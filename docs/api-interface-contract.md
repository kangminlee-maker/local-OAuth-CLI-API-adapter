# API interface contract

이 문서는 local OAuth CLI API adapter가 외부에 제공하는 input/output interface 규약이다. 원칙은 명확하다.

- 구현된 surface의 input spec과 output spec은 OpenAI 또는 Anthropic API-compatible shape를 기준으로 한다.
- provider와 동일하게 보이도록 simulate한 subset만 public contract로 본다.
- 구현상 provider와 다르게 처리하는 영역은 "구현 차이와 제약"에 별도 명시한다.
- 런타임 proxy는 direct provider API를 호출하지 않는다. direct provider API는 benchmark, reference 생성, 별도 direct transport 설계에서만 다룬다.

## Supported surfaces

| Provider-compatible surface | Endpoint | Runtime backend |
| --- | --- | --- |
| OpenAI Models | `GET /v1/models` | local backend metadata |
| OpenAI Chat Completions | `POST /v1/chat/completions` | Codex-compatible local backend |
| OpenAI Responses | `POST /v1/responses` | Codex-compatible local backend |
| OpenAI Images | `POST /v1/images/generations`, `/v1/images/edits`, `/v1/images/variations` | Codex image-generation backend for `image-2` route |
| Anthropic Messages | `POST /v1/messages` | Claude-compatible local backend |

## OpenAI Chat Completions

### Input spec

The request body is a JSON object compatible with Chat Completions for the implemented subset.

| Field | Supported shape | Handling |
| --- | --- | --- |
| `model` | string | **Required**, as on the direct APIs. Absent, empty, whitespace-only, or non-string values return 400 `invalid_request_error` with `param: model`. Whether it selects the executed model depends on `modelSelection.honorRequestModel`; see Model execution. |
| `messages` | array | Required. Each item must be an object. |
| `messages[].role` | `system`, `developer`, `user`, `assistant`, `tool` | Preserved in normalized conversation. Unknown roles are normalized to `user`. |
| `messages[].content` | string or content-part array | Text is flattened. `image_url` parts are preserved as image inputs. |
| `messages[].tool_calls` | assistant tool call array | Flattened into conversation context for tool-result continuation. |
| `messages[].tool_call_id` | string | Preserved for `tool` role messages. |
| `tools` | OpenAI function tool array | `function.name`, `function.description`, and `function.parameters` are preserved. |
| `tool_choice` | `none`, `required`, or `{ type: "function", function: { name } }` | Mapped to internal tool-choice modes. Other values default to `auto`. |
| `stream` | boolean | `true` enables SSE chunks. |
| `stream_options.include_usage` | boolean | Emits final usage chunk when true. |
| `stream_options.include_obfuscation` | boolean | Defaults to true unless explicitly false. |
| `response_format` | `{ type: "json_object" }` or `{ type: "json_schema", json_schema: { schema } }` | Enables JSON mode/schema steering where backend supports it. |
| `reasoning_effort` | `none`, `minimal`, `low`, `medium`, `high`, `xhigh` | Request value takes priority over fallback settings. Invalid values return 400. |
| `reasoning.effort` | same enum | Accepted as an alternate source. |
| `verbosity` | `low`, `medium`, `high` | Request value takes priority over fallback settings. |
| `text.verbosity` | same enum | Accepted as an alternate source. |
| `max_tokens`, `max_completion_tokens` | number | Passed to backend as max token hint. |
| `temperature` | number | Passed to backend as temperature hint. |

### Output spec

Non-streaming response uses OpenAI Chat Completions shape:

```json
{
  "id": "chatcmpl-...",
  "object": "chat.completion",
  "created": 0,
  "model": "...",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "...",
        "refusal": null,
        "annotations": []
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 0,
    "completion_tokens": 0,
    "total_tokens": 0,
    "prompt_tokens_details": {
      "cached_tokens": 0,
      "audio_tokens": 0
    },
    "completion_tokens_details": {
      "reasoning_tokens": 0,
      "audio_tokens": 0,
      "accepted_prediction_tokens": 0,
      "rejected_prediction_tokens": 0
    }
  },
  "service_tier": "default",
  "system_fingerprint": null
}
```

