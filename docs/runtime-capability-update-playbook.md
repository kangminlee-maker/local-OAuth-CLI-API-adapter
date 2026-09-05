# Runtime capability update playbook

## 목적

Codex CLI와 Claude Code CLI의 non-interactive runtime capability가 바뀌었을 때, `docs/runtime-capability-catalog.md`의 현재 유효성을 확인하고 필요한 부분만 갱신하기 위한 절차다.

원본 catalog는 current-state 문서다. 변경 이력, 이전 버전 호환성, 과거에 있었던 flag/method, 삭제된 항목의 설명은 원본 catalog에 남기지 않는다. 그런 정보는 update report artifact에만 남긴다.

## 실행

```bash
pnpm catalog:runtime -- --fail-on-stale
```

**`--fail-on-stale` 없이 실행하면 무엇을 발견하든 exit 0이다.** 그것이 유일한 게이트이므로 점검
목적이라면 항상 붙인다. `--fail-on-stale`은 report의 `inconclusive`에도 실패하므로 "확인 불가"가
"통과"가 되지 않는다(규칙 4-1을 강제하는 것이 이 경로다). 붙이지 않은 실행은 수집일 뿐 점검이 아니다.

기본 출력 위치:

```text
artifacts/runtime-capability-catalog/latest.json
artifacts/runtime-capability-catalog/latest.md
```

임시 검증만 할 때:

```bash
pnpm catalog:runtime -- --out /tmp/runtime-capability-catalog
```

binary string scan은 노이즈가 많다. 빠른 검증만 필요하면 끌 수 있다.

```bash
pnpm catalog:runtime -- --skip-binary-scan
```

수집 범위를 줄이는 플래그는 **그만큼 게이트를 비운다.** 무엇을 끄는지 알고 쓴다.

| 플래그 | 끄는 것 | 게이트에 미치는 영향 |
| --- | --- | --- |
| `--skip-binary-scan` | L0 문자열 스캔 | 노이즈 감소. **claude의 L0 후보가 사라지면 inconclusive가 되므로, 이 플래그는 그 신호를 끈다.** `pnpm smoke:runtime-capabilities`는 이 플래그를 항상 붙이므로 smoke의 `catalog.validity` 행은 L0 드리프트를 보지 못한다 — L0 확인이 목적이면 수집기를 직접 돌린다 |
| `--skip-flag-probe` | flag parse probe | `hiddenFlagAuthority`가 `declared_fallback`이 된다 — **규칙 4-1이 경고하는 그 상태를 만드는 것이 이 플래그다** |
| `--skip-command-tree` | command 수집 | `validateDocumentedCommands`가 `not_collected`가 되어 command staleness가 0으로 보고된다 |
| `--catalog <path>` | — | 검증 대상 문서를 바꾼다. 다른 파일을 검증하고 이 카탈로그가 통과했다고 읽지 않도록 주의 |
| `--out <dir>` | — | 산출물 위치 |
| `--probe-budget-ms <n>` | — | CLI spawn 총 소요의 상한(기본 150,000). 넘으면 남은 probe를 멈추고 **inconclusive**로 보고한다 — 밖에서 죽으면 리포트 자체가 남지 않기 때문이다 |

report의 `CLI spawns this run`이 이번 실행의 spawn 수와 총 소요를 예산과 함께 보고한다. 문서화된
표면이 늘면 이 값이 먼저 움직이므로, 타임아웃으로 발견하기 전에 여기서 보인다.

`pnpm catalog:runtime`은 매 실행마다 `latest.*` 외에 타임스탬프가 붙은 report 쌍을 추가로 쓴다.
`artifacts/runtime-capability-catalog/`는 정리하지 않으면 계속 쌓인다.

전체 capability의 input 규약, output schema, 위험 분류, smoke 결과를 확인하려면:

```bash
pnpm smoke:runtime-capabilities
```

비용이 있는 짧은 live model smoke까지 포함하려면:

```bash
pnpm build
pnpm smoke:runtime-capabilities -- --include-live-model
```

기본 출력 위치:

```text
artifacts/runtime-capability-smoke/latest.json
artifacts/runtime-capability-smoke/latest.md
```

live smoke는 `--fail-on-live-failure`를 주지 않으면 **live 행이 전부 실패해도 exit 0**이다. 실패는
`summary.liveFailures` 텍스트에만 남는다. 실행 시간을 제한하려면 `--timeout-ms`를 쓴다.

