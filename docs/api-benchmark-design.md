# API 대비 벤치마크 설계

> **이 문서의 semantic quality 게이트는 `docs/conformance-suite-design.md`가 대체한다(2026-08-28).**
> 손으로 쓴 10개 질문을 판정자로 재는 방식이 런타임을 그 질문들에 맞춰 조정되게 만들었고,
> 그 경위와 대체 설계는 그 문서에 있다. 이행이 끝날 때까지 이 문서는 **비교 authority, latency
> metrics, image quality, suite 계층, 실행 명령**의 권위로 남는다. 아래 「품질 벤치 설계」의
> Text semantic quality 절은 이행 중 현재 러너가 무엇을 하는지에 대한 기록으로만 읽는다.

이 문서는 로컬 OAuth CLI API 어댑터가 실제 provider API와 얼마나 같은 표면과 품질을 보이는지 검증하기 위한 벤치마크 설계이다. 목표는 단순 smoke 통과가 아니라, 실제 사용 환경에서 API contract, streaming latency, semantic quality, image quality, error parity가 함께 유지되는지 확인하는 것이다.

## 기준 소스

- OpenAI Images API: https://platform.openai.com/docs/api-reference/images
- OpenAI image generation guide: https://platform.openai.com/docs/guides/image-generation
- OpenAI Responses API: https://platform.openai.com/docs/api-reference/responses
- Anthropic Messages API: https://docs.anthropic.com/en/api/messages

Proxy runtime은 local OAuth CLI auth를 쓰는 것이 제품 목적이다. 따라서 proxy target이 benchmark 중 direct provider API(`api.openai.com`, `api.anthropic.com`)를 호출하면 해당 row는 실패로 기록하고 quality를 0점 처리한다. Direct provider API 호출은 `openai-api:*`, `anthropic-api:*` 같은 direct target에서만 허용한다.

Input/output interface contract의 단일 문서는 `docs/api-interface-contract.md`이다. 이 벤치마크 문서는 그 contract가 실제 provider 대비 schema, event, usage, error, semantic/image quality 기준을 만족하는지 검증하는 방법을 정의한다.

이 경계는 benchmark만의 사후 판정이 아니라 런타임 구조 검증으로도 고정한다. `pnpm verify:runtime-boundary`는 `src`/`dist` proxy runtime에서 direct provider host, provider credential env, ambient `process.env` pass-through를 금지하고, child CLI env sanitization만 별도 authority로 허용한다. outbound HTTP는 `codex-backend` transport가 ChatGPT Codex backend에 연결하거나 Codex OAuth access token을 refresh하는 경우에만 허용된다. 이 검증은 `pnpm test`와 `pnpm pack`의 `prepack` 단계에서 실행된다.

같은 verifier는 benchmark fixture 또는 문제 문항 리터럴이 runtime에 들어오는 것도 금지한다. Benchmark prompt, fixture 이름, expected tool/result token은 `scripts/`, `test/`, docs에만 존재해야 하며, `src`/`dist` runtime은 API field translation, provider-surface validation, context isolation, streaming forwarding 같은 일반 규칙만 가져야 한다.

리터럴 금지만으로는 이 경계가 지켜지지 않았다(2026-08-28 실측). 런타임의 `developerInstructions()`는 46줄까지 자랐고, 그 46줄 전부가 벤치 커밋 4개에서 들어왔으며 네 커밋 모두 같은 커밋에서 quality suite 문항 정의나 judge 루브릭을 함께 고쳤다 — contract 유래도 리뷰 유래도 0건이다. 문구는 리터럴이 아니라 **문항 내용의 패러프레이즈**였기 때문에 verifier를 그대로 통과했다: 예를 들어 `korean_incident_report`의 원인 후보("Codex turnWaitMs outlier, wrapper context 증가, usage 후착 대기 혼동")가 "wrapper context growth, usage/post-processing waits, transport timing, or provider turn waits"로 런타임에 들어와 있었다. 결과는 자기잠식이었다 — 그중 한 줄이 고정 길이 리포트를 항목당 한 문장으로 쓰라고 지시했고, 같은 suite가 그 답변을 (지시를 받지 않은) direct reference보다 얇다고 감점했다. **런타임을 그것을 재는 문항에 맞추면 그 문항은 더 이상 런타임을 재지 못한다.** 지금 그 블록은 8줄의 일반 요청 충실도 규칙만 남고, 문항형 어휘가 되돌아오면 `test/backend-contract.test.mjs`가 실패한다 — 검사 대상은 파일이 아니라 그 함수가 **반환하는 문자열**이다(파일 스캔은 이 규칙을 설명하는 주석에서 오탐이 난다).

