import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import net from 'node:net';
import { startLocalApiProxy } from '../dist/proxy/http-server.js';

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

// `n` is an integer in 1..10, and the direct API says which way a value is
// wrong (measured 2026-08-30): the bound it crossed with the value it got, or
// the JSON type it got. Each cell pins the whole envelope.
for (const [label, n, code, message] of [
  ['zero', 0, 'integer_below_min_value', "Invalid 'n': integer below minimum value. Expected a value >= 1, but got 0 instead."],
  ['above the maximum', 11, 'integer_above_max_value', "Invalid 'n': integer above maximum value. Expected a value <= 10, but got 11 instead."],
  ['fractional', 1.5, 'invalid_type', "Invalid type for 'n': expected an integer, but got a decimal number instead."],
  ['a non-numeric string', 'two', 'invalid_type', "Invalid type for 'n': expected an integer, but got a string instead."],
  ['a numeric string, in JSON', '2', 'invalid_type', "Invalid type for 'n': expected an integer, but got a string instead."],
  ['a boolean', true, 'invalid_type', "Invalid type for 'n': expected an integer, but got a boolean instead."],
  ['negative', -1, 'integer_below_min_value', "Invalid 'n': integer below minimum value. Expected a value >= 1, but got -1 instead."],
]) {
  test(`generations: n ${label} is rejected in the direct envelope`, async () => {
    const { status, payload } = await postImages(GEN, { model: 'gpt-image-2', prompt: 'a dot', n });
    assert.equal(status, 400, `expected a rejection for n=${n}`);
    assert.equal(payload.error.param, 'n');
    assert.equal(payload.error.code, code);
    assert.equal(payload.error.message, message);
  });
}

// The same three shapes for the other two integer fields.
for (const [field, value, code, message] of [
  ['output_compression', 101, 'integer_above_max_value', "Invalid 'output_compression': integer above maximum value. Expected a value <= 100, but got 101 instead."],
  ['output_compression', -1, 'integer_below_min_value', "Invalid 'output_compression': integer below minimum value. Expected a value >= 0, but got -1 instead."],
  ['output_compression', 1.5, 'invalid_type', "Invalid type for 'output_compression': expected an integer, but got a decimal number instead."],
  ['output_compression', '50', 'invalid_type', "Invalid type for 'output_compression': expected an integer, but got a string instead."],
  ['partial_images', 4, 'integer_above_max_value', "Invalid 'partial_images': integer above maximum value. Expected a value <= 3, but got 4 instead."],
  ['partial_images', -1, 'integer_below_min_value', "Invalid 'partial_images': integer below minimum value. Expected a value >= 0, but got -1 instead."],
]) {
  test(`generations: ${field} ${JSON.stringify(value)} carries the direct integer envelope`, async () => {
    const { status, payload } = await postImages(GEN, { model: 'gpt-image-2', prompt: 'a dot', [field]: value });
    assert.equal(status, 400);
    assert.equal(payload.error.param, field);
    assert.equal(payload.error.code, code);
    assert.equal(payload.error.message, message);
  });
}

// Enums (measured 2026-08-30): a string outside the set lists the set with
// "and"; a non-string lists it with "or" as a type error. `standard` and `hd`
// were dall-e aliases and are outside the set now.
for (const [field, value, code, message] of [
  ['quality', 'ultra', 'invalid_value', "Invalid value: 'ultra'. Supported values are: 'low', 'medium', 'high', and 'auto'."],
  ['quality', 'standard', 'invalid_value', "Invalid value: 'standard'. Supported values are: 'low', 'medium', 'high', and 'auto'."],
  ['quality', 'hd', 'invalid_value', "Invalid value: 'hd'. Supported values are: 'low', 'medium', 'high', and 'auto'."],
  ['quality', '', 'invalid_value', "Invalid value: ''. Supported values are: 'low', 'medium', 'high', and 'auto'."],
  ['quality', 1, 'invalid_type', "Invalid type for 'quality': expected one of 'low', 'medium', 'high', or 'auto', but got an integer instead."],
  ['output_format', 'gif', 'invalid_value', "Invalid value: 'gif'. Supported values are: 'png', 'webp', and 'jpeg'."],
  ['moderation', 'bogus', 'invalid_value', "Invalid value: 'bogus'. Supported values are: 'auto' and 'low'."],
  ['background', 'bogus', 'invalid_value', "Invalid value: 'bogus'. Supported values are: 'transparent', 'opaque', and 'auto'."],
]) {
  test(`generations: ${field} ${JSON.stringify(value)} carries the direct enum envelope`, async () => {
    const { status, payload } = await postImages(GEN, { model: 'gpt-image-2', prompt: 'a dot', [field]: value });
    assert.equal(status, 400);
    assert.equal(payload.error.param, field);
    assert.equal(payload.error.code, code);
    assert.equal(payload.error.message, message);
  });
}

for (const [size, message] of [
  ['bogus', "Invalid size 'bogus'. Expected WIDTHxHEIGHT, for example '1824x1024'."],
  ['0x0', "Invalid size '0x0'. Expected WIDTHxHEIGHT, for example '1824x1024'."],
  ['9x9', "Invalid size '9x9'. Width and height must both be divisible by 16."],
]) {
  test(`generations: size ${size} carries the direct size envelope`, async () => {
    const { status, payload } = await postImages(GEN, { model: 'gpt-image-2', prompt: 'a dot', size });
    assert.equal(status, 400);
    assert.equal(payload.error.type, 'image_generation_user_error');
    assert.equal(payload.error.param, 'size');
    assert.equal(payload.error.code, 'invalid_value');
    assert.equal(payload.error.message, message);
  });
}

test('generations: stream that is not a boolean is a type error in JSON', async () => {
  const { status, payload } = await postImages(GEN, { model: 'gpt-image-2', prompt: 'a dot', stream: 'yes' });
  assert.equal(status, 400);
  assert.equal(payload.error.code, 'invalid_type');
  assert.equal(payload.error.message, "Invalid type for 'stream': expected a boolean, but got a string instead.");
});

test('generations: an unknown top-level field is refused by name, as on the direct API', async () => {
  const { status, payload } = await postImages(GEN, { model: 'gpt-image-2', prompt: 'a dot', bogus_field: 1 });
  assert.equal(status, 400);
  assert.equal(payload.error.code, 'unknown_parameter');
  assert.equal(payload.error.param, 'bogus_field');
  assert.equal(payload.error.message, "Unknown parameter: 'bogus_field'.");
});

test('generations: x_proxy_image_route is the one key the direct API refuses that this proxy keeps', async () => {
  const { status } = await postImages(GEN, { model: 'gpt-image-2', prompt: 'a dot', x_proxy_image_route: { geometry_mode: 'strict' } });
  assert.equal(status, 200);
});

// Ordering, measured with two faults in one body: unknown keys before prompt,
// prompt before images, images before n, n before the enums.
test('generations: faults are reported in the direct order', async () => {
  const cases = [
    [{ prompt: 'a dot', bogus: 1, n: 0 }, 'bogus'],
    [{ prompt: '', n: 0 }, 'prompt'],
    [{ prompt: 'a dot', n: 0, quality: 'ultra' }, 'n'],
    [{ prompt: 'a dot', n: null, output_compression: 101 }, 'output_compression'],
  ];
  for (const [body, param] of cases) {
    const { payload } = await postImages(GEN, { model: 'gpt-image-2', ...body });
    assert.equal(payload.error.param, param, JSON.stringify(body));
  }
  const { payload } = await postImages('/v1/images/edits', { model: 'gpt-image-2', prompt: 'a dot', images: [], n: 0 });
  assert.equal(payload.error.param, 'images');
  assert.equal(payload.error.code, 'empty_array');
});

for (const [label, prompt, code, message] of [
  ['empty', '', 'empty_string', "Invalid 'prompt': empty string. Expected a string with minimum length 1, but got an empty string instead."],
  ['null', null, 'invalid_type', "Invalid type for 'prompt': expected a string, but got null instead."],
  ['an integer', 123, 'invalid_type', "Invalid type for 'prompt': expected a string, but got an integer instead."],
]) {
  test(`generations: prompt ${label} carries the direct envelope`, async () => {
    const { status, payload } = await postImages(GEN, { model: 'gpt-image-2', prompt });
    assert.equal(status, 400);
    assert.equal(payload.error.param, 'prompt');
    assert.equal(payload.error.code, code);
    assert.equal(payload.error.message, message);
  });
}

