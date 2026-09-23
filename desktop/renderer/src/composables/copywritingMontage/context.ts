// ═══════════════════════════════════════════════════════════════
// montage/context.ts — 智能混剪四步编排共享设施（铁律 10 拆分，2026-09-18）
// 拆分蓝图见 docs/智能混剪拆分迁移映射_2026-09-18.md。
// 持有：模块级纯工具 + 共享运行时（服务端地址/轮询状态机/clearBusy 槽）。
// 纯搬迁约定：符号名与行为与原 useCopywritingMontage.ts 逐字一致（IRON-02）；
// 唯一机械适配：clearBusy 闭包槽改经 setClearBusy 存取（槽语义不变）。
// ═══════════════════════════════════════════════════════════════
import { ref } from 'vue'
import { extractTaskObj, mapTaskStatus, pollPhaseText } from '../copywritingMontageCommonLogic'

export const POLL_INTERVAL_MS = 3000   // 对照原版轮询周期（_query_single_rh_task L656 同口径）
export const POLL_TIMEOUT_MS = 600_000 // 10 分钟上限

export function notify(title: string, body: string): void {
  try { window.tintin?.shell?.showNotification?.(title, body) } catch (_) {}
}

/** IpcError 三态分流：null=离线 / {error}=业务与 HTTP 错误 / 正常数据 */
export function unwrapIpc<T>(res: T | null | { error: string }, label: string): T {
  if (res === null || res === undefined) {
    throw new Error(`${label}：服务端不可达（OFFLINE），请检查服务端地址与网络`)
  }
  if (typeof res === 'object' && 'error' in (res as Record<string, unknown>)) {
    throw new Error(`${label}：${String((res as Record<string, unknown>).error)}`)
  }
  return res as T
}

export function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** Windows 路径拼接（渲染层无 node path；混剪缓存目录专用） */
export function joinPath(...parts: string[]): string {
  return parts
    .filter(Boolean)
    .map((s, i) => (i === 0 ? s.replace(/[\\/]+$/, '') : s.replace(/^[\\/]+|[\\/]+$/g, '')))
    .join('\\')
}

/** 轮询通道：unified=GET /tasks/unified/{id}；scheduled=GET /scheduled/tasks/{id}（契约各自指定） */
export type PollChannel = 'unified' | 'scheduled'

// ── 共享运行时（服务端地址 + 轮询状态机 + clearBusy 槽）────────
// 自 useCopywritingMontage.ts 纯搬迁；四步 composable 经 ctx 注入消费（映射文档 §四）。

export interface MontageSharedRuntime {
  serverUrl: import('vue').Ref<string>
  ensureServerUrl: () => Promise<string>
  toAbsolute: (url: string) => string
  polling: import('vue').Ref<boolean>
  activeTaskId: import('vue').Ref<string>
  statusText: import('vue').Ref<string>
  stopPolling: () => void
  cancelPolling: () => void
  /** 静默中止（原 onUnmounted 的 pollCancelled=true + stopPolling 组合，无文案/清 busy 副作用） */
  abortPolling: () => void
  startPolling: (opts: {
    id: string
    channel: PollChannel
    onDone: (task: Record<string, unknown>) => void
    onFail: (msg: string) => void
  }) => void
  /** clearBusy 槽写入（原闭包直接赋值，槽语义不变） */
  setClearBusy: (fn: (() => void) | null) => void
}

