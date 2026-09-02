// ═══════════════════════════════════════════════════════════════
// videoMarketingLogic.ts — 视频营销检测纯逻辑
// 对照原客户端 studio/gui/marketing_detect_page.py
//
// 核心功能：
//   · 关键帧时间点计算（_sample_times：按全片均匀抽 5~10 帧）
//   · system prompt（研判是否营销/广告/带货/引流，严格 JSON 输出）
//   · 结果解析归一（safe_json_parse 口径 + 字段夹紧/缺省）
//   · 结论文案与配色（_render：营销红 / 非营销绿）
//
// 与视频评价预测共用 visionLogic（safeJsonParse / buildVisionContent / 模型状态卡）；
// 差异仅在「抽帧策略」与「prompt / 结果结构」。
// 本文件不做任何 IPC / DOM 操作（IRON-06/07 分层）。
// 注：跨 .ts 的相对 import 必须带 .ts 后缀，否则 node --test（类型剥离）无法解析。
// ═══════════════════════════════════════════════════════════════

import { buildVisionContent, clampScore, safeJsonParse, toStringList, type VisionContentPart, type VisionFrame } from './visionLogic.ts'

/** 推广分类枚举（对照 sys_prompt 中 category 的取值集合） */
export const MARKETING_CATEGORIES = [
  '直销带货',
  '品牌广告',
  '软广植入',
  '知识付费/教育推广',
  '非营销/纯内容',
  '其他（请注明）',
] as const
export type MarketingCategory = typeof MARKETING_CATEGORIES[number]

/** 检测结果（对照 MarketingDetectWorker.finished 回调 dict） */
export interface MarketingResult {
  is_marketing: boolean       // 是否营销/广告视频
  confidence: number          // 置信度 0-100
  category: string            // 推广分类（模型可能自由发挥，故保留 string）
  product_or_brand: string    // 涉及品牌/商品，无则空串
  clues: string[]             // 营销线索（画面/文字证据）
  analysis: string            // 详细研判分析（≤150字）
  suggestions: string[]       // 优化/合规建议
}

/** 抽帧数量下限（对照 max(5, …)） */
const MIN_FRAMES = 5
/** 抽帧数量上限（对照 min(10, …)） */
const MAX_FRAMES = 10
/** 每帧覆盖时长（对照 int(dur / 3.0)） */
const SEC_PER_FRAME = 3.0

/**
 * 计算关键帧时间点（对照 _sample_times）。
 * 策略：按全片均匀抽 5~10 帧以覆盖视频全片（与评价预测的「前3秒密集」不同）。
 *
 * 原版分支顺序需严格保留：
 *   dur <= 0    → [0.5]
 *   n = min(10, max(5, int(dur / 3.0)))
 *   dur <= 2.0  → [dur / 2.0]（n 已算但不使用）
 *   否则        → n 帧，第 i 帧位于 dur*(i+0.5)/n
 */
export function marketingSampleTimes(dur: number): number[] {
  const d = Number(dur)
  if (!Number.isFinite(d) || d <= 0) return [0.5]

  const n = Math.min(MAX_FRAMES, Math.max(MIN_FRAMES, Math.floor(d / SEC_PER_FRAME)))
  if (d <= 2.0) return [Math.round((d / 2.0) * 10) / 10]

  const times: number[] = []
  for (let i = 0; i < n; i++) {
    times.push(Math.round((d * (i + 0.5) / n) * 10) / 10)
  }
  return times
}

/**
 * 构建研判 system prompt（对照 marketing_detect_page.py L109-122，逐句对齐）。
 * 视觉模型由服务端选择，客户端不指定 model。
 */
