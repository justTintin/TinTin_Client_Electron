<script setup lang="ts">
// ═══════════════════════════════════════════════════════════════
// Workbench.vue — 工作台（聊天会话界面）
// 结构：左侧 260px 会话侧栏（新建会话/分组会话列表/系统设置）
//       中间主区：消息流 + 底部输入框（上传/发送按钮 + 快捷键提示）
// 厚壳化补充：
//   · 消费 appStore.pendingExtract（浏览器"解析并导入"按钮推送的数据）
//     → 作为 AI 消息展示平台抽取结果（结构化数据卡）
// ═══════════════════════════════════════════════════════════════

import { ref, computed, nextTick, onMounted, onBeforeUnmount, watch, type Ref } from 'vue'
import { useRouter } from 'vue-router'
import { useAppStore, type BrowserExtractPayload } from '@/stores/app'
import { useTasksStore } from '@/stores/tasks'

const router = useRouter()
const appStore = useAppStore()
const tasksStore = useTasksStore()

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

/* ── 通知中心（对齐设计稿：侧栏底部“通知中心”入口 + 徽标） ── */
interface NotifyItem {
  id: string
  title: string
  desc: string
  time: string
  unread: boolean
}

const notifications = ref<NotifyItem[]>([
  { id: 'n1', title: '脚本流程任务完成', desc: '「JBL CHARGE6 脚本创作」已生成 3 个镜头', time: '09:12', unread: true },
  { id: 'n2', title: '服务器状态变化', desc: '本地推理服务已就绪，可离线使用', time: '08:47', unread: true },
  { id: 'n3', title: '新版本提示', desc: 'V3.0.0 已发布，新增浏览器解析能力', time: '昨天', unread: true }
])

/** 未读数量（设计稿徽标显示 3） */
const unreadCount = computed(() => notifications.value.filter((n) => n.unread).length)

/** 通知中心抽屉是否展开 */
const notificationOpen = ref(false)

/** 打开通知抽屉；打开时若全部未读，可点“全部已读”清空 */
function toggleNotifications() {
  notificationOpen.value = !notificationOpen.value
}

/* ── 点击遮罩关闭通知抽屉 */
function closeNotifications() {
  notificationOpen.value = false
}

/* ── 任务队列（对齐设计稿：位于通知中心上方） ──────────────── */
interface TaskRow {
  id: string
  title: string
  type: string
  progress: number
  status: 'running' | 'done' | 'pending'
  eta: string
}

/** 离线/无服务端时的示例任务（预览兜底，避免空抽屉） */
const SAMPLE_TASKS: TaskRow[] = [
  { id: 't1', title: '成片 · JBL CHARGE6 15s', type: '成片', progress: 78, status: 'running', eta: '剩余 02:13' },
  { id: 't2', title: '抠图 · COVER_MAIN_V1.png', type: '抠图', progress: 100, status: 'done', eta: '已完成' },
  { id: 't3', title: '超分 · 直播回放 4K', type: '超分（视频修复）', progress: 12, status: 'pending', eta: '排队中' },
]

/** 任务队列抽屉是否展开 */
const taskQueueOpen = ref(false)

/** 展示用任务列表：优先真实服务端任务，否则用示例兜底 */
const taskRows = computed<TaskRow[]>(() => {
  const real = tasksStore.page.items
  if (real && real.length > 0) {
    return real.slice(0, 10).map((t: any, i: number) => {
      const p = Number(t.progress) || (t.status === 'done' ? 100 : 0)
      const status: TaskRow['status'] =
        t.status === 'done' ? 'done' : t.status === 'pending' ? 'pending' : 'running'
      return {
        id: String(t.id ?? i),
        title: t.title || t.name || `任务 ${i + 1}`,
        type: t.type || '媒体工具',
        progress: p,
        status,
        eta: t.status === 'done' ? '已完成' : (t.eta || '进行中'),
      }
    })
  }
  return SAMPLE_TASKS
})

function toggleTaskQueue() {
  taskQueueOpen.value = !taskQueueOpen.value
  if (taskQueueOpen.value) void loadTasks()
}

