// ═══════════════════════════════════════════════════════════════
// browser-window.js — 浏览器域独立 BrowserWindow（D4）
//
// 职责：主进程侧浏览器独立窗口（与主窗口完全解耦）：
//   · 独立 preload（preload/browser-preload.js → window.tintinBrowser）
//   · dev 加载 http://127.0.0.1:5173/browser/，prod 加载 renderer/dist/browser/index.html
//     （vite 多入口已配：dist/browser/index.html；打包 files "renderer/dist/**/*" 已覆盖）
//   · 窗口尺寸独立持久化（electron-store 'windowState.browser'，与主窗口 windowState 互不干扰）
//   · 单实例：重复 open 聚焦已存在窗口（不重复创建，避免双 BrowserView 争抢 partition）
//   · 关闭行为 = 隐藏（对齐主窗口 B11/B12 关闭隐藏到托盘惯例，同豆包等浏览器窗口习惯：
//       BrowserView partition 登录态与页面缓存驻留内存，托盘/主窗口按钮可再唤起零成本；
//       仅 app.quit()（托盘「退出」/系统退出，before-quit → _userQuit）才真正销毁）
//   · BrowserView 挂载目标：thickShell-ipc.js 经 ctx.getBrowserWindow() 取本窗口
// ═══════════════════════════════════════════════════════════════

const { BrowserWindow, app, shell } = require('electron')
const path = require('node:path')

let browserWindow = null
/** 用户真正退出（app.quit / 托盘退出）→ close 允许真正销毁；默认关闭 = 隐藏 */
let _userQuit = false
app.on('before-quit', () => { _userQuit = true })

// ── 尺寸持久化：独立键 windowState.browser（与主窗口 windowState 互不干扰）──
function _loadState(store) {
  const d = { x: undefined, y: undefined, width: 1280, height: 840, isMaximized: false }
  if (!store || typeof store.get !== 'function') return d
  try {
    const v = store.get('windowState.browser') || {}
    if (typeof v.width === 'number' && v.width >= 800) d.width = v.width
    if (typeof v.height === 'number' && v.height >= 600) d.height = v.height
    d.isMaximized = !!v.isMaximized
    if (typeof v.x === 'number' && typeof v.y === 'number') { d.x = v.x; d.y = v.y }
    return d
  } catch (_) { return d }
}

/** x/y 显示器有效性校验：窗口至少 100x100 落在某显示器工作区内，否则主屏居中（拔副屏防不可见） */
function _validateOnDisplay(state) {
  const { screen } = require('electron')
  try {
    const displays = screen.getAllDisplays()
    if (!displays.length) return state
    if (typeof state.x !== 'number' || typeof state.y !== 'number') {
      const p = screen.getPrimaryDisplay().workArea
      state.x = Math.round(p.x + (p.width - state.width) / 2)
      state.y = Math.round(p.y + (p.height - state.height) / 2)
      return state
    }
    const ok = displays.some((d) => {
      const w = d.workArea
      const ox1 = Math.max(state.x, w.x), oy1 = Math.max(state.y, w.y)
      const ox2 = Math.min(state.x + state.width, w.x + w.width)
      const oy2 = Math.min(state.y + state.height, w.y + w.height)
      return (ox2 - ox1) >= 100 && (oy2 - oy1) >= 100
    })
    if (!ok) {
      const p = screen.getPrimaryDisplay().workArea
      state.x = Math.round(p.x + (p.width - state.width) / 2)
      state.y = Math.round(p.y + (p.height - state.height) / 2)
    }
  } catch (_) {}
  return state
}

function _saveState(store) {
  if (!store || !browserWindow || browserWindow.isDestroyed()) return
  try {
    if (browserWindow.isMaximized() || browserWindow.isMinimized()) {
      store.set('windowState.browser.isMaximized', browserWindow.isMaximized())
      return
    }
    const [x, y] = browserWindow.getPosition()
    const [width, height] = browserWindow.getSize()
    store.set('windowState.browser', { x, y, width, height, isMaximized: false })
  } catch (_) { /* ignore */ }
}

/** 当前浏览器窗口（未创建/已销毁 → null，防御调用方） */
function getBrowserWindow() {
  return browserWindow && !browserWindow.isDestroyed() ? browserWindow : null
}

/**
 * 创建浏览器独立窗口（单实例：已存活直接复用，禁止重复创建）。
 * 关闭=隐藏（不销毁）：BrowserView partition 登录态/页面缓存驻留内存，
 * 与主窗口关闭隐藏到托盘行为一致（B11/B12），托盘/主窗口按钮可再唤起。
 */
