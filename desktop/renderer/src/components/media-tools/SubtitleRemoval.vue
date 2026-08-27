<script setup lang="ts">
// ═══════════════════════════════════════════════════════════════
// SubtitleRemoval.vue — 视频去水印字幕
// 上传视频 → 在帧预览上框选需移除区域（矩形）→ 可选水印文字
// → POST /vsr/remove → 轮询任务 → 下载 MP4
// ═══════════════════════════════════════════════════════════════
import { ref, computed, nextTick } from 'vue'
import TButton from '@/components/common/TButton.vue'
import { useFilePicker } from '@/composables/useFilePicker'
import { useServerTask } from '@/composables/useServerTask'

/** 选区矩形（基于预览显示像素） */
interface Rect {
  x: number
  y: number
  w: number
  h: number
}

// ── 任务状态机（共享 composable：上传进度 + 轮询 + 终态通知） ──
const task = useServerTask({
  successTitle: '去水印完成',
  failTitle: '去水印失败',
  getSuccessBody: () => fileName.value,
})
const { status, progress, errorMsg, resultUrl, resultPath, isProcessing, uploadPercent } = task

// ── 文件选择 + 拖拽（共享 composable；选中后清选区并抽预览帧） ──
const framePath = ref('')         // 抽取的预览帧路径
const isExtractingFrame = ref(false)
const watermarkText = ref('')     // 可选水印文字
const regions = ref<Rect[]>([])   // 已选区域

async function extractPreviewFrame(path: string): Promise<void> {
  regions.value = []
  framePath.value = ''
  task.resetResult()
  isExtractingFrame.value = true
  try {
    const thumb = await window.tintin.ffmpeg.extractThumb(path, 1, 640)
    framePath.value = thumb
    await nextTick()
    syncCanvas()
  } catch (err) {
    console.warn('[subtitle-removal] 抽取预览帧失败:', err)
  } finally {
    isExtractingFrame.value = false
  }
}

const { filePath, fileName, isDragging, pickFile, onDrop, onDragOver, onDragLeave, resolveSrc } =
  useFilePicker({
    dialogTitle: '选择视频',
    filters: [{ name: '视频', extensions: ['mp4', 'mov', 'webm', 'mkv', 'avi'] }],
    onPicked: (path) => { void extractPreviewFrame(path) },
  })

// ── 框选状态 ──
const canvasRef = ref<HTMLCanvasElement | null>(null)
const imgRef = ref<HTMLImageElement | null>(null)
let drawing = false
let startPt = { x: 0, y: 0 }
let currentRect: Rect | null = null

const canStart = computed(
  () => !!filePath.value && regions.value.length > 0 && !isProcessing.value
)

/** 同步 canvas 尺寸到图片显示尺寸 */
function syncCanvas() {
  const img = imgRef.value
  const canvas = canvasRef.value
  if (!img || !canvas) return
  canvas.width = img.clientWidth
  canvas.height = img.clientHeight
  redraw()
}

/** 重绘所有选区 */
function redraw() {
  const canvas = canvasRef.value
  if (!canvas) return
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  // 已确认的区域
  regions.value.forEach((r, i) => {
    drawRect(ctx, r, 'rgba(109, 93, 252, 0.25)', '#6d5dfc', String(i + 1))
  })
  // 正在绘制的临时矩形
  if (currentRect) {
    drawRect(ctx, currentRect, 'rgba(239, 68, 68, 0.2)', '#ef4444')
  }
}

function drawRect(ctx: CanvasRenderingContext2D, r: Rect, fill: string, stroke: string, label?: string) {
  ctx.fillStyle = fill
  ctx.fillRect(r.x, r.y, r.w, r.h)
  ctx.strokeStyle = stroke
  ctx.lineWidth = 2
  ctx.strokeRect(r.x, r.y, r.w, r.h)
  if (label) {
    ctx.fillStyle = stroke
    ctx.font = '12px sans-serif'
    ctx.fillText(label, r.x + 4, r.y + 14)
  }
}

