// ═══════════════════════════════════════════════════════════════
// useSkills — 工作台技能数据域（2026-08-31 技能入口移植）
// 业务口径对照原客户端 gui/skill_manager_dialog.py + utils/skill_manager.py：
//   · 列表 = 内置技能（随包 resources/skills，只读不可卸载）+ 已安装技能
//     （userData/skills，env 层 skills:list，扫描自愈）
//   · 安装来源 = .md 文件 / 含 SKILL.md 的目录 / ZIP 包（skills:install）
//   · 卸载 = 仅用户技能（内置拒绝；skills:remove）
// 纯 IO 编排无业务规则；合并/前缀注入等口径在 skillsLogic.ts（可单测）。
// ═══════════════════════════════════════════════════════════════

import { ref } from 'vue'
import { getTintin } from './useSettingsConfig'
import type { SkillEntry } from './skillsLogic'

export function useSkills() {
  const builtin = ref<SkillEntry[]>([])
  const user = ref<SkillEntry[]>([])
  const loading = ref(false)
  /** 列表加载失败提示（安装/卸载结果走 actionMsg） */
  const error = ref('')
  /** 安装/卸载操作结果提示（管理弹窗展示） */
  const actionMsg = ref('')

  /** 拉取技能列表（内置 + 已安装；失败保留旧数据并置 error） */
  async function load() {
    const t = getTintin()
    if (!t?.skills?.list) {
      error.value = '技能通道不可用（preload 未暴露 skills）'
      return
    }
    loading.value = true
    try {
      const r = await t.skills.list()
      if (r && typeof r === 'object' && r.ok) {
        builtin.value = Array.isArray(r.builtin) ? r.builtin : []
        user.value = Array.isArray(r.user) ? r.user : []
        error.value = ''
      } else {
        error.value = String(r?.error || '技能列表加载失败')
      }
    } catch (e) {
      error.value = `技能列表加载失败：${String((e as Error)?.message || e)}`
    } finally {
      loading.value = false
    }
  }

  /** 安装技能（src=本地绝对路径：.md / 目录 / .zip）；成功后刷新列表 */
  async function install(src: string): Promise<{ ok: boolean; name?: string; error?: string }> {
    const t = getTintin()
    if (!t?.skills?.install) return { ok: false, error: '技能通道不可用' }
    try {
      const r = await t.skills.install(src)
      if (r && typeof r === 'object' && r.ok) {
        actionMsg.value = `技能「${r.entry?.name || r.entry?.id || ''}」安装成功`
        await load()
        return { ok: true, name: String(r.entry?.name || r.entry?.id || '') }
      }
      actionMsg.value = String(r?.error || '安装失败')
      return { ok: false, error: String(r?.error || '安装失败') }
    } catch (e) {
      const msg = String((e as Error)?.message || e)
      actionMsg.value = `安装失败：${msg}`
      return { ok: false, error: msg }
    }
  }

  /** 卸载用户技能（内置技能由主进程拒绝）；成功后刷新列表 */
  async function remove(id: string): Promise<{ ok: boolean; error?: string }> {
    const t = getTintin()
    if (!t?.skills?.remove) return { ok: false, error: '技能通道不可用' }
    try {
      const r = await t.skills.remove(id)
      if (r && typeof r === 'object' && r.ok) {
        actionMsg.value = '技能已卸载'
        await load()
        return { ok: true }
      }
      const err = String(r?.error || '卸载失败')
      actionMsg.value = err === 'NOT_FOUND' ? '技能不存在（可能已卸载）' : err
      return { ok: false, error: err }
    } catch (e) {
      const msg = String((e as Error)?.message || e)
      actionMsg.value = `卸载失败：${msg}`
      return { ok: false, error: msg }
    }
  }

  return { builtin, user, loading, error, actionMsg, load, install, remove }
}
