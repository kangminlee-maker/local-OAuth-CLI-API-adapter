#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { createCliGenerator } from './generator.js';
import { ClaudeCodeBackend } from './proxy/claude-code-backend.js';
import { CodexAppServerBackend } from './proxy/codex-app-server-backend.js';
import { startLocalApiProxy } from './proxy/http-server.js';
import { createRuntime } from './runtimes/index.js';
import { startAddonServer } from './server.js';
import {
  codexProxyFallbackReasoningEffort,
  isReasoningEffort,
} from './settings.js';
import {
  sentinelSelectionForRuntime,
  type RuntimeName,
} from './types.js';
import type { NormalizedReasoningEffort } from './proxy/types.js';
import { InMemoryBlueprintProvider } from '@ggui-ai/mcp-server-core/in-memory';

async function main(argv: readonly string[]): Promise<number> {
  const [command = 'help', ...args] = argv;
  if (command === 'help' || command === '--help' || command === '-h') {
    process.stdout.write(helpText());
    return 0;
  }
  if (command === 'serve') return serve(args);
  if (command === 'proxy') return proxy(args);
  if (command === 'generate') return generate(args);
  process.stderr.write(`Unknown command: ${command}\n\n${helpText()}`);
  return 1;
}

async function serve(args: readonly string[]): Promise<number> {
  const options = parseOptions(args);
  const runtimeName = parseRuntimeName(options.runtime ?? 'codex');
  const runtime = createRuntime(runtimeName, {
    command: options.command,
    model: options.model,
    extraArgs: options.extraArg,
  });

  const port = parseIntOption(options.port, 6781);
  const host = options.host ?? '127.0.0.1';
  const started = await startAddonServer({
    runtime,
    port,
    host,
    publicBaseUrl: options.publicBaseUrl,
    timeoutMs: parseIntOption(options.timeoutMs, 180_000),
    maxAttempts: parseIntOption(options.maxAttempts, 2),
    keepWorkspace: Boolean(options.keepWorkspace),
    workspaceRoot: options.workspaceRoot,
    earlyReturnOnCompile: options.earlyReturn !== 'false',
    earlyReturnStableMs: parseIntOption(options.earlyReturnStableMs, 1000),
  });

  process.stdout.write(`ggui OAuth CLI add-on ready\n`);
  process.stdout.write(`  runtime: ${runtime.name}\n`);
  process.stdout.write(`  mcp: ${started.mcpUrl}\n`);
  process.stdout.write(`  publicBaseUrl: ${started.publicBaseUrl}\n`);
  process.stdout.write(`  tools: ${started.server.toolCount}\n`);

  const shutdown = async (): Promise<void> => {
    await started.server.close();
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

async function generate(args: readonly string[]): Promise<number> {
  const options = parseOptions(args);
  const runtimeName = parseRuntimeName(options.runtime ?? 'mock');
  const prompt = options.prompt ?? options._.join(' ').trim();
  if (!prompt) {
    process.stderr.write('generate requires --prompt or trailing prompt text\n');
    return 1;
  }
  const runtime = createRuntime(runtimeName, {
    command: options.command,
    model: options.model,
    extraArgs: options.extraArg,
  });
  const generator = createCliGenerator({
    runtime,
    timeoutMs: parseIntOption(options.timeoutMs, 180_000),
    maxAttempts: parseIntOption(options.maxAttempts, 2),
    keepWorkspace: Boolean(options.keepWorkspace),
    workspaceRoot: options.workspaceRoot,
    earlyReturnOnCompile: options.earlyReturn !== 'false',
    earlyReturnStableMs: parseIntOption(options.earlyReturnStableMs, 1000),
  });
  const selection = sentinelSelectionForRuntime(runtime);
  const result = await generator.generate({
    request: {
      renderId: `dry_${randomUUID()}`,
      prompt,
    },
    llm: selection,
    providerKey: {
      provider: selection.provider,
      key: 'oauth-cli-session',
    },
    blueprints: new InMemoryBlueprintProvider(),
  });

  if (!result.ok) {
    process.stderr.write(`${result.error.message}\n`);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 1;
  }

  const summary = {
    ok: true,
    runtime: runtime.name,
    renderId: result.response.renderId,
    sourceBytes: result.response.sourceCode?.length ?? 0,
    componentBytes: result.response.componentCode.length,
    warnings: result.response.warnings ?? [],
    metadata: result.metadata,
    ...(options.showCode ? { sourceCode: result.response.sourceCode } : {}),
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  return 0;
}

interface ParsedOptions {
  readonly _: string[];
  readonly runtime?: string;
  readonly command?: string;
  readonly model?: string;
  readonly port?: string;
  readonly host?: string;
  readonly publicBaseUrl?: string;
  readonly timeoutMs?: string;
  readonly maxAttempts?: string;
  readonly keepWorkspace?: string;
  readonly workspaceRoot?: string;
  readonly prompt?: string;
  readonly showCode?: string;
  readonly earlyReturn?: string;
  readonly earlyReturnStableMs?: string;
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

function parseRuntimeName(value: string): RuntimeName {
  if (value === 'codex' || value === 'claude' || value === 'mock') return value;
  throw new Error(`Unsupported runtime: ${value}`);
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
  serve      Start a ggui MCP server backed by an OAuth CLI generator.
  proxy      Start an OpenAI/Anthropic-compatible local API subset proxy.
  generate   Run the generator directly for a dry-run compile check.

Options:
  --runtime <codex|claude|mock>      Runtime to use.
  --command <path>                   Override CLI binary path.
  --model <model>                    Pass a model to the selected CLI.
  --extra-arg <arg>                  Extra CLI arg, repeatable.
  --port <number>                    Server port. Default: 6781.
  --host <host>                      Server host. Default: 127.0.0.1.
  --public-base-url <url>            Public URL used in ggui metadata.
  --timeout-ms <number>              Runtime timeout. Default: 180000.
  --cwd <dir>                        Working directory for proxy app-server. Default: current cwd.
  --reasoning-effort <effort>        Codex proxy fallback effort. Default: settings.json (${codexProxyFallbackReasoningEffort()}).
  --max-attempts <number>            Compile feedback attempts. Default: 2.
  --keep-workspace                   Keep temp workspaces after generation.
  --workspace-root <dir>             Parent directory for temp workspaces.
  --early-return <true|false>        Return after generated component compiles. Default: true.
  --early-return-stable-ms <number>  File stability debounce. Default: 1000.
  --prompt <text>                    Prompt for generate.
  --show-code                        Include source code in generate output.

Examples:
  ggui-oauth-cli generate --runtime mock --prompt "Render a status card"
  ggui-oauth-cli serve --runtime codex --port 6781
  ggui-oauth-cli serve --runtime claude --port 6781
  ggui-oauth-cli proxy --runtime codex --port 8787
  ggui-oauth-cli proxy --runtime claude --port 8788
`;
}

main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
}).catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
