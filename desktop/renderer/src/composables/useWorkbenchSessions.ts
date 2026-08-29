import { ref } from 'vue'
import { getTintin, readCfg, writeCfg } from './useSettingsConfig'
import {
  sanitizeSessions,
  sessionGroupOf,
  applySessionDelete,
  applySessionRename,
  pickSessionServerId,
  type StoredSession,
  type HistoryMessage,
  type ChatMode
} from './workbenchChatLogic'

/* ── 会话列表数据 ──────────────────────────────────────────── */
/** 展示层会话条目 = 持久化条目 + 分组键（由 updatedAt 计算，今天/昨天/更早） */
export interface Session extends StoredSession {
  group: 'today' | 'yesterday' | 'earlier'
}

/** 分组渲染顺序（今天 / 昨天 / 更早） */
export const SESSION_GROUPS = ['today', 'yesterday', 'earlier'] as const

/** 侧栏分组数据结构（容器按 SESSION_GROUPS 组装后传给展示组件） */
export interface SessionGroup {
  key: Session['group']
  label: string
  items: Session[]
}

/** electron-store 持久化键（会话列表单一真相源） */
const STORE_KEY = 'workbench.sessions'

/** 标题/副标题截断宽度（首条用户消息 → 会话标题） */
const TITLE_MAX = 18
const SUBTITLE_MAX = 30

function truncate(text: string, max: number): string {
  const line = String(text || '').replace(/\s+/g, ' ').trim()
  return line.length > max ? line.slice(0, max) + '…' : line
}

/**
 * 工作台会话域（P1）：本地持久化的多会话，每个会话绑定独立服务端 session_id
 *（服务端会话续接 + 素材池归属），启动恢复、新建、切换、内容回写。
 *
 * 口径对照（对齐清单 W2/W7）：
 * - 服务端会话端点已核对存在（GET/DELETE /agent/sessions*，openapi-latest.json），
 *   故按「服务端会话续接」接线；服务端无会话消息历史读取端点，消息正文按
 *   原版 _save_chat 口径本地持久化（electron-store），数据结构可切换。
 * - 删除服务端会话经 server.agentSessionDelete（素材池一并清理，对照原版
 *   _reset_session L1640-1648）；当前 UI 无删除入口（W7 待裁决），IPC 链路先行。
 * - 假数据已全部移除：无持久化数据时会话列表为空（空态由侧栏自动呈现）。
 */
