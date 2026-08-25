// ═══════════════════════════════════════════════════════════════
// server-proxy.js — IPC → HTTP 代理桥（主进程内模块，属于【客户端】的一部分）
//
// 注意：这里【不启动任何服务器】，也不监听任何端口。
// 它的角色只是：把渲染进程通过 IPC 发来的请求（server:get/post/upload/...）
// 用 Node 侧 http/https 转发给【外部已部署】的 AI 推理服务（默认 ai_config.json
// 里的 server_url，或回退 http://127.0.0.1:8766），从而让渲染进程不关心 CORS /
// Cookie / X-Machine-ID 注入等细节。
//
// Electron 客户端在"外部服务未启动"时，仍可独立运行（工作台/浏览器/媒体工具 UI
// 全部可用；媒体工具卡片会因为能力探测 offline 而显示"未部署"态）。
// ═══════════════════════════════════════════════════════════════

const { ipcMain } = require('electron')
const https = require('node:https')
const http = require('node:http')
const { URL } = require('node:url')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

// 获取 machine_id（与 V2 PySide6 客户端一致，从 ai_config.json 读取或生成）
let cachedMachineId = null

function getMachineId() {
  if (cachedMachineId) return cachedMachineId
  // 尝试从配置文件读取
  const configPaths = [
    path.resolve(__dirname, '..', '..', '..', 'studio', 'config', 'ai_config.json'),
    path.resolve(__dirname, '..', '..', 'config', 'ai_config.json')
  ]
  for (const p of configPaths) {
    if (fs.existsSync(p)) {
      try {
        const cfg = JSON.parse(fs.readFileSync(p, 'utf-8'))
        if (cfg.machine_id) {
          cachedMachineId = cfg.machine_id
          return cachedMachineId
        }
      } catch (e) {}
    }
  }
  // 回退：用 hostname 生成
  cachedMachineId = os.hostname() + '-' + Date.now().toString(36)
  return cachedMachineId
}

// 从 ai_config.json 读取服务端地址
function getServerUrl() {
  const configPaths = [
    path.resolve(__dirname, '..', '..', '..', 'studio', 'config', 'ai_config.json'),
    path.resolve(__dirname, '..', '..', 'config', 'ai_config.json')
  ]
  for (const p of configPaths) {
    if (fs.existsSync(p)) {
      try {
        const cfg = JSON.parse(fs.readFileSync(p, 'utf-8'))
        if (cfg.server_url) return cfg.server_url.replace(/\/$/, '')
        if (cfg.server && cfg.server.url) return cfg.server.url.replace(/\/$/, '')
      } catch (e) {}
    }
  }
  return 'http://127.0.0.1:8766'
}

// ══════════════════════════════════════════════════════════════════
// API_ENDPOINTS — 服务端 HTTP 路径常量（与 types/server-api.ts 的 API_PATHS 保持同步）
// 新增/改路径时：先改 server-api.ts 的类型声明，再把这里改成同值；避免 IPC 层字符串硬编码。
// ══════════════════════════════════════════════════════════════════
const API_ENDPOINTS = {
  health: { capabilities: '/health/capabilities', check: '/health/check' },
  stats:  { workbench: '/stats/workbench' },
  llm:    { chatCompletions: '/llm/chat/completions', adjustCopywriting: '/script/adjust-copywriting', list: '/script/list' },
  asr:    { transcribe: '/whisper/transcribe' },
  tts:    { generate: '/voxcpm/tts', cloneVoice: '/voxcpm/clone-voice', voicesList: '/voices/list', voicesSamples: '/voices/samples' },
  workflow:{ run: '/workflow/run' },
  material: {
    list: '/material/list', search: '/material/search', serve: '/material/serve',
    ocr: '/material/ocr', stockSearch: '/material/stock_search', scoreClip: '/material/score-clip'
  },
  montage: { split: '/montage/split', concat: '/montage/concat', beatSync: '/montage/beat', auto: '/montage/auto-mix' },
  vsr:     { enhance: '/vsr/enhance', remove: '/vsr/remove' },
  rembg:   { matting: '/rembg/matting' },
  vision:  { reversePrompt: '/vision/reverse-prompt' },
  digitalHuman: { generate: '/digital-human/generate', listModels: '/digital-human/models' },
  storyboard: { scripts: '/api/storyboard/scripts', scriptItem: (id) => `/api/storyboard/scripts/${id}` },
  agent: {
    registry: '/agent/registry',
    tasks: '/agent/tasks',
    taskItem:        (id) => `/agent/tasks/${id}`,
    taskConfirm:     (id) => `/agent/tasks/${id}/confirm`,
    taskPause:       (id) => `/agent/tasks/${id}/pause`,
    taskResume:      (id) => `/agent/tasks/${id}/resume`,
    taskRetry:       (id) => `/agent/tasks/${id}/retry`,
    taskCancel:      (id) => `/agent/tasks/${id}/cancel`,
    artifacts: '/agent/artifacts',
    taskArtifacts:   (id) => `/agent/tasks/${id}/artifacts`,
    chat: '/agent/chat',
    sessions: '/agent/sessions',
    sessionItem:     (id) => `/agent/sessions/${id}`,
  },
  tasks: {
    unifiedList: '/tasks/unified',
    unifiedItem: (id) => `/tasks/unified/${id}`,
    item:        (id) => `/tasks/${id}`,
    itemResult:  (id) => `/tasks/${id}/result`,
  },
  scheduled: { tasks: '/scheduled/tasks', taskItem: (id) => `/scheduled/tasks/${id}` },
  editor:    { renderPackage: (id) => `/editor/render/${id}/package` },
  system:    { license: '/system/license', guide: '/guide' },
}

