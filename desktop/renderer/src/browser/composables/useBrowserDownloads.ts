// ═══════════════════════════════════════════════════════════════
// useBrowserDownloads — Browser.vue 下载/嗅探/历史域 composable（D2 搬迁）
// 来源：views/Browser.vue 原 script setup 以下区段整体搬移（行为不变）：
//   · L297-320  右栏下载管理（will-download 卡片）
//   · L322-390  媒体嗅探面板 + B站插件状态 + B站扩展推送 + 已装扩展
//   · L481-636  嗅探下载/B站扩展链接下载/页面解析下载 + 增强任务卡片
//   · L638-777  历史记录持久化(Phase 3) + 任务暂停/取消/移除
//   · L1011-1018 持久化 debounce watch（留在定义状态的 composable 内，
//                注册时机与原 setup 时序一致）
//
// 跨域接线约定：依赖 nav 域的 isElectronShell / addressUrl /
//   getActivePlatformId / activePlatformId / activePlatformName，
//   由 Browser.vue 容器以参数显式传入；事件订阅（_subscribeEvents）保留在容器。
// D2 解耦：IPC 由 window.tintin → window.tintinBrowser（browser-preload.js）
// ═══════════════════════════════════════════════════════════════

import { computed, ref, watch } from 'vue'
import type { ComputedRef, Ref } from 'vue'
import type { BrowserPlatformId } from './useBrowserNav'
import { pickPageDownloadUrl } from './browserDownloadLogic'

export interface UseBrowserDownloadsDeps {
  isElectronShell: Ref<boolean>
  /** 地址栏 URL（nav 域状态） */
  addressUrl: Ref<string>
  getActivePlatformId: () => string | null
  /** 当前平台 ID 计算属性（nav 域），B站插件下载模式判定用 */
  activePlatformId: ComputedRef<BrowserPlatformId | null>
  /** 当前平台名计算属性（nav 域） */
  activePlatformName: ComputedRef<string>
}

