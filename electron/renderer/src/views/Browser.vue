<script setup lang="ts">
// ═══════════════════════════════════════════════════════════════
// Browser.vue — 浏览器（P1.5 厚壳化：BrowserView 真嵌入 + C5/C6/C13 bounds 重算）
//
// 核心改动：
//   · mock-device 占位 → browser-view-host 容器
//   · 5 平台 Tab：切换时调用 browser:attachPlatform（partition 隔离）
//   · 4 源 bounds 重算（C13 200ms debounce）：
//     ① onMounted  ② selectPlatform  ③ window resize  ④ C9 门控（App.vue）后重算
//   · 导航：后退/前进/刷新/Enter 跳页 → browser:navigate
//   · URL 更新订阅：did-navigate → 回填地址栏 + 🔒 胶囊状态
//   · 下载更新订阅：will-download → 侧栏下载卡片实时刷新
//   · C6 切 Tab / onBeforeUnmount：detachAll 防止原生层级泄漏
// ═══════════════════════════════════════════════════════════════

import { ref, computed, onMounted, onBeforeUnmount, reactive, nextTick, watch, type Ref } from 'vue'
import { useRouter } from 'vue-router'
import { useAppStore, type BrowserExtractPayload } from '@/stores/app'
import type { BrowserPlatformId, BrowserBoundsVerifyReport } from '../../../../types/global'

/* ── 壳检测（C9 门控）：Electron = true，纯 Vite 浏览器 = false，走降级 mock ────── */
const isElectronShell = ref(false)
function _detectShell(): void {
  const t = (window as any).tintin
  isElectronShell.value = !!(t && t.browser && typeof t.browser.attachPlatform === 'function')
}
_detectShell()

const appStore = useAppStore()
const router = useRouter()

/* ── 地址栏交互 + 导航按钮 ──────────────────────────────────────────── */
const addressUrl = ref<string>('https://www.douyin.com/user/jbl_official')
const navCan = reactive({ back: false, forward: false })

async function onUrlEnter(): Promise<void> {
  const u = addressUrl.value.trim()
  if (!u) return
  if (!isElectronShell.value) return  // 非壳模式不跳
  const cur = currentPlatform.value
  if (!cur) return
  try {
    const r = await (window as any).tintin.browser.navigate({ platformId: cur, url: u })
    if (r?.success && r?.data) {
      navCan.back = !!r.data.canGoBack
      navCan.forward = !!r.data.canGoForward
    }
  } catch (_) {}
}
async function navBack(): Promise<void> {
  const cur = currentPlatform.value
  if (!cur || !isElectronShell.value) return
  try {
    const r = await (window as any).tintin.browser.navigate({ platformId: cur, back: true })
    if (r?.success && r?.data) { navCan.back = !!r.data.canGoBack; navCan.forward = !!r.data.canGoForward }
  } catch (_) {}
}
async function navForward(): Promise<void> {
  const cur = currentPlatform.value
  if (!cur || !isElectronShell.value) return
  try {
    const r = await (window as any).tintin.browser.navigate({ platformId: cur, forward: true })
    if (r?.success && r?.data) { navCan.back = !!r.data.canGoBack; navCan.forward = !!r.data.canGoForward }
  } catch (_) {}
}
async function navReload(): Promise<void> {
  const cur = currentPlatform.value
  if (!cur || !isElectronShell.value) return
  try { await (window as any).tintin.browser.navigate({ platformId: cur, reload: true }) } catch (_) {}
}

/* ── 平台 Tab ───────────────────────────────────────────── */
interface PlatformTab {
  id: BrowserPlatformId
  name: string
  emoji: string
  active?: boolean
}

const platforms = ref<PlatformTab[]>([
  { id: 'douyin',      name: '抖音',   emoji: '🎵', active: true },
  { id: 'weixin',      name: '视频号', emoji: '💚' },
  { id: 'kuaishou',    name: '快手',   emoji: '⚡' },
  { id: 'xiaohongshu', name: '小红书', emoji: '📕' },
  { id: 'bilibili',    name: 'B站',    emoji: '📺' }
])

const currentPlatform = computed<BrowserPlatformId | null>(() => {
  const p = platforms.value.find((x) => x.active)
  return p ? p.id : null
})

