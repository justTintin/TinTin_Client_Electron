<script setup lang="ts">
// ═══════════════════════════════════════════════════════════════
// CoverMaker.vue — 封面制作
// 图层编辑：背景 / 商品图 / 文本 / Logo → 选择尺寸与数量
// → POST /workflow/run（封面工作流 JSON）→ SSE 流式进度
// → 结果画廊，逐张下载
// ═══════════════════════════════════════════════════════════════
import { ref, computed, onBeforeUnmount } from 'vue'
import TButton from '@/components/common/TButton.vue'
import { useFilePicker } from '@/composables/useFilePicker'

type SizeRatio = '1:1' | '9:16' | '16:9'

/** 单张封面结果 */
interface CoverItem {
  url: string
  name?: string
}

/** 工作流事件（SSE 推送，字段宽松兼容） */
interface WorkflowEvent {
  status?: string
  progress?: number
  covers?: Array<string | CoverItem>
  error?: string
  message?: string
}

// ── 文件选择（共享 composable：商品图 / Logo 各一路） ──
const product = useFilePicker({
  dialogTitle: '选择商品图',
  filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
})
const logo = useFilePicker({
  dialogTitle: '选择 Logo',
  filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'svg'] }],
})

// ── 图层状态 ──
const bgColor = ref('#161828')        // 背景颜色
const bgTransparent = ref(false)      // 背景透明
const { filePath: productPath, fileName: productName } = product  // 商品图
const textContent = ref('')           // 文本内容
const { filePath: logoPath, fileName: logoName } = logo            // Logo

// ── 参数 ──
const size = ref<SizeRatio>('1:1')
const count = ref<number>(4)

// ── 运行状态 ──
const runId = ref('')
const isProcessing = ref(false)
const progress = ref(0)
const statusText = ref('')
const errorMsg = ref('')
const covers = ref<CoverItem[]>([])

// SSE 关闭函数
let stopSse: (() => void) | null = null

const sizeOptions: Array<{ label: string; value: SizeRatio }> = [
  { label: '1:1', value: '1:1' },
  { label: '9:16', value: '9:16' },
  { label: '16:9', value: '16:9' }
]

const canStart = computed(
  () => (productPath.value !== '' || textContent.value !== '') && !isProcessing.value
)

/** 选择商品图 */
async function pickProduct() { await product.pickFile() }
/** 选择 Logo */
async function pickLogo() { await logo.pickFile() }

const resolveSrc = product.resolveSrc

/** 构建封面工作流 JSON */
function buildWorkflow(): Record<string, unknown> {
  return {
    type: 'cover',
    size: size.value,
    count: count.value,
    layers: {
      background: bgTransparent.value ? { transparent: true } : { color: bgColor.value },
      product: productPath.value ? { file: productPath.value } : null,
      text: textContent.value ? { content: textContent.value } : null,
      logo: logoPath.value ? { file: logoPath.value } : null
    }
  }
}

/** 提交工作流并订阅 SSE */
async function startRun() {
  if (!canStart.value) return
  isProcessing.value = true
  errorMsg.value = ''
  covers.value = []
  progress.value = 0
  statusText.value = '提交中'
  try {
    const res = await window.tintin.server.workflowRun(buildWorkflow() as any)
    if (!res) throw new Error('服务端离线或未返回 run_id')
    runId.value = res.run_id
    statusText.value = '排队中'
    subscribeSse(res.run_id)
  } catch (err) {
    failWith(err)
  }
}

/** 订阅工作流 SSE 流 */
function subscribeSse(id: string) {
  stopSse = window.tintin.server.sse(
    `/workflow/run/${id}/stream`,
    (event: WorkflowEvent) => {
      if (typeof event !== 'object' || event === null) return
      if (event.progress !== undefined) progress.value = event.progress
      if (event.status) statusText.value = event.status
      if (Array.isArray(event.covers)) {
        const items = event.covers.map((c) =>
          typeof c === 'string' ? { url: c } : c
        )
        covers.value.push(...items)
      }
      if (event.status === 'done') {
        isProcessing.value = false
        statusText.value = '已完成'
        destroySse()
        window.tintin.shell.showNotification('封面制作完成', `共生成 ${covers.value.length} 张`)
      } else if (event.status === 'failed') {
        failWith(event.error || event.message || '工作流执行失败')
      }
    },
    (err: unknown) => {
      failWith(err instanceof Error ? err.message : String(err))
    }
  )
}

function destroySse() {
  if (stopSse) {
    stopSse()
    stopSse = null
  }
}

function failWith(err: unknown) {
  errorMsg.value = err instanceof Error ? err.message : String(err)
  statusText.value = '失败'
  isProcessing.value = false
  destroySse()
  window.tintin.shell.showNotification('封面制作失败', errorMsg.value)
}

/** 下载单张封面 */
function downloadCover(item: CoverItem, index: number) {
  const a = document.createElement('a')
  a.href = item.url
  a.download = item.name || `cover_${index + 1}.png`
  document.body.appendChild(a)
  a.click()
  a.remove()
}

onBeforeUnmount(() => destroySse())
</script>

