// The A/A sampler, driven the way the noise-floor run drives it.
//
// The file that hardcodes the vendor URLs cannot be run here — it spends real
// metered calls — so the sampler takes its URL as a parameter and these cases
// call the shipped function against a local server. That split is what the PR
// #28 review forced after a checker built to verify an un-runnable script
// reported PASS on an implementation that made no HTTP request at all.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { startCaptureRun } from '../scripts/lib/capture-recorder.mjs';
import { abortedRow, defaultArtifactName, noiseFloor, resumePlan, sampleRow, SamplingAbort, SERIES, summarise, takeSample, visibleChars } from '../scripts/lib/aa-sampler.mjs';

const servers = [];
after(async () => {
  for (const server of servers) await new Promise((resolve) => server.close(resolve));
});

async function serving(handler) {
  const seen = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      seen.push({ method: req.method, path: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
      handler(req, res, seen.length);
    });
  });
  servers.push(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, seen };
}

function capturing() {
  const dir = mkdtempSync(join(tmpdir(), 'aa-sampler-'));
  const run = startCaptureRun({ dir, meta: { probe: 'aa-sampler.test' } });
  return {
    records: () => readdirSync(run.runDir)
      .filter((name) => name !== 'run.json')
      .sort()
      .map((name) => JSON.parse(readFileSync(join(run.runDir, name), 'utf8'))),
  };
}

const headers = { 'content-type': 'application/json', 'x-aa-marker': 'noise-floor' };
const body = '{"prompt":"same every time"}';
const readAnswer = (parsed) => ({ text: parsed.text, outputTokens: parsed.tokens });
const sample = (url) => takeSample({ url, headers, body, label: 'aa', timeoutMs: 5000, readAnswer });

test('visible characters ignore how an answer is laid out', () => {
  // Two runs that differ only in indentation are not two different lengths, and
  // counting them as such would put whitespace into a vendor's variance.
  assert.equal(visibleChars('- one\n- two'), visibleChars('  -   one \n\n  -  two  '));
  assert.equal(visibleChars('  padded  '), 6);
  assert.equal(visibleChars(''), 0);
});

test('one sample is measured and recorded, with what the server received', async () => {
  const { url, seen } = await serving((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ text: 'alpha beta', tokens: 7 }));
  });
  const run = capturing();

  const got = await sample(url);
  assert.equal(got.chars, 10);
  assert.equal(got.outputTokens, 7);
  assert.equal(got.status, 200);
  assert.ok(got.latencyMs >= 0);

  assert.equal(seen.length, 1);
  assert.equal(seen[0].body, body, 'the sampler sent a body other than the one asked for');
  assert.equal(seen[0].headers['x-aa-marker'], 'noise-floor');

  const records = run.records();
  assert.equal(records.length, 1, `recorded ${records.length} exchanges for one sample`);
  assert.equal(records[0].status, 200);
  assert.equal(records[0].request.text, seen[0].body);
  assert.equal(records[0].error, null);
});

test('a refusal is recorded, and retried only when the vendor asked to be', async () => {
  const { url } = await serving((req, res) => {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end('{"error":"bad request"}');
  });
  const run = capturing();

  await assert.rejects(() => sample(url), (error) => {
    assert.equal(error.status, 400);
    // The whole point of the flag: a 400 is this run being wrong, and retrying
    // it is a retry storm with extra steps.
    assert.equal(error.retryable, false);
    return true;
  });
  const [record] = run.records();
  assert.equal(record.status, 400);
  assert.equal(record.response.text, '{"error":"bad request"}');
  assert.match(record.error, /400/);
});

test('a rate limit is retryable and a server error is too', async () => {
  for (const [status, expected] of [[429, true], [503, true], [404, false]]) {
    const { url } = await serving((req, res) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end('{}');
    });
    capturing();
    await assert.rejects(() => sample(url), (error) => {
      assert.equal(error.retryable, expected, `${status} retryable should be ${expected}`);
      return true;
    });
  }
});

test('an answer with no text is a failure, not a zero-length sample', async () => {
  // A row that quietly counted an empty answer as 0 characters would drag the
  // mean toward zero and read as the vendor having become terse.
  const { url } = await serving((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ text: '', tokens: 0 }));
  });
  capturing();
  await assert.rejects(() => sample(url), (error) => {
    assert.match(error.message, /no answer text/);
    assert.equal(error.retryable, false);
    return true;
  });
});

