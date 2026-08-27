// ═══════════════════════════════════════════════════════════════
// thickShell-ipc.js — P1.5 厚壳化 IPC（C8：必须在 whenReady 最早期、createMainWindow 之前注册）
//
// 通道清单（白名单）：
//   ── win:* 5 条（自绘标题栏 + 窗口状态存取，§1.3.1 A3）
//     win:getState           → 返回 {minimized, maximized, isMaximizable, resizable, title, ...}
//     win:minimize           → mainWindow.minimize()
//     win:toggleMaximize     → isMaximized() ? unmaximize() : maximize()
//     win:close              → mainWindow.close()
//     win:onStateChange      → 订阅 maximize/unmaximize/minimize/restore/move/resize 变化
//
//   ── browser:* 7 条（BrowserView 真嵌入，§1.3.2 B3 + B4 + B6）
//     browser:attachPlatform       (platformId, seedUrl?) → 创建/复用 partition 隔离 BrowserView → addBrowserView → attach
//     browser:detachAll            ()                        → removeBrowserView（切工作台/关设置前必须调用，防原生层级盖内容）
//     browser:setBounds            ({x,y,w,h})              → C5 Math.max(320,w)/Math.max(200,h) 裁剪负值后 setBounds
//     browser:navigate             ({back?,forward?,reload?,url?}) → goBack/goForward/reload/loadURL；返回 {canGoBack, canGoForward, currentUrl}
//     browser:extractDOM           (platformId)             → 运行 platform 抽取脚本，返回 ExtractResult（或 NEED_LOGIN/CAPTCHA/DOM_MISMATCH E3）
//     browser:onUrlUpdated         (cb) 订阅 did-navigate 推送（渲染层刷新🔒地址栏）
//     browser:onDownloadsUpdated   (cb) 订阅 will-download 推送（渲染层刷新⬇徽章红点）
//
// 规格关联：
//   C3 no-drag z-index: 渲染层三控件 -webkit-app-region: no-drag，禁止拖拽
//   C5 bounds 裁剪：Math.max(320,w) / Math.max(200,h) / Math.floor 去小数
//   C6 切 Tab 防泄露：切工作台 Tab 调用 detachAll，主窗口保持其他 Tab 不显示
//   C7 new-window 拦截：全部 shell.openExternal，不允许 BrowserView 内开窗（通用浏览器红线）
//   U10 crashed 恢复：view.webContents.on('crashed') → 最多 3 次自动重建 view，主窗口/其他 Tab 不崩
//   E2 离线兜底：did-fail-load 注入 Luosiding 风格暗色 data:text/html 离线页
//   C14 接口一致性：platforms 5 个 = 抖音/视频号/快手/小红书/B站
// ═══════════════════════════════════════════════════════════════

const { BrowserView, session, shell, ipcMain, protocol, app } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const AdmZip = require('adm-zip')
const { URL } = require('node:url')

// ── B站扩展协议注册（只注册一次）──
let bilibiliProtoRegistered = false
let bilibiliCspBypassRegistered = false

/** B站下载插件是否已随包分发（dev=assets，打包=resources/assets）。装了插件 → B站下载交给插件，无需嗅探 */
function _bilibiliHelperInstalled() {
  return !!_findBilibiliHelperDir()
}

// ── 查找 B站扩展真实目录（dev=assets，打包=resources/assets；多候选，失败时递归探测 resources） ──
function _findBilibiliHelperDir() {
  const candidates = []
  const res = process.resourcesPath
  if (res) {
    candidates.push(path.join(res, 'assets', 'bilibili-helper'))
    candidates.push(path.join(res, 'bilibili-helper'))
  }
  candidates.push(path.join(__dirname, '..', '..', 'assets', 'bilibili-helper'))
  candidates.push(path.join(process.cwd(), 'assets', 'bilibili-helper'))
  for (const p of candidates) {
    try { if (fs.existsSync(path.join(p, 'manifest.json'))) return p } catch (_) {}
  }
  // 兜底：在 resources 下递归搜索含 bilibili-helper 的目录
  if (res) {
    try {
      const hits = []
      const walk = (dir, depth) => {
        if (depth > 4) return
        let ents
        try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch (_) { return }
        for (const en of ents) {
          if (!en.isDirectory()) continue
          const sub = path.join(dir, en.name)
          if (/bilibili-helper/i.test(en.name)) {
            try { if (fs.existsSync(path.join(sub, 'manifest.json'))) hits.push(sub) } catch (_) {}
          }
          walk(sub, depth + 1)
        }
      }
      walk(res, 0)
      if (hits.length) return hits[0]
    } catch (_) {}
  }
  return null
}

// ── B站扩展下载链接提取脚本：主进程 executeJavaScript 主动从页面 shadow DOM 提取下载地址 ──
//    支持扩展的三种链接形式：href（兼容模式）、durl（单段高级）、durls（合并模式）
const BILI_DL_EXTRACT_SCRIPT = `(function(){
  function _dec(en){ try { return JSON.parse(decodeURIComponent(en)) } catch(_){} try { return JSON.parse(en) } catch(_){} return null; }
  function _norm(u){ try { return decodeURIComponent(u) } catch(_){ return u } }
  var host = document.getElementById('bilibili-helper-host');
  if(!host || !host.shadowRoot) return { hostFound: false, downloads: [] };
  try {
    var sr = host.shadowRoot;
    var list = sr.querySelectorAll('#durls li a');
    var titleEl = sr.querySelector('#title');
    var title = (titleEl && titleEl.textContent || '').trim();
    var items = [];
    for (var i = 0; i < list.length; i++) {
      var a = list[i];
      var t = (a.textContent || '').trim();
      var sm = t.match(/\\(([^)]+)\\)/);
      var sizeText = sm ? sm[1] : '';
      var href0 = a.getAttribute('href') || '';
      if (href0 && href0 !== '#nogo' && href0.indexOf('javascript:') !== 0) {
        items.push({ url: href0, download: a.getAttribute('download') || '', text: t, sizeText: sizeText });
        continue;
      }
      var durl = a.getAttribute('durl');
      if (durl) {
        var e = _dec(durl);
        if (e && e.url) { items.push({ url: _norm(e.url), download: a.getAttribute('title') || '', text: t, sizeText: sizeText }); continue; }
      }
      var durls = a.getAttribute('durls');
      if (durls) {
        var arr = _dec(durls);
        if (Object.prototype.toString.call(arr) === '[object Array]') {
          var base = a.getAttribute('title') || '';
          for (var j = 0; j < arr.length; j++) {
            var g = arr[j];
            if (g && g.url) items.push({ url: _norm(g.url), download: base + (arr.length>1?('_p'+(j+1)):''), text: t + (arr.length>1?(' '+(j+1)):''), sizeText: sizeText });
          }
          continue;
        }
      }
    }
    return { hostFound: true, title: title, downloads: items, url: window.location.href, ts: Date.now() };
  } catch(e) { return { hostFound: true, downloads: [] }; }
})()`

