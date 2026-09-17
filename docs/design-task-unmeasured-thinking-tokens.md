# Design task — an unmeasured thinking count is published as a measured zero

**Filed** 2026-09-10, from a reproduced review finding against PR #29.
**Status**: open. Nothing in this document is implemented.

## What happens today

All three text surfaces publish the thinking/reasoning token count with `?? 0`:

| surface | field | site |
| --- | --- | --- |
| `/v1/chat/completions` | `usage.completion_tokens_details.reasoning_tokens` | `http-server.ts` `chatUsage` |
| `/v1/responses` | `usage.output_tokens_details.reasoning_tokens` | `http-server.ts` (two sites, buffered and streamed) |
| `/v1/messages` | — | not emitted; see below |

`LocalUsage.reasoningOutputTokens` is optional. When the runtime does not report
it, the surfaces publish `0`.

**`claude-code-backend.ts` never populates it at all.** `usageFromClaude` reads
`input_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens` and
`output_tokens`, and nothing else. So for the Claude Code backend the published
value is a constant zero on every turn, including turns that thought.

The Codex paths erase the distinction one level earlier:
`codex-app-server-backend.ts` and `codex-backend-transport.ts` both coerce an
absent `reasoning_tokens` to `0` at parse time, so `undefined` never reaches the
serializer to be distinguished from a measured zero. Both merge functions sum a
missing count as zero, and the Chat `n` fan-out sums the known subset and
publishes it as a complete total.

A client cannot tell "this turn did not think" from "nobody counted".

## What was tried and reverted

PR #29 added `output_tokens_details.thinking_tokens: usage.reasoningOutputTokens ?? 0`
to `anthropicUsage`, on the argument that `/v1/messages` was the only surface not
publishing a number the other two already published.

That argument was circular — the other two publish the same false zero — and the
change made the natural pairing worse: `/v1/messages` is the surface the Claude
Code backend serves, and that backend never measures the number, so the field
was a hard `0` on every turn. It was reverted the same day. `anthropicUsage`
carries a comment saying so, and
`spec/declared-divergences.json`'s `messages-vendor-routing-usage-is-not-reported`
declares the absence with its reason.

## Why this is a design task and not a patch

The correct behaviour — report it when the runtime measures it, omit it when
nothing did — cannot be reached at the serializer. It has to survive:

1. **Two parsers.** Both Codex paths turn absent into `0` before anything else
   sees it. `readNumber` returning a number for a missing key is the mechanism.
2. **`usageFromClaude`.** Whether the Claude CLI reports a thinking counter at
   all is **UNMEASURED**. Its `raw` is retained, so the question is answerable
   from a recorded turn without guessing. It must be measured before anything is
   read out of it.
3. **Two merge functions and the fan-out.** `(a ?? 0) + (b ?? 0)` turns one
   known half and one unknown half into a confident total. A merge of a measured
   and an unmeasured count is not measured.
4. **Three serializers, and three vendors that always emit the field.** Each
   direct API emits its reasoning/thinking member unconditionally, so omitting it
   is a divergence per surface and needs a declaration per surface.

Each step is small; together they are a change of what `LocalUsage` MEANS, which
is the kind of change this repository requires a design pass for rather than a
patch chain.

## Open questions the design has to answer

- Is `undefined` the right carrier, or does `LocalUsage` need an explicit
  "measured" marker so a merge can refuse to add across it?
- Does the Claude CLI report a thinking count? (measurable from a recorded turn)
- For a fan-out where one branch measured and another did not, is the honest
  answer the partial sum, no value, or a value plus a count of contributing
  branches?
- Does omitting a member the vendor always sends break a real client, and is a
  declared divergence the right instrument, or should the surfaces publish a
  sentinel?

## Evidence

`review-artifacts/batch3-review-astra/REPORT.md` F2, with reproductions under
`review-artifacts/batch3-review-astra/review-evidence/` (offline; a local
`thinking-worker.cjs` stand-in for the Claude CLI, and an in-memory event source
for the Codex transport's real state machines).
