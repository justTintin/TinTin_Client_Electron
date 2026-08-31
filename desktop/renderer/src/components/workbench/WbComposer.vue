<script setup lang="ts">
// WbComposer.vue — 工作台底部输入区（重排定稿 2026-08-28）
// 结构：上下文胶囊行（产品/素材池/脚本/本地附件，原版「上下文」区）
//   → textarea 输入框（加宽）→ 容器内底部工具行：上传图标 + 选择产品/素材/脚本
//     入口 + 右下发送图标（保持最右）
//   → 智能体快捷条独立一行（输入框容器外部下方；首项「对话」= llm 直连；
//     超出宽度折叠进「更多」浮层）+ 列表失败提示
//   → 提示行：Enter 快捷键说明 + 转编排任务开关（agent 模式）
// 技能入口：工具行「⚙技能」打开技能管理弹窗（open-skills → 容器），本地技能
//   与智能体同构合并进快捷条/斜杠菜单（skillsLogic，原版 _on_agents_loaded 口径）。
// 移除：模式分段切换与模型下拉（模型只读 llm.defaultModel 偏好，系统设置可改）。
// 斜杠菜单：输入 / 唤起智能体候选（isAgentPrefix/filterSlashCandidates），
// 选中插入唤醒词（applyAgentWakeInsert，原版 _SlashPopup L294-361 口径）。
// 仅绘制 + 事件转发：模式/附件/上下文业务在 useWorkbenchChat /
// useWorkbenchAgents，弹窗与会话编排在本容器（Workbench.vue）。
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import type { ChatMode, ChatAttachment } from '@/composables/workbenchChatLogic'
import {
  type QuickEntry,
  type WorkbenchAgent,
  type CtxProductItem,
  type CtxMaterialItem,
  type CtxScriptItem,
  productLabel,
  productSummary,
  materialLabel,
  materialSummary,
  scriptLabel,
  scriptSummary,
  detectSlashKeyword,
  isAgentPrefix,
  filterSlashCandidates,
  applyAgentWakeInsert,
  estimateEntryWidth,
  fitQuickBar
} from '@/composables/workbenchChatContext'
import WbSlashPopup from './WbSlashPopup.vue'
import { applySkillWakeInsert, type SkillCandidate } from '@/composables/skillsLogic'

const props = defineProps<{
  modelValue: string
  /** 发送中（防重入：发送按钮禁用，原版 _send_text L1240-1241 口径） */
  sending?: boolean
  /** 对话模式：agent=智能体 / llm=通用对话（快捷条选中，容器编排新会话） */
  mode?: ChatMode
  /** 「转编排任务」开关（原版 chk_plan L1130-1135 默认勾选，仅智能体模式展示） */
  planMode?: boolean
  /** 会话附件上下文胶囊（含素材库引用 materialId 与本地文件两类） */
  attachments?: ChatAttachment[]
  /** 产品上下文胶囊（单选覆盖） */
  ctxProduct?: CtxProductItem | null
  /** 脚本上下文胶囊（按 id 去重多选） */
  ctxScripts?: CtxScriptItem[]
  /** 智能体快捷条条目（首项「对话」+ 服务端智能体，useWorkbenchAgents） */
  entries?: QuickEntry[]
  /** 当前选中条目 key（llm 直连=CHAT_ENTRY_KEY，智能体=agent_id） */
  selectedKey?: string
  /** 服务端智能体 + 本地技能（斜杠候选数据源，技能 source='skill'） */
  agents?: (WorkbenchAgent | SkillCandidate)[]
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void
  (e: 'send'): void
  (e: 'keydown', ev: KeyboardEvent): void
  (e: 'update:planMode', value: boolean): void
  (e: 'attachments-picked', paths: string[]): void
  /** 剪贴板截图贴入附件池（截图只提供信息，不入素材池） */
  (e: 'screenshots-picked', paths: string[]): void
  (e: 'remove-attachment', index: number): void
  (e: 'remove-product'): void
  (e: 'remove-script', index: number): void
  (e: 'pick-product'): void
  (e: 'pick-material'): void
  (e: 'pick-script'): void
  /** 打开技能管理弹窗（⚙技能，原版 L1136-1141 工具行入口） */
  (e: 'open-skills'): void
  (e: 'select-entry', key: string): void
}>()