/** 解析 endpoint（支持 string | (id)=>string 两种形态），拼接 query string */
function resolveEndpoint(endpoint, params) {
  const path = typeof endpoint === 'function' ? endpoint(...(params?.__args || [])) : endpoint
  if (!params) return path
  const qsKeys = Object.keys(params).filter((k) => k !== '__args')
  if (!qsKeys.length) return path
  const qs = new URLSearchParams()
  qsKeys.forEach((k) => {
    const v = params[k]
    if (Array.isArray(v)) v.forEach((x) => qs.append(k, String(x)))
    else if (v !== undefined && v !== null) qs.set(k, String(v))
  })
  const qsStr = qs.toString()
  return qsStr ? path + (path.includes('?') ? '&' : '?') + qsStr : path
}

/**
 * 统一的 HTTP 请求封装（Node 侧发起，避免渲染进程 CORS）
 */
function httpRequest(method, fullPath, { body, headers = {}, timeout = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const baseUrl = getServerUrl()
    const url = new URL(fullPath.startsWith('http') ? fullPath : baseUrl + fullPath)

    const isHttps = url.protocol === 'https:'
    const lib = isHttps ? https : http

    const defaultHeaders = {
      'X-Machine-ID': getMachineId(),
      'User-Agent': 'TintinElectron/3.0'
    }

    // JSON body
    let bodyData = null
    if (body !== undefined && body !== null) {
      if (Buffer.isBuffer(body) || typeof body === 'string') {
        bodyData = body
        if (!headers['Content-Type']) {
          headers['Content-Type'] = 'application/octet-stream'
        }
      } else {
        bodyData = JSON.stringify(body)
        if (!headers['Content-Type']) {
          headers['Content-Type'] = 'application/json'
        }
      }
      defaultHeaders['Content-Length'] = Buffer.byteLength(bodyData)
    }

    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method,
      headers: { ...defaultHeaders, ...headers },
      timeout
    }

    const req = lib.request(options, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => {
        const buf = Buffer.concat(chunks)
        const contentType = res.headers['content-type'] || ''
        let parsed = buf
        if (contentType.includes('application/json')) {
          try {
            parsed = JSON.parse(buf.toString('utf-8'))
          } catch (e) {
            parsed = buf.toString('utf-8')
          }
        } else if (contentType.startsWith('text/')) {
          parsed = buf.toString('utf-8')
        }
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ data: parsed, status: res.statusCode, headers: res.headers, raw: buf })
        } else {
          const err = new Error(`HTTP ${res.statusCode}`)
          err.status = res.statusCode
          err.response = parsed
          err.retryAfter = res.headers['retry-after']
          reject(err)
        }
      })
    })

    req.on('timeout', () => {
      req.destroy(new Error('Request timeout'))
    })
    req.on('error', reject)

    if (bodyData) req.write(bodyData)
    req.end()
  })
}

/**
 * Multipart/form-data 上传
 */
