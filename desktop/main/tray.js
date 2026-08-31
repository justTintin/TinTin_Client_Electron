const { app, Tray, Menu, nativeImage } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const browserWindow = require('./browser-window')

let tray = null

/**
 * 创建托盘。getMainWindow：主进程注入的主窗口 getter（mainWindow 闭包引用）。
 * 修复：不能用 BrowserWindow.getAllWindows()[0]（创建序首窗）代替主窗口——
 * 进程内还有浏览器独立窗口与下载/历史/扩展等浮动面板，取到错窗会导致
 * 托盘「显示主窗口」唤起的是浏览器/面板。未注入时回退旧逻辑。
 */
function createTray(getMainWindow) {
  const resolveMain = () => {
    const win = typeof getMainWindow === 'function' ? getMainWindow() : null
    if (win && !win.isDestroyed()) return win
    // 回退：取创建序首窗（仅未注入 getter 的旧调用方路径）
    const { BrowserWindow } = require('electron')
    return BrowserWindow.getAllWindows()[0] || null
  }
  const raiseWin = (win) => {
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  }

  // 图标路径：与界面左上角"钉"形 Logo 同源
  // 打包后 __dirname=<app>/resources/app.asar/main，'..'×2 已是 <app>/resources，不能再拼 'resources'
  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, 'icons', 'icon.png')
    : path.join(__dirname, '..', '..', 'resources', 'icons', 'icon.png')
  let icon
  if (fs.existsSync(iconPath)) {
    icon = nativeImage.createFromPath(iconPath)
    // Windows 托盘显示彩色"钉"形图标，不做 template 单色化
  } else {
    icon = nativeImage.createEmpty()
  }

  tray = new Tray(icon)
  tray.setToolTip('螺丝钉-电商智能体矩阵 V3')

  const contextMenu = Menu.buildFromTemplate([
    {
      label: '显示主窗口',
      click: () => {
        raiseWin(resolveMain())
      }
    },
    // D4：浏览器独立窗口关闭=隐藏，托盘可再唤起（未创建时直接创建，默认尺寸）
    {
      label: '显示浏览器窗口',
      click: () => {
        const bw = browserWindow.getBrowserWindow()
        if (bw) {
          if (bw.isMinimized()) bw.restore()
          bw.show()
          bw.focus()
        } else {
          browserWindow.openBrowserWindow({ store: null }).catch(() => {})
        }
      }
    },
    { type: 'separator' },
    {
      label: '开机自启动',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (menuItem) => {
        app.setLoginItemSettings({
          openAtLogin: menuItem.checked,
          path: app.getPath('exe')
        })
      }
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => app.quit()
    }
  ])

  tray.setContextMenu(contextMenu)

  tray.on('click', () => {
    const win = resolveMain()
    if (!win) return
    if (win.isVisible()) {
      win.hide()
    } else {
      raiseWin(win)
    }
  })

  return tray
}

function destroyTray() {
  if (tray) {
    tray.destroy()
    tray = null
  }
}

module.exports = { createTray, destroyTray }
