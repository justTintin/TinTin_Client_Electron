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

const { spawn, spawnSync, execSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const JY = require('./jianying-exporter')
// 特效烧制（2026-09-09 裁决：字幕/花字特效自配音链迁 Step4 统一烧制，
// 与配音链同一构建器 voice-tts-logic.buildEffectBurnArgs 保证样式/时机一致）
const L = require('./voice-tts-logic')
const FT = require('./fancy-templates')
const VI = require('./montage-voice-ipc')
const JT = require('./jianying-templates')
const { logInfo } = require('./logger')

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

/** ffprobe 不可用时懒加载 ffmpeg-gate 的 stderr 解析器（该模块顶层 require('electron')，
 *  直接顶部依赖会让 node --test 下的纯函数单测加载失败；拿不到则视为无兜底）。 */
function parseFfmpegInfoLazy(stderr) {
  try { return require('./ffmpeg-gate').parseFfmpegInfo(stderr) } catch (_) { return null }
}

/** ffprobe 探测（时长/宽高/帧率，供剪映导出 _probe_video + 服务端合成回传源规格）。
 *  fps 必需：/montage/concat 不传 width/height/fps 时按契约默认值 1080x1920@30
 *  强制改写产物（2026-09-11 实测：源 720x1280@25 → 产物 1080x1920@30）。
 *  打包环境 resources/bin 不带 ffprobe.exe（仅 ffmpeg.exe/yt-dlp.exe）→ 回退
 *  ffmpeg -i stderr 解析，否则正式包回传不了源规格、产物被服务端硬改竖屏 30 帧。 */
function probeMedia(filepath) {
  let durationSec = 0.0
  let width = 1080
  let height = 1920
  let fps = 0
  try {
    const out = execSync(
      `"${getFfprobePath()}" -v error -show_entries format=duration -of csv=p=0 "${filepath}"`,
      { timeout: 10000, windowsHide: true, encoding: 'utf-8' },
    ).trim()
    if (out) durationSec = parseFloat(out) || 0.0
  } catch (_) { /* 原版失败返回 0 */ }
  try {
    const out = execSync(
      `"${getFfprobePath()}" -v error -select_streams v:0 -show_entries stream=width,height,r_frame_rate -of csv=p=0 "${filepath}"`,
      { timeout: 10000, windowsHide: true, encoding: 'utf-8' },
    ).trim()
    const first = String(out).split(/\r?\n/).find((s) => s.trim())
    if (first) {
      const parts = first.split(',')
      if (parts.length >= 2) {
        width = Math.round(parseFloat(parts[0])) || 1080
        height = Math.round(parseFloat(parts[1])) || 1920
      }
      // r_frame_rate 形如 "25/1"；可变帧率给 "0/0" → 按 0 处理（不回传，交服务端默认）
      if (parts.length >= 3) {
        const [n, d] = String(parts[2]).split('/').map((x) => parseFloat(x))
        if (n > 0 && d > 0) fps = Math.round(n / d)
      }
    }
  } catch (_) { /* 交给下方 ffmpeg 兜底 */ }
  if (!durationSec || !fps) {
    const fb = probeMediaViaFfmpeg(filepath)
    if (fb) {
      if (!durationSec) durationSec = fb.durationSec || 0.0
      if (fb.width > 0 && fb.height > 0) { width = fb.width; height = fb.height }
      if (!fps) fps = fb.fps || 0
    }
  }
  return { durationSec, width, height, fps }
}

/** ffmpeg -i stderr 兜底探测（无 ffprobe 环境）：同步取 stderr 后交 ffmpeg-gate 解析器；
 *  失败返回 null 由调用方沿用默认值。fps 取整（服务端契约 integer）。 */
function probeMediaViaFfmpeg(filepath) {
  try {
    const r = spawnSync(getFfmpegPath(), ['-hide_banner', '-i', filepath], {
      timeout: 10000, windowsHide: true, encoding: 'utf-8',
    })
    const parsed = parseFfmpegInfoLazy(String(r.stderr || ''))
    if (!parsed || !(parsed.width > 0)) return null
    return {
      durationSec: parsed.duration || 0,
      width: parsed.width,
      height: parsed.height,
      fps: parsed.fps > 0 ? Math.round(parsed.fps) : 0,
    }
  } catch (_) {
    return null
  }
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
 *  buildSubtitleLines 同口径，供服务端统一合成 subtitle_srt 字段；cue 间空行分隔） */
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
  // cue 之间必须空行分隔（标准 SRT；2026-09-11 服务端实测教训：单 \n 连接时
  // 严格解析器把整段 SRT 当 1 条 cue——文本塞满编号/时间戳行，行级命中退化
  // 为整片一个动画，#914 命中事件「1 条 cue」即此因）
  return lines
    .map((l, i) => `${i + 1}\n${ts(starts[i])} --> ${ts(Math.max(starts[i] + 0.2, ends[i]))}\n${l}`)
    .join('\n\n')
}

/** 特效配置 → 服务端统一合成表单字段（口径对照服务端 /guide「镜头拼接」V-FANCY-3）：
 *  · 字幕文本（subtitle_srt）= 烧字幕/花字/文字模板的共同数据源 → 任一特效开启即传；
 *    burn_subtitle 只决定「是否把字幕烧进画面」，与传不传字幕数据无关
 *    （/guide：花字 subtitle_sync 与文字模板命中均「需同任务字幕」，命中在合成
 *    请求内做、服务端不保存待命中的字幕 → 必须随请求带全）；
 *  · 2026-09-11 用户裁决：不再传本地提取的词表（text_template_words）——关键词
 *    命中由服务端自行完成（常用关键词∪内置卖点词；不足由 LLM 从字幕行补足，
 *    text_template_match_llm 默认开）；客户端也不再预传词表到 /text_templates/keywords；
 *  · match 模式必填 text_template_match_ids（客户端模板池，命中行从池中随机选一），
 *    漏传则服务端无池可用（/guide 决策1/11）。 */
function buildServerFxFields(fx, srt) {
  const fields = {}
  // 字幕数据随任一依赖字幕的特效下发（不依赖 burn_subtitle 开关）
  if (srt && (fx.addSubtitles || fx.fancyText || fx.textFxEnabled)) {
    fields.subtitle_srt = srt
  }
  if (fx.addSubtitles) {
    fields.burn_subtitle = 'true'
    // 客户端字体下拉的 value 就是服务端字体 id（fontOptions 由 GET /config/fonts
    // 构建，items.push({ label, value: fid })）→ 走契约 font_id 字段；
    // fontname 仅适用于真字体族名场景，本端不传（旧实现把 id 当族名传错）
    if (fx.subtitleFont) fields.font_id = String(fx.subtitleFont)
    const op = Math.min(1, Math.max(0, Number(fx.subtitleBoxOpacity ?? 0.5)))
    fields.subtitle_style = JSON.stringify({ box_opacity: Number.isFinite(op) ? op : 0.5 })
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
      // 随机样式（未指定模板）→ 服务端关键词命中模式（match 优先）
      fields.text_template_match_enabled = 'true'
      // match 必填：客户端模板池（/guide text_template_match_ids）
      if (Array.isArray(fx.textTemplateMatchIds) && fx.textTemplateMatchIds.length) {
        fields.text_template_match_ids = JSON.stringify(fx.textTemplateMatchIds.map((x) => String(x)))
      }
    }
    const md = String(fx.matchDensity || '').trim().toLowerCase()
    if (md === 'low' || md === 'mid' || md === 'high') fields.text_template_match_density = md
  }
  return fields
}

