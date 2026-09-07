<script setup lang="ts">
// ═══════════════════════════════════════════════════════════════
// SubtitleRemoval.vue — 视频去水印字幕（M4 quad 框选移植）
// 交互对齐原客户端 gui/subtitle_removal_page_v14.py：
//   · 预览帧上四点框选（InteractivePreviewLabelV14 L254-532）：
//     多框 / 拖拽移动 / 顶点调整 / 旋转（去水印）/ 删除
//   · 每框无独立用途项——用途全局二选一（去字幕=轴对齐矩形 / 去水印=可旋转
//     四边形+水印文字，对照 purpose_combo L1033-1047）
//   · sub_areas 契约入参（编组在 vsrQuadLogic.ts 纯函数，L1294-1309 同源）
//   · 上传进度（对照 _ProgressFileReader L57-72）+ 主动取消（worker.stop L103-114）
// 本组件只做绘制与事件转发；业务编排在 useVsrRemoval.ts。
// ═══════════════════════════════════════════════════════════════
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import TButton from '@/components/common/TButton.vue'
import TSelect, { type SelectOption } from '@/components/common/TSelect.vue'
import { useFilePicker } from '@/composables/useFilePicker'
import {
  type Quad,
  type VsrPurpose,
  applyRotation,
  dragVertex,
  hitTestQuad,
  moveQuad,
  rotateHandleIndex,
  widgetToFrame,
} from '@/composables/vsrQuadLogic'
import { useVsrRemoval, type VsrMode } from '@/composables/useVsrRemoval'
import { drawQuads } from './vsrQuadCanvas'

// ── 业务编排（模式/用途/选区/提交/轮询/取消）──
const vm = useVsrRemoval()
const {
  mode, purpose, watermarkText, setMode, setPurpose,
  boxes, activeIndex, allowRotation, isSmart, isSelectMode,
  addBox, deleteActiveBox, setActiveIndex, updateActiveQuad, resetBoxes, boxLabel,
  canStart, cancelled, status, progress, errorMsg, resultUrl, resultFullUrl, resultPath, isProcessing, uploadPercent,
  submit, cancel, resetResult, setFrameSize, setFile,
  // 2026-09-07 用户裁决：完成后自动保存到原视频同目录（对齐原客户端），
  // 按钮变「打开目录」；自动保存失败时回退手动「下载视频」
  downloadResult, downloading, openResultDir, autoSaving,
} = vm

/** 复制结果地址（不点下载也可自行取用；仿 AudioGen BGM 的 URL 展示口径） */
const urlCopied = ref(false)
async function copyResultUrl(): Promise<void> {
  if (!resultFullUrl.value) return
  try {
    await navigator.clipboard.writeText(resultFullUrl.value)
    urlCopied.value = true
    setTimeout(() => { urlCopied.value = false }, 1500)
  } catch (_) { /* 副本失败静默 */ }
}

// ── 模式/用途选项 ──
const modeOptions: SelectOption[] = [
  { label: '标注选区（在预览帧上框选）', value: 'select' },
  { label: '智能识别（服务端自动检测）', value: 'smart' },
]
const purposeOptions: SelectOption[] = [
  { label: '去字幕（轴对齐矩形）', value: 'subtitle' },
  { label: '去水印（可旋转四边形）', value: 'watermark' },
]
function onModeChange(v: string | number) { setMode(v as VsrMode) }
function onPurposeChange(v: string | number) { setPurpose(v as VsrPurpose) }

// ── 文件选择 + 预览帧抽取 ──
const framePath = ref('')
// 2026-09-06 用户要求：界面仅保留「抓帧预览 + 一个拖拽把手」，删除上方可见播放器。
// 隐藏 <video> 仅作为逐帧 seek 的抓帧源（无可见播放控件）。
const previewVideo = ref<HTMLVideoElement | null>(null)
const durationS = ref(0)
const currentT = ref(0)
const fps = ref(0) // 帧率（ffprobe 探测；>0 时把手按帧刻度细分，拖拽对齐到帧）

/** 重置框选预览：探测帧率（把手按帧刻度细分），清空选区与结果，等待预览视频按当前帧抓帧 */
async function extractPreviewFrame(path: string): Promise<void> {
  resetBoxes()
  framePath.value = ''
  currentT.value = 0
  resetResult()
  fps.value = 0
  try {
    const info = await window.tintin.ffmpeg.probe(path)
    fps.value = Number(info?.fps) || 0
    if (info?.duration) durationS.value = info.duration
  } catch (e) {
    fps.value = 0
  }
}

