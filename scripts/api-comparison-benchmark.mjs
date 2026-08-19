#!/usr/bin/env node
import fs from 'node:fs';
import { deflateSync } from 'node:zlib';
import { ClaudeCodeBackend } from '../dist/proxy/claude-code-backend.js';
import {
  CodexAppServerBackend,
  isCodexAppServerProxyMode,
} from '../dist/proxy/codex-app-server-backend.js';
import { CodexBackendTransport } from '../dist/proxy/codex-backend-transport.js';
import { openAiImageQualityReasoningEffort, startLocalApiProxy } from '../dist/proxy/http-server.js';
import { image2ViaGpt55Prompt } from '../dist/proxy/image2-via-gpt55.js';
import { codexProxyImageModel, isReasoningEffort } from '../dist/settings.js';

loadEnvFile('.env');

const imageGenerationCaseNames = {
  generationB64: 'openai.images.generation.image2_via_gpt55.b64_json.schema_exact',
  generationB64N3Parallel: 'openai.images.generation.image2_via_gpt55.b64_json_n3_parallel.schema_exact',
  generationApiFields: 'openai.images.generation_api_fields.image2_via_gpt55.schema_exact',
  generationUrl: 'openai.images.generation_url.image2_via_gpt55.schema_exact',
  generationStream: 'openai.images.generation_stream.image2_via_gpt55.schema_exact',
  generationStreamPaired: 'openai.images.generation_stream_paired.image2_via_gpt55.latency_compare',
  generationPhotorealProduct: 'openai.images.generation_photoreal_product.image2_via_gpt55.schema_exact',
  generationAssetIcon: 'openai.images.generation_asset_icon.image2_via_gpt55.schema_exact',
  generationTextPoster: 'openai.images.generation_text_poster.image2_via_gpt55.schema_exact',
  referenceStyleGeneration: 'openai.images.reference_style_generation.image2_via_gpt55.schema_exact',
  referenceProductGeneration: 'openai.images.reference_product_generation.image2_via_gpt55.schema_exact',
  referenceMultiGeneration: 'openai.images.reference_multi_generation.image2_via_gpt55.schema_exact',
  edit: 'openai.images.edit.image2_via_gpt55.schema_exact',
  editPreserveComposition: 'openai.images.edit_preserve_composition.image2_via_gpt55.schema_exact',
  editMultiImage: 'openai.images.edit_multi_image.image2_via_gpt55.schema_exact',
  editMultipartStream: 'openai.images.edit_multipart_stream.image2_via_gpt55.schema_exact',
  variation: 'openai.images.variation.image2_via_gpt55.schema_exact',
  proxyGptImageResponseFormatUnsupported: 'openai.images.proxy_gpt_image_response_format_unsupported.schema_exact',
  directImagesGeneration: 'openai.images.direct_generation.gpt_image.schema_exact',
  directImagesEdit: 'openai.images.direct_edit.gpt_image.schema_exact',
  directImagesImage2Unsupported: 'openai.images.direct_image2_unsupported.schema_exact',
  errorMissingPrompt: 'openai.images.error_missing_prompt.schema_exact',
  errorInvalidOutputCompression: 'openai.images.error_invalid_output_compression.schema_exact',
  backgroundTransparentUnsupported: 'openai.images.background_transparent_unsupported.image2_via_gpt55.schema_exact',
  inputFidelityDisabled: 'openai.images.input_fidelity_disabled.image2_via_gpt55.schema_exact',
  errorVariationJson: 'openai.images.error_variation_json.schema_exact',
};

const imageGenerationSuiteCaseNames = Object.values(imageGenerationCaseNames)
  .filter((caseName) => caseName !== imageGenerationCaseNames.generationStreamPaired);
const originalFetch = globalThis.fetch.bind(globalThis);
let currentBenchmarkContext = null;
let activeProxyProviderEgressGuard = null;

globalThis.fetch = async (input, init) => {
  const url = fetchUrl(input);
  if (activeProxyProviderEgressGuard && isProviderApiUrl(url)) {
    const call = {
      url,
      target: currentBenchmarkContext?.target ?? null,
      case: currentBenchmarkContext?.caseName ?? null,
    };
    activeProxyProviderEgressGuard.calls.push(call);
    throw new ProxyProviderEgressError(activeProxyProviderEgressGuard.calls);
  }
  return originalFetch(input, init);
};

class ProxyProviderEgressError extends Error {
  constructor(calls, cause) {
    super(`proxy target made direct provider API call: ${calls.map((call) => call.url).join(', ')}`);
    this.name = 'ProxyProviderEgressError';
    this.calls = calls;
    this.cause = cause;
  }
}

function failedBenchmarkRow(target, caseName, err) {
  const row = {
    target,
    case: caseName,
    ok: false,
    error: errorMessage(err),
  };
  if (err instanceof ProxyProviderEgressError) {
    row.error = 'proxy target made direct provider API call; quality forced to 0';
    row.providerEgress = err.calls;
    row.quality = summarize([0]);
    row.semanticQuality = summarize([0]);
    row.imageQuality = summarize([0]);
    if (err.cause) row.providerEgressCause = errorMessage(err.cause);
  }
  return row;
}

async function guardedProxyFetch(url, fn) {
  if (!isLocalProxyUrl(url)) return await fn();
  const previous = activeProxyProviderEgressGuard;
  const guard = { calls: [] };
  activeProxyProviderEgressGuard = guard;
  try {
    const result = await fn();
    if (guard.calls.length > 0) throw new ProxyProviderEgressError(guard.calls);
    return result;
  } catch (err) {
    if (guard.calls.length > 0) throw new ProxyProviderEgressError(guard.calls, err);
    throw err;
  } finally {
    activeProxyProviderEgressGuard = previous;
  }
}

function fetchUrl(input) {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  if (input && typeof input === 'object' && typeof input.url === 'string') return input.url;
  return String(input ?? '');
}

function isLocalProxyUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname === '127.0.0.1'
      || parsed.hostname === 'localhost'
      || parsed.hostname === '::1';
  } catch {
    return false;
  }
}

function isProviderApiUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname === 'api.openai.com'
      || parsed.hostname === 'api.anthropic.com';
  } catch {
    return false;
  }
}

const benchmarkSuiteDefinitions = {
  'contract-smoke': [
    'openai.chat.text.schema_exact',
    'openai.chat.stream.schema_exact',
    'openai.chat.tool_call_stream.schema_exact',
    'openai.responses.text',
    'openai.responses.stream',
    'openai.responses.tool_call_stream.schema_exact',
    'anthropic.messages.text',
    'anthropic.messages.stream',
    'anthropic.messages.tool_use_stream.schema_exact',
  ],
  'provider-parity': [
    'openai.chat.text.schema_exact',
    'openai.chat.stream.schema_exact',
    'openai.chat.stream_usage.schema_exact',
    'openai.chat.tool_call.schema_exact',
    'openai.chat.tool_call_stream.schema_exact',
    'openai.chat.tool_result.schema_exact',
    'openai.chat.image.schema_exact',
    'openai.chat.multi_image.schema_exact',
    'openai.responses.text',
    'openai.responses.stream',
    'openai.responses.tool_call',
    'openai.responses.tool_call_stream.schema_exact',
    'openai.responses.image.schema_exact',
    'openai.responses.multi_image.schema_exact',
    'anthropic.messages.text',
    'anthropic.messages.stream',
    'anthropic.messages.tool_use',
    'anthropic.messages.tool_use_stream.schema_exact',
    'anthropic.messages.tool_result.schema_exact',
    'anthropic.messages.image.schema_exact',
    'anthropic.messages.multi_image.schema_exact',
  ],
  'quality-realistic': [
    'semantic_quality',
  ],
  'image-realistic': [
    ...imageGenerationSuiteCaseNames,
  ],
  'release-gate': [
    'all',
  ],
};

const options = parseArgs(process.argv.slice(2));
const selectedSuites = readBenchmarkSuites(options.suite ?? options.suites);
const suiteCaseFilters = benchmarkSuiteCaseFilters(selectedSuites);
const suiteDefaults = benchmarkSuiteDefaults(selectedSuites);
const timeoutMs = numberOption(options.timeoutMs, 240_000);
const repeats = numberOption(options.repeats, 1);
const qualityRepeats = countOption(options.qualityRepeats, 0);
const semanticQualityRepeats = countOption(options.semanticQualityRepeats, suiteDefaults.semanticQualityRepeats);
const includeMultimodal = booleanOption(options.includeMultimodal, suiteDefaults.includeMultimodal);
const includeImageGeneration = booleanOption(options.includeImageGeneration, suiteDefaults.includeImageGeneration);
const imageQualityRepeats = countOption(options.imageQualityRepeats, suiteDefaults.imageQualityRepeats);
const cwd = options.cwd ?? process.cwd();
const openAiModel = options.openaiModel ?? 'gpt-5.5';
const openAiImageApiModel = options.openaiImageApiModel ?? 'gpt-image-1.5';
const anthropicModels = {
  opus: options.anthropicOpusModel ?? 'claude-opus-4-8',
  haiku: options.anthropicHaikuModel ?? 'claude-haiku-4-5-20251001',
};
// Row labels carry the model that actually ran, so artifacts self-describe.
// Target selection matches by substring, so `--targets=openai-api` selects the
// direct target regardless of the model override.
const openAiApiTarget = `openai-api:${openAiModel}`;
const imageGenerationPairTarget = `proxy-codex-vs-openai-api:${openAiModel}`;
// Recorded in the summary: isolation changes the proxied session's context, so
// a baseline comparison across a differing value is not a like-for-like basis.
const claudeIsolateUserSettings = booleanOption(options.claudeIsolateUserSettings, false);
const outputPath = options.output;
const baselinePath = options.baseline;
const regressionTargets = options.regressionTargets ?? 'proxy';
const latencyRegressionPct = numberOption(options.latencyRegressionPct, 30);
const latencyRegressionMs = numberOption(options.latencyRegressionMs, 750);
const qualityRegressionPoints = numberOption(options.qualityRegressionPoints, 5);
const semanticQualityTargets = options.semanticQualityTargets ?? 'proxy';
const semanticQualityJudgeModel = options.semanticQualityJudgeModel ?? openAiModel;
const imageQualityJudgeModel = options.imageQualityJudgeModel ?? semanticQualityJudgeModel;
const semanticQualityReference = booleanOption(options.semanticQualityReference, true);
const semanticQualitySuite = options.semanticQualitySuite ?? 'realistic';
const minSemanticQuality = nonNegativeNumberOption(options.minSemanticQuality, 0);
const minImageQuality = nonNegativeNumberOption(options.minImageQuality, suiteDefaults.minImageQuality);
const expectProviderErrors = booleanOption(options.expectProviderErrors, false);
const requestReasoningEffort = optionalReasoningEffort(options.requestReasoningEffort);
const codexProxyMode = codexAppServerProxyMode(options.codexProxyMode ?? options.codexProbeMode);
const targetFilters = readFilters(options.targets ?? options.target);
const caseFilters = mergeFilters(readFilters(options.cases ?? options.case), suiteCaseFilters);
const codexImageAttemptLogPath = options.codexImageAttemptLog;
const codexImageAttemptDiagnosticsEnabled = booleanOption(
  options.codexImageAttemptDiagnostics,
  Boolean(codexImageAttemptLogPath),
);

const rows = [];
const servers = [];
const semanticReferenceCache = new Map();
const imageFixtureCache = new Map();
const backendTimingQueues = new Map();
const imageAttemptDiagnostics = [];

try {
  let proxyCodex = null;
  let proxyCodexAppServer = null;
  let proxyCodexBackendTransport = null;
  let proxyClaude = null;
  const selectedCodexImageTransport = codexImageTransport(options.codexImageTransport);
  if (shouldRunTarget('proxy-codex') || shouldRunImageGenerationPairBenchmark()) {
    const proxyCodexTextBackend = new CodexBackendTransport({
      model: options.codexBackendModel ?? options.codexModel,
      timeoutMs,
      reasoningEffort: reasoningEffort(options.reasoningEffort),
    });
    const proxyCodexImageBackend = selectedCodexImageTransport === 'codex-backend'
      ? new CodexBackendTransport({
          model: options.codexImageModel ?? codexProxyImageModel(),
          timeoutMs,
          ...(codexImageAttemptDiagnosticsEnabled
            ? { onImageAttempt: (diagnostic) => recordImageAttemptDiagnostic('proxy-codex', diagnostic) }
            : {}),
        })
      : new CodexAppServerBackend({
          command: options.codexCommand,
          cwd,
          model: options.codexImageModel ?? codexProxyImageModel(),
          timeoutMs,
          imageGeneration: true,
          proxyMode: codexProxyMode,
          onTiming: (timing) => pushBackendTiming('proxy-codex', timing),
        });
    proxyCodex = await startProxy(proxyCodexTextBackend, {
      imageGenerationClient: proxyCodexImageBackend,
    });
  }
  if (shouldRunDiagnosticTarget('proxy-codex-app-server')) {
    const proxyCodexBackend = new CodexAppServerBackend({
      command: options.codexCommand,
      cwd,
      model: options.codexModel,
      timeoutMs,
      reasoningEffort: reasoningEffort(options.reasoningEffort),
      proxyMode: codexProxyMode,
      onTiming: (timing) => pushBackendTiming('proxy-codex-app-server', timing),
    });
    proxyCodexAppServer = await startProxy(proxyCodexBackend);
  }
  if (shouldRunDiagnosticTarget('proxy-codex-backend')) {
    proxyCodexBackendTransport = await startProxy(new CodexBackendTransport({
      model: options.codexBackendModel ?? options.codexModel,
      timeoutMs,
      reasoningEffort: reasoningEffort(options.reasoningEffort),
    }));
  }
  if (shouldRunTarget('proxy-claude')) {
    proxyClaude = await startProxy(new ClaudeCodeBackend({
      command: options.claudeCommand,
      cwd,
      model: options.claudeCliModel ?? 'opus',
      timeoutMs,
      isolateUserSettings: claudeIsolateUserSettings,
    }));
  }

  if (proxyCodex) await benchmarkOpenAiChatCompatible('proxy-codex', proxyCodex.url, proxyCodex.model, false);
  if (proxyCodex) await benchmarkOpenAiCompatible('proxy-codex', proxyCodex.url, proxyCodex.model, false);
  if (shouldRunImageGenerationBenchmarks() && proxyCodex) await benchmarkOpenAiImageGenerationCompatible('proxy-codex', proxyCodex.url, false);
  if (proxyCodexAppServer) await benchmarkOpenAiChatCompatible('proxy-codex-app-server', proxyCodexAppServer.url, proxyCodexAppServer.model, false);
  if (proxyCodexAppServer) await benchmarkOpenAiCompatible('proxy-codex-app-server', proxyCodexAppServer.url, proxyCodexAppServer.model, false);
  if (proxyCodexBackendTransport) await benchmarkOpenAiChatCompatible('proxy-codex-backend', proxyCodexBackendTransport.url, proxyCodexBackendTransport.model, false);
  if (proxyCodexBackendTransport) await benchmarkOpenAiCompatible('proxy-codex-backend', proxyCodexBackendTransport.url, proxyCodexBackendTransport.model, false);
  if (shouldRunTarget(openAiApiTarget)) {
    if (process.env.OPENAI_API_KEY) {
      await benchmarkOpenAiChatCompatible(openAiApiTarget, 'https://api.openai.com', openAiModel, true);
      await benchmarkOpenAiCompatible(openAiApiTarget, 'https://api.openai.com', openAiModel, true);
      if (shouldRunImageGenerationBenchmarks()) await benchmarkOpenAiImageGenerationCompatible(openAiApiTarget, 'https://api.openai.com', true);
    } else {
      rows.push({ target: openAiApiTarget, ok: false, skipped: true, error: 'OPENAI_API_KEY missing' });
    }
  }
  if (shouldRunImageGenerationPairBenchmark()) {
    if (proxyCodex && process.env.OPENAI_API_KEY) {
      await benchmarkOpenAiImageGenerationStreamPair(proxyCodex.url);
    } else {
      rows.push({
        target: imageGenerationPairTarget,
        case: imageGenerationCaseNames.generationStreamPaired,
        ok: false,
        error: proxyCodex ? 'OPENAI_API_KEY missing' : 'proxy-codex unavailable',
      });
    }
  }

  if (proxyClaude) await benchmarkAnthropicCompatible('proxy-claude', proxyClaude.url, proxyClaude.model, false);
  if (process.env.ANTHROPIC_API_KEY) {
    for (const [family, model] of Object.entries(anthropicModels)) {
      // Select by family alias or by model name; label rows with the model that ran.
      if (shouldRunTarget(`anthropic-api:${family}`) || shouldRunTarget(`anthropic-api:${model}`)) {
        await benchmarkAnthropicCompatible(`anthropic-api:${model}`, 'https://api.anthropic.com', model, true);
      }
    }
  } else if (Object.keys(anthropicModels).some((family) => shouldRunTarget(`anthropic-api:${family}`))) {
    rows.push({ target: 'anthropic-api', ok: false, skipped: true, error: 'ANTHROPIC_API_KEY missing' });
  }
} finally {
  for (const server of servers.reverse()) await server.close().catch(() => undefined);
}

if (rows.length === 0) {
  rows.push({
    target: 'benchmark',
    case: 'selection',
    ok: false,
    error: `No benchmark rows selected. targets=${filterLabel(targetFilters)} cases=${filterLabel(caseFilters)}`,
  });
}

