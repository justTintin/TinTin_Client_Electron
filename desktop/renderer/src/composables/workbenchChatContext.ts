// ═══════════════════════════════════════════════════════════════
// workbenchChatContext.ts — 工作台输入区·智能体快捷条/斜杠菜单/
// 对话上下文编组·纯函数逻辑层（无 vue 依赖，可单测）
// 业务口径对照原客户端 gui/agent_home_page.py：
//   · parseAgentsResponse   = 原 _AgentLoader L707-725（GET /agent/agents
//                             兼容 {agents}|裸数组，过滤 exposed=False）
//   · buildQuickEntries     = 快捷条服务端智能体列表（2026-08-31 用户裁决：
//                             移除首项「对话」llm 直连入口，实际不用）
//   · isAgentPrefix         = 原 _SlashPopup.is_agent_prefix L254-259
//   · filterSlashCandidates = 原 _SlashPopup.show_for L294-298（名称/描述过滤）
//   · detectSlashKeyword    = 原 _ChatInput._on_text_changed L191（/([^\s/]*)$）
//   · buildAgentWakeText    = 原 _SlashPopup._insert_agent L353-361（唤醒词）
//   · fitQuickBar           = 原 _AgentBar L776-807 折叠 → 按可用宽度收纳「更多」
//   · productSummary / materialSummary / scriptSummary
//                           = 原 L1320-1366
//   · buildContextText      = 原 _build_context_text L1733-1751
//   · mediaTypeLabel        = 原 _MEDIA_TYPE_LABEL L64
// 单测：desktop/tests/workbench-context-logic.test.mjs
// ═══════════════════════════════════════════════════════════════

// Node 原生 type-stripping 直载（单测）要求显式 .ts 扩展；tsconfig 已开 allowImportingTsExtensions
import { buildAttachmentText, type ChatAttachment } from './workbenchChatLogic.ts'

/* ── 智能体列表（GET /agent/agents） ───────────────────────── */

export interface WorkbenchAgent {
  id: string
  name: string
  desc: string
}

/** 快捷条条目：kind=agent 服务端智能体；kind=skill 本地技能
 *  （2026-08-31 用户裁决：移除「对话」llm 直连入口，实际不用；
 *   存量 llm 会话仅保留可读，新会话全部走智能体链路） */
export interface QuickEntry {
  key: string
  kind: 'agent' | 'skill'
  name: string
  desc: string
  /** 服务端智能体的 agent_id（kind=agent 时有值，供 agentChat 请求传递） */
  agentId?: string
}

/**
 * 解析 /agent/agents 响应（原版 get_agents L88-95：兼容 {agents:[…]} 与裸数组；
 * _AgentLoader L713-721：过滤 exposed=False，映射 {id,name,desc}）。异常 → []。
 */
export function parseAgentsResponse(data: unknown): WorkbenchAgent[] {
  let raw: unknown[] = []
  if (Array.isArray(data)) raw = data
  else if (data && typeof data === 'object' && Array.isArray((data as Record<string, unknown>).agents)) {
    raw = (data as Record<string, unknown>).agents as unknown[]
  }
  const out: WorkbenchAgent[] = []
  for (const a of raw) {
    if (!a || typeof a !== 'object' || Array.isArray(a)) continue
    const d = a as Record<string, unknown>
    if (d.exposed === false) continue // 未开放给对话的智能体不展示（原版 L715-716）
    const id = String(d.agent_id || '')
    out.push({
      id,
      name: String(d.name || id || ''),
      desc: String(d.desc || d.description || '')
    })
  }
  return out
}

/** 快捷条条目：服务端智能体（原版每行 10 个改按宽度收纳；
 *  2026-08-31 移除首项「对话」，llm 直连入口实际不用） */
export function buildQuickEntries(agents: WorkbenchAgent[]): QuickEntry[] {
  return agents.map((a) => ({ key: a.id || a.name, kind: 'agent' as const, name: a.name, desc: a.desc, agentId: a.id || undefined }))
}

