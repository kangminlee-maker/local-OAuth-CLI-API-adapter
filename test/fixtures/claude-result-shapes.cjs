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
//   error_no_text  : an errored result with no string `result` or `error` at all.
//                    Its metadata must not reach the client.
//   subtype_only   : an error subtype with no diagnostic field at all.
//   ede_retry      : a structured-output failure as documented — no scalar
//                    diagnostic, only `subtype` and an `errors` array. Must stay
//                    retryable.
//   stderr_only    : nothing on stdout, a sentinel on stderr, non-zero exit.
//                    Those bytes are the operator's, not the client's.
const readline = require('node:readline');

const argv = process.argv.slice(2);
const shape = process.env.CLAUDE_TEST_RESULT_SHAPE || 'assistant_only';
const log = process.env.CLAUDE_TEST_ARGV_LOG;
if (log) require('node:fs').appendFileSync(log, `${JSON.stringify(argv)}\n`);

// The real CLI echoes the selected model into its refusal text, so the fixture
// does too: that is how a client-chosen string reaches the operator diagnostic,
// and a test for log injection needs it to travel that path.
const modelIndex = argv.indexOf('--model');
const selectedModel = modelIndex === -1 ? '(none)' : String(argv[modelIndex + 1]);

// Answers are tagged per turn so a test can tell WHICH turn's result settled a
// waiter. Two identical answers would let a late duplicate impersonate the next
// turn's real one.
let turns = 0;

const SENTENCE = "There's an issue with the selected model (x). It may not exist or you may not "
  + 'have access to it. Run --model to pick a different model.';
const GATEWAY = 'upstream returned 404 for the messages route';
const opaqueFor = (tag) => `localized refusal text the proxy does not parse [model=${selectedModel}] [${tag}]`;

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
  const tag = `turn-${turns}`;
  if (shape === 'assistant_only') {
    assistant({ error: 'model_not_found', is_api_error_message: true }, opaqueFor(tag));
    write({ type: 'result', subtype: 'success', is_error: true, api_error_status: 404, result: opaqueFor(tag) });
    return;
  }
  if (shape === 'result_only') {
    write({ type: 'result', subtype: 'success', is_error: true, api_error_status: 404, error: 'model_not_found', result: opaqueFor(tag) });
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
  if (shape === 'error_no_text') {
    write({
      type: 'result', subtype: 'success', is_error: true, api_error_status: 500,
      session_id: 'sentinel-session', total_cost_usd: 0.42,
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    return;
  }
  if (shape === 'subtype_only') {
    // An error subtype with no diagnostic field at all. The kind of failure is
    // the only thing worth reporting, and it must not be replaced by a generic
    // sentence that erases it.
    write({ type: 'result', subtype: 'error_max_turns', session_id: 'sentinel-session', total_cost_usd: 0.1 });
    return;
  }
  if (shape === 'ede_retry') {
    write({
      type: 'result', subtype: 'error_during_execution',
      errors: ['[ede_diagnostic] structured output could not be produced'],
      session_id: 'sentinel-session',
    });
    return;
  }
  throw new Error(`unknown CLAUDE_TEST_RESULT_SHAPE: ${shape}`);
}

if (shape === 'stderr_only') {
  process.stderr.write('SENTINEL_STDERR gateway=https://internal.example token-ish=abcd\n');
  process.exit(3);
}

// One-shot: no stdin is piped, so answer immediately and exit.
if (!argv.includes('--input-format')) {
  turns += 1;
  emit();
  process.exit(0);
}

// Persistent (and one-shot with stream-json stdin): answer each turn the proxy
// sends. `/clear`, which the backend sends between persistent turns, is NOT a
// turn — answering it would let one turn's answer settle the next turn's waiter.
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
