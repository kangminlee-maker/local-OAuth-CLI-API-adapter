// The A/A noise floor: how much a vendor varies against ITSELF.
//
// The comparison this repository runs is direct-vs-proxy, and the length axis of
// it was never usable as a verdict because nobody had measured what the vendor
// does when asked the same thing twice. A 2026-08-28 control took three samples
// per row — enough to notice the variance exists, not enough to bound it — and
// `docs/conformance-suite-design.md` has said since that the gate stays off
// until "A/A 증거가 그 대역을 분해할 수 있음을 보인 뒤".
//
// This is the sampler, with the vendor URL as a parameter, because the file that
// hardcodes the vendors cannot be run in a test without spending real calls.
// That separation is the one round 3 of the PR #28 review forced after a checker
// that read a transcription instead of the shipped code reported PASS on an
// implementation that made no HTTP request at all.
import { recordExchange } from './capture-recorder.mjs';

/**
 * What the design says to count: visible characters.
 *
 * Whitespace runs collapse and the ends are trimmed, so a model that indents its
 * bullets differently between two runs does not read as having said more. The
 * output-token count is measured SEPARATELY and never mixed into this one — they
 * answer different questions and the design is explicit that they are reported
 * apart.
 */
export function visibleChars(text) {
  return text.replace(/\s+/g, ' ').trim().length;
}

/** Mean, spread and a 95% interval for one row's samples. */
export function summarise(lens) {
  const n = lens.length;
  if (n === 0) return { n: 0, mean: null, sd: null, cvPct: null, ciHalfWidth: null, min: null, max: null, spreadPct: null };
  const mean = lens.reduce((total, value) => total + value, 0) / n;
  // Sample standard deviation: with n-1 this is an estimate of the vendor's
  // spread, not of these particular draws. n=1 has none, and saying 0 would
  // read as "no variance" rather than "not measured".
  const sd = n > 1
    ? Math.sqrt(lens.reduce((total, value) => total + (value - mean) ** 2, 0) / (n - 1))
    : null;
  const min = Math.min(...lens);
  const max = Math.max(...lens);
  return {
    n,
    mean: Number(mean.toFixed(1)),
    sd: sd === null ? null : Number(sd.toFixed(1)),
    cvPct: sd === null || mean === 0 ? null : Number(((sd / mean) * 100).toFixed(1)),
    // Half-width of a 95% interval for the MEAN, which is what "the interval is
    // decisive" is about — not the spread of individual answers.
    ciHalfWidth: sd === null ? null : Number(((1.96 * sd) / Math.sqrt(n)).toFixed(1)),
    min,
    max,
    spreadPct: mean === 0 ? null : Number((((max - min) / mean) * 100).toFixed(1)),
  };
}

/**
 * The series a row records, and where each one lives on the row.
 *
 * Three, not one. Visible characters are what a reader sees; output tokens are
 * what the bill is drawn on; thinking tokens are the part of that bill nobody
 * reads. They are kept apart because they answer different questions, and the
 * first run of this instrument proved they also MOVE differently: a row whose
 * characters held to 4.4% varied its billed tokens by 43.7%, because the vendor
 * thought on nine samples of twelve and not on the other three.
 */
export const SERIES = [
  ['chars', 'lens'],
  ['outputTokens', 'tokens'],
  ['thinking', 'thinking'],
];

/**
 * The floor, per series, over the rows of a finished run.
 *
 * A row whose `cvPct` is null is NOT measured — n < 2, or every sample was zero
 * so there is no proportion to take. It is counted as unmeasured and left out of
 * the max and the median. The first version of this read `cvPct ?? 0`, which
 * fed a null into `Math.max` as a zero and into the median as the lowest value
 * there is: a row nobody could measure made the floor look tighter than the
 * measured rows alone say it is. A missing reading is not a small reading.
 */
export function noiseFloor(rows) {
  const floor = {
    rowsTotal: rows.length,
    rowsDeadLettered: rows.filter((row) => row.deadLettered).length,
    rowsSettled: rows.filter((row) => row.settled).length,
    series: {},
  };
  for (const [name, field] of SERIES) {
    const readings = rows
      .map((row) => ({ row, reading: summarise(row[field] ?? []) }))
      .filter(({ reading }) => reading.n >= 2);
    const measured = readings.filter(({ reading }) => reading.cvPct !== null);
    const cvs = measured.map(({ reading }) => reading.cvPct).sort((a, b) => a - b);
    const worst = measured.reduce(
      (best, entry) => (best === null || entry.reading.cvPct > best.reading.cvPct ? entry : best),
      null,
    );
    floor.series[name] = {
      rowsMeasured: measured.length,
      // Named, not just counted: a series with no proportion to take is a fact
      // about the vendor (it never thought on this task), and a reader who sees
      // only a count cannot tell which fact it is.
      rowsUnmeasured: readings
        .filter(({ reading }) => reading.cvPct === null)
        .map(({ row }) => `${row.provider}/${row.task}`),
      worstCvPct: cvs.length ? cvs[cvs.length - 1] : null,
      worstRow: worst ? `${worst.row.provider}/${worst.row.task}` : null,
      medianCvPct: cvs.length ? cvs[Math.floor(cvs.length / 2)] : null,
      worstSpreadPct: measured.length
        ? Math.max(...measured.map(({ reading }) => reading.spreadPct ?? 0))
        : null,
    };
  }
  return floor;
}