<template>
  <div class="tool-form">
    <!-- 图层编辑器 -->
    <div class="layers">
      <!-- 背景层 -->
      <div class="layer">
        <div class="layer__head">
          <span class="layer__title">背景</span>
          <button
            type="button"
            class="switch switch--sm"
            :class="{ 'is-on': bgTransparent }"
            :disabled="isProcessing"
            role="switch"
            :aria-checked="bgTransparent"
            @click="bgTransparent = !bgTransparent"
          >
            <span class="switch__thumb" />
          </button>
          <span class="form-hint">{{ bgTransparent ? '透明' : '纯色' }}</span>
        </div>
        <input
          v-if="!bgTransparent"
          v-model="bgColor"
          type="color"
          class="color-input"
          :disabled="isProcessing"
        />
      </div>

      <!-- 商品图层 -->
      <div class="layer">
        <div class="layer__head">
          <span class="layer__title">商品图</span>
          <span class="form-hint">{{ productName || '未选择' }}</span>
        </div>
        <TButton
          label="选择商品图"
          icon="upload"
          size="small"
          variant="secondary"
          :disabled="isProcessing"
          @click="pickProduct"
        />
      </div>

      <!-- 文本层 -->
      <div class="layer">
        <div class="layer__head">
          <span class="layer__title">文本</span>
        </div>
        <textarea
          v-model="textContent"
          class="text-area"
          rows="2"
          placeholder="输入封面文字（可选）"
          :disabled="isProcessing"
        />
      </div>

      <!-- Logo 层 -->
      <div class="layer">
        <div class="layer__head">
          <span class="layer__title">Logo</span>
          <span class="form-hint">{{ logoName || '未选择' }}</span>
        </div>
        <TButton
          label="选择 Logo"
          icon="upload"
          size="small"
          variant="secondary"
          :disabled="isProcessing"
          @click="pickLogo"
        />
      </div>
    </div>

    <!-- 尺寸与数量 -->
    <div class="form-grid">
      <div class="form-field">
        <label class="form-label">画布尺寸</label>
        <div class="segmented">
          <button
            v-for="opt in sizeOptions"
            :key="opt.value"
            class="segmented__btn"
            :class="{ 'is-active': size === opt.value }"
            :disabled="isProcessing"
            @click="size = opt.value"
          >
            {{ opt.label }}
          </button>
        </div>
      </div>
      <div class="form-field">
        <label class="form-label">生成数量（1-16）</label>
        <input
          v-model.number="count"
          type="number"
          min="1"
          max="16"
          class="text-input"
          :disabled="isProcessing"
        />
      </div>
    </div>

    <!-- 操作区 -->
    <div class="action-row">
      <TButton
        label="开始生成"
        icon="play"
        :disabled="!canStart"
        :loading="isProcessing"
        @click="startRun"
      />
      <span v-if="statusText" class="status-badge" :class="{ 'is-failed': statusText === '失败' }">
        {{ statusText }} {{ isProcessing ? progress + '%' : '' }}
      </span>
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

    <!-- 结果画廊 -->
    <div v-if="covers.length" class="gallery">
      <div v-for="(cover, idx) in covers" :key="idx" class="gallery__item">
        <img class="gallery__img" :src="resolveSrc(cover.url)" :alt="`封面 ${idx + 1}`" />
        <button class="gallery__download" :disabled="isProcessing" @click="downloadCover(cover, idx)">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" />
          </svg>
          下载
        </button>
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

/* 图层编辑器 */
.layers {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: var(--space-3);
}
.layer {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-4);
  background: var(--surface-container);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-lg);
}
.layer__head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.layer__title {
  font-size: var(--font-size-body);
  font-weight: var(--font-weight-semibold);
  color: var(--foreground);
}
.form-hint {
  font-size: var(--font-size-caption);
  color: var(--muted-foreground);
  margin-left: auto;
}

/* 颜色输入 */
.color-input {
  width: 56px;
  height: var(--size-input-height);
  padding: 2px;
  background: var(--surface-container);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  cursor: pointer;
}

/* 文本域 */
.text-area {
  width: 100%;
  padding: var(--space-2) var(--space-3);
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

/* 开关 */
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

/* 表单 */
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
.text-input:focus {
  border-color: var(--primary);
  box-shadow: 0 0 0 2px var(--ring);
}
.text-input:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* 分段切换 */
.segmented {
  display: inline-flex;
  padding: 2px;
  background: var(--surface-container);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
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
.status-badge.is-failed {
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

/* 结果画廊 */
.gallery {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: var(--space-4);
}
.gallery__item {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-2);
  background: var(--surface-container);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-lg);
}
.gallery__img {
  width: 100%;
  aspect-ratio: 1 / 1;
  object-fit: cover;
  border-radius: var(--radius-md);
  background: var(--surface);
}
.gallery__download {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-1);
  height: var(--size-button-height-sm);
  color: var(--foreground-muted);
  font-size: var(--font-size-caption);
  font-weight: var(--font-weight-medium);
  border-radius: var(--radius-sm);
  transition: color var(--duration-fast) var(--easing-default),
    background var(--duration-fast) var(--easing-default);
}
.gallery__download:hover:not(:disabled) {
  color: var(--primary);
  background: var(--surface-container-high);
}
.gallery__download:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
