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

// A declaration that cannot be compared is worse than a missing one: it looks
// like a checked claim and matches nothing. The gates compare a divergence's
// two sides against `JSON.stringify` of a leaf, so `"detailed"` is the written
// form and `detailed` is a value no answer can ever equal — which would leave
// the declaration permanently unexhibited or, keyed loosely, permanently
// satisfied by someone else's evidence. Refusing here means a malformed
// declaration cannot be loaded by either gate rather than being caught by
// whichever test happens to read it.
const canonicalJsonText = (text) => {
  if (typeof text !== 'string') return false;
  try { return JSON.stringify(JSON.parse(text)) === text; } catch { return false; }
};

/** Throws on a declaration the gates could not compare. Exported so it can be shown to refuse. */
export function validateDeclarations(divergences) {
  if (!Array.isArray(divergences)) throw new Error('declared-divergences: divergences must be a list');
  const seenIds = new Set();
  for (const entry of divergences) {
    const where = `declared-divergences entry ${typeof entry?.id === 'string' ? entry.id : '(unnamed)'}`;
    for (const field of ['id', 'surface', 'claim', 'behavior', 'why', 'measuredAt', 'evidence']) {
      if (typeof entry?.[field] !== 'string' || entry[field] === '') {
        throw new Error(`${where}: ${field} must be a non-empty string`);
      }
    }
    if (seenIds.has(entry.id)) throw new Error(`${where}: declared twice`);
    seenIds.add(entry.id);
    for (const key of ['absentPaths', 'valueDivergences']) {
      if (key in entry && !Array.isArray(entry[key])) throw new Error(`${where}: ${key} must be a list`);
    }
    for (const path of entry.absentPaths ?? []) {
      if (typeof path !== 'string' || !path.startsWith('.')) {
        throw new Error(`${where}: absentPaths must be key paths written as the reader emits them`);
      }
    }
    for (const divergence of entry.valueDivergences ?? []) {
      if (typeof divergence?.path !== 'string' || !divergence.path.startsWith('.')) {
        throw new Error(`${where}: a valueDivergences path must be a key path`);
      }
      for (const side of ['vendor', 'proxy']) {
        if (!canonicalJsonText(divergence[side])) {
          throw new Error(`${where}: ${divergence.path} ${side} must be the JSON text of a value`);
        }
      }
      if (divergence.vendor === divergence.proxy) {
        throw new Error(`${where}: ${divergence.path} declares a divergence between two equal values`);
      }
    }
  }
  return divergences;
}

validateDeclarations(declared);

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
 * The form a declaration is written in: no type tag, no trailing `[]`, and no
 * member-signature suffix.
 *
 * A declaration names a field. The reader emits paths a declaration would never
 * write — `…:type` for the type at a path, `…[]` for the types an array's
 * members take, and `…[]{-<relative path>}` for something some members carry
 * and others do not — and each belongs to a field: if we do not report
 * `choices[].logprobs.content` at all, we report nothing beneath it either, so
 * its member types are absent for the same declared reason, and a signature
 * saying one member goes without `.message.role` is about
 * `…[].message.role`. Signatures nest, so this unwraps until none is left.
 */
export function declarablePath(path) {
  const signature = /^(.*?\[\])\{-(.+)\}$/.exec(path);
  if (signature) return declarablePath(`${signature[1]}${signature[2]}`);
  return path.replace(/:[a-z]+$/, '').replace(/\[\]$/, '');
}

/**
 * What answers for each path the vendor sent and we did not, and what nothing
 * answers for.
 *
 * Three readings had to be corrected here, each by a review that built the
 * construction the previous reading let through:
 *
 *  - A declaration says a FIELD is not reported. The paths beneath it are
 *    absent for the same reason and must not need declarations of their own —
 *    but the reverse is not true, and `logprobs: {content: []}` used it: the
 *    only missing path was the array's member type, whose declarable form is
 *    the CONTENT field, so "we do not report the content" was satisfied by a
 *    content that is present and empty.
 *  - "Missing" therefore means our answer carries NO path for that field, not
 *    that one of its typed paths is missing: with the vendor sending `x: 1`
 *    and `x: null` across two members and us sending only `x: null`, the
 *    number-typed path was gone and the field read as absent while every
 *    member still had it.
 *  - The owner is the nearest DECLARED ancestor, not the nearest missing one.
 *    Replacing an enumerated list of descendants with the one truthful parent
 *    used to fail, because each descendant's own path was missing and so
 *    stopped the walk before the declaration was reached.
 *
 * `exempt` is the other kind of answer: a path this TEST cannot produce,
 * credited literally and only to itself, so an exemption cannot spread the way
 * a declaration does. The caller is required to prove the exemption's premise
 * before passing it.
 */
export function creditedAbsences(declared, exempt, onlyVendorPaths, ourPaths) {
  const ourFields = new Set();
  for (const path of ourPaths) ourFields.add(declarablePath(path));
  const ancestors = (field) => {
    const out = [field];
    let rest = field;
    while (true) {
      const cut = Math.max(rest.lastIndexOf('.'), rest.lastIndexOf('['));
      if (cut <= 0) return out;
      rest = rest.slice(0, cut);
      if (rest.endsWith('[]')) rest = rest.slice(0, -2);
      if (rest === '') return out;
      out.push(rest);
    }
  };
  const owner = (path) => {
    for (const candidate of ancestors(declarablePath(path))) {
      if (declared.includes(candidate) && !ourFields.has(candidate)) return candidate;
    }
    return null;
  };

  const credited = new Set();
  const uncredited = [];
  for (const path of onlyVendorPaths) {
    if (exempt.includes(path)) {
      credited.add(path);
      continue;
    }
    const found = owner(path);
    if (found !== null) credited.add(found);
    else uncredited.push(path);
  }
  return { credited: [...credited].sort(), uncredited: uncredited.sort() };
}

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
    // What the union of member paths cannot say is whether the members AGREE.
    // A review answered the second choice as `{}` — an object like the first,
    // contributing no paths of its own — and the union was unchanged: a choice
    // with no message and no index, invisible to both gates. The next review
    // did it one level down, leaving the choice's own keys and emptying its
    // `message`, which a signature of immediate keys could not see. So each
    // member's WHOLE path set is compared against its siblings', and anything a
    // member goes without becomes a path.
    //
    // Uniform absence is deliberately not recorded: something no member has is
    // already missing from the union, which is where a declaration answers for
    // it, and recording it twice would make every declared absence look like a
    // disagreement between our own members.
    const within = value.map((item) => (
      item !== null && typeof item === 'object' && !Array.isArray(item) ? keyPaths(item, '', new Set()) : null
    ));
    const shared = new Set();
    for (const paths of within) if (paths) for (const path of paths) shared.add(path);
    value.forEach((item, index) => {
      // The TYPES an array's members take are shape, even though their count is
      // not. Without this line the union of member paths is all a reader sees,
      // so a second choice answered as `null` — which every SDK reads as a
      // missing message — contributed nothing and hid behind the first choice's
      // paths. A review planted exactly that and both gates passed.
      out.add(`${prefix}[]:${jsonType(item)}`);
      const paths = within[index];
      // Member ORDER is deliberately not shape: which items a turn contains
      // varies by construction, so this records that a member went without the
      // path, not which member it was.
      if (paths) for (const path of shared) if (!paths.has(path)) out.add(`${prefix}[]{-${path}}`);
      keyPaths(item, `${prefix}[]`, out);
    });
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
