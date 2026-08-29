<script setup lang="ts">
// WbSlashPopup.vue — 斜杠菜单浮层（输入 / 唤起智能体候选列表）
// 纯展示：候选过滤在容器（filterSlashCandidates 纯函数），选中上报由
// 容器执行唤醒词插入（applyAgentWakeInsert，原版 _SlashPopup 口径）。
import type { WorkbenchAgent } from '@/composables/workbenchChatContext'

defineProps<{
  visible: boolean
  candidates: WorkbenchAgent[]
  /** 键盘 ↑↓ 当前高亮行（容器 onKeydown 维护） */
  activeIndex?: number
}>()

const emit = defineEmits<{
  (e: 'select', agent: WorkbenchAgent): void
}>()
</script>

<template>
  <div v-if="visible" class="slash-pop">
    <button
      v-for="(a, i) in candidates"
      :key="a.id || a.name"
      class="slash-row"
      :class="{ active: i === activeIndex }"
      type="button"
      :title="a.desc"
      @mousedown.prevent="emit('select', a)"
    >
      <span class="slash-name">{{ a.name }}</span>
      <span class="slash-desc">{{ a.desc }}</span>
    </button>
  </div>
</template>

<style scoped>
.slash-pop {
  position: absolute;
  left: 0;
  bottom: calc(100% + 6px);
  z-index: 30;
  min-width: 280px;
  max-width: 480px;
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

.slash-row {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  padding: 6px var(--space-2);
  border-radius: var(--radius-md);
  text-align: left;
  transition: background var(--duration-fast);
}

.slash-row:hover,
.slash-row.active {
  background: var(--surface-container-high);
}

.slash-name {
  font-size: 13px;
  font-weight: var(--font-weight-medium);
  color: var(--foreground);
  white-space: nowrap;
}

.slash-desc {
  font-size: 12px;
  color: var(--muted-foreground);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
