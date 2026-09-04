// Codex app-server protocol schema: method surface and the request parameter
// contracts the catalog documents.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { HOT_PATH_REQUEST_METHODS } from './options.mjs';
import { listFiles, run, summarizeCommand } from './exec.mjs';
import { walkJson } from './text.mjs';

export async function collectCodexSchema(binary) {
  const tmp = await mkdtemp(join(tmpdir(), 'codex-app-server-schema-'));
  try {
    const generated = await run(binary, [
      'app-server',
      'generate-json-schema',
      '--experimental',
      '--out',
      tmp,
    ], {
      timeoutMs: 30_000,
      maxBuffer: 20_000_000,
    });

    if (!generated.ok) {
      return { generated: summarizeCommand(generated), files: [], methodEnums: {} };
    }

    const files = await listFiles(tmp);
    const methodEnums = {};
    for (const name of [
      'ClientRequest.json',
      'ClientNotification.json',
      'ServerRequest.json',
      'ServerNotification.json',
    ]) {
      const filePath = join(tmp, name);
      if (!existsSync(filePath)) continue;
      const schema = JSON.parse(await readFile(filePath, 'utf8'));
      methodEnums[name.replace(/\.json$/, '')] = collectMethodEnums(schema);
    }

    return {
      generated: summarizeCommand(generated),
      files: files.map((filePath) => relative(tmp, filePath)).sort(),
      methodEnums,
      requestContracts: await collectRequestContracts(tmp, HOT_PATH_REQUEST_METHODS),
    };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

// Method names alone do not describe what a request accepts. The catalog
// documents the parameter contract for the hot-path requests, and that contract
// is what justifies sending only declared fields, so it needs to be collected
// and compared rather than trusted.
export async function collectRequestContracts(schemaDir, methods) {
  const filePath = join(schemaDir, 'ClientRequest.json');
  if (!existsSync(filePath)) return {};
  const schema = JSON.parse(await readFile(filePath, 'utf8'));
  const definitions = schema.definitions ?? {};
  const contracts = {};
  for (const method of methods) {
    let paramsRef = null;
    walkJson(schema, (node) => {
      if (node?.properties?.method?.enum?.length === 1
        && node.properties.method.enum[0] === method
        && node.properties?.params?.$ref) {
        paramsRef = node.properties.params.$ref;
      }
    });
    if (!paramsRef) continue;
    const definition = definitions[paramsRef.split('/').pop()];
    if (!definition) continue;
    const properties = Object.keys(definition.properties ?? {}).sort();
    const required = [...(definition.required ?? [])].sort();
    contracts[method] = {
      required,
      optional: properties.filter((name) => !required.includes(name)),
    };
  }
  return contracts;
}

export function collectMethodEnums(schema) {
  const values = new Set();
  walkJson(schema, (node) => {
    const methodEnum = node?.properties?.method?.enum;
    if (Array.isArray(methodEnum)) {
      for (const value of methodEnum) values.add(value);
    }
  });
  return [...values].sort();
}