// JSON types the direct API names (measured 2026-08-30 on `model`): a
// decimal number is not "a number".
for (const [model, got] of [[1.5, 'a decimal number'], [true, 'a boolean'], [{}, 'an object'], [[], 'an array']]) {
  test(`generations: model ${JSON.stringify(model)} is a type error naming ${got}`, async () => {
    const { status, payload } = await postImages(GEN, { model, prompt: 'a dot' });
    assert.equal(status, 400);
    assert.equal(payload.error.code, 'invalid_type');
    assert.equal(payload.error.message, `Invalid type for 'model': expected a string, but got ${got} instead.`);
  });
}

test('generations: size that is not a string is a type error, not a bad size', async () => {
  const { status, payload } = await postImages(GEN, { model: 'gpt-image-2', prompt: 'a dot', size: 123 });
  assert.equal(status, 400);
  assert.equal(payload.error.code, 'invalid_type');
  assert.equal(payload.error.message, "Invalid type for 'size': expected a string, but got an integer instead.");
});

// Multipart, measured 2026-08-30 with a real form: the enum envelopes are the
// JSON ones (an empty field is a value outside the set), a non-digit integer
// field has its own wording, and the file field spelled the JSON way is
// pointed at the form spelling.
test('multipart edits: a non-digit integer field has the direct wording', async () => {
  for (const field of ['n', 'output_compression']) {
    const { status, payload } = await postForm('/v1/images/edits', { model: 'gpt-image-2', prompt: 'a dot', [field]: 'abc' });
    assert.equal(status, 400);
    assert.equal(payload.error.param, field);
    assert.equal(payload.error.message, `Invalid type for '${field}': expected an integer, but got a string value that could not be converted into an integer.`);
  }
});

test('multipart edits: an out-of-set or empty enum field is invalid_value, as in JSON', async () => {
  for (const quality of ['ultra', '']) {
    const { status, payload } = await postForm('/v1/images/edits', { model: 'gpt-image-2', prompt: 'a dot', quality });
    assert.equal(status, 400, quality);
    assert.equal(payload.error.code, 'invalid_value');
    assert.equal(payload.error.message, `Invalid value: '${quality}'. Supported values are: 'low', 'medium', 'high', and 'auto'.`);
  }
});

test('multipart edits: a file named images is pointed at image / image[]', async () => {
  const started = await startLocalApiProxy({
    backend: imageBackend(), imageGenerationClient: imageBackend(),
    host: '127.0.0.1', port: 0, requestTimeoutMs: 30_000,
  });
  try {
    const form = new FormData();
    form.set('model', 'gpt-image-2');
    form.set('prompt', 'a dot');
    form.set('images', new Blob([Buffer.from('iVBORw0KGgo=', 'base64')], { type: 'image/png' }), 'x.png');
    const res = await fetch(`${started.url}/v1/images/edits`, { method: 'POST', body: form });
    const payload = await res.json();
    assert.equal(res.status, 400);
    assert.equal(payload.error.param, 'images');
    assert.equal(payload.error.code, 'invalid_value');
    assert.equal(payload.error.message, "Unknown parameter: 'images'. For multipart/form-data use 'image' or 'image[]'.");
  } finally {
    await started.close();
  }
});

test('edits: images null is a type error, not omission', async () => {
  const { status, payload } = await postImages('/v1/images/edits', { model: 'gpt-image-2', prompt: 'a dot', images: null });
  assert.equal(status, 400);
  assert.equal(payload.error.code, 'invalid_type');
  assert.equal(payload.error.message, "Invalid type for 'images': expected an array of objects, but got null instead.");
});

test('generations: nullable fields treat null as omission, per the direct types', async () => {
  // `n`, `partial_images`, `output_compression` are declared nullable
  // (`Optional[...]`) on the direct API. The explicit-null rejections of
  // earlier rounds were anti-parity, measured against the published SDK
  // types, and are reversed. (`response_format` is not among them any more:
  // every live image model refuses the key, null included — measured.)
  const { status, payload } = await postImages(GEN, {
    model: 'gpt-image-2', prompt: 'a dot',
    n: null, partial_images: null, output_compression: null,
  });
  assert.equal(status, 200, JSON.stringify(payload));
  assert.equal(payload.data.length, 1, 'null n means the default of 1');
});

test('a numeric string n is accepted in multipart, where every field is a string', async () => {
  // In JSON a string `n` is a type error (measured); a form field can only be
  // a string, so there the digits are the integer they spell.
  const { status } = await postForm('/v1/images/edits', { model: 'gpt-image-2', prompt: 'a dot', n: '2' });
  assert.equal(status, 200);
});

test('a multipart body with a key the direct API does not know is refused too', async () => {
  const { status, payload } = await postForm('/v1/images/edits', { model: 'gpt-image-2', prompt: 'a dot', style: 'vivid' });
  assert.equal(status, 400);
  assert.equal(payload.error.code, 'unknown_parameter');
});

test('generations: the n boundaries are accepted', async () => {
  for (const n of [1, 10]) {
    const { status } = await postImages(GEN, { model: 'gpt-image-2', prompt: 'a dot', n });
    assert.equal(status, 200, `n=${n} is inside the documented domain`);
  }
});

test('generations: a prompt is required', async () => {
  const { status } = await postImages(GEN, { model: 'gpt-image-2' });
  assert.equal(status, 400);
});

for (const [label, prompt] of [['empty', ''], ['non-string', 42]]) {
  test(`generations: a ${label} prompt is rejected`, async () => {
    const { status } = await postImages(GEN, { model: 'gpt-image-2', prompt });
    assert.equal(status, 400);
  });
}

test('generations: a whitespace-only prompt is accepted, as the direct API accepts it', async () => {
  // Measured 2026-08-30: `"   "` generated. Blank-detection is not the direct
  // API's rule for this field; only the empty string is refused.
  const { status } = await postImages(GEN, { model: 'gpt-image-2', prompt: '   ' });
  assert.equal(status, 200);
});

test('edits: an image input is required', async () => {
  const { status, payload } = await postImages('/v1/images/edits', { model: 'gpt-image-2', prompt: 'a dot' });
  assert.equal(status, 400);
  assert.equal(payload.error.code, 'missing_required_parameter');
  assert.equal(payload.error.param, 'images');
});

// Documented model-specific exceptions. Each is a single guard; none was pinned.
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

// Measured on gpt-image-2 generations, 2026-08-29: the direct API does not
// know `input_fidelity` there at all — by key, whatever the value, and it says
// so before it looks at `n`. The enum parser used to run first, so null was a
// 200 that generated, and an out-of-enum value was a generic 400.
for (const [label, extra] of [
  ['high', { input_fidelity: 'high' }],
  ['null', { input_fidelity: null }],
  ['out of the enum', { input_fidelity: 'bogus' }],
  ['high, with n: 0 on the same body', { input_fidelity: 'high', n: 0 }],
]) {
  test(`generations: input_fidelity ${label} is an unknown parameter`, async () => {
    const { status, payload } = await postImages(GEN, { model: 'gpt-image-1', prompt: 'a dot', ...extra });
    assert.equal(status, 400, JSON.stringify(payload));
    assert.equal(payload.error.code, 'unknown_parameter');
    assert.equal(payload.error.param, 'input_fidelity');
  });
}

test('edits: input_fidelity null is omission there, and the request runs', async () => {
  const { status } = await postImages('/v1/images/edits', {
    model: 'gpt-image-1', prompt: 'a dot', images: [{ image_url: PNG_DATA_URL }], input_fidelity: null,
  });
  assert.equal(status, 200);
});

test('generations: style is an unknown parameter on every image model the direct API serves', async () => {
  // `style` was a dall-e-3 control; dall-e-3 is gone (2026-08-29) and gpt-image-2
  // answers "Unknown parameter: 'style'."
  const { status, payload } = await postImages(GEN, { model: 'gpt-image-2', prompt: 'a dot', style: 'vivid' });
  assert.equal(status, 400);
  assert.equal(payload.error.param, 'style');
  assert.equal(payload.error.code, 'unknown_parameter');
});

