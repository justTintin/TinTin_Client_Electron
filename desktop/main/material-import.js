// ═══════════════════════════════════════════════════════════════
// material-import.js — B8 素材入库客户端链路（主进程）
//
// 链路：采集清单（B10 collected.json）/ 每日素材（B9 本地下载目录勾选）
//   → 组包 /material/web_download（异步下载任务）→ 记录导入任务 →
//   可选 /material/enqueue_analysis（AI 分析队列）→ 状态回写标注。
//
// 契约（API-GUIDE，禁止臆造字段）：
//   · POST /material/web_download
//       body DownloadRequest：{ url: string(5..1000, 必填, 单条),
//         format?, cookies_file?, proxy?, max_filesize?(int>=0, 0=默认500MB),
//         share_name?(默认 "web_download") }
//       → 返回异步任务，轮询 GET /material/web_download/{task_id}
//   · POST /material/enqueue_analysis
//       body 筛选条件自由对象（默认只取 ai_status=pending），
//       返回匹配总数 + task_id（服务端单个批量任务）
//   · GET  /material/web_download/{task_id} → 下载任务进度/结果
//
// 任务记录取舍（书面说明）：web_download 有独立服务端任务体系
//   （/material/tasks/{task_id}，素材任务前缀），与通用客户端任务
//   /tasks/unified（c_ 前缀）链路不同 → 不强行打通 /tasks/unified；
//   导入任务落本地 userData/material-import/import-tasks.json，
//   仅做客户端侧去重与状态跟踪，状态轮询走 /material/web_download/{task_id}。
//
// 每日素材本地文件入库策略：web_download 只接受 http(s) url（无文件上传
//   接口），本地文件先按文件名/最终路径反查下载历史
//   （userData/downloads-history.json，B3 media-downloader 落盘，含 url
//   字段）取来源链接再提交；反查不到 → 归入 noUrl 类目提示。
//
// IPC 通道（browser-preload.js 白名单收口）：
//   material:import / material:importTaskList / material:importStatus
// ═══════════════════════════════════════════════════════════════

'use strict'
const fs = require('node:fs')
const path = require('node:path')

// ── 常量 ──
const DEFAULT_SHARE_NAME = 'web_download'
const URL_MAX_LENGTH = 1000 // 契约 DownloadRequest.url.maxLength
/** 导入任务本地记录上限（超出丢弃最旧，对齐 collected.json 裁剪口径） */
const MAX_IMPORT_TASKS = 2000

// ═══════════════════════════════════════════════════════════════
// 纯函数（无 electron / fs 副作用依赖，供 node --test 直接 import）
// ═══════════════════════════════════════════════════════════════

/** 采集条目规范化（对齐 B10 collected.json 条目结构，字段缺失兜底） */
function normalizeImportItem(item) {
  const src = item && typeof item === 'object' ? item : {}
  return {
    platform: String(src.platform || '').trim(),
    creatorId: String(src.creatorId || '').trim(),
    creatorName: String(src.creatorName || '').trim(),
    title: String(src.title || '未命名素材').trim(),
    url: String(src.url || '').trim(),
    source: String(src.source || '').trim(),
    date: String(src.date || '').trim(),
    collectedAt: String(src.collectedAt || '').trim(),
    filePath: String(src.filePath || '').trim(),
  }
}

/** url 合法性（契约：http(s) 且长度 5..1000） */
function isValidWebUrl(url) {
  if (!url || typeof url !== 'string') return false
  if (url.length < 5 || url.length > URL_MAX_LENGTH) return false
  return /^https?:\/\//i.test(url)
}

/**
 * 采集条目 → /material/web_download 请求体（DownloadRequest 组包）。
 * url 缺失/非法 → null（调用方归入 noUrl）。
 * @param {object} item 采集条目 {platform, creatorName, title, url, ...}
 * @param {object} [opts] { shareName, format, maxFilesize, proxy, cookiesFile }
 * @returns {object|null}
 */
