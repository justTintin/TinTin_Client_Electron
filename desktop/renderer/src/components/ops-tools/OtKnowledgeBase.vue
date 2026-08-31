<script setup lang="ts">
// ═══════════════════════════════════════════════════════════════
// OtKnowledgeBase.vue — 企业知识库（运营工具 · 骨架占位）
// 落地文档 2026-08-30 §4.2：结构化分类（公司介绍/产品资料/品牌背书/行业资讯等）
// + 分类文档 + 参考素材列表；数据层分批实施，本版仅骨架。
// ═══════════════════════════════════════════════════════════════
</script>

<template>
  <div class="ot-placeholder">
    <div class="ph-icon">📚</div>
    <h2 class="ph-title">企业知识库</h2>
    <p class="ph-desc">结构化分类（公司介绍/产品资料/品牌背书/行业资讯）+ 分类文档 + 参考素材列表。</p>
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
