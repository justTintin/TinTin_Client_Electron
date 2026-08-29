// ═══════════════════════════════════════════════════════════════
// videoMontageLogic.ts — 智能混剪·服务端四步链路纯逻辑（M8 条目⑥ parser/builder 层）
// 对照原客户端 studio/gui：
//   · gui/montage/workers/split_workers.py ServerSplitWorker L121-171
//     （POST /montage/split 响应 shots[] 解析与片段行映射）
//   · gui/video_montage_page.py _submit_concat_to_server L2663-2725
//     （转场安全映射 SERVER_TRANSITION_MAP / layout→width,height / options 白名单）
//   · gui/montage/workers/montage_concat_server_worker.py L57-143
//     （files / clip_urls 至少一项；clip_urls 为 JSON 字符串；result.video_url/url/output_url）
//   · gui/montage/workers/split_workers.py BeatDetectWorker L341-519
//     （/audio/beatmap 节拍/片段提取）
//   · gui/montage/workers/split_workers.py BeatVideoGenWorker L526-781
//     （/montage/beat 仅传非空参数；result.variants / result.file；结果 URL 规则）
// 轮询状态机与 reversePromptVideoLogic 同口径（原版 _poll_task_result 与 unified
// 轮询一致：{data:{}} 解包 / status|state / 终态与失败态），为 node 类型剥离的
// 模块解析限制在此独立实现（两文件各自有单测覆盖，保持行为同步）。
// 组件/composable 只做编排，本文件不做任何 IPC / DOM 操作（IRON-06/07 分层）
// ═══════════════════════════════════════════════════════════════

// ── 任务轮询状态机（unified 轮询口径）────────────────────────

/** 轮询响应解包：{data:{...}} → data，裸响应原样（对照 _poll_task_result L150） */
export function extractTaskObj(resp: unknown): Record<string, unknown> {
  if (!resp || typeof resp !== 'object') return {}
  const r = resp as Record<string, unknown>
  if (r.data && typeof r.data === 'object') return r.data as Record<string, unknown>
  return r
}

export interface TaskStatusInfo {
  phase: 'running' | 'done' | 'failed'
  error: string
}

/** 任务状态映射（终态/失败态/进行中，与 unified 轮询口径一致） */
export function mapTaskStatus(status: unknown, task: Record<string, unknown> = {}): TaskStatusInfo {
  const s = String(status || '').toLowerCase()
  if (['completed', 'done', 'success', 'finished'].includes(s)) return { phase: 'done', error: '' }
  if (['failed', 'error', 'cancelled'].includes(s)) {
    const err = task.error_msg || task.error || task.message || '未知错误'
    return { phase: 'failed', error: String(err) }
  }
  return { phase: 'running', error: '' }
}

/** 轮询阶段文案（progress ≤1 视为小数 ×100；否则显示已等待秒数） */
export function pollPhaseText(progress: unknown, elapsedSec?: number): string {
  const p = Number(progress)
  if (progress !== null && progress !== undefined && progress !== '' && !Number.isNaN(p)) {
    const pct = p <= 1.0 ? p * 100 : p
    return `服务端处理中 ${Math.round(pct)}%`
  }
  return `等待服务端处理，已等待 ${Math.max(0, Math.floor(elapsedSec || 0))} 秒...`
}

// ── Step1 镜头分割（/montage/split 响应解析）──────────────────

export interface SplitShot {
  startSec: number
  endSec: number
  shotIndex: number
  filename: string
  downloadUrl: string
  score: number
  analysis: string
  description: string
}

/** /montage/split 响应 shots 归一化（对照 ServerSplitWorker L121-171；clips/segments 兜底） */
export function parseSplitResponse(resp: unknown): SplitShot[] {
  if (!resp || typeof resp !== 'object') return []
  const r = resp as Record<string, unknown>
  const raw = (r.shots || r.clips || r.segments) as unknown
  if (!Array.isArray(raw)) return []
  return raw
    .filter((s): s is Record<string, unknown> => !!s && typeof s === 'object')
    .map((s) => ({
      startSec: Number(s.start_sec) || 0,
      endSec: Number(s.end_sec ?? s.start_sec ?? 0) || 0,
      shotIndex: Math.floor(Number(s.shot_index) || 0),
      filename: String(s.filename || ''),
      downloadUrl: String(s.download_url || ''),
      score: Number(s.aesthetic_score ?? s.score) || 0,
      analysis: String(s.shot_analysis || ''),
      description: String(s.description || ''),
    }))
}

