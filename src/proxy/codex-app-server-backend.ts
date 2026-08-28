import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import readline from 'node:readline';
import {
  codexProxyFallbackReasoningEffort,
  codexProxyFallbackVerbosity,
  honorRequestModel,
} from '../settings.js';
import { AsyncQueue } from './async-queue.js';
import { assertCodexModelSupported, codexModels, sourceCodexHome } from './codex-model-catalog.js';
import {
  baseInstructions,
  buildPrompt,
  developerInstructions,
  forcedSingleToolCall,
  hasToolDecisionSchema,
  outputSchemaFor,
  parseBackendOutput,
  requestInstructionText,
  usageFor,
} from './backend-contract.js';
import {
  image2QualityToGpt55ReasoningEffort,
  image2ViaGpt55PromptFromRequest,
} from './image2-via-gpt55.js';
import { prepareCodexInput } from './multimodal.js';
import { proxyChildProcessEnv } from './process-env.js';
import type {
  LocalCliBackend,
  LocalCompletionResult,
  LocalStreamEvent,
  LocalUsage,
  NormalizedRequest,
  NormalizedReasoningEffort,
  NormalizedVerbosity,
  OpenAiGeneratedImage,
  OpenAiImageGenerationClient,
  OpenAiImageGenerationRequest,
  OpenAiImageGenerationResult,
  OpenAiImageGenerationStreamEvent,
} from './types.js';
import { ProxyRequestError, unsupportedModelError } from './types.js';
import { KnownToolArgumentsDeltaExtractor, ToolCallDeltaExtractor } from './tool-call-stream.js';

interface CodexAppServerBackendOptions {
  readonly command?: string;
  readonly cwd: string;
  readonly model?: string;
  readonly timeoutMs: number;
  readonly reasoningEffort?: CodexReasoningEffort;
  readonly verbosity?: CodexVerbosity;
  readonly imageGeneration?: boolean;
  readonly proxyMode?: CodexAppServerProxyMode;
  readonly onTiming?: (timing: CodexTurnTiming) => void;
  readonly honorRequestModel?: boolean;
}

interface PendingRequest {
  readonly method: string;
  readonly resolve: (value: JsonRpcMessage) => void;
  readonly reject: (err: Error) => void;
  readonly timer: NodeJS.Timeout;
}

interface TurnWaiter {
  readonly threadId: string;
  readonly turnId: string;
  text: string;
  usage?: LocalUsage;
  completed: boolean;
  completedAt?: number;
  usageUpdatedAt?: number;
  usageGraceTimer?: NodeJS.Timeout;
  onTextDelta?: (delta: string) => void;
  resolve: (value: TurnResult) => void;
  reject: (err: Error) => void;
}

interface ImageTurnWaiter {
  readonly threadId: string;
  readonly turnId: string;
  images: OpenAiGeneratedImage[];
  usage?: LocalUsage;
  completed: boolean;
  completedAt?: number;
  usageUpdatedAt?: number;
  usageGraceTimer?: NodeJS.Timeout;
  onImage?: (image: OpenAiGeneratedImage) => void;
  resolve: (value: ImageTurnResult) => void;
  reject: (err: Error) => void;
}

interface BufferedTurnState {
  textDeltas: string[];
  finalText?: string;
  imageGenerations: OpenAiGeneratedImage[];
  usage?: LocalUsage;
  usageUpdatedAt?: number;
  completed: boolean;
  completedAt?: number;
  error?: Error;
  cleanupTimer?: NodeJS.Timeout;
}

type JsonRpcMessage = Record<string, unknown>;

interface TurnResult {
  readonly text: string;
  readonly usage?: LocalUsage;
  readonly usageWaitMs?: number;
}

interface ImageTurnResult {
  readonly images: readonly OpenAiGeneratedImage[];
  readonly usage?: LocalUsage;
  readonly usageWaitMs?: number;
  readonly timing?: CodexTurnTiming;
}

type CodexReasoningEffort = NormalizedReasoningEffort;
type CodexVerbosity = NormalizedVerbosity;
export type CodexAppServerProxyMode =
  | 'api-isolated'
  | 'omit-personality'
  | 'base-only'
  | 'no-instructions';

export interface CodexIsolation {
  readonly rootDir: string;
  readonly homeDir: string;
  readonly workDir: string;
  readonly defaultModel?: string;
}

interface CodexTurnTimingDraft {
  ensureStartedMs: number;
  promptBuildMs: number;
  threadStartMs: number;
  inputPrepareMs: number;
  turnStartMs: number;
  turnWaitMs: number;
  usageWaitMs: number;
  firstTextDeltaMs?: number;
  firstToolCallDeltaMs?: number;
  firstToolArgumentDeltaMs?: number;
}

interface CodexTurnTiming extends Readonly<CodexTurnTimingDraft> {
  readonly totalMs: number;
}

const USAGE_NOTIFICATION_GRACE_MS = 100;
const BUFFERED_TURN_STATE_TTL_MS = 30_000;
const FALLBACK_CODEX_MODEL = 'gpt-5.5';
const CODEX_APP_SERVER_PROXY_MODES: readonly CodexAppServerProxyMode[] = [
  'api-isolated',
  'omit-personality',
  'base-only',
  'no-instructions',
];
const DISABLED_CODEX_CONTEXT_FEATURES = [
  'apps',
  'browser_use',
  'computer_use',
  'goals',
  'hooks',
  'multi_agent',
  'plugins',
  'shell_tool',
  'workspace_dependencies',
] as const;

export class CodexAppServerBackend implements LocalCliBackend, OpenAiImageGenerationClient {
  readonly name = 'codex-app-server';
  readonly model: string;

  private readonly command: string;
  private readonly cwd: string;
  private readonly configuredModel?: string;
  private readonly honorRequestModel: boolean;
  private readonly timeoutMs: number;
  private readonly reasoningEffort: CodexReasoningEffort;
  private readonly verbosity: CodexVerbosity;
  private readonly imageGeneration: boolean;
  private readonly proxyMode: CodexAppServerProxyMode;
  private readonly onTiming?: (timing: CodexTurnTiming) => void;
  private child: ChildProcessWithoutNullStreams | null = null;
  private lineReader: readline.Interface | null = null;
  private nextId = 1;
  private initialized: Promise<void> | null = null;
  private stderr = '';
  private readonly pending = new Map<number, PendingRequest>();
  private readonly turnWaiters = new Map<string, TurnWaiter>();
  private readonly imageTurnWaiters = new Map<string, ImageTurnWaiter>();
  private readonly bufferedTurnStates = new Map<string, BufferedTurnState>();
  private isolation: CodexIsolation | null = null;

