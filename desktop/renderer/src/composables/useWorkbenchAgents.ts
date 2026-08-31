// ═══════════════════════════════════════════════════════════════
// useWorkbenchAgents — 工作台输入区·智能体快捷条数据域
// 业务口径对照原客户端 gui/agent_home_page.py：
//   · _AgentLoader L707-725（GET /agent/agents，exposed=False 过滤，
//     失败回退空列表）→ 快捷条/斜杠菜单数据源
//   · 快捷条仅服务端智能体 + 本地技能（2026-08-31 用户裁决：移除首项
//     「对话」llm 直连入口，实际不用；存量 llm 会话仅保留可读）
//   · 快捷条为纯列表（2026-08-31 用户裁决：不持有选中态；智能体调用统一
//     走输入框 / 唤起或点击条目插唤醒词，业务在容器 onSelectEntry）
// HTTP 全部经主进程 agent:agents IPC（离线 null / 5xx {error}），本层只做
// 解析（parseAgentsResponse 纯函数）与状态编排，不含 URL 拼装（IRON-06）。
// ═══════════════════════════════════════════════════════════════

import { ref } from 'vue'
import { getTintin } from './useSettingsConfig'
import {
  buildQuickEntries,
  parseAgentsResponse,
  type QuickEntry,
  type WorkbenchAgent
} from './workbenchChatContext'
import { skillQuickEntries, type SkillEntry } from './skillsLogic'

/** 列表加载状态：loading=加载中 / ok=成功 / error=失败（快捷条暂不可用） */
export type AgentsLoadState = 'loading' | 'ok' | 'error'

export function useWorkbenchAgents() {
  /** 快捷条条目（服务端智能体 + 本地技能；失败回退时空） */
  const entries = ref<QuickEntry[]>([])
  const loadState = ref<AgentsLoadState>('loading')
  /** 加载失败提示（spec：智能体列表失败回退空条目并提示） */
  const errorMessage = ref('')

  /** 最近一次解析成功的智能体列表（setSkills 重建 entries 时复用） */
  const lastAgents = ref<WorkbenchAgent[]>([])
  /** 本地技能条目（useSkills 装载后经 setSkills 注入，与智能体合并展示） */
  const skillItems = ref<SkillEntry[]>([])

  /** 重建快捷条：服务端智能体 + 本地技能（原版 L1519 合并顺序；
   *  2026-08-31 移除「对话」首项） */
  function rebuild(agents: WorkbenchAgent[]) {
    entries.value = [...buildQuickEntries(agents), ...skillQuickEntries(skillItems.value)]
  }

  /** 注入本地技能列表（useSkills 装载/安装/卸载后调用；快捷条与斜杠候选同步刷新） */
  function setSkills(skills: SkillEntry[]) {
    skillItems.value = Array.isArray(skills) ? skills : []
    rebuild(lastAgents.value)
  }

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
        errorMessage.value = `智能体列表加载失败：${r.error}（快捷条暂不可用）`
      } else {
        loadState.value = 'ok'
        errorMessage.value = ''
      }
      // 离线（null）/空列表 → parseAgentsResponse 返回 []，快捷条回退空
      lastAgents.value = parseAgentsResponse(r)
      rebuild(lastAgents.value)
    } catch (e) {
      loadState.value = 'error'
      errorMessage.value = `智能体列表加载失败：${String((e as Error)?.message || e)}（快捷条暂不可用）`
      lastAgents.value = []
      rebuild(lastAgents.value)
    }
  }

  return {
    entries,
    loadState,
    errorMessage,
    loadAgents,
    setSkills
  }
}
