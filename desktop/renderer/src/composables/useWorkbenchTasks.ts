// ═══════════════════════════════════════════════════════════════
// useWorkbenchTasks — 工作台任务队列域（条目⑫ 去 mock + 轮询）
// 数据源（对齐原 main_window_pages.py 任务队列页 L1246-1478 字段语义）：
//   真实服务端任务：/tasks/unified 统一任务中心（tasksStore，复用既有
//   轮询通道 fetchProgress /tasks/{id}）——工作台对话转编排任务、
//   浏览器/媒体工具提交的服务端任务都在此列表（原演示假数据已删除）。
// 轮询（复用 useVideoRepair 的 setInterval 模式）：抽屉打开期间
//   · 5s：对 running/pending 行调 tasksStore.fetchProgress 回填进度/状态
//   · 30s：整表 fetchTasks 刷新；关闭抽屉立即停止
// 展示字段对齐原七列口径：状态/进度/结果打开（openTaskResult）。
// 编组纯函数在 taskQueueLogic.ts（有单测），本文件只做状态与 IPC 编排。
// ═══════════════════════════════════════════════════════════════

import { ref, computed, onBeforeUnmount } from 'vue'
import { useTasksStore } from '@/stores/tasks'
import {
  statusText,
  mapServerTaskRow,
} from './taskQueueLogic'
import type { TaskRow } from './taskQueueLogic'

// 重导出（WbTaskDrawer 等组件按原路径 import，唯一定义点在 taskQueueLogic）
export { statusText }
export type { TaskRow }

/** 进度轮询间隔（对照 useVideoRepair POLL_INTERVAL_MS=3000；列表口径 5s） */
const PROGRESS_POLL_MS = 5000
/** 整表刷新间隔（进度轮询每 6 次触发一次 fetchTasks） */
const LIST_REFRESH_EVERY = 6

function getBridge(): any {
  return (window as any).tintin
}

export function useWorkbenchTasks() {
  const tasksStore = useTasksStore()

  /** 任务队列抽屉是否展开 */
  const taskQueueOpen = ref(false)

  /* ── 展示列表：服务端任务（空态由抽屉空态兜底，无假数据） ── */
  const taskRows = computed<TaskRow[]>(() =>
    (tasksStore.page.items || []).slice(0, 10).map(mapServerTaskRow),
  )

  /* ── 轮询（抽屉打开期间）：进度回填 + 整表刷新 ── */
  let pollTimer: ReturnType<typeof setInterval> | null = null
  let pollTick = 0

  function stopPolling(): void {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
  }

  function startPolling(): void {
    stopPolling()
    pollTick = 0
    pollTimer = setInterval(() => {
      pollTick += 1
      // 30s 整表刷新（新任务/被清任务出现）
      if (pollTick % LIST_REFRESH_EVERY === 0) { void loadTasks() }
      // 5s 进度回填：仅 running/pending 行（复用 tasksStore.fetchProgress 通道，
      // 其内部把结果同步回 page.items[idx]，computed 自动更新 UI）
      for (const t of tasksStore.page.items || []) {
        const s = String(t.status || '')
        if (s === 'completed' || s === 'failed' || s === 'cancelled') continue
        void tasksStore.fetchProgress(t.id)
      }
    }, PROGRESS_POLL_MS)
  }

  /* ── W11：client-task:activity 实时订阅（client-task-thread.js 任务完成
       推送 → 整表刷新，补充 30s 轮询的实时性；事件频率低，刷新代价可接受）── */
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
   * 打开时拉取服务端任务（统一任务中心）。
   * 异常分支：网络失败/5xx 在 tasksStore._patchResponse 内归一为空页 → 空态展示，
   * 此处仅兜底 IPC 未就绪（纯预览模式），不阻塞抽屉打开。
   */
  async function loadTasks(): Promise<void> {
    try {
      await tasksStore.fetchTasks({ page: 1, page_size: 10 })
    } catch (_e) { /* ignore：纯预览模式无 IPC 不阻塞 */ }
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