  constructor(options: CodexAppServerBackendOptions) {
    this.command = options.command ?? 'codex';
    this.cwd = options.cwd;
    this.model = options.model ?? 'codex-app-server';
    this.configuredModel = options.model;
    this.honorRequestModel = options.honorRequestModel ?? honorRequestModel();
    this.timeoutMs = options.timeoutMs;
    this.reasoningEffort = options.reasoningEffort ?? codexProxyFallbackReasoningEffort();
    this.verbosity = options.verbosity ?? codexProxyFallbackVerbosity();
    this.imageGeneration = options.imageGeneration ?? false;
    this.proxyMode = options.proxyMode ?? 'api-isolated';
    this.onTiming = options.onTiming;
  }

  generate(
    request: NormalizedRequest,
    signal?: AbortSignal,
  ): Promise<LocalCompletionResult>;
  generate(
    request: OpenAiImageGenerationRequest,
    signal?: AbortSignal,
  ): Promise<OpenAiImageGenerationResult>;
  async generate(
    request: NormalizedRequest | OpenAiImageGenerationRequest,
    signal?: AbortSignal,
  ): Promise<LocalCompletionResult | OpenAiImageGenerationResult> {
    if (isOpenAiImageGenerationRequest(request)) {
      return this.runImageRequest(request, signal);
    }
    return this.runTurn(request, signal);
  }

