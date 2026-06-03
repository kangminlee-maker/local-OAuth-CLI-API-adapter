# Local OAuth CLI API Adapter

Experimental local adapter that makes an already-authenticated OAuth CLI look
like a small API server.

The first backends are Codex CLI via a long-lived `codex app-server` process and
Claude Code via its local OAuth CLI session. The adapter exposes a local
OpenAI/Anthropic-compatible subset so local tools can use OAuth CLI login instead
of provider API keys.

It also includes a ggui MCP add-on mode that swaps ggui's UI generator for a CLI
runtime without patching the upstream `ggui` repository.

## Local API Proxy

```bash
pnpm install
pnpm build
pnpm proxy:codex
# or
pnpm proxy:claude
```

Run the local compatibility tests:

```bash
pnpm test
```

Run real CLI smoke tests with exact return checks:

```bash
pnpm smoke:real:codex
pnpm smoke:real:claude
```

Run only real multimodal image checks:

```bash
pnpm smoke:real:codex:multimodal
pnpm smoke:real:claude:multimodal
```

These commands use the actual logged-in CLI sessions and may consume plan
credits/rate limits. They verify exact text assembly, JSON values, tool names and
arguments, provider finish reasons, and optional latency samples:

```bash
pnpm smoke:real:codex -- --speed-repeats 3
pnpm smoke:real:claude -- --speed-repeats 3
```

Run a comparison benchmark against direct provider APIs:

```bash
pnpm bench:api
pnpm bench:api -- --repeats 3 --quality-repeats 3
pnpm bench:api -- --semantic-quality-repeats 1 --semantic-quality-targets=proxy --min-semantic-quality=95
pnpm bench:api -- --cases=semantic_quality --semantic-quality-suite=realistic --semantic-quality-repeats 1 --min-semantic-quality=95
pnpm bench:api -- --targets=proxy-codex --cases=tool_call_stream,tool_use,tool_result --repeats 3
pnpm bench:api -- --targets=proxy-codex,openai-api:gpt-5.5 --cases=request_reasoning_effort --request-reasoning-effort=none --repeats 3
pnpm bench:api -- --targets=proxy-codex,openai-api:gpt-5.5 --cases=request_reasoning_effort --request-reasoning-effort=minimal --expect-provider-errors=true
pnpm bench:api -- --include-multimodal=true
pnpm bench:api -- --output /tmp/api-bench.json
pnpm bench:api -- --baseline /tmp/api-bench.json --regression-targets=proxy
```

The benchmark loads `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` from the environment
or `.env`, starts both local proxy backends, and compares schema exactness,
response exactness, stream event shape, optional repeated quality samples, and
latency against direct API calls. `--targets` and `--cases` narrow the run to
comma-separated target or case filters; exact, substring, and `*` wildcard
matches are supported, so targeted repeated medians can be collected without
rerunning every provider/API shape. `--semantic-quality-repeats` additionally uses
an OpenAI JSON-schema judge to score requirement fit, semantic relevance,
conciseness, and direct-provider similarity; proxy targets also get cached direct
provider reference outputs when the matching API key is available. Semantic
references are paired by proxy backend provider, not by request API surface:
`proxy-codex` is compared with direct OpenAI API output, and `proxy-claude` is
compared with direct Anthropic API output. Use
`--min-semantic-quality=95` to make semantic quality a hard gate. Proxy-Codex
benchmark rows also include summary-only `backendTiming` diagnostics for local
phase breakdowns such as `threadStartMs`, `turnWaitMs`, and `usageWaitMs`; these
diagnostics are not added to API responses. Streaming benchmark rows record
`firstDataMs`, `firstTextMs`, and `firstToolArgumentMs` so text-token and tool
argument latency can be compared separately. Outlier rows include the dominant
backend phase when proxy-codex timing is available. With
`--baseline`, proxy rows are compared against a previous summary by default and
latency/quality regressions make the command fail. Proxy-Codex follows
request-level OpenAI reasoning effort settings first: Chat Completions
`reasoning_effort` and Responses `reasoning.effort`. The CLI
`--reasoning-effort` value is only the fallback when the request omits effort;
when it is also omitted, `settings.json` supplies
`codexProxy.fallbackReasoningEffort`, currently `medium` because the repeated
matrix benchmark showed the best speed/quality stability there.
Use `--request-reasoning-effort` in benchmarks to send those request fields to
both proxy and direct OpenAI targets. Current direct `gpt-5.5` rejects
`minimal`, so that value is useful as an unsupported-value parity probe rather
than a successful quality/latency case; add `--expect-provider-errors=true` to
assert matching provider error shapes. Multimodal image benchmarks use a
deterministic generated 64x64 red PNG fixture that direct OpenAI and Anthropic
APIs accept, so proxy image paths are compared against real provider behavior.
Defaults:

