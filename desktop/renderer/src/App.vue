<script setup lang="ts">
// ═══════════════════════════════════════════════════════════════
// App.vue — 根布局（P1.5 厚壳化：自绘标题栏 + C9 门控）
// 结构：.title-bar（36px，Electron 才显示）+ app-header（64px）+
//       app-main（router-view）
// ═══════════════════════════════════════════════════════════════

import { computed, ref, onMounted, onBeforeUnmount, watch } from 'vue'
import { useRoute, useRouter, type RouteLocationRaw } from 'vue-router'
import { useAppStore, type TabKey } from '@/stores/app'
import { useServerStore } from '@/stores/server'

import type { TintinBridgeWinState } from '../../../../types/global'

const appStore = useAppStore()
const serverStore = useServerStore()
const route = useRoute()
const router = useRouter()

// ── C9 门控：判断是否在 Electron 壳内（window.tintin.win 存在 = 自绘标题栏）
//    浏览器模式（纯 Vite 预览）→ 隐藏 title-bar，保留系统标题栏
const isElectronShell = ref(false)
function _detectShell(): void {
  const t = (window as any).tintin
  isElectronShell.value = !!(t && t.win && typeof t.win.getState === 'function')
}
_detectShell()
// 2 秒兜底：若还未检测到，强制认为不是 shell，不再等待（C9 超时不阻塞渲染）
const _c9Timer = setTimeout(() => { isElectronShell.value = false }, 2000)

// Tab 配置：标识 + 显示名 + 路由
const tabs: Array<{ key: TabKey; label: string; to: RouteLocationRaw }> = [
  { key: 'workbench', label: '工作台', to: '/workbench' },
  { key: 'browser', label: '浏览器', to: '/browser' },
  { key: 'media-tools', label: '媒体工具', to: '/media-tools' }
]

// 当前激活 Tab：优先取路由 meta.tab，设置页保持工作台 tab 高亮，回退到 appStore
const currentTab = computed<TabKey>(() => {
  const t = route.meta.tab as TabKey | undefined
  if (t === 'settings') return 'workbench'
  return t || appStore.activeTab
})

// 服务端状态徽章颜色与文案
const statusMeta = computed(() => {
  switch (serverStore.status) {
    case 'online':
      return { color: 'var(--success)', text: '服务端正常' }
    case 'offline':
      return { color: 'var(--error)', text: '服务端离线' }
    default:
      return { color: 'var(--warning)', text: '检测中…' }
  }
})

// 系统资源占位（V3 暂用静态展示，后续接入 systeminformation 桥接）
const systemStats = ref({ cpu: 12, mem: 34, gpu: 8 })

/** 点击 Tab：同步 store 并跳转 + C6 切 Tab 防泄露（切非 browser Tab 先 detachAll） */
async function switchTab(tab: TabKey, to: RouteLocationRaw): Promise<void> {
  try {
    const t = (window as any).tintin
    if (tab !== 'browser' && t?.browser?.detachAll) {
      // C6：切工作台/设置/媒体工具 Tab 前必须 detach BrowserView
      // 禁止原生层级盖到其他 Tab 的 DOM 上
      await t.browser.detachAll()
    }
  } catch (_) { /* detachAll 失败不影响路由跳转 */ }
  appStore.setActiveTab(tab)
  router.push(to)
}

// ══════════════════════════════════════════════════════════════
// P1.5 自绘标题栏：窗口状态 + 三控件（最小化/最大化/关闭）
// ══════════════════════════════════════════════════════════════
const winState = ref<TintinBridgeWinState | null>(null)
let _unsubWinState: (() => void) | null = null

/** 调用最小化 */
async function onWinMinimize(): Promise<void> {
  try { await (window as any).tintin?.win?.minimize() } catch (_) {}
}
/** 调用切换最大化 */
async function onWinToggleMax(): Promise<void> {
  try {
    const r = await (window as any).tintin?.win?.toggleMaximize()
    if (r?.success && r?.data) winState.value = r.data
  } catch (_) {}
}
/** 调用关闭窗口 */
async function onWinClose(): Promise<void> {
  try { await (window as any).tintin?.win?.close() } catch (_) {}
}
/** 双击标题栏：最大化/还原切换（规格 A1 第 122 条） */
function onTitleBarDblClick(ev: MouseEvent): void {
  // 忽略三控件/Logo 区域双击（避免误触）
  const target = ev.target as HTMLElement | null
  if (target?.closest('.title-bar-controls, .title-bar-logo')) return
  onWinToggleMax()
}

