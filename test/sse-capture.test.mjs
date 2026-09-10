// The streamed capture path, shown losing nothing.
//
// Every case below is a way the runner's own streaming path used to throw past
// its recording call. They run against a local server, so what is asserted is
// the real read of a real socket and not a description of one.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { startCaptureRun } from '../scripts/lib/capture-recorder.mjs';
import { SseTransportError, readRecordedSse } from '../scripts/lib/sse-capture.mjs';

const servers = [];
after(async () => {
  for (const server of servers) await new Promise((resolve) => server.close(resolve));
});

async function serving(handler) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

/** One capture run in its own directory, and the records it wrote. */
function capturing() {
  const dir = mkdtempSync(join(tmpdir(), 'sse-capture-'));
  const run = startCaptureRun({ dir, meta: { probe: 'sse-capture.test' } });
  return {
    records: () => readdirSync(run.runDir)
      .filter((name) => name !== 'run.json')
      .sort()
      .map((name) => JSON.parse(readFileSync(join(run.runDir, name), 'utf8'))),
  };
}

/**
 * The one record this call must have left — and proof that it left exactly one.
 *
 * `const [record] = run.records()` reads the first of however many there are, so
 * every assertion built on it passes a helper that records twice. The count is
 * the guarantee under test on EVERY exit, not only the good one: a second
 * recording makes a run's exchange count a lie.
 */
function soleRecord(run) {
  const records = run.records();
  assert.equal(records.length, 1, `recorded ${records.length} exchanges for one call`);
  return records[0];
}

const request = { headers: { 'content-type': 'application/json' }, body: '{"probe":1}' };
const read = (url, onFrame = () => {}) => readRecordedSse({
  url, request, timeoutMs: 5000, label: 'probe', startedAt: performance.now(), onFrame,
});

test('a refused stream is recorded with its body, not thrown away in a message', async () => {
  const url = await serving((req, res) => {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end('{"error":{"message":"nope","code":"probe_refused"}}');
  });
  const run = capturing();

  await assert.rejects(() => read(url), (error) => {
    assert.ok(error instanceof SseTransportError, `threw ${error?.name}`);
    assert.equal(error.status, 400);
    return true;
  });

  const record = soleRecord(run);
  assert.equal(record.status, 400);
  // The body is the evidence for an error-parity row, and it is here whole
  // rather than truncated into the error message.
  assert.equal(record.stream.text, '{"error":{"message":"nope","code":"probe_refused"}}');
  assert.match(record.error, /400/);
});

test('a stream that dies halfway is recorded with the bytes that arrived', async () => {
  const url = await serving((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"n":1}\n\n');
    // No terminator, and the connection drops mid-frame: the reader throws.
    // Dropped on a later tick so the head and the first frame reach the client
    // — destroying immediately fails the request itself, which is the case
    // below rather than this one.
    res.write('data: {"n":2}\n', () => setTimeout(() => res.socket.destroy(), 10));
  });
  const run = capturing();
  const frames = [];

  await assert.rejects(() => read(url, (frame) => frames.push(frame)));

  const record = soleRecord(run);
  assert.equal(record.status, 200);
  // What arrived is what a reader needs to see why it stopped: the completed
  // frame, and the partial one that never finished.
  assert.match(record.stream.text, /"n":1/);
  assert.match(record.stream.text, /"n":2/);
  // Which turn, and what it had already answered: a bare `terminated` says a
  // stream stopped and not which one.
  assert.match(record.error, /200, stream interrupted:/);
  assert.deepEqual(frames, ['data: {"n":1}'], 'a partial frame was handed on as if complete');
});

test('a stream cut inside a character records that something arrived', async () => {
  // The first byte of a multi-byte character, then nothing. A streaming decoder
  // holds that byte back waiting for the rest, so the exit path that skips the
  // flush recorded the empty string — a turn that reads afterwards as one where
  // nothing arrived at all, which is the opposite of what happened.
  const url = await serving((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(Buffer.from([0xed]), () => setTimeout(() => res.socket.destroy(), 10));
  });
  const run = capturing();

  await assert.rejects(() => read(url));

  const record = soleRecord(run);
  assert.equal(record.status, 200);
  assert.equal(record.stream.text, '\uFFFD', 'a byte arrived and the record says none did');
});

