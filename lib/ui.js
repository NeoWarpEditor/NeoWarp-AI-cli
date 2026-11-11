/**
 * NeoWarpAI CLI — 终端 UI 设计系统。
 *
 * Apple Design 语言在终端里的落地：
 * · 低饱和 macOS 系统色板（256 色近似 systemBlue/Green/Red/Orange）
 * · 单一符号语言：◈ 品牌 · ✻ 思考 · ▸ 工具 · ✓/✗ 结果 · › 提示符 · · 列表
 * · 克制的排版层级：正文用默认前景，信息密度靠缩进与留白，不靠加粗轰炸
 * · 所有输出尊重 --no-color 与非 TTY 环境（管道/重定向时零 ANSI 码）
 */
'use strict';

const IS_TTY = process.stdout.isTTY;
const NO_COLOR = process.argv.includes('--no-color') || !IS_TTY;

const c = (code, s) => (NO_COLOR ? String(s) : '\x1b[' + code + 'm' + s + '\x1b[0m');

// ── 色板（macOS 系统色 256 色近似，低饱和） ───────────────────
const paint = {
  text: s => String(s),
  secondary: s => c('38;5;245', s),     // 次要文本
  tertiary: s => c('38;5;241;2', s),    // 弱化（分隔线、元信息）
  blue: s => c('38;5;75', s),           // systemBlue — 品牌/交互
  green: s => c('38;5;114', s),         // systemGreen — 成功
  red: s => c('38;5;203', s),           // systemRed — 失败
  orange: s => c('38;5;215', s),        // systemOrange — 提问/警示
  bold: s => c('1', s),
  dim: s => c('38;5;241;2', s)
};

// 兼容别名（bin 内旧引用渐迁）
const gray = paint.secondary;
const yellow = paint.orange;
const green = paint.green;
const red = paint.red;
const cyan = paint.blue;
const bold = paint.bold;

// ── 符号系统 ─────────────────────────────────────────────────
const sym = {
  logo: '◈',      // 品牌
  think: '✻',     // 思维链 / 等待
  tool: '▸',      // 工具调用进行中
  ok: '✓',
  fail: '✗',
  prompt: '›',
  dot: '·',
  line: '─',
  arrow: '→',
  flag: '●',      // 激活项
  circle: '○'     // 非激活项
};

// ── 基础排版 ─────────────────────────────────────────────────

/** 细分隔线（默认 64 列，CJK 环境下足够又不溢出）。 */
function divider (width) {
  return paint.tertiary(sym.line.repeat(width || 64));
}

/** 产品横幅：名称 + 版本 + 一句话定位。 */
function banner (version) {
  const out = [];
  out.push('  ' + paint.blue(sym.logo) + ' ' + paint.bold('NeoWarpAI CLI') + paint.secondary('  v' + version));
  out.push('  ' + paint.tertiary('NeoWarp AI 编程助手 · 用自然语言编写真实的 Scratch 项目'));
  return out.join('\n');
}

/** 任务上下文行：模型 · 格式 · 项目（一轮任务的"属性行"）。 */
function contextLine ({ model, format, project, extra }) {
  const parts = [paint.secondary(model)];
  if (format) parts.push(paint.tertiary(format));
  if (project) parts.push(paint.tertiary('项目 ' + project));
  if (extra) parts.push(paint.tertiary(extra));
  return '  ' + parts.join(' ' + paint.tertiary(sym.dot) + ' ');
}

/** 任务完成摘要行。 */
function summaryLine ({ rounds, toolCalls, seconds, aborted }) {
  const bits = [aborted ? paint.orange('已中断') : paint.green(sym.ok + ' 完成')];
  if (rounds) bits.push(paint.tertiary(rounds + ' 轮'));
  if (toolCalls) bits.push(paint.tertiary(toolCalls + ' 次工具调用'));
  if (seconds != null) bits.push(paint.tertiary(seconds.toFixed(1) + 's'));
  return '  ' + bits.join(' ' + paint.tertiary(sym.dot) + ' ');
}

// ── 工具参数 → 人话摘要 ──────────────────────────────────────

/** 数一下 DSL 脚本的逻辑行数（去掉空行）。 */
function dslLineCount (s) {
  return String(s).split('\n').filter(x => x.trim()).length;
}

/**
 * 把工具参数压缩成人话。挑最有信息量的字段，其余折叠。
 * 例：add_script {sprite:"Ball", script:"event_...\n..."} → "Ball ← 12 行 DSL"
 */
function toolBrief (name, args) {
  const a = (args && typeof args === 'object' && !Array.isArray(args)) ? args : {};
  const parts = [];
  const who = a.sprite || a.spriteName || a.target || a.name || a.project || a.extension;
  if (who) parts.push(String(who));
  if (a.script) parts.push('← ' + dslLineCount(a.script) + ' 行 DSL');
  else if (a.dsl) parts.push('← ' + dslLineCount(a.dsl) + ' 行 DSL');
  if (a.tid) parts.push('tid ' + String(a.tid).slice(0, 10));
  if (a.variableName || a.listName) parts.push(String(a.variableName || a.listName) +
    (a.value !== undefined ? ' = ' + String(a.value).slice(0, 24) : ''));
  if (a.blockId) parts.push('block ' + String(a.blockId).slice(0, 10));
  if (a.where || a.mode || a.scope) parts.push(String(a.where || a.mode || a.scope));
  if (a.property && a.value !== undefined) parts.push(String(a.property) + ' ' + sym.arrow + ' ' + String(a.value).slice(0, 24));
  else if (a.property) parts.push(String(a.property));
  if (a.query || a.url) parts.push('"' + String(a.query || a.url).slice(0, 40) + '"');
  if (a.opcode) parts.push(String(a.opcode));
  if (a.count !== undefined && !a.script) parts.push('×' + a.count);
  if (!parts.length) {
    // 兜底：取前两个标量值
    const scalars = Object.values(a).filter(v => typeof v === 'string' || typeof v === 'number').slice(0, 2);
    if (scalars.length) parts.push(scalars.map(v => String(v).slice(0, 20)).join(' '));
  }
  let brief = parts.join(' ' + sym.dot + ' ');
  if (!brief) brief = '';
  if (brief.length > 56) brief = brief.slice(0, 56) + '…';
  return brief;
}

// ── Spinner（等待模型响应） ──────────────────────────────────

const SPINNER_FRAMES = ['·', '•', '●', '•'];
const SPINNER_MS = 240;

/**
 * 极简 spinner：`  ✻ 思考中 ·` 逐帧呼吸。仅 TTY 且有色彩时启用；
 * 写到 stderr，不污染 stdout 重定向。
 */
function spinner (label) {
  if (NO_COLOR || !process.stderr.isTTY) {
    return { start () {}, stop () {} }; // 静默空实现
  }
  let timer = null;
  let i = 0;
  const render = () => {
    process.stderr.write('\x1b[2K\r  ' + paint.blue(sym.think) + ' ' + label + ' ' +
      paint.blue(SPINNER_FRAMES[i++ % SPINNER_FRAMES.length]));
  };
  return {
    start () {
      render();
      timer = setInterval(render, SPINNER_MS);
    },
    stop () {
      if (timer) { clearInterval(timer); timer = null; }
      process.stderr.write('\x1b[2K\r');
    }
  };
}

module.exports = {
  NO_COLOR, IS_TTY,
  paint, sym,
  gray, yellow, green, red, cyan, bold, // 兼容别名
  divider, banner, contextLine, summaryLine, toolBrief, spinner,
  SPINNER_FRAMES, SPINNER_MS
};