function buildDownloadRequest(item, opts = {}) {
  const it = normalizeImportItem(item)
  if (!isValidWebUrl(it.url)) return null
  const req = { url: it.url }
  const shareName = String(opts.shareName || DEFAULT_SHARE_NAME).trim()
  if (shareName) req.share_name = shareName
  if (opts.format) req.format = String(opts.format)
  if (opts.maxFilesize !== undefined && opts.maxFilesize !== null) {
    const n = Number(opts.maxFilesize)
    if (Number.isFinite(n) && n >= 0) req.max_filesize = n
  }
  if (opts.proxy) req.proxy = String(opts.proxy)
  if (opts.cookiesFile) req.cookies_file = String(opts.cookiesFile)
  return req
}

/** 按 url 去重（保留首个；空/非法 url 条目原样保留由 splitImportItems 归类） */
function dedupeImportItems(items) {
  const out = []
  const seen = new Set()
  for (const it of (Array.isArray(items) ? items : [])) {
    const u = String((it && it.url) || '').trim()
    if (!u || seen.has(u)) continue
    seen.add(u)
    out.push(it)
  }
  return out
}

/**
 * 入库条目三分组：
 *   pending    → 有合法 http(s) url（去重后）
 *   duplicates → url 与前面条目重复
 *   noUrl      → 无 url / url 非法（本地文件且反查无来源链接等）
 */
function splitImportItems(items) {
  const pending = []
  const duplicates = []
  const noUrl = []
  const seen = new Set()
  for (const it of (Array.isArray(items) ? items : [])) {
    const u = String((it && it.url) || '').trim()
    if (!isValidWebUrl(u)) { noUrl.push(it); continue }
    if (seen.has(u)) { duplicates.push(it); continue }
    seen.add(u)
    pending.push(it)
  }
  return { pending, duplicates, noUrl }
}

/**
 * 按文件名/最终路径反查下载历史 → 来源 url（每日素材本地文件入库用）。
 * 路径比较 Windows 风格大小写不敏感（lowercase + 归一化斜杠）。
 * @param {string} filePath 本地文件绝对路径
 * @param {Array} history 下载历史（userData/downloads-history.json，
 *   条目含 {path, filename, url}，B3 media-downloader 落盘）
 * @returns {string|null}
 */
function resolveDownloadUrlByFile(filePath, history) {
  const fp = String(filePath || '').trim()
  if (!fp) return null
  const norm = fp.toLowerCase().replace(/\\/g, '/')
  const base = path.basename(fp).toLowerCase()
  for (const r of (Array.isArray(history) ? history : [])) {
    if (!r || !r.url) continue
    const p = String(r.path || '').trim().toLowerCase().replace(/\\/g, '/')
    const f = String(r.filename || '').trim().toLowerCase()
    if (p && p === norm) return String(r.url)
    if (f && f === base) return String(r.url)
  }
  return null
}

/**
 * 条目来源 url 解析：有合法 url 直接用；否则本地文件（filePath/path）反查
 * 下载历史补 url；补不到 → null（归入 noUrl）。
 * @param {object} item 采集条目或每日素材文件 {name, path, url, ...}
 * @param {Array} history 下载历史
 * @returns {object|null} 补全 url 后的条目
 */
function resolveImportUrl(item, history) {
  const it = normalizeImportItem(item)
  if (isValidWebUrl(it.url)) return it
  const fp = it.filePath || String((item && item.path) || '').trim()
  const url = resolveDownloadUrlByFile(fp, history)
  if (url) return { ...it, url }
  return null
}

/**
 * 采集条目标注导入状态（B10 collected.json 回写用）。
 * results: [{ url, taskId?|error? }] —— taskId → submitted（待处理）；
 * error → failed（失败+原因）；无结果条目保持原样。
 */
