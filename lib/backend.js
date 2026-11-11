/**
 * NeoWarpAI CLI — 工具执行后端。
 *
 * 对 ProjectStore（project.json 内存表示）执行 NeoWarp AI 的工具集。
 * 积木类操作（add_script / insert_blocks / delete_block / modify_input /
 * get_sprite_scripts）直接复用 desktop-hoc.jsx 的 DSL 引擎与
 * spliceBlocksIntoScript，链操作语义与编辑器逐行为一致；其余工具
 * （变量/列表/精灵/舞台/系统信息等）与 desktop-hoc.jsx 对应 case 同语义。
 *
 * 工具命名采用系统提示词里的 snake_case（add_script、list_sprites…），
 * 与 NeoWarp 桌面版提示词协议一致。
 */
'use strict';

const ENGINE = require('./dsl-engine');
const { genId } = require('./vm-adapter');

/** 模拟 scratch-vm Blocks 容器的最小接口（引擎需要的全部方法）。 */
function makeBlocksContainer (storeBlocks) {
  return {
    _blocks: storeBlocks,
    _addScript (topId) {
      const b = storeBlocks[topId];
      if (b) { b.topLevel = true; if (b.x === undefined) b.x = 0; if (b.y === undefined) b.y = 0; }
    },
    _deleteScript (topId) {
      const b = storeBlocks[topId];
      if (b) { b.topLevel = false; }
    },
    createBlock (b) { storeBlocks[b.id] = b; },
    getBlock (id) { return storeBlocks[id] || null; },
    deleteBlock (id) { delete storeBlocks[id]; }
  };
}

function attachBlocks (adapter) {
  if (!adapter.blocks || !adapter.blocks.getBlock) {
    adapter.blocks = makeBlocksContainer(adapter.blocks && adapter.blocks._blocks ? adapter.blocks._blocks : {});
  }
  return adapter.blocks;
}

/** 与引擎交互前确保适配器带 blocks 容器。 */
function withEngine (adapter) {
  attachBlocks(adapter);
  if (!adapter.runtime) {
    // 由 ToolBackend 注入 runtime（见 constructor）
  }
  return adapter;
}

class ToolBackend {
  /**
   * @param {ProjectStore} store
   * @param {object} io 交互 {prompt(question): Promise<string>}，ask_user 用
   */
  constructor (store, io) {
    this.store = store;
    this.io = io || { prompt: async () => '' };
    this.extensionsAdded = []; // delete_extension 仅允许删 AI 自己加的（与上游一致）
    this.stubVm = {
      runtime: { emitProjectChanged () {} },
      emitWorkspaceUpdate () {},
      emitTargetsUpdate () {}
    };
    for (const a of store.adapters) {
      attachBlocks(a);
      // 引擎在 runtime 上只读 _blockInfo（扩展积木）与 targets/stage；CLI 不加载
      // 运行时扩展，_blockInfo 留空即回落到 OPCODE_SCHEMA 核心积木。
      a.runtime = {
        _blockInfo: [],
        targets: store.adapters,
        getTargetForStage: () => store.stageAdapter,
        getTargetById: (id) => store.adapters.find(x => x.id === id) || null,
        emitProjectChanged () {}
      };
    }
  }

  // ── 通用查找 ─────────────────────────────────────────────

  findAdapter (spriteName) {
    if (!spriteName) return this.store.stageAdapter;
    const a = this.store.findTarget(spriteName);
    if (!a || a.isStage) {
      // 名字精确匹配精灵（Stage 传 "Stage" 仍返回 stage）
      if (spriteName && String(spriteName).toLowerCase() === 'stage') return this.store.stageAdapter;
      return this.store.findTarget(spriteName);
    }
    return a;
  }

  requireSprite (spriteName, toolName) {
    if (!spriteName) return { error: toolName + ' 需要 sprite 参数（角色名，大小写敏感）。先用 list_sprites 查看现有角色。' };
    const a = this.store.findTarget(spriteName);
    if (!a) return { error: '找不到角色 "' + spriteName + '"。先用 list_sprites 查看现有角色名。' };
    if (a.isStage) return { error: '"' + spriteName + '" 是舞台（Stage），该工具只作用于角色。' };
    return { adapter: a };
  }

  /** 把 tid 解析为 {adapter, blockId}。tid 支持真实 blockId。 */
  resolveBlockId (tid) {
    for (const a of this.store.adapters) {
      if (a.blocks._blocks[tid]) return { target: a, blockId: tid };
    }
    return null;
  }

  // ── 积木工具 ─────────────────────────────────────────────

  /**
   * add_script：在角色上追加一个新脚本（语义与上游 executeOperations 的
   * add_script case 逐行一致：parse → validate → build(topLevel) → createBlock，
   * 不触碰既有脚本）。
   */
  addScript (args) {
    const spriteName = args.sprite || args.spriteName;
    const req = this.requireSprite(spriteName, 'add_script');
    if (req.error) return { success: false, error: req.error };
    const target = withEngine(req.adapter);
    let scriptText = args.script;
    if (!scriptText) {
      return { success: false, error: '缺少 script 参数。它必须是 DSL 文本字符串（如 "event_whenflagclicked\\n  motion_movesteps 10"），不要传 JSON 对象。' };
    }
    if (typeof scriptText === 'object') {
      try {
        scriptText = ENGINE.convertBlockObjToDsl(scriptText, 0, target.runtime).join('\n');
      } catch (e) {
        return { success: false, error: 'script 对象转 DSL 失败: ' + (e.message || String(e)) };
      }
    }
    if (typeof scriptText !== 'string') {
      return { success: false, error: 'script 必须是 DSL 文本字符串（当前 ' + typeof scriptText + '）。' };
    }
    let parsed;
    try {
      parsed = ENGINE.parseScratchDSL(scriptText, target);
    } catch (e) {
      return { success: false, error: 'DSL 解析错误: ' + (e.message || String(e)) + '\n脚本文本(前500字符):\n' + String(scriptText).slice(0, 500) };
    }
    const validation = ENGINE.validateParsedScript(parsed, target);
    if (validation.errors.length > 0) {
      return { success: false, error: '校验失败: ' + ENGINE.formatValidationError(validation.errors, scriptText) };
    }
    const warnings = (parsed.warnings || []).concat(validation.warnings);
    const allBlocks = ENGINE.buildScriptBlocks(parsed, target).blocks;
    if (allBlocks.length > 0) {
      try {
        allBlocks.forEach(b => target.blocks.createBlock(b));
      } catch (e) {
        return { success: false, error: 'createBlock 失败: ' + (e.message || String(e)) + '（已尝试 ' + allBlocks.length + ' 块）' };
      }
    }
    return {
      success: true,
      sprite: target.getName(),
      blocksCreated: allBlocks.length,
      warnings: warnings.length ? warnings : undefined
    };
  }