// ── B站扩展：手动注入 content script（兼容 Electron）──
function _injectBilibiliHelper(wc, extPath, sess) {
  try {
    const contentScriptPath = path.join(extPath, 'bilibili-helper-content-script.js')
    if (!fs.existsSync(contentScriptPath)) {
      console.warn(`[ThickShell::bilibili] Content script not found: ${contentScriptPath}`)
      return
    }
    
    const scriptContent = fs.readFileSync(contentScriptPath, 'utf8')
    const manifestPath = path.join(extPath, 'manifest.json')
    let manifestData = { name: 'bilibili-helper', version: '3.0.4' }
    if (fs.existsSync(manifestPath)) {
      try {
        manifestData = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
      } catch (_) {}
    }
    
    // 注册自定义协议服务扩展文件
    if (!bilibiliProtoRegistered) {
      try {
        protocol.registerFileProtocol('tintin-ext', (request, callback) => {
          let urlPath = decodeURIComponent(request.url.replace('tintin-ext://', ''))
          // 处理 Windows 绝对路径 (例如 D:/...)
          if (/^[a-zA-Z]:[\\/]/.test(urlPath)) {
            urlPath = path.normalize(urlPath)
          } else {
            // 相对路径，基于 extPath
            urlPath = path.join(extPath, urlPath)
          }
          callback({ path: urlPath })
        })
        bilibiliProtoRegistered = true
        console.log(`[ThickShell::bilibili] Registered tintin-ext protocol for: ${extPath}`)
      } catch (err) {
        console.warn(`[ThickShell::bilibili] Protocol registration failed: ${err.message}`)
      }
    }
    
    const extBaseUrl = `tintin-ext://${extPath.replace(/\\/g, '/')}`
    
    // chrome.runtime polyfill + 扩展信息注入 + 主脚本
    // 幂等守卫：同一文档只完整执行一次（addScriptToEvaluateOnNewDocument 与 did-finish-load 补注会重复触发，
    // 重复执行会让 customElements.define 二次定义抛错）。SPA 跳转由 did-navigate-in-page 的 reload 兜底。
    const injectScript = `
      if (!window.__TINTIN_BILI_INJECTED__) {
      window.__TINTIN_BILI_INJECTED__ = true;
      // chrome.runtime polyfill
      (function() {
        if (!window.chrome) window.chrome = {};
        if (!window.chrome.runtime) {
          window.chrome.runtime = {
            getManifest: function() {
              return ${JSON.stringify(manifestData)};
            },
            getURL: function(path) {
              return '${extBaseUrl}/' + path.replace(/^\\//, '');
            }
          };
        }
      })();
      // 注入扩展信息占位元素
      (function() {
        const EL_ID = 'bilibili-helper-ext-content-script';
        let el = document.getElementById(EL_ID);
        if (!el) {
          el = document.createElement('div');
          el.id = EL_ID;
          el.style.display = 'none';
          // document_start 阶段 document.head 尚未解析（为 null），必须回退 documentElement，
          // 否则此处抛 TypeError 会中断整个注入脚本，扩展永远无法初始化
          (document.head || document.documentElement).appendChild(el);
        }
        el.dataset.internals = JSON.stringify({
          manifest: ${JSON.stringify(manifestData)},
          baseUrl: '${extBaseUrl}'
        });
      })();
    ` + scriptContent + `
      } // __TINTIN_BILI_INJECTED__ guard end
`
    
    // 在会话中移除 CSP 限制（允许内联脚本和 Worker）—— 只注册一次
    if (sess && !bilibiliCspBypassRegistered) {
      try {
        sess.webRequest.onHeadersReceived({ urls: ['*://*.bilibili.com/*'] }, (details, callback) => {
          const headers = details.responseHeaders || {}
          const cspKey = Object.keys(headers).find(k => k.toLowerCase() === 'content-security-policy')
          if (cspKey) {
            delete headers[cspKey]
            headers['content-security-policy'] = "default-src * 'unsafe-inline' 'unsafe-eval' 'unsafe-wasm-utils' 'self' data: blob: tintin-ext:; script-src * 'unsafe-inline' 'unsafe-eval' 'unsafe-wasm-utils' 'self' data: blob: tintin-ext:; worker-src * 'unsafe-inline' 'unsafe-eval' 'self' data: blob: tintin-ext:; style-src * 'unsafe-inline' 'self' data:; img-src * 'self' data: blob:; connect-src * 'self' data: blob:; font-src * 'self' data:;"
          }
          callback({ responseHeaders: headers })
        })
        bilibiliCspBypassRegistered = true
        console.log(`[ThickShell::bilibili] CSP bypass registered for bilibili.com`)
      } catch (err) {
        console.warn(`[ThickShell::bilibili] CSP bypass failed: ${err.message}`)
      }
    }
    
    // 使用 addScriptToEvaluateOnNewDocument 在文档开始时注入脚本
    if (wc && typeof wc.addScriptToEvaluateOnNewDocument === 'function') {
      wc.addScriptToEvaluateOnNewDocument({
        content: injectScript,
        runAt: 'document_start',
      })
      console.log(`[ThickShell::bilibili] Content script registered for document_start injection`)
    }
    
    // 如果页面已经加载，立即注入一次
    if (wc && !wc.isLoading()) {
      wc.executeJavaScript(injectScript).then(() => {
        console.log(`[ThickShell::bilibili] Content script injected immediately`)
      }).catch((err) => {
        console.warn(`[ThickShell::bilibili] Immediate injection failed: ${err.message}`)
      })
    }
    
    // 监听导航事件，在每次页面加载后重新注入
    if (wc && typeof wc.on === 'function') {
      wc.on('did-finish-load', () => {
        const url = wc.getURL()
        if (url && (url.includes('bilibili.com'))) {
          console.log(`[ThickShell::bilibili] Page loaded: ${url}, injecting content script`)
          wc.executeJavaScript(injectScript).then(() => {
            console.log(`[ThickShell::bilibili] Content script injected after page load`)
          }).catch((err) => {
            console.warn(`[ThickShell::bilibili] Post-load injection failed: ${err.message}`)
          })
        }
      })
      // SPA 内页跳转（pushState，如首页→视频详情页）不触发 did-finish-load；
      // content script 在非视频文档不会建立 URL 监听，跳到视频页后会永远沉默。
      // 检测到"文档已注入但扩展未初始化（无 host 元素）"时整页 reload 一次，让脚本在新文档完整初始化。
      wc.on('did-navigate-in-page', (_e, navUrl, isMainFrame) => {
        try {
          if (!isMainFrame) return
          const url = navUrl || wc.getURL() || ''
          if (!/bilibili\.com\/(video\/(av|bv)|bangumi\/play)/i.test(url)) return
          Promise.resolve(wc.executeJavaScript(`(function(){
            if (!window.__TINTIN_BILI_INJECTED__) return 'FRESH'
            if (document.getElementById('bilibili-helper-host')) return 'ACTIVE'
            return 'NEED_RELOAD'
          })()`)).then((state) => {
            if (state === 'NEED_RELOAD') {
              console.log(`[ThickShell::bilibili] SPA navigate to video page without initialized helper, reloading: ${url}`)
              wc.reload()
            }
          }).catch(() => {})
        } catch (_) {}
      })
    }
  } catch (err) {
    console.warn(`[ThickShell::bilibili] Injection error: ${err.message}`)
  }
}

// ── 媒体嗅探辅助 ──
function _formatBytes(bytes, decimals = 2) {
  if (!bytes) return '0 B'
  if (bytes === 0) return '0 Bytes'
  const k = 1024
  const dm = decimals < 0 ? 0 : decimals
  const sizes = ['Bytes', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i]
}

const ALLOWED_PROTOCOLS = ['http:', 'https:', 'file:', 'ws:', 'wss:', 'data:', 'blob:', 'about:', 'chrome-extension:', 'devtools:']

function _isAudioUrl(urlStr) {
  const lower = urlStr.toLowerCase()
  return lower.includes('.mp3') || lower.includes('mime=audio') || lower.includes('media-audio') ||
    lower.includes('-30216') || lower.includes('-30232') || lower.includes('-30280') ||
    lower.includes('-30250') || lower.includes('audio')
}

function _sniffMediaFromHeaders(responseHeaders, url) {
  const contentTypeKey = Object.keys(responseHeaders || {}).find(k => k.toLowerCase() === 'content-type')
  const contentType = contentTypeKey ? responseHeaders[contentTypeKey][0] : ''

  let isMedia = false
  let mediaType = ''

  if (contentType) {
    const ct = contentType.toLowerCase()
    if (ct.startsWith('video/') || ct.startsWith('audio/')) {
      isMedia = true
      mediaType = ct.startsWith('audio/') ? 'audio' : 'video'
      if (mediaType === 'video' && _isAudioUrl(url)) mediaType = 'audio'
    } else if (ct.includes('application/vnd.apple.mpegurl') || ct.includes('application/x-mpegurl') || ct.includes('application/octet-stream')) {
      const lowerUrl = url.toLowerCase()
      if (lowerUrl.includes('.m3u8') || lowerUrl.includes('.ts') || lowerUrl.includes('.mp4') || lowerUrl.includes('.mp3') || lowerUrl.includes('.m4s') || lowerUrl.includes('videoplayback')) {
        isMedia = true
        mediaType = _isAudioUrl(url) ? 'audio' : 'video'
      }
    }
  }

  if (!isMedia) {
    const lowerUrl = url.toLowerCase()
    if (lowerUrl.includes('.mp4') || lowerUrl.includes('.m3u8') || lowerUrl.includes('.mp3') || lowerUrl.includes('.webm') || lowerUrl.includes('.m4s') || lowerUrl.includes('.flv') || lowerUrl.includes('videoplayback')) {
      isMedia = true
      mediaType = _isAudioUrl(url) ? 'audio' : 'video'
    }
  }

  if (!isMedia || url.includes('127.0.0.1') || url.includes('localhost') || url.startsWith('file:')) {
    return null
  }

  let filename = '媒体素材'
  try {
    const parsed = new URL(url)
    filename = path.basename(parsed.pathname) || '媒体素材'
  } catch (_) {}
  filename = filename.split('?')[0]

  if (url.includes('videoplayback')) {
    filename = 'youtube_video_' + Math.random().toString(36).substring(2, 7)
  } else if (url.includes('video/tos') || url.includes('video_')) {
    filename = 'douyin_video_' + Math.random().toString(36).substring(2, 7)
  }

  const fileExt = mediaType === 'audio' ? '.mp3' : '.mp4'
  if (!filename.includes('.')) filename += fileExt

  let totalSize = 0
  const crKey = Object.keys(responseHeaders || {}).find(k => k.toLowerCase() === 'content-range')
  if (crKey && responseHeaders[crKey][0]) {
    const m = responseHeaders[crKey][0].match(/\/(\d+)$/)
    if (m) totalSize = parseInt(m[1], 10)
  }
  if (!totalSize) {
    const clKey = Object.keys(responseHeaders || {}).find(k => k.toLowerCase() === 'content-length')
    if (clKey && responseHeaders[clKey][0]) totalSize = parseInt(responseHeaders[clKey][0], 10)
  }

  return {
    url,
    type: mediaType,
    name: filename,
    size: totalSize,
    sizeText: totalSize > 0 ? _formatBytes(totalSize) : '网络流自动嗅探',
  }
}

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
}
const PLATFORM_IDS = Object.keys(PLATFORM_DEFS)