// ── 抓帧源视频事件（loadedmetadata → 时长；loadeddata → 首帧；seeked → 当前帧）──
function onPreviewLoaded(e: Event): void {
  durationS.value = (e.target as HTMLVideoElement).duration || 0
}
function onPreviewLoadedData(e: Event): void {
  void captureFrameFromVideo(e.target as HTMLVideoElement)
}
function onPreviewSeeked(e: Event): void {
  void captureFrameFromVideo(e.target as HTMLVideoElement)
}

/** 把预览视频当前帧绘制为 dataURL 作为框选帧（分辨率 = 视频真实分辨率，框坐标跨帧一致） */
async function captureFrameFromVideo(v: HTMLVideoElement): Promise<void> {
  if (!v || !v.videoWidth || !v.videoHeight) return
  try {
    const c = document.createElement('canvas')
    c.width = v.videoWidth
    c.height = v.videoHeight
    const ctx = c.getContext('2d')
    if (!ctx) return
    ctx.drawImage(v, 0, 0, c.width, c.height)
    framePath.value = c.toDataURL('image/jpeg', 0.85)
    await nextTick()
    syncCanvas()
  } catch (err) {
    console.warn('[subtitle-removal] 抓取当前帧失败:', err)
  }
}

// ── 时间轴把手：拖拽把手 → 逐帧 seek 预览视频（框选随帧更新）──
const scrubEl = ref<HTMLElement | null>(null)
// 拖拽态用 ref：模板需要它切换把手 grabbing 光标
const scrubbing = ref(false)
function seekToTime(t: number): void {
  const v = previewVideo.value
  if (!v || !Number.isFinite(t)) return
  // 按帧量化：把任意时间对齐到最接近的帧（fps>0 时生效），实现逐帧拖拽
  let target = t
  if (fps.value > 0) target = Math.round(t * fps.value) / fps.value
  const clamped = Math.max(0, Math.min(target, durationS.value || 0))
  v.currentTime = clamped
  currentT.value = clamped
}
function scrubRatio(clientX: number): number {
  const el = scrubEl.value
  if (!el || !durationS.value) return 0
  const rect = el.getBoundingClientRect()
  return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
}
function scrubDown(e: PointerEvent): void {
  if (!durationS.value) return
  scrubbing.value = true
  seekToTime(scrubRatio(e.clientX) * durationS.value)
}
function scrubMove(e: PointerEvent): void {
  if (!scrubbing.value) return
  seekToTime(scrubRatio(e.clientX) * durationS.value)
}
function scrubUp(): void {
  scrubbing.value = false
}
const scrubPct = computed(() =>
  durationS.value ? `${(currentT.value / durationS.value) * 100}%` : '0%')
function fmtTime(s: number): string {
  if (!Number.isFinite(s) || s < 0) s = 0
  const m = Math.floor(s / 60)
  const sec = s - m * 60
  return `${String(m).padStart(2, '0')}:${sec.toFixed(2).padStart(5, '0')}`
}

// ── 帧刻度细分（fps>0 时把手按帧间隔显示刻度线，拖拽对齐到帧）──
const totalFrames = computed(() =>
  fps.value > 0 ? Math.max(0, Math.round(durationS.value * fps.value)) : 0)
const frameIdx = computed(() =>
  fps.value > 0 ? Math.max(0, Math.floor(currentT.value * fps.value)) : -1)
/** 刻度步长（帧）：控制在约 32 条以内，并归整到友好步长（1/2/5×10^k） */
const tickStep = computed(() => {
  const total = totalFrames.value
  if (total <= 0) return 0
  const step = Math.max(1, Math.ceil(total / 32))
  const mag = Math.pow(10, Math.floor(Math.log10(step)))
  const norm = step / mag
  const nice = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10
  return nice * mag
})
const tickList = computed(() => {
  const step = tickStep.value
  const total = totalFrames.value
  if (step <= 0 || total <= 0) return [] as number[]
  const out: number[] = []
  for (let f = 0; f <= total; f += step) out.push(f)
  return out
})
const frameTickPct = (f: number) =>
  totalFrames.value ? `${(f / totalFrames.value) * 100}%` : '0%'

const { filePath: srcPath, fileName, isDragging, pickFile, onDrop, onDragOver, onDragLeave, resolveSrc } =
  useFilePicker({
    dialogTitle: '选择视频',
    filters: [{ name: '视频', extensions: ['mp4', 'mov', 'webm', 'mkv', 'avi'] }],
    onPicked: (path) => { setFile(path); void extractPreviewFrame(path) },
  })

// ── 画布与坐标映射（帧像素 = 预览图 natural 尺寸）──
const canvasRef = ref<HTMLCanvasElement | null>(null)
const imgRef = ref<HTMLImageElement | null>(null)
let resizeObserver: ResizeObserver | null = null

