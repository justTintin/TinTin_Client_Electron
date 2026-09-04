<script setup lang="ts">
// ═══════════════════════════════════════════════════════════════
// CardTheme — 外观主题卡（本地配置分组：亮/暗/跟随系统 3 档）
// 模板自 Settings.vue L471-539 原样迁出（IRON-08）；直接消费
// appStore（无需 props）；THEME_TABS 常量随卡迁入。
// ═══════════════════════════════════════════════════════════════

import { useAppStore, type ThemeMode, type FontWeightLevel, type VisualStyle } from '../../stores/app'
import { computed } from 'vue'

const appStore = useAppStore()

/* 外观主题：3 档分段控件 */
const THEME_TABS: Array<{ value: ThemeMode; label: string; icon: string }> = [
  { value: 'light',  label: '亮色',    icon: '☀' },
  { value: 'dark',   label: '暗色',    icon: '🌙' },
  { value: 'system', label: '跟随系统', icon: '🖥' },
]

/* 界面风格：2 档分段控件 */
const VISUAL_STYLE_TABS: Array<{ value: VisualStyle; label: string; icon: string }> = [
  { value: 'standard', label: '标准',   icon: '▣' },
  { value: 'glass',    label: '玻璃质感', icon: '◐' },
]

/* 字体粗细：3 档分段控件 */
const FONT_WEIGHT_TABS: Array<{ value: FontWeightLevel; label: string; weight: number }> = [
  { value: 'regular',  label: '常规', weight: 400 },
  { value: 'medium',   label: '中等', weight: 500 },
  { value: 'semibold', label: '半粗', weight: 600 },
]

const fwPreviewWeight = computed(() => {
  const map: Record<string, number> = { regular: 400, medium: 500, semibold: 600 }
  return map[appStore.fontWeight] || 500
})
</script>

<template>
  <section class="luo-card theme-card">
    <div class="luo-card-head">
      <div>
        <h2 class="luo-card-title">外观主题</h2>
        <p class="luo-card-desc">{{ appStore.themeModeLabel }}</p>
      </div>
    </div>

    <div class="seg-wrap">
      <div class="segmented" role="tablist" aria-label="外观主题">
        <button
          v-for="t in THEME_TABS"
          :key="t.value"
          class="seg-item"
          :class="{ active: appStore.themeMode === t.value }"
          role="tab"
          :aria-selected="appStore.themeMode === t.value"
          @click="appStore.setThemeMode(t.value)"
        >
          <span class="seg-icon" aria-hidden="true">{{ t.icon }}</span>
          {{ t.label }}
        </button>
      </div>
    </div>

    <!-- 界面风格 -->
    <div class="luo-card-head" style="margin-top: var(--space-4)">
      <div>
        <h2 class="luo-card-title">界面风格</h2>
        <p class="luo-card-desc">{{ appStore.visualStyleLabel }}</p>
      </div>
    </div>

    <div class="seg-wrap">
      <div class="segmented" role="tablist" aria-label="界面风格">
        <button
          v-for="vs in VISUAL_STYLE_TABS"
          :key="vs.value"
          class="seg-item"
          :class="{ active: appStore.visualStyle === vs.value }"
          role="tab"
          :aria-selected="appStore.visualStyle === vs.value"
          @click="appStore.setVisualStyle(vs.value)"
        >
          <span class="seg-icon" aria-hidden="true">{{ vs.icon }}</span>
          {{ vs.label }}
        </button>
      </div>
    </div>

    <!-- 字体粗细 -->
    <div class="luo-card-head" style="margin-top: var(--space-4)">
      <div>
        <h2 class="luo-card-title">字体粗细</h2>
        <p class="luo-card-desc">{{ appStore.fontWeightLabel }}</p>
      </div>
    </div>

    <div class="seg-wrap">
      <div class="segmented" role="tablist" aria-label="字体粗细">
        <button
          v-for="fw in FONT_WEIGHT_TABS"
          :key="fw.value"
          class="seg-item"
          :class="{ active: appStore.fontWeight === fw.value }"
          role="tab"
          :aria-selected="appStore.fontWeight === fw.value"
          @click="appStore.setFontWeight(fw.value)"
        >
          <span class="seg-icon" aria-hidden="true" :style="{ fontWeight: fw.weight }">Aa</span>
          {{ fw.label }}
        </button>
      </div>
    </div>

    <!-- 字体预览 -->
    <div class="fw-preview">
      <span class="fw-preview-text" :style="{ fontWeight: fwPreviewWeight }">
        螺丝钉智能体 —— 当前字体粗细预览
      </span>
      <span class="fw-preview-value">{{ fwPreviewWeight }}</span>
    </div>

    <div class="theme-preview" aria-hidden="true">
      <div class="tp-pane" :class="appStore.resolvedTheme">
        <div class="tp-topbar">
          <span class="tp-dot red"></span>
          <span class="tp-dot yellow"></span>
          <span class="tp-dot green"></span>
          <span class="tp-title">工作台预览</span>
        </div>
        <div class="tp-body">
          <div class="tp-side"></div>
          <div class="tp-main">
            <div class="tp-line primary"></div>
            <div class="tp-line short"></div>
            <div class="tp-line"></div>
            <div class="tp-btn">示例按钮</div>
          </div>
        </div>
      </div>
      <div class="tp-meta">
        <div class="tp-meta-row">
          <span class="tp-swatch swatch-bg"></span>
          <span class="tp-label">背景</span>
          <span class="tp-value">
            {{ appStore.resolvedTheme === 'dark' ? 'slate-950 (#0b0c10)' : 'white (#ffffff)' }}
          </span>
        </div>
        <div class="tp-meta-row">
          <span class="tp-swatch swatch-primary"></span>
          <span class="tp-label">主色</span>
          <span class="tp-value">
            indigo {{ appStore.resolvedTheme === 'dark' ? '400 #818cf8' : '500 #6366f1' }}
          </span>
        </div>
        <div class="tp-meta-row">
          <span class="tp-swatch swatch-border"></span>
          <span class="tp-label">分割线</span>
          <span class="tp-value">
            {{ appStore.resolvedTheme === 'dark' ? 'slate-700' : 'slate-200' }}
          </span>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
