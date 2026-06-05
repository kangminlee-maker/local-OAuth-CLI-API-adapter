# Proxy 최적화 학습 정리

이 문서는 2026-06 초반에 진행한 local OAuth CLI API adapter 최적화 작업에서 얻은 핵심 학습을 정리한다. 목적은 변경 이력을 나열하는 것이 아니라, 이후 proxy 성능·품질·API 호환성 작업에서 반복해서 적용할 판단 기준을 남기는 것이다.

## 1. 사용자 prompt가 아니라 ambient context를 줄여야 한다

학습:
사용자가 API에 보낸 prompt, instruction, tool schema는 provider API contract의 일부이다. 따라서 속도를 위해 prompt를 축약하면 API 호환성이 깨진다. 줄여야 할 대상은 CLI가 자동으로 끌고 오는 프로젝트 context, MCP/plugin/hook, 설정 파일, 기본 instruction 같은 ambient context이다.

실제 예시:
초기에는 "입력 토큰을 줄이자"는 목표가 prompt 축약처럼 보일 수 있었다. 그러나 `proxy-codex`는 사용자가 보낸 Chat `system`/`developer`/`user` 메시지와 Responses `instructions`를 보존해야 한다. 그래서 `src/proxy/codex-app-server-backend.ts`는 API instruction을 Codex thread instruction으로 구조화하고, 사용자 대화 입력은 tagged conversation으로 유지한다. 동시에 `test/codex-isolation.test.mjs`는 user MCP, plugin, hook, project config가 proxy 실행에 섞이지 않는지 검증한다.

재사용 규칙:
입력 최적화를 할 때는 먼저 "사용자가 보낸 요청인가, 런타임이 몰래 추가한 context인가"를 나눈다. 전자는 보존하고, 후자만 구조적으로 줄인다.

## 2. direct API가 품질과 contract의 기준 authority다

학습:
proxy 품질은 proxy끼리 비교하거나 다른 provider와 cross-reference하면 안 된다. `proxy-codex`는 OpenAI direct API와, `proxy-claude`는 Anthropic direct API와 비교해야 한다.

실제 예시:
semantic quality benchmark에서 `proxy-claude`를 OpenAI reference와 비교하거나 `proxy-codex`를 Anthropic reference와 비교하면, 모델 성향 차이를 proxy 품질 문제로 오판할 수 있었다. 그래서 `docs/api-benchmark-design.md`의 "비교 Authority"는 `proxy-codex -> OpenAI`, `proxy-claude -> Anthropic Opus`로 고정했고, benchmark runner도 cross-provider semantic row를 실행하지 않도록 정리했다.

재사용 규칙:
새 benchmark case를 추가할 때는 먼저 direct comparison authority를 명시한다. reference 확보 실패는 proxy quality failure와 분리해서 기록한다.

## 3. proxy runtime과 direct provider 경로는 구조적으로 분리해야 한다

학습:
proxy target이 benchmark 중 direct OpenAI/Anthropic API를 호출하면 addon의 목적이 무너진다. 이것은 단순한 테스트 실수가 아니라 제품 경계 위반이다.

실제 예시:
Images API proxy에서 실제 이미지 생성을 direct OpenAI API로 보내는 경로가 섞일 위험을 확인했다. 이를 막기 위해 `src/proxy/process-env.ts`에서 child CLI에 전달되는 provider credential/routing env를 제거했고, `scripts/verify-runtime-boundary.mjs`는 runtime source/dist에 direct provider host, direct credential pass-through, benchmark fixture literal이 들어오지 못하게 검사한다. `pnpm test`와 `pnpm pack`의 `prepack` 단계에서 이 검증이 항상 실행된다.

재사용 규칙:
벤치에서 proxy가 좋아 보이는 결과가 나오면 "정말 proxy runtime으로 해결했는가"를 먼저 확인한다. direct provider fallback은 성공 경로가 아니라 0점 처리 대상이다.