/* ── 斜杠菜单（原版 _SlashPopup） ──────────────────────────── */

/** 斜杠关键字是否可唤起（空关键字=显示全部候选；原版 L254-259 只认智能体名） */
export function isAgentPrefix(agents: WorkbenchAgent[], kw: string): boolean {
  const k = String(kw || '').trim().toLowerCase()
  if (!k) return true
  return agents.some((a) => String(a.name || '').toLowerCase().includes(k))
}

/** 斜杠候选过滤：名称或描述包含关键字（大小写不敏感；原版 L294-298） */
export function filterSlashCandidates(agents: WorkbenchAgent[], kw: string): WorkbenchAgent[] {
  const k = String(kw || '').trim().toLowerCase()
  if (!k) return agents.slice()
  return agents.filter(
    (a) =>
      String(a.name || '').toLowerCase().includes(k) ||
      String(a.desc || '').toLowerCase().includes(k)
  )
}

/**
 * 从光标前的文本段提取斜杠关键字（原版 L189-192：/([^\s/]*)$）。
 * 返回 '' 表示裸 /（显示全部候选）；null 表示无斜杠（不唤起）。
 */
export function detectSlashKeyword(text: string, caret: number): string | null {
  const seg = String(text || '').slice(0, Math.max(0, caret))
  const m = /\/([^\s/]*)$/.exec(seg)
  return m ? m[1] : null
}

/** 唤醒词（原版 L353-361：请【name】智能体执行：desc） */
export function buildAgentWakeText(agent: { name?: string; desc?: string }): string {
  const name = String(agent?.name || '').trim() || '该智能体'
  const desc = String(agent?.desc || '').trim()
  return desc ? `请【${name}】智能体执行：${desc}` : `请【${name}】智能体执行`
}

/**
 * 斜杠选中：把光标前的 /关键字 段替换为唤醒词（原版 L338-361：
 * 仅当最后一段斜杠后无空格才算唤醒段），返回新文本与新光标位置。
 */
export function applyAgentWakeInsert(
  text: string,
  caret: number,
  agent: { name?: string; desc?: string }
): { text: string; caret: number } {
  const s = String(text || '')
  const pos = Math.max(0, Math.min(caret, s.length))
  const seg = s.slice(0, pos)
  const i = seg.lastIndexOf('/')
  const wake = buildAgentWakeText(agent)
  if (i >= 0 && seg.slice(i + 1).split(' ').length === 1 && !seg.slice(i + 1).includes('\n')) {
    const next = s.slice(0, i) + wake + s.slice(pos)
    return { text: next, caret: i + wake.length }
  }
  const next = s.slice(0, pos) + wake + s.slice(pos)
  return { text: next, caret: pos + wake.length }
}

/* ── 快捷条收纳（原版 _AgentBar 折叠 → 按可用宽度 fitCount） ── */

/** 胶囊条目最大宽度（超出省略号截断，CSS 同步） */
export const QUICK_ENTRY_MAX_WIDTH = 120
/** 胶囊间距（CSS gap 同步） */
export const QUICK_GAP = 6
/** 「更多」按钮估算宽度 */
export const QUICK_MORE_WIDTH = 64

/** 估算条目宽度：12px 字号，CJK 12px/字、ASCII 7px/字 + 内边距 26 */
export function estimateEntryWidth(name: string): number {
  let w = 26
  for (const ch of String(name || '')) w += ch.charCodeAt(0) > 255 ? 12 : 7
  return Math.min(w, QUICK_ENTRY_MAX_WIDTH)
}

/**
 * 可用宽度内能放下多少条目；放不下时预留「更多」按钮宽度并折叠其余。
 * 返回 { count: 可见条数, more: 是否出现「更多」}（原版 _AgentBar 折叠口径）。
 */
