const { app, autoUpdater, dialog } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

let updateAvailableCallback = null

function getUpdateConfig() {
  // 尝试读取 studio/config/update.json
  const configPaths = [
    path.join(app.getPath('userData'), 'update.json'),
    path.resolve(__dirname, '..', '..', '..', 'studio', 'config', 'update.json')
  ]

  for (const p of configPaths) {
    if (fs.existsSync(p)) {
      try {
        return JSON.parse(fs.readFileSync(p, 'utf-8'))
      } catch (e) {
        console.warn('[Updater] Failed to parse update config:', p, e)
      }
    }
  }
  return null
}

function initUpdater() {
  const config = getUpdateConfig()
  if (!config || !config.url) {
    console.log('[Updater] No update URL configured, skipping auto-updater')
    return
  }

  try {
    autoUpdater.setFeedURL({
      url: config.url,
      headers: config.headers || {}
    })

    autoUpdater.on('checking-for-update', () => {
      console.log('[Updater] Checking for update...')
    })

    autoUpdater.on('update-available', (info) => {
      console.log('[Updater] Update available:', info.version)
      if (updateAvailableCallback) {
        updateAvailableCallback(info.version, config.url)
      }
      dialog.showMessageBox({
        type: 'info',
        title: '发现新版本',
        message: `发现新版本 ${info.version}，是否立即下载更新？`,
        buttons: ['立即下载', '稍后提醒'],
        defaultId: 0
      }).then((result) => {
        if (result.response === 0) {
          autoUpdater.downloadUpdate()
        }
      })
    })

    autoUpdater.on('update-not-available', () => {
      console.log('[Updater] Update not available')
    })

    autoUpdater.on('error', (err) => {
      console.error('[Updater] Error:', err)
    })

    autoUpdater.on('download-progress', (progress) => {
      console.log(`[Updater] Downloading: ${progress.percent.toFixed(1)}%`)
    })

    autoUpdater.on('update-downloaded', (info) => {
      console.log('[Updater] Update downloaded:', info.version)
      dialog.showMessageBox({
        type: 'info',
        title: '更新已就绪',
        message: '更新已下载完成，重启应用以安装更新。',
        buttons: ['立即重启', '稍后'],
        defaultId: 0
      }).then((result) => {
        if (result.response === 0) {
          autoUpdater.quitAndInstall()
        }
      })
    })

    // 启动后 10 秒检查更新
    setTimeout(() => {
      autoUpdater.checkForUpdates()
    }, 10000)

    // 每 4 小时检查一次
    setInterval(() => {
      autoUpdater.checkForUpdates()
    }, 4 * 60 * 60 * 1000)
  } catch (e) {
    console.error('[Updater] Init failed:', e)
  }
}

function onUpdateAvailable(cb) {
  updateAvailableCallback = cb
}

module.exports = { initUpdater, onUpdateAvailable }
