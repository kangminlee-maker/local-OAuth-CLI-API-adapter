#!/usr/bin/env python3
"""Negative controls for the streamed capture path.

A passing test says nothing until removing the mechanism it names makes it fail.
Four of these guarantees were once carried by tests that passed a helper without
them: `const [record] = run.records()` reads the first of two, and the test named
for a missing body served an empty one. Each control below deletes one mechanism
from `scripts/lib/sse-capture.mjs`, runs the suite, and requires the named case
to fail. The source is restored and its digest verified whatever happens.

Every mutant is a list of edits, each of which must match EXACTLY ONCE — a
mutant that plants half of itself, or plants at a second site, is a mutant whose
survival means nothing. Each planted module must also parse, so a failure below
is the mechanism and not a syntax error.
"""
import argparse, hashlib, pathlib, re, subprocess, sys

sys_path = str(pathlib.Path(__file__).parent)
if sys_path not in sys.path:
    sys.path.insert(0, sys_path)
from control_baseline import read_baseline

SOURCE = 'scripts/lib/sse-capture.mjs'
TEST = 'test/sse-capture.test.mjs'
# The cases that must exist and must run. Pinned by NAME, not by count: a
# count alone accepted `ok N - name # SKIP`, so disabling a case left the
# denominator unchanged and every mutant still reported killed. Edit this
# list deliberately when a case is added or renamed.
ROSTER = [
    'a refused stream is recorded with its body, not thrown away in a message',
    'a stream that dies halfway is recorded with the bytes that arrived',
    'a stream cut inside a character records that something arrived',
    'a whole stream is recorded once, with the terminator',
    'a good stream ending mid-character records what the callback saw',
    'a request that never reached a response is recorded too',
    'a 200 whose stream carries nothing is recorded as the empty turn it was',
    'a success with no body at all is refused, and recorded',
    'a caller that asked for the refusal gets it back, and no failure is recorded',
    'a body-less success is an answer too when the caller asked for one',
    'a body cut halfway is a failure even for a caller that wanted the refusal',
    'a caller whose onFrame throws does not leave the request open',
    'a long refusal is truncated in the message and kept whole in the record',
    'a whole refusal ending mid-character says the same thing twice',
    'a refusal cut off mid-body keeps the bytes that arrived',
]

GOOD_PATH_FLUSH = """      const tail = decoder.decode();
      rawStream += tail;
      buffer += tail;"""