const failed = rows.filter((row) => !row.ok && !row.skipped);
const summaryBase = {
  repeats,
  qualityRepeats,
  semanticQualityRepeats,
  imageQualityRepeats,
  semanticQualityTargets,
  semanticQualityJudgeModel,
  imageQualityJudgeModel,
  semanticQualityReference,
  semanticQualityReferenceMode: 'proxy-provider',
  semanticQualitySuite,
  minSemanticQuality,
  minImageQuality,
  expectProviderErrors,
  requestReasoningEffort,
  codexProxyMode: codexProxyMode ?? 'api-isolated',
  suites: filterLabel(selectedSuites),
  targetFilters: filterLabel(targetFilters),
  caseFilters: filterLabel(caseFilters),
  includeMultimodal,
  includeImageGeneration,
  openAiModel,
  openAiImageApiModel,
  codexImageModel: options.codexImageModel ?? codexProxyImageModel(),
  claudeIsolateUserSettings,
  anthropicModels,
  passed: rows.length - failed.length,
  failed: failed.length,
  rows,
};
const regressionGate = baselinePath
  ? compareWithBaseline(loadSummaryFile(baselinePath), summaryBase, {
      regressionTargets,
      latencyRegressionPct,
      latencyRegressionMs,
      qualityRegressionPoints,
    })
  : null;
const summary = {
  ...summaryBase,
  ...(imageAttemptDiagnostics.length > 0 ? { imageAttemptDiagnostics } : {}),
  ...(regressionGate ? { regressionGate } : {}),
};
if (outputPath) {
  fs.writeFileSync(outputPath, `${JSON.stringify(summary, null, 2)}\n`);
}
console.log(`\nAPI_COMPARISON_SUMMARY ${JSON.stringify(summary, null, 2)}`);
process.exit(failed.length > 0 || (regressionGate?.regressions.length ?? 0) > 0 ? 1 : 0);

async function startProxy(backend, options = {}) {
  const server = await startLocalApiProxy({
    backend,
    imageGenerationClient: options.imageGenerationClient,
    host: '127.0.0.1',
    port: 0,
    requestTimeoutMs: timeoutMs,
  });
  servers.push(server);
  return { url: server.url, model: backend.model };
}

async function benchmarkOpenAiChatCompatible(target, baseUrl, model, isApi) {
  await benchmarkCase(target, 'openai.chat.text.schema_exact', repeats, async (index) => {
    const token = tokenFor(target, 'CHAT_TEXT', index);
    const response = await postJson(`${baseUrl}/v1/chat/completions`, {
      model,
      messages: [{ role: 'user', content: exactPrompt(token) }],
      max_completion_tokens: 64,
    }, openAiHeaders(isApi));
    assertOpenAiChatResponseShape(response.body, 'stop');
    const text = response.body.choices?.[0]?.message?.content;
    assertEqual(text, token, 'chat content');
    return { totalMs: response.totalMs, text, usage: response.body.usage };
  });

  if (requestReasoningEffort) {
    await benchmarkCase(target, 'openai.chat.request_reasoning_effort.schema_exact', repeats, async (index) => {
      const token = tokenFor(target, `CHAT_REASONING_${requestReasoningEffort.toUpperCase()}`, index);
      const body = {
        model,
        reasoning_effort: requestReasoningEffort,
        messages: [{ role: 'user', content: exactPrompt(token) }],
        max_completion_tokens: 64,
      };
      if (expectProviderErrors) {
        return await postJsonExpectOpenAiError(`${baseUrl}/v1/chat/completions`, body, openAiHeaders(isApi), {
          status: 400,
          type: 'invalid_request_error',
          param: 'reasoning_effort',
          code: 'unsupported_value',
        });
      }
      const response = await postJson(`${baseUrl}/v1/chat/completions`, {
        ...body,
      }, openAiHeaders(isApi));
      assertOpenAiChatResponseShape(response.body, 'stop');
      const text = response.body.choices?.[0]?.message?.content;
      assertEqual(text, token, 'chat reasoning effort content');
      return { totalMs: response.totalMs, text, requestReasoningEffort, usage: response.body.usage };
    });
  }

  await benchmarkCase(target, 'openai.chat.stream.schema_exact', repeats, async (index) => {
    const token = tokenFor(target, 'CHAT_STREAM', index);
    const response = await postSse(`${baseUrl}/v1/chat/completions`, {
      model,
      stream: true,
      messages: [{ role: 'user', content: exactPrompt(token) }],
      max_completion_tokens: 64,
    }, openAiHeaders(isApi), (_event, payload) => payload?.choices?.[0]?.delta?.content ?? '');
    assertEqual(response.text, token, 'chat stream text');
    assert(response.done, 'chat stream missing DONE');
    assertOpenAiChatStreamShape(response.events, { includeUsage: false });
    return responseSummary(response);
  });

  await benchmarkCase(target, 'openai.chat.stream_usage.schema_exact', repeats, async (index) => {
    const token = tokenFor(target, 'CHAT_STREAM_USAGE', index);
    const response = await postSse(`${baseUrl}/v1/chat/completions`, {
      model,
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: 'user', content: exactPrompt(token) }],
      max_completion_tokens: 64,
    }, openAiHeaders(isApi), (_event, payload) => payload?.choices?.[0]?.delta?.content ?? '');
    assertEqual(response.text, token, 'chat stream usage text');
    assert(response.done, 'chat stream usage missing DONE');
    assertOpenAiChatStreamShape(response.events, { includeUsage: true });
    return responseSummary(response);
  });

  await benchmarkCase(target, 'openai.chat.json_schema.schema_exact', repeats, async () => {
    const response = await postJson(`${baseUrl}/v1/chat/completions`, {
      model,
      messages: [{
        role: 'user',
        content: 'Return JSON with adapter exactly "local-oauth-cli" and ok exactly true.',
      }],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'adapter_exactness',
          strict: true,
          schema: adapterSchema(),
        },
      },
      max_completion_tokens: 128,
    }, openAiHeaders(isApi));
    assertOpenAiChatResponseShape(response.body, 'stop');
    const parsed = parseJson(response.body.choices?.[0]?.message?.content, 'chat json content');
    assertEqual(parsed.adapter, 'local-oauth-cli', 'json adapter');
    assertEqual(parsed.ok, true, 'json ok');
    return { totalMs: response.totalMs, parsed, usage: response.body.usage };
  });

  let toolCall;
  await benchmarkCase(target, 'openai.chat.tool_call.schema_exact', repeats, async () => {
    const response = await postJson(`${baseUrl}/v1/chat/completions`, {
      model,
      messages: [{ role: 'user', content: 'Use get_weather for Seoul. Return a tool call only.' }],
      tools: [openAiChatWeatherTool()],
      tool_choice: 'required',
      // gpt-5.6+ rejects function tools on /v1/chat/completions unless
      // reasoning_effort is 'none'; sent to both sides to keep the pair identical.
      reasoning_effort: 'none',
      max_completion_tokens: 128,
    }, openAiHeaders(isApi));
    assertOpenAiChatResponseShape(response.body, 'tool_calls');
    toolCall = response.body.choices?.[0]?.message?.tool_calls?.[0];
    assertEqual(toolCall?.type, 'function', 'chat tool type');
    assertEqual(toolCall?.function?.name, 'get_weather', 'chat tool name');
    const args = parseJson(toolCall?.function?.arguments, 'chat tool arguments');
    assertEqual(args.city, 'Seoul', 'chat tool city');
    return { totalMs: response.totalMs, toolName: toolCall.function.name, args, usage: response.body.usage };
  });

  await benchmarkCase(target, 'openai.chat.tool_call_stream.schema_exact', repeats, async () => {
    const response = await postSse(`${baseUrl}/v1/chat/completions`, {
      model,
      stream: true,
      messages: [{ role: 'user', content: 'Use get_weather for Seoul. Return a tool call only.' }],
      tools: [openAiChatWeatherTool()],
      tool_choice: 'required',
      // gpt-5.6+ rejects function tools on /v1/chat/completions unless
      // reasoning_effort is 'none'; sent to both sides to keep the pair identical.
      reasoning_effort: 'none',
      max_completion_tokens: 128,
    }, openAiHeaders(isApi), () => '', (_event, payload) => {
      const calls = payload?.choices?.[0]?.delta?.tool_calls;
      if (!Array.isArray(calls)) return '';
      return calls.map((call) => call?.function?.arguments ?? '').join('');
    });
    const args = parseJson(response.toolArguments, 'chat streamed tool arguments');
    assertEqual(args.city, 'Seoul', 'chat streamed tool city');
    assertOpenAiChatToolStreamShape(response.events);
    return responseSummary(response);
  });

  await benchmarkCase(target, 'openai.chat.tool_result.schema_exact', repeats, async () => {
    toolCall ??= benchmarkChatToolCall();
    const expected = 'WEATHER_RESULT_CITY=Seoul;TEMP_C=23;CONDITION=clear';
    const response = await postJson(`${baseUrl}/v1/chat/completions`, {
      model,
      messages: [
        { role: 'user', content: `Use get_weather, then reply with exactly: ${expected}` },
        { role: 'assistant', content: null, tool_calls: [toolCall] },
        {
          role: 'tool',
          tool_call_id: toolCall.id,
          content: '{"city":"Seoul","temperature_c":23,"condition":"clear"}',
        },
      ],
      tools: [openAiChatWeatherTool()],
      tool_choice: 'auto',
      reasoning_effort: 'none',
      max_completion_tokens: 128,
    }, openAiHeaders(isApi));
    assertOpenAiChatResponseShape(response.body, 'stop');
    assertEqual(response.body.choices?.[0]?.message?.content, expected, 'chat tool result text');
    return { totalMs: response.totalMs, text: expected, usage: response.body.usage };
  });

  if (includeMultimodal) {
    await benchmarkCase(target, 'openai.chat.image.schema_exact', repeats, async () => {
      const response = await postJson(`${baseUrl}/v1/chat/completions`, {
        model,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'Identify the dominant color. Reply exactly one uppercase word: RED, GREEN, or BLUE.' },
            { type: 'image_url', image_url: { url: visionDataUrl(), detail: 'high' } },
          ],
        }],
        max_completion_tokens: 32,
      }, openAiHeaders(isApi));
      assertOpenAiChatResponseShape(response.body, 'stop');
      assertEqual(response.body.choices?.[0]?.message?.content, 'RED', 'chat image color');
      return { totalMs: response.totalMs, text: 'RED', usage: response.body.usage };
    });

    await benchmarkCase(target, 'openai.chat.multi_image.schema_exact', repeats, async () => {
      const response = await postJson(`${baseUrl}/v1/chat/completions`, {
        model,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'Two images follow. Identify the dominant colors in image order. Reply exactly: RED,BLUE' },
            { type: 'image_url', image_url: { url: fixtureDataUrl('red_square'), detail: 'high' } },
            { type: 'image_url', image_url: { url: fixtureDataUrl('blue_square'), detail: 'high' } },
          ],
        }],
        max_completion_tokens: 32,
      }, openAiHeaders(isApi));
      assertOpenAiChatResponseShape(response.body, 'stop');
      const text = response.body.choices?.[0]?.message?.content;
      assertEqual(text, 'RED,BLUE', 'chat multi-image color order');
      return { totalMs: response.totalMs, text, fixtures: ['red_square', 'blue_square'], usage: response.body.usage };
    });
  }

  if (qualityRepeats > 0) {
    await benchmarkQualityCase(target, 'openai.chat.quality_distribution', qualityRepeats, async () => {
      const response = await postJson(`${baseUrl}/v1/chat/completions`, {
        model,
        messages: [{ role: 'user', content: qualityPrompt() }],
        max_completion_tokens: 640,
      }, openAiHeaders(isApi));
      const text = response.body.choices?.[0]?.message?.content ?? '';
      assertOpenAiChatResponseShape(response.body, 'stop');
      return { totalMs: response.totalMs, text, quality: scoreQualityOutput(text) };
    });
  }

  if (shouldRunSemanticQuality(target)) {
    for (const task of semanticQualityTasks()) {
      await benchmarkQualityCase(target, `openai.chat.semantic_quality.${task.id}`, semanticQualityRepeats, async (index) => {
        const prompt = task.prompt;
        const response = await postJson(`${baseUrl}/v1/chat/completions`, {
          model,
          messages: [{ role: 'user', content: prompt }],
          max_completion_tokens: 640,
        }, openAiHeaders(isApi));
        const text = response.body.choices?.[0]?.message?.content ?? '';
        assertOpenAiChatResponseShape(response.body, 'stop');
        const { reference, referenceError } = await safeSemanticReference('openai.chat', target, `${task.id}:${index}`, prompt);
        const judged = await scoreSemanticQuality({
          target,
          caseName: `openai.chat.semantic_quality.${task.id}`,
          prompt,
          text,
          reference,
        });
        return { totalMs: response.totalMs, text, quality: scoreQualityOutput(text, task), ...judged, referenceError };
      });
    }
  }

  if (requestReasoningEffort && !expectProviderErrors && shouldRunSemanticQuality(target)) {
    await benchmarkQualityCase(target, 'openai.chat.request_reasoning_effort.semantic_quality', semanticQualityRepeats, async (index) => {
      const task = semanticQualityTasks()[0];
      const prompt = task.prompt;
      const response = await postJson(`${baseUrl}/v1/chat/completions`, {
        model,
        reasoning_effort: requestReasoningEffort,
        messages: [{ role: 'user', content: prompt }],
        max_completion_tokens: 640,
      }, openAiHeaders(isApi));
      const text = response.body.choices?.[0]?.message?.content ?? '';
      assertOpenAiChatResponseShape(response.body, 'stop');
      const { reference, referenceError } = await safeSemanticReference('openai.chat', target, `request_reasoning:${requestReasoningEffort}:${index}`, prompt, {
        openAiReasoningEffort: requestReasoningEffort,
      });
      const judged = await scoreSemanticQuality({
        target,
        caseName: 'openai.chat.request_reasoning_effort.semantic_quality',
        prompt,
        text,
        reference,
      });
      return {
        totalMs: response.totalMs,
        text,
        requestReasoningEffort,
        quality: scoreQualityOutput(text, task),
        ...judged,
        referenceError,
      };
    });
  }
}

