# Design task: a capture record holds decoded text, not the bytes that arrived

**Status:** open, filed 2026-09-10. **Scope:** `encodeBody` in
`scripts/lib/capture-recorder.mjs` and every record it writes; every producer
that hands it a decoded string —

- `scripts/lib/sse-capture.mjs`, where the question first became visible;
- `scripts/lib/probe-exchange.mjs`, the direct-API prober's buffered branch;
- `scripts/api-comparison-benchmark.mjs`, its JSON and multipart paths;
- `scripts/probe-text-surface-keys.mjs`;

— and `scripts/promote-capture.mjs`, which re-derives `streamBytes`/`bodyBytes`
onto a fixture from the text it was given. The inventory is every caller of
`recordExchange`: a decision that changed only some of them would leave records
claiming to be byte-exact beside records that are not.

Filed from the second seat of the first confirmation round on PR #28
(`review-artifacts/batch2-review-codex2/dist/batch2/REPORT.md`, the MED
finding), which built the construction below rather than observing it in a run.
No proxy defect sits here: what is at stake is what a recorded exchange can be
asked afterwards.

## What holds today

`recordExchange` takes `streamBytes` as a STRING. `encodeBody` then derives the
record's `bytes` and `sha256` from the UTF-8 encoding of that string. Every
capture in `spec/captures/` has that shape: `promote-capture.mjs` re-derives the
count and digest onto the fixture, and the three gates re-derive the digest again
on every run.

The provenance binding does NOT hash it. `scripts/lib/capture-provenance.mjs`
binds the promoter's own source blobs to a committed revision — `git cat-file`,
`merge-base --is-ancestor`, `rev-parse <rev>:<path>` — and the string `sha256`
does not appear in it. That distinction is the point of the binding: a fixture's
own digest proves it has not drifted and says nothing about what wrote it.
Getting it wrong here would overstate the migration below.

And the count has no reader. Nothing in this repository reads `streamBytes` or
`bodyBytes` back: 45 fixtures carry them, and the gates check only the digests.
So the cost of changing the shape is the writers and the migration, not a set of
consumers that would have to be taught a second representation.

The transport therefore has to decode before it records. `TextDecoder` with
`{stream: true}` holds back the first byte of a multi-byte character until the
rest arrives, so a stream cut inside a character left that byte in the decoder
and the record said the empty string — a turn that reads afterwards as one where
nothing arrived, which is the opposite of what happened.

`readRecordedSse` now flushes the decoder on every exit, so that byte reaches
the record as U+FFFD and the arrival is visible. What it CANNOT say is which
byte it was: U+FFFD is three bytes where one arrived, so `stream.bytes` is off
by two in the one case where the exact bytes are the whole question.

## The question

Should a capture record carry bytes rather than text?

It would answer this cleanly — a byte count and a digest that mean what they
say for any wire, including a truncated character, a mislabelled charset, or a
vendor sending something that is not UTF-8 at all.

The cost is the writers and the readers of the shape, and it is worth being
exact about which is which. **Writers**: the five producers above plus
`promote-capture.mjs`. **Readers**: the three gates, which compare a fixture's
`body`/`stream` text and re-derive its digest. **Not a reader**:
`capture-provenance.mjs`, which binds the promoter's source blobs to a committed
revision and never looks at a payload — charging the migration to it overstates
the cost. And the byte COUNT has no reader at all.

There is one thing a migration cannot do. The 45 promoted fixtures hold text
whose original bytes were discarded when they were recorded; re-deriving a count
from that text produces the same number it has now. They cannot become
byte-exact retroactively, only re-labelled as text-derived — so any answer here
has to say how a record declares which of the two it is, and a fixture recorded
before the change stays the weaker kind until the capture that made it is taken
again.

Two directions, neither chosen:

- **A second field.** Keep `text` as it is, add the raw bytes beside it (base64,
  or gzip+base64 as the existing large-body path already does). Nothing that
  reads today's records changes; the cost is two representations of one thing,
  which is a thing that can disagree with itself.
- **Bytes as the record, text as a view.** `encodeBody` takes bytes, and `text`
  becomes a decoding computed on read. Honest, and it touches every fixture,
  all five producers, `promote-capture.mjs`, and the three gates' digest
  re-derivation — with the 45 existing fixtures re-labelled rather than
  corrected, since their bytes are gone.

## What would close it

A decision, and if the decision is to change the shape: how a record declares
which kind it is, the re-labelling of the 45 fixtures whose bytes are gone, and a
gate case whose wire is not valid UTF-8 — asserted on the byte count and digest
rather than on decoded text, since decoded text is exactly what such a case
cannot pin.
