// ═══════════════════════════════════════════════════════════════
// montageStep1SplitLogic.ts — 智能混剪 Step1 素材解析纯逻辑
// 自 videoMontageLogic.ts 拆分（铁律 10 / 2026-09-18，纯搬迁零行为改动，
// 拆分过程过 SKILL.md IRON-02 五项 checklist）。
// 对照原客户端 studio/gui：
//   · gui/montage/workers/split_workers.py ServerSplitWorker L121-171
//     （POST /montage/split 响应 shots[] 解析与片段行映射）
//   · utils/montage_cache.py + utils_media.safe_source_name（splits 本地缓存口径）
//   · utils_media.py PR#3 景别分类（classify_shot_type / apply_shot_layout_order）
// 本文件不做任何 IPC / DOM 操作（IRON-06/07 分层）
// ═══════════════════════════════════════════════════════════════

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
