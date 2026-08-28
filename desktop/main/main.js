const { app, BrowserWindow, ipcMain, dialog, shell, session, protocol } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const { createTray } = require('./tray')
const { initUpdater } = require('./updater')
const { createServerProxy, httpRequest, multipartUpload, getServerUrl, setConfigStore } = require('./server-proxy')
const { createDownloadManager } = require('./download-manager')
const { createFfmpegGate } = require('./ffmpeg-gate')

// 统一 userData 路径：dev 模式用 package.json name，打包模式用 productName，
// 必须显式 setName 保持一致，否则 BrowserView 的 persist:* 分区（登录态）会丢失
try { app.setName('tintin-client-electron') } catch (_) {}

// ── A2 双模式推理模块（§1.5）──
const { createModelManager } = require('./model-manager')
const { InferenceRouter } = require('./inference-router')
const { createLocalOcr } = require('./ocr-local')
const { createVectorStore } = require('./vector-store')
const { createA2Ipc } = require('./a2-ipc')

// ── 厚壳化（P1.5：自绘标题栏 + BrowserView 真嵌入）──
const { createThickShellIpc } = require('./thickShell-ipc')
const { createMediaDownloader } = require('./media-downloader')
const { createMediaStorage } = require('./media-storage')
// 本地定时任务（P2 移植：schtasks CRUD + 到点触发接管）
const localScheduler = require('./local-scheduler')
const { purgeDeprecatedExtKeys } = require('./config-migrate')
// agent 任务 LLM 拆解（对照 agent_router.build_plan，P2 补齐）
const agentPlan = require('./agent-plan')

// electron-store：CommonJS 兼容；失败兜底内存 store（绝不阻塞启动，P1 红线）
let Store = null
try { Store = require('electron-store') } catch (_) { Store = null }

let mainWindow = null
let crashRecoveryCount = 0
const MAX_CRASH_RECOVERY = 3

// 历史面板子窗口
let historyPanelWindow = null
let _historyBlurTimer = null

function openHistoryPanel(items, anchorX, anchorY) {
  if (historyPanelWindow && !historyPanelWindow.isDestroyed()) {
    closeHistoryPanel()
  }
  
  const panelWidth = 380
  const panelHeight = 420
  
  // 计算位置：使用屏幕绝对坐标
  let x = anchorX || 100
  let y = anchorY || 100
  
  if (mainWindow && !mainWindow.isDestroyed()) {
    const winBounds = mainWindow.getBounds()
    // 如果坐标是相对于主窗口的，需要加上窗口偏移
    if (anchorX !== undefined && anchorY !== undefined) {
      // 传入的是相对主窗口的坐标，需要转换为屏幕坐标
      x = winBounds.x + anchorX
      y = winBounds.y + anchorY
    }
    
    // 确保面板在屏幕上合理位置
    const { screen } = require('electron')
    const display = screen.getDisplayMatching({ x, y, width: panelWidth, height: panelHeight })
    if (display) {
      const workArea = display.workArea
      if (x + panelWidth > workArea.x + workArea.width) {
        x = workArea.x + workArea.width - panelWidth - 10
      }
      if (y + panelHeight > workArea.y + workArea.height) {
        y = workArea.y + workArea.height - panelHeight - 10
      }
    }
  }
  
  historyPanelWindow = new BrowserWindow({
    width: panelWidth,
    height: panelHeight,
    x,
    y,
    frame: false,
    transparent: false,
    resizable: false,
    alwaysOnTop: false,
    skipTaskbar: true,
    hasShadow: true,
    show: false,  // 防止闪烁，准备好后再显示
    backgroundColor: '#ffffff',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    }
  })
  
  historyPanelWindow.setParentWindow(mainWindow)
  
  const panelHtml = path.join(__dirname, 'history-panel.html')
  historyPanelWindow.loadFile(panelHtml)
  
  // 准备好后显示窗口（防止闪烁）
  historyPanelWindow.once('ready-to-show', () => {
    if (historyPanelWindow && !historyPanelWindow.isDestroyed()) {
      historyPanelWindow.show()
    }
  })
  
  historyPanelWindow.webContents.on('did-finish-load', () => {
    historyPanelWindow.webContents.send('history:data', items || [])
  })
  
  // 延迟处理 blur，防止窗口刚创建就 blur 导致关闭
  let _ready = false
  historyPanelWindow.on('show', () => {
    _ready = true
  })
  
  historyPanelWindow.on('blur', () => {
    if (!_ready) return  // 窗口还没完全显示，忽略 blur
    // 延迟关闭，给用户一点时间
    if (_historyBlurTimer) clearTimeout(_historyBlurTimer)
    _historyBlurTimer = setTimeout(() => {
      closeHistoryPanel()
    }, 150)
  })
}

