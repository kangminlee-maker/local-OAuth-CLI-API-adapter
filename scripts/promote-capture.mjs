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
import { execFileSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
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
// Where the fixture lands. Defaulted to the one place fixtures belong; taken as
// an option so the promoter's own refusals can be tested without writing into
// `spec/captures/`.
const outDir = readArg('--out-dir') ?? join('spec', 'captures');

if (!name || !root || !urlPart) {
  console.error('usage: promote-capture.mjs --name <fixture> --from <capture root> --url <url substring> [--kind sse|json] [--must-contain <text>] [--must-not-contain <text>] [--request-must-be <exact request body>] [--out-dir <dir>]');
  process.exit(2);
}
if (kind !== 'sse' && kind !== 'json') {
  console.error(`--kind must be sse or json, not ${kind}`);
  process.exit(2);
}
// A buffered fixture's claim is about what the request DID NOT SAY, so the
// request has to be named rather than left to whichever exchange the URL
// happens to match first: two recorder-valid 200s on one URL differing only in
// their request bodies would otherwise promote by directory mtime.
if (kind === 'json' && !requestMustBe) {
  console.error('--request-must-be is required with --kind json: the request body is the evidence for what was omitted, so it is selected by hand, not by URL.');
  process.exit(2);
}

/**
 * The tree that produced this fixture — and whether that claim binds.
 *
 * Stamping ambient `HEAD` alone is a false identity: fixtures promoted while
 * this script was still uncommitted named a revision that contains no code able
 * to write the field. What decides the claim is not the whole worktree (which
 * carries unrelated edits and would never be clean) but THIS script: if its own
 * source differs from `HEAD`, `HEAD` does not name the code that ran.
 */
function provenance() {
  try {
    const revision = execFileSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const self = relative(repoRoot, fileURLToPath(import.meta.url));
    const status = execFileSync('git', ['-C', repoRoot, 'status', '--porcelain', '--', self], { encoding: 'utf8' });
    return { revision, promoterUncommitted: status.trim() !== '' };
  } catch {
    return { revision: null, promoterUncommitted: null };
  }
}

const promotedFrom = provenance();
// A fixture that names a revision which cannot have produced it is worse than
// one that names none: a reader treats the stamp as evidence.
if (promotedFrom.promoterUncommitted && !args.includes('--allow-unbound-provenance')) {
  console.error(
    `${relative(repoRoot, fileURLToPath(import.meta.url))} has uncommitted changes, so HEAD (${promotedFrom.revision?.slice(0, 12) ?? 'unknown'}) `
    + 'does not name the code that would write this fixture. Commit the promoter first, or pass '
    + '--allow-unbound-provenance to record the stamp as unbound.',
  );
  process.exit(2);
}

const rootDir = resolve(repoRoot, root);
const runs = readdirSync(rootDir)
  .map((entry) => ({ entry, dir: join(rootDir, entry) }))
  .filter(({ dir }) => statSync(dir).isDirectory())
  .map((run) => ({ ...run, mtime: statSync(run.dir).mtimeMs }))
  .sort((left, right) => right.mtime - left.mtime);

const rejected = [];
const matches = [];

/**
 * The recorded text of a body part. The recorder stores anything over its
 * inline limit as gzip+base64 (`capture-recorder.mjs`), with the digest taken
 * over the ORIGINAL text either way — so a long or image-bearing exchange is
 * fully promotable and only looked unpromotable while this read `text` alone.
 */
function bodyText(part) {
  if (!part) return null;
  if (typeof part.text === 'string') return part.text;
  if (part.encoding === 'gzip+base64' && typeof part.gzip === 'string') {
    return gunzipSync(Buffer.from(part.gzip, 'base64')).toString('utf8');
  }
  return null;
}

for (const run of runs) {
  for (const file of readdirSync(run.dir)) {
    if (file === 'run.json') continue;
    const where = `${run.entry}/${file}`;
    const record = JSON.parse(readFileSync(join(run.dir, file), 'utf8'));
    if (record.kind !== kind || !String(record.url).includes(urlPart)) continue;
    const source = kind === 'sse' ? record.stream : record.response;
    const payload = bodyText(source);
    if (typeof payload !== 'string') { rejected.push(`${where}: ${kind} payload not stored`); continue; }
    if (record.status !== 200) { rejected.push(`${where}: status ${record.status}`); continue; }
    if (mustContain && !payload.includes(mustContain)) { rejected.push(`${where}: missing ${mustContain}`); continue; }
    if (mustNotContain && payload.includes(mustNotContain)) { rejected.push(`${where}: contains ${mustNotContain}`); continue; }
    const requestText = bodyText(record.request);
    if (typeof requestText !== 'string') { rejected.push(`${where}: request body not stored`); continue; }
    if (requestMustBe && requestText !== requestMustBe) { rejected.push(`${where}: request is ${requestText}`); continue; }

    // BOTH halves are checked against the digest the RECORDER wrote, before
    // anything is written. Checking only the response let a record whose
    // request text had been edited through: the promoter then took a fresh
    // digest over the edited text and published it as authenticated evidence,
    // pairing a response for ever with a request that did not produce it.
    for (const [half, text, part] of [['response', payload, source], ['request', requestText, record.request]]) {
      const digest = createHash('sha256').update(text).digest('hex');
      if (digest !== part.sha256) {
        console.error(`${where}: recorded ${half} does not match its own digest — the source record has been altered, refusing to promote it`);
        process.exit(1);
      }
    }
    matches.push({ where, record, source, payload, requestText });
  }
}

// Ambiguity is refused, not resolved by directory order: two exchanges that
// both satisfy every stated condition mean the conditions do not name one
// capture, and picking either would publish a choice nobody made.
const distinct = new Set(matches.map((match) => `${match.source.sha256}:${match.record.request.sha256}`));
if (distinct.size > 1) {
  console.error(`${matches.length} captures match and they are not the same exchange; add --request-must-be or --must-contain to name one:\n${matches.map((match) => `  - ${match.where}`).join('\n')}`);
  process.exit(1);
}

if (matches.length > 0) {
  const { where, record, source, payload, requestText } = matches[0];
  const out = {
    claimEvidence: name,
    originRoot: root,
    originRun: record.runId ?? where.split('/')[0],
    originFile: where.split('/')[1],
    promotedAt: new Date().toISOString(),
    requiredContent: {
      mustContain: mustContain ?? null,
      mustNotContain: mustNotContain ?? null,
      requestMustBe: requestMustBe ?? null,
    },
    promotedFrom,
    url: record.url,
    status: record.status,
    kind: record.kind,
    requestSha256: record.request.sha256,
    request: requestText,
    // Byte counts are derived from the bytes just verified, not copied from the
    // record: a count carried over from an unverified field describes whatever
    // the record claimed rather than what the fixture holds.
    ...(kind === 'sse'
      ? { streamSha256: source.sha256, streamBytes: Buffer.byteLength(payload), stream: payload }
      : { bodySha256: source.sha256, bodyBytes: Buffer.byteLength(payload), body: payload }),
  };
  const target = join(resolve(repoRoot, outDir), `${name}.json`);
  writeFileSync(target, `${JSON.stringify(out, null, 2)}\n`);
  console.log(`promoted ${name} (${kind}) from ${where} (${Buffer.byteLength(payload)} bytes, sha ${source.sha256.slice(0, 12)})`);
  process.exit(0);
}

console.error(`no capture matched. Rejected ${rejected.length} candidate(s):\n${rejected.slice(0, 8).map((line) => `  - ${line}`).join('\n')}`);
process.exit(1);

function readArg(flag) {
  const at = args.indexOf(flag);
  return at === -1 ? undefined : args[at + 1];
}