async function benchmarkOpenAiCompatible(target, baseUrl, model, isApi) {
  await benchmarkCase(target, 'openai.responses.text', repeats, async (index) => {
    const token = tokenFor(target, 'OPENAI_TEXT', index);
    const response = await postJson(`${baseUrl}/v1/responses`, {
      model,
      input: exactPrompt(token),
      max_output_tokens: 64,
    }, openAiHeaders(isApi));
    const text = extractOpenAiResponseText(response.body);
    assertOpenAiResponsesShape(response.body);
    assertEqual(text, token, 'responses text');
    return { totalMs: response.totalMs, text };
  });

  if (requestReasoningEffort) {
    await benchmarkCase(target, 'openai.responses.request_reasoning_effort.schema_exact', repeats, async (index) => {
      const token = tokenFor(target, `RESPONSES_REASONING_${requestReasoningEffort.toUpperCase()}`, index);
      const body = {
        model,
        reasoning: { effort: requestReasoningEffort },
        input: exactPrompt(token),
        max_output_tokens: 64,
      };
      if (expectProviderErrors) {
        return await postJsonExpectOpenAiError(`${baseUrl}/v1/responses`, body, openAiHeaders(isApi), {
          status: 400,
          type: 'invalid_request_error',
          param: 'reasoning.effort',
          code: 'unsupported_value',
        });
      }
      const response = await postJson(`${baseUrl}/v1/responses`, body, openAiHeaders(isApi));
      const text = extractOpenAiResponseText(response.body);
      assertOpenAiResponsesShape(response.body);
      assertEqual(text, token, 'responses reasoning effort text');
      return { totalMs: response.totalMs, text, requestReasoningEffort, usage: response.body.usage };
    });
  }

  await benchmarkCase(target, 'openai.responses.stream', repeats, async (index) => {
    const token = tokenFor(target, 'OPENAI_STREAM', index);
    const response = await postSse(`${baseUrl}/v1/responses`, {
      model,
      input: exactPrompt(token),
      max_output_tokens: 64,
      stream: true,
      stream_options: isApi ? { include_obfuscation: false } : undefined,
    }, openAiHeaders(isApi), (event, payload) => {
      if (event === 'response.output_text.delta') return payload.delta ?? '';
      if (payload?.type === 'response.output_text.delta') return payload.delta ?? '';
      return '';
    });
    assertEqual(response.text, token, 'stream text');
    assertOpenAiResponsesStreamShape(response.events, ['response.created', 'response.in_progress']);
    return responseSummary(response);
  });

  await benchmarkCase(target, 'openai.responses.tool_call', repeats, async () => {
    const response = await postJson(`${baseUrl}/v1/responses`, {
      model,
      input: 'Use get_weather for Seoul. Return a tool call only.',
      max_output_tokens: 128,
      tools: [openAiWeatherTool()],
      tool_choice: 'required',
    }, openAiHeaders(isApi));
    assertOpenAiResponsesShape(response.body);
    const call = extractOpenAiFunctionCall(response.body);
    assertEqual(call?.name, 'get_weather', 'tool name');
    const args = parseJson(call?.arguments, 'tool arguments');
    assertEqual(args.city, 'Seoul', 'tool city');
    return { totalMs: response.totalMs, toolName: call.name, args };
  });

  await benchmarkCase(target, 'openai.responses.tool_call_stream.schema_exact', repeats, async () => {
    const response = await postSse(`${baseUrl}/v1/responses`, {
      model,
      input: 'Use get_weather for Seoul. Return a tool call only.',
      max_output_tokens: 128,
      stream: true,
      stream_options: isApi ? { include_obfuscation: false } : undefined,
      tools: [openAiWeatherTool()],
      tool_choice: 'required',
    }, openAiHeaders(isApi), () => '', (event, payload) => {
      if (event === 'response.function_call_arguments.delta') return payload.delta ?? '';
      return '';
    });
    const args = parseJson(response.toolArguments, 'responses streamed tool arguments');
    assertEqual(args.city, 'Seoul', 'responses streamed tool city');
    assertOpenAiResponsesStreamShape(response.events, [
      'response.created',
      'response.in_progress',
      'response.output_item.added',
      'response.function_call_arguments.delta',
      'response.function_call_arguments.done',
      'response.output_item.done',
      'response.completed',
    ]);
    return responseSummary(response);
  });

  if (includeMultimodal) {
    await benchmarkCase(target, 'openai.responses.image.schema_exact', repeats, async () => {
      const response = await postJson(`${baseUrl}/v1/responses`, {
        model,
        input: [{
          role: 'user',
          content: [
            { type: 'input_image', image_url: visionDataUrl(), detail: 'high' },
            { type: 'input_text', text: 'Identify the dominant color. Reply exactly one uppercase word: RED, GREEN, or BLUE.' },
          ],
        }],
        max_output_tokens: 32,
      }, openAiHeaders(isApi));
      assertOpenAiResponsesShape(response.body);
      assertEqual(extractOpenAiResponseText(response.body), 'RED', 'responses image color');
      return { totalMs: response.totalMs, text: 'RED', usage: response.body.usage };
    });

    await benchmarkCase(target, 'openai.responses.multi_image.schema_exact', repeats, async () => {
      const response = await postJson(`${baseUrl}/v1/responses`, {
        model,
        input: [{
          role: 'user',
          content: [
            { type: 'input_text', text: 'Two images follow. Identify the dominant colors in image order. Reply exactly: RED,BLUE' },
            { type: 'input_image', image_url: fixtureDataUrl('red_square'), detail: 'high' },
            { type: 'input_image', image_url: fixtureDataUrl('blue_square'), detail: 'high' },
          ],
        }],
        max_output_tokens: 32,
      }, openAiHeaders(isApi));
      assertOpenAiResponsesShape(response.body);
      const text = extractOpenAiResponseText(response.body);
      assertEqual(text, 'RED,BLUE', 'responses multi-image color order');
      return { totalMs: response.totalMs, text, fixtures: ['red_square', 'blue_square'], usage: response.body.usage };
    });
  }

  if (qualityRepeats > 0) {
    await benchmarkQualityCase(target, 'openai.responses.quality_distribution', qualityRepeats, async () => {
      const response = await postJson(`${baseUrl}/v1/responses`, {
        model,
        input: qualityPrompt(),
        max_output_tokens: 640,
      }, openAiHeaders(isApi));
      assertOpenAiResponsesShape(response.body);
      const text = extractOpenAiResponseText(response.body) ?? '';
      return { totalMs: response.totalMs, text, quality: scoreQualityOutput(text) };
    });
  }

  if (shouldRunSemanticQuality(target)) {
    for (const task of semanticQualityTasks()) {
      await benchmarkQualityCase(target, `openai.responses.semantic_quality.${task.id}`, semanticQualityRepeats, async (index) => {
        const prompt = task.prompt;
        const response = await postJson(`${baseUrl}/v1/responses`, {
          model,
          input: prompt,
          max_output_tokens: 640,
        }, openAiHeaders(isApi));
        assertOpenAiResponsesShape(response.body);
        const text = extractOpenAiResponseText(response.body) ?? '';
        const { reference, referenceError } = await safeSemanticReference('openai.responses', target, `${task.id}:${index}`, prompt);
        const judged = await scoreSemanticQuality({
          target,
          caseName: `openai.responses.semantic_quality.${task.id}`,
          prompt,
          text,
          reference,
        });
        return { totalMs: response.totalMs, text, quality: scoreQualityOutput(text, task), ...judged, referenceError };
      });
    }
  }
}

async function benchmarkOpenAiImageGenerationCompatible(target, baseUrl, isApi) {
  if (isApi) {
    await benchmarkCase(target, imageGenerationCaseNames.directImagesGeneration, repeats, async () => {
      const prompt = 'A simple flat red square centered on a white background. No text.';
      return await directImagesSample(`${baseUrl}/v1/images/generations`, {
        model: openAiImageApiModel,
        prompt,
        size: '1024x1024',
        quality: 'low',
        output_format: 'png',
      }, {
        prompt,
        requirements: ['solid red square', 'white background', 'no text'],
        kind: 'generation',
      });
    });

    await benchmarkCase(target, imageGenerationCaseNames.directImagesEdit, repeats, async () => {
      const prompt = 'Edit this image so the red square becomes green. No text.';
      return await directImagesMultipartSample(`${baseUrl}/v1/images/edits`, {
        model: openAiImageApiModel,
        prompt,
        size: '1024x1024',
        quality: 'low',
      }, [{
        name: 'image[]',
        filename: 'red-square.png',
        contentType: 'image/png',
        data: fixtureImageBytes('red_square'),
      }], {
        prompt,
        requirements: ['green square', 'same simple square composition', 'no text'],
        kind: 'edit',
      });
    });

    await benchmarkCase(target, imageGenerationCaseNames.directImagesImage2Unsupported, repeats, async () => {
      return await postJsonExpectOpenAiErrorShape(`${baseUrl}/v1/images/generations`, {
        model: 'image-2',
        prompt: 'A simple flat red square centered on a white background. No text.',
      }, openAiHeaders(true), {
        status: 400,
        type: 'image_generation_user_error',
      });
    });
  }

  if (!isApi) {
    await benchmarkCase(target, imageGenerationCaseNames.proxyGptImageResponseFormatUnsupported, repeats, async () => {
      return await postJsonExpectOpenAiErrorShape(`${baseUrl}/v1/images/generations`, {
        model: openAiImageApiModel,
        prompt: 'A simple flat red square centered on a white background. No text.',
        response_format: 'b64_json',
      }, openAiHeaders(false), {
        status: 400,
        type: 'invalid_request_error',
        param: 'response_format',
        code: 'unknown_parameter',
      });
    });
  }

  await benchmarkCase(target, imageGenerationCaseNames.generationB64, repeats, async () => {
    const prompt = 'A simple flat red square centered on a white background. No text.';
    return isApi
      ? await directResponsesImageSample(baseUrl, prompt, {
          action: 'generate',
          judge: {
            prompt,
            requirements: ['solid red square', 'white background', 'no text'],
            kind: 'generation',
          },
        })
      : await proxyImagesSample(`${baseUrl}/v1/images/generations`, {
          prompt,
          response_format: 'b64_json',
        }, {
          prompt,
          requirements: ['solid red square', 'white background', 'no text'],
          kind: 'generation',
        });
  });

  await benchmarkCase(target, imageGenerationCaseNames.generationB64N3Parallel, repeats, async () => {
    const prompt = 'A simple flat red square centered on a white background. No text.';
    const judge = {
      prompt,
      requirements: ['solid red square', 'white background', 'no text'],
      kind: 'generation',
    };
    return isApi
      ? await directResponsesImageSamplesParallel(baseUrl, prompt, {
          count: 3,
          action: 'generate',
          judge,
        })
      : await proxyImagesMultiSample(`${baseUrl}/v1/images/generations`, {
          prompt,
          n: 3,
          response_format: 'b64_json',
        }, judge);
  });

  await benchmarkCase(target, imageGenerationCaseNames.generationApiFields, repeats, async () => {
    const prompt = 'A simple flat red square centered on a white background. No text.';
    const imageOptions = {
      size: '1024x1536',
      quality: 'medium',
      output_format: 'webp',
      output_compression: 80,
      background: 'opaque',
      moderation: 'low',
    };
    return isApi
      ? await directResponsesImageSample(baseUrl, prompt, {
          action: 'generate',
          imageOptions,
          judge: {
            prompt,
            requirements: ['solid red square', 'white background', 'no text', 'portrait aspect ratio'],
            kind: 'generation',
          },
        })
      : await proxyImagesSample(`${baseUrl}/v1/images/generations`, {
          prompt,
          response_format: 'b64_json',
          ...imageOptions,
          user: 'api-benchmark-user',
        }, {
          prompt,
          requirements: ['solid red square', 'white background', 'no text', 'portrait aspect ratio'],
          kind: 'generation',
        });
  });

  if (!isApi) {
    await benchmarkCase(target, imageGenerationCaseNames.generationUrl, repeats, async () => {
      const prompt = 'A simple flat red square centered on a white background. No text.';
      return await proxyImagesSample(`${baseUrl}/v1/images/generations`, {
        prompt,
        response_format: 'url',
      }, {
        prompt,
        requirements: ['solid red square', 'white background', 'no text'],
        kind: 'generation',
      });
    });
  }

  await benchmarkCase(target, imageGenerationCaseNames.generationStream, repeats, async () => {
    return await openAiImageGenerationStreamSample(baseUrl, isApi);
  });

  await benchmarkCase(target, imageGenerationCaseNames.generationPhotorealProduct, repeats, async () => {
    const prompt = 'A photorealistic studio product photo of a matte teal ceramic coffee mug on a light gray tabletop, soft natural window light, shallow realistic shadow, no text.';
    const imageOptions = {
      size: '1024x1024',
      quality: 'medium',
      output_format: 'png',
    };
    const judge = {
      prompt,
      requirements: ['photorealistic product photo', 'matte teal ceramic mug', 'light gray tabletop', 'soft natural light', 'no text'],
      kind: 'photorealistic generation',
    };
    return isApi
      ? await directResponsesImageSample(baseUrl, prompt, {
          action: 'generate',
          imageOptions,
          judge,
        })
      : await proxyImagesSample(`${baseUrl}/v1/images/generations`, {
          prompt,
          response_format: 'b64_json',
          ...imageOptions,
        }, judge);
  });

  await benchmarkCase(target, imageGenerationCaseNames.generationAssetIcon, repeats, async () => {
    const prompt = 'A clean app icon style illustration of a yellow rain boot with a small blue puddle, centered on a plain white background, no text.';
    const imageOptions = {
      size: '1024x1024',
      quality: 'medium',
      output_format: 'png',
      background: 'opaque',
    };
    const judge = {
      prompt,
      requirements: ['yellow rain boot', 'small blue puddle', 'centered icon illustration', 'plain white background', 'no text'],
      kind: 'asset icon generation',
    };
    return isApi
      ? await directResponsesImageSample(baseUrl, prompt, {
          action: 'generate',
          imageOptions,
          judge,
        })
      : await proxyImagesSample(`${baseUrl}/v1/images/generations`, {
          prompt,
          response_format: 'b64_json',
          ...imageOptions,
        }, judge);
  });

  await benchmarkCase(target, imageGenerationCaseNames.generationTextPoster, repeats, async () => {
    const prompt = 'A clean square launch poster with exactly the words "LAUNCH DAY" in large bold white sans-serif letters centered above a small silver rocket icon, dark navy background. No other text.';
    const imageOptions = {
      size: '1024x1024',
      quality: 'medium',
      output_format: 'png',
    };
    const judge = {
      prompt,
      requirements: ['exact text LAUNCH DAY', 'large bold white sans-serif lettering', 'small silver rocket icon', 'dark navy background', 'no other text'],
      kind: 'text poster generation',
    };
    return isApi
      ? await directResponsesImageSample(baseUrl, prompt, {
          action: 'generate',
          imageOptions,
          judge,
        })
      : await proxyImagesSample(`${baseUrl}/v1/images/generations`, {
          prompt,
          response_format: 'b64_json',
          ...imageOptions,
        }, judge);
  });

  await benchmarkCase(target, imageGenerationCaseNames.referenceStyleGeneration, repeats, async () => {
    const prompt = [
      'Use the attached style reference image to create a new flat vector icon of a yellow rain boot beside a small blue puddle.',
      'Match the reference style: thick navy outline, coral accent stripe, simple geometric shapes, and a soft cream background.',
      'Do not copy the reference subject. No text.',
    ].join(' ');
    const referenceImages = [fixtureDataUrl('style_reference_card')];
    const imageOptions = {
      size: '1024x1024',
      quality: 'medium',
      output_format: 'png',
    };
    const judge = {
      prompt,
      requirements: [
        'yellow rain boot',
        'small blue puddle',
        'flat vector icon',
        'thick navy outline from reference',
        'coral accent stripe from reference',
        'soft cream background from reference',
        'does not copy the reference subject',
        'no text',
      ],
      referenceImages,
      kind: 'reference-guided style generation',
    };
    return isApi
      ? await directResponsesImageSample(baseUrl, prompt, {
          action: 'edit',
          images: referenceImages,
          imageOptions,
          judge,
        })
      : await proxyImagesSample(`${baseUrl}/v1/images/edits`, {
          prompt,
          images: referenceImages.map((image_url) => ({ image_url })),
          response_format: 'b64_json',
          ...imageOptions,
        }, judge);
  });

  await benchmarkCase(target, imageGenerationCaseNames.referenceProductGeneration, repeats, async () => {
    const prompt = [
      'Use the attached product reference image as the product identity reference.',
      'Generate a photorealistic studio product image of the same matte teal mug, keeping the rounded mug body, right-side handle, dark rim, and teal color family.',
      'Place it on a light gray tabletop with soft window light. No text.',
    ].join(' ');
    const referenceImages = [fixtureDataUrl('teal_mug_reference')];
    const imageOptions = {
      size: '1024x1024',
      quality: 'medium',
      output_format: 'png',
    };
    const judge = {
      prompt,
      requirements: [
        'photorealistic studio product image',
        'same matte teal mug identity from reference',
        'rounded mug body',
        'right-side handle',
        'dark rim',
        'light gray tabletop',
        'soft window light',
        'no text',
      ],
      referenceImages,
      kind: 'reference-guided product generation',
    };
    return isApi
      ? await directResponsesImageSample(baseUrl, prompt, {
          action: 'edit',
          images: referenceImages,
          imageOptions,
          judge,
        })
      : await proxyImagesSample(`${baseUrl}/v1/images/edits`, {
          prompt,
          images: referenceImages.map((image_url) => ({ image_url })),
          response_format: 'b64_json',
          ...imageOptions,
        }, judge);
  });

  await benchmarkCase(target, imageGenerationCaseNames.referenceMultiGeneration, repeats, async () => {
    const prompt = [
      'Use the first attached image as the product reference and the second attached image as the color/style palette reference.',
      'Generate a clean ecommerce hero image of the same teal mug on a warm sand background with navy and coral geometric accent shapes inspired by the palette reference.',
      'Keep the mug recognizable with a right-side handle and dark rim. No text.',
    ].join(' ');
    const referenceImages = [
      fixtureDataUrl('teal_mug_reference'),
      fixtureDataUrl('warm_palette_reference'),
    ];
    const imageOptions = {
      size: '1024x1024',
      quality: 'medium',
      output_format: 'png',
    };
    const judge = {
      prompt,
      requirements: [
        'clean ecommerce hero image',
        'same teal mug identity from first reference',
        'right-side handle',
        'dark rim',
        'warm sand background from second reference',
        'navy geometric accents from second reference',
        'coral geometric accents from second reference',
        'no text',
      ],
      referenceImages,
      kind: 'multi-reference guided generation',
    };
    return isApi
      ? await directResponsesImageSample(baseUrl, prompt, {
          action: 'edit',
          images: referenceImages,
          imageOptions,
          judge,
        })
      : await proxyImagesSample(`${baseUrl}/v1/images/edits`, {
          prompt,
          images: referenceImages.map((image_url) => ({ image_url })),
          response_format: 'b64_json',
          ...imageOptions,
        }, judge);
  });

  await benchmarkCase(target, imageGenerationCaseNames.edit, repeats, async () => {
    const prompt = 'Edit this image so the red square becomes green. No text.';
    return isApi
      ? await directResponsesImageSample(baseUrl, prompt, {
          action: 'edit',
          images: [fixtureDataUrl('red_square')],
          imageOptions: {
            size: '1024x1024',
            quality: 'low',
            output_format: 'png',
          },
          judge: {
            prompt,
            requirements: ['green square', 'same simple square composition', 'no text'],
            kind: 'edit',
          },
        })
      : await proxyImagesSample(`${baseUrl}/v1/images/edits`, {
          prompt,
          images: [{ image_url: fixtureDataUrl('red_square') }],
          response_format: 'b64_json',
        }, {
          prompt,
          requirements: ['green square', 'same simple square composition', 'no text'],
          kind: 'edit',
        });
  });

  await benchmarkCase(target, imageGenerationCaseNames.editPreserveComposition, repeats, async () => {
    const prompt = 'Edit this image by changing only the white background to pale blue. Keep the red square unchanged, centered, and the same size. No text.';
    const imageOptions = {
      size: '1024x1024',
      quality: 'low',
      output_format: 'png',
    };
    const judge = {
      prompt,
      requirements: ['pale blue background', 'red square unchanged', 'same centered composition', 'same square size', 'no text'],
      kind: 'preservation edit',
    };
    return isApi
      ? await directResponsesImageSample(baseUrl, prompt, {
          action: 'edit',
          images: [fixtureDataUrl('red_square_on_white')],
          imageOptions,
          judge,
        })
      : await proxyImagesSample(`${baseUrl}/v1/images/edits`, {
          prompt,
          images: [{ image_url: fixtureDataUrl('red_square_on_white') }],
          response_format: 'b64_json',
          ...imageOptions,
        }, judge);
  });

  await benchmarkCase(target, imageGenerationCaseNames.editMultiImage, repeats, async () => {
    const prompt = 'Use the red and blue reference images to create one clean purple square on a white background. No text.';
    const images = [fixtureDataUrl('red_square'), fixtureDataUrl('blue_square')];
    return isApi
      ? await directResponsesImageSample(baseUrl, prompt, {
          action: 'edit',
          images,
          imageOptions: {
            size: '1024x1024',
            quality: 'low',
            output_format: 'png',
          },
          judge: {
            prompt,
            requirements: ['purple square', 'white background', 'no text', 'uses red and blue references'],
            kind: 'multi-image edit',
          },
        })
      : await proxyImagesSample(`${baseUrl}/v1/images/edits`, {
          prompt,
          images: images.map((image_url) => ({ image_url })),
          response_format: 'b64_json',
        }, {
          prompt,
          requirements: ['purple square', 'white background', 'no text', 'uses red and blue references'],
          kind: 'multi-image edit',
        });
  });

  if (!isApi) {
    await benchmarkCase(target, imageGenerationCaseNames.editMultipartStream, repeats, async () => {
      const prompt = 'Edit this image so the red square becomes green. No text.';
      const response = await postSseMultipart(`${baseUrl}/v1/images/edits`, {
        model: 'image-2',
        prompt,
        stream: 'true',
        size: '1024x1024',
        quality: 'low',
        output_format: 'png',
      }, [{
        name: 'image[]',
        filename: 'red-square.png',
        contentType: 'image/png',
        data: fixtureImageBytes('red_square'),
      }], openAiMultipartHeaders(false), () => '', imageStreamCollector);
      assertImageStreamShape(response.events, 'images-edit');
      return imageStreamSummary(response, 'images');
    });
  }

  await benchmarkCase(target, imageGenerationCaseNames.variation, repeats, async () => {
    const prompt = 'Create a clean visual variation of the provided image. No text.';
    return isApi
      ? await directResponsesImageSample(baseUrl, prompt, {
          action: 'edit',
          images: [fixtureDataUrl('red_square')],
          judge: {
            prompt,
            requirements: ['red visual variation', 'simple square-like composition', 'no text'],
            kind: 'variation baseline through responses edit',
          },
        })
      : await proxyImagesMultipartSample(`${baseUrl}/v1/images/variations`, {
          model: 'image-2',
          response_format: 'b64_json',
          size: '1024x1024',
        }, [{
          name: 'image',
          filename: 'red-square.png',
          contentType: 'image/png',
          data: fixtureImageBytes('red_square'),
        }], {
          prompt,
          requirements: ['red visual variation', 'simple square-like composition', 'no text'],
          kind: 'variation',
        });
  });

  await benchmarkCase(target, imageGenerationCaseNames.errorMissingPrompt, repeats, async () => {
    return await postJsonExpectOpenAiErrorShape(`${baseUrl}/v1/images/generations`, {
      model: isApi ? openAiImageApiModel : 'image-2',
      response_format: 'b64_json',
    }, openAiHeaders(isApi), {
      status: 400,
      type: 'invalid_request_error',
    });
  });

  await benchmarkCase(target, imageGenerationCaseNames.errorInvalidOutputCompression, repeats, async () => {
    return await postJsonExpectOpenAiErrorShape(`${baseUrl}/v1/images/generations`, {
      model: isApi ? openAiImageApiModel : 'image-2',
      prompt: 'A simple flat red square centered on a white background. No text.',
      output_format: 'png',
      output_compression: 80,
    }, openAiHeaders(isApi), {
      status: 400,
      type: 'image_generation_user_error',
      param: null,
      code: 'invalid_png_output_compression',
    });
  });

  await benchmarkCase(target, imageGenerationCaseNames.backgroundTransparentUnsupported, repeats, async () => {
    const prompt = 'A clean app icon style illustration of a yellow rain boot with a small blue puddle, centered, transparent background, no text.';
    if (isApi) {
      return await postJsonExpectOpenAiErrorShape(`${baseUrl}/v1/responses`, {
        model: openAiModel,
        input: image2ViaGpt55Prompt({
          action: 'generate',
          prompt,
          size: '1024x1024',
          quality: 'medium',
          outputFormat: 'png',
          background: 'transparent',
        }),
        reasoning: { effort: openAiImageQualityReasoningEffort('medium') },
        tools: [{
          type: 'image_generation',
          action: 'generate',
          size: '1024x1024',
          quality: 'medium',
          output_format: 'png',
          background: 'transparent',
        }],
      }, openAiHeaders(true), {
        status: 400,
        type: 'image_generation_user_error',
        param: 'tools',
        code: 'invalid_value',
      });
    }
    return await postJsonExpectOpenAiErrorShape(`${baseUrl}/v1/images/generations`, {
      model: 'image-2',
      prompt,
      background: 'transparent',
      output_format: 'png',
      response_format: 'b64_json',
    }, openAiHeaders(false), {
      status: 400,
      type: 'image_generation_user_error',
      param: 'tools',
      code: 'invalid_value',
    });
  });

  await benchmarkCase(target, imageGenerationCaseNames.inputFidelityDisabled, repeats, async () => {
    const prompt = 'Edit this image so the red square becomes green. No text.';
    if (isApi) {
      return await postJsonExpectOpenAiErrorShape(`${baseUrl}/v1/responses`, {
        model: openAiModel,
        input: responsesImageInput(prompt, [fixtureDataUrl('red_square')]),
        reasoning: { effort: openAiImageQualityReasoningEffort('low') },
        tools: [{
          type: 'image_generation',
          action: 'edit',
          size: '1024x1024',
          quality: 'low',
          output_format: 'png',
          input_fidelity: 'high',
        }],
      }, openAiHeaders(true), {
        status: 400,
        type: 'image_generation_user_error',
        param: 'tools',
        code: 'invalid_input_fidelity_model',
      });
    }
    return await postJsonExpectOpenAiErrorShape(`${baseUrl}/v1/images/edits`, {
      model: 'image-2',
      prompt,
      images: [{ image_url: fixtureDataUrl('red_square') }],
      input_fidelity: 'high',
      response_format: 'b64_json',
    }, openAiHeaders(false), {
      status: 400,
      type: 'image_generation_user_error',
      param: 'tools',
      code: 'invalid_input_fidelity_model',
    });
  });

  await benchmarkCase(target, imageGenerationCaseNames.errorVariationJson, repeats, async () => {
    return await postJsonExpectOpenAiErrorShape(`${baseUrl}/v1/images/variations`, {
      model: isApi ? 'dall-e-2' : 'image-2',
      image: fixtureDataUrl('red_square'),
      response_format: 'b64_json',
    }, openAiHeaders(isApi), {
      status: isApi ? 404 : 400,
      type: isApi ? undefined : 'invalid_request_error',
      allowEmptyBody: isApi,
    });
  });
}

