# Verification receipt — supplied-echo conformance gate

Every number below names the command that produced it and the tree it ran on.
The sibling receipt (`echoed-defaults-RECEIPT.md`) covers the gate for a request
that configures nothing; this one covers the gate for a request that asks for
something.

- **Repo**: `/Users/kangmin/Documents/cli-api-adaptor/local-OAuth-CLI-API-adapter`
- **Revision**: `d3424752d4f7b4d50a20b4c22ada93e993d3eee8`
- **Subject**: `review-artifacts/echoed-defaults-evidence`, a detached worktree
  at that revision, clean over `src test spec scripts tsconfig.json
  package.json pnpm-lock.yaml` before and after. The four files belonging to
  another session exist only in the main checkout and are absent here.
- **Date**: 2026-09-10
- **Logs**: `review-artifacts/stage2/evidence-d342475/`

## Offline suite

```
$ pnpm test
ℹ tests 2132
ℹ pass 2132
ℹ fail 0            (rc 0 — evidence-d342475/full-suite.log)
```

2092 -> 2132: 25 tests in the new gate, 8 parity rows for the branch the refusal change opened, one check for the new evidence grade, and six that show the readers refusing — the declaration validator, the absence-credit rule, a key spelled like the reader's own syntax, a quoted key spelled the same way by both readers, the cost of a deeply nested body, and what crossed the wire.

## Mutation — the new gate

```
$ cd review-artifacts/echoed-defaults-evidence
$ python3 ../stage2/supplied-echo-mutants.py --root . --log ../stage2/evidence-d342475
SUBJECT d3424752d4f7b4d50a20b4c22ada93e993d3eee8 — 188 tracked inputs verified against that revision
RUNNER  supplied-echo-mutants.py sha256 ea2dd846732e5a8da4d5ef966ee09a2fb7996dcdfafb0396994e86eec90631ce
RUNNER  mutation_harness.py    sha256 d7f4ff85b60169bc0f8b37136aff4a065be99671c4a40215555a43ec81121c48
BASELINE test/conformance-supplied-echo.test.mjs: tests=25 pass=25 fail=0 -> OK
BASELINE test/conformance-manifest.test.mjs: tests=7 pass=7 fail=0 -> OK
  S1-effort-gate-reverted: KILLED (tests=2 fail=2)
  S2-parallel-tool-calls-hard-true: KILLED (tests=2 fail=1)
  S3-responses-service-tier-constant: KILLED (tests=2 fail=1)
  S4-chat-service-tier-constant: KILLED (tests=2 fail=1)
  S5-store-hard-true: KILLED (tests=2 fail=1)
  S6-metadata-emptied: KILLED (tests=2 fail=2)
  S7-top-logprobs-echo-constant: KILLED (tests=2 fail=1)
  S8-chat-fanout-collapsed: KILLED (tests=2 fail=1)
  S9-declaration-emptied: KILLED (tests=25 fail=3)
  S10-value-divergence-stale: KILLED (tests=2 fail=1)
  S11-fixture-tampered: KILLED (tests=1 fail=1)
  S12-second-choice-null: KILLED (tests=2 fail=1)
  S13-false-value-divergence: KILLED (tests=3 fail=1)
  S14-replay-row-deleted: KILLED (tests=23 fail=2)
  S15-wire-names-no-capture: KILLED (tests=1 fail=1)
  S16-second-choice-emptied: KILLED (tests=2 fail=1)
  S17-declared-absence-answered-empty: KILLED (tests=2 fail=1)
  S18-divergence-tuple-coerced: KILLED (tests=1 fail=1)
  S19-false-divergence-alone: KILLED (tests=1 fail=1)
  S20-wire-capture-loses-its-replay: KILLED (tests=1 fail=1)
  S21-second-choice-message-emptied: KILLED (tests=2 fail=1)
  S22-our-turn-gains-a-reasoning-item: KILLED (tests=2 fail=1)
  S23-driver-reads-off-its-roster: KILLED (tests=1 fail=1)
  S24-driver-replays-another-rows-request: KILLED (tests=1 fail=1)
BASELINE OK: True   ALL KILLED: True   RESTORED: True   DIST MATCHES TREE: True
```

Thirteen mutate code and **eleven do not**: this gate reads its authority from
data, from the registry of captures it replays, and from its own driver, and any
of the three can be emptied without touching the proxy. The declaration list
goes blank (`S9`), a value divergence is loosened until it exempts anything
(`S10`), a promoted capture is edited after promotion (`S11`), a false
declaration borrows a true one's evidence (`S13`, `S18`, `S19`), a registry row
is deleted (`S14`, `S20`), a `WIRE` row names no capture (`S15`), and the driver
reads a capture off its roster (`S23`) or replays the wrong row's request
(`S24`).