export function buildMarketingPrompt(): string {
  return (
    '你是专业的视频分析和营销内容审查专家。请仔细查看以下按时间顺序排列的视频关键帧（包含视频画面和字幕文字等信息）。\n' +
    '你的任务是判断这个视频是否属于【营销/广告宣传/带货/商业推广/引流】类视频。\n' +
    '请严格只输出符合以下格式的 JSON，不要包含任何 Markdown 标记或多余字符，确保能够被 json.loads() 解析：\n' +
    '{\n' +
    '  "is_marketing": true 或 false,\n' +
    '  "confidence": 0 到 100 之间的置信度数值,\n' +
    '  "category": "直销带货"、"品牌广告"、"软广植入"、"知识付费/教育推广"、"非营销/纯内容"、"其他（请注明）" 之一,\n' +
    '  "product_or_brand": "推广的产品/品牌名称，如果没有则为空字符串",\n' +
    '  "clues": ["证据1", "证据2", ...（列出视觉画面或文字中体现营销意图的线索）],\n' +
    '  "analysis": "对视频营销特征的简明分析说明（不超过150字）",\n' +
    '  "suggestions": ["优化或改进建议1", "优化或改进建议2", ...（如何提高营销吸引力、或若非营销视频如何保持内容纯粹性、商业合规等）]\n' +
    '}'
  )
}

/** user content 引导句（对照 L124：f"视频名称：{title}。以下为按时间先后抽取的关键帧："） */
export function buildMarketingLeadText(videoTitle: string): string {
  return `视频名称：${videoTitle}。以下为按时间先后抽取的关键帧：`
}

/** user content（文本引导句 + 逐帧 image_url，对照 L124-128） */
export function buildMarketingContent(
  videoTitle: string,
  frames: VisionFrame[]
): VisionContentPart[] {
  return buildVisionContent(buildMarketingLeadText(videoTitle), frames)
}

/**
 * 解析模型返回（对照 safe_json_parse + _render 取值口径）。
 * 结构不合要求（非对象 / 缺 is_marketing 与 confidence）时返回 null。
 */
export function parseMarketingResponse(text: string): MarketingResult | null {
  const obj = safeJsonParse(text)
  if (!obj) return null

  // is_marketing 缺失时按 confidence 兜底判定，避免整条结果被丢弃
  const hasFlag = typeof obj.is_marketing === 'boolean'
  const confidence = clampScore(obj.confidence)
  if (!hasFlag && obj.confidence == null) return null

  return {
    is_marketing: hasFlag ? !!obj.is_marketing : confidence >= 50,
    confidence,
    category: typeof obj.category === 'string' ? obj.category.trim() : '',
    product_or_brand: typeof obj.product_or_brand === 'string' ? obj.product_or_brand.trim() : '',
    clues: toStringList(obj.clues),
    analysis: typeof obj.analysis === 'string' ? obj.analysis : '',
    suggestions: toStringList(obj.suggestions),
  }
}

/** 结论文案（对照 _render lbl_verdict 两分支） */
export function marketingVerdictText(isMarketing: boolean): string {
  return isMarketing
    ? '⚠️ 检测结论：营销/商业推广视频'
    : '✅ 检测结论：原创内容/非营销视频'
}

/** 结论配色（对照 setStyleSheet：营销 #e74c3c / 非营销 #2ecc71） */
export function marketingVerdictColor(isMarketing: boolean): string {
  return isMarketing ? '#e74c3c' : '#2ecc71'
}

/** 置信度文案（对照 f"（置信度: {conf}%）"） */
export function marketingConfidenceText(confidence: number): string {
  return `（置信度: ${confidence}%）`
}

/** 涉及品牌/商品展示（对照 str(prod) if prod else "无"） */
export function marketingProductText(productOrBrand: string): string {
  const p = String(productOrBrand || '').trim()
  return p || '无'
}

/** 分类展示（对照 str(data.get("category", "—"))） */
export function marketingCategoryText(category: string): string {
  const c = String(category || '').trim()
  return c || '—'
}

/** 置信度分档配色（高分醒目、低分弱化，UI 展示用） */
export function marketingConfidenceColor(confidence: number): string {
  if (confidence >= 80) return '#e74c3c'
  if (confidence >= 50) return '#f1c40f'
  return '#a0aec0'
}
