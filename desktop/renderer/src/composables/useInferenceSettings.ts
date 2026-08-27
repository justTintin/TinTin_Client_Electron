// ═══════════════════════════════════════════════════════════════
// useInferenceSettings — A2 本地推理能力（设置页业务逻辑层）
// 职责：模式切换 / 能力探测 / 模型包清单与安装管理（IPC 调用 +
//       状态机 + labelMap 等纯逻辑），UI 层只做绘制与事件转发
// 来源：自 Settings.vue 内嵌 A2 段原样迁出（行为不变，IRON-08）
// ═══════════════════════════════════════════════════════════════

import { ref, computed } from 'vue'

/** 3 种推理模式（对齐 inference-router 的 store 取值） */
export type InferenceMode = 'server-only' | 'hybrid-auto' | 'force-local'

export const MODE_TABS: Array<{ value: InferenceMode; label: string; hint: string }> = [
  { value: 'server-only', label: '仅服务端', hint: '所有 OCR / 向量 / 封面走服务端 HTTP；新安装默认。' },
  { value: 'hybrid-auto', label: '混合自动', hint: '模型已下载时本地优先；失败/耗时过高自动切服务端（用户零感知）。' },
  { value: 'force-local', label: '强制本地', hint: '仅使用本地能力；本地不可用时直接返回错误，用于隐私合规场景。' },
]

/** 能力状态（inference:getCapability 返回的精简结构） */
export type CapState = {
  mode: string
  nativeModulesOk: boolean
  modelsOk: boolean
  avgLocalMs: number
  manifestVersion?: string
} | null

export type PkgStatus = 'NOT_INSTALLED' | 'INSTALLED' | 'SKIPPED' | 'DOWNLOADING'

/** 模型包行（设置页列表展示结构） */
export interface PkgRow {
  id: string
  label: string
  desc: string
  totalSizeMB: string
  status: PkgStatus
  progress?: number // 0-100
  files: Array<{ name: string; size: number }>
}

/** 工具：size → human MB */
export function bytesToMB(n: number): string {
  if (!n) return '0'
  return (n / 1024 / 1024).toFixed(1)
}

/** 模型包显示名映射（id → 中文名 + 描述） */
const PKG_LABEL_MAP: Record<string, { label: string; desc: string }> = {
  'ocr-paddle-int8':              { label: 'OCR · PaddleOCR INT8 3件套', desc: '本地图片/截图文字识别（det + rec + cls）' },
  'embedding-bge-small-zh':       { label: 'Embedding · bge-small-zh INT8', desc: '768 维中文向量生成，驱动本地知识库检索' },
  'native-addons-sqlitevss-sharp':{ label: '原生扩展 · sqlite-vss + sharp', desc: '向量 ANN 检索引擎、封面合成图像库（仅 Windows x64）' },
}

