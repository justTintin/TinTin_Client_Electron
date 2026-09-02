// ═══════════════════════════════════════════════════════════════
// client-task-thread.js — 客户端任务下发闭环（W11 移植）
// 基准：原客户端 studio/gui/client_task_thread.py L14-61 + studio/utils/
//       client_task_worker.py（领取→执行→上报三段，逐行为对照移植）。
//
// 服务端契约（API-GUIDE 权威，禁止臆造）：
//   · GET  /tasks/assigned/{machine_id}   客户端领取入口（领取即置 running）
//        描述返回 [{task_id, capability, params, executor}]；空数组 = 无任务
//        （兼容 {tasks:[...]} 与裸数组两种响应形态，同原版 pickup_tasks）
//   · POST /tasks/{task_id}/report        客户端上报执行结果（multipart/form-data）
//        Body_report_task schema：machine_id(必填), status=ok|failed(默认 ok),
//        error(默认 ""), result(默认 "", JSON 字符串), file?(二进制视频)
//
// execute_task 语义（以原文为准 = 引导下载）：
//   下载类任务（capability 含 download/browser/素材下载/下载，或 params.url
//   为 http(s) 链接）→ 打开客户端素材浏览器（新端=浏览器独立窗口）引导用户
//   手动下载 → 轮询下载目录出现新文件（最长 300s / 每 2s，同原版
//   _DOWNLOAD_MAX_WAIT/_DOWNLOAD_POLL）→ 有文件上报 ok + file（multipart）；
//   超时上报 failed「等待下载超时，用户未完成下载」；非下载能力上报 failed
//   「未实现的客户端能力」。
//
// 运行载体：主进程模块（对标原 QThread.run），startClientTaskThread 由
//   main.js 接线启动；异常仅告警继续轮询（原版 L33-35）；IPC/窗口未就绪
//   或服务端离线时静默跳过不阻塞主进程。
// 分层：本文件只做纯函数 + 状态机编排；HTTP（httpRequest/multipartUpload）、
//   浏览器窗口（openBrowserWindow）、store 均经 deps 注入，顶层零 electron
//   依赖（node --test 可直接 import 纯函数）。
// ═══════════════════════════════════════════════════════════════
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFile } = require('node:child_process')
// machine_id 稳定派生（与 server-proxy getMachineId 共用口径：config-store
// 'machineIdV2' 缓存优先 + 原版 license.py 口径派生写回，跨重启稳定、双入口一致）
const { deriveMachineId, MACHINE_ID_KEY } = require('./machine-id')

// ── 常量（对照原版 client_task_worker.py L27-32）──
const POLL_INTERVAL_MS = 5000          // 领取轮询间隔（原版 poll_interval=5）
const DOWNLOAD_MAX_WAIT_MS = 300000    // 等用户下载最长时间（原版 300s）
const DOWNLOAD_POLL_MS = 2000          // 下载目录轮询间隔（原版 2s）
const SLEEP_CHUNK_MS = 500             // 轮询间隔分段睡（可被 stop 打断，原版 L55-58）
const _DOWNLOAD_CAP_HINTS = ['download', 'browser', '素材下载', '下载']

// ── 服务端路径（API-GUIDE /tasks/* 契约；与 API_ENDPOINTS 不重复定义）──
const TASK_ASSIGNED = (machineId) => `/tasks/assigned/${encodeURIComponent(machineId)}`
const TASK_REPORT = (taskId) => `/tasks/${encodeURIComponent(taskId)}/report`

// 主进程事件通道：领取到任务/执行完成 → 推送到主窗口（useWorkbenchTasks 30s
// 整表刷新经 /tasks/unified 已能展示状态，此通道供渲染层实时订阅刷新）
const ACTIVITY_CHANNEL = 'client-task:activity'
// 浏览器窗口渲染层订阅通道：引导下载导航（browser-preload.js onClientTaskDownload）
const OPEN_DOWNLOAD_CHANNEL = 'client-task:open-download'