/** bounds 徽标显示文本 */
const boundsBadgeLabel = computed<string>(() => {
  switch (boundsStatus.value) {
    case 'ok': return 'OK'
    case 'nomatch': return 'NOMATCH'
    case 'verifying': return '…'
    default: return '—'
  }
})

/** bounds 徽标 tooltip（含诊断详情） */
const boundsBadgeTip = computed<string>(() => {
  const r = lastBoundsReport.value
  if (!r) {
    if (boundsStatus.value === 'ok') return 'BrowserView 已正确挂载（通过闭环校验）。点击立即重算。'
    if (boundsStatus.value === 'nomatch') return 'BrowserView 挂载坐标与宿主 DOM 不匹配。点击立即重算。'
    if (boundsStatus.value === 'verifying') return '正在校验 BrowserView 真实 bounds…'
    return '尚未校验。点击立即重算。'
  }
  const lines: string[] = []
  lines.push(`平台: ${r.platformId}`)
  lines.push(`状态: ${r.attached ? (r.visible ? '已挂载并可见' : '已挂载但越界/不可见') : '未挂载'}`)
  lines.push(`期望: (${r.expected?.x ?? '-'},${r.expected?.y ?? '-'}) ${r.expected?.width ?? '-'}×${r.expected?.height ?? '-'}`)
  lines.push(`实际: (${r.actual.x},${r.actual.y}) ${r.actual.width}×${r.actual.height}`)
  if (typeof r.deltaPx === 'number') lines.push(`最大边差: ${r.deltaPx}px（阈值 ≤${r.tolerancePx}px）`)
  lines.push(`主窗口: ${r.winSize.width}×${r.winSize.height}`)
  lines.push('点击徽标 → 立即重算+校验')
  return lines.join('\n')
})

async function selectPlatform(id: string): Promise<void> {
  const pid = id as BrowserPlatformId
  platforms.value.forEach((p) => (p.active = p.id === pid))

  // 非壳模式：直接更新地址栏为 seed URL
  if (!isElectronShell.value) {
    const seed: Record<BrowserPlatformId, string> = {
      douyin: 'https://www.douyin.com',
      weixin: 'https://channels.weixin.qq.com',
      kuaishou: 'https://www.kuaishou.com',
      xiaohongshu: 'https://www.xiaohongshu.com',
      bilibili: 'https://www.bilibili.com',
    }
    addressUrl.value = seed[pid] || 'about:blank'
    return
  }

  // 壳模式：attachPlatform → 拿到当前 URL/导航能力 → 重算 bounds
  try {
    const t = (window as any).tintin
    const r = await t.browser.attachPlatform(pid)
    if (r?.success && r?.data) {
      addressUrl.value = r.data.currentUrl || addressUrl.value
      navCan.back = !!r.data.canGoBack
      navCan.forward = !!r.data.canGoForward
    }
    // ② 平台切换后：C13 200ms debounce 重算 bounds
    await nextTick()
    scheduleRecalcBounds()
  } catch (e) {
    console.warn('[Browser] attachPlatform failed:', e)
  }
}

/* ── 浏览历史（侧栏左） ─────────────────────────────────── */
interface HistoryItem {
  id: string
  title: string
  url: string
  time: string
  group: 'today' | 'yesterday'
}

const historyItems = ref<HistoryItem[]>([
  { id: 'h1', title: 'JBL 官方旗舰店',        url: 'douyin.com/shop/jbl',       time: '14:23', group: 'today' },
  { id: 'h2', title: 'CHARGE6 商品详情页',    url: 'douyin.com/item/72xxx',     time: '13:58', group: 'today' },
  { id: 'h3', title: 'JBL 直播间 · 618专场', url: 'live.douyin.com/8291',      time: '11:02', group: 'today' },
  { id: 'h4', title: 'BOSE 官方账号',         url: 'douyin.com/user/bose',      time: '昨天',   group: 'yesterday' },
  { id: 'h5', title: '索尼 SRS 系列对比',     url: 'kuaishou.com/u/sony',       time: '昨天',   group: 'yesterday' }
])

function historyByGroup(g: HistoryItem['group']) {
  return historyItems.value.filter((h) => h.group === g)
}

async function visitHistory(item: HistoryItem): Promise<void> {
  const u = 'https://' + item.url
  addressUrl.value = u
  if (!isElectronShell.value) return
  const cur = currentPlatform.value
  if (!cur) return
  try {
    await (window as any).tintin.browser.navigate({ platformId: cur, url: u })
  } catch (_) {}
}

