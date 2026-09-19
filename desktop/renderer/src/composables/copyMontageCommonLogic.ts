// ═══════════════════════════════════════════════════════════════
// copyMontageCommonLogic.ts — 智能混剪四步共用纯逻辑（轮询状态机 + 路径工具）
// 自 copyMontageLogic.ts 拆分（铁律 10 / 2026-09-18，纯搬迁零行为改动，
// 拆分过程过 SKILL.md IRON-02 五项 checklist）。
// 轮询状态机与 reversePromptVideoLogic 同口径（原版 _poll_task_result 与 unified
// 轮询一致：{data:{}} 解包 / status|state / 终态与失败态），为 node 类型剥离的
// 模块解析限制在此独立实现（两文件各自有单测覆盖，保持行为同步）。
// 本文件不做任何 IPC / DOM 操作（IRON-06/07 分层）
// ═══════════════════════════════════════════════════════════════

// ── 任务轮询状态机（unified 轮询口径）────────────────────────

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

/** 任务状态映射（终态/失败态/进行中，与 unified 轮询口径一致） */
export function mapTaskStatus(status: unknown, task: Record<string, unknown> = {}): TaskStatusInfo {
  const s = String(status || '').toLowerCase()
  if (['completed', 'done', 'success', 'finished'].includes(s)) return { phase: 'done', error: '' }
  if (['failed', 'error', 'cancelled'].includes(s)) {
    const err = task.error_msg || task.error || task.message
      // cancelled 且无 error_msg：服务端运行中重启会把任务置 cancelled（实测 705：
      // result={cancelled:true}）——报「未知错误」误导，改为可行动的文案
      || (s === 'cancelled' ? '服务端任务被取消（可能因服务端重启中断），请重新提交' : '未知错误')
    return { phase: 'failed', error: String(err) }
  }
  return { phase: 'running', error: '' }
}

/** 轮询阶段文案（progress ≤1 视为小数 ×100；否则显示已等待秒数） */
export function pollPhaseText(progress: unknown, elapsedSec?: number): string {
  const p = Number(progress)
  if (progress !== null && progress !== undefined && progress !== '' && !Number.isNaN(p)) {
    const pct = p <= 1.0 ? p * 100 : p
    return `服务端处理中 ${Math.round(pct)}%`
  }
  return `等待服务端处理，已等待 ${Math.max(0, Math.floor(elapsedSec || 0))} 秒...`
}

// ── 路径工具（渲染层无 node path）────────────────────────────

/** 从完整路径取 basename（渲染层无 node path） */
export function pathBasename(p: string): string {
  const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'))
  return i >= 0 ? p.slice(i + 1) : p
}

/** 从完整路径取不带扩展名的 basename（渲染层无 node path；对照 path.basename(p, ext)） */
export function pathStem(p: string): string {
  const b = pathBasename(p)
  const i = b.lastIndexOf('.')
  return i > 0 ? b.slice(0, i) : b
}
