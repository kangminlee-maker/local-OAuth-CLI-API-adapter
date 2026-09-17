# Verification receipt — echoed-defaults conformance gate

A review can read "14/14 killed, suite green" and have no way to re-establish
either number. Every line below names the command that produced it and the tree
it ran on.

Three earlier versions of this file were the defect they were meant to prevent.
The first named `391d25c` while one of its own mutant results targeted code that
first appears in `a676817`. The second named `ac8788e` for a suite that included
edits absent from it, and said so in its own text. The third said the runner
"hashes every tracked input it compiles or executes", which was false: `scripts/`
was outside the list, and a review edited a module the gate imports while the
runner still printed its clean SUBJECT line.

- **Repo**: `/Users/kangmin/Documents/cli-api-adaptor/local-OAuth-CLI-API-adapter`
- **Revision**: `6c78666a364e07aeec1a946a0d6a0316aa0d0b66`
- **Subject**: `review-artifacts/echoed-defaults-evidence`, a detached worktree at
  that revision. `git status --porcelain -- src test spec scripts tsconfig.json
  package.json pnpm-lock.yaml` was empty before the runs and after them. The four
  files belonging to another session's in-progress work exist only in the main
  checkout and are absent here, so the 2092 below is this revision's suite and no
  one else's.
- **Date**: 2026-09-09
- **Logs**: `review-artifacts/stage2/evidence-6c78666/`

## Offline suite

```
$ pnpm test
ℹ tests 2092
ℹ pass 2092
ℹ fail 0            (rc 0 — evidence-6c78666/full-suite.log)
```

2083 -> 2092: the promoter's own check gained nine binding cases.

## The gate and its instruments

```
$ node --test test/conformance-echoed-defaults.test.mjs \
               test/promote-capture.test.mjs \
               test/conformance-stream-terminator.test.mjs
ℹ tests 26
ℹ pass 26
ℹ fail 0            (7 + 15 + 4)
```

## Mutation

```
$ cd review-artifacts/echoed-defaults-evidence
$ python3 ../stage2/echoed-defaults-mutants.py --root . --log ../stage2/evidence-6c78666
SUBJECT 6c78666a364e07aeec1a946a0d6a0316aa0d0b66 — 175 tracked inputs verified against that revision
RUNNER  sha256 c15e5ada97464b98a58a65cca4d3bcc055205a99ba9dd516b759811690d46256
BASELINE test/conformance-echoed-defaults.test.mjs: tests=7 pass=7 fail=0 -> OK
BASELINE test/proxy-http.test.mjs: tests=69 pass=69 fail=0 -> OK
  E1-responses-cache-write-dropped: KILLED (tests=2 fail=1)
  E2-chat-cache-write-dropped: KILLED (tests=2 fail=1)
  E3-reasoning-context-reverted: KILLED (tests=2 fail=1)
  E4-cache-read-sums-writes: KILLED (tests=1 fail=1)
  E5-invented-field: KILLED (tests=2 fail=1)
  E6-images-inherit-responses-usage: KILLED (tests=17 fail=1)
  E7-declaration-emptied: KILLED (tests=2 fail=2)
  E8-fixture-tampered: KILLED (tests=1 fail=1)
  E9-scalar-array-leaked: KILLED (tests=2 fail=1)
  E10-empty-object-becomes-null: KILLED (tests=2 fail=1)
  E11-model-not-echoed: KILLED (tests=2 fail=1)
  E12-output-item-duplicated: KILLED (tests=2 fail=1)
  E13-fanout-total-drops-cache: KILLED (tests=1 fail=1)
  E14-chat-choice-duplicated: KILLED (tests=2 fail=1)
BASELINE OK: True   ALL KILLED: True   RESTORED: True
```

Twelve mutate code; **two mutate data** (`E7` empties the declaration list,
`E8` tampers a promoted fixture) because the gate reads its authority from data
and can be silently emptied there. The runner takes `--root`, so this count is
reproducible in another checkout — every fold reviewer has re-established it that
way. Restoration is verified by digest before it exits, and `git status
--porcelain` over `src test spec scripts` after the run was empty.

The SUBJECT line is a gate, not a caption. **175** is `src` + `test` + `spec` +
`scripts` + `tsconfig.json` + `package.json` + `pnpm-lock.yaml`. `scripts` is in
that list because the conformance gate imports `scripts/lib/capture-provenance.mjs`:
a review edited exactly that file and the previous runner printed "138 tracked
inputs verified against that revision" while executing code absent from it.
Replaying that construction here now stops before any build:

```
SUBJECT-FAIL: the tree under test differs from any revision, so these counts would belong to no named tree:
M scripts/lib/capture-provenance.mjs
```

