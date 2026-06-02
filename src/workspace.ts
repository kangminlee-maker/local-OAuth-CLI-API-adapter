import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { UiGenerateInput } from '@ggui-ai/mcp-server';
import { describeInputForPrompt } from './types.js';

export interface GenerationWorkspace {
  readonly dir: string;
  readonly componentPath: string;
  readonly schemaPath: string;
  readonly promptPath: string;
  cleanup(): Promise<void>;
}

export async function createGenerationWorkspace(
  input: UiGenerateInput,
  options: {
    readonly workspaceRoot?: string;
  } = {},
): Promise<GenerationWorkspace> {
  const parent = options.workspaceRoot ?? tmpdir();
  const dir = await mkdtemp(path.join(parent, 'ggui-cli-gen-'));
  const componentPath = path.join(dir, 'Component.tsx');
  const schemaPath = path.join(dir, 'result.schema.json');
  const promptPath = path.join(dir, 'INPUT.json');

  await writeFile(componentPath, initialComponent(input.request.prompt), 'utf8');
  await writeFile(schemaPath, JSON.stringify(runtimeResultSchema(), null, 2), 'utf8');
  await writeFile(promptPath, describeInputForPrompt(input), 'utf8');

  return {
    dir,
    componentPath,
    schemaPath,
    promptPath,
    async cleanup() {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

export function buildTaskPrompt(args: {
  readonly input: UiGenerateInput;
  readonly workspace: GenerationWorkspace;
  readonly attempt: number;
  readonly feedback?: string;
}): string {
  const feedback = args.feedback
    ? `\nPrevious attempt feedback:\n${args.feedback}\n`
    : '';
  return [
    'You are generating a ggui React UI component.',
    '',
    `Working directory: ${args.workspace.dir}`,
    `Input JSON: ${args.workspace.promptPath}`,
    `Component file to edit: ${args.workspace.componentPath}`,
    '',
    'Task:',
    '- Read INPUT.json.',
    '- Decide the final design before editing, then write Component.tsx as the final component in one edit when possible.',
    '- Edit Component.tsx so it satisfies the user request.',
    '- After Component.tsx is complete and compilable, do not make extra edits; return the final JSON immediately.',
    '- Export a default React component.',
    '- Keep it browser-only and self-contained.',
    '- Prefer React, inline styles, CSS variables, and semantic HTML.',
    '- Do not use network calls, local filesystem calls, timers for data loading, or Node APIs in the component.',
    '- Do not import packages except react or react/jsx-runtime unless the input explicitly requires a registered ggui package.',
    '- If a contract is present, preserve its intent in the UI. Do not invent action or stream names.',
    '',
    `User request:\n${args.input.request.prompt}`,
    feedback,
    'Final response:',
    '- Return JSON only.',
    '- Use status "ok" after Component.tsx has been written.',
    '- Set componentPath to "./Component.tsx".',
    '- Always include componentPath, notes, error, and sessionId fields.',
    '- Use an empty string for error and sessionId when they do not apply.',
    '- Include short notes when useful; otherwise use an empty notes array.',
  ].join('\n');
}

function runtimeResultSchema(): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      status: { enum: ['ok', 'error'] },
      componentPath: { type: 'string' },
      notes: {
        type: 'array',
        items: { type: 'string' },
      },
      error: { type: 'string' },
      sessionId: { type: 'string' },
    },
    required: ['status', 'componentPath', 'notes', 'error', 'sessionId'],
  };
}

function initialComponent(prompt: string): string {
  const title = prompt.trim().slice(0, 80) || 'Generated UI';
  return `import * as React from 'react';

export default function Component() {
  return (
    <main style={{
      fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif',
      padding: 24,
      color: '#1f2937',
      background: '#ffffff',
      border: '1px solid #d1d5db',
      borderRadius: 8
    }}>
      <h1 style={{ margin: 0, fontSize: 20, lineHeight: 1.25 }}>Draft UI</h1>
      <p style={{ margin: '12px 0 0', fontSize: 14, lineHeight: 1.6 }}>
        ${escapeForText(title)}
      </p>
    </main>
  );
}
`;
}

function escapeForText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/{/g, '&#123;')
    .replace(/}/g, '&#125;');
}
