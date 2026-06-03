#!/usr/bin/env node
import fs from 'node:fs';
import { deflateSync } from 'node:zlib';
import { ClaudeCodeBackend } from '../dist/proxy/claude-code-backend.js';
import { CodexAppServerBackend } from '../dist/proxy/codex-app-server-backend.js';
import { startLocalApiProxy } from '../dist/proxy/http-server.js';
import { isReasoningEffort } from '../dist/settings.js';

loadEnvFile('.env');

const options = parseArgs(process.argv.slice(2));
const timeoutMs = numberOption(options.timeoutMs, 240_000);
const repeats = numberOption(options.repeats, 1);
const qualityRepeats = numberOption(options.qualityRepeats, 0);
const semanticQualityRepeats = numberOption(options.semanticQualityRepeats, 0);
const includeMultimodal = booleanOption(options.includeMultimodal, false);
const cwd = options.cwd ?? process.cwd();
const openAiModel = options.openaiModel ?? 'gpt-5.5';
const anthropicModels = {
  opus: options.anthropicOpusModel ?? 'claude-opus-4-8',
  sonnet: options.anthropicSonnetModel ?? 'claude-sonnet-4-6',
  haiku: options.anthropicHaikuModel ?? 'claude-haiku-4-5-20251001',
};
const outputPath = options.output;
const baselinePath = options.baseline;
const regressionTargets = options.regressionTargets ?? 'proxy';
const latencyRegressionPct = numberOption(options.latencyRegressionPct, 30);
const latencyRegressionMs = numberOption(options.latencyRegressionMs, 750);
const qualityRegressionPoints = numberOption(options.qualityRegressionPoints, 5);
const semanticQualityTargets = options.semanticQualityTargets ?? 'proxy';
const semanticQualityJudgeModel = options.semanticQualityJudgeModel ?? openAiModel;
const semanticQualityReference = booleanOption(options.semanticQualityReference, true);
const semanticQualitySuite = options.semanticQualitySuite ?? 'realistic';
const minSemanticQuality = numberOption(options.minSemanticQuality, 0);
const expectProviderErrors = booleanOption(options.expectProviderErrors, false);
const requestReasoningEffort = optionalReasoningEffort(options.requestReasoningEffort);
const targetFilters = readFilters(options.targets ?? options.target);
const caseFilters = readFilters(options.cases ?? options.case);

const rows = [];
const servers = [];
const semanticReferenceCache = new Map();
let redVisionDataUrl;
const backendTimingQueues = new Map();

try {
  let proxyCodex = null;
  let proxyClaude = null;
  if (shouldRunTarget('proxy-codex')) {
    proxyCodex = await startProxy(new CodexAppServerBackend({
      command: options.codexCommand,
      cwd,
      model: options.codexModel,
      timeoutMs,
      reasoningEffort: reasoningEffort(options.reasoningEffort),
      onTiming: (timing) => pushBackendTiming('proxy-codex', timing),
    }));
  }
  if (shouldRunTarget('proxy-claude')) {
    proxyClaude = await startProxy(new ClaudeCodeBackend({
      command: options.claudeCommand,
      cwd,
      model: options.claudeCliModel ?? 'sonnet',
      timeoutMs,
    }));
  }

  if (proxyCodex) await benchmarkOpenAiChatCompatible('proxy-codex', proxyCodex.url, proxyCodex.model, false);
  if (proxyClaude) await benchmarkOpenAiChatCompatible('proxy-claude', proxyClaude.url, proxyClaude.model, false);
  if (proxyCodex) await benchmarkOpenAiCompatible('proxy-codex', proxyCodex.url, proxyCodex.model, false);
  if (proxyClaude) await benchmarkOpenAiCompatible('proxy-claude', proxyClaude.url, proxyClaude.model, false);
  const openAiApiTarget = 'openai-api:gpt-5.5';
  if (shouldRunTarget(openAiApiTarget)) {
    if (process.env.OPENAI_API_KEY) {
      await benchmarkOpenAiChatCompatible(openAiApiTarget, 'https://api.openai.com', openAiModel, true);
      await benchmarkOpenAiCompatible(openAiApiTarget, 'https://api.openai.com', openAiModel, true);
    } else {
      rows.push({ target: openAiApiTarget, ok: false, skipped: true, error: 'OPENAI_API_KEY missing' });
    }
  }

  if (proxyCodex) await benchmarkAnthropicCompatible('proxy-codex', proxyCodex.url, proxyCodex.model, false);
  if (proxyClaude) await benchmarkAnthropicCompatible('proxy-claude', proxyClaude.url, proxyClaude.model, false);
  if (process.env.ANTHROPIC_API_KEY) {
    for (const [family, model] of Object.entries(anthropicModels)) {
      const target = `anthropic-api:${family}`;
      if (shouldRunTarget(target)) {
        await benchmarkAnthropicCompatible(target, 'https://api.anthropic.com', model, true);
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
  semanticQualityTargets,
  semanticQualityJudgeModel,
  semanticQualityReference,
  semanticQualityReferenceMode: 'proxy-provider',
  semanticQualitySuite,
  minSemanticQuality,
  expectProviderErrors,
  requestReasoningEffort,
  targetFilters: filterLabel(targetFilters),
  caseFilters: filterLabel(caseFilters),
  includeMultimodal,
  openAiModel,
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
  ...(regressionGate ? { regressionGate } : {}),
};
if (outputPath) {
  fs.writeFileSync(outputPath, `${JSON.stringify(summary, null, 2)}\n`);
}
console.log(`\nAPI_COMPARISON_SUMMARY ${JSON.stringify(summary, null, 2)}`);
process.exit(failed.length > 0 || (regressionGate?.regressions.length ?? 0) > 0 ? 1 : 0);

async function startProxy(backend) {
  const server = await startLocalApiProxy({
    backend,
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
        const reference = await semanticReference('openai.chat', target, `${task.id}:${index}`, prompt);
        const judged = await scoreSemanticQuality({
          target,
          caseName: `openai.chat.semantic_quality.${task.id}`,
          prompt,
          text,
          reference,
        });
        return { totalMs: response.totalMs, text, quality: scoreQualityOutput(text, task), ...judged };
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
      const reference = await semanticReference('openai.chat', target, `request_reasoning:${requestReasoningEffort}:${index}`, prompt, {
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
        const reference = await semanticReference('openai.responses', target, `${task.id}:${index}`, prompt);
        const judged = await scoreSemanticQuality({
          target,
          caseName: `openai.responses.semantic_quality.${task.id}`,
          prompt,
          text,
          reference,
        });
        return { totalMs: response.totalMs, text, quality: scoreQualityOutput(text, task), ...judged };
      });
    }
  }
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
        max_tokens: 32,
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
        const reference = await semanticReference('anthropic.messages', target, `${task.id}:${index}`, prompt);
        const judged = await scoreSemanticQuality({
          target,
          caseName: `anthropic.messages.semantic_quality.${task.id}`,
          prompt,
          text,
          reference,
        });
        return { totalMs: response.totalMs, text, quality: scoreQualityOutput(text, task), ...judged };
      });
    }
  }
}

