"""The part of a mutation run that is not the mutants.

Two gates now have mutant tables and both need the same discipline around them:
establish which tree the counts belong to, prove the pinning tests pass
UNMUTATED first, plant one change at a time, build when the source is
TypeScript, run the pinning test, and restore — verifying the restoration by
digest at exit. Duplicating that harness would mean the next improvement to it
lands in one copy and not the other, which is how two runners come to disagree
about what a KILLED verdict is worth.

A caller supplies only what is specific to its gate: the files it mutates, the
tests that must pass unmutated, the mutant table, and any transform that is not
a literal string replacement.
"""
import hashlib
import shutil
import json
import pathlib
import subprocess
import sys


def repo_root():
    """The checkout these runners live in.

    It used to be an absolute path typed into every runner, which is what living
    outside the repository costs: the runner could not say which tree it was
    about, and two copies of one runner drifted apart until a review found a
    mutant aimed at a test that had been renamed. A runner under `review/mutants/`
    is two directories below the tree it mutates, and that is the only thing it
    needs to know.
    """
    return pathlib.Path(__file__).resolve().parents[2]


def options(argv, default_root=None, default_log=None):
    def opt(flag, fallback):
        return pathlib.Path(argv[argv.index(flag) + 1]) if flag in argv else pathlib.Path(fallback)
    root = opt('--root', default_root if default_root is not None else repo_root())
    if default_log is None:
        # Beside the receipts that cite them, inside the tree whose revision the
        # log's own header names.
        default_log = repo_root() / 'review' / 'logs'
    log = opt('--log', default_log(root) if callable(default_log) else default_log)
    log.mkdir(parents=True, exist_ok=True)
    return root, log


