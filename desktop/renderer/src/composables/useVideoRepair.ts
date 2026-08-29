// ═══════════════════════════════════════════════════════════════
// useVideoRepair — 视频修复·工作流发现/提交/轮询/回填下载（条目⑤ 业务层）
// 对照原客户端：
//   · utils/workflow_client.py list_workflows/run_workflow/task_status
//     （GET /workflows?scope=client → POST /workflows/{id}/run multipart →
//       GET /workflows/task/{id}；返回 {ok, task_id} / {code, data:{status,results,errorMessage}}）
//   · gui/main_window_aigen.py _query_single_rh_task L823-906
//     （3s 轮询 L656；终态 SUCCESS→自动回填下载 L884、FAILED→错误透出 L885-892）
//   · gui/main_window_aigen.py _auto_download_rh_results L1031-1104
//     （命名 media.ext / media_idx.ext / task_id_idx.ext，同名追加 task_id）
//   · gui/main_window_pages.py L492-497（默认选「输入视频-修复脸部细节」工作流）
// 纯逻辑在 videoRepairLogic.ts（parser/builder 层），本文件仅编排（runner 层）
// ═══════════════════════════════════════════════════════════════

import { ref, computed, onUnmounted } from 'vue'
import {
  normalizeServerWorkflow,
  extractTaskData,
  extractTaskResults,
  mapWorkflowStatus,
  buildResultName,
  pickDefaultWorkflow,
  extractResultEntries,
  type ServerWorkflow,
  type WorkflowStatusInfo,
} from './videoRepairLogic'

function notify(title: string, body: string): void {
  try { window.tintin?.shell?.showNotification?.(title, body) } catch (_) {}
}

const POLL_INTERVAL_MS = 3000 // 对照 _start_rh_poll_timer L656