현재 Codex Images proxy의 이미지 라우트는 정식 `image2_via_gpt55` 경로이며, 요청 `model`은 direct API의 라이브 이미지 모델명(`gpt-image-2` 등, 2026-08-29부터 — 발명된 이름 `image-2`는 direct처럼 거절)이다. `/v1/images/generations`, `/v1/images/edits` 요청은(`/variations`는 direct와 함께 404) OpenAI Images API surface로 입력을 normalize한 뒤 Codex OAuth `gpt-5.5` backend Responses `image_generation` tool로 변환한다. Proxy runtime은 direct provider API fallback을 금지하며, benchmark 중 proxy target이 `api.openai.com` 또는 `api.anthropic.com`을 호출하면 해당 row는 0점 실패로 처리한다.

2026-06-04 기준으로 `image-2` route의 품질 비교 authority는 direct OpenAI Images API의 invalid-model 응답이 아니라 direct OpenAI `gpt-5.5` Responses `image_generation` 결과이다. Direct Images API의 `gpt-image-1.5` positive/negative row는 별도 baseline으로 남긴다. `input_fidelity`는 image-2 API field capability에서 비활성화된 항목으로 보고, `invalid_input_fidelity_model`은 proxy 품질 실패가 아니라 disabled-field contract 확인 row로 다룬다. Proxy-local variation JSON 오류는 proxy가 지원하는 `/v1/images/variations` 표면의 400 `invalid_request_error` contract로 별도 검증한다.

이미지 runtime transform PoC는 `scripts/poc-image-runtime-pipeline.mjs`로 별도 실행한다. 이 PoC는 모델이 최종 `output_format`을 직접 만들게 하는 경로와, 모델은 backend default/canonical 이미지를 만들고 local runtime이 JPEG/WebP 변환을 수행하는 경로를 비교한다. 결과 해석은 전역 기본값이 아니라 format/style별 capability rule 후보로만 사용한다. 2026-06-07 1회 PoC에서 flat WebP는 runtime 경로가 느렸고 품질은 동일했으며, photoreal JPEG는 runtime 경로가 빨랐고 품질은 1점 낮았다.

분류별 backend format discovery는 `scripts/bench-image-format-classification.mjs`로 실행한다. 이 벤치는 `simpleFlatGraphic`, `textOrLogoGraphic`, `photorealRaster`, `productIdentity`, `referenceOrEdit`, `unknownHybrid` 각각에 대해 `default`, `png`, `jpeg`, `webp` backend 요청 포맷을 반복 측정한다. 2026-06-07 5회 결과에서는 여러 분류가 하나의 전역 포맷으로 수렴하지 않았고, `referenceOrEdit`와 `unknownHybrid`는 포맷 선택보다 이미지 생성/편집 품질 안정화가 선행되어야 함을 보였다.

`simpleFlatGraphic`과 `photorealRaster`처럼 후보 포맷이 경합하는 분류는 `scripts/bench-image-format-targeted.mjs`로 prompt-diverse targeted discovery를 추가 실행한다. 2026-06-07 3회 결과에서는 `simpleFlatGraphic`의 `png/jpeg/webp` 모두 min 95를 만족하지 못해 format rule 승격을 보류했고, `photorealRaster`는 `png/jpeg/webp` 모두 min 95 이상을 유지했다. 이 중 WebP는 median 53.1초, max 75.7초, median bytes 126,819로 속도 tail과 payload size가 가장 균형적이었다.

`x_proxy_image_route` 같은 proxy-only Images extension field를 사용한 결과는 provider parity row가 아니라 proxy enhanced row로 분리한다. Provider parity row에서는 direct API와 proxy가 같은 provider-compatible input surface를 받아야 하므로 proxy-only field를 제외한다.

## 비교 Authority

| Proxy target | API surface | Direct comparison authority | 비교 기준 |
| --- | --- | --- | --- |
| `proxy-codex` | OpenAI Chat | OpenAI Chat Completions | product hybrid path: text/tool uses `codex-backend`; schema, exact output, stream shape, usage, semantic quality |
| `proxy-codex` | OpenAI Responses | OpenAI Responses | product hybrid path: text/tool uses `codex-backend`; schema, function call/tool result, stream shape, usage, semantic quality |
| `proxy-codex` | OpenAI Images | OpenAI `gpt-5.5` Responses `image_generation` for `image2_via_gpt55` quality through Codex backend; direct Images API rows only as separate baselines | schema, image quality, stream latency, URL/edit/variation behavior, no direct-provider egress |
| `proxy-codex-app-server` | OpenAI Chat/Responses text and tools | OpenAI Chat/Responses | diagnostic target for the older app-server text/tool path and `turnWaitMs` decomposition; not the product hot path |
| `proxy-codex-backend` | OpenAI Chat/Responses text and tools | OpenAI Chat/Responses | diagnostic target for the standalone thinner ChatGPT Codex backend transport; product path is `proxy-codex` |
| `proxy-claude` | Anthropic Messages | Anthropic Messages Opus (`claude-opus-4-8`) | schema, text/tool/image block behavior, stream shape, usage, semantic quality |

