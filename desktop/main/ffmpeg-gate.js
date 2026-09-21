const { ipcMain } = require('electron')
const { spawn } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')
const logger = require('./logger')

// ffmpeg/ffprobe 可执行文件路径
function getBinDir(studioRoot) {
  // 打包后：resources/bin/
  if (process.resourcesPath) {
    const pkgBin = path.join(process.resourcesPath, 'bin')
    if (fs.existsSync(pkgBin)) return pkgBin
  }
  // 开发模式：studio/bin/win/
  const devBin = path.join(studioRoot, 'bin', 'win')
  if (fs.existsSync(devBin)) return devBin
  // 回退：系统 PATH
  return ''
}

function getFfmpegPath(studioRoot) {
  const binDir = getBinDir(studioRoot)
  if (binDir) {
    const exe = path.join(binDir, 'ffmpeg.exe')
    if (fs.existsSync(exe)) return exe
  }
  return 'ffmpeg'
}

function getFfprobePath(studioRoot) {
  const binDir = getBinDir(studioRoot)
  if (binDir) {
    const exe = path.join(binDir, 'ffprobe.exe')
    if (fs.existsSync(exe)) return exe
  }
  return 'ffprobe'
}

/**
 * 从 ffprobe 视频流提取显示旋转角度（度，0/90/180/270）。
 * side_data_list(displaymatrix) 为现代容器格式（如 -90）；tags.rotate 为旧格式（如 "90"）。
 */
function getStreamRotationDeg(videoStream) {
  const side = (videoStream?.side_data_list || []).find((d) => d && typeof d.rotation === 'number')
  if (side) return Math.abs(Math.round(side.rotation)) % 360
  const tag = parseInt(String(videoStream?.tags?.rotate ?? videoStream?.tags?.ROTATE ?? ''), 10)
  if (Number.isFinite(tag)) return Math.abs(tag) % 360
  return 0
}

/**
 * 旋转元数据处理（对照原客户端 BUGFIX #010：镜头重组「与原片一致」画幅不正确）。
 * ffprobe width/height 是编码尺寸；±90/270 显示时宽高需互换（手机竖拍横存视频等）。
 */
function applyRotationSize(width, height, rotationDeg) {
  return (Math.abs(Math.round(rotationDeg || 0)) % 180 === 90)
    ? { width: height, height: width }
    : { width, height }
}

/**
 * ffmpeg -i stderr 解析时长（无 ffprobe 时的回退；仅依赖 ffmpeg.exe）。
 * Duration: 00:00:03.50 → 秒；无法解析返回 0。
 */
function probeDurationViaFfmpeg(ffmpegPath, file) {
  return new Promise((resolve) => {
    if (!file || !fs.existsSync(file)) return resolve(0)
    const proc = spawn(ffmpegPath, ['-hide_banner', '-i', file], { windowsHide: true })
    let stderr = ''
    proc.stderr.on('data', (d) => { stderr += d })
    proc.on('error', () => resolve(0))
    proc.on('close', () => {
      const m = /Duration:\s*(\d+):(\d{2}):(\d{2})\.(\d+)/.exec(stderr)
      resolve(m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number('0.' + m[4]) : 0)
    })
  })
}

/**
 * ffmpeg -i stderr 解析视频基础信息（打包环境无 ffprobe.exe 的兜底探测，纯函数可单测）。
 * 实测本仓库 resources/bin/ffmpeg.exe 输出（2026-09-11）：
 *   Duration: 00:00:01.00, start: 0.000000, bitrate: 104 kb/s
 *   Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(progressive),
 *     480x854 [SAR 1:1 DAR 240:427], 12 kb/s, 29.97 fps, 29.97 tbr, 11988 tbn (default)
 *   Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz, mono, fltp
 * 已知局限（同一实测）：该版本 ffmpeg 不在 -i 输出里打印 rotate/display matrix，
 * 故兜底路径拿不到旋转 → 宽高为编码尺寸（不做 ±90/270 互换，ffprobe 路径才做）。
 * 手机竖拍横存素材在打包环境可能给出反向画幅，属已知降级（有 ffprobe 即准确）。
 */