async function proxyImagesSample(url, body, judgeSpec) {
  const response = await postJson(url, {
    model: 'image-2',
    n: 1,
    size: '1024x1024',
    quality: 'low',
    output_format: 'png',
    ...body,
  }, openAiHeaders(false));
  assertOpenAiImagesGenerationShape(response.body);
  return await imagesApiSampleSummary(response, 'images', response.body.data[0], judgeSpec);
}

async function proxyImagesMultiSample(url, body, judgeSpec) {
  const response = await postJson(url, {
    model: 'image-2',
    n: 1,
    size: '1024x1024',
    quality: 'low',
    output_format: 'png',
    ...body,
  }, openAiHeaders(false));
  assertOpenAiImagesGenerationShape(response.body);
  if (Number.isInteger(body.n)) {
    assert(response.body.data.length === body.n, `images generation data length must match n=${body.n}`);
  }
  return await imagesApiMultiSampleSummary(response, 'images', judgeSpec);
}

async function proxyImagesMultipartSample(url, fields, files, judgeSpec) {
  const response = await postMultipart(url, fields, files, openAiMultipartHeaders(false));
  assertOpenAiImagesGenerationShape(response.body);
  return await imagesApiSampleSummary(response, 'images', response.body.data[0], judgeSpec);
}

async function directImagesSample(url, body, judgeSpec) {
  const response = await postJson(url, body, openAiHeaders(true));
  assertOpenAiImagesGenerationShape(response.body);
  return await imagesApiSampleSummary(response, 'images-direct', response.body.data[0], judgeSpec);
}

async function directImagesMultipartSample(url, fields, files, judgeSpec) {
  const response = await postMultipart(url, fields, files, openAiMultipartHeaders(true));
  assertOpenAiImagesGenerationShape(response.body);
  return await imagesApiSampleSummary(response, 'images-direct', response.body.data[0], judgeSpec);
}

async function imagesApiSampleSummary(response, responseApi, image, judgeSpec) {
  const b64Json = await imageB64Json(image);
  const imageQuality = b64Json
    ? await maybeScoreImageQuality({
        ...judgeSpec,
        b64Json,
        mediaType: mediaTypeForOutputFormat(response.body.output_format),
      })
    : null;
  return {
    totalMs: response.totalMs,
    responseApi,
    resultBytesApprox: b64Json ? Math.floor(b64Json.length * 3 / 4) : undefined,
    hasUrl: typeof image.url === 'string',
    revisedPrompt: truncate(image.revised_prompt ?? ''),
    size: response.body.size,
    quality: response.body.quality,
    outputFormat: response.body.output_format,
    background: response.body.background,
    ...(response.body.usage ? { usage: response.body.usage } : {}),
    ...(imageQuality ? { imageQuality } : {}),
  };
}

async function imagesApiMultiSampleSummary(response, responseApi, judgeSpec) {
  const images = response.body.data;
  const b64Jsons = await Promise.all(images.map((image) => imageB64Json(image)));
  const imageQualities = await Promise.all(b64Jsons.map((b64Json) => b64Json
    ? maybeScoreImageQuality({
        ...judgeSpec,
        b64Json,
        mediaType: mediaTypeForOutputFormat(response.body.output_format),
      })
    : null));
  const resultBytesApprox = b64Jsons
    .filter((b64Json) => typeof b64Json === 'string')
    .reduce((sum, b64Json) => sum + Math.floor(b64Json.length * 3 / 4), 0);
  return {
    totalMs: response.totalMs,
    responseApi,
    imageCount: images.length,
    resultBytesApprox,
    hasUrl: images.some((image) => typeof image.url === 'string'),
    revisedPrompt: truncate(images.map((image) => image.revised_prompt).filter(Boolean).join(' | ')),
    size: response.body.size,
    quality: response.body.quality,
    outputFormat: response.body.output_format,
    background: response.body.background,
    ...(response.body.usage ? { usage: response.body.usage } : {}),
    ...aggregateImageQualityResult(imageQualities),
  };
}

async function directResponsesImageSample(baseUrl, prompt, options) {
  const imageOptions = options.imageOptions ?? {};
  const translatedPrompt = image2ViaGpt55Prompt({
    action: options.action,
    prompt,
    size: imageOptions.size ?? '1024x1024',
    quality: imageOptions.quality ?? 'low',
    outputFormat: imageOptions.output_format ?? 'png',
    outputCompression: imageOptions.output_compression,
    background: imageOptions.background,
    moderation: imageOptions.moderation,
    inputFidelity: imageOptions.input_fidelity,
    imageCount: options.images?.length ?? 0,
  });
  const response = await postJson(`${baseUrl}/v1/responses`, {
    model: openAiModel,
    input: responsesImageInput(translatedPrompt, options.images ?? []),
    reasoning: { effort: openAiImageQualityReasoningEffort(imageOptions.quality) },
    tools: [{
      type: 'image_generation',
      action: options.action,
      size: imageOptions.size ?? '1024x1024',
      quality: imageOptions.quality ?? 'low',
      output_format: imageOptions.output_format ?? 'png',
      ...(imageOptions.output_compression !== undefined ? { output_compression: imageOptions.output_compression } : {}),
      ...(imageOptions.background ? { background: imageOptions.background } : {}),
      ...(imageOptions.moderation ? { moderation: imageOptions.moderation } : {}),
      ...(imageOptions.input_fidelity ? { input_fidelity: imageOptions.input_fidelity } : {}),
    }],
  }, openAiHeaders(true));
  assertOpenAiResponsesShape(response.body);
  const imageCall = response.body.output?.find((item) => item.type === 'image_generation_call');
  assertOpenAiImageGenerationCallShape(imageCall);
  const imageQuality = await maybeScoreImageQuality({
    ...options.judge,
    b64Json: imageCall.result,
    mediaType: mediaTypeForOutputFormat(imageOptions.output_format),
  });
  return {
    totalMs: response.totalMs,
    responseApi: 'responses',
    resultBytesApprox: Math.floor(imageCall.result.length * 3 / 4),
    revisedPrompt: truncate(imageCall.revised_prompt ?? ''),
    usage: response.body.usage,
    ...(imageQuality ? { imageQuality } : {}),
  };
}

async function directResponsesImageSamplesParallel(baseUrl, prompt, options) {
  const count = options.count ?? 1;
  const results = await Promise.all(Array.from({ length: count }, () => directResponsesImageSample(baseUrl, prompt, options)));
  return {
    totalMs: Math.max(...results.map((result) => result.totalMs)),
    responseApi: 'responses-parallel',
    imageCount: results.length,
    resultBytesApprox: results.reduce((sum, result) => sum + (result.resultBytesApprox ?? 0), 0),
    revisedPrompt: truncate(results.map((result) => result.revisedPrompt).filter(Boolean).join(' | ')),
    ...aggregateOpenAiUsageResult(results.map((result) => result.usage)),
    ...aggregateImageQualityResult(results.map((result) => result.imageQuality)),
  };
}

function aggregateImageQualityResult(qualities) {
  const present = qualities.filter(Boolean);
  if (present.length === 0) return {};
  const scores = present.map((quality) => quality.score).filter(Number.isFinite);
  const judgeMs = present
    .map((quality) => quality.judgeMs?.median ?? quality.judgeMs)
    .filter(Number.isFinite);
  return {
    imageQuality: {
      score: Math.min(...scores),
      scoreSummary: summarize(scores),
      requirementFit: medianNumber(present.map((quality) => quality.requirementFit).filter(Number.isFinite)),
      visualCorrectness: medianNumber(present.map((quality) => quality.visualCorrectness).filter(Number.isFinite)),
      artifactControl: medianNumber(present.map((quality) => quality.artifactControl).filter(Number.isFinite)),
      textAccuracy: medianNumber(present.map((quality) => quality.textAccuracy).filter(Number.isFinite)),
      preservation: medianNumber(present.map((quality) => quality.preservation).filter(Number.isFinite)),
      judgeMs: summarize(judgeMs),
      perImageScores: scores,
      samples: present.flatMap((quality) => quality.samples ?? []).slice(0, 6),
      judgeUsage: present.at(-1)?.judgeUsage,
    },
  };
}

function aggregateOpenAiUsageResult(usages) {
  const present = usages.filter(Boolean);
  if (present.length === 0) return {};
  const sum = (path) => present.reduce((total, usage) => {
    let value = usage;
    for (const key of path) value = value?.[key];
    return total + (Number.isFinite(value) ? value : 0);
  }, 0);
  return {
    usage: {
      input_tokens: sum(['input_tokens']),
      output_tokens: sum(['output_tokens']),
      total_tokens: sum(['total_tokens']),
      input_tokens_details: {
        cached_tokens: sum(['input_tokens_details', 'cached_tokens']),
      },
      output_tokens_details: {
        reasoning_tokens: sum(['output_tokens_details', 'reasoning_tokens']),
      },
    },
  };
}

async function imageB64Json(image) {
  if (typeof image.b64_json === 'string') return image.b64_json;
  if (typeof image.url !== 'string') return null;
  const res = await fetch(image.url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`image url fetch failed ${res.status}: ${image.url}`);
  const contentType = res.headers.get('content-type') ?? '';
  if (!contentType.startsWith('image/')) {
    throw new Error(`image url content-type must be image/*, got ${contentType || 'missing'}`);
  }
  return Buffer.from(await res.arrayBuffer()).toString('base64');
}

function responsesImageInput(prompt, images) {
  if (!images.length) return prompt;
  return [{
    role: 'user',
    content: [
      { type: 'input_text', text: prompt },
      ...images.map((image) => ({ type: 'input_image', image_url: image })),
    ],
  }];
}

function imageStreamCollector(event, payload) {
  if (event === 'image_generation.completed') {
    return payload.b64_json ?? '';
  }
  if (event === 'image_edit.completed') {
    return payload.b64_json ?? '';
  }
  if (event === 'response.output_item.done' && payload.item?.type === 'image_generation_call') {
    return payload.item.result ?? '';
  }
  return '';
}

