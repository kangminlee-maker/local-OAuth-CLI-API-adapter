import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { compileComponentCode } from '@ggui-ai/ui-gen';
import type { UiGenerateInput } from '@ggui-ai/mcp-server';
import {
  buildTaskPrompt,
  createGenerationWorkspace,
  type GenerationWorkspace,
} from './workspace.js';
import type { CliGeneratorOptions } from './types.js';

export interface CliApiOptions {
  readonly runtime: CliGeneratorOptions['runtime'];
  readonly timeoutMs: number;
  readonly maxAttempts: number;
  readonly keepWorkspace: boolean;
  readonly workspaceRoot?: string;
  readonly earlyReturnOnCompile: boolean;
  readonly earlyReturnStableMs: number;
}

export type CliApiGenerateResult =
  | {
      readonly ok: true;
      readonly id: string;
      readonly sourceCode: string;
      readonly componentCode: string;
      readonly warnings: readonly string[];
      readonly latencyMs: number;
      readonly attempts: number;
      readonly provider: 'openai' | 'anthropic';
      readonly model: string;
      readonly routeKind: string;
      readonly workspaceDir?: string;
    }
  | {
      readonly ok: false;
      readonly id: string;
      readonly error: {
        readonly code: 'PRODUCTION_FAILED' | 'COMPILATION_ERROR' | 'VALIDATION_ERROR';
        readonly message: string;
        readonly details: Record<string, string | number | boolean>;
      };
      readonly latencyMs: number;
      readonly attempts: number;
      readonly provider: 'openai' | 'anthropic';
      readonly model: string;
      readonly routeKind: string;
      readonly workspaceDir?: string;
    };

type AttemptRaceResult =
  | {
      readonly kind: 'runtime';
      readonly runtimeResult: Awaited<ReturnType<CliGeneratorOptions['runtime']['run']>>;
    }
  | {
      readonly kind: 'runtimeError' | 'compileWatchError';
      readonly error: string;
    }
  | {
      readonly kind: 'compiled';
      readonly compiledResult: {
        readonly sourceCode: string;
        readonly componentCode: string;
      };
    };

/**
 * Thin API-like facade over OAuth CLIs.
 *
 * From the caller's point of view this is a single async request/response
 * boundary. CLI-specific mechanics stay inside: temp files, structured final
 * response parsing, compile feedback, and cleanup.
 */
export class CliGenerationApi {
  constructor(private readonly options: CliApiOptions) {}

