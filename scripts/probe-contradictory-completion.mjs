#!/usr/bin/env node
// Does the live Codex backend ever finish a tool call on arguments that
// CONTRADICT the deltas it streamed for that same call?
//
// `missingToolCallArgumentDelta` (src/proxy/tool-wrapper.ts:15) answers a
// contradiction with `''`: the stream then ends on the streamed bytes while the
// buffered body carries the final value — one turn, two answers. Nothing here
// judges that; this only counts how often the live runtime produces the input.
//
// `CodexBackendTransport` is the ONLY backend this can be asked of.
// `argumentsDelta` is produced in exactly one file — `emitPending` and
// `emitArgumentExtension` in src/proxy/codex-backend-transport.ts — while the
// CLI runtimes (claude-code, codex-app-server) hold a tool turn until
// `completed` and stream no argument bytes at all, so `final.startsWith('')` is
// true for them by construction. Measuring them would return a vacuous zero.
//
// TWO readings of the same contradiction, recorded separately because they can
// disagree — and a disagreement between them means the instrument is wrong:
//   isExtension:false        the direct comparison the consumer performs.
//   sawArgumentsDone:false   the transport's OWN report — `announceFinished`
//     with streamed bytes    withholds the signal while `state.streamed !==
//                            complete`. Also withheld on a turn the vendor cut
//                            off (`response.incomplete`), so a hit on this
//                            reading alone is a lead, not a verdict.
//
// The transport is driven DIRECTLY, not through `/v1/chat/completions`: the HTTP
// surface is the consumer whose reconciliation is in question. It authenticates
// itself from `auth.json` under CODEX_HOME (the operator's Codex OAuth, no
// metered key); nothing here reads, holds, or prints auth material.
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (!existsSync(`${repoRoot}/dist/proxy/codex-backend-transport.js`)) {
  throw new Error(`dist/ is missing at ${repoRoot}/dist — run \`pnpm build\` first.`);
}

const options = parseArgs(process.argv.slice(2));
// A backend identifier is not a model: with no `--model` the transport falls
// back to its own placeholder, and sending that as the request model asks the
// runtime to run a model by that name, which it refuses. No default is guessed
// — the caller names the slug the measurement is about.
const model = options.model;
if (!model) throw new Error('--model is required (e.g. --model gpt-5.5).');
const codexHome = options.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), '.codex');
const turns = numberOption(options.turns, 6);
const timeoutMs = numberOption(options.timeoutMs, 180_000);
const out = resolve(process.cwd(), options.out ?? 'review-artifacts/stage2/contradictory-completion.jsonl');
// Presence only — the transport opens the file, this never does. Checked up
// front because the alternative is `turns` identical auth failures.
if (!existsSync(join(codexHome, 'auth.json'))) {
  throw new Error(`No auth.json under ${codexHome} — log in with \`codex\`, or pass --codexHome.`);
}

