import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, before, test } from 'node:test';
import { startLocalApiProxy } from '../dist/proxy/http-server.js';
import { ClaudeCodeBackend } from '../dist/proxy/claude-code-backend.js';
import { CodexAppServerBackend } from '../dist/proxy/codex-app-server-backend.js';

/**
 * One turn, read both ways, on every surface, through both wrapper backends.
 *
 * The tool wrapper has ONE reader: `JSON.parse` over the completed artefact,
 * in `parseBackendOutput`. The stream is a projection of that reading — a tool
 * turn releases nothing until it exists — so the two ways a client can read a
 * turn must agree on every input, including the malformed ones on which a
 * second, incremental reader used to disagree (conformance matrix §7; the
 * inputs below are that section's reproductions, one character per delta).
 *
 * Each input asserts the empty verdict AND what was delivered — a call set, a
 * text, or a refusal with nothing released and the same HTTP status on both
 * paths — so agreement on nothing proves nothing. The one input still pinned
 * to a disagreement is row 8 on /v1/messages, which is between the two
 * WRITERS' projections of one unparseable forced call; row 8's own fix flips
 * that pin, and that is the only way this file's verdicts may change.
 *
 * Verdict kinds:
 *   status                  one reading is an error and the other an answer
 *   released-before-error   the stream put content or a call on the wire and
 *                           then refused the turn
 *   text                    both answered; the narration differs
 *   calls                   both answered; the call set (id, name, arguments) differs
 */

const here = dirname(fileURLToPath(import.meta.url));
const streamingClaude = resolve(here, 'fixtures/streaming-claude.cjs');
const fakeCodex = resolve(here, 'fixtures/fake-codex.cjs');
const tempDirs = [];

before(async () => {
  await chmod(streamingClaude, 0o755);
  await chmod(fakeCodex, 0o755);
});

