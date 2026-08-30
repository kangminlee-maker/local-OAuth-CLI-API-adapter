#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { ClaudeCodeBackend } from './proxy/claude-code-backend.js';
import { CodexAppServerBackend } from './proxy/codex-app-server-backend.js';
import { CodexBackendTransport } from './proxy/codex-backend-transport.js';
import { startLocalApiProxy } from './proxy/http-server.js';
import { ClaudeNativeCliChatSession } from './chat/claude-native-session.js';
import { CodexNativeCliChatSession } from './chat/codex-native-session.js';
import { renderLlmInstallGuideNotice } from './llm-install-guide.js';
import { LocalCliChatSessionManager } from './chat/session-manager.js';
import type { LocalCliChatRuntimeFactoryInput } from './chat/types.js';
import {
  codexProxyImageModel,
  codexProxyFallbackReasoningEffort,
  codexProxyImageTransport,
  codexProxyTransport,
  isCodexProxyImageTransport,
  isCodexProxyTransport,
  isReasoningEffort,
} from './settings.js';
import type { CodexProxyImageTransport, CodexProxyTransport } from './settings.js';
import type { LocalCliBackend, NormalizedReasoningEffort, OpenAiImageGenerationClient } from './proxy/types.js';

const LLM_INSTALL_GUIDE_ACCEPT_VERSION = 'v1';

async function main(argv: readonly string[]): Promise<number> {
  const [command = 'help', ...args] = argv;
  if (command === 'help' || command === '--help' || command === '-h') {
    process.stdout.write(helpText());
    return 0;
  }
  if (command === '--llm-guide' || command === 'llm-guide') {
    process.stdout.write(renderLlmInstallGuideNotice());
    return 0;
  }
  if (command === 'proxy') return proxy(args);
  process.stderr.write(`Unknown command: ${command}\n\n${helpText()}`);
  return 1;
}