// Usage is part of the documented output spec and nothing asserted it.
test('generations: a backend that reports usage has it in the response', async () => {
  const { status, payload } = await postImages(GEN, { model: 'gpt-image-2', prompt: 'a dot' });
  assert.equal(status, 200);
  assert.ok(payload.usage, `expected usage in the response: ${JSON.stringify(payload)}`);
  assert.equal(payload.usage.input_tokens, 3);
  assert.equal(payload.usage.output_tokens, 4);
});

// The URL the proxy hands back is a client-visible resource with a lifecycle
// that was undocumented and untested.
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

test('edits: style is rejected there too, as the same unknown parameter', async () => {
  const { status, payload } = await postForm('/v1/images/edits', { model: 'gpt-image-1', prompt: 'a dot', style: 'vivid' });
  assert.equal(status, 400, JSON.stringify(payload));
  assert.equal(payload.error.code, 'unknown_parameter');
});

test('edits: n is validated there too', async () => {
  const { status } = await postForm('/v1/images/edits', { model: 'gpt-image-2', prompt: 'a dot', n: '11' });
  assert.equal(status, 400);
});

// The URL store's two promises — unguessable ids and expiry — were pinned by
// neither. A constant id and an infinite TTL both passed.
// The store's two remaining promises — entries expire, and the store does not
// grow without limit — were pinned by nothing. An infinite TTL and an unbounded
// map both passed every test above.
// The guards below are shared across operations but were only ever exercised on
// one of them, so an operation check added to any of them would go unnoticed.
// The URL the proxy hands back has to be one the client can actually follow.
// `fetch` will not send a hostile or absent Host, so these go through node:http.
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

test('edits: an empty multipart upload is rejected, like every other empty image input', async () => {
  // The JSON encodings all reject an empty image; the multipart path accepted
  // one and sent `data:image/png;base64,` upstream as though it were a picture.
  const form = new FormData();
  form.set('model', 'gpt-image-2');
  form.set('prompt', 'make it blue');
  form.set('image', new Blob([], { type: 'image/png' }), 'empty.png');
  const { status } = await postWith(streamingImageBackend(), '/v1/images/edits', { method: 'POST', body: form });
  assert.equal(status, 400);
});

test('edits: a multipart part that is not an image is rejected', async () => {
  const form = new FormData();
  form.set('model', 'gpt-image-2');
  form.set('prompt', 'make it blue');
  form.set('image', new Blob([Buffer.from('hello world')], { type: 'text/plain' }), 'notes.txt');
  const { status } = await postWith(streamingImageBackend(), '/v1/images/edits', { method: 'POST', body: form });
  assert.equal(status, 400);
});

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
        model: 'gpt-image-2', prompt: 'a dot', partial_images: 0, ...(stream ? { stream: true } : {}),
      }),
    });
    assert.equal(status, 200);
  });
}

for (const [path, fields, event] of [
  ['/v1/images/edits', { model: 'gpt-image-1', prompt: 'a dot', stream: 'true' }, 'image_edit.completed'],
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
    body: JSON.stringify({ model: 'gpt-image-2', prompt: 'a dot', stream: true }),
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
      body: JSON.stringify({ model: 'gpt-image-2', prompt: 'a dot', stream: true }),
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
      body: JSON.stringify({ model: 'gpt-image-2', prompt: 'a dot' }),
    },
  );
  assert.equal(status, 200);
  const usage = JSON.parse(text).usage;
  assert.equal(usage.input_tokens, 11);
  assert.equal(usage.output_tokens, 22);
  assert.equal(usage.total_tokens, 33);
});

test('generations: partial_images null is omission — the field is nullable', async () => {
  const { status } = await postImages(GEN, { model: 'gpt-image-2', prompt: 'a dot', partial_images: null });
  assert.equal(status, 200);
});

