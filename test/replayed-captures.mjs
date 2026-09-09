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
