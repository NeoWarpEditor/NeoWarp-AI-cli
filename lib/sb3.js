/**
 * NeoWarpAI CLI — .sb3 / project.json 读写。
 *
 * .sb3 本质是 ZIP（project.json + 资源文件）。用 Node 内置 zlib 实现纯 JS 的
 * ZIP 读写（deflate/inflateRaw），CLI 不引入任何第三方依赖。
 * 兼容 .np1（NeoWarp 未压缩项目 = project.json 直存，见桌面版 README 文件格式表）。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ── ZIP 读取 ──────────────────────────────────────────────────

/** 解析 ZIP（Local File Header 扫描 + Central Directory 定位，支持 deflate/store）。 */
function zipRead (buf) {
  // 定位 End Of Central Directory
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65536); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 ZIP/SB3 文件（找不到 EOCD）');
  const entries = [];
  let offset = buf.readUInt32LE(eocd + 16); // central directory offset
  const count = buf.readUInt16LE(eocd + 10);
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) break;
    const method = buf.readUInt16LE(offset + 10);
    const compSize = buf.readUInt32LE(offset + 20);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.slice(offset + 46, offset + 46 + nameLen).toString('utf8');
    // local header
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const raw = buf.slice(dataStart, dataStart + compSize);
    const data = method === 0 ? Buffer.from(raw) : zlib.inflateRawSync(raw);
    entries.push({ name, data });
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

// ── ZIP 写入 ──────────────────────────────────────────────────

function dosDateTime (d) {
  const now = new Date();
  const time = ((now.getHours() & 0x1f) << 11) | ((now.getMinutes() & 0x3f) << 5) | ((now.getSeconds() / 2) & 0x1f);
  const date = (((now.getFullYear() - 1980) & 0x7f) << 9) | (((now.getMonth() + 1) & 0xf) << 5) | (now.getDate() & 0x1f);
  return { time, date };
}

function zipWrite (files) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8');
    const crcTable = getCrcTable();
    let crc = 0xffffffff;
    for (let i = 0; i < f.data.length; i++) {
      crc = (crc >>> 8) ^ crcTable[(crc ^ f.data[i]) & 0xff];
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    const { time, date } = dosDateTime();
    const comp = zlib.deflateRawSync(f.data, { level: 6 });
    const useDeflate = comp.length < f.data.length;
    const payload = useDeflate ? comp : f.data;
    const method = useDeflate ? 8 : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 flag
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, payload);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(time, 12);
    cd.writeUInt16LE(date, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(payload.length, 20);
    cd.writeUInt32LE(f.data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([cd, nameBuf]));
    offset += 30 + nameBuf.length + payload.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, cdBuf, eocd]);
}

let _crcTable = null;
function getCrcTable () {
  if (_crcTable) return _crcTable;
  _crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    _crcTable[n] = c >>> 0;
  }
  return _crcTable;
}

// ── 项目加载 / 保存 ────────────────────────────────────────────

/**
 * 官方默认空白背景（backdrop1）。Scratch 3/TurboWarp 新建项目自带，
 * 内容寻址：内容的 md5 = cd21514d0531fdffb22204e0ec5ed84a（202 字节）。
 * blankProject 引用它，保存时必须带上该文件，否则桌面版/编辑器打开会因
 * 资产缺失而加载失败。
 */
const DEFAULT_BACKDROP_MD5 = 'cd21514d0531fdffb22204e0ec5ed84a';
const DEFAULT_BACKDROP_SVG = Buffer.from(
  'PHN2ZyB2ZXJzaW9uPSIxLjEiIHdpZHRoPSIyIiBoZWlnaHQ9IjIiIHZpZXdCb3g9Ii0xIC0xIDIgMiIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIiB4bWxuczp4bGluaz0iaHR0cDovL3d3dy53My5vcmcvMTk5OS94bGluayI+CiAgPCEtLSBFeHBvcnRlZCBieSBTY3JhdGNoIC0gaHR0cDovL3NjcmF0Y2gubWl0LmVkdS8gLS0+Cjwvc3ZnPg==',
  'base64'
);
// 守卫：常量被改动时立即暴露（md5 是内容寻址，必须与引用一致）
if (require('crypto').createHash('md5').update(DEFAULT_BACKDROP_SVG).digest('hex') !== DEFAULT_BACKDROP_MD5) {
  throw new Error('DEFAULT_BACKDROP_SVG 内容与 md5 引用不一致，禁止修改');
}