// --- round 40 ---

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
        model: 'gpt-image-2', prompt: 'a dot', output_format: 'jpeg', output_compression: 80,
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
  // terminal frame. The failure comes AFTER a first event: that is what makes
  // the stream committed — a failure before any event is an HTTP error (below).
  const backend = {
    name: 'test', model: 'configured-model',
    async generate() { return { created: 0, images: [{ b64Json: 'iVBORw0KGgo=', revisedPrompt: null }] }; },
    async *stream() {
      yield { type: 'partial_image', created: 0, image: { b64Json: 'iVBORw0KGgo=' }, partialImageIndex: 0 };
      throw new Error('backend exploded');
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
      body: JSON.stringify({ model: 'gpt-image-2', prompt: 'x', stream: true }),
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

// The backend refuses a request it will not run — an option its image model
// does not support — before any stream byte. That refusal is an HTTP error to
// the client, streamed or not: the SSE stream commits on the first backend
// event, not before it. Until this, `gpt-image-1` + `background: transparent`
// with `stream: true` was a 200 carrying an error frame while the identical
// envelope for `image-2` (a local guard) was a 400.
test('a backend refusal before the first event is an HTTP error on the streamed path too', async () => {
  const { ProxyRequestError } = await import('../dist/proxy/types.js');
  const backend = {
    name: 'test', model: 'configured-model',
    async generate() { throw new Error('unused'); },
    async *stream() {
      // The envelope the live backend returned for `background: transparent`
      // (artifacts/codex-backend-image-probe, `slot_background`), as the
      // codex-backend transport forwards it.
      throw new ProxyRequestError(
        'Transparent background is not supported for this model.', 400, 'openai',
        'image_generation_user_error', 'tools', 'invalid_value',
      );
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
      body: JSON.stringify({ model: 'gpt-image-1', prompt: 'x', background: 'transparent', stream: true }),
    });
    assert.equal(res.status, 400, 'nothing was on the wire, so the refusal is the status');
    assert.match(res.headers.get('content-type'), /application\/json/);
    const payload = await res.json();
    assert.equal(payload.error.type, 'image_generation_user_error');
    assert.equal(payload.error.param, 'tools');
    assert.equal(payload.error.code, 'invalid_value');
  } finally {
    await started.close();
  }
});

test('a stream that ends with no event at all is still a committed, empty stream', async () => {
  const backend = {
    name: 'test', model: 'configured-model',
    async generate() { throw new Error('unused'); },
    async *stream() {},
    async close() {},
  };
  const started = await startLocalApiProxy({
    backend, imageGenerationClient: backend,
    host: '127.0.0.1', port: 0, requestTimeoutMs: 30_000,
  });
  try {
    const res = await fetch(`${started.url}${GEN}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-image-2', prompt: 'x', stream: true }),
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/event-stream/);
    assert.equal(await res.text(), '');
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
        model: 'gpt-image-2', prompt: 'a dot', output_format: 'jpeg',
        x_proxy_image_route: { output_compression: 20 },
      }),
    });
    assert.equal(res.status, 200);
    assert.equal(seen, 20, 'with the standard field omitted, the route hint applies');
  } finally {
    await started.close();
  }
});

// --- round 42 ---

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
      body: JSON.stringify({ model: 'gpt-image-2', prompt: 'x', stream: true }),
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
    const { status } = await postImages(GEN, { model: 'gpt-image-2', prompt: 'a dot', response_format: value });
    assert.equal(status, 400, `response_format=${JSON.stringify(value)} is not b64_json or url`);
  });
}

test('generations: an empty-string enum value is a present wrong value, not omission', async () => {
  const { status } = await postImages(GEN, { model: 'gpt-image-2', prompt: 'a dot', quality: '' });
  assert.equal(status, 400, 'an empty string is outside the quality enum');
});

test('edits: a malformed member of an image array is rejected, not dropped', async () => {
  // Filtering the bad member executed the request with silently altered input.
  const { status, payload } = await postImages('/v1/images/edits', {
    model: 'gpt-image-2', prompt: 'make it blue',
    images: [{ image_url: PNG_DATA_URL }, 7],
  });
  assert.equal(status, 400, JSON.stringify(payload));
  assert.equal(payload.error.param, 'images[1]', 'the rejection must name the member');
  assert.equal(payload.error.code, 'invalid_type');
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
      body: JSON.stringify({ model: 'gpt-image-2', prompt: 'a dot' }),
    });
    assert.equal(res.status, 200, await res.text());
  } finally {
    await started.close();
  }
});

const PNG_DATA_URL = `data:image/png;base64,${Buffer.from('89504e470d0a1a0a', 'hex').toString('base64')}`;
// A JSON edit names its images as `images`, an array of objects, and nothing
// else — measured on the direct API 2026-08-29. `image` and `image[]` are the
// multipart spellings; in JSON they are refused with a message that says so.
test('edits: a JSON body names its images as the images array', async () => {
  const { status, payload } = await postImages('/v1/images/edits', {
    model: 'gpt-image-2', prompt: 'make it blue', images: [{ image_url: PNG_DATA_URL }],
  });
  assert.equal(status, 200, JSON.stringify(payload));
});

for (const alias of ['image', 'image[]']) {
  test(`edits: the JSON spelling ${alias} is refused with the direct message`, async () => {
    const { status, payload } = await postImages('/v1/images/edits', {
      model: 'gpt-image-2', prompt: 'make it blue', [alias]: [{ image_url: PNG_DATA_URL }],
    });
    assert.equal(status, 400);
    assert.equal(payload.error.param, alias);
    assert.equal(payload.error.code, 'invalid_value');
    assert.match(payload.error.message, /use 'images' \(array\)/);
  });
}

test('edits: images that is not an array names the JSON type it got', async () => {
  const { status, payload } = await postImages('/v1/images/edits', {
    model: 'gpt-image-2', prompt: 'make it blue', images: { image_url: PNG_DATA_URL },
  });
  assert.equal(status, 400);
  assert.equal(payload.error.code, 'invalid_type');
  assert.equal(payload.error.message, "Invalid type for 'images': expected an array of objects, but got an object instead.");
});

test('edits: a string member of images is a type error, not a URL reference', async () => {
  const { status, payload } = await postImages('/v1/images/edits', {
    model: 'gpt-image-2', prompt: 'make it blue', images: ['https://example.com/x.png'],
  });
  assert.equal(status, 400);
  assert.equal(payload.error.param, 'images[0]');
  assert.equal(payload.error.message, "Invalid type for 'images[0]': expected an object, but got a string instead.");
});

test('generations: the 32,000-code-unit prompt boundary is inclusive', async () => {
  const at = await postImages(GEN, { model: 'gpt-image-2', prompt: 'x'.repeat(32_000) });
  assert.equal(at.status, 200, 'exactly 32,000 units is inside the bound');
  const over = await postImages(GEN, { model: 'gpt-image-2', prompt: 'x'.repeat(32_001) });
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
      body: JSON.stringify({ model: 'gpt-image-2', prompt: 'a dot' }), signal: controller.signal,
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

// --- round 45 ---

test('response_format is an unknown parameter on every live image model, null included', async () => {
  // Measured 2026-08-29 on gpt-image-2: a present null is "Unknown parameter",
  // not omission. The earlier "null is omission" reading was of the dall-e
  // era, and dall-e is gone.
  for (const response_format of ['url', 'b64_json', null]) {
    const { status, payload } = await postImages(GEN, { model: 'gpt-image-1', prompt: 'a dot', response_format });
    assert.equal(status, 400, `response_format ${JSON.stringify(response_format)}`);
    assert.equal(payload.error.code, 'unknown_parameter');
    assert.equal(payload.error.param, 'response_format');
  }
});

for (const path of [GEN, '/v1/images/edits']) {
  test(`${path}: an empty-string output_compression is a present wrong value`, async () => {
    const body = path === GEN
      ? { model: 'gpt-image-2', prompt: 'a dot', output_compression: '' }
      : { model: 'gpt-image-2', prompt: 'a dot', images: [{ image_url: PNG_DATA_URL }], output_compression: '' };
    const { status } = await postImages(path, body);
    assert.equal(status, 400, 'an empty string is not an integer');
  });
}

test('edits: a malformed mask is rejected, not silently dropped', async () => {
  // Executing an unmasked edit the client never asked for is a semantic
  // alteration, not a convenience.
  const { status, payload } = await postImages('/v1/images/edits', {
    model: 'gpt-image-2', prompt: 'make it blue', images: [{ image_url: PNG_DATA_URL }], mask: 42,
  });
  assert.equal(status, 400, JSON.stringify(payload));
  assert.match(payload.error.message, /mask/);
});

test('edits: mask null is omission — the unmasked edit was asked for', async () => {
  const { status } = await postImages('/v1/images/edits', {
    model: 'gpt-image-2', prompt: 'make it blue', images: [{ image_url: PNG_DATA_URL }], mask: null,
  });
  assert.equal(status, 200);
});

for (const [label, model] of [['a number', 7], ['an empty string', ''], ['whitespace', '  ']]) {
  test(`generations: model ${label} is rejected, never rewritten to a default`, async () => {
    const { status, payload } = await postImages(GEN, { model, prompt: 'a dot' });
    assert.equal(status, 400, `model=${JSON.stringify(model)} must not select a different model`);
    assert.equal(payload.error.param, 'model');
  });
}

// `model` is required on the direct API (2026-08-29): absent is
// `missing_required_parameter`, null and a number are `invalid_type` with the
// JSON type named, and any name it does not serve — the dead `dall-e-2`, the
// proxy's former `image-2`, an empty string — "does not exist". The proxy used
// to default an absent model to dall-e-2.
test('generations: an absent model is a missing required parameter', async () => {
  const { status, payload } = await postImages(GEN, { prompt: 'a dot' });
  assert.equal(status, 400);
  assert.equal(payload.error.code, 'missing_required_parameter');
  assert.equal(payload.error.param, 'model');
  assert.equal(payload.error.message, "Missing required parameter: 'model'.");
});

test('generations: model null is a type error, not omission', async () => {
  const { status, payload } = await postImages(GEN, { model: null, prompt: 'a dot' });
  assert.equal(status, 400);
  assert.equal(payload.error.code, 'invalid_type');
  assert.equal(payload.error.message, "Invalid type for 'model': expected a string, but got null instead.");
});

for (const model of ['dall-e-2', 'dall-e-3', 'image-2', '', 'gpt-image-9']) {
  test(`generations: model ${JSON.stringify(model)} does not exist, in the direct envelope`, async () => {
    const { status, payload } = await postImages(GEN, { model, prompt: 'a dot' });
    assert.equal(status, 400);
    assert.equal(payload.error.type, 'image_generation_user_error');
    assert.equal(payload.error.param, 'model');
    assert.equal(payload.error.code, 'invalid_value');
    assert.equal(payload.error.message, `The model '${model}' does not exist.`);
  });
}

for (const model of ['chatgpt-image-latest', 'gpt-image-1', 'gpt-image-1-mini', 'gpt-image-1.5', 'gpt-image-2', 'gpt-image-2-2026-04-21']) {
  test(`generations: ${model} is a live direct model and runs on the local route`, async () => {
    const { status } = await postImages(GEN, { model, prompt: 'a dot' });
    assert.equal(status, 200);
  });
}

test('the variations endpoint is gone, as it is on the direct API — a bare 404', async () => {
  const started = await startLocalApiProxy({
    backend: imageBackend(), imageGenerationClient: imageBackend(),
    host: '127.0.0.1', port: 0, requestTimeoutMs: 30_000,
  });
  try {
    const res = await fetch(`${started.url}/v1/images/variations`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'gpt-image-2' }),
    });
    assert.equal(res.status, 404);
    assert.equal(await res.text(), '', 'no body, as measured on the direct API');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  } finally {
    await started.close();
  }
});

test('multipart works with an uppercase media-type essence', async () => {
  const started = await startLocalApiProxy({
    backend: imageBackend(), imageGenerationClient: imageBackend(),
    host: '127.0.0.1', port: 0, requestTimeoutMs: 30_000,
  });
  const target = new URL(started.url);
  try {
    const boundary = 'testboundary123';
    const body = [
      `--${boundary}`, 'Content-Disposition: form-data; name="model"', '', 'gpt-image-2',
      `--${boundary}`, 'Content-Disposition: form-data; name="prompt"', '', 'a dot',
      `--${boundary}--`, '',
    ].join('\r\n');
    const raw = await new Promise((resolve, reject) => {
      const conn = net.connect(Number(target.port), target.hostname, () => {
        conn.write(
          `POST /v1/images/generations HTTP/1.1\r\nHost: h\r\n`
          + `Content-Type: MULTIPART/FORM-DATA; boundary=${boundary}\r\n`
          + `Content-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
        );
      });
      let data = '';
      conn.on('data', (chunk) => { data += chunk; });
      conn.on('end', () => resolve(data));
      conn.on('error', reject);
    });
    assert.match(raw.split('\r\n')[0], /200/, raw.slice(0, 200));
  } finally {
    await started.close();
  }
});

// --- round 46 ---

