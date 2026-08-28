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
| `--skip-binary-scan` | L0 문자열 스캔 | 노이즈 감소. 게이트 판정에는 원래 반영되지 않는다(아래 「알려진 결함」 참조) |
| `--skip-flag-probe` | flag parse probe | `hiddenFlagAuthority`가 `declared_fallback`이 된다 — **규칙 4-1이 경고하는 그 상태를 만드는 것이 이 플래그다** |
| `--skip-command-tree` | command 수집 | `validateDocumentedCommands`가 `not_collected`가 되어 command staleness가 0으로 보고된다 |
| `--catalog <path>` | — | 검증 대상 문서를 바꾼다. 다른 파일을 검증하고 이 카탈로그가 통과했다고 읽지 않도록 주의 |
| `--out <dir>` | — | 산출물 위치 |

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

**1m token 경고는 현재 동작하지 않는다.** 추정치가 프롬프트를 읽지 않고 고정값을 쓰며 임계값보다
두 자리 작아, 그 분기는 발화하지 않는다. 비용 통제를 이 경고에 의존하지 않는다.

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
   필요하다. 실측 반례가 있다: `--ignore-user-config`는 help에 있고 parse probe가 받아들이지만
   AGENTS.md 22,262자가 그대로 와이어에 도달했고, `-c default_tools_enabled=false`는 받아들여지지만
   내장 도구 9개가 바이트 동일하게 남았다. 두 경우 모두 이 문서의 모든 권위가 "통과"라고 말한다.
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
6. Codex app-server method는 generated schema 기준으로 삭제/rename 여부를 먼저 확인한다.
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
- **[운영자]** `artifacts/runtime-capability-smoke/latest.md`에서 각 capability가 risk와 execution mode를
  갖고 있다. 집계는 값이 없는 행을 `undefined`라는 이름의 정상 항목으로 세므로, 개수만 보지 말고
  `undefined` 버킷이 있는지 직접 확인한다.
- **[운영자]** 원본 catalog가 현재 runtime/version/source-level 사실만 담고 있다. 버전을 본문 산문에도
  적었다면 표와 함께 고친다 — 게이트는 `| Codex CLI |` / `| Claude Code |` 행만 읽으므로 산문에 남은
  옛 버전은 보이지 않는다.
- **[운영자]** 삭제/변경 이력은 artifact report에만 남아 있다.
- **[기계, 단 범위 주의]** `pnpm pack:adapter`가 통과한다. 이것은 카탈로그가 tarball에 **존재하는지**만
  확인하며 내용은 검사하지 않는다. 내용이 틀린 카탈로그도 통과한다.
- 런북 본문이 지시하는 "markdown link 검증"에 해당하는 도구는 **현재 이 레포에 없다.** 링크를 바꿨다면
  수동 확인이며, 그렇게 보고한다.

## 알려진 결함 — 초록을 읽을 때 감안할 것

이 절은 도구가 고쳐지면 지운다. 그때까지 아래 초록은 그 자체로 증거가 아니다.

2026-08-29에 둘을 고쳤다. smoke가 이미 계산해 두고 버리던 `catalogValidity`를 이제 `catalog.validity`
행으로 보고하고 실패시키며, 기대 목록이나 버전 셀이 비어 있으면 검증이 조용히 통과하는 대신
`inconclusive`가 된다. 둘 다 변이로 확인했다 — 섹션 제목을 바꾼 사본은 exit 1과 함께 이유를 내고,
버전 셀을 틀리게 바꾼 카탈로그에서는 smoke가 `verdict=needs_update`로 빨간불이 된다.

1. **smoke의 claude flag 행은 아무것도 단언하지 않는다.** 그 행들은 `--help` 출력에서 만들어졌고 "help에
   존재한다"를 확인하므로 구조상 항상 통과한다. smoke 통과 건수의 최대 블록이며, CLI에서 플래그가
   사라지면 실패가 아니라 **행이 사라진다.**
2. **codex option probe에는 네거티브 컨트롤이 없다.** claude 경로는 bogus control 두 개가
   `unregistered`로 돌아와야 결과를 신뢰하지만 codex 경로는 그 대조가 없다. codex의 거부 문구가 바뀌면
   문서화된 옵션 전부가 조용히 "확인됨"이 된다.
3. **binary scan 결과는 게이트에 들어가지 않는다.** 코드 주석은 L0 후보가 사라지면 stale로 드러난다고
   적고 있으나 실제로는 렌더링에만 쓰인다.
4. **`--help`가 실패하면 "확인 불가"가 아니라 "없음"이 된다.** 타임아웃이나 강제 종료도 명령이 사라진
   것으로 기록되므로, 원칙 1(stale 우선 처리)을 따르다 멀쩡한 명령을 지울 수 있다. stale로 뜬 command는
   지우기 전에 손으로 한 번 실행해 본다.
5. **카탈로그 본문의 probe 예시에 쓰인 control flag 이름이 코드와 다르다.** 그 줄을 그대로 복사하면
   대조 없는 probe를 돌리게 된다. probe는 두 네거티브 컨트롤이 모두 `unregistered`로 와야 증거다.
