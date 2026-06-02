import type {
  GenerationDeps,
  UiGenerateInput,
  UiGenerateResult,
  UiGenerator,
} from '@ggui-ai/mcp-server';
import { InMemoryBlueprintProvider } from '@ggui-ai/mcp-server-core/in-memory';
import { CliGenerationApi } from './cli-api.js';
import {
  type CliGeneratorOptions,
  sentinelSelectionForRuntime,
} from './types.js';

const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_MAX_ATTEMPTS = 2;
const DEFAULT_EARLY_RETURN_STABLE_MS = 1000;

type ResolvedCliGeneratorOptions =
  Omit<Required<CliGeneratorOptions>, 'workspaceRoot'>
  & Pick<CliGeneratorOptions, 'workspaceRoot'>;

export class CliUiGenerator implements UiGenerator {
  readonly tier = 'default';
  readonly model: string;
  readonly slug: string;
  private readonly api: CliGenerationApi;

  constructor(private readonly options: ResolvedCliGeneratorOptions) {
    this.model = options.runtime.name === 'mock'
      ? 'oauth-cli-mock'
      : `${options.runtime.name}-oauth-cli`;
    this.slug = `ui-gen-default-${this.model}`;
    this.api = new CliGenerationApi(options);
  }

  async generate(input: UiGenerateInput): Promise<UiGenerateResult> {
    const result = await this.api.generate(input);
    if (!result.ok) {
      return {
        ok: false,
        error: result.error,
        metadata: {
          provider: result.provider,
          model: result.model,
          inputTokens: 0,
          outputTokens: 0,
          latencyMs: result.latencyMs,
          cacheHit: false,
          attempts: result.attempts,
          routeKind: result.routeKind,
        },
      };
    }

    return {
      ok: true,
      response: {
        renderId: input.request.renderId,
        componentCode: result.componentCode,
        sourceCode: result.sourceCode,
        ...(input.contract ? { contract: input.contract } : {}),
        ...(result.warnings.length > 0 ? { warnings: [...result.warnings] } : {}),
      },
      metadata: {
        provider: result.provider,
        model: result.model,
        inputTokens: 0,
        outputTokens: 0,
        latencyMs: result.latencyMs,
        cacheHit: false,
        attempts: Math.max(result.attempts - 1, 0),
        routeKind: result.routeKind,
      },
    };
  }
}

export function createCliGenerator(
  options: CliGeneratorOptions,
): CliUiGenerator {
  return new CliUiGenerator({
    runtime: options.runtime,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxAttempts: options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    keepWorkspace: options.keepWorkspace ?? false,
    workspaceRoot: options.workspaceRoot,
    earlyReturnOnCompile: options.earlyReturnOnCompile ?? true,
    earlyReturnStableMs: options.earlyReturnStableMs ?? DEFAULT_EARLY_RETURN_STABLE_MS,
  });
}

export function createCliGenerationDeps(
  options: CliGeneratorOptions,
): GenerationDeps {
  const generator = createCliGenerator(options);
  const selection = sentinelSelectionForRuntime(options.runtime);

  return {
    uiGenerator: generator,
    blueprints: new InMemoryBlueprintProvider(),
    resolveLlm: () => ({
      selection,
      providerKey: {
        provider: selection.provider,
        key: 'oauth-cli-session',
      },
    }),
  };
}
