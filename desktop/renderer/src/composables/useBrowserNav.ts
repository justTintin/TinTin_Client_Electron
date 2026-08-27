// ═══════════════════════════════════════════════════════════════
// useBrowserNav — Browser.vue 导航域 composable
// 来源：views/Browser.vue 原 script setup L29-304 整体搬移（行为不变）。
// 职责：壳检测 / 地址栏交互与导航按钮 / 左栏平台·导航项单一激活态 /
//       URL→平台识别 / 平台与网页浏览器切换 / 左栏历史条目数据。
//
// 跨域接线约定：本 composable 与 useBrowserBounds 存在双向引用
//   （selectPlatform/selectWebBrowser/visitHistory 需要 isNarrow、
//    leftDrawerOpen、scheduleRecalcBounds；bounds 反向需要
//    getActivePlatformId）。为避免工厂函数循环依赖，Browser.vue 容器
//    创建 navWiring 对象传入本工厂，并在创建 useBrowserBounds 之后立即
//    回填字段——所有引用均发生在 setup 完成之后的事件/生命周期回调中，
//    时序安全。逻辑分支与原实现一一对应，未做增删。
// ═══════════════════════════════════════════════════════════════

import { computed, nextTick, ref } from 'vue'
import type { ComputedRef, Ref } from 'vue'
// desktop/types/global.d.ts 内含同名 declare type / declare interface，但该文件
// 是模块（顶部 import + 底部 export {}），其声明不注入全局作用域，renderer 的
// .ts 文件无法直接引用。因此在本文件定义唯一的可导出类型源（与 global.d.ts
// 字面一致），其余 composable / 组件统一从这里取用。
export type BrowserPlatformId = 'douyin' | 'weixin' | 'kuaishou' | 'xiaohongshu' | 'bilibili' | 'youtube' | 'jimeng'

/* ── 对外类型（工厂内直接引用；子组件 props 复用） ── */
export interface PlatformTab {
  id: BrowserPlatformId
  name: string
  badge: string
  active?: boolean
}
export type BrowseMode = 'browser' | 'favorites'
export interface SidebarItem {
  id: string
  name: string
  badge: string
  type: 'browser' | 'favorites' | 'platform'
  active?: boolean
}
export interface HistoryItem {
  id: string
  title: string
  url: string
  time: string
}

/** 容器持有的晚绑定依赖对象（Browser.vue 在创建 useBrowserBounds 后回填） */
export interface BrowserNavWiring {
  leftDrawerOpen: Ref<boolean>
  isNarrow: Ref<boolean>
  scheduleRecalcBounds: () => void
}

export interface UseBrowserNavReturn {
  isElectronShell: Ref<boolean>
  _detectShell: () => void
  DEFAULT_BROWSER_URL: string
  addressUrl: Ref<string>
  navCan: { back: boolean; forward: boolean }
  addressEditable: ComputedRef<boolean>
  getActivePlatformId: () => string | null
  onUrlEnter: () => Promise<void>
  navBack: () => Promise<void>
  navForward: () => Promise<void>
  navReload: () => Promise<void>
  platforms: Ref<PlatformTab[]>
  browseMode: Ref<BrowseMode>
  activeNavId: Ref<string>
  isWebBrowser: ComputedRef<boolean>
  isFavorites: ComputedRef<boolean>
  activePlatformId: ComputedRef<BrowserPlatformId | null>
  sidebarItems: ComputedRef<SidebarItem[]>
  onSidebarItemClick: (item: SidebarItem) => void
  detectPlatformFromUrl: (url: string) => BrowserPlatformId | null
  activePlatformName: ComputedRef<string>
  selectPlatform: (id: string, loadDefaultUrl?: boolean) => Promise<void>
  selectWebBrowser: () => Promise<void>
  historyItems: Ref<HistoryItem[]>
  visitHistory: (item: HistoryItem) => Promise<void>
}

