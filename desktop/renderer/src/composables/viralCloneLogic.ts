// ═══════════════════════════════════════════════════════════════
// viralCloneLogic — 仿爆款（Viral Clone）纯函数层（无 vue/IPC 依赖，可单测）
// 业务对齐原客户端（双源一比一方法论）：
//   · studio/utils/viral_clone_client.py normalize_source L158-186
//     （素材 ID / 服务端 output 路径 / 本地文件 / 链接 / 兜底五种形态）
//   · studio/gui/viral_clone_dialog.py _collect_edit_payload L790-841
//     （动态表单 → files/values 两分组；本地路径 vs 素材 ID 判定）
//   · studio/gui/viral_clone_dialog.py _on_run/_render_result L844-890
//     （拆解+复刻 → 「══ 爆款结构 ══ / ══ 复刻脚本 ══」输出）
//   · studio/utils/workflow_client.py normalize_server_workflow L60-88
//     （GET /workflows 条目 → 客户端结构 + output_type 过滤）
//
// 2026-09-06 用户裁决：下载 / 素材浏览器链路不移植。输入统一为「本地视频上传」：
//   本地文件路径 → normalizeSource 标记 uploaded；由调用方经通用
//   window.tintin.server.upload(path, fields, onProgress) 上传到服务端
//   output/upload 区 → 拿 video_path 回填 → 走 flow/analyze。
//   链接分支（http:// https://）移除；material_id 保留为可选次选。
// ═══════════════════════════════════════════════════════════════

/** 服务端 output 上传/下载区标记（viral_clone_client._SERVER_OUTPUT_MARKERS） */
const SERVER_OUTPUT_MARKERS = ['/output/', 'output\\', 'output/']

/** 链接 → 平台推断规则（viral_clone_client._URL_PLATFORM_RULES） */
const URL_PLATFORM_RULES: Array<[string[], string]> = [
  [['douyin.com', 'iesdouyin.com', 'v.douyin.com'], 'douyin'],
  [['bilibili.com', 'b23.tv'], 'bilibili'],
  [['xiaohongshu.com', 'xhslink.com'], 'xiaohongshu'],
  [['tiktok.com'], 'tiktok'],
  [['youtube.com', 'youtu.be'], 'youtube'],
]

/** 本地文件扩展名（本地路径判定 + 动态表单文件字段判定） */
export const VIDEO_EXTS = ['mp4', 'mov', 'mkv', 'avi', 'webm', 'flv', 'm4v']
const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'tif', 'tiff']
const AUDIO_EXTS = ['mp3', 'wav', 'aac', 'flac', 'm4a', 'ogg']

/** 文件类动态表单 kind → 选择对话框 filters（viral_clone_dialog._pick_edit_file） */
export const FILE_KIND_FILTERS: Record<string, string> = {
  image: '图片 (*.png *.jpg *.jpeg *.webp *.bmp *.tif *.tiff)',
  audio: '音频 (*.mp3 *.wav *.aac *.flac *.m4a *.ogg)',
  video: '视频 (*.mp4 *.mov *.mkv *.avi *.webm *.flv)',
}

// ─────────────────────────────────────────────────────────────────────
// 来源归一化 normalizeSource（V3 改动版 —— 去 need_download，本地文件→上传）
// ─────────────────────────────────────────────────────────────────────

export interface NormalizeSourceResult {
  ok: boolean
  /** analyze/flow 入参（二选一）：servicePath = 上传后的 video_path（output 区） */
  videoPath?: string
  /** 素材库 ID（可选次选） */
  materialId?: number | string
  /** 是否需要先上传：本地文件 → true（调用方触发 server.upload 后回填 videoPath） */
  needsUpload?: boolean
  /** 用户可读说明 */
  note: string
}

/** 判断是否为服务端 output 上传/下载区内路径（viral_clone_client._is_server_path） */
export function isServerPath(p: unknown): boolean {
  if (typeof p !== 'string') return false
  return SERVER_OUTPUT_MARKERS.some((m) => p.includes(m))
}

/** 按域名粗略推断平台（素材浏览器 handoff 用；未知返回 douyin） */
export function guessPlatform(url: unknown): string {
  const low = String(url || '').toLowerCase()
  for (const [domains, platform] of URL_PLATFORM_RULES) {
    if (domains.some((d) => low.includes(d))) return platform
  }
  return 'douyin'
}

/** 判定本地文件路径（含分隔符或已知文件扩展名；viral_clone_dialog._collect_edit_payload L808） */
export function isLocalPathLike(s: unknown): boolean {
  if (typeof s !== 'string' || !s.trim()) return false
  const p = s.trim()
  if (p.includes('/') || p.includes('\\')) return true
  const ext = extname(p) || ''
  return VIDEO_EXTS.concat(IMAGE_EXTS, AUDIO_EXTS).includes(ext)
}

