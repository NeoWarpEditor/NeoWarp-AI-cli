#!/usr/bin/env node
/**
 * 从 NeoWarp 源码 desktop-hoc.jsx 提取 DSL 引擎（26 个顶层纯函数 + OPCODE_SCHEMA
 * 等常量），生成 lib/dsl-engine.js。
 *
 * 这与上游 `scripts/test-dsl-roundtrip.js` 的 loadHelpers() 是同一套提取思路，
 * 但输出为独立模块文件，CLI 与上游实现零漂移。上游文件更新后重新跑本脚本即可。
 *
 *   node scripts/extract-dsl-engine.js <desktop-hoc.jsx 路径> [输出路径]
 */
'use strict';

const fs = require('fs');
const path = require('path');

const SRC = process.argv[2] || path.join(__dirname, '../../nw-ai/src-renderer-webpack/editor/gui/desktop-hoc.jsx');
const OUT = process.argv[3] || path.join(__dirname, '../lib/dsl-engine.js');

const NAMES = [
  'OPCODE_SCHEMA', 'SHADOW_VALUE_FIELD', 'VALUE_PRIMITIVE_OPCODES',
  'tokenizeArgs', 'argToInputValue', 'mapArgsToDescriptor', 'parseDslLine',
  'convertNode', 'resolveVariableField', 'resolveBroadcastField', 'schemaArgFor',
  'toHexColor', 'createInputShadow', 'buildBlockStructure', 'buildSubstackChain',
  'buildScriptBlocks', 'spliceBlocksIntoScript', 'validateParsedScript',
  'formatValidationError', 'serializeBlockToDsl', 'convertBlockObjToDsl',
  'parseScratchDSL', 'collectTargetDsl', 'parseDefineLine', 'resolveBlockSchema',
  'collectProcRegistry', 'applyDslTextToTarget', 'procRegistryForParsed',
  'spliceBlocksIntoScript'
];

const src = fs.readFileSync(SRC, 'utf8');
const cut = src.indexOf('const DesktopHOC = function');
if (cut < 0) throw new Error('DesktopHOC marker not found in ' + SRC);
const head = src.slice(0, cut);

// 剥掉 import 与顶层 require（引擎自身是纯 JS，不依赖它们）
const stripped = head
  .replace(/^import[\s\S]*?;$/gm, '')
  .replace(/^const \{[\s\S]*?\} = require\([^)]*\);$/gm, '')
  .replace(/^const [A-Za-z_$][\w$]* = require\([^)]*\);$/gm, '')
  .replace(/^'use strict';$/gm, '');

const factory = new Function(
  'require', 'module', 'exports',
  stripped + '\nreturn {' + NAMES.map(n => n + ': typeof ' + n + " !== 'undefined' ? " + n + ' : undefined').join(', ') + '};'
);
const collected = factory(require, { exports: {} }, {});

const missing = NAMES.filter(n => !collected[n]);
if (missing.length) {
  throw new Error('engine functions missing from source: ' + missing.join(', '));
}

// 原样落盘为 CommonJS 模块（代码主体与上游逐字节一致，仅加模块外壳）
const banner =
  '/**\n' +
  ' * NeoWarp AI 积木 DSL 引擎 — 由 scripts/extract-dsl-engine.js 自动生成。\n' +
  ' * 来源：NeoWarp src-renderer-webpack/editor/gui/desktop-hoc.jsx 顶层函数，\n' +
  ' * 与上游 test-dsl-roundtrip.js 使用同一提取方式，保证 CLI 与编辑器行为一致。\n' +
  ' * 请勿手改本文件；上游更新后重新运行提取脚本。\n' +
  ' */\n' +
  "'use strict';\n\n" +
  stripped.trim() + '\n\n' +
  'module.exports = {\n' +
  NAMES.map(n => '  ' + n).join(',\n') + '\n' +
  '};\n';

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, banner);
console.log('wrote ' + OUT + ' (' + banner.length + ' bytes, ' + NAMES.length + ' exports)');