/** 获取相对 canvas 的坐标 */
function getPos(e: MouseEvent): { x: number; y: number } {
  const canvas = canvasRef.value!
  const rect = canvas.getBoundingClientRect()
  return { x: e.clientX - rect.left, y: e.clientY - rect.top }
}

function onDown(e: MouseEvent) {
  if (!framePath.value || isProcessing.value) return
  const canvas = canvasRef.value
  if (!canvas) return
  drawing = true
  startPt = getPos(e)
  currentRect = { x: startPt.x, y: startPt.y, w: 0, h: 0 }
}

function onMove(e: MouseEvent) {
  if (!drawing) return
  const p = getPos(e)
  const canvas = canvasRef.value!
  currentRect = {
    x: Math.min(startPt.x, p.x),
    y: Math.min(startPt.y, p.y),
    w: Math.abs(p.x - startPt.x),
    h: Math.abs(p.y - startPt.y)
  }
  // 限制在画布内
  currentRect.w = Math.min(currentRect.w, canvas.width - currentRect.x)
  currentRect.h = Math.min(currentRect.h, canvas.height - currentRect.y)
  redraw()
}

function onUp() {
  if (!drawing) return
  drawing = false
  if (currentRect && currentRect.w > 6 && currentRect.h > 6) {
    regions.value.push({ ...currentRect })
  }
  currentRect = null
  redraw()
}

/** 删除某个选区 */
function removeRegion(index: number) {
  regions.value.splice(index, 1)
  redraw()
}

/** 清空选区 */
function clearRegions() {
  regions.value = []
  redraw()
}

/** 提交去水印任务 */
async function startRemove() {
  if (!canStart.value) return
  task.begin()

  // 将显示坐标归一化为 0-1 分数，便于服务端按原分辨率映射
  const canvas = canvasRef.value
  const cw = canvas?.width || 1
  const ch = canvas?.height || 1
  const bboxes = regions.value.map<[number, number, number, number]>((r) => [
    r.x / cw,
    r.y / ch,
    r.w / cw,
    r.h / ch,
  ])

  try {
    const res = await window.tintin.server.vsrRemove({
      video: filePath.value,
      mode: watermarkText.value ? 'both' : 'subtitle',
      bboxes,
    }, task.setUpload)
    if (!res) throw new Error('服务端离线或未返回任务ID')
    task.startPolling(res.task_id)
  } catch (err) {
    task.failWith(err)
  }
}

function downloadResult() {
  if (resultUrl.value) {
    const a = document.createElement('a')
    a.href = resultUrl.value
    a.download = fileName.value
      ? fileName.value.replace(/\.[^.]+$/, '') + '_cleaned.mp4'
      : 'result.mp4'
    document.body.appendChild(a)
    a.click()
    a.remove()
  } else if (resultPath.value) {
    window.tintin.shell.revealInFolder(resultPath.value)
  }
}