export function useWorkbenchSessions(hooks?: {
  onConversationCreate?: () => void
  onSessionFocus?: () => void
}) {
  const sessions = ref<Session[]>([])
  const activeSessionId = ref<string>('')
  /** 小屏适配：会话侧栏折叠开关 */
  const sidebarOpen = ref(false)
  /** 持久化恢复是否完成（避免启动竞态） */
  let restored = false

  /** 启动恢复（原版 _restore_chat：本地消息 + 服务端 session_id 续接） */
  async function init() {
    if (restored) return
    restored = true
    const raw = await readCfg(STORE_KEY, '')
    const list = sanitizeSessions(typeof raw === 'string' ? safeParse(raw) : raw)
    sessions.value = list
      .map(toSession)
      .sort((a, b) => b.updatedAt - a.updatedAt)
    if (sessions.value.length) {
      activeSessionId.value = sessions.value[0].id
    }
  }

  /** electron-store 历史可能存过 JSON 字符串形态，兼容解析 */
  function safeParse(text: string): unknown {
    if (!text) return []
    try { return JSON.parse(text) } catch (_e) { return [] }
  }

  function toSession(s: StoredSession): Session {
    return { ...s, group: sessionGroupOf(s.updatedAt) }
  }

  async function persist() {
    await writeCfg(STORE_KEY, sessions.value.map(({ group: _group, ...rest }) => rest))
  }

  function selectSession(id: string) {
    activeSessionId.value = id
  }

  /** 新建会话（容器传入当前模式；原版模式切换即新会话，模式随会话固化） */
  function createSession(mode: ChatMode = 'agent') {
    const now = Date.now()
    const session: Session = {
      id: 's' + now,
      title: '新会话',
      subtitle: '开始输入…',
      updatedAt: now,
      serverSessionId: '',
      mode,
      messages: [],
      group: 'today'
    }
    sessions.value.unshift(session)
    activeSessionId.value = session.id
    void persist()
    // 原 createSession 内的消息重置 / 输入框聚焦，经容器桥接到消息域与输入区组件
    hooks?.onConversationCreate?.()
    hooks?.onSessionFocus?.()
  }

  /** 删除本地会话并同步清理服务端会话（素材池一并清理；对照原版 _reset_session）。
   *  本地删除先行且必然生效；服务端删除失败仅提示不阻塞（离线/失败时服务端孤儿
   *  会话由机器码隔离，不影响本机其余会话）。返回 { ok, error? } 供 UI 提示。 */
  async function deleteSession(id: string): Promise<{ ok: boolean; error?: string }> {
    const { list, removedServerSessionId, nextActiveId } = applySessionDelete(
      sessions.value,
      id,
      activeSessionId.value
    )
    sessions.value = list.map(toSession)
    activeSessionId.value = nextActiveId
    await persist()
    if (!removedServerSessionId) return { ok: true }
    const t = getTintin()
    const r = t?.server?.agentSessionDelete
      ? await t.server.agentSessionDelete({ id: removedServerSessionId }).catch(() => null)
      : null
    if (!r || ('error' in r && r.error)) {
      return { ok: true, error: '会话已从本地删除；服务端会话清理失败，可稍后重试。' }
    }
    return { ok: true }
  }

  /** 重命名会话（行内编辑确认后持久化；标题规范化 + 刷新更新时间） */
  function renameSession(id: string, title: string): boolean {
    if (!sessions.value.some((s) => s.id === id)) return false
    sessions.value = applySessionRename(sessions.value, id, title).map(toSession)
    void persist()
    return true
  }

  /**
   * 消息域回写当前会话（标题用首条用户消息、副标题用最后一条，updatedAt 刷新，
   * 原子持久化——electron-store 单一真相源）。
   */
  function updateActive(patch: {
    serverSessionId?: string
    history?: HistoryMessage[]
    subtitle?: string
  }) {
    const active = sessions.value.find((s) => s.id === activeSessionId.value)
    if (!active) return
    if (patch.serverSessionId !== undefined) active.serverSessionId = patch.serverSessionId
    if (patch.history) {
      active.messages = patch.history.map((m) => ({ role: m.role, content: m.content }))
      const firstUser = active.messages.find((m) => m.role === 'user')
      if (firstUser) active.title = truncate(firstUser.content, TITLE_MAX)
      const last = active.messages[active.messages.length - 1]
      active.subtitle = patch.subtitle !== undefined
        ? truncate(patch.subtitle, SUBTITLE_MAX)
        : (last ? truncate(last.content, SUBTITLE_MAX) : '开始输入…')
    } else if (patch.subtitle !== undefined) {
      active.subtitle = truncate(patch.subtitle, SUBTITLE_MAX)
    }
    active.updatedAt = Date.now()
    active.group = sessionGroupOf(active.updatedAt)
    void persist()
  }

  /** 当前会话（容器桥接消息域用；未选中返回 null） */
  function getActive(): Session | null {
    return sessions.value.find((s) => s.id === activeSessionId.value) || null
  }

  function toggleSidebarPanel() {
    sidebarOpen.value = !sidebarOpen.value
  }

  /* ── 会话分组 ──────────────────────────────────────────────── */
  function sessionsByGroup(group: Session['group']) {
    return sessions.value.filter((s) => s.group === group)
  }

  const groupLabels: Record<Session['group'], string> = {
    today: '今天',
    yesterday: '昨天',
    earlier: '更早'
  }

  return {
    sessions,
    activeSessionId,
    sidebarOpen,
    init,
    selectSession,
    createSession,
    deleteSession,
    renameSession,
    getActive,
    updateActive,
    toggleSidebarPanel,
    sessionsByGroup,
    groupLabels
  }
}