export function fitQuickBar(
  widths: number[],
  available: number,
  opts?: { gap?: number; more?: number }
): { count: number; more: boolean } {
  const gap = opts?.gap ?? QUICK_GAP
  const more = opts?.more ?? QUICK_MORE_WIDTH
  const list = Array.isArray(widths) ? widths : []
  const total = list.reduce((n, w) => n + w, 0) + Math.max(0, list.length - 1) * gap
  if (total <= available) return { count: list.length, more: false }
  let acc = 0
  let count = 0
  for (const w of list) {
    const next = acc + (count > 0 ? gap : 0) + w
    if (next + more > available) break
    acc = next
    count++
  }
  return { count, more: true }
}

/* ── 对话上下文编组（原版 _build_context_text） ─────────────── */

export interface CtxProductItem {
  id?: string
  category?: string
  brand?: string
  model?: string
  goods_no?: string
  features?: string
  selling_points?: string
}

export interface CtxMaterialItem {
  id?: string | number
  material_id?: string | number
  filename?: string
  media_type?: string
  brand?: string
  model?: string
  category?: string
  path?: string
}

export interface CtxScriptItem {
  id?: string | number
  topic?: string
  shot_count?: number
  ratio?: string
  saved_at?: string
}

const MEDIA_TYPE_LABEL: Record<string, string> = {
  image: '图片',
  video: '视频',
  audio: '音频',
  document: '文档'
}

/** media_type → 中文标签（原版 _MEDIA_TYPE_LABEL L64，未知回退「素材」） */
export function mediaTypeLabel(t: string): string {
  return MEDIA_TYPE_LABEL[String(t || '').toLowerCase()] || '素材'
}

/** 产品上下文文本：品牌/型号/品类/货号 + 性能 + 卖点（原版 L1320-1334） */
export function productSummary(item: CtxProductItem): string {
  const lines: string[] = []
  for (const [key, label] of [
    ['brand', '品牌'],
    ['model', '型号'],
    ['category', '品类'],
    ['goods_no', '货号']
  ] as const) {
    const val = String((item as Record<string, unknown>)?.[key] || '').trim()
    if (val) lines.push(`${label}:${val}`)
  }
  const feat = String(item?.features || '').trim()
  const sell = String(item?.selling_points || '').trim()
  if (feat) lines.push(`性能:${feat.slice(0, 300)}`)
  if (sell) lines.push(`卖点:${sell.slice(0, 300)}`)
  return lines.join('\n')
}

/** 素材上下文文本：ID/文件名/类型/品牌型号/路径（原版 L1336-1350） */
export function materialSummary(item: CtxMaterialItem): string {
  const mid = String(item?.id || item?.material_id || '')
  const name = item?.filename || mid || '未命名'
  const lines = [`素材ID:${mid}`, `文件名:${name}`, `类型:${mediaTypeLabel(String(item?.media_type || ''))}`]
  for (const [key, label] of [
    ['brand', '品牌'],
    ['model', '型号'],
    ['category', '分类']
  ] as const) {
    const val = String((item as Record<string, unknown>)?.[key] || '').trim()
    if (val) lines.push(`${label}:${val}`)
  }
  const path = String(item?.path || '').trim()
  if (path) lines.push(`路径:${path}`)
  return lines.join('\n')
}

/** 分镜脚本上下文文本：ID/主题/镜头数/画幅/保存时间（原版 L1352-1366） */
export function scriptSummary(item: CtxScriptItem): string {
  const lines = [`脚本ID:${item?.id || ''}`]
  const topic = String(item?.topic || '').trim()
  if (topic) lines.push(`主题:${topic}`)
  lines.push(`镜头数:${item?.shot_count || 0}`)
  const ratio = String(item?.ratio || '').trim()
  if (ratio) lines.push(`画幅:${ratio}`)
  const saved = String(item?.saved_at || '').trim()
  if (saved) lines.push(`保存时间:${saved}`)
  return lines.join('\n')
}

