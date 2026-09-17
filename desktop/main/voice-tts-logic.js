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
// 契约（API 口径，禁止臆造）：POST /indextts/tts（2026-09-05 服务端将删 /voxcpm/*，随声音克隆
//   裁决统一切 IndexTTS）：body = {"text": 预处理后, "prompt_audio": base64|null}（无 speaker），
//   响应 WAV 二进制。
//   api 模式下 inference_timesteps/cfg_value 存而不用（原版同口径，不发送服务端）。
// 架构差异注明：
//   · 原版 wave 模块 → 此处手写 WAV PCM 帧解析/拼接（同假设：段间参数一致帧拼接）
//   · 原版 get_video_encode_args 硬件探测 → 对齐 ffmpeg-gate.js 先例统一 libx264
// ═══════════════════════════════════════════════════════════════

'use strict'

// R3 方案A（2026-09-12）：文字模板装饰图标 overlay 需要 fs/path（扫描本地
// textpreset/缓存 PNG）。仍为主进程纯函数层：仅内置模块，可单测，不碰 electron。
const fs = require('node:fs')
const path = require('node:path')

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
  // 0. 读音标注（voice_workers.py 2026-09-07 新增第 0 步，PR#4 条目9）：
  //    数字/字母串(中文读音) → 整体替换为读法，在数字转中文之前。
  //    例：「555(三五)电池」→ TTS 读「三五电池」；字幕/花字侧由
  //    stripPronAnnotation 剥括号显示原文「555电池」。
  //    仅当括号前紧贴字母/数字串时才识别，避免误伤普通括号注释。
  t = t.replace(/([0-9A-Za-z][0-9A-Za-z.]*)\(([\u4e00-\u9fa5A-Za-z0-9]{1,12})\)/g, '$2')
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

/** 字幕文字样式预设（2026-09-09 用户裁决：样式属字幕配置，图3 色系 ~24 格）。
 *  key 与渲染层 SUBTITLE_STYLE_PRESETS（videoMontageLogic.ts）一一对应，
 *  两表同步维护：本表为 drawtext 片段，渲染层表为色板 UI 元数据。 */
const SUBTITLE_STYLES = {
  white:        'fontcolor=white',
  white_blk:    'fontcolor=0xFFFFFF:borderw=3:bordercolor=0x000000',
  white_gray:   'fontcolor=0xFFFFFF:borderw=3:bordercolor=0x555555',
  white_red:    'fontcolor=0xFFFFFF:borderw=3:bordercolor=0xCC2222',
  white_blue:   'fontcolor=0xFFFFFF:borderw=3:bordercolor=0x2266CC',
  black_white:  'fontcolor=0x111111:borderw=3:bordercolor=0xFFFFFF',
  black_yellow: 'fontcolor=0x111111:borderw=3:bordercolor=0xFFD700',
  yellow_blk:   'fontcolor=0xFFE135:borderw=3:bordercolor=0x000000',
  yellow_red:   'fontcolor=0xFFE135:borderw=3:bordercolor=0xCC0000',
  gold_blk:     'fontcolor=0xF0C040:borderw=3:bordercolor=0x3A2000',
  gold_red:     'fontcolor=0xF0C040:borderw=3:bordercolor=0xCC0000',
  orange_white: 'fontcolor=0xFF8C1A:borderw=3:bordercolor=0xFFFFFF',
  pink_blk:     'fontcolor=0xFF7EB9:borderw=3:bordercolor=0x000000',
  pink_white:   'fontcolor=0xFF7EB9:borderw=3:bordercolor=0xFFFFFF',
  red_white:    'fontcolor=0xFF4040:borderw=3:bordercolor=0xFFFFFF',
  red_yellow:   'fontcolor=0xFF4040:borderw=3:bordercolor=0xFFE135',
  blue_blk:     'fontcolor=0x40A0FF:borderw=3:bordercolor=0x000000',
  blue_white:   'fontcolor=0x40A0FF:borderw=3:bordercolor=0xFFFFFF',
  sky_white:    'fontcolor=0x7FD4FF:borderw=3:bordercolor=0xFFFFFF',
  green_blk:    'fontcolor=0x40FF80:borderw=3:bordercolor=0x000000',
  green_white:  'fontcolor=0x40FF80:borderw=3:bordercolor=0xFFFFFF',
  teal_white:   'fontcolor=0x2EC4B6:borderw=3:bordercolor=0xFFFFFF',
  purple_white: 'fontcolor=0xC060FF:borderw=3:bordercolor=0xFFFFFF',
  purple_blk:   'fontcolor=0xC060FF:borderw=3:bordercolor=0x000000',
}

/** drawtext 文本转义（对照 L915 逐字：\\ → \\\\ 、' 、: 、, ） */

/** 服务端字幕样式 → drawtext 片段（2026-09-17 用户裁决：字幕样式统一来自服务端
 *  /subtitle_styles 库，不再用本地 SUBTITLE_STYLES 硬编码表）。
 *  映射：color→fontcolor, outline→borderw, outline_colour→bordercolor；
 *  box（"color@opacity"）→ box=1:boxcolor=color@opacity:boxborderw=6。 */
function serverStyleToDrawtext(style) {
  if (!style || typeof style !== 'object') return 'fontcolor=white'
  const parts = []
  // 文字色
  const color = String(style.color || 'white').trim()
  parts.push('fontcolor=' + (color.startsWith('#') ? color.replace('#', '0x') : color))
  // 描边
  const outline = Number(style.outline) || 0
  if (outline > 0) {
    parts.push('borderw=' + Math.min(outline, 20))
    const oc = String(style.outline_colour || 'black').trim()
    parts.push('bordercolor=' + (oc.startsWith('#') ? oc.replace('#', '0x') : oc))
  }
  // 背景框（box="color@opacity" 或 "color"）
  if (style.box) {
    const boxStr = String(style.box)
    const atIdx = boxStr.lastIndexOf('@')
    if (atIdx > 0) {
      const boxColor = boxStr.slice(0, atIdx)
      const boxOpacity = boxStr.slice(atIdx + 1)
      const bc = boxColor.startsWith('#') ? boxColor.replace('#', '0x') : boxColor
      parts.push('box=1:boxcolor=' + bc + '@' + boxOpacity + ':boxborderw=6')
    } else {
      const bc = boxStr.startsWith('#') ? boxStr.replace('#', '0x') : boxStr
      parts.push('box=1:boxcolor=' + bc + ':boxborderw=6')
    }
  }
  return parts.join(':')
}
/** 剥读音标注括号（concat_workers.py _strip_pron_annotation 逐行移植）：
 * 555(三五)电池 → 555电池；仅括号前紧贴字母/数字时识别。字幕/花字显示原文。 */
const SUB_PRON_RE = /(?<=[0-9A-Za-z])\([^()]{1,12}\)/g
function stripPronAnnotation(text) {
  return String(text || '').replace(SUB_PRON_RE, '')
}

function escapeDrawText(s) {
  return String(s)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "'\\''")
    .replace(/:/g, '\:')
    .replace(/,/g, '\,')
}

