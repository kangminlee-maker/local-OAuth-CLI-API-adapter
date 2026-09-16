# Verification receipt — the nine that would not replay, and the defect one of them was

Every number below names the command that produced it and the tree it ran on.

- **Repo**: `/Users/kangmin/Documents/cli-api-adaptor/local-OAuth-CLI-API-adapter`
- **Revision**: `3ee0158` (branch `conformance/tier-a-batch-3`), after three
  review rounds, the thirteen fixes they forced, and the controls those fixes
  themselves turned out to need, and a frontier seat's judgment on
  the last unpromoted capture. The numbers
  below are re-taken at `c909eda`; §"What the reviews found" records what moved.
- **Subject**: `review-artifacts/batch3-final`, a detached worktree at that
  revision, clean over the whole tree before and after every run below. The
  files belonging to another session (`docs/runtime-capability-catalog.md`,
  `scripts/runtime-capability/collect.mjs`, `test/claude-code-backend.test.mjs`,
  `docs/runtime-capability-update-2026-09-07-claude.md`, `.claude/`) exist only
  in the main checkout and are not in this commit.
- **Date**: 2026-09-10
- **Logs**: `review-artifacts/stage2/evidence-ace97a0/` (pre-review) and
  `review-artifacts/stage2/evidence-3ee0158/` (final)

## What this batch was for

Nine 200/json captures had been recorded and left unpromoted. The last batch's
recon read seven of them as the proxy answering differently from the vendor.
That reading was wrong, and the way it was wrong is the point of this receipt.

A replayed row compares a frozen vendor answer against a live one from the real
server. Our side's answer comes from a fake backend, and that backend said `OK`
to every request. But a vendor turn's SHAPE is not always a function of the
option the request supplied:

- a turn that hit `max_tokens` before writing a token has an empty `content`;
- a turn whose text ran into a `stop_sequence` reports `stop_reason:
  "stop_sequence"` and which sequence it was;
- a cached turn reports what it read.

None of those can come out of a backend that answers `OK`. So the comparison was
between a stopped turn and a finished one, and every difference was booked
against the proxy. Seven rows sat unpromoted on the strength of an answer we had
supplied ourselves.

## The fix to the instrument

`createReplayBackend()` in `test/replayed-captures.mjs` lets each row name what
its own side should answer, declared in the same registry the rows live in so a
row and its answer cannot come apart. It also replaced two copies of the same
closure that `conformance-supplied-echo.test` and `conformance-echoed-defaults.test`
had each hardcoded.

The asymmetry is unchanged: the VENDOR side stays frozen — promoted bytes and
their digests. What a row now controls is our own side's INPUT, which is a
fixture choice exactly like the request bytes already were.

## The defect it exposed

With the answer supplied, six `/v1/messages` captures replayed — and one
difference was real. The vendor bodies all carry
`usage.output_tokens_details.thinking_tokens`. The proxy emitted no such field
on that surface, while BOTH OpenAI-shaped surfaces had always published the same
number as `reasoning_tokens`. `LocalUsage.reasoningOutputTokens` was there the
whole time; `anthropicUsage` simply dropped it.

A client reading thinking cost through an Anthropic SDK got nothing for a turn
that reported it fine through either other door. One runtime, three doors, two
answers — the defect shape this repository keeps producing.

Matrix §5.5.9 had `thinking_tokens` filed under "reporting fields for features
this proxy does not run, whose meaning must be measured before we fill them."
That was a misclassification, and the same one `cache_write_tokens` got on
2026-09-09: it was never the vendor's number to measure, it was ours to pass on.
`anthropicUsage` now emits it unconditionally, matching what the OpenAI shapes
do with the same value. The cache counters above it stay conditional — that is a
different judgement, written out in the code, and it stands.

## What could not be filled, declared instead of described

`messages-vendor-routing-usage-is-not-reported` (`spec/declared-divergences.json`,
13th entry) covers `.usage.service_tier`, `.usage.inference_geo`,
`.usage.cache_creation` and its two TTL members. Measured over the six
`/v1/messages` captures: `service_tier` is `"standard"` in all six,
`inference_geo` follows the request (`"global"` or `"us"`), and the
`cache_creation` breakdown is 0/0 in all six.

Each names infrastructure this proxy does not run. There is no tier system
behind a single local runtime. There is no inference geography — the runtime is
the machine the proxy runs on, and echoing the requested value back would
publish a routing claim nothing routes. And the TTL breakdown needs a cache that
distinguishes a five-minute write from a one-hour one, which neither backend
reports.

These absences were already true and already written down — as PROSE, in matrix
A-28 and A-30. A build that started emitting a tier would have agreed with a
paragraph. Now it fails a gate.

## Promoted

Six captures, `review-artifacts/stage3/promote-batch-3.mjs`. A seventh —
`direct-chat-n-one` — was promoted and then DELETED: its pinned bytes request
`n: 2`, both reviews caught the `n: 1` label, and `direct-chat-n-2` already
carries that claim properly.

| capture | surface | what it backs |
| --- | --- | --- |
| `direct-messages-stop-sequence-hit` | `/v1/messages` | A-17, the sequence actually hit |
| `direct-messages-stop-sequence-hit-p8` | `/v1/messages` | A-17, the P-8 turn |
| `direct-messages-stop-sequences-empty` | `/v1/messages` | A-17, `[]` never fires |
| `direct-messages-metadata-user-id` | `/v1/messages` | A-27, validated and not echoed |
| `direct-messages-service-tier-standard-only` | `/v1/messages` | A-28 + the declaration |
| `direct-messages-inference-geo-us` | `/v1/messages` | A-30 + the declaration |


## Not promoted, with the reason recorded

| capture | why |
| --- | --- |
| `3e0b8b03/0063-value-reasoning.effort-max.json` | the vendor turn is incomplete — 5 paths only it has, 10 only ours. An incomplete turn cannot pin a shape. |
| `66c57d12/0001-echo-moderation-model-.json` | 127 paths of a `moderation` block the proxy has no moderation pass to produce. It is a whole feature, not a field, and a declaration listing 127 absences would assert nothing a reader could check. Left open. |

## Offline suite

```
$ node --test --test-concurrency=2 test/*.test.mjs
# tests 2303
# pass 2303
# fail 0            (rc 0)      (2283 before round 4's twenty controls)
```

Capture store:

```
verifyCaptureStore()   52 captures, 0 unbound
conformance-coverage   134/148 live parity rows (90.5%)
```

## Mutation

Six tables against the clean worktree at `d367447`. (The counts and the
commentary below were written at `3ee0158` and are kept; round 4's re-run and its
ten new mutants are in the round-4 section at the end.)

Five tables against the clean worktree at `3ee0158`.

```
supplied-echo-mutants.py     40/40 killed, restored, dist matches tree
echoed-defaults-mutants.py   14/14 killed, restored, dist matches tree
aa-sampler-controls.py       29/29 killed, restored, no unbacked case
sse-capture-controls.py      15/15 killed, restored
probe-exchange-controls.py   10/10 killed, restored
```

**The tables refused, stalled or scored a survivor more often than they passed
cleanly, and every one of those was right.** That list is the most useful thing
in this receipt, because each entry is a moment where a green number would have
been wrong:

- `aa-sampler-controls.py` **refused its baseline** three separate times, each
  time because a case had been added and the ROSTER did not name it.
- **A8, A9 and A12 reported `NOT PLANTED`** when the loop moved from
  `lens.length` to `samples.length`; **S23 and S28 reported
  `ANCHOR-FAIL(count=0)`** when the code they aimed at was rewritten.
- **S27 and S30 SURVIVED because no capture distinguishes the rule from the one
  it replaced.** For S30 I instrumented the reader and measured that **no capture
  in the store reaches the ancestor branch at all**; the rule is exercised by
  `declared-absence-reader.test.mjs` and by nothing else, and the claim was
  narrowed to that.
- **Four of the five mutants written for round 3's fixes SURVIVED**, three of
  them for one reason: the roster is clean, so removing the rule changed
  nothing — every one reported `tests=1 pass=1`, the case ran and had nothing to
  fail on. The fourth was a hole I had put in: the unchecked-field scan hard-
  skipped `text` and `stopReason`, so renaming a binding left the field unchecked
  AND unreported.
- **A25 could not reach one of its own roster cases**, because setting the ledger
  to 0 is what a fresh state should read as anyway. A28 pushes the other way.
- **S32 HUNG the whole table for 45 minutes.** Its target named the assertion text
  rather than the test name, so `--test-name-pattern` matched nothing — and a
  file whose `before` hook starts a server, with no test to reach `after`, sits
  on an open handle instead of exiting. The harness now runs every command under
  a timeout and reports `TIMEOUT — this control proves nothing`. The interrupted
  run left one mutant planted; it was restored and verified against the committed
  blob (`81f724e2…`).

## What the reviews found

Two codex seats (`gpt-6-astra` xhigh, `gpt-5.6-sol` ultra) reviewed `ace97a0`
offline from one packet, in separate detached worktrees, each asserting the
2242-test baseline before and after. Six findings, all reproduced, all in this
branch's own work. Two were found by both seats independently.

| # | finding | seats |
| --- | --- | --- |
| 1 | `direct-chat-n-one` is an `n: 2` capture; the matrix claimed `n: 1` coverage | both |
| 2 | a retry spends past the shared budget — a ceiling of 1 authorised 5 calls | both |
| 3 | `--resume` drops every series but the character lengths | sol |
| 4 | the default plan is 12/24 where the design says 24/60 | sol |
| 5 | an unmeasured thinking count is published as a measured zero | astra |
| 6 | the seven new rows certify only `.model` | astra |

**Round 2** attacked the fixes rather than the code they fixed, and found four
more — every one the same shape: round 1 had closed an INSTANCE while the fix's
own comment claimed the CLASS.

| # | finding |
| --- | --- |
| 7 | the answer binding closed `usage`, not the class: a compensating `text` fixture still hid a serializer that ate a character (122/122 green with the defect installed) |
| 8 | resume reopened the whole budget — the runner rebuilt it at full size every invocation, so a ceiling of two paid for four calls |
| 9 | the new resume wiring DISCARDED the legacy state it promised to refuse, restarting the row and overwriting paid observations — worse than what it replaced |
| 10 | the presence guard covered only the ancestor walk, so an exactly-declared leaf stayed exempt on the echo side after the proxy began reporting it |

Round 2's negative results are evidence too, and are recorded here because they
are the only reason several of this branch's claims can be made at all: the
reader change is behaviour-preserving across all 45 pre-existing rows (46 in the roster; the '45' in two commit messages is off by one — round 3 counted it) by
identical compared-path SETS rather than equal totals; the `thinking_tokens`
revert is byte-identical to `29bc005` for missing, zero and positive counts on
both the buffered and the streamed path; `--report` makes no call and its numbers
match this branch's claims exactly; and all 52 captures are bound, none of them
to the rewritten-away commit.

**#5 was the product change this batch opened with, and it was wrong.**
`claude-code-backend.ts` never populates `reasoningOutputTokens`, so on the
surface the Claude backend serves, `thinking_tokens: 0` was a thinking model
reporting that it did not think. The parity argument written for it was circular
— the OpenAI shapes coerce the same absence to zero, which makes it one defect
on three surfaces rather than a standard to match. Reverted, declared, and filed
as `docs/design-task-unmeasured-thinking-tokens.md`; the real fix has to survive
two parsers, two merges, a fan-out and three serializers, each against a vendor
that always sends the field.

**#6 is the one the packet asked them to attack, and the attack landed.** The
sharpest form: adding `cachedInputTokens: 1` to six rows' answers turned a real
proxy defect — dropping the runtime's explicit cache-read report — from six red
tests into 117 green ones. A row's answer could compensate for the thing the row
exists to detect. Three changes answer it: `echoed` is per ROOT (which
immediately failed a row that predates this branch — `include` riding along on
`store`), each row claims its own option and compares that option's observable
effect, and every answer is bound to its own capture so one that CONTRADICTS the
capture fails. Removing the buffered stop truncation now kills four tests; before
this it left `AAZZtail` on the wire through a green gate.

An independent frontier seat, working a different question from a blind packet,
reached #6's structural half on the same day: `compared > 0` sums every supplied
root, so one option can carry the rest.

## Recon as a negative control over the whole store

`recon-unpromoted.mjs --all --answers <derived from the roster>` replays every
200/json capture in the store, promoted ones included, at the clean revision:

```
50 captures: {"CLEAN": 22, "CLEAN (declared)": 23, "DIFFERENCES": 5}
```