/* ── 下载管理（侧栏左底部卡片）：will-download 实时推送 ────────────── */
interface DownloadItem {
  id: string
  title: string
  progress: number // 0-100
  status: 'downloading' | 'done' | 'queued'
  size?: string
}
const downloads = ref<DownloadItem[]>([
  { id: 'd1', title: 'JBL_CHARGE6_15s.mp4',    progress: 68, status: 'downloading', size: '128MB' },
  { id: 'd2', title: 'COVER_MAIN_V1.png',      progress: 100, status: 'done',        size: '3.4MB' },
  { id: 'd3', title: 'LIVE_CLIP_21.mp4',       progress: 0,   status: 'queued' }
])
/** 字节 → 人类可读大小（粗估） */
function _fmtBytes(b?: number): string {
  if (!b) return ''
  if (b < 1024) return b + 'B'
  if (b < 1024 * 1024) return (b / 1024).toFixed(0) + 'KB'
  if (b < 1024 * 1024 * 1024) return (b / (1024 * 1024)).toFixed(1) + 'MB'
  return (b / (1024 * 1024 * 1024)).toFixed(2) + 'GB'
}

/* ── 解析并导入（调用 browser:extractDOM → 成功后推到工作台会话） ─────── */
const extracting = ref(false)
async function onExtract(): Promise<void> {
  const cur = currentPlatform.value
  if (!cur || !isElectronShell.value) return
  extracting.value = true
  try {
    const r = await (window as any).tintin.browser.extractDOM(cur)
    console.log('[Browser] extractDOM result:', r)
    if (r?.success && r?.data) {
      // 构造跨页面载荷，写入 appStore 并切 Tab → 工作台 watch 后消费
      const platName = platforms.value.find((p) => p.id === cur)?.name || String(cur)
      const payload: BrowserExtractPayload = {
        platformId: cur,
        platformName: platName,
        extractedAt: Date.now(),
        data: r.data,
      }
      appStore.pushBrowserExtract(payload)
      // 切 Tab：C6 防泄漏（切工作台前先 detach）
      try {
        await (window as any).tintin?.browser?.detachAll?.()
      } catch (_) {}
      appStore.setActiveTab('workbench')
      await router.push('/workbench')
    } else if (r?.ok === false) {
      // 结构化错误：NEED_LOGIN / RISK_CAPTCHA / DOM_MISMATCH / NETWORK_ERROR
      const errType = r?.error?.type || 'EXTRACTOR_ERROR'
      const errMsg = r?.error?.message || '抽取失败'
      console.warn(`[Browser] extractDOM ${errType}:`, errMsg, r?.error?.hint)
    }
  } catch (e) {
    console.warn('[Browser] extractDOM failed:', e)
  } finally {
    extracting.value = false
  }
}

/* ══════════════════════════════════════════════════════════
   P1.5 bounds 4源重算 + Cherry Studio 实时校验闭环（attach/setBounds/verify → 2 次 NOMATCH 自动重试）
   BrowserView 宿主节点：#browser-view-host（.browser-view-host）
   使用 getBoundingClientRect 获取 DOMRect → browser:setBounds
   ══════════════════════════════════════════════════════════ */
const hostRef = ref<HTMLElement | null>(null)
let _boundsTimer: ReturnType<typeof setTimeout> | null = null

/** bounds 校验徽标状态：
 *   unknown   尚未 verify（非壳/页面刚打开）
 *   ok        最近一次 verify：withinTolerance=true 且 visible=true
 *   nomatch   最近一次 verify：差异 >3px 或 不可见/未挂载
 *   verifying 正在 verify（防重复）
 */
