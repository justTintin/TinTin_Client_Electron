<script setup lang="ts">
// ═══════════════════════════════════════════════════════════════
// Browser.vue — 浏览器（对齐 TinTin V3 UI 设计稿三栏布局）
//
// 布局（与设计稿 浏览器.html 一致）：
//   · 顶部工具条：导航按钮 + 地址栏 + 解析并导入 + 下载/设置
//   · 左栏 200px：模式切换 + 常用平台（对齐原客户端素材浏览器）
//   · 中间：BrowserView 渲染区（非壳模式显示地球占位）
//   · 右栏 240px：下载管理（实时进度）
//
// 保留 P1.5 厚壳化能力：
//   · browser-view-host 容器 + attachPlatform（partition 隔离）
//   · 4 源 bounds 重算（C13 200ms debounce）+ 看门狗主动校验
//   · 导航：后退/前进/刷新/Enter 跳页 → browser:navigate
//   · URL 更新订阅：did-navigate → 回填地址栏
//   · 下载更新订阅：will-download → 右栏下载卡片实时刷新
//   · C6 切 Tab / onBeforeUnmount：detachAll 防止原生层级泄漏
//
// 多端适配：
//   · ≥1200px：三栏静态布局
//   · 900–1199px：右栏收纳为工具栏下载按钮唤出的滑出面板
//   · <900px：左栏抽屉化（工具栏汉堡按钮唤出）
//   · 壳模式下抽屉/面板打开时 BrowserView 置零边界，防原生层遮挡
// ═══════════════════════════════════════════════════════════════

import { ref, computed, onMounted, onBeforeUnmount, reactive, nextTick, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useAppStore, type BrowserExtractPayload } from '@/stores/app'
import type { BrowserPlatformId, BrowserBoundsVerifyReport } from '../../../../types/global'

/* ── 壳检测（C9 门控）：Electron = true，纯 Vite 浏览器 = false，走降级占位 ────── */
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

/* ── 平台标签（左栏，对齐原客户端素材浏览器布局） ─────────────── */
interface PlatformTab {
  id: BrowserPlatformId
  name: string
  badge: string
  active?: boolean
}

const platforms = ref<PlatformTab[]>([
  { id: 'douyin',      name: '抖音',   badge: '抖', active: true },
  { id: 'bilibili',    name: 'B站',    badge: 'B' },
  { id: 'kuaishou',    name: '快手',   badge: '快' },
  { id: 'xiaohongshu', name: '小红书', badge: '小' },
  { id: 'weixin',      name: '视频号', badge: '视' },
  { id: 'youtube',     name: 'YouTube', badge: 'Y' },
  { id: 'jimeng',      name: '即梦AI', badge: '即' },
])

type BrowseMode = 'browser' | 'favorites'
const browseMode = ref<BrowseMode>('browser')
const browseModes: { id: BrowseMode; name: string; icon: string }[] = [
  { id: 'browser',   name: '网页浏览器', icon: '🌐' },
  { id: 'favorites', name: '收藏记录',   icon: '📑' },
]

const currentPlatform = computed<BrowserPlatformId | null>(() => {
  const p = platforms.value.find((x) => x.active)
  return p ? p.id : null
})

const activePlatformName = computed<string>(() => {
  const p = platforms.value.find((x) => x.active)
  return p ? p.name : ''
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
      youtube: 'https://www.youtube.com',
      jimeng: 'https://jimeng.jianying.com',
    }
    addressUrl.value = seed[pid] || 'about:blank'
    // 小屏抽屉场景：选中标签后自动收起抽屉
    if (isNarrow.value) leftDrawerOpen.value = false
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

/* ── 浏览历史（左栏，设计稿 tag-item 样式） ─────────────── */
interface HistoryItem {
  id: string
  title: string
  url: string
  time: string
}

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
  if (isNarrow.value) leftDrawerOpen.value = false
  if (!isElectronShell.value) return
  const cur = currentPlatform.value
  if (!cur) return
  try {
    await (window as any).tintin.browser.navigate({ platformId: cur, url: u })
  } catch (_) {}
}

/* ── 下载管理（右栏）：will-download 实时推送 ────────────── */
interface DownloadItem {
  id: string
  title: string
  progress: number // 0-100
  status: 'downloading' | 'done' | 'queued'
  size?: string
}
const downloads = ref<DownloadItem[]>([
  { id: 'd1', title: 'sample_video.mp4',       progress: 75, status: 'downloading', size: '128MB' },
  { id: 'd2', title: 'COVER_MAIN_V1.png',      progress: 100, status: 'done',       size: '3.4MB' },
  { id: 'd3', title: 'LIVE_CLIP_21.mp4',       progress: 0,   status: 'queued' }
])
const downloadingCount = computed(() => downloads.value.filter((d) => d.status === 'downloading').length)
/** 字节 → 人类可读大小（粗估） */
function _fmtBytes(b?: number): string {
  if (!b) return ''
  if (b < 1024) return b + 'B'
  if (b < 1024 * 1024) return (b / 1024).toFixed(0) + 'KB'
  if (b < 1024 * 1024 * 1024) return (b / (1024 * 1024)).toFixed(1) + 'MB'
  return (b / (1024 * 1024 * 1024)).toFixed(2) + 'GB'
}
/** 下载状态显示文本 */
function dlStatusText(d: DownloadItem): string {
  if (d.status === 'done') return d.size ? '已完成 · ' + d.size : '已完成'
  if (d.status === 'queued') return '排队中'
  return d.size || '下载中'
}

/* ═══════════════════════════════════════════════════════════════
   Phase 2-1: 媒体嗅探面板 UI
   实时嗅探视频/音频流，展示列表，一键下载
   ═══════════════════════════════════════════════════════════════ */
