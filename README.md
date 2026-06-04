# Local OAuth CLI API Adapter

Experimental local adapter that makes an already-authenticated OAuth CLI look
like a small API server.

The supported backends are Codex CLI via a long-lived `codex app-server` process and
Claude Code via its local OAuth CLI session. The adapter exposes a local
OpenAI/Anthropic-compatible subset so local tools can use OAuth CLI login instead
of provider API keys.

## Local API Proxy

Build a distributable adapter package from this repository:

```bash
pnpm install
pnpm pack:adapter
```

The command writes and verifies a standalone tarball such as:

```text
artifacts/local-oauth-cli-api-adapter-0.1.0.tgz
```

Install that tarball from any other repository without linking back to this
source checkout:

```bash
pnpm add -D /path/to/local-oauth-cli-api-adapter-0.1.0.tgz
# or
pnpm add -g /path/to/local-oauth-cli-api-adapter-0.1.0.tgz
```

Then start it from any repository:

```bash
pnpm exec ggui-oauth-cli proxy --runtime codex --port 8787 --cwd /path/to/target-repo
# or
pnpm exec ggui-oauth-cli proxy --runtime claude --port 8788 --cwd /path/to/target-repo
```

Point API clients in the target repository at the local proxy:

```bash
OPENAI_BASE_URL=http://127.0.0.1:8787/v1
OPENAI_API_KEY=local
ANTHROPIC_BASE_URL=http://127.0.0.1:8788
ANTHROPIC_API_KEY=local
```

The installable proxy bin contains only the proxy runtime files and
`settings.json`; it does not install or load sibling-repository packages and does
not depend on this source repository after installation. For independence, avoid
`file:../path-to-adapter-source`-style installs; use the verified tarball, a
release asset containing that tarball, or a registry package built from the same
artifact flow.

For local development in this repository:

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

Run the installed-package E2E test:

```bash
pnpm test:e2e:adapter
```

