import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { startLocalApiProxy } from '../dist/proxy/http-server.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(`${root}/spec/conformance.json`, 'utf8'));

test('the manifest is what the matrix says', () => {
  // The builder rebuilds in memory and compares. Editing `spec/conformance.json`
  // by hand, or changing the matrix without rebuilding, fails here — which is
  // what makes the manifest a projection of the document rather than a second
  // copy of it that drifts.
  execFileSync(process.execPath, [`${root}/scripts/build-conformance-manifest.mjs`, '--check'], { stdio: 'pipe' });
});

test('the manifest carries one claim per numbered matrix row', () => {
  // Counted here independently of the builder: if the extractor silently
  // stopped matching a section, its own output would still be self-consistent.
  const lines = readFileSync(`${root}/docs/conformance-matrix.md`, 'utf8').split('\n');
  let section = null;
  let counted = 0;
  for (const line of lines) {
    const heading = /^## (\d)\. /.exec(line);
    if (heading) section = Number(heading[1]);
    if (section === null || section < 1 || section > 4) continue;
    if (/^\| *[A-Za-z]*-?\d+ *\|/.test(line)) counted += 1;
  }
  assert.ok(counted > 100, `the recount must actually find rows, got ${counted}`);
  assert.equal(manifest.claims.length, counted);
  assert.equal(manifest.counts.claims, counted);
  assert.equal(new Set(manifest.claims.map((claim) => claim.id)).size, counted, 'claim ids must be unique');
});

test('every route the manifest lists is a route this server answers', async () => {
  // Probed, not read off a constant the dispatcher does not use. A route the
  // server stopped serving would answer 404 here even though the list still
  // names it.
  const started = await startLocalApiProxy({
    backend: {
      name: 'test', model: 'm',
      async generate() { throw new Error('unused'); },
      async *stream() { throw new Error('unused'); },
      async close() {},
    },
    host: '127.0.0.1', port: 0, requestTimeoutMs: 5_000,
  });
  try {
    for (const entry of manifest.routes) {
      const [method, template] = entry.route.split(' ');
      const path = template.replace('{id}', 'probe-session');
      const res = await fetch(`${started.url}${path}`, {
        method,
        headers: { 'content-type': 'application/json' },
        ...(method === 'POST' ? { body: '{}' } : {}),
      });
      // 404 is this server's answer for a path it does not serve. Anything else
      // — 400 for a bad body, 501 for a disabled feature, 200 — proves it does.
      assert.notEqual(res.status, 404, `${entry.route} answered 404: the manifest lists a route the server does not serve`);
      await res.text();
    }
  } finally {
    await started.close();
  }
});

test('a path the manifest does not list is a 404', async () => {
  // The other direction: the list must not be SHORT either. If one of these
  // ever starts answering, the manifest is missing a surface.
  const started = await startLocalApiProxy({
    backend: {
      name: 'test', model: 'm',
      async generate() { throw new Error('unused'); },
      async *stream() { throw new Error('unused'); },
      async close() {},
    },
    host: '127.0.0.1', port: 0, requestTimeoutMs: 5_000,
  });
  try {
    for (const path of ['/v1/completions', '/v1/embeddings', '/v1/images/variations', '/v1/files', '/local/cli/nope', '/v1/models/gpt-5']) {
      const res = await fetch(`${started.url}${path}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      });
      assert.equal(res.status, 404, `${path} answered ${res.status}: the manifest lists no such route`);
      await res.text();
    }
  } finally {
    await started.close();
  }
});

test('the coverage report runs and names the unexamined surfaces', () => {
  const out = execFileSync(process.execPath, [`${root}/scripts/conformance-coverage.mjs`, '--json'], { encoding: 'utf8' });
  const report = JSON.parse(out);
  assert.equal(report.claims, manifest.claims.length);
  // The done-when of this stage: unexamined surfaces are ENUMERATED, not
  // counted. Both of these are real — nothing in the matrix covers either.
  assert.deepEqual(report.surfacesWithoutClaims.sort(), ['local-cli-sessions', 'openai-models']);
  assert.ok(report.routesWithoutClaims.length > 0, 'those surfaces have routes, so the route list cannot be empty');
});

test('derived evidence is derived, not declared', () => {
  // `liveParityRow` says the field is sent to both the vendor and this proxy on
  // every instrument run. It has to disagree with the hand-kept `Ev` column
  // somewhere, or it is just reading the column back: the Responses surface is
  // graded 7 VERIFIED of 41 by a column written before it was measured.
  const responses = manifest.claims.filter((claim) => claim.surface === 'openai-responses');
  const labelled = responses.filter((claim) => claim.evidenceGrade === 'VERIFIED').length;
  const derived = responses.filter((claim) => claim.liveParityRow).length;
  assert.ok(derived > labelled, `derived ${derived} must exceed the stale label's ${labelled}`);
  // And it must not simply be true everywhere.
  assert.ok(manifest.claims.some((claim) => !claim.liveParityRow), 'a detector that never says no measures nothing');
});