function parseFfmpegInfo(stderr) {
  const out = { duration: 0, width: 0, height: 0, fps: 0, video: '', audio: '' }
  const s = String(stderr || '')
  const d = /Duration:\s*(\d+):(\d{2}):(\d{2})\.(\d+)/.exec(s)
  if (d) out.duration = Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) + Number('0.' + d[4])
  for (const line of s.split(/\r?\n/)) {
    let m = /Stream #\d+:\d+.*?:\s*Video:\s*([A-Za-z0-9_]+)/.exec(line)
    if (m) {
      out.video = m[1].toLowerCase()
      // 宽高：\b 界定避免命中 fourcc 里的 "0x31637661"（x 前仅 1 位数字，不足 2 位）
      const sz = /\b(\d{2,5})x(\d{2,5})\b/.exec(line)
      if (sz && !out.width) { out.width = Number(sz[1]); out.height = Number(sz[2]) }
      // "29.97 fps, 29.97 tbr"：取 fps 字段（首个 "数字 fps"），不取 tbr
      const f = /([\d.]+)\s+fps/.exec(line)
      if (f && !out.fps) out.fps = Number(f[1])
      continue
    }
    m = /Stream #\d+:\d+.*?:\s*Audio:\s*([A-Za-z0-9_]+)/.exec(line)
    if (m && !out.audio) out.audio = m[1].toLowerCase()
  }
  return out
}

/** ffmpeg 兜底探测（永不 reject）：解析不到视频流尺寸返回 null。 */
function probeViaFfmpeg(ffmpegPath, file) {
  return new Promise((resolve) => {
    if (!file || !fs.existsSync(file)) return resolve(null)
    const proc = spawn(ffmpegPath, ['-hide_banner', '-i', file], { windowsHide: true })
    let stderr = ''
    proc.stderr.on('data', (d) => { stderr += d })
    proc.on('error', () => resolve(null))
    proc.on('close', () => {
      const info = parseFfmpegInfo(stderr)
      resolve(info.width > 0 ? info : null)
    })
  })
}

/**
 * 执行 ffprobe，返回结构化视频信息
 */
function probe(ffprobePath, file) {
  return new Promise((resolve, reject) => {
    const args = [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_format', '-show_streams',
      file
    ]
    const proc = spawn(ffprobePath, args, { windowsHide: true })
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (d) => stdout += d)
    proc.stderr.on('data', (d) => stderr += d)
        proc.on('error', (err) => reject(new Error(`ffprobe spawn failed: ${err.message}`)))
proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`ffprobe failed: ${stderr}`))
        return
      }
      try {
        const info = JSON.parse(stdout)
        const videoStream = (info.streams || []).find(s => s.codec_type === 'video')
        const audioStream = (info.streams || []).find(s => s.codec_type === 'audio')
        // 旋转元数据处理：width/height 归一为显示尺寸（BUGFIX #010）
        const dims = applyRotationSize(
          parseInt(videoStream?.width || 0, 10),
          parseInt(videoStream?.height || 0, 10),
          getStreamRotationDeg(videoStream)
        )
        resolve({
          duration: parseFloat(info.format?.duration || 0),
          width: dims.width,
          height: dims.height,
          fps: parseFps(videoStream?.r_frame_rate || '0/1'),
          codec: videoStream?.codec_name || '',
          audio_bitrate: parseInt(audioStream?.bit_rate || 0, 10)
        })
      } catch (e) {
        reject(new Error(`ffprobe parse error: ${e.message}`))
      }
    })
  })
}

function parseFps(rateStr) {
  const [num, den] = rateStr.split('/').map(Number)
  if (!den || den === 0) return 0
  return Math.round((num / den) * 100) / 100
}

