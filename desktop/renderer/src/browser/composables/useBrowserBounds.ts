// ═══════════════════════════════════════════════════════════════
// useBrowserBounds — Browser.vue BrowserView 边界/多端适配域 composable（D2 搬迁）
// 来源：views/Browser.vue 原 script setup 以下区段整体搬移（行为不变）：
//   · L779-914  P1.5 bounds 4 源重算 + Cherry Studio 实时校验闭环
//   · L916-954  多端适配断点 + 抽屉/滑出面板浮层状态
//   · L956-1001 已装扩展 / 浏览器设置独立原生窗口（工具栏锚点定位）
//   · L1003-1009 watch(overlayActive)（留在定义状态的 composable 内）
//   · L1178-1216 bounds 看门狗（_startBoundsWatchdog）
//
// 跨域接线约定：依赖 nav 域的 isElectronShell / getActivePlatformId /
//   platforms，由 Browser.vue 容器以参数显式传入；nav ↔ bounds 循环依赖由
//   navWiring 晚绑定对象解决（见 useBrowserNav.ts 头注释）。
// 生命周期：disposeBounds() 收拢原 onBeforeUnmount 中本域的清理语句，
//   由容器卸载编排按原有顺序调用。
// D2 解耦：所有 IPC 调用由 window.tintin → window.tintinBrowser（browser-preload.js）
// ═══════════════════════════════════════════════════════════════

import { computed, nextTick, ref, watch } from 'vue'
import type { ComputedRef, Ref } from 'vue'
import type { BrowserPlatformId, PlatformTab } from './useBrowserNav'

/** 与 desktop/types/global.d.ts 内 declare interface 字面一致（模块内声明不可直接引用） */
export interface BrowserBoundsVerifyReport {
  platformId: string
  /** 是否 attach 在主窗口 getBrowserViews() 内 */
  attached: boolean
  /** 是否在窗口可见范围内（排除负值/越界） */
  visible: boolean
  actual: { x: number; y: number; width: number; height: number }
  expected?: { x: number; y: number; width: number; height: number }
  /** 最大边差，单位 px */
  deltaPx?: number
  tolerancePx: number
  /** 是否在容忍阈值内（<= 3px 算 OK） */
  withinTolerance?: boolean
  /** 主窗口尺寸（用于越界诊断） */
  winSize: { width: number; height: number }
  ts: number
}

export interface UseBrowserBoundsDeps {
  isElectronShell: Ref<boolean>
  getActivePlatformId: () => string | null
  /** 左栏平台数组（设置面板平台列表构建用） */
  platforms: Ref<PlatformTab[]>
}

export type BoundsStatus = 'unknown' | 'ok' | 'nomatch' | 'verifying'

export interface UseBrowserBoundsReturn {
  hostRef: Ref<HTMLElement | null>
  boundsStatus: Ref<BoundsStatus>
  lastBoundsReport: Ref<BrowserBoundsVerifyReport | null>
  forceRecalcBounds: () => void
  scheduleRecalcBounds: () => void
  isNarrow: Ref<boolean>
  rightDocked: Ref<boolean>
  leftDrawerOpen: Ref<boolean>
  rightPanelOpen: Ref<boolean>
  overlayActive: ComputedRef<boolean>
  backdropVisible: ComputedRef<boolean>
  toggleLeftDrawer: () => void
  toggleRightPanel: () => void
  closeOverlays: () => void
  openExtensionsPanel: () => void
  buildSettingsPlatforms: () => { id: string; name: string; badge: string }[]
  openBrowserSettings: () => void
  goSettings: () => void
  /** 原 onMounted 断点监听段整句收拢（由容器在挂载编排中调用，时机一致） */
  setupMqWatchers: () => void
  _onWindowResize: () => void
  _startBoundsWatchdog: () => void
  disposeBounds: () => void
}