// ═══════════════════════════════════════════════════════════════
// 纯函数（可单测）
// ═══════════════════════════════════════════════════════════════

/** 下载类任务判定（对照原版 _is_download_task L107-113） */
function isDownloadTask(task) {
  const cap = String((task || {}).capability || '').toLowerCase()
  if (_DOWNLOAD_CAP_HINTS.some((h) => cap.includes(h.toLowerCase()))) return true
  const params = (task || {}).params || {}
  const url = String(params.url || '').trim()
  return url.startsWith('http://') || url.startsWith('https://')
}

/** 领取响应解析（对照原版 pickup_tasks L56-62：dict{tasks}|裸数组→数组） */
function parsePickupResponse(data) {
  if (Array.isArray(data)) return data
  if (data && typeof data === 'object' && Array.isArray(data.tasks)) return data.tasks
  return []
}

/**
 * report 字段编组（对照 API-GUIDE Body_report_task_tasks__task_id__report_post：
 * machine_id 必填；status=ok|failed；error 有值才带；result 非空才带；
 * file_path 存在且为字符串时以 {path} 对象占位（multipartUpload 识别为文件 part，
 * 服务端保存到 output/upload/ 续接处理）。
 */
function buildReportFields({ machineId, status = 'ok', error, result, file_path } = {}) {
  const fields = {
    machine_id: String(machineId || ''),
    status: status === 'failed' ? 'failed' : 'ok',
  }
  if (error) fields.error = String(error)
  if (result !== undefined && result !== null && result !== '') fields.result = String(result)
  if (file_path && typeof file_path === 'string') fields.file = { path: file_path }
  return fields
}

/** 目录内文件名集合（对照原版 _snapshot_dir L116-123，用于检测新增文件） */
function snapshotDir(dir) {
  try {
    if (!dir || !fs.statSync(dir).isDirectory()) return new Set()
    return new Set(fs.readdirSync(dir).filter((f) => fs.statSync(path.join(dir, f)).isFile()))
  } catch (_) {
    return new Set()
  }
}

/**
 * 轮询下载目录等待出现新文件（对照原版 _wait_download_file L126-140：
 * sorted(now - before) 取字典序最后者；deadline 内未出现返回 null）。
 * sleep 注入便于单测。
 */
