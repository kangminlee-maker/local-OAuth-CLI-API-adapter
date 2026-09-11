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
// A path starts at a key, and a key that needs quoting is written `["…"]`.
// Requiring a leading dot rejected every quoted first segment, so a field that
// needs quotes could be compared but never declared.
const isKeyPath = (path) => path.startsWith('.') || path.startsWith('[');

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
      if (typeof path !== 'string' || !isKeyPath(path)) {
        throw new Error(`${where}: absentPaths must be key paths written as the reader emits them`);
      }
    }
    for (const divergence of entry.valueDivergences ?? []) {
      if (typeof divergence?.path !== 'string' || !isKeyPath(divergence.path)) {
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
 * A key as it appears in a path.
 *
 * Ordinary keys — every key these two APIs actually send — are written plainly.
 * Anything else is quoted, because a path is a string and the reader used to
 * re-parse it: a key literally containing `[]{-` was read as the member
 * signature it resembles, and a key containing a newline was not read at all.
 * Quoting makes a key that looks like syntax unmistakably a key.
 */
const segmentFor = (key) => (/^[A-Za-z0-9_]+$/.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`);

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
/**
 * A field and every field that contains it, nearest first.
 *
 * Module scope because TWO readers of the same declarations need it, and for a
 * while only one had it: the shape comparison walked ancestors while the echo
 * comparison matched exactly, so `.moderation` credited all 127 paths under it
 * on one side and none on the other. Three readers of one declaration is the
 * shape this repository keeps producing; this is the one they share.
 */
function ancestors(field) {
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
}

export function creditedAbsences(declared, exempt, onlyVendorPaths, ourPaths) {
  const ourFields = new Set(ourPaths.values());
  const owner = (field) => {
    for (const candidate of ancestors(field)) {
      if (declared.includes(candidate) && !ourFields.has(candidate)) return candidate;
    }
    return null;
  };

  const credited = new Set();
  const uncredited = [];
  for (const [path, field] of onlyVendorPaths) {
    if (exempt.includes(path)) {
      credited.add(path);
      continue;
    }
    const found = owner(field);
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
  const fields = new Set(vendorPaths.values());
  return absentPathsFor(surface).filter((path) => fields.has(path));
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
 * Every path in a value, TAGGED with the JSON type there, arrays collapsed to
 * `[]` so item count is not shape — mapped to the FIELD each path is about.
 *
 * The type tag is load-bearing. Without it an empty container and a `null`
 * occupy the same path and contribute no children, so a default that changed
 * from `metadata: {}` to `metadata: null` — a difference every client sees —
 * left both key sets identical and no value to compare.
 *
 * Two things the union of an array's member paths cannot say are recorded as
 * paths of their own: the TYPES the members take, and anything a member goes
 * WITHOUT that a sibling carries. Three reviews built the constructions that
 * forced each: a second choice answered as `null`, then as `{}`, then keeping
 * its own keys with its `message` emptied. So a member's signature is its whole
 * path set, at any depth. Uniform absence is deliberately not recorded — it is
 * already missing from the union, which is where a declaration answers for it.
 *
 * Member ORDER is not shape: which items a turn contains varies by
 * construction, so a signature records that a member went without something,
 * not which member it was. That is a known limit, not an oversight: moving a
 * field from one member to another leaves both sides' signatures equal. It is
 * written up as a design task rather than patched here, because telling members
 * apart needs an identity rule this reader does not have.
 *
 * The map's VALUE is the field the path is about, computed here where the
 * structure is known rather than parsed back out of the string later. A key
 * that looks like the reader's own syntax used to be read as syntax.
 */
function pathsWithin(value) {
  const out = new Map();
  if (Array.isArray(value)) {
    // Each member's subtree is walked ONCE and used twice — for the signature
    // and for the aggregate. Walking it again per use made a 191-byte body of
    // nested singleton arrays take three and a half seconds.
    const within = value.map((item) => pathsWithin(item));
    const isMember = value.map((item) => item !== null && typeof item === 'object' && !Array.isArray(item));
    const shared = new Map();
    for (const [index, paths] of within.entries()) {
      if (isMember[index]) for (const [path, field] of paths) shared.set(path, field);
    }
    value.forEach((item, index) => {
      out.set(`[]:${jsonType(item)}`, '');
      if (isMember[index]) {
        for (const [path, field] of shared) {
          if (!within[index].has(path)) out.set(`[]{-${path}}`, `[]${field}`);
        }
      }
      for (const [path, field] of within[index]) out.set(`[]${path}`, `[]${field}`);
    });
    return out;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, member] of Object.entries(value)) {
      const segment = segmentFor(key);
      out.set(`${segment}:${jsonType(member)}`, segment);
      for (const [path, field] of pathsWithin(member)) out.set(`${segment}${path}`, `${segment}${field}`);
    }
  }
  return out;
}

/** The paths in a value, each mapped to the field it is about. */
export function keyPaths(value, prefix = '') {
  const out = new Map();
  for (const [path, field] of pathsWithin(value)) out.set(`${prefix}${path}`, `${prefix}${field}`);
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
    // The same spelling the shape reader uses. They were written apart, and a
    // key needing quotes could then be declared for one and not found by the
    // other: `.metadata["a.b"]` matched the shape and looked up `undefined`.
    for (const [key, member] of Object.entries(value)) leafValues(member, `${prefix}${segmentFor(key)}`, out);
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
/**
 * Is this vendor leaf answered for by a declared absence?
 *
 * The same ancestor rule `creditedAbsences` uses, so one declaration reads the
 * same way on both sides of the comparison. It used to match exactly, which
 * meant a declaration naming a subtree — the only form in which a whole absent
 * feature can be declared at all — credited every path under it on the shape
 * side and nothing on the echo side.
 *
 * `ourFields` is the guard, and it is what makes this safe rather than merely
 * permissive: a declared ancestor stops counting the moment WE start reporting
 * it. Without it, a build that began emitting a `moderation` block of its own
 * would have every leaf under it silently exempted here while the shape side
 * went red — two readers of one declaration disagreeing again, which is the
 * thing this function exists to end.
 */
export function isDeclaredAbsent(absent, path, ourFields = new Set()) {
  const indexless = path.replace(/\[\d+\]/g, '[]');
  const base = indexless.replace(/\[\]#$/, '');
  // The guard applies to EVERY way a declaration can match, not only to the
  // ancestor walk. The first version returned true on an exact hit before
  // `ourFields` was consulted, so a declaration naming a leaf kept exempting
  // that leaf after we started reporting it: plant a wrong `reasoning.mode` and
  // the shape comparison goes red on 19 rows while the echo comparison, reading
  // the same declaration, says nothing. Which is the disagreement this function
  // was consolidated to end — closed on the subtree case and left open on the
  // exact one.
  if ((absent.has(path) || absent.has(indexless)) && !ourFields.has(base)) return true;
  return ancestors(base).some((field) => absent.has(field) && !ourFields.has(field));
}

export const rootOf = (path) => path.replace(/^\./, '').split(/[.[]/, 1)[0];
