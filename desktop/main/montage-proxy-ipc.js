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

const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
// 成片完整性校验复用 ffprobe 助手（montage-voice-ipc 导出，同 getBinDir 口径）
const { getFfprobePath, getMediaDuration } = require('./montage-voice-ipc')

/** ffmpeg 可执行文件路径（dev resources/bin/win，打包 process.resourcesPath/bin；同 montage-voice-ipc 口径） */
function getBinDir() {
  if (process.resourcesPath) {
    const pkgBin = path.join(process.resourcesPath, 'bin')
    if (fs.existsSync(pkgBin)) return pkgBin
  }
  const devBin = path.resolve(__dirname, '..', 'resources', 'bin', 'win')
  if (fs.existsSync(devBin)) return devBin
  return ''
}

function getFfmpegPath() {
  const binDir = getBinDir()
  if (binDir) {
    const exe = path.join(binDir, 'ffmpeg.exe')
    if (fs.existsSync(exe)) return exe
  }
  return 'ffmpeg'
}

/** ffmpeg 运行（同 montage-voice-ipc.runFfmpeg 口径，含 180s 超时对照原版 run(timeout=180)） */
function runFfmpeg(args) {
  return new Promise((resolve) => {
    const proc = spawn(getFfmpegPath(), args, { windowsHide: true })
    let stderr = ''
    proc.stderr.on('data', (c) => { stderr += c })
    const timer = setTimeout(() => { try { proc.kill() } catch (_) {} }, 180 * 1000)
    proc.on('close', (code) => { clearTimeout(timer); resolve({ code, stderr }) })
    proc.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, stderr: String(e) }) })
  })
}

// ── 出入场超长片段裁剪（PR#4 条目10，对照 EdgeClipTrimWorker split_workers.py L822-900）──

/** 秒 → SRT 时间戳 HH:MM:SS,mmm（逐行对照 utils_media.py format_seconds_to_srt_timestamp L343-357） */
function formatSrtTimestamp(seconds) {
  let hours = Math.floor(seconds / 3600)
  let minutes = Math.floor((seconds % 3600) / 60)
  let secs = Math.floor(seconds % 60)
  let ms = Math.round((seconds - Math.floor(seconds)) * 1000)
  if (ms >= 1000) {
    ms -= 1000
    secs += 1
    if (secs >= 60) {
      secs -= 60
      minutes += 1
      if (minutes >= 60) {
        minutes -= 60
        hours += 1
      }
    }
  }
  const p2 = (n) => String(n).padStart(2, '0')
  return `${p2(hours)}:${p2(minutes)}:${p2(secs)},${String(ms).padStart(3, '0')}`
}