```bash
pnpm smoke:runtime-capabilities -- --include-live-model --fail-on-live-failure
```

live smoke 비용을 미리 제한하는 장치는 없다. report는 실제로 실행한 live probe 수를
`Live model probes run`으로 보고하며, 그것이 이 스위트가 비용에 대해 아는 전부다. 예전에 있던 1m token
경고는 프롬프트를 읽지 않는 고정 추정치를 임계값보다 두 자리 작은 값과 비교해 결코 발화할 수 없었고,
있지도 않은 안전장치를 문서가 보증하고 있었으므로 제거했다.

## 갱신 원칙

1. 신규 항목 추가보다 기존 항목 validity 확인을 먼저 한다.
2. 원본 catalog에는 현재 유효한 runtime 사실, source level, production 사용 규칙만 남긴다.
3. 삭제, rename, drift, 이전 버전 설명, backward-compatibility 메모는 report artifact에 남기고 원본 catalog에는 남기지 않는다.
4. L0 binary scan 결과는 후보일 뿐이다. 단독으로 원본 catalog에 production capability로 쓰지 않는다. flag 수용 여부의 권위는 parse probe이며, binary에 문자열이 남아 있어도 parser가 거부하면 catalog에 넣지 않는다.
4-1. report의 `hiddenFlagAuthority`가 `declared_fallback`이면 hidden flag drift가 검증되지 않은 상태다. 이 상태의 report로는 hidden 항목의 유효성을 판단하지 않는다.
4-2. flag probe는 값 대신 bogus control flag를 붙이는 형태만 쓴다. 값을 주면 boolean flag에서 그 값이 prompt가 되어 실제 모델 호출이 발생한다.
5. L1 help, L2 generated schema, L3 official docs는 discovery authority다. 기본 runtime path로 승격하려면 L4 runtime probe가 필요하다.
5-1. **L4는 "파서가 받았다"까지만 증명한다. "무언가를 바꿨다"는 증명하지 않는다.** 항목의 서술이
   *효과*를 주장하면 — 제어, 격리, 비활성화, 대체, 억제 — L4로는 부족하고 **L5(와이어 캡처 + 짝 대조)**가
   필요하다. 실측 반례가 있다: `-c default_tools_enabled=false`는 받아들여지지만 내장 도구 9개가
   바이트 동일하게 남고, `model_verbosity`를 `turn/start` 파라미터로 보내면 오류 없이 접수되지만
   wire에는 나타나지 않는다. 두 경우 모두 수용 단계의 권위는 "통과"라고 말한다.
5-2. **예외: Codex app-server 파라미터는 L2로 충분하다.** `validateDocumentedRequestContracts`가 문서화된
   파라미터 표를 생성 스키마와 대조하므로, `TurnStartParams`에 없는 파라미터는 `documentedButAbsent`로
   stale이 된다. 실제로 그 경로가 `model_verbosity`를 잡았다. CLI 플래그와 환경변수에는 이 대조가 없다.
5-3. **L5 절차.** ① 요청 본문을 로깅하고 400을 돌려주는 로컬 HTTP sink를 띄운다 ② **CLI를 돌리기 전에**
   `curl -X POST`로 sink를 자가 검사한다 — 이걸 건너뛰면 "본문 0건"이 "CLI가 안 보냈다"인지 "로그가
   고장났다"인지 구분되지 않는다 ③ CLI를 sink로 향하게 한다(claude는 `ANTHROPIC_BASE_URL`, codex는 합성
   `model_providers.<name>.base_url`) ④ 같은 프롬프트를 **설정을 켠 채와 끈 채로** 각각 돌린다
   ⑤ 두 본문을 diff하고 **관찰된 본문 건수를 아티팩트에 함께 기록한다**. 매 턴이 400으로 죽으므로 비용은 없다.
5-4. **설정이 무엇을 한다는 주장은 켠 실행과 끈 실행이 실제로 달랐을 때만 관찰된 것이다.** 둘이 같으면
   그 항목은 효과 없음으로 기록하거나 미상으로 남긴다. 받아들여졌다는 사실을 효과로 승격하지 않는다.