async function proxy(args: readonly string[]): Promise<number> {
  const options = parseOptions(args);
  if (options.acceptLlmGuide !== LLM_INSTALL_GUIDE_ACCEPT_VERSION) {
    process.stdout.write(renderLlmInstallGuideNotice());
    process.stderr.write(
      `Refusing to start proxy until the LLM install guide is acknowledged. Re-run with --accept-llm-guide=${LLM_INSTALL_GUIDE_ACCEPT_VERSION}.\n`,
    );
    return 1;
  }
  const host = options.host ?? '127.0.0.1';
  const port = parseIntOption(options.port, 8787);
  const timeoutMs = parseIntOption(options.timeoutMs, 180_000);
  const runtimeName = parseProxyRuntimeName(options.runtime ?? 'codex');
  const selectedCodexTransport = parseCodexTransport(options.codexTransport ?? options.transport);
  const selectedCodexImageTransport = parseCodexImageTransport(options.codexImageTransport);
  if (runtimeName !== 'codex' && (options.codexTransport || options.transport)) {
    throw new Error('codex transport can only be selected with --runtime codex.');
  }
  if (runtimeName !== 'codex' && options.codexImageTransport) {
    throw new Error('codex image transport can only be selected with --runtime codex.');
  }
  // A privacy switch must never fail open: an unparsable value is an error, not
  // "off", and asking for it on a runtime that cannot honour it is a mistake
  // worth reporting rather than a flag consumed by nothing.
  const isolateFlag = parseOptionalBooleanFlag(options.isolateUserSettings, '--isolate-user-settings');
  if (runtimeName !== 'claude' && isolateFlag === true) {
    throw new Error('--isolate-user-settings can only be selected with --runtime claude.');
  }
  // Extra args are appended last and win, so these would start a proxy that
  // reports isolation while loading the settings it promised to keep out.
  // `--settings` is a separate CLI flag that loads additional settings — hooks,
  // env, permissions — so it defeats the switch just as directly.
  const settingsOverrideFlags = ['--setting-sources', '--settings'];
  const conflicting = (options.extraArg ?? []).find(
    (arg) => settingsOverrideFlags.some((flag) => arg === flag || arg.startsWith(`${flag}=`)),
  );
  if (isolateFlag === true && conflicting) {
    throw new Error(`--isolate-user-settings conflicts with --extra-arg ${conflicting}: the extra arg would override the isolation.`);
  }
  // Claude isolates by default. An API request is a stranger's question, and the
  // CLI answers it by first reading the operator's global CLAUDE.md, hooks, env
  // and permissions — measured at 25,673 characters on one machine, carrying
  // answer-style directives and an `effort` setting, injected into every call.
  // Loading it was never something a caller asked for, and a prose line asking
  // the model to ignore it is not isolation; the setting source is.
  //
  // Supplying `--setting-sources` or `--settings` yourself is an explicit choice
  // to configure them, so it opts out rather than colliding with a default the
  // operator never typed. Asking for isolation AND overriding it is still an
  // error, above.
  const isolateUserSettings = isolateFlag ?? !conflicting;
  const cwd = options.cwd ?? process.cwd();
  const backend: LocalCliBackend = runtimeName === 'claude'
    ? new ClaudeCodeBackend({
        command: options.command,
        cwd,
        model: options.model,
        timeoutMs,
        extraArgs: options.extraArg,
        isolateUserSettings,
      })
    : createCodexBackend({
        transport: selectedCodexTransport,
        command: options.command,
        cwd,
        model: options.model,
        timeoutMs,
        reasoningEffort: parseReasoningEffort(options.reasoningEffort),
      });
  const imageGenerationClient = runtimeName === 'codex'
    ? createCodexImageGenerationClient({
        transport: selectedCodexImageTransport,
        command: options.command,
        cwd,
        model: options.imageModel ?? codexProxyImageModel(),
        timeoutMs,
      })
    : undefined;
  const chatSessionManager = new LocalCliChatSessionManager({
    defaultCwd: cwd,
    runtimes: {
      [runtimeName]: async (input: LocalCliChatRuntimeFactoryInput) => runtimeName === 'claude'
        ? ClaudeNativeCliChatSession.create({
            command: options.command,
            cwd: input.cwd,
            model: input.model ?? options.model,
            timeoutMs,
            extraArgs: options.extraArg,
            isolateUserSettings,
          })
        : CodexNativeCliChatSession.create({
            command: options.command,
            cwd: input.cwd,
            model: input.model ?? options.model,
            timeoutMs,
            reasoningEffort: input.options?.reasoningEffort ?? parseReasoningEffort(options.reasoningEffort),
            verbosity: input.options?.verbosity,
            imageGeneration: input.options?.imageGeneration,
          }),
    },
  });
  const authKey = configuredAuthKey(options.authKey, process.env.LOCAL_OAUTH_PROXY_KEY);
  const started = await startLocalApiProxy({
    backend,
    imageGenerationClient,
    chatSessionManager,
    host,
    port,
    requestTimeoutMs: timeoutMs,
    authKey,
  });

  process.stdout.write(`local OAuth CLI API proxy ready\n`);
  process.stdout.write(`  backend: ${backend.name}\n`);
  process.stdout.write(`  auth: ${authGateStatus(authKey)}\n`);
  if (runtimeName === 'codex') process.stdout.write(`  codexTransport: ${selectedCodexTransport}\n`);
  if (runtimeName === 'codex') process.stdout.write(`  codexImageTransport: ${selectedCodexImageTransport}\n`);
  // Stated for both values: the default runs operator hooks per API turn, and a
  // mistyped flag would otherwise leave that on with nothing contradicting it.
  if (runtimeName === 'claude') {
    process.stdout.write(`  userSettings: ${isolateUserSettings ? 'isolated (no setting sources) [default]' : `loaded (user source: CLAUDE.md, hooks, env, permissions) [${conflicting ? `--extra-arg ${conflicting}` : '--isolate-user-settings false'}]`}\n`);
  }
  process.stdout.write(`  baseUrl: ${started.url}/v1\n`);
  process.stdout.write(`  openai: OPENAI_BASE_URL=${started.url}/v1\n`);
  process.stdout.write(`  anthropic: ANTHROPIC_BASE_URL=${started.url}\n`);
  process.stdout.write(`  local chat: ${started.url}/local/cli/sessions\n`);

  const shutdown = async (): Promise<void> => {
    await started.close();
  };
  process.once('SIGINT', () => {
    shutdown().finally(() => process.exit(0));
  });
  process.once('SIGTERM', () => {
    shutdown().finally(() => process.exit(0));
  });
  await new Promise<void>(() => undefined);
  return 0;
}

interface ParsedOptions {
  readonly _: string[];
  readonly runtime?: string;
  readonly command?: string;
  readonly model?: string;
  readonly port?: string;
  readonly host?: string;
  readonly timeoutMs?: string;
  readonly extraArg?: readonly string[];
  readonly cwd?: string;
  readonly reasoningEffort?: string;
  readonly imageModel?: string;
  readonly codexTransport?: string;
  readonly codexImageTransport?: string;
  readonly transport?: string;
  readonly acceptLlmGuide?: string;
  readonly authKey?: string;
  readonly isolateUserSettings?: string;
}

