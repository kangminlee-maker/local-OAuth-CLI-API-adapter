# Local OAuth CLI API Adapter

Local OAuth CLI API Adapter turns an already-authenticated Codex or Claude Code
CLI session into a small local HTTP API server. It exposes an
OpenAI/Anthropic-compatible subset so tools that expect provider APIs can use a
local OAuth CLI login instead of provider API keys.

The package is meant for local development and automation flows where a consumer
tool can point `OPENAI_BASE_URL` or `ANTHROPIC_BASE_URL` at a loopback proxy.
The proxy runtime does not fall back to direct OpenAI or Anthropic API calls.

## Quick Start

Build a verified installable tarball from this repository:

```bash
pnpm install
pnpm pack:adapter
```

The command writes and verifies a standalone package:

```text
artifacts/local-oauth-cli-api-adapter-0.1.0.tgz
```

Install that tarball from any other repository:

```bash
pnpm add -D /path/to/local-oauth-cli-api-adapter-0.1.0.tgz
# or
pnpm add -g /path/to/local-oauth-cli-api-adapter-0.1.0.tgz
```

Start the proxy from the consumer repository:

```bash
pnpm exec local-oauth-cli proxy --runtime codex --port 8787 --cwd /path/to/target-repo
```

Then point OpenAI-compatible clients at the local proxy:

```bash
OPENAI_BASE_URL=http://127.0.0.1:8787/v1
OPENAI_API_KEY=local
```

For Anthropic-compatible clients, start a Claude runtime proxy:

```bash
pnpm exec local-oauth-cli proxy --runtime claude --port 8788 --cwd /path/to/target-repo
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
| OpenAI Models | `GET /v1/models` | Supported local model list |
| OpenAI Chat Completions | `POST /v1/chat/completions` | Text, tools, JSON mode/schema, streaming, image inputs |
| OpenAI Responses | `POST /v1/responses` | Text, function calls, function outputs, streaming, image inputs |
| OpenAI Images | `POST /v1/images/generations` | `image-2` via local Codex image generation |
| OpenAI Images | `POST /v1/images/edits` | JSON image references and multipart edits |
| OpenAI Images | `POST /v1/images/variations` | Multipart variations |
| Anthropic Messages | `POST /v1/messages` | Text, tools, images, streaming |

Planned local CLI chat sessions are intentionally separate from the
provider-compatible API surface. That design lives in
[`docs/local-cli-chat-api-design.md`](docs/local-cli-chat-api-design.md).

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
- provider token usage details when the CLI exposes them, with estimated usage
  only as a fallback

## Important Differences From Full Provider APIs

This adapter is compatible with a focused subset, not a full clone of the
OpenAI or Anthropic APIs.

| Area | Difference |
| --- | --- |
| Runtime authority | Local proxy requests never call direct OpenAI or Anthropic APIs. |
| Model list | `GET /v1/models` returns the configured local backend model, not the full provider catalog. |
| Model execution | The request `model` is accepted, but execution is constrained by the selected local CLI backend. |
| Context | Codex proxy runs with isolated home/workspace settings so ambient project context does not leak into API requests. |
| Images `image-2` | Implemented through the local Codex `gpt-5.5` image-generation route. |
| Images partial streaming | `partial_images > 0` is rejected; streams emit completed images only. |
| Images `input_fidelity` | Treated as disabled for `image-2`. |
| Provider `file_id` images | Rejected because the local CLI proxy cannot read provider Files API storage. |
| Token usage | Provider CLI usage is preferred; estimated usage is fallback only. |
| Audio / embeddings | Not implemented. |

For the complete list of input/output rules and implementation differences, see
[`docs/api-interface-contract.md`](docs/api-interface-contract.md).

## Examples

OpenAI Chat Completions:

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

OpenAI Responses:

```bash
curl http://127.0.0.1:8787/v1/responses \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer local' \
  -d '{
    "model": "codex-app-server",
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

Anthropic Messages:

```bash
curl http://127.0.0.1:8788/v1/messages \
  -H 'Content-Type: application/json' \
  -H 'x-api-key: local' \
  -H 'anthropic-version: 2023-06-01' \
  -d '{
    "model": "claude-code",
    "max_tokens": 64,
    "messages": [
      { "role": "user", "content": "Reply with exactly: OK" }
    ]
  }'
```

## Package Independence

The installable proxy bin contains only the proxy runtime files,
`settings.json`, README, and contract/design docs. It does not install or load
sibling-repository packages and does not depend on this source checkout after
installation.

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

## Benchmarks

Run a comparison benchmark against direct provider APIs:

```bash
pnpm bench:api
pnpm bench:api -- --suite=contract-smoke --targets=proxy-codex,proxy-claude --repeats 1
pnpm bench:api -- --suite=provider-parity --targets=proxy-codex,proxy-claude,openai-api:gpt-5.5,anthropic-api:opus --repeats 3
pnpm bench:api -- --suite=quality-realistic --targets=proxy-codex,proxy-claude --min-semantic-quality=95
pnpm bench:api -- --suite=image-realistic --targets=proxy-codex,openai-api:gpt-5.5 --image-quality-repeats=1 --min-image-quality=90 --repeats 1
```

Benchmarks load `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` from the environment or
`.env` for direct provider targets. Direct provider rows can consume paid
credits and rate limits.

Benchmark design and release gates are documented in
[`docs/api-benchmark-design.md`](docs/api-benchmark-design.md). The benchmark
runner compares schema exactness, response shape, streaming event shape, usage,
latency, semantic quality, image quality, and provider error parity.

Proxy benchmark rows are guarded: if a local proxy target makes a direct
provider API call during a proxy request, the row fails and quality is forced to
0. Direct OpenAI/Anthropic calls are allowed only under explicit direct provider
benchmark targets.

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

## Runtime Notes

- `codex` uses `codex app-server` and the local Codex CLI auth state.
- `claude` uses `claude -p` and the local Claude Code auth state.
- Codex text streaming maps app-server agent-message deltas to the local API
  stream.
- Claude Code text streaming maps Claude stream-json text deltas to the local
  API stream.
- Plain text Claude requests use one long-lived process and clear context after
  each request. Tool-call, JSON-schema, and image requests use one-shot Claude
  processes where needed for per-request schema or attachment isolation.
