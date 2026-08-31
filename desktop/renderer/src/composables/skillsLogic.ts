// ═══════════════════════════════════════════════════════════════
// skillsLogic.ts — 工作台技能·渲染层纯函数逻辑层（无 vue 依赖，可单测）
// 对齐原客户端 gui/agent_home_page.py（2026-08-31 用户反馈：工作台技能入口
// 未随移植带入）：
//   · skillToCandidate / mergeSkillCandidates
//                          = 原 _on_agents_loaded L1511-1521（技能与智能体
//                            同构合并进快捷条与斜杠菜单，技能在后）
//   · buildSkillWakeText  = 原 L1537-1540（请按技能【name】执行：instruction）
//   · applySkillWakeInsert= 原 _SlashPopup._insert_agent L338-361（斜杠段
//                           替换为唤醒词，语义与 applyAgentWakeInsert 一致）
//   · stripWakePrefixLine = 原 L1544-1548（换选时剥离旧唤醒前缀首行）
//   · applyWakePrefix     = 原 _on_agent_selected L1549（前缀 + 原文）
// 数据源：window.tintin.skills.list（main/skill-store.js，内置+已安装）。
// 单测：desktop/tests/workbench-skills-logic.test.mjs
// ═══════════════════════════════════════════════════════════════

import type { QuickEntry, WorkbenchAgent } from './workbenchChatContext.ts'

/** 主进程 skills:list 返回的技能条目（main/skill-store.js parseSkillMd 口径） */
export interface SkillEntry {
  id: string
  name: string
  description: string
  /** 正文全文（选中技能时注入对话输入的前缀指令） */
  instruction: string
  version?: string
  author?: string
  tags?: string[]
  builtin?: boolean
  path?: string
}

/** 斜杠候选中的技能形态（source='skill' 区分于服务端智能体） */
export interface SkillCandidate extends WorkbenchAgent {
  source: 'skill'
  instruction: string
}

/** 技能条目 → 斜杠候选（与智能体同构；desc=description，原版 skill_entries 口径） */
export function skillToCandidate(s: SkillEntry): SkillCandidate {
  return {
    id: String(s?.id || ''),
    name: String(s?.name || s?.id || ''),
    desc: String(s?.description || ''),
    source: 'skill',
    instruction: String(s?.instruction || '')
  }
}

/**
 * 技能条目 → 快捷条（kind:'skill'，key 加 skill: 前缀避免与服务端智能体
 * agent_id 撞车；原版技能直接拼在智能体列表尾部 L1519）。
 */
export function skillQuickEntry(s: SkillEntry): QuickEntry {
  return {
    key: `skill:${String(s?.id || '')}`,
    kind: 'skill',
    name: String(s?.name || s?.id || ''),
    desc: String(s?.description || '')
  }
}

/** 技能条目列表 → 快捷条尾部条目（空安全；id 缺失跳过） */
export function skillQuickEntries(skills: SkillEntry[]): QuickEntry[] {
  return (Array.isArray(skills) ? skills : [])
    .filter((s) => s && String(s.id || '').trim())
    .map(skillQuickEntry)
}

/**
 * 斜杠候选合并：服务端智能体在前、技能在后（原版 L1519 顺序）。
 * 智能体 id 与技能 id 同名时两者都保留（斜杠候选无 key 冲突问题）。
 */
export function mergeSkillCandidates(agents: WorkbenchAgent[], skills: SkillEntry[]): (WorkbenchAgent | SkillCandidate)[] {
  return [...(Array.isArray(agents) ? agents : []), ...(Array.isArray(skills) ? skills : []).map(skillToCandidate)]
}

/** 技能唤醒词（原版 L1537-1540：请按技能【name】执行：instruction） */
export function buildSkillWakeText(s: { name?: string; instruction?: string }): string {
  const name = String(s?.name || '').trim() || '该技能'
  const instruction = String(s?.instruction || '').trim()
  return instruction ? `请按技能【${name}】执行：${instruction}` : `请按技能【${name}】执行`
}

/**
 * 斜杠选中技能：把光标前 /关键字 段替换为技能唤醒词（原版 _SlashPopup
 * _insert_agent 同语义：仅当最后一段斜杠后无空格才算唤醒段）。
 */
export function applySkillWakeInsert(
  text: string,
  caret: number,
  skill: { name?: string; instruction?: string }
): { text: string; caret: number } {
  const s = String(text || '')
  const pos = Math.max(0, Math.min(caret, s.length))
  const seg = s.slice(0, pos)
  const i = seg.lastIndexOf('/')
  const wake = buildSkillWakeText(skill)
  if (i >= 0 && seg.slice(i + 1).split(' ').length === 1 && !seg.slice(i + 1).includes('\n')) {
    const next = s.slice(0, i) + wake + s.slice(pos)
    return { text: next, caret: i + wake.length }
  }
  const next = s.slice(0, pos) + wake + s.slice(pos)
  return { text: next, caret: pos + wake.length }
}

/**
 * 剥离旧唤醒前缀首行（原版 L1544-1548）：首行以「请【…】智能体执行：」或
 * 「请按技能【…】执行：」开头时去掉首行，返回剩余正文（无前缀原样返回）。
 */
export function stripWakePrefixLine(text: string): string {
  const s = String(text || '')
  const firstLine = s.split('\n', 1)[0]
  const isAgentWake = firstLine.startsWith('请【') && firstLine.includes('智能体执行：')
  const isSkillWake = firstLine.startsWith('请按技能【') && firstLine.includes('执行：')
  if (!isAgentWake && !isSkillWake) return s
  return s.includes('\n') ? s.split('\n').slice(1).join('\n').replace(/^\n+/, '') : ''
}

/** 快捷条选中技能：剥离旧前缀后以新唤醒词开头（原版 L1549 前缀 + 原文） */
export function applyWakePrefix(text: string, prefix: string): string {
  const rest = stripWakePrefixLine(text)
  return rest ? `${prefix}\n\n${rest}` : prefix
}