function displayMapping() {
  const canvas = canvasRef.value
  if (!canvas) return null
  return { w: canvas.width, h: canvas.height, offsetX: 0, offsetY: 0 }
}
function frameSizeNow() {
  const img = imgRef.value
  if (!img || !img.naturalWidth) return null
  return { w: img.naturalWidth, h: img.naturalHeight }
}

function onImgLoad(): void {
  const img = imgRef.value
  if (img) setFrameSize(img.naturalWidth, img.naturalHeight)
  syncCanvas()
  observeResize()
}

function syncCanvas(): void {
  const img = imgRef.value
  const canvas = canvasRef.value
  if (!img || !canvas) return
  canvas.width = img.clientWidth
  canvas.height = img.clientHeight
  redraw()
}

function observeResize(): void {
  const img = imgRef.value
  if (!img || resizeObserver || typeof ResizeObserver === 'undefined') return
  resizeObserver = new ResizeObserver(() => syncCanvas())
  resizeObserver.observe(img)
}
onBeforeUnmount(() => { resizeObserver?.disconnect(); resizeObserver = null })

/** 重绘全部选区（拖拽中绘制实时框） */
function redraw(): void {
  const canvas = canvasRef.value
  const ctx = canvas?.getContext('2d')
  const display = displayMapping()
  const frame = frameSizeNow()
  if (!canvas || !ctx || !display || !frame) return
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  if (!isSelectMode.value) return
  drawQuads(ctx, {
    boxes: boxes.value,
    activeIndex: activeIndex.value,
    display,
    frame,
    allowRotation: allowRotation.value,
    draggingQuad: draggingQuad.value,
  })
}

watch([boxes, activeIndex, isSelectMode, framePath], redraw, { deep: true })

// ── 拖拽状态（绘制层临时态；提交数据仍以 boxes 为准）──
type DragMode = null | 'move' | 'rotate' | `vertex-${number}`
const dragMode = ref<DragMode>(null)
let dragStartQuad: Quad | null = null
let dragStartWidget: { x: number; y: number } | null = null
let rotateStartAngle = 0
const draggingQuad = ref<Quad | null>(null)
const hoverHandle = ref('')

function relPos(e: MouseEvent): { x: number; y: number } {
  const rect = canvasRef.value!.getBoundingClientRect()
  return { x: e.clientX - rect.left, y: e.clientY - rect.top }
}

function onDown(e: MouseEvent): void {
  if (!framePath.value || isProcessing.value || isSmart.value) return
  const display = displayMapping()
  const frame = frameSizeNow()
  if (!display || !frame) return
  const { x: mx, y: my } = relPos(e)
  const hit = hitTestQuad({
    mx, my, boxes: boxes.value, activeIndex: activeIndex.value,
    display, frame, allowRotation: allowRotation.value,
  })
  if (!hit) return // 原版空白按下无动作（不新增框，见 _add_box 按钮语义）
  if (hit.index !== activeIndex.value) setActiveIndex(hit.index)
  dragStartQuad = boxes.value[hit.index].map((p) => [p[0], p[1]] as [number, number])
  dragStartWidget = { x: mx, y: my }
  const handle = hit.handle as 'move' | `vertex-${number}`
  dragMode.value = handle
  // 右下角顶点 = 旋转把手：进入整体旋转模式（对照 mousePressEvent L413-424）
  if (handle.startsWith('vertex-')) {
    const vi = Number(handle.split('-')[1])
    if (vi === rotateHandleIndex(dragStartQuad, allowRotation.value)) {
      dragMode.value = 'rotate'
      const cx = dragStartQuad.reduce((s, p) => s + p[0], 0) / 4
      const cy = dragStartQuad.reduce((s, p) => s + p[1], 0) / 4
      const fpt = widgetToFrame(mx, my, display, frame)
      if (fpt) rotateStartAngle = Math.atan2(fpt.y - cy, fpt.x - cx)
    }
  }
}

function onMove(e: MouseEvent): void {
  if (!framePath.value || isProcessing.value || isSmart.value) return
  const display = displayMapping()
  const frame = frameSizeNow()
  if (!display || !frame) return
  const { x: mx, y: my } = relPos(e)

  // 拖拽中：几何计算全部走 vsrQuadLogic 纯函数（对照 mouseMoveEvent L426-498）
  const mode = dragMode.value
  if (mode !== null && dragStartQuad && dragStartWidget) {
    const curF = widgetToFrame(mx, my, display, frame)
    const startF = widgetToFrame(dragStartWidget.x, dragStartWidget.y, display, frame)
    if (!curF || !startF) return
    if (mode === 'rotate') {
      const cx = dragStartQuad.reduce((s, p) => s + p[0], 0) / 4
      const cy = dragStartQuad.reduce((s, p) => s + p[1], 0) / 4
      const delta = Math.atan2(curF.y - cy, curF.x - cx) - rotateStartAngle
      draggingQuad.value = applyRotation(dragStartQuad, delta, frame)
    } else if (mode === 'move') {
      draggingQuad.value = moveQuad(dragStartQuad, curF.x - startF.x, curF.y - startF.y, frame)
    } else {
      draggingQuad.value = dragVertex(
        dragStartQuad, Number(mode.split('-')[1]), curF.x, curF.y, frame, allowRotation.value,
      )
    }
    redraw()
    return
  }

  // 悬停光标提示（对照 L500-517）
  const hit = hitTestQuad({
    mx, my, boxes: boxes.value, activeIndex: activeIndex.value,
    display, frame, allowRotation: allowRotation.value,
  })
  hoverHandle.value = hit ? hit.handle : ''
}

