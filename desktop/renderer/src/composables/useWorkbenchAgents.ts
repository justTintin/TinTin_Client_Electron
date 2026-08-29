// ═══════════════════════════════════════════════════════════════
// useWorkbenchAgents — 工作台输入区·智能体快捷条数据域
// 业务口径对照原客户端 gui/agent_home_page.py：
//   · _AgentLoader L707-725（GET /agent/agents，exposed=False 过滤，
//     失败回退空列表）→ 快捷条/斜杠菜单数据源
//   · 首项固定「对话」= 基础 llm 直连模式（本客户端定稿：模式分段/
//     模型下拉移除，模型只读 llm.defaultModel 偏好）
//   · 选中即切换对话模式，切智能体=新会话（容器编排，原版
//     _on_mode_changed「模式切换视为新会话」语义，L1459-1466）
// HTTP 全部经主进程 agent:agents IPC（离线 null / 5xx {error}），本层只做
// 解析（parseAgentsResponse 纯函数）与状态编排，不含 URL 拼装（IRON-06）。
// ═══════════════════════════════════════════════════════════════

import { computed, ref } from 'vue'
import { getTintin } from './useSettingsConfig'
import {
  buildQuickEntries,
  parseAgentsResponse,
  CHAT_ENTRY_KEY,
  type QuickEntry
} from './workbenchChatContext'
import type { ChatMode } from './workbenchChatLogic'

/** 列表加载状态：loading=加载中 / ok=成功 / error=失败（回退仅「对话」） */
export type AgentsLoadState = 'loading' | 'ok' | 'error'

export function useWorkbenchAgents() {
  /** 快捷条条目（首项固定「对话」，失败回退时仅剩该项） */
  const entries = ref<QuickEntry[]>([...buildQuickEntries([])])
  const loadState = ref<AgentsLoadState>('loading')
  /** 加载失败提示（spec：智能体列表失败回退仅显示「对话」项并提示） */
  const errorMessage = ref('')

  /** 当前选中条目 key（llm 直连=CHAT_ENTRY_KEY，智能体=agent_id） */
  const selectedKey = ref<string>(CHAT_ENTRY_KEY)

  const selectedEntry = computed(
    () => entries.value.find((e) => e.key === selectedKey.value) || entries.value[0]
  )

  /** 拉取智能体列表（GET /agent/agents → agent:agents IPC） */
  async function loadAgents() {
    loadState.value = 'loading'
    errorMessage.value = ''
    const t = getTintin()
    if (!t?.server?.agentAgents) {
      loadState.value = 'error'
      errorMessage.value = '网络异常：无法连接服务端，请检查「设置 → 服务端」的地址与网络后重试。'
      entries.value = [...buildQuickEntries([])]
      return
    }
    try {
      const r = await t.server.agentAgents()
      if (r && typeof r === 'object' && 'error' in r && r.error) {
        loadState.value = 'error'
        errorMessage.value = `智能体列表加载失败：${r.error}（快捷条仅保留「对话」入口）`
      } else {
        loadState.value = 'ok'
        errorMessage.value = ''
      }
      // 离线（null）/空列表 → parseAgentsResponse 返回 []，快捷条回退仅「对话」
      entries.value = [...buildQuickEntries(parseAgentsResponse(r))]
      // 列表刷新后若原选中项已不存在 → 回落「对话」
      if (!entries.value.some((e) => e.key === selectedKey.value)) {
        selectedKey.value = CHAT_ENTRY_KEY
      }
    } catch (e) {
      loadState.value = 'error'
      errorMessage.value = `智能体列表加载失败：${String((e as Error)?.message || e)}（快捷条仅保留「对话」入口）`
      entries.value = [...buildQuickEntries([])]
    }
  }

  /**
   * 选中快捷条条目：同一项重复点击为 no-op；否则更新选中态并返回
   * 目标模式（由容器执行「切换=新会话」编排）。'llm'/'agent'。
   */
  function selectEntry(key: string): { changed: boolean; mode?: ChatMode } {
    if (!key || key === selectedKey.value) return { changed: false }
    const entry = entries.value.find((e) => e.key === key)
    if (!entry) return { changed: false }
    selectedKey.value = key
    return { changed: true, mode: entry.kind === 'llm' ? 'llm' : 'agent' }
  }

  /** 会话装载时同步选中态（持久化只存 mode，llm 会话对齐「对话」项） */
  function syncSelectionWithMode(mode: ChatMode) {
    if (mode === 'llm') {
      selectedKey.value = CHAT_ENTRY_KEY
    } else if (!entries.value.some((e) => e.key === selectedKey.value && e.kind === 'agent')) {
      // agent 会话未记录智能体身份（原版 /agent/chat 不传 agent_id），保留当前选中
      if (selectedKey.value === CHAT_ENTRY_KEY && entries.value.length > 1) {
        selectedKey.value = entries.value[1].key
      }
    }
  }

  return {
    entries,
    loadState,
    errorMessage,
    selectedKey,
    selectedEntry,
    loadAgents,
    selectEntry,
    syncSelectionWithMode
  }
}