// ── 剪映安全框与花字（concat_workers.py 2026-09-07 PR#4 新口径逐行移植）──────
// 所有花字/字幕必须落在剪映竖屏(9:16)默认安全框内，避免被平台 UI 遮挡：
// 左右各约 8% 宽、顶部约 8% 高、底部约 10% 高（底部更大，避开抖音交互区）。
const SAFE_X = 0.08
const SAFE_TOP = 0.08
const SAFE_BOTTOM = 0.10
// 字幕：字号相对高度 + 底边距安全框下沿 2%（整体上移）
const SUB_FONT_SCALE = 0.035
const SUB_BOTTOM_GAP = 0.02
// 字幕自动折行：单行超 SUB_MAX_LINE_WEIGHT 等效字（中文=1、ASCII≈0.55）
// 按配音时间窗切段依次显示（均衡断点，优先在空格/标点处断开）
const SUB_MAX_LINE_WEIGHT = 13.0
const SUB_ASCII_WEIGHT = 0.55
const SUB_BREAK_CHARS = new Set('，。！？、；：,.!?;: \t')
const SAFE_X_EXPR = `w*${SAFE_X}`
const SAFE_TOP_EXPR = `h*${SAFE_TOP}`
const SAFE_BOTTOM_EDGE = `h*(1-${SAFE_BOTTOM})`
const SAFE_BOTTOM_ANCHOR = `${SAFE_BOTTOM_EDGE}-text_h-h*${SUB_BOTTOM_GAP}`

// 花字出现位置 → drawtext x/y 表达式（fontsize=h*0.08）。
// 全部落在剪映安全框内（对照 concat_workers.py FANCY_POSITIONS L54-63 逐字）。
const FANCY_POSITIONS = {
  upper_middle: { label: '中上', x: '(w-text_w)/2', y: 'h*0.3' },
  top: { label: '顶部居中', x: '(w-text_w)/2', y: SAFE_TOP_EXPR },
  center: { label: '画面正中', x: '(w-text_w)/2', y: '(h-text_h)/2' },
  bottom: { label: '底部居中', x: '(w-text_w)/2', y: SAFE_BOTTOM_ANCHOR },
  top_left: { label: '左上角', x: SAFE_X_EXPR, y: SAFE_TOP_EXPR },
  top_right: { label: '右上角', x: `w-text_w-${SAFE_X_EXPR}`, y: SAFE_TOP_EXPR },
  bottom_left: { label: '左下角', x: SAFE_X_EXPR, y: SAFE_BOTTOM_ANCHOR },
  bottom_right: { label: '右下角', x: `w-text_w-${SAFE_X_EXPR}`, y: SAFE_BOTTOM_ANCHOR },
}

// 花字出现时机：跟随对应字幕行，提前 FANCY_LEAD_SEC 秒出现、该行字幕结束消失
const FANCY_LEAD_SEC = 0.3
const FANCY_MAX_LEN = 10
const FANCY_MIN_GAP_SEC = 0.05
const FANCY_MIN_DISPLAY_SEC = 0.4
const FANCY_MAX_PER_VIDEO = 3

// ── 卖点提取（花字内容自动取自口播文案，不再手动输入）──
// 优先级：价格 > 数字参数 > 关键词（对照 L79-92 正则/词表逐字）
const FANCY_PRICE_RE = /(?:仅|只要|低至|到手|券后)?\d+(?:\.\d+)?元/g
const FANCY_UNIT = ('小时|分钟|秒钟|毫安时|毫安|mAh|千克|公斤|kg|KG|Kg|千瓦|kW|毫伏|mV|'
  + '毫米|厘米|分米|英寸|千米|公里|km|cm|mm|克|瓦|伏|升|毫升|ml|mL|'
  + '赫兹|Hz|kHz|分贝|dB|℃|°C|%|％|DPI|dpi|天|周|月|年|米|寸|度|W|V|G|g|L|倍|核|轴|键|帧|级|档|声')
const FANCY_NUM_RE = new RegExp(`[\u4e00-\u9fa5A-Za-z]{0,4}\\d+(?:\\.\\d+)?(?:${FANCY_UNIT})`, 'g')
const FANCY_KEYWORDS = (
  '超轻,超薄,超长续航,超静音,大容量,快充,闪充,无线充电,'
  + '防水,防尘,降噪,折叠,便携,旗舰,爆款,新款,限量,'
  + '免打孔,免安装,持久续航,高清,巨幕,一机多用,'
  + '电量持久,电量充足,放电均衡,不易漏液,输出稳定,经久耐用,密封性,'
  + '平价').split(',')

/** 单行内提取多个卖点（按出现位置排序）：价格×n + 数字参数×n + 关键词。
 *  口播文案常为一整行（无换行），每行只取 1 个会漏掉大部分卖点；
 *  按正则 matchAll 收集行内全部命中（非重叠），区间重叠去重（价格优先），
 *  按位置排序后取前 limit 个（对照 extract_fancy_words_in_line L104-140）。 */
function extractFancyWordsInLine(lineText, limit = FANCY_MAX_PER_VIDEO) {
  const t = String(lineText || '')
  if (!t.trim()) return []
  const hits = [] // [start, end, word]
  for (const m of t.matchAll(FANCY_PRICE_RE)) {
    hits.push([m.index, m.index + m[0].length, m[0].slice(0, FANCY_MAX_LEN)])
  }
  for (const m of t.matchAll(FANCY_NUM_RE)) {
    // 与价格区间重叠（如「只要199元」同时命中参数）
    if (hits.some(([s, e]) => (s <= m.index && m.index < e) || (s < m.index + m[0].length && m.index + m[0].length <= e))) continue
    hits.push([m.index, m.index + m[0].length, m[0].slice(0, FANCY_MAX_LEN)])
  }
  const occupied = (pos) => hits.some(([s, e]) => s <= pos && pos < e)
  for (const kw of FANCY_KEYWORDS) {
    if (hits.length >= limit) break // 已凑够上限，无需再扫关键词
    let pos = t.indexOf(kw)
    while (pos !== -1) {
      if (!occupied(pos)) {
        hits.push([pos, pos + kw.length, kw])
        break
      }
      pos = t.indexOf(kw, pos + 1)
    }
  }
  hits.sort((a, b) => a[0] - b[0])
  const words = []
  for (const [, , w] of hits) {
    if (w && (words.length === 0 || words[words.length - 1] !== w)) words.push(w)
    if (words.length >= limit) break
  }
  return words
}

/** 整段文案提取卖点花字：逐行（行内多卖点），保持行序，跨行累计到 maxWords
 *  （对照 extract_fancy_words_from_text L143-156；供烧制花字事件 + 花字预览两处） */
function extractFancyWordsFromText(text, maxWords = FANCY_MAX_PER_VIDEO) {
  const words = []
  for (const line of String(text || '').split(/\r?\n/)) {
    for (const w of extractFancyWordsInLine(line, maxWords - words.length)) {
      if (w && (words.length === 0 || words[words.length - 1] !== w)) words.push(w)
      if (words.length >= maxWords) return words
    }
  }
  return words
}

/** 消解花字时间窗重叠（对照 resolve_fancy_overlaps L159-183 逐行）：
 *  按开始时间排序后，优先压缩前一花字结束时间，压不动（低于最短显示时长）丢弃后一个。
 *  仅严格交叠（s < pe）才算重叠：背靠背（s == pe）是行内多卖点依次出现的正常形态。 */
function resolveFancyOverlaps(events, minGap = FANCY_MIN_GAP_SEC, minDisplay = FANCY_MIN_DISPLAY_SEC) {
  const out = []
  for (const [word, s, e] of [...events].sort((a, b) => a[1] - b[1] || a[2] - b[2])) {
    if (out.length && s < out[out.length - 1][2]) {
      const [prevWord, ps] = out[out.length - 1]
      const newPe = Math.max(s - minGap, ps + minDisplay)
      if (newPe < out[out.length - 1][2]) out[out.length - 1] = [prevWord, ps, newPe]
      if (s < out[out.length - 1][2] + minGap) continue // 压不动（或压完仍重叠）→ 丢弃后一个，保先到的
    }
    out.push([word, s, e])
  }
  return out
}

