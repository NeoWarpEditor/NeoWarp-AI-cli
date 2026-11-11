#!/usr/bin/env node
/**
 * NeoWarpAI CLI — NeoWarp AI 编程助手的命令行版。
 *
 * 复用 NeoWarp 桌面版 AI 部分的完整协议：
 *  - 模型配置与 tw_config.json 兼容（lib/config.js ← src-main/ai-model-configs.js）
 *  - OpenAI / Anthropic / Ollama 流式工具循环（lib/llm.js ← ai-assistant.js）
 *  - 积木 DSL 引擎逐行复用（lib/dsl-engine.js ← desktop-hoc.jsx）
 *  - 工具集与执行语义对齐（lib/backend.js ← desktop-hoc.jsx 工具执行器）
 *  - "一键撤销 AI 修改" 快照（lib/store.js）
 *
 * 所有输出使用 ANSI 终端色彩；--no-color 或非 TTY 时自动关闭。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const { PROVIDERS } = require('../lib/providers');
const config = require('../lib/config');
const { loadProject, saveProject, blankProject } = require('../lib/sb3');
const { ProjectStore } = require('../lib/vm-adapter');
const { ToolBackend } = require('../lib/backend');
const { TOOLS } = require('../lib/tools-schema');
const { buildSystemPrompt } = require('../lib/prompt');
const { runConversationLoop } = require('../lib/loop');
const store = require('../lib/store');

// ── 终端 UI 设计系统（Apple Design 风格，见 lib/ui.js）───────
const UI = require('../lib/ui');
const { NO_COLOR } = UI;
const gray = UI.paint.secondary;
const yellow = UI.paint.orange;
const green = UI.paint.green;
const red = UI.paint.red;
const cyan = UI.paint.blue;
const bold = UI.paint.bold;

function colorEnabled () { return !NO_COLOR; }

function banner () {
  console.log(UI.banner(require('../package.json').version));
  console.log('');
  console.log(UI.divider());
  console.log('');
  console.log(gray('输入 /help 查看会话内命令，/exit 退出'));
}

function usage () {
  const cmd = UI.paint.blue;
  console.log(`用法: ${UI.paint.bold('neowarp-ai')} <命令> [参数]

${UI.paint.bold('对话')}
  ${cmd('chat')}                        交互式对话（REPL，流式输出 + 工具调用）
      ${gray('--project <file.sb3>')}   加载项目（.sb3/.np1，无则跑在内存新项目上）
      ${gray('--save')}                 每次工具修改后自动保存回项目文件
      ${gray('--model <id>')}           临时使用指定模型配置
      ${gray('--session <id>')}         恢复指定会话
      ${gray('--mock-script <f.json>')} mock 模型对话脚本（无网络演示/测试）
  ${cmd('run')} "任务描述"              单发执行（选项同 chat，跑完即退）

${UI.paint.bold('模型')}
  ${cmd('models')} list                 列出模型配置（兼容桌面版 tw_config.json 格式）
  ${cmd('models')} add                  交互式添加配置
  ${cmd('models')} use <id|序号>        切换激活配置
  ${cmd('models')} remove <id|序号>     删除配置
  ${cmd('models')} key <id|序号> <key>  设置 API Key
  ${cmd('models')} test [id|序号]       连通性测试
  ${cmd('models')} import <tw_config.json>  导入桌面版配置

${UI.paint.bold('项目')}
  ${cmd('project')} new <file.sb3>      新建空白项目
  ${cmd('project')} info [--project f]  查看项目概况
  ${cmd('project')} scripts <角色>      查看角色脚本（DSL）
  ${cmd('project')} undo [--project f]  回滚到最近一次 AI 修改前快照
  ${cmd('project')} snapshots [--project f]  列出快照

${UI.paint.bold('工具')}
  ${cmd('dsl')} roundtrip               DSL 引擎往返自检
  ${cmd('help')}                        显示本帮助`);
}

// ── 项目上下文 ───────────────────────────────────────────────

function loadProjectContext (opts) {
  if (opts.project && fs.existsSync(opts.project)) {
    const { project, assets, sourcePath } = loadProject(opts.project);
    return new ProjectStore(project, assets, sourcePath);
  }
  const p = blankProject('未命名项目');
  return new ProjectStore(p, [], opts.project || null);
}

/** 项目摘要（对齐桌面版 buildSystemPrompt 的 compressed 逻辑）。 */
function projectSummary (storeObj) {
  if (!storeObj) return '';
  const p = storeObj.flush();
  const sprites = storeObj.listSpriteAdapters();
  const stage = storeObj.stageAdapter;
  const lines = ['## 当前项目（CLI 内存态，写之前先用工具读细节）'];
  lines.push('Project name: ' + (p.name || '未命名') + '；文件: ' + (storeObj.sourcePath || '（未保存，内存项目）'));
  lines.push('Sprites: ' + sprites.length);
  for (const s of sprites) {
    const blockCount = Object.keys(s.blocks._blocks).length;
    const varNames = Object.keys(s.variables).filter(id => !s.variables[id].type).map(id => s.variables[id].name);
    const listNames = Object.keys(s.variables).filter(id => s.variables[id].type === 'list').map(id => s.variables[id].name);
    let line = '- "' + s.getName() + '" pos(' + (s.__data.x || 0) + ',' + (s.__data.y || 0) + ') blocks:' + blockCount +
      ' scripts:' + Object.keys(s.blocks._blocks).filter(id => s.blocks._blocks[id].topLevel && s.blocks._blocks[id].parent === null).length;
    if (varNames.length) line += ' vars:[' + varNames.join(', ') + ']';
    if (listNames.length) line += ' lists:[' + listNames.join(', ') + ']';
    lines.push(line);
  }
  lines.push('Stage backdrops: [' + stage.getCostumes().map(x => x.name).join(', ') + ']');
  lines.push('');
  lines.push('修改既有脚本前先 get_sprite_scripts 获取 tid。');
  return lines.join('\n');
}

