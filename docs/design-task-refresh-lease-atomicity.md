# Design task: the refresh lease's remaining check-then-act gaps

**Status:** closed 2026-09-08 (Track A). Gap 4 — the ordinary-concurrency-reachable
one — is fixed; gaps 1–3 are a documented suspend-class residual (below), left
open by decision, not oversight. Filed 2026-09-06 from rounds 52–54 of the PR #15
review campaign; resolved after a two-provider design (Fable frontier + codex
gpt-5.6-sol) whose artifacts are in `review-artifacts/track-a/`.
**Scope:** `withRefreshLock`, `unlinkOwnLock`, `lockOwner`, `removeStaleLock` and
`refreshAuth`'s re-read/save in `src/proxy/codex-backend-transport.ts`.

## What holds today

The Codex OAuth token refresh is serialized by a file lease: `auth.json.refresh.lock`,
created with `wx`, naming its owner; a lease older than `REFRESH_LOCK_STALE_MS` (60 s) is
taken over; the token fetch is bounded to half of that (`REFRESH_FETCH_BUDGET_MS`), so a
live owner's fetch cannot outlast its lease; an owner removes only a lock still naming it;
and a refresh is persisted only while the lease still names its owner AND `auth.json` still
carries the refresh token it consumed — otherwise it returns what it got, unsaved. What is
saved is merged onto the file as re-read. Every one of those rules is pinned by a fixture
in `test/codex-backend-transport.test.mjs` (search `r52-codex`, `r53-fable`, `r54-fable`,
`r55-codex`, `r56-fable`).

## Gap 4 — fixed (this change)

The post-fetch re-read counted a file as usable once it parsed as JSON, but the
"moved generation" branch calls `authFromFile`, which needs `access_token` and an
account id. A concurrent writer leaving a parseable-but-token-less file — a codex
CLI logout, or a torn write showing `{}` — was treated as a moved generation, so
the caller kept its refreshed auth **unsaved** and the single-use rotation was
persisted **nowhere**: if the writer's *completed* file carried the same refresh
generation, the next refresh read that stale token, earned a 401, and forced a
re-login. This is the one gap reachable in **ordinary concurrency** (any logout /
torn write during a refresh — no suspend needed).

The fix separates "parses as JSON" from "a usable generation": a re-read that
parses but is neither this refresh's own generation (ours to save, even if it lost
its identity members — restored by `withIdentityFrom`) nor a usable moved
generation is retried once, the same 50 ms a parse failure already is. The
completed write the retry then reads is saved onto, so the rotation lands on the
writer's completed generation instead of nowhere. A still-token-less file after the
retry (a completed logout) keeps the fetched auth unsaved and is not written over
(r56 preserved). Pinned by `r57-track-a` and four mutants
(`review-artifacts/stage2/track-a-mutants.py`, all killed); r54-codex (usable moved
generation) and r55-codex (lost-identity save, unreadable-file decline) unchanged.

## Gaps 1–3 — suspend-class residual (open by decision)

Three rules are check-then-act on a pathname, not atomic:

1. `unlinkOwnLock` reads the lock's owner, then unlinks by path. A takeover landing between
   the read and the unlink removes the taker's lock.
2. The save verifies the lock still names its owner, then renames the new file onto
   `auth.json`. A takeover, or an outside writer, landing between the check and the rename
   is overwritten.
3. `removeStaleLock` decides staleness from `stat` and then unlinks by path: a fresh owner
   that replaced the pathname between the two is removed, and the waiter takes a lease over
   a refresh already in flight (codex round 55).

**Reachability — a continuity break, not ordinary contention.** Each needs a
takeover — a lease older than 60 s — to land inside the microsecond window of an
owner whose fetch is bounded to 30 s. On the live path that requires the owner's
process to be *stalled longer than its own lease mid-refresh*: a machine/VM
suspend, a `SIGSTOP`/cgroup freeze, or a **forward wall-clock step > 60 s** (an NTP
correction or VM-resume clock jump makes a live fresh lease read "stale" —
`removeStaleLock` compares `Date.now() - mtimeMs`, and there is no portable
cross-process monotonic clock to fix it with). codex round 53 reproduced 1–2 by
widening the window with a FIFO; Fable round 54 measured the ordinary interleavings
and found them serialized. Worst case on a hit: an older-but-valid rotation lands,
the next refresh 401s once, one re-login.

**Gap 2 has a second arm that is NOT suspend-class but is adapter-irreducible.**
The codex CLI writes `auth.json` by the same path and honors no lease; a CLI write
landing between the refresh's last generation re-read and its rename is overwritten,
in ordinary concurrency. Lost-update prevention on a fixed pathname requires *both*
writers to honor one discipline, which only a change to the codex CLI could add. It
is bounded today by the merge-onto-freshest-re-read (the loss is confined to a CLI
write inside that final read→rename window, and r54 governs everything before it).

## Why not close gaps 1–3 now

Two independent frontier designs converged (`review-artifacts/track-a/SYNTHESIS.md`):

- **No zero-dependency construction over Node's stdlib closes 1–3 while keeping the
  floor.** The only conditional filesystem transition Node exposes is
  absent→present (`open O_EXCL` / `link`); every present→absent (`unlink`) and
  present→present′ (`rename`) transition is unconditional at the syscall instant, so
  conditioning a release or a stale-takeover on the lock's current owner is exactly
  the compare-and-swap the API lacks. A speculative "grab into a private name, then
  restore" (rename the slot away, re-check the captured inode, `link` it back) was
  designed and then broken adversarially: it publishes a transient empty canonical
  slot, so a third waiter can acquire over a fresh live lease and the restore loses
  to `EEXIST` — destroying a valid lease and admitting two concurrent persists,
  which violates the r52/r53 floor (the taker's lock stays intact; exactly one
  persists). The persist backstop (`stillHeld()` then `rename` onto the fixed
  `auth.json`) is independently check-then-act with no conditional-rename escape.
- **A handle-bound OS advisory lock (`flock`/`fcntl`) would close 1–3**, but Node's
  standard library does not expose it, so it costs a **native dependency** (the
  packaging build-script allowlist is `sharp` and `ajv` today) plus a Windows
  divergence and a non-toggleable all-participant protocol on a credential path — and
  it still does **not** close gap 2's uncooperative-CLI arm, and it would re-semanticise
  the r52/r53 takeover floor (a suspended owner keeps its `flock`, so staleness
  takeover could no longer displace it). Paying a native dependency to close only the
  suspend-class arms, while the ordinary-reachable CLI arm stays open, is not
  justified now.

**Decision:** ship the gap-4 fix; leave 1–3 as the residual above. Revisit the
`flock` route (with the deliberate floor rewrite it entails) only if suspend-class
incidents appear in the field. A fencing token was rejected as inert — nothing
checks it at `rename` time, so it is a produced value with no consumer that changes
the outcome.
