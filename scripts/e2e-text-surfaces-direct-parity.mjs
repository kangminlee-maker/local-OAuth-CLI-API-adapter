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
const ANTHROPIC = 'https://api.anthropic.com';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_MODEL = readArg('--anthropic-model') ?? 'claude-sonnet-5';
const MESSAGES = '/v1/messages';
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
let skipped = 0;
function record(name, ok, detail = '') {
  checks += 1;
  if (!ok) failures += 1;
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'} ${name} ${detail}\n`);
}

/**
 * A row whose body the direct API ACCEPTS is not a rejection probe, and the
 * refusing backend turns the proxy's acceptance into a 500 — so comparing
 * envelopes reports FAIL for two completely different situations. Tell them
 * apart instead of printing one word for both:
 *
 *   proxy also accepted  -> the row is mis-filed, not a defect (SKIP)
 *   proxy REFUSED        -> the worst direction there is, and the whole reason
 *                           this instrument exists (FAIL, loudly)
 *
 * Written after a run reported five FAILs that were all mis-filed rows, which
 * cost a full re-derivation to tell from real over-refusal.
 */
const REACHED_BACKEND = 'a rejection case reached the backend';
function recordAcceptedByDirect(name, p) {
  const proxyAccepted = p.status === 200 || p.text.includes(REACHED_BACKEND);
  if (proxyAccepted) {
    skipped += 1;
    process.stdout.write(`SKIP parity ${name} — the direct API accepts this body; the proxy accepts it too, so it is not a free probe. Pin it in the offline ACCEPTED table instead.\n`);
    return;
  }
  record(`parity ${name}`, false,
    `\n   !! OVER-REFUSAL: direct accepted this body (200) and the proxy answered ${p.status}.\n   proxy : ${p.text.slice(0, 300)}`);
}

/**
 * One hung direct request must not take down a 400-row sweep. Twice now a
 * single call sat until undici's 300s HTTP/2 stream timeout and killed the
 * whole run with an uncaught `fetch failed`, losing every row after it. Each
 * attempt gets its own deadline and a couple of retries; a row that still
 * cannot be measured is reported as a LOUD failure rather than crashing the
 * process, so the run finishes and names exactly what went unmeasured.
 */
const POST_TIMEOUT_MS = 45_000;
const POST_ATTEMPTS = 3;

async function post(base, path, body, headers = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= POST_ATTEMPTS; attempt += 1) {
    try {
      const res = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(POST_TIMEOUT_MS),
      });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* not JSON */ }
      return { status: res.status, text, json };
    } catch (err) {
      lastErr = err;
      if (attempt < POST_ATTEMPTS) await new Promise((r) => setTimeout(r, 1_000 * attempt));
    }
  }
  // Not a measurement. Never let this shape read as a matching envelope.
  return {
    status: 0,
    text: `UNMEASURED: ${base}${path} failed ${POST_ATTEMPTS}x — ${lastErr?.message ?? lastErr}`,
    json: null,
    unmeasured: true,
  };
}

function envelope(r) {
  return r.json?.error
    ? { status: r.status, type: r.json.error.type, param: r.json.error.param ?? null, code: r.json.error.code ?? null, message: r.json.error.message }
    : { status: r.status, keys: Object.keys(r.json ?? {}).sort() };
}

// The Anthropic envelope is its own shape: `{type:'error', error:{type,message}}`
// with neither `param` nor `code`, so it gets its own reader and its own
// comparison rather than being forced through the OpenAI one.
function anthropicEnvelope(r) {
  return r.json?.error
    ? { status: r.status, type: r.json.error.type, message: r.json.error.message }
    : { status: r.status, keys: Object.keys(r.json ?? {}).sort() };
}