test('generations: mask and images are unknown parameters, as on the direct API', async () => {
  // Measured 2026-08-30: a generation body carrying either key is refused by
  // name; the earlier contract said they were ignored.
  for (const key of ['mask', 'images']) {
    const { status, payload } = await postImages(GEN, { model: 'gpt-image-2', prompt: 'a dot', [key]: 42 });
    assert.equal(status, 400);
    assert.equal(payload.error.code, 'unknown_parameter');
    assert.equal(payload.error.param, key);
  }
});

test('edits: a malformed array member keeps its index even when the parser throws', async () => {
  const { status, payload } = await postImages('/v1/images/edits', {
    model: 'gpt-image-2', prompt: 'edit', images: [
      { image_url: PNG_DATA_URL },
      { image_url: PNG_DATA_URL, file_id: 'also-this' },
    ],
  });
  assert.equal(status, 400);
  assert.match(payload.error.message, /image\[1\]/, JSON.stringify(payload.error));
});

test('a non-streaming response also caps at n images', async () => {
  const backend = {
    name: 'test', model: 'configured-model',
    async generate() {
      return {
        created: 0,
        images: Array.from({ length: 5 }, () => ({ b64Json: 'iVBORw0KGgo=', revisedPrompt: null })),
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
      body: JSON.stringify({ model: 'gpt-image-2', prompt: 'a dot', n: 2 }),
    });
    const data = (await res.json()).data;
    assert.equal(data.length, 2, 'the response must not exceed the requested n');
  } finally {
    await started.close();
  }
});

// The operation matrices the panel kept asking for: the rules hold on edits,
// not only generations.
const EDIT_BASE = { model: 'gpt-image-2', prompt: 'edit', images: [{ image_url: PNG_DATA_URL }] };

test('edits: nullable leaves treat null as omission there too', async () => {
  const { status, payload } = await postImages('/v1/images/edits', {
    ...EDIT_BASE, n: null, output_compression: null, partial_images: null,
  });
  assert.equal(status, 200, JSON.stringify(payload));
});

test('edits: an absent model is missing there too', async () => {
  const { status, payload } = await postImages('/v1/images/edits', {
    prompt: 'edit', images: [{ image_url: PNG_DATA_URL }],
  });
  assert.equal(status, 400);
  assert.equal(payload.error.code, 'missing_required_parameter');
  assert.equal(payload.error.param, 'model');
});

test('edits: an empty-string enum is rejected there too', async () => {
  const { status } = await postImages('/v1/images/edits', { ...EDIT_BASE, quality: '' });
  assert.equal(status, 400);
});

test('edits: the misleading multipart parameter is JSON there too', async () => {
  const { 0: status } = [(await (async () => {
    const started = await startLocalApiProxy({
      backend: imageBackend(), imageGenerationClient: imageBackend(),
      host: '127.0.0.1', port: 0, requestTimeoutMs: 30_000,
    });
    try {
      const res = await fetch(`${started.url}/v1/images/edits`, {
        method: 'POST',
        headers: { 'content-type': 'application/json; profile="x/multipart/form-data"' },
        body: JSON.stringify(EDIT_BASE),
      });
      return res.status;
    } finally {
      await started.close();
    }
  })())];
  assert.equal(status, 200);
});

// --- round 47 ---

test('boundary bytes inside multipart data are data, not delimiters', async () => {
  // RFC 2046: a boundary delimits only at the start of a line. Global
  // splitting truncated any field — or uploaded file — whose BYTES contained
  // the marker, silently altering client input.
  const started = await startLocalApiProxy({
    backend: imageBackend(), imageGenerationClient: imageBackend(),
    host: '127.0.0.1', port: 0, requestTimeoutMs: 30_000,
  });
  const target = new URL(started.url);
  const B = 'AaB03x';
  const send = (bodyLines) => new Promise((resolve, reject) => {
    const body = bodyLines.join('\r\n');
    const conn = net.connect(Number(target.port), target.hostname, () => conn.write(
      `POST /v1/images/generations HTTP/1.1\r\nHost: h\r\n`
      + `Content-Type: multipart/form-data; boundary=${B}\r\n`
      + `Content-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
    ));
    let data = '';
    conn.on('data', (chunk) => { data += chunk; });
    conn.on('end', () => resolve(data));
    conn.on('error', reject);
  });
  try {
    const truncatable = await send([
      `--${B}`, 'Content-Disposition: form-data; name="model"', '', 'gpt-image-2',
      `--${B}`, 'Content-Disposition: form-data; name="prompt"', '', 'a dot',
      `--${B}`, 'Content-Disposition: form-data; name="output_format"', '', `jpeg--${B}junk`,
      `--${B}--`, '',
    ]);
    assert.match(truncatable.split('\r\n')[0], /400/,
      'the whole value, marker bytes included, must reach the enum check');

    const control = await send([
      `--${B}`, 'Content-Disposition: form-data; name="model"', '', 'gpt-image-2',
      `--${B}`, 'Content-Disposition: form-data; name="prompt"', '', `a dot with --${B} inside`,
      `--${B}--`, '',
    ]);
    assert.match(control.split('\r\n')[0], /200/,
      'marker bytes inside an otherwise valid field are just data');
  } finally {
    await started.close();
  }
});

// --- round 48 ---

test('a line-starting boundary PREFIX is data: only a terminated delimiter splits', async () => {
  // `--BX` where the boundary is `B` delimits nothing — X is not the optional
  // whitespace, CRLF, or `--` the RFC requires after the token.
  const started = await startLocalApiProxy({
    backend: imageBackend(), imageGenerationClient: imageBackend(),
    host: '127.0.0.1', port: 0, requestTimeoutMs: 30_000,
  });
  const target = new URL(started.url);
  try {
    const B = 'B';
    const body = [
      `--${B}`, 'Content-Disposition: form-data; name="model"', '', 'gpt-image-2',
      `--${B}`, 'Content-Disposition: form-data; name="prompt"', '', `--${B}X\r\ndraw a cat`,
      `--${B}--`, '',
    ].join('\r\n');
    const raw = await new Promise((resolve, reject) => {
      const conn = net.connect(Number(target.port), target.hostname, () => conn.write(
        `POST /v1/images/generations HTTP/1.1\r\nHost: h\r\n`
        + `Content-Type: multipart/form-data; boundary=${B}\r\n`
        + `Content-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
      ));
      let data = '';
      conn.on('data', (chunk) => { data += chunk; });
      conn.on('end', () => resolve(data));
      conn.on('error', reject);
    });
    assert.match(raw.split('\r\n')[0], /200/, `the prompt must survive its prefix bytes: ${raw.slice(0, 200)}`);
  } finally {
    await started.close();
  }
});

test('a case-variant data-URL media type is still an image', async () => {
  const upper = PNG_DATA_URL.replace('data:image/png', 'data:IMAGE/PNG');
  const { status, payload } = await postImages('/v1/images/edits', {
    model: 'gpt-image-2', prompt: 'repair', images: [{ image_url: upper }],
  });
  assert.equal(status, 200, JSON.stringify(payload));
});

test('case-variant disposition parameter names still name the part', async () => {
  const started = await startLocalApiProxy({
    backend: imageBackend(), imageGenerationClient: imageBackend(),
    host: '127.0.0.1', port: 0, requestTimeoutMs: 30_000,
  });
  const target = new URL(started.url);
  try {
    const B = 'AaB03x';
    const png = Buffer.from('iVBORw0KGgo=', 'base64').toString('latin1');
    const body = [
      `--${B}`, 'Content-Disposition: form-data; NAME="model"', '', 'gpt-image-2',
      `--${B}`, 'Content-Disposition: form-data; NAME="prompt"', '', 'a dot',
      `--${B}`, `Content-Disposition: form-data; NAME="image"; FILENAME="x.png"`, 'Content-Type: image/png', '', png,
      `--${B}--`, '',
    ].join('\r\n');
    const raw = await new Promise((resolve, reject) => {
      // latin1 Buffer, not a string write: the PNG magic's \x89 would become
      // two UTF-8 bytes and overrun the latin1-counted Content-Length.
      const conn = net.connect(Number(target.port), target.hostname, () => conn.write(Buffer.from(
        `POST /v1/images/edits HTTP/1.1\r\nHost: h\r\n`
        + `Content-Type: multipart/form-data; boundary=${B}\r\n`
        + `Content-Length: ${Buffer.byteLength(body, 'latin1')}\r\nConnection: close\r\n\r\n${body}`,
        'latin1',
      )));
      let data = '';
      conn.on('data', (chunk) => { data += chunk; });
      conn.on('end', () => resolve(data));
      conn.on('error', reject);
    });
    assert.match(raw.split('\r\n')[0], /200/, raw.slice(0, 200));
  } finally {
    await started.close();
  }
});

