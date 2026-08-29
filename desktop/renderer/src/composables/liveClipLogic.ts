// ═══════════════════════════════════════════════════════════════
// liveClipLogic — 直播切片策略纯函数（M9，无 vue/IPC 依赖，可单测）
// 对照原客户端 studio/gui/live_clip/workers.py（以原代码为准）：
//   · HotSpotAnalyzer._rule_analyze（L108-168）：内置算法热点发现
//     60s 窗口 / 30s 步长滑动 → 关键词命中(HOT_KEYWORDS_CN)×3 +
//     词密度×10 + 唯一词占比×15 + 数字数×0.3 评分 → 阈值=均值×1.3
//     → 峰值合并（间隔 <20s）→ 时长 15~300s（>300 截断、<15 丢弃）
//     → 标题（热词≤3 + 高频实词≤5，| 连接，空则"精彩片段"）→ 按分降序
//   · HotSpotAnalyzer._llm_analyze 合并段（L233-259）：LLM 输出片段
//     按 start 升序合并（相邻 gap≤15s 且合并后 ≤300s → 合并，标题 / 连接截 25）
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
