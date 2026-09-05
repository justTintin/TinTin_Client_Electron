<script setup lang="ts">
// WbMessages.vue — 工作台聊天消息主区（纯展示）
// 结构：小屏汉堡按钮 / 消息流（用户/AI 消息与脚本镜头卡片）
//   · W8：AI 回复含成片视频资产（m.video）→ 气泡内视频卡片（播放/下载）；
//         播放=主窗口内 HTML5 <video> 弹窗（复用 VideoPreview，src 直连服务端 URL）；
//         下载=事件转发容器 → chat.downloadVideoAsset（业务在 composable）。
//   · W9：AI 气泡 hover 显示图标操作栏（预览 / 引用 / 复制 / 重新生成[仅最后一条]），
//         仅绘制 + 事件转发；复制为纯前端动作（剪贴板）组件内自持。
// messageListRef 在本组件内部自持：「发送后 nextTick 滚动」经容器桥接到 expose 的
// scrollToBottom，「初始滚动」由本组件 onMounted 完成——与原容器 onMounted 时机等价。
import { ref, computed, nextTick, onMounted, watch } from 'vue'
import type { ChatMessage } from '@/composables/useWorkbenchChat'
import type { VideoAsset, PlanView } from '@/composables/workbenchChatLogic'
import { chatTimeText, detectChatAssets, parsePlanContent } from '@/composables/workbenchChatLogic'
import VideoPreview from '@/components/common/VideoPreview.vue'

const props = defineProps<{
  messages: ChatMessage[]
}>()

const emit = defineEmits<{
  (e: 'toggle-sidebar'): void
  (e: 'quote-message', id: string): void
  (e: 'regenerate-message', id: string): void
  (e: 'confirm-plan'): void
  (e: 'download-video', asset: VideoAsset): void
  (e: 'assets-ready', id: string): void
  (e: 'preview-assets', id: string): void
}>()

const listRef = ref<HTMLDivElement | null>(null)

/** 重新生成仅对最后一条 AI 回复提供（对齐 W9 口径；语义为替换该轮回答） */
const lastAiId = computed(() => {
  const msgs = props.messages
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === 'ai' && !msgs[i].status) return msgs[i].id
  }
  return ''
})

/* ── 消息复制（2026-09-01 用户裁决：复制动作跟消息走，放「引用」后；
   导出整会话跟产物走 → 移除，导出在右侧预览面板按资产进行） ── */
const copiedId = ref('')
let copyTimer: ReturnType<typeof setTimeout> | undefined
/** 复制本条 AI 回复内容（2 秒反馈「已复制」；剪贴板不可用静默） */
function copyMessage(m: ChatMessage) {
  try {
    void navigator.clipboard.writeText(m.content)
    copiedId.value = m.id
    clearTimeout(copyTimer)
    copyTimer = setTimeout(() => { copiedId.value = '' }, 2000)
  } catch (_) { /* 忽略 */ }
}

/* ── W10：对话资产识别 → 气泡「预览」图标 + 资产出现自动展开 ── */

/** 含可预览资产的 AI 消息 id 集合（「预览」图标显示条件；detectChatAssets 无资产不显示） */
const assetMessageIds = computed(() => {
  const ids = new Set<string>()
  for (const m of props.messages) {
    if (m.role === 'ai' && !m.status && detectChatAssets(m.content).length) ids.add(m.id)
  }
  return ids
})

/** 最后一条含资产的 AI 气泡出现/内容更新（新回复到达、重新生成、切换会话）→ 通知容器自动展开 */
let lastAssetEmitted = { id: '', content: '' }
watch(lastAiId, (id) => {
  if (!id) return
  const m = props.messages.find((x) => x.id === id)
  if (!m || !detectChatAssets(m.content).length) return
  if (lastAssetEmitted.id === id && lastAssetEmitted.content === m.content) return
  lastAssetEmitted = { id, content: m.content }
  emit('assets-ready', id)
})

// 成片视频播放弹窗（主窗口内 <video>，src 直连服务端 URL；失败由 VideoPreview 错误态兜底）
const playSrc = ref('')
const playVisible = ref(false)
function playVideo(url: string) {
  playSrc.value = url
  playVisible.value = true
}

/** 原 Workbench 内 scrollToBottom 实现，逐字等价（nextTick 包裹 + scrollTop 置底） */
function scrollToBottom() {
  nextTick(() => {
    const el = listRef.value
    if (el) el.scrollTop = el.scrollHeight
  })
}

/* 原容器级 onMounted(scrollToBottom)，迁移至消息列表归属组件 */
onMounted(() => {
  scrollToBottom()
})