function closeHistoryPanel() {
  if (_historyBlurTimer) {
    clearTimeout(_historyBlurTimer)
    _historyBlurTimer = null
  }
  if (historyPanelWindow && !historyPanelWindow.isDestroyed()) {
    historyPanelWindow.close()
    historyPanelWindow = null
  }
}

/* ─────────── 浮动面板：扩展/设置（独立原生 BrowserWindow，天然在 BrowserView 之上 ───────────
   与历史面板同款方案：主进程创建子窗口加载独立 HTML，渲染层仅传锚点坐标。 */
let floatingPanelWindow = null
let _fpReady = false
let _fpBlurTimer = null

function _openFloatingPanel(name, htmlFile, panelWidth, panelHeight, anchorX, anchorY, data) {
  _closeFloatingPanel()
  let x = anchorX || 100
  let y = anchorY || 100
  if (mainWindow && !mainWindow.isDestroyed()) {
    const winBounds = mainWindow.getBounds()
    // 传入的是相对主窗口的坐标，转换为屏幕绝对坐标
    if (anchorX !== undefined && anchorY !== undefined) {
      x = winBounds.x + anchorX
      y = winBounds.y + anchorY
    }
    const { screen } = require('electron')
    const display = screen.getDisplayMatching({ x, y, width: panelWidth, height: panelHeight })
    if (display) {
      const wa = display.workArea
      if (x + panelWidth > wa.x + wa.width) x = wa.x + wa.width - panelWidth - 10
      if (y + panelHeight > wa.y + wa.height) y = wa.y + wa.height - panelHeight - 10
    }
  }
  floatingPanelWindow = new BrowserWindow({
    width: panelWidth,
    height: panelHeight,
    x,
    y,
    frame: false,
    transparent: false,
    resizable: false,
    alwaysOnTop: false,
    skipTaskbar: true,
    hasShadow: true,
    show: false,  // 防止闪烁，准备好后再显示
    backgroundColor: '#ffffff',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    }
  })
  floatingPanelWindow.setParentWindow(mainWindow)
  floatingPanelWindow.__panelName = name
  floatingPanelWindow.loadFile(path.join(__dirname, htmlFile))
  floatingPanelWindow.once('ready-to-show', () => {
    if (floatingPanelWindow && !floatingPanelWindow.isDestroyed()) {
      floatingPanelWindow.show()
    }
  })
  floatingPanelWindow.webContents.on('did-finish-load', () => {
    if (floatingPanelWindow && !floatingPanelWindow.isDestroyed()) {
      floatingPanelWindow.webContents.send('floating:data', data || {})
    }
  })
  let _r = false
  floatingPanelWindow.on('show', () => { _r = true })
  floatingPanelWindow.on('blur', () => {
    if (!_r) return
    if (_fpBlurTimer) clearTimeout(_fpBlurTimer)
    _fpBlurTimer = setTimeout(() => { _closeFloatingPanel() }, 150)
  })
}

function _closeFloatingPanel() {
  if (_fpBlurTimer) { clearTimeout(_fpBlurTimer); _fpBlurTimer = null }
  if (floatingPanelWindow && !floatingPanelWindow.isDestroyed()) {
    floatingPanelWindow.close()
    floatingPanelWindow = null
  }
}

