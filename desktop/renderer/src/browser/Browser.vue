<script setup lang="ts">
// ═══════════════════════════════════════════════════════════════
// Browser.vue — 浏览器页「容器组件」（对齐 TinTin V3 UI 设计稿三栏布局）
//
// 已按「容器 + 展示组件 + composable」拆分：
//   · composables/useBrowserNav.ts        导航/地址栏/左栏激活态（L29-304）
//   · composables/useBrowserFavorites.ts  收藏域（L392-479）
//   · composables/useBrowserDownloads.ts  下载/嗅探/历史域（L297-777、L1011-1018）
//   · composables/useBrowserBounds.ts     BrowserView 边界/多端适配（L779-1009、L1178-1216）
//   · components/BrowserToolbar.vue       工具栏
//   · components/BrowserSidebar.vue       左栏
//   · components/FavoritesView.vue        收藏视图
//   · components/BrowserRightPanel.vue    右栏双 Tab
// 本文件仅保留：组合函数实例化与显式接线、事件订阅 _subscribeEvents、
// onMounted/onBeforeUnmount 主编排、host 容器 DOM 与壳层公共样式。
//
// D2 搬迁（浏览器域解耦批次1）：
//   · 由 views/Browser.vue → src/browser/Browser.vue，作为独立渲染入口挂载组件
//   · 切断对主应用模块依赖：不再使用 @/stores/app；hotspot 触发改为自含订阅
//     tintinBrowser.scheduled.onScheduledHotspot；窗口状态重算改为自含订阅
//     tintinBrowser.win.onStateChange（替代原 App.vue 的 app:winstate-changed 广播）
//   · 所有 IPC 调用由 window.tintin → window.tintinBrowser（browser-preload.js）
//
// 行为要点（沿用原实现）：
//   · browser-view-host 容器 + attachPlatform（partition 隔离）
//   · 4 源 bounds 重算（C13 200ms debounce）+ 看门狗主动校验
//   · 导航：后退/前进/刷新/Enter 跳页 → browser:navigate
//   · URL 更新订阅：did-navigate → 回填地址栏；下载更新订阅：will-download
//   · C6 切 Tab / onBeforeUnmount：detachAll 防止原生层级泄漏
// ═══════════════════════════════════════════════════════════════

import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useBrowserNav } from './composables/useBrowserNav'
import type { BrowserNavWiring, BrowserPlatformId } from './composables/useBrowserNav'
import { useBrowserFavorites } from './composables/useBrowserFavorites'
import { useBrowserDownloads } from './composables/useBrowserDownloads'
import { useBrowserBounds } from './composables/useBrowserBounds'
import { useBrowserLogin } from './composables/useBrowserLogin'
import type { LoginState } from './composables/useBrowserLogin'
import { useBrowserDailyAssets } from './composables/useBrowserDailyAssets'
import { useBrowserCreators } from './composables/useBrowserCreators'
import BrowserSidebar from './components/BrowserSidebar.vue'
import BrowserToolbar from './components/BrowserToolbar.vue'
import FavoritesView from './components/FavoritesView.vue'
import AutoListingView from './components/AutoListingView.vue'
import DailyAssetsView from './components/DailyAssetsView.vue'
import CreatorsView from './components/CreatorsView.vue'
import BrowserRightPanel from './components/BrowserRightPanel.vue'

