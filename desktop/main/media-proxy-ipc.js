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
const { app } = require('electron')

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
      // 2026-09-05 用户裁决：声音克隆固定使用 IndexTTS，不再使用 voxcpm（voxcpm 分支已删除；
      // 智能混剪口播配音的 /voxcpm/tts 走 montage-voice-ipc.js 独立通道，与本 handler 无关）。
      // 契约（服务端 openapi.json 实测）：POST /indextts/tts IndexTTSRequest =
      //   text + sample_id/prompt_audio/lang/duration_factor/emo_text/emo_alpha/resp
      //   （契约无 engine 字段，不发）；内部任务队列 enqueue("indextts_tts")，HTTP 语义不变：
      //   等完成后返回 WAV 二进制（+X-Audio-Url 头）；resp=json 返 {audio_url, task_id, ...}
      const body = {
        text: p.text,
        ...(p.sample_id ? { sample_id: p.sample_id } : {}),
        ...(p.prompt_audio ? { prompt_audio: p.prompt_audio } : {}),
        ...(p.lang ? { lang: p.lang } : {}),
        ...(p.duration_factor !== undefined ? { duration_factor: p.duration_factor } : {}),
        ...(p.emo_text ? { emo_text: p.emo_text } : {}),
        ...(p.emo_alpha !== undefined ? { emo_alpha: p.emo_alpha } : {}),
        ...(p.resp ? { resp: p.resp } : {}),
      }
      // 异步任务队列排队 + 推理耗时不可控（同步等完成后响应），超时放宽到 300s
      const res = await httpRequest('POST', API_ENDPOINTS.tts.indextts, { body, timeout: 300000 })
      // 服务端返回 WAV 二进制 → 转 base64 经 IPC 传渲染层
      if (Buffer.isBuffer(res.data)) {
        return { audio_base64: res.data.toString('base64'), content_type: res.headers?.['content-type'] || 'audio/wav' }
      }
      // JSON 响应：实测（2026-09-05）audio_url 是相对路径（如 /output/tts/tts_xxx.wav），
      // 渲染层无法直接加载/下载 → 主进程主动取回音频二进制转 base64 一并返回，
      // 渲染层既有 audio_base64 链路（blob 播放/落盘/另存为）无需感知相对路径
      const d = res.data
      if (d && typeof d === 'object' && d.audio_url && !/^https?:/i.test(d.audio_url)) {
        try {
          const audioRes = await httpRequest('GET', d.audio_url, { timeout: 120000 })
          if (Buffer.isBuffer(audioRes.data)) {
            return { ...d, audio_base64: audioRes.data.toString('base64'), content_type: audioRes.headers?.['content-type'] || 'audio/wav' }
          }
        } catch (_) { /* 取回失败则透传原 JSON，由渲染层按 audio_url 兼容处理 */ }
      }
      return d
    } catch (err) { return isExpectedOfflineError(err) ? null : { error: err.message } }
  })

  ipcMain.handle('tts:voicesSamples', async (_e, params) => {
    try {
      const path = resolveEndpoint(API_ENDPOINTS.tts.voicesSamples, params || {})
      const res = await httpRequest('GET', path)
      return res.data || []
    } catch (err) { return isExpectedOfflineError(err) ? null : { error: err.message } }
  })

  // 样本试听：GET 样本音频（audio_url 为相对路径，httpRequest 自动拼 baseUrl），转 base64 返回
  ipcMain.handle('tts:fetchSampleAudio', async (_e, payload) => {
    try {
      const url = String((payload || {}).url || '').trim()
      if (!url) throw new Error('tts:fetchSampleAudio missing `url`')
      const res = await httpRequest('GET', url, { timeout: 60000 })
      if (!Buffer.isBuffer(res.data)) return { error: '非音频响应' }
      return { audio_base64: res.data.toString('base64'), content_type: res.headers?.['content-type'] || 'audio/wav' }
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
  ipcMain.handle('tts:saveAudio', async (_e, { base64, savePath, fromPath }) => {
    try {
      if (!savePath || (!base64 && !fromPath)) throw new Error('tts:saveAudio requires `savePath` and `base64`/`fromPath`')
      // 2026-09-05 修复：配置 cacheDir 可能是相对路径（如“资产输出”），此前 writeFileSync
      // 直接落到主进程工作目录（打包后不可预期且不可写）——统一解析到 userData 下，
      // 并返回绝对路径供渲染层播放/打开目录/file:// 直用
      const resolveRooted = (p) => {
        const s = String(p || '')
        return path.isAbsolute(s) ? s : path.join(app.getPath('userData'), s)
      }
      const target = resolveRooted(savePath)
      const dir = path.dirname(target)
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      if (fromPath) {
        // 复制模式（另存为：从已落盘文件复制，最可靠，不经 base64 往返）
        fs.copyFileSync(resolveRooted(fromPath), target)
      } else {
        fs.writeFileSync(target, Buffer.from(base64, 'base64'))
      }
      return target
    } catch (err) { return { error: err.message } }
  })

  // ── Step3 口播配音专用 IPC 已迁至 montage-voice-ipc.js（一比一重写版；
  //    旧 voice:scanDir/voice:mergeVideoAudio 已删除，避免 ipcMain.handle 重复注册崩溃）──
}

module.exports = { createMediaProxyIpc }