Per-mutant logs, for reading the assertion each one died on:
`evidence-6c78666/ed-<mutant>-test.log`, with the baselines at
`ed-baseline-conformance-echoed-defaults.test.log` and
`ed-baseline-proxy-http.test.log`, and the run transcripts at `full-suite.log`,
`gate-trio.log`, `mutants.log` and `run.log`.

## That the new mutants had a target

```
$ node review-artifacts/stage2/echoed-defaults-reader-gap.mjs     (in the worktree)
E9  tools: [] -> ["zzz-leaked"]    old=GREEN (invisible)  new=CAUGHT
E10 metadata: {} -> null           old=GREEN (invisible)  new=CAUGHT
E11 model -> a constant            old=GREEN (invisible)  new=CAUGHT
CONTROL temperature 1 -> 2         old=CAUGHT             new=CAUGHT
CONTROL identical bodies           old=GREEN (invisible)  new=GREEN (invisible)
exit 0
```

The positive control rules out "the new reader simply fails everything"; the
negative control rules out "it fails identical bodies". A mutant whose target
does not exist is a green light for nothing.

## Fixture provenance

All six captures in `spec/captures/`, promoted at `172ffce`, each naming **every
first-party source that ran** rather than the entry file alone:

```
revision 172ffce2a615
  scripts/lib/capture-provenance.mjs 4bf38fcc8a76
  scripts/promote-capture.mjs        ed5a0dbc6f07
```

Every stream and body digest is unchanged from the fixtures these replace: the
bytes are still the ones the vendor and the proxy sent, and only the claim about
what wrote them down became checkable. Both conformance gates re-derive that
claim from git — over the whole store, not over the fixtures each one happens to
load — and a stamp is accepted only if the revision is a commit this checkout can
reach and holds each recorded blob at each recorded path.

The stamp names the commit that wrote the fixture, not whatever the promoter
looks like now: `1f3492a` and `6c78666` both changed the module, and the fixtures stay bound
to `172ffce`, which still holds the blobs they record.

Constructions replayed against this binding; each fixture or file was restored
byte-for-byte afterwards:

| planted | reply |
| --- | --- |
| `revision` replaced with forty zeroes | gate: `names revision 000000000000, which this clone does not have` |
| a stamp with no `sources` | gate: `records no promoting sources` |
| a `blob` that is not the one committed there | gate: `claims scripts/promote-capture.mjs is aaaaaaaaaaaa at 172ffce2a615, which holds ed5a0dbc6f07` |
| promoter edited after its commit | promoter: refuses, `does not name the code that is running` |
| **module** edited, promoter committed | promoter: refuses, naming `scripts/lib/capture-provenance.mjs` |
| promoter copied under the ignored `dist/` | promoter: refuses, `does not exist at <revision>` |
| git off `PATH` | promoter: refuses; with the override, writes `{unbound: <reason>}`, which the gate rejects |
| `GIT_DIR`/`GIT_WORK_TREE` pointed at another repository | promoter: binds to the repository it was run in, not the decoy |
| a commit reachable from no branch | gate: `is not in this checkout's history` |
| a promoter that computes a specifier, or bridges to CommonJS | promoter: refuses, `the set of sources that run cannot be derived` |
| `unbound: true` beside a valid triple | gate: `was promoted unbound` |

The promoter's refusals are checked against committed COPIES of it inside
throwaway repositories (`test/promote-capture.test.mjs`), because "edited",
"ignored", "git is missing", "the environment points elsewhere" and "that commit
is abandoned" are properties of a checkout, and asserting them against this one
would turn the promoter's tests red whenever someone edits the promoter.

## What is NOT verified here

- Whether the direct API partitions cache reads and writes on a turn that
  actually uses the cache. P-1/P-3 are zero-cache minimal samples; the two
  fields' PRESENCE and their value `0` are all these bytes establish.
- The branch that fills `max_output_tokens` when it is ABSENT. Both promoted
  requests supply the cap, so that branch never runs under this gate; supplied
  echoes are counted apart from defaults (34+2 and 5+1) so neither can stand in
  for the other, but closing it needs a capture whose request omits the cap.
- Whether the ChatGPT backend ever emits a nonzero `cache_write_tokens`. The
  codex transport does not read it, deliberately (see the comment at
  `usageFromResponses`), and settling it needs a live call.
- **`node_modules` and `dist`.** Neither is in git, so neither the binding nor
  the SUBJECT gate says anything about the compiler, the packages, or a stale
  build artifact; `pnpm-lock.yaml` pins the dependency set by name only. The
  binding walks first-party sources: a specifier that is not relative is the
  runtime, not our code.
- **That a path a stamp names is a promoter.** The binding ties an artifact to
  committed bytes at a reachable revision; it does not prove those bytes can
  promote anything, and it defends against nothing that someone with commit
  rights writes by hand — as is true of every digest in `spec/captures/`.
