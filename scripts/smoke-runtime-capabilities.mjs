#!/usr/bin/env node
import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { arch, platform, release, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');
const args = process.argv.slice(2);
const outDir = resolve(repoRoot, readValueArg('--out') ?? 'artifacts/runtime-capability-smoke');
const includeLiveModel = args.includes('--include-live-model');
const failOnLiveFailure = args.includes('--fail-on-live-failure');
const timeoutMs = Number(readValueArg('--timeout-ms') ?? 180_000);
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
// Number of live model probes `runLiveModelSmokes` issues; keep in step with it.
const LIVE_PROBE_COUNT = 7;

const tempRoot = await mkdtemp(join(tmpdir(), 'runtime-capability-smoke-'));
const rows = [];
const liveRows = [];
try {
  const catalog = await collectCatalog(tempRoot);
  const codexSchema = await collectCodexSchema(tempRoot, catalog.codex?.binary);

  rows.push(...smokeCatalogBasics(catalog));
  rows.push(...smokeCodexSchema(codexSchema));
  rows.push(...await smokeClaudeHelpCommands(catalog.claude?.binary));
  rows.push(...smokeClaudeFlags(catalog));

  // There used to be a 1M-token warning here fed by a hardcoded 7 x 2,000
  // estimate, so the branch could never fire and documented a safeguard that did
  // not exist. What is actually known before the run is how many live probes it
  // will make; report that instead of a number nobody measured.
  const plannedLiveProbes = includeLiveModel ? LIVE_PROBE_COUNT : 0;

  if (includeLiveModel) {
    liveRows.push(...await runLiveModelSmokes({ timeoutMs }));
    rows.push(...liveRows);
  }

  const summary = summarizeRows(rows, {
    plannedLiveProbes,
  });
  const report = {
    generatedAt: new Date().toISOString(),
    repoRoot,
    platform: {
      os: platform(),
      arch: arch(),
      release: release(),
      node: process.version,
    },
    includeLiveModel,
    timeoutMs,
    riskPolicy: {
      safe_metadata: 'Read-only command, version, help, or generated schema smoke.',
      safe_live_model: 'Short model call with no tools, no session persistence where supported, scratch cwd, and small output target.',
      contained_scratch: 'Potential side effect that may be tested only inside a scratch workspace with explicit harness support.',
      risky_side_effect: 'Auth, install/update, remote-control, marketplace/plugin mutation, process control, or non-scratch filesystem mutation. Not executed by this smoke script.',
      schema_only: 'Protocol input/output schema is validated, but live invocation is skipped because the method is server-originated, notification-only, or risky.',
    },
    summary,
    rows,
  };

  await mkdir(outDir, { recursive: true });
  const jsonPath = join(outDir, `runtime-capability-smoke.${timestamp}.json`);
  const markdownPath = join(outDir, `runtime-capability-smoke.${timestamp}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(markdownPath, renderMarkdown(report));
  await writeFile(join(outDir, 'latest.json'), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(join(outDir, 'latest.md'), renderMarkdown(report));

  process.stdout.write(`runtime capability smoke report: ${jsonPath}\n`);
  process.stdout.write(`runtime capability smoke summary: ${markdownPath}\n`);

  // The runbook's completion criterion asks that every capability carry a risk
  // and an execution mode. The summary counts them, and countBy files a missing
  // field under the literal key "undefined" and prints it as an ordinary total —
  // so the criterion was satisfied by reading a table carefully, or not at all.
  const unclassified = rows.filter((row) => !row.risk || !row.execution);
  if (unclassified.length > 0) {
    process.stderr.write(`rows missing risk or execution: ${unclassified.map((row) => row.id).join(', ')}\n`);
  }
  const hardFailures = rows.filter((row) => row.status === 'fail' && (row.execution !== 'live_model' || failOnLiveFailure));
  if (hardFailures.length > 0 || unclassified.length > 0) process.exitCode = 1;
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

function readValueArg(name) {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

async function collectCatalog(root) {
  const catalogOut = join(root, 'catalog');
  const result = await run(process.execPath, [
    join(repoRoot, 'scripts/update-runtime-capability-catalog.mjs'),
    '--out',
    catalogOut,
    '--skip-binary-scan',
  ], {
    // The collector spawns both CLIs for every version, help, command-tree and
    // parse probe it makes, and each probe carries its own multi-second timeout.
    // It measured 55s here the day a negative-control probe was added to the
    // codex path, which is what a 60s budget turns into an empty crash.
    timeoutMs: 240_000,
    maxBuffer: 20_000_000,
  });
  if (!result.ok) {
    // A killed subprocess writes nothing, so the old message interpolated two
    // empty strings and reported that catalog collection failed for no stated
    // reason. Say which way it failed.
    const how = result.signal
      ? `killed by ${result.signal} (likely the ${240_000}ms budget)`
      : `exit code ${result.code}`;
    throw new Error(`catalog collection failed: ${how}${result.stderr ? `\n${result.stderr}` : ''}`);
  }
  return JSON.parse(await readFile(join(catalogOut, 'latest.json'), 'utf8'));
}

async function collectCodexSchema(root, codexBinary) {
  const out = join(root, 'codex-schema');
  const binary = codexBinary || await commandPath('codex');
  if (!binary) return { exists: false, schemaDir: out, files: [], entries: [] };
  await mkdir(out, { recursive: true });
  const result = await run(binary, [
    'app-server',
    'generate-json-schema',
    '--experimental',
    '--out',
    out,
  ], {
    timeoutMs: 45_000,
    maxBuffer: 30_000_000,
  });
  if (!result.ok) {
    return {
      exists: true,
      generated: commandSummary(result),
      schemaDir: out,
      files: [],
      entries: [],
      error: result.stderr || result.stdout,
    };
  }
  const files = (await listFiles(out)).map((file) => file.slice(out.length + 1)).sort();
  return {
    exists: true,
    generated: commandSummary(result),
    schemaDir: out,
    files,
    entries: await parseCodexSchemaEntries(out),
  };
}

function smokeCatalogBasics(catalog) {
  const result = [];
  // The collector already ran, spawned both CLIs and reached a verdict; reading
  // it here is free. Discarding it meant an operator who ran only this smoke saw
  // green over a stale catalog, because nothing else in this report looks at
  // whether the documented surface still matches the installed one.
  const validity = catalog.catalogValidity ?? {};
  const validityOk = validity.exists === true
    && validity.staleCount === 0
    && validity.inconclusive === false;
  result.push({
    id: 'catalog.validity',
    runtime: 'both',
    kind: 'catalog_validation',
    risk: 'safe_metadata',
    execution: 'metadata',
    status: validityOk ? 'pass' : 'fail',
    inputContract: 'update-runtime-capability-catalog.mjs --skip-binary-scan (run by this smoke)',
    outputSchema: 'catalogValidity: exists, staleCount 0, inconclusive false',
    evidence: [
      `verdict=${validity.verdict ?? 'missing'}`,
      `stale=${validity.staleCount ?? 'n/a'}`,
      `versionDrift=${(validity.versionDrift ?? []).length}`,
      (validity.inconclusiveReasons ?? []).length > 0
        ? `inconclusive: ${validity.inconclusiveReasons.join('; ')}`
        : 'inconclusive: none',
    ].join(' | '),
  });
  result.push({
    id: 'catalog.codex.version',
    runtime: 'codex',
    kind: 'cli_metadata',
    risk: 'safe_metadata',
    execution: 'metadata',
    status: catalog.codex?.version?.ok ? 'pass' : 'fail',
    inputContract: 'codex --version',
    outputSchema: 'stdout first line contains installed Codex CLI version',
    evidence: firstLine(catalog.codex?.version?.stdout),
  });
  result.push({
    id: 'catalog.claude.version',
    runtime: 'claude',
    kind: 'cli_metadata',
    risk: 'safe_metadata',
    execution: 'metadata',
    status: catalog.claude?.version?.ok ? 'pass' : 'fail',
    inputContract: 'claude --version',
    outputSchema: 'stdout first line contains installed Claude Code version',
    evidence: firstLine(catalog.claude?.version?.stdout),
  });
  for (const [id, command] of Object.entries(catalog.codex?.help ?? {})) {
    result.push({
      id: `codex.help.${id}`,
      runtime: 'codex',
      kind: 'cli_help',
      risk: 'safe_metadata',
      execution: 'help',
      status: command.ok ? 'pass' : 'fail',
      inputContract: codexHelpInput(id),
      outputSchema: 'help or metadata text on stdout',
      evidence: firstNonEmptyLine(command.stdout) || firstNonEmptyLine(command.stderr),
    });
  }
  for (const [id, command] of Object.entries(catalog.claude?.help ?? {})) {
    result.push({
      id: `claude.help.${id}`,
      runtime: 'claude',
      kind: 'cli_help',
      risk: classifyClaudeCommand(id).risk,
      execution: 'help',
      status: command.ok ? 'pass' : 'fail',
      inputContract: claudeHelpInput(id),
      outputSchema: 'help or metadata text on stdout',
      evidence: firstNonEmptyLine(command.stdout) || firstNonEmptyLine(command.stderr),
    });
  }
  return result;
}

function smokeCodexSchema(codexSchema) {
  if (!codexSchema.exists || codexSchema.error) {
    return [{
      id: 'codex.app_server.schema_bundle',
      runtime: 'codex',
      kind: 'protocol_schema',
      risk: 'safe_metadata',
      execution: 'schema_generation',
      status: 'fail',
      inputContract: 'codex app-server generate-json-schema --experimental --out <tmp>',
      outputSchema: 'JSON schema files for ClientRequest, ClientNotification, ServerRequest, ServerNotification',
      evidence: codexSchema.error ?? 'codex binary not found',
    }];
  }
  const rows = [{
    id: 'codex.app_server.schema_bundle',
    runtime: 'codex',
    kind: 'protocol_schema',
    risk: 'safe_metadata',
    execution: 'schema_generation',
    status: codexSchema.files.includes('ClientRequest.json') && codexSchema.files.includes('ServerNotification.json') ? 'pass' : 'fail',
    inputContract: 'codex app-server generate-json-schema --experimental --out <tmp>',
    outputSchema: 'JSON schema files for protocol request/notification unions',
    evidence: `${codexSchema.files.length} schema files`,
  }];
  for (const entry of codexSchema.entries) {
    const classification = classifyCodexMethod(entry.method, entry.direction);
    rows.push({
      id: `codex.schema.${entry.direction}.${entry.method}`,
      runtime: 'codex',
      kind: 'app_server_method',
      risk: classification.risk,
      execution: classification.execution,
      status: entry.paramsSchemaOk ? 'pass' : 'fail',
      inputContract: {
        direction: entry.direction,
        method: entry.method,
        paramsRef: entry.paramsRef,
        paramsRequired: entry.paramsSummary.required,
        paramsProperties: entry.paramsSummary.properties,
      },
      outputSchema: {
        direction: entry.direction,
        paramsOrResultRef: entry.resultRef,
        resultRequired: entry.resultSummary.required,
        resultProperties: entry.resultSummary.properties,
      },
      evidence: classification.reason,
    });
  }
  return rows;
}

async function smokeClaudeHelpCommands(claudeBinary) {
  if (!claudeBinary) return [];
  const root = await run(claudeBinary, ['--help'], { timeoutMs: 12_000, maxBuffer: 8_000_000 });
  if (!root.ok) return [];
  const commands = extractClaudeCommands(root.stdout);
  const rows = [];
  for (const command of commands) {
    const primary = command.split('|')[0];
    const classification = classifyClaudeCommand(primary);
    const result = await run(claudeBinary, [primary, '--help'], {
      timeoutMs: 12_000,
      maxBuffer: 8_000_000,
    });
    rows.push({
      id: `claude.command.${primary}.help`,
      runtime: 'claude',
      kind: 'cli_command',
      risk: classification.risk,
      execution: 'help',
      status: result.ok ? 'pass' : 'fail',
      inputContract: `claude ${primary} --help`,
      outputSchema: 'command-specific usage/help text',
      evidence: firstNonEmptyLine(result.stdout) || firstNonEmptyLine(result.stderr),
    });
  }
  return rows;
}

// These rows are an inventory with a risk classification, not a check. They are
// built from the flags `--help` reported, so "exists in help" is true by
// construction — and they were the largest block of passes in the report, which
// made the whole smoke read as more verified than it was. A flag the CLI drops
// does not fail here either; the row simply stops being emitted. Flag drift is
// gated by `catalog.validity`, which compares the documented set against the
// collected one. Marking these `inventory` keeps the classification and stops
// them from counting as evidence.
function smokeClaudeFlags(catalog) {
  return (catalog.claude?.helpFlags ?? []).map((flag) => {
    const classification = classifyClaudeFlag(flag);
    return {
      id: `claude.flag.${flag}`,
      runtime: 'claude',
      kind: 'cli_flag',
      risk: classification.risk,
      execution: 'help_definition',
      status: 'inventory',
      inputContract: flag,
      outputSchema: 'flag observed in an aggregated claude --help surface; asserts nothing on its own',
      evidence: classification.reason,
    };
  });
}

async function parseCodexSchemaEntries(schemaDir) {
  const protocol = await readJsonIfExists(join(schemaDir, 'codex_app_server_protocol.schemas.json'));
  const protocolDefinitions = protocol?.definitions ?? {};
  const files = [
    ['ClientRequest', 'ClientRequest.json'],
    ['ClientNotification', 'ClientNotification.json'],
    ['ServerRequest', 'ServerRequest.json'],
    ['ServerNotification', 'ServerNotification.json'],
  ];
  const entries = [];
  for (const [direction, file] of files) {
    const schema = await readJsonIfExists(join(schemaDir, file));
    if (!schema) continue;
    const definitions = { ...protocolDefinitions, ...(schema.definitions ?? {}) };
    for (const item of schema.oneOf ?? []) {
      const method = item?.properties?.method?.enum?.[0];
      if (typeof method !== 'string') continue;
      const paramsRef = item.properties?.params?.$ref ?? null;
      const paramsName = refName(paramsRef);
      const paramsSchema = paramsName ? definitions[paramsName] : null;
      const responseName = paramsName ? paramsName.replace(/Params$/, 'Response') : null;
      const responseSchema = responseName ? definitions[responseName] : null;
      const resultRef = responseSchema
        ? `#/definitions/${responseName}`
        : direction.endsWith('Notification')
          ? paramsRef
          : '#/definitions/JSONRPCResponse';
      entries.push({
        direction,
        method,
        title: item.title ?? '',
        paramsRef,
        paramsSchemaOk: Boolean(!paramsRef || paramsSchema),
        paramsSummary: summarizeSchema(paramsSchema),
        resultRef,
        resultSummary: summarizeSchema(responseSchema ?? (direction.endsWith('Notification') ? paramsSchema : definitions.JSONRPCResponse)),
      });
    }
  }
  return entries.sort((a, b) => `${a.direction}:${a.method}`.localeCompare(`${b.direction}:${b.method}`));
}