// ── 修改后处理（快照 + 自动保存）───────────────────────────

/** 修改追踪器：首次修改前快照、每次修改落盘。提示统一走 renderer.note 协调。 */
function makeModifyWatcher (storeObj, opts, state, note) {
  return {
    beforeFirstModify () {
      if (state.snapshotted) return;
      state.snapshotted = true;
      if (storeObj.sourcePath && fs.existsSync(storeObj.sourcePath)) {
        try {
          const snap = store.takeSnapshot(storeObj.sourcePath, 'pre-ai');
          note('已保存快照 ' + path.basename(snap) + '（project undo 可回滚）');
        } catch (e) { /* 快照失败不阻塞 */ }
      }
    },
    afterModify () {
      if (opts.save && storeObj.sourcePath) {
        try {
          saveProject(storeObj.flush(), storeObj.assets, storeObj.sourcePath);
          state.savedThisCall = (state.savedThisCall || 0) + 1;
        } catch (e) {
          note('保存失败: ' + e.message, true);
        }
      }
    }
  };
}

function wrapBackendWithWatcher (backend, watcher) {
  const modifyTools = new Set([
    'add_script', 'set_scripts', 'insert_blocks', 'delete_block', 'modify_input',
    'execute_operations', 'add_comment', 'delete_comment', 'add_sprite', 'delete_sprite',
    'rename_sprite', 'duplicate_sprite', 'set_sprite_property', 'change_costume',
    'change_backdrop', 'add_backdrop', 'set_stage_size', 'rename_project',
    'create_variable', 'set_variable', 'delete_variable', 'rename_variable',
    'create_list', 'add_to_list', 'insert_to_list', 'set_list_item', 'delete_from_list',
    'clear_list', 'install_extension', 'delete_extension'
  ]);
  const orig = backend.execute.bind(backend);
  backend.execute = async (name, args) => {
    const modifies = modifyTools.has(name);
    if (modifies) watcher.beforeFirstModify();
    const r = await orig(name, args);
    if (modifies && r && r.success) watcher.afterModify();
    return r;
  };
  return backend;
}

// ── 终端渲染器 ───────────────────────────────────────────────

/**
 * 流式渲染器（行式模型）。
 * 工具行在 onToolStart 即闭合换行，结果/提示行独立输出 —— 并行多工具
 * （Promise.all 交错回调）也不会错位。state.savedThisCall 由 watcher 每次
 * 成功落盘后自增，onToolEnd 时据此在结果行追加"已保存"标记，避免刷屏。
 */
