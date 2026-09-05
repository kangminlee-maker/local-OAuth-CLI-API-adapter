#!/usr/bin/env node
// Handoff §4-3-a: the text surfaces' option rules, measured on the direct APIs
// the way the Images envelopes were (conformance matrix §5.5.2–§5.5.4).
//
//   set -a; . ./.env; set +a
//   node scripts/probe-text-surface-keys.mjs [--only chat|responses|messages] [--phase keys|values]
//
// Phase `keys` sends every candidate top-level key with a value of a type the
// key can never take. A known key is answered about its type (or its value); an
// unknown one is `unknown_parameter` (OpenAI) / "Extra inputs are not permitted"
// (Anthropic). Nothing generates, nothing is billed.
//
// Phase `values` sends each key with a VALID value to learn whether the model
// family runs it (`gpt-5.6-terra` / `claude-sonnet-5`), refuses it
// (`unsupported_parameter` / `unsupported_value`), or accepts-and-echoes it.
// These can generate, so every body caps output at the smallest the surface
// allows (`max_completion_tokens: 1`, `max_output_tokens: 16`, `max_tokens: 1`).
//
// The raw bytes are the evidence: every exchange is recorded under
// `artifacts/direct-api-captures/<run>/`; the table printed here is read from
// them. The classifier is proven against known-opposite envelopes before any
// capture is believed.
import { recordExchange, startCaptureRun, captureSummary } from './lib/capture-recorder.mjs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const openAiModel = readArg('--openai-model') ?? 'gpt-5.6-terra';
const anthropicModel = readArg('--anthropic-model') ?? 'claude-sonnet-5';
const only = readArg('--only');
const phaseArg = readArg('--phase');
const grep = readArg('--grep');

if (!process.env.OPENAI_API_KEY || !process.env.ANTHROPIC_API_KEY) {
  console.error('OPENAI_API_KEY and ANTHROPIC_API_KEY are required: these probes ask the vendors directly');
  process.exit(2);
}

const OPENAI = 'https://api.openai.com';
const ANTHROPIC = 'https://api.anthropic.com';

// ------------------------------------------------------------ classifier
// One word per envelope. `accepted` is a 200. Everything else is read from the
// error body, never from the status alone.
function classify(status, json) {
  if (status === 200) return 'accepted';
  const err = json?.error;
  if (!err) return `http_${status}`;
  if (err.code === 'unknown_parameter') return 'unknown';
  if (err.code === 'unsupported_parameter' || err.code === 'unsupported_value') return `unsupported:${err.code}`;
  if (err.code === 'invalid_type') return 'type';
  if (err.code === 'invalid_value') return 'value';
  if (typeof err.message === 'string' && /Extra inputs are not permitted/.test(err.message)) return 'unknown';
  if (typeof err.message === 'string' && /Input should be|valid (number|integer|boolean|string|list|dictionary)|Field required/.test(err.message)) return 'type';
  if (err.code) return `code:${err.code}`;
  return `${status}:${err.type ?? 'error'}`;
}

function proveClassifier() {
  const cases = [
    ['unknown (OpenAI)', classify(400, { error: { type: 'invalid_request_error', param: 'zzz', code: 'unknown_parameter', message: 'Unknown parameter: zzz' } }), 'unknown'],
    ['type (OpenAI)', classify(400, { error: { type: 'invalid_request_error', param: 'n', code: 'invalid_type', message: 'x' } }), 'type'],
    ['unsupported (OpenAI)', classify(400, { error: { type: 'invalid_request_error', param: 'stop', code: 'unsupported_parameter', message: 'x' } }), 'unsupported:unsupported_parameter'],
    ['accepted', classify(200, { id: 'x' }), 'accepted'],
    ['unknown (Anthropic)', classify(400, { type: 'error', error: { type: 'invalid_request_error', message: 'bogus: Extra inputs are not permitted' } }), 'unknown'],
    ['type (Anthropic)', classify(400, { type: 'error', error: { type: 'invalid_request_error', message: 'top_k: Input should be a valid integer' } }), 'type'],
    ['not unknown when the code differs', classify(400, { error: { type: 'invalid_request_error', param: 'x', code: 'invalid_value', message: 'Unknown parameter: not really' } }), 'value'],
  ];
  const failed = cases.filter(([, got, want]) => got !== want);
  if (failed.length > 0) {
    console.error(`classifier self-test failed; no capture below can be trusted:\n${failed.map(([name, got, want]) => `  - ${name}: got ${got}, want ${want}`).join('\n')}`);
    process.exit(1);
  }
  console.log(`classifier self-test: ${cases.length}/${cases.length} — each class distinguished from its opposite\n`);
}

