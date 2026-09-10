import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { keyPaths } from '../scripts/lib/response-comparison.mjs';

// The captures the conformance gates replay, and what each row claims.
//
// The rosters live here, outside both gate files, because a third check needs
// to know which fixtures are actually replayed: the matrix's `WIRE` grade means
// "the provider's own value, read from a promoted capture that a gate replays",
// and the first version of that check searched the gate files' TEXT for the
// fixture's name. A name in a comment satisfied it, and so did a name left
// behind after its row was deleted — the review that planted exactly that
// deletion is why this file exists. Importing the array the gate iterates makes
// participation the thing being read.
//
// A gate file cannot be imported for this: loading it would register its tests
// a second time and start a second server.

// Everything the vendor's turn shows that ours cannot, all of it one fact: the
// fake backend behind this gate emits no reasoning item, so the vendor's output
// array holds two items where ours holds one. Two of the reasoning item's own
// members never appear, and every place the vendor's two items disagree is a
// disagreement an array of one cannot have.
//
// They are listed exactly as the reader emits them because an exemption covers
// itself and nothing else — unlike a declaration, which owns what is beneath
// it. And they are honoured only after the row's `harnessPremise` is checked
// against both turns, so they cannot outlive the situation they describe.
/**
 * The paths a declared harness gap is ALLOWED to name, derived from the capture
 * rather than listed.
 *
 * `harnessPremise` says which output items our turn lacks. That premise was
 * checked and the LIST was not, so once the two type arrays matched, any path at
 * all could ride in the list beside them: a review made the proxy drop `billing`
 * from a Responses answer — a client-visible field loss, red at 115/116 — and
 * turned it green by appending `.billing:object` and `.billing.payer:string` to
 * this row's gaps. The premise was still true. It just never had anything to do
 * with `billing`.
 *
 * So the gap set is now COMPUTED: remove from the vendor's own body exactly the
 * items the premise says we lack, and the paths that disappear are the gaps.
 * Nothing else can be one.
 */
export function harnessGapsFrom(vendor, premise) {
  const key = vendor?.output ? 'output' : 'choices';
  const missing = [...(premise?.vendor ?? [])];
  for (const type of premise?.ours ?? []) {
    const at = missing.indexOf(type);
    if (at !== -1) missing.splice(at, 1);
  }
  const kept = [];
  for (const item of vendor?.[key] ?? []) {
    const at = missing.indexOf(item?.type ?? null);
    if (at !== -1) {
      missing.splice(at, 1);
      continue;
    }
    kept.push(item);
  }
  const theirs = keyPaths(vendor);
  const ours = keyPaths({ ...vendor, [key]: kept });
  return [...theirs.keys()].filter((path) => !ours.has(path)).sort();
}

// Written out as well as derived: a reader of the roster should be able to see
// what the row is exempting without running anything. The gate asserts the two
// agree, so this list cannot drift or grow.
const HARNESS_GAPS_NO_REASONING_ITEM = [
  '.output[].encrypted_content:string',
  '.output[].summary:array',
  '.output[]{-.content[].annotations:array}',
  '.output[]{-.content[].logprobs:array}',
  '.output[]{-.content[].text:string}',
  '.output[]{-.content[].type:string}',
  '.output[]{-.content[]:object}',
  '.output[]{-.encrypted_content:string}',
  '.output[]{-.phase:string}',
  '.output[]{-.role:string}',
  '.output[]{-.status:string}',
  '.output[]{-.summary:array}',
];

// Each row is a claim about one option.
//
//   supplied     the options the request carries. Asserted present in the
//                request bytes, so a row cannot claim something the capture is
//                not evidence about.
//   echoed       whether the surface echoes them back AT ALL. Chat echoes
//                almost nothing — `n`, `logprobs` and `response_format` never
//                appear in its answer — and that is a fact worth failing on if
//                it changes, so `false` is a claim here and not a skip.
//   alsoCompare  leaf paths this row claims that are not echoes. `n` is not
//                echoed; the number of choices it produces is what a client
//                actually receives.
//   harnessGaps  paths the vendor's turn has and ours cannot: our side runs on
//                a fake backend whose turn contains no reasoning item. That is
//                a property of this test, not of the proxy, and it is written
//                per row so it cannot quietly cover a real gap.
//   vendorPaths  how much shape the comparison actually reads. The vendor side
//                is frozen, so this number only moves when the fixture does.
/**
 * What the backend behind the replay answers, when a row does not say otherwise.
 *
 * `text: 'OK'` and no cache numbers is what both gates hardcoded, separately, in
 * two copies of the same closure.
 */
export const DEFAULT_ANSWER = {
  text: 'OK',
  // How the turn ENDED, not only what it said. A vendor turn that ran out of
  // tokens reports `max_tokens`; a fake result with no `stopReason` derives
  // `end_turn`, so a row comparing stop reasons was comparing a stopped turn
  // against a finished one and calling the difference the proxy's. Left
  // undefined here because "the turn simply ended" is what most rows replay.
  stopReason: undefined,
  usage: { inputTokens: 7, outputTokens: 1, totalTokens: 8, cachedInputTokens: 0, reasoningOutputTokens: 0, source: 'provider' },
};

/**
 * The fake backend both live gates run behind, answerable per row.
 *
 * A row's shape is not always a function of the OPTION it supplies. A vendor
 * turn that hit `max_tokens` before writing anything has an empty `content`; a
 * turn whose text ran into a `stop_sequence` reports which one; a turn served
 * from cache reports what it read. None of those can be replayed by a backend
 * that says `OK` to everything, and the rows that need them sat unpromoted for
 * exactly that reason — read as "the proxy differs" when what differed was the
 * answer it had been given.
 *
 * The vendor side stays frozen. What this changes is our own side's INPUT, which
 * is a fixture choice like the request bytes are, and it is declared in the same
 * registry the rows live in so a row and its answer cannot come apart.
 */
/**
 * What the backend actually SERVES for a row: its own answer over the default.
 *
 * Exported, and the one place the merge is written, because the premise check
 * has to read exactly what the backend will hand the proxy. It read `row.answer`
 * instead — the row's DECLARED half — and `DEFAULT_ANSWER` was bound to no
 * capture anywhere, so moving a compensating value one scope outward defeated
 * the whole check: with `cachedInputTokens: 1` in the default and the
 * cache-read defect installed, both gates went green at 122/122.
 *
 * That is the third round in a row where a fixture compensated for a real
 * defect. The first two closed the field in front of them; what they had in
 * common is that they validated the DECLARED input and the proxy is served the
 * MERGED one.
 */
export function servedAnswer(rowAnswer) {
  return {
    ...DEFAULT_ANSWER,
    ...(rowAnswer ?? {}),
    usage: { ...DEFAULT_ANSWER.usage, ...(rowAnswer?.usage ?? {}) },
  };
}

/**
 * Everything the harness hands the proxy for one turn.
 *
 * Written HERE and returned by `generate()` below, so the unchecked-input scan
 * can run over what the proxy actually receives. It used to run over the row's
 * `answer` instead, which made the table read as an audit of the harness's
 * inputs while auditing one object inside them: `id`, `toolCalls` and
 * `latencyMs` are constants this function invents, neither derived from the
 * capture nor checked against it, and the scan could not see them because they
 * are not members of `answer`.
 *
 * `stopReason` is deliberately OMITTED when the answer leaves it undefined —
 * that is what makes the proxy derive `end_turn` — while the answer keeps it as
 * an own key, because there "undefined" is the CLAIM that the turn simply
 * ended. The two objects therefore answer two different questions, and the
 * premise check asks each of them the one it can answer: bindings off the
 * answer, unchecked inputs off the result.
 */
