// ═══════════════════════════════════════════════════════════════
// useReversePromptVideo — 视频反推提示词·编排层（M6 条目⑦ runner 层）
// 对照原客户端 studio/gui/prompt_reverse_page.py：
//   · _VideoPromptWorker L461-502（POST /prompt/video，start_sec/end_sec 随提交，
//     无本地裁切；响应 task_id/id/job_id → 轮询，无 task_id 同步结果）
//   · _poll_task_result L128-188（600s 超时/3s 间隔；{data:{}} 解包；status|state；
//     终态/失败态；progress ≤1 ×100；用户取消抛「用户取消」）
//   · _format_result L101-122（分段展示）
// 时间轴选段纯函数在 reversePromptVideoLogic.ts（parser/builder 层），
// 组件只绘制 + 事件转发（IRON-06/07 分层）。
// ═══════════════════════════════════════════════════════════════

import { ref, computed, onUnmounted } from 'vue'
import {
  MAX_WINDOW_SEC,
  POLL_TIMEOUT_MS,
  POLL_INTERVAL_MS,
  initialRange,
  clampDragLeft,
  clampDragRight,
  clampMove,
  fmtSec,
  frameTimestamps,
  parsePromptVideoResponse,
  extractTaskObj,
  mapTaskStatus,
  pollPhaseText,
  formatPromptResult,
  validateRange,
  type PromptSegment,
} from './reversePromptVideoLogic'
import { useFilePicker } from './useFilePicker'

function notify(title: string, body: string): void {
  try { window.tintin?.shell?.showNotification?.(title, body) } catch (_) {}
}

/** 两位小数（对照原版 start_sec/end_sec 提交精度 L482-488） */
function rounded2(v: number): number {
  return Number((Number(v) || 0).toFixed(2))
}

export type DragMode = 'left' | 'right' | 'move'

