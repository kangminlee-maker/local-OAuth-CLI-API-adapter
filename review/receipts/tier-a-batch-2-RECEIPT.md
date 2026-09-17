# Verification receipt — the rest of the direct store, and the streamed capture path

Every number below names the command that produced it and the tree it ran on.

- **Repo**: `/Users/kangmin/Documents/cli-api-adaptor/local-OAuth-CLI-API-adapter`
- **Revision**: `b3f094c925ce93fd47387b9d57b68a91341b36d4`
- **Subject**: `review-artifacts/echoed-defaults-evidence`, a detached worktree
  at that revision, clean over `src test spec scripts` before and after. The
  files belonging to another session exist only in the main checkout.
- **Date**: 2026-09-10
- **Logs**: `review-artifacts/stage2/evidence-b3f094c/`

## Offline suite

```
$ pnpm test
ℹ tests 2195
ℹ pass 2195
ℹ fail 0            (rc 0 — evidence-b3f094c/full-suite.log)
```

2132 -> 2195: 58 for the twenty-nine captures now replayed (two tests each), and
5 for the streamed capture path.

## Mutation

Both tables re-run unchanged against the larger roster.

```
$ python3 ../stage2/supplied-echo-mutants.py --root . --log ../stage2/evidence-b3f094c
SUBJECT b3f094c925ce93fd47387b9d57b68a91341b36d4 — 219 tracked inputs verified against that revision
BASELINE OK: True   ALL KILLED: True   RESTORED: True   DIST MATCHES TREE: True   (24/24)

$ python3 ../stage2/echoed-defaults-mutants.py --root . --log ../stage2/evidence-b3f094c
BASELINE OK: True   ALL KILLED: True   RESTORED: True   DIST MATCHES TREE: True   (14/14)
```

## What the recon found before anything was promoted

`review-artifacts/stage3/recon-unpromoted.mjs` replays each candidate's recorded
request bytes against the real server and compares status, shape and echo with
the surface's declarations applied — so the verdict is a gate's, not a diff's.
Its receipt is `promotion-RECON.md`.

| verdict, over 38 candidates | count |
| --- | --- |
| status divergence | **0** |
| clean once declarations are applied | 12 |
| clean with nothing declared | 18 |
| real differences | 8 |

Twenty-nine were promoted and given rows. Two matrix cells were false and the
captures are what showed it — `max_tool_calls` mirrors the supplied integer
rather than echoing a hard `null`, and `prompt_cache_options` is mirrored AND
canonicalised rather than silently ignored. Ten Responses rows moved DOC/DOC? to
WIRE; the coverage instrument counts **17/148**, up from 7.

## The streamed capture path

`scripts/lib/sse-capture.mjs` records in a `finally`, so a refusal, a stream
that dies halfway and a connection reset before the response head are all
recorded rather than thrown past. `test/sse-capture.test.mjs` drives a local
server for each of those exits and reads what was written.

**Confirmed on the live path, unintentionally.** The runner was invoked with
`--help`, which is not a help flag — it ran the benchmark, and four exchanges
went through the local proxy to the codex backend before the pipe closed. Two of
them are `sse` records written by this new code, 3456 and 4426 bytes of wire
text, 13 and 15 frames, terminator intact in both
(`artifacts/api-captures/2e39b93c-4361-4dc4-b19e-8bef63c755df/`). The cost was
the user's codex session quota, not vendor API spend. Recorded here because a
run that happened should be in the receipt whether or not it was meant.

## What is NOT verified here

- **The A/A noise floor at 24 samples.** It needs live calls by construction,
  and nothing in this increment is authorised to spend them.
- **The nine captures left unpromoted**, each with its reason in
  `promotion-RECON.md`: one duplicate claim, one incomplete vendor turn, one
  `moderation` block this proxy cannot produce, and six on a third surface
  (`/v1/messages`) whose usage members are undeclared.
- **Member identity in the shape reader**, still open as
  `docs/design-task-conformance-member-identity.md`.
- That `pnpm test` is credential-independent. Several tests read the ambient
  `~/.local-oauth-cli` state, so 2195/2195 is a result on a machine where that
  directory exists.
- One whole-suite run in the MAIN checkout failed
  `native-session-interrupt.test.mjs` once, concurrently with the accidental
  benchmark run holding a codex child. It passed 95/95 twice in isolation and
  did not recur in the clean worktree above.

## Confirmation round 1, folded (`6933644`)