5-4-1. **짝 대조에서 필드를 신호로 읽기 전에 같은 arm을 반복해 그 필드가 고정인지 본다.** 2026-09-04
   Claude 캡처에서 `tools` 배열 길이는 동일 arm 3회 반복에 117·166·164로 흔들렸다. 한 번씩만 재고
   비교했다면 flag가 tool을 줄였다고 읽었을 것이다. 반복에서 고정된 필드만 판정에 쓴다.
5-5. **runtime 버전이 바뀌면 이전 버전의 L5는 새 버전의 권위가 아니다.** 같은 sink 자가 검사와 짝 대조를
   새 버전에서 다시 실행하거나, 해당 효과를 「미결 효과 주장」으로 내린다. 대조군에서 기대 신호 자체가
   나타나지 않으면 양쪽이 같아도 "효과 없음"이 아니라 **inconclusive**다.
6. Codex app-server method는 generated schema 기준으로 삭제/rename 여부를 먼저 확인한다.
6-1. method는 각 request/notification union arm의 `properties.method.enum` discriminator에서만 수집한다.
   `openai/form`처럼 slash를 포함한 nested mode/값 enum은 method가 아니며, 이 반례를 negative control로 유지한다.
5-3-1. **sink 격리로 말할 수 있는 것은 "추론 요청 없음·과금 없음"까지다.** `ANTHROPIC_BASE_URL`을
   돌려도 CLI는 자기 용무로 provider에 접속한다(2026-09-04 Claude 2.1.260: CONNECT 로그에
   `api.anthropic.com` 9건). "외부 요청이 전혀 없다"고 쓰지 않는다.
5-3-2. **서로 다른 두 실행의 본문은 바이트 동일해질 수 없다.** 실행마다 새로 생기는 필드가 있다
   (Claude는 `metadata.user_id.session_id`). 짝 대조 판정은 **반복에서 흔들린 필드를 뺀 정규화
   본문의 해시**로 하고, "바이트 동일"이라는 표현은 쓰지 않는다.
5-3-3. **잡음 필드는 무시하기 전에 원인을 찾고, 가능하면 억제한다.** Claude의 `tools` 흔들림은 MCP
   tool 발견 경합이고 `--strict-mcp-config --mcp-config '{"mcpServers":{}}'`로 고정된다. 억제하면
   그 필드를 판정에 다시 쓸 수 있어 대조가 훨씬 날카로워진다.
5-3-4. **효과의 원인을 값이 아니라 "설정했다는 사실"로 오귀속하지 않도록, 같은 knob의 비-트리거
   값 arm을 넣는다.** `MAX_THINKING_TOKENS=0`이 `context_management`를 없애는 것을 확인할 때
   `=2048` arm이 대조군 그룹에 남아야 "환경변수 설정"이 아니라 "reasoning off"가 원인임이 갈린다.
6-2. **surface가 있느냐를 묻는 프로브는 native binary(`Scan target`)로 돌린다.** 동작 권위를 wrapper로
   두는 규칙은 wrapper가 통과층일 때의 것이고, PATH를 선점한 shim이 인자를 삼키면 살아 있는 hidden
   subcommand가 root help로 떨어져 `absent`로 읽힌다. 2026-09-04에 cmux shim이 `attach`·`logs`·
   `stop`·`kill` 넷을 그렇게 만들었고, 그대로 믿었으면 맞는 문서 네 줄을 지웠을 것이다. alias 명령은
   native에서도 원래 이름의 usage를 내므로 이름 일치 판정만으로는 위양성이 남는다.
6-2-1. **미등록 flag 프로브에 `--help`를 붙이지 않는다.** `--help`가 unknown-option 검증을
   건너뛰어 없는 flag도 usage를 출력한다(값 검증은 건너뛰지 않는다). 음성 대조군이 `--help`와 함께
   돌면 판별력이 0이 된다.
6-3. **프로브가 멈출 수 있는 명령은 자동 프로브에서 제외한다.** `claude remote-control --help`는
   2.1.260에서 반환하지 않는다. `--help`를 붙였으니 안전하다는 가정은 버전이 바뀌면 깨진다.
7. Claude flag는 local help와 official docs-only 후보를 분리한다.
8. service-neutral runtime 설계를 유지한다. 특정 서비스 도메인 용어를 기본 catalog 용어로 넣지 않는다.
9. 위험한 실행은 원본 catalog에 성공한 기능처럼 기록하지 않는다. schema/help smoke와 live execution을 분리한다.