function getStudioRoot() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'studio-legacy')
  }
  const devRoot = path.resolve(__dirname, '..', '..', '..')
  if (fs.existsSync(path.join(devRoot, 'studio'))) {
    return path.join(devRoot, 'studio')
  }
  return path.resolve(__dirname, '..', '..', '..')
}

function getWorkspacePath() {
  const studioRoot = getStudioRoot()
  return path.join(studioRoot, 'outputs')
}

/* ─────────── F4 frame:false 兼容兜底开关 ───────────
   任一命中 → 强制 frame:true（仅改 frame 字段，三开关绝不回退，Q2 红线）
   ① process.argv.includes('--enable-system-frame')
   ② process.env.TINTIN_USE_FRAME === '1' / 'true'
   ③ electron-store 'window.useSystemFrame' === true  */
function _useSystemFrame(store) {
  if (process.argv.includes('--enable-system-frame')) return true
  if (['1', 'true', 'yes'].includes(String(process.env.TINTIN_USE_FRAME || '').toLowerCase())) return true
  try { if (store && store.get('window.useSystemFrame') === true) return true } catch (_) {}
  return false
}

/* ─────────── 窗口状态存取：electron-store 持久化 windowState ─────────── */
function _loadWindowState(store) {
  const d = { x: undefined, y: undefined, width: 1440, height: 900, isMaximized: false }
  if (!store) return d
  try {
    const v = store.get('windowState') || {}
    if (typeof v.width === 'number' && v.width >= 1024) d.width = v.width
    if (typeof v.height === 'number' && v.height >= 700) d.height = v.height
    d.isMaximized = !!v.isMaximized
    // x/y 之后做显示器有效性校验
    if (typeof v.x === 'number' && typeof v.y === 'number') { d.x = v.x; d.y = v.y }
    return d
  } catch (_) { return d }
}

function _validateBoundsOnDisplay(state) {
  const { screen } = require('electron')
  if (!screen) return state
  const displays = screen.getAllDisplays()
  if (!displays.length) return state
  if (typeof state.x !== 'number' || typeof state.y !== 'number') {
    const p = screen.getPrimaryDisplay().workArea
    state.x = Math.round(p.x + (p.width - state.width) / 2)
    state.y = Math.round(p.y + (p.height - state.height) / 2)
    return state
  }
  // 窗口至少 100x100 要落在某个显示器工作区内，否则重置到主屏居中
  const ok = displays.some((d) => {
    const w = d.workArea
    const overlapX1 = Math.max(state.x, w.x)
    const overlapY1 = Math.max(state.y, w.y)
    const overlapX2 = Math.min(state.x + state.width,  w.x + w.width)
    const overlapY2 = Math.min(state.y + state.height, w.y + w.height)
    return (overlapX2 - overlapX1) >= 100 && (overlapY2 - overlapY1) >= 100
  })
  if (!ok) {
    const p = screen.getPrimaryDisplay().workArea
    state.x = Math.round(p.x + (p.width - state.width) / 2)
    state.y = Math.round(p.y + (p.height - state.height) / 2)
  }
  return state
}

function _saveWindowState(store, mainWindow) {
  if (!store || !mainWindow || mainWindow.isDestroyed()) return
  try {
    if (mainWindow.isMaximized() || mainWindow.isMinimized()) {
      store.set('windowState.isMaximized', mainWindow.isMaximized())
      return
    }
    const [x, y] = mainWindow.getPosition()
    const [width, height] = mainWindow.getSize()
    store.set('windowState', { x, y, width, height, isMaximized: false })
  } catch (_) { /* ignore */ }
}

let sharedCtx = {
  store: null,
  getMainWindow: () => mainWindow,
  downloadManager: null,
  EventBus: null,
}