  /** set_scripts：整段替换角色的全部脚本（applyDslTextToTarget 语义）。 */
  setScripts (args) {
    const spriteName = args.sprite || args.spriteName;
    const req = this.requireSprite(spriteName, 'set_scripts');
    if (req.error) return { success: false, error: req.error };
    const target = withEngine(req.adapter);
    const scriptText = args.script;
    if (!scriptText || typeof scriptText !== 'string') {
      return { success: false, error: 'set_scripts 需要 script 参数（DSL 文本）。它会替换该角色的全部脚本。' };
    }
    const out = ENGINE.applyDslTextToTarget(this.stubVm, target, String(scriptText));
    if (!out || !out.success) return { success: false, error: (out && out.error) || '应用失败' };
    return {
      success: true,
      sprite: target.getName(),
      scripts: out.scripts,
      blocks: out.blocks,
      warnings: out.warnings
    };
  }

  /** get_sprite_scripts：把角色脚本读回为 DSL 文本（同 collectTargetDsl）。 */
  getSpriteScripts (args) {
    const req = this.requireSprite(args.sprite || args.spriteName, 'get_sprite_scripts');
    if (req.error) return { success: false, error: req.error };
    const target = withEngine(req.adapter);
    const scripts = ENGINE.collectTargetDsl(target);
    const out = scripts.map(s => ({ tid: s.blockId, script: s.dsl }));
    return {
      success: true,
      sprite: target.getName(),
      scriptCount: out.length,
      scripts: out,
      note: out.length ? 'tid 可用于 insert_blocks / delete_block / modify_input' : '该角色还没有脚本。'
    };
  }

  /** execute_operations：批量操作（同 executeOperations 的七种 type）。 */
  executeOperations (args) {
    const ops = args.operations;
    if (!Array.isArray(ops) || !ops.length) {
      return { success: false, error: 'execute_operations 需要 operations 数组，每项带 type 字段。' };
    }
    const results = [];
    let failures = 0;
    ops.forEach((op, i) => {
      let r;
      switch (op && op.type) {
        case 'add_script': r = this.addScript(op); break;
        case 'insert_blocks': r = this.insertBlocks(op); break;
        case 'delete_block': r = this.deleteBlock(op); break;
        case 'modify_input': r = this.modifyInput(op); break;
        case 'add_comment': r = this.addComment(op); break;
        case 'delete_comment': r = this.deleteComment(op); break;
        case 'explain':
          r = { success: true, explanation: op.text || '' };
          break;
        default:
          r = { success: false, error: '未知操作类型: ' + JSON.stringify(op && op.type) + '。可用: add_script/insert_blocks/delete_block/modify_input/add_comment/delete_comment/explain' };
      }
      if (!r.success) failures++;
      results.push(Object.assign({ index: i }, r));
    });
    return {
      success: failures === 0,
      applied: ops.length - failures,
      failures,
      results
    };
  }

  /** insert_blocks：向既有脚本拼接积木体（语义与上游逐行一致）。 */
  insertBlocks (op) {
    const resolved = this.resolveBlockId(op.targetId);
    if (!resolved) return { success: false, error: '找不到积木 tid: ' + op.targetId + '。只使用项目上下文里出现的 tid，先 get_sprite_scripts 获取。' };
    const target = resolved.target;
    const anchorId = resolved.blockId;
    const position = op.position || 'after';
    const VALID = ['after', 'before', 'body_start', 'body_end'];
    if (VALID.indexOf(position) < 0) {
      return { success: false, error: '非法 position "' + position + '"。可用: ' + VALID.join(', ') };
    }
    let insertText = op.blocks !== undefined ? op.blocks : op.script;
    if (insertText === undefined || insertText === null || insertText === '') {
      return { success: false, error: '缺少 blocks 参数（DSL 文本，如 "looks_say \\"hi\\"\\ncontrol_wait 1"）。' };
    }
    if (typeof insertText === 'object') {
      try {
        insertText = ENGINE.convertBlockObjToDsl(insertText, 0, target.runtime).join('\n');
      } catch (e) {
        return { success: false, error: 'blocks 对象转 DSL 失败: ' + (e.message || String(e)) };
      }
    }
    let parsedIns;
    try {
      parsedIns = ENGINE.parseScratchDSL(String(insertText), target);
    } catch (e) {
      return { success: false, error: 'DSL 解析错误: ' + (e.message || String(e)) };
    }
    if (parsedIns.hat && String(insertText).replace(/^[ \t]+/, '').indexOf('event_') === 0) {
      return { success: false, error: 'insert_blocks 只接受积木体；"' + parsedIns.hat.opcode + '" 是帽积木。新建脚本请用 add_script。' };
    }
    const insBody = { hat: null, blocks: parsedIns.blocks, warnings: parsedIns.warnings };
    if (!insBody.blocks || !insBody.blocks.length) {
      return { success: false, error: 'DSL 未产生积木。文本: ' + String(insertText).slice(0, 200) };
    }
    const insValidation = ENGINE.validateParsedScript(insBody, target);
    if (insValidation.errors.length) {
      return { success: false, error: '校验失败: ' + insValidation.errors.join('; ') };
    }
    const insBuilt = ENGINE.buildScriptBlocks(insBody, target, { topLevel: false });
    const firstBlock = insBuilt.blocks.filter(b => !b.shadow)[0];
    if (!firstBlock || !insBuilt.lastId) {
      return { success: false, error: '无法构建要插入的积木' };
    }
    const spliced = ENGINE.spliceBlocksIntoScript(target, insBuilt.blocks, firstBlock.id, insBuilt.lastId, {
      position, blockId: anchorId, branch: op.branch
    });
    if (!spliced.ok) return { success: false, error: spliced.error };
    return {
      success: true,
      blocksInserted: insBuilt.blocks.filter(b => !b.shadow).length,
      position,
      warnings: insValidation.warnings.length ? insValidation.warnings : undefined
    };
  }

