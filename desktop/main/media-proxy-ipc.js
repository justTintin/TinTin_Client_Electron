// ═══════════════════════════════════════════════════════════════
// media-proxy-ipc.js — 服务端代理·媒体域 IPC（server-proxy.js 拆分）
// 自 server-proxy.js L597-757 原样迁出（IRON-02 行数守恒，行为不变）：
//   · rembg / vsr / vision（V3 新接口 S1~S3，multipart 上传）
//   · asr（whisper 转写，契约 multipart：本地文件直传 / 服务端样本先 GET 取回再上传）
//   · tts（voxcpm 合成 / 克隆 / 音色列表 / 示例）
// 依赖（httpRequest/multipartUpload/API_ENDPOINTS/resolveEndpoint/
// isExpectedOfflineError）由 server-proxy.js 注入，不重复实现。
// ═══════════════════════════════════════════════════════════════

const fs = require('node:fs')
const path = require('node:path')
const { app } = require('electron')
const logger = require('./logger')

function createMediaProxyIpc(ipcMain, { httpRequest, multipartUpload, API_ENDPOINTS, resolveEndpoint, isExpectedOfflineError }) {
  // --- V3 新接口 S1~S3（rembg / vsr / reverse-prompt）————————————————
  // 2026-09-07 契约对齐：服务端实装 POST /matting（multipart：file+model，同步回 PNG 二进制），
  // 旧 /rembg/matting 异步任务模式从未实装；旧实现把 image 裸字符串路径当文本字段发，
  // 服务端根本收不到图片（buildMultipartBody 的文本分支），一并修正为 { path } 包装。
  // 返回：PNG 落盘到原图同目录 `{原名}_matting.png`（对齐 vsr 自动保存口径），返 { path, bytes }
  ipcMain.handle('rembg:submit', async (event, payload, onProgressChannel) => {
    try {
      const p = payload || {}
      if (!p.image || typeof p.image !== 'string') throw new Error('rembg:submit missing `image` 本地路径')
      const fields = {}
      fields.file = { path: p.image }
      if (p.model) fields.model = p.model
      const onProgress = onProgressChannel
        ? (percent) => event.sender.send(onProgressChannel, percent)
        : undefined
      const buf = await multipartUpload(API_ENDPOINTS.rembg.matting, fields, onProgress)
      if (!Buffer.isBuffer(buf)) {
        // 服务端错误响应（JSON）会被 multipartUpload 解析后原样返回
        const detail = buf && typeof buf === 'object' ? JSON.stringify(buf).slice(0, 200) : String(buf).slice(0, 200)
        throw new Error(detail || '服务端未返回图片数据')
      }
      const outPath = p.image.replace(/\.[^.\\/]+$/, '') + '_matting.png'
      fs.writeFileSync(outPath, buf)
      // logger.js 是 electron-log 5.x 兼容层：导出 logInfo/logWarn/logError 函数集，无 .info 方法
      logger.logInfo('rembg', `matting saved: ${outPath} (${buf.length}B)`)
      return { path: outPath, bytes: buf.length }
    } catch (err) { return isExpectedOfflineError(err) ? null : { error: err.message } }
  })

  // GET /matting/models — 服务端可用抠图模型清单
  ipcMain.handle('rembg:models', async () => {
    try {
      const res = await httpRequest('GET', API_ENDPOINTS.rembg.models)
      const list = Array.isArray(res) ? res : (res && Array.isArray(res.models) ? res.models : [])
      return { models: list }
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
  // asr:transcribe ← POST /whisper/transcribe（契约 Body_transcribe_whisper_transcribe_post：
  //   multipart/form-data，字段 file(必填) + language/fmt/task_id，**无 JSON {url} 分支**）。
  // 2026-09-06 修复 422：① multipart 文件字段名 audio → file（契约字段名）；② url 分支原为
  //   JSON POST {url}，服务端根本不接受 → 422；改为先 GET 取回样本音频字节再 multipart 上传。
  //   p.format 兼容映射到契约字段 fmt（VoiceClone 上传样本识别传 format:'txt'）。
  ipcMain.handle('asr:transcribe', async (event, payload, onProgressChannel) => {
    try {
      const p = payload || {}
      const hasAudio = !!p.audio
      const hasUrl = !!p.url
      if (!hasAudio && !hasUrl) throw new Error('asr:transcribe missing `audio` Blob 或 `url` 字段（二选一）')

      // 公共表单字段（契约：language/fmt；word_timestamps 非契约字段，服务端忽略，保留透传不动行为）
      const fields = {}
      if (p.language) fields.language = String(p.language)
      const fmt = p.fmt || p.format
      if (fmt) fields.fmt = String(fmt)
      if (p.word_timestamps !== undefined) fields.word_timestamps = String(!!p.word_timestamps)

      if (hasAudio) {
        // 本地文件 → multipart file（{path} 包装，buildMultipartBody 按路径读文件）
        fields.file = p.audio
        try { logger.logInfo('voice-clone', `asr:transcribe 来源=本地文件 ${path.basename(String((p.audio && p.audio.path) || ''))}`) } catch (_) {}
      } else {
        // 服务端样本（/voice/samples audio_url 相对路径，httpRequest 自动拼 baseUrl）：
        // GET 取回音频字节 → multipart file 上传（内存直传不落盘，契约无 url 参数）
        const res = await httpRequest('GET', String(p.url), { timeout: 60000 })
        const buf = res.raw || (Buffer.isBuffer(res.data) ? res.data : null)
        if (!buf || !buf.length) throw new Error('样本音频下载失败：响应非音频数据')
        const ct = String(res.headers?.['content-type'] || '').split(';')[0].trim()
        const urlPath = String(p.url).split('?')[0]
        const ext = path.extname(urlPath) || (ct.includes('mpeg') ? '.mp3' : '.wav')
        fields.file = { buffer: buf, filename: `sample${ext.toLowerCase()}`, contentType: ct || undefined }
        // 全程留痕：明确展示"样本音频是从服务端 URL 取回的字节，无本地文件"（2026-09-06）
        try { logger.logInfo('voice-clone', `asr:transcribe 来源=服务端样本 GET ${p.url} → ${buf.length}B (${ct})，以内存字节 multipart 上传（无本地路径）`) } catch (_) {}
      }

      const onProgress = onProgressChannel
        ? (percent) => event.sender.send(onProgressChannel, percent)
        : undefined
      return await multipartUpload(API_ENDPOINTS.asr.transcribe, fields, onProgress)
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
        // 2026-09-20（服务端 TTS 统一入口）：engine=qwen3 → Qwen3-TTS；ref_text=克隆参考文稿
        ...(p.engine ? { engine: String(p.engine) } : {}),
        ...(p.ref_text ? { ref_text: String(p.ref_text) } : {}),
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

  // （样本试听 tts:fetchSampleAudio 已废弃删除：样本试听改渲染层直连服务端音频 URL，
  //   主进程取回+base64+blob 的中间链路整体下线，2026-09-07）

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
