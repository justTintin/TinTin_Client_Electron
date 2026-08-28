// ═══════════════════════════════════════════════════════════════
// hotspot-capture.js — 今日热点采集（P4 补齐，对照原版移植）
//
// 基准（零 Python 移植）：
//   · apps/asset-browser/renderer/app.js        HOTSPOT_PAGES / captureHotspots
//     （依次打开各平台热榜页，隐藏采集，不打扰用户浏览器）
//   · apps/asset-browser/preload-webview.js L1188+  热榜 API 拦截解析（逐段对照）
//   · apps/asset-browser/main.js L171            append-hotspot-manifest（追加 + date）
//   · studio/utils/asset_browser_client.py L203  launch_hotspot_capture（auto_quit 语义）
//
// 载体替换：原版「隐藏 <webview> + preload 拦截 fetch/XHR payload」
// → Electron 主进程「隐藏 BrowserView（bounds 移出可视区）+ CDP debugger
//   Network.getResponseBody 拦截同一批热榜 API 响应」，解析规则逐行一致。
// 清单写入 userData/hotspots/hotspots_sync.json（新客户端无 studio 目录）。
// ═══════════════════════════════════════════════════════════════

const { BrowserView, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

// ── 采集页清单（对照原版 app.js L1072-1077：zhihu 已注释隐藏）──
const HOTSPOT_PAGES = [
  { platform: 'douyin', url: 'https://www.douyin.com/hot' },
  // { platform: 'zhihu', url: 'https://www.zhihu.com/hot' },        // 暂时隐藏
  { platform: 'xiaohongshu', url: 'https://www.xiaohongshu.com/explore' },
  { platform: 'bilibili', url: 'https://www.bilibili.com/v/popular/rank/all' },
]

// ── 时序（对照原版 _waitWebviewLoad(9000, 3500) + 滚动后 1500ms）──
const SETTLE_MS = 3500
const SCROLL_WAIT_MS = 1500

// ── 热榜 API 解析（逐段对照原版 preload-webview.js L1191-1242）──

/** 抖音热榜：aweme/v1/web/hot/search/list */
function _parseDouyin(payload) {
  const wl = (payload.data && (payload.data.word_list || payload.data.data)) || payload.word_list || []
  return (wl || []).map((w, i) => ({
    platform: 'douyin',
    title: w.word || w.sentence || w.title || '',
    rank: (w.position !== undefined ? w.position + 1 : i + 1),
    hot: w.hot_value || w.hotValue || w.hot_score || 0,
    url: w.word ? `https://www.douyin.com/search/${encodeURIComponent(w.word)}` : '',
  })).filter((x) => x.title)
}

/** 知乎热榜：api/v3/feed/topstory/hot-lists/total（页面已隐藏，解析保留对照） */
function _parseZhihu(payload) {
  if (!payload || !Array.isArray(payload.data)) return []
  return payload.data.map((it, i) => {
    const t = it.target || {}
    return {
      platform: 'zhihu',
      title: t.title || (t.title_area && t.title_area.text) || (t.question && t.question.title) || '',
      rank: i + 1,
      hot: it.detail_text || (t.metrics_area && t.metrics_area.text) || '',
      url: t.id ? `https://www.zhihu.com/question/${t.id}` : (it.card_id ? `https://www.zhihu.com/${it.card_id}` : ''),
    }
  }).filter((x) => x.title)
}

/** 小红书热点：api/sns/web/v1/search/hotlist 或 hot_list */
function _parseXiaohongshu(payload) {
  if (!payload || !payload.data) return []
  const arr = payload.data.items || payload.data.hot_query || payload.data.list || []
  return (arr || []).map((it, i) => ({
    platform: 'xiaohongshu',
    title: it.title || it.query || it.name || '',
    rank: i + 1,
    hot: it.score || it.hot_value || '',
    url: (it.title || it.query) ? `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(it.title || it.query)}` : '',
  })).filter((x) => x.title)
}

/** B站热门排行：x/web-interface/ranking 或 /popular */
function _parseBilibili(payload) {
  const arr = (payload.data && (payload.data.list || payload.data.item)) || []
  return (arr || []).map((it, i) => ({
    platform: 'bilibili',
    title: it.title || '',
    rank: i + 1,
    hot: it.stat && it.stat.view !== undefined ? (it.stat.view >= 10000 ? (it.stat.view / 10000).toFixed(1) + '万播放' : it.stat.view + '播放') : '',
    url: it.bvid ? `https://www.bilibili.com/video/${it.bvid}` : '',
  })).filter((x) => x.title)
}

/** URL → 解析器映射（与原版四个 if 分支的 includes 匹配一致） */
function hotspotParserForUrl(url) {
  const u = String(url || '')
  if (u.includes('aweme/v1/web/hot/search/list')) return _parseDouyin
  if (u.includes('feed/topstory/hot-lists')) return _parseZhihu
  if (u.includes('sns/web/v1/search/hot')) return _parseXiaohongshu
  if (u.includes('x/web-interface/ranking') || u.includes('x/web-interface/popular')) return _parseBilibili
  return null
}

/**
 * 解析热榜 API 响应体 → 条目数组（纯函数，供单测）。
 * @param {string} url 命中的 API URL
 * @param {object} payload 已 JSON.parse 的响应体
 * @returns {Array<{platform,title,rank,hot,url}>}
 */
function parseHotspotPayload(url, payload) {
  const parser = hotspotParserForUrl(url)
  if (!parser) return []
  try { return parser(payload) } catch (_) { return [] }
}

/** 安全 JSON.parse（CDP body 可能带 BOM/空串） */
function safeJsonParse(text) {
  try { return JSON.parse(String(text || '')) } catch (_) { return null }
}

// ── DOM 兜底（对照原版 _hotspotDomScript：仅 xiaohongshu 有兜底脚本；
//    zhihu 已隐藏页面不再采集，douyin/bilibili 靠 API 拦截）──
function domFallbackScript(platform) {
  if (platform === 'xiaohongshu') {
    return `(() => { const out=[]; const seen=new Set();
      document.querySelectorAll('a[href*="/explore/"], a[href*="/search_result"], .note-item').forEach(el=>{
        const t=el.querySelector('.title')||el.querySelector('span')||el;
        const title=(t.textContent||'').trim();
        const a=el.tagName==='A'?el:el.querySelector('a');
        if(title && title.length>3 && !seen.has(title)){seen.add(title); out.push({title, url:a?a.href:''});}
      });
      return out.slice(0,40); })()`
  }
  return 'null'
}

// ── 清单写入（对照原版 append-hotspot-manifest：追加 + date 字段）──

function hotspotManifestPath(userDataDir) {
  return path.join(userDataDir, 'hotspots', 'hotspots_sync.json')
}

/**
 * 追加热榜条目到清单（含日期，供后续趋势合并）。
 * @returns {{ ok: boolean, count: number, date: string, error?: string }}
 */
function appendHotspotManifest(userDataDir, items) {
  const manifestPath = hotspotManifestPath(userDataDir)
  try {
    if (!Array.isArray(items) || items.length === 0) return { ok: true, count: 0, date: _today() }
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true })
    let arr = []
    if (fs.existsSync(manifestPath)) {
      try { arr = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) } catch (_) { arr = [] }
      if (!Array.isArray(arr)) arr = []
    }
    const date = _today()
    for (const it of items) arr.push({ ...it, date })
    fs.writeFileSync(manifestPath, JSON.stringify(arr, null, 2), 'utf-8')
    return { ok: true, count: items.length, date }
  } catch (e) {
    return { ok: false, count: 0, date: _today(), error: String((e && e.message) || e) }
  }
}

