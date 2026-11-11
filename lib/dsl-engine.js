/**
 * NeoWarp AI 积木 DSL 引擎 — 由 scripts/extract-dsl-engine.js 自动生成。
 * 来源：NeoWarp src-renderer-webpack/editor/gui/desktop-hoc.jsx 顶层函数，
 * 与上游 test-dsl-roundtrip.js 使用同一提取方式，保证 CLI 与编辑器行为一致。
 * 请勿手改本文件；上游更新后重新运行提取脚本。
 */
'use strict';

let mountedOnce = false;
let isStageDetached = false;
let frameStreamingActive = false;
let frameAnimationId = null;
let aiListenersRegistered = false;
// SOLO：后台编辑器把舞台画面流转发给 SOLO 窗口的开关（独立于 detach 舞台）
let soloStreamActive = false;
let soloStreamTimer = null;

/**
 * @param {string} filename
 * @returns {string}
 */
const getDefaultProjectTitle = (filename) => {
  const match = filename.match(/([^/\\]+)\.(?:sb[2|3]?|np1|npnp|viewsb3)$/);
  if (!match) return filename;
  return match[1];
};

function hashCode(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0;
  }
  return hash;
}

// NeoWarp: Collaboration — a project's JSON only references costumes, backdrops
// and sounds by md5. A peer that loads that JSON cannot resolve the host's
// uploaded assets (they are not on the public asset CDN), so every asset shows
// up empty. Collaborators therefore exchange the full .sb3 archive, which
// embeds all assets, base64-encoded inside the existing JSON message.
const COLLAB_PROJECT_FORMAT = 'sb3';

const arrayBufferToBase64 = (buffer) => {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
};

const base64ToArrayBuffer = (base64) => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
};

// ===== Collaboration: incremental project sync helpers =====
//
// Remote updates used to be applied with vm.loadProject(), which tears down
// and rebuilds every target: the whole editor visibly "reloads", all running
// scripts stop and the editing target resets on every single edit any peer
// makes. Instead, received projects are diffed against the local state and
// applied per sprite: only changed sprites are rebuilt in place, pure
// position/pose changes are merged onto the live target, monitors are synced
// through the runtime's monitor API, and a full reload remains only for
// stage-level/global changes. When a rebuild of the script workspace is
// needed, it is deferred while the user is dragging or editing a field, so
// remote updates land without visible flashes and without interrupting.

// Target fields that change while scripts run (dragging on stage, switching
// costume tabs, volume). They are synced, but must not be treated as a
// structural edit that requires rebuilding the target.
const COLLAB_SPRITE_RUNTIME_PROPS = [
  'x', 'y', 'size', 'direction', 'visible', 'draggable',
  'rotationStyle', 'currentCostume', 'volume'
];

