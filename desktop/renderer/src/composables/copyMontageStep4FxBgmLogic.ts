// ═══════════════════════════════════════════════════════════════
// copyMontageStep4FxBgmLogic.ts — 智能混剪 Step4 特效包装/BGM/字幕纯逻辑
// 自 copyMontageLogic.ts 拆分（铁律 10 / 2026-09-18，纯搬迁零行为改动，
// 拆分过程过 SKILL.md IRON-02 五项 checklist）。
// 对照原客户端 studio/gui：
//   · FinalMixWorker（/montage/bgm 混音口径服务端化）
//   · audio_material_page.py _GenBgmWorker L272-286 + audio_library_client.py
//     gen_bgm L159-175（/audio/gen/bgm）
//   · video_montage_page.py Step4 特效包装入口（成片收集/输出路径/BGM 时间轴）
//   · 字幕重切段后处理（2026-09-18 用户裁决：声音克隆完成后即处理）
// 本文件不做任何 IPC / DOM 操作（IRON-06/07 分层）
// ═══════════════════════════════════════════════════════════════

import { pathBasename } from './copyMontageCommonLogic.ts'
import {
  countChars,
  splitTextIntoSentences,
  validateLlmSplit,
} from './voiceCloneLogic.ts' // 带 .ts 扩展名：node --test 类型剥离直载约定（同 visionLogic.ts 口径）

// ── Step4 成片混音（/montage/bgm，对照 FinalMixWorker 口径服务端化）──

export interface BgmPayload {
  file: string
  bgm: string
  bgm_volume?: number
  source_volume?: number
}

/** /montage/bgm 载荷（Body_montage_add_bgm_montage_bgm_post：file+bgm 必填，音量可选） */
export function buildBgmPayload(opts: { file?: string; bgm?: string; bgmVolume?: number; sourceVolume?: number }): BgmPayload {
  if (!opts.file) throw new Error('缺少视频文件')
  if (!opts.bgm) throw new Error('缺少背景音乐')
  const p: BgmPayload = { file: opts.file, bgm: opts.bgm }
  if (opts.bgmVolume !== undefined) p.bgm_volume = Number(opts.bgmVolume)
  if (opts.sourceVolume !== undefined) p.source_volume = Number(opts.sourceVolume)
  return p
}

/** /montage/bgm 响应分流：task_id 优先轮询，否则同步结果 URL 下载 */
export function extractBgmResult(resp: unknown): { taskId: string; url: string } {
  if (!resp || typeof resp !== 'object') return { taskId: '', url: '' }
  const r = resp as Record<string, unknown>
  const taskId = String(r.task_id || r.id || r.job_id || '')
  if (taskId) return { taskId, url: '' }
  return { taskId: '', url: String(r.video_url || r.url || r.output_url || r.file || '') }
}

// ── Step4 AI 生成 BGM（/audio/gen/bgm，对齐原客户端 audio_material_page.py
//    _GenBgmWorker L272-286 + audio_library_client.py gen_bgm L159-175：
//    body = {prompt, style, duration}，无 mood —— 契约 description 中的中文
//    style/mood 枚举与原客户端实现矛盾，以实际工作的原客户端为准）──

/** style 下拉选项（原客户端 _build_tab_ai L1588-1594 硬编码 7 项，value 为英文值） */
export const BGM_STYLE_OPTIONS = [
  { label: '自动', value: 'auto' },
  { label: '电子', value: 'electronic' },
  { label: '古典', value: 'classical' },
  { label: '摇滚', value: 'rock' },
  { label: '爵士', value: 'jazz' },
  { label: '氛围', value: 'ambient' },
  { label: 'Lo-Fi', value: 'lofi' },
] as const

/** POST /audio/gen/bgm 载荷（原客户端 gen_bgm 同口径；duration 秒，UI 3-60 契约文档口径） */
export interface BgmGenPayload {
  prompt: string
  style: string
  duration?: number
}

export function buildBgmGenPayload(opts: { prompt?: string; style?: string; duration?: number }): BgmGenPayload {
  const prompt = String(opts.prompt || '').trim()
  if (!prompt) throw new Error('请输入 BGM 描述（如：激昂的电子音乐，适合科技感视频）')
  const p: BgmGenPayload = { prompt, style: String(opts.style || 'auto').trim() || 'auto' }
  if (opts.duration !== undefined && opts.duration !== null) {
    const d = Math.round(Number(opts.duration))
    if (!Number.isFinite(d) || d < 3 || d > 60) throw new Error('BGM 时长需在 3-60 秒之间')
    p.duration = d
  }
  return p
}