function onUp(): void {
  if (draggingQuad.value) updateActiveQuad(draggingQuad.value)
  dragMode.value = null
  dragStartQuad = null
  dragStartWidget = null
  draggingQuad.value = null
  redraw()
}

const cursorStyle = computed(() => {
  if (isSmart.value || isProcessing.value) return 'default'
  if (dragMode.value === 'rotate') return 'grabbing'
  if (hoverHandle.value === 'move') return 'move'
  if (hoverHandle.value.startsWith('vertex-')) {
    const quad = boxes.value[activeIndex.value]
    if (!quad) return 'crosshair'
    const vi = Number(hoverHandle.value.split('-')[1])
    if (vi === rotateHandleIndex(quad, allowRotation.value)) return 'grab'
    const cx = quad.reduce((s, p) => s + p[0], 0) / 4
    const cy = quad.reduce((s, p) => s + p[1], 0) / 4
    return (quad[vi][0] - cx) * (quad[vi][1] - cy) >= 0 ? 'nwse-resize' : 'nesw-resize'
  }
  return 'crosshair'
})

// ── 选区列表辅助 ──
function removeBoxAt(i: number): void {
  setActiveIndex(i)
  deleteActiveBox()
}

// ── 提交 / 取消 / 结果 ──
const statusText = computed(() => {
  if (cancelled.value) return vm.CANCELLED_STATUS_TEXT
  switch (status.value) {
    case 'queued':
      return uploadPercent.value < 100 ? `上传中 ${uploadPercent.value}%` : '排队中'
    case 'processing':
      return `处理中 ${progress.value}%`
    case 'done':
      return '已完成'
    case 'failed':
      return '失败'
    default:
      return ''
  }
})

</script>

