# Design task — releasing the tool wrapper before it is complete

**Status: closed 2026-09-04 (stages 0–4 landed; see the stage table at the end). Kept as the record of how the decision was made.** Four review rounds (14–17, 2026-09-04) established that the seven
rows of conformance matrix §7a are one problem, and that fixing it one row at a time produces the
next round's defects: round 14's fixes shipped 3 defects round 15 found, round 15's shipped 2 that
round 16 found. Round 17 was the first whose diff created no new disagreement — because its code
change was one shared predicate and everything else was declaration. This document is the packet
for the design, written so the decision can be made without re-deriving the evidence.

## The problem in one paragraph

A turn with `tools` is answered inside a private JSON wrapper `{status, text, toolCalls}`. The
buffered reader is `JSON.parse` over the completed artefact. The streamed reader is a hand-written
incremental walk (`src/proxy/tool-call-stream.ts`) that must decide what to release **before the
artefact is complete**, because a client that asked for a stream is waiting. A released byte cannot
be retracted. Whenever the completed parse reaches a value the incremental walk did not — a later
duplicate key, a member after the root closed, a non-object array member, an undeclared name in a
later call, an unparseable argument string — the two clients of one turn receive different answers,
and in the worst cases the streaming client has **executed a tool call the buffered reading says
never happened**.

## What is already decided

