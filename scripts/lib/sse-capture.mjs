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

/**
 * Enough of a body to read in an error message, without carrying the whole turn.
 * The limit and the ellipsis are the runner's own, so a message this throws reads
 * the same as one from the buffered path beside it — an extraction that quietly
 * shortened a diagnostic would be a behaviour change wearing a refactor's name.
 */
const truncate = (text, limit = 2000) => (text.length > limit ? `${text.slice(0, limit)}...` : text);

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
export async function readRecordedSse({
  url, request, timeoutMs, label, startedAt, onFrame,
  // Whether a non-2xx is a FAILURE or an ANSWER. The benchmark runner asks for a
  // completion and a 4xx means it did not get one; the direct-API prober asks
  // what the vendor says to a bad request and a 4xx is the whole point of the
  // call. Recording a prober's answer as a failed exchange makes a run's failure
  // count a lie, and the two callers cannot both be right about one default.
  refusalIsFailure = true,
} = {}) {
  let res = null;
  let rawStream = '';
  let failure = null;
  let recorded = false;
  // One decoder for whichever branch reads a body, so the flush below can reach
  // what it is still holding. `decode(chunk, {stream: true})` returns nothing
  // for the first byte of a multi-byte character and waits for the rest; a
  // stream cut there used to record the empty string, which reads afterwards as
  // a turn where nothing arrived rather than one cut mid-character.
  const decoder = new TextDecoder();
  const record = () => {
    if (recorded) return;
    recorded = true;
    // Whatever the decoder is still holding, as the replacement character it is.
    // A second call returns '' , so the good path — which has already flushed —
    // is unaffected. The exact bytes would need a record that can carry binary,
    // which every promoted fixture's shape depends on: see
    // docs/design-task-capture-records-decoded-text.md.
    rawStream += decoder.decode();
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
      if (refusalIsFailure) failure = `${url} ${res.status}`;
      // Read the refusal the way a good stream is read, chunk by chunk into
      // `rawStream`. `res.text()` resolves only when the whole body has arrived,
      // so a refusal whose connection drops mid-body recorded an empty string —
      // the same evidence loss this file exists to remove, surviving on the
      // other side of the branch.
      if (res.body) {
        const reader = res.body.getReader();
        try {
          while (true) {
            const read = await reader.read();
            if (read.done) break;
            rawStream += decoder.decode(read.value, { stream: true });
          }
          rawStream += decoder.decode();
        } catch (error) {
          // Interrupted is a failure whatever the status was: the caller asked a
          // question and did not get the whole answer.
          failure = `${url} ${res.status}, body interrupted: ${String(error?.message ?? error)}`;
          throw error;
        } finally {
          await reader.cancel().catch(() => {});
        }
      }
      // An answer is returned, not thrown. A caller that asked for one would
      // otherwise have to reconstruct it from an exception.
      if (!refusalIsFailure) return { status: res.status, rawStream };
      throw new SseTransportError(`${url} ${res.status}: ${truncate(rawStream)}`, res.status);
    }
    if (!res.body) {
      // Same question as the refusal above, same answer: a caller asking what
      // the vendor does with a bad request is told 204-and-nothing, while a
      // caller that asked for a completion did not get one.
      if (!refusalIsFailure) return { status: res.status, rawStream };
      failure = `${url} did not return a readable stream`;
      throw new SseTransportError(failure, res.status);
    }

    const reader = res.body.getReader();
    // Released on every exit that is not the stream ending on its own. A caller
    // whose `onFrame` throws used to leave the request live until an unrelated
    // timeout fired — the exception reached the caller at once while the socket
    // stayed open for minutes, so a run's timings and the vendor's view of it
    // disagreed about when the call ended.
    let drained = false;
    try {
      let buffer = '';
      while (true) {
        const read = await reader.read();
        if (read.done) { drained = true; break; }
        const decoded = decoder.decode(read.value, { stream: true });
        rawStream += decoded;
        buffer += decoded;
        let index;
        while ((index = buffer.indexOf('\n\n')) !== -1) {
          onFrame(buffer.slice(0, index));
          buffer = buffer.slice(index + 2);
        }
      }
      // The flush goes to both: `buffer` so a final frame is handed on, and
      // `rawStream` because that is what the record and the terminator gate read.
      // It used to reach only `buffer`, so a good stream ending mid-character was
      // recorded a byte short of what the frame callback had already seen.
      const tail = decoder.decode();
      rawStream += tail;
      buffer += tail;
      const finalFrame = buffer.trim();
      if (finalFrame) onFrame(finalFrame);
    } finally {
      if (!drained) await reader.cancel().catch(() => {});
    }
  } catch (error) {
    if (failure === null) {
      // Labelled where there is something to label it with. A bare `terminated`
      // in a record says a stream stopped and not which turn it was, and the
      // status is the half a reader cannot recover from the bytes.
      const said = String(error?.message ?? error);
      failure = res ? `${url} ${res.status}, stream interrupted: ${said}` : said;
    }
    throw error;
  } finally {
    record();
  }

  return { status: res.status, rawStream };
}