<template>
  <div class="tool-form">
    <!-- 2026-09-07 用户裁决：整体 1:1 左右分栏——左栏全部为预览区（画面居中），
         右栏集中原来的上传/设置/选区/操作/进度/结果 -->
    <div class="vsr-split">
      <!-- 左栏：预览区（视频抓帧 + 框选图层 + 逐帧时间轴，画面在预览区内居中） -->
      <div class="vsr-preview">
        <div class="frame-stage">
          <!-- 隐藏抓帧源（仅逐帧 seek 用，界面不显示；用户要求只保留一个拖拽控制） -->
          <video
            v-if="srcPath"
            ref="previewVideo"
            class="preview-src"
            :src="resolveSrc(srcPath)"
            preload="auto"
            @loadedmetadata="onPreviewLoaded"
            @loadeddata="onPreviewLoadedData"
            @seeked="onPreviewSeeked"
          />
          <div v-if="framePath" class="frame-wrap">
            <img
              ref="imgRef"
              class="frame-img"
              :src="resolveSrc(framePath)"
              alt="帧预览"
              @load="onImgLoad"
            />
            <canvas
              ref="canvasRef"
              class="frame-canvas"
              :style="{ cursor: cursorStyle }"
              @mousedown="onDown"
              @mousemove="onMove"
              @mouseup="onUp"
              @mouseleave="onUp"
            />
          </div>
          <div v-else class="frame-loading">{{ srcPath ? '等待视频就绪；拖动下方把手到目标帧后，可在此帧上框选' : '先在右侧选择视频，此处将显示预览帧' }}</div>
          <!-- 时间轴把手：拖拽到目标帧（逐帧），当前帧同步到上方预览 -->
          <div
            ref="scrubEl"
            class="frame-scrub"
            :class="{ 'is-disabled': !srcPath, 'is-scrubbing': scrubbing }"
            @pointerdown.prevent="scrubDown"
            @pointermove="scrubMove"
            @pointerup="scrubUp"
            @pointerleave="scrubUp"
          >
            <div class="frame-scrub__track">
              <span
                v-for="(f, i) in tickList"
                :key="i"
                class="frame-scrub__tick"
                :style="{ left: frameTickPct(f) }"
              />
              <div class="frame-scrub__fill" :style="{ width: scrubPct }" />
              <div class="frame-scrub__handle" :style="{ left: scrubPct }" />
            </div>
            <div class="frame-scrub__meta">
              <template v-if="fps > 0">
                <span class="frame-scrub__time">F{{ frameIdx }} / {{ totalFrames }}</span>
                <span class="frame-scrub__dur">{{ fmtTime(currentT) }} · {{ fps.toFixed(0) }}fps</span>
              </template>
              <template v-else>
                <span class="frame-scrub__time">{{ fmtTime(currentT) }}</span>
                <span class="frame-scrub__dur">/ {{ fmtTime(durationS) }}</span>
              </template>
            </div>
          </div>
        </div>
      </div>

      <!-- 右栏：控制区（上传 / 模式用途 / 水印文字 / 选区管理 / 操作 / 进度 / 结果） -->
      <div class="vsr-panel">
        <!-- 视频选择 -->
        <div
          class="dropzone"
          :class="{ 'is-active': isDragging, 'has-file': !!fileName }"
          @click="pickFile"
          @drop.prevent="onDrop"
          @dragover.prevent="onDragOver"
          @dragleave.prevent="onDragLeave"
        >
          <svg v-if="!fileName" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12" />
          </svg>
          <div class="dropzone__text">
            <template v-if="!fileName">
              <span class="dropzone__main">点击选择视频或拖拽到此处</span>
              <span class="dropzone__hint">支持 MP4 / MOV / WEBM / MKV / AVI</span>
            </template>
            <template v-else>
              <span class="dropzone__main">{{ fileName }}</span>
              <span class="dropzone__hint">点击重新选择</span>
            </template>
          </div>
        </div>

        <!-- 模式 / 用途 -->
        <div class="options-row">
          <div class="form-field">
            <label class="form-label">去除模式</label>
            <TSelect
              :model-value="mode"
              :options="modeOptions"
              :disabled="isProcessing"
              @update:model-value="onModeChange"
            />
          </div>
          <div class="form-field">
            <label class="form-label">用途（决定服务端 inpaint 策略）</label>
            <TSelect
              :model-value="purpose"
              :options="purposeOptions"
              :disabled="isProcessing"
              @update:model-value="onPurposeChange"
            />
          </div>
        </div>

        <!-- 水印文字（仅去水印显示，对照 watermark_container L1040） -->
        <div v-if="purpose === 'watermark'" class="form-field">
          <label class="form-label">水印文字（可选，辅助服务端精准定位）</label>
          <input
            v-model="watermarkText"
            type="text"
            class="text-input"
            placeholder="如：片头 LOGO 文字，留空则仅按框选区域移除"
            :disabled="isProcessing"
          />
        </div>

        <!-- 选区管理（标注选区模式；2026-09-07 用户裁决：卡片化统一风格） -->
        <div v-if="fileName && isSelectMode" class="regions-card">
          <div class="regions-card__head">
            <span class="regions-card__title">
              选区管理
              <span class="regions-card__count">{{ boxes.length }}</span>
              <span class="regions-card__hint">可拖拽移动 / 拖顶点调整<template v-if="allowRotation"> / 拖右下角把手旋转</template></span>
            </span>
            <span class="regions-card__actions">
              <button class="mini-btn mini-btn--primary" :disabled="isProcessing || !framePath" @click="addBox">＋ 添加选区</button>
              <button
                class="mini-btn mini-btn--danger"
                :disabled="isProcessing || boxes.length <= 1 || activeIndex < 0"
                @click="deleteActiveBox"
              >删除激活</button>
              <button class="mini-btn mini-btn--ghost" :disabled="isProcessing" @click="resetBoxes">清空</button>
            </span>
          </div>
          <div v-if="boxes.length" class="regions-card__list">
            <span
              v-for="(q, i) in boxes"
              :key="i"
              class="region-chip"
              :class="{ 'is-active': i === activeIndex }"
              @click="setActiveIndex(i)"
            >
              <span class="region-chip__idx">{{ i + 1 }}</span>
              <span class="region-chip__coord">{{ boxLabel(q) }}</span>
              <button
                class="region-chip__close"
                :disabled="isProcessing || boxes.length <= 1"
                title="删除该选区"
                @click.stop="removeBoxAt(i)"
              >×</button>
            </span>
          </div>
          <div v-else class="regions-card__empty">暂无选区，点击右上角「添加选区」开始标注</div>
        </div>

        <!-- 操作区 -->
        <div class="action-row">
          <TButton
            label="开始移除"
            icon="play"
            :disabled="!canStart"
            :loading="isProcessing"
            @click="submit"
          />
          <TButton
            v-if="isProcessing"
            label="终止"
            icon="close"
            variant="danger"
            @click="cancel"
          />
          <span v-if="statusText" class="status-badge" :class="`status-${status}`">{{ statusText }}</span>
        </div>

        <!-- 进度条（处理阶段） -->
        <div v-if="isProcessing" class="progress-bar">
          <div class="progress-bar__fill" :style="{ width: progress + '%' }" />
        </div>

        <!-- 错误提示 -->
        <div v-if="errorMsg" class="error-msg">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
          <span>{{ errorMsg }}</span>
        </div>

        <!-- 结果 -->
        <div v-if="status === 'done'" class="result">
          <div class="result__head">
            <span class="result__title">移除完成</span>
            <!-- 自动落盘后 → 打开目录；未落盘（含自动保存失败回退）→ 手动下载 -->
            <TButton v-if="resultPath" label="打开目录" icon="folder" size="small" @click="openResultDir" />
            <TButton v-else :label="downloading || autoSaving ? '保存中…' : '下载视频'" icon="download" size="small" :loading="downloading || autoSaving" @click="downloadResult" />
          </div>
          <video v-if="resultUrl" class="result-video" :src="resultFullUrl" controls />
          <!-- 本地保存位置（自动落盘后展示；仿 AudioGen BGM 结果文案口径） -->
          <p v-if="resultPath" class="result__save" :title="resultPath">已保存：{{ resultPath }}</p>
          <!-- 结果地址（2026-09-07 用户裁决：像 BGM 一样展示文件 URL，不点下载也可自行下载） -->
          <div v-if="resultFullUrl" class="result__url">
            <span class="result__url-text" :title="resultFullUrl">{{ resultFullUrl }}</span>
            <TButton :label="urlCopied ? '已复制' : '复制'" variant="ghost" size="small" @click="copyResultUrl" />
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.tool-form {
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
}

