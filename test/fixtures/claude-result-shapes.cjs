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
//   error_no_text  : an errored result with no string `result` or `error` at all.
//                    Its metadata must not reach the client.
//   bare_404       : an errored 404 result with NO model signal and unrelated
//                    text — a gateway failure as far as anything readable goes.
//                    Must NOT become `model_not_found`, and must not be a 200.
const readline = require('node:readline');

const shape = process.env.CLAUDE_TEST_RESULT_SHAPE || 'assistant_only';
const argv = process.argv.slice(2);
const log = process.env.CLAUDE_TEST_ARGV_LOG;
if (log) require('node:fs').appendFileSync(log, `${JSON.stringify(argv)}\n`);

// The real CLI echoes the selected model into its refusal text, so the fixture
// does too: that is how a client-chosen string reaches the operator diagnostic,
// and a test for log injection needs it to actually travel that path.
const modelIndex = argv.indexOf('--model');
const selectedModel = modelIndex === -1 ? '(none)' : String(argv[modelIndex + 1]);
const OPAQUE = `localized refusal text the proxy does not parse [model=${selectedModel}]`;
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
  if (shape === 'error_no_text') {
    // An errored result with neither `result` nor `error` as a string. The event
    // metadata here is what must not reach a client.
    write({
      type: 'result', subtype: 'success', is_error: true, api_error_status: 500,
      session_id: 'sentinel-session', total_cost_usd: 0.42,
      usage: { input_tokens: 1, output_tokens: 1 },
    });
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
// Count only real user turns. The backend sends `/clear` after each persistent
// turn; answering it with a result would let one turn's answer settle the NEXT
// turn's waiter, so a two-turn test could pass having produced one real answer.
let turns = 0;
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let text = '';
  try {
    const content = JSON.parse(line)?.message?.content;
    text = Array.isArray(content)
      ? content.map((b) => (b && b.type === 'text' ? b.text : '')).join('')
      : String(content ?? '');
  } catch {
    text = line;
  }
  if (text.trim() === '/clear') return;
  turns += 1;
  if (log) require('node:fs').appendFileSync(log, `${JSON.stringify(['#turn', turns])}\n`);
  emit();
});
rl.on('close', () => process.exit(0));