export function parseOptions(args: readonly string[]): ParsedOptions {
  const out: Record<string, string | string[]> = { _: [] };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? '';
    if (!arg.startsWith('--')) {
      (out._ as string[]).push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    const rawKey = arg.slice(2, eq === -1 ? undefined : eq);
    const key = rawKey.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
    const value = eq === -1 ? args[i + 1] : arg.slice(eq + 1);
    // `--extra-arg` forwards an arbitrary flag to the child CLI, so its space-form
    // value may itself be `--`-prefixed (e.g. `--extra-arg --effort`); take it
    // verbatim instead of letting the flag-like value collapse to a boolean.
    if (key === 'extraArg') {
      if (eq !== -1) {
        out.extraArg = [...asExtraArgs(out.extraArg), arg.slice(eq + 1)];
      } else if (value !== undefined) {
        out.extraArg = [...asExtraArgs(out.extraArg), value];
        i += 1;
      }
      continue;
    }
    if (eq === -1 && (value === undefined || value.startsWith('--'))) {
      out[key] = 'true';
      continue;
    }
    if (eq === -1) i += 1;
    out[key] = value ?? '';
  }
  return out as unknown as ParsedOptions;
}

function asExtraArgs(value: string | string[] | undefined): string[] {
  return Array.isArray(value) ? value : [];
}

/** Bare flag or an explicit `true`/`false`; anything else is a usage error. */
function parseBooleanFlag(value: string | undefined, flag: string): boolean {
  return parseOptionalBooleanFlag(value, flag) ?? false;
}