afterEach(async () => {
  delete process.env.WRAPPER_RAW;
  delete process.env.FAKE_CODEX_RAW_TEXT;
  delete process.env.FAKE_CODEX_RAW_TEXT_DELTAS;
  delete process.env.CODEX_HOME;
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

// ---------------------------------------------------------------------------
// The inputs. `GW`/`GT` are calls to the two declared tools.
// ---------------------------------------------------------------------------

const GW = '{"id":"c1","name":"get_weather","arguments":"{\\"city\\":\\"Seoul\\"}"}';
const GT = '{"id":"c2","name":"get_time","arguments":"{\\"tz\\":\\"Asia/Seoul\\"}"}';
const CANON_GW = { id: 'c1', name: 'get_weather', arguments: '{"city":"Seoul"}' };
const CANON_GT = { id: 'c2', name: 'get_time', arguments: '{"tz":"Asia/Seoul"}' };
const AGREE = [];

/**
 * `delivered` is what the buffered reading must carry (or `refused: true`),
 * the denominator of each agreement. `expect` names a surface whose verdict
 * is still a disagreement — only row 8 has one.
 */
const CASES = [
  {
    id: 'CONTROL valid wrapper: narration and one call',
    raw: `{"status":"tool_calls","text":"Checking.","toolCalls":[${GW}]}`,
    choice: 'auto',
    delivered: { text: 'Checking.', calls: [CANON_GW] },
  },
  {
    id: 'CONTROL plain text with no tools streams live',
    raw: 'hello there',
    choice: 'none',
    delivered: { text: 'hello there', calls: [] },
  },
  {
    id: '7a-1 a member after the root closed (r14-claude F3)',
    raw: `{"status":"tool_calls","text":"sorry, I will not call anything"}\ntrailing "toolCalls":[${GW}]`,
    choice: 'required',
    delivered: { refused: true },
  },
  {
    id: '7a-2 the root never closes (r16-codex F3, r17-codex F5)',
    raw: `{"status":"tool_calls","text":"narration","toolCalls":[${GW}]`,
    choice: 'auto',
    delivered: { text: `{"status":"tool_calls","text":"narration","toolCalls":[${GW}]`, calls: [] },
  },
  {
    id: '7a-3a duplicate `toolCalls` members (r15-codex F1)',
    raw: `{"status":"tool_calls","text":"","toolCalls":[${GW}],"toolCalls":[${GT}]}`,
    choice: 'required',
    delivered: { text: '', calls: [CANON_GT] },
  },
  {
    id: '7a-3b duplicate `text` members',
    raw: '{"status":"message","text":"FIRST","toolCalls":[],"text":"SECOND"}',
    choice: 'auto',
    delivered: { text: 'SECOND', calls: [] },
  },
  {
    id: '7a-3c duplicate `name` inside a call, declared first (r17-fable Q1-D)',
    raw: '{"status":"tool_calls","text":"","toolCalls":[{"id":"c1","name":"get_weather","name":"never","arguments":"{}"}]}',
    choice: 'required',
    delivered: { refused: true },
  },
  {
    id: '7a-3d duplicate `name` inside a call, declared last (r17-fable Q1-E)',
    raw: '{"status":"tool_calls","text":"","toolCalls":[{"id":"c1","name":"never","name":"get_weather","arguments":"{}"}]}',
    choice: 'required',
    delivered: { text: '', calls: [{ id: 'c1', name: 'get_weather', arguments: '{}' }] },
  },
  {
    id: '7a-4a a BOM before the root (r15-codex F3)',
    raw: `\uFEFF{"status":"tool_calls","text":"","toolCalls":[${GW}]}`,
    choice: 'required',
    // Agreement on a REFUSAL: `JSON.parse` rejects the BOM, so the buffered
    // reading finds no call under `required`, and the stream releases nothing
    // before saying the same. The pre-round-15 stream published the call.
    delivered: { refused: true },
  },
  {
    id: '7a-4b U+00A0 between `]` and the root `}` (r17-fable R4ii)',
    raw: `{"status":"tool_calls","text":"","toolCalls":[${GW}]\u00A0}`,
    choice: 'required',
    delivered: { refused: true },
  },
  {
    id: '7a-5a a declared call followed by an undeclared one (r16-codex F1)',
    raw: `{"status":"tool_calls","text":"","toolCalls":[${GW},{"id":"c2","name":"never_declared","arguments":"{}"}]}`,
    choice: 'required',
    delivered: { refused: true },
  },
  {
    id: '7a-5b narration before an undeclared call under auto (r17-fable Q1-K)',
    raw: '{"status":"tool_calls","text":"Checking the weather now.","toolCalls":[{"id":"c1","name":"never_declared","arguments":"{}"}]}',
    choice: 'auto',
    delivered: { refused: true },
  },
  {
    id: '7a-6a a nested array as a `toolCalls` member (r17-codex F1)',
    raw: `{"status":"tool_calls","text":"","toolCalls":[[${GW}]]}`,
    choice: 'required',
    delivered: { refused: true },
  },
  {
    id: '7a-6b `null` then a call as `toolCalls` members (r17-fable F2)',
    raw: `{"status":"tool_calls","text":"","toolCalls":[null,${GW}]}`,
    choice: 'required',
    delivered: { refused: true },
  },
  {
    id: '7a-7 arguments that are not JSON (r17-codex F3, r14-codex F6)',
    raw: '{"status":"tool_calls","text":"","toolCalls":[{"id":"c1","name":"get_weather","arguments":"Seoul"}]}',
    choice: 'required',
    delivered: { text: '', calls: [{ id: 'c1', name: 'get_weather', arguments: '{"input":"Seoul"}' }] },
  },
  {
    id: '7b-8 a forced tool answered with truncated arguments (r15-codex F5)',
    raw: '{"city":"Seo',
    choice: 'forced',
    // Chat and Responses carry `arguments` as a string, so both readings hand
    // the client the same unusable fragment. On /v1/messages the buffered
    // reading wraps text that is not JSON as `{"input":…}` (interface contract
    // line 380) while the stream sends the fragment as `input_json_delta` — the
    // row-7 normalization gap, on the forced path. Matrix §7b row 8.
    // The one remaining disagreement: between the two WRITERS' projections of
    // one completed call whose arguments do not parse, not between two
    // readers. Row 8's own fix — refuse the forced turn at completion — flips it.
    expect: { messages: ['calls'] },
    delivered: { text: '', calls: [{ id: null, name: 'get_weather', arguments: '{"city":"Seo' }] },
  },
  {
    id: '7b-9a U+000B as a member separator (r16-codex F2)',
    raw: `{"status":"tool_calls",\u000B"text":"","toolCalls":[${GW}]}`,
    choice: 'required',
    delivered: { refused: true },
  },
  {
    id: "7b-9b an invalid `\\'` escape inside arguments (r17-fable R4i)",
    raw: `{"status":"tool_calls","text":"","toolCalls":[{"id":"c1","name":"get_weather","arguments":"{\\'a\\':1}"}]}`,
    choice: 'required',
    delivered: { refused: true },
  },
  {
    id: '7b-10 the wrapper grammar as a JSON-format answer (r14-claude F5, r16-codex F5)',
    raw: '{"status":"done","text":"Seoul is sunny.","toolCalls":[]}',
    choice: 'auto',
    format: 'json_object',
    delivered: { text: '{"status":"done","text":"Seoul is sunny.","toolCalls":[]}', calls: [] },
  },
];

// ---------------------------------------------------------------------------
// Requests, one per surface, from a case's choice and format.
// ---------------------------------------------------------------------------

const WEATHER = { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] };
const TIME = { type: 'object', properties: { tz: { type: 'string' } }, required: ['tz'] };

const SURFACES = {
  chat: {
    path: '/v1/chat/completions',
    headers: { 'content-type': 'application/json', authorization: 'Bearer local' },
    body({ choice, format }) {
      const body = { model: 'm', messages: [{ role: 'user', content: 'w' }] };
      if (choice !== 'none') {
        body.tools = [
          { type: 'function', function: { name: 'get_weather', parameters: WEATHER } },
          { type: 'function', function: { name: 'get_time', parameters: TIME } },
        ];
        body.tool_choice = choice === 'forced' ? { type: 'function', function: { name: 'get_weather' } } : choice;
      }
      if (format) body.response_format = { type: format };
      return body;
    },
  },
  responses: {
    path: '/v1/responses',
    headers: { 'content-type': 'application/json', authorization: 'Bearer local' },
    body({ choice, format }) {
      const body = { model: 'm', input: 'w' };
      if (choice !== 'none') {
        body.tools = [
          { type: 'function', name: 'get_weather', parameters: WEATHER },
          { type: 'function', name: 'get_time', parameters: TIME },
        ];
        body.tool_choice = choice === 'forced' ? { type: 'function', name: 'get_weather' } : choice;
      }
      if (format) body.text = { format: { type: format } };
      return body;
    },
  },
  messages: {
    path: '/v1/messages',
    headers: { 'content-type': 'application/json', 'x-api-key': 'local', 'anthropic-version': '2023-06-01' },
    body({ choice, format }) {
      if (format) return null; // no JSON format on this surface
      const body = { model: 'm', max_tokens: 128, messages: [{ role: 'user', content: 'w' }] };
      if (choice !== 'none') {
        body.tools = [
          { name: 'get_weather', description: 'w', input_schema: WEATHER },
          { name: 'get_time', description: 't', input_schema: TIME },
        ];
        body.tool_choice = choice === 'forced' ? { type: 'tool', name: 'get_weather' }
          : choice === 'required' ? { type: 'any' } : { type: 'auto' };
      }
      return body;
    },
  },
};

// ---------------------------------------------------------------------------
// Readers. Each reduces one reading to { status, text, calls, releasedBeforeError }.
// `arguments` is canonicalised so an object and its serialisation compare equal;
// a string that is not JSON stays as written, which is the point of row 7.
// ---------------------------------------------------------------------------

function canonicalArguments(value) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') return JSON.stringify(value);
  try { return JSON.stringify(JSON.parse(value)); } catch { return value; }
}