/** /audio/gen/bgm 响应解析：url 必填（相对路径），其余元信息尽力保留（原客户端 _on_gen_bgm_done 同口径） */
export function parseBgmGenResponse(resp: unknown): {
  url: string; duration: number; prompt: string; engine: string; audioId: string
} {
  if (!resp || typeof resp !== 'object') throw new Error('BGM 生成响应为空')
  const r = resp as Record<string, unknown>
  const url = String(r.url || r.audio_url || r.file_url || '')
  if (!url) throw new Error('BGM 生成成功但未返回音频地址')
  return {
    url,
    duration: Number(r.duration) || 0,
    prompt: String(r.prompt || ''),
    engine: String(r.engine || ''),
    audioId: String(r.audio_id ?? ''),
  }
}

/**
 * 混音 BGM 源选择（本地文件优先于 AI 生成 URL；两者皆空报错）。
 * 返回 /montage/bgm 的 bgm 字段形态：本地走 {path}（multipart 读盘），AI 走 bgm_url（服务端自行拉取）。
 */
export function pickBgmMixField(bgmPath: string, bgmGenUrl: string): { bgm?: { path: string }; bgm_url?: string } {
  const local = String(bgmPath || '').trim()
  const ai = String(bgmGenUrl || '').trim()
  if (local) return { bgm: { path: local } }
  if (ai) return { bgm_url: ai }
  throw new Error('请先选择背景音乐或生成 BGM')
}

// ══ 文字模板（textfx；2026-09-09 用户裁决：与花字独立概念）════════

/** 随机模式下可选取的文字模板个数选项（默认 3，用户裁决口径） */
export const TEXT_RANDOM_COUNT_OPTIONS = [
  { label: '1 个', value: 1 },
  { label: '2 个', value: 2 },
  { label: '3 个', value: 3 },
  { label: '4 个', value: 4 },
  { label: '5 个', value: 5 },
]

/** 关键词密度档位（2026-09-10 用户裁决：低/中/高，调节后重新提取关键词并重新生成
 *  需要合成的文字模板；提取为本地函数 extractFancyWordsFromText，上限随档位变化） */
export const TEXT_KEYWORD_DENSITY_OPTIONS = [
  { label: '低', value: 'low' },
  { label: '中', value: 'mid' },
  { label: '高', value: 'high' },
]
/** 密度档位 → 关键词提取上限（低=价格等硬卖点；中=2026-09-10 前硬编码口径；
 *  高=关键词层扩容） */
export const TEXT_KEYWORD_DENSITY_MAX: Record<string, number> = {
  low: 3,
  mid: 8,
  high: 12,
}

// ── 文字模板效果预览时间轴（2026-09-10 用户裁决：每视频一条、背景条=视频时长、
//    关键词按真实时间点定位、每视频独立轮换随机模板）──

/** 单模板烧制/预览共用样式提炼（从 variables 提取主色/效果色/动画语义，
 *  与样式预览 textFxStyleSamples 同口径；本地烧制 buildTextFxDrawtextList 消费） */
export interface TextFxStyle {
  name: string
  color: string
  effectColor: string
  anim: string
  /** M2a/R3：剪映同步模板 id（jy_<resource_id>），本地烧制据此解析装饰图标 */
  templateId?: string
}
/** 描边兜底色（2026-09-13 用户反馈「本地全默认效果」：variables 无第二色时 effectColor
 *  曾回退主色 → 白字白边=无描边。按主色亮度取对比色：亮字深边/暗字白边/中亮加深） */
function borderFallbackOf(main: string): string {
  const m = /^#([0-9a-fA-F]{6})$/.exec(main)
  if (!m) return '#1A1A1A'
  const ch = [1, 3, 5].map((i) => parseInt(main.slice(i, i + 2), 16) / 255)
  const lum = 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2]
  if (lum > 0.6) return '#1A1A1A'
  if (lum < 0.25) return '#FFFFFF'
  return '#' + ch.map((v) => Math.round(v * 150).toString(16).padStart(2, '0')).join('')
}
export function textFxStyleOf(t: { template_id?: string; name?: string; variables?: unknown }): TextFxStyle {
  const vars = (t.variables && typeof t.variables === 'object' ? t.variables : {}) as Record<string, { default?: unknown }>
  const colors: string[] = []
  for (const v of Object.values(vars)) {
    const d = v && typeof v === 'object' ? v.default : v
    if (typeof d === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(d) && colors.length < 3) colors.push(d)
  }
  // M2a/R3：显式 anim 变量优先（同步 jy_ 模板可声明），名称正则仅兜底
  const varsAnim = vars.anim && typeof vars.anim === 'object' ? String(vars.anim.default || '') : ''
  const key = `${t.template_id || ''}${t.name || ''}`
  const anim = varsAnim || (/bounce|pop|弹/.test(key) ? 'bounce'
    : /flip|翻转/.test(key) ? 'flip'
    : /gradient|渐变/.test(key) ? 'flow'
    : /neon|glow|霓虹/.test(key) ? 'neon'
    : /shimmer|闪|扫/.test(key) ? 'shine'
    : /slide|滑/.test(key) ? 'slide'
    : /typewriter|打字/.test(key) ? 'type'
    : /pulse|zoom|脉冲|缩放/.test(key) ? 'pulse'
    : 'fade')
  const mainColor = String((vars.color && typeof vars.color === 'object' ? vars.color.default : '') || '#FFFFFF')
  // 渐变副色 color2 优先做效果色；无第二色按亮度兜底对比描边（不再回退主色）
  const effectColor = colors.find((c) => c.toLowerCase() !== mainColor.toLowerCase()) || borderFallbackOf(mainColor)
  return { name: String(t.name || ''), color: mainColor, effectColor, anim, templateId: String(t.template_id || '') }
}

