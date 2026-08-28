# Runtime capability catalog

## 목적

local OAuth CLI를 특정 서비스의 LLM chat UI runtime으로 붙일 때, Codex CLI와 Claude Code CLI가 실제로 지원하는 non-interactive 명령, flag, stream protocol, tool 연결 방식을 버전별로 확인하기 위한 기준 목록이다.

이 문서는 help 출력만을 권위로 보지 않는다. help, protocol schema, 공식 문서, binary scan, 실제 probe 결과를 분리해서 기록한다. production hot path에는 실제 probe를 통과한 capability만 사용한다.

현재 로컬 기준:

| Runtime | Local version | Command on PATH | Scan target | Primary hot path |
| --- | --- | --- | --- | --- |
| Codex CLI | `codex-cli 0.149.1` | `/opt/homebrew/bin/codex` | 동일 | `codex app-server --listen stdio://` |
| Claude Code | `2.1.251` | `/Users/kangmin/.superset/bin/claude` (wrapper) | `/Users/kangmin/.local/bin/claude` | `claude -p --input-format stream-json --output-format stream-json` |

PATH 주의: `~/.superset/bin/`의 wrapper script가 두 CLI를 가릴 수 있다. wrapper가 실제로 실행되는 명령이므로 version·help·schema·parse probe 같은 동작 권위는 wrapper 기준으로 수집한다. 다만 wrapper script에는 바이너리 문자열이 없으므로 string scan만 native 바이너리를 대상으로 하며, 그 후보는 wrapper와 `--version`이 일치할 때만 채택한다. 일치하는 후보가 없으면 scan은 대상 없음으로 보고한다. report의 `Command on PATH`와 `Scan target` 열이 이 둘을 구분한다.

## 신뢰 레벨

| Level | Source | 의미 |
| --- | --- | --- |
| L0 | Binary string scan | 후보만 발견. 노이즈가 많아 단독 사용 금지 |
| L1 | `--help` output | 현재 설치 binary가 노출한 public CLI surface |
| L2 | Generated protocol schema | Codex app-server처럼 schema 생성이 가능한 경우의 구조적 권위 |
| L3 | Official docs | 최신/권장 사용법 확인. 로컬 버전과 다를 수 있음 |
| L4 | Runtime probe (수용) | parser가 거부하지 않았다. dry run이 증명하는 것은 여기까지다 |
| L5 | Wire capture + 짝 대조 (효과) | 모델에 실제로 도달한 요청 본문이 바뀌었다. 설정을 켠 실행과 끈 실행이 서로 달라야 성립한다 |

운영 규칙: catalog에는 L0-L3도 기록할 수 있지만, 기본 runtime path는 L4를 통과한 항목만 사용한다. 그리고 그 항목이 무엇을 바꾼다고 서술한다면 L5까지 통과한 것만 쓴다. 확인하지 못한 효과는 서술을 낮추거나 「미결 효과 주장」에 남긴다.

L0과 L4의 관계에 주의한다. binary에 문자열이 남아 있다는 사실은 그 token이 compile되어 있다는 뜻일 뿐, parser가 그 flag를 받는다는 뜻이 아니다. 실제로 현재 Claude Code binary에는 CLI가 `unknown option`으로 거부하는 flag의 문자열도 남아 있다. flag 수용 여부의 권위는 항상 parse probe(L4)다.

**L4와 L5의 관계에는 더 주의한다.** 항목의 서술이 효과를 주장하면 — 제어, 격리, 비활성화, 대체, 억제 — L4는 근거가 되지 못한다. 이 버전에서 확인된 반례가 셋이다. `--ignore-user-config`는 help에 있고 parse probe가 받아들이지만 사용자 `AGENTS.md`가 그대로 wire에 도달했고, `-c default_tools_enabled=false`는 받아들여지지만 내장 tool 9개가 바이트 동일하게 남았으며, `model_verbosity`를 `turn/start` 파라미터로 보내면 오류 없이 접수되지만 wire에는 나타나지 않는다. 세 경우 모두 수용 단계의 모든 권위가 "통과"라고 답한다.

절대 없음을 주장할 때는 도구가 있는 것을 실제로 찾아낸다는 것을 먼저 보인다(negative control). 검증하지 않은 도구가 찾지 못했다는 사실은 발견이 아니다.

예외 하나. Codex app-server 요청 파라미터는 L2로 충분하다. 생성 schema와 문서화된 파라미터 표를 수집기가 직접 대조하므로 미선언 파라미터가 stale로 드러난다. CLI flag와 환경변수에는 이 대조가 없다.

이 문서에서 L5로 표시된 관찰의 출처는 모두 동일하다. **2026-08-28, `codex-cli 0.149.1` / Claude Code `2.1.251`**, 요청 본문을 기록하고 400을 반환하는 로컬 HTTP sink로 수집했다. sink는 CLI 실행 전에 `curl`로 자가 검사해 "본문 0건"이 계측 실패와 구분되도록 했다.

## 갱신 방식

이 문서는 current-state catalog다. 삭제된 항목, rename 이력, backward-compatibility 설명, 과거 버전 차이는 이 문서에 남기지 않는다. 해당 내용은 update report artifact에만 남긴다.

정기 점검은 아래 명령으로 실행한다. `--fail-on-stale`을 붙이지 않으면 무엇을 발견하든 exit 0이므로, 그 형태는 수집일 뿐 점검이 아니다.

```bash
pnpm catalog:runtime -- --fail-on-stale
```

수집기가 만드는 권위는 네 가지다.

| 권위 | 수집 방식 | 산출물 |
| --- | --- | --- |
| Command surface | root에서 `--help`를 재귀적으로 walk하여 모든 subcommand/option/value placeholder/choice/default를 열거 | report의 `Command Surface` |
| Protocol schema | `codex app-server generate-json-schema --experimental` | report의 `Codex Schema Methods` |
| Flag parse probe | flag에 값 대신 bogus control flag를 붙여 parser 응답을 분류 | report의 `Claude Hidden Flag Parse Probe` |
| Value domain probe | help가 choice를 노출하지 않으면서 인자를 검증하는 것으로 알려진 root option에만 수용 불가 인자를 주고 CLI가 알려주는 도메인을 기록 | report의 `Probed Option Value Domains` |

probe에 값 문자열이 아니라 flag 모양 인자를 쓰는 이유는, 값을 주면 boolean flag에서 그 값이 prompt로 해석되어 실제 모델 turn이 실행되기 때문이다. flag 모양 인자는 prompt가 될 수 없고, parser가 어느 option을 해석하지 못했는지에 따라 미등록/boolean 등록/값 등록이 모두 구분된다.

parse probe는 negative control이 `unregistered`로 나올 때만 권위를 갖는다. control이 깨지면 report는 선언 목록으로 물러서고 `hiddenFlagAuthority: declared_fallback`으로 표시한다. 이 표시가 있는 report는 hidden flag drift를 검증하지 못한 상태다.

값 도메인 probe는 인자를 검증하는 것이 확인된 option에만 건다. `--system-prompt`처럼 아무 값이나 받는 option에는 control flag가 정상 값이 되어 CLI가 그대로 기동하므로, parser 단계에서 끝나지 않고 부작용과 대기가 생긴다. 열거는 전수로 유지하고 실행 단계만 제한한다.

