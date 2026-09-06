# Design task: native chat session lifecycle atomicity

**Status:** closing — gaps 1, 2 and 4 closed by bundle B-res (track 1, 2026-09-06; see § Bundle B-res, reviewed and folded); gaps 3, 6 and 7 closed by bundle B-child (see § Bundle B-child, reviewed and folded); gap 5 closed by bundle B-shutdown (see § Bundle B-shutdown). Every gap is closed; the task ends with the review of its last two commits, gap 5 bundle B-shutdown. Filed 2026-09-06 from round 56 of the PR #15 review campaign; gap 7 added from track 1 round 1.
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

7. **A caller's mid-stream return leaves the child's turn to nobody, and the next turn is admitted
   on top of it (pre-existing; track 1 round 1, codex F4; reproduces on `be8c2d8` and `46b141e`).**
   When the manager's iterator is returned mid-stream without a stop — the HTTP writer failing, the
   client gone — the runtime generator's `finally` retires the turn without telling the child and
   without draining it. `isBusy()` reads false and the next turn is admitted: on codex the child
   hears `turn/start, turn/start` with no `turn/interrupt` between; on claude, whose events carry
   no turn id, the first turn's late result is routed to the second turn and decides its response
   (`FIRST_LATE` with the first turn's usage, an empty text). The contract makes the native surface
   the disconnect exception — its turns belong to the session, which survives the socket, and
   cancellation is the explicit `interrupt` (`docs/api-interface-contract.md`, the disconnect
   row) — so the manager's `return()` must not be the child's stop, and the runtime must keep the
   turn (drain it, stay occupied) or stop it explicitly with the contract changed.

## How to close it

- A **turn reservation** as an explicit object with states (`reserved → entered → running →
  stopped/failed/done`), owned from admission, not from generator entry: its deadline, a pre-entry
  `return()`, and `interrupt` all transition it and release the session iff it still owns it; a
  later `next()` observes the terminal state and dispatches nothing. Closes 1, 2, 4.
- A **child handle** with an async teardown that sends `SIGTERM`, awaits exit for a bounded grace,
  escalates the same PID to `SIGKILL`, and only then forgets the handle and removes its isolation —
  used by close, replacement, and failed-handshake rollback. A failed replacement moves the session
  to an honest `unavailable`/`restarting` state (or closes it), clearing `native.thread_id` with
  `threadId`, so status never reports `ready` for a session that can run no turn. A turn whose
  caller left without a stop stays the runtime's — drained to its own terminal event, occupying
  the session until then — or is stopped explicitly with the contract changed; on claude no later
  turn can be closed by an earlier turn's result. Closes 3, 6, 7.
- A **creation registry and a closing epoch** in the manager: register a creation before awaiting
  the factory; during global close refuse new admission, await in-flight factories, and immediately
  close any runtime that resolves after shutdown began. Closes 5.

## Bundle B-child — the child handle and the abandoned turn (design, 2026-09-06)

Synthesized from two blind drafts (Fable frontier, codex gpt-5.6-sol ultra) on `46b141e` from
one packet (`review-artifacts/t1-design-packet-bchild.md`; drafts and the disposition in
`review-artifacts/t1-design-log.md`). Both drafts kept the public surface (`ready | running |
closed`, the snapshot, the SSE names, the HTTP codes, `LocalCliChatRuntimeSession`) and the B-res
occupancy model unchanged, and both closed the three gaps at their existing authorities; the
synthesis takes each mechanism from the draft that carried it with fewer concepts.

**Gap 6 — one teardown, awaited, escalating (Fable's shape).** `teardownChild` keeps a synchronous
prefix — reject pendings, close the line reader, capture and null `child`/`lineReader`, clear
`threadId` and delete `native.thread_id` (today nothing clears them) — and gains an awaited
continuation on the captured handle: `SIGTERM` → await the child's `close` within
`CHILD_EXIT_GRACE_MS` (1000 ms) → `SIGKILL` the same handle → await within the same grace → only
then remove the captured isolation directory (failure → `isolationDebt`, as today). The
continuation never rejects; a child alive after `SIGKILL` is named in the close's existing terminal
error next to the directories (the session is closed either way; the copy is removed either way).
One shared helper carries the escalation for both runtimes (one rule, one owner). Every caller
awaits its own call: `close()` (after the archive race), `replaceChild`/`restartChild` (**before**
spawning — a session owns at most one child at any instant), the failed-handshake rollback in
`start()`, and claude's `close()`/restart. Claude gains a `closed` flag, load-bearing through the on-demand
start (gap 3): a turn asked of a closed session must not start a child for itself. (Both drafts
also put it before the replacement's spawn; that guard survived mutation — a close awaits the
replacement and then tears down whatever it spawned, so the guard only spared a spawn the close
kills within its bootstrap, unobservably — and was removed.) Bound: codex
close ≤ archive `min(2000, timeoutMs)` + 2 × 1000 + removal ≈ 4000 ms worst, under the 5000 ms
pin (`test/codex-native-session.test.mjs:55`); claude ≤ 2000 ms. The grace is a named constant
measured only against the fixture child offline (exit 2 ms after `SIGTERM`); retune against a live
measurement before release.

**Gap 3 — restart on demand through the existing replacement (both drafts).** `startTurn` awaits
at most one replacement per turn: the in-flight one if any (today's wait, raced with the turn's
stop), else — no child, not closed — one it initiates through `replaceChild()`/`restartChild()`,
raced with the stop the same way; then the existing checks. A turn that awaited a replacement
that failed reports that failure — the spawn or handshake error — whether it waited for the
attempt or made it (one rule; codex's draft had the initiator report and the waiter keep `not
running`, two rules for one fact — the r55 pin changes with that reason: the turn says why the
child it waited for could not start, not only that none is running). No retry loop: each failed turn
costs one spawn + handshake, paced by callers. `native.thread_id` follows the child — cleared by
the teardown prefix, set only by the handshake — so the snapshot never names a thread that no
longer exists; `ready` means "a turn will be attempted". No new status value, no `usableChild`
predicate: absence is `child === null` and the runtime's own refusal.

**Gap 7 — the turn outlives its caller; the manager drains (codex's locus).** The contract
sentence (`docs/api-interface-contract.md`, the disconnect row) is enforced, not changed: a
disconnect is not a cancellation. A mid-stream `return()` without a stop no longer calls
`inner.return()`: the caller's iteration ends (the public iterator finished, `session.reservation`
detached), and the manager starts one caught background loop over `inner.next()` that discards
events, keeps the reservation's idle deadline armed per event (the one timeout concept the
contract has — silence, not duration), tracks its read as `pending` so a stop's `closeInner` still
queues behind it, and runs to the terminal event, where `runtimeEvents`' `finally` releases as
today. The runtime generators are consumed normally, so codex keeps `turn` until `turn/completed`
and claude until its `result`: `isBusy()` holds the session at `running`/409, and claude's
route-to-current-turn is always route-to-the-turn-that-started-it — the misroute dies
structurally, without per-turn line ownership. A deadline expiry, interrupt, or close during the
drain takes the existing stop paths (the abort signal reaches the runtime's stop; the reservation
need not be attached). No runtime file changes for this gap. Return-as-stop was rejected by both
drafts: on claude a stop is a child replacement, so every dropped socket would cost the session its
conversation — the loss the contract sentence exists to prevent.

**Concept surface.** Public: preserving. Internal: +1 shared escalation helper, +1 grace constant,
+1 claude `closed` (codex's concept reused), +1 private manager drain phase; retired: the unnamed
dead-but-`ready` state and the stale-thread claim. Rejected: a `tearingDown` join promise (the
sync prefix plus the existing `restarting` join already serialize), a `usableChild()` predicate, a
new status value, an availability interface member, self-close on failed replacement (a transient
process failure would become 410).

**Plan (each check fails on `46b141e` unless stated; one mutant per gap plus extras).** (1) Red
fixtures first: gap 6 a `SIGTERM`-ignoring fixture child dead when `close()` resolves, on both
runtimes, and old exit before successor spawn; gap 3 a failed replacement's snapshot without
`thread_id`, an `initialize` per later turn, and a later turn completing once the fault clears;
gap 7 `running` + 409 after a writer failure, no `turn/start, turn/start`, no `FIRST_LATE` in a
later turn, a drain ended by the idle deadline with the interrupt written. (2) Gap 6 codex: helper,
async teardown, callers await, replacement serialized before spawn, thread clearing in the prefix.
(3) Gap 6 claude: same helper, `closed` flag (its close-during-restart pin cannot fail on
`46b141e` — the wait the close lands in is created by step 2's await — pinned against that head;
the flag's mutant is the turn asked of a closed session). (4) Gap 3 both runtimes. (5) Gap 7 in the manager. (6) Docs: the design note's "reader
return" language distinguishes reservation release from the drain; the contract row's residual
shrinks to gap 5; full suite, probes, mutants. Mutants: no `SIGKILL` stage / forget without
awaiting exit; no `closed` check before the spawn; on-demand branch a no-op; thread clearing
omitted; `inner.return()` restored on the non-stop return; the drain's deadline not re-armed.

**Review round 3 (codex: F1 high, F2 high, F3 medium, F4 medium, F5 high; Fable pending), folded.**
(F1) The child's own exit ran the whole teardown as a continuation nobody awaited, so a close that
landed meanwhile saw no isolation and reported success while that removal later failed: the
self-exit now runs only the synchronous prefix (`forgetChild`), and the credentials copy stays for
the next teardown — a close's or a replacement's — whose caller awaits it. (F2) Claude installed
its turn only after the replacement wait, so a stop during that wait found no turn, the caller was
answered, and the turn then ran on the successor: the turn is installed before any wait and the
wait is raced with its stop, as codex does (the silence timer is armed once there is a child).
(F3, pre-existing) A close landing while the replacement copied credentials found nothing to tear
down and waited out the successor's handshake: `start()` re-checks `closed` after the copy and
tears the copy down. (F4) The interrupt endpoint waited for the child's acknowledgement of
`turn/interrupt` — up to the RPC budget — with the session already free: the interrupt is written,
not awaited (the retire-then-write order stands). (F5) A replacement spawned a successor over a
child that had not exited after `SIGKILL`: survivors are kept by handle, no successor is spawned
while one lives (the turn reports `did not exit`), and the close names them; once the handle
reports its exit, the next turn gets its child. Both runtimes.

**Change conditions (pre-noted).** A real consumer found relying on disconnect-as-cancel (expecting
`ready` right after dropping the SSE socket) flips gap 7 to return-as-stop with the contract
sentence changed and the HTTP disconnect handling enumerated. A real consumer that must distinguish
"has a handshaken child" from "will attempt a start on this turn" before submitting fires the
status split (an explicit unavailable/recovering value with every reader enumerated).

## Bundle B-shutdown — the closing epoch (design, 2026-09-06)

Gap 5, the last: `create` awaits the runtime factory before registering the session, and
`closeAll` snapshots only the map, so a creation in flight when the global close runs resolves
after it and leaves a live child — the ordering the server's own `close()` takes (`server.close`
and `closeAll` run together). Small enough for the lightweight path: no blind drafts; the record
is this paragraph, the fixtures are red first.

**Mechanism.** Two private values in the manager, one owner each. `closing` — set by `closeAll()`
before anything else and never cleared: a manager that has begun closing accepts no session again
(the server behind it is going away; an in-process caller that wants a fresh manager makes one).
`creations` — the set of creations in flight, entered before the factory is awaited and left when
the creation settles. `create()` refuses at once while `closing` (below); after its factory
resolves it checks `closing` again, and a runtime that resolved after the close began is closed by
the creation itself, awaited, and the create refused the same way — that close's failure, if any,
is the create's error (its caller is the one listening). `closeAll()` sets `closing`, awaits every
creation in flight (they settle by closing their own runtime or by registering nothing), then
closes the sessions it finds as today. Nothing is registered after the close began, so no session
and no child outlives `closeAll`.

**Public surface: one split, with its trigger.** A create refused because the proxy is shutting
down is a fact no existing code carries — `session_closed` (410) names a session that was, and
this one never was — and a caller must handle it differently (not this proxy, not now): HTTP 503,
code `shutting_down`, message "Local CLI chat sessions are not accepted: the proxy is shutting
down." Every reader: the manager (raises it), the HTTP envelope (generic — status and code from
the error), the API design note's code list, the fixtures. Sign: +1 public code, +2 private values;
the four paths — reuse `session_closed`: a session that never existed; extend the 400s: not a
request fault; rename: nothing to rename; split: this.

**Plan.** (1) Red fixtures: `closeAll` landing while a create's handshake is in flight — the create
is refused 503 `shutting_down`, the child is gone when `closeAll` resolves (its published pid),
no credentials copy remains, the session is not listed; a create after `closeAll` — refused the
same way. (2) The two values and the two checks. (3) The code in the API design note. Mutants: the
post-factory check removed (the create registers a session the close never saw); the wait for
creations removed (the child outlives `closeAll`); `closing` never set (both). Bundle 3 of the
original plan; closes gap 5, the design task's last.

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

**Review round 1 (codex: 2 medium, 1 high; Fable: clean), folded.** (1) The stop itself closes the
runtime's iteration — behind a read still pending in the runtime, at once when the stop lands
between reads — so a runtime that retires only in its `finally` is retired even for a reader that
never reads again (the draft closed it only from the next read or the reader's `return()`). (2)
`isBusy` is required on `LocalCliChatRuntimeSession`: the manager keeps no fallback lifetime for a
runtime that cannot say — the fallback answered `ready` while that runtime's stop was in flight —
so every runtime, and every test double, answers it (concept surface: reducing). (3) The terminal
event (`cli.completed`, a runtime's `cli.error`) is the end: the reservation is released on its
delivery, not on the read after it, so a stop landing between the two appends nothing (the read
after it is done through the released state; the generator, parked at its last yield with the
runtime's turn already over, holds nothing — a finalize there and a `finished` flag both survived
mutation and were removed).

**Change condition.** Evidence that a runtime's own stop wording is a consumer contract on
manager-stopped routes; then the adapter forwards the inner's settled answer when one exists and uses
the reservation's reason only when the inner cannot answer. The state model and gaps 1–2 survive.

Each gap has a concrete offline probe in codex round 56's report
(`review-artifacts/r56-codex/REPORT.md`); those probes are the floor for the redesign. The a/-side
verdicts there separate the one regression (1) from the five pre-existing gaps.