/**
 * 官方默认角色造型（Scratch Cat，costume1）。addSprite 引用，同上内容寻址：
 * md5 = bcf454acf82e4504149f7ffe07081dbc（6158 字节）。
 */
const DEFAULT_COSTUME_MD5 = 'bcf454acf82e4504149f7ffe07081dbc';
const DEFAULT_COSTUME_SVG = Buffer.from(
  'PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHhtbG5zOnhsaW5rPSJodHRwOi8vd3d3LnczLm9yZy8xOTk5L3hsaW5rIiB3aWR0aD0iOTUuMTc4OTgxMDE4MDY2NDEiIGhlaWdodD0iMTAwLjA0MTU2MDM2Mzc2OTUzIiB2aWV3Qm94PSIwLjMyMTAxNzE2OTk1MjM5MjYgMC4zMDAwMDAwMzU3NjI3ODY5IDk1LjE3ODk4MTAxODA2NjQxIDEwMC4wNDE1NjAzNjM3Njk1MyIgdmVyc2lvbj0iMS4xIiB4bWw6c3BhY2U9InByZXNlcnZlIj4KICA8IS0tIEdlbmVyYXRvcjogU2tldGNoIDUyLjUgKDY3NDY5KSAtIGh0dHA6Ly93d3cuYm9oZW1pYW5jb2RpbmcuY29tL3NrZXRjaCAtLT4KICA8Zz4KICAgIDx0aXRsZT5jb3N0dW1lMS4xPC90aXRsZT4KICAgIDxkZXNjPkNyZWF0ZWQgd2l0aCBTa2V0Y2guPC9kZXNjPgogICAgPGcgaWQ9IlBhZ2UtMSIgc3Ryb2tlPSJub25lIiBmaWxsLXJ1bGU9ImV2ZW5vZGQiPgogICAgICA8ZyBpZD0iY29zdHVtZTEiPgogICAgICAgIDxnIGlkPSJjb3N0dW1lMS4xIj4KICAgICAgICAgIDxnIGlkPSJ0YWlsIj4KICAgICAgICAgICAgPHBhdGggZD0iTSAyMS45IDczLjggQyAxOS41IDczLjMgMTYuNiA3Mi41IDE0LjIgNzAuMyBDIDguNyA2NS40IDcgNTcuMyAzLjIgNTkuNCBDIC0wLjcgNjEuNSAtMC42IDc0LjYgMTEuNiA3OC42IEMgMTUuOCA4MCAxOS42IDgwIDIyLjcgNzkuOSBDIDIzLjUgNzkuOSAzMC40IDc5LjIgMzIuOCA3NS44IEMgMzUuMiA3Mi40IDMzLjUgNzEuNSAzMi43IDcxLjEgQyAzMS44IDcwLjYgMjUuMyA3NC40IDIxLjkgNzMuOCBaICIgc3Ryb2tlPSIjMDAxMDI2IiBzdHJva2Utd2lkdGg9IjEuMiIgZmlsbD0iI0ZGQUIxOSIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIi8+CiAgICAgICAgICAgIDxwYXRoIGQ9Ik0gMy44IDU5LjYgQyAxLjggNjAuMiAwLjggNjQuNCAxLjggNjcuOSBDIDIuOCA3MS40IDQuNCA3My4yIDUuNyA3NC41IEMgNS41IDczLjggNS4xIDcxLjYgNi44IDcwLjMgQyA4LjkgNjguNiAxMi42IDY5LjUgMTIuNiA2OS41IEMgMTIuNiA2OS41IDkuNSA2NS43IDcuOSA2MyBDIDYuMyA2MC43IDUuOCA1OS4yIDMuOCA1OS42IFogIiBpZD0iZGV0YWlsIiBmaWxsPSIjRkZGRkZGIiBzdHJva2Utd2lkdGg9IjEiLz4KICAgICAgICAgIDwvZz4KICAgICAgICAgIDxwYXRoIGQ9Ik0zNy43LDgxLjUgQzM1LjksODIuNyAyOS43LDg3LjEgMjEuOCw4OS42IEwyMS40LDg5LjcgQzIxLDg5LjggMjAuOCw5MC4zIDIxLDkwLjcgQzIyLjcsOTMuMSAyNS44LDk3LjkgMjAuMyw5OS42IEMxNSwxMDEuMyA1LjEsODcuMiA5LjMsODMuNSBDMTEuMiw4Mi4xIDEyLjksODIuOCAxMy44LDgzLjIgQzE0LjMsODMuNCAxNC44LDgzLjQgMTUuMyw4My4zIEMxNi41LDgyLjkgMTguNyw4Mi4xIDIwLjQsODEuMiBDMjQuNyw3OSAyNS43LDc4LjEgMjcuNyw3Ni42IEMyOS43LDc1LjEgMzQuMyw3MS40IDM4LDc0LjYgQzQxLjIsNzcuMyAzOS40LDgwLjMgMzcuNyw4MS41IFoiIGlkPSJsZWciIHN0cm9rZT0iIzAwMTAyNiIgc3Ryb2tlLXdpZHRoPSIxLjIiIGZpbGw9IiNGRkFCMTkiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCIvPgogICAgICAgICAgPHBhdGggZD0iTTUzLjYsNjAuNyBDNTQuMSw2MS4xIDYwLjIsNjguMyA2Mi4yLDY2LjUgQzY0LjYsNjQuNCA2Ny45LDYwLjMgNzEuNSw2My42IEM3NS4xLDY2LjkgNjguMyw3Mi41IDY1LjQsNzQgQzU4LjUsNzcuMSA1Mi45LDcxLjIgNTEuNyw2OS42IEM1MC41LDY4IDQ4LjQsNjUuMyA0OC40LDYyLjcgQzQ4LjUsNTkuOSA1MS45LDU5LjIgNTMuNiw2MC43IFoiIGlkPSJhcm0iIHN0cm9rZT0iIzAwMTAyNiIgc3Ryb2tlLXdpZHRoPSIxLjIiIGZpbGw9IiNGRkFCMTkiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCIvPgogICAgICAgICAgPGcgaWQ9ImJvZHktYW5kLWxlZyI+CiAgICAgICAgICAgIDxwYXRoIGQ9Ik0gNDYuMiA3Ni43IEMgNDcuNCA3NS44IDQ4LjYgNzQuMyA1MC4yIDcyIEMgNTEuNSA3MC4xIDUyLjkgNjYuNCA1Mi45IDY2LjQgQyA1My44IDYzLjkgNTQuNCA1OS4xIDUxLjEgNTkuMiBDIDQ4LjkgNTkuMyA0Ni45IDU5IDQzLjUgNTguNSBDIDM3LjUgNTcuMyAzNi40IDU2LjUgMzMuOSA2MC42IEMgMzEuMiA2NS40IDI0LjMgNjguOSAzMi44IDc3LjIgQyAzMi44IDc3LjIgMzcuNyA4MSA0My42IDg2LjggQyA0Ny42IDkwLjcgNTMuOSA5Ni4zIDU2LjEgOTguMiBDIDU2LjYgOTguNiA1Ny4yIDk4LjggNTcuOCA5OC45IEMgNjcuNSA5OS44IDc0LjcgOTguOCA3NC43IDk0LjUgQyA3NC43IDg3LjMgNjAuNCA4OS44IDYwLjQgODkuOCBDIDYwLjQgODkuOCA1NS44IDg1LjkgNTMuNyA4NCBMIDQ2LjIgNzYuNyBaICIgaWQ9ImJvZHkiIHN0cm9rZT0iIzAwMTAyNiIgc3Ryb2tlLXdpZHRoPSIxLjIiIGZpbGw9IiNGRkFCMTkiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCIvPgogICAgICAgICAgICA8cGF0aCBkPSJNIDUwLjYgNzAgQyA1MC42IDcwIDUyLjUgNjcuNSA0OC4yIDY0LjggQyA0My43IDYxLjkgNDIgNjUuMSA0MC4yIDY3LjUgQyAzOC4yIDcwLjYgNDAuMiA3Mi4xIDQyLjIgNzMuOSBDIDQzLjggNzUuNCA0NS4zIDc2LjYgNDUuMyA3Ni42IEMgNDUuMyA3Ni42IDQ4LjQgNzQuNSA1MC42IDcwIFogIiBpZD0idHVtbXkiIGZpbGw9IiNGRkZGRkYiIHN0cm9rZS13aWR0aD0iMSIvPgogICAgICAgICAgPC9nPgogICAgICAgICAgPHBhdGggZD0iTTMwLjIsNjguNCBDMzIuNCw3MS4yIDM1LjgsNzQuNyAzMS41LDc3LjYgQzI1LjYsODAuOSAyMC43LDcwLjkgMTkuNyw2Ny40IEMxOC44LDY0LjMgMjEuNCw2Mi4zIDIzLjYsNjAuNiBDMjcuOSw1Ny41IDMxLjUsNTQuNyAzNS41LDU2LjIgQzQwLjUsNTggMzYuOSw2MiAzNC40LDYzLjggQzMyLjksNjQuOSAzMS40LDY2LjEgMzAuMyw2Ni44IEMzMCw2Ny4zIDI5LjksNjcuOSAzMC4yLDY4LjQgWiIgaWQ9ImFybSIgc3Ryb2tlPSIjMDAxMDI2IiBzdHJva2Utd2lkdGg9IjEuMiIgZmlsbD0iI0ZGQUIxOSIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIi8+CiAgICAgICAgICA8ZyBpZD0iaGVhZCI+CiAgICAgICAgICAgIDxwYXRoIGQ9Ik0gNTMuMSA5IEMgNTAuOCA4LjYgNDguNCA4LjQgNDUuNiA4LjYgQyA0MC45IDguOCAzNi40IDEwLjUgMzYuNCAxMC41IEwgMjQuMyAyLjYgQyAyMy45IDIuNCAyMy40IDIuNyAyMy41IDMuMSBMIDI1LjYgMjEgQyAyNi4yIDIwLjIgMTUgMzMuOCAyMi4xIDQ1LjIgQyAyOS4yIDU2LjYgNDQuMyA2MS43IDYzLjEgNTggQyA4MS45IDU0LjMgODYuMyA0My41IDg1LjEgMzcuOCBDIDgzLjkgMzIuMSA3Ni44IDMwIDc2LjggMzAgQyA3Ni44IDMwIDc2LjcgMjUuNSA3My41IDIwIEMgNzEuNiAxNi43IDY1LjIgMTIgNjUuMiAxMiBMIDYyLjYgMS4zIEMgNjIuNSAwLjkgNjIgMC44IDYxLjcgMSBMIDUzLjEgOSBaICIgc3Ryb2tlPSIjMDAxMDI2IiBzdHJva2Utd2lkdGg9IjEuMiIgZmlsbD0iI0ZGQUIxOSIvPgogICAgICAgICAgICA8cGF0aCBkPSJNIDc2LjUgMzAuNCBDIDc2LjUgMzAuNCA4My40IDMyLjIgODQuNiAzNy45IEMgODUuOCA0My42IDgxIDUzLjkgNjIuNCA1Ny41IEMgMzguMiA2Mi41IDI2LjcgNDguMSAzMy40IDM3LjUgQyA0MC4xIDI2LjggNTEuNiAzNS45IDYwIDM1LjMgQyA2Ny4yIDM0LjggNjggMjguNSA3Ni41IDMwLjQgWiAiIGlkPSJmYWNlIiBmaWxsPSIjRkZGRkZGIiBzdHJva2Utd2lkdGg9IjEiLz4KICAgICAgICAgICAgPHBhdGggZD0iTSA0NSA0MS4xIEMgNDUgNDAuNyA0NS40IDQwLjQgNDUuOCA0MC41IEMgNDcuNyA0MS4yIDUzLjEgNDIuOCA1OS4xIDQzLjIgQyA2NC41IDQzLjUgNjcuNyA0My4yIDY5LjIgNDIuOSBDIDY5LjcgNDIuOCA3MC4xIDQzLjMgNjkuOSA0My44IEMgNjkgNDYuNSA2NS4yIDU0IDU0LjcgNTMuNCBDIDQ1LjYgNTIuNCA0NC43IDQ2IDQ1IDQxLjEgWiAiIGlkPSJtb3V0aCIgc3Ryb2tlPSIjMDAxMDI2IiBzdHJva2Utd2lkdGg9IjEuMiIgZmlsbD0iI0ZGRkZGRiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIi8+CiAgICAgICAgICAgIDxwYXRoIGQ9Ik0gODMgMzUuNCBDIDgzIDM1LjQgOTAuMiAzNS4zIDk0LjkgMzEuNSAiIGlkPSJ3aGlza2VyIiBzdHJva2U9IiMwMDEwMjYiIHN0cm9rZS13aWR0aD0iMS4yIiBzdHJva2UtbGluZWNhcD0icm91bmQiIHN0cm9rZS1saW5lam9pbj0icm91bmQiIGZpbGw9Im5vbmUiLz4KICAgICAgICAgICAgPHBhdGggZD0iTSA4My40IDQxLjMgQyA4My40IDQxLjMgODcuMyA0My4yIDkzLjYgNDIuNyAiIGlkPSJ3aGlza2VyIiBzdHJva2U9IiMwMDEwMjYiIHN0cm9rZS13aWR0aD0iMS4yIiBzdHJva2UtbGluZWNhcD0icm91bmQiIHN0cm9rZS1saW5lam9pbj0icm91bmQiIGZpbGw9Im5vbmUiLz4KICAgICAgICAgICAgPHBhdGggZD0iTSA1OS42IDMyLjcgQyA2MS43IDMyLjcgNjMuOSAzMi45IDY0IDMzLjYgQyA2NC4xIDM1IDYyLjYgMzcuOCA2MSAzNy45IEMgNTkuMiAzOC4xIDU1IDM1LjYgNTUgMzQgQyA1NC45IDMyLjggNTcuNiAzMi43IDU5LjYgMzIuNyBaICIgaWQ9Im5vc2UiIHN0cm9rZT0iIzAwMTAyNiIgc3Ryb2tlLXdpZHRoPSIxLjIiIGZpbGw9IiMwMDEwMjYiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCIvPgogICAgICAgICAgICA8cGF0aCBkPSJNIDE0LjYgMzEuMiBDIDE0LjYgMzEuMiAyMy4yIDM0IDI2LjcgMzcuMSAiIGlkPSJ3aGlza2VyIiBzdHJva2U9IiMwMDEwMjYiIHN0cm9rZS13aWR0aD0iMS4yIiBzdHJva2UtbGluZWNhcD0icm91bmQiIHN0cm9rZS1saW5lam9pbj0icm91bmQiIGZpbGw9Im5vbmUiLz4KICAgICAgICAgICAgPHBhdGggZD0iTSAxNS4zIDQxLjIgQyAxNS4zIDQxLjIgMjIuNyA0Mi4zIDI3IDQwLjYgIiBpZD0id2hpc2tlciIgc3Ryb2tlPSIjMDAxMDI2IiBzdHJva2Utd2lkdGg9IjEuMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIiBmaWxsPSJub25lIi8+CiAgICAgICAgICAgIDxnIGlkPSJleWUiPgogICAgICAgICAgICAgIDxwYXRoIGQ9Ik0gNzEuNCAyMSBDIDc0LjMgMjUuNSA3NC40IDMwLjYgNzEuNiAzMi40IEMgNjguOCAzNC4yIDY0LjIgMzIuMSA2MS4yIDI3LjYgQyA1OC4zIDIzLjEgNTguMiAxOCA2MSAxNi4yIEMgNjMuOCAxNC4zIDY4LjUgMTYuNSA3MS40IDIxIFogIiBpZD0icHVwaWwiIHN0cm9rZT0iIzAwMTAyNiIgc3Ryb2tlLXdpZHRoPSIxLjIiIGZpbGw9IiNGRkZGRkYiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCIvPgogICAgICAgICAgICAgIDxwYXRoIGQ9Ik0gNzEgMjYuNyBDIDcxIDI3LjggNzAuMiAyOC43IDY5LjIgMjguNyBDIDY4LjIgMjguNyA2Ny40IDI3LjggNjcuNCAyNi43IEMgNjcuNCAyNS42IDY4LjIgMjQuNyA2OS4yIDI0LjcgQyA3MC4yIDI0LjcgNzEgMjUuNiA3MSAyNi43ICIgaWQ9InB1cGlsIiBmaWxsPSIjMDAxMDI2IiBzdHJva2Utd2lkdGg9IjEiLz4KICAgICAgICAgICAgPC9nPgogICAgICAgICAgICA8ZyBpZD0iZXllIj4KICAgICAgICAgICAgICA8cGF0aCBkPSJNIDQ2LjYgMjMuOCBDIDQ5LjYgMjguMiA0OS40IDMzLjYgNDYuNyAzNS41IEMgNDMuNCAzNy40IDM5IDM2IDM2IDMxLjYgQyAzMi45IDI3LjIgMzIuNyAyMS41IDM1LjggMTkuMyBDIDM4LjkgMTcgNDMuNiAxOS40IDQ2LjYgMjMuOCBaICIgc3Ryb2tlPSIjMDAxMDI2IiBzdHJva2Utd2lkdGg9IjEuMiIgZmlsbD0iI0ZGRkZGRiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIi8+CiAgICAgICAgICAgICAgPHBhdGggZD0iTSA0NiAyOS42IEMgNDYgMzAuNyA0NS4yIDMxLjYgNDQuMiAzMS42IEMgNDMuMiAzMS42IDQyLjQgMzAuNyA0Mi40IDI5LjYgQyA0Mi40IDI4LjUgNDMuMiAyNy42IDQ0LjIgMjcuNiBDIDQ1LjIgMjcuNyA0NiAyOC41IDQ2IDI5LjYgIiBpZD0icHVwaWwiIGZpbGw9IiMwMDEwMjYiIHN0cm9rZS13aWR0aD0iMSIvPgogICAgICAgICAgICA8L2c+CiAgICAgICAgICA8L2c+CiAgICAgICAgPC9nPgogICAgICA8L2c+CiAgICA8L2c+CiAgPC9nPgo8L3N2Zz4=',
  'base64'
);
if (require('crypto').createHash('md5').update(DEFAULT_COSTUME_SVG).digest('hex') !== DEFAULT_COSTUME_MD5) {
  throw new Error('DEFAULT_COSTUME_SVG 内容与 md5 引用不一致，禁止修改');
}