test('a whole stream is recorded once, with the terminator', async () => {
  const url = await serving((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"n":1}\n\n');
    res.write('data: {"n":2}\n\n');
    res.end('data: [DONE]\n\n');
  });
  const run = capturing();
  const frames = [];

  const { status, rawStream } = await read(url, (frame) => frames.push(frame));
  assert.equal(status, 200);
  assert.deepEqual(frames, ['data: {"n":1}', 'data: {"n":2}', 'data: [DONE]']);

  const record = soleRecord(run);
  assert.equal(record.error, null);
  // The terminator lives in the wire text and nowhere else — it is the matrix's
  // highest-risk cell, and a parsed event list cannot say whether it was sent.
  assert.equal(record.stream.text, rawStream);
  assert.match(record.stream.text, /^data: \[DONE\]$/m);
});

test('a good stream ending mid-character records what the callback saw', async () => {
  // The other half of the flush, and the half no case reached: case #3 asserts
  // `record.stream.text === rawStream` but its stream ends on a blank line, so
  // the tail is empty and the assertion holds with the flush removed. This one
  // ends INSIDE a character, where the frame callback is handed a replacement
  // character that the record used to go without.
  const url = await serving((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"n":1}\n\n');
    res.end(Buffer.from([0xed]));
  });
  const run = capturing();
  const frames = [];

  const { rawStream } = await read(url, (frame) => frames.push(frame));
  assert.deepEqual(frames, ['data: {"n":1}', '\uFFFD']);

  const record = soleRecord(run);
  assert.equal(record.stream.text, rawStream);
  assert.equal(record.stream.text, 'data: {"n":1}\n\n\uFFFD',
    'the callback was handed a character the record does not hold');
});

test('a request that never reached a response is recorded too', async () => {
  // The connection is reset before the head is written, so `fetch` itself
  // throws and there is no response to describe. Recording nothing here reads
  // afterwards as a call that was never made, rather than one the vendor
  // dropped — the difference a run's evidence exists to preserve.
  const url = await serving((req, res) => { res.socket.destroy(); });
  const run = capturing();

  await assert.rejects(() => read(url));

  const record = soleRecord(run);
  assert.equal(record.status, null);
  assert.equal(record.request.text, request.body);
  assert.ok(record.error, 'a reset connection recorded no error');
});

test('a 200 whose stream carries nothing is recorded as the empty turn it was', async () => {
  // A body that is present and empty, which is what `res.end()` on a 200 sends.
  // It is NOT the missing-body case below: naming it that made the guard for
  // that case look tested when nothing reached it.
  const url = await serving((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end();
  });
  const run = capturing();
  const { rawStream } = await read(url);
  assert.equal(rawStream, '');
  const record = soleRecord(run);
  assert.equal(record.status, 200);
  assert.equal(record.stream.text, '');
});

test('a success with no body at all is refused, and recorded', async () => {
  // 204 is `res.ok`, so it walks past the refusal branch and reaches the guard
  // that has no stream to read. Reaching it is the point: read as an empty
  // stream instead, it would look like a turn the vendor answered with nothing.
  const url = await serving((req, res) => {
    res.writeHead(204);
    res.end();
  });
  const run = capturing();

  await assert.rejects(() => read(url), (error) => {
    assert.ok(error instanceof SseTransportError, `threw ${error?.name}`);
    assert.equal(error.status, 204);
    assert.match(error.message, /did not return a readable stream/);
    return true;
  });

  const record = soleRecord(run);
  assert.equal(record.status, 204);
  assert.match(record.error, /did not return a readable stream/);
});

test('a caller that asked for the refusal gets it back, and no failure is recorded', async () => {
  // The prober's mode. The same bytes, the same record, and `error: null` —
  // recording a probe's answer as a failed exchange makes a run's failure count
  // a lie about what happened.
  const url = await serving((req, res) => {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end('{"error":{"message":"bad stream_options"}}');
  });
  const run = capturing();

  const { status, rawStream } = await readRecordedSse({
    url, request, timeoutMs: 5000, label: 'probe', startedAt: performance.now(),
    onFrame: () => {}, refusalIsFailure: false,
  });
  assert.equal(status, 400);
  assert.equal(rawStream, '{"error":{"message":"bad stream_options"}}');

  const record = soleRecord(run);
  assert.equal(record.status, 400);
  assert.equal(record.stream.text, rawStream);
  assert.equal(record.error, null, 'an answer the caller asked for was recorded as a failure');
});

test('a body-less success is an answer too when the caller asked for one', async () => {
  const url = await serving((req, res) => { res.writeHead(204); res.end(); });
  const run = capturing();

  const { status, rawStream } = await readRecordedSse({
    url, request, timeoutMs: 5000, label: 'probe', startedAt: performance.now(),
    onFrame: () => {}, refusalIsFailure: false,
  });
  assert.equal(status, 204);
  assert.equal(rawStream, '');
  assert.equal(soleRecord(run).error, null);
});

