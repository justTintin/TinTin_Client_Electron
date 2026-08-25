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
        resolve({
          duration: parseFloat(info.format?.duration || 0),
          width: parseInt(videoStream?.width || 0, 10),
          height: parseInt(videoStream?.height || 0, 10),
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

function createFfmpegGate(ipcMain, studioRoot) {
  const ffmpegPath = getFfmpegPath(studioRoot)
  const ffprobePath = getFfprobePath(studioRoot)

  ipcMain.handle('ffmpeg:probe', async (event, file) => {
    return await probe(ffprobePath, file)
  })

  ipcMain.handle('ffmpeg:extractThumb', async (event, video, atSec, w) => {
    return await extractThumb(ffmpegPath, video, atSec, w)
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
}

module.exports = { createFfmpegGate }
