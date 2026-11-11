/**
 * NeoWarpAI CLI — 模型配置管理。
 *
 * 配置对象形状与桌面版统一存储（src-main/ai-model-configs.js → tw_config.json）
 * 完全一致：{id, name, provider, model, apiKey, apiFormat, customEndpoint,
 * customModelId, customContextLimit, thinkingLevel}。
 * 因此桌面版导出的配置列表可以直接导入，CLI 的配置也可以粘回桌面版。
 *
 * CLI 配置文件默认位于 ~/.neowarp-ai-cli/config.json，
 * 可用环境变量 NEOWARP_CLI_CONFIG 覆盖。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { PROVIDERS, normalizeCustomEndpoint } = require('./providers');

const CONFIG_FIELDS = [
  'id', 'name', 'provider', 'model', 'apiKey', 'apiFormat',
  'customEndpoint', 'customModelId', 'customContextLimit', 'thinkingLevel'
];

function configDir () {
  return process.env.NEOWARP_CLI_CONFIG
    ? path.dirname(path.resolve(process.env.NEOWARP_CLI_CONFIG))
    : path.join(os.homedir(), '.neowarp-ai-cli');
}

function configPath () {
  return process.env.NEOWARP_CLI_CONFIG
    ? path.resolve(process.env.NEOWARP_CLI_CONFIG)
    : path.join(configDir(), 'config.json');
}

/** 与桌面版 normalizeConfig 同一规范化规则。 */
function normalizeConfig (raw, index) {
  if (!raw || typeof raw !== 'object') return null;
  const cfg = {};
  for (const key of CONFIG_FIELDS) {
    if (raw[key] !== undefined && raw[key] !== null) cfg[key] = raw[key];
  }
  if (typeof cfg.id !== 'string' || !cfg.id) cfg.id = 'cfg_' + Date.now() + '_' + (index || 0);
  if (typeof cfg.provider !== 'string' || !cfg.provider) cfg.provider = 'openai';
  if (typeof cfg.name !== 'string') cfg.name = '';
  if (typeof cfg.model !== 'string') cfg.model = '';
  if (typeof cfg.apiKey !== 'string') cfg.apiKey = '';
  if (cfg.apiFormat !== 'anthropic' && cfg.apiFormat !== 'ollama' && cfg.apiFormat !== 'mock' && cfg.apiFormat !== 'custom') {
    cfg.apiFormat = 'openai';
  }
  if (typeof cfg.customEndpoint !== 'string') cfg.customEndpoint = '';
  cfg.customEndpoint = normalizeCustomEndpoint(cfg.customEndpoint);
  if (typeof cfg.customModelId !== 'string') cfg.customModelId = '';
  const ctx = Number(cfg.customContextLimit);
  cfg.customContextLimit = Number.isFinite(ctx) && ctx >= 1000 ? Math.floor(ctx) : 1000000;
  if (typeof cfg.thinkingLevel !== 'string' || !cfg.thinkingLevel) cfg.thinkingLevel = 'medium';
  return cfg;
}

function loadStore () {
  try {
    const raw = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    return {
      configs: Array.isArray(raw.aiModelConfigs) ? raw.aiModelConfigs.map(normalizeConfig).filter(Boolean) : [],
      activeId: typeof raw.activeAiModelConfigId === 'string' ? raw.activeAiModelConfigId : null
    };
  } catch (e) {
    return { configs: [], activeId: null };
  }
}

function saveStore (configs, activeId) {
  const normalized = (Array.isArray(configs) ? configs : []).map(normalizeConfig).filter(Boolean);
  const dir = configDir();
  fs.mkdirSync(dir, { recursive: true });
  // 原子写：先写临时文件再 rename，进程被杀不会留下半个配置文件
  const tmp = path.join(dir, '.config.json.tmp');
  fs.writeFileSync(tmp, JSON.stringify({
    aiModelConfigs: normalized,
    activeAiModelConfigId: activeId
  }, null, 2));
  fs.renameSync(tmp, configPath());
  return normalized;
}

/** 读取全部配置；未配置任何项时注入一条 mock 配置，保证开箱即用。 */
function getModelConfigs () {
  const store = loadStore();
  if (!store.configs.length) {
    const mock = normalizeConfig({
      id: 'cfg_mock_builtin',
      name: 'Mock（内置演示）',
      provider: 'mock',
      model: 'mock-1',
      apiKey: '',
      apiFormat: 'mock',
      thinkingLevel: 'medium'
    }, 0);
    saveStore([mock], mock.id);
    return { configs: [mock], activeId: mock.id };
  }
  let activeId = store.activeId;
  if (!activeId || !store.configs.some(c => c.id === activeId)) {
    activeId = store.configs[0].id;
  }
  return { configs: store.configs, activeId };
}

function getActiveConfig () {
  const { configs, activeId } = getModelConfigs();
  return configs.find(c => c.id === activeId) || null;
}

/** 解析一次请求真正生效的端点与请求体模型 id。 */
function resolveEndpointAndModel (cfg) {
  const provider = PROVIDERS[cfg.provider] || PROVIDERS.custom;
  const endpoint = provider.isCustom
    ? normalizeCustomEndpoint(cfg.customEndpoint || provider.endpoint)
    : (cfg.customEndpoint ? normalizeCustomEndpoint(cfg.customEndpoint) : provider.endpoint);
  const model = provider.isCustom
    ? (cfg.customModelId || cfg.model || 'custom')
    : (cfg.model || provider.defaultModel);
  return { endpoint, model, apiFormat: cfg.apiFormat || provider.apiFormat || 'openai' };
}

/** 导入桌面版 tw_config.json 的 aiModelConfigs 数组。 */
function importConfigs (list, activeId) {
  const existing = loadStore();
  const merged = existing.configs.slice();
  let added = 0;
  for (const raw of (Array.isArray(list) ? list : [])) {
    const cfg = normalizeConfig(raw, merged.length);
    if (!cfg) continue;
    const idx = merged.findIndex(m => m.id === cfg.id);
    if (idx >= 0) merged[idx] = cfg; else { merged.push(cfg); added++; }
  }
  const saved = saveStore(merged, activeId || existing.activeId);
  return { added, total: saved.length };
}

/** 打印时隐藏 apiKey 中间部分。 */
function maskKey (k) {
  if (!k) return '(未设置)';
  if (k.length <= 10) return k.slice(0, 2) + '****';
  return k.slice(0, 6) + '****' + k.slice(-4);
}

module.exports = {
  configPath,
  getModelConfigs,
  getActiveConfig,
  saveStore,
  resolveEndpointAndModel,
  importConfigs,
  maskKey,
  normalizeConfig
};