When the backend returns tool calls, `message.content` is `null`, `message.tool_calls` is populated, and `finish_reason` is `tool_calls`.

### Streaming output spec

SSE stream uses `data: ...` Chat Completions chunks and ends with `data: [DONE]`.

- First assistant chunk includes `delta.role`.
- Text chunks include `delta.content`.
- Tool chunks include `delta.tool_calls[].function.arguments` deltas.
- Final choice chunk has `finish_reason: "stop"` or `"tool_calls"`.
- If `stream_options.include_usage` is true, an extra chunk with `choices: []` and `usage` is emitted before `[DONE]`.
- Chunk `usage` is `null` when `include_usage` is true and the chunk is not the final usage chunk.

## OpenAI Responses

### Input spec

The request body is a JSON object compatible with Responses for the implemented subset.

| Field | Supported shape | Handling |
| --- | --- | --- |
| `model` | string | **Required**, as on the direct APIs. Absent, empty, whitespace-only, or non-string values return 400 `invalid_request_error` with `param: model`. Whether it selects the executed model depends on `modelSelection.honorRequestModel`; see Model execution. |
| `instructions` | string | Added as system-level instruction input. |
| `input` | string or array | String becomes a user message. Array items support message-like objects, `function_call`, and `function_call_output`. |
| `input[].role` | OpenAI-style role | Unknown or missing roles normalize to `user`. |
| `input[].content` | string, object, or content-part array | Text is flattened. `input_image` parts are preserved as image inputs. |
| `tools` | function tools | Same tool parser as Chat Completions. |
| `tool_choice` | string or object | Preserved in output response config and mapped to internal tool-choice mode. |
| `stream` | boolean | `true` enables Responses SSE events. |
| `stream_options.include_usage` | boolean | Parsed for shared stream options. |
| `text.format` | `{ type: "text" }`, `{ type: "json_object" }`, `{ type: "json_schema", schema }` | JSON modes enable backend schema steering. |
| `text.verbosity` | `low`, `medium`, `high` | Request value takes priority over fallback settings. |
| `reasoning.effort` | `none`, `minimal`, `low`, `medium`, `high`, `xhigh` | Request value takes priority over fallback settings. |
| `max_output_tokens` | number | Passed to backend as max token hint. |
| `temperature` | number | Passed to backend as temperature hint. |
| `previous_response_id`, `prompt_cache_key`, `safety_identifier`, `metadata`, `user`, `store`, `truncation` | provider-style fields | Reflected in the response object where implemented. |

### Output spec

Non-streaming response uses Responses object shape:

```json
{
  "id": "resp_...",
  "object": "response",
  "created_at": 0,
  "status": "completed",
  "background": false,
  "billing": { "payer": "developer" },
  "completed_at": 0,
  "error": null,
  "instructions": null,
  "max_output_tokens": null,
  "model": "...",
  "output": [],
  "parallel_tool_calls": true,
  "reasoning": {
    "context": "current_turn",
    "effort": "medium",
    "summary": null
  },
  "service_tier": "default",
  "store": true,
  "temperature": 1,
  "text": {
    "format": { "type": "text" },
    "verbosity": "medium"
  },
  "tool_choice": "auto",
  "tools": [],
  "usage": {
    "input_tokens": 0,
    "output_tokens": 0,
    "total_tokens": 0,
    "input_tokens_details": { "cached_tokens": 0 },
    "output_tokens_details": { "reasoning_tokens": 0 }
  }
}
```

Text output is represented as a reasoning item plus an assistant message item with `content[].type: "output_text"`. Tool output is represented as `function_call` items with `call_id`, `name`, and `arguments`.

### Streaming output spec

Responses streaming uses named SSE events:

- `response.created`
- `response.in_progress`
- `response.output_item.added`
- `response.output_item.done`
- `response.content_part.added`
- `response.output_text.delta`
- `response.output_text.done`
- `response.content_part.done`
- `response.function_call_arguments.delta`
- `response.function_call_arguments.done`
- `response.completed`
- `error`