## Smoke 위험 분류

| 분류 | 실행 방식 |
| --- | --- |
| `safe_metadata` | version, help, generated schema처럼 읽기 전용으로 실행한다. |
| `safe_live_model` | 짧은 prompt, no-tool, scratch cwd, no-session-persistence 가능한 조건에서 실제 모델 호출을 실행한다. |
| `contained_scratch` | 파일/프로세스/thread state 변경 가능성이 있으므로 전용 scratch harness가 있을 때만 실행한다. 현재는 schema/help smoke로 남긴다. |
| `risky_side_effect` | auth, logout, install/update, plugin/marketplace mutation, remote control처럼 환경을 바꿀 수 있어 기본 smoke에서는 실행하지 않는다. |
| `schema_only` | server-originated request나 notification처럼 직접 호출 대상이 아니므로 input/output schema만 확인한다. |

## LLM 갱신 지침

LLM에게 catalog 갱신을 맡길 때는 아래 입력을 함께 제공한다.

```text
다음 파일을 기준으로 docs/runtime-capability-catalog.md를 갱신해줘.

1. artifacts/runtime-capability-catalog/latest.md
2. artifacts/runtime-capability-catalog/latest.json
3. docs/runtime-capability-catalog.md

원칙:
- 원본 catalog는 current-state 문서로 유지한다.
- 변경 이력, 삭제된 항목 설명, backward-compatibility 내용은 원본 catalog에 넣지 않는다.
- stale/changed 항목을 먼저 반영하고, additive candidate는 source level을 명확히 분리한다.
- L0/L1/L2/L3 발견을 L4 probe 없이 production hot path로 승격하지 않는다.
- smoke report의 risk/execution/status를 함께 확인하고, risky/schema-only 결과를 live 지원처럼 쓰지 않는다.
- 공식 문서 링크가 필요한 경우 최신 official docs로 재확인한다.
- 변경 후 markdown link와 package verification을 실행한다.
```

## 완료 기준

각 기준 옆의 표시는 **기계가 검사하는가**이다. 표시가 없는 것은 운영자가 직접 확인해야 하며, 통과를
보고할 때 무엇을 눈으로 봤는지 함께 적는다.

- **[기계]** `pnpm catalog:runtime -- --fail-on-stale`이 exit 0이다. 플래그 없이 돌린 실행은 이 기준을
  만족시키지 못한다.
- **[기계]** `pnpm smoke:runtime-capabilities`가 exit 0이다. 여기에는 `catalog.validity` 행(수집기의
  판정)과 모든 행이 risk·execution을 갖는지에 대한 단언이 포함된다. `status: inventory` 행은 검사가
  아니라 목록이므로 통과 건수에 들어가지 않는다.
- **[운영자]** 원본 catalog가 현재 runtime/version/source-level 사실만 담고 있다. 버전을 본문 산문에도
  적었다면 표와 함께 고친다 — 게이트는 `| Codex CLI |` / `| Claude Code |` 행만 읽으므로 산문에 남은
  옛 버전은 보이지 않는다.
- **[운영자]** L5 관찰의 runtime 버전이 현재 표의 버전과 일치한다. 재측정하지 않은 효과는 L5로 유지하지
  않고 「미결 효과 주장」에 있으며, 대조군의 기대 신호가 실제로 나타났는지도 함께 확인했다.
- **[운영자]** 삭제/변경 이력은 artifact report에만 남아 있다.
- **[기계, 단 범위 주의]** `pnpm pack:adapter`가 통과한다. 이것은 카탈로그가 tarball에 **존재하는지**만
  확인하며 내용은 검사하지 않는다. 내용이 틀린 카탈로그도 통과한다.
- 런북 본문이 지시하는 "markdown link 검증"에 해당하는 도구는 **현재 이 레포에 없다.** 링크를 바꿨다면
  수동 확인이며, 그렇게 보고한다.

## 이 도구의 현재 신뢰 수준 (2026-08-29)

**이 도구는 유지보수 모드다.** 검증 권위는 `docs/conformance-suite-design.md`가 세운 적합성 스위트로
이행 중이며, 이 카탈로그 검증기는 그 체계에 흡수될 대상이다. 아래 결함들은 **고치지 않기로 한 것**이고,
그 판단의 이유는 세 라운드에 걸쳐 수정 2건당 회귀 1건이 나왔기 때문이다 — 교체 예정인 도구에 라운드를
더 쓰는 것이 자원 배분으로 맞지 않는다.