function classifyCodexMethod(method, direction) {
  if (direction === 'ServerNotification' || direction === 'ClientNotification') {
    return {
      risk: 'schema_only',
      execution: 'schema_only',
      reason: 'notification surface; output schema is validated but it is not directly invocable',
    };
  }
  if (direction === 'ServerRequest') {
    return {
      risk: 'schema_only',
      execution: 'schema_only',
      reason: 'server-originated request; client response schema is validated, live trigger requires model/runtime scenario',
    };
  }
  if (/login|logout|oauth|chatgptAuthTokens|attestation/.test(method)) {
    return { risk: 'risky_side_effect', execution: 'schema_only', reason: 'auth/session side effect' };
  }
  if (/marketplace|plugin\/(?:install|uninstall|share|remove|upgrade|checkout|delete|save|updateTargets)/.test(method)) {
    return { risk: 'risky_side_effect', execution: 'schema_only', reason: 'plugin or marketplace mutation' };
  }
  if (/remoteControl|windowsSandbox\/setup|environment\/add/.test(method)) {
    return { risk: 'risky_side_effect', execution: 'schema_only', reason: 'remote-control or environment mutation' };
  }
  if (/process\/|command\/exec|thread\/shellCommand|kill|terminate|writeStdin/.test(method)) {
    return { risk: 'contained_scratch', execution: 'schema_only', reason: 'process execution/control; live smoke requires scratch harness' };
  }
  if (/fs\/(?:writeFile|createDirectory|copy|remove|watch|unwatch)/.test(method)) {
    return { risk: 'contained_scratch', execution: 'schema_only', reason: 'filesystem side effect; live smoke requires scratch harness' };
  }
  if (/thread\/(?:start|resume|fork|archive|unarchive|unsubscribe|rollback|compact|inject|settings|metadata|name|goal|memoryMode|backgroundTerminals|increment|decrement)|turn\//.test(method)) {
    return { risk: 'contained_scratch', execution: 'schema_only', reason: 'thread/session mutation; representative live app-server hot path covers safe text turns' };
  }
  if (/write|set|enablement|enable|disable|reload|batchWrite|clear|reset/.test(method)) {
    return { risk: 'contained_scratch', execution: 'schema_only', reason: 'state mutation; schema-only until contained harness is added' };
  }
  return { risk: 'safe_metadata', execution: 'schema_only', reason: 'read/list/search/status style method; schema presence smoke only' };
}

