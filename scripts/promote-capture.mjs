#!/usr/bin/env node
// Move one recorded exchange out of the run directory and into `spec/captures/`,
// where a conformance check can read it.
//
// The selection is the point. A first attempt took "the first SSE capture whose
// URL matches" and promoted an ERROR stream — the run it came from had failed on
// an upstream overload, and the error path deliberately keeps a terminator the
// success path does not. The fixture then disagreed with the claim it was
// supposed to evidence, for a reason that had nothing to do with the code under
// test. So a promotion states what the capture must contain, and refuses rather
// than promoting something that does not.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const name = readArg('--name');
const root = readArg('--from');
const urlPart = readArg('--url');
const mustContain = readArg('--must-contain');
const mustNotContain = readArg('--must-not-contain');

if (!name || !root || !urlPart) {
  console.error('usage: promote-capture.mjs --name <fixture> --from <capture root> --url <url substring> [--must-contain <text>] [--must-not-contain <text>]');
  process.exit(2);
}

const rootDir = resolve(repoRoot, root);
const runs = readdirSync(rootDir)
  .map((entry) => ({ entry, dir: join(rootDir, entry) }))
  .filter(({ dir }) => statSync(dir).isDirectory())
  .map((run) => ({ ...run, mtime: statSync(run.dir).mtimeMs }))
  .sort((left, right) => right.mtime - left.mtime);

const rejected = [];
for (const run of runs) {
  for (const file of readdirSync(run.dir)) {
    if (file === 'run.json') continue;
    const record = JSON.parse(readFileSync(join(run.dir, file), 'utf8'));
    if (record.kind !== 'sse' || !String(record.url).includes(urlPart)) continue;
    const wire = record.stream?.text;
    if (typeof wire !== 'string') { rejected.push(`${run.entry}/${file}: stream not stored inline`); continue; }
    if (record.status !== 200) { rejected.push(`${run.entry}/${file}: status ${record.status}`); continue; }
    if (mustContain && !wire.includes(mustContain)) { rejected.push(`${run.entry}/${file}: missing ${mustContain}`); continue; }
    if (mustNotContain && wire.includes(mustNotContain)) { rejected.push(`${run.entry}/${file}: contains ${mustNotContain}`); continue; }

    const out = {
      claimEvidence: name,
      originRoot: root,
      originRun: run.entry,
      originFile: file,
      promotedAt: new Date().toISOString(),
      requiredContent: { mustContain: mustContain ?? null, mustNotContain: mustNotContain ?? null },
      url: record.url,
      status: record.status,
      kind: record.kind,
      streamSha256: record.stream.sha256,
      streamBytes: record.stream.bytes,
      stream: wire,
    };
    const target = join(repoRoot, 'spec', 'captures', `${name}.json`);
    writeFileSync(target, `${JSON.stringify(out, null, 2)}\n`);
    const digest = createHash('sha256').update(wire).digest('hex');
    if (digest !== record.stream.sha256) {
      console.error('promoted wire text does not match the recorded digest');
      process.exit(1);
    }
    console.log(`promoted ${name} from ${run.entry}/${file} (${out.streamBytes} bytes, sha ${digest.slice(0, 12)})`);
    process.exit(0);
  }
}

console.error(`no capture matched. Rejected ${rejected.length} candidate(s):\n${rejected.slice(0, 8).map((line) => `  - ${line}`).join('\n')}`);
process.exit(1);

function readArg(flag) {
  const at = args.indexOf(flag);
  return at === -1 ? undefined : args[at + 1];
}
