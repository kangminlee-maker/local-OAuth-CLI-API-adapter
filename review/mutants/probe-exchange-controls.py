#!/usr/bin/env python3
"""Negative controls for the direct-API prober's exchange.

This replaces `probe-stream-glue.mjs`, which checked the shipped file for three
token patterns and then ran a hand-written transcription beside it. Two
reviewers broke that the same way within an hour: reverse the refusal test, blank
the returned wire, plant an unconditional throw after the reader, or put the
reader behind `if (false)` and fabricate a result — the checker reported
`GLUE OK: 3/3` every time, because token presence is not execution.

`scripts/lib/probe-exchange.mjs` is now an importable function and
`test/probe-exchange.test.mjs` calls it. So the controls below plant into the
code that ships and require the named case to fail. The source is restored and
its digest verified whatever happens.

The four plants those reviewers used are P1, P2, P4 and P5.
"""
import argparse, hashlib, pathlib, re, subprocess, sys

sys_path = str(pathlib.Path(__file__).parent)
if sys_path not in sys.path:
    sys.path.insert(0, sys_path)
from control_baseline import read_baseline

SOURCE = 'scripts/lib/probe-exchange.mjs'
TEST = 'test/probe-exchange.test.mjs'
# The cases that must exist and must run. Pinned by NAME, not by count: a
# count alone accepted `ok N - name # SKIP`, so disabling a case left the
# denominator unchanged and every mutant still reported killed. Edit this
# list deliberately when a case is added or renamed.
ROSTER = [
    'a streamed answer comes back whole, and is recorded once',
    'a refusal is an observation, not a failed exchange',
    'a streamed 204 is an observation too',
    'a stream cut halfway keeps its status and its bytes',
    'a request that never reached a response is still recorded',
    'a buffered request that never reached a response records no body',
    'a buffered answer is recorded with its body',
    'a buffered body that dies mid-read keeps the status the vendor gave',
]

STREAM_RETURN = "      return { status: read.status, text: read.rawStream, wire: read.rawStream, failed: null };"
READER_CALL = "      const read = await readRecordedSse({"

MUTANTS = [
    ('P1-refusal-is-a-failure',
     'the prober\'s refusal mode, making an answer it asked for a failed exchange',
     [("        refusalIsFailure: false,\n", "        refusalIsFailure: true,\n")],
     'a refusal is an observation, not a failed exchange'),
    ('P2-wire-blanked',
     'the wire handed to the reading, which several probes read for the terminator',
     [(STREAM_RETURN,
       "      return { status: read.status, text: read.rawStream, wire: '', failed: null };")],
     'a streamed answer comes back whole, and is recorded once'),
    ('P3-text-blanked',
     'the text handed to the reading, which is what a refusal is parsed out of',
     [(STREAM_RETURN,
       "      return { status: read.status, text: '', wire: read.rawStream, failed: null };")],
     'a refusal is an observation, not a failed exchange'),
    ('P4-reader-never-called',
     'the call itself, fabricating a result behind `if (false)`',
     [(READER_CALL, "      if (false) await readRecordedSse({"),
      (STREAM_RETURN, "      return { status: 200, text: 'fabricated', wire: 'fabricated', failed: null };")],
     'a streamed answer comes back whole, and is recorded once'),
    ('P5-throw-after-the-reader',
     'everything after the read, by throwing before the result is used',
     [(STREAM_RETURN, "      throw new Error('planted');\n" + STREAM_RETURN)],
     'a streamed answer comes back whole, and is recorded once'),
    ('P6-buffered-catch-forgets-status',
     'the status a buffered turn already had when its body died',
     [("      status: res?.status ?? null,\n      statusText: res?.statusText ?? null,",
       "      status: null,\n      statusText: null,")],
     'a buffered body that dies mid-read keeps the status the vendor gave'),
    ('P8-request-body-dropped',
     "the probe's own body, sending something else to the socket while the record keeps the original",
     [("      body: requestBody,\n      signal: AbortSignal.timeout(timeoutMs),",
       "      body: '{}',\n      signal: AbortSignal.timeout(timeoutMs),")],
     'a buffered answer is recorded with its body'),
    ('P9-request-headers-dropped',
     "the headers the probe supplied, which is how a vendor is told what is being asked",
     [("        request: { headers, body: requestBody },", "        request: { headers: {}, body: requestBody },")],
     'a streamed answer comes back whole, and is recorded once'),
    ('P10-pre-response-body-invented',
     'the distinction between a body that never arrived and one that was empty, at the '
     'buffered exit where no response exists at all',
     [("      responseBody: read ? text : undefined,",
       "      responseBody: res === null ? text : (read ? text : undefined),")],
     'a buffered request that never reached a response records no body'),
    ('P7-cut-stream-reported-readable',
     'the failure a stopped turn reports, calling it an answer instead',
     [("      return { status: error?.status ?? null, text: '', wire: '', failed };",
       "      return { status: error?.status ?? null, text: '', wire: '', failed: null };")],
     'a stream cut halfway keeps its status and its bytes'),
]


