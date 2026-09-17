// The ten realistic tasks the semantic-quality rows and the A/A noise floor are
// built from.
//
// They live here rather than in the benchmark runner for the reason the capture
// path did: the runner retires and these do not. The noise floor sends the SAME
// task to the SAME vendor repeatedly to measure how much a vendor varies against
// itself, and that measurement means nothing if its prompts are a COPY of the
// runner's — a copy is a thing that can disagree with its original, and the
// disagreement would read as vendor variance.
//
// Changing a prompt changes what every measurement taken against it means, so
// the artifacts name this file's digest rather than trusting its filename.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function qualityTasks() {
  return [
    {
      id: 'implementation_review',
      requiredTerms: ['schema', 'latency', 'risk'],
      format: 'bullets',
      prompt: [
        'Write a concise English implementation review for a local OAuth CLI API proxy.',
        'Facts to review: provider mappings lack schema versioning; provider auth headers are hardcoded; token exchange adds about 200ms; refresh caching and connection reuse are missing; localhost binding exists; state validation is missing; tokens may appear in debug logs; token storage is plaintext.',
        'Treat these facts as current defects; do not soften them as acceptable tradeoffs or future recommendations.',
        'Preserve qualifiers: say about 200ms, and say tokens may appear in debug logs.',
        'Return only three bullet lines, with no heading, preface, caveat, or closing sentence.',
        'Bullet 1 must assess API schema compatibility using the schema-versioning, provider-mapping, or auth-header facts.',
        'Bullet 2 must assess latency using token exchange adding about 200ms plus missing refresh caching or connection reuse.',
        'Bullet 3 must mention localhost binding exists, but missing state validation, plaintext storage, or possible debug-log token exposure keep OAuth risk high.',
        'Keep each bullet under 24 words.',
      ].join(' '),
    },
    {
      id: 'korean_optimization_axes',
      requiredTerms: ['속도', '품질', '영향', '개선'],
      format: 'table',
      prompt: [
        '다음 최적화 후보를 한국어로 평가해줘.',
        '후보: Codex wrapper 축소, tool argument streaming, Claude persistent session, negative provider error parity.',
        '판단 근거: Codex wrapper 축소는 proxy-added token/context를 줄여 속도에는 중간 정도 도움이 되지만 guardrail 약화 회귀 위험이 있어 품질 영향도 중간이다.',
        '판단 근거: tool argument streaming은 첫 tool argument latency를 크게 줄일 수 있어 속도 영향은 크지만 JSON argument 파싱 안정성을 보존해야 하므로 품질 영향은 중간이다.',
        '판단 근거: Claude persistent session은 프로세스 재시작 비용을 줄여 속도 영향은 크고, 세션 상태 오염을 막으면 품질은 대체로 중립이다.',
        '판단 근거: negative provider error parity는 정상 경로 속도 개선은 거의 없고, unsupported-value 400 shape 일치로 contract 품질을 중간 정도 개선한다.',
        '속도 영향 크기는 각각 정확히 "중간", "큼", "큼", "거의 없음"으로 써.',
        '품질 영향 크기는 각각 정확히 "중간", "중간", "낮음", "중간"으로 써.',
        '품질 개선 방향에는 각각 "악화 위험", "보존 필요", "대체로 중립", "개선"을 포함해.',
        '반드시 "영향 크기"와 "개선 방향"을 분리해서 판단해.',
        '출력은 Markdown 표 하나만 사용하고, 열은 작업, 속도 영향 크기, 속도 개선 방향, 품질 영향 크기, 품질 개선 방향으로 해.',
        '각 셀은 짧게 쓰고, 위 판단 근거와 반대되는 영향 크기를 만들지 마.',
        '영향이 크다는 말과 좋아진다는 말을 같은 뜻으로 쓰지 마.',
      ].join(' '),
    },
    {
      id: 'benchmark_failure_triage',
      requiredTerms: ['fixture', 'provider', 'proxy', 'benchmark'],
      format: 'bullets',
      prompt: [
        'A benchmark for multimodal parity failed.',
        'Observed facts: direct OpenAI returns image_parse_error for the fixture; direct Anthropic says it could not process the image; both proxies sometimes answer BLUE when the expected label is RED.',
        'Write an English triage note with exactly four bullets.',
        'Identify the most likely first thing to validate, explain why proxy quality cannot be judged until direct providers accept the same fixture, and include one benchmark change plus one implementation check.',
        'Name both direct-provider errors: image_parse_error and could not process the image.',
        'Name the proxy label mismatch as BLUE vs expected RED.',
        'The implementation check must include forwarding fidelity and synthetic fallback labels or swallowed upstream errors.',
        'Do not claim the model is color blind and do not blame OAuth.',
      ].join(' '),
    },
    {
      id: 'handoff_summary',
      requiredTerms: ['usage', 'stream', 'quality', 'turnWaitMs'],
      format: 'bullets',
      expectedBullets: 5,
      prompt: [
        'Write a concise engineering handoff in English for the next maintainer of a local OAuth CLI API proxy.',
        'Current facts: provider token usage is preserved in public usage fields; stream rows track firstDataMs, firstTextMs, and firstToolArgumentMs; semantic quality must stay at least 95; proxy-codex-app-server diagnostic latency outliers are dominated by turnWaitMs; request-level effort overrides backend fallback settings.',
        'Return exactly five bullets.',
        'Each bullet must name the product consequence first, then the technical authority.',
        'Preserve exact identifiers and numeric thresholds: write "at least 95" as a score, not 95%, and state that outliers are dominated by turnWaitMs.',
        'Include these exact authority phrases once each: "stream rows track firstDataMs, firstTextMs, and firstToolArgumentMs"; "proxy-codex-app-server diagnostic latency outliers are dominated by turnWaitMs"; "request-level effort overrides backend fallback settings".',
        'Keep each bullet under 18 words.',
        'Avoid historical narration and avoid asking follow-up questions.',
      ].join(' '),
    },
    {
      id: 'korean_incident_report',
      requiredTerms: ['원인', '영향', '대응', '재발'],
      format: 'bullets',
      expectedBullets: 4,
      prompt: [
        '한국어로 장애 보고서를 작성해줘.',
        '상황: proxy-codex-app-server 진단 경로가 OpenAI Chat tool_call_stream에서 첫 tool argument를 7초 늦게 보냈고, 직접 OpenAI API는 1.2초였다.',
        '원인 후보: Codex turnWaitMs outlier, wrapper context 증가, usage 후착 대기 혼동.',
        '사실: public API schema와 provider usage 값은 정상이고, 사용자 prompt 축소는 금지되어 있다.',
        '출력은 제목 없이 정확히 네 개의 bullet만 사용해.',
        '각 bullet은 순서대로 원인, 영향, 대응, 재발 방지로 시작해.',
        '사용자 prompt를 줄이라는 제안은 하지 마.',
      ].join(' '),
    },
    {
      id: 'json_contract_summary',
      requiredTerms: ['contract', 'usage', 'stream', 'error'],
      format: 'json',
      requiredKeys: ['contractRisk', 'usageAuthority', 'streamLatencyMetric', 'errorParity'],
      prompt: [
        'Return only a valid JSON object with exactly these keys: contractRisk, usageAuthority, streamLatencyMetric, errorParity.',
        'Context: an API proxy must preserve provider usage fields, stream firstDataMs/firstTextMs/firstToolArgumentMs, and return provider-style 400 errors for unsupported values.',
        'contractRisk must mention schema exactness.',
        'usageAuthority must mention provider usage.',
        'streamLatencyMetric must mention firstToolArgumentMs.',
        'errorParity must mention invalid_request_error.',
        'Do not include markdown fences, comments, or extra keys.',
      ].join(' '),
    },
    {
      id: 'streaming_latency_decision',
      requiredTerms: ['firstDataMs', 'firstTextMs', 'firstToolArgumentMs', 'totalMs'],
      format: 'table',
      prompt: [
        'Create a Markdown table for deciding whether streaming got faster.',
        'Rows must cover firstDataMs, firstTextMs, firstToolArgumentMs, and totalMs.',
        'Columns must be Metric, User-visible meaning, Improve when, Quality risk.',
        'Use firstToolArgumentMs for tool argument latency, not firstTextMs.',
        'Mention that totalMs alone is insufficient for streaming UX.',
        'Return only the table.',
      ].join(' '),
    },
    {
      id: 'provider_error_policy',
      requiredTerms: ['400', 'invalid_request_error', 'param', 'code'],
      format: 'bullets',
      expectedBullets: 4,
      prompt: [
        'Write exactly four English bullets defining an error parity policy for an OpenAI-compatible proxy.',
        'The policy must cover status 400, error.type invalid_request_error, param, code, and non-empty message.',
        'Explain that unsupported request options should match provider style rather than silently falling back.',
        'Mention that message wording may vary but shape must remain stable.',
        'Do not include a heading.',
      ].join(' '),
    },
    {
      id: 'image_api_benchmark_plan',
      requiredTerms: ['generation', 'edit', 'variation', 'vision'],
      format: 'bullets',
      expectedBullets: 5,
      prompt: [
        'Write exactly five English bullets for an Images API benchmark plan.',
        'Cover generation, edit, variation, URL response, and streaming image generation.',
        'Include a vision judge requirement for image quality.',
        'State that proxy Images API requests must not call direct provider APIs; provider egress from a proxy target scores 0.',
        'State that gpt-image-2 through the proxy is the formal image2_via_gpt55 route and must not call direct provider APIs.',
        'Mention direct Images API positive and negative baseline rows.',
        'Do not claim variations are supported by GPT Image models.',
      ].join(' '),
    },
    {
      id: 'release_gate_decision',
      requiredTerms: ['pass', 'block', 'semantic', 'latency'],
      format: 'bullets',
      expectedBullets: 4,
      prompt: [
        'Write exactly four English bullets for a release gate decision.',
        'Inputs: semantic quality minimum is 95; image quality minimum is 90; latency regression threshold is direct API plus 30% or 750ms; schema contract failures block release.',
        'One bullet must say when to pass.',
        'One bullet must say when to block.',
        'One bullet must distinguish latency outliers from repeated median regressions.',
        'One bullet must mention follow-up benchmark evidence.',
        'Do not end with a question.',
      ].join(' '),
    },
  ];
}

/** What these prompts are, as one digest, so an artifact can name what it measured. */
export function qualityTasksDigest() {
  return createHash('sha256')
    .update(readFileSync(fileURLToPath(import.meta.url)))
    .digest('hex');
}