Cross-provider semantic references are not valid benchmark authority: `proxy-codex`, `proxy-codex-app-server`, and `proxy-codex-backend` quality are compared only with OpenAI direct API, and `proxy-claude` quality is compared only with Anthropic direct API. The benchmark runner therefore does not execute OpenAI-shaped quality rows for `proxy-claude` or Anthropic quality rows for Codex targets.

모든 판정은 **같은 모델의 proxy↔direct 페어** 안에서 이뤄진다. 별도의 통제군 모델은 없다: 모델 X의 proxy 사용 가능 판정은 ① 응답특성 동일(contract rows) ② direct X 대비 상대 품질 ③ direct X 대비 상대 지연, 세 축으로 한다. 한 row 안에서 proxy와 direct는 항상 동일 요청을 받는다(페어 불변식). direct row 라벨은 실제 실행 모델에서 파생된다(`openai-api:<model>`, `anthropic-api:<model>`); target 선택은 부분 문자열 매칭이라 `--targets=openai-api` 또는 family alias(`anthropic-api:opus`)로 지정한다.

### 모델군별 호출 규약

Provider가 모델 세대별로 문서화한 호출 규약은 프롬프트 최적화가 아니라 API 표면의 일부이므로 벤치 row 정의에 반영한다. 반영은 항상 페어 양쪽에 동일하게 적용한다.

- gpt-5.6 계열은 `/v1/chat/completions`에서 function tools 사용 시 `reasoning_effort: 'none'`을 요구한다(`/v1/responses`는 reasoning과 tools 동시 지원). chat tool rows는 이 규약대로 `reasoning_effort: 'none'`을 보낸다 — gpt-5.5에서도 유효한 일반 규칙이다. **측정 기반 변경 주의:** 이 값은 페어 양쪽에 동일하게 가지만 proxy 런타임의 실행 모드(reasoning off)도 바꾸므로, 2026-08-19 이전 baseline과 chat tool 행의 지연을 직접 비교하면 안 된다. baseline 비교는 측정 기반(모델·격리·judge 등)이 다르면 `regressionGate.basisMismatch`로 표시되고 stderr에 경고가 나간다.
- 규약 위반 요청(5.6 + chat tools + effort 미지정)은 direct가 400으로 거절하지만 proxy는 Responses 변환 경로라 성공시킨다. 이 관대함은 문서화된 proxy-enhanced 동작으로 유지한다(2026-08-19 결정, `docs/api-interface-contract.md` 구현 차이 표 참조) — provider parity row가 아니므로 error-parity negative row는 두지 않는다.
- family-5 Anthropic 모델은 응답이 길어 구세대 기준 fixture 토큰 예산에 잘린다. multimodal rows와 semantic reference의 max tokens는 완주 가능한 상한으로 유지한다(현재 256/2048; 상한 완화는 완주하던 행에 영향이 없다).

If a direct semantic reference fails, the benchmark records `referenceErrors` and fails that row as a reference-availability problem rather than treating it as proxy output quality. This distinction matters for provider `max_tokens` failures: `max_tokens` is the per-request output cap, not subscription or credit exhaustion.

## 판정과 종료 코드

exit 0은 "측정했고 문제가 없었다"만을 의미한다. 다음 중 하나라도 해당하면 exit 1이며, 이유는 summary의 `verdictFailures`와 stderr의 `BENCHMARK FAILED —` 줄에 남는다.

- 실패한 row가 있다(`failed > 0`).
- `--baseline`을 읽지 못했다. 측정 결과는 그대로 보존·기록하지만, 요청한 비교가 실행되지 않았으므로 통과로 보고하지 않는다.
- baseline 대비 회귀가 있다(`regressionGate.regressions`).
- 비교 대상 row가 있는데 그중 어느 것도 실제로 비교되지 않았다(`eligibleRows > 0`인데 `comparedRows === 0`). basis 불일치로 전 행이 void되거나, baseline에 같은 row가 없거나, 양쪽이 공유하는 유효 metric이 없을 때가 여기 해당한다. `--regression-targets`가 제외한 row는 운영자가 스스로 좁힌 범위이므로 대상에 넣지 않는다. 이유별 건수는 `regressionGate.skippedByReason`에 남는다.

