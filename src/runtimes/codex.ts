import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { runProcess } from '../process.js';
import { parseRuntimeResult } from '../result-parser.js';
import type {
  CliRuntime,
  RuntimeFactoryOptions,
  RuntimeGenerateArgs,
  RuntimeGenerateResult,
} from '../types.js';

export function createCodexRuntime(
  options: RuntimeFactoryOptions = {},
): CliRuntime {
  const command = options.command ?? 'codex';
  const model = options.model;
  const extraArgs = options.extraArgs ?? [];

  return {
    name: 'codex',
    telemetryProvider: 'openai',
    telemetryModel: model ?? 'codex-cli',
    async run(args: RuntimeGenerateArgs): Promise<RuntimeGenerateResult> {
      const finalPath = path.join(args.workspaceDir, 'codex-final.json');
      const argv = [
        'exec',
        '--json',
        '--cd',
        args.workspaceDir,
        '--sandbox',
        'workspace-write',
        '--skip-git-repo-check',
        '--ephemeral',
        '-c',
        'model_reasoning_effort="low"',
        '--output-schema',
        args.schemaPath,
        '--output-last-message',
        finalPath,
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
            || `codex exited with code ${processResult.code ?? 'null'}`,
          rawOutput: processResult,
        };
      }

      const lastMessage = await readOptional(finalPath);
      const parsed = parseRuntimeResult(lastMessage ?? processResult.stdout);
      if (!parsed) {
        return {
          status: 'error',
          error: 'codex did not return a JSON result matching the runtime schema',
          rawOutput: processResult,
        };
      }
      return parsed;
    },
  };
}

async function readOptional(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf8');
  } catch {
    return null;
  }
}
