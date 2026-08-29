// ═══════════════════════════════════════════════════════════════
// officeDocLogic — 办公能力：对话/转写 → docx 结构纯函数（PRD §3.1 / §3.2④）
// 职责：仅做「数据 → docx 文档结构」编组，不触碰 docx 库 / vue / IPC
//   （docx 库生成在 useOfficeExport.buildDocxBuffer，本模块可被 node 单测直载）。
// 结构（PRD §3.1）：
//   · 标题     heading1 居中 18pt 加粗
//   · 元信息   meta 行（智能体/模式·会话ID·导出时间，9pt 灰）
//   · 分隔线   divider（水平线）
//   · 消息     role 标头（【用户/助手】+ 可选时间）→ 内容（para/list/quote）
//   · Markdown - 列表 → list；> 引用 → quote（缩进灰字）；**加粗** → bold run
//   · 分页     每 40 条消息 / 每 80 段转写插 pageBreak；E5：段数超 5000 截断标记
// ═══════════════════════════════════════════════════════════════

/** 对话消息角色（气泡流口径：user / ai） */
export type DocxChatRole = 'user' | 'ai'

/** 对话导出消息（时间可选：数据源无逐条时间时省略，标头仅显示角色） */
export interface DocxChatMessage {
  role: DocxChatRole
  content: string
  time?: string
}

/** 转写段（start 为秒；纯文本源可省略 start） */
export interface DocxTranscriptSegment {
  start?: number
  text: string
}

/** 文档块类型（docx 生成层按 type 映射样式） */
export type DocxBlockType =
  | 'heading' | 'meta' | 'divider' | 'role' | 'para' | 'list' | 'quote' | 'pageBreak'

/** 行内 run（含 Markdown 加粗解析结果） */
export interface DocxRun {
  text: string
  bold?: boolean
}

/** 单个文档块（字段按 type 取用，其余可缺省） */
export interface DocxBlock {
  type: DocxBlockType
  /** heading / meta / quote 段落文本 */
  text?: string
  /** role 标头：角色 */
  role?: DocxChatRole
  /** role 标头：时间（PRD `【用户】2026-08-29 09:12`） */
  time?: string
  /** list：条目 runs（每条一个 Word 列表段） */
  items?: DocxRun[][]
  /** para / quote：行内 runs */
  runs?: DocxRun[]
}

/** docx 文档结构（标题 + 元信息行 + 块流） */
export interface DocxStructure {
  title: string
  metaLines: string[]
  blocks: DocxBlock[]
  /** E5：超 5000 段截断标记（渲染层提示「超出部分未导出」） */
  truncated?: boolean
}

/** 分页阈值（PRD §3.1：每 40 条消息分页） */
export const DOCX_PAGE_EVERY_MESSAGES = 40
/** 分页阈值（PRD §3.2④：每 80 段转写分页） */
export const DOCX_PAGE_EVERY_SEGMENTS = 80
/** E5：docx 段数上限（超出截断并标记） */
export const DOCX_MAX_BLOCKS = 5000

/** 角色文案（PRD §3.2 xlsx 摘要表角色列：用户/助手） */
export const DOCX_CHAT_ROLE_TEXT: Record<DocxChatRole, string> = {
  user: '用户',
  ai: '助手',
}

/** 秒 → HH:MM:SS（转写时间轴格式 `[00:00:03]`） */
export function formatSeconds(sec: number | undefined | null): string {
  const s = Math.max(0, Math.floor(Number(sec) || 0))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = s % 60
  const p2 = (n: number) => String(n).padStart(2, '0')
  return `${p2(h)}:${p2(m)}:${p2(r)}`
}