/** 裁剪后新文件名（对照 EdgeClipTrimWorker._build_path L837-853：_shot_%03d 段替换时间戳，描述段保留） */
function buildTrimmedPath(oldPath, idx, startSec, endSec, desc) {
  const dirName = path.dirname(oldPath)
  const baseName = path.basename(oldPath)
  const idxStr = `_shot_${String(idx).padStart(3, '0')}`
  let prefix
  if (baseName.includes(idxStr)) {
    prefix = baseName.split(idxStr)[0]
  } else {
    prefix = baseName.replace(/\.[^.]+$/, '')
    if (prefix.includes('_shot_')) prefix = prefix.split('_shot_')[0]
  }
  const startStr = formatSrtTimestamp(startSec).replace(/:/g, '-')
  const endStr = formatSrtTimestamp(endSec).replace(/:/g, '-')
  return desc
    ? path.join(dirName, `${prefix}${idxStr}_${startStr}_${endStr}_${desc}.mp4`)
    : path.join(dirName, `${prefix}${idxStr}_${startStr}_${endStr}.mp4`)
}

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
      putField(fields, 'clip_shot_types', p.clip_shot_types)
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

  // ── 出入场超长片段裁剪（PR#4 条目10，对照 _maybe_trim_edge_clips 调用的 EdgeClipTrimWorker：
  //  取中间时间段（产品通常在镜头中间段）重编码替换原文件并同步改写文件名时间戳；
  //  幂等由渲染层保证（已裁 ≤ 阈值不再发任务）。返回 renamed: [old, new, keepSec] 供行回写）──
  ipcMain.handle('montage:trimEdgeClips', async (_e, payload) => {
    const p = payload || {}
    const maxSec = Number(p.maxSec) > 0 ? Number(p.maxSec) : 4.0
    const jobs = Array.isArray(p.jobs) ? p.jobs : []
    const renamed = []
    let skipped = 0
    for (const job of jobs) {
      let tmp = ''
      try {
        const src = String((job || {}).path || '')
        if (!src || !fs.existsSync(src)) { skipped++; continue }
        const startSec = Number(job.startSec)
        const endSec = Number(job.endSec)
        const dur = endSec - startSec
        if (!(dur > 0) || dur <= maxSec + 0.01) { skipped++; continue }
        // 取中间时间段：产品通常在镜头中间段（头部是环境铺垫、尾部是收尾）（L866-871）
        const pad = (dur - maxSec) / 2.0
        const kStart = startSec + pad
        const kEnd = endSec - pad
        const keep = kEnd - kStart
        if (keep <= 0.2) { skipped++; continue }
        tmp = src + '.trim_tmp.mp4'
        const r = await runFfmpeg([
          '-y', '-ss', kStart.toFixed(3), '-i', src,
          '-t', keep.toFixed(3),
          '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
          '-c:a', 'aac', '-avoid_negative_ts', 'make_zero', tmp,
        ])
        if (r.code !== 0 || !fs.existsSync(tmp) || fs.statSync(tmp).size < 1024) {
          console.warn(`[出入场裁剪] ffmpeg 失败跳过: ${path.basename(src)}`)
          try { fs.unlinkSync(tmp) } catch (_) {}
          skipped++
          continue
        }
        const newPath = buildTrimmedPath(src, Number(job.idx) || 0, kStart, kEnd, String(job.desc || ''))
        if (path.resolve(newPath) !== path.resolve(src)) {
          fs.renameSync(tmp, newPath)
          try { fs.unlinkSync(src) } catch (_) {}
        } else {
          fs.renameSync(tmp, src)
        }
        renamed.push([src, newPath, Number(keep.toFixed(3))])
        console.log(`[出入场裁剪] ${String(job.position || '')} ${path.basename(src)} ${dur.toFixed(1)}s → ${keep.toFixed(1)}s`)
      } catch (e) {
        console.warn(`[出入场裁剪] 失败跳过: ${e && e.message}`)
        if (tmp) { try { fs.unlinkSync(tmp) } catch (_) {} }
        skipped++
      }
    }
    return { renamed, skipped }
  })

  // ── 成片完整性校验（PR#4 条目12，对照 _probe_video_ok/_validate_downloaded_file L263-304：
  //  >1KB 且 ffprobe 能读出时长>0 视为完整（moov 缺失/截断文件会失败）；
  //  无 ffprobe 时退化为只做大小校验不阻塞流程。hasFile 供渲染层区分
  //  「从未取到文件」与「取到但损坏」两种报错文案）──
  ipcMain.handle('montage:validateFinal', (_e, payload) => {
    const p = String((payload || {}).path || '')
    try {
      const hasFile = !!p && fs.existsSync(p) && fs.statSync(p).size >= 1024
      if (!hasFile) return { ok: false, hasFile: false }
      if (getFfprobePath() === 'ffprobe') return { ok: true, hasFile: true }
      return { ok: getMediaDuration(p) > 0, hasFile: true }
    } catch (err) {
      return { ok: false, hasFile: fs.existsSync(p), error: err && err.message }
    }
  })

  // 删除下载校验未通过的坏成片（2026-09-10 实测：服务端 result 端点会返回未写完的
  //  截断 mp4（moov 缺失）甚至 200 空体，坏片残留 outputs 会被 Step3 扫描带入配音/合成链，
  //  问题延迟到第四步统一合成才暴露——渲染层校验未通过即调此通道清除）。
  //  防误删：与 clearCache 同款策略，目标路径必须包含 montage_cache 段。
  ipcMain.handle('montage:deleteBadFinal', (_e, payload) => {
    const p = String((payload || {}).path || '')
    if (!p || !p.includes('montage_cache')) {
      return { error: '拒绝删除：目标不在混剪缓存目录（montage_cache）内' }
    }
    try {
      if (fs.existsSync(p)) fs.unlinkSync(p)
      return { ok: true }
    } catch (err) {
      return { error: err && err.message }
    }
  })

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
