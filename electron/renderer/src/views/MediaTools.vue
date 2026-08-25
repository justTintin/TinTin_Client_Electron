<script setup lang="ts">
// ═══════════════════════════════════════════════════════════════
// MediaTools.vue — 媒体工具（10张卡片，无分组响应式网格）
// ═══════════════════════════════════════════════════════════════

import { ref } from 'vue'

interface ToolCard {
  id: string
  title: string
  desc: string
  emoji: string
  accent: string   // 图标背景渐变
  tag?: string
}

const tools = ref<ToolCard[]>([
  {
    id: 'ai-script',
    title: 'AI脚本创作',
    desc: '输入产品卖点，一键生成 15/30/60s 短视频脚本，含分镜提示词。',
    emoji: '📝',
    accent: 'linear-gradient(135deg, #6366F1 0%, #A855F7 100%)'
  },
  {
    id: 'one-click',
    title: '一键成片',
    desc: '上传产品素材，自动剪辑包装为成片，并同步到平台草稿箱。',
    emoji: '🎬',
    accent: 'linear-gradient(135deg, #F43F5E 0%, #F97316 100%)',
    tag: 'HOT'
  },
  {
    id: 'product-lib',
    title: '产品库管理',
    desc: '集中管理 SKU 图、详情页、规格参数，一键关联到脚本与项目。',
    emoji: '📦',
    accent: 'linear-gradient(135deg, #0EA5E9 0%, #06B6D4 100%)'
  },
  {
    id: 'asset-gen',
    title: '素材生成',
    desc: 'AI 生成产品主图、场景图、转场素材，支持风格模板。',
    emoji: '🖼️',
    accent: 'linear-gradient(135deg, #10B981 0%, #14B8A6 100%)'
  },
  {
    id: 'audio-asset',
    title: '音频素材',
    desc: '海量 BGM / 音效 / AI 配音库，按节奏与场景智能推荐。',
    emoji: '🎵',
    accent: 'linear-gradient(135deg, #8B5CF6 0%, #EC4899 100%)'
  },
  {
    id: 'video-mix',
    title: '视频混剪',
    desc: '多机位素材自动对齐节奏，批量产出不同版本的成片。',
    emoji: '✂️',
    accent: 'linear-gradient(135deg, #F59E0B 0%, #EF4444 100%)'
  },
  {
    id: 'live-clip',
    title: '直播切片',
    desc: '回放自动识别高光时刻，生成切片并一键发布短视频。',
    emoji: '🎙️',
    accent: 'linear-gradient(135deg, #EF4444 0%, #DC2626 100%)'
  },
  {
    id: 'data-analytics',
    title: '数据分析',
    desc: '汇总抖音 / 视频号 / 快手数据，生成投放效果与爆款分析。',
    emoji: '📊',
    accent: 'linear-gradient(135deg, #06B6D4 0%, #3B82F6 100%)'
  },
  {
    id: 'video-restore',
    title: '视频修复',
    desc: '老素材 / 直播回放超分与去噪，4K 画质重建。',
    emoji: '✨',
    accent: 'linear-gradient(135deg, #3B82F6 0%, #8B5CF6 100%)'
  },
  {
    id: 'cover-design',
    title: '封面设计',
    desc: '基于平台爆款样式自动生成封面，一键替换文字与产品图。',
    emoji: '🎨',
    accent: 'linear-gradient(135deg, #EC4899 0%, #F43F5E 100%)'
  }
])

const selectedId = ref<string | null>('one-click')

function selectTool(id: string) {
  selectedId.value = selectedId.value === id ? null : id
}
</script>

<template>
  <section class="media-tools">
    <div class="tools-grid">
      <div
        v-for="t in tools"
        :key="t.id"
        class="tool-card"
        :class="{ active: selectedId === t.id }"
        @click="selectTool(t.id)"
      >
        <div class="card-top">
          <div class="tool-icon" :style="{ background: t.accent }">
            <span>{{ t.emoji }}</span>
          </div>
          <span v-if="t.tag" class="hot-tag">{{ t.tag }}</span>
        </div>
        <h3 class="tool-title">{{ t.title }}</h3>
        <p class="tool-desc">{{ t.desc }}</p>
        <div class="card-foot">
          <span class="arrow-ic">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M5 12h14" />
              <path d="M12 5l7 7-7 7" />
            </svg>
          </span>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.media-tools {
  width: 100%;
  height: 100%;
  overflow: auto;
  padding: var(--space-6);
  background: var(--background);
}

.tools-grid {
  display: grid;
  gap: var(--space-4);
  grid-template-columns: repeat(4, minmax(0, 1fr));
}

.tool-card {
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

.tool-card:hover {
  transform: translateY(-2px);
  border-color: var(--primary-hover);
  box-shadow: var(--shadow-3);
  background: var(--card-hover);
}

.tool-card.active {
  border-color: var(--primary);
  box-shadow: 0 0 0 3px var(--ring);
}

.card-top {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  margin-bottom: var(--space-4);
}

.tool-icon {
  width: 56px;
  height: 56px;
  border-radius: 14px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 28px;
  line-height: 1;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.08);
  color: #fff;
}

.hot-tag {
  padding: 3px 8px;
  background: linear-gradient(135deg, #F43F5E 0%, #F97316 100%);
  color: #fff;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.06em;
  border-radius: 999px;
  line-height: 1;
}

.tool-title {
  margin: 0 0 var(--space-2);
  font-size: var(--font-size-h3);
  font-weight: 700;
  line-height: var(--line-height-tight);
  color: var(--foreground);
}

.tool-desc {
  margin: 0;
  font-size: var(--font-size-small);
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
  background: var(--primary-container);
  transition: transform var(--duration-fast), background var(--duration-fast);
}

.tool-card:hover .arrow-ic {
  transform: translateX(2px);
  background: var(--primary);
  color: var(--primary-foreground);
}

/* 响应式断点：5列/4列/3列/2列/1列 */
@media (min-width: 1440px) {
  .tools-grid {
    grid-template-columns: repeat(5, minmax(0, 1fr));
  }
}

@media (max-width: 1100px) {
  .tools-grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}

@media (max-width: 800px) {
  .tools-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 560px) {
  .media-tools {
    padding: var(--space-4);
  }
  .tools-grid {
    grid-template-columns: repeat(1, minmax(0, 1fr));
  }
}
</style>
