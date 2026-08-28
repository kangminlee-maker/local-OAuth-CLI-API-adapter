#!/usr/bin/env node
// Tier A of the conformance matrix probe plan (docs/conformance-matrix.md §6):
// ten probes, twelve calls, aimed at the cells most likely to break a real SDK
// client. Every one of them converts a DOC cell into a VERIFIED one, and the
// evidence is the raw bytes, not this script's reading of them.
//
// The matrix's own rule applies here more than anywhere: each probe has an
// expected answer already written down, and an observation that agrees with an
// expectation is exactly when an instrument fails silently. So the detectors run
// against a known-opposite input before any capture is believed, and the run
// refuses to continue if a detector cannot tell the two apart.
import { recordExchange, startCaptureRun, captureSummary } from './lib/capture-recorder.mjs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const openAiModel = readArg('--openai-model') ?? 'gpt-5.6-terra';
const anthropicModel = readArg('--anthropic-model') ?? 'claude-sonnet-5';
const only = readArg('--only');

if (!process.env.OPENAI_API_KEY || !process.env.ANTHROPIC_API_KEY) {
  console.error('OPENAI_API_KEY and ANTHROPIC_API_KEY are required: these probes ask the vendors directly');
  process.exit(2);
}

// ---------------------------------------------------------------- detectors
// Each returns a fact the matrix wants. Each is proven below against an input
// whose answer is the opposite before it is used on a real capture.
const detect = {
  sseTerminator: (wire) => /^data:\s*\[DONE\]\s*$/m.test(wire),
  sseEventNames: (wire) => [...wire.matchAll(/^event:\s*(\S+)\s*$/gm)].map((m) => m[1]),
  jsonKeys: (text) => { try { return Object.keys(JSON.parse(text)).sort(); } catch { return null; } },
};

function proveDetectors() {
  const withDone = 'event: a\ndata: {"x":1}\n\ndata: [DONE]\n\n';
  const withoutDone = 'event: message_stop\ndata: {"type":"message_stop"}\n\n';
  const checks = [
    ['sseTerminator says present when it is', detect.sseTerminator(withDone) === true],
    ['sseTerminator says absent when it is', detect.sseTerminator(withoutDone) === false],
    ['sseEventNames finds names', detect.sseEventNames(withoutDone).join() === 'message_stop'],
    ['sseEventNames returns empty, not null, when there are none', detect.sseEventNames('data: {}\n\n').length === 0],
    ['jsonKeys parses', (detect.jsonKeys('{"b":1,"a":2}') ?? []).join() === 'a,b'],
    ['jsonKeys returns null on non-JSON', detect.jsonKeys('not json') === null],
  ];
  const failed = checks.filter(([, ok]) => !ok);
  if (failed.length > 0) {
    console.error(`detector self-test failed, so no capture below can be trusted:\n${failed.map(([name]) => `  - ${name}`).join('\n')}`);
    process.exit(1);
  }
  console.log(`detector self-test: ${checks.length}/${checks.length} — each detector distinguished a known-opposite input\n`);
}

// ------------------------------------------------------------------- probes
const OPENAI = 'https://api.openai.com';
const ANTHROPIC = 'https://api.anthropic.com';