export function useReversePromptVideo() {
  // ── 文件选择/预览 ──
  const { filePath, fileName, isDragging, pickFile, onDrop, onDragOver, onDragLeave, resolveSrc }
    = useFilePicker({
      dialogTitle: '选择视频',
      filters: [{ name: '视频', extensions: ['mp4', 'mov', 'avi', 'mkv', 'webm', 'm4v'] }],
      onPicked: () => resetResult(),
    })

  // ── 时间轴状态（组件上报 duration/currentTime，选段计算全部走纯函数）──
  const duration = ref(0)
  const currentTime = ref(0)
  const selStart = ref(0)
  const selEnd = ref(0)
  const thumbs = ref<string[]>([]) // dataURL 列表（组件抽帧后回填；空 → 波形回退）

  // ── 提交/轮询状态 ──
  const submitting = ref(false)
  const uploadPercent = ref(0)
  const taskId = ref('')
  const polling = ref(false)
  const statusText = ref('')
  const errorMessage = ref('')
  const segments = ref<PromptSegment[]>([])

  let pollTimer: ReturnType<typeof setInterval> | null = null
  let pollCancelled = false

  const canSubmit = computed(() =>
    !!filePath.value && duration.value > 0 && !submitting.value && !polling.value)
  const rangeText = computed(() =>
    `${fmtSec(selStart.value)} ~ ${fmtSec(selEnd.value)}（${(selEnd.value - selStart.value).toFixed(1)}s）`)

  function resetResult(): void {
    segments.value = []
    errorMessage.value = ''
    taskId.value = ''
    statusText.value = ''
    thumbs.value = []
    duration.value = 0
    selStart.value = 0
    selEnd.value = 0
  }

  /** 组件 loadedmetadata 上报时长 → 初始选区 0~min(30, duration)（对照 set_video L227-234） */
  function setDuration(d: number): void {
    duration.value = Math.max(0, Number(d) || 0)
    const r = initialRange(duration.value)
    selStart.value = r.start
    selEnd.value = r.end
  }

  function setCurrentTime(t: number): void {
    currentTime.value = Number(t) || 0
  }

  /** 组件回填抽帧缩略图（对照 _extract_frames 均匀抽帧 → set_frames L236-243） */
  function frameTimes(): number[] {
    return frameTimestamps(duration.value)
  }
  function setThumbs(list: string[]): void {
    thumbs.value = list
  }

  // ── 拖拽（组件把指针 x 换算成秒后转发到这里；约束全部在纯函数内）──
  function dragTo(mode: DragMode, t: number): void {
    const dur = duration.value
    if (mode === 'left') {
      const r = clampDragLeft(t, selStart.value, selEnd.value, dur)
      selStart.value = r.start; selEnd.value = r.end
    } else if (mode === 'right') {
      const r = clampDragRight(t, selStart.value, selEnd.value, dur)
      selStart.value = r.start; selEnd.value = r.end
    } else {
      const r = clampMove(t, selStart.value, selEnd.value, dur)
      selStart.value = r.start; selEnd.value = r.end
    }
  }

  /** 数值输入改选段（走同一 validateRange 校验口径） */
  function setRange(start: number, end: number): string {
    const err = validateRange(start, end, duration.value)
    if (err) return err
    selStart.value = start
    selEnd.value = end
    return ''
  }

  function hitMode(t: number, thresholdSec = 1.0): DragMode | null {
    const s = selStart.value
    const e = selEnd.value
    if (Math.abs(t - s) <= thresholdSec) return 'left'
    if (Math.abs(t - e) <= thresholdSec) return 'right'
    if (t > s && t < e) return 'move'
    return null
  }

  function stopPolling(): void {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
    polling.value = false
  }

  function cancelPolling(): void {
    pollCancelled = true
    stopPolling()
    statusText.value = '已取消等待'
  }

  /** 轮询 /tasks/unified/{id}（对照 _poll_task_result：3s 间隔、600s 超时） */
  function startPolling(id: string): void {
    stopPolling()
    pollCancelled = false
    polling.value = true
    const startedAt = Date.now()
    let inFlight = false
    const tick = async (): Promise<void> => {
      if (inFlight || pollCancelled) return
      inFlight = true
      try {
        const resp = await window.tintin.server.tasksUnifiedItem(id)
        if (!resp || (resp as Record<string, unknown>).error) {
          statusText.value = pollPhaseText(null, (Date.now() - startedAt) / 1000)
          return // 单次查询失败不终止（对照原版轮询失败静默重试）
        }
        const task = extractTaskObj(resp)
        const status = (task as Record<string, unknown>).status ?? (task as Record<string, unknown>).state
        const info = mapTaskStatus(status, task)
        if (info.phase === 'done') {
          stopPolling()
          const result = (task as Record<string, unknown>).result ?? task
          segments.value = formatPromptResult(result)
          statusText.value = `解析完成（${fmtSec(selStart.value)} ~ ${fmtSec(selEnd.value)} 选段）`
          notify('视频反推完成', `任务 ${id} 解析完成`)
        } else if (info.phase === 'failed') {
          stopPolling()
          errorMessage.value = info.error
          notify('视频反推失败', `任务 ${id}：${info.error}`)
        } else {
          statusText.value = pollPhaseText(
            (task as Record<string, unknown>).progress,
            (Date.now() - startedAt) / 1000,
          )
          if (Date.now() - startedAt > POLL_TIMEOUT_MS) {
            stopPolling()
            errorMessage.value = `轮询超时（${Math.round(POLL_TIMEOUT_MS / 1000)}s）`
            notify('视频反推失败', errorMessage.value)
          }
        }
      } catch (_) {
        // 查询异常保持等待下一拍
      } finally {
        inFlight = false
      }
    }
    void tick()
    pollTimer = setInterval(() => { void tick() }, POLL_INTERVAL_MS)
  }

  /** 提交选段解析（对照 _VideoPromptWorker.run：POST /prompt/video → 分流轮询/同步） */
  async function submit(): Promise<void> {
    if (!filePath.value || !duration.value) return
    const err = validateRange(selStart.value, selEnd.value, duration.value)
    if (err) { errorMessage.value = err; return }
    submitting.value = true
    errorMessage.value = ''
    segments.value = []
    taskId.value = ''
    statusText.value = '正在提交选段…'
    uploadPercent.value = 0
    try {
      // start/end 两位小数随提交，服务端按时间窗解析（禁止本地裁切语义）
      const res = await window.tintin.server.promptVideo({
        file: { path: filePath.value },
        start_sec: rounded2(selStart.value),
        end_sec: rounded2(selEnd.value),
      }, (p: number) => { uploadPercent.value = Math.round(p) })
      if (res === null || res === undefined) throw new Error('服务端不可达（OFFLINE）')
      if ((res as Record<string, unknown>).error) {
        throw new Error(String((res as Record<string, unknown>).error))
      }
      const parsed = parsePromptVideoResponse(res)
      if (parsed.taskId) {
        taskId.value = parsed.taskId
        statusText.value = `任务已提交：${parsed.taskId}`
        startPolling(parsed.taskId)
      } else {
        // 同步兼容模式：无 task_id 直接是结果（对照 L438-447 分支）
        segments.value = formatPromptResult(parsed.sync)
        statusText.value = '解析完成'
      }
    } catch (e) {
      errorMessage.value = e instanceof Error ? e.message : String(e)
      notify('视频反推失败', errorMessage.value)
    } finally {
      submitting.value = false
    }
  }

  onUnmounted(() => { pollCancelled = true; stopPolling() })

  return {
    // 文件
    filePath, fileName, isDragging, pickFile, onDrop, onDragOver, onDragLeave, resolveSrc,
    // 时间轴
    duration, currentTime, selStart, selEnd, thumbs, rangeText, MAX_WINDOW_SEC,
    setDuration, setCurrentTime, dragTo, setRange, hitMode, frameTimes, setThumbs,
    // 提交/轮询/结果
    submitting, uploadPercent, taskId, polling, statusText, errorMessage, segments, canSubmit,
    submit, cancelPolling,
  }
}
