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

  const [record] = run.records();
  assert.ok(record, 'the refusal recorded nothing at all');
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

  const [record] = run.records();
  assert.ok(record, 'the broken stream recorded nothing at all');
  assert.equal(record.status, 200);
  // What arrived is what a reader needs to see why it stopped: the completed
  // frame, and the partial one that never finished.
  assert.match(record.stream.text, /"n":1/);
  assert.match(record.stream.text, /"n":2/);
  assert.ok(record.error, 'a broken stream recorded no error');
  assert.deepEqual(frames, ['data: {"n":1}'], 'a partial frame was handed on as if complete');
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

  const records = run.records();
  // Exactly one: the `finally` records every exit, so a success path that also
  // recorded at the end would leave two and make a run's exchange count a lie.
  assert.equal(records.length, 1, `recorded ${records.length} exchanges for one call`);
  assert.equal(records[0].error, null);
  // The terminator lives in the wire text and nowhere else — it is the matrix's
  // highest-risk cell, and a parsed event list cannot say whether it was sent.
  assert.equal(records[0].stream.text, rawStream);
  assert.match(records[0].stream.text, /^data: \[DONE\]$/m);
});

test('a request that never reached a response is recorded too', async () => {
  // The connection is reset before the head is written, so `fetch` itself
  // throws and there is no response to describe. Recording nothing here reads
  // afterwards as a call that was never made, rather than one the vendor
  // dropped — the difference a run's evidence exists to preserve.
  const url = await serving((req, res) => { res.socket.destroy(); });
  const run = capturing();

  await assert.rejects(() => read(url));

  const [record] = run.records();
  assert.ok(record, 'a reset connection recorded nothing at all');
  assert.equal(record.status, null);
  assert.equal(record.request.text, request.body);
  assert.ok(record.error, 'a reset connection recorded no error');
});

test('a 200 with no readable body is recorded rather than thrown past', async () => {
  const url = await serving((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end();
  });
  const run = capturing();
  const { rawStream } = await read(url);
  assert.equal(rawStream, '');
  const records = run.records();
  assert.equal(records.length, 1);
  assert.equal(records[0].status, 200);
});
