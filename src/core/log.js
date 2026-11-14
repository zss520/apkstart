'use strict';
/**
 * 有上限的文本日志。
 * 超过上限时把当前文件换成同名 .1，只留一份旧日志。写失败被吞掉，不能影响启动。
 */
const fs = require('fs');
const path = require('path');

const DEFAULT_MAX = 2 * 1024 * 1024;

function appendCapped(file, text, maxBytes = DEFAULT_MAX) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let size = 0;
    try { size = fs.statSync(file).size; } catch (_) { /* 新文件 */ }
    if (size > maxBytes) {
      const bak = `${file}.1`;
      try { fs.rmSync(bak, { force: true }); } catch (_) { /* ignore */ }
      try { fs.renameSync(file, bak); } catch (_) { /* 文件被占用时继续往原文件追加 */ }
    }
    fs.appendFileSync(file, text);
  } catch (_) { /* 日志失败不能影响主流程 */ }
}

module.exports = { appendCapped, DEFAULT_MAX };
