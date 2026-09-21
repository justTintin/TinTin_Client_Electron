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
import type { StoryboardShot } from './opsStoryboardLogic.ts'

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
  /** 镜分组（2026-09-22 用户裁决：一镜多片·按时长装填）——每镜一组片段与各自
   *  使用时长（useDur < 片段全长 → 本地裁剪到该值）；预合成提交按组渲染/拼接 */
  groups?: PlanShotGroup[]
}

/** 镜分组：一镜的有序片段 + 每片使用时长（秒，与 scenes 平行对齐） */
export interface PlanShotGroup {
  scenes: SplitSceneRow[]
  useDurs: number[]
}

/** 组内每片使用时长分配（装填口径复算）：顺序消耗镜标时长，末端片段裁到剩余量；
 *  镜标 ≤0 或组短于镜标 → 片段全长使用 */
export function groupUseDurs(group: SplitSceneRow[], targetSec: number): number[] {
  let remaining = targetSec > 0 ? targetSec : Infinity
  return group.map((s) => {
    const full = Math.max(0, Number(s.duration) || 0)
    const use = Math.min(full, remaining)
    remaining -= use
    return Math.round(use * 100) / 100
  })
}

/** 分组方案是否需要本地渲染（镜内多片拼接 或 有片段被裁剪）：
 *  全部组=单片段且全长 → 走服务端 clip_urls 快路径（零本地处理） */
export function planNeedsGroupRender(groups: PlanShotGroup[]): boolean {
  return groups.some((g) => g.scenes.length > 1 ||
    g.scenes.some((s, i) => {
      const use = Number(g.useDurs[i]) || 0
      const full = Math.max(0, Number(s.duration) || 0)
      return use > 0 && use < full - 0.05
    }))
}

/** 分组化预合成方案（2026-09-22 用户裁决：一镜多片——每个分镜脚本的镜序列
 *  按组保序进入方案；clips=摊平视图供既有展示/统计兼容） */