## 4. API surface exactness와 semantic quality는 별도 축이다

학습:
schema가 정확해도 답변이 낮은 품질일 수 있고, 답변이 좋아도 usage/event/error shape가 provider API와 다르면 API-compatible이라고 볼 수 없다.

실제 예시:
OpenAI Chat stream에서는 `[DONE]`, `include_usage` final chunk, tool call delta shape가 맞아야 한다. Responses stream에서는 `response.output_text.delta`, function argument delta, usage timing이 따로 맞아야 한다. 반면 semantic benchmark는 direct provider reference를 기준으로 의미·구조·요구사항 충족도를 본다. 이 둘은 `test/proxy-http.test.mjs`, `test/tool-call-stream.test.mjs`, `scripts/api-comparison-benchmark.mjs`에서 서로 다른 방식으로 검증된다.

재사용 규칙:
새 기능의 완료 조건은 최소 두 문장으로 나눈다. "API shape가 provider와 같은가"와 "같은 입력에서 provider 수준의 결과를 내는가"를 따로 통과해야 한다.

## 5. 속도 영향도와 개선 방향은 분리해서 판단해야 한다

학습:
"속도에 영향이 크다"와 "속도가 좋아진다"는 다르다. 큰 영향을 주는 작업은 개선도 가능하지만 악화도 가능하다.

실제 예시:
reasoning effort, verbosity, image quality mapping은 latency에 큰 영향을 준다. 그러나 effort를 무조건 낮추면 품질이 떨어지고, effort를 무조건 높이면 품질은 좋아질 수 있어도 속도가 악화된다. 그래서 `settings.json`은 `fallbackReasoningEffort`, `fallbackVerbosity`, `imageModel`을 설정 authority로 두고, request가 effort를 명시하면 `src/proxy/normalizers.ts`와 backend가 request 값을 우선하도록 했다.

재사용 규칙:
작업 목록을 만들 때는 `속도 영향도`, `속도 방향`, `품질 영향도`, `품질 방향`, `위험`을 분리해서 적는다. 한 칸에 "좋음/큼"을 섞지 않는다.

## 6. streaming latency는 total latency와 다른 사용자 경험 지표다

학습:
전체 요청 시간이 같아도 첫 token, 첫 tool argument, usage 도착 시간이 다르면 사용자가 느끼는 응답성은 다르다.

실제 예시:
`proxy-codex` Chat/Responses streaming에서 `request_start`, `first_model_delta`, `first_tool_call_delta`, `first_tool_argument`, `usage_received`, `stream_end` 같은 timeline을 더 안정적으로 회수하도록 했다. 특히 Codex app-server notification이 `turn/start` 응답보다 먼저 도착하는 race가 있었고, `src/proxy/codex-app-server-backend.ts`는 early delta를 buffer해서 public SSE stream이 늦어지지 않게 했다.

재사용 규칙:
streaming 개선은 `totalMs`만 보지 않는다. text stream은 `firstTextMs`, tool stream은 `firstToolArgumentMs`, image stream은 완성 이미지 기준 `firstImageMs`를 별도 지표로 본다.

## 7. 이미지 proxy의 병목은 대부분 모델 작업시간이다

학습:
image-2 via gpt-5.5 경로에서 proxy overhead보다 모델 generation turn 자체가 대부분의 시간을 차지했다. 따라서 I/O micro-optimization만으로 큰 개선을 기대하기 어렵다.

실제 예시:
reference-image benchmark에서 proxy image row의 `backendTiming.turnWaitMs`가 전체의 약 97-100%였다. 예를 들어 reference product generation은 전체 약 28.0초 중 model turn wait가 거의 전부였다. 이 결과 때문에 partial streaming보다 모델 매칭, quality/effort mapping, `n > 1` 병렬 실행 같은 방향이 더 중요한 최적화 후보가 되었다.