interface SniffedMedia {
  id: string
  url: string
  name: string
  type: 'video' | 'audio' | 'image'
  size?: number
  sizeText?: string
  platformId?: string
  ts: number
  audioUrl?: string
}

const sniffedMedia = ref<SniffedMedia[]>([])
const activeRightTab = ref<'sniff' | 'downloads'>('sniff')
const sniffedCount = computed(() => sniffedMedia.value.length)

interface FavoriteItem {
  url: string
  name: string
  type: 'video' | 'audio' | 'image'
  size?: number
  sizeText?: string
  platformId?: string
  addedAt: number
  updatedAt?: number
  audioUrl?: string
}

const favorites = ref<FavoriteItem[]>([])
const favoritesCount = computed(() => favorites.value.length)
const currentPageFavorited = computed(() => {
  const url = addressUrl.value
  return url ? favorites.value.some(f => f.url === url) : false
})

async function loadFavorites(): Promise<void> {
  const t = (window as any).tintin
  if (!t?.mediaStorage) return
  try {
    const res = await t.mediaStorage.getFavorites()
    if (res?.data && Array.isArray(res.data)) {
      favorites.value = res.data
    }
  } catch (_) {}
}

async function addToFavorites(item: FavoriteItem): Promise<void> {
  const t = (window as any).tintin
  if (!t?.mediaStorage) return
  try {
    const res = await t.mediaStorage.addFavorite(item)
    if (res?.data && Array.isArray(res.data)) {
      favorites.value = res.data
    }
  } catch (_) {}
}

async function removeFromFavorites(url: string): Promise<void> {
  const t = (window as any).tintin
  if (!t?.mediaStorage) return
  try {
    const res = await t.mediaStorage.removeFavorite(url)
    if (res?.data && Array.isArray(res.data)) {
      favorites.value = res.data
    }
  } catch (_) {}
}

async function collectCurrentPage(): Promise<void> {
  const t = (window as any).tintin
  if (!t?.mediaStorage) return
  const url = addressUrl.value
  if (!url) return
  const item: FavoriteItem = {
    url,
    name: activePlatformName.value || url,
    type: 'video',
    platformId: currentPlatform.value || undefined,
    addedAt: Date.now(),
  }
  await addToFavorites(item)
}

async function navigateToFavorite(item: FavoriteItem): Promise<void> {
  const t = (window as any).tintin
  if (!t?.browser?.navigate) return
  const platformId = item.platformId || currentPlatform.value
  if (!platformId) return
  // 切回浏览器模式
  browseMode.value = 'browser'
  // 等模式切换完成后导航
  await nextTick()
  try {
    await t.browser.navigate({ platformId, url: item.url })
  } catch (_) {}
}

async function removeFavoriteItem(url: string, event?: Event): Promise<void> {
  if (event) {
    event.stopPropagation()
    event.preventDefault()
  }
  await removeFromFavorites(url)
}

function _formatBytesPhase2(b?: number): string {
  if (!b) return ''
  if (b < 1024) return b + 'B'
  if (b < 1024 * 1024) return (b / 1024).toFixed(0) + 'KB'
  if (b < 1024 * 1024 * 1024) return (b / (1024 * 1024)).toFixed(1) + 'MB'
  return (b / (1024 * 1024 * 1024)).toFixed(2) + 'GB'
}

async function downloadSniffedMedia(media: SniffedMedia): Promise<void> {
  const t = (window as any).tintin
  if (!t?.mediaDownload?.start) return
  const cur = currentPlatform.value
  const taskId = 'mdl_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6)
  try {
    await t.mediaDownload.start({
      taskId,
      url: media.url,
      audioUrl: media.audioUrl,
      filename: media.name || (media.type === 'video' ? 'video.mp4' : 'audio.mp3'),
      referer: addressUrl.value,
      platformId: cur || undefined,
      subDir: cur || undefined,
    })
    mediaDownloadTasks.value.unshift({
      id: taskId,
      title: media.name || taskId,
      progress: 0,
      status: 'downloading',
      speed: 0,
      totalSize: media.size || 0,
      downloaded: 0,
      paused: false,
      url: media.url,
    })
  } catch (e) {
    console.warn('[Browser] downloadSniffedMedia failed:', e)
  }
}

/* ═══════════════════════════════════════════════════════════════
   Phase 2-2: 增强下载进度卡片（速度/暂停/取消）
   ═══════════════════════════════════════════════════════════════ */
interface MediaDownloadTask {
  id: string
  title: string
  progress: number
  status: 'downloading' | 'done' | 'paused' | 'error' | 'cancelled' | 'queued'
  speed: number
  totalSize: number
  downloaded: number
  paused: boolean
  url?: string
}

const mediaDownloadTasks = ref<MediaDownloadTask[]>([])
const activeDownloadCount = computed(() =>
  mediaDownloadTasks.value.filter((t) => t.status === 'downloading' && !t.paused).length,
)

/* ═══════════════════════════════════════════════════════════════
   Phase 3: 历史记录 + 持久化
   ═══════════════════════════════════════════════════════════════ */
interface HistoryEntry {
  url: string
  title: string
  ts: number
  platformId?: string
}

const historyEntries = ref<HistoryEntry[]>([])

function addHistory(url: string, title: string, platformId?: string): void {
  if (!url) return
  const entry: HistoryEntry = { url, title: title || url, ts: Date.now(), platformId }
  const existing = historyEntries.value.findIndex((h) => h.url === url)
  if (existing >= 0) {
    historyEntries.value.splice(existing, 1)
  }
  historyEntries.value.unshift(entry)
  if (historyEntries.value.length > 300) historyEntries.value.pop()
}