export function servedResult(answer, request) {
  return {
    id: 'local_test',
    model: request?.model,
    text: answer.text,
    toolCalls: [],
    usage: answer.usage,
    latencyMs: 1,
    ...(answer.stopReason === undefined ? {} : { stopReason: answer.stopReason }),
  };
}

export function createReplayBackend() {
  let answer = DEFAULT_ANSWER;
  return {
    /** Answer the next replayed request this way. Called before each fetch. */
    answerWith(next) {
      answer = servedAnswer(next);
    },
    backend: {
      name: 'fake-backend',
      model: 'fake-local-model',
      async generate(request) {
        return servedResult(answer, request);
      },
      async close() {},
    },
  };
}

/**
 * Why fourteen Chat rows carry `reasoning_effort` and claim nothing about it.
 *
 * The probes set it to `none` so the turn does not reason — a capture costs a
 * few tokens and comes back the same way twice. It is how the request was
 * TAKEN, not what any of those rows is about; `direct-chat-reasoning-effort-none`
 * is the row that is about it. Written out per row rather than excused for the
 * whole surface, because a surface-level excuse is what let a row stop claiming
 * an option while another row kept the key alive — dropping a claim has to be a
 * visible edit, not a deletion.
 */
const PROBE_SHAPING_EFFORT = 'set to `none` so the probe turn does not reason; '
  + '`direct-chat-reasoning-effort-none` is the row that claims this option';