async function anthropicParity(name, body) {
  const sent = { model: ANTHROPIC_MODEL, max_tokens: 16, messages: [{ role: 'user', content: 'ping' }], ...body };
  for (const key of Object.keys(sent)) if (sent[key] === DELETE) delete sent[key];
  const [p, d] = await Promise.all([
    post(started.url, MESSAGES, sent),
    post(ANTHROPIC, MESSAGES, sent, { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' }),
  ]);
  // Two unmeasured sides compare EQUAL and would read as PASS. An absent
  // measurement is never agreement.
  if (p.unmeasured || d.unmeasured) {
    record(`parity ${name}`, false, `\n   !! UNMEASURED — this row proves nothing.\n   proxy : ${p.unmeasured ? p.text : 'ok'}\n   direct: ${d.unmeasured ? d.text : 'ok'}`);
    return;
  }
  if (d.status === 200 && !generate) {
    recordAcceptedByDirect(name, p);
    return;
  }
  const pe = anthropicEnvelope(p);
  const de = anthropicEnvelope(d);
  const same = JSON.stringify(pe) === JSON.stringify(de);
  record(`parity ${name}`, same, same
    ? `→ ${de.status} ${de.message ?? ''}`
    : `\n   proxy : ${JSON.stringify(pe)}\n   direct: ${JSON.stringify(de)}`);
}

async function parity(name, path, body) {
  const sent = { model: MODEL, ...body };
  for (const key of Object.keys(sent)) if (sent[key] === DELETE) delete sent[key];
  const [p, d] = await Promise.all([
    post(started.url, path, sent),
    post(DIRECT, path, sent, { authorization: `Bearer ${KEY}` }),
  ]);
  // Two unmeasured sides compare EQUAL and would read as PASS. An absent
  // measurement is never agreement.
  if (p.unmeasured || d.unmeasured) {
    record(`parity ${name}`, false, `\n   !! UNMEASURED — this row proves nothing.\n   proxy : ${p.unmeasured ? p.text : 'ok'}\n   direct: ${d.unmeasured ? d.text : 'ok'}`);
    return;
  }
  if (d.status === 200 && !generate) {
    recordAcceptedByDirect(name, p);
    return;
  }
  const pe = envelope(p);
  const de = envelope(d);
  const same = JSON.stringify(pe) === JSON.stringify(de);
  record(`parity ${name}`, same, same
    ? `→ ${de.status} ${de.code ?? ''} ${de.param ?? ''}`
    : `\n   proxy : ${JSON.stringify(pe)}\n   direct: ${JSON.stringify(de)}`);
}

const DELETE = Symbol('delete the key');
const M = [{ role: 'user', content: 'ping' }];
const WRONG = { __probe__: 'wrong type' };

/**
 * The adjacent edges of a measured report order, generated from ONE list
 * instead of hand-picked. A hand-picked subset is how `store` and `metadata`
 * came to sit next to each other in the Chat validator with nothing pinning
 * the pair: swapping the two checks changed which fault a two-fault body
 * reported and no row noticed.
 *
 * Only keys whose WRONG-TYPE value makes the direct API answer about that key
 * belong in a list here — the always-refused ones (`stop`, `logit_bias`,
 * `max_tokens`, ...) answer `unsupported_parameter` whatever you send, and a
 * mixed-kind pair does not test the order at all. Those keep their own
 * hand-written rows above, because kind changes the order.
 *
 * Each row sends the LATER key first, so a surface that answered about the
 * first key it read would fail every one of them.
 */
function adjacentOrderRows(order, base) {
  const rows = [];
  for (let i = 0; i + 1 < order.length; i += 1) {
    const [[a, aFault], [b, bFault]] = [order[i], order[i + 1]];
    rows.push([`order ${a} before ${b} (adjacent)`, { ...base, [b]: bFault, [a]: aFault }]);
  }
  return rows;
}

// The Chat order (§5.5.5), restricted to its type-faultable keys: 22 of 33,
// every adjacent edge of them measured 2026-08-31 (20 by sweep, 2 by hand).
const CHAT_TYPE_FAULT_ORDER = [
  ['messages', 'wrong type'], ['functions', 'wrong type'], ['tools', 'wrong type'],
  ['parallel_tool_calls', WRONG], ['max_completion_tokens', WRONG], ['n', WRONG],
  ['temperature', WRONG], ['top_p', WRONG], ['presence_penalty', WRONG], ['frequency_penalty', WRONG],
  ['logprobs', WRONG], ['top_logprobs', WRONG], ['user', WRONG], ['seed', WRONG],
  ['safety_identifier', WRONG], ['prompt_cache_key', WRONG], ['prompt_cache_retention', WRONG],
  ['service_tier', WRONG], ['stream', WRONG], ['store', WRONG], ['metadata', 'wrong type'],
  ['verbosity', WRONG],
];
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
  // `content` is required on every message, and it is the LAST check of all —
  // measured 2026-08-31 on three model families with a positive control. Its
  // param is the dotted-bracket `messages.[i].content` and it carries no code.
  ['chat content absent', { messages: [{ role: 'user' }] }],
  ['chat content null', { messages: [{ role: 'user', content: null }] }],
  ['chat content absent at index 1', { messages: [{ role: 'user', content: 'a' }, { role: 'assistant' }] }],
  ['chat content absent on a system item', { messages: [{ role: 'system' }, { role: 'user', content: 'a' }] }],
  ['chat content absent loses to an unknown key', { messages: [{ role: 'user' }], zzz_unknown: 1 }],
  ['chat content absent loses to the capability pass', { messages: [{ role: 'user' }], temperature: 0.5 }],
  ['chat content absent loses to a field type fault', { messages: [{ role: 'user' }], n: 'x' }],
  ['chat content absent loses to a content type fault', { messages: [{ role: 'user' }, { role: 'user', content: 7 }] }],
  ['chat content absent loses to a bad role', { messages: [{ role: 'user' }, { role: 'bogus', content: 'x' }] }],
  ['chat content absent on a tool item', { messages: [{ role: 'user', content: 'a' }, { role: 'assistant', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 'c1' }] }],
  ['chat messages null is a type fault', { messages: null }],
  ['chat messages as a string is a type fault', { messages: 'x' }],
  // `developer` answers in its own words, and a null substitute is no substitute.
  ['chat content absent on a developer item', { messages: [{ role: 'user', content: 'a' }, { role: 'developer' }] }],
  ['chat content null on a developer item', { messages: [{ role: 'user', content: 'a' }, { role: 'developer', content: null }] }],
  ['chat assistant refusal null is no substitute', { messages: [{ role: 'user', content: 'a' }, { role: 'assistant', refusal: null }] }],
  ['chat assistant tool_calls null is no substitute', { messages: [{ role: 'user', content: 'a' }, { role: 'assistant', tool_calls: null }] }],
  ['chat assistant function_call null is no substitute', { messages: [{ role: 'user', content: 'a' }, { role: 'assistant', function_call: null }] }],
  // An empty `tool_calls` is its own refusal, in the messages phase.
  ['chat assistant tool_calls empty', { messages: [{ role: 'user', content: 'a' }, { role: 'assistant', tool_calls: [] }] }],
  ['chat assistant tool_calls empty beside content', { messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'x', tool_calls: [] }] }],
  ['chat assistant tool_calls empty beats the capability pass', { messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'x', tool_calls: [] }], temperature: 0.5 }],
  ['chat assistant tool_calls empty beats a later bad role', { messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'x', tool_calls: [] }, { role: 'bogus', content: 'x' }] }],
  ['chat assistant tool_calls empty loses to an unknown key', { messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'x', tool_calls: [] }], zzz_unknown: 1 }],
  ['chat assistant tool_calls wrong type', { messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'x', tool_calls: 'x' }] }],
  ['chat assistant tool_calls loses to a content type fault', { messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 7, tool_calls: [] }] }],
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
  ['frequency_penalty above its range', { messages: M, reasoning_effort: 'none', frequency_penalty: 3 }],
  ['presence_penalty below its range', { messages: M, reasoning_effort: 'none', presence_penalty: -3 }],
  ['json_schema format without its member', { messages: M, response_format: { type: 'json_schema' } }],
  ['json_schema member without a name', { messages: M, response_format: { type: 'json_schema', json_schema: {} } }],
  ['stream_options unknown member', { messages: M, stream_options: { bogus: 1 } }],
  ['model null', { messages: M, model: null }],
  ['chat prompt_cache_retention outside the enum', { messages: M, prompt_cache_retention: 'x' }],
  ['chat reasoning_effort unknown', { messages: M, reasoning_effort: 'bogus' }],
  // Spelling help on an unknown key: offered for a near miss, withheld when the
  // key it would suggest is already in the body.
  ['chat unknown near store', { messages: M, stor: 1 }],
  ['chat unknown near temperature', { messages: M, temperatur: 1 }],
  ['chat unknown near a key already sent', { messages: M, messagess: 1 }],
  // Report order: each of these is invalid twice. The order is measured, not a
  // rule — a comparison sort over the same-kind faults plus these pins.
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
  ['order seed before service_tier', { messages: M, seed: 1.5, service_tier: 'bogus' }],
  ['order n before metadata', { messages: M, metadata: { k: 7 }, n: 0 }],
  ['order max_completion_tokens before logprobs', { messages: M, logprobs: 'x', max_completion_tokens: 0 }],
  ['order messages before metadata', { messages: [7], metadata: { k: 7 } }],
  ['order n before moderation', { messages: M, moderation: {}, n: 0 }],
  ['order stream before store', { messages: M, store: 'x', stream: 'y' }],
  ['order tools before top_logprobs', { messages: M, tools: 'x', top_logprobs: -1 }],
  ['order user before verbosity', { messages: M, user: 7, verbosity: 'bogus' }],
  ['order functions before function_call', { messages: M, function_call: {}, functions: 'x' }],
  ['order prompt_cache_options before prompt_cache_key', { messages: M, prompt_cache_key: 7, prompt_cache_options: 'x' }],
  ['order max_tokens before store', { messages: M, max_tokens: 32, store: 'x' }],
  ['order stop before stream_options', { messages: M, stop: ['ZZ'], stream_options: 'x' }],
  ['order stop before verbosity', { messages: M, stop: ['ZZ'], verbosity: 'bogus' }],
  ['order metadata before prediction', { messages: M, prediction: { type: 'content', content: 'p' }, metadata: 'x' }],
  ['order logit_bias before verbosity', { messages: M, logit_bias: { 1: 1 }, verbosity: 'bogus' }],
  ['order metadata before a refused temperature', { messages: M, temperature: 0.5, metadata: 'x' }],
  ['order verbosity before a refused logprobs', { messages: M, logprobs: true, verbosity: 'bogus' }],
  ['order reasoning_effort before metadata', { messages: M, reasoning_effort: 'bogus', metadata: 'x' }],
  ...adjacentOrderRows(CHAT_TYPE_FAULT_ORDER, { messages: M }),
];