/**
 * 批量抽取关键帧并读回 base64（视觉模型研判类工具共用）。
 *
 * 对照原客户端：
 *   · studio/gui/hook_score_page.py   HookScoreWorker.do_work 抽帧段
 *   · studio/gui/marketing_detect_page.py MarketingDetectWorker.do_work 抽帧段
 * 两处口径一致：frames_dir 先清空重建 → 逐帧 extract_frame(video, t, out,
 * scale="512:-2", quality=4) → 存在则收集 → 读文件 base64 拼 image_url。
 * 抽帧时间点由渲染层纯函数计算（sampleTimes / marketingSampleTimes），
 * 主进程只负责 I/O，不做策略决策（IRON-06/07 分层）。
 *
 * @param {string} ffmpegPath
 * @param {string} video    视频绝对路径
 * @param {number[]} times  抽帧时间点（秒）
 * @param {string} tag      输出目录标识（评价预测/营销检测各自独立目录）
 * @param {number} width    缩放宽度（对照 scale="512:-2"）
 * @param {number} quality  jpeg 质量（对照 quality=4）
 * @returns {Promise<{frames: Array<{path: string, timeSec: number, base64: string}>, outDir: string}>}
 */
function extractFramesBatch(ffmpegPath, video, times, tag, width = 512, quality = 4) {
  if (!video || !fs.existsSync(video)) return Promise.reject(new Error('视频文件不存在'))
  const list = Array.isArray(times) ? times.filter((t) => Number.isFinite(t) && t >= 0) : []
  if (!list.length) return Promise.reject(new Error('抽帧时间点为空'))

  // 目录标识白名单化，避免路径穿越（tag 来自渲染层）
  const safeTag = String(tag || 'frames').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) || 'frames'
  const outDir = path.join(require('node:os').tmpdir(), `tintin_frames_${safeTag}`)
  fs.rmSync(outDir, { recursive: true, force: true })
  fs.mkdirSync(outDir, { recursive: true })

  const grab = (atSec, outPath) => new Promise((resolve) => {
    const args = [
      '-y',
      '-ss', String(atSec),
      '-i', video,
      '-frames:v', '1',
      '-vf', `scale=${width}:-2`,
      '-q:v', String(quality),
      outPath
    ]
    const proc = spawn(ffmpegPath, args, { windowsHide: true })
    let stderr = ''
    proc.stderr.on('data', (d) => stderr += d)
    proc.on('error', () => resolve(false))
    proc.on('close', (code) => resolve(code === 0 && fs.existsSync(outPath)))
  })

  return (async () => {
    const frames = []
    for (let i = 0; i < list.length; i++) {
      const t = list[i]
      const outPath = path.join(outDir, `f${String(i).padStart(2, '0')}_${t}s.jpg`)
      const ok = await grab(t, outPath)
      // 单帧失败不中断（对照原版 if os.path.isfile(out) 才收集）
      if (!ok) continue
      try {
        frames.push({ path: outPath, timeSec: t, base64: fs.readFileSync(outPath).toString('base64') })
      } catch (_) { /* 读盘失败跳过该帧 */ }
    }
    if (!frames.length) throw new Error('视频关键帧提取失败，请检查视频文件是否损坏。')
    return { frames, outDir }
  })()
}

/**
 * 封面片头嵌入（M9 直播切片最终导出）。
 * 对照原客户端 live_clip/utils.py embed_cover_to_video L142-171（旧实现为
 * attached_pic 元数据封面且 -t 会截断正片，与原版语义不符，2026-09-03 重写）：
 * 封面按视频画幅 pad → 作为 2s 片头与正片 concat，音频延迟对齐片头，
 * -shortest 收尾。横竖版封面由渲染层按视频画幅选好传入（原版在函数内
 * 按 cover_/cover_vertical_ 命名约定选择，此处上移到调用方）。
 * 原版 get_video_encode_args(crf=23, preset=fast) 此处对齐为 libx264。
 */
