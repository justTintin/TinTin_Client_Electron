const { contextBridge, ipcRenderer } = require('electron')

// ── 事件监听器管理（防止内存泄漏）──
const progressListeners = new Map()
const doneListeners = new Map()

// ── app ──
const app = {
  getVersion: () => ipcRenderer.invoke('app:get-version'),
  getPath: (name) => ipcRenderer.invoke('app:get-path', name),
  quit: () => ipcRenderer.send('app:quit'),
  relaunch: () => ipcRenderer.send('app:relaunch'),
  onUpdateAvailable: (cb) => {
    const handler = (_event, ver, url) => cb(ver, url)
    ipcRenderer.on('updater:update-available', handler)
    return () => ipcRenderer.removeListener('updater:update-available', handler)
  }
}

// ── dialog ──
const dialog = {
  openFile: (params) => ipcRenderer.invoke('dialog:openFile', params),
  openFiles: (params) => ipcRenderer.invoke('dialog:openFiles', params),
  openDir: (params) => ipcRenderer.invoke('dialog:openDir', params),
  saveFile: (params) => ipcRenderer.invoke('dialog:saveFile', params)
}

// ── downloads ──
const downloads = {
  start: (params) => ipcRenderer.invoke('downloads:start', params),
  pause: (taskId) => ipcRenderer.invoke('downloads:pause', taskId),
  resume: (taskId) => ipcRenderer.invoke('downloads:resume', taskId),
  cancel: (taskId) => ipcRenderer.invoke('downloads:cancel', taskId),
  onProgress: (taskId, cb) => {
    const handler = (_event, data) => {
      if (data.taskId === taskId) cb(data)
    }
    progressListeners.set(taskId, handler)
    ipcRenderer.on('downloads:progress', handler)
    return () => {
      ipcRenderer.removeListener('downloads:progress', handler)
      progressListeners.delete(taskId)
    }
  },
  onDone: (taskId, cb) => {
    const handler = (_event, data) => {
      if (data.taskId === taskId) cb(data)
    }
    doneListeners.set(taskId, handler)
    ipcRenderer.on('downloads:done', handler)
    return () => {
      ipcRenderer.removeListener('downloads:done', handler)
      doneListeners.delete(taskId)
    }
  }
}

// ── server (HTTP 代理) ──
// 通用（保持兼容）+ 业务级方法（对齐 server-proxy.js 的业务 IPC handlers，一一映射）
function _withUploadProgress(onProgress, handlerName, payload) {
  const progressChannel = onProgress ? `up:${handlerName}:${Date.now()}` : undefined
  if (onProgress && progressChannel) {
    ipcRenderer.on(progressChannel, (_e, percent) => onProgress(percent))
  }
  return ipcRenderer.invoke(handlerName, payload, progressChannel)
}

