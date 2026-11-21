/**
 * NeoWarpAI CLI — 模型调用层。
 *
 * 三种 API 格式的流式实现，语义与桌面版 ai-assistant.html 内联脚本的
 * runConversationLoop / buildChatRequest 对齐：
 *  - openai:   POST {endpoint}（Bearer 鉴权），SSE `data:` 行，
 *              delta.reasoning_content 思维链、delta.tool_calls 按 index 增量拼接
 *  - anthropic: POST /v1/messages（x-api-key），SSE 事件流，
 *              content_block_delta.text_delta / input_json_delta
 *  - ollama:   POST /api/chat（默认无鉴权头，填了 Key 时带 Bearer），NDJSON 行流
 *  - mock:     内置演示模型（见 lib/mock-model.js），无网络即可验证全链路
 *
 * 同时移植 lenientFixJsonStrings：把模型输出的 JSON 字符串值里裸换行/制表符
 * 转成 \n \t —— 很多模型在 script 参数里写真实换行而不是 \n 转义。
 */
'use strict';

const { lenientFixJson } = require('./json-fix');
const { getModelInfo, getContextLimit, getModelMaxOutput } = require('./providers');

// ── 思考参数 ──────────────────────────────────────────────────
// 各服务商请求体里真正接受的思考参数形态（与桌面版 THINKING_PARAM_SUPPORT
// 同一张表）：qwen / huaweipangu 的接口不接受思考参数，故不在表内。
const THINKING_PARAM_SUPPORT = {
  openai: 'reasoning_effort',
  kimi: 'reasoning_effort',
  deepseek: 'thinking_toggle',
  mimo: 'thinking_toggle',
  glm: 'thinking_toggle'
};

function thinkingParamStyleFor (provider, apiFormat) {
  if (provider === 'custom') {
    // 自定义端点仅在明确选择 OpenAI 兼容格式时才附带 reasoning_effort，
    // 否则贸然加参数可能被对端拒绝。
    return apiFormat === 'openai' ? 'reasoning_effort' : null;
  }
  return THINKING_PARAM_SUPPORT[provider] || null;
}

/** 模型自身要支持推理，且其服务商接口要能接受思考参数，两者缺一不可。 */
function modelSupportsThinking (modelInfo, cfg, apiFormat) {
  if (!modelInfo || !modelInfo.supportsReasoning) return false;
  return !!thinkingParamStyleFor(cfg.provider, apiFormat);
}

function applyThinkingParams (body, cfg, apiFormat, modelInfo) {
  if (!modelSupportsThinking(modelInfo, cfg, apiFormat)) return;
  const style = thinkingParamStyleFor(cfg.provider, apiFormat);
  const lvl = cfg.thinkingLevel || 'medium';
  if (style === 'reasoning_effort') {
    body.reasoning_effort = lvl === 'max' ? 'high' : lvl;
  } else if (style === 'thinking_toggle') {
    if (modelInfo.alwaysThinking) {
      // GLM-5.3 / Kimi K3 系列：思考常开，传 disabled 会被接口直接拒绝。
      // 改为只发 reasoning_effort（官方支持 low / high / max），档位映射：
      // 低→low，中/高→high，最高→max。
      body.thinking = { type: 'enabled' };
      body.reasoning_effort = lvl === 'low' ? 'low' : (lvl === 'max' ? 'max' : 'high');
    } else {
      body.thinking = lvl === 'low' ? { type: 'disabled' } : { type: 'enabled' };
    }
  }
}

/** 请求体里实际使用的最大输出 token（桌面版 computeMaxTokens 同规则）。 */
function resolveMaxTokens (cfg, inputTokens, maxTokens) {
  if (maxTokens) return Math.floor(maxTokens);
  const ctxLimit = getContextLimit(cfg);
  const maxOut = getModelMaxOutput(cfg);
  let computed = Math.min(ctxLimit - (inputTokens || 0) - 512, maxOut);
  if (!isFinite(computed) || computed < 1024) computed = 1024;
  return Math.floor(computed);
}

/** CLI 内部消息 → OpenAI 兼容请求消息（补回 reasoning_content）。 */
function toOpenAIMessages (messages) {
  return (messages || []).map(m => {
    if (m.role === 'tool') return { role: 'tool', tool_call_id: m.tool_call_id, content: m.content };
    if (m.role === 'assistant') {
      const out = { role: 'assistant', content: m.content == null ? '' : m.content };
      if (m.tool_calls && m.tool_calls.length) out.tool_calls = m.tool_calls;
      if (m.reasoning) out.reasoning_content = m.reasoning;
      return out;
    }
    return { role: m.role, content: m.content };
  });
}