const innerText = computed({
  get: () => props.modelValue,
  set: (v) => emit('update:modelValue', v)
})

const textareaRef = ref<HTMLTextAreaElement | null>(null)
const fileInputRef = ref<HTMLInputElement | null>(null)

/** 原 createSession 内 inputRef.value?.focus() 的等价实现 */
function focus() {
  textareaRef.value?.focus()
}

/** 粘贴：纯文本正常插入（对齐原版 insertFromMimeData 文本分支）；
 *  剪贴板图片（截图）→ env.pasteImage 保存为本地 PNG → 截图附件
 *  （2026-08-30 用户裁决：截图直接贴入附件池，不入素材池，仅提供信息）。 */
async function onPaste(e: ClipboardEvent) {
  const dt = e.clipboardData
  if (!dt) return
  // 剪贴板含图片文件（截图）→ 调主进程存本地 PNG，作为截图附件
  if (dt.files.length) {
    e.preventDefault()
    await pasteScreenshot()
    return
  }
  const text = dt.getData('text/plain')
  if (!text) return // 无纯文本形式（纯 HTML/图片）→ 不插入
  e.preventDefault() // 拦截默认插入，手动以纯文本写入（富文本降级）
  const ta = textareaRef.value
  const cur = innerText.value
  if (!ta) { innerText.value = cur + text; return }
  const s = ta.selectionStart ?? cur.length
  const en = ta.selectionEnd ?? s
  innerText.value = cur.slice(0, s) + text + cur.slice(en)
  void nextTick(() => { ta.selectionStart = ta.selectionEnd = s + text.length })
}

/** 剪贴板图片（截图）→ 主进程保存本地 PNG → 截图信息附件（不入素材池） */
async function pasteScreenshot() {
  const t = (window as any).tintin
  if (!t?.env?.pasteImage) return // 预览环境：无 IPC，跳过
  try {
    const r = await t.env.pasteImage()
    if (r?.ok && r.path) emit('screenshots-picked', [r.path])
  } catch (_) { /* 截图保存失败静默：不阻塞粘贴 */ }
}

/** 引用回复后聚焦并移动光标到末尾（原版 _on_quote moveCursor(QTextCursor.End) + setFocus） */
async function focusEnd() {
  await nextTick()
  const el = textareaRef.value
  if (!el) return
  el.focus()
  const len = el.value.length
  el.setSelectionRange(len, len)
}

/** Electron 渲染层 File.path 取本地绝对路径（与 LiveClip/VideoMontage 同模式） */
function onFilesChange(e: Event) {
  const input = e.target as HTMLInputElement
  const paths = Array.from(input.files || [])
    .map((f) => (f as File & { path?: string }).path || '')
    .filter(Boolean)
  if (paths.length) emit('attachments-picked', paths)
  input.value = '' // 允许重复选择同一文件
}

/* ── 拖入文件加入会话附件（对齐原版输入框拖放：filesDropped → _add_attachment_files；
      与上传按钮共用 attachments-picked 链路，路径去重/入池逻辑同源） ── */
const dragActive = ref(false)
let dragDepth = 0

function onDragEnter() {
  dragDepth += 1
  dragActive.value = true
}

function onDragLeave() {
  dragDepth = Math.max(0, dragDepth - 1)
  if (!dragDepth) dragActive.value = false
}

function onDragOver(e: DragEvent) {
  e.preventDefault() // 允许 drop 触发
  dragActive.value = true
}

function onDrop(e: DragEvent) {
  dragDepth = 0
  dragActive.value = false
  const files = e.dataTransfer?.files
  if (!files || !files.length) return // 纯文本/其他拖放走默认行为（textarea 正常插入）
  e.preventDefault() // 文件拖放整体拦截：不落为 file:// 路径文本（原版 L169 同口径）
  const paths = Array.from(files)
    .map((f) => (f as File & { path?: string }).path || '')
    .filter(Boolean)
  if (paths.length) emit('attachments-picked', paths)
}