const server = {
  // ---------- 通用兜底 ----------
  get:            (path, params)  => ipcRenderer.invoke('server:get', path, params),
  post:           (path, body, headers) => ipcRenderer.invoke('server:post', path, body, headers),
  put:            (path, body, headers) => ipcRenderer.invoke('server:put', path, body, headers),
  delete:         (path, params)  => ipcRenderer.invoke('server:delete', path, params),
  upload:         (path, fields, onProgress) => {
    const progressChannel = onProgress ? `upload:progress:${Date.now()}` : undefined
    if (onProgress && progressChannel) ipcRenderer.on(progressChannel, (_e, percent) => onProgress(percent))
    return ipcRenderer.invoke('server:upload', path, fields, progressChannel)
  },
  downloadResult: (path, savePath) => ipcRenderer.invoke('server:downloadResult', path, savePath),
  sse:            (path, onEvent, onError) => {
    const eventChannel = `sse:event:${Date.now()}`
    const errorChannel = `sse:error:${Date.now()}`
    const eventHandler = (_e, data) => onEvent(data)
    const errorHandler = (_e, err) => { if (onError) onError(err) }
    ipcRenderer.on(eventChannel, eventHandler)
    ipcRenderer.on(errorChannel, errorHandler)
    ipcRenderer.invoke('server:sse', path, eventChannel, errorChannel)
    return () => {
      ipcRenderer.removeListener(eventChannel, eventHandler)
      ipcRenderer.removeListener(errorChannel, errorHandler)
    }
  },

  // ---------- health / stats ----------
  healthCapabilities: () => ipcRenderer.invoke('health:capabilities'),
  statsWorkbench:     () => ipcRenderer.invoke('stats:workbench'),

  // ---------- agent ----------
  agentRegistry:         ()       => ipcRenderer.invoke('agent:registry'),
  agentSubmitTask:       (payload) => ipcRenderer.invoke('agent:submitTask', payload),
  agentTaskAction:       (params)  => ipcRenderer.invoke('agent:taskAction', params),
  agentRegisterArtifact: (payload) => ipcRenderer.invoke('agent:registerArtifact', payload),

  // ---------- scheduled（P2 本地定时任务，schtasks）----------
  scheduledList:   () => ipcRenderer.invoke('scheduled:list'),
  scheduledCreate: (payload) => ipcRenderer.invoke('scheduled:create', payload),
  scheduledRun:    (taskName) => ipcRenderer.invoke('scheduled:run', taskName),
  scheduledDelete: (name) => ipcRenderer.invoke('scheduled:delete', name),
  onScheduledHotspot: (cb) => {
    const handler = () => cb()
    ipcRenderer.on('scheduled:hotspot-trigger', handler)
    return () => ipcRenderer.removeListener('scheduled:hotspot-trigger', handler)
  },

  // ---------- tasks ----------
  tasksUnifiedList:      (params)       => ipcRenderer.invoke('tasks:unifiedList', params),
  tasksUnifiedItem:      (id)           => ipcRenderer.invoke('tasks:unifiedItem', { id }),
  tasksProgress:         (id)           => ipcRenderer.invoke('tasks:progress', { id }),
  tasksDownloadResult:   (id, savePath) => ipcRenderer.invoke('tasks:downloadResult', { id, savePath }),

  // ---------- V3 S1~S3 媒体工具（上传类，支持 onProgress）----------
  rembgSubmit:          (p, onProgress) => _withUploadProgress(onProgress, 'rembg:submit', p),
  vsrSubmit:            (p, onProgress) => _withUploadProgress(onProgress, 'vsr:submit', p),
  vsrRemove:            (p, onProgress) => _withUploadProgress(onProgress, 'vsr:remove', p),
  visionReversePrompt:  (p, onProgress) => _withUploadProgress(onProgress, 'vision:reversePrompt', p),

  // ---------- asr / tts ----------
  asrTranscribe:  (p, onProgress) => _withUploadProgress(onProgress, 'asr:transcribe', p),
  ttsGenerate:   (p, onProgress) => {
    // tts:generate 内部会按是否含 clone_ref_file 选择 multipart / JSON，这里统一走同一 handler
    return (p && p.clone_ref_file)
      ? _withUploadProgress(onProgress, 'tts:generate', p)
      : ipcRenderer.invoke('tts:generate', p)
  },
  ttsCloneVoice: (p, onProgress) => _withUploadProgress(onProgress, 'tts:cloneVoice', p),
  ttsVoicesList:    (params)       => ipcRenderer.invoke('tts:voicesList', params),
  ttsVoicesSamples: (params)       => ipcRenderer.invoke('tts:voicesSamples', params),

  // ---------- workflow ----------
  workflowRun: (payload) => ipcRenderer.invoke('workflow:run', payload),

  // ---------- llm ----------
  llmChat:               (payload) => ipcRenderer.invoke('llm:chat', payload),
  llmAdjustCopywriting:  (payload) => ipcRenderer.invoke('llm:adjustCopywriting', payload),

  // ---------- material ----------
  materialList:       (params)  => ipcRenderer.invoke('material:list', params),
  materialStockSearch:(payload) => ipcRenderer.invoke('material:stockSearch', payload),
  materialOcr:        (p, onProgress) => _withUploadProgress(onProgress, 'material:ocr', p),

  // ---------- montage ----------
  montageSplit:    (p, onProgress) => _withUploadProgress(onProgress, 'montage:split', p),
  montageConcat:   (payload) => ipcRenderer.invoke('montage:concat', payload),
  montageBeatSync: (payload) => ipcRenderer.invoke('montage:beatSync', payload),

  // ---------- storyboard ----------
  storyboardListScripts: (params)  => ipcRenderer.invoke('storyboard:listScripts', params),
  storyboardSaveScript:  (payload) => ipcRenderer.invoke('storyboard:saveScript', payload),

  // ---------- system ----------
  systemLicenseVerify: (payload) => ipcRenderer.invoke('system:licenseVerify', payload),
}

