# Design task: the shape reader cannot tell one array member from another

**Status:** open, filed 2026-09-10. **Scope:** `keyPaths` and `creditedAbsences`
in `scripts/lib/response-comparison.mjs`, and the two gates that read them,
`test/conformance-supplied-echo.test.mjs` and
`test/conformance-echoed-defaults.test.mjs`.

Filed from the third confirmation round on PR #27
(`review-artifacts/supplied-echo-confirm3-codex-out/`, finding C5), which
classified it as pre-existing and never reached by the three rounds before it.
No proxy defect is known to sit here: the construction below is one a review
built, not an answer this proxy has been observed to give.

## What holds today

An array's shape is read as the union of its members' paths, plus two things a
union cannot say: the TYPES the members take, and — since 2026-09-10 — anything
a member goes WITHOUT that a sibling carries, written `[]{-<relative path>}` and
computed at every depth.

That second reading is what closes three constructions in a row: a second choice
answered as `null`, then as `{}`, then keeping its own keys with its `message`
emptied. Each was invisible to the union because a full sibling supplied every
path the empty one lacked.

## The gap

A signature records THAT some member went without something, never WHICH member.
So moving a field from one member to another leaves both sides' signature sets
identical, and every other reading agrees too: the item count is unchanged, the
member types are unchanged, and the union is unchanged.

The review's construction, on a Responses turn holding a message item and a
function-call item: move `call_id`, `name` and `arguments` off the function call
and onto the message, leaving the function call with `id`, `type` and `status`.
Both sides then say "some member lacks `call_id`" and "some member lacks
`content`", and the gate passes. A client meets a function call it cannot
execute and a message carrying arguments that belong to nothing.

The abstract form is `[{b:1},{c:1}]` reading the same as `[{b:1,c:1},{}]`.

## Why it is not patched here

Telling members apart needs an identity rule, and the rule is a decision this
reader does not have and cannot guess:

- Which key identifies a member — `type` for a Responses output item, `index`
  for a Chat choice, `name` for a tool — and what happens when a turn carries
  two members with the same one.
- What identity means when the vendor and the proxy disagree about which members
  exist at all, which is the ordinary case for the fake backend this gate runs
  against and is currently answered by a per-row `harnessPremise`.
- Whether member ORDER becomes shape once members are identified. It is
  deliberately not shape today, because which items a turn contains varies by
  construction.

Answering those changes what a declaration means — a declaration names a field,
and under member identity it would have to name a field *of a member kind* — so
it is a redesign of the comparison's vocabulary, not a repair. Three rounds of
patching this reader inside a defect fix produced a defect in the repair each
time, which is the reason this one is filed instead.

## What to preserve when it is taken up

- The vendor side stays frozen and our side stays live. Two frozen fixtures
  detect only fixture drift.
- Present-but-empty must keep failing an absence declaration, and a declaration
  must keep failing when it stops being true.
- The signature's cost is linear in the payload. An earlier form walked each
  member's subtree twice and took 3.5 seconds on a 191-byte body.
- A key that looks like the reader's own syntax stays a key. Paths carry the
  field they are about rather than being parsed back out of the string.

## Reproduction

`review-artifacts/supplied-echo-confirm3-codex/dist/confirm3/member-correlation.mjs`
prints `SHAPE_AND_COMPARED_VALUES_PASS` against the reader at both `370dda6` and
`bd6cc65`.
