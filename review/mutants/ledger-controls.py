#!/usr/bin/env python3
"""Negative controls for the A/A measurement ledger's durability.

The ledger is where a paid observation lives while a run is still running. The
shipped save opened the sole good copy with truncation and rewrote the whole JSON
object in place, so a write that failed part-way left zero readable copies and a
paid run that no shipped path could resume. Each mutant here restores one part of
that and requires the named case to fail.

    python3 ledger-controls.py --root <repo>
"""
import argparse, hashlib, pathlib, re, subprocess, sys

sys_path = str(pathlib.Path(__file__).parent)
if sys_path not in sys.path:
    sys.path.insert(0, sys_path)
from control_baseline import read_baseline

SOURCE = 'scripts/lib/ledger.mjs'
TEST = 'test/ledger.test.mjs'

ROSTER = [
    'a saved ledger reads back, and the copy beside it is kept',
    'the complete new content is on disk before the ledger is opened for truncation',
    'a ledger truncated mid-write is recovered from the shadow',
    'a ledger nobody wrote is a fresh run, not a crash',
    'the only copy that parses is not the one a failing write consumes',
    'the shadow is replaced, and the ledger is not',
    'a ledger that exists and cannot be read is not a run that has not started',
    'the newest generation wins, whichever file holds it',
    'the ledger keeps its inode, because the lock is keyed on it',
]

MUTANTS = [
    ('D1-no-shadow-before-the-truncation',
     'the complete copy written BESIDE the ledger, so the dangerous instant has zero readable copies',
     [("  writeFileSync(`${shadowOf(path)}.writing`, body);\n"
       "  renameSync(`${shadowOf(path)}.writing`, shadowOf(path));", "")],
     'the complete new content is on disk before the ledger is opened for truncation'),
    ('D2-shadow-never-read',
     'the fallback, so a truncated ledger reads as a fresh run and the paid rows are gone',
     [("  const copies = [readCopy(path), readCopy(shadowOf(path))];\n  const readable",
       "  const copies = [readCopy(path)];\n  const readable")],
     'a ledger truncated mid-write is recovered from the shadow'),
    ('D3-newest-decided-by-position',
     'the generation comparison, so which copy is current is whichever name was tried first',
     [("    const { generation, ...state } = readable.reduce(\n"
       "      (best, copy) => (copy.generation > best.generation ? copy : best),\n    ).state;",
       "    const { generation, ...state } = readable[0].state;")],
     'the newest generation wins, whichever file holds it'),
    ('D4-unreadable-is-a-fresh-run',
     'the refusal, so a ledger that exists and cannot be read re-grants the whole ceiling',
     [("  if (copies.some((copy) => copy.exists)) throw new UnreadableLedgerError(path);", "")],
     'a ledger that exists and cannot be read is not a run that has not started'),
    ('D5-save-replaces-the-inode',
     'the in-place rewrite, replacing the ledger the lock is keyed on',
     [("  writeFileSync(path, body);\n}", "  renameSync(shadowOf(path), path);\n}")],
     'the shadow is replaced, and the ledger is not'),
    ('D6-shadow-truncated-in-place',
     'the rename, so a write that fails part-way consumes the only copy that parses',
     [("  writeFileSync(`${shadowOf(path)}.writing`, body);\n"
       "  renameSync(`${shadowOf(path)}.writing`, shadowOf(path));",
       "  writeFileSync(shadowOf(path), body);")],
     'the only copy that parses is not the one a failing write consumes'),
    ('D7-generation-never-advances',
     'the increment, so every copy claims the same age and the newer one cannot be found',
     [("  const body = `${JSON.stringify({ ...state, generation: (newest?.generation ?? 0) + 1 }, null, 2)}\\n`;",
       "  const body = `${JSON.stringify({ ...state, generation: 1 }, null, 2)}\\n`;")],
     'the newest generation wins, whichever file holds it'),
    ('D8-generation-leaks-into-the-state',
     'the strip, so a caller round-trips a counter it does not maintain',
     [("    const { generation, ...state } = readable.reduce(\n"
       "      (best, copy) => (copy.generation > best.generation ? copy : best),\n    ).state;\n"
       "    return state;",
       "    return readable.reduce((best, copy) => (copy.generation > best.generation ? copy : best)).state;")],
     'a saved ledger reads back, and the copy beside it is kept'),
    ('D9-absent-is-a-crash',
     'the null for a ledger nobody wrote, so a fresh run throws instead of starting',
     [("  return null;\n}", "  throw new UnreadableLedgerError(path);\n}")],
     'a ledger nobody wrote is a fresh run, not a crash'),
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
        print(f'BASELINE-FAIL: {why or f"rc={code}"}.')
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
                print(f'[{tag}] NOT PLANTED — a target does not occur exactly once', flush=True)
                continue
            if tag == 'D5-save-replaces-the-inode':
                text = text.replace("import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';",
                                    "import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';")
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
