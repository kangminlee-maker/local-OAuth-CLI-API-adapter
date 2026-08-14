#!/usr/bin/env node
// Emits one of the result shapes the CLI is known to produce, chosen by
// CLAUDE_TEST_RESULT_SHAPE. One fixture per shape so each recognition branch is
// exercised alone — a fixture that satisfies two branches proves neither.
//
//   assistant_only : 2.1.232. `error: "model_not_found"` on the assistant event,
//                    absent from the result. Result text matches no pattern.
//   result_only    : 2.1.231. `error` on the result event, no assistant event.
//                    Result text matches no pattern.
//   sentence_only  : neither structured field; a 404 result whose text is the
//                    refusal sentence. The last-resort branch.
//   bare_404       : an errored 404 result with NO model signal and unrelated
//                    text — a gateway failure as far as anything readable goes.
//                    Must NOT become `model_not_found`, and must not be a 200.
const readline = require('node:readline');

const shape = process.env.CLAUDE_TEST_RESULT_SHAPE || 'assistant_only';
const argv = process.argv.slice(2);
const log = process.env.CLAUDE_TEST_ARGV_LOG;
if (log) require('node:fs').appendFileSync(log, `${JSON.stringify(argv)}\n`);

const OPAQUE = 'localized refusal text the proxy does not parse';
const SENTENCE = "There's an issue with the selected model (x). It may not exist or you may not "
  + 'have access to it. Run --model to pick a different model.';
const GATEWAY = 'upstream returned 404 for the messages route';

const write = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

function assistant(fields, text) {
  write({
    type: 'assistant',
    ...fields,
    message: {
      id: 'msg_x', model: '<synthetic>', role: 'assistant', type: 'message',
      content: [{ type: 'text', text }],
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  });
}

function emit() {
  if (shape === 'assistant_only') {
    assistant({ error: 'model_not_found', is_api_error_message: true }, OPAQUE);
    write({ type: 'result', subtype: 'success', is_error: true, api_error_status: 404, result: OPAQUE });
    return;
  }
  if (shape === 'result_only') {
    write({ type: 'result', subtype: 'success', is_error: true, api_error_status: 404, error: 'model_not_found', result: OPAQUE });
    return;
  }
  if (shape === 'sentence_only') {
    write({ type: 'result', subtype: 'success', is_error: true, api_error_status: 404, result: SENTENCE });
    return;
  }
  if (shape === 'bare_404') {
    write({ type: 'result', subtype: 'success', is_error: true, api_error_status: 404, result: GATEWAY });
    return;
  }
  throw new Error(`unknown CLAUDE_TEST_RESULT_SHAPE: ${shape}`);
}

if (!argv.includes('--input-format')) {
  emit();
  process.exit(0);
}
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => { if (line.trim()) emit(); });
rl.on('close', () => process.exit(0));
