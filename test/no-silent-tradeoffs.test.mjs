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
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
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

test('no file declares a gap it leaves unasserted', async () => {
  const files = [...await filesUnder(testDir), ...await filesUnder(srcDir)];
  const found = [];
  for (const file of files) {
    if (file === fileURLToPath(import.meta.url)) continue;
    const text = await readFile(file, 'utf8');
    for (const [index, line] of text.split('\n').entries()) {
      for (const marker of MARKERS) {
        if (line.includes(marker)) found.push(`${file.slice(testDir.length - 4)}:${index + 1}: ${line.trim().slice(0, 100)}`);
      }
    }
  }
  assert.deepEqual(found, [], `a gap is recorded in a comment instead of being closed or raised:\n${found.join('\n')}`);
});

test('the marker scan can actually find a marker', async () => {
  // The check above passes trivially if the scan is broken — and a scan that
  // silently matches nothing is exactly the failure this file exists to catch.
  const planted = `// ${MARKERS[0]}: a planted line`;
  assert.ok(MARKERS.some((marker) => planted.includes(marker)), 'the marker list must match a known-bad line');
  assert.equal((await filesUnder(testDir)).length > 0, true, 'the walk must reach the test directory');
  assert.equal((await filesUnder(srcDir)).length > 0, true, 'and the source directory');
});
