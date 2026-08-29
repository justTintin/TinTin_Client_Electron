// ═══════════════════════════════════════════════════════════════
// useAutoListing — 浏览器·自动上架面板域（B12 UI 接线）
// 对位基准：V2 PRD 14.3 页面结构（① 数据包 ② 执行 ③ 进度日志 ④ 结果）
//   + 原 studio/gui/auto_listing_tab.py（L133-242 卡片布局语义）。
// 接线：主进程引擎 desktop/main/auto-listing/*（config/package/validate/
//   state/engine/ipc 已完成），渲染端经 window.tintinBrowser.autoListing
//   （browser-preload.js 白名单）走 7 条 IPC + 订阅式进度通道
//   'auto-listing:progress'（autoListing:onProgress 注册）。
// 配置：config-store autoListing.* 键（shopKey/publishAfterSave），
//   读-合并-写（electron-store set 为整对象覆盖，syncDir/resultDir 回填
//   默认不丢）。
// 分层：本 composable 只做状态持有 + IPC 编排 + 进度编组（业务纯函数在
//   autoListingMeta.ts），组件 AutoListingView 纯展示 + 事件转发。
// 异常分支（至少四类）：引擎离线 / 浏览器窗口未就绪（启动/校验 error
//   含「打开浏览器窗口」引导）/ 校验失败 / 停止 / 任务失败与 5xx。
// ═══════════════════════════════════════════════════════════════

import { ref, watch, onUnmounted } from 'vue'
import { DOUYIN_STORES, storeMetaByKey, parseProgressMessage, runStatusMeta } from './autoListingMeta'
import type { AutoListingRunLike } from './autoListingMeta'

/** 校验摘要（对齐 autoListing:validate 返回 data，global.d.ts TintinAutoListingValidateData） */
export interface AutoListingSummary {
  runId: string
  title: string
  shopName: string
  shopKey: string
  skuCount: number
  skus: Array<{ name: string; merchant_code: string }>
  mainImages: number
  detailImages: number
  skuImages: number
  warnings: string[]
}

/** 进度阶段条目（阶段进度列表渲染用） */
export interface AutoListingPhase {
  stage: string
  message: string
  ts: number
}

/** 引擎离线/未就绪时的统一错误文案 */
const ERR_ENGINE_OFFLINE = '自动上架引擎不可用（主进程未加载 auto-listing 模块），请重启应用后重试'

/** 读 electron-store 配置（无 tintinBrowser.config 返回默认；语义与主应用 useSettingsConfig.readCfg 一致） */
async function readCfg(key: string, def: unknown): Promise<any> {
  const t = (window as any).tintinBrowser
  if (!t?.config?.get) return def
  try { return (await t.config.get(key)) ?? def } catch (_) { return def }
}

/** 写配置到 electron-store（返回主进程确认结果；无 IPC / 异常 / success:false 均为 false） */
async function writeCfg(key: string, val: any): Promise<boolean> {
  const t = (window as any).tintinBrowser
  if (!t?.config?.set) return false
  try { return (await t.config.set(key, val)) === true } catch (_) { return false }
}

/** 访问 autoListing IPC 命名空间（引擎离线 → null） */
function alApi(): any {
  const t = (window as any).tintinBrowser
  return t?.autoListing || null
}