// ── ffmpeg ──
const ffmpeg = {
  probe: (file) => ipcRenderer.invoke('ffmpeg:probe', file),
  extractThumb: (video, atSec, w) => ipcRenderer.invoke('ffmpeg:extractThumb', video, atSec, w),
  embedCover: (video, cover, outPath, durationSec) => ipcRenderer.invoke('ffmpeg:embedCover', video, cover, outPath, durationSec),
  concatSegments: (paths, outPath) => ipcRenderer.invoke('ffmpeg:concatSegments', paths, outPath),
  extractAudio: (video, outPath, format) => ipcRenderer.invoke('ffmpeg:extractAudio', video, outPath, format),
  cut: (video, outPath, startSec, endSec) => ipcRenderer.invoke('ffmpeg:cut', video, outPath, startSec, endSec)
}

// ── shell ──
const shell = {
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  showNotification: (title, body, icon, onClick) => ipcRenderer.invoke('shell:showNotification', title, body, icon, onClick),
  openItem: (p) => ipcRenderer.invoke('shell:openItem', p),
  revealInFolder: (p) => ipcRenderer.invoke('shell:revealInFolder', p)
}

// ── bridge（过渡期 bridge.exe，V3.1 移除）──
const bridge = {
  getStatus: () => ipcRenderer.invoke('bridge:getStatus'),
  navigate: (p) => ipcRenderer.invoke('bridge:navigate', p)
}

// ── config（持久化配置：electron-store，用于主题/窗口状态等）──
const config = {
  get: (key, defaultValue) =>
    ipcRenderer.invoke('config:get', key, defaultValue).then(r => r?.success ? r.data : defaultValue),
  set: (keyOrObject, value) =>
    ipcRenderer.invoke('config:set', keyOrObject, value).then(r => r?.success ? true : false),
}

