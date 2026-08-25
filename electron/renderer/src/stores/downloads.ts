// ═══════════════════════════════════════════════════════════════
// Downloads Store — 下载任务
// 通过 window.tintin.downloads 桥接管理下载任务并跟踪进度
// ═══════════════════════════════════════════════════════════════

import { defineStore } from 'pinia'
import { ref } from 'vue'

/** 单个下载任务状态 */
export type DownloadState = 'pending' | 'progress' | 'paused' | 'done' | 'error'

/** 单个下载任务 */
export interface DownloadTask {
  taskId: string
  url: string
  savePath: string
  percent: number
  speed: number
  state: DownloadState
  downloaded: number
  total: number
}

export const useDownloadsStore = defineStore('downloads', () => {
  // 全部下载任务
  const tasks = ref<DownloadTask[]>([])

  /** 根据 taskId 查找任务索引 */
  function findIndex(taskId: string): number {
    return tasks.value.findIndex((t) => t.taskId === taskId)
  }

  /** 启动一个下载任务，并绑定进度/完成回调 */
  async function startDownload(params: {
    url: string
    savePath: string
    referer?: string
    headers?: Record<string, string>
  }): Promise<string> {
    const taskId = await window.tintin.downloads.start(params)

    const task: DownloadTask = {
      taskId,
      url: params.url,
      savePath: params.savePath,
      percent: 0,
      speed: 0,
      state: 'pending',
      downloaded: 0,
      total: 0
    }
    tasks.value.push(task)

    // 监听进度
    window.tintin.downloads.onProgress(taskId, (p) => {
      const idx = findIndex(taskId)
      if (idx === -1) return
      const t = tasks.value[idx]
      t.percent = p.percent
      t.speed = p.speed
      t.downloaded = p.downloaded
      t.total = p.total
      if (t.state === 'pending') t.state = 'progress'
    })

    // 监听完成
    window.tintin.downloads.onDone(taskId, (d) => {
      const idx = findIndex(taskId)
      if (idx === -1) return
      const t = tasks.value[idx]
      t.state = 'done'
      t.percent = 100
      t.downloaded = d.size
      t.total = d.size
      t.savePath = d.finalPath
    })

    return taskId
  }

  /** 移除指定任务（仅清理本地状态，不取消远端任务） */
  function removeTask(taskId: string): void {
    const idx = findIndex(taskId)
    if (idx !== -1) tasks.value.splice(idx, 1)
  }

  return {
    tasks,
    startDownload,
    removeTask
  }
})
