import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { getTintin, readCfg, readCacheDir } from './useSettingsConfig'
import { joinDefaultPath } from './settingsIntegrationLogic'
import {
  trimHistory,
  buildLlmMessages,
  extractAgentReply,
  extractLlmReply,
  basenameOf,
  detectVideoAsset,
  buildQuoteInsert,
  regenerateHistoryTrim,
  type HistoryMessage,
  type ChatMode,
  type ChatAttachment,
  type VideoAsset,
  type PlanExecMode
} from './workbenchChatLogic'
import {
  buildContextText,
  appendContextText,
  type CtxProductItem,
  type CtxMaterialItem,
  type CtxScriptItem
} from './workbenchChatContext'
import type { AgentAPI, LLMAPI } from '../../../types/server-api'

/* ── 消息数据 ──────────────────────────────────────────────── */
export type Role = 'user' | 'ai'

export interface ChatMessage {
  id: string
  role: Role
  content: string
  /** 气泡状态：pending=等待回复（发送中占位）/ error=失败提示 */
  status?: 'pending' | 'error'
  shots?: Array<{ index: number; label: string; desc: string }>
  /** W8：回复含成片视频资产 → 气泡挂播放/下载（原版 set_asset_actions） */
  video?: VideoAsset
  /** 计划任务模式（mode=plan）：该回复是服务端 pending_approval 计划草稿，可确认执行 */
  confirmable?: boolean
  /** 已确认执行（卡片显示执行中状态；不改写 content——追加文本会破坏 plan JSON 结构） */
  planApproved?: boolean
  /** 消息时间戳（2026-09-01 用户需求：消息框带时间；欢迎语/错误提示缺省不显示） */
  time?: number
  /** 草稿对应的服务端任务 id 与确认端点（approve；确认时优先使用） */
  draftTaskId?: string
  draftConfirmPath?: string
}

/** 发送后超时自动恢复输入（原版 _on_busy_timeout L1438-1445 口径） */
const BUSY_TIMEOUT_MS = 120000
/** 通用对话 temperature（原版 _ChatWorker llm 分支 L649-650） */
const LLM_TEMPERATURE = 0.4

/** 对话流程内的可预期失败：message 即用户可读文案（不再二次包装） */
class ChatFlowError extends Error {}

/** 服务端离线（IPC 静默 null）→ 统一引导文案 */
const OFFLINE_TEXT = '网络异常：无法连接服务端，请检查「设置 → 服务端」的地址与网络后重试。'

/**
 * 工作台消息域（P1 真实链路）：发送 → 服务端 /agent/chat 或 /llm/chat/completions
 *（经主进程 IPC）→ 回复渲染 + 服务端会话续接。
 *
 * 业务口径对照原客户端 gui/agent_home_page.py：
 * - 防重入（_send_text L1240-1241）/ 思考中占位气泡（L1258-1262）
 * - 120s 超时恢复输入，回复迟到仍显示（_on_busy_timeout L1438-1445）
 * - agent 模式 history 传不含本轮的 msgs[:-1]，max_rounds=3，mode=plan 可选（L633-636）
 * - llm 模式 temperature=0.4（L649-650），空 history 注入系统提示词
 * - 服务端会话续接：响应 session_id 首次保存，后续轮次携带（_on_reply_ok L1374-1377）
 * - 失败气泡（_on_reply_failed L1429-1436）；取消=切换/新建会话（generation 丢弃迟到回复）
 *
 * DOM 归属拆分说明：scrollToBottom 由容器桥接到 WbMessages；会话持久化经
 * onSessionUpdate 回调交给会话域（useWorkbenchSessions，electron-store 单一真相源）。
 */
