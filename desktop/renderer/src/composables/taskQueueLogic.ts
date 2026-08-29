// ═══════════════════════════════════════════════════════════════
// taskQueueLogic — 条目⑫ 任务队列编组纯函数（无副作用，可单测）
// 原客户端 main_window_pages.py 任务队列页（L1246-1478）字段/语义对齐：
//   · 状态映射 status_map（L1417）：completed 完成 / processing 处理中 /
//     pending 排队中 / failed 失败 / error 错误 → 扩展新枚举
//     queued/waiting_user_input/paused/cancelled 文案
//   · 进度语义（L1420）：processing→progress 值；completed→100；其它→0
//   · 结果展示（详情区 L1317-1341）：结果为 url / 本地路径时可「打开」
// 数据源编组：/tasks/unified 服务端任务（统一任务中心）。
// ═══════════════════════════════════════════════════════════════

/** 展示行（useWorkbenchTasks/WbTaskDrawer 消费） */
export interface TaskRow {
  id: string
  title: string
  type: string
  progress: number
  status: 'running' | 'done' | 'pending'
  eta: string
  /** 任务创建时间（服务端 created_at；PRD §3.2⑤ 任务报告「创建时间」列） */
  createdAt?: string
  /** 结果打开目标（原详情区「结果」：url 或本地路径），null=无可打开结果 */
  resultTarget?: { kind: 'url' | 'path'; value: string } | null
}

/** 服务端任务节点（AgentAPI.TaskNode 子集，结构化契约见 types/server-api.ts） */
export interface ServerTaskLike {
  id?: string
  title?: string
  name?: string
  capability_key?: string
  type?: string
  status?: string
  progress?: number
  stage?: string
  result_preview?: string
  error_message?: string
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
  if (s === 'waiting_user_input') return '等待确认'
  if (s === 'cancelled') return '已取消'
  if (s === 'failed') return '失败'
  if (s === 'paused') return '已暂停'
  if (t.stage) return t.stage
  return '处理中'
}

/**
 * 进度语义对齐原 L1420：processing→progress 值，completed→100，其它→0
 */
function rowProgress(t: ServerTaskLike): number {
  const s = String(t.status || '')
  if (s === 'processing') return Math.max(0, Math.min(100, Number(t.progress) || 0))
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
  const raw = String(t?.result_preview || '').trim()
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
  return {
    id: String(t.id ?? ''),
    title: String(t.title || t.name || '任务'),
    type: String(t.capability_key || t.type || '媒体工具'),
    progress: rowProgress(t),
    status: rowStatus(s),
    eta: rowEta(t),
    createdAt: t.created_at ? String(t.created_at) : undefined,
    resultTarget: extractResultTarget(t),
  }
}
