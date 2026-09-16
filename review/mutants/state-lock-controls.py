#!/usr/bin/env python3
"""Negative controls for the A/A state lock.

The lock exists so that two runs cannot each spend the batch ceiling and then
erase each other's paid rows. A review got past it twice: once by spelling one
inode two ways, once by letting a departing process unlink a lock it no longer
owned. Neither bypass is visible in a passing suite unless something asserts it,
so each mutant here restores one of the two and requires the named case to fail.

    python3 state-lock-controls.py --root <repo>
"""
import argparse, hashlib, pathlib, re, subprocess, sys

sys_path = str(pathlib.Path(__file__).parent)
if sys_path not in sys.path:
    sys.path.insert(0, sys_path)
from control_baseline import read_baseline

SOURCE = 'scripts/lib/state-lock.mjs'
TEST = 'test/state-lock.test.mjs'

ROSTER = [
    'a symlink alias of the state file is the same writer',
    'a state file that does not exist yet resolves through its directory',
    'two hard links to one ledger are one writer',
    'two hard links in different directories are still one writer',
    'a dangling symlink is the file it will become, not a name of its own',
    'a run that creates the ledger and one that finds it agree',
    'a late release does not free the lock somebody else now holds',
    "a release after the lock was cleared by hand does not take the next run's",
    'the holder is reported by pid, not by token',
    'a name-keyed lock reserves a file that must not exist yet',
    'the lock namespace does not move with the environment',
]

MUTANTS = [
    ('L1-lock-keyed-on-the-spelling',
     'inode identity, so every alias of one ledger takes a lock of its own',
     [("  const { path, key } = stateIdentity(target, { create });",
       "  const path = resolve(target);\n  const key = path.replace(/[^A-Za-z0-9]+/g, '-');")],
     'a symlink alias of the state file is the same writer'),
    ('L1b-realpath-only',
     'the inode key while keeping realpath, which collapses symlinks and cannot collapse hard links',
     [("  const { dev, ino } = statSync(path);\n  return { path, key: `${dev}-${ino}` };",
       "  return { path, key: path.replace(/[^A-Za-z0-9]+/g, '-') };")],
     'two hard links to one ledger are one writer'),
    ('L1c-sidecar-beside-the-file',
     'the one lock directory, so one inode under two directories takes two locks',
     [("  const dir = lockDir ?? lockNamespace();",
       "  const dir = dirname(path);")],
     'two hard links in different directories are still one writer'),
    ('L1d-dangling-link-is-its-own-name',
     'the symlink walk, so a link to a file that is not there yet keeps its own basename',
     [("    if (!link.isSymbolicLink()) return canonicalise(current);",
       "    return canonicalise(current);")],
     'a dangling symlink is the file it will become, not a name of its own'),
    ('L1e-ledger-not-created',
     'the up-front creation, so a run that arrives before the file keys on a name and one that arrives after keys on an inode',
     [("    writeFileSync(path, FRESH_STATE, { flag: 'wx' });",
       "    if (existsSync(path)) throw Object.assign(new Error('exists'), { code: 'EEXIST' });")],
     'a run that creates the ledger and one that finds it agree'),
    ('L1f-artifact-lock-creates-the-artifact',
     "the name key, so reserving a file that must not exist creates it",
     [("  if (!create) {\n    return { path, key: `name-${createHash('sha256').update(path).digest('hex').slice(0, 32)}` };\n  }",
       "")],
     'a name-keyed lock reserves a file that must not exist yet'),
    ('L2-release-is-blind',
     "the ownership check, so a departing process unlinks whatever holds the name",
     [("""  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try {
      if (!readFileSync(lockPath, 'utf8').startsWith(`${token} `)) return;
      unlinkSync(lockPath);
    } catch { /* already gone */ }
  };""",
       "  const release = () => { try { unlinkSync(lockPath); } catch { /* already gone */ } };")],
     'a late release does not free the lock somebody else now holds'),
    ('L3-release-runs-once-but-unchecked',
     'the token check alone, leaving only the once-flag — which a second PROCESS does not share',
     [("      if (!readFileSync(lockPath, 'utf8').startsWith(`${token} `)) return;\n", "")],
     "a release after the lock was cleared by hand does not take the next run's"),
    ('L4-not-yet-existing-file-is-not-resolved',
     "the directory resolution, so two spellings disagree until the file exists",
     [("  return join(canonicalise(parent), basename(absolute));", "  return absolute;")],
     'a state file that does not exist yet resolves through its directory'),
    ('L5-holder-reported-whole',
     'the pid split, so the message names a token nobody can look up',
     [("      heldBy = readFileSync(lockPath, 'utf8').trim().split(':')[0];",
       "      heldBy = readFileSync(lockPath, 'utf8').trim();")],
     'the holder is reported by pid, not by token'),
    ('L6-namespace-follows-the-environment',
     'the environment-invariant rendezvous, so two runs with different TMPDIRs never contend',
     [("    if (statSync('/tmp').isDirectory()) return join(realpathSync('/tmp'), 'aa-noise-floor-locks');",
       "    if (false) return join(realpathSync('/tmp'), 'aa-noise-floor-locks');")],
     'the lock namespace does not move with the environment'),
]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--root', required=True)
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

    code, out = run_suite()
    accepted, reading, why = read_baseline(out, ROSTER)
    print(f'BASELINE rc={code} tests={reading["tests"]} pass={reading["pass"]} '
          f'skipped={reading["skipped"]} todo={reading["todo"]} cancelled={reading["cancelled"]} '
          f'roster={len(ROSTER)}', flush=True)
    if code != 0 or not accepted:
        print(f'BASELINE-FAIL: {why or f"rc={code}"}. No control below means anything until the '
              'whole roster runs and passes.')
        return 2

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
              f'mutant here: {unbacked}', flush=True)
    every = all(verdict == 'KILLED' for _, verdict in results)
    print(f'\nALL KILLED: {every}   ({sum(1 for _, v in results if v == "KILLED")}/{len(results)})',
          flush=True)
    return 0 if every and not unbacked else 1


if __name__ == '__main__':
    sys.exit(main())