function classifyClaudeFlag(flag) {
  if (['--dangerously-skip-permissions', '--allow-dangerously-skip-permissions'].includes(flag)) {
    return { risk: 'risky_side_effect', reason: 'permission bypass; never enabled by smoke' };
  }
  if (['--worktree', '--tmux', '--debug-file', '--file', '--add-dir'].includes(flag)) {
    return { risk: 'contained_scratch', reason: 'filesystem/worktree/debug-file side effect unless scratch-contained' };
  }
  if (['--chrome', '--remote-control', '--remote-control-session-name-prefix', '--plugin-dir', '--plugin-url', '--from-pr', '--continue', '--resume', '--fork-session'].includes(flag)) {
    return { risk: 'risky_side_effect', reason: 'integration, plugin, remote, or existing-session side effect' };
  }
  if (['--mcp-config', '--strict-mcp-config', '--allowedTools', '--allowed-tools', '--disallowedTools', '--disallowed-tools', '--tools', '--settings'].includes(flag)) {
    return { risk: 'contained_scratch', reason: 'safe only with generated config/tool allowlist' };
  }
  return { risk: 'safe_live_model', reason: 'safe for short no-tool print/stream smoke or help-definition smoke' };
}

function classifyClaudeCommand(command) {
  if (['install', 'update', 'upgrade', 'setup-token', 'auth'].includes(command)) {
    return { risk: 'risky_side_effect', reason: 'auth or install/update mutation' };
  }
  if (['plugin', 'plugins', 'project', 'agents', 'mcp', 'doctor', 'ultrareview'].includes(command)) {
    return { risk: 'contained_scratch', reason: 'may inspect, spawn, mutate project/plugin/MCP state, or call network' };
  }
  return { risk: 'safe_metadata', reason: 'metadata/help command' };
}