async function waitDownloadFile(dlDir, before, {
  maxWaitMs = DOWNLOAD_MAX_WAIT_MS,
  pollMs = DOWNLOAD_POLL_MS,
  onLog,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  const deadline = Date.now() + Math.max(0, maxWaitMs)
  while (Date.now() < deadline) {
    const now = snapshotDir(dlDir)
    const newFiles = [...now].filter((f) => !(before && before.has(f))).sort()
    if (newFiles.length) {
      const newest = path.join(dlDir, newFiles[newFiles.length - 1])
      try { if (onLog) onLog(`检测到下载完成：${newest}`) } catch (_) {}
      return newest
    }
    await sleep(pollMs)
  }
  return null
}

/**
 * 轮询间隔分段块数（对照原版 L55-58：poll_interval*2 次 0.5s 小睡，
 * stop 可在任一小睡后立即生效）。buildSleepChunks(5000,500)=10。
 */
function buildSleepChunks(intervalMs, chunkMs = SLEEP_CHUNK_MS) {
  const total = Math.max(0, Number(intervalMs) || 0)
  const per = Math.max(1, Number(chunkMs) || SLEEP_CHUNK_MS)
  return Math.max(1, Math.ceil(total / per))
}

/**
 * machine_id 派生：抽取至 ./machine-id 公共模块（与 server-proxy getMachineId
 * 共用口径），本文件经 require 复用并 re-export（单测导入路径不变）。
 */

/**
 * 轮询状态机：一次轮询 = 领取（异常仅告警继续，原版 L31-35）→ 逐任务执行 →
 * 按结果上报 ok/failed（原版 L36-53）。全部副作用经注入函数，可单测：
 *   pickup(machineId) → 任务数组
 *   executeTask(task, onLog) → {ok, file_path?, result?, error?}
 *   report(taskId, fields) → boolean
 *   isRunning() → boolean（stop 后中断）
 * 返回 [{task_id, ok, status}]（上报结果列表）。
 */
async function runOnePoll({ machineId, pickup, executeTask, report, isRunning = () => true, onLog }) {
  let tasks = []
  try {
    tasks = await pickup(machineId)
  } catch (e) { // 外部API调用（任务领取 HTTP 请求）异常仅告警继续轮询
    try { if (onLog) onLog(`领取异常: ${(e && e.message) || e}`) } catch (_) {}
    tasks = []
  }
  const reported = []
  for (const task of tasks || []) {
    if (!isRunning()) break
    const taskId = String((task || {}).task_id || '')
    if (!taskId) continue
    try { if (onLog) onLog(`领取任务 ${taskId}`) } catch (_) {}
    const res = await executeTask(task, onLog).catch((e) => ({ ok: false, error: (e && e.message) || String(e) }))
    const okRes = !!(res && res.ok)
    const fields = buildReportFields({
      machineId,
      status: okRes ? 'ok' : 'failed',
      file_path: okRes ? res.file_path : undefined,
      result: okRes ? res.result : undefined,
      error: okRes ? undefined : ((res && res.error) || '执行失败'),
    })
    const ok = await report(taskId, fields).catch(() => false)
    reported.push({ task_id: taskId, ok, status: okRes ? 'ok' : 'failed' })
  }
  return reported
}

// ═══════════════════════════════════════════════════════════════
// 运行时装配（副作用依赖经 deps 注入，main.js 负责接线）
// ═══════════════════════════════════════════════════════════════

/** 采集本机机器码原始信息（与 env-ipc.js env:getMachineInfo 同款；
 *  cpu 对齐原版 platform.processor()（Windows = PROCESSOR_IDENTIFIER）） */
function collectMachineInfo() {
  const info = { hostname: os.hostname(), platform: os.platform(), machineGuid: '', mac: '', cpu: '', source: '' }
  try {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const ni of list || []) {
        if (ni && !ni.internal && ni.mac && ni.mac !== '00:00:00:00:00:00') { info.mac = ni.mac; break }
      }
      if (info.mac) break
    }
  } catch (_) {}
  info.cpu = String(process.env.PROCESSOR_IDENTIFIER || '').trim()
  if (process.platform === 'win32') {
    info.machineGuid = new Promise((resolve) => {
      try {
        execFile('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'],
          { timeout: 3000 }, (err, stdout) => {
            if (err) return resolve('')
            const m = String(stdout).match(/MachineGuid\s+REG_SZ\s+(\S+)/i)
            resolve(m ? m[1] : '')
          })
      } catch (_) { resolve('') }
    })
  }
  return info
}

/**
 * 稳定 machine_id：优先复用 config-store 'machineIdV2' 缓存（跨重启稳定）；
 * 无则按 env:getMachineInfo 同源采集派生（原版 license.py 口径）并写回缓存。
 */
async function resolveMachineId({ store, collect = collectMachineInfo }) {
  try {
    const cached = store && typeof store.get === 'function' ? store.get(MACHINE_ID_KEY) : null
    if (cached) return String(cached)
  } catch (_) {}
  const info = await collect().catch(() => null)
  const mid = deriveMachineId(info)
  if (mid && store && typeof store.set === 'function') {
    try { store.set(MACHINE_ID_KEY, mid) } catch (_) {}
  }
  return mid
}

