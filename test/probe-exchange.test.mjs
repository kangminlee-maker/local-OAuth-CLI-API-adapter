// The direct-API prober's exchange, driven the way the prober drives it.
//
// This file exists because the previous attempt did not. `probe-direct-api.mjs`
// cannot be run here — it needs both vendor keys and spends real calls — so its
// stream read was checked by a script that read the delegation out of the source
// and ran a TRANSCRIPTION of it beside the file. Two reviewers broke that within
// an hour: put the reader behind `if (false)`, return fabricated text, plant an
// unconditional throw after it, and the checker still said PASS, because token
// presence is not execution. The glue moved into `scripts/lib/probe-exchange.mjs`
// so these cases call the function that ships.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { startCaptureRun } from '../scripts/lib/capture-recorder.mjs';
import { readProbeExchange } from '../scripts/lib/probe-exchange.mjs';

const servers = [];
after(async () => {
  for (const server of servers) await new Promise((resolve) => server.close(resolve));
});

/**
 * A server, and what it actually received.
 *
 * The handlers used to answer without reading the request at all, so a helper
 * that sent `body: '{}'` — or no body and no headers — passed every case while
 * the record froze the caller's original bytes as if they had crossed the wire.
 * A capture store whose request side is the caller's intent rather than the
 * request is the defect this whole campaign is about, one field over.
 */
async function serving(handler) {
  const seen = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      seen.push({
        method: req.method,
        path: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      handler(req, res);
    });
  });
  servers.push(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, seen };
}

/** What the server got, asserted against what the caller asked to send. */
function received(seen, record) {
  assert.equal(seen.length, 1, `the server saw ${seen.length} requests for one probe`);
  const [request] = seen;
  assert.equal(request.method, 'POST');
  assert.equal(request.path, '/', 'the helper sent the right bytes to the wrong place');
  assert.equal(request.body, requestBody, 'the helper sent a body other than the probe\'s');
  assert.equal(request.headers['content-type'], headers['content-type']);
  assert.equal(request.headers['x-probe-marker'], headers['x-probe-marker'],
    'the helper dropped a header the probe supplied');
  if (record) {
    assert.equal(record.request.text, request.body,
      'the record describes a request the server did not get');
  }
  return request;
}

function capturing() {
  const dir = mkdtempSync(join(tmpdir(), 'probe-exchange-'));
  const run = startCaptureRun({ dir, meta: { probe: 'probe-exchange.test' } });
  return {
    sole: () => {
      const records = readdirSync(run.runDir)
        .filter((name) => name !== 'run.json')
        .map((name) => JSON.parse(readFileSync(join(run.runDir, name), 'utf8')));
      assert.equal(records.length, 1, `recorded ${records.length} exchanges for one probe`);
      return records[0];
    },
  };
}

// A synthetic header, carried only so a case can prove it reached the socket.
const headers = { 'content-type': 'application/json', 'x-probe-marker': 'round-4' };
const requestBody = '{"probe":1}';
const probe = (url, stream) => readProbeExchange({
  url, headers, requestBody, stream, label: 'probe', timeoutMs: 5000,
});

test('a streamed answer comes back whole, and is recorded once', async () => {
  const { url, seen } = await serving((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"n":1}\n\n');
    res.end('data: [DONE]\n\n');
  });
  const run = capturing();

  const got = await probe(url, true);
  assert.equal(got.failed, null);
  assert.equal(got.status, 200);
  // Both, because `probe.read` is handed both and reads them for different things.
  assert.match(got.text, /^data: \[DONE\]$/m);
  assert.equal(got.wire, got.text);

  const record = run.sole();
  // The record's request side has to be what the server got, not what the
  // caller meant to send.
  received(seen, record);
  assert.equal(record.status, 200);
  assert.equal(record.stream.text, got.wire);
  assert.equal(record.error, null);
});

