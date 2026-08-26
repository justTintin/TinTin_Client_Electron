<script setup lang="ts">
// ═══════════════════════════════════════════════════════════════
// VoiceClone.vue — 声音克隆
// 上传参考音频或从 voice_samples 选择 → 选择音色（/voices/list）
// → 输入文本 → POST /clone → 轮询任务 → 音频播放与下载
// ═══════════════════════════════════════════════════════════════
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import TButton from '@/components/common/TButton.vue'
import TSelect, { type SelectOption } from '@/components/common/TSelect.vue'

type TaskStatus = 'queued' | 'processing' | 'done' | 'failed'
type RefMode = 'upload' | 'sample'

/** 音色样本（来自 /voices/samples） */
interface VoiceSample {
  id: string
  name: string
  path?: string
  url?: string
}

// ── 选项数据 ──
const voiceOptions = ref<SelectOption[]>([])   // 音色下拉（来自 /voices/list）
const voiceSamples = ref<VoiceSample[]>([])    // 参考样本列表

// ── 表单状态 ──
const refMode = ref<RefMode>('upload')
const refFilePath = ref('')          // 上传的参考音频路径
const refFileName = ref('')
const selectedSampleId = ref('')     // 选中的样本 id
const voice = ref('')                // 选中音色
const text = ref('')                 // 待合成文本

// ── 任务状态 ──
const taskId = ref('')
const status = ref<TaskStatus | ''>('')
const progress = ref(0)
const errorMsg = ref('')
const resultUrl = ref('')
const resultPath = ref('')
const isProcessing = ref(false)
const isDragging = ref(false)
const uploadPercent = ref(0)

let pollTimer: ReturnType<typeof setInterval> | null = null

// 已选参考描述（用于校验/提示）
const refReady = computed(() =>
  refMode.value === 'upload' ? !!refFilePath.value : !!selectedSampleId.value
)
const canStart = computed(() => refReady.value && !!voice.value && !!text.value && !isProcessing.value)

/** 拉取音色下拉与参考样本列表 */
async function loadVoices() {
  try {
    const list = await window.tintin.server.ttsVoicesList()
    voiceOptions.value = (list || []).map((v) => ({ label: v.name, value: v.id }))
    if (voiceOptions.value.length && !voice.value) {
      voice.value = voiceOptions.value[0].value as string
    }
  } catch (err) {
    console.warn('[voice-clone] 拉取音色列表失败:', err)
  }
  try {
    const samples = await window.tintin.server.ttsVoicesSamples()
    voiceSamples.value = (samples || []).map((s) => ({
      id: s.id,
      name: s.name,
      path: (s as any).path,
      url: s.audio_url || (s as any).url,
    }))
  } catch (err) {
    console.warn('[voice-clone] 拉取参考样本失败:', err)
    voiceSamples.value = []
  }
}

/** 选择参考音频文件 */
async function pickRefFile() {
  const res = await window.tintin.dialog.openFile({
    title: '选择参考音频',
    filters: [{ name: '音频', extensions: ['mp3', 'wav', 'm4a', 'flac', 'aac', 'ogg'] }]
  })
  if (res) {
    refFilePath.value = res
    refFileName.value = res.split(/[\\/]/).pop() || res
  }
}

