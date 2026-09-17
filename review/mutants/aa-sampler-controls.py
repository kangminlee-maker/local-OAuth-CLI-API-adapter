#!/usr/bin/env python3
"""Negative controls for the A/A sampler.

The noise floor is a number that will be used to decide whether a length
difference between direct and proxy means anything. A sampler that is wrong in
the quiet direction — counting whitespace, accepting an empty answer as a short
one, re-spending resumed calls — moves that number without failing anything.

Each mutant deletes one mechanism from `scripts/lib/aa-sampler.mjs`, runs the
suite, and requires the named case to fail. Every edit must match exactly once
and every planted module must parse.
"""
import argparse, hashlib, pathlib, re, subprocess, sys

sys_path = str(pathlib.Path(__file__).parent)
if sys_path not in sys.path:
    sys.path.insert(0, sys_path)
from control_baseline import read_baseline

SOURCE = 'scripts/lib/aa-sampler.mjs'
TEST = 'test/aa-sampler.test.mjs'

ROSTER = [
    'visible characters ignore how an answer is laid out',
    'one sample is measured and recorded, with what the server received',
    'a refusal is recorded, and retried only when the vendor asked to be',
    'a rate limit is retryable and a server error is too',
    'an answer with no text is a failure, not a zero-length sample',
    'a summary of one sample reports no spread rather than none',
    'a row stops early only once its interval is tight enough',
    'the stopping rule is asked about the reading, not about a character count',
    'a row that never settles takes its full budget and no more',
    'three consecutive failures dead-letter the row instead of hammering it',
    'a retryable failure backs off and is retried in place',
    'a call that never reached a response is recorded, and worth retrying',
    'a retryable failure gives up rather than retrying forever',
    'the shared budget ends the run rather than the row',
    'a resumed row keeps what it already has and asks only for the rest',
    'a resume state holding bare lengths is refused, not half-restored',
    'a retry cannot spend past the shared budget',
    'a retry inside the budget still happens',
    'a resumed run continues the budget it already spent',
    'a run with budget left resumes with what is left, not with all of it',
    'a state with no ledger is a fresh run, not an overspent one',
    'a row recorded before whole samples were kept is named, not silently restarted',
    'a call is booked before it is made, not when its sample arrives',
    'the floor covers every series a row records, not just the visible one',
    'a row with no proportion to take is unmeasured BY NAME, not a zero',
    'a single-sample row cannot be the floor, and is not "the vendor never varied"',
    'the floor names the row it came from',
    'dead-lettered and settled rows are counted, not silently dropped',
    'an aborted row still reaches the artifact with what it paid for',
    'a row that collected nothing leaves no row behind',
    'a run that spends gets a ledger whether or not it was asked for one',
    'an interrupt stops before the next call and lets the one in flight finish',
    'two partitions of one batch do not name one artifact',
    "the operator's filter text decides nothing about identity",
    'a run pinned to a different model is a different run',
    'a ledger from another configuration is refused, not merged',
    'a paid response survives a capture sink that cannot be written',
    'a sample whose evidence could not be written is kept, and ends the run',
    'a ledger that cannot be written stops the run; it is not a failed call',
    'a call neither sink could keep stops the run and says so',
    'a ledger that cannot record the next call means that call is not made',
    'an async sink is awaited, so its rejection is not lost',
    'a pin for a provider with no row in the run decides nothing',
    'identity reads the prompts a run sends, not the name they are sent under',
]

