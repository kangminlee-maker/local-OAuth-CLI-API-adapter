# 적합성 매트릭스 — direct API 표면 열거

> 이 문서는 `docs/conformance-suite-design.md` §2의 매니페스트가 될 원자료다. 2026-08-28에
> 작성됐고, 셀마다 증거 등급이 붙어 있다: **DOC**(provider 문서) / **CODE**(우리 코드) /
> **VERIFIED**(와이어 관찰). 현재 DOC 84 · DOC?(값 미상) 28 · VERIFIED 26 · VERIFIED-weak 9 ·
> CODE 1 = 148행이며, **「생략 시 기본값」이 VERIFIED인 행은 0개다.** 그것이 §6 프로브 계획이
> 존재하는 이유다. 이 문서를 읽을 때 등급 없는 값을 사실로 취급하지 말 것.


Author: conformance-spec agent · Date: 2026-08-28 · Repo state: `main` @ `8651b93` + uncommitted `local-OAuth-CLI-API-adapter/`
Repo read-only. **No paid API calls were made.** Every provider fact below is documentation- or archive-sourced; nothing in this document was observed on the wire by me.

---

## 0. Scope confirmation (and one correction to the packet)

Confirmed from `docs/api-interface-contract.md:10-18` (Supported surfaces table). The packet's list is correct but **incomplete by one surface**:

| Surface | Endpoint | Contract line | In packet? |
| --- | --- | --- | --- |
| OpenAI Chat Completions | `POST /v1/chat/completions` | `api-interface-contract.md:15` | yes |
| OpenAI Responses | `POST /v1/responses` | `:16` | yes |
| OpenAI Images | `POST /v1/images/generations`, `/edits`, `/variations` | `:17` | yes |
| Anthropic Messages | `POST /v1/messages` | `:18` | yes |
| **OpenAI Models** | **`GET /v1/models`** | **`:14`** | **no — missing** |

`GET /v1/models` is a claimed provider-compatible surface with real divergence already documented (`:405` ff., "Model catalog" row: the list reports the *configured* model, which is not necessarily the one that executes). It has **zero benchmark cases** (§0.2). I have not built a field matrix for it — it has no request body — but its response shape belongs in the conformance suite and it is listed in the probe plan (P-31).

Two more scope notes the packet did not state:

- `POST /v1/messages/count_tokens` is a documented Anthropic surface that clients (including the Anthropic SDKs' token-counting helpers) call. The contract does not claim it, and the proxy does not serve it, so a client hitting it gets `404 Unknown endpoint` (`:405` ff., "Method and path dispatch"). Out of matrix scope; flagged as a known client-visible gap.
- The proxy serves a **proxy-only** surface not on either provider: `GET /v1/images/generated/{id}` (`http-server.ts:1314`), the target of `response_format: "url"`. It has no provider counterpart and cannot diverge; noted for completeness.

### 0.1 What "our verification authority" actually is today

`docs/api-interface-contract.md:452-461` names the authority. Measured against `bench-results/*.json` (39 files, all rows unioned):

- **78 distinct benchmark case ids**: `openai.images` 26, `openai.chat` 19, `anthropic.messages` 17, `openai.responses` 16.
- **40 of the 78** (10 semantic questions × 4 surfaces) are `*.semantic_quality.*` — the hand-written questions the packet refers to.
- The remaining 38 are `schema_exact` shape rows.
- **`bench-results/*.json` stores no raw provider response bodies.** A row keeps `{target, case, ok, totalMs, sample:{text, usage}}` (`bench-results/bench-provider-parity-direct-20260622.json`, row 0). The `usage` object *is* a captured direct-API body fragment — the only wire evidence about a provider that exists in this repo.

So: the repo's total wire-level knowledge of the direct APIs is (a) assertion outcomes of 38 shape cases, and (b) captured `usage` sub-objects. **Not one request-field default has ever been observed.** That is the gap this document is written to close.

### 0.2 Coverage holes in the current authority, from the case list

- `GET /v1/models`: 0 cases, either target.
- Anthropic direct-API rows exist for only 7 cases; every one of them shows **both `ok:true` and `ok:false` across runs** in the archive — the Anthropic direct target is flaky in this harness and its greens are not stable evidence.
- `stream_options.include_obfuscation` is sent to the **direct API only** (`scripts/api-comparison-benchmark.mjs:861`: `stream_options: isApi ? { include_obfuscation: false } : undefined`), so the proxy's handling of it has never been compared to anything.
- `assertOpenAiResponsesStreamShape` (`scripts/api-comparison-benchmark.mjs:2928-2944`) asserts required event types and monotonic `sequence_number` — it **does not assert the stream terminator**. The chat assertion does (`:610`, `assert(response.done, ...)`). So `[DONE]` on `/v1/responses` is unasserted on both sides. See P-2; this is the single highest-risk row in the document.

---

## Method and evidence legend

**Sources, in the order the packet specified.**

1. Provider documentation via Context7 MCP, retrieved 2026-08-28:
   - `/openapi/app_stainless_api_spec_documented_openai_openapi_documented_yml` — OpenAI's documented OpenAPI spec (`CreateChatCompletionRequest`, `CreateResponse`, `CreateImageRequest`, `CreateImageEditRequest`, `CreateImageVariationRequest`, `ImagesResponse`).
   - `/websites/developers_openai_api_reference` — streaming-event reference and worked SSE transcripts.
   - `/websites/platform_claude_en_api` — Messages API and the error-code table.
2. `docs/api-interface-contract.md` — our claim, checked, never treated as provider authority.
3. `src/proxy/normalizers.ts`, `src/proxy/http-server.ts`, `scripts/api-comparison-benchmark.mjs`, `bench-results/*.json` — our behavior only.

**Evidence class (column 7)** grades the *provider-side* cells (columns 2-5) of the row. Column 6 is always CODE-cited and is not what the class describes.

| Class | Means |
| --- | --- |
| `VERIFIED` | Observed on the wire against the direct API, with a citation to the case and result file. **Scoped to exactly what was asserted** — in every case here that is "the field was accepted and the asserted response shape came back", never "the omitted default was X". |
| `DOC` | Provider documentation states it. A doc-sourced default is DOC. |
| `DOC?` | Provider documentation covers the field but is silent or ambiguous on the cell — column 3 reads `UNKNOWN`. |
| `CODE` | No provider evidence exists (proxy-only extension, or provider behavior inferable only from our own code — which is not evidence about the provider). |

**Instrument caveat on defaults, stated once and applying to every DOC default below.** The Context7 rendering of the OpenAI OpenAPI spec collapses the YAML's `default:` and `example:` keys into a single `(example: …)` annotation. Where I record e.g. `temperature` default `1`, that is the spec's rendered scalar and matches OpenAI's long-published default, but **I could not distinguish `default: 1` from `example: 1` in the retrieved text**. Every such cell is marked `DOC` and is a probe candidate; none is `VERIFIED`. Anthropic's docs state fewer defaults still, which is why Anthropic carries most of this document's `UNKNOWN`s.

**Column 6 vocabulary.** `supported` = read and acted on. `validated-rejected` = the proxy 400s an invalid value. `silently ignored` = accepted into the body, never read, no error, no effect. `not applicable` = the field cannot mean anything on a local-CLI backend. `divergent` = implemented but demonstrably unlike the provider.

---

## 1. OpenAI Chat Completions — `POST /v1/chat/completions`

50 rows.

| # | Field / JSON path | Type & accepted values | Provider default when omitted | Observable effect on response | Invalid-value error (status / type / param / code) | This proxy | Ev |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `model` | string, required | none — required | `choices[].message` content quality; echoed in `model` | 400 / `invalid_request_error` / `model` / `model_not_found` (404 on some paths) | supported; required non-empty string, `normalizers.ts:27` `readRequiredModel`; contract `:28` | VERIFIED (accepted: `openai.chat.text.schema_exact` vs `openai-api`, `bench-provider-parity-direct-20260622.json`) |
| 2 | `messages` | array, `minItems: 1`, required | none — required | the conversation | 400 / `invalid_request_error` / `messages` / — | supported; empty array 400 `normalizers.ts:303` | VERIFIED (same row) |
| 3 | `messages[].role` | `developer`\|`system`\|`user`\|`assistant`\|`tool`\|`function`(dep.) | none — required, schema discriminator | selects message schema | 400 / `invalid_request_error` / `messages[i].role` / `missing_required_parameter` when absent | supported, all six; `function`→tool; unknown 400 with param+code `normalizers.ts:330-352` | DOC |
| 4 | `messages[].content` | string \| content-part array (`text`, `image_url`, `input_audio`, `file`); nullable on assistant-with-tool_calls and on `function` | none — required except those cases | text and image inputs reach the model | 400 / `invalid_request_error` / `messages[i].content` / — | supported for `text` + `image_url`; `input_audio`/`file` parts: **UNKNOWN handling — not in the contract table (`:34`) and not enumerated in `flattenOpenAiMessage`**; probe P-33 | VERIFIED for text+image (`openai.chat.image.schema_exact`, `openai.chat.multi_image.schema_exact`) |
| 5 | `messages[].name` | string | absent | participant disambiguation inside the prompt | UNKNOWN | **silently ignored** — `readOpenAiMessages` reads only `role`/`content` (`normalizers.ts:306-317`) | DOC? |
| 6 | `messages[].tool_calls` | array of `{id, type:"function", function:{name, arguments}}` | absent | prior assistant tool turn replayed | UNKNOWN | supported — flattened into context via `ASSISTANT_TOOL_CALL_MARKER`; contract `:36` | VERIFIED (`openai.chat.tool_result.schema_exact`) |
| 7 | `messages[].tool_call_id` | string, required on `role:"tool"` | none on tool role | binds result to call | 400 / `invalid_request_error` / `messages[i].tool_call_id` / — | supported; contract `:37` | VERIFIED (same row) |
| 8 | `messages[].function_call` | `{name, arguments}` (deprecated) | absent | legacy tool turn | UNKNOWN | supported as a content-optional assistant turn (`normalizers.ts:354-357` comment) | DOC |
| 9 | `messages[].refusal` | string, assistant input | absent | replays a prior refusal | UNKNOWN | **silently ignored** | DOC? |
| 10 | `messages[].audio` | `{id}`, assistant input | absent | replays prior audio turn | UNKNOWN | **silently ignored** | DOC? |
| 11 | `modalities` | array of `text`\|`audio` | `["text"]` | adds `message.audio` to the response | UNKNOWN | **silently ignored** — `["text","audio"]` yields a text-only body with no error | DOC |
| 12 | `audio` | `{voice, format}`; required when `modalities` includes `audio` | absent | audio bytes in `message.audio.data` | 400 / `invalid_request_error` / `audio` / — | **silently ignored** | DOC |
| 13 | `temperature` | number 0-2 | `1` (see instrument caveat) | sampling spread | 400 / `invalid_request_error` / `temperature` / `unsupported_value` on reasoning models that fix it at 1 | parsed into `NormalizedRequest.temperature` (`normalizers.ts:30`) but **`codex-backend` does not forward it** (contract `:405` ff., "Codex backend sampling hints") → effectively ignored on the default transport | DOC |
| 14 | `top_p` | number 0-1 | `1` (caveat) | nucleus cutoff | 400 / `invalid_request_error` / `top_p` / — | **silently ignored** — not read anywhere | DOC |
| 15 | `n` | integer ≥1 | `1` (caveat) | `choices` array length | 400 / `invalid_request_error` / `n` / — (and `n>1` unsupported on some models) | **silently ignored** — `n:5` returns exactly one choice, no error. `choices` is hard-coded to a single element (`http-server.ts:1795-1820`) | DOC |
| 16 | `stop` | string \| array (≤4) \| null | `null` | truncates output at the sequence; `finish_reason:"stop"` | 400 / `invalid_request_error` / `stop` / — | **silently ignored** | DOC |
| 17 | `max_tokens` | integer (deprecated) | model max | caps output; `finish_reason:"length"` | 400 / `invalid_request_error` / `max_tokens` / `unsupported_parameter` on o-series | parsed (`normalizers.ts:29`, `max_tokens ?? max_completion_tokens`) but **not forwarded by `codex-backend`** | DOC |
| 18 | `max_completion_tokens` | integer | model max | as above, counts reasoning tokens | 400 / `invalid_request_error` / `max_completion_tokens` / — | same as row 17 | DOC |
| 19 | `presence_penalty` | number -2..2 | `0` (caveat) | topic novelty | 400 / `invalid_request_error` / `presence_penalty` / — | **silently ignored** | DOC |
| 20 | `frequency_penalty` | number -2..2 | `0` (caveat) | repetition | 400 / `invalid_request_error` / `frequency_penalty` / — | **silently ignored** | DOC |
| 21 | `logit_bias` | map token-id → -100..100 | `null` | token ban/boost | 400 / `invalid_request_error` / `logit_bias` / — | **silently ignored** | DOC |
| 22 | `logprobs` | boolean | `false` (caveat) | populates `choices[].logprobs` | 400 / `invalid_request_error` / `logprobs` / — | **silently ignored** — response always carries no `logprobs` key at all (`http-server.ts:1795-1820`); provider emits `logprobs: null` | DOC |
| 23 | `top_logprobs` | integer 0-20; requires `logprobs:true` | `null` | per-token alternatives | 400 / `invalid_request_error` / `top_logprobs` / — | **silently ignored** | DOC |
| 24 | `seed` | integer (Beta) | `null` | best-effort determinism; `system_fingerprint` | 400 / `invalid_request_error` / `seed` / — | **silently ignored**; `system_fingerprint` is hard `null` (`http-server.ts:1822`) | DOC |
| 25 | `stream` | boolean | `false` | SSE chunks vs JSON body | 400 / `invalid_request_error` / `stream` / — | supported; `input.stream === true` strictly (`normalizers.ts:34`) — note a string `"true"` is treated as false, no error | VERIFIED (`openai.chat.stream.schema_exact`) |
| 26 | `stream_options.include_usage` | boolean | `false` | extra final chunk with `choices: []` + `usage`; other chunks carry `usage: null` | 400 / `invalid_request_error` / `stream_options` / — (400 if set without `stream:true`) | supported (`http-server.ts:2227-2234`) | VERIFIED (`openai.chat.stream_usage.schema_exact` vs `openai-api`; asserts final-usage shape **and** the `[DONE]` terminator, `benchmark:610-611`) |
| 27 | `stream_options.include_obfuscation` | boolean | `true` (obfuscation fields present by default) | adds `obfuscation` string to delta events | UNKNOWN | supported; defaults true unless explicitly false (contract `:41`); emits `obfuscation` (`http-server.ts:2233`) | DOC |
| 28 | `response_format` | `{type:"text"\|"json_object"\|"json_schema"}` | `{"type":"text"}` | forces JSON / schema-valid output | 400 / `invalid_request_error` / `response_format` / — | supported for `json_object` + `json_schema` (`normalizers.ts:35-38`); `strict` and schema `name` parsed | VERIFIED (`openai.chat.json_schema.schema_exact`) |
| 29 | `tools` | array of `{type:"function", function:{name, description, parameters, strict}}` | `[]` / absent | enables `message.tool_calls`, `finish_reason:"tool_calls"` | 400 / `invalid_request_error` / `tools[i].function.name` / — | supported (name/description/parameters preserved); contract `:38` | VERIFIED (`openai.chat.tool_call.schema_exact`) |
| 30 | `tools[].function.strict` | boolean | `false` | strict schema adherence on arguments | UNKNOWN | **UNKNOWN — parsed for `response_format` (`normalizers.ts:38`) but not confirmed read off tool definitions**; probe P-34 | DOC |
| 31 | `tool_choice` | `"none"`\|`"auto"`\|`"required"`\|`{type:"function", function:{name}}` | `"auto"` when tools present, `"none"` when absent | forces / suppresses a call | 400 / `invalid_request_error` / `tool_choice` / — | **divergent**: mapped for the four known forms, but *any other value silently defaults to `auto`* (contract `:39`) where the provider 400s | DOC |
| 32 | `parallel_tool_calls` | boolean | `true` | allows >1 call per turn | 400 / `invalid_request_error` / `parallel_tool_calls` / — | **silently ignored** on chat | DOC |
| 33 | `functions` | array (deprecated) | absent | legacy tool list | 400 / `invalid_request_error` / `functions` / — | **UNKNOWN — `readOpenAiTools` reads `tools` only**; treat as silently ignored | DOC |
| 34 | `function_call` | `"none"`\|`"auto"`\|`{name}` (deprecated) | `"auto"` with `functions` | legacy forcing | 400 / `invalid_request_error` / `function_call` / — | **silently ignored** | DOC |
| 35 | `user` | string (superseded) | absent | cache bucketing / abuse signal | UNKNOWN | **silently ignored** on chat (echoed only on Responses) | DOC |
| 36 | `safety_identifier` | string ≤64 | absent | abuse detection bucket | UNKNOWN | **silently ignored** on chat | DOC |
| 37 | `prompt_cache_key` | string | absent | raises `usage.prompt_tokens_details.cached_tokens` | UNKNOWN | **silently ignored** on chat; the proxy caches nothing of its own (contract `:405` ff., "Prompt caching") | DOC |
| 38 | `prompt_cache_retention` | `"in_memory"`\|`"24h"` (deprecated) | **org-dependent: `24h` without ZDR, `in_memory` with ZDR** | cache lifetime | 400 / `invalid_request_error` / `prompt_cache_retention` / — | **silently ignored** on chat. (On Responses the proxy *hard-codes* `"24h"` in the echo — row R-35.) | DOC |
| 39 | `prompt_cache_options` | `{ttl:"30m", mode:"implicit"\|"explicit"}` | `ttl:"30m"`, `mode:"implicit"` | explicit cache breakpoints | UNKNOWN | **silently ignored** | DOC |
| 40 | `service_tier` | `auto`\|`default`\|`flex`\|`scale`\|`priority` | `"auto"` (resolves to project setting, usually `default`) | echoed as the tier actually used; latency/pricing | 400 / `invalid_request_error` / `service_tier` / — | **divergent**: request ignored; response always `service_tier:"default"` (`http-server.ts:1821`) | DOC |
| 41 | `store` | boolean | `false` | retention for distillation/evals | UNKNOWN | **silently ignored** on chat | DOC |
| 42 | `metadata` | map, ≤16 pairs, key ≤64 / value ≤512 | `null` | stored alongside a stored completion | 400 / `invalid_request_error` / `metadata` / — | **silently ignored** on chat | DOC |
| 43 | `reasoning_effort` | `none`\|`minimal`\|`low`\|`medium`\|`high`\|`xhigh`\|`max` | model-dependent (**UNKNOWN per-model**) | `usage.completion_tokens_details.reasoning_tokens`, latency | 400 / `invalid_request_error` / `reasoning_effort` / — | **divergent enum**: proxy accepts `none`…`xhigh` and **400s on `max`**, which the provider documents as valid (`normalizers.ts:76-88` vs spec enum) | DOC |
| 44 | `reasoning.effort` (on chat) | same enum | n/a — **not a Chat Completions field** | — | provider: 400 unknown parameter (expected) | **proxy extension**: accepted as an alternate source (`normalizers.ts:31`, contract `:43`). A body the provider rejects succeeds here. | DOC |
| 45 | `verbosity` | `low`\|`medium`\|`high` | `medium` (**UNKNOWN — spec states no default**) | output length | 400 / `invalid_request_error` / `verbosity` / — | supported (`normalizers.ts:32`) | DOC? |
| 46 | `text.verbosity` (on chat) | same enum | n/a — **not a Chat Completions field** | — | provider: 400 unknown parameter (expected) | **proxy extension**, same class as row 44 (contract `:45`) | DOC |
| 47 | `prediction` | `{type:"content", content}` | absent | speculative decoding; `usage.completion_tokens_details.accepted/rejected_prediction_tokens` | 400 / `invalid_request_error` / `prediction` / — | **silently ignored**; the usage sub-keys are emitted as `0` regardless (`openAiChatUsage`) | DOC |
| 48 | `web_search_options` | `{user_location, search_context_size}` | absent | adds web-search tool call + citations to `annotations` | 400 / `invalid_request_error` / `web_search_options` / — | **not applicable / silently ignored**; `annotations` is hard `[]` (`http-server.ts:1806`) | DOC |
| 49 | `moderation` | `{model, policy:{input:{mode}, output}}` | absent | moderated output / refusals | 400 / `invalid_request_error` / `moderation` / — | **silently ignored**; `refusal` hard `null` | DOC |
| 50 | *(behavioral)* unknown top-level field, e.g. `{"foo":1}` | — | — | — | OpenAI: **400 / `invalid_request_error` / `foo` / `unknown_parameter`** — believed, unconfirmed | **silently ignored on every text surface.** The only `unknown_parameter` the proxy raises anywhere is Images `response_format` (`http-server.ts:588-593`) | DOC? |

---

## 2. OpenAI Responses — `POST /v1/responses`

41 rows.

| # | Field / JSON path | Type & accepted values | Provider default when omitted | Observable effect | Invalid-value error | This proxy | Ev |
| --- | --- | --- | --- | --- | --- | --- | --- |
| R-1 | `model` | string | **spec marks it NOT required** (unlike chat) — behavior when omitted is UNKNOWN | selects model; echoed | 400 or 404 / `invalid_request_error` / `model` / `model_not_found` | **divergent**: proxy makes it required and 400s on absence (contract `:107`), citing "as on the direct APIs" — the documented Responses schema does not list `model` as required | DOC? |
| R-2 | `input` (string form) | string | absent (may be omitted with `prompt`/`previous_response_id`) | becomes a `user` turn | 400 / `invalid_request_error` / `input` / — | supported (`normalizers.ts:50`) | VERIFIED (`openai.responses.text`) |
| R-3 | `input` (array form) | array of typed items | as above | full conversation replay | 400 / `invalid_request_error` / `input[i]` / — | supported; primitives 400 (contract `:109`) | VERIFIED (`openai.responses.tool_call`) |
| R-4 | `input[].role` | `system`\|`developer`\|`user`\|`assistant` | required on message items only | message semantics | 400 / `invalid_request_error` / `input[i].role` / — | supported; missing/unknown 400 (contract `:110`) | DOC |
| R-5 | `input[].content` | string \| object \| parts (`input_text`, `input_image`, `input_file`) | required on message items | text + image inputs | 400 / `invalid_request_error` / `input[i].content` / — | `input_text` + `input_image` supported; `input_file` handling UNKNOWN (probe P-33) | VERIFIED for text+image (`openai.responses.image.schema_exact`, `…multi_image…`) |
| R-6 | `input[].type` | `message`, `function_call`, `function_call_output`, `reasoning`, `item_reference`, … (open union) | absent = message item | item semantics | 400 for a *known-invalid* type; unknown strings: UNKNOWN | **deliberately lenient**: non-string type 400, unknown string types accepted (contract `:110`) — documented, defensible, unverified against the provider | DOC? |
| R-7 | `instructions` | string | `null` | system-level steering; echoed in `instructions` | UNKNOWN | supported; prepended as a `system` message (`normalizers.ts:48-51`) | DOC |
| R-8 | `max_output_tokens` | integer | `null` (model max) | caps output; `status:"incomplete"` + `incomplete_details.reason:"max_output_tokens"` | 400 / `invalid_request_error` / `max_output_tokens` / — | parsed but **not forwarded by `codex-backend`**; echoed in the body. **`incomplete_details` is hard `null` (`http-server.ts:2004`) and `status` never becomes `incomplete`** → a capped turn is reported `completed` | DOC |
| R-9 | `max_tool_calls` | integer | `null` | caps built-in tool calls | UNKNOWN | **silently ignored**; echoed as hard `null` (`http-server.ts:2007`) | DOC |
| R-10 | `temperature` | number 0-2 | `1` (caveat; confirmed by the doc's SSE transcript showing `"temperature":1.0`) | sampling | 400 / `invalid_request_error` / `temperature` / — | parsed, not forwarded; echoed as `request.temperature ?? 1` (`http-server.ts:2021`) | DOC |
| R-11 | `top_p` | number 0-1 | `1` (doc SSE transcript shows `"top_p":1.0`) | nucleus | 400 / `invalid_request_error` / `top_p` / — | **divergent, client-visible**: ignored, and echoed as **`0.98`** when omitted (`http-server.ts:2025` `numberOrDefault(raw.top_p, 0.98)`) where the provider echoes `1` | DOC |
| R-12 | `top_logprobs` | integer 0-20 | `null` (doc) | logprobs on output text | 400 / `invalid_request_error` / `top_logprobs` / — | ignored; echoed as **`0`** (`http-server.ts:2024`) where the provider echoes `null` | DOC |
| R-13 | `stream` | boolean | `false` | named SSE events | 400 / `invalid_request_error` / `stream` / — | supported | VERIFIED (`openai.responses.stream`) |
| R-14 | `stream_options.include_obfuscation` | boolean | `true` | `obfuscation` on delta events | UNKNOWN | parsed via the shared reader (`normalizers.ts:64`) | DOC |
| R-15 | `stream_options.include_usage` | — | **not a documented Responses field** (the Responses `stream_options` object documents only `include_obfuscation`) | — | provider: UNKNOWN — likely 400 unknown parameter | **proxy extension**: parsed and honored (contract `:117`). Responses `usage` is on `response.completed` regardless | DOC? |
| R-16 | `text.format` | `{type:"text"\|"json_object"\|"json_schema", name, schema, strict}` | `{"type":"text"}` | structured output | 400 / `invalid_request_error` / `text.format` / — | supported (`normalizers.ts:65-68`) | DOC |
| R-17 | `text.verbosity` | `low`\|`medium`\|`high` | `medium` (**UNKNOWN**) | output length | 400 / `invalid_request_error` / `text.verbosity` / — | supported | DOC? |
| R-18 | `tools` | array; `function` tools plus **built-ins** (`web_search`, `file_search`, `code_interpreter`, `image_generation`, `computer_use`, `mcp`) | `[]` | tool calls in `output` | 400 / `invalid_request_error` / `tools[i]` / — | **function tools only**; built-in and MCP tool entries are UNKNOWN — probably dropped silently by `readOpenAiTools`, so a `web_search` request runs as a plain turn (P-35) | VERIFIED for function tools (`openai.responses.tool_call`) |
| R-19 | `tool_choice` | `"none"`\|`"auto"`\|`"required"`\|`{type:"function", name}`\|`{type:"<builtin>"}` | `"auto"` | forcing | 400 / `invalid_request_error` / `tool_choice` / — | mapped; unknown values fall back to `auto` (same divergence as chat row 31); echoed via `responseToolChoice` | DOC |
| R-20 | `parallel_tool_calls` | boolean | `true` | >1 call per turn | 400 / `invalid_request_error` / `parallel_tool_calls` / — | **divergent**: ignored **and** echoed as a hard `true` (`http-server.ts:2011`) even when the client sent `false` | DOC |
| R-21 | `reasoning.effort` | `none`…`max` | model-dependent; doc SSE transcript shows `"effort":null` echoed for a non-reasoning model | reasoning tokens, latency | 400 / `invalid_request_error` / `reasoning.effort` / — | supported minus `max` (same enum divergence as chat row 43) | DOC |
| R-22 | `reasoning.summary` | `auto`\|`concise`\|`detailed` | `null` | adds `summary` parts to the `reasoning` output item | 400 / `invalid_request_error` / `reasoning.summary` / — | **silently ignored** — the proxy never emits reasoning summaries; a client that asked for `detailed` gets an empty/absent summary with no error | DOC |
| R-23 | `reasoning.context` | `auto`\|`current_turn`\|`all_turns` | UNKNOWN (contract's own sample body shows `"context":"current_turn"`) | which reasoning items replay | 400 / `invalid_request_error` / `reasoning.context` / — | echoed via `responseReasoning`; not acted on | DOC? |
| R-24 | `reasoning.generate_summary` | deprecated alias of `summary` | `null` | as R-22 | as R-22 | silently ignored | DOC |
| R-25 | `include` | array: `reasoning.encrypted_content`, `message.output_text.logprobs`, `web_search_call.action.sources`, `file_search_call.results`, `code_interpreter_call.outputs`, `computer_call_output.output.image_url`, `message.input_image.image_url` | `null` | adds the named payloads to `output` | 400 / `invalid_request_error` / `include` / — | **silently ignored** — notably `reasoning.encrypted_content`, which stateless multi-turn clients depend on | DOC |
| R-26 | `store` | boolean | `true` on Responses (doc transcript echoes `"store":true`) | retrievable via `GET /v1/responses/{id}` | 400 / `invalid_request_error` / `store` / — | echoed (`raw.store === false ? false : true`, `http-server.ts:2019`) but **nothing is stored** — the proxy has no `GET /v1/responses/{id}`, so an echoed `store:true` is a false promise | DOC |
| R-27 | `background` | boolean | `false` | returns immediately with `status:"queued"`; poll to completion | 400 / `invalid_request_error` / `background` / — | **silently ignored**; echoed as hard `false` (`http-server.ts:1999`) — a `background:true` client blocks instead of getting a queued id | DOC |
| R-28 | `previous_response_id` | string | `null` | server-side conversation continuation | 400 / `invalid_request_error` / `previous_response_id` / `not_found` when unknown | **divergent**: echoed verbatim (`http-server.ts:2013`) but **never resolved** — a client relying on server-side state loses all prior turns, silently, with a `200` | DOC |
| R-29 | `conversation` | string (conversation id); mutually exclusive with `previous_response_id` | `null` | conversation-scoped state | 400 / `invalid_request_error` / `conversation` / — | **silently ignored**; not even echoed | DOC |
| R-30 | `truncation` | `auto`\|`disabled` | `"disabled"` (doc states default explicitly) | over-context: drop-from-start vs 400 | 400 / `invalid_request_error` / `truncation` / — | echoed, not acted on (`http-server.ts:2026`) | DOC |
| R-31 | `metadata` | ≤16 pairs | `{}` (doc transcript echoes `{}`) | echoed | 400 / `invalid_request_error` / `metadata` / — | echoed via `asRecordPayload` (`http-server.ts:2033`) | DOC |
| R-32 | `user` | string (superseded) | `null` | cache bucketing | UNKNOWN | echoed (`http-server.ts:2032`) | DOC |
| R-33 | `safety_identifier` | string ≤64 | UNKNOWN (not in doc transcripts) | abuse bucketing | UNKNOWN | echoed (`http-server.ts:2017`) | DOC? |
| R-34 | `prompt_cache_key` | string | UNKNOWN | `usage.input_tokens_details.cached_tokens` | UNKNOWN | echoed (`http-server.ts:2014`) | DOC? |
| R-35 | `prompt_cache_retention` | `in_memory`\|`24h` | **org-dependent** (ZDR); whether it is echoed at all when omitted is UNKNOWN | cache lifetime | 400 / `invalid_request_error` / … / — | **divergent**: hard-coded `'24h'` in every response (`http-server.ts:2015`) regardless of request or org | DOC? |
| R-36 | `prompt_cache_options` | `{ttl, mode}` | `ttl:"30m"`, `mode:"implicit"` | explicit breakpoints | UNKNOWN | silently ignored | DOC |
| R-37 | `service_tier` | `auto`\|`default`\|`flex`\|`scale`\|`priority` | `"auto"` | echoed as tier used | 400 / `invalid_request_error` / `service_tier` / — | ignored; hard `"default"` (`http-server.ts:2018`) | DOC |
| R-38 | `prompt` | `{id, version, variables}` | `null` | server-side prompt template expansion | 400 / `invalid_request_error` / `prompt.id` / `not_found` | **silently ignored** — a template-only request (no `input`) would run with an empty conversation | DOC |
| R-39 | `context_management` | array of `{type:"compaction", compact_threshold}` | absent | auto-compaction of long contexts | UNKNOWN | silently ignored | DOC |
| R-40 | `moderation` | `{model, policy}` | absent | moderated output | UNKNOWN | silently ignored; `moderation` echoed as hard `null` (`http-server.ts:2009`) | DOC |
| R-41 | *(behavioral)* unknown top-level field | — | — | — | expected 400 `unknown_parameter` — unconfirmed | silently ignored | DOC? |

---

## 3. OpenAI Images — `/v1/images/generations`, `/edits`, `/variations`

20 rows. `G`/`E`/`V` = applicability to generations / edits / variations per the provider spec.

| # | Field | G/E/V | Type & values | Provider default | Observable effect | Invalid-value error | This proxy | Ev |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| I-1 | `model` | G E V | string | **`dall-e-2`** (doc: the only model for which the `url` default and 1000-char prompt cap apply) | picks the generator; changes which other fields are legal | 400 / `invalid_request_error` / `model` / `model_not_found` | supported; defaults to `dall-e-2`; `image-2` is the local route (contract `:242`) | VERIFIED (`openai.images.direct_generation.gpt_image.schema_exact`) |
| I-2 | `prompt` | G E, ignored on V | string; ≤32000 chars GPT-image, ≤1000 `dall-e-2`, ≤4000 `dall-e-3` | required on G/E | the image | 400 / `invalid_request_error` / `prompt` / — | supported; cap enforced as **32000 UTF-16 code units** (contract `:243`) — the provider's caps are model-dependent and character-based, so `dall-e-2` prompts of 1001-32000 chars are accepted here and rejected there | VERIFIED for the missing-prompt error (`openai.images.error_missing_prompt.schema_exact`) |
| I-3 | `image` / `image[]` / `images` | — E V | binary (multipart) | required on E/V | the source image | 400 / `invalid_request_error` / `image` / — | supported; **JSON image references also accepted on edits** (a proxy extension); variations require multipart (contract `:245`) | VERIFIED (`openai.images.direct_edit.gpt_image.schema_exact`, `…error_variation_json…`) |
| I-4 | `mask` | — E — | binary PNG, <4MB, same dims as `image` | absent | edit region | 400 / `invalid_request_error` / `mask` / — | accepted as an image input (contract `:246`) | DOC |
| I-5 | `n` | G E V | integer 1-10 (`dall-e-3`: only 1) | `1` | `data` array length | 400 / `invalid_request_error` / `n` / — | supported 1-10 (`http-server.ts:556`) — **does not enforce the `dall-e-3` n=1 rule** | VERIFIED (`…b64_json_n3_parallel…`) |
| I-6 | `size` | G E V | model-dependent: `1024x1024`\|`1024x1536`\|`1536x1024`\|`auto` (GPT-image); `256x256`\|`512x512`\|`1024x1024` (`dall-e-2`); `1024x1792`\|`1792x1024` (`dall-e-3`) | `auto` on GPT-image; `1024x1024` on dall-e | output dimensions; echoed | 400 / `invalid_request_error` / `size` / — | **divergent**: accepts `auto` or **any** `WIDTHxHEIGHT` with positive ints (`http-server.ts:938-950`) — a free-form grammar the provider rejects | DOC |
| I-7 | `quality` | G E V | `standard`\|`hd`\|`low`\|`medium`\|`high`\|`auto` | `auto` | fidelity, cost, latency; echoed | 400 / `invalid_request_error` / `quality` / — | supported, full enum (`http-server.ts:563`) — **not model-gated** (`hd` on a GPT-image model is accepted here, rejected there) | VERIFIED (`…generation_api_fields…`) |
| I-8 | `style` | G — — | `vivid`\|`natural` (dall-e-3 only) | `vivid` | aesthetic | 400 / `invalid_request_error` / `style` / — | supported on generations, 400 elsewhere (`http-server.ts:660`) | DOC |
| I-9 | `background` | G E V | `transparent`\|`opaque`\|`auto` (GPT-image only) | `auto` | alpha channel; echoed | 400 / `invalid_request_error` / `background` / — | supported; `transparent` rejected for `image-2` and with `jpeg` (`http-server.ts:647-658`) | VERIFIED (`…background_transparent_unsupported…`) |
| I-10 | `output_format` | G E V | `png`\|`jpeg`\|`webp` (GPT-image only) | `png` | encoding; echoed | 400 / `invalid_request_error` / `output_format` / — | supported | VERIFIED (`…generation_api_fields…`) |
| I-11 | `output_compression` | G E V | integer 0-100; **provider: only with `webp`/`jpeg`** | `100` | file size | 400 / `invalid_request_error` / `output_compression` / — | supported; **PNG + `100` explicitly allowed** (contract `:250`), and `null` treated as omission — the provider documents the param as webp/jpeg-only, so the PNG carve-out is an unverified reading | VERIFIED for the error case (`…error_invalid_output_compression…`) |
| I-12 | `moderation` | G E V | `low`\|`auto` (GPT-image only) | `auto` | filter strictness | 400 / `invalid_request_error` / `moderation` / — | supported (`http-server.ts:567`) | DOC |
| I-13 | `input_fidelity` | — E — | `high`\|`low` (gpt-image-1/1.5, **not** `-mini`) | `low` | face/style preservation | 400 / `invalid_request_error` / `input_fidelity` / — | supported on edits; 400 `invalid_input_fidelity_model` for `image-2` (`http-server.ts:636-645`) | VERIFIED (`…input_fidelity_disabled…`) |
| I-14 | `response_format` | G E V | `url`\|`b64_json`; **dall-e only** — GPT-image models reject it | **`url`** (dall-e-2/3) | `data[].url` vs `data[].b64_json` | 400 / `invalid_request_error` / `response_format` / `unknown_parameter` on GPT-image | **divergent default**: proxy defaults to **`b64_json`** (contract `:255`) where the provider defaults to `url`; correctly 400s it for `gpt-image-*` (`http-server.ts:588-593`) | VERIFIED for the rejection (`…proxy_gpt_image_response_format_unsupported…`, `…direct_image2_unsupported…`) |
| I-15 | `stream` | G E — | boolean (GPT-image only) | `false` | SSE partial/completed image events | 400 / `invalid_request_error` / `stream` / — | supported | VERIFIED (`…generation_stream…`) |
| I-16 | `partial_images` | G E — | integer 0-3 | `0`… (doc's rendered scalar is `1`; **the documented default is not distinguishable** — UNKNOWN) | number of `image_generation.partial_image` events | 400 / `invalid_request_error` / `partial_images` / — | **only 0/null/omitted**; >0 → 400 `partial_images is not supported by this local image proxy` (`http-server.ts:823-833`) | DOC? |
| I-17 | `user` | G E V | string | absent | abuse signal | UNKNOWN | accepted (contract `:254`) | DOC? |
| I-18 | `x_proxy_image_route` | G E V | object: `visual_class`, `geometry_mode`, `output_format`, `output_compression` | n/a | route-specific generation constraints | 400 / `invalid_request_error` / `x_proxy_image_route.*` / — | **proxy-only extension** (`http-server.ts:880-934`). Sending it to the direct API is expected to 400 as an unknown parameter | CODE |
| I-19 | *(behavioral)* body encoding | G E V | JSON on G; multipart on E/V per provider | — | — | 400 on wrong encoding | proxy accepts **JSON on edits** too, and requires multipart only for variations (contract `:245`) | VERIFIED for the variation-JSON rejection (`…error_variation_json…`) |
| I-20 | *(behavioral)* unknown top-level field | G E V | — | — | — | expected 400 `unknown_parameter` | unknown fields other than `response_format` are silently ignored | DOC? |

---

## 4. Anthropic Messages — `POST /v1/messages`

37 rows. Anthropic's docs publish far fewer defaults than OpenAI's spec, which is why this table carries the most `UNKNOWN`s — and why several of its probes rank highest.

| # | Field / JSON path | Type & values | Provider default | Observable effect | Invalid-value error | This proxy | Ev |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A-1 | `model` | string, required | none | the model; echoed in `model` | 400 / `invalid_request_error` (Anthropic envelope has **no `param`/`code`**) | supported; required non-empty string; 404 `not_found_error` when honouring is on (contract `:301`, `:405` ff.) | VERIFIED-weak (`anthropic.messages.text` vs `anthropic-api`; **the archive shows this case both passing and failing across runs**) |
| A-2 | `max_tokens` | integer, **required** | none | caps output; `stop_reason:"max_tokens"` | 400 / `invalid_request_error` | supported and required; **`0` accepted** on the claim that the direct API accepts it (contract `:316`) — an unverified claim about the provider | DOC? |
| A-3 | `messages` | array, `minItems: 1`, required | none | the conversation | 400 / `invalid_request_error` | supported | VERIFIED-weak (same caveat as A-1) |
| A-4 | `messages[].role` | `user`\|`assistant` only | none | turn attribution | 400 / `invalid_request_error` | supported; anything else (esp. `system`) 400 in the Anthropic envelope (contract `:303`) | DOC |
| A-5 | `messages[].content` | string \| block array | none | the turn | 400 / `invalid_request_error` | supported | VERIFIED-weak |
| A-6 | `content[].type:"text"` | `{text, cache_control?, citations?}` | — | text input | 400 / `invalid_request_error` | supported | VERIFIED-weak |
| A-7 | `content[].type:"image"` | `source`: `{type:"base64", media_type, data}` \| `{type:"url", url}` \| `{type:"file", file_id}` | — | vision input | 400 / `invalid_request_error` | base64 + url supported; **`file` rejected pre-execution** (contract `:307`) — the provider accepts it via the Files API, so this is a real capability gap surfaced as a 400 | VERIFIED-weak for base64/url (`anthropic.messages.image.schema_exact`) |
| A-8 | `content[].type:"document"` | PDF / text / custom-content sources | — | document input; PDF page tokens in `usage` | 400 / `invalid_request_error` | **UNKNOWN — not in the contract's block table (`:305-310`)**; most likely dropped or 400. Probe P-36 | DOC |
| A-9 | `content[].type:"tool_use"` | `{id, name, input}` | — | replays an assistant tool turn | 400 / `invalid_request_error` | supported; flattened into context | VERIFIED-weak (`anthropic.messages.tool_use`) |
| A-10 | `content[].type:"tool_result"` | `{tool_use_id, content, is_error?}` | — | tool result turn | 400 / `invalid_request_error` (unmatched `tool_use_id` is a 400 there) | supported; `is_error` handling UNKNOWN | VERIFIED-weak (`anthropic.messages.tool_result.schema_exact`) |
| A-11 | `content[].type:"thinking"` / `"redacted_thinking"` | `{thinking, signature}` | — | required to replay a thinking turn; **signature is verified server-side** | 400 / `invalid_request_error` on a bad signature | **UNKNOWN — not in the contract's block table.** A client replaying a thinking turn is unhandled | DOC |
| A-12 | `cache_control` (on any block) | `{type:"ephemeral", ttl?}` | absent | `usage.cache_creation_input_tokens` / `cache_read_input_tokens` | 400 / `invalid_request_error` | **accepted and ignored**, documented as such (contract `:405` ff., "Prompt caching") | DOC |
| A-13 | `system` | string \| block array | absent | system steering | 400 / `invalid_request_error` | supported; flattened (`normalizers.ts:99-100`) | DOC |
| A-14 | `temperature` | number **0..1** (note: not 0..2) | `1` (doc example shows `1`; **stated default UNKNOWN**) | sampling | 400 / `invalid_request_error` | parsed; forwarding to the Claude CLI is not asserted anywhere | DOC? |
| A-15 | `top_p` | number 0..1 | UNKNOWN | nucleus | 400 / `invalid_request_error` | **silently ignored** — not read (`rg` finds no `top_p` in `normalizers.ts`) | DOC? |
| A-16 | `top_k` | integer | UNKNOWN | top-K truncation | 400 / `invalid_request_error` | **silently ignored** | DOC? |
| A-17 | `stop_sequences` | array of strings | `[]` | stops output; `stop_reason:"stop_sequence"` **and `stop_sequence` echoes the matched string** | 400 / `invalid_request_error` | **silently ignored** — never read, yet the response emits `stop_sequence: result.stopSequence ?? null` (`http-server.ts:1896`), which can therefore never reflect a client sequence | DOC |
| A-18 | `stream` | boolean | `false` | SSE events | 400 / `invalid_request_error` | supported | VERIFIED-weak (`anthropic.messages.stream`) |
| A-19 | `tools` | array of `{name, description, input_schema}` + server tools (`web_search`, `bash`, `text_editor`, `computer`, …) | absent | `tool_use` blocks; `stop_reason:"tool_use"` | 400 / `invalid_request_error` | **custom tools only**; server-tool entries UNKNOWN (probe P-35) | VERIFIED-weak (`anthropic.messages.tool_use`) |
| A-20 | `tools[].input_schema` | JSON Schema object, required | none | argument shape | 400 / `invalid_request_error` | preserved (contract `:311`) | DOC |
| A-21 | `tool_choice` | `{type:"auto"\|"any"\|"tool"\|"none", name?, disable_parallel_tool_use?}` | `{"type":"auto"}` when tools present | forcing | 400 / `invalid_request_error` | `none`/`any`/`tool` mapped (contract `:312`); **`auto` and `disable_parallel_tool_use` handling UNKNOWN** | DOC |
| A-22 | `thinking` | `{type:"adaptive"\|"enabled"\|"disabled", budget_tokens?, display?}` | UNKNOWN — recent models default to adaptive thinking; the doc example sends `{"type":"adaptive"}` explicitly | `thinking` content blocks; token spend | 400 / `invalid_request_error` | validated hard (enum, `budget_tokens ≥ 1024` and `< max_tokens`, container non-null) **then `budget_tokens` is deliberately not forwarded** — documented, with the CLI-inertness evidence, at contract `:317` | DOC |
| A-23 | `output_config.effort` | `low`\|`medium`\|`high`\|`xhigh`\|`max` | UNKNOWN | reasoning/effort spend | 400 / `invalid_request_error` | supported; **accepted-and-ignored on models that gate it (Haiku)** — documented (contract `:318`) | DOC? |
| A-24 | `output_config.format` | `{type:"json_schema", schema}` | absent | structured output | 400 / `invalid_request_error` | supported; **rejected together with tools unless `tool_choice:"none"`** (`normalizers.ts:110-125`) — a restriction the provider does not impose | DOC |
| A-25 | `output_config.task_budget` | `{type:"tokens", total ≥ 20000}` | UNKNOWN | total task token budget | 400 / `invalid_request_error` | validated; forwarding UNKNOWN (contract `:320`) | DOC? |
| A-26 | `output_format` (top level, deprecated) | object | absent | superseded by `output_config.format` | 400 / `invalid_request_error` | **silently ignored** | DOC |
| A-27 | `metadata.user_id` | opaque string | absent | abuse detection | 400 / `invalid_request_error` | **silently ignored** | DOC |
| A-28 | `service_tier` | `auto`\|`standard_only` | `"auto"` | **`usage.service_tier` in the response** ( `"priority"` / `"standard"` ) | 400 / `invalid_request_error` | **silently ignored**; `usage.service_tier` never emitted | DOC |
| A-29 | `speed` | `standard`\|`fast` | UNKNOWN (beta) | latency mode | 400 / `invalid_request_error` | silently ignored | DOC? |
| A-30 | `inference_geo` | string (beta) | UNKNOWN | inference region | 400 / `invalid_request_error` | silently ignored | DOC? |
| A-31 | `mcp_servers` | array of MCP server defs (beta) | absent | `mcp_tool_use` blocks | 400 / `invalid_request_error` | silently ignored | DOC |
| A-32 | `container` | string (code-execution container id) | absent | container reuse | 400 / `invalid_request_error` | silently ignored | DOC? |
| A-33 | `context_management` | object (beta) | absent | context editing/compaction | 400 / `invalid_request_error` | silently ignored | DOC? |
| A-34 | `anthropic-version` header | e.g. `2023-06-01`; **required** | none — required | request is rejected without it | **400 / `invalid_request_error`** | **UNKNOWN — the proxy does not appear to require it**; a body missing the header succeeds here and fails there. Probe P-37 | DOC |
| A-35 | `anthropic-beta` header | array/CSV of beta ids | absent | unlocks beta fields | 400 / `invalid_request_error` on an unknown id | silently ignored | DOC |
| A-36 | `x-api-key` / `Authorization` | credential header | none — required | 401 without it | 401 / `authentication_error` | proxy has its own local access gate; **the credential semantics differ by construction** (not applicable) | DOC |
| A-37 | *(behavioral)* unknown top-level field | — | — | — | Anthropic's schema is strict — expected **400 `invalid_request_error`** ("Extra inputs are not permitted") | **silently ignored** — the widest single divergence class on this surface | DOC? |

---

## 5. Response-shape specs

### 5.1 Chat Completions

**Non-streaming — required fields** (provider): `id` (`chatcmpl-…`), `object:"chat.completion"`, `created` (unix s), `model`, `choices[]` with `index`, `message{role, content, refusal, annotations, tool_calls?}`, `finish_reason` ∈ `stop`\|`length`\|`tool_calls`\|`content_filter`\|`function_call`, `logprobs` (null when not requested), `usage`, `service_tier`, `system_fingerprint`.

`usage` sub-keys — **VERIFIED on the wire** (`bench-results/bench-provider-parity-direct-20260622.json`, `openai-api:gpt-5.5`, `sample.usage`): `prompt_tokens`, `completion_tokens`, `total_tokens`, `prompt_tokens_details{cached_tokens, audio_tokens}`, `completion_tokens_details{reasoning_tokens, audio_tokens, accepted_prediction_tokens, rejected_prediction_tokens}`.

Proxy gaps in this body: no `logprobs` key on the choice; `annotations` always `[]`; `refusal` always `null`; `service_tier` always `"default"`; `system_fingerprint` always `null` (`http-server.ts:1795-1823`).

**Streaming — event sequence.** Unnamed SSE (`data:` only), object `chat.completion.chunk`:

1. first chunk: `choices[0].delta.role = "assistant"` (content usually `""`)
2. N × `choices[0].delta.content` chunks — and/or `choices[0].delta.tool_calls[].function.arguments` deltas for tool turns
3. terminal choice chunk: `delta:{}` and `finish_reason` set
4. **only when `stream_options.include_usage:true`**: one extra chunk with `choices: []` and a populated `usage`; every earlier chunk then carries `usage: null`
5. `data: [DONE]` — **VERIFIED against the direct API** (`benchmark:610` asserts `response.done` on the `openai-api` target)

Optional: `obfuscation` on delta events (present by default; suppressed by `include_obfuscation:false`).

**Minimal example.**

```json
POST /v1/chat/completions
{"model":"gpt-5.5","messages":[{"role":"user","content":"ping"}]}
```
```jsonc
{"id":"chatcmpl-…","object":"chat.completion","created":1750000000,"model":"gpt-5.5",
 "choices":[{"index":0,"message":{"role":"assistant","content":"…","refusal":null,"annotations":[]},
             "logprobs":null,"finish_reason":"stop"}],
 "usage":{"prompt_tokens":0,"completion_tokens":0,"total_tokens":0,
          "prompt_tokens_details":{"cached_tokens":0,"audio_tokens":0},
          "completion_tokens_details":{"reasoning_tokens":0,"audio_tokens":0,
                                       "accepted_prediction_tokens":0,"rejected_prediction_tokens":0}},
 "service_tier":"default","system_fingerprint":"fp_…"}
```

### 5.2 Responses

**Non-streaming — required fields**: `id` (`resp_…`), `object:"response"`, `created_at`, `status` ∈ `completed`\|`incomplete`\|`failed`\|`in_progress`\|`queued`, `error`, `incomplete_details`, `instructions`, `max_output_tokens`, `model`, `output[]`, `parallel_tool_calls`, `previous_response_id`, `reasoning{effort, summary}`, `store`, `temperature`, `text{format}`, `tool_choice`, `tools`, `top_p`, `truncation`, `usage`, `user`, `metadata`.

`usage`: `input_tokens`, `output_tokens`, `total_tokens`, `input_tokens_details{cached_tokens}`, `output_tokens_details{reasoning_tokens}`.

`output[]` items: `reasoning` (with `summary[]`), `message` (with `content[].type:"output_text"` + `annotations`), `function_call` (`call_id`, `name`, `arguments`), built-in tool-call items.

**The doc's own `response.completed` transcript is the reference for the echoed defaults** and shows: `temperature: 1.0`, `top_p: 1.0`, `store: true`, `truncation: "disabled"`, `parallel_tool_calls: true`, `tool_choice: "auto"`, `reasoning: {effort: null, summary: null}`, `metadata: {}`, `user: null`, `max_output_tokens: null`. Our echo differs on `top_p` (0.98), `top_logprobs` (0 vs null), `prompt_cache_retention` ("24h" always), and adds `billing`, `moderation`, `max_tool_calls`, `frequency_penalty`, `presence_penalty` keys.

**Streaming — event sequence** (named SSE; every payload carries `sequence_number`, monotonically increasing from 0):

```
response.created → response.in_progress
  → [per output item]
      response.output_item.added
        (message item:)   response.content_part.added
                          response.output_text.delta ×N
                          response.output_text.done
                          response.content_part.done
        (function_call:)  response.function_call_arguments.delta ×N
                          response.function_call_arguments.done
      response.output_item.done
  → response.completed        ← usage lives ONLY here, on `response.usage`
```
Terminal alternatives: `response.incomplete`, `response.failed`, `error`. Optional/model-dependent: `response.reasoning_summary_part.*`, `response.reasoning_summary_text.*`, `response.refusal.*`, `response.output_text.annotation.added`, built-in tool-call events (`response.web_search_call.*`, `response.file_search_call.*`, `response.image_generation_call.*`, `response.mcp_call.*`), `response.queued`.

**Stream terminator: UNKNOWN.** The provider's documented transcript ends at `response.completed` with **no `data: [DONE]` line**; our proxy writes one (`http-server.ts:2567`, `:2570`), and the benchmark's Responses assertion never checks the terminator (`benchmark:2928-2944`). This is the highest-risk unverified cell in the document — see P-2.

**Minimal example.**

```json
POST /v1/responses
{"model":"gpt-5.5","input":"ping"}
```
```jsonc
{"id":"resp_…","object":"response","created_at":1750000000,"status":"completed",
 "error":null,"incomplete_details":null,"instructions":null,"max_output_tokens":null,"model":"gpt-5.5",
 "output":[{"id":"msg_…","type":"message","status":"completed","role":"assistant",
            "content":[{"type":"output_text","text":"…","annotations":[]}]}],
 "parallel_tool_calls":true,"previous_response_id":null,"reasoning":{"effort":null,"summary":null},
 "store":true,"temperature":1.0,"text":{"format":{"type":"text"}},"tool_choice":"auto","tools":[],
 "top_p":1.0,"truncation":"disabled","user":null,"metadata":{},
 "usage":{"input_tokens":0,"output_tokens":0,"total_tokens":0,
          "input_tokens_details":{"cached_tokens":0},"output_tokens_details":{"reasoning_tokens":0}}}
```

### 5.3 Images

**Non-streaming — `ImagesResponse`**: `created` (required), `data[]` with `b64_json` **or** `url` (+ `revised_prompt` on dall-e-3), and — GPT-image only — `background`, `output_format`, `size`, `quality`, `usage{input_tokens, output_tokens, total_tokens, input_tokens_details{text_tokens, image_tokens}, output_tokens_details{image_tokens, text_tokens}}`.

Note the provider's image `usage` shape is **not** the Responses shape: it has `input_tokens_details{text_tokens, image_tokens}`, not `{cached_tokens}`. Our contract's Images output sample (`api-interface-contract.md:246` ff.) shows the **Responses** shape (`input_tokens_details:{cached_tokens}`, `output_tokens_details:{reasoning_tokens}`) — a shape the provider does not emit for images. Probe P-16.

**Streaming — provider events**: `image_generation.partial_image` (0-3 of them, with `partial_image_index`, `b64_json`, `created_at`, `size`, `quality`, `background`, `output_format`) then `image_generation.completed`; edits use `image_edit.*`. Our proxy emits only the `completed` event and 400s `partial_images > 0` (contract `:271` ff.).

**Minimal example.**

```json
POST /v1/images/generations
{"model":"gpt-image-1","prompt":"a red circle on white"}
```
```jsonc
{"created":1750000000,"data":[{"b64_json":"…"}],
 "background":"opaque","output_format":"png","size":"1024x1024","quality":"medium",
 "usage":{"input_tokens":0,"output_tokens":0,"total_tokens":0,
          "input_tokens_details":{"text_tokens":0,"image_tokens":0},
          "output_tokens_details":{"image_tokens":0,"text_tokens":0}}}
```

### 5.4 Anthropic Messages

**Non-streaming — required fields**: `id` (`msg_…`), `type:"message"`, `role:"assistant"`, `model`, `content[]`, `stop_reason` ∈ `end_turn`\|`max_tokens`\|`stop_sequence`\|`tool_use`\|`pause_turn`\|`refusal`\|`model_context_window_exceeded`, `stop_sequence` (string or null), `usage{input_tokens, output_tokens, cache_creation_input_tokens?, cache_read_input_tokens?, service_tier?}`.

**Streaming — event sequence** (named SSE):

```
message_start           (message with empty content; usage.input_tokens set, output_tokens ~1; stop_reason null)
  [per content block]
    content_block_start (index, block stub: text | tool_use | thinking)
    content_block_delta ×N  (text_delta | input_json_delta | thinking_delta | signature_delta)
    content_block_stop
message_delta           (delta{stop_reason, stop_sequence} + usage{output_tokens, …})
message_stop
```
`ping` events may be interleaved anywhere and carry no content. `error` may arrive **after** a 200 has been sent (mid-stream), which is why the Anthropic error envelope must be handled inside the stream as well as at HTTP level. There is **no `[DONE]` sentinel** on this surface.

Two divergences worth naming here:

- **`message_start.usage`.** The provider populates `input_tokens` (and cache counts) on `message_start`; the proxy writes zeros there and puts the whole usage on `message_delta` (`http-server.ts:2757-2762`, and the contract states this explicitly at `:349` ff.). A client that reads input tokens off `message_start` — the documented place — reads `0` from us.
- **`ping`.** The proxy never emits one (`rg` finds no `ping` in `http-server.ts`). SDKs tolerate its absence; naive SSE clients relying on it for keepalive would not.

**Minimal example.**

```json
POST /v1/messages   (headers: anthropic-version: 2023-06-01)
{"model":"claude-sonnet-5","max_tokens":64,"messages":[{"role":"user","content":"ping"}]}
```
```jsonc
{"id":"msg_…","type":"message","role":"assistant","model":"claude-sonnet-5",
 "content":[{"type":"text","text":"…"}],
 "stop_reason":"end_turn","stop_sequence":null,
 "usage":{"input_tokens":0,"output_tokens":0}}
```

---

## 6. Probe plan — converting DOC into VERIFIED

**Ranking.** risk = P(our proxy diverges) × client visibility. Tier A = a divergence a normal SDK client would hit on an ordinary request. Tier B = a divergence a client hits when it uses the feature. Tier C = completeness.

Standing rules for every probe: minimal token spend (`max_tokens`/`max_completion_tokens` ≈ 16 unless the probe needs more), cheapest model on the family, **record the complete raw response body and the complete raw SSE byte stream** (not a parsed summary — that is exactly what `bench-results` failed to keep), plus status line and response headers. Store under `artifacts/direct-api-captures/<probe-id>.json`. Every probe below then upgrades named rows from DOC/DOC? to VERIFIED.

| ID | Tier | Probe — exact request | Record | Upgrades | Calls |
| --- | --- | --- | --- | --- | --- |
| **P-1** | A | `POST /v1/responses` `{"model":"gpt-5.5","input":"ping","max_output_tokens":16}` — every optional field omitted | Full body. Every echoed default: `temperature`, `top_p`, `top_logprobs`, `truncation`, `store`, `parallel_tool_calls`, `service_tier`, `tool_choice`, `text`, `reasoning`, `background`, `max_tool_calls`, `metadata`, `prompt_cache_retention`, `billing`; and the exact key set | R-10, R-11, R-12, R-19, R-20, R-23, R-26, R-27, R-30, R-31, R-35, R-37 + §5.2 | 1 |
| **P-2** | A | Same body + `"stream":true` | Ordered list of every `event:` name; whether a `data: [DONE]` line exists; `sequence_number` start; where `usage` appears; whether `obfuscation` is present by default | §5.2 terminator (**the top unverified cell**), R-13, R-14 | 1 |
| **P-3** | A | `POST /v1/chat/completions` `{"model":"gpt-5.5","messages":[{"role":"user","content":"ping"}],"max_completion_tokens":16}` | Exact key set; `service_tier`, `system_fingerprint`, `logprobs`, `annotations`, `refusal` values | rows 22, 24, 40 + §5.1 | 1 |
| **P-4** | A | `POST /v1/messages` `{"model":"claude-haiku-…","max_tokens":16,"messages":[{"role":"user","content":"ping"}],"stream":true}` | Ordered event list; **`message_start.usage.input_tokens`**; `message_delta.usage` key set; `ping` presence/interval; absence of `[DONE]` | §5.4 (both named divergences), A-18 | 1 |
| **P-5** | A | Unknown top-level field on each of the three text surfaces: `{"…minimal…","zzz_unknown":1}` | status, `error.type`, `error.param`, `error.code`, message text | row 50, R-41, A-37 | 3 |
| **P-6** | A | `POST /v1/messages` minimal, **omitting the `anthropic-version` header** | status + envelope | A-34 | 1 |
| **P-7** | A | Chat `{"…","n":2,"max_completion_tokens":16}` | `choices` length; or the error if `n>1` is refused on the model | row 15 | 1 |
| **P-8** | A | Anthropic minimal + `"stop_sequences":["ZZ"]` with a prompt that emits `ZZ` | `stop_reason`, `stop_sequence` echo | A-17 | 1 |
| **P-9** | A | Chat minimal + `"stop":["ZZ"]`, prompt that emits `ZZ` | `finish_reason`, truncation point | row 16 | 1 |
| **P-10** | A | `POST /v1/responses` `{"model":…,"input":"ping","stream":true,"stream_options":{"include_usage":true}}` | Whether the provider 400s an undocumented `stream_options` key, or accepts it | R-15 | 1 |
| P-11 | B | Anthropic `{"max_tokens":0,…}` | status + envelope — settles the contract's claim at `:316` | A-2 | 1 |
| P-12 | B | Anthropic `{"messages":[{"role":"system",…}]}` | status + envelope (no `param`/`code`) | A-4 | 1 |
| P-13 | B | Chat `reasoning_effort:"max"`; then Responses `reasoning:{"effort":"max"}` | accepted or 400 — settles our enum truncation | row 43, R-21 | 2 |
| P-14 | B | Chat, model omitted; then `""`; then `"   "` | status/type/param/code per case | row 1 | 3 |
| P-15 | B | Responses **with `model` omitted** | whether the provider really requires it | R-1 | 1 |
| P-16 | B | `POST /v1/images/generations` `{"model":"gpt-image-1","prompt":"a red dot","size":"1024x1024","quality":"low"}` | Exact key set + **`usage` sub-shape** (settles the contract's Responses-shaped image usage) | I-1, I-7, §5.3 | 1 |
| P-17 | B | Images generations with `"model":"dall-e-2","prompt":"a red dot"`, `response_format` omitted | whether `data[0]` carries `url` (provider default) — settles our `b64_json` default | I-14 | 1 |
| P-18 | B | Images generations, `"size":"777x333"` on gpt-image | status/type/param/code — settles our free-form `WIDTHxHEIGHT` grammar | I-6 | 1 |
| P-19 | B | Chat `tool_choice:"banana"`; Responses same | 400 vs silent `auto` fallback | row 31, R-19 | 2 |
| P-20 | B | Chat with a tool + `"parallel_tool_calls":false` on a prompt that would call twice | `tool_calls` length; echo | row 32 | 1 |
| P-21 | B | Responses with `"parallel_tool_calls":false` | whether the echo reflects the request (ours is hard `true`) | R-20 | 1 |
| P-22 | B | Responses `{"input":"remember X"}` → capture `id` → second call `{"previous_response_id":"<id>","input":"what did I say?"}` | whether state carries; error when `store:false` | R-28, R-26 | 3 |
| P-23 | B | Responses `{"reasoning":{"effort":"medium","summary":"detailed"},…}` on a reasoning model | whether `output[0]` is a `reasoning` item with `summary[]` parts | R-22 | 1 |
| P-24 | B | Responses `{"include":["reasoning.encrypted_content"],"store":false,…}` | presence of `encrypted_content` in the reasoning item | R-25 | 1 |
| P-25 | B | Chat `{"max_completion_tokens":8}` on a long prompt; Anthropic `{"max_tokens":8}` likewise | `finish_reason:"length"` / `stop_reason:"max_tokens"`; Responses `status:"incomplete"` + `incomplete_details` | rows 17-18, A-2, R-8 | 3 |
| P-26 | B | Anthropic `{"thinking":{"type":"enabled","budget_tokens":<max_tokens>}}` (budget ≥ max) | status + envelope — settles our validation rule | A-22 | 1 |
| P-27 | B | Anthropic `{"tools":[…],"output_config":{"format":{"type":"json_schema","schema":{…}}}}` together | whether the provider allows the combination we refuse | A-24 | 1 |
| P-28 | B | Chat streaming **without** `include_usage` | whether `usage` is absent or `null` on chunks | row 26 | 1 |
| P-29 | B | Chat with tools on a `gpt-5.6`-family model, `reasoning_effort` omitted | reproduce the 400 our contract cites at `:405` ff. — it is currently an unverified claim about the provider that justifies a documented divergence | contract "Chat tools with model-default reasoning" | 1 |
| P-30 | C | Chat `{"temperature":3}`; Anthropic `{"temperature":1.5}` | status/type/param/code, and the differing ranges | rows 13, A-14 | 2 |
| P-31 | C | `GET /v1/models` on both providers | exact list-object shape (`object:"list"`, `data[].{id,object,created,owned_by}`) | §0 missing surface | 2 |
| P-32 | C | `POST /v1/messages/count_tokens` minimal | response shape, for the gap decision | §0 note | 1 |
| P-33 | C | Chat with an `input_audio` part and a `file` part; Responses with an `input_file` part | accepted / 400 shape | rows 4, R-5 | 2 |
| P-34 | C | Chat with `tools[0].function.strict:true` and a schema the model would violate | whether arguments conform | row 30 | 1 |
| P-35 | C | Responses with `tools:[{"type":"web_search"}]`; Anthropic with a server tool | output item types produced | R-18, A-19 | 2 |
| P-36 | C | Anthropic with a `document` block and with a `thinking` replay block | accepted / 400 | A-8, A-11 | 2 |
| P-37 | C | Anthropic `{"cache_control":{"type":"ephemeral"}}` on a large system block, twice | `cache_creation_input_tokens` then `cache_read_input_tokens` | A-12 | 2 |

**Totals.**

- **Full plan: 37 probes / 53 API calls** (`P-1`…`P-37`, summed over the Calls column; counted mechanically, not by hand).
- **Cheap subset — the Tier A ten (`P-1`…`P-10`): 12 calls.** All are ≤16-output-token requests on the cheapest model of each family; two of them (P-5, P-14-class errors) are 400s and cost nothing but the request. This subset alone upgrades **26 matrix rows plus both stream-shape specs**, and it settles the two divergences most likely to break a real SDK client today: the Responses stream terminator (P-2) and the echoed Responses defaults (P-1).

**Sequencing note.** Run P-1 and P-2 first and read them before running the rest: if the Responses body/stream shape differs from the doc transcript in ways this document did not anticipate, several Tier B probes should be rewritten before they are spent.

**Instrument check, mandatory before the plan is trusted.** Every probe here is an observation whose expected answer I have already written down. Before any capture is treated as evidence, run each recorder against an input whose answer is known to be the opposite — e.g. assert that the SSE recorder reports "no `[DONE]`" for a stream that genuinely has none (feed it a saved Anthropic stream) *before* concluding the same about `/v1/responses`. A capture that agrees with the table above is the moment to check the recorder, not the moment to stop.

---

## Appendix: evidence tally

Counted mechanically over the four matrices by the value in the final column (a hand tally written first was wrong on two classes; these are the script's numbers).

| Class | Rows |
| --- | --- |
| DOC | 84 |
| DOC? (documented field, cell UNKNOWN) | 28 |
| VERIFIED | 26 |
| VERIFIED-weak | 9 |
| CODE (no provider evidence exists) | 1 |
| **Total** | **148** |

Per surface: Chat Completions 50, Responses 41, Images 20, Anthropic Messages 37.

`VERIFIED-weak` (9 of the 35 verified rows) marks the Anthropic rows whose only wire evidence is a direct-API benchmark case that shows **both `ok:true` and `ok:false`** across archived runs. They are not stable evidence and every one of them is re-probed in the plan.

No row's **column 3 (default when omitted)** is VERIFIED anywhere in this document. That is the honest state of the world before the probe plan runs.
