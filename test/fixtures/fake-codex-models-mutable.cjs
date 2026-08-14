#!/usr/bin/env node
// A catalogue that can change between invocations, so a test can add a slug to
// "the runtime" and observe what a later request sees. Every other models
// fixture is fixed, which cannot express a runtime that gained a model.
require('./record-models-call.cjs')();
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const home = process.env.CODEX_HOME;
let slugs = ['fixture-model-a'];
try {
  slugs = JSON.parse(readFileSync(join(home, 'advertised.json'), 'utf8'));
} catch {
  // Falls back to the default list; the test writes the file before it matters.
}
process.stdout.write(`${JSON.stringify({
  models: slugs.map((slug) => ({
    slug,
    supported_in_api: true,
    supported_reasoning_levels: [{ effort: 'low' }],
  })),
})}\n`);