비교 기반(basis) 필드가 다르면 그 필드가 지배하는 row의 delta는 무효가 된다(`regressionGate.basisMismatch`). 기반 필드에는 모델·judge·격리 설정과 함께 `repeats`(표본 수가 달라지면 median과 min-of-N의 의미가 달라진다)와 `codexImageTransport`가 포함된다. `codexImageTransport`는 이미지 행이 실제로 실행된 run에서만 기록한다 — basis 범위가 OpenAI 계열 전체라, 텍스트 전용 run에 기록하면 그 transport가 지배하지 않는 행까지 무효화한다. baseline이 아예 기록하지 않은 필드는 불일치가 아니라 `basisUnknown`으로만 보고하고 비교는 진행한다.

각 row의 `sample`은 그 row의 게이트가 실제로 읽은 최저 점수 표본이다: semantic row는 `relativeQuality`(없으면 절대 `score`), image row는 `imageQuality.score` 기준이며, 서로 다른 척도를 섞어 최저값을 고르지 않는다.

`--quality-repeats`, `--semantic-quality-repeats`, `--image-quality-repeats`, `--min-semantic-quality`, `--min-image-quality`에 정수가 아닌 값을 주면 실행 전에 오류로 멈춘다. `0.9`가 0으로 잘려 게이트가 조용히 꺼지는 것을 막기 위해서다.

## Suite 계층

| Suite | 목적 | 실행 빈도 | 반복 수 | 실패 시 의미 |
| --- | --- | --- | --- | --- |
| `contract-smoke` | 빠른 schema/shape 회귀 확인 | 매 변경 | 1 | 구현 contract 깨짐 |
| `provider-parity` | 실제 provider 대비 schema, usage, latency 확인 | 주요 변경 | 3 | API 대비 동작 또는 속도 회귀 |
| `quality-realistic` | 실사용 prompt의 의미 품질 확인 | 주요 품질/컨텍스트 변경 | 3 | 품질 게이트 미달 |
| `image-realistic` | 이미지 생성/편집의 실사용 품질 확인 | 이미지 경로 변경 | 1-3 | 이미지 품질 또는 표면 회귀 |
| `release-gate` | 배포 전 통합 확인 | 커밋/릴리스 전 | 5 | 배포 보류 |

## Contract Matrix

| 영역 | 현재 대표 케이스 | 추가해야 할 케이스 | 합격 기준 |
| --- | --- | --- | --- |
| Chat text | `openai.chat.text.schema_exact` | Korean exact output, long input, low/max token boundary | direct API와 동일 schema, exact text, provider usage |
| Chat stream | `openai.chat.stream`, `openai.chat.stream_usage` | empty first delta, usage-only final chunk, delayed backend notification | event order, `[DONE]`, `include_usage` shape |
| Chat tool | `tool_call`, `tool_call_stream`, `tool_result` | parallel tools, required specific tool, invalid tool schema error | tool id/name/arguments schema exact, partial argument latency recorded |
| Responses text | `openai.responses.text` | mixed content input, instructions field, previous response handoff | `response` object schema, output array, no top-level `output_text` |
| Responses function | `tool_call`, `tool_call_stream` | multiple function calls, JSON argument fragmentation | function call item schema, argument stream reconstructs exactly |
| Anthropic text | `anthropic.messages.text` | Korean answer, system prompt, max_tokens boundary | Messages schema, stop reason, usage |
| Anthropic tool | `tool_use`, `tool_result`, `tool_use_stream` | forced tool name, rejected tool schema, streamed JSON fragments | content block schema and input JSON exact |
| Multimodal input | OpenAI/Anthropic red PNG fixture, red/blue multi-image order | URL vs base64, unsupported `file_id`, invalid image bytes | direct provider accepts fixture before proxy quality is judged |
| Images generation | proxy/direct `image2_via_gpt55`, direct `gpt-image-1.5` positive, direct Images `image-2` negative baseline, photoreal product, asset icon, text poster | Korean prompt, dense visual layout, large canvas variants | proxy `image-2` returns OpenAI Images-compatible payload without direct provider egress; direct rows verify provider image quality and current API errors |

