#!/usr/bin/env python3
"""Supplied-echo conformance gate mutation testing.

The sibling runner asks what protects the answer to a request that configures
nothing. This one asks what protects the answer to a request that asks for
something: each mutant reverts one decision `conformance-supplied-echo.test`
is supposed to hold, and is killed by the row that pins it.

Eleven of the forty are not code. This gate reads its authority from data — the
declared divergences and the promoted captures — and a gate whose data path is
unpinned can be silently emptied there: a declaration list that goes blank, a
value divergence loosened until it exempts anything, a fixture that drifts from
the bytes it was promoted from.

    python3 supplied-echo-mutants.py --root <repo> [--log <dir>]
"""
import json
import sys

from mutation_harness import options, run_mutation_suite

ROOT, LOG = options(sys.argv[1:])

SERVER = 'src/proxy/http-server.ts'
NORMALIZERS = 'src/proxy/normalizers.ts'
DIVERGENCES = 'spec/declared-divergences.json'
FIXTURE = 'spec/captures/direct-responses-service-tier-flex.json'
MANIFEST = 'spec/conformance.json'

GATE = 'test/conformance-supplied-echo.test.mjs'
MANIFEST_GATE = 'test/conformance-manifest.test.mjs'
ROSTER = 'test/replayed-captures.mjs'
COMPARISON = 'scripts/lib/response-comparison.mjs'
READER_GATE = 'test/declared-absence-reader.test.mjs'

