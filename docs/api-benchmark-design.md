# API 대비 벤치마크 설계

이 문서는 로컬 OAuth CLI API 어댑터가 실제 provider API와 얼마나 같은 표면과 품질을 보이는지 검증하기 위한 벤치마크 설계이다. 목표는 단순 smoke 통과가 아니라, 실제 사용 환경에서 API contract, streaming latency, semantic quality, image quality, error parity가 함께 유지되는지 확인하는 것이다.

## 기준 소스

- OpenAI Images API: https://platform.openai.com/docs/api-reference/images
- OpenAI image generation guide: https://platform.openai.com/docs/guides/image-generation
- OpenAI Responses API: https://platform.openai.com/docs/api-reference/responses
- Anthropic Messages API: https://docs.anthropic.com/en/api/messages

공식 API가 직접 지원하지 않는 proxy-specific 우회 경로는 가장 가까운 provider authority를 명시한다. 예를 들어 `image-2` Images 요청은 proxy 표면은 `/v1/images/*`이지만 실제 실행 authority는 OpenAI Responses `gpt-5.5` `image_generation` tool이다.

`image-2` proxy 실행은 Images 요청의 `quality` 값을 `gpt-5.5` Responses reasoning effort에도 deterministic하게 반영한다. `quality=high` 또는 생략값은 `reasoning.effort=xhigh`, `quality=medium`은 `high`, `quality=low`는 `medium`으로 매핑한다.

2026-06-03 실제 OpenAI API negative probe 기준으로, Images API의 unsupported `image-2`와 PNG `output_compression` 오류는 `image_generation_user_error`를 반환하고, deprecated variation endpoint는 빈 body의 404를 반환한다. Responses `image_generation` edit의 `input_fidelity=high`도 현재 underlying `gpt-image-2` 모델에서 `invalid_input_fidelity_model`로 거부된다. Proxy-local variation JSON 오류는 proxy가 지원하는 `/v1/images/variations` 표면의 400 `invalid_request_error` contract로 별도 검증한다.

## 비교 Authority

| Proxy target | API surface | Direct comparison authority | 비교 기준 |
| --- | --- | --- | --- |
| `proxy-codex` | OpenAI Chat | OpenAI Chat Completions | schema, exact output, stream shape, usage, semantic quality |
| `proxy-codex` | OpenAI Responses | OpenAI Responses | schema, function call/tool result, stream shape, usage, semantic quality |
| `proxy-codex` | OpenAI Images | OpenAI Images where supported, otherwise OpenAI Responses `image_generation` | request/response shape, image event shape, URL handling, image quality |
| `proxy-claude` | Anthropic Messages | Anthropic Messages | schema, text/tool/image block behavior, stream shape, usage, semantic quality |
| `proxy-claude` | OpenAI-shaped compatibility | Anthropic Messages semantic reference, OpenAI contract shape | public schema must be OpenAI-compatible, answer quality must match Anthropic provider behavior |

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
| Images generation | `generation`, `generation_api_fields`, `generation_url`, `generation_stream`, targeted `generation_stream_paired`, direct `gpt-image-1.5` positive, direct `image-2` negative | transparent output, text rendering, photoreal product, Korean prompt | `data[]` item has exactly one of `url`/`b64_json`; metadata only when known; stream events deduped |
| Images edit | `edit`, `edit_multi_image`, `edit_multipart_stream`, direct `gpt-image-1.5` edit positive | mask PNG, high input fidelity, invalid mask size | JSON `images` and multipart `image[]` both covered; direct Responses baseline where Images API differs |
| Images variation | multipart `variation`, JSON variation negative | non-square/oversize negative | variation is multipart-only; unsupported model differences explicit |
| Error parity | reasoning effort unsupported probe, missing prompt, invalid output compression, unsupported input fidelity, JSON variation body | invalid enum, conflicting image fields, oversized body, bad multipart boundary | status, `error.type`, optional `param`, optional `code`, message presence match provider style |

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

- semantic quality score: minimum 95
- direct-provider similarity: judge가 “meaningfully equivalent or better”로 판정
- hard fail: required term 누락, 숫자/식별자 왜곡, schema contract 위반

### Image quality

이미지 품질은 b64 크기나 revised prompt만으로 판단하지 않는다. 이미지 출력 자체를 vision judge에 넣고 direct API 또는 명시된 요구사항과 비교한다.

