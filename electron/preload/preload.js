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
  extractAudio: (video, outPath, format) => ipcRenderer.invoke('ffmpeg:extractAudio', video, outPath, format)
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
  attachPlatform:  (platformId, seedUrl) => ipcRenderer.invoke('browser:attachPlatform', platformId, seedUrl),
  detachAll:       ()                    => ipcRenderer.invoke('browser:detachAll'),
  setBounds:       (bounds)              => ipcRenderer.invoke('browser:setBounds', bounds),
  navigate:        (payload)             => ipcRenderer.invoke('browser:navigate', payload),
  extractDOM:      (platformId)          => ipcRenderer.invoke('browser:extractDOM', platformId),
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
  // A2 扩展（§1.5 双模式）
  model,
  inference,
  ocr,
  knowledge,
})