// One tool per turn, so `tool_choice: "required"` names the call rather than
// leaving the model a choice, and every shape asks for values long enough that
// the runtime has several deltas to stream. `parameters` is the property map;
// every key is required. Declared above the run loop: the loop runs at module
// top level, so a `const` below it is still in its dead zone when turn 1 reads
// it.
const TOOL_SHAPES = [
  {
    name: 'write_essay',
    parameters: { title: { type: 'string' }, body: { type: 'string' } },
    prompt: 'Call write_essay. title: "The Tide at Dawn". body: at least 150 words of prose about a harbour waking up. Return the tool call only.',
  },
  {
    name: 'create_event',
    parameters: { name: { type: 'string' }, date: { type: 'string' }, attendees: { type: 'array', items: { type: 'string' } } },
    prompt: 'Call create_event. name: "Q4 Harbour Logistics Review". date: "2026-11-14". attendees: twelve distinct full names. Return the tool call only.',
  },
  {
    name: 'file_report',
    parameters: { subject: { type: 'string' }, summary: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } }, priority: { type: 'string' } },
    prompt: 'Call file_report. subject: "Crane 3 hydraulic drift". summary: at least 150 words describing the fault, its timeline and its impact. tags: eight tags. priority: "high". Return the tool call only.',
  },
  // Adversarial shapes. The likeliest way a completed value could stop extending
  // its own deltas is a re-serialisation (parse then stringify) somewhere
  // instead of forwarding the model's bytes: that rewrites exactly the spellings
  // below — a trailing zero, an exponent, a non-ASCII character that may come
  // back \u-escaped, an escaped solidus — while leaving ordinary prose
  // byte-identical. Ordinary shapes cannot tell the two apart; these can, so a
  // clean result on them is worth more than more turns of the same.
  {
    name: 'record_reading',
    parameters: { label: { type: 'string' }, value: { type: 'number' }, scale: { type: 'number' }, note: { type: 'string' } },
    prompt: 'Call record_reading with these values EXACTLY as written, preserving every character and numeric spelling: label: café — berth 3½ "north" ; value: 1.50 ; scale: 1e3 ; note: path C:\\readings\\3 and a quote " and a slash / . Do not round, reformat, escape differently, or normalise anything. Return the tool call only.',
  },
  {
    name: 'store_manifest',
    parameters: { zeta: { type: 'string' }, alpha: { type: 'string' }, count: { type: 'number' }, ratio: { type: 'number' } },
    // Keys asked for out of alphabetical order: a re-serialiser that rebuilds the
    // object from a parsed map can reorder them, which is a non-extension the
    // moment the first key differs.
    prompt: 'Call store_manifest and emit the members in THIS order: zeta first, then alpha, then count, then ratio. zeta: "ζ tail — 마지막" ; alpha: "α head" ; count: 0007 as the number 7 ; ratio: 2.500 . Preserve the numeric spellings exactly. Return the tool call only.',
  },
];

const { normalizeOpenAiChatRequest } = await import(`${repoRoot}/dist/proxy/normalizers.js`);
const { CodexBackendTransport } = await import(`${repoRoot}/dist/proxy/codex-backend-transport.js`);
const backend = new CodexBackendTransport({ codexHome, model, timeoutMs });
mkdirSync(dirname(out), { recursive: true });
console.log(`probe model=${model} codexHome=${codexHome} turns=${turns} out=${out}`);

const rows = [];
try {
  for (let turn = 1; turn <= turns; turn += 1) await runTurn(turn);
} finally {
  await backend.close();
}

// A call is a row the completed result reported; the orphan-index rows carry no
// final value, so they are counted on their own rather than diluting the ratio.
const calls = rows.filter((row) => row.final !== null);
const suspects = calls.filter((row) => row.isExtension === false || notFinished(row));
console.log(`\nSUMMARY model=${model} turns=${turns}`);
console.log(`  tool calls: ${calls.length} (turns with none: ${count('no-tool-call')}, errored: ${rows.filter((row) => row.note.startsWith('error:')).length}, streamed-only calls: ${count('streamed-index-without-final-call')})`);
console.log(`  extensions: ${calls.filter((row) => row.isExtension === true).length}   exact-equal: ${calls.filter((row) => row.equal === true).length}`);
// The denominator, printed next to the answer: a call that streamed nothing
// could not have contradicted anything, and neither reading applies to it.
console.log(`  calls that streamed NO argument deltas: ${count('no-argument-deltas')}`);
// The two readings, counted apart. A call that streamed bytes and never got the
// signal should also be a non-extension; if these disagree, distrust the
// instrument before believing either number.
console.log(`  non-extensions: ${calls.filter((row) => row.isExtension === false).length}   streamed-but-never-argumentsDone: ${calls.filter(notFinished).length}`);
if (suspects.length === 0) {
  console.log('  CONTRADICTIONS: none observed');
} else {
  console.log(`  *** CONTRADICTIONS: ${suspects.length} ***`);
  for (const row of suspects) {
    console.log(`  *** turn ${row.turn} call ${row.toolIndex} ${row.name} isExtension=${row.isExtension} sawArgumentsDone=${row.sawArgumentsDone}`);
    console.log(`  ***   streamed(${row.streamedLen}): ${truncate(row.streamed)}`);
    console.log(`  ***   final   (${row.finalLen}): ${truncate(row.final)}`);
  }
}
process.exit(0);