/**
 * 已知官方资产的兜底表：project.json 引用但资产文件缺失时，保存前自动内补。
 * （官方资产按内容寻址，md5 与文件内容绑定，硬编码内容与引用永远一致。）
 */
const OFFICIAL_ASSET_FALLBACKS = {
  [DEFAULT_BACKDROP_MD5 + '.svg']: DEFAULT_BACKDROP_SVG,
  [DEFAULT_COSTUME_MD5 + '.svg']: DEFAULT_COSTUME_SVG
};

/** 收集 project 中所有 targets 引用的资产文件名（md5ext）。 */
function collectReferencedAssets (project) {
  const refs = new Set();
  for (const t of (project.targets || [])) {
    for (const c of (t.costumes || [])) if (c.md5ext) refs.add(c.md5ext);
    for (const s of (t.sounds || [])) if (s.md5ext) refs.add(s.md5ext);
  }
  return refs;
}

/** 加载 .sb3 / .np1 / project.json，返回 {project, assets, sourcePath}。 */
function loadProject (filePath) {
  const p = path.resolve(filePath);
  if (!fs.existsSync(p)) throw new Error('文件不存在: ' + p);
  const ext = path.extname(p).toLowerCase();
  if (ext === '.json') {
    return { project: JSON.parse(fs.readFileSync(p, 'utf8')), assets: [], sourcePath: p };
  }
  if (ext === '.np1') {
    // NeoWarp 未压缩项目：project.json 直存
    return { project: JSON.parse(fs.readFileSync(p, 'utf8')), assets: [], sourcePath: p };
  }
  // .sb3 / .sb2(仅 sb3 格式内容的 zip)
  const entries = zipRead(fs.readFileSync(p));
  const pj = entries.find(e => e.name === 'project.json');
  if (!pj) throw new Error('压缩包内没有 project.json（不是有效的 Scratch 3 项目）');
  const assets = entries
    .filter(e => e.name !== 'project.json')
    .map(e => ({ name: e.name, data: e.data }));
  return { project: JSON.parse(pj.data.toString('utf8')), assets, sourcePath: p };
}