// ------------------------------------------------------------------ bodies
const chatBase = () => ({ model: openAiModel, messages: [{ role: 'user', content: 'ping' }], max_completion_tokens: 1 });
const responsesBase = () => ({ model: openAiModel, input: 'ping', max_output_tokens: 16 });
const messagesBase = () => ({ model: anthropicModel, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] });

// Wrong-type values by the type the key takes; the object form is refused by
// every scalar and array key, the string form by every object and array key.
const OBJ = { __probe__: 'wrong type' };
const STR = 'wrong type';

// [key, wrongTypeValue, validValue | undefined (no value probe), note]
const CHAT_KEYS = [
  ['messages', STR, undefined, 'required array'],
  ['audio', STR, undefined, 'object; requires modalities audio'],
  ['frequency_penalty', STR, 0.5, 'number'],
  ['function_call', OBJ, 'auto', 'deprecated; needs functions'],
  ['functions', STR, [{ name: 'f', parameters: { type: 'object', properties: {} } }], 'deprecated array'],
  ['logit_bias', STR, { 1: 1 }, 'map'],
  ['logprobs', STR, true, 'boolean'],
  ['max_completion_tokens', STR, undefined, 'integer (base body carries it)'],
  ['max_tokens', STR, 1, 'deprecated integer'],
  ['metadata', STR, { a: 'b' }, 'map'],
  ['modalities', STR, ['text'], 'array'],
  ['n', STR, 2, 'integer (P-7 accepted)'],
  ['parallel_tool_calls', STR, false, 'boolean'],
  ['prediction', STR, { type: 'content', content: 'pong' }, 'object'],
  ['presence_penalty', STR, 0.5, 'number'],
  ['prompt_cache_key', OBJ, 'probe-key', 'string'],
  ['prompt_cache_retention', OBJ, 'in_memory', 'enum'],
  ['prompt_cache_options', STR, { ttl: '30m' }, 'object'],
  ['reasoning_effort', OBJ, 'low', 'enum'],
  ['reasoning', STR, { effort: 'low' }, 'Responses-shaped (proxy extension)'],
  ['response_format', STR, undefined, 'object'],
  ['safety_identifier', OBJ, 'probe', 'string'],
  ['seed', STR, 1, 'integer'],
  ['service_tier', OBJ, 'default', 'enum'],
  ['stop', OBJ, undefined, 'P-9: unsupported_parameter'],
  ['store', STR, false, 'boolean'],
  ['stream', STR, undefined, 'boolean'],
  ['stream_options', STR, undefined, 'object; needs stream'],
  ['temperature', STR, undefined, 'measured 2026-08-29'],
  ['text', STR, { verbosity: 'low' }, 'Responses-shaped (proxy extension)'],
  ['tool_choice', 7, undefined, 'string|object'],
  ['tools', STR, undefined, 'array'],
  ['top_logprobs', STR, undefined, 'integer; needs logprobs'],
  ['top_p', STR, undefined, 'measured 2026-08-29'],
  ['user', OBJ, 'probe', 'string'],
  ['verbosity', OBJ, 'low', 'enum'],
  ['web_search_options', STR, {}, 'object'],
  ['moderation', STR, undefined, 'object?'],
  ['zzz_unknown', 1, undefined, 'control: unknown'],
];

