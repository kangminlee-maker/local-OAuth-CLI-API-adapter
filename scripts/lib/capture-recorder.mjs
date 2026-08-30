// What a benchmark run keeps so a question asked later can be answered without
// re-spending.
//
// `bench-results/*.json` stores verdicts and a text sample. That is a record of
// conclusions, and it is why this project has never observed a single vendor
// request-field default: the bodies that carried them were parsed, judged and
// thrown away. Raw bytes are the evidence; parsed JSON is a projection that can
// be recomputed from them, never the other way round.
//
// So this records the exchange, not the finding: the exact request body sent,
// the status line, the response headers, the response bytes, and for a stream
// the wire text as it arrived. Assertions do not read any of it — this stage
// deliberately changes nothing about what the benchmark decides. It only stops
// the evidence from being lost while the suite that will consume it is built
// (`docs/conformance-suite-design.md` §4, migration step 1).
import { createHash, randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Anything that authenticates. Recorded as present so a later reader can tell
// "the header was sent" from "the header was missing", which is a real
// difference when a probe's whole point is a 401 — but never with its value.
const CREDENTIAL_HEADERS = new Set([
  'authorization',
  'x-api-key',
  'cookie',
  'set-cookie',
  'proxy-authorization',
  'openai-api-key',
  'anthropic-api-key',
]);

// Above this, the body is stored gzipped rather than inline. Compression is not
// lossy; truncation would be, and an image response is mostly base64.
const INLINE_BODY_LIMIT = 64 * 1024;

let state = null;

export function startCaptureRun({ dir, meta = {} } = {}) {
  if (!dir) return null;
  const runId = randomUUID();
  const runDir = join(dir, runId);
  mkdirSync(runDir, { recursive: true });
  state = { runId, runDir, seq: 0, bytes: 0, failures: 0 };
  writeFileSync(join(runDir, 'run.json'), `${JSON.stringify({
    runId,
    startedAt: new Date().toISOString(),
    ...meta,
  }, null, 2)}\n`);
  return { runId, runDir };
}

export function captureEnabled() {
  return state !== null;
}

/**
 * One HTTP exchange, as it happened.
 *
 * A failed attempt is recorded like any other and never overwritten by a retry:
 * the sequence number is the identity, so a run that retried three times leaves
 * three files. Losing the first two is how a flaky vendor reads as a healthy one.
 */
export function recordExchange(entry) {
  if (!state) return null;
  state.seq += 1;
  const seq = String(state.seq).padStart(4, '0');
  const label = String(entry.label ?? 'exchange').replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 80);
  const record = {
    seq: state.seq,
    runId: state.runId,
    recordedAt: new Date().toISOString(),
    kind: entry.kind ?? 'json',
    label: entry.label ?? null,
    target: entry.target ?? null,
    method: entry.method ?? 'POST',
    url: entry.url ?? null,
    requestHeaders: redactHeaders(entry.requestHeaders),
    request: encodeBody(entry.requestBody),
    status: entry.status ?? null,
    statusText: entry.statusText ?? null,
    responseHeaders: redactHeaders(entry.responseHeaders),
    response: encodeBody(entry.responseBody),
    // For a stream this is the wire text as received, before any event parsing —
    // the terminator and the chunk boundaries live here and nowhere else.
    stream: entry.streamBytes === undefined ? null : encodeBody(entry.streamBytes),
    startedAt: entry.startedAt ?? null,
    durationMs: entry.durationMs ?? null,
    error: entry.error ? String(entry.error).slice(0, 2000) : null,
  };
  if (record.error) state.failures += 1;
  const serialized = `${JSON.stringify(record, null, 2)}\n`;
  writeFileSync(join(state.runDir, `${seq}-${label}.json`), serialized);
  state.bytes += Buffer.byteLength(serialized);
  return record.seq;
}

export function captureSummary() {
  if (!state) return { enabled: false };
  return {
    enabled: true,
    runId: state.runId,
    dir: state.runDir,
    exchanges: state.seq,
    failedExchanges: state.failures,
    bytes: state.bytes,
  };
}

function redactHeaders(headers) {
  if (!headers) return null;
  const entries = headers instanceof Headers
    ? [...headers.entries()]
    : Object.entries(headers);
  const out = {};
  for (const [rawKey, value] of entries) {
    const key = String(rawKey).toLowerCase();
    out[key] = CREDENTIAL_HEADERS.has(key) ? 'present and redacted' : String(value);
  }
  return out;
}

function encodeBody(body) {
  if (body === undefined || body === null) return null;
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  const bytes = Buffer.byteLength(text);
  const sha256 = createHash('sha256').update(text).digest('hex');
  if (bytes <= INLINE_BODY_LIMIT) return { encoding: 'utf8', bytes, sha256, text };
  return { encoding: 'gzip+base64', bytes, sha256, gzip: gzipSync(text).toString('base64') };
}
