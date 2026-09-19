// ═══════════════════════════════════════════════════════════════
// copyMontageStep2ConcatLogic.ts — 智能混剪 Step2 镜头重组纯逻辑
// 自 copyMontageLogic.ts 拆分（铁律 10 / 2026-09-18，纯搬迁零行为改动，
// 拆分过程过 SKILL.md IRON-02 五项 checklist）。
// 对照原客户端 studio/gui：
//   · gui/video_montage_page.py _submit_concat_to_server L2663-2725
//     （转场安全映射 SERVER_TRANSITION_MAP / layout→width,height / options 白名单）
//   · gui/montage/workers/montage_concat_server_worker.py L57-143
//     （files / clip_urls 至少一项；clip_urls 为 JSON 字符串；result.video_url/url/output_url）
//   · _build_precompose_plans L5223-5344（预合成方案）
// 本文件不做任何 IPC / DOM 操作（IRON-06/07 分层）
// ═══════════════════════════════════════════════════════════════

import type { SplitSceneRow } from './copyMontageStep1SplitLogic.ts'
import { applyShotLayoutOrder } from './copyMontageStep1SplitLogic.ts'

// ── Step2 镜头重组（/montage/concat）──────────────────────────

/** 服务端 xfade 转场安全映射，未知回退 fade（对照 _submit_concat_to_server L2692-2703） */
const SERVER_TRANSITION_MAP: Record<string, string> = {
  fade: 'fade',
  dissolve: 'dissolve',
  slideleft: 'wipeleft',
  slideright: 'wiperight',
  slideup: 'slideup',
  slidedown: 'slidedown',
  zoomin: 'circleopen',
  zoomout: 'radial',
  none: 'none',
}

export function mapTransition(transition: string): string {
  return SERVER_TRANSITION_MAP[transition] || 'fade'
}

/** 输出画幅 → width/height；source 用探测值，无效回退 1080x1920（对照 L2707-2714） */
export function layoutSize(
  layout: string, probe?: { width?: number; height?: number } | null,
): { width: number; height: number } {
  if (layout === 'horizontal') return { width: 1920, height: 1080 }
  if (layout === 'source') {
    const w = Number(probe?.width) || 0
    const h = Number(probe?.height) || 0
    if (w > 0 && h > 0) return { width: w, height: h }
  }
  return { width: 1080, height: 1920 }
}

/** Step2 输出帧率下拉选项（2026-09-11 用户裁决：帧率可控，默认「跟随原片」）。
 *  服务端 /montage/concat 契约 fps 为 integer（default 30），29.97/23.976 等
 *  小数帧率不可直传 → 档位一律取整。 */
export const FPS_OPTIONS: Array<{ label: string; value: number | 'source' }> = [
  { label: '跟随原片', value: 'source' },
  { label: '24 fps（影视）', value: 24 },
  { label: '25 fps（PAL/国内流）', value: 25 },
  { label: '30 fps（通用）', value: 30 },
  { label: '50 fps（流畅）', value: 50 },
  { label: '60 fps（高刷）', value: 60 },
]

/** 帧率选择 → 提交服务端的整数 fps。
 *  'source'（跟随原片）用 Step1 探测到的原片帧率；探测失败（0/无效）兑底 30
 *  ——与契约默认值一致，避免传 0 被服务端拒或出 0 帧产物。 */
export function resolveConcatFps(sel: number | 'source', probedFps: number): number {
  const n = sel === 'source' ? Number(probedFps) : Number(sel)
  if (!Number.isFinite(n) || n <= 0) return 30
  return Math.max(1, Math.round(n))
}

export interface ConcatPayload {
  /** 对照原版 L87 data["clip_urls"] = json.dumps(...)：multipart 表单里是 JSON 字符串 */
  clip_urls?: string
  files?: string[]
  transition: string
  transition_duration?: number
  width: number
  height: number
  fps?: number
  crf?: number
  preset?: string
  image_duration?: number
}

/**
 * 组装 /montage/concat 提交载荷（multipart）：
 * clip_urls 优先（服务端 split 片段地址，服务端内部流转免二次上传），
 * 否则本地片段 files；options 只包含契约 Body_montage_concat_montage_concat_post
 * 列出的字段（对照原注释 L2671-2672）。
 */
