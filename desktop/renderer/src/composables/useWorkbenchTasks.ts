// ═══════════════════════════════════════════════════════════════
// useWorkbenchTasks — 工作台任务队列域（条目⑫ 去 mock + 轮询）
// 数据源（2026-08-31 修正，对齐原客户端双页口径）：
//   · /agent/tasks 编排任务（agentTaskList，root_only=true）——工作台对话
//     「转编排任务」创建的 a_ 任务（原 scheduled_tasks_mgmt_page.py L472-495
//     编排任务概览口径：goal/status/progress/created_at）
//   · /tasks 执行层计算任务（tasksList）——浏览器/媒体工具提交的服务端任务
//     （原 main_window_pages.py 任务队列页 L1360 同步服务端口径）
//   注：原先走的 /tasks/unified 在服务端契约中不存在（API-GUIDE
//   无此路径，404 → 空页），是「任务列表无任务消息」的根因。
// 轮询（复用抽屉打开期间 setInterval 模式）：打开期间每 5s 重拉双源列表
//   （列表已含 progress，无需逐行进度轮询）；关闭抽屉立即停止。
//   另订阅 client-task:activity 实时推送触发刷新。
// 展示字段对齐原七列口径：状态/进度/结果打开（openTaskResult）。
// 编组纯函数在 taskQueueLogic.ts（有单测），本文件只做状态与 IPC 编排。
// ═══════════════════════════════════════════════════════════════

import { ref, computed, onBeforeUnmount } from 'vue'
import {
  statusText,
  mapServerTaskRow,
  type ServerTaskLike,
} from './taskQueueLogic'
import type { TaskRow } from './taskQueueLogic'

// 重导出（WbTaskDrawer 等组件按原路径 import，唯一定义点在 taskQueueLogic）
export { statusText }
export type { TaskRow, ServerTaskLike }

/** 任务轮询间隔（列表含进度字段，整表重拉即可） */
const POLL_MS = 5000
/** 双源各取条数（2026-08-31 用户反馈充满后看不全：10→20；抽屉列表已可滚动） */
const FETCH_LIMIT = 20

function getBridge(): any {
  return (window as any).tintin
}

/** /agent/tasks 响应归一：{count,tasks} 或裸数组 → 条目数组 */
function normAgentTasks(data: any): ServerTaskLike[] {
  if (Array.isArray(data)) return data
  return Array.isArray(data?.tasks) ? data.tasks : []
}

export function useWorkbenchTasks() {
  /** 任务队列抽屉是否展开 */
  const taskQueueOpen = ref(false)

  /* ── 原始条目（编排任务在前，执行任务在后；映射在 computed 完成） ── */
  const rawTasks = ref<ServerTaskLike[]>([])

  /* ── 展示列表：编排任务（a_ 前缀）置顶，类型缺省标「编排任务」 ── */
  const taskRows = computed<TaskRow[]>(() =>
    rawTasks.value.map((t) =>
      mapServerTaskRow({
        ...t,
        type: String(t.type || t.capability_key || t.capability || '编排任务'),
      }),
    ),
  )

  /* ── 轮询（抽屉打开期间）：整表重拉双源 ── */
  let pollTimer: ReturnType<typeof setInterval> | null = null

  function stopPolling(): void {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
  }

  function startPolling(): void {
    stopPolling()
    pollTimer = setInterval(() => { void loadTasks() }, POLL_MS)
  }

  /* ── W11：client-task:activity 实时订阅（client-task-thread.js 任务完成
       推送 → 整表刷新，补充 5s 轮询的实时性；事件频率低，刷新代价可接受）── */
  let stopActivity: (() => void) | null = null
  try {
    const t = getBridge()
    if (t && typeof t?.clientTasks?.onActivity === 'function') {
      stopActivity = t.clientTasks.onActivity(() => { void loadTasks() })
    }
  } catch (_e) { /* 纯预览模式无 preload 不阻塞 */ }

  function toggleTaskQueue() {
    taskQueueOpen.value = !taskQueueOpen.value
    if (taskQueueOpen.value) {
      void loadTasks()
      startPolling()
    } else {
      stopPolling()
    }
  }

  function closeTaskQueue() {
    taskQueueOpen.value = false
    stopPolling()
  }

  /**
   * 拉取服务端任务（双源合并：/agent/tasks 编排 + /tasks 执行层）。
   * 异常分支：离线/失败归一为空数组 → 空态展示；双源同时不可用则清空
   * 列表（与原空页口径一致），不阻塞抽屉打开。
   */
  async function loadTasks(): Promise<void> {
    const t = getBridge()
    if (!t?.server) return // 纯预览模式无 IPC 不阻塞
    const [agent, exec] = await Promise.all([
      t.server.agentTaskList
        ? t.server.agentTaskList({ root_only: true, limit: FETCH_LIMIT }).catch(() => null)
        : Promise.resolve(null),
      t.server.tasksList
        ? t.server.tasksList({ limit: FETCH_LIMIT }).catch(() => null)
        : Promise.resolve(null),
    ])
    const agentItems = normAgentTasks(agent)
    const execItems = Array.isArray(exec?.items) ? exec.items : []
    rawTasks.value = [...agentItems, ...execItems]
  }

  /**
   * 结果打开（原详情区「结果」L1339-1340 语义）：
   * url → shell.openExternal；本地路径 → shell.openItem。
   * 返回 false = 无可打开结果 / IPC 不可用（调用方可据此提示）。
   */
  async function openTaskResult(row: TaskRow): Promise<boolean> {
    const target = row?.resultTarget
    if (!target) return false
    const shell = getBridge()?.shell
    if (!shell) return false
    try {
      if (target.kind === 'url') { await shell.openExternal(target.value) }
      else { await shell.openItem(target.value) }
      return true
    } catch (e) {
      console.warn('[TaskQueue] 打开任务结果失败:', (e as any)?.message || e)
      return false
    }
  }

  onBeforeUnmount(() => {
    stopPolling()
    if (stopActivity) { try { stopActivity() } catch (_e) { /* ignore */ } }
  })

  return {
    taskQueueOpen,
    taskRows,
    toggleTaskQueue,
    closeTaskQueue,
    loadTasks,
    openTaskResult,
  }
}