// F4 已废弃：系统标题栏已永久移除，不再支持回退

async function _initTitleBarState(): Promise<void> {
  if (!isElectronShell.value) return
  try {
    clearTimeout(_c9Timer)  // 既然有 shell，取消超时门控
    const t = (window as any).tintin
    // 1) 拉初始状态
    const s = await t.win.getState()
    if (s?.success && s?.data) winState.value = s.data
    // 2) 订阅后续变化：maximize/unmaximize/尺寸明显变化 → dispatch CustomEvent 给 Browser.vue
    let _prev = winState.value
    const _dispatchChanged = () => {
      try {
        const ev = new CustomEvent('app:winstate-changed', {
          bubbles: false, cancelable: false,
          detail: { prev: _prev, current: winState.value },
        })
        window.dispatchEvent(ev)
      } catch (_) {}
    }
    if (typeof t.win.onStateChange === 'function') {
      _unsubWinState = t.win.onStateChange((st: TintinBridgeWinState) => {
        const prev = _prev
        winState.value = st
        // Cherry Studio：触发 Browser 侧重算的条件（任一成立就发事件）：
        //   · maximized 切换（最大化/还原 → padding + window chrome 变化影响 DOMRect）
        //   · 宽或高变化 ≥ 40px（防止 WM 鼠标拖动过程中每 1px 触发一次）
        //   · fullscreen 切换
        //   · focused 从不聚焦 → 聚焦（部分窗口恢复时 BrowserView 会留在旧坐标）
        const maxToggled = !!prev?.maximized !== !!st.maximized
        const fsToggled  = !!prev?.fullscreen  !== !!st.fullscreen
        const focusRegain = !prev?.focused && st.focused
        const sizeDiffW = Math.abs((st?.width ?? 0) - (prev?.width ?? 0))
        const sizeDiffH = Math.abs((st?.height ?? 0) - (prev?.height ?? 0))
        const sizeSig = sizeDiffW >= 40 || sizeDiffH >= 40
        if (maxToggled || fsToggled || focusRegain || sizeSig) {
          _dispatchChanged()
        }
        _prev = st
      })
    }
  } catch (e) {
    console.warn('[title-bar] 初始化窗口状态失败，降级为浏览器壳：', e)
    isElectronShell.value = false
  }
}
// 每次 shell 判定变 true 时，初始化标题栏状态
watch(isElectronShell, (v) => { if (v) _initTitleBarState() }, { immediate: true })

// ══════════════════════════════════════════════════════════════
// P4 hotspot 到点触发订阅：定时任务采集完成后 → bump 信号（Browser.vue
// watch 后热榜导航）+ 切浏览器 Tab。仅 Electron 壳内有此事件。
// ══════════════════════════════════════════════════════════════
let _unsubHotspot: (() => void) | null = null
function _bindHotspotTrigger(): void {
  const t = (window as any).tintin
  if (t?.scheduled?.onScheduledHotspot) {
    _unsubHotspot = t.scheduled.onScheduledHotspot(() => {
      appStore.bumpHotspotNav()
      switchTab('browser', '/browser')
    })
  }
}

onMounted(async () => {
  _bindHotspotTrigger()
  // 注入版本号
  try {
    const v = await window.tintin.app.getVersion()
    appStore.setVersion(v)
  } catch (e) {
    console.warn('[app] 获取版本号失败:', e)
  }
  // 启动服务端能力轮询
  await serverStore.checkCapabilities()
  serverStore.startPolling()
})

