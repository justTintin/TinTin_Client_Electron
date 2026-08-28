// ═══════════════════════════════════════════════════════════════
// media-proxy-ipc.js — 服务端代理·媒体域 IPC（server-proxy.js 拆分）
// 自 server-proxy.js L597-757 原样迁出（IRON-02 行数守恒，行为不变）：
//   · rembg / vsr / vision（V3 新接口 S1~S3，multipart 上传）
//   · asr（whisper 转写，multipart 或 URL JSON 双路径）
//   · tts（voxcpm 合成 / 克隆 / 音色列表 / 示例）
// 依赖（httpRequest/multipartUpload/API_ENDPOINTS/resolveEndpoint/
// isExpectedOfflineError）由 server-proxy.js 注入，不重复实现。
// ═══════════════════════════════════════════════════════════════

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
}

module.exports = { createMediaProxyIpc }
