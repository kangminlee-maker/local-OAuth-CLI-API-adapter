# Design task — the codex native session's completion parity with the app-server backend

Status: closed 2026-09-08. All three fixed red-first in `src/chat/codex-native-session.ts`
(G1 a bounded usage grace on `turn/completed`; G2 a `params.turn.status:"failed"` branch that fails
the turn with the child's error; G3 the pre-ack buffer holds the burst whole, no `slice(-100)`); the
immediate path and the buffered replay route through one `routeNamedNotification`; the claude sibling
already agreed and is unchanged. Full offline suite 2063/0; three mutants (one per guard) all killed
(`review-artifacts/stage2/parity-mutants.py`). Filed 2026-09-07 from round 3 of the F2
interrupt-write-barrier review (both seats).
Independent of F2 (the interrupt barrier, whose fold is closed) and of track A
(`docs/design-task-refresh-lease-atomicity.md`). Three pre-existing defects, all confirmed on the
pre-F2 `a/` side by both review seats, all of the same shape: `CodexNativeCliChatSession` and
`CodexAppServerBackend` disagree on the same notification envelope, and the native path is the wrong
one. Not defect patches on the notification-ownership work — the barrier and its folds are correct;
these are a separate parity gap the review surfaced.

## The three gaps

### G1 — a plain turn's own usage never reaches the caller (both seats: codex HIGH, Fable medium)

An ordinary completing codex native turn returns `usage: null`. The live envelope delivers
`thread/tokenUsage/updated` AFTER `turn/completed` (measured in-repo: the live probe row
`codex_native_text_turn_probe`, `docs/runtime-capability-catalog.md:559`, lists usage after
`turn/completed`; the fake's `emitTurn` models it with a post-completion `setTimeout`). The native
session closes the turn's queue on `turn/completed` (`src/chat/codex-native-session.ts`,
`if (method === 'turn/completed') turn.queue.close()`) and retires when the caller's iteration ends,
so the trailing usage — one macrotask later — hits `if (!turn) return` and is dropped
deterministically. The sibling `CodexAppServerBackend` keeps a bounded post-completion grace for
exactly this (`USAGE_NOTIFICATION_GRACE_MS`, `src/proxy/codex-app-server-backend.ts`); the claude
sibling delivers usage too (`src/chat/claude-native-session.ts`). Two paths disagree.

Independently reproduced in the main tree: `runTurn` over the fake returns
`status: completed, text: "MEDIUM_OK", usage: null` with no usage event in the stream.

Fix direction (both seats converge): mirror the backend at the queue boundary — on `turn/completed`
with no usage-seen flag, hold the queue open for a bounded usage grace (deliver usage then close, or
close at expiry); or route a post-close usage whose id matches the just-retired turn into that
turn's result within a bounded tail window. Must keep the F2 anti-contamination drops intact (an
id-less or mismatched tail is still dropped). Needs an ordinary-turn usage fixture (the F2
`early-delta` fixture pins only PRE-completion usage).

### G2 — a child-reported FAILED turn surfaces as `status: "completed"` (both seats: codex HIGH, Fable medium)

A `turn/completed` carrying `params.turn.status: "failed"` (with an `error` payload) is projected as
`cli.completed` / `status: "completed"`. The native session closes the queue on the METHOD alone and
never reads `params.turn.status`; the manager then synthesizes `cli.completed` for any normally-ended
iteration, and its synthetic raw even replaces the child's failed raw in `final.raw`. The sibling
backend rejects the same envelope as an error (`src/proxy/codex-app-server-backend.ts`, the
`turn?.status === 'failed'` branch). The public terminal contradicts its own raw authority
(`docs/local-cli-chat-api-design.md`: "projections are views; `raw` is the authority").

Fix direction: read `params.turn.status` at the one authority (`handleNotification`, plus the flush
replay). On `failed`, fail the queue with the child's error (the shape `failActive` already produces)
so the manager emits exactly one `cli.error` and non-streaming `status: "error"`; keep successful
completion on the existing path. Needs a native-path fixture (a fake knob emitting a failed
completion). Honesty note (both seats): the LIVE failed-turn envelope is not re-measured offline; the
probe mirrors the backend's measured model. If the live child never emits `status: "failed"`, this
drops to a doc/consistency defect between the two in-repo paths — the fix direction is unchanged.

### G3 — the pre-ack buffer silently truncates a current turn after 100 notifications (codex HIGH)

While a turn is unnamed, every id-bearing notification is appended then truncated with `slice(-100)`
(`src/chat/codex-native-session.ts`, the `bufferedNotifications` buffer — pre-existing, predates F2).
A current turn that emits >100 notifications before its `turn/start` ack (a large early burst) loses
its earliest deltas silently: codex measured 105 deltas + completion returning only the last 99
deltas, first delta `006|` not `000|`, text 396/420 chars — a valid stream returned corrupted, with
a successful terminal. `flushBufferedNotifications` cannot recover discarded events.

Fix direction: replace the lossy fixed-count buffer with a per-pending-turn buffer that preserves all
events until the acknowledgement, bounded by the request's existing timeout and, if resource
protection is wanted, a fail-loud byte/event limit — a limit hit must surface an error, never a
truncated success. Continue filtering buffered events by canonical turn id at flush. (Fable did not
independently flag this one; codex reproduced it on `a/`.)

## Why one task and not three folds

All three are the same parity boundary (`CodexNativeCliChatSession` vs `CodexAppServerBackend`) and
two of the three fixes touch the same one authority (`handleNotification` / the queue-close on
`turn/completed`). G1 and G2 both hinge on making `turn/completed` do more than close-on-method
(hold for a usage grace; branch on `turn.status`), so they are naturally one change; G3 is the same
buffer these run beside. Designing them together avoids three overlapping edits to the completion
path. Red fixtures first; a mutant per new guard; two-seat review — as track 1.

## Scope

- `src/chat/codex-native-session.ts`: the `turn/completed` handling in `handleNotification` and
  `flushBufferedNotifications`, the queue-close boundary, and the `bufferedNotifications` buffer.
- The claude sibling already delivers usage; confirm it needs no G1/G2 change before assuming parity.
- Fixtures on the fakes only: an ordinary-turn usage delivery, a failed-turn completion, and a
  >100-notification early burst.

## Done when

An ordinary codex native turn returns its own usage; a child-reported failed turn returns
`status: "error"` with the child's error as the authority; a large pre-ack burst is delivered whole
or fails loud, never truncated to a success. Each verified against the fake, with a mutant per new
guard and both review seats clean on the fold. The F2 anti-contamination drops stay pinned (no tail
misattributed to a turn).
