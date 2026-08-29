// ═══════════════════════════════════════════════════════════════
// browser-preload.js — 浏览器域独立 preload（D3）
// 职责：仅向浏览器窗口暴露浏览器域需要的 IPC（window.tintinBrowser），
//   与主应用 preload.js（window.tintin）完全隔离，互不影响。
//
// 通道来源（全部为既有主进程 handler，本文件只做白名单收口）：
//   · browser:*            thickShell-ipc.js（attachPlatform/setBounds/navigate/
//                          cookieList/extensionList/verifyBounds/订阅式事件等）
//   · browser:open*Panel   main.js（扩展/设置/下载管理浮窗）
//   · browser:download*    media-downloader.js（媒体下载 start/pause/cancel +
//                          browser:downloads-updated 进度广播）
//   · media:storage*       media-storage.js（嗅探/下载/收藏/设置持久化）
//   · history:*            main.js（历史浮窗 + navigate/cleared 事件）
//   · scheduled:*          main.js / local-scheduler.js（hotspot 采集与触发）
//   · config:*             config-store.js（electron-store：themeMode / ext.shopKeyword）
//   · win:*                thickShell-ipc.js（窗口状态订阅 → BrowserView bounds 重算）
//
// 打包：随 asar（package.json build.files "preload/**/*" 已覆盖）。
// 批次2：浏览器窗口创建时 webPreferences.preload 指向本文件。
// ═══════════════════════════════════════════════════════════════

const { contextBridge, ipcRenderer } = require('electron')

// ── browser:*（BrowserView 真嵌入，thickShell-ipc.js + main.js 浮窗）──
const browser = {
  attachPlatform:  (platformId, seedUrl, skipSeed) => ipcRenderer.invoke('browser:attachPlatform', platformId, seedUrl, skipSeed),
  detachAll:       ()                    => ipcRenderer.invoke('browser:detachAll'),
  setBounds:       (bounds)              => ipcRenderer.invoke('browser:setBounds', bounds),
  navigate:        (payload)             => ipcRenderer.invoke('browser:navigate', payload),
  extractDOM:      (platformId)          => ipcRenderer.invoke('browser:extractDOM', platformId),
  // 浮动面板：独立原生窗口（扩展/设置/下载），渲染层只传锚点坐标
  openExtensionsPanel: (x, y)            => ipcRenderer.send('browser:openExtensionsPanel', x, y),
  closeExtensionsPanel: ()               => ipcRenderer.send('browser:closeExtensionsPanel'),
  openSettingsPanel:   (x, y, data)      => ipcRenderer.send('browser:openSettingsPanel', x, y, data),
  closeSettingsPanel:  ()                => ipcRenderer.send('browser:closeSettingsPanel'),
  openDownloadsPanel:  (x, y)            => ipcRenderer.send('browser:openDownloadsPanel', x, y),
  closeDownloadsPanel: ()                => ipcRenderer.send('browser:closeDownloadsPanel'),
  // 登录态（条目⑧）：cookie 摘要 / 清除
  cookieList:      (platformId)          => ipcRenderer.invoke('browser:cookieList', platformId),
  cookieClear:     (platformId)          => ipcRenderer.invoke('browser:cookieClear', platformId),
  // 扩展管理
  extensionList:   ()                    => ipcRenderer.invoke('browser:extensionList'),
  installExtension: (filePath)           => ipcRenderer.invoke('browser:extensionInstall', filePath),
  uninstallExtension: (id)               => ipcRenderer.invoke('browser:extensionUninstall', id),
  onExtensionsChanged: (cb) => {
    const handler = (_e, payload) => cb(payload)
    ipcRenderer.on('browser:extensions-changed', handler)
    return () => ipcRenderer.removeListener('browser:extensions-changed', handler)
  },
  // Cherry Studio：主动校验（渲染端期望 vs 主进程实际生效值）
  verifyBounds:    (payload)             => ipcRenderer.invoke('browser:verifyBounds', payload),
  // Cookie 导出 / 状态查询（yt-dlp 辅助）
  exportCookies:   (platformId, destPath) => ipcRenderer.invoke('browser:exportCookies', { platformId, destPath }),
  getCookieStatus: (platformId)          => ipcRenderer.invoke('browser:getCookieStatus', platformId),
  getCurrentUrl:   (platformId)          => ipcRenderer.invoke('browser:getCurrentUrl', platformId),
  // B9 每日素材（main/daily-assets.js）：按日期扫描下载目录 + 文件定位/打开
  getDailyAssets:  ()                    => ipcRenderer.invoke('browser:getDailyAssets'),
  revealFile:      (filePath)            => ipcRenderer.invoke('browser:revealFile', filePath),
  openFilePath:    (filePath)            => ipcRenderer.invoke('browser:openFilePath', filePath),
}

