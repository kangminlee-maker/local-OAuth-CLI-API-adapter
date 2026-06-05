# Local CLI chat API design

## 목표

local OAuth CLI를 이용해 실제 chat 환경을 구현하는 API를 추가한다. 이 API의 목표는 OpenAI/Anthropic provider-compatible proxy가 아니다. 이미 로그인된 Codex CLI 또는 Claude Code CLI의 native session을 가능한 한 그대로 붙여, consumer가 빠르고 예측 가능한 chat UI를 만들 수 있게 하는 것이다.

핵심 원칙:

- provider API shape로 불필요하게 변환하지 않는다.
- local CLI의 session/thread/turn/event 개념을 최대한 보존한다.
- user prompt, attachment, tool/event stream을 얇게 전달한다.
- runtime boundary는 유지한다. local chat API도 direct provider API를 호출하지 않는다.
- 기존 `/v1/chat/completions`, `/v1/responses`, `/v1/messages`는 provider-compatible API가 필요한 자동화용으로 유지한다.

## 기존 handoff와의 차이

`docs/direct-api-transport-handoff.md`는 consumer-owned direct provider API path를 package로 옮기는 설계이다. 그 문서는 M01-M09 같은 stateless API-style pipeline에는 유효하지만, M00 planning/editor chat session에는 맞지 않는다.

| 축 | direct API transport handoff | local CLI chat API |
| --- | --- | --- |
| 목적 | provider API connection 선택 | local CLI chat session 구현 |
| 상태 | 요청 단위 stateless | session/thread 단위 stateful |
| 출력 | provider JSON response | native CLI event stream |
| 변환 | OpenAI/Anthropic request helper | 최소 envelope + raw event pass-through |
| direct provider API | direct mode에서 허용 | 항상 금지 |
| 주 사용처 | batch pipeline, API-like generation | planning/editor chat UI |

결론: direct API transport와 local CLI chat API는 합치지 않는다. 합치면 mode matrix가 커지고, chat hot path에 불필요한 base URL/key/provider 변환이 들어간다.

## 설계 후보

| 옵션 | 설명 | 장점 | 비용/위험 | 판단 |
| --- | --- | --- | --- | --- |
| A. 기존 OpenAI/Anthropic-compatible API에 session id 추가 | `/v1/chat/completions` 등에 session persistence를 붙인다 | 기존 client 재사용 쉬움 | provider shape 변환이 계속 필요하고 native event/interrupt/attachments 표현이 애매함 | 비추천 |
| B. direct API transport handoff에 chat mode 추가 | `withProviderApiTransport()`가 local chat도 다룬다 | 표면 하나로 보임 | direct key/baseUrl 개념과 local session 개념이 섞임. 설계가 무거워짐 | 비추천 |
| C. Native local CLI session API 추가 | `/local/cli/sessions/*` 같은 별도 surface에서 CLI session과 raw events를 노출 | 변환 최소, 빠름, 품질 제어 쉬움, provider proxy와 경계 명확 | 새 API surface 필요 | 추천 |
| D. 완전 raw stdio bridge | CLI stdin/stdout을 거의 그대로 HTTP/WebSocket으로 노출 | 가장 얇음 | 보안/호환성/에러처리/cleanup 위험이 큼 | 내부 구현 힌트로만 사용 |

기본 선택은 C이다. C는 불필요한 provider-compatible 가공을 제거하면서도, 완전 raw stdio의 위험을 피한다.

## Public API surface

초기 버전은 HTTP + SSE만 둔다. WebSocket은 필요해질 때 추가한다.

현재 구현된 endpoint:

| Method | Path | Status |
| --- | --- | --- |
| `POST` | `/local/cli/sessions` | Implemented |
| `GET` | `/local/cli/sessions/{session_id}` | Implemented |
| `POST` | `/local/cli/sessions/{session_id}/turns` | Implemented for JSON and SSE |
| `POST` | `/local/cli/sessions/{session_id}/interrupt` | Implemented |
| `DELETE` | `/local/cli/sessions/{session_id}` | Implemented |

The installable `local-oauth-cli proxy --runtime <runtime>` process enables native local chat sessions for the selected runtime. Start separate proxy processes when both Codex and Claude native chat sessions are needed at the same time.

### Create session

```http
POST /local/cli/sessions
content-type: application/json
```

Input:

```json
{
  "runtime": "codex",
  "cwd": "/path/to/project",
  "model": "gpt-5.5",
  "title": "Planning session",
  "mode": "native",
  "options": {
    "reasoningEffort": "medium",
    "verbosity": "medium",
    "imageGeneration": false
  }
}
```

