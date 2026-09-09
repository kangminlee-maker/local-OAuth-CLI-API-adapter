// Reading a streamed response so that whatever happened is recorded, including
// when nothing good happened.
//
// The runner's buffered path already had this right and said why: it records
// before the status check, "so the body of a 4xx survives — that body is the
// whole evidence for an error-parity row". Its streaming path did the opposite.
// A non-2xx threw with the body truncated into an error message, and a stream
// that died halfway threw past the recording call at the end, so the bytes that
// would explain the failure — the only place the terminator and the chunk
// boundaries live — were the ones thrown away. Two paths in one file, answering
// the same question differently, which is the shape of defect this repository
// keeps producing.
//
// It lives here rather than in the runner because the runner retires and this
// does not: the capture path is what the conformance suite consumes.
import { recordExchange } from './capture-recorder.mjs';

/** Enough of a body to read in an error message, without carrying the whole turn. */
const truncate = (text, limit = 400) => (text.length > limit ? `${text.slice(0, limit)}…` : text);

/** A transport failure that already carries its status, so a caller need not re-read the response. */
export class SseTransportError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'SseTransportError';
    this.status = status;
  }
}

/**
 * POST, read the stream frame by frame, and record the exchange exactly once on
 * every exit.
 *
 * `onFrame` receives each complete SSE frame — the text between blank lines,
 * unparsed — in arrival order, and the trailing partial frame if the stream ends
 * without one. What the frames MEAN is the caller's business; what crossed the
 * wire is this function's.
 *
 * The recording is in a `finally`. Anything else is a list of exits someone has
 * to keep complete, and the two that were missed are the two that mattered.
 */
export async function readRecordedSse({ url, request, timeoutMs, label, startedAt, onFrame }) {
  let res = null;
  let rawStream = '';
  let failure = null;
  let recorded = false;
  const record = () => {
    if (recorded) return;
    recorded = true;
    recordExchange({
      kind: 'sse',
      label,
      url,
      requestHeaders: request.headers,
      requestBody: request.body,
      // Null when the request never reached a response at all. A reset
      // connection used to leave no trace whatever, which reads afterwards as a
      // call that was never made rather than one the vendor dropped.
      status: res?.status ?? null,
      statusText: res?.statusText ?? null,
      responseHeaders: res?.headers ?? null,
      // For a refusal this is the error body rather than a wire of events. It is
      // still what the response was, which is what a reader needs.
      streamBytes: rawStream,
      durationMs: performance.now() - startedAt,
      error: failure,
    });
  };

  try {
    res = await fetch(url, {
      method: 'POST',
      headers: request.headers,
      body: request.body,
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!res.ok) {
      rawStream = await res.text();
      failure = `${url} ${res.status}`;
      throw new SseTransportError(`${url} ${res.status}: ${truncate(rawStream)}`, res.status);
    }
    if (!res.body) {
      failure = `${url} did not return a readable stream`;
      throw new SseTransportError(failure, res.status);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const read = await reader.read();
      if (read.done) break;
      const decoded = decoder.decode(read.value, { stream: true });
      rawStream += decoded;
      buffer += decoded;
      let index;
      while ((index = buffer.indexOf('\n\n')) !== -1) {
        onFrame(buffer.slice(0, index));
        buffer = buffer.slice(index + 2);
      }
    }
    buffer += decoder.decode();
    const finalFrame = buffer.trim();
    if (finalFrame) onFrame(finalFrame);
  } catch (error) {
    if (failure === null) failure = String(error?.message ?? error);
    throw error;
  } finally {
    record();
  }

  return { status: res.status, rawStream };
}