export interface SplitSceneRow {
  idx: number
  name: string
  sourceName: string
  startSec: number
  endSec: number
  duration: number
  description: string
  analysis: string
  score: number
  clipUrl: string
  downloadState: 'pending' | 'ok' | 'failed'
  checked: boolean
}

/** shots → 镜头表格行（checked 默认 true，行号从 1 起） */
export function shotsToRows(shots: SplitShot[], sourceName: string): SplitSceneRow[] {
  return shots.map((s, i) => ({
    idx: i + 1,
    name: s.filename || `${sourceName}_shot_${String(s.shotIndex || i + 1).padStart(3, '0')}.mp4`,
    sourceName,
    startSec: s.startSec,
    endSec: s.endSec,
    duration: Math.max(0, s.endSec - s.startSec),
    description: s.description,
    analysis: s.analysis,
    score: s.score,
    clipUrl: s.downloadUrl,
    downloadState: 'pending' as const,
    checked: true,
  }))
}

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

/** 提交响应任务 ID 提取，缺失抛错（对照 server worker L103-105 / beat L760-764） */
export function extractSubmitTaskId(resp: unknown): string {
  if (!resp || typeof resp !== 'object') throw new Error('未返回任务 id')
  const r = resp as Record<string, unknown>
  const id = r.id ?? r.task_id ?? r.job_id
  if (id === undefined || id === null || id === '') throw new Error('未返回任务 id')
  return String(id)
}

// ── BGM 节拍检测（/audio/beatmap，对照 BeatDetectWorker L341-519）──

export interface BeatmapPayload {
  file: string
  count?: number
  segment_duration?: number
}

/** /audio/beatmap 载荷：count>0 才传 count；segment_duration>0 才传（对照 L379-383） */
export function buildBeatmapPayload(musicPath: string, opts: { count?: number; segmentDuration?: number } = {}): BeatmapPayload {
  if (!musicPath) throw new Error('缺少音频文件')
  const p: BeatmapPayload = { file: musicPath }
  const count = Math.floor(Number(opts.count) || 0)
  const segDur = Number(opts.segmentDuration) || 0
  if (count > 0) p.count = count
  if (segDur > 0) p.segment_duration = segDur
  return p
}

/**
 * 节拍时间戳提取（对照 BeatDetectWorker._extract_beats L489-512）：
 *   1. inner = payload.data（dict 时解包）→ 首个非空数组的 beats/beat_times/timestamps/beat_points
 *   2. 命中即转换（跳过 null），任一元素无法转数值 → 整体失败 []（对照 L500-502 float() 异常）
 *   3. 未命中 → result 嵌套（beats/beat_times/timestamps）同规则（对照 L503-511）
 */
const _BEATS_KEYS = ['beats', 'beat_times', 'timestamps', 'beat_points'] as const

/** 列表 → 数值升序；null 跳过、不可转换 → null（整体失败，对照 L500 float(b) if b is not None） */
function _toSortedBeats(arr: unknown[]): number[] | null {
  const out: number[] = []
  for (const b of arr) {
    if (b === null || b === undefined) continue
    const v = typeof b === 'number' ? b : (typeof b === 'string' || typeof b === 'boolean' ? Number(b) : Number.NaN)
    if (Number.isNaN(v)) return null
    out.push(v)
  }
  return out.sort((a, b) => a - b)
}

export function extractBeats(payload: unknown): number[] {
  if (!payload || typeof payload !== 'object') return []
  let inner = payload as Record<string, unknown>
  if (inner.data && typeof inner.data === 'object') inner = inner.data as Record<string, unknown>
  for (const k of _BEATS_KEYS) {
    const v = inner[k]
    if (Array.isArray(v) && v.length) return _toSortedBeats(v) ?? []
  }
  const res = inner.result
  if (res && typeof res === 'object') {
    const r = res as Record<string, unknown>
    for (const k of _BEATS_KEYS) {
      const v = r[k]
      if (Array.isArray(v) && v.length) return _toSortedBeats(v) ?? []
    }
  }
  return []
}

export interface BeatClip {
  start: number
  end: number
  strength: number
}

