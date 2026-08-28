// ═══════════════════════════════════════════════════════════════
// thickShell-ipc.js — P1.5 厚壳化 IPC（C8：必须在 whenReady 最早期、createMainWindow 之前注册）
//
// 本文件为 IPC 调度壳；实现按模块拆分：
//   bilibili-ext.js          → B站下载助手扩展（目录查找 / 注入 / 链接提取脚本）
//   ext-manager.js           → 扩展管理器（crx/zip 安装卸载，分 session 加载）
//   platform-meta.js         → 平台定义 + URL→平台识别 + 详情页白名单
//   media-sniff-utils.js     → 媒体嗅探辅助 + 协议白名单
//   offline-page.js          → E2 离线兜底页 + E3 结构化抽取错误
//   thick-shell-viewpool.js  → BrowserView 实例池（创建/事件/崩溃恢复/轮询）
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

const { session } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const { PLATFORM_DEFS, PLATFORM_IDS, PLATFORM_COOKIE_DOMAINS } = require('./platform-meta')
const { _extManager } = require('./ext-manager')
const { extractionError } = require('./offline-page')
const { createViewPoolCtl } = require('./thick-shell-viewpool')

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

  // BrowserView 实例池控制器（订阅 key 保持每实例随机后缀语义）
  const viewCtl = createViewPoolCtl({ getMainWindow, EventBus, resolveThemePref: _resolveThemePref })
  const viewPool = viewCtl.viewPool

  // 初始化扩展管理器（userData/extensions），并在启动时把已装扩展加载到各平台隔离 session
  _extManager.init()
  Promise.resolve().then(async () => {
    for (const e of _extManager.manifest) {
      try { await _extManager._loadExtToAllSessions(e.path) } catch (_) {}
    }
  })

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

  async function attachPlatform(platformId, seedUrlOverride, skipSeed) {
    if (!PLATFORM_IDS.includes(platformId)) throw new Error('BROWSER_PLATFORM_UNKNOWN: ' + platformId)
    const entry = viewCtl.getOrCreateView(platformId, seedUrlOverride)
    const mw = getMainWindow && getMainWindow()
    if (!mw || mw.isDestroyed()) throw new Error('NO_MAIN_WINDOW')
    // 先 detach 其他，确保只挂一个
    viewCtl.detachAllFrom(mw)
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
  }

  // browser:attachPlatform
  ipcMain.handle('browser:attachPlatform', async (_e, platformId, seedUrlOverride, skipSeed) => {
    try {
      return await attachPlatform(platformId, seedUrlOverride, skipSeed)
    } catch (e) { return { success: false, error: e.message } }
  })

  // browser:detachAll（切工作台/关设置 Tab 调用，禁止原生层级盖其他 Tab）
  ipcMain.handle('browser:detachAll', () => {
    try {
      const mw = getMainWindow && getMainWindow()
      viewCtl.detachAllFrom(mw)
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
      const deltaPx = viewCtl.maxDelta(expected, actual)
      const withinTolerance = deltaPx <= viewCtl.BOUNDS_TOLERANCE_PX

      // 广播 bounds-changed（调试面板用，不影响主路径）
      try {
        const mw2 = getMainWindow && getMainWindow()
        if (mw2 && !mw2.isDestroyed()) {
          mw2.webContents.send(viewCtl.keys.boundsChangedKey, { platformId, expected, actual, deltaPx, withinTolerance, ts: Date.now() })
        }
      } catch (_) {}

      return {
        success: true,
        data: { x: actual.x, y: actual.y, width: actual.width, height: actual.height },
        verify: {
          expected,
          actual,
          deltaPx,
          tolerancePx: viewCtl.BOUNDS_TOLERANCE_PX,
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
      const deltaPx = expected ? viewCtl.maxDelta(expected, actual) : null
      const withinTolerance = expected ? (deltaPx ?? 0) <= viewCtl.BOUNDS_TOLERANCE_PX : null

      return {
        success: true,
        data: {
          platformId,
          attached,
          visible,
          actual,
          expected,
          deltaPx,
          tolerancePx: viewCtl.BOUNDS_TOLERANCE_PX,
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
      viewCtl.subFlags.markViewReady()
      return { success: true, channel: viewCtl.keys.viewReadySubKey }
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
      viewCtl.subFlags.markMediaSniffed()
      return { success: true, channel: viewCtl.keys.mediaSniffedSubKey }
    } catch (e) { return { success: false, error: e.message } }
  })
  ipcMain.handle('browser:onBiliExtDownloads', () => {
    try {
      viewCtl.subFlags.markBiliExtDl()
      return { success: true, channel: viewCtl.keys.biliExtDlSubKey }
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

  // ── 平台 Cookie 域名映射（来自 platform-meta.js 单一维护点，勿在此重复定义）──

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
    detachAllFrom: viewCtl.detachAllFrom,
  }
}

module.exports = { createThickShellIpc, PLATFORM_DEFS }