function markCollectedImported(items, results) {
  const byUrl = new Map()
  for (const r of (Array.isArray(results) ? results : [])) {
    if (r && r.url) byUrl.set(String(r.url).trim(), r)
  }
  return (Array.isArray(items) ? items : []).map((it) => {
    const r = byUrl.get(String(it.url || '').trim())
    if (!r) return it
    if (r.taskId) {
      return { ...it, importStatus: 'submitted', importTaskId: String(r.taskId) }
    }
    if (r.error) {
      return { ...it, importStatus: 'failed', importError: String(r.error) }
    }
    return it
  })
}

/**
 * enqueue_analysis 请求体组包（契约：筛选条件自由对象，默认只取
 * ai_status=pending；share_name 限定本次 web_download 入库的素材）。
 */
function buildEnqueueAnalysisBody(shareName, extra = {}) {
  const body = { ai_status: 'pending' }
  const sn = String(shareName || DEFAULT_SHARE_NAME).trim()
  if (sn) body.share_name = sn
  return { ...body, ...(extra || {}) }
}

/** 入库输入校验（空清单 / 非数组 / 全无有效 url） */
function validateImportInput(items) {
  const arr = Array.isArray(items) ? items : null
  if (!arr || arr.length === 0) return { ok: false, error: '入库清单为空，请先勾选要入库的条目' }
  const hasUrl = arr.some((it) => isValidWebUrl(String((it && it.url) || '').trim()))
  if (!hasUrl) return { ok: false, error: '清单中没有可入库的条目（无有效 url，无法提交下载任务）' }
  return { ok: true }
}

/** 服务端异步任务状态 → 客户端状态标注（宽容匹配，raw 未知字段保持） */
function classifyServerTaskStatus(raw) {
  const s = String((raw && (raw.status || raw.state)) || '').toLowerCase()
  if (/fail|error|cancel/.test(s)) return 'failed'
  if (/finish|success|done|completed|ready/.test(s)) return 'imported'
  return 'submitted'
}

// ═══════════════════════════════════════════════════════════════
// 导入任务本地记录（userData/material-import/import-tasks.json）
// ═══════════════════════════════════════════════════════════════

function importTasksFilePath(userDataDir) {
  return path.join(userDataDir, 'material-import', 'import-tasks.json')
}

function _readImportTasks(userDataDir) {
  try {
    const file = importTasksFilePath(userDataDir)
    if (!fs.existsSync(file)) return []
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'))
    return Array.isArray(raw) ? raw : []
  } catch (_) { return [] }
}

/** 追加导入任务记录（按 taskId/url 去重 + 上限裁剪） */
function _appendImportTasks(userDataDir, tasks) {
  try {
    const arr = [..._readImportTasks(userDataDir)]
    for (const t of (Array.isArray(tasks) ? tasks : [])) {
      if (!t || !t.taskId) continue
      const i = arr.findIndex((x) => x && (x.taskId === t.taskId || (t.url && x.url === t.url)))
      if (i >= 0) arr[i] = { ...arr[i], ...t }
      else arr.push(t)
    }
    const trimmed = arr.slice(-MAX_IMPORT_TASKS)
    const dir = path.dirname(importTasksFilePath(userDataDir))
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(importTasksFilePath(userDataDir), JSON.stringify(trimmed, null, 2), 'utf-8')
    return trimmed
  } catch (_) { return _readImportTasks(userDataDir) }
}

/** 更新单条任务状态字段（轮询回写） */
function _patchImportTask(userDataDir, taskId, patch) {
  try {
    const arr = _readImportTasks(userDataDir)
    const i = arr.findIndex((x) => x && x.taskId === taskId)
    if (i < 0) return
    arr[i] = { ...arr[i], ...(patch || {}) }
    const dir = path.dirname(importTasksFilePath(userDataDir))
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(importTasksFilePath(userDataDir), JSON.stringify(arr, null, 2), 'utf-8')
  } catch (_) { /* 记录写失败不阻塞查询 */ }
}

