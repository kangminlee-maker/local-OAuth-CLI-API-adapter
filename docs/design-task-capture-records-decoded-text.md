# Design task: a capture record holds decoded text, not the bytes that arrived

**Status:** open, filed 2026-09-10. **Scope:** `encodeBody` in
`scripts/lib/capture-recorder.mjs`, every record it writes, and the two things
that read those records back — `spec/captures/*.json` and its provenance
binding, and `scripts/lib/sse-capture.mjs`.

Filed from the second seat of the first confirmation round on PR #28
(`review-artifacts/batch2-review-codex2/dist/batch2/REPORT.md`, the MED
finding), which built the construction below rather than observing it in a run.
No proxy defect sits here: what is at stake is what a recorded exchange can be
asked afterwards.

## What holds today

`recordExchange` takes `streamBytes` as a STRING. `encodeBody` then derives the
record's `bytes` and `sha256` from the UTF-8 encoding of that string. Every
capture in `spec/captures/` has that shape, and the provenance binding hashes
it.

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
vendor sending something that is not UTF-8 at all. The cost is that the record
shape is shared: every promoted fixture, the provenance binding that re-derives
it from git, and the three gates that compare `stream.text` all read the current
shape. A record that can carry binary has to say which of the two it is holding,
and everything that reads one has to answer for both.

Two directions, neither chosen:

- **A second field.** Keep `text` as it is, add the raw bytes beside it (base64,
  or gzip+base64 as the existing large-body path already does). Nothing that
  reads today's records changes; the cost is two representations of one thing,
  which is a thing that can disagree with itself.
- **Bytes as the record, text as a view.** `encodeBody` takes bytes, and `text`
  becomes a decoding computed on read. Honest, and it touches every fixture and
  the provenance digests that bind them.

## What would close it

A decision, and if the decision is to change the shape: the migration for the
existing fixtures, and a gate case whose wire is not valid UTF-8 — asserted on
the byte count and digest rather than on decoded text, since decoded text is
exactly what such a case cannot pin.
