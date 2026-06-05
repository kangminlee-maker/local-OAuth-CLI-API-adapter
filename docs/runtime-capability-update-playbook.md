# Runtime capability update playbook

## 목적

Codex CLI와 Claude Code CLI의 non-interactive runtime capability가 바뀌었을 때, `docs/runtime-capability-catalog.md`의 현재 유효성을 확인하고 필요한 부분만 갱신하기 위한 절차다.

원본 catalog는 current-state 문서다. 변경 이력, 이전 버전 호환성, 과거에 있었던 flag/method, 삭제된 항목의 설명은 원본 catalog에 남기지 않는다. 그런 정보는 update report artifact에만 남긴다.

## 실행

```bash
pnpm catalog:runtime
```

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

문서에 기재된 항목이 현재 수집 권위에서 사라졌을 때 실패시키려면:

```bash
pnpm catalog:runtime -- --fail-on-stale
```

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

live model smoke는 1m token을 넘을 것으로 추정되면 warning을 출력한다. 현재 기본 live smoke는 짧은 exact-output prompt만 사용한다.

## 갱신 원칙

1. 신규 항목 추가보다 기존 항목 validity 확인을 먼저 한다.
2. 원본 catalog에는 현재 유효한 runtime 사실, source level, production 사용 규칙만 남긴다.
3. 삭제, rename, drift, 이전 버전 설명, backward-compatibility 메모는 report artifact에 남기고 원본 catalog에는 남기지 않는다.
4. L0 binary scan 결과는 후보일 뿐이다. 단독으로 원본 catalog에 production capability로 쓰지 않는다.
5. L1 help, L2 generated schema, L3 official docs는 discovery authority다. 기본 runtime path로 승격하려면 L4 runtime probe가 필요하다.
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

- `latest.md`의 `Catalog Validity`에서 stale/changed 항목이 의도대로 처리됐다.
- `artifacts/runtime-capability-smoke/latest.md`에서 각 capability가 risk와 execution mode를 갖고 있다.
- 원본 catalog가 현재 runtime/version/source-level 사실만 담고 있다.
- 삭제/변경 이력은 artifact report에만 남아 있다.
- `pnpm pack:adapter`가 통과한다.
