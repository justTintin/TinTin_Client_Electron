// ═══════════════════════════════════════════════════════════════
// creators-store.js — B10 达人/创作者库 + 主页全量采集（主进程）
//
// 对照基准（零 Python 移植，逐段对照原版）：
//   · apps/asset-browser/main.js L543-564 creators DB：
//       db-get-creators / db-add-creator（按 id+platform 去重）/
//       db-delete-creator（按 id+platform 过滤）
//   · apps/asset-browser/renderer/app.js L1258-1312 collectAllFromCreator：
//       取 creatorHomepageUrl（无则按平台从名称推导主页 URL）→ 确认 →
//       导航到达人主页 → 自动滚动到底 → 嗅探收集内容
//   · apps/asset-browser/renderer/app.js L1176-1196 _loadAllByScroll：
//       executeJavaScript 找最大滚动容器滚动到底，高度稳定 3 次停止
//       （maxRounds=30, stepMs=1200）
//
// 存储取舍（书面说明）：新客户端无 sqlite 浏览器库，达人与采集清单用
//   独立 JSON 文件 userData/creators/creators.json + collected.json：
//   · 达人库是业务数据集合而非配置，独立文件与 hotspots_sync.json 清单
//     模式同构（hotspot-capture.js），读写独立、备份清晰；
//   · 不写入 config-store 分域（app.json 兜底域会混入业务数据，每次
//     get/set 全量读写分域文件，且无版本/追加语义）；
//   · collected.json 采集清单后续 B8 素材入库就绪后可直接转换为导入任务
//     （衔接点：{platform, creatorName, title, url} → enqueueMaterialImport 口径）。
//
// IPC 通道（browser-preload.js 白名单收口）：
//   creators:getCreators / creators:addCreator / creators:deleteCreator
//   creators:getCollected / creators:collectFromCreator（采集）
//   creators:collect-progress（订阅：{phase, index, total}）
// ═══════════════════════════════════════════════════════════════

'use strict'
const { BrowserView } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

// ── 达人/采集清单文件路径 ──
function creatorsDir(userDataDir) {
  return path.join(userDataDir, 'creators')
}
function creatorsFilePath(userDataDir) {
  return path.join(creatorsDir(userDataDir), 'creators.json')
}
function collectedFilePath(userDataDir) {
  return path.join(creatorsDir(userDataDir), 'collected.json')
}

/** 采集清单上限（防止无限增长；超过时丢弃最旧条目） */
const MAX_COLLECTED = 5000

function _today() {
  return new Date().toISOString().slice(0, 10) // YYYY-MM-DD（对照原版）
}

// ── 达人增删纯函数（对照原版 db-add-creator / db-delete-creator）──

function normalizeCreator(creator) {
  return {
    id: String((creator && creator.id) || '').trim(),
    platform: String((creator && creator.platform) || '').trim(),
    name: String((creator && creator.name) || (creator && creator.id) || '').trim(),
    homepageUrl: String((creator && creator.homepageUrl) || '').trim(),
    addedAt: (creator && creator.addedAt) || Date.now(),
  }
}

/** 新增达人（按 id+platform 去重，已存在则原样返回；对照原 db-add-creator L548-557） */
function addCreator(list, creator) {
  const arr = Array.isArray(list) ? list : []
  const c = normalizeCreator(creator)
  if (!c.id || !c.platform) return arr
  const exists = arr.find((x) => x.id === c.id && x.platform === c.platform)
  if (exists) return arr
  return [c, ...arr]
}

/** 删除达人（按 id+platform 过滤；对照原 db-delete-creator L559-564） */
function deleteCreator(list, { id, platform }) {
  return (Array.isArray(list) ? list : []).filter((c) => !(c.id === id && c.platform === platform))
}

// ── 采集清单纯函数 ──

