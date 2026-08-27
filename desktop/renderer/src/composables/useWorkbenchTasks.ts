import { ref, computed } from 'vue'
import { useTasksStore } from '@/stores/tasks'

/* ── 任务队列（对齐设计稿：位于通知中心上方） ──────────────── */
export interface TaskRow {
  id: string
  title: string
  type: string
  progress: number
  status: 'running' | 'done' | 'pending'
  eta: string
}

/** 离线/无服务端时的示例任务（预览兜底，避免空抽屉） */
const SAMPLE_TASKS: TaskRow[] = [
  { id: 't1', title: '成片 · JBL CHARGE6 15s', type: '成片', progress: 78, status: 'running', eta: '剩余 02:13' },
  { id: 't2', title: '抠图 · COVER_MAIN_V1.png', type: '抠图', progress: 100, status: 'done', eta: '已完成' },
  { id: 't3', title: '超分 · 直播回放 4K', type: '超分（视频修复）', progress: 12, status: 'pending', eta: '排队中' },
]

/** 任务状态的中文展示 */
export function statusText(s: string): string {
  if (s === 'done') return '已完成'
  if (s === 'pending') return '排队中'
  return '进行中'
}

/**
 * 工作台任务队列域：真实服务端任务优先、示例兜底的展示列表 + 抽屉开关。
 * statusText 为模块级纯函数，任务抽屉组件直接 import 使用（唯一定义点）。
 */
export function useWorkbenchTasks() {
  const tasksStore = useTasksStore()

  /** 任务队列抽屉是否展开 */
  const taskQueueOpen = ref(false)

  /** 展示用任务列表：优先真实服务端任务，否则用示例兜底 */
  const taskRows = computed<TaskRow[]>(() => {
    const real = tasksStore.page.items
    if (real && real.length > 0) {
      return real.slice(0, 10).map((t: any, i: number) => {
        const p = Number(t.progress) || (t.status === 'done' ? 100 : 0)
        const status: TaskRow['status'] =
          t.status === 'done' ? 'done' : t.status === 'pending' ? 'pending' : 'running'
        return {
          id: String(t.id ?? i),
          title: t.title || t.name || `任务 ${i + 1}`,
          type: t.type || '媒体工具',
          progress: p,
          status,
          eta: t.status === 'done' ? '已完成' : (t.eta || '进行中'),
        }
      })
    }
    return SAMPLE_TASKS
  })

  function toggleTaskQueue() {
    taskQueueOpen.value = !taskQueueOpen.value
    if (taskQueueOpen.value) void loadTasks()
  }

  function closeTaskQueue() {
    taskQueueOpen.value = false
  }

  /** 打开时拉取一次服务端任务（失败/离线静默，靠示例兜底） */
  async function loadTasks(): Promise<void> {
    try {
      await tasksStore.fetchTasks({ page: 1, page_size: 10 })
    } catch (_) { /* ignore：纯预览模式无 IPC 不阻塞 */ }
  }

  return {
    taskQueueOpen,
    taskRows,
    toggleTaskQueue,
    closeTaskQueue,
    loadTasks
  }
}
