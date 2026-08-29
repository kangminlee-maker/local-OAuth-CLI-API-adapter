#!/usr/bin/env node
// Images surface parity, end to end: the same request goes to this proxy
// (built `dist/`, the real CodexBackendTransport, the real Codex backend) and
// to the direct OpenAI API, and the two answers are compared field by field
// (status, error type/param/code/message). Every default case is invalid on
// both sides, so nothing is generated and nothing is billed.
//
//   set -a; . ./.env; set +a          # OPENAI_API_KEY for the direct side
//   node scripts/e2e-images-direct-parity.mjs [--generate]
//
// `--generate` adds three real turns through the proxy only (a generation, a
// streamed generation, a masked edit) and checks the images that come back.
// Those cost Codex quota, not money; the direct side is never asked to
// generate.
import { deflateSync } from 'node:zlib';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { startLocalApiProxy } = await import(`${repoRoot}/dist/proxy/http-server.js`);
const { CodexBackendTransport } = await import(`${repoRoot}/dist/proxy/codex-backend-transport.js`);

const KEY = process.env.OPENAI_API_KEY;
if (!KEY) throw new Error('OPENAI_API_KEY is not set; load .env first (set -a; . ./.env; set +a).');
const generate = process.argv.includes('--generate');
const DIRECT = 'https://api.openai.com';
const G = '/v1/images/generations';
const E = '/v1/images/edits';

const realFetch = globalThis.fetch;
const sentTools = [];
globalThis.fetch = async (url, init) => {
  if (String(url).includes('chatgpt.com')) {
    const body = JSON.parse(init.body);
    sentTools.push(body.tools?.[0] ?? null);
  }
  return realFetch(url, init);
};

const started = await startLocalApiProxy({
  backend: { name: 'none', model: 'x', async generate() { throw new Error('unused'); }, async close() {} },
  imageGenerationClient: new CodexBackendTransport({ timeoutMs: 180_000, model: 'gpt-5.5' }),
  host: '127.0.0.1',
  port: 0,
  requestTimeoutMs: 180_000,
});

let failures = 0;
function record(name, ok, detail = '') {
  if (!ok) failures += 1;
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'} ${name} ${detail}\n`);
}

async function post(base, path, body, headers = {}) {
  const res = await realFetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, contentType: res.headers.get('content-type') ?? '', text, json };
}

function envelope(r) {
  return r.json?.error
    ? { status: r.status, type: r.json.error.type, param: r.json.error.param, code: r.json.error.code, message: r.json.error.message }
    : { status: r.status, keys: Object.keys(r.json ?? {}) };
}

async function parity(name, path, body) {
  const [p, d] = await Promise.all([
    post(started.url, path, body),
    post(DIRECT, path, body, { authorization: `Bearer ${KEY}` }),
  ]);
  const pe = envelope(p);
  const de = envelope(d);
  const same = JSON.stringify(pe) === JSON.stringify(de);
  record(`parity ${name}`, same, same
    ? `→ ${de.status} ${de.code ?? ''} ${de.param ?? ''}`
    : `\n   proxy : ${JSON.stringify(pe)}\n   direct: ${JSON.stringify(de)}`);
  if (d.status === 200) process.stdout.write(`   !! the direct API generated for "${name}" — that case is not a free probe\n`);
}

