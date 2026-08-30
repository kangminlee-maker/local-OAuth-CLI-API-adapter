#!/usr/bin/env node
// Text surface parity, end to end: the same request goes to this proxy and to
// the direct OpenAI API, and the two answers are compared field by field
// (status, error type/param/code/message). The image surface's instrument
// (`e2e-images-direct-parity.mjs`) is the model; this is its Chat/Responses
// twin.
//
//   set -a; . ./.env; set +a          # OPENAI_API_KEY for the direct side
//   node scripts/e2e-text-surfaces-direct-parity.mjs [--generate] [--only chat]
//
// Every default case is INVALID on both sides, so nothing generates and
// nothing is billed. `--generate` adds the echo comparisons, which do run a
// turn on each side (a handful of tokens each, capped at
// `max_completion_tokens: 1`).
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { startLocalApiProxy } = await import(`${repoRoot}/dist/proxy/http-server.js`);

const KEY = process.env.OPENAI_API_KEY;
if (!KEY) throw new Error('OPENAI_API_KEY is not set; load .env first (set -a; . ./.env; set +a).');
const args = process.argv.slice(2);
const generate = args.includes('--generate');
const only = readArg('--only');
const DIRECT = 'https://api.openai.com';
const CHAT = '/v1/chat/completions';
const MODEL = readArg('--model') ?? 'gpt-5.6-terra';

// The rejection cases never reach a backend, so the proxy runs against one that
// refuses to be called: a case that DOES reach it is a bug in the case, and
// this makes it loud instead of billing a turn for it.
const refusingBackend = {
  name: 'must-not-run', model: MODEL,
  async generate() { throw new Error('a rejection case reached the backend'); },
  async *stream() { throw new Error('a rejection case reached the backend'); },
  async close() {},
};
let imageGenerationClient;
let backend = refusingBackend;
if (generate) {
  const { CodexBackendTransport } = await import(`${repoRoot}/dist/proxy/codex-backend-transport.js`);
  backend = new CodexBackendTransport({ timeoutMs: 180_000, model: 'gpt-5.5' });
  imageGenerationClient = backend;
}

const started = await startLocalApiProxy({
  backend, imageGenerationClient, host: '127.0.0.1', port: 0, requestTimeoutMs: 180_000,
});

let failures = 0;
let checks = 0;
function record(name, ok, detail = '') {
  checks += 1;
  if (!ok) failures += 1;
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'} ${name} ${detail}\n`);
}

async function post(base, path, body, headers = {}) {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, text, json };
}

function envelope(r) {
  return r.json?.error
    ? { status: r.status, type: r.json.error.type, param: r.json.error.param ?? null, code: r.json.error.code ?? null, message: r.json.error.message }
    : { status: r.status, keys: Object.keys(r.json ?? {}).sort() };
}

async function parity(name, path, body) {
  const sent = { model: MODEL, ...body };
  for (const key of Object.keys(sent)) if (sent[key] === DELETE) delete sent[key];
  const [p, d] = await Promise.all([
    post(started.url, path, sent),
    post(DIRECT, path, sent, { authorization: `Bearer ${KEY}` }),
  ]);
  const pe = envelope(p);
  const de = envelope(d);
  const same = JSON.stringify(pe) === JSON.stringify(de);
  record(`parity ${name}`, same, same
    ? `→ ${de.status} ${de.code ?? ''} ${de.param ?? ''}`
    : `\n   proxy : ${JSON.stringify(pe)}\n   direct: ${JSON.stringify(de)}`);
  if (d.status === 200 && !generate) {
    process.stdout.write(`   !! the direct API accepted "${name}" — that case is not a free probe\n`);
  }
}

const DELETE = Symbol('delete the key');
const M = [{ role: 'user', content: 'ping' }];
const TOOL = { type: 'function', function: { name: 'f', parameters: { type: 'object', properties: {} } } };