function clearHistory(): void {
  historyEntries.value = []
  const t = (window as any).tintin
  if (t?.history) t.history.close()
}

function navigateToHistory(index: number): void {
  const entry = historyEntries.value[index]
  if (!entry) return
  const t = (window as any).tintin
  if (!t?.browser?.navigate) return
  const cur = currentPlatform.value
  void t.browser.navigate({ platformId: cur, url: entry.url })
}

function openHistoryPanel(): void {
  const t = (window as any).tintin
  if (!t?.history) return
  // 获取按钮位置作为锚点
  const btn = document.querySelector('.hist-wrapper button')
  let x = 0, y = 0
  if (btn) {
    const rect = btn.getBoundingClientRect()
    x = Math.round(rect.left)
    y = Math.round(rect.bottom + 4)
  }
  // 转换为相对于主窗口的坐标
  const winBounds = (window as any).__WINDOW_BOUNDS__
  if (winBounds) {
    x += winBounds.x || 0
    y += winBounds.y || 0
  }
  t.history.open(historyEntries.value.map((h, i) => ({
    index: i,
    url: h.url,
    title: h.title,
    timestamp: h.ts
  })), x, y)
}

function formatHistoryTime(ts: number): string {
  if (!ts) return ''
  const d = new Date(ts)
  const now = new Date()
  const diff = now.getTime() - ts
  if (diff < 60_000) return '刚刚'
  if (diff < 3600_000) return Math.floor(diff / 60_000) + '分钟前'
  if (diff < 86_400_000) return Math.floor(diff / 3600_000) + '小时前'
  return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
}

async function saveAllToStorage(): Promise<void> {
  const t = (window as any).tintin
  if (!t?.mediaStorage) return
  try {
    await t.mediaStorage.saveSniffed(sniffedMedia.value)
    const completedDownloads = mediaDownloadTasks.value.filter(
      (d) => d.status === 'done' || d.status === 'cancelled' || d.status === 'error'
    )
    if (completedDownloads.length > 0) {
      await t.mediaStorage.saveDownloads(completedDownloads)
    }
  } catch (_) {}
}

async function loadFromStorage(): Promise<void> {
  const t = (window as any).tintin
  if (!t?.mediaStorage) return
  try {
    const [sniffedRes, downloadsRes] = await Promise.all([
      t.mediaStorage.getSniffed(),
      t.mediaStorage.getDownloads(),
    ])
    if (sniffedRes?.data && Array.isArray(sniffedRes.data)) {
      const existingUrls = new Set(sniffedMedia.value.map((m) => m.url))
      const restored = sniffedRes.data.filter((m: any) => !existingUrls.has(m.url))
      sniffedMedia.value = [...restored, ...sniffedMedia.value].slice(0, 50)
    }
    if (downloadsRes?.data && Array.isArray(downloadsRes.data)) {
      const existingIds = new Set(mediaDownloadTasks.value.map((t) => t.id))
      const restored = downloadsRes.data.filter((d: any) => !existingIds.has(d.id))
      mediaDownloadTasks.value = [...restored, ...mediaDownloadTasks.value]
    }
  } catch (_) {}
}

async function togglePauseTask(task: MediaDownloadTask): Promise<void> {
  const t = (window as any).tintin
  if (!t?.mediaDownload?.pause) return
  task.paused = !task.paused
  task.status = task.paused ? 'paused' : 'downloading'
  try {
    await t.mediaDownload.pause(task.id)
  } catch (_) {}
}

async function cancelDownloadTask(task: MediaDownloadTask): Promise<void> {
  const t = (window as any).tintin
  if (!t?.mediaDownload?.cancel) return
  task.status = 'cancelled'
  task.speed = 0
  try {
    await t.mediaDownload.cancel(task.id)
  } catch (_) {}
}

function removeDownloadTask(task: MediaDownloadTask): void {
  const idx = mediaDownloadTasks.value.findIndex((t) => t.id === task.id)
  if (idx >= 0) mediaDownloadTasks.value.splice(idx, 1)
}

