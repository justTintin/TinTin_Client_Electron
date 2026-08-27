<script setup lang="ts">
// ═══════════════════════════════════════════════════════════════
// Workbench.vue — 工作台容器（聊天会话界面）
// 结构：左侧 260px 会话侧栏（新建会话/分组会话列表/系统设置）
//       中间主区：消息流 + 底部输入框（上传/发送按钮 + 快捷键提示）
//       右侧抽屉：通知中心 / 任务队列（遮罩 + 滑入过渡由本容器持有）
// 拆分布局：业务状态在 composables/useWorkbench*.ts，
//           展示片段在 components/workbench/Wb*.vue，此处仅做接线与公共样式。
// ═══════════════════════════════════════════════════════════════

import { ref, computed } from 'vue'
import WbSidebar from '@/components/workbench/WbSidebar.vue'
import WbMessages from '@/components/workbench/WbMessages.vue'
import WbComposer from '@/components/workbench/WbComposer.vue'
import WbNotificationDrawer from '@/components/workbench/WbNotificationDrawer.vue'
import WbTaskDrawer from '@/components/workbench/WbTaskDrawer.vue'
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

/* ─── 抽屉遮罩（通知中心 / 任务队列共用） ─── */
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
