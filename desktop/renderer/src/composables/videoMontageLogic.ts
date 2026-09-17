// ═══════════════════════════════════════════════════════════════
// videoMontageLogic.ts — 智能混剪·服务端四步链路纯逻辑（M8 条目⑥ parser/builder 层）
// 对照原客户端 studio/gui：
//   · gui/montage/workers/split_workers.py ServerSplitWorker L121-171
//     （POST /montage/split 响应 shots[] 解析与片段行映射）
//   · gui/video_montage_page.py _submit_concat_to_server L2663-2725
//     （转场安全映射 SERVER_TRANSITION_MAP / layout→width,height / options 白名单）
//   · gui/montage/workers/montage_concat_server_worker.py L57-143
//     （files / clip_urls 至少一项；clip_urls 为 JSON 字符串；result.video_url/url/output_url）
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
    const err = task.error_msg || task.error || task.message
      // cancelled 且无 error_msg：服务端运行中重启会把任务置 cancelled（实测 705：
      // result={cancelled:true}）——报「未知错误」误导，改为可行动的文案
      || (s === 'cancelled' ? '服务端任务被取消（可能因服务端重启中断），请重新提交' : '未知错误')
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
  /** 服务端绝对路径（resolve_asset 白名单内，可直接喂 /montage/concat 的 clip_urls） */
  serverPath: string
  score?: number
  analysis: string
  description: string
  /** 景别（仅服务端 shot_analysis.shot_type；2026-09-09 裁决：景别客户端不自行推断） */
  shotType: string
  /** 服务端位置标注（/montage/split 逐镜 enter/exit 布尔，2026-09-09 实测确认；
   *  出场命名素材亦返回 false——服务端暂未实际标注，false 视同未标注由渲染层兑底） */
  enter?: boolean
  exit?: boolean
  /** 产品（服务端逐镜分析，多数为空） */
  product: string
  /** 型号（同上） */
  model: string
  /** 画幅 WxH（服务端逐镜返回对象 {width,height}，2026-09-11 实测；空则 UI 用
   *  ffprobe 探测源片结果兜底） */
  resolution: string
}

/** /montage/split 响应 shots 归一化（对照 ServerSplitWorker L121-171；clips/segments 兜底）
 *  服务端实际返回：
 *    aesthetic_score: {total: 4.4, clarity: 1.0, composition: 7.5, engine: "laion+opencv"}
 *    shot_analysis:   {shot_type: "空镜", visual_type: "外观", scene_primary: "...", confidence: 0.95}
 *  顶层无 shot_type 字段，需从 shot_analysis.shot_type 取。
 */
export function parseSplitResponse(resp: unknown): SplitShot[] {
  if (!resp || typeof resp !== 'object') return []
  const r = resp as Record<string, unknown>
  const raw = (r.shots || r.clips || r.segments) as unknown
  if (!Array.isArray(raw)) return []
  return raw
    .filter((s): s is Record<string, unknown> => !!s && typeof s === 'object')
    .map((s) => {
      // aesthetic_score 可能是数字（旧版）或对象 {total, clarity, ...}
      const rawScore = s.aesthetic_score ?? s.score
      let score: number | undefined
      if (rawScore != null) {
        if (typeof rawScore === 'object' && rawScore !== null) {
          score = Number((rawScore as Record<string, unknown>).total) || undefined
        } else {
          score = Number(rawScore) || undefined
        }
      }
      // shot_type 嵌套在 shot_analysis 对象内，顶层不存在
      const analysis = s.shot_analysis
      const shotType = String(
        (analysis && typeof analysis === 'object' ? (analysis as Record<string, unknown>).shot_type : s.shot_type) || ''
      )
      const analysisText = analysis && typeof analysis === 'object'
        ? String((analysis as Record<string, unknown>).scene_primary || (analysis as Record<string, unknown>).visual_type || '')
        : String(analysis || '')
      return {
        startSec: Number(s.start_sec) || 0,
        endSec: Number(s.end_sec ?? s.start_sec ?? 0) || 0,
        shotIndex: Math.floor(Number(s.shot_index) || 0),
        filename: String(s.filename || ''),
        downloadUrl: String(s.download_url || ''),
        serverPath: String(s.path || ''),
        score,
        analysis: analysisText,
        description: String(s.description || ''),
        shotType,
        enter: !!s.enter,
        exit: !!s.exit,
        product: String((analysis && typeof analysis === 'object' ? (analysis as Record<string, unknown>).product : s.product) || ''),
        model: String((analysis && typeof analysis === 'object' ? (analysis as Record<string, unknown>).model : s.model) || ''),
        // 逐镜画幅：服务端返回对象 {width,height}（2026-09-11 在线实测），
        // 统一归一化为 "WxH"——旧实现 String(对象) 直接渲染成 "[object Object]"
        resolution: normalizeSourceResolution(s.resolution),
      }
    })
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
  score?: number
  clipUrl: string
  /** 服务端绝对路径（resolve_asset 白名单内，/montage/concat clip_urls 用此字段） */
  serverPath: string
  downloadState: 'pending' | 'ok' | 'failed'
  /** 本地 splits 目录落盘路径（分割后批量下载填充；空=未落盘，预览回退内嵌） */
  clipLocalPath?: string
  checked: boolean
  /** 景别（仅服务端 shot_analysis.shot_type，客户端不自行推断，空则 UI 显 —） */
  shotType?: string
  /** 位置（2026-09-09 裁决与 /montage/split 对齐：位置≠景别，指入场/出场等叙事位置）：
   *  服务端 enter/exit 布尔优先，否则按源素材文件名/文件夹命名兜底推断（原 classify 口径） */
  position?: string
  /** 位置来源描述：服务端标注 / 文件名「xx」/ 文件夹「xx」；空=未标注 */
  positionSource?: string
  /** PR#4 条目10：本地已裁剪替换（concat 需改走本地 files 上传，服务端 clip 指向未裁剪原件） */
  trimmed?: boolean
  product?: string   // 产品列（服务端逐镜分析，空则 UI 显 —）
  model?: string     // 型号列（同上）
  resolution?: string // 画幅列（服务端返回，空则 UI 用 ffprobe 探测源片结果兜底）
}