function onPlanToggle(e: Event) {
  emit('update:planMode', (e.target as HTMLInputElement).checked)
}

/* ── 斜杠菜单（原版 _SlashPopup：/ 或 /关键字 唤起候选，选中插唤醒词） ── */
const slashKeyword = ref<string | null>(null)
const slashIndex = ref(0)

const slashCandidates = computed(() =>
  filterSlashCandidates(props.agents || [], slashKeyword.value || '')
)

const slashOpen = computed(() => {
  if (slashKeyword.value === null) return false
  return isAgentPrefix(props.agents || [], slashKeyword.value)
})

/** 光标前文本段变化后重算斜杠关键字（原版 _ChatInput._on_text_changed L189-192） */
function updateSlash() {
  const el = textareaRef.value
  if (!el) return
  slashKeyword.value = detectSlashKeyword(el.value, el.selectionStart ?? el.value.length)
  slashIndex.value = 0
}

function closeSlash() {
  slashKeyword.value = null
  slashIndex.value = 0
}

/** 斜杠选中：光标前 /关键字 段替换为唤醒词（原版 _SlashPopup._insert_agent）。
 *  技能候选用技能前缀（请按技能【…】执行），智能体用智能体唤醒词。 */
async function insertWake(agent: WorkbenchAgent | SkillCandidate) {
  const el = textareaRef.value
  const caret = el?.selectionStart ?? props.modelValue.length
  const r = (agent as SkillCandidate).source === 'skill'
    ? applySkillWakeInsert(props.modelValue, caret, agent as SkillCandidate)
    : applyAgentWakeInsert(props.modelValue, caret, agent)
  emit('update:modelValue', r.text)
  closeSlash()
  await nextTick()
  if (el) {
    el.focus()
    el.setSelectionRange(r.caret, r.caret)
  }
}

/** 键盘分流：斜杠菜单打开时 ↑↓/Enter/Escape 优先菜单操作，其余上报容器 */
function onKeydown(e: KeyboardEvent) {
  if (slashOpen.value && slashCandidates.value.length) {
    if (e.key === 'Escape') {
      closeSlash()
      e.preventDefault()
      e.stopPropagation()
      return
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const n = slashCandidates.value.length
      slashIndex.value = (slashIndex.value + (e.key === 'ArrowDown' ? 1 : n - 1)) % n
      e.preventDefault()
      e.stopPropagation()
      return
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      const agent = slashCandidates.value[slashIndex.value]
      if (agent) {
        void insertWake(agent)
        e.preventDefault()
        e.stopPropagation()
        return
      }
    }
  }
  emit('keydown', e)
}

/* ── 智能体快捷条收纳（原版 _AgentBar L776-807：按可用宽度折叠 → 「更多」） ── */
const quickbarRef = ref<HTMLElement | null>(null)
const quickAvail = ref(9999) // 初值放宽：挂载测量前不折叠（避免闪烁）
const moreOpen = ref(false)
let resizeOb: ResizeObserver | null = null

onMounted(() => {
  const el = quickbarRef.value
  if (!el) return
  quickAvail.value = el.clientWidth || 9999
  if ('ResizeObserver' in window) {
    resizeOb = new ResizeObserver((entries) => {
      for (const en of entries) quickAvail.value = en.contentRect.width
    })
    resizeOb.observe(el)
  }
})

onBeforeUnmount(() => resizeOb?.disconnect())

const quickFit = computed(() =>
  fitQuickBar(
    (props.entries || []).map((e) => estimateEntryWidth(e.name)),
    quickAvail.value
  )
)

const visibleEntries = computed(() => (props.entries || []).slice(0, quickFit.value.count))
const hiddenEntries = computed(() => (props.entries || []).slice(quickFit.value.count))

/** 「更多」浮层选中：上报容器并收起浮层 */
function onMorePick(key: string) {
  moreOpen.value = false
  emit('select-entry', key)
}

