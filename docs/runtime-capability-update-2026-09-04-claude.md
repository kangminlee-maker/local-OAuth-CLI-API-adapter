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

요청 본문을 기록하고 400을 돌려주는 로컬 sink에 `ANTHROPIC_BASE_URL`을 물려 캡처했다.
**추론 요청은 나가지 않고 과금도 없다** — 모든 arm이 sink의 400으로 끝난다. 다만 "외부 provider
요청이 전혀 없다"는 더 강한 진술은 **사실이 아니다**: `ANTHROPIC_BASE_URL`을 돌려도 CLI는 자기
용무(인증·설정·telemetry)로 `api.anthropic.com`에 따로 접속한다(독립 재현이 CONNECT 로깅 프록시로
호스트명까지 확인했다). 같은 census에 MCP 호스트들도 나오는데, 그게 아래 `tools` 잡음의 출처다. 짝 대조는 한 번에 변수 하나만 바꿨고, 그 밖의 조건(모델 `sonnet`, 프롬프트, host
설정)은 모든 arm에서 같다. 측정 대상은 native binary `/Users/kangmin/.local/bin/claude`다 — PATH의
shim은 인자를 주입할 수 있어 짝 대조를 오염시킨다.

sink는 CLI 실행 전에 `curl`로 자가 검사해 "본문 0건"이 계기 실패와 구분되도록 했다.

### 해결된 미결 3건

| 항목 | 결과 | 권위 |
| --- | --- | --- |
| `--thinking` | `disabled`가 `thinking:{"type":"disabled"}`를 싣는다(`display` 키 없음). `enabled`와 `adaptive`는 서로도 대조군과도 **잡음 필드(`metadata.session_id`, `tools`)를 뺀 모든 필드가 같다** — 값 도메인은 셋이지만 wire 상태는 둘이다 | L5 양방향 |
| `--thinking-display` | `thinking.display`가 값대로 움직인다. 미설정 기본값은 `omitted` | L5 양방향 |
| `--task-budget` | `output_config.task_budget`이 `{"type":"tokens","total":4096}`으로 실린다. 대조군에 없는 것은 `task_budget`뿐이고 `output_config` 자체는 `{"effort":"xhigh"}`로 실린다 | L5 |

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
한 번씩만 재고 비교했다면 flag가 tool을 줄였다고 읽었을 것이다. 위 판정은 반복에서 고정된
`thinking`과 `context_management`에만 근거한다.

독립 재현이 그 원인과 억제법까지 찾았다. **MCP tool 발견이 요청과 경합하는 것**이고, 흔들리는 이름
28개 중 27개가 `mcp__*`다. `--strict-mcp-config --mcp-config '{"mcpServers":{}}'`를 주면 12회 실행
내내 25개로 고정된다 — 다음 L5는 "tool 수는 무시한다" 대신 이걸로 훨씬 깨끗한 대조를 만들 수 있다.

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

## 독립 재현 (2026-09-04, 별도 계기)

위 Wire result를 다른 세션이 **자기 sink·자기 러너로 처음부터** 다시 쟀다. 39 arm, 39 본문,
발사 실패 0건. 결과: 다섯 주장 중 **넷은 그대로 재현**됐고, 하나는 **결론은 맞지만 표현이 틀렸다**.

- 재현: `--thinking disabled`(6/6), `--thinking-display`의 양방향과 기본값 `omitted`,
  `--task-budget`(4096과 8192가 서로 다른 정규화 그룹), `disabled`와 `MAX_THINKING_TOKENS=0`의
  동일 본문 + `context_management` 동반 소실(3+3).
- `context_management`는 **잡음이 아니다**: reasoning ON 계열 9/9 존재, OFF 계열 6/6 부재,
  arm 내 변동 0. 이게 흔들렸다면 다섯 번째 주장이 무너졌을 것이다.

### 재현이 잡아낸 것

1. **"바이트 동일"은 이 실험이 만들 수 없는 결과다.** `metadata.user_id.session_id`가 실행마다
   새로 생겨, 같은 arm의 두 실행조차 바이트가 다르다. 정확한 진술은 "`metadata.session_id`와
   `tools`를 뺀 모든 필드가 같다"이다. 결론(값 셋, wire 상태 둘)은 정규화 해시로 확인됐다 —
   MCP를 끄고 `tools`까지 해시에 넣으면 control·enabled·adaptive 9개 본문이 **한 해시**로 묶인다.
2. **`tools` 잡음의 원인과 억제법**(위 본문에 반영).
3. **`output_config` 자체는 대조군에도 있다**(위 표에 반영).
4. **격리 주장의 정정**(위 Wire result에 반영).

### 재현이 추가한 대조군

`MAX_THINKING_TOKENS=2048` — 환경변수를 설정하되 0이 아닌 arm. 이것이 **대조군 그룹에 들어갔고
`context_management`도 존재**했다. 즉 `context_management` 소실의 원인은 "환경변수를 설정한 것"이
아니라 "reasoning이 꺼진 것"이다. 이 arm이 없었다면 둘을 구분할 수 없었다. 원 측정에는 없던 대조다.

### 프로브 주의 하나

`--zzz-not-a-real-flag --help`는 오류가 아니라 usage를 출력한다. `--help`가 unknown-option 검증을
건너뛰기 때문이다(값 검증은 건너뛰지 않는다). **미등록 flag 프로브는 `--help` 없이 돌려야** 판별력이
있다. 이 문서의 프로브 예시는 원래 그렇게 돼 있어 영향은 없다.
