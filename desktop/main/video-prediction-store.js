// ═══════════════════════════════════════════════════════════════
// video-prediction-store.js — 视频评价预测记录库（主进程）
//
// 对照基准（零 Python 移植，逐段对照原版）：
//   · studio/utils/video_prediction_manager.py VideoPredictionManager：
//       load / save / all_items / add_prediction / set_feedback /
//       pending_feedback / recent_with_feedback / calibration_text
//     存储 data/video_predictions.json（Manager + JSON 模式）
//
// 存储取舍（书面说明）：新客户端无 sqlite，预测记录用独立 JSON 文件
//   userData/video_predictions.json，与 creators-store.js 的
//   creators.json 模式同构（业务数据集合而非配置，读写独立、备份清晰）；
//   不写入 config-store 分域（app.json 兜底域会混入业务数据，且无追加语义）。
//
// 分层取舍（IRON-06/07）：本文件只做 I/O 与记录结构变换；
//   「预测 vs 实际」校准文本拼接（calibration_text）属于 prompt 构造，
//   放在渲染层纯函数 videoScoreLogic.buildCalibrationText，便于单测与复用。
//
// IPC 通道（preload.js 白名单收口）：
//   prediction:list / prediction:add / prediction:setFeedback
// ═══════════════════════════════════════════════════════════════

'use strict'
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

/** 记录条数上限（原版无上限；此处防无限增长，超出丢弃最旧条目） */
const MAX_RECORDS = 500

function predictionsFilePath(userDataDir) {
  return path.join(userDataDir || '', 'video_predictions.json')
}

function _readJson(file) {
  try {
    if (!file || !fs.existsSync(file)) return []
    const raw = fs.readFileSync(file, 'utf8')
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr : []
  } catch (_) { return [] }
}

function _writeJson(file, data) {
  const dir = path.dirname(file)
  if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8')
}

// ── 纯函数（记录结构变换，导出供单测）──

/**
 * 新增一条预测记录（对照 add_prediction：insert(0, item) 最新在前）。
 * @returns {{ list: any[], id: string }} id 为空串表示入参非法未写入
 */
function addPrediction(list, { videoPath, platform, predicted } = {}) {
  const arr = Array.isArray(list) ? list.slice() : []
  const vp = String(videoPath || '').trim()
  if (!vp || !predicted || typeof predicted !== 'object') return { list: arr, id: '' }

  const id = crypto.randomBytes(8).toString('hex') // 对照 os.urandom(8).hex()
  const item = {
    id,
    video_path: vp,
    video_name: vp.split(/[\\/]/).pop() || '',
    platform: String(platform || '').trim(),
    predicted,
    actual: null,            // 回填后为 {play_count, platform_eval, at}
    created_at: Math.floor(Date.now() / 1000), // 对照 int(time.time()) 秒级
  }
  arr.unshift(item)
  return { list: arr.slice(0, MAX_RECORDS), id }
}

/**
 * 回填真实数据（对照 set_feedback）。
 * @returns {{ list: any[], ok: boolean }} ok=false 表示未找到该 id
 */
function setFeedback(list, id, playCount, platformEval) {
  const arr = Array.isArray(list) ? list.slice() : []
  const idx = arr.findIndex((it) => it && it.id === id)
  if (idx === -1) return { list: arr, ok: false }
  const target = Object.assign({}, arr[idx])
  target.actual = {
    play_count: String(playCount == null ? '' : playCount).trim(),
    platform_eval: String(platformEval == null ? '' : platformEval).trim(),
    at: Math.floor(Date.now() / 1000),
  }
  arr[idx] = target
  return { list: arr, ok: true }
}

/** 尚未回填真实数据的记录（对照 pending_feedback） */
function pendingFeedback(list) {
  return (Array.isArray(list) ? list : []).filter((it) => it && !it.actual)
}

/**
 * 取最近已回填的「预测 vs 实际」对照（对照 recent_with_feedback）。
 * @param {string} [platform] 传入则只取该平台
 * @param {number} [limit] 条数上限，默认 12
 */
function recentWithFeedback(list, platform, limit = 12) {
  const out = []
  for (const it of (Array.isArray(list) ? list : [])) {
    if (!it || !it.actual) continue
    if (platform && it.platform !== platform) continue
    out.push(it)
    if (out.length >= limit) break
  }
  return out
}

/**
 * 创建 prediction:* IPC handlers（main.js 在 createCreatorsStoreIpc 附近调用）。
 * ctx = { app }
 */
function createVideoPredictionIpc(ipcMain, ctx) {
  if (!ipcMain) throw new Error('createVideoPredictionIpc: ipcMain is required')
  const { app } = ctx || {}

  function _file() {
    let dir = ''
    try { dir = app.getPath('userData') } catch (_) { dir = '' }
    return predictionsFilePath(dir)
  }
  function _load() { return _readJson(_file()) }
  function _save(list) { _writeJson(_file(), list) }

  ipcMain.handle('prediction:list', () => {
    try { return { items: _load() } }
    catch (e) { return { error: (e && e.message) || String(e) } }
  })

  ipcMain.handle('prediction:add', (_e, payload) => {
    try {
      const p = payload || {}
      const { list, id } = addPrediction(_load(), p)
      if (!id) return { error: '缺少视频路径或预测结果' }
      _save(list)
      return { id }
    } catch (e) { return { error: (e && e.message) || String(e) } }
  })

  ipcMain.handle('prediction:setFeedback', (_e, payload) => {
    try {
      const p = payload || {}
      const { list, ok } = setFeedback(_load(), p.id, p.playCount, p.platformEval)
      if (!ok) return { ok: false, error: '未找到该预测记录' }
      _save(list)
      return { ok: true }
    } catch (e) { return { ok: false, error: (e && e.message) || String(e) } }
  })
}

module.exports = {
  createVideoPredictionIpc,
  addPrediction,
  setFeedback,
  pendingFeedback,
  recentWithFeedback,
  MAX_RECORDS,
}
