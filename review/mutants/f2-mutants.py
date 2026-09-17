#!/usr/bin/env python3
"""F2 mutation testing driver.

For each mutant: apply an exact single-occurrence edit to the codex source,
rebuild dist (tsc), run the F2 fixtures, assert at least one test fails
(mutant killed), then restore the source byte-for-byte.
"""
import subprocess, sys, pathlib, shutil, tempfile, os

ROOT = pathlib.Path(__file__).resolve().parents[2]
SRC = ROOT / 'src/chat/codex-native-session.ts'
LOGDIR = pathlib.Path(__file__).resolve().parents[2] / 'review' / 'logs'
LOGDIR.mkdir(parents=True, exist_ok=True)

MUTANTS = {
    'M1-done-drops-replaceChild': (
        "        if (err && this.child === child && !this.closed) {\n"
        "          void this.replaceChild().catch(() => undefined);\n"
        "        }\n"
        "        settle();",
        "        if (err && this.child === child && !this.closed) {\n"
        "          void 0; /* M1: replacement dropped */\n"
        "        }\n"
        "        settle();",
    ),
    'M2-admission-wait-removed': (
        "      const gate = this.interruptGate;\n"
        "      if (gate) {\n"
        "        await Promise.race([gate.promise, turn.stopped$]);\n"
        "        if (turn.stopped) throw new Error('local CLI chat turn aborted');\n"
        "      }\n",
        "      /* M2: admission wait removed */\n",
    ),
    'M3-stdin-routing-removed': (
        "    child.stdin.on('error', (err) => {\n"
        "      if (this.child !== child) return;\n"
        "      if (this.interruptGate && this.interruptGate.child === child) {\n"
        "        this.interruptGate.done(err);\n"
        "        return;\n"
        "      }\n"
        "      this.failActive(err);",
        "    child.stdin.on('error', (err) => {\n"
        "      if (this.child !== child) return;\n"
        "      /* M3: gate routing removed */\n"
        "      this.failActive(err);",
    ),
    'M4-gate-not-installed': (
        "    bound.unref?.();\n"
        "    this.interruptGate = gate;\n",
        "    bound.unref?.();\n"
        "    /* M4: gate not installed */\n",
    ),
}

def run(cmd, log):
    with open(log, 'w') as f:
        return subprocess.run(cmd, cwd=ROOT, stdout=f, stderr=subprocess.STDOUT, text=True).returncode

def build(log):
    return run(['npx', 'tsc', '-p', 'tsconfig.json'], log)

def f2(log):
    return run(['node', '--test', '--test-name-pattern=t1 F2', 'test/native-session-interrupt.test.mjs'], log)

original = SRC.read_text()
results = {}
try:
    for name, (needle, repl) in MUTANTS.items():
        n = original.count(needle)
        if n != 1:
            print(f'{name}: ANCHOR count={n} (expected 1) -- ABORT', flush=True)
            results[name] = f'ANCHOR-FAIL({n})'
            continue
        SRC.write_text(original.replace(needle, repl))
        brc = build(LOGDIR / f'mut-{name}-build.log')
        if brc != 0:
            print(f'{name}: BUILD FAILED rc={brc}', flush=True)
            results[name] = 'BUILD-FAIL'
            SRC.write_text(original)
            continue
        trc = f2(LOGDIR / f'mut-{name}-test.log')
        out = (LOGDIR / f'mut-{name}-test.log').read_text()
        killed = trc != 0 and (' fail ' in out or '\nℹ fail' in out) and 'fail 0' not in out.split('duration_ms')[0]
        # robust: parse the 'ℹ fail N' line
        failn = None
        for line in out.splitlines():
            s = line.strip()
            if s.startswith('ℹ fail'):
                failn = int(s.split()[-1])
        killed = failn is not None and failn >= 1
        results[name] = f'KILLED (fail={failn})' if killed else f'SURVIVED (fail={failn}, rc={trc})'
        print(f'{name}: {results[name]}', flush=True)
        SRC.write_text(original)
finally:
    SRC.write_text(original)

print('\n=== SUMMARY ===', flush=True)
for k, v in results.items():
    print(f'  {k}: {v}', flush=True)
allkilled = all(v.startswith('KILLED') for v in results.values())
print(f'\nALL KILLED: {allkilled}', flush=True)
sys.exit(0 if allkilled else 1)