/** Date → YYYY-MM-DD（null/空返回 ''） */
export function formatDate(ts: Date | number | string | null | undefined): string {
  if (ts === null || ts === undefined || ts === '') return ''
  const d = ts instanceof Date ? ts : new Date(ts)
  if (Number.isNaN(d.getTime())) return ''
  const p2 = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`
}

/** Date → YYYY-MM-DD HH:mm（PRD §3.2 对话摘要时间列格式；null/空返回 ''） */
export function formatDateTime(ts: Date | number | string | null | undefined): string {
  if (ts === null || ts === undefined || ts === '') return ''
  const d = ts instanceof Date ? ts : new Date(ts)
  if (Number.isNaN(d.getTime())) return ''
  const p2 = (n: number) => String(n).padStart(2, '0')
  return `${formatDate(d)} ${p2(d.getHours())}:${p2(d.getMinutes())}`
}

/**
 * Markdown 行内加粗解析：`**加粗**` → bold run，其余原样（PRD §3.1 加粗 run）。
 * 未命中 `**` 时返回单个普通 run。
 */
export function parseInlineMarkdown(text: string): DocxRun[] {
  const src = String(text ?? '')
  if (!src) return []
  if (!src.includes('**')) return [{ text: src }]
  const parts = src.split(/(\*\*[^*]+\*\*)/g).filter((p) => p !== '')
  const runs: DocxRun[] = []
  for (const part of parts) {
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      runs.push({ text: part.slice(2, -2), bold: true })
    } else {
      runs.push({ text: part })
    }
  }
  return runs.length ? runs : [{ text: src }]
}

export type DocxLineKind = 'para' | 'list' | 'quote'

/** 单行解析：`- `/`* ` 列表 → list；`> ` 引用 → quote；其余 → para；空行 → null */
export function parseDocxLine(line: string): { kind: DocxLineKind; runs: DocxRun[] } | null {
  const src = String(line ?? '')
  if (!src.trim()) return null
  if (/^[-*]\s+/.test(src)) {
    return { kind: 'list', runs: parseInlineMarkdown(src.replace(/^[-*]\s+/, '')) }
  }
  if (/^>\s?/.test(src)) {
    return { kind: 'quote', runs: parseInlineMarkdown(src.replace(/^>\s?/, '')) }
  }
  return { kind: 'para', runs: parseInlineMarkdown(src) }
}

/** 消息内容 → 块序列（逐行 para/list/quote；空行跳过） */
export function contentToBlocks(content: string): DocxBlock[] {
  const blocks: DocxBlock[] = []
  for (const line of String(content ?? '').split(/\r?\n/)) {
    const parsed = parseDocxLine(line)
    if (!parsed) continue
    if (parsed.kind === 'list') {
      // 连续列表行合并为一条 list 块（Word 生成时每条 items 一个列表段）
      const last = blocks[blocks.length - 1]
      if (last && last.type === 'list') {
        last.items = [...(last.items || []), parsed.runs]
      } else {
        blocks.push({ type: 'list', items: [parsed.runs] })
      }
    } else {
      blocks.push(parsed.kind === 'quote'
        ? { type: 'quote', runs: parsed.runs }
        : { type: 'para', runs: parsed.runs })
    }
  }
  return blocks
}

/**
 * 对话 → docx 结构（PRD §3.1）：
 * 标题 + 元信息行 + 分隔线 + 逐条消息（role 标头 + 内容块）+ 每 40 条分页。
 * 过滤 status='pending' 占位与空内容；E5：块超 5000 截断标记。
 */
export function buildChatDocxStructure(
  messages: DocxChatMessage[] | null | undefined,
  meta?: { title?: string; metaLines?: string[] } | null,
): DocxStructure {
  const list = (messages || []).filter((m) => m && m.content && m.content.trim())
  const title = (meta && meta.title && meta.title.trim()) || `会话 ${formatDate(new Date())}`
  const metaLines = (meta && meta.metaLines) || []

  const blocks: DocxBlock[] = [{ type: 'heading', text: title }]
  for (const line of metaLines) blocks.push({ type: 'meta', text: line })
  blocks.push({ type: 'divider' })

  let messageCount = 0
  for (const m of list) {
    messageCount += 1
    blocks.push({ type: 'role', role: m.role, time: m.time })
    for (const b of contentToBlocks(m.content)) blocks.push(b)
    if (messageCount > 0 && messageCount % DOCX_PAGE_EVERY_MESSAGES === 0) {
      blocks.push({ type: 'pageBreak' })
    }
  }

  const truncated = blocks.length > DOCX_MAX_BLOCKS
  return {
    title,
    metaLines,
    blocks: truncated ? blocks.slice(0, DOCX_MAX_BLOCKS) : blocks,
    truncated,
  }
}

/**
 * 转写 → docx 结构（PRD §3.2④）：
 * 标题 `转写 <文件名> <YYYY-MM-DD>` + 元信息（源文件/时长/转写时间）+
 * SRT 时间轴段 `[HH:MM:SS] 文本`（纯文本源逐段）+ 每 80 段分页。
 */
export function buildTranscriptDocxStructure(
  segments: DocxTranscriptSegment[] | null | undefined,
  meta?: { filename?: string; durationSec?: number; transcribeTime?: string; metaLines?: string[] } | null,
): DocxStructure {
  const list = (segments || []).filter((s) => s && s.text && s.text.trim())
  const filename = (meta && meta.filename) || '转写'
  const title = `转写 ${filename} ${formatDate(new Date())}`
  const metaLines = (meta && meta.metaLines) || [
    `源文件：${filename}`,
    ...(meta && typeof meta.durationSec === 'number' ? [`时长：${formatSeconds(meta.durationSec)}`] : []),
    ...(meta && meta.transcribeTime ? [`转写时间：${meta.transcribeTime}`] : []),
  ]

  const blocks: DocxBlock[] = [{ type: 'heading', text: title }]
  for (const line of metaLines) blocks.push({ type: 'meta', text: line })
  blocks.push({ type: 'divider' })

  let segCount = 0
  for (const s of list) {
    segCount += 1
    const text = typeof s.start === 'number'
      ? `[${formatSeconds(s.start)}] ${s.text.trim()}`
      : s.text.trim()
    blocks.push({ type: 'para', runs: parseInlineMarkdown(text) })
    if (segCount > 0 && segCount % DOCX_PAGE_EVERY_SEGMENTS === 0) {
      blocks.push({ type: 'pageBreak' })
    }
  }

  const truncated = blocks.length > DOCX_MAX_BLOCKS
  return {
    title,
    metaLines,
    blocks: truncated ? blocks.slice(0, DOCX_MAX_BLOCKS) : blocks,
    truncated,
  }
}