function sseEvents(text) {
  return text.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim())
    .filter((chunk) => chunk && chunk !== '[DONE]')
    .flatMap((chunk) => { try { return [JSON.parse(chunk)]; } catch { return []; } });
}

const BUFFERED = {
  chat(body) {
    const message = body.choices?.[0]?.message ?? {};
    return {
      text: message.content ?? '',
      calls: (message.tool_calls ?? []).map((call) => ({ id: call.id, name: call.function?.name, arguments: canonicalArguments(call.function?.arguments) })),
    };
  },
  responses(body) {
    const output = body.output ?? [];
    return {
      text: output.filter((item) => item.type === 'message').flatMap((item) => item.content ?? []).map((part) => part.text ?? '').join(''),
      calls: output.filter((item) => item.type === 'function_call').map((item) => ({ id: item.call_id, name: item.name, arguments: canonicalArguments(item.arguments) })),
    };
  },
  messages(body) {
    const content = body.content ?? [];
    return {
      text: content.filter((block) => block.type === 'text').map((block) => block.text).join(''),
      calls: content.filter((block) => block.type === 'tool_use').map((block) => ({ id: block.id, name: block.name, arguments: canonicalArguments(block.input) })),
    };
  },
};

function isErrorFrame(event) {
  return event.type === 'error' || event.type === 'response.failed' || (event.error !== undefined && event.choices === undefined);
}