  /** delete_block：摘除积木（with_children / block_only）。 */
  deleteBlock (op) {
    const resolved = this.resolveBlockId(op.targetId);
    if (!resolved) return { success: false, error: '找不到积木 tid: ' + op.targetId };
    const target = resolved.target;
    const blockId = resolved.blockId;
    const blocks = target.blocks;
    const block = blocks.getBlock(blockId);
    if (!block) return { success: false, error: '积木不存在' };
    const mode = op.mode || 'with_children';
    let removed = 0;
    if (mode === 'with_children') {
      const ids = [];
      const collect = (id) => {
        if (!id || ids.indexOf(id) >= 0) return;
        ids.push(id);
        const b = blocks.getBlock(id);
        if (!b) return;
        if (b.next) collect(b.next);
        if (b.inputs && b.inputs.SUBSTACK && b.inputs.SUBSTACK.block) collect(b.inputs.SUBSTACK.block);
        if (b.inputs && b.inputs.SUBSTACK2 && b.inputs.SUBSTACK2.block) collect(b.inputs.SUBSTACK2.block);
      };
      collect(blockId);
      ids.forEach(id => { blocks.deleteBlock(id); removed++; });
    } else {
      const parentId = block.parent;
      if (block.next) {
        const nb = blocks.getBlock(block.next);
        if (nb) nb.parent = parentId;
      }
      // 父指针重定向（上游 deleteBlock 内部处理 _blocks；这里显式重连）
      if (parentId) {
        const pb = blocks.getBlock(parentId);
        if (pb) {
          if (pb.next === blockId) pb.next = block.next || null;
          ['SUBSTACK', 'SUBSTACK2'].forEach(k => {
            if (pb.inputs && pb.inputs[k] && pb.inputs[k].block === blockId) {
              pb.inputs[k].block = block.next || null;
              if (!block.next) pb.inputs[k].shadow = pb.inputs[k].shadow || null;
            }
          });
        }
      }
      blocks.deleteBlock(blockId);
      removed = 1;
    }
    return { success: true, removed, mode };
  }

  /** modify_input：改一处输入（标量 / 报告器 / SUBSTACK DSL）。 */
  modifyInput (op) {
    const resolved = this.resolveBlockId(op.targetId);
    if (!resolved) return { success: false, error: '找不到积木 tid: ' + op.targetId };
    const target = resolved.target;
    const blockId = resolved.blockId;
    const blocks = target.blocks;
    const block = blocks.getBlock(blockId);
    if (!block) return { success: false, error: '积木不存在' };
    const inputName = op.inputName;
    const value = op.value;
    const oldInput = block.inputs ? block.inputs[inputName] : undefined;
    const inputSchema = ENGINE.OPCODE_SCHEMA[block.opcode];
    if (inputSchema && inputName !== 'SUBSTACK' && inputName !== 'SUBSTACK2' &&
        !ENGINE.schemaArgFor(block.opcode, inputName)) {
      return {
        success: false,
        error: block.opcode + ' 没有名为 "' + inputName + '" 的输入。可用: ' +
          (inputSchema.args.map(a => a.name).join(', ') || '（无）') +
          (inputSchema.substack ? ', SUBSTACK' : '') + (inputSchema.substack2 ? ', SUBSTACK2' : '')
      };
    }
    const deleteOldShadow = () => {
      if (oldInput && oldInput.shadow) blocks.deleteBlock(oldInput.shadow);
      if (oldInput && oldInput.block && oldInput.block !== oldInput.shadow) blocks.deleteBlock(oldInput.block);
    };
    if (!block.inputs) block.inputs = {};

    if (typeof value === 'string' && (inputName === 'SUBSTACK' || inputName === 'SUBSTACK2')) {
      deleteOldShadow();
      let parsedSub;
      try {
        parsedSub = ENGINE.parseScratchDSL(value, target);
      } catch (e) {
        return { success: false, error: 'SUBSTACK DSL 解析错误: ' + (e.message || String(e)) };
      }
      const subAll = [];
      let firstId = null;
      let prevId = null;
      (parsedSub.blocks || []).forEach(blk => {
        const sid = ENGINE.buildBlockStructure(blk, target, subAll);
        if (sid) {
          const def = subAll.find(ab => ab.id === sid);
          if (def) def.parent = prevId || blockId;
          if (!firstId) firstId = sid;
          if (prevId) {
            const pdef = subAll.find(ab => ab.id === prevId);
            if (pdef) pdef.next = sid;
          }
          prevId = sid;
        }
      });
      if (!firstId) return { success: false, error: 'SUBSTACK DSL 未产生积木: ' + value.slice(0, 200) };
      subAll.forEach(b => blocks.createBlock(b));
      block.inputs[inputName] = { name: inputName, block: firstId, shadow: null };
    } else if (value && typeof value === 'object' && value.opcode && (inputName === 'SUBSTACK' || inputName === 'SUBSTACK2')) {
      deleteOldShadow();
      const subAll = [];
      const rid = ENGINE.buildBlockStructure(value, target, subAll);
      if (!rid) return { success: false, error: '无法构建 ' + inputName + ' 的积木' };
      const def = subAll.find(ab => ab.id === rid);
      if (def) def.parent = blockId;
      subAll.forEach(b => blocks.createBlock(b));
      block.inputs[inputName] = { name: inputName, block: rid, shadow: null };
    } else if (value && typeof value === 'object' && value.opcode) {
      deleteOldShadow();
      const reporterBlocks = [];
      const rid = ENGINE.buildBlockStructure(value, target, reporterBlocks);
      if (!rid) return { success: false, error: '无法为 ' + inputName + ' 构建报告器: 缺少 opcode' };
      const rdef = reporterBlocks.find(ab => ab.id === rid);
      if (rdef) rdef.parent = blockId;
      reporterBlocks.forEach(b => blocks.createBlock(b));
      block.inputs[inputName] = { name: inputName, block: rid, shadow: null };
    } else {
      deleteOldShadow();
      const shadowPair = ENGINE.createInputShadow(target, blockId, block.opcode, inputName, value);
      if (shadowPair[0]) {
        blocks.createBlock(shadowPair[0]);
        block.inputs[inputName] = shadowPair[1];
      } else {
        delete block.inputs[inputName];
      }
    }
    return { success: true };
  }

