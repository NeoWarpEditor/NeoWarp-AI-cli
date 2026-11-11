/**
 * NeoWarpAI CLI — 会话持久化与项目快照。
 *
 * 会话：~/.neowarp-ai-cli/sessions/<id>.json（多轮对话可恢复）
 * 快照：对齐桌面版"每次改动前自动保存项目快照，一键撤销"——
 *       首次修改前把原始 .sb3 复制到 <项目目录>/.neowarp-snapshots/，
 *       `neowarp-ai project undo` 一键回退。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

function baseDir () {
  return process.env.NEOWARP_CLI_CONFIG
    ? path.join(path.dirname(path.resolve(process.env.NEOWARP_CLI_CONFIG)))
    : path.join(os.homedir(), '.neowarp-ai-cli');
}

function sessionsDir () {
  const d = path.join(baseDir(), 'sessions');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function sessionPath (id) {
  return path.join(sessionsDir(), id.replace(/[^\w.-]/g, '_') + '.json');
}

function saveSession (id, data) {
  fs.writeFileSync(sessionPath(id), JSON.stringify(data, null, 2));
  return sessionPath(id);
}

function loadSession (id) {
  try {
    return JSON.parse(fs.readFileSync(sessionPath(id), 'utf8'));
  } catch (e) {
    return null;
  }
}

function listSessions () {
  const d = sessionsDir();
  return fs.readdirSync(d)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      const full = path.join(d, f);
      try {
        const j = JSON.parse(fs.readFileSync(full, 'utf8'));
        return { id: j.id, updated: j.updated, model: j.model, messages: (j.messages || []).length };
      } catch (e) { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => (b.updated || '').localeCompare(a.updated || ''));
}

/** 项目快照目录（跟 .sb3 同目录）。 */
function snapshotDir (projectPath) {
  const d = path.join(path.dirname(path.resolve(projectPath)), '.neowarp-snapshots');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/** 保存快照，返回快照文件路径。 */
function takeSnapshot (projectPath, label) {
  const dir = snapshotDir(projectPath);
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, (label ? label.replace(/[^\w.-]/g, '_') + '_' : '') + ts + '.sb3');
  fs.copyFileSync(projectPath, file);
  return file;
}

function listSnapshots (projectPath) {
  const dir = snapshotDir(projectPath);
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.sb3'))
    .sort()
    .reverse()
    .map(f => path.join(dir, f));
}

/** 回滚到最近的快照，返回 {restored: 目标路径, from: 快照路径}。 */
function undoSnapshot (projectPath) {
  const snaps = listSnapshots(projectPath);
  if (!snaps.length) return null;
  fs.copyFileSync(snaps[0], projectPath);
  return { restored: path.resolve(projectPath), from: snaps[0] };
}

module.exports = { saveSession, loadSession, listSessions, takeSnapshot, listSnapshots, undoSnapshot };