- **Prompt injection is not a mechanism.** Delivery is by environment constraint, runtime knob, or
  code in the response path. (`docs/conformance-matrix.md` §0, every round's packet.)
- **The backstop rejects; it never repairs.** A backend that ignored its schema is a 502, not a
  guessed-at answer. (`src/proxy/backend-contract.ts`, `parseBackendOutput`.)
- **Held is acceptable; lost is not; contradicted is the defect.** Round 15 restored two gates at a
  latency cost on exactly this principle: a turn in JSON mode arrives in one frame at the end rather
  than streaming, because the walk cannot promise the completed parse will choose the same bytes.
- **After round 17, no further row-by-row patches to the reader.** (User decision, 2026-09-04.)

## The evidence set — §7a rows, with the round that established each

| row | axis | client-visible worst case | round |
|---|---|---|---|
| 1 | root end never found | executable call, then the refusal frame | 14 |
| 2 | root never closes | call + `text` streamed; body returns the raw fragment, no call | 14 (wording 15/16/17) |
| 3 | duplicate keys, first-wins vs last-wins, at wrapper level and inside a call | two clients execute **different functions** | 14 (in-call: 17) |
| 4 | bytes after the release point `JSON.parse` rejects | executable call, then 502 | 14 (scoped 16/17) |
| 5 | anything released before an undeclared name closes | earlier call / narration on the wire, then refusal | 16 (widened 17) |
| 6 | non-object `toolCalls` members | nested array's inner object read as a call; body refuses | 17 |
| 7 | argument normalization differs between readers on the wrapper path | different tool input per client | 14 (filed 15/16/17) |

Reproductions for every row are in `review-artifacts/r1{4,5,6,7}-{codex,claude,fable}-report.md`
with concrete inputs; each was confirmed on the pre-fix (`a/`) side, so none is an artefact of a
round's own patch.

## Constraints the design must satisfy

1. A streaming client must never receive a tool call (name + id + arguments) that the buffered
   reading of the same artefact would not publish. This is the invariant every row violates.
2. A streaming client must receive the same final text and the same final call set as the
   buffered client. Block *count* may differ; content may not. (`docs/api-interface-contract.md:451`.)
3. A `tool_choice:"required"` turn that carries no valid call is a 502 on both paths, and the stream
   releases nothing before that decision. (Already true; must stay true.)
4. Live parity (`pnpm e2e:text:parity`, 431 rows) must stay ALL PASS. The direct APIs are the
   authority for the envelope.
5. Any latency the design adds must be stated as a cost, not hidden, and applied identically to the
   Codex app-server and Claude backends (both drive `ToolCallDeltaExtractor` with the same policy).

## The alternatives, stated neutrally

**A. Release only after the root closes.** The incremental walk buffers the whole wrapper, hands it
to `JSON.parse`, and emits calls and text from the parsed value — i.e. one reader. Rows 1–7 close by
construction. Cost: no live argument streaming for any wrapper turn; a tool call arrives whole. The
JSON-mode text gate already makes this trade for answer text. Question to settle: is live streaming
of `arguments` a promise any client depends on, or a convenience? The repo's answer so far is split:
`README.md:134` and `docs/api-interface-contract.md:121,213` list argument deltas as a wire feature,
while the contract's "Streamed tool identity" row already **holds** arguments until the call's id
arrives — a precedent that holding is acceptable when releasing would publish something the turn
cannot honour. The forced-single-tool path (`KnownToolArgumentsDeltaExtractor`) is separate and can
keep streaming — unless 7b row 8 is fixed, whose precondition takes that away too.

**B. A validating incremental lexer.** Keep releasing early, but only while the prefix so far is a
valid prefix of a JSON text under the wrapper schema — strict whitespace, strict escapes, strict
member separators, array members typed, duplicate keys rejected on sight. Rows 4 (prefix half), 6
(leading half) and the in-call part of 3 close; rows 1, 2, 4 (suffix half), 5 and 6 (trailing half)
do **not**, because they are about bytes that arrive *after* a legitimate release. B is a subset of
the problem, not a solution to it; it is worth doing only as a component of C.

**C. Canonical framing from the runtime.** Change what the backend is asked to produce so that each
call is a self-delimiting unit the runtime commits to — e.g. one JSON value per line, or a
`toolCalls`-first wrapper with the array closed before `text` begins — so the walk can release a
call when *its* frame closes and nothing later can invalidate it. This needs the runtime schema
channel (`--json-schema`, app-server `outputSchema`) to be able to express ordering/framing, which
must be **measured**, not assumed: the catalog records that `--json-schema` sends a
`StructuredOutput` tool with no `tool_choice`, so provider-side enforcement is not guaranteed.

**D. Per-call validity in the response contract.** Redefine the turn so a later invalid call does
not refuse the whole turn — earlier valid calls stand, the invalid one is dropped or errored
individually. Closes row 5 by changing the promise rather than the reader. This is a semantic change
visible to clients and to parity; it needs the direct APIs' behaviour on a partially-invalid tool
turn measured before it can even be proposed as a mirror.

## What not to do (learned in this campaign)

- Do not take 7b row 8's fix direction as written: rejecting a forced-tool payload at completion
  while `{`/`[` arguments stream live produces an error frame after arguments on the wire — a new
  7a row. State the precondition (withhold those arguments) or leave it.
- Do not add a check to one reader without the identical check on the identical value in the other.
  Round 16's defect was a raw name tested in one reader and a substituted name in the other.
- Do not test the fix against the fixture shape where the bug cannot appear. Round 14's tests drove
  a double with no `structured_output`; the regression lived in the double that has one.
- Do not declare a class closed after fixing one position of it. Round 15's whitespace claim.
- Do not read the review count as convergence. Provenance (caused-by-fix vs pre-existing) is the
  signal; the aim of each packet was held constant from round 13 on so the rates compare.

## Provenance across the campaign

| round | reviewers | unique findings | caused by the previous round's fix |
|---|---|---|---|
| 14 | codex, claude(opus) | 10 | 2 |
| 15 | codex, claude(opus) | 9 | 3 |
| 16 | codex, fable | 9 | 2 |
| 17 | codex, fable | 8 (all declaration/boundary) | **0** |

Round 17's zero is the reason this document exists instead of a round 18.

## Adjacent, not part of this design

§7c rows 11–12 (a blank/missing tool-definition name manufactures `tool`; a forced undeclared
`tool_choice` creates a call) are input-validation gaps, decidable at the boundary, and need the
direct APIs' 400 envelopes measured first. They can proceed independently of A–D.

---

## Working draft — synthesized 2026-09-04 from two independent frontier drafts

Sources, produced blind from the same packet (`review-artifacts/design-packet/PACKET.md`):
`review-artifacts/design-fable-draft.md` (Claude Fable 5.1 max) and
`review-artifacts/design-codex-draft.md` (codex gpt-5.6-sol ultra). Neither saw the other.

**Both chose A independently, in the same strong form:** delete both incremental readers
(`ToolCallDeltaExtractor`, `KnownToolArgumentsDeltaExtractor`) and Chat's forced-call prestart
(`PredictableToolStart`); the stream becomes a projection of the `LocalCompletionResult` that
`parseBackendOutput` returned, produced by the completion reconcilers the HTTP layer already has.
Rows 1–7 and 9 close by construction (no second reader exists), row 8's fix becomes safe (its
precondition now holds globally), row 10's `json_object` half stays declared. B, C and D were
rejected by both for the same consequences the brief anticipated: a prefix validator cannot retract
a released byte; neither runtime's schema channel enforces framing (Claude's `--json-schema` is an
un-forced `StructuredOutput` tool); a per-call contract change has no measured direct-API basis.

