# LLM install and usage guide

This file is for LLM agents installing or operating `local-oauth-cli-api-adapter`.
Read it before running the proxy or generating integration code.

## What This Package Does

`local-oauth-cli-api-adapter` exposes a local OAuth CLI runtime through:

- OpenAI-compatible `/v1/chat/completions`
- OpenAI-compatible `/v1/responses`
- OpenAI-compatible `/v1/images/generations`, `/v1/images/edits`
- Anthropic-compatible `/v1/messages`
- Native local CLI chat endpoints under `/local/cli/sessions`

The proxy runtime must not call direct OpenAI or Anthropic Platform APIs.
Direct provider APIs are allowed only in explicit benchmark/reference workflows
outside normal proxy execution.

## Install

Prefer an artifact tarball, release asset, or registry package.
Avoid `file:../source-checkout` installs for consumers.

```bash
pnpm add -D ./local-oauth-cli-api-adapter-0.1.0.tgz
pnpm exec local-oauth-cli --help
pnpm exec local-oauth-cli --llm-guide
```

## Start A Proxy

Codex runtime:

```bash
pnpm exec local-oauth-cli proxy --accept-llm-guide=v1 --runtime codex --port 8787 --cwd /path/to/project
```

Claude runtime:

```bash
pnpm exec local-oauth-cli proxy --accept-llm-guide=v1 --runtime claude --port 8788 --cwd /path/to/project
```

Use these base URLs:

```text
OpenAI-compatible:    http://127.0.0.1:8787/v1
Anthropic-compatible: http://127.0.0.1:8788
Native local chat:    http://127.0.0.1:8787/local/cli/sessions
```

## Required Runtime Boundaries

- Do not add direct provider API fallback to proxy request paths.
- Do not pass direct provider API keys into child CLI environments.
- Do not depend on this source checkout after installing the packaged artifact.
- Do not import sibling repository packages.
- Preserve provider-compatible input and output shapes for implemented fields.
- Treat unsupported provider fields as explicit errors when the runtime cannot honor them.
- Keep benchmark direct provider calls isolated to direct provider targets.

## Images API Notes

`model` must be one of the direct API's live image models (`gpt-image-2`, `gpt-image-1`,
`gpt-image-1-mini`, `gpt-image-1.5`, `gpt-image-2-2026-04-21`, `chatgpt-image-latest`);
every one runs on the local Codex image route. `dall-e-*`, the former `image-2` and any
other name are refused as the direct API refuses them. `/v1/images/variations` is 404.

Standard Images fields keep provider-compatible priority:

- `quality`
- `size`
- `background`
- `output_format`
- `output_compression`
- `stream`

`partial_images > 0` is unsupported and must return an error.
`input_fidelity` is edits-only, and the backend image model refuses it today.
`response_format` and `style` are unknown parameters, as on the direct API.

## Proxy-only Image Route Hints

Use `x_proxy_image_route` only when the caller wants local proxy behavior that
is more explicit than prompt-derived automatic routing.

Example:

```json
{
  "model": "gpt-image-2",
  "prompt": "Create a simple flat circular badge: teal outer circle, white inner circle, and one small orange star in the center. No text.",
  "quality": "low",
  "x_proxy_image_route": {
    "visual_class": "badge_or_emblem",
    "geometry_mode": "strict",
    "output_format": "webp",
    "output_compression": 95
  }
}
```

Supported `x_proxy_image_route` fields:

| Field | Values |
| --- | --- |
| `visual_class` | `primitive_flat_shape`, `geometric_icon`, `badge_or_emblem`, `photoreal_raster`, `product_identity`, `reference_or_edit`, `unknown_hybrid` |
| `geometry_mode` | `auto`, `strict`, `loose` |
| `output_format` | `png`, `jpeg`, `webp` |
| `output_compression` | integer `0-100` |

Standard fields win over extension fields. If both `output_format` and
`x_proxy_image_route.output_format` are present, use `output_format`.

For multipart image edits, pass `x_proxy_image_route` as a JSON
string form field.

## Benchmark Labels

Use separate labels for these cases:

- Provider parity: direct API and proxy receive the same provider-compatible
  input surface. Do not include `x_proxy_image_route`.
- Proxy enhanced: proxy-only extension fields are present.
- Direct provider: calls an actual provider API intentionally for baseline,
  judging, or reference generation.

If a proxy benchmark target calls direct provider APIs during proxy execution,
the row must fail.

## Native Local CLI Chat

Use `/local/cli/sessions` when the product wants raw local CLI session behavior
instead of rebuilt provider-compatible responses.

Native chat is for attaching a local OAuth CLI to an application-specific chat
UI while preserving raw runtime events in a small SSE envelope.

## First Checks After Install

```bash
pnpm exec local-oauth-cli --help
pnpm exec local-oauth-cli --llm-guide
```

If the guide is missing, treat the package as invalid.
If `proxy` is run without `--accept-llm-guide=v1`, the CLI prints this guide
and exits instead of starting the server.

## Documentation Map

- `README.md`: human quickstart and common examples
- `docs/api-interface-contract.md`: supported input/output contract
- `docs/api-benchmark-design.md`: benchmark authority and release gates
- `docs/local-cli-chat-api-design.md`: native local CLI chat design
- `docs/runtime-capability-catalog.md`: CLI capability map
