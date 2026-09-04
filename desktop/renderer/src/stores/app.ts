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

/** 界面风格：标准 / 玻璃质感（macOS 风格） */
export type VisualStyle = 'standard' | 'glass'

/** 字体粗细档位 */
export type FontWeightLevel = 'regular' | 'medium' | 'semibold'

/**
 * 字体粗细数值映射（显式定义每档所有变量值）
 * 间距 ≥ 200，确保中文字体（微软雅黑/苹方）上可感知差异
 */
const FONT_WEIGHT_MAP: Record<FontWeightLevel, {
  body: number; medium: number; semibold: number
}> = {
  regular:  { body: 400, medium: 500, semibold: 600 },
  medium:   { body: 500, medium: 600, semibold: 700 },
  semibold: { body: 600, medium: 700, semibold: 700 },
}

const THEME_STORAGE_KEY = 'tintin.themeMode'
const VISUAL_STYLE_STORAGE_KEY = 'tintin.visualStyle'
const FONT_WEIGHT_STORAGE_KEY = 'tintin.fontWeight'
const DARK_CLASS = 'dark'
const GLASS_CLASS = 'glass-mode'

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

/**
 * 字体粗细持久化：与主题模式同口径（IPC → localStorage）
 */
function readFontWeightStorage(): FontWeightLevel | null {
  const w = window as any
  if (w?.tintin?.config?.get) {
    try {
      const v = w.tintin.config.get('fontWeight')
      if (v === 'regular' || v === 'medium' || v === 'semibold') return v
    } catch (_) { /* ignore */ }
  }
  if (typeof localStorage !== 'undefined') {
    const v = localStorage.getItem(FONT_WEIGHT_STORAGE_KEY)
    if (v === 'regular' || v === 'medium' || v === 'semibold') return v
  }
  return null
}

function writeFontWeightStorage(level: FontWeightLevel) {
  const w = window as any
  let ipcOk = false
  if (w?.tintin?.config?.set) {
    try {
      w.tintin.config.set('fontWeight', level)
      ipcOk = true
    } catch (_) { /* ignore */ }
  }
  if (!ipcOk && typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(FONT_WEIGHT_STORAGE_KEY, level)
    } catch (_) { /* ignore */ }
  }
}

/**
 * 界面风格持久化：与主题模式同口径
 */
function readVisualStyleStorage(): VisualStyle | null {
  const w = window as any
  if (w?.tintin?.config?.get) {
    try {
      const v = w.tintin.config.get('visualStyle')
      if (v === 'standard' || v === 'glass') return v
    } catch (_) { /* ignore */ }
  }
  if (typeof localStorage !== 'undefined') {
    const v = localStorage.getItem(VISUAL_STYLE_STORAGE_KEY)
    if (v === 'standard' || v === 'glass') return v
  }
  return null
}

function writeVisualStyleStorage(style: VisualStyle) {
  const w = window as any
  let ipcOk = false
  if (w?.tintin?.config?.set) {
    try {
      w.tintin.config.set('visualStyle', style)
      ipcOk = true
    } catch (_) { /* ignore */ }
  }
  if (!ipcOk && typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(VISUAL_STYLE_STORAGE_KEY, style)
    } catch (_) { /* ignore */ }
  }
}

/** 将字体粗细档位应用到 DOM（覆盖 CSS 自定义属性） */
function applyFontWeightToDom(level: FontWeightLevel) {
  if (typeof document === 'undefined') return
  const w = FONT_WEIGHT_MAP[level]
  const root = document.documentElement.style
  // body / lead / caption / regular / mono：基础字重
  root.setProperty('--font-weight-body',    String(w.body))
  root.setProperty('--font-weight-lead',    String(w.body))
  root.setProperty('--font-weight-caption', String(w.body))
  root.setProperty('--font-weight-regular', String(w.body))
  root.setProperty('--font-weight-mono',    String(w.body))
  // medium / semibold：显式映射
  root.setProperty('--font-weight-medium',  String(w.medium))
  root.setProperty('--font-weight-semibold', String(w.semibold))
}