async function benchmarkCase(target, caseName, count, fn) {
  if (!shouldRunCase(caseName)) return;
  const samples = [];
  for (let i = 0; i < count; i += 1) {
    try {
      const sample = await fn(i + 1);
      attachBackendTiming(target, sample);
      samples.push(sample);
      console.log(`PASS ${target} ${caseName} #${i + 1}: ${JSON.stringify(sample)}`);
    } catch (err) {
      const row = {
        target,
        case: caseName,
        ok: false,
        error: errorMessage(err),
      };
      rows.push(row);
      console.log(`FAIL ${target} ${caseName} #${i + 1}: ${row.error}`);
      return;
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
    chunks: samples.map((sample) => sample.chunks).filter(Number.isFinite),
    sample: samples.at(-1),
  };
  const backendTiming = summarizeBackendTimings(samples);
  if (backendTiming) row.backendTiming = backendTiming;
  const outliers = sampleOutliers(samples);
  if (outliers.length > 0) row.outliers = outliers;
  rows.push(row);
}

async function benchmarkQualityCase(target, caseName, count, fn) {
  if (!shouldRunCase(caseName)) return;
  const samples = [];
  for (let i = 0; i < count; i += 1) {
    try {
      const sample = await fn(i + 1);
      attachBackendTiming(target, sample);
      samples.push(sample);
      console.log(`PASS ${target} ${caseName} #${i + 1}: ${JSON.stringify({
        totalMs: sample.totalMs,
        quality: sample.quality,
        semanticQuality: sample.semanticQuality,
        judgeMs: sample.judgeMs,
        backendTiming: sample.backendTiming,
      })}`);
    } catch (err) {
      const row = {
        target,
        case: caseName,
        ok: false,
        error: errorMessage(err),
      };
      rows.push(row);
      console.log(`FAIL ${target} ${caseName} #${i + 1}: ${row.error}`);
      return;
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
  const judgeMs = samples.map((sample) => sample.judgeMs).filter(Number.isFinite);
  if (judgeMs.length > 0) row.judgeMs = summarize(judgeMs);
  const backendTiming = summarizeBackendTimings(samples);
  if (backendTiming) row.backendTiming = backendTiming;
  const outliers = sampleOutliers(samples);
  if (outliers.length > 0) row.outliers = outliers;
  const lowestSemanticScore = Math.min(...semanticScores);
  if (semanticScores.length > 0 && minSemanticQuality > 0 && lowestSemanticScore < minSemanticQuality) {
    row.ok = false;
    row.error = `semantic quality below ${minSemanticQuality}: ${lowestSemanticScore}`;
  }
  rows.push(row);
}

async function postJson(url, body, headers) {
  const startedAt = performance.now();
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(stripUndefined(body)),
    signal: AbortSignal.timeout(timeoutMs),
  });
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
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(stripUndefined(body)),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { raw: text };
  }
  assertEqual(res.status, expected.status, 'expected provider error status');
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

async function postSse(url, body, headers, collectText, collectToolArgument = () => '') {
  const startedAt = performance.now();
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(stripUndefined(body)),
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

  while (true) {
    const read = await reader.read();
    if (read.done) break;
    buffer += decoder.decode(read.value, { stream: true });
    let index;
    while ((index = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      const lines = frame.split(/\n/);
      const event = lines.find((line) => line.startsWith('event: '))?.slice(7) ?? 'message';
      const data = lines.find((line) => line.startsWith('data: '))?.slice(6);
      if (!data) continue;
      if (data === '[DONE]') {
        done = true;
        continue;
      }
      if (firstDataMs === null) firstDataMs = elapsed(startedAt);
      let payload;
      try {
        payload = JSON.parse(data);
      } catch {
        continue;
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
  }
  return { totalMs: elapsed(startedAt), firstDataMs, firstTextMs, firstToolArgumentMs, chunks, text, toolArguments, done, events };
}

function openAiHeaders(isApi) {
  return {
    'content-type': 'application/json',
    ...(isApi
      ? { authorization: `Bearer ${process.env.OPENAI_API_KEY}` }
      : { authorization: 'Bearer local' }),
  };
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

function visionDataUrl() {
  redVisionDataUrl ??= solidPngDataUrl(64, 64, { r: 255, g: 0, b: 0, a: 255 });
  return redVisionDataUrl;
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
  assertEqual(eventTypes[0], 'message_start', 'anthropic first stream event');
  assert(eventTypes.includes('content_block_delta'), 'anthropic stream missing content delta');
  assert(eventTypes.includes('message_delta'), 'anthropic stream missing message_delta');
  assertEqual(eventTypes.at(-1), 'message_stop', 'anthropic last stream event');
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

function attachBackendTiming(target, sample) {
  const queue = backendTimingQueues.get(target);
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
    'totalMs',
  ]) {
    const values = timings.map((timing) => timing[key]).filter(Number.isFinite);
    if (values.length > 0) summary[key] = summarize(values);
  }
  return summary;
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
      prompt: [
        'Write a concise engineering handoff in English for the next maintainer of a local OAuth CLI API proxy.',
        'Current facts: provider token usage is preserved in public usage fields; stream rows track firstDataMs, firstTextMs, and firstToolArgumentMs; semantic quality must stay at least 95; proxy-codex latency outliers are dominated by turnWaitMs; request-level effort overrides backend fallback settings.',
        'Return exactly five bullets.',
        'Each bullet must name the product consequence first, then the technical authority.',
        'Preserve exact identifiers and numeric thresholds: write "at least 95" as a score, not 95%, and state that outliers are dominated by turnWaitMs.',
        'Include these exact authority phrases once each: "stream rows track firstDataMs, firstTextMs, and firstToolArgumentMs"; "proxy-codex latency outliers are dominated by turnWaitMs"; "request-level effort overrides backend fallback settings".',
        'Keep each bullet under 18 words.',
        'Avoid historical narration and avoid asking follow-up questions.',
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
  const characters = text.trim().length;
  const structureScore = task.format === 'table'
    ? Math.min(1, tableRows / 6)
    : Math.min(1, bulletCount / (task.id === 'handoff_summary' ? 5 : task.id === 'benchmark_failure_triage' ? 4 : 3));
  const keywordScore = keywordHits / required.length;
  const lengthScore = characters >= 120 && characters <= 1200 ? 1 : Math.max(0, 1 - Math.abs(characters - 480) / 480);
  return {
    score: Math.round((keywordScore * 0.5 + structureScore * 0.3 + lengthScore * 0.2) * 100),
    keywordHits,
    bulletCount,
    tableRows,
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

function semanticReferenceProvider(target) {
  if (target === 'proxy-codex') return 'openai';
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
      max_output_tokens: 640,
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
    max_completion_tokens: 640,
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
    model: anthropicModels.sonnet,
    max_tokens: 640,
    messages: [{ role: 'user', content: prompt }],
  }, anthropicHeaders(true));
  assertAnthropicMessageShape(response.body, 'end_turn');
  return {
    target: `anthropic-api:${anthropicModels.sonnet}`,
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
      'Do not reward reference similarity when both the reference and candidate violate the explicit original request.',
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
  assert(typeof value.rationale === 'string', 'semantic judge rationale must be string');
  assert(Array.isArray(value.issues), 'semantic judge issues must be array');
  for (const issue of value.issues) {
    assert(typeof issue === 'string', 'semantic judge issue must be string');
  }
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
    for (const metric of ['totalMs', 'firstDataMs', 'firstTextMs', 'firstToolArgumentMs']) {
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
    for (const metric of ['quality', 'semanticQuality']) {
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

function readFilters(value) {
  if (value === undefined || value === null || value === '' || value === 'all') return null;
  const filters = String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return filters.length > 0 ? filters : null;
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

function errorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}