test('a refusal is an observation, not a failed exchange', async () => {
  // P-10 sends an undocumented key to see what the vendor says. The answer IS
  // the refusal, and a record that calls it a failure makes a run's failure
  // count a lie about what happened.
  const { url, seen } = await serving((req, res) => {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end('{"error":{"message":"bad stream_options"}}');
  });
  const run = capturing();

  const got = await probe(url, true);
  assert.equal(got.failed, null, 'a refusal was reported as a failed probe');
  assert.equal(got.status, 400);
  assert.equal(got.text, '{"error":{"message":"bad stream_options"}}');
  assert.equal(got.wire, got.text);

  const record = run.sole();
  received(seen, record);
  assert.equal(record.status, 400);
  assert.equal(record.stream.text, got.text);
  assert.equal(record.error, null);
});

test('a streamed 204 is an observation too', async () => {
  const { url, seen } = await serving((req, res) => { res.writeHead(204); res.end(); });
  const run = capturing();

  const got = await probe(url, true);
  assert.equal(got.failed, null);
  assert.equal(got.status, 204);
  assert.equal(got.text, '');
  const record = run.sole();
  received(seen, record);
  assert.equal(record.error, null);
});

test('a stream cut halfway keeps its status and its bytes', async () => {
  // The defect this function was extracted over: read all-or-nothing, this wrote
  // `status: null, stream: null` — a record that reads afterwards as a call
  // nobody made, in the store every conformance gate treats as frozen.
  const { url, seen } = await serving((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"n":1}\n\n');
    res.write('data: {"n":2}\n', () => setTimeout(() => res.socket.destroy(), 10));
  });
  const run = capturing();

  const got = await probe(url, true);
  assert.ok(got.failed, 'a cut stream was reported as a readable answer');

  const record = run.sole();
  received(seen, record);
  assert.equal(record.status, 200, 'a cut stream recorded no status');
  assert.ok(record.stream, 'a cut stream recorded no bytes at all');
  assert.match(record.stream.text, /"n":1/);
  assert.match(record.stream.text, /"n":2/);
  assert.match(record.error, /stream interrupted/);
});

test('a request that never reached a response is still recorded', async () => {
  const { url, seen } = await serving((req, res) => { res.socket.destroy(); });
  const run = capturing();

  const got = await probe(url, true);
  assert.ok(got.failed);
  const record = run.sole();
  received(seen, record);
  assert.equal(record.status, null);
  assert.ok(record.error);
});

test('a buffered request that never reached a response records no body', async () => {
  // The OTHER buffered failure point. The case below reaches the mid-read one;
  // this one dies before a response exists, and the two used to be confused: the
  // assertion meant for this exit was written on a STREAM probe, where `response`
  // is null for a different reason entirely.
  const { url, seen } = await serving((req, res) => { res.socket.destroy(); });
  const run = capturing();

  const got = await probe(url, false);
  assert.ok(got.failed);
  assert.equal(got.status, null);

  const record = run.sole();
  received(seen, record);
  assert.equal(record.status, null, 'a turn that got no response recorded one');
  assert.equal(record.response, null, 'a body that never arrived was recorded as an empty one');
  assert.ok(record.error);
});

test('a buffered answer is recorded with its body', async () => {
  const { url, seen } = await serving((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  const run = capturing();

  const got = await probe(url, false);
  assert.equal(got.failed, null);
  assert.equal(got.status, 200);
  assert.equal(got.text, '{"ok":true}');
  assert.equal(got.wire, '', 'a buffered turn has no wire to read');

  const record = run.sole();
  received(seen, record);
  assert.equal(record.status, 200);
  assert.equal(record.response.text, '{"ok":true}');
  assert.equal(record.error, null);
});

test('a buffered body that dies mid-read keeps the status the vendor gave', async () => {
  const { url, seen } = await serving((req, res) => {
    res.writeHead(500, { 'content-type': 'application/json', 'content-length': '64' });
    res.write('{"error":"half', () => setTimeout(() => res.socket.destroy(), 10));
  });
  const run = capturing();

  const got = await probe(url, false);
  assert.ok(got.failed);

  const record = run.sole();
  received(seen, record);
  assert.equal(record.status, 500, 'the head had already arrived and the record forgot it');
  assert.ok(record.error);
  // Not the empty string: a body that never arrived and a body that was empty
  // are different answers, and `encodeBody` gives the first one the second's
  // digest if it is handed `''`.
  assert.equal(record.response, null, 'a body that never arrived was recorded as an empty one');
});
