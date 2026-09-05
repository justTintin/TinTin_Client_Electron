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
  <div class="ot-card glass-card stagger-item" :style="{ '--card-accent': accent }" @click="emit('open')">
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
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
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
  /* 2026-09-04 用户裁决：主色调淡染底色已承担视觉分区，卡片描边移除 */
  border: none;
  border-radius: var(--radius-xl);
  padding: var(--space-5);
  cursor: pointer;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  transition:
    transform var(--duration-normal) var(--easing-default),
    box-shadow var(--duration-normal) var(--easing-default),
    background var(--duration-fast);
}
/* 主色调光晕层（2026-09-04 用户裁决二稿：默认以图标底色 accent 淡染卡片，
   hover/点击时卡片变毛玻璃——半透明+backdrop blur，光晕同步增强） */
.ot-card::before {
  content: '';
  position: absolute;
  inset: -60%;
  z-index: 0;
  background: var(
    --card-accent,
    conic-gradient(
      from 0deg at 50% 50%,
      #a78bfa 0deg,
      #fbbf24 60deg,
      #f472b6 120deg,
      #67e8f9 180deg,
      #a78bfa 240deg,
      #fbbf24 300deg,
      #a78bfa 360deg
    )
  );
  opacity: 0.07;
  filter: blur(40px);
  animation: aurora-spin 8s linear infinite;
  transition: opacity 0.4s;
  pointer-events: none;
}
.ot-card:hover::before {
  opacity: 0.16;
}
@keyframes aurora-spin {
  to { transform: rotate(360deg); }
}
/* 确保卡片内容在渐变之上 */
.ot-card > * {
  position: relative;
  z-index: 1;
}
.ot-card:hover {
  transform: translateY(-2px);
  box-shadow: var(--shadow-3);
  /* 毛玻璃：半透明卡身 + 背景模糊，图标同色光晕隐约透出 */
  background: color-mix(in srgb, var(--card) 62%, transparent);
  backdrop-filter: blur(14px) saturate(160%);
  -webkit-backdrop-filter: blur(14px) saturate(160%);
}
/* 暗色模式下渐变更明显 */
:root.dark .ot-card:hover::before {
  opacity: 0.25;
}
/* 玻璃质感模式覆盖 */
:global(html.glass-mode) .ot-card {
  background: color-mix(in srgb, var(--card) 72%, transparent);
  backdrop-filter: blur(12px) saturate(160%);
  -webkit-backdrop-filter: blur(12px) saturate(160%);
  box-shadow:
    0 2px 8px rgba(0, 0, 0, 0.04),
    inset 0 1px 0 rgba(255, 255, 255, 0.08);
}
:global(html.glass-mode):root.dark .ot-card {
  background: color-mix(in srgb, var(--card) 80%, transparent);
  box-shadow:
    0 2px 8px rgba(0, 0, 0, 0.2),
    inset 0 1px 0 rgba(255, 255, 255, 0.05);
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
  /* 2026-09-04 用户裁决：分割线移除后，箭头中线上移对齐原分割线位置
     （原分割线 = desc底 + margin 16px；箭头 36px 半高 18px → margin-top = 16-18 = -2px） */
  margin-top: -2px;
  display: flex;
  align-items: center;
  justify-content: flex-end;
}
.arrow-ic {
  width: 36px;
  height: 36px;
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
