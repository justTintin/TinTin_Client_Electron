<script setup lang="ts">
// ═══════════════════════════════════════════════════════════════
// MediaTools.vue — 媒体工具（按原来客户端的模块分组 Launcher）
//   分组：创作 / 素材 / 文案 / 运营 / 工具
//   每个工具卡片点击 → 跳转到：
//     · comp  → 真实工具组件页（懒加载）
//     · route → 路由跳转（如 素材浏览器 → /browser）
//     · note  → 能力定位占位页（该能力在工作台/其他模块，待接入此处）
// ═══════════════════════════════════════════════════════════════

import { shallowRef, defineAsyncComponent, type Component } from 'vue'
import { useRouter } from 'vue-router'

type ToolKind = 'comp' | 'route'

interface ToolItem {
  id: string
  title: string
  desc: string
  group: string
  emoji: string
  accent: string
  kind: ToolKind
  /** 建设中：卡片带角标，点击进入建设中占位页（不加载真实组件） */
  wip?: boolean
  /** kind=comp：真实组件 */
  comp?: Component
  /** kind=route：目标路由 */
  to?: string
}

const router = useRouter()

/* 分组顺序与工具（原客户端 media_tools_page.py：图形/视频/提示词 3 组 8 张 + 混剪/切片入口）
   2026-09-04 用户裁决：混剪/切片划入「视频」组；新增「音频」组（音频生成 + 声音克隆）；视频修复转建设中
   音频生成：移植原客户端 audio_material_page.py「 AI 生成」tab（BGM MusicGen + 音效 AudioLDM2）
   2026-09-04 二次裁决：「创作」组改名「文案脚本」（分镜脚本创作）；提示词组 2 卡划归运营工具
   2026-09-05 用户裁决：删除「产品知识」卡——其文案生成能力已迁入运营工具·产品资料页
   （OtCopywritingPanel.vue），本组仅保留分镜脚本创作 */
const GROUPS = ['文案脚本', '图形', '视频', '音频'] as const

const GROUP_TOOLS: Record<string, ToolItem[]> = {
  文案脚本: [
    // 2026-08-30 用户裁决：分镜脚本创作 自原「方案脚本」组划归媒体工具；
    // 2026-09-05 用户裁决：删除「产品知识」卡（文案生成已迁运营工具·产品资料页）
    { id: 'storyboard',  title: '分镜脚本创作', desc: '文案 → 分镜 → 引用素材 → 保存脚本库', group: '文案脚本', emoji: '🎬', accent: 'linear-gradient(135deg,#F97316 0%,#EC4899 100%)', kind: 'comp', comp: defineAsyncComponent(() => import('@/components/ops-tools/OtStoryboard.vue')) },
  ],
  图形: [
    { id: 'cover-design',   title: '封面制作',   desc: '商品封面图快速制作', group: '图形', emoji: '🎨', accent: 'linear-gradient(135deg,#EC4899 0%,#F43F5E 100%)', kind: 'comp', wip: true, comp: defineAsyncComponent(() => import('@/components/media-tools/CoverMaker.vue')) },
    { id: 'image-matting',  title: '图像抠图',   desc: '智能抠图 / 去除背景', group: '图形', emoji: '✂️', accent: 'linear-gradient(135deg,#0EA5E9 0%,#06B6D4 100%)', kind: 'comp', comp: defineAsyncComponent(() => import('@/components/media-tools/ImageMatting.vue')) },
  ],
  视频: [
    { id: 'video-montage', title: '智能混剪', desc: '4步流水线：镜头切割/重组/口播配音/特效', group: '视频', emoji: '✂️', accent: 'linear-gradient(135deg,#8B5CF6 0%,#EC4899 100%)', kind: 'comp', comp: defineAsyncComponent(() => import('@/components/media-tools/VideoMontage.vue')) },
    { id: 'live-slice',    title: '直播切片', desc: '视频分析热点发现→切片与封面生成', group: '视频', emoji: '📡', accent: 'linear-gradient(135deg,#EF4444 0%,#DC2626 100%)', kind: 'comp', comp: defineAsyncComponent(() => import('@/components/media-tools/LiveClip.vue')) },
    { id: 'video-repair',      title: '视频修复',     desc: '画质修复 / 工作流处理', group: '视频', emoji: '🛠️', accent: 'linear-gradient(135deg,#F59E0B 0%,#EF4444 100%)', kind: 'comp', wip: true, comp: defineAsyncComponent(() => import('@/components/media-tools/VideoRepair.vue')) },
    { id: 'video-transcribe',  title: '视频转文字',   desc: '视频语音自动转写',       group: '视频', emoji: '📄', accent: 'linear-gradient(135deg,#6366F1 0%,#A855F7 100%)', kind: 'comp', comp: defineAsyncComponent(() => import('@/components/media-tools/VideoTranscribe.vue')) },
    { id: 'subtitle-removal',  title: '视频去水印字幕', desc: '去除字幕 / 台标水印',  group: '视频', emoji: '🔤', accent: 'linear-gradient(135deg,#F59E0B 0%,#EF4444 100%)', kind: 'comp', comp: defineAsyncComponent(() => import('@/components/media-tools/SubtitleRemoval.vue')) },
  ],
  音频: [
    { id: 'audio-gen',   title: '音频生成', desc: 'AI 生成 BGM / 音效，一键入库', group: '音频', emoji: '🔊', accent: 'linear-gradient(135deg,#14B8A6 0%,#0EA5E9 100%)', kind: 'comp', comp: defineAsyncComponent(() => import('@/components/media-tools/AudioGen.vue')) },
    { id: 'voice-clone', title: '声音克隆', desc: '克隆音色生成配音',       group: '音频', emoji: '🎵', accent: 'linear-gradient(135deg,#8B5CF6 0%,#EC4899 100%)', kind: 'comp', comp: defineAsyncComponent(() => import('@/components/media-tools/VoiceClone.vue')) },
  ],
}

