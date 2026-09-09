// How two JSON answers to the SAME request bytes are compared.
//
// Two gates ask this question — one about a request that configures nothing
// (`conformance-echoed-defaults`), one about a request that supplies a single
// option (`conformance-supplied-echo`) — and they must read a body the same
// way, or a difference that one calls a defect the other calls per-call noise.
// The readers live here so there is one reading, and one place where the
// reasons for its shape are written down.
//
// The vendor side of both gates is FROZEN (a promoted capture) and our side is
// LIVE (the real server answering those same bytes), so what these functions
// see is a real answer from this build, not a second fixture.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from './capture-provenance.mjs';

const declared = JSON.parse(
  readFileSync(join(repoRoot, 'spec', 'declared-divergences.json'), 'utf8'),
).divergences;

/**
 * The response paths a surface is declared NOT to emit.
 *
 * Selected by SURFACE, not by which gate asked: a field this proxy structurally
 * does not report is absent from every answer it gives on that surface, so a
 * declaration keyed to one gate's name would have to be copied to the next one
 * — and a copy is a thing that can disagree with its original.
 */
export function absentPathsFor(surface) {
  return declared
    .filter((entry) => entry.surface === surface && Array.isArray(entry.absentPaths))
    .flatMap((entry) => entry.absentPaths);
}

/**
 * The leaf values a surface is declared to answer differently, as
 * `{path, vendor, proxy}` with both sides as JSON text.
 *
 * A path we do not report at all is an `absentPaths` entry; this is the other
 * kind — a field both sides send and fill differently. Declaring BOTH sides is
 * what keeps it from becoming an exemption: a gate that skipped the path would
 * wave through any future value, so the check is that each side still says
 * exactly what is written here.
 */
export function valueDivergencesFor(surface) {
  return declared
    .filter((entry) => entry.surface === surface && Array.isArray(entry.valueDivergences))
    .flatMap((entry) => entry.valueDivergences);
}

/**
 * The form a declaration is written in: no type tag, and no trailing `[]`.
 *
 * A declaration names a field. The reader emits two paths a declaration would
 * never write — `…:type` for the type at a path, and `…[]` for the types an
 * array's members take — and both belong to the field above them: if we do not
 * report `choices[].logprobs.content` at all, we report nothing beneath it
 * either, so its member types are absent for the same declared reason.
 */
export const declarablePath = (path) => path.replace(/:[a-z]+$/, '').replace(/\[\]$/, '');

/**
 * The declared absences that THIS capture can speak to.
 *
 * A declaration is about a surface, but a capture only shows the paths its own
 * request asked for: the direct API sends `choices[].logprobs` when a request
 * turns them on and omits the key entirely when it does not. Comparing a
 * capture's missing paths against the whole surface declaration would make
 * every minimal capture fail for not having asked. So the expectation is the
 * declaration intersected with what the vendor actually sent here — and a
 * declaration that no capture ever exercises is caught by its own check, not
 * by this one.
 */
export function expectedAbsentPaths(surface, vendorPaths) {
  const untagged = new Set([...vendorPaths].map(declarablePath));
  return absentPathsFor(surface).filter((path) => untagged.has(path));
}

// Values that differ on every call by construction — identifiers, clocks, the
// answer itself, and the token counts of two different models. Their SHAPE is
// still compared; only the leaf values below them are not.
//
// `model` is NOT on this list, though it looks like it belongs: the capture's
// request names a model and both sides echo THAT, so it is comparable, and
// skipping it would let a proxy that answered with its backend's model — or a
// constant — pass a conformance check on the field a client uses to know what
// answered it.
export const PER_CALL = new Set([
  'id', 'created', 'created_at', 'completed_at', 'output', 'usage', 'choices',
]);

export const jsonType = (value) => (value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value);

/**
 * Every key path in a value, TAGGED with the JSON type at that path, arrays
 * collapsed to `[]` so item count is not shape.
 *
 * The type tag is load-bearing. Without it an empty container and a `null`
 * occupy the same path and contribute no children, so a default that changed
 * from `metadata: {}` to `metadata: null` — a difference every client sees —
 * left both key sets identical and no value to compare.
 */
export function keyPaths(value, prefix, out) {
  if (Array.isArray(value)) {
    for (const item of value) {
      // The TYPES an array's members take are shape, even though their count is
      // not. Without this line the union of member paths is all a reader sees,
      // so a second choice answered as `null` — which every SDK reads as a
      // missing message — contributed nothing and hid behind the first choice's
      // paths. A review planted exactly that and both gates passed.
      out.add(`${prefix}[]:${jsonType(item)}`);
      keyPaths(item, `${prefix}[]`, out);
    }
    return out;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, member] of Object.entries(value)) {
      out.add(`${prefix}.${key}:${jsonType(member)}`);
      keyPaths(member, `${prefix}.${key}`, out);
    }
    return out;
  }
  return out;
}

/** Leaf values by path, for the fields a client would read as configuration. */
export function leafValues(value, prefix, out) {
  if (Array.isArray(value)) {
    // An array of SCALARS contributes no key paths at all, so its contents are
    // invisible to the shape reading above; its length is the value that makes
    // them visible. Without this, a vendor `tools: []` answered with
    // `tools: ["leaked"]` passed both halves of this gate.
    out.set(`${prefix}[]#`, String(value.length));
    value.forEach((item, index) => leafValues(item, `${prefix}[${index}]`, out));
    return out;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, member] of Object.entries(value)) leafValues(member, `${prefix}.${key}`, out);
    return out;
  }
  out.set(prefix, JSON.stringify(value));
  return out;
}

/**
 * Whether a leaf path is covered by a set of declared absences.
 *
 * A declaration names a path; a leaf carries real array indices and, for an
 * array's own length, a `[]#` suffix that no declaration would write. Both are
 * normalised here, because the first version compared the raw strings and a
 * declared `.tools[].parameters.required` did not cover the length leaf that
 * belongs to it.
 */
export function isDeclaredAbsent(absent, path) {
  const indexless = path.replace(/\[\d+\]/g, '[]');
  return absent.has(path)
    || absent.has(indexless)
    || absent.has(indexless.replace(/\[\]#$/, ''));
}

export const rootOf = (path) => path.replace(/^\./, '').split(/[.[]/, 1)[0];