MUTANTS = [
    ('A1-whitespace-counted',
     'the collapse of layout, putting indentation into a vendor\'s variance',
     [("  return text.replace(/\\s+/g, ' ').trim().length;", "  return text.length;")],
     'visible characters ignore how an answer is laid out'),
    ('A2-empty-answer-is-zero',
     'the refusal of an answer with no text, counting it as a very short one',
     [("  if (typeof answer?.text !== 'string' || answer.text === '') {",
       "  if (typeof answer?.text !== 'string') {")],
     'an answer with no text is a failure, not a zero-length sample'),
    ('A3-every-refusal-retried',
     'the line between a vendor asking to be asked again and this run being wrong',
     [("    failure.retryable = res.status === 429 || res.status >= 500;",
       "    failure.retryable = true;")],
     'a refusal is recorded, and retried only when the vendor asked to be'),
    ('A4-one-sample-has-no-spread',
     'the difference between "does not vary" and "was not measured"',
     [("  const sd = n > 1\n    ? Math.sqrt(lens.reduce((total, value) => total + (value - mean) ** 2, 0) / (n - 1))\n    : null;",
       "  const sd = Math.sqrt(lens.reduce((total, value) => total + (value - mean) ** 2, 0) / Math.max(1, n - 1));")],
     'a summary of one sample reports no spread rather than none'),
    ('A5-backoff-does-not-grow',
     'the growth in the wait, turning a backoff into a fixed-rate retry',
     [("          const wait = Math.min(backoffCapMs, backoffMs * 2 ** (attempt - 1));",
       "          const wait = backoffMs;")],
     'a retryable failure backs off and is retried in place'),
    ('A6-row-never-dead-lettered',
     'the limit on consecutive failures, so a dead row is asked its full count',
     [("          if (consecutive >= maxConsecutiveFailures) {", "          if (false) {")],
     'three consecutive failures dead-letter the row instead of hammering it'),
    ('A7-budget-not-spent',
     "the shared budget's accounting, so a run cannot know what it has spent",
     [("        if (budget) { budget.remaining -= 1; budget.spent += 1; }", "        if (false) { budget.remaining -= 1; }")],
     'the shared budget ends the run rather than the row'),
    ('A8-resume-restarts',
     'the samples a resumed row already has, re-spending every call',
     [("  for (let index = samples.length; index < reps; index += 1) {",
       "  for (let index = 0; index < reps; index += 1) {")],
     'a resumed row keeps what it already has and asks only for the rest'),
    ('A9-stops-before-the-floor',
     'the minimum sample count, letting two identical draws decide a row',
     [("    if (decisiveWhen !== null\n        && samples.length >= minReps",
       "    if (decisiveWhen !== null\n        && samples.length >= 2")],
     'a row stops early only once its interval is tight enough'),
    ('A10-failure-not-recorded',
     'the record for a call that never came back, leaving no evidence under the number',
     [("  } catch (error) {\n    recordExchange({\n      kind: 'json', label, url, requestHeaders: headers, requestBody: body,\n      status: res?.status ?? null, statusText: res?.statusText ?? null,\n      responseHeaders: res?.headers ?? null,\n      durationMs: performance.now() - startedAt, error,\n    });",
       "  } catch (error) {")],
     'a call that never reached a response is recorded, and worth retrying'),
    ('A12-row-stops-at-the-floor',
     'the full sample count, letting a row that never settles stop at the minimum',
     [("        && samples.length >= minReps\n        && reading.ciHalfWidth !== null\n        && decisiveWhen(reading)) {",
       "        && samples.length >= minReps) {")],
     'a row that never settles takes its full budget and no more'),
    ('A13-no-retry-at-all',
     'the retry itself, so a rate limit ends a row on its first refusal',
     [("  maxRetries = 4,", "  maxRetries = 0,")],
     'a retryable failure backs off and is retried in place'),
    ('A14-one-retry-too-many',
     'the exact bound on retries — off by one is still unbounded in the direction that matters',
     [("        const retryable = error?.retryable === true && attempt < maxRetries;",
       "        const retryable = error?.retryable === true && attempt <= maxRetries;")],
     'a retryable failure gives up rather than retrying forever'),
    ('A15-stopping-rule-ignores-the-reading',
     'the predicate itself, stopping every row at the floor whatever its interval says',
     [("        && decisiveWhen(reading)) {", "        && true) {")],
     'the stopping rule is asked about the reading, not about a character count'),
    ('A11-request-body-dropped',
     "the sampler's own body, so every row asks the vendor something else",
     [("      body,\n      signal: AbortSignal.timeout(timeoutMs),", "      body: '{}',\n      signal: AbortSignal.timeout(timeoutMs),")],
     'one sample is measured and recorded, with what the server received'),
    # A16: the defect the first live run shipped with. `cvPct ?? 0` feeds a row
    # nobody could measure into Math.max as a zero and into the median as the
    # lowest value there is, so a series where the vendor sometimes did nothing
    # at all reads TIGHTER than its measured rows alone say. A missing reading
    # is not a small reading.
    ('A16-unmeasured-row-counts-as-zero',
     'the exclusion of a row with no proportion to take, reading it as 0% variance',
     [("    const measured = readings.filter(({ reading }) => reading.cvPct !== null);\n"
       "    const cvs = measured.map(({ reading }) => reading.cvPct).sort((a, b) => a - b);",
       "    const measured = readings;\n"
       "    const cvs = measured.map(({ reading }) => reading.cvPct ?? 0).sort((a, b) => a - b);")],
     'a row with no proportion to take is unmeasured BY NAME, not a zero'),
    # A17: the other half of the same defect. Publishing the character series
    # alone called 16.7% "the floor" on a run whose billed-token series read
    # 65.4% — the tightest of the three, and the one nobody is billed on.
    ('A17-floor-covers-only-the-visible-series',
     'the other two series, publishing the one a reader sees and not the one a bill is drawn on',
     [("export const SERIES = [\n  ['chars', 'lens'],\n  ['outputTokens', 'tokens'],\n  ['thinking', 'thinking'],\n];",
       "export const SERIES = [\n  ['chars', 'lens'],\n];")],
     'the floor covers every series a row records, not just the visible one'),
    # A18: a row of ONE sample has no spread — `summarise` says so by returning
    # sd null — and letting it into the floor turns "not measured" into a
    # reading. The same confusion A4 plants one level down, at the point where
    # the floor consumes it.
    ('A18-one-sample-row-enters-the-floor',
     'the two-sample requirement, letting a row that has no spread set the floor',
     [("      .filter(({ reading }) => reading.n >= 2);", "      .filter(({ reading }) => reading.n >= 1);")],
     'a single-sample row cannot be the floor, and is not "the vendor never varied"'),
    # A19: the worst cv is still right, but it is attributed to whichever row
    # came first. A floor that names the wrong row sends the next reader to a
    # task that was steady.
    ('A19-worst-row-is-whichever-came-first',
     'the search for the widest row, naming the first one instead',
     [("    const worst = measured.reduce(\n"
       "      (best, entry) => (best === null || entry.reading.cvPct > best.reading.cvPct ? entry : best),\n"
       "      null,\n"
       "    );",
       "    const worst = measured.length ? measured[0] : null;")],
     'the floor names the row it came from'),
    # A20: the run-level counts go to constants. A dead-lettered row is a row
    # the vendor would not answer, and a floor that reports zero of them claims
    # a completeness it does not have.
    # A21: the budget check goes back outside the retry loop, where it was when
    # a ceiling of one authorised five metered calls. Two independent reviews
    # reproduced it on the same day.
    ('A21-budget-checked-once-per-sample',
     'the budget check in front of every CALL, leaving it in front of every SAMPLE',
     [("        if (budget && budget.remaining <= 0) {\n"
       "          throw new SamplingAbort(`the run's call budget is spent (${budget.spent} used)`);\n"
       "        }",
       "        if (attempt === 0 && budget && budget.remaining <= 0) {\n"
       "          throw new SamplingAbort(`the run's call budget is spent (${budget.spent} used)`);\n"
       "        }")],
     'a retry cannot spend past the shared budget'),
    # A22: an exhausted budget is caught as this row's failure instead of ending
    # the run, so the three-strikes rule reads "we ran out of money" as "this
    # row is broken" and the next row starts anyway.
    ('A22-budget-abort-becomes-a-row-failure',
     'the rethrow that lets an exhausted budget end the RUN',
     [("        if (error instanceof SamplingAbort) throw error;\n", "")],
     'a retry cannot spend past the shared budget'),
    # A23: a bare-length resume state is accepted again. The row then carries
    # five character readings beside two token readings and reports both as
    # complete — and the floor is taken over the token series.
    ('A23-bare-length-resume-accepted',
     'the refusal of a resume state that cannot say what its calls measured',
     [("    if (typeof entry === 'number' || entry === null || typeof entry !== 'object') {",
       "    if (false) {")],
     'a resume state holding bare lengths is refused, not half-restored'),
    # A24: the series stop coming from the samples and go back to being
    # accumulated in parallel, which is what lost them on resume.
    ('A24-series-not-derived-from-samples',
     'the derivation of every series from the samples that produced it',
     [("  const series = (key) => samples.map((sample) => sample[key]).filter((value) => typeof value === 'number');",
       "  const series = (key) => (key === 'chars' ? samples.map((sample) => sample[key]) : []);")],
     'a resumed row keeps what it already has and asks only for the rest'),
    # A25: the resume ledger goes away, so every invocation starts the batch's
    # budget over. A run resumed twice against a ceiling of two spends four
    # calls while each invocation truthfully reports spending its share — the
    # defect round 2 reproduced by extracting the runner's own loop.
    ('A25-resume-forgets-what-it-spent',
     'the ledger a resumed run reads, reopening the whole batch every invocation',
     [("  const spent = Number.isFinite(state?.spent) ? state.spent : 0;", "  const spent = 0;")],
     'a resumed run continues the budget it already spent'),
    # A26: a spent budget stops being spent, so `exhausted` never fires and the
    # runner starts a row it cannot pay for.
    # A28: a state with no ledger is read as fully spent rather than as fresh,
    # so a first run refuses to start. The opposite direction from A25, and the
    # case A25 cannot reach — it sets the ledger to 0, which is what a fresh
    # state should read as anyway.
    # A29: the ledger goes back to reaching disk only when a sample arrives.
    # A retry leaves no sample, so three consecutive indices at four retries
    # each put fifteen live calls on the vendor's meter and none on disk — and
    # an interrupt during a backoff re-granted every one of them.
    ('A29-spend-not-announced-before-the-call',
     'the announcement that a call has been paid for, made BEFORE the call',
     [("        await onSpend({ index, attempt, spent: budget?.spent ?? null });\n", "")],
     'a call is booked before it is made, not when its sample arrives'),
    ('A28-missing-ledger-reads-as-spent',
     'the reading of a state that has no ledger, treating it as a batch already paid for',
     [("  const spent = Number.isFinite(state?.spent) ? state.spent : 0;",
       "  const spent = state?.spent ?? budgetTotal;")],
     'a state with no ledger is a fresh run, not an overspent one'),
    ('A26-exhausted-budget-is-never-exhausted',
     'the test that says a batch has been paid for',
     [("    exhausted: budgetTotal - spent <= 0,", "    exhausted: false,")],
     'a resumed run continues the budget it already spent'),
    # A27: a legacy row stops being named, which is how it came to be read as an
    # ABSENT row — restarted, and its paid observations overwritten.
    ('A27-legacy-row-not-named',
     'the naming of a row recorded before whole samples were kept',
     [("      .filter(([, row]) => !Array.isArray(row?.samples))", "      .filter(() => false)")],
     'a row recorded before whole samples were kept is named, not silently restarted'),
    ('A20-run-level-counts-are-constants',
     'the counts of what happened to the rows, reporting none of either',
     [("    rowsDeadLettered: rows.filter((row) => row.deadLettered).length,\n"
       "    rowsSettled: rows.filter((row) => row.settled).length,",
       "    rowsDeadLettered: 0,\n    rowsSettled: 0,")],
     'dead-lettered and settled rows are counted, not silently dropped'),
    # The artifact is where a paid observation is published from; the ledger's
    # lock never covered it.
    ('A30-aborted-row-dropped',
     'the row an abort leaves behind, so its paid samples never reach the artifact',
     [("export function abortedRow(row, samples) {\n  if (!samples || samples.length === 0) return null;",
       "export function abortedRow(row, samples) {\n  if (true) return null;")],
     'an aborted row still reaches the artifact with what it paid for'),
    ('A31-empty-row-recorded',
     'the emptiness check, so a row that collected nothing is published as a reading',
     [("  if (!samples || samples.length === 0) return null;",
       "  if (false) return null;")],
     'a row that collected nothing leaves no row behind'),
    ('A33-spending-without-a-ledger',
     'the ledger a live run gets by default, so an interrupt loses every call it has paid for',
     [("  if (!live || !outPath) return null;\n  return `${outPath}.state.json`;",
       "  return null;")],
     'a run that spends gets a ledger whether or not it was asked for one'),
    ('A34-interrupt-not-checked',
     'the stop check beside the budget check, so an interrupt abandons the call in flight',
     [("        if (shouldStop()) {", "        if (false) {")],
     'an interrupt stops before the next call and lets the one in flight finish'),
    ('A35-artifact-name-ignores-the-cohort',
     'the identity digest, so every run of a day shares one artifact, one ledger and one lock',
     [("  return `aa-noise-floor-${day}${label}-${identity}.json`;",
       "  return `aa-noise-floor-${day}${label}.json`;")],
     'two partitions of one batch do not name one artifact'),
    ('A36-name-carries-what-was-typed',
     'the cohort-derived label, putting the raw filter text back inside the name',
     [("  const providers = [...new Set((selected ?? []).map((key) => String(key).split('/')[0]))].sort();\n"
       "  const label = providers.length > 0 ? `-${providers.join('-')}` : '';",
       "  const label = '';")],
     "the operator's filter text decides nothing about identity"),
    ('A37-identity-is-the-cohort-alone',
     'the measurement configuration, so two runs under different model pins are one run',
     [("  const canonical = JSON.stringify({\n    cohort,\n"
       "    models: Object.fromEntries(providers.map((provider) => [provider, models[provider]])),\n"
       "    maxTokens,\n  });",
       "  const canonical = JSON.stringify({ cohort });")],
     'a run pinned to a different model is a different run'),
    ('A38-identity-ignores-the-output-cap',
     'the cap from identity, so two runs measuring different amounts of answer share a ledger',
     [("    models: Object.fromEntries(providers.map((provider) => [provider, models[provider]])),\n"
       "    maxTokens,\n  });",
       "    models: Object.fromEntries(providers.map((provider) => [provider, models[provider]])),\n  });")],
     'a run pinned to a different model is a different run'),
    ('A39-cohort-order-is-identity',
     'the sort, so the order the rows were selected in decides whether this is the same run',
     [("    .map((row) => [`${row.provider}/${row.task}`, digest(row.prompt)])\n"
       "    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));",
       "    .map((row) => [`${row.provider}/${row.task}`, digest(row.prompt)]);")],
     'a run pinned to a different model is a different run'),
    ('A40-mismatched-resume-is-merged',
     "the refusal, so another configuration's paid samples join this run's series",
     [("  if (state?.identity && state.identity !== identity) {", "  if (false) {")],
     'a ledger from another configuration is refused, not merged'),
    ('A41-unstamped-ledger-is-a-fresh-run',
     'the refusal for a ledger written before identity was recorded, so paid and unaccounted-for '
     'reads as new',
     [("  if (!state?.identity && (rows > 0 || spent > 0)) {", "  if (false) {")],
     'a ledger from another configuration is refused, not merged'),
    ('A42-capture-failure-discards-the-response',
     'the carried capture error, so an unwritable sink throws away a response the vendor billed for',
     [("  } catch (error) {\n    captureError = `the exchange could not be recorded: "
       "${String(error?.message ?? error)}`;\n  }",
       "  } catch (error) {\n    throw error;\n  }")],
     'a paid response survives a capture sink that cannot be written'),
    ('A43-capture-failure-does-not-stop-the-run',
     'the abort, so a run whose evidence sink is gone keeps spending',
     [("        if (ledgerError !== null || sample.captureError) {",
       "        if (ledgerError !== null) {")],
     'a sample whose evidence could not be written is kept, and ends the run'),
    ('A44-capture-failure-loses-the-sample',
     'the persist-before-abort ordering, so the paid observation never reaches the ledger',
     [("          await onSample({ index, ...sample, samples: [...samples], lens: lensOf() });",
       "          if (!sample.captureError) await onSample({ index, ...sample, samples: [...samples], lens: lensOf() });")],
     'a sample whose evidence could not be written is kept, and ends the run'),
    ('A45-identity-carries-every-pin',
     "the cohort's own providers, so a pin for a provider with no row re-grants the ceiling",
     [("    models: Object.fromEntries(providers.map((provider) => [provider, models[provider]])),",
       "    models,")],
     'a pin for a provider with no row in the run decides nothing'),
    ('A46-prompt-by-name-only',
     'the prompt digest, so an edited prompt resumes as the same run',
     [("    .map((row) => [`${row.provider}/${row.task}`, digest(row.prompt)])",
       "    .map((row) => [`${row.provider}/${row.task}`])")],
     'a run pinned to a different model is a different run'),
    ('A47-prompt-without-its-row',
     'the row key, so one prompt under two names is one row',
     [("    .map((row) => [`${row.provider}/${row.task}`, digest(row.prompt)])",
       "    .map((row) => [digest(row.prompt)])")],
     'identity reads the prompts a run sends, not the name they are sent under'),
    ('A48-missing-pin-hashes-as-nothing',
     'the refusal of a provider with rows and no pin',
     [("      throw new Error(`no model is pinned for ${provider}, which has rows in this run`);\n", "")],
     'a pin for a provider with no row in the run decides nothing'),
    ('A49-ledger-failure-is-a-failed-call',
     'the ledger catch, so a full disk is booked as a vendor failure and the run keeps paying',
     [("        try {\n          await onSample({ index, ...sample, samples: [...samples], lens: lensOf() });\n"
       "        } catch (error) {\n          ledgerError = String(error?.message ?? error);\n        }",
       "        await onSample({ index, ...sample, samples: [...samples], lens: lensOf() });")],
     'a ledger that cannot be written stops the run; it is not a failed call'),
    ('A50-neither-sink-reported-as-one',
     'the both-sinks case, so a call nothing kept is reported as held by its capture record',
     [("            : !sample.captureError\n", "            : true\n")],
     'a call neither sink could keep stops the run and says so'),
    ('A51-booking-failure-is-a-failed-call',
     'the booking catch, so a ledger that refused the booking counts against the row',
     [("        try {\n          await onSpend({ index, attempt, spent: budget?.spent ?? null });\n"
       "        } catch (error) {",
       "        try {\n          await onSpend({ index, attempt, spent: budget?.spent ?? null });\n"
       "        } catch (error) {\n          throw error;")],
     'a ledger that cannot record the next call means that call is not made'),
    ('A52-ledger-not-awaited',
     'the await on the ledger sink, so an async rejection is never seen',
     [("          await onSample({ index, ...sample, samples: [...samples], lens: lensOf() });",
       "          onSample({ index, ...sample, samples: [...samples], lens: lensOf() });")],
     'an async sink is awaited, so its rejection is not lost'),
    ('A53-booking-not-awaited',
     'the await on the booking sink, so the call is made before its booking is known to have failed',
     [("          await onSpend({ index, attempt, spent: budget?.spent ?? null });",
       "          onSpend({ index, attempt, spent: budget?.spent ?? null });")],
     'an async sink is awaited, so its rejection is not lost'),
]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--root', required=True)
    ap.add_argument('--self-test', action='store_true',
                    help='skip each rostered case in turn and require the baseline to refuse')
    ap.add_argument('--baseline-only', action='store_true',
                    help='read the baseline and exit; used by --self-test')
    args = ap.parse_args()
    root = pathlib.Path(args.root).resolve()
    source = root / SOURCE
    original = source.read_bytes()
    digest = hashlib.sha256(original).hexdigest()
    print(f'SUBJECT {SOURCE} sha256 {digest}', flush=True)

    def run_suite():
        done = subprocess.run(['node', '--test', '--test-reporter=tap', TEST], cwd=root,
                              capture_output=True, text=True)
        return done.returncode, done.stdout + done.stderr

    if args.self_test:
        return self_test(root)

    code, out = run_suite()
    accepted, reading, why = read_baseline(out, ROSTER)
    print(f'BASELINE rc={code} tests={reading["tests"]} pass={reading["pass"]} '
          f'skipped={reading["skipped"]} todo={reading["todo"]} cancelled={reading["cancelled"]} '
          f'roster={len(ROSTER)}', flush=True)
    if code != 0 or not accepted:
        if not args.baseline_only:
            source.write_bytes(original)
        print(f'BASELINE-FAIL: {why or f"rc={code}"}. No control below means anything until the '
              'whole roster runs and passes — if a case was added or renamed on purpose, edit '
              'ROSTER with it.')
        return 2

    if args.baseline_only:
        return 0

    backed = set()
    results = []
    try:
        for tag, removes, edits, expected_test in MUTANTS:
            text = original.decode()
            planted = True
            for before, after in edits:
                if text.count(before) != 1:
                    planted = False
                    break
                text = text.replace(before, after, 1)
            if not planted:
                results.append((tag, 'NOT PLANTED'))
                print(f'[{tag}] NOT PLANTED — a target does not occur exactly once; this control '
                      'proves nothing until it is re-aimed', flush=True)
                continue
            source.write_text(text)
            checked = subprocess.run(['node', '--check', str(source)], capture_output=True, text=True)
            if checked.returncode != 0:
                results.append((tag, 'NOT PLANTED'))
                print(f'[{tag}] NOT PLANTED — the mutant does not parse, so a failure below would '
                      'be the syntax error and not the mechanism', flush=True)
                continue
            code, out = run_suite()
            failed_names = re.findall(r'^not ok \d+ - (.+)$', out, re.M)
            backed.update(failed_names)
            hit = any(expected_test in name for name in failed_names)
            verdict = 'KILLED' if code != 0 and hit else 'SURVIVED'
            results.append((tag, verdict))
            print(f'[{tag}] {verdict} (rc={code}) — removed {removes}\n'
                  f'         failing: {failed_names or "none"}', flush=True)
    finally:
        source.write_bytes(original)
        restored = hashlib.sha256(source.read_bytes()).hexdigest()
        print(f'RESTORED {restored == digest} ({restored[:12]})', flush=True)

    unbacked = [case for case in ROSTER if case not in backed]
    if unbacked:
        print(f'\nUNBACKED: {len(unbacked)} of {len(ROSTER)} rostered case(s) failed under no '
              f'mutant here, so nothing above would notice if they stopped asserting: '
              f'{unbacked}', flush=True)

    killed = sum(1 for _, v in results if v == 'KILLED')
    print(f'\nALL KILLED: {killed == len(MUTANTS)}   ({killed}/{len(MUTANTS)})', flush=True)
    return 0 if killed == len(MUTANTS) else 1