/** 当前打开的工具（null = 网格）；shallowRef 避免深响应包裹 async 组件 */
const activeTool = shallowRef<ToolItem | null>(null)

/** 卡片点击：route 跳路由，其余进入工具组件页 */
function openTool(t: ToolItem) {
  if (t.kind === 'route' && t.to) {
    router.push(t.to)
    return
  }
  activeTool.value = t
}

/** 工具页 → 返回网格 */
function backToGrid() {
  activeTool.value = null
}
</script>

<template>
  <section class="media-tools">
    <!-- ═══ 工具详情页 ═══ -->
    <Transition name="slide-up" mode="out-in">
    <div v-if="activeTool" key="detail" class="detail-view">
      <div class="tool-bar">
        <button class="back-btn" @click="backToGrid">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M19 12H5" />
            <path d="M12 19l-7-7 7-7" />
          </svg>
          返回媒体工具
        </button>
        <h1 class="tool-bar-title">
          <span class="tool-bar-emoji">{{ activeTool.emoji }}</span>
          {{ activeTool.title }}
          <span class="tool-bar-group">{{ activeTool.group }}</span>
        </h1>
      </div>

      <div class="tool-host">
        <!-- 建设中占位（wip 优先，不加载真实组件） -->
        <div v-if="activeTool.wip" class="tool-note">
          <div class="note-icon">🚧</div>
          <h2 class="note-title">{{ activeTool.title }}</h2>
          <p class="note-desc">该功能正在建设中，敬请期待。</p>
          <p class="note-tip">可返回媒体工具使用其他功能。</p>
        </div>
        <!-- 真实组件（KeepAlive 缓存实例，切走不销毁，回来状态保留） -->
        <KeepAlive v-else-if="activeTool.kind === 'comp' && activeTool.comp">
          <component :is="activeTool.comp" :key="activeTool.id" />
        </KeepAlive>
        <!-- 能力定位占位 -->
        <div v-else class="tool-note">
          <div class="note-icon">{{ activeTool.emoji }}</div>
          <h2 class="note-title">{{ activeTool.title }}</h2>
          <p class="note-desc">该能力有独立路由入口，将跳转到对应功能页。</p>
          <p class="note-tip">可返回媒体工具，从下方卡片进入。</p>
        </div>
      </div>
    </div>

    <!-- ═══ 工具网格（按原分组） ═══ -->
    <div v-else key="grid" class="grid-view">
      <div class="page-head">
        <h1 class="page-title">媒体工具</h1>
        <p class="page-sub">选择需要执行的 AI 生产能力</p>
      </div>

      <div v-for="g in GROUPS" :key="g" class="group-block">
        <div class="group-label">{{ g }}</div>
        <div class="tools-grid">
          <div
            v-for="(t, idx) in GROUP_TOOLS[g]"
            :key="t.id"
            class="tool-card glass-card stagger-item"
            :class="{ 'is-wip': t.wip }"
            :style="{ animationDelay: `${idx * 35}ms`, '--card-accent': t.accent }"
            @click="openTool(t)"
          >
            <span v-if="t.wip" class="wip-badge">建设中</span>
            <div class="card-top">
              <div class="tool-icon" :style="{ background: t.accent }">
                <span>{{ t.emoji }}</span>
              </div>
            </div>
            <h3 class="tool-title">{{ t.title }}</h3>
            <p class="tool-desc">{{ t.desc }}</p>
            <div class="card-foot">
              <span class="arrow-ic">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M5 12h14" />
                  <path d="M12 5l7 7-7 7" />
                </svg>
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
    </Transition>
  </section>
