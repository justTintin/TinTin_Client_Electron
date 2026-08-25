// ═══════════════════════════════════════════════════════════════
// Tasks Store — 成片 / 媒体工具任务状态
//
// 数据结构对齐：
//   - AgentAPI.TaskNode              （/tasks/unified/{id} 父子任务树）
//   - TasksAPI.UnifiedTaskType       （过滤条件 type 枚举）
//   - TasksAPI.UnifiedListRequest    （分页筛选请求）
//   - TasksAPI.UnifiedListResponse   （分页响应）
//
// 接口全部通过 window.tintin.server.tasks* 业务级方法调用，不再手写路径。
// ═══════════════════════════════════════════════════════════════

import { defineStore } from 'pinia'
import { ref, reactive } from 'vue'
import type {
  AgentAPI,
  TasksAPI,
  TaskStatus,
  UnifiedTaskType,
  PaginatedResponse,
} from '../../../types/server-api'

/**
 * 对外任务视图层用的 Item 类型（与 AgentAPI.TaskNode 同构，但声明一层避免业务层直接 import 嵌套命名空间）
 */
export type TaskTreeNode = AgentAPI.TaskNode

const EMPTY_PAGE: PaginatedResponse<TaskTreeNode> = {
  items: [], total: 0, page: 1, page_size: 20, has_more: false,
}

export const useTasksStore = defineStore('tasks', () => {
  // ── state ──────────────────────────────────────────────────────
  const loading = ref<boolean>(false)
  const page = reactive({
    items:      [] as TaskTreeNode[],
    total:      0,
    page:       1,
    page_size:  20,
    has_more:   false,
  })
  const filters = reactive<TasksAPI.UnifiedListRequest>({
    page: 1,
    page_size: 20,
    types:      undefined,
    statuses:   undefined,
    search:     undefined,
    created_from: undefined,
    created_to:   undefined,
  })

  /** 单独详情（/tasks/unified/{id} 取的完整子树，带 children / children_progress） */
  const detailById = reactive<Record<string, TaskTreeNode | null>>({})

  // ── helpers ────────────────────────────────────────────────────
  function _patchResponse(
    resp: TasksAPI.UnifiedListResponse | null | { error: string } | undefined
  ): TasksAPI.UnifiedListResponse {
    if (!resp || (resp as any)?.error) {
      return { ...EMPTY_PAGE }
    }
    return resp as TasksAPI.UnifiedListResponse
  }

  // ── actions ────────────────────────────────────────────────────

  /**
   * 拉取成片任务 / 媒体工具任务的统一列表（/tasks/unified）
   * 支持按任务类型 / 状态 / 时间 / 搜索过滤，分页。
   */
  async function fetchTasks(
    override?: Partial<TasksAPI.UnifiedListRequest>
  ): Promise<TasksAPI.UnifiedListResponse> {
    loading.value = true
    try {
      if (override) {
        (Object.keys(override) as (keyof TasksAPI.UnifiedListRequest)[]).forEach((k) => {
          ;(filters as any)[k] = (override as any)[k]
        })
      }
      if (!window.tintin?.server?.tasksUnifiedList) return { ...EMPTY_PAGE }
      const resp = await window.tintin.server.tasksUnifiedList({
        types: filters.types,
        statuses: filters.statuses,
        search: filters.search,
        created_from: filters.created_from,
        created_to: filters.created_to,
        page: filters.page ?? 1,
        page_size: filters.page_size ?? 20,
      })
      const data = _patchResponse(resp)
      page.items      = data.items || []
      page.total      = data.total ?? 0
      page.page       = data.page ?? 1
      page.page_size  = data.page_size ?? (filters.page_size ?? 20)
      page.has_more   = !!data.has_more
      return data
    } catch (_err) {
      page.items = []; page.total = 0; page.has_more = false
      return { ...EMPTY_PAGE }
    } finally {
      loading.value = false
    }
  }

  /** 获取单个任务的完整子树（含 a_* 前缀子任务、children_progress、waiting_reason） */
  async function fetchDetail(id: string): Promise<TaskTreeNode | null> {
    try {
      if (!id) return null
      if (!window.tintin?.server?.tasksUnifiedItem) return null
      const resp = await window.tintin.server.tasksUnifiedItem(id)
      if (!resp || (resp as any)?.error) {
        detailById[id] = null
        return null
      }
      detailById[id] = resp as TaskTreeNode
      return detailById[id]
    } catch (_err) {
      detailById[id] = null
      return null
    }
  }

  /** 轮询任务进度（/tasks/{id}）—— S1/S2 rembg 提交后用这个拿 progress 0-100 */
  async function fetchProgress(id: string): Promise<TasksAPI.ProgressResponse | null> {
    try {
      if (!id) return null
      if (!window.tintin?.server?.tasksProgress) return null
      const resp = await window.tintin.server.tasksProgress(id)
      if (!resp || (resp as any)?.error) return null
      // 同步更新列表页里对应那一行的 status/progress/stage（如果在当前页）
      const idx = page.items.findIndex((t) => t.id === id)
      if (idx >= 0) {
        const pr = resp as TasksAPI.ProgressResponse
        page.items[idx].status   = pr.status
        page.items[idx].progress = pr.progress
        if (pr.stage) page.items[idx].stage = pr.stage
        if (pr.error_message) page.items[idx].error_message = pr.error_message
      }
      return resp as TasksAPI.ProgressResponse
    } catch (_err) {
      return null
    }
  }

  /** 下载任务结果（抠图 PNG / 修复 MP4 / 成片 ZIP）到本地指定路径 */
  async function downloadResult(id: string, savePath: string): Promise<string | null> {
    try {
      if (!id || !savePath) return null
      if (!window.tintin?.server?.tasksDownloadResult) return null
      const resp = await window.tintin.server.tasksDownloadResult(id, savePath)
      if (!resp || (resp as any)?.error) return null
      return resp as string
    } catch (_err) {
      return null
    }
  }

  /** 设置单个任务过滤条件（不立即发请求，调用 fetchTasks 才拉） */
  function setFilter(patch: Partial<TasksAPI.UnifiedListRequest>): void {
    (Object.keys(patch) as (keyof TasksAPI.UnifiedListRequest)[]).forEach((k) => {
      ;(filters as any)[k] = (patch as any)[k]
    })
  }

  /** 重置过滤条件 */
  function resetFilters(): void {
    filters.types      = undefined
    filters.statuses   = undefined
    filters.search     = undefined
    filters.created_from = undefined
    filters.created_to   = undefined
    filters.page       = 1
    filters.page_size  = 20
  }

  /** isWaiting 判断 helper（挂起态=人工确认，按 V2 S3 PATCH confirm/cancel） */
  function isWaiting(status: TaskStatus | string): boolean {
    return status === 'waiting_user_input'
  }

  return {
    // state
    loading,
    page,
    filters,
    detailById,
    // actions
    fetchTasks,
    fetchDetail,
    fetchProgress,
    downloadResult,
    setFilter,
    resetFilters,
    isWaiting,
  }
})
