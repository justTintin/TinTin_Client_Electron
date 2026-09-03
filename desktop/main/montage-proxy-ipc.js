// ═══════════════════════════════════════════════════════════════
// montage-proxy-ipc.js — 服务端代理·智能混剪/提示词反推域 IPC（M6/M8 条目⑥⑦）
// 按原客户端口径恢复服务端链路（utils/montage_client.py split/concat）
// 与 /prompt/video（prompt_reverse_page L461-502）：
//   · montage:concat  POST /montage/concat  multipart（files[] + clip_urls JSON 串）
//     对照 gui/montage/workers/montage_concat_server_worker.py L57-128
//   · montage:bgm     POST /montage/bgm     multipart（file + bgm + 音量）
//   · prompt:video    POST /prompt/video    multipart（file + start_sec/end_sec）
//     对照 gui/prompt_reverse_page.py _VideoPromptWorker L461-502
// 契约（API-GUIDE，禁止臆造）：
//   Body_montage_concat_montage_concat_post /
//   Body_montage_add_bgm_montage_bgm_post /
//   Body_video_prompt_prompt_video_post
// 依赖（multipartUpload/API_ENDPOINTS/isExpectedOfflineError）由 server-proxy.js
// 注入，不重复实现（同 media-proxy-ipc.js 模式）。
// ═══════════════════════════════════════════════════════════════

function createMontageProxyIpc(ipcMain, { multipartUpload, API_ENDPOINTS, isExpectedOfflineError }) {
  /** {path} 包装：multipartUpload 按本地路径读取文件内容上传（渲染层只传路径字符串） */
  const filePathField = (p) => (typeof p === 'string' ? { path: p } : p)

  /** 可选字段：非空才收进 multipart 表单（对象值 JSON 字符串化，服务端从表单读取） */
  function putField(fields, key, value) {
    if (value === undefined || value === null || value === '') return
    if (value && typeof value === 'object' && !value.path) {
      fields[key] = JSON.stringify(value)
      return
    }
    fields[key] = value
  }

  /** multipart 提交 handler 通用壳：参数校验 → 字段收集 → 上传；错误统一 {error} */
  function uploadHandler(endpoint, validate, collect) {
    return async (event, payload, onProgressChannel) => {
      try {
        const p = payload || {}
        const preErr = validate(p)
        if (preErr) throw new Error(preErr)
        const fields = {}
        collect(fields, p)
        const onProgress = onProgressChannel
          ? (percent) => event.sender.send(onProgressChannel, percent)
          : undefined
        return await multipartUpload(endpoint, fields, onProgress)
      } catch (err) {
        if (isExpectedOfflineError(err)) return null
        return { error: err.message }
      }
    }
  }

  // POST /montage/concat — 镜头重组（对照 montage_concat_server_worker L57-103：
  // files / clip_urls 至少一项；clip_urls 为 JSON 字符串；options 白名单字段字符串化）
  ipcMain.handle('montage:concat', uploadHandler(
    API_ENDPOINTS.montage.concat,
    (p) => {
      const hasFiles = Array.isArray(p.files) && p.files.length > 0
      const hasClipUrls = typeof p.clip_urls === 'string' && p.clip_urls.length > 2
      if (!hasFiles && !hasClipUrls) return '没有可合成的镜头（本地 files 或 clip_urls 至少一项）'
      return ''
    },
    (fields, p) => {
      if (Array.isArray(p.files) && p.files.length) {
        // 同名多文件：fields 值为数组 → multipartUpload 逐个展开（服务端 List[UploadFile]）
        fields.files = p.files.map(filePathField)
      }
      putField(fields, 'clip_urls', p.clip_urls)
      putField(fields, 'transition', p.transition)
      putField(fields, 'transition_duration', p.transition_duration)
      putField(fields, 'width', p.width)
      putField(fields, 'height', p.height)
      putField(fields, 'fps', p.fps)
      putField(fields, 'crf', p.crf)
      putField(fields, 'preset', p.preset)
      putField(fields, 'image_duration', p.image_duration)
      // PR#3 出入场镜头加速倍率（对齐 step2_concat_view edge_speedup_combo）
      putField(fields, 'edge_speedup', p.edge_speedup)
      if (p.lut) fields.lut = filePathField(p.lut)
    },
  ))

  // POST /montage/bgm — 成片混音（Body_montage_add_bgm_montage_bgm_post：
  // file+bgm 必填（或 video_url/bgm_url/audio_id 三选一），bgm_volume/source_volume 可选）
  ipcMain.handle('montage:bgm', uploadHandler(
    API_ENDPOINTS.montage.bgm,
    (p) => {
      if (!p.file && !p.video_url) return '缺少视频文件'
      if (!p.bgm && !p.bgm_url && !p.audio_id) return '缺少背景音乐'
      return ''
    },
    (fields, p) => {
      if (p.file) fields.file = filePathField(p.file)
      putField(fields, 'video_url', p.video_url)
      if (p.bgm) fields.bgm = filePathField(p.bgm)
      putField(fields, 'bgm_url', p.bgm_url)
      putField(fields, 'audio_id', p.audio_id)
      putField(fields, 'bgm_volume', p.bgm_volume)
      putField(fields, 'source_volume', p.source_volume)
    },
  ))

  // POST /prompt/video — 视频反推提示词（对照 _VideoPromptWorker L482-488：
  // 时间窗 start_sec/end_sec 随提交，不做本地裁切；契约另备 material_id/local_path/file_ref）
  ipcMain.handle('prompt:video', uploadHandler(
    API_ENDPOINTS.prompt.video,
    (p) => {
      const hasSource = p.file || p.material_id !== undefined || p.local_path || p.file_ref
      return hasSource ? '' : '缺少视频来源（file / material_id / local_path / file_ref）'
    },
    (fields, p) => {
      if (p.file) fields.file = filePathField(p.file)
      putField(fields, 'material_id', p.material_id)
      putField(fields, 'local_path', p.local_path)
      putField(fields, 'file_ref', p.file_ref)
      putField(fields, 'start_sec', p.start_sec)
      putField(fields, 'end_sec', p.end_sec)
    },
  ))

  // 清空混剪任务缓存（对照原版 _clear_montage_cache → utils/montage_cache.py
  // clear_montage_cache：删除 montage_cache 下全部任务目录，不触碰原始素材）。
  // 防误删：目标路径必须包含 montage_cache 段才允许递归删除。
  ipcMain.handle('montage:clearCache', async (_e, payload) => {
    try {
      const fs = require('fs')
      const dir = String((payload || {}).dir || '')
      if (!dir || !dir.includes('montage_cache')) {
        return { error: '拒绝清理：目标目录不是混剪缓存目录（montage_cache）' }
      }
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true })
      return { ok: true }
    } catch (err) {
      return { error: err.message }
    }
  })
}

module.exports = { createMontageProxyIpc }