// ── 字幕自动折行（对照 L198-309 逐行）────────────────────────────────

/** 字幕行等效宽度：中文/全角=1，ASCII/半角≈0.55 */
function subLineWeight(text) {
  let w = 0
  for (const ch of text) w += ch.codePointAt(0) < 0x2E80 ? SUB_ASCII_WEIGHT : 1.0
  return w
}

const isAsciiAlnum = (ch) => /[0-9A-Za-z]/.test(ch)
// 量词/单位字：数字后紧跟这些字时不可作为字幕分段断点（如 199|元，拆开观感割裂）
const SUB_UNIT_CHARS = new Set('元角分厘克千克吨斤两米寸升瓦伏安时天年月日号度倍颗粒枚张片支盒包瓶罐箱袋页行站次趟遍')

/** 字幕分段禁断边界：英数连续串中间、数字后紧跟量词单位 */
function badSubBoundary(chars, i) {
  const a = chars[i - 1]
  const b = chars[i]
  if (isAsciiAlnum(a) && isAsciiAlnum(b)) return true
  if (/[0-9]/.test(a) && SUB_UNIT_CHARS.has(b)) return true
  return false
}

/** 断点选择（对照 _snap_break L222-253）：
 *  1. prefer±2 内空格/标点（吸附，断点跳过分隔符）；
 *  2. prefer±3 内非英数连续串中间/不拆数字+量词的边界；
 *  3. 全行范围最近可用边界；纯英数长串（无可用边界）返回 null 由调用方硬切。 */
function snapBreak(chars, prefer, lo) {
  let best = null
  for (let i = Math.max(lo + 1, prefer - 2); i <= Math.min(chars.length - 1, prefer + 2); i++) {
    if (SUB_BREAK_CHARS.has(chars[i]) || SUB_BREAK_CHARS.has(chars[i - 1])) {
      const dist = Math.abs(i - prefer)
      if (best === null || dist < best[0]) best = [dist, i]
    }
  }
  if (best !== null) {
    let i = best[1]
    if (SUB_BREAK_CHARS.has(chars[i])) i += 1 // 断点跳过分隔符
    return i
  }
  for (let i = Math.max(lo + 1, prefer - 3); i <= Math.min(chars.length - 1, prefer + 3); i++) {
    if (!badSubBoundary(chars, i)) return i
  }
  best = null
  for (let i = lo + 1; i < chars.length; i++) {
    if (!badSubBoundary(chars, i)) {
      const dist = Math.abs(i - prefer)
      if (best === null || dist < best[0]) best = [dist, i]
    }
  }
  return best ? best[1] : null
}

/** 超长字幕行自动折行（剪映竖屏安全框内单行约容 13 个等效字）。
 *  超宽按等效宽度均衡拆多行，断点优先吸附空格/标点，不在英数串中间硬断；
 *  不超宽返回 [原行]；空行返回 []（对照 wrap_subtitle_line L256-309）。 */
function wrapSubtitleLine(lineText) {
  const text = String(lineText || '').trim()
  if (!text) return []
  const total = subLineWeight(text)
  if (total <= SUB_MAX_LINE_WEIGHT) return [text]
  // 按上限-1 计算段数：断点离散性会让某段超出均值，留 1 字余量保证吸附后仍 ≤ 上限
  const nParts = Math.max(2, Math.ceil(total / Math.max(1.0, SUB_MAX_LINE_WEIGHT - 1.0)))
  const chars = Array.from(text)
  const weights = chars.map((c) => (c.codePointAt(0) < 0x2E80 ? SUB_ASCII_WEIGHT : 1.0))
  // 每个字符之前的累计宽度（断点候选基准）
  const cumBefore = []
  let acc = 0.0
  for (const w of weights) { cumBefore.push(acc); acc += w }

  const bounds = [0]
  for (let part = 1; part < nParts; part++) {
    const target = total * part / nParts
    const lo = bounds[bounds.length - 1] + 1
    if (lo >= chars.length) break
    // 兑底：任意字符边界里离 target 最近的
    let boundary = lo
    for (let i = lo; i < chars.length; i++) {
      if (Math.abs(cumBefore[i] - target) < Math.abs(cumBefore[boundary] - target)) boundary = i
    }
    let b = boundary
    // 优先：±2 范围内的空格/标点/非英数内部断点（snapBreak）
    const snapped = snapBreak(chars, boundary, bounds[bounds.length - 1])
    if (snapped !== null && bounds[bounds.length - 1] < snapped && snapped < chars.length) b = snapped
    // 段宽约束：吸附/回退候选不得让前段超过单行上限（均衡边界天然最接近）
    const loW = cumBefore[bounds[bounds.length - 1]]
    if (cumBefore[b] - loW > SUB_MAX_LINE_WEIGHT + 1e-9 && cumBefore[boundary] - loW <= SUB_MAX_LINE_WEIGHT + 1e-9) {
      b = boundary
    }
    b = Math.min(b, chars.length - 1)
    bounds.push(b)
  }
  bounds.push(chars.length)

  const parts = []
  for (let k = 0; k < bounds.length - 1; k++) {
    const seg = chars.slice(bounds[k], bounds[k + 1]).join('').replace(/^[ ，,、]+|[ ，,、]+$/g, '')
    if (seg) parts.push(seg)
  }
  return parts.length ? parts : [text]
}

// ── 花字模板动画映射（fancy_templates.py get_fancy_anim 逐行移植）────────
// 剪映入场动画（jy_intro_anim）→ 本地通用动画：drawtext 只支持 alpha/x/y 的
// t 表达式，按语义归 4 类；未识别/空 → fade（淡入，最安全）。
const FANCY_ANIM_KEYWORDS = [
  ['滑', 'slide'], ['弹', 'pop'], ['跳', 'pop'], ['晃', 'pop'], ['摆', 'pop'],
  ['放大', 'fade'], ['吸入', 'fade'], ['折叠', 'fade'], ['打字机', 'fade'],
]
const VALID_ANIMS = new Set(['fade', 'rise', 'slide', 'pop', 'none'])

/** 模板本地入场动画类型：anim 显式优先，否则按 jy_intro_anim 语义映射。
 *  返回 fade/rise/slide/pop/none 之一；无效值回退 fade。 */
function getFancyAnim(template) {
  const t = template || {}
  const anim = String(t.anim || '').trim().toLowerCase()
  if (VALID_ANIMS.has(anim)) return anim
  const jy = String(t.jy_intro_anim || '').trim()
  if (!jy) return 'fade'
  for (const [kw, a] of FANCY_ANIM_KEYWORDS) {
    if (jy.includes(kw)) return a
  }
  return 'fade'
}

/** 花字事件构建（对照 VideoDubbingWorker.run L1263-1289 逐行）：
 *  逐字幕行提取卖点（quota 递减），跟随该行时间窗提前 FANCY_LEAD_SEC 出现；
 *  行内多卖点均分时间窗（首段保提前量）；最后统一重叠消解。 */
