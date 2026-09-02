// browserDownloadLogic.ts — 浏览器页面解析下载·纯函数层（无 vue / IPC 依赖，可单测）
// 2026-09-01 用户反馈：视频详情页点「页面解析下载」却把抖音首页 URL 传给了
// yt-dlp（ERROR: Unsupported URL, exit 1）。根因：downloadFromPage 用 addressUrl
// （地址栏值），SPA 页内路由时可能滞后/未同步。修复口径：
//   · URL 解析以 webview 实际 URL（browser:getCurrentUrl，webContents.getURL()）
//     优先，地址栏值仅作回退
//   · 平台根路径（首页）没有可解析视频，前置拒绝并提示进入视频播放页，
//     不再把必败请求交给 yt-dlp

/** 页面解析下载支持的平台主机（对齐 useBrowserDownloads.downloadFromPage 的 supportedPlatforms） */
const ROOT_HOSTS = new Set([
  'www.douyin.com', 'douyin.com', 'v.douyin.com',
  'www.bilibili.com', 'bilibili.com',
  'www.kuaishou.com', 'kuaishou.com', 'v.kuaishou.com',
  'www.xiaohongshu.com', 'xiaohongshu.com', 'xhslink.com',
  'www.youtube.com', 'youtube.com', 'youtu.be',
])

/** 平台根路径判定：协议+域名（path 为空或仅 /）即视为首页，无可解析视频 */
export function isPlatformRootUrl(url: string): boolean {
  try {
    const u = new URL(String(url || ''))
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
    if (!ROOT_HOSTS.has(u.hostname.toLowerCase())) return false
    return u.pathname === '' || u.pathname === '/'
  } catch (_) {
    return false
  }
}

/** pickPageDownloadUrl 结果：ok 时携带 url，否则携带用户可读 reason */
export type PageDownloadPick =
  | { ok: true; url: string }
  | { ok: false; reason: string }

/**
 * 页面解析下载 URL 解析：
 *   · realUrl = webview 实际 URL（browser:getCurrentUrl；拿不到为 null）
 *   · fallback = 地址栏值（addressUrl，可能滞后）
 * 实际 URL 优先；两者皆平台根路径 → 拒绝（提示进入视频播放页）。
 */
export function pickPageDownloadUrl(realUrl: string | null, fallback: string): PageDownloadPick {
  const url = String(realUrl || '').trim() || String(fallback || '').trim()
  if (!url) return { ok: false, reason: '未获取到当前页面地址，请刷新页面后重试' }
  if (isPlatformRootUrl(url)) {
    return { ok: false, reason: '当前是平台首页，没有可解析的视频；请先进入视频播放页（地址含 /video/ 等路径）再试' }
  }
  return { ok: true, url }
}

/**
 * 嗅探媒体下载通道判定（2026-09-02）：
 *   · 真分片流（m3u8/flv）与需解参的 YouTube videoplayback → yt-dlp
 *   · 其余（含抖音 douyinvod/video/tos CDN 直链、/aweme/v1/play 等带签名完整媒体文件）
 *     → 直接 HTTP 下载。此前 video/tos 被强制交 yt-dlp，而 yt-dlp 对 CDN 直链
 *     没有 extractor，必报 Unsupported URL exit 1（下载历史已验证）。
 */
export function needsYtdlpForSniffedUrl(url: unknown): boolean {
  const lower = String(url || '').toLowerCase()
  if (!lower) return false
  return lower.includes('.m3u8') || lower.includes('.flv') || lower.includes('videoplayback')
}