// --- round 49 ---

test('a close-delimiter PREFIX is data too: later parts survive it', async () => {
  // `--B--X` closes nothing: the close is `--` then optional whitespace then
  // CRLF or end of body. The bare startsWith check discarded every part after
  // such bytes — a prompt or an uploaded PNG containing them lost its siblings.
  const started = await startLocalApiProxy({
    backend: imageBackend(), imageGenerationClient: imageBackend(),
    host: '127.0.0.1', port: 0, requestTimeoutMs: 30_000,
  });
  const target = new URL(started.url);
  try {
    const B = 'B';
    // The REQUIRED part comes after the fake close: dropping it must change
    // the status. (A dropped `model` part merely falls back to the default —
    // the first version of this test passed against the broken close check.)
    const body = [
      // A known field (`user` is free text) carries the fake close: an unknown
      // part name is itself a 400 now, which would mask what this test pins.
      `--${B}`, 'Content-Disposition: form-data; name="user"', '', `before\r\n--${B}--X\r\nafter`,
      `--${B}`, 'Content-Disposition: form-data; name="model"', '', 'gpt-image-2',
      `--${B}`, 'Content-Disposition: form-data; name="prompt"', '', 'a dot',
      `--${B}--`, 'epilogue',
    ].join('\r\n');
    const raw = await new Promise((resolve, reject) => {
      const conn = net.connect(Number(target.port), target.hostname, () => conn.write(
        `POST /v1/images/generations HTTP/1.1\r\nHost: h\r\n`
        + `Content-Type: multipart/form-data; boundary=${B}\r\n`
        + `Content-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
      ));
      let data = '';
      conn.on('data', (chunk) => { data += chunk; });
      conn.on('end', () => resolve(data));
      conn.on('error', reject);
    });
    assert.match(raw.split('\r\n')[0], /200/, `the prompt after the fake close must survive: ${raw.slice(0, 200)}`);
  } finally {
    await started.close();
  }
});

// --- round 50 ---

async function rawMultipart(bodyLines, paramTail, path = '/v1/images/generations') {
  const started = await startLocalApiProxy({
    backend: imageBackend(), imageGenerationClient: imageBackend(),
    host: '127.0.0.1', port: 0, requestTimeoutMs: 30_000,
  });
  const target = new URL(started.url);
  try {
    const body = bodyLines.join('\r\n');
    return await new Promise((resolve, reject) => {
      const conn = net.connect(Number(target.port), target.hostname, () => conn.write(Buffer.from(
        `POST ${path} HTTP/1.1\r\nHost: h\r\n`
        + `Content-Type: multipart/form-data; ${paramTail}\r\n`
        + `Content-Length: ${Buffer.byteLength(body, 'latin1')}\r\nConnection: close\r\n\r\n${body}`,
        'latin1',
      )));
      let data = '';
      conn.on('data', (chunk) => { data += chunk; });
      conn.on('end', () => resolve(data.split('\r\n')[0]));
      conn.on('error', reject);
    });
  } finally {
    await started.close();
  }
}

test('a folded Content-Disposition header still names its part', async () => {
  // RFC 822 folding: CRLF + SP/HTAB continues the field. The continuation was
  // dropped for having no colon, taking the disposition's `name` with it.
  const png = Buffer.from('iVBORw0KGgo=', 'base64').toString('latin1');
  const status = await rawMultipart([
    '--AaB03x', 'Content-Disposition: form-data;', ' name="model"', '', 'gpt-image-2', '--AaB03x', 'Content-Disposition: form-data; name=\"prompt\"', '', 'a dot',
    '--AaB03x', 'Content-Disposition: form-data;', '\tname="image"; filename="x.png"', 'Content-Type: image/png', '', png,
    '--AaB03x--', '',
  ], 'boundary=AaB03x', '/v1/images/edits');
  assert.match(status, /200/, status);
});

test('boundary grammar is enforced: empty and trailing-space boundaries are 400', async () => {
  const empty = await rawMultipart([
    '--""', 'Content-Disposition: form-data; name="prompt"', '', 'a dot', '--""--', '',
  ], 'boundary=""');
  assert.match(empty, /400/, `an empty boundary is not a boundary: ${empty}`);

  const trailing = await rawMultipart([
    '--B ', 'Content-Disposition: form-data; name="prompt"', '', 'a dot', '--B --', '',
  ], 'boundary="B "');
  assert.match(trailing, /400/, `a boundary may not end in a space: ${trailing}`);
});

test('a quoted boundary parameter is accepted', async () => {
  const status = await rawMultipart([
    '--AaB03x', 'Content-Disposition: form-data; name="model"', '', 'gpt-image-2',
    '--AaB03x', 'Content-Disposition: form-data; name="prompt"', '', 'a dot',
    '--AaB03x--', '',
  ], 'boundary="AaB03x"');
  assert.match(status, /200/, status);
});

// --- round 51 ---

test('a decoy boundary inside another quoted parameter is text', async () => {
  const started = await startLocalApiProxy({
    backend: imageBackend(), imageGenerationClient: imageBackend(),
    host: '127.0.0.1', port: 0, requestTimeoutMs: 30_000,
  });
  const target = new URL(started.url);
  try {
    const body = [
      '--real', 'Content-Disposition: form-data; name="model"', '', 'gpt-image-2',
      '--real', 'Content-Disposition: form-data; name="prompt"', '', 'a dot',
      '--real--', '',
    ].join('\r\n');
    const raw = await new Promise((resolve, reject) => {
      const conn = net.connect(Number(target.port), target.hostname, () => conn.write(Buffer.from(
        `POST /v1/images/generations HTTP/1.1\r\nHost: h\r\n`
        + `Content-Type: multipart/form-data; note="x;boundary=decoy"; boundary=real\r\n`
        + `Content-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
      )));
      let data = '';
      conn.on('data', (chunk) => { data += chunk; });
      conn.on('end', () => resolve(data.split('\r\n')[0]));
      conn.on('error', reject);
    });
    assert.match(raw, /200/, `the parameter NAMED boundary must win: ${raw}`);
  } finally {
    await started.close();
  }
});

test('a quoted boundary with a trailing suffix is malformed, not truncated', async () => {
  const status = await rawMultipart([
    '--B', 'Content-Disposition: form-data; name="model"', '', 'gpt-image-2',
    '--B', 'Content-Disposition: form-data; name="prompt"', '', 'a dot',
    '--B--', '',
  ], 'boundary="B"junk');
  assert.match(status, /400/, `"B"junk is not a boundary parameter: ${status}`);
});

// --- round 52 ---

test('an empty header block does not read the content as headers', async () => {
  // `--B\r\n\r\n<content>` has NO headers; the parser searched for CRLFCRLF
  // from the top and promoted content lines to headers, conjuring a
  // disposition the part never had.
  const png = Buffer.from('iVBORw0KGgo=', 'base64').toString('latin1');
  const status = await rawMultipart([
    '--B', '', 'Content-Disposition: form-data; name="image"; filename="x.png"', 'Content-Type: image/png', '', png,
    '--B', 'Content-Disposition: form-data; name="model"', '', 'gpt-image-2', '--B', 'Content-Disposition: form-data; name=\"prompt\"', '', 'a dot',
    '--B--', '',
  ], 'boundary=B', '/v1/images/edits');
  assert.match(status, /400/, `a headerless part names nothing — the image is missing: ${status}`);
});

test('an escaped quote inside another parameter does not derail the boundary walk', async () => {
  const status = await rawMultipart([
    '--B', 'Content-Disposition: form-data; name="model"', '', 'gpt-image-2',
    '--B', 'Content-Disposition: form-data; name="prompt"', '', 'a dot',
    '--B--', '',
  ], 'note="x\\";boundary=decoy"; boundary=B', '/v1/images/generations');
  assert.match(status, /200/, `the quoted-pair keeps the decoy quoted: ${status}`);
});

