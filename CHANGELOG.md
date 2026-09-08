# Changelog

All notable changes to `local-oauth-cli-api-adapter` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) (pre-1.0: minor versions may carry
breaking changes).

Dates are the published artifact (`artifacts/*.tgz`) build dates; there are no GitHub releases.
This file was reconstructed on 2026-09-07 from the git history, the merged PRs, and the shipped
`dist` in each artifact. Where a fact could be read straight from a tgz it is stated exactly;
where only the PR theme was available the entry stays at that level rather than guessing.

## [0.5.3] — 2026-09-08

Codex OAuth refresh-lease atomicity (Track A). The change is confined to the Codex
OAuth token refresh (`auth.json` handling on the `codex-backend` transport); the
OpenAI Chat/Responses and Anthropic Messages request/response surfaces are unchanged.

### Fixed
- **A concurrent-writer re-read no longer strands the freshly-fetched rotation.**
  After a refresh fetches a new token, it re-reads `auth.json` to merge onto the
  current file. A re-read that *parsed* but was not a usable generation — a codex
  CLI logout, a torn write showing `{}`, or a same-generation file whose identity
  members were present but empty — used to be misclassified: the token-less case was
  treated as a moved generation and the single-use rotation persisted nowhere, and
  the same-generation-unusable case threw the rotation to the caller as an error. If
  the writer's completed file then carried the same generation, the next refresh read
  the stale token, earned a 401, and forced a re-login. The re-read is now classified
  by whether it can actually be used or saved (`settled`/`saveCandidate`): an
  unusable re-read is retried once (the same grace a parse failure already gets) and
  the completed write is saved onto; a re-read still unusable after the retry keeps
  the fetched auth unsaved rather than stranding or throwing it.

### Known follow-ups
- The refresh lease's remaining check-then-act gaps (`unlinkOwnLock`,
  `removeStaleLock`, the save's rename) are a documented lock-atomicity residual
  (`docs/design-task-refresh-lease-atomicity.md`, closed): reachable only under a
  stale orphan plus two contenders, a process suspend, or a > 60 s clock step, with
  the worst case a rare failed request and a forced re-login, bounded by the
  `stillHeld()` persist guard (no unguarded double-persist). A two-provider design
  established that no zero-dependency construction closes them while keeping the
  concurrency floor, and that a native `flock` lock is not justified for that bounded
  harm. Revisit if it shows up in the field.

## [0.5.2] — 2026-09-08

