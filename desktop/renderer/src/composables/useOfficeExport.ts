// ═══════════════════════════════════════════════════════════════
// useOfficeExport — 办公能力导出编排（P1，PRD §2/§3.4/§4.3）
// 职责（runner 层，含副作用）：
//   · 编组结果（officeDocLogic / officeSheetLogic 纯函数）→ docx/exceljs 生成 Buffer
//   · office:saveFile（系统保存对话框）→ 反馈（成功/取消静默/失败文案/截断提示）
// 状态机（PRD §5 E6）：idle → exporting → done | cancel | error（导出中禁点，完成/失败恢复）
// 双窗口复用：bridge 取 window.tintin（主应用）或 window.tintinBrowser（浏览器独立窗口），
//   两者 office:* 通道同源（preload.js / browser-preload.js 均暴露）。
// ═══════════════════════════════════════════════════════════════

import { ref } from 'vue'
import {
  Document, Packer, Paragraph, TextRun, PageBreak,
  HeadingLevel, AlignmentType, BorderStyle,
} from 'docx'
import ExcelJS from 'exceljs'
import type { DocxBlock, DocxStructure, DocxRun } from './officeDocLogic'
import { DOCX_CHAT_ROLE_TEXT } from './officeDocLogic'
import type { SheetSpec } from './officeSheetLogic'

/** 导出状态机（E6：导出中禁用；完成/失败/取消后恢复） */
export type OfficeExportState = 'idle' | 'exporting' | 'done' | 'error' | 'cancel'

/** 导出结果（渲染层按需反馈/预览） */
export interface OfficeExportResult {
  saved: boolean
  path?: string
  canceled?: boolean
  truncated?: boolean
  error?: string
}

export interface UseOfficeExportOptions {
  /** 桥接取法（缺省自动探测 tintin / tintinBrowser） */
  bridge?: () => any
  /** 反馈定制（缺省：成功→系统通知；失败→alert；截断→提示文案） */
  onFeedback?: (kind: 'success' | 'error' | 'info', message: string, path?: string) => void
}

/** 缺省反馈：成功→系统通知（含保存路径）；失败→alert；截断→提示（PRD E3/E5） */
function _defaultFeedback(bridge: any, kind: 'success' | 'error' | 'info', message: string) {
  if (kind === 'error') {
    try { window.alert(message) } catch (_) { /* 预览环境无 alert 不阻塞 */ }
    return
  }
  try { bridge?.shell?.showNotification?.(kind === 'success' ? '已保存' : '导出提示', message) } catch (_) {}
}

/** 角色标头（PRD §3.1：`【用户】2026-08-29 09:12`；无时间仅角色） */
function _roleHeaderText(role: string, time?: string): string {
  const who = (DOCX_CHAT_ROLE_TEXT as Record<string, string>)[role] || role
  return time ? `【${who}】${time}` : `【${who}】`
}

/** DocxRun[] → docx TextRun[]（加粗 run 映射） */
function _runs(runs: DocxRun[] | undefined): TextRun[] {
  return (runs || []).map((r) => new TextRun({ text: r.text, bold: !!r.bold }))
}

/** 内容块 → docx Paragraph（para/list/quote；quote 左缩进 0.5cm 灰字，PRD §3.1） */
function _blockParagraph(block: DocxBlock): Paragraph {
  const base = { line: 360, lineRule: 'auto' as const } // 行距 1.5（PRD §3.1 正文）
  switch (block.type) {
    case 'list':
      return new Paragraph({
        children: _runs((block.items || [])[0]),
        bullet: { level: 0 },
        spacing: { ...base, after: 60 },
      })
    case 'quote':
      return new Paragraph({
        // 引用段灰字（加粗 run 保留加粗；PRD §3.1 引用缩进灰字）
        children: (block.runs || []).map((r) => (
          r.bold
            ? new TextRun({ text: r.text, bold: true })
            : new TextRun({ text: r.text, color: '777777' })
        )),
        indent: { left: 283 }, // 0.5cm ≈ 283 twips
        spacing: { ...base, after: 60 },
      })
    default:
      return new Paragraph({
        children: _runs(block.runs),
        spacing: { ...base, after: 60 },
      })
  }
}