function buildFancyEvents({ subLines, subStarts, subEnds, displayDur, quotaMax = FANCY_MAX_PER_VIDEO }) {
  const events = []
  let quota = quotaMax
  for (let li = 0; li < subLines.length; li++) {
    if (quota <= 0) break
    const words = extractFancyWordsInLine(subLines[li], quota)
    if (!words.length) continue
    const ws = Math.max(0.0, subStarts[li] - FANCY_LEAD_SEC)
    const we = Math.max(ws + 0.2, Math.min(subEnds[li], displayDur))
    if (words.length === 1) {
      events.push([words[0], ws, we])
    } else {
      // 行内多卖点：时间窗均分依次出现（首段保持提前量）
      const seg = (we - ws) / words.length
      words.forEach((w, wi) => {
        const s = wi === 0 ? ws : ws + wi * seg
        const e = wi < words.length - 1 ? ws + (wi + 1) * seg : we
        events.push([w, s, Math.max(s + 0.2, e)])
      })
    }
    quota -= words.length
  }
  if (!events.length) return []
  return resolveFancyOverlaps(events)
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

/** 字幕行时间轴（对照 L876-908/L1178-1210：优先 .timing.json 真实句级，回退按字数比例估算；
 *  返回行文本已剠读音标注括号——字幕/花字显示原文，读法仅供 TTS） */
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
  return { rawLines: rawLines.map(stripPronAnnotation), lineStarts, lineEnds }
}

/** 字幕 drawtext 段构建（供配音链与 Step4 特效烧制共用，保证样式/时机一致；
 *  run L1218-1242 口径：背景可配/底边安全框/超长行按时间窗切段） */
function buildSubtitleDrawtextList(o, subLines, subStarts, subEnds) {
  const fontPath = o.subtitleFontPath || 'msyh'
  // 背景不透明度可配（run L1057-1060；0=无背景框）。缺省回退 20%
  // （2026-09-15 用户裁决：背景透明默认 20%，原 0.5，与 SUBTITLE_BG_OPTIONS 默认项同源）
  let boxOpacity = 0.2
  try { boxOpacity = Math.min(1.0, Math.max(0.0, Number(o.subtitleBoxOpacity))) } catch (_) { /* NaN 等 → 默认 */ }
  if (!Number.isFinite(boxOpacity)) boxOpacity = 0.2
  // 字幕样式统一来自服务端 /subtitle_styles（2026-09-17 用户裁决）：文字色/描边
  // 取服务端样式对象；背景框底色沿用样式的 box 色（缺省 black），不透明度以客户端
  // 滑块为准；无服务端样式对象（离线降级）→ 回退本地 SUBTITLE_STYLES 查表。
  const srvStyle = (o.subtitleStyleObj && typeof o.subtitleStyleObj === 'object') ? o.subtitleStyleObj : null
  let boxColor = 'black'
  if (srvStyle && srvStyle.box) {
    const rawBox = String(srvStyle.box)
    boxColor = rawBox.includes('@') ? rawBox.slice(0, rawBox.lastIndexOf('@')) : rawBox
    if (boxColor.startsWith('#')) boxColor = boxColor.replace('#', '0x')
  }
  const boxStr = boxOpacity > 0
    ? `box=1:boxcolor=${boxColor || 'black'}@${boxOpacity.toFixed(2)}:boxborderw=6:`
    : ''
  // 底边贴安全框下沿再抬 2%（run L1225）
  const yExpr = `${SAFE_BOTTOM_EDGE}-text_h-h*${SUB_BOTTOM_GAP}`
  // 文字样式片段（2026-09-17 用户裁决）：服务端样式对象（去 box，box 已由 boxStr
  // 独立控制）经 serverStyleToDrawtext 转 fontcolor/borderw/bordercolor；无服务端样式
  // 对象时回退本地 SUBTITLE_STYLES 查表（未知 key 回退默认白字，与旧版一致）
  let styleStr
  if (srvStyle) {
    const { box: _box, ...rest } = srvStyle
    styleStr = serverStyleToDrawtext(rest)
  } else {
    styleStr = SUBTITLE_STYLES[o.subtitleStyle] || SUBTITLE_STYLES.white
  }
  // 入场动画（2026-09-10 用户裁决：字幕可选动画，预览与烧制同用该选择；口径对照花字
  //  fade/rise/slide/pop，白名单复用 VALID_ANIMS；none=硬切；无效值回退 fade）
  const animRaw = String(o.subtitleAnim || '').trim().toLowerCase()
  const anim = VALID_ANIMS.has(animRaw) ? animRaw : 'fade'
  const animDur = 0.4
  const drawtexts = []
  for (let i = 0; i < subLines.length; i++) {
    const startT = subStarts[i]
    const endT = Math.max(startT + 0.2, subEnds[i])
    // 超长行不再多行堆叠：按配音时间窗把长句切多个短段依次显示（run L1218-1242）
    const parts = wrapSubtitleLine(subLines[i])
    let segs
    if (parts.length === 1) {
      segs = [[parts[0], startT, endT]]
    } else {
      // 段时长按等效字数占比切分行时间窗
      const weights = parts.map((p) => subLineWeight(p))
      const totalW = weights.reduce((a, b) => a + b, 0) || parts.length
      let cum = startT
      segs = parts.map((part, k) => {
        const segEnd = k === parts.length - 1 ? endT : cum + (endT - startT) * weights[k] / totalW
        const seg = [part, cum, segEnd]
        cum = segEnd
        return seg
      })
    }
    for (const [part, segStart, segEnd] of segs) {
      // 入场动画：alpha 淡入 + 按类型 x/y 位移（写法对照花字 fade/rise/slide/pop；
      //  drawtext 的 alpha 只作用于文字，背景框不参与动画淡入）
      const s = segStart.toFixed(3)
      const animParts = []
      let xAnim = ''
      let yAnim = ''
      if (anim === 'fade') {
        animParts.push(`alpha='if(lt(t,${s}+${animDur}),(t-${s})/${animDur},1)'`)
      } else if (anim === 'rise') {
        animParts.push(`alpha='if(lt(t,${s}+${animDur}),(t-${s})/${animDur},1)'`)
        yAnim = `(${yExpr})-(1-min((t-${s})/${animDur},1))*h*0.03`
      } else if (anim === 'slide') {
        animParts.push(`alpha='if(lt(t,${s}+${animDur}),(t-${s})/${animDur},1)'`)
        xAnim = `(w-text_w)/2+(1-min((t-${s})/${animDur},1))*w*0.10`
      } else if (anim === 'pop') {
        animParts.push(`alpha='if(lt(t,${s}+0.15),(t-${s})/0.15,1)'`)
        yAnim = `(${yExpr})-abs(sin((t-${s})*14))*h*0.012*(1-min((t-${s})/0.7,1))`
      }
      const animStr = animParts.length ? ':' + animParts.join(':') : ''
      drawtexts.push(
        `drawtext=fontfile='${fontPath}':`
        + `text='${escapeDrawText(part)}':`
        + `fontsize=h*${SUB_FONT_SCALE}:${styleStr}:`
        + boxStr
        + `x=${xAnim ? `'${xAnim}'` : '(w-text_w)/2'}:`
        + `y=${yAnim ? `'${yAnim}'` : yExpr}:`
        + `enable='between(t,${segStart.toFixed(3)},${segEnd.toFixed(3)})'`
        + animStr,
      )
    }
  }
  return drawtexts
}