/** The transport's own reading: bytes went out, the finish signal never did. */
function notFinished(row) {
  return row.sawArgumentsDone === false && row.streamedLen > 0;
}

async function runTurn(turn) {
  const shape = TOOL_SHAPES[(turn - 1) % TOOL_SHAPES.length];
  const request = normalizeOpenAiChatRequest({
    model,
    stream: true,
    messages: [{ role: 'user', content: shape.prompt }],
    tools: [{
      type: 'function',
      function: {
        name: shape.name,
        description: `Probe tool ${shape.name}.`,
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: shape.parameters,
          required: Object.keys(shape.parameters),
        },
      },
    }],
    tool_choice: 'required',
  });
  // Deltas are keyed by `index` and paired with `toolCalls[index]` the way
  // `OpenAiChatToolStreamState.finish` pairs them (http-server.ts:2730); a
  // different pairing here would measure a comparison nothing performs.
  const streamed = new Map();
  const done = new Set();
  let result = null;
  try {
    for await (const event of backend.stream(request, AbortSignal.timeout(timeoutMs))) {
      if (event.type === 'completed') result = event.result;
      else if (event.type === 'tool_call_delta') {
        // Only a non-empty delta is accumulated, because only a non-empty delta
        // reaches the consumer's `streamedArguments`.
        if (event.argumentsDelta) {
          streamed.set(event.index, `${streamed.get(event.index) ?? ''}${event.argumentsDelta}`);
        }
        if (event.argumentsDone) done.add(event.index);
      }
    }
  } catch (err) {
    return record(turn, { note: `error: ${errorMessage(err)}` });
  }
  const toolCalls = result?.toolCalls ?? [];
  if (toolCalls.length === 0) return record(turn, { note: 'no-tool-call' });
  toolCalls.forEach((call, toolIndex) => {
    const text = streamed.get(toolIndex) ?? '';
    record(turn, {
      toolIndex,
      id: call.id,
      name: call.name,
      streamed: text,
      final: call.arguments,
      isExtension: call.arguments.startsWith(text),
      equal: call.arguments === text,
      sawArgumentsDone: done.has(toolIndex),
      streamedLen: text.length,
      finalLen: call.arguments.length,
      note: streamed.has(toolIndex) ? '' : 'no-argument-deltas',
    });
  });
  // A streamed index the completed result never reports is the same two-path
  // disagreement seen from the other end: the client was told about a call the
  // body does not carry.
  for (const [index, text] of streamed) {
    if (index >= toolCalls.length) {
      record(turn, { toolIndex: index, streamed: text, streamedLen: text.length, note: 'streamed-index-without-final-call' });
    }
  }
}

function record(turn, fields) {
  const row = {
    ts: new Date().toISOString(),
    model,
    turn,
    toolIndex: null,
    id: null,
    name: null,
    streamed: null,
    final: null,
    isExtension: null,
    equal: null,
    sawArgumentsDone: null,
    streamedLen: null,
    finalLen: null,
    note: '',
    ...fields,
  };
  rows.push(row);
  appendFileSync(out, `${JSON.stringify(row)}\n`);
  console.log(`turn ${turn}${row.toolIndex === null ? '' : ` call ${row.toolIndex}`}: ${row.name ?? '-'} streamed=${row.streamedLen ?? '-'} final=${row.finalLen ?? '-'} extension=${row.isExtension ?? '-'} equal=${row.equal ?? '-'} done=${row.sawArgumentsDone ?? '-'}${row.note ? ` note=${row.note}` : ''}`);
}

function count(note) {
  return rows.filter((row) => row.note === note).length;
}

function truncate(value) {
  if (typeof value !== 'string') return String(value);
  return value.length <= 200 ? value : `${value.slice(0, 200)}…(+${value.length - 200})`;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    const key = arg.slice(2, eq === -1 ? undefined : eq).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const value = eq === -1 ? argv[i + 1] : arg.slice(eq + 1);
    if (eq === -1 && (!value || value.startsWith('--'))) out[key] = 'true';
    else {
      if (eq === -1) i += 1;
      out[key] = value;
    }
  }
  return out;
}

function numberOption(value, fallback) {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function errorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}