/** 编组结构 → docx ArrayBuffer（Packer.toBlob；PRD §3.1 样式规格） */
export async function buildDocxBuffer(structure: DocxStructure): Promise<Uint8Array> {
  const children: Paragraph[] = []
  for (const block of structure.blocks) {
    switch (block.type) {
      case 'heading':
        children.push(new Paragraph({
          heading: HeadingLevel.HEADING_1,
          alignment: AlignmentType.CENTER,
          children: [new TextRun({ text: block.text || structure.title, bold: true, size: 36 })], // 18pt
          spacing: { after: 240 },
        }))
        break
      case 'meta':
        children.push(new Paragraph({
          children: [new TextRun({ text: block.text || '', size: 18, color: '888888' })], // 9pt 灰
          spacing: { after: 40 },
        }))
        break
      case 'divider':
        children.push(new Paragraph({
          children: [],
          border: {
            bottom: { style: BorderStyle.SINGLE, size: 6, color: 'CCCCCC' },
          },
          spacing: { before: 120, after: 120 },
        }))
        break
      case 'role':
        children.push(new Paragraph({
          children: [new TextRun({ text: _roleHeaderText(block.role || '', block.time), bold: true, size: 22 })], // 11pt 加粗
          spacing: { before: 160, after: 60 },
        }))
        break
      case 'pageBreak':
        children.push(new Paragraph({ children: [new PageBreak()] }))
        break
      default:
        children.push(_blockParagraph(block))
    }
  }
  if (structure.truncated) {
    children.push(new Paragraph({
      children: [new TextRun({ text: '（内容超出 5000 段上限，超出部分未导出）', italics: true, size: 18, color: '999999' })],
      spacing: { before: 120 },
    }))
  }
  const doc = new Document({
    sections: [{ children }],
    styles: {
      default: {
        document: { run: { font: 'Microsoft YaHei', size: 22 } }, // 11pt 默认正文
      },
    },
  })
  // 沙箱渲染进程无 Buffer 全局，Packer.toBuffer（nodebuffer 路径）会抛
  // "nodebuffer is not supported by this platform"；用浏览器口径 toBlob 再转 ArrayBuffer
  const blob = await Packer.toBlob(doc)
  return new Uint8Array(await blob.arrayBuffer())
}