function setHtmlDarkClass(enable: boolean) {
  if (typeof document === 'undefined') return
  const html = document.documentElement
  if (enable) html.classList.add(DARK_CLASS)
  else html.classList.remove(DARK_CLASS)
}

function setHtmlGlassClass(enable: boolean) {
  if (typeof document === 'undefined') return
  const html = document.documentElement
  if (enable) html.classList.add(GLASS_CLASS)
  else html.classList.remove(GLASS_CLASS)
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

  // 产品文案创作 → 分镜脚本创作 的跨卡草案信号（对齐 pendingHotspotNav 模式）：
  // OtProductCopywriting.goToStoryboard 写入，OtStoryboard 挂载时消费并清空
  const pendingStoryboard = ref<{ copyText: string; product: Record<string, string> } | null>(null)

  /** 写入分镜草案（文案创作卡 → 分镜脚本卡） */
  function setPendingStoryboard(draft: { copyText: string; product: Record<string, string> }): void {
    pendingStoryboard.value = draft
  }

  /** 消费并清空分镜草案（一次性信号） */
  function takePendingStoryboard(): { copyText: string; product: Record<string, string> } | null {
    const d = pendingStoryboard.value
    pendingStoryboard.value = null
    return d
  }

  // 客户端版本号，由 main 进程注入
  const version = ref<string>('3.0.0')

  // 工作台侧边栏是否折叠
  const sidebarCollapsed = ref<boolean>(false)

  // 外观主题：light / dark / system，默认 system（亮色优先跟随系统）
  const themeMode = ref<ThemeMode>('system')

  // 字体粗细：regular(400) / medium(500, 默认) / semibold(600)
  const fontWeight = ref<FontWeightLevel>('medium')

  // 界面风格：standard(默认) / glass（玻璃质感，macOS 风格）
  const visualStyle = ref<VisualStyle>('standard')

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

  /** 字体粗细可读描述 */
  const fontWeightLabel = computed(() => {
    const labels: Record<FontWeightLevel, string> = {
      regular:  '常规（400，系统默认）',
      medium:   '中等（500，推荐）',
      semibold: '半粗（600，更清晰）',
    }
    return labels[fontWeight.value]
  })

  /** 界面风格可读描述 */
  const visualStyleLabel = computed(() => {
    const labels: Record<VisualStyle, string> = {
      standard: '标准风格（实色卡片，简洁清爽）',
      glass:    '玻璃质感（半透明毛玻璃，macOS 风格）',
    }
    return labels[visualStyle.value]
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

  /** 切换字体粗细（对外 API） */
  function setFontWeight(level: FontWeightLevel) {
    if (fontWeight.value === level) return
    fontWeight.value = level
    writeFontWeightStorage(level)
    applyFontWeightToDom(level)
  }

  /** 启动初始化：读持久化 + 首次应用 */
  function initFontWeight() {
    const stored = readFontWeightStorage()
    if (stored) fontWeight.value = stored
    applyFontWeightToDom(fontWeight.value)
  }

  /** 切换界面风格（对外 API） */
  function setVisualStyle(style: VisualStyle) {
    if (visualStyle.value === style) return
    visualStyle.value = style
    writeVisualStyleStorage(style)
    setHtmlGlassClass(style === 'glass')
  }

  /** 启动初始化：读持久化 + 首次应用 */
  function initVisualStyle() {
    const stored = readVisualStyleStorage()
    if (stored) visualStyle.value = stored
    setHtmlGlassClass(visualStyle.value === 'glass')
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
    pendingStoryboard,
    setPendingStoryboard,
    takePendingStoryboard,
    version,
    sidebarCollapsed,
    themeMode,
    resolvedTheme,
    themeModeLabel,
    fontWeight,
    fontWeightLabel,
    visualStyle,
    visualStyleLabel,
    setActiveTab,
    setVersion,
    toggleSidebar,
    setThemeMode,
    setFontWeight,
    setVisualStyle,
    initTheme,
    initFontWeight,
    initVisualStyle,
  }
})
