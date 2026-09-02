// ═══════════════════════════════════════════════════════════════
// taskQueueLogic — 条目⑫ 任务队列编组纯函数（无副作用，可单测）
// 原客户端 main_window_pages.py 任务队列页（L1246-1478）字段/语义对齐：
//   · 状态映射 status_map（L1417）：completed 完成 / processing 处理中 /
//     pending 排队中 / failed 失败 / error 错误 → 扩展新枚举
//     queued/waiting_user_input/paused/cancelled 文案
//   · 进度语义（L1420）：processing→progress 值；completed→100；其它→0
//   · 结果展示（详情区 L1317-1341）：结果为 url / 本地路径时可「打开」
// 数据源编组（2026-08-31 修正）：/agent/tasks 编排任务（对话转编排的 a_ 任务，
// 含 goal/status/progress）+ /tasks 执行层计算任务（原任务队列页 L1360）。
// 注：原实现的 /tasks/unified 在服务端契约中不存在（API-GUIDE 无此
// 路径），导致任务列表永远为空（2026-08-31 用户反馈）。
// ═══════════════════════════════════════════════════════════════

/** 展示行（useWorkbenchTasks/WbTaskDrawer 消费） */
export interface TaskRow {
  id: string
  title: string
  type: string
  progress: number
  status: 'running' | 'done' | 'pending'
  eta: string
  /**
   * 任务提交时间（服务端 created_at 优先，回退 updated_at）
   * 这是任务提交给服务端的时间，不是客户端拉取到的时间。
   * PRD §3.2⑤ 任务报告「创建时间」列。
   */
  submittedAt?: string
  /** 结果打开目标（原详情区「结果」：url 或本地路径），null=无可打开结果 */
  resultTarget?: { kind: 'url' | 'path'; value: string } | null
}

/** 服务端任务节点（AgentAPI.TaskNode 子集，结构化契约见 types/server-api.ts） */
export interface ServerTaskLike {
  id?: string
  title?: string
  name?: string
  /** 编排任务目标（/agent/tasks；原 scheduled_tasks_mgmt_page.py L492 首列口径） */
  goal?: string
  capability_key?: string
  capability?: string
  type?: string
  status?: string
  progress?: number
  stage?: string
  result_preview?: string
  /** 执行层任务结果（/tasks 原任务队列页详情区 result 字段） */
  result?: string
  error_message?: string
  /** 执行层任务错误（/tasks，原 L1336 t.get("error")） */
  error?: string
  error_msg?: string
  created_at?: string
  updated_at?: string
}

/**
 * 状态文案（对齐原 status_map L1417 + 新枚举扩展）。
 * 未登记状态原样透出（原 L1418 status_map.get(status, status) 语义）。
 */