/** Sheet 结构 → xlsx ArrayBuffer（exceljs writeBuffer；表头加粗灰底 + 冻结首行 + 宽列换行） */
export async function buildXlsxBuffer(sheets: SheetSpec | SheetSpec[]): Promise<ArrayBuffer> {
  const list = Array.isArray(sheets) ? sheets : [sheets]
  const workbook = new ExcelJS.Workbook()
  for (const sheet of list) {
    const ws = workbook.addWorksheet(sheet.name || 'Sheet1')
    ws.columns = sheet.columns.map((c) => ({ header: c.header, width: c.width }))
    // 表头加粗 + 灰底 + 冻结首行（PRD §3.1）
    const headerRow = ws.getRow(1)
    headerRow.font = { bold: true }
    headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3F4F6' } }
    ws.views = [{ state: 'frozen', ySplit: 1 }]
    // 宽列（≥30）文本换行 + 顶部对齐（PRD §3.1 内容列口径）
    sheet.columns.forEach((c, i) => {
      if (c.width >= 30) {
        ws.getColumn(i + 1).alignment = { wrapText: true, vertical: 'top' }
      }
    })
    for (const row of sheet.rows) {
      ws.addRow(row.map((v) => (v === null || v === undefined ? '' : v)))
    }
  }
  const buf = await workbook.xlsx.writeBuffer()
  // exceljs writeBuffer：Node Buffer（Uint8Array 子类）/ buffer 垫片；统一拷贝为独立 ArrayBuffer
  const bytes = new Uint8Array(buf as unknown as ArrayBuffer)
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

/**
 * 导出编排（双窗口复用；E2 取消静默 / E3 失败文案 / E5 截断提示 / E6 导出中禁用）。
 * 用法：const { exportDocx, exportXlsx, state, lastPath, truncated } = useOfficeExport()
 */
export function useOfficeExport(opts?: UseOfficeExportOptions) {
  const state = ref<OfficeExportState>('idle')
  const error = ref('')
  const lastPath = ref('')
  const truncated = ref(false)

  function getBridge(): any {
    if (opts?.bridge) return opts.bridge() || (window as any).tintin
    return (window as any).tintin?.office ? (window as any).tintin : (window as any).tintinBrowser
  }

  function feedback(kind: 'success' | 'error' | 'info', message: string, path?: string) {
    if (opts?.onFeedback) { opts.onFeedback(kind, message, path); return }
    _defaultFeedback(getBridge(), kind, message)
  }

  /** 保存（office:saveFile）→ 结果 + 状态机 + 反馈 */
  async function save(payload: {
    filename: string
    ext: 'docx' | 'xlsx'
    data: Uint8Array | ArrayBuffer
    trunc?: boolean
  }): Promise<OfficeExportResult> {
    if (state.value === 'exporting') return { saved: false }
    state.value = 'exporting'
    error.value = ''
    lastPath.value = ''
    truncated.value = !!payload.trunc
    const bridge = getBridge()
    if (!bridge?.office?.saveFile) {
      state.value = 'error'
      error.value = '办公能力未就绪（office IPC 不可用）'
      feedback('error', `导出失败：${error.value}`)
      return { saved: false, error: error.value }
    }
    try {
      const r = await bridge.office.saveFile({
        filename: payload.filename,
        ext: payload.ext,
        data: payload.data,
      })
      if (r && r.error) {
        state.value = 'error'
        error.value = String(r.error)
        feedback('error', `导出失败：${error.value}`)
        return { saved: false, error: error.value }
      }
      if (!r || !r.saved) {
        state.value = 'cancel' // E2：取消静默
        return { saved: false, canceled: true }
      }
      state.value = 'done'
      lastPath.value = String(r.path || '')
      const extra = payload.trunc ? '（部分内容超出上限，超出部分未导出）' : ''
      feedback('success', lastPath.value ? `${lastPath.value}${extra}` : `已保存${extra}`, lastPath.value)
      return { saved: true, path: lastPath.value, truncated: payload.trunc }
    } catch (e) {
      state.value = 'error'
      error.value = String((e as Error)?.message || e)
      feedback('error', `导出失败：${error.value}`)
      return { saved: false, error: error.value }
    }
  }

  /** 导出 Word（编组结构 → buildDocxBuffer → save） */
  function exportDocx(structure: DocxStructure, filename: string): Promise<OfficeExportResult> {
    return buildDocxBuffer(structure).then(
      (buf) => save({ filename, ext: 'docx', data: buf, trunc: structure.truncated }),
      (e) => {
        state.value = 'error'
        error.value = String((e as Error)?.message || e)
        feedback('error', `导出失败：${error.value}`)
        return { saved: false, error: error.value }
      },
    )
  }

  /** 导出 Excel（Sheet 结构 → buildXlsxBuffer → save；sheets 支持单个或数组） */
  function exportXlsx(sheets: SheetSpec | SheetSpec[], filename: string): Promise<OfficeExportResult> {
    const trunc = (Array.isArray(sheets) ? sheets : [sheets]).some((s) => !!s.truncated)
    return buildXlsxBuffer(sheets).then(
      (buf) => save({ filename, ext: 'xlsx', data: buf, trunc }),
      (e) => {
        state.value = 'error'
        error.value = String((e as Error)?.message || e)
        feedback('error', `导出失败：${error.value}`)
        return { saved: false, error: error.value }
      },
    )
  }

  /** 用系统程序打开（预览弹窗「用系统程序打开」兜底，PRD E4） */
  async function openPath(filePath: string): Promise<boolean> {
    const bridge = getBridge()
    if (!bridge?.office?.openPath) return false
    try {
      const r = await bridge.office.openPath(filePath)
      return !!(r && r.ok)
    } catch (_) { return false }
  }

  /** 打开所在位置（优先系统资源管理器；浏览器窗口无 shell 时退化为 openPath） */
  async function revealInFolder(filePath: string): Promise<void> {
    const bridge = getBridge()
    try {
      if (bridge?.shell?.revealInFolder) { bridge.shell.revealInFolder(filePath); return }
      await openPath(filePath)
    } catch (_) { /* 定位失败不阻塞 */ }
  }

  /** 重置状态（导出完成后调用方按需清理） */
  function reset(): void {
    state.value = 'idle'
    error.value = ''
    lastPath.value = ''
    truncated.value = false
  }

  return {
    state, error, lastPath, truncated,
    exportDocx, exportXlsx, save, openPath, revealInFolder, reset,
  }
}
