<script setup lang="ts">
// ═══════════════════════════════════════════════════════════════
// OpsTools.vue — 运营工具（卡片 Launcher，模式对齐 MediaTools.vue）
// 落地文档 2026-08-30 §三：两大组 4 大模块（骨架占位，分批实施）
//   方案脚本：产品资料 / 企业知识库
//   视频运营：视频评价预测 / 视频营销检测
// 2026-08-30 用户裁决：飞书脚本创作不移植；产品文案创作、分镜脚本创作
//   划归媒体工具 Tab（组件同目录 components/ops-tools/，由 MediaTools 引用）。
// 2026-09-04 用户裁决：媒体工具提示词组 2 卡（图片/视频反推提示词）划归运营工具
//   （组件仍在 components/media-tools/，由 OpsTools 引用）。
// ═══════════════════════════════════════════════════════════════

import { shallowRef, defineAsyncComponent, type Component } from 'vue'
import OtToolCard from '@/components/ops-tools/OtToolCard.vue'

type ToolKind = 'comp'

interface ToolItem {
  id: string
  title: string
  desc: string
  group: string
  emoji: string
  accent: string
  kind: ToolKind
  /** kind=comp：工具组件 */
  comp?: Component
  /** 骨架占位标记（模块分批实施中） */
  status?: 'ready' | 'planned'
}

/* 分组与模块（落地文档 2026-08-30 §三 定稿卡片清单；2026-09-04 增提示词组，
   方案脚本组改名「产品知识」，提示词置于视频运营上方） */
const GROUPS = ['产品知识', '提示词', '视频运营'] as const

const GROUP_TOOLS: Record<string, ToolItem[]> = {
  产品知识: [
    { id: 'product-library', title: '产品资料', desc: '品类/品牌/型号树状管理，服务端同步', group: '产品知识', emoji: '📦', accent: 'linear-gradient(135deg,#8B5CF6 0%,#EC4899 100%)', kind: 'comp', comp: defineAsyncComponent(() => import('@/components/ops-tools/OtProductLibrary.vue')), status: 'ready' },
    { id: 'knowledge-base',  title: '我的知识库', desc: '风格化画像 + 参考素材蒸馏', group: '产品知识', emoji: '📚', accent: 'linear-gradient(135deg,#0EA5E9 0%,#06B6D4 100%)', kind: 'comp', comp: defineAsyncComponent(() => import('@/components/ops-tools/OtKnowledgeBase.vue')), status: 'planned' },
  ],
  提示词: [
    // 2026-09-04 自媒体工具提示词组划入（组件仍在 media-tools/，完整实现 status=ready）
    { id: 'reverse-prompt-image', title: '图片反推提示词', desc: '上传图片，AI 生成绘画提示词', group: '提示词', emoji: '🖼️', accent: 'linear-gradient(135deg,#10B981 0%,#14B8A6 100%)', kind: 'comp', comp: defineAsyncComponent(() => import('@/components/media-tools/ReversePromptImage.vue')), status: 'ready' },
    { id: 'reverse-prompt-video', title: '视频反推提示词', desc: '上传视频，框选片段生成提示词', group: '提示词', emoji: '🎬', accent: 'linear-gradient(135deg,#3B82F6 0%,#8B5CF6 100%)', kind: 'comp', comp: defineAsyncComponent(() => import('@/components/media-tools/ReversePromptVideo.vue')), status: 'ready' },
  ],
  视频运营: [
    { id: 'video-score',    title: '视频评价预测', desc: '关键帧 → 视觉模型预测视频表现', group: '视频运营', emoji: '📈', accent: 'linear-gradient(135deg,#F59E0B 0%,#EF4444 100%)', kind: 'comp', comp: defineAsyncComponent(() => import('@/components/ops-tools/OtVideoScore.vue')), status: 'ready' },
    { id: 'video-marketing', title: '视频营销检测', desc: '研判是否营销视频 + 品类 + 改进建议', group: '视频运营', emoji: '🎯', accent: 'linear-gradient(135deg,#10B981 0%,#14B8A6 100%)', kind: 'comp', comp: defineAsyncComponent(() => import('@/components/ops-tools/OtVideoMarketing.vue')), status: 'ready' },
  ],
}

/** 当前打开的模块（null = 网格）；shallowRef 避免深响应包裹 async 组件 */
const activeTool = shallowRef<ToolItem | null>(null)

/** 卡片点击 → 进入模块页 */
function openTool(t: ToolItem) {
  activeTool.value = t
}