export function useWorkbenchChat(options?: {
  scrollToBottom?: () => void
  /** 历史/服务端会话变化时回写给当前会话（会话域持久化） */
  onSessionUpdate?: (patch: {
    serverSessionId?: string
    history?: HistoryMessage[]
    subtitle?: string
  }) => void
}) {
  const router = useRouter()

  /* ── 气泡流（渲染）与 LLM 历史（上下文）分离：欢迎语/错误提示不进 history ── */
  const messages = ref<ChatMessage[]>([])
  const history = ref<HistoryMessage[]>([])
  const inputText = ref<string>('')
  const sending = ref<boolean>(false)
  /** 当前会话绑定的服务端 session_id（续接对话 + 素材池归属） */
  const sessionId = ref<string>('')
  /** 取消代币：切换/新建会话后递增，迟到的响应按代号丢弃 */
  let generation = 0
  let busyTimer: ReturnType<typeof setTimeout> | null = null

  /* ── 模式 / 模型（定稿 2026-08-28：模式分段与模型下拉移除，
     模型切换只在系统设置；输入区只读 llm.defaultModel 偏好） ── */
  const mode = ref<ChatMode>('agent')
  /** 任务选择器（原版 chk_plan L1130-1135 勾选 → 2026-08-31 改三档选择器） */
  const planMode = ref<PlanExecMode>('agent')
  /** 服务端模型偏好（llm.defaultModel；空 = 服务端默认模型） */
  const selectedModel = ref<string>('')
  /** 当前选中的智能体 agent_id（服务端严格校验，2026-08-16 起；空=不指定） */
  const selectedAgentId = ref<string>('')

  /** 设置选中智能体（快捷条/斜杠菜单点击时调用；传空=取消选中） */
  function setSelectedAgent(agentId: string) {
    selectedAgentId.value = String(agentId || '')
  }

  /** 初始化模型偏好：读设置页同源偏好（electron-store 单一真相源，不拉模型列表） */
  async function initModel() {
    selectedModel.value = String(await readCfg('llm.defaultModel', ''))
  }

  /* ── 模式切换（原版 _on_mode_changed L1459-1466：切换视为新会话） ──
     会话重置/删除由容器经 sessions 域的 resetActiveSession 编排 */
  function setMode(next: ChatMode) {
    if (mode.value === next) return
    mode.value = next
  }

  /* ── 会话附件（素材池，对照原版 _ctx_attachments / _start_pool_upload） ──
     胶囊为会话内临时上下文（原版不持久化），切换/新建会话即清空 */
  const attachments = ref<ChatAttachment[]>([])

  /** 单个附件入池：成功记 file_ref，失败标 failed（下次发送重试）；
   *  截图等 infoOnly 附件不入素材池（素材池是产品素材，截图仅提供信息） */
  async function uploadToPool(att: ChatAttachment) {
    if (att.infoOnly) return // 截图信息附件：保持 pending，仅随上下文文本提供信息
    const t = getTintin()
    if (!t?.server?.agentSessionAttachmentAdd || !sessionId.value) {
      att.state = 'failed'
      return
    }
    att.state = 'uploading'
    try {
      const r = await t.server.agentSessionAttachmentAdd(
        att.materialId
          ? { id: sessionId.value, materialId: att.materialId } // 素材库引用（session_attachment_add material_id 口径）
          : { id: sessionId.value, filePath: att.path }
      )
      if (r && !('error' in r)) {
        const entry = r.attachment || r.item
        att.poolKey = entry?.file_ref || ''
        att.state = 'pooled'
      } else {
        att.state = 'failed'
      }
    } catch (_e) {
      att.state = 'failed'
    }
  }

  /** 选择本地附件加入上下文（原版 _add_attachment_files L1759-1775：按路径去重；
   *  已有服务端会话 → 立即后台入池；无会话 → pending，首轮发送时统一入池）。
   *  2026-08-30：新增 infoOnly 参数——剪贴板截图等「只提供信息」附件，
   *  标记 infoOnly 后不入素材池（素材池是产品素材），发送时仅拼上下文文本。 */
  function addAttachments(paths: string[], infoOnly = false) {
    for (const raw of paths || []) {
      const p = String(raw || '').trim()
      if (!p || attachments.value.some((a) => a.path === p)) continue
      const att: ChatAttachment = { name: basenameOf(p), path: p, state: 'pending', ...(infoOnly ? { infoOnly: true } : {}) }
      attachments.value.push(att)
      if (mode.value === 'agent' && sessionId.value && !infoOnly) void uploadToPool(att)
    }
  }

  /** 剪贴板截图 → 截图信息附件（不入素材池；与 addAttachments 同去重口径） */
  function addScreenshots(paths: string[]) {
    addAttachments(paths, true)
  }

  /** 移除胶囊：已入池 → DELETE 素材池（原版 _remove_ctx L1619-1637：移除未生效则保留） */
  async function removeAttachment(index: number) {
    const att = attachments.value[index]
    if (!att) return
    if (att.poolKey && sessionId.value) {
      const t = getTintin()
      const r = t?.server?.agentSessionAttachmentRemove
        ? await t.server.agentSessionAttachmentRemove(sessionId.value, att.poolKey)
        : null
      if (!r || ('error' in r && r.error)) {
        att.state = 'failed' // 移除未生效：胶囊保留（服务端仍会注入该附件）
        return
      }
    }
    attachments.value.splice(index, 1)
  }

  /* ── 对话上下文：产品/脚本（原版 _ctx_product/_ctx_scripts L1050-1052：
     选择区胶囊，不随发送清空，发送时按 _build_context_text 口径拼入） ── */
  const ctxProduct = ref<CtxProductItem | null>(null)
  const ctxScripts = ref<CtxScriptItem[]>([])

  /** 选择产品加入上下文（原版 _pick_product：产品单选覆盖） */
  function addCtxProduct(item: CtxProductItem) {
    if (!item) return
    ctxProduct.value = item
  }

  /** 移除产品胶囊（原版 _remove_ctx "product" 分支） */
  function removeCtxProduct() {
    ctxProduct.value = null
  }

  /** 选择脚本加入上下文（原版 _pick_script：按 id 去重） */
  function addCtxScript(item: CtxScriptItem) {
    const id = String(item?.id ?? '')
    if (!id || ctxScripts.value.some((s) => String(s.id ?? '') === id)) return
    ctxScripts.value.push(item)
  }

  /** 移除脚本胶囊（原版 _remove_ctx "script" 分支） */
  function removeCtxScript(index: number) {
    ctxScripts.value.splice(index, 1)
  }

  /**
   * 选择素材加入会话素材池（原版 _pick_material + _start_pool_add：按
   * material_id 去重；入池走 session_attachment_add 的 material_id 引用，
   * 无本地文件上传）。已有会话 → 立即入池；否则 pending 首轮发送统一入池。
   */
  function addCtxMaterial(item: CtxMaterialItem) {
    const mid = String(item?.id ?? item?.material_id ?? '')
    if (!mid || attachments.value.some((a) => a.materialId === mid)) return
    const att: ChatAttachment = {
      name: String(item?.filename || mid),
      path: '',
      materialId: mid,
      material: item as unknown as Record<string, unknown>,
      state: 'pending'
    }
    attachments.value.push(att)
    if (mode.value === 'agent' && sessionId.value) void uploadToPool(att)
  }

  /**
   * 音频库条目加入上下文（2026-08-31「选择素材」弹窗音频 tab）：音频非
   * 产品素材 → infoOnly 信息胶囊不入素材池，随上下文文本拼【参考音频】。
   */
  function addCtxAudio(item: Record<string, unknown>) {
    const name = String(item?.filename || item?.title || item?.name || '').trim()
    if (!name || attachments.value.some((a) => a.infoOnly && a.name === name)) return
    attachments.value.push({
      name,
      path: '',
      state: 'pooled',
      infoOnly: true,
      material: { ...item, media_type: 'audio' }
    })
  }

  function setBubble(id: string, content: string, status?: ChatMessage['status']) {
    const bubble = messages.value.find((m) => m.id === id)
    if (bubble) {
      bubble.content = content
      bubble.status = status
    }
  }

  /** 当前会话内容落盘（用户消息先落、回复后落：原版 _save_chat 时序） */
  function persist(subtitle?: string) {
    options?.onSessionUpdate?.({
      serverSessionId: sessionId.value,
      history: [...history.value],
      ...(subtitle !== undefined ? { subtitle } : {})
    })
  }

  function clearBusyTimer() {
    if (busyTimer !== null) {
      clearTimeout(busyTimer)
      busyTimer = null
    }
  }

  function abortPending() {
    generation++
    clearBusyTimer()
    sending.value = false
  }

  /** 新会话欢迎消息（原版 append_bubble 欢迎语口径，欢迎语不属于 LLM 历史） */
  function resetToWelcome() {
    abortPending()
    sessionId.value = ''
    history.value = []
    attachments.value = [] // 原版 _reset_session L1649：新会话清空上下文胶囊
    ctxProduct.value = null // 原版 _reset_session L1650-1652：产品/脚本上下文一并清空
    ctxScripts.value = []
    messages.value = [
      {
        id: 'm-welcome',
        role: 'ai',
        content:
          '你好，我是 TinTin 智能体助手。\n\n' +
          '可以直接说需求；底部选择器切「智能体」会把对话转编排任务拆解执行；\n' +
          '切「计划任务」先出计划草稿，点「确认执行」后才提交服务端执行。'
      }
    ]
  }

  /** 切换会话：恢复气泡流 + 续接服务端会话（素材池仍在服务端）；
   *  附带该会话的模式（会话创建时固化，原版模式切换即新会话）；
   *  历史消息带时间（2026-09-01 消息框带时间），容器桥接恢复气泡流 */
  function loadSession(payload: {
    serverSessionId: string
    messages: HistoryMessage[]
    mode?: ChatMode
  }) {
    abortPending()
    sessionId.value = payload.serverSessionId || ''
    if (payload.mode) mode.value = payload.mode
    history.value = payload.messages.map((m) => ({
      role: m.role,
      content: m.content,
      ...(m.time ? { time: m.time } : {})
    }))
    attachments.value = [] // 胶囊不持久化（原版 _restore_chat 只恢复消息）
    ctxProduct.value = null // 产品/脚本上下文同为会话内临时状态，不跨会话携带
    ctxScripts.value = []
    messages.value = history.value.map((m, i) => ({
      id: `r${i}-${Date.now()}`,
      role: m.role === 'user' ? 'user' : 'ai',
      content: m.content,
      ...(m.time ? { time: m.time } : {})
    }))
  }

  /** 发送输入框消息（原版 _send_text 链路；普通发送入口） */
  function handleSend() {
    const text = inputText.value.trim()
    if (!text || sending.value) return
    return sendText(text)
  }

  /**
   * 「确认执行」（计划任务档两段式第二步，2026-08-31 新契约）：服务端 mode=plan
   * 已建 pending_approval 草稿，此处 POST /agent/tasks/{id}/approve 确认后才执行
   * （端点优先用草稿响应携带的 confirm；approve 不可用时回落 taskConfirm）。
   */
  async function confirmPlanExec() {
    if (sending.value) return
    const lastAi = [...messages.value].reverse().find((m) => m.role === 'ai')
    if (!lastAi?.confirmable || !lastAi.draftTaskId) return
    const taskId = lastAi.draftTaskId
    const t = getTintin()
    if (!t?.server) {
      setBubble(lastAi.id, '网络不可用，无法确认执行，请稍后重试。', 'error')
      return
    }
    // approve 优先（agent_chat.py 新契约 confirm 字段）；失败回落既有 taskConfirm 端点
    const paths = [lastAi.draftConfirmPath || '', `/agent/tasks/${taskId}/approve`, `/agent/tasks/${taskId}/confirm`]
    let ok = false
    let lastErr = ''
    for (const path of paths.filter(Boolean)) {
      try {
        const r: unknown = await t.server.post(path)
        if (r === null) { lastErr = OFFLINE_TEXT; continue }
        if (r && typeof r === 'object' && 'error' in (r as Record<string, unknown>) && (r as Record<string, unknown>).error) {
          lastErr = String((r as Record<string, unknown>).error)
          continue
        }
        ok = true
        break
      } catch (err) {
        lastErr = err instanceof Error ? err.message : String(err)
      }
    }
    if (!ok) {
      setBubble(lastAi.id, `确认执行失败：${lastErr || '服务端未响应'}（任务 ${taskId}）`, 'error')
      return
    }
    lastAi.confirmable = false
    // 已确认状态走气泡字段（卡片「执行中」徽章），不改写 content：
    // 往 JSON 后追加文本会使 parsePlanContent 解析失效 → 卡片退化为裸 JSON 纯文本
    //（2026-09-01 用户反馈）；history 尾条同步保持纯 plan JSON（重载后卡片仍可渲染）
    lastAi.planApproved = true
    persist()
  }

  /**
   * 发送一条消息（原版 _send_text 链路）；regenBubbleId 非空时为「重新生成」：
   * 不新建用户气泡，新回复替换该旧助手气泡（原版 L1237-1239 regen 分支）。
   */
  async function sendText(text: string, opts?: { regenBubbleId?: string }) {
    const regenBubbleId = opts?.regenBubbleId
    const gen = ++generation
    inputText.value = ''

    // 用户气泡 + history 追加（原版 L1242-1248）；重新生成：用户气泡已在消息流，
    // history 不重复追加（该轮提问保留，服务端按传入 history 重建上下文实现回退）
    let pendingId: string
    if (regenBubbleId) {
      const target = messages.value.find((m) => m.id === regenBubbleId)
      if (!target || target.role !== 'ai') return
      pendingId = regenBubbleId
      target.content = '思考中…'
      target.status = 'pending'
      target.video = undefined // 内容被替换 → 清旧回复挂的资产按钮（原版 set_text L520-527）
      target.confirmable = false
      target.draftTaskId = undefined
      target.draftConfirmPath = undefined
    } else {
      const now = Date.now()
      messages.value.push({ id: `u${now}`, role: 'user', content: text, time: now })
      history.value = trimHistory([...history.value, { role: 'user', content: text, time: now }])
      // 「思考中…」占位气泡（原版 L1258-1262）
      pendingId = `a${Date.now()}`
      messages.value.push({ id: pendingId, role: 'ai', content: '思考中…', status: 'pending' })
    }
    options?.scrollToBottom?.()
    sending.value = true
    persist(text) // 用户消息先落盘（原版 _save_chat L1249）
    // 120s 超时恢复输入；回复迟到仍显示（原版 _busy_timer + _on_busy_timeout）
    busyTimer = setTimeout(() => {
      busyTimer = null
      if (gen !== generation) return
      sending.value = false
      setBubble(pendingId, '请求超过 120 秒未返回，已恢复输入；回复稍后到达会直接显示。', 'error')
    }, BUSY_TIMEOUT_MS)

    let replyText = ''
    // 计划任务档草稿信息（agent 分支解析，落气泡时用：parsed 作用域在分支内）
    let draftInfo: { taskId: string; confirmPath: string } | null = null
    try {
      const t = getTintin()
      if (!t?.server) throw new ChatFlowError(OFFLINE_TEXT)
      // history 传不含本轮的 msgs[:-1]（原版 L633 agent / L644 llm 同源）；
      // 重新生成：本轮提问已在 history 末位（不重复追加），全量回传重建上下文
      const prevHistory = regenBubbleId
        ? [...history.value]
        : history.value.slice(0, -1)
      // 2026-08-31 修复：history 元素来自 ref 深层响应式（Vue Proxy），直接经 IPC
      // 结构化克隆会抛「An object could not be cloned」（多轮对话第二轮起必现）→
      // 发送前深拷贝成纯对象（与 loadSession 的纯化口径一致）
      const plainHistory: HistoryMessage[] = JSON.parse(JSON.stringify(prevHistory))
      if (mode.value === 'agent') {
        // 首轮发送且有待入池附件 → 先轻量建会话再一次性入池（原版 L622-632：
        // create_session 失败则中断发送并提示，附件保持 pending 待重试）。
        // 截图等 infoOnly 附件不入池，不参与「是否建会话」判断。
        const poolable = attachments.value.filter(
          (a) => !a.infoOnly && (a.state === 'pending' || a.state === 'failed')
        )
        if (poolable.length && !sessionId.value) {
          const cr = await t.server.agentChat({ message: '会话初始化', maxRounds: 1 })
          if (gen !== generation) return
          const sid = cr && !('error' in cr) ? String(cr.session_id || '') : ''
          if (!sid) throw new ChatFlowError('创建服务端会话失败，素材无法入池，请稍后重试')
          sessionId.value = sid
        }
        for (const a of poolable) {
          if (!sessionId.value) break
          await uploadToPool(a) // 单个失败不中断发送（原版 L628-632 同口径）
        }
        if (gen !== generation) return
        // 发送内容 = 用户原文 + 上下文（原版 _send_text L1244-1246：f"{text}\n\n{ctx}"；
        // agent 模式素材/附件已入服务端素材池，上下文文本只拼【产品】【脚本】）
        const agentCtx = buildContextText({
          product: ctxProduct.value,
          scripts: ctxScripts.value,
          atts: attachments.value,
          poolMode: true
        })
        // 任务选择器三档 → 服务端 mode（chat/agent/plan，agent_chat.py 2026-08-31 契约）
        const reqMode = planMode.value === 'off' ? 'chat' : planMode.value === 'agent' ? 'agent' : 'plan'
        const r: AgentAPI.ChatResponse | null | { error: string } = await t.server.agentChat({
          message: appendContextText(text, agentCtx),
          history: plainHistory.length ? plainHistory : undefined,
          agent_id: selectedAgentId.value || undefined,
          model: selectedModel.value || undefined,
          mode: reqMode,
          sessionId: sessionId.value || undefined
        })
        if (gen !== generation) return // 用户已切换/新建会话：丢弃迟到回复
        if (r === null || r === undefined) throw new ChatFlowError(OFFLINE_TEXT)
        if (r && typeof r === 'object' && 'error' in r && r.error) {
          throw new ChatFlowError(`出错了：${r.error}`)
        }
        const parsed = extractAgentReply(r, reqMode)
        if (!parsed) throw new ChatFlowError('服务端未返回内容，请稍后重试')
        replyText = parsed.reply
        // 计划任务档：服务端 pending_approval 草稿 → 带出任务 id 与确认端点
        if (parsed.isDraft && parsed.taskId) {
          draftInfo = { taskId: parsed.taskId, confirmPath: parsed.confirmPath }
        }
        // 会话续接：首次保存服务端 session_id（原版 _on_reply_ok L1374-1377）
        if (parsed.sessionId && !sessionId.value) {
          sessionId.value = parsed.sessionId
        }
      } else {
        // 通用对话：无服务端会话，上下文（产品/素材/脚本/附件）全文本拼接
        //（原版 _build_context_text pool_mode=False + _send_text L1244-1246
        //  f"{text}\n\n{ctx}"；历史仍存用户原文，不带上下文）
        const ctxText = buildContextText({
          product: ctxProduct.value,
          scripts: ctxScripts.value,
          atts: attachments.value,
          poolMode: false
        })
        const msgs = buildLlmMessages(plainHistory, appendContextText(text, ctxText))
        const r: LLMAPI.ChatCompletionsResponse | null | { error: string } =
          await t.server.llmChat({
            model: selectedModel.value || undefined,
            messages: msgs as LLMAPI.ChatMessage[],
            temperature: LLM_TEMPERATURE
          })
        if (gen !== generation) return
        if (r === null || r === undefined) throw new ChatFlowError(OFFLINE_TEXT)
        if (r && typeof r === 'object' && 'error' in r && r.error) {
          throw new ChatFlowError(`出错了：${r.error}`)
        }
        const reply = extractLlmReply(r)
        if (!reply) throw new ChatFlowError('服务端未返回内容，请稍后重试')
        replyText = reply
      }

      // 回复落气泡 + history（原版 _on_reply_ok L1378-1382）；时间随落盘记录（2026-09-01）
      const repliedAt = Date.now()
      setBubble(pendingId, replyText)
      const replyBubble = messages.value.find((m) => m.id === pendingId)
      if (replyBubble) replyBubble.time = repliedAt
      // 计划任务档（mode=plan）：本回复是服务端 pending_approval 草稿 → 挂任务 id
      // 与确认端点，用户点「确认执行」后 POST approve（服务端才启动执行）
      if (draftInfo) {
        const bubble = messages.value.find((m) => m.id === pendingId)
        if (bubble) {
          bubble.confirmable = true
          bubble.draftTaskId = draftInfo.taskId
          bubble.draftConfirmPath = draftInfo.confirmPath
        }
      }
      history.value = trimHistory([...history.value, { role: 'assistant', content: replyText, time: repliedAt }])
      persist(replyText)
      // W8：回复含成片视频资产 → 气泡挂播放/下载（原版 _on_reply_ok L1387-1390）
      void attachVideoAsset(pendingId, replyText)
    } catch (e) {
      if (gen !== generation) return
      const text2 =
        e instanceof ChatFlowError
          ? e.message
          : `出错了：${String((e as Error)?.message || e)}`
      setBubble(pendingId, text2, 'error')
      options?.scrollToBottom?.()
    } finally {
      clearBusyTimer()
      if (gen === generation) sending.value = false
    }
  }

  /* ── W8：回复成片视频资产（识别 / 播放 / 下载，原 set_asset_actions L538-590） ── */
  /** 服务端地址缓存（相对路径 → 绝对 URL；单一地址源 getServerUrl 经 env:serverPing 取回） */
  const serverBase = ref<string>('')
  async function ensureServerBase(): Promise<string> {
    if (serverBase.value) return serverBase.value
    try {
      const ping = await getTintin()?.env?.serverPing?.()
      serverBase.value = String(ping?.url || '').replace(/\/+$/, '')
    } catch (_e) {
      /* 预览环境无 env 桥 → 空串，相对路径保持相对（下载时主进程按 getServerUrl 解析） */
    }
    return serverBase.value
  }

  /** 回复落气泡后检测成片视频资产并挂到气泡（原版 _on_reply_ok L1387-1390） */
  async function attachVideoAsset(id: string, text: string) {
    const base = await ensureServerBase()
    const bubble = messages.value.find((m) => m.id === id)
    if (bubble) bubble.video = detectVideoAsset(text, base) ?? undefined
  }

  /**
   * 下载成片：系统保存对话框选路径 → 主进程 server:downloadResult（服务端 URL → 本地落盘，
   * 相对路径由主进程按 getServerUrl 解析）→ 定位文件（原版 _download_asset L568-587）。
   */
  async function downloadVideoAsset(asset: VideoAsset) {
    const t = getTintin()
    if (!t?.dialog?.saveFile || !t?.server?.downloadResult) return
    const defaultName = asset.taskId ? `render_${asset.taskId}.mp4` : 'render_video.mp4'
    // 默认保存到缓存目录（local.cacheDir；未配置则系统默认位置，对齐原 aigen L1044）
    const cacheDir = await readCacheDir()
    const savePath = await t.dialog.saveFile({
      title: '保存成片',
      defaultPath: joinDefaultPath(cacheDir, defaultName),
      filters: [{ name: '视频文件', extensions: ['mp4', 'mov', 'webm'] }]
    })
    if (!savePath) return // 用户取消
    try {
      await t.server.downloadResult(asset.url, savePath)
      t.shell?.revealInFolder?.(savePath)
    } catch (e) {
      window.alert?.(`下载成片失败：${String((e as Error)?.message || e)}`)
    }
  }

  /* ── W9：引用回复（原 _on_quote L1283-1289） ── */
  /** 引用消息到输入框：原文逐行 "> " 引用块置顶，现有输入拼其下（业务纯函数在 logic 层） */
  function quoteMessage(id: string) {
    const m = messages.value.find((x) => x.id === id)
    if (!m || !m.content) return
    inputText.value = buildQuoteInsert(m.content, inputText.value)
  }

  /* ── W9：重新生成（原 _on_regenerate L1291-1318） ── */
  /** 找到该回复对应的用户提问重发，新回复替换旧气泡；会话历史回退该轮 */
  async function handleRegenerate(id: string) {
    if (sending.value) return // 原版 L1297-1298：发送中不响应
    const idx = messages.value.findIndex((m) => m.id === id)
    if (idx < 0) return
    const bubble = messages.value[idx]
    if (!bubble || bubble.role !== 'ai' || bubble.status === 'pending') return // 原版 L1299-1300
    // 消息区中该气泡前最近的用户气泡即对应提问（原版 L1301-1310）
    let userText = ''
    for (let i = idx - 1; i >= 0; i--) {
      if (messages.value[i].role === 'user') {
        userText = messages.value[i].content
        break
      }
    }
    if (!userText) return
    // 同步清理 history 里该轮的旧回复（原版 L1312-1317）；回退发生在客户端 history
    // 修剪 + 服务端按传入 history 重建上下文（agent:chat IPC 现有 history 机制）
    history.value = regenerateHistoryTrim(history.value, userText)
    await sendText(userText, { regenBubbleId: id })
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void handleSend()
    }
  }

  function openSettings() {
    router.push('/settings')
  }

  return {
    messages,
    inputText,
    sending,
    mode,
    planMode,
    confirmPlanExec,
    selectedModel,
    selectedAgentId,
    sessionId,
    attachments,
    ctxProduct,
    ctxScripts,
    resetToWelcome,
    loadSession,
    handleSend,
    handleKeydown,
    openSettings,
    initModel,
    setMode,
    setSelectedAgent,
    addAttachments,
    addScreenshots,
    removeAttachment,
    addCtxProduct,
    removeCtxProduct,
    addCtxScript,
    removeCtxScript,
    addCtxMaterial,
    addCtxAudio,
    downloadVideoAsset,
    quoteMessage,
    handleRegenerate
  }
}
