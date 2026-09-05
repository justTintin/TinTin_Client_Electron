// ═══════════════════════════════════════════════════════════════
// logger.js — 主进程客户端日志（环境与维护卡「日志」区块的数据源）
// 2026-09-05 用户裁决：日志框架切换 electron-log 5.x（此前自研按天滚动）：
//   · 后端 = electron-log：主进程/渲染进程统一落盘，文件 userData/logs/main.log
//   · 滚动策略 = 按 5MB 旋转（main.log → main.old.log）+ 启动时清理 >30 天旧文件
//   · 渲染层：main.js 顶层 log.initialize({ spyRendererConsole }) 自动捕获
//     console.*；主进程未捕获异常由 errorHandler.startCatching 落盘（无弹窗）
//   · 对外 API（logInfo/logWarn/logError/listLogFiles/readLogFile/clearLogFile/
//     openLogFile/revealLogsDir）签名不变——env-ipc 日志查看器与既有调用方零改动
//   · 兼容历史 client-YYYYMMDD.log：旧文件仍可查看/清空，随 30 天清理自然淘汰
//   · 所有写入失败静默（日志绝不阻塞业务，P1 红线同款约束）
// ═══════════════════════════════════════════════════════════════
const fs = require('node:fs')
const path = require('node:path')
const { shell } = require('electron')
const electronLog = require('electron-log')

/** logs 根目录（initLogger 后有效） */
let _root = null
/** 当前主日志 / 旋转文件名（electron-log maxSize 滚动） */
const MAIN_LOG = 'main.log'
const ROTATED_LOG = 'main.old.log'
/** 文件名白名单：当前体系 + 历史 client-YYYYMMDD.log（只读兼容，随清理淘汰） */
const NAME_RE = /^(main(\.old)?|client-\d{8})\.log$/
/** 保留天数：启动时清理超龄 *.log */
const MAX_AGE_DAYS = 30

/** 启动时初始化（env-ipc 注册时以 userData 调用一次） */
function initLogger(userRoot) {
  _root = path.join(userRoot, 'logs')
  try {
    fs.mkdirSync(_root, { recursive: true })
    // electron-log 路径/滚动/格式对齐原查看器口径
    electronLog.transports.file.resolvePathFn = () => path.join(_root, MAIN_LOG)
    electronLog.transports.file.maxSize = 5 * 1024 * 1024
    electronLog.transports.file.format = '[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}] {text}'
  } catch (_) { /* 日志失败静默 */ }
  _cleanOldLogs()
}

/** 启动清理：删除超 MAX_AGE_DAYS 的 *.log（含历史 client-*），失败静默 */
function _cleanOldLogs() {
  if (!_root) return
  try {
    const cutoff = Date.now() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000
    for (const name of fs.readdirSync(_root)) {
      if (!name.endsWith('.log')) continue
      try {
        const p = path.join(_root, name)
        if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p)
      } catch (_) {}
    }
  } catch (_) {}
}

function getLogsDir() { return _root || '' }

function _append(level, tag, msg) {
  try {
    if (_root && !fs.existsSync(_root)) fs.mkdirSync(_root, { recursive: true })
    electronLog[level](`[${tag}] ${String(msg)}`)
  } catch (_) { /* 日志失败静默 */ }
}

function logInfo(tag, msg)  { _append('info', tag, msg) }
function logWarn(tag, msg)  { _append('warn', tag, msg) }
function logError(tag, msg) { _append('error', tag, msg) }

/** 日志文件列表（供渲染层展示）：[{ name, sizeBytes, mtimeMs }]，新→旧 */
function listLogFiles() {
  if (!_ensureRoot()) return []
  try {
    const rows = []
    for (const name of fs.readdirSync(_root)) {
      if (!NAME_RE.test(name)) continue
      try {
        const st = fs.statSync(path.join(_root, name))
        rows.push({ name, sizeBytes: st.size, mtimeMs: st.mtimeMs })
      } catch (_) { /* 单文件失败跳过 */ }
    }
    rows.sort((a, b) => b.mtimeMs - a.mtimeMs)
    return rows
  } catch (_) { return [] }
}

/** 用系统默认程序打开单个日志文件（Electron 13+ 用 openPath） */
async function openLogFile(name) {
  if (!_ensureRoot()) return { ok: false, error: 'LOG_DIR_NOT_READY' }
  // 防路径穿越：只允许白名单内的文件名
  if (!NAME_RE.test(String(name))) return { ok: false, error: 'INVALID_NAME' }
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
  if (!NAME_RE.test(String(name))) return { ok: false, error: 'INVALID_NAME' }
  try {
    const p = path.join(_root, String(name))
    const st = fs.statSync(p)
    if (st.size <= READ_CAP_BYTES) {
      return { ok: true, content: fs.readFileSync(p, 'utf8'), truncated: false }
    }
    // 超上限：只读尾部 1MB（定长尾读）
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
  if (!NAME_RE.test(String(name))) return { ok: false, error: 'INVALID_NAME' }
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
  try { shell.showItemInFolder(path.join(_root, MAIN_LOG)); return true } catch (_) { return false }
}

/** 日志目录未初始化时给出可用的兜底（避免调用方判空） */
function _ensureRoot() {
  if (_root) return true
  try {
    const { app } = require('electron')
    if (app?.getPath) { initLogger(app.getPath('userData')); return true }
  } catch (_) {}
  return false
}

module.exports = { initLogger, getLogsDir, logInfo, logWarn, logError, listLogFiles, openLogFile, readLogFile, clearLogFile, revealLogsDir }
