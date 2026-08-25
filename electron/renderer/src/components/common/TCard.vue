<script setup lang="ts">
/**
 * TCard 卡片容器组件
 * 支持悬停抬升效果、可选标题插槽、可选图标。
 */
import { computed, useSlots } from 'vue'

const props = withDefaults(
  defineProps<{
    /** 卡片标题（也可用 title 插槽自定义） */
    title?: string
    /** 标题图标名称 */
    icon?: string
    /** 禁用态 */
    disabled?: boolean
    /** 是否可点击（启用 hover 抬升） */
    clickable?: boolean
  }>(),
  {
    title: '',
    icon: '',
    disabled: false,
    clickable: false
  }
)

const emit = defineEmits<{
  (e: 'click', event: MouseEvent): void
}>()

// 内置图标集（24x24 描边路径）
const ICONS: Record<string, string> = {
  folder: 'M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z',
  file: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6',
  video: 'M23 7l-7 5 7 5z M1 5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2z',
  image: 'M19 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2z M8.5 11a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM21 15l-5-5L5 21',
  script: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6 M9 13h6M9 17h6',
  task: 'M9 11l3 3L22 4 M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11',
  cube: 'M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z M3.27 6.96L12 12.01l8.73-5.05M12 22.08V12',
  star: 'M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z',
  grid: 'M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z'
}

const iconPath = computed(() => (props.icon ? ICONS[props.icon] ?? '' : ''))

// 侦测是否存在 title 插槽
const slots = useSlots()
const hasTitleSlot = computed(() => Boolean(slots.title))

const hasHeader = computed(() => Boolean(props.title || props.icon || hasTitleSlot.value))

function handleClick(event: MouseEvent) {
  if (props.disabled) return
  if (!props.clickable) return
  emit('click', event)
}
</script>

<template>
  <div
    class="t-card"
    :class="{ 'is-clickable': clickable && !disabled, 'is-disabled': disabled }"
    @click="handleClick"
  >
    <!-- 头部：图标 + 标题 -->
    <div v-if="hasHeader" class="t-card__header">
      <svg
        v-if="iconPath"
        class="t-card__icon"
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.6"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path :d="iconPath" />
      </svg>
      <slot name="title">
        <span class="t-card__title">{{ title }}</span>
      </slot>
    </div>
    <!-- 内容区 -->
    <div class="t-card__body">
      <slot />
    </div>
    <!-- 底部插槽 -->
    <div v-if="$slots.footer" class="t-card__footer">
      <slot name="footer" />
    </div>
  </div>
</template>

<style scoped>
.t-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-xl);
  box-shadow: var(--shadow-card);
  padding: var(--space-4);
  transition: box-shadow var(--duration-fast) var(--easing-default),
    border-color var(--duration-fast) var(--easing-default),
    transform var(--duration-fast) var(--easing-default),
    opacity var(--duration-fast) var(--easing-default);
}

/* 可点击态：hover 抬升 */
.t-card.is-clickable {
  cursor: pointer;
}
.t-card.is-clickable:hover {
  border-color: var(--primary);
  box-shadow: var(--shadow-hover);
  transform: translateY(-2px);
}

/* 禁用态 */
.t-card.is-disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.t-card__header {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-bottom: var(--space-3);
}

.t-card__icon {
  flex-shrink: 0;
  color: var(--primary);
}

.t-card__title {
  font-size: var(--font-size-lead);
  font-weight: var(--font-weight-semibold);
  color: var(--foreground);
  line-height: var(--line-height-tight);
}

.t-card__body {
  color: var(--foreground);
}

.t-card__footer {
  margin-top: var(--space-4);
  padding-top: var(--space-3);
  border-top: 1px solid var(--border-subtle);
}
</style>
