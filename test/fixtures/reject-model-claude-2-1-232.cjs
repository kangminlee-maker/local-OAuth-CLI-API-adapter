#!/usr/bin/env node
// The refusal exactly as Claude Code 2.1.232 emits it, captured from the real
// CLI: `api_error_status: 404` with `error: null`. 2.1.231 set `error:
// "model_not_found"` here; the field went away one patch release later, which is
// why the structured 404 has to stand on its own.
//
// The result text is deliberately NOT the English refusal sentence, so this
// fixture cannot be detected by the text fallback — it proves the 404 branch.
const argv = process.argv.slice(2);
const log = process.env.CLAUDE_TEST_ARGV_LOG;
if (log) require('node:fs').appendFileSync(log, `${JSON.stringify(argv)}\n`);

process.stdout.write(`${JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: true,
  api_error_status: 404,
  error: null,
  result: 'localized refusal text the proxy does not parse',
  usage: { input_tokens: 0, output_tokens: 0 },
})}\n`);
process.exit(0);
