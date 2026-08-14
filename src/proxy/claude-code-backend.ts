import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import readline from 'node:readline';
import { honorRequestModel } from '../settings.js';
import { AsyncQueue } from './async-queue.js';
import {
  buildPrompt,
  claudeSystemPrompt,
  forcedSingleToolCall,
  hasToolDecisionSchema,
  outputSchemaFor,
  parseBackendOutput,
  usageFor,
} from './backend-contract.js';
import { claudeMessageContentFor, hasImageInputs } from './multimodal.js';
import { proxyChildProcessEnv } from './process-env.js';
import type {
  LocalCliBackend,
  LocalCompletionResult,
  LocalStreamEvent,
  LocalUsage,
  NormalizedRequest,
} from './types.js';
import { unsupportedModelError } from './types.js';
import { KnownToolArgumentsDeltaExtractor, ToolCallDeltaExtractor } from './tool-call-stream.js';

interface ClaudeCodeBackendOptions {
  readonly command?: string;
  readonly cwd: string;
  readonly model?: string;
  readonly timeoutMs: number;
  readonly extraArgs?: readonly string[];
  readonly honorRequestModel?: boolean;
}

interface ClaudeWaiter {
  readonly onTextDelta?: (delta: string) => void;
  text: string;
  /**
   * The `error` of the last assistant message flagged `is_api_error_message`.
   * Claude Code 2.1.232 reports a refused model there — `"model_not_found"` —
   * and leaves the field off the result event, where 2.1.231 had put it. The
   * result event is what settles the turn, so the kind has to be carried across.
   */
  apiErrorKind?: string;
  structuredOutput: unknown;
  usage: unknown;
  resolve: (value: ClaudeTurnResult) => void;
  reject: (err: Error) => void;
}

interface ClaudeTurnResult {
  readonly text: string;
  readonly structuredOutput: unknown;
  readonly usage: unknown;
  readonly stopReason?: string;
  readonly stopDetails?: unknown;
  readonly stopSequence?: string | null;
}

type JsonObject = Record<string, unknown>;

export class ClaudeCodeBackend implements LocalCliBackend {
  readonly name = 'claude-code';
  readonly model: string;

  private readonly command: string;
  private readonly cwd: string;
  private readonly configuredModel?: string;
  private readonly honorRequestModel: boolean;
  private readonly timeoutMs: number;
  private readonly extraArgs: readonly string[];
  private child: ChildProcessWithoutNullStreams | null = null;
  private lineReader: readline.Interface | null = null;
  private initialized: Promise<void> | null = null;
  private waiter: ClaudeWaiter | null = null;
  private stderr = '';
  private lock: Promise<void> = Promise.resolve();

  constructor(options: ClaudeCodeBackendOptions) {
    this.command = options.command ?? 'claude';
    this.cwd = options.cwd;
    this.model = options.model ?? 'claude-code-cli';
    this.configuredModel = options.model;
    this.honorRequestModel = options.honorRequestModel ?? honorRequestModel();
    this.timeoutMs = options.timeoutMs;
    this.extraArgs = options.extraArgs ?? [];
  }

  /**
   * Resolves which model the CLI runs. With `modelSelection.honorRequestModel`
   * off this is always the configured model, which is what the proxy has always
   * done. With it on the request wins and the configured model is the default.
   *
   * Claude Code validates `--model` itself and refuses an unknown one before any
   * model call, so the CLI stays the authority on which models exist.
   */
  private effectiveModel(request: NormalizedRequest): string | undefined {
    const requested = this.explicitRequestModel(request.model);
    if (this.honorRequestModel && requested) return requested;
    return this.configuredModel;
  }

  /**
   * The request model, or undefined when it carries no model choice — which over
   * HTTP no longer happens: normalization rejects an absent or empty `model`, so
   * only an internal caller can reach the undefined branch. The backend's own
   * identifier (`claude-code-cli`) is a model name like any other here — never a
   * sentinel meaning "no model chosen".
   *
   * What that changes is confined to honouring mode. With honouring on and
   * nothing configured, the identifier is compared against the *configured*
   * model (undefined), never against `this.model` — which is the identifier
   * itself — so it forces the one-shot path and the CLI refuses it. With
   * honouring off the request model is not forwarded at all, so the identifier,
   * like any other requested model, is simply ignored.
   */
  private explicitRequestModel(requestModel: string): string | undefined {
    return requestModel || undefined;
  }