function _formatSpeed(bps: number): string {
  if (!bps || bps < 0) return ''
  if (bps < 1024) return bps.toFixed(0) + 'B/s'
  if (bps < 1024 * 1024) return (bps / 1024).toFixed(1) + 'KB/s'
  return (bps / (1024 * 1024)).toFixed(2) + 'MB/s'
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

/* ════════════════════════════════════════════════════════════
   P1.5 bounds 4源重算 + Cherry Studio 实时校验闭环（attach/setBounds/verify → 2 次 NOMATCH 自动重试）
   BrowserView 宿主节点：#browser-view-host（.browser-view-host）
   使用 getBoundingClientRect 获取 DOMRect → browser:setBounds
   ════════════════════════════════════════════════════════════ */
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
const rightPanelOpen = ref(false)
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

/** 浮层（抽屉/面板）是否处于打开态且覆盖宿主区域 */
const overlayActive = computed<boolean>(() =>
  (leftDrawerOpen.value && isNarrow.value) || (rightPanelOpen.value && !rightDocked.value),
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
function goSettings(): void { router.push('/settings') }

/** 壳模式浮层打开 → BrowserView 置零；关闭 → 重算恢复 */
async function _collapseBounds(): Promise<void> {
  const cur = currentPlatform.value
  if (!cur) return
  const t = (window as any).tintin
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

/* ── Phase 3: 自动持久化（嗅探/下载变化后 debounce 保存） ──── */
let _saveTimer: ReturnType<typeof setTimeout> | null = null
function _debouncedSave() {
  if (_saveTimer) clearTimeout(_saveTimer)
  _saveTimer = setTimeout(() => { void saveAllToStorage() }, 1500)
}
watch(sniffedMedia, () => _debouncedSave(), { deep: true })
watch(mediaDownloadTasks, () => _debouncedSave(), { deep: true })

/* ── 订阅：URL 更新（did-navigate）+ 下载推送（will-download） + Cherry Studio view-ready（did-stop-loading） ──── */
let _unsubUrl: (() => void) | null = null
let _unsubDownloads: (() => void) | null = null
let _unsubViewReady: (() => void) | null = null
let _unsubMediaSniff: (() => void) | null = null
let _unsubMediaProgress: (() => void) | null = null
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
          addHistory(payload.url, payload?.title || '', payload.platformId)
        }
      })
    }
    if (typeof t.browser.onDownloadsUpdated === 'function') {
      _unsubDownloads = t.browser.onDownloadsUpdated((payload: any) => {
        if (!payload?.filename) return
        // 下载事件 → 右栏卡片实时刷新（简化：若存在同名则更新，否则新增 downloading）
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
    // Phase 2-1: 媒体嗅探订阅（browser:onMediaSniffed）
    if (typeof t.browser.onMediaSniffed === 'function') {
      _unsubMediaSniff = t.browser.onMediaSniffed((payload: any) => {
        if (!payload?.url) return
        const media: SniffedMedia = {
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
        let task = mediaDownloadTasks.value.find((t) => t.id === id)
        if (!task) {
          task = {
            id,
            title: payload?.filename || payload?.name || id,
            progress: 0,
            status: 'downloading',
            speed: 0,
            totalSize: payload?.totalSize || 0,
            downloaded: 0,
            paused: false,
          }
          mediaDownloadTasks.value.unshift(task)
        }
        if (typeof payload.progress === 'number') task.progress = payload.progress
        if (typeof payload.speed === 'number') task.speed = payload.speed
        if (typeof payload.downloaded === 'number') task.downloaded = payload.downloaded
        if (typeof payload.totalSize === 'number') task.totalSize = payload.totalSize
        if (payload.status) task.status = payload.status
        if (payload.status === 'done') {
          task.progress = 100
          task.speed = 0
          task.status = 'done'
        } else if (payload.status === 'paused') {
          task.paused = true
          task.speed = 0
        } else if (payload.status === 'downloading') {
          task.paused = false
        } else if (payload.status === 'cancelled' || payload.status === 'error') {
          task.speed = 0
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

    // 历史面板导航事件
    if (typeof t.history?.onNavigate === 'function') {
      t.history.onNavigate((index: number) => {
        navigateToHistory(index)
      })
    }
    if (typeof t.history?.onCleared === 'function') {
      t.history.onCleared(() => {
        historyEntries.value = []
      })
    }
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
  // 断点监听（多端适配）
  if (typeof window.matchMedia === 'function') {
    _mqNarrow = window.matchMedia('(max-width: 899px)')
    _mqDocked = window.matchMedia('(min-width: 1200px)')
    isNarrow.value = _mqNarrow.matches
    rightDocked.value = _mqDocked.matches
    _mqNarrow.addEventListener('change', _onMqNarrow)
    _mqDocked.addEventListener('change', _onMqDocked)
  }

  // Phase 3: 启动时加载持久化数据
  void loadFromStorage()
  void loadFavorites()

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

// 模式切换：浏览器模式 ↔ 收藏记录模式
watch(browseMode, async (mode) => {
  const t = (window as any).tintin
  if (!t?.browser) return
  if (mode === 'browser') {
    // 切回浏览器模式：重新 attach 当前平台的 BrowserView
    const cur = currentPlatform.value
    if (cur && isElectronShell.value) {
      try {
        const r = await t.browser.attachPlatform(cur)
        if (r?.success && r?.data) {
          addressUrl.value = r.data.currentUrl || addressUrl.value
        }
        scheduleRecalcBounds()
      } catch (_) {}
    }
  } else if (mode === 'favorites') {
    // 切到收藏模式：detach BrowserView 释放资源
    if (isElectronShell.value) {
      try {
        await t.browser.detachAll()
      } catch (_) {}
    }
    // 刷新收藏列表
    await loadFavorites()
  }
})

onBeforeUnmount(() => {
  if (_boundsTimer) { clearTimeout(_boundsTimer); _boundsTimer = null }
  if (_firstVerifyTimer) { clearTimeout(_firstVerifyTimer); _firstVerifyTimer = null }
  if (_boundsWatchdogTimer) { clearInterval(_boundsWatchdogTimer); _boundsWatchdogTimer = null }
  window.removeEventListener('resize', _onWindowResize)
  if (_mqNarrow) { _mqNarrow.removeEventListener('change', _onMqNarrow); _mqNarrow = null }
  if (_mqDocked) { _mqDocked.removeEventListener('change', _onMqDocked); _mqDocked = null }
  if (_onAppWindowStateChange) {
    window.removeEventListener('app:winstate-changed', _onAppWindowStateChange as EventListener)
    _onAppWindowStateChange = null
  }
  if (_unsubUrl) { try { _unsubUrl() } catch(_){} _unsubUrl = null }
  if (_unsubDownloads) { try { _unsubDownloads() } catch(_){} _unsubDownloads = null }
  if (_unsubViewReady) { try { _unsubViewReady() } catch(_){} _unsubViewReady = null }
  if (_unsubMediaSniff) { try { _unsubMediaSniff() } catch(_){} _unsubMediaSniff = null }
  if (_unsubMediaProgress) { try { _unsubMediaProgress() } catch(_){} _unsubMediaProgress = null }
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
        <!-- 汉堡按钮：<900px 唤出左栏抽屉 -->
        <button
          class="ic-btn menu-btn"
          :class="{ active: leftDrawerOpen }"
          title="快速标签与历史记录"
          aria-label="打开侧栏"
          @click="toggleLeftDrawer"
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
          @click="navBack"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="m15 18-6-6 6-6" />
          </svg>
        </button>
        <button
          class="ic-btn"
          :class="{ disabled: !navCan.forward || !isElectronShell }"
          title="前进"
          @click="navForward"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="m9 18 6-6-6-6" />
          </svg>
        </button>
        <button
          class="ic-btn"
          :class="{ disabled: !isElectronShell }"
          title="刷新"
          @click="navReload"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
            <path d="M3 21v-5h5" />
            <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
            <path d="M21 3v5h-5" />
          </svg>
        </button>
      </div>

      <div class="address-bar">
        <span class="lock-ic" title="安全连接">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
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
          :title="isElectronShell ? '解析当前页面并导入工作台' : '仅 Electron 壳内可用'"
          @click="onExtract"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
            <polyline points="13 2 13 9 20 9" />
          </svg>
          {{ extracting ? '解析中…' : '解析并导入' }}
        </button>
        <button
          class="ic-btn"
          :class="{ active: rightPanelOpen }"
          :title="rightDocked ? '下载任务见右侧面板' : '下载管理'"
          aria-label="下载管理"
          @click="toggleRightPanel"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
          <span v-if="activeDownloadCount > 0 || downloadingCount > 0" class="badge-dot" />
        </button>
        <div class="hist-wrapper">
          <button
            class="ic-btn"
            title="历史记录"
            aria-label="历史记录"
            @click="openHistoryPanel"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <path d="M3 3v5h5" />
              <path d="M3.05 13A9 9 0 1 0 6 5.3L3 8" />
              <path d="M12 7v5l4 2" />
            </svg>
            <span v-if="historyEntries.length > 0" class="badge-dot" />
          </button>
        </div>
        <button class="ic-btn" title="设置" aria-label="设置" @click="goSettings">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>
      </div>
    </header>

    <!-- ─── 主体：左栏 + 渲染区 + 右栏 ─── -->
    <div class="browser-body">
      <!-- 左栏：模式切换 + 平台网格（对齐原客户端素材浏览器） -->
      <aside class="browser-sidebar" :class="{ open: leftDrawerOpen }">
        <div class="side-scroll custom-scroll">

          <!-- 模式切换 -->
          <div class="side-block">
            <div class="section-title">模式切换</div>
            <div class="mode-buttons">
              <button
                v-for="m in browseModes"
                :key="m.id"
                class="mode-btn"
                :class="{ active: browseMode === m.id }"
                @click="browseMode = m.id"
              >
                <span class="mode-icon">{{ m.icon }}</span>
                <span>{{ m.name }}</span>
              </button>
            </div>
          </div>

          <!-- 常用平台 -->
          <div class="side-block">
            <div class="section-title">常用平台</div>
            <div class="platform-grid">
              <button
                v-for="p in platforms"
                :key="p.id"
                class="platform-btn"
                :class="{ active: p.active }"
                @click="selectPlatform(p.id)"
              >
                <span class="platform-badge" :class="p.id">{{ p.badge }}</span>
                <span class="platform-name">{{ p.name }}</span>
              </button>
            </div>
          </div>

        </div>
      </aside>

      <!-- 中间主区：BrowserView host / 收藏记录列表 -->
      <main class="browser-main">
        <!-- 网页浏览器模式 -->
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

          <!-- Cherry Studio：BrowserView bounds 校验徽标 -->
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

        <!-- 收藏记录模式 -->
        <div v-else class="favorites-view-area">
          <div class="favorites-header">
            <div class="favorites-title">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
              </svg>
              <span>收藏记录</span>
              <span class="favorites-count">{{ favoritesCount }}</span>
            </div>
          </div>
          <div v-if="favorites.length > 0" class="favorites-list">
            <div
              v-for="item in favorites"
              :key="item.url"
              class="favorite-card"
              @click="navigateToFavorite(item)"
            >
              <div class="favorite-icon" :class="item.type">
                <svg v-if="item.type === 'video'" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                  <polygon points="23 7 16 12 23 17 23 7" />
                  <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
                </svg>
                <svg v-else-if="item.type === 'audio'" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                  <path d="M9 18V5l12-2v13" />
                  <circle cx="6" cy="18" r="3" />
                  <circle cx="18" cy="16" r="3" />
                </svg>
                <svg v-else width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                  <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                  <circle cx="8.5" cy="8.5" r="1.5" />
                  <polyline points="21 15 16 10 5 21" />
                </svg>
              </div>
              <div class="favorite-info">
                <div class="favorite-name" :title="item.name">{{ item.name }}</div>
                <div class="favorite-meta">
                  <span class="favorite-url" :title="item.url">{{ item.url }}</span>
                </div>
                <div class="favorite-time">
                  <span>{{ new Date(item.addedAt).toLocaleString() }}</span>
                </div>
              </div>
              <button
                class="favorite-delete-btn"
                title="取消收藏"
                @click="removeFavoriteItem(item.url, $event)"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M3 6h18" />
                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                  <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                </svg>
              </button>
            </div>
          </div>
          <div v-else class="favorites-empty">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1">
              <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
            </svg>
            <div class="empty-title">暂无收藏</div>
            <div class="empty-sub">在浏览器中访问感兴趣的页面，点击收藏按钮添加到这里</div>
          </div>
        </div>
      </main>

      <!-- 右栏：媒体嗅探 + 下载管理（设计稿 240px） -->
      <aside class="browser-rightbar" :class="{ open: rightPanelOpen }">
        <div class="rightbar-tabs">
          <button
            class="rb-tab"
            :class="{ active: activeRightTab === 'sniff' }"
            @click="activeRightTab = 'sniff'"
          >
            媒体嗅探
            <span v-if="sniffedCount > 0" class="rb-tab-badge">{{ sniffedCount }}</span>
          </button>
          <button
            class="rb-tab"
            :class="{ active: activeRightTab === 'downloads' }"
            @click="activeRightTab = 'downloads'"
          >
            下载管理
            <span v-if="activeDownloadCount > 0" class="rb-tab-badge active">{{ activeDownloadCount }}</span>
          </button>
        </div>
        <div class="side-scroll custom-scroll">
          <!-- Tab: 媒体嗅探 -->
          <template v-if="activeRightTab === 'sniff'">
            <div class="side-block">
              <div v-if="sniffedMedia.length > 0" class="sniff-list">
                <div
                  v-for="m in sniffedMedia"
                  :key="m.id"
                  class="sniff-card"
                >
                  <div class="sniff-type-ic" :class="m.type">
                    <svg v-if="m.type === 'video'" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                      <polygon points="23 7 16 12 23 17 23 7" />
                      <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
                    </svg>
                    <svg v-else-if="m.type === 'audio'" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                      <path d="M9 18V5l12-2v13" />
                      <circle cx="6" cy="18" r="3" />
                      <circle cx="18" cy="16" r="3" />
                    </svg>
                    <svg v-else width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                      <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                      <circle cx="8.5" cy="8.5" r="1.5" />
                      <polyline points="21 15 16 10 5 21" />
                    </svg>
                  </div>
                  <div class="sniff-info">
                    <div class="sniff-name" :title="m.name">{{ m.name }}</div>
                    <div class="sniff-meta">
                      <span v-if="m.sizeText">{{ m.sizeText }}</span>
                      <span v-if="m.audioUrl" class="sniff-audio-tag">含音频</span>
                    </div>
                  </div>
                  <button
                    class="sniff-dl-btn"
                    :disabled="!isElectronShell"
                    title="下载"
                    @click="downloadSniffedMedia(m)"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                      <polyline points="7 10 12 15 17 10" />
                      <line x1="12" y1="15" x2="12" y2="3" />
                    </svg>
                  </button>
                </div>
              </div>
              <div v-else class="rb-empty">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                  <circle cx="11" cy="11" r="8" />
                  <line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
                <span>正在嗅探媒体资源…</span>
                <span class="rb-empty-sub">在页面上播放视频或音频以触发嗅探</span>
              </div>
            </div>
          </template>

          <!-- Tab: 下载管理 -->
          <template v-else>
            <!-- Phase 2-2: 增强下载任务卡片 -->
            <div v-if="mediaDownloadTasks.length > 0" class="side-block">
              <div
                v-for="t in mediaDownloadTasks"
                :key="t.id"
                class="dl-card enhanced"
                :class="{ paused: t.paused, done: t.status === 'done', cancelled: t.status === 'cancelled', error: t.status === 'error' }"
              >
                <div class="dl-card-header">
                  <div class="dl-name" :title="t.title">{{ t.title }}</div>
                  <div class="dl-actions">
                    <button
                      v-if="t.status !== 'done' && t.status !== 'cancelled' && t.status !== 'error'"
                      class="dl-action-btn"
                      :title="t.paused ? '继续' : '暂停'"
                      @click="togglePauseTask(t)"
                    >
                      <svg v-if="!t.paused" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <rect x="6" y="4" width="4" height="16" />
                        <rect x="14" y="4" width="4" height="16" />
                      </svg>
                      <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <polygon points="5 3 19 12 5 21 5 3" />
                      </svg>
                    </button>
                    <button
                      v-if="t.status !== 'done' && t.status !== 'cancelled'"
                      class="dl-action-btn"
                      title="取消"
                      @click="cancelDownloadTask(t)"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <line x1="18" y1="6" x2="6" y2="18" />
                        <line x1="6" y1="6" x2="18" y2="18" />
                      </svg>
                    </button>
                    <button
                      v-if="t.status === 'done' || t.status === 'cancelled' || t.status === 'error'"
                      class="dl-action-btn"
                      title="移除"
                      @click="removeDownloadTask(t)"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <polyline points="3 6 5 6 21 6" />
                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                      </svg>
                    </button>
                  </div>
                </div>
                <div class="dl-bar">
                  <div
                    class="dl-fill"
                    :class="{
                      done: t.status === 'done',
                      queued: t.status === 'queued',
                      paused: t.paused,
                      cancelled: t.status === 'cancelled',
                      error: t.status === 'error',
                    }"
                    :style="{ width: t.progress + '%' }"
                  />
                </div>
                <div class="dl-foot">
                  <span class="dl-progress-text">{{ t.status === 'done' ? '100%' : t.progress + '%' }}</span>
                  <span class="dl-speed" v-if="t.speed > 0">{{ _formatSpeed(t.speed) }}</span>
                  <span
                    class="dl-status"
                    :class="{ 'dl-done': t.status === 'done', 'dl-paused': t.paused, 'dl-cancelled': t.status === 'cancelled', 'dl-error': t.status === 'error' }"
                  >
                    {{ t.status === 'done' ? '已完成' : t.paused ? '已暂停' : t.status === 'cancelled' ? '已取消' : t.status === 'error' ? '错误' : '下载中' }}
                  </span>
                </div>
              </div>
            </div>
            <!-- 兼容旧 will-download 事件（非媒体嗅探来源） -->
            <div v-if="mediaDownloadTasks.length === 0 && downloads.length > 0" class="side-block">
              <div v-for="d in downloads" :key="d.id" class="dl-card">
                <div class="dl-name" :title="d.title">{{ d.title }}</div>
                <div class="dl-bar">
                  <div class="dl-fill" :class="d.status" :style="{ width: d.progress + '%' }" />
                </div>
                <div class="dl-foot">
                  <span>{{ d.status === 'done' ? '100%' : d.progress + '%' }}</span>
                  <span :class="{ 'dl-done': d.status === 'done' }">{{ dlStatusText(d) }}</span>
                </div>
              </div>
            </div>
            <div v-if="mediaDownloadTasks.length === 0 && downloads.length === 0" class="rb-empty">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
              <span>暂无下载任务</span>
            </div>
          </template>
        </div>
      </aside>

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

.address-input {
  flex: 1 1 auto;
  min-width: 0;
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
  white-space: nowrap;
}
.btn-parse:disabled { opacity: 0.6; cursor: not-allowed; }

.btn-parse:hover:not(:disabled) {
  filter: brightness(1.08);
  transform: translateY(-1px);
}

/* ─── 主体 ─── */
.browser-body {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  width: 100%;
  position: relative;
}

/* ─── 通用侧栏块 ─── */
.side-scroll {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 12px 10px;
}

.side-block + .side-block {
  margin-top: var(--space-5);
}

.section-title {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.08em;
  color: var(--muted-foreground);
  text-transform: uppercase;
  margin-bottom: var(--space-3);
}

/* ─── 左栏：模式切换 + 平台网格 ─── */
.browser-sidebar {
  flex: 0 0 168px;
  width: 168px;
  background: var(--surface);
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
}

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

/* ─── 右栏：下载管理 ─── */
.browser-rightbar {
  flex: 0 0 240px;
  width: 240px;
  background: var(--surface);
  border-left: 1px solid var(--border);
  display: flex;
  flex-direction: column;
}

.dl-card {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  padding: 8px 10px;
  margin-bottom: 6px;
  box-shadow: none;
}

.dl-card.enhanced {
  padding: 8px 10px;
}

.dl-name {
  font-size: 14px;
  color: var(--foreground);
  margin-bottom: var(--space-2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.dl-bar {
  height: 6px;
  background: var(--surface-container);
  border-radius: var(--radius-full);
  overflow: hidden;
  margin-bottom: var(--space-2);
}

.dl-fill {
  height: 100%;
  background: var(--primary);
  border-radius: var(--radius-full);
  transition: width 0.3s ease;
}

.dl-fill.done {
  background: var(--success);
}

.dl-fill.queued {
  background: var(--surface-container-high);
}

.dl-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 11px;
  color: var(--muted-foreground);
}

.dl-done { color: var(--success); }

.rb-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-6) 0;
  color: var(--muted-foreground);
  font-size: 12px;
}

.rb-empty-sub {
  font-size: 11px;
  opacity: 0.7;
}

/* ═══ Phase 2: 右栏 Tabs ═══ */
.rightbar-tabs {
  display: flex;
  gap: 0;
  flex-shrink: 0;
  background: var(--surface);
  border-bottom: 1px solid var(--border);
}

.rb-tab {
  flex: 1 1 50%;
  padding: 10px 12px;
  font-size: 12px;
  font-weight: 500;
  color: var(--muted-foreground);
  background: transparent;
  border: none;
  border-bottom: 2px solid transparent;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  transition: all var(--duration-fast);
}

.rb-tab:hover {
  color: var(--foreground);
  background: var(--surface-container);
}

.rb-tab.active {
  color: var(--primary);
  border-bottom-color: var(--primary);
  font-weight: 600;
}

.rb-tab-badge {
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  border-radius: 9px;
  background: var(--surface-container-high);
  color: var(--muted-foreground);
  font-size: 10px;
  font-weight: 600;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.rb-tab-badge.active {
  background: var(--primary);
  color: var(--primary-foreground);
}

/* ═══ Phase 2: 媒体嗅探卡片 ═══ */
.sniff-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.sniff-list .sniff-card:nth-child(odd) {
  background: var(--surface-container);
}

.sniff-list .sniff-card:nth-child(even) {
  background: var(--card);
}

.sniff-list .sniff-card:hover {
  background: rgba(99, 102, 241, 0.08);
  border-color: var(--primary);
  box-shadow: var(--shadow-1);
}

.sniff-card {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  transition: all var(--duration-fast);
}

.sniff-card:hover {
  border-color: var(--primary);
  box-shadow: var(--shadow-1);
  background: var(--surface-container);
}

.sniff-type-ic {
  width: 32px;
  height: 32px;
  border-radius: var(--radius-md);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  background: var(--surface-container);
  color: var(--muted-foreground);
}

.sniff-type-ic.video {
  background: rgba(99, 102, 241, 0.12);
  color: var(--primary);
}

.sniff-type-ic.audio {
  background: rgba(16, 185, 129, 0.12);
  color: var(--success);
}

.sniff-type-ic.image {
  background: rgba(245, 158, 11, 0.12);
  color: #f59e0b;
}

.sniff-info {
  flex: 1 1 auto;
  min-width: 0;
}

.sniff-name {
  font-size: 13px;
  font-weight: 500;
  color: var(--foreground);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.sniff-meta {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-top: 2px;
  font-size: 11px;
  color: var(--muted-foreground);
}

.sniff-audio-tag {
  padding: 1px 6px;
  border-radius: var(--radius-full);
  background: rgba(16, 185, 129, 0.12);
  color: var(--success);
  font-size: 10px;
  font-weight: 500;
}

.sniff-dl-btn {
  width: 28px;
  height: 28px;
  border-radius: var(--radius-md);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--primary);
  color: var(--primary-foreground);
  border: none;
  cursor: pointer;
  flex-shrink: 0;
  transition: all var(--duration-fast);
}

.sniff-dl-btn:hover:not(:disabled) {
  filter: brightness(1.08);
  transform: translateY(-1px);
}

.sniff-dl-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* ═══ Phase 2: 增强下载卡片 ═══ */

.side-block .dl-card:nth-child(odd) {
  background: var(--surface-container);
}

.side-block .dl-card:nth-child(even) {
  background: var(--card);
}

.dl-card.enhanced.done {
  opacity: 0.85;
}

.dl-card.enhanced.paused {
  border-color: var(--warning, #f59e0b);
}

.dl-card.enhanced.cancelled,
.dl-card.enhanced.error {
  opacity: 0.6;
}

.dl-card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  margin-bottom: var(--space-2);
}

.dl-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

.dl-action-btn {
  width: 24px;
  height: 24px;
  border-radius: var(--radius-md);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--surface-container);
  color: var(--muted-foreground);
  border: none;
  cursor: pointer;
  transition: all var(--duration-fast);
}

.dl-action-btn:hover {
  background: var(--surface-container-high);
  color: var(--foreground);
}

.dl-progress-text {
  font-variant-numeric: tabular-nums;
  font-weight: 500;
}

.dl-speed {
  font-variant-numeric: tabular-nums;
  color: var(--primary);
  font-weight: 500;
}

.dl-status {
  font-size: 11px;
}

.dl-status.dl-done {
  color: var(--success);
}

.dl-status.dl-paused {
  color: var(--warning, #f59e0b);
}

.dl-status.dl-cancelled {
  color: var(--muted-foreground);
}

.dl-status.dl-error {
  color: var(--error);
}

.dl-fill.paused {
  background: var(--warning, #f59e0b);
}

.dl-fill.cancelled {
  background: var(--muted-foreground);
}

.dl-fill.error {
  background: var(--error);
}

/* ─── 浮层遮罩 ─── */
.drawer-backdrop {
  position: absolute;
  inset: 0;
  background: rgba(15, 17, 34, 0.4);
  z-index: 40;
}

.custom-scroll::-webkit-scrollbar { width: 6px; height: 6px; }
.custom-scroll::-webkit-scrollbar-thumb { background: var(--surface-container-high); border-radius: 3px; }

/* ═══ 多端适配 ═══
   ≥1200px：三栏静态
   900–1199px：右栏滑出面板（下载按钮唤出）
   <900px：左栏抽屉（汉堡按钮唤出）+ 地址栏紧凑 */
@media (max-width: 1199px) {
  .browser-rightbar {
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    z-index: 50;
    width: 260px;
    transform: translateX(100%);
    transition: transform var(--duration-normal) var(--easing-default);
    box-shadow: var(--shadow-3);
  }
  .browser-rightbar.open {
    transform: translateX(0);
  }
}

@media (max-width: 899px) {
  .menu-btn { display: inline-flex; }

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

  /* 地址栏在极窄屏隐藏（历史记录/快速标签承担导航） */
  .address-bar { display: none; }
  .btn-parse { padding: 0 var(--space-3); }
}

@media (prefers-reduced-motion: reduce) {
  .browser-rightbar,
  .browser-sidebar {
    transition: none;
  }
  .dl-fill { transition: none; }
  .bounds-pill.nomatch { animation: none; }
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

/* ─── 收藏记录视图 ─── */
.favorites-view-area {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--background);
}

.favorites-header {
  flex: 0 0 auto;
  padding: var(--space-4) var(--space-5);
  border-bottom: 1px solid var(--border);
  background: var(--surface);
}

.favorites-title {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: 15px;
  font-weight: 600;
  color: var(--foreground);
}

.favorites-title svg {
  color: var(--primary);
}

.favorites-count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 20px;
  height: 20px;
  padding: 0 6px;
  background: var(--primary);
  color: var(--primary-foreground);
  font-size: 11px;
  font-weight: 600;
  border-radius: 999px;
}

.favorites-list {
  flex: 1 1 auto;
  overflow-y: auto;
  padding: var(--space-4);
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.favorite-card {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  cursor: pointer;
  transition: all var(--duration-fast);
}

.favorite-card:hover {
  background: var(--surface-container);
  border-color: var(--primary);
  box-shadow: 0 0 0 1px var(--ring);
}

.favorite-icon {
  flex: 0 0 auto;
  width: 40px;
  height: 40px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--surface-container);
  border-radius: var(--radius-md);
  color: var(--muted-foreground);
}

.favorite-icon.video {
  color: #ef4444;
  background: rgba(239, 68, 68, 0.1);
}

.favorite-icon.audio {
  color: #f59e0b;
  background: rgba(245, 158, 11, 0.1);
}

.favorite-icon.image {
  color: #3b82f6;
  background: rgba(59, 130, 246, 0.1);
}

.favorite-info {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.favorite-name {
  font-size: 14px;
  font-weight: 500;
  color: var(--foreground);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.favorite-meta {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.favorite-url {
  font-size: 12px;
  color: var(--muted-foreground);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 300px;
}

.favorite-time {
  font-size: 11px;
  color: var(--muted-foreground);
  opacity: 0.8;
}

.favorite-delete-btn {
  flex: 0 0 auto;
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-md);
  color: var(--muted-foreground);
  transition: all var(--duration-fast);
}

.favorite-delete-btn:hover {
  background: var(--error);
  color: white;
}

.favorites-empty {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-3);
  color: var(--muted-foreground);
}

.favorites-empty svg {
  opacity: 0.4;
}

.empty-title {
  font-size: 15px;
  font-weight: 500;
  color: var(--foreground);
}

.empty-sub {
  font-size: 13px;
  text-align: center;
  max-width: 280px;
  line-height: 1.5;
}

.favorites-list::-webkit-scrollbar { width: 6px; }
.favorites-list::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
.favorites-list::-webkit-scrollbar-track { background: transparent; }
</style>
