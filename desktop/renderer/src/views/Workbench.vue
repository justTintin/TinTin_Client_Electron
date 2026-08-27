<script setup lang="ts">
// ═══════════════════════════════════════════════════════════════
// Workbench.vue — 工作台容器（聊天会话界面）
// 结构：左侧 260px 会话侧栏（新建会话/定时任务/分组会话列表/系统设置）
//       中间主区：消息流 + 底部输入框（上传/发送按钮 + 快捷键提示）
//       右侧抽屉：定时任务 / 通知中心 / 任务队列（遮罩 + 滑入过渡由本容器持有）
// 拆分布局：业务状态在 composables/useWorkbench*.ts，
//           展示片段在 components/workbench/Wb*.vue，此处仅做接线与公共样式。
// P1 微调（移植原则：框架不动、按需加组件）：侧栏「新建会话」下新增「定时任务」
//           入口 → 右侧滑出定时任务抽屉（P1 占位，P2 实装），与通知/任务抽屉同构。
// ═══════════════════════════════════════════════════════════════

import { ref, computed } from 'vue'
import WbSidebar from '@/components/workbench/WbSidebar.vue'
import WbMessages from '@/components/workbench/WbMessages.vue'
import WbComposer from '@/components/workbench/WbComposer.vue'
import WbNotificationDrawer from '@/components/workbench/WbNotificationDrawer.vue'
import WbTaskDrawer from '@/components/workbench/WbTaskDrawer.vue'
import WbScheduledDrawer from '@/components/workbench/WbScheduledDrawer.vue'
import { useWorkbenchSessions, SESSION_GROUPS } from '@/composables/useWorkbenchSessions'
import { useWorkbenchChat } from '@/composables/useWorkbenchChat'
import { useWorkbenchNotifications } from '@/composables/useWorkbenchNotifications'
import { useWorkbenchTasks } from '@/composables/useWorkbenchTasks'

/* ── 子组件实例引用：跨组件 DOM 行为经 expose 方法桥接 ────── */
const msgsComp = ref<InstanceType<typeof WbMessages> | null>(null)
const composerComp = ref<InstanceType<typeof WbComposer> | null>(null)

/* ── 消息域：发送后「nextTick 滚动」桥接到 WbMessages expose 的 scrollToBottom ── */
const chat = useWorkbenchChat({
  scrollToBottom: () => msgsComp.value?.scrollToBottom()
})
const { messages, inputText, handleSend, handleKeydown, openSettings } = chat

/* ── 会话域：新建会话后重置欢迎消息并聚焦输入框（原 createSession 行为时序不变）── */
const {
  activeSessionId,
  sidebarOpen,
  selectSession,
  createSession,
  toggleSidebarPanel,
  sessionsByGroup,
  groupLabels
} = useWorkbenchSessions({
  onConversationCreate: () => chat.resetToWelcome(),
  onSessionFocus: () => composerComp.value?.focus()
})

/* ── 通知域 ── */
const {
  notifications,
  unreadCount,
  notificationOpen,
  toggleNotifications,
  closeNotifications,
  markNotifyRead,
  markAllRead
} = useWorkbenchNotifications()

/* ── 任务队列域 ── */
const { taskQueueOpen, taskRows, toggleTaskQueue, closeTaskQueue } = useWorkbenchTasks()

/* ── 定时任务抽屉（P1 占位开关；P2 实装数据域 useScheduledTasks） ── */
const scheduledOpen = ref(false)
function openScheduled() {
  scheduledOpen.value = true
}
function closeScheduled() {
  scheduledOpen.value = false
}

/** 侧栏分组数据（今天/昨天/更早，组名 + 成员），展示交给 WbSidebar */
const sessionGroups = computed(() =>
  SESSION_GROUPS.map((g) => ({ key: g, label: groupLabels[g], items: sessionsByGroup(g) }))
)
</script>

<template>
  <section class="workbench">
    <!-- ─── 左侧会话侧栏 ─── -->
    <WbSidebar
      :groups="sessionGroups"
      :active-session-id="activeSessionId"
      :open="sidebarOpen"
      :unread-count="unreadCount"
      @select="selectSession"
      @create="createSession"
      @open-scheduled="openScheduled"
      @toggle-taskqueue="toggleTaskQueue"
      @toggle-notifications="toggleNotifications"
      @open-settings="openSettings"
    />

    <!-- ─── 聊天主区（消息流 + 底部输入框，纵向排列） ─── -->
    <main class="wb-main">
      <WbMessages
        ref="msgsComp"
        :messages="messages"
        @toggle-sidebar="toggleSidebarPanel"
      />

      <!-- ─── 输入区 ─── -->
      <WbComposer
        ref="composerComp"
        v-model="inputText"
        @send="handleSend"
        @keydown="handleKeydown"
      />
    </main>

    <!-- ─── 定时任务抽屉（新建会话入口下方按钮唤起；P1 占位，P2 实装） ─── -->
    <Transition name="drawer-fade">
      <div v-if="scheduledOpen" class="notify-mask" @click.self="closeScheduled"></div>
    </Transition>
    <Transition name="drawer-slide">
      <WbScheduledDrawer v-if="scheduledOpen" @close="closeScheduled" />
    </Transition>

    <!-- ─── 通知中心抽屉（对齐设计稿侧栏底部“通知中心”入口） ─── -->
    <Transition name="drawer-fade">
      <div v-if="notificationOpen" class="notify-mask" @click.self="closeNotifications"></div>
    </Transition>
    <Transition name="drawer-slide">
      <WbNotificationDrawer
        v-if="notificationOpen"
        :notifications="notifications"
        :unread-count="unreadCount"
        @close="toggleNotifications"
        @mark-read="markNotifyRead"
        @mark-all="markAllRead"
      />
    </Transition>

    <!-- ─── 任务队列抽屉（位于通知中心上方，对齐最新设计） ─── -->
    <Transition name="drawer-fade">
      <div v-if="taskQueueOpen" class="notify-mask" @click.self="closeTaskQueue"></div>
    </Transition>
    <Transition name="drawer-slide">
      <WbTaskDrawer
        v-if="taskQueueOpen"
        :rows="taskRows"
        @close="closeTaskQueue"
      />
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

/* ─── 聊天主区：消息流(flex:1) + 底部输入框 纵向排列 ─── */
.wb-main {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

/* ─── 抽屉遮罩（定时任务 / 通知中心 / 任务队列共用） ─── */
.notify-mask {
  position: absolute;
  inset: 0;
  z-index: 60;
  background: rgba(11, 12, 16, 0.32);
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
</style>