const RESPONSES_KEYS = [
  ['input', OBJ, undefined, 'string|array'],
  ['instructions', OBJ, 'Answer briefly.', 'string'],
  ['max_output_tokens', STR, undefined, 'integer (base body carries it)'],
  ['max_tool_calls', STR, 1, 'integer'],
  ['temperature', STR, undefined, 'measured 2026-08-29'],
  ['top_p', STR, undefined, 'measured 2026-08-29'],
  ['top_logprobs', STR, 1, 'integer'],
  ['stream', STR, undefined, 'boolean'],
  ['stream_options', STR, undefined, 'object'],
  ['text', STR, { verbosity: 'low' }, 'object'],
  ['tools', STR, undefined, 'array'],
  ['tool_choice', 7, undefined, 'string|object'],
  ['parallel_tool_calls', STR, false, 'boolean'],
  ['reasoning', STR, { effort: 'low', summary: 'auto' }, 'object'],
  ['include', STR, ['reasoning.encrypted_content'], 'array'],
  ['store', STR, false, 'boolean'],
  ['background', STR, undefined, 'boolean (value probe would queue a run)'],
  ['previous_response_id', OBJ, 'resp_probe_does_not_exist', 'string'],
  ['conversation', OBJ, 'conv_probe_does_not_exist', 'string|object'],
  ['truncation', OBJ, 'auto', 'enum'],
  ['metadata', STR, { a: 'b' }, 'map'],
  ['user', OBJ, 'probe', 'string'],
  ['safety_identifier', OBJ, 'probe', 'string'],
  ['prompt_cache_key', OBJ, 'probe-key', 'string'],
  ['prompt_cache_retention', OBJ, 'in_memory', 'enum'],
  ['prompt_cache_options', STR, { ttl: '30m' }, 'object'],
  ['service_tier', OBJ, 'default', 'enum'],
  ['prompt', STR, { id: 'pmpt_probe_does_not_exist' }, 'object'],
  ['context_management', STR, [{ type: 'compaction', compact_threshold: 100000 }], 'array'],
  ['moderation', STR, undefined, 'object?'],
  ['presence_penalty', STR, 0.5, 'echoed by P-1; request key?'],
  ['frequency_penalty', STR, 0.5, 'echoed by P-1; request key?'],
  ['messages', STR, undefined, 'Chat key on Responses'],
  ['n', STR, undefined, 'Chat key on Responses'],
  ['stop', OBJ, undefined, 'Chat key on Responses'],
  ['seed', STR, undefined, 'Chat key on Responses'],
  ['logprobs', STR, undefined, 'Chat key on Responses'],
  ['max_tokens', STR, undefined, 'Chat key on Responses'],
  ['zzz_unknown', 1, undefined, 'control: unknown'],
];

// The Messages key set was measured 2026-08-30 (§5.5.4). Only the value probes
// the handoff still lists (A-17/27/28/30/32/35) run here.
const MESSAGES_VALUES = [
  ['metadata', { user_id: 'probe-user' }, 'A-27 valid'],
  ['metadata', { user_id: 7 }, 'A-27 wrong type inside'],
  ['metadata', { bogus: 'x' }, 'A-27 unknown member'],
  ['service_tier', 'standard_only', 'A-28 valid; look for usage.service_tier'],
  ['service_tier', 'bogus', 'A-28 enum'],
  ['inference_geo', 'us', 'A-30 value'],
  ['inference_geo', 'bogus-geo', 'A-30 enum?'],
  ['container', 'container_probe_does_not_exist', 'A-32 value'],
  ['stop_sequences', 'ZZ', 'A-17 wrong type (string)'],
  ['stop_sequences', [1], 'A-17 wrong member type'],
  ['stop_sequences', [], 'A-17 empty'],
];

// Some value probes need a companion field to be meaningful.
function companions(surface, key, value) {
  if (surface === 'chat' && key === 'function_call') return { functions: [{ name: 'f', parameters: { type: 'object', properties: {} } }] };
  if (surface === 'chat' && key === 'parallel_tool_calls') return { tools: [{ type: 'function', function: { name: 'f', parameters: { type: 'object', properties: {} } } }] };
  if (surface === 'responses' && key === 'parallel_tool_calls') return { tools: [{ type: 'function', name: 'f', parameters: { type: 'object', properties: {} } }] };
  if (surface === 'chat' && key === 'audio') return { modalities: ['text', 'audio'] };
  return {};
}

// ------------------------------------------------------------------- run
proveClassifier();
const run = startCaptureRun({
  dir: resolve(repoRoot, 'artifacts/direct-api-captures'),
  meta: { plan: 'handoff §4-3-a text surface keys', openAiModel, anthropicModel },
});
console.log(`captures: ${run.runDir}\n`);

const phases = phaseArg ? [phaseArg] : ['keys', 'values', 'echo', 'order'];
const rows = [];