function imageStreamSummary(response, responseApi) {
  const imageBytes = response.toolArguments
    ? Math.floor(response.toolArguments.length * 3 / 4)
    : 0;
  return {
    totalMs: response.totalMs,
    firstDataMs: response.firstDataMs,
    firstTextMs: response.firstTextMs,
    firstToolArgumentMs: response.firstToolArgumentMs,
    firstImageMs: response.firstToolArgumentMs,
    chunks: response.chunks,
    eventTypes: response.events.map(({ event }) => event),
    responseApi,
    resultBytesApprox: imageBytes,
  };
}

async function openAiImageGenerationStreamSample(baseUrl, isApi) {
  const prompt = 'A simple flat red square centered on a white background. No text.';
  const response = isApi
    ? await postSse(`${baseUrl}/v1/responses`, {
        model: openAiModel,
        input: image2ViaGpt55Prompt({
          action: 'generate',
          prompt,
          size: '1024x1024',
          quality: 'low',
          outputFormat: 'png',
        }),
        reasoning: { effort: openAiImageQualityReasoningEffort('low') },
        stream: true,
        tools: [{
          type: 'image_generation',
          action: 'generate',
          size: '1024x1024',
          quality: 'low',
          output_format: 'png',
        }],
      }, openAiHeaders(true), () => '', imageStreamCollector)
    : await postSse(`${baseUrl}/v1/images/generations`, {
        model: 'image-2',
        prompt,
        stream: true,
        size: '1024x1024',
        quality: 'low',
        output_format: 'png',
        response_format: 'b64_json',
      }, openAiHeaders(false), () => '', imageStreamCollector);
  assertImageStreamShape(response.events, isApi ? 'responses' : 'images-generation');
  return imageStreamSummary(response, isApi ? 'responses' : 'images');
}

async function benchmarkOpenAiImageGenerationStreamPair(proxyBaseUrl) {
  const caseName = imageGenerationCaseNames.generationStreamPaired;
  if (!shouldRunImageGenerationPairBenchmark()) return;
  await benchmarkCase(imageGenerationPairTarget, caseName, repeats, async (index) => {
    const proxyRun = async () => openAiImageGenerationStreamSample(proxyBaseUrl, false);
    const directRun = async () => openAiImageGenerationStreamSample('https://api.openai.com', true);
    let proxy;
    let direct;
    const order = index % 2 === 0 ? 'direct-first' : 'proxy-first';
    if (order === 'direct-first') {
      direct = await directRun();
      proxy = await proxyRun();
    } else {
      proxy = await proxyRun();
      direct = await directRun();
    }
    return {
      totalMs: proxy.totalMs,
      firstImageMs: proxy.firstImageMs,
      proxyTotalMs: proxy.totalMs,
      directTotalMs: direct.totalMs,
      proxyFirstImageMs: proxy.firstImageMs,
      directFirstImageMs: direct.firstImageMs,
      firstImageDeltaMs: Number.isFinite(proxy.firstImageMs) && Number.isFinite(direct.firstImageMs)
        ? proxy.firstImageMs - direct.firstImageMs
        : null,
      order,
      proxy,
      direct,
    };
  });
}

async function benchmarkAnthropicCompatible(target, baseUrl, model, isApi) {
  await benchmarkCase(target, 'anthropic.messages.text', repeats, async (index) => {
    const token = tokenFor(target, 'ANTHROPIC_TEXT', index);
    const response = await postJson(`${baseUrl}/v1/messages`, {
      model,
      max_tokens: 64,
      messages: [{ role: 'user', content: exactPrompt(token) }],
    }, anthropicHeaders(isApi));
    const text = response.body.content?.find((block) => block.type === 'text')?.text;
    assertAnthropicMessageShape(response.body, 'end_turn');
    assertEqual(text, token, 'message text');
    return { totalMs: response.totalMs, text };
  });

  await benchmarkCase(target, 'anthropic.messages.stream', repeats, async (index) => {
    const token = tokenFor(target, 'ANTHROPIC_STREAM', index);
    const response = await postSse(`${baseUrl}/v1/messages`, {
      model,
      max_tokens: 64,
      stream: true,
      messages: [{ role: 'user', content: exactPrompt(token) }],
    }, anthropicHeaders(isApi), (event, payload) => {
      if (event === 'content_block_delta') return payload?.delta?.text ?? '';
      if (payload?.type === 'content_block_delta') return payload?.delta?.text ?? '';
      return '';
    });
    assertEqual(response.text, token, 'stream text');
    assertAnthropicStreamShape(response.events);
    return responseSummary(response);
  });

  await benchmarkCase(target, 'anthropic.messages.tool_use', repeats, async () => {
    const response = await postJson(`${baseUrl}/v1/messages`, {
      model,
      max_tokens: 128,
      messages: [{ role: 'user', content: 'Use get_weather for Seoul. Return a tool call only.' }],
      tools: [{
        name: 'get_weather',
        description: 'Get current weather by city.',
        input_schema: weatherSchema(),
      }],
      tool_choice: { type: 'any' },
    }, anthropicHeaders(isApi));
    assertAnthropicMessageShape(response.body, 'tool_use');
    const call = response.body.content?.find((block) => block.type === 'tool_use');
    assertEqual(call?.name, 'get_weather', 'tool name');
    assertEqual(call?.input?.city, 'Seoul', 'tool city');
    return { totalMs: response.totalMs, toolName: call.name, args: call.input };
  });

  await benchmarkCase(target, 'anthropic.messages.tool_use_stream.schema_exact', repeats, async () => {
    const response = await postSse(`${baseUrl}/v1/messages`, {
      model,
      max_tokens: 128,
      stream: true,
      messages: [{ role: 'user', content: 'Use get_weather for Seoul. Return a tool call only.' }],
      tools: [{
        name: 'get_weather',
        description: 'Get current weather by city.',
        input_schema: weatherSchema(),
      }],
      tool_choice: { type: 'any' },
    }, anthropicHeaders(isApi), () => '', (event, payload) => {
      if (event !== 'content_block_delta' && payload?.type !== 'content_block_delta') return '';
      return payload?.delta?.type === 'input_json_delta' ? payload.delta.partial_json ?? '' : '';
    });
    const args = parseJson(response.toolArguments, 'anthropic streamed tool arguments');
    assertEqual(args.city, 'Seoul', 'anthropic streamed tool city');
    assertAnthropicStreamShape(response.events);
    return responseSummary(response);
  });

  await benchmarkCase(target, 'anthropic.messages.tool_result.schema_exact', repeats, async () => {
    const expected = 'WEATHER_RESULT_CITY=Seoul;TEMP_C=23;CONDITION=clear';
    const response = await postJson(`${baseUrl}/v1/messages`, {
      model,
      max_tokens: 128,
      messages: [
        { role: 'user', content: `Use get_weather, then reply with exactly: ${expected}` },
        {
          role: 'assistant',
          content: [{
            type: 'tool_use',
            id: 'toolu_bench_weather',
            name: 'get_weather',
            input: { city: 'Seoul' },
          }],
        },
        {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: 'toolu_bench_weather',
            content: '{"city":"Seoul","temperature_c":23,"condition":"clear"}',
          }],
        },
      ],
    }, anthropicHeaders(isApi));
    assertAnthropicMessageShape(response.body, 'end_turn');
    const text = response.body.content?.find((block) => block.type === 'text')?.text;
    assertEqual(text, expected, 'anthropic tool result text');
    return { totalMs: response.totalMs, text, usage: response.body.usage };
  });

  if (includeMultimodal) {
    await benchmarkCase(target, 'anthropic.messages.image.schema_exact', repeats, async () => {
      const response = await postJson(`${baseUrl}/v1/messages`, {
        model,
        max_tokens: 256,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/png',
                data: visionDataUrl().split(',')[1],
              },
            },
            { type: 'text', text: 'Identify the dominant color. Reply exactly one uppercase word: RED, GREEN, or BLUE.' },
          ],
        }],
      }, anthropicHeaders(isApi));
      assertAnthropicMessageShape(response.body, 'end_turn');
      const text = response.body.content?.find((block) => block.type === 'text')?.text;
      assertEqual(text, 'RED', 'anthropic image color');
      return { totalMs: response.totalMs, text, usage: response.body.usage };
    });

    await benchmarkCase(target, 'anthropic.messages.multi_image.schema_exact', repeats, async () => {
      const response = await postJson(`${baseUrl}/v1/messages`, {
        model,
        max_tokens: 256,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'Two images follow. Identify the dominant colors in image order. Reply exactly: RED,BLUE' },
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/png',
                data: fixtureDataUrl('red_square').split(',')[1],
              },
            },
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/png',
                data: fixtureDataUrl('blue_square').split(',')[1],
              },
            },
          ],
        }],
      }, anthropicHeaders(isApi));
      assertAnthropicMessageShape(response.body, 'end_turn');
      const text = response.body.content?.find((block) => block.type === 'text')?.text;
      assertEqual(text, 'RED,BLUE', 'anthropic multi-image color order');
      return { totalMs: response.totalMs, text, fixtures: ['red_square', 'blue_square'], usage: response.body.usage };
    });
  }

  if (qualityRepeats > 0) {
    await benchmarkQualityCase(target, 'anthropic.messages.quality_distribution', qualityRepeats, async () => {
      const response = await postJson(`${baseUrl}/v1/messages`, {
        model,
        max_tokens: 640,
        messages: [{ role: 'user', content: qualityPrompt() }],
      }, anthropicHeaders(isApi));
      assertAnthropicMessageShape(response.body, 'end_turn');
      const text = response.body.content?.find((block) => block.type === 'text')?.text ?? '';
      return { totalMs: response.totalMs, text, quality: scoreQualityOutput(text) };
    });
  }

  if (shouldRunSemanticQuality(target)) {
    for (const task of semanticQualityTasks()) {
      await benchmarkQualityCase(target, `anthropic.messages.semantic_quality.${task.id}`, semanticQualityRepeats, async (index) => {
        const prompt = task.prompt;
        const response = await postJson(`${baseUrl}/v1/messages`, {
          model,
          max_tokens: 640,
          messages: [{ role: 'user', content: prompt }],
        }, anthropicHeaders(isApi));
        assertAnthropicMessageShape(response.body, 'end_turn');
        const text = response.body.content?.find((block) => block.type === 'text')?.text ?? '';
        const { reference, referenceError } = await safeSemanticReference('anthropic.messages', target, `${task.id}:${index}`, prompt);
        const judged = await scoreSemanticQuality({
          target,
          caseName: `anthropic.messages.semantic_quality.${task.id}`,
          prompt,
          text,
          reference,
        });
        return { totalMs: response.totalMs, text, quality: scoreQualityOutput(text, task), ...judged, referenceError };
      });
    }
  }
}

async function benchmarkCase(target, caseName, count, fn) {
  if (!shouldRunCase(caseName)) return;
  const samples = [];
  for (let i = 0; i < count; i += 1) {
    currentBenchmarkContext = { target, caseName };
    try {
      const sample = await fn(i + 1);
      attachBackendTiming(target, sample);
      samples.push(sample);
      console.log(`PASS ${target} ${caseName} #${i + 1}: ${JSON.stringify(sample)}`);
    } catch (err) {
      const row = failedBenchmarkRow(target, caseName, err);
      rows.push(row);
      console.log(`FAIL ${target} ${caseName} #${i + 1}: ${row.error}`);
      return;
    } finally {
      currentBenchmarkContext = null;
    }
  }
  const row = {
    target,
    case: caseName,
    ok: true,
    totalMs: summarize(samples.map((sample) => sample.totalMs)),
    firstDataMs: summarize(samples.map((sample) => sample.firstDataMs).filter(Number.isFinite)),
    firstTextMs: summarize(samples.map((sample) => sample.firstTextMs).filter(Number.isFinite)),
    firstToolArgumentMs: summarize(samples.map((sample) => sample.firstToolArgumentMs).filter(Number.isFinite)),
    firstImageMs: summarize(samples.map((sample) => sample.firstImageMs).filter(Number.isFinite)),
    chunks: samples.map((sample) => sample.chunks).filter(Number.isFinite),
    sample: samples.at(-1),
  };
  const backendTiming = summarizeBackendTimings(samples);
  if (backendTiming) row.backendTiming = backendTiming;
  const modelWorkPct = summarizeModelWorkPct(samples);
  if (modelWorkPct) row.modelWorkPct = modelWorkPct;
  const imageQualityScores = samples.map((sample) => sample.imageQuality?.score).filter(Number.isFinite);
  if (imageQualityScores.length > 0) row.imageQuality = summarize(imageQualityScores);
  const imageJudgeMs = samples.map((sample) => sample.imageQuality?.judgeMs?.median ?? sample.imageQuality?.judgeMs).filter(Number.isFinite);
  if (imageJudgeMs.length > 0) row.imageJudgeMs = summarize(imageJudgeMs);
  const outliers = sampleOutliers(samples);
  if (outliers.length > 0) row.outliers = outliers;
  const lowestImageScore = Math.min(...imageQualityScores);
  if (imageQualityScores.length > 0 && minImageQuality > 0 && lowestImageScore < minImageQuality) {
    row.ok = false;
    row.error = `image quality below ${minImageQuality}: ${lowestImageScore}`;
  }
  rows.push(row);
}

async function benchmarkQualityCase(target, caseName, count, fn) {
  if (!shouldRunCase(caseName)) return;
  const samples = [];
  for (let i = 0; i < count; i += 1) {
    currentBenchmarkContext = { target, caseName };
    try {
      const sample = await fn(i + 1);
      attachBackendTiming(target, sample);
      samples.push(sample);
      console.log(`PASS ${target} ${caseName} #${i + 1}: ${JSON.stringify({
        totalMs: sample.totalMs,
        quality: sample.quality,
        semanticQuality: sample.semanticQuality,
        referenceError: sample.referenceError,
        judgeMs: sample.judgeMs,
        backendTiming: sample.backendTiming,
      })}`);
    } catch (err) {
      const row = failedBenchmarkRow(target, caseName, err);
      rows.push(row);
      console.log(`FAIL ${target} ${caseName} #${i + 1}: ${row.error}`);
      return;
    } finally {
      currentBenchmarkContext = null;
    }
  }
  const row = {
    target,
    case: caseName,
    ok: true,
    totalMs: summarize(samples.map((sample) => sample.totalMs)),
    quality: summarize(samples.map((sample) => sample.quality.score)),
    sample: samples.at(-1),
  };
  const semanticScores = samples.map((sample) => sample.semanticQuality?.score).filter(Number.isFinite);
  if (semanticScores.length > 0) row.semanticQuality = summarize(semanticScores);
  const relativeScores = samples
    .map((sample) => sample.semanticQuality?.relativeQuality ?? sample.semanticQuality?.score)
    .filter(Number.isFinite);
  if (relativeScores.length > 0) row.semanticRelativeQuality = summarize(relativeScores);
  const judgeMs = samples.map((sample) => sample.judgeMs).filter(Number.isFinite);
  if (judgeMs.length > 0) row.judgeMs = summarize(judgeMs);
  const backendTiming = summarizeBackendTimings(samples);
  if (backendTiming) row.backendTiming = backendTiming;
  const outliers = sampleOutliers(samples);
  if (outliers.length > 0) row.outliers = outliers;
  const referenceErrors = samples.map((sample) => sample.referenceError).filter(Boolean);
  if (referenceErrors.length > 0) {
    row.referenceErrors = referenceErrors;
    row.ok = false;
    row.error = `semantic reference failed: ${referenceErrors[0]}`;
  }
  // The gate is relative to the same-model direct reference: minSemanticQuality
  // means "at least N% of the reference's quality for this request", not an
  // absolute exam score. Absolute scores stay recorded for diagnosis.
  const lowestRelative = Math.min(...relativeScores);
  if (row.ok && relativeScores.length > 0 && minSemanticQuality > 0 && lowestRelative < minSemanticQuality) {
    row.ok = false;
    const lowestAbsolute = semanticScores.length > 0 ? Math.min(...semanticScores) : null;
    row.error = `semantic quality below ${minSemanticQuality}: relative ${lowestRelative}${lowestAbsolute === null ? '' : ` (absolute ${lowestAbsolute})`}`;
  }
  rows.push(row);
}

async function postJson(url, body, headers) {
  const startedAt = performance.now();
  const res = await guardedProxyFetch(url, () => fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(stripUndefined(body)),
    signal: AbortSignal.timeout(timeoutMs),
  }));
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { raw: text };
  }
  if (!res.ok) throw new Error(`${url} ${res.status}: ${truncate(text)}`);
  return { body: parsed, totalMs: elapsed(startedAt) };
}

async function postMultipart(url, fields, files, headers) {
  const form = multipartForm(fields, files);
  const startedAt = performance.now();
  const res = await guardedProxyFetch(url, () => fetch(url, {
    method: 'POST',
    headers,
    body: form,
    signal: AbortSignal.timeout(timeoutMs),
  }));
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { raw: text };
  }
  if (!res.ok) throw new Error(`${url} ${res.status}: ${truncate(text)}`);
  return { body: parsed, totalMs: elapsed(startedAt) };
}