  addComment (op) {
    const adapter = op.sprite ? this.store.findTarget(op.sprite) : this.store.stageAdapter;
    if (!adapter) return { success: false, error: '找不到角色: ' + op.sprite };
    const id = '_ai_cmt_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    const text = String(op.text || '');
    const minimized = op.minimized === true;
    let x = typeof op.x === 'number' ? op.x : 100 + Math.random() * 200;
    let y = typeof op.y === 'number' ? op.y : 100 + Math.random() * 200;
    if (op.targetId) {
      const resolved = this.resolveBlockId(op.targetId);
      if (!resolved) return { success: false, error: '找不到积木 tid: ' + op.targetId };
      const blk = resolved.target.blocks.getBlock(resolved.blockId);
      if (blk && typeof blk.x === 'number') { x = blk.x + 240; y = blk.y; }
    }
    adapter.comments[id] = { blockId: op.targetId || null, x, y, width: 200, height: 200, size: 12, minimized, text };
    return { success: true, data: { commentId: id } };
  }

  deleteComment (op) {
    const adapter = op.sprite ? this.store.findTarget(op.sprite) : this.store.stageAdapter;
    if (!adapter) return { success: false, error: '找不到角色: ' + op.sprite };
    let id = op.commentId;
    if (!id && op.targetId) {
      // targetId 可能是块 tid（挂在该块上的评论）或 commentId
      const hit = Object.keys(adapter.comments).find(cid =>
        cid === op.targetId || adapter.comments[cid].blockId === op.targetId);
      id = hit;
    }
    if (!id || !adapter.comments[id]) return { success: false, error: '找不到评论: ' + (op.commentId || op.targetId) };
    delete adapter.comments[id];
    return { success: true };
  }

  // ── 项目 / 精灵 ───────────────────────────────────────────

  getProjectInfo () {
    const p = this.store.project;
    const sprites = this.store.listSpriteAdapters();
    return {
      success: true,
      name: p.name || '未命名',
      spriteCount: sprites.length,
      sprites: sprites.map(a => ({
        name: a.getName(),
        blocks: Object.keys(a.blocks._blocks).length,
        costumes: a.getCostumes().map(c => c.name),
        sounds: a.getSounds().map(s => s.name),
        x: a.__data.x, y: a.__data.y, size: a.__data.size, direction: a.__data.direction,
        visible: a.__data.visible !== false
      })),
      stage: {
        backdrops: this.store.stageAdapter.getCostumes().map(c => c.name),
        blocks: Object.keys(this.store.stageAdapter.blocks._blocks).length
      },
      extensions: p.extensions || []
    };
  }

  listSprites () {
    const info = this.getProjectInfo();
    return { success: true, ...info };
  }

  getProjectSummary () {
    return this.getProjectInfo();
  }

  addSprite (args) {
    const name = (args.spriteName || args.name || 'Sprite1').trim() || 'Sprite1';
    // CLI 无素材库资源文件：创建空白精灵并说明
    const adapter = this.store.addSprite(name);
    return {
      success: true,
      name: adapter.getName(),
      note: '已创建空白角色（含默认造型）。CLI 模式不内置 Scratch 素材库；可用 add_costume_from_url 添加图片。'
    };
  }

  deleteSprite (args) {
    const req = this.requireSprite(args.spriteName || args.sprite, 'delete_sprite');
    if (req.error) return { success: false, error: req.error };
    const name = req.adapter.getName();
    const removed = {
      scripts: Object.keys(req.adapter.blocks._blocks).length,
      costumes: req.adapter.getCostumes().length,
      sounds: req.adapter.getSounds().length,
      variables: Object.keys(req.adapter.variables).filter(id => req.adapter.variables[id].type !== 'broadcast_msg').length
    };
    this.store.deleteSprite(name);
    return { success: true, deleted: name, removed };
  }

  renameSprite (args) {
    const req = this.requireSprite(args.spriteName || args.sprite, 'rename_sprite');
    if (req.error) return { success: false, error: req.error };
    const oldName = req.adapter.getName();
    const newName = String(args.newName || '').trim();
    if (!newName) return { success: false, error: '缺少 newName' };
    if (this.store.findTarget(newName)) return { success: false, error: '已有同名角色 "' + newName + '"' };
    req.adapter.__data.name = newName;
    return { success: true, oldName, newName };
  }