const collabStableStringify = value => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(collabStableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map(key => `${JSON.stringify(key)}:${collabStableStringify(value[key])}`).join(',')}}`;
};

// Strip runtime-only data from sb3 target JSON: variable/list values are
// written by running scripts all the time and are not part of a structural
// edit, so they must not make two structurally identical sprites differ.
const collabNormalizeTarget = (targetJson, isStage) => {
  const normalized = JSON.parse(collabStableStringify(targetJson));
  const stripValues = record => {
    const copy = {};
    for (const id of Object.keys(record || {})) {
      const entry = record[id];
      // [name, value, ...flags] — keep the name and flags, drop the value
      copy[id] = Array.isArray(entry) ? entry.slice(0, 1).concat(entry.slice(2)) : entry;
    }
    return copy;
  };
  normalized.variables = stripValues(normalized.variables);
  normalized.lists = stripValues(normalized.lists);
  if (isStage) {
    // Stage fields scripts mutate while running (tempo, video settings…)
    for (const key of ['tempo', 'videoState', 'videoTransparency', 'textToSpeechLanguage', 'volume']) {
      delete normalized[key];
    }
  }
  return normalized;
};

const collabSpritesEqual = (localJson, remoteJson) =>
  collabStableStringify(collabNormalizeTarget(localJson, localJson.isStage)) ===
  collabStableStringify(collabNormalizeTarget(remoteJson, remoteJson.isStage));

// True when the two sprites differ only in runtime props (drag, costume tab,
// volume…): those can be merged onto the live target without rebuilding it.
const collabSpriteRuntimePropsOnly = (localJson, remoteJson) => {
  const stripProps = json => {
    const copy = collabNormalizeTarget(json, json.isStage);
    for (const prop of COLLAB_SPRITE_RUNTIME_PROPS) delete copy[prop];
    return copy;
  };
  if (collabStableStringify(stripProps(localJson)) !== collabStableStringify(stripProps(remoteJson))) {
    return false;
  }
  return COLLAB_SPRITE_RUNTIME_PROPS.some(prop =>
    JSON.stringify(localJson[prop]) !== JSON.stringify(remoteJson[prop]));
};

// Monitors diff. Every serialized monitor field maps onto a MonitorRecord
// property, so monitor differences never require a full project reload; this
// returns the per-record operations to apply to the runtime monitor state.
// The serialized `value` is a placeholder, so it is ignored when comparing.
const collabMonitorRecordShape = record => {
  const copy = {...record};
  delete copy.value;
  return copy;
};

const collabMonitorChanges = (localMonitors, remoteMonitors) => {
  const localById = new Map((localMonitors || []).map(record => [record.id, record]));
  const remoteById = new Map((remoteMonitors || []).map(record => [record.id, record]));
  const additions = [];
  const updates = [];
  const deletions = [];
  for (const [id, remote] of remoteById) {
    const local = localById.get(id);
    if (!local) {
      additions.push(remote);
      continue;
    }
    if (collabStableStringify(collabMonitorRecordShape(local)) !==
        collabStableStringify(collabMonitorRecordShape(remote))) {
      updates.push(remote);
    }
  }
  for (const [id] of localById) {
    if (!remoteById.has(id)) deletions.push(id);
  }
  return {additions, updates, deletions};
};

// Stage structural diff. Peers create variables, lists and broadcast messages
// all the time while editing; when that is the ONLY stage change it is applied
// in place: {additions, deletions}. Any other stage change (backdrops, stage
// blocks, comments, renames, cloud variable removal…) needs a full reload and
// returns null.
const collabStageChanges = (localStageJson, remoteStageJson) => {
  // Any difference outside the variable records cannot be applied in place
  const stripVariables = stageJson => {
    const copy = collabNormalizeTarget(stageJson, true);
    delete copy.variables;
    delete copy.lists;
    delete copy.broadcasts;
    return copy;
  };
  if (collabStableStringify(stripVariables(localStageJson)) !==
      collabStableStringify(stripVariables(remoteStageJson))) {
    return null;
  }
  const kinds = [
    ['variables', ''],
    ['lists', 'list'],
    ['broadcasts', 'broadcast_msg']
  ];
  const additions = [];
  const deletions = [];
  for (const [field, type] of kinds) {
    const localRecord = localStageJson[field] || {};
    const remoteRecord = remoteStageJson[field] || {};
    for (const id of Object.keys(remoteRecord)) {
      const entry = remoteRecord[id];
      if (Object.prototype.hasOwnProperty.call(localRecord, id)) {
        const localEntry = Array.isArray(localRecord[id])
          ? localRecord[id].slice(0, 1).concat(localRecord[id].slice(2))
          : localRecord[id];
        const remoteEntry = Array.isArray(entry) ? entry.slice(0, 1).concat(entry.slice(2)) : entry;
        if (JSON.stringify(localEntry) !== JSON.stringify(remoteEntry)) return null; // renamed
      } else {
        additions.push({
          id,
          field,
          name: Array.isArray(entry) ? entry[0] : entry,
          type,
          isCloud: Array.isArray(entry) && entry[2] === true
        });
      }
    }
    for (const id of Object.keys(localRecord)) {
      if (Object.prototype.hasOwnProperty.call(remoteRecord, id)) continue;
      const entry = localRecord[id];
      if (field === 'variables' && Array.isArray(entry) && entry[2] === true) {
        // Cloud variable bookkeeping lives in the runtime; don't remove here
        return null;
      }
      deletions.push({id, field});
    }
  }
  return {additions, deletions};
};

const handleClickAddonSettings = (search) => {
  EditorPreload.openAddonSettings(typeof search === 'string' ? search : null);
};

const handleClickNewWindow = () => {
  EditorPreload.openNewWindow();
};

const handleClickPackager = () => {
  EditorPreload.openPackager();
};

const handleClickDesktopSettings = () => {
  EditorPreload.openDesktopSettings();
};

const handleClickPrivacy = () => {
  EditorPreload.openPrivacy();
};

const handleClickAbout = () => {
  EditorPreload.openAbout();
};

const handleClickContact = () => {
  EditorPreload.openContact();
};

const handleClickAI = () => {
  EditorPreload.openAI();
};

const handleClickTodoList = () => {
  EditorPreload.openTodoList();
};

const handleClickProjectAnalysis = () => {
  EditorPreload.openProjectAnalysis();
};

const handleClickMobilePreview = () => {
  EditorPreload.openMobilePreview();
};

const handleClickSourceCode = () => {
  window.open('https://github.com/Shiyuan-318/Neowarp');
};

const handleClickFeedback = () => {
  window.open('https://github.com/Shiyuan-318/Neowarp/issues');
};

const handleDetachStage = (vm) => {
  let stageWidth = 480;
  let stageHeight = 360;
  try {
    if (vm && vm.runtime && vm.runtime.renderer) {
      stageWidth = vm.runtime.renderer._width || stageWidth;
      stageHeight = vm.runtime.renderer._height || stageHeight;
    }
  } catch (e) {
    // ignore - fall back to defaults
  }
  EditorPreload.detachStage(stageWidth, stageHeight);
};

const handleReattachStage = () => {
  EditorPreload.reattachStage();
};

const handleClickCollaborationHost = () => {
  EditorPreload.openCollaborationHost();
};

const handleClickCollaborationJoin = () => {
  EditorPreload.openCollaborationJoin();
};

const handleClickCollaborationChat = () => {
  EditorPreload.openCollaborationChat();
};

const handleClickEndCollaboration = () => {
  EditorPreload.endCollaboration();
};

const handleClickLeaveCollaboration = () => {
  EditorPreload.leaveCollaboration();
};

const startFrameStreaming = (vm) => {
  if (frameStreamingActive) return;
  frameStreamingActive = true;

  const streamFrame = () => {
    if (!frameStreamingActive || !isStageDetached) return;
    try {
      if (vm.renderer && vm.renderer.requestSnapshot) {
        // Use the renderer's built-in snapshot API
        // This properly handles preserveDrawingBuffer and renders the frame
        vm.renderer.requestSnapshot((dataURL) => {
          if (frameStreamingActive && isStageDetached) {
            EditorPreload.sendStageFrame(dataURL);
          }
        });
      }
    } catch (e) {
      // ignore
    }
    frameAnimationId = setTimeout(streamFrame, 33);
  };
  streamFrame();
};

const stopFrameStreaming = () => {
  frameStreamingActive = false;
  if (frameAnimationId !== null) {
    clearTimeout(frameAnimationId);
    frameAnimationId = null;
  }
};

/* ── SOLO 舞台画面流 ──
   与 detach 舞台的流式推送相互独立：SOLO 只要求画面（预览缩略图 + 弹出的
   舞台窗口），编辑器本体隐藏与否都不影响。帧率取较低值（~8fps），
   足够看动画效果又不会让隐藏窗口的 CPU 占用明显上升。 */
let soloQuestion = null; // 当前待回答的提问文本；null 表示没有提问

// 常用非变量类监视器的标签（与 Scratch 界面用词一致），不在表内的用 opcode 兜底
const SOLO_MONITOR_LABELS = {
  motion_xposition: 'x position',
  motion_yposition: 'y position',
  motion_direction: 'direction',
  looks_costumenumbername: 'costume #',
  looks_backdropnumbername: 'backdrop #',
  looks_size: 'size',
  sensing_timer: 'timer',
  sensing_loudness: 'loudness',
  sensing_dayssince2000: 'days since 2000',
  sensing_username: 'username',
  sound_volume: 'volume'
};

// 列表监视器最多推送的条目数（防超大列表每帧序列化撑爆 IPC）
const SOLO_LIST_MAX_ITEMS = 50;
// 单个值字符串的推送上限
const SOLO_VALUE_MAX_CHARS = 200;

const soloClipValue = (value) => {
  const str = String(value);
  return str.length > SOLO_VALUE_MAX_CHARS ? str.slice(0, SOLO_VALUE_MAX_CHARS) + '…' : str;
};

/**
 * 收集舞台上的变量/列表监视器与提问框状态。
 * 这些都是 scratch-gui 的 DOM 覆盖层，canvas 快照拍不到，必须单独序列化。
 */
const getSoloStageOverlays = (vm) => {
  const monitors = [];
  try {
    const state = vm.runtime && vm.runtime._monitorState;
    if (state && state.map) {
      state.map.forEach((rec, id) => {
        if (!rec || rec.visible === false) return;
        const params = rec.params || {};
        let label;
        if (rec.opcode === 'data_variable') {
          label = (rec.spriteName ? rec.spriteName + ': ' : '') + (params.VARIABLE || '');
        } else if (rec.opcode === 'data_list') {
          label = (rec.spriteName ? rec.spriteName + ': ' : '') + (params.LIST || '');
        } else if (rec.opcode === 'sensing_current') {
          label = String(params.CURRENTMENU || '').toLowerCase();
        } else if (SOLO_MONITOR_LABELS[rec.opcode]) {
          label = SOLO_MONITOR_LABELS[rec.opcode];
        } else if (params.PROPERTY && rec.opcode === 'sensing_of') {
          label = (params.OBJECT && params.OBJECT !== '_stage_' ? params.OBJECT + ': ' : '') + params.PROPERTY;
        } else {
          label = String(rec.opcode || '').replace(/^[a-z]+_/, '').replace(/_/g, ' ');
        }
        const isList = (rec.mode || 'default') === 'list';
        let value = rec.value;
        let listTotal = 0;
        if (isList && Array.isArray(value)) {
          listTotal = value.length;
          value = value.slice(0, SOLO_LIST_MAX_ITEMS).map(soloClipValue);
        } else if (isList) {
          value = [];
        } else {
          value = soloClipValue(value);
        }
        // 每帧全量推送；舞台端按 id 复用 DOM 元素，只在列表内容真正变化时
        // 才重绘行（滚动位置得以保留），这里不做变化过滤
        monitors.push({
          id,
          mode: rec.mode || 'default',
          label,
          value,
          listTotal,
          x: typeof rec.x === 'number' ? rec.x : null,
          y: typeof rec.y === 'number' ? rec.y : null,
          width: rec.width || 0
        });
      });
    }
  } catch (e) {
    // 监视器状态读取失败不阻塞画面流
  }
  return {
    monitors,
    prompt: soloQuestion === null ? null : { question: soloQuestion }
  };
};

const startSoloStream = (vm) => {
  if (soloStreamActive) return;
  soloStreamActive = true;
  // 监视器/提问是 DOM 覆盖层，canvas 快照拍不到；在这里顺带监听并随帧推送。
  // VM 换工程后会换实例，绑定标记挂在 runtime 上保证每个实例只绑一次
  try {
    if (vm.runtime && !vm.runtime.__soloOverlaysBound) {
      vm.runtime.__soloOverlaysBound = true;
      vm.runtime.on('QUESTION', (question) => {
        soloQuestion = question === null || typeof question === 'undefined' ? null : String(question);
      });
      vm.runtime.on('PROJECT_STOP_ALL', () => {
        soloQuestion = null;
      });
    }
  } catch (e) {
    // ignore - 事件绑定失败只影响监视器/提问显示
  }
  const streamFrame = () => {
    if (!soloStreamActive) return;
    try {
      if (vm.renderer && vm.renderer.requestSnapshot) {
        vm.renderer.requestSnapshot((dataURL) => {
          if (soloStreamActive) {
            EditorPreload.sendSoloStageFrame(dataURL);
            try {
              EditorPreload.sendSoloStageOverlays(getSoloStageOverlays(vm));
            } catch (e) {
              // ignore - 覆盖层收集失败不阻塞画面
            }
          }
        });
      }
    } catch (e) {
      // ignore - 编辑器窗口可能在关闭过程中
    }
    soloStreamTimer = setTimeout(streamFrame, 125);
  };
  streamFrame();
};

const stopSoloStream = () => {
  soloStreamActive = false;
  soloQuestion = null;
  if (soloStreamTimer !== null) {
    clearTimeout(soloStreamTimer);
    soloStreamTimer = null;
  }
};

/* AI 工具的「工程就绪」门：SOLO 用隐藏编辑器作工程宿主，create_project/
   adoptProject 刚挂上工程那几秒里，页面虽已挂载、VM 却还在异步加载（实测
   3~8 秒）。这期间工具要么"立即成功但读到空工程"（AI 误判新工程为空），
   要么干等主进程 30 秒超时（AI 读不到新项目）。因此 VM 类工具执行前先等
   runtime 出现原始 target：deserializeProject 一开始就清空 targets，
   全部装完才发 PROJECT_LOADED，所以"有 isOriginal 的 target"⇔ 已加载完。 */
const AI_TOOLS_NOT_REQUIRING_PROJECT = [
  // 这些工具不读工程数据（宿主信息 / AI 侧快照登记 / 联网搜索），不用等加载
  'getSystemTime',
  'getSystemInfo',
  'searchExtensions',
  'getSpriteLibrary',
  'hasProjectSnapshot',
  'dropProjectSnapshot'
];

/**
 * 等 VM 把工程真正加载完。返回 null 表示已就绪、调用方可继续执行工具；
 * 返回对象则代表放弃等待（超时），调用方应把它作为工具结果直接回给主进程，
 * 给 AI 一个明确的"工程还没加载好"信号而不是空数据或哑超时。
 * @param {VM} vm
 * @param {number} timeoutMs 最长等待毫秒数
 * @returns {Promise<{success: boolean, error: string}|null>}
 */
const waitProjectReadyForTools = (vm, timeoutMs) => new Promise(resolve => {
  const isReady = () => {
    try {
      const targets = vm.runtime && vm.runtime.targets;
      return Array.isArray(targets) && targets.some(t => t && t.isOriginal);
    } catch (e) {
      // 状态读不出来就不拦工具，保持原有行为
      return true;
    }
  };
  if (isReady()) {
    resolve(null);
    return;
  }
  let finished = false;
  let pollTimer = null;
  let loadedHandler = null;
  const finish = result => {
    if (finished) return;
    finished = true;
    if (pollTimer) clearTimeout(pollTimer);
    try {
      if (loadedHandler) vm.runtime.off('PROJECT_LOADED', loadedHandler);
    } catch (e) {
      // ignore - 监听器解绑失败不影响结果
    }
    resolve(result);
  };
  // PROJECT_LOADED 恰在 targets 安装完时发出，事件到达比轮询更及时
  try {
    loadedHandler = () => finish(null);
    vm.runtime.on('PROJECT_LOADED', loadedHandler);
  } catch (e) {
    loadedHandler = null; // 挂不上监听就纯靠轮询
  }
  const deadline = Date.now() + timeoutMs;
  const poll = () => {
    if (finished) return;
    if (isReady()) {
      finish(null);
      return;
    }
    if (Date.now() >= deadline) {
      finish({
        success: false,
        error: 'Project is still loading (or failed to load). Please wait a few seconds and retry.'
      });
      return;
    }
    pollTimer = setTimeout(poll, 200);
  };
  poll();
});

/* SOLO 舞台控制：绿旗 = 重头运行；暂停/继续 = 直接停/启 VM 的帧循环
   （scratch-vm 的 FrameLoop，stop 后所有线程原样冻结，start 后接着跑）。 */
const handleSoloStageControl = (vm, action) => {
  try {
    if (action === 'greenFlag') {
      if (vm.runtime && vm.runtime.frameLoop && vm.runtime.frameLoop.running === false) {
        vm.runtime.start();
      }
      vm.greenFlag();
      return { success: true, running: true };
    }
    if (action === 'pause') {
      if (vm.runtime && vm.runtime.frameLoop && vm.runtime.frameLoop.running) {
        vm.runtime.frameLoop.stop();
      }
      return { success: true, running: false };
    }
    if (action === 'resume') {
      if (vm.runtime && vm.runtime.frameLoop && vm.runtime.frameLoop.running === false) {
        vm.runtime.start();
      }
      return { success: true, running: true };
    }
    if (action === 'stop') {
      if (vm.runtime && vm.runtime.frameLoop && vm.runtime.frameLoop.running === false) {
        vm.runtime.start();
      }
      vm.stopAll();
      return { success: true, running: false };
    }
    if (action === 'getState') {
      // "在运行" = 帧循环转着且还有活线程；stopAll 后线程清空，
      // 按此判断按钮能正确回到"未运行"档位
      const loopRunning = !!(vm.runtime && vm.runtime.frameLoop && vm.runtime.frameLoop.running);
      const hasThreads = !!(vm.runtime && vm.runtime.threads && vm.runtime.threads.length > 0);
      return { success: true, running: loopRunning && hasThreads };
    }
    return { success: false, error: 'Unknown action: ' + action };
  } catch (e) {
    return { success: false, error: (e && e.message) || String(e) };
  }
};

const handleDetachedStageInput = (vm, inputData) => {
  try {
    if (inputData.type === 'mousedown' || inputData.type === 'mouseup' || inputData.type === 'mousemove') {
      const data = {
        x: inputData.x,
        y: inputData.y,
        canvasWidth: inputData.canvasWidth || 480,
        canvasHeight: inputData.canvasHeight || 360
      };
      if (inputData.type === 'mousedown') {
        data.isDown = true;
        data.button = inputData.button || 0;
      } else if (inputData.type === 'mouseup') {
        data.isDown = false;
        data.button = inputData.button || 0;
      }
      vm.postIOData('mouse', data);
    } else if (inputData.type === 'wheel') {
      vm.postIOData('mouseWheel', {
        deltaX: inputData.deltaX,
        deltaY: inputData.deltaY
      });
    } else if (inputData.type === 'keydown') {
      vm.postIOData('keyboard', {
        key: inputData.key,
        code: inputData.code,
        isDown: true
      });
    } else if (inputData.type === 'keyup') {
      vm.postIOData('keyboard', {
        key: inputData.key,
        code: inputData.code,
        isDown: false
      });
    }
  } catch (e) {
    // ignore
  }
};

const securityManager = {
  // Everything not specified here falls back to the scratch-gui security manager

  // Managed by Electron main process:
  canReadClipboard: () => true,
  canNotify: () => true,

  // Does not work in Electron:
  canGeolocate: () => false
};

const USERNAME_KEY = 'tw:username';
const DEFAULT_USERNAME = 'player';

// Schema mapping each Scratch opcode to its parameter layout.
// args: array of {name, kind} where kind is 'input' or 'field', in visual order.
// substack: true for C-shaped blocks; substack2: true for control_if_else.
// 每个 opcode 的参数布局，直接对齐 scratch-blocks 的 args0 定义（顺序、名称、字段/输入类型）。
// DSL 是位置式的：parseDslLine 产出的 token 按下标落到这里声明的槽位上，所以顺序错一位
// 就会把值写进相邻参数（例如 data_addtolist 真实顺序是 ITEM,LIST，写成 LIST,ITEM 会把
// 数字当成列表名）。这张表由 scripts/gen-opcode-schema.js 从 scratch-blocks 生成，勿手改顺序。
//   kind: input  普通输入槽，shadow 指明 Scratch 给它的默认影子块类型
//   kind: field  下拉/变量字段，值直接写进 block.fields
//   kind: menu   看着像下拉、实际是带菜单影子块的输入槽（可插入 reporter）
//   bool: true   布尔（六边形）输入，没有影子块
//   optionalBody: true  C 形块允许空 body（如单独的 control_stop "all"），不发 empty body 警告
// argument_reporter_* 是自定义积木的参数报告器：VALUE 是字段（参数名），不是输入槽。
const OPCODE_SCHEMA = {
  argument_reporter_boolean: { args: [{ name: 'VALUE', kind: 'field' }] },
  argument_reporter_string_number: { args: [{ name: 'VALUE', kind: 'field' }] },
  control_all_at_once: { args: [], substack: true },
  control_clear_counter: { args: [] },
  control_create_clone_of: { args: [{ name: 'CLONE_OPTION', kind: 'menu', shadow: 'control_create_clone_of_menu', menuField: 'CLONE_OPTION' }] },
  control_delete_this_clone: { args: [] },
  control_for_each: { args: [{ name: 'VARIABLE', kind: 'field' }, { name: 'VALUE', kind: 'input', shadow: 'math_whole_number' }], substack: true },
  control_forever: { args: [], substack: true },
  control_get_counter: { args: [] },
  control_if: { args: [{ name: 'CONDITION', kind: 'input', bool: true }], substack: true },
  control_if_else: { args: [{ name: 'CONDITION', kind: 'input', bool: true }], substack: true, substack2: true },
  control_incr_counter: { args: [] },
  control_repeat: { args: [{ name: 'TIMES', kind: 'input', shadow: 'math_whole_number' }], substack: true },
  control_repeat_until: { args: [{ name: 'CONDITION', kind: 'input', bool: true }], substack: true },
  control_start_as_clone: { args: [] },
  control_stop: { args: [{ name: 'STOP_OPTION', kind: 'field' }], substack: true, optionalBody: true },
  control_wait: { args: [{ name: 'DURATION', kind: 'input', shadow: 'math_positive_number' }] },
  control_wait_until: { args: [{ name: 'CONDITION', kind: 'input', bool: true }] },
  control_while: { args: [{ name: 'CONDITION', kind: 'input', bool: true }], substack: true },
  data_addtolist: { args: [{ name: 'ITEM', kind: 'input', shadow: 'text' }, { name: 'LIST', kind: 'field' }] },
  data_changevariableby: { args: [{ name: 'VARIABLE', kind: 'field' }, { name: 'VALUE', kind: 'input', shadow: 'math_number' }] },
  data_deletealloflist: { args: [{ name: 'LIST', kind: 'field' }] },
  data_deleteoflist: { args: [{ name: 'INDEX', kind: 'input', shadow: 'math_integer' }, { name: 'LIST', kind: 'field' }] },
  data_hidelist: { args: [{ name: 'LIST', kind: 'field' }] },
  data_hidevariable: { args: [{ name: 'VARIABLE', kind: 'field' }] },
  data_insertatlist: { args: [{ name: 'ITEM', kind: 'input', shadow: 'text' }, { name: 'INDEX', kind: 'input', shadow: 'math_integer' }, { name: 'LIST', kind: 'field' }] },
  data_itemnumoflist: { args: [{ name: 'ITEM', kind: 'input', shadow: 'text' }, { name: 'LIST', kind: 'field' }] },
  data_itemoflist: { args: [{ name: 'INDEX', kind: 'input', shadow: 'math_integer' }, { name: 'LIST', kind: 'field' }] },
  data_lengthoflist: { args: [{ name: 'LIST', kind: 'field' }] },
  data_listcontainsitem: { args: [{ name: 'LIST', kind: 'field' }, { name: 'ITEM', kind: 'input', shadow: 'text' }] },
  data_replaceitemoflist: { args: [{ name: 'INDEX', kind: 'input', shadow: 'math_integer' }, { name: 'LIST', kind: 'field' }, { name: 'ITEM', kind: 'input', shadow: 'text' }] },
  data_setvariableto: { args: [{ name: 'VARIABLE', kind: 'field' }, { name: 'VALUE', kind: 'input', shadow: 'text' }] },
  data_showlist: { args: [{ name: 'LIST', kind: 'field' }] },
  data_showvariable: { args: [{ name: 'VARIABLE', kind: 'field' }] },
  event_broadcast: { args: [{ name: 'BROADCAST_INPUT', kind: 'menu', shadow: 'event_broadcast_menu', menuField: 'BROADCAST_OPTION' }] },
  event_broadcastandwait: { args: [{ name: 'BROADCAST_INPUT', kind: 'menu', shadow: 'event_broadcast_menu', menuField: 'BROADCAST_OPTION' }] },
  event_whenbackdropswitchesto: { args: [{ name: 'BACKDROP', kind: 'field' }] },
  event_whenbroadcastreceived: { args: [{ name: 'BROADCAST_OPTION', kind: 'field' }] },
  event_whenflagclicked: { args: [] },
  event_whengreaterthan: { args: [{ name: 'WHENGREATERTHANMENU', kind: 'field' }, { name: 'VALUE', kind: 'input', shadow: 'math_number' }] },
  event_whenkeypressed: { args: [{ name: 'KEY_OPTION', kind: 'field' }] },
  event_whenstageclicked: { args: [] },
  event_whenthisspriteclicked: { args: [] },
  looks_backdropnumbername: { args: [{ name: 'NUMBER_NAME', kind: 'field' }] },
  looks_changeeffectby: { args: [{ name: 'EFFECT', kind: 'field' }, { name: 'CHANGE', kind: 'input', shadow: 'math_number' }] },
  looks_changesizeby: { args: [{ name: 'CHANGE', kind: 'input', shadow: 'math_number' }] },
  looks_changestretchby: { args: [{ name: 'CHANGE', kind: 'input', shadow: 'math_number' }] },
  looks_cleargraphiceffects: { args: [] },
  looks_costumenumbername: { args: [{ name: 'NUMBER_NAME', kind: 'field' }] },
  looks_goforwardbackwardlayers: { args: [{ name: 'FORWARD_BACKWARD', kind: 'field' }, { name: 'NUM', kind: 'input', shadow: 'math_integer' }] },
  looks_gotofrontback: { args: [{ name: 'FRONT_BACK', kind: 'field' }] },
  looks_hide: { args: [] },
  looks_nextbackdrop: { args: [] },
  looks_nextcostume: { args: [] },
  looks_say: { args: [{ name: 'MESSAGE', kind: 'input', shadow: 'text' }] },
  looks_sayforsecs: { args: [{ name: 'MESSAGE', kind: 'input', shadow: 'text' }, { name: 'SECS', kind: 'input', shadow: 'math_number' }] },
  looks_seteffectto: { args: [{ name: 'EFFECT', kind: 'field' }, { name: 'VALUE', kind: 'input', shadow: 'math_number' }] },
  looks_setsizeto: { args: [{ name: 'SIZE', kind: 'input', shadow: 'math_number' }] },
  looks_setstretchto: { args: [{ name: 'STRETCH', kind: 'input', shadow: 'math_number' }] },
  looks_show: { args: [] },
  looks_size: { args: [] },
  looks_switchbackdropto: { args: [{ name: 'BACKDROP', kind: 'menu', shadow: 'looks_backdrops', menuField: 'BACKDROP' }] },
  looks_switchbackdroptoandwait: { args: [{ name: 'BACKDROP', kind: 'menu', shadow: 'looks_backdrops', menuField: 'BACKDROP' }] },
  looks_switchcostumeto: { args: [{ name: 'COSTUME', kind: 'menu', shadow: 'looks_costume', menuField: 'COSTUME' }] },
  looks_think: { args: [{ name: 'MESSAGE', kind: 'input', shadow: 'text' }] },
  looks_thinkforsecs: { args: [{ name: 'MESSAGE', kind: 'input', shadow: 'text' }, { name: 'SECS', kind: 'input', shadow: 'math_number' }] },
  motion_changexby: { args: [{ name: 'DX', kind: 'input', shadow: 'math_number' }] },
  motion_changeyby: { args: [{ name: 'DY', kind: 'input', shadow: 'math_number' }] },
  motion_direction: { args: [] },
  motion_glidesecstoxy: { args: [{ name: 'SECS', kind: 'input', shadow: 'math_number' }, { name: 'X', kind: 'input', shadow: 'math_number' }, { name: 'Y', kind: 'input', shadow: 'math_number' }] },
  motion_glideto: { args: [{ name: 'SECS', kind: 'input', shadow: 'math_number' }, { name: 'TO', kind: 'menu', shadow: 'motion_glideto_menu', menuField: 'TO' }] },
  motion_goto: { args: [{ name: 'TO', kind: 'menu', shadow: 'motion_goto_menu', menuField: 'TO' }] },
  motion_gotoxy: { args: [{ name: 'X', kind: 'input', shadow: 'math_number' }, { name: 'Y', kind: 'input', shadow: 'math_number' }] },
  motion_ifonedgebounce: { args: [] },
  motion_movesteps: { args: [{ name: 'STEPS', kind: 'input', shadow: 'math_number' }] },
  motion_pointindirection: { args: [{ name: 'DIRECTION', kind: 'input', shadow: 'math_angle' }] },
  motion_pointtowards: { args: [{ name: 'TOWARDS', kind: 'menu', shadow: 'motion_pointtowards_menu', menuField: 'TOWARDS' }] },
  motion_setrotationstyle: { args: [{ name: 'STYLE', kind: 'field' }] },
  motion_setx: { args: [{ name: 'X', kind: 'input', shadow: 'math_number' }] },
  motion_sety: { args: [{ name: 'Y', kind: 'input', shadow: 'math_number' }] },
  motion_turnleft: { args: [{ name: 'DEGREES', kind: 'input', shadow: 'math_number' }] },
  motion_turnright: { args: [{ name: 'DEGREES', kind: 'input', shadow: 'math_number' }] },
  motion_xposition: { args: [] },
  motion_yposition: { args: [] },
  operator_add: { args: [{ name: 'NUM1', kind: 'input', shadow: 'math_number' }, { name: 'NUM2', kind: 'input', shadow: 'math_number' }] },
  operator_and: { args: [{ name: 'OPERAND1', kind: 'input', bool: true }, { name: 'OPERAND2', kind: 'input', bool: true }] },
  operator_contains: { args: [{ name: 'STRING1', kind: 'input', shadow: 'text' }, { name: 'STRING2', kind: 'input', shadow: 'text' }] },
  operator_divide: { args: [{ name: 'NUM1', kind: 'input', shadow: 'math_number' }, { name: 'NUM2', kind: 'input', shadow: 'math_number' }] },
  operator_equals: { args: [{ name: 'OPERAND1', kind: 'input', shadow: 'text' }, { name: 'OPERAND2', kind: 'input', shadow: 'text' }] },
  operator_gt: { args: [{ name: 'OPERAND1', kind: 'input', shadow: 'text' }, { name: 'OPERAND2', kind: 'input', shadow: 'text' }] },
  operator_join: { args: [{ name: 'STRING1', kind: 'input', shadow: 'text' }, { name: 'STRING2', kind: 'input', shadow: 'text' }] },
  operator_length: { args: [{ name: 'STRING', kind: 'input', shadow: 'text' }] },
  operator_letter_of: { args: [{ name: 'LETTER', kind: 'input', shadow: 'math_whole_number' }, { name: 'STRING', kind: 'input', shadow: 'text' }] },
  operator_lt: { args: [{ name: 'OPERAND1', kind: 'input', shadow: 'text' }, { name: 'OPERAND2', kind: 'input', shadow: 'text' }] },
  operator_mathop: { args: [{ name: 'OPERATOR', kind: 'field' }, { name: 'NUM', kind: 'input', shadow: 'math_number' }] },
  operator_mod: { args: [{ name: 'NUM1', kind: 'input', shadow: 'math_number' }, { name: 'NUM2', kind: 'input', shadow: 'math_number' }] },
  operator_multiply: { args: [{ name: 'NUM1', kind: 'input', shadow: 'math_number' }, { name: 'NUM2', kind: 'input', shadow: 'math_number' }] },
  operator_not: { args: [{ name: 'OPERAND', kind: 'input', bool: true }] },
  operator_or: { args: [{ name: 'OPERAND1', kind: 'input', bool: true }, { name: 'OPERAND2', kind: 'input', bool: true }] },
  operator_random: { args: [{ name: 'FROM', kind: 'input', shadow: 'math_number' }, { name: 'TO', kind: 'input', shadow: 'math_number' }] },
  operator_round: { args: [{ name: 'NUM', kind: 'input', shadow: 'math_number' }] },
  operator_subtract: { args: [{ name: 'NUM1', kind: 'input', shadow: 'math_number' }, { name: 'NUM2', kind: 'input', shadow: 'math_number' }] },
  pen_changePenColorParamBy: { args: [{ name: 'COLOR_PARAM', kind: 'menu', shadow: 'pen_menu_colorParam', menuField: 'colorParam' }, { name: 'VALUE', kind: 'input', shadow: 'math_number' }] },
  pen_changePenSizeBy: { args: [{ name: 'SIZE', kind: 'input', shadow: 'math_number' }] },
  pen_clear: { args: [] },
  pen_penDown: { args: [] },
  pen_penUp: { args: [] },
  pen_setPenColorParamTo: { args: [{ name: 'COLOR_PARAM', kind: 'menu', shadow: 'pen_menu_colorParam', menuField: 'colorParam' }, { name: 'VALUE', kind: 'input', shadow: 'math_number' }] },
  pen_setPenColorToColor: { args: [{ name: 'COLOR', kind: 'input', shadow: 'colour_picker' }] },
  pen_setPenSizeTo: { args: [{ name: 'SIZE', kind: 'input', shadow: 'math_number' }] },
  pen_stamp: { args: [] },
  sensing_answer: { args: [] },
  sensing_askandwait: { args: [{ name: 'QUESTION', kind: 'input', shadow: 'text' }] },
  sensing_coloristouchingcolor: { args: [{ name: 'COLOR', kind: 'input', shadow: 'colour_picker' }, { name: 'COLOR2', kind: 'input', shadow: 'colour_picker' }] },
  sensing_current: { args: [{ name: 'CURRENTMENU', kind: 'field' }] },
  sensing_dayssince2000: { args: [] },
  sensing_distanceto: { args: [{ name: 'DISTANCETOMENU', kind: 'menu', shadow: 'sensing_distancetomenu', menuField: 'DISTANCETOMENU' }] },
  sensing_keypressed: { args: [{ name: 'KEY_OPTION', kind: 'menu', shadow: 'sensing_keyoptions', menuField: 'KEY_OPTION' }] },
  sensing_loudness: { args: [] },
  sensing_mousedown: { args: [] },
  sensing_mousex: { args: [] },
  sensing_mousey: { args: [] },
  sensing_of: { args: [{ name: 'PROPERTY', kind: 'field' }, { name: 'OBJECT', kind: 'menu', shadow: 'sensing_of_object_menu', menuField: 'OBJECT' }] },
  sensing_resettimer: { args: [] },
  sensing_setdragmode: { args: [{ name: 'DRAG_MODE', kind: 'field' }] },
  sensing_timer: { args: [] },
  sensing_touchingcolor: { args: [{ name: 'COLOR', kind: 'input', shadow: 'colour_picker' }] },
  sensing_touchingobject: { args: [{ name: 'TOUCHINGOBJECTMENU', kind: 'menu', shadow: 'sensing_touchingobjectmenu', menuField: 'TOUCHINGOBJECTMENU' }] },
  sensing_username: { args: [] },
  sound_changeeffectby: { args: [{ name: 'EFFECT', kind: 'field' }, { name: 'VALUE', kind: 'input', shadow: 'math_number' }] },
  sound_changevolumeby: { args: [{ name: 'VOLUME', kind: 'input', shadow: 'math_number' }] },
  sound_cleareffects: { args: [] },
  sound_play: { args: [{ name: 'SOUND_MENU', kind: 'menu', shadow: 'sound_sounds_menu', menuField: 'SOUND_MENU' }] },
  sound_playuntildone: { args: [{ name: 'SOUND_MENU', kind: 'menu', shadow: 'sound_sounds_menu', menuField: 'SOUND_MENU' }] },
  sound_seteffectto: { args: [{ name: 'EFFECT', kind: 'field' }, { name: 'VALUE', kind: 'input', shadow: 'math_number' }] },
  sound_setvolumeto: { args: [{ name: 'VOLUME', kind: 'input', shadow: 'math_number' }] },
  sound_stopallsounds: { args: [] },
  sound_volume: { args: [] },
};

// 值原语（value primitive）：这些 opcode 本质是字面量/变量/列表取值器，只能出现在
// 参数槽里，不是可独立执行的积木。出现在 DSL 行首会被 validateParsedScript 拒绝；
// 出现在参数位置（如 (math_number 5)、(data_variable $x)）会被 argToInputValue 折叠成字面量。
const VALUE_PRIMITIVE_OPCODES = { math_number:1, math_integer:1, math_whole_number:1, math_positive_number:1, math_angle:1, text:1, colour_picker:1, note:1, matrix:1, data_variable:1, data_listcontents:1 };

// Tokenize a string of positional arguments into parsed values.
// Handles: numbers, double-quoted strings, $variables, @lists, and (opcode args...) nested reporters.
function tokenizeArgs(argsStr) {
  const args = [];
  const s = String(argsStr == null ? '' : argsStr);
  const n = s.length;
  let i = 0;
  const isWhitespace = (c) => c === ' ' || c === '\t' || c === '\r' || c === '\n';
  // Read a double-quoted string starting at s[i] === '"'; returns [value, nextIndex].
  // Escapes: \" \\ \n \r \t. Unknown escapes keep the backslash literally.
  const readString = (s, i) => {
    let j = i + 1; // skip opening quote
    let str = '';
    while (j < n) {
      if (s[j] === '\\' && j + 1 < n) {
        const esc = s[j + 1];
        if (esc === '"' || esc === '\\') {
          str += esc; // unescape \" -> " and \\ -> \
          j += 2;
          continue;
        }
        if (esc === 'n') { str += '\n'; j += 2; continue; }
        if (esc === 'r') { str += '\r'; j += 2; continue; }
        if (esc === 't') { str += '\t'; j += 2; continue; }
      }
      if (s[j] === '"') break;
      str += s[j];
      j++;
    }
    if (j >= n) {
      throw new Error('Unclosed string literal: "' + str + '"');
    }
    return [str, j + 1]; // past the closing quote
  };
  while (i < n) {
    while (i < n && isWhitespace(s[i])) i++;
    if (i >= n) break;
    const ch = s[i];
    if (ch === '"') {
      let str;
      [str, i] = readString(s, i);
      args.push(str);
    } else if (ch === '(') {
      i++; // skip opening paren
      let depth = 1;
      let inner = '';
      while (i < n && depth > 0) {
        if (s[i] === '"') {
          // consume a quoted string verbatim so parens inside it don't affect depth
          inner += s[i]; i++;
          while (i < n) {
            if (s[i] === '\\' && i + 1 < n && (s[i+1] === '"' || s[i+1] === '\\')) {
              inner += s[i]; inner += s[i+1]; i += 2; continue;
            }
            if (s[i] === '"') break;
            inner += s[i]; i++;
          }
          if (i < n) { inner += s[i]; i++; } // closing quote
        } else if (s[i] === '(') {
          depth++; inner += s[i]; i++;
        } else if (s[i] === ')') {
          depth--;
          if (depth === 0) { i++; break; }
          inner += s[i]; i++;
        } else {
          inner += s[i]; i++;
        }
      }
      if (depth > 0) {
        throw new Error('Unbalanced parentheses in: ' + s.substring(Math.max(0, i - 20), i));
      }
      // inner = "opcode args..."
      let subOpcode, subArgsStr;
      const wsMatch = inner.match(/\s/);
      if (wsMatch === null) {
        subOpcode = inner;
        subArgsStr = '';
      } else {
        const wsIdx = wsMatch.index;
        subOpcode = inner.substring(0, wsIdx);
        subArgsStr = inner.substring(wsIdx + 1);
      }
      args.push({ opcode: subOpcode, args: tokenizeArgs(subArgsStr) });
    } else if (ch === '$') {
      i++; // skip $
      if (s[i] === '"') {
        let name;
        [name, i] = readString(s, i);
        args.push({ variable: name });
      } else {
        let name = '';
        while (i < n && !isWhitespace(s[i])) name += s[i], i++;
        args.push({ variable: name });
      }
    } else if (ch === '@') {
      i++; // skip @
      if (s[i] === '"') {
        let name;
        [name, i] = readString(s, i);
        args.push({ list: name });
      } else {
        let name = '';
        while (i < n && !isWhitespace(s[i])) name += s[i], i++;
        args.push({ list: name });
      }
    } else if (ch === '%') {
      // define 体内的参数引用：%名称 → {argument: 名称}，由 argToInputValue
      // 折叠成 argument_reporter_* 描述符（类型按最近 define 的参数表翻转）。
      i++; // skip %
      let name = '';
      while (i < n && !isWhitespace(s[i])) name += s[i], i++;
      args.push({ argument: name });
    } else {
      // number or bareword: read until whitespace
      let token = '';
      while (i < n && !isWhitespace(s[i])) token += s[i], i++;
      if (/^-?(?:\d+|\d+\.\d+|\.\d+)$/.test(token)) {
        args.push(parseFloat(token));
      } else {
        args.push(token);
      }
    }
  }
  return args;
}

// Convert a raw token (from tokenizeArgs) into an input value, applying variable/list/nested-reporter rules.
function argToInputValue(val, runtime) {
  if (val && typeof val === 'object') {
    if (val.variable) {
      return { opcode: 'data_variable', fields: { VARIABLE: val.variable } };
    }
    if (val.list) {
      return { opcode: 'data_listcontents', fields: { LIST: val.list } };
    }
    if (val.argument !== undefined) {
      // %参数：默认按字符串/数字报告器产出；类型翻转（bool → argument_reporter_boolean）
      // 与越界引用报错由 parseScratchDSL 的树遍历（applyArgumentRefs）完成。
      return { opcode: 'argument_reporter_string_number', fields: { VALUE: val.argument } };
    }
    if (val.opcode && VALUE_PRIMITIVE_OPCODES[val.opcode]) {
      // 值原语出现在参数位置：折叠成字面量（{variable}/{list} 简写、字符串或数字）
      // 直接返回，走常规 shadow 构建；不能保留 opcode 形态，否则会被
      // validateParsedScript 当成"值原语不是积木"拒绝，也会展开成残缺积木。
      const primArgs = Array.isArray(val.args) ? val.args : [];
      const prim0 = primArgs.length > 0 ? primArgs[0] : undefined;
      if (val.opcode === 'data_variable') {
        if (prim0 && typeof prim0 === 'object' && prim0.variable) return prim0;
        return { variable: prim0 == null ? '' : String(prim0) };
      }
      if (val.opcode === 'data_listcontents') {
        if (prim0 && typeof prim0 === 'object' && prim0.list) return prim0;
        return { list: prim0 == null ? '' : String(prim0) };
      }
      if (val.opcode === 'text' || val.opcode === 'colour_picker' ||
          val.opcode === 'note' || val.opcode === 'matrix') {
        return prim0 == null ? '' : String(prim0);
      }
      // math_*：trim 后可解析为数字则取数字，否则归 0
      const trimmed = String(prim0 == null ? '' : prim0).trim();
      const num = Number(trimmed);
      return trimmed !== '' && !isNaN(num) ? num : 0;
    }
    if (val.opcode) {
      return mapArgsToDescriptor(val.opcode, val.args, runtime);
    }
  }
  return val; // number or string
}

// Map an opcode + positional raw args to a block descriptor {opcode, inputs, fields}.
function mapArgsToDescriptor(opcode, rawArgs, runtime) {
  const schema = resolveBlockSchema(opcode, runtime);
  const inputs = {};
  const fields = {};
  const args = Array.isArray(rawArgs) ? rawArgs : [];
  if (schema) {
    for (let i = 0; i < args.length; i++) {
      const argDef = schema.args[i];
      const val = args[i];
      if (!argDef) {
        inputs['ARG' + (i + 1)] = argToInputValue(val);
        continue;
      }
      if (argDef.kind === 'field') {
        if (val && typeof val === 'object') {
          if (val.variable && argDef.name === 'VARIABLE') {
            fields[argDef.name] = val.variable;
          } else if (val.list && argDef.name === 'LIST') {
            fields[argDef.name] = val.list;
          } else if (val.opcode) {
            inputs[argDef.name] = argToInputValue(val);
          } else {
            fields[argDef.name] = String(val);
          }
        } else {
          fields[argDef.name] = String(val);
        }
      } else {
        inputs[argDef.name] = argToInputValue(val);
      }
    }
  } else {
    for (let i = 0; i < args.length; i++) {
      inputs['ARG' + (i + 1)] = argToInputValue(args[i]);
    }
  }
  return { opcode, inputs, fields };
}

// Parse a single DSL line (already trimmed) into {opcode, args} where args is the raw token array.
// runtime 仅用于调用链统一透传（词法解析本身不依赖 schema）。
function parseDslLine(content, runtime) {
  void runtime;
  const wsMatch = content.match(/\s/);
  if (wsMatch === null) {
    return { opcode: content, args: [] };
  }
  const wsIdx = wsMatch.index;
  const opcode = content.substring(0, wsIdx);
  const argsStr = content.substring(wsIdx + 1);
  return { opcode, args: tokenizeArgs(argsStr) };
}

const isDefineLine = content => content === 'define' || content.indexOf('define ') === 0;
const isCallLine = content => content === 'call' || content.indexOf('call ') === 0;

// Parse a define hat line: `define walk (steps) <fast> warp=true`.
// 扫描规则：bareword → proccode 字面词；(名) → 文本参数（%s）；<名> → 布尔参数（%b）；
// warp=true|false 是标记，不进 proccode。proccode 按出现顺序用单空格连接。
// 返回树节点形态（与 body 节点同构），解析错误直接抛出（applyDslTextToTarget 统一捕获）。
function parseDefineLine(content, lineNo) {
  const rest = content.substring('define'.length);
  const proccodeParts = [];
  const argNames = [];
  const argTypes = [];
  let warp = false;
  let i = 0;
  const n = rest.length;
  const fail = msg => { throw new Error('line ' + lineNo + ': ' + msg); };
  while (i < n) {
    while (i < n && /\s/.test(rest[i])) i++;
    if (i >= n) break;
    const ch = rest[i];
    if (ch === '(' || ch === '<') {
      const isBool = ch === '<';
      const close = isBool ? '>' : ')';
      i++;
      let name = '';
      while (i < n && rest[i] !== close) { name += rest[i]; i++; }
      if (i >= n) fail('define 参数括号未闭合：' + ch + name);
      i++; // skip close
      if (name.trim() === '') fail('define 参数名不能为空：' + (isBool ? '<名称>' : '(名称)'));
      argNames.push(name);
      argTypes.push(isBool ? 'bool' : 'string');
      proccodeParts.push(isBool ? '%b' : '%s');
    } else {
      let word = '';
      while (i < n && !/\s/.test(rest[i])) { word += rest[i]; i++; }
      const warpMatch = word.match(/^warp=(true|false)$/);
      if (warpMatch) {
        warp = warpMatch[1] === 'true';
      } else {
        proccodeParts.push(word);
      }
    }
  }
  if (proccodeParts.length === 0) {
    fail('define 后必须有过程名（例如 define walk (steps) <fast>）');
  }
  return {
    opcode: 'procedures_definition',
    proc: { proccode: proccodeParts.join(' '), argNames, argTypes, warp },
    rawArgs: [],
    indent: 0,
    substack: [],
    substack2: [],
    lineNo
  };
}

// Parse a call line: `call "walk %s %b" 10 (operator_gt (sensing_timer) 5)`.
// call 后第一个 token 必须是加引号的原始 proccode（含 %s/%b 占位符）；
// 其余 token 按占位符顺序填充参数，原样保留到构建阶段再解析。
function parseCallLine(content, lineNo) {
  const rest = content.substring('call'.length);
  const firstChar = rest.match(/\S/);
  if (!firstChar || firstChar[0] !== '"') {
    throw new Error('line ' + lineNo + ': call 后第一个参数必须是加引号的 proccode（例如 call "walk %s" 10）');
  }
  const tokens = tokenizeArgs(rest);
  if (tokens.length === 0 || typeof tokens[0] !== 'string') {
    throw new Error('line ' + lineNo + ': call 后第一个参数必须是加引号的 proccode（例如 call "walk %s" 10）');
  }
  return {
    opcode: 'procedures_call',
    proccode: tokens[0],
    callArgs: tokens.slice(1),
    rawArgs: [],
    indent: 0,
    substack: [],
    substack2: [],
    lineNo
  };
}

// Convert a tree node (with rawArgs and child node arrays) into a block descriptor with substack/substack2.
function convertNode(node, runtime) {
  let descriptor;
  if (node.opcode === 'procedures_definition') {
    descriptor = { opcode: node.opcode, inputs: {}, fields: {}, proc: node.proc };
  } else if (node.opcode === 'procedures_call') {
    // callArgs 原样保留（原始 token），procedures_call 的输入在构建阶段按注册表解析
    descriptor = { opcode: node.opcode, inputs: {}, fields: {}, proccode: node.proccode, callArgs: node.callArgs };
  } else {
    descriptor = mapArgsToDescriptor(node.opcode, node.rawArgs, runtime);
  }
  if (node.lineNo !== undefined) descriptor.lineNo = node.lineNo;
  if (node.substack && node.substack.length > 0) {
    descriptor.substack = node.substack.map(child => convertNode(child, runtime));
  }
  if (node.substack2 && node.substack2.length > 0) {
    descriptor.substack2 = node.substack2.map(child => convertNode(child, runtime));
  }
  return descriptor;
}

// define 参数表 → {参数名: 'string'|'bool'}，供 %参数 类型翻转使用。
function procParamMap(proc) {
  const map = {};
  const names = (proc && proc.argNames) || [];
  const types = (proc && proc.argTypes) || [];
  names.forEach((nm, idx) => { map[nm] = types[idx] === 'bool' ? 'bool' : 'string'; });
  return map;
}

// 遍历描述符树（含 substack/substack2 与嵌套 reporter 描述符）：把 {argument} 生成的
// argument_reporter_string_number 按最近 define 的参数类型翻转成 boolean；不在任何
// define 参数表里的 %引用 记错误（仍保留 string_number 描述符，让构建有据可依）。
function applyArgumentRefs(desc, procMap, errors) {
  if (!desc || typeof desc !== 'object' || !desc.opcode) return;
  let map = procMap;
  if (desc.opcode === 'procedures_definition') {
    map = procParamMap(desc.proc);
  }
  const lineNo = desc.lineNo;
  Object.keys(desc.inputs || {}).forEach(key => {
    const v = desc.inputs[key];
    if (!v || typeof v !== 'object' || !v.opcode) return;
    if (v.opcode === 'argument_reporter_string_number' || v.opcode === 'argument_reporter_boolean') {
      const f = v.fields && v.fields.VALUE;
      // argToInputValue 产出的是裸字符串（{VALUE: 'steps'}），构建期才展开成字段对象
      const nm = f && typeof f === 'object' ? f.value : f;
      if (map && Object.prototype.hasOwnProperty.call(map, nm)) {
        if (map[nm] === 'bool' && v.opcode !== 'argument_reporter_boolean') {
          desc.inputs[key] = { opcode: 'argument_reporter_boolean', fields: { VALUE: nm } };
        }
      } else {
        errors.push('line ' + (lineNo === undefined ? '?' : lineNo) + ': %' + nm +
          ' 不在最近的 define 参数列表中（%参数只能在 define 体内引用）');
      }
      return;
    }
    applyArgumentRefs(v, map, errors);
  });
  (desc.substack || []).forEach(s => applyArgumentRefs(s, map, errors));
  (desc.substack2 || []).forEach(s => applyArgumentRefs(s, map, errors));
}

// Convert a JSON block object (e.g. {"opcode":"...","inputs":{},"next":{...}}) to DSL text lines.
// IMPORTANT: the DSL is positional — parseDslLine/mapArgsToDescriptor map tokens onto
// OPCODE_SCHEMA[opcode].args by index. So arguments must be emitted in schema order,
// not "all inputs then all fields". Emitting them out of order silently swaps values
// between slots (e.g. data_setvariableto would take the number as VARIABLE and the
// variable name as VALUE, creating a bogus variable named after the value).
// Resolve a VARIABLE / LIST field to a real VM variable descriptor.
// The VM binds a block's variable field by ID: if the id is missing/unknown, Scratch
// auto-creates a *local* variable on the sprite named after whatever it finds, which is
// how a stray variable named after a value ends up on the sprite. So look the name up
// (local first, then stage) and create the variable when it genuinely does not exist,
// always returning a concrete id.
function resolveVariableField(target, key, rawName) {
  const isList = key === 'LIST';
  const type = isList ? 'list' : '';
  const name = String(rawName == null ? '' : rawName);
  let variable = target.lookupVariableByNameAndType(name, type);
  if (!variable) {
    // Prefer creating globals on the stage so every sprite can see them, matching
    // how users normally declare variables in the editor.
    const stage = target.runtime && target.runtime.getTargetForStage ? target.runtime.getTargetForStage() : null;
    const owner = stage || target;
    const newId = 'aivar_' + Math.random().toString(36).slice(2, 10);
    if (isList) {
      owner.createVariable(newId, name, 'list');
    } else {
      owner.createVariable(newId, name, '');
    }
    variable = owner.lookupVariableByNameAndType(name, type) || { id: newId, name: name };
  }
  return { name: key, value: variable.name, id: variable.id, variableType: type };
}

// Resolve a broadcast message name to a real broadcast variable descriptor.
// Broadcast blocks bind by id just like variables; an id-less BROADCAST_OPTION renders
// blank and never fires, so create the message when it is genuinely new.
function resolveBroadcastField(target, rawName) {
  const name = String(rawName == null ? '' : rawName) || 'message1';
  const stage = target.runtime && target.runtime.getTargetForStage
    ? target.runtime.getTargetForStage()
    : null;
  const owner = stage || target;
  let msg = owner.lookupBroadcastByInputValue ? owner.lookupBroadcastByInputValue(name) : null;
  if (!msg) {
    const newId = 'aibcast_' + Math.random().toString(36).slice(2, 10);
    owner.createVariable(newId, name, 'broadcast_msg');
    msg = (owner.lookupBroadcastByInputValue && owner.lookupBroadcastByInputValue(name)) ||
      { id: newId, name: name };
  }
  return { name: 'BROADCAST_OPTION', value: msg.name, id: msg.id, variableType: 'broadcast_msg' };
}

// Which field carries the literal value inside each primitive shadow block.
const SHADOW_VALUE_FIELD = {
  math_number: 'NUM',
  math_integer: 'NUM',
  math_whole_number: 'NUM',
  math_positive_number: 'NUM',
  math_angle: 'NUM',
  text: 'TEXT',
  colour_picker: 'COLOUR',
  note: 'NOTE',
  matrix: 'MATRIX'
};

// 扩展积木动态 schema：OPCODE_SCHEMA 只覆盖核心积木，音乐/翻译等扩展积木的参数
// 布局要从 runtime._blockInfo（scratch-vm 注册扩展时生成的 scratch-blocks JSON）
// 现场推导。按 runtime 缓存命中结果（WeakMap<runtime, Map<opcode, schema>>）；
// 只缓存命中的 opcode——扩展可能稍后加载，未命中的下次必须重查。
const dynamicSchemaCache = new WeakMap();

// 把 runtime._blockInfo 里的一项块定义（{info, json}）转成与 OPCODE_SCHEMA 同构的
// schema：args 按 json.args0 的视觉顺序排列，substack/substack2 对齐 C 形分支。
function buildSchemaFromExtensionEntry(entry, category) {
  const args0 = Array.isArray(entry.json.args0) ? entry.json.args0 : [];
  const argInfoMap = (entry.info && entry.info.arguments) || {};
  const args = [];
  const schema = { args: args, dynamic: true };
  for (let i = 0; i < args0.length; i++) {
    const argJson = args0[i];
    const name = argJson && argJson.name;
    const type = argJson && argJson.type;
    if (!name) continue; // field_image / field_vertical_separator 等图标项没有 name
    if (type === 'input_value') {
      const argInfo = argInfoMap[name] || {};
      const argDef = { name: name, kind: 'input' };
      if (argInfo.menu && category && category.menuInfo && category.menuInfo[argInfo.menu] &&
          category.menuInfo[argInfo.menu].acceptReporters) {
        // 扩展菜单且接受报告器：输入槽 + 菜单影子块，与核心积木的 menu 形态一致
        // （影子块 id 与 scratch-vm _makeExtensionMenuId 的 `${id}_menu_${name}` 对齐）。
        argDef.kind = 'menu';
        argDef.shadow = (category.id || '') + '_menu_' + argInfo.menu;
        argDef.menuField = argInfo.menu;
      } else {
        switch (argInfo.type) {
          case 'Boolean':
            argDef.bool = true;
            break;
          case 'color':
            argDef.shadow = 'colour_picker';
            break;
          case 'angle':
            argDef.shadow = 'math_angle';
            break;
          case 'number':
            argDef.shadow = 'math_number';
            break;
          default:
            // 'string'、'note'、'matrix'、缺省都按文本影子处理
            argDef.shadow = 'text';
            break;
        }
        if (!argInfo.type && argJson.check === 'Boolean') {
          // info.arguments 缺失时退回 args0 的 check 标记（六边形布尔输入）
          delete argDef.shadow;
          argDef.bool = true;
        }
      }
      args.push(argDef);
    } else if (type === 'input_boolean') {
      args.push({ name: name, kind: 'input', bool: true });
    } else if (type === 'input_statement') {
      if (name === 'SUBSTACK') schema.substack = true;
      else if (name === 'SUBSTACK2') schema.substack2 = true;
      // 其它名字的子栈 DSL 无法表示，忽略
    } else if (type === 'field_dropdown' || type === 'field_number' || type === 'field_angle' ||
               type === 'field_colour' || type === 'field_text' || type === 'field_checkbox') {
      // 扩展的下拉/数值等字段直接存值（没有独立菜单块），走 block.fields
      args.push({ name: name, kind: 'field' });
    }
    // field_image / field_variable 等其它类型 → 忽略
  }
  return schema;
}

/**
 * Resolve a block's parameter schema: OPCODE_SCHEMA for core blocks, or a schema
 * derived on demand from runtime._blockInfo for loaded extension blocks.
 * Returns null when the opcode is unknown (no runtime, or extension not loaded).
 */
function resolveBlockSchema(opcode, runtime) {
  if (OPCODE_SCHEMA[opcode]) return OPCODE_SCHEMA[opcode];
  if (!runtime || !Array.isArray(runtime._blockInfo)) return null;
  let cache = dynamicSchemaCache.get(runtime);
  if (cache && cache.has(opcode)) return cache.get(opcode);
  let derived = null;
  for (let ci = 0; ci < runtime._blockInfo.length && !derived; ci++) {
    const category = runtime._blockInfo[ci];
    const blocks = category && category.blocks;
    if (!Array.isArray(blocks)) continue;
    for (let bi = 0; bi < blocks.length; bi++) {
      const entry = blocks[bi];
      // 按钮/分隔线等项没有 json；scratch-vm 把 opcode 放在 json.type（容错 json.opcode）
      if (!entry || !entry.json) continue;
      if ((entry.json.opcode || entry.json.type) !== opcode) continue;
      derived = buildSchemaFromExtensionEntry(entry, category);
      break;
    }
  }
  if (!derived) return null; // 未命中不缓存：扩展可能稍后加载
  if (!cache) {
    cache = new Map();
    dynamicSchemaCache.set(runtime, cache);
  }
  cache.set(opcode, derived);
  return derived;
}

function schemaArgFor(opcode, inputName, runtime) {
  const schema = resolveBlockSchema(opcode, runtime);
  if (!schema || !Array.isArray(schema.args)) return null;
  for (let i = 0; i < schema.args.length; i++) {
    if (schema.args[i].name === inputName) return schema.args[i];
  }
  return null;
}

// Scratch's colour_picker field stores '#rrggbb'. Models often pass the decimal form
// used by the sb3 format (16711680), which would otherwise render as literal text.
function toHexColor(value) {
  if (typeof value === 'number' && isFinite(value)) {
    const n = Math.max(0, Math.min(0xffffff, Math.round(value)));
    return '#' + ('000000' + n.toString(16)).slice(-6);
  }
  const str = String(value == null ? '' : value).trim();
  if (/^#[0-9a-fA-F]{6}$/.test(str)) return str.toLowerCase();
  if (/^#[0-9a-fA-F]{3}$/.test(str)) {
    return '#' + str[1] + str[1] + str[2] + str[2] + str[3] + str[3];
  }
  if (/^[0-9a-fA-F]{6}$/.test(str)) return '#' + str.toLowerCase();
  const asNum = Number(str);
  if (str !== '' && !isNaN(asNum)) return toHexColor(asNum);
  return '#0000ff';
}

function newAiBlockId() {
  return '_ai_' + Math.random().toString(36).substr(2, 9);
}

// ── 自定义积木（procedures_definition / procedures_call）注册表 ──
// proccode → {argIds, argNames, argTypes, warp}。call 与 define 之间的参数槽
// 靠 argumentids 对齐，构建时必须用注册表里的 id，不能两边各自生成。

/**
 * 扫描 target 现有积木中的 procedures_prototype，解析 mutation 组成注册表。
 * mutation 里的三个数组字段（argumentids/argumentnames/argumentdefaults）是
 * JSON 字符串；%s/%b 顺序无法从字段直接得知，用 proccode 中占位符出现顺序与
 * argumentnames 按下标对齐推导 argTypes。
 */
function collectProcRegistry(target) {
  const registry = new Map();
  const blocks = target && target.blocks && target.blocks._blocks ? target.blocks._blocks : {};
  Object.keys(blocks).forEach(id => {
    const b = blocks[id];
    if (!b || b.opcode !== 'procedures_prototype' || !b.mutation) return;
    const proccode = b.mutation.proccode;
    if (typeof proccode !== 'string') return;
    let argIds = [];
    let argNames = [];
    try { argIds = JSON.parse(b.mutation.argumentids || '[]'); } catch (e) { argIds = []; }
    try { argNames = JSON.parse(b.mutation.argumentnames || '[]'); } catch (e) { argNames = []; }
    if (!Array.isArray(argIds)) argIds = [];
    if (!Array.isArray(argNames)) argNames = [];
    const placeholders = proccode.match(/%[sb]/g) || [];
    registry.set(proccode, {
      argIds,
      argNames,
      argTypes: placeholders.map(ph => (ph === '%b' ? 'bool' : 'string')),
      warp: b.mutation.warp === 'true' || b.mutation.warp === true
    });
  });
  return registry;
}

/** 把解析得到的文本 define 登记进注册表：每个参数分配一个新 id。 */
function registerTextDefines(registry, defines) {
  (defines || []).forEach(proc => {
    registry.set(proc.proccode, {
      argIds: (proc.argNames || []).map(() => newAiBlockId()),
      argNames: proc.argNames || [],
      argTypes: proc.argTypes || [],
      warp: !!proc.warp
    });
  });
}

/**
 * 构建用的注册表：优先 parsed.procRegistry（applyDslTextToTarget 已把文本 define
 * 合并进去）；否则 fallback 到 VM 现有 define + 本段 parsed.defines——保证 AI 助手
 * 单脚本路径（parseScratchDSL → validateParsedScript → buildScriptBlocks）可用。
 */
function procRegistryForParsed(parsed, target) {
  if (parsed && parsed.procRegistry) return parsed.procRegistry;
  const registry = collectProcRegistry(target);
  registerTextDefines(registry, parsed ? parsed.defines : null);
  return registry;
}

/**
 * Create the shadow block occupying one input slot, choosing its type from OPCODE_SCHEMA
 * rather than from the JavaScript type of the value.
 *
 * The distinction is not cosmetic: `motion_pointindirection` needs a math_angle dial,
 * `sensing_touchingcolor` a colour_picker, `control_repeat` a whole-number field,
 * `sound_play` a sound dropdown, and `event_broadcast` a broadcast menu bound to a real
 * message id. Filling every slot with math_number/text yields blocks that look wrong and,
 * for menus and broadcasts, do not work at all.
 *
 * @returns {[object|null, object]} [shadow block to create (or null), input reference]
 */
function createInputShadow(target, parentId, opcode, inputName, value) {
  const argDef = schemaArgFor(opcode, inputName, target && target.runtime);

  const mkShadow = (shadowOpcode, fields) => {
    const sid = newAiBlockId();
    return [
      {
        id: sid, opcode: shadowOpcode, fields: fields, inputs: {},
        next: null, parent: parentId, shadow: true, topLevel: false, x: 0, y: 0
      },
      { name: inputName, block: sid, shadow: sid }
    ];
  };

  // Variable / list reporters requested explicitly as {VARIABLE: n} / {LIST: n}
  if (value && typeof value === 'object' && value.VARIABLE !== undefined) {
    return mkShadow('data_variable', { VARIABLE: resolveVariableField(target, 'VARIABLE', value.VARIABLE) });
  }
  if (value && typeof value === 'object' && value.LIST !== undefined) {
    return mkShadow('data_listcontents', { LIST: resolveVariableField(target, 'LIST', value.LIST) });
  }
  // 同上的小写形态：argToInputValue 把嵌套的值原语（如 (data_variable $x)）折叠成的字面量简写
  if (value && typeof value === 'object' && value.variable !== undefined) {
    return mkShadow('data_variable', { VARIABLE: resolveVariableField(target, 'VARIABLE', value.variable) });
  }
  if (value && typeof value === 'object' && value.list !== undefined) {
    return mkShadow('data_listcontents', { LIST: resolveVariableField(target, 'LIST', value.list) });
  }

  // Boolean (hexagonal) slots hold no shadow in Scratch; an empty condition is legal and
  // reads as false. A text shadow there breaks the block's shape.
  if (argDef && argDef.bool) {
    return [null, { name: inputName, block: null, shadow: null }];
  }

  // Menu-backed input: dropdown appearance, real input slot underneath.
  if (argDef && argDef.kind === 'menu') {
    if (argDef.shadow === 'event_broadcast_menu') {
      return mkShadow('event_broadcast_menu', { BROADCAST_OPTION: resolveBroadcastField(target, value) });
    }
    const menuField = argDef.menuField || inputName;
    return mkShadow(argDef.shadow, {
      [menuField]: { name: menuField, value: String(value == null ? '' : value), id: undefined }
    });
  }

  const shadowType = (argDef && argDef.shadow) || null;
  if (shadowType === 'colour_picker') {
    return mkShadow('colour_picker', { COLOUR: { name: 'COLOUR', value: toHexColor(value), id: undefined } });
  }
  if (shadowType && SHADOW_VALUE_FIELD[shadowType] && shadowType !== 'text') {
    const fieldName = SHADOW_VALUE_FIELD[shadowType];
    const num = typeof value === 'number' ? value : Number(String(value == null ? '' : value).trim());
    // A numeric slot given non-numeric text means the model put a string where Scratch
    // expects a number; keep it visible in a text shadow instead of silently zeroing it.
    if (isFinite(num) && String(value).trim() !== '') {
      return mkShadow(shadowType, { [fieldName]: { name: fieldName, value: num, id: undefined } });
    }
    return mkShadow('text', { TEXT: { name: 'TEXT', value: String(value == null ? '' : value), id: undefined } });
  }

  if (typeof value === 'number') {
    return mkShadow('math_number', { NUM: { name: 'NUM', value: value, id: undefined } });
  }
  if (typeof value === 'boolean') {
    return mkShadow('text', { TEXT: { name: 'TEXT', value: value ? 'true' : 'false', id: undefined } });
  }
  if (value === null || value === undefined) {
    return [null, { name: inputName, block: null, shadow: null }];
  }
  return mkShadow('text', { TEXT: { name: 'TEXT', value: String(value), id: undefined } });
}

/**
 * Turn a block descriptor tree into flat VM block records appended to `allBlocks`.
 * Handles nested reporters, SUBSTACK/SUBSTACK2 (array or single descriptor), `next`
 * chaining, menu/variable/broadcast fields, and parent wiring.
 * @param {object} procRegistry optional custom-procedure registry (proccode → {argIds,...});
 *        required when the tree contains procedures_definition / procedures_call
 * @returns {string|null} id of the created block
 */
function buildBlockStructure(scriptObj, target, allBlocks, procRegistry) {
  if (!scriptObj || !scriptObj.opcode) return null;
  const blockId = newAiBlockId();
  const inputs = {};
  const rawInputs = scriptObj.inputs || {};

  if (scriptObj.opcode === 'procedures_call') {
    // call 的输入键是 argumentid、带 mutation，构建形态与普通块差异太大，单独走。
    return buildProcedureCall(scriptObj, target, allBlocks, procRegistry);
  }

  if (scriptObj.opcode === 'procedures_definition') {
    // define hat：prototype shadow 挂在 custom_block 输入上（shadow:true, parent=definition），
    // 参数槽 id 用注册表里的，不得重新生成；身体由 buildScriptBlocks 的 next 链处理。
    const proc = scriptObj.proc || {};
    const entry = procRegistry ? procRegistry.get(proc.proccode) : null;
    if (!entry) return null;
    const protoId = newAiBlockId();
    const argDefaults = (entry.argTypes || []).map(t => (t === 'bool' ? 'false' : ''));
    allBlocks.push({
      id: protoId,
      opcode: 'procedures_prototype',
      inputs: {},
      fields: {},
      next: null,
      parent: blockId,
      shadow: true,
      topLevel: false,
      x: 0,
      y: 0,
      // mutation 的三个数组字段是 JSON 字符串；children 必须存在（mutationToXML 会遍历）
      mutation: {
        tagName: 'mutation',
        children: [],
        proccode: proc.proccode,
        argumentids: JSON.stringify(entry.argIds || []),
        argumentnames: JSON.stringify(entry.argNames || []),
        argumentdefaults: JSON.stringify(argDefaults),
        warp: entry.warp ? 'true' : 'false'
      }
    });
    inputs.custom_block = { name: 'custom_block', block: protoId, shadow: protoId };
  }

  Object.keys(rawInputs).forEach(key => {
    if (key === 'SUBSTACK' || key === 'SUBSTACK2') return; // handled after the block exists
    const val = rawInputs[key];
    if (val && typeof val === 'object' && val.opcode) {
      const nestedId = buildBlockStructure(val, target, allBlocks, procRegistry);
      if (nestedId) {
        inputs[key] = { name: key, block: nestedId, shadow: null };
        const nestedDef = allBlocks.find(ab => ab.id === nestedId);
        if (nestedDef) nestedDef.parent = blockId;
      }
      return;
    }
    const [shadowBlock, inputRef] = createInputShadow(target, blockId, scriptObj.opcode, key, val);
    if (shadowBlock) allBlocks.push(shadowBlock);
    if (inputRef && inputRef.block) inputs[key] = inputRef;
  });

  const fields = {};
  if (scriptObj.fields) {
    Object.keys(scriptObj.fields).forEach(key => {
      const argDef = schemaArgFor(scriptObj.opcode, key, target && target.runtime);
      const raw = scriptObj.fields[key];
      // A model may place a menu value under `fields` even though Scratch models it as an
      // input slot; route it through the shadow path so the block still renders correctly.
      if (argDef && argDef.kind === 'menu') {
        const [shadowBlock, inputRef] = createInputShadow(target, blockId, scriptObj.opcode, key, raw);
        if (shadowBlock) allBlocks.push(shadowBlock);
        if (inputRef && inputRef.block) inputs[key] = inputRef;
        return;
      }
      if (key === 'VARIABLE') { fields[key] = resolveVariableField(target, 'VARIABLE', raw); return; }
      if (key === 'LIST') { fields[key] = resolveVariableField(target, 'LIST', raw); return; }
      if (key === 'BROADCAST_OPTION') { fields[key] = resolveBroadcastField(target, raw); return; }
      fields[key] = { name: key, value: String(raw), id: undefined };
    });
  }

  const blockDef = {
    id: blockId, opcode: scriptObj.opcode, next: null, parent: null,
    inputs: inputs, fields: fields, shadow: false, topLevel: false, x: 0, y: 0
  };
  allBlocks.push(blockDef);

  const subSource = scriptObj.substack || rawInputs.SUBSTACK;
  if (subSource) {
    const arr = Array.isArray(subSource) ? subSource : [subSource];
    const substackId = buildSubstackChain(arr, target, allBlocks, blockId, procRegistry);
    if (substackId) blockDef.inputs.SUBSTACK = { name: 'SUBSTACK', block: substackId, shadow: null };
  }
  const sub2Source = scriptObj.substack2 || rawInputs.SUBSTACK2;
  if (sub2Source) {
    const arr2 = Array.isArray(sub2Source) ? sub2Source : [sub2Source];
    const substack2Id = buildSubstackChain(arr2, target, allBlocks, blockId, procRegistry);
    if (substack2Id) blockDef.inputs.SUBSTACK2 = { name: 'SUBSTACK2', block: substack2Id, shadow: null };
  }

  if (scriptObj.next) {
    const nextId = buildBlockStructure(scriptObj.next, target, allBlocks, procRegistry);
    if (nextId) {
      blockDef.next = nextId;
      const nextDef = allBlocks.find(ab => ab.id === nextId);
      if (nextDef) nextDef.parent = blockId;
    }
  }

  return blockId;
}

/**
 * Build a procedures_call block: inputs keyed by argumentid（与 prototype 的
 * argumentids 对齐），mutation 记录 proccode + argumentids。
 * 参数槽规则：bool 槽接受嵌套报告器（走嵌套构建），裸 true/false 留空；
 * 其余值走 createInputShadow（数字/字符串 shadow），{variable}/{list} 简写转成
 * data_variable/data_listcontents 描述符走嵌套（与 argToInputValue 一致）。
 * 注册表查不到 proccode 时跳过创建（返回 null），校验阶段已报错。
 * @returns {string|null} id of the created call block
 */
function buildProcedureCall(scriptObj, target, allBlocks, procRegistry) {
  const entry = procRegistry ? procRegistry.get(scriptObj.proccode) : null;
  if (!entry) return null;
  const callId = newAiBlockId();
  const inputs = {};
  const placeholders = String(scriptObj.proccode).match(/%[sb]/g) || [];
  const callArgs = Array.isArray(scriptObj.callArgs) ? scriptObj.callArgs : [];
  const argIds = entry.argIds || [];
  const argTypes = entry.argTypes || [];
  for (let i = 0; i < placeholders.length && i < callArgs.length; i++) {
    const argId = argIds[i];
    if (!argId) break;
    let val = callArgs[i];
    // 原始 token 形态（{variable}/{list} 简写、{opcode, args} 嵌套 token）统一折叠：
    // 值原语变字面量/简写，其余变描述符——与普通积木参数走 argToInputValue 的规则一致。
    if (val && typeof val === 'object' && (val.variable !== undefined || val.list !== undefined ||
        (val.opcode && Array.isArray(val.args)))) {
      val = argToInputValue(val, target && target.runtime);
    }
    if (argTypes[i] === 'bool') {
      if (val && typeof val === 'object' && val.opcode) {
        const nestedId = buildBlockStructure(val, target, allBlocks, procRegistry);
        if (nestedId) {
          inputs[argId] = { name: argId, block: nestedId, shadow: null };
          const nestedDef = allBlocks.find(ab => ab.id === nestedId);
          if (nestedDef) nestedDef.parent = callId;
        }
      }
      // 裸 true/false（或布尔）与折叠后的字面量：布尔槽留空（Scratch 里即 false）
    } else if (val && typeof val === 'object' && val.opcode) {
      const nestedId = buildBlockStructure(val, target, allBlocks, procRegistry);
      if (nestedId) {
        inputs[argId] = { name: argId, block: nestedId, shadow: null };
        const nestedDef = allBlocks.find(ab => ab.id === nestedId);
        if (nestedDef) nestedDef.parent = callId;
      }
    } else if (val && typeof val === 'object' && (val.variable !== undefined || val.list !== undefined)) {
      // 折叠出的 {variable}/{list} 简写：转成 data_variable/data_listcontents 描述符走嵌套
      const nestedId = buildBlockStructure(argToInputValue(val, target && target.runtime), target, allBlocks, procRegistry);
      if (nestedId) {
        inputs[argId] = { name: argId, block: nestedId, shadow: null };
        const nestedDef = allBlocks.find(ab => ab.id === nestedId);
        if (nestedDef) nestedDef.parent = callId;
      }
    } else {
      const [shadowBlock, inputRef] = createInputShadow(target, callId, 'procedures_call', argId, val);
      if (shadowBlock) allBlocks.push(shadowBlock);
      if (inputRef && inputRef.block) inputs[argId] = inputRef;
    }
  }
  const callBlock = {
    id: callId,
    opcode: 'procedures_call',
    inputs,
    fields: {},
    next: null,
    parent: null,
    shadow: false,
    topLevel: false,
    x: 0,
    y: 0,
    mutation: {
      tagName: 'mutation',
      children: [],
      proccode: scriptObj.proccode,
      argumentids: JSON.stringify(argIds)
    }
  };
  allBlocks.push(callBlock);
  if (scriptObj.next) {
    const nextId = buildBlockStructure(scriptObj.next, target, allBlocks, procRegistry);
    if (nextId) {
      callBlock.next = nextId;
      const nextDef = allBlocks.find(ab => ab.id === nextId);
      if (nextDef) nextDef.parent = callId;
    }
  }
  return callId;
}

/** Build a vertical chain of blocks; returns the first block's id. */
function buildSubstackChain(substackArray, target, allBlocks, parentBlockId, procRegistry) {
  if (!Array.isArray(substackArray) || substackArray.length === 0) return null;
  let firstId = null;
  let prevId = null;
  for (let si = 0; si < substackArray.length; si++) {
    const subId = buildBlockStructure(substackArray[si], target, allBlocks, procRegistry);
    if (!subId) continue;
    if (firstId === null) firstId = subId;
    const curDef = allBlocks.find(ab => ab.id === subId);
    if (curDef) curDef.parent = prevId || parentBlockId;
    if (prevId) {
      const prevDef = allBlocks.find(ab => ab.id === prevId);
      if (prevDef) prevDef.next = subId;
    }
    prevId = subId;
  }
  return firstId;
}

/**
 * Build a complete top-level script (hat + body chain) from a parsed DSL result.
 * @returns {{blocks: Array, hatId: ?string, lastId: ?string}}
 */
/**
 * Splice a freshly built chain of blocks into an existing script.
 *
 * Scratch stores a stack as a singly linked list (`next`) plus a `parent` pointer, and
 * C-blocks hold their body under `inputs.SUBSTACK`. Inserting therefore means rewiring
 * exactly three links — predecessor→new, new tail→successor, successor→new tail — and
 * getting any of them wrong detaches the rest of the script into a floating stack.
 * Centralizing that here keeps every insert position consistent.
 *
 * @param {object} target the sprite/stage whose blocks are being edited
 * @param {Array} newBlocks flat block records to create (already linked among themselves)
 * @param {string} firstId id of the first block of the new chain
 * @param {string} lastId id of the last block of the new chain
 * @param {object} anchor {position, blockId} describing where to splice
 * @returns {{ok: boolean, error: ?string}}
 */
function spliceBlocksIntoScript(target, newBlocks, firstId, lastId, anchor) {
  const blocks = target.blocks;
  const position = anchor.position;
  const anchorBlock = anchor.blockId ? blocks.getBlock(anchor.blockId) : null;

  if (position !== 'body_start' && position !== 'body_end' && !anchorBlock) {
    return { ok: false, error: 'Anchor block not found' };
  }

  const create = () => newBlocks.forEach(b => blocks.createBlock(b));
  const firstDef = newBlocks.find(b => b.id === firstId);
  const lastDef = newBlocks.find(b => b.id === lastId);
  if (!firstDef || !lastDef) return { ok: false, error: 'New blocks were not built' };
  // Spliced blocks always live inside a script, never as their own stack.
  firstDef.topLevel = false;
  firstDef.x = 0;
  firstDef.y = 0;

  if (position === 'after') {
    const successorId = anchorBlock.next;
    create();
    blocks.getBlock(anchor.blockId).next = firstId;
    blocks.getBlock(firstId).parent = anchor.blockId;
    if (successorId) {
      blocks.getBlock(lastId).next = successorId;
      const successor = blocks.getBlock(successorId);
      if (successor) successor.parent = lastId;
    }
    return { ok: true };
  }

  if (position === 'before') {
    const parentId = anchorBlock.parent;
    const wasTopLevel = anchorBlock.topLevel;
    // Which link points at the anchor: a previous block's `next`, or a C-block's SUBSTACK?
    let parentBlock = parentId ? blocks.getBlock(parentId) : null;
    let branchInput = null;
    if (parentBlock) {
      if (parentBlock.next === anchor.blockId) {
        branchInput = null;
      } else if (parentBlock.inputs) {
        ['SUBSTACK', 'SUBSTACK2'].forEach(key => {
          if (parentBlock.inputs[key] && parentBlock.inputs[key].block === anchor.blockId) branchInput = key;
        });
      }
    }
    // Inserting before a hat block is meaningless — nothing can precede it.
    if (!parentBlock && !wasTopLevel) {
      return { ok: false, error: 'Anchor block has no parent and is not top level; cannot insert before it' };
    }
    if (anchorBlock.opcode.indexOf('event_when') === 0 || anchorBlock.opcode === 'control_start_as_clone') {
      return { ok: false, error: 'Cannot insert before a hat block (' + anchorBlock.opcode +
        '). Use position "after" to put blocks under the hat.' };
    }
    create();
    const anchorNow = blocks.getBlock(anchor.blockId);
    blocks.getBlock(lastId).next = anchor.blockId;
    anchorNow.parent = lastId;
    if (parentBlock) {
      const parentNow = blocks.getBlock(parentId);
      if (branchInput) {
        parentNow.inputs[branchInput] = { name: branchInput, block: firstId, shadow: null };
      } else {
        parentNow.next = firstId;
      }
      blocks.getBlock(firstId).parent = parentId;
    } else {
      // The anchor was the top of its own stack; the new chain takes that role.
      const firstNow = blocks.getBlock(firstId);
      firstNow.topLevel = true;
      firstNow.x = anchorBlock.x || 0;
      firstNow.y = anchorBlock.y || 0;
      firstNow.parent = null;
      anchorNow.topLevel = false;
      blocks._addScript(firstId);
      blocks._deleteScript(anchor.blockId);
    }
    return { ok: true };
  }

  if (position === 'body_start' || position === 'body_end') {
    const cBlock = blocks.getBlock(anchor.blockId);
    if (!cBlock) return { ok: false, error: 'C-block not found' };
    const schema = OPCODE_SCHEMA[cBlock.opcode];
    const branch = anchor.branch === 'else' ? 'SUBSTACK2' : 'SUBSTACK';
    if (!schema || (branch === 'SUBSTACK' && !schema.substack) || (branch === 'SUBSTACK2' && !schema.substack2)) {
      return { ok: false, error: cBlock.opcode + ' has no ' + (branch === 'SUBSTACK2' ? 'else branch' : 'body slot') +
        ', so it cannot receive blocks inside it. Use position "after" instead.' };
    }
    const existingFirstId = cBlock.inputs[branch] && cBlock.inputs[branch].block;
    create();
    if (!existingFirstId) {
      blocks.getBlock(anchor.blockId).inputs[branch] = { name: branch, block: firstId, shadow: null };
      blocks.getBlock(firstId).parent = anchor.blockId;
      return { ok: true };
    }
    if (position === 'body_start') {
      blocks.getBlock(anchor.blockId).inputs[branch] = { name: branch, block: firstId, shadow: null };
      blocks.getBlock(firstId).parent = anchor.blockId;
      blocks.getBlock(lastId).next = existingFirstId;
      const oldFirst = blocks.getBlock(existingFirstId);
      if (oldFirst) oldFirst.parent = lastId;
    } else {
      let tailId = existingFirstId;
      let guard = 0;
      while (blocks.getBlock(tailId) && blocks.getBlock(tailId).next && guard++ < 10000) {
        tailId = blocks.getBlock(tailId).next;
      }
      blocks.getBlock(tailId).next = firstId;
      blocks.getBlock(firstId).parent = tailId;
    }
    return { ok: true };
  }

  return { ok: false, error: 'Unknown position "' + position + '"' };
}

function buildScriptBlocks(parsed, target, options) {
  const opts = options || {};
  const procRegistry = procRegistryForParsed(parsed, target);
  const allBlocks = [];
  const hatId = parsed.hat ? buildBlockStructure(parsed.hat, target, allBlocks, procRegistry) : null;
  if (hatId && opts.topLevel !== false) {
    const hatDef = allBlocks.find(b => b.id === hatId);
    if (hatDef) {
      hatDef.topLevel = true;
      hatDef.x = typeof opts.x === 'number' ? opts.x : 100 + Math.random() * 200;
      hatDef.y = typeof opts.y === 'number' ? opts.y : 100 + Math.random() * 200;
    }
  }
  let prevId = hatId;
  (parsed.blocks || []).forEach(block => {
    const blockId = buildBlockStructure(block, target, allBlocks, procRegistry);
    if (!blockId) return;
    if (prevId) {
      const prevDef = allBlocks.find(b => b.id === prevId);
      if (prevDef) prevDef.next = blockId;
      const curDef = allBlocks.find(b => b.id === blockId);
      if (curDef) curDef.parent = prevId;
    } else if (opts.topLevel !== false) {
      // Body-only script (no hat): the first block becomes the top-level one
      const curDef = allBlocks.find(b => b.id === blockId);
      if (curDef) {
        curDef.topLevel = true;
        curDef.x = typeof opts.x === 'number' ? opts.x : 100 + Math.random() * 200;
        curDef.y = typeof opts.y === 'number' ? opts.y : 100 + Math.random() * 200;
      }
    }
    prevId = blockId;
  });
  return { blocks: allBlocks, hatId: hatId, lastId: prevId };
}

/**
 * Validate a parsed DSL tree before touching the workspace.
 *
 * The point is to fail with a message the model can act on, and to fail *before* any
 * block is created — a half-applied script leaves the user's project in a state they
 * have to clean up by hand. Checks: unknown opcodes, hat blocks nested in a body,
 * C-blocks used without a body, argument counts, and non-numeric values in numeric slots.
 *
 * @returns {{errors: string[], warnings: string[]}}
 */
function validateParsedScript(parsed, target) {
  const errors = (parsed.errors || []).slice();
  const warnings = [];
  const spriteName = target && target.getName ? target.getName() : '';
  // 扩展积木动态 schema 的来源；无 target/runtime 时只能覆盖 OPCODE_SCHEMA 核心积木
  const runtime = target && target.runtime;

  const costumeNames = target && target.getCostumes
    ? target.getCostumes().map(c => c.name)
    : [];
  const soundNames = target && target.getSounds
    ? target.getSounds().map(s => s.name)
    : [];
  const spriteNames = target && target.runtime
    ? target.runtime.targets.filter(t => !t.isStage && t.isOriginal).map(t => t.getName())
    : [];

  const isHat = opcode => opcode.indexOf('event_when') === 0 || opcode === 'control_start_as_clone' ||
    opcode === 'procedures_definition';

  function checkDescriptor(desc, path, depth) {
    if (!desc || !desc.opcode) return;
    const opcode = desc.opcode;
    const schema = resolveBlockSchema(opcode, runtime);
    const where = path + ' (' + opcode + ')';

    if (opcode === 'procedures_definition' || opcode === 'procedures_call') {
      // 自定义积木不在 OPCODE_SCHEMA 里，先于 unknown-opcode 检查单独处理。
      if (opcode === 'procedures_definition') {
        if (depth > 0) {
          errors.push(where + ': hat blocks can only be the first line of a script, never nested ' +
            'inside a body or a C-block. Split this into a separate add_script operation.');
        }
        (desc.substack || []).forEach((s, i) => checkDescriptor(s, where + ' body[' + (i + 1) + ']', depth + 1));
        (desc.substack2 || []).forEach((s, i) => checkDescriptor(s, where + ' else[' + (i + 1) + ']', depth + 1));
        return;
      }
      // procedures_call：注册表查 define，占位符数与 callArgs 数对齐。
      const registry = procRegistryForParsed(parsed, target);
      const entry = desc.proccode ? registry.get(desc.proccode) : null;
      if (!entry) {
        errors.push(where + ': call 引用的自定义积木 "' + desc.proccode +
          '" 不存在：本批文本与当前角色中都没有该 define。');
        return;
      }
      const placeholders = String(desc.proccode).match(/%[sb]/g) || [];
      const callArgs = Array.isArray(desc.callArgs) ? desc.callArgs : [];
      if (callArgs.length > placeholders.length) {
        errors.push(where + ': call 参数过多："' + desc.proccode + '" 只有 ' + placeholders.length +
          ' 个占位符，但提供了 ' + callArgs.length + ' 个参数。');
      }
      for (let pi = 0; pi < placeholders.length; pi++) {
        const ph = placeholders[pi];
        const val = pi < callArgs.length ? callArgs[pi] : undefined;
        if (val === undefined || val === null || val === '') {
          if (ph === '%s') {
            errors.push(where + ': call 缺少参数：第 ' + (pi + 1) + ' 个占位符 %s 没有对应的实参。');
          } else {
            warnings.push(where + ': call 缺少参数：第 ' + (pi + 1) + ' 个占位符 %b 没有对应的实参，布尔槽留空。');
          }
          continue;
        }
        if (ph === '%b' && (val === true || val === false || val === 'true' || val === 'false')) {
          warnings.push(where + ': 布尔参数用 true/false 留空处理，建议放括号内布尔报告器');
        }
        if (val && typeof val === 'object' && val.opcode) {
          const converted = argToInputValue(val, runtime);
          // {variable}/{list} 折叠出的 data_variable/data_listcontents 是值原语形态，
          // 构建时会成为嵌套变量报告器，不按「值原语不是积木」报错。
          if (converted && typeof converted === 'object' && converted.opcode &&
              !VALUE_PRIMITIVE_OPCODES[converted.opcode]) {
            checkDescriptor(converted, where + ' → ' + ph, depth + 1);
          }
        }
      }
      (desc.substack || []).forEach((s, i) => checkDescriptor(s, where + ' body[' + (i + 1) + ']', depth + 1));
      (desc.substack2 || []).forEach((s, i) => checkDescriptor(s, where + ' else[' + (i + 1) + ']', depth + 1));
      return;
    }

    if (VALUE_PRIMITIVE_OPCODES[opcode]) {
      errors.push(where + ': 「' + opcode + '」是值原语（value primitive），不是积木。数值/文本应直接写在参数里（例如 motion_movesteps 10），或放进对应积木的参数槽。');
      return;
    }
    if (!schema) {
      if (runtime) {
        errors.push(where + ': 「' + opcode + '」来自未加载或未知的扩展积木，无法解析其参数。请先在扩展库加载对应扩展后再应用。');
      } else {
        errors.push(where + ': unknown opcode. It is not in the supported block dictionary — ' +
          'check spelling, or use develop_extension if the block comes from an extension.');
      }
      return;
    }
    if (depth > 0 && isHat(opcode)) {
      errors.push(where + ': hat blocks can only be the first line of a script, never nested ' +
        'inside a body or a C-block. Split this into a separate add_script operation.');
    }
    if ((schema.substack || schema.substack2) && !schema.optionalBody &&
        (!desc.substack || desc.substack.length === 0) &&
        (!desc.substack2 || desc.substack2.length === 0)) {
      warnings.push(where + ': C-block has an empty body. Indent the blocks that belong inside it by two spaces.');
    }
    if (!schema.substack && desc.substack && desc.substack.length > 0) {
      errors.push(where + ': this block has no body slot, but ' + desc.substack.length +
        ' block(s) were indented under it. Remove the indentation.');
    }
    if (!schema.substack2 && desc.substack2 && desc.substack2.length > 0) {
      errors.push(where + ': this block has no else branch, so "else" is not valid here.');
    }

    // Extra positional tokens land in ARG1/ARG2… which Scratch cannot render.
    Object.keys(desc.inputs || {}).forEach(key => {
      if (/^ARG\d+$/.test(key)) {
        errors.push(where + ': too many arguments. This block takes ' + schema.args.length +
          ' (' + (schema.args.map(a => a.name).join(', ') || 'none') + ').');
      }
    });

    schema.args.forEach(argDef => {
      const provided = Object.prototype.hasOwnProperty.call(desc.inputs || {}, argDef.name) ||
        Object.prototype.hasOwnProperty.call(desc.fields || {}, argDef.name);
      if (!provided && !argDef.bool) {
        warnings.push(where + ': argument ' + argDef.name + ' is missing; Scratch will use its default.');
        return;
      }
      const raw = (desc.inputs || {})[argDef.name];
      if (raw === undefined || raw === null) return;
      if (typeof raw === 'object' && raw.opcode) {
        // $var/@list 简写经 argToInputValue 展开成的 data_variable/data_listcontents
        // 描述符是合法取值器（序列化端会还原成 $x/@x），与 call 参数路径一致放行；
        // 其内部没有可再嵌套的输入，无需递归校验。
        if (!VALUE_PRIMITIVE_OPCODES[raw.opcode]) {
          checkDescriptor(raw, where + ' → ' + argDef.name, depth + 1);
        }
        return;
      }
      if (typeof raw === 'object') return; // {VARIABLE}/{LIST} shorthand
      const shadow = argDef.shadow;
      if (shadow && SHADOW_VALUE_FIELD[shadow] && shadow !== 'text' && shadow !== 'colour_picker') {
        const num = Number(String(raw).trim());
        if (String(raw).trim() === '' || isNaN(num)) {
          warnings.push(where + ': ' + argDef.name + ' expects a number but got "' + raw +
            '". It will be kept as text, which Scratch reads as 0 in arithmetic.');
        }
      }
    });

    // Dropdown values that reference project assets: a typo produces a block that
    // silently does nothing, so surface it while the model can still fix it.
    const menuChecks = [
      { opcodes: ['looks_switchcostumeto'], arg: 'COSTUME', pool: costumeNames, label: 'costume' },
      { opcodes: ['sound_play', 'sound_playuntildone'], arg: 'SOUND_MENU', pool: soundNames, label: 'sound' }
    ];
    menuChecks.forEach(check => {
      if (check.opcodes.indexOf(opcode) < 0 || check.pool.length === 0) return;
      const val = (desc.inputs || {})[check.arg] !== undefined
        ? (desc.inputs || {})[check.arg]
        : (desc.fields || {})[check.arg];
      if (val === undefined || val === null || typeof val === 'object') return;
      if (check.pool.indexOf(String(val)) < 0) {
        warnings.push(where + ': ' + check.label + ' "' + val + '" does not exist on ' +
          (spriteName || 'this sprite') + '. Available: ' + check.pool.join(', '));
      }
    });
    if (opcode === 'control_create_clone_of' || opcode === 'sensing_touchingobject' ||
        opcode === 'motion_goto' || opcode === 'motion_glideto' || opcode === 'motion_pointtowards') {
      const argName = schema.args.filter(a => a.kind === 'menu').map(a => a.name)[0];
      const val = argName ? (desc.inputs || {})[argName] : undefined;
      if (typeof val === 'string' && val.charAt(0) !== '_' && spriteNames.length &&
          spriteNames.indexOf(val) < 0) {
        warnings.push(where + ': "' + val + '" is neither a special value (_myself_, _mouse_, ' +
          '_edge_, _random_) nor an existing sprite. Available sprites: ' + spriteNames.join(', '));
      }
    }

    (desc.substack || []).forEach((s, i) => checkDescriptor(s, where + ' body[' + (i + 1) + ']', depth + 1));
    (desc.substack2 || []).forEach((s, i) => checkDescriptor(s, where + ' else[' + (i + 1) + ']', depth + 1));
  }

  if (parsed.hat) checkDescriptor(parsed.hat, 'hat', 0);
  (parsed.blocks || []).forEach((b, i) => checkDescriptor(b, 'line ' + (i + 1), 0));
  return { errors: errors, warnings: warnings };
}

/** One place to phrase "nothing was changed" rejections so every caller reads alike. */
function formatValidationError(errors, scriptText) {
  const head = 'Script rejected before applying — the project was NOT modified. Fix these and retry:';
  const body = errors.map(e => '  - ' + e).join('\n');
  const tail = scriptText ? '\nScript text:\n' + String(scriptText).substring(0, 600) : '';
  return head + '\n' + body + tail;
}

/**
 * Serialize one live VM block back into a DSL line, walking OPCODE_SCHEMA in order.
 *
 * Emitting "all inputs then all fields" (the previous approach) breaks the round trip:
 * `data_addtolist` stores ITEM as an input and LIST as a field, so that order produced
 * `data_addtolist 100 @scores`, which parses back as list="100", item="scores". Walking
 * the schema keeps every token in the slot the parser will read it from.
 *
 * @param {object} blk block record from target.blocks._blocks
 * @param {object} blocks the whole _blocks map, for following input references
 * @param {number} depth recursion guard for nested reporters
 * @param {object} [runtime] VM runtime，用于扩展积木的动态 schema 解析
 * @returns {string} one DSL line without indentation
 */
function serializeBlockToDsl(blk, blocks, depth, runtime) {
  depth = depth || 0;
  if (!blk || !blk.opcode) return '';
  const escapeDsl = v => String(v)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
  const quote = v => '"' + escapeDsl(v) + '"';
  // 变量/列表名：含空白、引号或反斜杠时用带引号形式（$"my var" / @"my list"）
  const nameToken = (prefix, name) => /[\s"\\]/.test(String(name))
    ? prefix + '"' + escapeDsl(name) + '"'
    : prefix + name;

  // Value of whatever sits in one input slot, as a DSL token.
  const tokenForInput = (inputName) => {
    const inp = blk.inputs && blk.inputs[inputName];
    if (!inp || !inp.block) return null;
    const sub = blocks[inp.block];
    if (!sub) return null;
    const isShadow = inp.block === inp.shadow;
    if (isShadow) {
      const valueField = SHADOW_VALUE_FIELD[sub.opcode];
      if (valueField && sub.fields && sub.fields[valueField]) {
        const raw = sub.fields[valueField].value;
        if (sub.opcode === 'text' || sub.opcode === 'colour_picker') return quote(raw);
        return String(raw);
      }
      if (sub.opcode === 'data_variable') return nameToken('$', sub.fields.VARIABLE.value);
      if (sub.opcode === 'data_listcontents') return nameToken('@', sub.fields.LIST.value);
      // Menu shadow (sound_sounds_menu, motion_goto_menu, event_broadcast_menu, …)
      const menuKeys = sub.fields ? Object.keys(sub.fields) : [];
      for (let i = 0; i < menuKeys.length; i++) {
        const mf = sub.fields[menuKeys[i]];
        const mfv = mf && typeof mf === 'object' ? mf.value : mf;
        if (mfv !== null && mfv !== undefined) return quote(mfv);
      }
      return null;
    }
    // A real reporter is plugged in
    if (sub.opcode === 'data_variable' && sub.fields && sub.fields.VARIABLE) {
      return nameToken('$', sub.fields.VARIABLE.value);
    }
    if (sub.opcode === 'data_listcontents' && sub.fields && sub.fields.LIST) {
      return nameToken('@', sub.fields.LIST.value);
    }
    // %参数 引用：还原成裸 %名称（不是括号包裹的报告器），与解析端的 %名称 token 对应
    if (sub.opcode === 'argument_reporter_string_number' || sub.opcode === 'argument_reporter_boolean') {
      const f = sub.fields && sub.fields.VALUE;
      const nm = f ? (typeof f === 'object' ? f.value : f) : '';
      return '%' + String(nm == null ? '' : nm);
    }
    if (depth > 6) return '(' + sub.opcode + ')'; // pathological nesting guard
    return '(' + serializeBlockToDsl(sub, blocks, depth + 1, runtime) + ')';
  };

  const tokenForField = (fieldName) => {
    const f = blk.fields && blk.fields[fieldName];
    if (!f) return null;
    const value = typeof f === 'object' ? f.value : f;
    if (value === null || value === undefined) return null;
    if (fieldName === 'VARIABLE') return nameToken('$', value);
    if (fieldName === 'LIST') return nameToken('@', value);
    return quote(value);
  };

  // 自定义积木三类块在 generic 分支前拦截（procedures_* 不在 OPCODE_SCHEMA，
  // argument_reporter 要还原成 %参数）。
  if (blk.opcode === 'procedures_definition') {
    const cb = blk.inputs && blk.inputs.custom_block ? blocks[blk.inputs.custom_block.block] : null;
    const mutation = (cb && cb.mutation) || {};
    const proccode = String(mutation.proccode == null ? '' : mutation.proccode);
    let argNames = [];
    try { argNames = JSON.parse(mutation.argumentnames || '[]'); } catch (e) { argNames = []; }
    if (!Array.isArray(argNames)) argNames = [];
    // argumentnames 与 proccode 占位符按下标 zip，还原 (名)/<名> 显示形式
    let ai = 0;
    const display = proccode.replace(/%[sb]/g, ph => {
      const nm = ai < argNames.length && argNames[ai] != null ? String(argNames[ai]) : 'arg' + (ai + 1);
      ai++;
      return ph === '%b' ? '<' + nm + '>' : '(' + nm + ')';
    });
    return 'define ' + display + (String(mutation.warp) === 'true' ? ' warp=true' : '');
  }
  if (blk.opcode === 'procedures_call') {
    const mutation = blk.mutation || {};
    const proccode = String(mutation.proccode == null ? '' : mutation.proccode);
    let argIds = [];
    try { argIds = JSON.parse(mutation.argumentids || '[]'); } catch (e) { argIds = []; }
    if (!Array.isArray(argIds)) argIds = [];
    const callParts = ['call', quote(proccode)];
    argIds.forEach(argId => {
      const token = tokenForInput(argId);
      // null 只有空的 %b 会遇到（无输入可序列化），此时省略该 token
      if (token !== null) callParts.push(token);
    });
    return callParts.join(' ');
  }
  if (blk.opcode === 'argument_reporter_string_number' || blk.opcode === 'argument_reporter_boolean') {
    const f = blk.fields && blk.fields.VALUE;
    const nm = f ? (typeof f === 'object' ? f.value : f) : '';
    return '%' + String(nm == null ? '' : nm);
  }

  const parts = [blk.opcode];
  // 核心积木直接命中 OPCODE_SCHEMA；扩展积木带 runtime 时走 _blockInfo 推导的动态 schema，
  // 无 runtime 且不在 OPCODE_SCHEMA → 走后面的 unknown best-effort 分支。
  const schema = resolveBlockSchema(blk.opcode, runtime);
  const usedInputs = {};
  const usedFields = {};

  if (schema && Array.isArray(schema.args)) {
    for (let i = 0; i < schema.args.length; i++) {
      const argDef = schema.args[i];
      let token = null;
      if (argDef.kind === 'field') {
        token = tokenForField(argDef.name);
        if (token !== null) usedFields[argDef.name] = true;
      } else {
        token = tokenForInput(argDef.name);
        if (token !== null) {
          usedInputs[argDef.name] = true;
        } else {
          token = tokenForField(argDef.name);
          if (token !== null) usedFields[argDef.name] = true;
        }
      }
      // A boolean slot is legitimately empty; anything else needs a placeholder or
      // every later token would shift one slot left when parsed back.
      if (token === null) {
        if (argDef.bool) continue;
        token = argDef.kind === 'field' || argDef.shadow === 'text' ? '""' : '0';
      }
      parts.push(token);
    }
  } else {
    // Unknown opcode (extension block): best effort, inputs then fields.
    Object.keys(blk.inputs || {}).forEach(function(key) {
      if (key === 'SUBSTACK' || key === 'SUBSTACK2') return;
      const token = tokenForInput(key);
      if (token !== null) parts.push(token);
    });
    Object.keys(blk.fields || {}).forEach(function(key) {
      const token = tokenForField(key);
      if (token !== null) parts.push(token);
    });
  }
  return parts.join(' ');
}

/**
 * NeoWarp: 把一个 target（角色或舞台）的全部顶层脚本序列化为 DSL 文本。
 * 遍历 blocks._blocks 中的 topLevel 脚本，处理 SUBSTACK/SUBSTACK2 的 2 空格
 * 缩进与 else 行，输出与 AI 助手 getSpriteScripts 工具完全一致。
 *
 * @param {object} target VM target（vm.editingTarget 或按名查找的结果）
 * @returns {Array<{blockId: string, dsl: string}>}
 */
function collectTargetDsl(target) {
  const runtime = target && target.runtime; // 扩展积木序列化需要动态 schema
  const scripts = [];
  const allBlocks = target.blocks._blocks;
  Object.keys(allBlocks).forEach(function(blockId) {
    const b = allBlocks[blockId];
    if (!b.topLevel || b.parent !== null) return;
    // 漂浮值块（拖到画布上的独立 shadow/reporter）：不是可执行语句，序列化成注释行。
    // 解析端忽略 # 开头的行，这样面板自产文本重新应用时始终可用、不会校验失败。
    if (b.shadow === true || VALUE_PRIMITIVE_OPCODES[b.opcode] ||
        (b.opcode && b.opcode.indexOf('argument_reporter_') === 0)) {
      scripts.push({ blockId: blockId, dsl: '# 漂浮值块: ' + serializeBlockToDsl(b, allBlocks, 0, runtime) });
      return;
    }
    const dslLines = [];
    const emitBlock = (blk, ind) => {
      dslLines.push('  '.repeat(ind) + serializeBlockToDsl(blk, allBlocks, 0, runtime));
      if (blk.inputs && blk.inputs.SUBSTACK && blk.inputs.SUBSTACK.block) {
        let sub = allBlocks[blk.inputs.SUBSTACK.block];
        while (sub) {
          emitBlock(sub, ind + 1);
          sub = sub.next ? allBlocks[sub.next] : null;
        }
      }
      if (blk.inputs && blk.inputs.SUBSTACK2 && blk.inputs.SUBSTACK2.block) {
        dslLines.push('  '.repeat(ind) + 'else');
        let sub2 = allBlocks[blk.inputs.SUBSTACK2.block];
        while (sub2) {
          emitBlock(sub2, ind + 1);
          sub2 = sub2.next ? allBlocks[sub2.next] : null;
        }
      }
      if (blk.next) {
        if (blk.opcode === 'procedures_definition') {
          // define hat 的身体是 next 链：以 ind+1 缩进输出，重解析时才能回到 define 体内
          let sub = allBlocks[blk.next];
          while (sub) {
            emitBlock(sub, ind + 1);
            sub = sub.next ? allBlocks[sub.next] : null;
          }
        } else if (ind === 0) {
          emitBlock(allBlocks[blk.next], 0);
        }
      }
    };
    emitBlock(b, 0);
    scripts.push({ blockId: blockId, dsl: dslLines.join('\n') });
  });
  return scripts;
}

function convertBlockObjToDsl(obj, indent, runtime) {
  indent = indent || 0;
  var pad = '  '.repeat(indent);
  if (!obj || !obj.opcode) return [];

  var rawInputs = obj.inputs || {};
  var rawFields = obj.fields || {};

  var fieldValue = function(key) {
    var fv = rawFields[key];
    if (fv && typeof fv === 'object') fv = fv.value;
    return fv;
  };
  var escapeDslText = function(v) {
    return String(v)
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r')
      .replace(/\t/g, '\\t');
  };
  var nameToken = function(prefix, name) {
    return /[\s"\\]/.test(String(name)) ? prefix + '"' + escapeDslText(name) + '"' : prefix + name;
  };
  var encodeInput = function(val) {
    if (typeof val === 'number') return String(val);
    if (typeof val === 'boolean') return val ? 'true' : 'false';
    if (typeof val === 'string') return '"' + escapeDslText(val) + '"';
    if (val && typeof val === 'object') {
      if (val.opcode) return '(' + convertBlockObjToDsl(val, 0, runtime).join(' ') + ')';
      // Variable/list reporter shorthand used by some callers
      if (val.VARIABLE) return '$' + val.VARIABLE;
      if (val.LIST) return '@' + val.LIST;
    }
    return null;
  };
  var encodeField = function(key) {
    var fv = fieldValue(key);
    if (fv === undefined || fv === null) return null;
    if (key === 'VARIABLE') return nameToken('$', fv);
    if (key === 'LIST') return nameToken('@', fv);
    return '"' + escapeDslText(fv) + '"';
  };

  var parts = [obj.opcode];
  // 扩展积木带 runtime 时走 _blockInfo 推导的动态 schema；否则只认 OPCODE_SCHEMA
  var schema = resolveBlockSchema(obj.opcode, runtime);
  var usedInputs = {};
  var usedFields = {};

  if (schema && Array.isArray(schema.args)) {
    // Walk the schema in order so each token lands in its declared slot.
    for (var ai = 0; ai < schema.args.length; ai++) {
      var argDef = schema.args[ai];
      var token = null;
      if (argDef.kind === 'field') {
        if (Object.prototype.hasOwnProperty.call(rawFields, argDef.name)) {
          token = encodeField(argDef.name);
          usedFields[argDef.name] = true;
        } else if (Object.prototype.hasOwnProperty.call(rawInputs, argDef.name)) {
          // Tolerate models that put a menu value under inputs
          token = encodeInput(rawInputs[argDef.name]);
          usedInputs[argDef.name] = true;
        }
      } else {
        if (Object.prototype.hasOwnProperty.call(rawInputs, argDef.name)) {
          token = encodeInput(rawInputs[argDef.name]);
          usedInputs[argDef.name] = true;
        } else if (Object.prototype.hasOwnProperty.call(rawFields, argDef.name)) {
          token = encodeField(argDef.name);
          usedFields[argDef.name] = true;
        }
      }
      // A missing middle argument would shift every later token, so emit a
      // placeholder to keep positions aligned.
      parts.push(token === null ? (argDef.kind === 'field' ? '""' : '0') : token);
    }
  }

  // Anything the schema didn't cover (unknown opcode, extra args) keeps the old
  // inputs-then-fields order as a best effort.
  Object.keys(rawInputs).forEach(function(key) {
    if (key === 'SUBSTACK' || key === 'SUBSTACK2' || usedInputs[key]) return;
    var token = encodeInput(rawInputs[key]);
    if (token !== null) parts.push(token);
  });
  Object.keys(rawFields).forEach(function(key) {
    if (usedFields[key]) return;
    var token = encodeField(key);
    if (token !== null) parts.push(token);
  });

  var lines = [pad + parts.join(' ')];
  // Substacks may arrive either under inputs.SUBSTACK or as obj.substack
  var subSource = (obj.inputs && obj.inputs.SUBSTACK) || obj.substack;
  if (subSource) {
    var subArr = Array.isArray(subSource) ? subSource : [subSource];
    subArr.forEach(function(b) {
      convertBlockObjToDsl(b, indent + 1, runtime).forEach(function(l) { lines.push(l); });
    });
  }
  var sub2Source = (obj.inputs && obj.inputs.SUBSTACK2) || obj.substack2;
  if (sub2Source) {
    lines.push(pad + 'else');
    var sub2Arr = Array.isArray(sub2Source) ? sub2Source : [sub2Source];
    sub2Arr.forEach(function(b) {
      convertBlockObjToDsl(b, indent + 1, runtime).forEach(function(l) { lines.push(l); });
    });
  }
  if (obj.next) {
    convertBlockObjToDsl(obj.next, indent, runtime).forEach(function(l) { lines.push(l); });
  }
  return lines;
}

// Parse Scratch block DSL text into {hat: descriptor, blocks: [descriptor, ...]}.
function parseScratchDSL(scriptText, target) {
  // 扩展积木动态 schema 来源（target.runtime）；变量/列表 id 解析仍在 buildBlockStructure
  const runtime = target && target.runtime;
  const warnings = [];
  const errors = [];
  const defines = []; // 本段文本中的自定义积木定义（proc 对象）
  const rawLines = String(scriptText == null ? '' : scriptText).split('\n');
  const parsedLines = [];
  for (let li = 0; li < rawLines.length; li++) {
    const line = rawLines[li];
    // Normalize: convert leading tabs to 2 spaces each for indent calculation
    const indentMatch = line.match(/^[\t ]*/);
    const indentRaw = indentMatch ? indentMatch[0] : '';
    const indentSpaces = indentRaw.replace(/\t/g, '  ').length;
    const indent = Math.floor(indentSpaces / 2);
    const trimmed = line.replace(/^[\t ]+/, '').replace(/\s+$/, '');
    if (trimmed.length === 0 || trimmed.charAt(0) === '#') continue;
    parsedLines.push({ indent, content: trimmed, lineNo: li + 1 });
  }

  if (parsedLines.length === 0) {
    return { hat: { opcode: 'event_whenflagclicked', inputs: {}, fields: {} }, blocks: [], defines, warnings, errors };
  }

  // Determine hat. First line (indent 0) is the hat if it looks like one.
  const firstLine = parsedLines[0];
  let hatDescriptor;
  let bodyStartIdx;
  if (isDefineLine(firstLine.content)) {
    // define 行是自定义积木的 hat：proccode/参数表由 parseDefineLine 扫描得出，
    // 身体从下一行开始（bodyStartIdx=1）。
    const node = parseDefineLine(firstLine.content, firstLine.lineNo);
    hatDescriptor = { opcode: 'procedures_definition', inputs: {}, fields: {}, proc: node.proc, lineNo: firstLine.lineNo };
    defines.push(node.proc);
    bodyStartIdx = 1;
  } else {
    let firstParsed;
    try {
      firstParsed = parseDslLine(firstLine.content, runtime);
    } catch (e) {
      throw new Error('line ' + firstLine.lineNo + ': ' + e.message + ' (near: "' + firstLine.content.substring(0, 60) + '")');
    }
    const isFirstHat = firstParsed.opcode.indexOf('event_') === 0 || firstParsed.opcode === 'control_start_as_clone';
    if (isFirstHat) {
      if (!resolveBlockSchema(firstParsed.opcode, runtime)) {
        warnings.push('line ' + firstLine.lineNo + ': unknown opcode "' + firstParsed.opcode + '" (not in OPCODE_SCHEMA, block may not work correctly)');
      }
      hatDescriptor = mapArgsToDescriptor(firstParsed.opcode, firstParsed.args, runtime);
      bodyStartIdx = 1;
    } else {
      hatDescriptor = { opcode: 'event_whenflagclicked', inputs: {}, fields: {} };
      bodyStartIdx = 0;
    }
  }

  // Build the body tree using a stack.
  const rootNodes = [];
  const stack = []; // entries: {node, indent, inElse}
  let prevNode = null;
  let prevIndent = 0;
  let prevHadSubstack = false;
  for (let bi = bodyStartIdx; bi < parsedLines.length; bi++) {
    const { indent, content, lineNo } = parsedLines[bi];

    if (content === 'else') {
      // Mark the matching C-block entry (same indent) as being in its else branch.
      // 只接受「同缩进且支持 else 分支（substack2）」的栈项；栈空、缩进对不上、
      // 或匹配项不支持 else 时报错，避免 else 被静默吞掉或错误归入其它积木。
      let elseMatched = false;
      for (let sj = stack.length - 1; sj >= 0; sj--) {
        const entrySchema = resolveBlockSchema(stack[sj].node.opcode, runtime);
        if (stack[sj].indent === indent && entrySchema && entrySchema.substack2) {
          stack[sj].inElse = true;
          elseMatched = true;
          break;
        }
      }
      if (!elseMatched) {
        errors.push('line ' + lineNo + ': "else" 没有匹配到同缩进的 if/if_else 积木。');
      }
      continue;
    }

    // define/call 行在 parseDslLine 之前拦截：它们的语法不是「opcode + 位置参数」。
    let node;
    let hasSubstack = false;
    if (isDefineLine(content)) {
      node = parseDefineLine(content, lineNo);
      defines.push(node.proc);
    } else if (isCallLine(content)) {
      node = parseCallLine(content, lineNo);
    } else {
      let parsed;
      try {
        parsed = parseDslLine(content, runtime);
      } catch (e) {
        throw new Error('line ' + lineNo + ': ' + e.message + ' (near: "' + content.substring(0, 60) + '")');
      }
      const schema = resolveBlockSchema(parsed.opcode, runtime);
      if (!schema) {
        warnings.push('line ' + lineNo + ': unknown opcode "' + parsed.opcode + '" (not in OPCODE_SCHEMA, block may not work correctly)');
      }
      hasSubstack = !!(schema && (schema.substack === true || schema.substack2 === true));
      node = {
        opcode: parsed.opcode,
        rawArgs: parsed.args,
        indent,
        substack: [],
        substack2: []
      };
    }
    node.indent = indent;
    node.lineNo = lineNo;

    // Indenting under a block with no body slot would otherwise be silently dropped:
    // the line just becomes a sibling and the model never learns its nesting was lost.
    if (prevNode && indent > prevIndent && !prevHadSubstack) {
      errors.push('line ' + lineNo + ': "' + node.opcode + '" is indented under "' +
        prevNode.opcode + '", which has no body slot. Only C-blocks (repeat, forever, if, ...) ' +
        'can contain blocks. Remove the indentation.');
    }
    prevNode = node;
    prevIndent = indent;
    prevHadSubstack = hasSubstack;

    // Pop until top has indent < current indent.
    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }

    if (stack.length === 0) {
      rootNodes.push(node);
    } else {
      const top = stack[stack.length - 1];
      if (top.inElse) {
        top.node.substack2.push(node);
      } else {
        top.node.substack.push(node);
      }
    }

    if (hasSubstack) {
      stack.push({ node, indent, inElse: false });
    }
  }

  const blocks = rootNodes.map(node => convertNode(node, runtime));
  // %参数 引用：按最近 define 的参数类型翻转 reporter 类型；define 体外引用记错误。
  // define hat 的身体是根节点列表，因此用它的参数表遍历全部根块。
  let hatProcMap = null;
  if (hatDescriptor && hatDescriptor.opcode === 'procedures_definition' && hatDescriptor.proc) {
    hatProcMap = procParamMap(hatDescriptor.proc);
  }
  applyArgumentRefs(hatDescriptor, null, errors);
  blocks.forEach(b => applyArgumentRefs(b, hatProcMap, errors));
  return { hat: hatDescriptor, blocks, defines, warnings, errors };
}

/* ══════════════════════════════════════════════════════════════════════════
   角色 / 变量 / 列表工具的共用辅助
   这些工具原来各自内联解析目标与变量，导致三类问题：
     1. 变量查找用 Object.values(target.variables).find(byName)，不会像 Scratch
        那样回退到舞台，于是"给了 sprite_name 就改不到全局变量"；
     2. 查找不带类型，set_variable 传一个列表名会把数组覆盖成字符串；
     3. 报错只有 "Variable not found"，模型不知道有哪些名字可用、也不知道拼错了。
   统一到这里之后，作用域、类型、报错措辞在所有工具里保持一致。
   ══════════════════════════════════════════════════════════════════════════ */

/** 把数字形态的字符串转成数字，与 Scratch 自身的宽松类型一致。 */
function coerceScratchValue(value) {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (trimmed === '') return value;
  const num = Number(trimmed);
  return isNaN(num) ? value : num;
}

const STAGE_ALIASES = ['stage', '_stage_', '舞台', 'background', 'backdrop'];

/**
 * 解析变量/列表所属的目标。
 * 不传 sprite_name（或写成 Stage）表示全局，落在舞台上。
 * @returns {{target: ?object, error: ?string}}
 */
function resolveDataTarget(vm, params) {
  const raw = params.spriteName || params.sprite_name || params.targetName;
  const stage = vm.runtime.getTargetForStage();
  if (params.targetId) {
    const byId = vm.runtime.getTargetById(params.targetId);
    if (byId) return { target: byId, error: null };
  }
  if (!raw || STAGE_ALIASES.indexOf(String(raw).trim().toLowerCase()) >= 0) {
    return { target: stage, error: null };
  }
  const name = String(raw);
  const found = vm.runtime.targets.find(t => !t.isStage && t.getName() === name);
  if (found) return { target: found, error: null };
  const available = vm.runtime.targets.filter(t => !t.isStage && t.isOriginal).map(t => t.getName());
  return {
    target: null,
    error: 'Sprite "' + name + '" not found. Available sprites: ' +
      (available.length ? available.join(', ') : '(none)') +
      '. Omit sprite_name to use the Stage (global scope).'
  };
}

/** 名字打错时给出最接近的候选，比单纯罗列全部更有用。 */
function closestName(name, candidates) {
  const lower = String(name).toLowerCase();
  let best = null;
  let bestScore = 0;
  candidates.forEach(candidate => {
    const c = candidate.toLowerCase();
    let score = 0;
    if (c === lower) score = 100;
    else if (c.indexOf(lower) >= 0 || lower.indexOf(c) >= 0) score = 60 + Math.min(20, c.length);
    else {
      // 共同前缀长度，够简单也够用
      let i = 0;
      while (i < c.length && i < lower.length && c[i] === lower[i]) i++;
      score = i * 4;
    }
    if (score > bestScore) { bestScore = score; best = candidate; }
  });
  return bestScore >= 8 ? best : null;
}

/**
 * 在作用域内查找变量或列表：先找目标自己的，再回退到舞台，与 Scratch 一致。
 * @param {string} type '' 表示普通变量，'list' 表示列表
 * @returns {{variable: ?object, owner: ?object, scope: string, error: ?string}}
 */
function findDataVariable(vm, target, name, type) {
  const label = type === 'list' ? 'List' : 'Variable';
  if (!name) return { variable: null, owner: null, scope: '', error: 'No ' + label.toLowerCase() + ' name provided' };
  const stage = vm.runtime.getTargetForStage();

  const local = Object.values(target.variables).find(v => v.name === name && v.type === type);
  if (local) {
    return { variable: local, owner: target, scope: target.isStage ? 'global' : 'local', error: null };
  }
  if (!target.isStage && stage) {
    const global = Object.values(stage.variables).find(v => v.name === name && v.type === type);
    if (global) return { variable: global, owner: stage, scope: 'global', error: null };
  }

  // 同名但类型不对：这是最容易踩的坑，单独说清楚，别报 "not found"
  const wrongType = Object.values(target.variables).find(v => v.name === name) ||
    (!target.isStage && stage ? Object.values(stage.variables).find(v => v.name === name) : null);
  if (wrongType) {
    const actual = wrongType.type === 'list' ? 'a list' : 'a variable';
    const wanted = type === 'list' ? 'a list' : 'a variable';
    return {
      variable: null, owner: null, scope: '',
      error: '"' + name + '" is ' + actual + ', not ' + wanted +
        '. Use the ' + (wrongType.type === 'list' ? 'list' : 'variable') + ' tools for it.'
    };
  }

  const inScope = target.getAllVariableNamesInScopeByType(type);
  const suggestion = closestName(name, inScope);
  return {
    variable: null, owner: null, scope: '',
    error: label + ' "' + name + '" not found on ' +
      (target.isStage ? 'the Stage' : target.getName() + ' or the Stage') + '.' +
      (suggestion ? ' Did you mean "' + suggestion + '"?' : '') +
      ' In scope: ' + (inScope.length ? inScope.join(', ') : '(none)') + '.'
  };
}

/** 列表内容摘要：给模型看结果，避免它为了确认再读一次。 */
function listPreview(items, limit) {
  const max = limit || 20;
  const arr = Array.isArray(items) ? items : [];
  const shown = arr.slice(0, max);
  return {
    length: arr.length,
    items: shown,
    truncated: arr.length > shown.length ? arr.length - shown.length : 0
  };
}

/** 把 1 基下标（含 'first'/'last'/'all' 别名）解析成 0 基数组下标。 */
function resolveListIndex(raw, length, opts) {
  const allowAppend = !!(opts && opts.allowAppend);
  const upper = allowAppend ? length + 1 : length;
  if (raw === undefined || raw === null || raw === '') {
    return allowAppend ? { index: length, error: null } : { index: -1, error: 'No index provided' };
  }
  const token = String(raw).trim().toLowerCase();
  if (token === 'last') return { index: allowAppend ? length : length - 1, error: null };
  if (token === 'first') return { index: 0, error: null };
  const parsed = parseInt(raw, 10);
  if (isNaN(parsed)) {
    return { index: -1, error: 'Index must be a number (1 = first), or "first"/"last". Got: ' + raw };
  }
  if (parsed < 1 || parsed > upper) {
    return {
      index: -1,
      error: 'Index ' + parsed + ' is out of range. The list has ' + length + ' item(s), so valid values are 1' +
        (upper >= 1 ? '–' + upper : '') + (allowAppend ? ' (' + upper + ' appends to the end)' : '') + '.'
    };
  }
  return { index: parsed - 1, error: null };
}

/* ── AI 更改快照 ──
   撤销功能的存储层。快照是完整的 sb3 压缩包（含资产），只存活在编辑器渲染进程的
   内存里：不落盘是因为它只服务于"这次对话内的撤销"，用户重开编辑器后本就该失效；
   不经 IPC 传给 AI 窗口是因为体积可达几十 MB。 */
const aiSnapshots = new Map();
const aiSnapshotOrder = [];
const AI_SNAPSHOT_LIMIT = 4;

// NeoWarp: 「源代码Beta」标签页面板 —— 内嵌在编辑器第 4 个 TabPanel 中，
// 与造型/声音同级的完整区域：左侧行号、可编辑 DSL 文本、应用到积木。
// 序列化复用 collectTargetDsl（与 AI 助手 getSpriteScripts 输出一致），
// 应用复用 parseScratchDSL/validateParsedScript/buildScriptBlocks（与
// AI 助手 addScript 同一条链路）。样式见 editor/gui/gui.css。
const SOURCE_CODE_REFRESH_DELAY = 300;

/**
 * 把「源代码Beta」面板的文本应用到 target：按空行拆成多个脚本段，逐段
 * 解析（parseScratchDSL）并校验（validateParsedScript），全部通过后一次性
 * 替换 target 的全部顶层脚本（先删后建，与 AI 助手 addScript 相同的构建
 * 链路）。任何一段失败都不会改动 VM，避免留下半套脚本。
 *
 * @param {object} vm VirtualMachine
 * @param {object} target 目标（角色或舞台）
 * @param {string} text 面板中的 DSL 文本
 * @returns {{success: boolean, scripts?: number, blocks?: number,
 *            warnings?: string[], error?: string}}
 */
function applyDslTextToTarget(vm, target, text) {
  const chunks = String(text == null ? '' : text)
    .split(/\n[ \t]*\n/)
    .map(chunk => chunk.replace(/^\s+|\s+$/g, ''))
    // 只含注释/空白的段不生成任何积木，直接跳过
    .filter(chunk => chunk.split('\n').some(line => {
      const trimmed = line.trim();
      return trimmed.length > 0 && trimmed.charAt(0) !== '#';
    }));

  // 1. 解析全部脚本段（define/call 的行级解析错误在这里抛出）
  const parsedScripts = [];
  const warnings = [];
  for (let i = 0; i < chunks.length; i++) {
    let parsed;
    try {
      parsed = parseScratchDSL(chunks[i], target);
    } catch (e) {
      return { success: false, error: 'DSL 解析错误（第 ' + (i + 1) + ' 个脚本）：' + (e.message || String(e)) };
    }
    parsedScripts.push(parsed);
  }

  // 2. 组装自定义积木注册表：VM 现有 define 为底，本批文本 define 覆盖（先查重）。
  //    替换全部脚本会删掉 VM 里旧 define，所以文本 define 必须重新分配参数 id。
  const vmRegistry = collectProcRegistry(target);
  const registry = new Map(vmRegistry);
  const textDefineProccodes = [];
  for (let i = 0; i < parsedScripts.length; i++) {
    const defines = parsedScripts[i].defines || [];
    for (let di = 0; di < defines.length; di++) {
      const proc = defines[di];
      if (textDefineProccodes.indexOf(proc.proccode) >= 0) {
        return { success: false, error: '重复定义自定义积木 "' + proc.proccode + '"：同一批文本中 define 了两次。' };
      }
      textDefineProccodes.push(proc.proccode);
    }
  }
  if (textDefineProccodes.length > 0) {
    parsedScripts.forEach(parsed => registerTextDefines(registry, parsed.defines));
  }

  // 3. registry 挂到每个 parsed，校验与构建共用同一套参数 id。
  parsedScripts.forEach(parsed => { parsed.procRegistry = registry; });

  // 4. call 悬空警告：define 只存在于 VM（本批文本没有）时，替换全部脚本会把它删掉。
  parsedScripts.forEach(parsed => {
    const walkCalls = desc => {
      if (!desc || typeof desc !== 'object' || !desc.opcode) return;
      if (desc.opcode === 'procedures_call' &&
          textDefineProccodes.indexOf(desc.proccode) < 0 &&
          vmRegistry.has(desc.proccode)) {
        warnings.push('call 引用 "' + desc.proccode +
          '"：其 define 不在本次文本中，应用（替换全部脚本）后该定义会被删除，调用将悬空。');
      }
      (desc.substack || []).forEach(walkCalls);
      (desc.substack2 || []).forEach(walkCalls);
    };
    if (parsed.hat) walkCalls(parsed.hat);
    (parsed.blocks || []).forEach(walkCalls);
  });

  // 5. 校验全部通过后才动 VM，避免留下半套脚本。
  for (let i = 0; i < parsedScripts.length; i++) {
    const validation = validateParsedScript(parsedScripts[i], target);
    if (validation.errors.length > 0) {
      return { success: false, error: formatValidationError(validation.errors, chunks[i]) };
    }
    warnings.push(...(parsedScripts[i].warnings || []), ...(validation.warnings || []));
  }

  // 全部构建成功后再动 VM：删除现有顶层脚本（Blocks.deleteBlock 会递归
  // 删除子积木与 shadow），再创建新积木。
  const allBlocks = [];
  parsedScripts.forEach(parsed => {
    buildScriptBlocks(parsed, target).blocks.forEach(b => allBlocks.push(b));
  });
  const topLevelIds = Object.keys(target.blocks._blocks).filter(id => {
    const b = target.blocks._blocks[id];
    return b && b.topLevel && b.parent === null;
  });
  topLevelIds.forEach(id => target.blocks.deleteBlock(id));
  allBlocks.forEach(b => target.blocks.createBlock(b));
  vm.runtime.emitProjectChanged();
  vm.emitWorkspaceUpdate();
  vm.emitTargetsUpdate();
  return {
    success: true,
    scripts: parsedScripts.length,
    blocks: allBlocks.length,
    warnings: warnings.length ? warnings : undefined
  };
}

module.exports = {
  OPCODE_SCHEMA,
  SHADOW_VALUE_FIELD,
  VALUE_PRIMITIVE_OPCODES,
  tokenizeArgs,
  argToInputValue,
  mapArgsToDescriptor,
  parseDslLine,
  convertNode,
  resolveVariableField,
  resolveBroadcastField,
  schemaArgFor,
  toHexColor,
  createInputShadow,
  buildBlockStructure,
  buildSubstackChain,
  buildScriptBlocks,
  spliceBlocksIntoScript,
  validateParsedScript,
  formatValidationError,
  serializeBlockToDsl,
  convertBlockObjToDsl,
  parseScratchDSL,
  collectTargetDsl,
  parseDefineLine,
  resolveBlockSchema,
  collectProcRegistry,
  applyDslTextToTarget,
  procRegistryForParsed,
  spliceBlocksIntoScript
};
