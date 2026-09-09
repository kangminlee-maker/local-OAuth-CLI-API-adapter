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
  { fixture: 'direct-responses-store-false-include-encrypted', surface: '/v1/responses', supplied: ['include', 'store'], echoed: true, vendorPaths: 76 },

  // /v1/chat/completions — this surface echoes almost nothing, and each row
  // below says so about one more option. `service_tier` is the exception.
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
