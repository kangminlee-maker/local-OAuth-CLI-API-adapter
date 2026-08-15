import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { after, test } from 'node:test';

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const trees = [];

after(async () => {
  await Promise.all(trees.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

// The combination that a regression hid in: honouring ON, a model that is
// accepted, and a real streaming response. Rejection tests never reach the
// stream, and off-mode tests never take the prefetch path, so neither notices a
// prefetch that aborts healthy requests.
async function runScenario(scenario, honorRequestModel = true) {
  const root = await mkdtemp(join(tmpdir(), 'streaming-live-'));
  trees.push(root);
  await cp(join(repoRoot, 'dist'), join(root, 'dist'), { recursive: true });
  const settings = JSON.parse(await readFile(join(repoRoot, 'settings.json'), 'utf8'));
  await writeFile(
    join(root, 'settings.json'),
    `${JSON.stringify({ ...settings, modelSelection: { honorRequestModel } }, null, 2)}\n`,
  );
  const scriptPath = join(root, 'probe.mjs');
  await writeFile(scriptPath, `
    import { startLocalApiProxy } from ${JSON.stringify(join(root, 'dist/proxy/http-server.js'))};
    import { request as httpRequest } from 'node:http';

    const state = { cleanedUp: false, aborted: false };
    const backend = {
      name: 'live', model: 'live-model',
      async generate() {
        return { id: 'x', model: 'live-model', text: 'OK', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, source: 'estimated' }, latencyMs: 1 };
      },
      async *stream(request, signal) {
        signal?.addEventListener('abort', () => { state.aborted = true; });
        try {
          // A real backend takes a moment before its first event, and honours the
          // abort signal rather than running to completion.
          await new Promise((r, rejectP) => {
            const timer = setTimeout(r, ${scenario === 'disconnect' ? 400 : 30});
            signal?.addEventListener('abort', () => {
              clearTimeout(timer);
              rejectP(new Error('aborted'));
            }, { once: true });
          });
          yield { type: 'text_delta', delta: 'hello' };
          if (${scenario === 'late-disconnect' ? 'true' : 'false'}) {
            // Hold after the first event so a post-prefetch disconnect has a
            // pending turn to abort.
            await new Promise((r, rejectP) => {
              const timer = setTimeout(r, 5000);
              signal?.addEventListener('abort', () => { clearTimeout(timer); rejectP(new Error('aborted')); }, { once: true });
            });
          }
          yield { type: 'text_delta', delta: ' world' };
          yield { type: 'completed', result: { id: 'x', model: 'live-model', text: 'hello world', toolCalls: [], usage: { inputTokens: 1, outputTokens: 2, source: 'estimated' }, latencyMs: 1 } };
        } finally {
          state.cleanedUp = true;
        }
      },
      async close() {},
    };

    const started = await startLocalApiProxy({ backend, host: '127.0.0.1', port: 0, requestTimeoutMs: 30000 });
    const body = JSON.stringify({ model: 'live-model', stream: true, messages: [{ role: 'user', content: 'hi' }] });
    const outcome = await new Promise((resolveP) => {
      const req = httpRequest(started.url + '/v1/chat/completions',
        { method: 'POST', headers: { 'content-type': 'application/json' } },
        (res) => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (c) => { text += c; });
          res.on('end', () => resolveP({ status: res.statusCode, contentType: res.headers['content-type'], text }));
          res.on('error', () => resolveP({ status: res.statusCode, aborted: true, text }));
        });
      req.on('error', () => resolveP({ error: true }));
      req.end(body);
      ${scenario === 'disconnect' ? "setTimeout(() => req.destroy(), 100);" : ''}
      ${scenario === 'late-disconnect' ? "setTimeout(() => req.destroy(), 300);" : ''}
    });
    await new Promise((r) => setTimeout(r, 300));
    await started.close();
    process.stdout.write(JSON.stringify({ ...outcome, state }));
  `);
  const { stdout } = await execFileAsync(process.execPath, [scriptPath], { cwd: root });
  return JSON.parse(stdout);
}

test('honour-on: a valid model streams normally and is not aborted by the prefetch', async () => {
  const result = await runScenario('complete');
  assert.equal(result.status, 200, `body: ${result.text}`);
  assert.ok(String(result.contentType).includes('event-stream'), result.contentType);
  assert.ok(result.text.includes('hello'), `expected streamed text: ${result.text}`);
  assert.ok(result.text.includes('[DONE]'), `expected a completed stream: ${result.text}`);
  assert.equal(result.state.aborted, false, 'a healthy request must not be aborted');
  assert.equal(result.state.cleanedUp, true);
});

test('honour-on: a disconnect AFTER the first event still aborts the backend', async () => {
  // The close listener used to be released once the prefetched event settled,
  // so only the pre-first-event case was protected.
  const result = await runScenario('late-disconnect');
  assert.equal(result.state.aborted, true, 'the backend signal must abort after a late disconnect');
  assert.equal(result.state.cleanedUp, true);
});

test('honour-on: a disconnect while the first event is pending aborts the backend', async () => {
  const result = await runScenario('disconnect');
  assert.equal(result.state.aborted, true, 'the backend signal must be aborted on disconnect');
  assert.equal(result.state.cleanedUp, true, 'the backend stream must be cleaned up');
});

// Whether headers arrive before the backend's first event is exactly what the
// off-mode branch preserves. Asserting it through the real server is the only
// way to catch a regression that made every stream prefetch.
async function headerTiming(honorRequestModel) {
  const root = await mkdtemp(join(tmpdir(), 'stream-timing-'));
  trees.push(root);
  await cp(join(repoRoot, 'dist'), join(root, 'dist'), { recursive: true });
  const settings = JSON.parse(await readFile(join(repoRoot, 'settings.json'), 'utf8'));
  await writeFile(
    join(root, 'settings.json'),
    `${JSON.stringify({ ...settings, modelSelection: { honorRequestModel } }, null, 2)}\n`,
  );
  const scriptPath = join(root, 'timing.mjs');
  await writeFile(scriptPath, `
    import { startLocalApiProxy } from ${JSON.stringify(join(root, 'dist/proxy/http-server.js'))};
    import { request as httpRequest } from 'node:http';

    let releaseGate;
    const gate = new Promise((r) => { releaseGate = r; });
    const backend = {
      name: 'gated', model: 'gated-model',
      async generate() {
        return { id: 'x', model: 'gated-model', text: 'OK', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, source: 'estimated' }, latencyMs: 1 };
      },
      async *stream() {
        await gate;
        yield { type: 'text_delta', delta: 'go' };
        yield { type: 'completed', result: { id: 'x', model: 'gated-model', text: 'go', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, source: 'estimated' }, latencyMs: 1 } };
      },
      async close() {},
    };

    const started = await startLocalApiProxy({ backend, host: '127.0.0.1', port: 0, requestTimeoutMs: 30000 });
    let headersBeforeGate = null;
    const done = new Promise((resolveP) => {
      const req = httpRequest(started.url + '/v1/chat/completions',
        { method: 'POST', headers: { 'content-type': 'application/json' } },
        (res) => {
          headersBeforeGate = headersBeforeGate ?? 'before';
          res.resume();
          res.on('end', () => resolveP());
        });
      req.on('error', () => resolveP());
      req.end(JSON.stringify({ model: 'gated-model', stream: true, messages: [{ role: 'user', content: 'hi' }] }));
    });

    // Give the server time to write headers if it is going to.
    await new Promise((r) => setTimeout(r, 400));
    const sawHeadersWhileGated = headersBeforeGate !== null;
    releaseGate();
    await done;
    await started.close();
    process.stdout.write(JSON.stringify({ sawHeadersWhileGated }));
  `);
  const { stdout } = await execFileAsync(process.execPath, [scriptPath], { cwd: root });
  return JSON.parse(stdout);
}

test('off mode sends headers before the backend produces anything', async () => {
  const result = await headerTiming(false);
  assert.equal(result.sawHeadersWhileGated, true, 'default-off must not wait on the backend for headers');
});

test('honour-on holds headers until the first event settles', async () => {
  const result = await headerTiming(true);
  assert.equal(result.sawHeadersWhileGated, false, 'honour-on must settle the first event before headers');
});

// Streaming chunks carry a `model`. Echoing the request there is only correct by
// coincidence; with honouring on the proxy knows what actually runs.
test('honour-on: streaming chunks report the executed model, not the request echo', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stream-model-echo-'));
  trees.push(root);
  await cp(join(repoRoot, 'dist'), join(root, 'dist'), { recursive: true });
  const settings = JSON.parse(await readFile(join(repoRoot, 'settings.json'), 'utf8'));
  await writeFile(
    join(root, 'settings.json'),
    `${JSON.stringify({ ...settings, modelSelection: { honorRequestModel: true } }, null, 2)}\n`,
  );
  const scriptPath = join(root, 'echo.mjs');
  await writeFile(scriptPath, `
    import { startLocalApiProxy } from ${JSON.stringify(join(root, 'dist/proxy/http-server.js'))};
    // Three distinct values, so the reported one can only have come from
    // resolvedModel: the configured model, the model the request asks for, and
    // the model that actually runs. An earlier version made the configured model
    // and the executed model the same string, which let the production call be
    // replaced with backend.model while the test stayed green.
    let resolvedCalls = 0;
    const backend = {
      name: 'test', model: 'configured-not-this',
      async resolvedModel() { resolvedCalls += 1; return 'actually-runs-this'; },
      async generate() { return { id: 'x', model: 'actually-runs-this', text: 'OK', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, source: 'estimated' }, latencyMs: 1 }; },
      async *stream() {
        yield { type: 'text_delta', delta: 'hi' };
        yield { type: 'completed', result: { id: 'x', model: 'actually-runs-this', text: 'hi', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, source: 'estimated' }, latencyMs: 1 } };
      },
      async close() {},
    };
    const started = await startLocalApiProxy({ backend, host: '127.0.0.1', port: 0, requestTimeoutMs: 30000 });
    const res = await fetch(started.url + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5.6-sol', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    });
    const text = await res.text();
    await started.close();
    process.stdout.write(JSON.stringify({ text, resolvedCalls }));
  `);
  const { stdout } = await execFileAsync(process.execPath, [scriptPath], { cwd: root });
  const { text, resolvedCalls } = JSON.parse(stdout);
  assert.equal(resolvedCalls, 1, 'the streaming path must ask the backend which model runs');
  assert.ok(text.includes('actually-runs-this'), `chunks must name the executed model: ${text}`);
  assert.ok(!text.includes('gpt-5.6-sol'), `chunks must not echo the request model: ${text}`);
  assert.ok(!text.includes('configured-not-this'), `chunks must not fall back to the configured model: ${text}`);
});
