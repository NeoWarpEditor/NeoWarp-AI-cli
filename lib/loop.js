/**
 * NeoWarpAI CLI — 对话循环。
 * 与桌面版 ai-assistant.html 内联脚本的 runConversationLoop 同语义：
 * 流式增量（思维链/正文/工具调用按 index 拼接）→ 工具并行执行 →
 * 结果以 role:"tool" 回传 → 递归下一轮。
 *
 * 本轮同步自上游的行为：
 *  - 上下文预算：按模型 contextLimit 的 80% 从后往前裁剪历史，超出的旧消息
 *    以一条 [历史摘要] 系统消息代替；裁剪后修复 assistant/tool 配对
 *  - 断连自动重试：网络错误、流中断、408/429/5xx 或空响应时每 5 秒重试一次，
 *    最多 10 次（CLI 直接在终端流式输出，已产生可见输出时不重试，避免重复刷屏）
 *  - 幻觉/循环输出检测：同一文段连续输出 10 次即就地中止，保留已产出内容
 *  - assistant 消息携带 reasoning（思维链），下一轮请求按格式回传
 */
'use strict';

const { streamChat, buildRequestBody, buildHeaders, resolveMaxTokens } = require('./llm');
const { parseToolArgs } = require('./json-fix');
const { createMockStream } = require('./mock-model');
const { getContextLimit } = require('./providers');

const MAX_ROUNDS = 30;
const MAX_STREAM_RETRIES = 10;
const STREAM_RETRY_DELAY_MS = 5000;

// ── 循环输出检测（与桌面版同一组常量）─────────────────────────
const LOOP_REPEAT_THRESHOLD = 10;    // 同一文段连续出现次数
const LOOP_MIN_SEGMENT_CHARS = 8;    // 视为“文段”的最小非空白长度
const LOOP_MAX_SEGMENT_CHARS = 600;  // 单段最大长度，超出视为不同文段
const LOOP_MIN_TOTAL_CHARS = 160;    // 全文太短时不判定，避免误伤正常重复

function estimateTokens (text) {
  if (!text) return 0;
  const str = typeof text === 'string' ? text : JSON.stringify(text);
  // base64 大块数据按占位符估算，避免个别消息撑爆上下文预算
  const cleaned = str
    .replace(/data:[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]{64,}/g, '[base64 image]')
    .replace(/[A-Za-z0-9+/=]{2048,}/g, '[base64]');
  const cjk = (cleaned.match(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g) || []).length;
  return Math.ceil(cjk * 1.5 + (cleaned.length - cjk) / 4);
}

function estimateMessagesTokens (list) {
  let total = 0;
  for (const m of (list || [])) {
    if (!m) continue;
    if (typeof m.content === 'string') total += estimateTokens(m.content);
    if (m.tool_calls) total += estimateTokens(JSON.stringify(m.tool_calls));
    if (m.reasoning) total += estimateTokens(m.reasoning);
  }
  return total;
}

/** 判断一段文字本身是否由更短片段重复构成（分隔线/表格之类不该当循环证据）。 */
function isSelfRepeatingSegment (str) {
  for (let q = 1; q <= str.length / 2; q++) {
    if (str.length % q !== 0) continue;
    if (str.slice(0, q).repeat(str.length / q) === str) return true;
  }
  return false;
}

/** 检测文本结尾是否由同一文段连续重复 LOOP_REPEAT_THRESHOLD 次。 */
function detectRepeatedSegment (text) {
  if (!text) return null;
  const s = String(text);
  if (s.length < LOOP_MIN_TOTAL_CHARS) return null;
  const scan = s.length > 12000 ? s.slice(-12000) : s;
  const lastChar = scan.charAt(scan.length - 1);
  const maxPeriod = Math.min(LOOP_MAX_SEGMENT_CHARS, Math.floor(scan.length / LOOP_REPEAT_THRESHOLD));
  for (let p = 1; p <= maxPeriod; p++) {
    // 末尾重复块的最后一个字符必须等于全文最后一个字符，先用它做一次廉价剪枝
    if (scan.charAt(scan.length - p - 1) !== lastChar) continue;
    const block = scan.slice(-p);
    if (block.trim().length < LOOP_MIN_SEGMENT_CHARS) continue;
    if (isSelfRepeatingSegment(block)) continue;
    let repeated = true;
    for (let i = 1; i < LOOP_REPEAT_THRESHOLD; i++) {
      if (scan.slice(-(i + 1) * p, -i * p) !== block) { repeated = false; break; }
    }
    if (repeated) return block;
  }
  return null;
}

