<script lang="ts">
/** 左侧设置菜单项结构 */
export interface SettingsMenuItem {
  id: string
  label: string
  icon: string // SVG inner path
  desc?: string
}
</script>

<script setup lang="ts">
// ═══════════════════════════════════════════════════════════════
// SettingsSidebar — 设置页左侧菜单（展示组件）
// 模板与样式自 Settings.vue L259-338 / L868-990 原样迁出（IRON-08）
// ═══════════════════════════════════════════════════════════════

defineProps<{
  items: SettingsMenuItem[]
  activeMenu: string
}>()

const emit = defineEmits<{
  (e: 'select', id: string): void
  (e: 'back'): void
}>()
</script>

<template>
  <aside class="settings-sidebar">
    <!-- 侧栏页头（对齐设计稿 settings：设置 + 副标题） -->
    <div class="side-head">
      <h1 class="side-title">设置</h1>
      <p class="side-sub">管理账号、模型与系统偏好</p>
    </div>
    <nav class="menu-list custom-scroll">
      <div
        v-for="m in items"
        :key="m.id"
        class="menu-item"
        :class="{ active: activeMenu === m.id }"
        @click="emit('select', m.id)"
      >
        <div class="menu-ic">
          <!-- 图标集合 -->
          <svg v-if="m.icon === 'platform'" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <circle cx="12" cy="12" r="10" />
            <path d="M2 12h20" />
            <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
          </svg>
          <svg v-else-if="m.icon === 'local'" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
            <polyline points="13 2 13 9 20 9" />
          </svg>
          <svg v-else-if="m.icon === 'env'" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M12 2v4" />
            <path d="M12 18v4" />
            <path d="m4.93 4.93 2.83 2.83" />
            <path d="m16.24 16.24 2.83 2.83" />
            <path d="M2 12h4" />
            <path d="M18 12h4" />
            <path d="m4.93 19.07 2.83-2.83" />
            <path d="m16.24 7.76 2.83-2.83" />
            <circle cx="12" cy="12" r="4" />
          </svg>
          <svg v-else-if="m.icon === 'theme'" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z" />
          </svg>
          <svg v-else-if="m.icon === 'inference'" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <rect x="4" y="4" width="16" height="16" rx="2" />
            <rect x="9" y="9" width="6" height="6" />
            <line x1="9" y1="2" x2="9" y2="4" />
            <line x1="15" y1="2" x2="15" y2="4" />
            <line x1="9" y1="20" x2="9" y2="22" />
            <line x1="15" y1="20" x2="15" y2="22" />
            <line x1="2" y1="9" x2="4" y2="9" />
            <line x1="2" y1="15" x2="4" y2="15" />
            <line x1="20" y1="9" x2="22" y2="9" />
            <line x1="20" y1="15" x2="22" y2="15" />
          </svg>
          <svg v-else width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="16" x2="12" y2="12" />
            <line x1="12" y1="8" x2="12.01" y2="8" />
          </svg>
        </div>
        <div class="menu-text">
          <div class="menu-label">{{ m.label }}</div>
          <div v-if="m.desc" class="menu-desc">{{ m.desc }}</div>
        </div>
      </div>
    </nav>

    <div class="sidebar-foot">
      <button class="back-btn" @click="emit('back')">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M19 12H5" />
          <path d="M12 19l-7-7 7-7" />
        </svg>
        返回工作台
      </button>
    </div>
  </aside>
</template>

<style scoped>
.settings-sidebar {
  flex: 0 0 240px;
  width: 240px;
  background: var(--surface);
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
}

/* ─── 侧栏页头（设计稿对齐） ─── */
.side-head {
  padding: var(--space-4) var(--space-4) var(--space-2);
}
.side-title {
  margin: 0;
  font-size: var(--font-size-h3);
  font-weight: 700;
  line-height: 1.2;
  color: var(--foreground);
}
.side-sub {
  margin: 4px 0 0;
  font-size: var(--font-size-caption);
  color: var(--muted-foreground);
}

.menu-list {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: var(--space-2) var(--space-3) var(--space-4);
}

.menu-item {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  padding: 10px 12px;
  margin-bottom: 2px;
  border-radius: var(--radius-lg);
  cursor: pointer;
  transition: all var(--duration-fast);
}

.menu-ic {
  flex: 0 0 auto;
  width: 32px;
  height: 32px;
  border-radius: 10px;
  background: var(--surface-container);
  color: var(--muted-foreground);
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all var(--duration-fast);
}

.menu-text {
  flex: 1 1 auto;
  min-width: 0;
}

.menu-label {
  font-size: 13px;
  font-weight: 600;
  color: var(--foreground);
  line-height: 1.3;
}

.menu-desc {
  margin-top: 2px;
  font-size: 11px;
  color: var(--muted-foreground);
  line-height: 1.3;
}

.menu-item:hover {
  background: var(--surface-container);
}
.menu-item:hover .menu-ic {
  color: var(--primary);
}

.menu-item.active {
  background: var(--primary);
}
.menu-item.active .menu-label,
.menu-item.active .menu-desc {
  color: var(--primary-foreground);
}
.menu-item.active .menu-ic {
  background: rgba(255, 255, 255, 0.15);
  color: var(--primary-foreground);
}

.sidebar-foot {
  padding: var(--space-4);
  border-top: 1px solid var(--border);
}

.back-btn {
  width: 100%;
  height: 40px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  color: var(--foreground);
  font-size: var(--font-size-body);
  font-weight: 500;
  transition: all var(--duration-fast);
}

.back-btn:hover {
  background: var(--surface-container-high);
  border-color: var(--primary);
  color: var(--primary);
}

.custom-scroll::-webkit-scrollbar { width: 6px; height: 6px; }
.custom-scroll::-webkit-scrollbar-thumb { background: var(--surface-container-high); border-radius: 3px; }

/* 窄屏抽屉态 */
@media (max-width: 900px) {
  .settings-sidebar {
    position: absolute;
    z-index: 50;
    height: 100%;
    transform: translateX(-100%);
    transition: transform var(--duration-normal) var(--easing-default);
    box-shadow: var(--shadow-3);
  }
  .settings-sidebar.open { transform: translateX(0); }
}
</style>
