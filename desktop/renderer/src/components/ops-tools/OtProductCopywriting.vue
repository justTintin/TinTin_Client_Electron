<script setup lang="ts">
// ═══════════════════════════════════════════════════════════════
// OtProductCopywriting.vue — 产品文案创作（媒体工具卡 · 骨架占位）
// 2026-08-30 用户裁决：自原「方案脚本」组划归媒体工具 Tab。
// 参照原 product_script_page.py：选产品 → 查看性能参数&核心卖点
// → 可选风格化条目（知识库）→ 附加提示词 → 一键生成文案 → 风格改写。
// 数据层接口与交互分批实施，本版仅骨架。
// ═══════════════════════════════════════════════════════════════
</script>

<template>
  <div class="ot-placeholder">
    <div class="ph-icon">✍️</div>
    <h2 class="ph-title">产品文案创作</h2>
    <p class="ph-desc">选产品 → 查看性能参数与核心卖点 → 可选风格化条目 → 一键生成文案，生成后可调风格改写。</p>
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
