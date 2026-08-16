// Records that `debug models` was actually invoked, so a test can prove the
// catalogue was collected rather than assumed.
//
// Prefers an explicit log path because the backend runs the CLI against an
// isolated CODEX_HOME it creates itself, which the test cannot predict.
const { appendFileSync } = require('node:fs');
const { join } = require('node:path');

module.exports = function record() {
  const explicit = process.env.CODEX_MODELS_CALL_LOG;
  const home = process.env.CODEX_HOME;
  const target = explicit || (home ? join(home, 'debug-models-calls.log') : null);
  if (!target) return;
  appendFileSync(target, `${process.argv.slice(2).join(' ')}\n`);
};
