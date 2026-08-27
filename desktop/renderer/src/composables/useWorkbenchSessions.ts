import { ref } from 'vue'

/* ── 会话列表数据 ──────────────────────────────────────────── */
export interface Session {
  id: string
  title: string
  subtitle: string
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

/**
 * 工作台会话域：会话列表 / 新建会话 / 分组展示 / 小屏侧栏折叠开关。
 * 纯前端示例数据（与原 Workbench.vue 逐字一致）。
 * 原createSession中「重置欢迎消息」「聚焦输入框」分别属于消息域与输入区 DOM，
 * 拆分后通过 hooks 由容器注入，调用时序与原实现保持一致。
 */
export function useWorkbenchSessions(hooks?: {
  onConversationCreate?: () => void
  onSessionFocus?: () => void
}) {
  const sessions = ref<Session[]>([
    { id: 's1', title: 'JBL CHARGE6 脚本创作', subtitle: '生成 3 个镜头，等待确认', group: 'today' },
    { id: 's2', title: '产品卖点提炼',       subtitle: '已输出 5 条卖点',           group: 'today' },
    { id: 's3', title: 'BOSE 音箱对比分析',   subtitle: '已完成',                   group: 'yesterday' },
    { id: 's4', title: '618 大促话术库',       subtitle: '已生成 12 条话术',         group: 'yesterday' },
    { id: 's5', title: '竞品拆解 · 索尼 SRS', subtitle: '已归档',                   group: 'earlier' }
  ])

  const activeSessionId = ref<string>('s1')

  /** 小屏适配：会话侧栏折叠开关 */
  const sidebarOpen = ref(false)

  function selectSession(id: string) {
    activeSessionId.value = id
    // 实际项目中这里会拉取该会话的历史消息
  }

  function createSession() {
    const newId = 's' + Date.now()
    sessions.value.unshift({
      id: newId,
      title: '新会话',
      subtitle: '开始输入…',
      group: 'today'
    })
    activeSessionId.value = newId
    // 原 createSession 内的消息重置 / 输入框聚焦，经容器桥接到消息域与输入区组件
    hooks?.onConversationCreate?.()
    hooks?.onSessionFocus?.()
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
    selectSession,
    createSession,
    toggleSidebarPanel,
    sessionsByGroup,
    groupLabels
  }
}