MUTANTS = [
    ('C1-record-twice',
     'the once-only guard, and recording again on the way out of the catch',
     [("    if (recorded) return;\n    recorded = true;\n", ""),
      ("    throw error;\n  } finally {\n    record();", "    record();\n    throw error;\n  } finally {\n    record();")],
     'a refused stream is recorded with its body'),
    ('C2-null-body-succeeds',
     'the refusal of a response with no stream to read',
     [("      failure = `${url} did not return a readable stream`;\n      throw new SseTransportError(failure, res.status);",
       "      return { status: res.status, rawStream };")],
     'a success with no body at all is refused, and recorded'),
    ('C3-refusal-all-or-nothing',
     'the chunked read of a refusal body, restoring res.text()',
     [("      if (res.body) {\n        const reader = res.body.getReader();", "      if (res.body) {\n        rawStream = await res.text();\n        const reader = { read: async () => ({ done: true }), cancel: async () => {} };")],
     'a refusal cut off mid-body keeps the bytes that arrived'),
    ('C5-no-flush-on-exit',
     'the decoder flush on the way out, which is what a byte held mid-character needs',
     [("    rawStream += decoder.decode();\n    recordExchange({", "    recordExchange({")],
     'a stream cut inside a character records that something arrived'),
    ('C6-goodpath-tail-not-recorded',
     "the good path's flush into rawStream, which the record and the terminator gate read",
     [(GOOD_PATH_FLUSH, "      const tail = decoder.decode();\n      buffer += tail;")],
     'a good stream ending mid-character records what the callback saw'),
    ('C7-goodpath-tail-not-framed',
     "the good path's flush into buffer, which is what makes a final partial frame complete",
     [(GOOD_PATH_FLUSH, "      const tail = decoder.decode();\n      rawStream += tail;")],
     'a good stream ending mid-character records what the callback saw'),
    ('C8-refusal-inner-flush',
     "the refusal branch's flush, which runs before the thrown message is built",
     [("          }\n          rawStream += decoder.decode();\n        } catch (error) {", "          }\n        } catch (error) {")],
     'a whole refusal ending mid-character says the same thing twice'),
    ('C4-short-truncation',
     "the runner's diagnostic length",
     [("const truncate = (text, limit = 2000) => (text.length > limit ? `${text.slice(0, limit)}...` : text);",
       "const truncate = (text, limit = 400) => (text.length > limit ? `${text.slice(0, limit)}…` : text);")],
     'a long refusal is truncated in the message and kept whole in the record'),
    ('C10-refusal-mode-ignored',
     "the caller's say in whether a non-2xx is a failure, making every refusal one",
     [("      if (refusalIsFailure) failure = `${url} ${res.status}`;",
       "      failure = `${url} ${res.status}`;")],
     'a caller that asked for the refusal gets it back'),
    ('C11-refusal-mode-never-returns',
     'the answer a caller asked for, throwing it instead',
     [("      if (!refusalIsFailure) return { status: res.status, rawStream };\n      throw new SseTransportError(`${url} ${res.status}",
       "      throw new SseTransportError(`${url} ${res.status}")],
     'a caller that asked for the refusal gets it back'),
    ('C12-reader-not-released',
     'the reader release, leaving the request open until an unrelated timeout',
     [("      if (!drained) await reader.cancel().catch(() => {});\n    }\n  } catch (error) {",
       "      void drained;\n    }\n  } catch (error) {")],
     'a caller whose onFrame throws does not leave the request open'),
    ('C14-null-body-answer-throws',
     "the answer a caller asked for when there is no stream at all, throwing 204 instead",
     [("      if (!refusalIsFailure) return { status: res.status, rawStream };\n      failure = `${url} did not return a readable stream`;",
       "      failure = `${url} did not return a readable stream`;")],
     'a body-less success is an answer too when the caller asked for one'),
    ('C15-frames-split-on-one-newline',
     'the blank line that ends an SSE frame, cutting on every newline instead',
     [("      while ((index = buffer.indexOf('\\n\\n')) !== -1) {\n          onFrame(buffer.slice(0, index));\n          buffer = buffer.slice(index + 2);",
       "      while ((index = buffer.indexOf('\\n')) !== -1) {\n          onFrame(buffer.slice(0, index));\n          buffer = buffer.slice(index + 1);")],
     'a whole stream is recorded once, with the terminator'),
    ('C16-empty-turn-not-recorded',
     'the record for a turn that carried no bytes, which is the one a reader cannot reconstruct',
     [("    if (recorded) return;\n    recorded = true;\n    // Whatever the decoder",
       "    if (recorded || rawStream === '') return;\n    recorded = true;\n    // Whatever the decoder")],
     'a 200 whose stream carries nothing is recorded as the empty turn it was'),
    ('C13-mid-stream-failure-unlabelled',
     'the turn a stopped stream names, leaving a bare `terminated` in the record',
     [("      failure = res ? `${url} ${res.status}, stream interrupted: ${said}` : said;",
       "      failure = said;")],
     'a stream that dies halfway is recorded with the bytes that arrived'),
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
            before = f"test('{target}'"
            if text.count(before) != 1:
                print(f'SELF-TEST NOT PLANTED: {target!r} does not appear exactly once in {TEST}')
                return 2
            test.write_text(text.replace(before, f"test.skip('{target}'", 1))
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
        # `not ok` line, so a control parsing TAP found none and called every
        # mutant SURVIVED with an empty failure list. A control that cannot see a
        # failure reports the same word for "protected" and "blind".
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


if __name__ == '__main__':
    sys.exit(main())
