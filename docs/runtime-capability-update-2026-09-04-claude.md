# Runtime capability update — 2026-09-04 (Claude Code)

## Scope

같은 날 Codex 갱신이 범위 밖으로 둔 Claude Code를 `2.1.251` 기준에서 로컬 설치본 `2.1.260`에 맞춰
재검증했다. 갱신 방식 5-5("runtime 버전이 바뀌면 이전 버전의 L5는 새 버전의 권위가 아니다")가
그 갱신에서 새로 생겼고, 그 규칙이 곧바로 이 문서의 Claude L5 행 전체를 미결로 만들었기 때문에
그 부채를 갚는 작업이다.

## Structural result

`pnpm catalog:runtime`(수집기 자체 계기, L1 help walk + L4 parse probe) 기준.

- 명령 수는 50개로 그대로다. option 수는 218 → **221**로 늘었다.
- root가 광고하는 장문 flag는 **72개**다.
- 카탈로그에 없던 help flag 6개가 나왔다. root에 있는 것은 `--permission-prompts`,
  `--system-prompt-snapshot`, `--version`이고 `--all`·`--cwd`·`--json`은 하위 명령 option이다.
  **등록만 확인했고 효과는 관찰하지 않았다.**
- `hiddenFlagAuthority`는 `parse_probe`다(규칙 4-1이 경고하는 `declared_fallback`이 아니다).
- adapter가 parity 경로에서 의존하는 hidden flag 3종 `--thinking`, `--thinking-display`,
  `--task-budget`은 **모두 등록돼 있고 값 도메인도 동일**하다. 음성 대조군 두 개
  (`--zzz-not-a-real-flag`, `--zzz-catalog-probe-absent`)가 모두 `unknown option`으로 떨어져
  프로브가 판별력을 가진 상태임을 함께 보였다.
- `strings` 후보 중 `--judge-model`, `--max-cost-usd`, `--runs`, `--storybook-config`,
  `--storybook-static`는 parser가 거부한다. 카탈로그가 이미 서술한 "문자열은 남고 parser는 거부"
  경우이며 staleness가 아니다.

### PATH 해석이 바뀌었다

`claude`가 이제 superset wrapper가 아니라 **cmux가 `$TMPDIR/cmux-cli-shims/<uuid>/`에 깐 shim**으로
해석된다. 깨끗한 환경(`env -i`)의 `command -v claude`로 확인했다. shim 경로는 세션마다 바뀌므로
표에 고정 경로를 적을 수 없어 그렇게 서술했다.

## Wire result

요청 본문을 기록하고 400을 돌려주는 로컬 sink에 `ANTHROPIC_BASE_URL`을 물려 캡처했다. 외부 provider
요청과 과금은 없다. 짝 대조는 한 번에 변수 하나만 바꿨고, 그 밖의 조건(모델 `sonnet`, 프롬프트, host
설정)은 모든 arm에서 같다. 측정 대상은 native binary `/Users/kangmin/.local/bin/claude`다 — PATH의
shim은 인자를 주입할 수 있어 짝 대조를 오염시킨다.

sink는 CLI 실행 전에 `curl`로 자가 검사해 "본문 0건"이 계기 실패와 구분되도록 했다.

### 해결된 미결 3건

| 항목 | 결과 | 권위 |
| --- | --- | --- |
| `--thinking` | `disabled`가 `thinking:{"type":"disabled"}`를 싣는다. `enabled`와 `adaptive`는 서로도 대조군과도 **바이트 동일**한 `{"type":"adaptive","display":"omitted"}` — 값 도메인은 셋이지만 wire 상태는 둘이다 | L5 양방향 |
| `--thinking-display` | `thinking.display`가 값대로 움직인다. 미설정 기본값은 `omitted` | L5 양방향 |
| `--task-budget` | `output_config.task_budget`이 `{"type":"tokens","total":4096}`으로 실린다. 대조군에는 키가 없다 | L5 |

### 뒤집힌 주장

`MAX_THINKING_TOKENS=0`이 **"확인된 유일한 reasoning off 스위치이며 대응하는 flag는 없다"**는 서술은
2.1.260에서 틀렸다. `--thinking disabled`가 같은 본문을 만든다 — `thinking`도 같고,
`context_management`가 사라지는 것도 같다.

### 닫힌 미결: `context_management` 억제 수단

