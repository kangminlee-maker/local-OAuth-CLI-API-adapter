#!/usr/bin/env python3
"""A negative control for recon's stale-declaration verdict.

recon's whole claim is that it says BEFOREHAND what a gate will say. It computed
`staleDeclarations` and left it out of the verdict, so a capture whose surface
declares a path absent that the proxy has since started reporting came back
CLEAN while the gate carrying it exits 1. This plants exactly that: the compiled
server is made to emit `.reasoning.mode`, which
`responses-reasoning-mode-is-not-reported` declares absent on `/v1/responses`.

Both instruments are then run against the same planted server. The control is
only worth anything if recon says STALE DECLARATION *and* the gate fails — one
without the other is the disagreement this exists to remove. The compiled server
is restored and its digest verified whatever happens.
"""
import argparse, hashlib, json, pathlib, re, subprocess, sys, tempfile

TARGET = 'dist/proxy/http-server.js'
# The path the plant makes the proxy report, which `responses-reasoning-mode-is-
# not-reported` declares absent on /v1/responses. Asserted, not just planted: a
# control that requires SOME stale path and SOME gate failure would pass on a
# stale path it did not plant and a gate failing for its own reasons.
PLANTED_PATH = '.reasoning.mode'
PLANT_BEFORE = "        summary: reasoning.summary ?? null,\n    };\n}"
PLANT_AFTER = "        summary: reasoning.summary ?? null,\n        mode: 'standard',\n    };\n}"
RECON = pathlib.Path(__file__).with_name('recon-unpromoted.mjs')


def recon(root: pathlib.Path, store: str | None) -> dict:
    with tempfile.NamedTemporaryFile(suffix='.json', delete=False) as handle:
        out = pathlib.Path(handle.name)
    argv = ['node', str(RECON), '--root', str(root), '--all', '--json', str(out)]
    if store:
        argv += ['--store', store]
    done = subprocess.run(argv, cwd=root, capture_output=True, text=True)
    if done.returncode != 0:
        print(done.stdout[-2000:] + done.stderr[-2000:])
        raise SystemExit(f'recon exited {done.returncode}')
    report = json.loads(out.read_text())
    out.unlink()
    tally = {}
    for entry in report:
        tally[entry['verdict']] = tally.get(entry['verdict'], 0) + 1
    stale = [f"{e['run']}/{e['file']}" for e in report if e['verdict'] == 'STALE DECLARATION']
    paths = sorted({path for e in report for path in e.get('staleDeclarations', [])})
    return {'tally': tally, 'stale': stale, 'paths': paths, 'n': len(report)}


def gate(root: pathlib.Path) -> tuple[int, str]:
    done = subprocess.run(['node', '--test', '--test-reporter=tap',
                           'test/conformance-supplied-echo.test.mjs'],
                          cwd=root, capture_output=True, text=True)
    # The failing test names, not the error strings: the error text is nested in
    # the TAP diagnostic block and a regex that misses it prints an empty reason,
    # which reads as "it failed for nothing".
    failed = re.findall(r'^not ok \d+ - (.+)$', done.stdout, re.M)
    return done.returncode, '; '.join(failed[:3]) or '(no failing test named)'


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--root', required=True)
    # The recorded store is gitignored: a clean worktree has none, so the run
    # that produces receipt evidence has to be pointed at the checkout that does.
    ap.add_argument('--store', default=None)
    args = ap.parse_args()
    root = pathlib.Path(args.root).resolve()
    target = root / TARGET
    original = target.read_bytes()
    digest = hashlib.sha256(original).hexdigest()
    print(f'SUBJECT {TARGET} sha256 {digest}', flush=True)

    after = None
    before = recon(root, args.store)
    print(f'BASELINE recon over {before["n"]} captures: {before["tally"]}', flush=True)
    if before['stale']:
        print('BASELINE-FAIL: a stale declaration exists before anything was planted')
        return 2
    code, _ = gate(root)
    print(f'BASELINE gate rc={code}', flush=True)
    if code != 0:
        print('BASELINE-FAIL: the gate does not pass unplanted, so nothing below means anything')
        return 2

    text = original.decode()
    if PLANT_BEFORE not in text:
        print('NOT PLANTED: the compiled reasoning payload no longer looks like this; '
              'this control proves nothing until it is re-aimed')
        return 2
    try:
        target.write_text(text.replace(PLANT_BEFORE, PLANT_AFTER, 1))
        after = recon(root, args.store)
        gate_code, gate_reason = gate(root)
        print(f'PLANTED  .reasoning.mode, which /v1/responses declares absent', flush=True)
        print(f'         recon: {after["tally"]}', flush=True)
        print(f'         recon named {len(after["stale"])} stale on paths {after["paths"]}', flush=True)
        print(f'         first three: {after["stale"][:3]}', flush=True)
        print(f'         gate rc={gate_code}  {gate_reason}', flush=True)
    finally:
        target.write_bytes(original)
        restored = hashlib.sha256(target.read_bytes()).hexdigest()
        print(f'RESTORED {restored == digest} ({restored[:12]})', flush=True)

    # Both halves, on the planted path and nothing else: either alone is the
    # disagreement this exists to remove, and "some stale path" is not the claim.
    agreed = (after is not None
              and after['paths'] == [PLANTED_PATH]
              and bool(after['stale'])
              and gate_code != 0
              and gate_reason != '(no failing test named)')
    print(f'\nRECON AND GATE AGREE ON {PLANTED_PATH}: {agreed}', flush=True)
    return 0 if agreed else 1


if __name__ == '__main__':
    sys.exit(main())
