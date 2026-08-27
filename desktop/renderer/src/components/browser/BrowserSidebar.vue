<script setup lang="ts">
// BrowserSidebar — 浏览器页左栏（模式切换 + 平台网格）展示组件
// 模板与样式来源：views/Browser.vue 原 template L1440-1455 +
// style .browser-sidebar/.mode-*/.platform-*/.tag-* 区段（类名/结构不变）
import type { SidebarItem } from '../../composables/useBrowserNav'

defineProps<{
  /** 统一导航项（nav 域 sidebarItems 计算属性结果） */
  sidebarItems: SidebarItem[]
  /** <900px 抽屉展开态 */
  leftDrawerOpen?: boolean
}>()

defineEmits<{
  (e: 'select-item', item: SidebarItem): void
}>()
</script>

<template>
  <aside class="browser-sidebar" :class="{ open: leftDrawerOpen }">
    <div class="side-scroll custom-scroll">
      <div class="platform-grid">
        <button
          v-for="item in sidebarItems"
          :key="item.id"
          class="platform-btn"
          :class="{ active: !!item.active }"
          @click="$emit('select-item', item)"
        >
          <span class="platform-badge" :class="item.id">{{ item.badge }}</span>
          <span class="platform-name">{{ item.name }}</span>
        </button>
      </div>
    </div>
  </aside>
</template>

<style scoped>
/* ─── 左栏：模式切换 + 平台网格 ─── */
.browser-sidebar {
  flex: 0 0 168px;
  width: 168px;
  background: var(--surface);
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
}

/* ─── 通用侧栏块 ─── */
.side-scroll {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 12px 10px;
}

.custom-scroll::-webkit-scrollbar { width: 6px; height: 6px; }
.custom-scroll::-webkit-scrollbar-thumb { background: var(--surface-container-high); border-radius: 3px; }

/* 模式切换按钮 */
.mode-buttons {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.mode-btn {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border-radius: var(--radius-md);
  background: var(--surface-container);
  border: 1px solid var(--border);
  color: var(--foreground);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: all var(--duration-fast);
  text-align: left;
  font-family: inherit;
}

.mode-btn:hover {
  background: rgba(99, 102, 241, 0.08);
  border-color: var(--primary);
  color: var(--primary);
}

.mode-btn.active {
  background: var(--luosiding-indigo-50, #e0e7ff);
  border-color: var(--primary);
  color: var(--primary);
}

.mode-icon {
  font-size: 14px;
  line-height: 1;
}

:root.dark .mode-btn.active,
.dark .mode-btn.active {
  background: rgba(99, 102, 241, 0.16);
}

/* 平台网格 */
.platform-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 8px;
}

.platform-btn {
  display: flex;
  align-items: center;
  gap: 10px;
  background: var(--surface-container);
  border: 1px solid var(--border);
  padding: 8px 12px;
  border-radius: var(--radius-md);
  color: var(--foreground);
  cursor: pointer;
  font-family: inherit;
  font-size: 13px;
  font-weight: 500;
  transition: all var(--duration-fast);
  text-align: left;
}

.platform-btn:hover {
  background: rgba(99, 102, 241, 0.08);
  border-color: var(--primary);
  color: var(--primary);
}

.platform-btn.active {
  background: var(--luosiding-indigo-50, #e0e7ff);
  border-color: var(--primary);
  color: var(--primary);
}

.platform-badge {
  width: 22px;
  height: 22px;
  border-radius: 6px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  font-weight: 700;
  color: #fff;
  flex-shrink: 0;
}

.platform-badge.douyin      { background: #FE2C55; }
.platform-badge.bilibili    { background: #00AEEC; }
.platform-badge.kuaishou    { background: #FF6600; }
.platform-badge.xiaohongshu { background: #FF2442; }
.platform-badge.weixin      { background: #07C160; }
.platform-badge.youtube     { background: #FF0000; }
.platform-badge.jimeng      { background: #7C3AED; }

:root.dark .platform-btn.active,
.dark .platform-btn.active {
  background: rgba(99, 102, 241, 0.16);
}

/* 历史记录条目 */
.tag-item {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 10px 12px;
  border-radius: var(--radius-lg);
  cursor: pointer;
  color: var(--muted-foreground);
  transition: all var(--duration-fast);
  margin-bottom: 2px;
}

.tag-item:hover {
  background: var(--surface-container);
  color: var(--foreground);
}

.tag-ic {
  width: 18px;
  height: 18px;
  flex: 0 0 auto;
}

.tag-text {
  flex: 1 1 auto;
  min-width: 0;
}

.tag-title {
  font-size: 12px;
  font-weight: 500;
  color: var(--foreground);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.tag-url {
  margin-top: 1px;
  font-size: 11px;
  color: var(--muted-foreground);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.tag-time {
  flex: 0 0 auto;
  font-size: 11px;
  color: var(--muted-foreground);
}

@media (max-width: 899px) {
  .browser-sidebar {
    position: absolute;
    top: 0;
    left: 0;
    bottom: 0;
    z-index: 50;
    width: 260px;
    transform: translateX(-100%);
    transition: transform var(--duration-normal) var(--easing-default);
    box-shadow: var(--shadow-3);
  }
  .browser-sidebar.open {
    transform: translateX(0);
  }
}

@media (prefers-reduced-motion: reduce) {
  .browser-sidebar {
    transition: none;
  }
}
</style>
