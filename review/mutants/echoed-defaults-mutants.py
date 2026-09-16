#!/usr/bin/env python3
"""Echoed-defaults conformance gate mutation testing.

Each mutant reverts one decision the gate is supposed to hold, and is killed by
the check that pins it. A BASELINE phase first runs every pinning test on the
UNMUTATED build and requires it to PASS, so a KILLED verdict is attributable to
the mutant rather than to a test that fails regardless.

Two of the mutants are not code. The gate reads its authority from data —
`spec/declared-divergences.json` and the promoted captures — and a gate whose
data path is unpinned can be silently emptied: a declaration list that goes
blank, or a fixture that drifts from the bytes it was promoted from. Those are
mutated too.

Plant -> build (tsc, only when TypeScript changed) -> run the pinning test ->
assert fail>=1 -> restore. Restoration is verified by digest at exit.
"""
import json
import sys

from mutation_harness import options, run_mutation_suite

# Absolute by default, overridable: a reviewer given this file in another
# checkout could read it but never re-establish its count, which makes the
# "12/12 killed" line a claim rather than a receipt.
#   python3 echoed-defaults-mutants.py --root <repo> [--log <dir>]
ROOT, LOG = options(sys.argv[1:])

SERVER = 'src/proxy/http-server.ts'
DIVERGENCES = 'spec/declared-divergences.json'
FIXTURE = 'spec/captures/direct-chat-minimal.json'

GATE = 'test/conformance-echoed-defaults.test.mjs'
USAGE = 'test/proxy-http.test.mjs'

RESPONSES_DETAILS = (
    "    input_tokens_details: {\n"
    "      cached_tokens: cacheReadTokens(usage),\n"
    "      cache_write_tokens: cacheWriteTokens(usage),\n"
    "    },"
)
CHAT_DETAILS = (
    "    prompt_tokens_details: {\n"
    "      cached_tokens: cacheReadTokens(usage),\n"
    "      cache_write_tokens: cacheWriteTokens(usage),\n"
    "      audio_tokens: 0,\n"
    "    },"
)

# (name, file, test file, test-name pattern, needle, replacement)
MUTANTS = [
    # E1/E2: the field the vendor sends and we did not, back out on each surface.
    # The shape half of the gate must notice a path the vendor has and we lack
    # that no declaration covers.
    ('E1-responses-cache-write-dropped', SERVER, GATE, 'responses',
     RESPONSES_DETAILS,
     "    input_tokens_details: {\n"
     "      cached_tokens: cacheReadTokens(usage),\n"
     "    },"),
    ('E2-chat-cache-write-dropped', SERVER, GATE, 'chat',
     CHAT_DETAILS,
     "    prompt_tokens_details: {\n"
     "      cached_tokens: cacheReadTokens(usage),\n"
     "      audio_tokens: 0,\n"
     "    },"),
    # E3: the echoed default measured on the wire, reverted to the value the
    # contract's sample body showed. Only the VALUE half can see this — the
    # shape is identical either way.
    ('E3-reasoning-context-reverted', SERVER, GATE, 'responses',
     "context: typeof reasoning.context === 'string' ? reasoning.context : 'all_turns',",
     "context: typeof reasoning.context === 'string' ? reasoning.context : 'current_turn',"),
    # E4: cache writes folded back into the read counter. Invisible to the gate
    # (its fixture backend reports no cache activity at all) and pinned instead
    # by the split-runtime fixture — which is why that fixture exists.
    ('E4-cache-read-sums-writes', SERVER, USAGE, 'cache WRITE',
     "  return usage.cacheReadInputTokens ?? usage.cachedInputTokens ?? 0;",
     "  return usage.cachedInputTokens\n"
     "    ?? (usage.cacheCreationInputTokens ?? 0) + (usage.cacheReadInputTokens ?? 0);"),
    # E5: a field the vendor does not send. The proxy has never invented one and
    # the gate asserts that direction separately, so this must not pass.
    ('E5-invented-field', SERVER, GATE, 'responses',
     "    moderation: null,",
     "    moderation: null,\n    zzz_invented: true,"),
    # E6: Images delegating to the Responses usage builder again, which leaks a
    # field measured on another surface into one that has no capture at all.
    ('E6-images-inherit-responses-usage', SERVER, USAGE, 'image',
     "  if (!isLocalUsage(usage)) return usage;\n"
     "  const inputTokens = openAiInputTokens(usage);\n"
     "  const outputTokens = usage.outputTokens;\n"
     "  return {\n"
     "    input_tokens: inputTokens,\n"
     "    output_tokens: outputTokens,\n"
     "    total_tokens: usage.totalTokens ?? inputTokens + outputTokens,\n"
     "    input_tokens_details: {\n"
     "      cached_tokens: cacheReadTokens(usage),\n"
     "    },\n"
     "    output_tokens_details: {\n"
     "      reasoning_tokens: usage.reasoningOutputTokens ?? 0,\n"
     "    },\n"
     "  };",
     "  return isLocalUsage(usage) ? openAiResponsesUsage(usage) : usage;"),
    # E7 (data): the declaration list emptied. The gate reads what it is allowed
    # not to report from data, so an empty list must fail rather than widen.
    ('E7-declaration-emptied', DIVERGENCES, GATE, 'responses', None, 'EMPTY_ABSENT_PATHS'),
    # E8 (fixture): the promoted bytes edited away from their digest. Evidence
    # that has drifted is not evidence, and the gate must say so before it
    # compares anything against it.
    ('E8-fixture-tampered', FIXTURE, GATE, 'intact', None, 'TAMPER_BODY'),
    # E9-E11 are the classes a cross-provider review found the first eight did
    # not reach. Each SURVIVED the gate as first written; they are here because
    # a fix is worth only the mutant that proves it.
    #
    # E9: an empty vendor array answered with a scalar member. Scalar members
    # produce no key path, so the shape reading sees nothing; the value reading
    # iterates the vendor's leaves, and an empty array has none. Killed by the
    # array-length value.
    ('E9-scalar-array-leaked', SERVER, GATE, 'responses',
     "    tools: Array.isArray(raw.tools) ? raw.tools : [],",
     "    tools: Array.isArray(raw.tools) ? raw.tools : ['zzz-leaked'],"),
    # E10: an empty container answered with `null`. Same path, no children,
    # no leaf — invisible until the key path carries its JSON type.
    ('E10-empty-object-becomes-null', SERVER, GATE, 'responses',
     "    metadata: asRecordPayload(raw.metadata),",
     "    metadata: null,"),
    # E11: the answer names a model the request did not ask for. `model` was on
    # the per-call skip list, where it did not belong: both sides echo the
    # request's model, so it is comparable, and a client reads it to know what
    # answered.
    ('E11-model-not-echoed', SERVER, GATE, 'responses',
     "    model: options.model,",
     "    model: 'zzz-not-the-requested-model',"),
    # E12: the turn's answer delivered twice. `output` is a per-call root, so
    # its item CONTENT is rightly not compared — but skipping the subtree also
    # skipped its cardinality, and a client receiving the message twice is not
    # a per-call difference. Array counts now survive the per-call skip.
    ('E12-output-item-duplicated', SERVER, GATE, 'responses',
     "    output: options.output,",
     "    output: [...options.output, ...options.output],"),
    # E13: the fan-out total recomputed from the bare input tokens, dropping the
    # cache counters beside them — a total BELOW the prompt it reports.
    ('E13-fanout-total-drops-cache', SERVER, USAGE, 'fan-out totals',
     "      ? { totalTokens: openAiInputTokens(first.usage) + outputTokens }",
     "      ? { totalTokens: first.usage.inputTokens + outputTokens }"),
    # E14: the Chat side of E12 — a choice delivered twice on a request that
    # asked for one. `choices` is a per-call root like `output`, so this exists
    # to show the cardinality exception is not Responses-only.
    ('E14-chat-choice-duplicated', SERVER, GATE, 'chat',
     "    choices: results.map((result, index) => openAiChatChoice(result, index)),",
     "    choices: [...results, ...results].map((result, index) => openAiChatChoice(result, index)),"),
]