const statusText = computed(() => {
  switch (status.value) {
    case 'queued':
      return '排队中'
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
    <!-- 视频选择 -->
    <div
      class="dropzone"
      :class="{ 'is-active': isDragging, 'has-file': !!filePath }"
      @click="pickFile"
      @drop.prevent="onDrop"
      @dragover.prevent="onDragOver"
      @dragleave.prevent="onDragLeave"
    >
      <svg v-if="!filePath" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12" />
      </svg>
      <div class="dropzone__text">
        <template v-if="!filePath">
          <span class="dropzone__main">点击选择视频或拖拽到此处</span>
          <span class="dropzone__hint">支持 MP4 / MOV / WEBM / MKV / AVI</span>
        </template>
        <template v-else>
          <span class="dropzone__main">{{ fileName }}</span>
          <span class="dropzone__hint">点击重新选择</span>
        </template>
      </div>
    </div>

    <!-- 帧预览 + 框选画布 -->
    <div v-if="filePath" class="frame-stage">
      <div v-if="isExtractingFrame" class="frame-loading">正在抽取预览帧…</div>
      <div v-else-if="framePath" class="frame-wrap">
        <img
          ref="imgRef"
          class="frame-img"
          :src="resolveSrc(framePath)"
          alt="帧预览"
          @load="syncCanvas"
        />
        <canvas
          ref="canvasRef"
          class="frame-canvas"
          @mousedown="onDown"
          @mousemove="onMove"
          @mouseup="onUp"
          @mouseleave="onUp"
        />
      </div>
      <div v-else class="frame-loading">预览帧抽取失败，可直接提交（需手动框选）</div>
    </div>

    <!-- 选区列表 -->
    <div v-if="regions.length" class="regions">
      <div class="regions__head">
        <span class="form-label">已选区域（{{ regions.length }}）</span>
        <button class="link-btn" :disabled="isProcessing" @click="clearRegions">清空</button>
      </div>
      <div class="regions__list">
        <span v-for="(r, i) in regions" :key="i" class="region-chip">
          #{{ i + 1 }}
          <button class="region-chip__close" :disabled="isProcessing" @click="removeRegion(i)">×</button>
        </span>
      </div>
    </div>

    <!-- 水印文字 -->
    <div class="form-field">
      <label class="form-label">水印文字（可选，辅助检测）</label>
      <input
        v-model="watermarkText"
        type="text"
        class="text-input"
        placeholder="如：片头 LOGO 文字，留空则仅按框选区域移除"
        :disabled="isProcessing"
      />
    </div>

    <!-- 操作区 -->
    <div class="action-row">
      <TButton
        label="开始移除"
        icon="play"
        :disabled="!canStart"
        :loading="isProcessing"
        @click="startRemove"
      />
      <div v-if="isProcessing && uploadPercent < 100 && status === 'queued'" class="upload-progress">
        上传中 {{ uploadPercent }}%
      </div>
      <span v-if="statusText" class="status-badge" :class="`status-${status}`">{{ statusText }}</span>
    </div>

    <!-- 进度条 -->
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
        <TButton label="下载 MP4" icon="download" size="small" @click="downloadResult" />
      </div>
      <video
        v-if="resultUrl || resultPath"
        class="result-video"
        :src="resolveSrc(resultUrl) || resolveSrc(resultPath)"
        controls
      />
    </div>
  </div>
</template>

<style scoped>
.tool-form {
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
}

/* 拖拽上传区 */
.dropzone {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-6);
  background: var(--surface-container);
  border: 1.5px dashed var(--border);
  border-radius: var(--radius-lg);
  color: var(--muted-foreground);
  cursor: pointer;
  transition: border-color var(--duration-fast) var(--easing-default),
    background var(--duration-fast) var(--easing-default);
}
.dropzone:hover,
.dropzone.is-active {
  border-color: var(--primary);
  background: var(--surface-container-high);
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

/* 帧预览与画布 */
.frame-stage {
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
  display: inline-block;
  max-width: 100%;
  line-height: 0;
}
.frame-img {
  max-width: 100%;
  border-radius: var(--radius-md);
  display: block;
}
.frame-canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  cursor: crosshair;
}

/* 选区列表 */
.regions__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--space-2);
}
.form-label {
  font-size: var(--font-size-caption);
  font-weight: var(--font-weight-medium);
  color: var(--foreground-muted);
}
.link-btn {
  font-size: var(--font-size-caption);
  color: var(--primary);
  transition: color var(--duration-fast) var(--easing-default);
}
.link-btn:hover {
  color: var(--primary-hover);
}
.link-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.regions__list {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}
.region-chip {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  padding: 2px var(--space-2) 2px var(--space-3);
  background: var(--surface-container-high);
  border: 1px solid var(--border);
  border-radius: var(--radius-full);
  font-size: var(--font-size-caption);
  color: var(--foreground);
}
.region-chip__close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  color: var(--muted-foreground);
  border-radius: var(--radius-full);
  font-size: 14px;
  line-height: 1;
}
.region-chip__close:hover {
  color: var(--error);
  background: var(--surface-container-highest);
}

/* 表单 */
.form-field {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
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

/* 操作区 */
.action-row {
  display: flex;
  align-items: center;
  gap: var(--space-4);
}
.upload-progress {
  font-size: var(--font-size-caption);
  color: var(--muted-foreground);
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
.result-video {
  width: 100%;
  max-height: 360px;
  border-radius: var(--radius-md);
  background: #000;
}
</style>