def self_test(root: pathlib.Path) -> int:
    """Disable each rostered case in turn and require the baseline to refuse.

    Two things, not one. A control that refused everything would pass a
    rejection-only self-test, so the unmodified baseline has to be ACCEPTED
    first; and the refusal has to name the skip rather than merely happen. Every
    case is tried, because refusing the first one says nothing about the rest.
    """
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
            # Spelled as the test file spells it: a name with an apostrophe is
            # written `\'` there, and the bare name matched nothing.
            spelled = target.replace("'", "\\'")
            before = f"test('{spelled}'"
            if text.count(before) != 1:
                print(f'SELF-TEST NOT PLANTED: {target!r} does not appear exactly once in {TEST}')
                return 2
            test.write_text(text.replace(before, f"test.skip('{spelled}'", 1))
            done = subprocess.run([sys.executable, __file__, '--root', str(root), '--baseline-only'],
                                  capture_output=True, text=True)
            named = 'skipped' in done.stdout and target in done.stdout
            refused = done.returncode == 2 and 'BASELINE-FAIL' in done.stdout and named
            refusals.append(refused)
            if not refused:
                print(f'SELF-TEST kept going with {target!r} skipped: rc={done.returncode}\n'
                      f'         {done.stdout.strip().splitlines()[-1] if done.stdout.strip() else "(silent)"}',
                      flush=True)
    finally:
        test.write_bytes(original)
        restored = hashlib.sha256(test.read_bytes()).hexdigest()
        print(f'RESTORED {restored == digest} ({restored[:12]})', flush=True)

    every = all(refusals) and len(refusals) == len(ROSTER)
    print(f'\nBASELINE REFUSES EVERY DISABLED CASE: {every}   '
          f'({sum(refusals)}/{len(ROSTER)}, unmodified accepted)', flush=True)
    return 0 if every else 1


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--root', required=True)
    # A control that cannot reject a disabled case is a control that certifies
    # execution which did not happen. This proves it can, on this tree, now.
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
        # The reporter is pinned: node picks `spec` here, whose failures carry no
        # `not ok` line, so a control parsing TAP finds none and calls every
        # mutant SURVIVED with an empty failure list.
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

    # Which rostered cases actually failed under some mutant, MEASURED below
    # rather than declared here. A case nothing breaks can be gutted without any
    # control noticing: the roster proves it RAN, never that it asserts
    # anything. Reported rather than refused — a judgement about coverage, not a
    # structural violation.
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
                print(f'[{tag}] NOT PLANTED — a target occurs {text.count(before)} times, not once; '
                      'this control proves nothing until it is re-aimed', flush=True)
                continue
            source.write_text(text)
            checked = subprocess.run(['node', '--check', str(source)], capture_output=True, text=True)
            if checked.returncode != 0:
                results.append((tag, 'NOT PLANTED'))
                print(f'[{tag}] NOT PLANTED — the mutant does not parse, so a failure below '
                      'would be the syntax error and not the mechanism', flush=True)
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


if __name__ == '__main__':
    sys.exit(main())
