// ═══════════════════════════════════════════════════════════════
// useOfficePreview — 办公能力预览编排（P1，PRD §3.3/§4.3）
// 职责：openPreview(path) → 按扩展名走 office:previewDocx（docx→html）
//   / office:readXlsx（xlsx→多 Sheet 表格）；转换失败 → 错误态 +「用系统程序打开」兜底（E4）。
// 弹窗纯展示在 components/OfficePreview.vue（本 composable 只持有状态与 IPC 转发）。
// 双窗口复用：bridge 取 window.tintin / window.tintinBrowser（office:* 通道同源）。
// ═══════════════════════════════════════════════════════════════

import { reactive, ref } from 'vue'
import type { Ref } from 'vue'

/** 预览 Sheet 表格（office:readXlsx 出参） */
export interface PreviewSheet {
  name: string
  rows: any[][]
}

/** 预览状态（OfficePreview.vue 消费） */
export interface OfficePreviewState {
  open: boolean
  kind: '' | 'docx' | 'xlsx'
  /** 文件名（弹窗标题） */
  name: string
  /** 文件路径（「用系统程序打开」目标） */
  path: string
  /** docx 预览 html（iframe srcdoc） */
  html: string
  /** xlsx 预览多 Sheet */
  sheets: PreviewSheet[]
  /** 当前激活 Sheet 下标 */
  activeSheet: number
  /** 错误态（E4：损坏/非预期 → 错误文案 + 系统打开兜底） */
  error: string
}

export interface UseOfficePreviewOptions {
  /** 桥接取法（缺省自动探测 tintin / tintinBrowser） */
  bridge?: () => any
}

/** 从路径提取文件名（兼容 / 与 \） */
export function previewBasename(filePath: string): string {
  const p = String(filePath || '')
  const seg = p.split(/[\\/]/).pop() || p
  return seg || p
}

/** 扩展名 → 预览类型（docx/xlsx；其余不支持） */
export function previewKindOf(filePath: string): '' | 'docx' | 'xlsx' {
  const ext = (String(filePath || '').split('.').pop() || '').toLowerCase()
  if (ext === 'docx') return 'docx'
  if (ext === 'xlsx') return 'xlsx'
  return ''
}

export function useOfficePreview(opts?: UseOfficePreviewOptions) {
  const state = reactive<OfficePreviewState>({
    open: false,
    kind: '',
    name: '',
    path: '',
    html: '',
    sheets: [],
    activeSheet: 0,
    error: '',
  })
  const loading = ref(false)

  function getBridge(): any {
    if (opts?.bridge) return opts.bridge() || (window as any).tintin
    return (window as any).tintin?.office ? (window as any).tintin : (window as any).tintinBrowser
  }

  /** 打开预览（docx → mammoth html；xlsx → exceljs sheets；不支持/失败 → 错误态） */
  async function openPreview(filePath: string): Promise<boolean> {
    const bridge = getBridge()
    if (!bridge?.office) return false
    const p = String(filePath || '')
    const kind = previewKindOf(p)
    state.open = true
    state.kind = kind
    state.name = previewBasename(p)
    state.path = p
    state.html = ''
    state.sheets = []
    state.activeSheet = 0
    state.error = ''
    loading.value = true
    try {
      if (kind === 'docx') {
        const r = await bridge.office.previewDocx(p)
        if (r && r.error) { state.error = String(r.error); return false }
        state.html = String(r?.html || '')
        return true
      }
      if (kind === 'xlsx') {
        const r = await bridge.office.readXlsx(p)
        if (r && r.error) { state.error = String(r.error); return false }
        state.sheets = (r?.sheets || []).map((s: PreviewSheet) => ({ name: s.name, rows: s.rows || [] }))
        return true
      }
      state.error = '不支持的预览格式（仅支持 .docx / .xlsx）'
      return false
    } catch (e) {
      state.error = String((e as Error)?.message || e)
      return false
    } finally {
      loading.value = false
    }
  }

  /** 用系统程序打开（错误态兜底 + 工具栏入口，PRD E4） */
  async function openWithSystem(filePath?: string): Promise<boolean> {
    const p = filePath || state.path
    if (!p) return false
    const bridge = getBridge()
    if (!bridge?.office?.openPath) return false
    try {
      const r = await bridge.office.openPath(p)
      return !!(r && r.ok)
    } catch (_) { return false }
  }

  function switchSheet(index: number): void {
    if (index >= 0 && index < state.sheets.length) state.activeSheet = index
  }

  function close(): void {
    state.open = false
  }

  return { state, loading, openPreview, openWithSystem, switchSheet, close }
}

/** 供外部使用的 ref 便捷获取（等价返回类型声明） */
export type UseOfficePreviewReturn = {
  state: OfficePreviewState
  loading: Ref<boolean>
  openPreview: (filePath: string) => Promise<boolean>
  openWithSystem: (filePath?: string) => Promise<boolean>
  switchSheet: (index: number) => void
  close: () => void
}
