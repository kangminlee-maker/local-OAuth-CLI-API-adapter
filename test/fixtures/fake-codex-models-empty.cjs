#!/usr/bin/env node
require('./record-models-call.cjs')();
// A conclusive answer: this account is entitled to no model.
process.stdout.write(`${JSON.stringify({ models: [] })}\n`);
