# Direct API transport handoff

## Goal

Consumers currently choose between two execution paths:

- `local_oauth_adapter`: use this addon to expose a local OAuth CLI session as an OpenAI/Anthropic-compatible API.
- `direct_api`: bypass this addon and call the provider API with a real API key.

The second path is still implemented in the consumer repository. Move that
direct path into this package as a general-use transport surface, without
weakening the existing proxy runtime boundary.

The desired end state is that consumers ask this package for a provider API
connection regardless of mode. The package then either starts/reuses the local
OAuth proxy or returns a direct provider API connection.

## Current consumer need

The Fastcampus landing editor uses the same model stages in two ways:

| Area | Desired owner | Notes |
| --- | --- | --- |
| M01-M06 OpenAI / Anthropic pipeline calls | addon transport package | API-like calls, no long-lived chat session required |
| M08 section HTML generation | addon transport package | OpenAI-compatible chat/completions request |
| M09 image generation / editor image regeneration | addon transport package | OpenAI Images API request |
| source-ledger image vision analysis | addon transport package | Anthropic Messages multimodal request |
| M00 planning/editor chat sessions | consumer | Keep CLI session surface; session continuity matters |

Today the consumer has local helper modules that duplicate transport decisions:

- OpenAI: local addon proxy vs direct `https://api.openai.com/v1`
- Anthropic: local addon proxy vs direct `https://api.anthropic.com`
- key selection and "real key must not leak to local adapter children"
- loopback external proxy reuse
- non-loopback base URL handling for direct mode

That logic should become a package-level general utility.

## Important boundary

Do not add direct provider calls to the local proxy runtime.

The current proxy runtime boundary is valuable:

- `src/proxy/**` must not call `api.openai.com` or `api.anthropic.com`.
- local proxy requests must not fallback to direct provider APIs.
- local CLI child processes must not inherit direct provider API keys or base URLs.
- benchmark/runtime boundary checks should keep enforcing this.

Direct provider logic should live in a separate package surface, for example
`src/transport/**` or `src/client/**`, not inside `src/proxy/**`.

## Proposed package surface

Add a provider-neutral transport API exported by the package.

```ts
export type ProviderApiTransport = "local_oauth_adapter" | "direct_api";
export type ProviderApiKind = "openai" | "anthropic";
export type LocalRuntimeName = "codex" | "claude";

export interface ProviderApiTransportOptions {
  provider: ProviderApiKind;
  transport: ProviderApiTransport;
  cwd: string;
  model?: string;
  timeoutMs: number;

  // Used only for local_oauth_adapter.
  runtime?: LocalRuntimeName;
  reasoningEffort?: string;
  imageModel?: string;
  proxyBin?: string;
  proxyPort?: number;

  // Used by both modes as explicit overrides.
  baseUrl?: string;
  apiKey?: string;

  // General consumer integration hooks.
  baseUrlEnvKeys?: readonly string[];
  apiKeyEnvKeys?: readonly string[];
  proxyBinEnvKeys?: readonly string[];
  proxyPortEnvKeys?: readonly string[];
}

export interface ProviderApiConnection {
  provider: ProviderApiKind;
  transport: ProviderApiTransport;
  baseUrl: string;
  apiKey: string;
  proxy?: {
    mode: "spawned" | "external" | "direct";
    baseUrl: string;
    command?: string;
    args?: readonly string[];
    commandSource?: "env" | "package" | "path" | "direct";
  };
}

export function withProviderApiTransport<T>(
  options: ProviderApiTransportOptions,
  callback: (connection: ProviderApiConnection) => Promise<T>,
): Promise<T>;
```

Optional convenience helpers:

```ts
export function postOpenAiJson(input: {
  baseUrl: string;
  apiKey: string;
  path: "/chat/completions" | "/responses" | "/images/generations" | "/images/edits" | string;
  body: unknown;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<unknown>;

export function postAnthropicMessagesJson(input: {
  baseUrl: string;
  apiKey: string;
  body: unknown;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<unknown>;
```

Package exports should expose this surface without forcing consumers to import
internal proxy files:

```json
{
  "exports": {
    ".": "./dist/index.js",
    "./transport": "./dist/transport/index.js"
  }
}
```

## Mode semantics

### `local_oauth_adapter`

This is the existing addon behavior generalized as a callable helper.

- If `baseUrl` or an env-derived base URL is loopback, reuse it.
- Use `apiKey: "local"`.
- If no loopback base URL is provided, start `local-oauth-cli proxy`.
- Resolve the installed package bin first, then explicit env/path overrides.
- Choose runtime by provider unless overridden:
  - OpenAI -> `--runtime codex`
  - Anthropic -> `--runtime claude`
