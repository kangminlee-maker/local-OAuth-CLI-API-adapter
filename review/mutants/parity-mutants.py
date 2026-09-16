#!/usr/bin/env python3
"""Codex native completion-parity mutation testing: one mutant per new guard,
each killed by the committed fixture that pins it. Plant -> build -> run the
pinning fixture (balanced --test-name-pattern) -> assert fail>=1 -> restore."""
import subprocess, sys, pathlib

# The original run used a scratch worktree at `../parity-worktree`, which no
# longer exists. This checkout is the default; pass a path to run elsewhere.
ROOT = pathlib.Path(sys.argv[sys.argv.index('--root') + 1]) if '--root' in sys.argv \
    else pathlib.Path(__file__).resolve().parents[2]
SRC = ROOT / 'src/chat/codex-native-session.ts'
LOG = pathlib.Path(__file__).resolve().parents[2] / 'review' / 'logs'
TEST = 'test/native-session-interrupt.test.mjs'

# (name, pattern, needle, replacement)
MUTANTS = [
    # G1: drop the usage grace — close on turn/completed regardless, so the
    # trailing (post-completion) usage is dropped again.
    ('MP1-usage-grace-removed', 'parity G1',
     "      turn.queue.push(event);\n"
     "      // Usage already delivered (a pre-completion usage line): close now.\n"
     "      if (turn.usageSeen) {\n"
     "        turn.queue.close();\n"
     "        return;\n"
     "      }\n"
     "      // Otherwise hold the queue open a bounded grace; the trailing usage closes\n"
     "      // it early, the timer at expiry if none ever arrives (G1).\n"
     "      turn.usageGraceTimer = setTimeout(() => {\n"
     "        turn.usageGraceTimer = null;\n"
     "        turn.queue.close();\n"
     "      }, USAGE_GRACE_MS);\n"
     "      turn.usageGraceTimer.unref?.();\n"
     "      return;",
     "      turn.queue.push(event);\n"
     "      turn.queue.close(); /* MP1: no usage grace */\n"
     "      return;"),
    # G2: ignore params.turn.status — a failed completion falls through to a
    # normal close and is projected as a success.
    ('MP2-failed-status-ignored', 'parity G2',
     "      const completedTurn = asRecord(data?.turn);\n"
     "      if (completedTurn?.status === 'failed') {\n"
     "        // The child's error is the authority (the shape the app-server sibling\n"
     "        // rejects with); `failActive` retires this turn with it (G2).\n"
     "        this.failActive(new Error(JSON.stringify(completedTurn.error ?? 'codex turn failed')));\n"
     "        return;\n"
     "      }\n",
     "      const completedTurn = asRecord(data?.turn);\n"
     "      void completedTurn; /* MP2: failed status ignored */\n"),
    # G3: re-introduce the lossy fixed-count pre-ack buffer.
    ('MP3-preack-slice-restored', 'parity G3',
     "      this.bufferedNotifications.push(event);\n"
     "      return;\n"
     "    }\n"
     "    this.routeNamedNotification(turn, method, data, event);",
     "      this.bufferedNotifications.push(event);\n"
     "      this.bufferedNotifications = this.bufferedNotifications.slice(-100); /* MP3 */\n"
     "      return;\n"
     "    }\n"
     "    this.routeNamedNotification(turn, method, data, event);"),
    # F1 fold: the buffered-replay half must route through routeNamedNotification
    # too (both halves must agree). Reverting the flush loop to the old inline
    # close-on-method body passes the whole suite but regresses a pre-ack failed
    # completion to a false success — the flush-side G2 defect. Pinned by the new
    # 'parity G2 preack-failed' fixture.
    ('MP4-flush-inline-bypass', 'parity G2 preack-failed',
     "      const method = typeof rawRec?.method === 'string' ? rawRec.method : '';\n"
     "      this.routeNamedNotification(turn, method, params, event);",
     "      turn.queue.push(event); /* MP4 */\n"
     "      if (typeof rawRec?.method === 'string' && rawRec.method === 'turn/completed') turn.queue.close();"),
    # codex-review fold: G3's removal of slice(-100) turned a bounded stale-buffer
    # leak into an unbounded one — a turn stopped while parked on the interrupt gate
    # retires without flush or replace, retaining its pre-ack burst for the session's
    # life. retire() now releases the buffer with the turn that owns it. Reverting
    # that (keep this.turn=null, drop the buffer clear) reinstates the leak.
    ('MP5-retire-keeps-buffer', 'stopped-preack-buffer',
     "    if (this.turn === turn) {\n"
     "      // The pre-ack buffer holds only the current turn's unnamed-window\n"
     "      // notifications. A turn retired before it was named — stopped while parked\n"
     "      // on the interrupt gate — is neither flushed (`flushBufferedNotifications`)\n"
     "      // nor replaced (`replaceChild` clears it), so without this the buffer is\n"
     "      // retained for the session's life: bounded before by `slice(-100)`, now\n"
     "      // unbounded (G3). Release it with the turn that owns it.\n"
     "      this.bufferedNotifications = [];\n"
     "      this.turn = null;\n"
     "    }",
     "    if (this.turn === turn) this.turn = null; /* MP5: buffer not released on retire */"),
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
            print(f'{name}: {results[name]}', flush=True); continue
        SRC.write_text(orig.replace(needle, repl))
        if run(['npx', 'tsc', '-p', 'tsconfig.json'], LOG / f'pm-{name}-build.log') != 0:
            results[name] = 'BUILD-FAIL'; print(f'{name}: BUILD-FAIL', flush=True)
            SRC.write_text(orig); continue
        run(['node', '--test', f'--test-name-pattern={pattern}', TEST], LOG / f'pm-{name}-test.log')
        out = (LOG / f'pm-{name}-test.log').read_text()
        tests = passn = failn = None
        for line in out.splitlines():
            s = line.strip()
            if s.startswith('ℹ tests'): tests = int(s.split()[-1])
            if s.startswith('ℹ pass'): passn = int(s.split()[-1])
            if s.startswith('ℹ fail'): failn = int(s.split()[-1])
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
subprocess.run(['npx', 'tsc', '-p', 'tsconfig.json'], cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
sys.exit(0 if allkilled else 1)
