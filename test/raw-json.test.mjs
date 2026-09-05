import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RawJson, stringifyJson } from '../dist/proxy/raw-json.js';

// The Messages surface publishes a call's arguments as a JSON value, so the
// body's serializer has to carry the runtime's bytes through unchanged; a
// parse-and-stringify round trip rounded `9007199254740993` to `…992` and
// rewrote `1e999` as `null` (round 21).

test('stringifyJson: a RawJson value goes out as its own bytes, wherever it sits', () => {
  const body = {
    content: [
      { type: 'text', text: 'first' },
      { type: 'tool_use', id: 'c1', input: new RawJson('{"id":9007199254740993,"w":1e999, "s": "x"}') },
      { type: 'tool_use', id: 'c2', input: new RawJson('{}') },
    ],
    nested: { deeper: [new RawJson('[1, 2.50, -0]')] },
  };
  assert.equal(
    stringifyJson(body),
    '{"content":[{"type":"text","text":"first"},{"type":"tool_use","id":"c1","input":{"id":9007199254740993,"w":1e999, "s": "x"}},{"type":"tool_use","id":"c2","input":{}}],"nested":{"deeper":[[1, 2.50, -0]]}}',
  );
});

test('stringifyJson: without a RawJson value it is JSON.stringify', () => {
  const payload = { a: [1, 'two', null, { b: false }], c: 'd' };
  assert.equal(stringifyJson(payload), JSON.stringify(payload));
});

test('stringifyJson: a string that spells a placeholder is a string, not a splice', () => {
  // The nonce is generated per call, so no authored string can name it; a
  // string shaped like a placeholder from another call is left as it is.
  const text = stringifyJson({ input: new RawJson('{"n":1}') });
  const nonce = text.match(/^\{"input":\{"n":1\}\}$/) ? null : text;
  assert.equal(nonce, null, text);
  const foreign = `${'0'.repeat(8)}-0000-4000-8000-000000000000:0`;
  assert.equal(stringifyJson({ s: foreign, input: new RawJson('[]') }), `{"s":"${foreign}","input":[]}`);
});

test('RawJson: text that is not JSON is a programming error, refused at construction', () => {
  assert.throws(() => new RawJson('{"city":"Seo'), SyntaxError);
  assert.throws(() => new RawJson(''), SyntaxError);
  assert.equal(new RawJson(' 12 ').text, ' 12 ', 'whitespace around a value is kept');
});
