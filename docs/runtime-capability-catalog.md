# Runtime capability catalog

## 목적

local OAuth CLI를 특정 서비스의 LLM chat UI runtime으로 붙일 때, Codex CLI와 Claude Code CLI가 실제로 지원하는 non-interactive 명령, flag, stream protocol, tool 연결 방식을 버전별로 확인하기 위한 기준 목록이다.

이 문서는 help 출력만을 권위로 보지 않는다. help, protocol schema, 공식 문서, binary scan, 실제 probe 결과를 분리해서 기록한다. production hot path에는 실제 probe를 통과한 capability만 사용한다.

현재 로컬 기준:

| Runtime | Local version | Binary | Primary hot path |
| --- | --- | --- | --- |
| Codex CLI | `codex-cli 0.142.5` | `/opt/homebrew/bin/codex` | `codex app-server --listen stdio://` |
| Claude Code | `2.1.201` | `/Users/kangmin/.local/bin/claude` | `claude -p --input-format stream-json --output-format stream-json` |

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

Hidden-surface probe (codex is clap-based; `hide = true` items never appear in `--help`):

```bash
# Enumerate candidates from the pinned tag's source, then confirm each against the installed binary.
curl -sL "https://raw.githubusercontent.com/openai/codex/rust-v$(codex --version | awk '{print $2}')/codex-rs/cli/src/main.rs" | grep -n -B 2 "hide = true"
codex <hidden-cmd> --help   # hidden clap items still answer --help with exit 0
codex --no-such-flag-xyz    # negative control: must exit 2, or the probe proves nothing
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

Hidden-surface probe (claude is a bun-compiled commander CLI; `hideHelp()` flags and hidden commands never appear in `--help`, and unknown top-level options are silently tolerated, so silence proves nothing):

```bash
# L0: extract commander option-registration strings (`--flag <value>`) from the binary.
strings -n 6 "$(readlink -f ~/.local/bin/claude)" | grep -oE -- '--[a-z0-9-]+ (<[^>]{1,40}>|\[[^]]{1,40}\])' | sort -u
# L4 (value-validated flags only): an invalid value is rejected naming the flag and its choices.
claude --thinking=__bogus__ --version   # error lists enabled/adaptive/disabled → flag exists
# Hidden subcommand probe: a real command prints its own usage; an unknown name falls back to main help.
claude <name> --help | head -1          # "Usage: claude <name>" vs "Usage: claude [options] [command]"
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

### Hidden CLI surface (absent from `--help`)

codex hides part of its CLI with clap `hide = true`, so `--help` scraping cannot see it. The items below were enumerated from the pinned tag's source (`codex-rs/cli/src/main.rs`, `exec/src/cli.rs`, `app-server/src/main.rs`, `arg0/src/lib.rs`) and each was confirmed live on the installed `0.142.5` binary: hidden clap items still answer `--help` with exit 0, while a bogus flag exits 2 (negative control). Source level: L0 source/binary scan plus L4 `--help`/parse probe.

Hidden subcommands:

| Command | Purpose | Adapter relevance |
| --- | --- | --- |
| `codex execpolicy check` | Check execpolicy `.rules` files against a command | None on hot path |
| `codex responses-api-proxy` | Internal Responses API proxy | None; internal |
| `codex stdio-to-uds` | Relay stdio to a Unix domain socket | None; internal |
| `codex debug trace-reduce` | Replay a rollout trace bundle to reduced state JSON | Diagnostic candidate only |
| `codex debug clear-memories` | Reset local memory state | Not needed; adapter uses isolated `CODEX_HOME` |
| `codex app-server generate-internal-json-schema` | Internal schema artifacts | None; `generate-json-schema` is the public one |
| `codex app-server daemon pid-update-loop` | Detached updater loop | None; internal |

Hidden flags:

| Flag | Behavior | Adapter relevance |
| --- | --- | --- |
| `codex app-server --remote-control` | Enable remote control for this process without persisting | Keep off; widens control surface |
| `codex login --experimental_issuer <URL>` / `--experimental_client-id <ID>` | OAuth issuer/client override | None unless custom OAuth endpoint is required |
| `codex login --api-key` | Trap: exits with guidance to pipe via `--with-api-key` | Do not use |
| `codex exec --full-auto` | Trap for the removed legacy flag | Do not use |

arg0/argv dispatch (the binary becomes a different tool based on its invocation name; invisible to any help output):

| Invocation | Dispatches to |
| --- | --- |
| argv0 `apply_patch` or `applypatch` | Standalone apply_patch CLI |
| argv0 `codex-linux-sandbox` | Linux sandbox helper |
| argv0 `codex-execve-wrapper` | Shell-escalation execve wrapper |
| argv1 `--codex-run-as-apply-patch <PATCH>` | Apply one patch and exit |
| argv1 `--codex-run-as-fs-helper` | exec-server filesystem helper |

Risk: hidden items can be renamed or dropped with no visible `--help` diff. On every Codex version bump, re-run the source `hide = true` grep against the new tag and re-probe before trusting any hidden item. None of the hidden surface is on the adapter hot path today.

### App-server request methods

