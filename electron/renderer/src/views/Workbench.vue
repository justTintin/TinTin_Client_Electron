<script setup lang="ts">
// ═══════════════════════════════════════════════════════════════
// Workbench.vue — 工作台（聊天会话界面）
// 结构：左侧 260px 会话侧栏（新建会话/分组会话列表/系统设置）
//       中间主区：消息流 + 底部输入框（上传/发送按钮 + 快捷键提示）
// 厚壳化补充：
//   · 消费 appStore.pendingExtract（浏览器"解析并导入"按钮推送的数据）
//     → 作为 AI 消息展示平台抽取结果（结构化数据卡）
// ═══════════════════════════════════════════════════════════════

import { ref, nextTick, onMounted, onBeforeUnmount, watch, type Ref } from 'vue'
import { useRouter } from 'vue-router'
import { useAppStore, type BrowserExtractPayload } from '@/stores/app'

const router = useRouter()
const appStore = useAppStore()

/* ── 会话列表数据 ──────────────────────────────────────────── */
interface Session {
  id: string
  title: string
  subtitle: string
  group: 'today' | 'yesterday' | 'earlier'
}

const sessions = ref<Session[]>([
  { id: 's1', title: 'JBL CHARGE6 脚本创作', subtitle: '生成 3 个镜头，等待确认', group: 'today' },
  { id: 's2', title: '产品卖点提炼',       subtitle: '已输出 5 条卖点',           group: 'today' },
  { id: 's3', title: 'BOSE 音箱对比分析',   subtitle: '已完成',                   group: 'yesterday' },
  { id: 's4', title: '618 大促话术库',       subtitle: '已生成 12 条话术',         group: 'yesterday' },
  { id: 's5', title: '竞品拆解 · 索尼 SRS', subtitle: '已归档',                   group: 'earlier' }
])

const activeSessionId = ref<string>('s1')

/* ── 消息数据 ──────────────────────────────────────────────── */
type Role = 'user' | 'ai'

interface ExtractCard {
  /** 抽取来源平台（中文显示名） */
  platformName: string
  /** 抽取时间（毫秒） */
  extractedAt: number
  /** 原始结构化数据 */
  raw: any
  /** 人类可读摘要项（key-value 展示） */
  summary: Array<{ label: string; value: string }>
}

interface ChatMessage {
  id: string
  role: Role
  content: string
  shots?: Array<{ index: number; label: string; desc: string }>
  /** 浏览器解析导入的数据卡片（extract→工作台） */
  extract?: ExtractCard
}

const messages = ref<ChatMessage[]>([
  {
    id: 'm1',
    role: 'ai',
    content: '你好，我是螺丝钉电商智能体。今天需要我帮你做什么？可以输入产品名、上传参考图，或直接让我生成脚本。'
  },
  {
    id: 'm2',
    role: 'user',
    content: '帮我为 JBL CHARGE6 写一条 15 秒电商短视频脚本，风格年轻化，突出户外便携。'
  },
  {
    id: 'm3',
    role: 'ai',
    content: '已为你生成脚本，分为 3 个镜头：',
    shots: [
      { index: 1, label: '特写 · 3s', desc: 'JBL CHARGE6 置于背包侧袋，阳光掠过。' },
      { index: 2, label: '近景 · 5s', desc: '手指一键播放，节奏灯随鼓点跳动。' },
      { index: 3, label: '中景 · 7s', desc: '露营场景，好友围坐，音乐响起。' }
    ]
  }
])

/* ── 输入框交互 ───────────────────────────────────────────── */
const inputRef = ref<HTMLTextAreaElement | null>(null)
const inputText = ref<string>('')
const messageListRef = ref<HTMLDivElement | null>(null)

function selectSession(id: string) {
  activeSessionId.value = id
  // 实际项目中这里会拉取该会话的历史消息
}