async function postJsonExpectOpenAiError(url, body, headers, expected) {
  const startedAt = performance.now();
  const res = await guardedProxyFetch(url, () => fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(stripUndefined(body)),
    signal: AbortSignal.timeout(timeoutMs),
  }));
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { raw: text };
  }
  assertEqual(res.status, expected.status, 'expected provider error status');
  if (expected.allowEmptyBody && text.trim() === '') {
    return {
      totalMs: elapsed(startedAt),
      statusCode: res.status,
      raw: '',
    };
  }
  const error = parsed.error;
  assert(error && typeof error === 'object', 'expected OpenAI error object');
  assertEqual(error.type, expected.type, 'provider error type');
  assertEqual(error.param, expected.param, 'provider error param');
  assertEqual(error.code, expected.code, 'provider error code');
  assert(typeof error.message === 'string' && error.message.length > 0, 'provider error message');
  return {
    totalMs: elapsed(startedAt),
    statusCode: res.status,
    error: {
      type: error.type,
      param: error.param,
      code: error.code,
      message: error.message,
    },
  };
}

async function postJsonExpectOpenAiErrorShape(url, body, headers, expected) {
  const startedAt = performance.now();
  const res = await guardedProxyFetch(url, () => fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(stripUndefined(body)),
    signal: AbortSignal.timeout(timeoutMs),
  }));
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { raw: text };
  }
  assertEqual(res.status, expected.status, 'expected provider error status');
  if (expected.allowEmptyBody && text.trim() === '') {
    return {
      totalMs: elapsed(startedAt),
      statusCode: res.status,
      raw: '',
    };
  }
  const error = parsed.error;
  assert(error && typeof error === 'object', 'expected OpenAI error object');
  if (expected.type !== undefined) assertEqual(error.type, expected.type, 'provider error type');
  if (expected.param !== undefined) assertEqual(error.param, expected.param, 'provider error param');
  if (expected.code !== undefined) assertEqual(error.code, expected.code, 'provider error code');
  assert(typeof error.message === 'string' && error.message.length > 0, 'provider error message');
  return {
    totalMs: elapsed(startedAt),
    statusCode: res.status,
    error: {
      type: error.type,
      param: error.param,
      code: error.code,
      message: error.message,
    },
  };
}

async function postSseMultipart(url, fields, files, headers, collectText, collectToolArgument = () => '') {
  return await postSseRequest(
    url,
    { headers, body: multipartForm(fields, files) },
    collectText,
    collectToolArgument,
  );
}

async function postSse(url, body, headers, collectText, collectToolArgument = () => '') {
  return await postSseRequest(
    url,
    { headers, body: JSON.stringify(stripUndefined(body)) },
    collectText,
    collectToolArgument,
  );
}

async function postSseRequest(url, request, collectText, collectToolArgument = () => '') {
  return await guardedProxyFetch(url, async () => {
    const startedAt = performance.now();
    const res = await fetch(url, {
      method: 'POST',
      headers: request.headers,
      body: request.body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`${url} ${res.status}: ${truncate(await res.text())}`);
    if (!res.body) throw new Error(`${url} did not return a readable stream`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let firstDataMs = null;
    let firstTextMs = null;
    let firstToolArgumentMs = null;
    let chunks = 0;
    let text = '';
    let toolArguments = '';
    let done = false;
    const events = [];

    function processFrame(frame) {
      const lines = frame.split(/\n/).map((line) => line.trimEnd());
      const event = lines.find((line) => line.startsWith('event: '))?.slice(7) ?? 'message';
      const data = lines.find((line) => line.startsWith('data: '))?.slice(6);
      if (!data) return;
      if (data === '[DONE]') {
        done = true;
        return;
      }
      if (firstDataMs === null) firstDataMs = elapsed(startedAt);
      let payload;
      try {
        payload = JSON.parse(data);
      } catch {
        return;
      }
      events.push({ event, payload });
      const delta = collectText(event, payload);
      if (delta) {
        if (firstTextMs === null) firstTextMs = elapsed(startedAt);
        chunks += 1;
        text += delta;
      }
      const toolArgumentDelta = collectToolArgument(event, payload);
      if (toolArgumentDelta) {
        if (firstToolArgumentMs === null) firstToolArgumentMs = elapsed(startedAt);
        chunks += 1;
        toolArguments += toolArgumentDelta;
      }
    }

    while (true) {
      const read = await reader.read();
      if (read.done) break;
      buffer += decoder.decode(read.value, { stream: true });
      let index;
      while ((index = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        processFrame(frame);
      }
    }
    buffer += decoder.decode();
    const finalFrame = buffer.trim();
    if (finalFrame) processFrame(finalFrame);
    return { totalMs: elapsed(startedAt), firstDataMs, firstTextMs, firstToolArgumentMs, chunks, text, toolArguments, done, events };
  });
}

function multipartForm(fields, files) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    form.append(key, String(value));
  }
  for (const file of files) {
    form.append(file.name, new Blob([file.data], { type: file.contentType }), file.filename);
  }
  return form;
}

function openAiHeaders(isApi) {
  return {
    'content-type': 'application/json',
    ...(isApi
      ? { authorization: `Bearer ${process.env.OPENAI_API_KEY}` }
      : { authorization: 'Bearer local' }),
  };
}

function openAiMultipartHeaders(isApi) {
  return isApi
    ? { authorization: `Bearer ${process.env.OPENAI_API_KEY}` }
    : { authorization: 'Bearer local' };
}

function anthropicHeaders(isApi) {
  return {
    'content-type': 'application/json',
    ...(isApi
      ? { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' }
      : { 'x-api-key': 'local', 'anthropic-version': '2023-06-01' }),
  };
}

function openAiWeatherTool() {
  return {
    type: 'function',
    name: 'get_weather',
    description: 'Get current weather by city.',
    parameters: weatherSchema(),
    strict: true,
  };
}

function openAiChatWeatherTool() {
  return {
    type: 'function',
    function: {
      name: 'get_weather',
      description: 'Get current weather by city.',
      parameters: weatherSchema(),
      strict: true,
    },
  };
}

function benchmarkChatToolCall() {
  return {
    id: 'call_bench_weather',
    type: 'function',
    function: {
      name: 'get_weather',
      arguments: '{"city":"Seoul"}',
    },
  };
}

function adapterSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      adapter: { type: 'string' },
      ok: { type: 'boolean' },
    },
    required: ['adapter', 'ok'],
  };
}

function weatherSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      city: { type: 'string' },
    },
    required: ['city'],
  };
}

function fixtureDataUrl(name) {
  if (imageFixtureCache.has(name)) return imageFixtureCache.get(name);
  const fixtures = {
    red_square: () => solidPngDataUrl(64, 64, { r: 255, g: 0, b: 0, a: 255 }),
    red_square_on_white: () => centeredSquarePngDataUrl(96, 96, { r: 255, g: 255, b: 255, a: 255 }, { r: 255, g: 0, b: 0, a: 255 }),
    blue_square: () => solidPngDataUrl(64, 64, { r: 0, g: 76, b: 255, a: 255 }),
    green_square: () => solidPngDataUrl(64, 64, { r: 0, g: 180, b: 80, a: 255 }),
    transparent_red_square: () => solidPngDataUrl(64, 64, { r: 255, g: 0, b: 0, a: 96 }),
    center_mask: () => centerMaskPngDataUrl(64, 64),
    style_reference_card: () => styleReferenceCardPngDataUrl(),
    teal_mug_reference: () => tealMugReferencePngDataUrl(),
    warm_palette_reference: () => warmPaletteReferencePngDataUrl(),
  };
  const create = fixtures[name];
  if (!create) throw new Error(`unknown image fixture: ${name}`);
  const dataUrl = create();
  imageFixtureCache.set(name, dataUrl);
  return dataUrl;
}

function fixtureImageBytes(name) {
  return Buffer.from(fixtureDataUrl(name).split(',')[1], 'base64');
}

function visionDataUrl() {
  return fixtureDataUrl('red_square');
}

function visionImageBytes() {
  return fixtureImageBytes('red_square');
}

