/**
 * 内置 Mock 模型 — 无需网络与 API Key 即可端到端演示 NeoWarpAI CLI 的
 * 完整工具循环（对话 → tool_calls → 执行 → 结果回传 → 总结）。
 *
 * 通过对话脚本驱动：脚本是一个 JSON 文件（--mock-script），steps 逐轮回放，
 * 每轮可携带 assistant 文本与任意多个工具调用。轮次用尽后回复固定结束语。
 * 与真实模型相同的接口（buildRequestBody 产出的 openai 格式消息直接可用）。
 */
'use strict';

const fs = require('fs');

function createMockStream (scriptPath) {
  // loud fail：脚本缺失或损坏必须在启动前报错退出，而不是静默降级成
  // "脚本已播放完毕"——那会让使用者以为 demo 跑了，实际什么都没做。
  if (!scriptPath || !fs.existsSync(scriptPath)) {
    const e = new Error('Mock 脚本文件不存在: ' + scriptPath + '（--mock-script 路径有误或文件被移动）');
    e.expected = true; // 预期错误：CLI 只展示 message，不展示堆栈
    throw e;
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(scriptPath, 'utf8'));
  } catch (err) {
    const e = new Error('Mock 脚本不是有效 JSON: ' + scriptPath + '\n  ' + (err.message || String(err)));
    e.expected = true;
    throw e;
  }
  let steps = Array.isArray(raw) ? raw : (raw.steps || []);
  if (!steps.length) {
    process.stderr.write('[警告] Mock 脚本没有任何 steps，对话将只收到固定结束语\n');
  }
  let cursor = 0;

  return async function mockStream (opts, handlers) {
    const messages = opts.messages || [];
    const lastUser = [].concat(messages).reverse().find(m => m.role === 'user');
    const step = cursor < steps.length ? steps[cursor] : null;
    cursor++;

    // 模拟网络与首 token 延迟
    await new Promise(r => setTimeout(r, 120));

    if (!step) {
      handlers.onText('（Mock 脚本已播放完毕。配置真实模型请运行 `neowarp-ai models add`。）');
      handlers.onFinish('stop');
      return;
    }

    if (step.reasoning) handlers.onReasoning(step.reasoning);
    if (step.say) {
      // 逐字输出，模拟流式
      for (const ch of step.say) {
        handlers.onText(ch);
        if (/\s/.test(ch)) await new Promise(r => setTimeout(r, 4));
      }
    }
    const calls = step.tool_calls || [];
    calls.forEach((tc, i) => {
      handlers.onToolCallDelta({
        index: i,
        id: 'mock_call_' + cursor + '_' + i,
        nameDelta: tc.name,
        argsObj: tc.arguments || {}
      });
    });
    handlers.onFinish(calls.length ? 'tool_calls' : 'stop');
    void lastUser;
  };
}

module.exports = { createMockStream };