onBeforeUnmount(() => {
  clearTimeout(_c9Timer)
  if (_unsubWinState) { try { _unsubWinState() } catch(_){} _unsubWinState = null }
  if (_unsubHotspot) { try { _unsubHotspot() } catch(_){} _unsubHotspot = null }
  serverStore.stopPolling()
})
</script>

<template>
  <div class="app-shell" :class="{ 'electron-shell': isElectronShell }">
    <!-- ═══ P1.5 厚壳化：自绘标题栏（36px，C3/C9）═══ -->
    <!-- 仅 Electron 壳内显示；拖拽区使用 -webkit-app-region: drag；三控件使用 no-drag -->
    <header
      v-if="isElectronShell"
      class="title-bar"
      role="banner"
      @dblclick="onTitleBarDblClick"
    >
      <!-- 左侧：拖拽区 + Logo（C3：app-region: drag） -->
      <div class="title-bar-drag">
        <div class="title-bar-brand">
          <div class="title-bar-logo">钉</div>
          <span class="title-bar-title">螺丝钉-电商智能体矩阵</span>
        </div>
      </div>
    </header>

    <!-- ─── 顶栏（64px）─── -->
    <header class="app-header" @dblclick="onTitleBarDblClick">
      <div class="brand">
        <div class="brand-logo">钉</div>
        <div class="brand-text">
          <span class="brand-name">螺丝钉-电商智能体矩阵</span>
        </div>
      </div>

      <nav class="tab-bar">
        <button
          v-for="tab in tabs"
          :key="tab.key"
          class="luo-tab"
          :class="{ active: currentTab === tab.key }"
          @click="switchTab(tab.key, tab.to)"
        >
          {{ tab.label }}
        </button>
      </nav>

      <div class="header-right">
        <div class="server-status" :title="statusMeta.text">
          <span class="status-dot" :style="{ background: statusMeta.color }"></span>
          <span class="status-text">{{ statusMeta.text }}</span>
        </div>
        <div class="system-stats">
          <span>CPU {{ systemStats.cpu }}%</span>
          <span>内存 {{ systemStats.mem }}%</span>
          <span>GPU {{ systemStats.gpu }}%</span>
        </div>

        <!-- 窗口三控件：最小化 / 最大化 / 关闭 -->
        <div class="title-bar-controls" aria-label="窗口控制">
          <button
            class="wc-btn wc-min"
            type="button"
            title="最小化"
            aria-label="最小化"
            @click="onWinMinimize"
          >
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <rect x="1" y="4.5" width="8" height="1" rx="0.5" fill="currentColor" />
            </svg>
          </button>
          <button
            class="wc-btn wc-max"
            type="button"
            :title="winState?.maximized ? '还原' : '最大化'"
            :aria-label="winState?.maximized ? '还原' : '最大化'"
            @click="onWinToggleMax"
          >
            <svg v-if="!winState?.maximized" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <rect x="1" y="1" width="8" height="8" rx="1" fill="none" stroke="currentColor" stroke-width="1.2" />
            </svg>
            <svg v-else width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <rect x="2.5" y="1" width="6.5" height="6.5" rx="0.8" fill="none" stroke="currentColor" stroke-width="1.2" />
              <rect x="1" y="2.5" width="6.5" height="6.5" rx="0.8" fill="var(--surface)" stroke="currentColor" stroke-width="1.2" />
            </svg>
          </button>
          <button
            class="wc-btn wc-close"
            type="button"
            title="关闭"
            aria-label="关闭"
            @click="onWinClose"
          >
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <line x1="1.5" y1="1.5" x2="8.5" y2="8.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
              <line x1="8.5" y1="1.5" x2="1.5" y2="8.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
            </svg>
          </button>
        </div>
      </div>
    </header>

    <!-- ─── 主内容区 ─── -->
    <main class="app-main">
      <router-view v-slot="{ Component }">
        <transition name="fade" mode="out-in">
          <component :is="Component" />
        </transition>
      </router-view>
    </main>
  </div>
</template>

<style scoped>
.app-shell {
  display: flex;
  flex-direction: column;
  width: 100vw;
  height: 100vh;
  overflow: hidden;
  background: var(--background);
}