/**
 * 归一化视频来源（viral_clone_client.normalize_source V3 改动版）。
 * local 文件 → { ok:true, needsUpload:true }；数字 → material_id；
 * output 区路径 → videoPath；http(s) 链接 → 移除（下载链路不移植）；
 * 兜底 → material_id 文本。
 */
export function normalizeSource(videoRef: unknown): NormalizeSourceResult {
  if (videoRef === null || videoRef === undefined || String(videoRef).trim() === '') {
    return { ok: false, note: '未提供爆款视频' }
  }
  // 素材 ID（数字）
  if (typeof videoRef === 'number' || isDigits(String(videoRef).trim())) {
    const n = Number(videoRef)
    return Number.isInteger(n) && n >= 0
      ? { ok: true, materialId: n, note: `素材库 id=${n}` }
      : { ok: true, materialId: String(videoRef).trim(), note: `素材 id=${String(videoRef).trim()}` }
  }
  const s = String(videoRef).trim()
  // 服务端 output 区路径（已上传）
  if (isServerPath(s)) {
    return { ok: true, videoPath: s, note: '服务端 output 区路径（已上传）' }
  }
  // http(s) 链接 → 移除（下载链路不移植；须在本地文件判定之前，链接含 `/` 与 `.`）
  if (/^https?:\/\//i.test(s)) {
    return { ok: false, note: '链接输入已移除（下载链路不移植）：请选择本地视频上传' }
  }
  // 本地文件 → 需先上传（本端唯一输入）
  if (isLocalPath(s)) {
    return { ok: true, needsUpload: true, note: '本地视频，需上传到服务端 output/upload 区' }
  }
  // 兜底：视为素材 ID 文本
  return { ok: true, materialId: s, note: `素材 id=${s}` }
}

function isLocalPath(p: string): boolean {
  if (p.startsWith(':') || p.startsWith('/') || p.startsWith('\\')) return true
  return p.includes('.') && isLocalPathLike(p)
}

// ─────────────────────────────────────────────────────────────────────
// 请求体组包（flow / analyze / plan —— 契约字段名以原客户端行为源为准）
// ─────────────────────────────────────────────────────────────────────

function pick(videoPath?: string, materialId?: number | string): Record<string, unknown> {
  if (materialId !== undefined) return { material_id: materialId }
  if (videoPath) return { video_path: videoPath }
  return {}
}

/** POST /viral/clone/flow body */
export function buildFlowBody(videoPath?: string, materialId?: number | string, productInfo = ''): Record<string, unknown> {
  const body: Record<string, unknown> = { product_info: productInfo || '' }
  const src = pick(videoPath, materialId)
  if (!Object.keys(src).length) return body
  return { ...src, ...body }
}

/** POST /viral/clone/analyze body */
export function buildAnalyzeBody(videoPath?: string, materialId?: number | string): Record<string, unknown> {
  return pick(videoPath, materialId)
}

/** POST /viral/clone/plan body（structure 必填，便于直接传给 PlanRequest） */
export function buildPlanBody(
  structure: unknown,
  productInfo = '',
): { structure: unknown; product_info: string } {
  return { structure, product_info: productInfo || '' }
}

/** flow 失败状态（need_login/captcha/error）→ 用户可读中文文案（viral_clone_client.flow L119-126） */
export interface FlowErrorLike {
  needLogin?: boolean
  captcha?: boolean
  error?: string
}

/** 抖音未登录/风控滑块 → 中文提示（本端下载链路已移除，扫码/验证在浏览器完成） */
export function i18nFlowError(p: FlowErrorLike): string {
  if (p.needLogin) return '抖音未登录：请在浏览器中打开抖音扫码登录后重试'
  if (p.captcha) return '抖音触发滑块验证：请在浏览器中完成验证后重试'
  return p.error || 'flow 未返回成功'
}

// ─────────────────────────────────────────────────────────────────────
// 结果格式化（viral_clone_dialog._render_result / to_editor_text）
// ─────────────────────────────────────────────────────────────────────

/** 任意对象 → 紧凑 JSON 文本（渲染层无 to_editor_text，用 JSON.stringify 等效） */
export function toEditorText(obj: unknown): string {
  if (obj === undefined || obj === null) return ''
  if (typeof obj === 'string') return obj
  try {
    return JSON.stringify(obj, null, 2)
  } catch (_) {
    return String(obj)
  }
}

/** 组装「══ 爆款结构 ══ / ══ 复刻脚本 ══」输出文本 */
export function formatCloneResult(structure: unknown, script: unknown): string {
  const parts: string[] = []
  parts.push('══ 爆款结构（structure）══')
  parts.push(toEditorText(structure || {}))
  parts.push('')
  parts.push('══ 复刻脚本（script）══')
  parts.push(toEditorText(script || {}))
  return parts.join('\n')
}

