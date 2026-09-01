// ═══════════════════════════════════════════════════════════════
// workbenchChatLogic.ts — 工作台 AI 对话·纯函数逻辑层（无 vue 依赖，可单测）
// 业务口径对照原客户端 gui/agent_home_page.py + utils/agent_client.py：
//   · trimHistory        = 原 _trim_history L1452-1456（最近 12 条且总字符 ≤8000）
//   · LLM_SYSTEM_PROMPT  = 原 _SYSTEM_PROMPT L58-61（通用对话模式系统提示词）
//   · buildLlmMessages   = 原 _ChatWorker llm 分支 L642-653（空 history 注入 system、
//                          末位 user 替换为本轮文本）
//   · extractAgentReply  = 原 agent_client.agent_chat L286-297（mode=plan 无 reply
//                          含 task_id → 编排提示文本）
//   · sanitizeSessions   = 持久化恢复防御（原 _restore_chat L1682-1684 只收合法消息）
// 单测：desktop/tests/workbench-chat-logic.test.mjs
// ═══════════════════════════════════════════════════════════════

/* ── 历史上下文（OpenAI 风格，不含本轮消息时的发送约定见 buildLlmMessages） ── */
export interface HistoryMessage {
  role: 'user' | 'assistant'
  content: string
  /** 消息时间戳（2026-09-01 用户需求：消息框带时间；旧持久化数据缺省不显示） */
  time?: number
}

/** 原版口径：保留最近 12 条 */
export const HISTORY_MAX_COUNT = 12
/** 原版口径：总字符 ≤8000 */
export const HISTORY_MAX_CHARS = 8000
/** 本地持久化保留的最近消息条数（原版 _CHAT_SAVE_ROUNDS） */
export const CHAT_SAVE_ROUNDS = 40

/** 通用对话模式的首条系统提示词（智能体模式由服务端内置助手提示词接管） */
export const LLM_SYSTEM_PROMPT =
  '你是「螺丝钉电商智能体」的运营助手，帮助用户完成电商短视频的内容创作、素材管理、' +
  '视频处理等任务。回答简洁实用，需要执行具体任务时给出可操作的步骤建议。'

/** 上下文截断：保留最近 HISTORY_MAX_COUNT 条且总字符不超过 HISTORY_MAX_CHARS */
export function trimHistory(history: HistoryMessage[]): HistoryMessage[] {
  const out = history.filter(
    (m) => (m.role === 'user' || m.role === 'assistant') && String(m.content || '').length > 0
  )
  while (
    out.length > HISTORY_MAX_COUNT ||
    out.reduce((n, m) => n + (m.content || '').length, 0) > HISTORY_MAX_CHARS
  ) {
    out.shift()
  }
  return out
}

/**
 * 通用对话（llm 模式）消息组装：history 末位为 user（上轮失败残留）→ 替换为本轮
 * 文本；否则追加本轮 user；空 history 时以系统提示词开头。
 */
export function buildLlmMessages(
  history: HistoryMessage[],
  userText: string
): Array<{ role: string; content: string }> {
  const msgs: Array<{ role: string; content: string }> = trimHistory(history).map((m) => ({
    role: m.role,
    content: m.content
  }))
  if (!msgs.length) msgs.unshift({ role: 'system', content: LLM_SYSTEM_PROMPT })
  const last = msgs[msgs.length - 1]
  if (last && last.role === 'user') last.content = userText
  else msgs.push({ role: 'user', content: userText })
  return msgs
}

/* ── 服务端响应解析 ─────────────────────────────────────────── */

export interface AgentReply {
  reply: string
  sessionId: string
  taskId: string
  /** mode=agent：编排任务已自动执行（status=running） */
  isPlan: boolean
  /** mode=plan：计划草稿待确认（status=pending_approval，服务端不启动） */
  isDraft: boolean
  /** 服务端随草稿响应携带的确认端点（approve；空则客户端回落 taskConfirm） */
  confirmPath: string
}

