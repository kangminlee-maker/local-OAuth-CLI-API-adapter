import type {
  LlmSelection,
  UiGenerateInput,
} from '@ggui-ai/mcp-server';

export type RuntimeName = 'codex' | 'claude' | 'mock';

export interface RuntimeGenerateArgs {
  readonly workspaceDir: string;
  readonly componentPath: string;
  readonly schemaPath: string;
  readonly taskPrompt: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

export interface RuntimeGenerateResult {
  readonly status: 'ok' | 'error';
  readonly componentPath?: string;
  readonly notes?: readonly string[];
  readonly error?: string;
  readonly sessionId?: string;
  readonly rawOutput?: unknown;
}

export interface CliRuntime {
  readonly name: RuntimeName;
  readonly telemetryProvider: 'openai' | 'anthropic';
  readonly telemetryModel: string;
  run(args: RuntimeGenerateArgs): Promise<RuntimeGenerateResult>;
}

export interface CliGeneratorOptions {
  readonly runtime: CliRuntime;
  readonly timeoutMs?: number;
  readonly maxAttempts?: number;
  readonly keepWorkspace?: boolean;
  readonly workspaceRoot?: string;
  readonly earlyReturnOnCompile?: boolean;
  readonly earlyReturnStableMs?: number;
}

export interface RuntimeFactoryOptions {
  readonly command?: string;
  readonly model?: string;
  readonly extraArgs?: readonly string[];
}

export function sentinelSelectionForRuntime(
  runtime: CliRuntime,
): LlmSelection {
  if (runtime.telemetryProvider === 'anthropic') {
    return {
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
    };
  }
  return {
    provider: 'openai',
    model: 'gpt-5.3-codex',
  };
}

export function describeInputForPrompt(input: UiGenerateInput): string {
  const payload = {
    request: input.request,
    contract: input.contract ?? null,
    variance: input.variance ?? null,
    rendering: input.rendering ?? null,
    appGadgets: input.appGadgets ?? null,
    gadgetTypes: input.gadgetTypes
      ? Object.keys(input.gadgetTypes).sort()
      : null,
    infra: input.infra ?? null,
  };
  return JSON.stringify(payload, null, 2);
}