/** 胶囊展示文案（原版 _rebuild_ctx_bar L1581-1594） */
export function productLabel(item: CtxProductItem): string {
  return `${item?.brand || ''} / ${item?.model || ''}`
}

export function materialLabel(item: CtxMaterialItem): string {
  const mid = String(item?.id || item?.material_id || '')
  const name = item?.filename || mid || '未命名'
  return `[${mediaTypeLabel(String(item?.media_type || ''))}] ${name}`
}

export function scriptLabel(item: CtxScriptItem): string {
  return `[${item?.topic || ''}] ${item?.shot_count || 0}镜`
}

/** 上下文编组入参（atts 含附件与已入池素材条目，materialId 区分） */
export interface ContextTextInput {
  product: CtxProductItem | null
  scripts: CtxScriptItem[]
  atts: ChatAttachment[]
  /** agent 模式=true：素材/附件走服务端会话素材池不拼文本（原版 pool_mode） */
  poolMode: boolean
}

/**
 * 对话上下文文本（原版 _build_context_text L1733-1751）：
 * agent 模式只拼【产品】【脚本】（素材/附件已入服务端素材池，每轮自动注入）；
 * llm 模式全文本拼接【产品】【素材】【脚本】【附件】，段落间 \n\n。
 * 2026-08-30：截图等 infoOnly 附件不入素材池，任何模式下都拼入文本（服务端才能读到）。
 */
export function buildContextText(input: ContextTextInput): string {
  const { product, scripts, atts, poolMode } = input || {}
  const parts: string[] = []
  if (product) parts.push('【产品】\n' + productSummary(product))
  const materials = (atts || []).filter((a) => a && a.materialId)
  if (!poolMode) {
    for (const m of materials) parts.push('【素材】\n' + materialSummary((m.material || {}) as CtxMaterialItem))
  }
  for (const s of scripts || []) parts.push('【脚本】\n' + scriptSummary(s))
  // 普通附件：agent 模式已入素材池不拼文本；llm 模式全拼
  if (!poolMode) {
    const files = (atts || []).filter((a) => a && !a.materialId && a.path && !a.infoOnly)
    const text = buildAttachmentText(files)
    if (text) parts.push(text)
  }
  // 截图等 infoOnly 附件：不入素材池，任何模式都拼文本（服务端才能读到信息）
  const info = (atts || []).filter((a) => a && a.infoOnly && a.path)
  const infoText = buildAttachmentText(info)
  if (infoText) parts.push(infoText)
  // 音频库条目（2026-08-31「选择素材」弹窗音频 tab）：infoOnly 信息胶囊，
  // 不入素材池（音频非产品素材），任何模式下拼【参考音频】文本
  const audios = (atts || []).filter((a) => a && a.infoOnly && !a.path && a.material)
  for (const a of audios) parts.push('【参考音频】\n' + audioSummary(a.material as Record<string, unknown>))
  return parts.join('\n\n')
}

/** 用户原文 + 上下文拼装（原版 _send_text L1244-1246：f"{text}\n\n{ctx}"） */
export function appendContextText(text: string, ctx: string): string {
  return ctx ? `${text}\n\n${ctx}` : text
}

/* ── 音频库条目（2026-08-31「选择素材」弹窗音频 tab） ─────────── */

/** 音频上下文文本：文件名/类型/分类/风格/时长（字段容错：/audio/library 契约自由格式） */
export function audioSummary(item: Record<string, unknown>): string {
  const name = String(item?.filename || item?.title || item?.name || '').trim() || '未命名'
  const lines = [`文件名:${name}`, '类型:音频']
  for (const [key, label] of [
    ['category', '分类'],
    ['genre', '风格'],
    ['emotion', '情绪'],
    ['tags', '标签']
  ] as const) {
    const val = String((item as Record<string, unknown>)?.[key] || '').trim()
    if (val) lines.push(`${label}:${val}`)
  }
  const dur = Number(item?.duration || item?.duration_sec || 0)
  if (dur > 0) lines.push(`时长:${Math.round(dur)}秒`)
  return lines.join('\n')
}

