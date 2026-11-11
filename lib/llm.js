/**
 * NeoWarpAI CLI — 模型调用层。
 *
 * 三种 API 格式的流式实现，语义与桌面版 ai-assistant.js 的
 * runConversationLoop 对齐：
 *  - openai:   POST {endpoint}（Bearer 鉴权），SSE `data:` 行，
 *              delta.reasoning_content 思维链、delta.tool_calls 按 index 增量拼接
 *  - anthropic: POST /v1/messages（x-api-key），SSE 事件流，
 *              content_block_delta.text_delta / input_json_delta
 *  - ollama:   POST /api/chat（无鉴权头），NDJSON 行流，message.tool_calls
 *  - mock:     内置演示模型（见 lib/mock-model.js），无网络即可验证全链路
 *
 * 同时移植 lenientFixJsonStrings：把模型输出的 JSON 字符串值里裸换行/制表符
 * 转成 \n \t —— 很多模型在 script 参数里写真实换行而不是 \n 转义。
 */
'use strict';

const { lenientFixJson } = require('./json-fix');

/** 把 CLI 内部消息数组转换为各 API 格式的请求体。 */
function buildRequestBody (apiFormat, cfg, endpointModel, messages, tools, stream) {
  if (apiFormat === 'anthropic') {
    const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
    const convo = [];
    for (const m of messages) {
      if (m.role === 'system') continue;
      if (m.role === 'user') { convo.push({ role: 'user', content: m.content }); continue; }
      if (m.role === 'assistant') {
        const blocks = [];
        if (m.content) blocks.push({ type: 'text', text: m.content });
        for (const tc of (m.tool_calls || [])) {
          let input = {};
          try { input = JSON.parse(tc.function.arguments || '{}'); } catch (e) {
            try { input = JSON.parse(lenientFixJson(tc.function.arguments || '{}')); } catch (e2) { input = {}; }
          }
          blocks.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
        }
        convo.push({ role: 'assistant', content: blocks.length ? blocks : [{ type: 'text', text: '' }] });
        continue;
      }
      if (m.role === 'tool') {
        // Anthropic 的工具结果是一条 user 消息里的 tool_result 块；相邻合并
        const last = convo[convo.length - 1];
        const block = { type: 'tool_result', tool_use_id: m.tool_call_id, content: m.content };
        if (last && last.role === 'user' && Array.isArray(last.content) && last.content[0] && last.content[0].type === 'tool_result') {
          last.content.push(block);
        } else {
          convo.push({ role: 'user', content: [block] });
        }
      }
    }
    const body = {
      model: endpointModel,
      max_tokens: 8192,
      stream: !!stream,
      tools: tools.map(t => ({
        name: t.function.name,
        description: t.function.description,
        input_schema: t.function.parameters
      }))
    };
    if (system) body.system = system;
    if (cfg.thinkingLevel === 'high') body.thinking = { type: 'enabled', budget_tokens: 4096 };
    body.messages = convo;
    return body;
  }

  if (apiFormat === 'ollama') {
    const body = {
      model: endpointModel,
      stream: !!stream,
      tools: tools.map(t => ({
        type: 'function',
        function: { name: t.function.name, description: t.function.description, parameters: t.function.parameters }
      })),
      messages: messages.map(m => {
        if (m.role === 'tool') {
          return { role: 'tool', content: m.content };
        }
        const out = { role: m.role, content: m.content || '' };
        if (m.tool_calls) {
          out.tool_calls = m.tool_calls.map(tc => {
            let args = {};
            try { args = JSON.parse(tc.function.arguments || '{}'); } catch (e) { args = {}; }
            return { function: { name: tc.function.name, arguments: args } };
          });
        }
        return out;
      })
    };
    return body;
  }

  // openai（含绝大多数兼容网关）
  const body = {
    model: endpointModel,
    messages,
    stream: !!stream,
    tools
  };
  if (cfg.thinkingLevel === 'high' && /deepseek|kimi|openai/.test(cfg.provider)) {
    if (cfg.provider === 'openai' || cfg.provider === 'kimi') body.reasoning_effort = 'high';
    else body.thinking = true;
  }
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
    return { 'Content-Type': 'application/json' };
  }
  return {
    'Content-Type': 'application/json',
    Authorization: 'Bearer ' + (cfg.apiKey || '')
  };
}

/**
 * 发起流式请求并以统一事件回调输出。
 * @param {object} opts {endpoint, headers, body, signal}
 * @param {object} handlers {onText, onReasoning, onToolCallDelta, onFinish(reason), onError}
 *   onToolCallDelta({index, id?, nameDelta?, argsDelta?})
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
    handlers.onError(new Error('网络请求失败: ' + err.message + '（端点 ' + endpoint + '）'));
    return;
  }
  if (!resp.ok) {
    let detail = '';
    try {
      const j = await resp.json();
      detail = j.error && j.error.message ? j.error.message : JSON.stringify(j).slice(0, 300);
    } catch (e) { detail = ''; }
    handlers.onError(new Error('HTTP ' + resp.status + (detail ? ': ' + detail : '')));
    return;
  }

  const apiFormat = opts.apiFormat || 'openai';
  let finishReason = '';

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

module.exports = { streamChat, buildRequestBody, buildHeaders, lenientFixJson };