/** 采集链接去重（platform|url 键，对照原版嗅探去重口径） */
function dedupeCollectedItems(items) {
  const out = []
  for (const it of (Array.isArray(items) ? items : [])) {
    const key = String(it.platform || '') + '|' + String(it.url || '')
    if (!out.some((x) => String(x.platform || '') + '|' + String(x.url || '') === key)) out.push(it)
  }
  return out
}

// ── 达人主页 URL 推导（对照原 collectAllFromCreator L1271-1290 平台搜索页推导）──

function deriveProfileUrl(creatorName, platform) {
  const kw = encodeURIComponent(creatorName || '')
  if (platform === 'bilibili') return `https://search.bilibili.com/upuser?keyword=${kw}`
  if (platform === 'douyin') return `https://www.douyin.com/search/${kw}?type=user`
  if (platform === 'xiaohongshu') return `https://www.xiaohongshu.com/search_result?keyword=${kw}&source=web_search_result_notes&type=user`
  if (platform === 'youtube') return `https://www.youtube.com/results?search_query=${kw}&sp=EgIQAg%3D%3D`
  if (platform === 'kuaishou') return `https://www.kuaishou.com/search/video?searchKey=${kw}&tab=user`
  if (platform === 'weixin') return `https://channels.weixin.qq.com/search?keyword=${kw}`
  if (platform === 'jimeng') return `https://www.douyin.com/search/${kw}?type=user`
  return `https://www.douyin.com/search/${kw}?type=user` // 兜底（对照原版 else 分支）
}

// ── 自动滚动 + 链接提取（executeJavaScript 脚本，对照原版 _loadAllByScroll）──

/** 自动滚动到底（找最大可滚动容器；原版 L1181-1190 逐句对照） */
const SCROLL_SCRIPT = `(() => {
  let t = document.scrollingElement || document.documentElement;
  let m = t ? t.scrollHeight : 0;
  document.querySelectorAll('div, main, section, ul').forEach((e) => {
    if (e.scrollHeight > e.clientHeight + 300 && e.scrollHeight > m) { m = e.scrollHeight; t = e; }
  });
  try { if (t && t !== document.scrollingElement) t.scrollTop = t.scrollHeight; } catch (e) {}
  window.scrollTo(0, document.body.scrollHeight);
  return m;
})()`

/** 各平台视频详情链接特征（主页/搜索页内 a[href] 命中即采集；原版 sniffAndDownloadVideo 的平台视频页判定等价） */
const VIDEO_LINK_PATTERNS = {
  douyin:      [/\/video\/\d+/i, /\/note\/\d+/i],
  bilibili:    [/\/video\/(BV|av)\d+/i],
  kuaishou:    [/\/short-video\/\w+/i, /\/photo\/\w+/i],
  xiaohongshu: [/\/explore\/[0-9a-f]{8,}/i, /\/discovery\/item\/[0-9a-f]{8,}/i],
  weixin:      [/channels\.weixin\.qq\.com\/[^/]+\/[^/]+/i],
  youtube:     [/\/watch\?v=[\w-]{6,}/i],
  jimeng:      [],
}

/** 提取脚本（patterns 以 JSON 注入；标题取 a title/text/aria-label/img alt 兜底） */
function extractLinksScript(platform) {
  const patterns = (VIDEO_LINK_PATTERNS[platform] || []).map((r) => r.source)
  return `(() => {
    const patterns = ${JSON.stringify(patterns)};
    const out = [];
    const seen = new Set();
    for (const a of document.querySelectorAll('a[href]')) {
      let full = '';
      try { full = new URL(a.getAttribute('href'), location.href).href; } catch (e) { continue; }
      if (!patterns.some((p) => new RegExp(p, 'i').test(full))) continue;
      if (seen.has(full)) continue;
      seen.add(full);
      let title = (a.getAttribute('title') || (a.textContent || '').trim() || '').trim();
      if (!title) title = (a.getAttribute('aria-label') || '').trim();
      if (!title) { const img = a.querySelector('img'); title = img ? (img.getAttribute('alt') || '') : ''; }
      out.push({ title: title || '未命名素材', url: full, source: location.href });
    }
    return out;
  })()`
}