  duplicateSprite (args) {
    const req = this.requireSprite(args.spriteName || args.sprite, 'duplicate_sprite');
    if (req.error) return { success: false, error: req.error };
    const src = req.adapter.__data;
    let newName = args.newName || (src.name + ' copy');
    let n = 2;
    while (this.store.findTarget(newName)) newName = (args.newName || (src.name + ' copy')) + n++;
    const clone = JSON.parse(JSON.stringify(src));
    clone.name = newName;
    clone.layerOrder = this.project_targets().length;
    // 重新生成 id 避免冲突
    const remap = {};
    Object.keys(clone.blocks).forEach(id => { remap[id] = genId('dup_'); });
    const nb = {};
    Object.keys(clone.blocks).forEach(id => {
      const b = JSON.parse(JSON.stringify(clone.blocks[id]));
      b.id = remap[id];
      if (b.next && remap[b.next]) b.next = remap[b.next];
      if (b.parent && remap[b.parent]) b.parent = remap[b.parent];
      if (b.inputs) {
        Object.keys(b.inputs).forEach(k => {
          const inp = b.inputs[k];
          if (inp && inp.block && remap[inp.block]) inp.block = remap[inp.block];
          if (inp && inp.shadow && remap[inp.shadow]) inp.shadow = remap[inp.shadow];
        });
      }
      nb[b.id] = b;
    });
    clone.blocks = nb;
    // 本地变量也换 id
    const nv = {};
    Object.keys(clone.variables || {}).forEach(id => { nv[genId('dupvar_')] = clone.variables[id]; });
    clone.variables = nv;
    this.store.project.targets.push(clone);
    // 复制出的角色补建适配器（variables/broadcasts 已在 clone 里）
    const { adaptTarget } = require('./vm-adapter');
    const dupAdapter = adaptTarget(clone, this.store);
    attachBlocks(dupAdapter);
    dupAdapter.runtime = {
      _blockInfo: [],
      targets: this.store.adapters,
      getTargetForStage: () => this.store.stageAdapter,
      getTargetById: (id) => this.store.adapters.find(x => x.id === id) || null,
      emitProjectChanged () {}
    };
    this.store.adapters.push(dupAdapter);
    return { success: true, original: src.name, name: newName };
  }

  project_targets () {
    return this.store.project.targets;
  }

  setSpriteProperty (args) {
    const req = this.requireSprite(args.spriteName || args.sprite, 'set_sprite_property');
    if (req.error) return { success: false, error: req.error };
    const d = req.adapter.__data;
    const warnings = [];
    const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    if (args.x !== undefined) d.x = num(args.x);
    if (args.y !== undefined) d.y = num(args.y);
    if (args.size !== undefined) {
      const n = num(args.size);
      if (n !== null && (n < 5 || n > 535)) warnings.push('size 超出 5~535，已按 Scratch 规则截断');
      if (n !== null) d.size = clamp(n, 5, 535);
    }
    if (args.direction !== undefined) {
      const n = num(args.direction);
      if (n !== null && (n < -180 || n > 180)) warnings.push('direction 超出 -180~180，已按 Scratch 规则归一化');
      if (n !== null) d.direction = n;
    }
    if (args.visible !== undefined) d.visible = !!args.visible && args.visible !== 'false';
    if (args.draggable !== undefined) d.draggable = !!args.draggable && args.draggable !== 'false';
    if (args.rotationStyle !== undefined) {
      const ok = ['all around', 'left-right', "don't rotate"];
      if (ok.indexOf(args.rotationStyle) < 0) {
        return { success: false, error: 'rotationStyle 必须是: ' + ok.join(' | ') };
      }
      d.rotationStyle = args.rotationStyle;
    }
    return { success: true, sprite: req.adapter.getName(), warnings: warnings.length ? warnings : undefined };
  }

  getSpriteProperty (args) {
    const req = this.requireSprite(args.spriteName || args.sprite, 'get_sprite_property');
    if (req.error) return { success: false, error: req.error };
    const d = req.adapter.__data;
    return {
      success: true,
      name: d.name,
      x: d.x, y: d.y, size: d.size, direction: d.direction,
      visible: d.visible !== false, draggable: !!d.draggable,
      rotationStyle: d.rotationStyle,
      currentCostume: (d.costumes[d.currentCostume] || {}).name,
      costumeCount: d.costumes.length
    };
  }

  changeCostume (args) {
    const req = this.requireSprite(args.spriteName || args.sprite, 'change_costume');
    if (req.error) return { success: false, error: req.error };
    const d = req.adapter.__data;
    const name = String(args.costumeName || '');
    const idx = d.costumes.findIndex(c => c.name === name);
    if (idx < 0) {
      return { success: false, error: '找不到造型 "' + name + '"。现有造型: ' + d.costumes.map(c => c.name).join(', ') };
    }
    d.currentCostume = idx;
    return { success: true, sprite: d.name, costume: name };
  }

  changeBackdrop (args) {
    const d = this.store.stageAdapter.__data;
    const name = String(args.backdropName || '');
    const idx = d.costumes.findIndex(c => c.name === name);
    if (idx < 0) {
      return { success: false, error: '找不到背景 "' + name + '"。现有背景: ' + d.costumes.map(c => c.name).join(', ') };
    }
    d.currentCostume = idx;
    return { success: true, backdrop: name };
  }

  addBackdrop (args) {
    const d = this.store.stageAdapter.__data;
    const name = args.backdropName || ('backdrop' + (d.costumes.length + 1));
    const color = typeof args.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(args.color) ? args.color : '#4c97ff';
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360"><rect width="480" height="360" fill="' + color + '"/></svg>';
    const assetId = require('crypto').createHash('md5').update(svg).digest('hex');
    d.costumes.push({
      name, dataFormat: 'svg', assetId,
      md5ext: assetId + '.svg', rotationCenterX: 240, rotationCenterY: 180
    });
    this.store.assets.push({ name: assetId + '.svg', data: Buffer.from(svg, 'utf8') });
    d.currentCostume = d.costumes.length - 1;
    return { success: true, backdrop: name, color, note: '纯色渐变背景（SVG）。' };
  }

