<template>
  <div class="step-bar">
    <template v-for="(s, i) in STEPS" :key="s">
      <div class="step-pill" :class="{ active: step === i, done: step > i, disabled: i > step }" @click="i <= step && $emit('go', i)">
        <span class="step-dot" v-if="step > i">✓</span>{{ s }}
      </div>
      <span v-if="i < STEPS.length - 1" class="step-arrow">›</span>
    </template>
  </div>
</template>

<script setup lang="ts">
/**
 * 智能混剪步骤条（2026-09-10 用户裁决：四个 tab 步骤统一放操作区/卡片内，
 * 不再全宽顶置横跨预览区上方；门控保留：仅允许跳转到已完成或当前步骤）。
 */
defineProps<{ step: number }>()
defineEmits<{ (e: 'go', i: number): void }>()

// 步骤条文案对照原客户端 gui/video_montage_page.py steps_text L257，严格一致
const STEPS = ['1. 镜头智能分割', '2. 镜头重组', '3. 口播配音', '4. 特效包装']
</script>

<style scoped>
.step-bar { display: flex; align-items: center; gap: var(--space-2); padding: 6px 12px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-lg); }
.step-pill { flex: 1; padding: 4px 0; border-radius: var(--radius-sm); font-size: 13px; color: var(--muted-foreground); cursor: pointer; text-align: center; transition: background var(--duration-fast), color var(--duration-fast); }
.step-pill.disabled { cursor: not-allowed; opacity: .5; }
.step-pill.active { background: rgba(96, 165, 250, 0.12); color: var(--info, #60a5fa); font-weight: 700; padding: 4px 8px; }
.step-pill.done { background: rgba(52, 211, 153, 0.1); color: var(--success); padding: 4px 8px; }
.step-dot { margin-right: 4px; font-weight: 700; }
.step-arrow { color: rgba(255, 255, 255, 0.2); font-weight: bold; }
</style>