/** 单视频效果预览词条（时间单位=秒，相对该视频开头）；
 *  anim/tplStyle 由编排层附加（2026-09-10 用户裁决：预览词条按命中模板的
 *  颜色+动画渲染，与样式橱窗/烧制同源，不再写死黄色） */
export interface TextFxTrackItem {
  word: string
  tplName: string
  start: number
  end: number
  /** 服务端 match textfx_clips 逐事件指派的模板 id（2026-09-13 接口对齐；
   *  预览词条据此播放 render-preview 真实动画，未指派回退轮换） */
  templateId?: string
  /** 命中模板的动画语义键（2026-09-13 CSS 近似废止，仅作素材元数据保留） */
  anim?: string
  /** 命中模板的预览样式（颜色/渐变，不含 fontSize） */
  tplStyle?: Record<string, string>
  /** 服务端命中行的完整文本（word 为命中关键词时悬停提示显示整行；2026-09-11） */
  fullText?: string
}

/** 确定性种子洗牌（LCG；seed 相同结果相同 → 预览与烧制同源不漂移）。
 *  主进程 voice-tts-logic.js 内有逐行同款实现（跨端无共享模块），改这里必须同步改那边 */
export function seededShuffle<T>(arr: readonly T[], seed: number): T[] {
  const a = [...arr]
  let s = ((Number(seed) || 0) + 1) * 2654435761 >>> 0
  for (let i = a.length - 1; i > 0; i--) {
    s = (s * 1664525 + 1013904223) >>> 0
    const j = s % (i + 1)
    const tmp = a[i]; a[i] = a[j]; a[j] = tmp
  }
  return a
}

/** 每视频独立随机样式子集（2026-09-10 用户裁决：随机数量 N 对应每条视频各自
 *  从全量池随机选 N 个；seed=视频序 → 预览与烧制同视频同子集）。
 *  count<=0 或池≤1 → 原样返回全量（不限个数/指定单模板） */
export function pickVideoStyles<T>(pool: readonly T[], count: number, videoIdx: number): T[] {
  if (!(count > 0) || pool.length <= 1) return [...pool]
  return seededShuffle(pool, Number(videoIdx) || 0).slice(0, Math.min(count, pool.length))
}

/** 单视频效果预览轨（背景条即 durationSec 全长） */
export interface TextFxTrack {
  name: string
  durationSec: number
  items: TextFxTrackItem[]
}

/**
 * 组装字幕行（服务端 /text_templates/match、/montage/concat 的 subtitle_rows 入参）：
 * timing 优先；缺失回退字数占比均分视频时长（与主进程 buildSrtFromTiming 兜底同口径）。
 * 纯函数可单测。
 */
