// ═══════════════════════════════════════════════════════════════
// videoScoreLogic.ts — 视频评价预测纯逻辑（对照 hook_score_page.py）
// 核心功能：
//   · 关键帧时间点计算（_sample_times：前3秒密集 + 覆盖全片）
//   · 评分解析（safe_json_parse 口径）
//   · 维度定义（DIMENSIONS：吸睛力/画面冲击/悬念信息/节奏/完播预测/平台适配）
//   · 平台定义（PLATFORMS：抖音/快手/小红书/视频号/B站）
// 组件/composable 只做编排，本文件不做任何 IPC / DOM 操作（IRON-06/07 分层）
// 共用部分（safe_json_parse / image_url 拼接 / 模型状态卡）见 visionLogic.ts
// 注：跨 .ts 的相对 import 必须带 .ts 后缀，否则 node --test（类型剥离）无法解析。
// ═══════════════════════════════════════════════════════════════

import { buildVisionContent, clampScore, safeJsonParse, toStringList, type VisionContentPart, type VisionFrame } from './visionLogic.ts'

/** 投放平台列表（对照 video_prediction_manager.PLATFORMS，含顺序） */
export const PLATFORMS = ['抖音', '小红书', '视频号', 'B站', '快手'] as const
export type Platform = typeof PLATFORMS[number]

/** 评分维度（对照 DIMENSIONS） */
export const DIMENSIONS = ['吸睛力', '画面冲击', '悬念信息', '节奏', '完播预测', '平台适配'] as const
export type Dimension = typeof DIMENSIONS[number]

/** 维度颜色（对照 DIM_COLORS） */
export const DIM_COLORS: Record<Dimension, string> = {
  '吸睛力': '#e74c3c',
  '画面冲击': '#3498db',
  '悬念信息': '#f1c40f',
  '节奏': '#9b59b6',
  '完播预测': '#2ecc71',
  '平台适配': '#e67e22',
}

/** 预测量级 */
export type PlayLevel = '爆款' | '优质' | '普通' | '偏弱'

/** 预测结果（对照 HookScoreWorker.finished 回调） */
export interface VideoScoreResult {
  total: number              // 综合预测分 0-100
  play_level: PlayLevel      // 预测表现量级
  golden3s: boolean          // 黄金3秒是否合格
  dims: Record<Dimension, number>  // 各维度评分 0-100
  comment: string            // 一句话总评
  suggestions: string[]      // 改进建议
}

/**
 * 计算关键帧时间点（对照 _sample_times）
 * 策略：前3秒密集（0.5s/1.5s/2.5s）+ 覆盖前20秒（9帧均匀分布）
 * 
 * @param dur 视频时长（秒）
 * @returns 时间点数组（秒）
 */
export function sampleTimes(dur: number): number[] {
  const span = Math.min(20.0, dur || 20.0)
  const opening = [0.5, 1.5, 2.5]
  const rest: number[] = []
  
  if (span > 3.2) {
    const n = 9
    for (let i = 0; i < n; i++) {
      rest.push(Math.round((3.0 + (span - 3.0) * (i + 0.5) / n) * 10) / 10)
    }
  }
  
  const times = [...opening, ...rest].filter((t) => !dur || t < dur)
  return times.length ? times : [0.5]
}

/**
 * 解析视觉模型返回的 JSON（对照 safe_json_parse + finished.emit(result)）。
 * 多格式容错（纯 JSON / markdown 代码块 / 带前后缀文本）统一走 visionLogic.safeJsonParse，
 * 本函数只负责「评分结构归一化」；结构不合要求时返回 null。
 */
export function parseScoreResponse(text: string): VideoScoreResult | null {
  const obj = safeJsonParse(text)
  return obj ? validateScoreResult(obj) : null
}

/**
 * 验证并归一化评分结果（对照原版直接取 dict 字段，此处补夹紧与缺省）
 */
function validateScoreResult(obj: Record<string, any>): VideoScoreResult | null {
  // 必要字段：缺 total / play_level / dims 视为模型没按格式输出
  if (obj.total == null) return null
  if (typeof obj.play_level !== 'string' || !obj.play_level) return null
  if (!obj.dims || typeof obj.dims !== 'object') return null

  const rawDims = obj.dims as Record<string, unknown>
  const dims = {} as Record<Dimension, number>
  for (const d of DIMENSIONS) dims[d] = clampScore(rawDims[d])

  return {
    total: clampScore(obj.total),
    play_level: obj.play_level as PlayLevel,
    golden3s: !!obj.golden3s,
    dims,
    comment: typeof obj.comment === 'string' ? obj.comment : '',
    suggestions: toStringList(obj.suggestions),
  }
}

/**
 * 构建视觉模型预测的 system prompt（对照 HookScoreWorker.do_work）
 */
