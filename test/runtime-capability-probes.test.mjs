// The catalog gates decide whether a documented capability is still real, and
// a wrong verdict here ships a wrong entry inside the package. They had no
// tests: the gates were checked by running them by hand against a mutated
// catalog, which cannot cover the inputs that never occur on this machine. An
// inverted verdict survived exactly that gap — `parseHelpText` returns '' for
// help with no usage line, never null, so a null-guard let the empty value
// through and a REMOVED command was reported as a confirmed hidden one.
import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyFlagProbe } from '../scripts/runtime-capability/probes.mjs';
import { parseHelpText } from '../scripts/runtime-capability/help-parser.mjs';
import { collectMethodEnums } from '../scripts/runtime-capability/schema.mjs';

test('help with no usage line parses to an empty string, not null', () => {
  // The premise the guards rest on. If this ever returns null, the truthiness
  // checks below still hold, but a future `=== null` guard would start working
  // by accident and its absence elsewhere would stop being a defect.
  const parsed = parseHelpText('Some help with no usage line\nOptions:\n  --foo  bar');
  assert.equal(parsed.usage, '');
  assert.notEqual(parsed.usage, null);
});

test('a parent whose help prints no usage line cannot confirm a child command', async () => {
  // The regression in full: parent usage is '', the child prints something, and
  // a nullness guard would compare '' against it, find them different, and call
  // the child present. The child is documented and gone; this must not confirm it.
  const { commandAnswersForItself } = await import('../scripts/runtime-capability/probes.mjs');
  const source = commandAnswersForItself.toString();
  assert.match(
    source,
    /if \(!usage \|\| !parentUsage\) return 'indeterminate';/,
    'both usages must be checked for truthiness, not for null',
  );
  assert.doesNotMatch(
    source,
    /parentUsage === null/,
    'a nullness guard passes the empty usage parseHelpText actually returns',
  );
});

test('flag probe classification separates the three parser answers', () => {
  const flag = '--zzz-probe-target';
  const ok = { ok: true, code: 1, signal: null };
  assert.equal(
    classifyFlagProbe(`error: unknown option '${flag}'`, flag, ok),
    'unregistered',
  );
  assert.equal(
    classifyFlagProbe("argument '--zzz-catalog-probe-control' is invalid. Allowed choices are a, b.", flag, ok),
    'registered_value_validated',
  );
  assert.equal(
    classifyFlagProbe("error: unknown option '--zzz-catalog-probe-control'", flag, ok),
    'registered_no_value_consumed',
  );
});

test('a probe that was killed or said nothing is indeterminate, never registered', () => {
  const flag = '--zzz-probe-target';
  // A run that produced no parser evidence must not vouch for the flag: that is
  // how a dropped flag would read as supported.
  assert.equal(classifyFlagProbe('', flag, { ok: false, code: null, signal: 'SIGTERM' }), 'indeterminate');
  assert.equal(classifyFlagProbe('   \n  ', flag, { ok: true, code: 0, signal: null }), 'indeterminate');
});

test('the negative controls are flags no CLI can have', async () => {
  // The probe is evidence only because these come back unregistered. A control
  // that some CLI actually registers would silently disable the whole gate.
  const { FLAG_PROBE_CONTROL, FLAG_PROBE_CONTROLS } = await import('../scripts/runtime-capability/options.mjs');
  for (const control of [...FLAG_PROBE_CONTROLS, FLAG_PROBE_CONTROL]) {
    assert.match(control, /^--zzz-/, 'controls must be obviously synthetic');
  }
  assert.ok(FLAG_PROBE_CONTROLS.length >= 2, 'one control cannot distinguish a reworded rejection from a real one');
});

test('schema method collection reads method discriminators, not slash-bearing nested enums', () => {
  const schema = {
    oneOf: [
      {
        properties: {
          method: { enum: ['mcpServer/elicitation/request'] },
          params: { properties: { mode: { enum: ['form', 'openai/form', 'openaiForm', 'url'] } } },
        },
      },
      { properties: { method: { enum: ['turn/start'] } } },
    ],
    definitions: {
      unrelated: { enum: ['also/not-a-method'] },
    },
  };

  assert.deepEqual(collectMethodEnums(schema), ['mcpServer/elicitation/request', 'turn/start']);
});
