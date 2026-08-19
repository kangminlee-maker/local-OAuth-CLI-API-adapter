# Local OAuth CLI API Adapter

Local OAuth CLI API Adapter turns an already-authenticated Codex or Claude Code
CLI session into a small local HTTP API server. It exposes an
OpenAI/Anthropic-compatible subset so tools that expect provider APIs can use a
local OAuth CLI login instead of provider API keys.

The package is meant for local development and automation flows where a consumer
tool can point `OPENAI_BASE_URL` or `ANTHROPIC_BASE_URL` at a loopback proxy.
The proxy runtime does not fall back to direct OpenAI or Anthropic API calls.

LLM agents installing this package must read [`LLM_INSTALL.md`](LLM_INSTALL.md).
The packaged artifact prints that guide during `postinstall`, and it can be
re-read at any time with:

```bash
local-oauth-cli --llm-guide
```

## Quick Start

Build a verified installable tarball from this repository:

```bash
pnpm install
pnpm pack:adapter
```

The command writes and verifies a standalone package:

```text
artifacts/local-oauth-cli-api-adapter-0.2.0.tgz
```

Install that tarball from any other repository:

```bash
pnpm add -D /path/to/local-oauth-cli-api-adapter-0.2.0.tgz
# or
pnpm add -g /path/to/local-oauth-cli-api-adapter-0.2.0.tgz
```

Start the proxy from the consumer repository:

```bash
pnpm exec local-oauth-cli proxy --accept-llm-guide=v1 --runtime codex --port 8787 --cwd /path/to/target-repo
```

Codex text/tool and Images requests can use the thinner backend transport:

```bash
pnpm exec local-oauth-cli proxy --runtime codex \
  --accept-llm-guide=v1 \
  --codex-transport codex-backend \
  --codex-image-transport codex-backend \
  --port 8787
```

`codex-backend` uses the local Codex OAuth token against the ChatGPT Codex
backend surface that Codex itself uses. It is not a direct OpenAI Platform API
call and it does not use `OPENAI_API_KEY`. It refreshes expired Codex OAuth
access tokens with the stored refresh token; if that refresh token is expired,
revoked, or already used, sign in to Codex again. The default is
`codex-backend` for provider-compatible text/tool and Images API requests,
while native local chat still uses Codex app-server.

Then point OpenAI-compatible clients at the local proxy:

```bash
OPENAI_BASE_URL=http://127.0.0.1:8787/v1
OPENAI_API_KEY=local
```

For Anthropic-compatible clients, start a Claude runtime proxy:

```bash
pnpm exec local-oauth-cli proxy --accept-llm-guide=v1 --runtime claude --port 8788 --cwd /path/to/target-repo
```

Then configure:

```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:8788
ANTHROPIC_API_KEY=local
```

## Requirements

- Node.js 22 or newer
- `pnpm`
- A logged-in Codex CLI session for `--runtime codex`
- A logged-in Claude Code CLI session for `--runtime claude`

The proxy uses the selected local CLI's OAuth session. It avoids provider API
keys in the proxy path, but it can still consume the selected CLI plan, credits,
rate limits, and applicable usage policy.

## Supported API Surface

The implemented input/output contract follows the simulated OpenAI and Anthropic
API-compatible shapes for the subset below. The detailed field-by-field contract
lives in [`docs/api-interface-contract.md`](docs/api-interface-contract.md).

| Surface | Endpoint | Status |
| --- | --- | --- |
| OpenAI Models | `GET /v1/models` | Configured model plus models the local runtime advertises |
| OpenAI Chat Completions | `POST /v1/chat/completions` | Text, tools, JSON mode/schema, streaming, image inputs |
| OpenAI Responses | `POST /v1/responses` | Text, function calls, function outputs, streaming, image inputs |
| OpenAI Images | `POST /v1/images/generations` | `image-2` via local Codex image generation |
| OpenAI Images | `POST /v1/images/edits` | JSON image references and multipart edits |
| OpenAI Images | `POST /v1/images/variations` | Multipart variations |
| Anthropic Messages | `POST /v1/messages` | Text, tools, images, streaming, `thinking`/`output_config` tuning |

