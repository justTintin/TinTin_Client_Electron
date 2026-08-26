// ═══════════════════════════════════════════════════════════════
// Server Store — 服务端状态
//
// 1) 管理在线状态 / 能力开关（12 项完整字段，对齐 S4 GET /health/capabilities）
// 2) 队列负载（rembg/vsr/whisper 等）
// 3) 能力注册表（GET /agent/registry，来自 V2 分工 §13 Orchestrator）
// 4) 工作台 4 卡片统计（GET /stats/workbench）
// 5) 60s 能力轮询，离线时静默降级不打堆栈
// ═══════════════════════════════════════════════════════════════

import { defineStore } from 'pinia'
import { ref, reactive } from 'vue'
import type {
  HealthAPI,
  StatsAPI,
  CapabilityRegistryItem,
  CapabilitySwitch,
} from '../../../types/server-api'

/** 服务端在线状态 */
export type ServerStatus = 'online' | 'offline' | 'checking'

/** 12 项能力的 "布尔开关"（业务层渲染用：灰态卡片直接取这个） */
export interface ServerCapabilities {
  rembg:          boolean   // V3 S1
  vsr:            boolean   // V3 S2
  vsr_remove:     boolean
  whisper:        boolean
  voice_clone:    boolean
  stock_search:   boolean
  reverse_prompt: boolean   // V3 S3
  llm:            boolean
  asr:            boolean
  digital_human:  boolean
  montage:        boolean
  ocr:            boolean
}

/** 服务端能力详细配置（模型列表、队列、mode 等，渲染层要显示模型下拉时取这个） */
export interface ServerCapabilityDetail {
  rembg:          CapabilitySwitch
  vsr:            CapabilitySwitch
  vsr_remove:     CapabilitySwitch
  whisper:        CapabilitySwitch
  voice_clone:    CapabilitySwitch
  stock_search:   CapabilitySwitch
  reverse_prompt: CapabilitySwitch
  llm:            CapabilitySwitch
  asr:            CapabilitySwitch
  digital_human:  CapabilitySwitch
  montage:        CapabilitySwitch
  ocr:            CapabilitySwitch
}

/** 服务端队列负载概览（能力队列名 -> 排队任务数） */
export interface QueueLoad {
  [queueName: string]: number
}

/** 工作台 4 卡片统计（V3 PRD §3.1.4 与 /stats/workbench 返回一致） */
export interface WorkbenchStats {
  recentTasks:  number
  runningTasks: number
  scripts:      number
  materials:    number
}

const DEFAULT_CAP_BOOL: ServerCapabilities = {
  rembg: false, vsr: false, vsr_remove: false,
  whisper: false, voice_clone: false, stock_search: false,
  reverse_prompt: false, llm: false, asr: false,
  digital_human: false, montage: false, ocr: false,
}
const DEFAULT_CAP_DETAIL: ServerCapabilityDetail = {
  rembg:          { enabled: false },
  vsr:            { enabled: false },
  vsr_remove:     { enabled: false },
  whisper:        { enabled: false },
  voice_clone:    { enabled: false },
  stock_search:   { enabled: false },
  reverse_prompt: { enabled: false },
  llm:            { enabled: false },
  asr:            { enabled: false },
  digital_human:  { enabled: false },
  montage:        { enabled: false },
  ocr:            { enabled: false },
}

/** 轮询间隔（毫秒） */
const POLL_INTERVAL = 60_000