function createSession() {
  const newId = 's' + Date.now()
  sessions.value.unshift({
    id: newId,
    title: '新会话',
    subtitle: '开始输入…',
    group: 'today'
  })
  activeSessionId.value = newId
  messages.value = [
    {
      id: 'm-welcome',
      role: 'ai',
      content: '你好，我是螺丝钉电商智能体。告诉我你的产品信息，我来帮你创作脚本。'
    }
  ]
  inputRef.value?.focus()
}

function scrollToBottom() {
  nextTick(() => {
    const el = messageListRef.value
    if (el) el.scrollTop = el.scrollHeight
  })
}

function handleSend() {
  const text = inputText.value.trim()
  if (!text) return
  // 用户消息
  messages.value.push({
    id: 'u' + Date.now(),
    role: 'user',
    content: text
  })
  inputText.value = ''
  scrollToBottom()
  // 模拟 AI 回复（占位）
  setTimeout(() => {
    messages.value.push({
      id: 'a' + Date.now(),
      role: 'ai',
      content: '收到你的需求，正在分析产品卖点并生成脚本大纲…'
    })
    scrollToBottom()
  }, 500)
}

function handleKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    handleSend()
  }
}

function openSettings() {
  router.push('/settings')
}

/* ── 会话分组 ──────────────────────────────────────────────── */
function sessionsByGroup(group: Session['group']) {
  return sessions.value.filter((s) => s.group === group)
}

const groupLabels: Record<Session['group'], string> = {
  today: '今天',
  yesterday: '昨天',
  earlier: '更早'
}

/* ── 消费：浏览器"解析并导入"推送的 payload ──────────────── */
/** 从抽取的原始 data 中粗略挑选 N 个 key-value 作为摘要（不同平台字段不同，尽量兜底展示） */
function _summarizeExtract(data: any): ExtractCard['summary'] {
  const out: ExtractCard['summary'] = []
  if (!data) return out
  // data 可能是对象或数组
  if (Array.isArray(data)) {
    out.push({ label: '条目数', value: String(data.length) })
    // 取第 0 项的前几个字段
    if (data.length > 0 && typeof data[0] === 'object' && data[0] !== null) {
      const keys = Object.keys(data[0]).slice(0, 4)
      for (const k of keys) {
        const v = (data[0] as any)[k]
        out.push({ label: `样本.${k}`, value: typeof v === 'string' || typeof v === 'number' ? String(v) : JSON.stringify(v).slice(0, 60) })
      }
    }
    return out
  }
  if (typeof data === 'object' && data !== null) {
    const keys = Object.keys(data).slice(0, 8)
    for (const k of keys) {
      const v = (data as any)[k]
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
        out.push({ label: k, value: String(v) })
      } else if (Array.isArray(v)) {
        out.push({ label: k, value: `[Array ×${v.length}]` })
      } else if (v && typeof v === 'object') {
        out.push({ label: k, value: `{Object}` })
      }
    }
  }
  return out
}

function consumeExtract(payload: BrowserExtractPayload): void {
  const summary = _summarizeExtract(payload.data)
  // 先写一条用户消息：记录"从XX平台导入"
  const now = Date.now()
  messages.value.push({
    id: 'u' + now,
    role: 'user',
    content: `从【${payload.platformName}】解析并导入数据。`,
  })
  // 再写一条 AI 消息：附数据卡片
  messages.value.push({
    id: 'a' + (now + 1),
    role: 'ai',
    content: `已接收来自 ${payload.platformName} 的结构化数据，请确认下方内容无误后告诉我下一步需求（生成脚本 / 提炼卖点 / 对比竞品等）。`,
    extract: {
      platformName: payload.platformName,
      extractedAt: payload.extractedAt,
      raw: payload.data,
      summary,
    },
  })
  scrollToBottom()
}

/* ── watch appStore.pendingExtract：一旦 Browser 推送就消费（支持页面已打开时 receive） ── */
let _stopWatchExtract: (() => void) | null = null

