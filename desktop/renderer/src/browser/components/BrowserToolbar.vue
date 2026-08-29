<script setup lang="ts">
// BrowserToolbar — 浏览器页顶部工具栏展示组件
// 模板与样式来源：views/Browser.vue 原 template L1306-1435 +
// style .browser-toolbar/.nav-ic-group/.ic-btn/.ext-*/.menu-btn/.badge-dot/
// .address-*/.right-actions/.hist-* 区段（类名/结构/事件语义不变）
// 事件映射：汉堡→toggle-left-drawer；后退/前进/刷新→back/forward/reload；
// 地址栏输入→update:address，回车→url-enter；扩展图标与扩展按钮→open-ext-panel；
// 历史按钮→open-history-panel；设置→open-settings
import type { InstalledExtension } from '../composables/useBrowserDownloads'
import { loginStateText } from '../composables/useBrowserLogin'
import type { LoginState } from '../composables/useBrowserLogin'

const props = defineProps<{
  /** <900px 汉堡抽屉展开态（控制 menu-btn active） */
  leftDrawerOpen: boolean
  /** 导航可用性 { back, forward } */
  navCan: { back: boolean; forward: boolean }
  /** 是否 Electron 壳模式 */
  isElectronShell: boolean
  /** 地址栏值（v-model:address） */
  address: string
  /** 地址栏是否可编辑（仅网页浏览器模式） */
  addressEditable: boolean
  /** 已安装扩展列表（工具栏仅渲染用户扩展图标） */
  extensions: InstalledExtension[]
  /** 扩展图标 file:// 地址解析（downloads 域 extIconSrc） */
  iconSrc: (e: InstalledExtension) => string
  /** 历史条数（>0 显示红点） */
  historyCount: number
  /** 进行中下载任务数（⬇按钮角标） */
  activeDownloadCount: number
  /** 激活平台登录态（条目⑧徽章；null=无规则平台/非平台模式 → 不渲染） */
  loginState: LoginState | null
}>()

const emit = defineEmits<{
  (e: 'toggle-left-drawer'): void
  (e: 'back'): void
  (e: 'forward'): void
  (e: 'reload'): void
  (e: 'update:address', v: string): void
  (e: 'url-enter'): void
  (e: 'open-ext-panel'): void
  (e: 'open-history-panel'): void
  (e: 'open-downloads-panel'): void
  (e: 'open-settings'): void
  /** 点击登录徽章：重检当前平台（条目⑧） */
  (e: 'refresh-login'): void
}>()

function onAddressInput(e: Event): void {
  emit('update:address', (e.target as HTMLInputElement).value)
}

/** 供模板 v-for 使用（原模板内联 filter 表达式等价搬移） */
function userExtensions(): InstalledExtension[] {
  return props.extensions.filter(e => !e.builtin)
}
</script>