def run_mutation_suite(*, root, log, prefix, subject, files, baseline, mutants, specials=None, runner_file=None):
    """Plant each mutant, require the pinning test to fail, restore, and report.

    `mutants` are `(name, target, test_file, pattern, needle, replacement)`.
    A `needle` of None means `replacement` names a key in `specials`, whose
    callable takes the file's original text and returns the mutated text.
    """
    specials = specials or {}

    def shell(cmd, logf, timeout=900):
        """Run one command, and never wait forever for it.

        A mutant can make a test process HANG rather than fail: a
        `--test-name-pattern` that matches nothing still runs the file's
        `before` hook, which starts a server, and with no test to reach the
        `after` hook the process sits on an open handle. One such mutant stalled
        a 33-entry table for forty-five minutes with no output, and a table that
        can stall is a table nobody can trust to finish. A timeout turns that
        into a verdict.
        """
        with open(logf, 'w') as handle:
            try:
                return subprocess.run(cmd, cwd=root, stdout=handle, stderr=subprocess.STDOUT,
                                      text=True, timeout=timeout).returncode
            except subprocess.TimeoutExpired:
                handle.write(f'\n[harness] TIMEOUT after {timeout}s: {" ".join(cmd)}\n')
                return None

    def counts(path):
        tests = passn = failn = None
        for line in path.read_text().splitlines():
            s = line.strip()
            if s.startswith('ℹ tests'):
                tests = int(s.split()[-1])
            if s.startswith('ℹ pass'):
                passn = int(s.split()[-1])
            if s.startswith('ℹ fail'):
                failn = int(s.split()[-1])
        return tests, passn, failn

    def git(*argv):
        done = subprocess.run(['git', '-C', str(root), *argv], capture_output=True, text=True)
        if done.returncode != 0:
            print(f'SUBJECT-FAIL: git {" ".join(argv)}: {done.stderr.strip()}', flush=True)
            sys.exit(2)
        return done.stdout.strip()

    # --- SUBJECT: which tree these counts belong to, established rather than
    # asserted by hand. A receipt that names a revision while the run included
    # edits absent from it is the failure this exists to prevent, and the list
    # is what the run compiles or executes — a file that becomes an executed
    # input has to be added to it. `node_modules` and `dist` are outside git and
    # outside this claim. ---
    revision = git('rev-parse', 'HEAD')
    dirty = git('status', '--porcelain', '--', *subject)
    if dirty:
        print('SUBJECT-FAIL: the tree under test differs from any revision, so these counts would '
              f'belong to no named tree:\n{dirty}\n(run this against a clean worktree at the revision '
              'the receipt names)', flush=True)
        sys.exit(2)
    committed = {}
    for line in git('ls-tree', '-r', revision, '--', *subject).splitlines():
        meta, path = line.split('\t', 1)
        committed[path] = meta.split()[2]
    disk = subprocess.run(['git', '-C', str(root), 'hash-object', '--stdin-paths'],
                          input='\n'.join(committed) + '\n', capture_output=True, text=True)
    if disk.returncode != 0:
        print(f'SUBJECT-FAIL: hashing the working tree: {disk.stderr.strip()}', flush=True)
        sys.exit(2)
    tracked = list(committed)
    hashed = disk.stdout.split()
    # The comparison is only as good as its denominator: a quoted path or a
    # short reply would otherwise zip down to a few files and still print clean.
    if len(hashed) != len(tracked) or any(name.startswith('"') for name in tracked):
        print(f'SUBJECT-FAIL: hashed {len(hashed)} of {len(tracked)} tracked inputs', flush=True)
        sys.exit(2)
    for name, blob in zip(tracked, hashed):
        if blob != committed[name]:
            print(f'SUBJECT-FAIL: {name} on disk is {blob[:12]}, not the {committed[name][:12]} '
                  f'that {revision[:12]} holds', flush=True)
            sys.exit(2)
    print(f'SUBJECT {revision} — {len(tracked)} tracked inputs verified against that revision', flush=True)
    if runner_file:
        for path in [pathlib.Path(runner_file), pathlib.Path(__file__)]:
            print(f'RUNNER  {path.name} sha256 {hashlib.sha256(path.read_bytes()).hexdigest()}', flush=True)

    originals = {name: (root / name).read_text() for name in files}
    digests = {name: hashlib.sha256(text.encode()).hexdigest() for name, text in originals.items()}
    results = {}

    def build(tag):
        return shell(['npx', 'tsc', '-p', 'tsconfig.json'], log / f'{prefix}-{tag}-build.log')

    # What the compiler produces, and nothing else. Hashing the whole `dist/`
    # tree also hashed run artifacts — a log a baseline wrote there, or this
    # harness's own — and a rebuild cannot reproduce those, so a legitimate
    # write aborted the run. Executable drift still shows: a mutant that edits
    # compiled code edits one of these.
    COMPILED = ('.js', '.mjs', '.cjs', '.d.ts', '.map')

    def dist_digest():
        """What the gates will actually import, as one digest.

        Measured rather than inferred. The first version tracked a flag set when
        a TypeScript mutant was planted and skipped the rebuild when it was
        clear — and a review wrote an executable mutant that edits `dist/`
        directly and then throws: no TypeScript was planted, the flag stayed
        clear, the summary printed and the next gate ran against a build nothing
        on disk explains.
        """
        digest = hashlib.sha256()
        for path in sorted((root / 'dist').rglob('*')):
            if path.is_file() and path.name.endswith(COMPILED):
                digest.update(str(path.relative_to(root)).encode())
                digest.update(hashlib.sha256(path.read_bytes()).digest())
        return digest.hexdigest()

    baseline_dist = []

    def restore_all(tag):
        """Put every mutated source back AND rebuild the dist from it.

        The gates import `dist/`, not `src/`, so restoring the source alone
        leaves the previous mutant compiled and running. Every mutant that
        follows it and does not itself rebuild — one that edits a test, a spec
        or a script — then reports its verdict against the wrong build.

        This is the only place either happens, and it runs on every exit path.
        The first version rebuilt inline after each mutant and restored sources
        in `finally`: an exception raised between them — a review injected one
        where the test process launches — restored the source, skipped the
        rebuild, and left the dist holding the mutant for whatever ran next.
        """
        for name, text in originals.items():
            (root / name).write_text(text)
        if not baseline_dist or dist_digest() == baseline_dist[0]:
            return
        if build(f'{tag}-restore') != 0:
            # A dist that no longer matches any source is worse than a missing
            # one: it still runs. Nothing here can be trusted after this, so the
            # run ends and says why.
            print(f'RESTORE-BUILD-FAIL: {tag}: the restored source does not compile, so anything '
                  'measured after this would run against a dist matching no source. Aborting.', flush=True)
            sys.exit(2)
        if dist_digest() != baseline_dist[0]:
            print(f'RESTORE-DIST-FAIL: {tag}: the rebuilt dist is not the one the baseline built '
                  'from the same sources. Aborting rather than reporting against it.', flush=True)
            sys.exit(2)

    # --- BASELINE: compile from an EMPTY dist, then every pinning test must
    # PASS unmutated. The build rc is checked so a failed compile aborts instead
    # of testing an older dist. ---
    #
    # Emptied first because `tsc` only writes what it compiles: a compiled file
    # with no source — left by an older tree, or planted — survived the build,
    # entered `baseline_dist`, and `DIST MATCHES TREE: True` then said the run
    # ended where it started, which was true and not what the line claims. A
    # reviewer planted `dist/proxy/round4-phantom.js` with no `.ts` beside it and
    # the harness blessed it. The gates import this directory.
    stale = root / 'dist'
    if stale.exists():
        shutil.rmtree(stale)
    # The log directory is a supported destination and may live inside `dist`.
    # Wiping it out from under the first `shell()` turned a clean-build fix into
    # a crash before the compiler ran.
    log.mkdir(parents=True, exist_ok=True)
    if build('baseline') != 0:
        print('BASELINE-BUILD-FAIL: unmutated source does not compile; aborting so a stale '
              'dist cannot stand in for a passing baseline.', flush=True)
        sys.exit(2)
    if not stale.exists():
        print('BASELINE-BUILD-FAIL: the build wrote no dist at all, so there is nothing for the '
              'gates to import and nothing for DIST MATCHES TREE to mean.', flush=True)
        sys.exit(2)

    # Every emitted file has to have a source that explains it. Emptying the
    # directory first only closes the file that was there BEFORE the build; a
    # file written during it — by anything the compiler's environment carries —
    # walked straight into the baseline digest, and the count printed beside it
    # was compared to nothing. A reviewer did exactly that and the line read
    # `DIST BUILT CLEAN: 57`.
    emitted = sorted(p for p in stale.rglob('*') if p.is_file() and p.name.endswith(COMPILED))
    orphans = []
    for path in emitted:
        rel = str(path.relative_to(stale))
        for suffix in ('.d.ts', '.js.map', '.mjs.map', '.cjs.map', '.js', '.mjs', '.cjs'):
            if rel.endswith(suffix):
                stem = rel[: -len(suffix)]
                break
        else:
            stem = rel
        if not any((root / 'src' / f'{stem}{ext}').exists() for ext in ('.ts', '.tsx', '.mts', '.cts')):
            orphans.append(rel)
    if orphans or not emitted:
        print(f'BASELINE-BUILD-FAIL: {len(orphans)} compiled file(s) have no source under src/ '
              f'({orphans[:5]}), or nothing was emitted at all ({len(emitted)}). A digest taken '
              'over these would certify code the tree does not explain.', flush=True)
        sys.exit(2)
    baseline_dist.append(dist_digest())
    print(f'DIST BUILT CLEAN: {len(emitted)} compiler outputs, every one with a source under src/',
          flush=True)

    # Everything that can dirty the tree or the dist runs inside this — the
    # baseline included. A review injected a preload that edits compiled code
    # and throws during a BASELINE test: the run aborted before reaching the
    # block below and left the edit in place for whatever ran next.
    try:
        baseline_ok = True
        for test_file in baseline:
            logf = log / f'{prefix}-baseline-{pathlib.Path(test_file).stem}.log'
            shell(['node', '--test', test_file], logf)
            t, p, f = counts(logf)
            ok = bool(t) and f == 0 and p == t
            baseline_ok = baseline_ok and ok
            print(f'BASELINE {test_file}: tests={t} pass={p} fail={f} -> {"OK" if ok else "FAIL"}', flush=True)
        if not baseline_ok:
            print('\nBASELINE-FAIL: a pinning test does not pass on unmutated code; KILLED '
                  'verdicts would be meaningless. Aborting.', flush=True)
            sys.exit(2)

        for name, target, test_file, pattern, needle, repl in mutants:
            path = root / target
            original = originals[target]
            if needle is None:
                path.write_text(specials[repl](original))
            else:
                n = original.count(needle)
                if n != 1:
                    results[name] = f'ANCHOR-FAIL(count={n})'
                    print(f'{name}: {results[name]}', flush=True)
                    continue
                path.write_text(original.replace(needle, repl))

            if target.endswith('.ts'):
                if build(name) != 0:
                    results[name] = 'BUILD-FAIL'
                    print(f'{name}: BUILD-FAIL', flush=True)
                    restore_all(name)
                    continue

            cmd = ['node', '--test']
            if pattern:
                cmd.append(f'--test-name-pattern={pattern}')
            cmd.append(test_file)
            rc = shell(cmd, log / f'{prefix}-{name}-test.log')
            tests, passn, failn = counts(log / f'{prefix}-{name}-test.log')
            if rc is None:
                # Not a kill. A hung process proves nothing about the mutant,
                # and reading it as one would credit this control for a stall.
                results[name] = 'TIMEOUT — the test process did not finish; this control proves nothing'
            elif not tests:
                results[name] = f'NO-TESTS-MATCHED(pattern={pattern!r})'
            elif failn and failn >= 1:
                results[name] = f'KILLED (tests={tests} fail={failn})'
            else:
                results[name] = f'SURVIVED (tests={tests} pass={passn} fail={failn})'
            print(f'{name}: {results[name]}', flush=True)
            restore_all(name)
    finally:
        # Also on the way out of an exception, a KeyboardInterrupt, or a
        # `break`: the tree and the dist are put back together before anything
        # else can read either.
        restore_all('exit')

    restored = all(
        hashlib.sha256((root / name).read_text().encode()).hexdigest() == digest
        for name, digest in digests.items()
    )
    print('\n=== SUMMARY ===', flush=True)
    for key, value in results.items():
        print(f'  {key}: {value}', flush=True)
    allkilled = all(value.startswith('KILLED') for value in results.values())
    # Measured here too, so the line is a reading and not a claim about what the
    # code above should have done.
    dist_ok = dist_digest() == baseline_dist[0]
    print(f'\nBASELINE OK: {baseline_ok}   ALL KILLED: {allkilled}   RESTORED: {restored}   '
          f'DIST MATCHES TREE: {dist_ok}', flush=True)
    sys.exit(0 if (allkilled and baseline_ok and restored and dist_ok) else 1)