function multipartUpload(urlPath, fields, onProgress) {
  return new Promise((resolve, reject) => {
    const boundary = '----TintinBoundary' + Math.random().toString(16).substring(2)
    const parts = []
    let totalSize = 0

    for (const [key, value] of Object.entries(fields)) {
      let header = `--${boundary}\r\n`
      if (value instanceof fs.ReadStream || (value && typeof value.pipe === 'function')) {
        // 文件流
        const filePath = value.path
        const filename = path.basename(filePath)
        const stat = fs.statSync(filePath)
        header += `Content-Disposition: form-data; name="${key}"; filename="${filename}"\r\n`
        header += `Content-Type: ${getMimeType(filename)}\r\n\r\n`
        const headerBuf = Buffer.from(header, 'utf-8')
        parts.push({ type: 'header', data: headerBuf })
        const fileBuf = fs.readFileSync(filePath)
        parts.push({ type: 'file', data: fileBuf })
        totalSize += headerBuf.length + fileBuf.length
      } else if (value && value.path) {
        // { path: '...' } 对象
        const filePath = value.path
        const filename = value.filename || path.basename(filePath)
        const stat = fs.statSync(filePath)
        header += `Content-Disposition: form-data; name="${key}"; filename="${filename}"\r\n`
        header += `Content-Type: ${value.contentType || getMimeType(filename)}\r\n\r\n`
        const headerBuf = Buffer.from(header, 'utf-8')
        const fileBuf = fs.readFileSync(filePath)
        parts.push({ type: 'header', data: headerBuf })
        parts.push({ type: 'file', data: fileBuf })
        totalSize += headerBuf.length + fileBuf.length
      } else {
        // 普通文本字段
        header += `Content-Disposition: form-data; name="${key}"\r\n\r\n`
        const headerBuf = Buffer.from(header, 'utf-8')
        const valBuf = Buffer.from(String(value), 'utf-8')
        parts.push({ type: 'header', data: headerBuf })
        parts.push({ type: 'value', data: valBuf })
        totalSize += headerBuf.length + valBuf.length
      }
    }

    const endBuf = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf-8')
    totalSize += endBuf.length

    const bodyBuf = Buffer.concat(parts.map(p => p.data).concat([endBuf]))

    const baseUrl = getServerUrl()
    const fullUrl = new URL(urlPath.startsWith('http') ? urlPath : baseUrl + urlPath)
    const isHttps = fullUrl.protocol === 'https:'
    const lib = isHttps ? https : http

    const options = {
      hostname: fullUrl.hostname,
      port: fullUrl.port || (isHttps ? 443 : 80),
      path: fullUrl.pathname + fullUrl.search,
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': bodyBuf.length,
        'X-Machine-ID': getMachineId(),
        'User-Agent': 'TintinElectron/3.0'
      },
      timeout: 300000 // 文件上传 5 分钟超时
    }

    const req = lib.request(options, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => {
        const buf = Buffer.concat(chunks)
        const contentType = res.headers['content-type'] || ''
        let parsed = buf
        if (contentType.includes('application/json')) {
          try { parsed = JSON.parse(buf.toString('utf-8')) } catch (e) {}
        }
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(parsed)
        } else {
          const err = new Error(`HTTP ${res.statusCode}`)
          err.status = res.statusCode
          err.response = parsed
          reject(err)
        }
      })
    })

    req.on('error', reject)
    req.on('timeout', () => req.destroy(new Error('Upload timeout')))

    // 发送 body
    if (onProgress) {
      const total = bodyBuf.length
      let sent = 0
      const chunkSize = 64 * 1024
      let offset = 0
      const writeChunk = () => {
        if (offset >= total) {
          req.end()
          return
        }
        const end = Math.min(offset + chunkSize, total)
        const chunk = bodyBuf.subarray(offset, end)
        const ok = req.write(chunk, () => {
          sent = end
          onProgress(Math.round((sent / total) * 100))
          offset = end
          if (offset < total) {
            setImmediate(writeChunk)
          } else {
            req.end()
          }
        })
        if (!ok) {
          req.once('drain', () => {
            sent = end
            onProgress(Math.round((sent / total) * 100))
            offset = end
            setImmediate(writeChunk)
          })
        } else {
          sent = end
          onProgress(Math.round((sent / total) * 100))
          offset = end
        }
      }
      writeChunk()
    } else {
      req.end(bodyBuf)
    }
  })
}

function getMimeType(filename) {
  const ext = path.extname(filename).toLowerCase()
  const map = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
    '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp',
    '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
    '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.aac': 'audio/aac',
    '.json': 'application/json', '.txt': 'text/plain', '.srt': 'text/plain'
  }
  return map[ext] || 'application/octet-stream'
}

/** 判定是否为"外部服务未部署/不可达"的正常错误，这类错误不打主进程堆栈 */
function isExpectedOfflineError(err) {
  const code = err && (err.code || err.message)
  if (!code) return false
  const offlineCodes = ['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH']
  if (typeof code === 'string' && offlineCodes.some((c) => code.includes(c))) return true
  if (typeof err.message === 'string' && /fetch failed|network error/i.test(err.message)) return true
  return false
}