export function buildConcatPayload(opts: {
  clipUrls?: string[]
  files?: string[]
  transition?: string
  layout?: string
  probe?: { width?: number; height?: number } | null
  transitionDuration?: number
  fps?: number
  crf?: number
  preset?: string
  imageDuration?: number
}): ConcatPayload {
  const clipUrls = (opts.clipUrls || []).filter(Boolean)
  const files = (opts.files || []).filter(Boolean)
  if (!clipUrls.length && !files.length) {
    throw new Error('没有可合成的镜头（本地 files 或 clip_urls 至少一项）')
  }
  const { width, height } = layoutSize(opts.layout || 'vertical', opts.probe)
  const payload: ConcatPayload = {
    transition: mapTransition(opts.transition || 'fade'),
    width,
    height,
  }
  if (clipUrls.length) payload.clip_urls = JSON.stringify(clipUrls)
  if (files.length) payload.files = files
  if (opts.transitionDuration !== undefined) payload.transition_duration = Number(opts.transitionDuration)
  if (opts.fps !== undefined) payload.fps = Number(opts.fps)
  if (opts.crf !== undefined) payload.crf = Number(opts.crf)
  if (opts.preset) payload.preset = String(opts.preset)
  if (opts.imageDuration !== undefined) payload.image_duration = Number(opts.imageDuration)
  return payload
}

/** 拼接任务结果 URL 提取：video_url/url/output_url（对照 server worker L125-128） */
export function extractConcatResultUrl(result: unknown): string {
  if (!result || typeof result !== 'object') return ''
  const r = result as Record<string, unknown>
  return String(r.video_url || r.url || r.output_url || '')
}

/** 提交响应任务 ID 提取，缺失抛错（对照 server worker L103-105） */
export function extractSubmitTaskId(resp: unknown): string {
  if (!resp || typeof resp !== 'object') throw new Error('未返回任务 id')
  const r = resp as Record<string, unknown>
  const id = r.id ?? r.task_id ?? r.job_id
  if (id === undefined || id === null || id === '') throw new Error('未返回任务 id')
  return String(id)
}

// ── Step2 镜头重组·预合成方案（对照 video_montage_page.py _build_precompose_plans L5223-5344）──

/** 预合成方案（对照原版 plan dict：clips/deleted_flags/mode/confirmed/output_path） */
export interface PrecomposePlan {
  clips: SplitSceneRow[]
  deletedFlags: boolean[]
  mode: string
  confirmed: boolean
  /** 服务端成片 URL（确认合成后填充） */
  outputUrl: string
  /** 成片文件名（列表行展示） */
  outputName: string
  /** 本地成片路径（确认合成后下载落盘，供 Step4/口播配音使用） */
  outputPath: string
  /** 口播文案（生成口播文案后填充；原版同名 .txt 口径） */
  copy: string
  /** 成片实际时长（秒；确认合成后渲染层 ffmpeg:probeDuration 探测回写，0=探测中/失败） */
  durationSec?: number
}

/** 预合成行估计时长（秒）：未删除镜头时长之和（对照原版 sum(cut.end - cut.start) 口径；
 *  已合成行的实际时长走成片探测，不用此估计） */
export function planActiveDurationSec(p: PrecomposePlan): number {
  return (p.clips || []).reduce(
    (acc, c, i) => acc + (p.deletedFlags[i] ? 0 : Math.max(0, (c.endSec || 0) - (c.startSec || 0))), 0)
}

export function newPrecomposePlan(clips: SplitSceneRow[], mode = 'random'): PrecomposePlan {
  return {
    clips: [...clips],
    deletedFlags: clips.map(() => false),
    mode,
    confirmed: false,
    outputUrl: '',
    outputName: '',
    outputPath: '',
    copy: '',
  }
}