export function useBrowserBounds(deps: UseBrowserBoundsDeps): UseBrowserBoundsReturn {
const { isElectronShell, getActivePlatformId, platforms } = deps

const hostRef = ref<HTMLElement | null>(null)
let _boundsTimer: ReturnType<typeof setTimeout> | null = null
/** 主动校验定时：1.5s 后、之后每 8s 做一次轻量 verifyBounds（检测误挂/窗口越界） */
let _boundsWatchdogTimer: ReturnType<typeof setInterval> | null = null
/** 1.5s 后的首次主动校验定时器（setTimeout） */
let _firstVerifyTimer: ReturnType<typeof setTimeout> | null = null

/** bounds 校验徽标状态：
 *   unknown   尚未 verify（非壳/页面刚打开）
 *   ok        最近一次 verify：withinTolerance=true 且 visible=true
 *   nomatch   最近一次 verify：差异 >3px 或 不可见/未挂载
 *   verifying 正在 verify（防重复）
 */
const boundsStatus = ref<BoundsStatus>('unknown')
/** 最近一次 bounds verify 报告（用于调试 hover tip） */
const lastBoundsReport = ref<BrowserBoundsVerifyReport | null>(null)
/** NOMATCH 连续次数：≥ 2 自动走主进程报告 */
let _nomatchCount = 0
/** 连续 NOMATCH 阈值（超过就调用 verifyBounds 做诊断并保留 nomatch 徽标） */
const NOMATCH_RETRY_MAX = 1

/** 强制不 debounce 的 bounds 重算（onViewReady 之后用，防止布局跳动之后 BrowserView 留在旧坐标） */
function forceRecalcBounds(): void {
  if (!isElectronShell.value) return
  if (_boundsTimer) { clearTimeout(_boundsTimer); _boundsTimer = null }
  void _doRecalcBounds(true)
}

function scheduleRecalcBounds(): void {
  if (!isElectronShell.value) return
  if (_boundsTimer) clearTimeout(_boundsTimer)
  // C13 200ms debounce：4 源（mount/平台切换/resize/侧栏）都走这里合并
  _boundsTimer = setTimeout(() => {
    _boundsTimer = null
    void _doRecalcBounds(false)
  }, 200)
}

/** 记录一次 bounds 状态（含徽标切换） */
function _setBoundsStatus(
  s: BoundsStatus,
  report?: BrowserBoundsVerifyReport | null,
): void {
  boundsStatus.value = s
  if (report) lastBoundsReport.value = report
}

async function _doRecalcBounds(forceVerify: boolean): Promise<void> {
  const cur = getActivePlatformId()
  if (!cur) return
  const host = hostRef.value
  if (!host) return
    try {
      const rect = host.getBoundingClientRect()
      if (rect.width < 100 || rect.height < 100) return  // 尚未 layout
      const t = (window as any).tintinBrowser
      if (!t?.browser?.setBounds) return
      const expected = {
        platformId: cur,
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      }

    _setBoundsStatus('verifying')
    const r = await t.browser.setBounds(expected)
    if (r?.success && r?.verify) {
      // 主进程 setBounds 闭环校验：withinTolerance=true 且 visible=true 才算 OK
      //   setBounds 返回的 verify 没有 visible（需要再调用 verifyBounds 拿 visible）
      //   简化：先按 withinTolerance 预断，再调用 verifyBounds 确诊（2 次 nomatch 才降级）
      if (r.verify.withinTolerance) {
        // 期望 vs 实际 OK → 轻量：更新 ok 徽标，nomatch 清零
        _nomatchCount = 0
        _setBoundsStatus('ok')
        // 每 4 次 ok 做一次主动 verifyBounds（防止挂错窗口/隐藏到窗口外的情况）
        if (forceVerify || Math.random() < 0.25) {
          void _runVerifyBounds(expected, cur)
        }
      } else {
        // setBounds 结果超出阈值 → 再调一次 verifyBounds（确诊可见性/真实差异）
        _nomatchCount++
        if (_nomatchCount > NOMATCH_RETRY_MAX) {
          _setBoundsStatus('nomatch')
        }
        void _runVerifyBounds(expected, cur).then((report) => {
          if (!report) return
          if (report.visible && report.withinTolerance) {
            _nomatchCount = 0
            _setBoundsStatus('ok', report)
            return
          }
          _setBoundsStatus('nomatch', report)
          // NOMATCH 再重算一次（下一帧），防止 DPI 延迟
          requestAnimationFrame(() => scheduleRecalcBounds())
        })
      }
    } else {
      // 老版本 / 纯浏览器模式：verify 缺失 → 走 verifyBounds 单独拉一次
      if (forceVerify) void _runVerifyBounds(expected, cur)
    }
  } catch (e) {
    console.warn('[Browser] _doRecalcBounds failed:', e)
  }
}

/** Cherry Studio 主动校验：渲染端期望 vs 主进程实际。返回 report；失败置 nomatch
 *  （platformId 实参来自 getActivePlatformId(): string|null 的非空收窄，故含 string 宽容位） */
async function _runVerifyBounds(
  expected: { x: number; y: number; width: number; height: number },
  platformId: BrowserPlatformId | string,
): Promise<BrowserBoundsVerifyReport | null> {
  const t = (window as any).tintinBrowser
  if (!t?.browser?.verifyBounds) return null
  try {
    const r = await t.browser.verifyBounds({ platformId, expected })
    if (r?.success && r?.data) {
      const report = r.data as BrowserBoundsVerifyReport
      if (report.visible && (report.withinTolerance ?? true)) {
        _nomatchCount = 0
        _setBoundsStatus('ok', report)
      } else {
        _setBoundsStatus('nomatch', report)
      }
      return report
    }
    return null
  } catch (e) {
    console.warn('[Browser] verifyBounds failed:', e)
    return null
  }
}

/* ── window resize：③ 号源 bounds 重算 ── */
function _onWindowResize(): void { scheduleRecalcBounds() }

/* ════════════════════════════════════════════════════════════
   多端适配：断点状态 + 抽屉/滑出面板
     · isNarrow   < 900px：左栏抽屉化（汉堡按钮）
     · rightDocked ≥ 1200px：右栏静态停靠；否则收纳为下载按钮唤出的面板
   壳模式下浮层打开时 BrowserView 置零边界（防原生层盖住浮层），
   浮层关闭后重算恢复。
   ════════════════════════════════════════════════════════════ */
const isNarrow = ref(false)
const rightDocked = ref(true)
const leftDrawerOpen = ref(false)
const rightPanelOpen = ref(true)
let _mqNarrow: MediaQueryList | null = null
let _mqDocked: MediaQueryList | null = null

function _onMqNarrow(e: MediaQueryListEvent): void {
  isNarrow.value = e.matches
  if (!e.matches) leftDrawerOpen.value = false
}
function _onMqDocked(e: MediaQueryListEvent): void {
  rightDocked.value = e.matches
  if (e.matches) rightPanelOpen.value = false
}

/** 浮层（抽屉/侧栏）是否处于打开态且覆盖宿主区域（扩展/设置面板已改为独立原生窗口，不属此处） */
const overlayActive = computed<boolean>(() =>
  (leftDrawerOpen.value && isNarrow.value) ||
  (rightPanelOpen.value && !rightDocked.value),
)
const backdropVisible = computed<boolean>(() => overlayActive.value)

function toggleLeftDrawer(): void { leftDrawerOpen.value = !leftDrawerOpen.value }
function toggleRightPanel(): void {
  if (rightDocked.value) return  // 宽屏右栏常驻，无需切换
  rightPanelOpen.value = !rightPanelOpen.value
}
function closeOverlays(): void {
  leftDrawerOpen.value = false
  rightPanelOpen.value = false
}

/* ── 已安装扩展列表面板：独立原生窗口（BrowserWindow，始终在 BrowserView 之上） ── */
/** 计算工具栏按钮锚点坐标（相对本窗口渲染区），并换算为屏幕绝对坐标
 *  （__WINDOW_BOUNDS__ 由主进程注入；未注入时按 0 偏移），供原生面板定位 */
function _toolbarAnchor(btn: Element | null): { x: number; y: number } {
  let x = 100, y = 60
  if (btn) {
    const rect = btn.getBoundingClientRect()
    x = Math.round(rect.left)
    y = Math.round(rect.bottom + 6)
  }
  const winBounds = (window as any).__WINDOW_BOUNDS__
  if (winBounds) {
    x += winBounds.x || 0
    y += winBounds.y || 0
  }
  return { x, y }
}
function openExtensionsPanel(): void {
  const t = (window as any).tintinBrowser
  if (!isElectronShell.value || !t?.browser?.openExtensionsPanel) return
  const btn = document.querySelector('.right-actions > .ext-panel-wrapper button')
  const a = _toolbarAnchor(btn)
  t.browser.openExtensionsPanel(a.x, a.y)
}

/* ── 浏览器设置面板（Cookie/登录）：独立原生窗口（BrowserWindow，始终在 BrowserView 之上） ── */
function buildSettingsPlatforms(): { id: string; name: string; badge: string }[] {
  return [
    { id: 'web', name: '网页浏览器', badge: '🌐' },
    ...platforms.value.map((p) => ({ id: p.id as string, name: p.name, badge: p.badge })),
  ]
}
function openBrowserSettings(): void {
  const t = (window as any).tintinBrowser
  if (!isElectronShell.value || !t?.browser?.openSettingsPanel) return
  const btn = document.querySelector('.right-actions > button.ic-btn')
  const a = _toolbarAnchor(btn)
  t.browser.openSettingsPanel(a.x, a.y, { list: buildSettingsPlatforms() })
}

function goSettings(): void { openBrowserSettings() }

/** 壳模式浮层打开 → BrowserView 置零；关闭 → 重算恢复 */
async function _collapseBounds(): Promise<void> {
  const cur = getActivePlatformId()
  if (!cur) return
  const t = (window as any).tintinBrowser
  if (!t?.browser?.setBounds) return
  try {
    await t.browser.setBounds({ platformId: cur, x: 0, y: 0, width: 0, height: 0 })
  } catch (_) {}
}

watch(overlayActive, (v) => {
  if (!isElectronShell.value) return
  void nextTick().then(() => {
    if (v) void _collapseBounds()
    else scheduleRecalcBounds()
  })
})

/* ── 多端适配断点监听（原 onMounted 段整句搬移，调用时机由容器保持） ── */
function setupMqWatchers(): void {
  if (typeof window.matchMedia === 'function') {
    _mqNarrow = window.matchMedia('(max-width: 899px)')
    _mqDocked = window.matchMedia('(min-width: 1200px)')
    isNarrow.value = _mqNarrow.matches
    rightDocked.value = _mqDocked.matches
    _mqNarrow.addEventListener('change', _onMqNarrow)
    _mqDocked.addEventListener('change', _onMqDocked)
  }
}

/** 启动 bounds 看门狗：1500ms 首次 verifyBounds，之后每 8s 一次轻量 verifyBounds（不重算 DOM，只核已 attach+visible） */
function _startBoundsWatchdog(): void {
  if (!isElectronShell.value) return
  if (_firstVerifyTimer) { clearTimeout(_firstVerifyTimer); _firstVerifyTimer = null }
  if (_boundsWatchdogTimer) { clearInterval(_boundsWatchdogTimer); _boundsWatchdogTimer = null }
  _firstVerifyTimer = setTimeout(async () => {
    const cur = getActivePlatformId()
    if (!cur) return
    const host = hostRef.value
    if (!host) return
    const rect = host.getBoundingClientRect()
    if (rect.width < 100 || rect.height < 100) return
    const expected = {
      x: Math.round(rect.left), y: Math.round(rect.top),
      width: Math.round(rect.width), height: Math.round(rect.height),
    }
    await _runVerifyBounds(expected, cur)
  }, 1500)
  _boundsWatchdogTimer = setInterval(async () => {
    const cur = getActivePlatformId()
    if (!cur) return
    // 8s 一次：只在未 attach / nomatch / verifying 之外的"看似 OK"场景触发，
    // 主要兜底 BrowserView 挂错窗口 / 被 remove 了但渲染端不知道（经验 478486：悬挂引用）
    if (boundsStatus.value === 'verifying') return
    const host = hostRef.value
    if (!host) return
    const rect = host.getBoundingClientRect()
    if (rect.width < 100 || rect.height < 100) return
    const expected = {
      x: Math.round(rect.left), y: Math.round(rect.top),
      width: Math.round(rect.width), height: Math.round(rect.height),
    }
    const report = await _runVerifyBounds(expected, cur)
    // 看门狗触发了 NOMATCH → 再发起一次重算（主动纠偏）
    if (report && !report.visible) {
      scheduleRecalcBounds()
    }
  }, 8000)
}

/* ── 卸载清理（原 onBeforeUnmount 中本域语句整组收拢，行为一致） ── */
function disposeBounds(): void {
  if (_boundsTimer) { clearTimeout(_boundsTimer); _boundsTimer = null }
  if (_firstVerifyTimer) { clearTimeout(_firstVerifyTimer); _firstVerifyTimer = null }
  if (_boundsWatchdogTimer) { clearInterval(_boundsWatchdogTimer); _boundsWatchdogTimer = null }
  window.removeEventListener('resize', _onWindowResize)
  if (_mqNarrow) { _mqNarrow.removeEventListener('change', _onMqNarrow); _mqNarrow = null }
  if (_mqDocked) { _mqDocked.removeEventListener('change', _onMqDocked); _mqDocked = null }
}

return {
  hostRef, boundsStatus, lastBoundsReport,
  forceRecalcBounds, scheduleRecalcBounds,
  isNarrow, rightDocked, leftDrawerOpen, rightPanelOpen,
  overlayActive, backdropVisible,
  toggleLeftDrawer, toggleRightPanel, closeOverlays,
  openExtensionsPanel, buildSettingsPlatforms, openBrowserSettings, goSettings,
  setupMqWatchers, _onWindowResize, _startBoundsWatchdog, disposeBounds,
}
}