export function createMontageSharedRuntime(): MontageSharedRuntime {
  // ── 服务端地址（结果相对路径拼绝对 URL；单一地址源 getServerUrl 经 env:serverPing 取回）──
  const serverUrl = ref('')
  async function ensureServerUrl(): Promise<string> {
    if (serverUrl.value) return serverUrl.value
    try {
      const ping = await (window as any).tintin?.env?.serverPing?.()
      serverUrl.value = String(ping?.url || '')
    } catch (_) { /* 预览环境无 env 桥 → 空串，结果按相对路径下载 */ }
    return serverUrl.value
  }

  /** 相对路径 → 绝对 URL（http 原样；无 serverUrl 时保持相对，下载由主进程按 getServerUrl 解析） */
  function toAbsolute(url: string): string {
    const u = String(url || '')
    if (!u || /^https?:\/\//i.test(u)) return u
    return serverUrl.value ? serverUrl.value.replace(/\/$/, '') + u : u
  }

  // ── 共享轮询状态机（同一时刻一个活动任务；超时/失败/取消统一口径）──
  const polling = ref(false)
  const activeTaskId = ref('')
  const statusText = ref('')
  let pollTimer: ReturnType<typeof setInterval> | null = null
  let pollCancelled = false
  let clearBusy: (() => void) | null = null

  function stopPolling(): void {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
    polling.value = false
  }

  function cancelPolling(): void {
    pollCancelled = true
    stopPolling()
    statusText.value = '已取消等待（可重新提交重试）'
    if (clearBusy) { clearBusy(); setClearBusy(null) }
  }

  /** 静默中止：置取消标志 + 停表，不改 statusText、不清 busy（onUnmounted 口径） */
  function abortPolling(): void {
    pollCancelled = true
    stopPolling()
  }

  function startPolling(opts: {
    id: string
    channel: PollChannel
    onDone: (task: Record<string, unknown>) => void
    onFail: (msg: string) => void
  }): void {
    stopPolling()
    pollCancelled = false
    polling.value = true
    activeTaskId.value = opts.id
    const startedAt = Date.now()
    let inFlight = false
    const tick = async (): Promise<void> => {
      if (inFlight || pollCancelled) return
      inFlight = true
      try {
        const resp = opts.channel === 'unified'
          ? await window.tintin.server.tasksUnifiedItem(opts.id)
          : await window.tintin.server.get<Record<string, unknown>>(
              `/scheduled/tasks/${encodeURIComponent(opts.id)}`)
        if (!resp || (resp as Record<string, unknown>).error) {
          // 单次查询失败/离线不终止轮询（对照原版轮询失败静默重试）
          statusText.value = pollPhaseText(null, (Date.now() - startedAt) / 1000)
          return
        }
        const task = extractTaskObj(resp) as Record<string, any>
        // 错误字段名归一：unified 节点 error_message / scheduled error_msg
        const errCarrier = {
          error_msg: task.error_message || task.error_msg || task.error || task.message || '',
        }
        const info = mapTaskStatus(task.status ?? task.state, errCarrier)
        if (info.phase === 'done') {
          stopPolling()
          opts.onDone((task.result ?? task) as Record<string, unknown>)
        } else if (info.phase === 'failed') {
          stopPolling()
          opts.onFail(info.error)
        } else {
          statusText.value = pollPhaseText(task.progress, (Date.now() - startedAt) / 1000)
          if (Date.now() - startedAt > POLL_TIMEOUT_MS) {
            stopPolling()
            opts.onFail(`轮询超时（${Math.round(POLL_TIMEOUT_MS / 1000)}s），可重新提交重试`)
          }
        }
      } catch (_) {
        // 查询异常保持等待下一拍
      } finally {
        inFlight = false
      }
    }
    void tick()
    pollTimer = setInterval(() => { void tick() }, POLL_INTERVAL_MS)
  }

  function setClearBusy(fn: (() => void) | null): void {
    clearBusy = fn
  }

  // 2026-09-23 用户报障（选择池/分镜卡缩略图黑屏）根因：toAbsolute 依赖 serverUrl，
  // 而它只在分割/下载/合成等动作里被惰性初始化——重启后直接进素材库/预览时 serverUrl
  // 仍为空串，toAbsolute 产出相对路径，<video>/<img> 落在 dev origin 上 404 → 黑屏。
  // 运行时创建即预热 ping（fire-and-forget），reactive 消费方随后自动获得绝对 URL。
  void ensureServerUrl()

  return {
    serverUrl, ensureServerUrl, toAbsolute,
    polling, activeTaskId, statusText,
    stopPolling, cancelPolling, abortPolling, startPolling, setClearBusy,
  }
}
