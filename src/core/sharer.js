'use strict';
/**
 * 本机 ↔ 安卓 的共享目录双向同步
 *
 * 没有 root 的情况下无法真正「挂载」目录，所以采用增量同步：
 * 任何一侧新增/修改的文件都会在几秒内同步到另一侧，语义上等价于共享文件夹。
 */
const fs = require('fs');
const path = require('path');
const store = require('./store');

const MAX_FILE = 512 * 1024 * 1024; // 单文件 512MB 上限

/**
 * 只接受共享目录内部的相对路径。
 * 拒绝空段、`.`、`..`、绝对路径、盘符、NUL 和换行，避免客机文件名逃出目录或打断 shell。
 */
function safeRel(rel) {
  const s = String(rel || '').replace(/\\/g, '/');
  if (!s || /[\0\r\n]/.test(s)) return null;
  if (s.startsWith('/') || /^[A-Za-z]:/.test(s)) return null;
  const parts = s.split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..')) return null;
  return parts.join('/');
}

/** POSIX 单引号。路径里的单引号写成 `'\''`，整段仍是一个参数。 */
function shSingleQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/** 本机绝对路径必须仍在 root 里面。safeRel 已经挡住 `..`，这里再挡一次解析后的结果。 */
function localPathInside(root, rel) {
  const safe = safeRel(rel);
  if (!safe || !root) return null;
  const base = path.resolve(root);
  const abs = path.resolve(base, ...safe.split('/'));
  if (abs !== base && !abs.startsWith(base + path.sep)) return null;
  return abs;
}

/** `mkdir -p` 父目录。rel 不安全时返回 null，调用方跳过该文件。 */
function quotedMkdirParent(remoteDir, rel) {
  const safe = safeRel(rel);
  if (!safe) return null;
  const remote = `${String(remoteDir || '').replace(/\/+$/, '')}/${safe}`;
  return `mkdir -p ${shSingleQuote(path.posix.dirname(remote))}`;
}

function walk(dir, base = dir, out = []) {
  let items = [];
  try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
  for (const it of items) {
    if (it.name.startsWith('.')) continue;
    const full = path.join(dir, it.name);
    if (it.isDirectory()) walk(full, base, out);
    else if (it.isFile()) {
      try {
        const st = fs.statSync(full);
        if (st.size <= MAX_FILE) {
          out.push({ abs: full, rel: path.relative(base, full).split(path.sep).join('/'), mtime: st.mtimeMs, size: st.size });
        }
      } catch (_) { /* ignore */ }
    }
  }
  return out;
}

class Sharer {
  constructor(runtime) {
    this.runtime = runtime;
    this.stateFile = path.join(store.DATA_DIR, 'shared-state.json');
    this._busy = false;
    this._timer = null;
    this._lastError = '';
  }

  get localDir() { return store.getSettings().sharedDir; }
  get remoteDir() { return store.getSettings().deviceSharedDir; }

  loadState() {
    try { return JSON.parse(fs.readFileSync(this.stateFile, 'utf8')); } catch (_) { return {}; }
  }

  saveState(s) {
    try { fs.writeFileSync(this.stateFile, JSON.stringify(s, null, 2)); } catch (_) { /* ignore */ }
  }

  async ensureDirs(onLog = () => {}) {
    if (!fs.existsSync(this.localDir)) fs.mkdirSync(this.localDir, { recursive: true });
    const client = this.runtime.client();
    if (!(await client.isOnline())) return false;
    const root = String(this.remoteDir || '');
    if (!root || /[\0\r\n]/.test(root)) throw new Error('共享目录路径不安全');
    await client.shell(`mkdir -p ${shSingleQuote(root)}`);
    return true;
  }