  getStageInfo () {
    const d = this.store.stageAdapter.__data;
    return {
      success: true,
      currentBackdrop: (d.costumes[d.currentCostume] || {}).name,
      backdrops: d.costumes.map(c => c.name),
      width: 480, height: 360
    };
  }

  renameProject (args) {
    const name = String(args.name || '').trim();
    if (!name) return { success: false, error: '缺少 name' };
    this.store.project.name = name;
    return { success: true, name };
  }

  setStageSize (args) {
    // TurboWarp 特性：stageWidth/stageHeight
    const w = Number(args.width);
    const h = Number(args.height);
    if (!Number.isFinite(w) || !Number.isFinite(h) || w < 240 || h < 180) {
      return { success: false, error: '宽度与高度必须为数字且不小于 240x180' };
    }
    const p = this.store.project;
    p.stageWidth = Math.floor(w);
    p.stageHeight = Math.floor(h);
    return { success: true, width: p.stageWidth, height: p.stageHeight, note: 'TurboWarp 自定义舞台尺寸，保存于 project.json 的 stageWidth/stageHeight。' };
  }

  // ── 变量 / 列表 ───────────────────────────────────────────

  createVariable (args) {
    const name = String(args.variableName || args.name || '').trim();
    if (!name) return { success: false, error: '缺少 variableName' };
    const scope = args.spriteName || undefined;
    const { id, existed } = this.store.ensureVariable(name, '', scope);
    if (!existed && args.initial_value !== undefined) {
      const hit = this.store.getVariableValue(id);
      const raw = args.initial_value;
      hit.value = (typeof raw === 'string' && raw !== '' && !isNaN(Number(raw))) ? Number(raw) : raw;
    }
    return {
      success: true,
      name,
      scope: scope || 'Stage（全局）',
      existed,
      value: (this.store.getVariableValue(id) || {}).value
    };
  }

  setVariable (args) {
    const name = String(args.variableName || args.name || '');
    const scope = args.spriteName || undefined;
    const { id, existed } = this.store.ensureVariable(name, '', scope);
    if (!existed) return { success: false, error: '变量 "' + name + '" 不存在。先用 create_variable 创建。' };
    const hit = this.store.getVariableValue(id);
    const prev = hit.value;
    const raw = args.value;
    hit.value = (typeof raw === 'string' && raw !== '' && !isNaN(Number(raw))) ? Number(raw) : raw;
    return { success: true, name, previous: prev, value: hit.value, scope: scope || 'Stage（全局）' };
  }

  getVariable (args) {
    const name = String(args.variableName || args.name || '');
    const scope = args.spriteName || undefined;
    const { id, existed } = this.store.ensureVariable(name, '', scope);
    if (!existed) return { success: false, error: '变量 "' + name + '" 不存在。先用 list_variables 查看。' };
    const hit = this.store.getVariableValue(id);
    return { success: true, name, value: hit.value, scope: hit.owner.getName() };
  }

  deleteVariable (args) {
    const name = String(args.variableName || args.name || '');
    const scope = args.spriteName || undefined;
    const { id, existed } = this.store.ensureVariable(name, '', scope);
    if (!existed) return { success: false, error: '变量 "' + name + '" 不存在' };
    // 引用检查
    const users = [];
    for (const a of this.store.adapters) {
      const blocks = a.blocks._blocks;
      for (const bid of Object.keys(blocks)) {
        const b = blocks[bid];
        if (b.fields && b.fields.VARIABLE && b.fields.VARIABLE.id === id) users.push(a.getName());
      }
    }
    if (users.length && !args.force) {
      return { success: false, error: '变量 "' + name + '" 仍被以下角色引用: ' + [...new Set(users)].join(', ') + '。确信要删请传 force: true。' };
    }
    for (const a of this.store.adapters) a.deleteVariable(id);
    return { success: true, deleted: name, referencedBy: users.length ? [...new Set(users)] : undefined };
  }

  renameVariable (args) {
    const oldName = String(args.variableName || args.oldName || '');
    const newName = String(args.newName || '').trim();
    const scope = args.spriteName || undefined;
    if (!newName) return { success: false, error: '缺少 newName' };
    const { id, existed } = this.store.ensureVariable(oldName, '', scope);
    if (!existed) return { success: false, error: '变量 "' + oldName + '" 不存在' };
    // 重名检查
    const clash = this.store.ensureVariable(newName, '', scope);
    if (clash.existed && clash.id !== id) return { success: false, error: '已存在名为 "' + newName + '" 的变量/列表' };
    const hit = this.store.getVariableValue(id);
    hit.owner.renameVariable(id, newName);
    return { success: true, oldName, newName };
  }

  listVariables () {
    const out = [];
    const collect = (a, scopeLabel) => {
      Object.keys(a.variables).forEach(id => {
        const v = a.variables[id];
        if (v.type === 'list' || v.type === 'broadcast_msg') return;
        out.push({ name: v.name, value: v.value, scope: scopeLabel });
      });
    };
    collect(this.store.stageAdapter, 'Stage（全局）');
    this.store.listSpriteAdapters().forEach(a => collect(a, a.getName()));
    return { success: true, count: out.length, variables: out };
  }

  getAllVariables () { return this.listVariables(); }

  // 列表
  createList (args) {
    const name = String(args.listName || args.name || '').trim();
    if (!name) return { success: false, error: '缺少 listName' };
    const scope = args.spriteName || undefined;
    const { id, existed } = this.store.ensureVariable(name, 'list', scope);
    if (!existed && Array.isArray(args.items)) {
      const hit = this.store.getVariableValue(id);
      hit.value = args.items.map(x => (typeof x === 'string' && !isNaN(Number(x)) && x !== '') ? Number(x) : x);
    }
    return {
      success: true,
      name,
      scope: scope || 'Stage（全局）',
      existed,
      length: ((this.store.getVariableValue(id) || {}).value || []).length
    };
  }