Direct GPT image model positive rows do not send `response_format`; GPT image models return `b64_json` by default and the parameter is only valid for DALL-E-style response formatting. Proxy GPT image rows reject `response_format` with the same `unknown_parameter` error surface.
| Images reference-guided generation | style reference, product identity reference, product + palette multi-reference | deterministic reference PNG fixtures, direct Responses `input_image`, proxy Images edit JSON `images` | judge receives reference image(s) and candidate image together; style fidelity, product identity, palette transfer, and unwanted copying are scored |
| Images edit | proxy/direct `image2_via_gpt55`, direct `gpt-image-1.5` edit positive, composition-preservation edit | mask PNG, invalid mask size | JSON `images` and multipart `image[]` validation covered; image-2 input fidelity disabled row is contract, not quality failure |
| Images variation | *(삭제, 2026-08-30)* — direct API가 `/v1/images/variations`를 `dall-e-2`와 함께 없앴고(빈 404) 프록시도 같다. `error_variation_json` 케이스는 양쪽 404를 고정하는 용도로만 남는다 | — | — |
| Error parity | reasoning effort unsupported probe, missing prompt, invalid output compression, input fidelity disabled, variations 404(양쪽) | invalid enum, conflicting image fields, oversized body, bad multipart boundary | status, `error.type`, optional `param`, optional `code`, message presence match provider style |

## 품질 벤치 설계

품질 확인은 단일 “정답 문자열”만 보지 않는다. 이전 실수처럼 provider가 fixture를 처리하지 못했는데 proxy 품질을 평가하는 일이 없도록, 모든 품질 벤치는 direct provider reference를 먼저 확보한다.

### Text semantic quality

| 축 | 케이스 예 | Judge 기준 |
| --- | --- | --- |
| 언어 | 한국어 최적화 표, 영어 구현 리뷰 | 지시 언어 유지, 요구 용어 포함 |
| 구조 | Markdown 표, 정확한 bullet 수, JSON object/schema | 구조 충실도, 불필요한 서문 없음 |
| 사실 보존 | latency/usage/streaming handoff | 숫자와 qualifier 보존 |
| 도구 맥락 | tool result를 받은 뒤 요약 | tool 결과 반영, hallucination 없음 |
| 실패 triage | provider error와 proxy mismatch 설명 | 원인 우선순위, 잘못된 blame 방지 |

현재 `realistic` semantic suite는 10개 prompt shape를 포함한다: 구현 리뷰, 한국어 최적화 표, 멀티모달 실패 triage, handoff 요약, 한국어 incident report, strict JSON contract summary, streaming latency decision table, provider error policy, Images API benchmark plan, release-gate decision.

Gate:

- 품질 게이트는 같은 모델의 direct reference 대비 **상대** 기준이다: judge가 내는 `relativeQuality`(reference 대비 요구 충족도 %) 최저값이 `--min-semantic-quality`(기본 95) 이상이어야 한다. 100 = meaningfully equivalent, 100 초과 = reference보다 우수.
- 절대 `score`는 진단용으로 계속 기록되며(`semanticQuality`), 게이트 실패 메시지에 relative/absolute가 병기된다.
- direct reference 자체가 실패하면 그 row는 proxy 품질 실패가 아니라 reference 무효(`referenceErrors`)로 기록된다. reference 예산(max tokens)은 완주 가능하도록 잡되, 종료 조건은 "direct가 유효한 reference"이지 "proxy 통과"가 아니다.
- hard fail: required term 누락, 숫자/식별자 왜곡, schema contract 위반
- **표본 통계는 최저값(min-of-N)이다. median으로 완화하지 않는다.** 근거는 실측이다(2026-08-27, judge `gpt-5.5`, **절대 척도**): 저장된 후보 텍스트·reference·루브릭을 고정한 채 같은 판정을 5회 반복하면 점수 폭이 **최대 ±3점**(평균 2.7)이고, 경계 6개 row에서 min과 median의 판정이 **한 건도 갈리지 않았다**. 즉 min이 잡는 실패는 판정자 변동이 아니라 후보 자체의 미달이며, median으로 바꾸면 얻는 것은 없고 간헐 결함(2026-08-19 이미지 배경 반전처럼 턴당 8~20%로 나타나는 종류)을 가리게 된다.
- **상대 척도의 분해능은 그보다 넓다(2026-08-28 실측, judge `gpt-5.5`, 5회 반복, 14행, `bench-results/rejudge-boundary-relative-20260828.json`).** 게이트가 읽는 것은 `relativeQuality`인데, 같은 재판정 프로브를 경계 두 task(`korean_incident_report`·`streaming_latency_decision`)에 돌리면 상대 점수의 폭은 **최대 7·평균 2.93**이고 min과 median의 판정이 **14행 중 2행에서 갈린다**. 따라서 위 줄의 "한 건도 갈리지 않았다"는 절대 척도에서 관찰된 성질이며 상대 척도로 옮겨오지 않는다. min-of-N 자체는 유지한다 — 간헐 결함을 가리지 않는 보수적 선택이라는 이유는 그대로다. 다만 **"min이 잡는 실패는 판정자 변동이 아니다"라는 추론은 상대 척도에서 성립하지 않으므로**, 임계값 ±4 안의 상대 미달은 재판정 프로브로 폭과 min·median 일치 여부를 확인하기 전까지 후보 미달로 단정하지 않는다. 폭이 좁은 미달은 다르다: 같은 실측에서 `korean_incident_report`는 Codex 계열 세 타깃 전부 86~90에 폭 2로 모였고 `proxy-claude`는 100을 폭 0으로 냈다 — 이런 모양은 판정자 변동이 아니라 후보 자체의 미달이다.
- 게이트 자체에는 회색지대가 없다. 러너는 `relativeQuality` 최저값이 임계값 미만이면 그대로 실패시킨다(`api-comparison-benchmark.mjs`의 semantic 게이트). ±3은 **사람이 임계값 근처의 실패를 읽는 방법**이지 러너의 판정 규칙이 아니다.
- 임계값 근처(예: 92~97) 실패가 판정자 변동인지 후보 미달인지 가리려면 `node scripts/rejudge-semantic-sample.mjs --artifact <run.json> [--case <id>] [--repeats 5]`로 **저장된 후보를 고정한 채 재판정**한다. `--semantic-quality-repeats`를 올리는 것으로는 그 구분이 불가능하다 — 반복마다 후보와 reference를 새로 뽑으므로 판정자·후보·기준이 함께 움직인다.
- 상대 지표는 판정을 관대하게 만들지 않는다: 같은 실측에서 절대→상대로 바꿔도 경계 6개 row의 판정은 **전부 동일**했고(통과 row는 96→100으로 올라가고 미달 row는 92→90으로 유지), 상대 기준이 존재하는 이유는 관대함이 아니라 reference가 같은 제약을 받는 과제에서 비교 기반을 맞추는 것이다.

