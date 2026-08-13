import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  findForbiddenReference,
  maskAllowedMentions,
  strictSiblingPattern,
} from '../scripts/package-forbidden-patterns.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

const rejects = (content, filePath) =>
  findForbiddenReference(content, filePath, repoRoot) !== undefined;

// Reference forms the old bare-name rule caught. Enumerating syntaxes is exactly
// what this check refuses to do, so every one of these must be rejected by the
// bare-name rule rather than by a form-specific pattern.
const SIBLING_REFERENCES = [
  ["relative import", "import { serve } from '../mcp-server/index.js';"],
  ["side-effect import", "import 'mcp-server';"],
  ["bare subpath import", "import x from 'mcp-server/register';"],
  ["require.resolve", "require.resolve('mcp-server')"],
  ["dependency key", '"mcp-server": "^1.2.0"'],
  ["workspace link value", '"mcp-server": "link:../mcp-server"'],
  ["unquoted yaml key", "  mcp-server: workspace:*"],
  ["config extends value", '{"extends":"mcp-server/tsconfig.json"}'],
  ["tsconfig types list", '{"types":["mcp-server"]}'],
  ["triple-slash reference", '/// <reference types="mcp-server" />'],
  ["turbo task key", '"mcp-server#build": {}'],
  ["bare task key", 'mcp-server#build'],
  ["project graph member", 'dependsOn: [mcp-server]'],
  ["workspace alias value", '"tool": "workspace:mcp-server"'],
  ["long filter", "pnpm --filter mcp-server build"],
  ["short filter", "pnpm -F mcp-server build"],
  ["selector prefix filter", "pnpm --filter ...mcp-server build"],
  ["directory flag", "pnpm -C mcp-server build"],
  ["cd into sibling", "cd mcp-server && pnpm build"],
  ["yarn workspace", "yarn workspace mcp-server build"],
  ["npm workspace", "npm -w mcp-server run build"],
  ["install command", "pnpm add mcp-server"],
  ["package runner", "pnpm exec mcp-server"],
  ["leading path component", "cp mcp-server/dist/index.js out/"],
  ["windows leading path", "COPY mcp-server\\dist\\index.js ."],
  ["source map windows path", '"sources":["..\\\\mcp-server\\\\src\\\\index.ts"]'],
  ["jest mock", 'jest.mock("mcp-server");'],
  ["bare prose", "copied from the mcp-server package"],
];

const CODE_FILES = ['dist/proxy/http-server.js', 'package.json', 'settings.json', 'postinstall.mjs'];

for (const file of CODE_FILES) {
  test(`code and configuration reject every sibling reference form: ${file}`, () => {
    for (const [label, content] of SIBLING_REFERENCES) {
      assert.equal(rejects(content, file), true, `${file} should reject ${label}: ${content}`);
    }
  });
}

test('documentation rejects every sibling reference form too', () => {
  for (const [label, content] of SIBLING_REFERENCES) {
    assert.equal(rejects(content, 'docs/a.md'), true, `docs should reject ${label}: ${content}`);
  }
});

test('only the exact catalog occurrence in the exact catalog file is allowed', () => {
  const catalogRow =
    '| `mcp` / `mcp-server` | 외부 MCP 서버 관리 (`mcp list`) / Codex를 MCP 서버로 실행 | 서비스 tool bridge 후보 |';
  assert.equal(rejects(catalogRow, 'docs/runtime-capability-catalog.md'), false);
  // Same text, different file.
  assert.equal(rejects(catalogRow, 'docs/other.md'), true);
  // Same file, a different way of writing the name.
  assert.equal(rejects('`mcp-server`', 'docs/runtime-capability-catalog.md'), true);
  assert.equal(rejects('codex mcp-server', 'docs/runtime-capability-catalog.md'), true);
  // The allowed occurrence does not license a second, real reference beside it.
  const withImport = `${catalogRow}\n\nimport x from '../mcp-server/index.js';`;
  assert.equal(rejects(withImport, 'docs/runtime-capability-catalog.md'), true);
  // Nor does repeating the allowed literal itself multiply the allowance.
  const twice = `${catalogRow}\n${catalogRow}`;
  assert.equal(rejects(twice, 'docs/runtime-capability-catalog.md'), true);
});

