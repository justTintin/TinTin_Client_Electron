<script setup lang="ts">
// ═══════════════════════════════════════════════════════════════
// ReversePromptImage.vue — 图片反推提示词
// 上传图片 → 设置数量/风格/语言 → POST /vision/reverse-prompt
// 结果以卡片形式展示（中/英文本 + 风格标签），每张卡片可复制
// ═══════════════════════════════════════════════════════════════
import { ref, computed } from 'vue'
import TButton from '@/components/common/TButton.vue'
import TSelect, { type SelectOption } from '@/components/common/TSelect.vue'
import { useFilePicker } from '@/composables/useFilePicker'

/** 单条反推结果 */
interface PromptItem {
  zh?: string
  en?: string
  style_tags?: string[]
}

const styleOptions: SelectOption[] = [
  { label: '通用', value: 'general' },
  { label: 'Midjourney', value: 'midjourney' },
  { label: 'Stable Diffusion', value: 'stable-diffusion' },
  { label: '商品摄影', value: 'product-photo' }
]
const languageOptions: SelectOption[] = [
  { label: '中文', value: 'zh' },
  { label: '英文', value: 'en' },
  { label: '中英双语', value: 'zh+en' }
]

// ── 表单状态 ──
const count = ref<number>(4)        // 生成数量 1-8
const style = ref('general')
const language = ref('zh+en')

// ── 运行状态 ──
const isProcessing = ref(false)
const errorMsg = ref('')
const results = ref<PromptItem[]>([])
const copiedIndex = ref(-1)

const canStart = computed(() => !!filePath.value && !isProcessing.value)

// ── 文件选择 + 拖拽（共享 composable，选中后清结果区） ──
const { filePath, fileName, isDragging, pickFile, onDrop, onDragOver, onDragLeave, resolveSrc } =
  useFilePicker({
    dialogTitle: '选择图片',
    filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp'] }],
    onPicked: () => { results.value = [] },
  })

/** 提交反推 */
async function startReverse() {
  if (!filePath.value) return
  isProcessing.value = true
  errorMsg.value = ''
  results.value = []
  try {
    const res = await window.tintin.server.visionReversePrompt({
      file: filePath.value as unknown as Blob,
      count: count.value,
      style: style.value,
      language: language.value,
    })
    // 兼容 { prompts: [] } 或 [] 两种返回结构
    const raw = (res as any)
    results.value = Array.isArray(raw) ? raw : raw?.prompts || []
    if (results.value.length === 0) {
      errorMsg.value = '未返回任何提示词'
    }
  } catch (err) {
    errorMsg.value = err instanceof Error ? err.message : String(err)
    window.tintin.shell.showNotification('图片反推失败', errorMsg.value)
  } finally {
    isProcessing.value = false
  }
}

/** 复制单条提示词文本 */
async function copyPrompt(item: PromptItem, index: number) {
  const text = [item.zh, item.en].filter(Boolean).join('\n\n')
  if (!text) return
  try {
    await navigator.clipboard.writeText(text)
    copiedIndex.value = index
    setTimeout(() => (copiedIndex.value = -1), 1500)
  } catch {
    window.tintin.shell.showNotification('复制失败', '请手动选择文本复制')
  }
}
</script>

<template>
  <div class="tool-form">
    <!-- 图片选择 -->
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
      <img v-if="filePath" class="dropzone__thumb" :src="resolveSrc(filePath)" alt="预览" />
    </div>

    <!-- 参数 -->
    <div class="form-grid">
      <div class="form-field">
        <label class="form-label">生成数量（1-8）</label>
        <input
          v-model.number="count"
          type="number"
          min="1"
          max="8"
          class="text-input"
          :disabled="isProcessing"
        />
      </div>
      <div class="form-field">
        <label class="form-label">风格</label>
        <TSelect v-model="style" :options="styleOptions" :disabled="isProcessing" />
      </div>
      <div class="form-field">
        <label class="form-label">语言</label>
        <TSelect v-model="language" :options="languageOptions" :disabled="isProcessing" />
      </div>
    </div>

    <!-- 操作区 -->
    <div class="action-row">
      <TButton
        label="开始反推"
        icon="play"
        :disabled="!canStart"
        :loading="isProcessing"
        @click="startReverse"
      />
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

    <!-- 结果卡片 -->
    <div v-if="results.length" class="result-list">
      <div v-for="(item, idx) in results" :key="idx" class="prompt-card">
        <div class="prompt-card__head">
          <span class="prompt-card__index">#{{ idx + 1 }}</span>
          <TButton
            :label="copiedIndex === idx ? '已复制' : '复制'"
            :icon="copiedIndex === idx ? 'check' : 'download'"
            size="small"
            variant="secondary"
            @click="copyPrompt(item, idx)"
          />
        </div>
        <p v-if="item.zh" class="prompt-card__text prompt-card__text--zh">{{ item.zh }}</p>
        <p v-if="item.en" class="prompt-card__text prompt-card__text--en">{{ item.en }}</p>
        <div v-if="item.style_tags && item.style_tags.length" class="tag-row">
          <span v-for="tag in item.style_tags" :key="tag" class="tag">{{ tag }}</span>
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

/* 拖拽上传区 */
.dropzone {
  display: flex;
  align-items: center;
  gap: var(--space-3);
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
  flex: 1;
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
.dropzone__thumb {
  width: 56px;
  height: 56px;
  object-fit: cover;
  border-radius: var(--radius-md);
  flex-shrink: 0;
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

/* 结果卡片列表 */
.result-list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: var(--space-4);
}
.prompt-card {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-4);
  background: var(--surface-container);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-lg);
}
.prompt-card__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.prompt-card__index {
  font-size: var(--font-size-caption);
  font-weight: var(--font-weight-semibold);
  color: var(--primary);
}
.prompt-card__text {
  margin: 0;
  font-size: var(--font-size-body);
  line-height: var(--line-height-relaxed);
  color: var(--foreground);
  white-space: pre-wrap;
  word-break: break-word;
}
.prompt-card__text--zh {
  color: var(--foreground);
}
.prompt-card__text--en {
  color: var(--foreground-muted);
  font-family: var(--font-mono);
  font-size: var(--font-size-mono);
}
.tag-row {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
  margin-top: var(--space-1);
}
.tag {
  padding: 2px var(--space-2);
  font-size: var(--font-size-eyebrow);
  color: var(--accent);
  background: rgba(167, 139, 250, 0.12);
  border-radius: var(--radius-full);
}
</style>