/* ── 媒体预览 URL（「选择素材」弹窗预览；无鉴权流式端点，<img>/<video>/<audio> 直接加载） ── */

/** 服务端相对根拼接：去尾斜杠；serverUrl 为空（未连通）→ 空串（预览区显示占位） */
function mediaBaseUrl(serverUrl: string): string {
  return String(serverUrl || '').trim().replace(/\/$/, '')
}

/** 素材原文件流（GET /material/serve?material_id=，视频预览/图片预览共用） */
export function buildMediaServeUrl(serverUrl: string, materialId: string | number): string {
  const base = mediaBaseUrl(serverUrl)
  const mid = String(materialId ?? '').trim()
  return base && mid ? `${base}/material/serve?material_id=${encodeURIComponent(mid)}` : ''
}

/** 素材缩略图（GET /material/thumbnail?material_id=，卡片网格用） */
export function buildMediaThumbUrl(serverUrl: string, materialId: string | number): string {
  const base = mediaBaseUrl(serverUrl)
  const mid = String(materialId ?? '').trim()
  return base && mid ? `${base}/material/thumbnail?material_id=${encodeURIComponent(mid)}` : ''
}

/** 音频库文件流（GET /audio/library/{audio_id}/file，底部播放条用） */
export function buildAudioFileUrl(serverUrl: string, audioId: string | number): string {
  const base = mediaBaseUrl(serverUrl)
  const aid = String(audioId ?? '').trim()
  return base && aid ? `${base}/audio/library/${encodeURIComponent(aid)}/file` : ''
}

/* ── 弹窗列表容错解析（服务端自由格式响应） ─────────────────── */

/**
 * 搜索弹窗列表容错解析：兼容 {items}|{data}|{results}|裸数组；
 * 异常/字段缺失 → []（调用方按空结果提示）。
 */
export function pickListItems(data: unknown): Record<string, unknown>[] {
  let arr: unknown = data
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const d = data as Record<string, unknown>
    arr = d.items ?? d.data ?? d.results ?? []
  }
  if (!Array.isArray(arr)) return []
  return arr.filter((x) => x && typeof x === 'object' && !Array.isArray(x)) as Record<string, unknown>[]
}

/**
 * 分页 total 容错解析：{total}|{total_count}|{count}；无分页字段 → -1
 * （调用方退化为单页，不显示分页器）。
 */
export function pickListTotal(data: unknown): number {
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const d = data as Record<string, unknown>
    for (const k of ['total', 'total_count', 'count'] as const) {
      const n = Number(d[k])
      if (Number.isFinite(n) && n >= 0) return n
    }
  }
  return -1
}

/**
 * /material/distinct 响应容错解析：{values:[...]}（字符串或 {name}/{value}
 * 对象条目）兼容裸数组；去空/去重/剔除 null，保持服务端顺序。
 */
export function pickDistinctValues(data: unknown): string[] {
  let arr: unknown = data
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    arr = (data as Record<string, unknown>).values ?? []
  }
  if (!Array.isArray(arr)) return []
  const out: string[] = []
  for (const x of arr) {
    if (x === null || x === undefined) continue
    const raw =
      typeof x === 'string'
        ? x
        : x && typeof x === 'object'
          ? (x as Record<string, unknown>).name ?? (x as Record<string, unknown>).value
          : x // 数字等原始值直接转字符串
    const v = String(raw ?? '').trim()
    if (v && !out.includes(v)) out.push(v)
  }
  return out
}

/** 搜索异常分支文案：null=网络离线；Error('HTTP 5xx')=服务端错误 */
export function searchErrorText(err: unknown): string {
  if (err === null || err === undefined) {
    return '网络异常：无法连接服务端，请检查「设置 → 服务端」的地址与网络后重试。'
  }
  const msg = (err as Error)?.message || String(err)
  return `搜索失败：${msg}`
}
