// ═══════════════════════════════════════════════════════════════
// opsStoryboardLogic — 分镜脚本创作·纯函数层（无 vue / IPC 依赖）
// 对照原客户端 gui/storyboard_page.py：
//   · 生成 prompt（L2219-2230）：导演人设 + JSON 数组字段约定
//   · 解析（_fill_storyboard L2234-2254）：剥 ``` 包裹 / 失败回退单镜
//   · 镜头默认值（_make_shot_card / _render_shots L2130-2142）
//   · 服务端契约（_upload_storyboard_to_server L1564-1603）：
//     narration → audio；material_id int 化；saved_at 秒级 ISO；
//     product{brand,model,category,name} + 顶层同名四字段
//   · topic 清洗（L1496）：[\\/:*?"<>|\r\n\t] → '_'，截 40
// 服务端 Schema（API-GUIDE 已核实）：ScriptIn/Shot/ProductRef。
// ═══════════════════════════════════════════════════════════════

/* ── 画幅 ───────────────────────────────────────────────────── */

export const RATIO_OPTIONS = ['9:16', '16:9', '1:1'] as const

export function ratioToOrient(ratio: string): string {
  return { '9:16': '竖屏', '16:9': '横屏', '1:1': '方形' }[ratio] ?? ratio
}

export function ratioToOrientFull(ratio: string): string {
  return { '9:16': '竖屏（9:16）', '16:9': '横屏（16:9）', '1:1': '方形（1:1）' }[ratio] ?? ratio
}

/* ── 生成 prompt（对齐 L2219-2230） ──────────────────────────── */

export function buildStoryboardPrompt(copyText: string, ratio: string): {
  systemPrompt: string
  userPrompt: string
} {
  const orient = ratioToOrientFull(ratio)
  return {
    systemPrompt:
      '你是专业短视频导演，把视频文案拆解为专业分镜脚本。'
      + '每个镜头需要包含镜别、画面描述、旁白台词、音效建议、建议时长（秒）。',
    userPrompt:
      `请把以下短视频文案拆解为分镜脚本（${orient}画幅），约 9 个镜头，`
      + '以 JSON 数组输出，每个元素含以下字段：\n'
      + '  "index"(整型镜头序号), "shot_type"(镜别，如特写/近景/中景/远景/全景/俯拍/仰拍/主观/空镜), '
      + '"visual"(画面描述，可作为即梦出图提示词), "audio"(旁白/台词), '
      + '"sfx"(音效建议，如无则留空字符串), "duration"(建议时长秒数，整型)。\n'
      + '严格只输出 JSON 数组，不要 ```json 包裹。\n\n文案：\n' + copyText,
  }
}

/* ── 解析（对齐 _fill_storyboard） ───────────────────────────── */

export interface StoryboardShot {
  index: number
  shot_type: string
  visual: string
  audio: string
  sfx: string
  duration: number
  /** 素材绑定（服务端 Shot 契约字段） */
  material_path: string
  material_type: string
  material_hash: string
  material_id: number
  /** 展示辅助（不上传）：素材名 */
  material_name?: string
}

/** 镜头默认值归一（对齐 _render_shots L2130-2142） */
export function normalizeShot(raw: unknown, fallbackIndex: number): StoryboardShot {
  const s = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  let index = fallbackIndex
  const idxRaw = Number(s.index)
  if (Number.isFinite(idxRaw) && idxRaw > 0) index = Math.trunc(idxRaw)
  const durRaw = Number(s.duration)
  return {
    index,
    shot_type: String(s.shot_type ?? '') || '近景',
    visual: String(s.visual ?? ''),
    audio: String(s.audio ?? ''),
    sfx: String(s.sfx ?? ''),
    duration: Number.isFinite(durRaw) && durRaw > 0 ? durRaw : 5,
    material_path: String(s.material_path ?? ''),
    material_type: String(s.material_type ?? ''),
    material_hash: String(s.material_hash ?? ''),
    material_id: toMaterialId(s.material_id),
  }
}

function toMaterialId(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) ? Math.trunc(n) : 0
}

export interface ParseStoryboardResult {
  shots: StoryboardShot[]
  /** 解析失败时的原始回退标记（对齐 L2247-2248：原始结果放入第一格） */
  fallback: boolean
}

/** LLM 输出 → 镜头数组：剥 ``` 包裹 → JSON 解析 → 失败回退单镜 */
export function parseStoryboardShots(content: string): ParseStoryboardResult {
  let text = (content || '').trim()
  if (text.startsWith('```')) {
    text = text.replace(/^`+/, '').replace(/`+$/, '')
    if (text.toLowerCase().startsWith('json')) text = text.slice(4)
    text = text.trim()
  }
  let arr: unknown
  try {
    arr = JSON.parse(text)
  } catch (_) {
    arr = null
  }
  if (!Array.isArray(arr)) {
    return {
      shots: [normalizeShot({ index: 1, visual: content, audio: '', sfx: '', duration: 5 }, 1)],
      fallback: true,
    }
  }
  return { shots: arr.map((s, i) => normalizeShot(s, i + 1)), fallback: false }
}

/** 镜头总时长（秒） */
export function totalDuration(durations: number[]): number {
  return durations.reduce((acc, d) => acc + (Number(d) || 0), 0)
}

/* ── topic 清洗 / 默认命名（对齐 L1496 + _default_storyboard_name） ── */