/* 拖拽上传区（2026-09-07 用户裁决：全程序拖拽上传区高度统一 min-height 120px，
   以智能混剪选择素材原高 ≈80px 基准 +1/2） */
.dropzone {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-height: 120px;
  padding: var(--space-5);
  background: color-mix(in srgb, var(--primary) 6%, var(--surface-container));
  border: 1.5px dashed color-mix(in srgb, var(--primary) 40%, var(--border));
  border-radius: var(--radius-lg);
  color: var(--muted-foreground);
  cursor: pointer;
  transition: border-color var(--duration-fast) var(--easing-default),
    background var(--duration-fast) var(--easing-default);
}
.dropzone:hover,
.dropzone.is-active {
  border-color: var(--primary);
  background: color-mix(in srgb, var(--primary) 12%, var(--surface-container));
}
.dropzone.has-file {
  border-style: solid;
  color: var(--foreground);
}
.dropzone__text {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.dropzone__main {
  font-size: var(--font-size-body);
  font-weight: var(--font-weight-medium);
  color: var(--foreground);
}
.dropzone__hint {
  font-size: var(--font-size-caption);
  color: var(--muted-foreground);
}

/* 模式/用途行 */
.options-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--space-4);
}
.form-field {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.form-label {
  font-size: var(--font-size-caption);
  font-weight: var(--font-weight-medium);
  color: var(--foreground-muted);
}
.text-input {
  width: 100%;
  height: var(--size-input-height);
  padding: 0 var(--space-3);
  background: var(--surface-container);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  color: var(--foreground);
  font-size: var(--font-size-body);
  outline: none;
  transition: border-color var(--duration-fast) var(--easing-default),
    box-shadow var(--duration-fast) var(--easing-default);
}
.text-input::placeholder {
  color: var(--muted-foreground);
}
.text-input:focus {
  border-color: var(--primary);
  box-shadow: 0 0 0 2px var(--ring);
}
.text-input:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* 预览 + 控制：左右两栏（2026-09-07 用户裁决：左栏全部为预览区，右栏集中控制，1:1 均分） */
.vsr-split {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: var(--space-4);
  /* 2026-09-07 用户裁决：预览区定高 800px（不再随右栏拉伸）——
     视频加载后整体可见，时间轴不用滚动即可拖拽 */
  align-items: start;
}
.vsr-preview {
  min-width: 0;
  min-height: 0;
  /* 2026-09-07 用户裁决：自适应上限——默认 800px；窗口不够高时收缩到可视区，
     保证视频 + 时间轴不用滚动即可完整拖拽（
     顶部固定占用 ≈ title-bar 36 + app-header 64 + 页面 padding 48 + 工具栏 66 ≈ 214px，留 6px 余量） */
  --vsr-h: min(800px, calc(100vh - 220px));
  height: var(--vsr-h);
  display: flex;
  flex-direction: column;
}
.vsr-panel {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}
/* 隐藏抓帧源视频（须参与渲染否则 drawImage 取帧会空白：不可 display:none，用移出视口方式） */
.preview-src {
  position: fixed;
  left: -9999px;
  top: 0;
  width: 1px;
  height: 1px;
  opacity: 0;
  pointer-events: none;
}
/* 时间轴把手（逐帧拖拽；2026-09-07 用户裁决：做成明显把手形态，加大热区好拖） */
.frame-scrub {
  padding: var(--space-2) var(--space-2) var(--space-3);
  cursor: grab;
  user-select: none;
  touch-action: none;
}
.frame-scrub.is-scrubbing {
  cursor: grabbing;
}
.frame-scrub.is-scrubbing .frame-scrub__handle {
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--primary) 22%, transparent);
}
.frame-scrub.is-disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.frame-scrub__track {
  position: relative;
  height: 22px;
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--foreground) 8%, var(--surface-container-high));
  border: 1px solid var(--border-subtle);
}
.frame-scrub__tick {
  position: absolute;
  top: 5px;
  bottom: 5px;
  width: 1px;
  background: color-mix(in srgb, var(--foreground) 22%, transparent);
  pointer-events: none;
}
.frame-scrub__fill {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--primary) 30%, transparent);
}
.frame-scrub__handle {
  position: absolute;
  top: 50%;
  width: 18px;
  height: 28px;
  margin-left: -9px;
  transform: translateY(-50%);
  border-radius: 6px;
  background: var(--surface);
  border: 2px solid var(--primary);
  box-sizing: border-box;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.25);
  /* 抓握纹理：竖向棱纹，看起来可拖 */
  background-image: repeating-linear-gradient(
    to right,
    transparent 0 3px,
    color-mix(in srgb, var(--primary) 45%, transparent) 3px 5px
  );
  background-position: center;
  background-size: 9px 12px;
  background-repeat: no-repeat;
}
.frame-scrub__meta {
  display: flex;
  align-items: baseline;
  gap: 4px;
  margin-top: 3px;
  font-size: 11px;
  color: var(--muted-foreground);
  font-variant-numeric: tabular-nums;
}
.frame-scrub__time {
  color: var(--foreground);
}