function closeTaskQueue() {
  taskQueueOpen.value = false
}

/** 打开时拉取一次服务端任务（失败/离线静默，靠示例兜底） */
async function loadTasks(): Promise<void> {
  try {
    await tasksStore.fetchTasks({ page: 1, page_size: 10 })
  } catch (_) { /* ignore：纯预览模式无 IPC 不阻塞 */ }
}

/** 任务状态的中文展示 */
function statusText(s: string): string {
  if (s === 'done') return '已完成'
  if (s === 'pending') return '排队中'
  return '进行中'
}

/** 点击单条：标记已读 */
function markNotifyRead(id: string) {
  const n = notifications.value.find((x) => x.id === id)
  if (n) n.unread = false
}

/** 一键全部已读 */
function markAllRead() {
  notifications.value.forEach((n) => (n.unread = false))
}

/* ── 小屏适配：会话侧栏折叠开关 ────────────────────────────── */
const sidebarOpen = ref(false)

function toggleSidebarPanel() {
  sidebarOpen.value = !sidebarOpen.value
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
    <aside class="sidebar" :class="{ open: sidebarOpen }">
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
        <button class="btn btn-secondary w-full h-btn text-sm taskq-btn" @click="toggleTaskQueue">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <rect x="3" y="4" width="18" height="18" rx="2" />
            <path d="M16 2v4" />
            <path d="M8 2v4" />
            <path d="M3 10h18" />
            <path d="M9 16l3 3 4-5" />
          </svg>
          任务队列
        </button>
        <button class="btn btn-secondary w-full h-btn text-sm notify-btn" :class="{ 'badge': unreadCount > 0 }" @click="toggleNotifications">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
            <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
          </svg>
          通知中心
          <span v-if="unreadCount > 0" class="notify-badge">{{ unreadCount }}</span>
        </button>
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
      <!-- 小屏下显示侧栏开关（汉堡按钮） -->
      <button class="sidebar-toggle" title="会话列表" aria-label="会话列表" @click="toggleSidebarPanel">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <line x1="3" y1="6" x2="21" y2="6" />
          <line x1="3" y1="12" x2="21" y2="12" />
          <line x1="3" y1="18" x2="21" y2="18" />
        </svg>
      </button>
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

    <!-- ─── 通知中心抽屉（对齐设计稿侧栏底部“通知中心”入口） ─── -->
    <Transition name="drawer-fade">
      <div v-if="notificationOpen" class="notify-mask" @click.self="closeNotifications"></div>
    </Transition>
    <Transition name="drawer-slide">
      <aside v-if="notificationOpen" class="notify-drawer" aria-label="通知中心">
        <header class="notify-head">
          <span class="notify-title">通知中心</span>
          <span v-if="unreadCount > 0" class="notify-head-badge">{{ unreadCount }} 条未读</span>
          <button class="notify-actions" @click="toggleNotifications" title="关闭">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </header>
        <button v-if="unreadCount > 0" class="notify-read-all" @click="markAllRead">全部已读</button>
        <div class="notify-body">
          <div
            v-for="n in notifications"
            :key="n.id"
            class="notify-item"
            :class="{ unread: n.unread }"
            @click="markNotifyRead(n.id)"
          >
            <span class="notify-dot"></span>
            <div class="notify-content">
              <div class="notify-item-title">{{ n.title }}</div>
              <div class="notify-item-desc">{{ n.desc }}</div>
            </div>
            <span class="notify-item-time">{{ n.time }}</span>
          </div>
          <div v-if="notifications.length === 0" class="notify-empty">暂无通知</div>
        </div>
      </aside>
    </Transition>

    <!-- ─── 任务队列抽屉（位于通知中心上方，对齐最新设计） ─── -->
    <Transition name="drawer-fade">
      <div v-if="taskQueueOpen" class="notify-mask" @click.self="closeTaskQueue"></div>
    </Transition>
    <Transition name="drawer-slide">
      <aside v-if="taskQueueOpen" class="notify-drawer taskq-drawer" aria-label="任务队列">
        <header class="notify-head">
          <span class="notify-title">任务队列</span>
          <span class="notify-head-badge">{{ taskRows.length }} 项</span>
          <button class="notify-actions" @click="closeTaskQueue" title="关闭">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </header>
        <div class="notify-body">
          <div v-for="t in taskRows" :key="t.id" class="taskq-row">
            <div class="taskq-head">
              <span class="q-dot" :class="t.status"></span>
              <span class="taskq-title">{{ t.title }}</span>
              <span class="taskq-eta" :class="t.status">{{ t.eta }}</span>
            </div>
            <div class="taskq-type">{{ t.type }}</div>
            <div class="taskq-bar">
              <div class="taskq-fill" :class="t.status" :style="{ width: t.progress + '%' }"></div>
            </div>
            <div class="taskq-foot">
              <span>{{ t.status === 'done' ? '100%' : t.progress + '%' }}</span>
              <span>{{ ['running','pending','done'].includes(t.status) ? statusText(t.status) : t.status }}</span>
            </div>
          </div>
          <div v-if="taskRows.length === 0" class="notify-empty">暂无任务</div>
        </div>
      </aside>
    </Transition>
  </section>
</template>

<style scoped>
.workbench {
  position: relative;
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
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.settings-btn {
  gap: var(--space-2);
}

/* ─── 通知中心入口（侧栏底部，对齐设计稿） ─── */
.notify-btn {
  gap: var(--space-2);
  position: relative;
}

.taskq-btn {
  gap: var(--space-2);
}

.notify-badge {
  margin-left: auto;
  min-width: 20px;
  height: 20px;
  padding: 0 6px;
  border-radius: var(--radius-full);
  background: var(--color-error);
  color: var(--primary-foreground);
  font-size: 10px;
  font-weight: 600;
  line-height: 20px;
  text-align: center;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

/* ─── 小屏侧栏开关（汉堡按钮，桌面隐藏） ─── */
.sidebar-toggle {
  display: none;
  align-items: center;
  justify-content: center;
  position: absolute;
  top: 10px;
  left: 12px;
  width: 34px;
  height: 34px;
  border-radius: var(--radius-md);
  background: var(--surface);
  border: 1px solid var(--border);
  color: var(--foreground);
  box-shadow: var(--shadow-1);
  z-index: 30;
  transition: all var(--duration-fast);
}
.sidebar-toggle:hover {
  background: var(--surface-container);
}

/* ─── 通知中心抽屉 ─── */
.notify-mask {
  position: absolute;
  inset: 0;
  z-index: 60;
  background: rgba(11, 12, 16, 0.32);
}

.notify-drawer {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  width: 340px;
  max-width: 86%;
  z-index: 70;
  display: flex;
  flex-direction: column;
  background: var(--surface);
  border-left: 1px solid var(--border);
  box-shadow: var(--shadow-4);
}

.notify-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-4);
  border-bottom: 1px solid var(--border);
}

.notify-title {
  font-size: var(--font-size-h4);
  font-weight: var(--font-weight-semibold);
}

.notify-head-badge {
  font-size: 11px;
  color: var(--color-error);
  font-weight: 600;
}

.notify-actions {
  margin-left: auto;
  width: 28px;
  height: 28px;
  border-radius: var(--radius-md);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--muted-foreground);
  transition: all var(--duration-fast);
}
.notify-actions:hover {
  background: var(--surface-container);
  color: var(--foreground);
}