export function statusText(s: string): string {
  const map: Record<string, string> = {
    completed: '已完成',
    done: '已完成', // 展示层三档状态回查（WbTaskDrawer 页脚 statusText(t.status)）
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
  return map[s] ?? s
}

/** 行三档状态映射：done=completed；pending=queued/pending/waiting/paused/failed/cancelled；其余 running */
function rowStatus(s: string): TaskRow['status'] {
  if (s === 'completed') return 'done'
  if (['queued', 'pending', 'waiting_user_input', 'paused', 'failed', 'cancelled'].includes(s)) {
    return 'pending'
  }
  return 'running'
}

/** eta 文案：终态透出状态/错误，进行中给阶段提示 */
function rowEta(t: ServerTaskLike): string {
  const s = String(t.status || '')
  if (s === 'completed') return '已完成'
  if (t.error_message) return `失败： ${t.error_message}`
  if (t.error_msg) return `失败： ${t.error_msg}`
  if (t.error) return `失败： ${t.error}`
  if (s === 'waiting_user_input') return '等待确认'
  if (s === 'cancelled') return '已取消'
  if (s === 'failed') return '失败'
  if (s === 'paused') return '已暂停'
  if (t.stage) return t.stage
  return '处理中'
}

/** 进度语义对齐原 L1420：processing/running→progress 值，completed→100，其它→0
 *  （编排任务用 running，执行层用 processing，两口径都要取真实进度） */
function rowProgress(t: ServerTaskLike): number {
  const s = String(t.status || '')
  if (s === 'processing' || s === 'running') return Math.max(0, Math.min(100, Number(t.progress) || 0))
  if (s === 'completed') return 100
  return 0
}

/**
 * 结果打开目标提取（原详情区「结果」L1339-1340 可打开语义）：
 * result_preview 含 http(s) URL → {kind:'url'}（容错尾部说明文本）；
 * 本地绝对路径（盘符/UNC）→ {kind:'path'}；其余（纯文本预览）→ null
 */
export function extractResultTarget(
  t: ServerTaskLike | null | undefined,
): { kind: 'url' | 'path'; value: string } | null {
  const raw = String(t?.result_preview || t?.result || '').trim()
  if (!raw) return null
  const urlMatch = raw.match(/https?:\/\/[^\s（）()，,]+/)
  if (urlMatch) return { kind: 'url', value: urlMatch[0] }
  if (/^([a-zA-Z]:[\\/]|\\\\)/.test(raw)) {
    // 路径后可能带说明，截到首个空白
    const p = raw.split(/\s+/)[0]
    return { kind: 'path', value: p }
  }
  return null
}

/** 服务端任务节点 → 展示行 */
export function mapServerTaskRow(t: ServerTaskLike): TaskRow {
  const s = String(t.status || '')
  // 提交时间：优先 created_at（任务提交给服务端的时间），回退 updated_at
  // 注意：这是服务端记录的时间，不是客户端拉取时间
  const submittedAt = t.created_at || t.updated_at || undefined
  return {
    id: String(t.id ?? ''),
    title: String(t.title || t.name || t.goal || '任务'),
    type: String(t.capability_key || t.capability || t.type || '媒体工具'),
    progress: rowProgress(t),
    status: rowStatus(s),
    eta: rowEta(t),
    submittedAt: submittedAt ? String(submittedAt) : undefined,
    resultTarget: extractResultTarget(t),
  }
}

// ═══════════════════════════════════════════════════════════════
// 日期分组 + 筛选（2026-09-02 新增：任务队列整理）
// ═══════════════════════════════════════════════════════════════

/** 筛选标签 */
export type TaskFilter = 'all' | 'running' | 'done' | 'failed'

/** 日期分组键 */
export type DateGroupKey = 'today' | 'week' | 'earlier'

/** 日期分组标签文案 */
export const DATE_GROUP_LABEL: Record<DateGroupKey, string> = {
  today: '今天',
  week: '最近一周',
  earlier: '更早',
}

/** 筛选标签文案 */
export const FILTER_LABEL: Record<TaskFilter, string> = {
  all: '全部',
  running: '进行中',
  done: '已完成',
  failed: '失败',
}

/** 判断任务是否匹配筛选 */
export function matchesFilter(row: TaskRow, filter: TaskFilter): boolean {
  if (filter === 'all') return true
  if (filter === 'running') return row.status === 'running'
  if (filter === 'done') return row.status === 'done'
  if (filter === 'failed') return row.eta.startsWith('失败') || row.eta === '错误'
  return true
}

/** 解析提交时间字符串为 Date（兼容 ISO / 时间戳 / 空） */
function parseSubmittedAt(s: string | undefined): Date | null {
  if (!s) return null
  // ISO 格式（服务端通常返回这种）
  const d = new Date(s)
  if (!isNaN(d.getTime())) return d
  // 时间戳（秒或毫秒）
  const n = Number(s)
  if (!isNaN(n) && n > 0) {
    return new Date(n < 1e12 ? n * 1000 : n)
  }
  return null
}

/** 判断日期归属（today / week / earlier） */
function classifyDate(d: Date | null): DateGroupKey {
  if (!d) return 'earlier'
  const now = new Date()
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const weekStart = new Date(todayStart.getTime() - 7 * 86400000) // 7 天前
  if (d >= todayStart) return 'today'
  if (d >= weekStart) return 'week'
  return 'earlier'
}

/** 日期分组结果 */
export interface DateGroup {
  key: DateGroupKey
  label: string
  rows: TaskRow[]
}

/**
 * 将任务列表按提交日期分组（今天/昨天/更早），组内保持原序。
 * 日期取服务端 created_at（任务提交给服务端的时间），非客户端拉取时间。
 * 无时间戳的任务归入「更早」。
 */
export function groupByDate(rows: TaskRow[]): DateGroup[] {
  const groups: Record<DateGroupKey, TaskRow[]> = { today: [], week: [], earlier: [] }
  for (const r of rows) {
    const key = classifyDate(parseSubmittedAt(r.submittedAt))
    groups[key].push(r)
  }
  const result: DateGroup[] = []
  for (const key of ['today', 'week', 'earlier'] as DateGroupKey[]) {
    if (groups[key].length) {
      result.push({ key, label: DATE_GROUP_LABEL[key], rows: groups[key] })
    }
  }
  return result
}