/** 下载目录解析（与 media-downloader.js _resolveDownloadDir L264-275 同口径） */
function resolveDownloadDir({ store, app }) {
  try {
    const pref = store && typeof store.get === 'function' ? store.get('downloadDir') : null
    if (pref && typeof pref === 'string') {
      fs.mkdirSync(pref, { recursive: true })
      return pref
    }
  } catch (_) {}
  try { if (app && typeof app.getPath === 'function') return app.getPath('downloads') } catch (_) {}
  try { if (app && typeof app.getPath === 'function') return path.join(app.getPath('userData'), 'downloads') } catch (_) {}
  return path.join(os.tmpdir(), 'tintin-downloads')
}

/** 窗口 webContents 就绪后发事件；未加载完成则 did-finish-load 补发（防首开竞态） */
function sendWhenReady(wc, channel, payload) {
  return new Promise((resolve) => {
    try {
      if (!wc || wc.isDestroyed()) return resolve(false)
      if (!wc.isLoading()) { wc.send(channel, payload); return resolve(true) }
      wc.once('did-finish-load', () => {
        try { wc.send(channel, payload); resolve(true) } catch (_) { resolve(false) }
      })
    } catch (_) { resolve(false) }
  })
}

/**
 * execute_task 运行时实现（引导下载语义，对照原版 execute_task L143-184）：
 * 打开浏览器独立窗口 → 发 client-task:open-download 事件（渲染层 navigateToUrl
 * 自动切平台页并导航任务 URL）→ 轮询下载目录新文件 → ok+file / 超时 failed。
 */
async function executeDownloadTask(task, { openDownloadPage, getDownloadDir, maxWaitMs, pollMs, onLog }) {
  const taskId = String((task || {}).task_id || '')
  const params = (task || {}).params || {}
  const url = String(params.url || '').trim()
  if (!isDownloadTask(task) || !url) {
    const cap = (task || {}).capability || '?'
    return { ok: false, error: `未实现的客户端能力: ${cap}` }
  }
  try { if (onLog) onLog(`领取下载任务 ${taskId}（${url}）`) } catch (_) {}
  const opened = await openDownloadPage(url).catch((e) => ({ ok: false, error: (e && e.message) || String(e) }))
  if (!opened || !opened.ok) return { ok: false, error: (opened && opened.error) || '打开素材浏览器失败' }
  const dlDir = getDownloadDir()
  const before = snapshotDir(dlDir)
  try { if (onLog) onLog('已打开素材浏览器，请在浏览器中下载视频并入库（等待下载文件…）') } catch (_) {}
  const filePath = await waitDownloadFile(dlDir, before, { maxWaitMs, pollMs, onLog })
  if (!filePath) return { ok: false, error: '等待下载超时，用户未完成下载' }
  return { ok: true, file_path: filePath }
}