export function useAutoListing() {
  // ── 配置 ──
  const shopKey = ref<string>('juyou')
  const publishAfterSave = ref(false)
  const saving = ref(false)
  const saved = ref(false)
  const cfgLoaded = ref(false)

  // ── ① 数据包 ──
  const inputPath = ref('')
  const validating = ref(false)
  const summary = ref<AutoListingSummary | null>(null)
  const validateError = ref('')

  // ── ② 执行 ──
  const running = ref(false)
  const currentRunId = ref('')
  const actionBusy = ref(false)
  const actionError = ref('')

  // ── ③ 进度日志 ──
  const phases = ref<AutoListingPhase[]>([])
  const logs = ref<string[]>([])
  const lastResult = ref<{ saved?: boolean; publish_attempted?: boolean; result_dir?: string; sku_count?: number } | null>(null)

  // ── ④ 结果 ──
  const runs = ref<AutoListingRunLike[]>([])
  const runsLoaded = ref(false)
  const openDirMsg = ref('')

  let unsubProgress: (() => void) | null = null
  const MAX_LOG_LINES = 500

  /** 日志行（[HH:MM:SS] 前缀，对齐原 tab log_view 追加形态） */
  function pushLog(line: string) {
    const d = new Date()
    const p = (n: number) => String(n).padStart(2, '0')
    const stamp = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
    logs.value.push(`[${stamp}] ${line}`)
    if (logs.value.length > MAX_LOG_LINES) logs.value.splice(0, logs.value.length - MAX_LOG_LINES)
  }

  /** 阶段列表：同阶段收敛为一条（更新消息），跨阶段追加（阶段进度列表） */
  function appendPhase(stage: string, text: string, ts: number) {
    const last = phases.value[phases.value.length - 1]
    if (last && last.stage === stage) last.message = text
    else phases.value.push({ stage, message: text, ts })
  }

  /** 新任务开始时清空进度/日志/结果 */
  function beginLog(runId: string) {
    currentRunId.value = runId
    phases.value = []
    logs.value = []
    lastResult.value = null
    openDirMsg.value = ''
    actionError.value = ''
  }

  // ── 配置读写 ──
  async function loadCfg() {
    const cfg = await readCfg('autoListing', null)
    if (cfg && typeof cfg === 'object') {
      if (typeof cfg.shopKey === 'string' && cfg.shopKey) shopKey.value = cfg.shopKey
      if (typeof cfg.publishAfterSave === 'boolean') publishAfterSave.value = cfg.publishAfterSave
    }
    cfgLoaded.value = true
  }

  async function saveCfg() {
    if (saving.value) return
    saving.value = true
    try {
      const cur = (await readCfg('autoListing', {})) || {}
      const merged = { ...(cur && typeof cur === 'object' ? cur : {}), shopKey: shopKey.value, publishAfterSave: publishAfterSave.value }
      await writeCfg('autoListing', merged)
      saved.value = true
      setTimeout(() => { saved.value = false }, 1500)
    } finally {
      saving.value = false
    }
  }

  /** 输入路径变化 → 旧校验结果失效 */
  watch(inputPath, () => {
    summary.value = null
    validateError.value = ''
  })

  // ── ① 数据包校验 ──
  async function validatePackage() {
    const api = alApi()
    if (!api) { validateError.value = ERR_ENGINE_OFFLINE; summary.value = null; return }
    const path = inputPath.value.trim()
    if (!path) { validateError.value = '请先输入数据包路径（目录或 .zip 压缩包）'; summary.value = null; return }
    if (validating.value) return
    validating.value = true
    validateError.value = ''
    try {
      const r = await api.validate({ inputPath: path, shopKey: shopKey.value })
      if (r?.success && r?.data) {
        summary.value = r.data
        validateError.value = ''
        pushLog(`[校验] 数据包校验通过：${r.data.title || '（未命名商品）'}，${r.data.skuCount} 个SKU（runId=${r.data.runId}）`)
      } else {
        summary.value = null
        const err = r?.error || '数据包校验失败'
        validateError.value = err
        pushLog(`[校验] 失败：${err}`)
      }
    } catch (e) {
      summary.value = null
      validateError.value = `校验请求异常：${(e as Error)?.message || String(e)}`
      pushLog(`[校验] 请求异常：${(e as Error)?.message || String(e)}`)
    } finally {
      validating.value = false
    }
  }

  // ── ② 执行：开始 / 停止 / 断点续跑 / 状态轮询 ──
  async function startTask() {
    const api = alApi()
    if (!api) { actionError.value = ERR_ENGINE_OFFLINE; return }
    const path = inputPath.value.trim()
    if (!path) { actionError.value = '请先输入数据包路径（目录或 .zip 压缩包）'; return }
    if (running.value) { actionError.value = '已有自动上架任务运行中，请先停止'; return }
    if (actionBusy.value) return
    actionBusy.value = true
    actionError.value = ''
    try {
      const r = await api.start({
        inputPath: path,
        shopKey: shopKey.value,
        publishAfterSave: publishAfterSave.value,
        runId: summary.value?.runId || undefined, // 复用校验已 staging 的数据包（从阶段1继续）
      })
      if (r?.success && r?.data) {
        running.value = true
        beginLog(r.data.runId)
        pushLog('[启动] 自动上架任务已启动，浏览器窗口将执行商品填写…')
        void loadRuns()
      } else {
        actionError.value = r?.error || '启动失败'
        pushLog(`[启动] 失败：${actionError.value}`)
      }
    } catch (e) {
      actionError.value = `启动请求异常：${(e as Error)?.message || String(e)}`
    } finally {
      actionBusy.value = false
    }
  }

  async function stopTask() {
    const api = alApi()
    if (!api) { actionError.value = ERR_ENGINE_OFFLINE; return }
    actionBusy.value = true
    try {
      const r = await api.stop()
      if (r?.success) {
        if (r.data?.stopped) {
          actionError.value = ''
          pushLog(`[停止] 已请求停止（runId=${r.data.runId}），当前步骤完成后退出…`)
        } else {
          actionError.value = r.data?.reason === 'NO_RUNNING_TASK' ? '当前没有运行中的自动上架任务' : ''
        }
      } else {
        actionError.value = r?.error || '停止请求失败'
      }
    } catch (e) {
      actionError.value = `停止请求异常：${(e as Error)?.message || String(e)}`
    } finally {
      actionBusy.value = false
    }
  }

  async function resumeTask(runId: string) {
    const api = alApi()
    if (!api) { actionError.value = ERR_ENGINE_OFFLINE; return }
    if (!runId) { actionError.value = '缺少 runId，无法断点续跑'; return }
    if (running.value) { actionError.value = '已有自动上架任务运行中，请先停止'; return }
    if (actionBusy.value) return
    actionBusy.value = true
    actionError.value = ''
    try {
      const r = await api.resume({ runId, publishAfterSave: publishAfterSave.value })
      if (r?.success && r?.data) {
        running.value = true
        beginLog(runId)
        pushLog(`[续跑] 任务 ${runId} 已恢复执行…`)
        void loadRuns()
      } else {
        actionError.value = r?.error || '断点续跑失败'
        pushLog(`[续跑] 失败：${actionError.value}`)
      }
    } catch (e) {
      actionError.value = `续跑请求异常：${(e as Error)?.message || String(e)}`
    } finally {
      actionBusy.value = false
    }
  }

  async function refreshStatus() {
    const api = alApi()
    if (!api) return
    try {
      const r = await api.status()
      if (r?.success && r.data) {
        running.value = !!r.data.running
        if (r.data.runId) currentRunId.value = r.data.runId
      }
    } catch (_) { /* 状态查询失败静默（下次任务动作会重报） */ }
  }

  // ── ③ 进度订阅（固定 channel 'auto-listing:progress'）──
  function subscribeProgress() {
    const api = alApi()
    if (!api?.onProgress) return
    unsubProgress = api.onProgress((p: any) => {
      if (!p) return
      if (p.stage === 'done') {
        running.value = false
        lastResult.value = p.result || null
        if (p.result?.result_dir) pushLog(`[完成] 任务完成；结果目录：${p.result.result_dir}`)
        else pushLog('[完成] 任务完成')
        if (p.message && p.message !== '任务完成') pushLog(`[完成] ${p.message}`)
        void loadRuns()
      } else if (p.stage === 'error') {
        running.value = false
        actionError.value = p.message || '任务失败'
        pushLog(`[错误] ${p.message || '任务失败'}`)
        void loadRuns()
      } else {
        const { stage, text } = parseProgressMessage(p.message)
        pushLog(`[${stage}] ${text}`)
        appendPhase(stage, text, p.ts || Date.now())
      }
    })
  }

  // ── ④ 结果：历史运行列表 + 打开结果目录 ──
  async function loadRuns() {
    const api = alApi()
    if (!api) return
    try {
      const r = await api.listRuns()
      if (r?.success && r.data) {
        runs.value = r.data.runs || []
        runsLoaded.value = true
      }
    } catch (_) { /* 列表查询失败静默 */ }
  }

  async function openResult(runId: string) {
    const api = alApi()
    if (!api) { actionError.value = ERR_ENGINE_OFFLINE; return }
    try {
      const r = await api.openResultDir(runId)
      if (r?.success) openDirMsg.value = ''
      else {
        openDirMsg.value = r?.error || '打开结果目录失败'
        pushLog(`[结果] 打开目录失败：${openDirMsg.value}`)
      }
    } catch (e) {
      openDirMsg.value = `打开结果目录异常：${(e as Error)?.message || String(e)}`
    }
  }

  /** 挂载初始化：读配置 → 恢复运行态 → 订阅进度 → 拉历史 */
  async function init() {
    await loadCfg()
    await refreshStatus()
    subscribeProgress()
    await loadRuns()
  }

  onUnmounted(() => {
    if (unsubProgress) { unsubProgress(); unsubProgress = null }
  })

  return {
    // 数据源
    stores: DOUYIN_STORES,
    storeMetaByKey,
    runStatusMeta,
    // 配置
    shopKey, publishAfterSave, saving, saved, cfgLoaded, loadCfg, saveCfg,
    // ① 数据包
    inputPath, validating, summary, validateError, validatePackage,
    // ② 执行
    running, currentRunId, actionBusy, actionError, startTask, stopTask, resumeTask, refreshStatus,
    // ③ 进度日志
    phases, logs, lastResult,
    // ④ 结果
    runs, runsLoaded, openDirMsg, loadRuns, openResult,
    init,
  }
}

export type UseAutoListingReturn = ReturnType<typeof useAutoListing>