</template>

<style scoped>
.media-tools {
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

/* 工具详情页顶栏 */
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

/* 能力定位占位页 */
.tool-note {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: var(--space-12) var(--space-6);
  background: var(--card);
  border: 1px dashed var(--border);
  border-radius: var(--radius-xl);
  text-align: center;
}
.note-icon { font-size: 44px; line-height: 1; margin-bottom: var(--space-4); }
.note-title { margin: 0 0 var(--space-2); font-size: var(--font-size-h2); color: var(--foreground); }
.note-desc {
  margin: 0 auto var(--space-3);
  max-width: 460px;
  font-size: var(--font-size-body);
  line-height: 1.6;
  color: var(--muted-foreground);
}
.note-tip { font-size: 12px; color: var(--foreground-subtle); }

/* 卡片 */
.tools-grid {
  display: grid;
  gap: var(--space-4);
  grid-template-columns: repeat(4, minmax(0, 1fr));
}
.tool-card {
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
.tool-card::before {
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
.tool-card:hover::before {
  opacity: 0.16;
}
@keyframes aurora-spin {
  to { transform: rotate(360deg); }
}
/* 确保卡片内容在渐变之上 */
.tool-card > * {
  position: relative;
  z-index: 1;
}
.tool-card:hover {
  transform: translateY(-2px);
  box-shadow: var(--shadow-3);
  /* 毛玻璃：半透明卡身 + 背景模糊，图标同色光晕隐约透出 */
  background: color-mix(in srgb, var(--card) 62%, transparent);
  backdrop-filter: blur(14px) saturate(160%);
  -webkit-backdrop-filter: blur(14px) saturate(160%);
}
/* 暗色模式下渐变更明显 */
:root.dark .tool-card:hover::before {
  opacity: 0.25;
}
/* 玻璃质感模式覆盖 */
:global(html.glass-mode) .tool-card {
  background: color-mix(in srgb, var(--card) 72%, transparent);
  backdrop-filter: blur(12px) saturate(160%);
  -webkit-backdrop-filter: blur(12px) saturate(160%);
  border: 1px solid color-mix(in srgb, var(--border) 60%, transparent);
  box-shadow:
    0 2px 8px rgba(0, 0, 0, 0.04),
    inset 0 1px 0 rgba(255, 255, 255, 0.08);
}
:global(html.glass-mode):root.dark .tool-card {
  background: color-mix(in srgb, var(--card) 80%, transparent);
  box-shadow:
    0 2px 8px rgba(0, 0, 0, 0.2),
    inset 0 1px 0 rgba(255, 255, 255, 0.05);
}
/* 建设中卡片：降饱和 + 角标 */
.tool-card.is-wip .tool-icon { filter: grayscale(0.6); opacity: 0.75; }
.wip-badge {
  position: absolute;
  top: var(--space-3);
  right: var(--space-3);
  font-size: 11px;
  font-weight: 600;
  color: var(--muted-foreground);
  background: var(--surface-container);
  border: 1px dashed var(--border);
  border-radius: 999px;
  padding: 2px 10px;
  pointer-events: none;
}
.card-top { display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: var(--space-4); }
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
.tool-card:hover .arrow-ic {
  transform: translateX(2px);
  background: var(--primary);
  color: var(--primary-foreground);
}

/* 响应式 */
@media (min-width: 1440px) { .tools-grid { grid-template-columns: repeat(5, minmax(0, 1fr)); } }
@media (max-width: 1100px) { .tools-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
@media (max-width: 800px)  { .tools-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 560px) {
  .media-tools { padding: var(--space-4); }
  .tools-grid { grid-template-columns: repeat(1, minmax(0, 1fr)); }
}
</style>