.notify-read-all {
  align-self: flex-end;
  margin: var(--space-2) var(--space-4) 0;
  font-size: 12px;
  color: var(--primary);
  background: transparent;
  border: none;
  padding: 4px 8px;
  border-radius: var(--radius-sm);
}
.notify-read-all:hover {
  background: var(--surface-container);
}

.notify-body {
  flex: 1 1 auto;
  overflow-y: auto;
  padding: var(--space-2) var(--space-3) var(--space-4);
}

.notify-item {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  padding: var(--space-3);
  border-radius: var(--radius-lg);
  cursor: pointer;
  transition: all var(--duration-fast);
}
.notify-item:hover {
  background: var(--surface-container);
}

.notify-dot {
  flex: 0 0 auto;
  width: 8px;
  height: 8px;
  margin-top: 6px;
  border-radius: var(--radius-full);
  background: transparent;
  border: 2px solid var(--border);
}
.notify-item.unread .notify-dot {
  background: var(--color-error);
  border-color: var(--color-error);
}

.notify-content {
  flex: 1 1 auto;
  min-width: 0;
}

.notify-item-title {
  font-size: var(--font-size-body);
  font-weight: var(--font-weight-semibold);
  color: var(--foreground);
}

.notify-item.unread .notify-item-title {
  color: var(--primary);
}