Planned local CLI chat sessions are intentionally separate from the
provider-compatible API surface. That design lives in
[`docs/local-cli-chat-api-design.md`](docs/local-cli-chat-api-design.md).

Native local CLI chat sessions are available under:

```text
POST   /local/cli/sessions
GET    /local/cli/sessions/{session_id}
POST   /local/cli/sessions/{session_id}/turns
POST   /local/cli/sessions/{session_id}/interrupt
DELETE /local/cli/sessions/{session_id}
```

This path keeps a small `cli.event` / `cli.completed` / `cli.error` SSE
envelope and preserves raw CLI events as the authority instead of rebuilding
OpenAI or Anthropic provider responses.

Common supported features:

- SSE text deltas
- SSE tool/function argument deltas
- OpenAI Chat tool calls and tool-result follow-up messages
- OpenAI Responses function calls and function-call outputs
- Anthropic `tool_use` and `tool_result`
- OpenAI Chat `image_url` inputs
- OpenAI Responses `input_image` inputs
- Anthropic Messages image blocks
- image sources as remote URLs, data URLs/base64, local `file://` URLs, and
  multipart files where the endpoint supports multipart
- Images `response_format` `b64_json` or `url`; URL responses are served from
  `/v1/images/generated/<id>` out of an in-memory store bounded by a one-hour
  TTL, 128 MiB, and 10,000 entries
- Anthropic `thinking` and `output_config` (effort, JSON-schema format, task
  budget) mapped to Claude CLI controls where the model supports them
- provider token usage details when the CLI exposes them, with estimated usage
  only as a fallback

## Model Selection

`model` is required on every text surface and validated exactly as on the
direct APIs. Which model executes is controlled by
`modelSelection.honorRequestModel` in the packaged `settings.json`:

- `false` (default): no existence check is applied, and what executes depends
  on the runtime — the `codex-backend` transport forwards the request model,
  `app-server` uses the configured model (the request model only when none is
  configured), and `claude` ignores the request model.
- `true`: every runtime behaves the same — the request model executes, and a
  model the local runtime cannot run returns 404 `model_not_found`. Codex
  models are checked against `codex debug models` (cached per credentials; an
  unavailable list passes models through rather than failing them), Claude
  models by the CLI's own refusal.

`/v1/images/*` is exempt: the Images `model` (`image-2`, `dall-e-2`,
`gpt-image-*`) is a route selector with its own validation, and the Codex
model that actually runs image turns is `codexProxy.imageModel`.

## Important Differences From Full Provider APIs

This adapter is compatible with a focused subset, not a full clone of the
OpenAI or Anthropic APIs.

| Area | Difference |
| --- | --- |
| Runtime authority | Local proxy requests never call direct OpenAI or Anthropic APIs. |
| Model list | `GET /v1/models` returns the configured model plus models the local runtime advertises — not the full provider catalog. |
| Model execution | Governed by `modelSelection.honorRequestModel`; see Model Selection above. Off, execution is runtime-dependent with no existence check; on, the request model executes and an unrunnable one is a 404 `model_not_found`, never a silent replacement. |
| Thinking budget | Anthropic `thinking.budget_tokens` is validated to the direct domain (required for `enabled`, integer ≥ 1024, `< max_tokens`) but not forwarded: the local runtime governs its own thinking budget. |
| Context | Codex proxy runs with isolated home/workspace settings so ambient project context does not leak into API requests. |
| Claude user settings | By default the Claude runtime loads your `user` settings into every spawned child, so your global CLAUDE.md enters each request's context and your configured hooks run once per API turn. Start the proxy with `--isolate-user-settings` to load no setting source instead (keychain OAuth still works; credentials supplied through the settings file do not). |
| Codex transport | `codexProxy.transport` defaults to `codex-backend`; text/tool uses ChatGPT Codex backend directly. |
| Codex image transport | `codexProxy.imageTransport` defaults to `codex-backend`; Images API uses backend `image_generation` tool results, while native chat uses app-server. |
| Images `image-2` | Implemented through the local Codex `gpt-5.5` image-generation route. |
| Images proxy route hints | Optional `x_proxy_image_route` is a proxy-only extension for explicit visual class, geometry mode, and output format routing. |
| Images flat/vector references | PNG flat/vector reference-style outputs may receive deterministic edge-preserving flattening to reduce gradients while preserving small accent colors and outlines. |
| Images partial streaming | `partial_images > 0` is rejected; streams emit completed images only. |
| Images `input_fidelity` | Treated as disabled for `image-2`. |
| Provider `file_id` images | Rejected because the local CLI proxy cannot read provider Files API storage. |
| Token usage | Provider CLI usage is preferred; estimated usage is fallback only. |
| Audio / embeddings | Not implemented. |

