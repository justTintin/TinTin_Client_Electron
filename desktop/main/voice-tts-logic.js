// ═══════════════════════════════════════════════════════════════
// voice-tts-logic.js — 智能混剪 Step3「口播配音」纯函数层（主进程 CJS，可被单测 require）
// 双源对照（原客户端 studio/gui/montage/）：
//   · gui/montage/workers/voice_workers.py   VoiceCloneWorker L74-417
//     （_preprocess_tts_text/_split_sentences/_concat_wav_bytes/_wav_bytes_duration/
//      _synthesize_item/run 变速口径/_health_url）
//   · utils/voxcpm_client.py                 repair_wav_bytes L19-45
//   · gui/montage/workers/concat_workers.py  VideoDubbingWorker L768-1035
//     （字幕 drawtext/花字/tpad/atempo 链/编码参数）
//   · gui/montage/workers/script_workers.py  BatchAITextRewriteWorker L449-493
//     （改写 system prompt 四档 + markdown/引号清洗）
//   · gui/video_montage_page.py              _get_out_montage_dir L3969-3981 /
//     fancy_words 解析 L3726-3730
// 契约（API 口径，禁止臆造）：POST /voxcpm/tts
//   body = {"text": 预处理后, "prompt_audio": base64|null, "speaker": "default"}
//   api 模式下 inference_timesteps/cfg_value 存而不用（原版同口径，不发送服务端）。
// 架构差异注明：
//   · 原版 wave 模块 → 此处手写 WAV PCM 帧解析/拼接（同假设：段间参数一致帧拼接）
//   · 原版 get_video_encode_args 硬件探测 → 对齐 ffmpeg-gate.js 先例统一 libx264
// ═══════════════════════════════════════════════════════════════

'use strict'

// ── TTS 文本预处理（voice_workers.py L74-138 逐行移植）──────────────
// 解决："8000 DPI"→"八千 D P I"；"LIGHTSPEED"逐字母；"Type-C"→"Type C"

const CN_DIGITS = '零一二三四五六七八九'
const KEEP_UNITS = new Set(['Hz', 'MHz', 'GHz', 'kHz'])

/** 整数 → 中文（含 万/亿，口「一十」省略首「一」，十位对齐原版 L87-108） */
function intToCn(n) {
  if (n === 0) return '零'
  const units = [
    [100000000, '亿'], [10000, '万'],
    [1000, '千'], [100, '百'], [10, '十'], [1, ''],
  ]
  let result = ''
  let needZero = false
  for (const [val, name] of units) {
    const d = Math.floor(n / val)
    n %= val
    if (d) {
      if (needZero) { result += '零'; needZero = false }
      if (!(val === 10 && d === 1 && !result)) result += CN_DIGITS[d]
      result += name
    } else if (result) {
      needZero = true
    }
  }
  return result
}

function preprocessTtsText(text) {
  let t = String(text ?? '')
  // Python \b 为 Unicode 词边界（中文属 \w）：中文紧贴数字时边界不成立、不转换。
  // JS \b 是 ASCII 口径，需用 lookaround + \p{L}\p{N}_ 等价模拟（u flag）。
  const PY_B_L = '(?<![\\p{L}\\p{N}_])'
  const PY_B_R = '(?![\\p{L}\\p{N}_])'
  // 1. 小数 x.y → 中文x点中文y；再整数 → 中文（原版 L125-126 顺序）
  t = t.replace(new RegExp(`${PY_B_L}(\\d+)\\.(\\d+)${PY_B_R}`, 'gu'), (_m, a, b) => {
    try { return `${intToCn(parseInt(a, 10))}点${intToCn(parseInt(b, 10))}` } catch (_) { return _m }
  })
  t = t.replace(new RegExp(`${PY_B_L}\\d+${PY_B_R}`, 'gu'), (m) => {
    try { return intToCn(parseInt(m, 10)) } catch (_) { return m }
  })
  // 2. 全大写英文缩写（≥2 字母）→ 字母间加空格；保留 Hz/MHz/GHz/kHz（L129-133）
  t = t.replace(new RegExp(`${PY_B_L}[A-Z]{2,}${PY_B_R}`, 'gu'), (w) => (KEEP_UNITS.has(w) ? w : w.split('').join(' ')))
  // 3. 英文连字符 → 空格（L136）
  t = t.replace(/([A-Za-z])-([A-Za-z])/g, '$1 $2')
  return t
}