const M = { image_url: 'https://example.com/mask.png' };
const I = [{ image_url: 'https://example.com/x.png' }];
// [name, path, body]. `model`/`prompt` default to a live model and a valid
// prompt unless the case sets them (an explicit `undefined` deletes the key).
const cases = [
  // model namespace
  ['model missing', G, { model: undefined }],
  ['model null', G, { model: null }],
  ['model integer', G, { model: 7 }],
  ["model 'image-2'", G, { model: 'image-2' }],
  ["model 'dall-e-2'", G, { model: 'dall-e-2' }],
  ["model ''", G, { model: '' }],
  // parameters no live model knows
  ['response_format url', G, { response_format: 'url' }],
  ['response_format null', G, { response_format: null }],
  ['style', G, { style: 'vivid' }],
  ['input_fidelity on a generation', G, { input_fidelity: 'high' }],
  ['bogus_field', G, { bogus_field: 1 }],
  ['mask on a generation', G, { mask: M }],
  ['images on a generation', G, { images: I }],
  // prompt
  ['prompt ""', G, { prompt: '' }],
  ['prompt null', G, { prompt: null }],
  ['prompt 123', G, { prompt: 123 }],
  ['prompt missing', G, { prompt: undefined }],
  // integers
  ['n 0', G, { n: 0 }], ['n 11', G, { n: 11 }], ['n 1.5', G, { n: 1.5 }], ['n "2"', G, { n: '2' }], ['n true', G, { n: true }], ['n -1', G, { n: -1 }],
  ['output_compression 101', G, { output_compression: 101 }], ['output_compression -1', G, { output_compression: -1 }],
  ['output_compression 1.5', G, { output_compression: 1.5 }], ['output_compression "50"', G, { output_compression: '50' }],
  ['partial_images 4', G, { partial_images: 4 }], ['partial_images -1', G, { partial_images: -1 }],
  // enums, size, stream
  ['quality ultra', G, { quality: 'ultra' }], ['quality standard', G, { quality: 'standard' }], ['quality hd', G, { quality: 'hd' }],
  ['quality ""', G, { quality: '' }], ['quality 1', G, { quality: 1 }],
  ['output_format gif', G, { output_format: 'gif' }], ['moderation bogus', G, { moderation: 'bogus' }], ['background bogus', G, { background: 'bogus' }],
  ['size bogus', G, { size: 'bogus' }], ['size 0x0', G, { size: '0x0' }], ['size 9x9', G, { size: '9x9' }],
  ['stream "yes"', G, { stream: 'yes' }],
  // ordering, two faults per body
  ['order: bogus key before n', G, { bogus: 1, n: 0 }],
  ['order: prompt before n', G, { prompt: '', n: 0 }],
  ['order: n before quality', G, { n: 0, quality: 'ultra' }],
  ['order: n null is omission', G, { n: null, output_compression: 101 }],
  // edits
  ['edits JSON image alias', E, { image: I[0] }],
  ['edits JSON image[] alias', E, { 'image[]': I }],
  ['edits images object', E, { images: I[0] }],
  ['edits images string member', E, { images: ['https://example.com/x.png'] }],
  ['edits images missing', E, {}],
  ['edits images []', E, { images: [] }],
  ['edits images null', E, { images: null }],
  ['edits images [] before n', E, { images: [], n: 0 }],
];