function createMainWindow(store) {
  // 单例守卫：已有存活主窗口时直接复用，禁止重复创建
  // （否则两个窗口叠放 + 争抢同一 userData 磁盘缓存，BrowserView 只挂最后一个窗口）
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow

  const preloadPath = path.join(__dirname, '..', 'preload', 'preload.js')
  const isMac = process.platform === 'darwin'
  const ws = _validateBoundsOnDisplay(_loadWindowState(store))

  const baseWinOpts = {
    width: ws.width,
    height: ws.height,
    x: ws.x,
    y: ws.y,
    minWidth: 1024,
    minHeight: 700,
    show: false,
    // 背景色兜底（渲染端接管整体背景，只有 resize 瞬间露这点颜色）
    backgroundColor: '#ffffff',
    title: '',
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,   // 厚壳方案用 BrowserView，禁用 webview（安全）
      spellcheck: false,
    },
    // E1：高 DPI 缩放（Intel 核显 150% 不贴偏）
    useContentSize: false,
  }

  // 自绘标题栏：titleBarStyle:'hidden'（隐藏系统标题栏，保留可 resize 边框）
  // 不用 frame:false —— Windows 上 frame:false 会让 maximize() 不改窗口尺寸
  // （isMaximized() 返回 true、事件触发，但 DWM 对无边框窗口的 maximize 不变尺寸，
  //   导致"还原"按钮图标切换但窗口尺寸不变）。保留边框才能正常 maximize/restore。
  mainWindow = new BrowserWindow({
    ...baseWinOpts,
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    ...(isMac ? { trafficLightPosition: { x: 14, y: 10 } } : {}),
  })

  // zoomFactor：页面 1.0 不跟随历史值
  mainWindow.webContents.setZoomFactor(1)

  // 崩溃恢复
  mainWindow.webContents.on('render-process-gone', (event, details) => {
    console.error('[Main] Renderer process gone:', details.reason)
    if (crashRecoveryCount < MAX_CRASH_RECOVERY) {
      crashRecoveryCount++
      console.log(`[Main] Auto recovering renderer (${crashRecoveryCount}/${MAX_CRASH_RECOVERY})...`)
      setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.reload()
        } else {
          createMainWindow(store)
        }
      }, 1000)
    } else {
      dialog.showErrorBox('渲染进程崩溃', '渲染进程多次崩溃，请重启应用或联系技术支持。')
    }
  })

  mainWindow.webContents.on('unresponsive', () => {
    console.warn('[Main] Renderer became unresponsive')
  })

  // 窗口关闭/最小化/移动/resize：持久化 windowState（拔副屏防不可见）
  let saveTimer = null
  const scheduleSave = () => {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => _saveWindowState(store, mainWindow), 150)
  }
  mainWindow.on('move', scheduleSave)
  mainWindow.on('resize', scheduleSave)
  mainWindow.on('maximize', () => {
    try {
      store.set('windowState.isMaximized', true)
      // 全屏最大化（覆盖任务栏）：Windows 默认最大化到工作区（不含任务栏），
      // 手动 setBounds 到 screen.bounds 实现真正的全屏最大化
      const { screen } = require('electron')
      const display = screen.getDisplayMatching(mainWindow.getBounds())
      mainWindow.setBounds(display.bounds)
    } catch(_){}
  })
  mainWindow.on('unmaximize', () => {
    try {
      store.set('windowState.isMaximized', false)
      // 还原到小窗口（1440×900 居中），让最大化/还原有明显的视觉差异
      const { screen } = require('electron')
      const workArea = screen.getPrimaryDisplay().workArea
      let width = 1440, height = 900
      // 屏幕太小则缩到 workArea 的 80%
      if (workArea.width < width + 100 || workArea.height < height + 100) {
        width = Math.round(workArea.width * 0.8)
        height = Math.round(workArea.height * 0.8)
      }
      const x = Math.round(workArea.x + (workArea.width - width) / 2)
      const y = Math.round(workArea.y + (workArea.height - height) / 2)
      mainWindow.setBounds({ x, y, width, height })
    } catch(_){}
  })

  // ══════════════════════════════════════════════════════════════
  // B11/B12 关闭按钮 → 隐藏到托盘（不退出进程）；托盘菜单"退出"才真正 app.quit()
  // 关键：调用 app.quit() 时会再次触发 close，此时 _userQuit = true → 真正关闭
  // ══════════════════════════════════════════════════════════════
  let _userQuit = false
  app.on('before-quit', () => { _userQuit = true })
  mainWindow.on('close', (ev) => {
    _saveWindowState(store, mainWindow)
    if (_userQuit) return  // 用户真正退出（托盘"退出" / 命令行 / 任务管理器）
    // 否则阻止默认关闭 → 隐藏到托盘
    ev.preventDefault()
    try {
      if (mainWindow?.isFullScreen?.()) {
        mainWindow.setFullScreen(false)
      }
      if (mainWindow?.isMinimized?.()) {
        mainWindow.hide()
      } else {
        // 先最小化再 hide（有动画感，避免"突然消失"突兀）
        mainWindow.minimize()
        setTimeout(() => { try { mainWindow?.hide?.() } catch(_){} }, 220)
      }
    } catch (_) { /* 兜底：hide 失败就让系统关闭 */ }
  })

  mainWindow.once('ready-to-show', () => {
    if (ws.isMaximized) mainWindow.maximize()
    mainWindow.show()
    crashRecoveryCount = 0
  })

  // 开发模式加载 Vite dev server，生产模式加载打包文件
  if (process.env.NODE_ENV === 'development') {
    mainWindow.loadURL('http://127.0.0.1:5173')
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'dist', 'index.html'))
  }

  // 处理外部链接
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url)
      return { action: 'deny' }
    }
    return { action: 'allow' }
  })

  return mainWindow
}

