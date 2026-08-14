import assert from 'node:assert/strict';
import { test } from 'node:test';
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
  ['explicit null', null],
]) {
  test(`generations: n ${label} is rejected`, async () => {
    const { status, payload } = await postImages(GEN, { model: 'image-2', prompt: 'a dot', n });
    assert.equal(status, 400, `expected a rejection for n=${n}`);
    assert.match(payload.error.message, /n must be an integer between 1 and 10/);
  });
}

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

test('store: an image larger than the whole bound is still served once', () => {
  // Eviction that does not stop at the new entry deletes the image the client
  // was just handed a URL for, so the URL 404s on its first fetch. Only a single
  // oversized image reaches this branch — several small ones stop earlier.
  const store = new GeneratedImageStore(60_000, 1024);
  const id = store.put(Buffer.alloc(4096, 7).toString('base64'), 'png');
  const image = store.get(id);
  assert.ok(image, 'the URL the client was handed must serve its image at least once');
  assert.equal(image.bytes.byteLength, 4096);
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