Two of the five are the two left unpromoted above. **The other three are
over-reports, and the reason is worth writing down**: recon reads the
declarations' `absentPaths` but does NOT read the roster's per-row harness
exemptions or the value-divergence table, both of which the gate reads. So
`0042-value-parallel_tool_calls-false` (12 paths of a reasoning item the fake
backend never emits, plus 5 tool-echo members), `0043-value-reasoning-summary-auto`
(the declared `auto` -> `detailed` value divergence) and
`0022-order-top_logprobs-effort-none` come back DIFFERENCES where the gate
passes.

That is recon over-reporting, which is the safe direction for a
pre-promotion instrument — it costs a look, never a missed difference. But it
narrows recon's claim: it predicts what the gate says only for a capture that
has no roster exemption and no value divergence yet, which is exactly the
population it is pointed at. Recorded here rather than left for the next reader
to rediscover.

## Matrix

A-17, A-27, A-28, A-30 and Chat 15 now cite the captures that back them, and
§5.5.9's `/v1/messages` row records the `thinking_tokens` fill with the
misclassification written out. `spec/conformance.json` rebuilt from the matrix
by `scripts/build-conformance-manifest.mjs`; `matrixDigest` moves with it and
`test/conformance-manifest.test.mjs` (117/117) is what proves the two agree.

## Still open after this batch

- The moderation declaration (`66c57d12/0001`), above.
- `docs/design-task-capture-records-decoded-text.md` and
  `docs/design-task-conformance-member-identity.md` — design decisions, not work.
- The A/A noise-floor run, in flight on its own budget; its readings are not
  part of this receipt.

## The moderation capture, and the question that was wrong

The last unpromoted 200/json in the store was
`66c57d12/0001-echo-moderation-model-`: sent `moderation: {model: …}`, the direct
API answers 200 AND attaches 127 paths of classifier verdicts. This proxy
moderates nothing and emits no `moderation` key.

The decision went to a frontier seat on a blind packet — evidence, constraints,
rubric, four neutral alternatives, no draft conclusion. **It came back with a
correction to the question.** The packet said the declaration vocabulary had no
way to name a subtree. It does: `creditedAbsences` walks ancestors and its own
comment says so, and `.moderation` alone credits 127 of 127 paths on the SHAPE
comparison, today, unchanged. Measured, not argued.

What did not walk them was `isDeclaredAbsent`, which the ECHO comparison uses —
and a **third copy** inside `conformance-echoed-defaults.test` that matched
exactly and did not even strip `[]#`. One declaration meant three things
depending on who asked. Both disagreements were latent, because no capture in the
store had a declared subtree and no defaults capture had a declared array. Latent
is not absent.

The seat also measured that the enumerating alternative was not merely verbose
but IMPOSSIBLE: 26 of the 127 leaves are members of scalar arrays, for which the
shape reader builds no path, so listing them fails the gate rather than
satisfying it — and `validateDeclarations` refuses a value divergence whose proxy
side is absent. And it ruled the refuse-the-option alternative out of its own
authority: `docs/handoff-2026-09-09.md` §2 settles that case in the other
direction and marks it not-to-be-relitigated, and the packet's quotation of the
option rule was half of a sentence.

Three defects it found that have nothing to do with the decision, each verified
here before being acted on:

| what | why it mattered |
| --- | --- |
| `api-interface-contract.md` said "None of them has an echo field in a Chat response" with `moderation` in the list | a CLIENT-facing document, and the capture is the counter-example. A client would read a missing `moderation` as "nothing was flagged" rather than "nothing was screened" |
| R-40's default read `absent`, citing a line that had moved | all **19** promoted `/v1/responses` captures carry `moderation: null`, compared every run by `conformance-echoed-defaults`. `DOC` -> `WIRE` |
| recon's echo half never called `isDeclaredAbsent` | it would have reported the whole moderation subtree as differences the gate answers for — the same shape as the `STALE DECLARATION` fix, and recon's only claim is that it says beforehand what the gate will say |

Planting a `moderation` block in the chat response now fails the new row both
ways (`moderation is declared absent and this answer reports it`) and every other
chat row's shape comparison. Restored byte-for-byte, verified by `git diff`.

## A mistake of mine, and the gate that caught it

`c909eda` was committed with `git add -u`, which staged three files belonging to
ANOTHER session — the files this campaign's constraints name explicitly as not to
be touched or staged. I rebuilt the two affected commits without them and
restored the other session's content to the working tree byte-for-byte, verified
by digest, leaving its five entries exactly as they were.

That rewrite then broke something else, and **the provenance gate caught it**:
the moderation capture had been promoted while HEAD was `c909eda`, and its
`promotedFrom.revision` recorded a commit that no longer existed. In the gate's
own words, "a commit reachable from nothing is not evidence anyone can review."

It failed only in a clean worktree at the branch tip — the main checkout still
had the commit in its reflog. The mutation runner's insistence on a clean tree at
a NAMED revision is what surfaced it; a local test run said nothing. Re-promoted
at `df547bc`; bytes, both digests, origin run and file unchanged.

This is the reachability property that also makes squash-merge unusable in this
repository, demonstrated rather than asserted.

## Round 3, and the shape of the loop

A cross-provider seat (Opus 5 max; the Fable seat this round was meant for died
on usage credits before it started, and a dead seat is not a weak review but no
review) reviewed `774d0db`. Three findings, two high.

| # | finding |
| --- | --- |
| 11 | the premise check binds the row's DECLARED answer; the backend serves the MERGED one, and `DEFAULT_ANSWER` was bound to no capture anywhere |
| 12 | the budget ledger is durable against a clean exit only: up to 15 live calls unbooked, and two invocations on one state file each spend the ceiling |
| 13 | the `supplied` assertion runs ONE WAY — a real client-visible defect survived the WHOLE 2274-test suite |

**#13 is the most serious thing this campaign has found.** A row could not claim
an option its request lacks, and nothing said a row must claim the options its
request HAS. Deleting one word from one row — `supplied: ['top_logprobs',
'reasoning']` -> `['reasoning']` — made a client sending `top_logprobs: 1` being
told `0` invisible to every test in the repository. That row was the defect's
only witness, and the fixture dismissed it. 15 of 46 rows were already riding an
unclaimed option.

**#11 is the third shell of one class.** Round 1 closed
`answer.usage.cachedInputTokens`. Round 2 found it open on `answer.text`. Round 3
found it open one scope outward, in the default that every row without an answer
is served. Each round closed the FIELD the previous round used while the fix's
own comment claimed the CLASS — which is the diagnosis round 2's commit message
opens with, applied to that commit itself.

