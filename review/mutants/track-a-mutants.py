#!/usr/bin/env python3
"""Track A (gap-4 re-read reclassification + the same-generation-unusable fold)
mutation testing. Each mutant reverts a decision point of the fix and is killed by
the fixture that pins it. A BASELINE phase first runs every pinning fixture on the
UNMUTATED build and requires it to PASS — so a mutant's failure is attributable to
the mutant, not to a fixture that fails regardless (the false-KILL a review flagged).
Plant -> build (tsc) -> run the pinning fixture(s) -> assert fail>=1 -> restore."""
import subprocess, sys, pathlib

# The original run used a scratch worktree at `review-artifacts/track-a-impl`,
# which no longer exists. This checkout is the default; pass a path to run
# elsewhere.
ROOT = pathlib.Path(sys.argv[sys.argv.index('--root') + 1]) if '--root' in sys.argv \
    else pathlib.Path(__file__).resolve().parents[2]
SRC = ROOT / 'src/proxy/codex-backend-transport.ts'
LOG = pathlib.Path(__file__).resolve().parents[2] / 'review' / 'logs'
TEST = 'test/codex-backend-transport.test.mjs'

RETRY_BLOCK = (
    "      if (!settled(latest)) {\n"
    "        await sleep(50);\n"
    "        latest = await this.loadAuthFile().catch(() => null);\n"
    "      }"
)

# (name, pattern, needle, replacement)
MUTANTS = [
    # MP-A: retry only on a null (unparseable) re-read — the pre-fix behavior. A
    # parseable-but-token-less torn write is not retried, so the rotation strands.
    ('MPA-retry-null-only', 'r57-track-a',
     RETRY_BLOCK,
     "      if (latest === null) {\n"
     "        await sleep(50);\n"
     "        latest = await this.loadAuthFile().catch(() => null);\n"
     "      }"),
    # MP-B: no retry at all.
    ('MPB-retry-removed', 'r57-track-a', RETRY_BLOCK, "      /* MPB: retry removed */"),
    # MP-D: retry sleeps but does not re-read — latest stays the torn `{}`.
    ('MPD-reread-dropped', 'r57-track-a',
     "        await sleep(50);\n"
     "        latest = await this.loadAuthFile().catch(() => null);\n",
     "        await sleep(50);\n"),
    # MP-C: the moved branch throws on a token-less file instead of keeping the
    # fetched auth unsaved — a completed logout then rejects the caller (r56).
    ('MPC-moved-branch-throws', 'r56-fable',
     "        const moved = tryAuthFromFile(latest);\n"
     "        return moved ?? authFromFile(refreshed);",
     "        return authFromFile(latest);"),
    # MP-E: saveCandidate ignores validity — a same-generation file whose identity
    # is present-but-empty is treated as savable, so it is neither retried (settled
    # ours-arm true) nor caught at the save (authFromFile(updated) throws). Killed by
    # r58 (needs the retry) and r59 (needs the keep-unsaved on a stable unusable file).
    ('MPE-savecandidate-any', 'r5[89]-track-a',
     "        return tryAuthFromFile(updated) ? updated : null;",
     "        return updated;"),
    # MP-F: the save-side keep-unsaved fallback throws instead of keeping the fetched
    # auth unsaved — a same-generation file still unusable after the retry then
    # rejects the caller (r59). (Removing the guard outright is a type error: the
    # keep-unsaved branch is compiler-enforced to handle the null, so this mutates
    # its runtime behavior instead.)
    ('MPF-keep-unsaved-throws', 'r59-track-a',
     "      if (updated === null) return authFromFile(refreshed);",
     "      if (updated === null) throw codexRefreshError('MPF');"),
]

# The distinct fixtures the mutants pin — each must PASS on the unmutated build.
BASELINE_PATTERNS = ['r5[6789]-(track-a|fable)']

def run(cmd, logf):
    with open(logf, 'w') as f:
        return subprocess.run(cmd, cwd=ROOT, stdout=f, stderr=subprocess.STDOUT, text=True).returncode