defineExpose({ scrollToBottom })

/* ── plan 步骤卡片（2026-09-01 用户裁决方案B）：AI 回复内容为结构化 plan JSON
（goal+steps）时渲染执行计划卡片，识别不到走原文本（纯展示层判定在 logic 层） */
const planViews = computed(() => {
  const map = new Map<string, PlanView>()
  for (const m of props.messages) {
    if (m.role !== 'ai' || m.status) continue
    const v = parsePlanContent(m.content)
    if (v) map.set(m.id, v)
  }
  return map
})
function planOf(id: string): PlanView | undefined {
  return planViews.value.get(id)
}

/* ── 长内容折叠（2026-08-31；2026-09-01 用户反馈扩展到用户消息：发送的长文本
   气泡同样默认折叠，此前仅 AI 回复有限高）：超长气泡默认折叠（max-height + 底部渐隐），
   展开/收起按消息 id 记忆；纯展示层处理，阈值只判断是否显示切换按钮；
   plan 卡片消息不参与文本折叠（已是结构化卡片） */
const FOLD_LINE_THRESHOLD = 18
const FOLD_CHAR_THRESHOLD = 800

function isFoldable(content: string): boolean {
  return content.split('\n').length > FOLD_LINE_THRESHOLD || content.length > FOLD_CHAR_THRESHOLD
}

const expandedIds = ref(new Set<string>())

function toggleFold(id: string) {
  const s = new Set(expandedIds.value)
  if (s.has(id)) s.delete(id)
  else s.add(id)
  expandedIds.value = s
}
</script>