### What the seat asked for instead of a round 4

Two invariants, stated once and enforced in both gates:

1. Every input this harness gives its own side is derived from, or checked
   against, the capture it is replayed against.
2. Every option a capture's request carries is claimed by a row that replays it.

`ec93f0c` implements both. The merge is written once in `servedAnswer()` and
read by the backend and the check alike; every row is checked, over its whole
leaf path set, on every surface, in both gates; and the `supplied` assertion is
two-way, per surface, with the token caps every probe sends excused once by name
with their reason and an exception that has outlived its purpose failing as
stale.

### Round 3's negative results

Recorded because several of this branch's claims rest on them:

- `afterStopSequences` (re-derived in the test) and the proxy's own
  `truncateAtStopSequence` agree on **42,525 cases**, differing only on
  non-string sequences — which the normalizers refuse with 400, and in the
  false-alarm direction.
- The reader change is behaviour-preserving on **all 46 rows by identical
  compared-path SETS**, under `f4f5c84`'s reader, `ec93f0c`'s, and a control
  with the exact-hit clause deleted.
- Nothing downstream reads a state row's `lens`.
- The unpromoted capture's stated reason is exact to both numbers: uncredited
  vendor-only 5, ours-only 10, `status: "incomplete"`,
  `incomplete_details.reason: "max_output_tokens"`.
- One residual reader disagreement exists — a declaration written with a LITERAL
  index exempts on the echo side and stays uncredited on the shape side — and its
  direction is safe: the shape gate goes red and `every declaration is exercised
  by a capture this gate replays` goes red on the same declaration, so it cannot
  reach main silently. Recorded here rather than fixed, because fixing it would
  change what a declaration means for no reachable defect.

## Round 4 — two seats, two providers, and the one they agreed on

Two independent seats reviewed `774d0db..3ee0158`, offline, with no vendor call
between them: **Opus 5 max** (`review-artifacts/batch3-r4-opus/REPORT.md`) and
**gpt-5.6-sol ultra** (`review-artifacts/batch3-r4-sol/REPORT.md`). Nine
findings, and they overlap in the two places that matter most.

| # | seat | finding | closed by |
| --- | --- | --- | --- |
| 14 | both | invariant 2 is per SURFACE, so the row that is a defect's only witness can stop claiming its option while a sibling keeps the surface satisfied | `13fe9d7` |
| 15 | opus | `MANDATORY_REQUEST_KEYS` is an exemption a row can move INTO: `supplied: ['model']` satisfies every check while asserting nothing | `13fe9d7` + prose |
| 16 | opus | two of the `free` reasons are false, and one names a mechanism that does not exist | `df0ab89` |
| 17 | sol | the false `stopReason` reason is not merely wrong — one fixture field walks through it on both OpenAI surfaces | `df0ab89` |
| 18 | sol | a bound field set to explicit `undefined` is silently skipped | `df0ab89` |
| 19 | sol | `harnessGaps` accepts unrelated paths once its coarse premise is true | `df0ab89` |
| 20 | sol | deleting a row's `alsoCompare` deletes the only assertion `n` has, and cardinality is not shape | `df0ab89` |
| 21 | sol | the A/A lock has two bypasses: one inode spelled two ways, and a release that unlinks what it no longer owns | `d2ccaba` |
| 22 | opus | the `wx` lock covers the ledger; nothing covers the artifact, and the artifact is what the floor is published from | `d2ccaba` |

**#16 and #17 are the same sentence read from two directions, and neither seat
saw the other's report.** The Claude seat read the `free` table and reported that
`stopReason: 'not passed through on this surface'` states a mechanism that does
not exist. The codex seat did not read the table at all — it wrote
`answer: { stopReason: 'max_tokens' }` into one Chat row, watched the proxy
answer `finish_reason: "length"` against a capture that says `"stop"`, and
watched 2283/2283 stay green. Then it did the same on `/v1/responses`, where the
one field compensated for an inverted `responseCutOff` so exactly that a planted,
client-visible defect went from 115/116 back to green.

That is the strongest cross-provider result this campaign has produced: a written
reason that had been read and re-read for three rounds was false, and the hole it
covered was reachable in one edit. **A prose exemption is a defect waiting for
someone to take it literally.** It is a binding now, on all three surfaces,
through the wire effect each one has — and `stopReason` is not in the free table
at all.

**#22 is what a lock looks like when it moves a collision instead of removing
one.** The state lock's own comment says two runs on one ledger each spend the
ceiling and the second erases the first's rows. Every clause is true of the
artifact, which had no lock, no `wx`, and a default name carrying only the date —
and because `--only` is how a batch is partitioned, and the new lock refuses two
partitions that share a ledger, separate ledgers became the only way to
partition, which is precisely the configuration where two artifacts collide.

### What round 4 did to the loop

Round 3's seat asked whether a fourth round of the same kind would end it. Round
4's Claude seat answered for invariant 1 — "the third compensating-fixture route
is closed and I could not open a fourth" — and against invariant 2, which "closed
the instance in front of it rather than the class, for the same reason rounds 1
and 2 did: the rule was written against the case that had just been found instead
of against the property that matters."

The correction that follows from that is not another rule. It is that **each rule
this round added is written outside the row it constrains**, because every one of
round 4's findings is the same move: the thing being asserted and the thing
deciding whether to assert it were the same mutable object.

- a row's `supplied` decided which options got compared → now every option in the
  row's own request must be claimed **by that row**
- a row's `alsoCompare` decided which effects got compared → now `REQUIRED_EFFECTS`
  says, outside the row, which options owe which paths
- a row's `harnessGaps` decided which absences were excused → now the permissible
  set is **derived from the capture** and the written list is asserted against it
- a row's `answer` decided which bindings ran, because `undefined` read as "no
  claim" → now a binding runs whenever the served answer has the PATH

### A rule that measured wrong, and was not landed

The Claude seat stated #15's fix as "refuse a mandatory key in `supplied`, one
assertion beside the existing `option in request`". Written that way it fails
three real rows — `direct-chat-message-name`, `-message-refusal` and
`-message-unknown-member` all claim `messages`, and each is about one member
inside it. The seat's premise ("no row is about them") was the roster's own
comment, and the roster disproves it.