  /**
   * A model string that cannot become a process argument is a bad request, not a
   * server fault. Node rejects a NUL-bearing argv element before the CLI starts,
   * which would otherwise surface as an opaque spawn failure instead of the
   * surface's own model error.
   */
  private assertModelIsSpawnable(model: string, request: NormalizedRequest): void {
    const fromRequest = this.explicitRequestModel(request.model) !== undefined;
    // NUL cannot appear in an argv element, and an oversized one exceeds the
    // host's argument limit (E2BIG). Both fail inside spawn with an error that
    // says nothing about models, so they are answered here instead.
    if (model.includes('\0') || Buffer.byteLength(model, 'utf8') > MAX_MODEL_ARG_BYTES) {
      throw unsupportedModelError(model, request.shape, fromRequest);
    }
  }

  /**
   * Operator-supplied extra arguments, minus any model selection, when the
   * request is the authority on the model. They are appended after the resolved
   * `--model`, so leaving one in would let it win on a last-value-wins parser and
   * silently run a different model than the one the request asked for — and than
   * the one a rejection would be reported against.
   */
  private extraArgsFor(): readonly string[] {
    if (!this.honorRequestModel) return this.extraArgs;
    return stripModelSelectionArgs(this.extraArgs);
  }

  /**
   * The aliases `claude --model` documents, which always resolve to the current
   * generation, plus the configured model. Full version-pinned names are not
   * listed: the CLI does not enumerate them, and hard-coding a generation is
   * exactly the drift this avoids. A client may still name one — the CLI
   * validates it.
   */
  async resolvedModel(request: NormalizedRequest): Promise<string | null> {
    return this.effectiveModel(request) ?? null;
  }

  async availableModels(): Promise<readonly string[] | null> {
    return CLAUDE_MODEL_ALIASES;
  }

  async generate(
    request: NormalizedRequest,
    signal?: AbortSignal,
  ): Promise<LocalCompletionResult> {
    return this.runRequest(request, signal);
  }

  async *stream(
    request: NormalizedRequest,
    signal?: AbortSignal,
  ): AsyncIterable<LocalStreamEvent> {
    const queue = new AsyncQueue<LocalStreamEvent>();
    const forcedTool = forcedSingleToolCall(request);
    const toolExtractor = forcedTool
      ? new KnownToolArgumentsDeltaExtractor(forcedTool.index, forcedTool.id, forcedTool.name)
      : hasToolDecisionSchema(request)
      ? new ToolCallDeltaExtractor()
      : null;
    const shouldStreamText = !toolExtractor && this.canStreamTextDeltas(request);
    const run = this.runRequest(
      request,
      signal,
      toolExtractor
        ? (delta) => {
            for (const event of toolExtractor.push(delta)) queue.push(event);
          }
        : shouldStreamText
        ? (delta) => queue.push({ type: 'text_delta', delta })
        : undefined,
    )
      .then((result) => queue.push({ type: 'completed', result }))
      .catch((err: Error) => queue.fail(err))
      .finally(() => queue.close());

    try {
      for await (const event of queue) yield event;
      await run;
    } finally {
      await run.catch(() => undefined);
    }
  }

  async close(): Promise<void> {
    this.waiter?.reject(new Error('claude code backend closed'));
    this.waiter = null;
    this.lineReader?.close();
    this.child?.kill('SIGTERM');
    this.child = null;
    this.lineReader = null;
    this.initialized = null;
  }