// 单例锁
const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  // 到点拉起的第二实例：agent 任务就地提交后退出（主实例不再处理，防重复）；
  // hotspot 交给主实例 second-instance 切浏览器 Tab
  const schedArg = localScheduler.findScheduledArg(process.argv)
  if (schedArg && schedArg.startsWith('agent:')) {
    localScheduler.runScheduledTrigger(schedArg).catch(() => {}).finally(() => app.quit())
  } else {
    app.quit()
  }
} else {
  // 到点触发中继（P4，编排在 local-scheduler.setupTriggerRelay）：
  // hotspot = 自动采集热榜（对照原版 auto_quit=True 无感语义）→ 拉窗切浏览器 Tab；
  // agent = plan 优先提交服务端
  const triggerRelay = localScheduler.setupTriggerRelay({
    getWindow: () => mainWindow,
    getUserDataDir: () => app.getPath('userData'),
    progressChannel: 'scheduled:capture-progress',
  })
  app.on('second-instance', (_e, argv) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
    const schedArg = localScheduler.findScheduledArg(argv)
    if (schedArg && schedArg.startsWith('hotspot:')) {
      void triggerRelay.runHotspotCapture().catch(() => {})
    }
  })

// 注册 tintin-ext 为标准协议（支持 Worker/fetch 访问扩展文件）
protocol.registerSchemesAsPrivileged([
  { scheme: 'tintin-ext', privileges: { standard: true, secure: true, supportFetchAPI: true } }
])