The following methods were discovered from generated schema on local Codex `0.142.5`. They must still be covered by runtime probes before production use. The full generated method surface for the current version (including newer `thread/goal/*`, `thread/rollback`, `thread/backgroundTerminals/*`, `review/start`, `skills/*`, `hooks/*`, `plugin/*`, and `remoteControl/*` groups that are outside the chat hot path) is in `artifacts/runtime-capability-catalog/latest.json`.

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
| Model/effort | `--model`, `--fallback-model`, `--effort`, `--max-budget-usd` | Per-session quality/cost policy. `--effort` accepts `low/medium/high/xhigh/max`; an unknown value is warned and ignored (default effort is used), not rejected, so the proxy validates effort upstream |
| Output contract | `--json-schema` | Strict structured final output fallback |
| Prompt/context | `--system-prompt`, `--append-system-prompt`, `--exclude-dynamic-system-prompt-sections`, `--setting-sources`, `--settings` | Service-specific behavior and deterministic context |
| Tool control | `--tools`, `--allowedTools`, `--allowed-tools`, `--disallowedTools`, `--disallowed-tools`, `--mcp-config`, `--strict-mcp-config`, `--disable-slash-commands` | Service tool bridge and skill/slash-command isolation |
| Permission | `--permission-mode` (`acceptEdits`, `auto`, `bypassPermissions`, `manual`, `dontAsk`, `plan`), `--dangerously-skip-permissions`, `--allow-dangerously-skip-permissions` | Scratch-only execution policy |
| Workspace | `--add-dir`, `--worktree`, `--tmux` | Filesystem access control. `--worktree`/`--tmux` are not hot-path chat defaults |
| Integrations | `--chrome`, `--no-chrome`, `--ide`, `--plugin-dir`, `--plugin-url`, `--agents`, `--agent` | Usually disabled unless service opts in |
| Isolation/troubleshooting | `--bare`, `--safe-mode` | Neither is a local OAuth default: `--bare` does not read OAuth/keychain auth, `--safe-mode` disables all customizations |
| Other surface | `--betas`, `--file`, `--from-pr`, `--bg`/`--background`, `--brief`, `--prompt-suggestions`, `--remote-control`, `--remote-control-session-name-prefix`, `--ax-screen-reader`, `--debug-file` | Not hot-path chat defaults. `--betas` applies to API-key users only, so it is inert under OAuth; `--prompt-suggestions` accepts `true/false/1/0/yes/no/on/off` |

### Adapter-critical flags hidden from `--help`

These flags are registered in the installed binary but marked `hideHelp()`, so they do not appear in `claude --help`. The proxy's Anthropic parity path (`output_config`/`thinking`) depends on them, so they are tracked here even though help-scraping cannot see them. Source level is L0 binary scan plus an L4 parse probe: passing an invalid value makes the CLI reject it with the allowed choices, which confirms both that the option exists and what it accepts.

| Flag | Accepts | Adapter use |
| --- | --- | --- |
| `--thinking` | `enabled`, `adaptive`, `disabled` | Anthropic `thinking.type` on the claude runtime |
| `--thinking-display` | `summarized`, `omitted` | Anthropic `thinking.display` visibility |
| `--task-budget` | positive integer tokens | Anthropic `output_config.task_budget.total` |

Risk: because these are hidden, a future CLI could rename or drop them with no visible `--help` diff. When bumping the pinned Claude Code version, re-run `pnpm catalog:runtime` (binary scan) plus the invalid-value parse probe before trusting the parity path. `--max-thinking-tokens` still exists but is deprecated in favor of `--thinking`; the adapter does not use it.

### Other hidden CLI surface (binary scan + probe)

Enumerated on `2.1.201` with the hidden-surface probes from the investigation-commands section. The hidden command set and main `--help` are byte-identical between `2.1.200` and `2.1.201`.

Hidden subcommands (L4: each prints its own usage):

| Command | Purpose | Adapter relevance |
| --- | --- | --- |
| `claude remote-control` | Control local sessions from claude.ai/code or the mobile app | Keep off; widens control surface |
| `claude daemon [run\|status\|logs\|uninstall\|stop]` | Background session supervisor | None on hot path |
| `claude attach <id>` | Attach terminal to a background session | None on hot path |
| `claude logs <id>` | Print a background session's recent output | Diagnostic candidate only |
| `claude stop <id>` (alias `kill`) | Stop a background session | None on hot path |

Hidden flags confirmed by invalid-value probe (L4), beyond the adapter-critical set above:

| Flag | Accepts | Adapter relevance |
| --- | --- | --- |
| `--teammate-mode` | `auto`, `tmux`, `iterm2`, `in-process` | None; agent-team UX |

L0-only candidates: the option-spec extraction yields ~85 more registered value flags absent from every collected help, including `--system-prompt-file`, `--append-system-prompt-file`, `--plan-mode-instructions`, `--max-cost-usd`, `--prefill`/`--prefill-b64`, `--parent-session-id`, `--resume-session-at`, `--sdk-url`, `--managed-settings`, and an internal eval/storybook harness family (`--storybook-config`, `--storybook-static`, `--judge-model`, `--runs`, ...). These cannot be positively confirmed at top level because the CLI silently tolerates unknown and boolean-mismatched options, and some belong to subcommands; treat them as L0 candidates and add an L4 behavior probe before any adapter use.

### Official-docs items that need behavior probe

As of `claude 2.1.201` these are all registered in the installed binary (`hideHelp()`, so absent from `--help` output); the remaining work is behavior verification, not presence.

| Item | Source | Required probe |
| --- | --- | --- |
| `--max-turns` | Official CLI reference | Registered and accepted; verify early-exit behavior with `-p` |
| `--permission-prompt-tool` | Official CLI reference | Registered and accepted; verify MCP permission prompt contract and stream-json events |
| `--maintenance` | Official CLI reference | Registered; verify availability and whether it affects startup latency |

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
- Validate per-request tuning (`--effort`, `--thinking`, `--task-budget`) in the proxy before forwarding: `--effort` silently falls back on an unknown value, and the thinking/task-budget flags are hidden, so upstream validation is the only place a bad value is caught deterministically.
- Treat the hidden parity flags as a version-pinned contract: on every Claude Code version bump, re-run `pnpm catalog:runtime` and the invalid-value parse probe to confirm `--thinking`/`--thinking-display`/`--task-budget` still exist before shipping.
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