// ═══════════════════════════════════════════════════════════════
// 扩展管理器：上传 crx/zip → 解压到 userData/extensions → 对每个平台分隔离 session 逐个 loadExtension
//   逐 session 加载：保持各平台 cookie/登录态隔离（电商多店铺安全），扩展 content script 按 manifest.matches 在各平台页面生效
// ═══════════════════════════════════════════════════════════════
const _extManager = {
  root: null,          // userData/extensions
  manifest: [],        // 已安装扩展清单 [{ id, name, version, path, icon, addedAt }]
  manifestFile: null,
  // 计算清单指纹：内容变更时推送 renderer 刷新工具栏/面板
  _fingerprint: '',

  init() {
    try {
      this.root = path.join(app.getPath('userData'), 'extensions')
      this.manifestFile = path.join(this.root, 'manifest.json')
      fs.mkdirSync(this.root, { recursive: true })
      this._loadManifest()
    } catch (_) {}
  },
  _loadManifest() {
    try {
      if (fs.existsSync(this.manifestFile)) {
        this.manifest = JSON.parse(fs.readFileSync(this.manifestFile, 'utf8'))
        if (!Array.isArray(this.manifest)) this.manifest = []
      }
    } catch (_) { this.manifest = [] }
  },
  _saveManifest() {
    try { fs.writeFileSync(this.manifestFile, JSON.stringify(this.manifest, null, 2), 'utf8') } catch (_) {}
  },
  _fingerprintOf(list) {
    try { return list.map(e => `${e.id}@${e.version}`).join(',') } catch (_) { return '' }
  },
  // 对单个扩展目录，加载到"指定平台 session"；返回 {id,name,version}
  _loadIntoSession(extDir, sess) {
    try {
      const ext = sess.loadExtension(extDir)
      // loadExtension 返回 Promise；此处同步返回 extDir 相关，实际结果由调用方 await
      return ext
    } catch (_) { return null }
  },
  // 获取所有平台/网页的隔离 session（含可能已创建的）
  _allSessions() {
    const sess = []
    for (const id of PLATFORM_IDS) {
      try { sess.push(session.fromPartition(PLATFORM_DEFS[id].partition, { cache: true })) } catch (_) {}
    }
    return sess
  },
  // 把一个扩展目录加载到全部分离 session（幂等：已加载的会被 loadExtension 去重）
  _loadExtToAllSessions(extDir) {
    const results = []
    for (const s of this._allSessions()) {
      try { results.push(s.loadExtension(extDir)) } catch (_) {}
    }
    return Promise.allSettled(results)
  },
  // 安装：接收 crx/zip 文件源路径 → 解压到 root/<id>/ → loadExtension 全 session → 持久化
  async install(filePath) {
    if (!filePath) return { success: false, message: '未选择文件' }
    try {
      const extDir = this._extractPackage(filePath)
      if (!extDir) return { success: false, message: '无法解析扩展包（需为 manifest.json 的 zip 或 crx）' }
      // 读取解析出的 manifest 基本信息
      const mf = JSON.parse(fs.readFileSync(path.join(extDir, 'manifest.json'), 'utf8'))
      const id = (mf.key ? String(mf.key).slice(0, 32) : null) || path.basename(extDir)
      const entry = {
        id,
        name: mf.name || '未命名扩展',
        version: mf.version || '—',
        path: extDir,
        icon: (mf.icons && (mf.icons['128'] || mf.icons['48'] || mf.icons['32'] || mf.icons['16'])) || null,
        addedAt: Date.now(),
      }
      // 先移除同 id 旧版本，再加载新版（避免重复）
      this._removeExtensionEntry(id)
      await this._loadExtToAllSessions(extDir)
      this.manifest.push(entry)
      this._saveManifest()
      this._bump()
      return { success: true, data: entry, message: `已安装：${entry.name} v${entry.version}` }
    } catch (e) {
      return { success: false, message: '安装失败：' + (e.message || e) }
    }
  },
  _removeExtensionEntry(id) {
    const idx = this.manifest.findIndex(e => e.id === id)
    if (idx >= 0) this.manifest.splice(idx, 1)
  },
  // 卸载：从清单移除 + userData 删除目录 + 各 session removeExtension
  uninstall(id) {
    try {
      const entry = this.manifest.find(e => e.id === id)
      if (!entry) return { success: false, message: '扩展不存在' }
      for (const s of this._allSessions()) {
        try { s.removeExtension(id) } catch (_) {}
      }
      this._removeExtensionEntry(id)
      this._saveManifest()
      try { fs.rmSync(entry.path, { recursive: true, force: true }) } catch (_) {}
      this._bump()
      return { success: true, message: `已卸载：${entry.name}` }
    } catch (e) { return { success: false, message: '卸载失败：' + (e.message || e) } }
  },
  // 列表：内置 B站下载助手 + 已装用户扩展
  list() {
    const builtin = _builtinExtension()
    return { installed: true, extensions: [builtin, ...this.manifest] }
  },
  // 通知渲染层扩展列表已变化
  _bump() {
    try {
      const f = this._fingerprintOf(this.manifest)
      if (f === this._fingerprint) return
      this._fingerprint = f
      const mw = require('electron').BrowserWindow.getAllWindows().find(w => !w.isDestroyed())
      if (mw) mw.webContents.send('browser:extensions-changed', { extensions: this.list().extensions })
    } catch (_) {}
  },
  // 解压 crx/zip 到 root/<dir>，返回目录；失败返回 null
  _extractPackage(src) {
    const buf = fs.readFileSync(src)
    let zipBuf = buf
    // crx：头部 "Cr24" + version(4) + pubkeyLen(4) + sigLen(4) + header
    if (buf.length >= 4 && buf[0] === 0x43 && buf[1] === 0x72 && buf[2] === 0x32 && buf[3] === 0x34) {
      if (buf.length < 16) return null
      const pubLen = buf.readUInt32LE(8)
      const sigLen = buf.readUInt32LE(12)
      const headLen = 16 + pubLen + sigLen
      if (headLen >= buf.length) return null
      zipBuf = buf.slice(headLen)
    }
    let zip
    try { zip = new AdmZip(zipBuf) } catch (_) { return null }
    const entries = zip.getEntries()
    // 校验根目录有 manifest.json（可能在子目录，做一层查找）
    let manifestEntry = entries.find(e => !e.isDirectory && e.entryName === 'manifest.json')
    let baseDir = ''
    if (!manifestEntry) {
      const inDir = entries.find(e => !e.isDirectory && /(^|\/)manifest\.json$/i.test(e.entryName) && !e.entryName.split('/').slice(1).find(x => x))
      if (inDir) {
        baseDir = inDir.entryName.split('/')[0] + '/'
        manifestEntry = inDir
      }
    }
    if (!manifestEntry) return null
    const mf = JSON.parse(manifestEntry.getData().toString('utf8')) || {}
    const id = (mf.key ? String(mf.key).slice(0, 32) : null) || ('ext_' + Math.random().toString(36).slice(2, 10))
    const outDir = path.join(this.root, id)
    fs.mkdirSync(outDir, { recursive: true })
    // 解压（含 baseDir 前缀剥离）
    for (const en of entries) {
      if (en.isDirectory) continue
      let rel = en.entryName
      if (baseDir && rel.startsWith(baseDir)) rel = rel.slice(baseDir.length)
      if (!rel) continue
      const dest = path.join(outDir, rel)
      try {
        fs.mkdirSync(path.dirname(dest), { recursive: true })
        fs.writeFileSync(dest, en.getData())
      } catch (_) {}
    }
    return fs.existsSync(path.join(outDir, 'manifest.json')) ? outDir : null
  },
}

