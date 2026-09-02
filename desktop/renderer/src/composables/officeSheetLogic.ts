// ═══════════════════════════════════════════════════════════════
// officeSheetLogic — 办公能力：五类清单/报告 → Excel 结构纯函数（PRD §3.1/§3.2）
// 职责：仅做「数据 → {name, columns, rows}」编组，不触碰 exceljs / vue / IPC
//   （exceljs 生成在 useOfficeExport.buildXlsxBuffer，本模块可被 node 单测直载）。
// 行上限 5000（PRD §3.1「行上限 5000（超出截断并提示）」/ E5），截断返回 truncated。
// ═══════════════════════════════════════════════════════════════

/** 列定义（header 表头 / width 列宽字符数） */
export interface SheetColumn {
  header: string
  width: number
}

/** Sheet 结构（rows 为数据行数组，不含量化行头） */
export interface SheetSpec {
  name: string
  columns: SheetColumn[]
  rows: any[][]
  /** E5：超 5000 行截断标记（渲染层提示「超出部分未导出」） */
  truncated?: boolean
}

/** E5：行上限（不含表头） */
export const SHEET_MAX_ROWS = 5000

// ── 输入类型（鸭子类型，与各数据源字段对齐，避免跨域强依赖）──

/** ① 达人采集清单条目（collected.json：creators-store 落盘字段） */
export interface CollectedSheetItem {
  platform?: string
  creatorName?: string
  title?: string
  url?: string
  date?: string
  collectedAt?: string
  importStatus?: string
}

/** ② 每日素材组（daily-assets.js scanDailyAssets 分组结构） */
export interface DailySheetGroup {
  date?: string
  files?: Array<{ name?: string; type?: string; path?: string; size?: number }>
}

/** ③ 入库清单任务记录（material-import.js import-tasks.json 字段） */
export interface ImportSheetTask {
  url?: string
  title?: string
  platform?: string
  shareName?: string
  status?: string
  submittedAt?: string
  taskId?: string
}

/** ⑤ 任务报告展示行（useWorkbenchTasks.taskRows → TaskRow 字段） */
export interface TaskSheetRow {
  id?: string
  title?: string
  type?: string
  status?: string
  progress?: number
  /** 任务提交时间（服务端 created_at，非客户端拉取时间） */
  submittedAt?: string
  resultTarget?: { kind?: string; value?: string } | null
}

/** 对话导出消息（与 officeDocLogic.DocxChatMessage 同形） */
export interface ChatSheetMessage {
  role: 'user' | 'ai' | string
  content: string
  time?: string
}

// ── 通用工具（纯函数）──

/** 入库状态文案（PRD §3.2①：待处理/已入库/失败；未登记原样透出） */
export function importStatusText(status: string | undefined | null): string {
  if (status === 'submitted') return '待处理'
  if (status === 'imported') return '已入库'
  if (status === 'failed') return '失败'
  return String(status ?? '')
}

/** 字节格式化（B/KB/MB/GB 保留 1 位小数，与每日素材 formatBytes 同口径） */
export function sheetFormatBytes(b: number | undefined | null): string {
  const n = Number(b) || 0
  if (n < 1024) return n + ' B'
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB'
  return (n / 1024 / 1024 / 1024).toFixed(1) + ' GB'
}