/** A failure that should stop the whole run rather than just this row. */
export class SamplingAbort extends Error {
  constructor(message) {
    super(message);
    this.name = 'SamplingAbort';
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Sample one row until it is decided, without ever hammering a live endpoint.
 *
 * `take(index)` performs ONE call and returns `{chars, outputTokens, latencyMs}`
 * or throws. A thrown error carrying `retryable: true` is backed off and retried
 * in place; anything else counts against the row immediately.
 *
 * Three limits, all of them real:
 *   - `maxConsecutiveFailures` ends THIS row and dead-letters it.
 *   - `budget.remaining` ends the whole run — a shared counter across rows, so a
 *     resumed run cannot spend the batch twice. It is checked before EVERY call
 *     including a retry, and its exhaustion is a `SamplingAbort` that passes
 *     through the row's own failure handling rather than counting as one.
 *   - `decisiveWhen(reading)` stops early once the mean's interval is tight
 *     enough, which is the design's own sequential rule: start at 24, cap at
 *     60, stop when the interval decides.
 *
 * `onSpend({index, attempt, spent})` is called after a call is booked and
 * BEFORE it is made, so a caller persisting the ledger cannot lose a call it
 * has already paid for.
 *
 * `existing` resumes a row from whole SAMPLES, not from character lengths. A
 * bare-length state is refused: it cannot say what the token or thinking
 * readings for those calls were, and a floor taken over a partly-restored
 * series is not the floor.
 */
export async function sampleRow({
  reps,
  take,
  minReps = 24,
  // Decided as a QUESTION about the reading, not a number of characters. Rows
  // here run from ~350 to ~1100 characters, so one absolute half-width would
  // stop the short rows far too early and never stop the long ones.
  decisiveWhen = null,
  maxConsecutiveFailures = 3,
  maxRetries = 4,
  backoffMs = 2000,
  backoffCapMs = 60_000,
  budget = null,
  onSample = () => {},
  onSpend = () => {},
  sleepFor = sleep,
  // Injected so a case can assert the GROWTH rather than the growth plus a
  // random number: with jitter in the way, "the second wait is longer" is true
  // about half the time on its own, and a control that removed the growth
  // survived because the test was flipping a coin.
  jitterFor = () => Math.floor(Math.random() * 250),
  existing = [],
}) {
  // Whole SAMPLES, not a length. A resumed row used to carry `lens` alone and
  // start every other series empty, so a run that stopped and continued
  // reported five character readings beside two token readings as if both were
  // complete — and the floor is taken over the token series. One record per
  // sample makes that unrepresentable: the series are derived from it at the
  // end, never accumulated in parallel.
  const samples = existing.map((entry) => {
    if (typeof entry === 'number' || entry === null || typeof entry !== 'object') {
      throw new SamplingAbort('resume state holds bare lengths, not samples: it cannot say what the '
        + 'token or thinking readings for those calls were, and a floor taken over a partly-restored '
        + 'series is not the floor. Re-run the row, or re-record the state with whole samples.');
    }
    return entry;
  });
  const lensOf = () => samples.map((sample) => sample.chars);
  const failures = [];
  let consecutive = 0;

  for (let index = samples.length; index < reps; index += 1) {
    let attempt = 0;
    let done = false;
    while (!done) {
      try {
        // Inside the retry loop, because a retry is a CALL. The check used to
        // sit outside it and the decrement inside, so a row that began its last
        // permitted call and hit a 429 spent up to `maxRetries` more — five
        // metered calls against a ceiling of one.
        if (budget && budget.remaining <= 0) {
          throw new SamplingAbort(`the run's call budget is spent (${budget.spent} used)`);
        }
        if (budget) { budget.remaining -= 1; budget.spent += 1; }
        // Booked BEFORE the call, and the caller is told before the call too.
        // `budget.spent` used to reach disk only when a sample arrived, and a
        // retry leaves no sample: three consecutive indices at four retries
        // each put fifteen live calls on the vendor's meter and none in the
        // ledger, so an interrupt during a backoff re-granted every one of them
        // on resume. Persisting first can over-book by at most one — the safe
        // direction for a ceiling on spending.
        await onSpend({ index, attempt, spent: budget?.spent ?? null });
        const sample = await take(index);
        samples.push({
          chars: sample.chars,
          outputTokens: sample.outputTokens,
          thinkingTokens: sample.thinkingTokens,
          latencyMs: sample.latencyMs,
        });
        consecutive = 0;
        done = true;
        onSample({ index, ...sample, samples: [...samples], lens: lensOf() });
      } catch (error) {
        // An exhausted budget ends the RUN. Booking it as this row's failure
        // would let the next row start, and the three-failures rule would read
        // "we ran out of money" as "this row is broken".
        if (error instanceof SamplingAbort) throw error;
        const retryable = error?.retryable === true && attempt < maxRetries;
        failures.push({ index, attempt, retryable, said: String(error?.message ?? error) });
        if (!retryable) {
          consecutive += 1;
          done = true;
          if (consecutive >= maxConsecutiveFailures) {
            return outcomeOf(samples, { failures, deadLettered: true });
          }
        } else {
          attempt += 1;
          // Exponential with a cap, and jitter so a batch does not resynchronise
          // onto the same retry instant after a shared rate limit.
          const wait = Math.min(backoffCapMs, backoffMs * 2 ** (attempt - 1));
          await sleepFor(wait + jitterFor());
        }
      }
    }

    const reading = summarise(lensOf());
    if (decisiveWhen !== null
        && samples.length >= minReps
        && reading.ciHalfWidth !== null
        && decisiveWhen(reading)) {
      return outcomeOf(samples, { failures, deadLettered: false, stoppedEarly: true });
    }
  }

  // A row that collected nothing is lost however it got there. Reaching the end
  // of the loop without three failures in a row — a single rep that exhausted
  // its retries, say — used to return `deadLettered: false` with `n: 0`, which
  // is a hole a summary has to be read carefully to notice.
  return outcomeOf(samples, {
    failures,
    deadLettered: samples.length === 0,
    stoppedEarly: false,
  });
}

/**
 * The four series a run publishes, derived from the samples that produced them.
 *
 * A series drops a sample only where that sample carries no such measurement —
 * a turn whose answer arrived with no usage block has a character count and no
 * token count — so a series can legitimately be shorter than `samples`. What it
 * can no longer be is shorter because the row was RESUMED, which is the whole
 * reason the samples are kept whole. `samples` is returned beside them so the
 * pairing is recoverable from the artifact.
 */
export function seriesOf(samples) {
  const series = (key) => samples.map((sample) => sample[key]).filter((value) => typeof value === 'number');
  return {
    samples: [...samples],
    lens: series('chars'),
    tokens: series('outputTokens'),
    thinking: series('thinkingTokens'),
    latencies: series('latencyMs'),
  };
}

/**
 * A row's outcome, assembled in ONE place.
 *
 * `sampleRow` returns this three times and the caller has to build it a fourth,
 * when the budget aborts mid-row: those samples are paid for and reach the state
 * file through `onSample`, but the caller used to `break` without recording
 * them, so they never reached the artifact — and the artifact is what `--report`
 * re-derives the published floor from. A partly-sampled row that is missing
 * from `rows` is a paid observation the floor is not taken over.
 */
export function outcomeOf(samples, extra = {}) {
  return { ...seriesOf(samples), ...summarise(samples.map((sample) => sample.chars)), ...extra };
}

/**
 * The row a budget abort leaves behind, or null when the row collected nothing.
 *
 * The caller used to `break` out of the loop without recording anything, so the
 * samples an aborted row had already paid for reached the state file and never
 * reached the artifact. `--report` re-derives the published floor from
 * `artifact.rows`, so those calls were bought and then not counted.
 */
export function abortedRow(row, samples) {
  if (!samples || samples.length === 0) return null;
  return {
    ...row,
    prompt: undefined,
    ...outcomeOf(samples, { failures: null, deadLettered: false, stoppedEarly: false, abortedMidRow: true }),
    settled: false,
  };
}

/**
 * The artifact name a run writes when `--out` is not given.
 *
 * `--only` is in it because `--only` is how a batch is partitioned across
 * processes: with the date alone, two partitions of one batch wrote the same
 * file and the second erased the first — the same failure the state lock exists
 * to prevent, one file along, and made likelier by that lock, which leaves
 * separate ledgers as the only way to partition.
 */
/**
 * Where a run's paid observations land while it is still running.
 *
 * A ledger is a consequence of SPENDING, not of a flag. `--live` and `--resume`
 * were independent, so the shortest way to run a partition — `--live --only x`,
 * no `--resume` — had exactly one sink for a paid observation and wrote it once,
 * after the last row. A review interrupted that run at its fifth call and
 * measured what was on disk: with a ledger, four of four paid observations
 * survive; without one, zero, and the default batch prices at hundreds of calls
 * per partition. The SIGINT handler released the lock and saved nothing, because
 * there was nothing to save into.
 *
 * Beside the artifact, so it inherits the name that already carries `--only` and
 * cannot collide across partitions.
 */
export function ledgerFor({ resume = null, live = false, outPath = null } = {}) {
  if (resume) return resume;
  if (!live || !outPath) return null;
  return `${outPath}.state.json`;
}

export function defaultArtifactName(date, only) {
  const day = date.toISOString().slice(0, 10).replace(/-/g, '');
  return `aa-noise-floor-${day}${only ? `-${only.replace(/[^a-zA-Z0-9]+/g, '-')}` : ''}.json`;
}

/**
 * One recorded call to a chat-shaped endpoint.
 *
 * The exchange is recorded whatever happens, by the same recorder the capture
 * store uses: a noise floor whose samples cannot be re-read is a number with no
 * evidence under it.
 */
export async function takeSample({ url, headers, body, label, timeoutMs, readAnswer }) {
  const startedAt = performance.now();
  let res = null;
  let text = '';
  let read = false;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    text = await res.text();
    read = true;
  } catch (error) {
    recordExchange({
      kind: 'json', label, url, requestHeaders: headers, requestBody: body,
      status: res?.status ?? null, statusText: res?.statusText ?? null,
      responseHeaders: res?.headers ?? null,
      durationMs: performance.now() - startedAt, error,
    });
    const failure = new Error(`${url}: ${String(error?.message ?? error)}`);
    // A timeout or a reset is worth another try; a malformed request is not.
    failure.retryable = true;
    throw failure;
  }

  recordExchange({
    kind: 'json', label, url, requestHeaders: headers, requestBody: body,
    status: res.status, statusText: res.statusText, responseHeaders: res.headers,
    responseBody: read ? text : undefined,
    durationMs: performance.now() - startedAt,
    error: res.ok ? null : `${url} ${res.status}`,
  });

  if (!res.ok) {
    const failure = new Error(`${url} ${res.status}: ${text.slice(0, 400)}`);
    // 429 and 5xx are the vendor asking to be asked again. A 4xx that is not 429
    // is this run being wrong about something, and retrying it is a retry storm
    // with extra steps.
    failure.retryable = res.status === 429 || res.status >= 500;
    failure.status = res.status;
    throw failure;
  }

  const answer = readAnswer(JSON.parse(text));
  if (typeof answer?.text !== 'string' || answer.text === '') {
    const failure = new Error(`${url} ${res.status}: no answer text to measure`);
    failure.retryable = false;
    throw failure;
  }
  return {
    chars: visibleChars(answer.text),
    outputTokens: answer.outputTokens ?? null,
    // Billed as output and never seen in the answer. A model that thinks before
    // it writes varies in two places, and a floor that folded them together
    // would attribute reasoning length to the text it measures.
    thinkingTokens: answer.thinkingTokens ?? null,
    latencyMs: Math.round(performance.now() - startedAt),
    status: res.status,
  };
}

/**
 * What a saved state says about resuming a run: what it already spent, and
 * which of its rows cannot be resumed at all.
 *
 * Both were decided inline in the runner, where nothing could reach them. A
 * review reproduced the consequence by extracting the orchestration loop
 * verbatim: the budget was rebuilt at full size on every invocation, so a run
 * resumed twice against a ceiling of two spent four calls while each invocation
 * truthfully reported spending its share. `sampleRow` guarding a budget OBJECT
 * says nothing about who builds that object.
 *
 * `legacy` names rows recorded before whole samples were kept. Those carry
 * character lengths and nothing else, and the runner used to read them as an
 * ABSENT row — starting over and overwriting paid observations it could not
 * read. Refusing is the smaller loss.
 */
export function resumePlan(state, budgetTotal) {
  const rows = state?.rows ?? {};
  const spent = Number.isFinite(state?.spent) ? state.spent : 0;
  return {
    spent,
    remaining: budgetTotal - spent,
    exhausted: budgetTotal - spent <= 0,
    legacy: Object.entries(rows)
      .filter(([, row]) => !Array.isArray(row?.samples))
      .map(([key]) => key)
      .sort(),
  };
}