재사용 규칙:
이미지 속도 문제를 볼 때는 먼저 `modelWorkPct = turnWaitMs / totalMs`를 본다. 이 값이 높으면 HTTP, b64 wrapping, JSON 변환보다 모델 작업시간을 줄이는 전략을 우선한다.

## 8. image-2 via gpt-5.5는 정식 proxy 경로로 다뤄야 한다

학습:
OpenAI-compatible Images API surface를 제공하면서 실제 생성은 local OAuth Codex `gpt-5.5` image_generation으로 처리한다면, 이 경로는 실험용 fallback이 아니라 제품의 정식 구현이다.

실제 예시:
`src/proxy/image2-via-gpt55.ts`는 `image-2` 요청을 gpt-5.5 image turn에 맞게 변환한다. 이때 `quality: high/medium/low`를 각각 `xhigh/high/medium`에서 시작했다가, 속도와 품질 비교 후 `high/medium/low`로 한 단계 낮추는 실험을 했다. 또 `input_fidelity`는 image-2에서 disabled된 field로 보고 오류가 아니라 contract row로 처리했다.

재사용 규칙:
대체 경로라도 public API model로 노출되면 정식 경로다. generation, edits, variations, URL response, streaming shape, disabled field, error code까지 같은 surface로 관리한다.

## 9. 이미지 품질 벤치는 실사용 reference workflow를 포함해야 한다

학습:
단순 "프롬프트로 새 이미지 생성"만으로는 실제 이미지 API 사용 품질을 대표할 수 없다. reference image가 제공될 때 style, product identity, palette transfer를 얼마나 잘 반영하는지가 필수 품질 축이다.

실제 예시:
`scripts/api-comparison-benchmark.mjs`에 reference style generation, reference product generation, multi-reference generation을 추가했다. style reference case는 참조 스타일을 따르되 참조 subject를 복사하지 않아야 하고, product reference case는 머그의 색상·형태·손잡이·rim을 유지해야 하며, multi-reference case는 제품 reference와 palette reference의 역할을 분리해야 한다. Vision judge 입력도 prompt와 candidate만 보지 않고 reference image들을 먼저 받은 뒤 candidate output을 평가하도록 바꿨다.

재사용 규칙:
이미지 벤치 case를 추가할 때는 "reference가 있으면 무엇을 보존하고, 무엇을 복사하면 안 되는가"를 명시한다. judge도 reference와 output을 함께 봐야 한다.

## 10. 패키징과 설치 독립성도 제품 contract다

학습:
addon은 다른 repository에서 설치형 bin으로 독립 실행되어야 한다. 현재 checkout이나 sibling package에 의존하면 proxy가 동작하더라도 제품 요구를 만족하지 못한다.

실제 예시:
`scripts/package-adapter.mjs`는 `pnpm pack` 결과 tarball에 runtime 파일, `settings.json`, 필요한 문서만 들어가는지 검사한다. repo-local package namespace, relative local install specifier, source checkout path, direct provider egress 문자열이 패키지에 들어오면 실패한다. `scripts/e2e-installed-adapter.mjs`는 임시 consumer project에 tarball을 설치한 뒤 `local-oauth-cli proxy`가 실제로 뜨는지 확인한다.

재사용 규칙:
local repo에서 통과한 테스트만으로 완료를 선언하지 않는다. 설치형 artifact를 만들고, 임시 외부 consumer에서 bin이 독립 실행되는지 확인해야 한다.

## 압축 원칙

이번 최적화 작업의 핵심은 "빠른 proxy 만들기"만이 아니었다. 사용자 입력을 보존하면서 ambient context를 줄이고, direct API를 기준으로 품질을 비교하며, proxy runtime이 direct provider 경로를 절대 섞지 못하게 만들고, text/tool/image 각각의 체감 latency와 품질을 별도 지표로 측정하는 시스템을 만드는 일이었다.
