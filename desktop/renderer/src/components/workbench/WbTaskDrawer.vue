<script setup lang="ts">
// WbTaskDrawer.vue — 任务队列抽屉本体（纯展示）
// 抽屉开关（v-if + notify-mask 遮罩 + 过渡动画）由容器持有；
// statusText 为 useWorkbenchTasks 模块级唯一定义的纯函数，此处直接 import。
import type { TaskRow } from '@/composables/useWorkbenchTasks'
import { statusText } from '@/composables/useWorkbenchTasks'

defineProps<{
  rows: TaskRow[]
}>()

const emit = defineEmits<{
  /** 关闭按钮与遮罩共用（容器接原 closeTaskQueue） */
  (e: 'close'): void
}>()
</script>

<template>
  <aside class="notify-drawer taskq-drawer" aria-label="任务队列">
    <header class="notify-head">
      <span class="notify-title">任务队列</span>
      <span class="notify-head-badge">{{ rows.length }} 项</span>
      <button class="notify-actions" @click="emit('close')" title="关闭">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </header>
    <div class="notify-body">
      <div v-for="t in rows" :key="t.id" class="taskq-row">
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
      <div v-if="rows.length === 0" class="notify-empty">暂无任务</div>
    </div>
  </aside>
</template>

<style scoped>
/* 抽屉骨架/头部与任务行样式自持副本（与原 Workbench scoped 定义逐字一致；
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

.notify-empty {
  padding: var(--space-8) 0;
  text-align: center;
  font-size: 13px;
  color: var(--muted-foreground);
}
</style>