/** 读下载历史（B3 media-downloader 落盘 userData/downloads-history.json） */
function _readDownloadHistory(userDataDir) {
  try {
    const file = path.join(userDataDir, 'downloads-history.json')
    if (!fs.existsSync(file)) return []
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'))
    return Array.isArray(raw) ? raw : []
  } catch (_) { return [] }
}

/** collected.json 读/写（复用 creators-store 的 collectedFilePath；按 url 回写标注） */
function _readCollected(userDataDir) {
  try {
    const file = require('./creators-store').collectedFilePath(userDataDir)
    if (!fs.existsSync(file)) return []
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'))
    return Array.isArray(raw) ? raw : []
  } catch (_) { return [] }
}

function _writeCollected(userDataDir, list) {
  try {
    const file = require('./creators-store').collectedFilePath(userDataDir)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(list, null, 2), 'utf-8')
    return true
  } catch (_) { return false }
}

/**
 * 错误 → 用户可读文案（对齐既有 material 域「服务端返回 {status}: {detail}」口径）：
 *   网络/离线 → 服务端不可达；5xx/422 → 服务端返回 {status}[: detail]
 */
function _friendlyError(err) {
  if (!err) return '入库失败：未知错误'
  if (err.status) {
    const detail = err.response
      ? String(typeof err.response === 'object' ? JSON.stringify(err.response) : err.response).slice(0, 300)
      : ''
    return detail ? `服务端返回 ${err.status}: ${detail}` : `服务端返回 ${err.status}`
  }
  const msg = (err && err.message) || String(err)
  if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET|EHOSTUNREACH|ENETUNREACH|fetch failed|network error/i.test(msg)) {
    return '服务端不可达，入库失败（请确认服务端已启动）'
  }
  return `入库失败：${msg}`
}