// The Responses surface. Same rule as the Chat rows: every default case is
// invalid on both sides, so nothing generates. `I`/`OUT` keep the bodies short.
// `temperature: 0.5` rides along as a TRIPWIRE where a row asks "is this
// member known?": the model-capability pass runs after every field check, so
// the tripwire's own error only surfaces when nothing earlier is faulty.
const I = 'ping';
const OUT = { input: I, max_output_tokens: 16 };
const RTOOL = { type: 'function', name: 'f', parameters: { type: 'object', properties: {} } };
// The item shape this proxy's own `output` carries, which a client feeds back
// as input to hold a conversation on a surface that stores none.
const ASSISTANT_ITEM = (phase = 'final_answer') => ({
  id: 'msg_probe', type: 'message', status: 'completed', role: 'assistant', phase,
  content: [{ type: 'output_text', annotations: [], logprobs: [], text: 'OK' }],
});
const responsesCases = [
  // Keys this surface does not know — four of them are Chat's.
  ['responses unknown key', { ...OUT, zzz_unknown: 1 }],
  ['responses n', { ...OUT, n: 2 }],
  ['responses stop', { ...OUT, stop: ['ZZ'] }],
  ['responses seed', { ...OUT, seed: 1 }],
  ['responses logprobs', { ...OUT, logprobs: true }],
  ['responses max_tokens', { ...OUT, max_tokens: 16 }],
  ['responses messages instead of input', { ...OUT, messages: M }],
  // model — measured as a different sentence from Chat's.
  ['responses model absent', { ...OUT, model: DELETE }],
  ['responses model null', { ...OUT, model: null }],
  ['responses model empty', { ...OUT, model: '' }],
  ['responses model as an integer', { ...OUT, model: 7 }],
  // `input`, which the proxy used to substitute rather than require. Its
  // absence outranks everything but `model`; an input that is PRESENT but
  // carries nothing is a different sentence with no `param` at all, placed
  // after the state phase and before the capability pass.
  ['responses input absent', { ...OUT, input: DELETE }],
  ['responses input absent beats an unknown key', { ...OUT, input: DELETE, zzz_unknown: 1 }],
  ['responses input absent beats a bad field', { ...OUT, input: DELETE, truncation: 'bogus' }],
  ['responses input absent beats the state phase', { ...OUT, input: DELETE, previous_response_id: 'resp_x' }],
  ['responses input absent loses to a missing model', { ...OUT, input: DELETE, model: DELETE }],
  ['responses input empty array', { ...OUT, input: [] }],
  ['responses input empty string', { ...OUT, input: '' }],
  ['responses input empty loses to an unknown key', { ...OUT, input: [], zzz_unknown: 1 }],
  ['responses input empty loses to a bad field', { ...OUT, input: [], truncation: 'bogus' }],
  ['responses input empty loses to the state phase', { ...OUT, input: [], previous_response_id: 'resp_x' }],
  ['responses input empty beats the capability pass', { ...OUT, input: [], temperature: 0.5 }],
  ['responses input null', { ...OUT, input: null }],
  // input, and the item members inside it.
  ['responses input as an object', { ...OUT, input: { a: 1 } }],
  ['responses input item unknown member', { ...OUT, input: [{ role: 'user', content: I, bogus: 1 }] }],
  ['responses input item status', { ...OUT, input: [{ role: 'user', content: I, status: 'completed' }], temperature: 0.5 }],
  ['responses input item id', { ...OUT, input: [{ role: 'user', content: I, id: 'msg_x' }], temperature: 0.5 }],
  ['responses input item type', { ...OUT, input: [{ type: 'message', role: 'user', content: I }], temperature: 0.5 }],
  // `phase` is the assistant item's own member — the shape this proxy emits.
  ['responses input item phase on a user item', { ...OUT, input: [{ role: 'user', content: I, phase: 'final_answer' }] }],
  ['responses input item phase unknown value', { ...OUT, input: [ASSISTANT_ITEM('bogus'), { role: 'user', content: I }] }],
  ['responses input item assistant unknown member', { ...OUT, input: [{ ...ASSISTANT_ITEM(), zzz: 1 }, { role: 'user', content: I }] }],
  ['responses input item assistant with input_text', { ...OUT, input: [{ role: 'assistant', content: [{ type: 'input_text', text: 'x' }] }, { role: 'user', content: I }] }],
  ['responses input item round trip', { ...OUT, input: [{ role: 'user', content: I }, ASSISTANT_ITEM(), { role: 'user', content: 'again' }], temperature: 0.5 }],
  // The item schema, at the `input` slot rather than after the whole walk.
  ['responses input item primitive', { ...OUT, input: [7] }],
  ['responses input item null', { ...OUT, input: [null] }],
  ['responses input item type not a string', { ...OUT, input: [{ type: 7, role: 'user', content: I }] }],
  ['responses input item type unknown', { ...OUT, input: [{ type: 'bogus_item' }] }],
  ['responses input item role unknown', { ...OUT, input: [{ role: 'bogus', content: I }] }],
  ['responses input item empty object', { ...OUT, input: [{}] }],
  ['responses input item without content', { ...OUT, input: [{ role: 'user' }] }],
  ['responses input item developer role', { ...OUT, input: [{ role: 'developer', content: I }, { role: 'user', content: I }], temperature: 0.5 }],
  ['responses input item beats a later field', { ...OUT, input: [{}], truncation: 'bogus' }],
  ['responses input item beats the state phase', { ...OUT, input: [{}], previous_response_id: 'resp_x' }],
  ['responses input item beats the capability pass', { ...OUT, input: [{}], temperature: 0.5 }],
  ['responses content block unknown type', { ...OUT, input: [{ role: 'user', content: [{ type: 'bogus', text: 'x' }] }] }],
  ['responses content block wrong variant', { ...OUT, input: [{ role: 'user', content: [{ type: 'output_text', text: 'x' }] }] }],
  ['responses content block without text', { ...OUT, input: [{ role: 'user', content: [{ type: 'input_text' }] }] }],
  ['responses content block refusal on assistant', { ...OUT, input: [{ role: 'assistant', content: [{ type: 'refusal', refusal: 'no' }] }, { role: 'user', content: I }], temperature: 0.5 }],
  // `text` and `tools`, which were array/object checks and nothing more.
  ['responses text unknown member', { ...OUT, text: { zzz: 1 } }],
  ['responses text format unknown type', { ...OUT, text: { format: { type: 'bogus' } } }],
  ['responses text json_schema without a name', { ...OUT, text: { format: { type: 'json_schema' } } }],
  ['responses text verbosity unknown', { ...OUT, text: { verbosity: 'bogus' } }],
  ['responses text beats a later field', { ...OUT, text: { verbosity: 'bogus' }, context_management: 'x' }],
  ['responses text beats the capability pass', { ...OUT, text: { verbosity: 'bogus' }, temperature: 0.5 }],
  ['responses tools member without a type', { ...OUT, tools: [{}] }],
  ['responses tools function without a name', { ...OUT, tools: [{ type: 'function' }] }],
  ['responses chat-shaped tool', { ...OUT, tools: [{ type: 'function', function: { name: 'f', parameters: { type: 'object', properties: {} } } }] }],
  // reasoning — its own enum, wider than Chat's.
  ['responses reasoning as a string', { ...OUT, reasoning: 'low' }],
  ['responses reasoning.effort unknown', { ...OUT, reasoning: { effort: 'bogus' } }],
  ['responses reasoning.effort as an object', { ...OUT, reasoning: { effort: { __probe__: 'wrong type' } } }],
  ['responses reasoning.summary unknown', { ...OUT, reasoning: { summary: 'bogus' } }],
  ['responses reasoning.generate_summary', { ...OUT, reasoning: { generate_summary: 'concise' } }],
  ['responses reasoning unknown member', { ...OUT, reasoning: { bogus: 1 } }],
  // Sampling and penalties: refused by parameter, and by type before that.
  ['responses temperature 0.5', { ...OUT, temperature: 0.5 }],
  ['responses temperature as a string', { ...OUT, temperature: 'hot' }],
  ['responses top_p 0.5', { ...OUT, top_p: 0.5 }],
  ['responses top_p as a string', { ...OUT, top_p: 'wide' }],
  ['responses presence_penalty', { ...OUT, presence_penalty: 0.5 }],
  ['responses frequency_penalty', { ...OUT, frequency_penalty: 0.5 }],
  ['responses presence_penalty as a string', { ...OUT, presence_penalty: 'x' }],
  // logprobs, by either door.
  ['responses top_logprobs', { ...OUT, top_logprobs: 1 }],
  ['responses top_logprobs as a string', { ...OUT, top_logprobs: 'x' }],
  ['responses include logprobs', { ...OUT, include: ['message.output_text.logprobs'] }],
  // Server-side state this proxy holds none of.
  ['responses previous_response_id unknown', { ...OUT, previous_response_id: 'resp_probe_does_not_exist' }],
  ['responses previous_response_id as an object', { ...OUT, previous_response_id: { a: 1 } }],
  ['responses conversation unknown', { ...OUT, conversation: 'conv_probe_does_not_exist' }],
  ['responses prompt id unknown', { ...OUT, prompt: { id: 'pmpt_probe_does_not_exist' } }],
  ['responses prompt as a string', { ...OUT, prompt: 'x' }],
  // Enums and bounds.
  ['responses truncation unknown', { ...OUT, truncation: 'bogus' }],
  ['responses truncation as an object', { ...OUT, truncation: { a: 1 } }],
  ['responses include unknown member', { ...OUT, include: ['bogus.thing'] }],
  ['responses include as a string', { ...OUT, include: 'wrong type' }],
  ['responses max_tool_calls 0', { ...OUT, max_tool_calls: 0 }],
  ['responses max_tool_calls as a string', { ...OUT, max_tool_calls: 'x' }],
  ['responses max_output_tokens 0', { ...OUT, max_output_tokens: 0 }],
  ['responses max_output_tokens as a string', { ...OUT, max_output_tokens: 'x' }],
  ['responses metadata too many properties', { ...OUT, metadata: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, 'v'])) }],
  ['responses metadata as a string', { ...OUT, metadata: 'x' }],
  ['responses service_tier unknown', { ...OUT, service_tier: 'bogus' }],
  ['responses service_tier as an object', { ...OUT, service_tier: { a: 1 } }],
  ['responses prompt_cache_retention in_memory', { ...OUT, prompt_cache_retention: 'in_memory' }],
  ['responses prompt_cache_retention as an object', { ...OUT, prompt_cache_retention: { a: 1 } }],
  ['responses prompt_cache_options unknown member', { ...OUT, prompt_cache_options: { bogus: 1 } }],
  ['responses prompt_cache_key as an object', { ...OUT, prompt_cache_key: { a: 1 } }],
  // stream_options: `include_usage` is a Chat key and unknown here (P-10).
  ['responses stream_options include_usage', { ...OUT, stream_options: { include_usage: true } }],
  ['responses stream_options unknown member', { ...OUT, stream_options: { bogus: 1 } }],
  ['responses stream_options as a string', { ...OUT, stream_options: 'x' }],
  // Plain type checks across the rest of the key set.
  ['responses stream as a string', { ...OUT, stream: 'yes' }],
  ['responses background as a string', { ...OUT, background: 'yes' }],
  ['responses store as a string', { ...OUT, store: 'yes' }],
  ['responses parallel_tool_calls as a string', { ...OUT, parallel_tool_calls: 'yes' }],
  ['responses instructions as an object', { ...OUT, instructions: { a: 1 } }],
  ['responses user as an object', { ...OUT, user: { a: 1 } }],
  ['responses safety_identifier as an object', { ...OUT, safety_identifier: { a: 1 } }],
  ['responses text as a string', { ...OUT, text: 'wrong type' }],
  ['responses tools as a string', { ...OUT, tools: 'wrong type' }],
  ['responses context_management as a string', { ...OUT, context_management: 'wrong type' }],
  ['responses moderation as a string', { ...OUT, moderation: 'wrong type' }],
  // tool_choice: a different sentence and a different object shape from Chat's.
  ['responses tool_choice as an integer', { ...OUT, tool_choice: 7 }],
  ['responses tool_choice unknown string', { ...OUT, tools: [RTOOL], tool_choice: 'bogus' }],
  ['responses tool_choice object without a name', { ...OUT, tools: [RTOOL], tool_choice: { type: 'function' } }],
  ['responses chat-shaped tool_choice', { ...OUT, tools: [RTOOL], tool_choice: { type: 'function', function: { name: 'f' } } }],
  // Report order — this surface's own, nothing like Chat's (§5.5.6).
  ['responses order unknown key beats input item', { ...OUT, input: [{ role: 'user', content: I, bogus: 1 }], zzz_unknown: 1 }],
  ['responses order model beats unknown key', { ...OUT, model: DELETE, zzz_unknown: 1 }],
  ['responses order input beats truncation', { ...OUT, input: 7, truncation: 'bogus' }],
  ['responses order input beats previous_response_id', { ...OUT, input: 7, previous_response_id: 'resp_x' }],
  ['responses order previous_response_id beats prompt', { ...OUT, previous_response_id: 'resp_x', prompt: { id: 'pmpt_x' } }],
  ['responses order prompt beats include', { ...OUT, prompt: { id: 'pmpt_x' }, include: ['bogus.thing'] }],
  ['responses order include beats tools', { ...OUT, include: ['bogus.thing'], tools: 'x' }],
  ['responses order tools beats metadata', { ...OUT, tools: 'x', metadata: 'x' }],
  ['responses order metadata beats text', { ...OUT, metadata: 'x', text: 'x' }],
  ['responses order text beats temperature', { ...OUT, text: 'x', temperature: 'x' }],
  ['responses order temperature beats top_p', { ...OUT, temperature: 'x', top_p: 'x' }],
  ['responses order top_p beats presence_penalty', { ...OUT, top_p: 'x', presence_penalty: 'x' }],
  ['responses order parallel_tool_calls beats stream', { ...OUT, parallel_tool_calls: 'x', stream: 'x' }],
  ['responses order stream beats stream_options', { ...OUT, stream: 'x', stream_options: 'x' }],
  ['responses order stream_options beats background', { ...OUT, stream_options: 'x', background: 'x' }],
  ['responses order background beats max_output_tokens', { ...OUT, background: 'x', max_output_tokens: 'x' }],
  ['responses order max_output_tokens beats max_tool_calls', { ...OUT, max_output_tokens: 'x', max_tool_calls: 'x' }],
  ['responses order max_tool_calls beats reasoning', { ...OUT, max_tool_calls: 'x', reasoning: 'x' }],
  ['responses order reasoning beats user', { ...OUT, reasoning: 'x', user: 7 }],
  ['responses order user beats safety_identifier', { ...OUT, user: 7, safety_identifier: 7 }],
  ['responses order safety_identifier beats prompt_cache_options', { ...OUT, safety_identifier: 7, prompt_cache_options: 'x' }],
  ['responses order prompt_cache_options beats prompt_cache_key', { ...OUT, prompt_cache_options: 'x', prompt_cache_key: 7 }],
  ['responses order prompt_cache_key beats prompt_cache_retention', { ...OUT, prompt_cache_key: 7, prompt_cache_retention: 'x' }],
  ['responses order prompt_cache_retention beats truncation', { ...OUT, prompt_cache_retention: 'x', truncation: 'x' }],
  ['responses order truncation beats instructions', { ...OUT, truncation: 'x', instructions: 7 }],
  ['responses order instructions beats store', { ...OUT, instructions: 7, store: 'x' }],
  ['responses order store beats service_tier', { ...OUT, store: 'x', service_tier: 'bogus' }],
  ['responses order service_tier beats top_logprobs', { ...OUT, service_tier: 'bogus', top_logprobs: 'x' }],
  ['responses order top_logprobs beats context_management', { ...OUT, top_logprobs: 'x', context_management: 'x' }],
  ['responses order moderation beats include', { ...OUT, moderation: 'x', include: ['bogus.thing'] }],
  // The adjacencies no row pinned, as SAME-KIND (type) faults so they test the
  // field order rather than the phase boundary.
  ['responses order input beats previous_response_id (type)', { ...OUT, previous_response_id: 7, input: 7 }],
  ['responses order previous_response_id beats prompt (type)', { ...OUT, prompt: 'x', previous_response_id: 7 }],
  ['responses order prompt beats moderation (type)', { ...OUT, moderation: 'x', prompt: 'x' }],
  ['responses order tools beats tool_choice', { ...OUT, tool_choice: 7, tools: 'x' }],
  ['responses order tool_choice beats metadata', { ...OUT, metadata: 'x', tool_choice: 7 }],
  ['responses order presence_penalty beats frequency_penalty', { ...OUT, frequency_penalty: 'x', presence_penalty: 'x' }],
  ['responses order frequency_penalty beats parallel_tool_calls', { ...OUT, parallel_tool_calls: 'x', frequency_penalty: 'x' }],
  // Spelling help, and its two measured limits: distance 2 suggests, 3 does
  // not, and a key already in the body is never suggested.
  ['responses unknown near store at 2', { ...OUT, sto: 1 }],
  ['responses unknown too far', { ...OUT, st: 1 }],
  ['responses unknown near two keys', { ...OUT, stre: 1 }],
  ['responses unknown nearer one of two', { ...OUT, strem: 1 }],
  ['responses unknown near tools', { ...OUT, tool: 1 }],
  ['responses unknown near user', { ...OUT, usr: 1 }],
  ['responses unknown near include', { ...OUT, inclde: 1 }],
  ['responses unknown near a key already sent', { ...OUT, inpu: 1 }],
  ['responses unknown near model already sent', { ...OUT, modell: 1 }],
  // reasoning.effort: the schema layer, the model layer, and two type branches.
  ['responses reasoning.effort minimal', { ...OUT, reasoning: { effort: 'minimal' } }],
  ['responses reasoning.effort as an integer', { ...OUT, reasoning: { effort: 5 } }],
  ['responses reasoning.effort as an array', { ...OUT, reasoning: { effort: ['low'] } }],
  // The floor, from both sides of it.
  ['responses max_output_tokens 15', { ...OUT, max_output_tokens: 15 }],
  ['responses max_output_tokens 16 with a tripwire', { ...OUT, max_output_tokens: 16, top_p: 0.5 }],
  ['responses prompt_cache_retention outside the enum', { ...OUT, prompt_cache_retention: 'x' }],
  // The server-state phase: after every schema check, before the capability
  // pass, and internally ordered.
  ['responses state after schema (prompt)', { ...OUT, prompt: { id: 'pmpt_x' }, truncation: 'bogus' }],
  ['responses state after schema (previous)', { ...OUT, previous_response_id: 'resp_x', truncation: 'bogus' }],
  ['responses state before capability (prompt)', { ...OUT, prompt: { id: 'pmpt_x' }, temperature: 0.5 }],
  ['responses state before capability (previous)', { ...OUT, previous_response_id: 'resp_x', temperature: 0.5 }],
  ['responses state before capability (conversation)', { ...OUT, conversation: 'conv_x', temperature: 0.5 }],
  ['responses conversation beats prompt', { ...OUT, conversation: 'conv_x', prompt: { id: 'pmpt_x' } }],
  ['responses conversation with previous_response_id', { ...OUT, conversation: 'conv_x', previous_response_id: 'resp_x' }],
  ['responses include logprobs beats tools', { ...OUT, include: ['message.output_text.logprobs'], tools: 'x' }],
  ['responses top_logprobs refusal vs a later field', { ...OUT, top_logprobs: 1, context_management: 'x' }],
  ['responses top_logprobs refusal vs temperature', { ...OUT, top_logprobs: 1, temperature: 0.5 }],
  ['responses include logprobs vs temperature', { ...OUT, include: ['message.output_text.logprobs'], temperature: 0.5 }],
  ['responses include logprobs vs top_logprobs', { ...OUT, include: ['message.output_text.logprobs'], top_logprobs: 1 }],
];

