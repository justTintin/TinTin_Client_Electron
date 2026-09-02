// ═══════════════════════════════════════════════════════════════
// thick-shell-viewpool.js — BrowserView 实例池（从 thickShell-ipc.js 原样拆出，无逻辑改动）
//   5 平台懒创建，partition 严格隔离；媒体嗅探 / 协议拦截 / 导航事件 / 崩溃恢复 / B站扩展轮询
// ═══════════════════════════════════════════════════════════════

const { BrowserView, session } = require('electron')
const { PLATFORM_DEFS, detectPlatformFromUrl, isDetailPage } = require('./platform-meta')
const { ALLOWED_PROTOCOLS, _sniffMediaFromHeaders } = require('./media-sniff-utils')
const { offlinePageHTML } = require('./offline-page')
const { _bilibiliHelperInstalled, _findBilibiliHelperDir, _injectBilibiliHelper, BILI_DL_EXTRACT_SCRIPT } = require('./bilibili-ext')

/**
 * 创建视图池控制器（每个 thickShell IPC 实例一次；订阅 key 保持每实例随机后缀语义）
 * 挂载/广播目标窗口：D3/D4 后为浏览器独立窗口（getWindow 由 thickShell-ipc.js 注入
 *   getBrowserWindow，未创建返回 null 时调用点全部防御跳过，绝不落到主窗口）。
 * @param {{ getWindow: ()=>BrowserWindow, EventBus?: any, resolveThemePref: ()=>string }} deps
 */
function createViewPoolCtl({ getWindow, EventBus, resolveThemePref }) {
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

    const mw = getWindow && getWindow()
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
              const mw2 = getWindow && getWindow()
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
            const mw2 = getWindow && getWindow()
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

    // did-navigate → 推送到挂载窗口（D4 后为浏览器独立窗口）：让渲染层刷新🔒胶囊地址栏
    wc.on('did-navigate', (_e, url) => {
      // 更新 viewPool 中的 currentUrl，用于媒体嗅探智能判断
      const entry = viewPool.get(platformId)
      if (entry) entry.currentUrl = url
      // 检测 URL 实际所属平台（可能与 BrowserView 的 platformId 不同）
      const detectedPlatform = detectPlatformFromUrl(url)
      try {
        const mw2 = getWindow && getWindow()
        if (mw2 && !mw2.isDestroyed()) mw2.webContents.send('browser:url-updated', { platformId, detectedPlatform, url, ts: Date.now() })
      } catch (_) {}
    })
    wc.on('did-navigate-in-page', (_e, url) => {
      // 子框架导航也更新 URL
      const entry = viewPool.get(platformId)
      if (entry) entry.currentUrl = url
      const detectedPlatform = detectPlatformFromUrl(url)
      try {
        const mw2 = getWindow && getWindow()
        if (mw2 && !mw2.isDestroyed()) mw2.webContents.send('browser:url-updated', { platformId, detectedPlatform, url, ts: Date.now(), inPage: true })
      } catch (_) {}
    })

    // E2：did-fail-load → 注入 Luosiding 风格离线页（按当前主题亮/暗）
    wc.on('did-fail-load', (_e, errCode, errDesc, validatedUrl, isMainFrame) => {
      if (!isMainFrame) return
      // 非用户取消类错误（-3=ABORTED），取消不弹离线页
      if (errCode === -3) return
      try {
        const th = resolveThemePref()
        const html = offlinePageHTML({ errorCode: errCode, errorDescription: errDesc }, def.name, th)
        wc.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html)).catch(() => {})
      } catch (_) {}
    })

    // Cherry Studio：did-stop-loading 广播 browser:view-ready → 渲染层收到立刻强制重算 bounds（防止页面首帧布局跳动后 BrowserView 没跟上）
    wc.on('did-stop-loading', () => {
      try {
        const mw2 = getWindow && getWindow()
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
        const mw2 = getWindow && getWindow()
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
        const mw2 = getWindow && getWindow()
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
          const mw2 = getWindow && getWindow()
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
            const mw3 = getWindow && getWindow()
            if (mw3 && !mw3.isDestroyed()) {
              const curr = mw3.getBrowserViews?.() || []
              if (curr.includes(view)) mw3.removeBrowserView(view)
            }
          } catch (_) {}
          try { wc.destroy?.() } catch (_) {}
          viewPool.delete(platformId)
          // 重新创建（递归进此函数），并自动 attach
          const recreated = _getOrCreateView(platformId, seedUrlOverride || def.seedUrl)
          const mw4 = getWindow && getWindow()
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
              const mw3 = getWindow && getWindow()
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
      views.forEach(v => {
        // 分离前暂停页面内 video/audio（2026-09-02 用户反馈：B站详情切到其他平台仍有
        // B站声音——removeBrowserView 只是隐藏不销毁，webContents 里的媒体会继续播放）
        try {
          v.webContents
            .executeJavaScript('try{document.querySelectorAll("video,audio").forEach(function(m){try{m.pause()}catch(e){}})}catch(e){}', true)
            .catch(() => {})
        } catch (_) {}
        try { mw.removeBrowserView(v) } catch (_) {}
      })
    } catch (_) {}
  }

  return {
    viewPool,
    keys: { viewReadySubKey, boundsChangedKey, mediaSniffedSubKey, biliExtDlSubKey },
    BOUNDS_TOLERANCE_PX,
    subFlags: {
      markViewReady: () => { _viewReadySubRegistered = true },
      markMediaSniffed: () => { _mediaSniffedSubRegistered = true },
      markBiliExtDl: () => { _biliExtDlSubRegistered = true },
    },
    maxDelta: _maxDelta,
    getOrCreateView: _getOrCreateView,
    detachAllFrom: _detachAllFrom,
  }
}

module.exports = { createViewPoolCtl }