async function runLiveModelSmokes(options) {
  const rows = [];
  const scratch = await mkdtemp(join(tmpdir(), 'runtime-capability-live-'));
  try {
    rows.push(await liveCodexBackendText(scratch, options.timeoutMs));
    rows.push(await liveCodexBackendStream(scratch, options.timeoutMs));
    rows.push(await liveCodexBackendJsonSchema(scratch, options.timeoutMs));
    rows.push(await liveClaudeBackendText(scratch, options.timeoutMs));
    rows.push(await liveClaudeBackendStream(scratch, options.timeoutMs));
    rows.push(await liveClaudeBackendJsonSchema(scratch, options.timeoutMs));
    rows.push(await liveClaudeRawStreamJsonInput(scratch, options.timeoutMs));
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  return rows;
}

async function liveCodexBackendText(cwd, timeout) {
  const id = 'live.codex_app_server.text';
  try {
    const { CodexAppServerBackend } = await import(pathToFileURL(join(repoRoot, 'dist/proxy/codex-app-server-backend.js')).href);
    const backend = new CodexAppServerBackend({ cwd, timeoutMs: timeout, reasoningEffort: 'low', verbosity: 'low' });
    try {
      const result = await backend.generate(textRequest('Reply with exactly this token and no extra characters: RUNTIME_SMOKE_OK', 'codex-app-server'));
      return liveResultRow(id, 'codex', result.text.trim() === 'RUNTIME_SMOKE_OK', {
        inputContract: 'CodexAppServerBackend.generate(NormalizedRequest)',
        outputSchema: 'LocalCompletionResult { id, model, text, toolCalls, usage, latencyMs }',
        evidence: { text: result.text, usage: result.usage, latencyMs: result.latencyMs },
      });
    } finally {
      await backend.close();
    }
  } catch (error) {
    return liveErrorRow(id, 'codex', error);
  }
}

async function liveCodexBackendStream(cwd, timeout) {
  const id = 'live.codex_app_server.stream_text';
  try {
    const { CodexAppServerBackend } = await import(pathToFileURL(join(repoRoot, 'dist/proxy/codex-app-server-backend.js')).href);
    const backend = new CodexAppServerBackend({ cwd, timeoutMs: timeout, reasoningEffort: 'low', verbosity: 'low' });
    try {
      let text = '';
      let completed = false;
      for await (const event of backend.stream(textRequest('Reply with exactly this token and no extra characters: RUNTIME_STREAM_OK', 'codex-app-server'))) {
        if (event.type === 'text_delta') text += event.delta;
        if (event.type === 'completed') {
          completed = true;
          if (!text) text = event.result.text;
        }
      }
      return liveResultRow(id, 'codex', completed && text.trim() === 'RUNTIME_STREAM_OK', {
        inputContract: 'CodexAppServerBackend.stream(NormalizedRequest)',
        outputSchema: 'AsyncIterable<LocalStreamEvent> with text_delta and completed',
        evidence: { text, completed },
      });
    } finally {
      await backend.close();
    }
  } catch (error) {
    return liveErrorRow(id, 'codex', error);
  }
}

async function liveCodexBackendJsonSchema(cwd, timeout) {
  const id = 'live.codex_app_server.json_schema';
  try {
    const { CodexAppServerBackend } = await import(pathToFileURL(join(repoRoot, 'dist/proxy/codex-app-server-backend.js')).href);
    const backend = new CodexAppServerBackend({ cwd, timeoutMs: timeout, reasoningEffort: 'low', verbosity: 'low' });
    try {
      const request = textRequest('Return JSON with status exactly "ok" and runtime exactly "codex".', 'codex-app-server');
      request.jsonSchema = exactStatusSchema('codex');
      const result = await backend.generate(request);
      const parsed = JSON.parse(result.text);
      return liveResultRow(id, 'codex', parsed.status === 'ok' && parsed.runtime === 'codex', {
        inputContract: 'NormalizedRequest.jsonSchema',
        outputSchema: 'LocalCompletionResult.text is JSON matching requested schema',
        evidence: { parsed, usage: result.usage, latencyMs: result.latencyMs },
      });
    } finally {
      await backend.close();
    }
  } catch (error) {
    return liveErrorRow(id, 'codex', error);
  }
}

async function liveClaudeBackendText(cwd, timeout) {
  const id = 'live.claude_code.text';
  try {
    const { ClaudeCodeBackend } = await import(pathToFileURL(join(repoRoot, 'dist/proxy/claude-code-backend.js')).href);
    const backend = new ClaudeCodeBackend({ cwd, timeoutMs: timeout });
    try {
      const result = await backend.generate(textRequest('Reply with exactly this token and no extra characters: RUNTIME_SMOKE_OK', 'claude-code-cli'));
      return liveResultRow(id, 'claude', result.text.trim() === 'RUNTIME_SMOKE_OK', {
        inputContract: 'ClaudeCodeBackend.generate(NormalizedRequest)',
        outputSchema: 'LocalCompletionResult { id, model, text, toolCalls, usage, latencyMs }',
        evidence: { text: result.text, usage: result.usage, latencyMs: result.latencyMs },
      });
    } finally {
      await backend.close();
    }
  } catch (error) {
    return liveErrorRow(id, 'claude', error);
  }
}

async function liveClaudeBackendStream(cwd, timeout) {
  const id = 'live.claude_code.stream_text';
  try {
    const { ClaudeCodeBackend } = await import(pathToFileURL(join(repoRoot, 'dist/proxy/claude-code-backend.js')).href);
    const backend = new ClaudeCodeBackend({ cwd, timeoutMs: timeout });
    try {
      let text = '';
      let completed = false;
      for await (const event of backend.stream(textRequest('Reply with exactly this token and no extra characters: RUNTIME_STREAM_OK', 'claude-code-cli'))) {
        if (event.type === 'text_delta') text += event.delta;
        if (event.type === 'completed') {
          completed = true;
          if (!text) text = event.result.text;
        }
      }
      return liveResultRow(id, 'claude', completed && text.trim() === 'RUNTIME_STREAM_OK', {
        inputContract: 'ClaudeCodeBackend.stream(NormalizedRequest)',
        outputSchema: 'AsyncIterable<LocalStreamEvent> with text_delta and completed',
        evidence: { text, completed },
      });
    } finally {
      await backend.close();
    }
  } catch (error) {
    return liveErrorRow(id, 'claude', error);
  }
}

async function liveClaudeBackendJsonSchema(cwd, timeout) {
  const id = 'live.claude_code.json_schema';
  try {
    const { ClaudeCodeBackend } = await import(pathToFileURL(join(repoRoot, 'dist/proxy/claude-code-backend.js')).href);
    const backend = new ClaudeCodeBackend({ cwd, timeoutMs: timeout });
    try {
      const request = textRequest('Return JSON with status exactly "ok" and runtime exactly "claude".', 'claude-code-cli');
      request.jsonSchema = exactStatusSchema('claude');
      const result = await backend.generate(request);
      const parsed = JSON.parse(result.text);
      return liveResultRow(id, 'claude', parsed.status === 'ok' && parsed.runtime === 'claude', {
        inputContract: 'NormalizedRequest.jsonSchema',
        outputSchema: 'LocalCompletionResult.text is JSON matching requested schema',
        evidence: { parsed, usage: result.usage, latencyMs: result.latencyMs },
      });
    } finally {
      await backend.close();
    }
  } catch (error) {
    return liveErrorRow(id, 'claude', error);
  }
}

async function liveClaudeRawStreamJsonInput(cwd, timeout) {
  const id = 'live.claude_code.raw_stream_json_input';
  const claude = await commandPath('claude');
  if (!claude) return liveErrorRow(id, 'claude', new Error('claude binary not found'));
  const input = {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'text', text: 'Reply with exactly this token and no extra characters: RAW_STREAM_OK' }],
    },
    parent_tool_use_id: null,
  };
  const result = await spawnWithStdin(claude, [
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--tools',
    '',
    '--no-session-persistence',
  ], `${JSON.stringify(input)}\n`, { cwd, timeoutMs: timeout });
  if (!result.ok) return liveErrorRow(id, 'claude', new Error(result.stderr || result.stdout));
  const parsed = result.stdout.split(/\r?\n/).map(parseJsonLine).filter(Boolean);
  const resultLine = parsed.find((line) => line.type === 'result');
  const text = typeof resultLine?.result === 'string' ? resultLine.result : '';
  return liveResultRow(id, 'claude', text.trim() === 'RAW_STREAM_OK', {
    inputContract: 'claude -p --input-format stream-json --output-format stream-json',
    outputSchema: 'JSONL stream ending with type=result',
    evidence: { text, lineTypes: [...new Set(parsed.map((line) => line.type))] },
  });
}