onMounted(() => {
  scrollToBottom()
  // 1) 先消费可能在跳转前就已经写入 store 的 pending 载荷
  if (appStore.pendingExtract) {
    const p = appStore.pendingExtract
    appStore.clearPendingExtract()
    consumeExtract(p)
  }
  // 2) watch 后续变化（极端情况：页面已打开，Browser 侧 push）
  _stopWatchExtract = watch(
    () => appStore.pendingExtract,
    (v) => {
      if (!v) return
      const p = v
      appStore.clearPendingExtract()
      consumeExtract(p)
    },
  )
})

onBeforeUnmount(() => {
  if (_stopWatchExtract) {
    try { _stopWatchExtract() } catch (_) {}
    _stopWatchExtract = null
  }
})
</script>

<template>
  <section class="workbench">
    <!-- ─── 左侧会话侧栏 260px ─── -->
    <aside class="sidebar">
      <div class="sidebar-top">
        <button class="btn btn-secondary w-full h-btn text-sm new-session" @click="createSession">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M12 5v14" />
            <path d="M5 12h14" />
          </svg>
          新建会话
        </button>
      </div>

      <div class="session-list custom-scroll">
        <template v-for="g in (['today', 'yesterday', 'earlier'] as const)" :key="g">
          <template v-if="sessionsByGroup(g).length">
            <div class="group-label">{{ groupLabels[g] }}</div>
            <div
              v-for="s in sessionsByGroup(g)"
              :key="s.id"
              class="session-item"
              :class="{ active: activeSessionId === s.id }"
              @click="selectSession(s.id)"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              </svg>
              <div class="session-text">
                <div class="session-title">{{ s.title }}</div>
                <div class="session-sub">{{ s.subtitle }}</div>
              </div>
            </div>
          </template>
        </template>
      </div>

      <div class="sidebar-bottom">
        <button class="btn btn-secondary w-full h-btn text-sm settings-btn" @click="openSettings">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1Z" />
          </svg>
          系统设置
        </button>
      </div>
    </aside>

    <!-- ─── 聊天主区 ─── -->
    <main class="chat-main">
      <div ref="messageListRef" class="message-list custom-scroll">
        <div class="messages-inner">
          <div
            v-for="m in messages"
            :key="m.id"
            class="message-row"
            :class="m.role"
          >
            <div class="message" :class="m.role">
              <p>{{ m.content }}</p>
              <!-- 脚本镜头卡片（AI 消息附带） -->
              <div v-if="m.shots?.length" class="shots-card">
                <template v-for="shot in m.shots" :key="shot.index">
                  <div class="shot-row">
                    <span class="shot-idx">镜头 {{ shot.index }}</span>
                    <span class="shot-label">{{ shot.label }}</span>
                  </div>
                  <div class="shot-desc">{{ shot.desc }}</div>
                </template>
              </div>
              <!-- 浏览器解析导入数据卡片（AI 消息附带 extract） -->
              <div v-if="m.extract" class="extract-card">
                <div class="extract-head">
                  <span class="extract-tag">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                      <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
                      <polyline points="7.5 4.21 12 6.81 16.5 4.21" />
                      <polyline points="7.5 19.79 7.5 14.6 3 12" />
                    </svg>
                    {{ m.extract.platformName }} · 已导入
                  </span>
                  <span class="extract-time">
                    {{ new Date(m.extract.extractedAt).toLocaleTimeString('zh-CN', { hour12: false }) }}
                  </span>
                </div>
                <div v-if="m.extract.summary?.length" class="extract-summary">
                  <div
                    v-for="(item, i) in m.extract.summary"
                    :key="i"
                    class="extract-row"
                  >
                    <span class="extract-label">{{ item.label }}</span>
                    <span class="extract-value" :title="item.value">{{ item.value }}</span>
                  </div>
                </div>
                <div v-else class="extract-empty">（平台未返回可摘要字段，原始数据已存入 raw 供后续逻辑使用）</div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- ─── 输入区 ─── -->
      <div class="input-bar">
        <div class="input-wrap">
          <textarea
            ref="inputRef"
            v-model="inputText"
            class="chat-input"
            rows="4"
            placeholder="输入消息..."
            @keydown="handleKeydown"
          ></textarea>
          <div class="input-actions">
            <button class="action-ic" title="上传文件">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="17 8 12 3 7 8" />
                <line x1="12" y1="3" x2="12" y2="15" />
              </svg>
            </button>
            <button class="action-send" title="发送" @click="handleSend">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <path d="m22 2-7 20-4-9-9-4 20-7z" />
                <path d="M22 2 11 13" />
              </svg>
            </button>
          </div>
        </div>
        <div class="input-foot">
          <span>Enter 发送，Shift + Enter 换行</span>
          <span class="model-tag">模型：GPT-4o</span>
        </div>
      </div>
    </main>
  </section>
