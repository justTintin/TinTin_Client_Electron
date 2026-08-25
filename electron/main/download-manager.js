const { ipcMain, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const https = require('node:https')
const http = require('node:http')
const { URL } = require('node:url')

// 下载任务状态
const downloadTasks = new Map()

/**
 * 统一下载管理器
 * 支持 BrowserView 下载 + 手动 URL 下载
 * 统一进度广播到渲染进程
 */
function createDownloadManager(ipcMain, workspacePath) {
  let taskIdCounter = 0

  function genTaskId() {
    taskIdCounter++
    return `dl_${Date.now().toString(36)}_${taskIdCounter}`
  }

  // 广播进度到所有窗口
  function broadcastProgress(taskId, progress) {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('downloads:progress', { taskId, ...progress })
    }
  }

  // 广播完成
  function broadcastDone(taskId, result) {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('downloads:done', { taskId, ...result })
    }
    downloadTasks.delete(taskId)
  }

  // 广播错误
  function broadcastError(taskId, error) {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('downloads:error', { taskId, error: error.message })
    }
    downloadTasks.delete(taskId)
  }

  // 处理 Electron 原生下载（来自 BrowserView/webContents）
  function handleNativeDownload(item, webContents, params) {
    const taskId = genTaskId()
    const savePath = params.savePath || path.join(workspacePath, 'materials', item.getFilename())

    // 确保目录存在
    fs.mkdirSync(path.dirname(savePath), { recursive: true })

    item.setSavePath(savePath)

    let lastPercent = 0
    item.on('updated', (event, state) => {
      if (state === 'interrupted') {
        broadcastProgress(taskId, { state: 'paused', percent: lastPercent })
      } else if (state === 'progressing') {
        const received = item.getReceivedBytes()
        const total = item.getTotalBytes()
        const percent = total > 0 ? Math.round((received / total) * 100) : 0
        const speed = calculateSpeed(taskId, received)
        lastPercent = percent
        broadcastProgress(taskId, {
          state: 'downloading',
          percent,
          speed,
          downloaded: received,
          total
        })
      }
    })

    item.once('done', (event, state) => {
      if (state === 'completed') {
        const stat = fs.statSync(savePath)
        broadcastDone(taskId, { finalPath: savePath, size: stat.size })
      } else {
        broadcastError(taskId, new Error(`Download ${state}`))
      }
    })

    // 存储任务引用以便暂停/取消
    downloadTasks.set(taskId, {
      type: 'native',
      item,
      savePath
    })

    return taskId
  }

  // 手动 URL 下载（http/https 直接下载）
  function startUrlDownload(url, savePath, { referer, headers } = {}) {
    return new Promise((resolve, reject) => {
      const taskId = genTaskId()
      const parsedUrl = new URL(url)
      const isHttps = parsedUrl.protocol === 'https:'
      const lib = isHttps ? https : http

      fs.mkdirSync(path.dirname(savePath), { recursive: true })
      const fileStream = fs.createWriteStream(savePath)

      const reqHeaders = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        ...headers
      }
      if (referer) reqHeaders['Referer'] = referer

      const req = lib.request({
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (isHttps ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'GET',
        headers: reqHeaders,
        timeout: 60000
      }, (res) => {
        // 处理重定向
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          fileStream.close()
          fs.unlinkSync(savePath)
          const redirectUrl = new URL(res.headers.location, url).href
          startUrlDownload(redirectUrl, savePath, { referer, headers })
            .then(resolve).catch(reject)
          return
        }

        if (res.statusCode !== 200) {
          fileStream.close()
          fs.unlinkSync(savePath).catch(() => {})
          reject(new Error(`HTTP ${res.statusCode}`))
          return
        }

        const totalBytes = parseInt(res.headers['content-length'] || '0', 10)
        let receivedBytes = 0
        let startTime = Date.now()
        let lastSpeedUpdate = 0

        downloadTasks.set(taskId, {
          type: 'url',
          req,
          fileStream,
          savePath,
          receivedBytes,
          totalBytes,
          startTime
        })

        res.on('data', (chunk) => {
          receivedBytes += chunk.length
          fileStream.write(chunk)

          const percent = totalBytes > 0 ? Math.round((receivedBytes / totalBytes) * 100) : 0
          const elapsed = (Date.now() - startTime) / 1000
          const speed = elapsed > 0 ? Math.round(receivedBytes / elapsed) : 0

          // 限流广播（每 500ms 或每 1%）
          const now = Date.now()
          if (now - lastSpeedUpdate > 500 || percent === 100) {
            broadcastProgress(taskId, {
              state: 'downloading',
              percent,
              speed,
              downloaded: receivedBytes,
              total: totalBytes
            })
            lastSpeedUpdate = now
          }

          // 更新任务状态
          const task = downloadTasks.get(taskId)
          if (task) {
            task.receivedBytes = receivedBytes
          }
        })

        res.on('end', () => {
          fileStream.end(() => {
            const stat = fs.statSync(savePath)
            broadcastDone(taskId, { finalPath: savePath, size: stat.size })
          })
        })

        res.on('error', (err) => {
          fileStream.close()
          try { fs.unlinkSync(savePath) } catch (e) {}
          broadcastError(taskId, err)
        })
      })

      req.on('error', (err) => {
        fileStream.close()
        try { fs.unlinkSync(savePath) } catch (e) {}
        broadcastError(taskId, err)
      })

      req.on('timeout', () => {
        req.destroy(new Error('Download timeout'))
      })

      req.end()

      resolve(taskId)
    })
  }

  // 速度计算
  const speedTrackers = new Map()
  function calculateSpeed(taskId, received) {
    const now = Date.now()
    if (!speedTrackers.has(taskId)) {
      speedTrackers.set(taskId, { lastTime: now, lastBytes: 0, speed: 0 })
    }
    const tracker = speedTrackers.get(taskId)
    const elapsed = (now - tracker.lastTime) / 1000
    if (elapsed > 0.5) {
      tracker.speed = Math.round((received - tracker.lastBytes) / elapsed)
      tracker.lastTime = now
      tracker.lastBytes = received
    }
    return tracker.speed
  }

  // ── IPC 接口 ──

  // 启动下载
  ipcMain.handle('downloads:start', async (event, params) => {
    const { url, savePath, referer, headers } = params
    return await startUrlDownload(url, savePath, { referer, headers })
  })

  // 暂停（仅 URL 下载支持）
  ipcMain.handle('downloads:pause', (event, taskId) => {
    const task = downloadTasks.get(taskId)
    if (task) {
      if (task.type === 'native' && task.item) {
        // Electron 原生下载暂停
        task.item.pause()
      } else if (task.type === 'url' && task.req) {
        task.req.destroy()
        task.paused = true
      }
    }
  })

  // 恢复
  ipcMain.handle('downloads:resume', (event, taskId) => {
    const task = downloadTasks.get(taskId)
    if (task) {
      if (task.type === 'native' && task.item) {
        task.item.resume()
      } else if (task.type === 'url' && task.paused) {
        // URL 下载需要重新请求
        task.paused = false
      }
    }
  })

  // 取消
  ipcMain.handle('downloads:cancel', (event, taskId) => {
    const task = downloadTasks.get(taskId)
    if (task) {
      if (task.type === 'native' && task.item) {
        task.item.cancel()
      } else if (task.type === 'url' && task.req) {
        task.req.destroy()
        if (task.fileStream) task.fileStream.close()
        try { fs.unlinkSync(task.savePath) } catch (e) {}
      }
      downloadTasks.delete(taskId)
      speedTrackers.delete(taskId)
    }
  })

  // 获取下载列表
  ipcMain.handle('downloads:list', (event) => {
    const list = []
    for (const [taskId, task] of downloadTasks) {
      list.push({
        taskId,
        savePath: task.savePath,
        receivedBytes: task.receivedBytes || 0,
        totalBytes: task.totalBytes || 0,
        type: task.type
      })
    }
    return list
  })

  // 暴露原生下载处理器给 BrowserView
  return { handleNativeDownload }
}

module.exports = { createDownloadManager }