# (name, file, test file, test-name pattern, needle, replacement)
MUTANTS = [
    # S1: the fix this gate's first run forced. Without the effort gate the
    # surface refuses what the direct API answered 200 to, and the status
    # comparison is the only thing that sees it.
    ('S1-effort-gate-reverted', NORMALIZERS, GATE, 'top-logprobs',
     "  const reasons = asRecord(input.reasoning)?.effort !== 'none';",
     "  const reasons = true;"),
    # S2: the behaviour matrix R-20 used to describe — an option promised and
    # then contradicted in the same answer.
    ('S2-parallel-tool-calls-hard-true', SERVER, GATE, 'tools-parallel-false',
     "    parallel_tool_calls: raw.parallel_tool_calls === false ? false : true,",
     "    parallel_tool_calls: true,"),
    # S3: an echo replaced by a constant. The client asked for `flex` and would
    # be told `default` — the failure mode this whole gate exists for.
    ('S3-responses-service-tier-constant', SERVER, GATE, 'direct-responses-service-tier-flex',
     "    service_tier: echoedServiceTier(options.request),",
     "    service_tier: 'default',"),
    # S4: the Chat side of S3, so the gate is shown to reach both surfaces.
    ('S4-chat-service-tier-constant', SERVER, GATE, 'direct-chat-service-tier-flex',
     # Anchored on the buffered body, which is what this gate posts. The same
     # two lines appear in the streamed chunk builder, and a needle that matched
     # both would not have expressed one mutant — the runner refuses that rather
     # than picking, and did so on this table's first run.
     "    usage: openAiChatUsage(mergedChatUsage(results)),\n    service_tier: echoedServiceTier(request),",
     "    usage: openAiChatUsage(mergedChatUsage(results)),\n    service_tier: 'default',"),
    ('S5-store-hard-true', SERVER, GATE, 'store-false',
     "    store: raw.store === false ? false : true,",
     "    store: true,"),
    ('S6-metadata-emptied', SERVER, GATE, 'direct-responses-metadata',
     "    metadata: asRecordPayload(raw.metadata),",
     "    metadata: {},"),
    # S7: `top_logprobs` echoed as the constant the omitted case answers with.
    # The minimal capture cannot see this — its request omits the field — which
    # is why a supplied-value capture had to exist.
    ('S7-top-logprobs-echo-constant', SERVER, GATE, 'top-logprobs',
     "    top_logprobs: numberOrDefault(raw.top_logprobs, 0),",
     "    top_logprobs: 0,"),
    # S8: `n` is not echoed anywhere, so the only thing that can catch a
    # collapsed fan-out is the number of choices the client receives.
    ('S8-chat-fanout-collapsed', SERVER, GATE, 'direct-chat-n-2',
     "    choices: results.map((result, index) => openAiChatChoice(result, index)),",
     "    choices: results.slice(0, 1).map((result, index) => openAiChatChoice(result, index)),"),
    # S9 (data): the declaration list emptied. What we do not report has to be
    # declared, and an empty list means the gate has nothing to hold the answer to.
    ('S9-declaration-emptied', DIVERGENCES, GATE, None, None, 'EMPTY_ABSENT_PATHS'),
    # S10 (data): a value divergence loosened into an exemption — the declared
    # proxy side changed to something we do not send, which is what a stale
    # declaration looks like.
    ('S10-value-divergence-stale', DIVERGENCES, GATE, 'reasoning-summary', None, 'LOOSEN_VALUE_DIVERGENCE'),
    # S11 (data): a promoted capture edited after promotion.
    ('S11-fixture-tampered', FIXTURE, GATE, 'present, intact', None, 'TAMPER_BODY'),
    # S12: a second choice answered as `null`. The count is still 2 and every
    # path the first choice carries is still there, so only the member's TYPE
    # can see it — a review planted this and both gates passed.
    ('S12-second-choice-null', SERVER, GATE, 'direct-chat-n-2',
     "    choices: results.map((result, index) => openAiChatChoice(result, index)),",
     "    choices: results.map((result, index) => (index === 1 ? null : openAiChatChoice(result, index))),"),
    # S13 (data): a second declaration on a path that already has a true one.
    # Keyed by path, the true one's evidence certified the false one.
    ('S13-false-value-divergence', DIVERGENCES, GATE, 'reasoning-summary|exercised', None, 'PLANT_FALSE_DIVERGENCE'),
    # S14 (the roster): the row that replays a declared absence, deleted.
    # The declaration must lose its certification with it.
    ('S14-replay-row-deleted', ROSTER, GATE, None, None, 'DELETE_LOGPROBS_ROW'),
    # S15 (data): a row wearing the WIRE grade that names no capture. The
    # pattern runs only the rule's own test, so the manifest-drift check cannot
    # take the credit for killing it.
    ('S15-wire-names-no-capture', MANIFEST, MANIFEST_GATE, 'WIRE row names a capture', None, 'PLANT_BARE_WIRE'),
    # S16: a second choice answered as `{}`. The count is 2, the member type is
    # `object` as it should be, and every path the first choice carries is in
    # the union — so only a per-member reading can see a choice with no message
    # and no index. A confirmation review planted this and both gates passed.
    ('S16-second-choice-emptied', SERVER, GATE, 'direct-chat-n-2',
     "    choices: results.map((result, index) => openAiChatChoice(result, index)),",
     "    choices: results.map((result, index) => (index === 1 ? {} : openAiChatChoice(result, index))),"),
    # S17: a declared absence answered present-but-EMPTY. The declaration says
    # this proxy does not report `choices[].logprobs` at all; answering an empty
    # container satisfies a reading that credits the declaration for the array
    # MEMBER's missing path, which is the only path such an answer omits.
    ('S17-declared-absence-answered-empty', SERVER, GATE, 'direct-chat-logprobs-effort-none',
     "function openAiChatChoice(result: LocalCompletionResult, index: number): unknown {\n"
     "  const hasToolCalls = result.toolCalls.length > 0;\n  return {\n    index,\n",
     "function openAiChatChoice(result: LocalCompletionResult, index: number): unknown {\n"
     "  const hasToolCalls = result.toolCalls.length > 0;\n  return {\n    index,\n"
     "    logprobs: { content: [] },\n"),
    # S18 (data): a declaration whose two sides are ARRAYS holding the true
    # tuple's text. Under strict equality they match no leaf, so the
    # declaration can never be exhibited — but a key built by interpolation
    # reads identical to the true one's, and the true one's evidence certified
    # it.
    ('S18-divergence-tuple-coerced', DIVERGENCES, GATE, 'reasoning-summary|exercised', None, 'PLANT_COERCIBLE_DIVERGENCE'),
    # S19 (data): S13's false declaration again, with only the participation
    # check running. Exhibition used to be filled as a side effect of the
    # per-row tests, so under a filter — or a runner that reorders — this
    # certified a declaration nothing had replayed.
    ('S19-false-divergence-alone', DIVERGENCES, GATE, 'every declaration is exercised', None, 'PLANT_FALSE_DIVERGENCE'),
    # S20 (the roster): the capture a WIRE row cites, dropped from the roster
    # that replays it. S15 covers the row that names nothing; this covers the
    # row whose evidence stops being replayed while the citation stands.
    #
    # Its first form planted a WIRE row naming `direct-chat-stream` on the claim
    # that no gate replays it. A review read the stream gate and found that it
    # does — the mutant was rejecting on a false premise, and the registry, not
    # the mutant, was what was wrong.
    ('S20-wire-capture-loses-its-replay', ROSTER, MANIFEST_GATE, 'WIRE row names a capture', None, 'DROP_WIRE_CAPTURE_ROW'),
    # S21: the second choice keeps its own keys and its MESSAGE is emptied. A
    # signature of a member's immediate keys cannot see this — the review that
    # built it passed 39/39 against exactly that reading — so the signature has
    # to reach all the way down.
    ('S21-second-choice-message-emptied', SERVER, GATE, 'direct-chat-n-2',
     "    choices: results.map((result, index) => openAiChatChoice(result, index)),",
     "    choices: results.map((result, index) => (index === 1 "
     "? { ...(openAiChatChoice(result, index) as Record<string, unknown>), message: {} } "
     ": openAiChatChoice(result, index))),"),
    # S22: our turn gains a reasoning item. Every exemption on the tools row is
    # a consequence of our turn NOT having one, and until the row had to state
    # that premise the exemptions kept covering disagreements that were no
    # longer about a missing member.
    # The planted item matches the vendor's reasoning item in shape — `id`, and
    # `encrypted_content` as a STRING — so the row's shape comparison has
    # nothing to object to and the PREMISE is what fails. Two earlier forms died
    # one assertion sooner, first for omitting `id` and then for sending `null`
    # where the frozen capture holds a string; a review caught each. A mutant
    # that dies before the mechanism it was written for proves nothing about it.
    ('S22-our-turn-gains-a-reasoning-item', SERVER, GATE, 'direct-responses-tools-parallel-false',
     "    output: options.output,",
     "    output: [{ id: 'rs_planted', type: 'reasoning', content: [], "
     "encrypted_content: 'planted', summary: [] }, ...options.output],"),
    # S23 (the gate itself): the REPLAY driver reads a capture the roster does
    # not name. Its first form mutated the comparison side instead, which a
    # review pointed out is not the read that decides what gets replayed.
    ('S23-driver-reads-off-its-roster', GATE, GATE, 'the captures this check reads',
     "  for (const { fixture, surface, answer } of CAPTURES) {\n    const capture = load(fixture);",
     "  for (const { fixture, surface, answer } of CAPTURES) {\n    const capture = load('direct-responses-minimal');"),
    # S24 (the gate itself): the driver stays inside the roster and replays the
    # WRONG row's request. Nothing about the roster is edited, so only the bytes
    # that actually crossed the wire can tell. This mutant SURVIVED its first
    # run — the gate was hashing the capture it meant to send rather than what
    # it sent — which is how the recorder in front of the proxy came to exist.
    ('S24-driver-replays-another-rows-request', GATE, GATE, 'what crossed the wire',
     "      body: capture.request,",
     "      body: load(CAPTURES[0].fixture).request,"),
    # S25 (the gate itself): the per-row answer stops reaching the backend, so
    # every row is answered `OK` again — which is the state these six rows were
    # in when they read as "the proxy differs" and sat unpromoted for it. If no
    # row fails here, the answer registry is decoration and the rows that depend
    # on it are not backed by anything.
    ('S25-row-answer-not-supplied', GATE, GATE, 'stop-sequence-hit',
     "    replay.answerWith(answer);",
     "    replay.answerWith(undefined);"),
    # S26: the change this batch tried and REVERTED, put back. `anthropicUsage`
    # publishes `thinking_tokens` as `?? 0` — a constant zero behind the runtime
    # this surface exists for, because `claude-code-backend.ts` never populates
    # the field. The declaration says this surface does not report it, so a
    # build that starts reporting it has to go red: that is what makes the
    # declaration a check rather than a paragraph.
    ('S26-messages-publishes-an-unmeasured-thinking-count', SERVER, GATE, 'direct-messages-stop-sequence-hit',
     "    ...(cacheRead !== undefined ? { cache_read_input_tokens: cacheRead } : {}),",
     "    ...(cacheRead !== undefined ? { cache_read_input_tokens: cacheRead } : {}),\n"
     "    output_tokens_details: { thinking_tokens: usage.reasoningOutputTokens ?? 0 },"),
    # S27 (the gate itself): the echo assertion goes back to asking whether the
    # ROW compared anything, instead of whether each option it claims did. That
    # is what let a row supplying four options pass on `model`'s leaf alone, and
    # what let `include` ride along on `store`. Two independent reviews built
    # the case on the same day.
    ('S27-echo-asked-of-the-row-not-the-option', ROSTER, GATE, 'compared nothing fails even when a sibling',
     "  const speaksFor = supplied.filter((root) => echoedFor(root));\n"
     "  for (const root of speaksFor) {\n"
     "    if ((comparedByRoot.get(root) ?? 0) === 0) failures.push(`${root} reached no comparison, so this row does not speak for it`);\n"
     "  }",
     "  const speaksFor = supplied.filter((root) => echoedFor(root));\n"
     "  if (speaksFor.length > 0 && ![...comparedByRoot.values()].some((count) => count > 0)) {\n"
     "    failures.push(`${speaksFor.join(', ')} reached no comparison, so this row does not speak for it`);\n"
     "  }"),
    # S29 (the roster's rule): the map is allowed to stay silent about an option
    # the row supplies, which makes every unmentioned option default to "not
    # echoed" and claim nothing.
    ('S29-echo-map-may-omit-an-option', ROSTER, GATE, 'must say what happens to every option',
     "    const unsaid = supplied.filter((root) => typeof echoed[root] !== 'boolean');\n"
     "    if (unsaid.length > 0) failures.push(`the echo map does not say what happens to ${unsaid.join(', ')}`);",
     "    void supplied;"),
    # S28 (the gate itself): a surface whose answers have no binding table is
    # skipped instead of failing. The premise check then compares nothing for
    # any surface someone adds later, silently.
    ('S28-unbound-answer-is-skipped', ROSTER, GATE, 'refuses an answer on a surface it cannot check',
     "    if (!table) {\n"
     "      failures.push(`${fixture}: ${surface} has no binding table, so its premise is unchecked`);\n"
     "      continue;\n"
     "    }",
     "    if (!table) continue;"),
    # S30: the echo reader stops walking ancestors and goes back to exact
    # matching, which is what it did while the shape reader walked them. One
    # declaration, two answers — and the moderation row is the first capture in
    # the store that can tell them apart.
    ('S30-echo-reader-matches-exactly-again', COMPARISON, READER_GATE, 'a declared subtree answers for every leaf beneath it',
     "  return ancestors(base).some((field) => absent.has(field) && !ourFields.has(field));\n}",
     "  return false;\n}"),
    # S31: the `ourFields` guard goes away, so a declared ancestor keeps
    # answering for its descendants after we start reporting it. The declaration
    # would have stopped being true and the echo half would not notice.
    ('S31-declared-ancestor-credits-what-we-report', COMPARISON, READER_GATE, 'stops answering the moment we report it',
     "  return ancestors(base).some((field) => absent.has(field) && !ourFields.has(field));",
     "  return ancestors(base).some((field) => absent.has(field));"),
    # S32: the third row state stops asserting that we do NOT report the root it
    # declares absent, which is the half that makes it a check.
    ('S32-declared-absent-root-may-be-reported', ROSTER, GATE, 'this answer reports is a failure',
     "    if ((ourRoots ?? new Set()).has(root)) {\n"
     "      failures.push(`${root} is declared absent and this answer reports it`);\n"
     "    }",
     "    void ourRoots;"),
    # S33: a declared-absent root the vendor never fills is accepted, so a row
    # can claim a whole feature is missing from an answer that never had it.
    # S34: the guard goes back to covering only the ancestor walk, which is
    # where round 2 found it: an exactly-declared LEAF kept being exempt on the
    # echo side after we started reporting it, while the shape side went red.
    ('S34-exact-declaration-ignores-the-presence-guard', COMPARISON, READER_GATE, 'exactly-declared leaf stops being exempt',
     "  if ((absent.has(path) || absent.has(indexless)) && !ourFields.has(base)) return true;",
     "  if (absent.has(path) || absent.has(indexless)) return true;"),
    # S35: the answer's text stops being checked through its effect, which is
    # how a compensating fixture hid a serializer that ate a character.
    ('S35-answer-text-unbound', ROSTER, GATE, 'neither bound nor named free is reported',
     "    for (const field of new Set([...leafPaths(answer), ...leafPaths(served)])) {\n"
     "      if (covered.has(field)) continue;",
     "    for (const field of new Set([...leafPaths(answer), ...leafPaths(served)])) {\n"
     "      if (covered.has(field) || true) continue;"),
    # S36: the premise check goes back to reading the row's DECLARED half while
    # the backend serves the MERGE. That is the scope round 3 moved a
    # compensating value into: one character in `DEFAULT_ANSWER` and a real
    # proxy defect passed 122 green tests.
    ('S36-premise-checks-the-declared-answer', ROSTER, GATE, 'a row with NO answer is still checked',
     "    const answer = servedAnswer(declared);",
     "    const answer = declared;\n    if (!answer) continue;"),
    # S37: the unchecked-field scan goes back to top-level keys, which
    # `{usage: {anythingAtAll: 1}}` walked straight past because `usage` itself
    # was covered.
    ('S37-unbound-field-scan-is-shallow', ROSTER, GATE, 'a NESTED answer field that no binding covers',
     "    for (const field of new Set([...leafPaths(answer), ...leafPaths(served)])) {",
     "    for (const field of new Set([...Object.keys(answer), ...Object.keys(served)])) {"),
    # S38: a surface loses its binding table again, which used to exempt an
    # entire gate's worth of answers in silence.
    ('S38-a-surface-loses-its-bindings', ROSTER, GATE, 'row answer describes the turn',
     "  '/v1/responses': [\n    // The whole cut-off envelope",
     "  '/v1/responses-disabled': [\n    // The whole cut-off envelope"),
    # S39: the `supplied` assertion goes back to running one way. Round 3 used
    # exactly this to hide a client-visible echo defect from all 2274 tests.
    ('S39-supplied-assertion-runs-one-way', ROSTER, GATE, 'option THIS row does not claim is named',
     "      if (mandatory.has(key) || claims.has(key)) continue;",
     "      if (mandatory.has(key) || claims.has(key) || true) continue;"),
    # S40: an exception outlives what it was for — a key no capture sends, or
    # one a row does claim — and nothing says so.
    ('S40-stale-unclaimed-exception-accepted', ROSTER, GATE, 'is stale',
     "      if (!present.has(key)) staleExceptions.push(`${surface} ${key}: excused but no capture's request carries it`);\n"
     "      else if (claimed.has(key)) staleExceptions.push(`${surface} ${key}: excused but a row claims it`);",
     "      void key;"),
    ('S33-vacuous-declared-absent-root', ROSTER, GATE, 'proves nothing',
     "    if (!(vendorRoots ?? new Set()).has(root)) {\n"
     "      failures.push(`${root} is declared absent but the vendor's own answer carries nothing under it, so this row proves nothing`);\n"
     "    }",
     "    void vendorRoots;"),
    # --- round 4 ---
    # S41: Chat's `stopReason` goes back to being free. Both round-4 seats built
    # this: one fixture field, `finish_reason: "length"` against a capture that
    # says `"stop"`, and the whole suite green.
    ('S41-chat-stop-reason-unbound', ROSTER, GATE, 'stop reason that contradicts its capture',
     "    ['stopReason', (body) => (body.choices ?? []).map((choice) => choice?.finish_reason ?? null),",
     "    ['stopReason-unbound', (body) => (body.choices ?? []).map((choice) => choice?.finish_reason ?? null),"),
    # S42: the Responses half of S41, where the same one-field answer
    # compensated for an inverted `responseCutOff`.
    ('S42-responses-stop-reason-unbound', ROSTER, GATE, 'stop reason that contradicts its capture',
     "    ['stopReason', (body) => ({\n      status: body.status,",
     "    ['stopReason-unbound', (body) => ({\n      status: body.status,"),
    # S43: the Chat binding reads the first choice instead of every one, so a
    # fan-out could move the others unseen.
    ('S43-fan-out-reads-one-choice', ROSTER, GATE, 'fan-out answers every choice',
     "      (answer, request) => Array.from({ length: request.n ?? 1 }, () => chatFinishReason(answer))],",
     "      (answer) => [chatFinishReason(answer)]],"),
    # S44: `undefined` is read as absence again, which lets a fixture blank a
    # BOUND field back to unchecked.
    ('S44-undefined-blanks-a-binding', ROSTER, GATE, 'explicit undefined does not blank',
     "      if (!present.has(field)) continue;",
     "      if (read(answer, field) === undefined) continue;"),
    # S45: the messages derivation goes raw, so `undefined` no longer means the
    # `end_turn` the wire actually carries.
    ('S45-anthropic-stop-reason-raw', ROSTER, GATE, 'explicit undefined does not blank',
     "    ['stopReason', (body) => body.stop_reason,\n      (answer, request) => anthropicStopReason(withStopSequences(answer, request))],",
     "    ['stopReason', (body) => body.stop_reason],"),
    # S46: a gap list grows a path the missing item cannot explain — the shape a
    # dropped `billing` field took when a review reclassified it as a reasoning
    # gap. The premise stays true; the list is what has to be checked.
    ('S46-gap-list-grows-an-unrelated-path', ROSTER, GATE, 'direct-responses-tools-parallel-false',
     "  '.output[]{-.summary:array}',\n];",
     "  '.output[]{-.summary:array}',\n  '.billing:object',\n  '.billing.payer:string',\n];"),
    # S47: the derivation credits the whole body rather than what the missing
    # item explains.
    ('S47-gap-derivation-credits-everything', ROSTER, GATE, 'does not follow from the missing item',
     "  const ours = keyPaths({ ...vendor, [key]: kept });",
     "  const ours = new Map();"),
    # S48: the required-effect map is emptied, so deleting a row's `alsoCompare`
    # again deletes the only witness `n` has.
    # S55: the effect rule goes back to asking `supplied` instead of the request,
    # which puts it one door up from where it was aimed: the row that stops
    # claiming `n` also stops owing `.choices[]#`, and both are one edit.
    ('S55-effect-rule-asks-the-claim', ROSTER, GATE, 'stops claiming the option still owes its effect',
     "    const options = requestKeysOf ? requestKeysOf(fixture) : (supplied ?? []);",
     "    const options = supplied ?? [];"),
    ('S48-required-effects-emptied', ROSTER, GATE, 'deleting the only effect path fails',
     "export const REQUIRED_EFFECTS = {\n  '/v1/chat/completions': {",
     "export const REQUIRED_EFFECTS = {\n  '/v1/chat/completions-disabled': {"),
    # S49: the rule reads the map but never fails -- the loop finds the missing
    # comparison and walks past it, so the map is consulted and nothing it says
    # can make a row red.
    ('S49-required-effects-never-fails', ROSTER, GATE, 'deleting the only effect path fails',
     "          failures.push(`${fixture} ${option}: nothing compares ${path}, which is the only way this option shows`);",
     "          continue;"),
    # S51: the unchecked-input scan goes back to reading the row's `answer`
    # instead of what the proxy is handed. `id`, `toolCalls` and `latencyMs` are
    # constants `servedResult` invents; a scan of `answer` cannot reach them, and
    # the table read as an audit of every input while auditing one object inside
    # them.
    ('S51-scan-reads-the-row-not-the-turn', ROSTER, GATE, 'a constant the backend invents',
     "    for (const field of new Set([...leafPaths(answer), ...leafPaths(served)])) {",
     "    for (const field of leafPaths(answer)) {"),
    # S54: the cache-write number leaves the default answer, which is the state
    # a review found: two bindings in the table, present in review and absent
    # from every run, both rewritten to return a string no vendor sends with the
    # whole suite green.
    ('S54-a-binding-nothing-runs', ROSTER, GATE, 'every binding is run by some row',
     "    cacheCreationInputTokens: 0,\n    reasoningOutputTokens: 0,",
     "    reasoningOutputTokens: 0,"),
    # S61: the messages stop-reason oracle goes back to reading the raw answer,
    # so a row declaring `max_tokens` with a sequence-hitting text is certified
    # while the wire says `stop_sequence`.
    ('S61-stop-sequence-rewrite-not-derived', ROSTER, GATE, 'stop sequence the text runs into',
     "      (answer, request) => anthropicStopReason(withStopSequences(answer, request))],",
     "      (answer) => anthropicStopReason(answer)],"),
    # S62: the rewrite applies even when the turn made tool calls, which is not
    # the proxy's rule.
    ('S62-stop-sequence-ignores-tool-calls', ROSTER, GATE, 'made tool calls keeps its reason',
     "  if ((answer.toolCalls ?? []).length > 0) {\n"
     "    return { branch: 'match-with-tool-calls', value: { ...answer, text: cutText } };\n  }",
     "  if (false) {\n"
     "    return { branch: 'match-with-tool-calls', value: { ...answer, text: cutText } };\n  }"),
    # S63: the cut-off projection stops at the top-level triple again, leaving
    # the item statuses `responseCutOff` also drives out of the envelope.
    ('S63-cutoff-projection-drops-the-items', ROSTER, GATE, 'cut off mid tool call',
     "      callStatuses: (body.output ?? []).filter((item) => item?.type === 'function_call')\n        .map((item) => item?.status ?? null),",
     "      callStatuses: [],"),
    # S64: a free reason nothing reads is accepted again.
    ('S64-unread-free-reason-accepted', ROSTER, GATE, 'every free reason is read by some row',
     "  stopSequence: undefined,",
     ""),
    # S57: the product drops its answer item for one request — the defect a review
    # exempted by editing the row's premise, and the reason the item sequence is
    # checked against the HARNESS's table rather than against a row field.
    #
    # A PRODUCT mutant, not a tautology in the assertion: no test watches a test,
    # so the first version — replacing the expected side with the actual one —
    # SURVIVED at 46/46 and could not have done anything else.
    ('S57-responses-drops-its-answer-item', SERVER, GATE, 'direct-responses-tools-parallel-false',
     "    : [\n        ...reasoning,\n        openAiResponseMessageItem(`msg_${randomUUID()}`, result.text),\n      ];",
     "    : (asRecordPayload(request.raw).parallel_tool_calls === false ? [...reasoning] : [\n"
     "        ...reasoning,\n        openAiResponseMessageItem(`msg_${randomUUID()}`, result.text),\n      ]);"),
    # S58: a surface gains a harness-missing item it does not have, which is how
    # a lost Chat choice or messages block would find an exemption to hide in.
    ('S58-chat-gains-a-harness-exemption', ROSTER, GATE, 'no harness-missing item can derive no gap',
     "  '/v1/chat/completions': [],\n  '/v1/responses': ['reasoning'],",
     "  '/v1/chat/completions': ['reasoning', null],\n  '/v1/responses': ['reasoning'],"),
    # S59: the derivation removes the FIRST item of a missing type instead of
    # every one, which cannot tell two same-typed members apart.
    ('S59-gap-derivation-removes-the-first', ROSTER, GATE, 'item sequence our turn owes comes from the harness table',
     "  return itemTypesOf(vendor, surface).filter((type) => !absent.has(type));",
     "  const seen = new Set();\n  return itemTypesOf(vendor, surface).filter((type) => {\n    if (absent.has(type) && !seen.has(type)) { seen.add(type); return false; }\n    return true;\n  });"),
    # S60: the bound VALUE is read off the row again instead of off what the
    # backend serves, so a projection can move a bound leaf unseen.
    ('S60-binding-reads-the-row-not-the-turn', ROSTER, GATE, 'changes a bound VALUE',
     "      const ours = ofAnswer ? ofAnswer(served, request) : read(served, field);",
     "      const ours = ofAnswer ? ofAnswer(answer, request) : read(answer, field);"),
    # S52: a row can mint its own excuse again — the shape round 5 walked
    # through, where narrowing `supplied` by one word and writing one true
    # sentence in the same object took a client-visible defect back to green.
    ('S52-row-mints-its-own-excuse', ROSTER, GATE, 'cannot mint its own excuse',
     "        if (!excusable[key]) {", "        if (false) {"),
    # S53: the shared excusable table stops going stale, so a key nothing sends
    # can sit there excusing rows forever.
    ('S53-probe-shaped-table-never-stale', ROSTER, GATE, 'probe-shaped key with no reason',
     "      if (!why) staleExceptions.push(`${surface} ${key}: listed as probe-shaped with no reason`);",
     "      if (false) staleExceptions.push(`${surface} ${key}: listed as probe-shaped with no reason`);"),
    # S50: a `free` entry nothing reaches. The reserve list is empty now — every
    # reason the table gives is read by some row — so the defect has the shape of
    # an entry that joins it while no answer ever carries the field, which is how
    # "not passed through on this surface" sat unread through three rounds while
    # being false on all three.
    #
    # Was a roster mutant adding `stopSequence` to one row's answer, back when
    # that was the one unread reason. `stopSequence` is BOUND now, so the same
    # edit changes nothing; re-aimed at the property instead of the instance. Its
    # pattern also still named a test that had been renamed, which is why it
    # TIMED OUT rather than scoring: no test matched, and a file whose `before`
    # hook starts a server has no test left to reach `after`.
    ('S50-free-entry-nobody-reads', ROSTER, GATE, 'every free reason is read by some row',
     "    latencyMs: 'a constant the harness invents, and no surface puts it on the wire",
     "    neverServed: 'a field no answer carries, so this sentence is never read',\n"
     "    latencyMs: 'a constant the harness invents, and no surface puts it on the wire"),
    # S65: the item reader goes back to sniffing the body. Two seats found this
    # one independently: Anthropic answers carry neither `output` nor `choices`,
    # so `/v1/messages` compared an empty list with an empty list for every body
    # that surface can produce, and a proxy that answered one turn with its text
    # block TWICE passed 2328/2328.
    ('S65-item-reader-sniffs-the-body', ROSTER, GATE, 'each surface is read where its own items live',
     "  const key = SURFACE_ITEM_KEY[surface];\n"
     "  assert.ok(key, `no item key is declared for ${surface}, so its item sequence cannot be checked`);\n"
     "  return body?.[key] ?? [];",
     "  return body?.output ?? body?.choices ?? [];"),
    # S66: the table is right for two surfaces and wrong for the third, which is
    # the state the sniff left it in. A gate that reads Messages at `output`
    # finds nothing there and owes nothing.
    ('S66-messages-items-read-elsewhere', ROSTER, GATE, 'a repeated block is not the vendor block sequence',
     "  '/v1/messages': 'content',",
     "  '/v1/messages': 'output',"),
    # S67: an unnamed surface answers "this turn owes no items" instead of
    # stopping the gate. The reader's failure mode IS the defect: an empty list
    # reads as a satisfied obligation.
    ('S67-unknown-surface-owes-nothing', ROSTER, GATE, 'a surface with no declared item key cannot be checked',
     "  assert.ok(key, `no item key is declared for ${surface}, so its item sequence cannot be checked`);\n"
     "  return body?.[key] ?? [];",
     "  return body?.[key] ?? [];"),
    # S68: binding presence goes back to the row's answer alone, so a bound field
    # the projection adds falls between the two checks — the scan skips it as
    # covered and the binding loop never reaches it.
    ('S68-presence-reads-the-row-alone', ROSTER, GATE, 'a bound field the projection adds',
     "    const present = new Set([...leafPaths(answer), ...leafPaths(served)]);",
     "    const present = new Set(leafPaths(answer));"),
    # S69: the Anthropic precedence flips, so `max_tokens` no longer beats a tool
    # call. A PRODUCT-direction mutant of the oracle: nothing reached that branch
    # until this round, and with no input it could return anything.
    ('S69-max-tokens-loses-to-tool-use', ROSTER, GATE, 'each branch control derives the value its branch owes',
     "  if (hasToolCalls && answer.stopReason !== 'max_tokens') return { branch: 'tool-use', value: 'tool_use' };",
     "  if (hasToolCalls) return { branch: 'tool-use', value: 'tool_use' };"),
    # S70: the completed half of the Responses item statuses answers `incomplete`.
    # The sibling branch was controlled in the same expression and this one was
    # not, which is the omission `bindingsReached()` reported as full coverage.
    ('S70-completed-call-reports-incomplete', ROSTER, GATE, 'each branch control derives the value its branch owes',
     "      callStatuses: calls.map(() => 'completed'),",
     "      callStatuses: calls.map(() => 'incomplete'),"),
    # S71: a branch loses its control, and the coverage report has to name it. A
    # DATA mutant: the derivation is untouched and correct, and the defect is
    # that nothing feeds one of its branches any more.
    ('S71-branch-loses-its-only-input', ROSTER, GATE, 'every branch of every derivation is reached by some input',
     "    answer: { ...DEFAULT_ANSWER, stopReason: 'max_tokens', toolCalls: [TOOL_CALL] },\n"
     "    request: {},\n"
     "    // The cap wins over the tool call. Predicting `tool_use` here is the\n"
     "    // known-opposite, and it is what the binding said for every turn until this\n"
     "    // branch was named.\n"
     "    expect: 'max_tokens',",
     "    answer: { ...DEFAULT_ANSWER, toolCalls: [TOOL_CALL] },\n"
     "    request: {},\n"
     "    expect: 'tool_use',"),
    # S72: a branch the code takes that the table does not name. Dropping it from
    # the declaration makes the coverage report count it nowhere — it must be
    # reported as undeclared rather than pass unnoticed.
    ('S72-branch-not-declared', ROSTER, GATE, 'every branch of every derivation is reached by some input',
     "    anthropicStop: ['tool-use', 'max-tokens-over-tool-use', 'passthrough', 'default-end-turn'],",
     "    anthropicStop: ['tool-use', 'passthrough', 'default-end-turn'],"),
    # S73: the CLIENT-VISIBLE form of what S65 and S66 revert, and the reason
    # they are worth reverting. The proxy answers one `/v1/messages` turn with
    # its text block twice — the client receives the answer doubled — and the
    # whole suite used to stay green: the indexed value comparisons read the
    # unchanged FIRST block, the shape reader collapses arrays so cardinality is
    # invisible there too, and the item-sequence rule was comparing `[]` with
    # `[]` on that surface. Scoped to one turn on purpose: an unconditional
    # doubling is caught by tests that have nothing to do with this gate, and a
    # mutant scored by a neighbour proves nothing about the rule it was aimed at.
    ('S73-messages-answers-its-block-twice', SERVER, GATE, 'direct-messages-stop-sequence-hit',
     "    : result.text\n    ? [{ type: 'text', text: result.text }]\n    : [];",
     "    : result.text\n    ? (result.text === 'AA'\n"
     "      ? [{ type: 'text', text: result.text }, { type: 'text', text: result.text }]\n"
     "      : [{ type: 'text', text: result.text }])\n    : [];"),
]


