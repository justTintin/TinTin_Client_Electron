// ═══════════════════════════════════════════════════════════════
// useVsrRemoval — 字幕/水印去除·业务编排 composable（M4 移植）
// 职责：框选状态与选区管理（新增/删除/激活/用途切换规范化）→
//       sub_areas 编组（vsrQuadLogic 纯函数）→ 提交 /vsr/remove →
//       轮询（useServerTask 复用）→ 主动取消（DELETE /tasks/{id}）。
// 对照原客户端 gui/subtitle_removal_page_v14.py：
//   · 模式/用途切换 L1025-1047、选区管理 L1059-1131
//   · 提交链路 start_removal/_start_remote_removal L1252-1345
//   · 取消 stop_removal L1347-1352 + worker.stop L103-114（尽力 DELETE）
//   · 取消终态文案 on_worker_finished L1388「已被用户终止。」
// 组件层只做绘制与事件转发（IRON-06 分层）。
// ═══════════════════════════════════════════════════════════════

import { computed, ref, watch } from 'vue'
import { useServerTask } from './useServerTask'
import { readCacheDir } from './useSettingsConfig'
import { joinDefaultPath } from './settingsIntegrationLogic'
import { clientError } from '../utils/clientLog'

function notify(title: string, body: string): void {
  try { window.tintin?.shell?.showNotification?.(title, body) } catch (_) {}
}
import {
  type Quad,
  type VsrFrameSize,
  type VsrPurpose,
  CANCELLED_STATUS_TEXT,
  buildVsrFields,
  canDeleteBox,
  defaultNewQuad,
  normalizeQuadsForPurpose,
  quadAabb,
  shouldCancelServerTask,
  toSubmitError,
  outputPathToUrl,
} from './vsrQuadLogic'

/** 使用模式：智能识别（服务端自动检测）/ 标注选区（对照 mode_switch L1025-1031） */
export type VsrMode = 'smart' | 'select'