This E2E test packs the adapter, installs the tarball into a temporary consumer
project, starts the installed `ggui-oauth-cli` bin with a deterministic fake
Codex app-server backend, and verifies OpenAI-compatible model, chat completion,
and SSE streaming responses over HTTP.

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
pnpm bench:api -- --suite=contract-smoke --targets=proxy-codex,proxy-claude --repeats 1
pnpm bench:api -- --suite=provider-parity --targets=proxy-codex,proxy-claude,openai-api:gpt-5.5,anthropic-api:sonnet --repeats 3
pnpm bench:api -- --suite=quality-realistic --targets=proxy-codex,proxy-claude --min-semantic-quality=95
pnpm bench:api -- --suite=image-realistic --targets=proxy-codex,openai-api:gpt-5.5 --image-quality-repeats=1 --min-image-quality=90 --repeats 1
pnpm bench:api -- --include-multimodal=true
pnpm bench:api -- --targets=proxy-codex,openai-api:gpt-5.5 --cases=openai.images.generation,openai.images.generation_api_fields,openai.images.generation_url,openai.images.generation_stream,openai.images.edit,openai.images.edit_multipart_stream,openai.images.variation --include-image-generation=true
pnpm bench:api -- --targets=proxy-codex,openai-api:gpt-5.5 --cases=openai.images.generation_stream_paired --repeats 3
pnpm bench:api -- --output /tmp/api-bench.json
pnpm bench:api -- --baseline /tmp/api-bench.json --regression-targets=proxy
```

The benchmark design and release-gate matrix live in
[`docs/api-benchmark-design.md`](docs/api-benchmark-design.md). Use that document
as the source of truth for which provider authority, quality gate, latency
metric, and real-use fixture each suite must cover.

The benchmark loads `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` from the environment
or `.env`, starts both local proxy backends, and compares schema exactness,
response exactness, stream event shape, optional repeated quality samples, and
latency against direct API calls. `--suite` expands named benchmark presets such
as `contract-smoke`, `provider-parity`, `quality-realistic`, `image-realistic`,
and `release-gate`; explicit `--cases` are unioned with suite cases.
`--targets` and `--cases` narrow the run to comma-separated target or case
filters; exact, substring, and `*` wildcard matches are supported, so targeted
repeated medians can be collected without rerunning every provider/API shape.
`--semantic-quality-repeats` additionally uses
an OpenAI JSON-schema judge to score requirement fit, semantic relevance,
conciseness, and direct-provider similarity; proxy targets also get cached direct
provider reference outputs when the matching API key is available. Semantic
references are paired by proxy backend provider, not by request API surface:
`proxy-codex` is compared with direct OpenAI API output, and `proxy-claude` is
compared with direct Anthropic API output. The semantic judge treats the direct
provider output as a reference rather than a style template, so equivalent
answers can still pass when they better satisfy the original request. Use
`--min-semantic-quality=95` to make semantic quality a hard gate. The realistic
semantic suite covers 10 prompt shapes across implementation review, Korean
optimization tables, multimodal triage, handoff notes, Korean incident reports,
strict JSON summaries, latency decisions, error policy, image benchmark planning,
and release-gate decisions. Proxy-Codex
benchmark rows also include summary-only `backendTiming` diagnostics for local
phase breakdowns such as `threadStartMs`, `turnWaitMs`, and `usageWaitMs`; these
diagnostics are not added to API responses. Streaming benchmark rows record
`firstDataMs`, `firstTextMs`, and `firstToolArgumentMs` so text-token and tool
argument latency can be compared separately; image stream rows also expose
`firstImageMs` as the image-specific alias for `firstToolArgumentMs`, because
direct Responses API lifecycle events can arrive before the first image payload.
For image stream latency investigations, use the targeted
`openai.images.generation_stream_paired` diagnostic; it alternates proxy/direct
request order inside each repeat and reports paired `firstImageMs` deltas. This
diagnostic keeps per-sample failures in `sampleFailures` so transient provider
quota or rate-limit errors do not erase earlier successful samples from the
summary.
Outlier rows include the dominant backend phase when proxy-codex timing is
available. Codex app-server text deltas are buffered if they arrive before the
`turn/start` response, preventing an early-notification race from delaying public
SSE streams. With
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
deterministic generated PNG fixture family that direct OpenAI and Anthropic APIs
accept, including single red-square and red/blue multi-image order cases, so
proxy image paths are compared against real provider behavior.
Image generation benchmarks are opt-in because they create billable images.
They verify that local `/v1/images/generations`, `/v1/images/edits`, and
`/v1/images/variations` `image-2` requests are handled through OpenAI Responses
`gpt-5.5` `image_generation` and returned in Images API-compatible `b64_json`,
`url`, or SSE stream shapes. The image cases include API-detail coverage for
`background`, `quality`, `size`, `output_format`, `output_compression`,
`moderation`, `input_fidelity`, JSON edit image references, multipart
`image[]` uploads, multipart-only variations, direct Images API positive
baselines with `gpt-image-1.5`, unsupported `image-2` negative baselines, and
missing/invalid request error shape rows. Current direct Images negative rows
record OpenAI's `image_generation_user_error` cases and the deprecated
variations endpoint's empty 404 separately from proxy-local 400
`invalid_request_error` rows. Current Responses `image_generation` edit also
rejects `input_fidelity=high` for the underlying `gpt-image-2` model, so that
option is tracked as an unsupported-input error row rather than part of the main
edit quality benchmark. `--image-quality-repeats` runs an OpenAI vision
JSON-schema judge over generated image bytes and
`--min-image-quality=90` makes image quality a hard gate.
For `image-2` proxy execution, the caller's image `quality` also selects the
Responses reasoning effort used by `gpt-5.5`: `high` or omitted quality maps to
`xhigh`, `medium` maps to `high`, and `low` maps to `medium`.
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
- `POST /v1/images/generations`
- `POST /v1/images/edits`
- `POST /v1/images/variations`
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
- OpenAI Images generation, edit, and variation requests for `image-2`,
  translated to `gpt-5.5` Responses `image_generation` using `OPENAI_API_KEY`,
  with `b64_json`, local temporary `url`, and streaming image outputs returned
  in Images API-compatible shapes; generation/edit options such as
  `background`, `quality`, `size`, `output_format`, `output_compression`,
  `moderation`, `input_fidelity`, `style`, `user`, `stream`, and
  `partial_images` are validated and forwarded where supported by the Responses
  image tool
- provider token usage details where the CLI exposes them, including cached and
  reasoning-token breakdowns where available; estimated usage is used only as a
  fallback

Not yet supported:

- provider `file_id` image sources for non-image-generation chat/messages paths,
  because the local CLI proxy cannot read the provider Files API storage for the
  caller
- audio output generation
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

## Notes

- `codex` uses `codex app-server` and the local Codex CLI auth state.
- `claude` uses `claude -p` and the local Claude Code auth state.
- This avoids provider API keys, but it still consumes the selected CLI's plan,
  credits, rate limits, and applicable usage policy.
- Codex text streaming maps `item/agentMessage/delta` notifications to the
  local API stream. Claude Code text streaming maps
  `stream_event.event.content_block_delta` `text_delta` chunks to the same local
  API stream.