/** shots → 镜头表格行（checked 默认 true，行号从 1 起；sourcePath 用于「位置」兜底推断——
 *  景别仅认服务端返回；位置服务端 enter/exit 优先、路径命名兜底，2026-09-09 裁决） */
export function shotsToRows(shots: SplitShot[], sourceName: string, sourcePath?: string): SplitSceneRow[] {
  const detail = sourcePath ? classifyShotTypeDetail(sourcePath) : null
  // 位置兑底只认入场/出场（2026-09-09 用户裁决二次纠偏：特写/中景是景别不是位置，
  //  不得因文件名含「特写」就标进位置列；原版消费侧也只挑 entrance/exit 参与出入场
  //  裁剪/加速，medium/closeup 命中仅用于素材列表景别徽章展示）
  const posType = detail && (detail.type === 'entrance' || detail.type === 'exit') ? detail.type : ''
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
    serverPath: s.serverPath,
    downloadState: 'pending' as const,
    checked: true,
    // 景别：仅服务端 shot_analysis.shot_type，客户端不自行推断（2026-09-09 裁决）
    ...(s.shotType ? { shotType: s.shotType } : {}),
    // 位置：服务端 enter/exit 标注优先；否则按源素材文件名/文件夹命名兑底（仅入场/出场）
    //（2026-09-09 实测：服务端 enter/exit 恒 false——出场命名素材亦然，false 视同未标注回退路径推断）
    ...(s.enter
      ? { position: 'entrance', positionSource: '服务端标注' }
      : s.exit
        ? { position: 'exit', positionSource: '服务端标注' }
        : posType
          ? { position: posType, positionSource: detail!.origin === 'file' ? `文件名「${detail!.seg}」` : `文件夹「${detail!.seg}」` }
          : {}),
    ...(s.product ? { product: s.product } : {}),
    ...(s.model ? { model: s.model } : {}),
    ...(s.resolution ? { resolution: s.resolution } : {}),
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

// ── Step1 splits 本地缓存目录（对齐 utils/montage_cache.py + utils_media.safe_source_name）──

/** 出入场片段时长上限（秒；对照 utils_media.py EDGE_CLIP_MAX_SEC L63） */
export const EDGE_CLIP_MAX_SEC = 4.0

/** 收集出入场超长片段裁剪任务（对照 _maybe_trim_edge_clips L1729-1747 扫描口径：
 *  位置 entrance/exit 且时长 > 阈值；本端位置取行 position（服务端 enter/exit 优先，
 *  路径推断兜底，2026-09-09 裁决），起止秒取行 startSec/endSec（原版从文件名解析） */
export function collectEdgeTrimJobs(rows: SplitSceneRow[]): Array<{
  path: string; startSec: number; endSec: number; idx: number; desc: string; position: string
}> {
  return (rows || [])
    .filter((r) => r.clipLocalPath
      && (r.position === 'entrance' || r.position === 'exit')
      && r.duration > EDGE_CLIP_MAX_SEC + 0.01)
    .map((r) => ({
      path: r.clipLocalPath as string,
      startSec: r.startSec,
      endSec: r.endSec,
      idx: r.idx,
      desc: r.description || '',
      position: r.position || '',
    }))
}

/**
 * 视频文件名 → 统一短源名（splits 目录名/片段文件名共用）。
 * 对照原客户端 gui/montage/utils_media.py safe_source_name(max_len=40)：
 * 替换半角非法字符与控制字符为 _、折叠连续空白、剔除首尾点；
 * 超长截断并附 8 位散列后缀保证唯一（原版 md5 前 8 位；渲染层无 node
 * crypto，用 djb2 32bit hex 等效唯一性——架构差异，目的相同）。
 */
export function safeSourceName(name: string, maxLen = 40): string {
  const base = String(name || '').replace(/\.[^.]+$/, '')
  let cleaned = (base || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
  cleaned = cleaned.replace(/\s+/g, ' ').trim().replace(/^\.+|\.+$/g, '')
  if (!cleaned) cleaned = 'video'
  if (cleaned.length > maxLen) {
    let h = 5381
    for (let i = 0; i < base.length; i++) h = ((h << 5) + h + base.charCodeAt(i)) | 0
    const digest = (h >>> 0).toString(16).padStart(8, '0')
    cleaned = cleaned.slice(0, maxLen) + '_' + digest
  }
  return cleaned
}

/**
 * 归一化服务端 split 响应的画幅值（原片 source_resolution 与逐镜 resolution 共用）。
 * 对照原版 _detect_and_show_source_resolution L4768-4773（[w,h] 数组 / "WxH" 字符串），
 * 2026-09-11 在线实测补第三形态：**对象 {width,height}**——旧实现落到 String(obj)
 * 分支，表格画幅列直接显示 "[object Object]"（shots[].resolution 实测即为对象）；
 * 无效返回空串，由调用方回退本地探测。
 */
export function normalizeSourceResolution(value: unknown): string {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const o = value as Record<string, unknown>
    const w = Math.floor(Number(o.width ?? o.w))
    const h = Math.floor(Number(o.height ?? o.h))
    return w > 0 && h > 0 ? `${w}x${h}` : ''
  }
  if (Array.isArray(value) && value.length === 2) {
    const w = Math.floor(Number(value[0]))
    const h = Math.floor(Number(value[1]))
    return w > 0 && h > 0 ? `${w}x${h}` : ''
  }
  const s = String(value || '').trim()
  const m = /^(\d+)x(\d+)$/.exec(s)
  return m && Number(m[1]) > 0 && Number(m[2]) > 0 ? s : ''
}

/**
 * Step2 画幅基准（2026-09-15 用户裁决：「与原视频一致」的基准=分割片段，非原素材——
 * 服务端分割产物已统一缩放（4K 竖屏素材出 1080x1920），旧实现把 split 响应的
 * source_resolution（原素材 4K）当画幅基准，预合成被撑成 4K/横屏）。
 * 取值链：① 逐镜画幅（服务端 shots[].resolution，分割产物口径，取首个非空）
 *         ② source_resolution 兜底（响应缺逐镜画幅时的降级，仅此一档——
 *            本地探测首个片段由调用方在两者皆缺时执行）。
 * 入参均应为 normalizeSourceResolution 归一化后的 "WxH"；无效返回 ''。
 */
export function resolveSplitBaselineResolution(
  shotResolutions: ReadonlyArray<string | undefined>, serverSourceResolution?: string,
): string {
  for (const r of shotResolutions || []) {
    if (r) return r
  }
  return serverSourceResolution || ''
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

// ── 素材常量与景别分类（对齐原客户端 utils_media.py PR#3）──────────

/** Step1 原始素材支持的视频扩展名（与 VideoMontage.vue 文件选择器共用） */
export const VIDEO_EXTS = ['.mp4', '.mov', '.avi', '.mkv', '.flv', '.webm', '.m4v'] as const

/** 单次导入素材数量上限：防止误选整个媒体库时把上万个文件塞进列表卡死 UI */
export const MAX_SOURCE_VIDEOS = 500

/** 遍历素材文件夹时跳过的子目录名：混剪流程自身产物的派生目录，
 *  避免把上一次生成的镜头片段/配音/成片当成原始素材再喂回流程。 */
export const DERIVED_DIR_NAMES = new Set([
  'splits', 'output', 'outputs', 'final', 'dubbed', 'bgm', 'temp', 'montage_cache',
])

/** 景别分类关键词（大小写不敏感子串匹配）。
 *  与 docs/服务端景别分类与镜头编排需求.md 保持一致。 */
export const SHOT_TYPE_KEYWORDS: Record<string, readonly string[]> = {
  entrance: ['入场', '进场', '开场', 'entrance'],
  exit:     ['出场', '离场', '退场', '收尾', 'exit'],
  medium:   ['中景', 'medium shot', 'medium_shot'],
  closeup:  ['特写', 'closeup', 'close-up', 'close_up'],
}

/** 景别键 → 中文名（UI 展示与文档用） */
export const SHOT_TYPE_LABELS: Record<string, string> = {
  entrance: '入场', exit: '出场', medium: '中景', closeup: '特写',
}

/** 景别键 → 列表项前景色（素材列表里一眼区分景别；未标注保持默认色） */
export const SHOT_TYPE_COLORS: Record<string, string> = {
  entrance: '#2ecc71',  // 绿：入场
  exit:     '#e67e22',  // 橙：出场
  medium:   '#3498db',  // 蓝：中景
  closeup:  '#9b59b6',  // 紫：特写
}

/**
 * 按「文件夹/文件命名」识别素材景别（入场/出场/中景/特写）。
 * 对照原客户端 utils_media.py classify_shot_type()。
 *
 * 规则：
 * - 关键词为大小写不敏感的子串匹配（见 SHOT_TYPE_KEYWORDS）；
 * - 优先匹配文件名（去扩展名），其次父目录由深到浅逐级匹配，命中即返回；
 * - 均未命中返回 ""（未标注，编排时当中间镜头处理）。
 */
export function classifyShotType(filePath: string): string {
  return classifyShotTypeDetail(filePath).type
}

/** 景别推断详情：type=景别键，seg=命中段文本，origin=命中位置（file=文件名 / dir=父目录）。
 *  供分割表「位置」列兑底（仅取 entrance/exit 两键，特写/中景不进位置列）与
 *  素材列表景别徽章（四键全用，2026-09-09 用户裁决：出场/入场是路径命名推断，
 *  非 AI 分析，需在表里展示它是如何来的）。 */
export function classifyShotTypeDetail(filePath: string): { type: string; seg: string; origin: 'file' | 'dir' } {
  if (!filePath) return { type: '', seg: '', origin: 'file' }
  // 取文件名（去扩展名）+ 父目录由深到浅
  const parts = filePath.replace(/\\/g, '/').split('/')
  const fileName = parts[parts.length - 1] || ''
  const nameNoExt = fileName.replace(/\.[^.]+$/, '')
  const dirs = parts.slice(0, -1).filter(Boolean).reverse()
  const segs = [nameNoExt, ...dirs]
  for (let si = 0; si < segs.length; si++) {
    const low = segs[si].toLowerCase()
    for (const [st, kws] of Object.entries(SHOT_TYPE_KEYWORDS)) {
      if (kws.some((kw) => low.includes(kw))) return { type: st, seg: segs[si], origin: si === 0 ? 'file' : 'dir' }
    }
  }
  return { type: '', seg: '', origin: 'file' }
}

/**
 * 按景别编排镜头顺序：入场放头部、出场放尾部，其余（含未标注）居中混排。
 * 对照原客户端 utils_media.py apply_shot_layout_order()。
 *
 * - 各分组内保持原相对顺序（稳定排序，不额外洗牌，中景/特写天然交错）；
 * - 没有任何入场/出场标注时原样返回（不影响无景别素材的既有行为）。
 */
export function applyShotLayoutOrder<T>(
  seq: T[],
  shotTypes: Map<T, string> | Record<string, string> | ((item: T) => string),
): T[] {
  const clips = [...seq]
  if (!clips.length) return clips
  const getType = (c: T): string => {
    if (typeof shotTypes === 'function') return (shotTypes as (item: T) => string)(c)
    if (shotTypes instanceof Map) return shotTypes.get(c) || ''
    return (shotTypes as Record<string, string>)[String(c)] || ''
  }
  const heads = clips.filter((c) => getType(c) === 'entrance')
  const tails = clips.filter((c) => getType(c) === 'exit')
  if (!heads.length && !tails.length) return clips
  const middle = clips.filter((c) => {
    const t = getType(c)
    return t !== 'entrance' && t !== 'exit'
  })
  return [...heads, ...middle, ...tails]
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

/** 从完整路径取 basename（渲染层无 node path） */
export function pathBasename(p: string): string {
  const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'))
  return i >= 0 ? p.slice(i + 1) : p
}

/** 从完整路径取不带扩展名的 basename（渲染层无 node path；对照 path.basename(p, ext)） */
export function pathStem(p: string): string {
  const b = pathBasename(p)
  const i = b.lastIndexOf('.')
  return i > 0 ? b.slice(0, i) : b
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

// ══ Step3 读音/花字/字幕下拉选项（对照 step3_voice_view.py 逐字）════

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
