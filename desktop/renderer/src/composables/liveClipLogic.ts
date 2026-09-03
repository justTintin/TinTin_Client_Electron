// ═══════════════════════════════════════════════════════════════
// liveClipLogic — 直播切片策略纯函数（M9，无 vue/IPC 依赖，可单测）
// 对照原客户端 studio/gui/live_clip/{workers,page,utils}.py（以原代码为准）：
//   · HotSpotAnalyzer._rule_analyze（L108-168）：内置算法热点发现
//     60s 窗口 / 30s 步长滑动 → 关键词命中(HOT_KEYWORDS_CN)×3 +
//     词密度×10 + 唯一词占比×15 + 数字数×0.3 评分 → 阈值=均值×1.3
//     → 峰值合并（间隔 <20s）→ 时长 15~300s（>300 截断、<15 丢弃）
//     → 标题（热词≤3 + 高频实词≤5，| 连接，空则"精彩片段"）→ 按分降序
//   · HotSpotAnalyzer._llm_analyze 合并段（L233-259）：LLM 输出片段
//     按 start 升序合并（相邻 gap≤15s 且合并后 ≤300s → 合并，标题 / 连接截 25）
//   · HotSpotAnalyzer._llm_analyze 请求段（L172-231）：[mm:ss] text 行 →
//     4000 字符分块（5 行重叠）→ LLM prompt（逐字保留）→ JSON 数组解析
//     （extract_json_block 等价：纯 JSON / ```块 / 首个方括号块）+ mm:ss→秒
//   · VideoClipWorker 输出命名（L280-281）：clip_{i+1:03d}_{title}.mp4，
//     标题 re.sub(r"[^\w\u4e00-\u9fff\-]", "_")[:30]
//   · page.py _format_timestamp（L742-756）/ _RemoteWorker SRT 生成（L484-492）
//   · utils.py slice_srt（L49-93）：切片段字幕裁剪（重叠平移语义逐条对齐）
//   · 输入 segments 复用 srtUtils.SrtSegment（start/end/text）；无时间戳
//     文本经 estimateSegmentsFromText 估时兜底（真实链路 always 有 SRT）
// 归属口径（IRON-11 说明）：ASR 转写走服务端（/whisper/transcribe，
//   原版 transcribe_remote 同口径）；切片为本地 ffmpeg 顺序裁剪（原版
//   VideoClipWorker 同口径，属媒体直接操作非并行任务调度，服务端无切片接口）
// ═══════════════════════════════════════════════════════════════

import type { SrtSegment } from './srtUtils'

/** 原版 HOT_KEYWORDS_CN（live_clip/utils.py L14-21，39 词逐项移植） */
export const HOT_KEYWORDS_CN: string[] = [
  '重点', '关键', '核心', '重要', '注意', '记住', '一定要', '必须',
  '首先', '然后', '最后', '总结', '结论', '建议', '推荐',
  '技巧', '方法', '步骤', '教程', '演示', '实战', '案例',
  '干货', '福利', '优惠', '限时', '免费', '独家',
  '数据', '算法', '模型', 'AI', '人工智能', '深度学习',
  '赚钱', '流量', '变现', '涨粉', '运营',
]

/** 切片计划条目（对齐原版 hotspots dict 字段） */
export interface ClipPlanItem {
  start: number
  end: number
  startStr: string
  endStr: string
  duration: number
  score: number
  title: string
  preview: string
}

/** 切片计划参数（默认值对齐原版 _rule_analyze：win=60 / step=30 / 15~300s / gap=20） */
export interface ClipPlanOptions {
  win?: number
  step?: number
  minDuration?: number
  maxDuration?: number
  mergeGap?: number
}

/** LLM 模式片段输入（对齐原版 LLM JSON：start/end/title/score） */
export interface LlmPlanItem {
  start: number
  end: number
  title?: string
  score?: number
}