/** 把 CLI 内部消息数组转换为各 API 格式的请求体。 */
function buildRequestBody (apiFormat, cfg, endpointModel, messages, tools, stream, maxTokens) {
  const tokenCap = resolveMaxTokens(cfg, 0, maxTokens);

  if (apiFormat === 'anthropic') {
    const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
    const convo = [];
    // Anthropic 要求 user/assistant 交替，且工具结果必须放在 user 消息里：
    // 同一角色的相邻消息合并成一条，避免出现连续两条 user/assistant
    const pushMessage = (role, blocks) => {
      if (!blocks.length) return;
      const last = convo[convo.length - 1];
      if (last && last.role === role) last.content = last.content.concat(blocks);
      else convo.push({ role, content: blocks });
    };
    for (const m of messages) {
      if (m.role === 'system') continue;
      if (m.role === 'user') { pushMessage('user', [{ type: 'text', text: m.content == null ? '' : String(m.content) }]); continue; }
      if (m.role === 'assistant') {
        const blocks = [];
        if (m.content) blocks.push({ type: 'text', text: m.content });
        for (const tc of (m.tool_calls || [])) {
          let input = {};
          try { input = JSON.parse(tc.function.arguments || '{}'); } catch (e) {
            try { input = JSON.parse(lenientFixJson(tc.function.arguments || '{}')); } catch (e2) { input = {}; }
          }
          blocks.push({ type: 'tool_use', id: tc.id || ('toolu_' + Math.random().toString(36).slice(2, 12)), name: tc.function.name || 'unknown', input });
        }
        pushMessage('assistant', blocks);
        continue;
      }
      if (m.role === 'tool') {
        pushMessage('user', [{ type: 'tool_result', tool_use_id: m.tool_call_id || '', content: m.content }]);
      }
    }
    // Anthropic 要求消息以 user 开头
    if (convo.length && convo[0].role !== 'user') {
      convo.unshift({ role: 'user', content: [{ type: 'text', text: 'Continue.' }] });
    }
    const body = {
      model: endpointModel,
      max_tokens: tokenCap,
      stream: !!stream,
      messages: convo
    };
    if (system) body.system = system;
    if (tools && tools.length) {
      body.tools = tools.map(t => ({
        name: t.function.name,
        description: t.function.description,
        input_schema: t.function.parameters
      }));
    }
    return body;
  }

  if (apiFormat === 'ollama') {
    const body = {
      model: endpointModel,
      stream: !!stream,
      options: { num_predict: tokenCap },
      messages: messages.map(m => {
        if (m.role === 'tool') {
          return { role: 'tool', content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) };
        }
        if (m.role === 'assistant') {
          const out = { role: 'assistant', content: typeof m.content === 'string' ? m.content : '' };
          if (m.tool_calls) {
            out.tool_calls = m.tool_calls.map(tc => {
              let args = {};
              try { args = JSON.parse(tc.function.arguments || '{}'); } catch (e) { args = {}; }
              return { function: { name: tc.function.name, arguments: args } };
            });
          }
          return out;
        }
        return { role: m.role, content: typeof m.content === 'string' ? m.content : String(m.content == null ? '' : m.content) };
      })
    };
    if (tools && tools.length) {
      body.tools = tools.map(t => ({
        type: 'function',
        function: { name: t.function.name, description: t.function.description, parameters: t.function.parameters }
      }));
    }
    return body;
  }

  // openai（含绝大多数兼容网关）
  const body = {
    model: endpointModel,
    messages: toOpenAIMessages(messages),
    stream: !!stream,
    // 让服务端在流末尾附一个 usage 分片，用量统计才有真实数字而非本地估算
    stream_options: { include_usage: true },
    max_tokens: tokenCap
  };
  if (tools && tools.length) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }
  applyThinkingParams(body, cfg, apiFormat, getModelInfo(cfg));
  return body;
}

function buildHeaders (apiFormat, cfg) {
  if (apiFormat === 'anthropic') {
    return {
      'Content-Type': 'application/json',
      'x-api-key': cfg.apiKey || '',
      'anthropic-version': '2023-06-01'
    };
  }
  if (apiFormat === 'ollama') {
    // 本地默认无鉴权；填了 Key（反向代理场景）时带上 Bearer
    return cfg.apiKey
      ? { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.apiKey }
      : { 'Content-Type': 'application/json' };
  }
  return {
    'Content-Type': 'application/json',
    Authorization: 'Bearer ' + (cfg.apiKey || '')
  };
}

/**
 * 发起流式请求并以统一事件回调输出。
 * @param {object} opts {endpoint, headers, body, apiFormat, signal}
 * @param {object} handlers {onText, onReasoning, onToolCallDelta, onFinish(reason), onError}
 *   onToolCallDelta({index, id?, nameDelta?, argsDelta?, argsObj?})
 * finishReason 取值：'stop' | 'tool_calls' | 'max_tokens' | ...
 */
