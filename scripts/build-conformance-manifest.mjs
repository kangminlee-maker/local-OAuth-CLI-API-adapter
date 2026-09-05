#!/usr/bin/env node
// Stage 2 of the conformance suite (design §7-2): turn the matrix's claim rows
// and this server's route table into ONE machine-readable manifest that the
// runner, the coverage report and the generated docs all read.
//
//   node scripts/build-conformance-manifest.mjs [--check]
//
// `--check` rebuilds in memory and exits non-zero if `spec/conformance.json`
// is not what the matrix says — that is the gate, and it is what `pnpm test`
// runs. Without it the file is written.
//
// The manifest is JSON, not the YAML the design named. Nothing in this repo
// parses YAML and its whole dependency surface is one runtime package; a
// versioned machine-readable contract is what the design asked for, and JSON
// is that without adding a parser to read the repo's own spec.
//
// What is NOT in here: whether the proxy actually behaves this way. The matrix's
// column 7 is a CLAIM of support and is carried as one; real status is derived
// by running the claims, never by editing a field that says "done".
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MATRIX = `${root}/docs/conformance-matrix.md`;
const OUT = `${root}/spec/conformance.json`;
const MANIFEST_VERSION = 1;

// Surface sections, keyed by the matrix heading number. The route is the one
// the section's own heading names; a section whose route stops matching the
// server's table is a loud failure rather than a silent rename.
// `columns` is the section's own table width, asserted per row rather than
// assumed: the Images table carries an extra applicability column (`G/E/V`),
// and a table that changes shape must stop this build rather than shift every
// cell one place to the left.
const SECTIONS = [
  { heading: 1, id: 'openai-chat', routes: ['POST /v1/chat/completions'], columns: 8, applicability: false },
  { heading: 2, id: 'openai-responses', routes: ['POST /v1/responses'], columns: 8, applicability: false },
  { heading: 3, id: 'openai-images', routes: ['POST /v1/images/generations', 'POST /v1/images/edits'], columns: 9, applicability: true },
  { heading: 4, id: 'anthropic-messages', routes: ['POST /v1/messages'], columns: 8, applicability: false },
];

/**
 * The vocabulary the matrix's own legend declares for column 6. The cells have
 * outgrown it — `refused`, `mirrored`, `echoed`, `rejected` and twenty more
 * leading phrases appear — so this is NOT used to classify. It is used to say
 * how far the column has drifted from its legend, which is a real finding and
 * a quiet one: a parser that mapped `mirrored` onto `supported` would be
 * inventing a meaning the document never wrote down.
 */
const LEGEND_DISPOSITIONS = ['supported', 'validated-rejected', 'silently ignored', 'not applicable', 'divergent'];
const EVIDENCE_GRADES = ['VERIFIED', 'DOC?', 'DOC', 'CODE'];

/**
 * Every route this server answers, with the method it answers on. Written here
 * rather than imported because the dispatcher is a chain of `if`s, not a table
 * — and `test/conformance-manifest.test.mjs` probes a live proxy to prove this
 * list is neither short nor long, which a shared constant could not do on its
 * own.
 */
const ROUTES = [
  { route: 'POST /v1/chat/completions', surface: 'openai-chat', protocol: ['json', 'sse'] },
  { route: 'POST /v1/responses', surface: 'openai-responses', protocol: ['json', 'sse'] },
  { route: 'POST /v1/messages', surface: 'anthropic-messages', protocol: ['json', 'sse'] },
  { route: 'POST /v1/images/generations', surface: 'openai-images', protocol: ['json', 'multipart', 'sse'] },
  { route: 'POST /v1/images/edits', surface: 'openai-images', protocol: ['json', 'multipart', 'sse'] },
  { route: 'GET /v1/models', surface: 'openai-models', protocol: ['json'] },
  { route: 'POST /local/cli/sessions', surface: 'local-cli-sessions', protocol: ['json'] },
  { route: 'GET /local/cli/sessions/{id}', surface: 'local-cli-sessions', protocol: ['json'] },
  { route: 'DELETE /local/cli/sessions/{id}', surface: 'local-cli-sessions', protocol: ['json'] },
  { route: 'POST /local/cli/sessions/{id}/interrupt', surface: 'local-cli-sessions', protocol: ['json'] },
  { route: 'POST /local/cli/sessions/{id}/turns', surface: 'local-cli-sessions', protocol: ['json', 'sse'] },
];