const STREAMED = {
  chat(events) {
    let text = '';
    const calls = new Map();
    let released = 0;
    let error;
    for (const event of events) {
      if (isErrorFrame(event)) { error ??= event.error?.message ?? 'error'; continue; }
      const delta = event.choices?.[0]?.delta ?? {};
      if (delta.content) { text += delta.content; if (!error) released += 1; }
      for (const call of delta.tool_calls ?? []) {
        const slot = calls.get(call.index) ?? { id: undefined, name: undefined, arguments: '' };
        if (call.id) slot.id = call.id;
        if (call.function?.name) slot.name = call.function.name;
        if (call.function?.arguments) slot.arguments += call.function.arguments;
        calls.set(call.index, slot);
        if (!error) released += 1;
      }
    }
    return { text, calls: [...calls.values()].map((c) => ({ ...c, arguments: canonicalArguments(c.arguments) })), releasedBeforeError: released, error };
  },
  responses(events) {
    let text = '';
    const calls = new Map();
    let released = 0;
    let error;
    for (const event of events) {
      if (isErrorFrame(event)) { error ??= event.error?.message ?? event.message ?? 'error'; continue; }
      if (event.type === 'response.output_text.delta' && event.delta) { text += event.delta; if (!error) released += 1; }
      if (event.type === 'response.output_item.added' && event.item?.type === 'function_call') {
        calls.set(event.output_index, { id: event.item.call_id, name: event.item.name, arguments: '' });
        if (!error) released += 1;
      }
      if (event.type === 'response.function_call_arguments.delta') {
        const slot = calls.get(event.output_index) ?? { id: undefined, name: undefined, arguments: '' };
        slot.arguments += event.delta ?? '';
        calls.set(event.output_index, slot);
        if (!error) released += 1;
      }
    }
    return { text, calls: [...calls.values()].map((c) => ({ ...c, arguments: canonicalArguments(c.arguments) })), releasedBeforeError: released, error };
  },
  messages(events) {
    let text = '';
    const calls = new Map();
    let released = 0;
    let error;
    for (const event of events) {
      if (isErrorFrame(event)) { error ??= event.error?.message ?? 'error'; continue; }
      if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
        calls.set(event.index, { id: event.content_block.id, name: event.content_block.name, arguments: '' });
        if (!error) released += 1;
      }
      if (event.type === 'content_block_delta') {
        if (event.delta?.type === 'text_delta' && event.delta.text) { text += event.delta.text; if (!error) released += 1; }
        if (event.delta?.type === 'input_json_delta') {
          const slot = calls.get(event.index) ?? { id: undefined, name: undefined, arguments: '' };
          slot.arguments += event.delta.partial_json ?? '';
          calls.set(event.index, slot);
          if (!error) released += 1;
        }
      }
    }
    return { text, calls: [...calls.values()].map((c) => ({ ...c, arguments: canonicalArguments(c.arguments) })), releasedBeforeError: released, error };
  },
};

async function readBothWays(url, surfaceName, body) {
  const surface = SURFACES[surfaceName];
  const post = (extra) => fetch(`${url}${surface.path}`, { method: 'POST', headers: surface.headers, body: JSON.stringify({ ...body, ...extra }) });

  const bufferedRes = await post({});
  const bufferedBody = await bufferedRes.json();
  const buffered = bufferedRes.status === 200
    ? { status: 'ok', httpStatus: 200, ...BUFFERED[surfaceName](bufferedBody) }
    : { status: 'error', httpStatus: bufferedRes.status, text: '', calls: [], error: bufferedBody.error?.message ?? JSON.stringify(bufferedBody) };

  const streamedRes = await post({ stream: true });
  const streamedText = await streamedRes.text();
  let streamed;
  if (streamedRes.status !== 200) {
    let parsed; try { parsed = JSON.parse(streamedText); } catch { parsed = {}; }
    streamed = { status: 'error', httpStatus: streamedRes.status, text: '', calls: [], releasedBeforeError: 0, error: parsed.error?.message ?? streamedText };
  } else {
    const read = STREAMED[surfaceName](sseEvents(streamedText));
    streamed = { status: read.error === undefined ? 'ok' : 'error', httpStatus: 200, ...read };
  }
  return { buffered, streamed };
}

