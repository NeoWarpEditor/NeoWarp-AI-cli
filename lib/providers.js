/**
 * NeoWarpAI CLI — 供应商预设表。
 * 与桌面版 src-renderer/ai-assistant/ai-assistant.js 的 PROVIDERS 保持一致，
 * 并补充主进程 ai-model-configs.js 支持的 anthropic / ollama 两种 API 格式。
 */
'use strict';

const PROVIDERS = {
  openai: {
    name: 'OpenAI',
    endpoint: 'https://api.openai.com/v1/chat/completions',
    apiFormat: 'openai',
    models: [
      { id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', supportsReasoning: true },
      { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', supportsReasoning: true },
      { id: 'gpt-5.5', name: 'GPT-5.5', supportsReasoning: true },
      { id: 'gpt-5.4-mini', name: 'GPT-5.4 Mini', supportsReasoning: true }
    ],
    defaultModel: 'gpt-5.6-sol'
  },
  deepseek: {
    name: 'DeepSeek',
    endpoint: 'https://api.deepseek.com/chat/completions',
    apiFormat: 'openai',
    models: [
      { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', supportsReasoning: true },
      { id: 'deepseek-flash', name: 'DeepSeek Flash', supportsReasoning: true }
    ],
    defaultModel: 'deepseek-v4-pro'
  },
  glm: {
    name: 'Zhipu GLM',
    endpoint: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    apiFormat: 'openai',
    models: [
      { id: 'glm-5.3', name: 'GLM-5.3', supportsReasoning: true },
      { id: 'glm-5.3-flash', name: 'GLM-5.3 Flash', supportsReasoning: true },
      { id: 'glm-5.2', name: 'GLM-5.2', supportsReasoning: true }
    ],
    defaultModel: 'glm-5.3'
  },
  kimi: {
    name: 'Kimi (Moonshot)',
    endpoint: 'https://api.moonshot.cn/v1/chat/completions',
    apiFormat: 'openai',
    models: [
      { id: 'kimi-k3', name: 'Kimi K3', supportsReasoning: true },
      { id: 'kimi-k2.6', name: 'Kimi K2.6', supportsReasoning: false }
    ],
    defaultModel: 'kimi-k3'
  },
  mimo: {
    name: 'Xiaomi MiMo',
    endpoint: 'https://api.xiaomimimo.com/v1/chat/completions',
    apiFormat: 'openai',
    models: [
      { id: 'mimo-v2.6-pro', name: 'MiMo V2.6 Pro', supportsReasoning: true },
      { id: 'mimo-v2.6-flash', name: 'MiMo V2.6 Flash', supportsReasoning: true }
    ],
    defaultModel: 'mimo-v2.6-pro'
  },
  qwen: {
    name: 'Qwen (通义千问)',
    endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    apiFormat: 'openai',
    models: [
      { id: 'qwen3.8-max', name: 'Qwen3.8 Max', supportsReasoning: true },
      { id: 'qwen3.7-plus', name: 'Qwen3.7 Plus', supportsReasoning: true }
    ],
    defaultModel: 'qwen3.7-plus'
  },
  anthropic: {
    name: 'Anthropic',
    endpoint: 'https://api.anthropic.com/v1/messages',
    apiFormat: 'anthropic',
    models: [
      { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', supportsReasoning: true }
    ],
    defaultModel: 'claude-sonnet-4-5'
  },
  ollama: {
    name: 'Ollama (local)',
    endpoint: 'http://localhost:11434/api/chat',
    apiFormat: 'ollama',
    models: [],
    defaultModel: 'qwen3'
  },
  mock: {
    name: 'Mock (内置演示模型，无需网络)',
    endpoint: '',
    apiFormat: 'mock',
    models: [{ id: 'mock-1', name: 'Mock Model', supportsReasoning: false }],
    defaultModel: 'mock-1'
  },
  custom: {
    name: 'Custom',
    endpoint: '',
    apiFormat: 'openai',
    models: [{ id: 'custom', name: 'Custom Model', supportsReasoning: false }],
    defaultModel: 'custom',
    isCustom: true
  }
};

/**
 * 规范化自定义端点 — 与主进程 ai-model-configs.js 的 normalizeCustomEndpoint
 * 同一实现：补协议、去尾斜杠；不以 /chat/completions 结尾时自动补上
 * （绝不自动补 /v1）；Anthropic（/v1/messages）与 Ollama（/api/chat）样式的
 * 完整端点原样返回。
 */
function normalizeCustomEndpoint (url) {
  let u = String(url || '').trim();
  if (!u) return u;
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  u = u.replace(/\/+$/, '');
  if (/\/(v1\/messages|api\/chat)$/i.test(u)) return u;
  if (!/\/chat\/completions$/i.test(u)) u += '/chat/completions';
  return u;
}

module.exports = { PROVIDERS, normalizeCustomEndpoint };