For the complete list of input/output rules and implementation differences, see
[`docs/api-interface-contract.md`](docs/api-interface-contract.md).

## Access Key And Remote Exposure

By default the proxy binds to `127.0.0.1` and performs no inbound authentication.
To reach it from another machine or a web service, enable a key gate and put it
behind a tunnel.

Enable the gate with `--auth-key` or the `LOCAL_OAUTH_PROXY_KEY` environment
variable:

```bash
local-oauth-cli proxy --accept-llm-guide=v1 --runtime codex --auth-key "$MY_KEY"
# or
LOCAL_OAUTH_PROXY_KEY="$MY_KEY" local-oauth-cli proxy --accept-llm-guide=v1 --runtime codex
```

When set, every request except the CORS preflight must present the key via
`Authorization: Bearer <key>` or `x-api-key: <key>`. An OpenAI or Anthropic SDK
can therefore use the key as its API key with no code changes:

```bash
export OPENAI_BASE_URL="https://<your-tunnel-host>/v1"
export OPENAI_API_KEY="$MY_KEY"
```

A missing or wrong key returns a provider-shaped `401` (`invalid_api_key` for
OpenAI paths, `authentication_error` for `/v1/messages`). The key gates proxy
access only; the local CLI backend still authenticates with its own OAuth
session.

A key that is configured but could never be presented — empty (for example, a
deployment secret that expanded to nothing) or carrying leading/trailing
whitespace — is a configuration error, not an open gate: the proxy answers
every request with a fixed 500 and writes the specific cause to its own
stderr. Only true absence of both the flag and the environment variable
disables the gate.

To reach the proxy from the internet, keep it on `127.0.0.1` and front it with a
tunnel — no router changes and your home IP stays hidden:

```bash
# example: Cloudflare Tunnel pointing at the local proxy
cloudflared tunnel --url http://127.0.0.1:8787
```

Personal use only. Serving a web service from a personal CLI subscription may
violate the provider's terms, and subscription session/rate limits, your
machine's availability, and CLI latency all still apply.

## Examples

OpenAI Chat Completions:

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer local' \
  -d '{
    "model": "gpt-5.5",
    "messages": [
      { "role": "user", "content": "Reply with exactly: OK" }
    ]
  }'
```

OpenAI Responses:

```bash
curl http://127.0.0.1:8787/v1/responses \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer local' \
  -d '{
    "model": "gpt-5.5",
    "input": "Reply with exactly: OK"
  }'
```

OpenAI Images through the local `image-2` route:

```bash
curl http://127.0.0.1:8787/v1/images/generations \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer local' \
  -d '{
    "model": "image-2",
    "prompt": "A simple flat red square on a pure white background.",
    "size": "1024x1024",
    "quality": "medium",
    "response_format": "b64_json"
  }'
```

OpenAI Images with explicit proxy routing hints:

```bash
curl http://127.0.0.1:8787/v1/images/generations \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer local' \
  -d '{
    "model": "image-2",
    "prompt": "Create a simple flat circular badge: teal outer circle, white inner circle, and one small orange star in the center. No text.",
    "quality": "low",
    "response_format": "b64_json",
    "x_proxy_image_route": {
      "visual_class": "badge_or_emblem",
      "geometry_mode": "strict",
      "output_format": "webp",
      "output_compression": 95
    }
  }'
