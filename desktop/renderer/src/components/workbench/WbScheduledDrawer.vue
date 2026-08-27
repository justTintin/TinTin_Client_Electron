<script setup lang="ts">
// WbScheduledDrawer.vue — 定时任务抽屉本体（纯展示；P1 占位，P2 实装）
// 移植基准：原客户端 studio/gui/scheduled_tasks_mgmt_page.py（Vue 原生重写）。
// 开关（v-if + notify-mask 遮罩 + drawer-slide/drawer-fade 过渡）由容器 Workbench.vue 持有，
// 与通知中心 / 任务队列抽屉完全同构。
const emit = defineEmits<{
  /** 关闭按钮（容器接 closeScheduled） */
  (e: 'close'): void
}>()
</script>

<template>
  <aside class="sched-drawer" aria-label="定时任务">
    <header class="sched-head">
      <span class="sched-title">定时任务</span>
      <button class="sched-actions" @click="emit('close')" title="关闭">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </header>
    <div class="sched-body">
      <div class="sched-empty">
        <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <circle cx="12" cy="12" r="10" />
          <path d="M12 6v6l4 2" />
        </svg>
        <div class="sched-empty-title">定时任务管理</div>
        <div class="sched-empty-desc">移植自原客户端「定时任务」页面，将在 P2 在此抽屉内实装</div>
      </div>
    </div>
  </aside>
</template>

<style scoped>
/* 抽屉骨架与通知抽屉同构（宽度/层级/背景一致）；
   .notify-mask 与过渡动画样式保留在容器 */
.sched-drawer {
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
.sched-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 14px 16px;
  border-bottom: 1px solid var(--border);
}
.sched-title {
  flex: 1;
  font-size: 14px;
  font-weight: 600;
}
.sched-actions {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 6px;
  color: var(--muted-foreground, #8a8f98);
}
.sched-actions:hover {
  background: var(--secondary, rgba(255, 255, 255, 0.06));
}
.sched-body {
  flex: 1;
  overflow: auto;
  padding: 16px;
}
.sched-empty {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: var(--muted-foreground, #8a8f98);
  text-align: center;
}
.sched-empty-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--foreground, #e6e8eb);
}
.sched-empty-desc {
  font-size: 12px;
}
</style>