function solidPngDataUrl(width, height, rgba) {
  const stride = 1 + width * 4;
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * stride;
    pixels[row] = 0;
    for (let x = 0; x < width; x += 1) {
      const offset = row + 1 + x * 4;
      pixels[offset] = rgba.r;
      pixels[offset + 1] = rgba.g;
      pixels[offset + 2] = rgba.b;
      pixels[offset + 3] = rgba.a;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(pixels)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
  return `data:image/png;base64,${png.toString('base64')}`;
}

function centeredSquarePngDataUrl(width, height, background, square) {
  const stride = 1 + width * 4;
  const pixels = Buffer.alloc(stride * height);
  const side = Math.floor(Math.min(width, height) * 0.58);
  const left = Math.floor((width - side) / 2);
  const top = Math.floor((height - side) / 2);
  for (let y = 0; y < height; y += 1) {
    const row = y * stride;
    pixels[row] = 0;
    for (let x = 0; x < width; x += 1) {
      const offset = row + 1 + x * 4;
      const inSquare = x >= left && x < left + side && y >= top && y < top + side;
      const rgba = inSquare ? square : background;
      pixels[offset] = rgba.r;
      pixels[offset + 1] = rgba.g;
      pixels[offset + 2] = rgba.b;
      pixels[offset + 3] = rgba.a;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(pixels)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
  return `data:image/png;base64,${png.toString('base64')}`;
}

function centerMaskPngDataUrl(width, height) {
  const stride = 1 + width * 4;
  const pixels = Buffer.alloc(stride * height);
  const insetX = Math.floor(width * 0.25);
  const insetY = Math.floor(height * 0.25);
  for (let y = 0; y < height; y += 1) {
    const row = y * stride;
    pixels[row] = 0;
    for (let x = 0; x < width; x += 1) {
      const offset = row + 1 + x * 4;
      const inCenter = x >= insetX && x < width - insetX && y >= insetY && y < height - insetY;
      pixels[offset] = 255;
      pixels[offset + 1] = 255;
      pixels[offset + 2] = 255;
      pixels[offset + 3] = inCenter ? 0 : 255;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(pixels)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
  return `data:image/png;base64,${png.toString('base64')}`;
}

function styleReferenceCardPngDataUrl() {
  const cream = { r: 246, g: 236, b: 211, a: 255 };
  const navy = { r: 18, g: 46, b: 74, a: 255 };
  const coral = { r: 238, g: 108, b: 92, a: 255 };
  const blue = { r: 65, g: 155, b: 210, a: 255 };
  return customPngDataUrl(128, 128, (x, y) => {
    const dx = x - 64;
    const dy = y - 63;
    const radius = Math.sqrt(dx * dx + dy * dy);
    if (radius >= 37 && radius <= 45) return navy;
    if (Math.abs(y - (0.58 * x + 22)) < 5 && x > 22 && x < 104) return coral;
    if ((x - 35) ** 2 + (y - 90) ** 2 < 12 ** 2) return blue;
    return cream;
  });
}

function tealMugReferencePngDataUrl() {
  const background = { r: 244, g: 247, b: 248, a: 255 };
  const teal = { r: 28, g: 138, b: 139, a: 255 };
  const darkTeal = { r: 10, g: 79, b: 91, a: 255 };
  const highlight = { r: 91, g: 188, b: 185, a: 255 };
  return customPngDataUrl(128, 128, (x, y) => {
    const body = roundedRectContains(x, y, 34, 34, 82, 94, 12);
    const handleOuter = ellipseContains(x, y, 91, 63, 24, 27);
    const handleInner = ellipseContains(x, y, 91, 63, 13, 16);
    if (handleOuter && !handleInner) return teal;
    if (body) {
      if (y >= 36 && y <= 42) return darkTeal;
      if (x >= 44 && x <= 50 && y >= 45 && y <= 86) return highlight;
      return teal;
    }
    if (x >= 43 && x <= 77 && y >= 94 && y <= 98) return darkTeal;
    return background;
  });
}

function warmPaletteReferencePngDataUrl() {
  const sand = { r: 225, g: 192, b: 145, a: 255 };
  const cream = { r: 248, g: 239, b: 218, a: 255 };
  const navy = { r: 19, g: 48, b: 77, a: 255 };
  const coral = { r: 234, g: 112, b: 93, a: 255 };
  const teal = { r: 33, g: 140, b: 142, a: 255 };
  return customPngDataUrl(128, 128, (x, y) => {
    if (y < 34) return cream;
    if (Math.abs(y - (0.4 * x + 58)) < 8) return coral;
    if (x > 82 && y > 52 && y < 104) return navy;
    if ((x - 40) ** 2 + (y - 78) ** 2 < 18 ** 2) return teal;
    return sand;
  });
}

function customPngDataUrl(width, height, pixelFor) {
  const stride = 1 + width * 4;
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * stride;
    pixels[row] = 0;
    for (let x = 0; x < width; x += 1) {
      const rgba = pixelFor(x, y);
      const offset = row + 1 + x * 4;
      pixels[offset] = rgba.r;
      pixels[offset + 1] = rgba.g;
      pixels[offset + 2] = rgba.b;
      pixels[offset + 3] = rgba.a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(pixels)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
  return `data:image/png;base64,${png.toString('base64')}`;
}

function roundedRectContains(x, y, left, top, right, bottom, radius) {
  const cx = Math.max(left + radius, Math.min(x, right - radius));
  const cy = Math.max(top + radius, Math.min(y, bottom - radius));
  return x >= left && x <= right && y >= top && y <= bottom
    && (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
}

function ellipseContains(x, y, centerX, centerY, radiusX, radiusY) {
  return ((x - centerX) / radiusX) ** 2 + ((y - centerY) / radiusY) ** 2 <= 1;
}

function pngChunk(type, data) {
  const name = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([name, data])), 0);
  return Buffer.concat([length, name, data, crc]);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function assertOpenAiChatResponseShape(body, finishReason) {
  assertEqual(body.object, 'chat.completion', 'chat object');
  assert(typeof body.id === 'string' && body.id.startsWith('chatcmpl-'), 'chat id shape');
  assert(typeof body.created === 'number', 'chat created must be number');
  assert(typeof body.model === 'string', 'chat model must be string');
  const choice = body.choices?.[0];
  assert(choice && typeof choice === 'object', 'chat choice missing');
  assertEqual(choice.index, 0, 'chat choice index');
  assertEqual(choice.finish_reason, finishReason, 'chat finish_reason');
  assertEqual(choice.message?.role, 'assistant', 'chat message role');
  assertUsageShape(body.usage, 'openai-chat');
  if (finishReason === 'tool_calls') {
    assert(Array.isArray(choice.message.tool_calls), 'chat tool_calls must be array');
    assertEqual(choice.message.content, null, 'chat tool message content');
  } else {
    assert(typeof choice.message.content === 'string', 'chat content must be string');
  }
}

function assertOpenAiChatStreamShape(events, { includeUsage }) {
  assert(events.length > 0, 'chat stream must emit events');
  for (const { payload } of events) {
    assertEqual(payload.object, 'chat.completion.chunk', 'chat stream object');
    assert(typeof payload.id === 'string' && payload.id.startsWith('chatcmpl-'), 'chat stream id shape');
    assert(typeof payload.created === 'number', 'chat stream created');
    if (includeUsage) assert('usage' in payload, 'chat stream usage field missing');
  }
  if (includeUsage) {
    const usageChunk = events.find(({ payload }) => Array.isArray(payload.choices) && payload.choices.length === 0);
    assert(usageChunk, 'chat stream final usage chunk missing');
    assertUsageShape(usageChunk.payload.usage, 'openai-chat');
  }
}

function assertOpenAiChatToolStreamShape(events) {
  assertOpenAiChatStreamShape(events, { includeUsage: false });
  const toolDelta = events.find(({ payload }) => {
    const calls = payload?.choices?.[0]?.delta?.tool_calls;
    return Array.isArray(calls) && calls.some((call) => call?.function?.arguments);
  });
  assert(toolDelta, 'chat tool stream missing argument delta');
  const finish = events.find(({ payload }) => payload?.choices?.[0]?.finish_reason === 'tool_calls');
  assert(finish, 'chat tool stream missing tool_calls finish reason');
}

function assertOpenAiResponsesShape(body) {
  assertEqual(body.object, 'response', 'responses object');
  assert(typeof body.id === 'string' && body.id.startsWith('resp_'), 'responses id shape');
  assert(typeof body.created_at === 'number', 'responses created_at');
  assert(typeof body.model === 'string', 'responses model');
  assert(typeof body.status === 'string', 'responses status');
  assert(Array.isArray(body.output), 'responses output array');
  assert(!('output_text' in body), 'responses output_text must not be top-level');
  assertUsageShape(body.usage, 'openai-responses');
}

function assertOpenAiImagesGenerationShape(body) {
  assert(typeof body.created === 'number', 'images generation created');
  assert(Array.isArray(body.data), 'images generation data array');
  assert(body.data.length > 0, 'images generation data must include an image');
  for (const image of body.data) {
    const hasUrl = typeof image.url === 'string';
    const hasB64Json = typeof image.b64_json === 'string';
    assert(hasUrl !== hasB64Json, 'images generation item must include exactly one of url or b64_json');
    if (hasUrl) {
      assert(/^https?:\/\//.test(image.url), 'images generation url');
    } else {
      assertBase64Image(image.b64_json, 'images generation b64_json');
    }
    if ('revised_prompt' in image) {
      assert(typeof image.revised_prompt === 'string', 'images generation revised_prompt');
    }
  }
  if ('background' in body) {
    assert(body.background === 'transparent' || body.background === 'opaque', 'images generation background');
  }
  if ('size' in body) {
    assert(typeof body.size === 'string' && body.size.length > 0, 'images generation size');
  }
  if ('quality' in body) {
    assert(['low', 'medium', 'high'].includes(body.quality), 'images generation quality');
  }
  if ('output_format' in body) {
    assert(['png', 'jpeg', 'webp'].includes(body.output_format), 'images generation output_format');
  }
  if ('usage' in body) assertUsageShape(body.usage, 'openai-images');
}

function assertOpenAiImageGenerationCallShape(item) {
  assert(item && typeof item === 'object', 'responses image_generation_call item');
  assertEqual(item.type, 'image_generation_call', 'responses image generation item type');
  assertEqual(item.status, 'completed', 'responses image generation status');
  assert(item.action === 'generate' || item.action === 'edit', 'responses image generation action');
  assertBase64Image(item.result, 'responses image generation result');
  if ('revised_prompt' in item) {
    assert(typeof item.revised_prompt === 'string', 'responses image generation revised_prompt');
  }
}

function assertImageStreamShape(events, mode) {
  assert(events.length > 0, 'image stream must emit events');
  const eventTypes = events.map(({ event }) => event);
  const eventSummary = () => {
    const errorPayload = events.find(({ event }) => event === 'error' || event.endsWith('.failed'))?.payload;
    return `${eventTypes.join(',')}${errorPayload ? ` payload=${truncate(JSON.stringify(errorPayload), 500)}` : ''}`;
  };
  if (mode === 'responses') {
    assert(eventTypes.includes('response.image_generation_call.partial_image')
      || eventTypes.includes('response.output_item.done')
      || eventTypes.includes('response.completed'), `responses image stream event: ${eventSummary()}`);
    return;
  }
  assert(eventTypes.includes('image_generation.partial_image')
    || eventTypes.includes('image_generation.completed')
    || eventTypes.includes('image_edit.partial_image')
    || eventTypes.includes('image_edit.completed'), `images stream event: ${eventSummary()}`);
  for (const { event, payload } of events) {
    assertEqual(payload.type, event, `images stream payload type for ${event}`);
    if (event.endsWith('.partial_image')) {
      assert(typeof payload.partial_image_index === 'number', 'images partial image index');
    }
    if (payload.b64_json) assertBase64Image(payload.b64_json, 'images stream b64_json');
  }
}

function assertBase64Image(value, label) {
  assert(typeof value === 'string' && value.length > 1000, label);
  const bytes = Buffer.from(value, 'base64');
  assert(bytes.length > 1000, `${label} decoded bytes`);
}

function assertOpenAiResponsesStreamShape(events, requiredEventTypes) {
  assert(events.length > 0, 'responses stream must emit events');
  let previousSequence = -1;
  const eventTypes = events.map(({ event }) => event);
  for (const required of requiredEventTypes) {
    assert(eventTypes.includes(required), `responses stream missing ${required}`);
  }
  for (const { event, payload } of events) {
    assertEqual(payload.type, event, `responses payload type for ${event}`);
    assert(typeof payload.sequence_number === 'number', `responses ${event} sequence_number`);
    assert(payload.sequence_number === previousSequence + 1, `responses ${event} sequence order`);
    previousSequence = payload.sequence_number;
    if (event === 'response.function_call_arguments.done') {
      assert(typeof payload.arguments === 'string', 'responses function_call_arguments.done arguments');
    }
  }
}

function assertUsageShape(usage, provider) {
  assert(usage && typeof usage === 'object', `${provider} usage missing`);
  if (provider.startsWith('openai')) {
    const promptTokens = usage.prompt_tokens ?? usage.input_tokens;
    const completionTokens = usage.completion_tokens ?? usage.output_tokens;
    assert(typeof promptTokens === 'number', `${provider} input tokens`);
    assert(typeof completionTokens === 'number', `${provider} output tokens`);
    assert(typeof usage.total_tokens === 'number', `${provider} total tokens`);
    return;
  }
  assert(typeof usage.input_tokens === 'number', `${provider} input tokens`);
  assert(typeof usage.output_tokens === 'number', `${provider} output tokens`);
}

function assertAnthropicMessageShape(body, stopReason) {
  assertEqual(body.type, 'message', 'anthropic message type');
  assert(typeof body.id === 'string' && body.id.startsWith('msg_'), 'anthropic id shape');
  assertEqual(body.role, 'assistant', 'anthropic role');
  assert(typeof body.model === 'string', 'anthropic model');
  assert(Array.isArray(body.content), 'anthropic content array');
  assertEqual(body.stop_reason, stopReason, 'anthropic stop_reason');
  assert('stop_sequence' in body, 'anthropic stop_sequence missing');
  assertUsageShape(body.usage, 'anthropic');
}

function assertAnthropicStreamShape(events) {
  const eventTypes = events.map(({ event }) => event);
  const lifecycleEvents = eventTypes.filter((event) => event !== 'ping');
  assertEqual(lifecycleEvents[0], 'message_start', 'anthropic first non-ping stream event');
  assert(eventTypes.includes('content_block_delta'), 'anthropic stream missing content delta');
  assert(eventTypes.includes('message_delta'), 'anthropic stream missing message_delta');
  assertEqual(lifecycleEvents.at(-1), 'message_stop', 'anthropic last non-ping stream event');
  for (const { event, payload } of events) {
    assertEqual(payload.type, event, `anthropic payload type for ${event}`);
  }
}

function responseSummary(response) {
  return {
    totalMs: response.totalMs,
    firstDataMs: response.firstDataMs,
    firstTextMs: response.firstTextMs,
    firstToolArgumentMs: response.firstToolArgumentMs,
    chunks: response.chunks,
    eventTypes: response.events.map(({ event }) => event),
    text: response.text,
    toolArguments: response.toolArguments,
  };
}

function pushBackendTiming(target, timing) {
  const queue = backendTimingQueues.get(target) ?? [];
  queue.push(timing);
  backendTimingQueues.set(target, queue);
}

function recordImageAttemptDiagnostic(target, diagnostic) {
  const record = {
    target,
    case: currentBenchmarkContext?.caseName ?? null,
    ...diagnostic,
  };
  imageAttemptDiagnostics.push(record);
  if (codexImageAttemptLogPath) fs.appendFileSync(codexImageAttemptLogPath, `${JSON.stringify(record)}\n`);
}

function attachBackendTiming(target, sample) {
  const queue = backendTimingQueues.get(target)
    ?? (target === imageGenerationPairTarget ? backendTimingQueues.get('proxy-codex') : undefined);
  if (!queue?.length) return;
  sample.backendTiming = queue.shift();
}

function summarizeBackendTimings(samples) {
  const timings = samples.map((sample) => sample.backendTiming).filter(Boolean);
  if (timings.length === 0) return null;
  const summary = {};
  for (const key of [
    'ensureStartedMs',
    'promptBuildMs',
    'threadStartMs',
    'inputPrepareMs',
    'turnStartMs',
    'turnWaitMs',
    'usageWaitMs',
    'firstTextDeltaMs',
    'firstToolCallDeltaMs',
    'firstToolArgumentDeltaMs',
    'totalMs',
  ]) {
    const values = timings.map((timing) => timing[key]).filter(Number.isFinite);
    if (values.length > 0) summary[key] = summarize(values);
  }
  return summary;
}

function summarizeModelWorkPct(samples) {
  const values = samples
    .map((sample) => modelWorkPct(sample))
    .filter(Number.isFinite);
  return values.length > 0 ? summarize(values) : null;
}

function modelWorkPct(sample) {
  const timing = sample.backendTiming;
  if (!timing || !Number.isFinite(timing.turnWaitMs) || !Number.isFinite(sample.totalMs) || sample.totalMs <= 0) {
    return Number.NaN;
  }
  return Number((timing.turnWaitMs / sample.totalMs * 100).toFixed(1));
}

function extractOpenAiResponseText(body) {
  return body.output
    ?.flatMap((item) => item.content ?? [])
    ?.find((content) => content.type === 'output_text')
    ?.text;
}

function extractOpenAiFunctionCall(body) {
  return body.output?.find((item) => item.type === 'function_call');
}

function exactPrompt(token) {
  return `Reply with exactly this text and no extra characters: ${token}`;
}

function qualityPrompt() {
  return semanticQualityTasks()[0].prompt;
}

function semanticQualityTasks() {
  if (semanticQualitySuite === 'legacy') return [qualityTasks()[0]];
  if (semanticQualitySuite !== 'realistic') {
    throw new Error(`unsupported semantic quality suite: ${semanticQualitySuite}`);
  }
  return qualityTasks();
}

function qualityTasks() {
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
        'State that image-2 through the proxy is the formal image2_via_gpt55 route and must not call direct provider APIs.',
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

function scoreQualityOutput(text, task = { requiredTerms: ['schema', 'latency', 'risk'], format: 'bullets' }) {
  const lower = text.toLowerCase();
  const required = task.requiredTerms ?? ['schema', 'latency', 'risk'];
  const keywordHits = required.filter((word) => lower.includes(word.toLowerCase())).length;
  const bulletCount = (text.match(/(^|\n)\s*(-|•|\d+[.)])/g) ?? []).length;
  const tableRows = text.split('\n').filter((line) => /^\s*\|.*\|\s*$/.test(line)).length;
  let jsonKeys = 0;
  let validJsonObject = false;
  if (task.format === 'json') {
    try {
      const parsed = JSON.parse(text);
      validJsonObject = parsed && typeof parsed === 'object' && !Array.isArray(parsed);
      jsonKeys = validJsonObject
        ? (task.requiredKeys ?? []).filter((key) => Object.hasOwn(parsed, key)).length
        : 0;
    } catch {
      validJsonObject = false;
    }
  }
  const characters = text.trim().length;
  const structureScore = task.format === 'json'
    ? (validJsonObject ? (task.requiredKeys?.length ? jsonKeys / task.requiredKeys.length : 1) : 0)
    : task.format === 'table'
      ? Math.min(1, tableRows / 6)
      : Math.min(1, bulletCount / (task.expectedBullets ?? (task.id === 'benchmark_failure_triage' ? 4 : 3)));
  const keywordScore = keywordHits / required.length;
  const lengthScore = characters >= 120 && characters <= 1200 ? 1 : Math.max(0, 1 - Math.abs(characters - 480) / 480);
  return {
    score: Math.round((keywordScore * 0.5 + structureScore * 0.3 + lengthScore * 0.2) * 100),
    keywordHits,
    bulletCount,
    tableRows,
    jsonKeys,
    validJsonObject,
    characters,
  };
}

async function semanticReference(kind, target, index, prompt, options = {}) {
  if (!semanticQualityReference || target.includes('-api:')) return null;
  const provider = semanticReferenceProvider(target);
  if (!provider) return null;
  if (provider === 'openai' && !process.env.OPENAI_API_KEY) return null;
  if (provider === 'anthropic' && !process.env.ANTHROPIC_API_KEY) return null;
  const key = `${provider}:${kind}:${index}:${hashString(prompt)}:${options.openAiReasoningEffort ?? ''}`;
  if (semanticReferenceCache.has(key)) return semanticReferenceCache.get(key);
  const value = await fetchSemanticReference(provider, kind, prompt, options);
  semanticReferenceCache.set(key, value);
  return value;
}

async function safeSemanticReference(kind, target, index, prompt, options = {}) {
  try {
    return {
      reference: await semanticReference(kind, target, index, prompt, options),
      referenceError: undefined,
    };
  } catch (err) {
    return {
      reference: null,
      referenceError: errorMessage(err),
    };
  }
}

function semanticReferenceProvider(target) {
  if (target === 'proxy-codex') return 'openai';
  if (target === 'proxy-codex-app-server') return 'openai';
  if (target === 'proxy-codex-backend') return 'openai';
  if (target === 'proxy-claude') return 'anthropic';
  return null;
}

function hashString(value) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

async function fetchSemanticReference(provider, kind, prompt, options = {}) {
  if (provider === 'openai') {
    return await fetchOpenAiSemanticReference(kind, prompt, options);
  }
  if (provider === 'anthropic') {
    return await fetchAnthropicSemanticReference(prompt);
  }
  throw new Error(`unsupported semantic reference provider: ${provider}`);
}

async function fetchOpenAiSemanticReference(kind, prompt, options = {}) {
  if (kind === 'openai.responses') {
    const response = await postJson('https://api.openai.com/v1/responses', {
      model: openAiModel,
      input: prompt,
      // Reference validity cap, not a quality target: newer/more verbose model
      // generations must finish naturally or the row loses its reference.
      max_output_tokens: 1536,
    }, openAiHeaders(true));
    assertOpenAiResponsesShape(response.body);
    return {
      target: `openai-api:${openAiModel}:responses`,
      totalMs: response.totalMs,
      text: extractOpenAiResponseText(response.body) ?? '',
      usage: response.body.usage,
    };
  }

  const body = {
    model: openAiModel,
    messages: [{ role: 'user', content: prompt }],
    max_completion_tokens: 1536,
  };
  if (options.openAiReasoningEffort) body.reasoning_effort = options.openAiReasoningEffort;
  const response = await postJson('https://api.openai.com/v1/chat/completions', body, openAiHeaders(true));
  assertOpenAiChatResponseShape(response.body, 'stop');
  return {
    target: `openai-api:${openAiModel}:chat`,
    totalMs: response.totalMs,
    text: response.body.choices?.[0]?.message?.content ?? '',
    usage: response.body.usage,
  };
}

async function fetchAnthropicSemanticReference(prompt) {
  const response = await postJson('https://api.anthropic.com/v1/messages', {
    model: anthropicModels.opus,
    max_tokens: 2048,
    messages: [{ role: 'user', content: prompt }],
  }, anthropicHeaders(true));
  assertAnthropicMessageShape(response.body, 'end_turn');
  return {
    target: `anthropic-api:${anthropicModels.opus}`,
    totalMs: response.totalMs,
    text: response.body.content?.find((block) => block.type === 'text')?.text ?? '',
    usage: response.body.usage,
  };
}

async function scoreSemanticQuality({ target, caseName, prompt, text, reference }) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is required for semantic quality judge');
  }
  const response = await postJson('https://api.openai.com/v1/chat/completions', {
    model: semanticQualityJudgeModel,
    messages: [
      {
        role: 'system',
        content: [
          'You are a strict API benchmark judge.',
          'Score semantic answer quality for provider API compatibility tests.',
          'Return only JSON matching the requested schema.',
        ].join(' '),
      },
      {
        role: 'user',
        content: semanticJudgePrompt({ target, caseName, prompt, text, reference }),
      },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'semantic_quality_score',
        strict: true,
        schema: semanticQualityScoreSchema(),
      },
    },
    max_completion_tokens: 1600,
  }, openAiHeaders(true));
  assertOpenAiChatResponseShape(response.body, 'stop');
  const semanticQuality = parseJson(response.body.choices?.[0]?.message?.content, 'semantic judge content');
  assertSemanticQualityShape(semanticQuality);
  return {
    semanticQuality,
    judgeMs: response.totalMs,
    judgeUsage: response.body.usage,
    reference,
  };
}

function semanticJudgePrompt({ target, caseName, prompt, text, reference }) {
  return [
    `Target: ${target}`,
    `Case: ${caseName}`,
    'Original user request:',
    prompt,
    reference
      ? [
          'Direct provider reference output for the same request:',
          reference.text,
        ].join('\n')
      : 'No direct provider reference is available; judge against the request and typical provider API output quality.',
    'Candidate output to score:',
    text,
    [
      'Rubric:',
      '- requirementFit: exact satisfaction of the original request, including language, format, count, ordering, forbidden claims, and required facts.',
      '- semanticRelevance: usefulness, correctness, and operational value for the requested local OAuth CLI API proxy scenario.',
      '- conciseness: dense, non-fluffy, and no extra headings, caveats, or follow-up questions unless the request asks for them.',
      '- providerSimilarity: if a reference is present, semantic similarity to the direct provider output; otherwise plausibility as a direct provider API answer.',
      '- relativeQuality: how well the candidate satisfies the original request RELATIVE to how well the reference satisfies it, as an integer percentage. 100 = meaningfully equivalent, above 100 = clearly better than the reference, below 100 = worse. Judge task outcome, not stylistic identity: a candidate that satisfies the request as fully as the reference scores 100 even when phrased differently. When no reference is present, set relativeQuality equal to score.',
      'Do not reward reference similarity when both the reference and candidate violate the explicit original request.',
      'Do not treat the reference as a style template when the candidate better satisfies the original request.',
      'For improvement-direction table cells, accept compact concrete mechanisms when they clearly express the direction and keep impact size separate.',
      'Overall score should be a weighted quality score from 0 to 100.',
      'List only concrete issues; use an empty array if none.',
    ].join('\n'),
  ].join('\n\n');
}

function semanticQualityScoreSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      score: { type: 'integer' },
      relativeQuality: { type: 'integer' },
      requirementFit: { type: 'integer' },
      semanticRelevance: { type: 'integer' },
      conciseness: { type: 'integer' },
      providerSimilarity: { type: 'integer' },
      rationale: { type: 'string' },
      issues: {
        type: 'array',
        items: { type: 'string' },
      },
    },
    required: [
      'score',
      'relativeQuality',
      'requirementFit',
      'semanticRelevance',
      'conciseness',
      'providerSimilarity',
      'rationale',
      'issues',
    ],
  };
}

function assertSemanticQualityShape(value) {
  assert(value && typeof value === 'object', 'semantic judge result must be object');
  for (const key of ['score', 'requirementFit', 'semanticRelevance', 'conciseness', 'providerSimilarity']) {
    assert(Number.isInteger(value[key]), `semantic judge ${key} must be integer`);
    assert(value[key] >= 0 && value[key] <= 100, `semantic judge ${key} must be 0..100`);
  }
  // relativeQuality may exceed 100: the candidate can beat the reference.
  assert(Number.isInteger(value.relativeQuality), 'semantic judge relativeQuality must be integer');
  assert(value.relativeQuality >= 0 && value.relativeQuality <= 200, 'semantic judge relativeQuality must be 0..200');
  assert(typeof value.rationale === 'string', 'semantic judge rationale must be string');
  assert(Array.isArray(value.issues), 'semantic judge issues must be array');
  for (const issue of value.issues) {
    assert(typeof issue === 'string', 'semantic judge issue must be string');
  }
}

async function maybeScoreImageQuality(spec) {
  if (imageQualityRepeats <= 0 || !spec?.b64Json || !spec?.prompt) return null;
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is required for image quality judge');
  }
  const samples = [];
  for (let i = 0; i < imageQualityRepeats; i += 1) {
    samples.push(await scoreImageQualityOnce(spec));
  }
  const scores = samples.map((sample) => sample.score);
  return {
    score: medianNumber(scores),
    scoreSummary: summarize(scores),
    requirementFit: medianNumber(samples.map((sample) => sample.requirementFit)),
    visualCorrectness: medianNumber(samples.map((sample) => sample.visualCorrectness)),
    artifactControl: medianNumber(samples.map((sample) => sample.artifactControl)),
    textAccuracy: medianNumber(samples.map((sample) => sample.textAccuracy)),
    preservation: medianNumber(samples.map((sample) => sample.preservation)),
    judgeMs: summarize(samples.map((sample) => sample.judgeMs)),
    samples: samples.map(({ judgeUsage, ...sample }) => sample),
    judgeUsage: samples.at(-1)?.judgeUsage,
  };
}

