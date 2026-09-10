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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 句级时间轴 → SRT 字符串（timing.json 优先，回退字数比例均分；与本地
 *  buildSubtitleLines 同口径，供服务端统一合成 subtitle_srt 字段） */
function buildSrtFromTiming(text, timing, videoDur) {
  let lines, starts, ends
  if (Array.isArray(timing) && timing.length && timing.every((t) => t && t.text)) {
    lines = timing.map((t) => String(t.text).trim())
    starts = timing.map((t) => Number(t.start ?? 0))
    ends = timing.map((t) => Number(t.end ?? 0))
  } else {
    lines = String(text || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
    if (!lines.length) return ''
    const weights = lines.map((l) => Math.max(1, l.length))
    const total = weights.reduce((a, b) => a + b, 0)
    let cum = 0
    starts = []
    ends = []
    for (const w of weights) {
      starts.push(cum)
      cum += (videoDur > 0 ? videoDur : lines.length * 5) * w / total
      ends.push(cum)
    }
  }
  const ts = (s) => {
    const ms = Math.max(0, Math.round(s * 1000))
    const h = String(Math.floor(ms / 3600000)).padStart(2, '0')
    const m = String(Math.floor((ms % 3600000) / 60000)).padStart(2, '0')
    const sec = String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')
    const mmm = String(ms % 1000).padStart(3, '0')
    return `${h}:${m}:${sec},${mmm}`
  }
  return lines.map((l, i) => `${i + 1}\n${ts(starts[i])} --> ${ts(Math.max(starts[i] + 0.2, ends[i]))}\n${l}`).join('\n')
}

/** 特效配置 → 服务端统一合成表单字段（2026-09-10 在线契约；口径对照原版
 *  _submit_concat_to_server：subtitle_style=JSON{box_opacity}；fancy_timing='subtitle_sync'
 *  服务端自动按字幕同步提前 0.3s，客户端不提供时间轴；文案服务端自动提取。
 *  text_template_match_*：2026-09-10 服务端新增 match_density（low/mid/high，默认
 *  high，非法退 high）；模板 id 为 random（未指定）→ match_enabled=true 走全局词表
 *  自动匹配（/text_templates/keywords 为取数源）；text_template_timing 缺省
 *  subtitle_sync 与服务端默认一致不传） */
function buildServerFxFields(fx, srt) {
  const fields = {}
  if (fx.addSubtitles) {
    fields.burn_subtitle = 'true'
    if (fx.subtitleFont) fields.fontname = String(fx.subtitleFont)
    const op = Math.min(1, Math.max(0, Number(fx.subtitleBoxOpacity ?? 0.5)))
    fields.subtitle_style = JSON.stringify({ box_opacity: Number.isFinite(op) ? op : 0.5 })
    if (srt) fields.subtitle_srt = srt
  }
  if (fx.fancyText) {
    fields.fancy_enabled = 'true'
    fields.fancy_style = String(fx.fancyStyle || 'gold')
    fields.fancy_position = String(fx.fancyPosition || 'upper_middle')
    fields.fancy_timing = 'subtitle_sync'
    let tpl = fx.fancyTemplate
    if (tpl && typeof tpl === 'string') { try { tpl = JSON.parse(tpl) } catch (_) { tpl = null } }
    if (tpl && typeof tpl === 'object') {
      fields.fancy_template = JSON.stringify(tpl)
      if (tpl.template_id) fields.fancy_template_id = String(tpl.template_id)
    }
  }
  if (fx.textFxEnabled) {
    fields.text_template_enabled = 'true'
    if (fx.textTemplateId && fx.textTemplateId !== 'random') {
      fields.text_template_id = String(fx.textTemplateId)
    } else {
      // 随机样式（未指定模板）→ 按全局词表自动匹配模板
      fields.text_template_match_enabled = 'true'
    }
    if (Array.isArray(fx.textTemplateWords) && fx.textTemplateWords.length) {
      fields.text_template_words = JSON.stringify(fx.textTemplateWords)
    }
    const md = String(fx.matchDensity || '').trim().toLowerCase()
    if (md === 'low' || md === 'mid' || md === 'high') fields.text_template_match_density = md
  }
  return fields
}

/** multipart 组装（单文件 files 字段 + 文本字段；boundary 随机） */
function buildFxMultipart(fields, filePath) {
  const boundary = '----TintinFx' + Math.random().toString(16).substring(2)
  const parts = []
  for (const [k, v] of Object.entries(fields || {})) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`))
  }
  const fname = path.basename(filePath).replace(/"/g, '')
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${fname}"\r\nContent-Type: video/mp4\r\n\r\n`))
  parts.push(fs.readFileSync(filePath))
  parts.push(Buffer.from('\r\n'))
  parts.push(Buffer.from(`--${boundary}--\r\n`))
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` }
}

/** 服务端统一合成特效烧制（单视频）：提交 → 轮询结果端点 → 下载落盘 → moov 校验。
 *  任一环节失败抛错由调用方回退本地 ffmpeg。产物校验防两处实测坑：
 *  未就绪 200+0B 空体、就绪产物截断 moov 缺失。 */
async function serverFxBurnOne({ httpRequest, videoPath, fxOut, fx, sub, videoDur }) {
  let timing = null
  try {
    const sidecar = String(sub.timingPath || '')
    if (sidecar && fs.existsSync(sidecar)) {
      const arr = JSON.parse(fs.readFileSync(sidecar, 'utf-8'))
      if (Array.isArray(arr) && arr.length && arr.every((x) => x && x.text)) timing = arr
    }
  } catch (_) { timing = null }
  const fields = buildServerFxFields(fx, buildSrtFromTiming(sub.text, timing, videoDur))
  const { body, contentType } = buildFxMultipart(fields, videoPath)
  const res = await httpRequest('POST', '/montage/concat', {
    body,
    headers: { 'Content-Type': contentType },
    timeout: 600000,
  })
  const r = res.data
  if (!r || typeof r !== 'object') throw new Error('统一合成提交未返回 JSON')
  const id = r.id ?? r.task_id ?? r.job_id
  if (id === undefined || id === null || id === '') throw new Error('统一合成提交未返回任务 id')
  const resultPath = `/montage/concat/result/${encodeURIComponent(String(id))}`
  const deadline = Date.now() + 15 * 60 * 1000
  let buf = null
  while (Date.now() < deadline) {
    await sleep(3000)
    let resp
    try {
      resp = await httpRequest('GET', resultPath, { timeout: 120000 })
    } catch (err) {
      if (err && (err.status === 404 || err.status === 202)) continue // 未就绪
      throw err
    }
    const raw = Buffer.from(resp.raw || '')
    if (!raw.length) continue // 未就绪口径：200+0B 空体（实测契约）
    const ct = String((resp.headers && resp.headers['content-type']) || '')
    if (raw.length < 1024 && !ct.includes('video')) continue
    buf = raw
    break
  }
  if (!buf) throw new Error('统一合成结果轮询超时（15 分钟）')
  fs.writeFileSync(fxOut, buf)
  const dur = getMediaDuration(fxOut)
  if (!(dur > 0)) {
    try { fs.unlinkSync(fxOut) } catch (_) { /* 忽略 */ }
    throw new Error('服务端特效产物无法读取（moov 缺失/截断）')
  }
}

/** 服务端 BGM 混音（2026-09-10 用户裁决：统一合成主按钮走服务端）：
 *  POST /montage/bgm 同步返回 {ok, video_url, task_id}（实测，无 result 轮询端点），
 *  bgm_volume 为 volume 系数口径（默认 0.6，与客户端 bgmVolume/100 同口径）→
 *  video_url 下载落盘 → 时长校验。任一环节失败抛错由调用方回退本地混音。
 *  实测注意：①视频必须带音轨，无声视频服务端内部 ffmpeg 500（dubbed 视频均有音轨）；
 *  ②2026-09-10 实测 video_url=/output/... 死链（404，API 未挂载静态产物目录）——
 *  契约矛盾已上报，服务端修复前该函数实际恒回退本地混音，修复后零改动生效。 */
async function serverBgmMix({ httpRequest, videoPath, outPath, bgmPath, bgmVol }) {
  const boundary = '----TintinBgm' + Math.random().toString(16).substring(2)
  const parts = []
  const filePart = (name, filePath, ctype) => {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${path.basename(filePath).replace(/"/g, '')}"\r\nContent-Type: ${ctype}\r\n\r\n`))
    parts.push(fs.readFileSync(filePath))
    parts.push(Buffer.from('\r\n'))
  }
  filePart('file', videoPath, 'video/mp4')
  filePart('bgm', bgmPath, 'audio/mpeg')
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="bgm_volume"\r\n\r\n${Number(bgmVol).toFixed(2)}\r\n`))
  parts.push(Buffer.from(`--${boundary}--\r\n`))
  const res = await httpRequest('POST', '/montage/bgm', {
    body: Buffer.concat(parts),
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    timeout: 600000,
  })
  const r = res.data
  if (!r || !r.ok || !r.video_url) throw new Error('服务端混音未返回产物地址')
  const url = String(r.video_url).startsWith('/') ? String(r.video_url) : '/' + String(r.video_url)
  const dl = await httpRequest('GET', url, { timeout: 300000 })
  const buf = Buffer.from(dl.raw || '')
  if (!buf.length) throw new Error('服务端混音产物为空')
  fs.writeFileSync(outPath, buf)
  if (!(getMediaDuration(outPath) > 0)) {
    try { fs.unlinkSync(outPath) } catch (_) { /* 忽略 */ }
    throw new Error('服务端混音产物无法读取（moov 缺失/截断）')
  }
}

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
      // 服务端统一合成特效烧制：2026-09-10 在线实测单镜头约束已放开（单 files 提交
      // 200 clip_count:1，字幕烧制抽帧验证生效，产物 moov 完整）→ 渲染层服务端模式
      // 传 serverFx===true 时启用 serverFxBurnOne；失败自动回退本地 ffmpeg
      // （字幕动画仅本地链路支持，服务端 subtitle_style 契约只有 box_opacity；
      // 渲染层在字幕动画开启时已直接选本地，此回退为网络/服务端异常兑底）。
      // 已验证：files×2 提交 200 产物 6s 字幕正确；单 files 提交 200 产物 1s 字幕正确。
      const useServerFx = p.serverFx === true && typeof httpRequest === 'function'
      const hasFx = !!(fx && (fx.addSubtitles || fx.fancyText || fx.textFxEnabled) && subTexts.length)
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
          // fxOut 与最终成品同目录（final/），该目录在混音阶段才创建；ffmpeg 不会
          // 自动建输出目录，缺失时报 "No such file or directory"（2026-09-10 实锤根因：
          // 新任务首次合成必炸，两条链路共用此烧制前置）→ 烧制前先建目录
          fs.mkdirSync(path.dirname(fxOut), { recursive: true })
          // 服务端统一合成优先；失败回退本地 ffmpeg（字幕动画仅本地链路支持，
          // 服务端 subtitle_style 契约只有 box_opacity，无动画/预设色板字段）
          if (useServerFx) {
            try {
              await serverFxBurnOne({
                httpRequest, videoPath: t.videoPath,
                fxOut, fx, sub, videoDur,
              })
              fxPaths.set(t.videoPath, fxOut)
              continue
            } catch (e) {
              console.warn(`[final:mix] 服务端特效烧制失败，回退本地: ${e.message}`)
              try { if (fs.existsSync(fxOut)) fs.unlinkSync(fxOut) } catch (_) { /* 忽略 */ }
            }
          }
          const args = L.buildEffectBurnArgs({
            videoPath: t.videoPath,
            outputVideoPath: fxOut,
            text: String(sub.text || ''),
            timing,
            videoDur,
            videoIdx: i, // 样式轮换序号（与效果预览 (视频序+句序) 同口径）
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
            // 文字模板关键词（2026-09-10 用户裁决：本地合成同烧；词表+模板样式由渲染层传；
            // textFxCount=每视频随机选 N 个（随机样式模式），漏传会导致全量轮换）
            textFxWords: Array.isArray(fx.textTemplateWords) ? fx.textTemplateWords : [],
            textFxStyles: Array.isArray(fx.textFxStyles) ? fx.textFxStyles : [],
            textFxCount: Number(fx.textFxCount) || 0,
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
      // 2026-09-10 用户裁决：主按钮「统一合成」混音走服务端 /montage/bgm（mixMode
      // 缺省 server）；「本地合成」按钮传 mixMode='local' 全本地。特效烧制两端一致
      // 走本地 ffmpeg（服务端 concat ≥2 镜头约束收不了单视频，实测 400）。服务端
      // 混音失败自动回退本地。
      const serverMix = p.mixMode !== 'local' && typeof httpRequest === 'function' && hasBgm

      const results = []
      const total = tasks.length
      for (let index = 0; index < total; index++) {
        const { videoPath, outPath } = tasks[index]
        const srcVideo = fxPaths.get(videoPath) || videoPath
        emit(`正在进行最终合成配乐 (${index + 1}/${total})...`, mixBase + Math.floor(index / total * mixSpan))
        fs.mkdirSync(path.dirname(outPath), { recursive: true })

        // 服务端混音优先（仅 BGM 环节；失败回退本地 ffmpeg）
        if (serverMix) {
          try {
            await serverBgmMix({
              httpRequest, videoPath: srcVideo, outPath,
              bgmPath: p.bgmPath, bgmVol,
            })
            const fxTmpS = fxPaths.get(videoPath)
            if (fxTmpS) { try { fs.unlinkSync(fxTmpS) } catch (_) { /* 忽略 */ } }
            results.push(outPath)
            continue
          } catch (e) {
            console.warn(`[final:mix] 服务端混音失败，回退本地: ${e.message}`)
            try { if (fs.existsSync(outPath)) fs.unlinkSync(outPath) } catch (_) { /* 忽略 */ }
          }
        }

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

  // ── final:readTiming — 读句级时间轴 timing.json（2026-09-10 用户裁决：文字模板
  //  效果预览按视频分行时间轴，关键词需真实时间点；纯本地文件读取，结构对照
  //  buildSrtFromTiming 输入：[{text, start秒, end秒}]）──
  ipcMain.handle('final:readTiming', async (_e, payload) => {
    try {
      const timingPath = String((payload || {}).timingPath || '')
      if (!timingPath) return { items: [] }
      const raw = JSON.parse(fs.readFileSync(timingPath, 'utf-8'))
      const items = (Array.isArray(raw) ? raw : [])
        .filter((t) => t && t.text)
        .map((t) => ({ text: String(t.text).trim(), start: Number(t.start ?? 0), end: Number(t.end ?? 0) }))
      return { items }
    } catch (err) {
      return { items: [], error: err.message }
    }
  })

  // ── final:listResults — 回扫 final 目录已合成成片（2026-09-10 用户报障修复：
  //  刷新/重启后 finalDone=false 三按钮全禁用，「一键导出到剪映」点击无反应；
  //  排除 .fx. 烧制中间产物，名称排序与合成序号一致）──
  ipcMain.handle('final:listResults', async (_e, payload) => {
    try {
      const dirPath = String((payload || {}).dirPath || '')
      if (!dirPath || !fs.existsSync(dirPath)) return { files: [] }
      const files = fs.readdirSync(dirPath)
        .filter((f) => VIDEO_EXTS.has(path.extname(f).toLowerCase()) && !f.includes('.fx.'))
        .sort()
        .map((f) => path.join(dirPath, f))
      return { files, outDir: dirPath }
    } catch (err) {
      return { files: [], error: err.message }
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
            fxWords: p.fxWords,
            fxKinds: p.fxKinds,
            draftName: p.draftName,
            deps,
          })
        : JY.exportToDraft({
            videoPath: p.videoPath,
            bgmPath: p.bgmPath,
            bgmVolume: Number(p.bgmVolume) || 50,
            srtPath: p.srtPath,
            fxWords: p.fxWords,
            fxKinds: p.fxKinds,
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

module.exports = {
  createMontageFinalIpc, getOutFinalDir, getOutMontageDir, findSrtForVideo,
  buildSrtFromTiming, buildServerFxFields,
}
