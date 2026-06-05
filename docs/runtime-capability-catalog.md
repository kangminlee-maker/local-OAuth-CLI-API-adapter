# Runtime capability catalog

## 목적

local OAuth CLI를 특정 서비스의 LLM chat UI runtime으로 붙일 때, Codex CLI와 Claude Code CLI가 실제로 지원하는 non-interactive 명령, flag, stream protocol, tool 연결 방식을 버전별로 확인하기 위한 기준 목록이다.

이 문서는 help 출력만을 권위로 보지 않는다. help, protocol schema, 공식 문서, binary scan, 실제 probe 결과를 분리해서 기록한다. production hot path에는 실제 probe를 통과한 capability만 사용한다.

현재 로컬 기준:

| Runtime | Local version | Binary | Primary hot path |
| --- | --- | --- | --- |
| Codex CLI | `codex-cli 0.137.0` | `/opt/homebrew/bin/codex` | `codex app-server --listen stdio://` |
| Claude Code | `2.1.163` | `/Users/kangmin/.local/bin/claude` | `claude -p --input-format stream-json --output-format stream-json` |

## 신뢰 레벨

| Level | Source | 의미 |
| --- | --- | --- |
| L0 | Binary string scan | 후보만 발견. 노이즈가 많아 단독 사용 금지 |
| L1 | `--help` output | 현재 설치 binary가 노출한 public CLI surface |
| L2 | Generated protocol schema | Codex app-server처럼 schema 생성이 가능한 경우의 구조적 권위 |
| L3 | Official docs | 최신/권장 사용법 확인. 로컬 버전과 다를 수 있음 |
| L4 | Runtime probe | 실제 dry run 또는 fake runtime/E2E로 성공 확인 |

운영 규칙: catalog에는 L0-L3도 기록할 수 있지만, 기본 runtime path는 L4를 통과한 항목만 사용한다.

## 갱신 방식

이 문서는 current-state catalog다. 삭제된 항목, rename 이력, backward-compatibility 설명, 과거 버전 차이는 이 문서에 남기지 않는다. 해당 내용은 update report artifact에만 남긴다.

정기 점검은 아래 명령으로 실행한다.

```bash
pnpm catalog:runtime
```

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

### Claude Code

```bash
claude --help
claude mcp --help
claude agents --help
claude project --help
claude auth --help
claude doctor --help
```

Useful official references:

- Claude Code CLI reference: https://code.claude.com/docs/en/cli-usage
- Claude Code MCP/Agent SDK docs: https://code.claude.com/docs/en/agent-sdk/mcp
- OpenAI Codex model capability reference: https://developers.openai.com/api/docs/models/gpt-5.2-codex

## Codex capability list

### CLI commands

| Command | Source | Chat runtime use |
| --- | --- | --- |
| `codex exec --json` | L1 | One-shot fallback, smoke tests, simple automation |
| `codex exec resume <session>` | L1 | One-shot continuation fallback when app-server is unavailable |
| `codex exec --output-schema <file>` | L1 | Strict final output fallback. Not preferred for chat UI hot path |
| `codex exec --ephemeral` | L1 | Isolated one-shot runs without persisted session files |
| `codex exec --ignore-user-config` | L1 | Deterministic context control for one-shot fallback |
| `codex exec --ignore-rules` | L1 | Avoid user/project execpolicy drift when service requires strict isolation |
| `codex app-server --listen stdio://` | L1 | Primary native session runtime |
| `codex app-server generate-json-schema --experimental` | L1/L2 | Protocol discovery and version diff |
| `codex app-server generate-ts` | L1 | Type-level protocol discovery |
| `codex debug prompt-input` | L1 | Inspect model-visible prompt/context for deterministic tuning |
| `codex debug models` | L1 | Model catalog discovery |
| `codex features list` | L1 | Feature flag discovery |

### App-server request methods

The following methods were discovered from generated schema on local Codex `0.137.0`. They must still be covered by runtime probes before production use.