function _today() {
  return new Date().toISOString().slice(0, 10) // YYYY-MM-DD（对照原版）
}

// ── 采集 runner ──

function _sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

/** 去重（对照原版 platform|title 键） */
function _dedupe(items) {
  const out = []
  for (const it of items) {
    const key = it.platform + '|' + it.title
    if (!out.some((x) => (x.platform + '|' + x.title) === key)) out.push(it)
  }
  return out
}

/**
 * 采集今日各平台热榜（隐藏 BrowserView，不打扰用户浏览器）。
 * @param {{ userDataDir: string, onProgress?: (p:{platform:string,index:number,total:number})=>void }} opts
 * @returns {Promise<[boolean, number|string]>} 对齐项目 [ok, 数据|错误信息] 元组约定
 */
async function captureHotspots(opts) {
  const userDataDir = (opts && opts.userDataDir) || ''
  const onProgress = (opts && opts.onProgress) || null
  if (!userDataDir) return [false, '采集失败：userData 目录不可用']

  // 防并发：采集中重复触发直接拒绝
  if (captureHotspots._running) return [false, '热点采集中，请稍后再试']
  captureHotspots._running = true

  let view = null
  let attachedWin = null
  const items = []
  try {
    view = new BrowserView({
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    })
    const wc = view.webContents
    // CDP 拦截（等价原版 preload 内 fetch/XHR payload 拦截）
    try { await wc.debugger.attach('1.3') } catch (_) { /* 已附加则继续 */ }
    await wc.debugger.sendCommand('Network.enable').catch(() => {})
    /** requestId → url（responseReceived 记录，loadingFinished 取 body） */
    const pendingBodies = new Map()
    wc.debugger.on('message', (_ev, method, params) => {
      if (!params || !params.requestId) return
      if (method === 'Network.responseReceived') {
        const parser = hotspotParserForUrl(params.response && params.response.url)
        if (parser) pendingBodies.set(params.requestId, params.response.url)
      }
      if (method === 'Network.loadingFinished' && pendingBodies.has(params.requestId)) {
        const url = pendingBodies.get(params.requestId)
        pendingBodies.delete(params.requestId)
        wc.debugger.sendCommand('Network.getResponseBody', { requestId: params.requestId })
          .then((r) => {
            if (!r) return
            const body = r.base64Encoded ? Buffer.from(r.body, 'base64').toString('utf-8') : r.body
            const payload = safeJsonParse(body)
            if (payload) items.push(...parseHotspotPayload(url, payload))
          })
          .catch(() => {})
      }
    })

    // 挂到主窗口但 bounds 移出可视区（保持正常渲染尺寸触发懒加载，用户不可见）
    attachedWin = BrowserWindow.getAllWindows()[0] || null
    if (attachedWin) {
      attachedWin.addBrowserView(view)
      view.setBounds({ x: -2400, y: 0, width: 1200, height: 800 })
    }

    const total = HOTSPOT_PAGES.length
    for (let i = 0; i < total; i++) {
      const p = HOTSPOT_PAGES[i]
      if (onProgress) { try { onProgress({ platform: p.platform, index: i + 1, total }) } catch (_) {} }
      try { await wc.loadURL(p.url) } catch (_) { /* 部分平台 load 中断不阻塞后续 */ }
      await _sleep(SETTLE_MS) // 对照原版 settle 3500ms
      // 轻滚一下，触发懒加载的热榜接口（对照原版 scrollTo(0,1200) + 1500ms）
      try { await wc.executeJavaScript('window.scrollTo(0, 1200); true') } catch (_) {}
      await _sleep(SCROLL_WAIT_MS)
      // API 没抓到该平台 → DOM 兜底（对照原版逻辑）
      const have = items.filter((x) => x.platform === p.platform).length
      if (have === 0) {
        const script = domFallbackScript(p.platform)
        if (script !== 'null') {
          try {
            const domItems = await wc.executeJavaScript(script)
            if (Array.isArray(domItems)) {
              domItems.forEach((it, idx) => {
                items.push({ platform: p.platform, title: it.title, rank: idx + 1, hot: '', url: it.url || '' })
              })
            }
          } catch (_) {}
        }
      }
    }

    // 清单追加（对照原版 append-hotspot-manifest）
    const deduped = _dedupe(items)
    const res = deduped.length > 0 ? appendHotspotManifest(userDataDir, deduped) : { ok: true, count: 0, date: _today() }
    if (!res.ok) return [false, `采集完成但写入清单失败：${res.error}`]
    return [true, deduped.length]
  } catch (e) {
    return [false, `采集失败：${(e && e.message) || e}`]
  } finally {
    captureHotspots._running = false
    try { if (view && attachedWin) attachedWin.removeBrowserView(view) } catch (_) {}
    try { if (view) view.webContents.destroy() } catch (_) {}
  }
}

module.exports = {
  HOTSPOT_PAGES,
  parseHotspotPayload,
  domFallbackScript,
  appendHotspotManifest,
  hotspotManifestPath,
  captureHotspots,
}
