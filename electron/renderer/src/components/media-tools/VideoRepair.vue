<script setup lang="ts">
// ═══════════════════════════════════════════════════════════════
// VideoRepair.vue — 视频修复
// 上传视频 → 选择模式/倍数/帧率/降噪等人脸开关 → POST /vsr/enhance
// 轮询 GET /tasks/{task_id} → 展示阶段（抽帧/推理/编码/合并）→ 下载 MP4
// ═══════════════════════════════════════════════════════════════
import { ref, computed, onBeforeUnmount } from 'vue'
import TButton from '@/components/common/TButton.vue'
import TSelect, { type SelectOption } from '@/components/common/TSelect.vue'

type TaskStatus = 'queued' | 'processing' | 'done' | 'failed'

// ── 表单状态 ──
const filePath = ref('')
const fileName = ref('')
const mode = ref<'repair' | 'superres' | 'both'>('both')
const scale = ref<number>(2)
const fps = ref<number>(0)            // 0 = 保持原帧率
const denoise = ref<number>(20)       // 降噪强度 0-100
const faceRestore = ref<boolean>(true) // 人脸修复
const trimStart = ref<string>('')     // 起始秒（可选）
const trimEnd = ref<string>('')       // 结束秒（可选）

// ── 选项 ──
const modeOptions: SelectOption[] = [
  { label: '修复（去噪去压缩）', value: 'repair' },
  { label: '超分辨率', value: 'superres' },
  { label: '修复 + 超分辨率', value: 'both' }
]
const scaleOptions: SelectOption[] = [
  { label: '2 倍', value: 2 },
  { label: '3 倍', value: 3 },
  { label: '4 倍', value: 4 }
]
const fpsOptions: SelectOption[] = [
  { label: '保持原帧率', value: 0 },
  { label: '24 fps', value: 24 },
  { label: '30 fps', value: 30 },
  { label: '60 fps', value: 60 }
]

// 仅 superres/both 模式才需选择倍数
const showScale = computed(() => mode.value === 'superres' || mode.value === 'both')

// ── 任务状态 ──
const taskId = ref('')
const status = ref<TaskStatus | ''>('')
const progress = ref(0)
const stage = ref('')            // 当前阶段：抽帧/推理/编码/合并
const errorMsg = ref('')
const resultUrl = ref('')
const resultPath = ref('')
const isProcessing = ref(false)
const isDragging = ref(false)
const uploadPercent = ref(0)

let pollTimer: ReturnType<typeof setInterval> | null = null

const canStart = computed(() => !!filePath.value && !isProcessing.value)

/** 选择视频文件 */
async function pickFile() {
  const res = await window.tintin.dialog.openFile({
    title: '选择视频',
    filters: [{ name: '视频', extensions: ['mp4', 'mov', 'webm'] }]
  })
  if (res) setFile(res)
}

function setFile(path: string) {
  filePath.value = path
  fileName.value = path.split(/[\\/]/).pop() || path
  resetResult()
}

function onDrop(e: DragEvent) {
  isDragging.value = false
  const f = e.dataTransfer?.files?.[0]
  if (f && (f as File & { path?: string }).path) {
    setFile((f as File & { path: string }).path)
  }
}
function onDragOver() {
  isDragging.value = true
}
function onDragLeave() {
  isDragging.value = false
}

function resolveSrc(src: string): string {
  if (!src) return ''
  if (/^(https?|blob|file|data):/i.test(src)) return src
  return `file://${src.replace(/\\/g, '/')}`
}

/** 提交增强任务 */
async function startEnhance() {
  if (!filePath.value) return
  resetResult()
  isProcessing.value = true
  status.value = 'queued'
  errorMsg.value = ''
  uploadPercent.value = 0
  try {
    const payload: Record<string, unknown> = {
      video: filePath.value,
      mode: mode.value,
      fps: fps.value || undefined,
      denoise_strength: denoise.value,
      face_restoration: faceRestore.value,
    }
    if (showScale.value) payload.scale = (scale.value === 2 ? '2x' : scale.value === 3 ? '3x' : '4x')
    if (trimStart.value !== '') payload.trim_start_sec = Number(trimStart.value)
    if (trimEnd.value !== '') payload.trim_end_sec = Number(trimEnd.value)

    const res = await window.tintin.server.vsrSubmit(payload as any, (p: number) => {
      uploadPercent.value = Math.round(p)
    })
    if (!res) throw new Error('服务端离线或未返回任务ID')
    taskId.value = res.task_id
    startPolling(res.task_id)
  } catch (err) {
    failWith(err)
  }
}

function startPolling(id: string) {
  stopPolling()
  pollTimer = setInterval(() => pollTask(id), 2000)
}
function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

async function pollTask(id: string) {
  try {
    const data = await window.tintin.server.tasksProgress(id)
    if (!data) return
    status.value = (data.status as unknown as TaskStatus) || ''
    progress.value = data.progress ?? 0
    stage.value = data.stage || ''
    if (data.status === 'completed' as unknown as TaskStatus || (data.progress === 100 && status.value !== 'failed')) {
      status.value = 'done'
      resultUrl.value = data.result_url || ''
      isProcessing.value = false
      stopPolling()
      window.tintin.shell.showNotification('视频修复完成', fileName.value)
    } else if (data.status === 'failed' as unknown as TaskStatus) {
      failWith(data.error_message || '处理失败')
    }
  } catch (err) {
    failWith(err)
  }
}