async function scoreImageQualityOnce(spec) {
  const response = await postJson('https://api.openai.com/v1/chat/completions', {
    model: imageQualityJudgeModel,
    messages: [
      {
        role: 'system',
        content: [
          'You are a strict image quality judge for API compatibility benchmarks.',
          'Score only what is visible in the generated image against the request.',
          'Return only JSON matching the requested schema.',
        ].join(' '),
      },
      {
        role: 'user',
        content: imageQualityJudgeContent(spec),
      },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'image_quality_score',
        strict: true,
        schema: imageQualityScoreSchema(),
      },
    },
    max_completion_tokens: 1200,
  }, openAiHeaders(true));
  assertOpenAiChatResponseShape(response.body, 'stop');
  const judged = parseJson(response.body.choices?.[0]?.message?.content, 'image judge content');
  assertImageQualityShape(judged);
  return {
    ...judged,
    judgeMs: response.totalMs,
    judgeUsage: response.body.usage,
  };
}

function imageQualityJudgeContent(spec) {
  const content = [{ type: 'text', text: imageQualityJudgePrompt(spec) }];
  const references = Array.isArray(spec.referenceImages) ? spec.referenceImages : [];
  references.forEach((image, index) => {
    content.push({ type: 'text', text: `Reference image ${index + 1}:` });
    content.push({
      type: 'image_url',
      image_url: {
        url: image,
        detail: 'high',
      },
    });
  });
  content.push({ type: 'text', text: 'Candidate output image to score:' });
  content.push({
    type: 'image_url',
    image_url: {
      url: `data:${spec.mediaType ?? 'image/png'};base64,${spec.b64Json}`,
      detail: 'high',
    },
  });
  return content;
}

function imageQualityJudgePrompt(spec) {
  const referenceCount = Array.isArray(spec.referenceImages) ? spec.referenceImages.length : 0;
  return [
    `Operation: ${spec.kind ?? 'image generation'}`,
    'Original request:',
    spec.prompt,
    `Requirements: ${(spec.requirements ?? []).join('; ')}`,
    referenceCount > 0
      ? `Reference images: ${referenceCount}. They are provided before the candidate image. Evaluate reference fidelity only where the original request asks for it; do not reward copying reference subjects that the request says not to copy.`
      : 'Reference images: none.',
    [
      'Rubric:',
      '- requirementFit: visible satisfaction of the explicit request and listed requirements.',
      '- visualCorrectness: correct objects, colors, composition, background, aspect, and style.',
      '- artifactControl: no blank/corrupt output, obvious distortions, duplicate artifacts, or malformed geometry.',
      '- textAccuracy: visible text is absent when forbidden, or legible and spelled correctly when requested.',
      '- preservation: for edits and reference-guided generation, preserve or apply the requested source/reference identity, style, palette, product details, or composition; for pure generation without references, score 100 unless preservation is applicable.',
      'Overall score is 0 to 100. Penalize hard for blank images, wrong primary object/color, unwanted text, or edit changes outside the request.',
      'List concrete visible violations only; use an empty array if none.',
    ].join('\n'),
  ].join('\n\n');
}

function imageQualityScoreSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      score: { type: 'integer' },
      requirementFit: { type: 'integer' },
      visualCorrectness: { type: 'integer' },
      artifactControl: { type: 'integer' },
      textAccuracy: { type: 'integer' },
      preservation: { type: 'integer' },
      rationale: { type: 'string' },
      violations: {
        type: 'array',
        items: { type: 'string' },
      },
    },
    required: [
      'score',
      'requirementFit',
      'visualCorrectness',
      'artifactControl',
      'textAccuracy',
      'preservation',
      'rationale',
      'violations',
    ],
  };
}

function assertImageQualityShape(value) {
  assert(value && typeof value === 'object', 'image judge result must be object');
  for (const key of ['score', 'requirementFit', 'visualCorrectness', 'artifactControl', 'textAccuracy', 'preservation']) {
    assert(Number.isInteger(value[key]), `image judge ${key} must be integer`);
    assert(value[key] >= 0 && value[key] <= 100, `image judge ${key} must be 0..100`);
  }
  assert(typeof value.rationale === 'string', 'image judge rationale must be string');
  assert(Array.isArray(value.violations), 'image judge violations must be array');
  for (const violation of value.violations) {
    assert(typeof violation === 'string', 'image judge violation must be string');
  }
}

function mediaTypeForOutputFormat(format) {
  if (format === 'jpeg' || format === 'jpg') return 'image/jpeg';
  if (format === 'webp') return 'image/webp';
  return 'image/png';
}

function tokenFor(target, name, index) {
  const safeTarget = target.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '');
  return `BENCH_${safeTarget}_${name}_${index}_OK`;
}

function parseJson(value, label) {
  if (typeof value !== 'string') throw new Error(`${label} must be a string`);
  try {
    return JSON.parse(value);
  } catch (err) {
    throw new Error(`${label} is not JSON: ${value}; ${errorMessage(err)}`);
  }
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function summarize(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return {
    min: sorted[0],
    median: sorted[Math.floor((sorted.length - 1) / 2)],
    max: sorted[sorted.length - 1],
    samples: values,
  };
}

function sampleOutliers(samples) {
  const totals = samples.map((sample) => sample.totalMs).filter(Number.isFinite);
  if (totals.length < 2) return [];
  const median = medianNumber(totals);
  const threshold = Math.max(750, Math.abs(median) * 0.3);
  return samples
    .map((sample, index) => {
      if (!Number.isFinite(sample.totalMs) || sample.totalMs <= median + threshold) return null;
      return {
        sample: index + 1,
        totalMs: sample.totalMs,
        medianMs: median,
        overMedianMs: Math.round(sample.totalMs - median),
        thresholdMs: Math.round(threshold),
        ...(sample.backendTiming ? { backendTiming: outlierBackendTiming(sample.backendTiming) } : {}),
      };
    })
    .filter(Boolean);
}

function outlierBackendTiming(timing) {
  const phases = [
    'ensureStartedMs',
    'promptBuildMs',
    'threadStartMs',
    'inputPrepareMs',
    'turnStartMs',
    'turnWaitMs',
    'usageWaitMs',
  ].map((key) => ({ key, value: Number.isFinite(timing[key]) ? timing[key] : 0 }));
  const dominant = phases.reduce((best, item) => item.value > best.value ? item : best, phases[0]);
  const total = Number.isFinite(timing.totalMs) && timing.totalMs > 0 ? timing.totalMs : 0;
  return {
    dominantPhase: dominant.key,
    dominantMs: dominant.value,
    turnWaitMs: timing.turnWaitMs ?? 0,
    turnWaitShare: total > 0 ? Math.round((timing.turnWaitMs ?? 0) / total * 100) / 100 : null,
  };
}

function medianNumber(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)];
}

function loadSummaryFile(path) {
  const text = fs.readFileSync(path, 'utf8');
  const marker = 'API_COMPARISON_SUMMARY ';
  const markerIndex = text.lastIndexOf(marker);
  return JSON.parse(markerIndex === -1 ? text : text.slice(markerIndex + marker.length));
}

function compareWithBaseline(baseline, current, options) {
  const baselineRows = new Map(
    (baseline.rows ?? [])
      .filter((row) => row?.ok)
      .map((row) => [rowKey(row), row]),
  );
  const regressions = [];
  const improvements = [];
  const compared = [];
  const skipped = [];
  for (const row of current.rows.filter((item) => item.ok)) {
    if (!shouldCompareRegressionTarget(row.target, options.regressionTargets)) {
      skipped.push({ target: row.target, case: row.case, reason: 'target-filter' });
      continue;
    }
    const baselineRow = baselineRows.get(rowKey(row));
    if (!baselineRow) {
      skipped.push({ target: row.target, case: row.case, reason: 'missing-baseline' });
      continue;
    }
    for (const metric of ['totalMs', 'firstDataMs', 'firstTextMs', 'firstToolArgumentMs', 'firstImageMs']) {
      const before = medianOf(baselineRow[metric]);
      const after = medianOf(row[metric]);
      if (!Number.isFinite(before) || !Number.isFinite(after)) continue;
      const delta = after - before;
      const threshold = Math.max(options.latencyRegressionMs, Math.abs(before) * options.latencyRegressionPct / 100);
      const entry = {
        target: row.target,
        case: row.case,
        metric,
        before,
        after,
        delta,
        threshold: Math.round(threshold),
      };
      compared.push(entry);
      if (delta > threshold) regressions.push(entry);
      else if (delta < -threshold) improvements.push(entry);
    }
    for (const metric of ['quality', 'semanticQuality', 'imageQuality']) {
      const qualityBefore = medianOf(baselineRow[metric]);
      const qualityAfter = medianOf(row[metric]);
      if (!Number.isFinite(qualityBefore) || !Number.isFinite(qualityAfter)) continue;
      const delta = qualityAfter - qualityBefore;
      const entry = {
        target: row.target,
        case: row.case,
        metric,
        before: qualityBefore,
        after: qualityAfter,
        delta,
        threshold: options.qualityRegressionPoints,
      };
      compared.push(entry);
      if (delta < -options.qualityRegressionPoints) regressions.push(entry);
      else if (delta > options.qualityRegressionPoints) improvements.push(entry);
    }
  }
  return {
    baseline: baselinePath,
    targets: options.regressionTargets,
    latencyRegressionPct: options.latencyRegressionPct,
    latencyRegressionMs: options.latencyRegressionMs,
    qualityRegressionPoints: options.qualityRegressionPoints,
    compared: compared.length,
    skipped: skipped.length,
    regressions,
    improvements,
  };
}

function rowKey(row) {
  return `${row.target}\t${row.case}`;
}

function medianOf(summary) {
  return typeof summary?.median === 'number' ? summary.median : Number.NaN;
}

function shouldCompareRegressionTarget(target, filter) {
  if (filter === 'all') return true;
  if (filter === 'proxy') return target.startsWith('proxy-');
  return target.includes(filter);
}

function shouldRunTarget(target) {
  return matchesFilters(target, targetFilters);
}

function shouldRunDiagnosticTarget(target) {
  return Boolean(targetFilters) && shouldRunTarget(target);
}

function shouldRunImageGenerationBenchmarks() {
  return includeImageGeneration
    || Boolean(caseFilters && Object.values(imageGenerationCaseNames).some((caseName) => shouldRunCase(caseName)));
}

function shouldRunImageGenerationPairBenchmark() {
  const caseSelected = exactOrWildcardFilterMatches(imageGenerationCaseNames.generationStreamPaired, caseFilters);
  const pairTargetSelected = exactOrWildcardFilterMatches(imageGenerationPairTarget, targetFilters);
  if (!caseSelected && !pairTargetSelected) return false;
  if (!targetFilters) return true;
  return pairTargetSelected || (shouldRunTarget('proxy-codex') && shouldRunTarget(openAiApiTarget));
}

function shouldRunCase(caseName) {
  return matchesFilters(caseName, caseFilters);
}

function matchesFilters(value, filters) {
  if (!filters) return true;
  return filters.some((filter) => matchesFilter(value, filter));
}

function matchesFilter(value, filter) {
  if (filter === 'all') return true;
  if (filter.includes('*')) {
    const pattern = filter
      .split('*')
      .map((part) => part.replace(/[|\\{}()[\]^$+?.]/g, '\\$&'))
      .join('.*');
    return new RegExp(`^${pattern}$`).test(value);
  }
  return value === filter || value.includes(filter);
}

function exactOrWildcardFilterMatches(value, filters) {
  if (!filters) return false;
  return filters.some((filter) => {
    if (filter === 'all') return true;
    if (!filter.includes('*')) return value === filter;
    const pattern = filter
      .split('*')
      .map((part) => part.replace(/[|\\{}()[\]^$+?.]/g, '\\$&'))
      .join('.*');
    return new RegExp(`^${pattern}$`).test(value);
  });
}

function readFilters(value) {
  if (value === undefined || value === null || value === '' || value === 'all') return null;
  const filters = String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return filters.length > 0 ? filters : null;
}

function readBenchmarkSuites(value) {
  const names = readFilters(value) ?? [];
  for (const name of names) {
    if (!benchmarkSuiteDefinitions[name]) {
      throw new Error(`unknown benchmark suite: ${name}. Supported suites: ${Object.keys(benchmarkSuiteDefinitions).join(', ')}`);
    }
  }
  return names;
}

function benchmarkSuiteCaseFilters(names) {
  if (names.length === 0) return null;
  return uniqueFilters(names.flatMap((name) => benchmarkSuiteDefinitions[name]));
}

function benchmarkSuiteDefaults(names) {
  const has = (name) => names.includes(name);
  return {
    includeMultimodal: has('provider-parity') || has('release-gate'),
    includeImageGeneration: has('image-realistic') || has('release-gate'),
    semanticQualityRepeats: has('quality-realistic') || has('release-gate') ? 1 : 0,
    imageQualityRepeats: has('image-realistic') || has('release-gate') ? 1 : 0,
    minImageQuality: has('image-realistic') || has('release-gate') ? 90 : 0,
  };
}

function mergeFilters(...groups) {
  const filters = uniqueFilters(groups.flatMap((group) => group ?? []));
  if (filters.length === 0) return null;
  if (filters.includes('all')) return ['all'];
  return filters;
}

function uniqueFilters(filters) {
  return [...new Set(filters)];
}

function filterLabel(filters) {
  return filters?.join(',') ?? 'all';
}

function shouldRunSemanticQuality(target) {
  return semanticQualityRepeats > 0 && shouldCompareRegressionTarget(target, semanticQualityTargets);
}

function stripUndefined(value) {
  return JSON.parse(JSON.stringify(value));
}

function truncate(value) {
  return value.length > 2000 ? `${value.slice(0, 2000)}...` : value;
}

function elapsed(startedAt) {
  return Math.round(performance.now() - startedAt);
}

function loadEnvFile(path) {
  if (!fs.existsSync(path)) return;
  for (const line of fs.readFileSync(path, 'utf8').split(/\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match || process.env[match[1]]) continue;
    process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    const key = arg.slice(2, eq === -1 ? undefined : eq).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const value = eq === -1 ? argv[i + 1] : arg.slice(eq + 1);
    if (eq === -1 && (!value || value.startsWith('--'))) out[key] = 'true';
    else {
      if (eq === -1) i += 1;
      out[key] = value;
    }
  }
  return out;
}

function numberOption(value, fallback) {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function countOption(value, fallback) {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function nonNegativeNumberOption(value, fallback) {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function booleanOption(value, fallback) {
  if (value === undefined) return fallback;
  if (value === true || value === 'true' || value === '1' || value === 'yes') return true;
  if (value === false || value === 'false' || value === '0' || value === 'no') return false;
  return fallback;
}

function reasoningEffort(value) {
  if (value === undefined) return undefined;
  if (isReasoningEffort(value)) return value;
  throw new Error(`Unsupported reasoning effort: ${value}`);
}

function optionalReasoningEffort(value) {
  if (value === undefined) return undefined;
  if (isReasoningEffort(value)) return value;
  throw new Error(`Unsupported request reasoning effort: ${value}`);
}

function codexAppServerProxyMode(value) {
  if (value === undefined) return undefined;
  if (isCodexAppServerProxyMode(value)) return value;
  throw new Error(`Unsupported Codex proxy mode: ${value}`);
}

function codexImageTransport(value) {
  if (value === undefined) return 'codex-backend';
  if (value === 'app-server' || value === 'codex-backend') return value;
  throw new Error(`Unsupported Codex image transport: ${value}`);
}

function errorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}