<template>
  <!-- ─── 聊天主区 ─── -->
  <main class="chat-main">
    <!-- 小屏下显示侧栏开关（汉堡按钮） -->
    <button class="sidebar-toggle" title="会话列表" aria-label="会话列表" @click="emit('toggle-sidebar')">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <line x1="3" y1="6" x2="21" y2="6" />
        <line x1="3" y1="12" x2="21" y2="12" />
        <line x1="3" y1="18" x2="21" y2="18" />
      </svg>
    </button>
    <div ref="listRef" class="message-list custom-scroll">
      <div class="messages-inner">
        <div
          v-for="m in messages"
          :key="m.id"
          class="message-row"
          :class="m.role"
        >
          <div class="message" :class="[m.role, m.status]">
            <!-- plan JSON 消息 → 执行计划步骤卡片（方案B：plan 专门渲染） -->
            <div v-if="planOf(m.id)" class="plan-card">
              <div class="plan-goal" :title="planOf(m.id)?.goal">{{ planOf(m.id)?.goal }}</div>
              <div class="plan-steps-title">执行计划（{{ planOf(m.id)?.steps.length }} 步）</div>
              <div v-for="(st, si) in planOf(m.id)?.steps" :key="st.id" class="plan-step-row">
                <div class="plan-step-head">
                  <span class="plan-num">{{ si + 1 }}.</span>
                  <span class="plan-cap">{{ st.capability }}</span>
                  <span v-if="st.needsUserInput" class="plan-flag">需确认</span>
                </div>
                <pre v-if="st.summary" class="plan-params">{{ st.summary }}</pre>
                <div v-if="st.dependsOn.length" class="plan-deps">依赖：{{ st.dependsOn.join('、') }}</div>
              </div>
            </div>
            <div
              v-else
              class="bubble-body"
              :class="{ folded: isFoldable(m.content) && !expandedIds.has(m.id) }"
            >
              <p>{{ m.content }}</p>
            </div>
            <button
              v-if="!planOf(m.id) && isFoldable(m.content)"
              class="fold-btn"
              @click="toggleFold(m.id)"
            >
              {{ expandedIds.has(m.id) ? '收起' : '展开全文' }}
            </button>
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
            <!-- W8 成片视频资产卡片（回复含视频地址时挂播放/下载，原版 set_asset_actions） -->
            <div v-if="m.video" class="video-card">
              <span class="video-title">
                {{ m.video.taskId ? `成片（任务 #${m.video.taskId}）` : '成片视频' }}
              </span>
              <button class="video-btn" title="播放对话生成的成片视频" @click="playVideo(m.video.url)">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 3 20 12 6 21 6 3" /></svg>
                播放
              </button>
              <button class="video-btn" title="把成片保存到本地文件" @click="emit('download-video', m.video)">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></svg>
                下载
              </button>
            </div>
            <!-- 计划任务模式（plan-confirm）：本回复是计划草稿 → 确认后 POST approve 服务端启动执行；
                 已确认后显示执行中状态条（不改写消息内容，plan 卡片保持渲染） -->
            <div v-if="m.confirmable" class="confirm-card">
              <span class="confirm-hint">这是服务端计划草稿，确认后才开始执行</span>
              <button class="confirm-btn" title="确认计划并以编排任务提交执行" @click="emit('confirm-plan')">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
                确认执行
              </button>
            </div>
            <div v-else-if="m.planApproved" class="confirm-card confirm-card--done">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
              <span class="confirm-hint">已确认，服务端执行中；进度与产物见左侧「定时任务」抽屉或左下角「任务队列」</span>
            </div>
            <!-- W9 消息操作栏（AI 气泡 hover 显示）：预览 / 引用 / 复制 / 重新生成（仅最后一条 AI 回复）；
                 导出动作跟产物走 → 右侧预览面板按资产导出 Word/Excel（2026-09-01 用户裁决） -->
            <div v-if="m.role === 'ai' && !m.status" class="msg-actions">
              <!-- W10 对话资产预览（detectChatAssets 有资产时显示；点击 → 容器检测资产并展开右侧面板） -->
              <button
                v-if="assetMessageIds.has(m.id)"
                class="act-btn"
                title="在右侧预览本条回复中的资产（代码/文案/表格）"
                @click="emit('preview-assets', m.id)"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" /></svg>
                预览
              </button>
              <button
                class="act-btn"
                title="把本条回复引用到输入框，补充指令后再发送"
                @click="emit('quote-message', m.id)"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M10 7H6a3 3 0 0 0-3 3v5a3 3 0 0 0 3 3h1v-3H6v-2h4V7zm10 0h-4a3 3 0 0 0-3 3v5a3 3 0 0 0 3 3h1v-3h-1v-2h4V7z" /></svg>
                引用
              </button>
              <button
                class="act-btn"
                :title="copiedId === m.id ? '已复制' : '复制本条回复内容到剪贴板'"
                @click="copyMessage(m)"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
                {{ copiedId === m.id ? '已复制' : '复制' }}
              </button>
              <button
                v-if="m.id === lastAiId"
                class="act-btn"
                title="用上一条问题重新生成回答（新回复替换本条）"
                @click="emit('regenerate-message', m.id)"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" /></svg>
                重新生成
              </button>
            </div>
            <!-- 消息时间（2026-09-01 用户需求：每个消息框带时间；
                 欢迎语/错误提示无 time 不显示，chatTimeText 口径同天 HH:mm/昨天/更早日期） -->
            <div v-if="m.time" class="msg-time">{{ chatTimeText(m.time) }}</div>
          </div>
        </div>
      </div>
    </div>
  </main>

  <!-- W8 成片视频播放弹窗（主窗口内 HTML5 <video>，复用 VideoPreview） -->
  <VideoPreview :visible="playVisible" :src="playSrc" @close="playVisible = false" />
</template>

<style scoped>
/* ─── 聊天主区 ─── */
.chat-main {
  position: relative;
  flex: 1 1 auto;
  /* flex 子项默认 min-height:auto（不小于内容高度）——缺失会导致长会话把本块
     撑高、输入框被推出容器且消息列表 overflow-y 永不触发（2026-08-31 修复） */
  min-height: 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
  background: var(--background);
}

.message-list {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  /* 2026-09-05 用户裁决：贴边边距 12px → 24px（space-6），上下左右统一 */
  padding: var(--space-6);
}

.messages-inner {
  /* 2026-09-04 用户裁决：去 64rem 限宽，内容列跟随中间区可用宽度（左右 12px 贴边），
     与输入区 input-wrap/ctx-pills/input-foot 同步放开；气泡自身仍有 max-width 防横跨 */
  max-width: none;
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
  /* 保留原文换行；长单词/URL 断行，防撑破气泡 */
  white-space: pre-wrap;
  word-break: break-word;
  overflow-wrap: anywhere;
}

/* 长内容折叠：折叠态限高 + 底部渐隐（AI/用户气泡；渐变色对齐各自气泡底色） */
.bubble-body.folded {
  position: relative;
  max-height: 360px;
  overflow: hidden;
}

.bubble-body.folded::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 48px;
  background: linear-gradient(transparent, var(--card));
}

/* 用户气泡底色为 primary，渐隐色跟随（否则渐隐与气泡底色不接） */
.message-row.user .bubble-body.folded::after {
  background: linear-gradient(transparent, var(--primary));
}