  stream(
    request: NormalizedRequest,
    signal?: AbortSignal,
  ): AsyncIterable<LocalStreamEvent>;
  stream(
    request: OpenAiImageGenerationRequest,
    signal?: AbortSignal,
  ): AsyncIterable<OpenAiImageGenerationStreamEvent>;
  async *stream(
    request: NormalizedRequest | OpenAiImageGenerationRequest,
    signal?: AbortSignal,
  ): AsyncIterable<LocalStreamEvent | OpenAiImageGenerationStreamEvent> {
    if (isOpenAiImageGenerationRequest(request)) {
      for await (const event of this.streamImageRequest(request, signal)) yield event;
      return;
    }
    const queue = new AsyncQueue<LocalStreamEvent>();
    const forcedTool = forcedSingleToolCall(request);
    const toolExtractor = forcedTool
      ? new KnownToolArgumentsDeltaExtractor(forcedTool.index, forcedTool.id, forcedTool.name)
      : hasToolDecisionSchema(request)
      ? new ToolCallDeltaExtractor()
      : null;
    let firstToolCallDeltaMs: number | undefined;
    let firstToolArgumentDeltaMs: number | undefined;
    const run = this.runTurn(
      request,
      signal,
      (delta, elapsedMs) => {
        if (toolExtractor) {
          for (const event of toolExtractor.push(delta)) {
            if (firstToolCallDeltaMs === undefined) firstToolCallDeltaMs = elapsedMs;
            if (
              event.type === 'tool_call_delta'
              && event.argumentsDelta
              && firstToolArgumentDeltaMs === undefined
            ) {
              firstToolArgumentDeltaMs = elapsedMs;
            }
            queue.push(event);
          }
        } else {
          queue.push({ type: 'text_delta', delta });
        }
      },
      (timing) => {
        if (firstToolCallDeltaMs !== undefined) timing.firstToolCallDeltaMs = firstToolCallDeltaMs;
        if (firstToolArgumentDeltaMs !== undefined) timing.firstToolArgumentDeltaMs = firstToolArgumentDeltaMs;
      },
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

  private async runImageRequest(
    request: OpenAiImageGenerationRequest,
    signal?: AbortSignal,
  ): Promise<OpenAiImageGenerationResult> {
    if (!this.imageGeneration) throw unsupportedImageGenerationError();
    const startedAt = Date.now();
    const images: OpenAiGeneratedImage[] = [];
    let usage: LocalUsage | undefined;
    const emitPerTurnTiming = request.n === 1;
    const results = await Promise.all(
      Array.from(
        { length: request.n },
        (_, index) => this.runSingleImageTurn(request, index, signal, emitPerTurnTiming),
      ),
    );
    for (const result of results) {
      images.push(...result.images);
      usage = mergeUsage(usage, result.usage);
    }
    if (!emitPerTurnTiming) {
      const timings = results.map((result) => result.timing).filter(isCodexTurnTiming);
      if (timings.length > 0) {
        this.onTiming?.(aggregateParallelImageTurnTiming(timings, Date.now() - startedAt));
      }
    }
    return {
      created: Math.floor(Date.now() / 1000),
      images,
      background: request.background,
      outputFormat: request.outputFormat,
      quality: request.quality,
      size: request.size,
      ...(usage ? { usage } : {}),
      latencyMs: Date.now() - startedAt,
    };
  }

  private async *streamImageRequest(
    request: OpenAiImageGenerationRequest,
    signal?: AbortSignal,
  ): AsyncIterable<OpenAiImageGenerationStreamEvent> {
    if (!this.imageGeneration) throw unsupportedImageGenerationError();
    for (let index = 0; index < request.n; index += 1) {
      const result = await this.runSingleImageTurn(request, index, signal);
      for (const image of result.images) {
        yield {
          type: 'completed',
          created: Math.floor(Date.now() / 1000),
          image,
          partialImageIndex: index,
          background: request.background,
          outputFormat: request.outputFormat,
          quality: request.quality,
          size: request.size,
          usage: result.usage,
        };
      }
    }
  }

  private async runSingleImageTurn(
    request: OpenAiImageGenerationRequest,
    imageIndex: number,
    signal?: AbortSignal,
    emitTiming = true,
  ): Promise<ImageTurnResult> {
    const startedAt = Date.now();
    const timing = {
      ensureStartedMs: 0,
      promptBuildMs: 0,
      threadStartMs: 0,
      inputPrepareMs: 0,
      turnStartMs: 0,
      turnWaitMs: 0,
      usageWaitMs: 0,
    };
    let phaseStartedAt = Date.now();
    const reasoningEffort = image2QualityToGpt55ReasoningEffort(request.quality);
    await this.ensureStarted();
    timing.ensureStartedMs = Date.now() - phaseStartedAt;
    phaseStartedAt = Date.now();
    const prompt = buildCodexImageGenerationPrompt(request, imageIndex);
    timing.promptBuildMs = Date.now() - phaseStartedAt;
    const threadStartedAt = Date.now();
    const threadPromise = this.startThread(reasoningEffort, this.verbosity, 'image').then((value) => {
      timing.threadStartMs = Date.now() - threadStartedAt;
      return value;
    });
    const inputStartedAt = Date.now();
    const preparedInputPromise = prepareCodexInput(
      codexImageGenerationInputRequest(request),
      prompt,
    ).then((value) => {
      timing.inputPrepareMs = Date.now() - inputStartedAt;
      return value;
    });
    let threadId: string | null = null;
    let preparedInput: Awaited<ReturnType<typeof prepareCodexInput>> | null = null;
    let turnId: string | null = null;
    const abort = async (): Promise<void> => {
      if (!turnId) return;
      await this.send('turn/interrupt', { threadId, turnId }).catch(() => undefined);
    };
    const onAbort = (): void => {
      void abort();
    };
    if (signal) {
      if (signal.aborted) await abort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    try {
      [threadId, preparedInput] = await Promise.all([threadPromise, preparedInputPromise]);
      const cwd = this.isolation?.workDir ?? this.cwd;
      // Same rule as the text turn: a disconnect during the waits above must
      // not START a turn (the once-listener was a no-op while turnId was null).
      if (signal?.aborted) throw new Error('request aborted');
      phaseStartedAt = Date.now();
      const turn = await this.send('turn/start', {
        threadId,
        cwd,
        runtimeWorkspaceRoots: [cwd],
        environments: [],
        input: preparedInput.input,
        model: this.modelOverrideForCodexImage(),
        effort: reasoningEffort,
        summary: 'none',
        ...turnPersonalityParams(this.proxyMode),
        outputSchema: null,
      });
      timing.turnStartMs = Date.now() - phaseStartedAt;
      turnId = readPath<string>(turn, ['result', 'turn', 'id']);
      if (!turnId) throw new Error('codex app-server did not return a turn id');
      // The once-listener may have been consumed during the round-trip while
      // turnId was null; deliver the interrupt it could not.
      if (signal?.aborted) await abort();
      phaseStartedAt = Date.now();
      const result = await this.waitForImageTurn(threadId, turnId, signal);
      timing.turnWaitMs = Date.now() - phaseStartedAt;
      timing.usageWaitMs = result.usageWaitMs ?? 0;
      if (result.images.length === 0) {
        throw new Error('codex app-server completed image request without an imageGeneration result');
      }
      const completedTiming = {
        ...timing,
        totalMs: Date.now() - startedAt,
      };
      if (emitTiming) this.onTiming?.(completedTiming);
      return { ...result, timing: completedTiming };
    } finally {
      if (signal) signal.removeEventListener('abort', onAbort);
      if (preparedInput) await preparedInput.cleanup();
      else void preparedInputPromise.then((value) => value.cleanup()).catch(() => undefined);
      if (threadId) this.archiveThread(threadId);
    }
  }

  private async runTurn(
    request: NormalizedRequest,
    signal?: AbortSignal,
    onTextDelta?: (delta: string, elapsedMs: number) => void,
    decorateTiming?: (timing: CodexTurnTimingDraft) => void,
  ): Promise<LocalCompletionResult> {
    const startedAt = Date.now();
    const timing: CodexTurnTimingDraft = {
      ensureStartedMs: 0,
      promptBuildMs: 0,
      threadStartMs: 0,
      inputPrepareMs: 0,
      turnStartMs: 0,
      turnWaitMs: 0,
      usageWaitMs: 0,
    };
    const observedTextDelta = (delta: string): void => {
      const elapsedMs = Date.now() - startedAt;
      if (timing.firstTextDeltaMs === undefined) timing.firstTextDeltaMs = elapsedMs;
      onTextDelta?.(delta, elapsedMs);
    };
    let phaseStartedAt = Date.now();
    await this.ensureStarted();
    timing.ensureStartedMs = Date.now() - phaseStartedAt;
    phaseStartedAt = Date.now();
    const reasoningEffort = request.reasoningEffort ?? this.reasoningEffort;
    const verbosity = request.verbosity ?? this.verbosity;
    const splitInstructions = shouldSplitRequestInstructions(this.proxyMode);
    const prompt = buildPrompt(request, {
      includeInstructionMessages: !splitInstructions,
    });
    const apiRequestInstructions = splitInstructions
      ? requestInstructionText(request)
      : '';
    timing.promptBuildMs = Date.now() - phaseStartedAt;
    const threadStartedAt = Date.now();
    const threadPromise = this.startThread(reasoningEffort, verbosity, 'text', apiRequestInstructions).then((value) => {
      timing.threadStartMs = Date.now() - threadStartedAt;
      return value;
    });
    let threadId: string | null = null;
    let preparedInput: Awaited<ReturnType<typeof prepareCodexInput>> | null = null;
    const inputStartedAt = Date.now();
    const preparedInputPromise = prepareCodexInput(request, prompt).then((value) => {
      preparedInput = value;
      timing.inputPrepareMs = Date.now() - inputStartedAt;
      return value;
    });
    let turnId: string | null = null;
    const abort = async (): Promise<void> => {
      if (!turnId) return;
      await this.send('turn/interrupt', { threadId, turnId }).catch(() => undefined);
    };
    const onAbort = (): void => {
      void abort();
    };
    if (signal) {
      if (signal.aborted) await abort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    try {
      [threadId, preparedInput] = await Promise.all([threadPromise, preparedInputPromise]);
      const cwd = this.isolation?.workDir ?? this.cwd;
      const modelOverride = await this.modelOverrideFor(request, signal);
      // The abort listener is once-only and a no-op while turnId is null, and
      // an aborted catalogue lookup deliberately fails open — so a client that
      // disconnected during the waits above would otherwise still START a
      // turn nobody is waiting for.
      if (signal?.aborted) throw new Error('request aborted');
      phaseStartedAt = Date.now();
      const turn = await this.send('turn/start', {
        threadId,
        cwd,
        runtimeWorkspaceRoots: [cwd],
        environments: [],
        input: preparedInput.input,
        model: modelOverride,
        effort: reasoningEffort,
        summary: 'none',
        ...turnPersonalityParams(this.proxyMode),
        outputSchema: outputSchemaFor(request),
      });
      timing.turnStartMs = Date.now() - phaseStartedAt;
      turnId = readPath<string>(turn, ['result', 'turn', 'id']);
      if (!turnId) throw new Error('codex app-server did not return a turn id');
      // The abort may have fired during the turn/start round-trip, consuming
      // the once-listener while turnId was still null. Now that the id exists,
      // deliver the interrupt it could not.
      if (signal?.aborted) await abort();
      phaseStartedAt = Date.now();
      const turnResult = await this.waitForTurn(threadId, turnId, signal, observedTextDelta);
      timing.turnWaitMs = Date.now() - phaseStartedAt;
      timing.usageWaitMs = turnResult.usageWaitMs ?? 0;
      const parsed = parseBackendOutput(request, turnResult.text);
      const usage = turnResult.usage ?? usageFor(request, parsed.text, parsed.toolCalls);
      const totalMs = Date.now() - startedAt;
      decorateTiming?.(timing);
      this.onTiming?.({
        ...timing,
        totalMs,
      });
      return {
        id: `local_${randomUUID()}`,
        model: request.model,
        text: parsed.text,
        toolCalls: parsed.toolCalls,
        usage,
        latencyMs: totalMs,
      };
    } finally {
      if (signal) signal.removeEventListener('abort', onAbort);
      if (preparedInput) await preparedInput.cleanup();
      else void preparedInputPromise.then((value) => value.cleanup()).catch(() => undefined);
      if (threadId) this.archiveThread(threadId);
    }
  }

  async close(): Promise<void> {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('codex app-server backend closed'));
    }
    this.pending.clear();
    for (const waiter of this.turnWaiters.values()) {
      waiter.reject(new Error('codex app-server backend closed'));
    }
    this.turnWaiters.clear();
    for (const waiter of this.imageTurnWaiters.values()) {
      waiter.reject(new Error('codex app-server backend closed'));
    }
    this.imageTurnWaiters.clear();
    this.clearBufferedTurnStates();
    this.lineReader?.close();
    this.child?.kill('SIGTERM');
    this.child = null;
    this.lineReader = null;
    this.initialized = null;
    await this.cleanupIsolation();
  }

  private async ensureStarted(): Promise<void> {
    if (this.initialized) return this.initialized;
    this.initialized = this.start();
    return this.initialized;
  }

  private async start(): Promise<void> {
    const isolation = await createCodexIsolation({
      configuredModel: this.configuredModel,
      reasoningEffort: this.reasoningEffort,
      verbosity: this.verbosity,
      imageGeneration: this.imageGeneration,
    });
    this.isolation = isolation;
    const appServerArgs = [
      'app-server',
      ...codexContextIsolationArgs({
        model: this.configuredModel ?? isolation.defaultModel ?? FALLBACK_CODEX_MODEL,
        reasoningEffort: this.reasoningEffort,
        verbosity: this.verbosity,
        imageGeneration: this.imageGeneration,
      }),
      '--listen',
      'stdio://',
    ];
    this.child = spawn(this.command, appServerArgs, {
      cwd: isolation.workDir,
      shell: false,
      env: proxyChildProcessEnv({
        CODEX_HOME: isolation.homeDir,
      }),
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-12_000);
    });
    this.child.on('error', (err) => this.failAll(err));
    this.child.on('close', (code, signal) => {
      this.failAll(new Error(`codex app-server exited: code=${code ?? 'null'} signal=${signal ?? 'null'}`));
      this.child = null;
      this.lineReader = null;
      this.initialized = null;
      void this.cleanupIsolation();
    });

    this.lineReader = readline.createInterface({ input: this.child.stdout });
    this.lineReader.on('line', (line) => this.handleLine(line));

    await this.send('initialize', {
      clientInfo: {
        name: 'local_oauth_cli_proxy',
        title: 'Local OAuth CLI Proxy',
        version: '0.1.0',
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
        optOutNotificationMethods: [],
      },
    });
    this.notify('initialized', {});
  }

  private async startThread(
    reasoningEffort: CodexReasoningEffort,
    verbosity: CodexVerbosity,
    mode: 'text' | 'image' = 'text',
    apiRequestInstructions = '',
  ): Promise<string> {
    const cwd = this.isolation?.workDir ?? this.cwd;
    // Only fields the app-server protocol declares for `thread/start` are sent.
    // The server ignores unknown params silently, so an undeclared field would
    // read as configuration that is doing work when it is not. The declared set
    // is the one from `generate-json-schema --experimental`, because the client
    // opts into the experimental API during `initialize`; several of these
    // fields exist only in that mode.
    const thread = await this.send('thread/start', {
      cwd,
      runtimeWorkspaceRoots: [cwd],
      approvalPolicy: 'never',
      sandbox: 'read-only',
      environments: [],
      dynamicTools: [],
      ephemeral: true,
      ...threadInstructionParams(this.proxyMode, mode, apiRequestInstructions),
      ...threadPersonalityParams(this.proxyMode),
      experimentalRawEvents: false,
      config: {
        model_reasoning_effort: reasoningEffort,
        model_reasoning_summary: 'none',
        model_verbosity: verbosity,
        web_search: 'disabled',
      },
    });
    const threadId = readPath<string>(thread, ['result', 'thread', 'id']);
    if (!threadId) throw new Error('codex app-server did not return a thread id');
    return threadId;
  }

  private archiveThread(threadId: string): void {
    void this.send('thread/archive', { threadId }).catch(() => undefined);
  }

  private async cleanupIsolation(): Promise<void> {
    const isolation = this.isolation;
    this.isolation = null;
    if (isolation) {
      await rm(isolation.rootDir, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 100,
      });
    }
  }