export const SUPPLIED_ECHO_CAPTURES = [
  { fixture: 'direct-responses-service-tier-flex', surface: '/v1/responses', supplied: ['service_tier'], echoed: true, vendorPaths: 76 },
  { fixture: 'direct-responses-store-false', surface: '/v1/responses', supplied: ['store'], echoed: true, vendorPaths: 76 },
  { fixture: 'direct-responses-metadata', surface: '/v1/responses', supplied: ['metadata'], echoed: true, vendorPaths: 77 },
  { fixture: 'direct-responses-reasoning-summary-auto', surface: '/v1/responses', supplied: ['reasoning'], echoed: true, vendorPaths: 76 },
  {
    fixture: 'direct-responses-tools-parallel-false',
    surface: '/v1/responses',
    supplied: ['tools', 'parallel_tool_calls'],
    echoed: true,
    // The vendor's turn reasoned and ours does not: the fake backend emits no
    // reasoning item at all, so two of that item's members never appear and
    // the vendor's two output items disagree where an array of one message
    // item cannot. What a real backend's reasoning item would carry is matrix
    // R-25's claim, not this row's.
    //
    // The premise is asserted before any of these are honoured. A review gave
    // our side a reasoning item of its own, which left every exemption below
    // covering a disagreement that was no longer about a missing member.
    harnessPremise: { vendor: ['reasoning', 'message'], ours: ['message'] },
    harnessGaps: HARNESS_GAPS_NO_REASONING_ITEM,
    vendorPaths: 99,
  },
  { fixture: 'direct-responses-top-logprobs-effort-none', surface: '/v1/responses', supplied: ['top_logprobs', 'reasoning'], echoed: true, vendorPaths: 76 },
  { fixture: 'direct-chat-service-tier-flex', surface: '/v1/chat/completions', supplied: ['service_tier'], echoed: true, vendorPaths: 28, unclaimed: ['reasoning_effort'] },
  { fixture: 'direct-chat-response-format-json-object', surface: '/v1/chat/completions', supplied: ['response_format'], echoed: false, vendorPaths: 28, unclaimed: ['reasoning_effort'] },
  {
    fixture: 'direct-chat-n-2',
    unclaimed: ['reasoning_effort'],
    surface: '/v1/chat/completions',
    supplied: ['n'],
    echoed: false,
    // Not echoed, but not invisible either: two choices are what the client
    // gets, and the fan-out that produces them is where this proxy has had a
    // real defect before (the shared prompt counted twice).
    alsoCompare: ['.choices[]#'],
    vendorPaths: 28,
  },
  { fixture: 'direct-chat-logprobs-effort-none', surface: '/v1/chat/completions', supplied: ['logprobs', 'reasoning_effort'], echoed: false, vendorPaths: 37 },

  // The rest of the direct store's 200/json exchanges that a gate can replay.
  // Each was read against the live proxy before it was promoted, so a status
  // divergence or an undeclared shape gap would have been a finding rather than
  // a red row: `review-artifacts/stage3/recon-unpromoted.mjs` is that reading.
  //
  // `reasoning_effort` appears in `supplied` only where it is what makes the
  // vendor accept the option at all — the penalties, tools and functions, which
  // this model family refuses while it reasons. Elsewhere it is request
  // preamble, like the output cap, and naming it would make every row claim the
  // same thing twice.

  // /v1/responses — this surface echoes its configuration back.
  { fixture: 'direct-responses-instructions', surface: '/v1/responses', supplied: ['instructions'], echoed: true, vendorPaths: 76 },
  { fixture: 'direct-responses-max-tool-calls', surface: '/v1/responses', supplied: ['max_tool_calls'], echoed: true, vendorPaths: 76 },
  { fixture: 'direct-responses-text-verbosity', surface: '/v1/responses', supplied: ['text'], echoed: true, vendorPaths: 76 },
  { fixture: 'direct-responses-truncation-auto', surface: '/v1/responses', supplied: ['truncation'], echoed: true, vendorPaths: 76 },
  { fixture: 'direct-responses-user', surface: '/v1/responses', supplied: ['user'], echoed: true, vendorPaths: 76 },
  { fixture: 'direct-responses-safety-identifier', surface: '/v1/responses', supplied: ['safety_identifier'], echoed: true, vendorPaths: 76 },
  { fixture: 'direct-responses-prompt-cache-key', surface: '/v1/responses', supplied: ['prompt_cache_key'], echoed: true, vendorPaths: 76 },
  // Its echo carries members the other Responses answers do not, which is why
  // this row's shape count is not 76.
  { fixture: 'direct-responses-prompt-cache-options', surface: '/v1/responses', supplied: ['prompt_cache_options'], echoed: true, vendorPaths: 79 },
  // `flex` is already replayed; these two hold the other branches of the
  // resolver R-37 describes — `default` here, and everything that is not a
  // named tier collapsing to it.
  { fixture: 'direct-responses-service-tier-default', surface: '/v1/responses', supplied: ['service_tier'], echoed: true, vendorPaths: 76 },
  // Accepted and NOT echoed, both of them: the vendor takes the option and its
  // answer says nothing about it, so a client cannot read back what it asked.
  { fixture: 'direct-responses-include-encrypted-content', surface: '/v1/responses', supplied: ['include'], echoed: false, vendorPaths: 76 },
  { fixture: 'direct-responses-context-management', surface: '/v1/responses', supplied: ['context_management'], echoed: false, vendorPaths: 76 },
  // Two options at once, and only one of them comes back — which is the claim.
  // Two options, and the surface treats them differently: `store` comes back,
  // `include` produces no key at all (R-25). One boolean could only claim both,
  // and claiming `include` was echoed passed for years on `store`'s leaf alone.
  { fixture: 'direct-responses-store-false-include-encrypted', surface: '/v1/responses', supplied: ['include', 'store'], echoed: { include: false, store: true }, vendorPaths: 76 },

  // /v1/chat/completions — this surface echoes almost nothing, and each row
  // below says so about one more option. `service_tier` is the exception.
  {
    // The one option this surface accepts and answers with a whole FEATURE:
    // the direct API attaches 127 paths of moderation verdicts. This proxy
    // moderates nothing and emits no `moderation` key, which is declared
    // (`chat-moderation-results-are-not-reported`) rather than described —
    // matrix row 49 had carried it in prose since 2026-08-30, so a build that
    // started emitting a block would have agreed with a paragraph.
    //
    // `declaredAbsent` is the row's third state, and this capture is why it
    // exists: `echoed: true` wants a compared leaf and `echoed: false` wants no
    // echoed path, and a root the vendor fills 127 times while we report none
    // of it satisfies neither.
    fixture: 'direct-chat-moderation-model',
    surface: '/v1/chat/completions',
    supplied: ['reasoning_effort'],
    echoed: false,
    declaredAbsent: ['moderation'],
    vendorPaths: 155,
  },
  { fixture: 'direct-chat-service-tier-default', surface: '/v1/chat/completions', supplied: ['service_tier'], echoed: true, vendorPaths: 28, unclaimed: ['reasoning_effort'] },
  { fixture: 'direct-chat-service-tier-priority', surface: '/v1/chat/completions', supplied: ['service_tier'], echoed: true, vendorPaths: 28, unclaimed: ['reasoning_effort'] },
  { fixture: 'direct-chat-reasoning-effort-none', surface: '/v1/chat/completions', supplied: ['reasoning_effort'], echoed: false, vendorPaths: 28 },
  { fixture: 'direct-chat-seed', surface: '/v1/chat/completions', supplied: ['seed'], echoed: false, vendorPaths: 28, unclaimed: ['reasoning_effort'] },
  { fixture: 'direct-chat-store-true', surface: '/v1/chat/completions', supplied: ['store'], echoed: false, vendorPaths: 28, unclaimed: ['reasoning_effort'] },
  { fixture: 'direct-chat-metadata-user-safety-identifier', surface: '/v1/chat/completions', supplied: ['metadata', 'user', 'safety_identifier'], echoed: false, vendorPaths: 28, unclaimed: ['reasoning_effort'] },
  { fixture: 'direct-chat-prompt-cache-key-options', surface: '/v1/chat/completions', supplied: ['prompt_cache_key', 'prompt_cache_options'], echoed: false, vendorPaths: 28, unclaimed: ['reasoning_effort'] },
  { fixture: 'direct-chat-prompt-cache-retention', surface: '/v1/chat/completions', supplied: ['prompt_cache_retention'], echoed: false, vendorPaths: 28, unclaimed: ['reasoning_effort'] },
  { fixture: 'direct-chat-verbosity', surface: '/v1/chat/completions', supplied: ['verbosity'], echoed: false, vendorPaths: 28, unclaimed: ['reasoning_effort'] },
  { fixture: 'direct-chat-tools', surface: '/v1/chat/completions', supplied: ['tools', 'reasoning_effort'], echoed: false, vendorPaths: 28 },
  { fixture: 'direct-chat-parallel-tool-calls-false', surface: '/v1/chat/completions', supplied: ['tools', 'parallel_tool_calls', 'reasoning_effort'], echoed: false, vendorPaths: 28 },
  { fixture: 'direct-chat-functions-function-call', surface: '/v1/chat/completions', supplied: ['functions', 'function_call', 'reasoning_effort'], echoed: false, vendorPaths: 28 },
  { fixture: 'direct-chat-frequency-penalty', surface: '/v1/chat/completions', supplied: ['frequency_penalty', 'reasoning_effort'], echoed: false, vendorPaths: 28 },
  { fixture: 'direct-chat-presence-penalty', surface: '/v1/chat/completions', supplied: ['presence_penalty', 'reasoning_effort'], echoed: false, vendorPaths: 28 },
  // These three name `messages` because that is the option the request varies:
  // a user turn carrying `name`, a user turn carrying a member the schema does
  // not define, and an assistant turn carrying `refusal` and no content. The
  // claim they carry is the STATUS — the vendor answers 200 to each, and so
  // must this proxy — with the echo half saying that neither side reports the
  // messages back.
  { fixture: 'direct-chat-message-name', surface: '/v1/chat/completions', supplied: ['messages'], echoed: false, vendorPaths: 28, unclaimed: ['reasoning_effort'] },
  { fixture: 'direct-chat-message-unknown-member', surface: '/v1/chat/completions', supplied: ['messages'], echoed: false, vendorPaths: 28, unclaimed: ['reasoning_effort'] },
  { fixture: 'direct-chat-message-refusal', surface: '/v1/chat/completions', supplied: ['messages'], echoed: false, vendorPaths: 28, unclaimed: ['reasoning_effort'] },
  // Six turns whose shape is a function of what the VENDOR generated rather than
  // of the option supplied, each answered here the way its own turn went. A
  // backend that says `OK` to everything cannot produce an empty `content`, a
  // `stop_sequence` that was actually hit, or cache numbers — and reading that
  // as "the proxy differs" reads the answer we supplied as a fact about the
  // proxy. The vendor side stays frozen; this is our own side's input.
  // Each of these claims ITS OWN option, not the mandatory request fields that
  // ride along with it. The first version listed `max_tokens`, `messages` and
  // `model` beside the option and set `echoed: true`, which passed because
  // `model` comes back — one echoing root satisfying a row that claimed four.
  // Two independent reviews reached that from different directions on the same
  // day. What each row compares now is the option's own observable EFFECT.
  {
    fixture: 'direct-messages-metadata-user-id',
    surface: '/v1/messages',
    supplied: ['metadata'],
    // Neither side sends it back. That is the claim: A-27 says the proxy
    // validates `metadata.user_id` and does not apply it, and the vendor's own
    // answer carries no `metadata` key either.
    echoed: false,
    vendorPaths: 20,
    answer: { text: '', stopReason: 'max_tokens', usage: { cacheCreationInputTokens: 0, cacheReadInputTokens: 0 } },
  },
  {
    fixture: 'direct-messages-service-tier-standard-only',
    surface: '/v1/messages',
    supplied: ['service_tier'],
    // Not echoed at the top level by either side. Where the vendor DOES report
    // the tier — `usage.service_tier` — is declared absent for this proxy, so
    // the shape half of this row is what carries that claim.
    echoed: false,
    vendorPaths: 20,
    answer: { text: '', stopReason: 'max_tokens', usage: { cacheCreationInputTokens: 0, cacheReadInputTokens: 0 } },
  },
  {
    fixture: 'direct-messages-inference-geo-us',
    surface: '/v1/messages',
    supplied: ['inference_geo'],
    echoed: false,
    vendorPaths: 20,
    answer: { text: '', stopReason: 'max_tokens', usage: { cacheCreationInputTokens: 0, cacheReadInputTokens: 0 } },
  },
  {
    fixture: 'direct-messages-stop-sequences-empty',
    surface: '/v1/messages',
    supplied: ['stop_sequences'],
    echoed: false,
    // An empty list cannot fire, so the turn runs to the token limit instead.
    // Both halves are the claim: the reason it stopped, and that no sequence is
    // named.
    alsoCompare: ['.stop_reason', '.stop_sequence'],
    vendorPaths: 20,
    answer: { text: '', stopReason: 'max_tokens', usage: { cacheCreationInputTokens: 0, cacheReadInputTokens: 0 } },
  },
  {
    // The vendor's own text ran into `ZZ`. Ours is given text that contains one
    // too, and what this row compares is what the PROXY then did with it: the
    // text cut before the sequence, the reason, and which sequence was matched.
    // Removing the buffered truncation leaves `AAZZtail` on the wire, and until
    // these three paths were compared this gate stayed green through it.
    fixture: 'direct-messages-stop-sequence-hit',
    surface: '/v1/messages',
    supplied: ['stop_sequences'],
    echoed: false,
    alsoCompare: ['.stop_reason', '.stop_sequence', '.content[0].text', '.content[0].type'],
    vendorPaths: 23,
    answer: { text: 'AAZZtail', stopReason: 'stop_sequence', usage: { cacheCreationInputTokens: 0, cacheReadInputTokens: 0 } },
  },
  {
    fixture: 'direct-messages-stop-sequence-hit-p8',
    surface: '/v1/messages',
    supplied: ['stop_sequences'],
    echoed: false,
    alsoCompare: ['.stop_reason', '.stop_sequence', '.content[0].text', '.content[0].type'],
    vendorPaths: 23,
    answer: { text: 'AAZZtail', stopReason: 'stop_sequence', usage: { cacheCreationInputTokens: 0, cacheReadInputTokens: 0 } },
  },
];