/* 消息时间（2026-09-01 用户需求）：气泡底部小字，随气泡对齐 */
.msg-time {
  margin-top: var(--space-1);
  font-size: 11px;
  line-height: 1.4;
  color: var(--muted-foreground);
  text-align: right;
  user-select: none;
}

.fold-btn {
  margin-top: var(--space-1);
  align-self: flex-start;
  padding: 2px 8px;
  font-size: 12px;
  border-radius: var(--radius-md);
  color: var(--primary);
  transition: all var(--duration-fast);
}

.fold-btn:hover {
  background: var(--surface-container-high);
}

/* ─── plan 步骤卡片（AI 回复为结构化 plan JSON；样式对齐 WbScheduledDrawer 口径） ─── */
.plan-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
.plan-goal {
  font-size: 13px;
  font-weight: var(--font-weight-semibold);
  color: var(--foreground);
}
.plan-steps-title {
  font-size: 12px;
  color: var(--muted-foreground);
}
.plan-step-row {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 7px 9px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--surface-container);
}
.plan-step-head {
  display: flex;
  align-items: center;
  gap: 6px;
}
.plan-num {
  font-size: 12px;
  color: var(--muted-foreground);
}
.plan-cap {
  font-size: 12px;
  font-weight: var(--font-weight-medium);
  color: var(--primary);
  word-break: break-all;
}
.plan-flag {
  flex: 0 0 auto;
  padding: 0 6px;
  font-size: 10px;
  line-height: 16px;
  border-radius: var(--radius-full);
  background: rgba(180, 83, 9, 0.14);
  color: #b45309;
}
.plan-params {
  margin: 0;
  font-size: 11px;
  line-height: 1.5;
  color: var(--muted-foreground);
  white-space: pre-wrap;
  word-break: break-all;
}
.plan-deps {
  font-size: 11px;
  color: var(--muted-foreground);
}

/* 「思考中…」占位 / 失败提示气泡（ChatMessage.status） */
.message.pending {
  color: var(--muted-foreground);
  font-style: italic;
}

.message.error {
  border-color: var(--destructive, #e5484d);
  color: var(--destructive, #e5484d);
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

/* W8 成片视频资产卡片（原版 set_asset_actions：气泡内容下方挂播放/下载） */
.video-card {
  margin-top: var(--space-3);
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
  padding: 6px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: var(--surface-container);
}

.confirm-card {
  margin-top: var(--space-3);
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 6px 10px;
  border: 1px solid var(--primary);
  border-radius: var(--radius-lg);
  background: var(--surface-container);
}

/* 已确认执行状态条（无按钮；主色描边弱化，对齐「执行中」语义） */
.confirm-card--done {
  border-color: color-mix(in srgb, var(--primary) 45%, transparent);
  color: var(--primary);
}

.confirm-hint {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 12px;
  color: var(--text-secondary);
}

.confirm-btn {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  border: none;
  border-radius: var(--radius-md);
  background: var(--primary);
  color: var(--on-primary);
  font-size: 12px;
  cursor: pointer;
}

.confirm-btn:hover {
  filter: brightness(1.08);
}

.video-title {
  flex: 1 1 auto;
  min-width: 0;
  font-size: var(--font-size-caption);
  color: var(--foreground);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.video-btn {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 24px;
  padding: 0 10px;
  font-size: 12px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--surface);
  color: var(--muted-foreground);
  transition: all var(--duration-fast);
}

.video-btn:hover {
  border-color: var(--primary);
  color: var(--primary);
}

/* W9 消息操作栏：AI 气泡 hover 显示（图标按钮，原版操作栏 hover 化） */
.msg-actions {
  display: flex;
  align-items: center;
  gap: 2px;
  margin-top: var(--space-2);
  opacity: 0;
  transition: opacity var(--duration-fast) var(--easing-default);
}

.message.ai:hover .msg-actions {
  opacity: 1;
}

.act-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 24px;
  padding: 0 8px;
  font-size: 12px;
  border-radius: var(--radius-md);
  color: var(--muted-foreground);
  transition: all var(--duration-fast);
}

.act-btn:hover {
  background: var(--surface-container-high);
  color: var(--foreground);
}

.act-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
  background: transparent;
  color: var(--muted-foreground);
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

/* custom-scroll 为本组件自持副本（与原 Workbench scoped 定义逐字一致） */
.custom-scroll::-webkit-scrollbar { width: 6px; height: 6px; }
.custom-scroll::-webkit-scrollbar-thumb { background: var(--surface-container-high); border-radius: 3px; }

@media (max-width: 768px) {
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