/** The verdict: every way the two readings told the client different things. */
function disagreements({ buffered, streamed }) {
  const kinds = [];
  if (buffered.status !== streamed.status) kinds.push('status');
  if (streamed.status === 'error' && streamed.releasedBeforeError > 0) kinds.push('released-before-error');
  if (buffered.status === 'ok' && streamed.status === 'ok') {
    if (buffered.text !== streamed.text) kinds.push('text');
    if (JSON.stringify(buffered.calls) !== JSON.stringify(streamed.calls)) kinds.push('calls');
  }
  return kinds;
}

// ---------------------------------------------------------------------------
// The two real backends, each behind its own double that streams the chosen
// text one character per delta and then reports it as the turn's result.
// ---------------------------------------------------------------------------

const BACKENDS = {
  claude: async (raw) => {
    process.env.WRAPPER_RAW = raw;
    return new ClaudeCodeBackend({ command: streamingClaude, cwd: process.cwd(), model: 'sonnet', timeoutMs: 30_000 });
  },
  'app-server': async (raw) => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-agreement-home-'));
    tempDirs.push(dir);
    await writeFile(join(dir, 'auth.json'), '{"token":"local"}\n');
    await writeFile(join(dir, 'config.toml'), 'model = "gpt-test-model"\n');
    process.env.CODEX_HOME = dir;
    process.env.FAKE_CODEX_RAW_TEXT = raw;
    process.env.FAKE_CODEX_RAW_TEXT_DELTAS = 'chars';
    return new CodexAppServerBackend({ command: fakeCodex, cwd: process.cwd(), timeoutMs: 30_000 });
  },
};

const PRINT = process.env.WRAPPER_AGREEMENT_PRINT === '1';

/** Every surface, read both ways, through one backend. */
async function readAll(kase, makeBackend) {
  const backend = await makeBackend(kase.raw);
  const server = await startLocalApiProxy({ backend, host: '127.0.0.1', port: 0, requestTimeoutMs: 30_000 });
  try {
    const readings = {};
    for (const surfaceName of Object.keys(SURFACES)) {
      const body = SURFACES[surfaceName].body(kase);
      if (!body) continue;
      readings[surfaceName] = await readBothWays(server.url, surfaceName, body);
    }
    return readings;
  } finally {
    await server.close();
    await backend.close();
  }
}

for (const kase of CASES) {
  for (const [backendName, makeBackend] of Object.entries(BACKENDS)) {
    test(`${kase.id} — ${backendName}`, async () => {
      const readings = await readAll(kase, makeBackend);
      if (PRINT) {
        for (const [surfaceName, both] of Object.entries(readings)) {
          const { buffered, streamed } = both;
          console.log(`${kase.id} | ${backendName} | ${surfaceName} | ${disagreements(both).join(',') || 'AGREE'} | b=${buffered.httpStatus}:${JSON.stringify(buffered.text).slice(0, 30)}/${buffered.calls.length} s=${streamed.httpStatus}:${JSON.stringify(streamed.text).slice(0, 30)}/${streamed.calls.length} rel=${streamed.releasedBeforeError}`);
        }
        return;
      }
      for (const [surfaceName, both] of Object.entries(readings)) {
        const expected = kase.expect?.[surfaceName] ?? AGREE;
        assert.deepEqual(
          disagreements(both),
          expected,
          `${surfaceName}: ${expected.length === 0 ? 'the two readings disagree' : 'no longer disagrees as pinned'} — ${JSON.stringify(both)}`,
        );
        if (expected.length > 0) continue;
        const { buffered, streamed } = both;
        assert.equal(streamed.httpStatus, buffered.httpStatus, `${surfaceName}: the stream's HTTP status is not the buffered path's`);
        if (kase.delivered?.refused) {
          // Agreement on a refusal is only agreement if the stream refused
          // BEFORE releasing anything — the verdict already checked that; the
          // denominator here is that the turn was in fact refused.
          assert.equal(buffered.status, 'error', `${surfaceName}: expected a refusal, got ${JSON.stringify(buffered)}`);
          assert.equal(streamed.releasedBeforeError, 0, `${surfaceName}: the stream released before refusing`);
        } else {
          // The denominator: agreement on nothing delivered proves nothing.
          assert.equal(buffered.status, 'ok', `${surfaceName}: ${buffered.error}`);
          assert.equal(buffered.text, kase.delivered.text, `${surfaceName}: buffered text`);
          assert.deepEqual(
            buffered.calls.map((call) => ({ ...call, id: kase.delivered.calls[0]?.id === null ? null : call.id })),
            kase.delivered.calls,
            `${surfaceName}: buffered calls`,
          );
        }
      }
    });
  }
}