카탈로그가 이름을 적은 명령은 command tree에 있거나, hidden이라면 자기 `--help`를 출력해야 한다. 둘 다 아니면 stale로 집계된다. 즉 hidden 명령 목록도 매 수집 때 재확인된다.

출력 report는 `artifacts/runtime-capability-catalog/latest.md`와 `latest.json`에 생성된다. report의 `Catalog Validity`를 기준으로 기존 항목의 삭제/변경 여부를 먼저 반영한 뒤, 신규 후보를 source level에 맞게 추가한다. 세부 절차는 `docs/runtime-capability-update-playbook.md`를 따른다.

## 조사 명령

### Common

```bash
which codex
codex --version
codex --help

which claude
claude --version
claude --help
```

### Codex

```bash
codex exec --help
codex exec resume --help
codex app-server --help
codex app-server generate-json-schema --help
codex app-server generate-ts --help
codex debug --help
codex debug app-server --help
codex debug prompt-input --help
codex debug models --help
codex features --help
codex features list
```

Protocol schema probe:

```bash
tmpdir="$(mktemp -d /tmp/codex-schema.XXXXXX)"
codex app-server generate-json-schema --experimental --out "$tmpdir"
```

Hidden-surface probe (codex는 clap 기반이라 `hide = true` 항목이 `--help`에 나오지 않는다):

```bash
# pinned tag 소스에서 후보를 뽑고, 설치된 binary에서 각각 확인한다.
curl -sL "https://raw.githubusercontent.com/openai/codex/rust-v$(codex --version | awk '{print $2}')/codex-rs/cli/src/main.rs" | grep -n -B 2 "hide = true"
codex <hidden-cmd> --help        # hidden clap 항목은 자기 help를 exit 0으로 출력
codex app-server --zzz-bogus --help  # negative control: exit 2 + "unexpected argument"
```

### Claude Code

```bash
claude --help
claude mcp --help
claude agents --help
claude project --help
claude auth --help
claude doctor --help
```

Hidden-surface probe (claude는 bun-compiled commander CLI다. `hideHelp()` flag와 hidden command는 `--help`에 나오지 않는다):

```bash
# L0: binary에서 commander option 등록 문자열을 추출한다. 후보 발견용이며 수용 근거가 아니다.
strings -n 6 "$(readlink -f ~/.local/bin/claude)" | grep -oE -- '--[a-z0-9-]+ (<[^>]{1,40}>|\[[^]]{1,40}\])' | sort -u
# L4: flag에 bogus control flag를 붙여 parser 응답을 읽는다. 값이 아니라 flag를 주는 것이 핵심이다.
claude --thinking --zzz-catalog-probe-control          # "argument '--zzz-catalog-probe-control' is invalid. Allowed choices ..." → 값 flag로 등록됨
claude --maintenance --zzz-catalog-probe-control       # "unknown option '--zzz-catalog-probe-control'"                          → boolean으로 등록됨
claude --judge-model --zzz-catalog-probe-control       # "unknown option '--judge-model'"                          → 미등록
claude --zzz-not-a-real-flag --zzz-catalog-probe-control      # negative control 1 — 반드시 unregistered
claude --zzz-catalog-probe-absent --zzz-catalog-probe-control # negative control 2 — 둘 다 unregistered여야 probe가 유효
# Hidden subcommand probe: 실제 명령은 자기 usage를, 없는 이름은 main help를 출력한다.
claude <name> --help | head -1           # "Usage: claude <name>" vs "Usage: claude [options] [command]"
```

주의: `claude <flag> <value>` 형태로 probe하면 boolean flag에서 값이 prompt로 해석되어 실제 모델 호출이 발생한다. probe에는 항상 flag 모양 인자를 쓴다.

Useful official references:

- Claude Code CLI reference: https://code.claude.com/docs/en/cli-usage
- Claude Code MCP/Agent SDK docs: https://code.claude.com/docs/en/agent-sdk/mcp
- OpenAI Codex model capability reference: https://developers.openai.com/api/docs/models/gpt-5.2-codex

## Codex capability list

### CLI command surface

`--help` 재귀 walk 기준으로 73개 명령과 582개 option이 열거된다. root subcommand는 아래 27개이며(그 외 `help`), 전체 option 목록은 `artifacts/runtime-capability-catalog/latest.md`의 `Command Surface`에 있다.

| Root subcommand | 설명 | Adapter 관련성 |
| --- | --- | --- |
| `exec` | non-interactive 실행 (`exec resume`, `exec fork`, `exec review` 하위 명령 보유) | one-shot fallback |
| `app-server` | app server 및 관련 도구 (`app-server daemon`, `app-server proxy`, `app-server generate-ts`, `app-server generate-json-schema`) | **primary hot path** |
| `review` | non-interactive 코드 리뷰 | 없음 |
| `agents` | 공유 로컬 app-server daemon의 agent 세션 브라우징 | 없음; daemon 전제 |
| `queue` | 기존 세션에 메시지 큐잉 | 없음 (adapter는 ephemeral thread 사용) |
| `migrate-rollouts` | legacy 로컬 세션을 paginated thread history로 점검·이관 | 없음 |
| `login` / `logout` | 인증 관리 (`login status`) | OAuth 세션 전제 |
| `mcp` / `mcp-server` | 외부 MCP 서버 관리 (`mcp list`, `mcp get`, `mcp add`, `mcp remove`, `mcp login`, `mcp logout`) / Codex를 MCP 서버로 실행 | 서비스 tool bridge 후보 |
| `plugin` | plugin 관리 (`plugin add`, `plugin list`, `plugin remove`, `plugin marketplace`) | 없음 |
| `remote-control` | remote control 활성 daemon 관리 (`remote-control start`, `remote-control stop`, `remote-control pair`) | 끄고 유지 |
| `app`, `completion`, `update`, `doctor` | 데스크톱 앱, 셸 보완, 업데이트, 진단 | 없음 |
| `sandbox` | Codex 제공 sandbox 안에서 명령 실행 | 없음 |
| `debug` | 디버깅 도구 (`debug models`, `debug app-server`, `debug prompt-input`) | 진단용 |
| `apply` | 마지막 diff를 git apply로 적용 | 없음 |
| `resume`, `fork`, `archive`, `unarchive`, `delete` | 세션 수명주기 | 없음 (adapter는 ephemeral thread 사용) |
| `cloud` | Codex Cloud task 브라우징 (`cloud exec`, `cloud list`, `cloud status`, `cloud apply`, `cloud diff`) | 없음 |
| `exec-server` | standalone exec-server | 없음 |
| `features` | feature flag 조회 (`features list`, `features enable`, `features disable`) | 진단용 |

hot path에서 쓰는 항목:

| Command | Source | Chat runtime use |
| --- | --- | --- |
| `codex app-server --listen stdio://` | L1/L4 | native session runtime |
| `codex app-server generate-json-schema --experimental` | L1/L2 | protocol 발견 및 버전 diff |
| `codex exec --json` | L1 | one-shot fallback, smoke |
| `codex exec --output-schema <file>` | L1/L5 | strict final output fallback. `text.format`이 `strict: true`로 wire에 실리는 것을 확인했다 |
| `codex exec --ephemeral` / `codex exec --ignore-rules` | L1/L4 수용 | 등록되어 있고 parser가 받는다. 세션 파일과 execpolicy에 대한 **효과는 wire로 확인하지 않았다** — 미결 항목 참조 |
| `codex exec --ignore-user-config` | L1/L4 수용 + L5 반증 | 등록되어 있고 받아들여지지만 instruction을 격리하지 **않는다**. 이 flag를 켠 채 캡처한 본문에도 사용자 `AGENTS.md`가 user 메시지로 도달했고, `CODEX_HOME`을 빈 디렉터리로 돌렸을 때만 사라졌다. 억제 대상은 `config.toml`뿐이다 |
| `codex debug prompt-input` / `debug models` / `features list` | L1 | 진단·발견 |