Two seats, both on OpenAI models via `codex exec` with the packet on stdin and no
network beyond that: `gpt-6-astra`/xhigh and `gpt-5.6-sol`/ultra. The Fable seat
this repository normally uses failed at dispatch — out of usage credits — so the
round bought a model difference and an effort difference where it usually buys a
provider difference as well. Recorded because a round is worth what its
independence was, not what was intended.

Eight findings between them, six distinct. **Every one is in the instrument. No
construction produced a wrong answer to a client's request.** Both seats reached
the null-body test and the shortened diagnostic independently.

| # | Seat | What it was | Where |
| --- | --- | --- | --- |
| 1 | astra | recon computed `staleDeclarations` and left it out of its verdict, so a capture the gate would reject came back CLEAN | `stage3/recon-unpromoted.mjs` |
| 2 | astra | `res.text()` recorded nothing for a refusal cut mid-body | `scripts/lib/sse-capture.mjs` |
| 3 | both | `const [record] = run.records()` passes a helper that records twice; the case named for a body-less response served an empty stream and never reached that branch | `test/sse-capture.test.mjs` |
| 4 | astra | three receipt counts wrong: subject 190 (real **219**), frames "13" (real **13 and 15**), moderation 130 paths (real **127**) | this file, `promotion-RECON.md`, handoff |
| 5 | both | the extraction cut a caller's diagnostic from 2000 characters to 400 | `scripts/lib/sse-capture.mjs` |
| 6 | sol | a stream cut inside a multi-byte character recorded zero bytes: the decoder held the first byte and the throw skipped the flush | `scripts/lib/sse-capture.mjs` |

Finding 4 is the one worth naming plainly: the receipt printed a number the
harness did not print. The harness said 219 at `b3f094c` and this file said 190,
which is close to the 188 of the increment before it — a count that should have
jumped by the 29 promoted captures and instead barely moved. It was transcribed,
not read. The earlier receipts were checked against their own evidence
directories and are correct (188 at `d342475`, 187 at `2bef0b2`).

Finding 6's exact bytes are NOT closed. U+FFFD is three bytes where one arrived,
so `stream.bytes` still misstates that one case. Making it exact means a record
that can carry binary, and that shape is read by every promoted fixture and the
provenance binding that re-derives it —
`docs/design-task-capture-records-decoded-text.md` asks the question rather than
answering it inside a defect fix.

### The controls, and the control that was blind

```
$ python3 ../stage3/sse-capture-controls.py --root .
SUBJECT scripts/lib/sse-capture.mjs sha256 8ae0846773dd8b3d3b0d5d9b303eac95cf2ea43f2753c56ed4b538eccc23e410
BASELINE rc=0 # pass 9 (9 ok lines seen)
[C1-record-twice]           KILLED (rc=1)   7 tests fail
[C2-null-body-succeeds]     KILLED (rc=1)   'a success with no body at all is refused, and recorded'
[C3-refusal-all-or-nothing] KILLED (rc=1)   'a refusal cut off mid-body keeps the bytes that arrived'
[C5-no-flush-on-exit]       KILLED (rc=1)   'a stream cut inside a character records that something arrived'
[C4-short-truncation]       KILLED (rc=1)   'a long refusal is truncated in the message and kept whole in the record'
RESTORED True (8ae0846773dd)
ALL KILLED: True   (5/5)
```

The first run of that script printed **4/4 SURVIVED with "failing: none"**.
`node --test` picks the `spec` reporter here, whose failures carry no `not ok`
line, so a control parsing TAP saw no failures and printed the same word for
"protected" and "blind". The reporter is pinned now and the baseline asserts its
`ok` line count. This is the fourth time in this campaign that the instrument,
not the subject, was the thing that was wrong — and the first three were found
the same way, by an agreement nobody had earned yet.

```
$ python3 ../stage3/recon-stale-control.py --root . --store <main>/artifacts/direct-api-captures
SUBJECT dist/proxy/http-server.js sha256 89ec7cb35550d03efbd492f08752962887382a0fc681b637d18c476f6ad7348b
BASELINE recon over 50 captures: {'DIFFERENCES': 11, 'CLEAN (declared)': 17, 'CLEAN': 22}
BASELINE gate rc=0
PLANTED  .reasoning.mode, which /v1/responses declares absent
         recon: {'STALE DECLARATION': 20, 'DIFFERENCES': 7, 'CLEAN (declared)': 1, 'CLEAN': 22}
         gate rc=1  direct-responses-service-tier-flex: the proxy answers in the vendor's shape; ...
RESTORED True (89ec7cb35550)
RECON AND GATE AGREE: True
```