export function useVideoRepair() {
  // ── 工作流发现 ──
  const workflows = ref<ServerWorkflow[]>([])
  const selectedWfId = ref('')
  const wfLoading = ref(false)
  const wfStatusText = ref('正在拉取服务端工作流列表…')

  // ── 输入 ──
  const videoPath = ref('')
  const videoName = ref('')

  // ── 提交/轮询 ──
  const submitting = ref(false)
  const uploadPercent = ref(0)
  const taskId = ref('')
  const polling = ref(false)
  const statusInfo = ref<WorkflowStatusInfo | null>(null)
  const errorMessage = ref('')
  const results = ref<Array<Record<string, any>>>([])
  const downloadingIdx = ref(-1)

  let pollTimer: ReturnType<typeof setInterval> | null = null

  const selectedWf = computed(
    () => workflows.value.find((w) => w.id === selectedWfId.value) || null,
  )
  /** 后端展示（原版后端选择锁 ComfyUI；新口径后端由服务端工作流自带） */
  const backendText = computed(() => selectedWf.value?.backend || 'comfyui')

  const wfOptions = computed(() =>
    workflows.value.map((w) => ({
      label: `${w.name}（${w.type}）`,
      value: w.id,
    })),
  )

  const canSubmit = computed(() => !!selectedWfId.value && !!videoPath.value && !submitting.value)

  /** 拉取工作流列表并默认选中「修复脸部细节」（对照 refresh + L492-497） */
  async function loadWorkflows(): Promise<void> {
    wfLoading.value = true
    wfStatusText.value = '正在拉取服务端工作流列表…'
    try {
      const res = await window.tintin.server.get<{ workflows?: unknown[] }>('/workflows', {
        scope: 'client',
      })
      const list = (Array.isArray(res?.workflows) ? res!.workflows : [])
        .map(normalizeServerWorkflow)
        .filter((w): w is ServerWorkflow => !!w)
      workflows.value = list
      if (!list.length) {
        wfStatusText.value = '未获取到可用工作流（请检查服务端地址与网络）'
        return
      }
      if (!workflows.value.some((w) => w.id === selectedWfId.value)) {
        selectedWfId.value = pickDefaultWorkflow(list)
      }
      wfStatusText.value = `已加载 ${list.length} 个工作流`
    } catch (err) {
      wfStatusText.value = `拉取工作流失败：${err instanceof Error ? err.message : String(err)}`
    } finally {
      wfLoading.value = false
    }
  }

  function setVideo(path: string): void {
    videoPath.value = path
    videoName.value = path.split(/[\\/]/).pop() || path
    errorMessage.value = ''
  }

  /** 提交视频处理任务（对照 run_video_tool_task L110-144：未选工作流/视频先拦截） */
  async function submit(): Promise<void> {
    if (!selectedWfId.value) {
      errorMessage.value = '请先选择工作流。'
      return
    }
    if (!videoPath.value) {
      errorMessage.value = '请先选择视频文件。'
      return
    }
    submitting.value = true
    errorMessage.value = ''
    taskId.value = ''
    statusInfo.value = null
    results.value = []
    uploadPercent.value = 0
    try {
      // multipart 按工作流 inputs 的文件组件 key 编组（缺省 video；{path} 包装由
      // multipartUpload 读取本地文件，对照原 files={"video": video_path} 语义）
      const fileKey =
        String(
          (selectedWf.value?.inputs || []).find(
            (i) => String((i as any)?.kind || '') === 'video',
          )?.key,
        ) || 'video'
      const fields: Record<string, string | Blob> = {
        [fileKey]: { path: videoPath.value } as unknown as Blob,
        instance_type: selectedWf.value?.instanceType || 'default',
      }
      const res = await window.tintin.server.upload(
        `/workflows/${encodeURIComponent(selectedWfId.value)}/run`,
        fields,
        (p: number) => { uploadPercent.value = Math.round(p) },
      )
      if (!res) throw new Error('服务端离线或未返回结果')
      if ((res as any).error) throw new Error((res as any).error)
      const id = (res as any).task_id ?? (res as any).taskId ?? (res as any).id
      if (!id) throw new Error('提交失败，未返回任务 ID')
      taskId.value = String(id)
      statusInfo.value = mapWorkflowStatus('QUEUED')
      notify('视频修复', `任务已提交：${id}`)
      startPolling(String(id))
    } catch (err) {
      errorMessage.value = err instanceof Error ? err.message : String(err)
      notify('视频修复失败', errorMessage.value)
    } finally {
      submitting.value = false
    }
  }

  /** 轮询任务（对照 _query_single_rh_task：3s 周期，终态停表回填） */
  function startPolling(id: string): void {
    stopPolling()
    polling.value = true
    let inFlight = false
    const tick = async (): Promise<void> => {
      if (inFlight) return
      inFlight = true
      try {
        const resp = await window.tintin.server.get(`/workflows/task/${encodeURIComponent(id)}`)
        if (!resp) return // 离线/空响应保持当前状态等下一拍
        const data = extractTaskData(resp)
        if (data.errorMessage && !data.status) {
          // 无状态仅有错误 → 按失败透出（对照 L841 status 兜底取 errorMessage）
          finishFailed(id, data.errorMessage)
          return
        }
        const info = mapWorkflowStatus(data.status)
        statusInfo.value = info
        if (info.phase === 'done') {
          results.value = extractResultEntries(extractTaskResults(data))
          stopPolling()
          notify('视频修复完成', `任务 ${id} 完成，结果 ${results.value.length} 个`)
        } else if (info.phase === 'failed') {
          finishFailed(id, String(data.errorMessage || '任务失败'))
        }
      } catch (_) {
        // 单次查询异常不终止轮询（对照原版查询失败静默跳过）
      } finally {
        inFlight = false
      }
    }
    void tick()
    pollTimer = setInterval(() => { void tick() }, POLL_INTERVAL_MS)
  }

  function finishFailed(id: string, msg: string): void {
    statusInfo.value = mapWorkflowStatus('FAILED')
    errorMessage.value = msg
    stopPolling()
    notify('视频修复失败', `任务 ${id}：${msg}`)
  }

  function stopPolling(): void {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
    polling.value = false
  }

  /** 下载单个结果（url→saveFile+downloadResult；text→blob 落盘由浏览器接管） */
  async function downloadEntry(entry: Record<string, any>, idx: number): Promise<void> {
    const url = String(entry.url || '')
    const text = typeof entry.text === 'string' ? entry.text : ''
    if (!url && !text) return
    const ext = String(entry.outputType || 'bin')
    const defaultName = buildResultName(
      videoName.value.replace(/\.[^.]+$/, ''),
      idx + 1,
      results.value.length,
      ext,
      taskId.value,
      () => false, // saveFile 对话框自带重名确认
    )
    if (!url) {
      // 纯文本结果 → blob 下载
      const blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
      const href = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = href
      a.download = defaultName
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(href)
      return
    }
    downloadingIdx.value = idx
    try {
      const savePath = await window.tintin.dialog.saveFile({
        title: '保存修复结果',
        defaultPath: defaultName,
      })
      if (!savePath) return
      const saved = await window.tintin.server.downloadResult(url, savePath)
      if (!saved) throw new Error('下载失败（服务端离线或网络异常）')
      notify('下载完成', String(saved))
      try { window.tintin.shell.revealInFolder(String(saved)) } catch (_) {}
    } catch (err) {
      notify('下载失败', err instanceof Error ? err.message : String(err))
    } finally {
      downloadingIdx.value = -1
    }
  }

  /** 结果展示名（filename 优先，url 退化取尾段） */
  function resultDisplayName(entry: Record<string, any>): string {
    if (entry.filename) return String(entry.filename)
    if (entry.url) return String(entry.url).split('/').pop() || String(entry.url)
    return '文本结果'
  }

  onUnmounted(stopPolling)

  return {
    // state
    workflows, wfOptions, selectedWfId, selectedWf, wfLoading, wfStatusText, backendText,
    videoPath, videoName,
    submitting, uploadPercent, taskId, polling, statusInfo, errorMessage,
    results, downloadingIdx, canSubmit,
    // methods
    loadWorkflows, setVideo, submit, stopPolling, downloadEntry, resultDisplayName,
  }
}
