# Design task: the refresh lease's remaining check-then-act gaps

**Status:** open. Filed 2026-09-06 from rounds 52–54 of the PR #15 review campaign.
**Scope:** `withRefreshLock`, `unlinkOwnLock`, `lockOwner`, `removeStaleLock` and
`refreshAuth`'s save in `src/proxy/codex-backend-transport.ts`.

## What holds today

The Codex OAuth token refresh is serialized by a file lease: `auth.json.refresh.lock`,
created with `wx`, naming its owner; a lease older than `REFRESH_LOCK_STALE_MS` (60 s) is
taken over; the token fetch is bounded to half of that (`REFRESH_FETCH_BUDGET_MS`), so a
live owner's fetch cannot outlast its lease; an owner removes only a lock still naming it;
and a refresh is persisted only while the lease still names its owner AND `auth.json` still
carries the refresh token it consumed — otherwise it returns what it got, unsaved. What is
saved is merged onto the file as re-read. Every one of those rules is pinned by a fixture
in `test/codex-backend-transport.test.mjs` (search `r52-codex`, `r53-fable`, `r54-fable`).

## What remains

Two of those rules are check-then-act on a pathname, not atomic:

1. `unlinkOwnLock` reads the lock's owner, then unlinks by path. A takeover landing between
   the read and the unlink removes the taker's lock.
2. The save reads `auth.json` and the lock's owner, then renames the new file into place. A
   takeover, or another writer, landing between the checks and the rename is overwritten.
3. `removeStaleLock` decides staleness from `stat` and then unlinks by path: a fresh owner
   that replaced the pathname between the two is removed, and the waiter takes a lease over
   a refresh already in flight (codex round 55).
4. The save's post-fetch re-read counts a file as usable once it parses as JSON, but the
   branch that returns the file's current generation calls `authFromFile`, which needs
   `access_token` and an account id. A concurrent writer that leaves a parseable but
   token-less file — a codex CLI logout, or a torn write showing `{}` — is treated as a
   moved generation. Round 56 hardened the CALLER (a logout no longer throws away the token
   just fetched; the caller keeps its refreshed auth, unsaved, and the logout is not written
   over), but the single-use rotation the fetch consumed is then persisted nowhere: if the
   writer's completed file carries the same refresh generation, the next refresh reads that
   stale token, earns a 401, and forces a re-login. Retrying a parseable-but-unusable re-read
   the way a parse failure is retried, and persisting the rotation onto the writer's completed
   generation, is the same handle-vs-pathname atomicity problem as 1–3, on the save's read side.

Both need a takeover — a lease older than 60 s — to land inside a microsecond window of an
owner whose fetch is bounded to 30 s: on the live path that means a process stalled longer
than the lease in the middle of its refresh (a suspended machine), not ordinary contention.
codex round 53 reproduced both by widening the window with a FIFO; Fable round 54 measured
the ordinary interleavings and found them serialized.

## How to close it

A lease tied to a handle, not a pathname: an OS advisory lock (`flock`/`fcntl`) released by
the owning descriptor, which Node's standard library does not expose — a native dependency
(the packaging allowlist is `sharp` and `ajv` today) or a small helper — or a fencing token
carried from the lease into the save (the rename target named by the lease generation, so
a stale owner's rename lands on a name nobody reads). Either is a design change to the
credential path, to be made on its own, with the takeover fixtures above as the floor.