So the ban was measured, refused, and dropped. What actually closes the parking
move is the per-row rule from #14: a row that parks its claim on `model` still
has its real option unclaimed, and fails by name. The comment that said no row is
about a mandatory key now says which three are, and the control asserts the
per-row failure rather than a ban.

### The tail of round 4's Claude report, and what it was still hiding

The Opus seat's report reached this session truncated; its last section arrived
later and carried a part of F3 that nothing above had answered. **The unchecked-
input table read as an audit of every input the harness gives its own side, and
audited one object inside them.** `id: 'local_test'`, `toolCalls: []` and
`latencyMs: 1` are constants the fake backend invents inside `generate()`;
`leafPaths(answer)` cannot reach any of them, so their entries sat in the table
with reasons nobody had ever read against anything.

`servedResult()` now writes that object once and `generate()` returns it — the
same move `servedAnswer()` made for the merge — and the scan reads the UNION of
the two. They answer different questions: the answer is what the roster WRITES,
the result is what the proxy RECEIVES. The binding loop still reads the answer
alone, because there `stopReason: undefined` is a claim (the turn simply ended)
while the result omits the key so the proxy derives `end_turn`.

Four reasons became live and had to be rewritten; `stopSequence` is all that is
left in reserve. The same seat also named the SECOND mechanism keeping
`usage.reasoningOutputTokens` free — `reasoning_tokens: … ?? 0` is emitted
unconditionally, so no fixture value can add or remove the path for the shape
half either. Both protections are properties of other code (the `PER_CALL` list
and one `?? 0`), which is the reason they are now written down where the table
is read.

Round 5's two seats were dispatched against `d367447`, one commit before this
fix. If either reports it, that is a third independent confirmation rather than
a new hole; the packet's "rounds 1-4 are answered here" is false for this one
item and the reconciliation says so rather than quietly counting it twice.

### Round 4's tables

Six against the clean worktree at `d367447`, every mutant restored and the tree
verified byte-for-byte against the revision afterwards:

```
supplied-echo-mutants.py     50/50 killed, restored, dist matches tree
echoed-defaults-mutants.py   14/14 killed, restored, dist matches tree
aa-sampler-controls.py       32/32 killed, no unbacked case
state-lock-controls.py        5/5  killed, no unbacked case
sse-capture-controls.py      15/15 killed, restored
probe-exchange-controls.py   10/10 killed, restored
```

Ten mutants are new (S41-S50) and three more (A30-A32) plus a new table
(`state-lock-controls.py`, L1-L5). Two of them had to be re-aimed before they
meant anything, and both re-aimings are the same lesson this campaign keeps
paying for:

- **S46 SURVIVED twice.** First written as a mutation of the ASSERTION — replace
  `assert.deepEqual(gaps, harnessGapsFrom(...))` with a tautology — which nothing
  can kill, because no test watches a test. Rewritten as a mutation of the DATA
  (append `.billing:object` to the gap list, which is what the review actually
  did), it still survived: its pattern named `direct-responses-reasoning-summary-auto`
  and the row that declares gaps is `direct-responses-tools-parallel-false`. The
  harness ran two tests, both passed, and the survivor was the runner's aim.
- **S50 SURVIVED as a code mutant and had to become a data one.** Emptying the
  condition inside `freeFieldsReached` changed nothing: the five reserve entries
  are absent from every served answer either way, so a reader that over-reports
  still reports them as unreached. The defect the gate is for is a ROSTER that
  starts leaning on an unread reason, so the mutant is now a roster that answers
  with a `model` — and the gate names it.
- **S48 SURVIVED** because its pattern named the roster test rather than the
  control. The roster satisfies the rule, so the roster test could not fail; only
  the synthetic control distinguishes the map from an empty one.
- **L3 SURVIVED and stayed survived until a new input was written.** Deleting the
  ownership token leaves the once-flag, which covers the double-release the
  finding described — signal handler, then the `exit` hook it triggers, in one
  process. What it cannot cover is a FIRST release aimed at somebody else's lock,
  which is what happens after a user does what the refusal message tells them to:
  delete a stale lock deliberately. That case is now a control, and L3 dies on it.

### Round 4's negative results

- The exploit in #15's report — `supplied: ['model']` on
  `direct-responses-service-tier-flex` plus a `service_tier: 'default'` defect —
  was re-run against `13fe9d7` and is already closed: it fails
  `every option the store sends is claimed by the row that replays it`.
- #14's construction on `direct-responses-top-logprobs-effort-none` fails by name
  (`top-logprobs-effort-none reasoning`) at the same revision.
- All 18 `/v1/responses` captures are completed turns; all 22 Chat captures
  report `finish_reason: "stop"`; every messages row states its own stop reason
  and the three whose capture carries a stop sequence compare it by path. The
  `stopReason` bindings were written against those measurements, not against the
  proxy's source alone.
- The derived harness-gap set reproduces the twelve written paths exactly — same
  order, same members — so the list that had been trusted for three rounds was
  right; only its authority was missing.

## Round 5 — the loop reached the fixes, and one of them had not moved

Two seats again, `d367447`. The Claude seat (Opus 5 max) ran to a verdict; the
codex seat (gpt-5.6-sol ultra) was **cut off by its provider's content filter**
after its first finding — `This content was flagged for possible cybersecurity
risk`, 104k tokens in, no verdict. A reproduction of two processes racing for one
measurement ledger reads as attack research to that filter. Recorded here as
what it was: not a seat that found little, a seat that was stopped. It was
re-dispatched against `79fd65e` with the same questions worded as the durability
questions they are.

| # | seat | finding | closed by |
| --- | --- | --- | --- |
| 23 | sol | a path cannot name a file: two HARD LINKS, and a DANGLING symlink to a ledger that does not exist yet, each took two locks over one inode | `b0f5af2` |
| 24 | opus | the per-row claim rule moved the decision from one row field to two — a row stops claiming an option and excuses itself in the same object | `8fec5f5` |
| 25 | opus | two of the eleven answer bindings had never run; both were rewritten to return a string no vendor sends and the suite stayed green | `966c394` |
| 26 | opus | a live run without `--resume` has a lock and no ledger, so an interrupt loses every call it has paid for | `de3ab42` |
| 27 | opus | `REQUIRED_EFFECTS` asks its question of `supplied`, which the row can shed | `afd6167` |