def empty_absent_paths(text):
    data = json.loads(text)
    for entry in data['divergences']:
        if entry.get('claim') == 'supplied-echo':
            entry['absentPaths'] = []
    return json.dumps(data, ensure_ascii=False, indent=2) + '\n'


def loosen_value_divergence(text):
    data = json.loads(text)
    for entry in data['divergences']:
        for divergence in entry.get('valueDivergences', []):
            divergence['proxy'] = '"whatever"'
    return json.dumps(data, ensure_ascii=False, indent=2) + '\n'


def plant_false_divergence(text):
    data = json.loads(text)
    data['divergences'].append({
        'id': 'planted-false-divergence',
        'surface': '/v1/responses',
        'claim': 'supplied-echo',
        'valueDivergences': [{'path': '.reasoning.summary', 'vendor': '"nonsense"', 'proxy': '"also-nonsense"'}],
        'behavior': 'planted by the mutation runner', 'why': 'planted', 'measuredAt': '2026-09-10', 'evidence': 'none',
    })
    return json.dumps(data, ensure_ascii=False, indent=2) + '\n'


def plant_coercible_divergence(text):
    data = json.loads(text)
    data['divergences'].append({
        'id': 'planted-coercible-divergence',
        'surface': '/v1/responses',
        'claim': 'supplied-echo',
        'valueDivergences': [{'path': '.reasoning.summary', 'vendor': ['"detailed"'], 'proxy': ['"auto"']}],
        'behavior': 'planted by the mutation runner', 'why': 'planted', 'measuredAt': '2026-09-10', 'evidence': 'none',
    })
    return json.dumps(data, ensure_ascii=False, indent=2) + '\n'


