const { ipcMain, session, shell, dialog } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const https = require('node:https')
const http = require('node:http')
const os = require('node:os')
const { URL } = require('node:url')
const { spawn } = require('node:child_process')

const activeDownloads = new Map()

// ══ 任务注册表：主进程下载状态的「单一真相源」 ══
// 浮窗下载面板（downloads-panel.html）与下载历史均从本注册表读取；
// 渲染层的 useBrowserDownloads 仅做实时卡片镜像，不再承担持久化。
const FINAL_STATUSES = ['completed', 'failed', 'cancelled']
const HISTORY_MAX = 300
const taskRegistry = new Map() // taskId -> { taskId,title,filename,path,url,status,progress,message,size,receivedBytes,startedAt,finishedAt }
let _userDataDir = null

function _registryUpsert(taskId, patch) {
  if (!taskId || typeof taskId !== 'string') return
  const prev = taskRegistry.get(taskId) || {}
  const rec = { ...prev, ...patch, taskId }
  if (!rec.startedAt) rec.startedAt = Date.now()
  if (patch && FINAL_STATUSES.includes(patch.status)) rec.finishedAt = Date.now()
  taskRegistry.set(taskId, rec)
}

function _persistHistory() {
  try {
    const dir = _userDataDir || os.tmpdir()
    const file = path.join(dir, 'downloads-history.json')
    const done = [...taskRegistry.values()]
      .filter(r => FINAL_STATUSES.includes(r.status))
      .sort((a, b) => (b.finishedAt || 0) - (a.finishedAt || 0))
      .slice(0, HISTORY_MAX)
    fs.writeFileSync(file, JSON.stringify(done), 'utf8')
  } catch (_) {}
}

function _loadHistory(appLike) {
  try {
    _userDataDir = (appLike && appLike.getPath) ? appLike.getPath('userData') : null
  } catch (_) {}
  try {
    const file = path.join(_userDataDir || os.tmpdir(), 'downloads-history.json')
    const arr = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (Array.isArray(arr)) for (const r of arr) if (r && r.taskId) taskRegistry.set(r.taskId, r)
  } catch (_) {}
}

function _formatBytes(bytes, decimals = 2) {
  if (!bytes || bytes === 0) return '0 Bytes'
  const k = 1024
  const dm = decimals < 0 ? 0 : decimals
  const sizes = ['Bytes', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i]
}

function _updateTaskProgress(broadcastFn, taskId, progress, message, receivedBytes) {
  try {
    broadcastFn({ taskId, kind: 'progress', progress, message, receivedBytes, ts: Date.now() })
  } catch (_) {}
}

function _updateTaskStatus(broadcastFn, taskId, status, progress, size, message, log) {
  try {
    broadcastFn({ taskId, kind: 'status', status, progress, size, message: message || '', log: log || '', ts: Date.now() })
  } catch (_) {}
}

function _isValidVideoPageUrl(url) {
  if (!url) return false
  const lower = url.toLowerCase()
  return lower.includes('youtube.com') || lower.includes('youtu.be') ||
    lower.includes('bilibili.com') || lower.includes('douyin.com') ||
    lower.includes('kuaishou.com') || lower.includes('xiaohongshu.com') ||
    lower.includes('weibo.com') || lower.includes('iqiyi.com') ||
    lower.includes('youku.com') || lower.includes('mgtv.com')
}

function _cleanMediaUrl(urlStr) {
  if (!urlStr) return urlStr
  try {
    const parsed = new URL(urlStr)
    const host = parsed.hostname
    if (host.includes('googlevideo.com') || host.includes('youtube.com')) {
      parsed.searchParams.set('range', '0-99999999999')
      parsed.searchParams.delete('rn')
      parsed.searchParams.delete('obuf')
      parsed.searchParams.delete('start')
      parsed.searchParams.delete('end')
    }
    return parsed.toString()
  } catch (_) { return urlStr }
}

function _killActiveTask(id) {
  const t = activeDownloads.get(id)
  if (!t) return false
  try {
    if (t.kill) t.kill()
    else if (t.destroy) t.destroy()
  } catch (_) {}
  activeDownloads.delete(id)
  return true
}

