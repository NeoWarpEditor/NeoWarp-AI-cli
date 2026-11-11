/**
 * 宽松 JSON 修复 — 移植自桌面版 ai-assistant.js 的 lenientFixJsonStrings：
 * 很多模型在 script 参数里写真实换行/制表符而不是 \n 转义，标准 JSON.parse
 * 会失败。只修复双引号字符串值内部的控制字符，其余保持原样。
 */
'use strict';

function lenientFixJson (str) {
  let result = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (escaped) { result += ch; escaped = false; continue; }
    if (ch === '\\' && inString) { result += ch; escaped = true; continue; }
    if (ch === '"') { inString = !inString; result += ch; continue; }
    if (inString) {
      if (ch === '\n') { result += '\\n'; continue; }
      if (ch === '\r') { result += '\\r'; continue; }
      if (ch === '\t') { result += '\\t'; continue; }
    }
    result += ch;
  }
  return result;
}

/** 解析模型工具调用参数：先标准解析，失败后走宽松修复。 */
function parseToolArgs (raw) {
  try {
    return { args: JSON.parse(raw), fixed: false };
  } catch (e) {
    try {
      return { args: JSON.parse(lenientFixJson(raw)), fixed: true };
    } catch (e2) {
      return { args: null, error: e2.message };
    }
  }
}

module.exports = { lenientFixJson, parseToolArgs };
