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
- The proxy used to serve a **proxy-only** surface, `GET /v1/images/generated/{id}`, the target of `response_format: "url"`. Removed 2026-08-29: every live image model refuses `response_format`, so the surface was unreachable (row I-14).

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
| 5 | `messages[].name` | string | absent | participant disambiguation inside the prompt | UNKNOWN | **silently ignored** — `readOpenAiMessages` reads only `role`/`content` (`normalizers.ts`). The direct API accepts it too (measured); neither side reports it back | VERIFIED (§5.5.5) |
| 6 | `messages[].tool_calls` | array of `{id, type:"function", function:{name, arguments}}` | absent | prior assistant tool turn replayed | UNKNOWN | supported — flattened into context via `ASSISTANT_TOOL_CALL_MARKER`; contract `:36` | VERIFIED (`openai.chat.tool_result.schema_exact`) |
| 7 | `messages[].tool_call_id` | string, required on `role:"tool"` | none on tool role | binds result to call | 400 / `invalid_request_error` / `messages[i].tool_call_id` / — | supported; contract `:37` | VERIFIED (same row) |
| 8 | `messages[].function_call` | `{name, arguments}` (deprecated) | absent | legacy tool turn | UNKNOWN | supported as a content-optional assistant turn (`normalizers.ts:354-357` comment) | DOC |
| 9 | `messages[].refusal` | string, assistant input | absent | replays a prior refusal | UNKNOWN | **silently ignored**; the direct API accepts it and reports nothing back (measured) | VERIFIED (§5.5.5) |
| 10 | `messages[].audio` | `{id}`, assistant input | absent | replays prior audio turn | UNKNOWN | refused as an unknown key — `audio` is not in the direct Chat schema for this family (measured: `unknown_parameter`) | VERIFIED (§5.5.5) |
| 11 | `modalities` | array of `text`\|`audio` | `["text"]` | adds `message.audio` to the response | UNKNOWN | refused as an unknown key (measured: `unknown_parameter`), where it used to be accepted and ignored | VERIFIED (§5.5.5) |
| 12 | `audio` | `{voice, format}`; required when `modalities` includes `audio` | absent | audio bytes in `message.audio.data` | 400 / `invalid_request_error` / `audio` / — | refused as an unknown key (measured: `unknown_parameter`) | VERIFIED (§5.5.5) |
| 13 | `temperature` | number 0-2 | `1` (see instrument caveat) | sampling spread | 400 / `invalid_request_error` / `temperature` / `unsupported_value` on reasoning models that fix it at 1 | **rejected unless `1`** (null = omission): 400 `unsupported_value`, message `Unsupported value: 'temperature' does not support 0.5 with this model. Only the default (1) value is supported.` — the direct envelope, mirrored (`normalizers.ts` `rejectUnsupportedOpenAiSampling`). Nothing behind the surface applies it | VERIFIED (direct `gpt-5.6-terra` 2026-08-29: 0.5 → 400 `unsupported_value`, 1 → 200) |
| 14 | `top_p` | number 0-1 | `1` (caveat) | nucleus cutoff | 400 / `invalid_request_error` / `top_p` / `unsupported_parameter` | **rejected unless `1`** (null = omission): 400 `unsupported_parameter`, `Unsupported parameter: 'top_p' is not supported with this model.` | VERIFIED (direct 2026-08-29: 0.5 → 400 `unsupported_parameter`, 1 → 200) |
| 15 | `n` | integer ≥1 | `1` (caveat) | `choices` array length | 400 / `invalid_request_error` / `n` / — (and `n>1` unsupported on some models) | **validated** (integer, 1..8 — the ceiling measured) **and realized**: n backend turns, one per `choices[]` entry, on the buffered and the streamed path. Usage reports the prompt once and sums the completions, as the direct API does | VERIFIED (§5.5.5; live `n: 2` through the Codex backend: 2 turns, 2 choices, one usage chunk) |
| 16 | `stop` | string \| array (≤4) \| null | `null` | truncates output at the sequence; `finish_reason:"stop"` | 400 / `invalid_request_error` / `stop` / — | **refused** with the direct envelope for this family: `unsupported_parameter` / `param: stop` | VERIFIED (§5.5.5, P-9) |
| 17 | `max_tokens` | integer (deprecated) | model max | caps output; `finish_reason:"length"` | 400 / `invalid_request_error` / `max_tokens` / `unsupported_parameter` on o-series | **refused** with the direct message: `Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.` | VERIFIED (§5.5.5) |
| 18 | `max_completion_tokens` | integer | model max | as above, counts reasoning tokens | 400 / `invalid_request_error` / `max_completion_tokens` / — | validated (integer >= 1, `integer_below_min_value` below it) and passed to the backend as the max-token hint | VERIFIED (§5.5.5) |
| 19 | `presence_penalty` | number -2..2 | `0` (caveat) | topic novelty | 400 / `invalid_request_error` / `presence_penalty` / — | **refused while the model reasons** (`unsupported_parameter`), accepted and not applied at `reasoning_effort: none` — both measured | VERIFIED (§5.5.5) |
| 20 | `frequency_penalty` | number -2..2 | `0` (caveat) | repetition | 400 / `invalid_request_error` / `frequency_penalty` / — | **refused while the model reasons** (`unsupported_parameter`), accepted and not applied at `reasoning_effort: none` — both measured | VERIFIED (§5.5.5) |
| 21 | `logit_bias` | map token-id → -100..100 | `null` | token ban/boost | 400 / `invalid_request_error` / `logit_bias` / — | **refused** (`unsupported_parameter`) whatever the value, as the direct API refuses it for this family | VERIFIED (§5.5.5) |
| 22 | `logprobs` | boolean | `false` (caveat) | populates `choices[].logprobs` | 400 / `invalid_request_error` / `logprobs` / — | **refused while the model reasons** (`unsupported_parameter`); at `reasoning_effort: none` it is accepted and not applied — the response carries no `logprobs`, which the contract states | VERIFIED (§5.5.5) |
| 23 | `top_logprobs` | integer 0-20; requires `logprobs:true` | `null` | per-token alternatives | 400 / `invalid_request_error` / `top_logprobs` / — | validated as the direct API validates it: integer, 0..5, and only with `logprobs: true` — three distinct measured envelopes. Not applied | VERIFIED (§5.5.5) |
| 24 | `seed` | integer (Beta) | `null` | best-effort determinism; `system_fingerprint` | 400 / `invalid_request_error` / `seed` / — | validated (integer) and accepted without effect; `system_fingerprint` stays `null`, as it is on the direct API for this family (measured) | VERIFIED (§5.5.5) |
| 25 | `stream` | boolean | `false` | SSE chunks vs JSON body | 400 / `invalid_request_error` / `stream` / — | supported; `input.stream === true` strictly (`normalizers.ts:34`) — note a string `"true"` is treated as false, no error | VERIFIED (`openai.chat.stream.schema_exact`) |
| 26 | `stream_options.include_usage` | boolean | `false` | extra final chunk with `choices: []` + `usage`; other chunks carry `usage: null` | 400 / `invalid_request_error` / `stream_options` / — (400 if set without `stream:true`) | supported (`http-server.ts:2227-2234`) | VERIFIED (`openai.chat.stream_usage.schema_exact` vs `openai-api`; asserts final-usage shape **and** the `[DONE]` terminator, `benchmark:610-611`) |
| 27 | `stream_options.include_obfuscation` | boolean | `true` (obfuscation fields present by default) | adds `obfuscation` string to delta events | UNKNOWN | supported; defaults true unless explicitly false (contract `:41`); emits `obfuscation` (`http-server.ts:2233`) | DOC |
| 28 | `response_format` | `{type:"text"\|"json_object"\|"json_schema"}` | `{"type":"text"}` | forces JSON / schema-valid output | 400 / `invalid_request_error` / `response_format` / — | supported for `json_object` + `json_schema` (`normalizers.ts:35-38`); `strict` and schema `name` parsed | VERIFIED (`openai.chat.json_schema.schema_exact`) |
| 29 | `tools` | array of `{type:"function", function:{name, description, parameters, strict}}` | `[]` / absent | enables `message.tool_calls`, `finish_reason:"tool_calls"` | 400 / `invalid_request_error` / `tools[i].function.name` / — | supported (name/description/parameters preserved); contract `:38` | VERIFIED (`openai.chat.tool_call.schema_exact`) |
| 30 | `tools[].function.strict` | boolean | `false` | strict schema adherence on arguments | UNKNOWN | **UNKNOWN — parsed for `response_format` (`normalizers.ts:38`) but not confirmed read off tool definitions**; probe P-34 | DOC |
| 31 | `tool_choice` | `"none"`\|`"auto"`\|`"required"`\|`{type:"function", function:{name}}` | `"auto"` when tools present, `"none"` when absent | forces / suppresses a call | 400 / `invalid_request_error` / `tool_choice` / — | mirrored: the three modes and the `{type:'function', function:{name}}` object, with the direct API's `invalid_value` / `invalid_type` / `missing_required_parameter` envelopes for everything else. The silent `auto` fallback is gone | VERIFIED (§5.5.5) |
| 32 | `parallel_tool_calls` | boolean | `true` | allows >1 call per turn | 400 / `invalid_request_error` / `parallel_tool_calls` / — | validated (boolean) and accepted without effect | VERIFIED (§5.5.5) |
| 33 | `functions` | array (deprecated) | absent | legacy tool list | 400 / `invalid_request_error` / `functions` / — | validated as the direct API validates it (`functions[i].name` required) and **not applied** — carrying it into `tools` would run the tools but answer in the modern shape, and a legacy client reads `message.function_call` | VERIFIED for validation (§5.5.5) |
| 34 | `function_call` | `"none"`\|`"auto"`\|`{name}` (deprecated) | `"auto"` with `functions` | legacy forcing | 400 / `invalid_request_error` / `function_call` / — | validated (`function_call.name` required on the object form) and not applied | VERIFIED for validation (§5.5.5) |
| 35 | `user` | string (superseded) | absent | cache bucketing / abuse signal | UNKNOWN | validated (string) and accepted without effect on chat | VERIFIED (§5.5.5) |
| 36 | `safety_identifier` | string ≤64 | absent | abuse detection bucket | UNKNOWN | validated (string) and accepted without effect on chat | VERIFIED (§5.5.5) |
| 37 | `prompt_cache_key` | string | absent | raises `usage.prompt_tokens_details.cached_tokens` | UNKNOWN | validated (string) and accepted without effect; the proxy caches nothing of its own | VERIFIED (§5.5.5) |
| 38 | `prompt_cache_retention` | `"in_memory"`\|`"24h"` (deprecated) | **org-dependent: `24h` without ZDR, `in_memory` with ZDR** | cache lifetime | 400 / `invalid_request_error` / `prompt_cache_retention` / — | mirrored: `in_memory` is refused with the direct sentence (`This model is compatible only with 24h extended prompt caching`), `24h` accepted and not applied | VERIFIED (§5.5.5) |
| 39 | `prompt_cache_options` | `{ttl:"30m", mode:"implicit"\|"explicit"}` | `ttl:"30m"`, `mode:"implicit"` | explicit cache breakpoints | UNKNOWN | validated (object, and its members against the direct API's own key set — an unknown member is `unknown_parameter` naming `prompt_cache_options.<key>`) and not applied | VERIFIED (§5.5.5) |
| 40 | `service_tier` | `auto`\|`default`\|`fast`\|`flex`\|`priority` (the direct API's own list, measured — `scale` is not in it) | `"auto"` (resolves to project setting, usually `default`) | echoed as the tier actually used; latency/pricing | 400 / `invalid_request_error` / `service_tier` / — | **echoed as requested** (`flex` in, `flex` out), with `auto` and an omitted value resolving to `default` — the hard-coded `default` is gone | VERIFIED (§5.5.5) |
| 41 | `store` | boolean | `false` | retention for distillation/evals | UNKNOWN | validated (boolean) and accepted without effect on chat | VERIFIED (§5.5.5) |
| 42 | `metadata` | map, ≤16 pairs, key ≤64 / value ≤512 | `null` | stored alongside a stored completion | 400 / `invalid_request_error` / `metadata` / — | validated as the direct API validates it — at most 16 properties, keys <= 64 characters, string values <= 512 — and not applied | VERIFIED (§5.5.5) |
| 43 | `reasoning_effort` | `none`\|`minimal`\|`low`\|`medium`\|`high`\|`xhigh`\|`max` | model-dependent (**UNKNOWN per-model**) | `usage.completion_tokens_details.reasoning_tokens`, latency | 400 / `invalid_request_error` / `reasoning_effort` / — | mirrored for this family: `none`/`low`/`medium`/`high`/`xhigh` accepted, everything else (including `minimal` and `max`) refused with the direct `unsupported_value` and its supported list | VERIFIED (§5.5.5) |
| 44 | `reasoning.effort` (on chat) | same enum | n/a — **not a Chat Completions field** | — | provider: 400 unknown parameter (expected) | **refused as an unknown key**, as the direct API refuses it. The proxy extension is gone: a body the direct API rejects no longer succeeds here | VERIFIED (§5.5.5) |
| 45 | `verbosity` | `low`\|`medium`\|`high` | `medium` (**UNKNOWN — spec states no default**) | output length | 400 / `invalid_request_error` / `verbosity` / — | supported; an out-of-enum value is the direct `invalid_value` with its supported list | VERIFIED (§5.5.5) |
| 46 | `text.verbosity` (on chat) | same enum | n/a — **not a Chat Completions field** | — | provider: 400 unknown parameter (expected) | **refused as an unknown key**, as the direct API refuses it (the extension is gone, same as row 44) | VERIFIED (§5.5.5) |
| 47 | `prediction` | `{type:"content", content}` | absent | speculative decoding; `usage.completion_tokens_details.accepted/rejected_prediction_tokens` | 400 / `invalid_request_error` / `prediction` / — | **refused** (`unsupported_parameter`), as the direct API refuses it for this family | VERIFIED (§5.5.5) |
| 48 | `web_search_options` | `{user_location, search_context_size}` | absent | adds web-search tool call + citations to `annotations` | 400 / `invalid_request_error` / `web_search_options` / — | refused as an unknown key (measured: `unknown_parameter`) | VERIFIED (§5.5.5) |
| 49 | `moderation` | `{model, policy:{input:{mode}, output}}` | absent | moderated output / refusals | 400 / `invalid_request_error` / `moderation` / — | validated as the direct API validates it (`moderation.model` required) and not applied — the local runtimes moderate nothing, so the response carries no `moderation` object | VERIFIED (§5.5.5) |
| 50 | *(behavioral)* unknown top-level field, e.g. `{"foo":1}` | — | — | — | 400 / `invalid_request_error` / `<key>` / `unknown_parameter` — measured 2026-08-30 on every key outside the schema | **refused** with `unknown_parameter` on Chat, against the direct API's own key set, reported after the required parameters and before every other field | VERIFIED (§5.5.5) |

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
| R-10 | `temperature` | number 0-2 | `1` (caveat; confirmed by the doc's SSE transcript showing `"temperature":1.0`) | sampling | 400 / `invalid_request_error` / `temperature` / — | **rejected unless `1`** (null = omission): 400 `param: temperature`, `code: null`, `Unsupported parameter: 'temperature' is not supported with this model.`; echoed as the constant `1` | VERIFIED (direct `gpt-5.6-terra` 2026-08-29: 0.5 → 400 code null, 1 → 200) |
| R-11 | `top_p` | number 0-1 | `1` (doc SSE transcript shows `"top_p":1.0`) | nucleus | 400 / `invalid_request_error` / `top_p` / — | **rejected whenever present**, `1` included: 400 `param: top_p`, `code: null`, `Unsupported parameter: 'top_p' is not supported with this model.`; echoed as the constant `1` (was `0.98`) | VERIFIED (direct 2026-08-29: 0.5 → 400, **1 → 400 too** — the Responses surface refuses the parameter, not the value) |
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

## 3. OpenAI Images — `/v1/images/generations`, `/edits` (`/variations` is gone — 404 on both, 2026-08-29)

20 rows. `G`/`E`/`V` = applicability to generations / edits / variations per the provider spec as it stood before 2026-08-29; the `V` column is historical — the direct API answers a bare 404 on `/v1/images/variations` (measured 2026-08-29), and so does the proxy.

| # | Field | G/E/V | Type & values | Provider default | Observable effect | Invalid-value error | This proxy | Ev |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| I-1 | `model` | G E V | string | **none — required** (2026-08-29: absent → 400 `missing_required_parameter`; null/number → 400 `invalid_type`) | picks the generator; changes which other fields are legal | 400 / `image_generation_user_error` / `model` / `invalid_value` `The model 'X' does not exist.` — for `dall-e-2`, `dall-e-3`, `image-2`, `''`, anything not in the live list | required; live list `gpt-image-1`, `gpt-image-1-mini`, `gpt-image-1.5`, `gpt-image-2`, `gpt-image-2-2026-04-21`, `chatgpt-image-latest` (`OPENAI_IMAGE_MODELS`, `http-server.ts`); every name runs on the local backend; the former `image-2` is refused like any other unknown name | VERIFIED (direct 2026-08-29, §5.5.2) |
| I-2 | `prompt` | G E | string; ≤32000 chars | required | the image | absent → `missing_required_parameter`; null/number → `invalid_type`; `''` → `empty_string`; whitespace-only **accepted** (all measured 2026-08-30) | mirrored (`imagePrompt`); cap enforced as 32000 UTF-16 code units | VERIFIED (§5.5.3) |
| I-3 | `images` (JSON) / `image`, `image[]` (multipart) | — E — | JSON: array of objects; multipart: file parts | required on E | the source image | JSON `image`/`image[]` → 400 `invalid_value` "Unknown parameter: 'image'. For application/json on /v1/images/edits, use 'images' (array)."; non-array `images` → 400 `invalid_type`; string member → 400 `invalid_type` param `images[0]`; absent → 400 `missing_required_parameter` (all measured 2026-08-29) | mirrored: JSON takes `images` only with those envelopes, multipart takes `image`/`image[]` (`imageInputsForOperation`) | VERIFIED (direct 2026-08-29, §5.5.2) |
| I-4 | `mask` | — E — | binary PNG, <4MB, same dims as `image` | absent | edit region | 400 / `invalid_request_error` / `mask` / — | sent as the tool's `input_image_mask` (`codexBackendImageGenerationTool`); the slot accepts a data URL and an https URL, and 500s on `{}` (never sent empty) | VERIFIED (tool-slot probe 2026-08-29: `slot_input_image_mask`, `slot_mask_https_url`, `slot_mask_empty_object`) |
| I-5 | `n` | G E | integer 1-10 | `1` (null = omission) | `data` array length | below/above → `integer_below_min_value` / `integer_above_max_value` naming bound and value; decimal/string/boolean → `invalid_type` naming the type (measured) | mirrored (`imageInteger`); multipart digit strings still parse | VERIFIED (§5.5.3) |
| I-6 | `size` | G E | `auto` or `WIDTHxHEIGHT`, both divisible by 16 | `auto` | output dimensions | `image_generation_user_error` / `size` / `invalid_value`: `Expected WIDTHxHEIGHT, for example '1824x1024'.` for `bogus`/`0x0`; `Width and height must both be divisible by 16.` for `9x9` (measured) | mirrored (`optionalImageSize`); on the default transport a canvas returned at another size is brought to the requested one (§5.5.1 `slot_size_edit_256`) | VERIFIED (§5.5.3) |
| I-7 | `quality` | G E | `low`\|`medium`\|`high`\|`auto` (**no `standard`/`hd`** on any live model) | `auto` | fidelity, cost, latency; echoed | string outside the set → `invalid_value` `Supported values are: 'low', 'medium', 'high', and 'auto'.`; non-string → `invalid_type` `expected one of … or 'auto', but got an integer instead` (measured) | mirrored (`imageEnum`); the dall-e aliases are refused | VERIFIED (§5.5.3) |
| I-8 | `style` | G — — | `vivid`\|`natural` (dall-e-3 only, and dall-e-3 is gone) | — | aesthetic | 400 / `invalid_request_error` / `style` / `unknown_parameter` (measured on gpt-image-2) | rejected whenever present, the same envelope (`rejectUnknownOpenAiImageParameters`) | VERIFIED (direct 2026-08-29, §5.5.2) |
| I-9 | `background` | G E V | `transparent`\|`opaque`\|`auto` (GPT-image only) | `auto` | alpha channel; echoed | 400 / `invalid_request_error` / `background` / — | sent on the tool; `transparent` with `jpeg` rejected locally (`validateOpenAiImageRequest`); `transparent` itself is refused by the backend image model (`gpt-image-2-codex`, `image_generation_user_error` / `invalid_value`) and that refusal is forwarded, streamed or not — **a capability gap**: the direct Responses image tool on `gpt-5.6-terra` accepts `transparent` and generates (measured 2026-08-30, 200); `opaque`/`auto` accepted | VERIFIED (`…background_transparent_unsupported…`; tool-slot probe 2026-08-29: `slot_background`, `slot_background_opaque`, `slot_background_auto`) |
| I-10 | `output_format` | G E | `png`\|`webp`\|`jpeg` | `png` | encoding; echoed | `invalid_value` listing the three in that order (measured) | mirrored | VERIFIED (§5.5.3) |
| I-11 | `output_compression` | G E | integer 0-100 | `100` (null = omission) | file size | range/type envelopes as `n` (measured: 101, -1, 1.5, "50") | mirrored; PNG + `<100` additionally `invalid_png_output_compression` (proxy rule, direct validation passed `50` with no format) | VERIFIED (§5.5.3) |
| I-12 | `moderation` | G E | `auto`\|`low` | `auto` | filter strictness | `invalid_value` `Supported values are: 'auto' and 'low'.` (measured) | mirrored; sent on the tool | VERIFIED (§5.5.3 + tool-slot probe) |
| I-13 | `input_fidelity` | — E — | `high`\|`low` (gpt-image-1/1.5, **not** `-mini`) | `low` | face/style preservation | on a generation: 400 `unknown_parameter` (measured on gpt-image-2); on `gpt-image-1-mini`: 400 `unknown_parameter` (measured) | generation → `unknown_parameter`; edit → sent on the tool, and the backend image model (`gpt-image-2-codex`) refuses it with `invalid_input_fidelity_model`, forwarded | VERIFIED (direct 2026-08-29 + tool-slot probe) |
| I-14 | `response_format` | G E V | — | — | — | 400 / `invalid_request_error` / `response_format` / `unknown_parameter` on every live model, **null included** (measured on gpt-image-2, chatgpt-image-latest, gpt-image-2-2026-04-21) | rejected whenever present; the `url` format and the `GET /v1/images/generated/{id}` store are removed (2026-08-29) | VERIFIED (direct 2026-08-29, §5.5.2) |
| I-15 | `stream` | G E | boolean (null = omission) | `false` | SSE completed image events | non-boolean → `invalid_type` `expected a boolean, but got a string instead` (measured) | mirrored in JSON; multipart `true`/`false` strings parse | VERIFIED (§5.5.3) |
| I-16 | `partial_images` | G E | integer 0-3 (null = omission) | `0` | partial events | range/type envelopes as `n` (measured: 4, -1) | mirrored for the envelope; 1-3 then refused as `unsupported_value` (proxy limitation) | VERIFIED (§5.5.3) |
| I-17 | `user` | G E V | string | absent | abuse signal | UNKNOWN | accepted (contract `:254`) | DOC? |
| I-18 | `x_proxy_image_route` | G E | object: `visual_class`, `geometry_mode`, `output_format`, `output_compression` | n/a | route-specific generation constraints | **direct: 400 `unknown_parameter`** (measured 2026-08-30) | **proxy-only extension, kept by decision** — the one key accepted here that the direct API refuses | VERIFIED (§5.5.3) |
| I-19 | *(behavioral)* body encoding | G E — | JSON or multipart on both (the direct API takes JSON `images` on edits, measured) | — | — | 400 on wrong encoding | JSON and multipart on both operations; variations gone | VERIFIED (direct 2026-08-29) |
| I-20 | *(behavioral)* unknown top-level field | G E | — | — | — | 400 `unknown_parameter` naming the key; on a generation `mask`, `images`, `input_fidelity` count as unknown (measured) | mirrored, JSON and multipart, `x_proxy_image_route` excepted | VERIFIED (§5.5.3) |

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
| A-14 | `temperature` | number **0..1** | (not applied) | sampling | 400 `invalid_request_error` `temperature: range: 0..1`; non-number or **null** → `temperature: Input should be a valid number` (measured 2026-08-30) | mirrored (`rejectInvalidAnthropicSampling`); a valid value is accepted and inert — the Claude CLI has no sampling control, and nothing echoes it | VERIFIED (§5.5.4) |
| A-15 | `top_p` | number 0..1 | (not applied) | nucleus | `top_p: range: 0..1` / `Input should be a valid number` (measured) | mirrored; accepted and inert | VERIFIED (§5.5.4) |
| A-16 | `top_k` | integer (negatives accepted by the direct API) | (not applied) | top-K truncation | non-integer → `top_k: Input should be a valid integer` (measured); `-1` accepted | mirrored; accepted and inert | VERIFIED (§5.5.4) |
| A-17 | `stop_sequences` | array of strings | `[]` | stops output; `stop_reason:"stop_sequence"` **and `stop_sequence` echoes the matched string** | 400 / `invalid_request_error` | **realized**: the output is cut before the first sequence and the turn reports `stop_reason: stop_sequence` with the matched `stop_sequence`, buffered and streamed (a split-across-deltas sequence is caught by a hold-back). Validation mirrors the direct API (`Input should be a valid array`, `stop_sequences.0: … valid string`) | VERIFIED (P-8, §5.5.5-A) |
| A-18 | `stream` | boolean | `false` | SSE events | 400 / `invalid_request_error` | supported | VERIFIED-weak (`anthropic.messages.stream`) |
| A-19 | `tools` | array of `{name, description, input_schema}` + server tools (`web_search`, `bash`, `text_editor`, `computer`, …) | absent | `tool_use` blocks; `stop_reason:"tool_use"` | 400 / `invalid_request_error` | **custom tools only**; server-tool entries UNKNOWN (probe P-35) | VERIFIED-weak (`anthropic.messages.tool_use`) |
| A-20 | `tools[].input_schema` | JSON Schema object, required | none | argument shape | 400 / `invalid_request_error` | preserved (contract `:311`) | DOC |
| A-21 | `tool_choice` | `{type:"auto"\|"any"\|"tool"\|"none", name?, disable_parallel_tool_use?}` | `{"type":"auto"}` when tools present | forcing | 400 / `invalid_request_error` | `none`/`any`/`tool` mapped (contract `:312`); **`auto` and `disable_parallel_tool_use` handling UNKNOWN** | DOC |
| A-22 | `thinking` | `{type:"adaptive"\|"enabled"\|"disabled", budget_tokens?, display?}` | UNKNOWN — recent models default to adaptive thinking; the doc example sends `{"type":"adaptive"}` explicitly | `thinking` content blocks; token spend | 400 / `invalid_request_error` | validated hard (enum, `budget_tokens ≥ 1024` and `< max_tokens`, container non-null) **then `budget_tokens` is deliberately not forwarded** — documented, with the CLI-inertness evidence, at contract `:317` | DOC |
| A-23 | `output_config.effort` | `low`\|`medium`\|`high`\|`xhigh`\|`max` | UNKNOWN | reasoning/effort spend | 400 / `invalid_request_error` | supported; **accepted-and-ignored on models that gate it (Haiku)** — documented (contract `:318`) | DOC? |
| A-24 | `output_config.format` | `{type:"json_schema", schema}` | absent | structured output | 400 / `invalid_request_error` | supported; **rejected together with tools unless `tool_choice:"none"`** (`normalizers.ts:110-125`) — a restriction the provider does not impose | DOC |
| A-25 | `output_config.task_budget` | `{type:"tokens", total ≥ 20000}` | UNKNOWN | total task token budget | 400 / `invalid_request_error` | validated; forwarding UNKNOWN (contract `:320`) | DOC? |
| A-26 | `output_format` (top level, deprecated) | object | absent | superseded by `output_config.format` | 400 / `invalid_request_error` | refused as an unknown key (`output_format: Extra inputs are not permitted`) since 7a8bef6 — not in the measured key set | VERIFIED (§5.5.4 key set) |
| A-27 | `metadata.user_id` | opaque string | absent | abuse detection | 400 / `invalid_request_error` | validated as the direct API validates it — `user_id` only, and a string — then not applied | VERIFIED (§5.5.5-A) |
| A-28 | `service_tier` | `auto`\|`standard_only` | `"auto"` | **`usage.service_tier` in the response** ( `"priority"` / `"standard"` ) | 400 / `invalid_request_error` | validated (`Input should be 'auto' or 'standard_only'`) and not applied. `usage.service_tier` is **not emitted**, where the direct API always emits it: a local CLI runs in no tier, and the proxy reports the runtime's numbers rather than inventing one | VERIFIED (§5.5.5-A) |
| A-29 | `speed` | `standard`\|`fast` | UNKNOWN (beta) | latency mode | 400 / `invalid_request_error` `speed: Extra inputs are not permitted` (measured without a beta header) | refused as an unknown key, as measured | VERIFIED (§5.5.4) |
| A-30 | `inference_geo` | string (beta) | UNKNOWN | inference region | 400 / `invalid_request_error` | validated (`must be one of ['global', 'us']`) and not applied; `usage.inference_geo` is not emitted, for the same reason as A-28 | VERIFIED (§5.5.5-A) |
| A-31 | `mcp_servers` | array of MCP server defs (beta) | absent | `mcp_tool_use` blocks | 400 `mcp_servers: Extra inputs are not permitted` (measured without a beta header) | refused as an unknown key, as measured | VERIFIED (§5.5.4) |
| A-32 | `container` | string (code-execution container id) | absent | container reuse | 400 / `invalid_request_error` | **refused for every value** with the direct API's own sentence — it allows `container` only alongside the code execution tool, which this proxy does not serve | VERIFIED (§5.5.5-A) |
| A-33 | `context_management` | object (beta) | absent | context editing/compaction | 400 `context_management: Extra inputs are not permitted` (measured without a beta header) | refused as an unknown key, as measured | VERIFIED (§5.5.4) |
| A-34 | `anthropic-version` header | e.g. `2023-06-01`; **required** | none — required | request is rejected without it | **400 / `invalid_request_error`** | **UNKNOWN — the proxy does not appear to require it**; a body missing the header succeeds here and fails there. Probe P-37 | DOC |
| A-35 | `anthropic-beta` header | array/CSV of beta ids | absent | unlocks beta fields | 400 / `invalid_request_error` on an unknown id | silently ignored. The direct API refuses an unknown beta id at the header (`Unexpected value(s) … for the anthropic-beta header`); the proxy serves no betas, so it neither honours nor refuses one | DOC (measured: direct refuses an unknown id) |
| A-36 | `x-api-key` / `Authorization` | credential header | none — required | 401 without it | 401 / `authentication_error` | proxy has its own local access gate; **the credential semantics differ by construction** (not applicable) | DOC |
| A-37 | *(behavioral)* unknown top-level field | — | — | — | 400 `invalid_request_error` `bogus_field: Extra inputs are not permitted`; also `messages.0.bogus`; reported after field validation (measured 2026-08-30) | mirrored (`rejectUnknownAnthropicKeys`) against the measured key set of 18 — `user_profile_id`, `mcp_servers`, `context_management`, `betas` are unknown to the direct API without a beta and unknown here | VERIFIED (§5.5.4) |

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

**The doc's own `response.completed` transcript is the reference for the echoed defaults** and shows: `temperature: 1.0`, `top_p: 1.0`, `store: true`, `truncation: "disabled"`, `parallel_tool_calls: true`, `tool_choice: "auto"`, `reasoning: {effort: null, summary: null}`, `metadata: {}`, `user: null`, `max_output_tokens: null`. Our echo matches on `temperature` (1) and `top_p` (1, constants since 2026-08-29 — the `0.98` of earlier revisions is gone with row R-11), differs on `top_logprobs` (0 vs null) and `prompt_cache_retention` ("24h" always), and adds `billing`, `moderation`, `max_tool_calls`, `frequency_penalty`, `presence_penalty` keys.

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

## 5.5 Tier A 실측 (2026-08-29) — DOC → VERIFIED

12회 호출, 실패 0. 모델 `gpt-5.6-terra` / `claude-sonnet-5`. 원본 캡처는
`artifacts/direct-api-captures/a5eee9af-fcf4-450c-a0b0-4b16cdfcefbf/`에 요청 본문·상태·응답 헤더·응답 바이트(스트림은 파싱 이전
와이어)로 남아 있고, 아래 값은 전부 그 바이트에서 읽은 것이다. 검출기는 실행 전에 **답이 반대인 입력**으로
6/6 자가 검사를 통과했다 — 기대와 일치하는 관찰일수록 계기를 먼저 의심해야 하기 때문이다.

| 프로브 | 관찰된 사실 | 증거 등급 |
| --- | --- | --- |
| P-1 | `/v1/responses` 최소 요청의 응답 키 집합에 `background`·`billing`·`moderation`·`prompt_cache_key`·`prompt_cache_retention`·`max_tool_calls`·`frequency_penalty`·`presence_penalty`가 포함된다 | VERIFIED |
| **P-2** | **`/v1/responses` 스트림은 `[DONE]`으로 끝나지 않는다.** 이벤트 9종(`response.created` → `response.completed`), `sequence_number`는 **0**에서 시작, `obfuscation` 필드가 기본으로 존재 | VERIFIED |
| P-3 | `/v1/chat/completions` 최소 응답의 키는 `choices,created,id,model,object,service_tier,system_fingerprint,usage`. `service_tier: "default"`, `system_fingerprint: null`. choice 키는 `finish_reason,index,message` — `logprobs`·`annotations`·`refusal`은 없다 | VERIFIED |
| **P-4** | **`/v1/messages` 스트림도 `[DONE]`이 없다.** `message_start`→`content_block_start`→`ping`→`content_block_delta`→`content_block_stop`→`message_delta`→`message_stop`, `ping` 이벤트가 실제로 온다. `message_start.usage.input_tokens`가 존재 | VERIFIED |
| P-5 | 미지의 최상위 필드: OpenAI 두 표면 모두 400 + `{type: invalid_request_error, param, code: unknown_parameter}`. **Anthropic은 400이지만 `param`도 `code`도 없다** — `{type, message}`뿐 | VERIFIED |
| P-6 | `anthropic-version` 헤더 누락 → 400 `invalid_request_error`, 메시지 `anthropic-version: header is required` | VERIFIED |
| P-7 | Chat `n: 2` 수용, `choices` 길이 2 | VERIFIED |
| P-8 | Anthropic `stop_sequences` 적중 시 `stop_reason: "stop_sequence"`, `stop_sequence: "ZZ"`로 에코 | VERIFIED |
| **P-9** | **Chat `stop`은 `gpt-5.6-terra`에서 미지원** — 400 `{code: unsupported_parameter, param: stop}`. 모델군별 호출 규약이며 벤치 row 정의에 반영해야 한다 | VERIFIED |
| P-10 | `/v1/responses`의 `stream_options.include_usage`는 400 `unknown_parameter` — Responses에는 없는 파라미터다 | VERIFIED |

### 이 실측이 즉시 드러낸 프록시 발산

**프록시의 `/v1/responses`가 `data: [DONE]`을 보낸다. direct는 보내지 않는다.** 이벤트 9종은 이름과
순서까지 일치하므로 차이는 종결자 하나뿐이다. 기존 스트림 단언이 종결자를 **양쪽 다** 보지 않았기 때문에
지금까지 드러나지 않았다. 근거는 두 캡처의 원본 바이트다 — direct는 위 run, 프록시는
`artifacts/api-captures/`의 같은 표면 교환.

Chat 표면에서는 `[DONE]`이 맞다(direct도 보낸다). Responses에서만 다르다.

### 5.5.1 Codex 백엔드 `image_generation` 도구 슬롯 실측 (2026-08-29)

`pnpm probe:codex-image-tool-slots` (`scripts/probe-codex-image-tool-slots.mjs`). 텍스트 전용 요청에
도구 선언만 실어 보내므로 이미지는 생성되지 않는다. 대조군이 먼저다 — 가짜 키와 가짜 enum이 **거절**되지
않으면 수용은 아무것도 증명하지 못한다. 결과 파일은 `artifacts/codex-backend-image-probe/codex-image-tool-slots.*.json`.

| 변형 | 관찰된 사실 | 등급 |
| --- | --- | --- |
| `control_bogus_field` | `tools[0].bogus_field_xyz` → 400 `unknown_parameter`. **선언은 엄격 검증된다** | VERIFIED |
| `control_bogus_enum_*` | `background`·`moderation`·`input_fidelity`의 enum 밖 값 → 400 `invalid_value`, 허용 값 목록이 메시지에 온다(`transparent/opaque/auto`, `auto/low`, `high/low`) | VERIFIED |
| `control_bogus_mask_shape` | `input_image_mask: "string"` → 400 `invalid_type` (object 기대) | VERIFIED |
| `slot_background` | `transparent` → 400 `image_generation_user_error` / `invalid_value` "Transparent background is not supported for this model." — 우리 `image-2` 거절 봉투(`http-server.ts:647`)의 출처 | VERIFIED |
| `slot_background_opaque`, `_auto` | 200 | VERIFIED |
| `slot_moderation` | `low` → 200 | VERIFIED |
| `slot_input_fidelity` | `high` → 400 `image_generation_user_error` / `invalid_input_fidelity_model` "The model 'gpt-image-2-codex' does not support the 'input_fidelity' parameter." — 백엔드 이미지 모델 이름이 여기서 드러난다 | VERIFIED |
| `slot_input_image_mask` | data URL → 200; `slot_mask_https_url` https URL → 200(스키마 수용, 실제 fetch는 미검증); `slot_mask_empty_object` `{}` → **500** `server_error` | VERIFIED |
| `slot_edit_combo` | `action: edit` + `opaque` + `moderation: low` + 마스크 + size/quality/output_format 동시 → 200 | VERIFIED |
| `slot_size_edit_256` (라이브 편집, 2026-08-30) | 256×256 원본을 `action: edit`, `size: 1024x1024`, `quality: low`로 편집 → 200이지만 백엔드가 돌려준 캔버스는 **1254×1254**/png (SSE `result`를 tee 해 실측, 15.3s). 슬롯은 수용되나 존중되지 않는다 — 2026-08-29의 부수 발견 재현. 프록시는 같은 턴에서 1024×1024/png로 답하고 `size`를 1024x1024로 에코(`realizeRequestedSize`, 기본 경로·스트림 모두) | VERIFIED |
| `body_temperature_*`, `body_top_p_0_5` | 요청 본문의 `temperature`(0.5, 1 모두)·`top_p` → 400 `{"detail": "Unsupported parameter: temperature"}`. 프록시는 보내지 않았고 `/v1/responses` 응답이 호출자 값을 그대로 에코했다 — 적용된 적 없는 값의 에코. 같은 날 direct API(`gpt-5.6-terra`) 실측: Chat은 `temperature` 0.5 → 400 `unsupported_value`("Only the default (1) value is supported"), 1 → 200, `top_p` 0.5 → 400 `unsupported_parameter`, 1 → 200; Responses는 `temperature` 0.5 → 400(code null), 1 → 200, `top_p`는 **1이어도** 400(code null). 프록시는 이 봉투를 표면별로 그대로 미러링하고 에코는 상수 1로 고정했다(행 13·14·R-10·R-11) | VERIFIED |

### 5.5.2 Images 모델 네임스페이스 direct 실측 (2026-08-29)

`GET /v1/models`의 이미지 모델: `chatgpt-image-latest`, `gpt-image-1`, `gpt-image-1-mini`, `gpt-image-1.5`, `gpt-image-2`,
`gpt-image-2-2026-04-21`. **`dall-e-2`·`dall-e-3`는 없다.** 아래는 전부 생성 없이 거절된 호출(`n: 0` 등으로 검증 단계에서 멈춤).

| 요청 | direct 응답 | 등급 |
| --- | --- | --- |
| `model` 생략 | 400 `invalid_request_error` / `model` / `missing_required_parameter` | VERIFIED |
| `model: null` / `123` | 400 `invalid_type` "expected a string, but got null / an integer instead" | VERIFIED |
| `model: "dall-e-2"`, `"dall-e-3"`, `"image-2"`, `"foo-model"`, `""` | 400 `image_generation_user_error` / `model` / `invalid_value` "The model 'X' does not exist." | VERIFIED |
| `gpt-image-2` + `response_format` (`url`, `null` 모두), `chatgpt-image-latest`·`gpt-image-2-2026-04-21` + `response_format` | 400 `unknown_parameter` | VERIFIED |
| `gpt-image-2` generations + `input_fidelity`, `gpt-image-1-mini` + `input_fidelity` | 400 `unknown_parameter` | VERIFIED |
| `gpt-image-2` + `style: vivid` | 400 `unknown_parameter` | VERIFIED |
| `gpt-image-2` + `user` | 수용(다음 검증인 `n`에서 거절됨) | VERIFIED |
| edits JSON `image` / `image[]` | 400 `invalid_value` "Unknown parameter: 'image'. For application/json on /v1/images/edits, use 'images' (array)." | VERIFIED |
| edits JSON `images: {}` / `images: ["str"]` / `images` 생략 | 400 `invalid_type` (param `images` / `images[0]`) / `missing_required_parameter` | VERIFIED |
| edits JSON `images: [{image_url}]` + `mask: {image_url}` + `input_fidelity` | 수용(`n`에서 거절됨) | VERIFIED |
| `POST`/`GET /v1/images/variations` (어느 모델이든) | **404**, 본문 없음, `x-content-type-options: nosniff` — `/v1/images/foo`·`/v1/nope`도 동일 | VERIFIED |

프록시는 이 표를 그대로 미러한다(행 I-1·I-3·I-8·I-13·I-14·I-19). 미측정: `model`이 boolean/object/array일 때의 정확한 문구(같은 패턴으로 추정), `images: null`.

### 5.5.3 Images 검증 봉투 direct 실측 (2026-08-30)

E2E 패리티 비교가 `n: 0` 봉투 불일치를 드러내 추가로 잰 것. 전부 `gpt-image-2`, 무효값이라 생성 없음 — 단 공백 프롬프트 `"   "`는 **수용되어 생성**됐다(1회 과금). 프록시는 아래를 그대로 미러한다(행 I-2·I-5·I-6·I-7·I-10·I-11·I-12·I-15·I-16·I-18·I-20).

| 요청 | direct 응답 |
| --- | --- |
| `n: 0` / `11` | `integer_below_min_value` "Invalid 'n': integer below minimum value. Expected a value >= 1, but got 0 instead." / `integer_above_max_value` "… <= 10, but got 11 instead." |
| `n: 1.5` / `"2"` / `true` | `invalid_type` "Invalid type for 'n': expected an integer, but got a decimal number / a string / a boolean instead." |
| `output_compression: 101` / `-1` / `1.5` / `"50"` | 같은 패턴(`>= 0`, `<= 100`) |
| `partial_images: 4` / `-1` | 같은 패턴(`>= 0`, `<= 3`) |
| `quality: "ultra"` / `""` | `invalid_value` "Invalid value: 'ultra'. Supported values are: 'low', 'medium', 'high', and 'auto'." — `standard`/`hd`는 목록에 없다 |
| `quality: 1` | `invalid_type` "Invalid type for 'quality': expected one of 'low', 'medium', 'high', or 'auto', but got an integer instead." |
| `output_format: "gif"` / `moderation: "bogus"` / `background: "bogus"` | `invalid_value` — 목록은 각각 `'png', 'webp', and 'jpeg'` / `'auto' and 'low'` / `'transparent', 'opaque', and 'auto'` |
| `size: "bogus"` / `"0x0"` | `image_generation_user_error` / `size` / `invalid_value` "Invalid size 'bogus'. Expected WIDTHxHEIGHT, for example '1824x1024'." |
| `size: "9x9"` | 같은 봉투, "Width and height must both be divisible by 16." |
| `prompt` 생략 / `null` / `123` / `""` / `"   "` | `missing_required_parameter` / `invalid_type` (null, an integer) / `empty_string` / **수용(생성)** |
| `stream: "yes"` | `invalid_type` "expected a boolean, but got a string instead" |
| `bogus_field: 1`, generations의 `mask`·`images`·`x_proxy_image_route` | `unknown_parameter` naming the key |
| `user: 123` | 수용(다음 검증에서 거절) |
| edits `images: []` / `null` / `mask: null` | `empty_array` / `invalid_type` "got null instead" / `mask` null은 생략 |
| null: `n`·`output_compression`·`partial_images`·`quality`·`size`·`stream` | 전부 생략으로 취급(다음 필드의 오류가 보고됨) |
| 순서 (두 결함을 한 본문에) | model → 미지 키 → prompt → images → n → 나머지(`output_compression`·`quality` 등, 상호 순서 미측정) |

추가 실측 (2026-08-30 오후): `model`이 `1.5`/`true`/`{}`/`[]` → `invalid_type` "got a decimal number / a boolean / an object / an array instead"; `quality`가 `true`/`{}`/`[]` → 같은 패턴("expected one of … or 'auto', but got …"); `size: 123` → `invalid_type` "expected a string, but got an integer instead"; JSON `n: "abc"` → "got a string instead".
**multipart edits** (실제 폼, `n=0` 또는 `output_compression=101` tripwire): `style`·`bogus_field`·`response_format` → `unknown_parameter`; 파트 이름 `images` → `invalid_value` "Unknown parameter: 'images'. For multipart/form-data use 'image' or 'image[]'."; `n=abc`·`n=2.5`·`output_compression=abc` → `invalid_type` "expected an integer, but got a string value that could not be converted into an integer."; `quality=ultra`·`quality=`(빈 값) → JSON과 같은 `invalid_value`; 순서: `quality`가 `output_compression`보다 먼저, `size`는 `output_compression` 뒤, `mask` 파일은 `size` 검사를 막지 않음.
미측정: multipart `stream=yes`(검증 단계에서 `output_compression`보다 뒤라 tripwire로는 판정 불가 — 프록시는 `invalid_type`으로 거절), `output_compression < 100` + PNG의 최종 판정(검증 단계는 통과).

### 5.5.4 Anthropic Messages 샘플링 필드 direct 실측 (2026-08-30)

`claude-sonnet-5`, `max_tokens: 1`. 봉투는 전부 `{"type":"error","error":{"type":"invalid_request_error","message":…},"request_id":…}` — `param`·`code` 없음(P-5와 일치).

| 요청 | direct 응답 |
| --- | --- |
| `temperature: 1.5` / `-0.1` | 400 "temperature: range: 0..1" |
| `temperature: "abc"` / **`null`** | 400 "temperature: Input should be a valid number" — Anthropic에서 null은 생략이 아니다 |
| `top_p: 1.5` | 400 "top_p: range: 0..1" |
| `top_k: 1.5` | 400 "top_k: Input should be a valid integer" |
| `top_k: -1` | **수용**(1토큰 생성) |
| `bogus_field: 1` | 400 "bogus_field: Extra inputs are not permitted" |

프록시는 세 필드를 같은 문구로 검증하고 유효값은 수용하되 적용하지 않는다(claude CLI에 샘플링 노브 없음, 응답에 에코 필드 없음).

**최상위 키 집합 (같은 날, 각 키에 틀린 타입 `1`을 보내 판별)**: 아는 키 18개 — `model`·`messages`·`max_tokens`·`cache_control`("Input should be an object")·`container`·`inference_geo`·`metadata`·`output_config`·`service_tier`("Input should be 'auto' or 'standard_only'")·`stop_sequences`·`stream`("Input should be a valid boolean")·`system`·`temperature`·`thinking`·`tool_choice`·`tools`·`top_k`·`top_p`. 모르는 키 → "<key>: Extra inputs are not permitted": `user_profile_id`(SDK 타입엔 있음)·`mcp_servers`·`context_management`·`betas`·`speed`·`effort`·`seed`·`response_format`·`instructions`·`input`·`n`·`user`·`logprobs`·`stop`. 순서: `max_tokens: Field required`가 미지 키보다 먼저, `temperature: range: 0..1`도 미지 키보다 먼저, 미지 키 둘이면 본문 순서의 첫 키; `messages[0].bogus` → "messages.0.bogus: Extra inputs are not permitted"; `bogus: null`도 거절. 프록시는 이 집합을 그대로 미러한다(A-37).

### 5.5.5-A Anthropic Messages 나머지 행 direct 실측 (2026-08-30)

`scripts/probe-text-surface-keys.mjs --phase values --only messages`. 봉투는 `{type:"error", error:{type, message}}` — `param`·`code` 없음.

| 요청 | direct 응답 |
| --- | --- |
| `stop_sequences: "ZZ"` / `[1]` / `[]` | `stop_sequences: Input should be a valid array` / `stop_sequences.0: Input should be a valid string` / **수용** |
| `stop_sequences: ["ZZ"]` + `AAZZBB`를 말하게 하는 프롬프트 | 200, `content: [{text:"AA"}]`, `stop_reason: "stop_sequence"`, `stop_sequence: "ZZ"` (P-8) — **시퀀스 앞에서 자른다** |
| `metadata: {user_id:"…"}` / `{user_id:7}` / `{bogus:"x"}` | 수용 / `metadata.user_id: Input should be a valid string` / `metadata.bogus: Extra inputs are not permitted` |
| `service_tier: "standard_only"` / `"bogus"` | 수용, 응답 `usage.service_tier: "standard"` / `service_tier: Input should be 'auto' or 'standard_only'` |
| `inference_geo: "us"` / `"bogus-geo"` | 수용, 응답 `usage.inference_geo: "us"` / `inference_geo: must be one of ['global', 'us']` |
| `container: "container_x"` | `container: Container identifier can only be provided when using the code execution tool` — **코드 실행 도구 없이는 어떤 값도 거절** |
| `anthropic-beta: bogus-…` 헤더 | 400 `Unexpected value(s) … for the anthropic-beta header.` |

**프록시 라이브 검증 (2026-08-30, 실제 claude 런타임)**: 같은 프롬프트·같은 `stop_sequences: ["ZZ"]`를 프록시에 보내
버퍼 경로와 스트림 경로 모두 `content: [{text:"AA"}]`, `stop_reason: "stop_sequence"`, `stop_sequence: "ZZ"` — P-8의 direct 응답과 필드 단위로 일치.
스텁 백엔드는 게이트를 증명하고, 이 실행은 배선을 증명한다.

**direct의 `usage`는 항상 `service_tier`와 `inference_geo`를 싣는다.** 프록시는 싣지 않는다 — 로컬 CLI는 어느 티어·리전에서도 돌지 않으며,
이 프록시의 규칙은 런타임의 숫자를 보고하는 것이지 지어내는 것이 아니다. 계약의 "Anthropic accepted-and-not-applied keys" 행에 명시.

### 5.5.5 Chat Completions 옵션 규칙 direct 실측 (2026-08-30)

`scripts/probe-text-surface-keys.mjs`(무료 3단계: `--phase keys`는 키마다 **불가능한 타입**을 보내 known/unknown을 가르고,
`--phase values`는 유효값으로 모델군 지원 여부를, `--phase order`는 두 결함을 실은 본문으로 **보고 순서**를 잰다) + 경계 프로브.
모델 `gpt-5.6-terra`. 생성이 일어날 수 있는 본문에는 **뒤에 검사되는 확실한 무효값**(`temperature: 0.5`)을 트립와이어로 같이 실었고,
트립와이어 단독 대조를 먼저 통과시켰다 — 트립와이어가 뜨면 앞 필드는 유효하다는 뜻이다. 원자료는 `artifacts/direct-api-captures/`.

**키 집합 (34개)**: `model`·`messages`·`frequency_penalty`·`function_call`·`functions`·`logit_bias`·`logprobs`·
`max_completion_tokens`·`max_tokens`·`metadata`·`moderation`·`n`·`parallel_tool_calls`·`prediction`·`presence_penalty`·
`prompt_cache_key`·`prompt_cache_options`·`prompt_cache_retention`·`reasoning_effort`·`response_format`·`safety_identifier`·
`seed`·`service_tier`·`stop`·`store`·`stream`·`stream_options`·`temperature`·`tool_choice`·`tools`·`top_logprobs`·`top_p`·
`user`·`verbosity`. **모르는 키** → 400 `unknown_parameter` `Unknown parameter: '<key>'.`: `audio`·`modalities`·
`web_search_options`, 그리고 **`reasoning`·`text`** — 지금까지 프록시가 `reasoning_effort`/`verbosity`의 대체 철자로 받아온
두 키다(행 44·46). direct가 거절하는 본문이 프록시에서만 성공하고 있었다.

| 요청 | direct 응답 |
| --- | --- |
| `stop`·`logit_bias`·`prediction`·`max_tokens` | 400 `unsupported_parameter` — 값과 무관하게 이 모델군이 거절. `max_tokens`만 문구가 다르다(`Use 'max_completion_tokens' instead.`) |
| `frequency_penalty`·`presence_penalty`·`logprobs` | **추론 중에만** 400 `unsupported_parameter`. `reasoning_effort: none`이면 200이고 `logprobs`는 실제 값이 온다 |
| `n: 0` / `64` / `"2"` | `integer_below_min_value` (>= 1) / `integer_above_max_value` (**<= 8**) / `invalid_type` |
| `max_completion_tokens: 0` | `integer_below_min_value` (>= 1) |
| `top_logprobs: -1` / `21` / `logprobs` 없이 `1` | `integer_below_min_value` (>= 0) / **code 없음** `Invalid value for 'top_logprobs': must be less than or equal to 5.` / **code 없음** `The 'top_logprobs' parameter is only allowed when 'logprobs' is enabled.` |
| `frequency_penalty: 3` / `presence_penalty: -3` (effort none) | `decimal_above_max_value` (<= 2) / `decimal_below_min_value` (>= -2) — 범위는 -2..2 |
| `response_format: {type:'json_schema'}` / `{type:'json_schema', json_schema:{}}` | `missing_required_parameter` `response_format.json_schema` / `response_format.json_schema.name` — 프록시는 스키마 없이 JSON 모드로 돌고 있었다 |
| `stream_options: {bogus:1}` | `unknown_parameter` `stream_options.bogus` — 중첩 객체도 엄격 |
| `model: null` (Chat) | `you must provide a model parameter` (없음·빈 문자열과 같은 봉투). **Responses는 다르다**: `invalid_type` `model` "got an object instead" |
| `model: 7` (Chat) | 400 `We could not parse the JSON body of your request.` — 유효한 JSON인데 파서 오류를 답한다. **미러하지 않는다**(벤더 버그로 보이며, 프록시는 `invalid_type`) |
| `metadata` 17쌍 / 값 600자 / 키 70자 / 값이 정수 | `object_above_max_properties` / `string_above_max_length`(<= 512) / `property_name_above_max_length`(<= 64, **메시지에서는 키를 `'kkk...kkk'`로 줄이고 `param`에는 통째로 싣는다**) / `invalid_type` |
| `reasoning_effort` | 이 모델군의 집합은 `none`·`low`·`medium`·`high`·`xhigh`. `max`도 **`minimal`도** 밖이며 셋 다 `unsupported_value` + 지원 목록. 값이 객체면 파이썬 표기로 되비친다(`{'__probe__': 'wrong type'}`) |
| `service_tier` | 목록은 `auto`·`default`·`fast`·`flex`·`priority`. 밖이면 `invalid_value`, 타입이 틀리면 `invalid_type`(목록 동봉). 에코는 **요청값이 아니라 해석된 값**이다: `fast`·`priority` → **`priority`**, `flex` → `flex`, `auto`·`default`·생략 → `default` (Chat·Responses 동일). Responses도 목록 밖 값을 `invalid_value`로 거절한다 |
| `verbosity: bogus` | `invalid_value` + `'low', 'medium', and 'high'` |
| `response_format: {}` / `{type:'bogus'}` | `missing_required_parameter` `response_format.type` / `invalid_value` + `'json_object', 'json_schema', and 'text'` |
| `tools: [{type:'function'}]` / `function`에 name 없음 | `missing_required_parameter` `tools[0].function` / `tools[0].function.name` |
| `functions: [{parameters}]` | `missing_required_parameter` `functions[0].name` |
| `tool_choice: 'bogus'` / `{type:'bogus'}` / `{type:'function',function:{}}` / `7` | `invalid_value`(모드 3개) / `missing_required_parameter` `tool_choice.function` (**type과 무관하게 `function`을 요구한다**) / `tool_choice.function.name` / `invalid_type` |
| `prompt_cache_retention: 'in_memory'` | 400 **code 없음** `This model is compatible only with 24h extended prompt caching` (`24h`는 200) |
| `prompt_cache_options: {bogus:1}` | `unknown_parameter` `prompt_cache_options.bogus` — 중첩 객체도 엄격하다 |
| `moderation: {}` / `{model:'omni-moderation-latest'}` | `missing_required_parameter` `moderation.model` / 200 + 응답에 `moderation` 결과 객체가 붙는다 |
| `messages` 없음 / `[]` / 문자열 / `[7]` | `missing_required_parameter` / `empty_array` / `invalid_type`(`an array of objects`) / `invalid_type` `messages[0]` |
| `messages[0].role` 없음 / `'bogus'` | `missing_required_parameter` / `invalid_value` + `'system', 'assistant', 'user', 'function', 'tool', and 'developer'` |
| `messages[0].content` 없음 / `null` / `7` | **없음·null 둘 다 수용** (트립와이어가 떴다) / `invalid_type` `expected one of a string or array of objects` |
| `model` 없음 / `''` | 둘 다 400 `you must provide a model parameter`, **`param`도 `code`도 없다** (Responses는 `missing_required_parameter` `model`로 다르다) |
| `model: 'gpt-does-not-exist'` | **404** `model_not_found` |
| `metadata`·`store`·`user`·`safety_identifier`·`seed`·`prompt_cache_key`·`prompt_cache_options`·`parallel_tool_calls`·`verbosity` | 전부 200. Chat 응답 키는 `choices,created,id,model,object,service_tier,system_fingerprint,usage`뿐이라 되비칠 자리가 없다(`system_fingerprint`는 `null`) |

**보고 순서 — 측정한 것이지 규칙이 아니다.** 첫 초안은 "알파벳 키 순서"라고 적었고 그건 **틀렸다**(독립 10쌍 중 5쌍이 반증).
확정 절차: 같은 종류(타입 결함)로 고정한 뒤 **비교 정렬**로 전순서를 유도했다 — 27키, 107콜, 두 본문 순서로 보내 같은 답이 나오는지
**대칭성 6/6** 확인(먼저 쓴 키를 답하는 API였다면 정렬은 입력 순서를 그대로 뱉었을 것), 인접쌍 27개 재검증 0실패.

1. **필수값의 존재**: `model` → `messages` (둘 다 미지 키보다 앞).
2. **미지 키** (`unknown_parameter`).
3. **필드** — 유도된 순서(알파벳 아님):
   `messages` → `functions` → `function_call` → `tools` → `tool_choice` → `parallel_tool_calls` → `max_completion_tokens` → `n` →
   `temperature`(타입) → `top_p`(타입) → `presence_penalty` → `frequency_penalty` → `logprobs`(타입) → `top_logprobs` → `user` →
   `seed` → `moderation` → `safety_identifier` → `prompt_cache_options` → `prompt_cache_key` → `prompt_cache_retention` →
   `response_format` → `service_tier` → `max_tokens` → `reasoning_effort` → `logit_bias` → `stop` → `stream` → `stream_options` →
   `store` → `metadata` → `prediction` → `verbosity`.
4. **모델 능력 값 검사**(3 전부보다 뒤): `temperature`/`top_p`의 **값**, 추론 중 `presence_penalty`/`frequency_penalty`/`logprobs`.

**결함의 종류가 순서를 바꾼다**: `stop`(파라미터 거절)은 `temperature: 0.5`(값 거절)를 이기지만 `temperature: 'x'`(타입)에게는 진다.
그래서 "키마다 하나의 자리"가 아니다. 위 배치는 측정한 쌍 전부를 재현하는 순서이며, 그 이상은 주장하지 않는다 —
`pnpm e2e:text:parity`가 쌍들을 행으로 싣고 있어 드리프트는 조용히 지나가지 않는다.

측정된 쌍(계기에 전부 실려 있음): model↔미지키, messages↔미지키, 미지키↔{n 타입, `messages: []`, stop, service_tier enum,
reasoning_effort, n 하한}, n↔stop, n↔temperature(값), stop↔temperature(값), seed↔service_tier, n↔metadata, max_completion_tokens↔logprobs,
messages↔metadata, n↔moderation, stream↔store, tools↔top_logprobs, user↔verbosity, functions↔function_call,
prompt_cache_options↔prompt_cache_key, max_tokens↔store, stop↔stream_options, stop↔verbosity, metadata↔prediction,
logit_bias↔verbosity, metadata↔temperature(값), verbosity↔logprobs(값).

**의도된 발산 1건**: direct는 `gpt-5.6-terra`·`gpt-5.6-sol`의 Chat에서 **함수 도구와 `reasoning_effort`의 조합 자체를 거절한다**
(`Function tools with reasoning_effort are not supported for <model> in /v1/chat/completions`; `gpt-5.5`는 수용). 프록시의 백엔드는
이 조합을 실제로 실행하므로 미러하지 않는다 — 실현 가능한 것을 거절하는 쪽이 규칙 위반이다. `spec/declared-divergences.json`에 등록.

**범위 밖에서 드러난 것**: 위 `content` 행이 이 저장소의 기존 전제를 뒤집었다. 프록시는 `content` 없음/`null`을 400으로 거절해 왔고
(테스트 3건이 그 전제를 지키고 있었다) direct는 수용한다. 이번 커밋에서 함께 고쳤다.

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
| P-17 | B | ~~Images generations with `dall-e-2`, `response_format` omitted~~ — settled 2026-08-29 without a generation: `dall-e-2` does not exist and `response_format` is refused on every live model (§5.5.2) | — | I-14 | 0 |
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
