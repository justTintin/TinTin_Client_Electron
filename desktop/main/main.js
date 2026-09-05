const { app, BrowserWindow, ipcMain, dialog, shell, session, protocol } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const { logError: _logErr } = require('./logger')
// 2026-09-05 日志框架切 electron-log 5.x：主进程顶层即初始化（早于一切业务 require），
// spyRendererConsole 自动桥接渲染层 console.* 落盘；未捕获异常落盘、不弹窗。
// 文件路径/滚动/清理由 logger.js initLogger 统一接管（userData/logs/main.log）
try {
  const _elog = require('electron-log')
  _elog.initialize({ spyRendererConsole: true })
  _elog.errorHandler.startCatching({ showDialog: false })
} catch (_) { /* 日志初始化失败绝不阻塞启动 */ }
const { createTray } = require('./tray')
const { initUpdater } = require('./updater')
const { createServerProxy, httpRequest, multipartUpload, getServerUrl, setConfigStore, getMachineId } = require('./server-proxy')
const { createDownloadManager } = require('./download-manager')
const { createFfmpegGate } = require('./ffmpeg-gate')
const browserWindow = require('./browser-window')
const { createPanelAutoClose } = require('./floating-panel-logic')

// 统一 userData 路径（dev 用 name、打包用 productName，必须显式 setName 保持一致，
// 否则 BrowserView 的 persist:* 分区（登录态）会丢失）
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
const localScheduler = require('./local-scheduler'); const { purgeDeprecatedExtKeys } = require('./config-migrate')
const agentPlan = require('./agent-plan') // agent 任务 LLM 拆解（对照 agent_router.build_plan，P2 补齐）
const { startClientTaskThread } = require('./client-task-thread') // W11：客户端任务下发闭环（轮询领取→执行→上报）
const { createDailyAssetsIpc } = require('./daily-assets'); const { createCreatorsStoreIpc } = require('./creators-store'); const { createAutoListingIpc } = require('./auto-listing/ipc'); const { createOfficeIpc } = require('./office-ipc') // B12：自动上架主进程引擎 + 办公能力（office:* 4 条）
const { createLiveclipIpc } = require('./liveclip-ipc') // M9 直播切片本地文件 I/O（liveclip:* 3 条：封面/导出字幕/临时烧字幕 SRT）
const { createSkillsIpc } = require('./skill-store') // 工作台技能入口（安装/卸载/列表，2026-08-31 对齐原客户端）
const { createVideoPredictionIpc } = require('./video-prediction-store') // 视频评价预测记录库（prediction:* 3 条，对照 video_prediction_manager.py）

// config-store：自建分域 JSON 配置存储（B 整改 2026-08-28，零第三方依赖；应用根/config 分域，失败兜底内存 store）
const { createConfigStore, resolveConfigBasePath } = require('./config-store')

let mainWindow = null
let crashRecoveryCount = 0
const MAX_CRASH_RECOVERY = 3

