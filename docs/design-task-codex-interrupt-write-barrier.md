# Design task — the codex interrupt's write barrier

Status: implemented 2026-09-07; review round 1 folded (F2-1 + coverage gaps), round 2 on the fold
pending. Filed 2026-09-06 from round 6 of the native-session-lifecycle review (codex seat F2).
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

## Design (synthesized from two blind drafts, 2026-09-07)

Two independent drafts (`review-artifacts/f2-design-{fable,codex}/DESIGN_DRAFT.md`) converged on one
session-level gate installed synchronously at the interrupt write; each caught a flaw the other
missed, both folded in here.

**One field.** `private interruptGate: { child; promise: Promise<void>; done: (err?: Error) => void } | null`.
The `promise` never rejects. `done` is idempotent (first signal wins): it clears the field (if still
this gate), on error starts `replaceChild()` (which sets `this.restarting` synchronously) BEFORE it
resolves, then resolves. So a woken waiter always sees the truth.

**Install (in `sendTurnInterrupt`, synchronously, before the write).** Only when a write is actually
attempted (a captured live child, not closed). The gate exists before `stopTurn` retires the turn
and before `interrupt()` answers, so no next turn can be admitted into the window.

**The write.** Still through `send()`, which gains an optional `onWriteSettled?: (err?) => void`:
the four other callers pass nothing and are byte-identical by diff. The callback is the OS-acceptance
signal (contract 3 allows waiting on acceptance, never on the RPC ack). `send()`'s synchronous-throw
catch also calls `onWriteSettled(err)`. The interrupt keeps its pending RPC entry (unchanged wire).

**Settle** on the first of: write callback (ok → resolve; err → replace then resolve),
`send()` sync-catch (err), the child's teardown/exit (via the handlers below), or a `timeoutMs`
bound (a wedged-but-alive child that never flushes and never errors settles as accepted and falls
through to today's behavior — the bound caps the worst-case hold at one request budget). The bound
is Fable's; without it a full-buffer child blocks the next turn forever.

**The next turn waits** — inserted immediately before the current admission (`const replacement = …`
at line 214): `const gate = this.interruptGate; if (gate) { await Promise.race([gate.promise, turn.stopped$]); if (turn.stopped) throw 'local CLI chat turn aborted'; }`.
On resolve it re-reads `this.restarting`/`this.child` at the existing 214–217 and the r6 ownership
guard at 230 — reusing the replacement-wait machinery, and surfacing the successor's own start
failure through the existing `await` at 215.

**The stdin `error` / `close` / child-`error` handlers route a matching pending gate FIRST and
early-return** — this is codex's catch, essential: once the next turn is parked on the gate it is
`this.turn`, so the old child's async `error` reaching `failActive(err)` would retire that innocent
turn and reproduce the defect. So: `if (this.child !== child) return; if (this.interruptGate && this.interruptGate.child === child) { this.interruptGate.done(err); return; } this.failActive(err); if (!this.closed) void this.replaceChild()…`.
An accepted gate is already cleared, so a genuinely later error takes the generic path.

**`close()`** settles/clears the gate (no replacement while closed) after `closed = true`.

**Rejected** (from both drafts): awaiting the RPC ack (round-3 bar); moving `retire` into the
callback (turns the race into a client-visible 409, changes `isBusy`); a liveness probe at admission
(the flags are still healthy in the window — racy); pessimistic replace on every interrupt (burns
the warm child); treating `write() === false` as failure (that is backpressure).

## Done when

A turn submitted in the window between a failed-write interrupt returning and its stream error
never reaches the old child: the child method log shows no `turn/start` on the dying child after the
interrupt, the submitting turn runs on the successor (or reports the replacement's own start
failure), and the caller gets one terminal event per turn. Red fixtures first; a mutant per new
guard; both review seats clean on the fold.

## Verification (2026-09-07)

Red-first fixtures in `test/native-session-interrupt.test.mjs`; every guard pinned by a mutant that
turns its fixture red (`review-artifacts/stage2/f2-mutants-full.py`, ten mutants, all KILLED).

- The barrier's write-fate paths: `t1 F2` (a failed-write interrupt's next turn reaches the
  successor, no `turn/start` on the dying child) and `t1 F2 accepted` (the barrier holds the next
  turn only until OS write acceptance — not the RPC ack, `FAKE_CODEX_NO_INTERRUPT_ACK=1` — with the
  bound pushed far out so only acceptance can release within the test, and never replaces a healthy
  child). Mutants M1–M4, F10.
- The barrier's non-write-path guards (F2 review round 1, Fable Finding 2 — pinned by nothing
  before): `t1 F2 child-exit` (a child that exits while the next turn is parked settles the gate;
  the next turn starts a fresh child), `t1 F2 child-error` (a child `error` routes to the gate, not
  onto the innocent parked turn), `t1 F2 bound` (a write neither accepted nor errored releases the
  next turn at the bound, not forever). Mutants M5, M6, M7.

## Review round 1 fold (2026-09-07)

Two independent seats (Fable frontier agent, codex CLI at ultra) reviewed the barrier commit behind
a blind packet. Both converged on **one** substantive defect and Fable added a coverage finding;
both folded here.

- **F2-1 — post-interrupt notification contamination (codex HIGH, Fable medium; pre-existing,
  reproduced on `a/`; the barrier widened it).** An interrupted turn's tail was replayed into the
  next turn as its own: a `turn/completed` the child names at `params.turn.id` (which
  `handleNotification` read only at the top-level `params.turnId`) CLOSED the next turn's queue, so
  work that never ran on the child returned `completed`; an id-less usage tail became the next
  turn's usage. The barrier holds the next turn parked and id-less for up to a request budget while
  the interrupted child keeps talking, widening the window from one RPC round-trip. Fixed at the
  notification-routing authority, not the gate: one canonical turn-id extractor (`notificationTurnId`,
  both `params.turnId` and `params.turn.id`) used by immediate routing and buffered replay so a
  prior turn's completion is dropped, not routed; and while a turn is unnamed, an id-less
  notification (never the current turn's own output — a running turn's output carries its id) is
  dropped rather than buffered. Red-first fixtures `t1 F2-1 idless`, `t1 F2-1 nested` (parked), and
  `t1 F2-1 nested-named` (the named/immediate-routing path — the parked case is backstopped by the
  id-less drop, so it does not pin the extractor; the named case does). Mutants notifA (extractor
  top-level only) and notifB (id-less not dropped).
- **Fable Finding 2 — the barrier's non-write-path guards were pinned by nothing (medium,
  coverage).** Folded as the three fixtures above (child-exit, child-error, bound) plus a
  strengthened `t1 F2 accepted` that now distinguishes acceptance-release from bound-release (F10).
- **Not folded (verified, not defects):** the gate's timer-clear and `close()` settlement are
  resource hygiene, not behavioral — a leaked bound is `unref`'d and its `done()` idempotent; a gate
  the close did not clear has its late callback guarded by `!this.closed`. The codex seat killed
  both with instrumentation probes; a committed behavioral fixture would assert an implementation
  detail, so none is added.

- Full offline suite **2054/0**; `verify:runtime-boundary` passed.
