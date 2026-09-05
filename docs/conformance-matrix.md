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
| 28 | `response_format` | `{type:"text"\|"json_object"\|"json_schema"}` | `{"type":"text"}` | forces JSON / schema-valid output | 400 / `invalid_request_error` / `response_format` / — | supported for `json_object` + `json_schema` (`normalizers.ts:35-38`); `strict` and schema `name` parsed. Both go through a **runtime schema**, not a prompt sentence: `json_schema` carries the client's schema and `json_object` carries `{"type":"object"}` — the direct API forces a top-level object here (asked for `[1,2,3]` it answered `{"0":1,"1":2,"2":3}`, measured 2026-09-02). Output that is not a JSON object is rejected at the response boundary rather than passed through — for `json_object` only, since a client `json_schema` declares its own root (a schema rooted at an array is handed to the runtime and its arrays are accepted back). A `json_schema` answer is validated against the client's schema at the response boundary (`ajv`, draft 2020-12; §7 row 10) under `strict: true` — the promise the direct API itself enforces — and refused outside it; without `strict` the direct API is best-effort too and the answer is delivered. What cannot be judged passes: an uncompilable or `$async` schema, a boolean-root schema (`true`/`false`), a `$ref` outside the schema, a VIOLATION found in a text carrying a number a double does not hold exactly — decided by value, so `2^53` and `1e16` are judged while `0.3` and `1e-999` are not, with zero and more than 4096 significant digits decided without arithmetic so an exponent like `1e-999999999` cannot exhaust BigInt (round 20; round 21: the significant digits, so `0.000…0` and `1000…0e-4096` are the exact values they spell, not padding read as inexactness); a conforming answer is delivered either way (the direct API accepts `$async` and `$id`/`$ref` at request time, measured 2026-09-04; its answer to a boolean-root schema is **unmeasured**). **Sent together with `tools` the format is NOT enforced**: the one structured-output channel is carrying the tool wrapper, so the client's schema does not reach the runtime and the turn's `text` is returned as it stands. The direct API does serve the pair and honour the schema (measured 2026-09-03), so this is a divergence, declared here rather than faked — supporting it needs a second channel or a wrapper that isolates client data, which is a design change and not a bug fix. Numbers in a runtime-enforced answer are published as the bytes the runtime wrote — an id of `9007199254740993` is not rounded to `…992` | VERIFIED (`openai.chat.json_schema.schema_exact`, `option-is-a-promise`) |
| 29 | `tools` | array of `{type:"function", function:{name, description, parameters, strict}}` | `[]` / absent | enables `message.tool_calls`, `finish_reason:"tool_calls"` | 400 / `invalid_request_error` / `tools[i].function.name` / — | supported (name/description/parameters preserved); contract `:38` | VERIFIED (`openai.chat.tool_call.schema_exact`) |
| 30 | `tools[].function.strict` | boolean | `false` | strict schema adherence on arguments | UNKNOWN | read on all three surfaces from each surface's own location only — as is every tool member (`name`, `description`, `parameters`, `strict`: Chat under `function`, Responses at the top level, Messages at the top level), since round 21 found the others still cross-read, so a schema in the other surface's place was what `strict` enforced and a nested `function.name` shadowed a Responses tool's declared name. Measured 2026-09-05 (M9): Chat ignores a top-level `parameters`/`description` (200) and reports a top-level `name` alone as `tools[0].function.name` missing; Responses ignores a stray `function` member (200) and reports a name inside it alone as `tools[0].name` missing — the proxy answers the same. **Declared unenforced:** the direct Chat/Responses strict-schema validation family (`invalid_function_parameters`, e.g. `strict: true` with no `function.parameters` → 400 "'additionalProperties' is required to be supplied and to be false") is not mirrored; such a tool runs unjudged and handed to the response path: a forced call's arguments outside the tool's schema are refused (502) only under `strict: true`; without it the direct APIs deliver whatever the model wrote and so does the proxy (§7 row 8, round 18). The runtime schema channel is used either way. The direct API's own envelope for a bad `strict` value is unmeasured | VERIFIED (`backend-contract.test` r18 strict) |
| 31 | `tool_choice` | `"none"`\|`"auto"`\|`"required"`\|`{type:"function", function:{name}}` | `"auto"` when tools present, `"none"` when absent | forces / suppresses a call | 400 / `invalid_request_error` / `tool_choice` / — | mirrored: the three modes and the `{type:'function', function:{name}}` object, with the direct API's `invalid_value` / `invalid_type` / `missing_required_parameter` envelopes for everything else. The silent `auto` fallback is gone. `required` is enforced by the **runtime schema** for any number of tools — the status enum is locked to `tool_calls`, `toolCalls` has `minItems: 1`, and the call's `name` is limited to the declared tools; a turn that comes back without a call is rejected, never repaired. Matches the direct API, which calls a tool against a prompt begging it not to, and calls again on a continuation that already has the answer (measured 2026-09-02) | VERIFIED (§5.5.5, `option-is-a-promise`) |
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
| R-8 | `max_output_tokens` | integer | `null` (model max) | caps output; `status:"incomplete"` + `incomplete_details.reason:"max_output_tokens"` | 400 / `invalid_request_error` / `max_output_tokens` / — | parsed but the cap itself is **not enforced**; echoed in the body. No runtime channel exists for the cap (row A-2). But when the backend reports the limit — the `codex-backend` transport on `response.incomplete`, Claude Code on `stop_reason: "max_tokens"` — the response is `status: "incomplete"`, `incomplete_details: {reason: "max_output_tokens"}`, `completed_at: null`, a `function_call` item with `status: "incomplete"`, and the stream ends in `response.incomplete`, as the direct API answers (measured 2026-09-04, `review-artifacts/stage2/report.md` M6) | VERIFIED (`output-limit-projection.test`, `codex-backend-transport.test`) |
| R-9 | `max_tool_calls` | integer | `null` | caps built-in tool calls | UNKNOWN | **silently ignored**; echoed as hard `null` (`http-server.ts:2007`) | DOC |
| R-10 | `temperature` | number 0-2 | `1` (caveat; confirmed by the doc's SSE transcript showing `"temperature":1.0`) | sampling | 400 / `invalid_request_error` / `temperature` / — | **rejected unless `1`** (null = omission): 400 `param: temperature`, `code: null`, `Unsupported parameter: 'temperature' is not supported with this model.`; echoed as the constant `1` | VERIFIED (direct `gpt-5.6-terra` 2026-08-29: 0.5 → 400 code null, 1 → 200) |
| R-11 | `top_p` | number 0-1 | `1` (doc SSE transcript shows `"top_p":1.0`) | nucleus | 400 / `invalid_request_error` / `top_p` / — | **rejected whenever present**, `1` included: 400 `param: top_p`, `code: null`, `Unsupported parameter: 'top_p' is not supported with this model.`; echoed as the constant `1` (was `0.98`) | VERIFIED (direct 2026-08-29: 0.5 → 400, **1 → 400 too** — the Responses surface refuses the parameter, not the value) |
| R-12 | `top_logprobs` | integer 0-20 | `null` (doc) | logprobs on output text | 400 / `invalid_request_error` / `top_logprobs` / — | ignored; echoed as **`0`** (`http-server.ts:2024`) where the provider echoes `null` | DOC |
| R-13 | `stream` | boolean | `false` | named SSE events | 400 / `invalid_request_error` / `stream` / — | supported | VERIFIED (`openai.responses.stream`) |
| R-14 | `stream_options.include_obfuscation` | boolean | `true` | `obfuscation` on delta events | UNKNOWN | parsed via the shared reader (`normalizers.ts:64`) | DOC |
| R-15 | `stream_options.include_usage` | — | **not a documented Responses field** (the Responses `stream_options` object documents only `include_obfuscation`) | — | provider: UNKNOWN — likely 400 unknown parameter | **proxy extension**: parsed and honored (contract `:117`). Responses `usage` is on `response.completed` regardless | DOC? |
| R-16 | `text.format` | `{type:"text"\|"json_object"\|"json_schema", name, schema, strict}` | `{"type":"text"}` | structured output | 400 / `invalid_request_error` / `text.format` / — | supported (`normalizers.ts:65-68`), through the same runtime schema as chat row 28 — `json_object` carries `{"type":"object"}` and non-object output is rejected; a client `json_schema` keeps its own root, is validated against that schema at the response boundary under `strict: true` (chat row 28, §7 row 10) and is published with its numbers verbatim. **Not enforced together with `tools`**, same as chat row 28 | VERIFIED (`option-is-a-promise`, `wrapper-root-and-lexeme`) |
| R-17 | `text.verbosity` | `low`\|`medium`\|`high` | `medium` (**UNKNOWN**) | output length | 400 / `invalid_request_error` / `text.verbosity` / — | supported | DOC? |
| R-18 | `tools` | array; `function` tools plus **built-ins** (`web_search`, `file_search`, `code_interpreter`, `image_generation`, `computer_use`, `mcp`) | `[]` | tool calls in `output` | 400 / `invalid_request_error` / `tools[i]` / — | **function tools only**; built-in and MCP tool entries are UNKNOWN — probably dropped silently by `readOpenAiTools`, so a `web_search` request runs as a plain turn (P-35) | VERIFIED for function tools (`openai.responses.tool_call`) |
| R-19 | `tool_choice` | `"none"`\|`"auto"`\|`"required"`\|`{type:"function", name}`\|`{type:"<builtin>"}` | `"auto"` | forcing | 400 / `invalid_request_error` / `tool_choice` / — | mapped; unknown values fall back to `auto` (same divergence as chat row 31); echoed via `responseToolChoice`. `required` is schema-enforced as in chat row 31 | VERIFIED (`option-is-a-promise`) |
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
| A-2 | `max_tokens` | integer, **required** | none | caps output; `stop_reason:"max_tokens"` | 400 / `invalid_request_error` | accepted and required, but **the cap is NOT enforced**: a turn longer than `max_tokens` is returned whole with `stop_reason:"end_turn"` and a `usage.output_tokens` above the cap, where the direct API truncates and reports `stop_reason:"max_tokens"`. Neither runtime has a channel for it — codex has no upstream cap, and `CLAUDE_CODE_MAX_OUTPUT_TOKENS` makes the CLI **error** and discard the partial text instead of truncating (measured 2026-09-02 at 16 and 32). Trimming in the response path would leave `usage.output_tokens` reporting tokens that were generated and billed, so the cap is declared unenforced rather than faked. **`0` accepted** on the claim that the direct API accepts it (contract `:316`) — an unverified claim about the provider When the runtime does report the limit, `stop_reason: "max_tokens"` is reported even with a `tool_use` block present — the direct API keeps the block and its complete members (measured 2026-09-04, M6); the proxy's buffered writer publishes the complete top-level members of the fragment, each as the bytes the runtime wrote (`completeTopLevelMembers`, §7 row 8), and the stream carries the fragment verbatim in a block left open (`7b-8b`) | VERIFIED (measured 2026-09-02, 2026-09-04) |
| A-3 | `messages` | array, `minItems: 1`, required | none | the conversation | 400 / `invalid_request_error` | supported | VERIFIED-weak (same caveat as A-1) |
| A-4 | `messages[].role` | `user`\|`assistant`, plus `system` in the positions §5.5.7 measures | none | turn attribution | 400 / `invalid_request_error` | supported; `system` carries POSITION rules decided in their own late phase — index 0 is 400 with guidance toward the top-level parameter, and elsewhere a system run must precede an `assistant` message or end the array. Everything else about the item is the ordinary item schema at `messages.<i>` (§5.5.7, which also names the one clause not mirrored). Anything else 400 in the Anthropic envelope | VERIFIED |
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
| A-21 | `tool_choice` | `{type:"auto"\|"any"\|"tool"\|"none", name?, disable_parallel_tool_use?}` | `{"type":"auto"}` when tools present | forcing | 400 / `invalid_request_error` | `none`/`any`/`tool` mapped (contract `:312`); `any` normalizes to `required` and is schema-enforced as in chat row 31, matching the direct API (`stop_reason:"tool_use"` against a prompt begging for no call, measured 2026-09-02); **`disable_parallel_tool_use` handling UNKNOWN** | VERIFIED (`option-is-a-promise`) |
| A-22 | `thinking` | `{type:"adaptive"\|"enabled"\|"disabled", budget_tokens?, display?}` | UNKNOWN — recent models default to adaptive thinking; the doc example sends `{"type":"adaptive"}` explicitly | `thinking` content blocks; token spend | 400 / `invalid_request_error` | validated hard (enum, `budget_tokens ≥ 1024` and `< max_tokens`, container non-null) **then `budget_tokens` is deliberately not forwarded** — documented, with the CLI-inertness evidence, at contract `:317` | DOC |
| A-23 | `output_config.effort` | `low`\|`medium`\|`high`\|`xhigh`\|`max` | UNKNOWN | reasoning/effort spend | 400 / `invalid_request_error` | supported; **accepted-and-ignored on models that gate it (Haiku)** — documented (contract `:318`) | DOC? |
| A-24 | `output_config.format` | `{type:"json_schema", schema}` | absent | structured output | 400 / `invalid_request_error` | supported; without tools the answer is validated against the schema and refused outside it (chat row 28, §7 row 10). It is no longer REFUSED together with tools — the provider serves that pair (measured 2026-09-03: `{"verdict": "True", "score": 0.95}` with tools present), so refusing a turn the backends can serve was itself a divergence — but it is **not enforced** there either, for the reason given in chat row 28. Accepted, echoed, and declared unenforced rather than silently dropped or falsely refused | VERIFIED (measured 2026-09-03) |
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

**Stream terminator: VERIFIED (P-2, 2026-08-29).** The provider's stream ends at `response.completed` (or `response.incomplete`) with **no `data: [DONE]` line**, and so does ours on the successful path (`http-server.ts`, Responses writer; `conformance-stream-terminator.test` compares the promoted captures). The mid-stream failure path still writes an in-band `error` then `[DONE]`; the direct API's failure path is **unmeasured**.

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

**`/v1/responses` 종결자 — 종결(2026-08-29).** direct는 `response.completed`에서 끝나고 `[DONE]`을 보내지
않는다(P-2 VERIFIED); 프록시도 같은 날부터 성공 경로에서 보내지 않으며, `conformance-stream-terminator.test`가
두 캡처의 원본 바이트로 종결자를 **양쪽 다** 비교한다. Chat 표면에서는 `[DONE]`이 맞다(direct도 보낸다).
스트림 중 실패 경로(in-band `error` 뒤 `[DONE]`)는 direct 캡처가 없어 **미측정**이다.

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

### 5.5.6 Responses direct 실측 (2026-08-30~31) — **미러 완료**, 계기가 표를 고쳤다

이 절의 첫 초안은 코드보다 먼저 쓰였고, 코드로 옮기는 과정에서 **열다섯 군데가 실제 API와 달랐다**.
아래는 고쳐진 값이며, 근거는 `pnpm e2e:text:parity`(양쪽에 같은 본문을 보내 `{status,type,param,code,message}`를 비교)의
**ALL PASS 333/333**과 `test/openai-responses-validation-parity.test.mjs`(128행, 그 ALL PASS 실행에서 생성).
초안이 틀렸던 자리를 남겨 두는 이유는 하나다 — **측정 전의 표는 측정이 아니다.**

**키 집합**: `input`·`instructions`·`max_output_tokens`·`max_tool_calls`·`temperature`·`top_p`·`top_logprobs`·`stream`·
`stream_options`·`text`·`tools`·`tool_choice`·`parallel_tool_calls`·`reasoning`·`include`·`store`·`background`·
`previous_response_id`·`conversation`·`truncation`·`metadata`·`user`·`safety_identifier`·`prompt_cache_key`·
`prompt_cache_retention`·`prompt_cache_options`·`service_tier`·`prompt`·`context_management`·`moderation`·
`presence_penalty`·`frequency_penalty`. **모르는 키** → `unknown_parameter`. `messages`만 예외로 `unsupported_parameter`,
`param` 없이 "In the Responses API, this parameter has moved to 'input'".

| 요청 | direct 응답 | 초안이 틀렸던 점 |
| --- | --- | --- |
| `model` 없음 / `null` / `''` | `missing_required_parameter` / `invalid_type` **"got an object instead"** / **400 `model_not_found`** `The requested model '' does not exist.` | `''`를 "없음"으로 적었다 |
| `null`의 의미 | Responses에서 **`model`을 뺀 모든 필드는 null=생략** (truncation·store·user·metadata·instructions·max_output_tokens·temperature 개별 확인) | — |
| `model: null`의 문구 | "an object" — **Images 표면은 같은 결함을 "null"이라 쓴다**. 한 표면의 표현을 API의 표현으로 일반화하면 Images 테스트 3건이 깨진다 | 일반화할 뻔했다 |
| `reasoning.effort` 2층 | 스키마 집합 밖 → `invalid_value` (`none`·**`minimal`**·`low`·`medium`·`high`·`xhigh`·`max`) / 안이지만 모델 집합 밖(`minimal`) → `unsupported_value` **모델명을 적는다** (`'minimal' is not supported with the 'gpt-5.6-terra' model`) | 한 층·한 문장으로 적었다 |
| `reasoning.effort` 타입 | 정수 → `invalid_type` `one of 'minimal', 'low', 'medium', or 'high'` (좁은 목록) / 그 밖 → `one of one of 'none', 'minimal', … or 'max' or integer` | 없었다 |
| `presence_penalty`·`frequency_penalty` 값 | `unsupported_parameter` 문구에 **code 없음** (Chat은 code 있음) | code가 있다고 적었다 |
| `prompt_cache_retention` enum 밖 문자열 | `invalid_value` + 목록 (Chat은 **`Invalid prompt_cache_retention argument`**, code 없음) | Chat과 같다고 적었다 |
| 2개짜리 목록 문장부호 | `'auto' and 'disabled'` — **직렬 쉼표 없음** (3개 이상은 있다) | 3개 이상 규칙을 2개에 적용했다 |
| `max_output_tokens` 하한 | **16** (1·15 거절, 16 수용). `max_tool_calls`의 하한은 1 | 1이라고 적었다 |
| `include: ["message.output_text.logprobs"]` | `unsupported_parameter` `param: include` "logprobs are not supported with reasoning models." | 문 하나를 통째로 빠뜨렸고, 프록시는 **수용해서 턴을 돌리고 logprobs 없는 답을 주고 있었다** |
| logprobs 두 문의 위치 | 필드 자리가 아니라 **모델 능력 검사 단계**(맨 뒤). 뒤 필드의 타입 결함이 이긴다. 둘이 함께 오면 `include`가 이긴다 | 필드 자리라고 적었다 |
| `previous_response_id`·`prompt`·`conversation` | **단계**다. 모든 스키마 검사가 이기고, 능력 검사를 이긴다. 자기들끼리는 `conversation` → `prompt` → `previous_response_id` | 필드 순서 안에 넣었다(2·3번) |
| `previous_response_id` + `conversation` | 400 `mutually_exclusive_parameters`, `param` 없음, `Mutually exclusive parameters: ''. Ensure you are only providing one of: 'pre..._id' or 'conversation'.` | 없었다 |
| 이름 축약 규칙 | 12자는 그대로(`'conversation'`), 20자는 축약(`'pre..._id'`), `include` 멤버(24자+)도 타입 문장에서 축약 — **값 문장에서는 전체** | 임계값을 6자로 두고 있었다 |
| 모르는 키의 철자 도움 | `Did you mean 'store'?` — 편집거리 2 이하, **본문에 이미 있는 키는 제외**(`modell`은 `model`을 제안하지 않는다), 가까운 순, 동률은 알파벳순. Chat도 같다 | 없었다 |
| `tool_choice` | 타입 문장이 표면마다 다르고(`one of an object or …` vs `one of one of … or object`) 객체 모양도 다르다(`{type,name}` vs `{type,function:{name}}`) | 공유 함수를 그대로 썼다 |
| `input[N]` 내부 | 메시지 항목의 미지 멤버는 `unknown_parameter` `input[0].bogus` — `input` 자리에서 보고된다 | 항목 내부 검사가 없었다 |

**보고 순서** (타입 결함, 비교 정렬 31키·124콜·대칭성 3/3·인접쌍 0실패):
`input` → `previous_response_id` → `prompt` → `moderation` → `include` → `tools` → `tool_choice` → `metadata` → `text` →
`temperature` → `top_p` → `presence_penalty` → `frequency_penalty` → `parallel_tool_calls` → `stream` → `stream_options` →
`background` → `max_output_tokens` → `max_tool_calls` → `reasoning` → `user` → `safety_identifier` → `prompt_cache_options` →
`prompt_cache_key` → `prompt_cache_retention` → `truncation` → `instructions` → `store` → `service_tier` → `top_logprobs` →
`context_management`. **Chat의 순서와 완전히 다르다** — 표면마다 자기 스키마 순서이므로 옮겨 쓸 수 없다.
(`previous_response_id`·`prompt`의 이 자리는 **타입 결함**의 자리다. 조회 실패는 위에 적은 대로 별도 단계다.)

**2라운드 교차리뷰(Claude, 8e6fd35)가 더 찾아낸 것** — 아래는 전부 그 뒤 실측·미러 완료:

| 요청 | direct 응답 |
| --- | --- |
| **프록시 자신의 `output` 항목을 `input`으로 되먹임** | **200**. `phase`는 **assistant 항목의 멤버**이고(`commentary`·`final_answer`), user 항목에 붙이면 `unknown_parameter`. 프록시는 `phase`를 어디서든 거절해 **자기 출력을 자기가 거절하고 있었다** — 상태를 저장하지 않는 이 표면에서 대화를 잇는 유일한 방법인데도 |
| `input[0]`이 원시값 / `null` | `invalid_type` `expected an input item, but got an integer instead.` |
| `input[0].type`이 문자열 아님 / 미지 문자열 | 둘 다 `invalid_value` `input[0]` + **33개 항목 타입 전체 목록**(비문자열은 `''`로 표기). 미지 문자열 타입도 거절한다 — 프록시는 "유니온이 자란다"는 이유로 수용하고 있었다 |
| `input[0].role` 없음 / 미지 | `invalid_value` `input[0]` + `'assistant', 'system', 'developer', and 'user'` (없으면 `''`) |
| `role` 있고 `content` 없음 | `missing_required_parameter` `input[0].content` |
| 콘텐츠 블록 | **두 단계**: 유니온 밖이면 `content[N].type` + 9개 목록, 유니온 안이지만 이 role의 variant 밖이면 `content[N]` + 그 variant 목록(user는 5개, assistant는 `output_text`·`refusal`) |
| `text.zzz` / `text.format.type` 밖 / `json_schema`에 name 없음 | `unknown_parameter` / `invalid_value` **`'json_object', 'text', and 'json_schema'`(Chat과 순서가 다르다)** / `missing_required_parameter` `text.format.name` |
| `text.verbosity` 밖 | `invalid_value` `text.verbosity` — 프록시는 자기 문장을 쓰고 있었다 |
| `tools[0]`에 type 없음 / function에 name 없음 / **Chat 모양** | `missing_required_parameter` `tools[0].type` / `tools[0].name` / `tools[0].name` — Responses의 도구는 **평평하다**. 프록시는 이름 없는 도구를 `tool`이라는 **지어낸 이름**으로 실행하고 있었다 |
| `include`·`context_management` 에코 | **에코하지 않는다** — 위 표의 "전부 에코된다"가 틀렸다. `context_management`의 미지 type은 400이지만 유효 집합을 알 수 없어 미러하지 않음(알려진 격차) |

**두 개의 비-스키마 결함도 같이 나왔다**:
① 미지 키 철자 도움이 편집거리를 **문자 수 × 알려진 키 수**만큼 동기 계산해서, 본문 상한(50MB) 안의 긴 키 하나가 서버 전체를 **약 50초** 멈췄다.
길이 차가 2를 넘으면 거리도 2를 넘는다 — 계산 전에 걸러내면 끝. ② 클라이언트에 보이는 error.message 상한이 500자였는데
direct의 가장 긴 문장은 **713자**(항목 타입 유니온)라 미러가 잘려 나갔다. 상한은 성장을 막는 장치이지 목표가 아니므로 1024로 올렸고,
값은 `MAX_ERROR_MESSAGE_CHARS` 한 곳에 있으며 테스트 픽스처도 그 상수에서 파생한다.

**후속(2026-08-31, 4라운드 교차검증)**: 상한이 또 세 군데서 새고 있었다. ① 업스트림이 준 `type`·`code`는
상한을 타지 않아 4096자짜리가 Responses·Anthropic 봉투에 그대로 나갔다 — 이 둘은 클라이언트가 **분기하는 판별자**라
자르면 진짜 값도 아는 값도 아니게 되므로, 상한을 넘으면 없는 것과 같이 취급해 기본값으로 되돌린다.
② `param` 상한은 JSON 작성기에만 걸려 있었고 SSE 프레임에는 테스트가 없었다.
③ claude 백엔드의 `boundedText`는 숫자만 같아졌을 뿐 **규칙이 달랐다** — 마커 자리를 무조건 예약해서
1011~1024자 진단이 잘리고 필요 없는 마커를 달았다. 직렬화기는 같은 버그를 이미 고쳐 놓은 상태였다.

**후속(2026-08-31, 3라운드 리뷰)**: "한 곳"이 두 군데서 깨져 있었다. ① `error.param`은 상한을 타지 않아서
1,000만 자 미지 키가 `message.len 1024` 옆에 `param.len 10,000,000`으로 나갔다 — `param`도 caller의 바이트다
(`metadata.<key>`, 항목 경로, 키 이름 자체). ② claude 백엔드가 **자기 상한 500**으로 클라이언트 진단을 다시
잘랐고, 그래서 1024로 올린 것이 그 경로에서는 아무 효과가 없었다. 상수는 `types.ts`로 옮겨 HTTP 표면과
백엔드가 같은 것을 읽고, 500은 **운영자 로그 한 줄**에만 남는다.

**계기 검증**: 심은 변이 3개 — 철자 도움 제거, 하한을 1로 되돌리기, `conversation`보다 `prompt`를 먼저 조회 — 모두 빨간불.
오프라인 골든은 ALL PASS 실행의 프록시에서 **생성**했고(손으로 옮겨 적지 않았다), 거리 임계값 변이가 그중 4행을 죽인다.

### 5.5.8 claude 네이티브 스키마 채널 — 라이브 위반율 (2026-08-31)

**측정 대상**: 상시(persistent) claude 세션 경로에서 caller의 출력 스키마가 실제로 지켜지는가.
`claude --json-schema`(2.1.251)는 **spawn 시점 플래그**이고 stream-json 입력에 턴별 형태가 없다 —
상시 자식의 argv는 spawn에 고정되므로, 상시 경로로 간 요청에는 이 플래그가 **절대 붙지 않는다**.
그런 턴을 붙들고 있던 것은 프롬프트 한 줄(`Schema JSON only.` / `Valid JSON only. No Markdown.`)뿐이었다.

**계기**: 프록시에 같은 본문을 N회 보내 응답이 caller 스키마를 만족하는지 판정. 쉬운 케이스는 계기가 되지 못한다 —
첫 시도(`tool_choice: required` + "서울 날씨?")는 **양쪽 빌드 다 0/6**이었고, 그건 채널이 아니라 질문의 쉬움을 잰 것이다.
산문을 유도하는 케이스로 바꾼 뒤에야 갈렸다.

| 케이스 (각 3회) | 네이티브 채널 | 프롬프트만 (변이) |
| --- | --- | --- |
| `json_schema` + "비교하고 이유를 설명하라" | 0/3 | **3/3 위반** |
| `json_schema` + "마크다운 제목·불릿으로 요약하라" | 0/3 | **3/3 위반** |
| `tool_choice: required` + 도구가 필요 없는 질문 | 0/3 | 0/3 |
| 도구 결과 뒤의 연속 턴 | 0/3 | 0/3 |
| **합계** | **0/12** | **6/12** |

위반의 형태가 말해 주는 것: 모델은 **유효한 JSON을 냈지만 자기가 지어낸 키**를 썼다 —
`{comparison, preference}`, `{comparison, key_differences, preference}`, `{summary}`, `{content}`,
`{response, requested_format, delivered_format, conflict, topic}`. caller가 요구한 `{city, verdict}`는 한 번도 나오지 않았다.
도구 판정 스키마가 양쪽 다 0인 이유는 프롬프트가 그 형태를 예시까지 적어 두기 때문이며, 그래도 채널로 보낸다 —
같은 약속을 두 가지 방법으로 지킬 이유가 없다.

**대가**: 스키마를 실은 턴은 상시 세션을 잃고 매번 새 CLI를 띄운다. 약속이 있는 곳에서만 치르는 값이고,
스키마 없는 턴은 그대로 자식을 재사용한다. 회귀는 `test/claude-code-backend.test.mjs`의 argv 단언이 잡는다.

#### 5.5.9 수용된 200의 **봉투 모양** 실측 (2026-08-31) — 미결

라이브 계기는 **거절만** 보낸다(수용 본문은 실제 턴을 청구한다). 그래서 200의 봉투는 거의 측정된 적이 없었다.
같은 본문을 direct와 프록시에 보내고 **키와 JSON 타입만** 비교한 결과(값은 모델이 다르니 당연히 다르다):

| 표면 | 프록시에 **없는** 필드 (direct에는 있음) | 프록시에만 있는 필드 |
| --- | --- | --- |
| `/v1/chat/completions` | `usage.prompt_tokens_details.cache_write_tokens` | 없음 |
| `/v1/responses` | `usage.input_tokens_details.cache_write_tokens`, `reasoning.mode`, `tool_usage.web_search.num_requests`, `tool_usage.image_gen.*`(8개) | 없음 |
| `/v1/messages` | `usage.cache_creation_input_tokens`, `usage.cache_read_input_tokens`, `usage.cache_creation.ephemeral_1h_input_tokens`, `usage.cache_creation.ephemeral_5m_input_tokens`, `usage.output_tokens_details.thinking_tokens`, `usage.service_tier`, `usage.inference_geo` | 없음 |

**한 방향으로만 어긋난다** — 프록시가 없는 필드를 지어내지는 않는다. 하지만 direct가 늘 주는 필드를 읽는
클라이언트는 `0`이 아니라 `undefined`를 받는다.

**미결인 이유**: `/v1/messages`의 캐시 카운터 생략은 **이미 한 번 판단된 결정**이다
(`anthropicUsage`의 주석: "A zero is not a report … treating 0 as 'this runtime reports caching' put
`cache_read_input_tokens: 0` on every cache-miss turn and re-hid a real hit behind a merged zero").
캐시를 실제로 쓰지 않는 런타임이 `0`을 보고하는 것과, 보고 자체를 하지 않는 것 중 무엇이 클라이언트에게
정직한지는 **트레이드오프이지 결함이 아니다** — 이 표는 그 결정을 되돌리지 않고 사실만 남긴다.
`tool_usage`·`reasoning.mode`·`thinking_tokens`는 이 프록시가 실행하지 않는 기능의 보고 필드라 값의 의미를
따로 측정해야 하며, 추측으로 채우지 않는다.

#### 5.5.5-A Chat `content` 필수 규칙 — 4라운드 실측 (2026-08-31)

**이 항목은 2026-08-30에 반대로 기록됐고, 그 오독을 만든 것은 계기 자체였다.**
당시 노트: "`{"role":"user"}`에 `temperature: 0.5` 트립와이어를 태웠더니 temperature로 답했다 → 메시지는 검증을 통과했다."
트립와이어는 **타고 가는 결함이 검사 대상보다 늦게** 검사될 때만 성립한다. 그런데 `content` 필수 검사는
capability 패스보다 **더 뒤**다 — 그래서 메시지가 무엇이든 temperature가 이긴다. 그 프로브는 다른 답을 낼 수 없었고, 결론이 뒤집혔다.
그 오독으로 **맞던 검사를 지웠고**, direct가 400을 주는 본문에 프록시가 200을 주게 됐다.

**재측정**(트립와이어 없이, `gpt-5.6-terra`·`gpt-5.5`·`gpt-5.6-sol` 세 계열, `content:"hi"` 양성 대조):

| 본문 | direct |
| --- | --- |
| `content` 생략 / `null` (role 무관) | 400, param **`messages.[i].content`**(점+대괄호 형태), **code 없음**, `Invalid value for 'content': expected a string, got null.` |
| `content: ""` / `content: []` | **200** — 비어 있어도 *있는* 것이다 |
| assistant + `tool_calls`·`function_call`·`refusal`·`audio` 중 하나 | **200** — assistant 스키마 자신의 대체 집합 |
| assistant에 아무 대체도 없음 / `system`·`tool` 항목 | 400 |
| `messages: null`·`'x'`·`7` | 400 `invalid_type` `Invalid type for 'messages': expected an array of objects, but got <타입> instead.` (프록시는 null을 `missing_required_parameter`로 답하고 있었다) |

**역할별 차이와 대체 규칙(4라운드 스윕에서 추가 실측)**:

| 본문 | direct |
| --- | --- |
| `developer` 항목 content 생략 | 400 `missing_required_parameter` param **`messages[i].content`**(점 없음) — `Missing required parameter: 'messages[i].content'.` |
| `developer` 항목 content `null` | 400 `invalid_type` param `messages[i].content` — 다른 역할과 **다른 문장** |
| assistant 대체 멤버가 `null` | 대체가 **아니다**. `tool_calls`·`function_call`·`refusal`·`audio` 어느 것이든 `null`이면 content 결함으로 떨어진다 |
| assistant `tool_calls: []` | 400 `empty_array` param `messages[i].tool_calls` — content가 **있어도** 난다. `messages` 단계(역할·content 타입 다음)에 있고 capability 패스·뒤 항목의 잘못된 role을 이기며 미지 키에만 진다. user 항목의 `tool_calls: []`는 200 |
| assistant `tool_calls` 타입 오류 | 400 `invalid_type` `expected an array of objects` |

**단계**: `content` 필수 검사는 **전부의 마지막**이다 — 어느 인덱스의 content 타입 결함에도, 어느 인덱스의 잘못된 role에도,
`n`·`stop`·`temperature`·미지 키에도 전부 진다.

#### 5.5.6-A `input` 필수 규칙 — 4라운드 실측 (2026-08-31)

3라운드까지 이 프록시는 `input`이 **없으면 빈 user 턴을 대신 넣고 200**을 줬다. direct는 그러지 않는다.

| 본문 | direct | 프록시(3라운드까지) |
| --- | --- | --- |
| `input` 생략 | 400 `missing_required_parameter` param `input` — `Missing required parameter: 'input'.` | **200** |
| `input: []` / `input: ''` | 400 `missing_required_parameter` **param 없음(null)** — `One of "input" or "previous_response_id" or 'prompt' or 'conversation' must be provided.` | **200** |
| `input: null` | 400 `invalid_type` `Invalid type for 'input': expected a string, but got an object instead.` — `model: null`과 같은 "null은 실패한 STRING" 어법 | 프록시가 지어낸 문장 `input must be a string or an array of input items.`, code 없음 |

**단계**: 생략 검사는 `model` **바로 다음**이고 그 뒤 전부를 이긴다(미지 키·`truncation`·`previous_response_id`·`conversation`).
비어 있음 검사는 **상태 단계 뒤, capability 패스 앞**이다(`previous_response_id`에 지고 `temperature`를 이긴다).

**미러하지 않음**: 되먹인 `reasoning`·hosted-tool 항목의 **id 조회**. direct는 `[{id:'rs_abc',type:'reasoning'}]`에
404 `Item with id 'rs_abc' not found.`로 답하고, 진짜 왕복(같은 서버가 방금 낸 id)에서는 찾는다.
이 프록시는 상태를 저장하지 않아 id를 조회할 수단이 없다 — 흉내 내려면 **정당한 되먹임까지 전부** 거절해야 하므로 수용 쪽으로 남긴다.

**id를 수용한 다음 그 항목이 무엇이 되는가는 별개의 행동이다 (2026-09-01 실측).** 이 절은 한동안 둘을 한 문장으로 묶어
"`reasoning`·hosted-tool 항목을 **아무것도 아닌 것으로** 되재생한다"고 적어 뒀는데, 지금은 `reasoning`에만 참이다.

| 되먹인 항목 | 백엔드에 도착하는 것 |
| --- | --- |
| `reasoning` (`summary`·`encrypted_content` 포함) | **없음.** 드롭된다. 이 항목 하나뿐인 본문은 `messages: []` — 빈 대화로 실행된다(비어 있음 검사는 `input` 자체가 비었을 때만 걸린다) |
| `function_call` / `function_call_output` 쌍 | 이 프록시 자신의 툴 히스토리로 되재생돼 네이티브 항목으로 도착한다 |
| 그 밖에 표면이 아는 타입 전부 (hosted-tool 호출·출력, `web_search_call` 등) | **라벨 붙은 전사 기록** 한 건: 리터럴 `[replayed item]` → `type: <타입>` → 항목 자신의 JSON. 그 턴의 역할 그대로 도착하며 내용이 온전히 실린다. 라벨을 되파싱하는 곳이 없으므로 기록 안의 텍스트가 툴 결과 경계를 위조할 수 없다 |
| 표면이 **모르는** 타입 | 되재생 자체가 없다 — 400 `invalid_value` param `input[<i>]`, 아는 타입을 전부 나열한다 |

두 행동은 `spec/declared-divergences.json`에 각각 `responses-replayed-item-ids-are-not-looked-up`(id 조회)과
`responses-replayed-hosted-tool-items-are-transcript-records`(무엇이 되는가)로 나뉘어 등록돼 있다.

### 5.5.7 Anthropic Messages 필드 검증·보고 순서 실측 (2026-08-31) — **미러 완료**

`claude-sonnet-5`. 봉투는 `{type:"error", error:{type, message}}` — **`param`도 `code`도 없다**.
이 절이 생긴 계기는 리뷰 지적 2건이었다: 알려진 필드 여러 개가 아예 검증되지 않았고(`stream: "yes"`가 조용히 버퍼 모드가 됐다),
필수 필드 누락이 선택 필드의 결함에 밀렸다. 고치려면 순서를 알아야 했고, 순서는 재 봐야 했다.

**보고 순서** (타입 결함으로 종류 고정, 비교 정렬 18키·137콜·**대칭성 51/51**·인접쌍 17/17):
`model` → `tool_choice` → `tools` → `messages` → `system` → `thinking` → `output_config` → `cache_control` →
`max_tokens` → `metadata` → `stop_sequences` → `temperature` → `service_tier` → `top_k` → `top_p` → `stream` →
`container` → `inference_geo` → **모르는 키** → **`container` 거절**.
알파벳순도, 문서의 파라미터 나열 순서도 아니다. `container` 거절이 미지 키보다 뒤라는 것이 이 순서에서 가장 놀라운 부분이고,
OpenAI 표면들이 능력 거절을 맨 뒤에 두는 것과 같은 모양이다.

| 요청 | direct 응답 |
| --- | --- |
| `model` 없음 / `null`·정수 / `''` / `'   '` | `model: Field required` / `model: Input should be a valid string` / `model: String should have at least 1 character` / **404** (이름으로 취급해 조회한다) |
| `messages` 없음 / 문자열·null / `[]` | `messages: Field required` / `messages: Input should be a valid array` / `messages: at least one message is required` |
| `max_tokens` 없음 / 문자열·null / `-1` / `0` | `max_tokens: Field required` / `Input should be a valid integer` / `must be greater than or equal to 0` / **수용** |
| 항목 `role` 없음 / `"developer"` / **`"system"` 0번** / `"system"` 1번 이후 | `messages.0.role: Field required` / `messages: Unexpected role "developer". Allowed roles are "user" or "assistant"` / `messages.0: use the top-level 'system' parameter …` / **200 수용** |
| **`"system"` 1번 이후의 나머지 스키마** (2026-08-31 3라운드 추가 측정) | 위치만 면제이고 항목 스키마는 그대로 적용된다: content 없음 → `messages.1.content: Field required`, `content: null`·정수 → `messages.1.content: Input should be a valid array`, 블록에 type 없음 → `messages.1.content.0.type: Field required`, 미지 멤버 → `messages.1.bogus: Extra inputs are not permitted`(뒤 필드의 타입 결함을 이긴다). 프록시는 조기 `return`으로 앞의 셋을 **200**으로 답하고 미지 멤버를 **미지 키 단계**에서 보고하고 있었다 |

**대화 모양(shape) 단계 — 4라운드 실측(2026-08-31)**: 위 3라운드 표에서 "1번 이후는 200 수용"이라고 적은 것은 **너무 거칠었다**.
`system` 항목의 규칙은 **위치 규칙**이고, 위치 규칙은 항목 스키마와 다른 **별도의 늦은 단계**에 있다.

**단계 위치**: 필드 18개 순회 → 미지 키 거절 → **여기** → container 거절.
(`messages:[{role:'user',content:[]}]` + `temperature:'x'` → temperature. + `zzz_unknown:1` → 미지 키. + `container:'x'` → messages.)

| 규칙 | direct 실측 |
| --- | --- |
| `system` 항목 하나 안에서의 우선순위 | ① content 길이 0 → `messages.<i>: system content must contain at least one block` ② index 0 → `messages.0: use the top-level 'system' parameter …` ③ 위치 → `messages.<i>: role 'system' must precede an 'assistant' message or end the array; …` ④ 공백 → `messages.<i>: system text blocks must contain non-whitespace text` |
| `system` 위치 | 연속된 `system` 묶음의 **마지막**이 `assistant`를 앞서거나 배열을 끝내야 한다. `[U,S]` 200 · `[U,S,S]` 200 · `[U,S,A,U]` 200 · `[U,S,U]` **400** |
| `system` 런의 **보고 인덱스** (2026-09-01 실측) | 위반은 런의 **마지막 항목** 자리에서 보고된다. `[U,S,U]` → `messages.1` · `[U,S,S,U]` → `messages.2` · `[U,S,S,S,U]` → `messages.3`. 위 행의 `[U,S,U]` 하나만으로는 "런의 첫 항목" 읽기와 "런의 마지막 항목" 읽기가 같은 답을 내 구분되지 않는다 — 런 길이 2·3을 재야 갈린다. 대조군은 같은 런을 합법으로 끝낸 `[U,S,S,S]` 200 · `[U,S,S,A,U]` 200 |
| `system` 공백 | 텍스트 블록 **하나라도** 공백뿐이면 400. `content:'   '`도, `[text:'x', text:'']`도 400 |
| `user` 빈 턴 | **연속 같은 역할은 한 턴으로 합쳐진다.** 합쳐진 턴 전체가 비어야 400이고, 그 턴의 **첫 빈 항목** 자리에서 보고된다. `[user:[]]` 400 · `[user:[],user:'a']` **200** · `[user:'a',user:[]]` **200** · `[U,A,user:[]]` 400@2 · `[U,A,user:[],user:[]]` 400@2 |
| `assistant` 빈 턴 | 규칙 **없음** — `[U, assistant:[]]` 200 |

**프록시가 틀렸던 것 넷**: ① `user content:[]`를 **모든** 위치에서 거절 → direct가 200 주는 본문을 400으로 막고 있었다(가장 나쁜 방향).
② `system`의 빈·공백 content를 1번 이후에서 **수용**. ③ `system` 위치 규칙 자체가 없었다. ④ 이 규칙들과 index 0 안내 문장을
`messages` 단계(4번)에서 던져서, direct가 `temperature`(12번)·미지 키로 답하는 본문에 다른 답을 했다.

**합침은 수용 판정만이 아니라 투영에도 적용된다**: 내용이 있는 런 안의 빈 항목은 턴이 아니므로 백엔드에 가지 않는다.
비어 있지 않은 항목 둘은 둘 다 진짜 턴이라 그대로 남고, 런 전체가 빈 경우(`[U, assistant:[]]`)는 그 항목이 곧 턴이라 남는다.
이 규칙이 400 여부만 정하는 동안 `[user:[], user:'PING']`은 200을 받고도 백엔드에는
`[{text:''}, {text:'PING'}]`으로 — 클라이언트가 보내지 않은 빈 턴을 앞세워 — 도착했다.

| `system` 블록 타입 | `text`·`tool_addition`·`tool_removal` **뿐**. 그 밖(이미지·tool_result 등) → `messages.<i>: role 'system' supports text, tool_addition, and tool_removal blocks only`. 항목 안 우선순위에서 **빈 content 다음, index 0 안내 앞** |

**direct가 광고하지만 지키지 않는 면제 하나 (2026-09-01 실측)**: 위치 규칙 문장이 스스로 덧붙이는 꼬리말은
`the directive-only form (content: [] with output_config) is accepted at any position`이다.
리뷰가 이 문장을 근거로 "`content:[]`에 `output_config`가 붙으면 수용해야 하는데 프록시가 400을 준다"고 지적했으나, **재보니 아니다**.
처음 측정은 `output_config` 자체가 잘못된 모양이어서 `output_config.format`이 먼저 답해버려 질문에 닿지 못했다(계기 결함).
`additionalProperties`까지 갖춘 **유효한** `output_config`로 다시 재면 — 그 `output_config` 단독은 200이다 —

| 본문 | direct |
| --- | --- |
| `[{system, content:[]}, U]` + `output_config`(json_schema, 유효) | 400 `messages.0: system content must contain at least one block` |
| `[U, {system, content:[]}]` + `output_config`(json_schema, 유효) | 400 `messages.1: …` |
| `[U, {system, content:[]}]` + `output_config`(effort) | 400 `messages.1: …` |
| `[U]` + `output_config`(json_schema, 유효) — 대조 | **200** |

즉 꼬리말이 면제하는 것은 **위치 규칙**뿐이고 **content 길이 0 규칙은 면제하지 않는다**.
문장이 광고하는 것과 서버가 하는 것이 다른 경우이며, 미러의 권위는 문장이 아니라 측정이므로 프록시의 `length === 0` 거절이 옳다.
꼬리말 자체는 direct 문구를 그대로 복사한 것이라 그대로 둔다.

**측정했으나 미러하지 않음**: `system` 항목은 `user` 메시지 **또는 서버 툴 결과로 끝나는 assistant 메시지**를 뒤따라야 한다
(`[U,A,S]` → 400 `messages.2: role 'system' must follow a 'user' message or an 'assistant' message ending in a server tool result; …`).
면제 조건이 이 프록시가 만들어낼 수 없는 **서버 사이드 툴 결과**에 걸려 있어서, 주절만 보고 거절하면 direct가 받는 본문을 거절하게 된다 —
이 표면이 절대 하면 안 되는 그 한 가지다. 그래서 수용 쪽으로 남긴다.
또 하나: 대화가 `assistant` 턴으로 끝나면 `claude-sonnet-5`는 400
`This model does not support assistant message prefill. The conversation must end with a user message.`로 답한다.
문장이 **모델을 지목**하고 prefill은 모델마다 있고 없는 능력이라, 한 모델이 거절한다는 이유로 백엔드가 할 수 있는 턴을 막으면
그것이 위반이다(`chat-function-tools-with-reasoning-effort`와 같은 모양). 그리고 하나 더: 마지막 `user` 턴의 빈 텍스트 블록은 `messages: text content blocks must be non-empty`(인덱스 **없음**)로 거절되는데,
같은 블록이 대화 중간에서는 200이다. 같은 계열의 규칙이나 문장이 다르고 조건이 덜 측정돼 있어 이번에는 미러하지 않는다.
| 항목 `content` 없음 / null·정수·객체 / `[]` / `[7]` / `[{}]` | `messages.0.content: Field required` / `messages.0.content: Input should be a valid array`(문자열은 수용) / `messages.0: user messages must have non-empty content` / `messages.0.content.0: Input should be an object` / `messages.0.content.0.type: Field required` |
| 항목 미지 멤버 | `messages.0.bogus: Extra inputs are not permitted` — `messages` 자리에서 보고된다 |
| `null`의 의미 | **생략**: `metadata`·`inference_geo`·`stop_sequences`·`cache_control`·`container`. **타입 결함**: 그 밖 전부(`stream`·`system`·`tools`·`tool_choice`·`thinking`·`output_config`·`service_tier`·`top_k`·`top_p`·`temperature`). OpenAI 표면처럼 일률적이지 않다 |
| `temperature`·`top_p` 범위 | `range: 0..1` (`top_k`는 하한 없음 — `-1` 수용) |
| `tool_choice` `{}` / `{type:'bogus'}` | `tool_choice.type: Field required` / `tool_choice: Input tag 'bogus' found using 'type' does not match any of the expected tags: 'auto', 'any', 'tool', 'none'` |
| `system: 7` / 문자열 / `[7]` | `system: Input should be a valid array` (문자열은 **수용**) / 200 / `system.0: Input does not match the expected shape.` |
| `container` 값 무엇이든 | 미지 키 검사 **뒤에** `container: Container identifier can only be provided when using the code execution tool` |

**아직 미러하지 않은 것 (측정만 됨)** — 다음 작업의 재료다:
`thinking`은 variant별 스키마다(`thinking.enabled.budget_tokens: Field required`, 하한 1024, `thinking.disabled.display: Extra inputs are not permitted`,
그리고 이 모델은 `enabled` 자체를 거절하고 `adaptive`+`output_config.effort`를 쓰라고 답한다).
`output_config`의 direct 멤버는 `format`·`effort` **둘뿐**이고 `output_config.effort`의 문구는
`Input should be 'low', 'medium', 'high', 'xhigh' or 'max'`이다. **`output_config.task_budget`은 direct가 모르는 키**
(`Extra inputs are not permitted`)이므로 이 프록시의 확장이다 — 선언된 발산으로 등록해야 한다.

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

**의도된 발산 1건 추가 (2026-09-01 실측)**: `function` **역할**. direct는 `gpt-5.6-terra`에서 content가 무엇이든 이 역할을 통째로 거절한다 —
400 `unsupported_value`, param `messages[2].role`, `Unsupported value: 'messages[2].role' does not support 'function' with this mode`
(`content: null`도, `content: '23C'`도 같은 답). 프록시는 `{role:'function', name:'f', content:'23C'}`를 **수용**해 백엔드까지 보내고,
`content: null`은 자신의 평소 답인 param `messages.[2].content`·code 없음·`Invalid value for 'content': expected a string, got null.`로 거절한다.
거절 문장이 **mode를 지목**하므로 `chat-function-tools-with-reasoning-effort`와 같은 계열이다 — 벤더 모델 하나의 능력이지 이 표면의 규칙이 아니고,
백엔드가 실행할 수 있는 턴을 막는 쪽이 위반이다. 두 방향 중 **안전한 쪽**이기도 하다(이 역할을 안 쓰는 클라이언트는 차이를 못 느끼고, 쓰는 쪽은 400 대신 턴을 받는다).
`spec/declared-divergences.json`의 `chat-function-role-is-not-refused`에 등록.

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

## 7. The tool wrapper, read once

**Scope: any turn with `tools`** on the `claude` and `app-server` runtimes. Such a turn is answered
inside a private JSON wrapper (`{status, text, toolCalls}`) the runtime is asked to produce, and the
proxy reads that wrapper **once, whole** — `JSON.parse` in `parseBackendOutput`, with the backstops
that refuse a wrapper the schema would not have allowed (a status outside the schema, a call naming
a tool the request never declared, a `required` turn with no call). The stream releases nothing for
a tool turn — not even the surface's opening frames — until that reading exists; what a streaming
client then receives is a projection of it, and a refused turn is an HTTP 502 on the stream as on
the buffered body. Plain text turns and the `codex-backend` transport stream live.

Until 2026-09-04 there was a second reader: an incremental walk that released bytes before the
wrapper was complete. On malformed output it disagreed with the completed reading — a streaming
client could execute a call the buffered body denied, receive different narration, or different
arguments — and four review rounds of patching it one axis at a time each produced the next round's
defects. It was deleted by design, in the stages `docs/design-task-wrapper-release.md` records;
the twelve inputs on which it disagreed (a member after the root closed, a root that never closes,
duplicate keys at the wrapper level and inside a call, a BOM or U+00A0 or U+000B where JSON allows
no such byte, an undeclared name after a declared call or after narration, non-object `toolCalls`
members, arguments that are not JSON, an invalid escape) are now agreements. Measured cost of
waiting: none on `claude`, whose wrapper already arrived whole in `structured_output` and never fed
the incremental reader at all; about 0.3 s later call announcement per turn on `app-server`.

**Instrument.** `test/wrapper-agreement-suite.test.mjs` drives every one of those inputs, one
character per delta, through both wrapper backends and all three surfaces, buffered and streamed,
and asserts the two readings agree AND what was delivered — a call set, a text, or a refusal with
nothing released and the same HTTP status on both paths. One input stays pinned to a disagreement:
the forced-tool fragment when the runtime reports the output limit (`7b-8b`), where the two
`/v1/messages` writers project one unparseable call differently and the direct envelope for a
call cut off by `max_tokens` is unmeasured. Flipping a pin is the only way the file's verdicts may
change.

### Closed after the reader was deleted (2026-09-04)

The schema the client supplied is the runtime's output contract where the client took that
promise — `strict: true` on an OpenAI tool or `json_schema` format, or any Messages structured
output, which the direct API keeps exact — and an answer outside it is a runtime that ignored its
schema: the backstop refuses it, never repairs it. Without `strict` the OpenAI APIs are best-effort
themselves, and the proxy delivers what the runtime wrote (round 18). The validator is `ajv` 8
(draft 2020-12, `strict` off because the schema is the client's, formats not asserted because
neither direct API asserts them on model output), one instance per schema so a `$id` never crosses
requests, the one runtime dependency taken since `sharp`. What cannot be judged passes: a schema
that does not compile or is `$async`, a `$ref` the schema itself does not resolve, and a text
carrying a number a double cannot hold exactly (the client is promised the runtime's bytes) — the
direct APIs accept `$async`, `$id` and `$ref` at request time (measured 2026-09-04), so the request
boundary is not where these are refused either. A turn the runtime reports as cut off by its output
limit is delivered whatever it holds, with the terminal fields saying so.

| # | defect | what a client saw | what closed it |
|---|---|---|---|
| 8 | a forced single tool bypassed the wrapper entirely, and `normalizeToolArgumentsText` passed any `{`/`[`-opening payload through unvalidated | a truncated `{"city":"Seo` was published as `function.arguments` on Chat and Responses, and the two `/v1/messages` **writers** disagreed over it (buffered `{"input":…}` against a verbatim `input_json_delta`) | refused at completion — 502 `arguments that are not JSON` (a forced answer is judged and published byte for byte, whitespace included; a BOM or U+00A0 is not JSON on either path — round 20), `not a JSON object` for a bare string, array or number, or `an \`arguments\` member that is not a string` for a wrapper call whose member is an object (the schema says string; re-serializing it rounded its numbers — round 20), since the direct APIs' function-call channel yields an object by construction, strict or not — on every surface and both paths of `claude` and `app-server`, for a forced call and for every call inside the wrapper alike (the reading used to REPAIR prose into `{"input": …}` on both paths, publishing an executable call the model never made — r18-codex; agreement-suite `7a-7` is now a refusal) — the `codex-backend` transport does not reach this reading: its native channel's arguments are the vendor's own answer, delivered verbatim (whitespace-only included; only the empty string is the direct API's `{}`) on Chat and Responses as the direct API delivers them (whose documentation says they may not be valid JSON) — round 21 removed the `{"input": …}` wrap the transport used to put around a completed call that did not parse, which the stream had never applied — and a call it reports cut off is delivered verbatim (round 18). On `/v1/messages`, where `input` is a JSON value, a completed native call whose arguments are not a JSON object is refused with the same 502 as the wrapper reading (the stream: the bytes, then an in-band `error`); whether the live vendor ever produces one is **unmeasured**. Inside a turn the vendor reports cut off nothing is judged: the call the cut hit — the turn's last call with nothing after it, the one whose block the stream leaves open (`cutCallLeftOpen`) — is projected (its complete members; `{}` for whole JSON that is no object); when narration follows the last call the cut hit the narration, and that call, like every other call of the turn, goes out as written where its bytes are JSON (the stream closed its block on them; r24-codex read the earlier sentence as promising the projection there) — the stream closed its block on them — and as the projection where they are not, since `input` must be a JSON value (round 23, **unmeasured** shape). A completed value that contradicts what the transport streamed for the call (a vendor contradicting itself; **unmeasured**) reaches the body while the stream keeps the bytes it sent and closes on them — declared, not repaired (r23-fable F2); a completed item whose `id` and `call_id` name two different announced calls (item ids swapped) is left alone, the streamed pairing winning on both paths (r26-codex F2). Rounds 26–28 closed the native transport's finish-state gaps: the vendor's finish event fixes a call's value (later deltas dropped on every path, identified or not) while the signal that closes a surface's block waits for an event at a HIGHER output position (the vendor moved on; a late frame for an earlier item is not that — r28-fable F2) or for `response.completed`, so a call finished inside a cut-off turn keeps its bytes and its open block; a completed value may extend a finished fragment only while that signal has not gone out — once the block is closed the fragment stands on every path, and Messages refuses it as not a JSON object (r28: fable F1, codex F1); a call is announced on a `call_id` AND a name, and a call the vendor never names — or never gives a `call_id` — is refused at completion (HTTP 502 while no stream byte has been written, an in-band `error` once the stream has committed): half an identity is no identity, so neither the placeholder `tool` nor an item id or a minted `call_N` reaches a client, whatever tools the request declares (r27-fable F1, r27-codex); a present `arguments` member that is not text is refused wherever it arrives (finish event, closed item, completed output, delta) instead of being read past into `{}` (r27-codex), and so is a present identity member — `id`, `call_id`, `name`, `item_id` — that is not text, which presence alone let through as an object-valued id on every surface (r29-codex); only an event carrying an `output_index` claims that position — an identified event without one used to claim `#0`, and a later call really at position 0 was bound to it and vanished (r29-codex) — and a call bound by id on an index-less frame learns its position from the first later frame that carries one, so its finish signal still fires when the vendor moves on (r29-fable F1); a refusal raised while the body is open is the turn's outcome, not the unread body's teardown rejection (r29-fable F2); an argument event that names neither an item nor an output position is refused rather than read as position 0 and spliced into the next call (r27-codex); a request that permits no call — no tools declared, or `tool_choice: none` — refuses every call the vendor makes, an empty allowed set rather than no rule (r28-codex F4); a completed item carrying a `call_id` for a call the stream identified by its item id alone binds to that call at its output position instead of minting a second one (r28-codex F7); a call the vendor names only after narration that followed it is reported after that narration on both paths — the order the client was told (declared; r28-codex F5); anonymous argument deltas belong to the call the completed output names at their position; the terminal frame ends the read; and stream tool indices are announcement order, the order `toolCalls()` reports, so a call identified late keeps the block the stream opened for it. Unless the runtime reports the output limit (`stop_reason: max_tokens`, the one spelling both readers use): then the turn is delivered **whatever it holds** — a JSON fragment, a parseable partial object, `{}`, a `required` turn with no call — as the direct APIs deliver it (a frame that breaks the protocol is still refused inside a cut turn — half an identity, a non-text member, an event naming no call: those refusals judge the vendor's frames, not the call's value — r29) (`review-artifacts/stage2/report.md` M6/M7), and the terminal fields say so: Chat `finish_reason: length`, Responses `status: incomplete` + `incomplete_details` + an incomplete item + `response.incomplete`, Messages `stop_reason: max_tokens` with the `tool_use` block — whose body carries the complete top-level members parsed so far (`completeTopLevelMembers`, a walk over the completed fragment) and whose stream carries the verbatim fragment in a block that is not closed — the turn's FINAL block only, and only when the fragment is not a whole JSON object: a last call whose bytes are a complete object (`{"a":1}` under `max_tokens`) is closed like any other, and what the direct API does with a complete object cut off at the limit is **unmeasured** (r23-codex); a cut call with narration or another call after it closes like any other, or the next block would nest (round 20) — exactly the direct API's two projections (measured 2026-09-04). One cut-off shape is refused rather than delivered: a turn cut off **inside the tool wrapper** (the wrapper JSON itself never closed), since the fragment is this proxy's grammar and publishing it as the assistant's words is the row-10 defect — 502 `cut off at its output limit inside the tool wrapper`, **declared**, unreachable on the live runtimes (neither reports the cap). The Claude CLI errors at its own cap rather than truncating, so on the live `claude` runtime this path is the double's; `app-server` reports no stop reason (its protocol has none), so its fragment is always refused — **declared**. Arguments that parse are validated against the tool's schema only under `strict: true`, the promise the direct APIs themselves enforce; without it they are delivered (round 18). `wrapper-agreement-suite` 7b-8/7b-8b, `backend-contract.test` rows 8 + r18, `output-limit-projection.test`, `codex-backend-transport.test` (fragment verbatim) |
| 10 | with a JSON format present, a wrapper-shaped object with no usable `status` was exempted from refusal | `{"status":"done","text":"…","toolCalls":[]}` published verbatim — the proxy's internal grammar as the client's answer | `json_schema` **without tools**: text that is not JSON is refused always (`not JSON for a request that supplied a JSON schema` — the format promises JSON); text outside the schema is refused under `strict: true` on Chat/Responses and always on Messages, whose structured output is exact (`outside the request's JSON schema`) — which refuses the wrapper grammar along with every other near miss where the promise was taken. What cannot be judged passes (chat row 28). A turn the runtime reports as cut off by its limit is delivered as the fragment it is (row 8). `json_schema` **with tools**: chat row 28's declaration stands. `json_object`: object rule only — **declared unenforced** beyond it. The refusal and every gate that holds text for it (`textMayBeRefused`, the app-server stream gate, the HTTP commit deferral) key on `jsonMode`, and the request boundary no longer produces a schema without a JSON format (row 14). `backend-contract.test` rows 10 + r18, `what-the-reverted-member-left-behind` |
| 13 | the model echoes the wrapper grammar inside the wrapper: `"text": "{\"status\":\"message\",\"text\":\"Red\",…}"` | the client receives the proxy's grammar as the assistant's words | **measured, declared.** 0 of 50 prose turns on `claude` and 0 of 50 on `app-server` (2026-09-04, `review-artifacts/stage2/row13-run.log`); with the 1 of 12 seen the day before, 1 echo in 112 `auto` turns. A behaviour of the model against its schema instruction, at a rate that does not justify a detector — a detector would have to refuse every answer that legitimately quotes the grammar, and nothing in the bytes tells the two apart. Re-measure if the wrapper's shape changes |

### Request-boundary gaps found alongside — closed 2026-09-04

Both reproduced on every surface. Each direct envelope was measured live before the mirror was
written (`scripts/e2e-text-surfaces-direct-parity.mjs`, seven rows; 438/438 after the mirror), and
the three offline validation-parity suites carry the same rows.

| # | defect | what a client saw | what closed it |
|---|---|---|---|
| 11 | a tool definition with a blank name was accepted, and Anthropic accepted one with **no** name at all | all three surfaces published a call literally named `tool` — `readString(…, 'tool')` in each declaration reader manufactured the identity the runtime enum and the backstop then trusted | 400 at the boundary, the direct envelopes verbatim. Chat: `empty_string` on `tools[i].function.name`, and on the legacy `functions[i].name` too. Responses: `empty_string` on `tools[i].name` (an absent name was already `missing_required_parameter`). Messages: `tools.i.custom.name: Field required` and `…: String should have at least 1 character` — the direct API reports the name under the `custom` member of its tool union. A whitespace-only name is refused by the direct APIs' pattern — `^[a-zA-Z0-9_-]+$` on Chat/Responses (`invalid_value`, "string does not match pattern"), `^[a-zA-Z0-9_-]{1,128}$` on Messages ("String should match pattern") — mirrored 2026-09-04 (round 18), so no string name reaches the readers' `tool` fallback; and a Responses tool whose `type` is not `function` is refused at the boundary (row 16), so no declaration reaches the fallback. A non-string name on Messages answers `Input should be a valid string`, this validator's wording for `model`, **unmeasured** for this field. Three HISTORY readers still substitute `tool` for a call with no name in the conversation the client replays (a Chat assistant `tool_calls[].function`, a Responses `function_call` item, a Messages `tool_use` block) — the direct envelopes for those inputs are **unmeasured** (r18-codex), and they are not declarations |
| 12 | a forced `tool_choice` naming a tool the request never declared created a call for it | with only `real` declared and `never_declared` forced, every surface published `never_declared` in both modes — `forcedSingleToolCall` fell back to a generic argument schema when the lookup found nothing, and this path bypassed `declaredToolNames` | 400 before `forcedSingleToolCall` can run, one check for the three shapes (`assertForcedToolDeclared` in `normalizers.ts`). Chat: `Invalid value for 'function_call': no function named 'X' was specified in the 'functions' parameter.`, `param: function_call` — the direct API still words it in the deprecated vocabulary, reaches that check on this model only under `reasoning_effort: "none"` (which the parity row sets), and answers the same for the legacy `function_call` naming a function `functions` never declared (round 18). Responses: `Tool choice 'X' not found in 'tools' parameter.`, `param: tool_choice`. Messages: `Tool 'X' not found in provided tools`. **With `tools` absent** (round 18, measured): Chat refuses every `tool_choice` — `auto`, `none`, `required`, a forced function — with `'tool_choice' is only allowed when 'tools' are specified` (a malformed choice reports its type first); Responses serves `auto`, refuses `required` (`Tool choice 'required' must be specified with 'tools' parameter.`) and a forced function with `Tool choice 'function' not found in 'tools' parameter.` — the TYPE, and the same with `tools: []`; Messages serves `auto`, refuses `any` (`tool_choice.any may only be specified while providing tools`) and a forced tool with the not-found envelope. With `tools: []` on Chat the forced function gets the `function_call` envelope; `required` with `tools: []` passes the direct API's validation and is decided at generation — **not deterministic**: 6 samples on 2026-09-04 (round 21, `review-artifacts/stage2/report.md` M8 correction) gave 500 `model_error` "The model produced invalid content…" ×3, 500 `server_error` ×2 and 200 ×1, where round 19's two samples had read a deterministic `model_error`. **Declared divergence:** the proxy answers the modal envelope, the 500 `model_error`, every time, at the boundary — after the whole validation walk, since the direct API reaches it only at generation and a request fault answers first (round 20) — rather than serving a text turn for an option that promised a call. The row is pinned offline (`test/openai-chat-validation-parity.test.mjs`) and is not in the live parity table, whose rows compare against a deterministic direct answer; Responses `required` and Messages `any` with `tools: []` get their tools-absent envelopes (measured). The legacy `function_call` — any value, with `tools` declared or nothing at all — is refused without `functions` (`'function_call' is only allowed when 'functions' are specified`, measured round 19), so the declared-name check runs only where `functions` is present |
| 14 | a `schema` under `text.format` of type `text`/`json_object` (Responses), or a `json_schema` under `response_format` of type `text`/`json_object` (Chat), was accepted — a request with a schema and no JSON format | the response path refused on the schema while every streaming gate held text for the format: on `app-server` the whole prose streamed and then an in-band error; on `claude` a 200 with an in-band error where the buffered body was 502 (r18-fable F2) | 400 `unknown_parameter` on `text.format.schema` / `response_format.json_schema` (measured 2026-09-04, both types), so the pair cannot be formed; the response-path gate additionally keys on `jsonMode` |
| 15 | a Messages tool with `strict: true` and an object schema that does not set `additionalProperties: false` was accepted | the runtime ran a strict tool the direct API refuses at request time | 400 `tools.i.custom: For 'object' type, 'additionalProperties' must be explicitly set to false` (measured 2026-09-04 at the schema root; nested objects **unmeasured**). `strict` itself is a known member on all three surfaces and is what turns the response path's schema refusal on (rows 8, 10) |
| 16 | a Responses built-in tool (`web_search`, `file_search`, …) was normalized into a function named `tool` | the runtime could "call" a tool the client never declared as a function, under an invented identity | 400 at the boundary, `Unsupported tool type 'X': this proxy runs 'function' tools only.` (`tools[i].type`) — **not** the direct API's envelope, which serves the built-in: a declared divergence, since an option the adapter cannot deliver is refused rather than silently accepted. With this, the declaration readers' `tool` fallback has no reachable input left; the three history readers' fallback (row 11) remains |

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
