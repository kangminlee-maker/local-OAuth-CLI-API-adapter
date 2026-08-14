#!/usr/bin/env node
// The refusal exactly as Claude Code 2.1.232 emits it, captured from the real
// binary. Two things moved between 2.1.231 and 2.1.232:
//
//   assistant: { error: "model_not_found", is_api_error_message: true, ... }
//   result:    { is_error: true, api_error_status: 404 }   <- no `error` field
//
// 2.1.231 put `error: "model_not_found"` on the RESULT event. 2.1.232 leaves it
// off there and reports it on the assistant event instead, so the proxy has to
// carry the kind across.
//
// The result text here is deliberately NOT the English refusal sentence, so this
// fixture cannot be classified by the text fallback. Only the structured
// assistant-event signal can produce the 404.
const readline = require('node:readline');

const argv = process.argv.slice(2);
const log = process.env.CLAUDE_TEST_ARGV_LOG;
if (log) require('node:fs').appendFileSync(log, `${JSON.stringify(argv)}\n`);

const write = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

function emitRefusal() {
  write({
    type: 'assistant',
    error: 'model_not_found',
    is_api_error_message: true,
    message: {
      id: 'msg_reject',
      model: '<synthetic>',
      role: 'assistant',
      type: 'message',
      content: [{ type: 'text', text: 'localized refusal text the proxy does not parse' }],
      stop_reason: 'stop_sequence',
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  });
  write({
    type: 'result',
    subtype: 'success',
    is_error: true,
    api_error_status: 404,
    result: 'localized refusal text the proxy does not parse',
    usage: { input_tokens: 0, output_tokens: 0 },
  });
}

// One-shot: no stdin is piped, so answer immediately and exit.
if (!argv.includes('--input-format')) {
  emitRefusal();
  process.exit(0);
}

// Persistent (and one-shot with stream-json stdin): answer each turn the proxy
// sends, which is what makes the persistent route reachable in a test.
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  emitRefusal();
});
rl.on('close', () => process.exit(0));