function liveResultRow(id, runtime, ok, detail) {
  return {
    id,
    runtime,
    kind: 'live_model_probe',
    risk: 'safe_live_model',
    execution: 'live_model',
    status: ok ? 'pass' : 'fail',
    ...detail,
  };
}

function liveErrorRow(id, runtime, error) {
  return {
    id,
    runtime,
    kind: 'live_model_probe',
    risk: 'safe_live_model',
    execution: 'live_model',
    status: 'fail',
    inputContract: 'short no-tool live model probe',
    outputSchema: 'expected exact short token or JSON schema output',
    evidence: error instanceof Error ? error.message : String(error),
  };
}

function textRequest(prompt, model) {
  return {
    shape: 'openai-chat',
    model,
    messages: [{ role: 'user', content: prompt, images: [] }],
    maxTokens: 64,
    stream: false,
    streamOptions: { includeUsage: false, includeObfuscation: false },
    jsonMode: false,
    tools: [],
    toolChoice: { type: 'auto' },
    raw: { smoke: true },
  };
}

function exactStatusSchema(runtime) {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      status: { type: 'string', enum: ['ok'] },
      runtime: { type: 'string', enum: [runtime] },
    },
    required: ['status', 'runtime'],
  };
}

function summarizeRows(allRows, extra) {
  const byStatus = countBy(allRows, 'status');
  const byRisk = countBy(allRows, 'risk');
  const byExecution = countBy(allRows, 'execution');
  const liveFailures = allRows.filter((row) => row.execution === 'live_model' && row.status !== 'pass');
  return {
    total: allRows.length,
    byStatus,
    byRisk,
    byExecution,
    liveFailures: liveFailures.map((row) => ({ id: row.id, evidence: row.evidence })),
    ...extra,
  };
}