CLI option 값 도메인:

| Flag | Domain | 권위 |
| --- | --- | --- |
| `--sandbox` | `read-only`, `workspace-write`, `danger-full-access` | L1 help choices (root 및 `codex exec`) |

`--model`의 값 도메인은 고정 enum이 아니라 서버가 정하는 목록이므로 위 표에 넣지 않는다. 모델 목록의 권위는 `codex debug models`이며, 각 항목은 `slug`, `supported_reasoning_levels`, `supported_in_api`, `visibility`, `priority`를 노출한다. CLI는 미지원 `--model` 값을 거부하지 않고 그대로 실행하다 요청 단계에서 실패하므로, 모델 검증은 proxy가 상류에서 수행해야 한다.

proxy가 강제하는 것은 `slug` 존재 여부뿐이다. `supported_in_api`와 `visibility`는 local OAuth proxy 경로에서 실행을 막지 않는다 — 네 가지 플래그 조합을 각각 실제 turn으로 호출해 모두 성공을 확인했다(L4 probe): `api=true/vis=list`(대조군), `api=false/vis=hide`, `api=false/vis=list`, `api=true/vis=hide`. 따라서 이 필드로 모델을 거부하지도, 노출 목록에서 빼지도 않는다. 두 필드는 다른 표면(공식 API, 선택 UI)의 정책으로 보이며 이 경로의 권위가 아니다.

`supported_reasoning_levels`는 effort 검증에 쓰지 않는다. effort 도메인의 권위는 아래 app-server 계약(모델이 광고하는 문자열)이다.

`codex app-server --code-mode-host <WS_URL>`는 로컬 host를 띄우는 대신 원격 code-mode host에 접속한다(L1). hot path는 로컬 stdio app-server이므로 기본값으로 쓰지 않는다.

### Hidden CLI surface (absent from `--help`)

codex는 clap `hide = true`로 일부 CLI를 감춘다. 아래 항목은 설치된 binary에서 각각 확인했다. hidden 항목은 자기 `--help`를 exit 0으로 출력하고, bogus flag는 exit 2 + `unexpected argument`로 끝난다(negative control). Source level: L0 소스/binary scan + L4 `--help`/parse probe.

Hidden subcommands:

| Command | Purpose | Adapter relevance |
| --- | --- | --- |
| `codex execpolicy check` | execpolicy `.rules` 파일 검사 | hot path 없음 |
| `codex responses-api-proxy` | 내부 Responses API proxy | 없음; 내부용 |
| `codex stdio-to-uds` | stdio를 Unix domain socket으로 중계 | 없음; 내부용 |
| `codex debug trace-reduce` | rollout trace 번들 재생 후 축약 상태 JSON 출력 | 진단 후보 |
| `codex debug clear-memories` | 로컬 memory 상태 초기화 | 불필요; adapter는 격리된 `CODEX_HOME` 사용 |
| `codex app-server generate-internal-json-schema` | 내부 schema artifact | 없음; public은 `generate-json-schema` |
| `codex app-server daemon pid-update-loop` | 분리형 updater loop | 없음; 내부용 |

Hidden flags. Behavior 열은 해당 flag의 `--help` 서술과 parse probe 응답에서 온 것이며 wire로 확인한 효과가 아니다(L1/L4 수용).

| Flag | Behavior (help 서술) | Adapter relevance |
| --- | --- | --- |
| `codex app-server --remote-control` | 영속화 없이 이 프로세스에 remote control 활성 | 끄고 유지; 제어면 확대 |
| `codex login --experimental_issuer <URL>` / `codex login --experimental_client-id <ID>` | OAuth issuer/client 재정의 | custom OAuth endpoint가 필요할 때만 |
| `codex login --api-key` | trap: `--with-api-key`로 파이프하라는 안내 후 종료 | 사용 금지 |

arg0/argv dispatch (binary가 호출 이름에 따라 다른 도구가 된다. 어떤 help에도 나오지 않으며, 현재 binary의 string scan에서 각 token 존재를 확인했다. L0):

| Invocation | Dispatches to |
| --- | --- |
| argv0 `apply_patch` 또는 `applypatch` | 독립 apply_patch CLI |
| argv0 `codex-linux-sandbox` | Linux sandbox helper |
| argv0 `codex-execve-wrapper` | shell-escalation execve wrapper |
| argv1 `--codex-run-as-apply-patch <PATCH>` | 패치 1건 적용 후 종료 |
| argv1 `--codex-run-as-fs-helper` | exec-server filesystem helper |

Risk: hidden 항목은 `--help` diff 없이 rename/삭제될 수 있다. Codex 버전이 올라갈 때마다 새 tag의 `hide = true` grep과 재probe를 먼저 수행한다. 현재 hidden surface 중 adapter hot path에 있는 것은 없다.

### App-server protocol surface

생성 schema 기준 현재 method 수는 238개이며, `--experimental` 생성물은 401개 파일이다.

| Category | Count | 비고 |
| --- | ---: | --- |
| ClientRequest | 150 | client → server 요청 |
| ClientNotification | 1 | `initialized` |
| ServerRequest | 12 | server → client 요청 (승인, tool call, form 등) |
| ServerNotification | 75 | server → client 알림 |

전체 목록은 `artifacts/runtime-capability-catalog/latest.json`의 `codex.schema.methodEnums`에 있다. 주요 그룹:

| Group | Methods |
| --- | --- |
| Handshake/diagnostics | `initialize`, `server/diagnostics` |
| Session/thread | `thread/start`, `thread/resume`, `thread/fork`, `thread/archive`, `thread/unarchive`, `thread/delete`, `thread/unsubscribe`, `thread/read`, `thread/list`, `thread/search`, `thread/searchOccurrences`, `thread/loaded/list` |
| Thread section | `threadSection/create`, `threadSection/list`, `threadSection/update`, `threadSection/delete`, `thread/section/move` |
| Turn control | `turn/start`, `turn/interrupt`, `turn/steer`, `thread/turns/list`, `thread/items/list`, `thread/rollback`, `thread/revert` |
| Turn queue | `thread/queue/add`, `thread/queue/start`, `thread/queue/list`, `thread/queue/update`, `thread/queue/reorder`, `thread/queue/delete` |
| Context and settings | `thread/settings/update`, `thread/metadata/update`, `thread/name/set`, `thread/memoryMode/set`, `thread/compact/start`, `thread/inject_items`, `thread/goal/set`, `thread/goal/get`, `thread/goal/clear` |
| Filesystem | `fs/readFile`, `fs/writeFile`, `fs/readDirectory`, `fs/createDirectory`, `fs/copy`, `fs/remove`, `fs/getMetadata`, `fs/watch`, `fs/unwatch` |
| Process/terminal | `process/spawn`, `process/writeStdin`, `process/resizePty`, `process/kill`, `command/exec`, `command/exec/write`, `command/exec/resize`, `command/exec/terminate`, `thread/backgroundTerminals/list`, `thread/backgroundTerminals/terminate`, `thread/backgroundTerminals/clean` |
| Tools/MCP | `mcpServer/tool/call`, `mcpServer/resource/read`, `mcpServer/oauth/login`, `mcpServerStatus/list`, `skills/list`, `skills/config/write`, `skills/extraRoots/set`, `config/mcpServer/reload`, `hooks/list` |
| Plugin/app/marketplace | `plugin/list`, `plugin/read`, `plugin/search`, `plugin/install`, `plugin/uninstall`, `app/list`, `app/read`, `app/installed`, `marketplace/add`, `marketplace/remove`, `marketplace/upgrade` |
| Project | `project/create`, `project/list`, `project/read`, `project/update`, `project/delete`, `project/import`, `project/move` |
| Memory/review/search | `memory/reset`, `review/start`, `fuzzyFileSearch`, `fuzzyFileSearch/sessionStart`, `fuzzyFileSearch/sessionUpdate`, `fuzzyFileSearch/sessionStop` |
| Server requests | `item/tool/call`, `item/tool/requestUserInput`, `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `item/permissions/requestApproval`, `applyPatchApproval`, `execCommandApproval`, `mcpServer/elicitation/request`, `attestation/generate`, `account/chatgptAuthTokens/refresh`, `currentTime/read`, `openai/form` |
| Models/features | `model/list`, `modelProvider/capabilities/read`, `experimentalFeature/list`, `experimentalFeature/enablement/set`, `collaborationMode/list`, `permissionProfile/list` |
| Account/config | `account/read`, `account/usage/read`, `account/rateLimits/read`, `account/login/start`, `account/login/cancel`, `account/logout`, `config/read`, `config/value/write`, `config/batchWrite`, `configRequirements/read` |
| Environments | `environment/add`, `environment/info`, `environment/status` |
| Realtime | `thread/realtime/start`, `thread/realtime/appendText`, `thread/realtime/appendAudio`, `thread/realtime/appendSpeech`, `thread/realtime/stop`, `thread/realtime/listVoices` |

Notification 주요 그룹:

| Group | Methods |
| --- | --- |
| Text stream | `item/agentMessage/delta`, `item/completed`, `turn/started`, `turn/completed` |
| Reasoning/plan | `item/reasoning/textDelta`, `item/reasoning/summaryTextDelta`, `item/reasoning/summaryPartAdded`, `item/plan/delta`, `turn/plan/updated` |
| Tool/process stream | `item/started`, `item/mcpToolCall/progress`, `item/commandExecution/outputDelta`, `item/commandExecution/terminalInteraction`, `command/exec/outputDelta`, `process/outputDelta`, `process/exited` |
| File changes | `item/fileChange/outputDelta`, `item/fileChange/patchUpdated`, `turn/diff/updated`, `fs/changed` |
| Usage | `thread/tokenUsage/updated`, `account/rateLimits/updated`, `account/updated` |
| Thread lifecycle | `thread/started`, `thread/status/changed`, `thread/closed`, `thread/archived`, `thread/unarchived`, `thread/deleted`, `thread/compacted`, `thread/name/updated`, `thread/settings/updated`, `thread/environment/connected`, `thread/environment/disconnected`, `thread/reverted`, `thread/queue/changed`, `thread/project/updated`, `thread/goal/updated`, `thread/goal/cleared` |
| Approval review | `item/autoApprovalReview/started`, `item/autoApprovalReview/completed`, `autoApprovalReview/strictReviewRequired` |
| Hooks/skills/plugins | `hook/started`, `hook/completed`, `skills/changed`, `app/list/updated` |
| Realtime | `thread/realtime/started`, `thread/realtime/transcript/delta`, `thread/realtime/transcript/done`, `thread/realtime/outputAudio/delta`, `thread/realtime/itemAdded`, `thread/realtime/sdp`, `thread/realtime/closed`, `thread/realtime/error` |
| Runtime/system | `error`, `warning`, `guardianWarning`, `configWarning`, `deprecationNotice`, `model/rerouted`, `model/verification`, `model/safetyBuffering/updated`, `mcpServer/startupStatus/updated`, `serverRequest/resolved`, `turn/moderationMetadata` |

### App-server 요청 파라미터 계약

adapter가 쓰는 두 요청의 선언된 파라미터는 아래와 같다(L2 schema). 기준은 `codex app-server generate-json-schema --experimental` 출력이다. adapter는 `initialize`에서 `capabilities.experimentalApi: true`를 선언하므로 experimental 모드가 적용되며, `--experimental` 없이 생성한 schema는 이 필드들을 빼고 출력하므로 계약 확인에 쓰면 안 된다.

| Request | Required | Optional |
| --- | --- | --- |
| `thread/start` | 없음 | `allowProviderModelFallback`, `approvalPolicy`, `approvalsReviewer`, `baseInstructions`, `config`, `cwd`, `developerInstructions`, `dynamicTools`, `environments`, `ephemeral`, `experimentalRawEvents`, `historyMode`, `mockExperimentalField`, `model`, `modelProvider`, `multiAgentMode`, `permissions`, `personality`, `projectId`, `runtimeWorkspaceRoots`, `sandbox`, `selectedCapabilityRoots`, `serviceName`, `serviceTier`, `sessionStartSource`, `threadSource` |
| `turn/start` | `input`, `threadId` | `additionalContext`, `approvalPolicy`, `approvalsReviewer`, `clientUserMessageId`, `collaborationMode`, `cwd`, `effort`, `environments`, `model`, `multiAgentMode`, `outputSchema`, `permissions`, `personality`, `responsesapiClientMetadata`, `runtimeWorkspaceRoots`, `sandboxPolicy`, `serviceTier`, `summary` |

값 도메인:

| Field | Domain |
| --- | --- |
| `sandbox` (`SandboxMode`) | `read-only`, `workspace-write`, `danger-full-access` |
| `approvalPolicy` (`AskForApproval`) | `untrusted`, `on-request`, `never`, 또는 granular 객체 |
| `personality` | `none`, `friendly`, `pragmatic` |
| `effort` (`ReasoningEffort`) | 모델이 광고하는 비어있지 않은 문자열 (enum 아님) |

중요: app-server는 **선언되지 않은 파라미터를 조용히 무시한다**(bogus 파라미터를 넣은 negative control로 확인). 따라서 스키마에 없는 필드를 보내도 오류가 나지 않고, 설정이 동작하는 것처럼 보이지만 실제로는 아무 일도 하지 않는다. adapter는 선언된 필드만 전송한다.

이 규칙의 실제 사례가 `model_verbosity`다. 이 이름은 config key이지 protocol 필드가 아니므로 `turn/start` 파라미터로 보내면 조용히 무시된다. wire에 도달하는 경로는 `-c model_verbosity`뿐이며, 그때 `text.verbosity`로 실린다.

### 환경 격리와 wire 기본값

adapter가 아무것도 지정하지 않았을 때 CLI가 상류로 실제 전송하는 값이다. 표의 "미설정 기본값"은 캡처한 요청 본문에서 읽은 값이며, help나 schema는 필드의 존재만 말해 주므로 이 표의 권위가 될 수 없다. 관찰 조건은 위 신뢰 레벨 절에 적은 것과 같다(2026-08-28, `codex-cli 0.149.1`, 로컬 sink).

권위 열의 표기: **L5**는 설정을 켠 본문과 끈 본문이 실제로 달랐다는 뜻이고, **L5 양방향**은 반대 값을 주었을 때 관찰값이 따라 움직이는 것까지 확인했다는 뜻이다.

| Knob | 미설정 기본값 | 효과 | 권위 |
| --- | --- | --- | --- |
| `CODEX_HOME` 리디렉션 | `~/.codex` 로드: `AGENTS.md`, 사용자 MCP 서버, `dangerFullAccess` sandbox | 빈 디렉터리를 가리키면 `instructionSources`가 비고, 내장 `codex_apps` 외 MCP 서버가 사라지며, sandbox가 `readOnly` + network 차단으로 내려간다. **instruction 격리의 실제 수단** | L5 |
| `baseInstructions` (`thread/start`) | Codex persona developer 블록 + skills 블록 | persona와 skills 블록을 함께 대체한다. 대조 실행에서는 두 블록이 모두 본문에 있었다. config 등가물 `-c instructions`는 persona만 대체하고 skills 블록은 남기므로, app-server 파라미터 쪽이 더 강하다 | L5 |
| `developerInstructions` (`thread/start`) | 없음 | base 뒤에 developer 메시지를 하나 더 추가한다 | L5 |
| `-c model_verbosity` | `text.verbosity: "low"` — 지정하지 않아도 전송된다 | CLI가 요청하지 않은 축약을 상류에 요구한다. `high`를 주면 캡처값도 `high`로 움직인다 | L5 양방향 |
| `-c model_reasoning_effort` | `reasoning.effort: "low"` — reasoning ON | `=none`이 reasoning off 스위치다 | L5 |
| 내장 tool | 항상 9개: `functions`(`exec`, `wait`, `request_user_input`) + `collaboration` 6개 | **끄는 수단이 없다.** 아래 네 가지 시도가 모두 tool 목록을 바이트 단위로 동일하게 남겼다 | L5 negative |
| output token cap | 없음 | 상류에서 강제할 방법이 없으므로 proxy가 하류에서 처리해야 한다 | L2 + L5 negative |
| `tool_choice` / `parallel_tool_calls` / `store` | `"auto"` / `false` / `false` | 호출자가 지정하지 않아도 무조건 실린다 | L5 |

두 negative 항목은 계측이 살아 있음을 먼저 보인 뒤에 기록했다. 같은 캡처에서 `text.verbosity`는 설정을 따라 움직였고 `dynamicTools`로 선언한 tool은 본문에 새로 나타났으므로, 본문을 읽는 경로 자체는 변화를 감지한다. 그 상태에서 tool 9개가 움직이지 않았고 출력 상한 필드가 어느 본문에도 없었다.

내장 tool 제거 시도 네 가지는 `-c default_tools_enabled=false`, `codex --disable multi_agent`, `codex --disable code_mode_host`, 그리고 두 flag의 조합이었다. 네 경우 모두 9개가 그대로 남았다. 이 잔여는 artifact가 아니라 응답 성향의 변화이므로 출력에서 탐지하거나 상쇄할 수 없다. 받아들이고 문서화한다.

`--ignore-user-config`는 이 격리를 대신하지 못한다. 이 flag를 켠 `codex exec` capture에서도 사용자 `AGENTS.md`가 user 메시지로 wire에 도달했다. 억제되는 것은 `config.toml`뿐이다. help에도 있고 parse probe도 통과하므로 수용 단계의 권위만 보면 통과로 읽힌다는 점이 이 항목의 요점이다.

### Codex design implications

- 서비스가 저지연 streaming, interrupt, tool event, 멀티턴 연속성을 필요로 하면 `exec --json`이 아니라 app-server를 쓴다.
- package build나 명시적 probe 시 `generate-json-schema --experimental`로 protocol drift를 감지한다.
- `thread/start`·`turn/start`에는 schema에 선언된 필드만 보낸다. 미선언 필드는 무시되므로 있으나 마나이며, 읽는 사람에게는 동작하는 설정으로 오해된다.
- `baseInstructions`, `developerInstructions`, `dynamicTools`는 `thread/start` 파라미터다. `turn/start`에 실으면 위 규칙에 따라 조용히 무시된다.
- role이 붙은 히스토리가 필요하면 `turn/start`의 `input`이 아니라 `thread/inject_items`를 쓴다. `input`의 요소 타입에는 role이 없어 전부 user로 들어간다. `inject_items`는 raw Responses item을 그대로 받는다(L2. end-to-end wire 확인은 아직 없다).
- strict 구조화 출력이 필요하면 `outputSchema`나 `exec --output-schema`를 쓴다. 둘 다 `text.format`에 `strict: true`로 실려 provider가 강제한다(L4).
- 선언 여부는 반드시 `--experimental` schema로 판단한다. adapter가 experimental API를 opt-in하므로, 축소된 schema로 확인하면 실제로 유효한 필드를 미선언으로 오판한다.
- workspace 격리는 `CODEX_HOME`·`cwd` 격리에 더해 `runtimeWorkspaceRoots`로 명시한다.
- 자식 프로세스 env에서 직접 provider 자격증명을 제거한다.
- realtime, filesystem/process method는 명시적 권한 정책과 probe 이후에만 후보로 취급한다.

## Claude Code capability list

### CLI command surface

`--help` 재귀 walk 기준으로 50개 명령과 218개 option이 열거된다. root subcommand는 아래 13개이며, 여기에 뒤의 hidden root command가 더해진다.

| Root subcommand | 설명 | Adapter 관련성 |
| --- | --- | --- |
| `agents` | 백그라운드 agent 관리 | 없음 |
| `auth` | 인증 관리 (`auth login`, `auth logout`, `auth status`) | OAuth 세션 전제 |
| `auto-mode` | auto mode 분류기 설정 조회·초기화 | 없음 |
| `doctor` | 설치 상태 점검 | 진단용 |
| `gateway` | enterprise auth/telemetry gateway | 없음 |
| `import` | 다른 AI coding agent의 설정을 Claude Code로 가져오기 | 없음 |
| `install` | native build 설치 | 없음 |
| `mcp` | MCP 서버 설정·관리 (`mcp add`, `mcp add-json`, `mcp get`, `mcp list`, `mcp login`, `mcp logout`, `mcp remove`, `mcp serve`) | 서비스 tool bridge 후보 |
| `plugin` | plugin 관리 (`plugin marketplace`, `plugin eval` 등) | 없음 |
| `project` | project 상태 관리 (`project purge`) | 없음 |
| `setup-token` | 장기 인증 토큰 설정 | 없음 |
| `ultrareview` | 클라우드 멀티 에이전트 코드 리뷰 | 없음 |
| `update` | 업데이트 확인·설치 | 없음 |

### CLI flags from local help

root command는 63개 option 항목(장문 flag 66개)을 광고한다. 아래 그룹별 요약의 "Chat runtime use" 열은 help 서술과 의도된 용도이며, 그 자체로는 L1이다. 각 flag가 실제로 무엇을 바꾸는지는 뒤의 wire 기본값 표에서 L5로 표시한 항목만 확인된 것이다.

| Group | Flags | Chat runtime use |
| --- | --- | --- |
| Non-interactive | `-p`, `--print`, `--output-format`, `--input-format`, `--verbose` | 기본 자동화·streaming 경로 |
| Streaming | `--include-partial-messages`, `--include-hook-events`, `--replay-user-messages`, `--forward-subagent-text` | text delta, hook 가시성, 입력 확인, subagent text 전달 |
| Session | `--session-id`, `--resume`, `--continue`, `--fork-session`, `--no-session-persistence`, `--name` | 서비스 세션 수명주기 |
| Model/effort | `--model`, `--fallback-model`, `--effort`, `--max-budget-usd` | 세션 품질·비용 정책 |
| Output contract | `--json-schema` | 구조화 최종 출력. provider가 강제하지는 않는다 — 아래 wire 기본값 표 참조 |
| Prompt/context | `--system-prompt`, `--append-system-prompt`, `--exclude-dynamic-system-prompt-sections`, `--setting-sources`, `--settings`, `--autocompact` | 서비스 고유 동작과 결정적 context |
| Tool control | `--tools`, `--allowedTools`, `--allowed-tools`, `--disallowedTools`, `--disallowed-tools`, `--mcp-config`, `--strict-mcp-config`, `--disable-slash-commands` | 서비스 tool bridge와 skill/slash 격리 |
| Permission | `--permission-mode`, `--dangerously-skip-permissions`, `--allow-dangerously-skip-permissions` | scratch 전용 실행 정책 |
| Workspace | `--add-dir`, `--worktree`, `--tmux` | 파일 접근 제어. hot path 기본값 아님 |
| Integrations | `--chrome`, `--no-chrome`, `--ide`, `--plugin-dir`, `--plugin-url`, `--agents`, `--agent` | 서비스가 명시적으로 켤 때만 |
| Isolation/troubleshooting | `--bare`, `--safe-mode`, `--restricted` | 셋 다 local OAuth 기본값 아님. `--bare`는 keychain 조회를 건너뛰고 인증을 `ANTHROPIC_API_KEY`로 한정하며 wire 효과까지 확인했다(L5). `--safe-mode`(커스터마이즈 해제)와 `--restricted`(코드 실행 계열 tool·`WebFetch` 제거, user/project/local 설정 무시)는 help 서술이며 효과 미확인 |
| Cloud/remote session | `--cloud`, `--environment`, `--teleport`, `--remote-control`, `--remote-control-session-name-prefix` | 끄고 유지. 세션을 로컬 밖(claude.ai/code, self-hosted environment)에서 만들거나 제어면을 넓힌다 |
| Other surface | `--betas`, `--file`, `--from-pr`, `--bg`/`--background`, `--brief`, `--prompt-suggestions`, `--ax-screen-reader`, `--debug`, `--debug-file` | hot path 기본값 아님. `--betas`는 API key 사용자에게만 적용되어 OAuth에서는 무효 |

측정된 값 도메인:

| Flag | Domain | 권위 |
| --- | --- | --- |
| `--output-format` | `text`, `json`, `stream-json` | L1 help choices |
| `--input-format` | `text`, `stream-json` | L1 help choices |
| `--permission-mode` | `acceptEdits`, `auto`, `bypassPermissions`, `manual`, `dontAsk`, `plan` | L1 help choices |
| `--prompt-suggestions` | `true`, `false`, `1`, `0`, `yes`, `no`, `on`, `off` | L1 help choices |
| `--effort` | `low`, `medium`, `high`, `xhigh`, `max` | L4 probe. 알 수 없는 값은 **거부되지 않고 경고 후 기본값으로 무시**되므로 proxy가 상류에서 검증해야 한다 |
| `--setting-sources` | `user`, `project`, `local`, 그리고 빈 값 `''` | L4 probe. 오류 메시지가 안내하는 유효 값은 셋뿐이지만, 빈 값은 거부되지 않고 **어떤 source도 로드하지 않는 상태**로 동작한다. proxy의 사용자 설정 격리 옵션이 이 동작에 의존한다. 플래그 **생략은 `user`와 동일**하게 사용자 설정을 로드하므로 격리 수단이 아니다 |
| `--max-budget-usd` | 0보다 큰 수 | L4 probe |
| `--session-id` | 유효한 UUID | L4 probe |

`--model`은 고정 enum이 아니므로 위 표에 넣지 않는다. help는 최신 모델 alias(`fable`, `opus`, `sonnet`)와 full name(예: `claude-fable-5`)을 받는다고 안내하며, 미지원 값은 세션 시작 단계에서 거부되어 모델 호출에 도달하지 않는다(L4 probe). 즉 Claude 쪽 모델 유효성 판정은 CLI에 위임할 수 있고, Codex 쪽은 위임할 수 없다.

### Adapter-critical flags hidden from `--help`

`hideHelp()`로 등록되어 `claude --help`에 나오지 않지만 proxy의 Anthropic parity 경로(`output_config`/`thinking`)가 의존하는 flag다. 권위는 L4 parse probe이며, 잘못된 값을 주면 CLI가 허용값과 함께 거부한다. 아래 표의 "Adapter use"는 **의도한 대응 관계이지 관찰된 효과가 아니다.** 세 flag 모두 값 도메인까지는 확인했고, 그 값이 wire를 어떻게 바꾸는지는 확인하지 않았다.

| Flag | Accepts | Adapter use (의도) | 효과 |
| --- | --- | --- | --- |
| `--thinking` | `enabled`, `adaptive`, `disabled` | Anthropic `thinking.type` | 미결 |
| `--thinking-display` | `summarized`, `omitted` | Anthropic `thinking.display` | 미결 |
| `--task-budget` | 양의 정수 토큰 | Anthropic `output_config.task_budget.total` | 미결 |

`--thinking`은 특히 먼저 확인할 값이 있다. reasoning을 실제로 끄는 것으로 관찰된 수단은 `MAX_THINKING_TOKENS=0` 하나였고, 그 캡처에서는 flag로 끄는 경로를 시도하지 않았다. 따라서 `--thinking disabled`가 같은 일을 하는지, 수용만 되고 마는지는 아직 갈리지 않았다. parity 경로를 이 flag에 의존시키기 전에 켠·끈 두 실행을 캡처해 비교한다.

Risk: hidden이므로 `--help` diff 없이 rename/삭제될 수 있다. Claude Code 버전을 올릴 때마다 `pnpm catalog:runtime`의 parse probe로 세 flag의 등록을 확인한 뒤 parity 경로를 배포한다.

### Other hidden CLI surface (parse probe 기준)

Hidden subcommands (L4: 각자 자기 usage를 출력하며, 없는 이름은 main help로 떨어진다):

| Command | Purpose | Adapter relevance |
| --- | --- | --- |
| `claude remote-control` | claude.ai/code·모바일 앱에서 로컬 세션 제어 | 끄고 유지; 제어면 확대 |
| `claude daemon` | 백그라운드 세션 supervisor | hot path 없음 |
| `claude attach <id>` | 백그라운드 세션에 터미널 연결 | hot path 없음 |
| `claude logs <id>` | 백그라운드 세션 최근 출력 | 진단 후보 |
| `claude stop <id>` (alias `kill`) | 백그라운드 세션 종료 | hot path 없음 |

주의: `claude remote-control`을 인자 없이 실행하면 즉시 claude.ai로 원격 제어 세션을 연다. 조사 목적이면 반드시 `--help`만 붙인다.

parse probe로 등록이 확인된 그 밖의 hidden flag:

| Flag | Accepts | Adapter relevance |
| --- | --- | --- |
| `--teammate-mode` | `auto`, `tmux`, `iterm2`, `in-process` | 없음; agent-team UX |
| `--max-thinking-tokens` | 수 | 예산값으로는 무력하다: 직접 API가 거부할 값(100, 10^7)도 thinking이 켜진 채 실행된다. 다만 `MAX_THINKING_TOKENS=0`은 예외로 reasoning을 실제로 끈다 — 아래 wire 기본값 표 참조. adapter는 `thinking.budget_tokens`를 parity 검증만 하고 전달하지 않는다 — 계약 문서 `thinking` 행에 기록 |
| `--managed-settings`, `--parent-session-id`, `--plan-mode-instructions`, `--prefill`, `--prefill-b64` | 값 flag | 없음; drift 추적용 |
| `--system-prompt-file`, `--append-system-prompt-file` | 파일 경로 | 없음; adapter는 인라인 `--system-prompt` 사용 |
| `--resume-session-at` | `--resume`와 함께만 유효 | 없음 |
| `--sdk-url` | URL (Remote Control 전용) | 없음 |

binary string scan은 위 목록보다 많은 option 등록 문자열을 뱉지만, 그중 일부는 현재 parser가 `unknown option`으로 거부한다(root와 `ultrareview` 양쪽에서 확인). 문자열이 남아 있다는 이유로 CLI surface에 넣지 않는다. 거부된 항목의 목록은 report의 `Claude Hidden Flag Parse Probe` 표에 있다.

### Official-docs items (parse probe로 확인됨)

| Item | Parse probe | 남은 확인 |
| --- | --- | --- |
| `--max-turns` | 값 flag로 등록 (수를 요구) | `-p`에서 조기 종료 동작 |
| `--permission-prompt-tool` | 값 flag로 등록 | MCP permission prompt 계약과 stream-json 이벤트 |
| `--maintenance` | boolean으로 등록 | 가용성과 시작 지연 영향 |
| `--prompt-suggestions` | 등록 (help가 choices 노출) | 이벤트 shape과 서비스 노출 여부 |

### 환경 격리와 wire 기본값

adapter가 아무것도 지정하지 않았을 때 CLI가 상류로 실제 전송하는 값이다. 관찰 조건은 위 신뢰 레벨 절과 같다(2026-08-28, Claude Code `2.1.251`, 로컬 sink). 기준선이 둘이라는 점에 주의한다. host-default는 설정 파일과 CLAUDE.md가 살아 있는 상태이고 isolated는 `--bare`에 빈 `--setting-sources`를 준 상태인데, 아무 flag도 주지 않은 adapter가 물려받는 쪽은 host-default다.

| Knob | 미설정 기본값 | 효과 | 권위 |
| --- | --- | --- | --- |
| `--system-prompt` / `--append-system-prompt` | 만 자 단위의 coding agent persona system 블록 | `--system-prompt`는 그 블록을 대체하고 `--append-system-prompt`는 뒤에 잇는다. **0까지는 내려가지 않는다** — 과금 헤더와 preamble 한 문장이 남고, 첫 user 메시지에 붙는 날짜 reminder도 남는다 | L5 |
| `--tools ""` | host-default에서는 내장 tool + host MCP tool 다수, `--bare`에서는 `Bash`·`Edit`·`Read` 3개 | `""`를 주면 `tools`가 빈 배열이 된다. 호출할 tool이 없으면 agentic loop가 한 턴으로 접히므로 사실상 completion 모드 스위치다 | L5 |
| `--setting-sources ""` | **사용자 설정이 로드된다.** host의 effort 설정이 `output_config.effort`로 실려 나간다 | 빈 값이면 어떤 source도 읽지 않는다. 같은 프롬프트에서 host 설정값과 격리 기본값이 서로 다르게 캡처되어 확인했다. 격리하면 `--output-format stream-json`이 `--verbose`를 추가로 요구하는 결합이 드러난다 | L5 양방향 |
| `--effort` | isolated 기준 `high`, 그 외에는 host 설정값 | `output_config.effort`로 실린다. `off`나 `none`에 해당하는 수준은 없다 | L5 |
| `MAX_THINKING_TOKENS` | `thinking`이 `adaptive`로 — **reasoning ON** | `=0`이면 `thinking`이 `disabled`로 바뀐다. 확인된 유일한 reasoning off 스위치이며 대응하는 flag는 없다 | L5 |
| `CLAUDE_CODE_MAX_OUTPUT_TOKENS` | `max_tokens: 64000` | 지정한 값이 그대로 `max_tokens`로 실린다. 대응하는 flag가 없어 이 변수만이 수단이다 | L5 양방향 |
| `--bare` | 전체 harness(CLAUDE.md, hook, plugin, auto-memory, keychain) 로드 | system 블록·첫 user 메시지·tool 수가 모두 크게 줄어든다. `CLAUDE_CODE_SIMPLE=1`을 설정한다 | L5 |
| `--strict-mcp-config` | host MCP 서버가 로드된다 | `--mcp-config`로 준 서버만 남긴다 | L5 |
| `--json-schema` | 없음 | schema를 그대로 담은 `StructuredOutput` tool 하나를 전송한다. **`tool_choice`가 실리지 않으므로 provider 강제가 아니다** — codex의 `strict: true`와 달리 conformance는 proxy가 검증해야 한다 | L5 |
| `context_management` | thinking 정리 edit이 매 요청 전송된다 | 전송 자체는 확인했다. 호출자가 요청한 적 없는 context edit이다 | 전송은 L5. **억제 수단은 미결** — 없다고 단정하지 않는다 |

`--input-format stream-json`은 NDJSON 입력에서 `assistant` 줄을 실제 assistant 턴으로 wire에 올린다. 다만 의미는 history 적재가 아니라 streaming이다. `user` 줄 하나마다 턴이 하나 발생하고, 연달아 오는 user 메시지는 하나로 합쳐지며, assistant 줄은 첫 user 줄 앞으로 당겨진다. 따라서 N턴을 그대로 흘려보내면 원하는 결과가 나오지 않는다. **이전 assistant 턴을 먼저 모두 보내고 마지막에 user 메시지 하나만 두는 형태**가 턴 하나와 올바른 순서를 보장한다. 이 입력 형식은 `--output-format stream-json`을 함께 요구한다.

### MCP and service tools

Claude Code는 MCP 설정과 `allowedTools`로 서비스 tool 연결을 지원한다.

| Capability | Source | Design implication |
| --- | --- | --- |
| Stdio MCP servers | L1/L5 | 로컬 서비스 tool bridge에 적합. stdio MCP 서버가 선언한 tool의 이름·설명·JSON Schema가 그대로 wire에 실리는 것을 확인했다. 다만 tool을 **실행하는 쪽은 CLI**이므로, 구조화된 호출을 받으려면 proxy가 MCP 서버 자체가 되어야 한다 |
| HTTP/SSE/streamable HTTP MCP | L3 | 원격 서비스 API에 유용하나 명시적 자격증명 정책 필요. 이 경로는 확인하지 않았다 |
| `allowedTools` wildcard | L1/L3 | 광범위한 bypass permission보다 우선 |
| `--strict-mcp-config` | L1/L5 | project/user MCP 서버가 서비스 chat에 새는 것을 차단한다. 대조 실행에서는 host MCP 서버가 본문에 있었고 이 flag를 켜면 사라졌다 |
| `--tools ""` | L1/L5 | 서비스가 custom tool만 원할 때 내장 tool 비활성화. wire에서 `tools`가 빈 배열이 되는 것을 확인했다 |

### Claude design implications

- 첨부와 per-turn flag가 one-shot을 강제하지 않는 한, native chat은 지속 프로세스 `claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages`를 쓴다.
- local OAuth에서 `--bare`를 기본값으로 쓰지 않는다. keychain 인증 조회를 건너뛰고 인증을 `ANTHROPIC_API_KEY`로 한정한다.
- 사용자 설정 격리는 `--setting-sources`에 빈 값을 주는 것으로 한다. 생략은 `user`와 같아 host의 effort·hook·env가 매 턴 요청에 실린다.
- 서비스 제공 tool에는 `--mcp-config` + `--strict-mcp-config` + 명시적 `--allowedTools`를 쓴다.
- `--json-schema`는 구조화 최종 출력에만 쓰고, 기본 chat UI는 text stream + tool/action 이벤트를 우선한다. 이 flag는 schema를 tool로 제시할 뿐 강제하지 않으므로, 반환 JSON의 schema 적합성 검증은 proxy가 코드로 처리한다.
- 출력 토큰 상한이 필요하면 `CLAUDE_CODE_MAX_OUTPUT_TOKENS`를 쓴다. 대응 flag가 없고, 지정하지 않으면 호출자의 값과 무관하게 CLI 기본값이 실린다.
- per-request tuning(`--effort`, `--thinking`, `--task-budget`)은 proxy에서 먼저 검증한다. `--effort`는 잘못된 값을 조용히 무시하고 hidden flag는 help에 없으므로, 상류 검증만이 결정적으로 잡아내는 지점이다.
- hidden parity flag는 버전 고정 계약으로 취급한다. Claude Code 버전을 올릴 때마다 `pnpm catalog:runtime`의 parse probe를 재실행한다.
- native chat에서는 `ANTHROPIC_API_KEY` 등 직접 provider 변수를 자식 env에서 제거한다.

## Service chat runtime output list

The runtime should expose a service-neutral stream projection over raw CLI events.

| Projection event | Meaning | Raw authority |
| --- | --- | --- |
| `text.delta` | User-visible assistant text chunk | Codex `item/agentMessage/delta`; Claude partial message |
| `tool.call.started` | Service or CLI tool started | Raw tool start/progress event |
| `tool.call.delta` | Tool arguments or progress delta | Raw dynamic/MCP/tool event |
| `tool.result` | Tool completed or returned data | Raw tool result event |
| `state.patch.pending` | Service state change proposed | Service tool/outbox event |
| `state.patch.validated` | Service accepted patch | Service validator result |
| `state.patch.rejected` | Service rejected patch | Service validator result |
| `usage.updated` | Provider or CLI usage changed | Codex `thread/tokenUsage/updated`; Claude result usage |
| `turn.completed` | Turn is complete | Raw turn/result event |
| `error` | Runtime or service error | Raw error plus normalized error |

Rule: projections are convenience views. The raw event is always retained for audit and replay.

## 미결 효과 주장

수용(L4)까지는 확인했지만 효과(L5)를 관찰하지 못한 항목이다. 규칙 5-4에 따라 효과 주장을 그대로 두는 대신 여기에 모아 둔다. 아래 항목을 근거로 hot path 동작을 설계하지 않는다. 해결 절차는 playbook 규칙 5-3의 sink 대조 실행이다.

| 항목 | 지금까지 확인된 것 | 남은 질문 |
| --- | --- | --- |
| Codex `exec --ephemeral`, `exec --ignore-rules` | 등록·수용 | 세션 파일과 execpolicy가 실제로 달라지는지 |
| Claude `--thinking`, `--thinking-display`, `--task-budget` | 등록·수용 + 값 도메인 | 값이 요청 본문을 바꾸는지. 특히 `--thinking disabled`가 `MAX_THINKING_TOKENS=0`과 같은 일을 하는지 |
| Claude `--safe-mode`, `--restricted`, `--disable-slash-commands`, `--exclude-dynamic-system-prompt-sections` | 등록·수용 + help 서술 | 서술대로 context와 tool이 줄어드는지 |
| Claude `context_management` 억제 | 매 요청 전송되는 것은 관찰 | 끄는 수단이 있는지. 찾지 못했을 뿐 없다고 확인한 것이 아니다 |
| Claude `--effort` 미지원 값 | CLI가 경고 후 계속 진행하는 것은 관찰 | 그때 wire에 실리는 effort 값이 무엇인지 |
| Codex `thread/inject_items` | schema 선언(L2) | inject 후 `turn/start`에서 role이 붙은 항목이 본문에 나타나는지 |
| Codex `personality` | schema enum(L2) | 별도 wire 필드로 나타나지 않는다. 값이 무엇을 바꾸는지 |
| Codex `app-server --code-mode-host` | help 서술(L1) | 원격 host 접속 동작 |

## Probe checklist

| Probe | Done when |
| --- | --- |
| `runtime_capability_smoke` | `pnpm smoke:runtime-capabilities` classifies every collected capability by risk and validates input/output schema presence |
| `runtime_capability_live_smoke` | `pnpm smoke:runtime-capabilities -- --include-live-model --fail-on-live-failure` passes the safe live model probes. 비용을 사전에 제한하는 장치는 없다 — report의 `Live model probes run`이 실제 실행 수를 사후 보고할 뿐이다 |
| `codex_app_server_schema_probe` | `generate-json-schema --experimental` succeeds and required methods are present |
| `codex_native_text_turn_probe` | `thread/start`, `turn/start`, first `item/agentMessage/delta`, `turn/completed`, `thread/tokenUsage/updated` observed |
| `codex_dynamic_tool_probe` | `item/tool/call` request is received and client response reaches the model |
| `codex_scratch_fs_probe` | CLI can read/write scratch files and cannot access disallowed repo paths |
| `claude_stream_json_probe` | Persistent stream-json input emits partial messages and final result |
| `claude_mcp_tool_probe` | Service MCP tool is visible only when allowed and returns result |
| `claude_strict_json_probe` | `--json-schema` validates final output for strict mode |
| `direct_key_isolation_probe` | Child env has no direct OpenAI/Anthropic API keys in native chat mode |
| `binary_docs_diff_probe` | Official-doc-only flags are checked against installed binary and marked supported/unsupported |
| `codex_model_flag_gate_probe` | Each `supported_in_api`/`visibility` combination from `codex debug models` is run as a real turn through the proxy, establishing whether either flag gates execution on the local OAuth path |

## 다음 구현 항목

1. Add L4 runtime probes for native Codex app-server text turns, Codex dynamic tools, Claude stream-json, Claude MCP tools, strict JSON, scratch filesystem isolation, and direct key isolation. 효과를 주장하는 항목은 L4로 끝내지 않고 playbook 규칙 5-3의 대조 캡처까지 간다.
2. 「미결 효과 주장」 표의 항목을 sink 대조 실행으로 하나씩 해소한다. 수집기는 이 종류의 주장을 검증하지 못하므로 자동으로 드러나지 않는다.
3. Gate native chat startup on required L4 probes for the selected runtime/profile.
4. Store probe output under benchmark artifacts and keep package docs focused on current behavior.
5. Keep this document as the human-readable current-state map and update it when validity reports reveal drift.
