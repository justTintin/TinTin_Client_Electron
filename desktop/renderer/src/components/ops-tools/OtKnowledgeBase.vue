<script setup lang="ts">
// ═══════════════════════════════════════════════════════════════
// OtKnowledgeBase.vue — 我的知识库（运营工具 · 骨架占位，整块暂缓）
//
// 2026-09-02 复校结论（详见 docs/媒体工具功能对齐检查报告_2026-09-02.md §7.2.2）：
//   原客户端 my_knowledge_page.py 文件头即「以「风格化」为核心的三区布局」，
//   三区（风格化列表 / 画像详情 / 参考素材）+ 工具栏（同步/导入/提炼）+ 状态栏统计
//   100% 属风格化管理；数据层 ENTRY_TYPES 虽定义 8 类，但全仓库无页面引用、
//   add_item/update_item 在 GUI 无调用点，三个创作页只 import STYLIZATION_TYPE。
//   ⇒「我的知识库」≡「风格化管理」，二者同一模块。
//
// 2026-09-02 用户裁决：风格化管理暂时不做 ⇒ 本模块整块暂缓，保持骨架占位。
// 旧骨架文案「公司介绍/产品资料/品牌背书/行业资讯 + 分类文档」系虚构，原客户端
//   不存在（且「产品资料」是另一套独立库，已实现为 OtProductLibrary.vue），已校正。
// ═══════════════════════════════════════════════════════════════
</script>

<template>
  <div class="ot-placeholder">
    <div class="ph-icon">📚</div>
    <h2 class="ph-title">我的知识库</h2>
    <p class="ph-desc">
      风格化画像 + 参考素材蒸馏：按账号风格/内容类型/产品品类/行业垂类分组，
      从收藏素材提炼写作风格画像，供产品文案与分镜脚本创作时注入 prompt。
    </p>
    <p class="ph-tip">
      ⏸️ 本模块即「风格化管理」，按 2026-09-02 用户裁决整块暂缓，暂不实施。
    </p>
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