function renderMarkdown(report) {
  const rowsByRisk = Object.entries(report.summary.byRisk)
    .map(([risk, count]) => `| ${risk} | ${count} |`)
    .join('\n');
  const rowsByExecution = Object.entries(report.summary.byExecution)
    .map(([execution, count]) => `| ${execution} | ${count} |`)
    .join('\n');
  const failures = report.rows
    .filter((row) => row.status === 'fail')
    .map((row) => `| ${row.id} | ${row.runtime} | ${row.execution} | ${escapeCell(formatEvidence(row.evidence))} |`)
    .join('\n') || '| none |  |  |  |';
  return `# Runtime Capability Smoke Report

Generated at: ${report.generatedAt}

Live model probes: ${report.includeLiveModel ? 'enabled' : 'disabled'}

Planned live model probes: ${report.summary.plannedLiveProbes}

## Summary

| Metric | Count |
| --- | ---: |
| Total rows | ${report.summary.total} |
| Pass | ${report.summary.byStatus.pass ?? 0} |
| Fail | ${report.summary.byStatus.fail ?? 0} |
| Skipped | ${report.summary.byStatus.skip ?? 0} |

## Risk Classification

| Risk | Count |
| --- | ---: |
${rowsByRisk}

## Execution Modes

| Execution | Count |
| --- | ---: |
${rowsByExecution}

## Failures

| ID | Runtime | Execution | Evidence |
| --- | --- | --- | --- |
${failures}

## Notes

- Risky side-effect rows are intentionally schema/help-smoked, not live-executed.
- Codex app-server request/notification rows include method, params schema, and result/notification schema references.
- Live model probes use short no-tool prompts and scratch working directories.
`;
}