  private async runRequest(
    request: NormalizedRequest,
    signal?: AbortSignal,
    onTextDelta?: (delta: string) => void,
  ): Promise<LocalCompletionResult> {
    const chosen = this.effectiveModel(request);
    if (this.honorRequestModel && chosen) this.assertModelIsSpawnable(chosen, request);
    try {
      if (this.canUsePersistentTurn(request)) {
        return await this.withLock(() => this.runPersistentTurn(request, signal, onTextDelta));
      }
      return await this.runOneShotTurn(request, signal, onTextDelta);
    } catch (err) {
      // The CLI is the authority on which models exist, so its refusal becomes
      // the surface's own not-found error. Mapped here rather than inside one
      // path so the same model produces the same status whether the request took
      // the persistent or the one-shot route.
      //
      // Only when the request chose the model: with honouring off the model came
      // from local configuration, and that stays a server-side fault.
      const model = this.effectiveModel(request);
      if (
        this.honorRequestModel
        && model
        && err instanceof Error
        && isClaudeModelRejection(err)
      ) {
        throw unsupportedModelError(
          model,
          request.shape,
          this.explicitRequestModel(request.model) !== undefined,
        );
      }
      throw err;
    }
  }

  private canStreamTextDeltas(request: NormalizedRequest): boolean {
    return !hasToolDecisionSchema(request) && !request.jsonSchema;
  }

  private canUsePersistentTurn(request: NormalizedRequest): boolean {
    // The persistent process fixes its model at spawn time, so a request that
    // asks for a different one has to take the one-shot path that can pass its
    // own `--model`.
    if (this.effectiveModel(request) !== this.configuredModel) return false;
    return !hasImageInputs(request) && !requiresOneShotClaudeArgs(request, this.configuredModel);
  }

  private async runPersistentTurn(
    request: NormalizedRequest,
    signal?: AbortSignal,
    onTextDelta?: (delta: string) => void,
  ): Promise<LocalCompletionResult> {
    const startedAt = Date.now();
    await this.ensureStarted();
    const turn = await this.sendPersistentMessage(
      await claudeMessageContentFor(request, buildPrompt(request)),
      signal,
      onTextDelta,
    );
    await this.clearPersistentSession(signal);
    return this.resultFromTurn(request, turn, startedAt);
  }

  private async clearPersistentSession(signal?: AbortSignal): Promise<void> {
    await this.sendPersistentMessage('/clear', signal).catch(() => undefined);
  }