/** 花字 drawtext 段 + 模板音效构建（供配音链与 Step4 特效烧制共用；run L1309-1383 口径） */
function buildFancyDrawtextList(o, fancyEvents) {
  const fontPath = o.fancyFontPath || 'C\\:/Windows/Fonts/msyhbd.ttc'
  let styleStr = FANCY_STYLES[o.fancyStyle] || FANCY_STYLES.gold
  const tpl = o.fancyTemplate && typeof o.fancyTemplate === 'object' ? o.fancyTemplate : null
  // 模板优先：选了花字模板时，样式以模板的 drawtext 串为准（run L1309-1311）
  if (tpl && tpl.style) styleStr = String(tpl.style)
  // 花字位置（run L1328）：未知值回退默认中上
  const pos = FANCY_POSITIONS[o.fancyPosition] || FANCY_POSITIONS.upper_middle
  // 入场动画：模板 jy_intro_anim 映射本地动画；未选模板时默认淡入（run L1332-1341）
  const anim = getFancyAnim(tpl)
  const animDur = 0.4
  const fancyDrawtexts = []
  const soundSpecs = [] // [音效绝对路径, 延迟ms]
  for (const [word, ftStart, ftEnd] of fancyEvents) {
    const escaped = escapeDrawText(word)
    // 动画选项：alpha 淡入 + 按类型的 x/y 位移；s=出现时刻。
    // x/y 必须成对提供（drawtext 默认 x/y=0，缺一个就跑位）
    const s = ftStart.toFixed(3)
    const animParts = []
    let xExpr = ''
    let yExpr = ''
    if (anim === 'fade') {
      animParts.push(`alpha='if(lt(t,${s}+${animDur}),(t-${s})/${animDur},1)'`)
    } else if (anim === 'rise') {
      animParts.push(`alpha='if(lt(t,${s}+${animDur}),(t-${s})/${animDur},1)'`)
      yExpr = `(${pos.y})-(1-min((t-${s})/${animDur},1))*h*0.04`
    } else if (anim === 'slide') {
      animParts.push(`alpha='if(lt(t,${s}+${animDur}),(t-${s})/${animDur},1)'`)
      xExpr = `(${pos.x})+(1-min((t-${s})/${animDur},1))*w*0.10`
    } else if (anim === 'pop') {
      animParts.push(`alpha='if(lt(t,${s}+0.15),(t-${s})/0.15,1)'`)
      yExpr = `(${pos.y})-abs(sin((t-${s})*14))*h*0.012*(1-min((t-${s})/0.7,1))`
    }
    const animStr = animParts.length ? ':' + animParts.join(':') : ''
    const xStr = xExpr ? `x='${xExpr}'` : `x=${pos.x}`
    const yStr = yExpr ? `y='${yExpr}'` : `y=${pos.y}`
    fancyDrawtexts.push(
      `drawtext=fontfile='${fontPath}':`
      + `text='${escaped}':`
      + `fontsize=h*0.08:${styleStr}:`
      + `${xStr}:${yStr}:`
      + `enable='between(t,${ftStart.toFixed(3)},${ftEnd.toFixed(3)})'`
      + animStr,
    )
    // 模板音效：每个花字出现时刻混入（路径由主进程预解析，缺失时为空 → 不混）
    if (o.fancySoundPath) soundSpecs.push([o.fancySoundPath, Math.trunc(ftStart * 1000)])
  }
  return { fancyDrawtexts, soundSpecs }
}

/**
 * 文字模板关键词 drawtext 段构建（2026-09-11 用户裁决：本地合成与服务端
 * /text_templates/match 命中同源——命中的行/词/时间一律取渲染层预取的服务端
 * 结果（预览所见即合成所做），不再本地提取卖点词、不再本地判定命中；
 * 此前 2026-09-10 版本地提取在无卖点词文案上提取为空会导致文字模板整块不烧）。
 * 渲染文案与效果预览 buildTextFxTracks 同款：命中词优先（"/" 拼接），
 * 无词行（LLM 补足/等距兜底）整行截断；样式池先按视频序确定性洗牌取随机子集
 * （textFxCount 个，随机数量对每条视频独立生效），再按 (视频序+命中行序) 轮换；
 * 动画 fade/slide/pulse/bounce/neon/shine（drawtext 能力边界：flip/flow/type 无旋转/
 * 渐变/逐字能力近似 fade，完整动画走剪映导出 appendKeywordTrack）。
 * o: { textFxStyles: Array<{color,effectColor,anim}>, textFxCount, fancyFontPath }
 * hits: Array<{ text, start, end, keywords }>（服务端 match 选中行；空 → 不烧）
 */
// 确定性种子洗牌（LCG；与渲染层 videoMontageLogic.seededShuffle 逐行同款——
// 跨端无共享模块，两边同步改，保证预览与烧制同视频同子集）
function textFxSeedShuffle(arr, seed) {
  const a = [...arr]
  let s = ((Number(seed) || 0) + 1) * 2654435761 >>> 0
  for (let i = a.length - 1; i > 0; i--) {
    s = (s * 1664525 + 1013904223) >>> 0
    const j = s % (i + 1)
    const tmp = a[i]; a[i] = a[j]; a[j] = tmp
  }
  return a
}

/**
 * 文字模板命中行 → 烧制计划（2026-09-13 用户裁决：本地合成与服务端同效果——
 * 本方案B下 plan 同时供两条消费端：drawtext 兜底烧字 / 服务端 render-preview
 * alpha 素材下载（montage-final-ipc 按 plan 逐条取素材后随 textFxClipOverlays 回传）。
 * 纯函数可单测；样式池先按视频序确定性洗牌取随机子集（textFxCount 个），
 * 再按 (视频序+命中行序) 轮换；渲染文案=关键词命中显词、无词行整行截断。
 * o: { textFxStyles, textFxCount }；hits: [{text,start,end,keywords}]
 * 返回 [{shown,start,end,style:{name,color,effectColor,anim,templateId,decorations?}}]
 */
function planTextFxHits(o, hits, videoIdx) {
  const rows = (Array.isArray(hits) ? hits : [])
    .filter((h) => h && typeof h === 'object' && String(h.text || '').trim())
  const allStyles = Array.isArray(o.textFxStyles) ? o.textFxStyles : []
  if (!rows.length || !allStyles.length) return []
  // 每视频独立随机子集（2026-09-10 用户裁决：随机数量 N 对应每条视频；
  // textFxCount<=0 或池≤1 → 全量轮换）
  const count = Number(o.textFxCount) || 0
  const styles = (count > 0 && allStyles.length > 1)
    ? textFxSeedShuffle(allStyles, Number(videoIdx) || 0).slice(0, Math.min(count, allStyles.length))
    : allStyles
  return rows.map((h, hitIdx) => {
    const kws = (Array.isArray(h.keywords) ? h.keywords : [])
      .map((k) => String(k).trim()).filter(Boolean)
    const full = String(h.text).trim()
    // 渲染文案与效果预览同款（2026-09-11 用户裁决：关键词命中显词、无词行整行截断）
    const shown = kws.length ? kws.join('/')
      : (full.length > 10 ? `${full.slice(0, 10)}…` : full)
    const startT = Math.max(0, Number(h.start) || 0)
    const endT = Math.max(startT + 0.2, Number(h.end) || 0)
    // 2026-09-13 接口对齐：hit.templateId = 服务端 match textfx_clips 的逐事件指派
    // （预览/素材/concat 三方同源），命中则优先；否则回退 (视频序+行序) 轮换
    const override = h.templateId
      ? allStyles.find((s) => String(s.templateId || '') === String(h.templateId))
      : null
    const st = override || styles[(videoIdx + hitIdx) % styles.length] // 与预览 (视频序+词序) 轮换同口径
    return { shown, start: startT, end: endT, style: st, raw: h }
  })
}