def counts(path):
    tests = passn = failn = None
    for line in path.read_text().splitlines():
        s = line.strip()
        if s.startswith('ℹ tests'): tests = int(s.split()[-1])
        if s.startswith('ℹ pass'): passn = int(s.split()[-1])
        if s.startswith('ℹ fail'): failn = int(s.split()[-1])
    return tests, passn, failn

orig = SRC.read_text()
results = {}
# --- BASELINE: a fresh unmutated build MUST compile, then PASS every pinning
# fixture, so a later KILLED verdict is attributable to the mutant and not to a
# fixture that fails regardless (or to a stale dist). The build rc is checked: a
# failed baseline compile aborts rather than testing an older passing dist.
# NOTE (timing): r59/MPC/MPE/MPF are deterministic pins; r57/r58 and the retry
# mutants MPA/MPB/MPD depend on the completed-file write (atomic temp+rename)
# landing after the first re-read and before the ~50 ms retry — reliable under
# normal scheduling but not a hard ordering guarantee. A one-off timing flake here
# surfaces as a BASELINE fixture FAIL (abort) or a spurious mutant SURVIVED (loud),
# never a silent false KILL. ---
if run(['npx', 'tsc', '-p', 'tsconfig.json'], LOG / 'ta-baseline-build.log') != 0:
    print('BASELINE-BUILD-FAIL: unmutated source does not compile; aborting so a stale '
          'dist cannot stand in for a passing baseline.', flush=True)
    sys.exit(2)
baseline_ok = True
for pat in BASELINE_PATTERNS:
    run(['node', '--test', f'--test-name-pattern={pat}', TEST], LOG / f'ta-baseline-{pat}.log')
    t, p, f = counts(LOG / f'ta-baseline-{pat}.log')
    ok = bool(t) and f == 0 and p == t
    baseline_ok = baseline_ok and ok
    print(f'BASELINE {pat!r}: tests={t} pass={p} fail={f} -> {"OK" if ok else "FAIL"}', flush=True)
if not baseline_ok:
    print('\nBASELINE-FAIL: a pinning fixture does not pass on unmutated code; '
          'KILLED verdicts would be meaningless. Aborting.', flush=True)
    sys.exit(2)

try:
    for name, pattern, needle, repl in MUTANTS:
        n = orig.count(needle)
        if n != 1:
            results[name] = f'ANCHOR-FAIL(count={n})'
            print(f'{name}: {results[name]}', flush=True); continue
        SRC.write_text(orig.replace(needle, repl))
        if run(['npx', 'tsc', '-p', 'tsconfig.json'], LOG / f'ta-{name}-build.log') != 0:
            results[name] = 'BUILD-FAIL'; print(f'{name}: BUILD-FAIL', flush=True)
            SRC.write_text(orig); continue
        run(['node', '--test', f'--test-name-pattern={pattern}', TEST], LOG / f'ta-{name}-test.log')
        tests, passn, failn = counts(LOG / f'ta-{name}-test.log')
        if not tests:
            results[name] = f'NO-TESTS-MATCHED(pattern={pattern!r})'
        elif failn and failn >= 1:
            results[name] = f'KILLED (tests={tests} fail={failn})'
        else:
            results[name] = f'SURVIVED (tests={tests} pass={passn} fail={failn})'
        print(f'{name}: {results[name]}', flush=True)
        SRC.write_text(orig)
finally:
    SRC.write_text(orig)

print('\n=== SUMMARY ===', flush=True)
for k, v in results.items():
    print(f'  {k}: {v}', flush=True)
allkilled = all(v.startswith('KILLED') for v in results.values())
print(f'\nBASELINE OK: {baseline_ok}   ALL KILLED: {allkilled}', flush=True)
subprocess.run(['npx', 'tsc', '-p', 'tsconfig.json'], cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
sys.exit(0 if (allkilled and baseline_ok) else 1)