/** mode=agent 无 reply 含 task_id → 编排提示文本（原版 agent_client L287-291 文案；
 *  2026-08-31 对齐 Electron 实际 UI：编排任务在「定时任务」抽屉/「任务队列」看） */
export function planReplyText(taskId: string): string {
  return ` 已创建编排任务：\`${taskId}\`，服务端将自动执行。\n可在左侧「定时任务」抽屉（执行结果）或左下角「任务队列」查看进度与产物。`
}

/** mode=plan 草稿响应 plan 字段 → 计划草稿文本（string 直接用；
 *  数组/对象格式化；空 → task_id 提示兜底） */
export function planSummaryText(plan: unknown, taskId: string): string {
  if (typeof plan === 'string' && plan.trim()) return plan
  if (plan != null && typeof plan === 'object') {
    try { return JSON.stringify(plan, null, 2) } catch { /* 序列化失败走兜底 */ }
  }
  return `服务端已生成计划草稿：\`${taskId}\`，请确认执行。`
}

/* ── plan JSON 消息步骤卡片（2026-09-01 用户裁决方案B：服务端返回结构化 plan，
   客户端负责渲染——WbMessages 检测到 plan 结构渲染步骤卡片，识别不到走原文本） ── */

/** 计划步骤视图模型（params 序列化为可读摘要） */
export interface PlanStepView {
  id: string
  capability: string
  /** params 摘要（key: value 多行；value 截断 80 字符） */
  summary: string
  dependsOn: string[]
  needsUserInput: boolean
}

/** 计划消息视图模型（goal + 步骤列表） */
export interface PlanView {
  goal: string
  steps: PlanStepView[]
}

/** params 值 → 摘要字符串（对象/数组 JSON 化；长值截断 80 字符加省略号） */
function planParamText(v: unknown): string {
  const s = typeof v === 'string' ? v : (() => { try { return JSON.stringify(v) } catch { return String(v) } })()
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > 80 ? t.slice(0, 80) + '…' : t
}

function planStepView(raw: unknown): PlanStepView | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const capability = String(o.capability || '').trim()
  if (!capability) return null
  const params = o.params && typeof o.params === 'object' ? (o.params as Record<string, unknown>) : {}
  const summary = Object.entries(params)
    .map(([k, v]) => `${k}: ${planParamText(v)}`)
    .join('\n')
  const dependsOn = Array.isArray(o.depends_on)
    ? o.depends_on.map((d) => String(d)).filter(Boolean)
    : []
  return {
    id: String(o.id || capability),
    capability,
    summary,
    dependsOn,
    needsUserInput: o.needs_user_input === true
  }
}

/**
 * 消息内容 → plan 视图模型（WbMessages 步骤卡片渲染判定）。
 * 兼容裸 JSON 与 ```json 围栏；必须同时有 goal 与非空 steps（每步含 capability），
 * 否则返回 null（调用方按普通文本渲染）。
 */
export function parsePlanContent(content: string): PlanView | null {
  const s = String(content || '').trim()
  if (!s.startsWith('{')) {
    const m = s.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/)
    if (!m) return null
    const inner = String(m[1] || '').trim()
    if (!inner.startsWith('{')) return null
    return parsePlanContent(inner)
  }
  let d: unknown
  try { d = JSON.parse(s) } catch { return null }
  if (!d || typeof d !== 'object') return null
  const o = d as Record<string, unknown>
  const goal = String(o.goal || '').trim()
  if (!goal || !Array.isArray(o.steps) || !o.steps.length) return null
  const steps = o.steps.map(planStepView)
  if (steps.some((x) => x === null)) return null
  return { goal, steps: steps as PlanStepView[] }
}

/**
 * 底部任务选择器（2026-08-31 用户裁决：替换原「转编排任务」勾选）：
 * · off=普通对话（mode=chat，即时回复）；agent=智能体（mode=agent，拆解后自动执行）；
 * · plan-confirm=计划任务（mode=plan，服务端建 pending_approval 草稿，
 *   客户端 POST /agent/tasks/{id}/approve 确认后才执行）
 */
export type PlanExecMode = 'off' | 'agent' | 'plan-confirm'