**#24 is this campaign's own lesson turned on the fix that was written for it.**
Round 4's diagnosis — the thing being asserted and the thing deciding whether to
assert it were the same mutable object — produced five fixes, and four of them
moved the deciding half out of the row. The fifth replaced one row field with
two. The seat's edit is worth quoting whole, because nothing in it is false:

```js
-  supplied: ['top_logprobs', 'reasoning'],
+  supplied: ['top_logprobs'],
+  unclaimed: { reasoning: 'set to `effort: none` so the probe turn does not
+    reason; `direct-responses-reasoning-summary-auto` is the row that claims
+    this option' },
```

modelled on the sentence one surface over, which is true about the same knob.
With the round-4 `reasoning.effort` defect underneath, that took the suite from
one failing test back to 2303/2303. **The three staleness checks an excuse must
pass are all satisfied BY dropping the claim** — dropping it is what makes the
excuse well formed. `PROBE_SHAPED_KEYS` now lists the excusable keys per surface,
outside every roster, and a row may only opt in.

**#25 is the same shape one table over.** `freeFieldsReached()` was added in
round 4 to name the exemptions no roster has ever read. The argument behind it is
not about prose, it is about un-run inputs — and the BINDING table had two, the
cache-write number on both OpenAI surfaces, present in the table and absent from
every run. The only coverage assertion was `checked > 0`, one number over eleven
bindings. Every OpenAI capture reports `cache_write_tokens: 0`, so the fix is to
serve the number rather than to write down that nobody reads it, and
`bindingsReached()` is now the mirror of `freeFieldsReached()`.

### What the Claude seat could not break

Recorded because the campaign's stopping rule depends on it:

- The three `stopReason` derivations are faithful transcriptions, checked against
  their sources rather than their comments, including the `n`-fan-out shape and
  the tool-call precedence. The two effects they do not cover are unreachable.
- `harnessGapsFrom()` is right for three premises it has never seen — two missing
  items, a missing item that is not last, `choices` instead of `output` — and
  round 4's `billing` construction is not derivable from a premise about
  `reasoning`.
- No `free` reason that a roster reaches is false. Round 4 found two; there is no
  third.
- Answering round 4's `MANDATORY_REQUEST_KEYS` finding by measurement rather than
  by the ban the report asked for was correct, and the ban would have been wrong:
  the three rows that claim `messages` each send their subject inside it.
- The batch ceiling holds; `outcomeOf` is a faithful refactor; `abortedRow`'s
  partly-sampled row can only raise the floor, never lower it.

### One clause that was true of two surfaces and inherited by a third

The seat found no third false `free` reason and named one clause as imprecise
rather than false, for the record and without counting it.
`usage.reasoningOutputTokens` is written in the Chat table and inherited by
`/v1/messages`, where it says the shape half "sees the same path on both sides
whatever the number" — and on that surface the two sides carry different paths:
`anthropicUsage` omits `output_tokens_details` and the absence is DECLARED. What
the clause asserts is true there for a stronger reason than the one given.

Fixed in `c1ed728`, because it is the same shape as round 4's `stopReason`
finding one clause deep instead of one entry deep: a sentence written about two
surfaces and spread onto a third where it reads false.

### Two comments that did not match their code

Neither reported as a finding, both fixed in `79fd65e`: `REQUIRED_EFFECTS` said
the cut text was among the ways a client sees `stop_sequences` honoured and its
table did not list it (it cannot — one row sends an EMPTY list), and
`anthropicStopReason` reads the raw answer while `applyStopSequences` can
overwrite the stop reason before the messages shaping sees it. The second runs in
the failing direction and is deliberate; now it says so.

### One change with no control, said out loud

`servedResult` passes the answer's `toolCalls` through instead of replacing them
with a constant, because both stop-reason derivations branch on them while the
backend discarded them. **No input distinguishes the two spellings** — no roster
row sets `toolCalls` — so it is written into the code as an uncontrolled change
rather than counted as covered. What it removes is a latent disagreement.

### Round 5's tables

```
supplied-echo-mutants.py     55/55 killed, restored, dist matches tree (re-run at `79fd65e`)
echoed-defaults-mutants.py   14/14 killed, restored, dist matches tree
aa-sampler-controls.py       33/33 killed, no unbacked case
state-lock-controls.py       10/10 killed, no unbacked case
sse-capture-controls.py      15/15 killed, restored
probe-exchange-controls.py   10/10 killed, restored
```

Five mutants are new (S52-S55, A33) and the lock table grew from five to ten.
S50 and S51 both SURVIVED their first run and both were right to: S51 reverted
the widened scan and nothing failed, because every constant the widening newly
reaches is already named free — the case that must fail is the NEXT constant, and
no test could express it until the result builder became a parameter. S50 reached
`model`, which the widening had made reachable by every row, so it proved
nothing; `stopSequence` is the one reason left that nothing has ever read.

## Round 5, second seat — re-dispatched, and the one it found first was not the worst

The codex seat was re-run against `79fd65e` with the same questions worded as the
durability questions they are. It ran to a verdict this time: **not ready to
certify**, one high and five medium, every one reproduced.

| # | finding | closed by |
| --- | --- | --- |
| 28 | the harness PREMISE is still row-local: a dropped answer item can be reclassified as a harness limitation by the row it happened to | `f7bade8` |
| 29 | the bindings read the row's `answer`, not the value `servedResult()` hands the proxy | `f7bade8` |
| 30 | `harnessGapsFrom()` attributes a duplicate-typed omission to the first occurrence | `f7bade8` |
| 31 | two `stopReason` oracles omit effects the server applies after the answer is written | `2eac905` |
| 32 | run identity still depends on `TMPDIR` and on the spelling of `--only` | `3eb578f` |
| 33 | a signal abandons the call in flight, and a failed ledger write leaves no readable copy | `3eb578f` |

**#28 is the round-4 diagnosis one level up, and the most client-visible result
of the campaign so far.** Round 4 moved the gap LIST out of the row and derived
it from the capture. The fact that decides WHICH items may be absent stayed a row
field. The seat made `/v1/responses` drop its message item for one request,
changed that row's `harnessPremise.ours` from `['message']` to `[]`, re-derived
the list — and the client received **no answer item at all** with 2315/2315
green. The product regression supplied the very observation that validated the
row edit exempting it.

