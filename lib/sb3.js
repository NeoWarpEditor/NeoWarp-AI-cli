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

/** 保存为 .sb3（project.json + 原有资源 + 新增资源）。 */
function saveProject (project, assets, outPath) {
  const pj = Buffer.from(JSON.stringify(project), 'utf8');
  const files = [{ name: 'project.json', data: pj }];
  for (const a of assets || []) files.push({ name: a.name, data: a.data });
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

module.exports = { loadProject, saveProject, blankProject, zipRead, zipWrite };