if (!only || only === 'chat') {
  for (const [name, body] of chatCases) await parity(name, CHAT, body);
}
if (!only || only === 'responses') {
  for (const [name, body] of responsesCases) await parity(name, '/v1/responses', body);
}

// The Anthropic Messages surface. Its report order was derived the same way the
// OpenAI ones were — a comparison sort over type faults, 18 keys, antisymmetry
// checked in both body orders — and these rows are the pairs it rests on.
const AM = [{ role: 'user', content: 'ping' }];
const messagesCases = [
  // Required presence and type, in this surface's own order.
  ['messages model absent', { model: DELETE }],
  ['messages model null', { model: null }],
  ['messages model as an integer', { model: 7 }],
  ['messages model empty', { model: '' }],
  ['messages messages absent', { messages: DELETE }],
  ['messages messages null', { messages: null }],
  ['messages messages as a string', { messages: 'x' }],
  ['messages messages empty', { messages: [] }],
  ['messages max_tokens absent', { max_tokens: DELETE }],
  ['messages max_tokens null', { max_tokens: null }],
  ['messages max_tokens as a string', { max_tokens: 'x' }],
  ['messages max_tokens below zero', { max_tokens: -1 }],
  // The item level, reported at the `messages` slot.
  ['messages item role missing', { messages: [{ content: 'ping' }] }],
  ['messages item role unknown', { messages: [{ role: 'bogus', content: 'ping' }] }],
  ['messages item role system at the head', { messages: [{ role: 'system', content: 'ping' }] }],
  ['messages item role system with empty content', { messages: [{ role: 'system', content: [] }, { role: 'user', content: 'ping' }] }],
  ['messages item role developer', { messages: [{ role: 'developer', content: 'x' }, { role: 'user', content: 'ping' }] }],
  // A system item past the head is ACCEPTED, so its own schema is what decides
  // the answer — the item's content and members, at the `messages` position.
  ['messages item system past the head without content', { messages: [{ role: 'user', content: 'a' }, { role: 'system' }] }],
  ['messages item system past the head content null', { messages: [{ role: 'user', content: 'a' }, { role: 'system', content: null }] }],
  ['messages item system past the head content as an integer', { messages: [{ role: 'user', content: 'a' }, { role: 'system', content: 7 }] }],
  ['messages item system past the head content block without a type', { messages: [{ role: 'user', content: 'a' }, { role: 'system', content: [{ text: 'x' }] }] }],
  ['messages item system past the head unknown member', { messages: [{ role: 'user', content: 'a' }, { role: 'system', content: 'x', bogus: 1 }], temperature: 'x' }],
  ['messages item user unknown member beats a later field', { messages: [{ role: 'user', content: 'a', bogus: 1 }], temperature: 'x' }],
  // The conversation's SHAPE — where a system item may sit, and which turns may
  // be empty. Measured 2026-08-31: these sit AFTER every field's type check and
  // after the unknown-key refusal, and BEFORE the container one. Only the
  // REFUSED half is here; a body this API accepts would bill a real turn, so the
  // accepted half is pinned in `test/anthropic-messages-validation-parity.test.mjs`.
  ['messages shape system precedes a user', { messages: [{ role: 'user', content: 'a' }, { role: 'system', content: 'sys' }, { role: 'user', content: 'b' }] }],
  ['messages shape system content empty past the head', { messages: [{ role: 'user', content: 'a' }, { role: 'system', content: [] }] }],
  ['messages shape system content empty beats position', { messages: [{ role: 'user', content: 'a' }, { role: 'system', content: [] }, { role: 'user', content: 'b' }] }],
  ['messages shape system whitespace text', { messages: [{ role: 'user', content: 'a' }, { role: 'system', content: '  ' }] }],
  ['messages shape system one empty block of two', { messages: [{ role: 'user', content: 'a' }, { role: 'system', content: [{ type: 'text', text: 'x' }, { type: 'text', text: '' }] }] }],
  ['messages shape system position beats whitespace', { messages: [{ role: 'user', content: 'a' }, { role: 'system', content: '  ' }, { role: 'user', content: 'b' }] }],
  ['messages shape system at the head empty', { messages: [{ role: 'system', content: [] }, { role: 'user', content: 'a' }] }],
  ['messages shape system at the head whitespace', { messages: [{ role: 'system', content: '  ' }, { role: 'user', content: 'a' }] }],
  ['messages shape system block type', { messages: [{ role: 'user', content: 'a' }, { role: 'system', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' } }] }] }],
  ['messages shape system block type beats position', { messages: [{ role: 'user', content: 'a' }, { role: 'system', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' } }] }, { role: 'user', content: 'b' }] }],
  ['messages shape system block type at the head', { messages: [{ role: 'system', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' } }] }, { role: 'user', content: 'a' }] }],
  ['messages shape system block type beaten by an empty content', { messages: [{ role: 'user', content: 'a' }, { role: 'system', content: [] }] }],
  ['messages shape empty user turn alone', { messages: [{ role: 'user', content: [] }] }],
  ['messages shape empty user string alone', { messages: [{ role: 'user', content: '' }] }],
  ['messages shape empty user turn after an assistant', { messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'ok' }, { role: 'user', content: [] }] }],
  ['messages shape empty user run of two', { messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'ok' }, { role: 'user', content: [] }, { role: 'user', content: [] }] }],
  ['messages shape order a field type fault beats an empty turn', { messages: [{ role: 'user', content: [] }], temperature: 'x' }],
  ['messages shape order an unknown key beats an empty turn', { messages: [{ role: 'user', content: [] }], zzz_unknown: 1 }],
  ['messages shape order an empty turn beats container', { messages: [{ role: 'user', content: [] }], container: 'x' }],
  ['messages shape order a bad role beats an empty system', { messages: [{ role: 'user', content: 'a' }, { role: 'system', content: [] }, { role: 'bogus', content: 'x' }] }],
  ['messages item content missing', { messages: [{ role: 'user' }] }],
  ['messages item content null', { messages: [{ role: 'user', content: null }] }],
  ['messages item content as an integer', { messages: [{ role: 'user', content: 7 }] }],
  ['messages item content as an object', { messages: [{ role: 'user', content: {} }] }],
  ['messages item content empty array', { messages: [{ role: 'user', content: [] }] }],
  ['messages item content block not an object', { messages: [{ role: 'user', content: [7] }] }],
  ['messages item content block without a type', { messages: [{ role: 'user', content: [{}] }] }],
  ['messages item unknown member', { messages: [{ role: 'user', content: 'ping', bogus: 1 }] }],
  // Known fields, one type fault each — the rows the order sort was run on.
  ['messages tool_choice as an integer', { tool_choice: 7 }],
  ['messages tool_choice null', { tool_choice: null }],
  ['messages tools as a string', { tools: 'x' }],
  ['messages tools null', { tools: null }],
  ['messages tools member not an object', { tools: [7] }],
  ['messages system as an integer', { system: 7 }],
  ['messages system null', { system: null }],
  ['messages system member not an object', { system: [7] }],
  ['messages thinking as a string', { thinking: 'x' }],
  ['messages thinking null', { thinking: null }],
  ['messages output_config as a string', { output_config: 'x' }],
  ['messages output_config null', { output_config: null }],
  ['messages cache_control as a string', { cache_control: 'x' }],
  ['messages metadata as a string', { metadata: 'x' }],
  ['messages metadata unknown member', { metadata: { bogus: 'x' } }],
  ['messages metadata user_id as an integer', { metadata: { user_id: 7 } }],
  ['messages stop_sequences as a string', { stop_sequences: 'ZZ' }],
  ['messages stop_sequences member not a string', { stop_sequences: [1] }],
  ['messages temperature as a string', { temperature: 'x' }],
  ['messages temperature null', { temperature: null }],
  ['messages temperature above its range', { temperature: 2 }],
  ['messages service_tier unknown', { service_tier: 'bogus' }],
  ['messages service_tier null', { service_tier: null }],
  ['messages top_k as a string', { top_k: 'x' }],
  ['messages top_k null', { top_k: null }],
  ['messages top_p as a string', { top_p: 'x' }],
  ['messages top_p null', { top_p: null }],
  ['messages top_p above its range', { top_p: 1.5 }],
  ['messages stream as a string', { stream: 'yes' }],
  ['messages stream null', { stream: null }],
  ['messages container as an integer', { container: 7 }],
  ['messages container by name', { container: 'container_x' }],
  ['messages inference_geo as an integer', { inference_geo: 7 }],
  ['messages inference_geo unknown', { inference_geo: 'bogus-geo' }],
  ['messages unknown key', { zzz_unknown: 1 }],
  // The derived order, adjacent pair by adjacent pair, each sent with the
  // LATER key first so a proxy that answered about the first key it read would
  // fail every one of them.
  ['messages order model before tool_choice', { tool_choice: 7, model: 7 }],
  ['messages order tool_choice before tools', { tools: 'x', tool_choice: 7 }],
  ['messages order tools before messages', { messages: 'x', tools: 'x' }],
  ['messages order messages before system', { system: 7, messages: 'x' }],
  ['messages order system before thinking', { thinking: 'x', system: 7 }],
  ['messages order thinking before output_config', { output_config: 'x', thinking: 'x' }],
  ['messages order output_config before cache_control', { cache_control: 'x', output_config: 'x' }],
  ['messages order cache_control before max_tokens', { max_tokens: 'x', cache_control: 'x' }],
  ['messages order max_tokens before metadata', { metadata: 'x', max_tokens: 'x' }],
  ['messages order metadata before stop_sequences', { stop_sequences: 'ZZ', metadata: 'x' }],
  ['messages order stop_sequences before temperature', { temperature: 'x', stop_sequences: 'ZZ' }],
  ['messages order temperature before service_tier', { service_tier: 7, temperature: 'x' }],
  ['messages order service_tier before top_k', { top_k: 'x', service_tier: 7 }],
  ['messages order top_k before top_p', { top_p: 'x', top_k: 'x' }],
  ['messages order top_p before stream', { stream: 'yes', top_p: 'x' }],
  ['messages order stream before container', { container: 7, stream: 'yes' }],
  ['messages order container before inference_geo', { inference_geo: 7, container: 7 }],
  // The two phases behind every known field.
  ['messages order a known field beats an unknown key', { zzz_unknown: 1, inference_geo: 7 }],
  ['messages order a missing model beats an unknown key', { model: DELETE, zzz_unknown: 1 }],
  ['messages order an unknown key beats the container refusal', { container: 'container_x', zzz_unknown: 1 }],
  ['messages order a known field beats the container refusal', { container: 'container_x', inference_geo: 7 }],
  ['messages order a missing model beats a bad optional field', { model: DELETE, stop_sequences: 'ZZ' }],
  ['messages order a bad item beats an unknown key', { messages: [{ role: 'user', content: 'ping', bogus: 1 }], zzz_unknown: 1 }],
];

if (!only || only === 'messages') {
  if (!ANTHROPIC_KEY) throw new Error('ANTHROPIC_API_KEY is not set; the messages rows need it.');
  for (const [name, body] of messagesCases) await anthropicParity(name, body);
}

// The accepted rows: identical bodies on both sides, compared on the fields
// the proxy is responsible for echoing. These generate.
if (generate && (!only || only === 'chat')) {
  const echoCases = [
    ['echo baseline', {}],
    ['echo service_tier flex', { service_tier: 'flex' }],
    ['echo service_tier auto', { service_tier: 'auto' }],
    ['echo service_tier priority', { service_tier: 'priority' }],
    ['echo service_tier fast', { service_tier: 'fast' }],
    ['echo service_tier default', { service_tier: 'default' }],
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
process.stdout.write(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILED`} — ${checks - failures}/${checks}${skipped ? ` (+${skipped} SKIP: accepted by direct, not a probe)` : ''}\n`);
process.exit(failures === 0 ? 0 : 1);

function readArg(name) {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
}
