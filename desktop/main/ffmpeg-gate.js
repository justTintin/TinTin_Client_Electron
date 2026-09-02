const { ipcMain } = require('electron')
const { spawn } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')

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
 * 提取视频缩略图
 */
function extractThumb(ffmpegPath, video, atSec, w) {
  return new Promise((resolve, reject) => {
    const outPath = path.join(require('node:os').tmpdir(), `thumb_${Date.now()}.png`)
    const args = [
      '-y',
      '-ss', String(atSec),
      '-i', video,
      '-frames:v', '1',
      '-vf', w ? `scale=${w}:-1` : 'scale=320:-1',
      '-q:v', '2',
      outPath
    ]
    const proc = spawn(ffmpegPath, args, { windowsHide: true })
    let stderr = ''
    proc.stderr.on('data', (d) => stderr += d)
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg extractThumb failed: ${stderr}`))
        return
      }
      resolve(outPath)
    })
  })
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
 * 嵌入封面到视频
 */
function embedCover(ffmpegPath, video, cover, outPath, durationSec = 2) {
  return new Promise((resolve, reject) => {
    const args = [
      '-y',
      '-i', video,
      '-i', cover,
      '-map', '0:v',
      '-map', '0:a?',
      '-map', '1:v',
      '-c:v:0', 'copy',
      '-c:v:1', 'mjpeg',
      '-disposition:v:1', 'attached_pic',
      '-t', String(durationSec),
      outPath
    ]
    const proc = spawn(ffmpegPath, args, { windowsHide: true })
    let stderr = ''
    proc.stderr.on('data', (d) => stderr += d)
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg embedCover failed: ${stderr}`))
        return
      }
      resolve(outPath)
    })
  })
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
 * ffmpeg -y -ss <start> -i <video> -t <duration> -avoid_negative_ts make_zero -c copy <out>
 */
function cutClip(ffmpegPath, video, outPath, startSec, endSec) {
  return new Promise((resolve, reject) => {
    const start = Math.max(0, Number(startSec) || 0)
    const end = Number(endSec) || Math.max(start + 1, start)
    const duration = Math.max(0.5, end - start)
    const args = [
      '-y',
      '-ss', String(start),
      '-i', video,
      '-t', String(duration),
      '-avoid_negative_ts', 'make_zero',
      '-c', 'copy',
      outPath
    ]
    const proc = spawn(ffmpegPath, args, { windowsHide: true })
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

function createFfmpegGate(ipcMain, studioRoot) {
  const ffmpegPath = getFfmpegPath(studioRoot)
  const ffprobePath = getFfprobePath(studioRoot)

  ipcMain.handle('ffmpeg:probe', async (event, file) => {
    return await probe(ffprobePath, file)
  })

  ipcMain.handle('ffmpeg:extractThumb', async (event, video, atSec, w) => {
    return await extractThumb(ffmpegPath, video, atSec, w)
  })

  ipcMain.handle('ffmpeg:extractFrames', async (event, payload) => {
    const p = payload || {}
    try {
      return await extractFramesBatch(
        ffmpegPath, p.videoPath, p.times, p.tag, p.width || 512, p.quality || 4
      )
    } catch (err) { return { error: (err && err.message) || String(err) } }
  })

  ipcMain.handle('ffmpeg:embedCover', async (event, video, cover, outPath, durationSec) => {
    return await embedCover(ffmpegPath, video, cover, outPath, durationSec)
  })

  ipcMain.handle('ffmpeg:concatSegments', async (event, paths, outPath) => {
    return await concatSegments(ffmpegPath, paths, outPath)
  })

  ipcMain.handle('ffmpeg:extractAudio', async (event, video, outPath, format) => {
    return await extractAudio(ffmpegPath, video, outPath, format)
  })

  ipcMain.handle('ffmpeg:cut', async (event, video, outPath, startSec, endSec) => {
    return await cutClip(ffmpegPath, video, outPath, startSec, endSec)
  })
}

module.exports = { createFfmpegGate, getStreamRotationDeg, applyRotationSize, extractFramesBatch }