// 订阅式事件（invoke 注册 channel → on）：URL 更新 / 下载更新 / view-ready / 媒体嗅探 / B站扩展链接
function _subscribe(registerChannel, eventChannel) {
  return (cb) => {
    let handler = null
    ipcRenderer.invoke(registerChannel).then((res) => {
      if (!res?.success || !res?.channel) return
      handler = (_e, payload) => cb(payload)
      ipcRenderer.on(res.channel, handler)
    }).catch(() => {})
    return () => {
      if (handler) {
        ipcRenderer.invoke(registerChannel).then((res) => {
          if (res?.channel) ipcRenderer.removeListener(res.channel, handler)
        }).catch(() => {})
        handler = null
      }
    }
  }
}

browser.onUrlUpdated = _subscribe('browser:onUrlUpdated')
browser.onDownloadsUpdated = _subscribe('browser:onDownloadsUpdated')
browser.onViewReady = _subscribe('browser:onViewReady')
browser.onMediaSniffed = _subscribe('browser:onMediaSniffed')
// W11：客户端任务引导下载（主进程 client-task-thread.js 推送任务 URL → 渲染层导航）
browser.onClientTaskDownload = (cb) => {
  const handler = (_e, payload) => cb(payload)
  ipcRenderer.on('client-task:open-download', handler)
  return () => ipcRenderer.removeListener('client-task:open-download', handler)
}

browser.onBiliExtDownloads = (cb) => {
  let handler = null
  let biliChannel = null
  ipcRenderer.invoke('browser:onBiliExtDownloads').then((res) => {
    if (!res?.success || !res?.channel) return
    biliChannel = res.channel
    handler = (_e, payload) => cb(payload)
    ipcRenderer.on(biliChannel, handler)
  }).catch(() => {})
  return () => {
    if (handler && biliChannel) ipcRenderer.removeListener(biliChannel, handler)
    handler = null
    biliChannel = null
  }
}

// ── 媒体下载（media-downloader.js）：start/pause/cancel + 进度广播 ──
let _mediaDlProgressHandler = null
const mediaDownload = {
  start: (params) => ipcRenderer.invoke('browser:downloadMediaStart', params),
  cancel: (taskId) => ipcRenderer.invoke('browser:downloadMediaCancel', taskId),
  pause: (taskId) => ipcRenderer.invoke('browser:downloadMediaPause', taskId),
  onProgress: (cb) => {
    if (_mediaDlProgressHandler) {
      ipcRenderer.removeListener('browser:downloads-updated', _mediaDlProgressHandler)
    }
    const handler = (_e, payload) => cb(payload)
    _mediaDlProgressHandler = handler
    ipcRenderer.on('browser:downloads-updated', handler)
    return () => {
      ipcRenderer.removeListener('browser:downloads-updated', handler)
      if (_mediaDlProgressHandler === handler) _mediaDlProgressHandler = null
    }
  },
}

// ── 媒体持久化（media-storage.js）：嗅探/下载/收藏/设置 ──
const mediaStorage = {
  getSniffed: () => ipcRenderer.invoke('media:storageGetSniffed'),
  saveSniffed: (list) => ipcRenderer.invoke('media:storageSaveSniffed', list),
  getDownloads: () => ipcRenderer.invoke('media:storageGetDownloads'),
  saveDownloads: (list) => ipcRenderer.invoke('media:storageSaveDownloads', list),
  getSettings: () => ipcRenderer.invoke('media:storageGetSettings'),
  saveSettings: (s) => ipcRenderer.invoke('media:storageSaveSettings', s),
  getFavorites: () => ipcRenderer.invoke('media:storageGetFavorites'),
  saveFavorites: (list) => ipcRenderer.invoke('media:storageSaveFavorites', list),
  addFavorite: (item) => ipcRenderer.invoke('media:storageAddFavorite', item),
  removeFavorite: (url) => ipcRenderer.invoke('media:storageRemoveFavorite', url),
  export: (format, filePath) => ipcRenderer.invoke('media:storageExport', { format, path: filePath }),
  import: (filePath) => ipcRenderer.invoke('media:storageImport', { path: filePath }),
  clearHistory: (type) => ipcRenderer.invoke('media:storageClearHistory', { type }),
  openDownloadDir: () => ipcRenderer.invoke('media:storageOpenDownloadDir'),
}

// ── 历史浮窗（main.js）：open/close + navigate/cleared 事件 ──
const history = {
  open: (items, x, y) => ipcRenderer.send('history:open', items, x, y),
  close: () => ipcRenderer.send('history:close'),
  onNavigate: (cb) => {
    const handler = (_e, index) => cb(index)
    ipcRenderer.on('history:navigate', handler)
    return () => ipcRenderer.removeListener('history:navigate', handler)
  },
  onCleared: (cb) => {
    const handler = () => cb()
    ipcRenderer.on('history:cleared', handler)
    return () => ipcRenderer.removeListener('history:cleared', handler)
  },
}