function failWith(err: unknown) {
  errorMsg.value = err instanceof Error ? err.message : String(err)
  status.value = 'failed'
  isProcessing.value = false
  stopPolling()
  window.tintin.shell.showNotification('视频修复失败', errorMsg.value)
}

function resetResult() {
  taskId.value = ''
  status.value = ''
  progress.value = 0
  stage.value = ''
  errorMsg.value = ''
  resultUrl.value = ''
  resultPath.value = ''
}

/** 下载结果 MP4 */
function downloadResult() {
  if (resultUrl.value) {
    const a = document.createElement('a')
    a.href = resultUrl.value
    a.download = fileName.value
      ? fileName.value.replace(/\.[^.]+$/, '') + '_enhanced.mp4'
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
      return stage.value ? `${stage.value} ${progress.value}%` : `处理中 ${progress.value}%`
    case 'done':
      return '已完成'
    case 'failed':
      return '失败'
    default:
      return ''
  }
})

onBeforeUnmount(() => stopPolling())
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
          <span class="dropzone__hint">支持 MP4 / MOV / WEBM</span>
        </template>
        <template v-else>
          <span class="dropzone__main">{{ fileName }}</span>
          <span class="dropzone__hint">点击重新选择</span>
        </template>
      </div>
    </div>

    <!-- 参数表单 -->
    <div class="form-grid">
      <div class="form-field">
        <label class="form-label">处理模式</label>
        <TSelect v-model="mode" :options="modeOptions" :disabled="isProcessing" />
      </div>

      <div v-if="showScale" class="form-field">
        <label class="form-label">超分倍数</label>
        <TSelect v-model="scale" :options="scaleOptions" :disabled="isProcessing" />
      </div>

      <div class="form-field">
        <label class="form-label">输出帧率</label>
        <TSelect v-model="fps" :options="fpsOptions" :disabled="isProcessing" />
      </div>

      <div class="form-field form-field--full">
        <label class="form-label">降噪强度：{{ denoise }}</label>
        <input
          v-model.number="denoise"
          type="range"
          min="0"
          max="100"
          step="1"
          class="slider"
          :disabled="isProcessing"
        />
        <span class="form-hint">0 = 不降噪，100 = 最大强度</span>
      </div>

      <div class="form-field">
        <label class="form-label">人脸修复</label>
        <div class="switch-row">
          <button
            type="button"
            class="switch"
            :class="{ 'is-on': faceRestore }"
            :disabled="isProcessing"
            role="switch"
            :aria-checked="faceRestore"
            @click="faceRestore = !faceRestore"
          >
            <span class="switch__thumb" />
          </button>
          <span class="form-hint">{{ faceRestore ? '开启' : '关闭' }}</span>
        </div>
      </div>

      <div class="form-field">
        <label class="form-label">裁剪起始（秒，可选）</label>
        <input
          v-model="trimStart"
          type="number"
          min="0"
          step="0.1"
          class="text-input"
          placeholder="留空不裁剪"
          :disabled="isProcessing"
        />
      </div>

      <div class="form-field">
        <label class="form-label">裁剪结束（秒，可选）</label>
        <input
          v-model="trimEnd"
          type="number"
          min="0"
          step="0.1"
          class="text-input"
          placeholder="留空不裁剪"
          :disabled="isProcessing"
        />
      </div>
    </div>

    <!-- 操作区 -->
    <div class="action-row">
      <TButton
        label="开始增强"
        icon="play"
        :disabled="!canStart"
        :loading="isProcessing"
        @click="startEnhance"
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
        <span class="result__title">增强完成</span>
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

/* 表单网格 */
.form-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: var(--space-4);
}
.form-field {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.form-field--full {
  grid-column: 1 / -1;
}
.form-label {
  font-size: var(--font-size-caption);
  font-weight: var(--font-weight-medium);
  color: var(--foreground-muted);
}
.form-hint {
  font-size: var(--font-size-caption);
  color: var(--muted-foreground);
}

/* 文本/数字输入 */
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

/* 滑块 */
.slider {
  width: 100%;
  height: var(--size-input-height);
  background: transparent;
  cursor: pointer;
  accent-color: var(--primary);
}
.slider:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* 开关 */
.switch-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  height: var(--size-input-height);
}
.switch {
  position: relative;
  width: 38px;
  height: 22px;
  flex-shrink: 0;
  background: var(--surface-container-high);
  border: 1px solid var(--border);
  border-radius: var(--radius-full);
  cursor: pointer;
  transition: background var(--duration-fast) var(--easing-default);
}
.switch.is-on {
  background: var(--primary);
  border-color: var(--primary);
}
.switch__thumb {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  background: var(--foreground);
  border-radius: var(--radius-full);
  transition: transform var(--duration-fast) var(--easing-default);
}
.switch.is-on .switch__thumb {
  transform: translateX(16px);
  background: var(--primary-foreground);
}
.switch:disabled {
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
