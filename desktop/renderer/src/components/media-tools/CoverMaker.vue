<script setup lang="ts">
// ═══════════════════════════════════════════════════════════════
// CoverMaker.vue — 封面制作
// 图层编辑：背景 / 商品图 / 文本 / Logo → 选择尺寸与数量
// → POST /workflow/run（封面工作流 JSON）→ SSE 流式进度
// → 结果画廊，逐张下载
// 契约核对 2026-08-29：openapi-latest.json 无 /workflow/run 端点（相近端点：
//   /workflows/{workflow_id}/run 为 multipart 路径式、/workflow/execute 为
//   引擎级 multipart 执行，均非当前 JSON 提交形态）→ 契约缺失，保留现有
//   提交结构，待服务端核对后对齐（docs BUSINESS_ALIGNMENT M5 行已登记）。
// M5 增量（用户裁决：接受服务端模板渲染链路，补模板选择 + AI 文案参数）：
//   · 封面模板（可选）：openapi 契约无封面模板列表接口 → 暂手动输入模板标识
//     （对齐 CoverRequest.template），契约补充后改下拉/网格，见 cover-workflow-logic.ts
//   · AI 文案：封面参考文案（对齐原版 copy_input）→ 服务端 LLM（llm:chat，
//     契约存在）提炼标题/副标题 → 填 aiTitle/aiSubtitle → 随提交透传 title。
// 提交参数编组/文案解析在 cover-workflow-logic.ts（纯函数可单测）。
// ═══════════════════════════════════════════════════════════════
import { ref, computed, onBeforeUnmount } from 'vue'
import TButton from '@/components/common/TButton.vue'
import { useFilePicker } from '@/composables/useFilePicker'
import { buildCoverWorkflow, parseAiCopyJson } from './cover-workflow-logic'

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

// ── M5：模板与 AI 文案参数 ──
const templateId = ref('')            // 封面模板标识（可选，契约无列表接口暂手动填写）
const copyText = ref('')              // 封面参考文案（原版 copy_input，AI 提炼标题/副标题用）
const aiTitle = ref('')               // AI 建议/手动填写的标题（随提交透传 title）
const aiSubtitle = ref('')            // AI 建议的副标题（可编辑，辅助文案）

// ── 参数 ──
const size = ref<SizeRatio>('1:1')
const count = ref<number>(4)

// ── 运行状态 ──
const runId = ref('')
const isProcessing = ref(false)
const aiGenerating = ref(false)
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

/** 构建封面工作流 JSON（纯函数在 cover-workflow-logic.ts） */
function buildWorkflow(): Record<string, unknown> {
  return buildCoverWorkflow({
    size: size.value,
    count: count.value,
    bgColor: bgColor.value,
    bgTransparent: bgTransparent.value,
    productPath: productPath.value,
    textContent: textContent.value,
    logoPath: logoPath.value,
    template: templateId.value,
    title: aiTitle.value
  })
}

/**
 * M5 AI 文案：封面参考文案 → 服务端 LLM（llm:chat，契约存在）提炼
 * 标题/副标题（对齐原版 _ai_suggest + CoverTextAIWorker：sys prompt 只输出
 * JSON {"title","subtitle"}，temperature=0.6）。
 */
const AI_COPY_SYSTEM_PROMPT =
  '你是短视频封面文案专家。根据提供的文案提炼封面用的【标题】与【副标题】：' +
  '标题≤10字、强冲击；副标题≤16字、补充信息。只输出 JSON：{"title": "...", "subtitle": "..."}，不要多余内容。'

async function aiSuggestCopy() {
  const src = copyText.value.trim()
  if (!src || isProcessing.value || aiGenerating.value) return
  aiGenerating.value = true
  errorMsg.value = ''
  statusText.value = 'AI 建议中…'
  try {
    const t = window.tintin.server
    if (!t?.llmChat) throw new Error('服务端 LLM 不可用')
    const r = await t.llmChat({
      model: '',
      messages: [
        { role: 'system', content: AI_COPY_SYSTEM_PROMPT },
        { role: 'user', content: `文案：\n${src}` }
      ],
      temperature: 0.6
    })
    if (r === null || r === undefined) throw new Error('服务端离线或未返回内容')
    if ('error' in r && r.error) throw new Error(String(r.error))
    const content = String(r?.choices?.[0]?.message?.content || '')
    const parsed = parseAiCopyJson(content)
    if (parsed) {
      aiTitle.value = parsed.title
      aiSubtitle.value = parsed.subtitle
      statusText.value = '已生成标题/副标题，可修改后生成'
    } else {
      aiTitle.value = content.slice(0, 20) // 原版 safe_json_parse 失败 → 整段截断作标题
      aiSubtitle.value = ''
      statusText.value = 'AI 返回无法解析，已截断填入标题'
    }
  } catch (err) {
    errorMsg.value = err instanceof Error ? err.message : String(err)
    statusText.value = '失败'
  } finally {
    aiGenerating.value = false
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

    <!-- M5：模板与 AI 文案参数（保持服务端模板渲染链路，不引入画布编辑器） -->
    <div class="form-grid">
      <div class="form-field">
        <label class="form-label">封面模板（可选）</label>
        <input
          v-model="templateId"
          type="text"
          class="text-input"
          placeholder="模板标识（模板库列表接口契约未就绪，暂手动填写）"
          :disabled="isProcessing"
        />
      </div>
      <div class="form-field">
        <label class="form-label">封面标题（随提交透传 title）</label>
        <input
          v-model="aiTitle"
          type="text"
          class="text-input"
          placeholder="AI 建议或手动填写"
          :disabled="isProcessing"
        />
      </div>
    </div>

    <!-- M5：AI 文案生成（封面参考文案 → 服务端 LLM 提炼标题/副标题，对齐原版 _ai_suggest） -->
    <div class="layer">
      <div class="layer__head">
        <span class="layer__title">封面文案（AI 提炼标题/副标题）</span>
      </div>
      <textarea
        v-model="copyText"
        class="text-area"
        rows="2"
        placeholder="粘贴商品卖点/脚本文案，AI 据此生成标题与副标题（可选）"
        :disabled="isProcessing || aiGenerating"
      />
      <div class="layer__row">
        <input
          v-model="aiSubtitle"
          type="text"
          class="text-input"
          placeholder="副标题（AI 生成或手动填写）"
          :disabled="isProcessing || aiGenerating"
        />
        <TButton
          label="AI 建议标题/副标题"
          icon="edit"
          size="small"
          variant="secondary"
          :loading="aiGenerating"
          :disabled="isProcessing || !copyText.trim()"
          @click="aiSuggestCopy"
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
/* M5：AI 文案行（副标题输入 + 建议按钮 水平排列） */
.layer__row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}
.layer__row .text-input {
  flex: 1 1 auto;
  min-width: 0;
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
