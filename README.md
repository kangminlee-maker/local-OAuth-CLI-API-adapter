# Local OAuth CLI API Adapter

Experimental local adapter that makes an already-authenticated OAuth CLI look
like a small API server.

The first backend is Codex CLI via a long-lived `codex app-server` process. The
adapter exposes a local OpenAI/Anthropic-compatible subset so local tools can use
OAuth CLI login instead of provider API keys.

It also includes a ggui MCP add-on mode that swaps ggui's UI generator for a CLI
runtime without patching the upstream `ggui` repository.

## Local API Proxy

```bash
pnpm install
pnpm build
pnpm proxy:codex
```

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
- synthetic SSE streaming for text and tool-call responses
- OpenAI JSON object/schema output where supported by the backend
- OpenAI Chat tool calls and tool-result follow-up messages
- OpenAI Responses function calls and function-call outputs
- Anthropic `tool_use` and `tool_result`

Not yet supported:

- true token-level streaming from the underlying CLI
- multimodal inputs
- exact provider token usage
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