test('a quoted-pair in the boundary value decodes', async () => {
  const status = await rawMultipart([
    '--B?', 'Content-Disposition: form-data; name="model"', '', 'gpt-image-2',
    '--B?', 'Content-Disposition: form-data; name="prompt"', '', 'a dot',
    '--B?--', '',
  ], 'boundary="B\\?"', '/v1/images/generations');
  assert.match(status, /200/, `"B\\?" names B?: ${status}`);
});

test('a non-OWS byte beside the boundary value is not trimmed away', async () => {
  // U+00A0 under latin1 decoding is a real byte outside the boundary alphabet;
  // String.trim ate it and accepted the remainder.
  const started = await startLocalApiProxy({
    backend: imageBackend(), imageGenerationClient: imageBackend(),
    host: '127.0.0.1', port: 0, requestTimeoutMs: 30_000,
  });
  const target = new URL(started.url);
  try {
    const body = [
      '--B', 'Content-Disposition: form-data; name="model"', '', 'gpt-image-2',
      '--B', 'Content-Disposition: form-data; name="prompt"', '', 'a dot',
      '--B--', '',
    ].join('\r\n');
    const raw = await new Promise((resolve, reject) => {
      const conn = net.connect(Number(target.port), target.hostname, () => conn.write(Buffer.concat([
        Buffer.from('POST /v1/images/generations HTTP/1.1\r\nHost: h\r\nContent-Type: multipart/form-data; boundary=B'),
        Buffer.from([0xa0]),
        Buffer.from(`\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`),
      ])));
      let data = '';
      conn.on('data', (chunk) => { data += chunk; });
      conn.on('end', () => resolve(data.split('\r\n')[0]));
      conn.on('error', reject);
    });
    assert.match(raw, /400/, `B<0xA0> is outside the boundary grammar: ${raw}`);
  } finally {
    await started.close();
  }
});

// --- round 53 ---

test('a quoted-pair in a disposition parameter decodes', async () => {
  const png = Buffer.from('iVBORw0KGgo=', 'base64').toString('latin1');
  const status = await rawMultipart([
    '--B', 'Content-Disposition: form-data; name="model"', '', 'gpt-image-2', '--B', 'Content-Disposition: form-data; name=\"prompt\"', '', 'a dot',
    '--B', 'Content-Disposition: form-data; name="im\\age"; filename="x.png"', 'Content-Type: image/png', '', png,
    '--B--', '',
  ], 'boundary=B', '/v1/images/edits');
  assert.match(status, /200/, `name="im\\age" names image: ${status}`);
});

test('a non-OWS byte before the boundary parameter name is not trimmed away', async () => {
  const started = await startLocalApiProxy({
    backend: imageBackend(), imageGenerationClient: imageBackend(),
    host: '127.0.0.1', port: 0, requestTimeoutMs: 30_000,
  });
  const target = new URL(started.url);
  try {
    const body = [
      '--B', 'Content-Disposition: form-data; name="model"', '', 'gpt-image-2',
      '--B', 'Content-Disposition: form-data; name="prompt"', '', 'a dot',
      '--B--', '',
    ].join('\r\n');
    const raw = await new Promise((resolve, reject) => {
      const conn = net.connect(Number(target.port), target.hostname, () => conn.write(Buffer.concat([
        Buffer.from('POST /v1/images/generations HTTP/1.1\r\nHost: h\r\nContent-Type: multipart/form-data; '),
        Buffer.from([0xa0]),
        Buffer.from(`boundary=B\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`),
      ])));
      let data = '';
      conn.on('data', (chunk) => { data += chunk; });
      conn.on('end', () => resolve(data.split('\r\n')[0]));
      conn.on('error', reject);
    });
    assert.match(raw, /400/, `<0xA0>boundary is not the boundary parameter: ${raw}`);
  } finally {
    await started.close();
  }
});

// --- round 54 ---

test('a semicolon inside a quoted filename cannot overwrite the field name', async () => {
  const png = Buffer.from('iVBORw0KGgo=', 'base64').toString('latin1');
  const status = await rawMultipart([
    '--B', 'Content-Disposition: form-data; name="model"', '', 'gpt-image-2', '--B', 'Content-Disposition: form-data; name=\"prompt\"', '', 'a dot',
    '--B', 'Content-Disposition: form-data; name="image"; filename="x; name=bogus.png"', 'Content-Type: image/png', '', png,
    '--B--', '',
  ], 'boundary=B', '/v1/images/edits');
  assert.match(status, /200/, `the quoted semicolon is filename data: ${status}`);
});

test('a quoted filename cannot fabricate a name the part never had', async () => {
  const png = Buffer.from('iVBORw0KGgo=', 'base64').toString('latin1');
  const status = await rawMultipart([
    '--B', 'Content-Disposition: form-data; name="model"', '', 'gpt-image-2', '--B', 'Content-Disposition: form-data; name=\"prompt\"', '', 'a dot',
    '--B', 'Content-Disposition: form-data; filename="x; name=image; z"', 'Content-Type: image/png', '', png,
    '--B--', '',
  ], 'boundary=B', '/v1/images/edits');
  assert.match(status, /400/, `an unnamed part names nothing — the image is missing: ${status}`);
});

test('a non-OWS byte before a disposition parameter name is not trimmed away', async () => {
  const started = await startLocalApiProxy({
    backend: imageBackend(), imageGenerationClient: imageBackend(),
    host: '127.0.0.1', port: 0, requestTimeoutMs: 30_000,
  });
  const target = new URL(started.url);
  try {
    const png = Buffer.from('iVBORw0KGgo=', 'base64').toString('latin1');
    const head = [
      '--B', 'Content-Disposition: form-data; name="model"', '', 'gpt-image-2', '--B', 'Content-Disposition: form-data; name=\"prompt\"', '', 'a dot',
      '--B',
    ].join('\r\n');
    const tail = [
      '', 'Content-Type: image/png', '', png,
      '--B--', '',
    ].join('\r\n');
    const disposition = Buffer.concat([
      Buffer.from('Content-Disposition: form-data;', 'latin1'),
      Buffer.from([0xa0]),
      Buffer.from('name="image"; filename="x.png"', 'latin1'),
    ]);
    const body = Buffer.concat([
      Buffer.from(head + '\r\n', 'latin1'), disposition, Buffer.from(tail, 'latin1'),
    ]);
    const raw = await new Promise((resolve, reject) => {
      const conn = net.connect(Number(target.port), target.hostname, () => conn.write(Buffer.concat([
        Buffer.from(
          'POST /v1/images/edits HTTP/1.1\r\nHost: h\r\n'
          + 'Content-Type: multipart/form-data; boundary=B\r\n'
          + `Content-Length: ${body.byteLength}\r\nConnection: close\r\n\r\n`, 'latin1'),
        body,
      ])));
      let data = '';
      conn.on('data', (chunk) => { data += chunk; });
      conn.on('end', () => resolve(data.split('\r\n')[0]));
      conn.on('error', reject);
    });
    assert.match(raw, /400/, `<0xA0>name is not the name parameter: ${raw}`);
  } finally {
    await started.close();
  }
});

// --- round 55 ---

test('a non-OWS byte in a part-header name or value is not trimmed away', async () => {
  const started = await startLocalApiProxy({
    backend: imageBackend(), imageGenerationClient: imageBackend(),
    host: '127.0.0.1', port: 0, requestTimeoutMs: 30_000,
  });
  const target = new URL(started.url);
  const send = async (dispositionBytes) => {
    const body = Buffer.concat([
      Buffer.from('--B\r\n', 'latin1'),
      dispositionBytes,
      Buffer.from('\r\n\r\na dot\r\n--B\r\nContent-Disposition: form-data; name="model"\r\n\r\ngpt-image-2\r\n--B--\r\n', 'latin1'),
    ]);
    return await new Promise((resolve, reject) => {
      const conn = net.connect(Number(target.port), target.hostname, () => conn.write(Buffer.concat([
        Buffer.from(
          'POST /v1/images/generations HTTP/1.1\r\nHost: h\r\n'
          + 'Content-Type: multipart/form-data; boundary=B\r\n'
          + `Content-Length: ${body.byteLength}\r\nConnection: close\r\n\r\n`, 'latin1'),
        body,
      ])));
      let data = '';
      conn.on('data', (chunk) => { data += chunk; });
      conn.on('end', () => resolve(data.split('\r\n')[0]));
      conn.on('error', reject);
    });
  };
  try {
    const nameByte = await send(Buffer.concat([
      Buffer.from('Content-Disposition', 'latin1'), Buffer.from([0xa0]),
      Buffer.from(': form-data; name="prompt"', 'latin1'),
    ]));
    assert.match(nameByte, /400/, `Content-Disposition<0xA0> is not that header: ${nameByte}`);

    const valueByte = await send(Buffer.concat([
      Buffer.from('Content-Disposition: form-data; name="prompt"', 'latin1'), Buffer.from([0xa0]),
    ]));
    assert.match(valueByte, /400/, `a trailing 0xA0 keeps the value malformed: ${valueByte}`);
  } finally {
    await started.close();
  }
});

