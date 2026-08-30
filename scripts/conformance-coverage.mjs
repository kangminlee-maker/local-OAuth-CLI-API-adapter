#!/usr/bin/env node
// The coverage report of design §7-2. Non-blocking by construction: it prints
// what the contract does and does not cover and always exits 0. What blocks is
// `--check` on the builder (the manifest must match the matrix) and the tests
// that probe the live route table — a report that can fail a build turns into
// a number people tune instead of a picture they read.
//
//   node scripts/conformance-coverage.mjs [--json]
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(`${root}/spec/conformance.json`, 'utf8'));

const tally = (rows, key) => rows.reduce((into, row) => {
  const value = row[key];
  into[value] = (into[value] ?? 0) + 1;
  return into;
}, {});

const bySurface = new Map();
for (const claim of manifest.claims) {
  if (!bySurface.has(claim.surface)) bySurface.set(claim.surface, []);
  bySurface.get(claim.surface).push(claim);
}

// A claim graded VERIFIED was observed on the wire against the vendor. Anything
// else is a candidate: DOC is the vendor's prose, CODE is our own reading, and
// neither is evidence about the vendor's behaviour.
const verified = manifest.claims.filter((claim) => claim.evidenceGrade === 'VERIFIED');
// The derived half. `Ev` is a label someone wrote; `liveParityRow` is whether
// the field is sent to BOTH the vendor and this proxy on every instrument run
// and the two envelopes compared. Where the two disagree, the label is the
// stale one — the Responses surface reads 7 VERIFIED of 41 in a column written
// before that surface was measured field by field.
const live = manifest.claims.filter((claim) => claim.liveParityRow);
const report = {
  manifestVersion: manifest.manifestVersion,
  claims: manifest.claims.length,
  verified: verified.length,
  verifiedShare: Number((verified.length / manifest.claims.length).toFixed(3)),
  byEvidenceGrade: tally(manifest.claims, 'evidenceGrade'),
  liveParityRows: live.length,
  claimsWithNeitherLabelNorRow: manifest.claims
    .filter((claim) => claim.evidenceGrade !== 'VERIFIED' && !claim.liveParityRow)
    .map((claim) => `${claim.id} ${claim.field}`),
  byClaimedLead: tally(manifest.claims, 'claimedLead'),
  // The matrix's column 6 declares a five-word vocabulary in its legend and the
  // cells no longer use it. Reported, not corrected — and never mapped, because
  // a mapping would invent a meaning the document does not carry.
  claimsOutsideLegendVocabulary: manifest.counts.claimsOutsideLegendVocabulary,
  bySurface: Object.fromEntries([...bySurface].map(([surface, rows]) => [surface, {
    claims: rows.length,
    verified: rows.filter((row) => row.evidenceGrade === 'VERIFIED').length,
    liveParityRows: rows.filter((row) => row.liveParityRow).length,
    byEvidenceGrade: tally(rows, 'evidenceGrade'),
  }])),
  routes: manifest.routes.length,
  // The two lists the done-when asks for by name.
  surfacesWithoutClaims: manifest.counts.surfacesWithoutClaims,
  routesWithoutClaims: manifest.routes
    .filter((entry) => !manifest.claims.some((claim) => claim.routes.includes(entry.route)))
    .map((entry) => entry.route),
  declaredDivergences: manifest.declaredDivergences.length,
};

if (process.argv.includes('--json')) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exit(0);
}

const pad = (value, width) => String(value).padEnd(width);
process.stdout.write(`conformance coverage — manifest v${report.manifestVersion}, ${report.claims} claims, ${report.routes} routes\n\n`);
process.stdout.write(`${pad('surface', 22)}${pad('claims', 8)}${pad('Ev=VER', 9)}${pad('live row', 10)}rest of Ev\n`);
for (const [surface, row] of Object.entries(report.bySurface)) {
  const rest = Object.entries(row.byEvidenceGrade)
    .filter(([grade]) => grade !== 'VERIFIED')
    .map(([grade, count]) => `${grade} ${count}`)
    .join(', ');
  process.stdout.write(`${pad(surface, 22)}${pad(row.claims, 8)}${pad(row.verified, 9)}${pad(row.liveParityRows, 10)}${rest}\n`);
}
const leads = Object.entries(report.byClaimedLead).sort((a, b) => b[1] - a[1]);
process.stdout.write(`\nclaimed disposition (as written, top 8): ${leads.slice(0, 8).map(([k, v]) => `${k} ${v}`).join(', ')}\n`);
process.stdout.write(`distinct opening phrases: ${leads.length}; outside the legend's five: ${report.claimsOutsideLegendVocabulary}\n`);
process.stdout.write(`declared divergences: ${report.declaredDivergences}\n`);
process.stdout.write(`\nsurfaces this server answers on with NO claim row: ${report.surfacesWithoutClaims.join(', ') || 'none'}\n`);
process.stdout.write(`routes with NO claim row: ${report.routesWithoutClaims.join(', ') || 'none'}\n`);
process.stdout.write(`\nEv column says VERIFIED: ${report.verified}/${report.claims} (${(report.verifiedShare * 100).toFixed(1)}%)\n`);
process.stdout.write(`live parity row on every run: ${report.liveParityRows}/${report.claims} (${((report.liveParityRows / report.claims) * 100).toFixed(1)}%)\n`);
process.stdout.write(`neither: ${report.claimsWithNeitherLabelNorRow.length}\n`);
for (const claim of report.claimsWithNeitherLabelNorRow) process.stdout.write(`  ${claim}\n`);
process.stdout.write(`\nA row whose \`Field\` cell is prose rather than a name (\`*(behavioral)* unknown top-level field\`)\ncannot match an instrument key, so it reads as uncovered even where the instrument covers it.\nThat understates coverage, which is the safe direction for a report to be wrong in.\n`);