<template>
  <header class="browser-toolbar">
    <div class="nav-ic-group">
      <!-- 汉堡按钮：<900px 唤出左栏抽屉 -->
      <button
        class="ic-btn menu-btn"
        :class="{ active: leftDrawerOpen }"
        title="快速标签与历史记录"
        aria-label="打开侧栏"
        @click="$emit('toggle-left-drawer')"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <line x1="3" y1="6" x2="21" y2="6" stroke-linecap="round" />
          <line x1="3" y1="12" x2="21" y2="12" stroke-linecap="round" />
          <line x1="3" y1="18" x2="21" y2="18" stroke-linecap="round" />
        </svg>
      </button>
      <button
        class="ic-btn"
        :class="{ disabled: !navCan.back || !isElectronShell }"
        title="后退"
        @click="$emit('back')"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="m15 18-6-6 6-6" />
        </svg>
      </button>
      <button
        class="ic-btn"
        :class="{ disabled: !navCan.forward || !isElectronShell }"
        title="前进"
        @click="$emit('forward')"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="m9 18 6-6-6-6" />
        </svg>
      </button>
      <button
        class="ic-btn"
        :class="{ disabled: !isElectronShell }"
        title="刷新"
        @click="$emit('reload')"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
          <path d="M3 21v-5h5" />
          <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
          <path d="M21 3v5h-5" />
        </svg>
      </button>
    </div>

    <div class="address-bar" :class="{ locked: !addressEditable }">
      <span class="lock-ic" :title="addressEditable ? '可编辑' : '平台固定地址'">
        <svg v-if="addressEditable" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
        </svg>
        <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
          <path d="M7 11V7a5 5 0 0 1 10 0v4" />
        </svg>
      </span>
      <input
        :value="address"
        type="text"
        class="address-input"
        :class="{ locked: !addressEditable }"
        :readonly="!addressEditable"
        :placeholder="addressEditable ? '输入网址或搜索' : '平台固定地址'"
        @input="onAddressInput"
        @keydown.enter="$emit('url-enter')"
      />
    </div>

    <div class="right-actions">
      <!-- 登录状态徽章（条目⑧ B11：对照原 renderLoginStatusBadges；
           仅平台模式显示，点击重检；检测失败不阻塞浏览） -->
      <button
        v-if="props.loginState"
        class="login-pill"
        :class="props.loginState"
        :title="`登录状态：${loginStateText(props.loginState)}（点击重新检测）`"
        aria-label="登录状态"
        @click="$emit('refresh-login')"
      >
        <span class="login-pill-dot"></span>
        {{ loginStateText(props.loginState) }}
      </button>
      <div
        v-for="ext in userExtensions()"
        :key="ext.id"
        class="hist-wrapper"
      >
        <button
          class="ic-btn ext-ic"
          :title="ext.name"
          :aria-label="ext.name"
          @click="$emit('open-ext-panel')"
        >
          <img v-if="iconSrc(ext)" :src="iconSrc(ext)" class="ext-img" alt="" />
          <svg v-else width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
            <path d="M7 11V7a5 5 0 0 1 10 0v4" />
          </svg>
        </button>
      </div>
      <div class="hist-wrapper">
        <button
          class="ic-btn"
          title="扩展"
          aria-label="扩展"
          @click="$emit('open-ext-panel')"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M20.5 13h-1a2.5 2.5 0 0 1 0-5h1a2.5 2.5 0 0 0 0-5h-1" />
            <path d="M3.5 3h4a2.5 2.5 0 0 1 0 5h-4" />
            <path d="M3.5 13h1a2.5 2.5 0 0 1 0 5h-1a2.5 2.5 0 0 1 0-5z" />
            <path d="M3.5 21h2.5a2.5 2.5 0 0 0 0-5" />
            <path d="M21 21v-2.5a2.5 2.5 0 0 0-5 0V21" />
          </svg>
        </button>
      </div>
      <div class="hist-wrapper">
        <button
          class="ic-btn"
          title="历史记录"
          aria-label="历史记录"
          @click="$emit('open-history-panel')"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M3 3v5h5" />
            <path d="M3.05 13A9 9 0 1 0 6 5.3L3 8" />
            <path d="M12 7v5l4 2" />
          </svg>
          <span v-if="historyCount > 0" class="badge-dot" />
        </button>
      </div>
      <div class="hist-wrapper">
        <button
          class="ic-btn dl-btn"
          title="下载管理"
          aria-label="下载管理"
          @click="$emit('open-downloads-panel')"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
          <span v-if="activeDownloadCount > 0" class="dl-badge">{{ activeDownloadCount > 99 ? '99+' : activeDownloadCount }}</span>
        </button>
      </div>
      <button class="ic-btn" title="设置" aria-label="设置" @click="$emit('open-settings')">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      </button>
    </div>
  </header>
</template>

<style scoped>
/* ─── 顶部工具条 ─── */
.browser-toolbar {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  background: var(--surface);
  border-bottom: 1px solid var(--border);
  z-index: 30;
}

.nav-ic-group {
  display: flex;
  align-items: center;
  gap: 2px;
}

.ic-btn {
  position: relative;
  width: 36px;
  height: 36px;
  border-radius: var(--radius-md);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--muted-foreground);
  transition: all var(--duration-fast);
}

.ic-btn:hover:not(.disabled) {
  background: var(--surface-container-high);
  color: var(--foreground);
}

/* ── 工具栏扩展图标（已装用户扩展） ── */
.ext-ic { overflow: hidden; }
.ext-ic .ext-img {
  width: 18px;
  height: 18px;
  object-fit: contain;
  border-radius: 3px;
  display: block;
}

.ic-btn.active {
  background: var(--surface-container);
  color: var(--foreground);
}

.ic-btn.disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

/* 汉堡按钮：默认隐藏，<900px 显示 */
.menu-btn { display: none; }

.badge-dot {
  position: absolute;
  top: 8px;
  right: 8px;
  width: 7px;
  height: 7px;
  border-radius: 999px;
  background: var(--error);
  box-shadow: 0 0 0 2px var(--surface);
}

/* ── ⬇ 下载管理按钮角标（进行中任务数） ── */
.dl-badge {
  position: absolute;
  top: 3px;
  right: 1px;
  min-width: 14px;
  height: 14px;
  padding: 0 3px;
  border-radius: 999px;
  background: var(--primary);
  color: var(--primary-foreground);
  font-size: 9px;
  font-weight: 600;
  line-height: 14px;
  text-align: center;
  box-shadow: 0 0 0 2px var(--surface);
}