async function embedCover(ffmpegPath, ffprobePath, video, cover, outPath, durationSec = 2) {
  const info = await probe(ffprobePath, video)
  const w = info.width > 0 ? info.width : 1080
  const h = info.height > 0 ? info.height : 1920
  const fps = info.fps > 0 ? info.fps : 30
  const cd = Math.max(0.5, Number(durationSec) || 2)
  const filter = [
    `[0:v]scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,` +
      `trim=duration=${cd},fps=${fps},setpts=PTS-STARTPTS,setsar=1,format=yuv420p[v0]`,
    `[1:v]fps=${fps},format=yuv420p[v1]`,
    `[v0][v1]concat=n=2:v=1:a=0[v]`,
    `[1:a]adelay=${Math.round(cd * 1000)}:all=1[a]`,
  ].join(';')
  return new Promise((resolve, reject) => {
    const args = [
      '-y',
      '-loop', '1', '-i', cover,
      '-i', video,
      '-filter_complex', filter,
      '-map', '[v]',
      '-map', '[a]',
      '-c:v', 'libx264', '-crf', '23', '-preset', 'fast',
      '-c:a', 'aac',
      '-shortest',
      outPath
    ]
    const proc = spawn(ffmpegPath, args, { windowsHide: true })
    let stderr = ''
    proc.stderr.on('data', (d) => stderr += d)
        proc.on('error', (err) => reject(new Error(`ffmpeg embedCover spawn failed: ${err.message}`)))
proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg embedCover failed: ${stderr.slice(-500)}`))
        return
      }
      resolve(outPath)
    })
  })
}

/**
 * 带缓存的音频提取（M9 直播切片，对照原客户端 live_clip/page.py L469-601）。
 * 音频已存在 + 未勾选「强制重新提取」+ 视频源未变更（mtimeMs+size+路径写
 * 入 .meta 校验，原版 L542-568 同口径）→ 直接复用缓存；否则删除旧缓存后按
 * 原版 AudioExtractWorker 同参数提取（pcm_s16le / 16kHz / 单声道 wav，
 * 原版 L61-63 同口径，服务端 ASR 输入）。
 * @returns {Promise<{path: string, cached: boolean}>}
 */
function extractAudioCached(ffmpegPath, video, forceReextract) {
  return (async () => {
    const vname = path.basename(video).replace(/\.[^.]+$/, '')
    const audioPath = path.join(require('node:os').tmpdir(), `${vname}_audio.wav`)
    const metaPath = path.join(require('node:os').tmpdir(), `${vname}_audio.meta`)
    const vstat = await fs.promises.stat(video)
    const curMeta = `${vstat.mtimeMs}_${vstat.size}_${video}`
    if (!forceReextract) {
      try {
        const saved = (await fs.promises.readFile(metaPath, 'utf8')).trim()
        if (saved === curMeta) {
          const st = await fs.promises.stat(audioPath)
          if (st.size > 0) return { path: audioPath, cached: true }
        }
      } catch (_) { /* 缓存缺失/读取失败 → 走重新提取 */ }
    }
    await Promise.all([
      fs.promises.unlink(audioPath).catch(() => {}),
      fs.promises.unlink(metaPath).catch(() => {}),
    ])
    await new Promise((resolve, reject) => {
      const args = [
        '-y', '-threads', '0', '-i', video, '-vn',
        '-acodec', 'pcm_s16le', '-ar', '16000', '-ac', '1',
        audioPath
      ]
      const proc = spawn(ffmpegPath, args, { windowsHide: true })
      let stderr = ''
      proc.stderr.on('data', (d) => stderr += d)
          proc.on('error', (err) => reject(new Error(`ffmpeg extractAudioCached spawn failed: ${err.message}`)))
proc.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`ffmpeg extractAudioCached failed: ${stderr.slice(-500)}`))
          return
        }
        resolve()
      })
    })
    await fs.promises.writeFile(metaPath, curMeta, 'utf8')
    return { path: audioPath, cached: false }
  })()
}

/**
 * 拼接视频片段
 */
function concatSegments(ffmpegPath, paths, outPath) {
  return new Promise((resolve, reject) => {
    // 创建 concat 列表文件
    const listFile = path.join(require('node:os').tmpdir(), `concat_${Date.now()}.txt`)
    const listContent = paths.map(p => `file '${p.replace(/'/g, "'\\''")}'`).join('\n')
    fs.writeFileSync(listFile, listContent, 'utf-8')

    const args = [
      '-y',
      '-f', 'concat',
      '-safe', '0',
      '-i', listFile,
      '-c', 'copy',
      outPath
    ]
    const proc = spawn(ffmpegPath, args, { windowsHide: true })
    let stderr = ''
    proc.stderr.on('data', (d) => stderr += d)
        proc.on('error', (err) => { try { fs.unlinkSync(listFile) } catch (e) {} reject(new Error(`ffmpeg concat spawn failed: ${err.message}`)) })
proc.on('close', (code) => {
      try { fs.unlinkSync(listFile) } catch (e) {}
      if (code !== 0) {
        reject(new Error(`ffmpeg concatSegments failed: ${stderr}`))
        return
      }
      resolve(outPath)
    })
  })
}