/* ── 壳检测（C9 门控）：Electron = true，纯 Vite 浏览器 = false，走降级占位 ────── */

export function useBrowserNav(layoutWiring: BrowserNavWiring): UseBrowserNavReturn {
const isElectronShell = ref(false)
function _detectShell(): void {
  const t = (window as any).tintin
  isElectronShell.value = !!(t && t.browser && typeof t.browser.attachPlatform === 'function')
}
_detectShell()

/* ── 地址栏交互 + 导航按钮 ──────────────────────────────────────────── */
// 默认起始 URL（对齐原素材浏览器：https://www.pinterest.com/）
const DEFAULT_BROWSER_URL = 'https://www.pinterest.com/'
const addressUrl = ref<string>(DEFAULT_BROWSER_URL)
const navCan = { back: false, forward: false }

// 地址栏是否可编辑（仅网页浏览器模式可编辑）
const addressEditable = computed(() => isWebBrowser.value)

// 获取当前有效的平台 ID（用于 attach/navigate）
// 网页浏览器模式返回 'web'，平台模式返回对应平台 ID
function getActivePlatformId(): string | null {
  if (isWebBrowser.value) return 'web'
  return activePlatformId.value
}

async function onUrlEnter(): Promise<void> {
  const u = addressUrl.value.trim()
  if (!u) return
  if (!isElectronShell.value) return
  // 仅网页浏览器模式下地址栏输入才导航（平台模式地址栏锁定）
  if (!isWebBrowser.value) return
  const pid = getActivePlatformId()
  if (!pid) return
  try {
    const r = await (window as any).tintin.browser.navigate({ platformId: pid, url: u })
    if (r?.success && r?.data) {
      navCan.back = !!r.data.canGoBack
      navCan.forward = !!r.data.canGoForward
    }
  } catch (_) {}
}
async function navBack(): Promise<void> {
  const pid = getActivePlatformId()
  if (!pid || !isElectronShell.value) return
  try {
    const r = await (window as any).tintin.browser.navigate({ platformId: pid, back: true })
    if (r?.success && r?.data) { navCan.back = !!r.data.canGoBack; navCan.forward = !!r.data.canGoForward }
  } catch (_) {}
}
async function navForward(): Promise<void> {
  const pid = getActivePlatformId()
  if (!pid || !isElectronShell.value) return
  try {
    const r = await (window as any).tintin.browser.navigate({ platformId: pid, forward: true })
    if (r?.success && r?.data) { navCan.back = !!r.data.canGoBack; navCan.forward = !!r.data.canGoForward }
  } catch (_) {}
}
async function navReload(): Promise<void> {
  const pid = getActivePlatformId()
  if (!pid || !isElectronShell.value) return
  try { await (window as any).tintin.browser.navigate({ platformId: pid, reload: true }) } catch (_) {}
}

/* ── 平台标签（左栏，对齐原客户端素材浏览器布局） ─────────────── */

const platforms = ref<PlatformTab[]>([
  { id: 'douyin',      name: '抖音',   badge: '抖' },
  { id: 'bilibili',    name: 'B站',    badge: 'B' },
  { id: 'kuaishou',    name: '快手',   badge: '快' },
  { id: 'xiaohongshu', name: '小红书', badge: '小' },
  { id: 'weixin',      name: '视频号', badge: '视' },
  { id: 'youtube',     name: 'YouTube', badge: 'Y' },
  { id: 'jimeng',      name: '即梦AI', badge: '即' },
])

const browseMode = ref<BrowseMode>('browser')

/* ── 统一导航项：网页浏览器 + 收藏记录 + 常用平台（单一激活态） ── */
// 当前选中的导航项 ID（'web' | 'favorites' | 平台 ID）
const activeNavId = ref<string>('web')
const isWebBrowser = computed(() => activeNavId.value === 'web')
const isFavorites = computed(() => activeNavId.value === 'favorites')
const activePlatformId = computed<BrowserPlatformId | null>(() => {
  if (isWebBrowser.value || isFavorites.value) return null
  const id = activeNavId.value as BrowserPlatformId
  return platforms.value.some(p => p.id === id) ? id : null
})

const sidebarItems = computed<SidebarItem[]>(() => [
  { id: 'web', name: '网页浏览器', badge: '🌐', type: 'browser', active: isWebBrowser.value },
  ...platforms.value.map(p => ({
    id: p.id, name: p.name, badge: p.badge, type: 'platform' as const,
    active: activeNavId.value === p.id,
  })),
  { id: 'favorites', name: '收藏记录', badge: '📑', type: 'favorites', active: isFavorites.value },
])

function onSidebarItemClick(item: SidebarItem): void {
  activeNavId.value = item.id
  if (item.type === 'favorites') {
    browseMode.value = 'favorites'
  } else if (item.type === 'browser') {
    browseMode.value = 'browser'
    void selectWebBrowser()
  } else {
    browseMode.value = 'browser'
    void selectPlatform(item.id)
  }
}

/** URL → 平台 ID 映射（根据域名自动识别） */
const PLATFORM_DOMAINS: Record<BrowserPlatformId, RegExp[]> = {
  douyin:      [/douyin\.com/i, /iesdouyin\.com/i],
  bilibili:    [/bilibili\.com/i],
  kuaishou:    [/kuaishou\.com/i, /ks\.com/i],
  xiaohongshu: [/xiaohongshu\.com/i, /xhslink\.com/i],
  weixin:      [/channels\.weixin\.qq\.com/i, /weixin\.qq\.com/i, /wx\.qq\.com/i],
  youtube:     [/youtube\.com/i, /youtu\.be/i, /music\.youtube\.com/i],
  jimeng:      [/jimeng\.jianying\.com/i, /jimeng\.com/i],
}

function detectPlatformFromUrl(url: string): BrowserPlatformId | null {
  if (!url) return null
  try {
    const u = new URL(url)
    const hostname = u.hostname.toLowerCase()
    for (const [id, patterns] of Object.entries(PLATFORM_DOMAINS)) {
      if (patterns.some((p) => p.test(hostname))) return id as BrowserPlatformId
    }
  } catch {
    for (const [id, patterns] of Object.entries(PLATFORM_DOMAINS)) {
      if (patterns.some((p) => p.test(url))) return id as BrowserPlatformId
    }
  }
  return null
}

const activePlatformName = computed<string>(() => {
  const p = platforms.value.find((x) => x.active)
  return p ? p.name : ''
})

async function selectPlatform(id: string, loadDefaultUrl: boolean = false): Promise<void> {
  const pid = id as BrowserPlatformId
  // activeNavId 已由 onSidebarItemClick 设置，这里确保同步
  activeNavId.value = id
  browseMode.value = 'browser'

  // 非壳模式：直接更新地址栏
  if (!isElectronShell.value) {
    const seed: Record<BrowserPlatformId, string> = {
      douyin: 'https://www.douyin.com',
      weixin: 'https://channels.weixin.qq.com',
      kuaishou: 'https://www.kuaishou.com',
      xiaohongshu: 'https://www.xiaohongshu.com',
      bilibili: 'https://www.bilibili.com',
      youtube: 'https://www.youtube.com',
      jimeng: 'https://jimeng.jianying.com',
    }
    addressUrl.value = loadDefaultUrl ? DEFAULT_BROWSER_URL : (seed[pid] || 'about:blank')
    if (layoutWiring.isNarrow.value) layoutWiring.leftDrawerOpen.value = false
    return
  }

  // 壳模式：attachPlatform → 导航到 seed URL
  try {
    const t = (window as any).tintin
    const r = await t.browser.attachPlatform(pid, undefined, loadDefaultUrl)
    if (r?.success && r?.data) {
      if (loadDefaultUrl) {
        // 初始加载：跳过 seed，手动导航到默认 URL
        addressUrl.value = DEFAULT_BROWSER_URL
        try {
          await t.browser.navigate({ platformId: pid, url: DEFAULT_BROWSER_URL })
        } catch (_) {}
      } else {
        // 用户点击平台：直接用 seed URL（不依赖主进程返回的 currentUrl，因 loadURL 是异步的）
        const seed: Record<string, string> = {
          douyin: 'https://www.douyin.com',
          weixin: 'https://channels.weixin.qq.com',
          kuaishou: 'https://www.kuaishou.com',
          xiaohongshu: 'https://www.xiaohongshu.com',
          bilibili: 'https://www.bilibili.com',
          youtube: 'https://www.youtube.com',
          jimeng: 'https://jimeng.jianying.com',
          web: 'https://www.pinterest.com',
        }
        addressUrl.value = seed[pid] || addressUrl.value
      }
      navCan.back = !!r.data.canGoBack
      navCan.forward = !!r.data.canGoForward
    }
    await nextTick()
    layoutWiring.scheduleRecalcBounds()
  } catch (e) {
    console.warn('[Browser] attachPlatform failed:', e)
  }
}

// 点击"网页浏览器"标签
async function selectWebBrowser(): Promise<void> {
  activeNavId.value = 'web'
  browseMode.value = 'browser'
  if (!isElectronShell.value) {
    addressUrl.value = DEFAULT_BROWSER_URL
    return
  }
  try {
    const t = (window as any).tintin
    // 'web' 是网页浏览器的独立 partition ID
    const r = await t.browser.attachPlatform('web')
    if (r?.success && r?.data) {
      addressUrl.value = r.data.currentUrl || DEFAULT_BROWSER_URL
      navCan.back = !!r.data.canGoBack
      navCan.forward = !!r.data.canGoForward
    }
    await nextTick()
    layoutWiring.scheduleRecalcBounds()
  } catch (e) {
    console.warn('[Browser] attachPlatform(web) failed:', e)
  }
}

/* ── 浏览历史（左栏，设计稿 tag-item 样式） ─────────────── */

const historyItems = ref<HistoryItem[]>([
  { id: 'h1', title: '抖音创作中心',   url: 'creator.douyin.com',       time: '14:23' },
  { id: 'h2', title: 'B站创作中心',    url: 'member.bilibili.com',      time: '13:58' },
  { id: 'h3', title: 'JBL 官方旗舰店', url: 'douyin.com/shop/jbl',      time: '11:02' },
  { id: 'h4', title: 'CHARGE6 商品详情页', url: 'douyin.com/item/72xxx', time: '10:41' },
  { id: 'h5', title: '小红书热门种草榜', url: 'xiaohongshu.com/hot',    time: '昨天' },
  { id: 'h6', title: '快手热榜',       url: 'kuaishou.com/hot',         time: '昨天' }
])

async function visitHistory(item: HistoryItem): Promise<void> {
  const u = 'https://' + item.url
  addressUrl.value = u
  if (layoutWiring.isNarrow.value) layoutWiring.leftDrawerOpen.value = false
  if (!isElectronShell.value) return
  const cur = getActivePlatformId()
  if (!cur) return
  try {
    await (window as any).tintin.browser.navigate({ platformId: cur, url: u })
  } catch (_) {}
}

return {
  isElectronShell, _detectShell, DEFAULT_BROWSER_URL, addressUrl, navCan,
  addressEditable, getActivePlatformId, onUrlEnter, navBack, navForward,
  navReload, platforms, browseMode, activeNavId, isWebBrowser, isFavorites,
  activePlatformId, sidebarItems, onSidebarItemClick, detectPlatformFromUrl,
  activePlatformName, selectPlatform, selectWebBrowser, historyItems, visitHistory,
}
}