async function _downloadStream(taskId, url, destPath, referer, partition, broadcastFn) {
  return new Promise(async (resolve, reject) => {
    let cookieString = ''
    try {
      const sess = session.fromPartition(partition)
      const cookies = await sess.cookies.get({ url })
      cookieString = cookies.map(c => `${c.name}=${c.value}`).join('; ')
    } catch (_) {}

    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': '*/*',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    }
    if (referer) headers['Referer'] = referer
    if (cookieString) headers['Cookie'] = cookieString
    // B站 PCDN 等分块响应缺 content-length，Range 请求可拿到 206+content-range 以计算进度百分比
    headers['Range'] = 'bytes=0-'

    let req = null
    let fileStream = null
    let destroyed = false

    const cleanup = () => {
      activeDownloads.delete(taskId)
      if (fileStream) { try { fileStream.close() } catch (_) {} ; fileStream = null }
      if (fs.existsSync(destPath)) { try { fs.unlinkSync(destPath) } catch (_) {} }
    }

    const makeRequest = (requestUrl) => {
      try {
        const parsed = new URL(requestUrl)
        const lib = parsed.protocol === 'https:' ? https : http

        req = lib.get(requestUrl, { method: 'GET', headers, timeout: 45000 }, (res) => {
          if (destroyed) return

          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            const redirectUrl = new URL(res.headers.location, requestUrl).toString()
            makeRequest(redirectUrl)
            return
          }

          if (res.statusCode !== 200 && res.statusCode !== 206) {
            let errBody = ''
            res.on('data', (chunk) => { errBody += chunk.toString().slice(0, 500) })
            res.on('end', () => reject(new Error(`HTTP ${res.statusCode}: ${errBody.slice(0, 200)}`)))
            return
          }

          try {
            fileStream = fs.createWriteStream(destPath)
            fileStream.on('error', (err) => { cleanup(); reject(err) })
          } catch (err) { reject(err); return }

          const totalBytes = parseInt(res.headers['content-length'] || '0', 10) || 0
            || ((res.headers['content-range'] || '').match(/\/(\d+)\s*$/) ? parseInt(RegExp.$1, 10) : 0)
          let receivedBytes = 0
          let lastTime = Date.now()
          let lastBytes = 0

          res.on('data', (chunk) => {
            if (destroyed) return
            receivedBytes += chunk.length
            if (fileStream) fileStream.write(chunk)

            const now = Date.now()
            const elapsed = now - lastTime
            if (elapsed >= 500 || (totalBytes > 0 && receivedBytes >= totalBytes)) {
              const progress = totalBytes > 0 ? Math.round((receivedBytes / totalBytes) * 100) : 0
              const bytesDiff = receivedBytes - lastBytes
              const speedBps = elapsed > 0 ? (bytesDiff / elapsed) * 1000 : 0
              let speed = '0 B/s'
              if (speedBps > 1024 * 1024) speed = `${(speedBps / (1024 * 1024)).toFixed(1)} MB/s`
              else if (speedBps > 1024) speed = `${(speedBps / 1024).toFixed(1)} KB/s`
              else speed = `${Math.round(speedBps)} B/s`
              _updateTaskProgress(broadcastFn, taskId, progress, `下载中 ${speed}`, receivedBytes)
              lastTime = now
              lastBytes = receivedBytes
            }
          })

          res.on('end', () => {
            if (destroyed) return
            activeDownloads.delete(taskId)
            if (fileStream) fileStream.end(() => resolve({ totalBytes }))
            else resolve({ totalBytes })
          })
        })

        activeDownloads.set(taskId, req)

        req.on('error', (err) => {
          if (destroyed) return
          cleanup(); reject(err)
        })
        req.on('timeout', () => {
          if (destroyed) return
          destroyed = true
          try { req.destroy() } catch (_) {}
          cleanup(); reject(new Error('网络连接超时'))
        })
      } catch (err) {
        cleanup(); reject(err)
      }
    }

    makeRequest(url)
  })
}

async function _getYtdlpArgs() {
  const { execSync } = require('node:child_process')
  try {
    execSync('yt-dlp --version', { stdio: 'pipe', timeout: 5000 })
    return { cmd: 'yt-dlp', args: [] }
  } catch (_) {
    // Try python -m yt_dlp
    try {
      execSync('python -m yt_dlp --version', { stdio: 'pipe', timeout: 5000 })
      return { cmd: 'python', args: ['-m', 'yt_dlp'] }
    } catch (_) {
      // Try python3
      try {
        execSync('python3 -m yt_dlp --version', { stdio: 'pipe', timeout: 5000 })
        return { cmd: 'python3', args: ['-m', 'yt_dlp'] }
      } catch (_) {
        return null
      }
    }
  }
}

function _getFfmpegPath(app, dirname) {
  const candidates = []
  if (app && app.isPackaged) {
    candidates.push(path.join(process.resourcesPath, 'bin', 'ffmpeg.exe'))
  }
  candidates.push(path.join(dirname, 'bin', 'ffmpeg.exe'))
  candidates.push(path.join(__dirname, '..', '..', 'resources', 'bin', 'ffmpeg.exe'))
  candidates.push('ffmpeg')

  for (const c of candidates) {
    if (c === 'ffmpeg') return 'ffmpeg'
    if (fs.existsSync(c)) return `"${c}"`
  }
  return 'ffmpeg'
}

function createMediaDownloader(ipcMain, ctx) {
  const { app, getMainWindow, getDownloadsPanel, store } = ctx
  _loadHistory(app)

  // 下载目录解析：用户设置(store: downloadDir) > Windows 下载文件夹 > userData/downloads 兜底
  function _resolveDownloadDir() {
    try {
      const pref = store && store.get && store.get('downloadDir')
      if (pref && typeof pref === 'string') {
        fs.mkdirSync(pref, { recursive: true })
        return pref
      }
    } catch (_) {}
    try { return app.getPath('downloads') } catch (_) {}
    try { return path.join(app.getPath('userData'), 'downloads') } catch (_) {}
    return path.join(require('node:os').tmpdir(), 'tintin-downloads')
  }

  // 兼容双调用形态：_updateTaskProgress/_updateTaskStatus 传入完整消息对象（单参），
  // 其余调用方传 (taskId, payload)。此前固定双参导致消息被二次包装为 {taskId: MSG}，
  // 渲染层 id 变成对象引用 → 幂等失效 → 每个进度事件新建一张 0% 空 JSON 卡。
  function broadcast(msgOrTaskId, maybePayload) {
    try {
      const msg = typeof msgOrTaskId === 'string'
        ? { taskId: msgOrTaskId, ...(maybePayload || {}) }
        : msgOrTaskId
      if (!msg || !msg.taskId || typeof msg.taskId !== 'string') return
      // 注册表同步：主窗口 + 浮窗面板共用同一份状态（单一真相源）
      _registryUpsert(msg.taskId, msg.kind === 'progress'
        ? { progress: msg.progress || 0, message: msg.message || '', receivedBytes: msg.receivedBytes || 0 }
        : { status: msg.status, progress: msg.progress || 0, size: msg.size || 0, message: msg.message || '' })
      if (FINAL_STATUSES.includes(msg.status)) _persistHistory()
      const mw = getMainWindow && getMainWindow()
      if (mw && !mw.isDestroyed()) {
        mw.webContents.send('browser:downloads-updated', msg)
      }
      const panel = getDownloadsPanel && getDownloadsPanel()
      if (panel && !panel.isDestroyed()) {
        panel.webContents.send('browser:downloads-updated', msg)
      }
    } catch (_) {}
  }

  // ── IPC: browser:downloadMediaStart ──
  ipcMain.handle('browser:downloadMediaStart', async (_e, params) => {
    const { taskId, url, audioUrl, filename, title, referer, subDir, useYtdlp, platformId } = params
    const partition = platformId ? `persist:tintin-${platformId}` : 'persist:tintin-browser'

    let downloadDir = _resolveDownloadDir()
    try {
      downloadDir = path.join(downloadDir, subDir || '')
      fs.mkdirSync(downloadDir, { recursive: true })
    } catch (_) {
      downloadDir = path.join(require('node:os').tmpdir(), 'tintin-downloads', subDir || '')
      fs.mkdirSync(downloadDir, { recursive: true })
    }

    let safeFilename = (filename || 'media').replace(/[\\/:*?"<>|]/g, '_')
    let finalPath = path.join(downloadDir, safeFilename)
    let counter = 1
    const ext = path.extname(safeFilename)
    const base = path.basename(safeFilename, ext)
    while (fs.existsSync(finalPath)) {
      safeFilename = `${base}_${counter}${ext}`
      finalPath = path.join(downloadDir, safeFilename)
      counter++
    }

    activeDownloads.set(taskId, { type: 'downloading', startTime: Date.now() })
    // 注册表建档：title/path 等静态信息只在此登记一次，后续 broadcast 仅刷新动态字段
    _registryUpsert(taskId, {
      title: params.title || safeFilename,
      filename: safeFilename,
      path: finalPath,
      url: url || '',
      platformId: platformId || null,
      audioUrl: audioUrl || null,
      status: 'downloading',
    })

    const isVideoPage = useYtdlp === true || (useYtdlp !== false && referer && _isValidVideoPageUrl(referer))
    _updateTaskStatus(broadcast, taskId, 'downloading', 0, 0, isVideoPage ? '正在通过 yt-dlp 解析视频...' : '准备下载...')

    if (isVideoPage) {
      const urlToDownload = referer || url

      let cookieDomains = []
      if (urlToDownload.includes('youtube.com') || urlToDownload.includes('youtu.be')) {
        cookieDomains = ['.youtube.com', '.google.com']
      } else if (urlToDownload.includes('bilibili.com')) {
        cookieDomains = ['.bilibili.com']
      } else if (urlToDownload.includes('douyin.com')) {
        cookieDomains = ['.douyin.com']
      }

      let cookieTempPath = null
      if (cookieDomains.length > 0) {
        try {
          const sess = session.fromPartition(partition)
          let cookieLines = '# Netscape HTTP Cookie File\n# Generated by TinTin Client\n'
          for (const domain of cookieDomains) {
            const domainCookies = await sess.cookies.get({ domain }).catch(() => [])
            for (const c of domainCookies) {
              const d = c.domain.startsWith('.') ? c.domain : '.' + c.domain
              const flag = 'TRUE'
              const p = c.path || '/'
              const secure = c.secure ? 'TRUE' : 'FALSE'
              const exp = c.expirationDate ? Math.round(c.expirationDate) : Math.round(Date.now() / 1000 + 86400 * 30)
              cookieLines += `${d}\t${flag}\t${p}\t${secure}\t${exp}\t${c.name}\t${c.value}\n`
            }
          }
          const domainCookies2 = await sess.cookies.get({}).catch(() => [])
          const relevant = domainCookies2.filter(c =>
            cookieDomains.some(d => c.domain.includes(d.replace(/^\./, '')))
          )
          for (const c of relevant) {
            const d = c.domain.startsWith('.') ? c.domain : '.' + c.domain
            const flag = 'TRUE'
            const p = c.path || '/'
            const secure = c.secure ? 'TRUE' : 'FALSE'
            const exp = c.expirationDate ? Math.round(c.expirationDate) : Math.round(Date.now() / 1000 + 86400 * 30)
            cookieLines += `${d}\t${flag}\t${p}\t${secure}\t${exp}\t${c.name}\t${c.value}\n`
          }
          const nonHeaderLines = cookieLines.split('\n').filter(l => l.trim() && !l.startsWith('#'))
          if (nonHeaderLines.length > 0) {
            cookieTempPath = finalPath + '.cookies.txt'
            fs.writeFileSync(cookieTempPath, cookieLines, 'utf-8')
          }
        } catch (_) {}
      }

      let ytdlpInfo = await _getYtdlpArgs()
      if (!ytdlpInfo) {
        _updateTaskStatus(broadcast, taskId, 'failed', 0, 0, 'yt-dlp 未安装，请先安装 yt-dlp: pip install yt-dlp')
        activeDownloads.delete(taskId)
        return { success: false, error: 'yt-dlp not found' }
      }

      const formatList = ['bv+ba/b', 'best', 'bestvideo+bestaudio/best', 'worst']
      let lastError = '', lastLog = ''

      for (const fmt of formatList) {
        if (!activeDownloads.has(taskId) || activeDownloads.get(taskId) === 'cancelled') break
        _updateTaskProgress(broadcast, taskId, 5, `正在通过 yt-dlp 下载 (格式: ${fmt})...`, 0)

        const allArgs = [
          ...ytdlpInfo.args,
          ...(cookieTempPath ? ['--cookies', cookieTempPath] : []),
          '--no-warnings',
          '--extractor-retries', '3',
          '--retries', '5',
          '-f', fmt,
          '--merge-output-format', 'mp4',
          '-o', finalPath,
          urlToDownload,
        ]

        const result = await new Promise((resolve) => {
          let stderrBuf = ''
          let stdoutBuf = ''
          const child = spawn(ytdlpInfo.cmd, allArgs, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })

          const parseProgress = (text) => {
            const match = text.match(/\[download\]\s+(\d+\.\d+)%\s+of\s+([^\s]+)\s+at\s+([^\s]+)/)
            if (match) _updateTaskProgress(broadcast, taskId, Math.round(parseFloat(match[1])), `下载中 ${match[3]}`, 0)
          }

          child.stdout.on('data', (data) => { const s = data.toString(); stdoutBuf += s; parseProgress(s) })
          child.stderr.on('data', (data) => { const s = data.toString(); stderrBuf += s; parseProgress(s) })

          child.on('close', (code) => {
            try { if (cookieTempPath && fs.existsSync(cookieTempPath)) fs.unlinkSync(cookieTempPath) } catch (_) {}
            if (code === 0) {
              let finalSize = 0
              try { if (fs.existsSync(finalPath)) finalSize = fs.statSync(finalPath).size } catch (_) {}
              resolve({ success: true, size: finalSize })
            } else {
              let fileCreated = false
              try { fileCreated = fs.existsSync(finalPath) && fs.statSync(finalPath).size > 0 } catch (_) {}
              if (fileCreated) {
                resolve({ success: true, size: fs.statSync(finalPath).size })
              } else {
                const fullOutput = (stderrBuf + '\n--- stdout ---\n' + stdoutBuf).trim()
                lastError = `yt-dlp exit code ${code}`
                lastLog = fullOutput
                resolve({ success: false, error: lastError, log: fullOutput })
              }
            }
          })

          child.on('error', (e) => { resolve({ success: false, error: e.message }) })
          activeDownloads.set(taskId, child)
        })

        if (result.success) {
          activeDownloads.delete(taskId)
          _updateTaskStatus(broadcast, taskId, 'completed', 100, result.size)
          return { success: true }
        }
      }

      activeDownloads.delete(taskId)
      _updateTaskStatus(broadcast, taskId, 'failed', 0, 0, `下载失败: ${lastError}`, lastLog)
      return { success: false, error: lastError }
    }

    // ── 流式下载模式 ──
    const cleanUrl = _cleanMediaUrl(url)
    const cleanAudioUrl = audioUrl ? _cleanMediaUrl(audioUrl) : null

    try {
      if (cleanAudioUrl) {
        // 音视频分离下载 + FFmpeg 合并
        const videoTempPath = finalPath + '.video.tmp'
        const audioTempPath = finalPath + '.audio.tmp'

        let videoBytes = { received: 0, total: 0 }
        let audioBytes = { received: 0, total: 0 }
        let vPct = 0
        let aPct = 0

        const videoPromise = _downloadStream(taskId + '_video', cleanUrl, videoTempPath, referer, partition, (_p) => {
          videoBytes.received = _p.receivedBytes || 0
          videoBytes.total = _p.size || 0
          vPct = _p.progress || 0
          const total = videoBytes.total + audioBytes.total
          const received = videoBytes.received + audioBytes.received
          const progress = total > 0 ? Math.round((received / total) * 100) : 0
          _updateTaskProgress(broadcast, taskId, progress, `视频 ${vPct}% · 音频 ${aPct}%`, received)
        })

        const audioPromise = _downloadStream(taskId + '_audio', cleanAudioUrl, audioTempPath, referer, partition, (_p) => {
          audioBytes.received = _p.receivedBytes || 0
          audioBytes.total = _p.size || 0
          aPct = _p.progress || 0
          const total = videoBytes.total + audioBytes.total
          const received = videoBytes.received + audioBytes.received
          const progress = total > 0 ? Math.round((received / total) * 100) : 0
          _updateTaskProgress(broadcast, taskId, progress, `视频 ${vPct}% · 音频 ${aPct}%`, received)
        })

        try {
          const [videoRes, audioRes] = await Promise.all([videoPromise, audioPromise])
          const totalSize = (videoRes.totalBytes || 0) + (audioRes.totalBytes || 0)
          _updateTaskProgress(broadcast, taskId, 99, '正在使用 FFmpeg 合并音视频...', totalSize)

          const ffmpegBin = _getFfmpegPath(app, __dirname)
          const cmd = `${ffmpegBin} -y -i "${videoTempPath}" -i "${audioTempPath}" -c:v copy -c:a aac -strict experimental "${finalPath}"`

          await new Promise((resolve) => {
            const { exec } = require('node:child_process')
            exec(cmd, (err) => {
              try { if (fs.existsSync(videoTempPath)) fs.unlinkSync(videoTempPath) } catch (_) {}
              try { if (fs.existsSync(audioTempPath)) fs.unlinkSync(audioTempPath) } catch (_) {}
              if (err) {
                try { fs.renameSync(videoTempPath, finalPath) } catch (_) {}
                _updateTaskStatus(broadcast, taskId, 'completed', 100, videoRes.totalBytes || 0, 'FFmpeg 合并失败，仅保存视频')
              } else {
                _updateTaskStatus(broadcast, taskId, 'completed', 100, totalSize)
              }
              resolve()
            })
          })
          activeDownloads.delete(taskId)
          return { success: true }
        } catch (err) {
          try { if (fs.existsSync(videoTempPath)) fs.unlinkSync(videoTempPath) } catch (_) {}
          try { if (fs.existsSync(audioTempPath)) fs.unlinkSync(audioTempPath) } catch (_) {}
          activeDownloads.delete(taskId)
          _updateTaskStatus(broadcast, taskId, 'failed', 0, 0, `下载失败: ${err.message}`)
          return { success: false, error: err.message }
        }
      } else {
        // 单文件下载
        try {
          const result = await _downloadStream(taskId, cleanUrl, finalPath, referer, partition, (p) => {
            const progress = p.progress || 0
            const speed = p.message || ''
            _updateTaskProgress(broadcast, taskId, progress, speed, p.receivedBytes)
          })
          const finalSize = result.totalBytes || 0
          _updateTaskStatus(broadcast, taskId, 'completed', 100, finalSize)
          activeDownloads.delete(taskId)
          return { success: true, size: finalSize }
        } catch (err) {
          activeDownloads.delete(taskId)
          _updateTaskStatus(broadcast, taskId, 'failed', 0, 0, `下载失败: ${err.message}`)
          return { success: false, error: err.message }
        }
      }
    } catch (err) {
      activeDownloads.delete(taskId)
      _updateTaskStatus(broadcast, taskId, 'failed', 0, 0, `下载失败: ${err.message}`)
      return { success: false, error: err.message }
    }
  })

  // ── IPC: browser:downloadMediaCancel ──
  ipcMain.handle('browser:downloadMediaCancel', (_e, taskId) => {
    if (_killActiveTask(taskId)) {
      broadcast(taskId, { kind: 'status', status: 'cancelled', message: '已取消', ts: Date.now() })
      return { success: true }
    }
    return { success: false }
  })

  // ── IPC: browser:downloadMediaPause ──
  ipcMain.handle('browser:downloadMediaPause', (_e, taskId) => {
    if (_killActiveTask(taskId)) {
      broadcast(taskId, { kind: 'status', status: 'paused', message: '已暂停', ts: Date.now() })
      return { success: true }
    }
    return { success: false }
  })

  // ── IPC: 下载面板数据源与文件操作（注册表为单一真相源） ──
  ipcMain.handle('browser:downloadsSnapshot', async () => {
    const items = [...taskRegistry.values()]
      .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))
    return { success: true, items }
  })
  ipcMain.handle('browser:downloadOpenFile', async (_e, taskId) => {
    const t = taskRegistry.get(taskId)
    if (!t || !t.path) return { success: false, error: '任务不存在' }
    if (!fs.existsSync(t.path)) return { success: false, error: '文件不存在或已被移动' }
    await shell.openPath(t.path)
    return { success: true }
  })
  ipcMain.handle('browser:downloadRevealPath', (_e, taskId) => {
    const t = taskRegistry.get(taskId)
    if (!t || !t.path) return { success: false, error: '任务不存在' }
    if (fs.existsSync(t.path)) shell.showItemInFolder(t.path)
    else shell.openPath(path.dirname(t.path)).catch(() => {})
    return { success: true }
  })
  ipcMain.handle('browser:downloadRemoveRecord', (_e, taskId) => {
    _killActiveTask(taskId)
    taskRegistry.delete(taskId)
    _persistHistory()
    return { success: true }
  })

  // ── 下载路径设置：浮窗「📁」按钮读取/修改（store: downloadDir）──
  ipcMain.handle('browser:downloadGetDir', () => {
    try { return { success: true, dir: _resolveDownloadDir() } }
    catch (e) { return { success: false, error: e.message } }
  })
  ipcMain.handle('browser:downloadSetDir', async () => {
    try {
      const owner = (getDownloadsPanel && getDownloadsPanel()) || (getMainWindow && getMainWindow())
      const r = await dialog.showOpenDialog(owner && !owner.isDestroyed() ? owner : undefined, {
        title: '选择下载保存路径',
        defaultPath: _resolveDownloadDir(),
        properties: ['openDirectory', 'createDirectory'],
      })
      if (r.canceled || !r.filePaths || !r.filePaths[0]) return { success: false, cancelled: true }
      const dir = r.filePaths[0]
      try { if (store && store.set) store.set('downloadDir', dir) } catch (_) {}
      return { success: true, dir }
    } catch (e) { return { success: false, error: e.message } }
  })

  return {}
}

module.exports = { createMediaDownloader }