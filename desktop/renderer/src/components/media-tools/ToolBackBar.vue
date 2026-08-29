<script setup lang="ts">
// ═══════════════════════════════════════════════════════════════
// ToolBackBar.vue — 媒体工具独立路由页统一返回栏（纯展示 + 事件转发，IRON-06）
// 样式对齐 MediaTools.vue 的 .tool-bar / .back-btn / .tool-bar-title，
// 保证「智能混剪 / 直播切片」等独立路由页与内嵌工具页界面统一：
// 左上角固定「← 返回媒体工具」。
// ═══════════════════════════════════════════════════════════════
import { useRouter } from 'vue-router'

defineProps<{
  /** 页面标题（emoji + 名称），如「✂️ 智能混剪」 */
  emoji?: string
  title: string
  /** 分组徽标（如「创作」），不传不显示 */
  group?: string
}>()

const router = useRouter()

function backToMediaTools(): void {
  router.push('/media-tools')
}
</script>

<template>
  <div class="tool-back-bar">
    <button class="back-btn" type="button" @click="backToMediaTools">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <path d="M19 12H5" />
        <path d="M12 19l-7-7 7-7" />
      </svg>
      返回媒体工具
    </button>
    <h1 class="bar-title">
      <span v-if="emoji" class="bar-emoji">{{ emoji }}</span>
      {{ title }}
      <span v-if="group" class="bar-group">{{ group }}</span>
    </h1>
  </div>
</template>

<style scoped>
.tool-back-bar {
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
.bar-title {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin: 0;
  font-size: 20px;
  font-weight: 700;
  color: var(--foreground);
}
.bar-emoji { font-size: 22px; line-height: 1; }
.bar-group {
  font-size: 11px;
  font-weight: 600;
  color: var(--muted-foreground);
  background: var(--surface-container);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 2px 10px;
}
</style>