function createRenderer (state) {
  let inReasoning = false;
  let spin = null;          // 等待模型响应的 spinner
  let toolStartedAt = 0;
  let lastToolName = '';    // 最近一次 onToolStart 的工具名（并行归属判断）
  let lastWasTool = false;  // 连续工具行之间不加空行

  const stopSpin = () => {
    if (spin) { spin.stop(); spin = null; }
  };

  return {
    onRoundStart (n) {
      stopSpin();
      if (inReasoning) { process.stdout.write('\n'); inReasoning = false; }
      if (n > 1) process.stdout.write('\n');
      lastWasTool = false;
      spin = UI.spinner('思考中');
      spin.start();
    },
    onText (t) {
      if (spin) stopSpin();
      if (inReasoning) { process.stdout.write('\n\n'); inReasoning = false; }
      lastWasTool = false;
      process.stdout.write(t);
    },
    onReasoning (t) {
      if (spin) stopSpin();
      if (!inReasoning) {
        process.stdout.write('  ' + UI.paint.tertiary(UI.sym.think + ' 思考\n'));
        inReasoning = true;
        lastWasTool = false;
      }
      process.stdout.write(UI.paint.tertiary(t));
    },
    /** 插入提示行（快照、保存失败等），行式独立输出。 */
    note (text, isError) {
      process.stdout.write('    ' + (isError ? UI.paint.red(UI.sym.fail + ' ' + text) : UI.paint.tertiary(UI.sym.dot + ' ' + text)) + '\n');
    },
    onToolStart (name, args, fixed) {
      stopSpin();
      if (inReasoning) { process.stdout.write('\n\n'); inReasoning = false; }
      toolStartedAt = Date.now();
      lastToolName = name;
      const brief = UI.toolBrief(name, args);
      const note2 = fixed ? ' ' + gray('(JSON 已自动修复)') : '';
      const tail = brief ? ' ' + UI.paint.tertiary(brief) : '';
      // 行式渲染：工具行立即闭合，结果行独立输出 —— 并行多工具不会错位
      process.stdout.write((lastWasTool ? '' : '\n') + '  ' + UI.paint.blue(UI.sym.tool) + ' ' + UI.paint.text(name) + tail + note2 + '\n');
      lastWasTool = true;
    },
    onToolEnd (name, result) {
      const ms = Date.now() - toolStartedAt;
      const savedCount = state ? (state.savedThisCall || 0) : 0;
      if (state) state.savedThisCall = 0;
      const saved = savedCount > 0
        ? ' ' + UI.paint.tertiary(UI.sym.dot + ' 已保存')
        : '';
      const owner = name === lastToolName ? '' : UI.paint.secondary(name) + ' ' + UI.paint.tertiary(UI.sym.dot) + ' ';
      if (result && result.success) {
        process.stdout.write('    ' + UI.paint.green(UI.sym.ok) + ' ' + owner + UI.paint.tertiary(ms + 'ms' + saved) + '\n');
      } else {
        const msg = (result && result.error) ? String(result.error).split('\n')[0].slice(0, 160) : '未知错误';
        process.stdout.write('    ' + UI.paint.red(UI.sym.fail + ' ' + owner + msg) + '\n');
      }
      lastWasTool = true;
    }
  };
}

function askIo () {
  return {
    prompt (question, options) {
      return new Promise(resolve => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        let text = '\n  ' + UI.paint.orange('? ') + question + '\n';
        (options || []).forEach(o => { text += '  ' + UI.paint.secondary(UI.sym.dot) + ' ' + o + '\n'; });
        text += '  ' + UI.paint.blue(UI.sym.prompt) + ' ';
        rl.question(NO_COLOR ? text.replace(/\x1b\[[0-9;]*m/g, '') : text, ans => {
          rl.close();
          const n = Number(ans);
          if (options && Number.isInteger(n) && n >= 1 && n <= options.length) resolve(options[n - 1]);
          else resolve(ans);
        });
      });
    }
  };
}

// ── 会话与执行 ───────────────────────────────────────────────

function parseArgs (argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--project') opts.project = argv[++i];
    else if (a === '--save') opts.save = true;
    else if (a === '--model') opts.model = argv[++i];
    else if (a === '--session') opts.session = argv[++i];
    else if (a === '--mock-script') opts.mockScript = argv[++i];
    else if (a === '--json') opts.json = true;
    else opts._.push(a);
  }
  return opts;
}

function resolveCfg (opts) {
  let cfg = config.getActiveConfig();
  if (opts.model) {
    const all = config.getModelConfigs().configs;
    const byIdx = all[Number(opts.model) - 1];
    cfg = all.find(x => x.id === opts.model || x.name === opts.model) || (Number.isInteger(Number(opts.model)) ? byIdx : null);
    if (!cfg) {
      console.error(red('找不到模型配置: ' + opts.model));
      process.exit(1);
    }
  }
  if (!cfg) {
    console.error(red('尚未配置模型。运行 neowarp-ai models add 添加，或 models import 导入桌面版 tw_config.json。'));
    process.exit(1);
  }
  return cfg;
}