/** 裁剪后可能切出孤立的 tool 消息，这里把不完整的工具调用对整体丢弃。 */
function sanitizeToolCallPairs (apiMessages) {
  const cleaned = [];
  let i = 0;
  while (i < apiMessages.length) {
    const msg = apiMessages[i];
    if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
      const requiredIds = msg.tool_calls.map(tc => tc.id);
      let j = i + 1;
      const coveredIds = {};
      while (j < apiMessages.length && apiMessages[j].role === 'tool') {
        if (apiMessages[j].tool_call_id) coveredIds[apiMessages[j].tool_call_id] = true;
        j++;
      }
      const allCovered = requiredIds.every(id => coveredIds[id]);
      if (allCovered) {
        cleaned.push(msg);
        for (let k = i + 1; k < j; k++) cleaned.push(apiMessages[k]);
      }
      i = j;
    } else if (msg.role === 'tool') {
      i++;
    } else {
      cleaned.push(msg);
      i++;
    }
  }
  apiMessages.length = 0;
  apiMessages.push(...cleaned);
}

/** CLI 消息 → 请求消息（补 reasoning_content），并按上下文预算裁剪历史。 */
function buildRequestMessages (messages, cfg) {
  const systemPrompt = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
  const apiMessages = [];
  if (systemPrompt) apiMessages.push({ role: 'system', content: systemPrompt });

  const ctxLimit = getContextLimit(cfg);
  const tokenBudget = Math.floor(ctxLimit * 0.8);

  const toApiMessage = (m) => {
    if (m.role === 'tool') return { role: 'tool', tool_call_id: m.tool_call_id, content: m.content };
    if (m.role === 'assistant') {
      const out = { role: 'assistant', content: m.content == null ? '' : m.content };
      if (m.tool_calls && m.tool_calls.length) out.tool_calls = m.tool_calls;
      if (m.reasoning) out.reasoning_content = m.reasoning;
      return out;
    }
    return { role: m.role, content: m.content };
  };

  // 从后往前走，累计 token 直到预算用完；最近的消息永远保留
  const history = messages.filter(m => m.role !== 'system');
  const included = [];
  let runningTokens = estimateTokens(systemPrompt);
  let droppedCount = 0;
  let hitBudget = false;
  for (let i = history.length - 1; i >= 0; i--) {
    if (hitBudget) { droppedCount++; continue; }
    const apiMsg = toApiMessage(history[i]);
    const msgTokens = estimateMessagesTokens([apiMsg]);
    if (runningTokens + msgTokens > tokenBudget && included.length > 0) {
      hitBudget = true;
      droppedCount++;
      continue;
    }
    runningTokens += msgTokens;
    included.unshift(apiMsg);
  }

  if (droppedCount > 0) {
    apiMessages.push({ role: 'system', content: '[历史摘要] 之前的 ' + droppedCount + ' 条对话已省略以节省上下文。' });
  }
  apiMessages.push(...included);
  sanitizeToolCallPairs(apiMessages);
  return { messages: apiMessages, tokenCount: estimateMessagesTokens(apiMessages) };
}

function isTransientStreamFailure (err) {
  if (!err) return true;
  if (err.name === 'AbortError') return false;
  if (err.noRetry) return false;
  if (err.status) return err.status === 408 || err.status === 429 || err.status >= 500;
  return true;
}