/** 解析 /agent/chat 响应（mode = 请求 mode：chat/agent/plan，服务端三档契约 2026-08-31）：
 *  · chat：即时回复，不建任务；
 *  · agent：{task_id, status:'running'} → 编排提示文本（isPlan）；
 *  · plan：{plan, task_id, status:'pending_approval', confirm} → 计划草稿（isDraft）；
 *  空回复且非任务 → null（触发「服务端未返回内容」） */
export function extractAgentReply(data: unknown, mode?: string): AgentReply | null {
  if (!data || typeof data !== 'object') return null
  const d = data as Record<string, any>
  const reply = String(d.reply || '')
  const sessionId = String(d.session_id || '')
  const taskId = String(d.task_id || '')
  const status = String(d.status || '')
  const confirmPath = String(d.confirm || '')
  let text = reply
  let isPlan = false
  let isDraft = false
  if (!text && mode === 'agent' && taskId) {
    text = planReplyText(taskId)
    isPlan = true
  }
  // 计划任务档：服务端建 pending_approval 草稿不启动，气泡展示计划待确认
  if (mode === 'plan' && (status === 'pending_approval' || (!text && taskId))) {
    isDraft = true
    if (!text) text = planSummaryText(d.plan, taskId)
  }
  if (!text) return null
  return { reply: text, sessionId, taskId, isPlan, isDraft, confirmPath }
}

/** 解析 /llm/chat/completions 响应（OpenAI 格式）；异常 → null */
export function extractLlmReply(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null
  const choices = (data as Record<string, any>).choices
  if (!Array.isArray(choices) || !choices.length) return null
  const content = choices[0]?.message?.content
  return typeof content === 'string' && content.length ? content : null
}

/* ── 会话附件（上下文胶囊，对照原版 _ctx_attachments L1049） ── */

/** 胶囊状态：pending=未入池 / uploading=入池中 / pooled=已入池 / failed=入池失败 */
export type AttachmentState = 'pending' | 'uploading' | 'pooled' | 'failed'

export interface ChatAttachment {
  name: string
  path: string
  /** 已入池时服务端返回的 file_ref（移除时作为 key） */
  poolKey?: string
  state: AttachmentState
  /** 素材库引用条目（「选择素材」弹窗入池走 material_id，无本地 path） */
  materialId?: string
  /** 素材库原始条目（llm 模式文本拼接取 media_type/brand 等摘要字段） */
  material?: Record<string, unknown>
  /**
   * 只提供信息的附件（如剪贴板截图粘贴）：不入服务端素材池
   * （素材池是产品素材；截图仅作为上下文信息文本拼入）。
   * 2026-08-30 用户裁决：截图直接贴入附件池，不入素材池。
   */
  infoOnly?: boolean
}

/**
 * 通用对话（llm）模式附件随消息文本携带（原版 L1748-1750 口径：
 * agent 模式附件入服务端会话素材池不拼文本；llm 模式全文本拼接）。
 */
export function buildAttachmentText(atts: ChatAttachment[]): string {
  const list = Array.isArray(atts) ? atts.filter((a) => a && a.name && a.path) : []
  if (!list.length) return ''
  const lines = list.map((a) => `- ${a.name}（${a.path}）`)
  return `【附件】\n${lines.join('\n')}`
}

/** 本地文件路径 → 文件名（兼容 \\ 与 / 分隔符，对照原版 os.path.basename） */
export function basenameOf(p: string): string {
  const i = Math.max(String(p).lastIndexOf('\\'), String(p).lastIndexOf('/'))
  return i >= 0 ? String(p).slice(i + 1) : String(p)
}

/* ── 会话持久化数据结构（可切换设计：每会话绑定独立服务端 session_id） ── */

export type ChatMode = 'agent' | 'llm'
export type SessionGroupKey = 'pinned' | 'today' | 'yesterday' | 'earlier'