/** 模块页 → 返回网格 */
function backToGrid() {
  activeTool.value = null
}
</script>

<template>
  <section class="ops-tools">
    <Transition name="slide-up" mode="out-in">
    <!-- ═══ 模块详情页 ═══ -->
    <div v-if="activeTool" key="detail" class="detail-view">
      <div class="tool-bar">
        <button class="back-btn" @click="backToGrid">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M19 12H5" />
            <path d="M12 19l-7-7 7-7" />
          </svg>
          返回运营工具
        </button>
        <h1 class="tool-bar-title">
          <span class="tool-bar-emoji">{{ activeTool.emoji }}</span>
          {{ activeTool.title }}
          <span class="tool-bar-group">{{ activeTool.group }}</span>
        </h1>
      </div>

      <div class="tool-host">
        <keep-alive v-if="activeTool.kind === 'comp' && activeTool.comp">
          <component :is="activeTool.comp" :key="activeTool.id" />
        </keep-alive>
      </div>
    </div>

    <!-- ═══ 模块网格（按分组） ═══ -->
    <div v-else key="grid" class="grid-view">
      <div class="page-head">
        <h1 class="page-title">运营工具</h1>
        <p class="page-sub">产品资料 · 我的知识库 · 视频评价预测 · 视频营销检测 · 反推提示词</p>
      </div>

      <div v-for="g in GROUPS" :key="g" class="group-block">
        <div class="group-label">{{ g }}</div>
        <div class="tools-grid">
          <OtToolCard
            v-for="(t, idx) in GROUP_TOOLS[g]"
            :key="t.id"
            :emoji="t.emoji"
            :accent="t.accent"
            :title="t.title"
            :desc="t.desc"
            :status="t.status"
            :style="{ animationDelay: `${idx * 35}ms` }"
            @open="openTool(t)"
          />
        </div>
      </div>
    </div>
    </Transition>
  </section>
</template>

<style scoped>
.ops-tools {
  width: 100%;
  height: 100%;
  overflow-y: auto;
  padding: var(--space-6);
  background: var(--background);
}

/* 网格 ↔ 详情 切换动画 */
.slide-up-enter-active,
.slide-up-leave-active {
  transition: opacity 0.2s var(--easing-out), transform 0.2s var(--easing-out);
}
.slide-up-enter-from {
  opacity: 0;
  transform: translateY(12px);
}
.slide-up-leave-to {
  opacity: 0;
  transform: translateY(-6px);
}

/* 页头 */
.page-head { margin-bottom: var(--space-5); }
.page-title {
  margin: 0 0 var(--space-1);
  font-size: 24px;
  font-weight: 700;
  line-height: 1.2;
  color: var(--foreground);
}
.page-sub {
  margin: 0;
  font-size: var(--font-size-body);
  color: var(--muted-foreground);
}

/* 分组 */
.group-block { margin-bottom: var(--space-6); }
.group-block:last-child { margin-bottom: 0; }
.group-label {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--muted-foreground);
  margin-bottom: var(--space-3);
}

/* 模块详情页顶栏 */
.tool-bar {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  padding-bottom: var(--space-4);
  margin-bottom: var(--space-4);
  border-bottom: 1px solid var(--border);
}
.back-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 34px;
  padding: 0 var(--space-3);
  background: var(--surface-container);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  color: var(--foreground);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: all var(--duration-fast);
}
.back-btn:hover { border-color: var(--primary); color: var(--primary); }
.tool-bar-title {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin: 0;
  font-size: 20px;
  font-weight: 700;
  color: var(--foreground);
}
.tool-bar-emoji { font-size: 22px; line-height: 1; }
.tool-bar-group {
  font-size: 11px;
  font-weight: 600;
  color: var(--muted-foreground);
  background: var(--surface-container);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 2px 10px;
}
.tool-host { min-height: 0; }

/* 网格 */
.tools-grid {
  display: grid;
  gap: var(--space-4);
  grid-template-columns: repeat(4, minmax(0, 1fr));
}
@media (min-width: 1440px) { .tools-grid { grid-template-columns: repeat(5, minmax(0, 1fr)); } }
@media (max-width: 1100px) { .tools-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
@media (max-width: 800px)  { .tools-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 560px) {
  .ops-tools { padding: var(--space-4); }
  .tools-grid { grid-template-columns: repeat(1, minmax(0, 1fr)); }
}
</style>
