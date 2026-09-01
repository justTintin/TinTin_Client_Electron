// ═══════════════════════════════════════════════════════════════
// decisionLogic.ts — 人审决策点（pending_decision）纯函数
// 契约：服务端 PRD-human-in-loop-choices.md（live /guide 在线文档）——
//   · 决策点 = 1 个问题 + N 个候选选项；kind=single_choice/multi_choice；
//   · fail-closed：决策数据异常不渲染选项（回退纯确认），不自动放行；
//   · 提交：POST /agent/tasks/{id}/confirm {decision_id, choice:[...]}
//     或 {decision_id, action:'reject', reason}；422=非法 choice、409=重复/过期。
// 纯函数无 vue 依赖（单测：tests/decision-logic.test.mjs）。
// ═══════════════════════════════════════════════════════════════

/** 契约候选选项（服务端 choices[] 条目） */
export interface DecisionChoice {
  value: string
  label: string
  /** 展示补充信息（如镜头时间段+评分） */
  desc: string
}

/** 归一后的决策点（供 UI 渲染；字段已容错缺省） */
export interface PendingDecision {
  decisionId: string
  ask: string
  kind: 'single_choice' | 'multi_choice'
  choices: DecisionChoice[]
  /** 默认推荐（已过滤 choices 外的值，可预选） */
  default: string[]
  placeholder: string
}

/**
 * 防御性解析服务端 pending_decision（2026-09-01 人审决策点改造）。
 * 结构非法（缺 decision_id / choices 非数组或空）→ null：UI 回退纯确认按钮
 * （fail-closed 口径——不渲染可能误导的选项，由「确认/拒绝」兜底）。
 */
export function normalizePendingDecision(raw: unknown): PendingDecision | null {
  if (!raw || typeof raw !== 'object') return null
  const d = raw as Record<string, unknown>
  const decisionId = String(d.decision_id || '')
  if (!decisionId) return null
  if (!Array.isArray(d.choices) || d.choices.length === 0) return null
  const choices: DecisionChoice[] = d.choices
    .filter((c): c is Record<string, unknown> => !!c && typeof c === 'object')
    .map((c) => ({
      value: String(c.value ?? ''),
      label: String(c.label ?? c.value ?? ''),
      desc: String(c.desc ?? '')
    }))
    .filter((c) => c.value)
  if (!choices.length) return null
  const validValues = new Set(choices.map((c) => c.value))
  const kind = d.kind === 'multi_choice' ? 'multi_choice' : 'single_choice'
  const defaults = Array.isArray(d.default)
    ? d.default.map(String).filter((v) => validValues.has(v))
    : []
  return {
    decisionId,
    ask: String(d.ask || '请选择'),
    kind,
    choices,
    default: defaults,
    placeholder: String(d.placeholder ?? '')
  }
}

/**
 * 提交前本地校验（422 前置拦截）：
 * single_choice 恰好 1 项；multi_choice 至少 1 项。通过返回 ''，否则返回提示。
 */
export function validateDecisionSelection(kind: string, selected: string[]): string {
  if (kind === 'multi_choice') {
    return selected.length >= 1 ? '' : '请至少选择一项'
  }
  if (selected.length === 0) return '请选择一项'
  if (selected.length > 1) return '该问题只能选择一项'
  return ''
}

/**
 * 主进程错误 → 用户文案：409=重复/过期提交（无副作用，引导刷新）；
 * 422=非法 choice（优先透传服务端 detail 的合法值提示）；其余原样兜底。
 */
export function mapDecisionError(res: { error?: string; status?: number; detail?: string } | null | undefined): string {
  if (!res || (!res.error && !res.status)) return '决策提交失败，请稍后重试'
  if (res.status === 409) return '该决策已被处理（任务状态已变化），请刷新后查看'
  if (res.status === 422) {
    return res.detail ? `选项不被接受：${res.detail}` : '选项不被接受，请重新选择后提交'
  }
  return String(res.error || '决策提交失败，请稍后重试')
}

/**
 * 等待态判断（2026-09-01 gap3 修复）：根任务等待时 status 恒为 running，
 * 等待态在 derived_status（API-GUIDE「等待状态看 derived_status」）——
 * 两者任一为 waiting_user_input 即视为等待，兼容新旧服务端版本。
 */
export function isWaitingUserInput(node: { status?: unknown; derived_status?: unknown } | null | undefined): boolean {
  if (!node) return false
  return node.status === 'waiting_user_input' || node.derived_status === 'waiting_user_input'
}