export function buildScorePrompt(platform: Platform, calibration?: string): string {
  const calib = calibration ? calibration + '\n' : ''
  return (
    `你是短视频运营与投放专家，熟悉各平台推荐机制。下面按时间顺序给出一条【完整视频】` +
    `的若干关键帧（前3秒密集，其余覆盖全片）。目标投放平台：${platform}。` +
    `请站在「${platform}」的推荐逻辑与用户偏好上，预测这条视频的表现，并多维度打分。\n` +
    calib +
    `严格只输出 JSON：\n` +
    `{"total":0-100,"play_level":"爆款|优质|普通|偏弱","golden3s":true/false,` +
    `"dims":{"吸睛力":0-100,"画面冲击":0-100,"悬念信息":0-100,"节奏":0-100,` +
    `"完播预测":0-100,"平台适配":0-100},` +
    `"comment":"一句话总评","suggestions":["建议1","建议2","建议3"]}\n` +
    `total=综合预测分；play_level=预测表现量级；完播预测=预计完播表现；` +
    `平台适配=与该平台调性/算法的契合度。`
  )
}

/**
 * 构建视觉模型预测的 user content 引导句（对照 hook_score_page.py L211-212）。
 * 逐帧 image_url 由 visionLogic.buildVisionContent 统一拼接。
 */
export function buildScoreLeadText(platform: Platform, videoTitle: string): string {
  return `目标平台：${platform}；视频标题：${videoTitle}。以下为该视频的关键帧（按时间先后）：`
}

/**
 * 构建视觉模型预测的 user content（对照 hook_score_page.py L211-216）：
 * 文本引导句 + 逐帧 data:image/jpeg;base64 图片。
 */
export function buildScoreContent(
  platform: Platform,
  videoTitle: string,
  frames: VisionFrame[]
): VisionContentPart[] {
  return buildVisionContent(buildScoreLeadText(platform, videoTitle), frames)
}

/** 视频文件名 → 标题：见 visionLogic.videoTitleOf（两工具共用） */

// ═══════════════════════════════════════════════════════════════
// 雷达图几何（对照 RadarChartWidget.paintEvent）
// 原版用 QPainter 极坐标手绘，此处产出同口径的 SVG 几何数据：
//   cx=cy=size/2；r_max=min(w,h)/2-30；a=-π/2 + i*(2π/n)；
//   网格 4 圈（0.25/0.5/0.75/1.0）；数据多边形 r=r_max*(v/100)；
//   标签位于 r_max+13，颜色取 DIM_COLORS。
// 纯计算，不做 DOM 操作（IRON-06/07），供 UI 层直接绑到 <svg>。
// ═══════════════════════════════════════════════════════════════

export interface RadarPoint { x: number; y: number }

export interface RadarGeometry {
  size: number
  cx: number
  cy: number
  rMax: number
  /** 4 圈网格（step 0.25/0.5/0.75/1.0） */
  rings: RadarPoint[][]
  /** 轴线终点（从圆心出发） */
  axes: RadarPoint[]
  /** 数据多边形顶点 */
  polygon: RadarPoint[]
  /** 维度标签（名称 + 分值 + 颜色） */
  labels: Array<RadarPoint & { dim: Dimension; score: number; color: string }>
}

/** 网格圈步进（对照 for step in (0.25, 0.5, 0.75, 1.0)） */
const RADAR_STEPS = [0.25, 0.5, 0.75, 1.0]
/** 标签偏移（对照 r_max + 13.0） */
const RADAR_LABEL_OFFSET = 13

/** 维度 i 的极角（对照 a = -π/2 + i*(2π/n)，首维指向正上方） */
function radarAngle(i: number, n: number): number {
  return -Math.PI / 2 + i * ((2 * Math.PI) / n)
}

/** 极坐标 → 直角坐标 */
function polar(cx: number, cy: number, r: number, a: number): RadarPoint {
  return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) }
}

/**
 * 生成雷达图几何。维度数 < 3 时返回空多边形（对照 if n < 3: return）。
 * @param scores 各维度得分 0-100
 * @param size   画布边长（对照 setMinimumSize(170,170)）
 */
export function radarGeometry(
  scores: Partial<Record<Dimension, number>>,
  size = 170
): RadarGeometry {
  const dims = DIMENSIONS as readonly Dimension[]
  const n = dims.length
  const cx = size / 2
  const cy = size / 2
  const rMax = Math.min(size, size) / 2 - 30
  const empty: RadarGeometry = {
    size, cx, cy, rMax, rings: [], axes: [], polygon: [], labels: [],
  }
  if (n < 3 || rMax <= 0) return empty

  const rings = RADAR_STEPS.map((step) =>
    dims.map((_d, i) => polar(cx, cy, rMax * step, radarAngle(i, n)))
  )
  const axes = dims.map((_d, i) => polar(cx, cy, rMax, radarAngle(i, n)))
  const polygon = dims.map((d, i) => {
    // 对照 v = max(0, min(100, scores.get(d, 0) or 0))
    const raw = scores?.[d]
    const v = Math.max(0, Math.min(100, Number(raw) || 0))
    return polar(cx, cy, rMax * (v / 100), radarAngle(i, n))
  })
  const labels = dims.map((d, i) => {
    const p = polar(cx, cy, rMax + RADAR_LABEL_OFFSET, radarAngle(i, n))
    return {
      x: p.x,
      y: p.y,
      dim: d,
      score: Math.max(0, Math.min(100, Number(scores?.[d]) || 0)),
      color: DIM_COLORS[d] || '#ffffff',
    }
  })

  return { size, cx, cy, rMax, rings, axes, polygon, labels }
}

