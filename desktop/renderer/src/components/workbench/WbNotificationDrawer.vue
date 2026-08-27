<script setup lang="ts">
// WbNotificationDrawer.vue — 通知中心抽屉本体（纯展示）
// 抽屉开关（v-if + notify-mask 遮罩 + drawer-slide/drawer-fade 过渡）由容器持有，
// 原关闭按钮绑定的 toggleNotifications / 单条已读 markNotifyRead / 全部已读 markAllRead
// 均经事件上抛由容器调用原函数，行为零变更。
import type { NotifyItem } from '@/composables/useWorkbenchNotifications'

defineProps<{
  notifications: NotifyItem[]
  unreadCount: number
}>()

const emit = defineEmits<{
  /** 关闭按钮（容器接原 toggleNotifications） */
  (e: 'close'): void
  (e: 'mark-read', id: string): void
  (e: 'mark-all'): void
}>()
</script>

<template>
  <aside class="notify-drawer" aria-label="通知中心">
    <header class="notify-head">
      <span class="notify-title">通知中心</span>
      <span v-if="unreadCount > 0" class="notify-head-badge">{{ unreadCount }} 条未读</span>
      <button class="notify-actions" @click="emit('close')" title="关闭">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </header>
    <button v-if="unreadCount > 0" class="notify-read-all" @click="emit('mark-all')">全部已读</button>
    <div class="notify-body">
      <div
        v-for="n in notifications"
        :key="n.id"
        class="notify-item"
        :class="{ unread: n.unread }"
        @click="emit('mark-read', n.id)"
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
</template>

<style scoped>
/* 抽屉骨架与通知条目样式自持副本（与原 Workbench scoped 定义逐字一致；
   .notify-mask 与过渡动画样式保留在容器） */
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
</style>
