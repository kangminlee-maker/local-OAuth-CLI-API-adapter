// A gap the author knew about must not be able to hide in a comment.
//
// A round of fixes here hit two rules that could not both hold on the
// `/v1/messages` wire — one content block at a time, and streamed tool
// arguments equal to the turn's real input — chose the first, and recorded the
// sacrifice as a comment beside a deliberately-omitted assertion. The suite
// stayed green, the review packet said the round was done, and the defect
// shipped: a client accumulating `input_json_delta` got invalid JSON. It took
// an outside reviewer a round later to find it.
//
// The lesson is not "write better comments". A known gap that only a reader
// notices is a gap nothing enforces, so this makes the marker itself fail:
// leaving one is now impossible to do quietly. Close the gap, or say it out
// loud where a decision gets made — never in a file that goes green.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const testDir = dirname(fileURLToPath(import.meta.url));
const srcDir = join(testDir, '..', 'src');

// Phrases that announce an author-known gap. Kept literal and few: a broad
// pattern would catch ordinary prose and teach people to reword instead of
// report.
const MARKERS = [
  'KNOWN HOLE',
  'deliberately not asserted',
  'not asserted as contract',
  'knowingly unasserted',
];

async function filesUnder(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await filesUnder(full));
    else if (/\.(mjs|cjs|js|ts)$/.test(entry.name)) out.push(full);
  }
  return out;
}

/**
 * The scan itself, as a function the control can run.
 *
 * It used to be inlined in the test, and the "can it find a marker" control
 * checked the marker LIST and the directory walk without ever passing a line
 * through the matching — so disabling the match entirely left both tests green.
 * A control that cannot fail is the whole thing this file exists to catch, and
 * it was in this file.
 */
async function markersIn(files, self) {
  const found = [];
  for (const file of files) {
    if (file === self) continue;
    const text = await readFile(file, 'utf8');
    for (const [index, line] of text.split('\n').entries()) {
      for (const marker of MARKERS) {
        if (line.includes(marker)) found.push({ file, line: index + 1, text: line.trim().slice(0, 100) });
      }
    }
  }
  return found;
}

const self = fileURLToPath(import.meta.url);

test('no file declares a gap it leaves unasserted', async () => {
  const files = [...await filesUnder(testDir), ...await filesUnder(srcDir)];
  const found = await markersIn(files, self);
  assert.deepEqual(found.map((f) => `${f.file}:${f.line}: ${f.text}`), [],
    'a gap is recorded in a comment instead of being closed or raised');
});

test('the scan finds a marker in a real file, and reports where', async () => {
  // Through the SAME function the check above uses, against a real file on
  // disk — so breaking the match breaks this too.
  const dir = await mkdtemp(join(tmpdir(), 'marker-scan-'));
  try {
    const planted = join(dir, 'planted.mjs');
    await writeFile(planted, `// fine\n// ${MARKERS[0]}: a planted line\n// also fine\n`);
    const clean = join(dir, 'clean.mjs');
    await writeFile(clean, '// nothing to see here\n');

    const hits = await markersIn(await filesUnder(dir), self);
    assert.equal(hits.length, 1, 'exactly the planted line is reported');
    assert.equal(hits[0].file, planted, 'and it names the file it was in');
    assert.equal(hits[0].line, 2, 'and the line it was on');

    // The other direction: a tree with no marker reports nothing, so the scan
    // is not simply returning everything it walks.
    assert.deepEqual(await markersIn([clean], self), []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('every marker in the list is one the scan would catch', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'marker-each-'));
  try {
    for (const [index, marker] of MARKERS.entries()) {
      const file = join(dir, `m${index}.mjs`);
      await writeFile(file, `// ${marker} here\n`);
      const hits = await markersIn([file], self);
      assert.equal(hits.length, 1, `the list entry ${JSON.stringify(marker)} is never matched by the scan`);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
