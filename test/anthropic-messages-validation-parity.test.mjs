import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startLocalApiProxy } from '../dist/proxy/http-server.js';

// The Messages twin of the Chat and Responses parity files. Every row is a
// DIRECT API observation taken 2026-08-31 against `claude-sonnet-5`, recorded
// in `docs/conformance-matrix.md` §5.5.7; the bodies are the rows
// `scripts/e2e-text-surfaces-direct-parity.mjs` sends to both sides, and these
// envelopes were taken from the proxy on a run where that instrument reported
// ALL PASS against the live API.
//
// This surface's envelope is its own: `{type:"error", error:{type, message}}`
// with neither `param` nor `code`, and its report order — derived by comparison
// sort, 18 keys, 137 calls, antisymmetry 51/51 — is nothing like either OpenAI
// surface's.

const DELETE = Symbol('delete the key');
const AM = [{ role: 'user', content: 'ping' }];

function backend() {
  return {
    name: 'test',
    model: 'configured-model',
    // Every row here is a rejection, so reaching the backend is a broken row.
    async generate() { throw new Error('a rejection case reached the backend'); },
    async *stream() { throw new Error('a rejection case reached the backend'); },
    async close() {},
  };
}

async function messages(extra) {
  const started = await startLocalApiProxy({ backend: backend(), host: '127.0.0.1', port: 0, requestTimeoutMs: 30_000 });
  try {
    const body = { model: 'claude-sonnet-5', max_tokens: 16, messages: AM, ...extra };
    for (const key of Object.keys(body)) if (body[key] === DELETE) delete body[key];
    const res = await fetch(`${started.url}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: res.status, payload: await res.json() };
  } finally {
    await started.close();
  }
}

// [name, request fragment, the direct API's sentence]
const REJECTIONS = [
  // Required presence and type, in this surface's own order.
  ["model absent", { model: DELETE }, "model: Field required"],
  ["model null", { model: null }, "model: Input should be a valid string"],
  ["model as an integer", { model: 7 }, "model: Input should be a valid string"],
  ["model empty", { model: '' }, "model: String should have at least 1 character"],
  ["messages absent", { messages: DELETE }, "messages: Field required"],
  ["messages null", { messages: null }, "messages: Input should be a valid array"],
  ["messages as a string", { messages: 'x' }, "messages: Input should be a valid array"],
  ["messages empty", { messages: [] }, "messages: at least one message is required"],
  ["max_tokens absent", { max_tokens: DELETE }, "max_tokens: Field required"],
  ["max_tokens null", { max_tokens: null }, "max_tokens: Input should be a valid integer"],
  ["max_tokens as a string", { max_tokens: 'x' }, "max_tokens: Input should be a valid integer"],
  ["max_tokens below zero", { max_tokens: -1 }, "max_tokens: must be greater than or equal to 0"],
  // The item level, reported at the `messages` slot.
  ["item role missing", { messages: [{ content: 'ping' }] }, "messages.0.role: Field required"],
  ["item role unknown", { messages: [{ role: 'bogus', content: 'ping' }] }, "messages: Unexpected role \"bogus\". Allowed roles are \"user\" or \"assistant\""],
  ["item role system at the head", { messages: [{ role: 'system', content: 'ping' }] }, "messages.0: use the top-level 'system' parameter for the initial system prompt; the directive-only form (content: [] with output_config) is accepted at any position"],
  ["item role system with empty content", { messages: [{ role: 'system', content: [] }, { role: 'user', content: 'ping' }] }, "messages.0: system content must contain at least one block"],
  ["item role developer", { messages: [{ role: 'developer', content: 'x' }, { role: 'user', content: 'ping' }] }, "messages: Unexpected role \"developer\". Allowed roles are \"user\" or \"assistant\""],
  // A system item past the head is ACCEPTED, so the rest of its schema decides
  // the answer — measured 2026-08-31, the same sentences a user item gets, at
  // the same position. The proxy used to return early and answer all four 200.
  ["item system past the head without content", { messages: [{ role: 'user', content: 'a' }, { role: 'system' }] }, "messages.1.content: Field required"],
  ["item system past the head content null", { messages: [{ role: 'user', content: 'a' }, { role: 'system', content: null }] }, "messages.1.content: Input should be a valid array"],
  ["item system past the head content as an integer", { messages: [{ role: 'user', content: 'a' }, { role: 'system', content: 7 }] }, "messages.1.content: Input should be a valid array"],
  ["item system past the head content block without a type", { messages: [{ role: 'user', content: 'a' }, { role: 'system', content: [{ text: 'x' }] }] }, "messages.1.content.0.type: Field required"],
  // The phase, not just the sentence: the item's unknown member is reported at
  // the `messages` position (4), beating `temperature`'s type fault (12).
  ["item system past the head unknown member", { messages: [{ role: 'user', content: 'a' }, { role: 'system', content: 'x', bogus: 1 }], temperature: 'x' }, "messages.1.bogus: Extra inputs are not permitted"],
  ["item user unknown member beats a later field", { messages: [{ role: 'user', content: 'a', bogus: 1 }], temperature: 'x' }, "messages.0.bogus: Extra inputs are not permitted"],
  ["item content missing", { messages: [{ role: 'user' }] }, "messages.0.content: Field required"],
  ["item content null", { messages: [{ role: 'user', content: null }] }, "messages.0.content: Input should be a valid array"],
  ["item content as an integer", { messages: [{ role: 'user', content: 7 }] }, "messages.0.content: Input should be a valid array"],
  ["item content as an object", { messages: [{ role: 'user', content: {} }] }, "messages.0.content: Input should be a valid array"],
  ["item content empty array", { messages: [{ role: 'user', content: [] }] }, "messages.0: user messages must have non-empty content"],
  ["item content block not an object", { messages: [{ role: 'user', content: [7] }] }, "messages.0.content.0: Input should be an object"],
  ["item content block without a type", { messages: [{ role: 'user', content: [{}] }] }, "messages.0.content.0.type: Field required"],
  ["item unknown member", { messages: [{ role: 'user', content: 'ping', bogus: 1 }] }, "messages.0.bogus: Extra inputs are not permitted"],
  // Known fields, one type fault each — the rows the order sort was run on.
  ["tool_choice as an integer", { tool_choice: 7 }, "tool_choice: Input should be an object"],
  ["tool_choice null", { tool_choice: null }, "tool_choice: Input should be an object"],
  ["tools as a string", { tools: 'x' }, "tools: Input should be a valid array"],
  ["tools null", { tools: null }, "tools: Input should be a valid array"],
  ["tools member not an object", { tools: [7] }, "tools.0: Input should be an object"],
  // Conformance matrix §7 rows 11–12, measured live 2026-09-04 (`e2e:text:parity`).
  ["tool with a blank name", { tools: [{ name: '', input_schema: { type: 'object', properties: {} } }] }, "tools.0.custom.name: String should have at least 1 character"],
  ["tool without a name", { tools: [{ input_schema: { type: 'object', properties: {} } }] }, "tools.0.custom.name: Field required"],
  ["tool_choice naming an undeclared tool", { tools: [{ name: 'f', input_schema: { type: 'object', properties: {} } }], tool_choice: { type: 'tool', name: 'never_declared' } }, "Tool 'never_declared' not found in provided tools"],
  // Round 18 (measured 2026-09-04).
  ["tool with a whitespace-only name", { tools: [{ name: '   ', input_schema: { type: 'object', properties: {} } }] }, "tools.0.custom.name: String should match pattern '^[a-zA-Z0-9_-]{1,128}$'"],
  ["tool_choice any with tools absent", { tool_choice: { type: 'any' } }, "tool_choice.any may only be specified while providing tools"],
  ["tool_choice tool with tools absent", { tool_choice: { type: 'tool', name: 'x' } }, "Tool 'x' not found in provided tools"],
  ["strict tool whose object schema is not closed", { tools: [{ name: 'f', input_schema: { type: 'object', properties: {} }, strict: true }] }, "tools.0.custom: For 'object' type, 'additionalProperties' must be explicitly set to false"],
  ["system as an integer", { system: 7 }, "system: Input should be a valid array"],
  ["system null", { system: null }, "system: Input should be a valid array"],
  ["system member not an object", { system: [7] }, "system.0: Input does not match the expected shape."],
  ["thinking as a string", { thinking: 'x' }, "thinking: Input should be an object"],
  ["thinking null", { thinking: null }, "thinking: Input should be an object"],
  ["output_config as a string", { output_config: 'x' }, "output_config: Input does not match the expected shape."],
  ["output_config null", { output_config: null }, "output_config: Input does not match the expected shape."],
  ["cache_control as a string", { cache_control: 'x' }, "cache_control: Input should be an object"],
  ["metadata as a string", { metadata: 'x' }, "metadata: Input does not match the expected shape."],
  ["metadata unknown member", { metadata: { bogus: 'x' } }, "metadata.bogus: Extra inputs are not permitted"],
  ["metadata user_id as an integer", { metadata: { user_id: 7 } }, "metadata.user_id: Input should be a valid string"],
  ["stop_sequences as a string", { stop_sequences: 'ZZ' }, "stop_sequences: Input should be a valid array"],
  ["stop_sequences member not a string", { stop_sequences: [1] }, "stop_sequences.0: Input should be a valid string"],
  ["temperature as a string", { temperature: 'x' }, "temperature: Input should be a valid number"],
  ["temperature null", { temperature: null }, "temperature: Input should be a valid number"],
  ["temperature above its range", { temperature: 2 }, "temperature: range: 0..1"],
  ["service_tier unknown", { service_tier: 'bogus' }, "service_tier: Input should be 'auto' or 'standard_only'"],
  ["service_tier null", { service_tier: null }, "service_tier: Input should be 'auto' or 'standard_only'"],
  ["top_k as a string", { top_k: 'x' }, "top_k: Input should be a valid integer"],
  ["top_k null", { top_k: null }, "top_k: Input should be a valid integer"],
  ["top_p as a string", { top_p: 'x' }, "top_p: Input should be a valid number"],
  ["top_p null", { top_p: null }, "top_p: Input should be a valid number"],
  ["top_p above its range", { top_p: 1.5 }, "top_p: range: 0..1"],
  ["stream as a string", { stream: 'yes' }, "stream: Input should be a valid boolean"],
  ["stream null", { stream: null }, "stream: Input should be a valid boolean"],
  ["container as an integer", { container: 7 }, "container.ContainerParams: Input does not match the expected shape."],
  ["container by name", { container: 'container_x' }, "container: Container identifier can only be provided when using the code execution tool"],
  ["inference_geo as an integer", { inference_geo: 7 }, "inference_geo: Input should be a valid string"],
  ["inference_geo unknown", { inference_geo: 'bogus-geo' }, "inference_geo: must be one of ['global', 'us']"],
  ["unknown key", { zzz_unknown: 1 }, "zzz_unknown: Extra inputs are not permitted"],
  // The derived order, adjacent pair by adjacent pair, each sent with the
  // LATER key first so a proxy that answered about the first key it read would
  // fail every one of them.
  ["order model before tool_choice", { tool_choice: 7, model: 7 }, "model: Input should be a valid string"],
  ["order tool_choice before tools", { tools: 'x', tool_choice: 7 }, "tool_choice: Input should be an object"],
  ["order tools before messages", { messages: 'x', tools: 'x' }, "tools: Input should be a valid array"],
  ["order messages before system", { system: 7, messages: 'x' }, "messages: Input should be a valid array"],
  ["order system before thinking", { thinking: 'x', system: 7 }, "system: Input should be a valid array"],
  ["order thinking before output_config", { output_config: 'x', thinking: 'x' }, "thinking: Input should be an object"],
  ["order output_config before cache_control", { cache_control: 'x', output_config: 'x' }, "output_config: Input does not match the expected shape."],
  ["order cache_control before max_tokens", { max_tokens: 'x', cache_control: 'x' }, "cache_control: Input should be an object"],
  ["order max_tokens before metadata", { metadata: 'x', max_tokens: 'x' }, "max_tokens: Input should be a valid integer"],
  ["order metadata before stop_sequences", { stop_sequences: 'ZZ', metadata: 'x' }, "metadata: Input does not match the expected shape."],
  ["order stop_sequences before temperature", { temperature: 'x', stop_sequences: 'ZZ' }, "stop_sequences: Input should be a valid array"],
  ["order temperature before service_tier", { service_tier: 7, temperature: 'x' }, "temperature: Input should be a valid number"],
  ["order service_tier before top_k", { top_k: 'x', service_tier: 7 }, "service_tier: Input should be 'auto' or 'standard_only'"],
  ["order top_k before top_p", { top_p: 'x', top_k: 'x' }, "top_k: Input should be a valid integer"],
  ["order top_p before stream", { stream: 'yes', top_p: 'x' }, "top_p: Input should be a valid number"],
  ["order stream before container", { container: 7, stream: 'yes' }, "stream: Input should be a valid boolean"],
  ["order container before inference_geo", { inference_geo: 7, container: 7 }, "container.ContainerParams: Input does not match the expected shape."],
  // The two phases behind every known field.
  ["order a known field beats an unknown key", { zzz_unknown: 1, inference_geo: 7 }, "inference_geo: Input should be a valid string"],
  ["order a missing model beats an unknown key", { model: DELETE, zzz_unknown: 1 }, "model: Field required"],
  ["order an unknown key beats the container refusal", { container: 'container_x', zzz_unknown: 1 }, "zzz_unknown: Extra inputs are not permitted"],
  ["order a known field beats the container refusal", { container: 'container_x', inference_geo: 7 }, "inference_geo: Input should be a valid string"],
  ["order a missing model beats a bad optional field", { model: DELETE, stop_sequences: 'ZZ' }, "model: Field required"],
  ["order a bad item beats an unknown key", { messages: [{ role: 'user', content: 'ping', bogus: 1 }], zzz_unknown: 1 }, "messages.0.bogus: Extra inputs are not permitted"],
  // The conversation's SHAPE, a phase of its own: after every field's type
  // check and after the unknown-key refusal, before the container one.
  ["shape system precedes a user", { messages: [{ role: 'user', content: 'a' }, { role: 'system', content: 'sys' }, { role: 'user', content: 'b' }] }, "messages.1: role 'system' must precede an 'assistant' message or end the array; the directive-only form (content: [] with output_config) is accepted at any position"],
  // WHICH item of a system RUN the position fault is reported at: the LAST.
  // A run of consecutive `system` items is one block and only where it ENDS is
  // constrained, so the index in the sentence is the run's last item, not its
  // first. Measured 2026-09-01 (§5.5.7). The single-item row above cannot see
  // this — first and last are the same item there — and "report the run at its
  // first item" left the whole suite green until these two rows.
  ["shape a system run of two is reported at its LAST item", { messages: [{ role: 'user', content: 'a' }, { role: 'system', content: 's1' }, { role: 'system', content: 's2' }, { role: 'user', content: 'b' }] }, "messages.2: role 'system' must precede an 'assistant' message or end the array; the directive-only form (content: [] with output_config) is accepted at any position"],
  ["shape a system run of three is reported at its LAST item", { messages: [{ role: 'user', content: 'a' }, { role: 'system', content: 's1' }, { role: 'system', content: 's2' }, { role: 'system', content: 's3' }, { role: 'user', content: 'b' }] }, "messages.3: role 'system' must precede an 'assistant' message or end the array; the directive-only form (content: [] with output_config) is accepted at any position"],
  ["shape system content empty past the head", { messages: [{ role: 'user', content: 'a' }, { role: 'system', content: [] }] }, "messages.1: system content must contain at least one block"],
  ["shape system content empty beats position", { messages: [{ role: 'user', content: 'a' }, { role: 'system', content: [] }, { role: 'user', content: 'b' }] }, "messages.1: system content must contain at least one block"],
  ["shape system whitespace text", { messages: [{ role: 'user', content: 'a' }, { role: 'system', content: '  ' }] }, "messages.1: system text blocks must contain non-whitespace text"],
  ["shape system one empty block of two", { messages: [{ role: 'user', content: 'a' }, { role: 'system', content: [{ type: 'text', text: 'x' }, { type: 'text', text: '' }] }] }, "messages.1: system text blocks must contain non-whitespace text"],
  ["shape system position beats whitespace", { messages: [{ role: 'user', content: 'a' }, { role: 'system', content: '  ' }, { role: 'user', content: 'b' }] }, "messages.1: role 'system' must precede an 'assistant' message or end the array; the directive-only form (content: [] with output_config) is accepted at any position"],
  ["shape system at the head empty", { messages: [{ role: 'system', content: [] }, { role: 'user', content: 'a' }] }, "messages.0: system content must contain at least one block"],
  ["shape system at the head whitespace", { messages: [{ role: 'system', content: '  ' }, { role: 'user', content: 'a' }] }, "messages.0: use the top-level 'system' parameter for the initial system prompt; the directive-only form (content: [] with output_config) is accepted at any position"],
  // A system item's blocks are its own set, and the check sits between the
  // empty-content one and the index-0 guidance.
  ["shape system block type", { messages: [{ role: 'user', content: 'a' }, { role: 'system', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' } }] }] }, "messages.1: role 'system' supports text, tool_addition, and tool_removal blocks only"],
  ["shape system block type beats position", { messages: [{ role: 'user', content: 'a' }, { role: 'system', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' } }] }, { role: 'user', content: 'b' }] }, "messages.1: role 'system' supports text, tool_addition, and tool_removal blocks only"],
  ["shape system block type at the head", { messages: [{ role: 'system', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' } }] }, { role: 'user', content: 'a' }] }, "messages.0: role 'system' supports text, tool_addition, and tool_removal blocks only"],
  ["shape empty user turn alone", { messages: [{ role: 'user', content: [] }] }, "messages.0: user messages must have non-empty content"],
  ["shape empty user string alone", { messages: [{ role: 'user', content: '' }] }, "messages.0: user messages must have non-empty content"],
  ["shape empty user turn after an assistant", { messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'ok' }, { role: 'user', content: [] }] }, "messages.2: user messages must have non-empty content"],
  ["shape empty user run of two is reported at its first item", { messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'ok' }, { role: 'user', content: [] }, { role: 'user', content: [] }] }, "messages.2: user messages must have non-empty content"],
  ["shape order a field type fault beats an empty turn", { messages: [{ role: 'user', content: [] }], temperature: 'x' }, "temperature: Input should be a valid number"],
  ["shape order an unknown key beats an empty turn", { messages: [{ role: 'user', content: [] }], zzz_unknown: 1 }, "zzz_unknown: Extra inputs are not permitted"],
  ["shape order an empty turn beats container", { messages: [{ role: 'user', content: [] }], container: 'container_x' }, "messages.0: user messages must have non-empty content"],
  ["shape order a bad role beats an empty system", { messages: [{ role: 'user', content: 'a' }, { role: 'system', content: [] }, { role: 'bogus', content: 'x' }] }, "messages: Unexpected role \"bogus\". Allowed roles are \"user\" or \"assistant\""],
];

for (const [name, fragment, message] of REJECTIONS) {
  test(`/v1/messages rejects ${name} as the direct API does`, async () => {
    const { status, payload } = await messages(fragment);
    assert.equal(status, 400, JSON.stringify(payload));
    assert.equal(payload.type, 'error');
    assert.equal(payload.error.type, 'invalid_request_error');
    assert.equal(payload.error.message, message);
    assert.equal(payload.error.param, undefined, 'this envelope carries no param');
    assert.equal(payload.error.code, undefined, 'and no code');
  });
}

// Bodies the direct API ACCEPTS. A shape rule that refuses one of these is the
// worst failure this surface can have — a working client stops working — and no
// rejection row can see it.
const ACCEPTED = [
  ["system ends the array", [{ role: 'user', content: 'a' }, { role: 'system', content: 'sys' }]],
  ["system precedes an assistant", [{ role: 'user', content: 'a' }, { role: 'system', content: 'sys' }, { role: 'assistant', content: 'ok' }, { role: 'user', content: 'b' }]],
  ["a run of system items", [{ role: 'user', content: 'a' }, { role: 'system', content: 's1' }, { role: 'system', content: 's2' }]],
  // The controls for the two rejection rows above: the SAME runs, ended
  // legally. Only where a run ends is constrained, so a run of any length that
  // ends the array or precedes an assistant is accepted — a rule that reported
  // at the run's first item would have to refuse these to refuse the others.
  ["a run of three system items ending the array", [{ role: 'user', content: 'a' }, { role: 'system', content: 's1' }, { role: 'system', content: 's2' }, { role: 'system', content: 's3' }]],
  ["a run of two system items preceding an assistant", [{ role: 'user', content: 'a' }, { role: 'system', content: 's1' }, { role: 'system', content: 's2' }, { role: 'assistant', content: 'ok' }, { role: 'user', content: 'b' }]],
  ["an empty user turn a later one gives content", [{ role: 'user', content: [] }, { role: 'user', content: 'a' }]],
  ["an empty user turn an earlier one gives content", [{ role: 'user', content: 'a' }, { role: 'user', content: [] }]],
  ["an empty user turn inside a run with content", [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'ok' }, { role: 'user', content: [] }, { role: 'user', content: 'b' }]],
  ["an empty assistant turn", [{ role: 'user', content: 'a' }, { role: 'assistant', content: [] }]],
  ["a system item whose blocks all carry text", [{ role: 'user', content: 'a' }, { role: 'system', content: [{ type: 'text', text: 'x' }] }]],
  ["a system item of two text blocks", [{ role: 'user', content: 'a' }, { role: 'system', content: [{ type: 'text', text: 'x' }, { type: 'text', text: 'y' }] }]],
];

for (const [name, list] of ACCEPTED) {
  test(`/v1/messages accepts ${name}, as the direct API does`, async () => {
    const started = await startLocalApiProxy({
      backend: {
        name: 'test', model: 'configured-model',
        async generate() {
          return { id: 'x', model: 'configured-model', text: 'pong', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, source: 'estimated' }, latencyMs: 1 };
        },
        async *stream() { throw new Error('unused'); },
        async close() {},
      },
      host: '127.0.0.1', port: 0, requestTimeoutMs: 30_000,
    });
    try {
      const res = await fetch(`${started.url}/v1/messages`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 16, messages: list }),
      });
      const payload = await res.json();
      assert.equal(res.status, 200, JSON.stringify(payload));
    } finally {
      await started.close();
    }
  });
}

test('the rows cover every key this surface knows', () => {
  const sent = new Set();
  for (const [, fragment] of REJECTIONS) for (const key of Object.keys(fragment)) sent.add(key);
  const known = [
    'model', 'messages', 'max_tokens', 'cache_control', 'container', 'inference_geo',
    'metadata', 'output_config', 'service_tier', 'stop_sequences', 'stream', 'system',
    'temperature', 'thinking', 'tool_choice', 'tools', 'top_k', 'top_p',
  ];
  assert.deepEqual(known.filter((key) => !sent.has(key)), [], 'these known keys have no row');
});