export function useVsrRemoval() {
  // ── 模式与用途 ──
  const mode = ref<VsrMode>('select')
  const purpose = ref<VsrPurpose>('subtitle')
  const watermarkText = ref('')

  // ── 选区状态（帧像素坐标，顺时针四点）──
  const boxes = ref<Quad[]>([])
  const activeIndex = ref(-1)
  const frameSize = ref<VsrFrameSize>({ w: 0, h: 0 })

  // 去水印允许旋转四边形；去字幕仅轴对齐矩形（对照 allow_rotation L284/L1038-1042）
  const allowRotation = computed(() => purpose.value === 'watermark')
  const isSmart = computed(() => mode.value === 'smart')

  // ── 任务状态机（上传进度 + 2s 轮询 + 终态通知；getter 对象使标题随用途切换）──
  // extractResultUrl（2026-09-07）：/vsr/remove 契约不回 result_url，仅回 result.output_path
  // （服务端本地路径）；output 目录静态挂载在 /output/ 下，映射为 /output/vsr/xxx.mp4 下载。
  const task = useServerTask({
    get successTitle() {
      return purpose.value === 'watermark' ? '去水印完成' : '去字幕完成'
    },
    get failTitle() {
      return purpose.value === 'watermark' ? '去水印失败' : '去字幕失败'
    },
    getSuccessBody: () => fileName.value || '',
    extractResultUrl: (data) => outputPathToUrl(String(data.result?.output_path || '')),
  })
  const { status, progress, errorMsg, resultUrl, resultPath, isProcessing, uploadPercent } = task

  // 取消态（不与 failed 混淆；文案对齐原客户端 L1388）
  const cancelled = ref(false)
  const filePath = ref('')
  const fileName = ref('')

  const isSelectMode = computed(() => !isSmart.value)

  // ── 服务端地址（结果相对路径拼绝对 URL 供展示/下载/复制；对齐 useAudioGen 口径）──
  const serverUrl = ref('')
  async function ensureServerUrl(): Promise<string> {
    if (serverUrl.value) return serverUrl.value
    try {
      const ping = await (window as any).tintin?.env?.serverPing?.()
      serverUrl.value = String(ping?.url || '')
    } catch (_) { /* 预览环境无 env 桥 → 空串 */ }
    return serverUrl.value
  }
  /** 相对路径 → 绝对 URL（http 原样；无 serverUrl 时保持相对） */
  function toAbsolute(url: string): string {
    const u = String(url || '')
    if (!u || /^https?:\/\//i.test(u)) return u
    return serverUrl.value ? serverUrl.value.replace(/\/$/, '') + u : u
  }
  /** 结果可访问 URL（组件展示/复制用；resultUrl 本身保持服务端返回形态） */
  const resultFullUrl = computed(() => toAbsolute(resultUrl.value))

  /** 标注模式须至少一个选区；智能模式仅要求文件（对照 canStart 语义 L1258-1262） */
  const canStart = computed(() => {
    if (!filePath.value || isProcessing.value) return false
    return isSmart.value || boxes.value.length > 0
  })

  // ── 文件（组件经 useFilePicker 转发）──
  function setFile(path: string): void {
    filePath.value = path
    fileName.value = path.split(/[\\/]/).pop() || path
  }

  /** 预览帧尺寸上报（预览图 natural 尺寸 = 帧坐标系） */
  function setFrameSize(w: number, h: number): void {
    frameSize.value = { w, h }
  }

  function resetBoxes(): void {
    boxes.value = []
    activeIndex.value = -1
  }

  // ── 选区管理（对照 _add_box/_delete_box/_on_box_list_row_changed）──
  function addBox(): boolean {
    if (isProcessing.value || frameSize.value.w <= 0) return false
    const prev = boxes.value.length > 0 ? boxes.value[boxes.value.length - 1] : null
    boxes.value = [...boxes.value, defaultNewQuad(prev, frameSize.value)]
    activeIndex.value = boxes.value.length - 1
    return true
  }

  /** 删除激活框（≤1 个时禁止删除，对照 _delete_box L1124） */
  function deleteActiveBox(): boolean {
    if (isProcessing.value || !canDeleteBox(boxes.value.length)) return false
    if (activeIndex.value < 0 || activeIndex.value >= boxes.value.length) return false
    const next = boxes.value.slice()
    next.splice(activeIndex.value, 1)
    boxes.value = next
    activeIndex.value = Math.min(activeIndex.value, next.length - 1)
    return true
  }

  function setActiveIndex(idx: number): void {
    if (idx >= 0 && idx < boxes.value.length) activeIndex.value = idx
  }

  /** 拖拽回写激活框四点（组件事件层转发） */
  function updateActiveQuad(quad: Quad): void {
    if (activeIndex.value < 0 || activeIndex.value >= boxes.value.length) return
    const next = boxes.value.slice()
    next[activeIndex.value] = quad
    boxes.value = next
  }

  /** 用途切换：去字幕时把已有四边形规范为轴对齐矩形（对照 _on_purpose_changed L1037-1047） */
  function setPurpose(p: VsrPurpose): void {
    if (purpose.value === p) return
    purpose.value = p
    if (!allowRotation.value) boxes.value = normalizeQuadsForPurpose(boxes.value, 'subtitle')
  }

  function setMode(m: VsrMode): void {
    mode.value = m
  }

  /** 激活框外接框描述（列表展示，对照 _update_box_list_widget L1059-1067） */
  function boxLabel(quad: Quad): string {
    const [x, y, w, h] = quadAabb(quad)
    return `X=${Math.round(x)}, Y=${Math.round(y)}, W=${Math.round(w)}, H=${Math.round(h)}`
  }

  // 用途切换到去字幕时框被规范化，组件深度监听 boxes 重绘即可

  // ── 提交（对照 start_removal/_start_remote_removal L1252-1345）──
  async function submit(): Promise<void> {
    const built = buildVsrFields({
      videoPath: filePath.value,
      isSmart: isSmart.value,
      purpose: purpose.value,
      watermarkText: watermarkText.value,
      boxes: boxes.value,
      frame: frameSize.value,
    })
    if (!built.ok) {
      // 参数校验失败：内联提示（对照原版 QMessageBox.warning「参数错误」口径），不进入任务态
      task.errorMsg.value = built.error
      return
    }
    cancelled.value = false
    task.begin()
    try {
      const res = (await window.tintin.server.vsrRemove(built.fields, task.setUpload)) as
        | { task_id?: string }
        | null
      if (!res || !res.task_id) throw toSubmitError(res)
      task.startPolling(res.task_id)
    } catch (err) {
      task.failWith(err)
    }
  }

  // ── 主动取消（对照 stop_removal L1347-1352 + worker.stop L103-114：
  //     尽力 DELETE /tasks/{task_id}，不等响应；终态文案「已被用户终止。」）──
  async function cancel(): Promise<void> {
    if (!isProcessing.value) return
    const id = task.taskId.value
    task.stopPolling()
    cancelled.value = true
    isProcessing.value = false
    status.value = 'failed'
    if (shouldCancelServerTask(id)) {
      // best-effort：失败静默（原版 catch RequestException: pass）
      try { await window.tintin.server.delete(`/tasks/${id}`) } catch (_) { /* 尽力取消 */ }
    }
  }

  // ── 结果自动落盘（2026-09-07 用户裁决：对齐原客户端 RemoteVSRWorkerV14 L208-251——
  //     轮询完成即自动下载，不问用户；保存到原视频同目录 {原名}_no_sub.mp4（L1316-1322）；
  //     失败降级为手动通道（按钮回退「下载视频」））──
  const autoSaving = ref(false)
  async function autoDownload(): Promise<void> {
    const url = resultUrl.value
    if (!url || autoSaving.value || resultPath.value) return
    autoSaving.value = true
    try {
      await ensureServerUrl()
      const dir = filePath.value.replace(/[\\/][^\\/]+$/, '')
      const base = fileName.value.replace(/\.[^.]+$/, '')
      const savePath = `${dir}/${base}_no_sub.mp4`
      const saved = await window.tintin.server.downloadResult(toAbsolute(url), savePath)
      if (!saved) throw new Error('下载失败（服务端离线或网络异常）')
      resultPath.value = String(saved)
      notify('已保存', String(saved))
    } catch (err) {
      clientError('subtitle-removal', '自动保存失败', err)
      notify('自动保存失败', '可点击「下载视频」手动选择位置保存')
    } finally {
      autoSaving.value = false
    }
  }
  watch(
    () => status.value === 'done' && !!resultUrl.value && !resultPath.value,
    (need) => { if (need) void autoDownload() },
  )

  /** 打开结果所在目录（2026-09-07 用户裁决：自动落盘后按钮改为「打开目录」） */
  function openResultDir(): void {
    if (!resultPath.value) return
    try { window.tintin.shell.revealInFolder(resultPath.value) } catch (_) { /* 无壳环境静默 */ }
  }

  // ── 结果下载（手动通道，自动保存失败时按钮回退到此；2026-09-07 修复跨域 <a download> 无效）──
  const downloading = ref(false)
  async function downloadResult(): Promise<void> {
    const url = resultUrl.value
    if (!url || downloading.value) return
    downloading.value = true
    try {
      const defaultName = fileName.value
        ? fileName.value.replace(/\.[^.]+$/, '') + '_no_sub.mp4'
        : 'result.mp4'
      await ensureServerUrl()
      // 默认保存到缓存目录（local.cacheDir；未配置则系统默认位置，对齐原 aigen L1044）
      const cacheDir = await readCacheDir()
      const savePath = await window.tintin.dialog.saveFile({
        title: '下载视频',
        defaultPath: joinDefaultPath(cacheDir, defaultName),
        filters: [{ name: '视频文件', extensions: ['mp4', 'mov', 'webm'] }],
      })
      if (!savePath) return // 用户取消
      const saved = await window.tintin.server.downloadResult(toAbsolute(url), savePath)
      if (!saved) throw new Error('下载失败（服务端离线或网络异常）')
      notify('下载完成', String(saved))
      try { window.tintin.shell.revealInFolder(String(saved)) } catch (_) {}
    } catch (err) {
      clientError('subtitle-removal', '下载失败', err)
      notify('下载失败', err instanceof Error ? err.message : String(err))
    } finally {
      downloading.value = false
    }
  }

  return {
    // 模式/用途/表单
    mode, purpose, watermarkText, setMode, setPurpose,
    // 文件与帧
    filePath, fileName, setFile, frameSize, setFrameSize,
    // 选区
    boxes, activeIndex, allowRotation, isSmart, isSelectMode,
    addBox, deleteActiveBox, setActiveIndex, updateActiveQuad, resetBoxes, boxLabel,
    // 任务
    canStart, cancelled,
    status, progress, errorMsg, resultUrl, resultFullUrl, resultPath, isProcessing, uploadPercent,
    downloadResult, downloading, openResultDir, autoSaving,
    taskId: task.taskId,
    submit, cancel, resetResult: task.resetResult,
    CANCELLED_STATUS_TEXT,
  }
}