function countBy(items, key) {
  const counts = {};
  for (const item of items) counts[item[key]] = (counts[item[key]] ?? 0) + 1;
  return counts;
}

function codexHelpInput(id) {
  const map = {
    root: 'codex --help',
    exec: 'codex exec --help',
    'exec-resume': 'codex exec resume --help',
    'app-server': 'codex app-server --help',
    'app-server-generate-json-schema': 'codex app-server generate-json-schema --help',
    'app-server-generate-ts': 'codex app-server generate-ts --help',
    debug: 'codex debug --help',
    'debug-app-server': 'codex debug app-server --help',
    'debug-prompt-input': 'codex debug prompt-input --help',
    'debug-models': 'codex debug models --help',
    features: 'codex features --help',
    'features-list': 'codex features list',
  };
  return map[id] ?? `codex ${id} --help`;
}

function claudeHelpInput(id) {
  return id === 'root' ? 'claude --help' : `claude ${id} --help`;
}

function extractClaudeCommands(helpText) {
  const commands = [];
  let inCommands = false;
  for (const line of String(helpText).split(/\r?\n/)) {
    if (line.trim() === 'Commands:') {
      inCommands = true;
      continue;
    }
    if (!inCommands) continue;
    const match = line.match(/^\s{2}([A-Za-z0-9_-]+(?:\|[A-Za-z0-9_-]+)?)(?:\s|\t)/);
    if (match) commands.push(match[1]);
  }
  return [...new Set(commands)].sort();
}