test('a body cut halfway is a failure even for a caller that wanted the refusal', async () => {
  // The line the flag does NOT move: the caller asked a question and did not get
  // the whole answer, whatever the status said.
  const url = await serving((req, res) => {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.write('{"error":"cut', () => setTimeout(() => res.socket.destroy(), 10));
  });
  const run = capturing();

  await assert.rejects(() => readRecordedSse({
    url, request, timeoutMs: 5000, label: 'probe', startedAt: performance.now(),
    onFrame: () => {}, refusalIsFailure: false,
  }));

  const record = soleRecord(run);
  assert.equal(record.status, 400);
  assert.equal(record.stream.text, '{"error":"cut');
  assert.match(record.error, /body interrupted/);
});

test('a caller whose onFrame throws does not leave the request open', async () => {
  // The exception reached the caller at once while the socket stayed open until
  // an unrelated timeout fired, so a run's own timings and the vendor's view of
  // when the call ended disagreed. The server below never ends the response.
  let closed = null;
  const opened = [];
  const url = await serving((req, res) => {
    opened.push(res);
    res.on('close', () => { closed = performance.now(); });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"n":1}\n\n');
  });
  const run = capturing();
  const startedAt = performance.now();

  await assert.rejects(
    () => readRecordedSse({
      url, request, timeoutMs: 30_000, label: 'probe', startedAt,
      onFrame: () => { throw new Error('caller exploded'); },
    }),
    (error) => { assert.equal(error.message, 'caller exploded'); return true; },
  );

  // The timeout is 30 s and this must not wait for it.
  const deadline = performance.now() + 2000;
  while (closed === null && performance.now() < deadline) await new Promise((r) => setTimeout(r, 10));
  assert.ok(closed !== null, 'the request was still open two seconds after the caller threw');
  assert.ok(closed - startedAt < 2000, `the request stayed open ${Math.round(closed - startedAt)}ms`);

  const record = soleRecord(run);
  assert.equal(record.status, 200);
  assert.match(record.error, /caller exploded/);
});

test('a long refusal is truncated in the message and kept whole in the record', async () => {
  // The two halves of the same rule. The message is a diagnostic and is cut to
  // the length the runner's buffered path cuts to — the extraction shortened it
  // to a fifth of that, which drops the end of a body where the vendor's code
  // often is. The record is evidence and is never cut at all.
  const body = `{"error":{"message":"${'x'.repeat(2400)}","code":"probe_long"}}`;
  const url = await serving((req, res) => {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(body);
  });
  const run = capturing();

  await assert.rejects(() => read(url), (error) => {
    const shown = error.message.slice(`${url} 400: `.length);
    assert.equal(shown, `${body.slice(0, 2000)}...`, 'the message is not cut where the runner cuts');
    return true;
  });

  assert.equal(soleRecord(run).stream.text, body, 'the record lost bytes the message had to drop');
});

test('a whole refusal ending mid-character says the same thing twice', async () => {
  // The message is built from `rawStream` BEFORE the exit flush runs, so the
  // refusal branch has to flush its own decoder. Without that the thrown
  // message is a character shorter than the record — one body, described two
  // ways, which is the shape this file exists to remove.
  const url = await serving((req, res) => {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(Buffer.from([0x7b, 0x22, 0x65, 0x22, 0x3a, 0x22, 0xed]));
  });
  const run = capturing();

  let thrown;
  await assert.rejects(() => read(url), (error) => { thrown = error; return true; });

  const record = soleRecord(run);
  assert.equal(record.stream.text, '{"e":"\uFFFD');
  assert.equal(thrown.message, `${url} 400: ${record.stream.text}`,
    'the message and the record disagree about one body');
});

test('a refusal cut off mid-body keeps the bytes that arrived', async () => {
  // The mirror of the broken stream above. `res.text()` resolves only on a
  // whole body, so this exit used to record the empty string — a refusal that
  // reads afterwards as one the vendor sent no reason for.
  const url = await serving((req, res) => {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.write('{"error":{"message":"cut', () => setTimeout(() => res.socket.destroy(), 10));
  });
  const run = capturing();

  await assert.rejects(() => read(url));

  const record = soleRecord(run);
  assert.equal(record.status, 400);
  assert.equal(record.stream.text, '{"error":{"message":"cut');
  assert.match(record.error, /400/);
  assert.match(record.error, /body interrupted/);
});
