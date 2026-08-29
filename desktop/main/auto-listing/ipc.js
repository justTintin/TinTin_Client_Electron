// ═══════════════════════════════════════════════════════════════
// auto-listing/ipc.js — B12 自动上架：IPC 白名单注册（主进程）
//
// 通道（全部 ipcMain.handle，返回 {success, data?|error}）：
//   autoListing:validate      → 数据包导入+校验（staging 产生 runId，PRD 14.6）
//   autoListing:start         → 启动后台任务（互斥；可复用 validate 的 runId）
//   autoListing:stop          → 请求停止（shouldStop → 抛「任务已停止」）
//   autoListing:resume        → 断点续跑（读 state.json + URL 特征）
//   autoListing:status        → 当前任务状态（运行中/阶段/URL/runId）
//   autoListing:listRuns      → 列出 runs 目录全部 runId + state 摘要
//   autoListing:openResultDir → 打开 results/<runId> 目录
//   autoListing:onProgress    → 订阅式（固定 channel 'auto-listing:progress'，
//     参照 browser:extractDOM/onUrlUpdated 固定 channel 模式）
// 执行载体：BrowserView persist:tintin-fxg（getView 注入，engine 内
//   executeJavaScript + wc.debugger DOM.setFileInputFiles + capturePage）。
// 日志：userData/auto-listing/logs/<runId>.log + logger.js 全局日志双写。
// ═══════════════════════════════════════════════════════════════
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { shell } = require('electron')
const logger = require('../logger')
const { loadConfig, saveConfig } = require('./config')
const { preparePackage } = require('./package')
const { AutoListingEngine, ListingError } = require('./engine')
const { runsRootDir, readState, writeState } = require('./state')

const PROGRESS_CHANNEL = 'auto-listing:progress'

