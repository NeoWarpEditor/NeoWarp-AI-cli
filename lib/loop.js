/**
 * NeoWarpAI CLI — 对话循环。
 * 与桌面版 ai-assistant.js 的 runConversationLoop 同语义：
 * 流式增量（思维链/正文/工具调用按 index 拼接）→ 工具并行执行 →
 * 结果以 role:"tool" 回传（超 4000 字符截断）→ 递归下一轮。
 */
'use strict';

const { streamChat } = require('./llm');
const { parseToolArgs } = require('./json-fix');
const { buildRequestBody, buildHeaders } = require('./llm');
const { createMockStream } = require('./mock-model');

const MAX_ROUNDS = 30;
const TOOL_RESULT_LIMIT = 4000;

/**
 * @param {object} opts
 *   messages      消息数组（会原地追加 assistant/tool 消息）
 *   cfg           模型配置
 *   endpointModel {endpoint, model, apiFormat}
 *   tools         function calling 定义
 *   backend       ToolBackend
 *   render        {onText(t), onReasoning(t), onRoundStart(n), onToolStart(name,args), onToolEnd(name, result)}
 *   signal        AbortSignal（可选）
 *   mockScript    mock 脚本路径（可选）
 * @returns {Promise<{rounds: number, toolCalls: number, aborted: boolean, error?: Error}>}
 */
async function runConversationLoop (opts) {
  const { messages, cfg, endpointModel, tools, backend, render } = opts;
  const apiFormat = endpointModel.apiFormat;
  const mock = apiFormat === 'mock' ? createMockStream(opts.mockScript) : null;

  let rounds = 0;
  let toolCallCount = 0;

  for (;;) {
    if (rounds++ >= MAX_ROUNDS) {
      render.onText('\n[已达单次任务最大工具轮数 ' + MAX_ROUNDS + '，停止。]');
      return { rounds, toolCalls: toolCallCount, aborted: false };
    }
    render.onRoundStart && render.onRoundStart(rounds);

    let fullContent = '';
    let fullReasoning = '';
    const toolCallsMap = {};
    let hasToolCalls = false;
    let finishReason = '';
    let loopError = null;
    let aborted = false;

    const sink = {
      onText (t) { fullContent += t; render.onText(t); },
      onReasoning (t) { fullReasoning += t; render.onReasoning(t); },
      onToolCallDelta (d) {
        hasToolCalls = true;
        if (!toolCallsMap[d.index]) toolCallsMap[d.index] = { id: '', name: '', arguments: '', argsObj: null };
        const slot = toolCallsMap[d.index];
        if (d.id) slot.id = d.id;
        if (d.nameDelta) slot.name += d.nameDelta;
        if (d.argsDelta) slot.arguments += d.argsDelta;
        if (d.argsObj) slot.argsObj = d.argsObj;
      },
      onFinish (reason) { finishReason = reason; },
      onError (err) { loopError = err; }
    };

    const body = buildRequestBody(apiFormat, cfg, endpointModel.model, messages, tools, !mock);
    if (mock) {
      await mock({ messages, apiFormat, signal: opts.signal }, sink);
    } else {
      await streamChat({
        endpoint: endpointModel.endpoint,
        headers: buildHeaders(apiFormat, cfg),
        body,
        apiFormat,
        signal: opts.signal
      }, sink);
    }

    if (opts.signal && opts.signal.aborted) aborted = true;
    if (loopError && !hasToolCalls) {
      return { rounds, toolCalls: toolCallCount, aborted, error: loopError };
    }

    const pending = Object.keys(toolCallsMap).sort((a, b) => a - b).map(k => {
      const s = toolCallsMap[k];
      if (!s.id) s.id = 'call_r' + rounds + '_' + k;
      return s;
    });

    if (pending.length > 0 && (finishReason === 'tool_calls' || hasToolCalls)) {
      // assistant 工具调用消息入历史
      messages.push({
        role: 'assistant',
        content: fullContent || null,
        tool_calls: pending.map(tc => ({
          id: tc.id, type: 'function',
          function: { name: tc.name, arguments: tc.argsObj ? JSON.stringify(tc.argsObj) : tc.arguments }
        }))
      });

      // 并行执行工具
      const results = await Promise.all(pending.map(async tc => {
        const { args, error, fixed } = tc.argsObj
          ? { args: tc.argsObj, error: null, fixed: false }
          : parseToolArgs(tc.arguments);
        let result;
        if (error) {
          result = {
            success: false,
            error: 'JSON 参数解析失败: ' + error + '\n提示: script 参数中的换行必须写成 \\n，引号必须写成 \\"' +
              '\n原始参数(前500字符): ' + (tc.arguments || '').slice(0, 500)
          };
        } else {
          render.onToolStart && render.onToolStart(tc.name, args, fixed);
          result = await backend.execute(tc.name, args);
          render.onToolEnd && render.onToolEnd(tc.name, result);
          toolCallCount++;
        }
        let resultStr = JSON.stringify(result);
        if (resultStr.length > TOOL_RESULT_LIMIT) {
          resultStr = resultStr.slice(0, TOOL_RESULT_LIMIT) + '\n[结果已截断]';
        }
        return { toolCallId: tc.id, content: resultStr };
      }));

      for (const r of results) {
        messages.push({ role: 'tool', tool_call_id: r.toolCallId, content: r.content });
      }
      continue; // 下一轮
    }

    // 纯文本回复：入历史并结束
    messages.push({ role: 'assistant', content: fullContent });
    return { rounds, toolCalls: toolCallCount, aborted, error: null };
  }
}

module.exports = { runConversationLoop, MAX_ROUNDS };
