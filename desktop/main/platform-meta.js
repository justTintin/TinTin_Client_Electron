// ═══════════════════════════════════════════════════════════════
// platform-meta.js — 平台定义 + URL→平台识别 + 详情页白名单（从 thickShell-ipc.js 原样拆出，无逻辑改动）
//   C14 接口一致性：platforms 5 个 = 抖音/视频号/快手/小红书/B站
//   （另含 web/youtube/jimeng 扩展位 + fxg 抖店分区：仅自动上架使用，不进左栏平台组）
// ═══════════════════════════════════════════════════════════════

const { URL } = require('node:url')

// ── 7 平台定义 + 网页浏览器：partition（cookie jar 隔离）+ seed URL + extractor script 路径 ──
const PLATFORM_DEFS = {
  web:         { name: '网页浏览器', partition: 'persist:tintin-web',      seedUrl: 'https://www.pinterest.com/',     extractor: null },
  douyin:      { name: '抖音',   partition: 'persist:tintin-douyin',   seedUrl: 'https://www.douyin.com',        extractor: 'extractors/douyin.ts' },
  weixin:      { name: '视频号', partition: 'persist:tintin-weixin',   seedUrl: 'https://channels.weixin.qq.com', extractor: 'extractors/weixin.ts' },
  kuaishou:    { name: '快手',   partition: 'persist:tintin-kuaishou', seedUrl: 'https://www.kuaishou.com',       extractor: 'extractors/kuaishou.ts' },
  xiaohongshu: { name: '小红书', partition: 'persist:tintin-xhs',      seedUrl: 'https://www.xiaohongshu.com',    extractor: 'extractors/xiaohongshu.ts' },
  bilibili:    { name: 'B站',    partition: 'persist:tintin-bili',     seedUrl: 'https://www.bilibili.com',       extractor: 'extractors/bilibili.ts' },
  youtube:     { name: 'YouTube', partition: 'persist:tintin-youtube', seedUrl: 'https://www.youtube.com',        extractor: 'extractors/youtube.ts' },
  jimeng:      { name: '即梦AI', partition: 'persist:tintin-jimeng',   seedUrl: 'https://jimeng.jianying.com',     extractor: 'extractors/jimeng.ts' },
  // fxg 抖店工作台：自动上架载体分区（V2 PRD 十四章；无 extractor、无详情页嗅探模式）
  fxg:         { name: '抖店',   partition: 'persist:tintin-fxg',      seedUrl: 'https://fxg.jinritemai.com',     extractor: null },
}
const PLATFORM_IDS = Object.keys(PLATFORM_DEFS)

// 各平台详情页 URL 模式（只在详情页嗅探，主页/列表页不嗅探）
// 注：使用白名单方式 - 只有匹配这些模式的 URL 才嗅探
// 所有不匹配详情页模式的 URL（包括首页、列表页、搜索页等）都不嗅探
const PLATFORM_DETAIL_PATTERNS = {
  douyin:      [/\/video\/\d+/, /\/note\/\d+/, /\/user\/[^/]+\/video\/\d+/],
  bilibili:    [/\/video\/BV[\w]+/i, /\/video\/av\d+/i, /\/medialist\/\d+/],
  kuaishou:    [/\/short-video\/\d+/, /\/f\.ks\.com\/\w+/, /\/video\/\d+/],
  xiaohongshu: [/\/explore\/[a-zA-Z0-9]+/, /\/discovery\/item\/[a-zA-Z0-9]+/, /\/item\/[a-zA-Z0-9]+/],
  weixin:      [/\/feed\/[a-zA-Z0-9_-]+/, /\/finder\/[a-zA-Z0-9_-]+/],
  youtube:     [/\/watch\?v=[a-zA-Z0-9_-]+/, /\/shorts\/[a-zA-Z0-9_-]+/],
  jimeng:      [/\/video\/\d+/, /\/creation\/\w+/, /\/workspace\/\w+/, /\/template\/\d+/],
}

// URL → 平台 ID 映射（根据域名自动识别）
const URL_TO_PLATFORM = {
  douyin:      [/douyin\.com/i, /iesdouyin\.com/i],
  bilibili:    [/bilibili\.com/i],
  kuaishou:    [/kuaishou\.com/i, /ks\.com/i],
  xiaohongshu: [/xiaohongshu\.com/i, /xhslink\.com/i],
  weixin:      [/channels\.weixin\.qq\.com/i, /weixin\.qq\.com/i, /wx\.qq\.com/i],
  youtube:     [/youtube\.com/i, /youtu\.be/i, /music\.youtube\.com/i],
  jimeng:      [/jimeng\.jianying\.com/i, /jimeng\.com/i],
}

function detectPlatformFromUrl(url) {
  if (!url) return null
  try {
    const u = new URL(url)
    const hostname = u.hostname.toLowerCase()
    for (const [id, patterns] of Object.entries(URL_TO_PLATFORM)) {
      if (patterns.some((p) => p.test(hostname))) return id
    }
  } catch {
    for (const [id, patterns] of Object.entries(URL_TO_PLATFORM)) {
      if (patterns.some((p) => p.test(url))) return id
    }
  }
  return null
}

function isDetailPage(url, platformId) {
  if (!url) return false
  // 网页浏览器（platformId='web'）：不做 URL 平台过滤，所有平台详情页都可嗅探
  if (platformId === 'web') {
    // 仅用 URL 检测实际平台，找对应的详情页模式
    const urlPlatform = detectPlatformFromUrl(url)
    if (!urlPlatform) return false
    const patterns = PLATFORM_DETAIL_PATTERNS[urlPlatform]
    if (!patterns) return false
    return patterns.some(p => p.test(url))
  }
  // 1. 先根据 URL 检测实际所属平台
  const urlPlatform = detectPlatformFromUrl(url)
  // 如果 URL 属于其他平台，跳过（不在这个 BrowserView 中嗅探其他平台的内容）
  if (urlPlatform && platformId && urlPlatform !== platformId) return false
  // 2. 使用白名单方式：只有匹配详情页模式的 URL 才返回 true
  const patterns = PLATFORM_DETAIL_PATTERNS[platformId]
  if (!patterns) return false
  return patterns.some(p => p.test(url))
}

module.exports = { PLATFORM_DEFS, PLATFORM_IDS, PLATFORM_DETAIL_PATTERNS, URL_TO_PLATFORM, detectPlatformFromUrl, isDetailPage }