- Strip direct provider env from spawned child processes by NAMESPACE, not by a
  list of names: every variable under `ANTHROPIC_`, `OPENAI_`, `AWS_`, `AZURE_`,
  `BEDROCK_`, `VERTEX_`, `GOOGLE_`, `GEMINI_`, `COHERE_`, `DEEPSEEK_`, `GROQ_`,
  `MISTRAL_`, `OPENROUTER_`, `PERPLEXITY_`, `TOGETHER_`, `XAI_`, plus the switches
  that put a child on one of those providers (`CLAUDE_CODE_USE_*`) or hand it a
  direct-API credential (`CLAUDE_CODE_API_KEY*`). A name list could not hold this
  boundary: the installed CLIs read `ANTHROPIC_CUSTOM_HEADERS`,
  `AWS_BEARER_TOKEN_BEDROCK` and `GOOGLE_APPLICATION_CREDENTIALS`, and each
  provider release adds more.
- Do NOT strip the runtime's own local-session env (`CODEX_*`, the rest of
  `CLAUDE_CODE_*`). That is the local OAuth path this proxy runs on, and
  stripping a suppression flag (`CLAUDE_CODE_SKIP_*`, `CLAUDE_CODE_DISABLE_*`)
  would turn the behaviour an operator switched off back on.
- Ignore or reject non-loopback provider base URLs in local mode. They must not
  turn a local transport selection into a direct provider call.

### `direct_api`

This is the current consumer-owned 4C path that should move into this package.

- Do not start the proxy.
- Do not touch local OAuth CLI session state.
- Require a real API key. The sentinel value `"local"` is invalid.
- Use explicit `apiKey` first, then `apiKeyEnvKeys`, then provider defaults.
- Use explicit `baseUrl` first, then `baseUrlEnvKeys`, then provider defaults.
- Provider defaults:
  - OpenAI: `https://api.openai.com/v1`
  - Anthropic: `https://api.anthropic.com`
- Return `proxy.mode = "direct"` metadata for telemetry.
- Redact API keys in all thrown errors and logs.

## Non-goals

- Do not make local proxy requests fallback to direct API.
- Do not auto-switch to direct mode just because a real API key exists.
- Do not route M00/chat session surfaces through this helper.
- Do not mix direct provider host constants into `src/proxy/**`.
- Do not add consumer-specific stage names or Fastcampus-specific concepts.

## Suggested implementation steps

1. Add `src/transport/types.ts`.
2. Add `src/transport/provider-connection.ts` with provider-neutral mode
   resolution and `withProviderApiTransport()`.
3. Factor local proxy command/bin resolution so both CLI and transport helper can
   reuse it.
4. Add `src/transport/openai.ts` and `src/transport/anthropic.ts` convenience
   request helpers.
5. Add package `exports` for `./transport` and include transport files in
   package artifacts.
6. Keep `src/proxy/**` direct-provider-free. Update
   `scripts/verify-runtime-boundary.mjs` so direct hosts/env names are allowed
   only under `src/transport/**`, tests, scripts, and docs.
7. Add consumer-style tests with fake loopback proxy and fake direct fetch.

## Test matrix

| Case | Expected |
| --- | --- |
| local mode + real `OPENAI_API_KEY` present | returns `apiKey: "local"` and spawned child env does not include the real key |
| local mode + real `ANTHROPIC_API_KEY` present | returns `apiKey: "local"` and spawned child env does not include the real key |
| local mode + loopback base URL | reuses external loopback proxy, does not spawn |
| local mode + non-loopback base URL | does not call provider directly; should ignore or fail closed |
| direct OpenAI + real key | returns direct `https://api.openai.com/v1` connection |
| direct Anthropic + real key | returns direct `https://api.anthropic.com` connection |
| direct mode + missing key | fails clearly |
| direct mode + `apiKey: "local"` | fails clearly |
| direct mode + non-loopback custom base URL | uses that base URL only because transport is direct |
| proxy runtime boundary verifier | still rejects provider hosts/env reads inside `src/proxy/**` |

## Consumer migration target

After this package exposes the transport helper, the landing editor should be
able to replace its local wrappers with package calls:

```ts
import {
  postAnthropicMessagesJson,
  postOpenAiJson,
  withProviderApiTransport,
} from "local-oauth-cli-api-adapter/transport";

await withProviderApiTransport(
  {
    provider: "openai",
    transport: settings.api_transports.openai,
    runtime: "codex",
    cwd: repoRoot,
    model,
    timeoutMs,
  },
  (connection) =>
    postOpenAiJson({
      baseUrl: connection.baseUrl,
      apiKey: connection.apiKey,
      path: "/chat/completions",
      body,
      timeoutMs,
    }),
);
```

The consumer still owns:

- UI settings and masked API key inputs
- stage-to-provider selection
- prompt hydration and artifact persistence
- M00/chat session behavior

The addon owns:

- local adapter package/bin resolution
- local proxy spawn/reuse
- direct provider connection resolution
- key isolation and direct-key validation
- provider API POST helpers and redacted error surfaces

## Done when

- A consumer can choose `local_oauth_adapter` or `direct_api` using the same
  package-level transport API.
- Local mode never leaks real provider keys to spawned CLI children.
- Direct mode never starts local OAuth CLI processes.
- Existing proxy runtime tests and boundary verifier still protect
  `src/proxy/**`.
- The package tarball includes the new transport export and types.
- Landing editor can remove its local OpenAI/Anthropic transport duplicate code
  and delegate both 4A/4B and 4C to this addon.