export function sanitizeTopic(topic: string): string {
  return (topic || '').replace(/[\\/:*?"<>|\r\n\t]/g, '_').slice(0, 40)
}

/** 默认 topic：分镜脚本_YYYYMMDD_HHMM（原版为文案标题+日期；新端无飞书选题，取时间戳） */
export function defaultStoryboardTopic(now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  const d = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}`
  const t = `${p(now.getHours())}${p(now.getMinutes())}`
  return `分镜脚本_${d}_${t}`
}

/* ── 已有脚本·继续创作（对齐 _continue_from_script/_apply_server_script
      L1781-1822 + storyboard_client.py list/get 注释口径） ─────────── */

/** 脚本列表摘要项（GET /api/storyboard/scripts → [{id, topic, ratio, shot_count, saved_at}]） */
export interface ScriptSummary {
  id: string
  topic: string
  ratio: string
  shotCount: number
  savedAt: string
}

/** {items}|{data}|{results}|裸数组 容错展开（同产品库域口径） */
export function extractScriptItems(data: unknown): Record<string, unknown>[] {
  if (Array.isArray(data)) return data as Record<string, unknown>[]
  if (data && typeof data === 'object') {
    for (const key of ['items', 'data', 'results']) {
      const v = (data as Record<string, unknown>)[key]
      if (Array.isArray(v)) return v as Record<string, unknown>[]
    }
  }
  return []
}

/** 列表摘要项 → 下拉选项（label 对齐原版 L1769-1771：[选题] N镜 · 保存时间） */
export function toScriptOption(it: Record<string, unknown>): ScriptSummary | null {
  const id = String(it.id ?? '').trim()
  if (!id) return null
  const saved = String(it.saved_at ?? '').trim()
  return {
    id,
    topic: String(it.topic ?? '').trim(),
    ratio: String(it.ratio ?? '').trim(),
    shotCount: Number(it.shot_count) || 0,
    savedAt: saved,
  }
}

export interface ScriptDetail {
  topic: string
  ratio: string
  shots: Record<string, unknown>[]
  product: Record<string, string>
}

/**
 * 脚本详情响应解析（GET /api/storyboard/scripts/{id} 响应为空 schema）。
 * 兼容 {script:{...}} 包裹 / 裸 dict；字段宽容取值；产品上下文对齐
 * _apply_server_script L1811-1819：script.product 优先，顶层同名四字段兑底。
 */
export function parseScriptDetail(data: unknown): ScriptDetail | null {
  if (!data || typeof data !== 'object') return null
  const raw = data as Record<string, unknown>
  const s = (raw.script && typeof raw.script === 'object' ? raw.script : raw) as Record<string, unknown>
  const prodRaw = s.product && typeof s.product === 'object' ? (s.product as Record<string, unknown>) : {}
  const pick = (k: string): string => String(prodRaw[k] ?? s[k] ?? '')
  const shots = Array.isArray(s.shots) ? (s.shots as Record<string, unknown>[]) : []
  return {
    topic: String(s.topic ?? '').trim(),
    ratio: String(s.ratio ?? '').trim(),
    shots,
    product: {
      brand: pick('brand'),
      model: pick('model'),
      category: pick('category'),
      name: pick('name'),
    },
  }
}

/** 视频文案 = 镜头旁白拼接（_apply_server_script L1801-1802 口径） */
export function copyFromShots(shots: Record<string, unknown>[]): string {
  const lines = shots
    .map((sh) => String((sh as Record<string, unknown>).audio ?? '').trim())
    .filter(Boolean)
  return lines.join('\n')
}

/* ── 大模型调整文案（对齐 _adjust_copy L1852-1871） ───────────── */

export function buildAdjustCopyPrompt(input: {
  copyText: string
  extraPrompt?: string
  styleText?: string
}): { systemPrompt: string; userPrompt: string } {
  const parts = [`原始视频文案：\n${input.copyText}`]
  if (input.styleText?.trim()) parts.push(`风格化要求（HOW to write）：\n${input.styleText.trim()}`)
  if (input.extraPrompt?.trim()) parts.push(`额外要求：\n${input.extraPrompt.trim()}`)
  parts.push('请根据以上要求重新输出优化后的视频文案，保持核心信息不变，只调整表达风格和措辞。')
  return {
    systemPrompt: '你是专业的短视频文案创作者，根据用户要求对视频文案进行优化和调整。',
    userPrompt: parts.join('\n\n'),
  }
}

/* ── 服务端保存契约（ScriptIn，对齐 L1564-1603） ─────────────── */

export interface ScriptProductRef {
  brand: string
  model: string
  category: string
  name: string
}

export interface ScriptSaveInput {
  topic: string
  ratio: string
  shots: StoryboardShot[]
  product?: Partial<ScriptProductRef> | null
  now?: Date
}

/** 渲染层镜头 → 服务端 Shot（narration→audio 已在字段层；material_id int 化） */
export function toServerShot(s: StoryboardShot): Record<string, unknown> {
  return {
    index: s.index,
    shot_type: s.shot_type,
    duration: s.duration,
    visual: s.visual,
    audio: s.audio,
    sfx: s.sfx,
    material_path: s.material_path,
    material_type: s.material_type,
    material_hash: s.material_hash,
    material_id: toMaterialId(s.material_id),
  }
}

export function buildScriptPayload(input: ScriptSaveInput): Record<string, unknown> {
  const shots = (input.shots || []).map(toServerShot)
  const prod = input.product || {}
  const now = input.now ?? new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  const savedAt = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`
    + `T${p(now.getHours())}:${p(now.getMinutes())}:${p(now.getSeconds())}`
  const brand = String(prod.brand ?? '')
  const model = String(prod.model ?? '')
  const category = String(prod.category ?? '')
  const name = String(prod.name ?? '')
  return {
    topic: sanitizeTopic(input.topic) || '未命名分镜脚本',
    ratio: input.ratio,
    total_duration: totalDuration(shots.map((s) => Number(s.duration))),
    shot_count: shots.length,
    shots,
    saved_at: savedAt,
    product: { brand, model, category, name },
    brand,
    model,
    category,
    name,
  }
}
