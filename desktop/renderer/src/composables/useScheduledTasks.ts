// ═══════════════════════════════════════════════════════════════
// useScheduledTasks — 定时任务管理域（P2 移植）
// 对照基准：原客户端 scheduled_tasks_mgmt_page.py + local_scheduler.py。
// 本地任务（schtasks）经 window.tintin.scheduled IPC；
// 云端编排任务（GET /agent/tasks 根任务、waiting_user_input 人工确认）
// 经 window.tintin.server 通用通道（契约：types/server-api.ts AgentAPI）。
// ═══════════════════════════════════════════════════════════════

import { computed, ref } from 'vue'
import type { TintinBridgeScheduledTask, TintinBridgeAgentPlan } from '../../../types/global'
import type { AgentAPI } from '../../../types/server-api'

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

  /* ── 云端编排任务域（GET /agent/tasks 根任务） ── */
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

  /* ── 云端智能体能力清单（GET /agent/registry，executor=server） ── */
  interface AgentCap { id: string; name: string; description: string; api: string }
  const agentCaps = ref<AgentCap[]>([])
  const capsLoading = ref(false)

  async function loadRegistry() {
    if (capsLoading.value) return
    capsLoading.value = true
    try {
      const reg = await window.tintin.server.agentRegistry()
      // /agent/registry 返回能力项数组（V2 §13.3，server.ts store 亦按数组消费）；
      // 兼容历史 {capabilities:[...]} 包裹结构
      const raw: unknown = (reg && !('error' in reg)) ? reg : null
      const list = Array.isArray(raw) ? raw : (((raw as { capabilities?: unknown[] } | null)?.capabilities) ?? [])
      agentCaps.value = (list as Array<Record<string, unknown>>)
        .filter((c: Record<string, unknown>) => c.executor === 'server')
        .map((c: Record<string, unknown>) => ({
          id: String(c.id ?? '—'),
          name: String(c.name ?? '—'),
          description: String(c.description ?? '—'),
          api: String(c.api ?? '—')
        }))
      if (!agentCaps.value.length) notice.value = '服务端未注册任何云端智能体，请确认服务端在线。'
    } catch (e) {
      notice.value = `云端智能体列表加载失败：${(e as Error).message}`
    } finally {
      capsLoading.value = false
    }
  }

  return {
    // 本地任务域
    tasks, loading, creating, notice, form, formError,
    load, create, runNow, remove,
    // agent 任务拆解（对照原版 build_plan）
    currentPlan, splitting, splitPlan,
    // 今日热点采集
    capturing, captureProgress, captureNow,
    // 编排任务详情
    detailTask, detailLoading, openDetail, closeDetail,
    // 云端编排域
    agentTasks, agentLoading, loadAgent, confirmAgent,
    // 能力清单域
    agentCaps, capsLoading, loadRegistry
  }
}
