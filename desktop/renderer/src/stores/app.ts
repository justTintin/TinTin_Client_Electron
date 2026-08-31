// ═══════════════════════════════════════════════════════════════
// App Store — 应用级状态
// 管理当前激活 Tab、客户端版本、侧边栏折叠状态、外观主题（亮/暗/跟随系统）
// ═══════════════════════════════════════════════════════════════

import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

/** 主 Tab + 设置页标识 */
export type TabKey = 'workbench' | 'browser' | 'ops-tools' | 'media-tools' | 'settings'

/** 外观主题模式 */
export type ThemeMode = 'light' | 'dark' | 'system'

const THEME_STORAGE_KEY = 'tintin.themeMode'
const DARK_CLASS = 'dark'

/**
 * 持久化：优先走 IPC（tintin.config.get/set → electron-store）
 * 无 IPC 时回退 localStorage（浏览器模式 / 旧版 preload.js 时仍可用）
 */
function readModeStorage(): ThemeMode | null {
  const w = window as any
  if (w?.tintin?.config?.get) {
    try {
      const v = w.tintin.config.get('themeMode')
      if (v === 'light' || v === 'dark' || v === 'system') return v
    } catch (_) { /* ignore */ }
  }
  if (typeof localStorage !== 'undefined') {
    const v = localStorage.getItem(THEME_STORAGE_KEY)
    if (v === 'light' || v === 'dark' || v === 'system') return v
  }
  return null
}

function writeModeStorage(m: ThemeMode) {
  const w = window as any
  let ipcOk = false
  if (w?.tintin?.config?.set) {
    try {
      w.tintin.config.set('themeMode', m)
      ipcOk = true
    } catch (_) { /* ignore */ }
  }
  if (!ipcOk && typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(THEME_STORAGE_KEY, m)
    } catch (_) { /* ignore */ }
  }
}

function systemPrefersDark(): boolean {
  try {
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
  } catch (_) {
    return false
  }
}

function setHtmlDarkClass(enable: boolean) {
  if (typeof document === 'undefined') return
  const html = document.documentElement
  if (enable) html.classList.add(DARK_CLASS)
  else html.classList.remove(DARK_CLASS)
}

export const useAppStore = defineStore('app', () => {
  // 当前激活的 Tab，默认工作台
  const activeTab = ref<TabKey>('workbench')

  // hotspot 到点触发信号（时间戳）：App.vue 订阅事件后 bump，
  // Browser.vue watch 该值 → navigateToHotspot 热榜导航（单一信号源，不直接跨视图调用）
  const pendingHotspotNav = ref<number>(0)

  /** bump hotspot 导航信号 */
  function bumpHotspotNav(): void {
    pendingHotspotNav.value = Date.now()
  }

  // 客户端版本号，由 main 进程注入
  const version = ref<string>('3.0.0')

  // 工作台侧边栏是否折叠
  const sidebarCollapsed = ref<boolean>(false)

  // 外观主题：light / dark / system，默认 system（亮色优先跟随系统）
  const themeMode = ref<ThemeMode>('system')

  /** 解析后的实际主题（考虑 system → 系统偏好） */
  const resolvedTheme = computed<'light' | 'dark'>(() => {
    if (themeMode.value === 'system') return systemPrefersDark() ? 'dark' : 'light'
    return themeMode.value
  })

  /** 当前模式的可读描述（用于 Settings 页面副标题提示） */
  const themeModeLabel = computed(() => {
    const labels: Record<ThemeMode, string> = {
      light:  '亮色主题（白底，默认对齐设计稿）',
      dark:   '暗色主题（深灰底，减少视觉疲劳）',
      system: `跟随系统（当前系统：${systemPrefersDark() ? '暗色' : '亮色'}）`,
    }
    return labels[themeMode.value]
  })

  /** matchMedia listener：system 模式下系统切主题时实时同步 */
  let _systemDarkListener: ((e: MediaQueryListEvent) => void) | null = null

  /** 把解析好的 resolved 主题写入 document */
  function applyDomTheme() {
    setHtmlDarkClass(resolvedTheme.value === 'dark')
  }

  /** 注册/注销跟随系统的监听 */
  function bindSystemListener() {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    if (!_systemDarkListener) {
      _systemDarkListener = () => {
        if (themeMode.value === 'system') applyDomTheme()
      }
      // Safari < 14：addListener / removeListener；标准：addEventListener('change', ...)
      try {
        (mq as any).addEventListener?.('change', _systemDarkListener)
      } catch (_) {
        try { (mq as any).addListener?.(_systemDarkListener) } catch (__) { /* ignore */ }
      }
    }
  }

  /** 切换主题模式（对外 API） */
  function setThemeMode(m: ThemeMode) {
    if (themeMode.value === m) return
    themeMode.value = m
    writeModeStorage(m)
    applyDomTheme()
  }

  /** 启动初始化：读持久化 + 绑定监听 + 首次应用 */
  function initTheme() {
    const stored = readModeStorage()
    if (stored) themeMode.value = stored
    bindSystemListener()
    applyDomTheme()
  }

  /** 切换当前 Tab */
  function setActiveTab(tab: TabKey): void {
    activeTab.value = tab
  }

  /** 设置版本号（main 进程回调时使用） */
  function setVersion(v: string): void {
    version.value = v
  }

  /** 切换侧边栏折叠状态 */
  function toggleSidebar(): void {
    sidebarCollapsed.value = !sidebarCollapsed.value
  }

  return {
    activeTab,
    pendingHotspotNav,
    bumpHotspotNav,
    version,
    sidebarCollapsed,
    themeMode,
    resolvedTheme,
    themeModeLabel,
    setActiveTab,
    setVersion,
    toggleSidebar,
    setThemeMode,
    initTheme,
  }
})