`HARNESS_MISSING_ITEMS` now names, per surface, the items our own turn cannot
produce — `reasoning` on `/v1/responses`, nothing anywhere else — as a fact about
`createReplayBackend` rather than about any capture. Every row owes the vendor's
item sequence minus those.

**#29 is the round-5 fix read one stage along.** The scan was widened to read
what the proxy is handed; the bindings still took their VALUES from the row. The
seat moved `usage.cachedInputTokens` by one inside the projection, the proxy
answered 1 against a capture that says 0, and the check reported nothing. The
control written for the widened scan added a new NAME and never moved a value at
a name already bound, which is exactly why it could not see this.

**#31 is two oracles reading an input the server had already changed.** On
`/v1/messages`, `applyStopSequences` rewrites the stop reason and the sequence
before the shaping runs, and only the TEXT half of it had been re-derived here —
so a row could declare `max_tokens` with a sequence-hitting text and be certified
while the wire said `stop_sequence`. The round-5 Claude seat read that
disagreement as failing-direction-only; the codex seat built the direction where
it passes. On `/v1/responses`, `responseCutOff` drives each function-call item's
status too, and the projection that called itself "the whole cut-off envelope"
stopped at the top-level triple — a binding `bindingsReached()` counted as run
whose branch never ran. **The binding running and the branch running are
different questions**, and only the second one was being asked.

### The two seats disagreed, and the disagreement was the finding

Both read the same `stopReason` derivations. The Claude seat checked them against
their sources and called them faithful; the codex seat built the input where the
Messages one certifies a turn the proxy ended some other way. Both readings were
careful and one was wrong — which is the argument for two providers stated as
cheaply as it can be.

### What this round cost the instrument

Five mutants had to be re-aimed and one written twice, all for the same reason
the campaign keeps paying: a mutant is a claim about what an input distinguishes.
`D1` SURVIVED because the test fabricated the shadow copy by hand instead of
observing `saveLedger` write it; the discriminating input is a ledger made
unwritable, which is the only way to see the ORDERING from outside.

### The tables at `3eb578f`

Seven tables, all green, all restored, every count from a run whose header pins
the subject revision and the runner's own digest.

```
supplied-echo-mutants.py     63/63 killed, restored, dist matches tree   (se-3eb578f.log)
echoed-defaults-mutants.py   14/14 killed, restored, dist matches tree   (ed-3eb578f.log)
aa-sampler-controls.py       34/34 killed, no unbacked case              (aa-3eb578f.log)
state-lock-controls.py       11/11 killed, no unbacked case              (sl-3eb578f.log)
ledger-controls.py            5/5 killed, no unbacked case               (lg-3eb578f.log)
sse-capture-controls.py      15/15 killed, restored                      (sse-3eb578f.log)
probe-exchange-controls.py   10/10 killed, restored                      (pe-3eb578f.log)
```

Two mutants in the supplied-echo table had to be re-aimed before it would close,
and both re-aimings are the same lesson the campaign has been paying for all
along.

**`S50` had become a mutant of an assertion, and no test watches a test.** Its
first form emptied the reader condition inside the coverage gate; with the
reserve list now empty, nothing in the roster depends on that condition and the
gate stayed green while the check did nothing. Its second form named a test that
had been renamed, matched no test at all, and the file's `before` hook then sat
on an open server handle until the harness's timeout — a TIMEOUT, which is not a
weak verdict but an absent one: **this control proves nothing** is the only
honest thing to print. The form that discriminates is DATA: a `free` entry that
no answer carries, so the roster is claiming an exemption nobody has ever read.

**`S57` could not be a test mutant either.** The item-sequence rule is new, and
loosening the assertion that checks it produces a tautology no other test can
see. Re-aimed at the PRODUCT — `/v1/responses` drops its message item when
`parallel_tool_calls` is false — it fails the gate the way a client would feel
it, which is what the rule was written to catch.

### One accident, recorded

A line-range edit to `supplied-echo-mutants.py` truncated the file: the closing
bracket, every `specials` function, and the `run_mutation_suite(...)` call were
deleted. The tail was reconstructed from the copy under
`review-artifacts/supplied-echo-confirm2-codex/dist/confirm2/original-runners/`,
and the reconstruction is byte-identical to that copy except for the two changes
this branch had already made to it (`plant_unreplayed_wire` replaced by
`drop_wire_capture_row`, and `COMPARISON` added to the mutated-file set).

The reconstructed file reported **62** mutants where the last complete run
reported 63 — so the table was not re-run until the difference had a name.
Diffing the roster against the verdict list in the previous run's log identified
`S49-required-effects-never-fails`, the one mutant lost with the tail, and it was
restored. The check that cleared the file for use was mechanical, not visual:
every mutant's needle occurs exactly once in its target, every `specials` key
used is defined, every mutated file is declared, and every special transform was
dry-run against the tree to prove it changes something. **A runner that silently
lost a mutant would have reported a smaller table as a complete one** — the count
is part of the claim, which is why the previous run's log is kept.

## Round 6 — the rule moved and its instrument stayed

Two seats, `3eb578f`, both offline, both to a verdict. Eight findings, every one
medium and every one reproduced. **Three of the eight were found independently by
both seats** — the dead item rule, the branch coverage, and the run identity that
ignores the model pin — which is the cheapest possible statement of why there are
two. Counted the other way: the codex seat filed seven, the Claude seat four, and
eleven filings are eight findings.

| # | seat | finding | closed by |
| --- | --- | --- | --- |
| 34 | both | the item-sequence rule is vacuous on `/v1/messages`: the reader sniffs `output ?? choices` | `f079526` |
| 35 | codex | a bound field the projection adds falls between the value scan and the presence test | `f079526` |
| 36 | both | `bindingsReached()` reports full coverage while four binding BRANCHES have no input | `f079526` |
| 37 | Claude | the safety argument round 5 refuted is still inside `anthropicStopReason` | `f079526` |
| 38 | codex | the raw `--only` label still splits one cohort into independent ceilings | `b9d98cc` |
| 39 | both | run identity ignores the model pin, the cap and the prompts | `b9d98cc` |
| 40 | codex | the shadow ledger can be newer than the primary, and the reader discards it | `b9d98cc` |
| 41 | codex | a capture-write failure discards an accepted response before the ledger can keep it | `b9d98cc` |

### The shape, stated by the seat that found it first

> the rule was moved out of the object it judges, and the INSTRUMENT that reports
> whether the rule applies was not moved with it.