export function buildSubtitleRows(
  text: string,
  timing: Array<{ text: string; start: number; end: number }> | undefined,
  durationSec: number,
): Array<{ text: string; start: number; end: number }> {
  const sents = (timing || [])
    .map((t) => ({ text: String(t.text || '').trim(), start: Number(t.start) || 0, end: Number(t.end) || 0 }))
    .filter((s) => s.text)
  if (sents.length) return sents
  const lines = String(text || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
  const weights = lines.map((l) => Math.max(1, l.length))
  const total = weights.reduce((a, b) => a + b, 0)
  let cum = 0
  return lines.map((l, i) => {
    const s = cum
    cum += (durationSec > 0 ? durationSec : lines.length * 5) * weights[i] / total
    return { text: l, start: s, end: cum }
  })
}

/**
 * 组装效果预览时间轴（2026-09-11 用户裁决：命中数据一律取自服务端
 * /text_templates/match 返回的 lines——selected=合成时会加动画的行（含关键词命中/
 * LLM 补足/等距兜底三类），word 优先显示命中关键词（matched_keywords），无词行
 * 显示整行文本截断；模板样式按 (视频序号 + 词序号) 对每视频随机子集取模轮换，
 * 使不同视频的随机样式错开）。纯函数可单测。
 */
export function buildTextFxTracks(opts: {
  rows: Array<{
    name: string
    durationSec: number
    /** 服务端命中行动画（lines 中 selected=true 的行；行级时间戳；
     *  2026-09-13 接口对齐：templateId=match textfx_clips 逐事件指派，有则透传词条） */
    lines?: Array<{ text: string; start: number; end: number; keywords?: string[]; templateId?: string }>
  }>
  tplNames: string[]
  /** 每视频随机样式个数（2026-09-10 用户裁决；缺省 0=全量池轮换） */
  count?: number
}): TextFxTrack[] {
  return (opts.rows || []).map((row, vi) => {
    const videoPool = pickVideoStyles(opts.tplNames, opts.count ?? 0, vi) // 每视频独立随机子集
    const dur = Math.max(0, Number(row.durationSec) || 0)
    const lines = (row.lines || []).filter((l) => String(l.text || '').trim())
    const items: TextFxTrackItem[] = lines.map((l, i) => {
      const kws = (Array.isArray(l.keywords) ? l.keywords : []).map((k) => String(k).trim()).filter(Boolean)
      const full = String(l.text).trim()
      return {
        // 命中关键词优先（服务端 matched_keywords）；LLM/兜底补足行无词 → 整行截断
        word: kws.length ? kws.join('/') : full.length > 10 ? `${full.slice(0, 10)}…` : full,
        fullText: full,
        tplName: videoPool.length ? videoPool[(vi + i) % videoPool.length] : '',
        start: Number(l.start) || 0,
        end: Number(l.end) || 0,
        templateId: l.templateId ? String(l.templateId) : undefined,
      }
    })
    return { name: row.name, durationSec: dur, items }
  })
}

/** 从池中随机取 n 个（Fisher-Yates 部分洗牌；n≥池长时全量乱序返回；
 *  供文字模板「随机样式」与效果预览逐词轮换使用，纯函数可单测） */
export function pickRandomItems<T>(pool: readonly T[], n: number): T[] {
  const arr = [...pool]
  const take = Math.max(0, Math.min(Math.floor(n) || 0, arr.length))
  for (let i = 0; i < take; i++) {
    const j = i + Math.floor(Math.random() * (arr.length - i))
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
  return arr.slice(0, take)
}

// ══ Step4 特效包装（对照 video_montage_page.py + FinalMixWorker 入口逻辑）════

/** final 输出目录（逐行对照 _get_out_final_dir L3983-3995，Windows 路径口径） */
export function resolveOutFinalDir(firstVid: string): string {
  const abs = String(firstVid || '').replace(/\//g, '\\').replace(/\\+$/, '')
  const idx = (abs + '\\').toLowerCase().indexOf('\\outputs\\')
  if (idx >= 0) return abs.slice(0, idx) + '\\final'
  const dirName = abs.slice(0, Math.max(abs.lastIndexOf('\\'), 0))
  const base = ['dubbed', 'outputs'].includes(dirName.slice(dirName.lastIndexOf('\\') + 1).toLowerCase())
    ? dirName.slice(0, Math.max(dirName.lastIndexOf('\\'), 0))
    : dirName
  return base + '\\final'
}

/** 收集待混音候选（_collect_mix_candidates L4073-4112：dubbed 优先 + outputs 回退，去重保序） */
export function collectMixCandidates(dubbedPaths: string[], outputsFiles: string[]): string[] {
  const tasks: string[] = []
  for (const p of dubbedPaths || []) { if (p) tasks.push(p) }
  if (!tasks.length) {
    for (const p of outputsFiles || []) { if (p) tasks.push(p) }
  }
  const seen = new Set<string>()
  const unique: string[] = []
  for (const t of tasks) {
    if (!seen.has(t)) { seen.add(t); unique.push(t) }
  }
  return unique
}

/** 构建混音任务输出路径（_start_final_mix L4132-4142：剥 dubbed_ 前缀 + {src}_final_{name}/final_{name}） */
export function buildFinalTasks(candidates: string[], srcName: string, outFinalDir: string): Array<{ videoPath: string; outPath: string }> {
  return candidates.map((vid) => {
    let name = pathBasename(vid)
    if (name.startsWith('dubbed_')) name = name.slice('dubbed_'.length)
    const outName = srcName ? `${srcName}_final_${name}` : `final_${name}`
    return { videoPath: vid, outPath: `${outFinalDir.replace(/\\+$/, '')}\\${outName}` }
  })
}

/** 合成产物路径 → 反推输入源 basename（旧持久化 lastComposeTasks 无 inputPath 的兜底，
 *  2026-09-17 修复：时间轴导出按它回关联口播行/字幕 timing）。命名约定见 buildFinalTasks：
 *  {srcName}_final_{name}（name=输入 basename 剥 dubbed_ 前缀）——取首个 '_final_'
 *  之后段；无 srcName 形态 final_{name} 走前缀分支；产物名不合约定返回空串，
 *  调用方落「该段无字幕轨」不阻断。 */
export function inputNameFromFinalPath(outPath: string): string {
  const b = pathBasename(outPath)
  const k = b.indexOf('_final_')
  if (k >= 0) return b.slice(k + '_final_'.length)
  if (b.startsWith('final_')) return b.slice('final_'.length)
  return ''
}

/** BGM 播放器时间标签（原版 format_time ms→mm:ss，lbl_bgm_time「00:00 / 00:00」口径） */
export function fmtBgmTime(ms: number): string {
  const s = Math.floor(Math.max(0, Number(ms) || 0) / 1000)
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

/** 源视频目录名（_start_final_mix L4133：basename(folder_path.rstrip("/\\"))） */
export function srcDirName(dirPath: string): string {
  const s = String(dirPath || '').replace(/[\\/]+$/, '')
  if (!s) return ''
  return pathBasename(s)
}

// ── 字幕样式预设（2026-09-17 用户裁决：字幕样式统一来自服务端 /subtitle_styles 库）──

/** 字幕样式预设（2026-09-17 用户裁决：字幕样式统一来自服务端 /subtitle_styles 库）。
 *  key=服务端 style.id，label=服务端 style.name，color/stroke 从服务端 style 对象解析；
 *  serverStyle 保留原始服务端样式对象，供主进程 buildServerFxFields 透传。 */
export interface SubtitleStylePreset {
  key: string; label: string; color: string; stroke: string
  serverStyle?: Record<string, unknown>
}

/** 服务端颜色值 → CSS hex（"white"→"#FFFFFF"，"#RRGGBB"→原样，"color@opacity"→剥离@） */
function normalizeCssColor(raw: unknown): string {
  const s = String(raw || '').trim()
  if (!s) return '#FFFFFF'
  // 剥离 @opacity（box="black@0.6" → "black"）
  const base = s.includes('@') ? s.slice(0, s.lastIndexOf('@')) : s
  if (base.startsWith('#')) return base.length === 7 ? base : base
  // 常见色名映射（服务端可能用色名或 hex）
  const named: Record<string, string> = {
    white: '#FFFFFF', black: '#000000', red: '#FF0000', green: '#00FF00',
    blue: '#0000FF', yellow: '#FFFF00', orange: '#FFA500', pink: '#FFC0CB',
    purple: '#800080', teal: '#008080', gold: '#FFD700', gray: '#808080',
  }
  return named[base.toLowerCase()] || '#FFFFFF'
}

/** 服务端样式对象 → UI 色板预设（key/label/color/stroke + 原始 serverStyle） */
export function serverStyleToPreset(s: { id?: string; name?: string; style?: Record<string, unknown> }): SubtitleStylePreset {
  const st = s.style || {}
  const color = normalizeCssColor(st.color)
  const outline = Number(st.outline) || 0
  const stroke = outline > 0 ? normalizeCssColor(st.outline_colour || 'black') : ''
  return {
    key: String(s.id || 'unknown'),
    label: String(s.name || s.id || '未知样式'),
    color,
    stroke,
    serverStyle: st,
  }
}

/** 服务端样式列表 → UI 色板预设数组 */
export function serverStylesToPresets(styles: Array<{ id?: string; name?: string; style?: Record<string, unknown> }>): SubtitleStylePreset[] {
  return styles.map(serverStyleToPreset)
}

/** 离线兆底：服务端不可用时的默认预设（保持基本可用性） */
export const SUBTITLE_STYLE_PRESETS_FALLBACK: SubtitleStylePreset[] = [
  { key: 'std_bottom', label: '标准底部白字', color: '#FFFFFF', stroke: '' },
  { key: 'white_blk', label: '白字黑边', color: '#FFFFFF', stroke: '#000000' },
  { key: 'yellow_blk', label: '黄字黑边', color: '#FFE135', stroke: '#000000' },
  { key: 'red_white', label: '红字白边', color: '#FF4040', stroke: '#FFFFFF' },
  { key: 'blue_white', label: '蓝字白边', color: '#40A0FF', stroke: '#FFFFFF' },
  { key: 'green_white', label: '绿字白边', color: '#40FF80', stroke: '#FFFFFF' },
]

/** 字幕样式预设 → 色板 tile 内联样式（T 字样例；描边用 text-stroke，背景框用 background） */
export function subtitlePresetTileStyle(p: SubtitleStylePreset): Record<string, string> {
  const s: Record<string, string> = { color: p.color }
  if (p.stroke) {
    s.webkitTextStroke = `2.5px ${p.stroke}`
    s.paintOrder = 'stroke'
  }
  // 服务端 box 背景框预览（"color@opacity" → rgba）
  if (p.serverStyle?.box) {
    const boxStr = String(p.serverStyle.box)
    const atIdx = boxStr.lastIndexOf('@')
    if (atIdx > 0) {
      const boxColor = normalizeCssColor(boxStr.slice(0, atIdx))
      const opacity = parseFloat(boxStr.slice(atIdx + 1)) || 0.5
      // hex → rgba
      const r = parseInt(boxColor.slice(1, 3), 16)
      const g = parseInt(boxColor.slice(3, 5), 16)
      const b = parseInt(boxColor.slice(5, 7), 16)
      s.background = `rgba(${r},${g},${b},${opacity})`
    } else {
      s.background = normalizeCssColor(boxStr)
    }
  }
  return s
}

/** 字幕背景 6 项（对照 subtitle_bg_combo L226-228，value 为黑框不透明度）。
 *  默认 20%（2026-09-15 用户裁决：背景里的透明默认设计为 20%） */
export const SUBTITLE_BG_OPTIONS = [
  { label: '无背景', value: 0 },
  { label: '20% 透明黑 (默认)', value: 0.2 },
  { label: '35% 透明黑', value: 0.35 },
  { label: '50% 透明黑', value: 0.5 },
  { label: '65% 透明黑', value: 0.65 },
  { label: '80% 透明黑', value: 0.8 },
]

// ── 渲染层花字卖点提取（与 main/voice-tts-logic.js 同逻辑，供花字预览弹窗；
//    实际烧制以主进程提取结果为准）──

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
const FANCY_MAX_LEN = 10
const FANCY_MAX_PER_VIDEO = 3

/** 单行内提取多个卖点（优先级：价格 > 数字参数 > 关键词，对照 extract_fancy_words_in_line L104-140） */
export function extractFancyWordsInLine(lineText: string, limit = FANCY_MAX_PER_VIDEO): string[] {
  const t = String(lineText || '')
  if (!t.trim()) return []
  const hits: Array<[number, number, string]> = []
  for (const m of t.matchAll(FANCY_PRICE_RE)) {
    hits.push([m.index, m.index + m[0].length, m[0].slice(0, FANCY_MAX_LEN)])
  }
  for (const m of t.matchAll(FANCY_NUM_RE)) {
    if (hits.some(([s, e]) => (s <= m.index && m.index < e) || (s < m.index + m[0].length && m.index + m[0].length <= e))) continue
    hits.push([m.index, m.index + m[0].length, m[0].slice(0, FANCY_MAX_LEN)])
  }
  const occupied = (pos: number) => hits.some(([s, e]) => s <= pos && pos < e)
  for (const kw of FANCY_KEYWORDS) {
    if (hits.length >= limit) break
    let pos = t.indexOf(kw)
    while (pos !== -1) {
      if (!occupied(pos)) { hits.push([pos, pos + kw.length, kw]); break }
      pos = t.indexOf(kw, pos + 1)
    }
  }
  hits.sort((a, b) => a[0] - b[0])
  const words: string[] = []
  for (const [, , w] of hits) {
    if (w && (words.length === 0 || words[words.length - 1] !== w)) words.push(w)
    if (words.length >= limit) break
  }
  return words
}

/** 全文提取卖点（逐行扫描，跨行去重，上限 maxWords） */
export function extractFancyWordsFromText(text: string, maxWords = FANCY_MAX_PER_VIDEO): string[] {
  const words: string[] = []
  for (const line of String(text || '').split(/\r?\n/)) {
    for (const w of extractFancyWordsInLine(line, maxWords - words.length)) {
      if (w && (words.length === 0 || words[words.length - 1] !== w)) words.push(w)
      if (words.length >= maxWords) return words
    }
  }
  return words
}

// ── 关键词命中（2026-09-19 架构：服务端 /text_templates/match 删除）──
// 词源=产品资料关联关键词（客户端命中）；产品无关联词 → LLM 兜底提词。

/** 产品关键词 × 字幕行命中（原 textFxHitsForExport 内核复活为纯函数）：
 *  逐行扫描，词在行文本中出现即命中（窗口=该行时间区间）；
 *  templateId=候选池轮转（渲染样式层，与命中判定解耦）。 */
export function matchKeywordHits(
  words: string[],
  rows: Array<{ text: string; start: number; end: number }>,
  templatePool: string[] = [],
): Array<{ text: string; start: number; end: number; keywords: string[]; templateId?: string }> {
  const clean = (Array.isArray(words) ? words : []).map((w) => String(w || '').trim()).filter(Boolean)
  const out: Array<{ text: string; start: number; end: number; keywords: string[]; templateId?: string }> = []
  for (const r of Array.isArray(rows) ? rows : []) {
    for (const w of clean) {
      if (!w || !String(r.text || '').toLowerCase().includes(w.toLowerCase())) continue
      const templateId = templatePool.length ? String(templatePool[out.length % templatePool.length]) : ''
      out.push({ text: w, start: r.start, end: r.end, keywords: [w], templateId })
    }
  }
  return out
}

/** LLM 关键词提取系统提示词（只要求 JSON 数组输出，防御解析见 parseLlmKeywords） */
export const LLM_KEYWORDS_SYSTEM_PROMPT
  = '你是电商短视频关键词提取器。从口播文案中提取至多 {max} 个卖点关键词（词或短语，每个不超过8个字，'
  + '不要整句），用于在视频中做花字/文字模板展示。只输出 JSON 字符串数组，例如 ["大容量","快充","199元"]，'
  + '不要输出任何解释或其他内容。'

/** LLM 回复 → 关键词数组（防御解析：JSON 数组优先，失败回退引号/顿号/逗号切分；
 *  去重去空、截断 maxWords） */
export function parseLlmKeywords(content: string, maxWords = 8): string[] {
  const raw = String(content || '').trim()
  if (!raw) return []
  let list: unknown[] = []
  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) list = parsed
  } catch (_) {
    const m = /\[[\s\S]*\]/.exec(raw) // 截取首个 JSON 数组片段再试
    if (m) {
      try {
        const parsed = JSON.parse(m[0])
        if (Array.isArray(parsed)) list = parsed
      } catch (_) { /* 落下方文本切分 */ }
    }
  }
  if (!list.length) {
    list = raw.replace(/["'\[\]]/g, ' ').split(/[,，、;；\n]/)
  }
  const out: string[] = []
  for (const it of list) {
    const w = String(it ?? '').trim()
    if (!w || out.includes(w)) continue
    out.push(w)
    if (out.length >= maxWords) break
  }
  return out
}

// ── 字幕重切段后处理（2026-09-18 用户裁决：声音克隆完成后即处理）──────────
// 服务端无字幕重切段端点（live /openapi.json 仅 whisper ASR，识别文本不可作
// 字幕文本）→ 走「本地 + LLM」：复用原客户端 SentenceSplitterLLMWorker 机器
// （voiceCloneLogic：LLM 拆句 + 漏字校验回退本地），行级时间轴由 TTS 句级
// timing 按字符位置分段线性映射。产物 SRT 资产供本地剪映导出与服务端合成
// subtitle_srt 上传同消费（单一事实源）。

/** 字幕行字数上限：超长按逗号停顿重切（屏读可读性，2026-09-18 裁决） */
export const SUBTITLE_LINE_MAX_CHARS = 20
/** 字幕行字数下限：短于此并入前行（防 1 秒闪现残片） */
export const SUBTITLE_LINE_MIN_CHARS = 8

const stripWs = (s: string): string => String(s || '').replace(/\s+/g, '')
/** 字幕行显示长度：去空白后码点数。不能用 countChars（\p{L}\p{N} 不计中文标点，
 *  会把「低延迟稳定传输。」算 7 字误判短残片并行使屏读断句失真） */
const displayLen = (s: string): number => Array.from(stripWs(s)).length

/** 超长行重切：按中文逗号/分号/顿号停顿贪心累加 ≤maxChars；单停顿仍超 → 按字数硬切。
 *  停顿符归前段（先构造「文本+尾随停顿符」单元再贪心，硬切不拆散单元 →
 *  行首不会悬挂孤立逗号） */
export function splitLongSubtitleLines(lines: string[], maxChars: number): string[] {
  const out: string[] = []
  for (const raw of lines || []) {
    const s = String(raw || '').trim()
    if (!s) continue
    if (displayLen(s) <= maxChars) { out.push(s); continue }
    // 停顿单元：非停顿符正文 + 尾随停顿符（硬切只切正文，标点跟随前文）
    const units: string[] = []
    for (const m of s.match(/[^，,；;、]+[，,；;、]*/g) || [s]) {
      const t = m.replace(/[，,；;、]+$/, '')
      const p = m.slice(t.length)
      if (t) units.push(t, p)
      else if (units.length) units[units.length - 1] += p
      else units.push(p)
    }
    let cur = ''
    for (let i = 0; i < units.length; i++) {
      const u = units[i]
      const isPunct = i % 2 === 1
      if (isPunct) { cur += u; continue }
      if (displayLen(cur + u) <= maxChars) { cur += u; continue }
      // 正文单段仍超长 → 先 flush 再按字数硬切，余尾留 cur 继续贪心
      if (displayLen(u) > maxChars) {
        if (cur) { out.push(cur); cur = '' }
        let rest = u
        while (displayLen(rest) > maxChars) {
          let take = ''
          for (const ch of rest) {
            take += ch
            if (displayLen(take) >= maxChars) break
          }
          out.push(take)
          rest = rest.slice(take.length)
        }
        cur = rest
        continue
      }
      if (cur) { out.push(cur); cur = '' }
      cur = u
    }
    if (cur) out.push(cur)
  }
  return out
}

/** 过短残片合并：显示长度 <minChars 的行直接并入前行（首行过短保留，不丢字） */
export function mergeTinySubtitleLines(lines: string[], minChars: number): string[] {
  const out: string[] = []
  for (const raw of lines || []) {
    const s = String(raw || '').trim()
    if (!s) continue
    const prev = out.length ? out[out.length - 1] : ''
    if (prev && displayLen(s) < minChars) out[out.length - 1] = prev + s
    else out.push(s)
  }
  return out
}

/**
 * 字幕行规划：LLM 重切段优先（漏字校验 + 去空白拼接一致性双校验，任一不过 →
 * 本地规则拆句兜底）→ 超长重切 → 残片合并。纯函数可单测。
 */
export function planSubtitleLines(text: string, llmLines: string[] | null): string[] {
  const src = String(text || '').trim()
  if (!src) return []
  const fallback = splitTextIntoSentences(src)
  let lines = fallback
  const cand = (llmLines || []).map((l) => String(l || '').trim()).filter(Boolean)
  if (cand.length) {
    const invalid = validateLlmSplit(src, cand)
    if (!invalid && stripWs(cand.join('')) === stripWs(src)) lines = cand
  }
  return mergeTinySubtitleLines(splitLongSubtitleLines(lines, SUBTITLE_LINE_MAX_CHARS), SUBTITLE_LINE_MIN_CHARS)
}

export interface SubtitleRow { text: string; start: number; end: number }

/**
 * 行文本 → 句级 timing 映射：字符游标分段线性（句内按字数比例插值，句界精确）；
 * 去空白拼接不一致 / 无 timing / 总时长≤0 → 按有效字数在 [0, totalEnd] 均分兜底。
 */
export function mapLinesToTiming(
  lines: string[],
  timing: Array<{ text: string; start: number; end: number }>,
): SubtitleRow[] {
  const list = (lines || []).map((l) => String(l || '').trim()).filter(Boolean)
  if (!list.length) return []
  const r3 = (n: number): number => Math.round(n * 1000) / 1000
  const segs = (timing || []).filter((t) => t && String(t.text || '').trim())
  const totalEnd = segs.length ? Math.max(0, Number(segs[segs.length - 1].end) || 0) : 0
  const tConcat = segs.map((t) => stripWs(t.text)).join('')
  const lConcat = list.map(stripWs).join('')
  if (!segs.length || !totalEnd || tConcat !== lConcat) {
    const weights = list.map((l) => Math.max(1, countChars(l)))
    const sum = weights.reduce((a, b) => a + b, 0)
    let cur = 0
    return list.map((l, i) => {
      const start = (cur / sum) * totalEnd
      cur += weights[i]
      const end = (cur / sum) * totalEnd
      return { text: l, start: r3(start), end: r3(Math.max(end, start + 0.2)) }
    })
  }
  const bounds: Array<{ cs: number; ce: number; start: number; end: number }> = []
  let pos = 0
  for (const t of segs) {
    const len = stripWs(t.text).length
    bounds.push({ cs: pos, ce: pos + len, start: Number(t.start) || 0, end: Number(t.end) || 0 })
    pos += len
  }
  const at = (p: number): number => {
    for (let i = 0; i < bounds.length; i++) {
      const b = bounds[i]
      if (p <= b.ce || i === bounds.length - 1) {
        const span = Math.max(1, b.ce - b.cs)
        const f = Math.min(1, Math.max(0, (p - b.cs) / span))
        return b.start + f * (b.end - b.start)
      }
    }
    return totalEnd
  }
  let cp = 0
  return list.map((l) => {
    const len = stripWs(l).length
    const start = at(cp)
    const end = at(cp + len)
    cp += len
    return { text: l, start: r3(start), end: r3(Math.max(end, start + 0.2)) }
  })
}

/** SRT 时间戳（HH:MM:SS,mmm，与导出链路原内联格式化同口径） */
export function srtTimestamp(sec: number): string {
  const ms = Math.max(0, Math.round((Number(sec) || 0) * 1000))
  const p = (n: number, w: number): string => String(n).padStart(w, '0')
  return `${p(Math.floor(ms / 3600000), 2)}:${p(Math.floor((ms % 3600000) / 60000), 2)}:${p(Math.floor((ms % 60000) / 1000), 2)},${p(ms % 1000, 3)}`
}

/** 字幕行 → SRT 文本（cue 间空行分隔，与导出链路原内联拼接逐字同口径）；
 *  2026-09-19 用户报障（字幕行尾悬挂逗号观感差）：序列化时剥离行尾逗号/顿号
 *  （句号/问号等句末标点保留），不影响重切校验（校验发生在序列化之前） */
const stripTrailingComma = (t: unknown): string => String(t ?? '').replace(/\s*[，,、]\s*$/, '')

export function serializeSrtRows(rows: SubtitleRow[]): string {
  return (rows || [])
    .map((r, k) => `${k + 1}\n${srtTimestamp(r.start)} --> ${srtTimestamp(r.end)}\n${stripTrailingComma(r.text)}\n`)
    .join('\n')
}