  getList (args) {
    const name = String(args.listName || args.name || '');
    const scope = args.spriteName || undefined;
    const { id, existed } = this.store.ensureVariable(name, 'list', scope);
    if (!existed) return { success: false, error: '列表 "' + name + '" 不存在。先用 list_lists 查看。' };
    const hit = this.store.getVariableValue(id);
    const items = hit.value || [];
    return { success: true, name, scope: hit.owner.getName(), length: items.length, items };
  }

  listLists () {
    const out = [];
    const collect = (a, scopeLabel) => {
      Object.keys(a.variables).forEach(id => {
        const v = a.variables[id];
        if (v.type !== 'list') return;
        out.push({ name: v.name, length: (v.value || []).length, scope: scopeLabel });
      });
    };
    collect(this.store.stageAdapter, 'Stage（全局）');
    this.store.listSpriteAdapters().forEach(a => collect(a, a.getName()));
    return { success: true, count: out.length, lists: out };
  }

  getAllLists () { return this.listLists(); }

  addToList (args) {
    const name = String(args.listName || args.name || '');
    const scope = args.spriteName || undefined;
    const { id } = this.store.ensureVariable(name, 'list', scope);
    const hit = this.store.getVariableValue(id);
    const item = (typeof args.item === 'string' && !isNaN(Number(args.item)) && args.item !== '') ? Number(args.item) : args.item;
    hit.value.push(item);
    return { success: true, length: hit.value.length, preview: hit.value.slice(0, 8) };
  }

  insertToList (args) {
    const name = String(args.listName || args.name || '');
    const scope = args.spriteName || undefined;
    const { id, existed } = this.store.ensureVariable(name, 'list', scope);
    if (!existed) return { success: false, error: '列表 "' + name + '" 不存在' };
    const hit = this.store.getVariableValue(id);
    const items = hit.value;
    let pos = args.index;
    if (pos === 'first' || pos === undefined) pos = 1;
    if (pos === 'last') pos = items.length + 1;
    pos = Number(pos);
    if (!Number.isFinite(pos) || pos < 1 || pos > items.length + 1) {
      return { success: false, error: 'index 越界: ' + args.index + '（列表长度 ' + items.length + '）' };
    }
    const item = (typeof args.item === 'string' && !isNaN(Number(args.item)) && args.item !== '') ? Number(args.item) : args.item;
    items.splice(pos - 1, 0, item);
    return { success: true, length: items.length, preview: items.slice(0, 8) };
  }

  setListItem (args) {
    const name = String(args.listName || args.name || '');
    const scope = args.spriteName || undefined;
    const { id, existed } = this.store.ensureVariable(name, 'list', scope);
    if (!existed) return { success: false, error: '列表 "' + name + '" 不存在' };
    const hit = this.store.getVariableValue(id);
    const items = hit.value;
    let pos = Number(args.index);
    if (!Number.isFinite(pos) || pos < 1 || pos > items.length) {
      return { success: false, error: 'index 越界: ' + args.index + '（列表长度 ' + items.length + '）' };
    }
    const prev = items[pos - 1];
    const item = (typeof args.item === 'string' && !isNaN(Number(args.item)) && args.item !== '') ? Number(args.item) : args.item;
    items[pos - 1] = item;
    return { success: true, index: pos, previous: prev, value: item };
  }

  deleteFromList (args) {
    const name = String(args.listName || args.name || '');
    const scope = args.spriteName || undefined;
    const { id, existed } = this.store.ensureVariable(name, 'list', scope);
    if (!existed) return { success: false, error: '列表 "' + name + '" 不存在' };
    const hit = this.store.getVariableValue(id);
    const items = hit.value;
    if (args.index === 'all') {
      const n = items.length;
      items.length = 0;
      return { success: true, removed: n, length: 0 };
    }
    let pos = args.index === 'last' ? items.length : Number(args.index);
    if (!Number.isFinite(pos) || pos < 1 || pos > items.length) {
      return { success: false, error: 'index 越界: ' + args.index + '（列表长度 ' + items.length + '）' };
    }
    const [removed] = items.splice(pos - 1, 1);
    return { success: true, removed, length: items.length };
  }

  clearList (args) {
    return this.deleteFromList({ listName: args.listName, spriteName: args.spriteName, index: 'all' });
  }

  // ── 扩展 ─────────────────────────────────────────────────

  getInstalledExtensions () {
    const exts = this.store.project.extensions || [];
    return { success: true, count: exts.length, extensions: exts, aiAdded: this.extensionsAdded };
  }