async function executeTask (opts, userInput, session) {
  const cfg = resolveCfg(opts);
  const storeObj = session.projectStore || loadProjectContext(opts);
  const state = { snapshotted: false, savedThisCall: 0 };
  const render = createRenderer(state);
  const watcher = makeModifyWatcher(storeObj, opts, state, (text, isError) => render.note(text, isError));
  const backend = wrapBackendWithWatcher(new ToolBackend(storeObj, askIo()), watcher);
  const endpointModel = config.resolveEndpointAndModel(cfg);

  const sys = buildSystemPrompt('Chinese.') + '\n' + projectSummary(storeObj);

  const messages = session.messages && session.messages.length
    ? session.messages
    : [{ role: 'system', content: sys }];
  if (!session.messages || !session.messages.length) {
    messages.push({ role: 'user', content: userInput });
  } else {
    messages.push({ role: 'user', content: userInput });
  }

  const fmt = apiLabel(endpointModel.apiFormat);
  process.stdout.write('\n' + UI.contextLine({
    model: cfg.name + ' ' + UI.sym.dot + ' ' + endpointModel.model,
    format: fmt && !cfg.name.includes(fmt) ? fmt : null,
    project: storeObj.sourcePath ? path.basename(storeObj.sourcePath) : null
  }) + '\n');

  const startedAt = Date.now();
  const out = await runConversationLoop({
    messages, cfg, endpointModel, tools: TOOLS, backend, render, mockScript: opts.mockScript
  });
  const seconds = (Date.now() - startedAt) / 1000;

  process.stdout.write('\n' + UI.summaryLine({ rounds: out.rounds, toolCalls: out.toolCalls, seconds, aborted: out.aborted }) + '\n');
  if (out.error) {
    process.stdout.write('  ' + red(UI.sym.fail + ' ' + out.error.message) + '\n');
  }
  process.stdout.write('\n');
  return { messages, projectStore: storeObj, out };
}

function apiLabel (f) {
  return { openai: 'OpenAI 兼容', anthropic: 'Anthropic', ollama: 'Ollama', mock: 'Mock', custom: '自定义' }[f] || f;
}

// ── REPL ─────────────────────────────────────────────────────