/**
 * 生成预合成方案：随机洗牌 + 时长预算 + 景别编排。
 * 对照原版 _build_precompose_plans L5223-5344：
 * - 去重后按 randomness 洗牌（low 不洗牌；medium/high 洗牌，high 每批重洗）
 * - 时长预算 max_total = duration_limit_sec × 1.1（0 = 无上限）；非首个片段放不下
 *   跳过继续找更短的（不整批中断）；候选扫描上限 max(deck×3, target×3, 1)
 * - cursor 跨批连续轮转（批间镜头错开）
 * - 跨成片镜头使用计数 usage_count：每批开始按使用次数升序稳定排序，
 *   未用过的镜头优先上场；无上限补足时也优先取使用次数最少的镜头
 * - 景别编排 apply_shot_layout_order：入场头/出场尾/其余居中
 * 架构差异（注明）：原版对镜头做感知 hash 相似去重 + 质量择优替换，
 * 本端片段在服务端无法本地计算 hash，去重退化为「同一镜头引用不重复入列」。
 */
export function buildPrecomposePlans(opts: {
  clips: SplitSceneRow[]
  batchCount: number
  durationLimitSec: number
  randomness: string
  positionOf?: (row: SplitSceneRow) => string
  randomFn?: () => number
}): PrecomposePlan[] {
  const rnd = opts.randomFn || Math.random
  // 去重（同一镜头引用只保留一份，对照原版 unique）
  const seen = new Set<number>()
  const unique: SplitSceneRow[] = []
  for (const c of opts.clips || []) {
    if (c && !seen.has(c.idx)) { seen.add(c.idx); unique.push(c) }
  }
  if (!unique.length) return []
  console.log(`[plans] 去重后 unique=${unique.length}, batchCount=${opts.batchCount}, durationLimit=${opts.durationLimitSec}s, maxTotal=${(opts.durationLimitSec > 0 ? opts.durationLimitSec * 1.1 : 0).toFixed(1)}s`)
  console.log(`[plans] 前 5 个 clip duration:`, unique.slice(0, 5).map(c => ({ idx: c.idx, dur: c.duration, name: c.name })))
  const deck = [...unique]
  if (opts.randomness !== 'low') {
    for (let i = deck.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1))
      ;[deck[i], deck[j]] = [deck[j], deck[i]]
    }
  }
  const maxTotal = opts.durationLimitSec > 0 ? opts.durationLimitSec * 1.1 : 0
  const target = unique.length
  const positionOf = opts.positionOf || ((r: SplitSceneRow) => r.position || '')
  const plans: PrecomposePlan[] = []
  let cursor = 0
  // 跨成片镜头使用计数（对照 usage_count L5786）：让全部镜头轮流上场，
  // 修复「不同成片用的镜头都一样」「出入场镜头大部分一样」的问题。
  const usageCount = new Map<number, number>()
  for (let b = 0; b < opts.batchCount; b++) {
    if (opts.randomness === 'high') {
      for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(rnd() * (i + 1))
        ;[deck[i], deck[j]] = [deck[j], deck[i]]
      }
    }
    // 均衡排序：按使用次数升序稳定排序（同频保持当前 deck 相对序），
    // 未用过的镜头自然排在最前被优先扫描；出入场镜头也随 seq 均衡轮换（L5820）
    deck.sort((a, b) => (usageCount.get(a.idx) || 0) - (usageCount.get(b.idx) || 0))
    const seq: SplitSceneRow[] = []
    let totalDur = 0
    let scanned = 0
    let ci = cursor
    const maxScan = Math.max(deck.length * 3, target * 3, 1)
    while (seq.length < target && scanned < maxScan) {
      if (maxTotal > 0 && totalDur >= maxTotal) break
      scanned++
      const clip = deck[ci % deck.length]
      ci++
      const clipDur = maxTotal > 0 ? Math.max(0, Number(clip.duration) || 0) : 0
      // 时长预算：非首个片段且放不下 → 继续试更短的（不 break 整批）
      if (maxTotal > 0 && seq.length && totalDur + clipDur > maxTotal) continue
      seq.push(clip)
      usageCount.set(clip.idx, (usageCount.get(clip.idx) || 0) + 1)
      totalDur += clipDur
    }
    cursor = ci % deck.length
    // 无时长上限时：补足到目标镜头数（优先用使用次数最少的镜头，保持均衡，L5877-5879；
    // key=(使用次数, 随机数) 字典序元组比较）
    if (maxTotal <= 0) {
      while (seq.length < target) {
        let pick = unique[0]
        let pickCnt = usageCount.get(pick.idx) || 0
        let pickRnd = rnd()
        for (const c of unique) {
          const cnt = usageCount.get(c.idx) || 0
          const rr = rnd()
          if (cnt < pickCnt || (cnt === pickCnt && rr < pickRnd)) { pick = c; pickCnt = cnt; pickRnd = rr }
        }
        seq.push(pick)
        usageCount.set(pick.idx, pickCnt + 1)
      }
    }
    // 兑底：极端情况至少保证 1 个镜头
    if (!seq.length) seq.push(unique[0])
    // 位置编排：入场头/出场尾/其余居中（有任何标注才生效，对照原版）
    let ordered = seq
    if (seq.some((c) => positionOf(c))) {
      ordered = applyShotLayoutOrder(seq, positionOf)
    }
    plans.push(newPrecomposePlan(ordered))
    console.log(`[plans] 方案 ${b + 1}: ${ordered.length} 个镜头, totalDur=${totalDur.toFixed(1)}s`)
  }
  return plans
}