// ── 采集 runner ──

function _sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

/** 读 JSON 清单（缺失/损坏 → []） */
function _readJson(filePath) {
  try {
    if (!fs.existsSync(filePath)) return []
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
    return Array.isArray(raw) ? raw : []
  } catch (_) { return [] }
}

/** 追加采集条目到 collected.json（去重 + 上限裁剪） */
function appendCollected(userDataDir, items) {
  const filePath = collectedFilePath(userDataDir)
  try {
    const arr = dedupeCollectedItems([..._readJson(filePath), ...(Array.isArray(items) ? items : [])])
    const trimmed = arr.slice(-MAX_COLLECTED)
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, JSON.stringify(trimmed, null, 2), 'utf-8')
    return { ok: true, count: trimmed.length }
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) }
  }
}

/**
 * 达人主页全量采集（隐藏 BrowserView，不打扰用户浏览；对照原版
 * collectAllFromCreator + _loadAllByScroll 时序：settle 3500ms → 滚动
 * maxRounds=30/stepMs=1200/稳定 3 次 → 提取链接 → 落 collected.json）。
 * @param {object} opts
 * @param {string} opts.userDataDir
 * @param {object} opts.creator  达人 {id, platform, name, homepageUrl}
 * @param {Function} [opts.onProgress]  (phase) => void
 * @returns {Promise<[boolean, {count:number, items:object[], profileUrl:string}|string]>}
 */
async function collectFromCreator(opts) {
  const userDataDir = (opts && opts.userDataDir) || ''
  const creator = (opts && opts.creator) || {}
  const onProgress = (opts && opts.onProgress) || null
  const platform = String(creator.platform || '')
  if (!userDataDir || !platform || !creator.id) return [false, '采集失败：达人信息不完整']

  if (collectFromCreator._running) return [false, '采集进行中，请稍后再试']
  collectFromCreator._running = true

  const profileUrl = creator.homepageUrl || deriveProfileUrl(creator.name || creator.id, platform)
  const partition = `persist:tintin-${platform}`
  let view = null
  let attachedWin = null
  try {
    view = new BrowserView({
      webPreferences: { partition, contextIsolation: true, nodeIntegration: false, sandbox: true },
    })
    const wc = view.webContents
    // 挂到浏览器窗口（未开则主窗口），bounds 移出可视区（hotspot-capture.js 同法）
    attachedWin = require('electron').BrowserWindow.getAllWindows()[0] || null
    if (attachedWin) {
      attachedWin.addBrowserView(view)
      view.setBounds({ x: -2400, y: 0, width: 1200, height: 800 })
    }

    if (onProgress) { try { onProgress(`正在打开「${creator.name || creator.id}」主页…`) } catch (_) {} }
    try { await wc.loadURL(profileUrl) } catch (_) { /* 加载中断不阻塞（did-fail-load 兜底） */ }
    await _sleep(3500) // 对照原版 _waitWebviewLoad settle

    // 自动滚动加载全部（对照原版 _loadAllByScroll：maxRounds=30, stepMs=1200, 稳定 3 次）
    if (onProgress) { try { onProgress('正在自动滚动加载全部内容…') } catch (_) {} }
    let lastH = 0
    let stable = 0
    for (let i = 0; i < 30 && stable < 3; i++) {
      let h = 0
      try { h = await wc.executeJavaScript(SCROLL_SCRIPT) } catch (_) { /* 页面未就绪继续 */ }
      if (h <= lastH) stable++
      else { stable = 0; lastH = h }
      if (i < 29) await _sleep(1200)
    }

    // 提取视频链接
    if (onProgress) { try { onProgress('正在收集内容链接…') } catch (_) {} }
    let links = []
    try { links = await wc.executeJavaScript(extractLinksScript(platform), true) } catch (_) { links = [] }
    if (!Array.isArray(links)) links = []

    const date = _today()
    const items = links.map((l) => ({
      platform,
      creatorId: String(creator.id),
      creatorName: creator.name || creator.id,
      title: String(l.title || '未命名素材'),
      url: String(l.url || ''),
      source: String(l.source || profileUrl),
      date,
      collectedAt: new Date().toISOString(),
    })).filter((it) => it.url)

    const res = items.length > 0 ? appendCollected(userDataDir, items) : { ok: true, count: 0 }
    if (!res.ok) return [false, `采集完成但写入清单失败：${res.error}`]
    return [true, { count: items.length, items, profileUrl }]
  } catch (e) {
    return [false, `采集失败：${(e && e.message) || e}`]
  } finally {
    collectFromCreator._running = false
    try { if (view && attachedWin) attachedWin.removeBrowserView(view) } catch (_) {}
    try { if (view) view.webContents.destroy() } catch (_) {}
  }
}

