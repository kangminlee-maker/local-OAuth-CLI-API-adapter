# Design task: native chat session lifecycle atomicity

**Status:** open — gaps 1, 2 and 4 closed by bundle B-res (track 1, 2026-09-06; see § Bundle B-res); gaps 3, 5 and 6 remain for bundles 2 and 3. Filed 2026-09-06 from round 56 of the PR #15 review campaign.
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

1. **[closed by B-res] The eager reservation outlives a generator that is never entered (regression, b/ only).**
   `streamTurn` sets `running`, installs `currentTurn`, and arms the deadline, then returns an
   async generator. An async generator's `finally` does not run if `return()` is called before the
   first `next()`; the deadline callback only calls `abort.abort()`. A caller that cancels before
   reading leaves the session `running` — every later turn is refused `409` for the session's life.
   Introduced by the round-55 move to synchronous admission (a/ admitted lazily).

2. **[closed by B-res] An interrupt before the first read is a no-op, then the turn runs (dispatch pre-existing).**
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

4. **[closed by B-res] Stop does not end the caller's iteration while `turn/start` is in flight (pre-existing).**
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

## Bundle B-res — the turn reservation (design, 2026-09-06)

Synthesized from two independent frontier drafts (Fable 5.1, GPT-5.6 Sol) produced from one blind
packet (`review-artifacts/t1-design-packet.md`); both re-derived the evidence on a copy of `9995705`.
Both chose the manager as the locus with zero runtime changes; the synthesis takes the Fable draft as
the skeleton and grafts three points from the codex draft (recorded in `review-artifacts/t1-design-log.md`).

**Locus and owners.** A private `TurnReservation` in `src/chat/session-manager.ts`, created
synchronously at admission, replaces both `ManagedSession.running` and `ManagedTurn`. `streamTurn`
returns an explicit iterator over the existing `turnEvents` generator — so a `return()` before the
first `next()` is real code, not a `finally` that never runs. Occupancy is the disjunction of two
single-owner values: the reservation (admission → the caller's iteration ends) and the runtime's
`isBusy()` (dispatch → the child-side retirement, unchanged: codex keeps its turn until the child
names it and the interrupt is written). Session status is a projection: `closed`, else `running` iff
the reservation is attached ∨ `isBusy()`, else `ready`. The runtime keeps the child and what a stop
means for it.

**States.** `admitted` (slot taken, runtime not asked, nobody has read) → `streaming` (the adapter's
first `next()` entered the generator) → terminal `stopped` (a stop ended the turn for its caller; one
`cli.error` with the stop's reason is owed to a reader) or `released` (ended without a stop: completed,
failed runtime-side, or the reader returned). Terminal transitions run once, clear the idle deadline,
and detach from the session iff `session.reservation === this`.

**Stop routes** — `interrupt`, `close`/`closeAll`, the idle deadline — transition the reservation
synchronously before their own `await`, then perform today's runtime action (the runtime's `interrupt`
when it has one, else the abort signal; the deadline fires the signal as today). The adapter's `next()`
races the inner generator against the reservation's stop and answers from the stop's reason; an inner
`next()` still pending (parked in codex's `turn/start` RPC) is absorbed in the background with exactly
one rejection handler, and `inner.return()` is queued behind it so the generator's own `catch`/`finally`
still run (replacement on timeout, retire on acknowledgement) and reach no caller.

**Ordering invariant (gap 4).** Releasing the caller is not releasing the session: the reservation
detaches at the stop, but codex's `isBusy()` stays true until the acknowledgement path retires the
turn immediately before writing `turn/interrupt` (no `await` between) — so admission answers 409 for
the whole window and the next `turn/start` cannot precede the interrupt. Instrumented by the existing
fixture `a stop between the request and its acknowledgement still precedes the next turn` and by a
mutant that drops `∨ isBusy()`.

**Strings (reused, none added).** Interrupt and deadline: `local CLI chat turn aborted`. Close:
`local CLI chat session closed` — the string both runtimes already deliver in-band when a close ends a
running turn, so a turn stopped before entry and one stopped mid-stream hear the same words (graft
from the codex draft; the Fable draft's `Session is closed.` would have made two in-band close strings).

**Two paths.** codex and claude answer the same on every manager-stopped route; `runTurn` stays a fold
over `streamTurn`. Runtime-originated ends keep their diagnoses (`not running`, RPC and silence
timeouts, child exits). Direct users of a runtime session see the runtime's answers as today.

**Regression floor changes, each with the caller-observable reason.** `:108` and the gap-4 fixtures
poll the method log for the eventual `turn/interrupt` instead of reading it the instant the caller
returns (the caller now returns before the acknowledgement — graft from the codex draft); `:443` asserts
`/session closed/` (one close answer on both runtimes); `:566` asserts `/aborted/` (one deadline answer
on both runtimes); `:189` and `:246` give the first turn a caller budget larger than the RPC budget
(with equal budgets the deadline's answer now wins the ~3 ms race the fixtures rode on).

**Concept surface: reducing.** Two manager-side lifetime records → one; two caller-answer authorities
on stop routes → one; `running`, `ManagedTurn` and the `armDeadline`/`stopDeadline` parameter threading
deleted; +4 file-private state names; no `types.ts` change; `isBusy()` stays a live consumer (the
codex draft's single-authority pump would have left it inert inside the manager and added a delivery
queue and a `stopping` state — rejected as larger than the gaps demand).

**Bundles 2 and 3.** The reservation owns nothing child-side: bundle 2's child-handle state composes
under `isBusy()` without a reservation transition, and an honest `unavailable` is a runtime-originated
`startTurn` refusal flowing through the inner as `not running` does today (or the session closes).
Bundle 3's closing epoch iterates "stop the reservation, then await teardown" per session and registers
an in-flight creation as "no reservation yet" — it must call the same stop the routes call.

**Change condition.** Evidence that a runtime's own stop wording is a consumer contract on
manager-stopped routes; then the adapter forwards the inner's settled answer when one exists and uses
the reservation's reason only when the inner cannot answer. The state model and gaps 1–2 survive.

Each gap has a concrete offline probe in codex round 56's report
(`review-artifacts/r56-codex/REPORT.md`); those probes are the floor for the redesign. The a/-side
verdicts there separate the one regression (1) from the five pre-existing gaps.