/* ══ 组合函数实例化与显式接线（无全局单例 store） ══ */
// nav ↔ bounds 双向依赖走晚绑定：bounds 创建后立刻回填，
// 全部读取发生在 setup 完成后的事件回调内，时序安全。
const navWiring = {} as BrowserNavWiring
const nav = useBrowserNav(navWiring)
const favoritesApi = useBrowserFavorites({
  addressUrl: nav.addressUrl,
  activeNavId: nav.activeNavId,
  activePlatformName: nav.activePlatformName,
  browseMode: nav.browseMode,
})
const downloadsApi = useBrowserDownloads({
  isElectronShell: nav.isElectronShell,
  addressUrl: nav.addressUrl,
  getActivePlatformId: nav.getActivePlatformId,
  activePlatformId: nav.activePlatformId,
  activePlatformName: nav.activePlatformName,
})
const boundsApi = useBrowserBounds({
  isElectronShell: nav.isElectronShell,
  getActivePlatformId: nav.getActivePlatformId,
  platforms: nav.platforms,
})
// 登录状态域（条目⑧ B11）：cookieList 判定 + 工具栏/左栏徽章
const loginApi = useBrowserLogin(nav.activeNavId)
// B9/B10（浏览器域移植批次2）：每日素材 + 达人库域（进主页导航复用 nav 域能力）
const dailyAssetsApi = useBrowserDailyAssets()
const creatorsApi = useBrowserCreators({ onOpenHomepage: nav.navigateToCreatorHomepage })
/** 工具栏徽章用激活平台登录态：仅「有判定规则的平台」展示（web/autolisting → null 不渲染） */
const activeLoginStateProp = computed<LoginState | null>(() => {
  const id = nav.activeNavId.value
  if (id === 'web' || id === 'autolisting' || id === 'favorites' || id === 'dailyassets' || id === 'creators' || id === 'collect') return null
  return loginApi.activeLoginState.value
})
navWiring.leftDrawerOpen = boundsApi.leftDrawerOpen
navWiring.isNarrow = boundsApi.isNarrow
navWiring.scheduleRecalcBounds = boundsApi.scheduleRecalcBounds

/* ── 解构为原裸名，保持订阅回调 / 编排语句与原文件逐字一致 ── */
const {
  isElectronShell,
  addressUrl,
  navCan,
  addressEditable,
  onUrlEnter,
  navBack,
  navForward,
  navReload,
  navigateToHotspot,
  browseMode,
  activeNavId,
  sidebarItems,
  onSidebarItemClick,
  activePlatformId,
  activePlatformName,
  selectPlatform,
  selectWebBrowser,
  selectFxg,
} = nav

const router = useRouter()
/** 左栏底部「服务端」入口（2026-08-31）：在浏览器中打开系统设置里配置的服务端
 *  接口地址（config 'server.url'）；未配置时回退跳系统设置并定位到服务端地址配置。
 *  组件卸载时 onBeforeUnmount 已 detachAll（C6），BrowserView 不会泄漏到设置页 */
function onOpenServerSettings() {
  void nav.openServerHome(() => router.push('/settings?focus=server'))
}
const {
  favorites,
  favoritesCount,
  loadFavorites,
  navigateToFavorite,
  removeFavoriteItem,
} = favoritesApi
const {
  sniffedMedia,
  sniffedCount,
  loadBiliPluginState,
  biliPluginDownloadMode,
  biliExtDownloads,
  biliExtTitle,
  installedExtensions,
  loadInstalledExtensions,
  extIconSrc,
  _formatBytesPhase2,
  downloadSniffedMedia,
  downloadBiliExtLink,
  downloadFromPage,
  douyinParseDownload,
  mediaDownloadTasks,
  activeDownloadCount,
  _ensureMediaTask,
  historyEntries,
  addHistory,
  navigateToHistory,
  openHistoryPanel,
  openDownloadsPanel,
  saveAllToStorage,
  loadFromStorage,
} = downloadsApi

/** 抖音分享链接解析结果提示（预装 chrom-douyin 扩展能力，2026-09-02） */
const douyinParseMsg = ref<{ ok: boolean; message: string } | null>(null)
/** 解析下载：调主进程 browser:douyinParse（dy.xs25.cn 解析）→ 直链下载 */
async function onDouyinParse(text: string) {
  if (!text.trim()) return
  douyinParseMsg.value = { ok: true, message: '解析中…' }
  douyinParseMsg.value = await douyinParseDownload(text.trim())
}
const {
  hostRef,
  forceRecalcBounds,
  scheduleRecalcBounds,
  isNarrow,
  rightDocked,
  leftDrawerOpen,
  rightPanelOpen,
  backdropVisible,
  toggleLeftDrawer,
  closeOverlays,
  openExtensionsPanel,
  goSettings,
  setupMqWatchers,
  _onWindowResize,
  _startBoundsWatchdog,
  disposeBounds,
} = boundsApi

