#!/usr/bin/env node
import { ClaudeCodeBackend } from './proxy/claude-code-backend.js';
import { CodexAppServerBackend } from './proxy/codex-app-server-backend.js';
import { startLocalApiProxy } from './proxy/http-server.js';
import {
  codexProxyFallbackReasoningEffort,
  isReasoningEffort,
} from './settings.js';
import type { NormalizedReasoningEffort } from './proxy/types.js';

async function main(argv: readonly string[]): Promise<number> {
  const [command = 'help', ...args] = argv;
  if (command === 'help' || command === '--help' || command === '-h') {
    process.stdout.write(helpText());
    return 0;
  }
  if (command === 'proxy') return proxy(args);
  process.stderr.write(`Unknown command: ${command}\n\n${helpText()}`);
  return 1;
}

async function proxy(args: readonly string[]): Promise<number> {
  const options = parseOptions(args);
  const host = options.host ?? '127.0.0.1';
  const port = parseIntOption(options.port, 8787);
  const timeoutMs = parseIntOption(options.timeoutMs, 180_000);
  const runtimeName = parseProxyRuntimeName(options.runtime ?? 'codex');
  const backend = runtimeName === 'claude'
    ? new ClaudeCodeBackend({
        command: options.command,
        cwd: options.cwd ?? process.cwd(),
        model: options.model,
        timeoutMs,
        extraArgs: options.extraArg,
      })
    : new CodexAppServerBackend({
        command: options.command,
        cwd: options.cwd ?? process.cwd(),
        model: options.model,
        timeoutMs,
        reasoningEffort: parseReasoningEffort(options.reasoningEffort),
      });
  const started = await startLocalApiProxy({
    backend,
    host,
    port,
    requestTimeoutMs: timeoutMs,
  });

  process.stdout.write(`local OAuth CLI API proxy ready\n`);
  process.stdout.write(`  backend: ${backend.name}\n`);
  process.stdout.write(`  baseUrl: ${started.url}/v1\n`);
  process.stdout.write(`  openai: OPENAI_BASE_URL=${started.url}/v1\n`);
  process.stdout.write(`  anthropic: ANTHROPIC_BASE_URL=${started.url}\n`);

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
}

function parseOptions(args: readonly string[]): ParsedOptions {
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
    if (eq === -1 && (value === undefined || value.startsWith('--'))) {
      out[key] = 'true';
      continue;
    }
    if (eq === -1) i += 1;
    if (key === 'extraArg') {
      const current = Array.isArray(out.extraArg) ? out.extraArg : [];
      out.extraArg = [...current, value ?? ''];
    } else {
      out[key] = value ?? '';
    }
  }
  return out as unknown as ParsedOptions;
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

function parseReasoningEffort(
  value: string | undefined,
): NormalizedReasoningEffort | undefined {
  if (value === undefined) return undefined;
  if (isReasoningEffort(value)) return value;
  throw new Error('reasoning effort must be one of none, minimal, low, medium, high, or xhigh.');
}

function helpText(): string {
  return `ggui-oauth-cli

Commands:
  proxy      Start an OpenAI/Anthropic-compatible local API subset proxy.

Options:
  --runtime <codex|claude>           Runtime to use.
  --command <path>                   Override CLI binary path.
  --model <model>                    Pass a model to the selected CLI.
  --extra-arg <arg>                  Extra CLI arg, repeatable.
  --port <number>                    Server port. Default: 8787.
  --host <host>                      Server host. Default: 127.0.0.1.
  --timeout-ms <number>              Runtime timeout. Default: 180000.
  --cwd <dir>                        Working directory for proxy backend. Default: current cwd.
  --reasoning-effort <effort>        Codex proxy fallback effort. Default: settings.json (${codexProxyFallbackReasoningEffort()}).

Examples:
  ggui-oauth-cli proxy --runtime codex --port 8787 --cwd /path/to/project
  ggui-oauth-cli proxy --runtime claude --port 8788 --cwd /path/to/project
`;
}

main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
}).catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