const probes = [
  {
    id: 'P-1', why: 'every echoed default on a minimal Responses request',
    url: `${OPENAI}/v1/responses`, provider: 'openai',
    body: { model: openAiModel, input: 'ping', max_output_tokens: 16 },
    read: (r) => ({ keys: detect.jsonKeys(r.text), echoed: pick(r.json, ['temperature', 'top_p', 'truncation', 'store', 'parallel_tool_calls', 'service_tier', 'tool_choice', 'text', 'reasoning', 'background', 'max_tool_calls', 'metadata']) }),
  },
  {
    id: 'P-2', why: 'Responses stream shape and terminator — the top unverified cell',
    url: `${OPENAI}/v1/responses`, provider: 'openai', stream: true,
    body: { model: openAiModel, input: 'ping', max_output_tokens: 16, stream: true },
    read: (r) => ({ terminator: detect.sseTerminator(r.wire), events: dedupe(detect.sseEventNames(r.wire)), firstSequence: firstMatch(r.wire, /"sequence_number":\s*(\d+)/), hasObfuscation: /"obfuscation"/.test(r.wire) }),
  },
  {
    id: 'P-3', why: 'exact key set of a minimal Chat Completions response',
    url: `${OPENAI}/v1/chat/completions`, provider: 'openai',
    body: { model: openAiModel, messages: [{ role: 'user', content: 'ping' }], max_completion_tokens: 16 },
    read: (r) => ({ keys: detect.jsonKeys(r.text), choiceKeys: Object.keys(r.json?.choices?.[0] ?? {}).sort(), serviceTier: r.json?.service_tier ?? null, systemFingerprint: r.json?.system_fingerprint ?? null }),
  },
  {
    id: 'P-4', why: 'Anthropic stream event order, usage placement, and absence of [DONE]',
    url: `${ANTHROPIC}/v1/messages`, provider: 'anthropic', stream: true,
    body: { model: anthropicModel, max_tokens: 16, messages: [{ role: 'user', content: 'ping' }], stream: true },
    read: (r) => ({ terminator: detect.sseTerminator(r.wire), events: dedupe(detect.sseEventNames(r.wire)), messageStartInputTokens: firstMatch(r.wire, /"input_tokens":\s*(\d+)/), hasPing: /^event:\s*ping\s*$/m.test(r.wire) }),
  },
  {
    id: 'P-5a', why: 'unknown top-level field, Chat', url: `${OPENAI}/v1/chat/completions`, provider: 'openai',
    body: { model: openAiModel, messages: [{ role: 'user', content: 'ping' }], max_completion_tokens: 16, zzz_unknown: 1 },
    read: (r) => ({ status: r.status, error: r.json?.error ?? null }),
  },
  {
    id: 'P-5b', why: 'unknown top-level field, Responses', url: `${OPENAI}/v1/responses`, provider: 'openai',
    body: { model: openAiModel, input: 'ping', max_output_tokens: 16, zzz_unknown: 1 },
    read: (r) => ({ status: r.status, error: r.json?.error ?? null }),
  },
  {
    id: 'P-5c', why: 'unknown top-level field, Messages', url: `${ANTHROPIC}/v1/messages`, provider: 'anthropic',
    body: { model: anthropicModel, max_tokens: 16, messages: [{ role: 'user', content: 'ping' }], zzz_unknown: 1 },
    read: (r) => ({ status: r.status, error: r.json?.error ?? null }),
  },
  {
    id: 'P-6', why: 'Messages without the anthropic-version header', url: `${ANTHROPIC}/v1/messages`, provider: 'anthropic',
    omitVersionHeader: true,
    body: { model: anthropicModel, max_tokens: 16, messages: [{ role: 'user', content: 'ping' }] },
    read: (r) => ({ status: r.status, error: r.json?.error ?? null }),
  },
  {
    id: 'P-7', why: 'chat n:2 — accepted or refused', url: `${OPENAI}/v1/chat/completions`, provider: 'openai',
    body: { model: openAiModel, messages: [{ role: 'user', content: 'ping' }], max_completion_tokens: 16, n: 2 },
    read: (r) => ({ status: r.status, choices: r.json?.choices?.length ?? null, error: r.json?.error ?? null }),
  },
  {
    id: 'P-8', why: 'Anthropic stop_sequences echo', url: `${ANTHROPIC}/v1/messages`, provider: 'anthropic',
    body: { model: anthropicModel, max_tokens: 32, stop_sequences: ['ZZ'], messages: [{ role: 'user', content: 'Reply with exactly: AAZZBB' }] },
    read: (r) => ({ stopReason: r.json?.stop_reason ?? null, stopSequence: r.json?.stop_sequence ?? null }),
  },
  {
    id: 'P-9', why: 'chat stop echo and finish_reason', url: `${OPENAI}/v1/chat/completions`, provider: 'openai',
    body: { model: openAiModel, messages: [{ role: 'user', content: 'Reply with exactly: AAZZBB' }], max_completion_tokens: 32, stop: ['ZZ'] },
    read: (r) => ({ finishReason: r.json?.choices?.[0]?.finish_reason ?? null, content: r.json?.choices?.[0]?.message?.content ?? null }),
  },
  {
    id: 'P-10', why: 'Responses with an undocumented stream_options key', url: `${OPENAI}/v1/responses`, provider: 'openai', stream: true,
    body: { model: openAiModel, input: 'ping', max_output_tokens: 16, stream: true, stream_options: { include_usage: true } },
    read: (r) => ({ status: r.status, accepted: r.status === 200, error: r.json?.error ?? null, terminator: r.wire ? detect.sseTerminator(r.wire) : null }),
  },
];

// --------------------------------------------------------------------- run
proveDetectors();
const run = startCaptureRun({
  dir: resolve(repoRoot, 'artifacts/direct-api-captures'),
  meta: { plan: 'conformance matrix Tier A', openAiModel, anthropicModel },
});
console.log(`captures: ${run.runDir}\n`);

const results = [];
for (const probe of probes) {
  if (only && !probe.id.startsWith(only)) continue;
  const headers = probe.provider === 'openai'
    ? { authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'content-type': 'application/json' }
    : { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'content-type': 'application/json', ...(probe.omitVersionHeader ? {} : { 'anthropic-version': '2023-06-01' }) };
  const requestBody = JSON.stringify(probe.body);
  const startedAt = Date.now();
  let res; let text = ''; let wire = '';
  try {
    res = await fetch(probe.url, { method: 'POST', headers, body: requestBody });
    text = await res.text();
    if (probe.stream) wire = text;
  } catch (err) {
    recordExchange({ kind: probe.stream ? 'sse' : 'json', label: probe.id, url: probe.url, requestHeaders: headers, requestBody, error: err, durationMs: Date.now() - startedAt });
    results.push({ id: probe.id, why: probe.why, error: String(err) });
    continue;
  }
  recordExchange({
    kind: probe.stream ? 'sse' : 'json',
    label: probe.id,
    url: probe.url,
    requestHeaders: headers,
    requestBody,
    status: res.status,
    statusText: res.statusText,
    responseHeaders: res.headers,
    responseBody: probe.stream ? undefined : text,
    streamBytes: probe.stream ? wire : undefined,
    durationMs: Date.now() - startedAt,
  });
  let json = null;
  try { json = JSON.parse(text); } catch { /* streams and error pages are not one JSON object */ }
  results.push({ id: probe.id, why: probe.why, status: res.status, observed: probe.read({ status: res.status, text, wire, json }) });
}

console.log(JSON.stringify({ openAiModel, anthropicModel, captures: captureSummary(), results }, null, 2));

function pick(obj, keys) {
  if (!obj) return null;
  const out = {};
  for (const key of keys) if (key in obj) out[key] = obj[key];
  return out;
}
function dedupe(values) { return [...new Set(values)]; }
function firstMatch(text, re) { const m = re.exec(text ?? ''); return m ? m[1] : null; }
function readArg(name) {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
}