export const useServerStore = defineStore('server', () => {
  // ── 状态 ────────────────────────────────────────────────────────
  const status = ref<ServerStatus>('checking')
  const serverTime = ref<string>('')
  const capabilities = reactive<ServerCapabilities>({ ...DEFAULT_CAP_BOOL })
  const capabilityDetail = reactive<ServerCapabilityDetail>({ ...DEFAULT_CAP_DETAIL })
  const queueLoad = reactive<QueueLoad>({})
  const registry = ref<CapabilityRegistryItem[]>([])
  const workbenchStats = reactive<WorkbenchStats>({
    recentTasks: 0, runningTasks: 0, scripts: 0, materials: 0,
  })

  let pollTimer: ReturnType<typeof setInterval> | null = null

  // ── Helpers ─────────────────────────────────────────────────────
  function _applyCapabilitiesResponse(
    data: HealthAPI.CapabilitiesResponse | null | undefined
  ): void {
    const caps = data?.capabilities
    const keys = Object.keys(DEFAULT_CAP_BOOL) as (keyof ServerCapabilities)[]
    keys.forEach((k) => {
      const sw = (caps as any)?.[k] as CapabilitySwitch | undefined
      capabilities[k] = !!sw?.enabled
      // 更新详细结构（保留 models/modes/engines/url 等元数据）
      if (sw) {
        Object.assign(capabilityDetail[k], sw)
      } else {
        Object.assign(capabilityDetail[k], DEFAULT_CAP_DETAIL[k])
      }
    })
    Object.keys(queueLoad).forEach((k) => delete queueLoad[k])
    const ql = data?.queue_load || {}
    Object.keys(ql).forEach((k) => { queueLoad[k] = ql[k] })
    if (data?.server_time) serverTime.value = data.server_time
  }

  // ── Actions ─────────────────────────────────────────────────────

  /**
   * 拉取服务端能力清单（V3 PRD S4 /health/capabilities）。
   * 服务端不可达 / window.tintin 未就绪 → 静默置 offline，不抛错。
   */
  async function checkCapabilities(): Promise<void> {
    status.value = 'checking'
    try {
      if (!window.tintin?.server?.healthCapabilities) {
        status.value = 'offline'
        return
      }
      const resp = await window.tintin.server.healthCapabilities()
      // resp 可能是 null（离线态）或 { error }（业务错误）或正常响应
      if (!resp || (resp as any)?.error) {
        _applyCapabilitiesResponse(undefined)
        status.value = 'offline'
        return
      }
      _applyCapabilitiesResponse(resp as HealthAPI.CapabilitiesResponse)
      status.value = 'online'
    } catch (_err) {
      status.value = 'offline'
    }
  }

  /** 拉取完整能力注册表（V2 §13 /agent/registry，Orchestrator 提交计划时要用到 capability_keys） */
  async function fetchRegistry(): Promise<CapabilityRegistryItem[]> {
    try {
      if (!window.tintin?.server?.agentRegistry) return []
      const resp = await window.tintin.server.agentRegistry()
      if (!resp || (resp as any)?.error) {
        registry.value = []
        return []
      }
      registry.value = resp as CapabilityRegistryItem[]
      return registry.value
    } catch (_err) {
      registry.value = []
      return []
    }
  }

  /** 拉取工作台概览卡片统计（/stats/workbench） */
  async function fetchStatsWorkbench(): Promise<WorkbenchStats> {
    try {
      if (!window.tintin?.server?.statsWorkbench) {
        return { ...workbenchStats }
      }
      const resp = await window.tintin.server.statsWorkbench()
      if (!resp || (resp as any)?.error) {
        return { ...workbenchStats }
      }
      const s = resp as StatsAPI.WorkbenchResponse
      workbenchStats.recentTasks  = s.recentTasks  ?? 0
      workbenchStats.runningTasks = s.runningTasks ?? 0
      workbenchStats.scripts      = s.scripts      ?? 0
      workbenchStats.materials    = s.materials    ?? 0
      return { ...workbenchStats }
    } catch (_err) {
      return { ...workbenchStats }
    }
  }

  /** 强制置为离线（心跳超时 / 用户主动断开等场景） */
  function setOffline(): void {
    status.value = 'offline'
  }

  /** 启动 60s 能力轮询 */
  function startPolling(): void {
    if (pollTimer) return
    pollTimer = setInterval(() => { checkCapabilities() }, POLL_INTERVAL)
  }

  /** 停止轮询 */
  function stopPolling(): void {
    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
  }

  return {
    // state
    status,
    serverTime,
    capabilities,
    capabilityDetail,
    queueLoad,
    registry,
    workbenchStats,
    // actions
    checkCapabilities,
    fetchRegistry,
    fetchStatsWorkbench,
    setOffline,
    startPolling,
    stopPolling,
  }
})
