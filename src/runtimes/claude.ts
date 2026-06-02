import { parseRuntimeResult } from '../result-parser.js';
import { runProcess } from '../process.js';
import type {
  CliRuntime,
  RuntimeFactoryOptions,
  RuntimeGenerateArgs,
  RuntimeGenerateResult,
} from '../types.js';

export function createClaudeRuntime(
  options: RuntimeFactoryOptions = {},
): CliRuntime {
  const command = options.command ?? 'claude';
  const model = options.model;
  const extraArgs = options.extraArgs ?? [];

  return {
    name: 'claude',
    telemetryProvider: 'anthropic',
    telemetryModel: model ?? 'claude-code-cli',
    async run(args: RuntimeGenerateArgs): Promise<RuntimeGenerateResult> {
      const schema = await import('node:fs/promises').then((fs) =>
        fs.readFile(args.schemaPath, 'utf8')
      );
      const argv = [
        '-p',
        '--no-session-persistence',
        '--permission-mode',
        'acceptEdits',
        '--output-format',
        'json',
        '--json-schema',
        schema,
        '--add-dir',
        args.workspaceDir,
        '--tools',
        'Read,Write,Edit',
        ...(model ? ['--model', model] : []),
        ...extraArgs,
        args.taskPrompt,
      ];

      const processResult = await runProcess(command, argv, {
        cwd: args.workspaceDir,
        timeoutMs: args.timeoutMs,
        signal: args.signal,
      });

      if (processResult.code !== 0) {
        return {
          status: 'error',
          error: processResult.stderr.trim()
            || `claude exited with code ${processResult.code ?? 'null'}`,
          rawOutput: processResult,
        };
      }

      const parsed = parseRuntimeResult(processResult.stdout);
      if (!parsed) {
        return {
          status: 'error',
          error: 'claude did not return a JSON result matching the runtime schema',
          rawOutput: processResult,
        };
      }
      return parsed;
    },
  };
}