`S24` is the one that has already earned its place: it **survived** its first
run. The gate was hashing the capture its row names rather than the bytes it
sent, so the record restated the claim instead of observing it. A recorder in
front of the proxy now reads the surface and the bytes off each request that
crosses it, and the registry compares that against its own rows.

`DIST MATCHES TREE` is a reading of the compiled output's digest against the
one the baseline built. Four rounds went into that line. The first restored a
TypeScript mutant's source without recompiling, so every later mutant that edits
a test, a spec or a script was measured against the previous mutant's build. The
second rebuilt inline but left the rebuild off the exception path, which a
review reached by injecting a failure where the test process launches. The third
tracked a flag instead of measuring: a review wrote an executable mutant that
edits `dist/` directly and throws, and the flag — set only by TypeScript targets
— stayed clear while the summary printed. Restore, rebuild and abort-on-failure
are one function on every exit, and the line is now measured rather than
claimed, over the compiler's own output rather than everything under `dist/` —
hashing the whole tree meant a log written there aborted a run nothing was wrong
with. The fourth round also found the BASELINE running outside the restoring
block, so a failure there left its edits in place; it runs inside now.

`S4` is in this table twice over. Its first run returned `ANCHOR-FAIL(count=2)`:
the needle matched the buffered chat body and the streamed chunk builder, so the
mutant did not express one decision and the runner refused to pick. Re-anchored
on the buffered body, which is what this gate posts.

`S16` through `S24` are the nine constructions three confirmation rounds planted
that every gate passed at the time. They are listed with their findings below.

`S1` is the defect the gate found on its own first run, planted back: without
the effort gate `/v1/responses` refuses `top_logprobs` at `reasoning.effort:
none`, which the direct API answers 200 to and which our own Chat surface has
always accepted.

## Mutation — the sibling gate, on the shared harness

```
$ python3 ../stage2/echoed-defaults-mutants.py --root . --log ../stage2/evidence-d342475
SUBJECT d3424752d4f7b4d50a20b4c22ada93e993d3eee8 — 188 tracked inputs verified against that revision
BASELINE test/conformance-echoed-defaults.test.mjs: tests=13 pass=13 fail=0 -> OK
BASELINE test/proxy-http.test.mjs: tests=69 pass=69 fail=0 -> OK
  E1 … E14: all KILLED
BASELINE OK: True   ALL KILLED: True   RESTORED: True   DIST MATCHES TREE: True
```

The harness moved to `mutation_harness.py` so the two runners cannot drift apart
on what a KILLED verdict is worth; the 14/14 above is that harness re-running
the older table unchanged.

## The captures

Ten new, promoted from `artifacts/direct-api-captures` with no new vendor call.
All sixteen in the store are provenance-bound and swept by both gates on every
run; the ten added here name `dd92b386cf75`, the revision whose promoter wrote
them.

| capture | the option it is evidence about |
| --- | --- |
| `direct-responses-service-tier-flex` | `service_tier` echoed |
| `direct-responses-store-false` | `store` echoed |
| `direct-responses-metadata` | `metadata` echoed |
| `direct-responses-reasoning-summary-auto` | `reasoning.summary`, alias resolved by the vendor and not by us |
| `direct-responses-tools-parallel-false` | the tool echo, canonicalised by the vendor and not by us |
| `direct-responses-top-logprobs-effort-none` | accepted at `effort: none`, where this proxy refused |
| `direct-chat-service-tier-flex` | `service_tier` echoed |
| `direct-chat-response-format-json-object` | not echoed at all — a claim in the other direction |
| `direct-chat-n-2` | not echoed; two choices are what the client receives |
| `direct-chat-logprobs-effort-none` | the vendor fills `choices[].logprobs`; we declare that we do not |

## What two seats found, and what closed it

A two-seat review (a different provider on one seat) returned **DO NOT SHIP**
on the first version of this work, with six real defects. Five were made by this
delta.