function sleep (ms, signal) {
  return new Promise(resolve => {
    if (signal && signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    if (signal) signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });
}

/**
 * 跑一次流式请求（不做重试），把增量聚合成完整结果。
 * @returns {Promise<{content, reasoning, toolCalls, finishReason, error, aborted, loopDetected}>}
 */
async function streamAttempt (opts) {
  const { apiFormat, cfg, endpointModel, requestMessages, tools, maxTokens, mockStream, signal, render } = opts;
  const attempt = {
    content: '',
    reasoning: '',
    toolCalls: [],
    finishReason: '',
    error: null,
    aborted: false,
    loopDetected: false
  };
  const toolCallsMap = {};
  let hasToolCalls = false;
  let lastLoopCheckAt = 0;

  const controller = new AbortController();
  const onUserAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onUserAbort, { once: true });
  }

  const sink = {
    onText (t) {
      attempt.content += t;
      render.onText(t);
      // 正文每增长 24 个字符检查一次是否陷入重复输出；命中即中止本次流
      if (attempt.content.length - lastLoopCheckAt >= 24) {
        lastLoopCheckAt = attempt.content.length;
        const segment = detectRepeatedSegment(attempt.content);
        if (segment) {
          attempt.loopDetected = true;
          controller.abort();
        }
      }
    },
    onReasoning (t) { attempt.reasoning += t; render.onReasoning(t); },
    onToolCallDelta (d) {
      hasToolCalls = true;
      if (!toolCallsMap[d.index]) toolCallsMap[d.index] = { id: '', name: '', arguments: '', argsObj: null };
      const slot = toolCallsMap[d.index];
      if (d.id) slot.id = d.id;
      if (d.nameDelta) slot.name += d.nameDelta;
      if (d.argsDelta) slot.arguments += d.argsDelta;
      if (d.argsObj) slot.argsObj = d.argsObj;
    },
    onFinish (reason) { attempt.finishReason = reason; },
    onError (err) { attempt.error = err; }
  };

  try {
    if (apiFormat === 'mock') {
      await mockStream({ messages: requestMessages, apiFormat, signal: controller.signal }, sink);
    } else {
      const body = buildRequestBody(apiFormat, cfg, endpointModel.model, requestMessages, tools, true, maxTokens);
      await streamChat({
        endpoint: endpointModel.endpoint,
        headers: buildHeaders(apiFormat, cfg),
        body,
        apiFormat,
        signal: controller.signal
      }, sink);
    }
  } catch (err) {
    if (!attempt.error) attempt.error = err;
  } finally {
    if (signal) signal.removeEventListener('abort', onUserAbort);
  }

  attempt.aborted = !!(signal && signal.aborted);
  if (hasToolCalls) {
    attempt.toolCalls = Object.keys(toolCallsMap)
      .sort((a, b) => a - b)
      .map(k => toolCallsMap[k]);
  }
  if (attempt.loopDetected) attempt.error = null;
  return attempt;
}

/**
 * @param {object} opts
 *   messages      消息数组（会原地追加 assistant/tool 消息）
 *   cfg           模型配置
 *   endpointModel {endpoint, model, apiFormat}
 *   tools         function calling 定义
 *   backend       ToolBackend
 *   render        {onText(t), onReasoning(t), onRoundStart(n), onToolStart(name,args),
 *                  onToolEnd(name, result), note(text)}
 *   signal        AbortSignal（可选）
 *   mockScript    mock 脚本路径（可选）
 * @returns {Promise<{rounds: number, toolCalls: number, aborted: boolean, loopDetected?: boolean, error?: Error}>}
 */