### Image quality

이미지 품질은 b64 크기나 revised prompt만으로 판단하지 않는다. 이미지 출력 자체를 vision judge에 넣고 direct API 또는 명시된 요구사항과 비교한다.

| 축 | 케이스 예 | 평가 기준 |
| --- | --- | --- |
| 단순 생성 | 빨간 사각형 | 색/형태/배경 충족 |
| 에셋 생성 | 앱 아이콘/스티커형 에셋 | 주요 객체, 배경 옵션, 텍스트 없음 |
| 텍스트 포함 | 짧은 영문 라벨, 한글 라벨 후보 | 텍스트 가독성, 오탈자 수 |
| 실물풍 | 제품 mockup, 인테리어 장면 | prompt 객체/스타일/구성 반영 |
| reference style generation | 스타일 카드 참조로 새 아이콘 생성 | 참조 스타일/팔레트 반영, 참조 subject 복사 금지, flatness |
| reference product generation | 제품 참조로 스튜디오 이미지 생성 | 제품 identity, 색상, 형태, handle/rim 같은 세부 요소 보존 |
| multi-reference generation | 제품 참조 + 팔레트 참조 조합 | reference별 역할 구분, 제품 보존, palette/style transfer |
| 편집 | 색상 변경, 객체 제거, 배경 유지, 보존 중심 편집 | 원본 보존, 변경 영역 정확도 |
| mask edit | 투명 mask 영역만 교체 | mask 외부 보존 |
| multi-image edit | 로고/색상/제품 참조 합성 | 참조 이미지 fidelity |
| URL response | 반환 URL fetchback | 200, content-type, TTL/expiry error |
| streaming | completed image | first completed-image latency, final event 중복 없음, partial 미지원 |

Gate:

- vision requirement score: minimum 90
- edit preservation score: minimum 85
- text rendering score: minimum 80, text-heavy cases는 별도 tracked risk
- hard fail: 빈/손상 이미지, 잘못된 content-type, prompt 핵심 객체 누락, URL fetch 실패
- disabled-field contract: Codex 백엔드의 이미지 모델(`gpt-image-2-codex`)이 거절하는 `background: transparent`는 proxy에서 400 `image_generation_user_error`로 전달된다. 2026-08-30 실측으로 direct `gpt-5.6-terra`의 Responses 이미지 도구는 transparent를 **수용해 생성**하므로 이 행은 패리티 행이 아니라 백엔드 능력 격차를 고정하는 proxy 전용 행이다.
- prompt 또는 translator 개선은 특정 benchmark 문항에만 맞춘 문구가 아니라 flat/style, geometry, edit preservation, output field translation처럼 실제 요청 전반에 적용되는 일반 규칙이어야 한다.
- flat/vector reference-style PNG 후처리는 benchmark fixture 전용 보정이 아니라, reference-style flat graphic 요청 전반에서 gradient/background shading을 줄이는 deterministic edge-preserving 규칙이어야 한다. 작은 accent 색상과 outline/antialiasing이 손상되면 품질 실패로 본다.
- reference-guided generation 품질 평가는 출력 이미지만 보지 않는다. judge 입력에 reference image(s)를 먼저 넣고 candidate output을 뒤에 넣어, 참조 fidelity와 요구사항 충족을 같이 평가한다.