/**
 * 提取音频
 */
function extractAudio(ffmpegPath, video, outPath, format = 'aac') {
  return new Promise((resolve, reject) => {
    const args = [
      '-y',
      '-i', video,
      '-vn',
      '-acodec', format === 'aac' ? 'aac' : 'libmp3lame',
      '-ab', '192k',
      outPath
    ]
    const proc = spawn(ffmpegPath, args, { windowsHide: true })
    let stderr = ''
    proc.stderr.on('data', (d) => stderr += d)
        proc.on('error', (err) => reject(new Error(`ffmpeg extractAudio spawn failed: ${err.message}`)))
proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg extractAudio failed: ${stderr}`))
        return
      }
      resolve(outPath)
    })
  })
}

/**
 * 区间切片（直播/长视频快速裁切）
 * 默认（opts 不传）：流拷贝 —— ffmpeg -y -ss <start> -i <video> -t <duration>
 *                    -avoid_negative_ts make_zero -c copy <out>
 * opts.reencode（M9 直播切片对齐原版 VideoClipWorker L288-317）：两段式
 *   精确 seek（输入级提前 30s 关键帧定位 + 输出级精确到点）+ 重编码
 *   （libx264 crf23 preset fast + aac，原版 get_video_encode_args 同参数）。
 * opts.srtPath（烧录切片段字幕，原版 L296-306 同口径）： subtitles=basename
 *   滤镜 + cwd=srt 目录（切片段字幕由渲染层裁剪好落盘，主进程只做 I/O）。
 */
function cutClip(ffmpegPath, video, outPath, startSec, endSec, opts) {
  return new Promise((resolve, reject) => {
    const start = Math.max(0, Number(startSec) || 0)
    const end = Number(endSec) || Math.max(start + 1, start)
    const reencode = !!(opts && opts.reencode)
    const srtPath = (opts && opts.srtPath) || ''
    // 输出目录不存在时 ffmpeg 直接失败（No such file or directory）——先建目录
    // （2026-09-22 实测：镜内渲染 g{i}_s{j}.mp4 落 groups 目录未创建致 cutClip 全灭）
    try { fs.mkdirSync(path.dirname(outPath), { recursive: true }) } catch (_) {}
    let args
    let cwd
    if (!reencode) {
      const duration = Math.max(0.5, end - start)
      args = [
        '-y',
        '-ss', String(start),
        '-i', video,
        '-t', String(duration),
        '-avoid_negative_ts', 'make_zero',
        '-c', 'copy',
        outPath
      ]
    } else {
      const fastStart = Math.max(0, start - 30)
      const remainStart = start - fastStart
      const duration = Math.max(0.1, end - start)
      const vf = srtPath ? `subtitles=${path.basename(srtPath)},format=yuv420p` : 'format=yuv420p'
      if (srtPath) cwd = path.dirname(srtPath)
      args = [
        '-y',
        '-ss', fastStart.toFixed(3),
        '-i', video,
        '-ss', remainStart.toFixed(3),
        '-t', duration.toFixed(3),
        '-vf', vf,
        '-c:v', 'libx264', '-crf', '23', '-preset', 'fast',
        '-c:a', 'aac',
        outPath
      ]
    }
    const proc = spawn(ffmpegPath, args, { windowsHide: true, cwd })
    let stderr = ''
    proc.stderr.on('data', (d) => stderr += d)
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg cutClip failed: ${stderr}`))
        return
      }
      resolve(outPath)
    })
  })
}