test('a summary of one sample reports no spread rather than none', () => {
  // `sd: 0` would read as "this vendor does not vary", which is the opposite of
  // what one draw establishes.
  const one = summarise([100]);
  assert.equal(one.n, 1);
  assert.equal(one.sd, null);
  assert.equal(one.cvPct, null);
  assert.equal(one.ciHalfWidth, null);

  const many = summarise([90, 100, 110]);
  assert.equal(many.n, 3);
  assert.equal(many.mean, 100);
  assert.equal(many.sd, 10);
  assert.equal(many.cvPct, 10);
  assert.equal(many.min, 90);
  assert.equal(many.max, 110);
  assert.equal(many.spreadPct, 20);
});

test('a row stops early only once its interval is tight enough', async () => {
  const taken = [];
  const row = await sampleRow({
    reps: 40,
    minReps: 12,
    decisiveWhen: (reading) => reading.ciHalfWidth <= 1,
    take: async (index) => { taken.push(index); return { chars: 100, outputTokens: 1, latencyMs: 1 }; },
  });
  // Identical answers have zero spread, so the interval is decisive at exactly
  // the floor and not before it.
  assert.equal(row.stoppedEarly, true);
  assert.equal(row.n, 12);
  assert.equal(taken.length, 12);
});

test('the stopping rule is asked about the reading, not about a character count', async () => {
  // Rows here run from ~350 to ~1100 characters. One absolute half-width would
  // stop the short rows long before their spread was known and never stop the
  // long ones, so the predicate gets the whole reading and decides in the units
  // that row is in.
  const seen = [];
  const row = await sampleRow({
    reps: 30,
    minReps: 4,
    decisiveWhen: (reading) => { seen.push(reading); return (reading.ciHalfWidth / reading.mean) * 100 <= 5; },
    take: async () => ({ chars: 1000 + Math.round(Math.sin(seen.length) * 20), outputTokens: 1, latencyMs: 1 }),
  });
  assert.equal(row.stoppedEarly, true);
  assert.ok(row.n >= 4 && row.n < 30, `stopped at ${row.n}`);
  assert.ok(seen.every((reading) => reading.mean > 0 && reading.ciHalfWidth !== null),
    'the predicate was handed a reading it could not decide on');

  // And a predicate that says no is obeyed: without this the case passes on a
  // sampler that stops at the floor and never asks.
  const refused = await sampleRow({
    reps: 9,
    minReps: 2,
    decisiveWhen: () => false,
    take: async () => ({ chars: 1000, outputTokens: 1, latencyMs: 1 }),
  });
  assert.equal(refused.stoppedEarly, false, 'a row stopped early against its own predicate');
  assert.equal(refused.n, 9);
});

test('a row that never settles takes its full budget and no more', async () => {
  let index = 0;
  const row = await sampleRow({
    reps: 20,
    minReps: 5,
    decisiveWhen: (reading) => reading.ciHalfWidth <= 0.001,
    take: async () => ({ chars: index++ % 2 === 0 ? 50 : 500, outputTokens: 1, latencyMs: 1 }),
  });
  assert.equal(row.stoppedEarly, false);
  assert.equal(row.n, 20);
  assert.ok(row.cvPct > 50, `a row swinging 50↔500 reported cv ${row.cvPct}%`);
});

test('three consecutive failures dead-letter the row instead of hammering it', async () => {
  let calls = 0;
  const row = await sampleRow({
    reps: 24,
    take: async () => { calls += 1; throw new Error('vendor said no'); },
    sleepFor: async () => {},
  });
  assert.equal(row.deadLettered, true);
  assert.equal(calls, 3, `kept calling after the row was lost: ${calls} calls`);
  assert.equal(row.n, 0);
  assert.equal(row.failures.length, 3);
});

test('a retryable failure backs off and is retried in place', async () => {
  const waits = [];
  let attempts = 0;
  const row = await sampleRow({
    reps: 1,
    take: async () => {
      attempts += 1;
      if (attempts < 3) {
        const error = new Error('rate limited');
        error.retryable = true;
        throw error;
      }
      return { chars: 42, outputTokens: 1, latencyMs: 1 };
    },
    sleepFor: async (ms) => { waits.push(ms); },
    jitterFor: () => 0,
    backoffMs: 100,
  });
  assert.equal(row.n, 1);
  assert.deepEqual(row.lens, [42]);
  // Exact, with the jitter pinned to zero: "the second wait was bigger" is true
  // half the time by chance when a random number is still in there.
  assert.deepEqual(waits, [100, 200], `backoff did not double: ${waits}`);
});

