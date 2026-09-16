# review

The instruments this repository's gates are measured with, and the receipts that
say what they measured.

They used to live outside the checkout, in a sibling `review-artifacts/`
directory, and that cost real money three times in one round:

- a bad edit truncated `supplied-echo-mutants.py` and the tail had to be
  reconstructed from a stale copy buried in an old review worktree — the only
  other copy anyone had;
- a source change moved two lines the table's needles named, and the mutants
  stopped being planted with nothing to say so;
- a renamed test left a mutant's `--test-name-pattern` matching nothing, so the
  test process sat on an open server handle until the harness timed it out. A
  TIMEOUT is not a weak verdict. It is an absent one.

All three are one thing: **the instrument lived outside the tree it measures**,
so a change to the code and the change its mutant table needs could not land in
one diff. In here, they can.

Nothing in this directory ships. `package.json` carries an explicit `files`
allowlist and the package is private.

## Layout

    review/mutants/       the mutation runners and the harness they share
    review/receipts/      what each campaign changed, and what its tables said
    review/tables/<rev>/  the table runs the receipts cite, by revision
    review/logs/          per-mutant build and test output; gitignored working space

## Running a table

Every runner defaults to THIS checkout and writes its per-mutant output to
`review/logs/`:

    python3 review/mutants/ledger-controls.py --root .

Pass `--root` to measure a different tree. A detached worktree is the usual
choice, so the working checkout is never the thing being mutated — and the table
that belongs in a receipt is the runner's STDOUT, kept under `review/tables/`:

    REV=$(git rev-parse --short HEAD)
    git worktree add --detach /tmp/wt HEAD
    mkdir -p review/tables/$REV
    python3 review/mutants/supplied-echo-mutants.py --root /tmp/wt \
      > review/tables/$REV/se-$REV.log

A run prints the subject revision, its own digest, the digest of the harness, and
one verdict per mutant, and it restores every file it touched and says whether the
restoration matched. Read `ALL KILLED`, `RESTORED` and `DIST MATCHES TREE`
together: a table that did not restore is a table whose next line is about a tree
nobody can name.

## What a verdict means

A mutant is a claim about what an input distinguishes, not a claim that a line is
covered. The failure modes that have actually happened here:

| verdict | what it means |
| --- | --- |
| `KILLED` | some named test failed with the mutant planted. The claim holds. |
| `SURVIVED` | no test told the difference. The input that would has not been written yet. |
| `NOT PLANTED` | the needle no longer occurs. The mutant is about code that moved. |
| `TIMEOUT` | no test matched the pattern and the file's `before` hook hung. **This control proves nothing.** |

Two more that a green table can hide: a mutant that edits an ASSERTION into a
tautology can never be killed, because no test watches a test — such a mutant has
to become a DATA or PRODUCT mutant instead. And a mutant scored by a NEIGHBOUR
proves nothing about the rule it was aimed at: if an unconditional change fails
fourteen tests and twelve have nothing to do with the gate, narrow the mutant
until only the gate can see it.

## Where `review-artifacts/...` points

Thirty-four paths across the docs and receipts in this repository cite
`review-artifacts/<something>` — a seat's report, a round's evidence directory,
a probe's output. Until 2026-09-16 that was a sibling directory on one machine,
so none of those citations resolved for anyone else.

They resolve here:

    https://github.com/kangminlee-maker/local-OAuth-CLI-API-adapter-review

Private, and holding what each review WROTE: seat reports, the packets they
answered, run logs, and these receipts. The checkouts each round worked in are
NOT there — every report names the revision it reviewed, and
`git worktree add --detach <dir> <rev>` brings the tree back.

A path written `review-artifacts/x/y` in this repository means `x/y` in that one.

## Logs

`review/tables/<rev>/` holds the table summaries the receipts cite by name — the
runner's stdout, a few kilobytes each. The per-mutant build and test logs land in
the gitignored `review/logs/`, and the review seats' own session transcripts stay
in the out-of-tree archive. Nothing in a receipt depends on either.

A worktree under a temporary directory can be swept out from under a run: the
scratchpad one used here lost its `.git` between campaigns, and the harness
answered `SUBJECT-FAIL` instead of producing counts for a tree it could not name.
That is the intended behaviour — recreate the worktree and run again.
