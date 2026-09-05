// Runs one buffered and one streamed image request with a concrete `size` and
// reports what came back and whether the backend was ever called. Run twice by
// `codex-backend-transport.test.mjs`: once with the failing-codec hook and once
// without, so the counter is proven against the opposite answer rather than
// trusted.
import { CodexBackendTransport } from '../../dist/proxy/codex-backend-transport.js';

let fetchCalls = 0;
globalThis.fetch = async () => {
  fetchCalls += 1;
  // A turn that starts here is the failure this probe is looking for; the body
  // is irrelevant, so it is answered as a backend outage.
  throw new Error('backend turn started');
};

const request = {
  operation: 'generation', model: 'gpt-image-2', prompt: 'x', n: 1, images: [],
  size: '32x16', quality: 'medium', stream: false, partialImages: 0, raw: {},
};

const backend = new CodexBackendTransport({ timeoutMs: 5_000, model: 'gpt-5.5' });
const report = (err) => (err && typeof err === 'object'
  ? { name: err.constructor?.name ?? null, statusCode: err.statusCode ?? null, type: err.type ?? null, param: err.param ?? null, code: err.code ?? null, message: String(err.message).slice(0, 200) }
  : { raw: String(err) });

const out = {};
try {
  await backend.generate(request);
  out.buffered = 'resolved';
} catch (err) {
  out.buffered = report(err);
}
out.fetchCallsAfterBuffered = fetchCalls;
try {
  const iterator = backend.stream({ ...request, stream: true })[Symbol.asyncIterator]();
  await iterator.next();
  out.streamed = 'resolved';
} catch (err) {
  out.streamed = report(err);
}
out.fetchCalls = fetchCalls;
process.stdout.write(JSON.stringify(out));
process.exit(0);
