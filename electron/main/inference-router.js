// ═══════════════════════════════════════════════════════════════
// inference-router.js — A2 双模式：主进程单例统一路由入口
//
// 规格 §1.5.1 决策流程（严格按顺序）：
//   1) inference.mode = 'server-only'  → 直接走 HTTP
//   2) inference.mode = 'force-local'  → 走本地，失败返回 LOCAL_NOT_READY
//   3) inference.mode = 'hybrid-auto'  → 检查 3 条前置条件：
//        - 原生模块 require 成功
//        - 模型文件齐全 + SHA256 通过
//        - 最近一次本地推理耗时 < 2s 阈值
//      → 全部 YES = 本地分支，否则 HTTP 分支
//   4) 本地分支异常兜底：抛错 / 耗时 >5s / 空结果 → 自动 fallback HTTP（Q3 红线）
//
// 红线 Q2：必须是主进程单例唯一入口，渲染层不做决策，不直接 require 原生模块
// ═══════════════════════════════════════════════════════════════

const PERF_WINDOW_MS = 5 * 60 * 1000   // 5 分钟滑动窗口
const LOCAL_SLOW_THRESHOLD_MS = 2000   // 连续 2 次 >2s → 自动切回服务端
const LOCAL_TIMEOUT_MS = 5000          // 单次本地推理 5s 超时 → fallback

class InferenceRouter {
  constructor({ store, modelManager, httpExecutor, localExecutors }) {
    /** @type {ElectronStore} inference.mode / inference.localPerf / inference.lastFallback 等 */
    this.store = store
    this.modelManager = modelManager
    /** 执行 HTTP 请求：(endpointPath, payload) => Promise<any> */
    this.httpExecutor = httpExecutor
    /** { ocr, embedding, coverCompose, vectorSearch } 本地执行器（可选，缺失=不可用） */
    this.localExecutors = localExecutors || {}
    /** 最近 N 次本地耗时（滑动窗口） */
    this._localDurations = []
    /** 本地能力可用性缓存（冷启动写一次，下载完成后刷新） */
    this._capabilityCache = null
    this._capabilityCachedAt = 0
  }

  // ──────────────── 工具：时间窗口平均 ────────────────
  _avgLocalDuration() {
    const now = Date.now()
    this._localDurations = this._localDurations.filter((d) => now - d.t < PERF_WINDOW_MS)
    if (this._localDurations.length === 0) return 0
    return this._localDurations.reduce((s, d) => s + d.ms, 0) / this._localDurations.length
  }
  _recordLocalDuration(ms, ok) {
    this._localDurations.push({ t: Date.now(), ms, ok })
    if (this._localDurations.length > 200) this._localDurations.shift()
  }

  // ──────────────── 工具：模式读取 ────────────────
  _getMode() {
    return (this.store && this.store.get('inference.mode')) || 'server-only'
  }

  // ──────────────── hybrid-auto 本地前置检查 ────────────────
  _checkHybridPreconditions(capability) {
    // 3 条：原生模块加载 OK / 模型 OK / 最近耗时 < 2s
    if (!capability.nativeModulesOk) return false
    if (!capability.modelsOk) return false
    const avg = this._avgLocalDuration()
    if (avg > 0 && avg >= LOCAL_SLOW_THRESHOLD_MS) return false
    return true
  }

  /**
   * 取得本地能力可用性（带 10s 缓存，避免每次都跑 verifyInstallation）
   */
  getCapability(force = false) {
    const now = Date.now()
    if (!force && this._capabilityCache && (now - this._capabilityCachedAt) < 10_000) {
      return this._capabilityCache
    }
    const iv = this.modelManager.verifyInstallation()
    const nativeModulesOk = Object.values(iv.details.nativeModules || {}).every((m) => m.ok)
    const modelsOk = Object.values(iv.details.pkgs || {}).every((p) => p.skipped || p.allOk)
    const cap = {
      mode: iv.inferenceMode,
      nativeModulesOk,
      modelsOk,
      avgLocalMs: this._avgLocalDuration(),
      detail: iv,
    }
    this._capabilityCache = cap
    this._capabilityCachedAt = now
    return cap
  }