Output:

```json
{
  "id": "sess_...",
  "runtime": "codex",
  "created_at": 0,
  "status": "ready",
  "native": {
    "thread_id": "..."
  }
}
```

Rules:

- `runtime` is `codex` or `claude`.
- `cwd` is the consumer workspace for the session.
- The server creates one isolated local CLI session resource.
- Direct provider API keys/base URLs are stripped from spawned child env.
- For Codex, the session owns one app-server thread.
- For Claude, the session owns one persistent `claude -p --input-format stream-json --output-format stream-json` process when possible.

### Start turn

```http
POST /local/cli/sessions/{session_id}/turns
content-type: application/json
```

Input:

```json
{
  "input": [
    {
      "type": "text",
      "text": "이 화면의 문제를 같이 진단해보자."
    },
    {
      "type": "image",
      "source": {
        "type": "url",
        "url": "file:///path/to/screenshot.png"
      }
    }
  ],
  "stream": true,
  "metadata": {
    "client_turn_id": "turn-ui-1"
  }
}
```

Output when `stream: false`:

```json
{
  "id": "turn_...",
  "session_id": "sess_...",
  "status": "completed",
  "events": [],
  "final": {
    "text": "...",
    "raw": {}
  },
  "usage": {}
}
```

Output when `stream: true`: SSE stream.

```text
event: cli.event
data: {"session_id":"sess_...","turn_id":"turn_...","runtime":"codex","raw":{"method":"item/agentMessage/delta","params":{"delta":"..."}}}

event: cli.completed
data: {"session_id":"sess_...","turn_id":"turn_...","runtime":"codex","raw":{"method":"turn/completed","params":{}}}
```

Rules:

- The public event wrapper is small and stable: `event`, `session_id`, `turn_id`, `runtime`, `raw`.
- `raw` preserves the native CLI event as closely as possible.
- The server may add `text_delta`, `usage`, or `tool` convenience projections later, but `raw` remains the authority.
- No OpenAI Chat/Responses or Anthropic Messages reconstruction is done on this path.

### Interrupt turn

```http
POST /local/cli/sessions/{session_id}/interrupt
```

Output:

```json
{
  "session_id": "sess_...",
  "status": "interrupting"
}
```

Runtime mapping:

- Codex: `turn/interrupt`.
- Claude: process signal or CLI-supported interruption when available.

### Close session

```http
DELETE /local/cli/sessions/{session_id}
```

Output:

```json
{
  "session_id": "sess_...",
  "status": "closed"
}
```

Runtime mapping:

- Codex: `thread/archive` and app-server cleanup when session owns the child.
- Claude: close stdin/process and cleanup temp state.

### Inspect session

```http
GET /local/cli/sessions/{session_id}
```

Output:

```json
{
  "id": "sess_...",
  "runtime": "codex",
  "status": "ready",
  "created_at": 0,
  "last_turn_id": "turn_...",
  "native": {
    "thread_id": "..."
  }
}
```

## Runtime mapping

### Codex

Recommended hot path:

1. Spawn `codex app-server` with existing isolation and env sanitization.
2. Initialize app-server once for the chat server or session pool.
3. On `POST /local/cli/sessions`, call `thread/start` with `ephemeral: false` or a session-scoped persistence setting.
4. On each turn, call `turn/start` with native input items.
5. Forward app-server notifications as `cli.event` SSE payloads.
6. On completion, forward `turn/completed` as `cli.completed`.

Do not rebuild OpenAI Chat or Responses objects on this path. That is the main speed and quality win.

Current behavior:

- Uses an isolated `CODEX_HOME` with copied local Codex auth and direct provider env sanitization.
- Starts one app-server thread per local chat session.
- Uses the caller `cwd` as the runtime workspace root with read-only sandbox and `approvalPolicy: "never"`.
- Emits app-server notifications as raw `cli.event` payloads and exposes `text_delta` / `usage` projections when present.

### Claude

Recommended hot path:

1. Spawn a persistent Claude process for the session when the request does not require per-turn CLI flags that force one-shot execution.
2. Use `--input-format stream-json --output-format stream-json`.
3. Do not send `/clear` after every turn. Session continuity is the point of this API.
4. Forward stream-json output lines as `cli.event` SSE payloads.
5. Close the process on session close.

When a turn needs flags that Claude only supports at process start, either reject that option for persistent chat sessions or create a separate one-shot non-chat request path. Do not silently break session continuity.

Current behavior:

