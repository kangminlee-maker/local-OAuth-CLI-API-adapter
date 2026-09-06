#!/usr/bin/env node
// The Claude CLI as the NATIVE chat session drives it: a persistent
// stream-json child with no system prompt of its own. The sibling
// `fake-claude.cjs` fakes the API completion backend, whose argv it asserts,
// and a session turn is not that request.
const readline = require('node:readline');

require('./direct-provider-env.cjs').assertNoDirectProviderEnv('fake claude native');

const args = process.argv.slice(2);
if (args[args.indexOf('--input-format') + 1] !== 'stream-json') {
  process.stderr.write(`native chat session must drive a stream-json child: ${args.join(' ')}\n`);
  process.exit(2);
}

// A child a test can find by pid, and one that will not leave on SIGTERM: the
// teardown must escalate, and a close must not resolve over a live child.
if (process.env.FAKE_CLAUDE_PID_FILE) require('node:fs').writeFileSync(process.env.FAKE_CLAUDE_PID_FILE, String(process.pid));
if (process.env.FAKE_CLAUDE_IGNORE_SIGTERM === '1') process.on('SIGTERM', () => {});

function write(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let payload;
  try {
    payload = JSON.parse(line);
  } catch {
    return;
  }
  const content = payload?.message?.content;
  const text = Array.isArray(content)
    ? content.map((part) => part?.text ?? '').join('')
    : String(content ?? '');
  // A child that took the prompt and never answered — the failure an interrupt
  // exists for, and the only way to hold a turn open here.
  if (text.includes('HANG')) return;
  // A child that dies on this prompt: the session is left with no child.
  if (text.includes('EXIT')) process.exit(0);
  // A result that comes late: the delta now, the `result` 150 ms later — the
  // window a reader can walk away in, and the line that then went to whoever
  // was running by the time it arrived.
  if (text.includes('LATE_RESULT')) {
    write({ type: 'system', subtype: 'init', session_id: 'fake_native_session' });
    write({
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'LATE_HEAD' } },
      session_id: 'fake_native_session',
    });
    setTimeout(() => write({
      type: 'result',
      subtype: 'success',
      result: 'LATE_RESULT',
      session_id: 'fake_native_session',
      usage: { input_tokens: 1, output_tokens: 11 },
    }), 150);
    return;
  }
  // A turn that answers only after 300 ms, all at once.
  if (text.includes('DELAYED')) {
    setTimeout(() => {
      write({ type: 'system', subtype: 'init', session_id: 'fake_native_session' });
      write({
        type: 'stream_event',
        event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'DELAYED_REAL' } },
        session_id: 'fake_native_session',
      });
      write({
        type: 'result',
        subtype: 'success',
        result: 'DELAYED_REAL',
        session_id: 'fake_native_session',
        usage: { input_tokens: 2, output_tokens: 22 },
      });
    }, 300);
    return;
  }
  // A turn that streams for longer than one deadline while never falling
  // silent for one: six deltas 100 ms apart, then the result.
  if (text.includes('SLOW')) {
    write({ type: 'system', subtype: 'init', session_id: 'fake_native_session' });
    let step = 0;
    const tick = () => {
      if (step < 6) {
        write({
          type: 'stream_event',
          event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `${step} ` } },
          session_id: 'fake_native_session',
        });
        step += 1;
        setTimeout(tick, 100);
        return;
      }
      write({
        type: 'result',
        subtype: 'success',
        result: 'SLOW-DONE',
        session_id: 'fake_native_session',
        usage: { input_tokens: 1, output_tokens: 6 },
      });
    };
    setTimeout(tick, 100);
    return;
  }
  // One event and then silence: the turn produces, so its reader can stop
  // advancing at a yield, and the turn stays open behind it.
  if (text.includes('PARTIAL')) {
    write({ type: 'system', subtype: 'init', session_id: 'fake_native_session' });
    write({
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'thinking' } },
      session_id: 'fake_native_session',
    });
    return;
  }
  write({ type: 'system', subtype: 'init', session_id: 'fake_native_session' });
  write({
    type: 'stream_event',
    event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'OK' } },
    session_id: 'fake_native_session',
  });
  write({
    type: 'result',
    subtype: 'success',
    result: 'OK',
    session_id: 'fake_native_session',
    usage: { input_tokens: 1, output_tokens: 1 },
  });
});
rl.on('close', () => process.exit(0));