// ── 文案切句（voice_workers.py L190-204 逐行移植）──────────────────
// 按行拆分后以句末标点切分，过滤只含标点/符号的片段（保留含中英数字的可朗读片段）

function splitSentences(text) {
  const segs = []
  for (const rawLine of String(text || '').split('\n')) {
    const line = rawLine.trim()
    if (!line) continue
    // JS 无 lookbehind 定长限制（Node ≥10 均支持），与原版 re.split(r"(?<=…)") 同口径
    for (const part of line.split(/(?<=[。！？!?；;…])/)) {
      const p = part.trim()
      if (p) segs.push(p)
    }
  }
  return segs.filter((s) => /[一-鿿A-Za-z0-9]/.test(s))
}

// ── 变速比计算（voice_workers.py run L371-380 口径）────────────────
// 差异 ≤2% 不调；ratio=aud/vid clamp [speedMin, speedMax]；|clamped-1|≤0.005 不调。
// 返回 {should, ratio}；should=true 时以 ratio 做 ffmpeg atempo（时间轴缩放 1/ratio）。

function computeSpeedAdjust(vidDur, audDur, speedMin, speedMax) {
  if (!(vidDur > 0) || !(audDur > 0)) return { should: false, ratio: 1 }
  if (Math.abs(vidDur - audDur) / vidDur <= 0.02) return { should: false, ratio: 1 }
  const raw = audDur / vidDur
  const clamped = Math.max(speedMin, Math.min(speedMax, raw))
  if (Math.abs(clamped - 1.0) <= 0.005) return { should: false, ratio: clamped }
  return { should: true, ratio: clamped }
}

// ── WAV 字节层（voxcpm_client repair_wav_bytes + voice_workers L206-243）──────
// PCM 假设同原版 wave 模块：data 帧逐段拼接，句间按参数插入零静音。

/** 修复 WAV RIFF/data 头：声明的 data 长度小于实际字节时重写（防尾部裁断），正常原样返回 */
function repairWavBytes(buf) {
  try {
    if (!buf || buf.length < 12) return buf
    if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return buf
    let pos = 12
    while (pos + 8 <= buf.length) {
      const cid = buf.toString('ascii', pos, pos + 4)
      const size = buf.readUInt32LE(pos + 4)
      if (cid === 'data') {
        const declared = size
        const actual = buf.length - (pos + 8)
        if (actual > declared) {
          const out = Buffer.from(buf)
          out.writeUInt32LE(actual, pos + 4)
          out.writeUInt32LE(out.length - 8, 4)
          return out
        }
        return buf
      }
      pos += 8 + size + (size & 1)
    }
  } catch (_) { /* 头异常按原样返回（同原版 except 兜底） */ }
  return buf
}

/** 解析 WAV：返回 {params:{framerate,sampwidth,nchannels}, frames}（PCM data 帧字节） */
function parseWav(buf) {
  if (!buf || buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF') {
    throw new Error('无法读取音频参数')
  }
  let pos = 12
  let fmt = null
  while (pos + 8 <= buf.length) {
    const cid = buf.toString('ascii', pos, pos + 4)
    const size = buf.readUInt32LE(pos + 4)
    if (cid === 'fmt ') {
      fmt = {
        audioFormat: buf.readUInt16LE(pos + 8),
        nchannels: buf.readUInt16LE(pos + 10),
        framerate: buf.readUInt32LE(pos + 12),
        sampwidth: Math.max(1, buf.readUInt16LE(pos + 22) / 8),
      }
    } else if (cid === 'data') {
      if (!fmt) throw new Error('无法读取音频参数')
      return { params: fmt, frames: buf.subarray(pos + 8, pos + 8 + size) }
    }
    pos += 8 + size + (size & 1)
  }
  throw new Error('无法读取音频参数')
}

/** wav 字节时长（秒）＝ data 帧数 / 采样率（对照 _wav_bytes_duration L236-243） */
function wavBytesDuration(buf) {
  const { params, frames } = parseWav(buf)
  const fr = params.framerate || 1
  return frames.length / (fr * params.nchannels * params.sampwidth)
}