- Uses one persistent `claude -p --input-format stream-json --output-format stream-json` process per local chat session.
- Does not send `/clear` after turns.
- Disables slash commands and uses an empty strict MCP config by default.
- Emits Claude JSONL messages as raw `cli.event` payloads and exposes `text_delta` / `usage` projections when present.

## Event envelope

The envelope should stay intentionally small:

```ts
interface LocalCliChatEvent {
  event: "cli.event" | "cli.completed" | "cli.error";
  session_id: string;
  turn_id?: string;
  runtime: "codex" | "claude";
  raw: unknown;
}
```

Optional convenience fields can be added without replacing `raw`:

```ts
interface LocalCliChatEventProjection {
  text_delta?: string;
  usage?: unknown;
  tool_delta?: unknown;
}
```

Rule: projections are views; `raw` is the authority.

## Why this is faster

The existing provider-compatible proxy must perform several expensive or fragile steps:

- normalize provider request into internal message representation
- build backend prompt/instructions
- parse backend output back into OpenAI or Anthropic response schema
- synthesize tool/event/usage shapes
- protect API compatibility edge cases

The local CLI chat API avoids most of that:

- no provider schema reconstruction
- no stateless transcript flattening
- no forced `/clear` for chat turns
- no API-compatible event synthesis unless a caller explicitly asks for projections
- one native session can hold conversation state

This should improve first-token latency and reduce quality drift because the CLI receives a more native turn shape and keeps its own session state.

## Quality control

Quality should be controlled at the session boundary, not by rewriting every prompt:

- session options: model, effort, verbosity, sandbox/approval policy, allowed tools
- isolated ambient context: disable project context by default unless the caller opts in
- explicit attachments: caller passes files/images intentionally
- raw event audit: store raw events for replay/debug
- optional projections: derive UI text/tool/usage views from raw events

The API should not compress or rewrite user prompts for performance.

## Boundary rules

- No direct provider API fallback.
- No direct provider credentials in child CLI env.
- No provider-compatible response synthesis in the native chat hot path.
- No consumer-specific stage names in the package API.
- No hidden project context unless explicitly enabled by session options.
- No session sharing across unrelated consumers unless caller explicitly reuses the same `session_id`.

## Implementation status

| Area | Status | Current behavior |
| --- | --- | --- |
| Types | Implemented | `src/chat/types.ts` expresses session lifecycle without provider API concepts |
| Session manager | Implemented | Can create, inspect, interrupt, close, stream turns, and collect non-stream turns |
| Codex native backend | Implemented | Uses app-server `thread/start`, `turn/start`, `turn/interrupt`, `thread/archive` and forwards raw notifications |
| Claude native backend | Implemented | Uses persistent stream-json process without per-turn `/clear` |
| HTTP endpoints | Implemented | Create, inspect, turn, interrupt, and close work over HTTP/SSE |
| Embedded package export | Not yet implemented | HTTP/bin usage works; embedded consumers do not yet have a dedicated `./chat` export |
| 7 | Add E2E tests with fake Codex/Claude native event streams | Raw event forwarding, interrupt, close, env isolation pass |
| 8 | Add benchmark rows for native chat | Compare first text delta and total turn time against provider-compatible proxy path |

## Benchmark plan

Native chat should be benchmarked separately from provider-compatible proxy rows.

| Case | Compare | Metric |
| --- | --- | --- |
| Codex native chat first turn | `/local/cli/sessions` vs `/v1/chat/completions` | first text delta, total turn |
| Codex native chat follow-up | same session second turn vs stateless API request | first text delta, answer quality |
| Claude native chat first turn | persistent session vs existing Messages proxy | first text delta, total turn |
| Claude native chat follow-up | same session second turn vs one-shot Messages proxy | continuity, quality |
| interrupt | native interrupt endpoint | time to stop event |
| raw event fidelity | fake CLI event fixtures | raw event exactness |

Expected result:

- native chat should be faster than provider-compatible proxy for interactive UI turns.
- native chat should preserve quality better for multi-turn planning because session state is native rather than reconstructed.

## Relationship to existing APIs

| Existing surface | Keep? | Relationship |
| --- | --- | --- |
| `/v1/chat/completions` | Yes | For OpenAI-compatible clients and stateless automation |
| `/v1/responses` | Yes | For OpenAI-compatible Responses clients |
| `/v1/messages` | Yes | For Anthropic-compatible clients |
| `/v1/images/*` | Yes | For OpenAI-compatible image clients |
| `docs/direct-api-transport-handoff.md` | Yes, but separate | For direct provider API transport, not chat session |
| `/local/cli/sessions/*` | New | For native local CLI chat UI |