test('a call that never reached a response is recorded, and worth retrying', async () => {
  // The other failure point in `takeSample`: `fetch` itself throws, so there is
  // no status and no body to read. Recording nothing here leaves the number with
  // no evidence under it for exactly the calls that explain a gap in it.
  const { url } = await serving((req, res) => { res.socket.destroy(); });
  const run = capturing();

  await assert.rejects(() => sample(url), (error) => {
    assert.equal(error.retryable, true, 'a dropped connection was not worth retrying');
    return true;
  });

  const records = run.records();
  assert.equal(records.length, 1, `recorded ${records.length} exchanges for one dropped call`);
  assert.equal(records[0].status, null);
  assert.equal(records[0].request.text, body);
  assert.ok(records[0].error, 'a dropped connection recorded no error');
});

test('a retryable failure gives up rather than retrying forever', async () => {
  let attempts = 0;
  const row = await sampleRow({
    reps: 1,
    maxRetries: 2,
    take: async () => {
      attempts += 1;
      const error = new Error('rate limited');
      error.retryable = true;
      throw error;
    },
    sleepFor: async () => {},
  });
  // One attempt plus two retries, and then it stops: the alternative is a run
  // that never ends against an endpoint that is always rate limited.
  assert.equal(attempts, 3);
  // Nothing was collected, so the row is lost — however it got there.
  assert.equal(row.deadLettered, true);
  assert.equal(row.n, 0);
});

test('the shared budget ends the run rather than the row', async () => {
  const budget = { remaining: 4, spent: 0 };
  await assert.rejects(
    () => sampleRow({ reps: 10, take: async () => ({ chars: 1, outputTokens: 1, latencyMs: 1 }), budget }),
    (error) => {
      assert.ok(error instanceof SamplingAbort, `threw ${error?.name}`);
      assert.match(error.message, /budget is spent/);
      return true;
    },
  );
  assert.equal(budget.spent, 4, 'the budget was overspent before it stopped');
});

test('a resumed row keeps what it already has and asks only for the rest', async () => {
  const taken = [];
  const row = await sampleRow({
    reps: 5,
    existing: [10, 20, 30].map((chars) => ({ chars, outputTokens: chars, thinkingTokens: chars, latencyMs: chars })),
    take: async (index) => {
      taken.push(index);
      return { chars: 40, outputTokens: 41, thinkingTokens: 42, latencyMs: 43 };
    },
  });
  assert.deepEqual(row.lens, [10, 20, 30, 40, 40]);
  assert.deepEqual(taken, [3, 4], 'a resumed run re-spent calls it had already made');
  // Every series, not just the one the state file used to hold. A resumed row
  // that returns five character readings beside two token readings reports both
  // as complete, and the floor is taken over the token series.
  assert.deepEqual(row.tokens, [10, 20, 30, 41, 41], 'the token series was not restored');
  assert.deepEqual(row.thinking, [10, 20, 30, 42, 42], 'the thinking series was not restored');
  assert.deepEqual(row.latencies, [10, 20, 30, 43, 43], 'the latency series was not restored');
  assert.equal(row.samples.length, 5);
});

test('a resume state holding bare lengths is refused, not half-restored', async () => {
  await assert.rejects(
    () => sampleRow({ reps: 5, existing: [10, 20, 30], take: async () => ({ chars: 1, outputTokens: 1, latencyMs: 1 }) }),
    (error) => {
      assert.ok(error instanceof SamplingAbort, `threw ${error?.name}`);
      assert.match(error.message, /bare lengths/);
      return true;
    },
  );
});

test('a retry cannot spend past the shared budget', async () => {
  const budget = { remaining: 1, spent: 0 };
  let calls = 0;
  await assert.rejects(
    () => sampleRow({
      reps: 1,
      budget,
      maxRetries: 4,
      sleepFor: async () => {},
      take: async () => {
        calls += 1;
        const error = new Error('429 slow down');
        error.retryable = true;
        throw error;
      },
    }),
    (error) => {
      assert.ok(error instanceof SamplingAbort, `threw ${error?.name}`);
      assert.match(error.message, /budget is spent/);
      return true;
    },
  );
  // One call is what a ceiling of one authorises. The check used to sit outside
  // the retry loop while the decrement sat inside it, so this construction made
  // five metered calls and returned normally.
  assert.equal(calls, 1, `the budget authorised 1 call and ${calls} were made`);
  assert.equal(budget.spent, 1);
  assert.ok(budget.remaining >= 0, `the budget went to ${budget.remaining}`);
});

