#!/usr/bin/env node
// Which Images API options does the live Codex backend accept on the
// `image_generation` tool declaration, and what does it do with each value?
//
// Text-only asks with `tool_choice: auto`, so nothing is generated and the run
// is free apart from a few tokens. Controls come first: a bogus key and a bogus
// enum must be REJECTED, or the backend is not validating the declaration and
// acceptance proves nothing.
//
//   node scripts/probe-codex-image-tool-slots.mjs [--model gpt-5.5] [--only id,id]
//                                                  [--out artifacts/codex-backend-image-probe]
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const model = readValueArg('--model') ?? 'gpt-5.5';
const only = (readValueArg('--only') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const outDir = resolve(repoRoot, readValueArg('--out') ?? 'artifacts/codex-backend-image-probe');
const codexHome = resolve(readValueArg('--codex-home') ?? process.env.CODEX_HOME ?? join(homedir(), '.codex'));

const CHATGPT_CODEX_BACKEND_URL = 'https://chatgpt.com/backend-api/codex/responses';
const CODEX_REFRESH_TOKEN_URL = 'https://auth.openai.com/oauth/token';
const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const CHATGPT_AUTH_CLAIM_NAMESPACE = `https://api.${'openai'}.com/auth`;
const allowedHosts = new Set(['chatgpt.com', 'auth.openai.com']);

const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';
const MASK = { image_url: `data:image/png;base64,${TINY_PNG}` };

const base = {
  model,
  instructions: 'Answer in text only. Do not use any tool.',
  input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Reply with exactly: OK' }] }],
  tool_choice: 'auto',
  parallel_tool_calls: true,
  reasoning: { effort: 'low' },
  store: false,
  stream: true,
  include: [],
  text: { verbosity: 'low' },
};

// [id, tools, extra body fields]
const variants = [
  ['control_no_tool', []],
  ['control_bogus_field', [{ type: 'image_generation', bogus_field_xyz: 'x' }]],
  ['control_bogus_enum_background', [{ type: 'image_generation', background: 'bogus' }]],
  ['control_bogus_enum_moderation', [{ type: 'image_generation', moderation: 'bogus' }]],
  ['control_bogus_enum_input_fidelity', [{ type: 'image_generation', input_fidelity: 'bogus' }]],
  ['control_bogus_mask_shape', [{ type: 'image_generation', input_image_mask: 'not-an-object' }]],
  ['slot_background', [{ type: 'image_generation', background: 'transparent' }]],
  ['slot_background_opaque', [{ type: 'image_generation', background: 'opaque' }]],
  ['slot_background_auto', [{ type: 'image_generation', background: 'auto' }]],
  ['slot_moderation', [{ type: 'image_generation', moderation: 'low' }]],
  ['slot_input_fidelity', [{ type: 'image_generation', input_fidelity: 'high' }]],
  ['slot_input_image_mask', [{ type: 'image_generation', input_image_mask: MASK }]],
  ['slot_mask_https_url', [{ type: 'image_generation', input_image_mask: { image_url: 'https://example.com/mask.png' } }]],
  ['slot_mask_empty_object', [{ type: 'image_generation', input_image_mask: {} }]],
  ['slot_edit_combo', [{ type: 'image_generation', action: 'edit', background: 'opaque', moderation: 'low', input_image_mask: MASK, size: '1024x1024', quality: 'low', output_format: 'png' }]],
  ['body_temperature_0_5', [], { temperature: 0.5 }],
  ['body_temperature_1', [], { temperature: 1 }],
  ['body_top_p_0_5', [], { top_p: 0.5 }],
];

const auth = await readAuth();
const results = [];
for (const [id, tools, extra = {}] of variants) {
  if (only.length > 0 && !only.includes(id)) continue;
  const body = { ...base, ...extra, tools };
  const startedAt = Date.now();
  let summary;
  try {
    const response = await guardedFetch(CHATGPT_CODEX_BACKEND_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${auth.accessToken}`,
        'ChatGPT-Account-ID': auth.accountId,
        'OAI-Product-Sku': 'codex',
        'Content-Type': 'application/json',
        accept: 'text/event-stream',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(90_000),
    });
    if (!response.ok) {
      const raw = await response.text().catch(() => '');
      summary = { id, status: response.status, error: safeJsonOrText(raw) };
    } else {
      let text = '';
      let eventCount = 0;
      const itemTypes = [];
      for await (const event of parseSseEvents(response)) {
        eventCount += 1;
        if (event.type === 'response.output_text.delta') text += event.delta ?? '';
        if (event.type === 'response.output_item.done' && event.item?.type) itemTypes.push(event.item.type);
        if (event.type === 'response.failed' || event.type === 'error') {
          summary = { id, status: response.status, failed: event };
        }
        if (event.type === 'response.completed') break;
      }
      summary ??= { id, status: response.status, text: text.trim().slice(0, 80), itemTypes, eventCount };
    }
  } catch (err) {
    summary = { id, error: err instanceof Error ? err.message : String(err) };
  }
  summary.tools = tools;
  if (Object.keys(extra).length > 0) summary.extraBody = extra;
  summary.totalMs = Date.now() - startedAt;
  results.push(summary);
  process.stdout.write(`${id}: ${summary.status ?? 'ERR'} ${summary.text ?? summary.error?.error?.message ?? summary.error?.detail ?? summary.error ?? ''}\n`);
}

await mkdir(outDir, { recursive: true });
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const reportPath = join(outDir, `codex-image-tool-slots.${timestamp}.json`);
await writeFile(reportPath, `${JSON.stringify({ generatedAt: new Date().toISOString(), model, backend: CHATGPT_CODEX_BACKEND_URL, results }, null, 2)}\n`);
process.stdout.write(`tool-slot probe report: ${reportPath}\n`);

function readValueArg(name) {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

async function guardedFetch(url, init) {
  const parsed = new URL(url);
  if (!allowedHosts.has(parsed.hostname)) {
    throw new Error(`Blocked non-Codex/backend network host: ${parsed.hostname}`);
  }
  return await fetch(url, init);
}

function safeJsonOrText(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return raw.slice(0, 600);
  }
}

async function* parseSseEvents(response) {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let separator = /\r?\n\r?\n/.exec(buffer);
    while (separator) {
      const block = buffer.slice(0, separator.index);
      buffer = buffer.slice(separator.index + separator[0].length);
      const data = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data: '))
        .map((line) => line.slice(6))
        .join('\n')
        .trim();
      if (data && data !== '[DONE]') {
        try {
          yield JSON.parse(data);
        } catch {
          // Not JSON; skip.
        }
      }
      separator = /\r?\n\r?\n/.exec(buffer);
    }
  }
}

async function readAuth() {
  const authPath = join(codexHome, 'auth.json');
  let parsed = JSON.parse(await readFile(authPath, 'utf8'));
  const expiresAt = jwtPayload(parsed.tokens?.access_token)?.exp;
  if (typeof expiresAt === 'number' && expiresAt * 1000 <= Date.now() + 5 * 60 * 1000) {
    const response = await guardedFetch(CODEX_REFRESH_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: CODEX_CLIENT_ID,
        grant_type: 'refresh_token',
        refresh_token: parsed.tokens?.refresh_token,
      }),
    });
    if (!response.ok) throw new Error(`Codex OAuth refresh failed with status ${response.status}`);
    const refreshed = await response.json();
    parsed = {
      ...parsed,
      tokens: {
        ...parsed.tokens,
        ...(refreshed.id_token ? { id_token: refreshed.id_token } : {}),
        ...(refreshed.access_token ? { access_token: refreshed.access_token } : {}),
        ...(refreshed.refresh_token ? { refresh_token: refreshed.refresh_token } : {}),
      },
      last_refresh: new Date().toISOString(),
    };
    const tempPath = `${authPath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });
    await rename(tempPath, authPath);
  }
  const accessToken = parsed.tokens?.access_token;
  const accountId = parsed.tokens?.account_id
    ?? jwtPayload(parsed.tokens?.id_token)?.[CHATGPT_AUTH_CLAIM_NAMESPACE]?.chatgpt_account_id;
  if (!accessToken || !accountId) {
    throw new Error('Codex OAuth auth.json must include tokens.access_token and tokens.account_id.');
  }
  return { accessToken, accountId };
}

function jwtPayload(jwt) {
  const payload = jwt?.split('.')[1];
  if (!payload) return null;
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}
