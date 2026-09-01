// ═══════════════════════════════════════════════════════════════
// useScheduledTasks — 定时任务管理域（P2 移植；2026-08-31 结构澄清）
// 对照基准：原客户端 scheduled_tasks_mgmt_page.py + scheduled_tasks_page.py。
// 领域划分（2026-08-31 用户裁决：编排任务也是定时任务——云端智能体类型
// 到点提交服务端 Orchestrator 执行产生的实例，属执行结果而非独立板块）：
//   · 注册域：本地 schtasks 任务清单（本地热点采集 + 云端智能体两类注册项）
//   · 执行结果域：①编排任务执行实例（GET /agent/tasks 根任务，等待确认
//     可继续）②服务端定时任务执行记录（GET /scheduled/tasks，成片类）
// 非定时任务的执行结果走工作台左下角「任务队列」（/tasks/unified，另域）。
// 本地任务（schtasks）经 window.tintin.scheduled IPC；服务端数据经
// window.tintin.server 业务方法（契约：types/server-api.ts）。
// ═══════════════════════════════════════════════════════════════

import { computed, ref, watch } from 'vue'
import type { TintinBridgeScheduledTask, TintinBridgeAgentPlan } from '../../../types/global'
import type { AgentAPI, ScheduledAPI } from '../../../types/server-api'
import { toSchedExecRows, type SchedExecRow } from './scheduledExecLogic'
import {
  normalizePendingDecision,
  validateDecisionSelection,
  mapDecisionError,
  isWaitingUserInput,
  type PendingDecision
} from './decisionLogic'

/** 任务类型标签（对齐原版 _TYPE_LABEL） */
export const TYPE_LABEL: Record<string, string> = {
  hotspot: '本地定时任务',
  agent: '云端智能体'
}

/** 编排任务状态标签（对齐原版 _STATUS_LABEL） */
export const AGENT_STATUS_LABEL: Record<string, string> = {
  queued: '排队中',
  running: '执行中',
  waiting_user_input: '等待确认',
  completed: '已完成',
  failed: '失败',
  paused: '已暂停',
  cancelled: '已取消'
}

/** 编排任务状态 → 中文标签（未知状态原样展示） */
export function agentStatusText(s: string | undefined): string {
  if (!s) return '—'
  return AGENT_STATUS_LABEL[s] || s
}

/** 星期显示（对齐原版「一二三四五六日」顺序，index 0=周一） */
export const WEEKDAY_LABELS = ['一', '二', '三', '四', '五', '六', '日'] as const

/** 新建表单（默认值对齐原版：热点采集 / 每天 09:00 / 周一~五） */
export interface ScheduledForm {
  name: string
  taskType: 'hotspot' | 'agent'
  goal: string
  mode: 'daily' | 'weekly'
  time: string
  weekdays: boolean[]
}

