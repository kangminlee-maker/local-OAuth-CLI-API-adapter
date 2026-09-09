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
    // The vendor's turn reasoned and ours does not: a reasoning item carries
    // the first two members, and the fake backend emits no reasoning item at
    // all. What a real backend's reasoning item would carry is matrix R-25's
    // claim, not this row's.
    //
    // The `{-key}` entries are the same fact read from the other side: the
    // vendor's output array holds two items that disagree about `phase`,
    // `role` and `status`, and an array of one message item cannot disagree
    // with itself. Every member the vendor's turn does have, ours matches.
    harnessGaps: [
      '.output[].encrypted_content',
      '.output[].summary',
      '.output[]{-phase}',
      '.output[]{-role}',
      '.output[]{-status}',
    ],
    vendorPaths: 94,
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

/** Every promoted buffered capture some gate replays. */
export const REPLAYED_FIXTURES = new Set([
  ...SUPPLIED_ECHO_CAPTURES.map((row) => row.fixture),
  ...MINIMAL_SURFACES.map((row) => row.fixture),
]);