| Group | Methods |
| --- | --- |
| Session/thread | `thread/start`, `thread/resume`, `thread/fork`, `thread/archive`, `thread/unarchive`, `thread/unsubscribe`, `thread/read`, `thread/list`, `thread/search`, `thread/loaded/list` |
| Turn control | `turn/start`, `turn/interrupt`, `turn/steer`, `thread/turns/list`, `thread/turns/items/list` |
| Context and settings | `thread/settings/update`, `thread/metadata/update`, `thread/name/set`, `thread/memoryMode/set`, `thread/compact/start`, `thread/inject_items` |
| Filesystem | `fs/readFile`, `fs/writeFile`, `fs/readDirectory`, `fs/createDirectory`, `fs/copy`, `fs/remove`, `fs/getMetadata`, `fs/watch`, `fs/unwatch` |
| Process/terminal | `process/spawn`, `process/writeStdin`, `process/resizePty`, `process/kill`, `command/exec`, `command/exec/write`, `command/exec/resize`, `command/exec/terminate` |
| Tools/MCP | `mcpServer/tool/call`, `mcpServer/resource/read`, `mcpServer/oauth/login`, `mcpServerStatus/list` |
| Dynamic tools | `item/tool/call` server request, `item/tool/requestUserInput` server request |
| Permissions | `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `item/permissions/requestApproval`, `applyPatchApproval`, `execCommandApproval` |
| Models/features | `model/list`, `modelProvider/capabilities/read`, `experimentalFeature/list`, `experimentalFeature/enablement/set` |
| Realtime | `thread/realtime/start`, `thread/realtime/appendText`, `thread/realtime/appendAudio`, `thread/realtime/stop`, `thread/realtime/listVoices` |

### App-server notification methods

| Group | Methods |
| --- | --- |
| Text stream | `item/agentMessage/delta`, `item/completed`, `turn/started`, `turn/completed` |
| Reasoning/plan | `item/reasoning/textDelta`, `item/reasoning/summaryTextDelta`, `item/reasoning/summaryPartAdded`, `item/plan/delta`, `turn/plan/updated` |
| Tool/process stream | `item/started`, `item/mcpToolCall/progress`, `item/commandExecution/outputDelta`, `item/commandExecution/terminalInteraction`, `command/exec/outputDelta`, `process/outputDelta`, `process/exited` |
| File changes | `item/fileChange/outputDelta`, `item/fileChange/patchUpdated`, `turn/diff/updated`, `fs/changed` |
| Usage | `thread/tokenUsage/updated` |
| Thread lifecycle | `thread/started`, `thread/status/changed`, `thread/closed`, `thread/archived`, `thread/unarchived`, `thread/compacted`, `thread/name/updated` |
| Realtime | `thread/realtime/started`, `thread/realtime/transcript/delta`, `thread/realtime/transcript/done`, `thread/realtime/outputAudio/delta`, `thread/realtime/closed`, `thread/realtime/error` |
| Runtime/system | `error`, `warning`, `guardianWarning`, `model/rerouted`, `model/verification`, `mcpServer/startupStatus/updated`, `serverRequest/resolved` |

### Codex design implications

- Use app-server for native chat sessions, not `exec --json`, when the service needs low-latency streaming, interrupt, tool events, or multi-turn continuity.
- Use `generate-json-schema --experimental` during package build or explicit probe to detect protocol drift.
- Prefer scratch workspace roots and explicit `runtimeWorkspaceRoots` for service chat UI sessions.
- Keep direct provider credentials out of child env.
- Treat realtime and filesystem/process methods as available candidates only after explicit service permission policy and probes.

## Claude Code capability list

### CLI flags from local help

| Group | Flags | Chat runtime use |
| --- | --- | --- |
| Non-interactive | `-p`, `--print`, `--output-format text/json/stream-json`, `--input-format text/stream-json`, `--verbose` | Primary automation and streaming path |
| Streaming | `--include-partial-messages`, `--include-hook-events`, `--replay-user-messages` | Text deltas, hook visibility, input acknowledgment |
| Session | `--session-id`, `--resume`, `--continue`, `--fork-session`, `--no-session-persistence`, `--name` | Service session lifecycle |
| Model/effort | `--model`, `--fallback-model`, `--effort`, `--max-budget-usd` | Per-session quality/cost policy |
| Output contract | `--json-schema` | Strict structured final output fallback |
| Prompt/context | `--system-prompt`, `--append-system-prompt`, `--exclude-dynamic-system-prompt-sections`, `--setting-sources`, `--settings` | Service-specific behavior and deterministic context |
| Tool control | `--tools`, `--allowedTools`, `--allowed-tools`, `--disallowedTools`, `--disallowed-tools`, `--mcp-config`, `--strict-mcp-config` | Service tool bridge |
| Permission | `--permission-mode`, `--dangerously-skip-permissions`, `--allow-dangerously-skip-permissions` | Scratch-only execution policy |
| Workspace | `--add-dir`, `--worktree`, `--tmux` | Filesystem access control. `--worktree`/`--tmux` are not hot-path chat defaults |
| Integrations | `--chrome`, `--no-chrome`, `--ide`, `--plugin-dir`, `--plugin-url`, `--agents`, `--agent` | Usually disabled unless service opts in |
| Minimal mode | `--bare` | Not a default for local OAuth sessions because it does not read OAuth/keychain auth |

### Official-docs items that need local probe

These appear in official docs but were not present in the observed local `claude 2.1.163 --help` output, or need behavior verification.

| Item | Source | Required probe |
| --- | --- | --- |
| `--max-turns` | Official CLI reference | Verify accepted by installed binary and behavior with `-p` |
| `--permission-prompt-tool` | Official CLI reference | Verify MCP permission prompt contract and stream-json events |
| `--maintenance` | Official CLI reference | Verify availability and whether it affects startup latency |
| `--prompt-suggestions` | Official CLI reference and local help | Verify stream-json event shape and whether service UI wants it |

### MCP and service tools

Claude Code supports service tool connection through MCP configuration and `allowedTools`.

| Capability | Source | Design implication |
| --- | --- | --- |
| Stdio MCP servers | L1/L3 | Good fit for local service tool bridge |
| HTTP/SSE/streamable HTTP MCP | L3 | Useful for remote service APIs, but requires explicit credential policy |
| `allowedTools` wildcard | L1/L3 | Prefer this over broad bypass permissions |
| `--strict-mcp-config` | L1 | Prevent project/user MCP servers from leaking into service chat |
| `--tools ""` | L1 | Disable built-in tools when service only wants custom tools |

### Claude design implications

- Use persistent `claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages` for native chat when attachments and per-turn-only flags do not force one-shot mode.
- Do not use `--bare` by default for local OAuth because it bypasses OAuth/keychain auth lookup.
- Use `--mcp-config` plus `--strict-mcp-config` and explicit `--allowedTools` for service-provided tools.
- Use `--json-schema` only for strict final output cases; default chat UI should prefer text stream plus tool/action events.
- Keep `ANTHROPIC_API_KEY` and related direct provider variables out of the child process env unless the selected mode is explicitly direct API, which native local chat should not support.

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

## Probe checklist

| Probe | Done when |
| --- | --- |
| `runtime_capability_smoke` | `pnpm smoke:runtime-capabilities` classifies every collected capability by risk and validates input/output schema presence |
| `runtime_capability_live_smoke` | `pnpm smoke:runtime-capabilities -- --include-live-model` passes safe live model probes without crossing the 1m token warning threshold |
| `codex_app_server_schema_probe` | `generate-json-schema --experimental` succeeds and required methods are present |
| `codex_native_text_turn_probe` | `thread/start`, `turn/start`, first `item/agentMessage/delta`, `turn/completed`, `thread/tokenUsage/updated` observed |
| `codex_dynamic_tool_probe` | `item/tool/call` request is received and client response reaches the model |
| `codex_scratch_fs_probe` | CLI can read/write scratch files and cannot access disallowed repo paths |
| `claude_stream_json_probe` | Persistent stream-json input emits partial messages and final result |
| `claude_mcp_tool_probe` | Service MCP tool is visible only when allowed and returns result |
| `claude_strict_json_probe` | `--json-schema` validates final output for strict mode |
| `direct_key_isolation_probe` | Child env has no direct OpenAI/Anthropic API keys in native chat mode |
| `binary_docs_diff_probe` | Official-doc-only flags are checked against installed binary and marked supported/unsupported |

## 다음 구현 항목

1. Add L4 runtime probes for native Codex app-server text turns, Codex dynamic tools, Claude stream-json, Claude MCP tools, strict JSON, scratch filesystem isolation, and direct key isolation.
2. Gate native chat startup on required L4 probes for the selected runtime/profile.
3. Store probe output under benchmark artifacts and keep package docs focused on current behavior.
4. Keep this document as the human-readable current-state map and update it when validity reports reveal drift.