.address-bar {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 0 var(--space-3);
  height: 40px;
  background: var(--surface-container);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  transition: all var(--duration-fast);
}

.address-bar:focus-within {
  border-color: var(--primary);
  box-shadow: 0 0 0 3px var(--ring);
  background: var(--card);
}

.lock-ic {
  color: var(--success);
  display: inline-flex;
  flex: 0 0 auto;
}

.address-bar.locked .lock-ic {
  color: var(--muted-foreground);
}

.address-input {
  flex: 1 1 auto;
  min-width: 0;
  background: transparent;
  border: none;
  outline: none;
  color: var(--foreground);
  font-size: var(--font-size-body);
}

.address-input.locked {
  color: var(--muted-foreground);
  cursor: default;
}

.address-input.locked::selection {
  background: transparent;
}

.right-actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

/* ── 登录状态徽章（条目⑧；对照原徽章绿=已登录/红=未登录 + 检测中态） ── */
.login-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
  line-height: 1;
  white-space: nowrap;
  border: 1px solid var(--border);
  background: var(--surface-container);
  color: var(--muted-foreground);
  cursor: pointer;
  font-family: inherit;
  transition: all var(--duration-fast);
}
.login-pill:hover { border-color: var(--primary); color: var(--foreground); }
.login-pill-dot {
  width: 7px;
  height: 7px;
  border-radius: 999px;
  flex: 0 0 auto;
  background: var(--muted-foreground);
}
.login-pill.logged_in {
  background: rgba(16, 185, 129, 0.10);
  border-color: rgba(16, 185, 129, 0.30);
  color: var(--success);
}
.login-pill.logged_in .login-pill-dot { background: var(--success); }
.login-pill.logged_out {
  background: rgba(239, 68, 68, 0.06);
  border-color: rgba(239, 68, 68, 0.22);
  color: var(--error);
}
.login-pill.logged_out .login-pill-dot { background: var(--error); }
.login-pill.checking .login-pill-dot {
  background: conic-gradient(from 0deg, var(--primary) 0%, transparent 60%);
  animation: login-pill-spin 1.1s linear infinite;
}
@keyframes login-pill-spin { from { transform: rotate(0) } to { transform: rotate(360deg) } }
@media (prefers-reduced-motion: reduce) {
  .login-pill.checking .login-pill-dot { animation: none; }
}

/* ═══ Phase 3: 历史记录弹出面板 ═══ */
.hist-wrapper {
  position: relative;
  display: inline-flex;
}

.hist-popover {
  position: absolute;
  top: calc(100% + 8px);
  right: 0;
  width: 360px;
  max-height: 480px;
  background: var(--popover, var(--surface));
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-lg, 0 12px 32px rgba(0,0,0,0.18));
  z-index: 9999;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  animation: hist-fade-in 0.15s ease-out;
}

@keyframes hist-fade-in {
  from { opacity: 0; transform: translateY(-4px); }
  to { opacity: 1; transform: translateY(0); }
}

.hist-popover-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border);
  font-size: 13px;
  font-weight: 600;
  color: var(--foreground);
  background: var(--surface-container);
}

.hist-clear-btn {
  background: transparent;
  border: none;
  color: var(--muted-foreground);
  font-size: 11px;
  cursor: pointer;
  padding: 2px 8px;
  border-radius: var(--radius-md);
  transition: all var(--duration-fast);
}

.hist-clear-btn:hover {
  color: var(--destructive, #ef4444);
  background: var(--surface-container-high);
}

.hist-list {
  flex: 1 1 auto;
  overflow-y: auto;
  padding: 4px;
}

.hist-item {
  padding: 8px 10px;
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: background var(--duration-fast);
}

.hist-item:hover {
  background: var(--surface-container);
}

.hist-item-title {
  font-size: 13px;
  font-weight: 500;
  color: var(--foreground);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  line-height: 1.3;
}

.hist-item-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 4px;
  font-size: 11px;
  color: var(--muted-foreground);
}

.hist-item-time {
  flex-shrink: 0;
  padding: 1px 6px;
  background: var(--surface-container);
  border-radius: var(--radius-full);
  font-variant-numeric: tabular-nums;
}

.hist-item-url {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1 1 auto;
}

.hist-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 32px 16px;
  color: var(--muted-foreground);
  font-size: 13px;
}

.hist-popover::-webkit-scrollbar { width: 6px; }
.hist-popover::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }

@media (max-width: 899px) {
  .menu-btn { display: inline-flex; }

  /* 地址栏在极窄屏隐藏（历史记录/快速标签承担导航） */
  .address-bar { display: none; }
}
</style>