/** 创建客户端任务线程（对标原 ClientTaskWorker.start/stop + run 主循环） */
function createClientTaskThread(deps) {
  const {
    store,
    app,
    getWindow,
    getBrowserWindow,
    openBrowserWindow,
    pollIntervalMs = POLL_INTERVAL_MS,
    downloadMaxWaitMs = DOWNLOAD_MAX_WAIT_MS,
    downloadPollMs = DOWNLOAD_POLL_MS,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    onLog = (msg) => { try { console.log(`[客户端任务] ${msg}`) } catch (_) {} },
  } = deps || {}

  let running = false
  let machineId = ''
  let loopPromise = null

  /** 推送活动事件到主窗口/浏览器窗口（渲染层可订阅实时刷新任务队列） */
  function pushActivity(payload) {
    try { if (getWindow) getWindow()?.webContents?.send(ACTIVITY_CHANNEL, payload) } catch (_) {}
    try { if (getBrowserWindow) getBrowserWindow()?.webContents?.send(ACTIVITY_CHANNEL, payload) } catch (_) {}
  }

  /** 打开浏览器独立窗口并引导导航到任务 URL（浏览器窗口未开则先创建） */
  async function openDownloadPage(url) {
    let win = null
    if (typeof openBrowserWindow === 'function') {
      win = openBrowserWindow({})
    } else if (typeof getBrowserWindow === 'function') {
      win = getBrowserWindow()
    }
    if (!win || win.isDestroyed()) return { ok: false, error: '浏览器窗口不可用' }
    await sendWhenReady(win.webContents, OPEN_DOWNLOAD_CHANNEL, { url: String(url || '') })
    return { ok: true }
  }

  /** 领取（GET /tasks/assigned/{machine_id}，失败返回 [] 由 runOnePoll 兜底告警） */
  async function pickup(mid) {
    if (!mid) { onLog('无 machine_id，跳过领取'); return [] }
    const { httpRequest } = require('./server-proxy')
    const res = await httpRequest('GET', TASK_ASSIGNED(mid), { timeout: 10000 })
    return parsePickupResponse(res && res.data)
  }

  /** 上报（POST /tasks/{task_id}/report，multipart；2xx 即成功） */
  async function report(taskId, fields) {
    const { multipartUpload } = require('./server-proxy')
    await multipartUpload(TASK_REPORT(taskId), fields)
    return true
  }

  /** 单任务执行：引导下载（注入 browser-window 等运行时句柄） */
  function executeTask(task, log) {
    return executeDownloadTask(task, {
      openDownloadPage,
      getDownloadDir: () => resolveDownloadDir({ store, app }),
      maxWaitMs: downloadMaxWaitMs,
      pollMs: downloadPollMs,
      onLog: (msg) => { try { log ? log(msg) : onLog(msg) } catch (_) {} },
    })
  }

  /** 启动轮询（幂等；不阻塞主进程启动，异常静默） */
  async function start() {
    if (running) return
    running = true
    machineId = await resolveMachineId({ store }).catch(() => '')
    if (!machineId) onLog('未取得 machine_id，本轮跳过领取（仍保持轮询）')
    onLog(`领取循环启动 machine_id=${machineId} interval=${pollIntervalMs}ms`)
    loopPromise = (async () => {
      while (running) {
        const results = await runOnePoll({
          machineId,
          pickup,
          executeTask,
          report,
          isRunning: () => running,
          onLog,
        }).catch(() => [])
        for (const r of results) {
          pushActivity({ type: 'done', task_id: r.task_id, ok: r.ok, status: r.status })
          onLog(`任务 ${r.task_id} 上报 ${r.status} ${r.ok ? '成功' : '失败'}`)
        }
        // 轮询间隔（分段小睡，stop 可打断；对照原版 L55-58）
        const chunks = buildSleepChunks(pollIntervalMs)
        for (let i = 0; i < chunks && running; i++) await sleep(SLEEP_CHUNK_MS)
      }
    })()
    return loopPromise
  }

  /** 停止轮询（对标原版 stop L60-61） */
  function stop() {
    running = false
  }

  return { start, stop, getMachineId: () => machineId, isRunning: () => running, runOnePoll }
}

/** main.js 接线便捷入口：创建线程并异步启动（不 await，不阻塞主进程） */
function startClientTaskThread(deps) {
  const thread = createClientTaskThread(deps)
  void thread.start().catch(() => {})
  return thread
}

module.exports = {
  // 纯函数（单测面）
  isDownloadTask,
  parsePickupResponse,
  buildReportFields,
  snapshotDir,
  waitDownloadFile,
  buildSleepChunks,
  deriveMachineId,
  runOnePoll,
  // 运行时
  collectMachineInfo,
  resolveMachineId,
  resolveDownloadDir,
  executeDownloadTask,
  createClientTaskThread,
  startClientTaskThread,
  // 常量（事件通道 / 间隔）
  ACTIVITY_CHANNEL,
  OPEN_DOWNLOAD_CHANNEL,
  POLL_INTERVAL_MS,
  DOWNLOAD_MAX_WAIT_MS,
  DOWNLOAD_POLL_MS,
}