async function cmdChat (opts) {
  banner();
  const session = {
    id: opts.session || ('s_' + Date.now().toString(36)),
    model: null,
    messages: [],
    projectStore: null,
    updated: null
  };
  if (opts.session) {
    const saved = store.loadSession(opts.session);
    if (saved) {
      session.id = saved.id;
      session.messages = saved.messages || [];
      console.log(gray('已恢复会话 ' + session.id + '（' + session.messages.filter(m => m.role === 'user').length + ' 轮）'));
    }
  }
  if (opts.project) {
    session.projectStore = loadProjectContext(opts);
    console.log(gray('项目: ' + (session.projectStore.sourcePath || '（新内存项目）')));
  }

  const PROMPT = '  ' + UI.paint.blue(UI.sym.prompt) + ' ';
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: PROMPT
  });

  const ask = q => new Promise(res => rl.question(q, res));

  for (;;) {
    let line;
    try {
      line = await ask(PROMPT);
    } catch (e) {
      break; // EOF
    }
    const input = String(line || '').trim();
    if (!input) continue;

    if (input === '/exit' || input === '/quit' || input === 'exit') break;
    if (input === '/help') {
      console.log(gray('  /exit 退出 · /clear 清空会话 · /model 切换模型 · /save 立即保存项目 · /undo 回滚快照 · /info 项目概况'));
      continue;
    }
    if (input === '/clear') { session.messages = []; console.log(green('  ' + UI.sym.ok + ' 会话已清空')); continue; }
    if (input === '/model') {
      listModels();
      const pick = await ask(gray('  输入序号切换（回车取消）: '));
      const all = config.getModelConfigs().configs;
      const cfg = all[Number(pick) - 1];
      if (cfg) { config.saveStore(all, cfg.id); console.log(green('  ' + UI.sym.ok + ' 已切换到 ' + cfg.name)); }
      continue;
    }
    if (input === '/save') {
      if (session.projectStore && session.projectStore.sourcePath) {
        saveProject(session.projectStore.flush(), session.projectStore.assets, session.projectStore.sourcePath);
        console.log(green('  ' + UI.sym.ok + ' 已保存 ' + UI.sym.arrow + ' ' + session.projectStore.sourcePath));
      } else {
        const p = await ask(gray('  保存到路径（.sb3）: '));
        if (p && p.trim()) {
          session.projectStore.sourcePath = p.trim();
          saveProject(session.projectStore.flush(), session.projectStore.assets, p.trim());
          console.log(green('  ' + UI.sym.ok + ' 已保存 ' + UI.sym.arrow + ' ' + p.trim()));
        }
      }
      continue;
    }
    if (input === '/undo') {
      const src = session.projectStore && session.projectStore.sourcePath;
      if (!src) { console.log(red('  没有关联的项目文件')); continue; }
      const r = store.undoSnapshot(src);
      console.log(r ? green('  ' + UI.sym.ok + ' 已回滚 ' + r.restored) : red('  没有可用快照'));
      session.projectStore = loadProjectContext({ project: src });
      continue;
    }
    if (input === '/info') {
      const backend = new ToolBackend(session.projectStore || loadProjectContext(opts), askIo());
      console.log(JSON.stringify(backend.getProjectInfo(), null, 2));
      continue;
    }
    if (input.startsWith('/')) { console.log(red('  未知命令 ' + input)); continue; }

    try {
      const { messages, projectStore, out } = await executeTask(opts, input, session);
      session.messages = messages;
      session.projectStore = projectStore;
      session.updated = new Date().toISOString();
      if (out.error) console.log(red('  ' + UI.sym.fail + ' ' + out.error.message));
      store.saveSession(session.id, { id: session.id, model: (resolveCfg(opts)).name, messages: messages.filter(m => m.role !== 'system' || true), updated: session.updated });
    } catch (err) {
      console.log(red('  ' + UI.sym.fail + ' 执行失败: ' + err.message));
    }
  }
  console.log('\n' + UI.divider());
  console.log(gray('  再见。会话已保存: ' + session.id + '（--session ' + session.id + ' 可恢复）\n'));
}

async function cmdRun (opts) {
  const task = opts._.slice(1).join(' ') || (opts.prompt || '');
  if (!task) { console.error(red('用法: neowarp-ai run "任务描述"')); process.exit(1); }
  const session = { messages: [], projectStore: null };
  const { messages, projectStore, out } = await executeTask(opts, task, session);
  if (out.error) {
    console.error(red('错误: ' + out.error.message));
    process.exit(2);
  }
  if (opts.json) {
    console.log(JSON.stringify({
      rounds: out.rounds,
      toolCalls: out.toolCalls,
      messages: messages.filter(m => m.role === 'assistant').map(m => m.content)
    }, null, 2));
  }
  if (!opts.save && projectStore.sourcePath) {
    console.log(gray('  提示: 加 --save 可把修改自动写回项目文件；或用 /save（chat 模式）手动保存。'));
  }
}

// ── models 子命令 ────────────────────────────────────────────

function listModels () {
  const { configs, activeId } = config.getModelConfigs();
  console.log('  ' + UI.paint.bold('模型配置') + UI.paint.tertiary('  ' + UI.sym.dot + '  ' + config.configPath()));
  console.log('');
  configs.forEach((x, i) => {
    const active = x.id === activeId;
    const provRaw = PROVIDERS[x.provider] ? PROVIDERS[x.provider].name : x.provider;
    const prov = provRaw.split('（')[0].split(' (')[0]; // 短名，去掉括号说明
    console.log(
      '  ' + (active ? UI.paint.green(UI.sym.flag) : UI.paint.tertiary(UI.sym.circle)) + ' ' +
      String(i + 1).padStart(2) + '. ' + UI.paint.bold(x.name || x.id) +
      UI.paint.tertiary('  ' + prov + ' ' + UI.sym.dot + ' ' + (x.apiFormat || 'openai') +
        ' ' + UI.sym.dot + ' ' + (x.customModelId || x.model || '(默认)') +
        ' ' + UI.sym.dot + ' key ' + config.maskKey(x.apiKey)) +
      (active ? '  ' + UI.paint.green('当前') : '')
    );
  });
  if (!configs.length) console.log('  ' + UI.paint.tertiary('（空）'));
  console.log('');
}

