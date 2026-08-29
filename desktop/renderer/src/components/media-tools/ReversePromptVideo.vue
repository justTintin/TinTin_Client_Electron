<script setup lang="ts">
// ═══════════════════════════════════════════════════════════════
// ReversePromptVideo.vue — 视频反推提示词（M6 条目⑦）
// 对齐原客户端 gui/prompt_reverse_page.py：
//   预览播放器 + 时间轴选段（拖拽手柄/整窗平移 + 数值输入，≤30s，对照
//   _VideoTimeline L210-420）→ 仅把选中段随 POST /prompt/video 提交
//   （start_sec/end_sec，无本地裁切，对照 _VideoPromptWorker L461-502）
//   → 任务轮询（对照 _poll_task_result L128-188）→ 分段结果展示（_format_result）
// 组件只绘制 + 事件转发；选段约束/轮询状态机/结果分段全部在
// reversePromptVideoLogic.ts（纯函数）与 useReversePromptVideo.ts（编排）。
// ═══════════════════════════════════════════════════════════════
import { ref, computed, watch } from 'vue'
import TButton from '@/components/common/TButton.vue'
import { useReversePromptVideo } from '@/composables/useReversePromptVideo'

const V = useReversePromptVideo()

// ── 预览播放器 ──
const videoEl = ref<HTMLVideoElement | null>(null)

function onLoadedMetadata(e: Event): void {
  const v = e.target as HTMLVideoElement
  V.setDuration(v.duration || 0)
  void captureFrames()
}
function onTimeUpdate(e: Event): void {
  V.setCurrentTime((e.target as HTMLVideoElement).currentTime)
}
/** 播放头跳到选段起点（对照原版双击选区跳播的便捷语义） */
function seekTo(t: number): void {
  const v = videoEl.value
  if (v && Number.isFinite(t)) v.currentTime = Math.max(0, Math.min(t, V.duration.value))
}

// ── 时间轴：抽帧缩略图（对照 _extract_frames 均匀抽帧；失败 → 波形条回退）──
const THUMB_W = 96
const THUMB_H = 54

async function captureFrames(): Promise<void> {
  const times = V.frameTimes()
  const src = V.resolveSrc(V.filePath.value)
  if (!times.length || !src) return
  const v = document.createElement('video')
  v.src = src
  v.muted = true
  v.preload = 'auto'
  v.crossOrigin = 'anonymous'
  const canvas = document.createElement('canvas')
  canvas.width = THUMB_W
  canvas.height = THUMB_H
  const ctx = canvas.getContext('2d')
  const out: string[] = []
  await new Promise<void>((res) => {
    v.onloadeddata = () => res()
    v.onerror = () => res()
    setTimeout(res, 4000)
  })
  for (const t of times) {
    await new Promise<void>((res) => {
      v.onseeked = () => res()
      try { v.currentTime = Math.min(t, Math.max(0, (v.duration || t) - 0.05)) } catch { res() }
      setTimeout(res, 1500) // seek 兜底，避免坏帧卡住
    })
    try {
      ctx?.drawImage(v, 0, 0, THUMB_W, THUMB_H)
      out.push(canvas.toDataURL('image/jpeg', 0.6))
    } catch { break }
  }
  V.setThumbs(out)
}

/** 伪波形条高（对照原版 _gen_waveform 失败回退随机条 L245-258；这里确定性伪随机） */
const waveBars = Array.from({ length: 64 }, (_, i) =>
  18 + Math.round(46 * Math.abs(Math.sin(i * 12.9898 + 1.234) * 43758.5453 % 1)))

// ── 选段拖拽（指针 x → 秒，转发 composable 纯函数约束）──
const stripEl = ref<HTMLElement | null>(null)
let dragMode: 'left' | 'right' | 'move' | null = null

function xToTime(clientX: number): number {
  const el = stripEl.value
  if (!el || !V.duration.value) return 0
  const rect = el.getBoundingClientRect()
  const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
  return ratio * V.duration.value
}
function pointerDown(e: PointerEvent): void {
  if (!V.duration.value) return
  const t = xToTime(e.clientX)
  const thresholdSec = (10 / (stripEl.value?.getBoundingClientRect().width || 1)) * V.duration.value
  dragMode = V.hitMode(t, thresholdSec)
  if (dragMode) V.dragTo(dragMode, t)
}
function pointerMove(e: PointerEvent): void {
  if (!dragMode) return
  V.dragTo(dragMode, xToTime(e.clientX))
}
function pointerUp(): void {
  dragMode = null
}

// ── 数值输入（对照原版可直接键入起止的便捷语义；走统一 validateRange）──
const inputStart = ref(0)
const inputEnd = ref(0)
watch([V.selStart, V.selEnd], ([s, e]) => {
  inputStart.value = Number(s.toFixed(2))
  inputEnd.value = Number(e.toFixed(2))
}, { immediate: true })
const rangeError = ref('')
function applyInputs(): void {
  rangeError.value = V.setRange(Number(inputStart.value), Number(inputEnd.value))
}