/* ── 子组件 v-model 中转（保持子组件纯展示） ── */
function setAddress(v: string): void { addressUrl.value = v }

/** 工具栏登录徽章点击：重检当前激活平台（条目⑧） */
function onRefreshLogin(): void {
  const id = nav.activeNavId.value
  if (!id || id === 'web' || id === 'autolisting' || id === 'favorites' || id === 'collect') return
  void loginApi.refreshOne(id)
}

/** B7：侧栏「素材采集」入口（activeNavId==='collect'）→ CreatorsView 固定展示采集清单 Tab */
const creatorsCollectMode = computed(() => nav.activeNavId.value === 'collect')

/* ── 订阅：URL 更新（did-navigate） + Cherry Studio view-ready（did-stop-loading） ──── */
let _unsubUrl: (() => void) | null = null
let _unsubViewReady: (() => void) | null = null
let _unsubMediaSniff: (() => void) | null = null
let _unsubMediaProgress: (() => void) | null = null
let _unsubBiliExtDl: (() => void) | null = null
let _unsubExtensions: (() => void) | null = null
let _unsubWinState: (() => void) | null = null

function _subscribeEvents(): void {
  if (!isElectronShell.value) return
  const t = (window as any).tintinBrowser
  try {
    if (typeof t.browser.onUrlUpdated === 'function') {
      _unsubUrl = t.browser.onUrlUpdated((payload: any) => {
        if (payload?.url) {
          // 平台模式：地址栏显示 URL 但 active 标签不变（锁定状态）
          // 网页浏览器模式：地址栏同步 URL，但 active 标签也不变
          addressUrl.value = payload.url
          addHistory(payload.url, payload?.title || '', payload.platformId)
          // 不再根据 URL 自动切换 active 标签——active 由用户点击决定
        }
      })
    }
    // Phase 2-1: 媒体嗅探订阅（browser:onMediaSniffed）
    if (typeof t.browser.onMediaSniffed === 'function') {
      _unsubMediaSniff = t.browser.onMediaSniffed((payload: any) => {
        // 跳过标记：主进程在非详情页/被忽略的请求时下发 skipped，不得当作真实媒体加入列表
        if (payload?.skipped) return
        if (!payload?.url) return
        const media: SniffedMediaLike = {
          id: payload.id || ('sniff_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6)),
          url: payload.url,
          name: payload.name || '未命名媒体',
          type: payload.type || 'video',
          size: payload.size,
          sizeText: payload.sizeText || _formatBytesPhase2(payload.size),
          platformId: payload.platformId,
          ts: payload.ts || Date.now(),
          audioUrl: payload.audioUrl,
        }
        const existing = sniffedMedia.value.findIndex((m) => m.url === media.url)
        if (existing >= 0) {
          sniffedMedia.value[existing] = media
        } else {
          sniffedMedia.value.unshift(media)
          if (sniffedMedia.value.length > 50) sniffedMedia.value.pop()
        }
      })
    }

    // Phase 2-2: 增强下载进度订阅（mediaDownload.onProgress）
    if (typeof t.mediaDownload?.onProgress === 'function') {
      _unsubMediaProgress = t.mediaDownload.onProgress((payload: any) => {
        const id = payload?.taskId || payload?.id
        if (!id) return
        // 主进程状态名与渲染层不一致：completed→done，failed→error
        let st = payload.status
        if (st === 'completed') st = 'done'
        else if (st === 'failed') st = 'error'
        const task = _ensureMediaTask(id, {
          title: payload?.filename || payload?.name || id,
          totalSize: payload?.totalSize || 0,
        })
        if (typeof payload.progress === 'number') task.progress = payload.progress
        if (typeof payload.speed === 'number') task.speed = payload.speed
        if (typeof payload.downloaded === 'number') task.downloaded = payload.downloaded
        if (typeof payload.totalSize === 'number') task.totalSize = payload.totalSize
        if (st) task.status = st
        if (st === 'done') {
          task.progress = 100
          task.speed = 0
          task.status = 'done'
        } else if (st === 'paused') {
          task.paused = true
          task.speed = 0
        } else if (st === 'downloading') {
          task.paused = false
        } else if (st === 'cancelled' || st === 'error') {
          task.speed = 0
        } else if (st === 'queued') {
          task.paused = false
        }
      })
    }

    // Cherry Studio：BrowserView did-stop-loading → 强制不 debounce 重算，防止布局跳动后 BrowserView 留在旧坐标
    if (typeof t.browser.onViewReady === 'function') {
      _unsubViewReady = t.browser.onViewReady((payload: any) => {
        if (!payload?.platformId) return
        if (payload.platformId !== activeNavId.value) return  // 其他 Tab 的事件忽略
        // 立刻 + 300ms 后各重算一次（首帧 Chromium 会补 1px 阴影/滚动条）
        forceRecalcBounds()
        setTimeout(() => forceRecalcBounds(), 300)
        // 登录态重检（条目⑧）：页面加载完成后 cookie 可能已变化（登录/登出跳转）
        void loginApi.refreshOne(payload.platformId)
      })
    }

    // B站扩展下载链接订阅
    if (typeof t.browser.onBiliExtDownloads === 'function') {
      _unsubBiliExtDl = t.browser.onBiliExtDownloads((payload: any) => {
        if (!payload?.payload?.downloads?.length) return
        biliExtDownloads.value = payload.payload.downloads
        biliExtTitle.value = payload.payload.title || ''
      })
    }

    // 已安装扩展变更订阅（安装/卸载后主进程广播 → 刷新工具栏图标）
    if (typeof t.browser.onExtensionsChanged === 'function') {
      _unsubExtensions = t.browser.onExtensionsChanged(() => {
        void loadInstalledExtensions()
      })
    }
    // 窗口最大化/还原/尺寸显著变化 → 强制重算 bounds（独立窗口自含订阅
    // tintinBrowser.win.onStateChange；条件与原 App.vue 广播口径一致）
    _unsubWinState = _bindWinStateRecalc()
  } catch (_) {}
}

/** 订阅窗口状态变化 → 满足条件时重算 bounds（替代原主应用 app:winstate-changed 广播） */
function _bindWinStateRecalc(): (() => void) | null {
  const t = (window as any).tintinBrowser
  if (typeof t?.win?.onStateChange !== 'function') return null
  let prev: any = null
  return t.win.onStateChange((st: any) => {
    const maxToggled = !!prev?.maximized !== !!st.maximized
    const fsToggled  = !!prev?.fullscreen  !== !!st.fullscreen
    const focusRegain = !prev?.focused && st.focused
    const sizeSig = Math.abs((st?.width ?? 0) - (prev?.width ?? 0)) >= 40 ||
                    Math.abs((st?.height ?? 0) - (prev?.height ?? 0)) >= 40
    if (maxToggled || fsToggled || focusRegain || sizeSig) scheduleRecalcBounds()
    prev = st
  })
}

/* ── 生命周期（主编排；订阅接线见上，断点监听收拢在 setupMqWatchers） ───────────────────────────────────────────── */
onMounted(async () => {
  // 断点监听（多端适配）
  setupMqWatchers()

  // Phase 3: 启动时加载持久化数据
  void loadFromStorage()
  void loadFavorites()
  void loadBiliPluginState()
  void loadInstalledExtensions()

  // 登录状态全量初检（条目⑧；并行 7 平台，失败静默不阻塞浏览）
  if (isElectronShell.value) {
    void loginApi.refreshAll(nav.platforms.value.map((p) => p.id))
  }

  // ① mount 后首次 bounds 重算（含 C9 判定）
  await nextTick()
  scheduleRecalcBounds()
  window.addEventListener('resize', _onWindowResize, { passive: true })
  _subscribeEvents()
  _startBoundsWatchdog()
  // P4：hotspot 到点触发 → 热榜导航（独立窗口自含订阅）
  _bindHotspotTrigger()
  // W11：客户端任务引导下载（主进程 client-task:open-download 订阅）
  _bindClientTaskDownload()

  // 初始：进入"网页浏览器"模式，加载默认 URL（Pinterest）
  if (browseMode.value === 'browser') {
    await selectWebBrowser()
  }
})

// 模式切换：浏览器模式 ↔ 收藏记录模式 ↔ 自动上架面板
// 注意：打开抖店统一走 watch('browser' + navId='autolisting') → selectFxg 单一路径，
// 避免面板直调 + watch 回环造成双重 attachPlatform（每次 attach 会 loadURL 重载页面）。
function openFxg() {
  activeNavId.value = 'autolisting'
  browseMode.value = 'browser'
}
watch(browseMode, async (mode) => {
  const t = (window as any).tintinBrowser
  if (mode === 'browser') {
    // 切回浏览器模式：恢复上次的 activeNavId
    const navId = activeNavId.value || 'web'
    if (navId === 'web') {
      await selectWebBrowser()
    } else if (navId === 'autolisting') {
      // 自动上架打开的抖店分区会话（从收藏等视图切回时恢复 attach）
      await selectFxg()
    } else {
      await selectPlatform(navId)
    }
  } else if (mode === 'favorites') {
    // 切到收藏模式：detach BrowserView 释放资源
    if (isElectronShell.value) {
      try {
        if (t?.browser?.detachAll) {
          await t.browser.detachAll()
        }
      } catch (_) {}
    }
    // 刷新收藏列表
    await loadFavorites()
  } else if (mode === 'autolisting') {
    // 切到自动上架面板：detach BrowserView 释放资源
    if (isElectronShell.value) {
      try {
        if (t?.browser?.detachAll) {
          await t.browser.detachAll()
        }
      } catch (_) {}
    }
  } else if (mode === 'dailyassets' || mode === 'creators') {
    // B9/B10：切数据视图 detach BrowserView + 拉取数据
    if (isElectronShell.value) {
      try {
        if (t?.browser?.detachAll) await t.browser.detachAll()
      } catch (_) {}
    }
    if (mode === 'dailyassets') {
      await dailyAssetsApi.loadDailyAssets()
    } else {
      await creatorsApi.loadCreators()
      await creatorsApi.loadCollected()
    }
  }
})

// ── P4：hotspot 到点触发 → 热榜导航（独立窗口自含订阅 tintinBrowser.scheduled
//    onScheduledHotspot → navigateToHotspot；替代原主应用 App.vue 经
//    appStore.pendingHotspotNav 的转发链路）──
let _unsubHotspot: (() => void) | null = null
function _bindHotspotTrigger(): void {
  const t = (window as any).tintinBrowser
  if (typeof t?.scheduled?.onScheduledHotspot === 'function') {
    _unsubHotspot = t.scheduled.onScheduledHotspot(() => { void navigateToHotspot() })
  }
}

// ── W11：客户端任务引导下载（主进程 client-task-thread.js 推送任务 URL →
//    tintinBrowser.browser.onClientTaskDownload → navigateToUrl 切平台页导航）──
let _unsubClientTaskDl: (() => void) | null = null
function _bindClientTaskDownload(): void {
  const t = (window as any).tintinBrowser
  if (typeof t?.browser?.onClientTaskDownload === 'function') {
    _unsubClientTaskDl = t.browser.onClientTaskDownload((payload: any) => {
      if (payload?.url) void nav.navigateToUrl(String(payload.url))
    })
  }
}

onBeforeUnmount(() => {
  // bounds 域清理（定时器 + resize 监听 + 断点监听）
  disposeBounds()
  if (_unsubWinState) { try { _unsubWinState() } catch(_){} _unsubWinState = null }
  if (_unsubHotspot) { try { _unsubHotspot() } catch(_){} _unsubHotspot = null }
  if (_unsubClientTaskDl) { try { _unsubClientTaskDl() } catch(_){} _unsubClientTaskDl = null }
  if (_unsubUrl) { try { _unsubUrl() } catch(_){} _unsubUrl = null }
  if (_unsubViewReady) { try { _unsubViewReady() } catch(_){} _unsubViewReady = null }
  if (_unsubMediaSniff) { try { _unsubMediaSniff() } catch(_){} _unsubMediaSniff = null }
  if (_unsubMediaProgress) { try { _unsubMediaProgress() } catch(_){} _unsubMediaProgress = null }
  if (_unsubBiliExtDl) { try { _unsubBiliExtDl() } catch(_){} _unsubBiliExtDl = null }
  if (_unsubExtensions) { try { _unsubExtensions() } catch(_){} _unsubExtensions = null }
  // C6：卸载前 detachAll，防止 BrowserView 原生层泄漏到其他 Tab
  try {
    const t = (window as any).tintinBrowser
    if (t?.browser?.detachAll) t.browser.detachAll().catch(() => {})
  } catch (_) {}
})

// 当 activeNavId 变化时：延迟重算 bounds（保证 DOM layout 完成）
watch(activeNavId, () => { nextTick().then(scheduleRecalcBounds) })

/** 模板内使用的嗅探媒体类型别名（结构 = downloads 域 SniffedMedia） */
type SniffedMediaLike = typeof sniffedMedia.value[number]
</script>

<template>
  <section class="browser-page">
    <!-- ─── 顶部工具条 ─── -->
    <BrowserToolbar
      :left-drawer-open="leftDrawerOpen"
      :nav-can="navCan"
      :is-electron-shell="isElectronShell"
      :address="addressUrl"
      :address-editable="addressEditable"
      :extensions="installedExtensions"
      :icon-src="extIconSrc"
      :history-count="historyEntries.length"
      :active-download-count="activeDownloadCount"
      :login-state="activeLoginStateProp"
      @toggle-left-drawer="toggleLeftDrawer"
      @back="navBack"
      @forward="navForward"
      @reload="navReload"
      @update:address="setAddress"
      @url-enter="onUrlEnter"
      @open-ext-panel="openExtensionsPanel"
      @open-history-panel="openHistoryPanel"
      @open-downloads-panel="openDownloadsPanel"
      @open-settings="goSettings"
      @refresh-login="onRefreshLogin"
    />

    <!-- ─── 主体：左栏 + 渲染区 + 右栏 ─── -->
    <div class="browser-body">
      <!-- 左栏：统一导航（收藏记录 + 常用平台，单一激活态，无分组） -->
      <BrowserSidebar
        :sidebar-items="sidebarItems"
        :left-drawer-open="leftDrawerOpen"
        :login-states="loginApi.loginStates.value"
        @select-item="onSidebarItemClick"
        @open-server="onOpenServerSettings"
      />

      <!-- 中间主区：BrowserView host / 收藏记录列表 -->
      <main class="browser-main">
        <!-- 网页浏览器模式：直接显示浏览器，对齐原素材浏览器行为 -->
        <div v-if="browseMode === 'browser'" class="browser-view-area">
          <!-- ═══ BrowserView 宿主容器（厚壳化） ═══
               真实 BrowserView（原生层）通过 getBoundingClientRect
               覆盖到此节点之上（z-index 由 Electron 管理）。
               非壳模式（Vite 浏览器预览）→ 设计稿地球占位。 -->
          <div
            ref="hostRef"
            id="browser-view-host"
            class="browser-view-host"
          >
            <!-- 非壳模式降级占位：设计稿「BrowserView 渲染区」 -->
            <template v-if="!isElectronShell">
              <div class="webview-placeholder">
                <div class="placeholder-icon">
                  <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                    <circle cx="12" cy="12" r="10" />
                    <path d="M2 12h20" />
                    <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
                  </svg>
                </div>
                <div class="placeholder-title">BrowserView 渲染区</div>
                <div class="placeholder-sub">独立 session partition：persist:tintin-browser</div>
                <div v-if="activePlatformName" class="placeholder-platform">
                  当前平台：{{ activePlatformName }}
                </div>
              </div>
            </template>
            <!-- 壳模式：BrowserView 原生层覆盖宿主 DOM → 这里只渲染一个
                 细微的 Luosiding 风格徽标（不阻挡交互，z-index 由 Electron 控制） -->
            <template v-else>
              <div class="host-decoration" aria-hidden="true">
                <span class="host-badge">
                  {{ activePlatformName || '浏览器' }}
                  <span class="host-sep">·</span>
                  <span class="host-tip">BrowserView</span>
                </span>
              </div>
            </template>
          </div>

          </div>

        <!-- 自动上架面板（P3 迁移自系统设置扩展卡） -->
        <AutoListingView
          v-else-if="browseMode === 'autolisting'"
          @open-fxg="openFxg"
        />

        <!-- 收藏记录模式 -->
        <FavoritesView
          v-else-if="browseMode === 'favorites'"
          :favorites="favorites"
          :favorites-count="favoritesCount"
          @navigate="navigateToFavorite"
          @remove="removeFavoriteItem"
        />

        <!-- B9 每日素材（日期分组 + 预览 + 筛选） -->
        <DailyAssetsView
          v-else-if="browseMode === 'dailyassets'"
        />

        <!-- B10 达人/创作者库（达人列表 + 采集清单）；B7 素材采集入口 → 采集清单 Tab -->
        <CreatorsView
          v-else
          :collect-mode="creatorsCollectMode"
          @open-homepage="nav.navigateToCreatorHomepage"
        />
      </main>

      <!-- 右栏：媒体嗅探（下载进度内嵌卡片；下载管理在工具栏⬇浮窗） -->
      <BrowserRightPanel
        :open="rightPanelOpen"
        :sniffed-media="sniffedMedia"
        :media-tasks="mediaDownloadTasks"
        :bili-plugin-mode="biliPluginDownloadMode"
        :bili-ext-title="biliExtTitle"
        :bili-ext-downloads="biliExtDownloads"
        :is-electron-shell="isElectronShell"
        :active-platform-id="activePlatformId"
        :page-url="addressUrl"
        :douyin-parse-msg="douyinParseMsg"
        @download-media="downloadSniffedMedia"
        @download-bili="downloadBiliExtLink"
        @page-download="downloadFromPage"
        @douyin-parse="onDouyinParse"
      />

      <!-- 浮层遮罩：抽屉/滑出面板打开时（<1200px） -->
      <div
        v-if="backdropVisible"
        class="drawer-backdrop"
        @click="closeOverlays"
      />
    </div>
  </section>
</template>

<style scoped>
.browser-page {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: var(--background);
  position: relative;  /* BrowserView bounds 计算基于 page 内部绝对坐标 */
}

/* ─── 主体 ─── */
.browser-body {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  width: 100%;
  position: relative;
}

/* ─── 浏览器主区 ─── */
.browser-main {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

/* ─── BrowserView 宿主容器 ─── */
.browser-view-area {
  flex: 1 1 auto;
  min-height: 0;
  padding: 0;
  overflow: hidden;
  position: relative;
}

/* ─── BrowserView 宿主容器 ─── */
.browser-view-host {
  width: 100%;
  height: 100%;
  position: relative;
  background: var(--background);
  overflow: hidden;
}

/* 非壳模式降级：设计稿「BrowserView 渲染区」地球占位 */
.webview-placeholder {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  background: var(--background);
}

.placeholder-icon {
  width: 80px;
  height: 80px;
  border-radius: var(--radius-2xl, 14px);
  background: var(--card);
  border: 1px solid var(--border);
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: var(--space-5);
  color: var(--muted-foreground);
  box-shadow: var(--shadow-1);
}

.placeholder-title {
  font-size: 16px;
  font-weight: 500;
  color: var(--foreground);
  margin-bottom: 4px;
}

.placeholder-sub {
  font-size: 14px;
  color: var(--muted-foreground);
}

.placeholder-platform {
  margin-top: var(--space-3);
  padding: 4px 12px;
  border-radius: var(--radius-full);
  background: var(--surface-container);
  border: 1px solid var(--border);
  font-size: 12px;
  color: var(--muted-foreground);
}

/* 壳模式装饰：右下角轻量品牌徽标（BrowserView 覆盖在整个 host 之上，
   此徽标仅在加载瞬间可见，之后被 BrowserView 遮挡；作为视觉锚点） */
.host-decoration {
  position: absolute;
  right: 16px;
  bottom: 14px;
  pointer-events: none;
  opacity: 0.65;
  z-index: 1;
}
.host-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.45);
  color: #fff;
  font-size: 11px;
  font-weight: 600;
  backdrop-filter: blur(6px);
  letter-spacing: 0.02em;
}
.host-sep { opacity: 0.55; }
.host-tip { font-family: var(--font-mono); opacity: 0.8; }

