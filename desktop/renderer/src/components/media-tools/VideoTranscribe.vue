<script setup lang="ts">
// ═══════════════════════════════════════════════════════════════
// VideoTranscribe.vue — 视频转文字
// 本地文件或 URL → 选择语言/输出格式 → POST /whisper/transcribe
// 展示转写文本，支持按所选格式下载
// ═══════════════════════════════════════════════════════════════
import { ref, computed } from 'vue'
import TButton from '@/components/common/TButton.vue'
import TSelect, { type SelectOption } from '@/components/common/TSelect.vue'

type SourceMode = 'file' | 'url'

const languageOptions: SelectOption[] = [
  { label: '自动识别', value: 'auto' },
  { label: '中文', value: 'zh' },
  { label: '英文', value: 'en' }
]
const formatOptions: SelectOption[] = [
  { label: 'SRT 字幕', value: 'srt' },
  { label: '纯文本', value: 'txt' },
  { label: 'JSON', value: 'json' }
]

// ── 表单状态 ──
const sourceMode = ref<SourceMode>('file')
const filePath = ref('')
const fileName = ref('')
const url = ref('')
const language = ref('auto')
const format = ref<'srt' | 'txt' | 'json'>('txt')

// ── 运行状态 ──
const isProcessing = ref(false)
const errorMsg = ref('')
const transcript = ref('')          // 转写文本
const downloadUrl = ref('')         // 服务端提供的下载地址
const isDragging = ref(false)
const uploadPercent = ref(0)

const canStart = computed(() => {
  if (isProcessing.value) return false
  return sourceMode.value === 'file' ? !!filePath.value : !!url.value
})

/** 选择视频/音频文件 */
async function pickFile() {
  const res = await window.tintin.dialog.openFile({
    title: '选择视频或音频',
    filters: [
      { name: '视频', extensions: ['mp4', 'mov', 'webm', 'mkv', 'avi'] },
      { name: '音频', extensions: ['mp3', 'wav', 'm4a', 'flac', 'aac'] }
    ]
  })
  if (res) {
    filePath.value = res
    fileName.value = res.split(/[\\/]/).pop() || res
    transcript.value = ''
  }
}

function onDrop(e: DragEvent) {
  isDragging.value = false
  const f = e.dataTransfer?.files?.[0]
  if (f && (f as File & { path?: string }).path) {
    filePath.value = (f as File & { path: string }).path
    fileName.value = filePath.value.split(/[\\/]/).pop() || filePath.value
    transcript.value = ''
  }
}
function onDragOver() {
  isDragging.value = true
}
function onDragLeave() {
  isDragging.value = false
}

/** 提交转写 */
async function startTranscribe() {
  isProcessing.value = true
  errorMsg.value = ''
  transcript.value = ''
  downloadUrl.value = ''
  uploadPercent.value = 0
  try {
    let res
    if (sourceMode.value === 'file') {
      res = await window.tintin.server.asrTranscribe({
        audio: filePath.value as unknown as Blob, // 本地路径占位：server-proxy Node 侧按字段名读取
        language: language.value === 'auto' ? undefined : language.value,
      }, (p: number) => {
        uploadPercent.value = Math.round(p)
      })
    } else {
      res = await window.tintin.server.asrTranscribe({
        url: url.value,
        language: language.value === 'auto' ? undefined : language.value,
      })
    }
    if (!res) throw new Error('服务端离线或未返回结果')
    transcript.value = (res as any).transcript || (res as any).text || ''
    downloadUrl.value = (res as any).download_url || ''
    if (!transcript.value) errorMsg.value = '未返回转写内容'
  } catch (err) {
    errorMsg.value = err instanceof Error ? err.message : String(err)
    window.tintin.shell.showNotification('转写失败', errorMsg.value)
  } finally {
    isProcessing.value = false
  }
}

/** 下载转写结果 */
function downloadTranscript() {
  if (downloadUrl.value) {
    const a = document.createElement('a')
    a.href = downloadUrl.value
    a.download = `transcript.${format.value}`
    document.body.appendChild(a)
    a.click()
    a.remove()
    return
  }
  // 无服务端下载地址时，用文本内容生成 blob 下载
  if (!transcript.value) return
  const mime = format.value === 'json' ? 'application/json' : 'text/plain'
  const blob = new Blob([transcript.value], { type: `${mime};charset=utf-8` })
  const href = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = href
  a.download = `transcript.${format.value}`
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(href)
}
</script>

<template>
  <div class="tool-form">
    <!-- 来源切换 -->
    <div class="segmented">
      <button
        class="segmented__btn"
        :class="{ 'is-active': sourceMode === 'file' }"
        :disabled="isProcessing"
        @click="sourceMode = 'file'"
      >
        本地文件
      </button>
      <button
        class="segmented__btn"
        :class="{ 'is-active': sourceMode === 'url' }"
        :disabled="isProcessing"
        @click="sourceMode = 'url'"
      >
        URL 链接
      </button>
    </div>

    <!-- 文件选择 -->
    <div
      v-if="sourceMode === 'file'"
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
          <span class="dropzone__main">点击选择视频/音频或拖拽到此处</span>
          <span class="dropzone__hint">支持 MP4 / MOV / MP3 / WAV 等</span>
        </template>
        <template v-else>
          <span class="dropzone__main">{{ fileName }}</span>
          <span class="dropzone__hint">点击重新选择</span>
        </template>
      </div>
    </div>

    <!-- URL 输入 -->
    <div v-else class="form-field">
      <label class="form-label">媒体 URL</label>
      <input
        v-model="url"
        type="url"
        class="text-input"
        placeholder="https://example.com/video.mp4"
        :disabled="isProcessing"
      />
    </div>

    <!-- 参数 -->
    <div class="form-grid">
      <div class="form-field">
        <label class="form-label">语言</label>
        <TSelect v-model="language" :options="languageOptions" :disabled="isProcessing" />
      </div>
      <div class="form-field">
        <label class="form-label">输出格式</label>
        <TSelect v-model="format" :options="formatOptions" :disabled="isProcessing" />
      </div>
    </div>

    <!-- 操作区 -->
    <div class="action-row">
      <TButton
        label="开始转写"
        icon="play"
        :disabled="!canStart"
        :loading="isProcessing"
        @click="startTranscribe"
      />
      <span v-if="isProcessing && uploadPercent < 100 && sourceMode === 'file'" class="upload-progress">
        上传中 {{ uploadPercent }}%
      </span>
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
    <div v-if="transcript" class="result">
      <div class="result__head">
        <span class="result__title">转写结果</span>
        <TButton label="下载" icon="download" size="small" @click="downloadTranscript" />
      </div>
      <pre class="transcript">{{ transcript }}</pre>
    </div>
  </div>
</template>

<style scoped>
.tool-form {
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
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

/* 表单 */
.form-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
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

.action-row {
  display: flex;
  align-items: center;
  gap: var(--space-4);
}
.upload-progress {
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
.transcript {
  margin: 0;
  max-height: 360px;
  overflow: auto;
  padding: var(--space-3) var(--space-4);
  background: var(--surface);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  font-family: var(--font-mono);
  font-size: var(--font-size-mono);
  line-height: var(--line-height-relaxed);
  color: var(--foreground);
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
