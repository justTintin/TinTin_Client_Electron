// ═══════════════════════════════════════════════════════════════
// copyMontageStep3VoiceLogic.ts — 智能混剪 Step3 口播配音纯逻辑
// 自 copyMontageLogic.ts 拆分（铁律 10 / 2026-09-18，纯搬迁零行为改动，
// 拆分过程过 SKILL.md IRON-02 五项 checklist）。
// 对照原客户端 studio/gui：
//   · step3_voice_view.py 逐控件（花字样式/位置、行状态展示、时长模式）
//   · VoiceCloneWorker api 模式 / VideoDubbingWorker / BatchAITextRewriteWorker
//     （AI 改写四档指令 = script_workers.py L449-475 逐字）
// 本文件不做任何 IPC / DOM 操作（IRON-06/07 分层）
// ═══════════════════════════════════════════════════════════════

// ── Step3 口播配音（对照 step3_voice_view.py 逐控件 / VoiceCloneWorker api 模式 /
// VideoDubbingWorker / BatchAITextRewriteWorker；TTS 契约 POST /indextts/tts（2026-09-05 服务端
// 将删 /voxcpm/*，随声音克隆裁决统一切 IndexTTS）────

/** 配音行状态机（对照 _do_scan_voice_video_dir 行构建 + _start_synthesize_voice tasks 构建） */
export interface VoiceRow {
  path: string            // 视频绝对路径（行主键，原版 item Qt.UserRole 口径）
  name: string            // basename（行首列文件名）
  text: string            // 配音文案（行内编辑框）
  originalText: string    // 伴随 .txt 缓存（original_texts 口径，供对比/AI 改写）
  status: 'pending' | 'generating' | 'done'
  progress: number        // 0-100（row_progress 口径）
  wavPath: string         // 已生成 voices/voice_N.wav（generated_voice_paths 口径）
  lengthMode: 'video' | 'audio'   // 时长模式（voice_length_mode 口径）
  dubbedPath?: string     // 配音后视频（dubbed_video_paths 口径）
  durationSec: number     // 视频时长（VoiceRowDetailWidget video_duration_sec，黄字 m:ss）
  voiceDurSec: number     // 克隆音频时长（voice_audio_durations，绿字 m:ss；未生成为 0）
}

/** 行内时长展示（原版 f"{int(sec // 60)}:{int(sec % 60):02d}" 口径） */
export function fmtDur(sec: number): string {
  const s = Math.max(0, Math.floor(Number(sec) || 0))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** 花字样式 7 项（对照 step3_voice_view.py L249-255 addItem 顺序逐字） */
export const FANCY_STYLE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'gold', label: '渐变金' },
  { value: 'red', label: '渐变红' },
  { value: 'blue', label: '渐变蓝' },
  { value: 'purple', label: '渐变紫' },
  { value: 'neon_green', label: '霓虹绿' },
  { value: 'white_outline', label: '白字黑描边' },
  { value: 'yellow_red', label: '黄字红描边' },
]

/** 花字样式 → CSS 近似色对（Step3 行3 效果预览用；对照主进程 FANCY_STYLES drawtext 片段：
 *  color=fontcolor stroke=bordercolor，borderw≈4→text-stroke 3px、5→4px） */
export const FANCY_STYLE_PREVIEW: Record<string, { color: string; stroke: string }> = {
  gold:          { color: '#F0C040', stroke: '#6B3000' },
  red:           { color: '#FF4040', stroke: '#800000' },
  blue:          { color: '#40A0FF', stroke: '#003080' },
  purple:        { color: '#C060FF', stroke: '#300060' },
  neon_green:    { color: '#40FF80', stroke: '#004020' },
  white_outline: { color: '#FFFFFF', stroke: '#000000' },
  yellow_red:    { color: '#FFFF00', stroke: '#CC0000' },
}

/** 花字 drawtext 样式串 → CSS 近似预览（模板行3 效果预览：服务端/本地模板 style 即
 *  ffmpeg drawtext 片段，解析 fontcolor/borderw/bordercolor 还原主色+描边；
 *  shadow 统一近似为 textShadow。解析失败返回 null，回退选中样式预设色板） */