/**
 * 创建 B10 IPC handlers（main.js 在 createMediaStorage 之后调用）。
 * ctx = { app, getBrowserWindow }
 */
function createCreatorsStoreIpc(ipcMain, ctx) {
  if (!ipcMain) throw new Error('createCreatorsStoreIpc: ipcMain is required')
  const { app, getBrowserWindow } = ctx || {}

  function _userDataDir() {
    try { return app.getPath('userData') } catch (_) { return '' }
  }
  function _loadCreators() {
    return _readJson(creatorsFilePath(_userDataDir()))
  }
  function _saveCreators(list) {
    const filePath = creatorsFilePath(_userDataDir())
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, JSON.stringify(list, null, 2), 'utf-8')
  }
  /** 采集进度广播 → 浏览器窗口（useBrowserCreators 订阅） */
  function _broadcastProgress(phase) {
    try {
      const w = getBrowserWindow && getBrowserWindow()
      if (w && !w.isDestroyed()) w.webContents.send('creators:collect-progress', { phase })
    } catch (_) {}
  }

  ipcMain.handle('creators:getCreators', () => {
    try { return { success: true, data: _loadCreators() } }
    catch (e) { return { success: false, error: (e && e.message) || String(e) } }
  })

  ipcMain.handle('creators:addCreator', (_e, creator) => {
    try {
      const next = addCreator(_loadCreators(), creator)
      _saveCreators(next)
      return { success: true, data: next }
    } catch (e) { return { success: false, error: (e && e.message) || String(e) } }
  })

  ipcMain.handle('creators:deleteCreator', (_e, payload) => {
    try {
      const next = deleteCreator(_loadCreators(), payload || {})
      _saveCreators(next)
      return { success: true, data: next }
    } catch (e) { return { success: false, error: (e && e.message) || String(e) } }
  })

  ipcMain.handle('creators:getCollected', () => {
    try { return { success: true, data: _readJson(collectedFilePath(_userDataDir())) } }
    catch (e) { return { success: false, error: (e && e.message) || String(e) } }
  })

  // creators:collectFromCreator → 达人主页全量采集（隐藏 BrowserView + 自动滚动）
  ipcMain.handle('creators:collectFromCreator', async (_e, payload) => {
    try {
      const creator = (payload && payload.creator) || null
      if (!creator || !creator.id || !creator.platform) return { success: false, error: '缺少达人参数' }
      const [ok, result] = await collectFromCreator({
        userDataDir: _userDataDir(),
        creator,
        onProgress: (phase) => _broadcastProgress(phase),
      })
      if (!ok) return { success: false, error: String(result) }
      return { success: true, data: result }
    } catch (e) {
      return { success: false, error: (e && e.message) || String(e) }
    }
  })
}

module.exports = {
  normalizeCreator,
  addCreator,
  deleteCreator,
  dedupeCollectedItems,
  deriveProfileUrl,
  VIDEO_LINK_PATTERNS,
  SCROLL_SCRIPT,
  extractLinksScript,
  appendCollected,
  collectFromCreator,
  creatorsFilePath,
  collectedFilePath,
  createCreatorsStoreIpc,
}