```

`x_proxy_image_route` is not an OpenAI field. It is accepted only by this local
proxy to avoid guessing the image route from ambiguous prompts. Standard Images
API fields still take priority: if both `output_format` and
`x_proxy_image_route.output_format` are present, `output_format` wins.

Supported proxy route fields:

| Field | Values | Effect |
| --- | --- | --- |
| `visual_class` | `primitive_flat_shape`, `geometric_icon`, `badge_or_emblem`, `photoreal_raster`, `product_identity`, `reference_or_edit`, `unknown_hybrid` | Adds route-specific generation constraints without rewriting the prompt. |
| `geometry_mode` | `auto`, `strict`, `loose` | Controls whether ambiguous shape language is resolved toward exact geometry or looser stylization. |
| `output_format` | `png`, `jpeg`, `webp` | Used as the effective output format only when standard `output_format` is omitted. |
| `output_compression` | integer `0-100` | Used as the effective compression only when standard `output_compression` is omitted; valid only with JPEG/WebP output. |

For multipart image edits or variations, pass `x_proxy_image_route` as a JSON
string form field.

Anthropic Messages:

```bash
curl http://127.0.0.1:8788/v1/messages \
  -H 'Content-Type: application/json' \
  -H 'x-api-key: local' \
  -H 'anthropic-version: 2023-06-01' \
  -d '{
    "model": "claude-opus-5",
    "max_tokens": 64,
    "messages": [
      { "role": "user", "content": "Reply with exactly: OK" }
    ]
  }'
```

## Package Independence

The installable proxy bin contains only the proxy runtime files,
`settings.json`, `LLM_INSTALL.md`, README, and contract/design docs. It does not
install or load sibling-repository packages and does not depend on this source
checkout after installation.

The package `postinstall` script prints `LLM_INSTALL.md` from the installed
package root. If that file is missing, the install should be treated as invalid.
Some package managers can block dependency lifecycle scripts; for that reason
`local-oauth-cli proxy` also requires `--accept-llm-guide=v1` and otherwise
prints the guide before exiting.

For independence, avoid `file:../path-to-adapter-source` installs. Use the
verified tarball, a release asset containing that tarball, or a registry package
built from the same artifact flow.

The proxy also strips direct provider credential/routing environment variables
from spawned local CLI backends, including OpenAI/Anthropic API keys and base
URLs. The target backend should authenticate through its local OAuth CLI session,
not inherited provider API key settings.

## Local Development

Install and build:

```bash
pnpm install
pnpm build
```

Start a development proxy:

```bash
pnpm proxy:codex
# or
pnpm proxy:claude
```

Run the main verification suite:

```bash
pnpm test
```

Run runtime capability catalog and smoke checks:

```bash
pnpm catalog:runtime
pnpm smoke:runtime-capabilities
pnpm smoke:runtime-capabilities -- --include-live-model
```

Run the installed-package E2E test:

```bash
pnpm test:e2e:adapter
```

This E2E test packs the adapter, installs the tarball into a temporary consumer
project, starts the installed `local-oauth-cli` bin with a deterministic fake
Codex app-server backend, and verifies OpenAI-compatible model, chat completion,
image, and SSE streaming responses over HTTP.

## Real CLI Checks

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

These commands use actual logged-in CLI sessions and may consume plan credits or
rate limits.

To verify the raw Codex backend image path and installed Codex binary schema:

```bash
pnpm probe:codex-backend-image
```

The probe calls only `chatgpt.com/backend-api/codex` plus Codex OAuth refresh if
needed. It records whether backend SSE emits `image_generation_call.result` and
saves the generated image under `artifacts/codex-backend-image-probe/`.
For image latency request-shape probes, pass comma-separated variants and
repeats, for example:

```bash
pnpm probe:codex-backend-image -- --repeats 2 --no-stop-after-success \
  --variant tool_image_generation_required_with_controls,tool_image_generation_required_action_format