test('a retry inside the budget still happens', async () => {
  const budget = { remaining: 4, spent: 0 };
  let calls = 0;
  const row = await sampleRow({
    reps: 1,
    budget,
    sleepFor: async () => {},
    take: async () => {
      calls += 1;
      if (calls === 1) {
        const error = new Error('429 slow down');
        error.retryable = true;
        throw error;
      }
      return { chars: 10, outputTokens: 2, thinkingTokens: 1, latencyMs: 3 };
    },
  });
  assert.equal(calls, 2, 'the retry did not happen');
  assert.deepEqual(row.lens, [10]);
  assert.equal(budget.spent, 2, 'a retry is a call and must be booked as one');
});

// --- the floor over a finished run -----------------------------------------

/** A row shaped the way the runner writes one, with only the fields the floor reads. */
const finished = (provider, task, lens, tokens, thinking, extra = {}) => ({
  provider, task, lens, tokens, thinking, settled: false, deadLettered: false, ...extra,
});

test('the floor covers every series a row records, not just the visible one', () => {
  const floor = noiseFloor([
    // Characters barely move; the billed tokens move a lot, because the vendor
    // thought on two samples of four and not on the other two. This is the
    // shape the first live run actually produced.
    finished('openai', 'a', [400, 402, 398, 400], [300, 70, 310, 72], [200, 0, 210, 0]),
  ]);
  assert.deepEqual(Object.keys(floor.series), SERIES.map(([name]) => name));
  assert.ok(floor.series.chars.worstCvPct < 1, `chars read ${floor.series.chars.worstCvPct}`);
  assert.ok(
    floor.series.outputTokens.worstCvPct > 50,
    `the billed series read ${floor.series.outputTokens.worstCvPct}, so a cost difference `
      + 'that is inside the noise would clear the published floor',
  );
});

test('a row with no proportion to take is unmeasured BY NAME, not a zero', () => {
  const floor = noiseFloor([
    finished('openai', 'thinks', [100, 120], [50, 60], [40, 10]),
    // Never thought. There is no proportion to take, and reading that as 0%
    // makes the whole series look tighter than the rows that WERE measured say.
    finished('openai', 'never-thinks', [100, 120], [50, 60], [0, 0]),
  ]);
  const thinking = floor.series.thinking;
  assert.deepEqual(thinking.rowsUnmeasured, ['openai/never-thinks']);
  assert.equal(thinking.rowsMeasured, 1);
  // The one measured row's own cv, unchanged by the row nobody could measure.
  assert.equal(thinking.worstCvPct, summarise([40, 10]).cvPct);
  assert.equal(thinking.medianCvPct, summarise([40, 10]).cvPct);
  assert.equal(thinking.worstRow, 'openai/thinks');
});

test('a single-sample row cannot be the floor, and is not "the vendor never varied"', () => {
  const floor = noiseFloor([finished('openai', 'one', [100], [50], [10])]);
  assert.equal(floor.series.chars.rowsMeasured, 0);
  assert.equal(floor.series.chars.worstCvPct, null);
  assert.equal(floor.series.chars.medianCvPct, null);
  assert.equal(floor.rowsTotal, 1);
  // And NOT listed as unmeasured-for-lack-of-a-proportion. That list says
  // something about the VENDOR — it never thought on this task. A row that was
  // sampled once says something about the RUN, and putting it in the same list
  // reports a fact about our budget as a fact about the vendor. A mutant that
  // relaxed the two-sample filter survived until this line existed, because
  // every other assertion here holds either way.
  assert.deepEqual(floor.series.chars.rowsUnmeasured, []);
  assert.deepEqual(floor.series.thinking.rowsUnmeasured, []);
});

test('the floor names the row it came from', () => {
  const floor = noiseFloor([
    finished('openai', 'steady', [100, 101], [50, 50], [10, 10]),
    finished('anthropic', 'wild', [100, 300], [50, 50], [10, 10]),
  ]);
  assert.equal(floor.series.chars.worstRow, 'anthropic/wild');
  assert.ok(floor.series.chars.worstCvPct > 50, 'the wilder row did not set the worst');
});

test('dead-lettered and settled rows are counted, not silently dropped', () => {
  const floor = noiseFloor([
    finished('openai', 'a', [100, 101], [50, 50], [10, 10], { settled: true }),
    finished('openai', 'b', [100, 101], [50, 50], [10, 10], { deadLettered: true }),
  ]);
  assert.equal(floor.rowsTotal, 2);
  assert.equal(floor.rowsSettled, 1);
  assert.equal(floor.rowsDeadLettered, 1);
});