export function useScheduledTasks() {
  /* ── 本地定时任务域 ── */
  const tasks = ref<TintinBridgeScheduledTask[]>([])
  const loading = ref(false)
  const creating = ref(false)
  const notice = ref('')

  /** 表单当前拆解结果（agent 类型「拆解任务」按钮产出，注册时随任务存储） */
  const currentPlan = ref<TintinBridgeAgentPlan | null>(null)
  const splitting = ref(false)

  /** 拆解任务描述（对照原版 build_plan：LLM 产出能力步骤 → 注册时存 plan，到点优先提交） */
  async function splitPlan(): Promise<void> {
    if (form.value.taskType !== 'agent' || !form.value.goal.trim() || splitting.value) return
    splitting.value = true
    notice.value = ''
    try {
      const [ok, data] = await window.tintin.scheduled.splitPlan(form.value.goal.trim())
      if (ok && typeof data === 'object') {
        currentPlan.value = data
        notice.value = `拆解完成：${data.steps.length} 个能力步骤，注册任务后将随任务存储（到点优先按此执行）。`
      } else {
        currentPlan.value = null
        notice.value = `拆解失败：${data}`
      }
    } catch (e) {
      notice.value = `拆解失败：${(e as Error).message}`
    } finally {
      splitting.value = false
    }
  }

  const form = ref<ScheduledForm>({
    name: '热点采集',
    taskType: 'hotspot',
    goal: '生成产品文案，做合规复检，再生成分镜脚本并评价',
    mode: 'daily',
    time: '09:00',
    weekdays: [true, true, true, true, true, false, false]
  })

  /** 新建表单校验（与主进程 validateCreate 同源的入口侧快速反馈） */
  const formError = computed(() => {
    const f = form.value
    if (!f.name.trim()) return '任务名称不能为空'
    if (f.taskType === 'agent' && !f.goal.trim()) return '云端智能体任务需要填写任务描述'
    if (!/^\d{2}:\d{2}$/.test(f.time)) return '时间格式应为 HH:MM'
    if (f.mode === 'weekly' && !f.weekdays.some(Boolean)) return '每周模式至少选择一个星期'
    return ''
  })

  /** 非 Electron 壳（纯浏览器预览）时 IPC 不可用，统一降级提示 */
  function shellAvailable(): boolean {
    if (typeof window !== 'undefined' && window.tintin?.scheduled) return true
    notice.value = '当前为浏览器预览模式，定时任务功能需在桌面端使用。'
    return false
  }

  async function load() {
    if (loading.value) return
    if (!shellAvailable()) return
    loading.value = true
    try {
      tasks.value = (await window.tintin.scheduled.list()) || []
    } catch (e) {
      notice.value = `本地任务刷新失败：${(e as Error).message}`
    } finally {
      loading.value = false
    }
  }

  /** 注册任务（对齐原版 _on_create：goal 必填校验在 formError，主进程负责 schtasks） */
  async function create(): Promise<boolean> {
    if (formError.value || creating.value) return false
    creating.value = true
    notice.value = ''
    try {
      const payload = {
        name: form.value.name.trim(),
        taskType: form.value.taskType,
        schedule: {
          mode: form.value.mode,
          time: form.value.time,
          weekdays: form.value.weekdays
            .map((on, i) => (on ? i : -1))
            .filter((i) => i >= 0)
        },
        goal: form.value.taskType === 'agent' ? form.value.goal.trim() : '',
        plan: form.value.taskType === 'agent' ? currentPlan.value : null
      }
      const [ok, msg] = await window.tintin.scheduled.create(payload)
      if (ok) {
        currentPlan.value = null
        notice.value = `定时任务已注册：${msg}（已写入 Windows 任务计划程序）`
        await load()
        return true
      }
      notice.value = `注册失败：${msg}`
      return false
    } catch (e) {
      notice.value = `注册失败：${(e as Error).message}`
      return false
    } finally {
      creating.value = false
    }
  }

  /** 立即运行一次（schtasks /run） */
  async function runNow(taskName: string) {
    notice.value = ''
    try {
      const [ok, msg] = await window.tintin.scheduled.run(taskName)
      notice.value = `任务 ${taskName}：${ok ? msg : msg || '触发失败'}`
      if (ok) await load()
    } catch (e) {
      notice.value = `运行失败：${(e as Error).message}`
    }
  }

  /** 取消定时（schtasks /delete + 清理清单） */
  async function remove(name: string) {
    if (!window.confirm(`确定取消定时任务「${name}」吗？\n（任务计划程序中的注册项将一并删除）`)) return
    notice.value = ''
    try {
      const [ok, msg] = await window.tintin.scheduled.delete(name)
      notice.value = ok ? `定时任务「${name}」已取消` : `取消失败：${msg}`
      if (ok) await load()
    } catch (e) {
      notice.value = `取消失败：${(e as Error).message}`
    }
  }

  /* ── 今日热点采集域（P4 补齐，对照原版「一键采集」） ── */
  const capturing = ref(false)
  const captureProgress = ref<{ platform: string; index: number; total: number } | null>(null)

  /** 手动采集今日各平台热榜（主进程隐藏 BrowserView 执行，采集完成写清单并切浏览器 Tab） */
  async function captureNow(): Promise<void> {
    if (capturing.value) return
    if (!shellAvailable()) return
    capturing.value = true
    notice.value = ''
    const unsub = window.tintin.scheduled.onScheduledCaptureProgress((p) => {
      captureProgress.value = p
    })
    try {
      const [ok, data] = await window.tintin.scheduled.captureHotspots()
      notice.value = ok
        ? `今日热点采集完成：共 ${data} 条（已写入清单）`
        : `采集失败：${data}`
    } catch (e) {
      notice.value = `采集失败：${(e as Error).message}`
    } finally {
      try { unsub() } catch (_) { /* ignore */ }
      capturing.value = false
      captureProgress.value = null
    }
  }

  /* ── 编排任务详情域（详情弹窗：/tasks/unified/{id} 子步骤树） ── */
  const detailTask = ref<AgentAPI.TaskNode | null>(null)
  const detailLoading = ref(false)

  /** 拉取编排任务详情（子步骤 + 进度 + 结果预览；unifiedItem 失败/离线返回 null 或 {error}） */
  async function openDetail(id: string): Promise<void> {
    detailLoading.value = true
    try {
      const node = await window.tintin.server.tasksUnifiedItem(id)
      detailTask.value = node && !('error' in node) ? node : null
    } catch (_) {
      detailTask.value = null
    } finally {
      detailLoading.value = false
    }
  }

  function closeDetail(): void {
    detailTask.value = null
  }

  /* ── 人审决策点域（2026-09-01，PRD-human-in-loop-choices：详情弹窗内决策卡）── */
  /** 详情任务待决策点（等待态含 derived_status 兼容 + pending_decision 归一；非法/无 → null 回退纯确认） */
  const pendingDecision = computed<PendingDecision | null>(() =>
    detailTask.value && isWaitingUserInput(detailTask.value)
      ? normalizePendingDecision(detailTask.value.pending_decision)
      : null
  )
  /** 已选项（统一数组口径：single 恰 1 项 / multi 多项；打开详情预选 default） */
  const decisionSel = ref<string[]>([])
  const decisionError = ref('')
  const decisionSubmitting = ref(false)

  watch(detailTask, (t) => {
    decisionError.value = ''
    decisionSel.value = (t && isWaitingUserInput(t)
      ? normalizePendingDecision(t.pending_decision)?.default
      : null) || []
  })

  /** 勾选切换（multi=toggle；single=置唯一项；radio/checkbox 统一走此函数） */
  function toggleChoice(kind: string, value: string): void {
    decisionError.value = ''
    if (kind === 'multi_choice') {
      decisionSel.value = decisionSel.value.includes(value)
        ? decisionSel.value.filter((v) => v !== value)
        : [...decisionSel.value, value]
    } else {
      decisionSel.value = [value]
    }
  }

  /** 提交选择（POST confirm {decision_id, choice:[...]}；422/409 文案映射） */
  async function submitDecision(): Promise<void> {
    const d = pendingDecision.value
    if (!d || decisionSubmitting.value) return
    const err = validateDecisionSelection(d.kind, decisionSel.value)
    if (err) { decisionError.value = err; return }
    decisionSubmitting.value = true
    decisionError.value = ''
    try {
      const res = await window.tintin.server.agentTaskAction({
        id: detailTask.value!.id,
        action: 'confirm',
        decision: { decision_id: d.decisionId, choice: decisionSel.value }
      })
      if (res && !('error' in res)) {
        notice.value = `决策已提交，任务继续执行。`
        await openDetail(detailTask.value!.id) // 重拉详情：状态离开 waiting 后决策卡自动消失
        await loadAgent()
      } else {
        decisionError.value = mapDecisionError(res)
      }
    } catch (e) {
      decisionError.value = `决策提交失败：${(e as Error).message}`
    } finally {
      decisionSubmitting.value = false
    }
  }

  /** 拒绝决策（POST confirm {decision_id, action:'reject', reason}；服务端按 on_reject 处理） */
  async function rejectDecision(): Promise<void> {
    const d = pendingDecision.value
    if (!d || decisionSubmitting.value) return
    const reason = window.prompt(`拒绝原因（可空）：\n${d.ask}`)
    if (reason === null) return // 取消
    decisionSubmitting.value = true
    decisionError.value = ''
    try {
      const res = await window.tintin.server.agentTaskAction({
        id: detailTask.value!.id,
        action: 'confirm',
        decision: { decision_id: d.decisionId, action: 'reject', reason }
      })
      if (res && !('error' in res)) {
        notice.value = `已拒绝该决策，按服务端策略继续。`
        await openDetail(detailTask.value!.id)
        await loadAgent()
      } else {
        decisionError.value = mapDecisionError(res)
      }
    } catch (e) {
      decisionError.value = `拒绝失败：${(e as Error).message}`
    } finally {
      decisionSubmitting.value = false
    }
  }

  /* ── 执行结果域①：编排任务执行实例（云端智能体定时任务到点执行产生；
     GET /agent/tasks 根任务；对齐原版 mgmt_page L262「最近编排任务」） ── */
  interface AgentTaskRow {
    id: string
    goal: string
    status: string
    progress: number
    created_at: string
  }
  const agentTasks = ref<AgentTaskRow[]>([])
  const agentLoading = ref(false)

  async function loadAgent() {
    if (agentLoading.value) return
    agentLoading.value = true
    try {
      const data = await window.tintin.server.agentTaskList({ page: 1, page_size: 10 })
      const list = (data && !('error' in data) && data.tasks) || []
      agentTasks.value = list.slice(0, 10).map((t: Record<string, unknown>, i: number) => ({
        id: String(t.id ?? i),
        goal: String(t.goal ?? t.capability ?? '—'),
        status: String(t.status ?? t.derived_status ?? ''),
        progress: Number(t.progress) || 0,
        created_at: String(t.created_at ?? '').slice(0, 16)
      }))
    } catch (_) {
      agentTasks.value = []
    } finally {
      agentLoading.value = false
    }
  }

  /* ── 执行结果域②：服务端定时任务执行记录（成片类定时任务到点执行；
     GET /scheduled/tasks，对齐原 scheduled_tasks_page.py 执行状态页） ── */
  const schedExecRows = ref<SchedExecRow[]>([])
  const schedExecLoading = ref(false)

  async function loadSchedExec() {
    if (schedExecLoading.value) return
    schedExecLoading.value = true
    try {
      const data = await window.tintin.server.scheduledTasksList({ page: 1, size: 20 })
      const list = (data && !('error' in data) && (data.tasks || data.items)) || []
      schedExecRows.value = toSchedExecRows(list)
    } catch (_) {
      schedExecRows.value = []
    } finally {
      schedExecLoading.value = false
    }
  }

  /** 执行记录详情（GET /scheduled/tasks/{id}：params/error_msg/result 全量） */
  const schedItem = ref<ScheduledAPI.TaskExecRecord | null>(null)
  const schedItemLoading = ref(false)

  async function openSchedItem(id: string): Promise<void> {
    schedItemLoading.value = true
    try {
      const rec = await window.tintin.server.scheduledTaskItem(id)
      schedItem.value = rec && !('error' in rec) ? rec : null
    } catch (_) {
      schedItem.value = null
    } finally {
      schedItemLoading.value = false
    }
  }

  function closeSchedItem(): void {
    schedItem.value = null
  }

  /** waiting_user_input 节点人工确认 → 继续执行（POST /agent/tasks/{id}/confirm） */
  async function confirmAgent(id: string) {
    notice.value = ''
    try {
      const res = await window.tintin.server.agentTaskAction({ id, action: 'confirm' })
      notice.value = res && !('error' in res)
        ? `任务 ${id} 已确认，继续执行。`
        : `任务 ${id} 确认失败（状态可能已变化）。`
      await loadAgent()
    } catch (e) {
      notice.value = `确认失败：${(e as Error).message}`
    }
  }

  /* 2026-08-30 用户裁决：删除「云端智能体能力」清单域（loadRegistry/agentCaps/
     capsLoading）——智能体已展示在输入框下快捷条，抽屉内重复展示无价值。 */

  return {
    // 注册域（本地 schtasks：热点采集 + 云端智能体两类注册项）
    tasks, loading, creating, notice, form, formError,
    load, create, runNow, remove,
    // agent 任务拆解（对照原版 build_plan）
    currentPlan, splitting, splitPlan,
    // 今日热点采集
    capturing, captureProgress, captureNow,
    // 执行结果域：编排任务详情弹窗（/tasks/unified/{id} 子步骤树）
    detailTask, detailLoading, openDetail, closeDetail,
    // 人审决策点（详情弹窗内决策卡；PRD-human-in-loop-choices）
    pendingDecision, decisionSel, decisionError, decisionSubmitting,
    toggleChoice, submitDecision, rejectDecision,
    // 执行结果域①：编排任务执行实例（/agent/tasks）
    agentTasks, agentLoading, loadAgent, confirmAgent,
    // 执行结果域②：服务端定时任务执行记录（/scheduled/tasks）
    schedExecRows, schedExecLoading, loadSchedExec,
    schedItem, schedItemLoading, openSchedItem, closeSchedItem
  }
}
