# Design task: the refresh lease's remaining check-then-act gaps

**Status:** closed 2026-09-08 (Track A). Gap 4 — a re-read stranding the single-use
rotation, reachable in ordinary concurrency — is fixed; gaps 1–3 are a documented
lock-atomicity residual (below), left open by decision, not oversight, with the
worst case bounded to the r52/r53 class (one recoverable re-login). Filed 2026-09-06
from rounds 52–54 of the PR #15 review campaign; resolved after a two-provider
design (Fable frontier + codex gpt-5.6-sol) and a two-provider code review, whose
artifacts are in `review-artifacts/track-a/` and `review-artifacts/track-a-review/`.
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

The fix separates "parses as JSON" from "a usable generation": a re-read is
*settled* only when it is a usable moved generation, or this refresh's own
generation that can actually be persisted (`saveCandidate` = the response merged
onto the re-read with the identity restored, validated). Anything else —
unreadable, token-less, or a torn same-generation write whose identity is missing
AND unrestorable (present-but-empty, not just absent) — is retried once, the same
50 ms a parse failure already is. The completed write the retry then reads is saved
onto, so the rotation lands on the writer's completed generation instead of nowhere.
Two ways a re-read could otherwise strand the single-use rotation are closed
together: the token-less moved-generation misclassification (the rotation persisted
nowhere), and a same-generation file that could not be validated for the save
(`authFromFile` threw the rotation to the caller). Both now keep the fetched auth
unsaved rather than stranding it — nothing is written over a file that cannot be
read or turned into a usable auth, and nothing is thrown away (the r55/r56
principle, extended to the save side). Pinned by `r57-track-a` (token-less torn
write), `r58-track-a` (present-but-empty identity, retried then saved), and
`r59-track-a` (a stable unusable same-generation file kept unsaved, not thrown) plus
six mutants (`review-artifacts/stage2/track-a-mutants.py`, all killed, over a passing
unmutated baseline); r54-codex (usable moved generation) and r55-codex
(lost-identity save with *absent* members, unreadable-file decline) unchanged.

## Gaps 1–3 — lock-atomicity residual (open by decision)

Three rules are check-then-act on a pathname, not atomic:

1. `unlinkOwnLock` reads the lock's owner, then unlinks by path. A takeover landing between
   the read and the unlink removes the taker's lock.
2. The save verifies the lock still names its owner, then renames the new file onto
   `auth.json`. A takeover, or an outside writer, landing between the check and the rename
   is overwritten.
3. `removeStaleLock` decides staleness from `stat` and then unlinks by path: a fresh owner
   that replaced the pathname between the two is removed, and the waiter takes a lease over
   a refresh already in flight (codex round 55).

**Reachability.** Two distinct triggers, only one of which is a continuity break:

- *Displacing a LIVE owner* (gaps 1 and 2, and gap 3 against a live lease) needs a
  takeover — a lease older than 60 s — to land inside the microsecond window of an
  owner whose fetch is bounded to 30 s, which requires that owner's process to be
  *stalled longer than its own lease mid-refresh*: a machine/VM suspend, a
  `SIGSTOP`/cgroup freeze, or a **forward wall-clock step > 60 s** (an NTP
  correction or VM-resume clock jump makes a live fresh lease read "stale" —
  `removeStaleLock` compares `Date.now() - mtimeMs`, and there is no portable
  cross-process monotonic clock to fix it with). Fable round 54 measured the
  ordinary interleavings against a live lease and found them serialized.
- *A stale ORPHAN plus two waiters* (gap 3, ordinary concurrency — no suspend). A
  process killed mid-refresh (`SIGKILL`, an OOM kill, a crash) leaves its lock; it
  ages past 60 s on its own. Two later refreshes both `open(..., 'wx')`-fail, both
  `stat` the orphan and judge it stale, and race in `removeStaleLock`'s
  `stat`→`unlink` window: the second `unlink(lockPath)` can remove the *fresh* lock
  the first waiter created after taking over, so both proceed to refresh. This needs
  no stalled live owner — only an expected crash orphan and two contenders (codex,
  this review). It can also open the gap-1/gap-2 windows downstream once a fresh
  lock has been wrongly removed.

**Worst case on any hit.** Two refreshes consume the same single-use token. The
`stillHeld()` guard before the save allows **at most one** to persist — never an
unguarded double-persist, and this path never overwrites a concurrently-valid
generation (the only lost-update overwrite is gap 2's separate final-read→rename
CLI arm). But "at most one" includes **zero**: a waiter that took over can find
`stillHeld()` false (a later waiter displaced it) and return its fetched rotation
*unsaved*, while the other waiter's fetch — racing for the same single-use token —
earns a **401 and fails its request outright** (not merely a re-login). The disk is
then left carrying the consumed old token, so subsequent refreshes 401 until the
operator re-logs in. So the harm is bounded to "a rare stale-orphan / suspend /
clock-step race costs one failed request and a forced re-login, recoverable" — not
the stronger "exactly one persists, one re-login" this document previously claimed
(codex fold review). It is worse than a single re-login, but still rare (a crash
orphan or a >60 s stall, plus two contenders interleaving in a microsecond window)
and recoverable, and closing it needs the `flock` route below; revisit that route
if the failed-request/re-login harm shows up in the field.

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
  takeover could no longer displace it). Paying a native dependency — plus that floor
  rewrite — to close gaps whose worst case is already the r52/r53 class (one
  recoverable re-login), while gap 2's uncooperative-CLI arm stays open regardless,
  is not justified now.

**Decision:** ship the gap-4 fix; leave 1–3 as the residual above, bounded by the
`stillHeld()` persist guard (exactly one persists; no unguarded double-persist, no
token written over a good one). Revisit the `flock` route (with the deliberate floor
rewrite it entails) if the bounded harm — a spurious re-login under a stale orphan
plus two contenders, or a suspend/clock-step — shows up often enough in the field to
warrant it. A fencing token was rejected as inert — nothing checks it at `rename`
time, so it is a produced value with no consumer that changes the outcome.
