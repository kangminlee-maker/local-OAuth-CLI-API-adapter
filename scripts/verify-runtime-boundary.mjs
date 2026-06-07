#!/usr/bin/env node
import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');

const runtimeRoots = [
  'src',
  'dist',
];

const sourceOnlyChecks = [
  {
    name: 'runtime source must not use outbound fetch',
    pattern: /\bfetch\s*\(/,
    allow: [
      'src/proxy/codex-backend-transport.ts',
    ],
  },
  {
    name: 'runtime source must not use outbound HTTP clients',
    pattern: /\b(?:https?|net|tls)\.(?:request|get|connect)\s*\(/,
    allow: [],
  },
  {
    name: 'runtime source must not create browser-style outbound clients',
    pattern: /\b(?:WebSocket|EventSource)\s*\(/,
    allow: [],
  },
  {
    name: 'runtime source must not pass ambient env wholesale',
    pattern: /(?:\.\.\.process\.env|env\s*:\s*process\.env)/,
    allow: [],
  },
];

const runtimeChecks = [
  {
    name: 'runtime must not embed direct provider hosts',
    pattern: /(?:https:\/\/)?api\.(?:openai|anthropic)\.com/,
    allow: [],
  },
  {
    name: 'runtime must not embed ChatGPT Codex backend host outside codex-backend transport',
    pattern: /(?:https:\/\/)?chatgpt\.com\/backend-api\/codex/,
    allow: [
      'src/proxy/codex-backend-transport.ts',
      'dist/proxy/codex-backend-transport.js',
      'dist/proxy/codex-backend-transport.d.ts',
    ],
  },
  {
    name: 'runtime must not embed Codex OAuth refresh host outside codex-backend transport',
    pattern: /(?:https:\/\/)?auth\.openai\.com\/oauth\/token/,
    allow: [
      'src/proxy/codex-backend-transport.ts',
      'dist/proxy/codex-backend-transport.js',
      'dist/proxy/codex-backend-transport.d.ts',
    ],
  },
  {
    name: 'runtime must not read direct provider credential env names',
    pattern: /\b(?:OPENAI|ANTHROPIC|AZURE_OPENAI|OPENROUTER|GOOGLE|GEMINI|MISTRAL|GROQ|DEEPSEEK|COHERE|TOGETHER|PERPLEXITY|XAI)_(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|ORG_ID|ORGANIZATION|PROJECT)\b/,
    allow: [
      'src/proxy/process-env.ts',
      'dist/proxy/process-env.js',
      'dist/proxy/process-env.d.ts',
    ],
  },
  {
    name: 'runtime must not use direct provider routing env names outside proxy client instructions and sanitizer',
    pattern: /\b(?:OPENAI|ANTHROPIC|AZURE_OPENAI|OPENROUTER|GOOGLE|GEMINI|MISTRAL|GROQ|DEEPSEEK|COHERE|TOGETHER|PERPLEXITY|XAI)_(?:BASE_URL|API_BASE|ENDPOINT)\b/,
    allow: [
      'src/proxy-cli.ts',
      'src/proxy/process-env.ts',
      'dist/proxy-cli.js',
      'dist/proxy-cli.d.ts',
      'dist/proxy/process-env.js',
      'dist/proxy/process-env.d.ts',
    ],
  },
  {
    name: 'runtime must not construct direct provider auth headers from process.env',
    pattern: /(?:Bearer\s+\$\{process\.env|x-api-key['"]?\s*:\s*process\.env)/,
    allow: [],
  },
  {
    name: 'runtime must not embed benchmark fixture or task literals',
    pattern: /\b(?:A simple flat red square|A small red square|A streaming red square|solid red square|red_square(?:_on_white)?|blue_square|green_square|transparent_red_square|center_mask|LAUNCH DAY|yellow rain boot|matte teal ceramic coffee mug|api-benchmark-user|get_weather for Seoul|WEATHER_RESULT_CITY|call_bench_weather|toolu_bench_weather)\b/,
    allow: [],
  },
];

const requiredRuntimeFiles = [
  'src/proxy/process-env.ts',
  'dist/proxy/process-env.js',
  'dist/proxy/process-env.d.ts',
];

const failures = [];

for (const filePath of requiredRuntimeFiles) {
  try {
    await stat(join(repoRoot, filePath));
  } catch {
    failures.push(`${filePath}: required runtime boundary file is missing`);
  }
}

for (const root of runtimeRoots) {
  const rootPath = join(repoRoot, root);
  try {
    await stat(rootPath);
  } catch {
    continue;
  }
  for await (const filePath of walk(rootPath)) {
    if (!/\.(?:ts|js|d\.ts)$/.test(filePath)) continue;
    const relativePath = relative(repoRoot, filePath);
    const content = await readFile(filePath, 'utf8');
    const checks = root === 'src'
      ? [...sourceOnlyChecks, ...runtimeChecks]
      : runtimeChecks;
    for (const check of checks) {
      if (check.allow.includes(relativePath)) continue;
      if (check.pattern.test(content)) {
        failures.push(`${relativePath}: ${check.name}`);
      }
    }
  }
}

if (failures.length > 0) {
  process.stderr.write(`Runtime boundary verification failed:\n${failures.map((item) => `- ${item}`).join('\n')}\n`);
  process.exit(1);
}

process.stdout.write('runtime boundary verification passed\n');

async function* walk(dir) {
  for (const name of await readdir(dir)) {
    const filePath = join(dir, name);
    const fileStat = await stat(filePath);
    if (fileStat.isDirectory()) {
      yield* walk(filePath);
    } else if (fileStat.isFile()) {
      yield filePath;
    }
  }
}