async function runConversationLoop (opts) {
  const { messages, cfg, endpointModel, tools, backend, render } = opts;
  const apiFormat = endpointModel.apiFormat;
  // Mock 脚本按轮次顺序推进，必须整场对话共用一个闭包（不能每轮新建）
  const mockStream = apiFormat === 'mock' ? createMockStream(opts.mockScript) : null;

  let rounds = 0;
  let toolCallCount = 0;

  for (;;) {
    if (rounds++ >= MAX_ROUNDS) {
      render.onText('\n[已达单次任务最大工具轮数 ' + MAX_ROUNDS + '，停止。]');
      return { rounds, toolCalls: toolCallCount, aborted: false };
    }
    render.onRoundStart && render.onRoundStart(rounds);

    const built = buildRequestMessages(messages, cfg);
    const maxTokens = resolveMaxTokens(cfg, built.tokenCount);

    let attempt = null;
    let retryAttempt = 0;
    for (;;) {
      attempt = await streamAttempt({
        apiFormat, cfg, endpointModel, requestMessages: built.messages, tools, maxTokens,
        mockStream, signal: opts.signal, render
      });

      if (attempt.aborted || attempt.loopDetected) break;

      if (attempt.error) {
        const transient = isTransientStreamFailure(attempt.error);
        const hadVisibleOutput = !!(attempt.content || attempt.reasoning || attempt.toolCalls.length);
        if (transient && !hadVisibleOutput && retryAttempt < MAX_STREAM_RETRIES) {
          retryAttempt++;
          const seconds = STREAM_RETRY_DELAY_MS / 1000;
          if (render.note) render.note('连接中断（' + attempt.error.message + '），' + seconds + ' 秒后重试 ' + retryAttempt + '/' + MAX_STREAM_RETRIES);
          await sleep(STREAM_RETRY_DELAY_MS, opts.signal);
          if (opts.signal && opts.signal.aborted) { attempt.aborted = true; break; }
          continue;
        }
        break;
      }

      // 空响应保护：流结束却没有任何正文/思维链/工具调用，按断连处理自动重试
      if (!attempt.content.trim() && !attempt.reasoning && !attempt.toolCalls.length) {
        if (retryAttempt < MAX_STREAM_RETRIES) {
          retryAttempt++;
          const seconds = STREAM_RETRY_DELAY_MS / 1000;
          if (render.note) render.note('模型返回空响应，' + seconds + ' 秒后重试 ' + retryAttempt + '/' + MAX_STREAM_RETRIES);
          await sleep(STREAM_RETRY_DELAY_MS, opts.signal);
          if (opts.signal && opts.signal.aborted) { attempt.aborted = true; break; }
          continue;
        }
        attempt.error = new Error('模型连续 ' + MAX_STREAM_RETRIES + ' 次返回空响应，已停止。');
      }
      break;
    }

    if (attempt.aborted) {
      return { rounds, toolCalls: toolCallCount, aborted: true };
    }
    if (attempt.loopDetected) {
      // 幻觉/循环输出：已经烧掉的 token 收不回来，立刻结束本回合（不重试、
      // 不续跑工具循环），把已产出的内容如实留档
      const stored = attempt.content.length > 6000
        ? attempt.content.slice(0, 6000) + '\n\n…（重复内容已截断）'
        : attempt.content;
      const loopMsg = { role: 'assistant', content: stored };
      if (attempt.reasoning) loopMsg.reasoning = attempt.reasoning;
      messages.push(loopMsg);
      if (render.note) render.note('模型输出陷入重复，已中止本回合（对话已暂停，可直接发新消息）。', true);
      return { rounds, toolCalls: toolCallCount, aborted: false, loopDetected: true };
    }
    if (attempt.error) {
      return { rounds, toolCalls: toolCallCount, aborted: false, error: attempt.error };
    }

    const pending = attempt.toolCalls;

    if (pending.length > 0) {
      // assistant 工具调用消息入历史
      const assistantMsg = {
        role: 'assistant',
        content: attempt.content || null,
        tool_calls: pending.map(tc => ({
          id: tc.id || 'call_r' + rounds + '_' + tc.name,
          type: 'function',
          function: { name: tc.name, arguments: tc.argsObj ? JSON.stringify(tc.argsObj) : tc.arguments }
        }))
      };
      if (attempt.reasoning) assistantMsg.reasoning = attempt.reasoning;
      messages.push(assistantMsg);

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
        // 结果完整回传（与桌面版一致）：超长历史交给下一轮的上下文预算裁剪
        return { toolCallId: tc.id || 'call_r' + rounds + '_' + tc.name, content: JSON.stringify(result) };
      }));

      for (const r of results) {
        messages.push({ role: 'tool', tool_call_id: r.toolCallId, content: r.content });
      }
      continue; // 下一轮
    }

    // 纯文本回复：入历史并结束
    const finalMsg = { role: 'assistant', content: attempt.content };
    if (attempt.reasoning) finalMsg.reasoning = attempt.reasoning;
    messages.push(finalMsg);
    return { rounds, toolCalls: toolCallCount, aborted: false, error: null };
  }
}

module.exports = {
  runConversationLoop,
  buildRequestMessages,
  detectRepeatedSegment,
  estimateTokens,
  MAX_ROUNDS,
  MAX_STREAM_RETRIES
};
