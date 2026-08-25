<script lang="ts">
/** 通知类型 */
export type NotificationType = 'info' | 'success' | 'warning' | 'error'

/** 通知项 */
export interface NotificationItem {
  id: string | number
  title: string
  body?: string
  time?: string
  type?: NotificationType
}
</script>
<script setup lang="ts">
/**
 * TNotification 通知下拉面板组件
 * 展示通知列表，支持清空与点击单条通知。
 */
import { computed } from 'vue'

const props = withDefaults(
  defineProps<{
    /** 通知列表 */
    notifications?: NotificationItem[]
    /** 空状态提示 */
    emptyText?: string
    /** 是否显示清空按钮 */
    clearable?: boolean
  }>(),
  {
    notifications: () => [],
    emptyText: '暂无通知',
    clearable: true
  }
)

const emit = defineEmits<{
  (e: 'clear'): void
  (e: 'click', item: NotificationItem): void
}>()

// 未读数量（当前实现全部视为未读）
const count = computed(() => props.notifications.length)

// 类型对应的点颜色
function typeColor(type: NotificationType = 'info'): string {
  const map: Record<NotificationType, string> = {
    info: 'var(--info)',
    success: 'var(--success)',
    warning: 'var(--warning)',
    error: 'var(--error)'
  }
  return map[type]
}

function handleClick(item: NotificationItem) {
  emit('click', item)
}

function handleClear() {
  emit('clear')
}
</script>

<template>
  <div class="t-notification">
    <!-- 头部 -->
    <div class="t-notification__header">
      <span class="t-notification__title">
        通知
        <span v-if="count > 0" class="t-notification__badge">{{ count }}</span>
      </span>
      <button
        v-if="clearable && count > 0"
        class="t-notification__clear"
        @click="handleClear"
      >
        全部清除
      </button>
    </div>

    <!-- 通知列表 -->
    <div class="t-notification__body">
      <template v-if="notifications.length > 0">
        <div
          v-for="item in notifications"
          :key="item.id"
          class="t-notification__item"
          @click="handleClick(item)"
        >
          <span
            class="t-notification__dot"
            :style="{ background: typeColor(item.type) }"
          />
          <div class="t-notification__content">
            <div class="t-notification__row">
              <span class="t-notification__name">{{ item.title }}</span>
              <span v-if="item.time" class="t-notification__time">{{ item.time }}</span>
            </div>
            <p v-if="item.body" class="t-notification__desc">{{ item.body }}</p>
          </div>
        </div>
      </template>
      <!-- 空状态 -->
      <div v-else class="t-notification__empty">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
          <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
        </svg>
        <span>{{ emptyText }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.t-notification {
  width: 360px;
  max-width: calc(100vw - 32px);
  background: var(--popover);
  border: 1px solid var(--border);
  border-radius: var(--radius-xl);
  box-shadow: var(--shadow-float);
  overflow: hidden;
}

.t-notification__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--space-3) var(--space-4);
  border-bottom: 1px solid var(--border-subtle);
}

.t-notification__title {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--font-size-lead);
  font-weight: var(--font-weight-semibold);
  color: var(--foreground);
}

.t-notification__badge {
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--primary);
  color: var(--primary-foreground);
  font-size: var(--font-size-eyebrow);
  font-weight: var(--font-weight-semibold);
  border-radius: var(--radius-full);
}

.t-notification__clear {
  color: var(--muted-foreground);
  font-size: var(--font-size-caption);
  transition: color var(--duration-fast) var(--easing-default);
}

.t-notification__clear:hover {
  color: var(--primary);
}

.t-notification__body {
  max-height: 420px;
  overflow-y: auto;
}

.t-notification__item {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  cursor: pointer;
  transition: background var(--duration-fast) var(--easing-default);
  border-bottom: 1px solid var(--border-subtle);
}

.t-notification__item:last-child {
  border-bottom: none;
}

.t-notification__item:hover {
  background: var(--surface-container);
}

.t-notification__dot {
  flex-shrink: 0;
  width: 8px;
  height: 8px;
  margin-top: 6px;
  border-radius: var(--radius-full);
}

.t-notification__content {
  flex: 1;
  min-width: 0;
}

.t-notification__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
}

.t-notification__name {
  font-size: var(--font-size-body);
  font-weight: var(--font-weight-medium);
  color: var(--foreground);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.t-notification__time {
  flex-shrink: 0;
  font-size: var(--font-size-caption);
  color: var(--muted-foreground);
}

.t-notification__desc {
  margin-top: 2px;
  font-size: var(--font-size-caption);
  color: var(--muted-foreground);
  line-height: var(--line-height-normal);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.t-notification__empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-8) var(--space-4);
  color: var(--muted-foreground);
  font-size: var(--font-size-caption);
}
</style>