app.whenReady().then(() => {
    // E1: DPI 缩放：让 Chromium 高 DPI 支持更稳定（Intel 核显 150% 不贴偏 BrowserView bounds）
    try { app.commandLine.appendSwitch('high-dpi-support', '1') } catch(_){}

    // ───────────── A2 双模式推理：初始化上下文（§1.5 + §2.3 冷启动检查）─────────────
    // 1. Persistent store（electron-store，失败回退内存 Map，绝不阻塞启动）
    let store
    try {
      if (Store) {
        store = new Store({ name: 'app-config', defaults: {
          'inference.mode': 'server-only',
          'inference.lastVerifyAt': 0,
          'inference.fallbackHistory': [],
        }})
      } else {
        // 内存兜底
        const _mem = new Map()
        store = {
          get: (k, d) => _mem.has(k) ? _mem.get(k) : d,
          set: (k, v) => _mem.set(k, v),
          delete: (k) => _mem.delete(k),
          has: (k) => _mem.has(k),
        }
      }
    } catch (e) {
      console.warn('[A2] electron-store 初始化失败，回退内存 Map：', e.message)
      const _mem = new Map()
      store = { get: (k, d) => _mem.has(k) ? _mem.get(k) : d, set: (k, v) => _mem.set(k, v), delete: (k) => _mem.delete(k), has: (k) => _mem.has(k) }
    }

    // 注入 store 给 server-proxy：getServerUrl 优先读 'server.url'（设置页可改服务端地址）
    setConfigStore(store)

    // 同步共享上下文
    sharedCtx.store = store

    // ───────────── P3 遗留清理：ext.* 分离时代废弃配置键一次性迁移（GAP §3.4-3）─────────────
    // 外挂 Chrome CDP(9222) + bridge(8123) 载体已作废（2026-08-27 裁决），
    // 6 个废弃键随启动静默清除；ext.shopKeyword 仍被浏览器自动上架面板使用，保留。
    try { purgeDeprecatedExtKeys(store) } catch (_) { /* 清理失败不阻塞启动 */ }

    // F4：frame:true 兜底判断在 createMainWindow 内部完成（基于 argv/env/store）
    // 窗口创建延后到所有 IPC handlers 注册之后（C8 顺序，避免渲染层早调用 IPC 静默超时）
    console.log('[ThickShell] frame mode: SELF-DRAWN (frame:false, system titlebar removed)')

    // ══════════════════════════════════════════════════════════════
    // C8 · IPC 最早期注册：所有 IPC handlers 必须在 createMainWindow() 之前注册
    //     （BrowserView attach / BrowserWindow 构造完成后才会渲染 App.vue，
    //      避免渲染层 window.tintin.win 调用时 IPC 还没注册而静默超时）
    // ══════════════════════════════════════════════════════════════
    createThickShellIpc(ipcMain, sharedCtx)

    // Phase 1: 媒体下载器（yt-dlp + 流式下载 + FFmpeg 合并）
    createMediaDownloader(ipcMain, {
      app,
      store,
      getMainWindow: () => mainWindow,
      // 下载浮窗打开期间同步接收进度广播（注册表状态推送到面板）
      getDownloadsPanel: () => (floatingPanelWindow
        && !floatingPanelWindow.isDestroyed()
        && floatingPanelWindow.__panelName === 'downloads') ? floatingPanelWindow : null,
    })

    // Phase 3: 媒体持久化（嗅探历史 + 下载记录 + 设置）
    createMediaStorage(ipcMain, { store })

    // 5. 注册 A2 12 条 IPC handlers（C14 白名单：config 2 + model 4 + inference 2 + ocr 1 + knowledge 3）
    createA2Ipc(ipcMain, { store, modelManager: null, inferenceRouter: null, vectorStore: null, httpRequest: null })
    //    注意：model/inference/vector 在下方实例化后，通过 deferred 注入
    let deferred = {}
    try {
      // 2. Model manager
      const modelManager = createModelManager({ store })
      deferred.modelManager = modelManager

      // 3. 本地执行器（ocr / vector store）
      const localOcr = createLocalOcr({ modelsDir: modelManager.paths.modelsDir })
      const vectorStore = createVectorStore({
        dbPath: path.join(modelManager.paths.dbDir, 'knowledge.db'),
        nativeAddonsDir: modelManager.paths.nativeAddonsDir,
      })
      deferred.vectorStore = vectorStore

      // 4. inference-router（单例路由入口，Q2 红线）
      const httpExecutor = async ({ endpoint, method = 'POST', payload, _multipart }) => {
        if (method === 'POST_MULTIPART' && _multipart) {
          return await multipartUpload(endpoint, _multipart.fields, _multipart.onProgress)
        }
        const res = await httpRequest(method, endpoint, {
          body: (method !== 'GET' && payload) ? payload : undefined,
        })
        return res.data
      }
      const inferenceRouter = new InferenceRouter({
        store,
        modelManager,
        httpExecutor,
        localExecutors: {
          ocr: ({ imageInput, lang }) => localOcr.imageToText(imageInput, { lang }),
          vectorSearch: ({ queryVector, topK }) => {
            const r = vectorStore.vectorSearch({ queryVector, topK })
            if (!r.success || !r.vssReady) throw new Error(r.msg || 'VSS_NOT_READY')
            return r.data
          },
        },
      })
      deferred.inferenceRouter = inferenceRouter

      // 二次重注册（替换刚才占位的 handlers，让 A2 handler 拿到真实依赖）
      createA2Ipc(ipcMain, { store, modelManager, inferenceRouter, vectorStore, httpRequest })

      // 6. 冷启动第 4 项检查：本地推理能力检测
      try {
        const iv = modelManager.verifyInstallation()
        store.set('inference.mode', iv.inferenceMode)
        store.set('inference.lastVerifyAt', Date.now())
        store.set('inference.verifyReport', iv.details)
        console.log(`[A2 ColdCheck] mode=${iv.inferenceMode} allOk=${iv.allOk} manifest=${iv.manifestVersion}`)
        if (iv.allOk) {
          localOcr.preload().then((r) => console.log(`[A2 OCR preload] ${r.ok ? 'OK' : 'SKIP: ' + r.reason}`))
          try { vectorStore.getDB(); console.log('[A2 KB] SQLite opened, vssReady=', vectorStore.isVssReady()) }
          catch (e) { console.warn('[A2 KB] open failed (auto HTTP fallback):', e.message) }
        }
      } catch (e) {
        console.warn('[A2 ColdCheck] 异常 → 强制 server-only：', e.message)
        store.set('inference.mode', 'server-only')
      }
    } catch (e) {
      console.warn('[A2] 初始化失败（A2 降级不可用）：', e.message)
    }

    // ───────────── 原有模块初始化 ─────────────
    createServerProxy(ipcMain)
    const dm = createDownloadManager(ipcMain, getWorkspacePath())
    sharedCtx.downloadManager = dm
    // 下载总线暴露（BrowserView will-download → 全局 EventBus）
    sharedCtx.EventBus = (dm && typeof dm.getEventBus === 'function') ? dm.getEventBus() : null

    createFfmpegGate(ipcMain, getStudioRoot())
    createTray()
    initUpdater()
    // 环境与维护 / 扩展插件：真实主进程操作（服务端探测、清缓存、CDP 检测）
    const { createEnvIpc } = require('./env-ipc')
    createEnvIpc(ipcMain, { getServerUrl })

    createMainWindow(store)

    // 本地定时任务 IPC（P2 移植）+ 首启到点参数接管
    ipcMain.handle('scheduled:list', () => localScheduler.listTasks())
    ipcMain.handle('scheduled:create', (_e, payload) => localScheduler.createTask(payload || {}))
    ipcMain.handle('scheduled:run', (_e, taskName) => localScheduler.runNow(taskName))
    ipcMain.handle('scheduled:delete', (_e, name) => localScheduler.deleteTask(name))
    // agent 任务 LLM 拆解（对照原版 agent_router.build_plan，P2 补齐）
    ipcMain.handle('agent:splitPlan', (_e, goal) => agentPlan.splitPlan(goal))
    // 今日热点手动采集（P4 补齐，对照原版素材浏览器「一键采集」按钮）
    ipcMain.handle('scheduled:captureHotspots', () => triggerRelay.runHotspotCapture())
    void triggerRelay.handleScheduledArg(localScheduler.findScheduledArg(process.argv))
    if (triggerRelay.hasPendingHotspot() && mainWindow) {
      triggerRelay.flushPendingHotspot()
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createMainWindow(store)
      }
    })
  })
}

