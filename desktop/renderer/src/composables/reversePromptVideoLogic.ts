// ═══════════════════════════════════════════════════════════════
// reversePromptVideoLogic.ts — 视频反推提示词·纯逻辑（M6 条目⑦ parser/builder 层）
// 对照原客户端 studio/gui/prompt_reverse_page.py：
//   · _VideoTimeline L210-420（MAX_WINDOW=30 拖拽约束 / set_video 初始选区 / _fmt_sec）
//   · _extract_frames L73-95（均匀抽帧 fps=1/step，共 count 帧）
//   · _VideoPromptWorker L461-502（POST /prompt/video，start_sec/end_sec 随提交，
//     直接传参不做本地裁切；响应 task_id → 轮询，无 task_id 同步结果）
//   · _poll_task_result L128-188（600s 超时/3s 间隔；{data:{}} 解包；status|state；
//     终态 completed/done/success/finished；失败态 failed/error/cancelled）
//   · _format_result L101-122（分段结构化展示）
// 组件只绘制 + 事件转发，本文件不做任何 IPC / DOM 操作（IRON-06 分层）
// ═══════════════════════════════════════════════════════════════

/** 选段窗口上限（原版 _VideoTimeline.MAX_WINDOW L213） */
export const MAX_WINDOW_SEC = 30.0
/** 轮询超时/间隔（原版 _poll_task_result L128 默认 timeout=600, interval=3） */
export const POLL_TIMEOUT_MS = 600_000
export const POLL_INTERVAL_MS = 3_000
/** 时间轴抽帧数（原版 _extract_frames 默认 16 帧） */
export const FRAME_COUNT = 16

/** 初始选区：0 ~ min(MAX_WINDOW, duration)（对照 set_video L227-234） */
export function initialRange(duration: number): { start: number; end: number } {
  const dur = Math.max(0, Number(duration) || 0)
  return { start: 0, end: Math.min(MAX_WINDOW_SEC, dur) }
}

/** 拖左手柄：最短 1s、窗口超 MAX_WINDOW 时不动（对照 mouseMoveEvent L322-325） */
export function clampDragLeft(
  t: number, start: number, end: number, duration: number,
): { start: number; end: number } {
  const dur = Math.max(0, Number(duration) || 0)
  const newStart = Math.max(0, Math.min(t, end - 1.0))
  if (end - newStart > MAX_WINDOW_SEC) return { start, end }
  return { start: Math.min(newStart, dur), end }
}

/** 拖右手柄：最短 1s、≤MAX_WINDOW、不超时长（对照 L326-330） */
export function clampDragRight(
  t: number, start: number, end: number, duration: number,
): { start: number; end: number } {
  const dur = Math.max(0, Number(duration) || 0)
  const newEnd = Math.min(dur, Math.max(t, start + 1.0))
  if (newEnd - start > MAX_WINDOW_SEC) return { start, end }
  return { start, end: newEnd }
}

/** 整窗平移：夹在 [0, duration-win]（对照 L331-335） */
export function clampMove(
  t: number, start: number, end: number, duration: number,
): { start: number; end: number } {
  const dur = Math.max(0, Number(duration) || 0)
  const win = end - start
  const newStart = Math.max(0, Math.min(t - win / 2, dur - win))
  return { start: newStart, end: newStart + win }
}

/** m:ss 格式（对照 _fmt_sec L96-98） */
export function fmtSec(s: number): string {
  const v = Math.max(0, Math.floor(Number(s) || 0))
  return `${Math.floor(v / 60)}:${v % 60 < 10 ? '0' : ''}${v % 60}`
}

/** 均匀抽帧时间点 ts_i = i * (duration/count)（对照 _extract_frames fps=1/step L84-89） */
export function frameTimestamps(duration: number, count: number = FRAME_COUNT): number[] {
  const dur = Number(duration) || 0
  const n = Math.floor(Number(count) || 0)
  if (dur <= 0 || n <= 1) return []
  const step = dur / n
  return Array.from({ length: n }, (_, i) => i * step)
}

/** 响应任务 ID 提取，兼容 task_id / id / job_id（对照 _extract_task_id L189-194） */
export function extractTaskId(data: unknown): string {
  if (!data || typeof data !== 'object') return ''
  const d = data as Record<string, unknown>
  return String(d.task_id || d.id || d.job_id || '')
}