def drop_wire_capture_row(text):
    import re
    # R-37 cites this capture and carries the WIRE grade.
    out = re.sub(r"\n  \{ fixture: 'direct-responses-service-tier-flex'.*?\},", '', text, flags=re.S)
    assert out != text, 'the row this mutant removes is not in the roster'
    return out


def delete_logprobs_row(text):
    import re
    return re.sub(r"\n  \{ fixture: 'direct-chat-logprobs-effort-none'.*?\},", '', text, flags=re.S)


def plant_bare_wire(text):
    data = json.loads(text)
    for claim in data['claims']:
        if claim['evidenceGrade'] == 'DOC':
            claim['evidenceGrade'] = 'WIRE'
            claim['evidenceNote'] = 'WIRE'
            break
    return json.dumps(data, indent=2) + '\n'


def tamper_body(text):
    data = json.loads(text)
    data['body'] = data['body'].replace('"flex"', '"default"', 1)
    return json.dumps(data, indent=2) + '\n'


run_mutation_suite(
    root=ROOT,
    log=LOG,
    prefix='se',
    subject=['src', 'test', 'spec', 'scripts', 'tsconfig.json', 'package.json', 'pnpm-lock.yaml'],
    files={SERVER, NORMALIZERS, DIVERGENCES, FIXTURE, MANIFEST, GATE, ROSTER, COMPARISON},
    baseline=[GATE, MANIFEST_GATE],
    mutants=MUTANTS,
    specials={
        'EMPTY_ABSENT_PATHS': empty_absent_paths,
        'LOOSEN_VALUE_DIVERGENCE': loosen_value_divergence,
        'TAMPER_BODY': tamper_body,
        'PLANT_FALSE_DIVERGENCE': plant_false_divergence,
        'DELETE_LOGPROBS_ROW': delete_logprobs_row,
        'PLANT_BARE_WIRE': plant_bare_wire,
        'PLANT_COERCIBLE_DIVERGENCE': plant_coercible_divergence,
        'DROP_WIRE_CAPTURE_ROW': drop_wire_capture_row,
    },
    runner_file=__file__,
)