async function probe({ surface, label, url, provider, body, headers: extraHeaders = {} }) {
  if (grep && !label.includes(grep)) return;
  const headers = provider === 'openai'
    ? { authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'content-type': 'application/json' }
    : { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'content-type': 'application/json', 'anthropic-version': '2023-06-01', ...extraHeaders };
  const requestBody = JSON.stringify(body);
  const startedAt = Date.now();
  let res; let text = '';
  try {
    res = await fetch(url, { method: 'POST', headers, body: requestBody });
    text = await res.text();
  } catch (err) {
    recordExchange({ kind: 'json', label, url, requestHeaders: headers, requestBody, error: err, durationMs: Date.now() - startedAt });
    rows.push({ surface, label, error: String(err) });
    return;
  }
  recordExchange({ kind: 'json', label, url, requestHeaders: headers, requestBody, status: res.status, statusText: res.statusText, responseHeaders: res.headers, responseBody: text, durationMs: Date.now() - startedAt });
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  const err = json?.error ?? null;
  const row = {
    surface, label, status: res.status, class: classify(res.status, json),
    ...(err ? { param: err.param ?? null, code: err.code ?? null, message: String(err.message ?? '').slice(0, 220) } : {}),
  };
  if (res.status === 200 && json) row.echo = echoOf(surface, json, body);
  rows.push(row);
  console.log(`${surface.padEnd(9)} ${label.padEnd(44)} ${String(res.status).padEnd(4)} ${row.class}${err ? `  ${err.param ?? ''} — ${String(err.message ?? '').slice(0, 140)}` : row.echo ? `  echo ${JSON.stringify(row.echo)}` : ''}`);
}

function echoOf(surface, json, body) {
  if (surface === 'chat') {
    const choice = json.choices?.[0] ?? {};
    return {
      choices: json.choices?.length, service_tier: json.service_tier, system_fingerprint: json.system_fingerprint,
      finish_reason: choice.finish_reason, logprobs: choice.logprobs === undefined ? '(absent)' : choice.logprobs,
      keys: Object.keys(json).sort().join(','),
    };
  }
  if (surface === 'responses') {
    const picked = {};
    for (const key of Object.keys(body)) if (key in json) picked[key] = json[key];
    return { status: json.status, picked, outputTypes: (json.output ?? []).map((item) => item.type) };
  }
  return { stop_reason: json.stop_reason, stop_sequence: json.stop_sequence, usage: json.usage };
}