  private send(method: string, params: unknown): Promise<JsonRpcMessage> {
    if (!this.child) {
      return Promise.reject(new Error('codex app-server is not running'));
    }
    const id = this.nextId;
    this.nextId += 1;
    const payload = JSON.stringify({ method, id, params });
    this.child.stdin.write(`${payload}\n`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
    });
  }

  private notify(method: string, params: unknown): void {
    this.child?.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  private handleLine(line: string): void {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      return;
    }

    const id = typeof message.id === 'number' ? message.id : null;
    if (id !== null && this.pending.has(id)) {
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(new Error(`${pending.method} failed: ${JSON.stringify(message.error)}`));
      } else {
        pending.resolve(message);
      }
      return;
    }

    if (id !== null && typeof message.method === 'string') {
      this.respondToServerRequest(id, message.method);
      return;
    }

    if (typeof message.method === 'string') {
      this.handleNotification(message.method, message.params);
    }
  }

  private respondToServerRequest(id: number, method: string): void {
    const result = method.includes('requestApproval')
      ? { decision: 'decline' }
      : undefined;
    this.child?.stdin.write(`${JSON.stringify({
      id,
      ...(result
        ? { result }
        : { error: { code: -32601, message: `Unsupported server request: ${method}` } }),
    })}\n`);
  }

  private handleNotification(method: string, params: unknown): void {
    const data = asRecord(params);
    if (!data) return;
    if (method === 'item/agentMessage/delta') {
      const key = turnStateKey(data.threadId, data.turnId);
      if (!key || typeof data.delta !== 'string') return;
      const delta = data.delta;
      const waiter = this.turnWaiters.get(key);
      if (waiter) this.appendTextDelta(waiter, delta);
      else this.bufferTurnState(key, (state) => state.textDeltas.push(delta));
      return;
    }
    if (method === 'item/completed') {
      const key = turnStateKey(data.threadId, data.turnId);
      if (!key) return;
      const waiter = this.turnWaiters.get(key);
      const item = asRecord(data.item);
      const image = imageGenerationFromThreadItem(item);
      if (image) {
        const imageWaiter = this.imageTurnWaiters.get(key);
        if (imageWaiter) this.appendImageGeneration(imageWaiter, image);
        else this.bufferTurnState(key, (state) => {
          state.imageGenerations.push(image);
        });
        return;
      }
      if (waiter && item?.type === 'agentMessage' && typeof item.text === 'string') {
        waiter.text = item.text;
      } else if (item?.type === 'agentMessage' && typeof item.text === 'string') {
        this.bufferTurnState(key, (state) => {
          state.finalText = item.text as string;
        });
      }
      return;
    }
    if (method === 'thread/tokenUsage/updated') {
      const threadId = typeof data.threadId === 'string' ? data.threadId : null;
      const turnId = typeof data.turnId === 'string' ? data.turnId : null;
      if (!threadId || !turnId) return;
      const usage = usageFromCodexTokenUsage(data.tokenUsage);
      const key = `${threadId}:${turnId}`;
      const waiter = usage ? this.turnWaiters.get(key) : null;
      if (waiter && usage) {
        waiter.usage = usage;
        waiter.usageUpdatedAt = Date.now();
        if (waiter.completed) this.resolveTurnWaiter(threadId, turnId);
      }
      const imageWaiter = usage ? this.imageTurnWaiters.get(key) : null;
      if (imageWaiter && usage) {
        imageWaiter.usage = usage;
        imageWaiter.usageUpdatedAt = Date.now();
        if (imageWaiter.completed) this.resolveImageTurnWaiter(threadId, turnId);
      } else if (usage && !waiter) {
        this.bufferTurnState(key, (state) => {
          state.usage = usage;
          state.usageUpdatedAt = Date.now();
        });
      }
      return;
    }
    if (method === 'turn/completed') {
      const threadId = typeof data.threadId === 'string' ? data.threadId : null;
      const turn = asRecord(data.turn);
      const turnId = typeof turn?.id === 'string' ? turn.id : null;
      if (!threadId || !turnId) return;
      const key = `${threadId}:${turnId}`;
      const waiter = this.turnWaiters.get(key);
      const imageWaiter = this.imageTurnWaiters.get(key);
      if (!waiter) {
        if (!imageWaiter) {
          this.bufferTurnState(key, (state) => {
            if (turn?.status === 'failed') {
              state.error = new Error(JSON.stringify(turn.error ?? 'turn failed'));
            } else {
              state.completed = true;
              state.completedAt = Date.now();
            }
          });
          return;
        }
      }
      if (imageWaiter) {
        if (turn?.status === 'failed') {
          this.imageTurnWaiters.delete(key);
          imageWaiter.reject(new Error(JSON.stringify(turn.error ?? 'turn failed')));
        } else {
          this.markImageWaiterCompleted(threadId, turnId, imageWaiter, Date.now());
        }
        if (!waiter) return;
      }
      if (!waiter) return;
      if (turn?.status === 'failed') {
        this.turnWaiters.delete(key);
        waiter.reject(new Error(JSON.stringify(turn.error ?? 'turn failed')));
      } else {
        this.markWaiterCompleted(threadId, turnId, waiter, Date.now());
      }
    }
  }

  private appendTextDelta(waiter: TurnWaiter, delta: string): void {
    waiter.text += delta;
    waiter.onTextDelta?.(delta);
  }

  private appendImageGeneration(
    waiter: ImageTurnWaiter,
    image: OpenAiGeneratedImage,
  ): void {
    waiter.images.push(image);
    waiter.onImage?.(image);
  }

  private markWaiterCompleted(
    threadId: string,
    turnId: string,
    waiter: TurnWaiter,
    completedAt: number,
  ): void {
    waiter.completed = true;
    waiter.completedAt = completedAt;
    if (waiter.usage) this.resolveTurnWaiter(threadId, turnId);
    else {
      waiter.usageGraceTimer = setTimeout(
        () => this.resolveTurnWaiter(threadId, turnId),
        USAGE_NOTIFICATION_GRACE_MS,
      );
    }
  }

  private markImageWaiterCompleted(
    threadId: string,
    turnId: string,
    waiter: ImageTurnWaiter,
    completedAt: number,
  ): void {
    waiter.completed = true;
    waiter.completedAt = completedAt;
    if (waiter.usage || waiter.images.length > 0) {
      this.resolveImageTurnWaiter(threadId, turnId);
    } else {
      waiter.usageGraceTimer = setTimeout(
        () => this.resolveImageTurnWaiter(threadId, turnId),
        USAGE_NOTIFICATION_GRACE_MS,
      );
    }
  }

  private resolveTurnWaiter(threadId: string, turnId: string): void {
    const key = `${threadId}:${turnId}`;
    const waiter = this.turnWaiters.get(key);
    if (!waiter) return;
    this.turnWaiters.delete(key);
    if (waiter.usageGraceTimer) {
      clearTimeout(waiter.usageGraceTimer);
      waiter.usageGraceTimer = undefined;
    }
    waiter.resolve({
      text: waiter.text.trim(),
      usage: waiter.usage,
      usageWaitMs: waiter.completedAt
        ? Math.max(0, (waiter.usageUpdatedAt ?? Date.now()) - waiter.completedAt)
        : 0,
    });
  }

  private resolveImageTurnWaiter(threadId: string, turnId: string): void {
    const key = `${threadId}:${turnId}`;
    const waiter = this.imageTurnWaiters.get(key);
    if (!waiter) return;
    this.imageTurnWaiters.delete(key);
    if (waiter.usageGraceTimer) {
      clearTimeout(waiter.usageGraceTimer);
      waiter.usageGraceTimer = undefined;
    }
    waiter.resolve({
      images: waiter.images,
      usage: waiter.usage,
      usageWaitMs: waiter.completedAt
        ? Math.max(0, (waiter.usageUpdatedAt ?? Date.now()) - waiter.completedAt)
        : 0,
    });
  }

  private waitForImageTurn(
    threadId: string,
    turnId: string,
    signal?: AbortSignal,
    onImage?: (image: OpenAiGeneratedImage) => void,
  ): Promise<ImageTurnResult> {
    const key = `${threadId}:${turnId}`;
    return new Promise((resolve, reject) => {
      let waiter: ImageTurnWaiter | undefined;
      const timer = setTimeout(() => {
        this.imageTurnWaiters.delete(key);
        cleanup();
        reject(new Error(`image turn timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      const cleanup = (): void => {
        clearTimeout(timer);
        if (waiter?.usageGraceTimer) {
          clearTimeout(waiter.usageGraceTimer);
          waiter.usageGraceTimer = undefined;
        }
        if (signal) signal.removeEventListener('abort', abortFromSignal);
      };
      const abortFromSignal = (): void => {
        this.imageTurnWaiters.delete(key);
        cleanup();
        reject(new Error('request aborted'));
      };
      waiter = {
        threadId,
        turnId,
        images: [],
        completed: false,
        onImage,
        resolve: (value) => {
          cleanup();
          resolve(value);
        },
        reject: (err) => {
          cleanup();
          reject(err);
        },
      };
      this.imageTurnWaiters.set(key, waiter);
      if (signal) {
        if (signal.aborted) {
          abortFromSignal();
          return;
        }
        signal.addEventListener('abort', abortFromSignal, { once: true });
      }
      const buffered = this.takeBufferedTurnState(key);
      if (buffered) {
        waiter.images = [...buffered.imageGenerations];
        waiter.usage = buffered.usage;
        waiter.usageUpdatedAt = buffered.usageUpdatedAt;
        for (const image of buffered.imageGenerations) waiter.onImage?.(image);
        if (buffered.error) {
          this.imageTurnWaiters.delete(key);
          cleanup();
          reject(buffered.error);
          return;
        }
        if (buffered.completed) {
          this.markImageWaiterCompleted(
            threadId,
            turnId,
            waiter,
            buffered.completedAt ?? Date.now(),
          );
        }
      }
    });
  }

  private waitForTurn(
    threadId: string,
    turnId: string,
    signal?: AbortSignal,
    onTextDelta?: (delta: string) => void,
  ): Promise<TurnResult> {
    const key = `${threadId}:${turnId}`;
    return new Promise((resolve, reject) => {
      let waiter: TurnWaiter | undefined;
      const timer = setTimeout(() => {
        this.turnWaiters.delete(key);
        cleanup();
        reject(new Error(`turn timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      const cleanup = (): void => {
        clearTimeout(timer);
        if (waiter?.usageGraceTimer) {
          clearTimeout(waiter.usageGraceTimer);
          waiter.usageGraceTimer = undefined;
        }
        if (signal) signal.removeEventListener('abort', abortFromSignal);
      };
      const abortFromSignal = (): void => {
        this.turnWaiters.delete(key);
        cleanup();
        reject(new Error('request aborted'));
      };
      waiter = {
        threadId,
        turnId,
        text: '',
        completed: false,
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
      this.turnWaiters.set(key, waiter);
      if (signal) {
        if (signal.aborted) {
          abortFromSignal();
          return;
        }
        signal.addEventListener('abort', abortFromSignal, { once: true });
      }
      const buffered = this.takeBufferedTurnState(key);
      if (buffered) {
        const bufferedText = buffered.finalText ?? buffered.textDeltas.join('');
        waiter.text = bufferedText;
        waiter.usage = buffered.usage;
        waiter.usageUpdatedAt = buffered.usageUpdatedAt;
        if (buffered.textDeltas.length > 0) {
          for (const delta of buffered.textDeltas) waiter.onTextDelta?.(delta);
        } else if (buffered.finalText) {
          waiter.onTextDelta?.(buffered.finalText);
        }
        if (buffered.error) {
          this.turnWaiters.delete(key);
          cleanup();
          reject(buffered.error);
          return;
        }
        if (buffered.completed) {
          this.markWaiterCompleted(
            threadId,
            turnId,
            waiter,
            buffered.completedAt ?? Date.now(),
          );
        }
      }
    });
  }

  private failAll(err: Error): void {
    const detail = this.stderr ? `\n${this.stderr.slice(-2000)}` : '';
    const wrapped = new Error(`${err.message}${detail}`);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(wrapped);
    }
    this.pending.clear();
    for (const waiter of this.turnWaiters.values()) waiter.reject(wrapped);
    this.turnWaiters.clear();
    for (const waiter of this.imageTurnWaiters.values()) waiter.reject(wrapped);
    this.imageTurnWaiters.clear();
    this.clearBufferedTurnStates();
  }

  /**
   * Resolves which model the turn runs on. With `modelSelection.honorRequestModel`
   * off this keeps the historical precedence — a configured model always wins and
   * the request model is only a fallback. With it on the request wins and the
   * configured model becomes the default for requests that name none.
   */
  /** The Codex catalogue, so new model generations appear without a code change. */
  async availableModels(): Promise<readonly string[] | null> {
    const models = await codexModels({
      command: this.command,
      codexHome: this.isolation?.homeDir,
      cwd: this.isolation?.workDir ?? this.cwd,
      commandCwd: this.cwd,
    });
    return models?.map((entry) => entry.slug) ?? null;
  }

  async resolvedModel(request: NormalizedRequest): Promise<string | null> {
    const requested = this.explicitRequestModel(request.model);
    if (this.honorRequestModel) return requested ?? this.configuredModel ?? null;
    return this.configuredModel ?? requested ?? null;
  }

  private async modelOverrideFor(
    request: NormalizedRequest,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    const requested = this.explicitRequestModel(request.model);
    if (this.honorRequestModel) {
      // Resolve first, then validate what will actually run — including the
      // configured model when the request names none. `undefined` means no model
      // is named at all and the CLI's own default applies, so there is nothing to
      // check against the catalogue.
      const effective = requested ?? this.configuredModel;
      if (effective) {
        await this.assertModelSupported(effective, request, requested !== undefined, signal);
      }
      return effective;
    }
    if (this.configuredModel) return this.configuredModel;
    return requested;
  }

  /**
   * The request model, or undefined when it carries no model choice — which over
   * HTTP no longer happens: normalization rejects an absent or empty `model`, so
   * only an internal caller can reach the undefined branch. The backend's own
   * identifier (`codex-app-server`) is a model name like any other here — never
   * a sentinel meaning "no model chosen". Whether it is then checked against the
   * catalogue depends on honouring mode, as for any other model: on, it is; off,
   * `modelOverrideFor` validates nothing at all.
   *
   * A request naming the same model as the configured one is still a choice, not
   * an omission — otherwise it would skip validation and keep running a model the
   * served catalogue has since dropped.
   */
  private explicitRequestModel(requestModel: string): string | undefined {
    return requestModel || undefined;
  }

  private async assertModelSupported(
    model: string,
    request: NormalizedRequest,
    fromRequest: boolean,
    signal?: AbortSignal,
  ): Promise<void> {
    await assertCodexModelSupported(model, request.shape, {
      command: this.command,
      codexHome: this.isolation?.homeDir,
      // The same workspace the app-server turn runs in, so the lookup sees the
      // configuration the turn will actually use.
      cwd: this.isolation?.workDir ?? this.cwd,
      commandCwd: this.cwd,
      signal,
    }, fromRequest);
  }

  private modelOverrideForCodexImage(): string | undefined {
    return this.configuredModel;
  }

  private bufferTurnState(key: string, apply: (state: BufferedTurnState) => void): void {
    const state = this.bufferedTurnStates.get(key) ?? {
      textDeltas: [],
      imageGenerations: [],
      completed: false,
    };
    if (state.cleanupTimer) clearTimeout(state.cleanupTimer);
    apply(state);
    state.cleanupTimer = setTimeout(() => {
      this.bufferedTurnStates.delete(key);
    }, BUFFERED_TURN_STATE_TTL_MS);
    this.bufferedTurnStates.set(key, state);
  }

  private takeBufferedTurnState(key: string): BufferedTurnState | undefined {
    const state = this.bufferedTurnStates.get(key);
    if (!state) return undefined;
    this.bufferedTurnStates.delete(key);
    if (state.cleanupTimer) {
      clearTimeout(state.cleanupTimer);
      state.cleanupTimer = undefined;
    }
    return state;
  }

  private clearBufferedTurnStates(): void {
    for (const state of this.bufferedTurnStates.values()) {
      if (state.cleanupTimer) clearTimeout(state.cleanupTimer);
    }
    this.bufferedTurnStates.clear();
  }
}

export function isCodexAppServerProxyMode(value: unknown): value is CodexAppServerProxyMode {
  return typeof value === 'string'
    && CODEX_APP_SERVER_PROXY_MODES.includes(value as CodexAppServerProxyMode);
}

function threadInstructionParams(
  proxyMode: CodexAppServerProxyMode,
  mode: 'text' | 'image',
  apiRequestInstructions = '',
): Record<string, string> {
  if (proxyMode === 'no-instructions') return {};
  const base = mode === 'image' ? imageGenerationBaseInstructions() : baseInstructions();
  if (proxyMode === 'base-only') return { baseInstructions: base };
  const developer = mode === 'image'
    ? imageGenerationDeveloperInstructions()
    : developerInstructions();
  return {
    baseInstructions: base,
    developerInstructions: [developer, apiRequestInstructions].filter(Boolean).join('\n\n'),
  };
}

function shouldSplitRequestInstructions(proxyMode: CodexAppServerProxyMode): boolean {
  return proxyMode === 'api-isolated' || proxyMode === 'omit-personality';
}

function threadPersonalityParams(
  proxyMode: CodexAppServerProxyMode,
): Record<string, string> {
  return proxyMode === 'omit-personality' ? {} : { personality: 'none' };
}

function turnPersonalityParams(
  proxyMode: CodexAppServerProxyMode,
): Record<string, string> {
  return proxyMode === 'omit-personality' ? {} : { personality: 'none' };
}

function isOpenAiImageGenerationRequest(
  request: NormalizedRequest | OpenAiImageGenerationRequest,
): request is OpenAiImageGenerationRequest {
  return 'operation' in request && (
    request.operation === 'generation'
    || request.operation === 'edit'
    || request.operation === 'variation'
  );
}

function unsupportedImageGenerationError(): ProxyRequestError {
  return new ProxyRequestError(
    'Images API proxy does not have a Codex image-generation client enabled.',
    501,
    'openai',
    'unsupported_feature',
  );
}

function isCodexTurnTiming(value: CodexTurnTiming | undefined): value is CodexTurnTiming {
  return Boolean(value);
}

function aggregateParallelImageTurnTiming(
  timings: readonly CodexTurnTiming[],
  totalMs: number,
): CodexTurnTiming {
  const maxPhase = (key: keyof CodexTurnTimingDraft): number => Math.max(
    ...timings
      .map((timing) => timing[key])
      .filter((value): value is number => Number.isFinite(value)),
    0,
  );
  return {
    ensureStartedMs: maxPhase('ensureStartedMs'),
    promptBuildMs: maxPhase('promptBuildMs'),
    threadStartMs: maxPhase('threadStartMs'),
    inputPrepareMs: maxPhase('inputPrepareMs'),
    turnStartMs: maxPhase('turnStartMs'),
    turnWaitMs: maxPhase('turnWaitMs'),
    usageWaitMs: maxPhase('usageWaitMs'),
    totalMs,
  };
}

function imageGenerationBaseInstructions(): string {
  return 'API proxy image generation only. Ignore host context, files, tools other than image generation, memory, browsing, and git.';
}

function imageGenerationDeveloperInstructions(): string {
  return [
    'Use the image generation capability for the requested visual output.',
    'Do not answer with text only.',
    'Preserve the user prompt as visual intent.',
    'Use attached images only as source/reference/mask material described in the request.',
    'Do not call direct provider APIs or external network APIs.',
  ].join(' ');
}

function buildCodexImageGenerationPrompt(
  request: OpenAiImageGenerationRequest,
  imageIndex: number,
): string {
  const attachmentNote = imageAttachmentNote(request);
  const countNote = request.n > 1
    ? `Generate image ${imageIndex + 1} of ${request.n} for the same Images API request.`
    : 'Generate exactly one image for this Images API request.';
  return [
    countNote,
    `Images API operation: ${request.operation}.`,
    'Use the image generation capability now; the final turn must include an imageGeneration result.',
    attachmentNote,
    image2ViaGpt55PromptFromRequest(request),
  ].filter(Boolean).join('\n\n');
}

function imageAttachmentNote(request: OpenAiImageGenerationRequest): string {
  const notes: string[] = [];
  if (request.images.length > 0) {
    notes.push(`Attached images 1-${request.images.length} are source/reference images for the ${request.operation} request.`);
  }
  if (request.mask) {
    notes.push(`Attached image ${request.images.length + 1} is the edit mask.`);
  }
  return notes.join(' ');
}

function codexImageGenerationInputRequest(
  request: OpenAiImageGenerationRequest,
): NormalizedRequest {
  return {
    shape: 'openai-responses',
    model: 'codex-app-server',
    messages: [{
      role: 'user',
      content: '',
      images: [
        ...request.images,
        ...(request.mask ? [request.mask] : []),
      ],
    }],
    stream: false,
    streamOptions: { includeUsage: false, includeObfuscation: false },
    jsonMode: false,
    tools: [],
    toolChoice: { type: 'auto' },
    raw: request.raw,
  };
}

function imageGenerationFromThreadItem(
  item: Record<string, unknown> | null,
): OpenAiGeneratedImage | null {
  if (item?.type !== 'imageGeneration') return null;
  if (typeof item.result !== 'string' || !item.result.trim()) return null;
  return {
    b64Json: item.result,
    ...(typeof item.revisedPrompt === 'string' && item.revisedPrompt.trim()
      ? { revisedPrompt: item.revisedPrompt }
      : {}),
  };
}

/** Sums a token field only when at least one side reported it. */
function optionalSum(
  field: 'cacheCreationInputTokens' | 'cacheReadInputTokens',
  left: LocalUsage,
  right: LocalUsage,
): Partial<LocalUsage> {
  if (left[field] === undefined && right[field] === undefined) return {};
  return { [field]: (left[field] ?? 0) + (right[field] ?? 0) };
}

function mergeUsage(
  current: LocalUsage | undefined,
  next: LocalUsage | undefined,
): LocalUsage | undefined {
  if (!current) return next;
  if (!next) return current;
  return {
    inputTokens: current.inputTokens + next.inputTokens,
    outputTokens: current.outputTokens + next.outputTokens,
    totalTokens: (current.totalTokens ?? 0) + (next.totalTokens ?? 0),
    cachedInputTokens: (current.cachedInputTokens ?? 0) + (next.cachedInputTokens ?? 0),
    // Summed only where one side reported them: `?? 0` turned two silent
    // halves into a reported zero, which downstream reads as "this runtime
    // reports caching and got none" — a different claim from "it does not say".
    ...optionalSum('cacheCreationInputTokens', current, next),
    ...optionalSum('cacheReadInputTokens', current, next),
    reasoningOutputTokens: (current.reasoningOutputTokens ?? 0) + (next.reasoningOutputTokens ?? 0),
    source: current.source === 'provider' && next.source === 'provider' ? 'provider' : 'estimated',
    raw: [current.raw, next.raw].filter(Boolean),
  };
}

function turnStateKey(threadId: unknown, turnId: unknown): string | null {
  return typeof threadId === 'string' && typeof turnId === 'string'
    ? `${threadId}:${turnId}`
    : null;
}

function readPath<T>(value: unknown, path: readonly string[]): T | null {
  let current = value;
  for (const part of path) {
    const obj = asRecord(current);
    if (!obj) return null;
    current = obj[part];
  }
  return current as T;
}

export function usageFromCodexTokenUsage(value: unknown): LocalUsage | null {
  const usage = asRecord(value);
  const last = asRecord(usage?.last);
  if (!last) return null;
  const totalTokens = readNumber(last.totalTokens);
  const inputTokens = readNumber(last.inputTokens);
  const outputTokens = readNumber(last.outputTokens);
  const cachedInputTokens = readNumber(last.cachedInputTokens);
  const reasoningOutputTokens = readNumber(last.reasoningOutputTokens);
  if (
    totalTokens === 0
    && inputTokens === 0
    && outputTokens === 0
    && cachedInputTokens === 0
    && reasoningOutputTokens === 0
  ) {
    return null;
  }
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    cachedInputTokens,
    reasoningOutputTokens,
    source: 'provider',
    raw: value,
  };
}

export function codexContextIsolationArgs(options: {
  readonly model: string;
  readonly reasoningEffort: CodexReasoningEffort;
  readonly verbosity: CodexVerbosity;
  readonly imageGeneration?: boolean;
}): string[] {
  return [
    '-c',
    `model=${tomlString(options.model)}`,
    '-c',
    `model_reasoning_effort=${tomlString(options.reasoningEffort)}`,
    '-c',
    'model_reasoning_summary="none"',
    '-c',
    `model_verbosity=${tomlString(options.verbosity)}`,
    '-c',
    'web_search="disabled"',
    '-c',
    'approval_policy="never"',
    '-c',
    'sandbox_mode="read-only"',
    '-c',
    'shell_environment_policy.inherit="none"',
    ...DISABLED_CODEX_CONTEXT_FEATURES.flatMap((feature) => [
      '-c',
      `features.${feature}=false`,
    ]),
    '-c',
    `features.image_generation=${options.imageGeneration ? 'true' : 'false'}`,
    '-c',
    'notify=[]',
    '-c',
    'analytics.enabled=false',
  ];
}

export async function createCodexIsolation(options: {
  readonly configuredModel?: string;
  readonly reasoningEffort: CodexReasoningEffort;
  readonly verbosity: CodexVerbosity;
  readonly imageGeneration?: boolean;
}): Promise<CodexIsolation> {
  const rootDir = await mkdtemp(join(tmpdir(), 'local-oauth-cli-codex-proxy-'));
  const homeDir = join(rootDir, 'codex-home');
  const workDir = join(rootDir, 'workspace');
  await Promise.all([
    mkdir(homeDir, { recursive: true }),
    mkdir(workDir, { recursive: true }),
  ]);

  const sourceHome = sourceCodexHome();
  const defaultModel = options.configuredModel ?? await readTopLevelStringConfig(sourceHome, 'model');
  await copyCodexAuth(sourceHome, homeDir);
  await writeFile(
    join(homeDir, 'config.toml'),
    minimalCodexConfigToml({
      model: defaultModel ?? FALLBACK_CODEX_MODEL,
      reasoningEffort: options.reasoningEffort,
      verbosity: options.verbosity,
      imageGeneration: options.imageGeneration,
    }),
    { mode: 0o600 },
  );

  return {
    rootDir,
    homeDir,
    workDir,
    defaultModel,
  };
}

export function minimalCodexConfigToml(options: {
  readonly model: string;
  readonly reasoningEffort: CodexReasoningEffort;
  readonly verbosity: CodexVerbosity;
  readonly imageGeneration?: boolean;
}): string {
  return [
    `model = ${tomlString(options.model)}`,
    `model_reasoning_effort = ${tomlString(options.reasoningEffort)}`,
    'model_reasoning_summary = "none"',
    `model_verbosity = ${tomlString(options.verbosity)}`,
    'web_search = "disabled"',
    'approval_policy = "never"',
    'sandbox_mode = "read-only"',
    '',
    '[analytics]',
    'enabled = false',
    '',
    '[features]',
    ...DISABLED_CODEX_CONTEXT_FEATURES.map((feature) => `${feature} = false`),
    `image_generation = ${options.imageGeneration ? 'true' : 'false'}`,
    '',
    '[shell_environment_policy]',
    'inherit = "none"',
    '',
  ].join('\n');
}

async function copyCodexAuth(sourceHome: string, targetHome: string): Promise<void> {
  try {
    await copyFile(join(sourceHome, 'auth.json'), join(targetHome, 'auth.json'));
  } catch {
    // Let Codex surface its normal auth error if the user has no local auth state.
  }
}

async function readTopLevelStringConfig(sourceHome: string, key: string): Promise<string | undefined> {
  let text: string;
  try {
    text = await readFile(join(sourceHome, 'config.toml'), 'utf8');
  } catch {
    return undefined;
  }
  const match = new RegExp(`^${escapeRegExp(key)}\\s*=\\s*"([^"\\\\]*(?:\\\\.[^"\\\\]*)*)"\\s*$`, 'm').exec(text);
  if (!match?.[1]) return undefined;
  return match[1].replace(/\\(["\\])/g, '$1');
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