/**
 * ffmpeg -i stderr 解析视频/音频流编码与像素格式（编码可播性检测）。
 * 与 probeDurationViaFfmpeg 同模式：ffprobe 未随包（resources/bin 仅 ffmpeg.exe），
 * 仅依赖 ffmpeg.exe stderr（Stream #0:0... Video: h264 (High 4:2:2)..., yuv422p10le...）。
 * 返回 { video, pixFmt, audio }（全小写）；文件不存在/解析失败返 null。
 */
function parseCodecsViaFfmpeg(ffmpegPath, file) {
  return new Promise((resolve) => {
    if (!file || !fs.existsSync(file)) return resolve(null)
    const proc = spawn(ffmpegPath, ['-hide_banner', '-i', file], { windowsHide: true })
    let stderr = ''
    proc.stderr.on('data', (d) => { stderr += d })
    proc.on('error', () => resolve(null))
        proc.on('error', () => resolve(null))
proc.on('close', () => {
      const out = { video: '', pixFmt: '', audio: '' }
      for (const line of stderr.split(/\r?\n/)) {
        let m = /Stream #\d+:\d+.*?:\s*Video:\s*([A-Za-z0-9_]+)/.exec(line)
        if (m) {
          out.video = m[1].toLowerCase()
          // 像素格式：编码名/括号参数后的已知族 token（yuv422p10le / yuvj420p / nv12 等）
          const pix = /,\s*(yuv[a-z0-9_]+|nv\d{2}|p010[le]?|gbrp\w*|bgr[a-z0-9_]+|rgb[a-z0-9_]+|gray[a-z0-9_]*)/.exec(line)
          if (pix) out.pixFmt = pix[1].toLowerCase()
          continue
        }
        m = /Stream #\d+:\d+.*?:\s*Audio:\s*([A-Za-z0-9_]+)/.exec(line)
        if (m) out.audio = m[1].toLowerCase()
      }
      resolve(out.video || out.audio ? out : null)
    })
  })
}

// Chromium/Electron 31 <video> 可直接解码的集合。其余一律 MediaError：
// H.264 仅支持 4:2:0 8bit（专业设备的 High 4:2:2 / 10bit yuv422p10le 拒解），
// MP4 容器音频仅认 AAC/MP3 等压缩流（pcm_s16be/twos 拒解）——
// 2026-09-10 素材预览全灭根因（555电池批次 3840x2160 h264 4:2:2 10bit + PCM）。
const PLAYABLE_VIDEO_CODECS = new Set(['h264', 'vp8', 'vp9', 'av1'])
const PLAYABLE_PIX_FORMATS = new Set(['yuv420p', 'yuvj420p', 'nv12'])
const PLAYABLE_AUDIO_CODECS = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac'])

/** 可播性判定（info=null 即检测失败：不拦截，交给播放器与既有错误 UI） */
function isStreamPlayable(info) {
  if (!info) return true
  const vOk = PLAYABLE_VIDEO_CODECS.has(info.video) && (!info.pixFmt || PLAYABLE_PIX_FORMATS.has(info.pixFmt))
  const aOk = !info.audio || PLAYABLE_AUDIO_CODECS.has(info.audio)
  return vOk && aOk
}