/** 多段 wav 帧级拼接为单段（句间 gap_sec 静音；参数取第一段；对照 _concat_wav_bytes L206-234） */
function concatWavBuffers(wavList, gapSec = 0.15) {
  if (!Array.isArray(wavList) || wavList.length === 0) {
    throw new Error('没有可拼接的音频片段')
  }
  const first = parseWav(wavList[0])
  const { framerate, nchannels, sampwidth, audioFormat } = first.params
  const byteRate = framerate * nchannels * sampwidth
  const chunks = [first.frames]
  const nsil = Math.floor(gapSec * framerate)
  const sil = nsil > 0 ? Buffer.alloc(nsil * nchannels * sampwidth) : null
  for (let i = 1; i < wavList.length; i++) {
    const { frames } = parseWav(wavList[i])
    if (sil) chunks.push(sil)
    chunks.push(frames)
  }
  const dataLen = chunks.reduce((s, c) => s + c.length, 0)
  const header = buildWavHeader(dataLen, audioFormat, nchannels, framerate, byteRate, nchannels * sampwidth, sampwidth * 8)
  return Buffer.concat([header, ...chunks])
}

function buildWavHeader(dataLen, audioFormat, nchannels, framerate, byteRate, blockAlign, bits) {
  const h = Buffer.alloc(44)
  h.write('RIFF', 0, 'ascii')
  h.writeUInt32LE(36 + dataLen, 4)
  h.write('WAVE', 8, 'ascii')
  h.write('fmt ', 12, 'ascii')
  h.writeUInt32LE(16, 16)
  h.writeUInt16LE(audioFormat, 20)
  h.writeUInt16LE(nchannels, 22)
  h.writeUInt32LE(framerate, 24)
  h.writeUInt32LE(byteRate, 28)
  h.writeUInt16LE(blockAlign, 32)
  h.writeUInt16LE(bits, 34)
  h.write('data', 36, 'ascii')
  h.writeUInt32LE(dataLen, 40)
  return h
}

// ── 健康检查地址推导（voice_workers.py _health_url L41-55）─────────
// /v1/tts、/tts 结尾 → 换 /health；否则 scheme://host:port + /health

function deriveHealthUrl(apiUrl) {
  try {
    const u = String(apiUrl || '')
    for (const suffix of ['/v1/tts', '/tts']) {
      if (u.endsWith(suffix)) return u.slice(0, -suffix.length) + '/health'
    }
    const p = new URL(u)
    if (p.protocol && p.host) return `${p.protocol}//${p.host}/health`
  } catch (_) { /* 原版 try/except 同口径返回 null */ }
  return null
}

// ── 整体合成回退时间轴（voice_workers.py _synthesize_item L304-328）──────
// 多句回退时整段音频内按字数比例分配句时间（比无时间轴强）

function buildFallbackTiming(segs, totalDur) {
  const charCounts = segs.map((s) => Math.max(1, s.length))
  const totalChars = charCounts.reduce((a, b) => a + b, 0)
  const timing = []
  let cursor = 0
  segs.forEach((s, i) => {
    const d = totalDur * charCounts[i] / totalChars
    timing.push({ text: s, start: Math.round(cursor * 1000) / 1000, end: Math.round((cursor + d) * 1000) / 1000 })
    cursor += d
  })
  return timing
}

// ── AI 改写（script_workers.py BatchAITextRewriteWorker L449-493 逐字移植）──────

/** 自由度百分比 → temperature（原版 1.0 - pct/100） */
function rewriteTemperature(pct) {
  return 1.0 - (pct / 100.0)
}

/** system prompt 四档指令（对照 L449-475 逐字） */
function buildAiRewriteSystemPrompt(temperature) {
  const freedomPct = Math.round((1.0 - temperature) * 100)
  let rewriteInstruction
  if (freedomPct >= 80) {
    rewriteInstruction = '请对用户提供的文案进行最小幅度的润色，尽量保持原文字词和句式不变，只修正明显的语病或不通顺之处。'
  } else if (freedomPct >= 50) {
    rewriteInstruction = '请对用户提供的文案进行较大幅度的改写和润色，可以使用不同的表达方式和词汇，使其更朗朗上口、更生动、更有网感，但必须保留原有的核心意思。'
  } else if (freedomPct >= 20) {
    rewriteInstruction = '请对用户提供的文案进行大幅改写和重构，显著改变表达方式和句式结构，大胆使用新词汇，大幅提升感染力和传播力，只保留最核心的主题不变。'
  } else {
    rewriteInstruction = '请对用户提供的文案进行彻底的重写和创作，完全抛弃原文的用词和句式，用全新的、极具冲击力的方式表达核心意思，最大化网感和爆款潜力。'
  }
  return (
    '你是一个顶尖的短视频脚本与广告文案改写、润色与重构专家。\n'
    + rewriteInstruction + '\n'
    + '要求：\n'
    + '1. 如果用户提供了多行文案，请对每一行分别进行改写优化，并保持与原行一一对应的行数。\n'
    + '2. 每行改写后的文案控制在15-35字之间。\n'
    + '3. 请直接返回改写后的纯文本（保持多行格式，每行对应原输入的一行），千万不要返回任何多余的解释、问候、序号或包裹符号（不要有markdown的引文框）！'
  )
}