/* ── 对外类型（子组件 props 复用；与原定义逐字一致） ── */
export interface SniffedMedia {
  id: string
  url: string
  name: string
  type: 'video' | 'audio' | 'image'
  size?: number
  sizeText?: string
  platformId?: string
  ts: number
  audioUrl?: string
  /** 触发下载后的任务 ID（嗅探卡片内嵌进度条绑定用） */
  taskId?: string
}
export interface BiliExtDownload {
  url: string
  download: string
  text: string
  sizeText: string
  /** 触发下载后的任务 ID（卡片内嵌进度条绑定用） */
  taskId?: string
}
export interface InstalledExtension {
  id: string
  name: string
  version: string
  path?: string
  icon?: string | null
  builtin?: boolean
  description?: string
}
export interface MediaDownloadTask {
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
export interface HistoryEntry {
  url: string
  title: string
  ts: number
  platformId?: string
}

export interface UseBrowserDownloadsReturn {
  sniffedMedia: Ref<SniffedMedia[]>
  sniffedCount: ComputedRef<number>
  biliPluginInstalled: Ref<boolean>
  loadBiliPluginState: () => Promise<void>
  biliPluginDownloadMode: ComputedRef<boolean>
  biliExtDownloads: Ref<BiliExtDownload[]>
  biliExtTitle: Ref<string>
  installedExtensions: Ref<InstalledExtension[]>
  loadInstalledExtensions: () => Promise<void>
  extIconSrc: (e: InstalledExtension) => string
  _formatBytesPhase2: (b?: number) => string
  downloadSniffedMedia: (media: SniffedMedia) => Promise<void>
  downloadBiliExtLink: (dl: BiliExtDownload) => Promise<void>
  downloadFromPage: () => Promise<void>
  mediaDownloadTasks: Ref<MediaDownloadTask[]>
  activeDownloadCount: ComputedRef<number>
  _ensureMediaTask: (id: string, partial: Partial<MediaDownloadTask>) => MediaDownloadTask
  historyEntries: Ref<HistoryEntry[]>
  addHistory: (url: string, title: string, platformId?: string) => void
  clearHistory: () => void
  navigateToHistory: (index: number) => void
  openHistoryPanel: () => void
  openDownloadsPanel: () => void
  formatHistoryTime: (ts: number) => string
  saveAllToStorage: () => Promise<void>
  loadFromStorage: () => Promise<void>
  togglePauseTask: (task: MediaDownloadTask) => Promise<void>
  cancelDownloadTask: (task: MediaDownloadTask) => Promise<void>
  removeDownloadTask: (task: MediaDownloadTask) => void
  _formatSpeed: (bps: number) => string
}

export function useBrowserDownloads(deps: UseBrowserDownloadsDeps): UseBrowserDownloadsReturn {
const {
  isElectronShell, addressUrl, getActivePlatformId,
  activePlatformId, activePlatformName,
} = deps

/* ── 媒体嗅探面板 + B站插件状态 + B站扩展推送 + 已装扩展 ── */
const sniffedMedia = ref<SniffedMedia[]>([])
const sniffedCount = computed(() => sniffedMedia.value.length)

/* ── B站下载插件可用性（装了插件 → 右栏显示"用插件下载"，不再嗅探） ── */
const biliPluginInstalled = ref<boolean>(false)
async function loadBiliPluginState(): Promise<void> {
  const t = (window as any).tintinBrowser
  if (!isElectronShell.value || !t?.browser?.extensionList) return
  try {
    const r = await t.browser.extensionList()
    biliPluginInstalled.value = !!(r?.success && r?.data?.installed)
  } catch (_) { biliPluginInstalled.value = false }
}
/** B站且已装插件：右栏 show 插件下载，不显示嗅探/解析列表 */
const biliPluginDownloadMode = computed<boolean>(() =>
  activePlatformId.value === 'bilibili' && biliPluginInstalled.value,
)

/** B站扩展推送的下载链接列表 */
const biliExtDownloads = ref<BiliExtDownload[]>([])
const biliExtTitle = ref<string>('')

/* ── 已安装扩展列表（工具栏右侧显示）：内置 B站助手 + 用户上传安装扩展 ── */
const installedExtensions = ref<InstalledExtension[]>([])
async function loadInstalledExtensions(): Promise<void> {
  const t = (window as any).tintinBrowser
  if (!isElectronShell.value || !t?.browser?.extensionList) return
  try {
    const r = await t.browser.extensionList()
    if (r?.success && r?.data?.extensions) installedExtensions.value = r.data.extensions
  } catch (_) {}
}
/** 扩展图标 file://（主进程返回扩展目录 path + icon 相对路径） */
function extIconSrc(e: InstalledExtension): string {
  if (!e?.icon || !e?.path) return ''
  return 'file://' + String(e.path).replace(/\\/g, '/') + '/' + String(e.icon).replace(/^\/+/, '')
}

function _formatBytesPhase2(b?: number): string {
  if (!b) return ''
  if (b < 1024) return b + 'B'
  if (b < 1024 * 1024) return (b / 1024).toFixed(0) + 'KB'
  if (b < 1024 * 1024 * 1024) return (b / (1024 * 1024)).toFixed(1) + 'MB'
  return (b / (1024 * 1024 * 1024)).toFixed(2) + 'GB'
}

async function downloadSniffedMedia(media: SniffedMedia): Promise<void> {
  const t = (window as any).tintinBrowser
  if (!t?.mediaDownload?.start) return
  const cur = getActivePlatformId()
  const taskId = 'mdl_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6)
  
  // 检测是否为动态加载平台（Bilibili, YouTube, 抖音等）
  // 这些平台的视频流通常被加密或分片，直接下载链接会失效
  const isDynamicPlatform = ['bilibili', 'youtube', 'douyin', 'kuaishou', 'xiaohongshu', 'weixin'].includes(cur || '')
  const needsYtdlp = isDynamicPlatform && (media.url.includes('.m3u8') || media.url.includes('.flv') || media.url.includes('video/tos') || media.url.includes('videoplayback'))
  
  try {
    await t.mediaDownload.start({
      taskId,
      url: media.url,
      audioUrl: media.audioUrl,
      filename: media.name || (media.type === 'video' ? 'video.mp4' : 'audio.mp3'),
      referer: addressUrl.value,
      platformId: cur || undefined,
      subDir: cur || undefined,
      // 动态平台的分片流必须用 yt-dlp 处理
      useYtdlp: needsYtdlp,
    })
    // 幂等创建：onProgress 可能已创建同 taskId 卡片，避免重复 key
    media.taskId = taskId
    _ensureMediaTask(taskId, {
      title: media.name || taskId,
      totalSize: media.size || 0,
      url: media.url,
    })
  } catch (e) {
    console.warn('[Browser] downloadSniffedMedia failed:', e)
  }
}

// B站扩展下载链接 → 触发下载
async function downloadBiliExtLink(dl: BiliExtDownload): Promise<void> {
  const t = (window as any).tintinBrowser
  if (!t?.mediaDownload?.start) {
    window.open(dl.url, '_blank')
    return
  }
  const taskId = 'bili_ext_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6)
  try {
    const filename = dl.download || dl.text || 'video.mp4'
    await t.mediaDownload.start({
      taskId,
      url: dl.url,
      audioUrl: (dl as any).audioUrl,
      title: dl.text,
      filename,
      referer: addressUrl.value,
      platformId: 'bilibili',
      subDir: 'bilibili',
      useYtdlp: false,
    })
    // 卡片内嵌进度：把任务 ID 回写到来源条目，SniffTab 据此渲染进度条
    dl.taskId = taskId
    _ensureMediaTask(taskId, {
      title: dl.text || filename,
      totalSize: 0,
      url: dl.url,
    })
  } catch (e) {
    console.warn('[Browser] downloadBiliExtLink failed:', e)
    window.open(dl.url, '_blank')
  }
}

// 从当前页面解析下载（针对动态加载平台的回退方案）
async function downloadFromPage(): Promise<void> {
  const t = (window as any).tintinBrowser
  if (!t?.mediaDownload?.start) return
  const cur = getActivePlatformId()
  const pageUrl = addressUrl.value
  if (!pageUrl) return

  // 仅对支持的平台启用此功能
  const supportedPlatforms = ['bilibili', 'youtube', 'douyin', 'kuaishou', 'xiaohongshu']
  if (!supportedPlatforms.includes(cur || '')) {
    alert('当前平台不支持页面解析下载')
    return
  }

  // 2026-09-01 修复：视频详情页点「页面解析下载」却传了首页 URL（SPA 页内路由时
  // 地址栏值滞后）→ 以 webview 实际 URL 优先（browser:getCurrentUrl，地址栏仅回退），
  // 平台根路径前置拒绝（首页无视频可解析，不把必败请求交给 yt-dlp）
  let realUrl: string | null = null
  try {
    const r = await t.browser?.getCurrentUrl?.(cur)
    if (r?.success && r.url) realUrl = String(r.url)
  } catch (_) { /* 取不到回退地址栏值 */ }
  const picked = pickPageDownloadUrl(realUrl, pageUrl)
  if (!picked.ok) {
    alert(picked.reason)
    return
  }

  const taskId = 'pgdl_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6)
  try {
    const platformName = activePlatformName.value || 'video'
    const safeName = `${platformName}_${Date.now()}`
    await t.mediaDownload.start({
      taskId,
      url: picked.url,  // webview 实际 URL（而非地址栏值），让 yt-dlp 解析
      filename: safeName + '.mp4',
      referer: picked.url,
      platformId: cur || undefined,
      subDir: cur || undefined,
      useYtdlp: true,  // 强制使用 yt-dlp 解析页面
    })
    // 幂等创建：onProgress 可能已创建同 taskId 卡片，避免重复 key
    _ensureMediaTask(taskId, {
      title: `${platformName} 视频 (解析下载)`,
      url: pageUrl,
    })
  } catch (e) {
    console.warn('[Browser] downloadFromPage failed:', e)
  }
}

const mediaDownloadTasks = ref<MediaDownloadTask[]>([])
const activeDownloadCount = computed(() =>
  mediaDownloadTasks.value.filter((t) => t.status === 'downloading' && !t.paused).length,
)

/**
 * 幂等创建/更新一个下载任务。
 * 手动触发（downloadSniffedMedia/downloadFromPage）与主进程 onProgress 都在创建任务，
 * 若不幂等会出现同一 taskId 的重复卡片（相同 :key），最终留下一个停在 0% 的空卡片。
 */
function _ensureMediaTask(id: string, partial: Partial<MediaDownloadTask>): MediaDownloadTask {
  let task = mediaDownloadTasks.value.find((t) => t.id === id)
  if (!task) {
    task = {
      id,
      title: id,
      progress: 0,
      status: 'downloading',
      speed: 0,
      totalSize: 0,
      downloaded: 0,
      paused: false,
      ...partial,
    }
    mediaDownloadTasks.value.unshift(task)
  } else {
    Object.assign(task, partial)
  }
  return task
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
  const t = (window as any).tintinBrowser
  if (t?.history) t.history.close()
}

function navigateToHistory(index: number): void {
  const entry = historyEntries.value[index]
  if (!entry) return
  const t = (window as any).tintinBrowser
  if (!t?.browser?.navigate) return
  const cur = getActivePlatformId()
  void t.browser.navigate({ platformId: cur, url: entry.url })
}

function openHistoryPanel(): void {
  const t = (window as any).tintinBrowser
  if (!t?.history) return
  // 获取按钮位置作为锚点
  const btn = document.querySelector('.hist-wrapper button')
  let x = 0, y = 0
  if (btn) {
    const rect = btn.getBoundingClientRect()
    x = Math.round(rect.left)
    y = Math.round(rect.bottom + 4)
  }
  // 转换为相对于主窗口的坐标（__WINDOW_BOUNDS__ 由宿主注入；未注入时为 0 偏移）
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

/** 打开下载管理浮窗（独立原生窗口，天然位于 BrowserView 之上；锚点=工具栏⬇按钮） */
function openDownloadsPanel(): void {
  const t = (window as any).tintinBrowser
  if (!t?.browser?.openDownloadsPanel) return
  const btn = document.querySelector('.browser-toolbar .dl-btn')
  let x = 0, y = 0
  if (btn) {
    const rect = (btn as HTMLElement).getBoundingClientRect()
    x = Math.round(rect.right - 400)
    y = Math.round(rect.bottom + 6)
  }
  // 相对主窗口坐标 → 屏幕绝对坐标（与 openHistoryPanel 同一套换算）
  const winBounds = (window as any).__WINDOW_BOUNDS__
  if (winBounds) {
    x += winBounds.x || 0
    y += winBounds.y || 0
  }
  t.browser.openDownloadsPanel(x, y)
}

async function saveAllToStorage(): Promise<void> {
  const t = (window as any).tintinBrowser
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
  const t = (window as any).tintinBrowser
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
  const t = (window as any).tintinBrowser
  if (!t?.mediaDownload?.pause) return
  task.paused = !task.paused
  task.status = task.paused ? 'paused' : 'downloading'
  try {
    await t.mediaDownload.pause(task.id)
  } catch (_) {}
}

async function cancelDownloadTask(task: MediaDownloadTask): Promise<void> {
  const t = (window as any).tintinBrowser
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

/* ── Phase 3: 自动持久化（嗅探/下载变化后 debounce 保存） ──── */
let _saveTimer: ReturnType<typeof setTimeout> | null = null
function _debouncedSave() {
  if (_saveTimer) clearTimeout(_saveTimer)
  _saveTimer = setTimeout(() => { void saveAllToStorage() }, 1500)
}
watch(sniffedMedia, () => _debouncedSave(), { deep: true })
watch(mediaDownloadTasks, () => _debouncedSave(), { deep: true })

return {
  sniffedMedia, sniffedCount,
  biliPluginInstalled, loadBiliPluginState, biliPluginDownloadMode,
  biliExtDownloads, biliExtTitle,
  installedExtensions, loadInstalledExtensions, extIconSrc,
  _formatBytesPhase2, downloadSniffedMedia, downloadBiliExtLink, downloadFromPage,
  mediaDownloadTasks, activeDownloadCount, _ensureMediaTask,
  historyEntries, addHistory, clearHistory, navigateToHistory, openHistoryPanel, formatHistoryTime,
  openDownloadsPanel,
  saveAllToStorage, loadFromStorage,
  togglePauseTask, cancelDownloadTask, removeDownloadTask, _formatSpeed,
}
}