"끄는 수단이 있는지 미결"이었다. **있다.** reasoning을 끄면(`--thinking disabled` 또는
`MAX_THINKING_TOKENS=0`) `context_management` 키가 본문에서 통째로 사라진다. edit의 종류가
`clear_thinking_20251015`이므로 기전과도 맞는다. 다만 **reasoning을 켠 채 이것만 끄는 수단은
여전히 못 찾았다** — 그건 미결로 남긴다.

## 계기에 대한 기록

**첫 시도는 본문 0건이었고, 그것은 효과 없음이 아니라 계기 고장이었다.** arm runner가 `timeout`을
쓰는데 macOS에는 그 명령이 없어(`command not found`) CLI가 **아예 실행되지 않았다**. sink 재자가검사가
sink는 살아 있음을 보여 원인이 갈렸다. 규칙 5-5의 후단("대조군에서 기대 신호 자체가 나타나지 않으면
inconclusive")이 이번에 실제로 걸린 경우다.

**`tools` 배열 길이는 이 환경에서 잡음이다.** 같은 arm을 3회 반복했는데 117·166·164로 흔들렸다.
host-default에는 실행마다 변하는 필드가 있으므로 tool 수를 짝 대조의 신호로 읽으면 안 된다.
위 판정은 3회 반복에서 값이 고정된 `thinking`과 `context_management`에만 근거한다. 반대로 이 반복이
없었다면 `context_management` 유무도 잡음일 가능성을 배제하지 못했다.

## 남긴 부채

`2.1.251`에서 관찰한 나머지 L5 행 — `--system-prompt`, `--tools`, `--setting-sources`, `--bare`,
`--strict-mcp-config`, `--json-schema`, `CLAUDE_CODE_MAX_OUTPUT_TOKENS` — 은 재측정하지 않았다.
규칙 5-5에 따라 설치 런타임의 권위가 아니며, 「미결 효과 주장」에 한 행으로 모아 두었다.
`--safe-mode`, `--restricted`, `--disable-slash-commands`,
`--exclude-dynamic-system-prompt-sections`의 효과도 이번 범위 밖이다.

## 수집기의 위양성 4건 — 문서가 아니라 계기가 틀렸다

`pnpm catalog:runtime`이 hidden subcommand `attach`·`kill`·`logs`·`stop` 넷을 `absent`로 보고했다
(`staleCount: 4`, `verdict: needs_update`). 문서를 지우기 전에 직접 프로브했더니 **넷 다 살아 있다** —
native binary에서 각자 자기 usage를 출력한다.

원인은 수집기가 프로브에 쓰는 binary다. 수집기는 PATH 해석 결과(`data.claude.binary`)를 쓰는데
그게 이제 cmux shim이고, **shim은 이 subcommand들을 삼켜 root help로 떨어뜨린다**:

| 명령 | shim | native |
| --- | --- | --- |
| `attach` | `Usage: claude [options] [command] [prompt]` | `Usage: claude attach <id>` |
| `logs` | 〃 | `Usage: claude logs <id>` |
| `stop` | 〃 | `Usage: claude stop <id>` |
| `kill` | 〃 | `Usage: claude stop <id>` (alias) |

`kill`에는 독립적인 두 번째 원인도 있다. alias라서 native에서도 `stop`의 usage를 출력하므로,
"자기 이름으로 답하는가"로 판정하면 native에서도 위양성이 된다.

카탈로그의 기존 규칙은 "동작 권위는 wrapper 기준으로 수집한다"였다. 그 규칙은 wrapper가 통과층일 때
쓰였고, 인자를 삼키는 shim에는 맞지 않는다. **surface 존재 여부를 묻는 프로브는 `Scan target` 열의
native binary로 돌려야 한다.** 수집기는 아직 그렇게 하지 않으므로 이 네 건은 매 실행 `absent`로
남는다 — 코드 수정이 필요한 별도 과제이며, 그때까지 `verdict: needs_update`의 이 부분은
**계기 한계이지 문서 staleness가 아니다.**

`claude remote-control --help`도 이번에 걸렸다. 문서는 "조사 목적이면 반드시 `--help`만 붙인다"고
안내하는데, 2.1.260에서는 그렇게 해도 5분 동안 반환하지 않아 프로브를 죽여야 했다. 자동 프로브
대상에서 제외하도록 문서를 고쳤다.