</template>

<style scoped>
.workbench {
  display: flex;
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: var(--background);
}

/* ─── 侧栏 ─── */
.sidebar {
  flex: 0 0 260px;
  width: 260px;
  display: flex;
  flex-direction: column;
  background: var(--surface);
  border-right: 1px solid var(--border);
}

.sidebar-top {
  padding: var(--space-4);
}

.new-session {
  gap: var(--space-2);
}

.session-list {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 0 var(--space-3) var(--space-3);
}

.group-label {
  padding: 0 var(--space-2);
  margin: var(--space-2) 0 var(--space-1);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--muted-foreground);
}

.session-item {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  padding: 10px 12px;
  margin-bottom: 2px;
  border-radius: var(--radius-lg);
  cursor: pointer;
  color: var(--muted-foreground);
  transition: all var(--duration-fast);
}

.session-item svg {
  flex: 0 0 auto;
  width: 18px;
  height: 18px;
  margin-top: 1px;
  color: inherit;
}

.session-item:hover {
  background: var(--surface-container);
  color: var(--foreground);
}

.session-item.active {
  background: var(--primary);
  color: var(--primary-foreground);
}

.session-text {
  flex: 1 1 auto;
  min-width: 0;
}

.session-title {
  font-size: var(--font-size-body);
  line-height: 1.4;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.session-sub {
  margin-top: 2px;
  font-size: 11px;
  line-height: 1.3;
  opacity: 0.8;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.sidebar-bottom {
  padding: var(--space-4);
  border-top: 1px solid var(--border);
}

.settings-btn {
  gap: var(--space-2);
}

/* ─── 聊天主区 ─── */
.chat-main {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  background: var(--background);
}

.message-list {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: var(--space-6);
}

.messages-inner {
  max-width: 48rem;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: var(--space-6);
}

.message-row {
  display: flex;
  width: 100%;
}

.message-row.user {
  justify-content: flex-end;
}

.message-row.ai {
  justify-content: flex-start;
}

.message {
  max-width: 78%;
  padding: 14px 18px;
  border-radius: var(--radius-xl);
  line-height: 1.65;
  font-size: var(--font-size-body);
}

.message.ai {
  background: var(--card);
  color: var(--foreground);
  border: 1px solid var(--border);
  border-bottom-left-radius: 6px;
}

.message.user {
  background: var(--primary);
  color: var(--primary-foreground);
  border-bottom-right-radius: 6px;
}

.message p {
  margin: 0;
}

/* 脚本镜头卡片 */
.shots-card {
  margin-top: var(--space-3);
  background: var(--surface-container);
  border: 1px solid var(--border);
  border-radius: var(--radius-xl);
  padding: var(--space-4);
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.shot-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  font-size: var(--font-size-body);
}

.shot-idx {
  font-weight: 600;
  color: var(--primary);
}

.shot-label {
  color: var(--muted-foreground);
}

.shot-desc {
  font-size: var(--font-size-body);
  color: var(--muted-foreground);
}

/* 浏览器解析导入数据卡片 */
.extract-card {
  margin-top: var(--space-3);
  background:
    linear-gradient(180deg, rgba(99, 102, 241, 0.06), rgba(139, 92, 246, 0.02)),
    var(--surface-container);
  border: 1px solid rgba(99, 102, 241, 0.20);
  border-radius: var(--radius-xl);
  padding: var(--space-4);
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.extract-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.extract-tag {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 10px;
  border-radius: 999px;
  background: rgba(99, 102, 241, 0.14);
  color: var(--primary);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.01em;
}

.extract-time {
  font-size: 11px;
  color: var(--muted-foreground);
  font-variant-numeric: tabular-nums;
}

.extract-summary {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: var(--space-3);
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
}

.extract-row {
  display: grid;
  grid-template-columns: 100px 1fr;
  gap: var(--space-3);
  align-items: start;
}

.extract-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--muted-foreground);
  line-height: 1.6;
  white-space: nowrap;
}

.extract-value {
  font-size: 12px;
  color: var(--foreground);
  line-height: 1.6;
  word-break: break-all;
}

.extract-empty {
  font-size: 12px;
  color: var(--muted-foreground);
  padding: var(--space-3);
  background: var(--card);
  border: 1px dashed var(--border);
  border-radius: var(--radius-lg);
  text-align: center;
}

/* ─── 输入区 ─── */
.input-bar {
  flex: 0 0 auto;
  padding: var(--space-4);
  background: var(--surface);
  border-top: 1px solid var(--border);
}

.input-wrap {
  max-width: 48rem;
  margin: 0 auto;
  position: relative;
}

.chat-input {
  width: 100%;
  min-height: 112px;
  padding: var(--space-4) 64px var(--space-4) var(--space-4);
  background: var(--surface-container);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  color: var(--foreground);
  font-size: var(--font-size-body);
  line-height: var(--line-height-body);
  outline: none;
  resize: none;
  transition: all var(--duration-fast);
}

.chat-input:focus {
  border-color: var(--primary);
  box-shadow: 0 0 0 3px var(--ring);
  background: var(--card);
}

.input-actions {
  position: absolute;
  right: var(--space-3);
  bottom: var(--space-3);
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.action-ic {
  width: 36px;
  height: 36px;
  border-radius: var(--radius-lg);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--muted-foreground);
  transition: all var(--duration-fast);
}

.action-ic:hover {
  background: var(--surface-container-high);
  color: var(--foreground);
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

.input-foot {
  max-width: 48rem;
  margin: var(--space-3) auto 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 11px;
  color: var(--muted-foreground);
}

.model-tag {
  white-space: nowrap;
}

/* 兼容 App 组件里已经定义了 btn/card 类（向后兼容类），这里补充设计稿需要的 variant */
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  border: 1px solid transparent;
  border-radius: var(--radius-lg);
  font-weight: 500;
  white-space: nowrap;
  transition: all var(--duration-fast);
}
.btn-secondary {
  background: var(--surface-container);
  color: var(--foreground);
  border-color: var(--border);
}
.btn-secondary:hover {
  background: var(--surface-container-high);
}
.h-btn { height: 40px; padding: 0 var(--space-4); }

.custom-scroll::-webkit-scrollbar { width: 6px; height: 6px; }
.custom-scroll::-webkit-scrollbar-thumb { background: var(--surface-container-high); border-radius: 3px; }

/* ─── 响应式：小屏下隐藏会话侧栏，可由 App 增加折叠按钮扩展 ─── */
@media (max-width: 768px) {
  .sidebar {
    position: absolute;
    z-index: 50;
    height: 100%;
    transform: translateX(-100%);
    transition: transform var(--duration-normal) var(--easing-default);
  }
  .sidebar.open {
    transform: translateX(0);
    box-shadow: var(--shadow-3);
  }
  .messages-inner {
    max-width: 100%;
  }
  .message {
    max-width: 90%;
  }
}
</style>