  private async runOneShotTurn(
    request: NormalizedRequest,
    signal?: AbortSignal,
    onTextDelta?: (delta: string) => void,
  ): Promise<LocalCompletionResult> {
    const startedAt = Date.now();
    const prompt = buildPrompt(request);
    // Honouring a request model forces this path for requests that would
    // otherwise run on the persistent process, which feeds the prompt over
    // stdin. Passing it as an argument instead would publish system and user
    // content in the child's command line, visible to anything that can read
    // process arguments. Stream-JSON input keeps it off argv.
    const modelForcedOneShot = this.effectiveModel(request) !== this.configuredModel;
    const useStreamJsonInput = hasImageInputs(request) || modelForcedOneShot;
    const includePartialMessages = Boolean(onTextDelta);
    // Which model this one-shot runs on, and the model the per-request tuning
    // flags are gated against — they must be the same one.
    const requestModel = this.effectiveModel(request);
    const argv = [
      '-p',
      ...(useStreamJsonInput ? ['--input-format', 'stream-json'] : []),
      '--output-format',
      'stream-json',
      '--verbose',
      ...(includePartialMessages ? ['--include-partial-messages'] : []),
      ...claudeContextIsolationArgs(),
      '--tools',
      '',
      '--no-session-persistence',
      ...(requestModel ? ['--model', requestModel] : []),
      ...schemaArgsFor(request),
      ...claudeTuningArgs(request, requestModel),
      ...this.extraArgsFor(),
      ...(useStreamJsonInput ? [] : [prompt]),
    ];
    const stdinMessage = useStreamJsonInput
      ? {
          type: 'user',
          message: {
            role: 'user',
            content: await claudeMessageContentFor(request, prompt),
          },
          parent_tool_use_id: null,
        }
      : undefined;
    let turn: ClaudeTurnResult | null = null;
    let lastError: Error | null = null;
    // Validate-and-retry is only safe when the whole output is buffered. When a
    // streaming consumer is attached (onTextDelta), a mid-stream retryable error
    // has already delivered partial deltas, so a second attempt would duplicate
    // output downstream — do not retry in that case.
    const maxAttempts = onTextDelta ? 1 : 2;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        turn = await runClaudeProcess(this.command, argv, {
          cwd: this.cwd,
          timeoutMs: this.timeoutMs,
          signal,
          onTextDelta,
          stdinMessage,
        });
        break;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        // Model refusals are mapped once in runRequest, which covers this path
        // and the persistent one alike.
        if (!isRetryableClaudeStructuredOutputError(lastError) || signal?.aborted) throw lastError;
      }
    }
    if (!turn) throw lastError ?? new Error('claude did not return a result');
    return this.resultFromTurn(request, turn, startedAt);
  }

  private resultFromTurn(
    request: NormalizedRequest,
    turn: ClaudeTurnResult,
    startedAt: number,
  ): LocalCompletionResult {
    const rawText = turn.structuredOutput === undefined
      ? turn.text
      : JSON.stringify(turn.structuredOutput);
    const parsed = parseBackendOutput(request, rawText);
    const usage = usageFromClaude(turn.usage) ?? usageFor(request, parsed.text, parsed.toolCalls);
    return {
      id: `local_${randomUUID()}`,
      model: request.model,
      text: parsed.text,
      toolCalls: parsed.toolCalls,
      usage,
      latencyMs: Date.now() - startedAt,
      stopReason: turn.stopReason,
      stopDetails: turn.stopDetails,
      stopSequence: turn.stopSequence ?? null,
    };
  }

  private async ensureStarted(): Promise<void> {
    if (this.initialized) return this.initialized;
    this.initialized = this.start();
    return this.initialized;
  }

  private async start(): Promise<void> {
    this.child = spawn(this.command, [
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      ...claudeContextIsolationArgs(),
      '--tools',
      '',
      '--no-session-persistence',
      ...(this.configuredModel ? ['--model', this.configuredModel] : []),
      ...this.extraArgsFor(),
    ], {
      cwd: this.cwd,
      shell: false,
      env: proxyChildProcessEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-12_000);
    });
    this.child.on('error', (err) => this.failCurrent(err));
    this.child.on('close', (code, signal) => {
      this.failCurrent(new Error(`claude code exited: code=${code ?? 'null'} signal=${signal ?? 'null'}`));
      this.child = null;
      this.lineReader = null;
      this.initialized = null;
    });
    this.lineReader = readline.createInterface({ input: this.child.stdout });
    this.lineReader.on('line', (line) => this.handlePersistentLine(line));
  }

  private sendPersistentMessage(
    content: string | readonly unknown[],
    signal?: AbortSignal,
    onTextDelta?: (delta: string) => void,
  ): Promise<ClaudeTurnResult> {
    if (!this.child) {
      return Promise.reject(new Error('claude code is not running'));
    }
    if (this.waiter) {
      return Promise.reject(new Error('claude code already has a pending turn'));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        reject(new Error(`claude turn timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      const cleanup = (): void => {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', abortFromSignal);
      };
      const abortFromSignal = (): void => {
        cleanup();
        const err = new Error('request aborted');
        this.waiter = null;
        this.child?.kill('SIGTERM');
        reject(err);
      };
      this.waiter = {
        text: '',
        structuredOutput: undefined,
        usage: undefined,
        onTextDelta,
        resolve: (value) => {
          cleanup();
          resolve(value);
        },
        reject: (err) => {
          cleanup();
          reject(err);
        },
      };
      if (signal) {
        if (signal.aborted) abortFromSignal();
        else signal.addEventListener('abort', abortFromSignal, { once: true });
      }
      this.child?.stdin.write(`${JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: typeof content === 'string' ? [{ type: 'text', text: content }] : content,
        },
        parent_tool_use_id: null,
      })}\n`);
    });
  }

  private handlePersistentLine(line: string): void {
    const message = parseJsonObject(line);
    if (!message || !this.waiter) return;
    consumeClaudeMessage(this.waiter, message);
    if (message.type === 'result') {
      const waiter = this.waiter;
      this.waiter = null;
      if (message.subtype === 'success' && isClaudeModelRejectionResult(message, waiter)) {
        waiter.reject(new ClaudeModelRejectionError(typeof message.result === 'string' ? message.result : 'model rejected'));
      } else if (message.subtype === 'success') {
        waiter.resolve({
          text: typeof message.result === 'string' ? message.result : waiter.text,
          structuredOutput: message.structured_output ?? waiter.structuredOutput,
          usage: message.usage ?? waiter.usage,
          stopReason: readClaudeStopReason(message),
          stopDetails: message.stop_details,
          stopSequence: readClaudeStopSequence(message),
        });
      } else {
        waiter.reject(new Error(readErrorMessage(message)));
      }
    }
  }

  private failCurrent(err: Error): void {
    const detail = this.stderr ? `\n${this.stderr.slice(-2000)}` : '';
    const wrapped = new Error(`${err.message}${detail}`);
    this.waiter?.reject(wrapped);
    this.waiter = null;
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.lock;
    let release!: () => void;
    this.lock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

function schemaArgsFor(request: NormalizedRequest): string[] {
  const schema = outputSchemaFor(request);
  return schema ? ['--json-schema', JSON.stringify(schema)] : [];
}

interface ClaudeModelCapabilities {
  readonly effort: boolean;
  readonly adaptiveThinking: boolean;
}

// Single source of truth for per-request-argument model limits. Haiku supports
// neither the effort parameter nor adaptive thinking; gating is keyed on the model
// the CLI actually runs (the configured `--model`).
function claudeModelCapabilities(model?: string): ClaudeModelCapabilities {
  const isHaiku = /haiku/i.test(model ?? '');
  return { effort: !isHaiku, adaptiveThinking: !isHaiku };
}

// Anthropic-only per-request tuning controls (effort/thinking/task_budget), threaded
// to claude flags. They are only populated by the Anthropic normalizer; this is the
// claude runtime's bounded authority over that surface. Flags gated out for the model
// (e.g. Haiku effort/adaptive thinking) contribute nothing.
function claudeTuningArgs(request: NormalizedRequest, model?: string): string[] {
  const caps = claudeModelCapabilities(model);
  const args: string[] = [];
  if (request.effort && caps.effort) args.push('--effort', request.effort);
  const thinking = request.thinking;
  if (thinking && !(thinking.type === 'adaptive' && !caps.adaptiveThinking)) {
    args.push('--thinking', thinking.type);
    if (thinking.display) args.push('--thinking-display', thinking.display);
  }
  if (request.taskBudgetTokens) args.push('--task-budget', String(request.taskBudgetTokens));
  return args;
}

// Per-request flags must be on the spawned argv, so a request that contributes any
// of them runs one-shot rather than reusing the persistent process (whose argv is
// fixed at spawn). The schema case is scoped to the Anthropic shape, where
// `jsonSchema` comes from `output_config.format` and must reach `claude
// --json-schema`; OpenAI-shape `response_format` keeps its persistent path. Tuning
// flags only force one-shot when they actually contribute (gated-out flags do not).
function requiresOneShotClaudeArgs(request: NormalizedRequest, model?: string): boolean {
  const needsSchema = request.shape === 'anthropic-messages' && request.jsonSchema !== undefined;
  return needsSchema || claudeTuningArgs(request, model).length > 0;
}

function readClaudeStopReason(message: JsonObject): string | undefined {
  return typeof message.stop_reason === 'string' ? message.stop_reason : undefined;
}

function readClaudeStopSequence(message: JsonObject): string | null {
  return typeof message.stop_sequence === 'string' ? message.stop_sequence : null;
}

function claudeContextIsolationArgs(): string[] {
  return [
    '--system-prompt',
    claudeSystemPrompt(),
    '--disable-slash-commands',
    '--strict-mcp-config',
    '--mcp-config',
    '{"mcpServers":{}}',
    '--setting-sources',
    'user',
  ];
}

function runClaudeProcess(
  command: string,
  args: readonly string[],
  options: {
    readonly cwd: string;
    readonly timeoutMs: number;
    readonly signal?: AbortSignal;
    readonly onTextDelta?: (delta: string) => void;
    readonly stdinMessage?: unknown;
  },
): Promise<ClaudeTurnResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
  const abortFromParent = (): void => controller.abort();
  if (options.signal) {
    if (options.signal.aborted) controller.abort();
    else options.signal.addEventListener('abort', abortFromParent, { once: true });
  }

  return new Promise<ClaudeTurnResult>((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      shell: false,
      env: proxyChildProcessEnv(),
      signal: controller.signal,
      stdio: options.stdinMessage ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    const waiter: ClaudeWaiter = {
      text: '',
      structuredOutput: undefined,
      usage: undefined,
      onTextDelta: options.onTextDelta,
      resolve,
      reject,
    };
    const finish = (err?: Error, value?: ClaudeTurnResult): void => {
      clearTimeout(timeout);
      if (options.signal) options.signal.removeEventListener('abort', abortFromParent);
      if (err) reject(err);
      else if (value) resolve(value);
    };
    if (!child.stdout || !child.stderr) {
      finish(new Error('claude process did not expose stdout/stderr pipes'));
      return;
    }
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-12_000);
    });
    child.stdout.on('data', (chunk) => {
      for (const line of String(chunk).split(/\n/)) {
        const message = parseJsonObject(line);
        if (!message) continue;
        consumeClaudeMessage(waiter, message);
        if (message.type === 'result') {
          if (message.subtype === 'success' && isClaudeModelRejectionResult(message, waiter)) {
            finish(new ClaudeModelRejectionError(typeof message.result === 'string' ? message.result : 'model rejected'));
          } else if (message.subtype === 'success') {
            finish(undefined, {
              text: typeof message.result === 'string' ? message.result : waiter.text,
              structuredOutput: message.structured_output ?? waiter.structuredOutput,
              usage: message.usage ?? waiter.usage,
              stopReason: readClaudeStopReason(message),
              stopDetails: message.stop_details,
              stopSequence: readClaudeStopSequence(message),
            });
          } else {
            finish(new Error(readErrorMessage(message)));
          }
        }
      }
    });
    child.on('error', (err) => finish(err));
    child.on('close', (code, signal) => {
      if (code === 0) return;
      finish(new Error(stderr.trim() || `claude exited with code=${code ?? 'null'} signal=${signal ?? 'null'}`));
    });
    if (options.stdinMessage && child.stdin) {
      child.stdin.write(`${JSON.stringify(options.stdinMessage)}\n`);
      child.stdin.end();
    }
  }).finally(() => {
    clearTimeout(timeout);
    if (options.signal) options.signal.removeEventListener('abort', abortFromParent);
  });
}

