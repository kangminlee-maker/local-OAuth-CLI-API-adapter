#!/usr/bin/env node
require('./record-models-call.cjs')();
// A mixed-schema list, as during a server-side rollout: one entry the parser
// understands, one it does not.
process.stdout.write(`${JSON.stringify({
  models: [
    { slug: 'fixture-model-a', supported_in_api: true, supported_reasoning_levels: [{ effort: 'low' }] },
    { id: 'fixture-model-renamed-field', supported_in_api: true },
  ],
})}\n`);