// 历史面板子窗口
let historyPanelWindow = null
let _historyBlurTimer = null
// D4 锚点修正：按调用方窗口 parentWin 定位——主窗口传相对坐标加偏移；浏览器窗口
// 渲染层已用 __WINDOW_BOUNDS__ 换算为屏幕绝对坐标不偏移；面板 setParentWindow 跟随调用方
function openHistoryPanel(items, anchorX, anchorY, parentWin) {
  if (historyPanelWindow && !historyPanelWindow.isDestroyed()) {
    closeHistoryPanel()
  }
  const panelWidth = 380
  const panelHeight = 420
  const base = parentWin && !parentWin.isDestroyed() ? parentWin : mainWindow
  // 计算位置：使用屏幕绝对坐标
  let x = anchorX || 100
  let y = anchorY || 100
  if (base) {
    const winBounds = base.getBounds()
    if (base !== browserWindow.getBrowserWindow() && anchorX !== undefined && anchorY !== undefined) {
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
  
  historyPanelWindow.setParentWindow(base)
  
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

/* ─────────── 浮动面板：扩展/设置（独立原生 BrowserWindow，天然在 BrowserView 之上；
   与历史面板同款方案：主进程创建子窗口加载独立 HTML，渲染层仅传锚点坐标）─────────── */
let floatingPanelWindow = null
/** 面板自动关闭状态机（floating-panel-logic.js；busy=文件对话框/安装流程中暂停自动关闭，
 *  修复「点安装扩展选完文件面板已被销毁，安装永不执行且无提示」2026-09-02） */
let _fpAutoClose = null

// D4 锚点修正：同 openHistoryPanel（浏览器窗口已传绝对坐标不偏移；主窗口加偏移），面板挂调用方窗口
function _openFloatingPanel(name, htmlFile, panelWidth, panelHeight, anchorX, anchorY, data, parentWin) {
  _closeFloatingPanel()
  const base = parentWin && !parentWin.isDestroyed() ? parentWin : mainWindow
  let x = anchorX || 100
  let y = anchorY || 100
  if (base) {
    const winBounds = base.getBounds()
    if (base !== browserWindow.getBrowserWindow() && anchorX !== undefined && anchorY !== undefined) {
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
  floatingPanelWindow.setParentWindow(base)
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
  _fpAutoClose = createPanelAutoClose({ closeDelayMs: 150, onFire: () => _closeFloatingPanel() })
  floatingPanelWindow.on('show', () => { _r = true; _fpAutoClose.markShow() })
  floatingPanelWindow.on('blur', () => {
    if (!_r) return
    _fpAutoClose.blur()
  })
  floatingPanelWindow.on('closed', () => { try { _fpAutoClose.dispose() } catch (_) {} })
}

function _closeFloatingPanel() {
  try { _fpAutoClose && _fpAutoClose.dispose() } catch (_) {}
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
  getBrowserWindow: () => browserWindow.getBrowserWindow(), // D4：BrowserView 挂载目标（未创建返回 null）
  downloadManager: null,
  EventBus: null,
}

function createMainWindow(store) {
  // 单例守卫：已有存活主窗口时直接复用，禁止重复创建
  // （否则两个窗口叠放 + 争抢同一 userData 磁盘缓存，BrowserView 只挂最后一个窗口）
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow

  const preloadPath = path.join(__dirname, '..', 'preload', 'preload.js')
  // 应用图标：与界面左上角"钉"形 Logo 同源（打包后 process.resourcesPath/icons）
  const appIconPath = app.isPackaged
    ? path.join(process.resourcesPath, 'icons', 'icon.png')
    : path.join(__dirname, '..', '..', 'resources', 'icons', 'icon.png')
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
    // 窗口/任务栏图标（Windows 下 exe 未嵌图标时的兜底）
    icon: fs.existsSync(appIconPath) ? appIconPath : undefined,
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
  // （app.quit() 会再次触发 close，此时 _userQuit = true → 真正关闭）
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
    // 写日志方便排查（用户感知：双击后闪退 = 已有实例在托盘）
    _logErr('app', 'second-instance denied (lock held); existing instance should focus its window')
    // 不弹 dialog（阻塞型弹窗体验更差）；second-instance 事件会在主实例侧 focus
    app.quit()
  }
} else {
  // P4 到点触发中继（local-scheduler.setupTriggerRelay：hotspot 采集→切 Tab；agent 提交服务端）
  const triggerRelay = localScheduler.setupTriggerRelay({
    getWindow: () => mainWindow,
    getExtraWindow: () => browserWindow.getBrowserWindow(), // D5：hotspot 广播到浏览器窗口（自含订阅导航）
    getUserDataDir: () => app.getPath('userData'),
    progressChannel: 'scheduled:capture-progress',
  })
  app.on('second-instance', (_e, argv) => {
    if (mainWindow) {
      if (!mainWindow.isVisible()) mainWindow.show()      // 隐藏到托盘时必须先 show
      else if (mainWindow.isMinimized()) mainWindow.restore()
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
    try { app.commandLine.appendSwitch('high-dpi-support', '1') } catch (_){}

    // ───────────── A2 双模式推理：初始化上下文（§1.5 + §2.3 冷启动检查）─────────────
    // 1. Persistent store（config-store 分域 JSON，失败回退内存 Map，绝不阻塞启动）
    let store
    try {
      store = createConfigStore({
        // D6：配置固定 userData/config（跨版本/打包保留；resolveConfigBasePath 返回对象，取 .basePath 字段）
        basePath: resolveConfigBasePath(app.isPackaged ? path.dirname(app.getPath('exe')) : process.cwd(), app.getPath('userData')).basePath,
        legacyPath: path.join(app.getPath('userData'), 'app-config.json'),
        legacyBasePath: path.join(app.getPath('userData'), 'config'),
        defaults: {
          'inference.mode': 'server-only',
          'inference.lastVerifyAt': 0,
          'inference.fallbackHistory': [],
        },
      })
    } catch (e) {
      console.warn('[A2] config-store 初始化失败，回退内存 Map：', e.message)
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
    const thickShell = createThickShellIpc(ipcMain, sharedCtx)
    // B12：自动上架引擎（BrowserView persist:tintin-fxg + executeJavaScript + CDP debugger）
    createAutoListingIpc(ipcMain, { store, app, getBrowserWindow: () => browserWindow.getBrowserWindow(), getOrCreateView: (id, seed) => thickShell.getOrCreateView(id, seed) })

    // Phase 1: 媒体下载器（yt-dlp + 流式下载 + FFmpeg 合并）
    createMediaDownloader(ipcMain, {
      app,
      store,
      getMainWindow: () => mainWindow,
      getBrowserWindow: () => browserWindow.getBrowserWindow(), // D5：下载进度广播到浏览器窗口
      // 下载浮窗打开期间同步接收进度广播（注册表状态推送到面板）
      getDownloadsPanel: () => (floatingPanelWindow
        && !floatingPanelWindow.isDestroyed()
        && floatingPanelWindow.__panelName === 'downloads') ? floatingPanelWindow : null,
    })

    // Phase 3: 媒体持久化（嗅探历史 + 下载记录 + 设置）
    createMediaStorage(ipcMain, { store })
    createDailyAssetsIpc(ipcMain, { store, app }); createCreatorsStoreIpc(ipcMain, { app, getBrowserWindow: () => browserWindow.getBrowserWindow() }); createOfficeIpc(ipcMain, { getMainWindow: () => mainWindow }) // 办公能力 office:*（主窗口 + 浏览器窗口共用）
    createSkillsIpc(ipcMain, { app }) // 技能 skills:list/install/remove（内置技能随包 resources/skills）
    createVideoPredictionIpc(ipcMain, { app }) // 视频评价预测记录 prediction:list/add/setFeedback（预测 vs 实际对照反哺校准）
        createLiveclipIpc(ipcMain) // M9 直播切片 liveclip:writeImageFile/writeTextFile/writeTempText（渲染层策略 + 主进程纯 I/O）

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
    createServerProxy(ipcMain, { app, store })
    const dm = createDownloadManager(ipcMain, getWorkspacePath())
    sharedCtx.downloadManager = dm
    // 下载总线暴露（BrowserView will-download → 全局 EventBus）
    sharedCtx.EventBus = (dm && typeof dm.getEventBus === 'function') ? dm.getEventBus() : null

    createFfmpegGate(ipcMain, getStudioRoot())
    // 注入主窗口 getter：托盘「显示主窗口」/左键点击固定指向 mainWindow（非 getAllWindows[0]）
    createTray(() => mainWindow)
    initUpdater()
    // 环境与维护（服务端探测/清缓存/CDP/环境检测）
    const { createEnvIpc } = require('./env-ipc')
    createEnvIpc(ipcMain, { getServerUrl, studioRoot: getStudioRoot(), getMachineId })

    // 飞书连接测试（条目⑩ S6，对照原 _test_feishu L584-600；getCfg 读 electron-store 补全 Secret）
    const { createFeishuIpc } = require('./feishu-ipc')
    createFeishuIpc(ipcMain, { getCfg: (key) => store.get(key) })

    // S8 平台接入 + S9 自启动（platform-ipc.js）
    const { createPlatformIpc } = require('./platform-ipc')
    createPlatformIpc(ipcMain, { httpRequest, getCfg: (k) => store.get(k), setCfg: (k, v) => store.set(k, v) })

    createMainWindow(store)
    // W11：客户端任务下发闭环（对标原 client_task_thread.py：5s 领取→引导浏览器下载→report；启动不阻塞）
    startClientTaskThread({ store, app, getWindow: () => mainWindow, getBrowserWindow: () => browserWindow.getBrowserWindow(), openBrowserWindow: (o) => browserWindow.openBrowserWindow({ store, ...(o || {}) }) })
    // D4：浏览器独立窗口 IPC（browserWindow:open —— 主窗口按钮 / hotspot 到点打开）
    browserWindow.registerBrowserWindowIpc(ipcMain, { store })
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
ipcMain.on('history:open', (event, items, anchorX, anchorY) => openHistoryPanel(items, anchorX, anchorY, BrowserWindow.fromWebContents(event.sender) || mainWindow))
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

// IPC: 浮动面板（扩展/设置/下载 → 独立原生窗口，渲染层只传锚点坐标；D4：按 sender 窗口定位挂父）
ipcMain.on('browser:openExtensionsPanel', (e, x, y) => _openFloatingPanel('extensions', 'extensions-panel.html', 380, 440, x, y, null, BrowserWindow.fromWebContents(e.sender) || mainWindow))
ipcMain.on('browser:closeExtensionsPanel', () => _closeFloatingPanel())
ipcMain.on('browser:openSettingsPanel', (e, x, y, data) => _openFloatingPanel('settings', 'settings-panel.html', 420, 470, x, y, data, BrowserWindow.fromWebContents(e.sender) || mainWindow))
ipcMain.on('browser:closeSettingsPanel', () => _closeFloatingPanel())
ipcMain.on('browser:openDownloadsPanel', (e, x, y) => _openFloatingPanel('downloads', 'downloads-panel.html', 400, 480, x, y, null, BrowserWindow.fromWebContents(e.sender) || mainWindow))
ipcMain.on('browser:closeDownloadsPanel', () => _closeFloatingPanel())
// 面板忙态：扩展安装选文件等模态流程中暂停 blur 自动关闭（否则面板被销毁、安装永不执行且无提示，2026-09-02）
ipcMain.on('browser:panelBusy', (e, busy) => {
  if (!floatingPanelWindow || floatingPanelWindow.isDestroyed()) return
  if (e.sender !== floatingPanelWindow.webContents) return
  try { _fpAutoClose && _fpAutoClose.setBusy(!!busy) } catch (_) {}
})

// IPC: dialog
ipcMain.handle('dialog:openFile', async (event, params) => {
  // 父窗口：浮动面板是子窗口（setParentWindow），Windows 上对子窗口弹模态对话框
  // 会被父窗口遮挡导致用户看不到。检测发起方为浮动面板时改用顶层浏览器窗口。
  let parent = BrowserWindow.fromWebContents(event.sender) || mainWindow
  if (parent && floatingPanelWindow && !floatingPanelWindow.isDestroyed() && parent === floatingPanelWindow) {
    parent = browserWindow.getBrowserWindow() || mainWindow
  }
  const result = await dialog.showOpenDialog(parent, {
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

// 递归收集文件夹内全部视频文件（对齐原客户端 utils_media.py collect_video_files PR#3）
// 跳过隐藏/系统目录与混剪派生目录（splits/outputs/…），达到 limit 即停止遍历
ipcMain.handle('dialog:collectVideos', async (_event, params) => {
  const root = params?.root || ''
  if (!root || !fs.existsSync(root) || !fs.statSync(root).isDirectory()) return []
  const exts = new Set(
    (params?.exts || ['.mp4', '.mov', '.avi', '.mkv', '.flv', '.webm', '.m4v'])
      .map((e) => e.startsWith('.') ? e.toLowerCase() : '.' + e.toLowerCase())
  )
  const limit = Math.min(Number(params?.limit) || 500, 5000)
  const derivedDirs = new Set(params?.skipDirs || [
    'splits', 'output', 'outputs', 'final', 'dubbed', 'bgm', 'temp', 'montage_cache',
  ])
  const found = []
  function walk(dir) {
    if (found.length >= limit) return
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch (_) { return }
    for (const ent of entries) {
      if (found.length >= limit) return
      const full = path.join(dir, ent.name)
      if (ent.isDirectory()) {
        // 跳过隐藏/系统目录与混剪派生目录
        if (ent.name.startsWith('.') || ent.name.startsWith('$')) continue
        if (derivedDirs.has(ent.name.toLowerCase())) continue
        walk(full)
      } else if (ent.isFile()) {
        const ext = path.extname(ent.name).toLowerCase()
        if (exts.has(ext)) found.push(full)
      }
    }
  }
  walk(root)
  // 自然序排序（目录+文件名）
  found.sort((a, b) => {
    const natKey = (p) => {
      const base = path.basename(p).toLowerCase()
      const parts = base.split(/(\d+)/)
      return [path.dirname(p).toLowerCase(), ...parts.map((s, i) => i % 2 ? String(Number(s)).padStart(10, '0') : s)]
    }
    const ka = natKey(a), kb = natKey(b)
    const len = Math.max(ka.length, kb.length)
    for (let i = 0; i < len; i++) {
      const cmp = String(ka[i] || '').localeCompare(String(kb[i] || ''), undefined, { numeric: true })
      if (cmp !== 0) return cmp
    }
    return 0
  })
  return found.slice(0, limit)
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

// 捕获未处理异常（写入日志文件，避免闪退后无法排查）
process.on('uncaughtException', (err) => {
  console.error('[Main] Uncaught exception:', err)
  try { _logErr('crash', `uncaughtException: ${err?.stack || err}`) } catch (_) {}
})
process.on('unhandledRejection', (reason) => {
  console.error('[Main] Unhandled rejection:', reason)
  try { _logErr('crash', `unhandledRejection: ${reason?.stack || reason}`) } catch (_) {}
})
