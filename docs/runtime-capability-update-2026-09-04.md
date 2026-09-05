# Runtime capability update — 2026-09-04

## Scope

Codex CLI `0.149.1` 기준 current-state catalog를 로컬 `codex-cli 0.153.0`에 맞춰 재검증했다. Claude Code는 이번 갱신 범위에서 제외했다.

## Structural result

- `codex app-server generate-json-schema --experimental` 생성물은 401개 파일에서 416개 파일로 늘었다.
- 0.153.0 method 분포는 ClientRequest 155, ClientNotification 1, ServerRequest 11, ServerNotification 81로 총 248개다.
- 기존에 문서화한 Codex command와 option은 현재 binary에서 모두 확인됐다.
- `turn/start` optional field에 `cyberAccessProgram`, `serviceTierForTurn`, `toolOutput`, `turnTrigger`가 추가됐다.
- `CodexErrorInfo`에는 `rateLimitExceeded`, `misalignmentPolicyViolation`이 추가됐다.

## Wire result

요청 본문을 기록하고 400을 반환하는 로컬 sink를 먼저 POST 자가 검사한 뒤, 각 arm에서 본문 1건 이상을 확인했다. 외부 provider 요청과 과금은 없었다.

- 분리된 `CODEX_HOME`의 통제 marker는 app-server 대조에서 설정한 home에만 나타났다.
- `thread/start.baseInstructions` arm은 기본 Codex persona와 skill 지시 블록을 제거하고 지정한 marker를 실었으며, `developerInstructions` marker는 그 뒤에 별도로 나타났다.
- `model_verbosity`의 `low`/`high`, `model_reasoning_effort`의 `low`/`none`이 짝 대조에 따라 움직였다.
- app-server `outputSchema`와 `codex exec --output-schema`는 모두 `text.format.strict: true`로 전송됐다.
- `dynamicTools`의 통제 marker가 요청 본문에 나타났다.
- 내장 tool 9개는 `input[0].tools` 아래 `functions` 3개와 `collaboration` 6개로 실렸다. `default_tools_enabled=false`, `--disable multi_agent`, `--disable code_mode_host`, 결합 arm 모두 대조군과 동일했다.
- output token cap 필드는 없었고 `tool_choice:"auto"`, `parallel_tool_calls:false`, `store:false`가 모든 arm에 나타났다.
- `--ignore-user-config`는 `config.toml`의 `model_verbosity:"high"`를 기본 `low`로 되돌려 config 억제 효과를 보였다.

## Corrected claim

`--ignore-user-config`의 instruction 격리 효과는 0.153.0에서 **미결**이다. 통제한 exec 대조군과 flag arm 모두 `CODEX_HOME/AGENTS.md` marker를 싣지 않아, flag가 marker를 제거했다고 판정할 수 없었다. 0.149.1 관찰을 새 버전의 L5로 승격하지 않고 current-state catalog의 「미결 효과 주장」으로 내렸다.

## Collector correction

첫 0.153.0 수집은 ServerRequest 12·총 249를 보고했지만, 실제 `ServerRequest.json` union arm은 11개였다. 수집기가 slash를 포함한 모든 nested enum을 method 후보로 취급해 `mcpServer/elicitation/request`의 mode 값 `openai/form`을 유령 method로 더했다. method 수집을 `properties.method.enum` discriminator로 한정하고 `openai/form` nested mode를 negative control로 고정했다. 같은 휴리스틱을 쓴 0.149.1 catalog의 총 238은 엄격한 discriminator 기준 baseline으로 재사용하지 않는다.

수정 후 기본 수집 경로를 다시 실행해 로컬 gitignored `artifacts/runtime-capability-catalog/latest.json`을 0.153.0·248 methods로 갱신했다. 이 report artifact는 배포 package나 Git 추적 문서가 아니며, 전체 목록이 필요할 때 현재 binary에서 다시 생성하는 로컬 산출물이다.
