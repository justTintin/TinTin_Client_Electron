<script setup lang="ts">
// ═══════════════════════════════════════════════════════════════
// OtVideoMarketing.vue — 视频营销选题（运营工具 · 骨架占位）
// 落地文档 2026-08-30 §4.6：爆款运营视频拆解 + 品牌 + 文案仿写选题；
// 链路分批实施，本版仅骨架。
// ═══════════════════════════════════════════════════════════════
</script>

<template>
  <div class="ot-placeholder">
    <div class="ph-icon">🎯</div>
    <h2 class="ph-title">视频营销选题</h2>
    <p class="ph-desc">爆款运营视频拆解 + 品牌结合 + 文案仿写，产出可执行选题。</p>
    <p class="ph-tip">该模块按《运营工具功能落地文档 2026-08-30》分批实施，骨架已就位。</p>
  </div>
</template>

<style scoped>
.ot-placeholder {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: var(--space-12) var(--space-6);
  background: var(--card);
  border: 1px dashed var(--border);
  border-radius: var(--radius-xl);
  text-align: center;
}
.ph-icon { font-size: 44px; line-height: 1; margin-bottom: var(--space-4); }
.ph-title { margin: 0 0 var(--space-2); font-size: var(--font-size-h2); color: var(--foreground); }
.ph-desc {
  margin: 0 auto var(--space-3);
  max-width: 460px;
  font-size: var(--font-size-body);
  line-height: 1.6;
  color: var(--muted-foreground);
}
.ph-tip { font-size: 12px; color: var(--foreground-subtle); }
</style>