try {
  for (const [name, path, extra] of cases) {
    const body = { model: 'gpt-image-2', prompt: 'a dot', ...extra };
    for (const key of Object.keys(body)) if (body[key] === undefined) delete body[key];
    await parity(name, path, body);
  }
  {
    // Status parity; the bodies differ by design on neither side: both are
    // bare 404s, and the proxy's has no envelope either.
    const [p, d] = await Promise.all([
      post(started.url, '/v1/images/variations', { model: 'gpt-image-2' }),
      post(DIRECT, '/v1/images/variations', { model: 'gpt-image-2' }, { authorization: `Bearer ${KEY}` }),
    ]);
    record('variations: bare 404 on both', p.status === 404 && d.status === 404 && p.text === '' && d.text === '', `proxy ${p.status} ${JSON.stringify(p.text)}, direct ${d.status} ${JSON.stringify(d.text)}`);
  }
  {
    // Proxy only: the backend refuses before the first event, and the stream
    // has not committed — the direct API would generate a transparent image.
    const p = await post(started.url, G, { model: 'gpt-image-1', prompt: 'a dot', background: 'transparent', stream: true });
    record('stream: a backend refusal before the first event is HTTP 400', p.status === 400 && p.contentType.includes('json') && p.json?.error?.type === 'image_generation_user_error', `${p.status} ${JSON.stringify(p.json?.error)}`);
  }

  if (generate) {
    const t0 = Date.now();
    const gen = await post(started.url, G, { model: 'gpt-image-2', prompt: 'A simple flat red square centered on a white background. No text.', size: '1024x1024', quality: 'low', output_format: 'png' });
    const buf = Buffer.from(gen.json?.data?.[0]?.b64_json ?? '', 'base64');
    const isPng = buf.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    record('generate gpt-image-2', gen.status === 200 && isPng && buf.length > 10_000, `${gen.status} in ${Date.now() - t0}ms, png=${isPng} ${isPng ? `${buf.readUInt32BE(16)}x${buf.readUInt32BE(20)}` : ''} ${buf.length}B, tool=${JSON.stringify(sentTools.at(-1))}`);

    const t1 = Date.now();
    const res = await realFetch(`${started.url}${G}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'gpt-image-1.5', prompt: 'A blue circle on white. No text.', size: '1024x1024', quality: 'low', stream: true }) });
    const sse = await res.text();
    const frames = sse.split('\n\n').filter(Boolean);
    const completed = frames.find((f) => f.startsWith('event: image_generation.completed'));
    const payload = completed ? JSON.parse(completed.split('\n').find((l) => l.startsWith('data: ')).slice(6)) : null;
    record('streamed generation gpt-image-1.5', res.status === 200 && (res.headers.get('content-type') ?? '').includes('event-stream') && Boolean(payload?.b64_json), `${res.status} in ${Date.now() - t1}ms, frames=${frames.length}, keys=${Object.keys(payload ?? {})}`);

    const W = 256; const H = 256;
    const src = Buffer.alloc(W * H * 4); const mask = Buffer.alloc(W * H * 4);
    for (let y = 0; y < H; y += 1) {
      for (let x = 0; x < W; x += 1) {
        const i = (y * W + x) * 4;
        const inSquare = x >= 64 && x < 192 && y >= 64 && y < 192;
        src.set(inSquare ? [220, 30, 30, 255] : [255, 255, 255, 255], i);
        mask.set(inSquare ? [0, 0, 0, 0] : [255, 255, 255, 255], i);
      }
    }
    const t2 = Date.now();
    const edit = await post(started.url, E, {
      model: 'gpt-image-2',
      prompt: 'Make the red square blue. Keep everything else exactly as it is.',
      images: [{ image_url: `data:image/png;base64,${png(W, H, src).toString('base64')}` }],
      mask: { image_url: `data:image/png;base64,${png(W, H, mask).toString('base64')}` },
      size: '1024x1024', quality: 'low', background: 'opaque', moderation: 'low',
    });
    const eb = Buffer.from(edit.json?.data?.[0]?.b64_json ?? '', 'base64');
    const tool = sentTools.at(-1);
    record('masked edit gpt-image-2', edit.status === 200 && eb.length > 10_000 && tool?.input_image_mask?.image_url?.startsWith('data:image/png') && tool?.background === 'opaque' && tool?.moderation === 'low', `${edit.status} in ${Date.now() - t2}ms, ${eb.length}B, tool keys=${Object.keys(tool ?? {})}`);
  }
} finally {
  await started.close();
}

process.stdout.write(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAIL`} — ${cases.length} parity cases${generate ? ' + 3 generations' : ''}\n`);
process.exit(failures ? 1 : 0);

function png(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
function chunk(type, data) {
  const t = Buffer.from(type, 'ascii'); const len = Buffer.alloc(4); const crc = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
function crc32(data) {
  let c = 0xffffffff;
  for (const b of data) { c ^= b; for (let i = 0; i < 8; i += 1) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0); }
  return (c ^ 0xffffffff) >>> 0;
}