| 축 | 케이스 예 | 평가 기준 |
| --- | --- | --- |
| 단순 생성 | 빨간 사각형, 투명 배경 아이콘 | 색/형태/배경/투명도 충족 |
| 텍스트 포함 | 짧은 영문 라벨, 한글 라벨 | 텍스트 가독성, 오탈자 수 |
| 실물풍 | 제품 mockup, 인테리어 장면 | prompt 객체/스타일/구성 반영 |
| 편집 | 색상 변경, 객체 제거, 배경 유지 | 원본 보존, 변경 영역 정확도 |
| mask edit | 투명 mask 영역만 교체 | mask 외부 보존 |
| multi-image edit | 로고/색상/제품 참조 합성 | 참조 이미지 fidelity |
| URL response | 반환 URL fetchback | 200, content-type, TTL/expiry error |
| streaming | partial/final image | first partial latency, final event 중복 없음 |

Gate:

- vision requirement score: minimum 90
- edit preservation score: minimum 85
- text rendering score: minimum 80, text-heavy cases는 별도 tracked risk
- hard fail: 빈/손상 이미지, 잘못된 content-type, prompt 핵심 객체 누락, URL fetch 실패

## Latency Metrics

| Metric | 의미 | 기록 대상 |
| --- | --- | --- |
| `totalMs` | 전체 요청 시간 | 모든 케이스 |
| `firstDataMs` | SSE 첫 data 수신 | stream |
| `firstTextMs` | 첫 텍스트 delta | text stream |
| `firstToolArgumentMs` | 첫 tool/function/image b64 delta | tool stream, image stream |
| `firstImageMs` | 이미지 stream의 첫 b64 payload delta; `firstToolArgumentMs`의 이미지 전용 alias | image stream |
| `chunks` | 의미 있는 delta 수 | stream |
| `backendTiming.turnWaitMs` | proxy-codex provider turn 대기 | proxy-codex |
| `usageWaitMs` | provider usage 후착 대기 | proxy-codex |

Gate:

- proxy median total latency: direct API 대비 +30% 또는 +750ms 초과 시 regression 후보
- stream first data: non-image text/tool은 direct 대비 별도 추적
- image stream latency: direct Responses API의 `response.created` 같은 초기 lifecycle event는 Images API 호환 payload가 아니므로 `firstDataMs`가 아니라 `firstImageMs`/`firstToolArgumentMs`를 사용자 체감 지표로 본다
- order-sensitive image stream diagnostics: `openai.images.generation_stream_paired`는 proxy/direct 순서를 repeat마다 교차 실행해 시간대 편향을 줄이고 paired delta를 남긴다
- paired diagnostics keep `sampleFailures` with provider error details such as `insufficient_quota`, so a quota/rate-limit failure can be separated from proxy latency regression
- image generation/edit은 provider 자체 변동성이 크므로 p50/p95와 outlier reason을 함께 본다

## 실행 명령

빠른 contract:

```bash
pnpm test
pnpm bench:api -- --suite=contract-smoke --targets=proxy-codex,proxy-claude --repeats 1
```

Provider parity:

```bash
pnpm bench:api -- --suite=provider-parity --targets=proxy-codex,proxy-claude,openai-api:gpt-5.5,anthropic-api:sonnet --repeats 3 --output /tmp/api-provider-parity.json
```

Semantic quality:

```bash
pnpm bench:api -- --suite=quality-realistic --targets=proxy-codex,proxy-claude --semantic-quality-repeats 3 --min-semantic-quality=95 --output /tmp/api-semantic-quality.json
```

Image API/detail parity:

```bash
pnpm bench:api -- --suite=image-realistic --targets=proxy-codex,openai-api:gpt-5.5 --image-quality-repeats 1 --min-image-quality=90 --repeats 1 --output /tmp/api-image-parity.json
```

Release gate:

```bash
pnpm bench:api -- --suite=release-gate --targets=proxy-codex,proxy-claude,openai-api:gpt-5.5,anthropic-api:sonnet --semantic-quality-repeats 3 --min-semantic-quality=95 --repeats 5 --output /tmp/api-release-gate.json
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
| Done | direct Images API negative/positive baseline 추가 | `image-2` 우회와 공식 Images 모델의 차이를 명시해야 함 | `gpt-image-1.5` generation/edit positive, unsupported `image-2` negative row |
| Done | error parity matrix 추가 | invalid enum, missing prompt, bad multipart가 실제 SDK 사용에서 자주 발생 | missing prompt, invalid compression, unsupported input fidelity, JSON variation body가 status/type/message shape를 검증 |
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