function buildTextFxDrawtextList(o, hits, videoIdx) {
  const plan = planTextFxHits(o, hits, videoIdx)
  if (!plan.length) return { drawtexts: [], overlays: [] }
  // R3 方案A：装饰图标 overlay 需要（styles[].decorations 由主进程按 R2 公式解析随行）
  const vw = Number(o.videoW) || 0
  const vh = Number(o.videoH) || 0
  const fontPath = o.fancyFontPath || 'C\\:/Windows/Fonts/msyhbd.ttc'
  const drawtexts = []
  const overlays = []
  plan.forEach((p, hitIdx) => {
    const shown = p.shown
    const st = p.style
    const color = String(st.color || '#FFFFFF').replace('#', '0x')
    const effect = String(st.effectColor || st.color || '#FFD24D').replace('#', '0x')
    const startT = p.start
    const endT = p.end
    // 2026-09-13 用户裁决：要不真实动画（render-preview alpha 素材 overlay，方案B
    // 主路径），要不只是文字——drawtext 兜底不再用表达式模拟模板动画（近似动画废止）：
    // 静态文字按命中窗口显隐（enable），颜色/描边仍按模板提炼值。
    const xExpr = '(w-text_w)/2'
    const yExpr = 'h*0.08' // 顶部居中（与花字中上/字幕底部不重叠）
    // R3 方案A：装饰图标 overlay（style.decorations：{file,cx,cy,wf,aspect,rot}，
    // cx/wf 为画布宽占比、cy 为画布高占比——R2 公式的分辨率无关形态）
    for (const d of (Array.isArray(st.decorations) ? st.decorations : [])) {
      if (!d || !d.file || !(Number(d.wf) > 0) || !vw || !vh || !(Number(d.aspect) > 0)) continue
      const w = Math.round(Number(d.wf) * vw)
      const h = Math.round(w / Number(d.aspect))
      if (w < 4 || h < 4) continue
      overlays.push({
        file: d.file, w, h,
        x: Math.round(Number(d.cx) * vw - w / 2),
        y: Math.round(Number(d.cy) * vh - h / 2),
        rot: Number(d.rot) || 0,
        start: startT, end: Math.max(startT + 0.2, endT),
      })
    }
    drawtexts.push(
      `drawtext=fontfile='${fontPath}':`
      + `text='${escapeDrawText(shown)}':`
      + `fontsize=h*0.055:fontcolor=${color}:`
      + `borderw=3:bordercolor=${effect}@0.9:`
      + `x='${xExpr}':y='${yExpr}':`
      + `enable='between(t,${startT.toFixed(3)},${endT.toFixed(3)})'`
    )
  })
  return { drawtexts, overlays }
}

/**
 * 构建 Step4 特效烧制 ffmpeg 参数（2026-09-09 用户裁决：字幕/花字特效自配音链迁至
 * 特效包装统一烧制；复用与配音链同一构建器保证样式/时机一致；无配音替换，音频 copy）。
 * opts: { videoPath, outputVideoPath, text, timing, videoDur,
 *         addSubtitles, subtitleFontPath(已转义), subtitleStyle, subtitleBoxOpacity, subtitleAnim,
 *         fancyText, fancyStyle, fancyPosition, fancyFontPath(已转义), fancyTemplate,
 *         fancySoundPath, fancySoundGainDb,
 *         textFxHits(服务端 match 选中行，2026-09-11 用户裁决本地同源),
 *         textFxStyles, textFxCount, videoIdx(样式轮换序号) }
 * 返回 null = 无特效可烧（调用方直通跳过）。
 */