Each event payload includes a monotonically increasing `sequence_number`. The stream ends with `data: [DONE]`.

## OpenAI Images

### Input spec

Images requests accept JSON bodies, and edit/variation endpoints also accept `multipart/form-data` where applicable.

| Field | Generation | Edit | Variation | Handling |
| --- | --- | --- | --- | --- |
| `model` | optional | optional | optional | Defaults to `dall-e-2`. `image-2` is the local Codex image route. |
| `prompt` | required | required | ignored | Variation uses `Create a variation of the provided image.` internally. |
| `image`, `image[]`, `images` | ignored | required | required | JSON image references are accepted for edits. Variations require multipart. |
| `mask` | ignored | optional | ignored | Accepted as image input. |
| `n` | optional | optional | optional | Integer 1-10, default 1. |
| `size` | optional | optional | optional | `auto` or `WIDTHxHEIGHT`. |
| `quality` | optional | optional | optional | `standard`, `hd`, `low`, `medium`, `high`, `auto`. |
| `background` | optional | optional | optional | `transparent`, `opaque`, `auto`. |
| `output_format` | optional | optional | optional | `png`, `jpeg`, `webp`. |
| `output_compression` | optional | optional | optional | Integer 0-100; valid only for `jpeg` or `webp`. |
| `moderation` | optional | optional | optional | `low`, `auto`. |
| `input_fidelity` | invalid | optional | invalid | `high`, `low`; disabled for `image-2`. |
| `style` | optional | invalid | invalid | `vivid`, `natural`. |
| `user` | optional | optional | optional | Accepted. |
| `response_format` | optional | optional | optional | `b64_json` or `url`, default `b64_json`. Rejected for `gpt-image-*` models. |
| `stream` | optional | optional | optional | Boolean. |
| `partial_images` | optional | optional | optional | Only `0` or omitted is supported. Values above 0 return 400. |
| `x_proxy_image_route` | optional | optional | optional | Proxy-only extension object. Multipart requests may pass it as a JSON string form field. |

Image references support:

- URL string
- data URL
- `{ "image_url": "..." }`
- `{ "image_url": { "url": "..." } }`
- `{ "url": "..." }`
- `{ "b64_json": "...", "media_type": "image/png" }`
- multipart file parts
- `{ "file_id": "..." }` is parsed but rejected before backend execution for local proxy paths.

`x_proxy_image_route` is outside the provider-compatible OpenAI Images surface.
It exists so applications can avoid ambiguous prompt-derived route inference
when they already know the image class and desired output format. Standard
Images API fields take priority over extension fields.

| `x_proxy_image_route` field | Supported values | Handling |
| --- | --- | --- |
| `visual_class` | `primitive_flat_shape`, `geometric_icon`, `badge_or_emblem`, `photoreal_raster`, `product_identity`, `reference_or_edit`, `unknown_hybrid` | Adds route-specific generation constraints without changing the user prompt. |
| `geometry_mode` | `auto`, `strict`, `loose` | Controls whether ambiguous shape language is resolved toward exact geometry or looser stylization. |
| `output_format` | `png`, `jpeg`, `webp` | Used as effective output format only when standard `output_format` is omitted. |
| `output_compression` | integer 0-100 | Used as effective compression only when standard `output_compression` is omitted; valid only with JPEG/WebP output. |

### Output spec

Non-streaming output follows Images response shape:

```json
{
  "created": 0,
  "data": [
    {
      "b64_json": "...",
      "revised_prompt": "..."
    }
  ],
  "background": "opaque",
  "output_format": "png",
  "quality": "high",
  "size": "1024x1024",
  "usage": {
    "input_tokens": 0,
    "output_tokens": 0,
    "total_tokens": 0,
    "input_tokens_details": { "cached_tokens": 0 },
    "output_tokens_details": { "reasoning_tokens": 0 }
  }
}
```