// ─────────────────────────────────────────────────────────────────────
// 动态表单（viral_clone_dialog._build_edit_form / _collect_edit_payload）
// ─────────────────────────────────────────────────────────────────────

export interface WorkflowInput {
  key?: string
  kind?: string
  label?: string
  required?: boolean
  placeholder?: string
  options?: Array<string | [string, unknown]>
  default?: unknown
}

/** 归一化后的服务端工作流（workflow_client.normalize_server_workflow，取本端用字段） */
export interface ServerWorkflow {
  id: string
  name: string
  type: string
  backend: string
  description: string
  instanceType: string
  outputType: string
  inputs: WorkflowInput[]
}

/** GET /workflows 条目 → 客户端结构（缺 workflow_id / 非对象 → null） */
export function normalizeServerWorkflow(w: unknown): ServerWorkflow | null {
  if (!w || typeof w !== 'object') return null
  const item = w as Record<string, any>
  const wfId = item.workflow_id
  if (!wfId) return null
  return {
    id: String(wfId),
    name: item.name || wfId,
    type: item.type || '其他',
    backend: item.backend || '',
    description: item.description || '',
    instanceType: item.instance_type || 'default',
    outputType: item.output_type || '',
    inputs: Array.isArray(item.inputs) ? item.inputs : [],
  }
}

/** 过滤 output_type == "video" 的编辑工作流（_LoadVideoWorkflowsWorker L93） */
export function filterVideoWorkflows(list: Array<ServerWorkflow | null | undefined>): ServerWorkflow[] {
  return (Array.isArray(list) ? list : []).filter(
    (w): w is ServerWorkflow => !!w && String(w.outputType).toLowerCase() === 'video',
  )
}

/** 工作流下拉展示文案 `name [backend]`；后端为空则纯 name */
export function workflowDisplayName(w: ServerWorkflow): string {
  return w.backend ? `${w.name}  [${w.backend}]` : w.name
}

/** 工作流描述文案（_on_wf_changed L554）：【BACKEND】实例：instanceType\n描述 */
export function workflowDescText(w: ServerWorkflow): string {
  const backend = w.backend || '-'
  const itype = w.instanceType || 'default'
  const desc = w.description || '（工作流未提供描述）'
  return `【${backend.toUpperCase()}】实例：${itype}\n${desc}`
}

/** 动态表单行模型（组件渲染用） */
export interface FormEntry {
  key: string
  kind: string
  label: string
  required: boolean
  placeholder: string
  options: Array<{ label: string; value: unknown }>
  default: unknown
}

/** 下拉 options → {label,value} 列表（支持 [label,value] 元组 / 字符串） */
function normalizeOptions(options?: Array<string | [string, unknown]>): Array<{ label: string; value: unknown }> {
  if (!Array.isArray(options)) return []
  return options.map((opt) =>
    Array.isArray(opt) && opt.length >= 2
      ? { label: String(opt[0]), value: opt[1] }
      : { label: String(opt), value: opt },
  )
}

/** 由 workflow.inputs 生成表单行（无 inputs 时默认一个 video 字段，_build_edit_form L582-589） */
export function buildFormEntries(workflow: ServerWorkflow, defaultVideoPath = ''): FormEntry[] {
  let inputs: WorkflowInput[] = workflow?.inputs?.length ? workflow.inputs : []
  if (!inputs.length) {
    inputs = [
      { key: 'video', kind: 'video', label: '视频文件/素材 ID', required: true, placeholder: '填入素材库 ID 或本地视频绝对路径' },
    ]
  }
  return inputs.map((inp, row) => {
    const key = inp.key || `field_${row}`
    const kind = (inp.kind || 'text').toLowerCase()
    const label = inp.label || key
    const required = Boolean(inp.required)
    let defaultValue: unknown = inp.default
    // 文件类：默认视频字段预置左侧素材（_build_edit_form L572-589）
    if (kind === 'video' && defaultVideoPath && (defaultValue === undefined || defaultValue === null || defaultValue === '')) {
      defaultValue = defaultVideoPath
    }
    return {
      key,
      kind,
      label,
      required,
      placeholder: inp.placeholder || (kind === 'text' ? `输入${label}` : `选择${kind}文件路径 / 素材 ID`),
      options: normalizeOptions(inp.options),
      default: defaultValue,
    }
  })
}

/** 动态表单当前值 → {files, values, errors}（_collect_edit_payload 一比一） */
export interface EditPayloadValues {
  /** 文件字段 key → 本地绝对路径 */
  files: Record<string, string>
  /** 非文件字段（select/text/素材ID）或不存在文件的素材标识 */
  values: Record<string, unknown>
  /** 必填校验错误（空串 = 通过） */
  error: string
}