def self_test(root: pathlib.Path) -> int:
    """Disable each rostered case in turn and require the baseline to refuse."""
    test = root / TEST
    original = test.read_bytes()
    digest = hashlib.sha256(original).hexdigest()
    text = original.decode()

    unmodified = subprocess.run([sys.executable, __file__, '--root', str(root), '--baseline-only'],
                                capture_output=True, text=True)
    accepted = unmodified.returncode == 0
    print(f'SELF-TEST unmodified baseline accepted: {accepted}', flush=True)
    if not accepted:
        print('SELF-TEST-FAIL: the unmodified baseline is refused, so a refusal below would '
              'prove nothing about skipping.')
        return 1

    refusals = []
    try:
        for target in ROSTER:
            before = f"test('{target}'"
            if text.count(before) != 1:
                print(f'SELF-TEST NOT PLANTED: {target!r} does not appear exactly once in {TEST}')
                return 2
            test.write_text(text.replace(before, f"test.skip('{target}'", 1))
            done = subprocess.run([sys.executable, __file__, '--root', str(root), '--baseline-only'],
                                  capture_output=True, text=True)
            refused = (done.returncode == 2 and 'BASELINE-FAIL' in done.stdout
                       and 'skipped' in done.stdout and target in done.stdout)
            refusals.append(refused)
            if not refused:
                print(f'SELF-TEST kept going with {target!r} skipped: rc={done.returncode}', flush=True)
    finally:
        test.write_bytes(original)
        restored = hashlib.sha256(test.read_bytes()).hexdigest()
        print(f'RESTORED {restored == digest} ({restored[:12]})', flush=True)

    every = all(refusals) and len(refusals) == len(ROSTER)
    print(f'\nBASELINE REFUSES EVERY DISABLED CASE: {every}   '
          f'({sum(refusals)}/{len(ROSTER)}, unmodified accepted)', flush=True)
    return 0 if every else 1


if __name__ == '__main__':
    sys.exit(main())