When `response_format: "url"` is requested, each image object contains `url` instead of `b64_json`. The URL points to the local proxy under `/v1/images/generated/{id}` and is fetchable for approximately one hour.

### Streaming output spec

Images streaming uses named SSE events and does not expose partial image payloads.

- generation emits `image_generation.completed`
- edits and variations emit `image_edit.completed`
- error emits `error`

Completed event payload includes:

```json
{
  "type": "image_generation.completed",
  "created_at": 0,
  "background": "auto",
  "output_format": "png",
  "quality": "auto",
  "size": "auto",
  "b64_json": "..."
}
```

If `response_format: "url"` is requested, the completed event contains `url` instead of `b64_json`.

## Anthropic Messages

### Input spec

The request body is a JSON object compatible with Anthropic Messages for the implemented subset.

| Field | Supported shape | Handling |
| --- | --- | --- |
| `model` | string | **Required**, as on the direct APIs. Absent, empty, whitespace-only, or non-string values return 400 `invalid_request_error` in the Anthropic error envelope (`{"type":"error","error":{"type","message"}}`), which carries no `param` or `code` — those are OpenAI-shape fields. Whether it selects the executed model depends on `modelSelection.honorRequestModel`; see Model execution. |
| `system` | string or content block array | Flattened into system-level text. |
| `messages` | array | Required. Each item must be an object. |
| `messages[].role` | `user`, `assistant` | `assistant` is preserved; other values normalize to `user`. |
| `messages[].content` | string or content block array | Text and image blocks are preserved. Tool blocks are flattened into conversation context. |
| `content[].type: "text"` | `{ text }` | Text is preserved. |
| `content[].type: "image"` | base64, URL, or file source | Base64 and URL are supported. File IDs are rejected before backend execution. |
| `content[].type: "tool_use"` | `{ id, name, input }` | Flattened into assistant tool-call context. |
| `content[].type: "tool_result"` | `{ tool_use_id, content }` | Flattened into tool-result context. |
| `tools` | array with `name`, `description`, `input_schema` | Preserved. |
| `tool_choice` | `{ type: "none" }`, `{ type: "any" }`, `{ type: "tool", name }` | Mapped to internal tool-choice modes. |
| `stream` | boolean | `true` enables Anthropic SSE events. |
| `max_tokens` | number | Passed to backend as max token hint. |
| `temperature` | number | Passed to backend as temperature hint. |

### Output spec

Non-streaming output follows Anthropic Messages shape:

```json
{
  "id": "msg_...",
  "type": "message",
  "role": "assistant",
  "model": "...",
  "content": [
    {
      "type": "text",
      "text": "..."
    }
  ],
  "stop_reason": "end_turn",
  "stop_sequence": null,
  "usage": {
    "input_tokens": 0,
    "output_tokens": 0
  }
}
```

When tool calls are returned, `content` contains `tool_use` blocks and `stop_reason` is `tool_use`. Tool arguments are parsed as JSON when possible; invalid JSON becomes `{ "input": "..." }`.

### Streaming output spec

Anthropic streaming uses named SSE events:

- `message_start`
- `content_block_start`
- `content_block_delta`
- `content_block_stop`
- `message_delta`
- `message_stop`
- `error`

Text deltas use `delta: { "type": "text_delta", "text": "..." }`. Tool input deltas use `delta: { "type": "input_json_delta", "partial_json": "..." }`.

## Usage contract

Usage fields prefer provider-reported CLI usage when available. Estimated usage is fallback only.

| Surface | Usage shape |
| --- | --- |
| OpenAI Chat | `prompt_tokens`, `completion_tokens`, `total_tokens`, `prompt_tokens_details.cached_tokens`, `completion_tokens_details.reasoning_tokens` |
| OpenAI Responses | `input_tokens`, `output_tokens`, `total_tokens`, `input_tokens_details.cached_tokens`, `output_tokens_details.reasoning_tokens` |
| OpenAI Images | Same as OpenAI Responses when local usage is available; otherwise provider/raw image usage is passed through. |
| Anthropic Messages | `input_tokens`, `output_tokens`, optional `cache_creation_input_tokens`, optional `cache_read_input_tokens` |