/* ═══════════════════════════════════════════════════════════
   外观主题卡：预览小窗 + 色板说明（原 Settings.vue L1375-1476 迁出）
   ═══════════════════════════════════════════════════════════ */
.theme-card .theme-preview {
  display: grid;
  grid-template-columns: 1.25fr 1fr;
  gap: var(--space-4);
  padding-top: var(--space-2);
}
.theme-card .tp-pane {
  width: 100%; aspect-ratio: 16 / 10;
  border-radius: var(--radius-lg);
  overflow: hidden;
  border: 1px solid var(--border-subtle);
  box-shadow: var(--shadow-card);
  transition: background var(--duration-normal), color var(--duration-normal),
              border-color var(--duration-normal);
}
.theme-card .tp-pane.light {
  background: #ffffff; color: var(--luosiding-slate-900);
  border-color: var(--luosiding-slate-200);
}
.theme-card .tp-pane.dark {
  background: #0b0c10; color: var(--luosiding-slate-50);
  border-color: var(--luosiding-slate-700);
}
.theme-card .tp-topbar {
  height: 26px; padding: 0 10px;
  display: flex; align-items: center; gap: 6px;
  border-bottom: 1px solid var(--border-subtle);
  font-size: 11px; font-weight: 600;
}
.theme-card .tp-pane.light .tp-topbar { background: #f5f6fa; color: #54576a; border-color: #e5e7ec; }
.theme-card .tp-pane.dark  .tp-topbar { background: #121425; color: #9ea1b2; border-color: #1d2138; }

.theme-card .tp-dot {
  width: 9px; height: 9px; border-radius: 50%;
  box-shadow: inset 0 0 0 0.5px rgba(0,0,0,0.15);
}
.theme-card .tp-dot.red    { background: #ff6159; }
.theme-card .tp-dot.yellow { background: #ffbd2e; }
.theme-card .tp-dot.green  { background: #28c940; }
.theme-card .tp-title { margin-left: 8px; }

.theme-card .tp-body {
  display: grid; grid-template-columns: 84px 1fr;
  height: calc(100% - 26px);
}
.theme-card .tp-side {
  border-right: 1px solid var(--border-subtle);
}
.theme-card .tp-pane.light .tp-side { background: #f5f6fa; border-color: #e5e7ec; }
.theme-card .tp-pane.dark  .tp-side { background: #121425; border-color: #1d2138; }

.theme-card .tp-main {
  padding: 14px 16px; display: flex; flex-direction: column; gap: 9px;
}
.theme-card .tp-line {
  height: 7px; border-radius: 999px;
  background: var(--muted);
}
.theme-card .tp-line.primary { height: 9px; background: var(--primary); width: 42%; opacity: 0.85; }
.theme-card .tp-line.short   { width: 68%; opacity: 0.85; }
.theme-card .tp-btn {
  margin-top: auto;
  align-self: flex-start;
  padding: 6px 14px; border-radius: 999px;
  background: var(--primary); color: #fff;
  font-size: 12px; font-weight: 600;
  box-shadow: 0 1px 2px rgba(99,102,241,0.25);
}
.theme-card .tp-pane.light .tp-line { background: var(--luosiding-slate-200); }
.theme-card .tp-pane.dark  .tp-line { background: var(--luosiding-slate-700); }

.theme-card .tp-meta {
  display: flex; flex-direction: column; gap: var(--space-3);
  padding-top: 4px;
}
.theme-card .tp-meta-row {
  display: grid;
  grid-template-columns: 22px 54px 1fr;
  gap: var(--space-2);
  align-items: center;
  font-size: 13px;
}
.theme-card .tp-swatch {
  width: 20px; height: 20px; border-radius: 6px;
  border: 1px solid var(--border-subtle);
  box-shadow: inset 0 0 0 0.5px rgba(255,255,255,0.4);
}
.theme-card .tp-swatch.swatch-bg      { background: var(--background); }
.theme-card .tp-swatch.swatch-primary { background: var(--primary); }
.theme-card .tp-swatch.swatch-border  { background: var(--border); }

.theme-card .tp-label { color: var(--muted-foreground); font-size: 12px; }
.theme-card .tp-value { color: var(--foreground); font-variant-numeric: tabular-nums; }

/* 字体粗细预览行 */
.fw-preview {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: var(--space-3);
  padding: var(--space-2) var(--space-3);
  background: var(--color-surface-container-low);
  border-radius: var(--radius-md);
  border: 1px solid var(--border-subtle);
}
.fw-preview-text {
  font-size: var(--font-size-lead);
  color: var(--foreground);
  transition: font-weight 0.15s ease;
}
.fw-preview-value {
  font-size: var(--font-size-caption);
  color: var(--muted-foreground);
  font-variant-numeric: tabular-nums;
}

/* 主题卡响应式 */
@media (max-width: 900px) {
  .theme-card .theme-preview { grid-template-columns: 1fr; }
}
@media (max-width: 560px) {
  .theme-card .tp-body { grid-template-columns: 68px 1fr; }
  .theme-card .tp-main { padding: 10px 12px; }
}
</style>
