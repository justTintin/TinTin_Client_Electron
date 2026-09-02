// ═══════════════════════════════════════════════════════════════
// media-proxy-ipc.js — 服务端代理·媒体域 IPC（server-proxy.js 拆分）
// 自 server-proxy.js L597-757 原样迁出（IRON-02 行数守恒，行为不变）：
//   · rembg / vsr / vision（V3 新接口 S1~S3，multipart 上传）
//   · asr（whisper 转写，multipart 或 URL JSON 双路径）
//   · tts（voxcpm 合成 / 克隆 / 音色列表 / 示例）
// 依赖（httpRequest/multipartUpload/API_ENDPOINTS/resolveEndpoint/
// isExpectedOfflineError）由 server-proxy.js 注入，不重复实现。
// ═══════════════════════════════════════════════════════════════

const fs = require('node:fs')
const path = require('node:path')

function createMediaProxyIpc(ipcMain, { httpRequest, multipartUpload, API_ENDPOINTS, resolveEndpoint, isExpectedOfflineError }) {
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

  // M4 对齐 API-GUIDE 契约 Body_remove_subtitle_vsr_remove_post：
  //   file（multipart 文件）+ inpaint_mode/sub_areas/purpose/watermark_text/
  //   mode/mask_dilate/mask_expand_y/sttn_max_load_num；sub_areas='' 表示智能识别
  ipcMain.handle('vsr:remove', async (event, payload, onProgressChannel) => {
    try {
      const p = payload || {}
      if (!p.video) throw new Error('vsr:remove missing `video` Blob')
      const fields = {}
      // { path } 包装 → multipartUpload 按本地路径读取文件内容上传（字段名必须为 file）
      fields.file = typeof p.video === 'string' ? { path: p.video } : p.video
      if (p.inpaint_mode)      fields.inpaint_mode      = p.inpaint_mode
      if (p.sub_areas !== undefined && p.sub_areas !== null) fields.sub_areas = String(p.sub_areas)
      if (p.purpose)           fields.purpose           = p.purpose
      if (p.watermark_text)    fields.watermark_text    = p.watermark_text
      if (p.mode)              fields.mode              = p.mode
      if (p.mask_dilate !== undefined)      fields.mask_dilate      = String(p.mask_dilate)
      if (p.mask_expand_y !== undefined)    fields.mask_expand_y    = String(p.mask_expand_y)
      if (p.sttn_max_load_num !== undefined) fields.sttn_max_load_num = String(p.sttn_max_load_num)
      const onProgress = onProgressChannel
        ? (percent) => event.sender.send(onProgressChannel, percent)
        : undefined
      try {
        return await multipartUpload(API_ENDPOINTS.vsr.remove, fields, onProgress)
      } catch (err) {
        // 5xx/422 细节透出（对照原客户端「服务端返回 {status}: {text[:300]}」口径）
        if (err && err.status) {
          const detail = err.response ? JSON.stringify(err.response).slice(0, 300) : ''
          throw new Error(detail ? `服务端返回 ${err.status}: ${detail}` : `服务端返回 ${err.status}`)
        }
        throw err
      }
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
      // API-GUIDE 契约（/voxcpm/tts）：text(必填) + sample_id(推荐) + engine + speaker
      // 服务端返回 WAV 二进制（Content-Type: audio/wav），IPC 传 Buffer 会丢失，转 base64 透传
      const body = {
        text: p.text,
        ...(p.sample_id ? { sample_id: p.sample_id } : {}),
        ...(p.prompt_audio ? { prompt_audio: p.prompt_audio } : {}),
        ...(p.speaker || p.voice_id ? { speaker: p.speaker || p.voice_id } : {}),
        ...(p.engine ? { engine: p.engine } : {}),
      }
      const res = await httpRequest('POST', API_ENDPOINTS.tts.generate, { body })
      // 服务端返回 WAV 二进制 → 转 base64 经 IPC 传渲染层
      if (Buffer.isBuffer(res.data)) {
        return { audio_base64: res.data.toString('base64'), content_type: res.headers?.['content-type'] || 'audio/wav' }
      }
      // JSON 响应（audio_url 模式，兼容未来服务端切换）
      return res.data
    } catch (err) { return isExpectedOfflineError(err) ? null : { error: err.message } }
  })

  ipcMain.handle('tts:voicesSamples', async (_e, params) => {
    try {
      const path = resolveEndpoint(API_ENDPOINTS.tts.voicesSamples, params || {})
      const res = await httpRequest('GET', path)
      return res.data || []
    } catch (err) { return isExpectedOfflineError(err) ? null : { error: err.message } }
  })

  // API-GUIDE：POST /voice/samples（multipart: file 音频 + name + text）
  ipcMain.handle('tts:uploadSample', async (event, payload, onProgressChannel) => {
    try {
      const p = payload || {}
      if (!p.file) throw new Error('tts:uploadSample requires `file`')
      if (!p.name || !String(p.name).trim()) throw new Error('tts:uploadSample requires `name`')
      const fields = {}
      fields.file = p.file
      fields.name = String(p.name).trim()
      if (p.text) fields.text = String(p.text)
      const onProgress = onProgressChannel
        ? (percent) => event.sender.send(onProgressChannel, percent)
        : undefined
      return await multipartUpload(API_ENDPOINTS.tts.voicesSamples, fields, onProgress)
    } catch (err) { return isExpectedOfflineError(err) ? null : { error: err.message } }
  })

  // 将 base64 音频数据写入本地文件（TTS 响应 audio_base64 → 本地落盘）
  ipcMain.handle('tts:saveAudio', async (_e, { base64, savePath }) => {
    try {
      if (!base64 || !savePath) throw new Error('tts:saveAudio requires `base64` and `savePath`')
      const dir = path.dirname(savePath)
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      const buf = Buffer.from(base64, 'base64')
      fs.writeFileSync(savePath, buf)
      return savePath
    } catch (err) { return { error: err.message } }
  })

  // ── Step3 口播配音专用 IPC ────────────────────────────────────────

  // 扫描目录中的视频文件（递归，上限 500 个）
  ipcMain.handle('voice:scanDir', async (_e, { dir, maxCount = 500 }) => {
    try {
      if (!dir || !fs.existsSync(dir)) throw new Error('目录不存在')
      const VIDEO_EXTS = new Set(['.mp4', '.mov', '.avi', '.mkv', '.flv', '.webm', '.m4v'])
      const SKIP_DIRS = new Set(['splits', 'outputs', 'temp', 'cache', 'node_modules'])
      const results = []
      
      function scanDir(currentDir, depth = 0) {
        if (results.length >= maxCount || depth > 5) return
        const entries = fs.readdirSync(currentDir, { withFileTypes: true })
        for (const entry of entries) {
          if (results.length >= maxCount) break
          const fullPath = path.join(currentDir, entry.name)
          if (entry.isDirectory()) {
            if (!SKIP_DIRS.has(entry.name.toLowerCase())) {
              scanDir(fullPath, depth + 1)
            }
          } else if (entry.isFile()) {
            const ext = path.extname(entry.name).toLowerCase()
            if (VIDEO_EXTS.has(ext)) {
              results.push(fullPath)
            }
          }
        }
      }
      
      scanDir(dir)
      return { files: results.slice(0, maxCount), total: results.length }
    } catch (err) { return { error: err.message } }
  })

  // 合并视频+音频（ffmpeg -i video -i audio -c:v copy -c:a aac -shortest out）
  ipcMain.handle('voice:mergeVideoAudio', async (_e, { videoPath, audioPath, outPath }) => {
    try {
      if (!videoPath || !audioPath || !outPath) throw new Error('缺少必要参数')
      if (!fs.existsSync(videoPath)) throw new Error('视频文件不存在')
      if (!fs.existsSync(audioPath)) throw new Error('音频文件不存在')
      
      const dir = path.dirname(outPath)
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      
      const { spawn } = require('node:child_process')
      const args = [
        '-y',
        '-i', videoPath,
        '-i', audioPath,
        '-c:v', 'copy',
        '-c:a', 'aac',
        '-shortest',
        outPath
      ]
      
      // 使用系统 ffmpeg（或打包后的 ffmpeg）
      const ffmpegPath = process.resourcesPath 
        ? path.join(process.resourcesPath, 'bin', 'ffmpeg.exe')
        : 'ffmpeg'
      
      const proc = spawn(ffmpegPath, args, { windowsHide: true })
      let stderr = ''
      proc.stderr.on('data', (d) => stderr += d)
      
      return await new Promise((resolve) => {
        proc.on('close', (code) => {
          if (code !== 0) {
            resolve({ error: `ffmpeg 合并失败: ${stderr}` })
          } else {
            resolve({ path: outPath })
          }
        })
        proc.on('error', (err) => {
          resolve({ error: `ffmpeg 启动失败: ${err.message}` })
        })
      })
    } catch (err) { return { error: err.message } }
  })
}

module.exports = { createMediaProxyIpc }