export function buildGroupedPrecomposePlan(
  sceneGroups: SplitSceneRow[][],
  shotTargets: number[],
  mode = 'grouped',
): PrecomposePlan {
  const groups: PlanShotGroup[] = sceneGroups.map((g, i) => ({
    scenes: g,
    useDurs: groupUseDurs(g, Number(shotTargets[i]) || 0),
  }))
  const clips = groups.flatMap((g) => g.scenes)
  const plan = newPrecomposePlan(clips, mode)
  plan.groups = groups
  return plan
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

// ── 文案编写页提示词构建器（2026-09-21 用户裁决：按参考界面重排——高级脚本设置
//    （生成方式/段落数量/自定义要求/系统提示）+ AI 生成文案与关键词）──────────

/** 系统提示默认值（2026-09-21 用户定稿：Video Script Generator 角色式提示词，逐字） */
export const SCRIPT_SYSTEM_PROMPT_DEFAULT = [
  '# Role: Video Script Generator',
  '',
  '## Goals:',
  'Generate a script for a video, depending on the subject of the video.',
  '',
  '## Constrains:',
  '1. the script is to be returned as a string with the specified number of paragraphs.',
  '2. do not under any circumstance reference this prompt in your response.',
  '3. get straight to the point, don\'t start with unnecessary things like, "welcome to this video".',
  '4. you must not include any type of markdown or formatting in the script, never use a title.',
  '5. only return the raw content of the script.',
  '6. do not include "voiceover", "narrator" or similar indicators of what should be spoken at the beginning of each paragraph or line.',
  '7. you must not mention the prompt, or anything about the script itself. also, never talk about the amount of paragraphs or lines. just write the script.',
  '8. respond in the same language as the video subject.',
].join('\n')

/** 旧版默认提示词（同日早版 Constraints 七条；仅供 localStorage 一次性迁移比对——
 *  存储值恰等于它时升级为新默认，用户自定义过的提示词不动） */
export const SCRIPT_SYSTEM_PROMPT_LEGACY_DEFAULT = [
  '## Constraints:',
  '1. The script is to be returned as a string with the specified number of paragraphs.',
  '2. Do not under any circumstance reference this prompt in your response.',
  '3. Get straight to the point, don\'t start with unnecessary things like, "welcome to this video!"',
  '4. You must not include any type of markdown or formatting in the script, never use a title.',
  '5. Only return the core content of the script. Do not include OTF elements such as preface.',
  '6. I will provide the script length and I would like you to stay on the script topic at that length.',
  '7. You must not mention the prompt, or anything about the script itself. Also, never talk about the amount of paragraphs or lines, just write the script.',
].join('\n')

/** 关键词提取固定系统提示（页面「系统提示」仅约束文案生成，关键词用内置口径） */
export const KEYWORDS_SYSTEM_PROMPT =
  '你是视频关键词提取助手。从用户给出的视频文案中提取适合作为视频文字模板/花字命中依据的关键词：' +
  '只保留在文案中原文出现的词语，8-15 个，按出现顺序用中文逗号「，」分隔返回，不要序号、不要解释、不要任何其他内容。'

/** 场景选项（2026-09-21 用户裁决：场景选择——通用/口播带货/产品讲解/种草推荐；
 *  场景指令随系统提示一并发给 LLM） */
/** 场景时长节奏基准（2026-09-21 用户裁决：口播约 4 字/秒） */
export const NARRATION_CHARS_PER_SEC = 4

export interface ScriptSceneOption {
  label: string
  value: string
  /** 并入 system 提示词的场景指令 */
  directive: string
  /** 该场景的建议时长（秒）：场景切换时作为「建议时长」默认值 */
  defaultSec: number
}

export const SCRIPT_SCENE_OPTIONS: ScriptSceneOption[] = [
  {
    label: '通用', value: 'general', defaultSec: 30,
    directive: '不限定具体场景：按产品信息自然撰写一条通用的产品视频口播文案。',
  },
  {
    label: '口播带货', value: 'live_pitch', defaultSec: 30,
    directive: '口播带货场景：真人出镜口播节奏，开场即抓注意力，强化卖点与行动号召（引导下单），语气有感染力、节奏紧凑。',
  },
  {
    label: '产品讲解', value: 'explain', defaultSec: 45,
    directive: '产品讲解场景：围绕产品功能、参数与使用体验展开讲解，信息密度高，专业可信，适合深度介绍。',
  },
  {
    label: '种草推荐', value: 'seeding', defaultSec: 40,
    directive: '种草推荐场景：第一人称真实体验口吻，突出使用感受、适用人群与使用场景，柔和种草，弱化叫卖感。',
  },
]

/** 组最终 system 提示词：页面可编辑系统提示为基底，依次追加场景指令、产品信息块与
 *  自定义文案要求（均为可选——产品信息全空时省略该块；「预览最终提示词」展示的即此合并结果） */
export function buildScriptSystemPrompt(base: string, opts: {
  scene?: string
  brand?: string
  product?: string
  modelName?: string
  extra?: string
  customRequirement?: string
  suggestSec?: number
}): string {
  const parts = [String(base || '').trim()]
  const scene = SCRIPT_SCENE_OPTIONS.find((o) => o.value === opts.scene) || SCRIPT_SCENE_OPTIONS[0]
  parts.push(`## 场景\n${scene.directive}`)
  // 建议时长（2026-09-21 用户裁决：时长控制并入提示词；口播约 4 字/秒）
  const suggestRaw = Math.round(Number(opts.suggestSec) || 0)
  const suggest = suggestRaw >= 5 ? suggestRaw : 0 // 未传/过短 → 不出建议时长块
  if (suggest > 0) {
    parts.push(`## 建议时长\n约 ${suggest} 秒（口播约 ${NARRATION_CHARS_PER_SEC} 字/秒，正文控制在 ${suggest * NARRATION_CHARS_PER_SEC} 字左右）。`)
  }
  const s = (v: unknown) => String(v ?? '').trim()
  const info = [s(opts.brand), s(opts.product), s(opts.modelName)].filter(Boolean).join('，')
  const extra = s(opts.extra)
  const infoLines = [
    info ? `产品：${info}` : '',
    extra ? `核心卖点：${extra}` : '',
  ].filter(Boolean)
  if (infoLines.length) parts.push(`## 产品信息\n${infoLines.join('\n')}`)
  if (s(opts.customRequirement)) parts.push(`## 文案要求\n${s(opts.customRequirement)}`)
  return parts.join('\n\n')
}

/** 组文案生成 user prompt（产品/场景已并入 system，这里只给脚本长度与产出指令） */
export function buildScriptUserPrompt(opts: { paragraphCount: number }): string {
  const n = Math.max(1, Math.floor(Number(opts.paragraphCount) || 1))
  return `脚本长度：${n} 个段落。\n请按以上要求写一条视频口播文案，直接返回文案正文。`
}

/** 组关键词提取 user prompt（文案全文随消息给出） */
export function buildKeywordsUserPrompt(copyText: string): string {
  return `请从以下视频文案中提取关键词：\n${String(copyText || '').trim()}`
}

// ── 分镜×素材自动分配池（2026-09-21 用户裁决：素材来源将来含本地上传/在线素材/
//    在线搜索/AI 生成——分配统一走本池，并按 hash 去重）──

/** 分配池条目：key=去重键（有 hash 用 hash；分割镜头退化为 源片|起点|终点 指纹） */
export interface AssignPoolItem {
  key: string
  scene: SplitSceneRow
}

/** 分割镜头 → 去重键：同源片同一起止 = 同一内容（重复分割/重复导入去重） */
export function sceneHashKey(row: SplitSceneRow): string {
  return [String(row.sourceName || '').trim(), Number(row.startSec) || 0, Number(row.endSec) || 0].join('|')
}

/** 构建去重后的分配池：按 key 去重保序（首个入池） */
export function buildAssignPool(rows: SplitSceneRow[]): AssignPoolItem[] {
  const seen = new Set<string>()
  const pool: AssignPoolItem[] = []
  for (const r of rows || []) {
    if (!r) continue
    const key = sceneHashKey(r)
    if (seen.has(key)) continue
    seen.add(key)
    pool.push({ key, scene: r })
  }
  return pool
}

/** 把素材池循环分配给各分镜脚本（跨脚本复用 + 降低重复度：
 *  全局镜头序 k 对池循环取用，各素材被使用次数均衡）。返回每 tab 的场景 idx 矩阵 */
export function assignClipsCyclically(shotCounts: number[], pool: AssignPoolItem[]): number[][] {
  const out: number[][] = []
  let k = 0
  for (const n of shotCounts || []) {
    const row: number[] = []
    for (let s = 0; s < n; s++) {
      row.push(pool.length ? pool[k % pool.length].scene.idx : -1)
      k++
    }
    out.push(row)
  }
  return out
}

// ── AI 分镜翻译（2026-09-21 用户裁决：口播文案=旁白（作为口播连续存在，本身不是分镜）；
//    分镜脚本由 AI 根据旁白单独生成梳理（镜头=画面层，旁白按时间轴覆盖到镜头上）。
//    prompt 融合 text-storyboard skill（画面工艺规则）+ Viral_Writer skill（口播节奏：
//    黄金3秒钩子/卖点递进/金句/行动号召 → 分镜节奏跟随）；JSON 契约对齐现有分镜脚本
//    规范 opsStoryboardLogic。skill 原文存 .zcode/skills/{text-storyboard,viral-writer}/ ──

/** 镜头旁白拼接（纯文案克隆的合成全文：逐镜 audio 去空白按序拼接） */
export function shotsNarrationText(shots: StoryboardShot[]): string {
  return shots.map((s) => String(s?.audio || '').trim()).filter(Boolean).join('\n')
}

// ── 分镜 × 素材自动分配（2026-09-21 用户裁决：上传素材分割后自动分配到分镜脚本）──

/** 单镜的素材分配结果 */
export interface CopyShotAssignment {
  shot: StoryboardShot
  /** 分配到该镜的分割素材（按分割顺序；贪心装填至累计时长 ≥ 该镜时长） */
  scenes: SplitSceneRow[]
  /** 已分配素材的累计时长（秒，一位小数） */
  coveredSec: number
}

/** 分割素材 → 分镜自动分配：素材按分割顺序贪心装填，累计时长达到该镜 duration
 *  即封镜、继续下一镜（每镜至少 1 个素材）；素材耗尽时剩余分镜为空（画面层待补）。
 *  纯展示层分配（不改动勾选状态与分镜数据） */
export function assignScenesToShots(shots: StoryboardShot[], scenes: SplitSceneRow[]): CopyShotAssignment[] {
  const ordered = [...scenes].sort((a, b) => a.idx - b.idx)
  let cursor = 0
  return shots.map((shot) => {
    const target = Number(shot.duration) > 0 ? Number(shot.duration) : 0
    const picked: SplitSceneRow[] = []
    let covered = 0
    while (cursor < ordered.length && (picked.length === 0 || (target > 0 && covered < target))) {
      const s = ordered[cursor++]
      picked.push(s)
      covered += Number(s.duration) || 0
    }
    return { shot, scenes: picked, coveredSec: Math.round(covered * 10) / 10 }
  })
}

/** 组分镜翻译 prompt（system=文字分镜 skill 画面规则 + Viral Writer 口播节奏 + 现有
 *  分镜脚本 JSON 契约；旁白规则：audio=原文片段、按序覆盖全文、一字不改不丢） */
export function buildCopyStoryboardPrompt(copyText: string, ratio = 'vertical'): {
  systemPrompt: string
  userPrompt: string
} {
  const orient = ratio === 'horizontal' ? '横屏（16:9）' : '竖屏（9:16）'
  return {
    systemPrompt:
      '你是专业短视频导演兼文字分镜师。用户给出的是一条完整的口播旁白（作为口播连续存在，不是分镜）；'
      + '你的任务是根据旁白梳理出分镜脚本：把旁白按时间轴切分到各个镜头上，并为每个镜头补充画面层信息。'
      + '画面描述遵守文字分镜规则：\n'
      + '1. 用具体的物理动作，不用抽象概念（不写"很惊讶"，写"瞳孔骤然收缩、手停在半空"）。\n'
      + '2. 用连续的动作链让画面动起来，动作有先后顺序，不孤立描述单个动作。\n'
      + '3. 镜头运动要有明确方向和起止（推/拉/摇/移/跟，从哪里到哪里）。\n'
      + '4. 光影具体到方向、色温（3200K暖光/5600K日光/冷白路灯光）、强度（柔和/强烈）。\n'
      + '5. 画面、人物动作、声音、镜头运动、光影融合成流畅叙述，不列清单。\n'
      + '节奏规则（爆款口播结构）：开场钩子用快切镜头（1-3 秒）抓住注意力；核心卖点用中近景展示细节；'
      + '金句处给特写定格；结尾行动号召回归产品特写。单镜时长 2-5 秒为基准，跟随旁白情绪快慢交替。\n'
      + '旁白切分规则：audio 必须是口播文案的原文片段，按顺序切分、一字不改不丢、完整覆盖全文；'
      + 'visual 要具体到可直接作为视频生成提示词。\n'
      + '以 JSON 数组输出，每个元素含以下字段：\n'
      + '"index"(整型镜头序号), "shot_type"(镜别：特写/近景/中景/远景/全景/俯拍/仰拍/主观/空镜), '
      + '"visual"(画面描述), "audio"(旁白/台词——该镜对应的文案原文片段), '
      + '"sfx"(音效建议，无则空字符串), "duration"(建议时长秒数，整型)。\n'
      + '严格只输出 JSON 数组，不要 ```json 包裹。',
    userPrompt: `请把以下口播文案（旁白）翻译成${orient}分镜脚本：\n${String(copyText || '').trim()}`,
  }
}

/** 关键词响应 → 展示文本：剥 markdown 代码块/序号/引号，分隔符统一为「，」单行。
 *  序号形态「1. kw1，2、kw2」须在切分前剥（序号自带分隔符，切分后再剥会残留裸数字） */
export function parseKeywordsText(raw: unknown): string[] {
  const rawStr = String(raw ?? '').trim()
  // 伪 JSON 数组容错（LLM 偶发返回 ["a","b"] 形态）
  if (/^\[[\s\S]*\]$/.test(rawStr)) {
    try {
      const arr = JSON.parse(rawStr) as unknown
      if (Array.isArray(arr)) {
        return [...new Set(arr
          .map((k) => String(k).replace(/^["'「『]+|["'」』]+$/g, '').trim())
          .filter(Boolean))]
      }
    } catch { /* 非 JSON 数组 → 落回文本路径 */ }
  }
  let t = rawStr
  // ```...``` 代码块围栏
  t = t.replace(/^```[a-zA-Z]*\s*/, '').replace(/```\s*$/, '').trim()
  // 剥「1. / 2、 / 3)」类序号：分隔符后/行首的直接剥；空格分隔的序号换成中文逗号当分隔符
  t = t
    .replace(/(^|[，,、;；\n])[ \t]*\d{1,2}[.、)）][ \t]*/g, '$1')
    .replace(/[^，,、;；\n\d][ \t]+\d{1,2}[.、)）][ \t]*/g, '$1，')
  const parts = t
    .split(/[，,、;；\n]+/)
    .map((k) => k.replace(/^["'「『]+|["'」』]+$/g, '').trim())
    .filter(Boolean)
  // 去重保序
  return [...new Set(parts)]
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