## Latency Metrics

| Metric | 의미 | 기록 대상 |
| --- | --- | --- |
| `totalMs` | 전체 요청 시간 | 모든 케이스 |
| `firstDataMs` | SSE 첫 data 수신 | stream |
| `firstTextMs` | 첫 텍스트 delta | text stream |
| `firstToolArgumentMs` | 첫 tool/function/image b64 delta | tool stream, image stream |
| `firstImageMs` | 이미지 stream의 첫 completed b64 payload 도착 시간; partial image payload는 proxy 벤치 지표에서 제외 | image stream |
| `chunks` | 의미 있는 delta 수 | stream |
| `backendTiming.turnWaitMs` | Codex app-server provider turn 대기 | `proxy-codex-app-server`, image rows under `proxy-codex` |
| `usageWaitMs` | provider usage 후착 대기 | `proxy-codex-app-server`, image rows under `proxy-codex` |

Gate:

- proxy median total latency: direct API 대비 +30% 또는 +750ms 초과 시 regression 후보
- stream first data: non-image text/tool은 direct 대비 별도 추적
- image stream latency: direct Responses API의 `response.created` 같은 초기 lifecycle event와 `partial_image` payload는 Images API proxy의 완성 이미지 표면이 아니므로, completed image 기준의 `firstImageMs`/`firstToolArgumentMs`를 사용자 체감 지표로 본다
- partial image streaming은 proxy 표면에서 지원하지 않는다. `partial_images > 0`은 provider-style 400으로 거절하고, stream은 `image_generation.completed` 또는 `image_edit.completed`만 사용자에게 보낸다.
- order-sensitive image stream diagnostics: `openai.images.generation_stream_paired`는 partial 없이 proxy/direct 순서를 repeat마다 교차 실행해 시간대 편향을 줄이고, 첫 완성 이미지 payload 기준 paired delta를 남긴다
- multi-image b64 diagnostics: `openai.images.generation.image2_via_gpt55.b64_json_n3_parallel`은 proxy Images API의 `n: 3` 단일 요청을 direct gpt-5.5 image_generation 3개 병렬 실행과 비교한다. proxy 런타임은 비스트리밍 `n > 1` 요청을 독립 image turn 병렬 실행으로 처리하며, backendTiming은 요청 단위 critical path aggregate만 남긴다.
- multi-image quality aggregation: 다중 이미지 케이스는 첫 이미지만 보지 않고 모든 이미지의 `imageQuality`를 채점한다. row의 `imageQuality.score`는 이미지별 점수의 최저점으로 기록해, 한 장만 실패한 경우도 게이트가 감지하도록 한다.
- paired diagnostics keep `sampleFailures` with provider error details such as `insufficient_quota`, so a quota/rate-limit failure can be separated from proxy latency regression
- image generation/edit은 provider 자체 변동성이 크므로 p50/p95와 outlier reason을 함께 본다

## 교환 기록 (적합성 스위트 이행 1단계)

모든 실행이 자신이 만든 HTTP 교환을 `artifacts/api-captures/<runId>/`에 남긴다. 교환마다 보낸 요청
본문 원본, 상태줄, 응답 헤더, 응답 바이트, 스트림이면 **파싱 이전의 와이어 텍스트**를 저장하며, 인증
헤더는 값 대신 `present and redacted`로 기록한다. 본문은 64KB를 넘으면 gzip한다 — 압축은 무손실이고
잘라내기는 아니기 때문이다. 실패한 시도는 재시도가 덮어쓰지 않는다(일련번호가 정체성이다).

단언은 이 기록을 읽지 않는다. 이 단계의 목적은 판정을 바꾸는 것이 아니라 **증거를 잃지 않는 것**이다:
`bench-results/*.json`은 판정과 텍스트 표본만 남기므로, 이 프로젝트는 vendor 요청 필드 기본값을 한 번도
관찰하지 못했다. 첫 실행에서 바로 값을 했다 — `/v1/chat/completions` 스트림의 종결자가
`data: [DONE]\n\n`으로 와이어에 기록됐고, 이는 적합성 매트릭스에서 가장 위험한 미검증 셀이었다.