/* 帧预览与框选画布 */
.frame-stage {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  /* 2026-09-07 用户裁决：帧 + 时间轴整组在预览区内垂直居中；
     帧本身由 .frame-wrap 的 align-self 水平居中 */
  justify-content: center;
  background: var(--surface-container);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-lg);
  padding: var(--space-3);
}
.frame-loading {
  padding: var(--space-8);
  text-align: center;
  font-size: var(--font-size-caption);
  color: var(--muted-foreground);
}
.frame-wrap {
  position: relative;
  /* 画面尺寸规则（2026-09-07 用户裁决）：等比缩放，横屏不超预览区宽度、
     竖屏不超预览区高度，边距由 .frame-stage 的 padding 提供 */
  max-width: 100%;
  align-self: center;
  line-height: 0;
}
.frame-img {
  /* 竖屏时高度上限 = 预览区定高 − 时间轴与内边距（约 96px），宽度随等比自动收 */
  max-width: 100%;
  max-height: calc(var(--vsr-h) - 96px);
  border-radius: var(--radius-md);
  display: block;
}
.frame-canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}

/* 选区管理卡片（2026-09-07 用户裁决：与整体卡片风格统一） */
.regions-card {
  padding: var(--space-3) var(--space-4);
  background: var(--card);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-lg);
}
.regions-card__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  flex-wrap: wrap;
  padding-bottom: var(--space-2);
}
.regions-card__title {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--font-size-caption);
  font-weight: var(--font-weight-semibold);
  color: var(--foreground);
}
.regions-card__count {
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-full);
  background: color-mix(in srgb, var(--primary) 14%, transparent);
  color: var(--primary);
  font-size: 11px;
  font-weight: var(--font-weight-semibold);
  font-variant-numeric: tabular-nums;
}
.regions-card__hint {
  font-weight: var(--font-weight-regular);
  color: var(--muted-foreground);
}
.regions-card__actions {
  display: inline-flex;
  gap: var(--space-2);
}
.regions-card__list {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  padding-top: var(--space-2);
  border-top: 1px dashed var(--border-subtle);
}
.regions-card__empty {
  padding: var(--space-3) 0 var(--space-2);
  font-size: var(--font-size-caption);
  color: var(--muted-foreground);
  text-align: center;
}
/* 区块内小按钮（添加/删除/清空统一形态） */
.mini-btn {
  height: 26px;
  padding: 0 10px;
  font-size: 12px;
  font-weight: var(--font-weight-medium);
  border-radius: var(--radius-md);
  border: 1px solid var(--border);
  background: var(--surface-container);
  color: var(--foreground);
  cursor: pointer;
  transition: border-color var(--duration-fast) var(--easing-default),
    background var(--duration-fast) var(--easing-default),
    color var(--duration-fast) var(--easing-default);
}
.mini-btn:hover:not(:disabled) {
  border-color: var(--primary);
  color: var(--primary);
}
.mini-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.mini-btn--primary {
  border-color: color-mix(in srgb, var(--primary) 40%, transparent);
  background: color-mix(in srgb, var(--primary) 10%, var(--surface-container));
  color: var(--primary);
}
.mini-btn--primary:hover:not(:disabled) {
  background: color-mix(in srgb, var(--primary) 18%, var(--surface-container));
}
.mini-btn--danger {
  color: var(--error);
}
.mini-btn--danger:hover:not(:disabled) {
  border-color: var(--error);
  color: var(--error);
  background: color-mix(in srgb, var(--error) 8%, var(--surface-container));
}
.mini-btn--ghost {
  background: transparent;
  color: var(--muted-foreground);
}
.mini-btn--ghost:hover:not(:disabled) {
  color: var(--foreground);
  border-color: var(--foreground-muted);
}
.region-chip {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  padding: 3px 6px 3px 4px;
  background: var(--surface-container);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  font-size: var(--font-size-caption);
  color: var(--foreground);
  cursor: pointer;
  transition: border-color var(--duration-fast) var(--easing-default),
    background var(--duration-fast) var(--easing-default),
    box-shadow var(--duration-fast) var(--easing-default);
}
.region-chip:hover {
  border-color: color-mix(in srgb, var(--primary) 50%, var(--border));
}
.region-chip.is-active {
  border-color: var(--primary);
  background: color-mix(in srgb, var(--primary) 8%, var(--surface-container));
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--primary) 16%, transparent);
}
.region-chip__idx {
  min-width: 18px;
  height: 18px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-sm);
  background: var(--surface-container-high);
  color: var(--muted-foreground);
  font-size: 11px;
  font-weight: var(--font-weight-semibold);
  font-variant-numeric: tabular-nums;
}
.region-chip.is-active .region-chip__idx {
  background: var(--primary);
  color: var(--primary-foreground);
}
.region-chip__coord {
  font-family: var(--font-mono);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.region-chip__close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  color: var(--muted-foreground);
  border-radius: var(--radius-full);
  font-size: 14px;
  line-height: 1;
  transition: color var(--duration-fast) var(--easing-default),
    background var(--duration-fast) var(--easing-default);
}
.region-chip__close:hover:not(:disabled) {
  color: var(--error);
  background: color-mix(in srgb, var(--error) 12%, transparent);
}
.region-chip__close:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