/** 秒 → mm:ss（对齐原版 f"{int(m//60):02d}:{int(m%60):02d}"） */
export function fmtMinSec(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

/** 文本中的中文/词 token（对齐原版 re.findall(r"[\u4e00-\u9fff\w]+", text)） */
function tokenize(text: string): string[] {
  const out: string[] = []
  for (const m of String(text || '').matchAll(/[\u4e00-\u9fff\w]+/g)) out.push(m[0])
  return out
}

/** 词频统计（对齐原版 collections.Counter） */
function wordFreq(words: string[]): Map<string, number> {
  const freq = new Map<string, number>()
  for (const w of words) freq.set(w, (freq.get(w) || 0) + 1)
  return freq
}

/**
 * 内置算法热点发现（原版 _rule_analyze 全量移植）：
 * 输入 ASR/SRT 分段（start/end/text）→ 输出切片计划（按评分降序）。
 * @param segments 字幕分段（可空）
 * @param opts 窗口/步长/时长边界参数（默认对齐原版）
 */
export function buildClipPlan(segments: SrtSegment[] | null | undefined, opts?: ClipPlanOptions): ClipPlanItem[] {
  const win = opts?.win ?? 60
  const step = opts?.step ?? 30
  const minDur = opts?.minDuration ?? 15
  const maxDur = opts?.maxDuration ?? 300
  const mergeGap = opts?.mergeGap ?? 20

  const segs = (Array.isArray(segments) ? segments : [])
    .filter((s) => s && typeof s.start === 'number' && typeof s.end === 'number')
  const totalDur = segs.length ? Math.max(...segs.map((s) => s.end)) : 0

  // 窗口滑动评分（原版 L111-128）
  const windows: Array<{ start: number; end: number; score: number; text: string; words: string[] }> = []
  for (let t0 = 0; t0 <= Math.floor(totalDur); t0 += step) {
    const t1 = t0 + win
    const wsegs = segs.filter((s) => s.start < t1 && s.end > t0)
    if (!wsegs.length) continue
    const text = wsegs.map((s) => String(s.text || '').trim()).join(' ')
    const words = tokenize(text)
    if (words.length < 10) continue // 原版：词数 <10 的窗口跳过
    const kwHits = words.filter((w) => HOT_KEYWORDS_CN.includes(w)).length
    const density = words.length / win
    const unique = new Set(words).size / Math.max(1, words.length)
    const digits = (String(text).match(/\d/g) || []).length
    const score = kwHits * 3.0 + density * 10.0 + unique * 15.0 + Math.min(digits, 20) * 0.3
    windows.push({ start: t0, end: t1, score, text, words })
  }
  if (!windows.length) return []

  // 阈值 = 均值 × 1.3 → 峰值（原版 L133-135）
  const avg = windows.reduce((a, w) => a + w.score, 0) / windows.length
  const threshold = avg * 1.3
  const peaks = windows
    .filter((w) => w.score >= threshold)
    .sort((a, b) => a.start - b.start)

  // 相邻峰值合并（间隔 <20s，原版 L137-145）
  const merged: Array<{ start: number; end: number; score: number; text: string; words: string[] }> = []
  for (const p of peaks) {
    const last = merged[merged.length - 1]
    if (last && p.start - last.end < mergeGap) {
      last.end = Math.max(last.end, p.end)
      last.score = Math.max(last.score, p.score)
      last.text += ' ' + p.text
      last.words.push(...p.words)
    } else {
      merged.push({ ...p, words: [...p.words] })
    }
  }

  // 时长边界 + 标题 + 预览（原版 L146-165）
  const results: ClipPlanItem[] = []
  for (const m of merged) {
    let dur = m.end - m.start
    if (dur < minDur) continue
    if (dur > maxDur) { m.end = m.start + maxDur; dur = maxDur }
    const freq = wordFreq(m.words)
    const hot = [...freq.keys()].filter((w) => HOT_KEYWORDS_CN.includes(w))
    const reg = [...freq.entries()]
      .filter(([w, c]) => w.length >= 2 && !HOT_KEYWORDS_CN.includes(w) && c > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([w]) => w)
    const top = [...hot.slice(0, 3), ...reg.slice(0, 5)]
    const title = top.slice(0, 5).join(' | ') || '精彩片段'
    results.push({
      start: m.start,
      end: m.end,
      startStr: fmtMinSec(m.start),
      endStr: fmtMinSec(m.end),
      duration: Math.round(dur),
      score: Math.round(m.score * 10) / 10,
      title,
      preview: String(m.text).slice(0, 120).replace(/\s+/g, ' '),
    })
  }
  results.sort((a, b) => b.score - a.score)
  return results
}

/** 单个 LLM 片段归一为计划条目（内部辅助） */
function normalizeLlmItem(item: LlmPlanItem, gap: number, maxDur: number, out: ClipPlanItem[], prev: ClipPlanItem | undefined): void {
  const start = Math.max(0, Number(item.start) || 0)
  const end = Math.max(start + 0.1, Number(item.end) || 0)
  if (prev && start <= prev.end + gap) {
    const newEnd = Math.max(prev.end, end)
    if (newEnd - prev.start <= maxDur) {
      prev.end = newEnd
      prev.duration = Math.round(newEnd - prev.start)
      prev.score = Math.max(prev.score, Number(item.score) || 0)
      if (item.title && item.title !== prev.title) {
        prev.title = `${prev.title}/${item.title}`.slice(0, 25)
      }
      return
    }
  }
  out.push({
    start,
    end,
    startStr: fmtMinSec(start),
    endStr: fmtMinSec(end),
    duration: Math.round(end - start),
    score: Math.round((Number(item.score) || 0) * 10) / 10,
    title: String(item.title || '精彩片段').slice(0, 25),
    preview: '',
  })
}

/**
 * LLM 模式结果合并（原版 _llm_analyze 合并段 L233-259）：
 * 输入 LLM 返回的片段列表（start/end 秒）→ 相邻 gap≤15s 且合并后 ≤300s 合并，
 * 标题以 / 连接截 25；输出与 buildClipPlan 同构的计划条目。
 */
export function mergeLlmPlan(items: LlmPlanItem[] | null | undefined, opts?: ClipPlanOptions): ClipPlanItem[] {
  const gap = opts?.mergeGap ?? 15
  const maxDur = opts?.maxDuration ?? 300
  const sorted = (Array.isArray(items) ? items : [])
    .filter((i) => i && typeof i.start === 'number')
    .sort((a, b) => a.start - b.start)
  const out: ClipPlanItem[] = []
  for (const item of sorted) {
    normalizeLlmItem(item, gap, maxDur, out, out[out.length - 1])
  }
  out.sort((a, b) => b.score - a.score)
  return out
}

/**
 * 无时间戳文本 → 估时字幕分段（fallback：真实链路 ASR 均带时间戳）。
 * 按标点/换行分句，每句时长按 4 字/秒 估算（min 2s），start 累加。
 */
export function estimateSegmentsFromText(text: string | null | undefined): SrtSegment[] {
  const parts = String(text || '')
    .split(/[\n。！？!?]+/)
    .map((s) => s.trim())
    .filter(Boolean)
  const segments: SrtSegment[] = []
  let cursor = 0
  for (const p of parts) {
    const dur = Math.max(2, Math.ceil(p.length / 4))
    segments.push({ start: cursor, end: cursor + dur, text: p })
    cursor += dur
  }
  return segments
}

/**
 * 无时间戳文本直接生成切片计划（LiveClip 无 SRT 时的统一入口）：
 * estimateSegmentsFromText → buildClipPlan。
 */
export function buildPlanFromText(text: string | null | undefined, opts?: ClipPlanOptions): ClipPlanItem[] {
  return buildClipPlan(estimateSegmentsFromText(text), opts)
}

// ═══════════════════════════════════════════════════════════════
// SRT 生成 / 裁剪（M9 补齐：原版 page.py _format_timestamp +
// workers.py _RemoteWorker SRT 生成 + utils.py slice_srt）
// ═══════════════════════════════════════════════════════════════

/**
 * 秒 → SRT 时间戳 hh:mm:ss,mmm（原版 page.py _format_timestamp L742-756，
 * 毫秒进位处理逐条对齐：ms==1000 → 秒进位 → 分进位 → 时进位）。
 */
export function formatSrtTimestamp(seconds: number): string {
  let s = Math.max(0, Number(seconds) || 0)
  let h = Math.floor(s / 3600)
  let m = Math.floor((s % 3600) / 60)
  let sec = Math.floor(s % 60)
  let ms = Math.round((s - Math.floor(s)) * 1000)
  if (ms === 1000) {
    ms = 0
    sec += 1
    if (sec === 60) {
      sec = 0
      m += 1
      if (m === 60) {
        m = 0
        h += 1
      }
    }
  }
  const p2 = (n: number) => String(n).padStart(2, '0')
  return `${p2(h)}:${p2(m)}:${p2(sec)},${String(ms).padStart(3, '0')}`
}

/**
 * 分段 → SRT 全文（原版 workers.py _RemoteWorker L484-492 生成格式：
 * 序号行 / hh:mm:ss,mmm --> hh:mm:ss,mmm / text / 空行）。
 */
export function buildSrtFromSegments(segments: SrtSegment[] | null | undefined): string {
  const lines: string[] = []
  let i = 0
  for (const s of Array.isArray(segments) ? segments : []) {
    if (!s || typeof s.start !== 'number' || typeof s.end !== 'number') continue
    i += 1
    lines.push(String(i))
    lines.push(`${formatSrtTimestamp(s.start)} --> ${formatSrtTimestamp(s.end)}`)
    lines.push(String(s.text || '').trim().replace(/\n/g, ' '))
    lines.push('')
  }
  return lines.join('\n')
}

/**
 * 切片段字幕裁剪（原版 utils.py slice_srt L49-93 语义，直接基于分段操作）：
 * t_end > start && t_start < end 保留；new_start = max(0, t_start - start)，
 * new_end = min(end - start, t_end - start)；new_end > new_start 才收。
 */
export function clipSegmentsForRange(segments: SrtSegment[] | null | undefined, startSec: number, endSec: number): SrtSegment[] {
  const out: SrtSegment[] = []
  for (const s of Array.isArray(segments) ? segments : []) {
    if (!s || typeof s.start !== 'number' || typeof s.end !== 'number') continue
    if (s.end > startSec && s.start < endSec) {
      const ns = Math.max(0, s.start - startSec)
      const ne = Math.min(endSec - startSec, s.end - startSec)
      if (ne > ns) out.push({ start: ns, end: ne, text: s.text })
    }
  }
  return out
}

// ═══════════════════════════════════════════════════════════════
// LLM 分析（M9 接线：原版 workers.py _llm_analyze 请求段 L172-231）
// ═══════════════════════════════════════════════════════════════

/** LLM 分块参数（对齐原版：块内 ≥4000 字符切分，块间带 5 行重叠） */
const LLM_CHUNK_CHARS = 4000
const LLM_CHUNK_OVERLAP_LINES = 5

/**
 * 字幕分段 → LLM 分块文本（原版 _llm_analyze L172-193）：
 * 每段一行 `[mm:ss] text`；累积 ≥4000 字符成块，下一块携带上一块
 * 末尾 5 行（不足 5 行则全部）作重叠。
 */
export function buildLlmChunks(segments: SrtSegment[] | null | undefined): string[] {
  const full: string[] = []
  for (const s of Array.isArray(segments) ? segments : []) {
    if (!s || typeof s.start !== 'number') continue
    full.push(`[${fmtMinSec(s.start)}] ${String(s.text || '').trim()}`)
  }
  const chunks: string[] = []
  let current: string[] = []
  let len = 0
  let overlap: string[] = []
  for (const line of full) {
    if (!current.length && overlap.length) {
      current.push(...overlap)
      len = overlap.reduce((a, l) => a + l.length + 1, 0)
    }
    current.push(line)
    len += line.length + 1
    if (len >= LLM_CHUNK_CHARS) {
      chunks.push(current.join('\n'))
      overlap = current.length >= LLM_CHUNK_OVERLAP_LINES ? current.slice(-LLM_CHUNK_OVERLAP_LINES) : current.slice()
      current = []
      len = 0
    }
  }
  if (current.length) chunks.push(current.join('\n'))
  return chunks
}

/**
 * LLM 分析 prompt（原版 _llm_analyze L199-210 逐字保留，仅拼接分块文本）。
 */
export function buildLlmPrompt(chunk: string): string {
  return (
    '你是专业的直播视频内容分析师。请仔细阅读以下直播字幕文本，并从中找出最具传播价值和吸引力的热点片段。\n\n' +
    '【分析与剪裁规则】：\n' +
    '1. **保持话题完整连贯（核心要求）**：如果主播在连续讨论同一个话题或主题，请务必将其归为一个完整的片段，不要将其切碎为多个零碎、不连贯的小片段。片段时长一般控制在30秒到5分钟之间。如果一个话题较长（如3-5分钟），只要逻辑连贯，请输出为一个完整片段。\n' +
    '2. **语义停顿**：确保片段的开始时间（start）和结束时间（end）定位在语句的自然停顿处，避免截断一句话。\n' +
    '3. **时间戳格式**：必须严格使用待分析文本中对应的 `分:秒`（如 `12:34`）格式。如果分钟数超过60，也请按照 `分钟数:秒` 格式输出（例如 `75:20`），不要转换为 `时:分:秒`。\n' +
    '4. **评分打分**：根据内容的精彩程度、信息干货密度 and 传播价值，给每个片段打分（0-10分）。\n' +
    '5. **片段标题**：为片段起一个能够高度概括主题、有吸引力且不超过15个字的简短标题。\n\n' +
    '【输出格式要求】：\n' +
    '请仅返回一个标准的 JSON 数组格式，不要包含任何 Markdown 格式标记（如 ```json）或任何额外的解释性文字。格式示例如下：\n' +
    '[{"start": "mm:ss", "end": "mm:ss", "title": "片段标题", "score": 8.5}]\n\n' +
    '【待分析字幕文本】：\n' + chunk
  )
}

/** mm:ss → 秒（原版 L219-223：split(':') 两段 分*60+秒；分钟可 >60 如 75:20。宽容支持 h:mm:ss） */
function mmssToSec(v: unknown): number {
  const parts = String(v ?? '').split(':').map((p) => parseInt(String(p).trim(), 10))
  if (parts.some((n) => !Number.isFinite(n))) return NaN
  if (parts.length === 2) return parts[0] * 60 + parts[1]
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
  return NaN
}

/** 等价 extract_json_block：纯 JSON → ```块 → 首个方括号块（失败返回 null） */
function extractJsonArray(text: string): unknown[] | null {
  const raw = String(text || '').trim()
  if (!raw) return null
  const candidates: string[] = [raw]
  const code = raw.match(/```[a-zA-Z]*\n?([\s\S]*?)```/)
  if (code) candidates.push(code[1].trim())
  for (const c of candidates) {
    try {
      const obj = JSON.parse(c)
      if (Array.isArray(obj)) return obj
      // 整体不是数组时在内部找首个 [...]（对齐原版「谁在前面用谁」的容错思路）
    } catch (_) { /* 继续 */ }
  }
  for (const c of candidates) {
    const i = c.indexOf('[')
    const j = c.lastIndexOf(']')
    if (i >= 0 && j > i) {
      try {
        const obj = JSON.parse(c.slice(i, j + 1))
        if (Array.isArray(obj)) return obj
      } catch (_) { /* 继续 */ }
    }
  }
  return null
}

/**
 * LLM 响应 → 计划片段列表（原版 L212-231：extract_json_block → 逐条
 * mm:ss→秒 / duration / score 默认 5.0 / title 兼容）。解析失败返回 []。
 */
export function parseLlmPlanResponse(content: string | null | undefined): LlmPlanItem[] {
  const arr = extractJsonArray(String(content || ''))
  if (!arr) return []
  const out: LlmPlanItem[] = []
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue
    const it = item as Record<string, unknown>
    const start = mmssToSec(it.start)
    const end = mmssToSec(it.end)
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue
    out.push({
      start,
      end,
      title: typeof it.title === 'string' ? it.title : '',
      score: Number.isFinite(Number(it.score)) ? Number(it.score) : 5.0,
    })
  }
  return out
}

