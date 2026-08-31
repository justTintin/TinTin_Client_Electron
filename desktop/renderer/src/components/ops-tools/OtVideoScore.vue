<script setup lang="ts">
// ═══════════════════════════════════════════════════════════════
// OtVideoScore.vue — 视频数据预估（运营工具 · 骨架占位）
// 落地文档 2026-08-30 §4.5：关键帧 → 视觉模型预估视频数据；
// 采集/打分链路分批实施，本版仅骨架。
// ═══════════════════════════════════════════════════════════════
</script>

<template>
  <div class="ot-placeholder">
    <div class="ph-icon">📈</div>
    <h2 class="ph-title">视频数据预估</h2>
    <p class="ph-desc">提取关键帧，经视觉模型预估视频数据表现。</p>
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