for (const phase of phases) {
  console.log(`\n=== phase ${phase} ===`);
  if (phase === 'keys') {
    if (!only || only === 'chat') {
      for (const [key, wrong] of CHAT_KEYS) {
        await probe({ surface: 'chat', label: `key ${key} (wrong type)`, url: `${OPENAI}/v1/chat/completions`, provider: 'openai', body: { ...chatBase(), [key]: wrong } });
      }
    }
    if (!only || only === 'responses') {
      for (const [key, wrong] of RESPONSES_KEYS) {
        await probe({ surface: 'responses', label: `key ${key} (wrong type)`, url: `${OPENAI}/v1/responses`, provider: 'openai', body: { ...responsesBase(), [key]: wrong } });
      }
    }
  }
  if (phase === 'values') {
    if (!only || only === 'chat') {
      for (const [key, , valid] of CHAT_KEYS) {
        if (valid === undefined) continue;
        await probe({ surface: 'chat', label: `value ${key}=${short(valid)}`, url: `${OPENAI}/v1/chat/completions`, provider: 'openai', body: { ...chatBase(), ...companions('chat', key, valid), [key]: valid } });
      }
      // The ones that need a companion to be meaningful, as extra rows.
      await probe({ surface: 'chat', label: 'value logprobs+top_logprobs', url: `${OPENAI}/v1/chat/completions`, provider: 'openai', body: { ...chatBase(), logprobs: true, top_logprobs: 1 } });
      await probe({ surface: 'chat', label: 'value modalities text+audio', url: `${OPENAI}/v1/chat/completions`, provider: 'openai', body: { ...chatBase(), modalities: ['text', 'audio'], audio: { voice: 'alloy', format: 'wav' } } });
      await probe({ surface: 'chat', label: 'value messages[].name', url: `${OPENAI}/v1/chat/completions`, provider: 'openai', body: { ...chatBase(), messages: [{ role: 'user', name: 'alice', content: 'ping' }] } });
      await probe({ surface: 'chat', label: 'value messages[].refusal (assistant)', url: `${OPENAI}/v1/chat/completions`, provider: 'openai', body: { ...chatBase(), messages: [{ role: 'user', content: 'ping' }, { role: 'assistant', refusal: 'no' }, { role: 'user', content: 'ping' }] } });
      await probe({ surface: 'chat', label: 'value messages[].bogus', url: `${OPENAI}/v1/chat/completions`, provider: 'openai', body: { ...chatBase(), messages: [{ role: 'user', content: 'ping', bogus: 1 }] } });
      await probe({ surface: 'chat', label: 'value service_tier=flex', url: `${OPENAI}/v1/chat/completions`, provider: 'openai', body: { ...chatBase(), service_tier: 'flex' } });
      await probe({ surface: 'chat', label: 'value service_tier=bogus', url: `${OPENAI}/v1/chat/completions`, provider: 'openai', body: { ...chatBase(), service_tier: 'bogus' } });
      await probe({ surface: 'chat', label: 'value reasoning_effort=max', url: `${OPENAI}/v1/chat/completions`, provider: 'openai', body: { ...chatBase(), reasoning_effort: 'max' } });
      await probe({ surface: 'chat', label: 'value reasoning_effort=bogus', url: `${OPENAI}/v1/chat/completions`, provider: 'openai', body: { ...chatBase(), reasoning_effort: 'bogus' } });
      await probe({ surface: 'chat', label: 'value tool_choice=bogus (with tools)', url: `${OPENAI}/v1/chat/completions`, provider: 'openai', body: { ...chatBase(), tools: [{ type: 'function', function: { name: 'f', parameters: { type: 'object', properties: {} } } }], tool_choice: 'bogus' } });
      await probe({ surface: 'chat', label: 'value n=0', url: `${OPENAI}/v1/chat/completions`, provider: 'openai', body: { ...chatBase(), n: 0 } });
      await probe({ surface: 'chat', label: 'value metadata 17 pairs', url: `${OPENAI}/v1/chat/completions`, provider: 'openai', body: { ...chatBase(), metadata: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, 'v'])) } });
    }
    if (!only || only === 'responses') {
      for (const [key, , valid] of RESPONSES_KEYS) {
        if (valid === undefined) continue;
        await probe({ surface: 'responses', label: `value ${key}=${short(valid)}`, url: `${OPENAI}/v1/responses`, provider: 'openai', body: { ...responsesBase(), ...companions('responses', key, valid), [key]: valid } });
      }
      await probe({ surface: 'responses', label: 'value store=false+include encrypted', url: `${OPENAI}/v1/responses`, provider: 'openai', body: { ...responsesBase(), store: false, include: ['reasoning.encrypted_content'] } });
      await probe({ surface: 'responses', label: 'value top_logprobs+include logprobs', url: `${OPENAI}/v1/responses`, provider: 'openai', body: { ...responsesBase(), top_logprobs: 1, include: ['message.output_text.logprobs'] } });
      await probe({ surface: 'responses', label: 'value include=[bogus]', url: `${OPENAI}/v1/responses`, provider: 'openai', body: { ...responsesBase(), include: ['bogus.thing'] } });
      await probe({ surface: 'responses', label: 'value truncation=bogus', url: `${OPENAI}/v1/responses`, provider: 'openai', body: { ...responsesBase(), truncation: 'bogus' } });
      await probe({ surface: 'responses', label: 'value service_tier=flex', url: `${OPENAI}/v1/responses`, provider: 'openai', body: { ...responsesBase(), service_tier: 'flex' } });
      await probe({ surface: 'responses', label: 'value reasoning.effort=max', url: `${OPENAI}/v1/responses`, provider: 'openai', body: { ...responsesBase(), reasoning: { effort: 'max' } } });
      await probe({ surface: 'responses', label: 'value reasoning.summary=bogus', url: `${OPENAI}/v1/responses`, provider: 'openai', body: { ...responsesBase(), reasoning: { summary: 'bogus' } } });
      await probe({ surface: 'responses', label: 'value reasoning.generate_summary=auto', url: `${OPENAI}/v1/responses`, provider: 'openai', body: { ...responsesBase(), reasoning: { generate_summary: 'auto' } } });
      await probe({ surface: 'responses', label: 'value reasoning.bogus', url: `${OPENAI}/v1/responses`, provider: 'openai', body: { ...responsesBase(), reasoning: { bogus: 1 } } });
      await probe({ surface: 'responses', label: 'value tool_choice=bogus (with tools)', url: `${OPENAI}/v1/responses`, provider: 'openai', body: { ...responsesBase(), tools: [{ type: 'function', name: 'f', parameters: { type: 'object', properties: {} } }], tool_choice: 'bogus' } });
      await probe({ surface: 'responses', label: 'value max_tool_calls=0', url: `${OPENAI}/v1/responses`, provider: 'openai', body: { ...responsesBase(), max_tool_calls: 0 } });
      await probe({ surface: 'responses', label: 'value metadata 17 pairs', url: `${OPENAI}/v1/responses`, provider: 'openai', body: { ...responsesBase(), metadata: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, 'v'])) } });
      await probe({ surface: 'responses', label: 'value input[].bogus', url: `${OPENAI}/v1/responses`, provider: 'openai', body: { ...responsesBase(), input: [{ role: 'user', content: 'ping', bogus: 1 }] } });
    }
    if (!only || only === 'messages') {
      for (const [key, value, note] of MESSAGES_VALUES) {
        await probe({ surface: 'messages', label: `value ${key}=${short(value)} (${note})`, url: `${ANTHROPIC}/v1/messages`, provider: 'anthropic', body: { ...messagesBase(), [key]: value } });
      }
      await probe({ surface: 'messages', label: 'header anthropic-beta=bogus', url: `${ANTHROPIC}/v1/messages`, provider: 'anthropic', body: messagesBase(), headers: { 'anthropic-beta': 'bogus-beta-2020-01-01' } });
      await probe({ surface: 'messages', label: 'value metadata.user_id + stop_sequences hit', url: `${ANTHROPIC}/v1/messages`, provider: 'anthropic', body: { ...messagesBase(), max_tokens: 32, stop_sequences: ['ZZ'], messages: [{ role: 'user', content: 'Reply with exactly: AAZZBB' }] } });
    }
  }
}