/** 本地持久化的会话条目（electron-store 'workbench.sessions'） */
export interface StoredSession {
  id: string
  title: string
  subtitle: string
  updatedAt: number
  /** 服务端会话 id（续接对话 + 素材池归属；无则首轮发送时由服务端创建） */
  serverSessionId: string
  mode: ChatMode
  messages: HistoryMessage[]
  /** 置顶会话（2026-09-01 用户需求：置顶组排在普通会话上面；旧数据缺省不置顶） */
  pinned?: boolean
}

const VALID_ROLES = ['user', 'assistant']

/**
 * 防御性恢复持久化会话（脏数据剔除 + 消息过滤 + CHAT_SAVE_ROUNDS 截断），
 * 数据结构向后兼容：未知字段忽略，缺字段给默认值。
 */
export function sanitizeSessions(raw: unknown): StoredSession[] {
  if (!Array.isArray(raw)) return []
  const out: StoredSession[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const d = item as Record<string, any>
    if (!d.id || typeof d.id !== 'string') continue
    const messages = Array.isArray(d.messages)
      ? (d.messages
          .filter(
            (m: any) =>
              m && typeof m === 'object' &&
              VALID_ROLES.includes(m.role) &&
              typeof m.content === 'string' && m.content.trim()
          )
          .map((m: any) => ({
            role: m.role,
            content: m.content,
            ...(typeof m.time === 'number' ? { time: m.time } : {})
          }))
          .slice(-CHAT_SAVE_ROUNDS) as HistoryMessage[])
      : []
    out.push({
      id: d.id,
      title: typeof d.title === 'string' && d.title ? d.title : '新会话',
      subtitle: typeof d.subtitle === 'string' ? d.subtitle : '',
      updatedAt: typeof d.updatedAt === 'number' ? d.updatedAt : 0,
      serverSessionId: typeof d.serverSessionId === 'string' ? d.serverSessionId : '',
      mode: d.mode === 'llm' ? 'llm' : 'agent',
      messages,
      ...(d.pinned === true ? { pinned: true } : {})
    })
  }
  return out
}

/** 会话按更新时间分组：今天 / 昨天 / 更早（对齐原侧栏分组语义） */
export function sessionGroupOf(updatedAt: number, now: number = Date.now()): SessionGroupKey {
  if (!updatedAt) return 'earlier'
  const startOfToday = new Date(now).setHours(0, 0, 0, 0)
  if (updatedAt >= startOfToday) return 'today'
  if (updatedAt >= startOfToday - 86400000) return 'yesterday'
  return 'earlier'
}

/* ── W7：会话删除/重命名/切换 纯函数（useWorkbenchSessions 复用；无 vue 依赖可单测） ── */

/**
 * 删除会话（本地 + 服务端联动编排的纯函数部分）：
 * 返回删除后的列表、被删会话绑定的服务端 session_id（供调用方决定是否调
 * agent:sessionDelete 同步清理服务端）、以及删除后的激活会话 id
 *（删的是当前激活会话 → 取列表首个；否则保持原 activeId）。
 */
export function applySessionDelete(
  sessions: StoredSession[],
  id: string,
  currentActiveId: string
): { list: StoredSession[]; removedServerSessionId: string; nextActiveId: string } {
  const idx = sessions.findIndex((s) => s.id === id)
  if (idx < 0) {
    return { list: [...sessions], removedServerSessionId: '', nextActiveId: currentActiveId }
  }
  const list = sessions.filter((s) => s.id !== id)
  const nextActiveId = currentActiveId === id ? (list[0]?.id || '') : currentActiveId
  return { list, removedServerSessionId: sessions[idx].serverSessionId || '', nextActiveId }
}

/** 会话标题规范化（重命名/恢复统一口径）：trim + 空值回退「新会话」 */
export function normalizeSessionTitle(title: string): string {
  const t = String(title || '').trim()
  return t || '新会话'
}

/**
 * 重命名会话：规范化标题 + 刷新 updatedAt（最近操作置顶语义，对齐
 * updateActive 口径）；目标不存在 → 原样返回新数组。
 */
