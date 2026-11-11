/**
 * NeoWarpAI CLI — 轻量 VM 适配器。
 *
 * 把 project.json 的 target 数据包装成 DSL 引擎（lib/dsl-engine.js，来自
 * desktop-hoc.jsx）所需的鸭子类型接口：
 *   getName / getCostumes / getSounds / isStage / variables / blocks._blocks
 *   lookupVariableByNameAndType / createVariable / lookupBroadcastByInputValue
 *   runtime.getTargetForStage / runtime.targets
 *
 * 语义与 scratch-vm 对齐：
 *  - 变量/列表/广播消息在 project.json 中分别落在 variables / broadcasts 字段，
 *    序列化时按 scratch-vm 规则还原
 *  - $name / @name / 广播名不存在时自动在 Stage 上创建（与提示词承诺一致）
 */
'use strict';

const ENGINE = require('./dsl-engine');

function genId (prefix) {
  return prefix + Math.random().toString(36).slice(2, 10);
}

/** 把 project.json 的一个 target 转成运行时形状并包一层适配器。 */
function adaptTarget (data, projectRef) {
  const isStage = !!data.isStage;
  const runtimeVars = {}; // {id: {name, value, type}}
  // project.json: variables: {id: [name, value]}，列表值是数组；broadcasts: {id: name}
  Object.keys(data.variables || {}).forEach(id => {
    const [name, value] = data.variables[id];
    runtimeVars[id] = { name, value, type: Array.isArray(value) ? 'list' : '' };
  });
  const broadcasts = Object.assign({}, data.broadcasts || {});

  const store = { _blocks: data.blocks || {} };
  const comments = data.comments || {};

  const adapter = {
    // ── 数据 ──
    __data: data,
    isStage,
    isOriginal: true,
    variables: runtimeVars,
    blocks: store,
    comments,

    // ── DSL 引擎鸭子类型接口 ──
    getName () { return data.name; },
    getCostumes () { return data.costumes || []; },
    getSounds () { return data.sounds || []; },
    lookupVariableByNameAndType (name, type) {
      // 先本 target，再回退 Stage（与 Scratch 读取顺序一致）
      const wanted = type || '';
      for (const id of Object.keys(runtimeVars)) {
        const v = runtimeVars[id];
        if (v.name === name && (v.type || '') === wanted) return { id, name: v.name, value: v.value, type: v.type };
      }
      const stage = getStage();
      if (stage && stage !== adapter) return stage.lookupVariableByNameAndType(name, type);
      return null;
    },
    lookupBroadcastByInputValue (name) {
      for (const id of Object.keys(broadcasts)) {
        if (broadcasts[id] === name) return { id, name: broadcasts[id] };
      }
      return null;
    },
    createVariable (id, name, type) {
      const t = type || '';
      if (t === 'broadcast_msg') {
        broadcasts[id] = name;
        return;
      }
      runtimeVars[id] = { name, value: t === 'list' ? [] : 0, type: t };
    },
    renameVariable (id, newName) {
      if (runtimeVars[id]) runtimeVars[id].name = newName;
    },
    deleteVariable (id) {
      delete runtimeVars[id];
      delete broadcasts[id];
    },
    getAllVariableNamesInScopeByType (type) {
      const wanted = type === 'list' ? 'list' : '';
      const names = [];
      const collect = (t) => {
        Object.keys(t.variables).forEach(id => {
          const v = t.variables[id];
          if ((v.type || '') === wanted) names.push(v.name);
        });
      };
      const stage = getStage();
      if (stage) collect(stage);
      if (stage !== adapter) collect(adapter);
      return names;
    }
  };

  function getStage () {
    return projectRef.stageAdapter || adapter;
  }

  return adapter;
}

/**
 * 项目容器：持有 project.json 的内存表示，向工具层提供
 * 按名取 target、适配器集合与序列化。
 */
class ProjectStore {
  constructor (project, assets, sourcePath) {
    this.project = project;
    this.assets = assets || [];
    this.sourcePath = sourcePath || null;
    this.adapters = [];
    this.stageAdapter = null;
    for (const t of project.targets) {
      const a = adaptTarget(t, this);
      this.adapters.push(a);
      if (t.isStage) this.stageAdapter = a;
    }
    // 适配器闭包引用 stageAdapter（adaptTarget 时可能尚未建立，这里补挂）
    // 适配器通过 projectRef.getStage 闭包调用本对象的 stageAdapter。
  }