// The two denominators, pinned rather than bounded. `echoedDefaults` counts the
// leaf values the vendor CHOSE for a field the request never mentioned;
// `suppliedEchoes` counts the ones it echoed back from the request. They are
// counted apart because the probe has to supply an output cap to bound its
// cost, and counting that cap among the defaults is how the gate came to claim
// a property it never exercised. A pinned count fails when it silently drops by
// one, which a `>= 1` would not.
export const MINIMAL_SURFACES = [
  {
    surface: '/v1/responses',
    fixture: 'direct-responses-minimal',
    requestKeys: ['model', 'input', 'max_output_tokens'],
    echoedDefaults: 34,
    // `model` and `max_output_tokens` — the two the request named.
    suppliedEchoes: 2,
  },
  {
    surface: '/v1/chat/completions',
    fixture: 'direct-chat-minimal',
    requestKeys: ['model', 'messages', 'max_completion_tokens'],
    echoedDefaults: 5,
    // `model` only: Chat does not echo its cap or its messages as configuration.
    suppliedEchoes: 1,
  },
];

// Surfaces to compare, and which capture is which side.
// `surface` is the vocabulary `spec/declared-divergences.json` uses, so the
// lookup below can actually find one. It used to read `openai.responses.stream`,
// a spelling no declaration has ever carried, which left the stale-declaration
// branch unreachable — the check could only ever take the equality path.
export const STREAM_SURFACES = [
  { surface: '/v1/responses', vendor: 'direct-responses-stream', proxy: 'proxy-responses-stream' },
  { surface: '/v1/chat/completions', vendor: 'direct-chat-stream', proxy: 'proxy-chat-stream' },
];

/**
 * Every promoted capture some gate replays, buffered and streamed alike.
 *
 * The streamed pair was missing from the first version of this registry, and
 * the check that reads it — the matrix's `WIRE` rule — went from searching gate
 * source text, which found the stream gate, to reading a registry that did not
 * know about it. A review caught the regression on the mutant written to prove
 * the rule: it claimed no gate replays `direct-chat-stream` while the stream
 * gate reads it on every run.
 */
export const REPLAYED_FIXTURES = new Set([
  ...SUPPLIED_ECHO_CAPTURES.map((row) => row.fixture),
  ...MINIMAL_SURFACES.map((row) => row.fixture),
  ...STREAM_SURFACES.flatMap((row) => [row.vendor, row.proxy]),
]);

const captureDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'spec', 'captures');

const GROUPS = {
  supplied: { rows: SUPPLIED_ECHO_CAPTURES },
  minimal: { rows: MINIMAL_SURFACES },
};

/**
 * A recorder in front of the proxy, so what a gate replayed is MEASURED.
 *
 * A gate that records what it meant to send records nothing: the first version
 * of this hashed the capture the row names while the driver posted a different
 * one, and the mutant written for exactly that survived. What crosses this
 * server is what the proxy received, and the gate contributes no label to it —
 * the surface and the bytes are read off the request itself.
 */
// Headers that describe the hop rather than the message. `fetch` decodes and
// re-frames on its own, so passing these through would describe a transfer that
// is no longer happening.
const HOP_BY_HOP = new Set(['host', 'connection', 'keep-alive', 'transfer-encoding', 'content-length', 'content-encoding']);