/** 顶点数组 → SVG polygon points 属性（"x,y x,y …"） */
export function toSvgPoints(pts: RadarPoint[]): string {
  return pts.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ')
}

/**
 * 量级颜色映射（用于 UI 展示）
 */
export function playLevelColor(level: PlayLevel): string {
  switch (level) {
    case '爆款': return '#e74c3c'
    case '优质': return '#2ecc71'
    case '普通': return '#f1c40f'
    case '偏弱': return '#95a5a6'
  }
}

/**
 * 综合分颜色映射（用于 UI 展示）
 */
export function totalScoreColor(score: number): string {
  if (score >= 80) return '#2ecc71'  // 绿色
  if (score >= 60) return '#f1c40f'  // 黄色
  return '#e74c3c'                    // 红色
}

// ═══════════════════════════════════════════════════════════════
// 预测记录 + 「预测 vs 实际」校准
// 对照 studio/utils/video_prediction_manager.py：
//   recent_with_feedback / pending_feedback / calibration_text
// 记录本体由主进程 video-prediction-store.js 持久化（userData/video_predictions.json），
// 本层只做「取子集 + 拼校准文本」的纯计算，不做任何 I/O。
// ═══════════════════════════════════════════════════════════════

/** 回填的真实数据（对照 actual = {play_count, platform_eval, at}） */
export interface PredictionActual {
  play_count: string
  platform_eval: string
  at: number
}

/** 一条预测记录（对照 VideoPredictionManager.items 元素） */
export interface PredictionRecord {
  id: string
  video_path: string
  video_name: string
  platform: string
  /** 模型原始输出（持久化口径，不做窄化：字段可能缺失或为任意类型） */
  predicted: Record<string, any>
  actual: PredictionActual | null
  created_at: number
}

/** 校准取数条数上限（对照 recent_with_feedback(limit=12)） */
export const CALIBRATION_LIMIT = 12

/**
 * 取最近已回填的「预测 vs 实际」对照（对照 recent_with_feedback）
 * @param items   全量记录（已按最新在前排序）
 * @param platform 传入则只取该平台；留空取全部
 * @param limit   条数上限
 */
export function recentWithFeedback(
  items: PredictionRecord[],
  platform?: string,
  limit: number = CALIBRATION_LIMIT
): PredictionRecord[] {
  const arr = Array.isArray(items) ? items : []
  const out: PredictionRecord[] = []
  for (const it of arr) {
    if (!it || !it.actual) continue
    if (platform && it.platform !== platform) continue
    out.push(it)
    if (out.length >= limit) break
  }
  return out
}

/** 尚未回填真实数据的记录（对照 pending_feedback） */
export function filterPendingFeedback(items: PredictionRecord[]): PredictionRecord[] {
  return (Array.isArray(items) ? items : []).filter((it) => !!it && !it.actual)
}

/**
 * 把历史对照拼成校准文本（对照 calibration_text，喂给 buildScorePrompt）。
 * 无已回填数据时返回空串（此时 prompt 不插入校准段）。
 */
export function buildCalibrationText(
  items: PredictionRecord[],
  platform?: string,
  limit: number = CALIBRATION_LIMIT
): string {
  const rows = recentWithFeedback(items, platform, limit)
  if (!rows.length) return ''

  const lines: string[] = [
    '以下是你过往的『预测 vs 实际』对照（同一作者/账号），' +
    '请据此校准本次预测——若历史上你高估/低估，请相应修正：',
  ]
  for (const it of rows) {
    const p: Record<string, any> = it.predicted || {}
    const a: Record<string, any> = it.actual || {}
    // 对照原版 f-string 的 .get(key, '?') 缺省口径
    const total = p.total == null || p.total === '' ? '?' : p.total
    const level = p.play_level == null || p.play_level === '' ? '?' : p.play_level
    const play = a.play_count == null || a.play_count === '' ? '?' : a.play_count
    const evalText = a.platform_eval == null ? '' : a.platform_eval
    lines.push(
      `- [${it.platform || ''}] 预测综合${total}分/量级${level} → 实际播放${play}、` +
      `平台评价「${evalText}」`
    )
  }
  return lines.join('\n')
}