/**
 * Which top-level fields the live parity instrument actually exercises, read
 * out of the instrument itself rather than listed here. This is the design's
 * rule that an evidence grade is COMPUTED from evidence, not maintained by
 * hand: the matrix's `Ev` column still grades the Responses surface at 7 of 41
 * VERIFIED, written before the surface was measured field by field, while the
 * instrument sends 164 rows to the live API on every run.
 */
function parityFieldsBySurface() {
  const src = readFileSync(`${root}/scripts/e2e-text-surfaces-direct-parity.mjs`, 'utf8');
  const sets = {
    'openai-chat': ['const chatCases = [', 'CHAT_TYPE_FAULT_ORDER'],
    'openai-responses': ['const responsesCases = ['],
    'anthropic-messages': ['const messagesCases = ['],
  };
  const out = {};
  for (const [surface, anchors] of Object.entries(sets)) {
    const fields = new Set();
    for (const anchor of anchors) {
      const at = src.indexOf(anchor);
      if (at === -1) throw new Error(`the parity instrument no longer has ${anchor}`);
      const end = src.indexOf('\n];', at);
      const block = src.slice(at, end === -1 ? src.length : end);
      // `key:` at the start of an object member, and `...OUT`-style spreads are
      // ignored — those carry the base body every row shares. The generated
      // order lists name their keys as quoted strings instead, so those count
      // too — without this, `parallel_tool_calls` and `safety_identifier` read
      // as uncovered while the instrument sends both on every run.
      for (const match of block.matchAll(/[{,]\s*([a-z_][a-z0-9_]*)\s*:/gi)) fields.add(match[1]);
      for (const match of block.matchAll(/\['([a-z_][a-z0-9_]*)',\s*(?:WRONG|'[^']*')\]/g)) fields.add(match[1]);
    }
    out[surface] = [...fields].sort();
  }
  // The image surface has its own instrument.
  const images = readFileSync(`${root}/scripts/e2e-images-direct-parity.mjs`, 'utf8');
  const imageFields = new Set();
  for (const match of images.matchAll(/[{,]\s*([a-z_][a-z0-9_]*)\s*:/gi)) imageFields.add(match[1]);
  out['openai-images'] = [...imageFields].sort();
  return out;
}

/** The root key a matrix `Field / JSON path` cell names. */
function rootField(cell) {
  const backticked = /`([^`]+)`/.exec(cell);
  const path = (backticked?.[1] ?? cell).trim();
  return path.split(/[.\[ ]/)[0].replace(/[^A-Za-z0-9_]/g, '');
}

function cells(line) {
  // A leading and trailing pipe frame the row; `\|` is an escaped pipe inside a
  // cell and must not split it.
  const inner = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return inner.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, '|'));
}

/** `G E V` → the routes those letters name, dropping the retired variations. */
function routesFor(section, applicability) {
  const letters = new Set(applicability.replace(/[^GEV]/g, '').split(''));
  const routes = [];
  if (letters.has('G')) routes.push('POST /v1/images/generations');
  if (letters.has('E')) routes.push('POST /v1/images/edits');
  // `V` is historical: `/v1/images/variations` answers 404 on the direct API
  // and here, so a row marked V names no live route through it.
  return routes.length > 0 ? routes : section.routes;
}

/** The cell's opening phrase, with markdown emphasis stripped. Observed, not mapped. */
function readClaimLead(cell) {
  const plain = cell.replace(/\*\*/g, '').trim().toLowerCase();
  if (plain.startsWith('silently ignored')) return 'silently ignored';
  if (plain.startsWith('not applicable')) return 'not applicable';
  if (plain.startsWith('validated-rejected')) return 'validated-rejected';
  const word = plain.split(/[\s,;:—(]/)[0]?.replace(/^`|[`.]$/g, '') ?? '';
  return word || 'unstated';
}

function readGrade(cell) {
  const found = EVIDENCE_GRADES.find((grade) => cell.startsWith(grade));
  if (!found) throw new Error(`row evidence cell names no known grade: ${cell.slice(0, 60)}`);
  return found;
}

function build() {
  const parityFields = parityFieldsBySurface();
  const lines = readFileSync(MATRIX, 'utf8').split('\n');
  const claims = [];
  const problems = [];
  let section = null;
  for (const [index, line] of lines.entries()) {
    const heading = /^## (\d)\. (.+)$/.exec(line);
    if (heading) {
      section = SECTIONS.find((candidate) => candidate.heading === Number(heading[1])) ?? null;
      continue;
    }
    if (!section || !line.startsWith('|')) continue;
    if (!/^\| *[A-Za-z]*-?\d+ *\|/.test(line)) continue;
    const row = cells(line);
    if (row.length !== section.columns) {
      problems.push(`${MATRIX}:${index + 1}: §${section.heading} rows have ${section.columns} cells, got ${row.length}`);
      continue;
    }
    const [id, field, ...rest] = row;
    const applicability = section.applicability ? rest.shift() : null;
    const [valueSpace, whenOmitted, observable, invalidValue, proxyCell, evidenceCell] = rest;
    claims.push({
      id: `${section.id}:${id}`,
      surface: section.id,
      // An Images row that applies to generations only is not a claim about
      // edits, so the route list narrows with it.
      routes: applicability === null ? section.routes : routesFor(section, applicability),
      matrixRow: id,
      matrixLine: index + 1,
      field,
      ...(applicability === null ? {} : { applicability }),
      vendor: {
        valueSpace,
        defaultWhenOmitted: whenOmitted,
        observableEffect: observable,
        invalidValue,
      },
      // Claimed, not measured. Stage 3 derives the real status by running it.
      claimedLead: readClaimLead(proxyCell),
      claimedLeadInLegend: LEGEND_DISPOSITIONS.includes(readClaimLead(proxyCell)),
      claimedNote: proxyCell,
      evidenceGrade: readGrade(evidenceCell),
      evidenceNote: evidenceCell,
      // Derived, not declared: this field is sent to BOTH the vendor and this
      // proxy on every instrument run, and the two envelopes are compared.
      liveParityRow: (parityFields[section.id] ?? []).includes(rootField(field)),
    });
  }
  if (problems.length) throw new Error(`the matrix did not parse:\n  ${problems.join('\n  ')}`);
  if (claims.length === 0) throw new Error('the matrix yielded no claims — the extractor is broken, not the document');

  const divergences = JSON.parse(readFileSync(`${root}/spec/declared-divergences.json`, 'utf8'));
  const surfaces = [...new Set(ROUTES.map((entry) => entry.surface))].sort();
  const claimedSurfaces = new Set(claims.map((claim) => claim.surface));
  return {
    manifestVersion: MANIFEST_VERSION,
    generatedBy: 'scripts/build-conformance-manifest.mjs',
    source: {
      matrix: 'docs/conformance-matrix.md',
      matrixDigest: createHash('sha256').update(readFileSync(MATRIX)).digest('hex'),
      divergences: 'spec/declared-divergences.json',
    },
    counts: {
      claims: claims.length,
      claimsOutsideLegendVocabulary: claims.filter((claim) => !claim.claimedLeadInLegend).length,
      claimsWithLiveParityRow: claims.filter((claim) => claim.liveParityRow).length,
      routes: ROUTES.length,
      surfaces: surfaces.length,
      // The surfaces this server answers on that no claim row covers. This is
      // the "unexamined surface" list, derived rather than maintained.
      surfacesWithoutClaims: surfaces.filter((surface) => !claimedSurfaces.has(surface)),
    },
    routes: ROUTES,
    declaredDivergences: divergences.divergences.map((entry) => ({
      id: entry.id, surface: entry.surface, evidence: entry.evidence, measuredAt: entry.measuredAt,
    })),
    claims,
  };
}

const manifest = build();
const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
if (process.argv.includes('--check')) {
  let current = null;
  try { current = readFileSync(OUT, 'utf8'); } catch { /* not written yet */ }
  if (current === serialized) {
    process.stdout.write(`conformance manifest is current: ${manifest.counts.claims} claims, ${manifest.counts.routes} routes\n`);
    process.exit(0);
  }
  process.stderr.write('spec/conformance.json is not what docs/conformance-matrix.md says.\n');
  process.stderr.write('Run: node scripts/build-conformance-manifest.mjs\n');
  process.exit(1);
}
writeFileSync(OUT, serialized);
process.stdout.write(`wrote ${OUT}: ${manifest.counts.claims} claims across ${manifest.counts.surfaces} surfaces, ${manifest.counts.routes} routes\n`);
if (manifest.counts.surfacesWithoutClaims.length) {
  process.stdout.write(`surfaces with no claim row: ${manifest.counts.surfacesWithoutClaims.join(', ')}\n`);
}
