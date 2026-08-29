const { app, Tray, Menu, nativeImage } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const browserWindow = require('./browser-window')

let tray = null

function createTray() {
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
        const { BrowserWindow } = require('electron')
        const win = BrowserWindow.getAllWindows()[0]
        if (win) {
          if (win.isMinimized()) win.restore()
          win.show()
          win.focus()
        }
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
    const { BrowserWindow } = require('electron')
    const win = BrowserWindow.getAllWindows()[0]
    if (win) {
      if (win.isVisible()) {
        win.hide()
      } else {
        win.show()
        win.focus()
      }
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