// ── 定时任务 hotspot（main.js / local-scheduler.js）：采集 + 到点触发 ──
const scheduled = {
  captureHotspots: () => ipcRenderer.invoke('scheduled:captureHotspots'),
  onScheduledCaptureProgress: (cb) => {
    const handler = (_e, p) => cb(p)
    ipcRenderer.on('scheduled:capture-progress', handler)
    return () => ipcRenderer.removeListener('scheduled:capture-progress', handler)
  },
  onScheduledHotspot: (cb) => {
    const handler = (_e, payload) => cb(payload)
    ipcRenderer.on('scheduled:hotspot-trigger', handler)
    return () => ipcRenderer.removeListener('scheduled:hotspot-trigger', handler)
  },
}

// ── config（config-store.js）：主题 / 自动上架店铺关键词 ──
const config = {
  get: (key, defaultValue) =>
    ipcRenderer.invoke('config:get', key, defaultValue).then(r => r?.success ? r.data : defaultValue),
  set: (keyOrObject, value) =>
    ipcRenderer.invoke('config:set', keyOrObject, value).then(r => r?.success ? true : false),
}

// ── win（thickShell-ipc.js）：窗口状态订阅 → BrowserView bounds 重算 ──
const win = {
  getState: () => ipcRenderer.invoke('win:getState'),
  onStateChange: (cb) => {
    let handler = null
    ipcRenderer.invoke('win:onStateChange').then((res) => {
      if (!res?.success || !res?.channel) return
      handler = (_e, payload) => cb(payload)
      ipcRenderer.on(res.channel, handler)
    }).catch(() => {})
    return () => {
      if (handler) {
        ipcRenderer.invoke('win:onStateChange').then((res) => {
          if (res?.channel) ipcRenderer.removeListener(res.channel, handler)
        }).catch(() => {})
        handler = null
      }
    }
  },
}

// ── creators（main/creators-store.js）：B10 达人/创作者库 + 主页全量采集 ──
const creators = {
  getCreators: () => ipcRenderer.invoke('creators:getCreators'),
  addCreator: (creator) => ipcRenderer.invoke('creators:addCreator', creator),
  deleteCreator: (payload) => ipcRenderer.invoke('creators:deleteCreator', payload),
  getCollected: () => ipcRenderer.invoke('creators:getCollected'),
  collectFromCreator: (payload) => ipcRenderer.invoke('creators:collectFromCreator', payload),
  onCollectProgress: (cb) => {
    const handler = (_e, p) => cb(p)
    ipcRenderer.on('creators:collect-progress', handler)
    return () => ipcRenderer.removeListener('creators:collect-progress', handler)
  },
}

// ── materialImport（main/material-import.js）：B8 素材入库（web_download 异步任务）──
const materialImport = {
  import: (payload) => ipcRenderer.invoke('material:import', payload),
  listTasks: () => ipcRenderer.invoke('material:importTaskList'),
  status: (taskId) => ipcRenderer.invoke('material:importStatus', taskId),
}

// ── autoListing（main/auto-listing/ipc.js）：B12 自动上架 ──
// 通道：autoListing:validate/start/stop/resume/status/listRuns/openResultDir +
//   autoListing:onProgress（订阅式，invoke 返回固定 channel 'auto-listing:progress'，
//   payload { runId, stage: 'progress'|'done'|'error', message, ts, result? }）
const autoListing = {
  validate: (payload) => ipcRenderer.invoke('autoListing:validate', payload),
  start: (payload) => ipcRenderer.invoke('autoListing:start', payload),
  stop: () => ipcRenderer.invoke('autoListing:stop'),
  resume: (payload) => ipcRenderer.invoke('autoListing:resume', payload),
  status: () => ipcRenderer.invoke('autoListing:status'),
  listRuns: () => ipcRenderer.invoke('autoListing:listRuns'),
  openResultDir: (runId) => ipcRenderer.invoke('autoListing:openResultDir', runId),
  onProgress: _subscribe('autoListing:onProgress'),
}

// ── 办公能力集成（office:* 主进程 handler，PRD §4.2；与主应用同通道复用，
//    达人库/每日素材/素材采集导出 Excel 经 tintinBrowser.office 调用）──
const office = {
  saveFile: (payload) => ipcRenderer.invoke('office:saveFile', payload),
  openPath: (filePath) => ipcRenderer.invoke('office:openPath', filePath),
  previewDocx: (filePath) => ipcRenderer.invoke('office:previewDocx', filePath),
  readXlsx: (filePath) => ipcRenderer.invoke('office:readXlsx', filePath),
}

// ── 暴露到浏览器窗口渲染进程（window.tintinBrowser）──
contextBridge.exposeInMainWorld('tintinBrowser', {
  browser,
  mediaDownload,
  mediaStorage,
  history,
  scheduled,
  config,
  win,
  creators,
  materialImport,
  autoListing,
  office,
})