function createServerProxy(ipcMain) {
  // GET
  ipcMain.handle('server:get', async (event, path, params) => {
    try {
      let fullPath = path
      if (params && Object.keys(params).length > 0) {
        const qs = new URLSearchParams(params).toString()
        fullPath += (path.includes('?') ? '&' : '?') + qs
      }
      const res = await httpRequest('GET', fullPath)
      return res.data
    } catch (err) {
      // 服务端未启动 / 无网络时静默返回 null，避免 Electron 默认 handler 打印堆栈
      if (isExpectedOfflineError(err)) return null
      throw err
    }
  })

  // POST
  ipcMain.handle('server:post', async (event, path, body, headers) => {
    try {
      const res = await httpRequest('POST', path, { body, headers: headers || {} })
      return res.data
    } catch (err) {
      if (isExpectedOfflineError(err)) return null
      throw err
    }
  })

  // PUT
  ipcMain.handle('server:put', async (event, path, body, headers) => {
    try {
      const res = await httpRequest('PUT', path, { body, headers: headers || {} })
      return res.data
    } catch (err) {
      if (isExpectedOfflineError(err)) return null
      throw err
    }
  })

  // DELETE
  ipcMain.handle('server:delete', async (event, path, params) => {
    try {
      let fullPath = path
      if (params && Object.keys(params).length > 0) {
        const qs = new URLSearchParams(params).toString()
        fullPath += (path.includes('?') ? '&' : '?') + qs
      }
      const res = await httpRequest('DELETE', fullPath)
      return res.data
    } catch (err) {
      if (isExpectedOfflineError(err)) return null
      throw err
    }
  })

  // Upload (multipart/form-data)
  ipcMain.handle('server:upload', async (event, path, fields, onProgressChannel) => {
    try {
      const onProgress = onProgressChannel
        ? (percent) => event.sender.send(onProgressChannel, percent)
        : undefined
      return await multipartUpload(path, fields, onProgress)
    } catch (err) {
      if (isExpectedOfflineError(err)) return null
      throw err
    }
  })

  // Download result as file
  ipcMain.handle('server:downloadResult', async (event, path, savePath) => {
    try {
      const res = await httpRequest('GET', path, { timeout: 600000 })
      fs.writeFileSync(savePath, res.raw)
      return savePath
    } catch (err) {
      if (isExpectedOfflineError(err)) return null
      throw err
    }
  })

  // SSE (Server-Sent Events)
  ipcMain.handle('server:sse', async (event, path, channel, errorChannel) => {
    const baseUrl = getServerUrl()
    const url = new URL(path.startsWith('http') ? path : baseUrl + path)
    const isHttps = url.protocol === 'https:'
    const lib = isHttps ? https : http

    const req = lib.request({
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method: 'GET',
      headers: {
        'Accept': 'text/event-stream',
        'X-Machine-ID': getMachineId(),
        'Cache-Control': 'no-cache'
      }
    }, (res) => {
      let buffer = ''
      res.on('data', (chunk) => {
        buffer += chunk.toString()
        const lines = buffer.split('\n')
        buffer = lines.pop()
        for (const line of lines) {
          if (line.startsWith('data:')) {
            const data = line.slice(5).trim()
            if (data === '[DONE]') {
              event.sender.send(channel, { done: true })
              return
            }
            try {
              const parsed = JSON.parse(data)
              event.sender.send(channel, parsed)
            } catch (e) {
              event.sender.send(channel, data)
            }
          }
        }
      })
      res.on('end', () => {
        event.sender.send(channel, { done: true })
      })
    })

    req.on('error', (_err) => {
      // 离线态通过 errorChannel 通知渲染层即可，不打堆栈
      if (errorChannel) {
        event.sender.send(errorChannel, isExpectedOfflineError(_err) ? 'OFFLINE' : _err.message)
      }
    })

    req.end()
    return { started: true }
  })

  // ──────────────────────────────────────────────────────────────────
  // 业务级 IPC handlers（对齐 server-api.ts 各域命名空间）
  // 目的：在 IPC 层集中做参数校验 / endpoint 解析，把渲染层从"字符串拼路径"解放出来。
  // 规范：所有业务 handler 命名 = "业务域:动作"（如 agent:registry、rembg:submit）；
  //       返回值与 server-api.ts 命名空间的 Response 一致；离线态按 isExpectedOfflineError 静默 null。
  // ──────────────────────────────────────────────────────────────────

  // --- health / stats -------------------------------------------------
  ipcMain.handle('health:capabilities', async () => {
    try {
      const res = await httpRequest('GET', API_ENDPOINTS.health.capabilities)
      return res.data
    } catch (err) { return isExpectedOfflineError(err) ? null : { error: err.message } }
  })
  ipcMain.handle('stats:workbench', async () => {
    try {
      const res = await httpRequest('GET', API_ENDPOINTS.stats.workbench)
      return res.data || { recentTasks: 0, runningTasks: 0, scripts: 0, materials: 0 }
    } catch (err) { return isExpectedOfflineError(err) ? null : { error: err.message } }
  })

  // --- agent ----------------------------------------------------------
  ipcMain.handle('agent:registry', async () => {
    try {
      const res = await httpRequest('GET', API_ENDPOINTS.agent.registry)
      return res.data || []
    } catch (err) { return isExpectedOfflineError(err) ? null : [] }
  })
  ipcMain.handle('agent:submitTask', async (_e, payload) => {
    try {
      const body = payload || {}
      if (!body.goal) throw new Error('agent:submitTask requires `goal`')
      const res = await httpRequest('POST', API_ENDPOINTS.agent.tasks, { body })
      return res.data
    } catch (err) { return isExpectedOfflineError(err) ? null : { error: err.message } }
  })
  ipcMain.handle('agent:taskAction', async (_e, { id, action, reason }) => {
    try {
      if (!id || !action) throw new Error('agent:taskAction requires id+action')
      const actions = ['confirm', 'pause', 'resume', 'retry', 'cancel']
      if (!actions.includes(action)) throw new Error(`agent:taskAction invalid action=${action}`)
      const endpointMap = {
        confirm: API_ENDPOINTS.agent.taskConfirm,
        pause:   API_ENDPOINTS.agent.taskPause,
        resume:  API_ENDPOINTS.agent.taskResume,
        retry:   API_ENDPOINTS.agent.taskRetry,
        cancel:  API_ENDPOINTS.agent.taskCancel,
      }
      const path = endpointMap[action](id)
      const res = await httpRequest('POST', path, { body: { reason: reason || '' } })
      return res.data
    } catch (err) { return isExpectedOfflineError(err) ? null : { error: err.message } }
  })
  ipcMain.handle('agent:registerArtifact', async (_e, payload) => {
    try {
      const body = payload || {}
      if (!body.task_id || !body.name) throw new Error('agent:registerArtifact requires task_id+name')
      const res = await httpRequest('POST', API_ENDPOINTS.agent.artifacts, { body })
      return res.data
    } catch (err) { return isExpectedOfflineError(err) ? null : { error: err.message } }
  })

  // --- tasks ----------------------------------------------------------
  ipcMain.handle('tasks:unifiedList', async (_e, params) => {
    try {
      const path = resolveEndpoint(API_ENDPOINTS.tasks.unifiedList, params || {})
      const res = await httpRequest('GET', path)
      return res.data || { items: [], total: 0, page: 1, page_size: 20, has_more: false }
    } catch (err) { return isExpectedOfflineError(err) ? null : { error: err.message } }
  })
  ipcMain.handle('tasks:unifiedItem', async (_e, { id }) => {
    try {
      if (!id) throw new Error('tasks:unifiedItem missing id')
      const res = await httpRequest('GET', API_ENDPOINTS.tasks.unifiedItem(id))
      return res.data
    } catch (err) { return isExpectedOfflineError(err) ? null : { error: err.message } }
  })
  ipcMain.handle('tasks:progress', async (_e, { id }) => {
    try {
      if (!id) throw new Error('tasks:progress missing id')
      const res = await httpRequest('GET', API_ENDPOINTS.tasks.item(id))
      return res.data
    } catch (err) { return isExpectedOfflineError(err) ? null : { error: err.message } }
  })
  ipcMain.handle('tasks:downloadResult', async (_e, { id, savePath }) => {
    try {
      if (!id || !savePath) throw new Error('tasks:downloadResult missing id/savePath')
      const res = await httpRequest('GET', API_ENDPOINTS.tasks.itemResult(id), { timeout: 600000 })
      fs.writeFileSync(savePath, res.raw)
      return savePath
    } catch (err) { return isExpectedOfflineError(err) ? null : { error: err.message } }
  })

  // --- V3 新接口 S1~S3（rembg / vsr / reverse-prompt）————————————————
  ipcMain.handle('rembg:submit', async (event, payload, onProgressChannel) => {
    try {
      const p = payload || {}
      if (!p.image) throw new Error('rembg:submit missing `image` Blob')
      const fields = {}
      fields.image = p.image
      if (p.model)         fields.model = p.model
      if (p.alpha_matting !== undefined) fields.alpha_matting = String(!!p.alpha_matting)
      if (p.return_mask !== undefined)   fields.return_mask   = String(!!p.return_mask)
      if (p.bg_color)      fields.bg_color = p.bg_color
      const onProgress = onProgressChannel
        ? (percent) => event.sender.send(onProgressChannel, percent)
        : undefined
      return await multipartUpload(API_ENDPOINTS.rembg.matting, fields, onProgress)
    } catch (err) { return isExpectedOfflineError(err) ? null : { error: err.message } }
  })

  ipcMain.handle('vsr:submit', async (event, payload, onProgressChannel) => {
    try {
      const p = payload || {}
      if (!p.video) throw new Error('vsr:submit missing `video` Blob')
      const fields = {}
      fields.video = p.video
      if (p.mode)              fields.mode              = p.mode
      if (p.scale)             fields.scale             = p.scale
      if (p.fps !== undefined) fields.fps               = String(p.fps)
      if (p.denoise_strength !== undefined) fields.denoise_strength = String(p.denoise_strength)
      if (p.face_restoration !== undefined) fields.face_restoration = String(!!p.face_restoration)
      if (p.trim_start_sec !== undefined)   fields.trim_start_sec   = String(p.trim_start_sec)
      if (p.trim_end_sec !== undefined)     fields.trim_end_sec     = String(p.trim_end_sec)
      const onProgress = onProgressChannel
        ? (percent) => event.sender.send(onProgressChannel, percent)
        : undefined
      return await multipartUpload(API_ENDPOINTS.vsr.enhance, fields, onProgress)
    } catch (err) { return isExpectedOfflineError(err) ? null : { error: err.message } }
  })

  ipcMain.handle('vsr:remove', async (event, payload, onProgressChannel) => {
    try {
      const p = payload || {}
      if (!p.video) throw new Error('vsr:remove missing `video` Blob')
      const fields = {}
      fields.video = p.video
      if (p.mode)              fields.mode  = p.mode
      if (Array.isArray(p.bboxes)) fields.bboxes = JSON.stringify(p.bboxes)
      const onProgress = onProgressChannel
        ? (percent) => event.sender.send(onProgressChannel, percent)
        : undefined
      return await multipartUpload(API_ENDPOINTS.vsr.remove, fields, onProgress)
    } catch (err) { return isExpectedOfflineError(err) ? null : { error: err.message } }
  })

  ipcMain.handle('vision:reversePrompt', async (event, payload, onProgressChannel) => {
    try {
      const p = payload || {}
      if (!p.file) throw new Error('vision:reversePrompt missing `file` Blob')
      const fields = {}
      fields.file = p.file
      if (p.count !== undefined)       fields.count       = String(p.count)
      if (p.style)                     fields.style       = p.style
      if (p.language)                  fields.language    = p.language
      if (p.frame_count !== undefined) fields.frame_count = String(p.frame_count)
      const onProgress = onProgressChannel
        ? (percent) => event.sender.send(onProgressChannel, percent)
        : undefined
      return await multipartUpload(API_ENDPOINTS.vision.reversePrompt, fields, onProgress)
    } catch (err) { return isExpectedOfflineError(err) ? null : { error: err.message } }
  })

  // --- asr / tts ------------------------------------------------------
  ipcMain.handle('asr:transcribe', async (event, payload, onProgressChannel) => {
    try {
      const p = payload || {}
      const hasAudio = !!p.audio
      const hasUrl = !!p.url
      if (!hasAudio && !hasUrl) throw new Error('asr:transcribe missing `audio` Blob 或 `url` 字段（二选一）')

      if (hasAudio) {
        // 本地文件上传 → multipart
        const fields = {}
        fields.audio = p.audio
        if (p.language)        fields.language        = p.language
        if (p.task)            fields.task            = p.task
        if (p.format)          fields.format          = p.format
        if (p.word_timestamps !== undefined) fields.word_timestamps = String(!!p.word_timestamps)
        const onProgress = onProgressChannel
          ? (percent) => event.sender.send(onProgressChannel, percent)
          : undefined
        return await multipartUpload(API_ENDPOINTS.asr.transcribe, fields, onProgress)
      } else {
        // URL 远程文件 → 纯 JSON POST
        const body = { url: p.url }
        if (p.language)        body.language        = p.language
        if (p.task)            body.task            = p.task
        if (p.format)          body.format          = p.format
        if (p.word_timestamps !== undefined) body.word_timestamps = !!p.word_timestamps
        const res = await httpRequest('POST', API_ENDPOINTS.asr.transcribe, { body })
        return res.data
      }
    } catch (err) { return isExpectedOfflineError(err) ? null : { error: err.message } }
  })

  ipcMain.handle('tts:generate', async (event, payload, onProgressChannel) => {
    try {
      const p = payload || {}
      if (!p.text) throw new Error('tts:generate missing `text`')
      // 有参考音频时走 multipart；否则纯 JSON 即可
      if (p.clone_ref_file) {
        const fields = {}
        fields.text = p.text
        if (p.voice_id)  fields.voice_id  = p.voice_id
        if (p.speed !== undefined)     fields.speed     = String(p.speed)
        if (p.emotion)   fields.emotion   = p.emotion
        if (p.format)    fields.format    = p.format
        fields.clone_ref_file = p.clone_ref_file
        const onProgress = onProgressChannel
          ? (percent) => event.sender.send(onProgressChannel, percent)
          : undefined
        return await multipartUpload(API_ENDPOINTS.tts.generate, fields, onProgress)
      } else {
        const res = await httpRequest('POST', API_ENDPOINTS.tts.generate, {
          body: {
            text: p.text, voice_id: p.voice_id,
            speed: p.speed, emotion: p.emotion, format: p.format
          }
        })
        return res.data
      }
    } catch (err) { return isExpectedOfflineError(err) ? null : { error: err.message } }
  })

  ipcMain.handle('tts:cloneVoice', async (event, payload, onProgressChannel) => {
    try {
      const p = payload || {}
      if (!p.name || !p.reference_audio) throw new Error('tts:cloneVoice requires name+reference_audio')
      const fields = {}
      fields.name = p.name
      fields.reference_audio = p.reference_audio
      if (p.description) fields.description = p.description
      const onProgress = onProgressChannel
        ? (percent) => event.sender.send(onProgressChannel, percent)
        : undefined
      return await multipartUpload(API_ENDPOINTS.tts.cloneVoice, fields, onProgress)
    } catch (err) { return isExpectedOfflineError(err) ? null : { error: err.message } }
  })

  ipcMain.handle('tts:voicesList', async (_e, params) => {
    try {
      const path = resolveEndpoint(API_ENDPOINTS.tts.voicesList, params || {})
      const res = await httpRequest('GET', path)
      return res.data || []
    } catch (err) { return isExpectedOfflineError(err) ? null : { error: err.message } }
  })
  ipcMain.handle('tts:voicesSamples', async (_e, params) => {
    try {
      const path = resolveEndpoint(API_ENDPOINTS.tts.voicesSamples, params || {})
      const res = await httpRequest('GET', path)
      return res.data || []
    } catch (err) { return isExpectedOfflineError(err) ? null : { error: err.message } }
  })

  // --- workflow（CoverMaker 一键成片编排）-----------------------------------------
  ipcMain.handle('workflow:run', async (_e, payload) => {
    try {
      const p = payload || {}
      if (!Array.isArray(p.nodes) || p.nodes.length === 0) throw new Error('workflow:run requires nodes[]')
      const res = await httpRequest('POST', API_ENDPOINTS.workflow.run, { body: p })
      return res.data
    } catch (err) { return isExpectedOfflineError(err) ? null : { error: err.message } }
  })

  // --- llm ------------------------------------------------------------
  ipcMain.handle('llm:chat', async (_e, payload) => {
    try {
      const p = payload || {}
      if (!p.model || !Array.isArray(p.messages)) throw new Error('llm:chat requires model+messages[]')
      const res = await httpRequest('POST', API_ENDPOINTS.llm.chatCompletions, {
        body: { model: p.model, messages: p.messages, temperature: p.temperature, stream: false }
      })
      return res.data
    } catch (err) { return isExpectedOfflineError(err) ? null : { error: err.message } }
  })
  ipcMain.handle('llm:adjustCopywriting', async (_e, payload) => {
    try {
      const p = payload || {}
      if (!p.script_id && !p.text) throw new Error('llm:adjustCopywriting requires script_id or text')
      const res = await httpRequest('POST', API_ENDPOINTS.llm.adjustCopywriting, { body: p })
      return res.data
    } catch (err) { return isExpectedOfflineError(err) ? null : { error: err.message } }
  })

  // --- material -------------------------------------------------------
  ipcMain.handle('material:list', async (_e, params) => {
    try {
      const path = resolveEndpoint(API_ENDPOINTS.material.list, params || {})
      const res = await httpRequest('GET', path)
      return res.data || { items: [], total: 0, page: 1, page_size: 20, has_more: false }
    } catch (err) { return isExpectedOfflineError(err) ? null : { error: err.message } }
  })
  ipcMain.handle('material:stockSearch', async (_e, payload) => {
    try {
      const p = payload || {}
      if (!p.query) throw new Error('material:stockSearch missing query')
      const res = await httpRequest('POST', API_ENDPOINTS.material.stockSearch, { body: p })
      return res.data || { items: [], total: 0, page: 1, page_size: 20, has_more: false }
    } catch (err) { return isExpectedOfflineError(err) ? null : { error: err.message } }
  })
  ipcMain.handle('material:ocr', async (event, payload, onProgressChannel) => {
    try {
      const p = payload || {}
      if (!p.image) throw new Error('material:ocr missing image')
      const fields = { image: p.image }
      if (p.lang) fields.lang = p.lang
      const onProgress = onProgressChannel
        ? (percent) => event.sender.send(onProgressChannel, percent)
        : undefined
      return await multipartUpload(API_ENDPOINTS.material.ocr, fields, onProgress)
    } catch (err) { return isExpectedOfflineError(err) ? null : { error: err.message } }
  })

  // --- montage --------------------------------------------------------
  ipcMain.handle('montage:split', async (event, payload, onProgressChannel) => {
    try {
      const p = payload || {}
      // 契约 Body_split_video_montage_split_post：至少一种素材来源（三选一）
      const hasFile = !!p.file
      const hasMat = !!p.material_id
      const hasUrl = !!p.clip_url
      if ((hasFile ? 1 : 0) + (hasMat ? 1 : 0) + (hasUrl ? 1 : 0) !== 1) {
        throw new Error('montage:split 需要且仅需要一个来源：file / material_id / clip_url 三选一')
      }
      const fields = {}
      if (p.file !== undefined)             fields.file          = p.file
      if (p.material_id !== undefined)      fields.material_id   = p.material_id
      if (p.clip_url !== undefined)         fields.clip_url      = p.clip_url
      if (p.threshold !== undefined)        fields.threshold     = String(p.threshold)
      if (p.min_scene_len !== undefined)    fields.min_scene_len = String(p.min_scene_len)
      if (p.dedup !== undefined)            fields.dedup         = String(!!p.dedup)
      if (p.dedup_threshold !== undefined)  fields.dedup_threshold = String(p.dedup_threshold)
      if (p.product_mode !== undefined)     fields.product_mode  = String(!!p.product_mode)
      if (p.analyze !== undefined)          fields.analyze       = String(!!p.analyze)
      if (p.image_duration !== undefined)   fields.image_duration = String(p.image_duration)
      const onProgress = onProgressChannel
        ? (percent) => event.sender.send(onProgressChannel, percent)
        : undefined
      return await multipartUpload(API_ENDPOINTS.montage.split, fields, onProgress)
    } catch (err) { return isExpectedOfflineError(err) ? null : { error: err.message } }
  })
  ipcMain.handle('montage:concat', async (_e, payload) => {
    try {
      const p = payload || {}
      if (!Array.isArray(p.paths) || p.paths.length < 2) throw new Error('montage:concat requires paths[]>=2')
      const res = await httpRequest('POST', API_ENDPOINTS.montage.concat, { body: p })
      return res.data
    } catch (err) { return isExpectedOfflineError(err) ? null : { error: err.message } }
  })
  ipcMain.handle('montage:beatSync', async (_e, payload) => {
    try {
      const p = payload || {}
      if (!p.video_path || !p.audio_path) throw new Error('montage:beatSync requires video_path+audio_path')
      const res = await httpRequest('POST', API_ENDPOINTS.montage.beatSync, { body: p })
      return res.data
    } catch (err) { return isExpectedOfflineError(err) ? null : { error: err.message } }
  })

  // --- storyboard -----------------------------------------------------
  ipcMain.handle('storyboard:listScripts', async (_e, params) => {
    try {
      const path = resolveEndpoint(API_ENDPOINTS.storyboard.scripts, params || {})
      const res = await httpRequest('GET', path)
      return res.data || { items: [], total: 0 }
    } catch (err) { return isExpectedOfflineError(err) ? null : { error: err.message } }
  })
  ipcMain.handle('storyboard:saveScript', async (_e, payload) => {
    try {
      const p = payload || {}
      if (!p.title || !Array.isArray(p.shots)) throw new Error('storyboard:saveScript requires title+shots[]')
      const method = p.id ? 'PUT' : 'POST'
      const path   = p.id ? API_ENDPOINTS.storyboard.scriptItem(p.id) : API_ENDPOINTS.storyboard.scripts
      const res = await httpRequest(method, path, { body: p })
      return res.data
    } catch (err) { return isExpectedOfflineError(err) ? null : { error: err.message } }
  })

  // --- system ---------------------------------------------------------
  ipcMain.handle('system:licenseVerify', async (_e, payload) => {
    try {
      const p = payload || {}
      if (!p.activation_code) throw new Error('system:licenseVerify requires activation_code')
      const res = await httpRequest('POST', API_ENDPOINTS.system.license, {
        body: { activation_code: p.activation_code, machine_id: getMachineId() }
      })
      return res.data
    } catch (err) { return isExpectedOfflineError(err) ? null : { error: err.message } }
  })
}

module.exports = {
  createServerProxy,
  getServerUrl,
  getMachineId,
  API_ENDPOINTS,
  // A2 inference-router 需要：直接复用 server-proxy 的 HTTP 请求能力（不经过 IPC）
  httpRequest,
  multipartUpload
}
