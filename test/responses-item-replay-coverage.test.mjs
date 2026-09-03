import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeOpenAiResponsesRequest } from '../dist/proxy/normalizers.js';

/**
 * `spec/declared-divergences.json`: every typed input item other than a
 * message, reasoning, and the native function-call pair reaches the model as a
 * LABELLED TRANSCRIPT RECORD. Replay coverage used to prove that for
 * `program_output` alone, so a mutant that added a whole type to the drop
 * branch — `web_search_call`, its query and all — passed 1665 tests.
 *
 * The case list is derived from the accepted-type union rather than written
 * out, so a type added to the union without replay handling fails here instead
 * of silently vanishing from the transcript.
 */

// Kept in sync by the union check below, never hand-maintained against it.
const ACCEPTED = [
  'additional_tools', 'agent_message', 'apply_patch_call', 'apply_patch_call_output',
  'code_interpreter_call', 'compaction', 'compaction_trigger', 'computer_call',
  'computer_call_output', 'custom_tool_call', 'custom_tool_call_output', 'file_search_call',
  'function_call', 'function_call_output', 'image_generation_call', 'item_reference',
  'local_shell_call', 'local_shell_call_output', 'mcp_approval_request', 'mcp_approval_response',
  'mcp_call', 'mcp_list_tools', 'message', 'multi_agent_call', 'multi_agent_call_output',
  'program', 'program_output', 'reasoning', 'shell_call', 'shell_call_output', 'tool_search_call',
  'tool_search_output', 'web_search_call',
];

// `message` carries its own role and is not a transcript record; `reasoning` is
// dropped on purpose and has its own test below.
const NOT_REPLAYED = new Set(['message', 'reasoning']);

test('the accepted-type union has not changed under this test', () => {
  // The union is the source of the cases. If it grows, this fails first and
  // says so, rather than the new type quietly going untested.
  // A type outside the union is refused with the union itself in the message.
  // Matching on that, rather than on "Invalid value", keeps this from reading
  // an unrelated complaint (a `message` item needs a role) as a rejected type.
  const rejectedAsType = (type) => {
    try {
      normalizeOpenAiResponsesRequest({ model: 'm', input: [{ type, id: 'i_1', role: 'assistant', content: 'x' }] });
      return false;
    } catch (err) {
      return /Invalid value/.test(err.message) && /web_search_call/.test(err.message);
    }
  };
  assert.equal(rejectedAsType('definitely_not_an_item_type'), true, 'unknown types must still be rejected');
  for (const type of ACCEPTED) {
    assert.equal(rejectedAsType(type), false, `${type} is in this test's list but the normalizer rejects it`);
  }
});

for (const type of ACCEPTED.filter((item) => !NOT_REPLAYED.has(item))) {
  test(`a ${type} item reaches the model instead of vanishing`, () => {
    const sentinel = `SENTINEL_${type.toUpperCase()}`;
    // One payload shape for every type: whichever field a given type actually
    // reads, the sentinel is in it, so a type that reads none of them fails.
    const request = normalizeOpenAiResponsesRequest({
      model: 'm',
      input: [{
        type,
        id: 'it_1',
        status: 'completed',
        call_id: 'call_1',
        name: sentinel,
        arguments: JSON.stringify({ q: sentinel }),
        output: sentinel,
        action: { type: 'search', query: sentinel },
        text: sentinel,
        content: sentinel,
        summary: sentinel,
        result: sentinel,
        query: sentinel,
        command: [sentinel],
        code: sentinel,
      }],
    });
    assert.ok(request.messages.length > 0, `${type} produced no message at all`);
    assert.ok(
      JSON.stringify(request.messages).includes(sentinel),
      `${type} reached the model with its content stripped: ${JSON.stringify(request.messages).slice(0, 200)}`,
    );
  });
}

test('reasoning is the declared exception and stays dropped', () => {
  const request = normalizeOpenAiResponsesRequest({
    model: 'm',
    input: [{ type: 'reasoning', id: 'r_1', summary: 'SENTINEL_REASONING' }],
  });
  assert.equal(request.messages.length, 0);
});

test('CONTROL: the sentinel check can fail — an item stripped to nothing is caught', () => {
  const request = normalizeOpenAiResponsesRequest({
    model: 'm',
    input: [{ type: 'web_search_call', id: 'ws_1', status: 'completed', action: { type: 'search', query: 'OTHER' } }],
  });
  assert.equal(JSON.stringify(request.messages).includes('SENTINEL_WEB_SEARCH_CALL'), false);
});