/** 片段提取：{start,end,strength} 按 start 排序、过滤非法（对照 L478-519） */
export function extractBeatClips(payload: unknown): BeatClip[] {
  if (!payload || typeof payload !== 'object') return []
  const inner = payload as Record<string, unknown>
  let raw = inner.clips
  if (!Array.isArray(raw) && inner.result && typeof inner.result === 'object') {
    raw = (inner.result as Record<string, unknown>).clips
  }
  if (!Array.isArray(raw)) return []
  const out: BeatClip[] = []
  for (const c of raw) {
    if (!c || typeof c !== 'object') continue
    const o = c as Record<string, unknown>
    if (o.start === undefined || o.end === undefined) continue
    const start = Number(o.start)
    const end = Number(o.end)
    if (Number.isNaN(start) || Number.isNaN(end) || end <= start) continue
    const sRaw = o.strength === undefined || o.strength === null ? 1.0 : Number(o.strength)
    const strength = Number.isNaN(sRaw) ? 1.0 : sRaw
    out.push({ start, end, strength })
  }
  return out.sort((a, b) => a.start - b.start)
}

// ── 卡点成片（/montage/beat，对照 BeatVideoGenWorker L526-781）──

export interface BeatPayload {
  music: string
  videos: string[]
  count?: number
  time_limit?: number
  variant_count?: number
  min_duration?: number
  max_duration?: number
  width?: number
  height?: number
  fps?: number
  crf?: number
  transition?: string
  transition_duration?: number
  aspect_ratio?: string
}

/** /montage/beat 载荷：仅传非空参数（对照 _submit_one L721-728） */
export function buildBeatPayload(opts: BeatBuildOptions): BeatPayload {
  if (!opts.music) throw new Error('缺少音乐文件')
  const videos = (opts.videos || []).filter(Boolean)
  if (!videos.length) throw new Error('没有可上传的镜头视频')
  const p: BeatPayload = { music: opts.music, videos }
  const num = (v: unknown): number | undefined => {
    const n = Number(v)
    return v !== undefined && v !== null && v !== '' && !Number.isNaN(n) && n > 0 ? n : undefined
  }
  const count = Math.floor(Number(opts.count) || 0)
  if (count > 0) p.count = count
  const tl = num(opts.timeLimit); if (tl !== undefined) p.time_limit = tl
  const vc = Math.floor(Number(opts.variantCount) || 0)
  if (vc > 0) p.variant_count = vc
  const md = num(opts.minDuration); if (md !== undefined) p.min_duration = md
  const xd = num(opts.maxDuration); if (xd !== undefined) p.max_duration = xd
  const w = Math.floor(Number(opts.width) || 0); if (w > 0) p.width = w
  const h = Math.floor(Number(opts.height) || 0); if (h > 0) p.height = h
  const fps = Math.floor(Number(opts.fps) || 0); if (fps > 0) p.fps = fps
  const crf = Math.floor(Number(opts.crf) || 0); if (crf > 0) p.crf = crf
  if (opts.transition) p.transition = String(opts.transition)
  const td = num(opts.transitionDuration); if (td !== undefined) p.transition_duration = td
  if (opts.aspectRatio) p.aspect_ratio = String(opts.aspectRatio)
  return p
}

export interface BeatVariant {
  variant: number
  file: string
}

/** buildBeatPayload 入参（camelCase 构建选项；输出 BeatPayload 为契约 snake_case 字段） */
export interface BeatBuildOptions {
  music?: string
  videos?: string[]
  count?: number
  timeLimit?: number
  variantCount?: number
  minDuration?: number
  maxDuration?: number
  width?: number
  height?: number
  fps?: number
  crf?: number
  transition?: string
  transitionDuration?: number
  aspectRatio?: string
}

/** 变体提取：result.variants 优先；否则 result.file 单变体（对照 L624-653） */
export function extractBeatVariants(result: unknown): BeatVariant[] {
  if (!result || typeof result !== 'object') return [{ variant: 1, file: '' }]
  const r = result as Record<string, unknown>
  if (Array.isArray(r.variants) && r.variants.length) {
    return r.variants.map((v, i) => {
      const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
      return {
        variant: Math.floor(Number(o.variant) || i + 1),
        file: String(o.file || ''),
      }
    })
  }
  return [{ variant: 1, file: String(r.file || '') }]
}

/** 结果下载 URL：http 原样 / / 前缀拼 server / 否则 /montage/result/{task}[/{variant}]（对照 _download L767-775） */
export function buildResultUrl(
  serverUrl: string, taskId: string, fileRef: string, variantIndex?: number,
): string {
  const base = String(serverUrl || '').replace(/\/$/, '')
  if (/^https?:\/\//i.test(fileRef)) return fileRef
  if (fileRef && fileRef.startsWith('/')) return base + fileRef
  const v = Math.floor(Number(variantIndex) || 0)
  return v > 0
    ? `${base}/montage/result/${taskId}/${v}`
    : `${base}/montage/result/${taskId}`
}

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