.notify-item-desc {
  margin-top: 2px;
  font-size: 12px;
  color: var(--muted-foreground);
  line-height: 1.5;
}

.notify-item-time {
  flex: 0 0 auto;
  font-size: 11px;
  color: var(--foreground-subtle);
}

.notify-empty {
  padding: var(--space-8) 0;
  text-align: center;
  font-size: 13px;
  color: var(--muted-foreground);
}

/* ─── 任务队列抽屉内容 ─── */
.taskq-row {
  padding: var(--space-3);
  border-radius: var(--radius-lg);
  background: var(--surface-container);
  border: 1px solid var(--border);
  margin-bottom: var(--space-2);
  transition: border-color var(--duration-fast);
}
.taskq-row:hover { border-color: var(--primary); }

.taskq-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.q-dot {
  flex: 0 0 auto;
  width: 8px;
  height: 8px;
  border-radius: var(--radius-full);
}
.q-dot.running { background: var(--primary); box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.18); }
.q-dot.done    { background: var(--success);  box-shadow: 0 0 0 3px rgba(16, 185, 129, 0.18); }
.q-dot.pending { background: var(--muted-foreground); }

.taskq-title {
  flex: 1 1 auto;
  min-width: 0;
  font-size: var(--font-size-body);
  font-weight: 600;
  color: var(--foreground);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.taskq-eta {
  flex: 0 0 auto;
  font-size: 11px;
  color: var(--muted-foreground);
}
.taskq-eta.done { color: var(--success); }
.taskq-eta.running { color: var(--primary); }

.taskq-type {
  margin-top: 2px;
  font-size: 11px;
  color: var(--muted-foreground);
}

.taskq-bar {
  margin-top: var(--space-2);
  height: 6px;
  background: var(--surface-container-high);
  border-radius: var(--radius-full);
  overflow: hidden;
}
.taskq-fill {
  height: 100%;
  border-radius: var(--radius-full);
  background: var(--primary);
  transition: width 0.3s ease;
}
.taskq-fill.done { background: var(--success); }
.taskq-fill.pending { background: var(--surface-container-highest); }

.taskq-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 6px;
  font-size: 11px;
  color: var(--muted-foreground);
  font-variant-numeric: tabular-nums;
}

/* 抽屉过渡动画 */
.drawer-slide-enter-active,
.drawer-slide-leave-active {
  transition: transform var(--duration-normal) var(--easing-out);
}
.drawer-slide-enter-from,
.drawer-slide-leave-to {
  transform: translateX(100%);
}
.drawer-fade-enter-active,
.drawer-fade-leave-active {
  transition: opacity var(--duration-normal) var(--easing-default);
}
.drawer-fade-enter-from,
.drawer-fade-leave-to {
  opacity: 0;
}

/* ─── 聊天主区 ─── */
.chat-main {
  position: relative;
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

/* ─── 响应式：小屏下会话侧栏折叠为抽屉，由汉堡按钮控制 ─── */
@media (max-width: 768px) {
  .sidebar {
    position: absolute;
    left: 0;
    top: 0;
    z-index: 50;
    height: 100%;
    transform: translateX(-100%);
    transition: transform var(--duration-normal) var(--easing-default);
    box-shadow: none;
  }
  .sidebar.open {
    transform: translateX(0);
    box-shadow: var(--shadow-3);
  }
  .sidebar-toggle {
    display: inline-flex;
  }
  .message-list {
    padding-top: var(--space-12);
  }
  .messages-inner {
    max-width: 100%;
  }
  .message {
    max-width: 90%;
  }
}
</style>