/** 改写结果清洗：剥 markdown 代码块 + 引号包裹（对照 L481-493 逐行） */
function cleanRewriteContent(content) {
  let c = String(content || '')
  if (c.startsWith('```')) {
    const lines = c.split('\n')
    if (lines[0].startsWith('```')) lines.shift()
    if (lines.length && lines[lines.length - 1].startsWith('```')) lines.pop()
    c = lines.join('\n').trim()
  }
  if ((c.startsWith('"') && c.endsWith('"')) || (c.startsWith("'") && c.endsWith("'"))) {
    c = c.slice(1, -1).trim()
  }
  if ((c.startsWith('“') && c.endsWith('”')) || (c.startsWith('‘') && c.endsWith('’'))) {
    c = c.slice(1, -1).trim()
  }
  return c
}

// ── 花字（controller L3726-3730 + VideoDubbingWorker L929-971）────────

/** 花字输入解析：全角逗号归一后按半角逗号拆分、去空白项（对照 L3726-3730 逐行） */
function parseFancyWords(raw) {
  const r = String(raw || '').trim()
  if (!r) return []
  return r.replace(/，/g, ',').split(',').map((w) => w.trim()).filter((w) => w)
}

/** 花字样式预设：fontcolor + 描边 + 阴影（对照 L937-945 逐字） */
const FANCY_STYLES = {
  gold:          'fontcolor=0xF0C040:borderw=4:bordercolor=0x6B3000:shadowx=2:shadowy=2:shadowcolor=0x000000@0.8',
  red:           'fontcolor=0xFF4040:borderw=4:bordercolor=0x800000:shadowx=2:shadowy=2:shadowcolor=0x000000@0.8',
  blue:          'fontcolor=0x40A0FF:borderw=4:bordercolor=0x003080:shadowx=2:shadowy=2:shadowcolor=0x000000@0.8',
  purple:        'fontcolor=0xC060FF:borderw=4:bordercolor=0x300060:shadowx=2:shadowy=2:shadowcolor=0x000000@0.8',
  neon_green:    'fontcolor=0x40FF80:borderw=3:bordercolor=0x004020:shadowx=3:shadowy=3:shadowcolor=0x00FF80@0.5',
  white_outline: 'fontcolor=white:borderw=5:bordercolor=black:shadowx=2:shadowy=2:shadowcolor=0x000000@0.6',
  yellow_red:    'fontcolor=0xFFFF00:borderw=5:bordercolor=0xCC0000:shadowx=2:shadowy=2:shadowcolor=0x000000@0.8',
}

/** drawtext 文本转义（对照 L915 逐字：\\ → \\\\ 、' 、: 、, ） */
function escapeDrawText(s) {
  return String(s)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "'\\''")
    .replace(/:/g, '\\:')
    .replace(/,/g, '\\,')
}

// ── 输出目录推导（controller _get_out_montage_dir L3969-3981 逐行移植）──────
// 输入目录本身是 outputs → 原样；位于 outputs/ 内 → 取该 outputs；否则 <父目录>/outputs