export function fancyDrawtextToPreview(style: string): Record<string, string> | null {
  const s = String(style || '').trim()
  if (!s) return null
  const pick = (k: string): string => {
    const m = s.match(new RegExp(`${k}=([^:]*)`))
    return m ? m[1] : ''
  }
  const hex = (v: string): string => {
    const t = v.trim().toLowerCase()
    if (!t) return ''
    if (t === 'white') return '#FFFFFF'
    if (t === 'black') return '#000000'
    const m = t.match(/^0x([0-9a-f]{6})/)
    return m ? `#${m[1].toUpperCase()}` : ''
  }
  const color = hex(pick('fontcolor'))
  if (!color) return null
  const bw = parseInt(pick('borderw'), 10)
  const stroke = hex(pick('bordercolor'))
  const out: Record<string, string> = { color }
  if (bw > 0 && stroke) {
    out.webkitTextStroke = `${Math.min(5, Math.max(2, bw - 1))}px ${stroke}`
    out.paintOrder = 'stroke'
  }
  if (pick('shadowx') || pick('shadowy')) out.textShadow = '2px 2px 4px rgba(0,0,0,.6)'
  return out
}

// ── AI 改写（对照 BatchAITextRewriteWorker / script_workers.py L449-493）────

/** AI 改写自由度说明（对照 _show_ai_rewrite_settings desc QLabel 逐字） */
export const AI_REWRITE_DESC =
  '控制AI改写文案时的创造性程度：\n' +
  '80-100% = 最小润色，保持原文字词句式不变\n' +
  '50-79% = 较大幅度改写，使用不同表达方式，更有网感\n' +
  '20-49% = 大幅重构，显著改变句式词汇\n' +
  '0-19% = 彻底重写，完全不同的词句，最大化爆款潜力'

/** 自由度 → temperature（对照 _show_ai_rewrite_settings L3405） */
export function rewriteTemperature(pct: number): number {
  return 1.0 - pct / 100.0
}

/** 改写 system prompt 四档指令（逐字对照 script_workers.py L449-475；
 *  主进程 main/voice-tts-logic.js 有同源实现，双份由单测锁定） */
export function buildRewriteSystemPrompt(temperature: number): string {
  const freedomPct = Math.round((1.0 - temperature) * 100)
  let rewriteInstruction: string
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
export function cleanRewriteContent(content: string): string {
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

/** 花字输入解析：全角逗号归一后按半角逗号拆分（对照 _start_dubbing_videos L3726-3730） */
export function parseFancyWords(raw: string): string[] {
  const r = String(raw || '').trim()
  if (!r) return []
  return r.replace(/，/g, ',').split(',').map((w) => w.trim()).filter((w) => w)
}

/** 输出目录推导（逐行对照 _get_out_montage_dir L3969-3981，Windows 路径口径） */
export function resolveOutMontageDir(dirPath: string): string {
  const abs = String(dirPath || '').replace(/\//g, '\\').replace(/\\+$/, '')
  if (/\\outputs$/i.test(abs)) return abs
  const idx = (abs + '\\').toLowerCase().indexOf('\\outputs\\')
  if (idx >= 0) return abs.slice(0, idx) + '\\outputs'
  const parent = abs.slice(0, Math.max(abs.lastIndexOf('\\'), 0))
  return parent + '\\outputs'
}

/** 行状态展示（对照行复合控件：已生成 → wav 文件名绿色粗体；未生成 → 灰） */
export function voiceStatusText(row: Pick<VoiceRow, 'status' | 'wavPath'>): string {
  if (row.status === 'generating') return '合成中...'
  if (row.wavPath) return row.wavPath.slice(row.wavPath.lastIndexOf('\\') + 1)
  return '未生成'
}

export function voiceStatusClass(row: Pick<VoiceRow, 'status' | 'wavPath'>): string {
  if (row.status === 'generating') return 'st-running'
  if (row.wavPath) return 'st-done'
  return 'st-pending'
}

// ── Step3 读音/花字/字幕下拉选项（对照 step3_voice_view.py 逐字）────

/** 花字位置 8 项（对照 fancy_position_combo L335-339） */
export const FANCY_POSITION_OPTIONS = [
  { label: '中上 (默认)', value: 'upper_middle' },
  { label: '顶部居中', value: 'top' },
  { label: '画面正中', value: 'center' },
  { label: '底部居中', value: 'bottom' },
  { label: '左上角', value: 'top_left' },
  { label: '右上角', value: 'top_right' },
  { label: '左下角', value: 'bottom_left' },
  { label: '右下角', value: 'bottom_right' },
]
