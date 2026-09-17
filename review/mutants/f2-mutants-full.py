#!/usr/bin/env python3
"""F2 fold mutation testing: one mutant per new guard, each killed by the
committed fixture that pins it. Plant -> build -> run the pinning fixture (by a
balanced --test-name-pattern) -> assert fail>=1 -> restore, byte-for-byte."""
import subprocess, sys, pathlib

ROOT = pathlib.Path(__file__).resolve().parents[2]
SRC = ROOT / 'src/chat/codex-native-session.ts'
LOG = pathlib.Path(__file__).resolve().parents[2] / 'review' / 'logs'
TEST = 'test/native-session-interrupt.test.mjs'

# (name, pattern, needle, replacement)
MUTANTS = [
    ('M1-done-drops-replaceChild', 'reach the dead child',
     "        if (err && this.child === child && !this.closed) {\n"
     "          void this.replaceChild().catch(() => undefined);\n"
     "        }\n"
     "        settle();",
     "        if (err && this.child === child && !this.closed) {\n"
     "          void 0; /* M1 */\n"
     "        }\n"
     "        settle();"),
    ('M2-admission-wait-removed', 'reach the dead child',
     "      const gate = this.interruptGate;\n"
     "      if (gate) {\n"
     "        await Promise.race([gate.promise, turn.stopped$]);\n"
     "        if (turn.stopped) throw new Error('local CLI chat turn aborted');\n"
     "      }\n",
     "      /* M2 */\n"),
    ('M3-stdin-routing-removed', 'reach the dead child',
     "    child.stdin.on('error', (err) => {\n"
     "      if (this.child !== child) return;\n"
     "      if (this.interruptGate && this.interruptGate.child === child) {\n"
     "        this.interruptGate.done(err);\n"
     "        return;\n"
     "      }\n"
     "      this.failActive(err);",
     "    child.stdin.on('error', (err) => {\n"
     "      if (this.child !== child) return;\n"
     "      /* M3 */\n"
     "      this.failActive(err);"),
    ('M4-gate-not-installed', 'reach the dead child',
     "    bound.unref?.();\n"
     "    this.interruptGate = gate;\n",
     "    bound.unref?.();\n"
     "    /* M4 */\n"),
    ('M5-close-routing-removed', 'child that EXITS',
     "      if (this.interruptGate && this.interruptGate.child === child) {\n"
     "        this.interruptGate.done();\n"
     "        this.forgetChild(exit);\n"
     "        return;\n"
     "      }\n",
     "      /* M5 */\n"),
    ('M6-child-error-routing-removed', 'child ERROR while',
     "    child.on('error', (err) => {\n"
     "      if (this.child !== child) return;\n"
     "      if (this.interruptGate && this.interruptGate.child === child) {\n"
     "        this.interruptGate.done(err);\n"
     "        return;\n"
     "      }\n"
     "      this.failActive(err);\n"
     "    });",
     "    child.on('error', (err) => {\n"
     "      if (this.child !== child) return;\n"
     "      /* M6 */\n"
     "      this.failActive(err);\n"
     "    });"),
    ('M7-bound-neutered', 'neither accepted nor errored',
     "    bound = setTimeout(() => gate.done(), this.timeoutMs);",
     "    bound = setTimeout(() => gate.done(), 0x7fffffff); /* M7 */"),
    ('F10-acceptance-ignored', 'holds the next turn only until acceptance',
     "        onWriteSettled ? (err) => onWriteSettled(err ?? undefined) : undefined,",
     "        onWriteSettled ? () => {} : undefined, /* F10 */"),
    ('extractor-nested-ignored', 'plain codex turn routes its own',
     "  const nested = asRecord(data?.turn);\n"
     "  return typeof nested?.id === 'string' ? nested.id : undefined;",
     "  return undefined; /* nested ignored */"),
    ('extractor-toplevel-ignored', 'plain codex turn routes its own',
     "  if (typeof data?.turnId === 'string') return data.turnId;",
     "  if (typeof data?.turnId === 'string') return undefined; /* toplevel ignored */"),
    ('mismatch-check-removed', 'nested-id turn/completed arriving AFTER',
     "    if (turn.turnId && turnId !== turn.turnId) return;",
     "    /* mismatch removed */"),
    ('notifB-idless-not-dropped', 'id-less tail arriving',
     "    if (turnId === undefined) return;",
     "    /* notifB */"),
    ('R2M1-early-delta-dropped', 'early delta arriving before',
     "    if (turnId === undefined) return;",
     "    if (turnId === undefined || method === 'item/agentMessage/delta') return; /* R2-M1 */"),
    # Round-3 fold: the three test-quality findings the final two-seat review named.
    # MG1 (Fable): the settled gate must clear itself, else a later stdin error on
    # the same child is swallowed by the stale gate rather than replacing it.
    ('MG1-gate-not-cleared', 'gate-clear',
     "        if (this.interruptGate === gate) this.interruptGate = null;",
     "        /* MG1: gate not cleared on settle */"),
    # MG2 (Fable): the admission wait must race the parked turn's own stop, else a
    # stop on a parked turn is not honored (its native retirement is deferred) until
    # the wedged gate's bound — a whole timeoutMs. Finer than M2 (which drops the
    # whole wait): MG2 keeps `await gate.promise`, dropping only `turn.stopped$`.
    ('MG2-stopped-race-dropped', 'stopped-parked',
     "        await Promise.race([gate.promise, turn.stopped$]);",
     "        await gate.promise; /* MG2: admission wait no longer races turn.stopped$ */"),
    # M-D (codex, F2-FINAL-1): the bound must settle the gate as ACCEPTED, not as a
    # failed write. Misclassified as failed, the bound replaces the child and lets
    # the wedged next turn complete on the successor — bypassing the interrupt. The
    # rewritten bound fixture (backpressure-modeled) kills it.
    ('M-D-bound-as-failed', 'F2 bound',
     "    bound = setTimeout(() => gate.done(), this.timeoutMs);",
     "    bound = setTimeout(() => gate.done(new Error('bound-as-failed')), this.timeoutMs); /* M-D */"),
    # P-D (Fable final-fold review): a bound VALUE mutant. The original bound
    # fixture's flat `< 5000ms` release assert had ~7x slack and let this survive;
    # the strengthened `< 2*bound + 1500` assert kills it (the next turn is released
    # far past the bound and the wedged turn/start RPC timeout stretches to match).
    ('P-D-bound-tripled', 'F2 bound',
     "    bound = setTimeout(() => gate.done(), this.timeoutMs);",
     "    bound = setTimeout(() => gate.done(), this.timeoutMs * 3); /* P-D */"),
]