export function applySessionRename(
  sessions: StoredSession[],
  id: string,
  title: string,
  now: number = Date.now()
): StoredSession[] {
  const idx = sessions.findIndex((s) => s.id === id)
  if (idx < 0) return [...sessions]
  const name = normalizeSessionTitle(title)
  return sessions.map((s, i) => (i === idx ? { ...s, title: name, updatedAt: now } : s))
}

/**
 * 置顶/取消置顶会话（2026-09-01 用户需求）：不传 pinned 则 toggle；
 * 目标不存在 → 原样返回新数组（与 applySessionRename 同风格，不突变输入）。
 */
export function applySessionPin(
  sessions: StoredSession[],
  id: string,
  pinned?: boolean
): StoredSession[] {
  const target = sessions.find((s) => s.id === id)
  if (!target) return [...sessions]
  const next = pinned !== undefined ? pinned : !target.pinned
  return sessions.map((s) => (s.id === id ? { ...s, pinned: next } : s))
}

/* ── 消息时间（2026-09-01 用户需求：每个消息框带时间；纯展示层格式化） ── */

const pad2 = (n: number) => String(n).padStart(2, '0')

/** 消息时间文案：无时间 → ''（欢迎语/错误提示不显示）；同天 HH:mm；
 *  昨天「昨天 HH:mm」；更早同年 MM-DD HH:mm；跨年 YYYY-MM-DD HH:mm */