async function cmdModels (opts) {
  const sub = opts._[1] || 'list';
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = q => new Promise(res => rl.question(q, res));

  if (sub === 'list') { listModels(); rl.close(); return; }

  if (sub === 'add') {
    console.log(bold('添加模型配置') + gray('（与桌面版 tw_config.json 同格式）'));
    const provKeys = Object.keys(PROVIDERS);
    console.log('  供应商: ' + provKeys.map((k, i) => (i + 1) + '=' + PROVIDERS[k].name).join('  '));
    const provPick = await ask('选择供应商 [1-' + provKeys.length + ']（回车=7/自定义或输入名称）: ');
    let provKey = 'custom';
    const n = Number(provPick);
    if (Number.isInteger(n) && provKeys[n - 1]) provKey = provKeys[n - 1];
    else if (PROVIDERS[provPick.trim()]) provKey = provPick.trim();
    const prov = PROVIDERS[provKey];
    const name = await ask('配置名称 [' + prov.name + ']: ') || prov.name;
    const model = await ask('模型 ID [' + (prov.defaultModel || 'model') + ']: ') || prov.defaultModel;
    const apiKey = await ask('API Key（Ollama/mock 可留空）: ') || '';
    let customEndpoint = '';
    let customModelId = '';
    if (prov.isCustom) {
      customEndpoint = await ask('端点（base URL 或完整 URL，自动补 /chat/completions）: ') || '';
      customModelId = model;
    } else if (provKey === 'ollama') {
      customEndpoint = await ask('端点 [' + prov.endpoint + ']: ') || prov.endpoint;
    }
    const cfg = config.normalizeConfig({
      name, provider: provKey, model, apiKey,
      apiFormat: prov.apiFormat || 'openai',
      customEndpoint, customModelId,
      thinkingLevel: 'medium'
    }, 0);
    const { configs } = config.getModelConfigs();
    configs.push(cfg);
    config.saveStore(configs, cfg.id);
    console.log(green('已添加并激活: ' + cfg.name + '（' + cfg.id + '）'));
    rl.close();
    return;
  }

  const { configs, activeId } = config.getModelConfigs();
  const pick = (arg) => {
    const byIdx = configs[Number(arg) - 1];
    return configs.find(x => x.id === arg || x.name === arg) || (Number.isInteger(Number(arg)) ? byIdx : null);
  };

  if (sub === 'use') {
    const cfg = pick(opts._[2]);
    if (!cfg) { console.error(red('找不到配置: ' + opts._[2])); rl.close(); process.exit(1); }
    config.saveStore(configs, cfg.id);
    console.log(green('已切换到 ' + cfg.name));
  } else if (sub === 'remove') {
    const cfg = pick(opts._[2]);
    if (!cfg) { console.error(red('找不到配置: ' + opts._[2])); rl.close(); process.exit(1); }
    const rest = configs.filter(x => x.id !== cfg.id);
    config.saveStore(rest, rest.length ? (activeId === cfg.id ? rest[0].id : activeId) : null);
    console.log(green('已删除 ' + cfg.name));
  } else if (sub === 'key') {
    const cfg = pick(opts._[2]);
    if (!cfg) { console.error(red('找不到配置: ' + opts._[2])); rl.close(); process.exit(1); }
    cfg.apiKey = opts._[3] || await ask('输入 API Key: ');
    config.saveStore(configs, activeId);
    console.log(green('已更新 ' + cfg.name + ' 的 Key（' + config.maskKey(cfg.apiKey) + '）'));
  } else if (sub === 'test') {
    const cfg = pick(opts._[2]) || configs.find(x => x.id === activeId);
    if (!cfg) { console.error(red('没有配置可测试')); rl.close(); process.exit(1); }
    const em = config.resolveEndpointAndModel(cfg);
    console.log('测试 ' + bold(cfg.name) + gray(' → ' + em.endpoint + ' · ' + em.model));
    if (em.apiFormat === 'mock') {
      console.log(green('✓ Mock 配置无需网络，直接可用'));
      rl.close(); return;
    }
    try {
      const { buildRequestBody, buildHeaders } = require('../lib/llm');
      const resp = await fetch(em.endpoint, {
        method: 'POST',
        headers: buildHeaders(em.apiFormat, cfg),
        body: JSON.stringify(buildRequestBody(em.apiFormat, cfg, em.model, [
          { role: 'user', content: '回复"ok"两个字母即可。' }
        ], [], false)),
        signal: AbortSignal.timeout(20000)
      });
      if (resp.ok) {
        const j = await resp.json().catch(() => null);
        const text = j && j.choices && j.choices[0] && j.choices[0].message ? (j.choices[0].message.content || '').slice(0, 60) : JSON.stringify(j).slice(0, 60);
        console.log(green('✓ 连通正常（HTTP ' + resp.status + '）响应: ' + text));
      } else {
        console.log(red('✗ HTTP ' + resp.status + ' ' + (await resp.text()).slice(0, 200)));
      }
    } catch (e) {
      console.log(red('✗ 失败: ' + e.message));
    }
  } else if (sub === 'import') {
    const file = opts._[2];
    if (!file || !fs.existsSync(file)) { console.error(red('用法: models import <tw_config.json>')); rl.close(); process.exit(1); }
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const r = config.importConfigs(raw.aiModelConfigs || raw, raw.activeAiModelConfigId);
    console.log(green('已导入 ' + r.added + ' 条新配置，共 ' + r.total + ' 条'));
  } else {
    console.error(red('未知子命令: models ' + sub));
  }
  rl.close();
}