// Each row is one body both sides must answer identically. They are the same
// bodies `docs/conformance-matrix.md` §5.5.5 was measured from, so this
// instrument re-checks the measurement rather than restating it.
const chatCases = [
  ['unknown key', { messages: M, zzz_unknown: 1 }],
  ['audio', { messages: M, audio: { voice: 'alloy', format: 'wav' } }],
  ['modalities', { messages: M, modalities: ['text', 'audio'] }],
  ['web_search_options', { messages: M, web_search_options: {} }],
  ['responses-shaped reasoning', { messages: M, reasoning: { effort: 'low' } }],
  ['responses-shaped text', { messages: M, text: { verbosity: 'low' } }],
  ['stop', { messages: M, stop: ['ZZ'] }],
  ['max_tokens', { messages: M, max_tokens: 32 }],
  ['logit_bias', { messages: M, logit_bias: { 1: 1 } }],
  ['prediction', { messages: M, prediction: { type: 'content', content: 'pong' } }],
  ['frequency_penalty while reasoning', { messages: M, frequency_penalty: 0.5 }],
  ['presence_penalty while reasoning', { messages: M, presence_penalty: 0.5 }],
  ['logprobs while reasoning', { messages: M, logprobs: true }],
  ['n as a string', { messages: M, n: '2' }],
  ['n below the floor', { messages: M, n: 0 }],
  ['n above the ceiling', { messages: M, n: 64 }],
  ['temperature as a string', { messages: M, temperature: 'hot' }],
  ['temperature 0.5', { messages: M, temperature: 0.5 }],
  ['top_p as a string', { messages: M, top_p: 'wide' }],
  ['top_p 0.5', { messages: M, top_p: 0.5 }],
  ['store as a string', { messages: M, store: 'yes' }],
  ['seed as a decimal', { messages: M, seed: 1.5 }],
  ['user as an object', { messages: M, user: { a: 1 } }],
  ['tools as a string', { messages: M, tools: 'none' }],
  ['tool_choice as an integer', { messages: M, tool_choice: 7 }],
  ['tool_choice unknown string', { messages: M, tools: [TOOL], tool_choice: 'bogus' }],
  ['tool_choice object without function', { messages: M, tools: [TOOL], tool_choice: { type: 'bogus' } }],
  ['tool_choice function without name', { messages: M, tools: [TOOL], tool_choice: { type: 'function', function: {} } }],
  ['response_format as a string', { messages: M, response_format: 'json' }],
  ['response_format without type', { messages: M, response_format: {} }],
  ['response_format unknown type', { messages: M, response_format: { type: 'bogus' } }],
  ['messages as a string', { messages: 'ping' }],
  ['messages absent', { messages: DELETE }],
  ['messages empty', { messages: [] }],
  ['message item not an object', { messages: ['ping'] }],
  ['message role unknown', { messages: [{ role: 'bogus', content: 'ping' }] }],
  ['message role missing', { messages: [{ content: 'ping' }] }],
  ['message content numeric', { messages: [{ role: 'user', content: 7 }] }],
  ['max_completion_tokens 0', { messages: M, max_completion_tokens: 0 }],
  ['metadata too many properties', { messages: M, metadata: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, 'v'])) }],
  ['metadata value too long', { messages: M, metadata: { k: 'x'.repeat(600) } }],
  ['metadata key too long', { messages: M, metadata: { ['k'.repeat(70)]: 'v' } }],
  ['metadata value not a string', { messages: M, metadata: { k: 7 } }],
  ['moderation without model', { messages: M, moderation: {} }],
  ['functions without name', { messages: M, functions: [{ parameters: {} }] }],
  ['tools without function', { messages: M, tools: [{ type: 'function' }] }],
  ['tools function without name', { messages: M, tools: [{ type: 'function', function: { parameters: {} } }] }],
  ['function_call object without name', { messages: M, functions: [{ name: 'f', parameters: {} }], function_call: { __probe__: 'wrong type' } }],
  ['service_tier unknown', { messages: M, service_tier: 'bogus' }],
  ['service_tier as an object', { messages: M, service_tier: { a: 1 } }],
  ['verbosity unknown', { messages: M, verbosity: 'bogus' }],
  ['reasoning_effort max', { messages: M, reasoning_effort: 'max' }],
  ['reasoning_effort minimal', { messages: M, reasoning_effort: 'minimal' }],
  ['reasoning_effort as an object', { messages: M, reasoning_effort: { __probe__: 'wrong type' } }],
  ['prompt_cache_retention in_memory', { messages: M, prompt_cache_retention: 'in_memory' }],
  ['prompt_cache_retention as an object', { messages: M, prompt_cache_retention: { a: 1 } }],
  ['prompt_cache_options unknown member', { messages: M, prompt_cache_options: { bogus: 1 } }],
  ['top_logprobs above the ceiling', { messages: M, reasoning_effort: 'none', logprobs: true, top_logprobs: 21 }],
  ['top_logprobs below the floor', { messages: M, reasoning_effort: 'none', logprobs: true, top_logprobs: -1 }],
  ['top_logprobs without logprobs', { messages: M, reasoning_effort: 'none', top_logprobs: 1 }],
  ['model absent', { messages: M, model: DELETE }],
  ['model empty', { messages: M, model: '' }],
  // Report order: each of these is invalid twice.
  ['order model beats unknown key', { messages: M, model: DELETE, zzz_unknown: 1 }],
  ['order messages beats unknown key', { messages: DELETE, zzz_unknown: 1 }],
  ['order unknown key beats bad type', { messages: M, zzz_unknown: 1, n: 'abc' }],
  ['order unknown key beats empty messages', { messages: [], zzz_unknown: 1 }],
  ['order unknown key beats refused parameter', { messages: M, zzz_unknown: 1, stop: ['ZZ'] }],
  ['order unknown key beats bad enum', { messages: M, zzz_unknown: 1, service_tier: 'bogus' }],
  ['order n before stop', { messages: M, n: 'abc', stop: ['ZZ'] }],
  ['order n before temperature', { messages: M, n: 'abc', temperature: 0.5 }],
  ['order n bound before stop', { messages: M, n: 0, stop: ['ZZ'] }],
  ['order stop before temperature', { messages: M, stop: ['ZZ'], temperature: 0.5 }],
];