// ═══════════════════════════════════════════════════════════════
// IPC（browser-preload.js 白名单收口）
// deps = { httpRequest, API_ENDPOINTS, resolveEndpoint, isExpectedOfflineError, app }
// ═══════════════════════════════════════════════════════════════
function createMaterialImportIpc(ipcMain, deps) {
  if (!ipcMain) throw new Error('createMaterialImportIpc: ipcMain is required')
  const { httpRequest, API_ENDPOINTS, resolveEndpoint, isExpectedOfflineError, app } = deps || {}

  function _userDataDir() {
    try { return (app && app.getPath && app.getPath('userData')) || '' } catch (_) { return '' }
  }

  // material:import → 采集条目/每日素材勾选 → web_download 异步任务 → 记录 → 可选 enqueue_analysis
  ipcMain.handle('material:import', async (_e, payload) => {
    try {
      const p = payload || {}
      const items = Array.isArray(p.items) ? p.items : []
      const opts = p.opts || {}
      const userDataDir = _userDataDir()
      if (!userDataDir) return { success: false, error: 'userData 目录不可用' }

      // 参数校验：空清单 / 非数组 / 全无有效 url
      const check = validateImportInput(items)
      if (!check.ok) return { success: false, error: check.error }

      // 本地文件（每日素材）反查下载历史补 url
      const history = _readDownloadHistory(userDataDir)
      const resolved = items.map((it) => resolveImportUrl(it, history)).filter(Boolean)
      if (resolved.length === 0) {
        return { success: false, error: '清单中没有可入库的条目（本地文件未找到来源下载链接）' }
      }

      const { pending, duplicates, noUrl } = splitImportItems(resolved)
      if (pending.length === 0) {
        return {
          success: false,
          error: '清单中没有可入库的条目（缺少有效的视频/图片链接）',
          data: { duplicates: duplicates.length, noUrl: noUrl.length },
        }
      }

      // 逐个提交（web_download 契约：单条 url；串行避免并发风暴，排队由服务端控制）
      const results = []
      const tasks = []
      let submitted = 0
      let failed = 0
      for (const item of pending) {
        const req = buildDownloadRequest(item, opts)
        try {
          const res = await httpRequest('POST', API_ENDPOINTS.material.webDownload, { body: req, timeout: 60000 })
          const taskId = String((res.data && (res.data.task_id || res.data.taskId)) || '')
          if (taskId) {
            results.push({ url: item.url, taskId })
            tasks.push({
              taskId,
              url: item.url,
              title: item.title,
              platform: item.platform,
              shareName: req.share_name || DEFAULT_SHARE_NAME,
              status: 'submitted',
              submittedAt: new Date().toISOString(),
            })
            submitted++
          } else {
            results.push({ url: item.url, error: '服务端未返回 task_id' })
            failed++
          }
        } catch (err) {
          results.push({ url: item.url, error: _friendlyError(err) })
          failed++
        }
      }

      // 导入任务本地记录（去重 + 上限裁剪）
      if (tasks.length > 0) _appendImportTasks(userDataDir, tasks)

      // 采集清单状态回写（collected.json 按 url 标注 imported；B10 衔接）
      let markedCount = 0
      if (results.length > 0) {
        const collected = _readCollected(userDataDir)
        if (collected.length > 0) {
          const marked = markCollectedImported(collected, results)
          if (_writeCollected(userDataDir, marked)) {
            markedCount = marked.filter((x) => x.importStatus).length
          }
        }
      }

      // 可选：批量入 AI 分析队列（契约：筛选条件 + 默认 ai_status=pending）
      let analysis = null
      if (opts.enqueueAnalysis && submitted > 0) {
        try {
          const body = buildEnqueueAnalysisBody(req.share_name || opts.shareName || DEFAULT_SHARE_NAME)
          const res = await httpRequest('POST', API_ENDPOINTS.material.enqueueAnalysis, { body, timeout: 30000 })
          analysis = (res && res.data) || null
        } catch (_) { /* 分析队列失败不回滚下载任务，提示见 analysisError */ }
      }

      const data = {
        submitted,
        failed,
        duplicates: duplicates.length,
        noUrl: noUrl.length,
        markedCount,
        tasks,
        results,
        analysis,
        analysisError: null,
      }
      if (failed > 0) data.firstError = (results.find((r) => r.error) || {}).error
      return { success: true, data }
    } catch (e) {
      return { success: false, error: (e && e.message) || String(e) }
    }
  })

  // material:importTaskList → 本地导入任务记录
  ipcMain.handle('material:importTaskList', async () => {
    try {
      const userDataDir = _userDataDir()
      if (!userDataDir) return { success: false, error: 'userData 目录不可用' }
      return { success: true, data: _readImportTasks(userDataDir) }
    } catch (e) {
      return { success: false, error: (e && e.message) || String(e) }
    }
  })

  // material:importStatus → 轮询 /material/web_download/{task_id} 并回写本地记录
  ipcMain.handle('material:importStatus', async (_e, taskId) => {
    try {
      if (!taskId) return { success: false, error: '缺少 task_id' }
      const userDataDir = _userDataDir()
      const path = resolveEndpoint(API_ENDPOINTS.material.webDownloadStatus(taskId))
      const res = await httpRequest('GET', path, { timeout: 30000 })
      const raw = (res && res.data) || {}
      const status = classifyServerTaskStatus(raw)
      if (userDataDir) {
        _patchImportTask(userDataDir, String(taskId), {
          status,
          updatedAt: new Date().toISOString(),
          serverData: raw,
        })
      }
      return { success: true, data: { taskId: String(taskId), status, raw } }
    } catch (err) {
      // 离线态静默 null（对齐既有 material 域 handler 口径）
      if (isExpectedOfflineError && isExpectedOfflineError(err)) return null
      return { success: false, error: _friendlyError(err) }
    }
  })
}

module.exports = {
  normalizeImportItem,
  isValidWebUrl,
  buildDownloadRequest,
  dedupeImportItems,
  splitImportItems,
  resolveDownloadUrlByFile,
  resolveImportUrl,
  markCollectedImported,
  buildEnqueueAnalysisBody,
  validateImportInput,
  classifyServerTaskStatus,
  importTasksFilePath,
  createMaterialImportIpc,
}