// ── project 子命令 ───────────────────────────────────────────

function cmdProject (opts) {
  const sub = opts._[1] || 'info';
  if (sub === 'new') {
    const file = opts._[2];
    if (!file) { console.error(red('用法: project new <file.sb3>')); process.exit(1); }
    saveProject(blankProject(path.basename(file, path.extname(file))), [], file);
    console.log(green('  ' + UI.sym.ok + ' 已创建空白项目 ' + UI.sym.arrow + ' ' + file));
    return;
  }
  const storeObj = loadProjectContext(opts);
  const backend = new ToolBackend(storeObj, { prompt: async () => '' });
  if (sub === 'info') {
    console.log(JSON.stringify(backend.getProjectInfo(), null, 2));
  } else if (sub === 'scripts') {
    const sprite = opts._[2];
    if (!sprite) { console.error(red('用法: project scripts <角色名>')); process.exit(1); }
    console.log(JSON.stringify(backend.getSpriteScripts({ sprite }), null, 2));
  } else if (sub === 'snapshots') {
    const src = storeObj.sourcePath;
    const snaps = src ? store.listSnapshots(src) : [];
    console.log(snaps.length ? snaps.map(s => '  ' + s).join('\n') : gray('  （没有快照）'));
  } else if (sub === 'undo') {
    const src = storeObj.sourcePath;
    if (!src) { console.error(red('项目文件未保存到磁盘，无法回滚')); process.exit(1); }
    const r = store.undoSnapshot(src);
    if (r) console.log(green('  ' + UI.sym.ok + ' 已回滚 ' + r.restored + ' ' + UI.paint.tertiary(UI.sym.arrow + ' ' + path.basename(r.from))));
    else { console.log(red('  ' + UI.sym.fail + ' 没有可用快照')); process.exit(1); }
  } else {
    console.error(red('未知子命令: project ' + sub));
    process.exit(1);
  }
}

// ── dsl 自检 ─────────────────────────────────────────────────

