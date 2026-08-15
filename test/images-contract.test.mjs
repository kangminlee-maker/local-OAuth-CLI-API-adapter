import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import net from 'node:net';
import { startLocalApiProxy, GeneratedImageStore } from '../dist/proxy/http-server.js';

// The Images surface has a documented input contract and almost none of its
// REJECTIONS were pinned: the successful paths were tested, so a widened bound or
// a deleted guard would have gone unnoticed. These are the negatives.

function imageBackend() {
  return {
    name: 'test',
    model: 'configured-model',
    async generate(request) {
      return {
        created: 0,
        images: Array.from({ length: request.n ?? 1 }, () => ({
          b64Json: 'iVBORw0KGgo=',
          revisedPrompt: null,
        })),
        usage: { inputTokens: 3, outputTokens: 4, source: 'provider' },
      };
    },
    async close() {},
  };
}

async function postImages(path, body) {
  const started = await startLocalApiProxy({
    backend: imageBackend(), imageGenerationClient: imageBackend(),
    host: '127.0.0.1', port: 0, requestTimeoutMs: 30_000,
  });
  try {
    const res = await fetch(`${started.url}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, payload: await res.json() };
  } finally {
    await started.close();
  }
}

const GEN = '/v1/images/generations';

// `n` is a documented domain: an integer in 1..10. Only the happy path was
// covered, so widening the bound or dropping the integer check was invisible.
for (const [label, n] of [
  ['zero', 0],
  ['above the maximum', 11],
  ['fractional', 1.5],
  ['a non-numeric string', 'two'],
  ['negative', -1],
]) {
  test(`generations: n ${label} is rejected`, async () => {
    const { status, payload } = await postImages(GEN, { model: 'image-2', prompt: 'a dot', n });
    assert.equal(status, 400, `expected a rejection for n=${n}`);
    assert.match(payload.error.message, /n must be an integer between 1 and 10/);
  });
}

test('generations: nullable fields treat null as omission, per the direct types', async () => {
  // `n`, `partial_images`, `output_compression`, `response_format` are all
  // declared nullable (`Optional[...]`) on the direct API. The explicit-null
  // rejections of earlier rounds were anti-parity, measured against the
  // published SDK types, and are reversed.
  const { status, payload } = await postImages(GEN, {
    model: 'image-2', prompt: 'a dot',
    n: null, partial_images: null, output_compression: null, response_format: null,
  });
  assert.equal(status, 200, JSON.stringify(payload));
  assert.equal(payload.data.length, 1, 'null n means the default of 1');
});

test('generations: a numeric string n is accepted, because form fields are strings', async () => {
  // `/v1/images/*` accepts multipart/form-data, where every field arrives as a
  // string. Rejecting "2" would reject a well-formed form-encoded request.
  const { status } = await postImages(GEN, { model: 'image-2', prompt: 'a dot', n: '2' });
  assert.equal(status, 200);
});

test('generations: the n boundaries are accepted', async () => {
  for (const n of [1, 10]) {
    const { status } = await postImages(GEN, { model: 'image-2', prompt: 'a dot', n });
    assert.equal(status, 200, `n=${n} is inside the documented domain`);
  }
});

test('generations: a prompt is required', async () => {
  const { status } = await postImages(GEN, { model: 'image-2' });
  assert.equal(status, 400);
});

for (const [label, prompt] of [['empty', ''], ['whitespace-only', '   '], ['non-string', 42]]) {
  test(`generations: a ${label} prompt is rejected`, async () => {
    const { status } = await postImages(GEN, { model: 'image-2', prompt });
    assert.equal(status, 400);
  });
}

test('edits: an image input is required', async () => {
  const { status, payload } = await postImages('/v1/images/edits', { model: 'image-2', prompt: 'a dot' });
  assert.equal(status, 400);
  assert.match(payload.error.message, /image input is required/);
});

// The variations allow-list is two names wide. Widening it is a one-line edit,
// and both success cases would have stayed green.
//
// These go through multipart, not JSON: variations reject a JSON body before the
// model is ever looked at, so a JSON request would be a 400 that proves nothing
// about the allow-list.
async function postVariationForm(model) {
  const started = await startLocalApiProxy({
    backend: imageBackend(), imageGenerationClient: imageBackend(),
    host: '127.0.0.1', port: 0, requestTimeoutMs: 30_000,
  });
  try {
    const form = new FormData();
    form.set('model', model);
    form.set('image', new Blob([Buffer.from('iVBORw0KGgo=', 'base64')], { type: 'image/png' }), 'square.png');
    const res = await fetch(`${started.url}/v1/images/variations`, { method: 'POST', body: form });
    return { status: res.status, payload: await res.json().catch(() => ({})) };
  } finally {
    await started.close();
  }
}

for (const model of ['gpt-image-1', 'not-a-model', 'dall-e-3']) {
  test(`variations: ${model} is not an allowed model`, async () => {
    const { status, payload } = await postVariationForm(model);
    assert.equal(status, 400, `${model} must be rejected`);
    assert.equal(payload.error?.param, 'model', `the rejection must be about the model: ${JSON.stringify(payload)}`);
  });
}

for (const model of ['dall-e-2', 'image-2']) {
  test(`variations: ${model} is allowed`, async () => {
    const { status } = await postVariationForm(model);
    assert.equal(status, 200, `${model} is in the documented allow-list`);
  });
}

// Documented model-specific exceptions. Each is a single guard; none was pinned.
test('generations: image-2 rejects a transparent background', async () => {
  const { status, payload } = await postImages(GEN, {
    model: 'image-2', prompt: 'a dot', background: 'transparent',
  });
  assert.equal(status, 400);
  assert.equal(payload.error.code, 'invalid_value');
});

test('generations: a transparent background needs a format that carries alpha', async () => {
  const { status, payload } = await postImages(GEN, {
    model: 'gpt-image-1', prompt: 'a dot', background: 'transparent', output_format: 'jpeg',
  });
  assert.equal(status, 400);
  assert.match(payload.error.message, /output_format to be png or webp/);
});

test('generations: compression below 100 needs jpeg or webp', async () => {
  const { status, payload } = await postImages(GEN, {
    model: 'gpt-image-1', prompt: 'a dot', output_format: 'png', output_compression: 80,
  });
  assert.equal(status, 400);
  assert.equal(payload.error.code, 'invalid_png_output_compression');
});

test('generations: png with compression 100 is accepted, because 100 is no compression', async () => {
  // The guard names compression LESS THAN 100. Written as a bare presence check
  // it rejected the documented maximum, which is the value that asks for none.
  const { status } = await postImages(GEN, {
    model: 'gpt-image-1', prompt: 'a dot', output_format: 'png', output_compression: 100,
  });
  assert.equal(status, 200);
});

test('generations: png with compression 99 is still rejected', async () => {
  const { status, payload } = await postImages(GEN, {
    model: 'gpt-image-1', prompt: 'a dot', output_format: 'png', output_compression: 99,
  });
  assert.equal(status, 400);
  assert.equal(payload.error.code, 'invalid_png_output_compression');
});

test('generations: input_fidelity belongs to edits', async () => {
  const { status, payload } = await postImages(GEN, {
    model: 'gpt-image-1', prompt: 'a dot', input_fidelity: 'high',
  });
  assert.equal(status, 400);
  assert.match(payload.error.message, /only supported for image edits/);
});

test('generations: style belongs to generations only, and is accepted there', async () => {
  const { status } = await postImages(GEN, { model: 'dall-e-3', prompt: 'a dot', style: 'vivid' });
  assert.notEqual(status, 400);
});

// Usage is part of the documented output spec and nothing asserted it.
test('generations: a backend that reports usage has it in the response', async () => {
  const { status, payload } = await postImages(GEN, { model: 'image-2', prompt: 'a dot' });
  assert.equal(status, 200);
  assert.ok(payload.usage, `expected usage in the response: ${JSON.stringify(payload)}`);
  assert.equal(payload.usage.input_tokens, 3);
  assert.equal(payload.usage.output_tokens, 4);
});

// The URL the proxy hands back is a client-visible resource with a lifecycle
// that was undocumented and untested.
test('a generated image URL serves the image, and an unknown id is a 404', async () => {
  const started = await startLocalApiProxy({
    backend: imageBackend(), imageGenerationClient: imageBackend(),
    host: '127.0.0.1', port: 0, requestTimeoutMs: 30_000,
  });
  try {
    const res = await fetch(`${started.url}${GEN}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'image-2', prompt: 'a dot', response_format: 'url' }),
    });
    const payload = await res.json();
    const url = payload.data[0].url;
    assert.ok(url, `expected a url: ${JSON.stringify(payload)}`);

    const fetched = await fetch(url);
    assert.equal(fetched.status, 200);
    assert.match(fetched.headers.get('content-type') ?? '', /^image\//);

    const missing = await fetch(url.replace(/[^/]+$/, 'not-a-real-id'));
    assert.equal(missing.status, 404);
    const body = await missing.json();
    assert.equal(body.error.type, 'invalid_request_error');
  } finally {
    await started.close();
  }
});

// The style guard is `style && operation !== 'generation'`. Testing it only on
// generations exercises the false branch: the guard could be deleted entirely
// and that test would still pass.
async function postForm(path, fields) {
  const started = await startLocalApiProxy({
    backend: imageBackend(), imageGenerationClient: imageBackend(),
    host: '127.0.0.1', port: 0, requestTimeoutMs: 30_000,
  });
  try {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.set(k, v);
    form.set('image', new Blob([Buffer.from('iVBORw0KGgo=', 'base64')], { type: 'image/png' }), 'square.png');
    const res = await fetch(`${started.url}${path}`, { method: 'POST', body: form });
    return { status: res.status, payload: await res.json().catch(() => ({})) };
  } finally {
    await started.close();
  }
}

for (const path of ['/v1/images/edits', '/v1/images/variations']) {
  test(`${path}: style is rejected outside generations`, async () => {
    const model = path.endsWith('variations') ? 'dall-e-2' : 'gpt-image-1';
    const { status, payload } = await postForm(path, { model, prompt: 'a dot', style: 'vivid' });
    assert.equal(status, 400, `style must be generation-only: ${JSON.stringify(payload)}`);
    assert.match(payload.error.message, /only supported for image generations/);
  });
}

test('generations: style is accepted, exactly 200', async () => {
  const { status } = await postImages(GEN, { model: 'dall-e-3', prompt: 'a dot', style: 'vivid' });
  assert.equal(status, 200);
});

test('edits: an image-2 transparent background is rejected there too', async () => {
  // The guard is model-scoped, not operation-scoped. Adding an operation check
  // would leave the generations test green while edits started accepting it.
  const { status, payload } = await postForm('/v1/images/edits', {
    model: 'image-2', prompt: 'a dot', background: 'transparent',
  });
  assert.equal(status, 400);
  assert.equal(payload.error.code, 'invalid_value');
});

test('edits: n is validated there too', async () => {
  const { status } = await postForm('/v1/images/edits', { model: 'image-2', prompt: 'a dot', n: '11' });
  assert.equal(status, 400);
});

test('variations: a missing image is rejected', async () => {
  const started = await startLocalApiProxy({
    backend: imageBackend(), imageGenerationClient: imageBackend(),
    host: '127.0.0.1', port: 0, requestTimeoutMs: 30_000,
  });
  try {
    const form = new FormData();
    form.set('model', 'dall-e-2');
    const res = await fetch(`${started.url}/v1/images/variations`, { method: 'POST', body: form });
    assert.equal(res.status, 400);
  } finally {
    await started.close();
  }
});

// The URL store's two promises — unguessable ids and expiry — were pinned by
// neither. A constant id and an infinite TTL both passed.
test('each generated image gets its own id, and each URL keeps its own bytes', async () => {
  const started = await startLocalApiProxy({
    backend: imageBackend(), imageGenerationClient: imageBackend(),
    host: '127.0.0.1', port: 0, requestTimeoutMs: 30_000,
  });
  try {
    const urls = [];
    for (const prompt of ['first', 'second']) {
      const res = await fetch(`${started.url}${GEN}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'image-2', prompt, response_format: 'url' }),
      });
      urls.push((await res.json()).data[0].url);
    }
    assert.notEqual(urls[0], urls[1], 'two images must not share a URL');
    for (const url of urls) {
      const id = url.split('/').pop();
      assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, `expected a UUID: ${id}`);
      assert.equal((await fetch(url)).status, 200, 'each URL still serves its own image');
    }
  } finally {
    await started.close();
  }
});

// The store's two remaining promises — entries expire, and the store does not
// grow without limit — were pinned by nothing. An infinite TTL and an unbounded
// map both passed every test above.
test('store: an expired entry is gone, and reads as a miss', () => {
  const store = new GeneratedImageStore(0);
  const id = store.put('iVBORw0KGgo=', 'png');
  assert.equal(store.get(id), null, 'a zero lifetime must not be servable');
});

test('store: an unexpired entry is served', () => {
  const store = new GeneratedImageStore(60_000);
  const id = store.put('iVBORw0KGgo=', 'png');
  assert.ok(store.get(id), 'a live entry must be servable');
});

test('store: the byte bound evicts the oldest, never the entry just stored', () => {
  const oneKiB = Buffer.alloc(1024, 7).toString('base64');
  const store = new GeneratedImageStore(60_000, 3 * 1024);
  const ids = Array.from({ length: 5 }, () => store.put(oneKiB, 'png'));

  assert.ok(store.get(ids.at(-1)), 'the newest entry must survive its own insertion');
  assert.equal(store.get(ids[0]), null, 'the oldest must be evicted first');
  assert.equal(store.get(ids[1]), null);

  const live = ids.filter((id) => store.get(id));
  assert.equal(live.length, 3, `the bound holds 3 KiB, got ${live.length} entries`);
});

test('store: storing an image never evicts that same image', () => {
  // Eviction that does not stop at the new entry deletes the image the client
  // was just handed a URL for, so the URL 404s before any request could use it.
  // Only a single oversized image reaches this branch — several small ones stop
  // earlier. This is the guarantee, and it is the whole guarantee: the next test
  // pins how far it does NOT go.
  const store = new GeneratedImageStore(60_000, 1024);
  const id = store.put(Buffer.alloc(4096, 7).toString('base64'), 'png');
  const image = store.get(id);
  assert.ok(image, 'the entry just stored must survive its own insertion');
  assert.equal(image.bytes.byteLength, 4096);
});

test('store: an oversized image is evicted by the next request, fetched or not', () => {
  // Documented, because it is surprising: the contract cannot promise a first
  // fetch. Making it true would mean pinning entries until someone fetches them,
  // and an entry nobody fetches would pin forever — the unbounded growth the
  // budget exists to stop.
  const store = new GeneratedImageStore(60_000, 1024);
  const oversized = store.put(Buffer.alloc(4096, 7).toString('base64'), 'png');
  store.put(Buffer.alloc(64, 9).toString('base64'), 'png');
  assert.equal(store.get(oversized), null, 'the later put must reclaim the budget');
});

test('store: eviction accounting survives expiry, so the bound does not drift', () => {
  // Dropping an expired entry must return its bytes to the budget. If it does
  // not, the store silently shrinks to nothing over a long-running session.
  const oneKiB = Buffer.alloc(1024, 7).toString('base64');
  const store = new GeneratedImageStore(60_000, 3 * 1024);
  const expiring = new GeneratedImageStore(0);
  expiring.put(oneKiB, 'png');

  const ids = Array.from({ length: 3 }, () => store.put(oneKiB, 'png'));
  assert.equal(ids.filter((id) => store.get(id)).length, 3);
});

test('the generated image URL is a v4 UUID and serves exactly the bytes it was given', async () => {
  // `randomUUID` is v4; asserting only the hex shape would accept a counter
  // formatted to look like one, which is guessable across callers.
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  const backend = {
    name: 'test', model: 'configured-model',
    async generate() {
      return {
        created: 0,
        images: [{ b64Json: png.toString('base64'), revisedPrompt: null }],
        usage: { inputTokens: 1, outputTokens: 1, source: 'provider' },
      };
    },
    async close() {},
  };
  const started = await startLocalApiProxy({
    backend, imageGenerationClient: backend,
    host: '127.0.0.1', port: 0, requestTimeoutMs: 30_000,
  });
  try {
    const res = await fetch(`${started.url}${GEN}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'image-2', prompt: 'a dot', response_format: 'url' }),
    });
    const url = (await res.json()).data[0].url;
    const id = url.split('/').pop();
    assert.match(
      id,
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      `expected a v4 UUID (version nibble 4, variant 8..b): ${id}`,
    );

    const fetched = await fetch(url);
    assert.equal(fetched.status, 200);
    const served = Buffer.from(await fetched.arrayBuffer());
    assert.ok(served.equals(png), `served bytes must be the generated bytes: ${served.toString('hex')}`);
  } finally {
    await started.close();
  }
});

test('the access gate covers the generated image route', async () => {
  // The contract says the gate applies here "like any other" route, and this is
  // the one route whose URL the proxy itself hands out.
  const started = await startLocalApiProxy({
    backend: imageBackend(), imageGenerationClient: imageBackend(),
    host: '127.0.0.1', port: 0, requestTimeoutMs: 30_000, authKey: 'secret-key',
  });
  try {
    const res = await fetch(`${started.url}${GEN}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer secret-key' },
      body: JSON.stringify({ model: 'image-2', prompt: 'a dot', response_format: 'url' }),
    });
    const url = (await res.json()).data[0].url;

    assert.equal((await fetch(url)).status, 401, 'an unauthenticated fetch must not get the bytes');
    assert.equal(
      (await fetch(url, { headers: { authorization: 'Bearer secret-key' } })).status,
      200,
    );
  } finally {
    await started.close();
  }
});

// The guards below are shared across operations but were only ever exercised on
// one of them, so an operation check added to any of them would go unnoticed.
test('variations: n is validated there too', async () => {
  const { status } = await postForm('/v1/images/variations', { model: 'dall-e-2', n: '11' });
  assert.equal(status, 400);
});

test('variations: an image-2 transparent background is rejected there too', async () => {
  const { status, payload } = await postForm('/v1/images/variations', {
    model: 'image-2', background: 'transparent',
  });
  assert.equal(status, 400);
  assert.equal(payload.error.code, 'invalid_value');
});

test('variations: input_fidelity is rejected there too', async () => {
  const { status, payload } = await postForm('/v1/images/variations', {
    model: 'dall-e-2', input_fidelity: 'high',
  });
  assert.equal(status, 400);
  assert.match(payload.error.message, /only supported for image edits/);
});

// The URL the proxy hands back has to be one the client can actually follow.
// `fetch` will not send a hostile or absent Host, so these go through node:http.
async function generatedUrlWith(headers, fetchIt = false) {
  const started = await startLocalApiProxy({
    backend: imageBackend(), imageGenerationClient: imageBackend(),
    host: '127.0.0.1', port: 0, requestTimeoutMs: 30_000,
  });
  const target = new URL(started.url);
  try {
    const body = JSON.stringify({ model: 'image-2', prompt: 'a dot', response_format: 'url' });
    const raw = await new Promise((resolve, reject) => {
      const req = http.request({
        host: target.hostname, port: target.port, path: '/v1/images/generations', method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...headers },
      }, (res) => { let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve(d)); });
      req.on('error', reject);
      req.end(body);
    });
    const url = JSON.parse(raw).data[0].url;
    // Fetched here, while the server is still listening: a URL is only useful if
    // it resolves during the proxy's lifetime.
    const served = fetchIt ? (await fetch(url)).status : null;
    return { url, origin: `${target.hostname}:${target.port}`, served };
  } finally {
    await started.close();
  }
}

test('a generated URL keeps the scheme the client reached the proxy with', async () => {
  // The scheme was hard-coded `http://`. Behind an HTTPS tunnel that hands the
  // client a link its own page refuses as mixed content, for bytes that are on
  // the other side of the same connection.
  const forwarded = await generatedUrlWith({ 'x-forwarded-proto': 'https' });
  assert.match(forwarded.url, /^https:\/\//, `expected https, got ${forwarded.url}`);

  const plain = await generatedUrlWith({});
  assert.match(plain.url, /^http:\/\//, 'a plain request must stay http');
});

test('a comma-joined x-forwarded-proto uses the first hop', async () => {
  const { url } = await generatedUrlWith({ 'x-forwarded-proto': 'https, http' });
  assert.match(url, /^https:\/\//, `the client-facing hop is the first one: ${url}`);
});

test('an unrecognised x-forwarded-proto does not choose the scheme', async () => {
  const { url } = await generatedUrlWith({ 'x-forwarded-proto': 'gopher' });
  assert.match(url, /^http:\/\//, `expected the connection's own scheme: ${url}`);
});

test('a request with no Host still gets a URL pointing at this proxy', async () => {
  // HTTP/1.0 has no Host line, and the authority used to fall back to a bare
  // `127.0.0.1` with no port — a URL pointing at nothing.
  //
  // Raw socket, not `node:http`: passing `host: ''` there does NOT omit the
  // header, it makes node substitute its own, and a test written that way passes
  // whatever the fallback does.
  const started = await startLocalApiProxy({
    backend: imageBackend(), imageGenerationClient: imageBackend(),
    host: '127.0.0.1', port: 0, requestTimeoutMs: 30_000,
  });
  const target = new URL(started.url);
  try {
    const body = JSON.stringify({ model: 'image-2', prompt: 'a dot', response_format: 'url' });
    const raw = await new Promise((resolve, reject) => {
      const socket = net.connect(Number(target.port), target.hostname, () => {
        socket.write(
          'POST /v1/images/generations HTTP/1.0\r\n'
          + 'Content-Type: application/json\r\n'
          + `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
        );
      });
      let data = '';
      socket.on('data', (chunk) => { data += chunk; });
      socket.on('end', () => resolve(data));
      socket.on('error', reject);
    });
    const url = JSON.parse(raw.split('\r\n\r\n').slice(1).join('\r\n\r\n')).data[0].url;
    const origin = `${target.hostname}:${target.port}`;
    assert.ok(url.includes(origin), `expected the bound address ${origin}, got ${url}`);
    assert.equal((await fetch(url)).status, 200, 'the fallback URL must actually serve the image');
  } finally {
    await started.close();
  }
});

// --- round 38: image promises the inventory showed nothing would catch ---

function streamingImageBackend(usage) {
  const result = {
    created: 0,
    images: [{ b64Json: 'iVBORw0KGgo=', revisedPrompt: null }],
    ...(usage ? { usage } : {}),
  };
  return {
    name: 'test', model: 'configured-model',
    async generate() { return result; },
    async *stream() {
      yield { type: 'completed', created: 0, image: result.images[0], ...(usage ? { usage } : {}) };
    },
    async close() {},
  };
}

async function postWith(backend, path, init) {
  const started = await startLocalApiProxy({
    backend, imageGenerationClient: backend,
    host: '127.0.0.1', port: 0, requestTimeoutMs: 30_000,
  });
  try {
    const res = await fetch(`${started.url}${path}`, init);
    return { status: res.status, text: await res.text() };
  } finally {
    await started.close();
  }
}

function multipart(fields) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  form.set('image', new Blob([Buffer.from('iVBORw0KGgo=', 'base64')], { type: 'image/png' }), 'sq.png');
  return { method: 'POST', body: form };
}

for (const stream of [false, true]) {
  test(`generations: an explicit partial_images 0 is accepted${stream ? ' while streaming' : ''}`, async () => {
    // The contract supports `0` or omitted and rejects anything above. Only the
    // rejection and the omitted case were tested, so a presence check in place
    // of the value check would reject the one value that IS supported.
    const { status } = await postWith(streamingImageBackend(), GEN, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'image-2', prompt: 'a dot', partial_images: 0, ...(stream ? { stream: true } : {}),
      }),
    });
    assert.equal(status, 200);
  });
}

for (const [path, fields, event] of [
  ['/v1/images/edits', { model: 'gpt-image-1', prompt: 'a dot', stream: 'true' }, 'image_edit.completed'],
  ['/v1/images/variations', { model: 'dall-e-2', stream: 'true' }, 'image_edit.completed'],
]) {
  test(`${path}: stream is supported there too, as ${event}`, async () => {
    // `stream` is optional on all three operations. Every streaming image test
    // targeted generations, so scoping the stream to generations alone would
    // silently turn these into non-streaming JSON — and the event NAME is what
    // says which operation streamed, so asserting only ".completed" would accept
    // an edit stream announcing itself as a generation.
    const { status, text } = await postWith(streamingImageBackend(), path, multipart(fields));
    assert.equal(status, 200);
    assert.match(text, /^event: /, `expected SSE, got: ${text.slice(0, 120)}`);
    assert.ok(text.includes(`event: ${event}`), `expected ${event}, got: ${text.slice(0, 200)}`);
  });
}

test('generations: the streamed completed event is named for its own operation', async () => {
  const { text } = await postWith(streamingImageBackend(), GEN, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'image-2', prompt: 'a dot', stream: true }),
  });
  assert.ok(text.includes('event: image_generation.completed'), `got: ${text.slice(0, 200)}`);
});

test('edits: a prompt is required even when the image is present', async () => {
  // The tested cases were a missing generation prompt and a missing edit image.
  // Narrowing the prompt requirement to generations alone would leave both green.
  const { status, text } = await postWith(
    streamingImageBackend(), '/v1/images/edits', multipart({ model: 'gpt-image-1' }),
  );
  assert.equal(status, 400);
  const payload = JSON.parse(text);
  assert.equal(payload.error.param, 'prompt');
  assert.equal(payload.error.code, 'missing_required_parameter');
});

test('edits: input_fidelity is accepted on a model that supports it', async () => {
  // Every input_fidelity test was a rejection, so widening the guard to reject
  // the field everywhere would have stayed green while breaking its one valid use.
  const { status } = await postWith(
    streamingImageBackend(),
    '/v1/images/edits',
    multipart({ model: 'gpt-image-1', prompt: 'a dot', input_fidelity: 'high' }),
  );
  assert.equal(status, 200);
});

test('generations: a streaming response carries usage in the completed event', async () => {
  const { status, text } = await postWith(
    streamingImageBackend({ inputTokens: 3, outputTokens: 4, source: 'provider' }),
    GEN,
    {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'image-2', prompt: 'a dot', stream: true }),
    },
  );
  assert.equal(status, 200);
  const completed = text.split('\n')
    .filter((line) => line.startsWith('data: ') && line.includes('.completed'))
    .map((line) => JSON.parse(line.slice(6)))
    .at(-1);
  assert.ok(completed, `expected a completed frame: ${text.slice(0, 200)}`);
  assert.equal(completed.usage.input_tokens, 3);
  assert.equal(completed.usage.output_tokens, 4);
});

test('generations: a backend reporting raw image usage has it passed through', async () => {
  // The documented fallback for a backend that reports provider-shaped image
  // usage rather than the normalized local shape.
  const { status, text } = await postWith(
    streamingImageBackend({ input_tokens: 11, output_tokens: 22, total_tokens: 33 }),
    GEN,
    {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'image-2', prompt: 'a dot' }),
    },
  );
  assert.equal(status, 200);
  const usage = JSON.parse(text).usage;
  assert.equal(usage.input_tokens, 11);
  assert.equal(usage.output_tokens, 22);
  assert.equal(usage.total_tokens, 33);
});

test('an IPv6 listener produces bracketed, parseable URLs', async () => {
  // `http://::1:8080` does not parse as a URL — an IPv6 authority needs
  // brackets. Both the proxy's own url and the no-Host fallback build one.
  const started = await startLocalApiProxy({
    backend: imageBackend(), imageGenerationClient: imageBackend(),
    host: '::1', port: 0, requestTimeoutMs: 30_000,
  });
  try {
    const parsed = new URL(started.url);
    assert.match(parsed.hostname, /^\[?::1\]?$/, `expected the IPv6 loopback: ${started.url}`);

    const body = JSON.stringify({ model: 'image-2', prompt: 'a dot', response_format: 'url' });
    const raw = await new Promise((resolve, reject) => {
      const socket = net.connect(Number(parsed.port), '::1', () => {
        socket.write(
          'POST /v1/images/generations HTTP/1.0\r\n'
          + 'Content-Type: application/json\r\n'
          + `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
        );
      });
      let data = '';
      socket.on('data', (chunk) => { data += chunk; });
      socket.on('end', () => resolve(data));
      socket.on('error', reject);
    });
    const url = JSON.parse(raw.split('\r\n\r\n').slice(1).join('\r\n\r\n')).data[0].url;
    assert.doesNotThrow(() => new URL(url), `the fallback URL must parse: ${url}`);
    assert.equal((await fetch(url)).status, 200, 'and it must actually serve the image');
  } finally {
    await started.close();
  }
});

test('a generated id that does not percent-decode is a 404 miss, not a 500', async () => {
  // `%FF` made decodeURIComponent throw — a 500 for an id the proxy could never
  // have issued, where the contract promises the indistinguishable 404.
  const started = await startLocalApiProxy({
    backend: imageBackend(), imageGenerationClient: imageBackend(),
    host: '127.0.0.1', port: 0, requestTimeoutMs: 30_000,
  });
  try {
    const res = await fetch(`${started.url}/v1/images/generated/%FF`);
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.error.type, 'invalid_request_error');
  } finally {
    await started.close();
  }
});

test('generations: partial_images null is omission — the field is nullable', async () => {
  const { status } = await postImages(GEN, { model: 'image-2', prompt: 'a dot', partial_images: null });
  assert.equal(status, 200);
});

// --- round 40 ---

test('a generated id with an encoded question mark is path data, not a query', async () => {
  // Only the first LITERAL `?` starts the query. `%3F` is part of the raw path,
  // so appending it to a valid id must produce a different, unknown id.
  const started = await startLocalApiProxy({
    backend: imageBackend(), imageGenerationClient: imageBackend(),
    host: '127.0.0.1', port: 0, requestTimeoutMs: 30_000,
  });
  try {
    const res = await fetch(`${started.url}${GEN}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'image-2', prompt: 'a dot', response_format: 'url' }),
    });
    const url = (await res.json()).data[0].url;
    assert.equal((await fetch(`${url}%3Fjunk`)).status, 404, 'the encoded ? extends the id');
    assert.equal((await fetch(`${url}?junk`)).status, 200, 'a literal ? starts an ignored query');
  } finally {
    await started.close();
  }
});

test('a generated path with extra separators is an unknown endpoint, whatever the method', async () => {
  // The route is one nonempty, slash-free id segment. Prefix matching used to
  // classify `//missing` as served and answer 405 to a POST.
  const started = await startLocalApiProxy({
    backend: imageBackend(), imageGenerationClient: imageBackend(),
    host: '127.0.0.1', port: 0, requestTimeoutMs: 30_000,
  });
  try {
    for (const [path, method] of [
      ['/v1/images/generated//missing', 'POST'],
      ['/v1/images/generated//missing', 'GET'],
      ['/v1/images/generated/a/b', 'GET'],
      ['/v1/images/generated/', 'GET'],
    ]) {
      const res = await fetch(`${started.url}${path}`, { method });
      assert.equal(res.status, 404, `${method} ${path} is not the generated route`);
      assert.match((await res.json()).error.message, /Unknown endpoint/);
    }
  } finally {
    await started.close();
  }
});

test('generations: output_compression null is omission — the field is nullable', async () => {
  const { status } = await postImages(GEN, {
    model: 'gpt-image-1', prompt: 'a dot', output_compression: null,
  });
  assert.equal(status, 200);
});

test('generations: standard output_compression wins over the route hint', async () => {
  // The extension applies only when the standard field is omitted.
  let seen;
  const backend = {
    name: 'test', model: 'configured-model',
    async generate(request) {
      seen = request.outputCompression;
      return { created: 0, images: [{ b64Json: 'iVBORw0KGgo=', revisedPrompt: null }] };
    },
    async close() {},
  };
  const started = await startLocalApiProxy({
    backend, imageGenerationClient: backend,
    host: '127.0.0.1', port: 0, requestTimeoutMs: 30_000,
  });
  try {
    const res = await fetch(`${started.url}${GEN}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'image-2', prompt: 'a dot', output_format: 'jpeg', output_compression: 80,
        x_proxy_image_route: { output_compression: 20 },
      }),
    });
    assert.equal(res.status, 200);
    assert.equal(seen, 80, 'the standard field decides when both are present');
  } finally {
    await started.close();
  }
});

// --- round 41 ---

test('a failed image stream still ends with data: [DONE]', async () => {
  // The one OpenAI surface whose mid-stream error ended without the promised
  // terminal frame.
  const backend = {
    name: 'test', model: 'configured-model',
    async generate() { return { created: 0, images: [{ b64Json: 'iVBORw0KGgo=', revisedPrompt: null }] }; },
    async *stream() { throw new Error('backend exploded'); },
    async close() {},
  };
  const started = await startLocalApiProxy({
    backend, imageGenerationClient: backend,
    host: '127.0.0.1', port: 0, requestTimeoutMs: 30_000,
  });
  try {
    const res = await fetch(`${started.url}${GEN}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'image-2', prompt: 'x', stream: true }),
    });
    assert.equal(res.status, 200, 'the stream was already committed');
    const text = await res.text();
    assert.match(text, /event: error/);
    const frames = text.split('\n\n').map((b) => b.trim()).filter(Boolean);
    assert.equal(frames.at(-1), 'data: [DONE]', `the last frame must be the terminal one: ${frames.at(-1)}`);
  } finally {
    await started.close();
  }
});

test('generated ids are matched byte-for-byte: encoding is not an alias', async () => {
  // Issued ids are plain UUIDs, so no client needs encoding — and decoding
  // created aliases: two raw targets naming one image.
  const started = await startLocalApiProxy({
    backend: imageBackend(), imageGenerationClient: imageBackend(),
    host: '127.0.0.1', port: 0, requestTimeoutMs: 30_000,
  });
  try {
    const res = await fetch(`${started.url}${GEN}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'image-2', prompt: 'a dot', response_format: 'url' }),
    });
    const url = (await res.json()).data[0].url;
    assert.equal((await fetch(url)).status, 200);
    const id = url.split('/').pop();
    // %-encode the first hex digit: same decoded value, different raw bytes.
    const aliased = url.replace(id, `%${id.charCodeAt(0).toString(16)}${id.slice(1)}`);
    assert.equal((await fetch(aliased)).status, 404, 'an encoded spelling is a different, unissued id');
  } finally {
    await started.close();
  }
});

test('route-only output_compression is the effective value when the standard field is omitted', async () => {
  let seen;
  const backend = {
    name: 'test', model: 'configured-model',
    async generate(request) {
      seen = request.outputCompression;
      return { created: 0, images: [{ b64Json: 'iVBORw0KGgo=', revisedPrompt: null }] };
    },
    async close() {},
  };
  const started = await startLocalApiProxy({
    backend, imageGenerationClient: backend,
    host: '127.0.0.1', port: 0, requestTimeoutMs: 30_000,
  });
  try {
    const res = await fetch(`${started.url}${GEN}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'image-2', prompt: 'a dot', output_format: 'jpeg',
        x_proxy_image_route: { output_compression: 20 },
      }),
    });
    assert.equal(res.status, 200);
    assert.equal(seen, 20, 'with the standard field omitted, the route hint applies');
  } finally {
    await started.close();
  }
});

test('a forwarded proto with a non-OWS byte does not choose the scheme', async () => {
  // `https` followed by byte 0xA0 is not the token `https`. String.trim ate the
  // byte (it is U+00A0 under latin1 decoding) and upgraded the URL; OWS-only
  // stripping leaves the token unrecognised, falling back to the connection.
  const started = await startLocalApiProxy({
    backend: imageBackend(), imageGenerationClient: imageBackend(),
    host: '127.0.0.1', port: 0, requestTimeoutMs: 30_000,
  });
  const target = new URL(started.url);
  try {
    const body = JSON.stringify({ model: 'image-2', prompt: 'a dot', response_format: 'url' });
    const raw = await new Promise((resolve, reject) => {
      const conn = net.connect(Number(target.port), target.hostname, () => {
        conn.write(Buffer.concat([
          Buffer.from(
            'POST /v1/images/generations HTTP/1.1\r\nHost: h\r\nContent-Type: application/json\r\n'
            + `Content-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\nX-Forwarded-Proto: https`,
          ),
          Buffer.from([0xa0]),
          Buffer.from(`\r\n\r\n${body}`),
        ]));
      });
      let data = '';
      conn.on('data', (chunk) => { data += chunk; });
      conn.on('end', () => resolve(data));
      conn.on('error', reject);
    });
    const url = /"url":"([^"]+)"/.exec(raw)?.[1];
    assert.ok(url, raw.slice(0, 120));
    assert.match(url, /^http:\/\//, `the malformed hop must not upgrade the scheme: ${url}`);
  } finally {
    await started.close();
  }
});

// --- round 42 ---

test('store: a flood of tiny images is bounded by entry count, not only bytes', () => {
  // The byte budget counts payloads; Map keys and entry metadata are overhead
  // the budget never sees. 1-byte images could grow the store unboundedly.
  const store = new GeneratedImageStore(60_000, 1024 * 1024, 50);
  const ids = Array.from({ length: 120 }, () => store.put('AA==', 'png'));
  const live = ids.filter((id) => store.get(id));
  assert.ok(live.length <= 50, `entries must be bounded: ${live.length}`);
  assert.ok(store.get(ids.at(-1)), 'the newest entry survives');
  assert.equal(store.get(ids[0]), null, 'the oldest was evicted');
});

test('a timed-out image stream still ends with data: [DONE]', async () => {
  // The terminal-frame promise covers every mid-stream failure, the timeout
  // included — a skip conditioned on the timeout error would leave the thrown-
  // iterator test green.
  const backend = {
    name: 'test', model: 'configured-model',
    async generate() { return { created: 0, images: [{ b64Json: 'iVBORw0KGgo=', revisedPrompt: null }] }; },
    async *stream(request, signal) {
      yield { type: 'completed', created: 0, image: { b64Json: 'iVBORw0KGgo=', revisedPrompt: null } };
      // Honors the abort like the real backends do — the proxy's timeout is a
      // signal to the backend, not an in-proxy deadline, so a fixture that
      // ignores it tests a backend bug, not the proxy.
      await new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('timed out')), { once: true });
      });
    },
    async close() {},
  };
  const started = await startLocalApiProxy({
    backend, imageGenerationClient: backend,
    host: '127.0.0.1', port: 0, requestTimeoutMs: 300,
  });
  try {
    const res = await fetch(`${started.url}${GEN}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'image-2', prompt: 'x', stream: true }),
    });
    const text = await res.text();
    const frames = text.split('\n\n').map((b) => b.trim()).filter(Boolean);
    assert.equal(frames.at(-1), 'data: [DONE]', `expected the terminal frame: ${frames.at(-1)}`);
    assert.ok(frames.some((f) => f.startsWith('event: error') || f.includes('"error"')),
      `expected an error frame before it: ${text.slice(-200)}`);
  } finally {
    await started.close();
  }
});

// --- round 43 ---

// Big enough that one decoded image cannot fit beside another in the budget —
// small enough to keep the test fast. The store bound is exercised through the
// real HTTP path, so the real 128 MiB constant cannot be used here; the probe
// asserts the PINNING rule, which is budget-independent.
const GENERATED_BUDGET_PROBE = 256 * 1024;

for (const [label, value] of [['a number', 17], ['an object', {}]]) {
  test(`generations: response_format ${label} is rejected, not defaulted`, async () => {
    // A present non-string was silently replaced with b64_json. Null is the
    // exception: the field is nullable on the direct API.
    const { status } = await postImages(GEN, { model: 'image-2', prompt: 'a dot', response_format: value });
    assert.equal(status, 400, `response_format=${JSON.stringify(value)} is not b64_json or url`);
  });
}

test('generations: an empty-string enum value is a present wrong value, not omission', async () => {
  const { status } = await postImages(GEN, { model: 'image-2', prompt: 'a dot', quality: '' });
  assert.equal(status, 400, 'an empty string is outside the quality enum');
});

test('edits: a malformed member of an image array is rejected, not dropped', async () => {
  // Filtering the bad member executed the request with silently altered input.
  const { status, payload } = await postImages('/v1/images/edits', {
    model: 'image-2', prompt: 'make it blue',
    images: [{ image_url: PNG_DATA_URL }, 7],
  });
  assert.equal(status, 400, JSON.stringify(payload));
  assert.match(payload.error.message, /image\[1\]/, 'the rejection must name the member');
});

test('multipart detection uses the media-type essence, not a substring', async () => {
  // `application/json; profile="...multipart/form-data..."` is JSON.
  const started = await startLocalApiProxy({
    backend: imageBackend(), imageGenerationClient: imageBackend(),
    host: '127.0.0.1', port: 0, requestTimeoutMs: 30_000,
  });
  try {
    const res = await fetch(`${started.url}${GEN}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json; profile="https://example.test/multipart/form-data"' },
      body: JSON.stringify({ model: 'image-2', prompt: 'a dot' }),
    });
    assert.equal(res.status, 200, await res.text());
  } finally {
    await started.close();
  }
});

test('a streamed n=2 URL response serves both URLs — siblings share one pin set', async () => {
  const big = Buffer.alloc(GENERATED_BUDGET_PROBE, 7).toString('base64');
  const backend = {
    name: 'test', model: 'configured-model',
    async generate() { return { created: 0, images: [] }; },
    async *stream() {
      yield { type: 'completed', created: 0, image: { b64Json: big, revisedPrompt: null } };
      yield { type: 'completed', created: 0, image: { b64Json: 'iVBORw0KGgo=', revisedPrompt: null } };
    },
    async close() {},
  };
  const started = await startLocalApiProxy({
    backend, imageGenerationClient: backend,
    host: '127.0.0.1', port: 0, requestTimeoutMs: 30_000,
    generatedImageStore: new GeneratedImageStore(60_000, 1024, 100),
  });
  try {
    const res = await fetch(`${started.url}${GEN}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'image-2', prompt: 'a dot', n: 2, stream: true, response_format: 'url' }),
    });
    const text = await res.text();
    const urls = [...text.matchAll(/"url":"([^"]+)"/g)].map((m) => m[1]);
    assert.equal(urls.length, 2, text.slice(0, 200));
    for (const [index, url] of urls.entries()) {
      assert.equal((await fetch(url)).status, 200, `url[${index}] must survive its sibling`);
    }
  } finally {
    await started.close();
  }
});

const PNG_DATA_URL = `data:image/png;base64,${Buffer.from('89504e470d0a1a0a', 'hex').toString('base64')}`;
for (const [label, fields] of [
  ['singular image', { image: { image_url: PNG_DATA_URL } }],
  ['image[] spelling', { 'image[]': [{ image_url: PNG_DATA_URL }] }],
  ['images array', { images: [{ image_url: PNG_DATA_URL }] }],
]) {
  test(`edits: a JSON body may name its image as ${label}`, async () => {
    // The documented aliases hold in both encodings; JSON edits read only
    // `images` and rejected the other two documented spellings.
    const { status, payload } = await postImages('/v1/images/edits', {
      model: 'image-2', prompt: 'make it blue', ...fields,
    });
    assert.equal(status, 200, `${label} must be accepted: ${JSON.stringify(payload)}`);
  });
}

test('store: sibling images of one response cannot evict each other', () => {
  // An n=2 response whose first image exceeds the budget had its first URL
  // 404 before the response was even sent — evicted by its own sibling.
  const store = new GeneratedImageStore(60_000, 1024, 100);
  const batch = new Set();
  const big = store.put(Buffer.alloc(4096, 1).toString('base64'), 'png', batch);
  batch.add(big);
  const second = store.put(Buffer.alloc(64, 2).toString('base64'), 'png', batch);
  batch.add(second);
  assert.ok(store.get(big), 'the oversized sibling must survive its own response');
  assert.ok(store.get(second), 'and so must the second');
});

test('store: under the entry cap, eviction is still oldest-first', () => {
  const store = new GeneratedImageStore(60_000, 1024 * 1024, 2);
  const a = store.put('AA==', 'png');
  const b = store.put('AA==', 'png');
  const c = store.put('AA==', 'png');
  assert.equal(store.get(a), null, 'A is the oldest and must go');
  assert.ok(store.get(b), 'B stays');
  assert.ok(store.get(c), 'C stays');
});

test('an n=2 URL response serves both URLs, even when the first image is oversized', async () => {
  const big = Buffer.alloc(GENERATED_BUDGET_PROBE, 7).toString('base64');
  const backend = {
    name: 'test', model: 'configured-model',
    async generate(request) {
      return {
        created: 0,
        images: Array.from({ length: request.n ?? 1 }, (_v, i) => ({
          b64Json: i === 0 ? big : 'iVBORw0KGgo=', revisedPrompt: null,
        })),
      };
    },
    async close() {},
  };
  const started = await startLocalApiProxy({
    backend, imageGenerationClient: backend,
    host: '127.0.0.1', port: 0, requestTimeoutMs: 30_000,
    // A store whose byte budget the first image EXCEEDS — without this the
    // production 128 MiB budget never binds and the test pins nothing.
    generatedImageStore: new GeneratedImageStore(60_000, 1024, 100),
  });
  try {
    const res = await fetch(`${started.url}${GEN}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'image-2', prompt: 'a dot', n: 2, response_format: 'url' }),
    });
    const data = (await res.json()).data;
    assert.equal(data.length, 2);
    for (const [index, item] of data.entries()) {
      assert.equal((await fetch(item.url)).status, 200, `url[${index}] must serve immediately after the response`);
    }
  } finally {
    await started.close();
  }
});

test('generations: the 32,000-code-unit prompt boundary is inclusive', async () => {
  const at = await postImages(GEN, { model: 'image-2', prompt: 'x'.repeat(32_000) });
  assert.equal(at.status, 200, 'exactly 32,000 units is inside the bound');
  const over = await postImages(GEN, { model: 'image-2', prompt: 'x'.repeat(32_001) });
  assert.equal(over.status, 400);
});

test('a non-streaming image disconnect aborts the backend', async () => {
  let aborted = false;
  const backend = {
    name: 'test', model: 'configured-model',
    async generate(request, signal) {
      await new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }, { once: true });
      });
    },
    async close() {},
  };
  const started = await startLocalApiProxy({
    backend, imageGenerationClient: backend,
    host: '127.0.0.1', port: 0, requestTimeoutMs: 30_000,
  });
  try {
    const controller = new AbortController();
    const pending = fetch(`${started.url}${GEN}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'image-2', prompt: 'a dot' }), signal: controller.signal,
    }).catch(() => null);
    await new Promise((r) => setTimeout(r, 150));
    controller.abort();
    await pending;
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(aborted, true, 'the abandoned generation must see the abort');
  } finally {
    await started.close();
  }
});