/**
 * 预览可播性保障（2026-09-10 素材预览全灭兜底）：
 * 不可播编码 → ffmpeg 转码到临时缓存 mp4（文件名含 size+mtime 自失效，
 * 预览用 1280 宽降采样 + veryfast + faststart，秒级出片）；
 * 可播/带协议 URL/检测失败 → 原路径直返。视频流可播仅音频不播时只转音频（视频 copy）。
 * @returns {Promise<{path: string, transcoded: boolean} | {error: string}>}
 */
async function ensurePlayablePreview(ffmpegPath, file) {
  if (!file || /^[a-z][a-z0-9+.-]*:/i.test(String(file)) || !fs.existsSync(file)) {
    return { path: file, transcoded: false }
  }
  const info = await parseCodecsViaFfmpeg(ffmpegPath, file)
  // 全程留痕（2026-09-10 素材预览事故教训：转码兜底链路无日志，断点无法定位）
  try { logger.logInfo('ffmpeg', `ensurePlayable 检测 ${file} → video=${info?.video || '(未解析)'} pixFmt=${info?.pixFmt || '(未解析)'} audio=${info?.audio || '(无/未解析)'}`) } catch (_) {}
  if (isStreamPlayable(info)) {
    try { logger.logInfo('ffmpeg', 'ensurePlayable 判定可播，原路径直返') } catch (_) {}
    return { path: file, transcoded: false }
  }
  const outDir = path.join(require('node:os').tmpdir(), 'tintin_preview')
  fs.mkdirSync(outDir, { recursive: true })
  const st = fs.statSync(file)
  const base = path.basename(file).replace(/\.[^.]+$/, '').slice(0, 60)
  const outPath = path.join(outDir, `${base}_${st.size}_${Math.round(st.mtimeMs)}_p.mp4`)
  // 缓存命中须同时有产物 + .ok 完成标记（防中断残留的半截文件被复用）
  if (fs.existsSync(outPath) && fs.existsSync(outPath + '.ok')) {
    try { logger.logInfo('ffmpeg', `ensurePlayable 缓存命中 ${outPath}`) } catch (_) {}
    return { path: outPath, transcoded: true }
  }
  const vPlayable = !!info && PLAYABLE_VIDEO_CODECS.has(info.video) && (!info.pixFmt || PLAYABLE_PIX_FORMATS.has(info.pixFmt))
  const aPlayable = !!info && (!info.audio || PLAYABLE_AUDIO_CODECS.has(info.audio))
  const args = [
    '-y', '-i', file,
    '-map', '0:v:0', '-map', '0:a:0?', '-sn',
    ...(vPlayable
      ? ['-c:v', 'copy']
      : ['-vf', 'scale=1280:-2:flags=bicubic,format=yuv420p', '-c:v', 'libx264', '-crf', '20', '-preset', 'veryfast']),
    ...(aPlayable ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '192k']),
    '-movflags', '+faststart',
    outPath,
  ]
  await new Promise((resolve, reject) => {
    const started = Date.now()
    const proc = spawn(ffmpegPath, args, { windowsHide: true })
    let stderr = ''
    proc.stderr.on('data', (d) => { stderr += d })
    proc.on('error', (err) => {
      try { logger.logError('ffmpeg', `ensurePlayable spawn 失败: ${err.message}`) } catch (_) {}
      reject(err)
    })
    proc.on('close', (code) => {
      if (code !== 0) {
        try { fs.unlinkSync(outPath) } catch (_) {}
        try { logger.logError('ffmpeg', `ensurePlayable 转码失败 code=${code}: ${stderr.slice(-300)}`) } catch (_) {}
        reject(new Error(`ffmpeg 转码失败: ${stderr.slice(-300)}`))
        return
      }
      try { logger.logInfo('ffmpeg', `ensurePlayable 转码完成 ${Math.round((Date.now() - started) / 100) / 10}s → ${outPath}`) } catch (_) {}
      try { fs.writeFileSync(outPath + '.ok', '1') } catch (_) {}
      resolve()
    })
  })
  return { path: outPath, transcoded: true }
}