/* ═══════════════════════════════════════════════════════════
   P1.5 厚壳化：自绘标题栏（36px，C3/C9）
   ═══════════════════════════════════════════════════════════ */
.title-bar {
  display: none;
}

/* C3：拖拽区已合并到 app-header */

.title-bar-brand {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}

.title-bar-logo {
  width: 20px;
  height: 20px;
  border-radius: 6px;
  background: linear-gradient(135deg, var(--primary), var(--accent));
  color: var(--primary-foreground);
  font-weight: 700;
  font-size: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  -webkit-app-region: no-drag;
  app-region: no-drag;
}

.title-bar-title {
  font-size: 12px;
  font-weight: 500;
  color: var(--foreground);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  opacity: 0.85;
}

/* C3：三控件使用 -webkit-app-region: no-drag，禁止拖拽误触 */
.title-bar-controls {
  flex: 0 0 auto;
  display: flex;
  align-items: stretch;
  height: 100%;
  -webkit-app-region: no-drag;
  app-region: no-drag;
}

.wc-btn {
  width: 56px;
  min-width: 56px;
  height: 64px;
  min-height: 64px;
  padding: 0;
  margin: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  color: var(--foreground-muted);
  cursor: pointer;
  transition: background var(--duration-fast), color var(--duration-fast);
  outline: none;
  -webkit-app-region: no-drag;
  app-region: no-drag;
  pointer-events: auto;
  position: relative;
  z-index: 10;
  box-sizing: border-box;
}

.wc-btn svg {
  pointer-events: none;
  flex-shrink: 0;
}

/* 三按钮统一 hover：整个按钮区域都有明显背景 */
.wc-min:hover,
.wc-max:hover {
  background: rgba(0, 0, 0, 0.08);
  color: var(--foreground);
}

:root.dark .wc-min:hover,
:root.dark .wc-max:hover,
.dark .wc-min:hover,
.dark .wc-max:hover {
  background: rgba(255, 255, 255, 0.1);
}

.wc-btn:focus-visible { box-shadow: inset 0 0 0 2px var(--ring); }

/* 关闭按钮特殊：hover 红底 + 白 X */
.wc-close:hover { background: #E81123; color: #FFFFFF; }
.wc-close:active { background: #C40E1C; filter: brightness(0.95); }

/* ─── 顶栏 ─── */
.app-header {
  flex: 0 0 var(--size-page-header-height);
  height: var(--size-page-header-height);
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 var(--space-4);
  background: var(--surface);
  border-bottom: 1px solid var(--border-subtle);
  gap: var(--space-4);
}

.app-header .brand {
  -webkit-app-region: drag;
  app-region: drag;
}

.app-header .tab-bar {
  -webkit-app-region: no-drag;
  app-region: no-drag;
}

.brand {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-width: 0;
}

.brand-logo {
  width: 28px;
  height: 28px;
  border-radius: var(--radius-md);
  background: linear-gradient(135deg, var(--primary), var(--accent));
  color: var(--primary-foreground);
  font-weight: 700;
  font-size: 13px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
}

.brand-text {
  display: flex;
  flex-direction: column;
  line-height: 1.2;
  min-width: 0;
}

.brand-name {
  font-size: var(--font-size-body);
  font-weight: 600;
  color: var(--foreground);
}

/* ─── Tab 栏 ─── */
.tab-bar {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  background: var(--color-surface-container);
  border-radius: var(--radius-md);
  padding: var(--space-1);
  -webkit-app-region: no-drag;
  app-region: no-drag;
}

/* ─── 顶栏右侧 ─── */
.header-right {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  -webkit-app-region: no-drag;
  app-region: no-drag;
}

.server-status {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--font-size-caption);
  color: var(--foreground-muted);
}

.status-dot {
  width: 8px;
  height: 8px;
  border-radius: var(--radius-full);
  box-shadow: 0 0 6px currentColor;
}

.system-stats {
  display: flex;
  gap: var(--space-3);
  font-size: var(--font-size-caption);
  color: var(--foreground-muted);
}

/* ─── 主内容区 ─── */
.app-main {
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
  position: relative;
}
</style>