Anthropic cache creation/read tokens are folded into OpenAI `input_tokens` when an Anthropic-style backend usage object is rendered through an OpenAI-compatible surface.

## Error contract

OpenAI-compatible errors use:

```json
{
  "error": {
    "message": "...",
    "type": "invalid_request_error",
    "param": null,
    "code": null
  }
}
```

Anthropic-compatible errors use:

```json
{
  "type": "error",
  "error": {
    "type": "invalid_request_error",
    "message": "..."
  }
}
```

Backend provider-style JSON errors are parsed and forwarded with their status, type, message, param, and code where possible. For OpenAI Chat shape, backend param `reasoning.effort` is normalized to `reasoning_effort`.

## 구현 차이와 제약

This section is the explicit list of areas where implementation intentionally differs from a full direct OpenAI or Anthropic API.

| Area | Difference | Reason / expected behavior |
| --- | --- | --- |
| Runtime authority | Proxy runtime never calls direct provider APIs. | Local OAuth CLI auth is the product boundary. Direct provider calls belong only to benchmark/reference/direct-transport surfaces. |
| Codex text/tool transport | Default `codex-backend`; `app-server` remains available as a diagnostic transport. | The product proxy is hybrid: provider-compatible text/tool requests use `codex-backend`, while Images API and native local chat use Codex app-server. `codex-backend` calls ChatGPT Codex backend with the local Codex OAuth token and maps native Responses SSE text/function-call events back to the public proxy schema. It is not a direct OpenAI Platform API call. It refreshes access tokens through the Codex OAuth refresh endpoint and asks the user to re-authenticate only when the refresh token is expired, revoked, or already used. |
| Codex backend sampling hints | `codex-backend` does not forward `max_tokens` / `max_output_tokens` or `temperature` today. | The observed ChatGPT Codex backend route rejects `max_output_tokens`, and Codex's backend request schema does not include sampling fields. Use `--codex-transport app-server` only when diagnosing the older app-server text/tool path. |
| Model catalog | `GET /v1/models` reports the configured model, which is not necessarily the one that executes — with honouring off on `codex-backend` the request `model` runs while the list still shows what is configured. Off: the configured model alone. On: the configured model first, then the runtime's advertised catalogue — `codex debug models`, or the aliases `claude --model` documents (`fable`, `opus`, `sonnet`). In both modes a backend identifier (`codex-app-server`, `codex-backend`, `claude-code-cli`) is dropped from every position, so the list is empty when nothing else is known. Repeated slugs are collapsed to their first occurrence: `id` is the client's key for a model, so a list carrying one twice is malformed whatever the runtime meant by it. | The list is never hard-coded, so a new model generation appears without a code change. Codex entries are listed as advertised, including ones marked hidden or not API-supported, because honour-on validation accepts any advertised slug — the list and the gate agree. Claude version-pinned names (`claude-opus-5`, …) are not listed since the CLI does not enumerate them; a client may still name one and the CLI validates it. Identifiers are dropped because they name a transport, not a model a client can select — not because the proxy rejects them categorically; what a request naming one actually gets is the honour-mode behaviour in the two rows below. |
| Model execution (on) | With `modelSelection.honorRequestModel: true` every runtime behaves the same: the request `model` selects the model, and a model the runtime cannot run is rejected instead of silently replaced. The configured model is the default only for a caller that names none, which no HTTP request can be — `model` is required (see Input parity), so this branch exists for internal/direct backend callers alone. | HTTP 404 with `error.type: invalid_request_error`, `error.param: model`, `error.code: model_not_found` on the OpenAI surfaces; `error.type: not_found_error` on `/v1/messages`. Existence is decided per runtime: Codex against `codex debug models` (both Codex transports), Claude by the CLI's own `--model` refusal, recognised from the structured `error: "model_not_found"` wherever the CLI reports it — on the result event in 2.1.231, on the assistant event in 2.1.232 — or from the refusal sentence. **A Claude 404 from this proxy means "the runtime would not run this model", not "this model does not exist".** The CLI does not distinguish the two: probed against 2.1.232, a valid model (`haiku`) sent to an endpoint answering 404 to everything produced the same `error: "model_not_found"`, the same `api_error_status: 404`, and the same refusal sentence naming the real model. So if the CLI is routed through a gateway that 404s, every request is reported as a model problem; the runtime's own message is written to the proxy's stderr so an operator can see the real cause. An errored result carrying no model signal at all is never a `model_not_found`: before any bytes are written it is an HTTP 5xx carrying the runtime's message, and once a chunk is on the wire — where the status is already committed — it is an in-band error event. The OpenAI surfaces send `data: {"error":…}` and then `data: [DONE]`, with no `finish_reason`; `/v1/messages` sends `event: error` and ends there, since the Anthropic stream has no `[DONE]` and a `message_stop` would say the turn finished normally. That event keeps the mapped error type — `not_found_error` for a refusal, the provider's own type for a mapped provider error, `api_error` only when nothing maps — even though the HTTP status was committed as 200 before the failure was known. What it must never be is a finished 200 answer whose content is the error text; that was the original defect. The runtime's message is drawn only from fields documented to hold a diagnostic — `result`, `error`, `errors[]` — prefixed with the failure `subtype` when the runtime names one, and never a serialization of the result event, which carries `session_id`, cost and usage. Every client-visible `error.message`, on every surface and in every envelope, is bounded to 500 characters at the point it is serialized — not at each producer, which had already been missed once: a client-supplied model name is echoed into a refusal, so an oversized model produced an oversized 404. `errors[]` in particular is unrestricted text an upstream, gateway or hook can fill, and its size is not theirs to choose for the client. A failure with no provider mapping is answered in the envelope the caller used — `/v1/messages` gets the Anthropic shape with `error.type: api_error`, not the OpenAI body. The CLI's own stderr is never part of the message, and neither is an OS-level failure — `spawn /some/where/claude ENOENT` names a configured path. Both are operator-local: they go to the proxy's stderr, flattened to one bounded line, while the client gets a fixed description (`the local claude runtime failed to start`, `... exited (code=N signal=S)`). A refusal recognised from stderr — the only place the CLI's plain-text mode reports one — is accepted for a one-shot child, which is spawned per turn, and for a persistent child only until it has answered something. After that its model is demonstrably runnable, so a late sentence on stderr cannot mean the model is unknown; stdout and stderr are independent pipes with no ordering between them, so no amount of buffer-clearing could decide that by timing. The refusal is matched as the whole diagnostic the CLI prints, model name and all, not as a phrase appearing anywhere in a buffer — a hook echoing those words is not a refusal report. A child that dies while idle still produces the operator diagnostic even though no request is waiting; an intentional shutdown does not, and one failed child is reported once even though `error` and `close` both fire. When the Codex list cannot be collected the model is passed through rather than rejected, so a failed lookup does not become an outage. The collected list is cached (10 minutes on success, 30 seconds on failure), which is observable across requests: a slug added to the runtime after a successful collection is rejected until the entry expires, and one request's collection therefore decides what a later one may name. Restart the proxy to clear it. |
| Model execution (off, default) | Off is not one rule — it is each runtime's pre-existing model-execution behaviour, preserved exactly, and they differ. `codex-backend` (default transport): the request `model` wins, the configured-model fallback is unreachable over HTTP, and nothing is validated. `app-server` (diagnostic transport): the configured model wins; the request `model` applies only when no model is configured. `claude`: the configured model runs, and a request `model` is never forwarded — with no configured model the CLI's own default runs. | This asymmetry is why the switch exists. Turning it on is what makes the three paths agree; leaving it off guarantees no change to *which model executes*, not a coherent contract — and not an unchanged request surface: making `model` required (see Input parity) rejects bodies in both switch modes that earlier builds accepted. While off, an operator `--extra-arg --model`/`--fallback-model` is passed through untouched and, being appended last, can decide the model over the configured one — preserved because removing it would itself be a behaviour change. |
| Input parity for `model` | The proxy accepts exactly what the direct APIs accept: a required, non-empty string. There is no omitted-model default and no backend alias that means "no model chosen". | Earlier builds substituted a default for a missing or empty `model` and read backend identifiers (`codex-app-server`, `codex-backend`, `claude-code-cli`) as omission. Both made bodies succeed here that a direct API rejects, so both were removed. An identifier is now an ordinary model string, so it follows whatever rule the row above states for the runtime and mode — nothing about it is special-cased. With honouring on: 404 when the Codex catalogue does not list it (it would execute if the catalogue ever did, or if the lookup fails open), 404 when the Claude CLI refuses it. With honouring off it is not uniformly ignored: `codex-backend` forwards it as the model, `app-server` forwards it only when no model is configured, and `claude` alone ignores it. `GET /v1/models` stopped advertising the identifiers because they name a transport rather than a selectable model, so nothing invites a client to send one. |
| Model echo | With honouring on, streaming chunks report the model that actually runs, resolved before the stream starts. With it off the reporting is not uniform, and that is preserved rather than corrected: the non-streaming body — on both surfaces — reports the model the backend says it ran, while a stream opens with the request `model` and its closing chunk reports the executed one. A client keying on `chunk.model` therefore sees two values in one response. The echoed request model is returned verbatim and is not length-limited — it is the client's own string coming back to it, so it is neither truncated like an error message nor rejected for size. | Off-mode echo is preserved because correcting it would change what existing clients read back; the inconsistency is documented rather than fixed for the same reason. Turning the switch on is what makes the reported model trustworthy. |
| Access gate | Off unless `authKey` is configured; with it set, every request except the CORS preflight must present the key as `Authorization: Bearer <key>` or `x-api-key: <key>` — including `GET` routes. The two are alternatives: presenting one valid credential authorizes the request even if the other header is present and wrong, including repeated `x-api-key` lines, which arrive folded into one comma-joined value. A bare `Authorization: <key>` without the Bearer scheme is not a credential. Configuring `authKey` to an empty string is a configuration error and the proxy refuses the request rather than serving it unauthenticated. A rejection is 401 in the caller's own envelope: `invalid_request_error` / `code: invalid_api_key` on the OpenAI surfaces, `authentication_error` on `/v1/messages`. | This protects a tunnel-exposed personal proxy. It does not change how the local CLI authenticates — the CLI's own OAuth session is what reaches the provider — and leaving `authKey` unset leaves the proxy open, which is the default for a localhost listener. |
| Images `model` is a separate namespace | `modelSelection.honorRequestModel` does not apply to `/v1/images/*`. Those requests carry an Images API model (`image-2`, `dall-e-2`, `gpt-image-*`), which is a route selector, not a Codex model slug. | The Codex model that actually runs an image turn is `codexProxy.imageModel`. Feeding the request `model` to the image backend would send `image-2` where a Codex slug belongs. Image model values keep their own validation (`response_format` rejection for `gpt-image-*`; `image-2` rejects `background: transparent` and `input_fidelity`, both as `image_generation_user_error`). Variations accept `dall-e-2` and the local `image-2` route; other Images models are rejected there. `n` is an integer in 1..10 on every route, and a numeric string is accepted because `/v1/images/*` also takes multipart/form-data, where every field arrives as a string — an explicit `null` is a value the client chose and is rejected. Further documented rejections, each a 400: `output_compression` below 100 requires `jpeg` or `webp` (`invalid_png_output_compression`); `background: transparent` requires a format carrying alpha; `input_fidelity` is edits-only; `style` is generations-only. These are model- or operation-scoped, not route-scoped — an `image-2` edit is rejected for a transparent background exactly as a generation is. |
| Request isolation | Each API request is its own conversation, on both the persistent and one-shot routes and for requests in flight at the same time — a persistent turn is serialized end to end, so overlapping requests queue rather than share a child. The Claude runtime holds one in the process that serves it, so that process is retired between requests rather than reset in place. | The reset used to be a `/clear` message, which the same spawn disables with `--disable-slash-commands` — the CLI answers `/clear isn't available in this environment`, so it never happened, and every request after the first was another turn of the previous one's conversation. Verified end to end against 2.1.232 before and after the change: a second request could read back a value that appeared only in the first request's body, and now cannot. Dropping the flag would make `/clear` work and would also let a client's prompt invoke slash commands, which is what the flag prevents; retiring the process costs one spawn per request, which the one-shot path already pays. |
| Generated image URLs | With `response_format: url` the proxy returns a link to `GET /v1/images/generated/<id>` served from memory. The id is a random UUID, the entry expires, and the store does not survive a restart. An unknown or expired id is a 404 `invalid_request_error`; the two are deliberately indistinguishable. The access gate applies to this route like any other. | The bytes never leave the machine, and nothing about the id is derived from the request, so one caller cannot enumerate or guess another's. |
| Ambient context | Codex proxy runs in an isolated temp home/workspace with project context sources disabled. | User request text is preserved; hidden local project context is intentionally removed. |
| Instruction handling | OpenAI Chat `system`/`developer` and Responses `instructions` can be lifted into backend thread instructions. | This preserves API roles while fitting CLI backend mechanics. |
| Unknown roles | Some unknown roles normalize to `user` instead of provider-style validation failure. | Current normalizer is permissive for compatibility with local tools. |
| `file_id` images | Parsed but rejected before backend execution. | Local CLI proxy cannot fetch provider file storage. Use URL, data URL, base64, or multipart image input. |
| Images `image-2` | `image-2` is implemented through local Codex `gpt-5.5` backend Responses `image_generation`. | This is the formal local proxy route, not direct OpenAI `image-2` execution. `codexProxy.imageTransport` can select `app-server` for diagnostics/fallback. |
| Images quality mapping | `quality: low -> effort/tool quality low`, `medium/standard -> medium`, `high/hd/auto/omitted -> high`. | Maps Images API quality intent to local Codex image-generation effort and backend tool controls. |
| Images proxy route hints | `x_proxy_image_route` is accepted as a local extension only. | It is excluded from provider parity benchmarks and included only in proxy enhanced benchmarks. |
| Images flat/vector references | Flat/vector reference-style PNG outputs may be postprocessed with deterministic edge-preserving flattening. | This reduces gradients/background shading while preserving small accent colors, outlines, and antialiasing. It only applies to flat/vector reference-style PNG requests and does not call direct provider APIs. |
| Images `input_fidelity` | Disabled for `image-2`. | Treated as current `image-2` field capability, not as quality failure. |
| Images partial streaming | `partial_images > 0` is rejected. Partial backend events are not forwarded. | Public proxy stream exposes completed images only. |
| Images variations | JSON image input is rejected; multipart image upload is required. | Matches the implemented Images API form-data contract. |
| GPT image `response_format` | `response_format` is rejected for `gpt-image-*` models. | Mirrors provider-style parameter compatibility for GPT image models. |
| URL images | `response_format: "url"` returns local ephemeral URLs under the proxy. | Generated image bytes are stored in-memory for about one hour. |
| Token accounting | Provider CLI usage is preferred; estimated usage is fallback. | Local CLIs do not always provide complete provider token details. |
| Audio and embeddings | Not implemented. | Outside current compatible subset. |

## Verification authority

| Contract area | Tests / benchmark authority |
| --- | --- |
| OpenAI/Anthropic HTTP shapes | `test/proxy-http.test.mjs` |
| Input normalization | `test/normalizers.test.mjs` |
| Image route translation | `test/image2-via-gpt55.test.mjs`, image rows in `scripts/api-comparison-benchmark.mjs` |
| Tool streaming deltas | `test/tool-call-stream.test.mjs`, stream tests in `test/proxy-http.test.mjs` |
| Runtime boundary | `scripts/verify-runtime-boundary.mjs` |
| Provider parity and quality | `docs/api-benchmark-design.md` and `scripts/api-comparison-benchmark.mjs` |