// --- what a saved state says about resuming ---------------------------------

test('a resumed run continues the budget it already spent', () => {
  // The defect this replaces: the runner rebuilt `{remaining: total, spent: 0}`
  // on every invocation, so a run resumed twice against a ceiling of two spent
  // four calls — and each invocation truthfully reported spending its share.
  const plan = resumePlan({ rows: { 'a/b': { samples: [{ chars: 1 }] } }, spent: 2 }, 2);
  assert.equal(plan.spent, 2);
  assert.equal(plan.remaining, 0);
  assert.equal(plan.exhausted, true, 'a spent budget was reopened by resuming');
});

test('a run with budget left resumes with what is left, not with all of it', () => {
  const plan = resumePlan({ rows: {}, spent: 3 }, 10);
  assert.equal(plan.remaining, 7);
  assert.equal(plan.exhausted, false);
});

test('a state with no ledger is a fresh run, not an overspent one', () => {
  const plan = resumePlan({ rows: {} }, 5);
  assert.equal(plan.spent, 0);
  assert.equal(plan.remaining, 5);
  assert.deepEqual(plan.legacy, []);
});

test('a row recorded before whole samples were kept is named, not silently restarted', () => {
  // Reading `?.samples ?? []` made a legacy row look ABSENT, so the runner
  // started it over and the first new sample overwrote observations that had
  // been paid for and could no longer be read.
  const plan = resumePlan({
    rows: {
      'openai/old': { lens: [80, 90] },
      'openai/new': { samples: [{ chars: 80, outputTokens: 3 }] },
    },
    spent: 2,
  }, 10);
  assert.deepEqual(plan.legacy, ['openai/old']);
});

test('a call is booked before it is made, not when its sample arrives', async () => {
  // A retry leaves no sample, so a ledger written at `onSample` missed every
  // retried call: three consecutive indices at four retries each is fifteen
  // live calls on the meter and none on disk, and an interrupt during a backoff
  // re-granted all fifteen.
  const seen = [];
  const budget = { remaining: 10, spent: 0 };
  let calls = 0;
  await sampleRow({
    reps: 1,
    budget,
    sleepFor: async () => {},
    onSpend: ({ spent }) => { seen.push(spent); },
    take: async () => {
      calls += 1;
      if (calls <= 2) {
        const error = new Error('429');
        error.retryable = true;
        throw error;
      }
      return { chars: 5, outputTokens: 1, thinkingTokens: 0, latencyMs: 1 };
    },
  });
  assert.equal(calls, 3, 'the retries did not happen');
  assert.deepEqual(seen, [1, 2, 3], 'a retried call reached the vendor without reaching the ledger');
});

// The artifact, which is where a paid observation is published from. The ledger
// got a lock; these two are the ways a paid call still went missing from the
// file the floor is re-derived out of.

test('an aborted row still reaches the artifact with what it paid for', () => {
  const row = { provider: 'openai', task: 'summarise', prompt: 'secret prompt' };
  const samples = [{ chars: 400, outputTokens: 90 }, { chars: 420, outputTokens: 95 }];
  const recorded = abortedRow(row, samples);
  assert.equal(recorded.abortedMidRow, true);
  assert.equal(recorded.settled, false);
  assert.deepEqual(recorded.samples, samples, 'the samples this row paid for are not in the row');
  assert.deepEqual(recorded.tokens, [90, 95], 'the billed series is the one the floor is taken over');
  assert.equal(recorded.n, 2);
  assert.equal(recorded.prompt, undefined, 'the artifact carries prompts it should not');
});

test('a row that collected nothing leaves no row behind', () => {
  assert.equal(abortedRow({ provider: 'openai' }, []), null);
  assert.equal(abortedRow({ provider: 'openai' }, undefined), null);
});

test('two partitions of one batch do not name one artifact', () => {
  // `--only` is how a batch is split across processes, and hundreds of metered
  // calls per partition used to land on one filename.
  const day = new Date('2026-09-10T11:00:00Z');
  assert.equal(defaultArtifactName(day, 'openai'), 'aa-noise-floor-20260910-openai.json');
  assert.notEqual(defaultArtifactName(day, 'openai'), defaultArtifactName(day, 'anthropic'));
  assert.equal(defaultArtifactName(day, null), 'aa-noise-floor-20260910.json');
  assert.equal(defaultArtifactName(day, 'openai/summarise'), 'aa-noise-floor-20260910-openai-summarise.json');
});
