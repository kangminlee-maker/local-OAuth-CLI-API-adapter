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
| `model` | string | **Required**, as on the direct APIs. Absent, empty, whitespace-only, or non-string values return 400 `invalid_request_error` with `param: model`. Whether it selects the executed model depends on `modelSelection.honorRequestModel`; see Model execution. |
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
| Model catalog | With `modelSelection.honorRequestModel` off, `GET /v1/models` returns the single executed model. With it on, it returns what the runtime advertises: the Codex catalogue from `codex debug models`, or the aliases `claude --model` documents (`fable`, `opus`, `sonnet`). The executed model is listed first. | The list is never hard-coded, so a new model generation appears without a code change. Codex entries are listed as advertised, including ones marked hidden or not API-supported, because validation accepts any advertised slug — the list and the gate agree. Claude version-pinned names (`claude-opus-5`, …) are not listed since the CLI does not enumerate them; a client may still name one and the CLI validates it. |
| Model execution (on) | With `modelSelection.honorRequestModel: true` every runtime behaves the same: the request `model` selects the model, the configured model is the default for requests that name none, and a model the runtime cannot run is rejected instead of silently replaced. | HTTP 404 with `error.type: invalid_request_error`, `error.param: model`, `error.code: model_not_found` on the OpenAI surfaces; `error.type: not_found_error` on `/v1/messages`. Existence is decided per runtime: Codex against `codex debug models` (both Codex transports), Claude by the CLI's own `--model` refusal. When the Codex list cannot be collected the model is passed through rather than rejected, so a failed lookup does not become an outage. |
| Model execution (off, default) | Off is not one rule — it is each runtime's pre-existing behaviour, preserved exactly, and they differ. `codex-backend` (default transport): the request `model` wins, the configured model is the fallback, and nothing is validated. `app-server` (diagnostic transport): the configured model wins; the request `model` applies only when no model is configured. `claude`: the configured model runs, and a request `model` is never forwarded — with no configured model the CLI's own default runs. | This asymmetry is why the switch exists. Turning it on is what makes the three paths agree; leaving it off guarantees no behaviour change, not a coherent contract. While off, an operator `--extra-arg --model`/`--fallback-model` is passed through untouched and, being appended last, can decide the model over the configured one — preserved because removing it would itself be a behaviour change. |
| Input parity for `model` | The proxy accepts exactly what the direct APIs accept: a required, non-empty string. There is no omitted-model default and no backend alias that means "no model chosen". | Earlier builds substituted a default for a missing or empty `model` and read backend identifiers (`codex-app-server`, `codex-backend`, `claude-code-cli`) as omission. Both made bodies succeed here that a direct API rejects, so both were removed. `GET /v1/models` no longer advertises those identifiers either — advertising a value the proxy rejects would be a contract a client cannot follow. |
| Model echo | With honouring on, streaming chunks report the model that actually runs, resolved before the stream starts. With it off, the response `model` carries the request `model` as it always has. | Off-mode echo is preserved rather than corrected because correcting it would change what existing clients read back. Turning the switch on is what makes the reported model trustworthy. |
| Images `model` is a separate namespace | `modelSelection.honorRequestModel` does not apply to `/v1/images/*`. Those requests carry an Images API model (`image-2`, `dall-e-2`, `gpt-image-*`), which is a route selector, not a Codex model slug. | The Codex model that actually runs an image turn is `codexProxy.imageModel`. Feeding the request `model` to the image backend would send `image-2` where a Codex slug belongs. Image model values keep their own validation (`response_format` rejection for `gpt-image-*`, `dall-e-2`-only variations). |
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