function consumeClaudeMessage(waiter: ClaudeWaiter, message: JsonObject): void {
  if (message.type === 'stream_event') {
    const event = asRecord(message.event);
    if (event?.type === 'content_block_delta') {
      const delta = asRecord(event.delta);
      if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
        waiter.text += delta.text;
        waiter.onTextDelta?.(delta.text);
      }
    }
    return;
  }
  if (message.type === 'assistant') {
    if (message.is_api_error_message === true && typeof message.error === 'string') {
      waiter.apiErrorKind = message.error;
    }
    const msg = asRecord(message.message);
    const content = Array.isArray(msg?.content) ? msg.content : [];
    const text = content.map((part) => {
      const block = asRecord(part);
      return block?.type === 'text' && typeof block.text === 'string' ? block.text : '';
    }).join('');
    if (text) waiter.text = text;
  }
}

function usageFromClaude(value: unknown): LocalUsage | null {
  const usage = asRecord(value);
  const inputTokens = readNumber(usage?.input_tokens);
  const cacheCreationInputTokens = readNumber(usage?.cache_creation_input_tokens);
  const cacheReadInputTokens = readNumber(usage?.cache_read_input_tokens);
  const cachedInputTokens = cacheCreationInputTokens + cacheReadInputTokens;
  const outputTokens = readNumber(usage?.output_tokens);
  if (inputTokens === 0 && cachedInputTokens === 0 && outputTokens === 0) return null;
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + cachedInputTokens + outputTokens,
    cachedInputTokens,
    cacheCreationInputTokens,
    cacheReadInputTokens,
    source: 'provider',
    raw: value,
  };
}

function readNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function readErrorMessage(message: JsonObject): string {
  if (typeof message.result === 'string' && message.result.trim()) return message.result;
  if (typeof message.error === 'string' && message.error.trim()) return message.error;
  return JSON.stringify(message);
}

function isRetryableClaudeStructuredOutputError(err: Error): boolean {
  return err.message.includes('error_during_execution')
    || err.message.includes('[ede_diagnostic]');
}

/**
 * Carries "the runtime refused this model" from wherever it was recognised to
 * the one place that maps it to a status. Without it the fact has to be
 * re-derived from the error's text at the mapping site, which makes the English
 * sentence load-bearing twice over — and it already changed shape once between
 * two patch releases.
 */
class ClaudeModelRejectionError extends Error {}

/**
 * True when the runtime refused the model. Either it was already recognised from
 * a structured result event, or this is the plain-text path — the CLI refuses an
 * unknown `--model` before starting a session and says "There's an issue with the
 * selected model (<name>)" on stderr, with no structured event to read. Matched
 * on the stable part of that sentence rather than the whole wording.
 */
function isClaudeModelRejection(err: Error): boolean {
  return err instanceof ClaudeModelRejectionError
    || /issue with the selected model/i.test(err.message);
}

/**
 * The same refusal as it arrives under `--output-format stream-json`: the failure
 * is reported inside the result event rather than on stderr, which is why the
 * text used to surface as an ordinary assistant reply.
 *
 * Three signals, deliberately ordered weakest-dependency first. `error:
 * "model_not_found"` is the structured one — but 2.1.231 set it and 2.1.232 sends
 * `null` in its place, so it cannot be relied on alone. `api_error_status: 404`
 * is therefore sufficient by itself: on a turn this proxy builds, the model is
 * the only resource the client names, so a 404 from the turn is a model the
 * runtime will not run. A non-model 404 would be reported to the client as an
 * unavailable model, which is the safer of the two ways to be wrong — the
 * alternative is what this function was written to stop, a refusal returning 200
 * with the refusal sentence as the assistant's answer. The English text stays as
 * a last resort for a report that carries neither field.
 */