  async generate(input: UiGenerateInput): Promise<CliApiGenerateResult> {
    const startedAt = Date.now();
    const routeKind = `${this.options.runtime.name}-oauth-cli`;
    let workspace: GenerationWorkspace | null = null;
    let attempts = 0;
    let feedback: string | undefined;
    let lastError = 'generation did not run';

    try {
      workspace = await createGenerationWorkspace(input, {
        workspaceRoot: this.options.workspaceRoot,
      });

      for (let attempt = 1; attempt <= this.options.maxAttempts; attempt += 1) {
        attempts = attempt;
        const taskPrompt = buildTaskPrompt({
          input,
          workspace,
          attempt,
          feedback,
        });

        const attemptAbort = new AbortController();
        const abortFromInput = (): void => attemptAbort.abort();
        if (input.signal) {
          if (input.signal.aborted) attemptAbort.abort();
          else input.signal.addEventListener('abort', abortFromInput, { once: true });
        }

        const runtimePromise = this.options.runtime.run({
          workspaceDir: workspace.dir,
          componentPath: workspace.componentPath,
          schemaPath: workspace.schemaPath,
          taskPrompt,
          timeoutMs: this.options.timeoutMs,
          signal: attemptAbort.signal,
        });
        const runtimeRace: Promise<AttemptRaceResult> = runtimePromise
          .then<AttemptRaceResult>((runtimeResult) => ({
            kind: 'runtime',
            runtimeResult,
          }))
          .catch<AttemptRaceResult>((err) => ({
            kind: 'runtimeError',
            error: stringifyError(err),
          }));
        const raceCandidates = [runtimeRace];
        if (this.options.earlyReturnOnCompile) {
          const compileRace: Promise<AttemptRaceResult> = waitForCompiledComponent({
            componentPath: workspace.componentPath,
            stableMs: this.options.earlyReturnStableMs,
            signal: attemptAbort.signal,
          })
            .then<AttemptRaceResult>((compiledResult) => ({
              kind: 'compiled',
              compiledResult,
            }))
            .catch<AttemptRaceResult>((err) => ({
              kind: 'compileWatchError',
              error: stringifyError(err),
            }));
          raceCandidates.push(
            compileRace,
          );
        }

        let raced: AttemptRaceResult;
        try {
          raced = await Promise.race(raceCandidates);
        } finally {
          if (input.signal) input.signal.removeEventListener('abort', abortFromInput);
        }

        if (raced.kind === 'compiled') {
          attemptAbort.abort();
          void runtimePromise.catch(() => undefined);
          return {
            ok: true,
            id: input.request.renderId,
            sourceCode: raced.compiledResult.sourceCode,
            componentCode: raced.compiledResult.componentCode,
            warnings: [
              'Returned after Component.tsx compiled successfully before CLI final response.',
            ],
            latencyMs: Date.now() - startedAt,
            attempts,
            provider: this.options.runtime.telemetryProvider,
            model: this.options.runtime.telemetryModel,
            routeKind,
            ...(this.options.keepWorkspace ? { workspaceDir: workspace.dir } : {}),
          };
        }

        let runtimeResult: Awaited<ReturnType<CliGeneratorOptions['runtime']['run']>>;
        switch (raced.kind) {
          case 'runtime':
            runtimeResult = raced.runtimeResult;
            break;
          case 'runtimeError':
          case 'compileWatchError':
            attemptAbort.abort();
            lastError = raced.error;
            feedback = lastError;
            continue;
        }

        attemptAbort.abort();

        if (runtimeResult.status !== 'ok') {
          lastError = runtimeResult.error ?? 'runtime returned status:error';
          feedback = lastError;
          continue;
        }

        const componentPath = resolveComponentPath(
          workspace.dir,
          runtimeResult.componentPath ?? workspace.componentPath,
        );
        let sourceCode: string;
        try {
          sourceCode = await readFile(componentPath, 'utf8');
        } catch (err) {
          lastError = `component file was not readable: ${stringifyError(err)}`;
          feedback = lastError;
          continue;
        }

        let compiledCode: string;
        try {
          compiledCode = await compileComponentCode(sourceCode);
        } catch (err) {
          lastError = `component did not compile: ${stringifyError(err)}`;
          feedback = lastError;
          continue;
        }

        return {
          ok: true,
          id: input.request.renderId,
          sourceCode,
          componentCode: compiledCode,
          warnings: runtimeResult.notes ?? [],
          latencyMs: Date.now() - startedAt,
          attempts,
          provider: this.options.runtime.telemetryProvider,
          model: this.options.runtime.telemetryModel,
          routeKind,
          ...(this.options.keepWorkspace ? { workspaceDir: workspace.dir } : {}),
        };
      }

      return {
        ok: false,
        id: input.request.renderId,
        error: {
          code: 'PRODUCTION_FAILED',
          message: lastError,
          details: {
            runtime: this.options.runtime.name,
            attempts,
            ...(this.options.keepWorkspace && workspace
              ? { workspaceDir: workspace.dir }
              : {}),
          },
        },
        latencyMs: Date.now() - startedAt,
        attempts,
        provider: this.options.runtime.telemetryProvider,
        model: this.options.runtime.telemetryModel,
        routeKind,
        ...(this.options.keepWorkspace && workspace ? { workspaceDir: workspace.dir } : {}),
      };
    } finally {
      if (workspace && !this.options.keepWorkspace) {
        await workspace.cleanup();
      }
    }
  }
}

async function waitForCompiledComponent(args: {
  readonly componentPath: string;
  readonly stableMs: number;
  readonly signal: AbortSignal;
}): Promise<{ sourceCode: string; componentCode: string }> {
  let lastStamp = '';
  let lastChangedAt = 0;

  while (!args.signal.aborted) {
    await sleep(250, args.signal);
    let sourceCode: string;
    let stamp: string;
    try {
      const [source, stats] = await Promise.all([
        readFile(args.componentPath, 'utf8'),
        stat(args.componentPath),
      ]);
      sourceCode = source;
      stamp = `${stats.size}:${stats.mtimeMs}`;
    } catch {
      continue;
    }

    if (stamp !== lastStamp) {
      lastStamp = stamp;
      lastChangedAt = Date.now();
      continue;
    }
    if (lastChangedAt === 0 || Date.now() - lastChangedAt < args.stableMs) {
      continue;
    }
    if (sourceCode.includes('Draft UI') || !sourceCode.includes('export default')) {
      continue;
    }

    try {
      const componentCode = await compileComponentCode(sourceCode);
      return { sourceCode, componentCode };
    } catch {
      continue;
    }
  }

  throw new Error('waitForCompiledComponent aborted');
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new Error('aborted'));
      },
      { once: true },
    );
  });
}

function resolveComponentPath(workspaceDir: string, componentPath: string): string {
  const resolved = path.isAbsolute(componentPath)
    ? componentPath
    : path.resolve(workspaceDir, componentPath);
  const relative = path.relative(workspaceDir, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`componentPath escapes workspace: ${componentPath}`);
  }
  return resolved;
}

function stringifyError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