function resolveOutMontageDir(dirPath) {
  const abs = String(dirPath || '').replace(/\//g, '\\').replace(/\\+$/, '')
  if (/\\outputs$/i.test(abs)) return abs
  const idx = (abs + '\\').toLowerCase().indexOf('\\outputs\\')
  if (idx >= 0) return abs.slice(0, idx) + '\\outputs'
  const parent = abs.slice(0, Math.max(abs.lastIndexOf('\\'), 0))
  return parent + '\\outputs'
}

// ── 配音替换 ffmpeg 链（VideoDubbingWorker L843-1019 逐行移植）────────

/** atempo 链拆解（对照 L974-985：>2 逐级 ÷2，<0.5 乘 0.5，余差 >0.001 才补一段） */
function buildAtempoChain(ratio) {
  const parts = []
  let remaining = ratio
  while (remaining > 2.0) { parts.push('atempo=2.0'); remaining /= 2.0 }
  if (remaining < 0.5) { parts.push('atempo=0.5'); remaining /= 0.5 }
  if (Math.abs(remaining - 1.0) > 0.001) parts.push(`atempo=${remaining.toFixed(4)}`)
  return parts
}

/** 字体路径解析纯逻辑（对照 _resolve_subtitle_font_path L768-785；fileExists 注入便于测试） */
function resolveSubtitleFontPath(family, fileExists) {
  if (family) {
    const p = fileExists.familyPath || ''
    if (p) return p.replace(/\\/g, '/').replace(/:/g, '\\:')
  }
  for (const cand of ['C:/Windows/Fonts/msyh.ttc', 'C:/Windows/Fonts/msyh.ttf']) {
    if (fileExists.path(cand)) return cand.replace(/:/g, '\\:')
  }
  return 'msyh'
}

/** 字幕行时间轴（对照 L876-908：优先 .timing.json 真实句级，回退按字数比例估算） */
function buildSubtitleLines({ timing, text, displayDur, needAudioSpeed, videoDur, audioDur }) {
  let rawLines, lineStarts, lineEnds
  if (Array.isArray(timing) && timing.length && timing.every((t) => t && t.text)) {
    rawLines = timing.map((t) => String(t.text).trim())
    lineStarts = timing.map((t) => Number(t.start ?? 0))
    lineEnds = timing.map((t) => Number(t.end ?? 0))
    if (needAudioSpeed && audioDur > 0) {
      const fScale = videoDur / audioDur
      lineStarts = lineStarts.map((s) => s * fScale)
      lineEnds = lineEnds.map((e) => e * fScale)
    }
    if (displayDur > 0) lineEnds = lineEnds.map((e) => Math.min(e, displayDur))
  } else {
    rawLines = String(text || '').trim().split('\n').map((l) => l.trim()).filter(Boolean)
    if (!rawLines.length) rawLines = [String(text || '').trim()]
    const charCounts = rawLines.map((l) => Math.max(1, l.length))
    const totalChars = charCounts.reduce((a, b) => a + b, 0)
    let cumT = 0
    lineStarts = []
    lineEnds = []
    for (const c of charCounts) {
      const t0 = cumT
      const t1 = cumT + (displayDur > 0 ? displayDur * c / totalChars : 5.0)
      lineStarts.push(t0)
      lineEnds.push(t1)
      cumT = t1
    }
  }
  return { rawLines, lineStarts, lineEnds }
}

/**
 * 构建配音替换完整 ffmpeg 参数（对照 run L843-1019；不含 ffmpeg 可执行路径前缀）。
 * opts: { videoPath, voiceWavPath, outputVideoPath, text, addSubtitles, lengthMode,
 *         videoDur, audioDur, timing, fancyText, fancyStyle, fancyWords,
 *         subtitleFontPath(已转义), }
 * 编码：对齐 ffmpeg-gate.js 先例（原版 get_video_encode_args 硬件探测 → libx264）
 */
function buildDubFFmpegArgs(opts) {
  const o = opts || {}
  const lengthMode = o.lengthMode || 'video'
  const videoDur = Number(o.videoDur || 0)
  const audioDur = Number(o.audioDur || 0)
  const useAudioLength = lengthMode === 'audio' && audioDur > videoDur && videoDur > 0
  const extraDur = useAudioLength ? audioDur - videoDur : 0
  const displayDur = useAudioLength ? audioDur : videoDur
  const needAudioSpeed = !useAudioLength && audioDur > videoDur && videoDur > 0

  const videoFilters = []
  let videoLabel = '0:v'
  let audioLabel = '1:a:0'

  if (useAudioLength) {
    videoFilters.push(`[${videoLabel}]tpad=stop_mode=clone:stop_duration=${extraDur.toFixed(3)}[v_padded]`)
    videoLabel = 'v_padded'
  }

  if (o.addSubtitles && o.text) {
    const fontPath = o.subtitleFontPath || 'msyh'
    const { rawLines, lineStarts, lineEnds } = buildSubtitleLines({
      timing: o.timing, text: o.text, displayDur, needAudioSpeed, videoDur, audioDur,
    })
    const drawtexts = rawLines.map((lineText, i) => {
      const escaped = escapeDrawText(lineText)
      return (
        `drawtext=fontfile='${fontPath}':`
        + `text='${escaped}':`
        + 'fontsize=h*0.025:fontcolor=white:'
        + 'box=1:boxcolor=black@0.5:boxborderw=6:'
        + 'x=(w-text_w)/2:y=h-text_h-h*0.06:'
        + `enable='between(t,${lineStarts[i].toFixed(3)},${lineEnds[i].toFixed(3)})'`
      )
    })
    videoFilters.push(`[${videoLabel}]${drawtexts.join(',')}[v]`)
    videoLabel = 'v'
  }

  const fancyWords = Array.isArray(o.fancyWords) ? o.fancyWords : []
  if (o.fancyText && fancyWords.length && displayDur > 0) {
    const styleStr = FANCY_STYLES[o.fancyStyle] || FANCY_STYLES.gold
    const segDur = displayDur / fancyWords.length
    const fancyDrawtexts = []
    fancyWords.forEach((word, wi) => {
      const w = String(word).trim()
      if (!w) return
      const ftStart = wi * segDur
      const ftEnd = Math.min((wi + 1) * segDur, displayDur)
      const escaped = escapeDrawText(w)
      fancyDrawtexts.push(
        `drawtext=fontfile='${o.fancyFontPath || 'C\\:/Windows/Fonts/msyhbd.ttc'}':`
        + `text='${escaped}':`
        + `fontsize=h*0.08:${styleStr}:`
        + 'x=(w-text_w)/2:y=h*0.3:'
        + `enable='between(t,${ftStart.toFixed(3)},${ftEnd.toFixed(3)})'`,
      )
    })
    if (fancyDrawtexts.length) {
      videoFilters.push(`[${videoLabel}]${fancyDrawtexts.join(',')}[vf]`)
      videoLabel = 'vf'
    }
  }

  if (needAudioSpeed) {
    const parts = buildAtempoChain(audioDur / videoDur)
    if (parts.length) {
      videoFilters.push(`[${audioLabel}]${parts.join(',')}[a]`)
      audioLabel = 'a'
      if (videoFilters.length === 1) {
        // 仅变速无视频滤镜：需占位视频直通，filter_complex 才能 map 双流（L993-995）
        videoFilters.unshift(`[0:v]null[v0]`)
        videoLabel = 'v0'
      }
    }
  }

  if (videoFilters.length) {
    const filterComplex = videoFilters.join(';')
    const audioMap = audioLabel === 'a' ? '[a]' : audioLabel
    const cmd = [
      '-y', '-i', o.videoPath,
      '-i', o.voiceWavPath,
      '-filter_complex', filterComplex,
      '-map', `[${videoLabel}]`, '-map', audioMap,
      '-c:v', 'libx264', '-crf', '23', '-preset', 'superfast', '-c:a', 'aac',
    ]
    // 「以声音为准」严格裁剪到音频时长（L1007-1011）
    if (lengthMode === 'audio' && audioDur > 0) cmd.push('-t', audioDur.toFixed(3))
    cmd.push(o.outputVideoPath)
    return cmd
  }
  return [
    '-y', '-i', o.videoPath,
    '-i', o.voiceWavPath,
    '-map', '0:v:0', '-map', '1:a:0',
    '-c:v', 'copy', '-c:a', 'aac', '-shortest',
    o.outputVideoPath,
  ]
}

module.exports = {
  preprocessTtsText,
  intToCn,
  splitSentences,
  computeSpeedAdjust,
  repairWavBytes,
  parseWav,
  wavBytesDuration,
  concatWavBuffers,
  buildWavHeader,
  deriveHealthUrl,
  buildFallbackTiming,
  rewriteTemperature,
  buildAiRewriteSystemPrompt,
  cleanRewriteContent,
  parseFancyWords,
  FANCY_STYLES,
  escapeDrawText,
  resolveOutMontageDir,
  buildAtempoChain,
  resolveSubtitleFontPath,
  buildSubtitleLines,
  buildDubFFmpegArgs,
}