Round 4 found that a roster row was deciding what it would itself be checked on.
Round 5 found that the rules moved out of the row were still reading facts the
row supplied. Round 6 is the next turn of the same screw: the rules are outside
and the facts are outside, and **the thing that says whether a rule is running is
still deciding for itself**.

- `itemTypesOf()` decided which surfaces the item rule covered by sniffing the
  body's shape. Anthropic answers carry `content`, so on the one surface whose
  comment promises that "a `/v1/messages` block that goes missing is a defect
  with no exemption to reach for", the all-rows assertion compared `[]` with `[]`
  for every body that surface can produce. A seat made the proxy answer a turn
  with its text block twice — **the client receives the answer doubled** — with
  2328/2328 green. The indexed value comparisons read the unchanged first block
  and the shape reader collapses arrays, so no other check could see it either.
- `bindingsReached()` decided coverage by the presence of a leaf rather than by
  the branch that produced its value. Nine branches reach no roster row; four of
  them could be rewritten to return a value no vendor sends with the whole suite
  green, and **one of those four is a branch this campaign added in round 5**,
  whose sibling it controlled in the same expression.
- The comment on `anthropicStopReason` decided what a reader believes about a
  call site it no longer describes.

### The two-seat disagreement, again, and the reverse of last time

Round 5's disagreement was about whether a derivation was faithful. Round 6's is
about severity: the Claude seat recorded the shadow-ledger ordering as a LIMIT
inside the declared "at most one over-booked call" scope; the codex seat built the
input that makes it a defect — the primary made unwritable, so the shadow is the
only complete copy and the reader hands back the stale primary anyway, losing a
paid sample that was sitting in one piece beside it. The one who wrote a sharper
input was right.

### What the fixes moved

| what used to decide | now |
| --- | --- |
| the body's own shape, for which surface the item rule covers | `SURFACE_ITEM_KEY`, passed the surface, throwing on one it does not name |
| `leafPaths(answer)`, for whether a binding runs | the union of what the roster writes and what the proxy receives |
| the presence of a leaf, for whether a derivation is covered | the BRANCH the derivation reports out of the same evaluation |
| the normalized `--only` text, in front of the cohort digest | a digest over cohort, prompts, models and cap; the label derived from the cohort |
| nothing, for whether a ledger may be resumed as this run | the identity it was opened with, and a refusal on mismatch |
| which filename was tried first, for which copy is current | a generation on every copy |
| the shadow, always truncated first | the shadow, replaced by rename — the ledger keeps its inode because the lock is |
| `null`, for both "no ledger" and "no readable ledger" | `null` and `UnreadableLedgerError` |
| `recordExchange()` throwing, for whether a paid response survives | the record carried back on the sample; persist, then stop |

### Round 6's tables

```
supplied-echo-mutants.py     72/72 killed, restored, dist matches tree   (se-30b62c6-c.log)
echoed-defaults-mutants.py   14/14 killed, restored, dist matches tree   (ed-30b62c6.log)
aa-sampler-controls.py       43/43 killed, no unbacked case              (aa-30b62c6.log)
state-lock-controls.py       11/11 killed, no unbacked case              (sl-30b62c6.log)
ledger-controls.py            9/9 killed, no unbacked case               (lg-30b62c6.log)
sse-capture-controls.py      15/15 killed, restored                      (sse-30b62c6.log)
probe-exchange-controls.py   10/10 killed, restored                      (pe-30b62c6.log)
```

Those seven logs are `review/tables/30b62c6/`, beside this file. They used to
be cited by a name only their author could resolve — a receipt that names
evidence nobody reading it can open is the same defect this campaign keeps
closing, one level up.

Twenty-two mutants are new: nine on the conformance gate (S65-S73), four on the
ledger (D3, D6, D7, D8 — plus D1, D2, D4, D5, D9 re-aimed at the rewritten
module), and nine on the sampler (A36-A44). Two older ones (S59, S62) were
re-aimed at code this round moved.

### The verification pass added the mutant the table was missing

Re-reading the table against the finding it answers: `S65` and `S66` REVERT the
fix — they put the sniff back and point the Messages key at `output` — and
nothing in the table was the defect a client would feel. `S73` is: the proxy
answers one `/v1/messages` turn with its text block twice, which is what a seat
built and what passed 2328/2328.

Proving it required getting the scope right, and the first attempt did not. An
UNCONDITIONAL doubling fails fourteen tests, twelve of them with nothing to do
with this gate — a mutant scored by a neighbour says nothing about the rule it
was aimed at, which is the failure mode this round hit twice already. Scoped to
the one turn, it fails four, two of them this gate's rows BY FIXTURE NAME.

The before/after, read off the real capture rather than argued:

| | the vendor's turn | the same turn doubled | distinguished |
| --- | --- | --- | --- |
| the reader at `3eb578f` | `[]` | `[]` | no |
| the reader now | `["text"]` | `["text","text"]` | yes |

### Two mutants that were wrong before the code was

**`D6-shadow-truncated-in-place` SURVIVED, and the test was the reason.** The
case that says a save will not consume the only copy that parses was written with
the ledger made UNWRITABLE — and that input cannot see the property. A refused
write leaves both copies untouched, so the truncation order does not matter and
the mutant was scored by a neighbouring case. The question is a write that fails
PART WAY, and `ulimit -f` in a child process is the only portable way to force
one; the state written is larger than the limit so the write is stopped
mid-object rather than refused. Without the rename that leaves two unreadable
files, which is the state the seat reached.

The first rewrite of that case "passed" for the wrong reason: a heredoc inside a
template literal never parsed, the child exited non-zero because of the quoting,
and `assert.notEqual(child.status, 0)` was satisfied by a failure that had nothing
to do with the size limit. **A control can be green because the thing it runs
never ran.**

**`S71-branch-loses-its-only-input` SURVIVED because it added a control instead of
removing one.** It was written to take a branch's only input away, and what it
actually did was insert a second control for a branch that already had one — a
no-op the coverage report was right to pass. Re-aimed at the real defect shape: a
control whose input DRIFTS off the branch it was written for, which leaves the
branch with nothing and the table still looking complete.

### One change with a stated limit

`resumeRefusal()` refuses a ledger written before run identity was recorded, and
that refusal costs a re-run of any such ledger. There are none outside this
campaign's own scratch runs, and the alternative — accepting it — is the exact
merge the refusal exists to prevent, with nothing on disk able to say whether it
was safe.