// Absent and explicitly-false are different answers when the default is true:
// one means "the operator said nothing", the other "the operator said no".
function parseOptionalBooleanFlag(value: string | undefined, flag: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${flag} takes no value or true/false, got: ${value}`);
}

function parseProxyRuntimeName(value: string): 'codex' | 'claude' {
  if (value === 'codex' || value === 'claude') return value;
  throw new Error(`Unsupported proxy runtime: ${value}`);
}

function parseIntOption(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

/**
 * The configured key, RAW. Only true absence — no flag, no env var — means
 * "no gate". The old normalization trimmed and turned an empty or
 * whitespace-only key into undefined, which read a misconfigured deployment
 * (a secret expanding to "") as a request for an OPEN proxy and silently
 * served everything unauthenticated; it also repaired edge-whitespace keys
 * the server is contracted to reject as configuration errors. Every
 * configured value now reaches the server's own checks, which answer a fixed
 * 500 instead of opening the gate.
 */
export function configuredAuthKey(
  flag: string | undefined,
  env: string | undefined,
): string | undefined {
  return flag ?? env;
}

/**
 * The startup status keys on CONFIGURED vs ABSENT, never on truthiness: an
 * empty configured key is a gate the server refuses to serve through (a fixed
 * 500 per request), and announcing it as "open (no key gate)" would tell the
 * operator their proxy is intentionally unauthenticated. Whether a configured
 * key is VALID is the server's judgment alone — its config-error checks put
 * the specific cause on stderr at the first request — so the status claims
 * only what the CLI knows: a gate is configured, or it is not.
 */
export function authGateStatus(authKey: string | undefined): string {
  return authKey !== undefined
    ? 'required (Authorization: Bearer or x-api-key)'
    : 'open (no key gate)';
}

function parseCodexTransport(value: string | undefined): CodexProxyTransport {
  if (value === undefined) return codexProxyTransport();
  if (isCodexProxyTransport(value)) return value;
  throw new Error('codex transport must be one of app-server or codex-backend.');
}

function parseCodexImageTransport(value: string | undefined): CodexProxyImageTransport {
  if (value === undefined) return codexProxyImageTransport();
  if (isCodexProxyImageTransport(value)) return value;
  throw new Error('codex image transport must be one of app-server or codex-backend.');
}

function parseReasoningEffort(
  value: string | undefined,
): NormalizedReasoningEffort | undefined {
  if (value === undefined) return undefined;
  if (isReasoningEffort(value)) return value;
  throw new Error('reasoning effort must be one of none, minimal, low, medium, high, or xhigh.');
}

export function createCodexBackend(options: {
  readonly transport: CodexProxyTransport;
  readonly command?: string;
  readonly cwd: string;
  readonly model?: string;
  readonly timeoutMs: number;
  readonly reasoningEffort?: NormalizedReasoningEffort;
  // Left undefined in production so the backend reads settings.json; tests pass
  // it explicitly to exercise the honour-on path without rewriting settings.
  readonly honorRequestModel?: boolean;
}): LocalCliBackend {
  if (options.transport === 'codex-backend') {
    return new CodexBackendTransport({
      model: options.model,
      // The catalogue lookup must query the same Codex executable the operator
      // selected, not whichever `codex` happens to be on PATH.
      codexCommand: options.command,
      cwd: options.cwd,
      timeoutMs: options.timeoutMs,
      reasoningEffort: options.reasoningEffort,
      honorRequestModel: options.honorRequestModel,
    });
  }
  return new CodexAppServerBackend({
    command: options.command,
    cwd: options.cwd,
    model: options.model,
    timeoutMs: options.timeoutMs,
    reasoningEffort: options.reasoningEffort,
    honorRequestModel: options.honorRequestModel,
  });
}

function createCodexImageGenerationClient(options: {
  readonly transport: CodexProxyImageTransport;
  readonly command?: string;
  readonly cwd: string;
  readonly model?: string;
  readonly timeoutMs: number;
}): OpenAiImageGenerationClient {
  // Images are out of scope for `modelSelection.honorRequestModel`: an Images API
  // `model` is one of the direct API's image model names (`gpt-image-2` and
  // its siblings), validated as such and routed here regardless — not a
  // Codex slug — and the Codex model for an image turn comes from
  // `codexProxy.imageModel`. The image paths do not consult request models today;
  // pinning the flag off keeps that true if they ever come to share more code.
  if (options.transport === 'codex-backend') {
    return new CodexBackendTransport({
      model: options.model,
      codexCommand: options.command,
      cwd: options.cwd,
      timeoutMs: options.timeoutMs,
      honorRequestModel: false,
    });
  }
  return new CodexAppServerBackend({
    command: options.command,
    cwd: options.cwd,
    model: options.model,
    timeoutMs: options.timeoutMs,
    imageGeneration: true,
    honorRequestModel: false,
  });
}

function helpText(): string {
  return `local-oauth-cli

Commands:
  proxy      Start an OpenAI/Anthropic-compatible proxy plus native local CLI chat API.

Options:
  --llm-guide                       Print the LLM install and usage guide.
  --accept-llm-guide <version>       Required for proxy. Current version: ${LLM_INSTALL_GUIDE_ACCEPT_VERSION}.
  --runtime <codex|claude>           Runtime to use.
  --command <path>                   Override CLI binary path.
  --model <model>                    Pass a model to the selected CLI.
  --extra-arg <arg>                  Extra CLI arg, repeatable.
  --isolate-user-settings            Claude runtime: load no CLI setting sources for
                                     spawned children (API backend and native chat
                                     sessions alike), so the operator's global CLAUDE.md,
                                     hooks, permissions and env settings stay out of them.
                                     Default: off (user settings load).
  --port <number>                    Server port. Default: 8787.
  --host <host>                      Server host. Default: 127.0.0.1.
  --timeout-ms <number>              Runtime timeout. Default: 180000.
  --cwd <dir>                        Working directory for proxy backend. Default: current cwd.
  --reasoning-effort <effort>        Codex proxy fallback effort. Default: settings.json (${codexProxyFallbackReasoningEffort()}).
  --codex-transport <transport>      Codex text/tool transport: app-server or codex-backend. Default: settings.json (${codexProxyTransport()}).
  --codex-image-transport <transport>
                                     Codex Images transport: app-server or codex-backend. Default: settings.json (${codexProxyImageTransport()}).
  --image-model <model>              Codex model that runs Images API turns (every image model name routes here). Default: settings.json (${codexProxyImageModel()}).
  --auth-key <key>                   Require this key on every request via Authorization: Bearer <key> or x-api-key. Env: LOCAL_OAUTH_PROXY_KEY. Default: open (no gate).

Examples:
  local-oauth-cli proxy --accept-llm-guide=${LLM_INSTALL_GUIDE_ACCEPT_VERSION} --runtime codex --port 8787 --cwd /path/to/project
  local-oauth-cli proxy --accept-llm-guide=${LLM_INSTALL_GUIDE_ACCEPT_VERSION} --runtime codex --codex-transport codex-backend --codex-image-transport codex-backend --port 8787
  local-oauth-cli proxy --accept-llm-guide=${LLM_INSTALL_GUIDE_ACCEPT_VERSION} --runtime claude --port 8788 --cwd /path/to/project

Native local CLI chat endpoint:
  POST /local/cli/sessions
  POST /local/cli/sessions/{session_id}/turns
`;
}

// Only run the CLI when invoked directly (not when imported, e.g. by tests).
// realpath resolves the packaged bin symlink so direct/`pnpm exec` runs still match.
function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  }).catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}
