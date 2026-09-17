#!/usr/bin/env python3
"""Negative controls for the noise-floor runner's identity call.

`aa-sampler-controls.py` mutates the library. The defect round 7 found was one
step out, at the CALL: the runner handed `runIdentity` both model pins and the
bytes of the tasks file whatever the cohort. The library cannot see what it is
handed, so this table mutates the runner and requires
`test/aa-noise-floor-plan.test.mjs` to notice.

That test starts the mutated runner, so what it does to a mutant matters: it
never passes `--live` or `--resume`, it strips both vendor keys from the
child's environment, and it preloads a module that ends the process on any
fetch. No mutant below touches the live path; if one did, it would exit at the
key check before a call could be made.

    python3 aa-noise-floor-plan-controls.py --root <repo> [--self-test]
"""
import argparse, hashlib, pathlib, re, subprocess, sys

sys_path = str(pathlib.Path(__file__).parent)
if sys_path not in sys.path:
    sys.path.insert(0, sys_path)
from control_baseline import read_baseline

SOURCE = 'scripts/aa-noise-floor.mjs'
TEST = 'test/aa-noise-floor-plan.test.mjs'

ROSTER = [
    'a partition is the same run whatever the pin of the provider it leaves out',
    "the runner's identity is its selected prompts, their providers' pins and the cap",
    'an edit to the tasks file is a new run only where it changes a selected prompt',
]

CALL = '  rows,\n  models: Object.fromEntries(Object.entries(PROVIDERS)'

MUTANTS = [
    ('P1-file-bytes-back-in-identity',
     'the prompt-only digest, putting the tasks file back into every row',
     [(CALL, '  rows: rows.map((row) => ({ ...row, prompt: row.prompt + qualityTasksDigest() })),\n'
             '  models: Object.fromEntries(Object.entries(PROVIDERS)')],
     'an edit to the tasks file is a new run only where it changes a selected prompt'),
    ('P2-pins-not-from-the-invocation',
     "the operator's pins, so every model is one run",
     [('([provider, vendor]) => [provider, vendor.model]',
       "([provider]) => [provider, 'pinned-by-default']")],
     'a partition is the same run whatever the pin of the provider it leaves out'),
    ('P3-cap-not-from-the-invocation',
     "the operator's cap, so two caps are one run",
     [('  maxTokens,\n});\nconst outPath', '  maxTokens: 1536,\n});\nconst outPath')],
     "the runner's identity is its selected prompts, their providers' pins and the cap"),
    ('P4-identity-over-every-row',
     'the selection, so every partition is named for the whole batch',
     [(CALL, '  rows: Object.keys(PROVIDERS).flatMap((provider) => tasks.map((task) => '
             '({ provider, task: task.id, prompt: task.prompt }))),\n'
             '  models: Object.fromEntries(Object.entries(PROVIDERS)')],
     "the runner's identity is its selected prompts, their providers' pins and the cap"),
]


def run_suite(root):
    done = subprocess.run(['node', '--test', '--test-reporter=tap', TEST], cwd=root,
                          capture_output=True, text=True)
    return done.returncode, done.stdout + done.stderr


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

    if args.self_test:
        return self_test(root)

    code, out = run_suite(root)
    accepted, reading, why = read_baseline(out, ROSTER)
    print(f'BASELINE rc={code} tests={reading["tests"]} pass={reading["pass"]} '
          f'skipped={reading["skipped"]} todo={reading["todo"]} cancelled={reading["cancelled"]} '
          f'roster={len(ROSTER)}', flush=True)
    if code != 0 or not accepted:
        print(f'BASELINE-FAIL: {why or f"rc={code}"}. No control below means anything until the '
              'whole roster runs and passes.')
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
                print(f'[{tag}] NOT PLANTED — the mutant does not parse', flush=True)
                continue
            code, out = run_suite(root)
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
              f'mutant here: {unbacked}', flush=True)

    killed = sum(1 for _, v in results if v == 'KILLED')
    print(f'\nALL KILLED: {killed == len(MUTANTS)}   ({killed}/{len(MUTANTS)})', flush=True)
    return 0 if killed == len(MUTANTS) else 1


def self_test(root: pathlib.Path) -> int:
    """Disable each rostered case in turn and require the baseline to refuse."""
    test = root / TEST
    original = test.read_bytes()
    digest = hashlib.sha256(original).hexdigest()
    refusals = []
    try:
        for target in ROSTER:
            text = original.decode()
            spelled = target.replace("'", "\\'")
            before = f"test('{spelled}'"
            if text.count(before) != 1:
                print(f'SELF-TEST NOT PLANTED: {target!r} does not appear exactly once in {TEST}')
                return 2
            test.write_text(text.replace(before, f"test.skip('{spelled}'", 1))
            done = subprocess.run([sys.executable, __file__, '--root', str(root), '--baseline-only'],
                                  capture_output=True, text=True)
            refused = done.returncode == 2 and 'BASELINE-FAIL' in done.stdout and 'skipped' in done.stdout
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