| finding | closed by |
| --- | --- |
| The effort gate opened three doors whose value checks were never written, so `presence_penalty: 99` and `top_logprobs: 999` answered 200 and came back echoed | only the measured door moves; the accepted value is bounded; eight parity rows hold the edges |
| A false value declaration borrowed a true one's evidence | exhibition keyed by the whole tuple (`S13`) |
| A second choice answered as `null` passed the shape comparison | an array member's TYPE is shape (`S12`) |
| A declared absence stayed certified after the row replaying it was deleted | participation read from the gate's own rows; no capture may go unreplayed (`S14`) |
| A row graded `WIRE` naming no capture passed every instrument | the legend's rule made executable (`S15`) |
| R-37 said `service_tier` came back as a hard `"default"`, and a `WIRE` grade was hung on that false text | the cell now says what `resolvedOpenAiServiceTier` does; R-25's `include` cell now states the unconditional refusal it describes |

Each of the five is a mutant in the table above, planted and killed.

## What the confirmation round found, and what closed it

A confirmation round on the different provider's seat returned **DO NOT SHIP**
with seven findings, five of them constructions it built that every gate passed.
Of the seven: one was made by the previous round's own fix, two were fixes that
did not close what they were written for, three were holes that round had not
reached, and one was prose. The pattern is the one this area keeps producing —
the repairs need reviewing as much as the claim did — and it is what the budget
for this kind of work has to carry.

| finding | closed by |
| --- | --- |
| A declaration whose two sides are ARRAYS holding the true tuple's text: unmatchable against any answer, but its interpolated key read identical to the true one's, so the true one's evidence certified it | the key is serialised, and a declaration the gates could not compare is refused when it is loaded (`S18`) |
| `logprobs: {content: []}` — present and empty — credited to a declaration that the field is not reported at all, because the array MEMBER's path was the only one missing | an absence is credited only where the field's own path is missing (`S17`) |
| A second choice answered as `{}`: an object like the first, contributing no paths, invisible to both gates | each key some member carries and another does not is a path of its own (`S16`) |
| The `WIRE` grade satisfied by a fixture named in a COMMENT, including the comment left behind when its row is deleted | replay is read from the roster the gates iterate (`S20`) |
| Certification of a declaration depended on the sibling tests having run, so a filtered or reordered run certified what nothing had replayed | the participation check recomputes exhibition itself (`S19`) |
| A restored TypeScript mutant left its compilation in `dist`, so the next mutant that is not TypeScript was measured against the wrong build | the harness rebuilds on restore and aborts if that build fails |
| R-25 said the `include` logprobs member is accepted at `reasoning.effort: none` | it is refused at every effort — only `top_logprobs` is conditional — in the matrix, its manifest projection, and this receipt |

## What the second confirmation round found, and what closed it

The same seat reviewed the repairs and returned **DO NOT SHIP** again. Four of
its findings were the previous round's repairs read one level deeper; one was a
regression those repairs introduced.

| finding | closed by |
| --- | --- |
| The second choice kept its own keys and answered `message: {}`. A signature of a member's immediate keys could not see it — the first choice supplied every path beneath | a member's signature is its WHOLE path set, at any depth (`S21`) |
| With the vendor sending `x: 1` and `x: null` across two members and us sending only `x: null`, one typed path was gone and the field read as absent while every member still had it | an absence means our answer carries NO path for that field |
| Replacing an enumerated list of descendants with the one truthful parent failed, because each descendant's own missing path stopped the walk before the declaration | the owner is the nearest DECLARED ancestor, not the nearest missing one |
| Given a reasoning item of its own, our turn kept the exemptions written for not having one | an exemption is honoured only after its premise is checked against both turns (`S22`) |
| A driver repointed at a different fixture left every check certifying the capture the roster advertised while nothing replayed it | a gate cannot read a capture its roster does not name (`S23`) |
| **Introduced by the previous round:** the registry that replaced the source-text search lost the stream gate, so the rule claimed no gate replays `direct-chat-stream` | the streamed pair is in the registry, the store sweep no longer carves it out, and `S20` — which had rejected on that false premise — now drops a cited capture's own replay row |
| The harness restored sources on the exception path without rebuilding | restore, rebuild and abort-on-failure are one function on every exit |

The round also corrected itself: it accepted `S20`'s premise at first, then read
and ran the stream gate and overturned it. That is how the regression above was
found — on the mutant written to prove the rule, not on the rule.

## What the third confirmation round found, and what closed it

The verdict moved to **SHIP WITH FIXES**, scoped to this instrument and this
receipt: the round demonstrated **no proxy defect a client would meet**, and no
`src/` file has changed since `2bef0b2`.