// ── P1.5 厚壳化：win:* 5 条（自绘标题栏 + 窗口状态存取，§1.3.1 A3）──
const win = {
  getState:         ()       => ipcRenderer.invoke('win:getState'),
  minimize:         ()       => ipcRenderer.invoke('win:minimize'),
  toggleMaximize:   ()       => ipcRenderer.invoke('win:toggleMaximize'),
  close:            ()       => ipcRenderer.invoke('win:close'),
  // 订阅式：invoke 一次注册 channel，后续通过 listener 推送
  onStateChange: (cb) => {
    let handler = null
    ipcRenderer.invoke('win:onStateChange').then((res) => {
      if (!res?.success || !res?.channel) return
      const channel = res.channel
      handler = (_e, payload) => cb(payload)
      ipcRenderer.on(channel, handler)
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

// ── P1.5 厚壳化：browser:* 7 条 + 2（verifyBounds/onViewReady）（BrowserView 真嵌入，§1.3.2 B3+B4+B6 + Cherry Studio 实时校验）──
const browser = {
  attachPlatform:  (platformId, seedUrl, skipSeed) => ipcRenderer.invoke('browser:attachPlatform', platformId, seedUrl, skipSeed),
  detachAll:       ()                    => ipcRenderer.invoke('browser:detachAll'),
  setBounds:       (bounds)              => ipcRenderer.invoke('browser:setBounds', bounds),
  navigate:        (payload)             => ipcRenderer.invoke('browser:navigate', payload),
  extractDOM:      (platformId)          => ipcRenderer.invoke('browser:extractDOM', platformId),
  // 浮动面板：独立原生窗口（扩展/设置），渲染层只传锚点坐标
  openExtensionsPanel: (x, y)            => ipcRenderer.send('browser:openExtensionsPanel', x, y),
  closeExtensionsPanel: ()               => ipcRenderer.send('browser:closeExtensionsPanel'),
  openSettingsPanel:   (x, y, data)      => ipcRenderer.send('browser:openSettingsPanel', x, y, data),
  closeSettingsPanel:  ()                => ipcRenderer.send('browser:closeSettingsPanel'),
  // 下载管理浮窗：独立原生窗口（进度内嵌嗅探卡片，浮窗承载历史/文件操作）
  openDownloadsPanel:  (x, y)            => ipcRenderer.send('browser:openDownloadsPanel', x, y),
  closeDownloadsPanel: ()                => ipcRenderer.send('browser:closeDownloadsPanel'),
  cookieList:      (platformId)          => ipcRenderer.invoke('browser:cookieList', platformId),
  cookieClear:     (platformId)          => ipcRenderer.invoke('browser:cookieClear', platformId),
  extensionList:   ()                    => ipcRenderer.invoke('browser:extensionList'),
  installExtension: (filePath)           => ipcRenderer.invoke('browser:extensionInstall', filePath),
  uninstallExtension: (id)               => ipcRenderer.invoke('browser:extensionUninstall', id),
  // 扩展列表变更订阅（主进程安装/卸载后主动广播）
  onExtensionsChanged: (cb) => {
    const handler = (_e, payload) => cb(payload)
    ipcRenderer.on('browser:extensions-changed', handler)
    return () => ipcRenderer.removeListener('browser:extensions-changed', handler)
  },
  // Cherry Studio：主动校验（渲染端期望 vs 主进程实际生效值）
  verifyBounds:    (payload)             => ipcRenderer.invoke('browser:verifyBounds', payload),
  onUrlUpdated: (cb) => {
    let handler = null
    ipcRenderer.invoke('browser:onUrlUpdated').then((res) => {
      if (!res?.success || !res?.channel) return
      handler = (_e, payload) => cb(payload)
      ipcRenderer.on(res.channel, handler)
    }).catch(() => {})
    return () => {
      if (handler) {
        ipcRenderer.invoke('browser:onUrlUpdated').then((res) => {
          if (res?.channel) ipcRenderer.removeListener(res.channel, handler)
        }).catch(() => {})
        handler = null
      }
    }
  },
  onDownloadsUpdated: (cb) => {
    let handler = null
    ipcRenderer.invoke('browser:onDownloadsUpdated').then((res) => {
      if (!res?.success || !res?.channel) return
      handler = (_e, payload) => cb(payload)
      ipcRenderer.on(res.channel, handler)
    }).catch(() => {})
    return () => {
      if (handler) {
        ipcRenderer.invoke('browser:onDownloadsUpdated').then((res) => {
          if (res?.channel) ipcRenderer.removeListener(res.channel, handler)
        }).catch(() => {})
        handler = null
      }
    }
  },
  // Cherry Studio：订阅 did-stop-loading → 渲染层收到后立刻强制重算 bounds（防止页面布局跳动）
  onViewReady: (cb) => {
    let handler = null
    ipcRenderer.invoke('browser:onViewReady').then((res) => {
      if (!res?.success || !res?.channel) return
      handler = (_e, payload) => cb(payload)
      ipcRenderer.on(res.channel, handler)
    }).catch(() => {})
    return () => {
      if (handler) {
        ipcRenderer.invoke('browser:onViewReady').then((res) => {
          if (res?.channel) ipcRenderer.removeListener(res.channel, handler)
        }).catch(() => {})
        handler = null
      }
    }
  },
  // Phase 1-1: 媒体嗅探订阅
  onMediaSniffed: (cb) => {
    let handler = null
    ipcRenderer.invoke('browser:onMediaSniffed').then((res) => {
      if (!res?.success || !res?.channel) return
      handler = (_e, payload) => cb(payload)
      ipcRenderer.on(res.channel, handler)
    }).catch(() => {})
    return () => {
      if (handler) {
        ipcRenderer.invoke('browser:onMediaSniffed').then((res) => {
          if (res?.channel) ipcRenderer.removeListener(res.channel, handler)
        }).catch(() => {})
        handler = null
      }
    }
  },
  // Phase: B站扩展下载链接订阅
  onBiliExtDownloads: (cb) => {
    let handler = null
    let biliChannel = null
    ipcRenderer.invoke('browser:onBiliExtDownloads').then((res) => {
      if (!res?.success || !res?.channel) return
      biliChannel = res.channel
      handler = (_e, payload) => cb(payload)
      ipcRenderer.on(biliChannel, handler)
    }).catch(() => {})
    return () => {
      if (handler && biliChannel) {
        ipcRenderer.removeListener(biliChannel, handler)
      }
      handler = null
      biliChannel = null
    }
  },
  // Phase 1: Cookie 导出 / 状态查询
  exportCookies: (platformId, destPath) => ipcRenderer.invoke('browser:exportCookies', { platformId, destPath }),
  getCookieStatus: (platformId) => ipcRenderer.invoke('browser:getCookieStatus', platformId),
  getCurrentUrl: (platformId) => ipcRenderer.invoke('browser:getCurrentUrl', platformId),
}

// ── Phase 1: 媒体下载器（yt-dlp + 流式下载 + FFmpeg 合并）──
const mediaDownload = {
  start: (params) => ipcRenderer.invoke('browser:downloadMediaStart', params),
  cancel: (taskId) => ipcRenderer.invoke('browser:downloadMediaCancel', taskId),
  pause: (taskId) => ipcRenderer.invoke('browser:downloadMediaPause', taskId),
  onProgress: (cb) => {
    const handler = (_e, payload) => cb(payload)
    ipcRenderer.on('browser:downloads-updated', handler)
    return () => ipcRenderer.removeListener('browser:downloads-updated', handler)
  },
}

// ── Phase 3: 媒体持久化存储 ──
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

// ── A2 双模式推理（10 条白名单 C14 IPC，Q2 红线：渲染层仅能从此处调用）──
//    · model:*      — 模型下载/安装/卸载
//    · inference:*  — 能力查询 + 模式切换
//    · ocr:*        — OCR（自动路由本地/HTTP）
//    · knowledge:*  — 知识库（本地 better-sqlite3 / HTTP fallback）
const model = {
  listPkgs:       ()        => ipcRenderer.invoke('model:listPkgs'),
  downloadPkg:    (pkgId)   => ipcRenderer.invoke('model:download', pkgId),
  cancelPkg:      (pkgId)   => ipcRenderer.invoke('model:cancel', pkgId),
  uninstallPkg:   (pkgId)   => ipcRenderer.invoke('model:uninstall', pkgId),
}
const inference = {
  getCapability:  (force = false) => ipcRenderer.invoke('inference:getCapability', force),
  setMode:        (mode)          => ipcRenderer.invoke('inference:setMode', mode),
}
const ocr = {
  imageToText: (p, onProgress) => {
    const progressChannel = onProgress ? `ocr:progress:${Date.now()}` : undefined
    if (onProgress && progressChannel) ipcRenderer.on(progressChannel, (_e, percent) => onProgress(percent))
    return ipcRenderer.invoke('ocr:imageToText', p, progressChannel)
      .finally(() => { if (progressChannel) ipcRenderer.removeAllListeners(progressChannel) })
  }
}
const knowledge = {
  listDocuments:   (params) => ipcRenderer.invoke('knowledge:listDocuments', params),
  deleteDocument:  (id)     => ipcRenderer.invoke('knowledge:deleteDocument', id),
  vectorSearch:    (payload) => ipcRenderer.invoke('knowledge:vectorSearch', payload),
}

// ── env：环境与维护 / 扩展插件（真实主进程操作）──
const env = {
  serverPing:    ()      => ipcRenderer.invoke('env:serverPing'),
  restartService:()      => ipcRenderer.invoke('env:restartService'),
  clearCache:    ()      => ipcRenderer.invoke('env:clearCache'),
  detectCdp:     (port)  => ipcRenderer.invoke('env:detectCdp', port),
}

// ── 历史面板（独立子窗口，浮于 BrowserView 之上）──
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

// ── 暴露到渲染进程（window.tintin）──
contextBridge.exposeInMainWorld('tintin', {
  app,
  dialog,
  downloads,
  server,
  ffmpeg,
  shell,
  bridge,
  config,
  // P1.5 厚壳化
  win,
  browser,
  // Phase 1: 媒体下载器
  mediaDownload,
  // Phase 3: 媒体持久化
  mediaStorage,
  // 历史面板
  history,
  // A2 扩展（§1.5 双模式）
  model,
  inference,
  ocr,
  knowledge,
  env,
})
