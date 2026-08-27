<script setup lang="ts">
// ═══════════════════════════════════════════════════════════════
// ImageMatting.vue — 图像抠图
// 上传图片 → 选择模型与参数 → POST /rembg/matting（上传）
// 轮询 GET /tasks/{task_id} → 预览/下载 PNG 结果
// ═══════════════════════════════════════════════════════════════
import { ref, computed } from 'vue'
import TButton from '@/components/common/TButton.vue'
import TSelect, { type SelectOption } from '@/components/common/TSelect.vue'
import { useFilePicker } from '@/composables/useFilePicker'
import { useServerTask } from '@/composables/useServerTask'

/** 抠图模型选项 */
const modelOptions: SelectOption[] = [
  { label: 'U2Net（通用）', value: 'u2net' },
  { label: 'ISNet General Use（高精度）', value: 'isnet-general-use' },
  { label: 'BiRefNet Portrait（人像）', value: 'birefnet-portrait' }
]

// ── 表单状态 ──
const model = ref('u2net')      // 抠图模型
const alphaMatting = ref(false) // Alpha matting 开关
const bgColor = ref('#ffffff')  // 背景颜色
const bgTransparent = ref(true) // 背景透明（默认透明）

// ── 文件选择 + 拖拽（共享 composable，选中后清结果区） ──
const { filePath, fileName, isDragging, pickFile, onDrop, onDragOver, onDragLeave, resolveSrc } =
  useFilePicker({
    dialogTitle: '选择图片',
    filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp'] }],
    onPicked: () => task.resetResult(),
  })

// ── 任务状态机（共享 composable：上传进度 + 轮询 + 终态通知） ──
const task = useServerTask({
  successTitle: '图像抠图完成',
  failTitle: '图像抠图失败',
  getSuccessBody: () => fileName.value,
})
const { status, progress, errorMsg, resultUrl, resultPath, isProcessing, uploadPercent } = task

const canStart = computed(() => !!filePath.value && !isProcessing.value)

/** 提交抠图任务 */
async function startMatting() {
  if (!filePath.value) return
  task.begin()
  try {
    const payload = {
      image: filePath.value as unknown as Blob, // 路径占位：server-proxy 在 Node 侧按字段名读本地路径
      model: model.value,
      alpha_matting: alphaMatting.value,
      bg_color: bgTransparent.value ? null : bgColor.value,
    }
    const res = await window.tintin.server.rembgSubmit(payload, task.setUpload)
    if (!res) throw new Error('服务端离线或未返回任务ID')
    task.startPolling(res.task_id)
  } catch (err) {
    task.failWith(err)
  }
}

/** 下载结果 PNG */
function downloadResult() {
  if (resultUrl.value) {
    const a = document.createElement('a')
    a.href = resultUrl.value
    a.download = fileName.value
      ? fileName.value.replace(/\.[^.]+$/, '') + '_matting.png'
      : 'result.png'
    document.body.appendChild(a)
    a.click()
    a.remove()
  } else if (resultPath.value) {
    window.tintin.shell.revealInFolder(resultPath.value)
  }
}

/** 状态文案 */
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
    <!-- 文件选择 -->
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
          <span class="dropzone__main">点击选择图片或拖拽到此处</span>
          <span class="dropzone__hint">支持 PNG / JPG / WEBP / BMP</span>
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
        <label class="form-label">抠图模型</label>
        <TSelect v-model="model" :options="modelOptions" :disabled="isProcessing" />
      </div>

      <div class="form-field">
        <label class="form-label">Alpha matting</label>
        <div class="switch-row">
          <button
            type="button"
            class="switch"
            :class="{ 'is-on': alphaMatting }"
            :disabled="isProcessing"
            role="switch"
            :aria-checked="alphaMatting"
            @click="alphaMatting = !alphaMatting"
          >
            <span class="switch__thumb" />
          </button>
          <span class="form-hint">开启后边缘更精细，速度较慢</span>
        </div>
      </div>

      <div class="form-field">
        <label class="form-label">背景颜色</label>
        <div class="color-row">
          <button
            type="button"
            class="switch switch--sm"
            :class="{ 'is-on': !bgTransparent }"
            :disabled="isProcessing"
            role="switch"
            :aria-checked="!bgTransparent"
            @click="bgTransparent = !bgTransparent"
          >
            <span class="switch__thumb" />
          </button>
          <span class="form-hint">{{ bgTransparent ? '透明背景' : '自定义颜色' }}</span>
          <input
            v-if="!bgTransparent"
            v-model="bgColor"
            type="color"
            class="color-input"
            :disabled="isProcessing"
          />
        </div>
      </div>
    </div>

    <!-- 操作区 -->
    <div class="action-row">
      <TButton
        label="开始抠图"
        icon="play"
        :disabled="!canStart"
        :loading="isProcessing"
        @click="startMatting"
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

    <!-- 结果预览 -->
    <div v-if="status === 'done'" class="result">
      <div class="result__head">
        <span class="result__title">抠图结果</span>
        <TButton label="下载 PNG" icon="download" size="small" @click="downloadResult" />
      </div>
      <div class="preview-grid">
        <div class="preview-cell">
          <span class="preview-label">原图</span>
          <img class="preview-img" :src="resolveSrc(filePath)" alt="原图" />
        </div>
        <div class="preview-cell">
          <span class="preview-label">结果</span>
          <img class="preview-img preview-img--checker" :src="resolveSrc(resultUrl) || resolveSrc(resultPath)" alt="结果" />
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

/* ── 拖拽上传区 ── */
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

/* ── 表单网格 ── */
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

.form-label {
  font-size: var(--font-size-caption);
  font-weight: var(--font-weight-medium);
  color: var(--foreground-muted);
}

.form-hint {
  font-size: var(--font-size-caption);
  color: var(--muted-foreground);
}

/* ── 开关 ── */
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

.switch--sm {
  width: 32px;
  height: 18px;
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

.switch--sm .switch__thumb {
  width: 12px;
  height: 12px;
}

.switch.is-on .switch__thumb {
  transform: translateX(16px);
  background: var(--primary-foreground);
}

.switch--sm.is-on .switch__thumb {
  transform: translateX(14px);
}

.switch:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* ── 颜色选择 ── */
.color-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  height: var(--size-input-height);
}

.color-input {
  width: 40px;
  height: var(--size-input-height);
  padding: 2px;
  background: var(--surface-container);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  cursor: pointer;
}

/* ── 操作区 ── */
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

/* ── 进度条 ── */
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

/* ── 错误提示 ── */
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

/* ── 结果区 ── */
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

.preview-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--space-4);
}

.preview-cell {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.preview-label {
  font-size: var(--font-size-caption);
  color: var(--muted-foreground);
}

.preview-img {
  width: 100%;
  max-height: 280px;
  object-fit: contain;
  border-radius: var(--radius-md);
  background: var(--surface);
}

/* 透明棋盘格背景，便于观察 PNG 透明区域 */
.preview-img--checker {
  background-image: linear-gradient(45deg, var(--border-subtle) 25%, transparent 25%),
    linear-gradient(-45deg, var(--border-subtle) 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, var(--border-subtle) 75%),
    linear-gradient(-45deg, transparent 75%, var(--border-subtle) 75%);
  background-size: 16px 16px;
  background-position: 0 0, 0 8px, 8px -8px, -8px 0;
}
</style>