/* ── 上下文胶囊行（原版 _rebuild_ctx_bar L1567-1595 口径：产品→素材→脚本→附件） ── */
const STATE_LABEL: Record<ChatAttachment['state'], string> = {
  pending: '待入池（发送后加入会话素材池）',
  uploading: '入池中…',
  pooled: '已入会话素材池（后续轮次自动注入）',
  failed: '入池失败（下次发送自动重试）'
}

const hasCtxPills = computed(
  () => !!props.ctxProduct || !!(props.attachments?.length) || !!(props.ctxScripts?.length)
)

function attLabel(a: ChatAttachment): string {
  return a.materialId ? materialLabel((a.material || {}) as CtxMaterialItem) : a.name
}

function attTitle(a: ChatAttachment): string {
  const head = a.materialId ? materialSummary((a.material || {}) as CtxMaterialItem) : a.path
  return `${head}\n${STATE_LABEL[a.state]}`
}

defineExpose({ focus, focusEnd })
</script>

<template>
  <!-- ─── 输入区 ─── -->
  <div class="input-bar">
    <!-- 上下文胶囊（原版：显示在输入框上方，点击 × 移除；选择项不删除则持续携带） -->
    <div v-if="hasCtxPills" class="ctx-pills">
      <span
        v-if="ctxProduct"
        class="ctx-pill ctx-pill--product"
        :title="productSummary(ctxProduct)"
      >
        {{ productLabel(ctxProduct) }}
        <button class="pill-x" aria-label="移除产品" @click="emit('remove-product')">×</button>
      </span>
      <span
        v-for="(a, i) in attachments"
        :key="a.materialId || a.path || i"
        class="ctx-pill"
        :class="a.state"
        :title="attTitle(a)"
      >
        {{ attLabel(a) }}
        <button class="pill-x" :aria-label="'移除 ' + a.name" @click="emit('remove-attachment', i)">×</button>
      </span>
      <span
        v-for="(s, i) in ctxScripts"
        :key="'s-' + i"
        class="ctx-pill ctx-pill--script"
        :title="scriptSummary(s)"
      >
        {{ scriptLabel(s) }}
        <button class="pill-x" :aria-label="'移除脚本 ' + s.topic" @click="emit('remove-script', i)">×</button>
      </span>
    </div>

    <!-- 豆包式一体输入容器：上部 textarea + 底部工具行（视觉一体）；
         支持从资源管理器拖入文件加入会话附件（对齐原版输入框拖放口径 L141-176） -->
    <div
      class="input-wrap"
      :class="{ 'drag-active': dragActive }"
      @dragover="onDragOver"
      @dragenter="onDragEnter"
      @dragleave="onDragLeave"
      @drop="onDrop"
    >
      <WbSlashPopup
        :visible="slashOpen"
        :candidates="slashCandidates"
        :active-index="slashIndex"
        @select="insertWake"
      />
      <textarea
        ref="textareaRef"
        v-model="innerText"
        class="chat-input"
        rows="4"
        placeholder="输入消息，/ 唤起智能体…"
        @keydown="onKeydown"
        @paste="onPaste"
        @input="updateSlash"
        @click="updateSlash"
        @keyup="updateSlash"
      ></textarea>
      <!-- 容器内底部工具行：上传 → 产品/素材/脚本 → 智能体快捷条（更多折叠） → 右侧发送 -->
      <div class="input-tools">
      <button class="tool-ic" title="上传本地文件加入会话素材池" @click="fileInputRef?.click()">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="17 8 12 3 7 8" />
          <line x1="12" y1="3" x2="12" y2="15" />
        </svg>
      </button>
      <button class="tool-chip" title="选择产品作为对话上下文（单选覆盖）" @click="emit('pick-product')">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
          <path d="M21 8l-9-5-9 5 9 5 9-5z" />
          <path d="M3 8v8l9 5 9-5V8" />
        </svg>
        产品
      </button>
      <button class="tool-chip" title="选择素材加入会话素材池" @click="emit('pick-material')">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <circle cx="8.5" cy="8.5" r="1.5" />
          <path d="m21 15-5-5L5 21" />
        </svg>
        素材
      </button>
      <button class="tool-chip" title="选择分镜脚本作为对话上下文（可多选）" @click="emit('pick-script')">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <path d="M14 2v6h6" />
          <path d="M8 13h8M8 17h5" />
        </svg>
        脚本
      </button>

      <!-- 技能入口（原版 L1136-1141：安装/管理本地技能；安装后与智能体一样
           出现在快捷条和斜杠菜单，2026-08-31 技能入口移植） -->
      <button class="tool-chip" title="安装/管理本地技能；安装后与智能体一样出现在快捷条和斜杠菜单" @click="emit('open-skills')">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
        技能
      </button>

      <!-- 发送键保留在最右侧（工具行行尾） -->
      <div class="input-actions">
        <button class="action-send" title="发送" :disabled="sending" @click="emit('send')">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="m22 2-7 20-4-9-9-4 20-7z" />
            <path d="M22 2 11 13" />
          </svg>
        </button>
      </div>
    </div>
    </div>

    <!-- 底部信息行：智能体快捷条（含「对话」首项）在左，「转编排任务」在右——
         2026-08-30 用户裁决：快捷条不单独占行，并入本行转编排任务之前 -->
    <div class="input-foot">
      <div ref="quickbarRef" class="quick-bar">
        <button
          v-for="e in visibleEntries"
          :key="e.key"
          class="quick-pill"
          :class="{ active: e.key === selectedKey }"
          type="button"
          :title="e.desc"
          @click="emit('select-entry', e.key)"
        >
          {{ e.name }}
        </button>
        <button
          v-if="quickFit.more && !moreOpen"
          class="quick-pill quick-more"
          type="button"
          title="展开全部智能体"
          @click="moreOpen = true"
        >
          更多
        </button>

        <!-- 「更多」浮层：列出折叠的智能体（原版 _AgentBar 展开口径） -->
        <div v-if="moreOpen && hiddenEntries.length" class="quick-more-pop">
          <button
            v-for="e in hiddenEntries"
            :key="e.key"
            class="quick-more-row"
            type="button"
            :title="e.desc"
            @click="onMorePick(e.key)"
          >
            {{ e.name }}
          </button>
        </div>
      </div>

      <span class="foot-hint">Enter 发送，Shift + Enter 换行，输入 / 唤起智能体</span>
      <label
        v-if="mode === 'agent'"
        class="plan-check"
        title="勾选后对话先转为编排任务提交服务端自动执行（回复返回任务 ID）"
      >
        <input type="checkbox" :checked="planMode" @change="onPlanToggle" />
        转编排任务
      </label>
    </div>

    <input ref="fileInputRef" type="file" multiple class="hidden-file" @change="onFilesChange" />
  </div>