function cmdDslRoundtrip () {
  const ENGINE = require('../lib/dsl-engine');
  const { makeBlocksContainer } = require('../lib/backend');
  const { blankProject } = require('../lib/sb3');
  const { ProjectStore } = require('../lib/vm-adapter');

  function makeTarget () {
    const storeObj = new ProjectStore(blankProject('t'), [], null);
    const cat = storeObj.addSprite('Cat');
    cat.blocks = makeBlocksContainer(cat.blocks._blocks);
    cat.runtime = {
      _blockInfo: [],
      targets: storeObj.adapters,
      getTargetForStage: () => storeObj.stageAdapter,
      getTargetById: () => null,
      emitProjectChanged () {}
    };
    return cat;
  }
  function roundTrip (dsl) {
    const target = makeTarget();
    const parsed = ENGINE.parseScratchDSL(dsl, target);
    const v = ENGINE.validateParsedScript(parsed, target);
    if (v.errors.length) return { error: v.errors.join('; ') };
    const built = ENGINE.buildScriptBlocks(parsed, target);
    built.blocks.forEach(b => target.blocks.createBlock(b));
    const scripts = ENGINE.collectTargetDsl(target);
    return { dsl: scripts.map(s => s.dsl).join('\n') };
  }
  const cases = [
    ['simple stack', 'event_whenflagclicked\nmotion_movesteps 10\nlooks_say "hello"'],
    ['nested C-blocks', 'event_whenkeypressed "space"\ncontrol_repeat 10\n  motion_changeyby 6\n  control_wait 0.02'],
    ['if/else with reporters', 'event_whenflagclicked\ncontrol_if_else (operator_gt (sensing_timer) 10)\n  looks_say "up"\nelse\n  looks_say "down"'],
    ['list ops', 'event_whenflagclicked\ndata_addtolist "apple" @fruit\ndata_insertatlist "pear" 2 @fruit\ndata_replaceitemoflist 1 @fruit "kiwi"\ndata_deleteoflist 3 @fruit'],
    ['variable ops', 'event_whenflagclicked\ndata_setvariableto $score 0\ndata_changevariableby $score 5'],
    ['menus and dropdowns', 'event_whenflagclicked\nmotion_goto "_random_"\nmotion_pointtowards "_mouse_"\nlooks_switchcostumeto "costume1"\ncontrol_stop "this script"'],
    ['glide', 'event_whenflagclicked\nmotion_glideto 1.5 "_mouse_"'],
    ['colour input', 'event_whenflagclicked\ncontrol_wait_until (sensing_touchingcolor "#ff0000")'],
    ['angle input', 'event_whenflagclicked\nmotion_pointindirection 45'],
    ['broadcast', 'event_whenbroadcastreceived "go"\nevent_broadcast "done"'],
    ['deep reporter nesting', 'event_whenflagclicked\nmotion_movesteps (operator_multiply (operator_add 1 2) (operator_random 1 10))'],
    ['boolean operators', 'event_whenflagclicked\ncontrol_if (operator_and (sensing_mousedown) (operator_not (sensing_keypressed "a")))\n  looks_say "both"']
  ];
  let pass = 0; let fail = 0;
  for (const [name, dsl] of cases) {
    const out = roundTrip(dsl);
    if (out.error || out.dsl !== dsl) {
      fail++;
      console.log(red('  ✗ ' + name));
      if (out.error) console.log(gray('      ' + out.error.slice(0, 120)));
      else {
        console.log(gray('      期望: ' + dsl.split('\n').join(' ⏎ ')));
        console.log(gray('      实际: ' + out.dsl.split('\n').join(' ⏎ ')));
      }
    } else {
      pass++;
      console.log(green('  ✓ ' + name));
    }
  }
  // 校验拒绝用例
  const rejects = [
    ['unknown opcode', 'event_whenflagclicked\nmotion_teleport 10'],
    ['nested hat', 'event_whenflagclicked\ncontrol_repeat 2\n  event_whenflagclicked'],
    ['too many args', 'event_whenflagclicked\nmotion_movesteps 10 20 30'],
    ['body under non-C block', 'event_whenflagclicked\nlooks_say "x"\n  motion_movesteps 1']
  ];
  for (const [name, dsl] of rejects) {
    const target = makeTarget();
    const parsed = ENGINE.parseScratchDSL(dsl, target);
    const v = ENGINE.validateParsedScript(parsed, target);
    if (v.errors.length) { pass++; console.log(green('  ✓ reject: ' + name)); }
    else { fail++; console.log(red('  ✗ reject: ' + name + '（未被拒绝！）')); }
  }
  console.log('\n  ' + (fail === 0 ? UI.paint.green(UI.sym.ok + ' 全部通过') : UI.paint.red(UI.sym.fail + ' 存在失败')) + UI.paint.tertiary('  ' + UI.sym.dot + '  ' + pass + ' 通过 / ' + fail + ' 失败'));
  process.exit(fail === 0 ? 0 : 1);
}

// ── main ─────────────────────────────────────────────────────

async function main () {
  const opts = parseArgs(process.argv.slice(2));
  const cmd = opts._[0] || 'help';
  switch (cmd) {
    case 'chat': await cmdChat(opts); break;
    case 'run': await cmdRun(opts); break;
    case 'models': await cmdModels(opts); break;
    case 'project': cmdProject(opts); break;
    case 'dsl':
      if (opts._[1] === 'roundtrip') cmdDslRoundtrip();
      else { console.error('未知子命令'); process.exit(1); }
      break;
    case 'help':
    default:
      usage();
      if (cmd !== 'help') process.exitCode = 1;
  }
}

main().catch(err => {
  console.error(err.expected ? red('错误: ' + err.message) : red('未处理错误: ' + (err.stack || err.message)));
  process.exit(1);
});