function createFfmpegGate(ipcMain, studioRoot) {
  const ffmpegPath = getFfmpegPath(studioRoot)
  const ffprobePath = getFfprobePath(studioRoot)

  ipcMain.handle('ffmpeg:probe', async (event, file) => {
    try {
      return await probe(ffprobePath, file)
    } catch (err) {
      // 打包环境 resources/bin 不带 ffprobe.exe（仅 ffmpeg.exe/yt-dlp.exe），PATH 上也
      // 通常没有 → ffprobe 必然失败，此前该 IPC 直接报错。2026-09-11 补 ffmpeg -i 兜底：
      // Step2「输出帧率=跟随原片」与原片分辨率列都依赖此探测，无兜底则正式包恒拿不到
      // fps/宽高，静默降级（帧率回退 30、画幅回退 1080x1920）。
      const fb = await probeViaFfmpeg(ffmpegPath, file)
      if (!fb) throw err
      return {
        duration: fb.duration, width: fb.width, height: fb.height,
        fps: fb.fps, codec: fb.video, audio_bitrate: 0, via: 'ffmpeg',
      }
    }
  })

  // ── ffmpeg:probeDuration — 仅取时长（2026-09-09 用户裁决：素材列表加时长列）──
  // resources/bin 未随包 ffprobe.exe（仅 ffmpeg.exe/yt-dlp.exe），getFfprobePath
  // 回退 PATH 的 ffprobe 也不存在 → ffmpeg:probe 必然失败。
  // 策略：ffprobe 可用优先（精度一致）；否则回退 ffmpeg -i stderr 的 Duration 行解析。
  ipcMain.handle('ffmpeg:probeDuration', async (event, file) => {
    if (ffprobePath && path.isAbsolute(ffprobePath)) {
      try {
        const r = await probe(ffprobePath, file)
        const d = Number(r && r.duration)
        if (d > 0) return d
      } catch (_) { /* 回退 ffmpeg 解析 */ }
    }
    return await probeDurationViaFfmpeg(ffmpegPath, file)
  })

  // ── ffmpeg:ensurePlayable — 预览可播性保障（2026-09-10 素材预览全灭兜底）：
  // Chromium 不可播编码（H.264 4:2:2/10bit、MP4+PCM 等）自动转码到临时缓存，
  // 可播/检测失败原路径直返 → { path, transcoded } 或 { error } ──
  ipcMain.handle('ffmpeg:ensurePlayable', async (event, file) => {
    try {
      return await ensurePlayablePreview(ffmpegPath, file)
    } catch (err) {
      return { error: (err && err.message) || String(err) }
    }
  })

  // （ffmpeg:extractThumb 已废弃删除：预览缩略图改渲染层 canvas 抓帧，2026-09-07）

  ipcMain.handle('ffmpeg:extractFrames', async (event, payload) => {
    const p = payload || {}
    try {
      return await extractFramesBatch(
        ffmpegPath, p.videoPath, p.times, p.tag, p.width || 512, p.quality || 4
      )
    } catch (err) { return { error: (err && err.message) || String(err) } }
  })

  ipcMain.handle('ffmpeg:embedCover', async (event, video, cover, outPath, durationSec) => {
    return await embedCover(ffmpegPath, ffprobePath, video, cover, outPath, durationSec)
  })

  ipcMain.handle('ffmpeg:extractAudioCached', async (event, video, forceReextract) => {
    return await extractAudioCached(ffmpegPath, video, forceReextract)
  })

  ipcMain.handle('ffmpeg:extractAudio', async (event, video, outPath, format) => {
    return await extractAudio(ffmpegPath, video, outPath, format)
  })

  ipcMain.handle('ffmpeg:cut', async (event, video, outPath, startSec, endSec, opts) => {
    return await cutClip(ffmpegPath, video, outPath, startSec, endSec, opts)
  })
}

module.exports = { createFfmpegGate, getStreamRotationDeg, applyRotationSize, extractFramesBatch, parseCodecsViaFfmpeg, isStreamPlayable, parseFfmpegInfo, probeViaFfmpeg }