export function chatTimeText(time: number | undefined, now: number = Date.now()): string {
  if (!time) return ''
  const d = new Date(time)
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
  const startOfToday = new Date(now).setHours(0, 0, 0, 0)
  if (time >= startOfToday) return hm
  if (time >= startOfToday - 86400000) return `昨天 ${hm}`
  const y = d.getFullYear()
  const md = `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
  return y === new Date(now).getFullYear() ? `${md} ${hm}` : `${y}-${md} ${hm}`
}

/**
 * 切换会话时的服务端会话绑定：返回目标会话持久化的 serverSessionId
 *（续接对话 + 素材池归属）；目标不存在 → ''（新会话语义，首轮发送时由
 * 服务端创建并回填，见 useWorkbenchChat.sendText）。
 */
export function pickSessionServerId(sessions: StoredSession[], id: string): string {
  const s = sessions.find((x) => x.id === id)
  return (s && s.serverSessionId) || ''
}

/**
 * 指定模式下最近的一个会话（updatedAt 最大；无则 null）。
 * 快捷条模式切换复用已有会话用：原「切换即新建」在多会话列表下
 * 来回切换会不停堆积空会话（2026-08-31 用户反馈）。
 */
export function latestSessionOfMode<T extends { mode: ChatMode; updatedAt: number }>(
  sessions: T[],
  mode: ChatMode
): T | null {
  let best: T | null = null
  for (const s of sessions) {
    if (s && s.mode === mode && (!best || s.updatedAt > best.updatedAt)) best = s
  }
  return best
}

/* ── W8：回复成片视频资产识别（原 _detect_video_asset L1392-1418 三级识别） ── */

/** 气泡内挂载的成片视频资产（播放/下载按钮数据源） */
export interface VideoAsset {
  /** 可播放/下载的视频地址（相对路径已拼 serverBase；绝对 URL 原样） */
  url: string
  /** 关联渲染任务 ID（0=无；来自 ② 相对路径 或 ③ 任务 ID 兜底） */
  taskId: string
}

/** 绝对 URL 中判定视频的特征（原版 _VIDEO_URL_HINTS） */
const VIDEO_URL_HINTS = ['.mp4', '/render', '/result', '/video', '/output', '/download']
/** 绝对 URL 匹配（原版 _URL_RE：排除空白与中文标点） */
const ABS_URL_RE = /https?:\/\/[^\s)\]}>，。；、]+/g
/** 成片相对路径（原版 _REL_URL_RE：/editor/render/{id}/result 及后缀） */
const REL_RESULT_RE = /\/editor\/render\/(\d+)\/result[^\s]*/
/** 成片/渲染语境（原版 ③ 兜底判定条件） */
const RENDER_CTX_RE = /(成片|渲染|一键成片|render)/i
/** 任务 ID 提取（原版 ③：任务 ID / task id 后跟数字，可带 #） */
const TASK_ID_RE = /(?:任务\s*ID|task\s*id)\s*[:：]?\s*#?(\d+)/i

/**
 * 从智能体回复中提取成片视频地址（供气泡挂播放/下载按钮）。
 *
 * 识别顺序（对齐原版 _detect_video_asset L1392-1418）：
 *   ① 文本中带视频特征的绝对 URL（hints：.mp4 /render /result /video /output /download）；
 *   ② /editor/render/{id}/result 相对路径 → 拼 serverBase；
 *   ③ 「任务ID：#N」+ 成片语境（成片/渲染/一键成片/render）→ 服务端 render 结果端点兜底。
 * 返回 VideoAsset 或 null（无资产时不挂按钮）。
 */
export function detectVideoAsset(text: string, serverBase?: string): VideoAsset | null {
  const src = String(text || '')
  if (!src) return null
  // ① 绝对 URL（含视频特征）
  ABS_URL_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = ABS_URL_RE.exec(src))) {
    const u = String(m[0]).replace(/[.,;:!?]+$/, '')
    if (VIDEO_URL_HINTS.some((k) => u.toLowerCase().includes(k))) {
      return { url: u, taskId: '' }
    }
  }
  const base = serverBase ? String(serverBase).replace(/\/+$/, '') : ''
  // ② 相对路径
  m = REL_RESULT_RE.exec(src)
  if (m) {
    return { url: base + m[0], taskId: m[1] }
  }
  // ③ 任务 ID 兜底（仅当消息含成片/渲染语境，避免误判普通编号）
  if (RENDER_CTX_RE.test(src)) {
    m = TASK_ID_RE.exec(src)
    if (m) {
      return { url: `${base}/editor/render/${m[1]}/result`, taskId: m[1] }
    }
  }
  return null
}

/* ── W10：对话资产识别（右侧工作台预览面板数据源；纯函数可单测） ── */

/** 气泡可预览资产（script=代码块 / text=长文案 / table=markdown 表格） */
export interface ChatAsset {
  id: string
  type: 'script' | 'text' | 'table'
  /** 代码块语言 / 表格表头首列 / 首个标题或首行（超长截断 ≤30，兜底「内容资产」） */
  title: string
  /** 代码块内容 / 正文全文 / 表格原文 */
  content: string
  /** script 资产的代码语言标注（小写；text/table 无） */
  lang?: string
}

/** 资产标题最大长度（超长截断，PRD 面板标题展示口径） */
const ASSET_TITLE_MAX = 30

/** Markdown 代码块（```lang\n...\n```，语言标注可含 + / -） */
const CODE_FENCE_RE = /```([\w+-]*)\s*\n([\s\S]*?)```/g
/** Markdown 表格（表头 + 分隔行 + ≥1 数据行；分隔行须含 - 避免误吞内容行） */
const MD_TABLE_RE = /^\|.*\|\s*\n\|?[\s:|-]+-[\s:|-]*\|?\s*\n(?:^\|.*\|\s*\n?)+/gm
/** Markdown 标题结构（# 开头，text 资产判定） */
const MD_HEADING_RE = /^#{1,6}\s+(.+)$/m

/** 文档类语言标注（无代码展示价值，不识别为 script 资产） */
const DOC_LANGS = new Set(['text', 'markdown', 'md', 'plaintext', 'plain', 'txt', 'console', 'output', 'diff'])

/** 标题规范化：压缩空白 + 超长截断（≤30 字符），空值兜底「内容资产」 */
function truncateTitle(s: string, max: number = ASSET_TITLE_MAX): string {
  const t = String(s || '').replace(/\s+/g, ' ').trim()
  return t ? t.slice(0, max) : '内容资产'
}

/** 表格标题：表头行第一列单元格（trim），兜底「表格」 */
function tableHeaderTitle(table: string): string {
  const header = String(table).split(/\r?\n/)[0] || ''
  const cell = header.split('|').map((c) => c.trim()).find(Boolean)
  return cell || '表格'
}

/**
 * 从 AI 回复中识别可预览资产（右侧工作台预览面板数据源）：
 *   · script：markdown 代码块且语言标注为脚本/编程语言（python/javascript/shell/bash…）
 *   · table ：markdown 表格（表头 + 分隔行 + ≥1 数据行）
 *   · text  ：去除代码块/表格后的长文案（>3 行或含 # 标题结构，如分镜脚本/方案/文案）
 * 输出 ChatAsset[]：title 为代码块语言 / 表格表头首列 / 首个标题或首行（截断 ≤30）。
 * 无资产返回 []；正文/代码块/表格缺内容均不产出空资产。
 */
export function detectChatAssets(content: string): ChatAsset[] {
  const src = String(content || '')
  if (!src.trim()) return []
  const assets: ChatAsset[] = []
  let n = 0

  // ① 代码块（语言标注非文档类 → script）
  CODE_FENCE_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = CODE_FENCE_RE.exec(src))) {
    const lang = String(m[1] || '').trim().toLowerCase()
    if (!lang || DOC_LANGS.has(lang)) continue
    n += 1
    assets.push({ id: `asset-${n}`, type: 'script', title: truncateTitle(m[1]), content: m[2], lang })
  }

  // ② markdown 表格 → table
  MD_TABLE_RE.lastIndex = 0
  while ((m = MD_TABLE_RE.exec(src))) {
    n += 1
    assets.push({ id: `asset-${n}`, type: 'table', title: truncateTitle(tableHeaderTitle(m[0])), content: m[0].trim() })
  }

  // ③ 正文（去除代码块/表格后的剩余文本）→ text（长文案：>3 行或含标题结构）
  const body = src.replace(CODE_FENCE_RE, '').replace(MD_TABLE_RE, '').trim()
  if (body) {
    const lines = body.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    const h = body.match(MD_HEADING_RE)
    if (lines.length > 3 || h) {
      n += 1
      assets.push({ id: `asset-${n}`, type: 'text', title: truncateTitle(h ? h[1] : lines[0]), content: body })
    }
  }
  return assets
}

/** Markdown 表格原文 → 二维数组（预览面板表格渲染；剔除分隔行，行内单元 trim） */
export function parseMarkdownTable(text: string): string[][] {
  const rows: string[][] = []
  for (const line of String(text || '').split(/\r?\n/)) {
    const t = line.trim()
    if (!t.startsWith('|') || !t.endsWith('|')) continue
    if (/^[\s:|-]+$/.test(t.slice(1, -1))) continue // 分隔行（| --- | --- |）
    rows.push(t.slice(1, -1).split('|').map((c) => c.trim()))
  }
  return rows
}

/* ── W9：引用回复 / 重新生成 纯函数（原 _on_quote L1283-1289 / _on_regenerate L1291-1318） ── */

/** 消息原文 → Markdown 引用块（原版 _on_quote：逐行 "> " 前缀，空文本兜底 "> "） */
export function buildQuoteText(text: string): string {
  const quoted = String(text || '')
    .split(/\r?\n/)
    .map((ln) => `> ${ln}`)
    .join('\n')
  return quoted || '> '
}

/** 引用块插入输入框后的完整内容（原版 _on_quote L1285-1287：现有内容拼在引用块下方） */
export function buildQuoteInsert(text: string, currentInput: string): string {
  const quoted = buildQuoteText(text)
  const cur = String(currentInput || '')
  return cur.trim() ? `${quoted}\n\n${cur}` : quoted + '\n'
}

/** 重新生成时回退会话历史：删除指定用户提问后紧跟的旧 assistant 回复（原版 L1312-1317；
 *  找不到该轮则原样返回，不影响重发）。 */
export function regenerateHistoryTrim(
  history: HistoryMessage[],
  userText: string
): HistoryMessage[] {
  const out = [...history]
  for (let i = 0; i < out.length; i++) {
    const m = out[i]
    if (m.role === 'user' && m.content === userText) {
      if (i + 1 < out.length && out[i + 1].role === 'assistant') out.splice(i + 1, 1)
      break
    }
  }
  return out
}