type BoundsStatus = 'unknown' | 'ok' | 'nomatch' | 'verifying'
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
  const cur = currentPlatform.value
  if (!cur) return
  const host = hostRef.value
  if (!host) return
  try {
    const rect = host.getBoundingClientRect()
    if (rect.width < 100 || rect.height < 100) return  // 尚未 layout
    const t = (window as any).tintin
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

/** Cherry Studio 主动校验：渲染端期望 vs 主进程实际。返回 report；失败置 nomatch */
async function _runVerifyBounds(
  expected: { x: number; y: number; width: number; height: number },
  platformId: BrowserPlatformId,
): Promise<BrowserBoundsVerifyReport | null> {
  const t = (window as any).tintin
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

/* ── 订阅：URL 更新（did-navigate）+ 下载推送（will-download）+ Cherry Studio view-ready（did-stop-loading） ──── */
let _unsubUrl: (() => void) | null = null
let _unsubDownloads: (() => void) | null = null
let _unsubViewReady: (() => void) | null = null
let _onAppWindowStateChange: (() => void) | null = null
/** 主动校验定时：1.5s 后、之后每 8s 做一次轻量 verifyBounds（检测误挂/窗口越界） */
let _boundsWatchdogTimer: ReturnType<typeof setInterval> | null = null
/** 1.5s 后的首次主动校验定时器（setTimeout） */
let _firstVerifyTimer: ReturnType<typeof setTimeout> | null = null

function _subscribeEvents(): void {
  if (!isElectronShell.value) return
  const t = (window as any).tintin
  try {
    if (typeof t.browser.onUrlUpdated === 'function') {
      _unsubUrl = t.browser.onUrlUpdated((payload: any) => {
        if (payload?.platformId === currentPlatform.value && payload?.url) {
          addressUrl.value = payload.url
        }
      })
    }
    if (typeof t.browser.onDownloadsUpdated === 'function') {
      _unsubDownloads = t.browser.onDownloadsUpdated((payload: any) => {
        if (!payload?.filename) return
        // 下载事件 → 侧栏卡片实时刷新（简化：若存在同名则更新，否则新增 downloading）
        const name = String(payload.filename)
        let item = downloads.value.find((d) => d.title === name)
        if (!item) {
          item = { id: 'dl-' + Date.now(), title: name, progress: 0, status: 'downloading', size: _fmtBytes(payload.size) }
          downloads.value.unshift(item)
        }
        if (payload.kind === 'done' || payload.kind === 'completed') {
          item.progress = 100
          item.status = 'done'
          if (payload.savePath) item.size = _fmtBytes(payload.totalBytes)
        } else if (payload.kind === 'cancelled' || payload.kind === 'interrupted') {
          item.status = 'queued'
        } else if (typeof payload.percent === 'number') {
          item.progress = payload.percent
          item.status = 'downloading'
          if (payload.totalBytes) item.size = _fmtBytes(payload.totalBytes)
        }
      })
    }
    // Cherry Studio：BrowserView did-stop-loading → 强制不 debounce 重算，防止布局跳动后 BrowserView 留在旧坐标
    if (typeof t.browser.onViewReady === 'function') {
      _unsubViewReady = t.browser.onViewReady((payload: any) => {
        if (!payload?.platformId) return
        if (payload.platformId !== currentPlatform.value) return  // 其他 Tab 的事件忽略
        // 立刻 + 300ms 后各重算一次（首帧 Chromium 会补 1px 阴影/滚动条）
        forceRecalcBounds()
        setTimeout(() => forceRecalcBounds(), 300)
      })
    }
    // App.vue 广播：窗口最大化/还原/尺寸显著变化后，强制重算 bounds
    _onAppWindowStateChange = () => scheduleRecalcBounds()
    window.addEventListener('app:winstate-changed', _onAppWindowStateChange as EventListener, { passive: true })
  } catch (_) {}
}

/** 启动 bounds 看门狗：1500ms 首次 verifyBounds，之后每 8s 一次轻量 verifyBounds（不重算 DOM，只核已 attach+visible） */
function _startBoundsWatchdog(): void {
  if (!isElectronShell.value) return
  if (_firstVerifyTimer) { clearTimeout(_firstVerifyTimer); _firstVerifyTimer = null }
  if (_boundsWatchdogTimer) { clearInterval(_boundsWatchdogTimer); _boundsWatchdogTimer = null }
  _firstVerifyTimer = setTimeout(async () => {
    const cur = currentPlatform.value
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
    const cur = currentPlatform.value
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

/* ── 生命周期 ───────────────────────────────────────────── */
onMounted(async () => {
  // ① mount 后首次 bounds 重算（含 C9 判定）
  await nextTick()
  scheduleRecalcBounds()
  window.addEventListener('resize', _onWindowResize, { passive: true })
  _subscribeEvents()
  _startBoundsWatchdog()

  // 首个平台：自动 attach（仅壳模式）
  const cur = currentPlatform.value
  if (cur && isElectronShell.value) {
    try {
      const t = (window as any).tintin
      const r = await t.browser.attachPlatform(cur)
      if (r?.success && r?.data) {
        addressUrl.value = r.data.currentUrl || addressUrl.value
        navCan.back = !!r.data.canGoBack
        navCan.forward = !!r.data.canGoForward
      }
      scheduleRecalcBounds()
    } catch (_) {}
  }
})

onBeforeUnmount(() => {
  if (_boundsTimer) { clearTimeout(_boundsTimer); _boundsTimer = null }
  if (_firstVerifyTimer) { clearTimeout(_firstVerifyTimer); _firstVerifyTimer = null }
  if (_boundsWatchdogTimer) { clearInterval(_boundsWatchdogTimer); _boundsWatchdogTimer = null }
  window.removeEventListener('resize', _onWindowResize)
  if (_onAppWindowStateChange) {
    window.removeEventListener('app:winstate-changed', _onAppWindowStateChange as EventListener)
    _onAppWindowStateChange = null
  }
  if (_unsubUrl) { try { _unsubUrl() } catch(_){} _unsubUrl = null }
  if (_unsubDownloads) { try { _unsubDownloads() } catch(_){} _unsubDownloads = null }
  if (_unsubViewReady) { try { _unsubViewReady() } catch(_){} _unsubViewReady = null }
  // C6：卸载前 detachAll，防止 BrowserView 原生层泄漏到其他 Tab
  try {
    const t = (window as any).tintin
    if (t?.browser?.detachAll) t.browser.detachAll().catch(() => {})
  } catch (_) {}
})

// 当 currentPlatform 变化时：延迟重算 bounds（保证 DOM layout 完成）
watch(currentPlatform, () => { nextTick().then(scheduleRecalcBounds) })
</script>

<template>
  <section class="browser-page">
    <!-- ─── 顶部工具条 ─── -->
    <header class="browser-toolbar">
      <div class="nav-ic-group">
        <button
          class="ic-btn"
          :class="{ disabled: !navCan.back || !isElectronShell }"
          title="后退"
          @click="navBack"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </button>
        <button
          class="ic-btn"
          :class="{ disabled: !navCan.forward || !isElectronShell }"
          title="前进"
          @click="navForward"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M9 18l6-6-6-6" />
          </svg>
        </button>
        <button
          class="ic-btn"
          :class="{ disabled: !isElectronShell }"
          title="刷新"
          @click="navReload"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
            <path d="M21 3v5h-5" />
            <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
            <path d="M3 21v-5h5" />
          </svg>
        </button>
      </div>

      <div class="address-bar">
        <span class="lock-ic">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <rect x="3" y="11" width="18" height="11" rx="2" />
            <path d="M7 11V7a5 5 0 0 1 10 0v4" />
          </svg>
        </span>
        <input
          v-model="addressUrl"
          type="text"
          class="address-input"
          placeholder="输入网址或搜索"
          @keydown.enter="onUrlEnter"
        />
      </div>

      <div class="right-actions">
        <button
          class="btn-parse"
          :disabled="extracting || !isElectronShell"
          @click="onExtract"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
            <polyline points="7.5 4.21 12 6.81 16.5 4.21" />
            <polyline points="7.5 19.79 7.5 14.6 3 12" />
          </svg>
          {{ extracting ? '解析中…' : '解析并导入' }}
        </button>
        <button class="ic-btn" title="下载列表">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
          <span v-if="downloads.some((d) => d.status === 'downloading')" class="badge-dot" />
        </button>
        <button class="ic-btn" title="设置">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>
      </div>
    </header>

    <!-- ─── 主体：左栏 + 主区 ─── -->
    <div class="browser-body">
      <!-- 左侧 240px -->
      <aside class="browser-sidebar">
        <div class="side-scroll custom-scroll">
          <div class="side-section">
            <div class="section-title">浏览历史</div>
            <template v-for="g in (['today', 'yesterday'] as const)" :key="g">
              <template v-if="historyByGroup(g).length">
                <div class="group-label">{{ g === 'today' ? '今天' : '昨天' }}</div>
                <div
                  v-for="h in historyByGroup(g)"
                  :key="h.id"
                  class="hist-item"
                  @click="visitHistory(h)"
                >
                  <div class="hist-icon">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                      <circle cx="12" cy="12" r="10" />
                      <polyline points="12 6 12 12 16 14" />
                    </svg>
                  </div>
                  <div class="hist-text">
                    <div class="hist-title">{{ h.title }}</div>
                    <div class="hist-url">{{ h.url }}</div>
                  </div>
                  <span class="hist-time">{{ h.time }}</span>
                </div>
              </template>
            </template>
          </div>

          <!-- 下载管理卡片 -->
          <div class="dl-card">
            <div class="dl-head">
              <span class="dl-title">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="7 10 12 15 17 10" />
                  <line x1="12" y1="15" x2="12" y2="3" />
                </svg>
                下载管理
              </span>
              <span class="dl-count">{{ downloads.length }} 个任务</span>
            </div>

            <div class="dl-list">
              <div v-for="d in downloads" :key="d.id" class="dl-item">
                <div class="dl-row-1">
                  <span class="dl-name" :title="d.title">{{ d.title }}</span>
                  <span
                    class="dl-status"
                    :class="{
                      done: d.status === 'done',
                      downloading: d.status === 'downloading',
                      queued: d.status === 'queued'
                    }"
                  >
                    {{ d.status === 'done' ? '已完成' : d.status === 'downloading' ? '下载中' : '排队中' }}
                  </span>
                </div>
                <div class="dl-bar">
                  <div class="dl-fill" :style="{ width: d.progress + '%' }" />
                </div>
                <div class="dl-foot">
                  <span>{{ d.progress }}%</span>
                  <span v-if="d.size">{{ d.size }}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </aside>

      <!-- 中间主区：平台 tabs + BrowserView host -->
      <main class="browser-main">
        <div class="plat-tabs">
          <div
            v-for="p in platforms"
            :key="p.id"
            class="plat-tab"
            :class="{ active: p.active }"
            @click="selectPlatform(p.id)"
          >
            <span class="plat-emoji">{{ p.emoji }}</span>
            <span class="plat-name">{{ p.name }}</span>
          </div>
        </div>

        <div class="browser-view-area">
          <!-- ═══ P1.5 厚壳化：BrowserView 宿主容器 ═══
               真实 BrowserView（原生层）通过 getBoundingClientRect
               覆盖到此节点之上（z-index 由 Electron 管理）。
               非壳模式（Vite 浏览器预览）→ 回退 mock 占位。 -->
          <div
            ref="hostRef"
            id="browser-view-host"
            class="browser-view-host"
          >
            <!-- 非壳模式降级占位：保留原 mock-device 供 Vite 纯浏览器预览 -->
            <template v-if="!isElectronShell">
              <div class="webview-placeholder">
                <div class="mock-device">
                  <div class="mock-device-header">
                    <span /> <span /> <span />
                  </div>
                  <div class="mock-device-body">
                    <div class="mock-video">
                      <div class="mock-video-logo">
                        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                          <polygon points="23 7 16 12 23 17 23 7" />
                          <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
                        </svg>
                      </div>
                      <div class="mock-video-title">JBL CHARGE6 · 短视频商品页预览</div>
                      <div class="mock-video-hint">（非壳模式：Electron 环境此处为真实 BrowserView）</div>
                    </div>
                    <div class="mock-aside">
                      <div class="mock-chip" />
                      <div class="mock-chip" />
                      <div class="mock-chip long" />
                    </div>
                  </div>
                </div>
              </div>
            </template>
            <!-- 壳模式：BrowserView 原生层覆盖宿主 DOM → 这里只渲染一个
                 细微的 Luosiding 风格边框装饰（不阻挡交互，z-index 由 Electron 控制） -->
            <template v-else>
              <div class="host-decoration" aria-hidden="true">
                <span class="host-badge">
                  {{ platforms.find((p) => p.active)?.name || '浏览器' }}
                  <span class="host-sep">·</span>
                  <span class="host-tip">BrowserView</span>
                </span>
              </div>
            </template>
          </div>

          <!-- Cherry Studio：BrowserView bounds 校验徽标（放在 .browser-view-area 顶层不被原生层遮挡；OK 绿 / NOMATCH 红 / verifying 紫 / unknown 灰）
               点击 → 立即重算+校验；hover → 诊断详情 tip -->
          <button
            v-if="isElectronShell"
            class="bounds-pill"
            :class="boundsStatus"
            type="button"
            :title="boundsBadgeTip"
            @click.stop.prevent="() => { forceRecalcBounds() }"
          >
            <span class="bounds-pill-dot" />
            <span class="bounds-pill-text">{{ boundsBadgeLabel }}</span>
          </button>
        </div>
      </main>
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

/* ─── 顶部工具条 ─── */
.browser-toolbar {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  background: var(--surface);
  border-bottom: 1px solid var(--border);
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
  background: var(--surface-container);
  color: var(--foreground);
}

.ic-btn.disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.badge-dot {
  position: absolute;
  top: 8px;
  right: 8px;
  width: 7px;
  height: 7px;
  border-radius: 999px;
  background: var(--destructive);
  box-shadow: 0 0 0 2px var(--surface);
}

.address-bar {
  flex: 1 1 auto;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 0 var(--space-3);
  height: 40px;
  background: var(--surface-container);
  border: 1px solid var(--border);
  border-radius: 999px;
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
}

.address-input {
  flex: 1 1 auto;
  background: transparent;
  border: none;
  outline: none;
  color: var(--foreground);
  font-size: var(--font-size-body);
}

.right-actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.btn-parse {
  height: 40px;
  padding: 0 var(--space-4);
  border-radius: var(--radius-lg);
  background: var(--primary);
  color: var(--primary-foreground);
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-weight: 600;
  font-size: var(--font-size-body);
  transition: all var(--duration-fast);
}
.btn-parse:disabled { opacity: 0.6; cursor: wait; }

.btn-parse:hover:not(:disabled) {
  filter: brightness(1.05);
}

/* ─── 主体 ─── */
.browser-body {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  width: 100%;
}

/* 左栏 */
.browser-sidebar {
  flex: 0 0 240px;
  width: 240px;
  background: var(--surface);
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
}

.side-scroll {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: var(--space-4) var(--space-3) var(--space-4);
}

.side-section + .dl-card {
  margin-top: var(--space-4);
}

.section-title {
  padding: 0 var(--space-2) var(--space-2);
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.06em;
  color: var(--muted-foreground);
  text-transform: uppercase;
}

.group-label {
  padding: var(--space-2) var(--space-2) 6px;
  font-size: 11px;
  color: var(--muted-foreground);
}

.hist-item {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 8px 10px;
  border-radius: var(--radius-lg);
  cursor: pointer;
  transition: background var(--duration-fast);
  margin-bottom: 2px;
}

.hist-item:hover {
  background: var(--surface-container);
}

.hist-icon {
  flex: 0 0 auto;
  width: 28px;
  height: 28px;
  border-radius: 8px;
  background: var(--surface-container);
  color: var(--muted-foreground);
  display: flex;
  align-items: center;
  justify-content: center;
}

.hist-text {
  flex: 1 1 auto;
  min-width: 0;
}

.hist-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--foreground);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.hist-url {
  margin-top: 1px;
  font-size: 11px;
  color: var(--muted-foreground);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.hist-time {
  flex: 0 0 auto;
  font-size: 11px;
  color: var(--muted-foreground);
}

/* 下载卡片 */
.dl-card {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: var(--radius-xl);
  padding: var(--space-4);
}

.dl-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--space-3);
}

.dl-title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: var(--font-size-body);
  font-weight: 700;
  color: var(--foreground);
}

.dl-count {
  font-size: 11px;
  color: var(--muted-foreground);
}

.dl-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.dl-item {
  padding: var(--space-3);
  background: var(--surface-container);
  border-radius: var(--radius-lg);
}

.dl-row-1 {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  margin-bottom: 8px;
}

.dl-name {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 12px;
  font-weight: 600;
  color: var(--foreground);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.dl-status {
  flex: 0 0 auto;
  font-size: 10px;
  font-weight: 700;
  padding: 2px 7px;
  border-radius: 999px;
  line-height: 1.2;
}

.dl-status.downloading { background: var(--primary-container); color: var(--primary); }
.dl-status.done        { background: var(--success-container); color: var(--success); }
.dl-status.queued      { background: var(--surface-container-high); color: var(--muted-foreground); }

.dl-bar {
  height: 6px;
  background: var(--surface-container-high);
  border-radius: 999px;
  overflow: hidden;
}

.dl-fill {
  height: 100%;
  background: linear-gradient(90deg, var(--primary) 0%, var(--primary-hover) 100%);
  border-radius: 999px;
  transition: width 0.3s ease;
}

.dl-foot {
  margin-top: 6px;
  display: flex;
  justify-content: space-between;
  font-size: 10px;
  color: var(--muted-foreground);
}

/* ─── 浏览器主区 ─── */
.browser-main {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.plat-tabs {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4) 0;
  overflow-x: auto;
}

.plat-tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 14px;
  height: 36px;
  border-radius: var(--radius-lg);
  background: var(--surface-container);
  color: var(--muted-foreground);
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
  cursor: pointer;
  transition: all var(--duration-fast);
  border: 1px solid transparent;
}

.plat-tab:hover {
  background: var(--surface-container-high);
  color: var(--foreground);
}

.plat-tab.active {
  background: var(--card);
  color: var(--primary);
  border-color: var(--primary);
  box-shadow: 0 0 0 3px var(--ring);
}

.plat-emoji {
  font-size: 14px;
  line-height: 1;
}

/* ─── BrowserView 宿主容器 ─── */
.browser-view-area {
  flex: 1 1 auto;
  min-height: 0;
  padding: var(--space-4);
  overflow: hidden;   /* 宿主容器本身不滚动（BrowserView 原生自己滚动） */
  position: relative;
}

.browser-view-host {
  width: 100%;
  height: 100%;
  position: relative;
  background: var(--card);
  border-radius: var(--radius-xl);
  overflow: hidden;
  /* 与 BrowserView 原生层视觉对齐：Luosiding 风格边框 */
  border: 1px solid var(--border);
}

/* 非壳模式降级：原 mock device 样式保留 */
.webview-placeholder {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  background:
    linear-gradient(135deg, rgba(99, 102, 241, 0.05), rgba(236, 72, 153, 0.05)),
    var(--card);
  border-radius: var(--radius-xl);
}

.mock-device {
  width: min(720px, 100%);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 20px;
  overflow: hidden;
  box-shadow: var(--shadow-3);
}

.mock-device-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 16px;
  background: var(--surface-container);
  border-bottom: 1px solid var(--border);
}
.mock-device-header span {
  width: 10px; height: 10px; border-radius: 999px; background: var(--border);
}
.mock-device-header span:first-child { background: #F87171; }
.mock-device-header span:nth-child(2) { background: #FBBF24; }
.mock-device-header span:nth-child(3) { background: #34D399; }

.mock-device-body {
  display: grid;
  grid-template-columns: 2fr 1fr;
  gap: var(--space-4);
  padding: var(--space-5);
}

.mock-video {
  background: linear-gradient(180deg, #0f172a 0%, #1e293b 100%);
  border-radius: var(--radius-xl);
  aspect-ratio: 9 / 14;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: var(--space-4);
  color: #e2e8f0;
  text-align: center;
}

.mock-video-logo {
  color: #94a3b8;
  margin-bottom: var(--space-3);
}

.mock-video-title {
  font-size: 13px;
  font-weight: 600;
  line-height: 1.5;
}

.mock-video-hint {
  margin-top: var(--space-2);
  font-size: 11px;
  color: #64748b;
}

.mock-aside {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.mock-chip {
  height: 40px;
  background: var(--surface-container);
  border-radius: 12px;
}
.mock-chip.long { flex: 1 1 auto; min-height: 180px; }

/* 壳模式装饰：右下角轻量品牌徽章（BrowserView 覆盖在整个 host 之上，
   此徽章仅在加载瞬间可见，之后被 BrowserView 遮挡；作为视觉锚点） */
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

.custom-scroll::-webkit-scrollbar { width: 6px; height: 6px; }
.custom-scroll::-webkit-scrollbar-thumb { background: var(--surface-container-high); border-radius: 3px; }

/* ─── 响应式 ─── */
@media (max-width: 900px) {
  .browser-sidebar {
    position: absolute;
    z-index: 40;
    height: calc(100% - 61px);
    bottom: 0;
    left: 0;
    transform: translateX(-100%);
    transition: transform var(--duration-normal) var(--easing-default);
    box-shadow: var(--shadow-3);
  }
  .browser-sidebar.open { transform: translateX(0); }
  .btn-parse span { display: none; }
  .btn-parse { padding: 0 var(--space-3); }
}

@media (max-width: 640px) {
  .mock-device-body {
    grid-template-columns: 1fr;
  }
  .mock-video { aspect-ratio: 3 / 4; }
  .address-bar { display: none; }
}
</style>