def run(cmd, logf):
    with open(logf, 'w') as handle:
        return subprocess.run(cmd, cwd=ROOT, stdout=handle, stderr=subprocess.STDOUT, text=True).returncode


def counts(path):
    tests = passn = failn = None
    for line in path.read_text().splitlines():
        s = line.strip()
        if s.startswith('ℹ tests'):
            tests = int(s.split()[-1])
        if s.startswith('ℹ pass'):
            passn = int(s.split()[-1])
        if s.startswith('ℹ fail'):
            failn = int(s.split()[-1])
    return tests, passn, failn


def apply_special(kind, text):
    if kind == 'EMPTY_ABSENT_PATHS':
        data = json.loads(text)
        for entry in data['divergences']:
            if entry.get('claim') == 'echoed-defaults':
                entry['absentPaths'] = []
        return json.dumps(data, ensure_ascii=False, indent=2) + '\n'
    if kind == 'TAMPER_BODY':
        data = json.loads(text)
        data['body'] = data['body'].replace('"default"', '"flex"', 1)
        return json.dumps(data, indent=2) + '\n'
    raise AssertionError(kind)


def empty_absent_paths(text):
    data = json.loads(text)
    for entry in data['divergences']:
        if entry.get('claim') == 'echoed-defaults':
            entry['absentPaths'] = []
    return json.dumps(data, ensure_ascii=False, indent=2) + '\n'


def tamper_body(text):
    data = json.loads(text)
    data['body'] = data['body'].replace('"default"', '"flex"', 1)
    return json.dumps(data, indent=2) + '\n'


run_mutation_suite(
    root=ROOT,
    log=LOG,
    prefix='ed',
    subject=['src', 'test', 'spec', 'scripts', 'tsconfig.json', 'package.json', 'pnpm-lock.yaml'],
    files={SERVER, DIVERGENCES, FIXTURE},
    baseline=[GATE, USAGE],
    mutants=MUTANTS,
    specials={'EMPTY_ABSENT_PATHS': empty_absent_paths, 'TAMPER_BODY': tamper_body},
    runner_file=__file__,
)