그러므로 **이 도구의 초록은 그 자체로 증거가 아니다.** 아래를 알고 읽는다.

### 리포트가 사실과 다르게 말하는 것

1. **`CLI spawns this run`은 실제보다 적다.** 계측 스냅샷이 `update-runtime-capability-catalog.mjs:38`에서
   찍히는데 검증 단계 probe는 `:54`의 `validateCatalog` 안에서 일어난다. 객체 리터럴은 순서대로 평가되므로
   **검증이 만드는 spawn이 전부 빠진다** — 문서화된 표면이 늘 때 가장 빠르게 자라는 쪽이 바로 그 절반이다.
2. **smoke의 `catalog.validity`가 검증기의 판정을 우회한다.** 그 행은 `verdict`가 아니라 `staleCount`를
   읽으므로, 검증기가 "빈 수집 집합 대비 stale이라 말할 수 없다"고 `inconclusive`로 내린 실행을 다시
   **FAIL로 재출간**한다. codex가 없는 머신에서 실제로 그렇게 된다.
3. **그 행은 정상 실행에서 초록이 될 수 없다.** L0 후보 14개가 항상 선언되고 smoke는
   `--skip-binary-scan`을 항상 붙이므로 언제나 `inventory`다. 즉 실패할 때만 말한다.
4. **`--probe-budget-ms`에 숫자가 아닌 값을 주면 예산이 조용히 꺼진다**(`Number()` → `NaN`, 모든 비교가
   거짓). 리포트에는 `budget NaNms`로 찍힌다.
5. **`unclassified`·`emptyPopulations` 검사는 리포트를 쓴 뒤에 돈다.** 그래서 exit 1이면서도
   `latest.md`의 Failures 표는 `none`이다 — 터미널이 아니라 아티팩트를 읽는 사람은 깨끗한 리포트를 본다.
6. **예산 소진 후 컨트롤 probe가 "CLI 거부 문구가 바뀌었다"고 보고한다.** 실제 원인은 스스로 멈춘 예산인데,
   문서화된 대응은 matcher를 새 릴리스에 맞춰 다시 유도하는 것이라 가장 시끄러운 오진이다.
7. **`budgetExhausted` 필드는 아무도 읽지 않는다.** 소진과 실제 CLI 실패를 구분할 수 있는 유일한 신호인데
   소비자가 없다.

### 테스트가 덜 잡는 것

9. `test/runtime-capability-probes.test.mjs`의 부모 usage 테스트는 함수를 호출하지 않고 **소스를 정규식으로
   매칭**한다. 가드 줄을 유지한 채 비교 아래로 옮기면 통과하고, 줄바꿈만 바꿔도 실패한다.
10. `test/backend-contract.test.mjs`의 이미지 블록 추출기 `[^}]*}`는 **첫 `}`에서 잘린다.** 템플릿 리터럴
    하나만 들어가도 그 뒤는 검사되지 않는데 블록 수 단언은 통과한다.
11. 그 가드는 `image2-via-gpt55.ts`를 보지 않는다. **그 파일이 이 PR이 없애려는 패턴의 더 큰 인스턴스다** —
    클라이언트 프롬프트를 regex로 읽어 지시문을 주입하고, 문구가 이미지 벤치 문항 모양이다.

근거는 2026-08-28~29의 리뷰 세 라운드(같은 모델군 격리 실행 2회 + 다른 provider 1회)이며, 위 1·2·3은
코드에서 직접 재확인했다.

## 도구가 강제하는 것과 하지 않는 것

수집기와 smoke는 버전·명령·flag·요청 계약의 **드리프트**를 강제한다. 강제하지 않는 것이 둘 남아 있고,
둘 다 운영자 몫이다. 첫째, 카탈로그가 현재 사실만 담고 있는지 — 과거 버전 서술이 산문에 남아도 게이트는
표 행만 읽으므로 보이지 않는다. 둘째, markdown 링크 유효성 — 해당 도구가 이 레포에 없다.

`pnpm pack:adapter`는 카탈로그가 tarball에 **존재하는지**만 확인하며 내용은 검사하지 않는다.
