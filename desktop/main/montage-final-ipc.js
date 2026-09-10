// ═══════════════════════════════════════════════════════════════
// montage-final-ipc.js — 智能混剪 Step4「特效包装」域 IPC
// 对照原客户端（studio/gui/ + utils/）：
//   · workers/concat_workers.py FinalMixWorker L651-746 → final:mix
//     （本地 ffmpeg：ffprobe 探测音频流 → sidechain ducking + 淡入淡出 +
//       loudnorm（EBU R128 -16 LUFS）；无 BGM → -c copy）
//   · video_montage_page.py _collect_mix_candidates 回退段 L4088-4104 → final:collectOutputs
//     （扫描 outputs 排列视频，_get_out_montage_dir L3969-3981 目录规则）
//   · _find_srt_for_video L4249-4271 → final:findSrt
//   · _export_to_jianying_draft / _export_all_to_jianying_draft L4196-4326
//     → jianying:export（JianyingExporter 一比一移植于 jianying-exporter.js）
//   · 本端扩展（架构差异，AI BGM 生成结果为服务端 URL，本地混音需落盘）：
//     bgm:downloadUrl —— 下载 AI 生成 BGM 到本地（列入待裁决清单）
// 剪映导出为本地文件操作，不依赖服务端契约。
// ═══════════════════════════════════════════════════════════════

'use strict'