끄려면 `--no-capture true`. 위치를 바꾸려면 `--capture-dir <path>`.

## 실행 명령

빠른 contract:

```bash
pnpm test
pnpm bench:api -- --suite=contract-smoke --targets=proxy-codex,proxy-claude --repeats 1
pnpm bench:api -- --suite=contract-smoke --targets=proxy-codex-app-server,proxy-codex-backend --repeats 1
```

Provider parity:

```bash
pnpm bench:api -- --suite=provider-parity --targets=proxy-codex,proxy-claude,openai-api,anthropic-api:opus --repeats 3 --output /tmp/api-provider-parity.json
```

Semantic quality:

```bash
pnpm bench:api -- --suite=quality-realistic --targets=proxy-codex,proxy-claude --semantic-quality-repeats 3 --min-semantic-quality=95 --output /tmp/api-semantic-quality.json
```

Image API/detail parity:

```bash
pnpm bench:api -- --suite=image-realistic --targets=proxy-codex,openai-api --image-quality-repeats 1 --min-image-quality=90 --repeats 1 --output /tmp/api-image-parity.json
```

Release gate:

```bash
pnpm bench:api -- --suite=release-gate --targets=proxy-codex,proxy-claude,openai-api,anthropic-api:opus --semantic-quality-repeats 3 --min-semantic-quality=95 --repeats 5 --output /tmp/api-release-gate.json
```

Suite 기본값:

| Suite | Case filter | Default side effects |
| --- | --- | --- |
| `contract-smoke` | core text/stream/tool schema rows | none |
| `provider-parity` | core rows plus multimodal input rows | `includeMultimodal=true` unless explicitly overridden |
| `quality-realistic` | semantic quality rows | `semanticQualityRepeats=1` unless explicitly overridden |
| `image-realistic` | Images generation/edit/variation rows plus direct Images baseline/error rows | `includeImageGeneration=true`, `imageQualityRepeats=1`, `minImageQuality=90` unless explicitly overridden |
| `release-gate` | all rows | `includeMultimodal=true`, `includeImageGeneration=true`, `semanticQualityRepeats=1`, `imageQualityRepeats=1`, `minImageQuality=90` unless explicitly overridden |

## 추가 구현 작업

| 우선순위 | 작업 | 이유 | Done when |
| --- | --- | --- | --- |
| Done | benchmark suite preset 옵션 추가 | 긴 `--cases`를 매번 수동 조합하면 누락 위험이 큼 | `--suite=contract-smoke,provider-parity,image-realistic`로 케이스 선택 가능 |
| Done | image vision judge 추가 | 이미지 품질을 b64 크기/프롬프트만으로 판단하면 실사용 품질을 놓침 | 이미지 출력이 `imageQuality` score, sub-score, violation list를 남김 |
| Done | direct Images API negative/positive baseline 추가 | `image2_via_gpt55`와 공식 Images 모델의 차이를 명시해야 함 | `gpt-image-1.5` generation/edit positive, direct Images `image-2` negative baseline row |
| Done | error parity matrix 추가 | invalid enum, missing prompt, bad multipart가 실제 SDK 사용에서 자주 발생 | missing prompt, invalid compression, image-2 input fidelity disabled, JSON variation body가 status/type/message shape를 검증 |
| Done | multi-fixture image inputs 추가 | 단일 빨간 PNG는 실사용 이미지를 대표하지 못함 | red/blue/green/transparent/mask PNG fixture family와 red/blue multi-image rows |
| Done | semantic task suite 확장 | 품질이 한두 prompt에 과적합될 수 있음 | 한국어/영어/JSON/tool/triage/summary 10개 prompt shape |
| P2 | benchmark cost estimator | image/release suite는 비용이 큼 | 실행 전 예상 provider call 수와 image call 수 출력 |
| P2 | flake/outlier classification | 이미지 latency는 변동성이 크므로 단발 실패 판단이 위험 | p50/p95/outlier reason이 summary에 표시 |

## 완료 기준

벤치마크 설계가 충분하다고 판단하는 기준은 다음과 같다.

- API contract는 positive/negative, JSON/multipart, stream/non-stream, usage/error를 모두 포함한다.
- 품질 평가는 direct provider reference 없이 proxy 단독으로 판단하지 않는다.
- 이미지 품질은 출력 이미지를 vision으로 평가한다.
- fixture가 direct provider에서 먼저 성공해야 proxy 품질 평가가 유효하다.
- 비용이 큰 suite와 빠른 suite가 분리되어, 개발 중에는 빠르게 돌리고 릴리스 전에는 넓게 돌릴 수 있다.