// IPC: app 相关
ipcMain.handle('app:get-version', () => app.getVersion())
ipcMain.handle('app:get-path', (event, name) => {
  if (name === 'workspace') return getWorkspacePath()
  if (name === 'home') return app.getPath('home')
  if (name === 'userData') return app.getPath('userData')
  if (name === 'temp') return app.getPath('temp')
  return ''
})
ipcMain.on('app:quit', () => app.quit())
ipcMain.on('app:relaunch', () => {
  app.relaunch()
  app.quit()
})

// IPC: 历史面板
ipcMain.on('history:open', (event, items, anchorX, anchorY) => {
  openHistoryPanel(items, anchorX, anchorY)
})
ipcMain.on('history:close', () => {
  closeHistoryPanel()
})
ipcMain.on('history:navigate', (event, index) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('history:navigate', index)
  }
  closeHistoryPanel()
})
ipcMain.handle('history:get', async () => {
  try {
    const ms = require('./media-storage')
    return { success: true, items: await ms.getHistory() }
  } catch (e) {
    return { success: false, items: [] }
  }
})
ipcMain.handle('history:clear', async () => {
  try {
    const ms = require('./media-storage')
    await ms.clearHistory()
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('history:cleared')
    }
    return { success: true }
  } catch (e) {
    return { success: false, error: e.message }
  }
})