  installExtension (args) {
    const url = String(args.extension_url || args.extensionId || '');
    if (!url) return { success: false, error: '缺少 extension_url' };
    const id = url.replace(/^\w+:\/\//, '').replace(/\.[a-z]+$/, '').split('/').pop();
    const p = this.store.project;
    p.extensions = p.extensions || [];
    if (p.extensions.indexOf(id) < 0) p.extensions.push(id);
    this.extensionsAdded.push(id);
    return { success: true, extensionId: id, note: '已登记到项目 extensions。CLI 不加载运行时代码，导出后在 TurboWarp/NeoWarp 编辑器中生效。' };
  }

  deleteExtension (args) {
    const key = String(args.extension_id || args.extensionId || args.extension_name || args.extensionName || '');
    const p = this.store.project;
    const exts = p.extensions || [];
    const idx = exts.indexOf(key);
    if (idx < 0) return { success: false, error: '未安装扩展 "' + key + '"' };
    if (this.extensionsAdded.indexOf(key) < 0) {
      return { success: false, error: '只能删除你（AI）通过 install_extension 添加的扩展；"' + key + '" 是内置或用户手动添加的，受保护。' };
    }
    exts.splice(idx, 1);
    this.extensionsAdded = this.extensionsAdded.filter(x => x !== key);
    return { success: true, deleted: key };
  }

  // ── 系统 / 演示 ───────────────────────────────────────────

  getSystemTime () {
    const now = new Date();
    return {
      success: true,
      iso: now.toISOString(),
      local: now.toLocaleString('zh-CN', { hour12: false }),
      timezone: 'UTC' + (-now.getTimezoneOffset() / 60 >= 0 ? '+' : '') + (-now.getTimezoneOffset() / 60)
    };
  }

  getSystemInfo () {
    const os = require('os');
    return {
      success: true,
      platform: os.platform(),
      arch: os.arch(),
      cpus: os.cpus().length,
      memoryGB: Math.round(os.totalmem() / 1073741824 * 10) / 10,
      node: process.version,
      hostname: os.hostname()
    };
  }

  async webSearch (args) {
    const query = String(args.query || '').trim();
    if (!query) return { success: false, error: '缺少 query' };
    try {
      const resp = await fetch('https://api.duckduckgo.com/?q=' + encodeURIComponent(query) + '&format=json&no_html=1&skip_disambig=1', {
        signal: AbortSignal.timeout(8000)
      });
      const j = await resp.json();
      const results = [];
      if (j.AbstractText) results.push({ title: j.Heading || query, text: j.AbstractText, url: j.AbstractURL });
      (j.RelatedTopics || []).slice(0, 5).forEach(t => {
        if (t.Text) results.push({ title: t.Text.slice(0, 60), text: t.Text, url: t.FirstURL });
      });
      if (!results.length) {
        return { success: true, query, results: [], note: 'DuckDuckGo 即时回答无结果。可换关键词重试，或基于已有知识回答。' };
      }
      return { success: true, query, results: results.slice(0, 5) };
    } catch (e) {
      return { success: false, error: '搜索失败（网络不可用）: ' + e.message + '。请基于已有知识回答。' };
    }
  }

  async askUser (args) {
    const question = String(args.question || '请补充说明');
    const options = Array.isArray(args.options) ? args.options.map(String) : [];
    const answer = await this.io.prompt(question, options);
    return { success: true, question, answer };
  }

  // ── 分发入口 ──────────────────────────────────────────────

  async execute (name, args) {
    const fn = this.dispatch[name];
    if (!fn) return { success: false, error: '未知工具: ' + name };
    try {
      return await fn.call(this, args || {});
    } catch (err) {
      return { success: false, error: '工具执行异常: ' + (err.message || String(err)) };
    }
  }
}

ToolBackend.prototype.dispatch = {
  add_script: ToolBackend.prototype.addScript,
  set_scripts: ToolBackend.prototype.setScripts,
  get_sprite_scripts: ToolBackend.prototype.getSpriteScripts,
  execute_operations: ToolBackend.prototype.executeOperations,
  insert_blocks: ToolBackend.prototype.insertBlocks,
  delete_block: ToolBackend.prototype.deleteBlock,
  modify_input: ToolBackend.prototype.modifyInput,
  add_comment: ToolBackend.prototype.addComment,
  delete_comment: ToolBackend.prototype.deleteComment,
  get_project_info: ToolBackend.prototype.getProjectInfo,
  get_project_summary: ToolBackend.prototype.getProjectSummary,
  list_sprites: ToolBackend.prototype.listSprites,
  get_all_sprites: ToolBackend.prototype.listSprites,
  add_sprite: ToolBackend.prototype.addSprite,
  add_sprite_from_library: ToolBackend.prototype.addSprite,
  delete_sprite: ToolBackend.prototype.deleteSprite,
  rename_sprite: ToolBackend.prototype.renameSprite,
  duplicate_sprite: ToolBackend.prototype.duplicateSprite,
  set_sprite_property: ToolBackend.prototype.setSpriteProperty,
  get_sprite_property: ToolBackend.prototype.getSpriteProperty,
  change_costume: ToolBackend.prototype.changeCostume,
  change_backdrop: ToolBackend.prototype.changeBackdrop,
  add_backdrop: ToolBackend.prototype.addBackdrop,
  get_stage_info: ToolBackend.prototype.getStageInfo,
  set_stage_size: ToolBackend.prototype.setStageSize,
  rename_project: ToolBackend.prototype.renameProject,
  create_variable: ToolBackend.prototype.createVariable,
  set_variable: ToolBackend.prototype.setVariable,
  get_variable: ToolBackend.prototype.getVariable,
  delete_variable: ToolBackend.prototype.deleteVariable,
  rename_variable: ToolBackend.prototype.renameVariable,
  list_variables: ToolBackend.prototype.listVariables,
  get_all_variables: ToolBackend.prototype.getAllVariables,
  create_list: ToolBackend.prototype.createList,
  get_list: ToolBackend.prototype.getList,
  list_lists: ToolBackend.prototype.listLists,
  get_all_lists: ToolBackend.prototype.getAllLists,
  add_to_list: ToolBackend.prototype.addToList,
  insert_to_list: ToolBackend.prototype.insertToList,
  set_list_item: ToolBackend.prototype.setListItem,
  delete_from_list: ToolBackend.prototype.deleteFromList,
  clear_list: ToolBackend.prototype.clearList,
  get_installed_extensions: ToolBackend.prototype.getInstalledExtensions,
  install_extension: ToolBackend.prototype.installExtension,
  delete_extension: ToolBackend.prototype.deleteExtension,
  get_system_time: ToolBackend.prototype.getSystemTime,
  get_system_info: ToolBackend.prototype.getSystemInfo,
  web_search: ToolBackend.prototype.webSearch,
  ask_user: ToolBackend.prototype.askUser
};

module.exports = { ToolBackend, makeBlocksContainer };
