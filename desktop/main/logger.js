// ═══════════════════════════════════════════════════════════════
// logger.js — 主进程客户端日志（环境与维护卡「日志」区块的数据源）
// 对齐原客户端日志查看页（gui/env_config_page.py / 日志相关页面）：
//   · 应用运行关键事件写入 %APPDATA%/<userData>/logs/client-YYYYMMDD.log
//   · 按天分文件；listLogFiles 供渲染层日志列表；readLogFile 内嵌展示；
//     clearLogFile 清空单文件（内置日志查看器「清空」，2026-08-31）
//   · 惰性单例：main.js 启动时 initLogger(userRoot)，其他模块直接 require 使用
//   · 所有写入失败静默（日志绝不阻塞业务，P1 红线同款约束）
// ═══════════════════════════════════════════════════════════════
const fs = require('node:fs')
const path = require('node:path')
const { shell } = require('electron')

/** logs 根目录（initLogger 后有效） */
let _root = null
/** 保留文件数上限（按天滚动，超量删最旧） */
const MAX_FILES = 30

function _stamp() {
  const d = new Date()
  const p = (n, w = 2) => String(n).padStart(w, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
}

function _fileOfDay() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return path.join(_root, `client-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}.log`)
}

/** 启动时初始化（main.js app.whenReady 最早处调用一次） */
function initLogger(userRoot) {
  _root = path.join(userRoot, 'logs')
  try { fs.mkdirSync(_root, { recursive: true }) } catch (_) {}
}

function getLogsDir() { return _root || '' }

/** 日志目录未初始化时给出可用的兜底（避免调用方判空） */
function _ensureRoot() {
  if (_root) return true
  try {
    const { app } = require('electron')
    if (app?.getPath) { initLogger(app.getPath('userData')); return true }
  } catch (_) {}
  return false
}

function _append(level, tag, msg) {
  if (!_ensureRoot()) return
  try {
    fs.appendFileSync(_fileOfDay(), `[${_stamp()}] [${level}] [${tag}] ${String(msg)}\n`)
  } catch (_) { /* 日志失败静默 */ }
}

function logInfo(tag, msg)  { _append('INFO', tag, msg) }
function logWarn(tag, msg)  { _append('WARN', tag, msg) }
function logError(tag, msg) { _append('ERROR', tag, msg) }

/** 日志文件列表（供渲染层展示）：[{ name, sizeBytes, mtimeMs }]，新→旧，上限 MAX_FILES */
function listLogFiles() {
  if (!_ensureRoot()) return []
  try {
    const rows = []
    for (const name of fs.readdirSync(_root)) {
      if (!/^client-\d{8}\.log$/.test(name)) continue
      try {
        const st = fs.statSync(path.join(_root, name))
        rows.push({ name, sizeBytes: st.size, mtimeMs: st.mtimeMs })
      } catch (_) { /* 单文件失败跳过 */ }
    }
    rows.sort((a, b) => b.mtimeMs - a.mtimeMs)
    const removed = rows.splice(MAX_FILES)
    for (const r of removed) { try { fs.unlinkSync(path.join(_root, r.name)) } catch (_) {} }
    return rows
  } catch (_) { return [] }
}

/** 用系统默认程序打开单个日志文件（Electron 13+ 用 openPath，openItem 已移除） */
async function openLogFile(name) {
  if (!_ensureRoot()) return { ok: false, error: 'LOG_DIR_NOT_READY' }
  // 防路径穿越：只允许白名单内的文件名
  if (!/^client-\d{8}\.log$/.test(String(name))) return { ok: false, error: 'INVALID_NAME' }
  try {
    const err = await shell.openPath(path.join(_root, String(name)))
    return err ? { ok: false, error: err } : { ok: true }
  } catch (e) { return { ok: false, error: String(e?.message || e) } }
}

/** 单文件读取上限（2MB：日志查看器内嵌展示够用，超出读尾部避免渲染层卡顿） */
const READ_CAP_BYTES = 2 * 1024 * 1024

/** 读取单个日志文件内容（日志查看器内嵌展示；超上限读尾部并标记 truncated） */
function readLogFile(name) {
  if (!_ensureRoot()) return { ok: false, error: 'LOG_DIR_NOT_READY' }
  if (!/^client-\d{8}\.log$/.test(String(name))) return { ok: false, error: 'INVALID_NAME' }
  try {
    const p = path.join(_root, String(name))
    const st = fs.statSync(p)
    if (st.size <= READ_CAP_BYTES) {
      return { ok: true, content: fs.readFileSync(p, 'utf8'), truncated: false }
    }
    // 超上限：只读尾部 1MB（fs.openReadStream 语义等价的定长尾读）
    const tailBytes = 1024 * 1024
    const fd = fs.openSync(p, 'r')
    try {
      const buf = Buffer.alloc(tailBytes)
      fs.readSync(fd, buf, 0, tailBytes, st.size - tailBytes)
      return { ok: true, content: buf.toString('utf8'), truncated: true }
    } finally { fs.closeSync(fd) }
  } catch (e) { return { ok: false, error: String(e?.message || e) } }
}

/** 清空单个日志文件内容（内置日志查看器「清空」；文件保留、写入归零） */
function clearLogFile(name) {
  if (!_ensureRoot()) return { ok: false, error: 'LOG_DIR_NOT_READY' }
  // 防路径穿越：与 openLogFile/readLogFile 同款白名单校验
  if (!/^client-\d{8}\.log$/.test(String(name))) return { ok: false, error: 'INVALID_NAME' }
  try {
    const p = path.join(_root, String(name))
    if (!fs.existsSync(p)) return { ok: false, error: 'NOT_FOUND' }
    fs.writeFileSync(p, '', 'utf8')
    logInfo('env', `log cleared by user: ${name}`)
    return { ok: true }
  } catch (e) { return { ok: false, error: String(e?.message || e) } }
}

/** 打开日志文件夹（revealInFolder 同源能力，供「打开日志目录」入口） */
function revealLogsDir() {
  if (!_ensureRoot()) return false
  try { shell.showItemInFolder(_fileOfDay()); return true } catch (_) { return false }
}

module.exports = { initLogger, getLogsDir, logInfo, logWarn, logError, listLogFiles, openLogFile, readLogFile, clearLogFile, revealLogsDir }