// --- round 56 ---

test('a malformed disposition type does not name a part', async () => {
  const started = await startLocalApiProxy({
    backend: imageBackend(), imageGenerationClient: imageBackend(),
    host: '127.0.0.1', port: 0, requestTimeoutMs: 30_000,
  });
  const target = new URL(started.url);
  try {
    const body = Buffer.concat([
      Buffer.from('--B\r\nContent-Disposition:', 'latin1'),
      Buffer.from([0xa0]),
      Buffer.from(
        'form-data; name="prompt"\r\n\r\na dot\r\n'
        + '--B\r\nContent-Disposition: form-data; name="model"\r\n\r\ngpt-image-2\r\n--B--\r\n', 'latin1'),
    ]);
    const raw = await new Promise((resolve, reject) => {
      const conn = net.connect(Number(target.port), target.hostname, () => conn.write(Buffer.concat([
        Buffer.from(
          'POST /v1/images/generations HTTP/1.1\r\nHost: h\r\n'
          + 'Content-Type: multipart/form-data; boundary=B\r\n'
          + `Content-Length: ${body.byteLength}\r\nConnection: close\r\n\r\n`, 'latin1'),
        body,
      ])));
      let data = '';
      conn.on('data', (chunk) => { data += chunk; });
      conn.on('end', () => resolve(data.split('\r\n')[0]));
      conn.on('error', reject);
    });
    assert.match(raw, /400/, `<0xA0>form-data is not the form-data type — the prompt is missing: ${raw}`);
  } finally {
    await started.close();
  }
});

test('a non-OWS byte inside a data-URL media type is not repaired away', async () => {
  const { status } = await postImages('/v1/images/edits', {
    model: 'gpt-image-2', prompt: 'edit',
    images: [{ image_url: `data:\u00a0image/png;base64,${Buffer.from('89504e47', 'hex').toString('base64')}` }],
  });
  assert.equal(status, 400, 'the malformed token must not become image/png');
});

test('delimiter-looking bytes in the epilogue are ignored', async () => {
  // After a valid close delimiter the scanner must STOP: an epilogue carrying
  // `\r\n--B\r\n...` shaped bytes is not more parts.
  const status = await rawMultipart([
    '--B', 'Content-Disposition: form-data; name="model"', '', 'gpt-image-2',
    '--B', 'Content-Disposition: form-data; name="prompt"', '', 'a dot',
    '--B--', '--B', 'Content-Disposition: form-data; name="n"', '', '11', '--B--', '',
  ], 'boundary=B', '/v1/images/generations');
  assert.match(status, /200/, `the fake n=11 part lives in the epilogue and must be ignored: ${status}`);
});

// --- round 57 ---

test('a trailing non-OWS byte on a data-URL media type keeps it malformed', async () => {
  const { status } = await postImages('/v1/images/edits', {
    model: 'gpt-image-2', prompt: 'edit',
    images: [{ image_url: `data:image/png\u00a0;base64,${Buffer.from('89504e47', 'hex').toString('base64')}` }],
  });
  assert.equal(status, 400, 'image/png<0xA0> is not the token image/png');
});

// --- round 58 ---

test('an RFC 2045 subtype with braces is a valid image reference', async () => {
  const { status } = await postImages('/v1/images/edits', {
    model: 'gpt-image-2', prompt: 'edit',
    images: [{ image_url: `data:image/x-{foo};base64,${Buffer.from('89504e47', 'hex').toString('base64')}` }],
  });
  assert.equal(status, 200, '{ and } are not tspecials — x-{foo} is a token');
});

test('a whitespace-only data-URL media type is junk, not image/png', async () => {
  const { status } = await postImages('/v1/images/edits', {
    model: 'gpt-image-2', prompt: 'edit',
    images: [{ image_url: `data: \t;base64,${Buffer.from('89504e47', 'hex').toString('base64')}` }],
  });
  assert.equal(status, 400, 'OWS-only content must not be repaired into a default');
});

// --- round 59 ---

test('Unicode case-folding cannot smuggle a non-ASCII subtype', async () => {
  // U+212A KELVIN SIGN folds to ASCII k; RFC 2045 tokens are US-ASCII, so the
  // validation must see the ORIGINAL character and reject it.
  const { status } = await postImages('/v1/images/edits', {
    model: 'gpt-image-2', prompt: 'edit',
    images: [{ image_url: `data:image/\u212a;base64,${Buffer.from('89504e47', 'hex').toString('base64')}` }],
  });
  assert.equal(status, 400, 'KELVIN SIGN is not an ASCII token character');
});

test('an ASCII tspecial in the subtype is rejected', async () => {
  const { status } = await postImages('/v1/images/edits', {
    model: 'gpt-image-2', prompt: 'edit',
    images: [{ image_url: `data:image/png?x;base64,${Buffer.from('89504e47', 'hex').toString('base64')}` }],
  });
  assert.equal(status, 400, '? is a tspecial and ends no token');
});

test('an uppercase ASCII subtype still folds and passes', async () => {
  const { status } = await postImages('/v1/images/edits', {
    model: 'gpt-image-2', prompt: 'edit',
    images: [{ image_url: `data:IMAGE/PNG;base64,${Buffer.from('89504e47', 'hex').toString('base64')}` }],
  });
  assert.equal(status, 200, 'ASCII case-insensitivity is preserved');
});

// --- round 60: the last three coverage pins ---

test('duplicate part headers resolve last-wins, as documented', async () => {
  const status = await rawMultipart([
    '--B', 'Content-Disposition: form-data; name="decoy"', 'Content-Disposition: form-data; name="prompt"', '', 'a dot',
    '--B', 'Content-Disposition: form-data; name="model"', '', 'gpt-image-2',
    '--B--', '',
  ], 'boundary=B', '/v1/images/generations');
  assert.match(status, /200/, `the LAST disposition names the part: ${status}`);
});

test('an unterminated final part is dropped, not guessed at', async () => {
  const started = await startLocalApiProxy({
    backend: imageBackend(), imageGenerationClient: imageBackend(),
    host: '127.0.0.1', port: 0, requestTimeoutMs: 30_000,
  });
  const target = new URL(started.url);
  try {
    // The prompt lives ONLY in a final part that never closes.
    const body = [
      '--B', 'Content-Disposition: form-data; name="model"', '', 'gpt-image-2',
      '--B', 'Content-Disposition: form-data; name="prompt"', '', 'a dot',
    ].join('\r\n');
    const raw = await new Promise((resolve, reject) => {
      const conn = net.connect(Number(target.port), target.hostname, () => conn.write(Buffer.from(
        'POST /v1/images/generations HTTP/1.1\r\nHost: h\r\n'
        + 'Content-Type: multipart/form-data; boundary=B\r\n'
        + `Content-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`, 'latin1')));
      let data = '';
      conn.on('data', (chunk) => { data += chunk; });
      conn.on('end', () => resolve(data.split('\r\n')[0]));
      conn.on('error', reject);
    });
    assert.match(raw, /400/, `the unterminated prompt part must be dropped: ${raw}`);
  } finally {
    await started.close();
  }
});

test('OWS between a boundary and its CRLF is permitted', async () => {
  // The padded delimiter opens the REQUIRED part: rejecting it must change
  // the status. (Padding the optional model part let a rejection pass as 200
  // via the default model — the first version of this pin survived its own
  // mutation.)
  const status = await rawMultipart([
    '--B', 'Content-Disposition: form-data; name="model"', '', 'gpt-image-2',
    '--B \t', 'Content-Disposition: form-data; name="prompt"', '', 'a dot',
    '--B--', '',
  ], 'boundary=B', '/v1/images/generations');
  assert.match(status, /200/, `transport padding after the boundary is legal: ${status}`);
});