</template>

<style scoped>
/* ─── 输入区（加宽：48rem → 64rem） ─── */
.input-bar {
  flex: 0 0 auto;
  padding: var(--space-4);
  background: var(--surface);
  border-top: 1px solid var(--border);
}

/* 豆包式一体输入容器：圆角容器 = 上部 textarea + 底部工具行 */
.input-wrap {
  max-width: 64rem;
  margin: 0 auto;
  position: relative;
  background: var(--surface-container);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  transition: all var(--duration-fast);
}

.input-wrap:focus-within {
  border-color: var(--primary);
  box-shadow: 0 0 0 3px var(--ring);
  background: var(--card);
}

/* 拖入文件悬停高亮（对齐 focus 视觉；drop 后经 dragDepth 计数复位） */
.input-wrap.drag-active {
  border-color: var(--primary);
  box-shadow: 0 0 0 3px var(--ring);
  background: var(--card);
}

.chat-input {
  display: block;
  width: 100%;
  min-height: 112px;
  padding: var(--space-4) var(--space-4) var(--space-2);
  background: transparent;
  border: none;
  color: var(--foreground);
  font-size: var(--font-size-body);
  line-height: var(--line-height-body);
  outline: none;
  resize: none;
}

/* 发送键保留最右（工具行行尾，随行高对齐） */
.input-actions {
  flex: 0 0 auto;
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.action-send {
  width: 36px;
  height: 36px;
  border-radius: var(--radius-lg);
  background: var(--primary);
  color: var(--primary-foreground);
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all var(--duration-fast);
}

.action-send:hover {
  filter: brightness(1.1);
}

.action-send:disabled {
  opacity: 0.5;
  cursor: not-allowed;
  filter: none;
}

/* 隐藏的原生文件选择（上传按钮经 ref 触发） */
.hidden-file {
  display: none;
}

/* ─── 容器内底部工具行：上传 / 弹窗入口 / 发送（智能体快捷条已移出容器） ─── */
.input-tools {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-height: 44px;
  padding: var(--space-1) var(--space-2) var(--space-2) var(--space-2);
  border-top: 1px solid transparent;
}

.tool-ic {
  width: 32px;
  height: 32px;
  flex: 0 0 auto;
  border-radius: var(--radius-lg);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--muted-foreground);
  transition: all var(--duration-fast);
}