if (!only || only === 'chat') {
  for (const [name, body] of chatCases) await parity(name, CHAT, body);
}

// The accepted rows: identical bodies on both sides, compared on the fields
// the proxy is responsible for echoing. These generate.
if (generate && (!only || only === 'chat')) {
  const echoCases = [
    ['echo baseline', {}],
    ['echo service_tier flex', { service_tier: 'flex' }],
    ['echo service_tier auto', { service_tier: 'auto' }],
    ['echo service_tier priority', { service_tier: 'priority' }],
  ];
  for (const [name, extra] of echoCases) {
    const body = { model: MODEL, messages: [{ role: 'user', content: 'Reply with exactly: pong' }], max_completion_tokens: 8, reasoning_effort: 'none', ...extra };
    const [p, d] = await Promise.all([
      post(started.url, CHAT, body),
      post(DIRECT, CHAT, body, { authorization: `Bearer ${KEY}` }),
    ]);
    const read = (r) => ({ status: r.status, service_tier: r.json?.service_tier ?? null, system_fingerprint: r.json?.system_fingerprint ?? null, choices: r.json?.choices?.length ?? null });
    const pe = read(p);
    const de = read(d);
    const same = JSON.stringify(pe) === JSON.stringify(de);
    record(`echo ${name}`, same, same ? `→ ${JSON.stringify(de)}` : `\n   proxy : ${JSON.stringify(pe)}\n   direct: ${JSON.stringify(de)}`);
  }
}

await started.close();
process.stdout.write(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILED`} — ${checks - failures}/${checks}\n`);
process.exit(failures === 0 ? 0 : 1);

function readArg(name) {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
}