  async sync({ onLog = () => {} } = {}) {
    if (this._busy) return { skipped: true };
    this._busy = true;
    const result = { pushed: 0, pulled: 0, errors: [] };
    try {
      const client = this.runtime.client();
      if (!(await client.isOnline())) throw new Error('运行时未连接');
      await this.ensureDirs(onLog);
      const state = this.loadState();

      // --- 本机 → 设备 ---
      const localFiles = walk(this.localDir);
      for (const f of localFiles) {
        const prev = state[f.rel];
        const changed = !prev || Math.abs((prev.mtime || 0) - f.mtime) > 1500 || prev.size !== f.size;
        if (!changed) continue;
        const mkdirCmd = quotedMkdirParent(this.remoteDir, f.rel);
        const rel = safeRel(f.rel);
        if (!mkdirCmd || !rel) {
          result.errors.push(`↑ ${f.rel}: 路径不安全，已跳过`);
          continue;
        }
        const remote = `${String(this.remoteDir).replace(/\/+$/, '')}/${rel}`;
        try {
          await client.shell(mkdirCmd);
          await client.push(f.abs, remote);
          state[f.rel] = { mtime: f.mtime, size: f.size, dir: 'up' };
          result.pushed++;
        } catch (e) {
          result.errors.push(`↑ ${f.rel}: ${e.message}`);
        }
      }

      // --- 设备 → 本机 ---
      // 优先用 toybox stat 拿真实 mtime；拿不到才退回 ls 解析（此时只能按大小判断）
      let remoteList = null;
      try {
        remoteList = await client.listRemoteStat(this.remoteDir);
      } catch (_) { /* ignore */ }
      if (!remoteList) {
        try {
          remoteList = await this.listRemoteRecursive(client, this.remoteDir);
        } catch (_) { remoteList = []; }
      }

      for (const r of remoteList) {
        const prev = state[r.rel];
        const sizeSame = !!prev && prev.size === r.size;
        // 新文件（prev 为空）必须拉回来；旧版在这里直接读 prev.mtime 会抛异常，
        // 让整次同步中断，表现为「设备 → 本机永远不同步」
        const mtimeSame = (prev && r.mtime) ? Math.abs((prev.mtime || 0) - r.mtime) <= 1500 : false;
        if (prev && sizeSame && mtimeSame) continue;
        const rel = safeRel(r.rel);
        const local = rel ? localPathInside(this.localDir, rel) : null;
        if (!rel || !local) {
          result.errors.push(`↓ ${r.rel}: 路径不安全，已跳过`);
          continue;
        }
        const remote = `${String(this.remoteDir).replace(/\/+$/, '')}/${rel}`;
        try {
          fs.mkdirSync(path.dirname(local), { recursive: true });
          await client.pull(remote, local);
          const st = fs.statSync(local);
          state[rel] = { mtime: st.mtimeMs, size: st.size, dir: 'down' };
          result.pulled++;
        } catch (e) {
          result.errors.push(`↓ ${r.rel}: ${e.message}`);
        }
      }

      this.saveState(state);
      this._lastError = result.errors[0] || '';
      return result;
    } catch (e) {
      this._lastError = e.message;
      return { ...result, error: e.message };
    } finally {
      this._busy = false;
    }
  }

  async listRemoteRecursive(client, base, prefix = '', depth = 0, out = []) {
    if (depth > 6) return out;
    // 优先一次 find + stat 拿全量（比逐目录 ls -l 快，也不受日期格式差异影响）
    if (depth === 0 && !prefix) {
      try {
        const text = await client.shell(
          `cd ${shSingleQuote(base)} 2>/dev/null && find . -type f -exec stat -c '%s|%Y|%n' {} + 2>/dev/null`,
        );
        const rows = String(text).split('\n').map((l) => l.trim()).filter(Boolean)
          .map((l) => /^(\d+)\|(\d+)\|(.+)$/.exec(l))
          .filter(Boolean)
          .map((m) => {
            const rel = safeRel(m[3].replace(/^\.\//, ''));
            if (!rel) return null;
            return { rel, size: Number(m[1]), mtime: Number(m[2]) * 1000 };
          })
          .filter(Boolean);
        if (rows.length) return rows;
      } catch (_) { /* 落到 ls 解析 */ }
    }
    const items = await client.listRemote(prefix ? `${base}/${prefix}` : base);
    for (const it of items) {
      if (it.name === '.' || it.name === '..') continue;
      const rel = prefix ? `${prefix}/${it.name}` : it.name;
      if (it.isDir) {
        // eslint-disable-next-line no-await-in-loop
        await this.listRemoteRecursive(client, base, rel, depth + 1, out);
      } else {
        out.push({ rel, size: it.size, mtime: Date.now() });
      }
    }
    return out;
  }

  start(intervalMs = 8000) {
    if (this._timer) return;
    this._timer = setInterval(() => { this.sync().catch(() => {}); }, intervalMs);
    if (this._timer.unref) this._timer.unref();
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  get lastError() { return this._lastError; }
}

module.exports = { Sharer, safeRel, shSingleQuote, localPathInside, quotedMkdirParent };
