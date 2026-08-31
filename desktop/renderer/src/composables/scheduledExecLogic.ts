// ═══════════════════════════════════════════════════════════════
// scheduledExecLogic — 服务端定时任务执行记录·纯函数层（无 vue/IPC 依赖）
// 对照原客户端 scheduled_tasks_page.py（执行状态页）：
//   · _status_label L1002-1004：pending 排队中/running 执行中/
//     completed 已完成/failed 失败
//   · _type_label L996-999：product/video/compile_montage→产品成片、
//     storyboard/script_montage→脚本成片
//   · _status_color L1007-1010：running 橙/completed 绿/failed 红/pending 灰
//   · 详情字段：id/task_type/title/status/progress/error_msg/result/
//     created_at/completed_at（模块 docstring L9-10）
// ═══════════════════════════════════════════════════════════════

import type { ScheduledAPI } from '../../../types/server-api'

export type SchedExecRecord = ScheduledAPI.TaskExecRecord

/** 状态 → 中文标签（对齐原 _status_label） */
export const SCHED_STATUS_LABEL: Record<string, string> = {
  pending: '排队中',
  running: '执行中',
  completed: '已完成',
  failed: '失败',
}

/** 状态 → 展示色（对齐原 _status_color） */
export const SCHED_STATUS_COLOR: Record<string, string> = {
  pending: '#8a8f98',
  running: '#f39c12',
  completed: '#2ecc71',
  failed: '#e74c3c',
}

/** task_type → 类型标签（对齐原 _type_label） */
export const SCHED_TYPE_LABEL: Record<string, string> = {
  product_montage: '产品成片',
  video_montage: '产品成片',
  compile_video: '产品成片',
  storyboard_montage: '脚本成片',
  script_montage: '脚本成片',
}

export function schedStatusText(s: string | undefined): string {
  if (!s) return '—'
  return SCHED_STATUS_LABEL[s] || s
}

export function schedStatusColor(s: string | undefined): string {
  if (!s) return '#8a8f98'
  return SCHED_STATUS_COLOR[s] || '#8a8f98'
}

export function schedTypeText(t: string | undefined): string {
  if (!t) return '—'
  return SCHED_TYPE_LABEL[t] || t
}

/** 从 result 提取可展示摘要：video_url / url / 文本兜底（对齐原详情「结果」区） */
export function schedResultSummary(rec: SchedExecRecord | null | undefined): string {
  const r = rec?.result
  if (!r || typeof r !== 'object') return ''
  const obj = r as Record<string, unknown>
  for (const k of ['video_url', 'url', 'video', 'file_url', 'text', 'summary']) {
    const v = obj[k]
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return ''
}

/** 执行记录 → 抽屉卡片行视图（字段归一 + 时间截断，供组件直渲染） */
export interface SchedExecRow {
  id: string
  title: string
  typeText: string
  statusText: string
  statusColor: string
  progress: number
  score: number | null
  createdAt: string
  completedAt: string
  hasResultUrl: boolean
}

function cutTime(s: string | undefined): string {
  return String(s ?? '').slice(0, 16)
}

export function toSchedExecRows(list: Array<Record<string, unknown>>): SchedExecRow[] {
  return (list || []).map((t) => {
    const rec = t as unknown as SchedExecRecord
    return {
      id: String(t.id ?? ''),
      title: String(t.title || '—'),
      typeText: schedTypeText(rec.task_type),
      statusText: schedStatusText(rec.status),
      statusColor: schedStatusColor(rec.status),
      progress: Number(t.progress) || 0,
      score: Number.isFinite(Number(t.score)) && t.score !== null && t.score !== undefined
        ? Number(t.score)
        : null,
      createdAt: cutTime(t.created_at as string | undefined),
      completedAt: cutTime(t.completed_at as string | undefined),
      hasResultUrl: !!schedResultSummary(rec),
    }
  })
}
