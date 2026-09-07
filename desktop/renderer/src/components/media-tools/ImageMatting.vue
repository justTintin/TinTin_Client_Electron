<script setup lang="ts">
// ═══════════════════════════════════════════════════════════════
// ImageMatting.vue — 图像抠图
// 上传图片 → 选择模型 → POST /matting（同步，服务端直接回 PNG 二进制）
// 主进程落盘到原图同目录 `{原名}_matting.png` → 预览/打开目录
// （2026-09-07 契约对齐：服务端实装 /matting，旧 /rembg/matting 异步任务模式从未实装）
// ═══════════════════════════════════════════════════════════════
import { ref, computed, onMounted } from 'vue'
import TButton from '@/components/common/TButton.vue'
import TSelect, { type SelectOption } from '@/components/common/TSelect.vue'
import { useFilePicker } from '@/composables/useFilePicker'
import { useServerTask } from '@/composables/useServerTask'
import type { RembgAPI } from '../../../../types/server-api'

/** 抠图模型选项（静态兑底；onMounted 尝试拉 GET /matting/models 对齐服务端） */
const modelOptions = ref<SelectOption[]>([
  { label: 'U2Net（通用）', value: 'u2net' },
  { label: 'ISNet General Use（高精度）', value: 'isnet-general-use' },
  { label: 'BiRefNet Portrait（人像）', value: 'birefnet-portrait' },
])

// ── 表单状态 ──
const model = ref('u2net')      // 抠图模型

onMounted(async () => {
  try {
    const res = await window.tintin.server.mattingModels()
    const list = (res && !('error' in res) && Array.isArray(res.models) ? res.models : []) as unknown[]
    // 归一化：字符串 或 {name/id, ...} 对象
    const opts = list
      .map((it) => (typeof it === 'string' ? it : String((it as any)?.name ?? (it as any)?.id ?? '')))
      .filter(Boolean)
      .map((v) => ({ label: v, value: v }))
    if (opts.length) modelOptions.value = opts
  } catch { /* 离线/失败静默，用静态兑底 */ }
})

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
const { status, progress, errorMsg, resultPath, isProcessing, uploadPercent } = task

const canStart = computed(() => !!filePath.value && !isProcessing.value)

/** 提交抠图（同步接口：服务端直接回 PNG，主进程落盘后返路径） */
async function startMatting() {
  if (!filePath.value) return
  task.begin()
  try {
    const res = await window.tintin.server.rembgSubmit({ image: filePath.value, model: model.value }, task.setUpload)
    if (!res) throw new Error('服务端离线或未返回结果')
    if ('error' in res && res.error) throw new Error(String(res.error))
    const out = res as RembgAPI.MattingResponse
    resultPath.value = out.path
    task.completeSync('')
  } catch (err) {
    task.failWith(err)
  }
}

/** 打开结果所在目录（对齐 vsr 裁决：完成后自动保存本地，按钮改为打开目录） */
function openResultDir() {
  if (resultPath.value) window.tintin.shell.revealInFolder(resultPath.value)
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

    <!-- 参数表单（2026-09-07 契约对齐：新接口 /matting 仅 file+model，删旧契约的 Alpha matting / 背景色） -->
    <div class="form-grid">
      <div class="form-field">
        <label class="form-label">抠图模型</label>
        <TSelect v-model="model" :options="modelOptions" :disabled="isProcessing" />
      </div>
    </div>

    <!-- 操作区 -->
    <div class="action-row">
      <!-- 对齐 vsr 裁决：完成后自动保存本地，按钮改两态（打开目录 / 开始抠图） -->
      <TButton
        v-if="resultPath"
        label="打开目录"
        icon="folder"
        @click="openResultDir"
      />
      <TButton
        v-else
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
        <TButton label="打开目录" icon="folder" size="small" @click="openResultDir" />
      </div>
      <p v-if="resultPath" class="result__save">已保存：{{ resultPath }}</p>
      <div class="preview-grid">
        <div class="preview-cell">
          <span class="preview-label">原图</span>
          <img class="preview-img" :src="resolveSrc(filePath)" alt="原图" />
        </div>
        <div class="preview-cell">
          <span class="preview-label">结果</span>
          <img class="preview-img preview-img--checker" :src="resolveSrc(resultPath)" alt="结果" />
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

/* ── 拖拽上传区（2026-09-07 用户裁决：全程序拖拽上传区高度统一 min-height 120px，
   以智能混剪选择素材原高 ≈80px 基准 +1/2）── */
.dropzone {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-height: 120px;
  padding: var(--space-6);
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

/* ── 开关/颜色选择已随旧契约参数删除（2026-09-07 /matting 仅 file+model） ── */

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

/* 已保存路径（对齐 SubtitleRemoval 的 .result__save 口径：尾部省略保留文件名） */
.result__save {
  margin: 0;
  font-size: var(--font-size-caption);
  color: var(--muted-foreground);
  direction: rtl;
  text-align: left;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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
