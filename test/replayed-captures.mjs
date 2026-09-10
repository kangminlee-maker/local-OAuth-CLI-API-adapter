import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
export function createReplayBackend() {
  let answer = DEFAULT_ANSWER;
  return {
    /** Answer the next replayed request this way. Called before each fetch. */
    answerWith(next) {
      answer = { ...DEFAULT_ANSWER, ...(next ?? {}), usage: { ...DEFAULT_ANSWER.usage, ...(next?.usage ?? {}) } };
    },
    backend: {
      name: 'fake-backend',
      model: 'fake-local-model',
      async generate(request) {
        return {
          id: 'local_test',
          model: request.model,
          text: answer.text,
          toolCalls: [],
          usage: answer.usage,
          latencyMs: 1,
          ...(answer.stopReason === undefined ? {} : { stopReason: answer.stopReason }),
        };
      },
      async close() {},
    },
  };
}

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
  { fixture: 'direct-chat-service-tier-flex', surface: '/v1/chat/completions', supplied: ['service_tier'], echoed: true, vendorPaths: 28 },
  { fixture: 'direct-chat-response-format-json-object', surface: '/v1/chat/completions', supplied: ['response_format'], echoed: false, vendorPaths: 28 },
  {
    fixture: 'direct-chat-n-2',
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
  { fixture: 'direct-chat-service-tier-default', surface: '/v1/chat/completions', supplied: ['service_tier'], echoed: true, vendorPaths: 28 },
  { fixture: 'direct-chat-service-tier-priority', surface: '/v1/chat/completions', supplied: ['service_tier'], echoed: true, vendorPaths: 28 },
  { fixture: 'direct-chat-reasoning-effort-none', surface: '/v1/chat/completions', supplied: ['reasoning_effort'], echoed: false, vendorPaths: 28 },
  { fixture: 'direct-chat-seed', surface: '/v1/chat/completions', supplied: ['seed'], echoed: false, vendorPaths: 28 },
  { fixture: 'direct-chat-store-true', surface: '/v1/chat/completions', supplied: ['store'], echoed: false, vendorPaths: 28 },
  { fixture: 'direct-chat-metadata-user-safety-identifier', surface: '/v1/chat/completions', supplied: ['metadata', 'user', 'safety_identifier'], echoed: false, vendorPaths: 28 },
  { fixture: 'direct-chat-prompt-cache-key-options', surface: '/v1/chat/completions', supplied: ['prompt_cache_key', 'prompt_cache_options'], echoed: false, vendorPaths: 28 },
  { fixture: 'direct-chat-prompt-cache-retention', surface: '/v1/chat/completions', supplied: ['prompt_cache_retention'], echoed: false, vendorPaths: 28 },
  { fixture: 'direct-chat-verbosity', surface: '/v1/chat/completions', supplied: ['verbosity'], echoed: false, vendorPaths: 28 },
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
  { fixture: 'direct-chat-message-name', surface: '/v1/chat/completions', supplied: ['messages'], echoed: false, vendorPaths: 28 },
  { fixture: 'direct-chat-message-unknown-member', surface: '/v1/chat/completions', supplied: ['messages'], echoed: false, vendorPaths: 28 },
  { fixture: 'direct-chat-message-refusal', surface: '/v1/chat/completions', supplied: ['messages'], echoed: false, vendorPaths: 28 },
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
export const ANSWER_BINDINGS = {
  '/v1/messages': [
    ['stopReason', (body) => body.stop_reason],
    ['usage.cacheCreationInputTokens', (body) => body.usage?.cache_creation_input_tokens],
    ['usage.cacheReadInputTokens', (body) => body.usage?.cache_read_input_tokens],
    ['usage.cachedInputTokens', (body) => (body.usage?.cache_creation_input_tokens ?? 0)
      + (body.usage?.cache_read_input_tokens ?? 0)],
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
export function answerPremiseFailures(rows, bodyOf, bindings = ANSWER_BINDINGS) {
  const read = (answer, dotted) => dotted.split('.').reduce(
    (value, key) => (value === undefined || value === null ? undefined : value[key]),
    answer,
  );
  const failures = [];
  let checked = 0;
  for (const { fixture, surface, answer } of rows) {
    if (!answer) continue;
    const table = bindings[surface];
    if (!table) {
      failures.push(`${fixture}: ${surface} has an answer but no binding table, so its premise is unchecked`);
      continue;
    }
    const vendor = bodyOf(fixture);
    for (const [field, ofVendor] of table) {
      const supplied = read(answer, field);
      if (supplied === undefined) continue;
      checked += 1;
      const theirs = ofVendor(vendor);
      if (JSON.stringify(supplied) !== JSON.stringify(theirs)) {
        failures.push(`${fixture}: the answer says ${field} is ${JSON.stringify(supplied)}, `
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