```

## Benchmarks

Run a comparison benchmark against direct provider APIs:

```bash
pnpm bench:api
pnpm bench:api -- --suite=contract-smoke --targets=proxy-codex,proxy-claude --repeats 1
pnpm bench:api -- --suite=contract-smoke --targets=proxy-codex-app-server,proxy-codex-backend --repeats 1
pnpm bench:api -- --suite=provider-parity --targets=proxy-codex,proxy-claude,openai-api:gpt-5.5,anthropic-api:opus --repeats 3
pnpm bench:api -- --suite=quality-realistic --targets=proxy-codex,proxy-claude --min-semantic-quality=95
pnpm bench:api -- --suite=image-realistic --targets=proxy-codex,openai-api:gpt-5.5 --image-quality-repeats=1 --min-image-quality=90 --repeats 1
pnpm build && node scripts/poc-image-runtime-pipeline.mjs --cases flat-webp,photo-jpeg --repeats 1
pnpm build && node scripts/bench-image-format-classification.mjs --repeats 5
pnpm build && node scripts/bench-image-format-targeted.mjs --repeats 3
```

Benchmarks load `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` from the environment or
`.env` for direct provider targets. Direct provider rows can consume paid
credits and rate limits.
For `proxy-codex`, image benchmark rows use `codex-backend` by default; pass
`--codex-image-transport app-server` only when measuring the older diagnostic
image path.
When diagnosing Codex backend image latency or no-image completions, pass
`--codex-image-attempt-diagnostics` to include attempt timelines in the summary,
or `--codex-image-attempt-log artifacts/image-attempts.jsonl` to also write JSONL.

Benchmark design and release gates are documented in
[`docs/api-benchmark-design.md`](docs/api-benchmark-design.md). The benchmark
runner compares schema exactness, response shape, streaming event shape, usage,
latency, semantic quality, image quality, and provider error parity.

`scripts/poc-image-runtime-pipeline.mjs` is a repo-local benchmark helper for
checking whether Images API output formatting should be handled by the model or
by deterministic local runtime transforms. It is intentionally not included in
the installable package.
`scripts/bench-image-format-classification.mjs` extends that check across image
classes such as simple flat graphics, text/logo graphics, photoreal raster,
product identity, reference/edit, and hybrid prompts.
`scripts/bench-image-format-targeted.mjs` narrows the comparison to prompt-diverse
simple flat graphics and photoreal raster images before promoting a format rule.

Proxy benchmark rows are guarded: if a local proxy target makes a direct
provider API call during a proxy request, the row fails and quality is forced to
0. Direct OpenAI/Anthropic calls are allowed only under explicit direct provider
benchmark targets.
Benchmarks that include `x_proxy_image_route` should be labeled as proxy
enhanced rows. Provider parity rows should omit proxy-only extension fields.

## Reference Docs

- [`docs/api-interface-contract.md`](docs/api-interface-contract.md): public
  input/output contract and implementation differences
- [`docs/api-benchmark-design.md`](docs/api-benchmark-design.md): benchmark
  suites, provider authorities, quality gates, and latency metrics
- [`docs/direct-api-transport-handoff.md`](docs/direct-api-transport-handoff.md):
  design handoff for adding a separate direct provider transport surface
- [`docs/local-cli-chat-api-design.md`](docs/local-cli-chat-api-design.md):
  native local CLI chat session API design
- [`docs/runtime-capability-catalog.md`](docs/runtime-capability-catalog.md):
  Codex and Claude Code non-interactive runtime capability map
- [`docs/runtime-capability-update-playbook.md`](docs/runtime-capability-update-playbook.md):
  periodic validity check and LLM-assisted update process for the runtime map
- [`docs/optimization-learnings.md`](docs/optimization-learnings.md): lessons
  from proxy optimization work
- [`docs/review-defect-criteria.md`](docs/review-defect-criteria.md): defect
  classification used by the review process (behavioral defect vs coverage gap
  vs doc gap) and what each class gates

## Runtime Notes

- `codex` uses the hybrid Codex proxy path by default: `codex-backend` for
  provider-compatible text/tool and Images API requests, and `codex app-server`
  for native local chat sessions.
- `codex-backend` calls `chatgpt.com/backend-api/codex` with the local Codex
  OAuth token. For Images API requests it sends the backend Responses
  `image_generation` tool and maps `image_generation_call.result` to OpenAI
  Images-compatible `b64_json` or local URL responses. The transport
  proactively refreshes the access token near expiry and retries once after
  backend auth failures.
- `claude` uses `claude -p` and the local Claude Code auth state.
- Codex text streaming maps app-server agent-message deltas to the local API
  stream.
- Claude Code text streaming maps Claude stream-json text deltas to the local
  API stream.
- Plain text Claude requests use one long-lived process and clear context after
  each request. Tool-call, JSON-schema, image, per-request tuning
  (effort/thinking/task budget), and honored non-default-model requests use
  one-shot Claude processes, because those controls live on the spawned argv.