  // ──────────────── 核心：route ────────────────
  /**
   * @param {'ocr'|'embedding'|'coverCompose'|'vectorSearch'} kind
   * @param {object} payload  — 对 OCR = { imageBuffer, lang }；对 vectorSearch = { query, topK } 等
   * @param {object} opts     — { httpEndpoint: string, httpMethod?: 'GET'|'POST' }
   */
  async route(kind, payload, opts = {}) {
    const t0 = Date.now()
    const mode = this._getMode()
    const capability = this.getCapability()
    const localFn = this.localExecutors[kind]

    // 决策分支
    let branch = 'http'
    if (mode === 'server-only') branch = 'http'
    else if (mode === 'force-local') branch = localFn ? 'local' : 'local_unavailable'
    else if (mode === 'hybrid-auto') branch = this._checkHybridPreconditions(capability) && localFn ? 'local' : 'http'

    // ====== 本地分支 ======
    if (branch === 'local') {
      try {
        const result = await withTimeout(localFn(payload), LOCAL_TIMEOUT_MS, `LOCAL_${kind.toUpperCase()}_TIMEOUT`)
        const dur = Date.now() - t0
        this._recordLocalDuration(dur, true)

        // 空结果兜底（Q3 红线）：hybrid-auto 下空结果自动 fallback HTTP
        const isEmpty = this._isEmptyResult(kind, result)
        if (isEmpty && mode === 'hybrid-auto') {
          this._fallbackLog(kind, 'EMPTY_RESULT', dur)
          return this._httpRun(kind, payload, opts, 'LOCAL_EMPTY_FALLBACK')
        }
        return { success: true, branch: 'local', durationMs: dur, data: result }
      } catch (err) {
        const dur = Date.now() - t0
        this._recordLocalDuration(dur, false)

        // force-local：直接抛 LOCAL_NOT_READY
        if (mode === 'force-local') {
          return {
            success: false,
            branch: 'local',
            durationMs: dur,
            error: 'LOCAL_NOT_READY',
            detail: err.message || String(err)
          }
        }
        // hybrid-auto：自动 fallback（Q3 红线，用户零感知）
        this._fallbackLog(kind, err.message || 'LOCAL_EXCEPTION', dur)
        return this._httpRun(kind, payload, opts, 'LOCAL_EXCEPTION_FALLBACK')
      }
    }

    if (branch === 'local_unavailable') {
      return {
        success: false, branch: 'local', durationMs: Date.now() - t0,
        error: 'LOCAL_NOT_READY', detail: `本地 ${kind} 执行器未加载`
      }
    }

    // ====== HTTP 分支 ======
    return this._httpRun(kind, payload, opts, `${mode.toUpperCase()}_DIRECT`)
  }

  // ──────────────── 工具：空结果判定 ────────────────
  _isEmptyResult(kind, result) {
    if (!result) return true
    switch (kind) {
      case 'ocr':
        return !Array.isArray(result.lines) || result.lines.length === 0
      case 'embedding':
        return !Array.isArray(result.vector) || result.vector.length === 0
      case 'vectorSearch':
        return !Array.isArray(result.hits) || result.hits.length === 0
      case 'coverCompose':
        return !result.outputPath
      default:
        return !result
    }
  }

  // ──────────────── 工具：HTTP 运行 ────────────────
  async _httpRun(kind, payload, opts, reason) {
    const t0 = Date.now()
    try {
      const data = await this.httpExecutor({
        endpoint: opts.httpEndpoint,
        method: opts.httpMethod || 'POST',
        payload,
      })
      return { success: true, branch: 'http', durationMs: Date.now() - t0, data, fallbackReason: reason }
    } catch (err) {
      return {
        success: false, branch: 'http', durationMs: Date.now() - t0,
        error: 'HTTP_ERROR', detail: err.message || String(err),
        fallbackReason: reason
      }
    }
  }

  // ──────────────── 工具：fallback 日志（写 store + console）────────────────
  _fallbackLog(kind, reason, durationMs) {
    const entry = { t: Date.now(), kind, reason, durationMs }
    const history = (this.store && this.store.get('inference.fallbackHistory')) || []
    history.push(entry)
    if (history.length > 100) history.shift()
    this.store && this.store.set('inference.fallbackHistory', history)
    console.warn(`[A2 Router] ${kind} fallback → ${reason} (${durationMs}ms)`)
  }
}

// ──────────────── 工具：Promise 超时 ────────────────
function withTimeout(promise, ms, errorMsg = 'TIMEOUT') {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(errorMsg)), ms)
    Promise.resolve(promise)
      .then((v) => { clearTimeout(timer); resolve(v) })
      .catch((e) => { clearTimeout(timer); reject(e) })
  })
}

module.exports = { InferenceRouter }
