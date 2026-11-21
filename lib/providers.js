/**
 * NeoWarpAI CLI — 供应商预设表。
 * 与桌面版 ai-assistant.html 内联脚本的 PROVIDERS 保持一致（模型信息更新于
 * 2026-10），并补充主进程 ai-model-configs.js 支持的 anthropic / ollama 两种
 * API 格式与 CLI 内置的 mock 演示模型。
 */
'use strict';

const PROVIDERS = {
  openai: {
    name: 'OpenAI',
    endpoint: 'https://api.openai.com/v1/chat/completions',
    apiFormat: 'openai',
    supportsVision: true,
    defaultContextLimit: 1000000,
    // GPT-6.x/5.5/5.4 为 1.05M 上下文 / 128K 输出，5.4-mini/nano 与
    // 5.3-codex 为 400K / 128K。早期无后缀的 gpt-5.6 已拆分为
    // sol/terra/luna 变体，按官方 ID 收录。
    models: [
      { id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', supportsReasoning: true, contextLimit: 1050000, maxOutput: 131072 },
      { id: 'gpt-6-sol', name: 'GPT-6 Sol', supportsReasoning: true, contextLimit: 1050000, maxOutput: 131072 },
      { id: 'gpt-6-luna', name: 'GPT-6 Luna', supportsReasoning: true, contextLimit: 1050000, maxOutput: 131072 },
      { id: 'gpt-6-astra', name: 'GPT-6 Astra', supportsReasoning: true, contextLimit: 1050000, maxOutput: 131072 },
      { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', supportsReasoning: true, contextLimit: 1050000, maxOutput: 131072 },
      { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra', supportsReasoning: true, contextLimit: 1050000, maxOutput: 131072 },
      { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', supportsReasoning: true, contextLimit: 1050000, maxOutput: 131072 },
      { id: 'gpt-5.5', name: 'GPT-5.5', supportsReasoning: true, contextLimit: 1050000, maxOutput: 131072 },
      { id: 'gpt-5.4', name: 'GPT-5.4', supportsReasoning: true, contextLimit: 1050000, maxOutput: 131072 },
      { id: 'gpt-5.4-mini', name: 'GPT-5.4 Mini', supportsReasoning: true, contextLimit: 400000, maxOutput: 131072 },
      { id: 'gpt-5.4-nano', name: 'GPT-5.4 Nano', supportsReasoning: true, contextLimit: 400000, maxOutput: 131072 },
      { id: 'gpt-5.3-codex', name: 'GPT-5.3 Codex', supportsReasoning: true, contextLimit: 400000, maxOutput: 131072 }
    ],
    defaultModel: 'gpt-6.1-sol'
  },
  deepseek: {
    name: 'DeepSeek',
    endpoint: 'https://api.deepseek.com/chat/completions',
    apiFormat: 'openai',
    supportsVision: true,
    defaultContextLimit: 1000000,
    // 官方在售两个型号：deepseek-v4-pro 与 deepseek-flash（DeepSeek-V4.1-Flash，
    // 已支持视觉）。旧的 deepseek-v4-flash 已退役，由 deepseek-flash 接管。
    // 两者均 1M 上下文 / 384K 最大输出。
    models: [
      { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', supportsReasoning: true, supportsVision: false, contextLimit: 1000000, maxOutput: 393216 },
      { id: 'deepseek-flash', name: 'DeepSeek Flash', supportsReasoning: true, contextLimit: 1000000, maxOutput: 393216 }
    ],
    defaultModel: 'deepseek-v4-pro'
  },
  glm: {
    name: 'Zhipu GLM',
    endpoint: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    apiFormat: 'openai',
    supportsVision: true,
    defaultContextLimit: 1000000,
    // 5.3 系列均为 1M 上下文 / 128K 输出；GLM-5.3 为纯文本，多模态的是
    // GLM-5.3-Flash / FlashX；GLM-5.2 最大输出由 16K 修正为 128K。
    // alwaysThinking：思考常开，请求里传 disabled 会直接报错。
    models: [
      { id: 'glm-5.3', name: 'GLM-5.3', supportsReasoning: true, supportsVision: false, alwaysThinking: true, contextLimit: 1000000, maxOutput: 131072 },
      { id: 'glm-5.3-flash', name: 'GLM-5.3 Flash', supportsReasoning: true, supportsVision: true, alwaysThinking: true, contextLimit: 1000000, maxOutput: 131072 },
      { id: 'glm-5.3-flashx', name: 'GLM-5.3 FlashX', supportsReasoning: true, supportsVision: true, alwaysThinking: true, contextLimit: 1000000, maxOutput: 131072 },
      { id: 'glm-5.2', name: 'GLM-5.2', supportsReasoning: true, supportsVision: false, contextLimit: 1000000, maxOutput: 131072 }
    ],
    defaultModel: 'glm-5.3'
  },
  kimi: {
    name: 'Kimi (Moonshot)',
    endpoint: 'https://api.moonshot.cn/v1/chat/completions',
    apiFormat: 'openai',
    supportsVision: true,
    defaultContextLimit: 262144,
    models: [
      // K3 始终开启思考模式（无法关闭），max_completion_tokens 默认 131072
      { id: 'kimi-k3', name: 'Kimi K3', supportsReasoning: true, supportsVision: true, alwaysThinking: true, contextLimit: 1000000, maxOutput: 131072 },
      { id: 'kimi-k2.7-code', name: 'Kimi K2.7 Code', supportsReasoning: true, supportsVision: true, contextLimit: 262144, maxOutput: 16384 },
      { id: 'kimi-k2.6', name: 'Kimi K2.6', supportsReasoning: false, contextLimit: 262144, maxOutput: 16384 }
    ],
    defaultModel: 'kimi-k3'
  },
  mimo: {
    name: 'Xiaomi MiMo',
    endpoint: 'https://api.xiaomimimo.com/v1/chat/completions',
    apiFormat: 'openai',
    supportsVision: true,
    defaultContextLimit: 1000000,
    // 2026-09 起 V2.6 系列全面替代 V2.5（官方已停售 V2.5 型号），
    // 全系原生多模态，1M 上下文；UltraSpeed 为 20 倍速高速档。
    models: [
      { id: 'mimo-v2.6-pro', name: 'MiMo V2.6 Pro', supportsReasoning: true, supportsVision: true, contextLimit: 1000000, maxOutput: 131072 },
      { id: 'mimo-v2.6-pro-ultraspeed', name: 'MiMo V2.6 Pro UltraSpeed', supportsReasoning: true, supportsVision: true, contextLimit: 1000000, maxOutput: 131072 },
      { id: 'mimo-v2.6-flash', name: 'MiMo V2.6 Flash', supportsReasoning: true, supportsVision: true, contextLimit: 1000000, maxOutput: 131072 }
    ],
    defaultModel: 'mimo-v2.6-pro'
  },
  huaweipangu: {
    name: 'Huawei Pangu',
    endpoint: 'https://api.huaweicloud.com/api/v2/chat/completions',
    apiFormat: 'openai',
    supportsVision: false,
    defaultContextLimit: 524288,
    models: [
      { id: 'pangu-2.0-pro', name: 'Pangu 2.0 Pro', supportsReasoning: true, contextLimit: 524288, maxOutput: 16384 },
      { id: 'pangu-2.0-flash', name: 'Pangu 2.0 Flash', supportsReasoning: false, contextLimit: 524288, maxOutput: 16384 }
    ],
    defaultModel: 'pangu-2.0-pro'
  },
  qwen: {
    name: 'Qwen (通义千问)',
    endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    apiFormat: 'openai',
    defaultContextLimit: 1000000,
    models: [
      // 百炼推荐列表（1M 上下文）：qwen3.8-max 为最强推理档，
      // qwen3.7-plus 为官方推荐的成本均衡档；qwen3.7-max 已转为旧版。
      { id: 'qwen3.8-max', name: 'Qwen3.8 Max', supportsReasoning: true, contextLimit: 1000000, maxOutput: 65536 },
      { id: 'qwen3.8-flash', name: 'Qwen3.8 Flash', supportsReasoning: true, contextLimit: 1000000, maxOutput: 65536 },
      { id: 'qwen3.7-plus', name: 'Qwen3.7 Plus', supportsReasoning: true, contextLimit: 1000000, maxOutput: 65536 },
      { id: 'qwen3.7-flash', name: 'Qwen3.7 Flash', supportsReasoning: true, contextLimit: 1000000, maxOutput: 65536 }
    ],
    defaultModel: 'qwen3.7-plus'
  },
  // Anthropic 原生协议（/v1/messages）：请求体、鉴权头与流式事件都与
  // OpenAI 不同，见 llm.js 的 apiFormat 分支。
  anthropic: {
    name: 'Anthropic',
    endpoint: 'https://api.anthropic.com/v1/messages',
    apiFormat: 'anthropic',
    supportsVision: true,
    defaultContextLimit: 200000,
    models: [
      { id: 'claude-opus-4-5', name: 'Claude Opus 4.5', supportsReasoning: true, contextLimit: 200000, maxOutput: 64000 },
      { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', supportsReasoning: true, contextLimit: 200000, maxOutput: 64000 },
      { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', supportsReasoning: false, contextLimit: 200000, maxOutput: 32000 }
    ],
    defaultModel: 'claude-sonnet-4-5'
  },
  // Ollama 本地推理（/api/chat）。模型名随用户本地已 pull 的模型变化，
  // 这里只给几个常见默认值；未命中时按 defaultContextLimit 预算历史。
  ollama: {
    name: 'Ollama (local)',
    endpoint: 'http://localhost:11434/api/chat',
    apiFormat: 'ollama',
    supportsVision: false,
    defaultContextLimit: 131072,
    models: [
      { id: 'llama3.3', name: 'Llama 3.3', supportsReasoning: false, contextLimit: 131072, maxOutput: 8192 },
      { id: 'qwen3', name: 'Qwen3', supportsReasoning: true, contextLimit: 131072, maxOutput: 8192 },
      { id: 'deepseek-r1', name: 'DeepSeek R1', supportsReasoning: true, contextLimit: 131072, maxOutput: 8192 },
      { id: 'gemma3', name: 'Gemma 3', supportsReasoning: false, contextLimit: 131072, maxOutput: 8192 }
    ],
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
 * 规范化自定义端点：兼容用户填 base URL（如 https://api.siliconflow.cn/v1）
 * 或完整端点两种习惯。补全的路径由 API 格式决定，三种格式各有一套：
 * - openai / custom：…/chat/completions（只补这一段，绝不补 /v1；不同厂商
 *   路径前缀不同，自动补 /v1 会弄坏 DeepSeek/Groq 这类端点）
 * - anthropic：…/v1/messages
 * - ollama：…/api/chat
 * 已经带对应聊天路径的完整端点原样返回。
 * @param {string} url
 * @param {'openai'|'anthropic'|'ollama'|'custom'} [apiFormat]
 * @returns {string}
 */
function normalizeCustomEndpoint (url, apiFormat) {
  let u = String(url || '').trim();
  if (!u) return u;
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  u = u.replace(/\/+$/, '');
  if (apiFormat === 'anthropic') {
    if (/\/v1\/messages$/i.test(u)) return u;
    if (/\/v1$/i.test(u)) return u + '/messages';
    return u + '/v1/messages';
  }
  if (apiFormat === 'ollama') {
    if (/\/api\/chat$/i.test(u)) return u;
    if (!/\/api$/i.test(u)) u += '/api';
    return u + '/chat';
  }
  if (/\/(v1\/messages|api\/chat)$/i.test(u)) return u;
  if (!/\/chat\/completions$/i.test(u)) u += '/chat/completions';
  return u;
}

/** 当前配置命中的模型元数据（未收录时返回 null）。 */
function getModelInfo (cfg) {
  const p = PROVIDERS[cfg.provider];
  if (!p) return null;
  const modelId = cfg.model || cfg.customModelId;
  return (p.models || []).find(m => m.id === modelId) || null;
}

/** 上下文上限：自定义服务商与未收录模型按服务商默认值预算。 */
function getContextLimit (cfg) {
  const p = PROVIDERS[cfg.provider];
  if (cfg.provider === 'custom') return cfg.customContextLimit || 1000000;
  const modelId = cfg.model || cfg.customModelId;
  const m = p && (p.models || []).find(x => x.id === modelId);
  return (m && m.contextLimit) || (p && p.defaultContextLimit) || 1000000;
}

/** 单次请求的最大输出 token。 */
function getModelMaxOutput (cfg) {
  const p = PROVIDERS[cfg.provider];
  const m = p && (p.models || []).find(x => x.id === cfg.model);
  return (m && m.maxOutput) || 16384;
}

module.exports = {
  PROVIDERS,
  normalizeCustomEndpoint,
  getModelInfo,
  getContextLimit,
  getModelMaxOutput
};
