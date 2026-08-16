#!/usr/bin/env node
require('./record-models-call.cjs')();
process.stdout.write(`${JSON.stringify({
  models: [
    { slug: 'fixture-model-a', supported_in_api: true, supported_reasoning_levels: [{ effort: 'low' }, { effort: 'max' }] },
    { slug: 'fixture-model-b', supported_in_api: false, supported_reasoning_levels: [] },
  ],
})}\n`);