/** multipart 组装（主视频 files 字段 + 文本字段 + 可选附加文件（BGM）；boundary 随机） */
function buildFxMultipart(fields, filePath, extraFiles) {
  const boundary = '----TintinFx' + Math.random().toString(16).substring(2)
  const parts = []
  for (const [k, v] of Object.entries(fields || {})) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`))
  }
  const filePart = (name, fp, ctype) => {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${path.basename(fp).replace(/"/g, '')}"\r\nContent-Type: ${ctype}\r\n\r\n`))
    parts.push(fs.readFileSync(fp))
    parts.push(Buffer.from('\r\n'))
  }
  filePart('files', filePath, 'video/mp4')
  for (const ef of (extraFiles || [])) filePart(ef.name, ef.path, ef.ctype)
  parts.push(Buffer.from(`--${boundary}--\r\n`))
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` }
}

/** 音频上传 ctype 按扩展名映射（BGM/voice；未知扩展名兜底 audio/mpeg）。
 *  2026-09-11 修正：旧实现固定 audio/mpeg，wav/m4a 等 BGM 会传错 MIME。 */
function audioCtype(filePath) {
  const ext = path.extname(String(filePath || '')).toLowerCase()
  if (ext === '.wav') return 'audio/wav'
  if (ext === '.m4a' || ext === '.mp4') return 'audio/mp4'
  if (ext === '.aac') return 'audio/aac'
  if (ext === '.flac') return 'audio/flac'
  if (ext === '.ogg' || ext === '.opus') return 'audio/ogg'
  return 'audio/mpeg'
}

/** 服务端统一合成（单视频，2026-09-11 用户终裁：点「服务端合成」= 特效烧制 + BGM
 *  混音全部由服务端一次 /montage/concat 调用完成）：提交 → 轮询
 *  /montage/concat/result/{id} → 落盘 outPath → 校验。
 *  在线实测依据（192.168.111.31:8000，2026-09-11）：
 *   - 单镜头约束已放开（单 files 提交 200 clip_count:1，id 880/881/886/887/888）；
 *   - concat 自带 bgm/bgm_volume 字段：静音素材（mean -91dB）+ BGM 提交后产物
 *     mean -32.5dB → BGM 确被混入；不传 bgm 时源音轨直通（-21.1dB）；
 *   - 不传 width/height/fps 会被契约默认值 1080x1920@30 强制改写产物（实测源
 *     720x1280@25 → 产物 1080x1920@30）→ 必须回传源规格；回传后产物保持 720x1280@25；
 *   - 不走 /montage/bgm：该端点 video_url=/output/... 实测 404（API 未挂静态目录），
 *     而 concat 产物经 result 端点下载可用。
 *  任一环节失败抛错（终裁：调用方直接报错给用户，不回退本地——回退会使两按钮语义失真）。
 *  产物校验防两处实测坑：未就绪 200+0B 空体、就绪产物截断 moov 缺失。
 *  配音轨（2026-09-11 统一合成契约提案③）：口播 wav 随 concat voice 字段上传 +
 *  voice_mode=replace（替换原声；契约默认同值，显式固定）；不再本地预热 dub 产物。 */
async function serverComposeOne({ httpRequest, videoPath, outPath, fx, sub, videoDur, spec, bgmPath, bgmVol }) {
  let fields = {}
  if (fx && sub) {
    let timing = null
    try {
      const sidecar = String(sub.timingPath || '')
      if (sidecar && fs.existsSync(sidecar)) {
        const arr = JSON.parse(fs.readFileSync(sidecar, 'utf-8'))
        if (Array.isArray(arr) && arr.length && arr.every((x) => x && x.text)) timing = arr
      }
    } catch (_) { timing = null }
    fields = buildServerFxFields(fx, buildSrtFromTiming(sub.text, timing, videoDur))
  }
  // 回传源规格：否则服务端按默认 1080x1920@30 改写产物（实测坑）
  if (spec && spec.width > 0 && spec.height > 0) {
    fields.width = String(spec.width)
    fields.height = String(spec.height)
  }
  if (spec && spec.fps > 0) fields.fps = String(spec.fps)
  const extraFiles = []
  if (bgmPath && fs.existsSync(bgmPath)) {
    // bgm_volume 契约值域 0~1（默认 0.6）：客户端 UI 0-200 → 系数 0-2.0，clamp 到
    // [0,1]；0 是合法值（静音），不能用 `|| 0.6` 回退（2026-09-11 修正）
    const vol = Number(bgmVol)
    fields.bgm_volume = (Number.isFinite(vol) ? Math.min(1, Math.max(0, vol)) : 0.6).toFixed(2)
    extraFiles.push({ name: 'bgm', path: bgmPath, ctype: audioCtype(bgmPath) })
  }
  // 配音轨（契约提案③）：voice 文件 + voice_mode=replace；无配音/文件缺失的视频
  // 不带 voice 直通（与本地链路「无 wav 不替换原声」同语义）
  const voicePath = String((sub && sub.voicePath) || '')
  if (voicePath && fs.existsSync(voicePath)) {
    fields.voice_mode = 'replace'
    extraFiles.push({ name: 'voice', path: voicePath, ctype: audioCtype(voicePath) })
  }
  const { body, contentType } = buildFxMultipart(fields, videoPath, extraFiles)
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
  fs.writeFileSync(outPath, buf)
  const dur = getMediaDuration(outPath)
  if (!(dur > 0)) {
    try { fs.unlinkSync(outPath) } catch (_) { /* 忽略 */ }
    throw new Error('服务端合成产物无法读取（moov 缺失/截断）')
  }
  return dur
}

function createMontageFinalIpc(ipcMain, { httpRequest, isExpectedOfflineError, getServerUrl }) {

  // ── final:mix — 最终合成（特效烧制 + BGM 混音）──
  // tasks: [{videoPath, outPath}]；bgmPath/bgmVolume(0-200)；进度经 progressChannel 推送。
  // 2026-09-09 裁决扩展：payload 可带 effects（字幕/花字配置）+ subtitleTexts
  // （[{videoPath, text, timingPath}]，渲染层已按候选视频映射好文案）。
  // 2026-09-11 终裁：mixMode 决定链路——'server'（缺省）整条交服务端一次 concat 完成
  // （特效 + 混音，失败报错不回退）；'local' 逐视频本地 ffmpeg 烧制到中间文件再混音。
  ipcMain.handle('final:mix', async (event, payload) => {
    try {
      const p = payload || {}
      const tasks = Array.isArray(p.tasks) ? p.tasks : []
      if (!tasks.length) throw new Error('final:mix requires tasks[]')
      const channel = p.progressChannel || ''
      // extra（2026-09-12）：donePath=逐条完成事件随带成片路径，渲染层增量上表
      // （此前列表只在整批返回后填充，合成期间已落盘的成片不可见）
      const emit = (stage, value, extra) => { if (channel) event.sender.send(channel, { stage, value, ...(extra || {}) }) }

      const ffmpegPath = getFfmpegPath()
      const hasBgm = !!(p.bgmPath && fs.existsSync(p.bgmPath))
      const bgmVol = (Number(p.bgmVolume) || 0) / 100.0

      // ── 特效/混音链路裁决（2026-09-11 用户终裁：按钮决定链路，开了哪些特效、
      // 是否选 BGM 都只是参数）──
      // 「服务端合成」：特效烧制 + BGM 混音由服务端一次 /montage/concat 完成；
      // 「本地合成」（mixMode='local'）：全部本地 ffmpeg。
      // 服务端链路失败直接报错，不静默回退本地（回退会让两按钮语义失真）。
      // 注：字幕动画（fade/rise/slide/pop）服务端无字段 → 服务端产物不生效（仅本地有意义），
      // 但不再因此默默改走本地链路。
      const fx = p.effects || null
      const subTexts = Array.isArray(p.subtitleTexts) ? p.subtitleTexts : []
      const serverMode = p.mixMode !== 'local' && typeof httpRequest === 'function'
      const hasFx = !!(fx && (fx.addSubtitles || fx.fancyText || fx.textFxEnabled) && subTexts.length)
      // 配音轨（2026-09-11 voice 接线）：服务端链路 voice 随 concat 上传；本地链路
      // 的配音已在 dubVideos 阶段替换进视频，不消费 voicePath
      const hasVoice = subTexts.some((s) => s && s.voicePath && fs.existsSync(String(s.voicePath)))
      // 无特效且无 BGM 且无配音：没有任何处理要做，本地 -c copy 直通即可（走服务端
      // 只会无谓重编一遍）；只要有参数就整条交给服务端。
      const doServer = serverMode && (hasFx || hasBgm || hasVoice)
      let fontPathEsc = ''
      let fancyFontPath = ''
      let fancyTemplate = null
      let fancySoundPath = ''
      let fancySoundGainDb = -6.0
      if (hasFx && !doServer) {
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

      const fxPaths = new Map() // videoPath → 特效烧制中间文件（仅本地链路）
      if (hasFx && !doServer) {
        for (let i = 0; i < tasks.length; i++) {
          const t = tasks[i]
          const sub = subTexts.find((s) => s.videoPath === t.videoPath)
          if (!sub || !String(sub.text || '').trim()) {
            // 跳过留痕（2026-09-11 文字模板动画排查教训：静默 continue 无迹可查）
            try { logInfo('final-mix', `特效烧制跳过（无匹配文案行）: ${path.basename(t.videoPath)}`) } catch (_) {}
            continue
          }
          emit(`正在烧制字幕/花字特效 (${i + 1}/${tasks.length})...`, Math.floor(i / tasks.length * 55))
          // 文字模板命中行/样式池计数留痕：为 0 时仅勾文字模板的视频会整块直通（排查入口）
          try {
            logInfo('final-mix', `特效烧制 #${i + 1} ${path.basename(t.videoPath)}: textFxHits=${Array.isArray(sub.fxLines) ? sub.fxLines.length : 0} textFxStyles=${Array.isArray(fx.textFxStyles) ? fx.textFxStyles.length : 0} sub=${!!fx.addSubtitles} fancy=${!!fx.fancyText}`)
          } catch (_) {}
          const videoDur = getMediaDuration(t.videoPath)
          if (videoDur <= 0) {
            try { logInfo('final-mix', `特效烧制跳过（时长不可读）: ${path.basename(t.videoPath)}`) } catch (_) {}
            continue // 时长读不出 → 无法定位时间轴，跳过烧制直通混音
          }
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
          // R3 方案A：jy_ 前缀文字模板 → 本地装饰图标解析（R2 公式，分辨率无关占比）；
          // 仅存在 jy_ 样式时才探测画布尺寸，避免多余 ffprobe
          let videoW = 0, videoH = 0
          let stylesForBurn = Array.isArray(fx.textFxStyles) ? fx.textFxStyles : []
          try {
            if (stylesForBurn.some((s) => s && String(s.templateId || '').startsWith('jy_'))) {
              const dims = probeMedia(t.videoPath)
              videoW = dims.width; videoH = dims.height
              const presetDir = path.join(process.env.LOCALAPPDATA || '', 'JianyingPro', 'User Data', 'Presets', 'Text_V2')
              stylesForBurn = stylesForBurn.map((s) => {
                const tid = String((s && s.templateId) || '')
                if (!tid.startsWith('jy_')) return s
                try { return { ...s, decorations: L.buildTextTemplateDecorations(presetDir, tid.slice(3), videoW, videoH) } } catch (_) { return s }
              })
            }
          } catch (decoErr) {
            try { logInfo('final-mix', '装饰图标解析失败（降级纯文字）: ' + (decoErr && decoErr.message || decoErr)) } catch (_) {}
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
            // 文字模板命中行（2026-09-11 用户裁决：本地烧制与服务端 /text_templates/match
            // 命中同源——渲染层按合成口径预取命中行（fxLines）随 payload 下发；
            // 离线/未取到 → 空（不烧，与预览空轨口径一致；不再本地提取卖点词，
            // 旧实现在无卖点词文案上提取为空会导致文字模板整块不烧））
            textFxHits: Array.isArray(sub.fxLines) ? sub.fxLines : [],
            // textFxCount=每视频随机选 N 个（随机样式模式），漏传会导致全量轮换
            textFxStyles: stylesForBurn,
            videoW: videoW,
            videoH: videoH,
            textFxCount: Number(fx.textFxCount) || 0,
          })
          if (!args) {
            try { logInfo('final-mix', `特效烧制直通（构建器判定无可烧特效，多为命中行/样式池为空）: ${path.basename(t.videoPath)}`) } catch (_) {}
            continue // 无特效可烧（构建器判定）→ 直通
          }
          const r = await runFfmpeg(args)
          if (r.code !== 0) {
            throw new Error(`字幕/花字特效烧制失败：\n${r.stderr || '(无输出)'}`)
          }
          fxPaths.set(t.videoPath, fxOut)
        }
      }

      // 进度分段：本地链路有特效烧制时烧制占 0-55、混音占 60-100；无特效保持 0-100；
      // 服务端链路一次调用完成全部处理，按条均分 0-95
      const mixBase = hasFx && !doServer ? 60 : 0
      const mixSpan = hasFx && !doServer ? 40 : 100

      const results = []
      const total = tasks.length
      for (let index = 0; index < total; index++) {
        const { videoPath, outPath } = tasks[index]
        fs.mkdirSync(path.dirname(outPath), { recursive: true })

        // 服务端统一合成（特效烧制 + BGM 混音一次 concat；终裁：失败直接报错不回退）
        if (doServer) {
          emit(`服务端统一合成 (${index + 1}/${total})...`, Math.floor(index / total * 95))
          const spec = probeMedia(videoPath)
          // sub 无条件查找（2026-09-11 voice 接线）：仅配音/仅 BGM 的视频也需带 voicePath 提交
          const sub = subTexts.find((s) => s.videoPath === videoPath) || null
          // 该视频无配套文案（如未配音的排列视频）或时长读不出（无法定位时间轴）
          // → 不传特效字段，仅按参数做 BGM 混音或配音替换（与本地链路「直通」同语义）
          const fxForTask = (hasFx && sub && String(sub.text || '').trim() && spec.durationSec > 0) ? fx : null
          try {
            await serverComposeOne({
              httpRequest, videoPath, outPath,
              fx: fxForTask, sub,
              videoDur: spec.durationSec, spec,
              bgmPath: hasBgm ? p.bgmPath : '', bgmVol,
            })
            results.push(outPath)
            // 逐条完成即推送（渲染层增量上表，不等整批返回）
            emit(`服务端统一合成完成 (${index + 1}/${total})...`, Math.floor((index + 1) / total * 95), { donePath: outPath })
            continue
          } catch (e) {
            try { if (fs.existsSync(outPath)) fs.unlinkSync(outPath) } catch (_) { /* 忽略 */ }
            throw new Error(`服务端合成失败（第 ${index + 1}/${total} 条）：${e.message}\n如需本地合成请改点「本地合成」`)
          }
        }

        const srcVideo = fxPaths.get(videoPath) || videoPath
        emit(`正在进行最终合成配乐 (${index + 1}/${total})...`, mixBase + Math.floor(index / total * mixSpan))

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
        // 逐条完成即推送（渲染层增量上表，不等整批返回）
        emit(`最终合成完成 (${index + 1}/${total})...`, mixBase + Math.floor((index + 1) / total * mixSpan), { donePath: outPath })
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
            // M2a：文字入场动画/花字效果随剪映导出（textAnim=入场动画名，fancyEffectId/tplEffectId=花字效果 id）
            textAnim: p.textAnim,
            fancyEffectId: p.fancyEffectId,
            tplEffectId: p.tplEffectId,
            // 二期②：字幕轨入场动画（本地语义 key，导出器映射剪映动画名）
            subAnim: p.subAnim,
            // 二期④：视频特效（resource_id）挂主轨全片段
            videoEffectId: p.videoEffectId,
            videoEffectName: p.videoEffectName,
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
            textAnim: p.textAnim,
            fancyEffectId: p.fancyEffectId,
            tplEffectId: p.tplEffectId,
            subAnim: p.subAnim,
            videoEffectId: p.videoEffectId,
            videoEffectName: p.videoEffectName,
            draftName: p.draftName,
            deps,
          })
      // M1：首页索引登记 + 封面（2026-09-12 实测：登记后剪映首页免刷新可见；失败不阻断导出）
      if (res && res.success) {
        try {
          const firstVideo = (Array.isArray(p.videoPaths) && p.videoPaths[0]) || p.videoPath || ''
          let durUs = 0
          for (const vp of (Array.isArray(p.videoPaths) && p.videoPaths.length ? p.videoPaths : [firstVideo])) {
            durUs += Math.round((probeMedia(vp).durationSec || 0) * 1e6)
          }
          let cover = ''
          try {
            cover = path.join(res.message, 'draft_cover.jpg')
            const r = spawnSync(getFfmpegPath(), ['-y', '-ss', '1', '-i', firstVideo, '-frames:v', '1', '-q:v', '3', cover], { timeout: 15000, windowsHide: true })
            if (r.status !== 0 || !fs.existsSync(cover)) cover = ''
          } catch (_) { cover = '' }
          const reg = JY.registerInRootMeta({ draftFolder: res.message, draftName: res.draftName || p.draftName || path.basename(res.message), durationUs: durUs, coverPath: cover })
          res.registered = reg.ok
        } catch (regErr) {
          try { logInfo('jianying-export', '首页索引登记失败（不影响草稿本身）: ' + (regErr && regErr.message || regErr)) } catch (_) {}
        }
      }
      return res
    } catch (err) {
      return { success: false, message: err.message }
    }
  })

  // ── jytpl:list — 剪映模板卡片数据源（§0.0 单一数据源：主数据=服务端模板库；
  //    localAvailable=本机剪映可同步预设清单，仅供「从剪映同步」弹窗使用）──
  ipcMain.handle('jytpl:list', async () => {
    try {
      // 1) 主数据：服务端模板库（分组按剪映语义：花字库=有效果引用非「文字模板」类目；文字模板=类目含「文字模板」）
      const res = await httpRequest('GET', '/text_templates/templates', { timeout: 10000 })
      const data = res && res.data
      const list = Array.isArray(data) ? data : (Array.isArray(data?.items) ? data.items : [])
      const fancy = [], tpl = []
      for (const t of list) {
        const vars = t.variables || {}
        const sig = String((vars.animSignature && vars.animSignature.default) || '')
        const desc = String(t.description || '')
        const isTpl = /类目:.*文字模板/.test(desc) || /文字模板/.test(String(t.category || ''))
        const item = {
          id: String(t.id), name: String(t.name || t.id),
          color: String((vars.color && vars.color.default) || '#FFFFFF'),
          text: String((vars.text && vars.text.default) || t.name || ''),
          anim: String((vars.anim && vars.anim.default) || '') || (sig ? '' : 'fade'),
          animSignature: sig,
          category: String(t.category || ''),
          preview: String(t.preview || ''),
          previewWebm: String(t.preview_webm || ''),
          synced: true,
        }
        ;(isTpl ? tpl : fancy).push(item)
      }
      // 2) 本机可同步清单（弹窗用；不作为卡片数据源）
      const jyRoot = path.join(process.env.LOCALAPPDATA || '', 'JianyingPro', 'User Data')
      const local = JT.scanTextPresets(path.join(jyRoot, 'Presets', 'Text_V2'))
      const serverIds = new Set(list.map((t) => String(t.id)))
      const localItems = [...local.textItems, ...local.tplItems].map((it) => ({
        ...it,
        serverId: 'jy_' + it.effectId,
        syncedToServer: serverIds.has('jy_' + it.effectId),
      }))
      return { ok: true, serverUrl: getServerUrl(), serverTemplates: { 花字库: fancy, 文字模板: tpl }, localAvailable: localItems }
    } catch (err) {
      return { error: err.message }
    }
  })

  // ── jytpl:sync — 批量同步选中模板到服务端（打包+上传；§0.0 同步目标即服务端）──
  ipcMain.handle('jytpl:sync', async (_e, payload) => {
    const ids = Array.isArray((payload || {}).ids) ? payload.ids : []
    if (!ids.length) return { error: '未选择模板' }
    const presetDir = path.join(process.env.LOCALAPPDATA || '', 'JianyingPro', 'User Data', 'Presets', 'Text_V2')
    const outDir = path.join(process.env.TEMP || process.env.LOCALAPPDATA, 'tintin-jytpl-sync')
    fs.mkdirSync(outDir, { recursive: true })
    const { execFileSync } = require('node:child_process')
    const results = []
    for (const id of ids) {
      try {
        const built = JT.buildSyncPackage(presetDir, String(id))
        if (!built) throw new Error('未找到该预设或无有效效果资源')
        const dir = path.join(outDir, String(id))
        fs.rmSync(dir, { recursive: true, force: true })
        fs.mkdirSync(dir, { recursive: true })
        fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(built.meta, null, 1))
        fs.writeFileSync(path.join(dir, 'template.html'), built.html)
        const zip = path.join(outDir, String(id) + '.zip')
        fs.rmSync(zip, { force: true })
        execFileSync('powershell', ['-NoProfile', '-Command', `Push-Location '${dir}'; Compress-Archive -Force -Path '.\\*' -DestinationPath '${zip}'; Pop-Location`], { stdio: 'pipe' })
        // multipart 组装（文件根级在 zip 内；直接传 zip 文件）
        const boundary = '----TinTinJySync' + Date.now()
        const zbuf = fs.readFileSync(zip)
        const body = Buffer.concat([
          Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${String(id)}.zip"\r\nContent-Type: application/zip\r\n\r\n`),
          zbuf,
          Buffer.from(`\r\n--${boundary}--\r\n`),
        ])
        const up = await httpRequest('POST', '/text_templates/templates', {
          body,
          headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary },
          timeout: 60000,
        }).catch((e) => ({ error: e.message }))
        if (up && up.error) throw new Error(up.error)
        const txt = Buffer.from(up.raw || '').toString('utf-8')
        if (!txt.includes('"ok":true')) throw new Error(txt.slice(0, 80))
        results.push({ id, ok: true, name: built.meta.name })
      } catch (e) {
        results.push({ id, ok: false, error: String(e.message).slice(0, 80) })
      }
    }
    return { ok: true, results }
  })

  // ── jytpl:deleteServer — 从服务端模板库删除（jy_<rid>）──
  ipcMain.handle('jytpl:deleteServer', async (_e, payload) => {
    const ids = Array.isArray((payload || {}).ids) ? payload.ids : []
    if (!ids.length) return { error: '未选择模板' }
    const results = []
    for (const id of ids) {
      try {
        await httpRequest('DELETE', '/text_templates/templates/' + encodeURIComponent(String(id)), { timeout: 15000 })
        results.push({ id, ok: true })
      } catch (e) {
        results.push({ id, ok: false, error: String(e.message).slice(0, 80) })
      }
    }
    return { ok: true, results }
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
  buildSrtFromTiming, buildServerFxFields, buildFxMultipart, serverComposeOne, probeMedia,
}
