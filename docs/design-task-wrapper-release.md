# Design task — releasing the tool wrapper before it is complete

**Status: open. Not a patch.** Four review rounds (14–17, 2026-09-04) established that the seven
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
of `arguments` a promise any client depends on, or a convenience? The forced-single-tool path
(`KnownToolArgumentsDeltaExtractor`) is separate and can keep streaming.

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