// IPC: 浮动面板（扩展/设置/下载 → 独立原生窗口，渲染层只传锚点坐标）
ipcMain.on('browser:openExtensionsPanel', (e, x, y) =>
  _openFloatingPanel('extensions', 'extensions-panel.html', 380, 440, x, y, null))
ipcMain.on('browser:closeExtensionsPanel', () => _closeFloatingPanel())
ipcMain.on('browser:openSettingsPanel', (e, x, y, data) =>
  _openFloatingPanel('settings', 'settings-panel.html', 420, 470, x, y, data))
ipcMain.on('browser:closeSettingsPanel', () => _closeFloatingPanel())
ipcMain.on('browser:openDownloadsPanel', (e, x, y) =>
  _openFloatingPanel('downloads', 'downloads-panel.html', 400, 480, x, y, null))
ipcMain.on('browser:closeDownloadsPanel', () => _closeFloatingPanel())

// IPC: dialog
ipcMain.handle('dialog:openFile', async (event, params) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: params?.title || '选择文件',
    properties: ['openFile'],
    filters: params?.filters || []
  })
  return result.canceled ? null : result.filePaths[0]
})
ipcMain.handle('dialog:openFiles', async (event, params) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: params?.title || '选择文件',
    properties: ['openFile', 'multiSelections'],
    filters: params?.filters || []
  })
  return result.canceled ? null : result.filePaths
})
ipcMain.handle('dialog:openDir', async (event, params) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: params?.title || '选择目录',
    properties: ['openDirectory']
  })
  return result.canceled ? null : result.filePaths[0]
})
ipcMain.handle('dialog:saveFile', async (event, params) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: params?.title || '保存文件',
    defaultPath: params?.defaultPath,
    filters: params?.filters || []
  })
  return result.canceled ? null : result.filePath
})

// IPC: shell
ipcMain.handle('shell:openExternal', (event, url) => shell.openExternal(url))
ipcMain.handle('shell:openItem', (event, filePath) => shell.openPath(filePath))
ipcMain.handle('shell:revealInFolder', (event, filePath) => {
  shell.showItemInFolder(filePath)
})
ipcMain.handle('shell:showNotification', (event, title, body, iconPath, onClickCb) => {
  const { Notification } = require('electron')
  if (!Notification.isSupported()) return
  const notif = new Notification({
    title,
    body,
    icon: iconPath || undefined
  })
  if (onClickCb) {
    notif.on('click', () => {
      if (mainWindow) mainWindow.webContents.send('notification:clicked', { title, body })
    })
  }
  notif.show()
})

// 所有窗口关闭时退出（macOS 除外）—— 若主窗口只是被 hide 不算关闭
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    // 再判断一遍：若 tray 仍存在且没真正 destroy，说明是隐藏到托盘，不 quit
    // （createTray 已经注册，托盘退出用 app.quit 触发 before-quit→_userQuit→真正关）
    app.quit()
  }
})

// 捕获未处理异常
process.on('uncaughtException', (err) => {
  console.error('[Main] Uncaught exception:', err)
})
