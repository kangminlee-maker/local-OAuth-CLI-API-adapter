# Design task — the codex interrupt's write barrier

Status: open. Filed 2026-09-06 from round 6 of the native-session-lifecycle review (codex seat F2).
Independent of track 1 (whose seven gaps are closed) and of track A
(`docs/design-task-refresh-lease-atomicity.md`). Not a defect patch: the fix is a new ordering
primitive, so it is a design task, not a fold.

## The gap

An interrupt answers when the child has been told, not when it acknowledges: `stopTurn` retires the
turn and writes `turn/interrupt` fire-and-forget, and the endpoint answers as soon as the write
call returns (`src/chat/codex-native-session.ts`, `stopTurn` → `void sendTurnInterrupt`). A write
to a dead pipe does not throw at the call; it returns `false` and the failure arrives a tick later
as an `error` event, which now replaces the child (round-5 fold, F2). But the replacement is
installed by that later event, not synchronously with the interrupt. Between the interrupt
returning `ready` and the error firing, the session is free and its child is non-null with no
`restarting` promise, so a `turn/start` submitted in that window reaches the same dying child —
ahead of an interrupt it never received. One turn's worth of the wrong child.

Observed (round 6, both patch sides — pre-existing): interrupt a codex turn whose interrupt write
will fail asynchronously, then submit another turn before the error fires; the second turn writes
to the failed pipe, errors with `codex app-server replaced`, and only then is the child replaced.
The child's method log shows the interrupt never reached it. The narrow real window is one event-
loop tick; the probe widens it with an artificial delay to make it deterministic
(`review-t1-r6-probes.mjs`, mode `codex-delayed-interrupt-error`).

## Why a design task and not a fix

The contract wants ORDER: nothing starts ahead of an interrupt the child never received. Today's
order holds only when the write throws synchronously or acknowledges; the async-failure window is
open because write ACCEPTANCE is not an observable step. Closing it needs a per-child write barrier:
the interrupt may still skip waiting for the JSON-RPC acknowledgement, but it must not release
ordering until the stream's write callback reports success — or the stream error has installed a
replacement. Subsequent turns await that barrier and either run on the successor or receive the
replacement's own start failure. That is a new primitive on the child handle (a write-completion
promise the interrupt and the next turn both join), touching `send`/`sendTurnInterrupt`/`startTurn`
and their interaction with `replaceChild` and `restarting` — enough surface and enough new concept
that it wants a design, red fixtures first, and its own two-seat review.

## Scope

- `src/chat/codex-native-session.ts`: the write path (`send`), the interrupt (`stopTurn`,
  `sendTurnInterrupt`), and `startTurn`'s admission after a wait.
- The claude sibling (`src/chat/claude-native-session.ts`) has no in-band interrupt — its stop IS a
  restart, and the next turn already waits on `restarting` — so the same window may not exist there;
  confirm before assuming parity work is needed.
- Fixtures on the fakes only; the async pipe failure is realized by making the owned child handle's
  `stdin.write` return `false` and emit `error` a tick later (the shape Node produces for a dead
  reader), as the round-5/6 fixtures do.

## Done when

A turn submitted in the window between a failed-write interrupt returning and its stream error
never reaches the old child: the child method log shows no `turn/start` on the dying child after the
interrupt, the submitting turn runs on the successor (or reports the replacement's own start
failure), and the caller gets one terminal event per turn. Red fixtures first; a mutant per new
guard; both review seats clean on the fold.