const leftPct = computed(() =>
  V.duration.value ? `${(V.selStart.value / V.duration.value) * 100}%` : '0%')
const widthPct = computed(() =>
  V.duration.value ? `${((V.selEnd.value - V.selStart.value) / V.duration.value) * 100}%` : '0%')
const playheadPct = computed(() =>
  V.duration.value ? `${(V.currentTime.value / V.duration.value) * 100}%` : '0%')
</script>

<template>
  <div class="tool-form">
    <!-- 视频选择 -->
    <div
      class="dropzone"
      :class="{ 'is-active': V.isDragging.value, 'has-file': !!V.filePath.value }"
      @click="V.pickFile"
      @drop.prevent="V.onDrop"
      @dragover.prevent="V.onDragOver"
      @dragleave.prevent="V.onDragLeave"
    >
      <svg v-if="!V.filePath.value" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12" />
      </svg>
      <div class="dropzone__text">
        <template v-if="!V.filePath.value">
          <span class="dropzone__main">点击选择视频或拖拽到此处</span>
          <span class="dropzone__hint">支持 MP4 / MOV / AVI / MKV / WEBM</span>
        </template>
        <template v-else>
          <span class="dropzone__main">{{ V.fileName.value }}</span>
          <span class="dropzone__hint">点击重新选择</span>
        </template>
      </div>
    </div>

    <!-- 预览 + 时间轴选段 -->
    <template v-if="V.filePath.value">
      <div class="preview-row">
        <video
          ref="videoEl"
          class="preview"
          :src="V.resolveSrc(V.filePath.value)"
          controls
          preload="metadata"
          @loadedmetadata="onLoadedMetadata"
          @timeupdate="onTimeUpdate"
        />
        <div class="range-side">
          <span class="range-side__title">选段（≤ {{ V.MAX_WINDOW_SEC }} 秒）</span>
          <span class="range-side__range">{{ V.rangeText.value }}</span>
          <div class="range-side__inputs">
            <label>起(s)<input v-model.number="inputStart" type="number" step="0.1" min="0" :max="V.duration.value" @change="applyInputs" :disabled="V.polling.value" /></label>
            <label>止(s)<input v-model.number="inputEnd" type="number" step="0.1" min="0" :max="V.duration.value" @change="applyInputs" :disabled="V.polling.value" /></label>
          </div>
          <span v-if="rangeError" class="range-side__err">{{ rangeError }}</span>
        </div>
      </div>

      <!-- 时间轴条：缩略图（或波形回退）+ 选区 + 播放头 -->
      <div
        ref="stripEl"
        class="strip"
        @pointerdown.prevent="pointerDown"
        @pointermove="pointerMove"
        @pointerup="pointerUp"
        @pointerleave="pointerUp"
      >
        <template v-if="V.thumbs.value.length">
          <img v-for="(src, i) in V.thumbs.value" :key="i" class="strip__thumb" :src="src" alt="" />
        </template>
        <template v-else>
          <span v-for="(h, i) in waveBars" :key="i" class="strip__bar" :style="{ height: h + '%' }" />
        </template>
        <!-- 选区窗口 -->
        <div
          class="strip__sel"
          :style="{ left: leftPct, width: widthPct }"
          @dblclick.prevent="seekTo(V.selStart.value)"
        >
          <span class="strip__handle strip__handle--l" title="拖拽调整起点" />
          <span class="strip__win-label">{{ V.rangeText.value }}</span>
          <span class="strip__handle strip__handle--r" title="拖拽调整终点" />
        </div>
        <span class="strip__playhead" :style="{ left: playheadPct }" />
      </div>
      <div class="strip-scale"><span>{{ V.fmtSecLabel(0) }}</span><span>{{ V.fmtSecLabel(Math.floor(V.duration.value / 2)) }}</span><span>{{ V.fmtSecLabel(Math.floor(V.duration.value)) }}</span></div>
    </template>

    <!-- 操作区 -->
    <div class="action-row">
      <TButton
        label="开始反推选段"
        icon="play"
        :disabled="!V.canSubmit.value"
        :loading="V.submitting.value || V.polling.value"
        @click="V.submit"
      />
      <TButton
        v-if="V.polling.value"
        label="取消等待"
        icon="close"
        variant="secondary"
        @click="V.cancelPolling"
      />
      <span v-if="V.statusText.value" class="status">{{ V.statusText.value }}</span>
    </div>

    <!-- 错误提示 -->
    <div v-if="V.errorMessage.value" class="error-msg">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="10" />
        <line x1="12" y1="8" x2="12" y2="12" />
        <line x1="12" y1="16" x2="12.01" y2="16" />
      </svg>
      <span>{{ V.errorMessage.value }}</span>
    </div>

    <!-- 结果分段卡片（对照 _format_result 分段） -->
    <div v-if="V.segments.value.length" class="result-card">
      <div class="result-card__head">
        <span class="result-card__title">反推结果</span>
        <TButton
          label="复制全部"
          icon="download"
          size="small"
          variant="secondary"
          @click="copyAll"
        />
      </div>
      <div v-for="(seg, i) in V.segments.value" :key="i" class="result-seg">
        <span v-if="seg.label" class="result-seg__label">{{ seg.label }}</span>
        <p class="result-seg__text">{{ seg.text }}</p>
      </div>
    </div>
  </div>