// ═══════════════════════════════════════════════════════════════
// 切片命名 / 评分过滤（M9 补齐：原版 workers.py VideoClipWorker L280-281 +
// page.py score_filter L264-272）
// ═══════════════════════════════════════════════════════════════

/**
 * 切片输出文件名（原版 VideoClipWorker L280-281）：
 * clip_{i+1:03d}_{title}.mp4；标题 re.sub(r"[^\w\u4e00-\u9fff\-]", "_")[:30]。
 * 注意 JS 的 \w 含中文以外同 Python（含下划线/数字/字母），中文单独保留。
 */
export function clipFileName(index: number, title: string): string {
  const safe = String(title || 'clip').replace(/[^\w\u4e00-\u9fff-]/g, '_').slice(0, 30)
  return `clip_${String(index + 1).padStart(3, '0')}_${safe}.mp4`
}

/** 评分过滤下拉选项（原版 page.py L264-272：显示所有 + ≥3/5/6/7/8/9，默认 ≥9.0） */
export const SCORE_FILTER_OPTIONS: Array<{ label: string; value: number }> = [
  { label: '显示所有', value: 0.0 },
  { label: '>= 3.0', value: 3.0 },
  { label: '>= 5.0', value: 5.0 },
  { label: '>= 6.0', value: 6.0 },
  { label: '>= 7.0', value: 7.0 },
  { label: '>= 8.0', value: 8.0 },
  { label: '>= 9.0', value: 9.0 },
]

/** 评分过滤默认下限（原版 setCurrentIndex(6) → ≥ 9.0） */
export const SCORE_FILTER_DEFAULT = 9.0

/** 评分着色档位（原版 _on_analysis L682-685：≥7 绿 / ≥5 黄） */
export function scoreClass(score: number): string {
  if (score >= 7) return 'score-high'
  if (score >= 5) return 'score-mid'
  return ''
}