/** 保存为 .sb3（project.json + 原有资源；自动补齐 project 引用但缺失的资产）。 */
function saveProject (project, assets, outPath) {
  const pj = Buffer.from(JSON.stringify(project), 'utf8');
  const files = [{ name: 'project.json', data: pj }];
  const have = new Set();
  for (const a of assets || []) {
    if (!have.has(a.name)) files.push({ name: a.name, data: a.data });
    have.add(a.name);
  }
  // 兜底：project.json 引用了但压缩包里没有的资产会导致 Scratch/TurboWarp
  // 打开失败。已知官方资产（空背景 / Scratch Cat 造型）直接内补；其余资产给
  // 警告（内容无从获得）。
  for (const ref of collectReferencedAssets(project)) {
    if (have.has(ref)) continue;
    const fallback = OFFICIAL_ASSET_FALLBACKS[ref];
    if (fallback) {
      files.push({ name: ref, data: fallback });
      have.add(ref);
    } else {
      process.stderr.write('[警告] 项目引用的资产缺失，保存的 sb3 中没有该文件: ' + ref + '\n');
    }
  }
  fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
  fs.writeFileSync(outPath, zipWrite(files));
  return outPath;
}

/** 新建空白项目（与 Scratch 3 默认结构一致）。 */
function blankProject (name) {
  return {
    targets: [
      {
        isStage: true,
        name: 'Stage',
        variables: {},
        lists: {},
        broadcasts: {},
        blocks: {},
        comments: {},
        currentCostume: 0,
        costumes: [{
          name: 'backdrop1', dataFormat: 'svg', assetId: 'cd21514d0531fdffb22204e0ec5ed84a',
          md5ext: 'cd21514d0531fdffb22204e0ec5ed84a.svg', rotationCenterX: 240, rotationCenterY: 180
        }],
        sounds: [],
        volume: 100,
        layerOrder: 0,
        tempo: 60,
        videoTransparency: 50,
        videoState: 'on',
        textToSpeechLanguage: null
      }
    ],
    monitors: [],
    extensions: [],
    meta: { semver: '3.0.0', vm: '2.3.0', agent: 'NeoWarpAI-CLI' },
    name: name || 'NeoWarp 项目'
  };
}

module.exports = {
  loadProject, saveProject, blankProject, zipRead, zipWrite,
  collectReferencedAssets,
  DEFAULT_BACKDROP_MD5, DEFAULT_BACKDROP_SVG,
  DEFAULT_COSTUME_MD5, DEFAULT_COSTUME_SVG,
  OFFICIAL_ASSET_FALLBACKS
};