Evidence weight differs. Fable **emulated A in its copy** (both extractors' `push` muted in `dist/`,
`src/` untouched): 15 reproduction inputs from rounds 14–17 read **10 disagreements today, 0 muted**,
with two controls agreeing on both builds. Codex derived the same closure from reading the writers,
`withFirstEventSettled` and the fan-out prefetch. Stage 0 below turns Fable's probe into the suite.

### Release rule (adopted)

No response-body byte of a wrapper-path or forced-tool turn reaches a streaming client until the
runtime has ended the artefact and `parseBackendOutput` has returned; a call is published only as a
member of that result's call set. A failure before commit is an HTTP 502 on both paths. This is
codex's stronger form (Fable left prologue timing as an open cosmetic point); it is adopted because
`withFirstEventSettled` already defers commit to the first backend event, and under A the first
event *is* the completed result — so the true 502 falls out, and the last shape difference between
the paths (status code vs in-band error) goes with it.

### Where the drafts differed

| point | Fable | codex | adopted | why |
|---|---|---|---|---|
| prologue frames (`response.created`, `message_start`) | immediate, then idle gap | withheld until the validated result | codex | constraint 3 read literally; an early prologue forces a 200 commit and an in-band error |
| row 2, root never closes | agree-on-deliver (today's buffered reading: the fragment as prose) | 502, the runtime ignored its schema | Fable now; codex's 502 only after measurement | `backend-contract.ts` delivers non-JSON as the answer on purpose — Claude's schema channel is not provider-forced, so a bare-prose `auto` answer may be a real answer. Count them live before refusing them |
| schema validation (row 8 in full, row 10 `json_schema` half) | owner decision, needs a validator dependency | mandatory standards validator over wrapper, forced `inputSchema`, client schema | **out of this design.** Row 8's minimum is `JSON.parse` at completion; a validator is a separate decision | keeps the gate concept-reducing; the direct APIs do not validate non-strict tool arguments, so schema-rejecting them is stricter than the authority and is a parity question first |
| switch shape | config key, default = new behaviour, escape hatch back | new env var, default off, flip, delete | a `settings.json` key (the repo's config surface: `transport`, `honorRequestModel`…), **default off first**, flip after canary, delete after one release | `src/` reads one env var today (`LOCAL_OAUTH_PROXY_KEY`); the corpus rule is default-off preserving today's bytes, proven by diff |
| Claude retry | — | a streamed turn regains the buffered path's retry, since nothing is committed | adopted; a convergence benefit, measured in stage 2 | |
| Chat `n>1` | — | waits for the slowest choice (fan-out prefetch) | noted as cost | |
| silent socket on Chat (no pre-content frame) | measure idle tolerance; SSE keepalive if needed | — | measure. A keepalive forces early commit and conflicts with the true 502 — if it is needed, the prologue decision reverts to Fable's form | |

### Stages

| stage | content | reversibility |
|---|---|---|
| 0 | **landed 2026-09-04** — `test/wrapper-agreement-suite.test.mjs`: 19 inputs × both wrapper backends × three surfaces, buffered vs streamed; 13 inputs pinned to the disagreement they show today (plus row 8 on `/v1/messages` only), 5 agreeing inputs assert what was delivered or that nothing was released before the refusal. Both backends read identically on every input. Discovery corrected two expectations before pinning: the BOM input is agreement on a *refusal*, and the forced-tool fragment disagrees on `/v1/messages` (`{"input":…}` vs the raw fragment) | no behaviour change; the instrument was run on inputs whose answer is known to be the opposite, and it read them so |
| 1 | **landed 2026-09-04** — `holdToolTurnsUntilComplete` (`settings.json`, default off). On: neither backend constructs an incremental reader for a tool turn, the HTTP layer pulls the first event before writing headers (so a refusal is a real 502 on the stream), and Chat's predicted forced-call announcement is skipped; the completion reconcilers project the one reading. The agreement suite runs both arms per input: off, every pin holds; on, every pin flips to agreement on both backends and all three surfaces and the buffered reading is byte-identical to the off arm's. One pin survives the key — row 8 on `/v1/messages`, a writer-side projection difference on an unparseable forced call, which row 8's own 502 closes. No per-backend switch | one config flip |
| 2 | **measured 2026-09-04** (table above); canary = the operator's own installed instance with the key on. Docs describe the opt-in (README, matrix §7) | docs-only plus a flip |
| 3 | **landed 2026-09-04** — loader fallback and packaged `settings.json` both on; `false` is the rollback, kept one release. README, contract (one new difference row), matrix §7 and the map describe the default. Ten tests moved with it: seven read a refusal from the stream's own status instead of an in-band frame, one control asserts the real status, two that test the incremental reader are pinned to `false` and go when it goes | one config flip |
| 4 | **landed 2026-09-04** — the owner waived the one-release wait (PR #15 is unmerged, so the deletion ships with the rest and is one revertable commit). Deleted: `holdToolTurnsUntilComplete` from settings, loader, both backends and the proxy options; `ToolCallDeltaExtractor`, `KnownToolArgumentsDeltaExtractor` and their walkers; `PredictableToolStart` and the Chat prestart; the app-server's tool-delta timing checkpoints (and the benchmark's two dead keys); five extractor test files, the extractor halves of four more, the fixture's diagnostic tool-turn branch. `tool-call-stream.ts` is now `tool-wrapper.ts`: readers of the completed wrapper and the one completion reconciler. The agreement suite is single-reader: every input agrees and asserts its delivery; row 8 on `/v1/messages` stays pinned | git revert of one commit |
| separate | row 8's 502 at completion (`JSON.parse` minimum); the validator dependency for rows 8-full and 10; row 2's 502 | each its own flip and revert |

**Revert criterion** (both drafts): a body byte before a 502 on a required-invalid turn; any final
text or call-set difference between the paths; parity not 431/431; a supported client broken by
held frames; the p95 first-frame or peak-buffer ceiling exceeded.

### Measured 2026-09-04 (`review-artifacts/stage2/report.md`)

| question | result | consequence |
|---|---|---|
| does a real client depend on live argument deltas | the one consumer code search finds uses Images and buffered `/v1/messages`; none reads argument deltas. **On the Claude runtime the incremental reader is never fed on real wrapper turns**: the CLI streams the wrapper as `tool_use` `input_json_delta` and returns `structured_output`, and the backend forwards text deltas only — so live argument streaming for wrapper turns has not existed there | change condition not triggered by any known consumer; unknown consumers stay the owner's call |
| idle-gap tolerance | silent window under the key = the whole turn, 2.8–7.5 s measured | no keepalive; the real-status property stays |
| real latency cost (n = 5 per arm) | claude: **0 ms** (first frame was already at completion, both arms, ~3.0 s). app-server: **~293 ms** per turn (276–300), the tail between the incremental reader's call announcement and `turn/completed`, on ~4.5 s turns | accept; C is not needed for latency |
| bare-prose `auto` answers on Claude (n = 12) | **0 / 12**; every answer came through `structured_output`. 1/12 double-wrapped (a wrapper JSON string inside the wrapper's `text`) — a schema-echo behaviour, not a reader defect | row 2's 502 upgrade has no observed cost; small sample |

Parity cannot move on its own: every default row runs against a backend that throws if reached,
and `--generate` rows carry no tools (both drafts, verified against the script).

### Owner decisions, with the default each draft's evidence supports

1. Prologue timing — default **withhold** (true 502 on both paths).
2. Row 2 — default **deliver** now; 502 after the live count.
3. Validator dependency — default **not in this design**; separate task.
4. Ceilings for p95 first frame and peak buffer — numbers the owner supplies; the packet had none.
5. The settings key's name.

Concept delta: net reducing on both drafts (Fable −9/+2, codex −13/+2 final), with one transient
key until stage 4.
