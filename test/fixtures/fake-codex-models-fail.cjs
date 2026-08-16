#!/usr/bin/env node
require('./record-models-call.cjs')();
process.stderr.write('codex: unable to reach the model service\n');
process.exit(1);