- OpenAI API: `gpt-5.5`
- Codex proxy fallback effort: `settings.json` `codexProxy.fallbackReasoningEffort`
- Anthropic API Opus: `claude-opus-4-8`
- Anthropic API Sonnet: `claude-sonnet-4-6`
- Anthropic API Haiku: `claude-haiku-4-5-20251001`

It performs real provider calls and may consume paid credits/rate limits.

The default base URLs are:

```text
OpenAI-compatible:    http://127.0.0.1:8787/v1
Anthropic-compatible: http://127.0.0.1:8787
```

Supported subset:

- `GET /v1/models`
- `POST /v1/chat/completions`
- `POST /v1/responses`
- `POST /v1/messages`
- non-stream text generation
- live SSE text deltas from Codex `app-server` and Claude Code
- live SSE tool-call argument deltas when the backend streams structured output,
  with synthetic completion of any remaining arguments after the CLI decision
  completes
- OpenAI JSON object/schema output where supported by the backend
- OpenAI Chat tool calls and tool-result follow-up messages
- OpenAI Responses function calls and function-call outputs
- Anthropic `tool_use` and `tool_result`
- image inputs for OpenAI Chat `image_url`, OpenAI Responses `input_image`, and
  Anthropic Messages `image` blocks
- image sources as remote URLs, data URLs/base64, and local `file://` URLs
- provider token usage details where the CLI exposes them, including cached and
  reasoning-token breakdowns where available; estimated usage is used only as a
  fallback

Not yet supported:

- provider `file_id` image sources, because the local CLI proxy cannot read the
  provider Files API storage for the caller
- image/audio output generation
- full API compatibility

Example:

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer local' \
  -d '{
    "model": "codex-app-server",
    "messages": [
      { "role": "user", "content": "Reply with exactly: OK" }
    ]
  }'
```

Claude proxy:

```bash
pnpm proxy:claude
```

Plain text Claude requests use one long-lived
`claude -p --input-format stream-json --output-format stream-json` process and
clear context with `/clear` after each request. Tool-call and JSON-schema
requests use a one-shot Claude process so `--json-schema` can be set per request.
Image requests also use a one-shot `stream-json` input process to avoid carrying
image attachment state across persistent turns.

## ggui Add-on

The add-on does not patch the upstream `ggui` repository. It imports the local
ggui packages via `link:` dependencies and supplies its own `UiGenerator`
implementation through `createGguiServer({ generation })`.

The runtime boundary is intentionally thin: `CliGenerationApi.generate(input)`
behaves like a single API request, while CLI-specific file setup, structured
output parsing, compile feedback, and cleanup stay hidden inside the facade.

### Install

```bash
pnpm install
pnpm build
```

This package expects the sibling `../ggui` repository to be built already:

```bash
cd ../ggui
PATH=/opt/homebrew/opt/node@22/bin:$PATH pnpm build
```

### Dry Run

```bash
pnpm generate:mock
```

### Serve

```bash
pnpm serve:mock
pnpm serve:codex
pnpm serve:claude
```

The default endpoint is:

```text
http://127.0.0.1:6781/mcp
```

## Notes

- `mock` proves the ggui seam and compile path without calling a model.
- `codex` uses `codex exec` and the local Codex CLI auth state.
- `claude` uses `claude -p` and the local Claude Code auth state.
- The generated TSX is compiled to browser ESM before ggui commits it.
- This avoids provider API keys, but it still consumes the selected CLI's plan,
  credits, rate limits, and applicable usage policy.
- Codex text streaming maps `item/agentMessage/delta` notifications to the
  local API stream. Claude Code text streaming maps
  `stream_event.event.content_block_delta` `text_delta` chunks to the same local
  API stream.