  /** 按名查找 target 适配器（大小写敏感，与编辑器上下文 tids 约定一致）。 */
  findTarget (name) {
    if (!name) return this.stageAdapter;
    const lower = String(name).toLowerCase();
    return this.adapters.find(a => a.getName().toLowerCase() === lower &&
      (a.isStage ? String(name).toLowerCase() === 'stage' : true)) ||
      this.adapters.find(a => !a.isStage && a.getName().toLowerCase() === lower) || null;
  }

  listSpriteAdapters () {
    return this.adapters.filter(a => !a.isStage);
  }

  /** 新建空精灵。 */
  addSprite (name) {
    let finalName = name;
    let n = 2;
    while (this.findTarget(finalName)) finalName = name + n++;
    const data = {
      isStage: false,
      name: finalName,
      variables: {},
      broadcasts: {},
      blocks: {},
      comments: {},
      currentCostume: 0,
      costumes: [{
        name: 'costume1', dataFormat: 'svg', assetId: 'bcf454acf82e4504149f7ffe07081dbc',
        md5ext: 'bcf454acf82e4504149f7ffe07081dbc.svg', rotationCenterX: 48, rotationCenterY: 50
      }],
      sounds: [],
      volume: 100,
      layerOrder: this.project.targets.length,
      visible: true,
      x: 0, y: 0,
      size: 100,
      direction: 90,
      draggable: false,
      rotationStyle: 'all around'
    };
    this.project.targets.push(data);
    const a = adaptTarget(data, this);
    this.adapters.push(a);
    return a;
  }

  deleteSprite (name) {
    const idx = this.project.targets.findIndex(t => !t.isStage && t.name === name);
    if (idx < 0) return false;
    this.project.targets.splice(idx, 1);
    const ai = this.adapters.findIndex(a => !a.isStage && a.getName() === name);
    if (ai >= 0) this.adapters.splice(ai, 1);
    // 重排 layerOrder
    this.project.targets.forEach((t, i) => { t.layerOrder = i; });
    return true;
  }

  /** 查找或创建变量（返回 {id, existed}）。 */
  ensureVariable (name, type, scopeName) {
    const owner = scopeName ? this.findTarget(scopeName) : this.stageAdapter;
    const wanted = type === 'list' ? 'list' : '';
    let hit = null;
    const searchIn = (a) => {
      for (const id of Object.keys(a.variables)) {
        const v = a.variables[id];
        if (v.name === name && (v.type || '') === wanted) return { id, v };
      }
      return null;
    };
    if (owner) hit = searchIn(owner);
    if (!hit) {
      const other = owner === this.stageAdapter ? null : this.stageAdapter;
      if (other) hit = searchIn(other);
    }
    if (hit) return { id: hit.id, owner: null, existed: true };
    const target = owner || this.stageAdapter;
    const id = genId('clivar_');
    target.createVariable(id, name, wanted);
    return { id, owner: target, existed: false };
  }

  /** 按 id 读变量值。 */
  getVariableValue (id) {
    for (const a of this.adapters) {
      if (a.variables[id]) return { value: a.variables[id].value, owner: a };
    }
    return null;
  }

  /** 序列化回 project.json 形状（写盘前调用）。 */
  flush () {
    for (const a of this.adapters) {
      const d = a.__data;
      d.blocks = a.blocks._blocks;
      d.comments = a.comments;
      const vars = {};
      const bcasts = {};
      for (const id of Object.keys(a.variables)) {
        const v = a.variables[id];
        if (v.type === 'broadcast_msg') { bcasts[id] = v.name; continue; }
        vars[id] = [v.name, v.value];
      }
      d.variables = vars;
      // 广播消息合并（保留原有未在运行时形状中出现的）
      const mergedB = Object.assign({}, bcasts);
      Object.keys(d.broadcasts || {}).forEach(id => {
        if (!mergedB[id]) mergedB[id] = d.broadcasts[id];
      });
      d.broadcasts = mergedB;
    }
    return this.project;
  }
}

module.exports = { ProjectStore, adaptTarget, ENGINE, genId };