Codex native/app-server completion parity (PR #21): the three pre-existing native-session defects
the F2 review surfaced, now fixed. Behavior changes are confined to the native session API
(`/local/cli/sessions`); the OpenAI Chat/Responses and Anthropic Messages provider surfaces are
unchanged.

### Fixed
- **A plain turn's usage is no longer discarded.** A `turn/completed` closed the turn's stream at
  once, so a `thread/tokenUsage/updated` that trailed the completion (the common ordering) was lost
  and the turn reported no usage. Completion now holds the stream open a bounded grace
  (`USAGE_GRACE_MS`, mirroring the app-server sibling's `USAGE_NOTIFICATION_GRACE_MS`): the trailing
  usage closes it early, or the timer closes it at expiry if none ever arrives. A usage line seen
  before completion still closes immediately.
- **A failed turn is reported as failed, not `completed`.** A `turn/completed` carrying
  `params.turn.status === "failed"` was projected as a normal success; it now retires the turn with
  the child's own error (the shape the app-server sibling rejects with), on both the live path and
  the buffered pre-ack replay.
- **A pre-ack notification burst is no longer truncated.** The pre-ack buffer capped retention at the
  last 100 notifications, so a turn whose first 100+ deltas arrived before its id was acknowledged
  lost its head. The whole burst is now replayed; and because the cap is gone, the buffer of a turn
  stopped while parked on the interrupt barrier — neither flushed nor replaced — is released with the
  turn on retirement, so an unnamed-window burst cannot be retained for the session's life.

### Known follow-ups
- Refresh-lease atomicity (`docs/design-task-refresh-lease-atomicity.md`).

## [0.5.1] — 2026-09-08

The codex interrupt write barrier (F2; PR #19), a correctness fix to the 0.5.0 native session.
Behavior changes are confined to the native session API (`/local/cli/sessions`); the OpenAI
Chat/Responses and Anthropic Messages provider surfaces are unchanged.

### Fixed
- **Nothing starts ahead of an interrupt the child never received.** An interrupt answered `ready`
  as soon as the write call returned; a write to a dead pipe returns `false` and fails a tick later,
  and in that window a turn submitted next could reach the dying child ahead of an interrupt it never
  received. A session-level write barrier, installed synchronously at the interrupt write, now holds
  the next turn until the OS accepts the interrupt bytes — or, on a failed write, until the
  replacement child is installed, so the next turn runs on the successor. The barrier waits on OS
  acceptance, never the RPC ack: an unresponsive child does not hold the next turn, and a
  wedged-but-alive child is capped at one request budget (`timeoutMs`) then falls through to prior
  behavior. A healthy child is never replaced by an interrupt.
- **An interrupted turn's tail is never delivered as the next turn's own.** A `turn/completed` names
  its turn at `params.turn.id` and a delta/usage at `params.turnId`; a notification naming a prior
  turn — or carrying no id at all while a turn is running — is now dropped, so a post-interrupt tail
  can no longer close the next turn's queue (making work that never ran return `completed`) or leak
  its usage into the next turn.

### Known follow-ups
- Codex native/app-server completion parity (`docs/design-task-codex-native-completion-parity.md`):
  three pre-existing native-session defects the F2 review surfaced (a plain turn's usage discarded, a
  failed turn reported `completed`, a >100-notification pre-ack truncation). Filed, not yet fixed.
- Refresh-lease atomicity (`docs/design-task-refresh-lease-atomicity.md`).

## [0.5.0] — 2026-09-07

The native chat session lifecycle, designed as one change (track 1; PR #16, released by PR #17).
Behavior changes are confined to the native session API (`/local/cli/sessions`); the OpenAI
Chat/Responses and Anthropic Messages provider surfaces are unchanged.

### Changed
- A turn is a reservation the manager owns from admission to the end of its caller's iteration; a
  stop ends the turn for its caller at once while the session stays occupied until the runtime
  retires the turn (a turn asked for in that window is `409 turn_already_running`).
- A reader that leaves without a stop leaves the turn to the session: it is drained to its own end
  under the same idle deadline rather than the next turn being admitted on top of it. `interrupt`
  is the way to end it sooner.
- A close resolves only once the child has exited (`SIGTERM` → 1000 ms grace → `SIGKILL` the same
  handle → grace); a codex child's credentials copy is removed after that exit; a child still
  present is named in the close's error. The 1000 ms grace was measured against the real CLIs
  before release (codex `app-server` exits ~4 ms after `SIGTERM`, claude `stream-json` ~520 ms).
- A child that cannot be written to is replaced, thread and all — whether the write throws at the
  call or the pipe reports the failure a tick later.
- A session whose child is gone answers `ready` and starts a child for the next turn (once per
  turn); a turn that could not get one reports the start's own failure.

### Added
- `503 shutting_down`: a session create that arrives after the global close began is refused with
  this code. Two overlapping global closes resolve as one; a teardown a close could not finish is
  re-closed by the next.
- `isBusy()` is now **required** on the `LocalCliChatRuntimeSession` interface (the package is
  private and has no external implementers).

### Known follow-ups
- The codex interrupt write-barrier (`docs/design-task-codex-interrupt-write-barrier.md`): a turn
  submitted in the one-tick window after an async-failed interrupt write can still reach the dying
  child. Filed, not yet fixed.
- Refresh-lease atomicity (`docs/design-task-refresh-lease-atomicity.md`).

## [0.4.0] — 2026-09-06

Text-surface conformance campaign (PR #15). Contract compliance across the OpenAI and Anthropic
text surfaces, with the streaming tool-call identity/ordering rules hardened.

### Changed (breaking — more requests and responses are now rejected)
- New request-boundary `400` rejections and response-path `502` rejections were added so the
  proxy refuses malformed or contract-violating shapes rather than passing them through. The
  precise lists are in `docs/api-interface-contract.md` and the conformance matrix.
- Streaming tool-call identity/ordering: a call is announced only once its `call_id` is known;
  contradictory or anonymous identities are refused rather than repaired.

## [0.3.0] — 2026-09-04

Images namespace and the benchmark exchange recorder (PR #13).

### Added
- Images API mirrored to the direct API's validation envelope; serves the image models the direct
  API serves.

### Changed (breaking)
- Invented image model names and retired `dall-e-*` names are rejected as the direct API rejects
  them; `/v1/images/variations` returns `404`; `response_format` and `style` are rejected as
  `unknown_parameter`.

## [0.2.1] — 2026-08-29

Consumer-reported adapter defects (PRs #8, #9, #10, #11).

### Fixed
- Tool-result image attribution, tool continuation, and cache-usage reporting; the semantic gate
  criterion for the review campaign. First artifact validated by the installed-adapter E2E.

## 0.2.0 — 2026-08-28

First consumer-installable artifact: an OpenAI Chat/Responses and Anthropic Messages provider
proxy over already-logged-in Codex CLI and Claude Code CLI OAuth sessions, plus a native local CLI
session API at `/local/cli/sessions`.

### Note
- `local-oauth-cli proxy` requires `--accept-llm-guide=v1` and refuses to start without it. This
  has been required since 0.2.0 and has **not** changed in any release since; it is documented in
  `README.md` and the quickstart examples. (Recorded here because its absence from a consumer's
  own runbook was once misread as a version change — it is not one.)

[0.5.0]: https://github.com/kangminlee-maker/local-OAuth-CLI-API-adapter/pull/16
[0.4.0]: https://github.com/kangminlee-maker/local-OAuth-CLI-API-adapter/pull/15
[0.3.0]: https://github.com/kangminlee-maker/local-OAuth-CLI-API-adapter/pull/13
[0.2.1]: https://github.com/kangminlee-maker/local-OAuth-CLI-API-adapter/pull/11