function createAutoListingIpc(ipcMain, ctx) {
  // ctx: { store, app, getBrowserWindow, getOrCreateView }
  const { store, app, getBrowserWindow, getOrCreateView } = ctx
  const userDataDir = () => app.getPath('userData')
  const cfg = () => loadConfig(store, userDataDir())

  /** 当前活跃任务（单任务互斥；PRD：任务使用客户端 Worker 直接执行） */
  let current = null // { runId, engine, promise }
  let _stopRequested = false

  /** 进度广播（订阅式固定 channel） */
  function _broadcast(payload) {
    try {
      const bw = getBrowserWindow()
      if (bw && !bw.isDestroyed()) bw.webContents.send(PROGRESS_CHANNEL, payload)
    } catch (_) {}
  }

  /** run 日志：userData/auto-listing/logs/<runId>.log + logger.js 双写 */
  function _runLog(runId, lvl, msg) {
    try {
      const file = path.join(userDataDir(), 'auto-listing', 'logs', String(runId) + '.log')
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const d = new Date()
      const p = (n, w = 2) => String(n).padStart(w, '0')
      const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
      fs.appendFileSync(file, `[${stamp}] [${lvl}] ${String(msg)}\n`)
    } catch (_) {}
    try {
      if (lvl === 'ERROR') logger.logError('auto-listing', msg)
      else if (lvl === 'WARN') logger.logWarn('auto-listing', msg)
      else logger.logInfo('auto-listing', msg)
    } catch (_) {}
  }

  /** 确保 fxg BrowserView 存在并挂载到浏览器窗口（未打开浏览器窗口 → 报错引导） */
  function _ensureFxgView() {
    const bw = getBrowserWindow()
    if (!bw) throw new ListingError('请先打开浏览器窗口（抖店工作台）')
    const view = getOrCreateView('fxg')
    const views = bw.getBrowserViews ? (bw.getBrowserViews() || []) : []
    if (!views.includes(view)) bw.addBrowserView(view)
    return view
  }

  /** 创建引擎（注入执行通道 + 进度/停止/日志回调） */
  function _makeEngine(runId) {
    return new AutoListingEngine({
      getView: () => {
        try { return _ensureFxgView() } catch (_) { return null }
      },
      userDataDir: userDataDir(),
      store,
      onProgress: (msg) => _broadcast({ runId, stage: 'progress', message: msg, ts: Date.now() }),
      shouldStop: () => _stopRequested,
      log: (lvl, msg) => _runLog(runId, lvl, msg),
    })
  }

  /** 后台执行包装（互斥 + 收尾清空 current + 结束广播） */
  function _launch(runId, engine, promise) {
    current = { runId, engine, promise }
    promise
      .then((result) => {
        _broadcast({ runId, stage: 'done', message: '任务完成', result, ts: Date.now() })
      })
      .catch((e) => {
        const msg = e && e.message ? e.message : String(e)
        _runLog(runId, 'ERROR', msg)
        try { writeState(runsRootDir(cfg().syncDir), runId, { status: 'failed', error: msg }) } catch (_) {}
        _broadcast({ runId, stage: 'error', message: msg, ts: Date.now() })
      })
      .finally(() => {
        if (current && current.runId === runId) current = null
        _stopRequested = false
      })
    return { runId }
  }

  function _summary(info) {
    return {
      title: info.title,
      shopName: info.shop_name,
      shopKey: info.shop_key,
      skuCount: info.skus.length,
      skus: info.skus.map((s) => ({ name: s.name, merchant_code: s.merchant_code })),
      mainImages: info.main_images.length,
      detailImages: info.detail_images.length,
      skuImages: info.sku_images.length,
      warnings: info.warnings,
    }
  }

  // ── autoListing:validate ──
  ipcMain.handle('autoListing:validate', async (_e, payload) => {
    try {
      const p = payload || {}
      const c = cfg()
      const res = await preparePackage(p.inputPath, p.shopKey || c.shopKey, { syncDir: c.syncDir, runId: p.runId })
      _runLog(res.runId, 'INFO', `校验通过：${res.info.title || '（未命名商品）'} / ${res.info.skus.length} 个SKU`)
      return { success: true, data: { runId: res.runId, ..._summary(res.info) } }
    } catch (e) {
      return { success: false, error: e && e.message ? e.message : String(e) }
    }
  })

  // ── autoListing:start ──
  ipcMain.handle('autoListing:start', async (_e, payload) => {
    try {
      if (current) return { success: false, error: '已有自动上架任务运行中，请先停止' }
      const p = payload || {}
      _stopRequested = false
      const engine = _makeEngine(p.runId || '')
      let promise
      if (p.runId && fs.existsSync(path.join(cfg().syncDir, 'runs', String(p.runId)))) {
        // 复用 validate 已 staging 的 runId（从阶段1继续）
        promise = engine.resume({ runId: p.runId, publishAfterSave: p.publishAfterSave })
      } else {
        promise = engine.run({
          inputPath: p.inputPath,
          shopKey: p.shopKey,
          publishAfterSave: p.publishAfterSave,
          runId: p.runId,
        })
      }
      const runId = p.runId || String(Date.now())
      return { success: true, data: _launch(runId, engine, promise) }
    } catch (e) {
      return { success: false, error: e && e.message ? e.message : String(e) }
    }
  })

  // ── autoListing:stop ──
  ipcMain.handle('autoListing:stop', () => {
    if (!current) return { success: true, data: { stopped: false, reason: 'NO_RUNNING_TASK' } }
    _stopRequested = true
    return { success: true, data: { stopped: true, runId: current.runId } }
  })

  // ── autoListing:resume ──
  ipcMain.handle('autoListing:resume', async (_e, payload) => {
    try {
      if (current) return { success: false, error: '已有自动上架任务运行中，请先停止' }
      const p = payload || {}
      if (!p.runId) return { success: false, error: '缺少 runId' }
      _stopRequested = false
      const engine = _makeEngine(p.runId)
      const promise = engine.resume({ runId: p.runId, publishAfterSave: p.publishAfterSave })
      return { success: true, data: _launch(p.runId, engine, promise) }
    } catch (e) {
      return { success: false, error: e && e.message ? e.message : String(e) }
    }
  })

  // ── autoListing:status ──
  ipcMain.handle('autoListing:status', () => {
    try {
      if (!current) return { success: true, data: { running: false } }
      return { success: true, data: { running: true, runId: current.runId } }
    } catch (e) {
      return { success: false, error: e.message }
    }
  })

  // ── autoListing:listRuns ──
  ipcMain.handle('autoListing:listRuns', () => {
    try {
      const runsRoot = runsRootDir(cfg().syncDir)
      const out = []
      if (fs.existsSync(runsRoot)) {
        for (const name of fs.readdirSync(runsRoot)) {
          const state = readState(runsRoot, name)
          if (state) out.push({ runId: name, stage: state.stage, status: state.status, ts: state.ts, sourceName: state.sourceName || '', title: state.title || '' })
        }
      }
      out.sort((a, b) => (b.ts || 0) - (a.ts || 0))
      return { success: true, data: { runs: out } }
    } catch (e) {
      return { success: false, error: e.message }
    }
  })

  // ── autoListing:openResultDir ──
  ipcMain.handle('autoListing:openResultDir', async (_e, runId) => {
    try {
      const dir = path.join(cfg().resultDir, String(runId || ''))
      if (!fs.existsSync(dir)) return { success: false, error: '结果目录不存在：' + dir }
      const err = await shell.openPath(dir)
      return err ? { success: false, error: err } : { success: true }
    } catch (e) {
      return { success: false, error: e.message }
    }
  })

  // ── autoListing:onProgress（订阅式固定 channel，参照 browser:onUrlUpdated）──
  ipcMain.handle('autoListing:onProgress', () => {
    try { return { success: true, channel: PROGRESS_CHANNEL } } catch (e) { return { success: false, error: e.message } }
  })

  return {
    channel: PROGRESS_CHANNEL,
    saveConfig: (patch) => saveConfig(store, userDataDir(), patch),
    loadConfig: () => cfg(),
    isRunning: () => !!current,
  }
}

module.exports = { createAutoListingIpc, PROGRESS_CHANNEL }