</template>

<script lang="ts">
export default {
  // 复制全部分段（clipboard 失败 → 系统通知回退；DOM/剪贴板操作留在组件层）
  methods: {
    async copyAll(): Promise<void> {
      const text = this.$.setupState.V.segments.value
        .map((s) => (s.label ? `【${s.label}】\n${s.text}` : s.text))
        .join('\n\n')
      try {
        await navigator.clipboard.writeText(text)
        window.tintin.shell.showNotification('已复制', '反推结果已复制到剪贴板')
      } catch {
        window.tintin.shell.showNotification('复制失败', '请手动选择文本复制')
      }
    },
  },
}
</script>

<style scoped>
.tool-form {
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
}

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

.preview-row {
  display: flex;
  gap: var(--space-4);
  align-items: stretch;
}
.preview {
  flex: 1 1 420px;
  min-width: 0;
  max-height: 300px;
  background: #000;
  border-radius: var(--radius-lg);
  outline: none;
}
.range-side {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4);
  background: var(--surface-container);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  min-width: 220px;
}
.range-side__title {
  font-size: var(--font-size-caption);
  font-weight: var(--font-weight-semibold);
  color: var(--foreground);
}
.range-side__range {
  font-size: var(--font-size-caption);
  color: var(--primary);
  font-variant-numeric: tabular-nums;
}
.range-side__inputs {
  display: flex;
  gap: var(--space-2);
}
.range-side__inputs label {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 11px;
  color: var(--muted-foreground);
  flex: 1;
}
.range-side__inputs input {
  width: 100%;
  height: 28px;
  padding: 0 var(--space-2);
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  color: var(--foreground);
  font-size: var(--font-size-caption);
  outline: none;
}
.range-side__inputs input:focus {
  border-color: var(--primary);
}
.range-side__err {
  font-size: 11px;
  color: var(--error);
}

.strip {
  position: relative;
  display: flex;
  align-items: stretch;
  gap: 1px;
  height: 64px;
  padding: 2px;
  background: var(--surface-container);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  overflow: hidden;
  cursor: crosshair;
  user-select: none;
  touch-action: none;
}
.strip__thumb {
  flex: 1 1 0;
  min-width: 0;
  object-fit: cover;
  height: 100%;
  opacity: 0.85;
}
.strip__bar {
  flex: 1 1 0;
  min-width: 0;
  align-self: center;
  background: var(--primary);
  opacity: 0.35;
  border-radius: 1px;
}
.strip__sel {
  position: absolute;
  top: 0;
  bottom: 0;
  border: 2px solid var(--primary);
  background: rgba(46, 204, 113, 0.12);
  cursor: grab;
  display: flex;
  align-items: center;
  justify-content: center;
}
.strip__handle {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 8px;
  cursor: ew-resize;
  background: var(--primary);
}
.strip__handle--l { left: 0; border-radius: 2px 0 0 2px; }
.strip__handle--r { right: 0; border-radius: 0 2px 2px 0; }
.strip__win-label {
  font-size: 11px;
  color: var(--foreground);
  background: rgba(0, 0, 0, 0.45);
  padding: 1px 6px;
  border-radius: var(--radius-full);
  white-space: nowrap;
  pointer-events: none;
}
.strip__playhead {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 2px;
  background: var(--error, #ef4444);
  pointer-events: none;
}
.strip-scale {
  display: flex;
  justify-content: space-between;
  font-size: 11px;
  color: var(--muted-foreground);
  font-variant-numeric: tabular-nums;
}

.action-row {
  display: flex;
  align-items: center;
  gap: var(--space-4);
}
.status {
  font-size: var(--font-size-caption);
  color: var(--muted-foreground);
}

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

.result-card {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-4);
  background: var(--surface-container);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-lg);
}
.result-card__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.result-card__title {
  font-size: var(--font-size-body);
  font-weight: var(--font-weight-semibold);
  color: var(--foreground);
}
.result-seg {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.result-seg__label {
  font-size: var(--font-size-caption);
  font-weight: var(--font-weight-semibold);
  color: var(--primary);
}
.result-seg__text {
  margin: 0;
  font-size: var(--font-size-body);
  line-height: var(--line-height-relaxed);
  color: var(--foreground);
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