| finding | closed by |
| --- | --- |
| The reader wrote structure into a string and parsed it back. A key literally spelled `a[]{-.b` was read as the member signature it resembles and credited to an unrelated field; a key containing a newline was not read at all | a path carries the field it is about, computed where the structure is known; a key that is not a plain identifier is quoted |
| Each member's subtree was walked once for its signature and again for the aggregate — exponential in depth, 3.5 seconds on a 191-byte body | one walk, used twice |
| A gate that rewrites its own roster and adjusts its expectations passes every check while the registry certifies a capture nobody replayed | a recorder in front of the proxy reads the surface and bytes off each request; the registry compares that against its own rows (`S24`) |
| An executable mutant that edits `dist/` and throws left the summary printing against a build nothing on disk explained | the harness measures the compiled output's digest instead of tracking a flag |
| `S22` died one assertion before the premise it was written for, and `S23` mutated the comparison rather than the replay driver | `S23` mutates the replay driver; `S22` took two more tries — see the round below |

**Filed, not patched:** `docs/design-task-conformance-member-identity.md`. A
signature records that some member went without something, never which one, so
moving a field from one member to another leaves both sides equal — a function
call stripped of its `call_id` while the message beside it gains one reads as no
difference at all. Closing it needs a member identity rule, which changes what a
declaration names. The round's own recommendation was to spend the next hour on
that redesign rather than on another broad review.

## What a fourth, narrow round found

Scoped to the repairs above and the harness. Verdict **SHIP WITH FIXES** again,
instrument and receipt only; still no proxy defect, and still no `src/` change
since `2bef0b2`.

| finding | closed by |
| --- | --- |
| The recorder read the proxy's answer as text and wrote the string back. Three byte-order marks the proxy sent collapsed to one, so a body the gate could not have parsed arrived parsed and 37 tests passed | the recorder forwards bytes, with the headers that describe the message rather than the hop |
| A key needing quotes was spelled `["a.b"]` by the shape reader and `.a.b` by the leaf reader, and a declaration naming either was rejected for not starting with a dot | one spelling for both readers, and a path may begin at a quoted key |
| The dist digest hashed everything under `dist/`, so a log written there aborted a run nothing was wrong with | it hashes the compiler's own output |
| The BASELINE ran outside the restoring block, so a failure there left its edits in place | it runs inside |
| `S22` still died one assertion early, now on `encrypted_content: null` where the frozen capture holds a string | it sends a string and dies on the premise assertion |

The round also corrected two claims in this receipt: that `S22` reached its
premise, and that restoration covered every exit. Both were false when written
and are true now, which is the difference between a receipt and a summary.

## What is NOT verified here

- Whether the direct API accepts `include: ["message.output_text.logprobs"]`,
  `presence_penalty` or `frequency_penalty` at `reasoning.effort: none` on
  `/v1/responses`. Only `top_logprobs` is measured there, and only
  `top_logprobs` is conditional on effort in this proxy: the other three are
  refused at every effort, which is where they stood before this work and is
  what the matrix now says. Opening them by inference from the one measured
  door is the defect a review caught — behind that refusal, `presence_penalty:
  99` was accepted and echoed. Three cheap calls settle whether the refusals
  are parity at `none`.
- Whether `reasoning.summary: "auto"` resolves to `"detailed"` at any effort but
  `low`, or on any model but this one. One sample is why the alias is declared
  rather than mirrored.
- What a real backend's reasoning item carries. Our side of this gate runs on a
  fake backend whose turn contains no reasoning item, which is why twelve paths
  are listed as harness gaps in the row that meets them rather than as
  divergences: two members only a reasoning item carries, and ten places the
  vendor's two output items disagree where an array of one cannot. The row
  asserts that premise — the item types on both sides — before any of them is
  honoured.
- The **38** remaining 200/json exchanges in the direct store (50 in all, 12
  promoted). They are promotable without a vendor call; nothing here has read
  them. An earlier draft of this line said forty and was corrected by a review:
  the two minimal captures were promoted from the same fifty.
- That the suite count reproduces under a short deadline. The review seat timed
  out at 150 and then at 155 seconds without reaching a summary, so `2132/2132`
  above is a result from this machine's own unbounded run and has not been
  reproduced elsewhere. Both mutation tables were reproduced there, the second
  time through a socket-free adapter the seat wrote because its sandbox denies
  the local listener the gates need — which establishes the assertions, not the
  socket path.
- That `pnpm test` is credential-independent. Several tests read the ambient
  `~/.local-oauth-cli` state, so 2132/2132 is a result on a machine where that
  directory exists; what the suite does without it is unmeasured here.
- Whether the direct Responses API enforces Chat's measured `top_logprobs`
  ceiling of 5 or the documented 20. The accepted value is held to the
  documented range, and the choice is stated in R-12 rather than assumed.