Before the fix those 20 were `CLEAN (declared)` while the gate exited 1 on the
same plant. The control requires BOTH — recon naming it and the gate failing —
because either alone is the disagreement it exists to remove.

### Baselines at `6933644`, clean worktree `review-artifacts/batch2-evidence`

```
BUILD OK      node scripts/verify-runtime-boundary.mjs OK
# tests 2199  # pass 2199  # fail 0        (2195 + the four new streamed-exit cases)

$ python3 ../stage2/supplied-echo-mutants.py --root . --log ../stage2/evidence-6933644
SUBJECT 69336448deb3b844b458194586a91a506ccf431a — 219 tracked inputs verified against that revision
BASELINE OK: True   ALL KILLED: True   RESTORED: True   DIST MATCHES TREE: True   (24/24)

$ python3 ../stage2/echoed-defaults-mutants.py --root . --log ../stage2/evidence-6933644
BASELINE OK: True   ALL KILLED: True   RESTORED: True   DIST MATCHES TREE: True   (14/14)
```

`git status` in that worktree is empty apart from the supplied `node_modules`
symlink. The main checkout carries five entries that belong to another session,
not four: `docs/runtime-capability-catalog.md`,
`scripts/runtime-capability/collect.mjs`, `test/claude-code-backend.test.mjs`,
the untracked `docs/runtime-capability-update-2026-09-07-claude.md`, and the
untracked `.claude/` (which holds that session's agent worktree). None was
touched or staged.

### What is still NOT verified

- The real runner was not invoked, under any flag. Its streamed path is
  exercised by `test/sse-capture.test.mjs` against a local server, not against a
  vendor.
- Byte-exact recording of a wire that is not valid UTF-8 (design task above).
- The A/A noise floor still needs live calls and has no authorization.

## Confirmation round 2, folded (`ccc58c9`)

**One seat, and it bought isolation only.** Both codex seats died at dispatch on
a usage limit that resets 2026-09-16, and the Fable seat is out of credits, so
the round ran on a fresh-context Opus — the same provider and model family as the
author. Recorded plainly because a round is worth the independence it actually
had: this one had none beyond a clean context, and its own report says which
claims it did not test.

Six findings, all instrument or document. **No proxy defect.** The two that
mattered are both this campaign's recurring shape, one level down from where it
was last found.

**F1 — half of the previous round's fix was unprotected.** Removing
`rawStream += tail` (the good path's flush) leaves the whole suite green at
2199/2199 while the frame callback is handed a character the record does not
hold. Case #3 already asserts `record.stream.text === rawStream`, and it does not
catch this: its stream ends on a blank line, so the tail is empty and the
assertion holds either way. A stream ending INSIDE a character is what separates
them. Added, along with C6/C7 (both halves of the good-path flush), C8 (the
refusal branch's own flush, which runs before the thrown message is built) and
C9 (the whole body the error hands its caller).

**F2 — the defect removed from the runner was still live in the script that
produced the store.** `scripts/probe-direct-api.mjs` wrote every capture in
`artifacts/direct-api-captures`, which is the frozen side of all three gates, and
it still read a stream with `res.text()`. Cut halfway it recorded
`status: null, stream: null` — worse than the empty string the runner used to
write, because it reads afterwards as a call that was never made. Swept: 225
records, 4 of them `sse`, **0** affected. Latent, not lost evidence.

Its stream probes go through `readRecordedSse` now; its buffered branch records
the status the response already gave; and `SseTransportError` carries the whole
body, because a refusal is an OBSERVATION to these probes rather than a failure
— P-10 exists to see one.

**That file cannot be verified by running it.** It refuses to start without both
vendor keys and, given them, spends real vendor calls. Its base URLs are
deliberately not overridable: an env var that redirected them would let bytes
claiming to be the vendor's enter the store. So the check is split, and each half
is worth exactly what it says:

```
$ node ../stage3/probe-stream-glue.mjs --root .
STRUCTURE OK — the shipped stream branch delegates (622 chars of code, 630 of comment)
BEHAVIOUR OK — a whole stream: status 200, 1 record, 29 bytes, terminator present
BEHAVIOUR OK — a refusal: status 400 observed rather than thrown, record holds all 42 bytes
BEHAVIOUR OK — a stream cut halfway: record keeps status 200 and 29 bytes, error present
GLUE OK: 3/3   (transport not transcribed: it is the shipped module)
```

Pointed at the pre-fix file it REFUSES rather than passes (`the stream branch is
not where this control expects it`). The structure half is what binds the
transcription to the code that ships; the transport is not transcribed at all,
because it is the module with eleven tests and nine control mutants.

F3–F6 were one editing pass: `recon-stale-control.py` now asserts the path it
plants (`.reasoning.mode`) rather than any stale path, and prints it;
`sse-capture-controls.py` pins its baseline case count instead of requiring it
non-zero — the blindness it was patched for yields zero parsable lines, but a
suite that silently lost eight of eleven cases would have gone on reporting every
mutant killed; the design task's claim that the provenance binding hashes the
payload was wrong (it binds source blobs to a revision and contains no digest of
the payload at all), the two other places a byte count is derived from decoded
text are named in its Scope, and the fact that **nothing reads `streamBytes` or
`bodyBytes` back** is recorded — which makes changing the record shape cheaper
than the document implied. One extra, found while checking fix #5's claim: the
runner's `truncate` took one parameter while a call site passed two, so a payload
asked for at 500 characters was cut at 2000 in silence.

### Baselines at `ccc58c9`, clean worktree `review-artifacts/batch2-evidence`

```
BUILD OK      node scripts/verify-runtime-boundary.mjs OK
# tests 2201  # pass 2201  # fail 0        (2199 + the two new mid-character cases)

SUBJECT ccc58c9e257f6ba1084ccefe9842617dd06c2945 — 219 tracked inputs verified against that revision
supplied-echo    BASELINE OK: True  ALL KILLED: True  RESTORED: True  DIST MATCHES TREE: True  (24/24)
echoed-defaults  BASELINE OK: True  ALL KILLED: True  RESTORED: True  DIST MATCHES TREE: True  (14/14)

sse-capture-controls.py   BASELINE # pass 11 (11 of 11 expected)   ALL KILLED: True (9/9)
recon-stale-control.py    RECON AND GATE AGREE ON .reasoning.mode: True
probe-stream-glue.mjs     GLUE OK: 3/3
```

`git status` in that worktree is empty apart from `node_modules`.

### What is still NOT verified after two rounds

- `scripts/probe-direct-api.mjs` has never been run here, and will not be without
  authorization to spend vendor calls. Its stream branch is now the module the
  gates' tests cover; its glue is checked by transcription bound to the file.
- The benchmark runner itself, under any flag.
- Byte-exact recording of a wire that is not valid UTF-8 — open design task,
  `docs/design-task-capture-records-decoded-text.md`.
- The A/A noise floor: needs live calls, has no authorization, and the codex
  quota that would pay for a review of it resets 2026-09-16.
- Round 2 bought no provider or model independence. If that matters for merging,
  it is a reason to wait rather than a defect in what is here.

## Confirmation round 3, folded (`76a56ad`)

**Two codex seats, and the first provider difference to read either fix commit**
— `gpt-6-astra`/xhigh and `gpt-5.6-sol`/ultra, on `783e462..ccc58c9`. sol
returned **DO NOT SHIP**. Both reached the same HIGH by different constructions.

**H1 — the checker round 2 built reported PASS on implementations that cannot
work.** `probe-stream-glue.mjs` read three token patterns out of the shipped file
and ran a transcription beside it. astra planted four changes (reverse the
refusal test, `wire = ''`, `text = ''`, the reader behind `if (false)` returning
fabricated text); sol planted an unconditional throw immediately after the real
read. **All five reported `GLUE OK: 3/3`.** One of them made zero HTTP requests.

The receipt's own claim at "Confirmation round 2, folded" — that the structure
half binds the transcription to shipped behaviour — **was false**, and this
paragraph is where that is recorded. Token presence is not execution.

The glue is a function now: `scripts/lib/probe-exchange.mjs`, called by
`test/probe-exchange.test.mjs` against a local server, with
`stage3/probe-exchange-controls.py` planting into the file that ships — the four
constructions that walked past the old checker among them.

```
$ python3 ../stage3/probe-exchange-controls.py --root .
BASELINE rc=0 7 of 7 expected ok lines
[P1-refusal-is-a-failure]           KILLED   'a refusal is an observation, not a failed exchange'
[P2-wire-blanked]                   KILLED   'a streamed answer comes back whole, and is recorded once'
[P3-text-blanked]                   KILLED   'a refusal is an observation, not a failed exchange'
[P4-reader-never-called]            KILLED   'a streamed answer comes back whole, and is recorded once'
[P5-throw-after-the-reader]         KILLED   'a streamed answer comes back whole, and is recorded once'
[P6-buffered-catch-forgets-status]  KILLED   'a buffered body that dies mid-read keeps the status the vendor gave'
[P7-cut-stream-reported-readable]   KILLED   'a stream cut halfway keeps its status and its bytes'
RESTORED True (52d7c952b226)
ALL KILLED: True   (7/7)
```

This is the FIFTH time in this campaign that the instrument, not the subject, was
the thing that was wrong — and the second time running, one level up: round 2's
instrument checked round 1's fix, and round 3's seats checked round 2's checker.

**H2 — a caller whose `onFrame` threw left the request open until an unrelated
timeout** (180 s for the prober, 240 s for the runner), while the exception had
already reached the caller. The reader is released on every exit that is not the
stream ending on its own; the case drives a server that never ends its response
and requires the close inside two seconds against a 30 s timeout.

**H3 — a probe's refusal was an observation and a failed exchange at once.**
`readRecordedSse` set `failure` for every non-2xx, so `captureSummary()`
counted a P-10 answer as a failure. The runner asks for a completion and a 4xx
means it did not get one; the prober asks what the vendor says to a bad request
and the 4xx IS the answer. `refusalIsFailure` (default true) is the caller's
say: with it false, a non-2xx and a body-less success come back as returns with
`error: null`. A body cut halfway stays a failure whatever the status was.
`SseTransportError.body`, added in round 2 for exactly this case, lost its
consumer and was removed with it.

**H4 — the design task's producer list and cost were still wrong.** Two more
producers derive a byte count from decoded text (`api-comparison-benchmark.mjs`'s
JSON and multipart paths, `probe-text-surface-keys.mjs`), and a paragraph still
charged the migration to the provenance binding two paragraphs after correctly
saying that binding never reads a payload. The correction that matters most:
**the 45 promoted fixtures discarded their original bytes when they were
recorded, so no migration makes them byte-exact retroactively** — they can only
be re-labelled.

**The control table was rewritten in one form.** Every mutant is now a list of
edits, each required to match exactly once, and every planted module must parse
before its failure counts. The previous table had drifted: four mutants silently
became NOT PLANTED when the source moved, and a four-field row among five-field
rows killed the loop halfway through — it printed eight verdicts and no total.

### Baselines at `76a56ad`, clean worktree `review-artifacts/batch2-evidence`

```
BUILD OK      node scripts/verify-runtime-boundary.mjs OK
# tests 2212  # pass 2212  # fail 0

SUBJECT 76a56ad73fb82fb1edc9fea59b046a6d1c67eb15 — 221 tracked inputs verified against that revision
supplied-echo    BASELINE OK: True  ALL KILLED: True  RESTORED: True  DIST MATCHES TREE: True  (24/24)
echoed-defaults  BASELINE OK: True  ALL KILLED: True  RESTORED: True  DIST MATCHES TREE: True  (14/14)

sse-capture-controls.py    BASELINE 15 of 15 expected   ALL KILLED: True (12/12)
probe-exchange-controls.py BASELINE  7 of 7  expected   ALL KILLED: True  (7/7)
recon-stale-control.py     RECON AND GATE AGREE ON .reasoning.mode: True
```

`git status` in that worktree is empty apart from `node_modules`.

### What round 3 checked that earlier rounds had not

Recorded because it is what a provider difference bought. Both seats built their
own constructions rather than reading the tests: a throwing `onFrame`; a refusal
cut mid-read; 302 and 307 redirects; `content-length` lying in both directions; a
stream ending exactly on a chunk boundary; 204; wholly invalid UTF-8; and whole
refusal decoding against `Response.text()` across identity/gzip/brotli/deflate,
BOM, declared ISO-8859-1, empty, 64 KiB, 64 KiB+1, 2 MB and 8 MB bodies —
**36/36 and 13/13 identical**. They also audited the control table itself: every
anchor occurring exactly once, every planted module parsing, every
`expected_test` matching exactly one case name, and a "KILLED" from a build error
correctly reported as SURVIVED.

astra's full-suite run reported 375 failures under its own sandbox guard (268
naming credential-path denial, 15 process denial); sol's, without that guard,
reproduced 2201/2201. The delta is the guard, not the tree.

### What is still NOT verified after three rounds

- `scripts/probe-direct-api.mjs` as a file has never been run here. Its one
  exchange is now `scripts/lib/probe-exchange.mjs`, which is called by tests and
  planted by controls; what remains untested is its probe table and its
  detectors, which need vendor calls.
- The benchmark runner, under any flag.
- Byte-exact recording of a non-UTF-8 wire — open design task, and the 45
  existing fixtures cannot be made byte-exact at all.
- The A/A noise floor: needs live calls and has no authorization.

## Confirmation round 4, folded (`b7621ed`)

Two codex seats on `ccc58c9..76a56ad`. sol returned **DO NOT SHIP** again. Both
seats reached the same two HIGHs independently, and sol found two more.

**J1 — a skipped case satisfied the pinned baseline.** TAP writes a disabled
test as `ok 3 - name # SKIP`, and both control tables counted lines beginning
with `ok`. Turning three probe cases (and, in the other seat's construction,
five SSE cases) into `test.skip` left `7 of 7` and `15 of 15` unchanged, and
every mutant still reported KILLED.

```
# tests 7   # pass 4   # fail 0   # skipped 3
BASELINE rc=0 7 of 7 expected ok lines
ALL KILLED: True   (7/7)
```

The denominator certified execution that had not happened — including, in one
seat's construction, the interrupted-refusal guarantee the previous commit had
just added. **This is what the count was pinned for in round 3, and it was still
blind.** The reading is now the reporter's own summary (`tests`, `pass`, `fail`,
`skipped`, `todo`, `cancelled`) plus a roster pinned by NAME, in one shared
module (`stage3/control_baseline.py`) rather than two copies, and `--self-test`
disables a rostered case and requires the baseline to refuse:

```
$ python3 ../stage3/sse-capture-controls.py --root . --self-test
SELF-TEST skipped 'a refused stream is recorded with its body, not thrown away in a message'
         BASELINE rc=0 tests=15 pass=14 skipped=1 todo=0 cancelled=0 roster=15
         rc=2
BASELINE REFUSES A DISABLED CASE: True
```

**J2 — the probe gate never looked at the request.** Its local handlers answered
without reading what arrived, so a helper sending `body: '{}'` — or dropping the
supplied headers — passed all seven cases, while the record froze the caller's
original bytes as though they had crossed the wire:

```
{"requested":"{\"probe\":1}","seen":"{}","recorded":"{\"probe\":1}","status":200,"failed":null}
```

This is the campaign's own defect with the sides swapped. For four rounds the
question was whether a record holds what the response really said; the request
half was being taken on trust the whole time, in the store that is the frozen
vendor side of all three gates. The servers observe method, path, headers and
body now, the record's request side is compared against what the server actually
received, and P8/P9 send something else. **9/9.**

**J3 — `DIST MATCHES TREE: True` could bless a compiled file with no source.**
The harness built without emptying `dist`, so anything already there entered the
baseline digest, and the final comparison then proved only a return to it — true,
and not what the line claims. A reviewer planted `dist/proxy/round4-phantom.js`
with no `.ts` beside it and the harness blessed it. Reproduced here before the
fix and after: the baseline now empties the directory, refuses a build that
writes nothing, and prints `DIST BUILT CLEAN: 56 compiler outputs, from an
emptied directory`. The planted phantom is gone when the run ends.

**J4 — a buffered failure was recorded as an empty response body.** `text`
starts as `''` and the catch passed it through, so `encodeBody` wrote a known
zero-byte body carrying the empty string's digest: a turn whose answer never
arrived, stored as one the vendor answered with nothing. Both readers this
replaced omitted the field in their catch and recorded `response: null`. It is
omitted again, and both failure points assert it.

### Baselines at `b7621ed`, clean worktree `review-artifacts/batch2-evidence`

```
BUILD OK      node scripts/verify-runtime-boundary.mjs OK
# tests 2212  # pass 2212  # fail 0  # skipped 0  # todo 0  # cancelled 0

SUBJECT b7621eda825915f51cc06787646fab719039d727 — 221 tracked inputs verified against that revision
DIST BUILT CLEAN: 56 compiler outputs, from an emptied directory
supplied-echo    BASELINE OK: True  ALL KILLED: True  RESTORED: True  DIST MATCHES TREE: True  (24/24)
echoed-defaults  BASELINE OK: True  ALL KILLED: True  RESTORED: True  DIST MATCHES TREE: True  (14/14)

sse-capture-controls.py    tests=15 pass=15 skipped=0 roster=15   ALL KILLED: True (12/12)
probe-exchange-controls.py tests=7  pass=7  skipped=0 roster=7    ALL KILLED: True  (9/9)
both --self-test           BASELINE REFUSES A DISABLED CASE: True
recon-stale-control.py     RECON AND GATE AGREE ON .reasoning.mode: True
```

`git status` in that worktree is empty apart from `node_modules`.

### The count so far

Four rounds, seven seats, **nineteen distinct findings, every one of them in the
instrument.** No construction in any round made the proxy answer a client's
request wrongly, and `src/` has not been touched since `2bef0b2`. What each round
found was the round before it:

| round | found | in |
| --- | --- | --- |
| 1 | five | the capture path and the recon |
| 2 | six | round 1's fix, and the sibling script that produced the store |
| 3 | four | the checker round 2 built to verify round 2's fix |
| 4 | four | the count round 3 pinned, and the request side nobody had checked |

### What is still NOT verified after four rounds

- `scripts/probe-direct-api.mjs` as a file — its exchange is a tested function
  now; its probe table and detectors need vendor calls.
- The benchmark runner, under any flag.
- Byte-exact recording of a non-UTF-8 wire — open design task; the 45 existing
  fixtures cannot be made byte-exact at all.
- The A/A noise floor: needs live calls and has no authorization.

## Confirmation round 5, folded (`885929a`)

**One seat completed.** `gpt-5.6-sol` was refused by its provider mid-run —
"This content was flagged for possible cybersecurity risk" — and exited rc=1
with no verdict. The packet asks for adversarial constructions against a
security-adjacent instrument, and that is apparently enough to trip the filter.
Recorded because it is a property of this review method, not of the code.
`gpt-6-astra` finished: **DO NOT SHIP**, six findings.

Two of them are the same shape as each other and as rounds 3 and 4: **a fix
reaching only half of what it was said to reach.**

**K1 — a TAP run with two summaries was read by taking the first.** The seat put
an all-passing summary ahead of the reporter's real output; the control printed
`7 of 7` while the lines below it said one case had been skipped. A duplicate
case name also satisfied a roster it appears on once. Every summary field is now
read every time it appears, and fields that disagree are a refusal: with two
summaries there is no ground for believing either, and choosing one is the
error.

**K2 — the request binding round 4 added checked the body and not the
destination.** Same bytes to `/round5-wrong` passed. It compared the record with
the wire in one case out of seven; it never counted the server's attempts, so a
reader that sent twice and recorded once passed; and it was **not in the SSE
file at all** — the defect round 4 closed in the prober had been sitting one file
over since round 1. Both suites now assert method, path, headers, body and
attempt count, and every case with a complete request compares the record
against what the server received.

**K3 — the assertion round 4 added for a buffered pre-response failure was
written on a STREAM probe**, where the field is null for a different reason. The
real case is here, with P10 restoring the bug at that exit alone.

**K4 — a file written DURING the build still entered the baseline.** Emptying
`dist` first only closes what was there before it. The seat wrote
`dist/proxy/round5-phantom.js` after compilation and the harness printed
`DIST BUILT CLEAN: 57` — a count compared to nothing. Every emitted file must
now have a source under `src/`. Verified both ways here: a phantom planted
before the build is wiped; one planted during it is refused.

```
$ NODE_OPTIONS="--require <post-build hook>" python3 ../stage2/echoed-defaults-mutants.py --root .
BASELINE-BUILD-FAIL: 1 compiled file(s) have no source under src/
  (['proxy/round5-phantom.js']), or nothing was emitted at all (57).
```

**K5 — the same wipe deleted the harness's own log directory** when `--log`
pointed inside `dist`. Recreated after cleaning.

**K6 — this receipt said "twenty-two findings" over rows summing to 19.**
Corrected to nineteen, which is what its own table says.

### The controls now measure their coverage instead of asserting it

A rostered case that no mutant makes fail is printed by name at the end: the
roster proves a case RAN, never that it asserts anything, and the seat
demonstrated that by replacing a case body with `async () => {}` and watching
everything stay green. Three SSE cases came back unbacked on the first run —
`a whole stream is recorded once, with the terminator`, `a 200 whose stream
carries nothing…`, `a body-less success is an answer too…` — and C14/C15/C16
back them now.

`--self-test` disables **every** rostered case in turn rather than the first,
and requires the unmodified baseline to be **accepted** before any of it counts.
The seat showed the old form passing on a control that refused everything.

### Baselines at `885929a`, clean worktree `review-artifacts/batch2-evidence`

```
BUILD OK      node scripts/verify-runtime-boundary.mjs OK
# tests 2213  # pass 2213  # fail 0  # skipped 0  # todo 0  # cancelled 0

SUBJECT 885929aaca28614a2b4686d9ac779138fa1317c0 — 221 tracked inputs verified against that revision
DIST BUILT CLEAN: 56 compiler outputs, every one with a source under src/
supplied-echo    BASELINE OK: True  ALL KILLED: True  RESTORED: True  DIST MATCHES TREE: True  (24/24)
echoed-defaults  BASELINE OK: True  ALL KILLED: True  RESTORED: True  DIST MATCHES TREE: True  (14/14)

sse-capture-controls.py    tests=15 pass=15 roster=15  ALL KILLED: True (15/15)  0 unbacked
probe-exchange-controls.py tests=8  pass=8  roster=8   ALL KILLED: True (10/10)  0 unbacked
--self-test                REFUSES EVERY DISABLED CASE: 15/15 and 8/8, unmodified accepted
recon-stale-control.py     RECON AND GATE AGREE ON .reasoning.mode: True
```

`git status` in that worktree is empty apart from `node_modules`.

### Five rounds, eight seats, twenty-five distinct findings — every one in the instrument

`src/` has not been touched since `2bef0b2`, and no construction in any round has
made the proxy answer a client's request wrongly.

| round | found | in |
| --- | --- | --- |
| 1 | five | the capture path and the recon |
| 2 | six | round 1's fix, and the script that produced the store |
| 3 | four | the checker round 2 built to verify round 2's fix |
| 4 | four | the count round 3 pinned, and the request side nobody had checked |
| 5 | six | the summary round 4 pinned, the half of the request side it reached, and the build it cleaned |

What is worth reading off that table is not the total but where the findings
sit. Rounds 3, 4 and 5 each found the previous round's instrument, and the
severity of what they found has not fallen: round 5's K1, K2 and K4 are all
"a gate reports PASS on false evidence". **This has not converged.** What HAS
stayed constant is the boundary: every finding is in the measuring apparatus,
none in the thing measured.


## Merged (`29bc005`)

PR #28 merged to `main` with `--merge`, after five confirmation rounds and an
explicit decision to stop the instrument loop rather than a claim that it had
converged.

`--merge` and not `--squash`: the provenance gate re-derives each fixture from a
committed revision, and squashing would make the eight stamped commits
unreachable from `main` and every capture unbound.

Verified on `origin/main` at `29bc005`, in a clean worktree cut from it:

```
merge commit has two parents: yes
all 8 stamped commits are ancestors of main: yes (3b7cdf8 b3f094c 783e462
  6933644 ccc58c9 76a56ad b7621ed 885929a)
BUILD OK   verify-runtime-boundary OK
# tests 2213  # pass 2213  # fail 0  # skipped 0  # todo 0  # cancelled 0
conformance + capture gates: 130/130
capture provenance: 45 checked, 0 unbound
```

### What this increment closed, and what it did not

Closed: the rest of the direct store replayed (29 captures promoted with rows),
two false matrix cells corrected, ten rows moved to WIRE, and the streamed
capture path made to record on every exit — the migration's step 1.

Not closed, and none of it blocked by this merge:

- **The A/A noise floor**, 24 samples. Needs live calls; has no authorization.
- **`docs/design-task-capture-records-decoded-text.md`** — whether a record
  should carry bytes rather than text. The 45 existing fixtures cannot be made
  byte-exact retroactively either way.
- **`docs/design-task-conformance-member-identity.md`** — a member signature
  records THAT something is missing, never WHICH member.
- **Nine unpromoted captures**: one duplicate claim, one incomplete vendor turn,
  one `moderation` block needing a declaration, six on `/v1/messages` whose usage
  members are undeclared.
- **The instrument loop itself.** Five rounds did not exhaust it and the
  severity did not fall. Continuing it is separate work with its own budget, not
  a condition on this increment — the argument for stopping is that the loop is
  not reaching the thing being measured, not that there is nothing left to find.
