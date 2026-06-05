#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');
const args = process.argv.slice(2);
const keepTemp = args.includes('--keep-temp');
const outDir = resolve(repoRoot, readValueArg('--out-dir') ?? 'artifacts');
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

const pkg = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'));
const artifactName = packageArtifactName(pkg.name, pkg.version);
const artifactPath = join(outDir, artifactName);

await mkdir(outDir, { recursive: true });
if (existsSync(artifactPath)) await unlink(artifactPath);

run(pnpm, ['pack', '--pack-destination', outDir]);
if (!existsSync(artifactPath)) {
  throw new Error(`Expected package artifact was not created: ${artifactPath}`);
}

const entries = listTarball(artifactPath);
validateTarballEntries(entries);

const extractedDir = await mkdtemp(join(tmpdir(), 'local-oauth-cli-package-'));
const consumerDir = await mkdtemp(join(tmpdir(), 'local-oauth-cli-consumer-'));
try {
  run('tar', ['-xzf', artifactPath, '-C', extractedDir]);
  await validateExtractedPackage(join(extractedDir, 'package'));
  await validateConsumerInstall(consumerDir, artifactPath);
} finally {
  if (keepTemp) {
    process.stdout.write(`kept package temp dir: ${extractedDir}\n`);
    process.stdout.write(`kept consumer temp dir: ${consumerDir}\n`);
  } else {
    await rm(extractedDir, { recursive: true, force: true });
    await rm(consumerDir, { recursive: true, force: true });
  }
}

process.stdout.write(`adapter package ready: ${artifactPath}\n`);

function readValueArg(name) {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: options.cwd ?? repoRoot,
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (options.capture) {
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
    }
    throw new Error(`${command} ${commandArgs.join(' ')} failed with exit code ${result.status}`);
  }
  return result.stdout ?? '';
}

function packageArtifactName(name, version) {
  const normalizedName = String(name).replace(/^@/, '').replace(/\//g, '-');
  return `${normalizedName}-${version}.tgz`;
}

function listTarball(tarballPath) {
  return run('tar', ['-tzf', tarballPath], { capture: true })
    .split(/\r?\n/)
    .filter(Boolean);
}

function validateTarballEntries(entries) {
  const required = [
    'package/package.json',
    'package/README.md',
    'package/settings.json',
    'package/dist/proxy-cli.js',
    'package/dist/settings.js',
    'package/dist/proxy/http-server.js',
    'package/docs/api-benchmark-design.md',
  ];
  for (const item of required) {
    if (!entries.includes(item)) throw new Error(`Package is missing required file: ${item}`);
  }

  const disallowed = [
    'package/src/',
    'package/test/',
    'package/scripts/',
    'package/node_modules/',
    'package/pnpm-lock.yaml',
    'package/IMPLEMENTATION_MAP.html',
  ];
  for (const entry of entries) {
    const matched = disallowed.find((prefix) => entry === prefix || entry.startsWith(prefix));
    if (matched) throw new Error(`Package contains non-runtime file: ${entry}`);
  }
}

async function validateExtractedPackage(packageDir) {
  const packageJson = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'));
  if (packageJson.bin?.['local-oauth-cli'] !== './dist/proxy-cli.js') {
    throw new Error('Package bin must point to ./dist/proxy-cli.js');
  }
  if (packageJson.dependencies && Object.keys(packageJson.dependencies).length > 0) {
    throw new Error('Installable adapter package must not declare runtime dependencies.');
  }

  const forbidden = [
    legacyBrandPattern(),
    legacyNamespacePattern(),
    /link:\.\.\//,
    new RegExp(escapeRegExp(repoRoot)),
    /mcp-server/,
    /ui-gen/,
  ];
  for await (const filePath of walk(packageDir)) {
    const packageRelativePath = relative(packageDir, filePath);
    const content = await readFile(filePath, 'utf8');
    const found = forbidden.find((pattern) => pattern.test(content));
    if (found) {
      throw new Error(`Package file contains forbidden reference ${found}: ${packageRelativePath}`);
    }
    if (packageRelativePath.startsWith('dist/')) {
      validateRuntimeFileDoesNotCallDirectProvider(content, packageRelativePath);
    }
  }
}

function validateRuntimeFileDoesNotCallDirectProvider(content, filePath) {
  const forbidden = [
    /https:\/\/api\.(?:openai|anthropic)\.com/,
    /\bapi\.(?:openai|anthropic)\.com\b/,
    /Bearer\s+\$\{process\.env/,
    /x-api-key['"]?\s*:\s*process\.env/,
  ];
  const found = forbidden.find((pattern) => pattern.test(content));
  if (found) {
    throw new Error(`Runtime file contains direct provider egress reference ${found}: ${filePath}`);
  }
}

async function validateConsumerInstall(consumerDir, tarballPath) {
  await writeFile(join(consumerDir, 'package.json'), JSON.stringify({
    private: true,
    type: 'module',
  }, null, 2));
  run(pnpm, ['add', '-D', tarballPath], { cwd: consumerDir });
  const help = run(pnpm, ['exec', 'local-oauth-cli', '--help'], {
    cwd: consumerDir,
    capture: true,
  });
  if (!help.includes('Commands:') || !help.includes('proxy')) {
    throw new Error('Installed CLI help did not expose the proxy command.');
  }
  if (help.includes('generate') || help.includes('serve')) {
    throw new Error('Installed CLI exposes non-proxy commands.');
  }
}

function legacyNamespacePattern() {
  return new RegExp(`@${'g'}${'gui'}-ai/`);
}

function legacyBrandPattern() {
  return new RegExp(`${'g'}${'gui'}`, 'i');
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function* walk(dir) {
  for (const name of await readdir(dir)) {
    const filePath = join(dir, name);
    const fileStat = await stat(filePath);
    if (fileStat.isDirectory()) {
      yield* walk(filePath);
    } else if (fileStat.isFile()) {
      yield filePath;
    }
  }
}