function buildEffectBurnArgs(opts) {
  const o = opts || {}
  const videoDur = Number(o.videoDur || 0)
  if (!(videoDur > 0)) return null
  // 逐句时间轴：优先 .timing.json 真实句级时间轴；无则字数比例估算（与配音链同一口径）
  let subLines = []
  let subStarts = []
  let subEnds = []
  // 文字模板命中行（2026-09-11 用户裁决：本地烧制与服务端 /text_templates/match、
  // 效果预览同源；行/词/时间由渲染层预取随 payload 下发——不再本地提取卖点词，
  // 旧实现在无卖点词文案上提取为空会导致文字模板整块不烧）
  const hasTextFx = Array.isArray(o.textFxHits) && o.textFxHits.length
    && Array.isArray(o.textFxStyles) && o.textFxStyles.length
  if ((o.addSubtitles || o.fancyText) && o.text) {
    const built = buildSubtitleLines({
      timing: o.timing, text: o.text, displayDur: videoDur,
      needAudioSpeed: false, videoDur, audioDur: videoDur,
    })
    subLines = built.rawLines
    subStarts = built.lineStarts
    subEnds = built.lineEnds
  }
  const videoFilters = []
  let videoLabel = '0:v'
  let audioLabel = '0:a:0'
  const soundInputPaths = []
  // R3 方案A：文字模板装饰图标输入（编号接在音效之后；与 filter_complex 引用顺序一致）
  const overlayInputPaths = []
  if (o.addSubtitles && o.text && subLines.length) {
    const drawtexts = buildSubtitleDrawtextList(o, subLines, subStarts, subEnds)
    if (drawtexts.length) {
      videoFilters.push(`[${videoLabel}]${drawtexts.join(',')}[v]`)
      videoLabel = 'v'
    }
  }
  let fancyEvents = []
  if (o.fancyText && subLines.length && videoDur > 0) {
    fancyEvents = buildFancyEvents({ subLines, subStarts, subEnds, displayDur: videoDur })
  }
  if (o.fancyText && fancyEvents.length) {
    const { fancyDrawtexts, soundSpecs } = buildFancyDrawtextList(o, fancyEvents)
    if (fancyDrawtexts.length) {
      videoFilters.push(`[${videoLabel}]${fancyDrawtexts.join(',')}[vf]`)
      videoLabel = 'vf'
    }
    // 花字模板音效混入（adelay 对齐 + amix；有音效时音频需重编码）
    let soundGain = -6.0
    try { soundGain = Number(o.fancySoundGainDb) } catch (_) { /* 缺省 -6 */ }
    if (!Number.isFinite(soundGain)) soundGain = -6.0
    if (soundSpecs.length) {
      let nextIdx = 1 // 输入流：0=video，音效从 1 开始
      let amixIn = `[${audioLabel}]`
      soundSpecs.forEach(([sfxPath, delayMs], si) => {
        videoFilters.push(`[${nextIdx}:a]adelay=${delayMs}:all=1,volume=${soundGain.toFixed(1)}dB[s${si}]`)
        amixIn += `[s${si}]`
        soundInputPaths.push(sfxPath)
        nextIdx += 1
      })
      videoFilters.push(`${amixIn}amix=inputs=${soundSpecs.length + 1}:normalize=0:duration=longest[a_mix]`)
      audioLabel = 'a_mix'
    }
  }
  // 文字模板关键词叠加（2026-09-10 用户裁决：本地合成同烧；接在字幕/花字链尾，
  // 输出标 vtx 恒唯一；videoIdx 供样式轮换与预览同源；2026-09-11 起命中行直接
  // 用服务端 match 结果，不依赖 subLines——仅勾文字模板（无字幕/花字）也不影响）
  if (hasTextFx) {
    const { drawtexts: txd, overlays: txOverlays } = buildTextFxDrawtextList(o, o.textFxHits, Number(o.videoIdx) || 0)
    if (txd.length) {
      videoFilters.push(`[${videoLabel}]${txd.join(',')}[vtx]`)
      videoLabel = 'vtx'
    }
    // R3 方案A：装饰图标 overlay（R2 公式定位；输入索引接在音效输入之后；rot=0 免 rotate）
    txOverlays.forEach((ov, oi) => {
      const inIdx = 1 + soundInputPaths.length + oi
      const dLabel = `deco${oi}`
      const chain = [`[${inIdx}:v]format=rgba`]
      if (ov.rot) chain.push(`rotate=${ov.rot}*(PI/180):c=black@0:ow=rotw(iw):oh=roth(ih)`)
      chain.push(`scale=${ov.w}:${ov.h}`)
      videoFilters.push(chain.join(',') + `[${dLabel}]`)
      videoFilters.push(`[${videoLabel}][${dLabel}]overlay=x=${ov.x}:y=${ov.y}:enable='between(t,${ov.start.toFixed(3)},${ov.end.toFixed(3)})'[tfo${oi}]`)
      videoLabel = `tfo${oi}`
      overlayInputPaths.push(ov.file)
    })
  }
  // 方案B（2026-09-13 用户裁决：本地合成与服务端同效果）：文字模板命中行改用服务端
  // render-preview 全分辨率 alpha WebM 素材（与成片同一渲染器，像素一致），全帧 overlay。
  // 素材缺失的命中行走 drawtext 兜底（textFxHits 只含兜底行，见 montage-final-ipc）。
  // 输入序：接在音效/装饰输入之后；setpts 把素材平移到命中起点，eof_action=repeat
  // 让末帧驻留到 enable 窗口结束（素材时长按命中窗口向服务端定制，正常恰好对齐）。
  const clipOverlays = Array.isArray(o.textFxClipOverlays) ? o.textFxClipOverlays : []
  clipOverlays.forEach((cv, ci) => {
    if (!cv || !cv.file || !(cv.end > cv.start)) return
    const inIdx = 1 + soundInputPaths.length + overlayInputPaths.length
    const cLabel = `txc${ci}`
    videoFilters.push(`[${inIdx}:v]setpts=PTS-STARTPTS+${cv.start.toFixed(3)}/TB[${cLabel}]`)
    videoFilters.push(`[${videoLabel}][${cLabel}]overlay=x=0:y=0:eof_action=repeat:enable='between(t,${cv.start.toFixed(3)},${cv.end.toFixed(3)})'[txc${ci}]`)
    videoLabel = `txc${ci}`
    overlayInputPaths.push(cv.file)
  })
  if (!videoFilters.length) return null
  // 滤镜输出标签（无冒号）需要 [] 包裹；裸输入流（如 0:a:0）不加
  const audioMap = audioLabel.includes(':') ? audioLabel : `[${audioLabel}]`
  const cmd = ['-y', '-i', o.videoPath]
  for (const sp of soundInputPaths) cmd.push('-i', sp)
  for (const ip of overlayInputPaths) {
    // 方案B：alpha WebM 素材必须用 libvpx-vp9 解码（原生 vp9 解码器丢弃
    // alpha_mode=1 附属流 → overlay 黑底块，2026-09-13 冒烟实锤）；PNG 装饰图不适用
    if (/\.webm$/i.test(ip)) cmd.push('-c:v', 'libvpx-vp9')
    cmd.push('-i', ip)
  }
  cmd.push(
    '-filter_complex', videoFilters.join(';'),
    '-map', `[${videoLabel}]`, '-map', audioMap,
    '-c:v', 'libx264', '-crf', '23', '-preset', 'superfast',
  )
  if (soundInputPaths.length) cmd.push('-c:a', 'aac')
  else cmd.push('-c:a', 'copy')
  cmd.push(o.outputVideoPath)
  return cmd
}

