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
// `sse` promotes the wire bytes, `json` the buffered body. Defaulted so the
// invocations that predate the option keep promoting streams.
const kind = readArg('--kind') ?? 'sse';
// The request body is what proves a field was OMITTED, which is the whole
// claim for an echoed default — a response alone cannot say what was asked.
const requestMustBe = readArg('--request-must-be');

if (!name || !root || !urlPart) {
  console.error('usage: promote-capture.mjs --name <fixture> --from <capture root> --url <url substring> [--kind sse|json] [--must-contain <text>] [--must-not-contain <text>] [--request-must-be <exact request body>]');
  process.exit(2);
}
if (kind !== 'sse' && kind !== 'json') {
  console.error(`--kind must be sse or json, not ${kind}`);
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
    if (record.kind !== kind || !String(record.url).includes(urlPart)) continue;
    const source = kind === 'sse' ? record.stream : record.response;
    const payload = source?.text;
    if (typeof payload !== 'string') { rejected.push(`${run.entry}/${file}: ${kind} payload not stored inline`); continue; }
    if (record.status !== 200) { rejected.push(`${run.entry}/${file}: status ${record.status}`); continue; }
    if (mustContain && !payload.includes(mustContain)) { rejected.push(`${run.entry}/${file}: missing ${mustContain}`); continue; }
    if (mustNotContain && payload.includes(mustNotContain)) { rejected.push(`${run.entry}/${file}: contains ${mustNotContain}`); continue; }
    const requestText = record.request?.text;
    if (typeof requestText !== 'string') { rejected.push(`${run.entry}/${file}: request body not stored inline`); continue; }
    if (requestMustBe && requestText !== requestMustBe) { rejected.push(`${run.entry}/${file}: request is ${requestText}`); continue; }

    // Verified BEFORE the write: a fixture that does not match its origin
    // should never reach the tree, not even to be reported as broken.
    const digest = createHash('sha256').update(payload).digest('hex');
    if (digest !== source.sha256) {
      console.error(`${run.entry}/${file}: ${kind} text does not match the recorded digest`);
      process.exit(1);
    }

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
      requestSha256: createHash('sha256').update(requestText).digest('hex'),
      request: requestText,
      ...(kind === 'sse'
        ? { streamSha256: source.sha256, streamBytes: source.bytes, stream: payload }
        : { bodySha256: source.sha256, bodyBytes: source.bytes, body: payload }),
    };
    const target = join(repoRoot, 'spec', 'captures', `${name}.json`);
    writeFileSync(target, `${JSON.stringify(out, null, 2)}\n`);
    console.log(`promoted ${name} (${kind}) from ${run.entry}/${file} (${source.bytes} bytes, sha ${digest.slice(0, 12)})`);
    process.exit(0);
  }
}

console.error(`no capture matched. Rejected ${rejected.length} candidate(s):\n${rejected.slice(0, 8).map((line) => `  - ${line}`).join('\n')}`);
process.exit(1);

function readArg(flag) {
  const at = args.indexOf(flag);
  return at === -1 ? undefined : args[at + 1];
}
