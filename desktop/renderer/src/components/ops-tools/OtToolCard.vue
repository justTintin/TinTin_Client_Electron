<script setup lang="ts">
// ═══════════════════════════════════════════════════════════════
// OtToolCard.vue — 运营工具通用卡片（图标 + 名称 + 描述 + 状态）
// 落地文档 2026-08-30 §三：OpsTools Launcher 卡片统一走本组件
// status: 'ready' 可进入 | 'planned' 骨架占位（按文档分批实施）
// ═══════════════════════════════════════════════════════════════

defineProps<{
  emoji: string
  accent: string
  title: string
  desc: string
  status?: 'ready' | 'planned'
}>()

const emit = defineEmits<{
  (e: 'open'): void
}>()
</script>

<template>
  <div class="ot-card" @click="emit('open')">
    <div class="card-top">
      <div class="tool-icon" :style="{ background: accent }">
        <span>{{ emoji }}</span>
      </div>
      <span v-if="status === 'planned'" class="status-badge">建设中</span>
    </div>
    <h3 class="tool-title">{{ title }}</h3>
    <p class="tool-desc">{{ desc }}</p>
    <div class="card-foot">
      <span class="arrow-ic">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M5 12h14" />
          <path d="M12 5l7 7-7 7" />
        </svg>
      </span>
    </div>
  </div>
</template>

<style scoped>
.ot-card {
  position: relative;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: var(--radius-xl);
  padding: var(--space-5);
  cursor: pointer;
  display: flex;
  flex-direction: column;
  transition:
    transform var(--duration-normal) var(--easing-default),
    border-color var(--duration-fast),
    box-shadow var(--duration-normal) var(--easing-default),
    background var(--duration-fast);
}
.ot-card:hover {
  transform: translateY(-2px);
  border-color: var(--primary-hover);
  box-shadow: var(--shadow-3);
}
.card-top {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  margin-bottom: var(--space-4);
}
.tool-icon {
  width: 52px;
  height: 52px;
  border-radius: 14px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 26px;
  line-height: 1;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.08);
  color: #fff;
}
.status-badge {
  font-size: 11px;
  font-weight: 600;
  color: var(--muted-foreground);
  background: var(--surface-container);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 2px 10px;
}
.tool-title { margin: 0 0 var(--space-2); font-size: var(--font-size-h3); font-weight: 700; line-height: var(--line-height-tight); color: var(--foreground); }
.tool-desc {
  margin: 0;
  font-size: var(--font-size-body);
  line-height: var(--line-height-body);
  color: var(--muted-foreground);
  flex: 1 1 auto;
}
.card-foot {
  margin-top: var(--space-4);
  padding-top: var(--space-3);
  border-top: 1px solid var(--border);
  display: flex;
  align-items: center;
  justify-content: flex-end;
}
.arrow-ic {
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
  color: var(--primary);
  background: var(--surface-container);
  transition: transform var(--duration-fast), background var(--duration-fast);
}
.ot-card:hover .arrow-ic {
  transform: translateX(2px);
  background: var(--primary);
  color: var(--primary-foreground);
}
</style>