function createBrowserWindow({ store }) {
  if (browserWindow && !browserWindow.isDestroyed()) return browserWindow
  const preloadPath = path.join(__dirname, '..', 'preload', 'browser-preload.js')
  const ws = _validateOnDisplay(_loadState(store))
  browserWindow = new BrowserWindow({
    width: ws.width,
    height: ws.height,
    x: ws.x,
    y: ws.y,
    minWidth: 800,
    minHeight: 600,
    show: false,
    backgroundColor: '#ffffff',
    title: '螺丝钉浏览器',
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      spellcheck: false,
    },
  })
  browserWindow.webContents.setZoomFactor(1)

  // 移动/resize/最大化：持久化 windowState.browser（150ms debounce）
  let saveTimer = null
  const scheduleSave = () => {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => _saveState(store), 150)
  }
  browserWindow.on('move', scheduleSave)
  browserWindow.on('resize', scheduleSave)
  browserWindow.on('maximize', () => { try { store?.set?.('windowState.browser.isMaximized', true) } catch (_) {} })
  browserWindow.on('unmaximize', () => { try { store?.set?.('windowState.browser.isMaximized', false) } catch (_) {} })

  // 关闭 = 隐藏；仅用户真正退出（_userQuit）时允许销毁
  browserWindow.on('close', (ev) => {
    _saveState(store)
    if (_userQuit) return
    ev.preventDefault()
    try { browserWindow.hide() } catch (_) { /* hide 失败就让系统关闭 */ }
  })

  browserWindow.once('ready-to-show', () => {
    if (ws.isMaximized) browserWindow.maximize()
    browserWindow.show()
  })

  // dev：Vite dev server 多入口 /browser/；prod：打包产物 dist/browser/index.html
  if (process.env.NODE_ENV === 'development') {
    browserWindow.loadURL('http://127.0.0.1:5173/browser/')
  } else {
    browserWindow.loadFile(path.join(__dirname, '..', 'renderer', 'dist', 'browser', 'index.html'))
  }

  // D4 遗留：浮动面板锚点需窗口绝对位置（渲染层 useBrowserDownloads/
  // useBrowserBounds 读 window.__WINDOW_BOUNDS__ 把相对按钮坐标换算为
  // 屏幕绝对坐标；加载完成后注入 + move/resize 同步更新，保证换算准确）
  const injectWindowBounds = () => {
    try {
      if (browserWindow && !browserWindow.isDestroyed()) {
        const b = browserWindow.getBounds()
        browserWindow.webContents.executeJavaScript(
          `window.__WINDOW_BOUNDS__ = ${JSON.stringify({ x: b.x, y: b.y, width: b.width, height: b.height })}`
        ).catch(() => {})
      }
    } catch (_) { /* 页面未就绪/已销毁时静默 */ }
  }
  browserWindow.webContents.on('did-finish-load', injectWindowBounds)
  browserWindow.on('move', injectWindowBounds)
  browserWindow.on('resize', injectWindowBounds)

  // 外链一律交系统浏览器（C7 通用浏览器红线）
  browserWindow.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })

  return browserWindow
}

/**
 * 打开浏览器窗口（单实例入口）：已存在 → 恢复 + 聚焦；未创建 → 新建。
 * opts.hotspot=true：窗口就绪后补发 scheduled:hotspot-trigger（带 count），
 * 浏览器渲染层自含订阅 onScheduledHotspot → navigateToHotspot。
 * 必要性：定时到点/手动采集时若窗口未开，主进程广播送达不到渲染层，
 *   由本函数在窗口加载完成后补发，保证 D5 热点联动闭环。
 */
async function openBrowserWindow({ store, hotspot = false, count = null } = {}) {
  const sendSignal = (wc) => {
    try { wc.send('scheduled:hotspot-trigger', { count: typeof count === 'number' ? count : null }) } catch (_) {}
  }
  const existing = getBrowserWindow()
  if (existing) {
    if (existing.isMinimized()) existing.restore()
    existing.show()
    existing.focus()
    if (hotspot) sendSignal(existing.webContents)
    return { success: true, created: false }
  }
  const win = createBrowserWindow({ store })
  if (hotspot) {
    const wc = win.webContents
    if (!wc.isLoading()) sendSignal(wc)
    else wc.once('did-finish-load', () => sendSignal(win.webContents))
  }
  return { success: true, created: true }
}

/** 注册 IPC（main.js 在 createMainWindow 之后调用）：browserWindow:open（主窗口按钮 + hotspot 打开） */
function registerBrowserWindowIpc(ipcMain, { store }) {
  ipcMain.handle('browserWindow:open', async (_e, opts) => {
    try {
      const o = opts || {}
      return await openBrowserWindow({ store, hotspot: !!o.hotspot, count: o.count })
    } catch (e) {
      return { success: false, error: (e && e.message) || String(e) }
    }
  })
}

module.exports = {
  createBrowserWindow,
  openBrowserWindow,
  getBrowserWindow,
  registerBrowserWindowIpc,
}