// ── Step2 口播文案（2026-09-13 改调 POST /copywriting/voiceover：服务端自持 prompt，
//    按 duration_s 控字数（30s → budget 135 字）；客户端只组 payload + 解析响应）──

/**
 * 组 voiceover 请求体（契约 VoiceoverIn：product_desc 必填、duration_s (0,600]、hint 可选）：
 * 品牌/品类/型号 → product_desc（「，」连接），补充卖点 → hint；
 * 仅填了补充卖点时兜底进 product_desc（服务端 product_desc 缺失 400）。
 * duration_s 取成片实测总时长（四舍五入到 0.1s，夹 0.1-600），无有效时长回退 30s 默认值。
 */
export function buildVoiceoverPayload(opts: {
  brand?: string
  product?: string
  modelName?: string
  extra?: string
  totalDuration?: number
}): { product_desc: string; duration_s: number; hint?: string } {
  const s = (v: unknown) => String(v ?? '').trim()
  const parts = [s(opts.brand), s(opts.product), s(opts.modelName)].filter(Boolean)
  const extra = s(opts.extra)
  const product_desc = parts.join('，') || extra
  if (!product_desc) throw new Error('产品描述为空：请至少填写品牌/产品/型号之一')
  let duration_s = Number(opts.totalDuration)
  if (!Number.isFinite(duration_s) || duration_s <= 0) duration_s = 30
  duration_s = Math.min(600, Math.max(0.1, Math.round(duration_s * 10) / 10))
  const payload: { product_desc: string; duration_s: number; hint?: string } = { product_desc, duration_s }
  if (extra && parts.length) payload.hint = extra
  return payload
}

/** 解析 voiceover 响应（实测契约 {text,chars,budget,retried}），空文案报错 */
export function parseVoiceoverResponse(resp: unknown): string {
  const text = String((resp as { text?: unknown } | null | undefined)?.text ?? '').trim()
  if (!text) throw new Error('服务端未返回口播文案')
  return text
}

// ── Step2 预合成列表行文案（对照 _add_assembled_row L5383-5410）────────

/** 文案预览：前 30 字，未生成返回占位（对照 _assembled_copy_preview） */
export function copyPreviewText(copy: string): string {
  const c = String(copy || '').trim().replace(/\n/g, ' ')
  if (!c) return '未生成口播文案'
  return c.slice(0, 30) + (c.length > 30 ? '…' : '')
}

/** 预合成列表行文案：`[n] 文件名/镜头数  状态  文案预览` */
export function assembledRowText(opts: {
  index: number
  clipCount: number
  outputName: string
  confirmed: boolean
  copyPreview: string
}): string {
  const fileText = opts.outputName || `${opts.clipCount} 个镜头`
  const statusTxt = opts.confirmed && opts.outputName ? '已合成' : '待确认'
  const copyMark = opts.copyPreview ? `  ${opts.copyPreview}` : ''
  return `[${opts.index + 1}] ${fileText}  ${statusTxt}${copyMark}`
}