def run(cmd, logf):
    with open(logf, 'w') as f:
        return subprocess.run(cmd, cwd=ROOT, stdout=f, stderr=subprocess.STDOUT, text=True).returncode

orig = SRC.read_text()
results = {}
try:
    for name, pattern, needle, repl in MUTANTS:
        n = orig.count(needle)
        if n != 1:
            results[name] = f'ANCHOR-FAIL(count={n})'
            print(f'{name}: {results[name]}', flush=True)
            continue
        SRC.write_text(orig.replace(needle, repl))
        if run(['npx', 'tsc', '-p', 'tsconfig.json'], LOG / f'mf-{name}-build.log') != 0:
            results[name] = 'BUILD-FAIL'
            print(f'{name}: BUILD-FAIL', flush=True)
            SRC.write_text(orig); continue
        run(['node', '--test', f'--test-name-pattern={pattern}', TEST], LOG / f'mf-{name}-test.log')
        out = (LOG / f'mf-{name}-test.log').read_text()
        tests = passn = failn = None
        for line in out.splitlines():
            s = line.strip()
            if s.startswith('ℹ tests'): tests = int(s.split()[-1])
            if s.startswith('ℹ pass'): passn = int(s.split()[-1])
            if s.startswith('ℹ fail'): failn = int(s.split()[-1])
        # A pattern that matched zero tests is a vacuous pass, not a kill.
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
print(f'\nALL KILLED: {allkilled}', flush=True)
# rebuild clean at the end
subprocess.run(['npx', 'tsc', '-p', 'tsconfig.json'], cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
sys.exit(0 if allkilled else 1)