const { spawn, execSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const JY = require('./jianying-exporter')
// 特效烧制（2026-09-09 裁决：字幕/花字特效自配音链迁 Step4 统一烧制，
// 与配音链同一构建器 voice-tts-logic.buildEffectBurnArgs 保证样式/时机一致）
const L = require('./voice-tts-logic')
const FT = require('./fancy-templates')
const VI = require('./montage-voice-ipc')

// ── ffmpeg/ffprobe 路径（同 ffmpeg-gate.js getBinDir 口径，未导出故本地等价实现）──
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

function getFfprobePath() {
  const binDir = getBinDir()
  if (binDir) {
    const exe = path.join(binDir, 'ffprobe.exe')
    if (fs.existsSync(exe)) return exe
  }
  return 'ffprobe'
}

/** 媒体时长（秒）（对照 utils_media.py get_media_duration：ffprobe format=duration） */
function getMediaDuration(filepath) {
  try {
    const out = execSync(
      `"${getFfprobePath()}" -v error -show_entries format=duration -of csv=p=0 "${filepath}"`,
      { timeout: 10000, windowsHide: true, encoding: 'utf-8' },
    ).trim()
    if (out) return parseFloat(out) || 0.0
  } catch (_) { /* 原版失败返回 0.0 */ }
  return 0.0
}

/** ffmpeg 运行（FinalMixWorker _run_proc 口径） */
function runFfmpeg(args) {
  return new Promise((resolve) => {
    const proc = spawn(getFfmpegPath(), args, { windowsHide: true })
    let stderr = ''
    proc.stderr.on('data', (c) => { stderr += c })
    proc.on('close', (code) => resolve({ code, stderr }))
    proc.on('error', (e) => resolve({ code: -1, stderr: String(e) }))
  })
}

/** 视频是否含音频流（FinalMixWorker L683-693：ffprobe codec_type 探测，异常按有音频处理） */
function hasAudioStream(videoPath) {
  try {
    const out = execSync(
      `"${getFfprobePath()}" -v error -show_entries stream=codec_type -of csv=p=0 "${videoPath}"`,
      { timeout: 10000, windowsHide: true, encoding: 'utf-8' },
    )
    if (String(out).includes('audio')) return true
    return false
  } catch (_) {
    return true
  }
}

/** ffprobe 探测（时长/宽高，供剪映导出 _probe_video） */
function probeMedia(filepath) {
  let durationSec = 0.0
  let width = 1080
  let height = 1920
  try {
    const out = execSync(
      `"${getFfprobePath()}" -v error -show_entries format=duration -of csv=p=0 "${filepath}"`,
      { timeout: 10000, windowsHide: true, encoding: 'utf-8' },
    ).trim()
    if (out) durationSec = parseFloat(out) || 0.0
  } catch (_) { /* 原版失败返回 0 */ }
  try {
    const out = execSync(
      `"${getFfprobePath()}" -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 "${filepath}"`,
      { timeout: 10000, windowsHide: true, encoding: 'utf-8' },
    ).trim()
    const first = String(out).split(/\r?\n/).find((s) => s.trim())
    if (first) {
      const parts = first.split(',')
      if (parts.length >= 2) {
        width = Math.round(parseFloat(parts[0])) || 1080
        height = Math.round(parseFloat(parts[1])) || 1920
      }
    }
  } catch (_) { /* 原版失败返回默认尺寸 */ }
  return { durationSec, width, height }
}

/** 输入目录 → outputs 目录（_get_out_montage_dir L3969-3981 一比一） */
function getOutMontageDir(dirPath) {
  const abs = path.resolve(dirPath)
  const pathStr = abs.split('\\').join('/').replace(/\/+$/, '')
  if (pathStr.endsWith('/outputs')) return abs
  const withSlash = pathStr + '/'
  if (withSlash.includes('/outputs/')) {
    const idx = pathStr.indexOf('/outputs')
    return path.resolve(pathStr.slice(0, idx), 'outputs')
  }
  return path.resolve(path.dirname(abs), 'outputs')
}

/** 待混音视频 → final 输出目录（_get_out_final_dir L3983-3995 一比一） */
function getOutFinalDir(firstVid) {
  const abs = path.resolve(firstVid)
  const pathStr = abs.split('\\').join('/').replace(/\/+$/, '')
  const withSlash = pathStr + '/'
  if (withSlash.includes('/outputs/')) {
    const idx = pathStr.indexOf('/outputs')
    return path.resolve(pathStr.slice(0, idx), 'final')
  }
  const dirName = path.dirname(abs)
  let baseParent = path.resolve(path.dirname(dirName))
  if (['dubbed', 'outputs'].includes(path.basename(dirName))) {
    baseParent = path.resolve(path.dirname(baseParent))
  }
  return path.join(baseParent, 'final')
}

/** 查找视频同目录配套 .srt（_find_srt_for_video L4249-4271 一比一） */
function findSrtForVideo(videoPath) {
  const videoDir = path.dirname(videoPath)
  const videoBasename = path.basename(videoPath, path.extname(videoPath))
  let srtPath = path.join(videoDir, `${videoBasename}.srt`)
  // 兼容处理：有些视频名为 dubbed_xxx.mp4，但是字幕名为 dubbed_xxx.srt，也可能叫 xxx.srt
  if (!fs.existsSync(srtPath)) {
    let cleanName = videoBasename
    if (cleanName.startsWith('dubbed_')) cleanName = cleanName.slice('dubbed_'.length)
    else if (cleanName.startsWith('final_')) cleanName = cleanName.slice('final_'.length)
    for (const folder of [videoDir, path.dirname(videoDir)]) {
      const tmpSrt = path.join(folder, `${cleanName}.srt`)
      if (fs.existsSync(tmpSrt)) { srtPath = tmpSrt; break }
    }
  }
  return fs.existsSync(srtPath) ? srtPath : ''
}

const VIDEO_EXTS = new Set(['.mp4', '.mkv', '.avi', '.mov', '.webm', '.m4v'])

function createMontageFinalIpc(ipcMain, { httpRequest, isExpectedOfflineError, getServerUrl }) {

  // ── final:mix — 最终混音合成（FinalMixWorker.run L662-746 一比一）──
  // tasks: [{videoPath, outPath}]；bgmPath/bgmVolume(0-200)；进度经 progressChannel 推送。
  // 2026-09-09 裁决扩展：payload 可带 effects（字幕/花字配置）+ subtitleTexts
  // （[{videoPath, text, timingPath}]，渲染层已按候选视频映射好文案），
  // 混音前逐视频 ffmpeg 烧制特效到中间文件，混音后清理；无特效配置时零开销直通。
  ipcMain.handle('final:mix', async (event, payload) => {
    try {
      const p = payload || {}
      const tasks = Array.isArray(p.tasks) ? p.tasks : []
      if (!tasks.length) throw new Error('final:mix requires tasks[]')
      const channel = p.progressChannel || ''
      const emit = (stage, value) => { if (channel) event.sender.send(channel, { stage, value }) }

      const ffmpegPath = getFfmpegPath()
      const hasBgm = !!(p.bgmPath && fs.existsSync(p.bgmPath))
      const bgmVol = (Number(p.bgmVolume) || 0) / 100.0

      // ── 特效烧制前置阶段（同 dubVideos 字体/模板解析口径）──
      const fx = p.effects || null
      const subTexts = Array.isArray(p.subtitleTexts) ? p.subtitleTexts : []
      const hasFx = !!(fx && (fx.addSubtitles || fx.fancyText) && subTexts.length)
      let fontPathEsc = ''
      let fancyFontPath = ''
      let fancyTemplate = null
      let fancySoundPath = ''
      let fancySoundGainDb = -6.0
      if (hasFx) {
        // 字幕字体：族名 → 注册表解析本机字体文件，解析不到回退微软雅黑（dubVideos 同口径）
        const family = String(fx.subtitleFont || '').trim()
        fontPathEsc = fx.addSubtitles
          ? L.resolveSubtitleFontPath(family, {
              familyPath: family ? VI.lookupWindowsFontFile(family) : '',
              path: (cand) => fs.existsSync(cand.replace(/\\:/g, ':')),
            })
          : ''
        // 花字字体：msyhbd.ttc → msyh.ttc → msyh
        fancyFontPath = fs.existsSync('C:/Windows/Fonts/msyhbd.ttc')
          ? 'C\\:/Windows/Fonts/msyhbd.ttc'
          : (fs.existsSync('C:/Windows/Fonts/msyh.ttc') ? 'C\\:/Windows/Fonts/msyh.ttc' : 'msyh')
        // 花字模板（非 dict → null=自定义样式）+ anim 缺失推导 + 模板音效
        if (fx.fancyTemplate) {
          try {
            const parsed = typeof fx.fancyTemplate === 'string' ? JSON.parse(fx.fancyTemplate) : fx.fancyTemplate
            if (parsed && typeof parsed === 'object' && parsed.template_id) {
              fancyTemplate = parsed
              if (!fancyTemplate.anim) fancyTemplate.anim = L.getFancyAnim(fancyTemplate)
            }
          } catch (_) { fancyTemplate = null }
        }
        fancySoundPath = fancyTemplate ? FT.getFancySoundPath(fancyTemplate) : ''
        fancySoundGainDb = fancyTemplate ? FT.getFancySoundGainDb(fancyTemplate) : -6.0
      }

      const fxPaths = new Map() // videoPath → 特效烧制中间文件
      if (hasFx) {
        for (let i = 0; i < tasks.length; i++) {
          const t = tasks[i]
          const sub = subTexts.find((s) => s.videoPath === t.videoPath)
          if (!sub || !String(sub.text || '').trim()) continue
          emit(`正在烧制字幕/花字特效 (${i + 1}/${tasks.length})...`, Math.floor(i / tasks.length * 55))
          const videoDur = getMediaDuration(t.videoPath)
          if (videoDur <= 0) continue // 时长读不出 → 无法定位时间轴，跳过烧制直通混音
          // .timing.json 句级时间轴（voice-tts-logic buildSubtitleLines 既有口径）
          let timing = null
          try {
            const sidecar = String(sub.timingPath || '')
            if (sidecar && fs.existsSync(sidecar)) {
              const arr = JSON.parse(fs.readFileSync(sidecar, 'utf-8'))
              if (Array.isArray(arr) && arr.length && arr.every((x) => x && x.text)) timing = arr
            }
          } catch (_) { timing = null }
          const ext = path.extname(t.outPath) || '.mp4'
          const fxOut = t.outPath.replace(/\.[^.]+$/, '') + '.fx' + ext
          const args = L.buildEffectBurnArgs({
            videoPath: t.videoPath,
            outputVideoPath: fxOut,
            text: String(sub.text || ''),
            timing,
            videoDur,
            addSubtitles: !!fx.addSubtitles,
            subtitleFontPath: fontPathEsc,
            subtitleStyle: String(fx.subtitleStyle || 'white'),
            subtitleBoxOpacity: fx.subtitleBoxOpacity ?? 0.5,
            // 字幕入场动画（2026-09-10 用户裁决：可选 fade/rise/slide/pop/none，预览与烧制同源）
            subtitleAnim: String(fx.subtitleAnim || 'fade'),
            fancyText: !!fx.fancyText,
            fancyStyle: fx.fancyStyle || 'gold',
            fancyPosition: fx.fancyPosition || 'upper_middle',
            fancyFontPath,
            fancyTemplate,
            fancySoundPath,
            fancySoundGainDb,
          })
          if (!args) continue // 无特效可烧（构建器判定）→ 直通
          const r = await runFfmpeg(args)
          if (r.code !== 0) {
            throw new Error(`字幕/花字特效烧制失败：\n${r.stderr || '(无输出)'}`)
          }
          fxPaths.set(t.videoPath, fxOut)
        }
      }

      // 混音进度分段：有特效烧制时烧制占 0-55、混音占 60-100；无特效保持 0-100
      const mixBase = hasFx ? 60 : 0
      const mixSpan = hasFx ? 40 : 100

      const results = []
      const total = tasks.length
      for (let index = 0; index < total; index++) {
        const { videoPath, outPath } = tasks[index]
        const srcVideo = fxPaths.get(videoPath) || videoPath
        emit(`正在进行最终合成配乐 (${index + 1}/${total})...`, mixBase + Math.floor(index / total * mixSpan))
        fs.mkdirSync(path.dirname(outPath), { recursive: true })

        let args
        if (hasBgm) {
          const hasAudio = hasAudioStream(srcVideo)
          // BGM 淡入淡出：开头 1s 淡入，结尾 2s 淡出（按视频时长定位）
          const vidDur = getMediaDuration(srcVideo)
          const fadeOutStart = Math.max(0.0, vidDur - 2.0)
          const bgmFades = vidDur > 0
            ? `afade=t=in:st=0:d=1.0,afade=t=out:st=${fadeOutStart.toFixed(3)}:d=2.0`
            : 'afade=t=in:st=0:d=1.0'
          if (hasAudio) {
            // 人声闪避（sidechain ducking）：BGM 在人声出现时自动压低，
            // 人声停顿时回升；最终 loudnorm 统一响度（EBU R128 -16 LUFS）。
            const filterComplex = (
              `[0:a]asplit=2[vo][sc];` +
              `[1:a]volume=${bgmVol},${bgmFades}[bg];` +
              `[bg][sc]sidechaincompress=threshold=0.05:ratio=8:attack=50:release=400[duck];` +
              `[vo][duck]amix=inputs=2:duration=first:normalize=0,` +
              `loudnorm=I=-16:TP=-1.5:LRA=11[a]`
            )
            args = [
              '-y', '-i', srcVideo,
              '-stream_loop', '-1', '-i', p.bgmPath,
              '-filter_complex', filterComplex,
              '-map', '0:v', '-map', '[a]',
              '-c:v', 'copy', '-c:a', 'aac', '-shortest',
              outPath,
            ]
          } else {
            args = [
              '-y', '-i', srcVideo,
              '-stream_loop', '-1', '-i', p.bgmPath,
              '-filter_complex', `[1:a]volume=${bgmVol},${bgmFades},loudnorm=I=-16:TP=-1.5:LRA=11[bgm]`,
              '-map', '0:v', '-map', '[bgm]',
              '-c:v', 'copy', '-c:a', 'aac', '-shortest',
              outPath,
            ]
          }
        } else {
          args = ['-y', '-i', srcVideo, '-c', 'copy', outPath]
        }

        const r = await runFfmpeg(args)
        if (r.code !== 0) {
          throw new Error(`最后合成视频失败：\n${r.stderr || '(无输出)'}`)
        }
        // 特效烧制中间文件用完即清（失败中断时残留由下次同名烧制覆盖，不阻断）
        const fxTmp = fxPaths.get(videoPath)
        if (fxTmp) { try { fs.unlinkSync(fxTmp) } catch (_) { /* 忽略 */ } }
        results.push(outPath)
      }
      emit('所有视频及配乐最终合成完成！', 100)
      return { results }
    } catch (err) {
      return { error: err.message }
    }
  })

  // ── final:collectOutputs — 回退扫描 outputs 排列视频（_collect_mix_candidates L4088-4104）──
  ipcMain.handle('final:collectOutputs', async (_e, payload) => {
    try {
      const p = payload || {}
      const dirPath = String(p.dirPath || '')
      if (!dirPath) return { files: [] }
      const outMontageDir = getOutMontageDir(dirPath)
      if (!fs.existsSync(outMontageDir) || !fs.statSync(outMontageDir).isDirectory()) return { files: [] }
      const files = []
      for (const f of fs.readdirSync(outMontageDir)) {
        if (VIDEO_EXTS.has(path.extname(f).toLowerCase())) {
          const fp = path.join(outMontageDir, f)
          if (fs.statSync(fp).isFile()) files.push(fp)
        }
      }
      return { files, outDir: outMontageDir }
    } catch (err) {
      return { files: [], error: err.message }
    }
  })

  // ── final:findSrt — 视频配套字幕查找（_find_srt_for_video）──
  ipcMain.handle('final:findSrt', async (_e, payload) => {
    try {
      const videoPath = String((payload || {}).videoPath || '')
      if (!videoPath) return { srtPath: '' }
      return { srtPath: findSrtForVideo(videoPath) }
    } catch (err) {
      return { srtPath: '', error: err.message }
    }
  })

  // ── jianying:export — 剪映专业版草稿导出（_export_to_jianying_draft / _export_all）──
  // mode 'single'：单视频（export_to_draft）；mode 'multi'：多片段时间轴（export_multi_to_draft，
  // transitions 沿用第②步转场下拉 key，默认 fade）。
  ipcMain.handle('jianying:export', async (_e, payload) => {
    try {
      const p = payload || {}
      const deps = { probeMedia }
      const res = p.mode === 'multi'
        ? JY.exportMultiToDraft({
            videoPaths: p.videoPaths,
            transitions: p.transitions,
            bgmPath: p.bgmPath,
            bgmVolume: Number(p.bgmVolume) || 50,
            srtPaths: p.srtPaths,
            draftName: p.draftName,
            deps,
          })
        : JY.exportToDraft({
            videoPath: p.videoPath,
            bgmPath: p.bgmPath,
            bgmVolume: Number(p.bgmVolume) || 50,
            srtPath: p.srtPath,
            draftName: p.draftName,
            deps,
          })
      return res
    } catch (err) {
      return { success: false, message: err.message }
    }
  })

  // ── bgm:downloadUrl — AI 生成 BGM 落盘（本端扩展：本地混音需本地文件，见头注）──
  ipcMain.handle('bgm:downloadUrl', async (_e, payload) => {
    try {
      const p = payload || {}
      let u = String(p.url || '')
      if (!u) throw new Error('bgm:downloadUrl requires url')
      if (!/^https?:/i.test(u)) {
        u = getServerUrl().replace(/\/$/, '') + (u.startsWith('/') ? u : '/' + u)
      }
      const destDir = String(p.destDir || '')
      if (!destDir) throw new Error('bgm:downloadUrl requires destDir')
      fs.mkdirSync(destDir, { recursive: true })
      const dest = path.join(destDir, `ai_bgm_${Date.now()}.mp3`)
      const r = await httpRequest('GET', u, { timeout: 60000 })
      fs.writeFileSync(dest, Buffer.from(r.raw || ''))
      return { path: dest }
    } catch (err) {
      return isExpectedOfflineError(err) ? null : { error: err.message }
    }
  })
}

module.exports = { createMontageFinalIpc, getOutFinalDir, getOutMontageDir, findSrtForVideo }