test('Markdown structure is not interpreted, so no code-block form can bypass', () => {
  // Each of these bypassed an earlier structure-aware masker. None of them is
  // the allowed literal, so all are rejected without parsing anything.
  const forms = [
    ['fenced', ['```js', 'await import(`mcp-server`)', '```'].join('\n')],
    ['tilde fenced', ['~~~js', 'require(`mcp-server`)', '~~~'].join('\n')],
    ['indented', '    const mod = await import(`mcp-server`);'],
    ['tab indented', '\trequire(`mcp-server`)'],
    ['double backtick', 'use ``mcp-server`` here'],
    ['nested fence', ['````md', '```js', 'await import(`mcp-server`)', '```', '````'].join('\n')],
    ['malformed closer', ['```js', '```not-a-close', 'await import(`mcp-server`)', '```'].join('\n')],
    ['blockquoted fence', ['> ```js', '> await import(`mcp-server`)', '> ```'].join('\n')],
  ];
  for (const [label, content] of forms) {
    assert.equal(rejects(content, 'docs/runtime-capability-catalog.md'), true, `${label}: ${content}`);
  }
});

test('generated identifiers that concatenate the sibling name are rejected', () => {
  // Build metadata routinely joins a project name to a target or hash. These
  // identify the sibling, so the rule must not stop at a word boundary.
  for (const content of [
    '"mcp-serverBuild": {}',
    '"ui-genConfig"',
    'chunk-mcp-servera1b2.js',
    'mcp-server_bundle',
    'build_mcp-server:',
  ]) {
    assert.equal(rejects(content, 'dist/a.js'), true, content);
    assert.equal(rejects(content, 'docs/a.md'), true, content);
  }
});

test('sibling names are matched case-insensitively and across underscore joins', () => {
  // Case: macOS and Windows filesystems resolve these to the same directory.
  assert.equal(rejects("require('../MCP-SERVER')", 'dist/a.js'), true);
  assert.equal(rejects('..\\UI-GEN\\dist', 'dist/a.js'), true);
  assert.equal(rejects("import x from '../Mcp-Server/index.js'", 'docs/a.md'), true);
  // Underscore joins: realistic CI task keys that `\b` would have missed.
  assert.equal(rejects('build_mcp-server:', 'dist/a.js'), true);
  assert.equal(rejects('mcp-server_bundle', 'dist/a.js'), true);
  assert.equal(rejects('build_ui-gen', 'dist/a.js'), true);
  // A longer compound is rejected too: the rule is a plain substring, and an
  // unrelated word containing the sibling name has no reason to ship here.
  assert.equal(rejects('my-mcp-serverless-thing', 'dist/a.js'), true);
});

test('the strict rule matches the whole name only', () => {
  const strict = strictSiblingPattern('mcp-server');
  assert.equal(strict.test('mcp-server'), true);
  assert.equal(strict.test('nothing to see here'), false);
  assert.equal(strict.test('my-mcp-serverless-thing'), true);
});

const MONOREPO_REFERENCES = [
  ["legacy namespace", '"@ggui-ai/core": "1.0.0"'],
  ["legacy brand", "Generated by the GGUI toolchain"],
  ["workspace link", '"x": "link:../something"'],
];

for (const [label, content] of MONOREPO_REFERENCES) {
  test(`every file kind rejects: ${label}`, () => {
    assert.equal(rejects(content, 'docs/a.md'), true, content);
    assert.equal(rejects(content, 'dist/a.js'), true, content);
  });
}

test('the checkout path is rejected everywhere', () => {
  const content = `see ${repoRoot}/src/proxy/http-server.ts`;
  assert.equal(rejects(content, 'docs/a.md'), true);
  assert.equal(rejects(content, 'dist/a.js'), true);
});

async function* walkPackagedEntry(entry) {
  // `package.json#files` mixes files and directories (`dist/proxy/`), so a
  // non-recursive pass would silently skip most of what actually ships.
  const absolute = resolve(repoRoot, entry);
  const info = await stat(absolute);
  if (info.isFile()) {
    yield absolute;
    return;
  }
  for (const name of await readdir(absolute)) {
    yield* walkPackagedEntry(join(entry, name));
  }
}

test('every packaged file, including those inside packaged directories, passes', async () => {
  const pkg = JSON.parse(await readFile(resolve(repoRoot, 'package.json'), 'utf8'));
  const inspected = [];
  for (const entry of pkg.files) {
    for await (const filePath of walkPackagedEntry(entry)) {
      const content = await readFile(filePath, 'utf8');
      const packageRelativePath = relative(repoRoot, filePath);
      const offender = findForbiddenReference(content, packageRelativePath, repoRoot);
      assert.equal(offender, undefined, `${packageRelativePath} matched ${offender}`);
      inspected.push(packageRelativePath);
    }
  }
  // Guards the denominator: if the walk silently inspected nothing, or missed the
  // directory entries, this assertion fails rather than reporting a clean pass.
  assert.ok(inspected.length > 20, `expected a full package walk, inspected ${inspected.length}`);
  assert.ok(
    inspected.some((p) => p.startsWith('dist/proxy/')),
    'expected files inside packaged directories to be inspected',
  );
  assert.ok(
    inspected.includes('docs/runtime-capability-catalog.md'),
    'expected the catalog, which is the file that forced the documentation exception',
  );
});