/* Cherry Studio：BrowserView bounds 校验徽标（独立于 host，不被原生层遮挡；
   z-index 低于 BrowserView（原生层无上限）但在 .browser-view-area 上层，可点可见） */
.bounds-pill {
  position: absolute;
  top: 24px;
  right: 24px;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.01em;
  line-height: 1;
  cursor: pointer;
  user-select: none;
  border: 1px solid transparent;
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  transition: all 0.18s var(--easing-default);
  z-index: 10;
  box-shadow: 0 4px 16px rgba(15, 23, 42, 0.10);
}
.bounds-pill:hover { transform: translateY(-1px); box-shadow: 0 8px 24px rgba(15, 23, 42, 0.14); }
.bounds-pill:active { transform: translateY(0); }
.bounds-pill-dot {
  width: 8px; height: 8px; border-radius: 999px;
  box-shadow: 0 0 0 2px rgba(255,255,255,0.18);
}
.bounds-pill-text {
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
  min-width: 2.8em;
  text-align: left;
}
/* unknown（灰）：未校验 / 非 Electron 模式 */
.bounds-pill.unknown {
  background: rgba(148, 163, 184, 0.16);
  border-color: rgba(148, 163, 184, 0.32);
  color: #475569;
}
.dark .bounds-pill.unknown {
  background: rgba(148, 163, 184, 0.18);
  border-color: rgba(148, 163, 184, 0.30);
  color: #cbd5e1;
}
.bounds-pill.unknown .bounds-pill-dot { background: #94a3b8; }

/* ok（绿）：withinTolerance & visible */
.bounds-pill.ok {
  background: rgba(52, 211, 153, 0.18);
  border-color: rgba(52, 211, 153, 0.38);
  color: #065f46;
}
.dark .bounds-pill.ok {
  background: rgba(52, 211, 153, 0.20);
  border-color: rgba(52, 211, 153, 0.34);
  color: #34d399;
}
.bounds-pill.ok .bounds-pill-dot { background: #10b981; box-shadow: 0 0 0 2px rgba(52,211,153,0.24); }

/* nomatch（红）：差异 >3px 或未 attach / 不可见 */
.bounds-pill.nomatch {
  background: rgba(248, 113, 113, 0.20);
  border-color: rgba(248, 113, 113, 0.42);
  color: #991b1b;
  animation: bounds-nomatch-pulse 1.8s ease-in-out infinite;
}
.dark .bounds-pill.nomatch {
  background: rgba(239, 68, 68, 0.22);
  border-color: rgba(248, 113, 113, 0.38);
  color: #fca5a5;
}
.bounds-pill.nomatch .bounds-pill-dot {
  background: #ef4444;
  box-shadow: 0 0 0 2px rgba(239,68,68,0.28), 0 0 0 6px rgba(239,68,68,0.12);
}
@keyframes bounds-nomatch-pulse {
  0%,100% { box-shadow: 0 4px 16px rgba(239,68,68,0.22); }
  50%     { box-shadow: 0 6px 22px rgba(239,68,68,0.38); }
}

/* verifying（紫）：校验中 */
.bounds-pill.verifying {
  background: rgba(139, 92, 246, 0.18);
  border-color: rgba(139, 92, 246, 0.38);
  color: #4c1d95;
}
.dark .bounds-pill.verifying {
  background: rgba(139, 92, 246, 0.20);
  border-color: rgba(139, 92, 246, 0.34);
  color: #c4b5fd;
}
.bounds-pill.verifying .bounds-pill-dot {
  background: conic-gradient(from 0deg, #8b5cf6 0%, #c4b5fd 50%, #8b5cf6 100%);
  animation: bounds-verifying-spin 1.1s linear infinite;
}
@keyframes bounds-verifying-spin { from { transform: rotate(0) } to { transform: rotate(360deg) } }

/* ─── 浮层遮罩 ─── */
.drawer-backdrop {
  position: absolute;
  inset: 0;
  background: rgba(15, 17, 34, 0.4);
  z-index: 40;
}

@media (prefers-reduced-motion: reduce) {
  .bounds-pill.nomatch { animation: none; }
}
</style>
