// One exchange as the direct-API prober makes it, in a function rather than
// inside a loop that needs vendor keys to reach.
//
// It lives here because of what happened when it did not. The prober's stream
// read was the same all-or-nothing `res.text()` the runner's was, so a stream
// cut halfway wrote `status: null, stream: null` — a record that reads
// afterwards as a call nobody made. Fixing it inside `probe-direct-api.mjs` left
// the fix unverifiable: that script refuses to start without both vendor keys
// and, given them, spends real vendor calls, and its base URLs are deliberately
// not overridable, because an env var that redirected them would let bytes
// claiming to be the vendor's into the store every gate treats as frozen.
//
// A checker that read the fix out of the file and ran a TRANSCRIPTION of it
// beside the file was the next attempt, and two reviewers broke it the same way
// within an hour: put the reader behind `if (false)`, return fabricated text,
// and the checker still said PASS, because token presence is not execution.
// So the glue moved here, where a test can call the thing that ships.
import { recordExchange } from './capture-recorder.mjs';
import { SseTransportError, readRecordedSse } from './sse-capture.mjs';

/**
 * POST one probe and record the exchange, whatever happens to it.
 *
 * Returns `{status, text, wire, failed}`. `failed` is a string when the probe
 * got no answer to read — and ONLY then: a vendor refusing a bad request is what
 * several of these probes exist to see, so a non-2xx comes back as an
 * observation with its status and its body, not as a failure.
 */
export async function readProbeExchange({ url, headers, requestBody, stream, label, timeoutMs }) {
  const startedAt = Date.now();
  if (stream) {
    try {
      const read = await readRecordedSse({
        url,
        request: { headers, body: requestBody },
        timeoutMs,
        label,
        startedAt: performance.now(),
        onFrame: () => {},
        // The prober's whole question. `readRecordedSse` records either way; this
        // decides whether the record calls the answer a failure.
        refusalIsFailure: false,
      });
      return { status: read.status, text: read.rawStream, wire: read.rawStream, failed: null };
    } catch (error) {
      // Recorded already, with the status and the bytes that arrived. What
      // reaches here is a turn that stopped: a reset, a timeout, a body cut
      // halfway, or a success with no stream to read at all.
      const failed = error instanceof SseTransportError
        ? `${error.name}: ${error.message}`
        : String(error);
      return { status: error?.status ?? null, text: '', wire: '', failed };
    }
  }

  let res = null;
  let text = '';
  // Whether `res.text()` finished. Without it the catch recorded `text`'s
  // initial `''` as the response body, which `encodeBody` writes as a known
  // zero-byte body with the empty string's digest — a turn that reads afterwards
  // as one the vendor answered with nothing, rather than one whose answer never
  // arrived. Both readers this replaced omitted the field and recorded null.
  let read = false;
  let recorded = false;
  const record = (error) => {
    if (recorded) return;
    recorded = true;
    recordExchange({
      kind: 'json',
      label,
      url,
      requestHeaders: headers,
      requestBody,
      // `res` is set as soon as the head arrives, so a body that dies mid-read
      // still knows what the vendor answered. Recording none of it said the
      // request had never reached anyone.
      status: res?.status ?? null,
      statusText: res?.statusText ?? null,
      responseHeaders: res?.headers ?? null,
      responseBody: read ? text : undefined,
      durationMs: Date.now() - startedAt,
      error: error ?? null,
    });
  };

  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: requestBody,
      signal: AbortSignal.timeout(timeoutMs),
    });
    text = await res.text();
    read = true;
  } catch (error) {
    record(error);
    return { status: res?.status ?? null, text: '', wire: '', failed: String(error) };
  }
  record(null);
  return { status: res.status, text, wire: '', failed: null };
}
