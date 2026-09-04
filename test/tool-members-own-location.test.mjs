import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeOpenAiChatRequest, normalizeOpenAiResponsesRequest } from '../dist/proxy/normalizers.js';
import { parseBackendOutput } from '../dist/proxy/backend-contract.js';

// A tool's members are read from each surface's own location only, as the
// direct APIs read them (measured 2026-09-05, review-artifacts/stage2/report.md
// M9): Chat reads `function.*` and ignores a top-level `parameters` or
// `description`; Responses reads the top level and ignores a stray `function`
// member. Round 20 scoped `strict` this way; round 21 (Fable F2) found the
// name, description and schema still cross-read — a schema in the other
// surface's place was what `strict` enforced, and a nested `function.name`
// shadowed a Responses tool's declared name.

const SCHEMA = { type: 'object', properties: { q: { type: 'string' } }, required: ['q'], additionalProperties: false };
const M = [{ role: 'user', content: 'x' }];

test('chat: a top-level parameters or description is not the tool\'s, and strict enforces nothing without function.parameters', () => {
  const request = normalizeOpenAiChatRequest({ model: 'm', messages: M, tools: [
    { type: 'function', function: { name: 'a', strict: true }, parameters: SCHEMA, description: 'foreign' },
  ] });
  assert.equal(request.tools[0].name, 'a');
  assert.equal(request.tools[0].inputSchema, undefined);
  assert.equal(request.tools[0].description, undefined);
  assert.equal(request.tools[0].strict, true);
  const forced = { ...request, toolChoice: { type: 'tool', name: 'a' } };
  const out = parseBackendOutput(forced, '{"nope":1}');
  assert.equal(out.toolCalls[0].arguments, '{"nope":1}', 'no schema at the tool\'s own location: nothing to judge by');
});

test('chat: function.parameters is the schema even beside a stray top-level one', () => {
  const request = normalizeOpenAiChatRequest({ model: 'm', messages: M, tools: [
    { type: 'function', function: { name: 'a', parameters: SCHEMA, strict: true, description: 'own' }, parameters: { type: 'object', properties: {} } },
  ] });
  assert.deepEqual(request.tools[0].inputSchema, SCHEMA);
  assert.equal(request.tools[0].description, 'own');
  const forced = { ...request, toolChoice: { type: 'tool', name: 'a' } };
  assert.throws(() => parseBackendOutput(forced, '{"nope":1}'), /outside the tool's schema/);
});

test('responses: a stray Chat-shaped function member neither names the tool nor supplies its schema', () => {
  const request = normalizeOpenAiResponsesRequest({ model: 'm', input: 'x', tools: [
    { type: 'function', name: 'real', parameters: SCHEMA, strict: true, function: { name: 'fake', parameters: { type: 'object', properties: { z: { type: 'number' } } }, description: 'foreign' } },
  ] });
  assert.equal(request.tools[0].name, 'real');
  assert.deepEqual(request.tools[0].inputSchema, SCHEMA);
  assert.equal(request.tools[0].description, undefined);
  assert.equal(request.tools[0].strict, true);
  // Forcing the name the client declared at the surface's own location is
  // forcing a declared tool.
  const forced = normalizeOpenAiResponsesRequest({ model: 'm', input: 'x', tool_choice: { type: 'function', name: 'real' }, tools: [
    { type: 'function', name: 'real', parameters: SCHEMA, function: { name: 'fake' } },
  ] });
  assert.deepEqual(forced.toolChoice, { type: 'tool', name: 'real' });
});