function onDrop(e: DragEvent) {
  isDragging.value = false
  const f = e.dataTransfer?.files?.[0]
  if (f && (f as File & { path?: string }).path) {
    refFilePath.value = (f as File & { path: string }).path
    refFileName.value = refFilePath.value.split(/[\\/]/).pop() || refFilePath.value
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

/** 提交克隆合成（走 tts:generate + 一次性参考音频 clone_ref_file） */
async function startClone() {
  if (!canStart.value) return
  resetResult()
  isProcessing.value = true
  status.value = 'queued'
  errorMsg.value = ''
  uploadPercent.value = 0
  try {
    const payload: Record<string, unknown> = {
      voice_id: voice.value,
      text: text.value,
    }
    if (refMode.value === 'upload') {
      payload.clone_ref_file = refFilePath.value as unknown as Blob
    }
    const res = await window.tintin.server.ttsGenerate(payload as any, (p: number) => {
      uploadPercent.value = Math.round(p)
    })
    if (!res) throw new Error('服务端离线或未返回结果')
    // ttsGenerate 返回 audio_url；若带 task_id（异步模式）则进入轮询；否则同步显示结果
    if ((res as any).task_id) {
      taskId.value = (res as any).task_id
      startPolling((res as any).task_id)
    } else {
      resultUrl.value = (res as any).audio_url || ''
      status.value = 'done'
      isProcessing.value = false
      window.tintin.shell.showNotification('声音克隆完成', '合成音频已就绪')
    }
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
    if (data.status === 'completed' as unknown as TaskStatus || (data.progress === 100 && status.value !== 'failed')) {
      status.value = 'done'
      resultUrl.value = data.result_url || ''
      isProcessing.value = false
      stopPolling()
      window.tintin.shell.showNotification('声音克隆完成', '合成音频已就绪')
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
  window.tintin.shell.showNotification('声音克隆失败', errorMsg.value)
}

function resetResult() {
  taskId.value = ''
  status.value = ''
  progress.value = 0
  errorMsg.value = ''
  resultUrl.value = ''
  resultPath.value = ''
}

/** 下载合成音频 */
function downloadResult() {
  if (resultUrl.value) {
    const a = document.createElement('a')
    a.href = resultUrl.value
    a.download = `clone_${taskId.value || 'result'}.wav`
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
      return `合成中 ${progress.value}%`
    case 'done':
      return '已完成'
    case 'failed':
      return '失败'
    default:
      return ''
  }
})

onMounted(loadVoices)
onBeforeUnmount(() => stopPolling())
</script>

<template>
  <div class="tool-form">
    <!-- 参考音频来源切换 -->
    <div class="form-field">
      <label class="form-label">参考音频</label>
      <div class="segmented">
        <button
          class="segmented__btn"
          :class="{ 'is-active': refMode === 'upload' }"
          :disabled="isProcessing"
          @click="refMode = 'upload'"
        >
          上传音频
        </button>
        <button
          class="segmented__btn"
          :class="{ 'is-active': refMode === 'sample' }"
          :disabled="isProcessing"
          @click="refMode = 'sample'"
        >
          从样本选择
        </button>
      </div>
    </div>

    <!-- 上传模式 -->
    <div
      v-if="refMode === 'upload'"
      class="dropzone"
      :class="{ 'is-active': isDragging, 'has-file': !!refFilePath }"
      @click="pickRefFile"
      @drop.prevent="onDrop"
      @dragover.prevent="onDragOver"
      @dragleave.prevent="onDragLeave"
    >
      <svg v-if="!refFilePath" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12" />
      </svg>
      <div class="dropzone__text">
        <template v-if="!refFilePath">
          <span class="dropzone__main">点击选择参考音频或拖拽到此处</span>
          <span class="dropzone__hint">支持 MP3 / WAV / M4A / FLAC</span>
        </template>
        <template v-else>
          <span class="dropzone__main">{{ refFileName }}</span>
          <span class="dropzone__hint">点击重新选择</span>
        </template>
      </div>
    </div>

    <!-- 样本选择模式 -->
    <div v-else class="sample-grid">
      <button
        v-for="s in voiceSamples"
        :key="s.id"
        class="sample-card"
        :class="{ 'is-selected': selectedSampleId === s.id }"
        :disabled="isProcessing"
        @click="selectedSampleId = s.id"
      >
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M3 18v-6a9 9 0 0 1 18 0v6" />
          <path d="M21 19a2 2 0 0 1-2 2h-1v-6h3zM3 19a2 2 0 0 0 2 2h1v-6H3z" />
        </svg>
        <span class="sample-card__name">{{ s.name }}</span>
      </button>
      <div v-if="!voiceSamples.length" class="sample-empty">暂无参考样本，请使用上传方式</div>
    </div>

    <!-- 音色与文本 -->
    <div class="form-grid">
      <div class="form-field">
        <label class="form-label">合成音色</label>
        <TSelect
          v-model="voice"
          :options="voiceOptions"
          placeholder="选择音色"
          :disabled="isProcessing"
        />
      </div>
    </div>

    <div class="form-field">
      <label class="form-label">待合成文本</label>
      <textarea
        v-model="text"
        class="text-area"
        rows="5"
        placeholder="输入要合成语音的文本（每段文本合成时长不超过 20 秒）"
        :disabled="isProcessing"
      />
      <span class="form-hint">提示：超过 20 秒的文本将被自动分段合成</span>
    </div>

    <!-- 操作区 -->
    <div class="action-row">
      <TButton
        label="开始合成"
        icon="play"
        :disabled="!canStart"
        :loading="isProcessing"
        @click="startClone"
      />
      <span v-if="isProcessing && uploadPercent < 100 && status === 'queued'" class="upload-progress">
        上传中 {{ uploadPercent }}%
      </span>
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
        <span class="result__title">合成结果</span>
        <TButton label="下载音频" icon="download" size="small" @click="downloadResult" />
      </div>
      <audio v-if="resultUrl || resultPath" class="audio-player" :src="resolveSrc(resultUrl) || resolveSrc(resultPath)" controls />
    </div>
  </div>
</template>

<style scoped>
.tool-form {
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
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
.form-hint {
  font-size: var(--font-size-caption);
  color: var(--muted-foreground);
}

/* 分段切换 */
.segmented {
  display: inline-flex;
  padding: 2px;
  background: var(--surface-container);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  align-self: flex-start;
}
.segmented__btn {
  padding: 0 var(--space-4);
  height: var(--size-button-height-sm);
  font-size: var(--font-size-caption);
  font-weight: var(--font-weight-medium);
  color: var(--muted-foreground);
  border-radius: var(--radius-sm);
  transition: background var(--duration-fast) var(--easing-default),
    color var(--duration-fast) var(--easing-default);
}
.segmented__btn.is-active {
  background: var(--primary);
  color: var(--primary-foreground);
}
.segmented__btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
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

/* 样本选择网格 */
.sample-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: var(--space-3);
}
.sample-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-4);
  background: var(--surface-container);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  color: var(--foreground-muted);
  transition: border-color var(--duration-fast) var(--easing-default),
    background var(--duration-fast) var(--easing-default),
    color var(--duration-fast) var(--easing-default);
}
.sample-card:hover:not(:disabled) {
  border-color: var(--primary);
  color: var(--foreground);
}
.sample-card.is-selected {
  border-color: var(--primary);
  background: rgba(109, 93, 252, 0.12);
  color: var(--primary);
}
.sample-card:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.sample-card__name {
  font-size: var(--font-size-caption);
  text-align: center;
  word-break: break-all;
}
.sample-empty {
  grid-column: 1 / -1;
  padding: var(--space-4);
  text-align: center;
  font-size: var(--font-size-caption);
  color: var(--muted-foreground);
}

/* 表单网格 */
.form-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: var(--space-4);
}

/* 文本域 */
.text-area {
  width: 100%;
  padding: var(--space-3);
  background: var(--surface-container);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  color: var(--foreground);
  font-size: var(--font-size-body);
  line-height: var(--line-height-relaxed);
  outline: none;
  resize: vertical;
  transition: border-color var(--duration-fast) var(--easing-default),
    box-shadow var(--duration-fast) var(--easing-default);
}
.text-area::placeholder {
  color: var(--muted-foreground);
}
.text-area:focus {
  border-color: var(--primary);
  box-shadow: 0 0 0 2px var(--ring);
}
.text-area:disabled {
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
.audio-player {
  width: 100%;
}
</style>