/**
 * 构建配音替换完整 ffmpeg 参数（对照 VideoDubbingWorker.run L1137-1456，
 * 2026-09-07 PR#4 新口径逐行移植；不含 ffmpeg 可执行路径前缀）。
 * opts: { videoPath, voiceWavPath, outputVideoPath, text, addSubtitles, lengthMode,
 *         videoDur, audioDur, timing,
 *         fancyText, fancyStyle, fancyPosition, fancyFontPath(已转义),
 *         subtitleFontPath(已转义), subtitleBoxOpacity,
 *         fancyTemplate(模板 dict 或 null), fancySoundPath(主进程已解析绝对路径或''),
 *         fancySoundGainDb,
 *         fancyWords(兼容保留：花字内容已改为自动提取卖点，不再参与渲染),
 *         burnEffects(2026-09-09 裁决：特效迁 Step4 后配音链显式传 false 纯化配音；
 *                     默认 true 保持向后兼容与既有单测口径) }
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
  const soundInputPaths = []

  if (useAudioLength) {
    videoFilters.push(`[${videoLabel}]tpad=stop_mode=clone:stop_duration=${extraDur.toFixed(3)}[v_padded]`)
    videoLabel = 'v_padded'
  }

  // 火效烧制开关（2026-09-09 裁决：字幕/花字迁 Step4 统一烧制，配音链传 false 纯化；
  // 默认 true 保持向后兼容）
  const burnEffects = o.burnEffects !== false

  // 逐句时间轴（字幕烧制与花字跟字幕时机共用，run L1178-1210）：
  // 优先 .timing.json 真实句级时间轴；无时间轴按字数比例估算（旧行为）
  let subLines = []
  let subStarts = []
  let subEnds = []
  if (burnEffects && (o.addSubtitles || o.fancyText) && o.text) {
    const built = buildSubtitleLines({
      timing: o.timing, text: o.text, displayDur, needAudioSpeed, videoDur, audioDur,
    })
    subLines = built.rawLines
    subStarts = built.lineStarts
    subEnds = built.lineEnds
  }

  if (burnEffects && o.addSubtitles && o.text && subLines.length) {
    const drawtexts = buildSubtitleDrawtextList(o, subLines, subStarts, subEnds)
    if (drawtexts.length) {
      videoFilters.push(`[${videoLabel}]${drawtexts.join(',')}[v]`)
      videoLabel = 'v'
    }
  }

  // 花字叠加（run L1258-1383）：内容自动从口播文案提取卖点（价格>数字参数>关键词，
  // 每条视频最多 FANCY_MAX_PER_VIDEO 个）；时机跟随对应字幕行——提前 FANCY_LEAD_SEC
  // 秒出现、该行字幕结束即消失；无卖点的行不出现。
  let fancyEvents = []
  if (burnEffects && o.fancyText && subLines.length && displayDur > 0) {
    fancyEvents = buildFancyEvents({ subLines, subStarts, subEnds, displayDur })
  }
  if (burnEffects && o.fancyText && fancyEvents.length) {
    const { fancyDrawtexts, soundSpecs } = buildFancyDrawtextList(o, fancyEvents)
    if (fancyDrawtexts.length) {
      videoFilters.push(`[${videoLabel}]${fancyDrawtexts.join(',')}[vf]`)
      videoLabel = 'vf'
    }
    if (soundSpecs.length) o.__soundSpecs = soundSpecs
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

  // 花字模板音效混入（run L1409-1426）：adelay 对齐时间轴 + amix 混入配音，
  // normalize=0 防止人声被拉低。必须在 atempo 之后追加，保证延迟基于最终时间轴。
  const soundSpecs = Array.isArray(o.__soundSpecs) ? o.__soundSpecs : []
  delete o.__soundSpecs
  let soundGain = -6.0
  try { soundGain = Number(o.fancySoundGainDb) } catch (_) { /* 缺省 -6 */ }
  if (!Number.isFinite(soundGain)) soundGain = -6.0
  if (soundSpecs.length) {
    let nextIdx = 2 // 输入流：0=video, 1=voice，音效从 2 开始
    let amixIn = `[${audioLabel}]`
    soundSpecs.forEach(([sfxPath, delayMs], si) => {
      videoFilters.push(`[${nextIdx}:a]adelay=${delayMs}:all=1,volume=${soundGain.toFixed(1)}dB[s${si}]`)
      amixIn += `[s${si}]`
      soundInputPaths.push(sfxPath)
      nextIdx += 1
    })
    videoFilters.push(`${amixIn}amix=inputs=${soundSpecs.length + 1}:normalize=0:duration=longest[a_mix]`)
    audioLabel = 'a_mix'
  }

  if (videoFilters.length) {
    const filterComplex = videoFilters.join(';')
    // 滤镜输出标签（无冒号）需要 [] 包裹；裸输入流（如 1:a:0）不加（L1430-1432）
    const audioMap = audioLabel.includes(':') ? audioLabel : `[${audioLabel}]`
    const cmd = [
      '-y', '-i', o.videoPath,
      '-i', o.voiceWavPath,
    ]
    for (const sp of soundInputPaths) cmd.push('-i', sp)
    cmd.push(
      '-filter_complex', filterComplex,
      '-map', `[${videoLabel}]`, '-map', audioMap,
      '-c:v', 'libx264', '-crf', '23', '-preset', 'superfast', '-c:a', 'aac',
    )
    // 「以声音为准」严格裁剪到音频时长（L1444-1448）
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

/**
 * 加载剪映文字模板的装饰图标（R2 标定公式：设计画布 720x720、中心原点、y 向上）。
 * 纯函数（dir 参数化可单测）；rid 不匹配/无装饰 → []。
 * 返回 [{file, cx, cy, wf, aspect, rot}]：
 *   cx/wf = 相对画布宽的占比（0-1）、cy = 相对画布高的占比、rot = 度。
 */
// R3 polish：装饰簇竖直锚点 = 文字中心占画布高比例（drawtext y=h*0.08 + 字号 h*0.055/2）
const TEXT_CENTER_CY = 0.108
function buildTextTemplateDecorations(dir, rid, videoW, videoH) {
  if (!dir || !rid || !(videoW > 0) || !(videoH > 0) || !fs.existsSync(dir)) return []
  const out = []
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.textpreset')) continue
    let p = null
    try { p = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')) } catch (_) { continue }
    const eff = p && p.effect
    if (!eff || String(eff.resource_id || eff.effect_id || '') !== String(rid)) continue
    // PNG↔元素两遍配对：精确尺寸 → 宽高比就近（与 test/sync-textpresets.cjs 同口径）
    const decorations = []
    const seen = new Set()
    for (const r of p.resources || []) {
      try {
        for (const f2 of fs.readdirSync(r.file_path)) {
          if (!f2.endsWith('.png')) continue
          const fp = path.join(r.file_path, f2)
          const b = fs.readFileSync(fp)
          const nw = b.readUInt32BE(16), nh = b.readUInt32BE(20)
          const key = nw + 'x' + nh + ':' + b.length
          if (seen.has(key)) continue
          seen.add(key)
          decorations.push({ file: fp, nw, nh })
        }
      } catch (_) {}
    }
    decorations.forEach((d) => { d.used = false })
    const elements = (p.elements || []).filter((e) => e && e.type === 'sticker')
    const assign = new Array(elements.length).fill(null)
    elements.forEach((e, i) => {
      const c = (e.attach_info && e.attach_info.clip) || {}
      const ow = Number(e.attach_info.original_size_width || 0), oh = Number(e.attach_info.original_size_height || 0)
      const d = decorations.find((x) => !x.used && x.nw === ow && x.nh === oh)
      if (d) { d.used = true; assign[i] = d }
    })
    elements.forEach((e, i) => {
      if (assign[i]) return
      const c = (e.attach_info && e.attach_info.clip) || {}
      const ow = Number(e.attach_info.original_size_width || 1), oh = Number(e.attach_info.original_size_height || 1)
      let bestD = null, bestDiff = 1e9
      for (const d of decorations) {
        if (d.used) continue
        const diff = Math.abs(d.nw / d.nh - ow / oh)
        if (diff < bestDiff) { bestDiff = diff; bestD = d }
      }
      if (bestD) { bestD.used = true; assign[i] = bestD }
    })
    // R2 公式 → 分辨率无关占比：cx = 0.5 + tx/720；cy = 文字中心 − ty*(W/720)/H；wf = natural*scale/720
    // R3 polish：装饰簇锚定文字位置（本地烧制文字在 h*0.08、字号 h*0.055 → 文字中心≈0.108H）；
    // 全画幅效果层（wf>0.8）保持画布居中；可见性钳制：装饰不得越出画面
    elements.forEach((e, i) => {
      const d = assign[i]
      const c = (e.attach_info && e.attach_info.clip) || {}
      if (!d) return
      const tx = Number(c.transform_x || 0), ty = Number(c.transform_y || 0)
      const sc = Number(c.scale_x || 1)
      const wf = (d.nw * sc) / 720
      const isFullLayer = wf > 0.8
      const dw = wf * videoW
      const dhFrac = (dw / Number(d.aspect || 1)) / videoH
      let cx = 0.5 + tx / 720
      let cy = TEXT_CENTER_CY - (ty * videoW / 720) / videoH
      cx = Math.min(Math.max(cx, wf / 2), 1 - wf / 2)
      cy = Math.min(Math.max(cy, dhFrac / 2), 1 - dhFrac / 2)
      out.push({
        file: d.file,
        cx: isFullLayer ? 0.5 : cx,
        cy: isFullLayer ? 0.5 : cy,
        wf,
        aspect: d.nw / d.nh,
        rot: Number(c.rotation || 0),
      })
    })
    break
  }
  return out
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
  SUBTITLE_STYLES,
  serverStyleToDrawtext,
  escapeDrawText,
  stripPronAnnotation,
  SAFE_X,
  SAFE_TOP,
  SAFE_BOTTOM,
  SUB_FONT_SCALE,
  SUB_BOTTOM_GAP,
  SUB_MAX_LINE_WEIGHT,
  SUB_ASCII_WEIGHT,
  FANCY_POSITIONS,
  FANCY_LEAD_SEC,
  FANCY_MAX_LEN,
  FANCY_MIN_GAP_SEC,
  FANCY_MIN_DISPLAY_SEC,
  FANCY_MAX_PER_VIDEO,
  extractFancyWordsInLine,
  extractFancyWordsFromText,
  resolveFancyOverlaps,
  subLineWeight,
  badSubBoundary,
  wrapSubtitleLine,
  getFancyAnim,
  buildFancyEvents,
  resolveOutMontageDir,
  buildAtempoChain,
  resolveSubtitleFontPath,
  buildSubtitleLines,
  buildDubFFmpegArgs,
  buildEffectBurnArgs,
  buildTextFxDrawtextList,
  planTextFxHits,
  buildTextTemplateDecorations,
}