// 内置 B站下载助手（随包分发，手动注入方案，作为"预装扩展"展示在列表顶部）
function _builtinExtension() {
  const dir = _findBilibiliHelperDir()
  if (!dir) return { id: 'bilibili-helper-builtin', name: 'B站下载助手', version: '预装', installed: true }
  let mf = null
  try { mf = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')) } catch (_) {}
  const ic = (mf && mf.icons) || {}
  return {
    id: 'bilibili-helper',
    name: (mf && mf.name) || 'B站下载助手',
    version: (mf && mf.version) || '—',
    path: dir,
    icon: ic['128'] || ic['48'] || ic['32'] || ic['16'] || null,
    builtin: true,
    description: (mf && mf.description) || 'B站视频下载辅助扩展',
  }
}
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

// ── E2 离线兜底页：Luosiding 风格（支持 light/dark 双主题，避免与用户主题强烈反差） ──
function offlinePageHTML(details, platformName, theme) {
  const isDark = theme === 'dark'
  const errCode = details?.errorCode ?? 'UNKNOWN'
  const errDesc = details?.errorDescription ?? '未连接到网络'
  const scheme = isDark
    ? `:root{ color-scheme: dark }
  html,body{ margin:0;padding:0;height:100%;width:100%;
    background: radial-gradient(1200px 600px at 20% -10%, #17193a 0%, transparent 60%), #0b0c1a;
    color:#e3e4f0; font-family: -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;
    display:flex; align-items:center; justify-content:center; }
  .card{ background:rgba(255,255,255,0.04); border:1px solid rgba(255,255,255,0.08);
    border-radius:16px; padding:18px 20px; margin:0 0 24px; text-align:left; }
  .tag{ background:rgba(99,102,241,0.18); color:#a5a8ff; }
  .kbd{ color:#b9bcd1; }
  button{ background:linear-gradient(180deg,#6366f1,#4f46e5); color:#fff; box-shadow:0 2px 8px rgba(79,70,229,0.35); }`
    : `:root{ color-scheme: light }
  html,body{ margin:0;padding:0;height:100%;width:100%;
    background:
      radial-gradient(1200px 600px at 20% -10%, rgba(99,102,241,0.14) 0%, transparent 60%),
      linear-gradient(180deg, #f7f8fc 0%, #eef1fb 100%);
    color:#1a1d2e; font-family: -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;
    display:flex; align-items:center; justify-content:center; }
  .card{ background:#ffffff; border:1px solid rgba(99,102,241,0.14);
    border-radius:16px; padding:18px 20px; margin:0 0 24px; text-align:left;
    box-shadow: 0 1px 2px rgba(15,23,42,0.04), 0 10px 30px rgba(99,102,241,0.06); }
  .tag{ background:rgba(99,102,241,0.10); color:#4f46e5; }
  .kbd{ color:#475569; }
  button{ background:linear-gradient(180deg,#6366f1,#4f46e5); color:#fff; box-shadow:0 2px 8px rgba(79,70,229,0.30); }`
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>无网络 — 螺丝钉</title>
<style>
  ${scheme}
  .c{ max-width:520px; padding:40px 32px; text-align:center; }
  .icon{ width:64px; height:64px; margin:0 auto 20px; border-radius:18px;
    background:linear-gradient(135deg,#6366f1,#8b5cf6); display:flex; align-items:center; justify-content:center;
    box-shadow: 0 12px 32px rgba(99,102,241,0.35); }
  .icon svg{ width:30px; height:30px; stroke:#fff; stroke-width:1.8; fill:none; stroke-linecap:round; stroke-linejoin:round }
  h1{ margin:0 0 8px; font-size:20px; font-weight:700; letter-spacing:0.2px }
  p.sub{ margin:0 0 24px; color:${isDark ? '#9ca1b2' : '#64748b'}; font-size:13px; line-height:1.6 }
  .row{ display:flex; align-items:center; gap:12px; margin:8px 0 }
  .row:first-child{ margin-top:0 } .row:last-child{ margin-bottom:0 }
  .tag{ font-size:11px; padding:2px 8px; border-radius:999px; }
  .kbd{ font-variant-numeric: tabular-nums; font-size:13px; }
  button{ appearance:none; border:0; padding:10px 18px; border-radius:999px;
    font-weight:600; cursor:pointer; font-size:13px; }
  button:hover{ filter:brightness(1.05) }
</style></head><body>
  <div class="c">
    <div class="icon" aria-hidden="true">
      <svg viewBox="0 0 24 24"><path d="M5 12.55a11 11 0 0 1 14.08 0"/><path d="M1.42 9a16 16 0 0 1 21.16 0"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><line x1="12" y1="20" x2="12.01" y2="20"/></svg>
    </div>
    <h1>${platformName || '网页'}暂时加载失败</h1>
    <p class="sub">请检查网络连接后重试。若平台需要登录或有风控验证，请在恢复网络后通过地址栏重新进入。</p>
    <div class="card">
      <div class="row"><span class="tag">错误码</span><span class="kbd">${String(errCode)}</span></div>
      <div class="row"><span class="tag">说明</span>  <span class="kbd">${String(errDesc)}</span></div>
    </div>
    <button onclick="location.reload()">重试</button>
  </div>
</body></html>`
}

// 结构化抽取返回（E3 要求）
function extractionError(type, message, hint) {
  return { ok: false, error: { type: type || 'EXTRACTOR_ERROR', message: message || '抽取失败', hint: hint || '' } }
}

function createThickShellIpc(ipcMain, ctx) {
  /**
   * ctx = {
   *   store,                 // electron-store（A2 共享）
   *   getMainWindow: ()=> BrowserWindow,
   *   downloadManager?,
   *   EventBus?,            // 下载总线（broadcast downloads:progress/done）
   * }
   */
  const { store, getMainWindow, EventBus } = ctx

  // 初始化扩展管理器（userData/extensions），并在启动时把已装扩展加载到各平台隔离 session
  _extManager.init()
  Promise.resolve().then(async () => {
    for (const e of _extManager.manifest) {
      try { await _extManager._loadExtToAllSessions(e.path) } catch (_) {}
    }
  })

  /** 从 electron-store 解析当前实际主题（light/dark）：system 模式下默认 light */
  function _resolveThemePref() {
    try {
      const m = store?.get?.('themeMode')
      if (m === 'dark') return 'dark'
      if (m === 'light') return 'light'
      // system / 未设置 → 默认 light（设计稿白主题），若未来要跟随系统可查 nativeTheme
      return 'light'
    } catch (_) { return 'light' }
  }

  // ─────────────────────────── win:* 5 条 ───────────────────────────
  // 给 win:* 事件订阅者一个专用 channel：每次主窗口状态变化时广播
  const stateSubKey = 'thickShell:state-change'

  function _broadcastState() {
    try {
      const w = getMainWindow && getMainWindow()
      if (!w || w.isDestroyed()) return
      const payload = _snapshotWindowState(w)
      w.webContents.send(stateSubKey, payload)
    } catch (_) { /* ignore */ }
  }

  function _snapshotWindowState(w) {
    try {
      const [width, height] = w.getSize()
      const [x, y] = w.getPosition()
      return {
        width, height, x, y,
        minimized: w.isMinimized(),
        maximized: w.isMaximized(),
        fullscreen: w.isFullScreen(),
        resizable: w.isResizable(),
        maximizable: w.isMaximizable(),
        minimizable: w.isMinimizable(),
        closable: w.isClosable(),
        focused: w.isFocused(),
        title: w.getTitle(),
      }
    } catch (_) { return null }
  }

  // 在创建窗口之后的广播注册：通过主事件循环监听（onReady->createMainWindow 之后绑定）
  let _stateBound = false
  setImmediate(() => {
    // 每 50ms 轮询一次，等到 getMainWindow() 返回实例；最多 3s
    let attempts = 0
    const timer = setInterval(() => {
      attempts++
      try {
        const w = getMainWindow && getMainWindow()
        if (w && !w.isDestroyed() && !_stateBound) {
          _stateBound = true
          clearInterval(timer)
          const evts = ['maximize', 'unmaximize', 'minimize', 'restore', 'resize', 'move', 'focus', 'blur', 'enter-full-screen', 'leave-full-screen']
          evts.forEach(ev => w.on(ev, () => _broadcastState()))
        }
      } catch (_) {}
      if (attempts > 60) clearInterval(timer)
    }, 50)
  })

  ipcMain.handle('win:getState', () => {
    try {
      const w = getMainWindow && getMainWindow()
      if (!w || w.isDestroyed()) return { success: false, error: 'NO_WINDOW' }
      return { success: true, data: _snapshotWindowState(w) }
    } catch (e) { return { success: false, error: e.message } }
  })

  ipcMain.handle('win:minimize', () => {
    try {
      const w = getMainWindow && getMainWindow()
      if (!w || w.isDestroyed()) return { success: false, error: 'NO_WINDOW' }
      w.minimize()
      return { success: true }
    } catch (e) { return { success: false, error: e.message } }
  })

  ipcMain.handle('win:toggleMaximize', () => {
    try {
      const w = getMainWindow && getMainWindow()
      if (!w || w.isDestroyed()) return { success: false, error: 'NO_WINDOW' }
      if (w.isMaximized()) w.unmaximize(); else w.maximize()
      return { success: true, data: _snapshotWindowState(w) }
    } catch (e) { return { success: false, error: e.message } }
  })

  ipcMain.handle('win:close', () => {
    try {
      const w = getMainWindow && getMainWindow()
      if (!w || w.isDestroyed()) return { success: false, error: 'NO_WINDOW' }
      // 默认行为：关闭按钮 → 隐藏到托盘（不退出进程），托盘菜单"退出"才真正 quit
      // 规格：B11/B12 关闭隐藏到托盘，防止用户误关丢任务
      try { w.hide() } catch (_) { w.close() }
      return { success: true }
    } catch (e) { return { success: false, error: e.message } }
  })

  // win:onStateChange：渲染层调用一次 → 返回一个订阅 id，后续通过 stateSubKey 推送
  // 保持对称：off 用 id 移除（由于只需要 1 个 listener，这里简化为：收到订阅时标记 listener 已注册，webContents销毁自动清理）
  let _stateSubRegistered = false
  ipcMain.handle('win:onStateChange', () => {
    try {
      _stateSubRegistered = true  // 告知主循环已有人监听（保留钩子位）
      return { success: true, channel: stateSubKey }
    } catch (e) { return { success: false, error: e.message } }
  })

  // ─────────────────────────── browser:* 7 条 + 2 条（verifyBounds + onViewReady，Cherry Studio 方案）───────────────────────────
  /** BrowserView 实例池：5 平台懒创建，partition 严格隔离 */
  const viewPool = new Map()  // platformId → { view, crashRecoveryCount, platformId, seedUrlOverride, lastBounds }
  const MAX_CRASH_VIEW = 3
  /** bounds 差异阈值（px），超过视为 NOMATCH（渲染层会重试并重算） */
  const BOUNDS_TOLERANCE_PX = 3
  /** 订阅 channel：BrowserView did-stop-loading（Cherry Studio 的 view-ready 钩子） */
  const viewReadySubKey = 'browser:view-ready:' + Math.random().toString(36).slice(2, 9)
  let _viewReadySubRegistered = false
  /** 订阅 channel：setBounds 变更后通知（可选） */
  const boundsChangedKey = 'browser:bounds-changed:' + Math.random().toString(36).slice(2, 9)
  /** 订阅 channel：媒体嗅探结果推送 */
  const mediaSniffedSubKey = 'browser:media-sniffed:' + Math.random().toString(36).slice(2, 9)
  let _mediaSniffedSubRegistered = false
  /** 订阅 channel：B站扩展下载链接推送 */
  const biliExtDlSubKey = 'browser:bili-ext-dl:' + Math.random().toString(36).slice(2, 9)
  let _biliExtDlSubRegistered = false

  /** 从 entry.view.webContents 取 isDestroyed 门禁（经验 478486） */
  function _wc(entry) {
    if (!entry?.view) return null
    try {
      const wc = entry.view.webContents
      if (!wc || wc.isDestroyed?.()) return null
      return wc
    } catch (_) { return null }
  }

  /** 计算两个矩形的最大边差（绝对值 px） */
  function _maxDelta(a, b) {
    return Math.max(
      Math.abs((a?.x || 0) - (b?.x || 0)),
      Math.abs((a?.y || 0) - (b?.y || 0)),
      Math.abs((a?.width || 0) - (b?.width || 0)),
      Math.abs((a?.height || 0) - (b?.height || 0)),
    )
  }

  function _getOrCreateView(platformId, seedUrlOverride) {
    const def = PLATFORM_DEFS[platformId]
    if (!def) throw new Error('BROWSER_PLATFORM_UNKNOWN: ' + platformId)
    const existing = viewPool.get(platformId)
    if (existing && existing.view && !existing.view.webContents.isDestroyed()) {
      return existing
    }

    const mw = getMainWindow && getMainWindow()
    if (!mw) throw new Error('NO_MAIN_WINDOW')
    // partition 隔离的 session：必须用 session 模块静态方法 fromPartition（实例上没有该方法）
    const sess = session.fromPartition(def.partition, { cache: true })
    const view = new BrowserView({
      webPreferences: {
        session: sess,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        sandboxed: true,
        disableBlinkFeatures: 'Auxclick',
        backgroundThrottling: false,
      },
    })
    view.setAutoResize({ width: false, height: false })
    const wc = view.webContents

    // ── B站扩展加载：bilibili-helper Chrome 扩展 ──
    // 使用手动注入方式，兼容 Electron 对 MV3 扩展的有限支持
    if (platformId === 'bilibili') {
      try {
        const extPath = _findBilibiliHelperDir()
        if (extPath) {
          console.log(`[ThickShell::bilibili] Loading extension from: ${extPath}`)
          _injectBilibiliHelper(wc, extPath, sess)
        } else {
          console.warn(`[ThickShell::bilibili] Extension not found (res=${process.resourcesPath})`)
        }
      } catch (err) {
        console.warn(`[ThickShell::bilibili] Extension load error: ${err.message}`)
      }
    }

    // ── Phase 1-2: 协议拦截（bytedance://, snssdk:// 等非标准协议 → 阻止系统弹窗）──
    try {
      sess.webRequest.onBeforeRequest((details, callback) => {
        try {
          const parsed = new URL(details.url)
          if (!ALLOWED_PROTOCOLS.includes(parsed.protocol)) {
            callback({ cancel: true })
            return
          }
        } catch (_) {
          callback({ cancel: true })
          return
        }
        callback({ cancel: false })
      })
    } catch (_) {}

    // ── Phase 1-1: 媒体嗅探（实时嗅探视频/音频流，推送到渲染层）──
    try {
      sess.webRequest.onHeadersReceived({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
        const media = _sniffMediaFromHeaders(details.responseHeaders, details.url)
        if (media) {
          // B站：已随包安装下载插件时，下载交给插件处理，不再嗅探（避免列表/切片帧塞满列表）
          if (platformId === 'bilibili' && _bilibiliHelperInstalled()) {
            callback({ cancel: false })
            return
          }
          // 智能化嗅探：只在详情页嗅探，主页/列表页不嗅探
          // 只检查当前页面 URL，不检查媒体请求 URL（避免列表页视频缩略图误触发）
          const entry = viewPool.get(platformId)
          const pageUrl = entry?.currentUrl || ''
          const isDetail = isDetailPage(pageUrl, platformId)
          if (!isDetail) {
            try {
              const mw2 = getMainWindow && getMainWindow()
              if (mw2 && !mw2.isDestroyed()) {
                mw2.webContents.send(mediaSniffedSubKey, {
                  platformId,
                  skipped: true,
                  reason: 'NOT_DETAIL_PAGE',
                  url: details.url,
                  ts: Date.now(),
                })
              }
            } catch (_) {}
            callback({ cancel: false })
            return
          }
          try {
            const mw2 = getMainWindow && getMainWindow()
            if (mw2 && !mw2.isDestroyed()) {
              mw2.webContents.send(mediaSniffedSubKey, { platformId, ...media, ts: Date.now() })
            }
          } catch (_) {}
        }
        callback({ cancel: false })
      })
    } catch (_) {}

    // ── Phase 1-3: 新窗口重定向 + 协议拦截（will-navigate / will-frame-navigate / will-redirect）──
    const _blockNonStandard = (navigationUrl) => {
      try {
        const parsed = new URL(navigationUrl)
        if (!ALLOWED_PROTOCOLS.includes(parsed.protocol)) return true
      } catch (_) { return true }
      return false
    }

    wc.on('will-navigate', (event, navigationUrl) => {
      if (_blockNonStandard(navigationUrl)) event.preventDefault()
    })
    wc.on('will-frame-navigate', (event, navigationUrl) => {
      if (_blockNonStandard(navigationUrl)) event.preventDefault()
    })
    wc.on('will-redirect', (event, navigationUrl) => {
      if (_blockNonStandard(navigationUrl)) event.preventDefault()
    })

    // C7：new-window → BrowserView 内导航（带协议检查，不弹窗、不交 OS）
    try {
      wc.setWindowOpenHandler(({ url }) => {
        if (_blockNonStandard(url)) return { action: 'deny' }
        if (/^https?:\/\//i.test(url)) {
          try { wc.loadURL(url) } catch (_) {}
        }
        return { action: 'deny' }
      })
    } catch (_) {}

    // did-navigate → 推送到 mainWindow：让渲染层刷新🔒胶囊地址栏
    wc.on('did-navigate', (_e, url) => {
      // 更新 viewPool 中的 currentUrl，用于媒体嗅探智能判断
      const entry = viewPool.get(platformId)
      if (entry) entry.currentUrl = url
      // 检测 URL 实际所属平台（可能与 BrowserView 的 platformId 不同）
      const detectedPlatform = detectPlatformFromUrl(url)
      try {
        const mw2 = getMainWindow && getMainWindow()
        if (mw2 && !mw2.isDestroyed()) mw2.webContents.send('browser:url-updated', { platformId, detectedPlatform, url, ts: Date.now() })
      } catch (_) {}
    })
    wc.on('did-navigate-in-page', (_e, url) => {
      // 子框架导航也更新 URL
      const entry = viewPool.get(platformId)
      if (entry) entry.currentUrl = url
      const detectedPlatform = detectPlatformFromUrl(url)
      try {
        const mw2 = getMainWindow && getMainWindow()
        if (mw2 && !mw2.isDestroyed()) mw2.webContents.send('browser:url-updated', { platformId, detectedPlatform, url, ts: Date.now(), inPage: true })
      } catch (_) {}
    })

    // E2：did-fail-load → 注入 Luosiding 风格离线页（按当前主题亮/暗）
    wc.on('did-fail-load', (_e, errCode, errDesc, validatedUrl, isMainFrame) => {
      if (!isMainFrame) return
      // 非用户取消类错误（-3=ABORTED），取消不弹离线页
      if (errCode === -3) return
      try {
        const th = _resolveThemePref()
        const html = offlinePageHTML({ errorCode: errCode, errorDescription: errDesc }, def.name, th)
        wc.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html)).catch(() => {})
      } catch (_) {}
    })

    // Cherry Studio：did-stop-loading 广播 browser:view-ready → 渲染层收到立刻强制重算 bounds（防止页面首帧布局跳动后 BrowserView 没跟上）
    wc.on('did-stop-loading', () => {
      try {
        const mw2 = getMainWindow && getMainWindow()
        if (mw2 && !mw2.isDestroyed()) {
          mw2.webContents.send(viewReadySubKey, {
            platformId,
            url: wc.getURL?.() || '',
            title: wc.getTitle?.() || '',
            ts: Date.now(),
          })
        }
      } catch (_) {}
    })

    // ── B站扩展下载消息监听：捕获扩展 content script 通过 console.log 推送的下载链接（冗余通道，主通道为主动轮询） ──
    wc.on('console-message', (_event, _level, message) => {
      if (platformId !== 'bilibili') return
      if (!message || typeof message !== 'string') return
      if (!message.startsWith('[TINTIN_BILI_DL]')) return
      try {
        const jsonStr = message.slice('[TINTIN_BILI_DL]'.length)
        const payload = JSON.parse(jsonStr)
        const mw2 = getMainWindow && getMainWindow()
        if (mw2 && !mw2.isDestroyed() && _biliExtDlSubRegistered) {
          mw2.webContents.send(biliExtDlSubKey, {
            platformId,
            payload,
            ts: Date.now(),
          })
        }
      } catch (_) {}
    })

    // will-download → 挂全局下载总线 EventBus（下载徽章红点）
    wc.session.on('will-download', (_event, item, webContents) => {
      try {
        const mw2 = getMainWindow && getMainWindow()
        // 主流程：若有全局下载管理器 EventBus，先尝试广播 downloads:start（让其统一调度）
        if (EventBus && typeof EventBus.emit === 'function') {
          const filename = item.getFilename()
          const totalBytes = item.getTotalBytes() || 0
          const state = {
            platformId,
            sourceUrl: webContents?.getURL?.() || '',
            filename,
            totalBytes,
          }
          EventBus.emit('downloads:start', { platformId, payload: state })
        }
        // 同时单独推 browser:downloads-updated，让Browser侧栏下载卡也能实时看到
        try {
          if (mw2 && !mw2.isDestroyed()) {
            mw2.webContents.send('browser:downloads-updated', {
              platformId,
              kind: 'will-download',
              filename: item.getFilename(),
              size: item.getTotalBytes(),
              sourceUrl: webContents?.getURL?.() || '',
            })
          }
        } catch (_) {}

        // 更新下载进度
        item.on('updated', (_ev, state2) => {
          try {
            if (mw2 && !mw2.isDestroyed()) {
              mw2.webContents.send('browser:downloads-updated', {
                platformId,
                kind: state2 || 'progress',
                filename: item.getFilename(),
                receivedBytes: item.getReceivedBytes(),
                totalBytes: item.getTotalBytes(),
                percent: item.getTotalBytes() > 0
                  ? Math.floor((item.getReceivedBytes() / item.getTotalBytes()) * 100)
                  : 0,
              })
            }
          } catch (_) {}
        })
        item.once('done', (_ev, state3) => {
          try {
            if (mw2 && !mw2.isDestroyed()) {
              mw2.webContents.send('browser:downloads-updated', {
                platformId,
                kind: state3 || 'done',  // completed / cancelled / interrupted
                filename: item.getFilename(),
                savePath: item.getSavePath?.() || '',
              })
            }
          } catch (_) {}
        })
      } catch (_) {}
    })

    // U10 crashed 自动恢复（最多 3 次，主窗口/其他 Tab 不崩）
    const entry = { view, crashRecoveryCount: 0, platformId, currentUrl: '' }
    wc.on('crashed', () => {
      entry.crashRecoveryCount++
      console.warn(`[ThickShell::${platformId}] BrowserView crashed (${entry.crashRecoveryCount}/${MAX_CRASH_VIEW})`)
      if (entry.crashRecoveryCount > MAX_CRASH_VIEW) {
        try {
          const mw2 = getMainWindow && getMainWindow()
          if (mw2 && !mw2.isDestroyed()) {
            mw2.webContents.send('browser:platform-error', {
              platformId,
              type: 'VIEW_CRASH_MAX_RETRY',
              message: `${def.name}页面崩溃过多（${MAX_CRASH_VIEW} 次），请稍后重试。`,
            })
          }
        } catch (_) {}
        return
      }
      // 1 秒后重建 BrowserView
      setTimeout(() => {
        try {
          // 从池里移除旧 view（若仍 attach，先 detach）
          try {
            const mw3 = getMainWindow && getMainWindow()
            if (mw3 && !mw3.isDestroyed()) {
              const curr = mw3.getBrowserViews?.() || []
              if (curr.includes(view)) mw3.removeBrowserView(view)
            }
          } catch (_) {}
          try { wc.destroy?.() } catch (_) {}
          viewPool.delete(platformId)
          // 重新创建（递归进此函数），并自动 attach
          const recreated = _getOrCreateView(platformId, seedUrlOverride || def.seedUrl)
          const mw4 = getMainWindow && getMainWindow()
          if (mw4 && !mw4.isDestroyed()) {
            try { mw4.addBrowserView(recreated.view) } catch (_) {}
          }
        } catch (e) {
          console.warn(`[ThickShell::${platformId}] recovery failed:`, e.message)
        }
      }, 1000)
    })

    // 初始化种子 URL（仅在 URL 为空时）
    const initial = seedUrlOverride || def.seedUrl
    if (initial) {
      try {
        const curr = wc.getURL?.()
        if (!curr || curr === 'about:blank') {
          wc.loadURL(initial).catch(() => {})
        }
      } catch (_) {}
    }

    // ── B站扩展下载链接主动轮询：主进程定期从页面 shadow DOM 提取下载链接（不依赖 console-message / 注入时机） ──
    if (platformId === 'bilibili') {
      try {
        const biliPollTimer = setInterval(() => {
          try {
            const wc2 = wc.isDestroyed?.() ? null : wc
            if (!wc2) { clearInterval(biliPollTimer); return }
            const url = wc2.getURL?.() || ''
            if (!url || url === 'about:blank' || !/bilibili\.com/i.test(url)) return
            if (!_biliExtDlSubRegistered) return
            wc2.executeJavaScript(BILI_DL_EXTRACT_SCRIPT).then((res) => {
              if (!res || !res.downloads || !res.downloads.length) return
              const mw3 = getMainWindow && getMainWindow()
              if (mw3 && !mw3.isDestroyed()) {
                mw3.webContents.send(biliExtDlSubKey, {
                  platformId,
                  payload: res,
                  ts: Date.now(),
                })
              }
            }).catch(() => {})
          } catch (_) {}
        }, 2000)
        entry._biliPollTimer = biliPollTimer
      } catch (_) {}
    }

    viewPool.set(platformId, entry)
    return entry
  }

  function _detachAllFrom(mw) {
    if (!mw || mw.isDestroyed()) return
    try {
      const views = mw.getBrowserViews?.() || []
      views.forEach(v => mw.removeBrowserView(v))
    } catch (_) {}
  }

  // browser:attachPlatform
  ipcMain.handle('browser:attachPlatform', async (_e, platformId, seedUrlOverride, skipSeed) => {
    try {
      if (!PLATFORM_IDS.includes(platformId)) throw new Error('BROWSER_PLATFORM_UNKNOWN: ' + platformId)
      const entry = _getOrCreateView(platformId, seedUrlOverride)
      const mw = getMainWindow && getMainWindow()
      if (!mw || mw.isDestroyed()) throw new Error('NO_MAIN_WINDOW')
      // 先 detach 其他，确保只挂一个
      _detachAllFrom(mw)
      mw.addBrowserView(entry.view)

      // 默认导航到 seed URL（点击平台标签 = 跳转到平台首页）
      // skipSeed=true 时跳过（用于初始加载场景，由渲染层控制初始 URL）
      const def = PLATFORM_DEFS[platformId]
      const seed = seedUrlOverride || def?.seedUrl
      let loadedNewUrl = false
      if (seed && !skipSeed) {
        try {
          // 不 await stop()：stop() 在某些情况下会挂起导致 loadURL 永不执行。
          // loadURL 本身就会终止旧加载并导航到新 URL
          try { entry.view.webContents.stop() } catch (_) {}
          const loadPromise = entry.view.webContents.loadURL(seed)
          await loadPromise.catch(() => {})
          loadedNewUrl = true
        } catch (_) {}
      }
      // 默认 1024x700 窗口下的 bounds（渲染层会紧接着调用 browser:setBounds 重算）
      try {
        const [w, h] = mw.getSize()
        entry.view.setBounds({ x: 400, y: 160, width: Math.max(320, w - 420), height: Math.max(200, h - 180) })
      } catch (_) {}

      const wc = entry.view.webContents
      // 如果刚加载了新 URL，返回 seed URL 而不是旧 URL（因为页面还在加载中）
      const currentUrl = loadedNewUrl ? seed : (wc.getURL?.() || '')
      return {
        success: true,
        data: {
          platformId,
          currentUrl,
          canGoBack: !!wc.canGoBack?.(),
          canGoForward: !!wc.canGoForward?.(),
          title: wc.getTitle?.() || '',
        },
      }
    } catch (e) { return { success: false, error: e.message } }
  })

  // browser:detachAll（切工作台/关设置 Tab 调用，禁止原生层级盖其他 Tab）
  ipcMain.handle('browser:detachAll', () => {
    try {
      const mw = getMainWindow && getMainWindow()
      _detachAllFrom(mw)
      return { success: true }
    } catch (e) { return { success: false, error: e.message } }
  })

  // browser:setBounds → C5 Math.max(320,w) / Math.max(200,h) + 去小数
  //   · Cherry Studio 方案：setBounds 后立刻读 view.getBounds()（实际生效值）对比期望，返回 delta + withinTolerance
  ipcMain.handle('browser:setBounds', (_e, raw) => {
    try {
      const r = raw || {}
      const platformId = r.platformId
      if (!platformId || !PLATFORM_IDS.includes(platformId)) throw new Error('BROWSER_PLATFORM_UNKNOWN')
      const entry = viewPool.get(platformId)
      if (!entry) throw new Error('BROWSER_VIEW_NOT_ATTACHED')
      if (!entry.view) throw new Error('BROWSER_VIEW_NOT_ATTACHED')
      const mw = getMainWindow && getMainWindow()
      if (!mw || mw.isDestroyed()) throw new Error('NO_MAIN_WINDOW')
      const views = mw.getBrowserViews?.() || []
      if (!views.includes(entry.view)) mw.addBrowserView(entry.view)

      // C5 裁剪负值/过小尺寸
      const expected = {
        x: Math.floor(Math.max(0, Number(r.x) || 0)),
        y: Math.floor(Math.max(0, Number(r.y) || 0)),
        width:  Math.floor(Math.max(320, Number(r.width) || 0)),
        height: Math.floor(Math.max(200, Number(r.height) || 0)),
      }
      try { entry.view.setBounds(expected) } catch (_) {}

      // Cherry Studio：取 Electron 实际生效值（Win32 DPI/窗口边缘夹取可能有 1-2px 差异）
      let actual
      try {
        const b = entry.view.getBounds?.()
        actual = b ? { x: b.x|0, y: b.y|0, width: b.width|0, height: b.height|0 } : { ...expected }
      } catch (_) { actual = { ...expected } }

      entry.lastBounds = { ...actual }
      const deltaPx = _maxDelta(expected, actual)
      const withinTolerance = deltaPx <= BOUNDS_TOLERANCE_PX

      // 广播 bounds-changed（调试面板用，不影响主路径）
      try {
        const mw2 = getMainWindow && getMainWindow()
        if (mw2 && !mw2.isDestroyed()) {
          mw2.webContents.send(boundsChangedKey, { platformId, expected, actual, deltaPx, withinTolerance, ts: Date.now() })
        }
      } catch (_) {}

      return {
        success: true,
        data: { x: actual.x, y: actual.y, width: actual.width, height: actual.height },
        verify: {
          expected,
          actual,
          deltaPx,
          tolerancePx: BOUNDS_TOLERANCE_PX,
          withinTolerance,
        },
      }
    } catch (e) { return { success: false, error: e.message } }
  })

  // ── Cherry Studio：browser:verifyBounds（主进程读实际值 vs 渲染端期望 → 返回 delta/可见性/挂载状态）
  ipcMain.handle('browser:verifyBounds', (_e, raw) => {
    try {
      const r = raw || {}
      const platformId = r.platformId
      if (!platformId || !PLATFORM_IDS.includes(platformId)) throw new Error('BROWSER_PLATFORM_UNKNOWN')
      const entry = viewPool.get(platformId)
      if (!entry || !entry.view) throw new Error('BROWSER_VIEW_NOT_ATTACHED')
      const mw = getMainWindow && getMainWindow()
      if (!mw || mw.isDestroyed()) throw new Error('NO_MAIN_WINDOW')

      // 1) 主进程实际
      let actual
      try {
        const b = entry.view.getBounds?.()
        actual = b ? { x: b.x|0, y: b.y|0, width: b.width|0, height: b.height|0 } : null
      } catch (_) { actual = null }
      if (!actual) throw new Error('VIEW_GET_BOUNDS_FAILED')

      // 2) 是否挂载在主窗口
      const attached = (mw.getBrowserViews?.() || []).includes(entry.view)
      // 3) 是否在窗口可见范围内
      const [winW, winH] = mw.getSize?.() || [0, 0]
      const visible =
        attached &&
        actual.x >= -1 && actual.y >= -1 &&
        actual.width > 0 && actual.height > 0 &&
        actual.x + actual.width <= winW + 2 &&
        actual.y + actual.height <= winH + 2

      const expected = r.expected
        ? {
            x: Math.max(0, Number(r.expected.x) || 0) | 0,
            y: Math.max(0, Number(r.expected.y) || 0) | 0,
            width:  Math.max(320, Number(r.expected.width) || 0) | 0,
            height: Math.max(200, Number(r.expected.height) || 0) | 0,
          }
        : null
      const deltaPx = expected ? _maxDelta(expected, actual) : null
      const withinTolerance = expected ? (deltaPx ?? 0) <= BOUNDS_TOLERANCE_PX : null

      return {
        success: true,
        data: {
          platformId,
          attached,
          visible,
          actual,
          expected,
          deltaPx,
          tolerancePx: BOUNDS_TOLERANCE_PX,
          withinTolerance,
          winSize: { width: winW, height: winH },
          ts: Date.now(),
        },
      }
    } catch (e) { return { success: false, error: e.message } }
  })

  // ── Cherry Studio：browser:onViewReady（订阅 did-stop-loading 广播，收到后立刻重算 bounds）
  ipcMain.handle('browser:onViewReady', () => {
    try {
      _viewReadySubRegistered = true
      return { success: true, channel: viewReadySubKey }
    } catch (e) { return { success: false, error: e.message } }
  })

  // browser:cookieList → 列出一个平台 partition 的 cookies（登录态管理用）
  //   platformId ∈ PLATFORM_IDS（含 web）；session.fromPartition(def.partition)
  ipcMain.handle('browser:cookieList', async (_e, platformId) => {
    try {
      const def = PLATFORM_DEFS[platformId]
      if (!def) throw new Error('BROWSER_PLATFORM_UNKNOWN: ' + platformId)
      const sess = session.fromPartition(def.partition, { cache: true })
      const cookies = await sess.cookies.get({})
      const summarized = cookies.map((c) => ({
        name: c.name || '',
        domain: c.domain || '',
        path: c.path || '/',
        secure: !!c.secure,
        httpOnly: !!c.httpOnly,
        session: !!c.session,
        expirationDate: c.expirationDate,
      }))
      return { success: true, data: { platformId, count: summarized.length, cookies: summarized } }
    } catch (e) { return { success: false, error: e.message } }
  })

  // browser:cookieClear → 清空一个平台 partition 的所有 cookie
  ipcMain.handle('browser:cookieClear', async (_e, platformId) => {
    try {
      const def = PLATFORM_DEFS[platformId]
      if (!def) throw new Error('BROWSER_PLATFORM_UNKNOWN: ' + platformId)
      const sess = session.fromPartition(def.partition, { cache: true })
      await sess.cookies.flushStore()
      await sess.clearStorageData({ storages: ['cookies'] })
      await sess.cookies.flushStore()
      return { success: true, data: { platformId } }
    } catch (e) { return { success: false, error: e.message } }
  })

  // browser:extensionList → 返回已安装扩展清单（内置 B站下载助手 + userData 用户已装扩展）
  ipcMain.handle('browser:extensionList', () => {
    try {
      const data = _extManager.list()
      return { success: true, data: { installed: data.installed, path: data.path, extensions: data.extensions } }
    } catch (e) { return { success: true, data: { installed: false, extensions: [] } } }
  })
  // browser:extensionInstall → 上传 crx/zip 安装扩展（对每个平台隔离 session 逐 loadExtension）
  ipcMain.handle('browser:extensionInstall', async (_e, filePath) => {
    try { return await _extManager.install(filePath) }
    catch (e) { return { success: false, message: '安装失败：' + (e.message || e) } }
  })
  // browser:extensionUninstall → 卸载已装扩展
  ipcMain.handle('browser:extensionUninstall', (_e, id) => {
    try { return _extManager.uninstall(id) }
    catch (e) { return { success: false, message: '卸载失败：' + (e.message || e) } }
  })

  // browser:navigate → back/forward/reload/loadURL；返回 canGoBack/canGoForward/currentUrl
  ipcMain.handle('browser:navigate', (_e, payload) => {
    try {
      const p = payload || {}
      const platformId = p.platformId
      if (!platformId || !PLATFORM_IDS.includes(platformId)) return extractionError('NEED_PLATFORM', '缺少平台参数', '请先选择平台 Tab')
      const entry = viewPool.get(platformId)
      if (!entry) return extractionError('NOT_ATTACHED', '平台页面尚未打开', '先点击平台 Tab 打开')
      const wc = entry.view.webContents
      if (p.back) try { wc.goBack?.() } catch(_){}
      else if (p.forward) try { wc.goForward?.() } catch(_){}
      else if (p.reload) try { wc.reload?.() } catch(_){}
      else if (p.url) {
        const u = String(p.url).trim()
        if (u) {
          const full = /^https?:\/\//i.test(u) ? u : ('https://' + u)
          wc.loadURL(full).catch(e => { /* did-fail-load 会兜底离线页 */ })
        }
      }
      return {
        success: true,
        data: {
          platformId,
          currentUrl: wc.getURL?.() || '',
          canGoBack: !!wc.canGoBack?.(),
          canGoForward: !!wc.canGoForward?.(),
        },
      }
    } catch (e) { return { success: false, error: e.message } }
  })

  // browser:extractDOM → 运行 platform 抽取脚本（extractors/*.ts）
  //    E3 结构化错误：NEED_LOGIN / RISK_CAPTCHA / DOM_MISMATCH / NETWORK_ERROR
  ipcMain.handle('browser:extractDOM', async (_e, platformId) => {
    try {
      if (!PLATFORM_IDS.includes(platformId)) return extractionError('NEED_PLATFORM', '缺少平台参数', '')
      const entry = viewPool.get(platformId)
      if (!entry) return extractionError('NOT_ATTACHED', '平台页面尚未打开', '先点击平台 Tab 打开')
      const wc = entry.view.webContents
      if (!wc) return extractionError('NETWORK_ERROR', 'webContents 尚未就绪', '稍后再试')
      const def = PLATFORM_DEFS[platformId]

      // 1) 先确认当前 URL 非 data:text/html（离线页）
      try {
        const cur = wc.getURL?.() || ''
        if (cur.startsWith('data:text/html')) {
          return extractionError('NETWORK_ERROR', '当前处于离线兜底页，无法抽取', '请恢复网络后重试')
        }
        if (!cur || cur === 'about:blank') {
          return extractionError('DOM_MISMATCH', '页面尚未加载完成', '等待页面加载完成后再点解析')
        }
      } catch (_) {}

      // 2) 读取 extractor 脚本文件（可不存在：抛 DOM_MISMATCH+hint）
      //    先读 _common.ts（公共契约），再 prepend 到平台脚本之前
      let commonScript = ''
      try {
        const commonPath = path.resolve(__dirname, 'extractors/_common.ts')
        commonScript = fs.readFileSync(commonPath, 'utf8')
      } catch (_) {
        commonScript = ''
      }
      let script = null
      try {
        const scriptPath = path.resolve(__dirname, def.extractor)
        script = fs.readFileSync(scriptPath, 'utf8')
      } catch (_) {
        // 抽取脚本暂未实现（预留位置）→ 返回结构化错误 DOM_MISMATCH，提示：等待上线
        return extractionError(
          'DOM_MISMATCH',
          `${def.name}抽取脚本尚未上线`,
          `脚本路径 ${def.extractor} 暂未写入，请使用"解析并导入(服务端)"按钮从服务端拉取`
        )
      }

      // 3) 在 BrowserView 里同步执行抽取（永远 try/catch，主进程不崩）
      //    commonScript + '\n' + platformScript 一起注入，确保平台脚本可直接用 __TIN_EX_COMMON__
      //    平台脚本把结果赋给 var __TIN_EXTRACT_RESULT__，wrapper 显式 return（否则 IIFE 返回值会被丢弃 → undefined）
      let result = null
      try {
        const combined = commonScript + '\n' + script
        const wrapped = `(function(){
          var __TIN_EXTRACT_RESULT__;
          try { ${combined} }
          catch(e){ return { ok:false, error:{type:'DOM_MISMATCH', message:String(e.message||e), hint:'平台DOM可能已变更'} } }
          return (typeof __TIN_EXTRACT_RESULT__ !== 'undefined') ? __TIN_EXTRACT_RESULT__
            : { ok:false, error:{type:'DOM_MISMATCH', message:'抽取脚本未返回结果', hint:'平台脚本结构需升级'} }
        })()`
        result = await wc.executeJavaScript(wrapped, false)
      } catch (e) {
        return extractionError('DOM_MISMATCH', e.message || '抽取脚本执行异常', '平台 DOM 可能已变更')
      }
      // 4) 结果必须是 {ok, data?} 结构
      if (!result || typeof result !== 'object') {
        return extractionError('DOM_MISMATCH', '抽取脚本返回了非对象结构', '需修复 ' + def.extractor)
      }
      if (result.ok === false) {
        // 允许抽取脚本内部直接抛结构化错误（例：检测到登录页则返回 NEED_LOGIN）
        return { success: false, ok: false, error: result.error || { type: 'DOM_MISMATCH', message: '抽取失败' } }
      }
      return { success: true, data: result.data || null }
    } catch (e) {
      return extractionError('EXTRACTOR_ERROR', e.message || '未知错误')
    }
  })

  // browser:onUrlUpdated / onDownloadsUpdated：订阅式，渲染层 invoke 一次注册，后续通过固定 channel 推送
  ipcMain.handle('browser:onUrlUpdated', () => {
    try { return { success: true, channel: 'browser:url-updated' } }
    catch (e) { return { success: false, error: e.message } }
  })
  ipcMain.handle('browser:onDownloadsUpdated', () => {
    try { return { success: true, channel: 'browser:downloads-updated' } }
    catch (e) { return { success: false, error: e.message } }
  })
  ipcMain.handle('browser:onMediaSniffed', () => {
    try {
      _mediaSniffedSubRegistered = true
      return { success: true, channel: mediaSniffedSubKey }
    } catch (e) { return { success: false, error: e.message } }
  })
  ipcMain.handle('browser:onBiliExtDownloads', () => {
    try {
      _biliExtDlSubRegistered = true
      return { success: true, channel: biliExtDlSubKey }
    } catch (e) { return { success: false, error: e.message } }
  })

  // ── Cookie 导出辅助：将指定 partition 的 Cookie 导出为 Netscape 格式 ──
  async function _exportCookiesForPartition(partition, destPath, domains) {
    try {
      const sess = session.fromPartition(partition)
      let allCookies = []
      for (const domain of (domains || [])) {
        try {
          const cookies = await sess.cookies.get({ domain })
          allCookies = allCookies.concat(cookies)
        } catch (_) {}
        try {
          const cookies2 = await sess.cookies.get({ domain: domain.replace(/^\./, '') })
          allCookies = allCookies.concat(cookies2)
        } catch (_) {}
      }
      if (allCookies.length === 0) return { success: false, count: 0 }

      const seen = new Set()
      const unique = allCookies.filter(c => {
        const key = `${c.domain}|${c.path}|${c.name}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })

      let text = '# Netscape HTTP Cookie File\n# Generated by TinTin Client\n'
      for (const c of unique) {
        const d = c.domain.startsWith('.') ? c.domain : '.' + c.domain
        const flag = 'TRUE'
        const p = c.path || '/'
        const secure = c.secure ? 'TRUE' : 'FALSE'
        const exp = c.expirationDate ? Math.round(c.expirationDate) : Math.round(Date.now() / 1000 + 86400 * 30)
        text += `${d}\t${flag}\t${p}\t${secure}\t${exp}\t${c.name}\t${c.value}\n`
      }
      fs.writeFileSync(destPath, text, 'utf-8')
      return { success: true, count: unique.length }
    } catch (err) {
      return { success: false, error: err.message }
    }
  }

  // ── 平台 Cookie 域名映射 ──
  const PLATFORM_COOKIE_DOMAINS = {
    douyin: ['.douyin.com', 'www.douyin.com'],
    bilibili: ['.bilibili.com'],
    xiaohongshu: ['.xiaohongshu.com'],
    kuaishou: ['.kuaishou.com'],
    weixin: ['.weixin.qq.com', 'channels.weixin.qq.com'],
  }

  // browser:exportCookies：导出指定平台的 Cookie 为 Netscape 文件（给 yt-dlp 用）
  ipcMain.handle('browser:exportCookies', async (_e, { platformId, destPath }) => {
    try {
      if (!PLATFORM_IDS.includes(platformId)) return { success: false, error: 'UNKNOWN_PLATFORM' }
      const def = PLATFORM_DEFS[platformId]
      const domains = PLATFORM_COOKIE_DOMAINS[platformId] || []
      const result = await _exportCookiesForPartition(def.partition, destPath, domains)
      return result
    } catch (e) { return { success: false, error: e.message } }
  })

  // browser:getCookieStatus：检查指定平台的登录状态
  ipcMain.handle('browser:getCookieStatus', async (_e, platformId) => {
    try {
      if (!PLATFORM_IDS.includes(platformId)) return { success: false, error: 'UNKNOWN_PLATFORM' }
      const def = PLATFORM_DEFS[platformId]
      const sess = session.fromPartition(def.partition)
      const allCookies = await sess.cookies.get({})
      const domains = PLATFORM_COOKIE_DOMAINS[platformId] || []
      const matched = allCookies.filter(c => domains.some(d => c.domain.includes(d.replace(/^\./, ''))))
      const hasLoginCookie = matched.length > 0
      return {
        success: true,
        platformId,
        platformName: def.name,
        totalCookies: allCookies.length,
        matchedCookies: matched.length,
        hasLoginCookie,
        cookies: matched.map(c => ({ name: c.name, domain: c.domain, expired: c.expirationDate ? new Date(c.expirationDate * 1000).toISOString() : null })).slice(0, 20),
      }
    } catch (e) { return { success: false, error: e.message } }
  })

  // browser:getCurrentUrl：获取指定平台 BrowserView 当前 URL 和标题
  ipcMain.handle('browser:getCurrentUrl', (_e, platformId) => {
    try {
      if (!PLATFORM_IDS.includes(platformId)) return { success: false, error: 'UNKNOWN_PLATFORM' }
      const entry = viewPool.get(platformId)
      if (!entry || !entry.view) return { success: false, error: 'NOT_ATTACHED' }
      const wc = entry.view.webContents
      return {
        success: true,
        platformId,
        url: wc.getURL?.() || '',
        title: wc.getTitle?.() || '',
      }
    } catch (e) { return { success: false, error: e.message } }
  })

  return {
    PLATFORM_DEFS,
    getView: (id) => viewPool.get(id)?.view || null,
    getPool: () => viewPool,
    detachAllFrom: _detachAllFrom,
  }
}

module.exports = { createThickShellIpc, PLATFORM_DEFS }