async function streamChat (opts, handlers) {
  const { endpoint, headers, body } = opts;
  let resp;
  try {
    resp = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: opts.signal
    });
  } catch (err) {
    // AbortError 原样上抛给调用方判断"用户主动中断"
    handlers.onError(err && err.name === 'AbortError' ? err : new Error('网络请求失败: ' + err.message + '（端点 ' + endpoint + '）'));
    return;
  }
  if (!resp.ok) {
    let detail = '';
    try {
      const j = await resp.json();
      detail = j.error && j.error.message ? j.error.message : JSON.stringify(j).slice(0, 300);
    } catch (e) { detail = ''; }
    const err = new Error('HTTP ' + resp.status + (detail ? ': ' + detail : ''));
    // 供调用方判断是否值得自动重试：4xx 明确拒绝不重试，408/429/5xx 可重试
    err.status = resp.status;
    err.noRetry = resp.status >= 400 && resp.status < 500 && resp.status !== 408 && resp.status !== 429;
    handlers.onError(err);
    return;
  }

  const apiFormat = opts.apiFormat || 'openai';
  let finishReason = '';

  try {
    if (apiFormat === 'anthropic') {
      // SSE 事件流
      await consumeSse(resp, evt => {
        let j;
        try { j = JSON.parse(evt); } catch (e) { return; }
        if (j.type === 'content_block_delta') {
          const d = j.delta || {};
          if (d.type === 'text_delta' && d.text) handlers.onText(d.text);
          if (d.type === 'thinking_delta' && d.thinking) handlers.onReasoning(d.thinking);
          if (d.type === 'input_json_delta' && d.partial_json) handlers.onToolCallDelta({ index: j.index, argsDelta: d.partial_json });
        } else if (j.type === 'content_block_start') {
          const cb = j.content_block || {};
          if (cb.type === 'tool_use') handlers.onToolCallDelta({ index: j.index, id: cb.id, nameDelta: cb.name });
        } else if (j.type === 'message_delta') {
          if (j.delta && j.delta.stop_reason) {
            finishReason = j.delta.stop_reason === 'tool_use' ? 'tool_calls' : j.delta.stop_reason;
          }
        } else if (j.type === 'error') {
          handlers.onError(new Error('Anthropic 流错误: ' + JSON.stringify(j.error || j).slice(0, 300)));
        }
      });
      handlers.onFinish(finishReason || 'stop');
      return;
    }

    // openai SSE 与 ollama NDJSON 都按行消费
    await consumeLines(resp, line => {
      if (apiFormat === 'ollama') {
        let j;
        try { j = JSON.parse(line); } catch (e) { return; }
        if (j.error) { handlers.onError(new Error('Ollama: ' + j.error)); return; }
        const msg = j.message || {};
        if (msg.thinking) handlers.onReasoning(msg.thinking);
        if (msg.content) handlers.onText(msg.content);
        if (msg.tool_calls) {
          msg.tool_calls.forEach((tc, i) => {
            handlers.onToolCallDelta({
              index: i,
              id: 'call_' + Math.random().toString(36).slice(2, 10),
              nameDelta: tc.function && tc.function.name,
              argsObj: tc.function && tc.function.arguments
            });
          });
        }
        if (j.done) {
          finishReason = j.done_reason === 'tool_calls' || j.done_reason === 'stop' ? (j.done_reason === 'tool_calls' ? 'tool_calls' : 'stop') : 'stop';
          if (msg.tool_calls && msg.tool_calls.length) finishReason = 'tool_calls';
        }
        return;
      }
      // openai: "data: {...}"
      if (!line.startsWith('data: ')) return;
      const d = line.slice(6).trim();
      if (d === '[DONE]') return;
      let j;
      try { j = JSON.parse(d); } catch (e) { return; }
      const choice = j.choices && j.choices[0];
      if (!choice) return;
      const delta = choice.delta || {};
      if (delta.reasoning_content) handlers.onReasoning(delta.reasoning_content);
      if (delta.reasoning) handlers.onReasoning(delta.reasoning);
      if (delta.content) handlers.onText(delta.content);
      if (delta.tool_calls) {
        delta.tool_calls.forEach(tc => {
          handlers.onToolCallDelta({
            index: typeof tc.index === 'number' ? tc.index : 0,
            id: tc.id || undefined,
            nameDelta: tc.function && tc.function.name || undefined,
            argsDelta: tc.function && tc.function.arguments || undefined
          });
        });
      }
      if (choice.finish_reason) finishReason = choice.finish_reason;
    });
    handlers.onFinish(finishReason || 'stop');
  } catch (err) {
    // 流在读取途中断开（含主动 abort）：统一交给 onError，由对话循环决定重试/结束
    handlers.onError(err);
  }
}

async function consumeSse (resp, onEvent) {
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split('\n');
    buf = parts.pop() || '';
    for (const l of parts) {
      const t = l.trim();
      if (t.startsWith('data:')) onEvent(t.slice(5).trim());
    }
  }
}

async function consumeLines (resp, onLine) {
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split('\n');
    buf = parts.pop() || '';
    for (const l of parts) {
      const t = l.trim();
      if (t) onLine(t);
    }
  }
  if (buf.trim()) onLine(buf.trim());
}

module.exports = {
  streamChat,
  buildRequestBody,
  buildHeaders,
  resolveMaxTokens,
  applyThinkingParams,
  lenientFixJson
};