/** Date → YYYY-MM-DD HH:mm（PRD §3.2 对话摘要时间格式） */
export function sheetFormatDateTime(ts: Date | number | string | undefined | null): string {
  if (ts === undefined || ts === null || ts === '') return ''
  // 数字时间戳（Date.now() 口径）直接 new Date(ts)；字符串才走 String 兜底（防 NaN）
  const d = ts instanceof Date ? ts : typeof ts === 'number' ? new Date(ts) : new Date(String(ts))
  if (Number.isNaN(d.getTime())) return String(ts)
  const p2 = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`
}

/** 截断数组（超出 5000 行 → slice + truncated 标记；同时返回是否截断） */
function _trimRows(rows: any[][]): { rows: any[][]; truncated: boolean } {
  if (rows.length <= SHEET_MAX_ROWS) return { rows, truncated: false }
  return { rows: rows.slice(0, SHEET_MAX_ROWS), truncated: true }
}

/** Excel Sheet 名规范化：非法字符替换 + 截断 31 字符（exceljs 写入硬限制） */
function _sheetName(name: string): string {
  const clean = String(name || '').replace(/[\\/:*?[\]]/g, '_').trim()
  return (clean || 'Sheet1').slice(0, 31)
}

function _sheet(name: string, columns: SheetColumn[], rows: any[][]): SheetSpec {
  const t = _trimRows(rows)
  return { name: _sheetName(name), columns, rows: t.rows, truncated: t.truncated }
}

// ── ① 对话摘要表（PRD §3.1 xlsx：序号/角色/内容/时间）──

export function chatToSheet(
  messages: ChatSheetMessage[] | null | undefined,
  meta?: { title?: string } | null,
): SheetSpec {
  const list = (messages || []).filter((m) => m && m.content && m.content.trim())
  const rows = list.map((m, i) => [
    i + 1,
    m.role === 'user' ? '用户' : '助手',
    m.content,
    sheetFormatDateTime(m.time),
  ])
  return _sheet(meta && meta.title ? meta.title : '对话记录', [
    { header: '序号', width: 8 },
    { header: '角色', width: 10 },
    { header: '内容', width: 60 },
    { header: '时间', width: 20 },
  ], rows)
}

// ── ② 达人采集清单（PRD §3.2①：平台/达人/标题/链接/日期/采集时间/入库状态）──

export function creatorsToSheet(items: CollectedSheetItem[] | null | undefined): SheetSpec {
  const rows = (items || []).map((it) => [
    String(it.platform ?? ''),
    String(it.creatorName ?? ''),
    // 标题截断 80 字（PRD §3.2①）
    String(it.title ?? '').slice(0, 80),
    String(it.url ?? ''),
    String(it.date ?? ''),
    String(it.collectedAt ?? ''),
    importStatusText(it.importStatus),
  ])
  return _sheet('采集清单', [
    { header: '平台', width: 14 },
    { header: '达人', width: 20 },
    { header: '标题', width: 40 },
    { header: '链接', width: 40 },
    { header: '日期', width: 12 },
    { header: '采集时间', width: 20 },
    { header: '入库状态', width: 14 },
  ], rows)
}

// ── ③ 每日素材（PRD §3.2②：文件名/类型/日期/路径/大小）──

export function dailyToSheet(groups: DailySheetGroup[] | null | undefined): SheetSpec {
  const rows: any[][] = []
  for (const g of (groups || [])) {
    const date = String(g.date ?? '')
    for (const f of (g.files || [])) {
      rows.push([
        String(f.name ?? ''),
        String(f.type ?? ''),
        date,
        String(f.path ?? ''),
        sheetFormatBytes(f.size),
      ])
    }
  }
  return _sheet('每日素材', [
    { header: '文件名', width: 30 },
    { header: '类型', width: 10 },
    { header: '日期', width: 12 },
    { header: '路径', width: 50 },
    { header: '大小', width: 12 },
  ], rows)
}

// ── ④ 入库清单（PRD §3.2③：URL/标题/来源/状态/提交时间/任务ID）──

export function importsToSheet(tasks: ImportSheetTask[] | null | undefined): SheetSpec {
  const rows = (tasks || []).map((t) => [
    String(t.url ?? ''),
    String(t.title ?? ''),
    // 来源：platform 优先，兜底 shareName（material-import 记录字段）
    String(t.platform || t.shareName || ''),
    importStatusText(t.status),
    sheetFormatDateTime(t.submittedAt),
    String(t.taskId ?? ''),
  ])
  return _sheet('入库清单', [
    { header: 'URL', width: 40 },
    { header: '标题', width: 30 },
    { header: '来源', width: 14 },
    { header: '状态', width: 14 },
    { header: '提交时间', width: 20 },
    { header: '任务ID', width: 24 },
  ], rows)
}

// ── ⑤ 任务报告（PRD §3.2⑤：任务ID/标题/类型/状态/进度/创建时间/结果）──

/** 任务状态文案（completed 已完成 / processing 处理中 / pending 排队中 / failed 失败等） */
export function taskStatusText(status: string | undefined | null): string {
  const map: Record<string, string> = {
    completed: '已完成',
    processing: '处理中',
    running: '处理中',
    pending: '排队中',
    queued: '排队中',
    failed: '失败',
    error: '错误',
    waiting_user_input: '等待确认',
    paused: '已暂停',
    cancelled: '已取消',
  }
  return map[String(status ?? '')] ?? String(status ?? '')
}

export function tasksToSheet(rows: TaskSheetRow[] | null | undefined): SheetSpec {
  const data = (rows || []).map((t) => [
    String(t.id ?? ''),
    String(t.title ?? ''),
    String(t.type ?? ''),
    taskStatusText(t.status),
    Math.max(0, Math.min(100, Number(t.progress) || 0)),
    sheetFormatDateTime(t.submittedAt),
    String(t.resultTarget?.value ?? ''),
  ])
  return _sheet('任务报告', [
    { header: '任务ID', width: 24 },
    { header: '标题', width: 30 },
    { header: '类型', width: 16 },
    { header: '状态', width: 12 },
    { header: '进度', width: 10 },
    { header: '创建时间', width: 20 },
    { header: '结果', width: 40 },
  ], data)
}

// ── ⑥ 预览面板 table 资产 → Excel（2026-09-01 用户裁决：导出动作跟产物走，
//    右侧预览面板的 markdown 表格资产支持导出 Excel）──

/** markdown 表格文本 → SheetSpec（首行表头、余行数据；无有效表格 → 空 columns/rows） */
export function tableToSheet(title: string, content: string): SheetSpec {
  const lines = String(content || '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('|') && l.endsWith('|') && l.length > 1)
  const parseRow = (l: string): string[] => l.slice(1, -1).split('|').map((c) => c.trim())
  const rowsRaw = lines
    .map(parseRow)
    .filter((cells) => !cells.every((c) => /^:?-{2,}:?$/.test(c))) // 剔除分隔行
  if (!rowsRaw.length) return { name: _sheetName(title), columns: [], rows: [] }
  const [header = [], ...data] = rowsRaw
  return _sheet(
    String(title || '').trim(),
    header.map((h, i) => ({ header: h || `列${i + 1}`, width: 18 })),
    data,
  )
}