/** 提交响应分流：有 task_id → 轮询；无 → 同步结果（对照 _VideoPromptWorker L492-499） */
export function parsePromptVideoResponse(data: unknown): { taskId: string; sync: unknown } {
  const taskId = extractTaskId(data)
  return taskId ? { taskId, sync: null } : { taskId: '', sync: data }
}

/** 轮询响应解包：{data:{...}} → data，裸响应原样（对照 _poll_task_result L150） */
export function extractTaskObj(resp: unknown): Record<string, unknown> {
  if (!resp || typeof resp !== 'object') return {}
  const r = resp as Record<string, unknown>
  if (r.data && typeof r.data === 'object') return r.data as Record<string, unknown>
  return r
}

export interface TaskStatusInfo {
  phase: 'running' | 'done' | 'failed'
  error: string
}

/**
 * 任务状态映射（对照 _poll_task_result L158/L177-185）：
 * 终态 completed/done/success/finished；失败态 failed/error/cancelled
 * （error 依次取 error_msg/error/message，兜底「未知错误」）；其余按进行中等待。
 */
export function mapTaskStatus(status: unknown, task: Record<string, unknown> = {}): TaskStatusInfo {
  const s = String(status || '').toLowerCase()
  if (['completed', 'done', 'success', 'finished'].includes(s)) return { phase: 'done', error: '' }
  if (['failed', 'error', 'cancelled'].includes(s)) {
    const err = task.error_msg || task.error || task.message || '未知错误'
    return { phase: 'failed', error: String(err) }
  }
  return { phase: 'running', error: '' }
}

/** 轮询阶段文案（对照 L162-176：progress ≤1 视为小数 ×100；否则显示已等待秒数） */
export function pollPhaseText(progress: unknown, elapsedSec?: number): string {
  const p = Number(progress)
  if (progress !== null && progress !== undefined && progress !== '' && !Number.isNaN(p)) {
    const pct = p <= 1.0 ? p * 100 : p
    return `服务端处理中 ${Math.round(pct)}%`
  }
  return `等待服务端处理，已等待 ${Math.max(0, Math.floor(elapsedSec || 0))} 秒...`
}

export interface PromptSegment {
  label: string
  text: string
}

/** 结构化结果分段（对照 _format_result L101-122；空 → 原始 JSON 兜底） */
export function formatPromptResult(data: unknown): PromptSegment[] {
  if (!data || typeof data !== 'object') return [{ label: '', text: String(data ?? '') }]
  const d = data as Record<string, unknown>
  const segs: PromptSegment[] = []
  const push = (label: string, v: unknown) => {
    if (v !== undefined && v !== null && String(v).length) segs.push({ label, text: String(v) })
  }
  push('描述', d.description)
  push('正向提示词 Prompt', d.prompt)
  push('反向提示词 Negative Prompt', d.negative_prompt)
  if (Array.isArray(d.style_tags) && d.style_tags.length) {
    push('风格标签', d.style_tags.join(', '))
  }
  push('画面比例', d.aspect_ratio)
  push('引擎', d.engine_used || d.model_used)
  if (!segs.length) segs.push({ label: '', text: JSON.stringify(d, null, 2) })
  return segs
}

/**
 * 选段提交载荷（对照 _VideoPromptWorker L482-488：start_sec/end_sec 两位小数随提交，
 * 由服务端 /prompt/video 按时间窗解析，客户端不做本地裁切）。
 */
export function buildPromptVideoPayload(
  filePath: string, start: number, end: number,
): { file: string; start_sec: string; end_sec: string } {
  return {
    file: filePath,
    start_sec: (Number(start) || 0).toFixed(2),
    end_sec: (Number(end) || 0).toFixed(2),
  }
}

/** 选段合法性校验；返回错误文案，空串表示通过（0≤start<end≤duration、≤30s） */
export function validateRange(start: number, end: number, duration: number): string {
  const dur = Number(duration) || 0
  const s = Number(start) || 0
  const e = Number(end) || 0
  if (s < 0) return '起始时间不能为负'
  if (e > dur) return `结束时间超出视频时长（${fmtSec(dur)}）`
  if (e <= s) return '结束时间必须大于起始时间'
  if (e - s > MAX_WINDOW_SEC) return `选段最长 ${MAX_WINDOW_SEC} 秒`
  return ''
}
