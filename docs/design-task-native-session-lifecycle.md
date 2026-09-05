# Design task: native chat session lifecycle atomicity

**Status:** open. Filed 2026-09-06 from round 56 of the PR #15 review campaign.
**Scope:** `LocalCliChatSessionManager` (`streamTurn` admission, `interrupt`, `close`,
`closeAll`, `create`) and `CodexNativeCliChatSession` (`startTurn`, `stopTurn`, `replaceChild`,
`teardownChild`, `close`, the `native` snapshot) in `src/chat/`.

## Why a design task and not a fix

Rounds 52–56 closed one lifecycle hole per round (turn ownership through a replacement, close
during a replacement, the manager dropping a session before teardown, the wait racing a stop, a
failed handshake leaving a partial child, streamed admission before the SSE commit). Round 56
surfaced six more, five of which **reproduce on the `a/` side** — they predate this PR. Each fix
below is a change to the same lifecycle machinery, and patching them one at a time is what has
produced a finding in this area every round. They are one design change: a turn reservation and a
child handle with explicit states and atomic transitions, made on its own with the fixtures below
as the floor. Per the campaign rule, a fix that keeps causing fixes is a design task.

## The gaps (codex round 56; each with its reproduce-on-a/ verdict)

1. **The eager reservation outlives a generator that is never entered (regression, b/ only).**
   `streamTurn` sets `running`, installs `currentTurn`, and arms the deadline, then returns an
   async generator. An async generator's `finally` does not run if `return()` is called before the
   first `next()`; the deadline callback only calls `abort.abort()`. A caller that cancels before
   reading leaves the session `running` — every later turn is refused `409` for the session's life.
   Introduced by the round-55 move to synchronous admission (a/ admitted lazily).

2. **An interrupt before the first read is a no-op, then the turn runs (dispatch pre-existing).**
   Between admission and the first `next()` the runtime has no turn, so `interrupt` finds nothing and,
   because the runtime exposes `interrupt`, the manager does not abort the reservation's signal. The
   detached iterable still holds a live controller and dispatches on the next read. Over HTTP this
   window is not currently reachable (no `await` separates admission from the first read), so it is
   latent; the manager API exposes it.

3. **A failed replacement is projected `ready` on a stale thread forever (pre-existing state; the
   dispatch was worse on a/).** `replaceChild` clears the private `threadId` but never `native.thread_id`,
   and after a transactional handshake teardown `isBusy()` reports only whether a turn object exists.
   So a session whose replacement failed answers `status: "ready"` with a stale `native.thread_id`
   while every later turn errors "not running", with no recovery path until close.

4. **Stop does not end the caller's iteration while `turn/start` is in flight (pre-existing).**
   `stopTurn` fails `turn.queue`, but `startTurn` does not iterate that queue until after
   `await send('turn/start')`. Failing a queue nobody is reading yet cannot settle the generator's
   pending `next()`, so an interrupted caller's stream stays open until the child acknowledges the
   start (up to the RPC budget; unbounded against a child that never answers).

5. **`closeAll` misses a session whose initial handshake is in flight (pre-existing).** `create`
   awaits the runtime factory before registering the session; `closeAll` snapshots only the map. A
   create racing shutdown resolves after `closeAll` returns and leaves a live child/session. This is
   the ordering the server's own `close()` can take.

6. **A successful close does not ensure the OAuth child exited (pre-existing).** `teardownChild`
   and `replaceChild` send `SIGTERM` and immediately forget the handle; neither awaits exit nor
   escalates to `SIGKILL`, and isolation cleanup can run while the process is still alive. A child
   that ignores `SIGTERM` outlives a close reported as successful, holding its credentials copy.

## How to close it

- A **turn reservation** as an explicit object with states (`reserved → entered → running →
  stopped/failed/done`), owned from admission, not from generator entry: its deadline, a pre-entry
  `return()`, and `interrupt` all transition it and release the session iff it still owns it; a
  later `next()` observes the terminal state and dispatches nothing. Closes 1, 2, 4.
- A **child handle** with an async teardown that sends `SIGTERM`, awaits exit for a bounded grace,
  escalates the same PID to `SIGKILL`, and only then forgets the handle and removes its isolation —
  used by close, replacement, and failed-handshake rollback. A failed replacement moves the session
  to an honest `unavailable`/`restarting` state (or closes it), clearing `native.thread_id` with
  `threadId`, so status never reports `ready` for a session that can run no turn. Closes 3, 6.
- A **creation registry and a closing epoch** in the manager: register a creation before awaiting
  the factory; during global close refuse new admission, await in-flight factories, and immediately
  close any runtime that resolves after shutdown began. Closes 5.

Each gap has a concrete offline probe in codex round 56's report
(`review-artifacts/r56-codex/REPORT.md`); those probes are the floor for the redesign. The a/-side
verdicts there separate the one regression (1) from the five pre-existing gaps.
