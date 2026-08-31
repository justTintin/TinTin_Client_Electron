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
  type QuickEntry,
  type WorkbenchAgent
} from './workbenchChatContext'
import { skillQuickEntries, type SkillEntry } from './skillsLogic'
import type { ChatMode } from './workbenchChatLogic'

/** 列表加载状态：loading=加载中 / ok=成功 / error=失败（回退仅「对话」） */
export type AgentsLoadState = 'loading' | 'ok' | 'error'

export function useWorkbenchAgents() {
  /** 快捷条条目（首项固定「对话」，失败回退时仅剩该项） */
  const entries = ref<QuickEntry[]>([...buildQuickEntries([]), ...skillQuickEntries([])])
  const loadState = ref<AgentsLoadState>('loading')
  /** 加载失败提示（spec：智能体列表失败回退仅显示「对话」项并提示） */
  const errorMessage = ref('')

  /** 当前选中条目 key（llm 直连=CHAT_ENTRY_KEY，智能体=agent_id，技能=skill:<id>） */
  const selectedKey = ref<string>(CHAT_ENTRY_KEY)

  /** 最近一次解析成功的智能体列表（setSkills 重建 entries 时复用） */
  const lastAgents = ref<WorkbenchAgent[]>([])
  /** 本地技能条目（useSkills 装载后经 setSkills 注入，与智能体合并展示） */
  const skillItems = ref<SkillEntry[]>([])

  /** 重建快捷条：「对话」首项 + 服务端智能体 + 本地技能（原版 L1519 合并顺序） */
  function rebuild(agents: WorkbenchAgent[]) {
    entries.value = [...buildQuickEntries(agents), ...skillQuickEntries(skillItems.value)]
    // 列表刷新后若原选中项已不存在 → 回落「对话」
    if (!entries.value.some((e) => e.key === selectedKey.value)) {
      selectedKey.value = CHAT_ENTRY_KEY
    }
  }

  /** 注入本地技能列表（useSkills 装载/安装/卸载后调用；快捷条与斜杠候选同步刷新） */
  function setSkills(skills: SkillEntry[]) {
    skillItems.value = Array.isArray(skills) ? skills : []
    rebuild(lastAgents.value)
  }

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
      lastAgents.value = []
      rebuild(lastAgents.value)
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
      lastAgents.value = parseAgentsResponse(r)
      rebuild(lastAgents.value)
    } catch (e) {
      loadState.value = 'error'
      errorMessage.value = `智能体列表加载失败：${String((e as Error)?.message || e)}（快捷条仅保留「对话」入口）`
      lastAgents.value = []
      rebuild(lastAgents.value)
    }
  }

  /**
   * 选中快捷条条目：同一项重复点击为 no-op；否则更新选中态并返回
   * 目标模式与条目（技能条目 kind='skill'，容器注入唤醒前缀；同样走
   * agent 模式会话链路，原版选中技能即切到 agent 模式）。
   */
  function selectEntry(key: string): { changed: boolean; mode?: ChatMode; entry?: QuickEntry } {
    if (!key || key === selectedKey.value) return { changed: false }
    const entry = entries.value.find((e) => e.key === key)
    if (!entry) return { changed: false }
    selectedKey.value = key
    return { changed: true, mode: entry.kind === 'llm' ? 'llm' : 'agent', entry }
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
    setSkills,
    selectEntry,
    syncSelectionWithMode
  }
}