/** 文件类 kind 集合 */
const FILE_KINDS = new Set(['image', 'video', 'audio'])

/** 单字段值提取：文件路径 / select 值 / 文本值 */
export function extractFieldValue(entry: FormEntry, raw: unknown, key: string): string {
  if (entry.kind === 'select') {
    const v = (raw !== undefined && raw !== null && raw !== '') ? raw : null
    if (v === null) return ''
    return String(v)
  }
  return String(raw ?? '').trim()
}

/**
 * 收集动态表单值 → files/values two 分组（viral_clone_dialog._collect_edit_payload L790-841）。
 * 文件类：本地路径（含分隔符/扩展名）→ files；否则（素材 ID/远程标识）→ values。
 * 必填缺失 → 收集到 error；非必填文件不存在 → 当值透传。
 */
export function collectEditPayload(entries: FormEntry[], formState: Record<string, unknown>): EditPayloadValues {
  const files: Record<string, string> = {}
  const values: Record<string, unknown> = {}
  const errors: string[] = []

  for (const ent of entries) {
    const key = ent.key
    const raw = formState[key]
    if (FILE_KINDS.has(ent.kind)) {
      const path = String(raw ?? '').trim()
      if (!path) {
        if (ent.required) errors.push(`${ent.label} 为必填项`)
        continue
      }
      if (isLocalPathLike(path)) {
        // 本地路径 → files（由 multipartUpload 读取；不存在时必填报错/非必填透传）
        if (path.includes('.') || path.includes('/') || path.includes('\\')) {
          // 无法在渲染层判 isfile（无 node fs），交由主进程 multipartUpload 处理；
          // 若路径无扩展名但含分隔符仍视为路径，缺文件时服务端会报 422 透出。
          files[key] = path
        } else {
          values[key] = path
        }
      } else {
        // 素材 ID / 远程标识 → value 透传
        values[key] = path
      }
    } else if (ent.kind === 'select') {
      const v = raw !== undefined && raw !== null && raw !== '' ? raw : null
      if (v === null || v === '') {
        if (ent.required) errors.push(`${ent.label} 请选择一个选项`)
        continue
      }
      values[key] = String(v)
    } else {
      const v = String(raw ?? '').trim()
      if (!v) {
        if (ent.required) errors.push(`${ent.label} 为必填项`)
        continue
      }
      values[key] = v
    }
  }

  return { files, values, error: errors.join('；') }
}

// ─────────────────────────────────────────────────────────────────────
// 产品下拉展示（viral_clone_dialog._on_products_loaded L492-494）
// ─────────────────────────────────────────────────────────────────────

/** 产品条目 → 下拉展示文案 `brand / model|name|title`（空段折叠） */
export function productDisplayName(it: unknown): string {
  if (!it || typeof it !== 'object') return ''
  const o = it as Record<string, any>
  const model = o.model || o.name || o.title || ''
  const label = `${o.brand || ''} / ${model}`.replace(/^\/\s*/, '').replace(/\s*\/$/, '').trim()
  return label ? label : `${o.brand || o.model || o.name || o.title || ''}`.trim()
}

/** 产品条目 → 产品描述文案（原客户端 ProductLibraryManager.to_prompt_text；本端取常用字段拼装） */
export function productPromptText(it: unknown): string {
  if (!it || typeof it !== 'object') return ''
  const o = it as Record<string, any>
  const parts = [
    o.brand && `品牌：${o.brand}`,
    o.model && `型号：${o.model}`,
    o.name && `名称：${o.name}`,
    o.category && `品类：${o.category}`,
    o.desc && `描述：${o.desc}`,
    o.selling_points && `卖点：${o.selling_points}`,
    o.core_selling_points && `卖点：${o.core_selling_points}`,
  ].filter(Boolean)
  return parts.join('；') || (o.name || o.model || o.brand || String(o))
}

// ─────────────────────────────────────────────────────────────────────
// 字符串工具（渲染层无 lodash / node path，仅 local 小工具，纯函数可单测）
// ─────────────────────────────────────────────────────────────────────

/** 取文件扩展名（无点、小写；无 . 返回空） */
function extname(s: string): string {
  const i = s.lastIndexOf('.')
  return i < 0 ? '' : s.slice(i + 1).toLowerCase()
}

/** 是否为纯数字字符串 */
function isDigits(s: string): boolean {
  return /^\d+$/.test(s)
}

// ── 字符串工具（渲染层无 lodash / node path）──

/** 拆路径取文件名尾段 */
export function pathBasename(p: unknown): string {
  const s = String(p || '')
  return s.split(/[\\/]/).pop() || s
}
