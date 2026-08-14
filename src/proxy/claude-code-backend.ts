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
  /** Set once the model has produced output of its own on this turn. */
  sawModelOutput?: boolean;
  /**
   * The `error` of the last assistant message flagged `is_api_error_message`.
   * Claude Code 2.1.232 and 2.1.233 report a refused model there — `"model_not_found"` —
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
  // A persistent child fixes its model at spawn. Once it has answered anything,
  // the model is demonstrably runnable, so a refusal sentence arriving on stderr
  // later cannot mean "bad model" — it is a late or unrelated byte. Clearing a
  // receive buffer would not settle that either: stdout and stderr are separate
  // pipes with no delivery ordering between them, so a turn boundary cannot be
  // drawn by timing. This flag draws it by fact instead.
  private childAnswered = false;
  // Set by close(), so an intentional shutdown is not reported as a failure.
  private shuttingDown = false;
  // Which child the backend currently owns. Every handler captures the value it
  // was registered for and does nothing once it is superseded: a dying child's
  // `close` arrives late, and without this it would reject a NEWER child's waiter
  // and null a state that no longer belongs to it.
  //
  // `close()` normally waits for that `close` before returning, which keeps the
  // window shut on its own. What this guards is the one branch where it does not:
  // a descendant holding the stdio pipes open past the give-up deadline, after
  // which `close()` returns and a replacement can be serving when the old event
  // finally lands. That branch is not reachable in a test without a child that
  // outlives its own SIGKILL, so this guard is reasoned defence, not covered by
  // one — said plainly rather than implied by its presence.
  private childGeneration = 0;
  // A close in progress. Concurrent closes await the same one, and a respawn
  // waits for it rather than racing the old child's teardown.
  private closing: Promise<void> | null = null;
  // One operator diagnostic per child: `error` and `close` both fire for a
  // failed spawn, and the second says nothing the first did not.
  private childFailureReported = false;
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
    if (this.closing) return this.closing;
    this.closing = this.closeOnce().finally(() => {
      this.closing = null;
    });
    return this.closing;
  }

  private async closeOnce(): Promise<void> {
    this.shuttingDown = true;
    this.waiter?.reject(new Error('claude code backend closed'));
    this.waiter = null;
    const child = this.detachChild();
    if (!child) return;
    await terminateChild(child);
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
        // The mapped error carries a fixed sentence, so the runtime's own words
        // reach nobody. They are the operator's only lead when the cause is not
        // the model at all — the CLI reports a gateway 404 with these same
        // fields — so put them on the proxy's stderr before they are dropped.
        // Only the CLI's message: no prompt, no argv, no environment.
        process.stderr.write(`claude model rejection (reported as 404): ${asLogLine(err.message)}\n`);
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
    // In a `finally`: a turn that FAILS has still put its content into the
    // child's conversation, and leaving that child alive hands it to the next
    // request. Retirement is about isolation, not about success.
    let turn: ClaudeTurnResult;
    try {
      turn = await this.sendPersistentMessage(
        await claudeMessageContentFor(request, buildPrompt(request)),
        signal,
        onTextDelta,
      );
    } finally {
      await this.clearPersistentSession();
    }
    return this.resultFromTurn(request, turn, startedAt);
  }

  /**
   * End the conversation between requests, by ending the process that holds it.
   *
   * This used to send `/clear`. It never worked: the same spawn carries
   * `--disable-slash-commands`, and the CLI answers `/clear isn't available in
   * this environment` — measured against 2.1.232. So the reset was inert from
   * the day that flag was added, and every request after the first was another
   * turn of the previous request's conversation. A caller could read back a value
   * that appeared only in an earlier caller's body; that was verified end to end
   * before this change and again after it.
   *
   * Dropping the flag would make `/clear` work and would also let a client's own
   * prompt text invoke slash commands, which is the thing the flag exists to
   * stop. Retiring the child is the isolation the persistent path claimed to have
   * — the next request starts a fresh one — and it costs a spawn per request,
   * which is what the one-shot path already pays.
   */
  private async clearPersistentSession(): Promise<void> {
    const child = this.detachChild();
    if (!child) return;
    // Not awaited: isolation is established the moment the backend lets go of
    // this child — the next request cannot reach it. Waiting for it to die would
    // put teardown on every response's critical path. The reaping is still
    // bounded and escalating, it just happens alongside.
    void terminateChild(child);
  }

  /** Let go of the current child and retire its generation, returning it. */
  private detachChild(): ChildProcessWithoutNullStreams | null {
    const child = this.child;
    if (!child) return null;
    this.childGeneration += 1;
    this.child = null;
    this.lineReader?.close();
    this.lineReader = null;
    this.initialized = null;
    return child;
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

  private spawnChild(argv: readonly string[]): ChildProcessWithoutNullStreams {
    try {
      return spawn(this.command, [...argv], {
        cwd: this.cwd,
        shell: false,
        env: proxyChildProcessEnv(),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      throw claudeProcessFailure(
        err instanceof Error ? err : new Error(String(err)),
        '',
        'the local claude runtime failed to start',
        { report: true, allowRefusal: false },
      );
    }
  }

  private async start(): Promise<void> {
    // Never overlap a teardown: the outgoing child still owns `this.child` until
    // its `close` has been handled.
    if (this.closing) await this.closing;
    const generation = ++this.childGeneration;
    this.stderr = '';
    this.childAnswered = false;
    this.childFailureReported = false;
    // Scoped to the child, not to the backend: `close()` clears `initialized`, so
    // a later request spawns a new child, and that one's failures are news.
    this.shuttingDown = false;
    // `spawn` throws synchronously for an empty or NUL-bearing command, and Node
    // puts the offending value in the message — the configured path. That throw
    // never reaches the `error` handler below, so it is caught here and given the
    // same treatment as every other start failure.
    try {
      this.child = this.spawnChild([
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
      ]);
    } catch (err) {
      // Do not leave a rejected promise cached as the backend's start: a later
      // request should make its own attempt and get its own report.
      this.initialized = null;
      throw err;
    }

    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-12_000);
    });
    this.child.on('error', (err) => {
      if (generation !== this.childGeneration) return;
      this.failCurrent(err, 'the local claude runtime failed to start');
    });
    this.child.on('close', (code, signal) => {
      if (generation !== this.childGeneration) return;
      this.failCurrent(
        new Error(`claude code exited: code=${code ?? 'null'} signal=${signal ?? 'null'}`),
        `the local claude runtime exited (code=${code ?? 'null'} signal=${signal ?? 'null'})`,
      );
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
        this.detachWaiter();
        reject(new Error(`claude turn timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      const cleanup = (): void => {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', abortFromSignal);
      };
      const abortFromSignal = (): void => {
        cleanup();
        const err = new Error('request aborted');
        this.detachWaiter();
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
      this.detachWaiter();
      if (message.subtype === 'success' && isClaudeModelRejectionResult(message, waiter)) {
        waiter.reject(claudeModelRejection(message));
      } else if (message.subtype === 'success' && message.is_error !== true) {
        waiter.resolve({
          text: typeof message.result === 'string' ? message.result : waiter.text,
          structuredOutput: message.structured_output ?? waiter.structuredOutput,
          usage: message.usage ?? waiter.usage,
          stopReason: readClaudeStopReason(message),
          stopDetails: message.stop_details,
          stopSequence: readClaudeStopSequence(message),
        });
      } else {
        waiter.reject(claudeTurnFailure(message));
      }
    }
  }

  /**
   * Carry "this child's model runs" up from the turn that observed it, then let
   * the turn go. Every terminal detachment goes through here — a timeout and an
   * abort end a turn just as much as a result does, and forgetting the proof
   * there would let a later stderr sentence re-open a question this child has
   * already answered.
   */
  private detachWaiter(): void {
    this.promoteModelProof();
    this.waiter = null;
  }

  private promoteModelProof(): void {
    if (this.waiter?.sawModelOutput) this.childAnswered = true;
  }

  private failCurrent(err: Error, publicMessage: string): void {
    // The child's stderr is operator-local: it can carry gateway detail, settings
    // values, paths and auth diagnostics, and this error becomes an HTTP 500's
    // message or an in-band SSE error. It goes to the proxy's own stderr instead,
    // flattened and bounded like every other diagnostic here.
    // Evaluated unconditionally: a child that dies while idle has no waiter, and
    // `this.waiter?.reject(f(...))` would skip the call — and the diagnostic with
    // it. This is the only record of why the runtime went away.
    this.promoteModelProof();
    const report = !this.childFailureReported && !this.shuttingDown;
    this.childFailureReported = true;
    const failure = claudeProcessFailure(err, this.stderr, publicMessage, {
      report,
      allowRefusal: !this.childAnswered,
    });
    this.waiter?.reject(failure);
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
    let stderr = '';
    let child: ChildProcessWithoutNullStreams;
    try {
      // Synchronous throws — an empty or NUL-bearing command — never reach the
      // `error` handler below, and Node puts the configured path in the message.
      // The cast preserves the type this call had before it was wrapped: stdio is
      // chosen at runtime, so the general overload widens the streams to nullable
      // and every existing use site would need a guard it never needed.
      child = spawn(command, [...args], {
        cwd: options.cwd,
        shell: false,
        env: proxyChildProcessEnv(),
        signal: controller.signal,
        stdio: options.stdinMessage ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
      }) as ChildProcessWithoutNullStreams;
    } catch (err) {
      reject(claudeProcessFailure(
        err instanceof Error ? err : new Error(String(err)),
        '',
        'the local claude runtime failed to start',
        { report: true, allowRefusal: false },
      ));
      return;
    }
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
            finish(claudeModelRejection(message));
          } else if (message.subtype === 'success' && message.is_error !== true) {
            finish(undefined, {
              text: typeof message.result === 'string' ? message.result : waiter.text,
              structuredOutput: message.structured_output ?? waiter.structuredOutput,
              usage: message.usage ?? waiter.usage,
              stopReason: readClaudeStopReason(message),
              stopDetails: message.stop_details,
              stopSequence: readClaudeStopSequence(message),
            });
          } else {
            finish(claudeTurnFailure(message));
          }
        }
      }
    });
    // A one-shot child is spawned per turn, so its stderr belongs to that turn and
    // a refusal there is always about this request's model. `error` and `close`
    // can both fire for one failed spawn; only the first is worth reporting.
    let reported = false;
    const failure = (err: Error, publicMessage: string): Error => {
      const report = !reported;
      reported = true;
      // Same proof as the persistent route: output already seen means the model
      // runs, so a refusal-looking stderr line afterwards is about something else.
      return claudeProcessFailure(err, stderr, publicMessage, {
        report,
        allowRefusal: !waiter.sawModelOutput,
      });
    };
    child.on('error', (err) => finish(failure(err, 'the local claude runtime failed to start')));
    child.on('close', (code, signal) => {
      if (code === 0) return;
      finish(failure(
        new Error(`claude exited with code=${code ?? 'null'} signal=${signal ?? 'null'}`),
        `the local claude runtime exited (code=${code ?? 'null'} signal=${signal ?? 'null'})`,
      ));
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
        // A streamed delta is model output too. A child that dies mid-stream has
        // still proved its model runs.
        waiter.sawModelOutput = true;
        waiter.text += delta.text;
        waiter.onTextDelta?.(delta.text);
      }
    }
    return;
  }
  if (message.type === 'assistant') {
    // Branch on the flag alone. An API-error assistant is a synthetic message the
    // CLI writes on the model's behalf, whatever shape its `error` field takes —
    // reading it as model output would suppress a refusal the runtime is in the
    // middle of reporting.
    if (message.is_api_error_message === true) {
      if (typeof message.error === 'string') waiter.apiErrorKind = message.error;
    } else {
      // Assistant output IS the proof that the configured model ran. Waiting for
      // the turn to resolve would miss a turn that produced text and then failed,
      // and would count a locally answered `/clear` — which names no model — as
      // proof.
      waiter.sawModelOutput = true;
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

/**
 * A child-process failure, with everything operator-local kept out of the
 * client's error: the child's stderr, and the OS message too — `spawn
 * /some/where/claude ENOENT` names a configured path.
 *
 * The refusal the CLI prints in plain-text mode arrives only on stderr, so it is
 * recognised here and becomes the tagged rejection — that is the one thing a
 * caller needs from those bytes. Everything else goes to the proxy's own stderr,
 * and the returned error carries the fixed description the caller passed.
 */
/**
 * End a child and wait for it, escalating if it will not go. A child that
 * ignores SIGTERM — or a descendant holding its stdio open — would otherwise
 * keep the pipes alive after the backend has let go of it, and nothing would
 * ever close them.
 */
async function terminateChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    let settled = false;
    const done = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(sigkillTimer);
      clearTimeout(giveUpTimer);
      child.removeListener('close', done);
      resolve();
    };
    const sigkillTimer = setTimeout(() => child.kill('SIGKILL'), CHILD_SHUTDOWN_GRACE_MS);
    const giveUpTimer = setTimeout(() => {
      // Nothing is coming. Stop holding the loop open for it.
      child.unref();
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.stdin?.destroy();
      done();
    }, CHILD_SHUTDOWN_GRACE_MS * 2);
    child.once('close', done);
    child.kill('SIGTERM');
  });
}

function claudeProcessFailure(
  err: Error,
  childStderr: string,
  publicMessage: string,
  options: { readonly report: boolean; readonly allowRefusal: boolean },
): Error {
  const detail = childStderr.trim();
  if (options.report) {
    const operatorLine = detail ? `${err.message} :: ${detail}` : err.message;
    process.stderr.write(`claude process failure: ${asLogLine(operatorLine)}\n`);
  }
  if (options.allowRefusal && CLAUDE_REFUSAL_DIAGNOSTIC.test(detail)) {
    return new ClaudeModelRejectionError(publicMessage);
  }
  return new Error(publicMessage);
}

/**
 * A client-visible diagnostic, bounded but not escaped. HTTP JSON and SSE JSON
 * already encode control characters safely, so escaping them here would make a
 * legitimate multi-line runtime message arrive as escape notation. Truncation
 * walks code points so a boundary cannot split an astral character.
 */
function boundedText(message: string): string {
  const budget = MAX_LOG_LINE_CHARS - TRUNCATION_MARKER.length;
  let out = '';
  for (const ch of message) {
    if (out.length + ch.length > budget) return `${out}${TRUNCATION_MARKER}`;
    out += ch;
  }
  return out;
}

function asLogLine(message: string): string {
  const budget = MAX_LOG_LINE_CHARS - TRUNCATION_MARKER.length;
  let out = '';
  for (const ch of message) {
    const piece = NON_PRINTING.test(ch) ? `\\u{${ch.codePointAt(0)?.toString(16)}}` : ch;
    if (out.length + piece.length > budget) return `${out}${TRUNCATION_MARKER}`;
    out += piece;
  }
  return out;
}

// The CLI's refusal diagnostic, as a whole line. Anchoring matters: a hook or a
// log echoing the words mid-line — even with parentheses — is not a refusal
// report, and stderr here is a lifetime buffer where such a line can sit for a
// long time. The second sentence is required too, for the same reason.
//
// Measured against 2.1.232:
//   There's an issue with the selected model (<name>). It may not exist or you
//   may not have access to it. Run --model to pick a different model.
const CLAUDE_REFUSAL_DIAGNOSTIC = new RegExp(
  String.raw`^[^\n]*\bthere's an issue with the selected model\s*\([^)\n]*\)`
  + String.raw`[^\n]*\bmay not (?:exist|have access)\b`,
  'im',
);

// C0, DEL and C1, plus the two Unicode line separators.
const NON_PRINTING = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const TRUNCATION_MARKER = '...[truncated]';
// Long enough for the CLI's refusal sentence and a model name; short enough that
// a hostile value cannot flood an operator's log from one request.
const MAX_LOG_LINE_CHARS = 500;
// A terminating child gets this long to exit before it is killed outright.
const CHILD_SHUTDOWN_GRACE_MS = 2_000;

/**
 * A failed turn as an error: the kind it reports, and the runtime's own words
 * bounded to the same limit as the operator log.
 *
 * Deliberately not a serialization of the event — this message becomes an HTTP
 * 500 and an in-band SSE error, and a result event carries `session_id`, cost
 * and usage. Only fields documented to hold a diagnostic are read (`result`,
 * `error`, `errors[]`), and they are bounded: `errors[]` in particular is
 * unrestricted text that an upstream, a gateway or a hook can fill, so its size
 * is not theirs to choose. The operator gets it too — flattened and bounded to
 * the same limit, not in full: one line per failed request is a channel a
 * client can drive, so no length here is the operator's to choose either.
 */
/**
 * A refused model, carrying the runtime's own words under the same bound as every
 * other client-visible diagnostic. With honouring ON this message is replaced at
 * the mapping site; with it OFF nothing replaces it, so the bound has to be here
 * rather than there.
 */
function claudeModelRejection(message: JsonObject): ClaudeModelRejectionError {
  const detail = typeof message.result === 'string' && message.result.trim()
    ? boundedText(message.result)
    : 'model rejected';
  return new ClaudeModelRejectionError(detail);
}

function claudeTurnFailure(message: JsonObject): ClaudeTurnError {
  const subtype = typeof message.subtype === 'string' && message.subtype !== 'success'
    ? message.subtype
    : undefined;
  const detail = readErrorDetail(message);
  if (detail) process.stderr.write(`claude turn failure: ${asLogLine(detail)}\n`);
  // Bound what is COMPOSED, not just the detail: `subtype` is a runtime-supplied
  // string too, and bounding one half leaves the other free to be any size.
  const composed = detail && subtype ? `${subtype}: ${detail}`
    : detail ? detail
    : subtype ? `claude code reported a failed turn (${subtype})`
    : 'claude code reported a failed turn without a diagnostic message';
  return new ClaudeTurnError(boundedText(composed), subtype);
}

function readErrorDetail(message: JsonObject): string | null {
  if (typeof message.result === 'string' && message.result.trim()) return message.result;
  if (typeof message.error === 'string' && message.error.trim()) return message.error;
  if (Array.isArray(message.errors)) {
    const joined = message.errors.filter((e): e is string => typeof e === 'string').join('; ').trim();
    if (joined) return joined;
  }
  return null;
}

/**
 * Whether a failed turn is worth one more attempt. Read from the failure's own
 * `subtype` when the error carries one, so it does not depend on the diagnostic
 * text surviving into the message — which is exactly what broke once already,
 * when a generic fallback replaced the text and silently made every
 * structured-output failure permanent. The text match stays for errors that
 * arrive without structure.
 */
function isRetryableClaudeStructuredOutputError(err: Error): boolean {
  // A refused model is never retryable: a second attempt runs the same model.
  if (err instanceof ClaudeModelRejectionError) return false;
  // A typed failure knows its own kind, and that answer is final — falling
  // through to the text would let an `error_max_turns` whose diagnostic merely
  // mentions an earlier execution error be retried against its own subtype.
  if (err instanceof ClaudeTurnError && err.subtype !== undefined) {
    return err.subtype === 'error_during_execution';
  }
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
class ClaudeTurnError extends Error {
  constructor(message: string, readonly subtype?: string) {
    super(message);
  }
}

class ClaudeModelRejectionError extends ClaudeTurnError {}

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
 * Whether a finished turn is the runtime refusing the requested model.
 *
 * The refusal arrives inside the event stream, not on stderr, and not as a
 * non-zero exit — which is why it used to surface as an ordinary assistant reply.
 * Where the structured kind sits moved between patch releases: 2.1.231 put
 * `error: "model_not_found"` on the result event, 2.1.232 and later put it on the
 * assistant message (`is_api_error_message: true`) and omits it from the result,
 * so `consumeClaudeMessage` carries it across on the waiter.
 *
 * Only those two structured signals classify here. A refusal carrying neither
 * is left alone: the sentence match on the way out covers the plain-text path
 * and catches it there, so testing the sentence twice would duplicate one rule
 * rather than add a signal.
 *
 * KNOWN AMBIGUITY, measured rather than assumed. Claude Code 2.1.232+ reports a
 * plain HTTP 404 from whatever endpoint it talked to using these same fields.
 * Probed directly: a VALID model (`haiku`) against an endpoint answering 404 to
 * everything produced `error: "model_not_found"`, `api_error_status: 404`, and
 * the selected-model sentence naming the real model — byte-identical in shape to
 * a genuinely unknown model. Nothing in the stream separates the two, so this
 * proxy cannot either. A 404 raised from here therefore means "the runtime would
 * not run this model", not "this model does not exist"; if an operator points the
 * CLI at a gateway that 404s, every request is reported as a model problem. That
 * is documented in the API contract rather than papered over, and the unmapped
 * text is written to the proxy's own stderr so the operator can see the real one.
 */
function isClaudeModelRejectionResult(message: JsonObject, waiter: ClaudeWaiter): boolean {
  // 2.1.232 and later: on the assistant message, carried here by `consumeClaudeMessage`.
  if (waiter.apiErrorKind === 'model_not_found') return true;
  // 2.1.231: on the result event itself.
  if (message.error === 'model_not_found') return true;
  // Neither field present: not classified here. A 404 alone is not enough — the
  // CLI's own settings can route it through an operator-run gateway, and a 404
  // from there is the operator's to fix, not a model the client should stop
  // asking for. A result whose text IS the refusal sentence still maps, but
  // through `isClaudeModelRejection` on the way out, which already matches that
  // sentence for the plain-text path; repeating the test here would be a second
  // copy of one rule, not a second signal.
  return false;
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