function refName(ref) {
  return typeof ref === 'string' ? ref.split('/').pop() : null;
}

function summarizeSchema(schema) {
  if (!schema || typeof schema !== 'object') return { exists: false, required: [], properties: [] };
  return {
    exists: true,
    type: schema.type ?? (schema.anyOf ? 'anyOf' : schema.oneOf ? 'oneOf' : undefined),
    required: Array.isArray(schema.required) ? schema.required : [],
    properties: schema.properties && typeof schema.properties === 'object'
      ? Object.keys(schema.properties).sort()
      : [],
    enum: Array.isArray(schema.enum) ? schema.enum : undefined,
  };
}

async function readJsonIfExists(path) {
  if (!existsSync(path)) return null;
  return JSON.parse(await readFile(path, 'utf8'));
}

async function listFiles(dir) {
  const result = [];
  for (const name of await readdir(dir)) {
    const path = join(dir, name);
    const fileStat = await stat(path);
    if (fileStat.isDirectory()) result.push(...await listFiles(path));
    else if (fileStat.isFile()) result.push(path);
  }
  return result;
}

async function commandPath(name) {
  const result = await run('/bin/sh', ['-lc', `command -v '${name.replace(/'/g, `'\\''`)}'`], {
    timeoutMs: 10_000,
  });
  if (!result.ok) return null;
  return result.stdout.trim().split(/\r?\n/).filter(Boolean)[0] ?? null;
}

async function run(command, commandArgs, options = {}) {
  try {
    const result = await execFileAsync(command, commandArgs, {
      cwd: options.cwd ?? repoRoot,
      encoding: 'utf8',
      timeout: options.timeoutMs ?? timeoutMs,
      maxBuffer: options.maxBuffer ?? 8_000_000,
      env: process.env,
    });
    return { ok: true, code: 0, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  } catch (error) {
    return {
      ok: false,
      code: typeof error.code === 'number' ? error.code : null,
      signal: error.signal ?? null,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? error.message ?? '',
    };
  }
}

function spawnWithStdin(command, commandArgs, stdin, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, commandArgs, {
      cwd: options.cwd ?? repoRoot,
      shell: false,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      resolve({ ok: false, code: null, signal: 'timeout', stdout, stderr: `${stderr}\ntimeout` });
    }, options.timeoutMs ?? timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout = `${stdout}${chunk}`;
    });
    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${chunk}`;
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ ok: false, code: null, stdout, stderr: error.message });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, code, signal, stdout, stderr });
    });
    child.stdin.end(stdin);
  });
}

function commandSummary(result) {
  return {
    ok: result.ok,
    code: result.code,
    signal: result.signal ?? null,
    stdout: firstNonEmptyLine(result.stdout),
    stderr: firstNonEmptyLine(result.stderr),
  };
}

function firstLine(value) {
  return String(value ?? '').split(/\r?\n/)[0] ?? '';
}

function firstNonEmptyLine(value) {
  return String(value ?? '').split(/\r?\n/).find((line) => line.trim())?.trim() ?? '';
}

function parseJsonLine(line) {
  if (!line.trim()) return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function formatEvidence(value) {
  if (typeof value === 'string') return value.slice(0, 500);
  return JSON.stringify(value).slice(0, 500);
}

function escapeCell(value) {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}