.tool-ic:hover {
  background: var(--surface-container-high);
  color: var(--foreground);
}

.tool-chip {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 26px;
  padding: 0 10px;
  font-size: 12px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--surface-container);
  color: var(--muted-foreground);
  white-space: nowrap;
  transition: all var(--duration-fast);
}

.tool-chip:hover {
  border-color: var(--primary);
  color: var(--primary);
}

/* ─── 智能体快捷条（首项「对话」；超出宽度折叠进「更多」浮层。
        2026-08-30 并入底部信息行左侧，不再独立占行） ─── */
.quick-bar {
  flex: 1 1 auto;
  min-width: 0;
  position: relative;
  display: flex;
  align-items: center;
  gap: 6px;
  overflow: hidden;
}

.quick-pill {
  flex: 0 0 auto;
  max-width: 120px;
  height: 24px;
  padding: 0 13px;
  font-size: 12px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: transparent;
  color: var(--muted-foreground);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  transition: all var(--duration-fast);
}

.quick-pill:hover {
  border-color: var(--primary);
  color: var(--primary);
}

.quick-pill.active {
  background: var(--primary);
  border-color: var(--primary);
  color: var(--primary-foreground);
}

.quick-more-pop {
  position: absolute;
  left: 0;
  bottom: calc(100% + 6px);
  z-index: 30;
  min-width: 160px;
  max-height: 240px;
  overflow-y: auto;
  padding: 6px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-modal);
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.quick-more-row {
  padding: 6px var(--space-2);
  font-size: 12px;
  color: var(--foreground);
  border-radius: var(--radius-md);
  text-align: left;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  transition: background var(--duration-fast);
}

.quick-more-row:hover {
  background: var(--surface-container-high);
}

/* ─── 上下文胶囊（原版「上下文」区） ─── */
.ctx-pills {
  max-width: 64rem;
  margin: 0 auto var(--space-2);
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.ctx-pill {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: 220px;
  padding: 2px 4px 2px 10px;
  font-size: 12px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--surface-container);
  color: var(--foreground);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.ctx-pill--product {
  border-color: var(--primary);
  color: var(--primary);
}

.ctx-pill--script {
  border-color: var(--primary);
  color: var(--primary);
}

.ctx-pill.pooled {
  border-color: var(--primary);
  color: var(--primary);
}

.ctx-pill.uploading,
.ctx-pill.pending {
  color: var(--muted-foreground);
}

.ctx-pill.failed {
  border-color: var(--destructive, #e5484d);
  color: var(--destructive, #e5484d);
}

.pill-x {
  width: 18px;
  height: 18px;
  line-height: 1;
  border-radius: 999px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: inherit;
  font-size: 13px;
}

.pill-x:hover {
  background: var(--surface-container-high);
}

/* ─── 底部信息行：快捷条（左） + 键位提示 / 转编排任务（右） ─── */
.input-foot {
  max-width: 64rem;
  margin: var(--space-3) auto 0;
  display: flex;
  align-items: center;
  gap: var(--space-3);
  font-size: 11px;
  color: var(--muted-foreground);
}

.foot-hint {
  flex: 0 0 auto;
  margin-left: auto;
  white-space: nowrap;
}

.plan-check {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  cursor: pointer;
  white-space: nowrap;
  color: var(--muted-foreground);
}

.plan-check input {
  accent-color: var(--primary);
  cursor: pointer;
}
</style>