export async function startReplayRecorder(targetUrl) {
  const seen = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', async () => {
      const body = Buffer.concat(chunks);
      seen.push({ surface: req.url, request: createHash('sha256').update(body).digest('hex') });
      const forwarded = Object.fromEntries(
        Object.entries(req.headers).filter(([name]) => !HOP_BY_HOP.has(name)),
      );
      const upstream = await fetch(`${targetUrl}${req.url}`, { method: req.method, headers: forwarded, body });
      // BYTES, not text. Decoding and re-encoding is not observation: reading
      // the answer as a string collapsed a run of byte-order marks the proxy had
      // actually sent, so a body the gate could not have parsed arrived parsed.
      // A review put three of them in front of a turn and the gate passed 37/37.
      const answer = Buffer.from(await upstream.arrayBuffer());
      const back = {};
      for (const [name, value] of upstream.headers) if (!HOP_BY_HOP.has(name)) back[name] = value;
      res.writeHead(upstream.status, { ...back, 'content-length': answer.length });
      res.end(answer);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    seen,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/**
 * What crossed the recorder, against what THIS module says the group replays.
 *
 * The comparison is made here and not in the gate. A review rewrote a gate's
 * own roster to replay a different capture and adjusted the gate's expectations
 * to match: every check the gate made was then about the capture it had
 * substituted, while the registry — which is what the matrix's `WIRE` rule and
 * the store sweep read — went on certifying the one nobody replayed. A gate
 * comparing against its own array cannot see that.
 *
 * What this cannot see is a gate that stops calling it, which is what the
 * mutation table and the runner's subject gate are for.
 */
export function assertRosterReplayed(group, seen) {
  const { rows } = GROUPS[group];
  assert.ok(rows, `no such replay group: ${group}`);
  const expected = rows.map((row) => {
    const capture = JSON.parse(readFileSync(join(captureDir, `${row.fixture}.json`), 'utf8'));
    const request = createHash('sha256').update(capture.request).digest('hex');
    assert.equal(capture.requestSha256, request, `${row.fixture}: its own request digest does not match its bytes`);
    return `${row.surface} ${request} (${row.fixture})`;
  });
  const measured = seen.map((call) => {
    const named = rows.find((row) => {
      const capture = JSON.parse(readFileSync(join(captureDir, `${row.fixture}.json`), 'utf8'));
      return row.surface === call.surface && capture.requestSha256 === call.request;
    });
    return `${call.surface} ${call.request} (${named?.fixture ?? 'no row in the registry sends these bytes here'})`;
  });
  assert.deepEqual(measured.sort(), expected.sort(), `${group}: what crossed the wire is not what the registry names`);
}

/**
 * Where a row's `answer` names something the vendor's own body also reports.
 *
 * A row's `answer` is our own side's INPUT, and an input can be chosen to make a
 * comparison pass. A review built exactly that: adding `cachedInputTokens: 1` to
 * six rows' answers turned a real proxy defect — dropping the runtime's explicit
 * cache-read report — from six red tests into 117 green ones. Nothing checked
 * that an answer described the turn the frozen capture recorded.
 */
/**
 * The text a turn produces after the request's own stop sequences are applied.
 *
 * Re-derived here rather than imported from the proxy: a premise check that
 * asks the code under test what the answer should be cannot catch that code
 * being wrong. Earliest match wins, ties go to the caller's array order, which
 * is the rule matrix A-17 records.
 */
function afterStopSequences(text, sequences) {
  let cut = null;
  for (const sequence of sequences ?? []) {
    if (typeof sequence !== 'string' || sequence === '') continue;
    const at = text.indexOf(sequence);
    if (at !== -1 && (cut === null || at < cut)) cut = at;
  }
  return cut === null ? text : text.slice(0, cut);
}

/**
 * How each surface turns an answer's `stopReason` into what the client reads.
 *
 * RE-DERIVED here, not imported, for the same reason `afterStopSequences` is:
 * a binding that calls the proxy's own function cannot disagree with it, and
 * disagreeing is the entire job. Both were written off the source and the
 * captures — `openAiChatFinishReason` (src/proxy/http-server.ts:1939),
 * `responseCutOff` (:2362), `anthropicStopReason` (:2249) with
 * `ANTHROPIC_PASSTHROUGH_STOP_REASONS` (:2241).
 *
 * These exist because "not passed through on this surface" was written of a
 * field that is passed through on all three, and two independent reviews walked
 * straight through the hole it left: `answer: { stopReason: 'max_tokens' }` on a
 * Chat row answered `finish_reason: "length"` against a capture that says
 * `"stop"` and passed, and the same one-field answer on a Responses row
 * compensated for an inverted `responseCutOff` so exactly that a planted,
 * client-visible defect went green.
 */
const ANTHROPIC_PASSTHROUGH_STOP_REASONS = new Set(['end_turn', 'max_tokens', 'stop_sequence', 'refusal', 'pause_turn']);

function chatFinishReason(answer) {
  if (answer.stopReason === 'max_tokens') return 'length';
  return (answer.toolCalls ?? []).length > 0 ? 'tool_calls' : 'stop';
}

function anthropicStopReason(answer) {
  const hasToolCalls = (answer.toolCalls ?? []).length > 0;
  if (hasToolCalls && answer.stopReason !== 'max_tokens') return 'tool_use';
  const reported = answer.stopReason;
  return reported && ANTHROPIC_PASSTHROUGH_STOP_REASONS.has(reported) ? reported : 'end_turn';
}

/**
 * The cache numbers, which every surface reports and every fixture can lie
 * about. `cachedInputTokens` is what the OpenAI shapes read; the Anthropic shape
 * reads the two halves separately. A surface missing from this table used to be
 * a silent exemption for an entire gate.
 */
export const ANSWER_BINDINGS = {
  '/v1/chat/completions': [
    // Per CHOICE, not just the first: a fan-out answers n of them, and a fixture
    // that could move one finish reason without the others saying so would be
    // the `n` hole in a second place.
    ['stopReason', (body) => (body.choices ?? []).map((choice) => choice?.finish_reason ?? null),
      (answer, request) => Array.from({ length: request.n ?? 1 }, () => chatFinishReason(answer))],
    ['usage.cachedInputTokens', (body) => body.usage?.prompt_tokens_details?.cached_tokens],
    ['usage.cacheCreationInputTokens', (body) => body.usage?.prompt_tokens_details?.cache_write_tokens],
  ],
  '/v1/responses': [
    // The whole cut-off envelope through the one value that drives it. Binding
    // `status` alone would leave `completed_at` and `incomplete_details` free to
    // be moved by a defect the answer then compensated for.
    ['stopReason', (body) => ({
      status: body.status,
      incompleteReason: body.incomplete_details?.reason ?? null,
      completedAtIsSet: typeof body.completed_at === 'number',
    }), (answer) => (answer.stopReason === 'max_tokens'
      ? { status: 'incomplete', incompleteReason: 'max_output_tokens', completedAtIsSet: false }
      : { status: 'completed', incompleteReason: null, completedAtIsSet: true })],
    ['usage.cachedInputTokens', (body) => body.usage?.input_tokens_details?.cached_tokens],
    ['usage.cacheCreationInputTokens', (body) => body.usage?.input_tokens_details?.cache_write_tokens],
  ],
  '/v1/messages': [
    // Through the derivation, not raw. `undefined` is not "no claim" here — it
    // is a claim that the turn simply ended, and the wire says `end_turn`.
    ['stopReason', (body) => body.stop_reason, (answer) => anthropicStopReason(answer)],
    ['usage.cacheCreationInputTokens', (body) => body.usage?.cache_creation_input_tokens],
    ['usage.cacheReadInputTokens', (body) => body.usage?.cache_read_input_tokens],
    ['usage.cachedInputTokens', (body) => (body.usage?.cache_creation_input_tokens ?? 0)
      + (body.usage?.cache_read_input_tokens ?? 0)],
    // Not the raw text — `AAZZtail` is a LEGITIMATE fixture for a turn whose
    // answer is `AA`, because the sequence is what cuts it. What must agree is
    // the text the capture's own request would leave behind. Without this a
    // compensating fixture still passed: a serializer that dropped the first
    // character of every answer stayed green once the rows said `AAAZZtail`,
    // which is the class the cache binding closed only one instance of.
    ['text', (body, request) => (body.content ?? [])
      .filter((block) => block?.type === 'text')
      .map((block) => block.text ?? '')
      .join(''), (answer, request) => afterStopSequences(answer.text ?? '', request.stop_sequences)],
  ],
};

/**
 * Every way a roster's answers contradict the captures they are replayed
 * against, plus how many fields were actually compared.
 *
 * This does not make an answer "right". It makes an answer that CONTRADICTS its
 * own capture a failure, which is the shape a compensating fixture has to take.
 * A surface with no binding table is itself a failure: skipping one silently is
 * how a premise stops being checked.
 */
/** Every leaf path of an object, dotted. `{usage: {a: 1}}` -> `['usage.a']`. */
export function leafPaths(value, prefix = '') {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return [prefix];
  const keys = Object.keys(value);
  if (keys.length === 0) return [prefix];
  return keys.flatMap((key) => leafPaths(value[key], prefix ? `${prefix}.${key}` : key));
}

/**
 * Answer fields a surface deliberately does not check, each with its reason.
 *
 * A field that is neither bound nor named here is a failure. The first version
 * hard-skipped `text` and `stopReason` inside the scan, so renaming a binding
 * left the field unchecked AND unreported — a mutant that removed the `text`
 * binding survived. An unchecked input has to be a written decision or it is a
 * hole.
 */
export const FREE_ANSWER_FIELDS = {
  '/v1/chat/completions': {
    // The three constants `servedResult` invents, and the one thing it does not
    // invent. Each was unreachable by this scan until the scan started reading
    // the object the proxy actually receives, so each reason below is new — the
    // old ones were about a field nothing had ever handed anybody.
    id: 'a constant the harness invents. The proxy mints its own id FROM it '
      + "(`chatcmpl-${id}`, `resp_${id}`, `msg_${id}`) and no capture's id is reproducible, so nothing "
      + 'compares one: `id` is in `PER_CALL` and both sides carry `.id:string` whatever it says',
    model: 'not invented — `servedResult` returns `request.model`, the capture\'s own request bytes',
    toolCalls: 'always empty here, and a non-empty one could not hide anything: it ADDS items and keys '
      + 'the vendor body does not have, which is what the shape half reports first. A row that needs '
      + 'tool calls would have to bind them',
    latencyMs: 'a constant the harness invents, and no surface puts it on the wire — `latencyMs` does '
      + 'not appear in src/proxy/http-server.ts at all',
    text: 'this surface compares echoed request options and shapes, not the answer text; '
      + 'no row on it reads the content back, so the text cannot carry a compensating value',
    stopSequence: 'not passed through on this surface: `stop_sequence` is shaped only for /v1/messages '
      + '(src/proxy/http-server.ts:2233, 3720)',
    'usage.source': "a label on where the numbers came from, absent from the vendor's shape",
    'usage.inputTokens': 'the counts a row compares are the cache ones; these are the turn\'s own size',
    'usage.outputTokens': 'as above',
    'usage.totalTokens': 'as above',
    // An earlier reason here named `harnessGaps` as the mechanism. It is not:
    // `HARNESS_GAPS_NO_REASONING_ITEM` (:32-45) holds twelve paths, every one of
    // them under `.output[]`, and none of them a usage path. Nothing declares
    // this count absent, because it is not absent — we publish it, as a hard
    // zero. The real mechanism is that no usage count is compared unless it is
    // bound here by name.
    'usage.reasoningOutputTokens': 'no usage count reaches a comparison unless it is bound above by '
      + 'name: `usage` is in `PER_CALL` so the value half skips it, no row supplies or `alsoCompare`s a '
      + 'usage path, and `reasoning_tokens: usage.reasoningOutputTokens ?? 0` '
      + '(src/proxy/http-server.ts:2286, :2306) is emitted unconditionally, so no fixture value can add '
      + 'or remove the path for the shape half either. The cache '
      + 'counters are bound for exactly that reason; this one cannot be, because our fake backend never '
      + 'reasons — claude-code-backend does not populate `reasoningOutputTokens` — while '
      + "`direct-responses-tools-parallel-false`'s vendor turn spent 9, so binding it would require a "
      + 'fixture to claim a reasoning turn it never had. What the proxy publishes here is therefore not '
      + 'evidence about the proxy; docs/design-task-unmeasured-thinking-tokens.md is where that is settled',
  },
};
FREE_ANSWER_FIELDS['/v1/responses'] = { ...FREE_ANSWER_FIELDS['/v1/chat/completions'] };
FREE_ANSWER_FIELDS['/v1/messages'] = {
  ...FREE_ANSWER_FIELDS['/v1/chat/completions'],
  // `stop_sequence` IS shaped on this surface (src/proxy/http-server.ts:2233,
  // 3720), so chat's reason would be false here. Three rows compare it directly
  // through `alsoCompare: ['.stop_sequence']`, which is what makes it free: the
  // rows that care read it off the wire, not off the answer.
  stopSequence: 'reported here as `stop_sequence`, and the three rows that depend on it compare it by '
    + 'path through `alsoCompare`, so a fixture cannot move it without one of them saying so',
};
// Bound on this surface, so not free here.
delete FREE_ANSWER_FIELDS['/v1/messages'].text;

/**
 * Options whose only observable effect is a path, and the path each one owes.
 *
 * `alsoCompare` is a row-local array, and a row-local array is a thing a defect
 * can delete. A review deleted this one: with `n: 2` answered as a single
 * choice, `direct-chat-n-2` failed on `.choices[]#` — and then passed, whole
 * suite green, once the row no longer listed the path. Nothing was left saying
 * `n` has an effect, because the only thing that said so was the row that
 * stopped saying it. Cardinality is not shape: one choice and two carry the same
 * 28 typed paths, so the shape half cannot notice either.
 *
 * So the requirement lives HERE, outside the row. A row that supplies one of
 * these options and does not compare its effect fails by name — which is the
 * same move as `unclaimedRequestOptions`, one level in: that one says an option
 * must be claimed, this one says a claim without its witness is not a claim.
 */
export const REQUIRED_EFFECTS = {
  '/v1/chat/completions': {
    // Two choices are what the client receives, and the fan-out that produces
    // them is where this proxy has had a real defect before.
    n: ['.choices[]#'],
  },
  '/v1/messages': {
    // The sequence is what cuts the text; `stop_reason` and the cut text itself
    // are the only ways a client sees that it was honoured.
    stop_sequences: ['.stop_reason', '.stop_sequence'],
  },
};

/** Every row that supplies an effect-bearing option without comparing its effect. */
export function missingRequiredEffects(rows, required = REQUIRED_EFFECTS) {
  const failures = [];
  for (const { fixture, surface, supplied, alsoCompare } of rows) {
    const table = required[surface] ?? {};
    for (const option of supplied ?? []) {
      for (const path of table[option] ?? []) {
        if (!(alsoCompare ?? []).includes(path)) {
          failures.push(`${fixture} ${option}: nothing compares ${path}, which is the only way this option shows`);
        }
      }
    }
  }
  return failures;
}

/**
 * Which `free` reasons the rosters actually reach, and which are held in reserve.
 *
 * A round found two of these reasons false and noted that five more describe
 * fields no row sets, so their reasons had never been read against anything. An
 * unreached entry is not a defect — a row that sets `model` tomorrow needs an
 * answer waiting — but an unreached entry that nobody knows is unreached is a
 * sentence with the authority of a checked one and none of the checking. So the
 * split is written down and asserted: the day a roster reaches one of these, the
 * gate says which, and its reason gets read before it counts.
 */
export function freeFieldsReached(rosters, bindings = ANSWER_BINDINGS, free = FREE_ANSWER_FIELDS) {
  const reached = new Set();
  const declared = new Set();
  for (const [surface, table] of Object.entries(free)) {
    for (const field of Object.keys(table)) declared.add(`${surface} ${field}`);
  }
  for (const rows of rosters) {
    for (const { surface, answer } of rows) {
      const covered = new Set((bindings[surface] ?? []).map(([field]) => field));
      const merged = servedAnswer(answer);
      // The same union the premise check scans; anything else would report a
      // reason as unread while the check was reading it.
      for (const field of new Set([...leafPaths(merged), ...leafPaths(servedResult(merged, {}))])) {
        if (covered.has(field)) continue;
        if (Object.prototype.hasOwnProperty.call(free[surface] ?? {}, field)) reached.add(`${surface} ${field}`);
      }
    }
  }
  return {
    reached: [...reached].sort(),
    heldInReserve: [...declared].filter((entry) => !reached.has(entry)).sort(),
  };
}

export function answerPremiseFailures(rows, bodyOf, bindings = ANSWER_BINDINGS, resultOf = servedResult) {
  const read = (answer, dotted) => dotted.split('.').reduce(
    (value, key) => (value === undefined || value === null ? undefined : value[key]),
    answer,
  );
  const failures = [];
  let checked = 0;
  for (const { fixture, surface, answer: declared } of rows) {
    // EVERY row, not only the ones that declare an answer. A row with no answer
    // is served `DEFAULT_ANSWER`, and a default nobody checks is a default
    // anybody can put a compensating value into.
    const answer = servedAnswer(declared);
    const { body: vendor, request } = bodyOf(fixture);
    const table = bindings[surface];
    if (!table) {
      failures.push(`${fixture}: ${surface} has no binding table, so its premise is unchecked`);
      continue;
    }

    // A field the answer carries that no binding covers is unchecked, and an
    // unchecked field is where the next compensating fixture goes. By LEAF, not
    // by top-level key: `{usage: {anythingAtAll: 1}}` slipped past a scan of
    // `Object.keys(answer)` because `usage` itself was covered.
    const covered = new Set(table.map(([field]) => field));
    // These reach the proxy and are compared by the rows that claim them; a
    // fixture cannot use them to contradict a capture without the comparison
    // saying so.
    const free = FREE_ANSWER_FIELDS[surface] ?? {};
    // Both objects, because they are different sets and an unchecked input in
    // either is an unchecked input. The row's `answer` is what the roster
    // WRITES — a field invented there is unchecked the day `servedResult` starts
    // spreading it. `servedResult` is what the proxy RECEIVES, and a review
    // reported that scanning the answer alone could never reach `id`,
    // `toolCalls` or `latencyMs`: constants the harness invents, neither derived
    // from the capture nor checked against it, while the table read as an audit
    // of every input the proxy is given.
    for (const field of new Set([...leafPaths(answer), ...leafPaths(resultOf(answer, request))])) {
      if (covered.has(field)) continue;
      if (Object.prototype.hasOwnProperty.call(free, field)) {
        if (!free[field]) failures.push(`${fixture}: ${field} is free with no reason given`);
        continue;
      }
      failures.push(`${fixture}: the answer sets ${field}, which no binding checks against the capture`);
    }
    const present = new Set(leafPaths(answer));
    for (const [field, ofVendor, ofAnswer] of table) {
      // Skipped only when the served answer has no such PATH. `undefined` is not
      // absence: `DEFAULT_ANSWER.stopReason` is an own key whose value is
      // undefined, and reading absence off the VALUE let a fixture blank a bound
      // field back to "no claim" — a review set one messages row's `stopReason`
      // to an explicit `undefined`, the proxy answered `end_turn` where the
      // capture says `max_tokens`, and this loop skipped the binding that exists
      // to catch exactly that.
      if (!present.has(field)) continue;
      checked += 1;
      const theirs = ofVendor(vendor, request);
      // Some fields are compared through the effect they have, not literally.
      const ours = ofAnswer ? ofAnswer(answer, request) : read(answer, field);
      if (JSON.stringify(ours) !== JSON.stringify(theirs)) {
        failures.push(`${fixture}: the answer's ${field} yields ${JSON.stringify(ours)}, `
          + `the capture says ${JSON.stringify(theirs)}`);
      }
    }
  }
  return { failures, checked };
}

/**
 * Every way a row's echo claim fails to hold, given what actually got compared.
 *
 * `echoed` is per ROOT: a boolean says the same thing about every option the row
 * supplies, a map says it option by option. The map exists because a row can
 * combine an option the surface echoes with one it does not, and a single
 * boolean could only claim both — which is how `store: false` alongside
 * `include` passed for a long time on `store`'s leaf while `include`, which
 * R-25 records as producing no key at all, rode along uncompared.
 *
 * The rule is per root and not per row for the same reason. Asking whether the
 * ROW compared anything let one echoing option carry every other option in the
 * list; two independent reviews built that case on the same day.
 */
export function echoFailures({
  supplied, echoed, alsoCompare, declaredAbsent, comparedByRoot, echoedPaths, vendorRoots, ourRoots, rootOf,
}) {
  const failures = [];
  const declared = declaredAbsent ?? [];
  const asMap = typeof echoed === 'object' && echoed !== null;
  const echoedFor = (root) => (asMap ? echoed[root] === true : echoed === true);

  // The third state. `echoed: true` wants a compared leaf and `echoed: false`
  // wants no echoed path, and a root the vendor fills while a declaration says
  // we report nothing satisfies NEITHER: the vendor echoes 127 paths under it
  // and we compare none of them. Saying so out loud is what keeps the row from
  // being written as one of the two states it is not.
  for (const root of declared) {
    if (!(vendorRoots ?? new Set()).has(root)) {
      failures.push(`${root} is declared absent but the vendor's own answer carries nothing under it, so this row proves nothing`);
    }
    if ((comparedByRoot.get(root) ?? 0) !== 0) {
      failures.push(`${root} is declared absent yet ${comparedByRoot.get(root)} of its leaves were compared`);
    }
    if ((ourRoots ?? new Set()).has(root)) {
      failures.push(`${root} is declared absent and this answer reports it`);
    }
    if (supplied.includes(root)) {
      failures.push(`${root} is both supplied and declared absent; a row says one or the other about a root`);
    }
  }
  if (asMap) {
    const unsaid = supplied.filter((root) => typeof echoed[root] !== 'boolean');
    if (unsaid.length > 0) failures.push(`the echo map does not say what happens to ${unsaid.join(', ')}`);
  }

  const speaksFor = supplied.filter((root) => echoedFor(root));
  for (const root of speaksFor) {
    if ((comparedByRoot.get(root) ?? 0) === 0) failures.push(`${root} reached no comparison, so this row does not speak for it`);
  }

  const silentRoots = supplied.filter((root) => !echoedFor(root));
  const nowEchoed = echoedPaths.filter((path) => silentRoots.includes(rootOf(path)));
  if (nowEchoed.length > 0) failures.push(`the vendor now echoes ${nowEchoed.join(', ')}, so this row's claim is stale`);

  for (const path of alsoCompare ?? []) {
    if ((comparedByRoot.get(path) ?? 0) === 0) failures.push(`${path} did not reach the comparison`);
  }
  return failures;
}

/**
 * Keys every request on a surface must carry.
 *
 * A row need not claim them: they are the envelope, and a row that claimed
 * `model` would be asserting nothing about what it replays. A row MAY claim one
 * when its subject is a member INSIDE it — `direct-chat-message-name`,
 * `-message-refusal` and `-message-unknown-member` all claim `messages`, and
 * each is about one member of it. An earlier version of this comment said "no
 * row is about them", which those three rows disprove.
 *
 * Padding `supplied` with a mandatory key used to be a way to PARK a claim
 * rather than drop it: `supplied: ['model']` satisfies `option in request`,
 * `supplied.length > 0`, and even `echoed: true`, because `.model` really is
 * echoed and really does match — so a row went on certifying while asserting
 * nothing about its own option. That is closed by the per-row rule below rather
 * than by a ban here: the row's real option becomes unclaimed and fails by name.
 */
export const MANDATORY_REQUEST_KEYS = {
  '/v1/chat/completions': ['model', 'messages'],
  '/v1/responses': ['model', 'input'],
  '/v1/messages': ['model', 'messages', 'max_tokens'],
};

/**
 * Request keys no row claims, each with the reason it is nobody's subject.
 *
 * An entry here is a decision, written down. It is NOT a blanket exemption: the
 * rule below still requires every OTHER non-mandatory key in the store to be
 * claimed by some row on its surface, so removing a key from the one row that
 * claims it fails by name instead of silently deleting the only witness.
 */
export const UNCLAIMED_REQUEST_KEYS = {
  '/v1/chat/completions': {
    max_completion_tokens: 'every probe caps the turn so a capture costs a few tokens; '
      + 'the cap is how the request was taken, not what any row is about',
  },
  '/v1/responses': {
    max_output_tokens: 'the same cap under this surface\'s name',
  },
  '/v1/messages': {},
};

/**
 * The only keys a row may decline to claim, per surface, each with the reason.
 *
 * OUTSIDE every roster, which is the whole point. The first per-row rule let the
 * row carry its own excuse: `row.unclaimed` was a free-form map, so a row could
 * stop claiming an option and, in the same object, write a true sentence about
 * why it need not. A review did exactly that — `supplied: ['top_logprobs',
 * 'reasoning']` narrowed to `['top_logprobs']` plus one `unclaimed.reasoning`
 * sentence modelled on the one below — and a client-visible defect
 * (`reasoning.effort: "none"` answered `"medium"`) went from one failing test
 * back to 2303/2303. The rule asked the question per row and then read the
 * answer off the same row.
 *
 * So a row can only OPT IN to an excuse that already exists here. Minting one is
 * an edit to this table, on its own line, in a diff a reviewer reads — not a
 * field inside the row that stopped claiming.
 *
 * An entry that no capture on its surface carries is stale and fails.
 */
export const PROBE_SHAPED_KEYS = {
  '/v1/chat/completions': {
    reasoning_effort: PROBE_SHAPING_EFFORT,
  },
  '/v1/responses': {},
  '/v1/messages': {},
};

/**
 * Every option the store's requests carry that no row on that surface claims.
 *
 * The `supplied` assertion ran ONE WAY: a row could not claim an option its
 * request lacks, and nothing said a row must claim the options its request HAS.
 * A review made a real echo defect — `top_logprobs` answered as a hard `0` where
 * the client asked for `1` — invisible to the ENTIRE 2274-test suite by deleting
 * one word from one row's `supplied`. The gate was that defect's only witness
 * and the fixture dismissed it.
 *
 * Claiming through `declaredAbsent` counts: that row asserts the option's whole
 * answer is missing, which is a claim about it.
 */
export function unclaimedRequestOptions(rows, requestKeysOf,
  mandatoryKeys = MANDATORY_REQUEST_KEYS, surfaceExceptions = UNCLAIMED_REQUEST_KEYS,
  probeShaped = PROBE_SHAPED_KEYS) {
  const claimedOnSurface = new Map();
  const presentOnSurface = new Map();
  for (const row of rows) {
    const claimed = claimedOnSurface.get(row.surface) ?? new Set();
    for (const option of [...(row.supplied ?? []), ...(row.declaredAbsent ?? [])]) claimed.add(option);
    claimedOnSurface.set(row.surface, claimed);
    const present = presentOnSurface.get(row.surface) ?? new Set();
    for (const key of requestKeysOf(row.fixture)) present.add(key);
    presentOnSurface.set(row.surface, present);
  }

  const unclaimed = [];
  const staleExceptions = [];
  for (const row of rows) {
    const mandatory = new Set(mandatoryKeys[row.surface] ?? []);
    const surfaceExcused = surfaceExceptions[row.surface] ?? {};
    // A LIST of keys the row opts out of, not a map of reasons it writes. The
    // reasons live in `probeShaped`, where no row owns them.
    const rowExcused = new Set(row.unclaimed ?? []);
    const excusable = probeShaped[row.surface] ?? {};
    const claims = new Set([...(row.supplied ?? []), ...(row.declaredAbsent ?? [])]);
    const keys = requestKeysOf(row.fixture);
    // PER ROW. Per surface was not this property: a key stays claimed on a
    // surface by any row that names it, so the row that is a defect's only
    // WITNESS can stop claiming it and the rule sees nothing. Being an option's
    // only claimer and being its only witness are different, and a review made
    // a client-visible defect — `reasoning.effort: "none"` answered as
    // `"medium"` — pass all 2283 tests by deleting one word from the row that
    // witnessed it, while another row on the same surface kept the key claimed.
    for (const key of keys) {
      if (mandatory.has(key) || claims.has(key)) continue;
      if (rowExcused.has(key)) {
        if (!excusable[key]) {
          staleExceptions.push(`${row.fixture} ${key}: opted out of a key this surface does not list as probe-shaped`);
        }
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(surfaceExcused, key)) {
        if (!surfaceExcused[key]) staleExceptions.push(`${row.surface} ${key}: excused with no reason`);
        continue;
      }
      unclaimed.push(`${row.fixture} ${key}`);
    }
    for (const key of rowExcused) {
      if (!keys.includes(key)) staleExceptions.push(`${row.fixture} ${key}: excused but its request does not carry it`);
      else if (claims.has(key)) staleExceptions.push(`${row.fixture} ${key}: excused but this row claims it`);
    }

  }

  // An excusable key nothing sends has outlived whatever it was for. It cannot
  // also be required to go unclaimed by every row — `reasoning_effort` is
  // exactly a key the probe shapes AND one row is about.
  for (const [surface, excusable] of Object.entries(probeShaped)) {
    if (!presentOnSurface.has(surface)) continue;
    const present = presentOnSurface.get(surface);
    for (const [key, why] of Object.entries(excusable)) {
      if (!why) staleExceptions.push(`${surface} ${key}: listed as probe-shaped with no reason`);
      else if (!present.has(key)) staleExceptions.push(`${surface} ${key}: listed as probe-shaped but no capture's request carries it`);
    }
  }

  // A surface-level exception is for a key NO row claims — the shape of a knob
  // every probe sets and no row is about. One that a row does claim, or that no
  // capture sends, has outlived whatever it was for.
  for (const [surface, excused] of Object.entries(surfaceExceptions)) {
    const claimed = claimedOnSurface.get(surface) ?? new Set();
    const present = presentOnSurface.get(surface) ?? new Set();
    if (!presentOnSurface.has(surface)) continue;
    for (const key of Object.keys(excused)) {
      if (!present.has(key)) staleExceptions.push(`${surface} ${key}: excused but no capture's request carries it`);
      else if (claimed.has(key)) staleExceptions.push(`${surface} ${key}: excused but a row claims it`);
    }
  }
  return { unclaimed: [...new Set(unclaimed)].sort(), staleExceptions: [...new Set(staleExceptions)].sort() };
}