export function useInferenceSettings() {
  const currentMode = ref<InferenceMode>('server-only')
  const capability = ref<CapState>(null)
  const pkgList = ref<PkgRow[]>([])
  const a2Busy = ref(false)
  const lastError = ref<string | null>(null)

  /** 所有模型包体积合计（human MB） */
  const totalSizeMB = computed(() => {
    return (pkgList.value.reduce((s, p) => s + (parseFloat(p.totalSizeMB) || 0), 0)).toFixed(0)
  })

  /** 能力描述文案 */
  function statusSummary(): string {
    if (!capability.value) return '加载中…'
    if (currentMode.value === 'server-only')  return '当前：仅使用服务端推理（默认）。'
    if (currentMode.value === 'force-local')  return `当前：强制本地（原生模块 ${capability.value.nativeModulesOk ? '✓' : '✗'}，模型 ${capability.value.modelsOk ? '✓' : '✗'}）`
    if (capability.value.modelsOk && capability.value.nativeModulesOk) return '当前：混合自动模式 · 本地能力就绪 ✓'
    if (capability.value.nativeModulesOk && !capability.value.modelsOk) return '当前：混合自动模式 · 原生模块就绪，但模型尚未下载（自动走服务端）。'
    return '当前：混合自动模式 · 本地能力未就绪（自动走服务端）。'
  }

  /** 主流程：加载能力 + 模型清单 */
  async function refreshA2(force = false): Promise<void> {
    const tintin = (window as any).tintin
    const ok =
      !!tintin?.inference &&
      typeof tintin.inference.getCapability === 'function' &&
      typeof tintin.inference.setMode === 'function' &&
      !!tintin?.model &&
      typeof tintin.model.listPkgs === 'function' &&
      typeof tintin.model.downloadPkg === 'function' &&
      typeof tintin.model.cancelPkg === 'function' &&
      typeof tintin.model.uninstallPkg === 'function'
    if (!ok) {
      lastError.value = 'A2 IPC 未就绪（preload.js 可能未加载）；当前所有推理仍走服务端 HTTP。'
      return
    }
    lastError.value = null
    try {
      const [capRes, listRes] = await Promise.all([
        tintin.inference.getCapability(force),
        tintin.model.listPkgs(),
      ])
      if (capRes?.success && capRes.data) {
        currentMode.value = (capRes.data.mode || 'server-only') as InferenceMode
        capability.value = {
          mode: capRes.data.mode,
          nativeModulesOk: !!capRes.data.nativeModulesOk,
          modelsOk: !!capRes.data.modelsOk,
          avgLocalMs: capRes.data.avgLocalMs || 0,
          manifestVersion: capRes.data.detail?.manifestVersion,
        }
      }
      if (listRes?.success && Array.isArray(listRes.data)) {
        pkgList.value = listRes.data.map((p: any) => ({
          id: p.id,
          label: PKG_LABEL_MAP[p.id]?.label || p.id,
          desc:  PKG_LABEL_MAP[p.id]?.desc  || '',
          totalSizeMB: bytesToMB(p.totalSize),
          status: (p.status || 'NOT_INSTALLED') as PkgStatus,
          files: p.files || [],
        }))
      }
    } catch (e: any) {
      lastError.value = e?.message || String(e)
    }
  }

  /** 切换模式（写回 electron-store → inference:setMode） */
  async function setMode(m: InferenceMode): Promise<void> {
    const tintin = (window as any).tintin
    if (!tintin?.inference) return
    a2Busy.value = true
    try {
      await tintin.inference.setMode(m)
      currentMode.value = m
      // 刷新能力缓存
      await refreshA2(true)
    } catch (e: any) {
      lastError.value = e?.message || String(e)
    } finally {
      a2Busy.value = false
    }
  }

  /** 下载 / 取消 / 卸载 */
  async function actOnPkg(row: PkgRow, action: 'download' | 'cancel' | 'uninstall'): Promise<void> {
    const tintin = (window as any).tintin
    if (!tintin?.model) return
    a2Busy.value = true
    try {
      if (action === 'download') {
        row.status = 'DOWNLOADING'
        row.progress = 0
        const r = await tintin.model.downloadPkg(row.id)
        if (r?.skipped) {
          lastError.value = r.reason || 'SKIPPED'
        } else if (!r?.ok) {
          lastError.value = r?.error || '下载失败'
        }
      } else if (action === 'cancel') {
        await tintin.model.cancelPkg(row.id)
      } else if (action === 'uninstall') {
        await tintin.model.uninstallPkg(row.id)
      }
      await refreshA2(true)
    } catch (e: any) {
      lastError.value = e?.message || String(e)
    } finally {
      a2Busy.value = false
    }
  }

  /**
   * Footer 下载进度挂接：每 5s 轮询 listPkgs 更新安装状态。
   * 返回停止函数（组件卸载时清理，避免游离 setInterval）
   */
  function attachDownloadBus(intervalMs = 5000): () => void {
    const t = window.setInterval(() => refreshA2(false).catch(() => {}), intervalMs)
    return () => clearInterval(t)
  }

  return {
    // state
    currentMode,
    capability,
    pkgList,
    a2Busy,
    lastError,
    totalSizeMB,
    // consts
    MODE_TABS,
    // methods
    statusSummary,
    refreshA2,
    setMode,
    actOnPkg,
    attachDownloadBus,
  }
}