function isClaudeModelRejectionResult(message: JsonObject, waiter: ClaudeWaiter): boolean {
  // 2.1.232: on the assistant message, carried here by `consumeClaudeMessage`.
  if (waiter.apiErrorKind === 'model_not_found') return true;
  // 2.1.231: on the result event itself.
  if (message.error === 'model_not_found') return true;
  // Neither field present. A 404 alone is not enough: the CLI's own settings can
  // route it through an operator-run gateway, and a 404 from there is the
  // operator's to fix, not a model the client should stop asking for. Pair it
  // with the refusal sentence, accepting that a rewording of that sentence costs
  // this last-resort branch and nothing else.
  if (message.api_error_status !== 404) return false;
  const text = typeof message.result === 'string' ? message.result : '';
  return /issue with the selected model/i.test(text);
}

// Flags that decide which model actually runs. `--fallback-model` counts: in
// print mode Claude switches to it when the primary is overloaded, which would
// silently run a model other than the one the request asked for and the response
// echoes.
const CLAUDE_MODEL_SELECTION_FLAGS = ['--model', '--fallback-model'];
// Far above any real model name, far below every platform's argv limit.
const MAX_MODEL_ARG_BYTES = 4096;
// Documented by `claude --model`: "an alias for the latest model (e.g. 'fable',
// 'opus', or 'sonnet')". Aliases track generations; version-pinned names do not.
const CLAUDE_MODEL_ALIASES: readonly string[] = ['fable', 'opus', 'sonnet'];

/** Drops `--flag <value>` and `--flag=<value>` pairs for model-selection flags. */
function stripModelSelectionArgs(args: readonly string[]): string[] {
  const kept: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (CLAUDE_MODEL_SELECTION_FLAGS.includes(arg)) {
      index += 1;
      continue;
    }
    if (CLAUDE_MODEL_SELECTION_FLAGS.some((flag) => arg.startsWith(`${flag}=`))) continue;
    kept.push(arg);
  }
  return kept;
}

function parseJsonObject(line: string): JsonObject | null {
  if (!line.trim()) return null;
  try {
    const parsed = JSON.parse(line) as unknown;
    return asRecord(parsed);
  } catch {
    return null;
  }
}

function asRecord(value: unknown): JsonObject | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as JsonObject;
}
