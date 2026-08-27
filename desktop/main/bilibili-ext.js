// ═══════════════════════════════════════════════════════════════
// bilibili-ext.js — B站下载助手扩展（从 thickShell-ipc.js 原样拆出，无逻辑改动）
//   目录查找 / tintin-ext 协议注册 / content script 手动注入 / shadow DOM 下载链接提取脚本
// ═══════════════════════════════════════════════════════════════

const path = require('node:path')
const fs = require('node:fs')
const { protocol } = require('electron')

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
    // 从标题前缀提取画质标识（如 "[4K 超高清]" / "[1080P 高码率]"），附加到每个条目便于区分
    var qm = title.match(/^\\[([^\\]]+)\\]/);
    var quality = qm ? ('[' + qm[1] + '] ') : '';
    var items = [];
    for (var i = 0; i < list.length; i++) {
      var a = list[i];
      var t = (a.textContent || '').trim();
      var sm = t.match(/\\(([^)]+)\\)/);
      var sizeText = sm ? sm[1] : '';
      var href0 = a.getAttribute('href') || '';
      if (href0 && href0 !== '#nogo' && href0.indexOf('javascript:') !== 0) {
        items.push({ url: href0, download: a.getAttribute('download') || '', text: quality + t + (sizeText?('<'+sizeText+'>'):''), sizeText: sizeText });
        continue;
      }
      var durl = a.getAttribute('durl');
      if (durl) {
        var e = _dec(durl);
        if (e && e.url) { items.push({ url: _norm(e.url), download: a.getAttribute('title') || '', text: quality + t + (sizeText?('<'+sizeText+'>'):''), sizeText: sizeText }); continue; }
      }
      var durls = a.getAttribute('durls');
      if (durls) {
        var arr = _dec(durls);
        if (Object.prototype.toString.call(arr) === '[object Array]' && arr.length) {
          // 合并模式（type="a+v"）：整组归并为「单条目」，携带视频流+音频流，
          // 由主进程分别下载两路流后 FFmpeg 合并，渲染层只显示一张进度卡。
          // 扩展源码中 durls 固定 [音频, 视频] 顺序；兜底按体积大者为视频判定。
          var base = a.getAttribute('title') || '';
          var liSize = '';
          try {
            var szSpan = a.parentElement ? a.parentElement.querySelector('span.size') : null;
            liSize = szSpan ? (szSpan.textContent || '').replace(/^[（(共]+/, '').replace(/[）)]$/, '') : '';
          } catch (_eSz) {}
          var mergeText = quality + t + (liSize ? (' (' + liSize + ')') : '');
          if (arr.length >= 2) {
            var vIdx = 0, aIdx = 1;
            var tAttr = a.getAttribute('type') || '';
            if (/a\\+v/.test(tAttr)) { aIdx = 0; vIdx = 1 }
            else {
              var s0 = Number(arr[0] && arr[0].size) || 0, s1 = Number(arr[1] && arr[1].size) || 0;
              if (s1 > s0) { vIdx = 1; aIdx = 0 } else { vIdx = 0; aIdx = 1 }
            }
            if (arr[vIdx] && arr[vIdx].url && arr[aIdx] && arr[aIdx].url) {
              items.push({ url: _norm(arr[vIdx].url), audioUrl: _norm(arr[aIdx].url), download: quality + base + '.mp4', text: mergeText, sizeText: liSize, dual: true });
              continue;
            }
          }
          if (arr[0] && arr[0].url) { items.push({ url: _norm(arr[0].url), download: quality + base + '.mp4', text: mergeText, sizeText: liSize }); }
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
    // 注：content script 是 MV3 模块化产物，内含 import.meta.url（仅用于 ffmpeg worker 路径解析）。
    // executeJavaScript/addScriptToEvaluateOnNewDocument 按经典脚本求值，import.meta 是解析期 SyntaxError，
    // 会导致整段脚本一行都不执行（调试实证：page:console 报 "Cannot use 'import.meta' outside a module"）。
    // 这里把它替换成页面 URL 表达式：语法合法化；ffmpeg 仅在合成/转码时惰性用到且与"链接提取"无关。
    const safeContent = String(scriptContent || '').replace(
      /import\.meta\.url/g,
      "(window.location && window.location.href || 'https://www.bilibili.com/')"
    )
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
    ` + safeContent + `
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

module.exports = { _bilibiliHelperInstalled, _findBilibiliHelperDir, BILI_DL_EXTRACT_SCRIPT, _injectBilibiliHelper }