/* 操作区 */
.action-row {
  display: flex;
  align-items: center;
  gap: var(--space-4);
}
.status-badge {
  margin-left: auto;
  padding: 2px var(--space-3);
  font-size: var(--font-size-caption);
  font-weight: var(--font-weight-medium);
  border-radius: var(--radius-full);
  background: var(--surface-container-high);
  color: var(--foreground-muted);
}
.status-badge.status-processing {
  color: var(--info);
  background: rgba(59, 130, 246, 0.15);
}
.status-badge.status-done {
  color: var(--success);
  background: rgba(16, 185, 129, 0.15);
}
.status-badge.status-failed {
  color: var(--error);
  background: rgba(239, 68, 68, 0.15);
}

/* 进度条 */
.progress-bar {
  height: 6px;
  background: var(--surface-container);
  border-radius: var(--radius-full);
  overflow: hidden;
}
.progress-bar__fill {
  height: 100%;
  background: var(--primary);
  border-radius: var(--radius-full);
  transition: width var(--duration-slow) var(--easing-default);
}

/* 错误提示 */
.error-msg {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4);
  background: rgba(239, 68, 68, 0.1);
  border: 1px solid rgba(239, 68, 68, 0.3);
  border-radius: var(--radius-md);
  color: var(--error);
  font-size: var(--font-size-caption);
}

/* 结果区 */
.result {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-4);
  background: var(--surface-container);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-lg);
}
.result__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.result__title {
  font-size: var(--font-size-lead);
  font-weight: var(--font-weight-semibold);
  color: var(--foreground);
}
.result__save {
  margin: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  direction: rtl;
  text-align: left;
  font-size: var(--font-size-caption);
  color: var(--foreground-muted);
}
.result__url {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}
.result__url-text {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  direction: rtl;             /* 长路径尾部省略，保留文件名可读 */
  text-align: left;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--foreground-muted);
}
.result-video {
  width: 100%;
  max-height: 360px;
  border-radius: var(--radius-md);
  background: #000;
}
</style>