// Chat on a reasoning model answers `max_completion_tokens: 1` with a 400
// "Could not finish the message" AFTER validation, which proves acceptance
// but hides the echo. These run with `reasoning_effort: 'none'` and room to
// finish, so the response body can be read: `service_tier`,
// `system_fingerprint`, `choices` length, `logprobs`, and whether tools run.
const chatEcho = () => ({ ...chatBase(), reasoning_effort: 'none', max_completion_tokens: 32 });
const CHAT_ECHO = [
  ['echo baseline (effort none)', {}],
  ['echo service_tier=flex', { service_tier: 'flex' }],
  ['echo service_tier=default', { service_tier: 'default' }],
  ['echo service_tier=priority', { service_tier: 'priority' }],
  ['echo seed=1', { seed: 1 }],
  ['echo n=2', { n: 2 }],
  ['echo messages[].name', { messages: [{ role: 'user', name: 'alice', content: 'ping' }] }],
  ['echo messages[].bogus', { messages: [{ role: 'user', content: 'ping', bogus: 1 }] }],
  ['echo messages[].refusal (assistant)', { messages: [{ role: 'user', content: 'ping' }, { role: 'assistant', refusal: 'no' }, { role: 'user', content: 'ping' }] }],
  ['echo store=true', { store: true }],
  ['echo metadata+user+safety_identifier', { metadata: { a: 'b' }, user: 'probe', safety_identifier: 'probe' }],
  ['echo prompt_cache_key+options', { prompt_cache_key: 'probe-key', prompt_cache_options: { ttl: '30m' } }],
  ['echo prompt_cache_retention=24h', { prompt_cache_retention: '24h' }],
  ['echo verbosity=low', { verbosity: 'low' }],
  ['echo tools (effort none)', { tools: [{ type: 'function', function: { name: 'f', parameters: { type: 'object', properties: {} } } }] }],
  ['echo parallel_tool_calls=false (effort none)', { tools: [{ type: 'function', function: { name: 'f', parameters: { type: 'object', properties: {} } } }], parallel_tool_calls: false }],
  ['echo functions+function_call (effort none)', { functions: [{ name: 'f', parameters: { type: 'object', properties: {} } }], function_call: 'auto' }],
  ['echo stop (effort none)', { stop: ['ZZ'] }],
  ['echo logprobs (effort none)', { logprobs: true }],
  ['echo max_tokens (effort none)', { max_tokens: 32, max_completion_tokens: undefined }],
  ['echo moderation={}', { moderation: {} }],
  ['echo response_format=json_object', { response_format: { type: 'json_object' }, messages: [{ role: 'user', content: 'Reply with a JSON object {"ok":true}' }] }],
  ['echo frequency_penalty=0.5 (effort none)', { frequency_penalty: 0.5 }],
  ['echo presence_penalty=0.5 (effort none)', { presence_penalty: 0.5 }],
  ['echo top_logprobs=1 without logprobs (effort none)', { top_logprobs: 1 }],
  ['echo moderation={model}', { moderation: { model: 'omni-moderation-latest' } }],
];
// Which fault the direct API reports first when a body carries two. Every
// body here is invalid on both counts, so nothing generates.
const CHAT_ORDER = [
  ['order unknown+type(n)', { zzz_unknown: 1, n: 'abc' }],
  ['order unknown+unsupported(stop)', { zzz_unknown: 1, stop: ['ZZ'] }],
  ['order type(n)+unsupported(stop)', { n: 'abc', stop: ['ZZ'] }],
  ['order unknown+temperature0.5', { zzz_unknown: 1, temperature: 0.5 }],
  ['order unknown+missing model', { zzz_unknown: 1, model: undefined }],
  ['order unknown+empty messages', { zzz_unknown: 1, messages: [] }],
  ['order unknown+n0', { zzz_unknown: 1, n: 0 }],
  ['order unsupported(stop)+temperature0.5', { stop: ['ZZ'], temperature: 0.5 }],
  ['order unsupported(stop)+n0', { stop: ['ZZ'], n: 0 }],
  ['order type(n)+temperature0.5', { n: 'abc', temperature: 0.5 }],
  ['order unknown+bad service_tier', { zzz_unknown: 1, service_tier: 'bogus' }],
  ['order unknown+reasoning_effort max', { zzz_unknown: 1, reasoning_effort: 'max' }],
];
const RESPONSES_ORDER = [
  ['order unknown+type(max_output_tokens)', { zzz_unknown: 1, max_output_tokens: 'abc' }],
  ['order unknown+messages', { zzz_unknown: 1, messages: [] }],
  ['order unknown+previous bogus', { zzz_unknown: 1, previous_response_id: 'resp_probe_does_not_exist' }],
  ['order type+previous bogus', { max_output_tokens: 'abc', previous_response_id: 'resp_probe_does_not_exist' }],
  ['order unknown+temperature0.5', { zzz_unknown: 1, temperature: 0.5 }],
  ['order unknown+missing model', { zzz_unknown: 1, model: undefined }],
  ['order unknown+truncation bogus', { zzz_unknown: 1, truncation: 'bogus' }],
  ['order unknown+input[0].bogus', { zzz_unknown: 1, input: [{ role: 'user', content: 'ping', bogus: 1 }] }],
  ['order messages+temperature0.5', { messages: [], temperature: 0.5 }],
  ['order top_logprobs+effort none', { top_logprobs: 1, reasoning: { effort: 'none' } }],
  ['order unknown+max_tool_calls 0', { zzz_unknown: 1, max_tool_calls: 0 }],
];
for (const phase of phases) {
  if (phase === 'echo' && (!only || only === 'chat')) {
    console.log('\n=== phase echo ===');
    for (const [label, extra] of CHAT_ECHO) {
      const body = { ...chatEcho(), ...extra };
      for (const key of Object.keys(body)) if (body[key] === undefined) delete body[key];
      await probe({ surface: 'chat', label, url: `${OPENAI}/v1/chat/completions`, provider: 'openai', body });
    }
  }
  if (phase === 'order') {
    console.log('\n=== phase order ===');
    if (!only || only === 'chat') {
      for (const [label, extra] of CHAT_ORDER) {
        const body = { ...chatBase(), ...extra };
        for (const key of Object.keys(body)) if (body[key] === undefined) delete body[key];
        await probe({ surface: 'chat', label, url: `${OPENAI}/v1/chat/completions`, provider: 'openai', body });
      }
    }
    if (!only || only === 'responses') {
      for (const [label, extra] of RESPONSES_ORDER) {
        const body = { ...responsesBase(), ...extra };
        for (const key of Object.keys(body)) if (body[key] === undefined) delete body[key];
        await probe({ surface: 'responses', label, url: `${OPENAI}/v1/responses`, provider: 'openai', body });
      }
    }
  }
}

console.log(`\n${JSON.stringify({ openAiModel, anthropicModel, captures: captureSummary(), rows }, null, 2)}`);

function short(value) {
  const s = JSON.stringify(value);
  return s.length > 40 ? `${s.slice(0, 37)}...` : s;
}
function readArg(name) {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
}
