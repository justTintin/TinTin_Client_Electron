// ═══════════════════════════════════════════════════════════════
// useSkills — 工作台技能数据域（2026-08-31 技能入口移植）
// 业务口径对照原客户端 gui/skill_manager_dialog.py + utils/skill_manager.py：
//   · 列表 = 内置技能（随包 resources/skills，只读不可卸载）+ 已安装技能
//     （userData/skills，env 层 skills:list，扫描自愈）
//   · 安装来源 = .md 文件 / 含 SKILL.md 的目录 / ZIP 包（skills:install）
//   · 卸载 = 仅删除客户端本地（内置拒绝；skills:remove），不影响服务端共享
//   · 服务端共享（2026-08-31 用户反馈：原客户端可把安装的 skill 上传为服务端
//     共用，Electron 端未随移植带入）：安装成功后自动登记（原版 install +
//     register_skill 链路，失败仅提示不阻塞本地）；管理弹窗支持手动重传。
//     卸载只删客户端本地，不注销服务端（供其他客户端继续使用）。
//     内置技能按用户要求不上传（与原版 ensure_builtin_skills 略有差异，以用户口径为准）。
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
  /** 已上传服务端的技能 id 集合（2026-09-01 用户反馈：已上传仍显示「上传」无标识）：
   *  打开列表时从服务端 GET /skills 回查（离线静默），上传/注销/安装链路同步维护 */
  const uploadedIds = ref<Set<string>>(new Set())
  function isUploaded(id: string): boolean {
    return uploadedIds.value.has(String(id || ''))
  }

  /** 服务端共享技能全量条目（2026-09-01 技能下载：面板「服务端技能」区块数据源；
   *  含 instruction/tags，供下载安装落盘） */
  const serverSkills = ref<SkillEntry[]>([])
  /** 服务端技能列表拉取失败提示（离线静默不提示，与 syncUploadedFromServer 口径一致） */
  const serverError = ref('')

  /** 拉取服务端技能全量条目（GET /skills；离线/失败静默保留旧数据） */
  async function loadServerSkills() {
    const t = getTintin()
    if (!t?.skills?.serverList) return
    try {
      const r = await t.skills.serverList()
      if (r && typeof r === 'object' && r.ok && Array.isArray(r.items)) {
        serverSkills.value = r.items as SkillEntry[]
        uploadedIds.value = new Set((r.items as Array<{ id?: unknown }>).map((s) => String(s?.id || '')).filter(Boolean))
        serverError.value = ''
      }
    } catch (_) { /* 离线静默：保留旧数据 */ }
  }

  /** 从服务端下载技能并安装到本地（面板「下载」；成功后刷新本地列表） */
  async function installFromServer(id: string): Promise<{ ok: boolean; error?: string }> {
    const t = getTintin()
    if (!t?.skills?.serverInstall) return { ok: false, error: '技能下载通道不可用（客户端需更新）' }
    const name = serverSkills.value.find((s) => s.id === id)?.name || id
    actionMsg.value = `正在从服务端下载「${name}」…`
    try {
      const r = await t.skills.serverInstall(id)
      if (r && typeof r === 'object' && r.ok) {
        actionMsg.value = `「${name}」已从服务端下载安装`
        await load() // 刷新本地列表（新技能进入「已安装」区，可斜杠唤起）
        return { ok: true }
      }
      const msg = r?.offline
        ? '服务端暂不可达，下载失败；请检查服务连接后重试'
        : String(r?.error || '下载安装失败')
      actionMsg.value = `下载失败：${msg}`
      return { ok: false, error: msg }
    } catch (e) {
      const msg = String((e as Error)?.message || e)
      actionMsg.value = `下载失败：${msg}`
      return { ok: false, error: msg }
    }
  }

  /** 从服务端回查已登记技能 id（GET /skills，归一化条目 {id}；离线/失败静默保留旧状态） */
  async function syncUploadedFromServer() {
    const t = getTintin()
    if (!t?.skills?.serverList) return
    try {
      const r = await t.skills.serverList()
      if (r && typeof r === 'object' && r.ok && Array.isArray(r.items)) {
        uploadedIds.value = new Set(r.items.map((s: { id?: unknown }) => String(s?.id || '')).filter(Boolean))
      }
    } catch (_) { /* 离线静默：保留本地维护的上传状态 */ }
  }

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
        void syncUploadedFromServer() // 回查已上传标识（离线静默）
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
        const name = String(r.entry?.name || r.entry?.id || '')
        // 安装后自动登记服务端（原版 install_skill → register_skill 链路；
        // 失败仅提示，不阻塞本地安装）
        const reg = await registerToServer(r.entry)
        if (reg.ok && r.entry?.id) uploadedIds.value.add(String(r.entry.id)) // 上传标识同步
        actionMsg.value = reg.ok
          ? `技能「${name}」安装成功，已同步服务端共享`
          : reg.offline
            ? `技能「${name}」安装成功（本地）；服务端暂不可达，可稍后在技能广场中重试上传`
            : `技能「${name}」安装成功（本地）；服务端登记失败：${reg.error || '未知错误'}`
        await load()
        return { ok: true, name }
      }
      actionMsg.value = String(r?.error || '安装失败')
      return { ok: false, error: String(r?.error || '安装失败') }
    } catch (e) {
      const msg = String((e as Error)?.message || e)
      actionMsg.value = `安装失败：${msg}`
      return { ok: false, error: msg }
    }
  }

  /** 卸载用户技能（内置技能由主进程拒绝）；仅删除客户端本地，不影响服务端共享 */
  async function remove(id: string): Promise<{ ok: boolean; error?: string }> {
    const t = getTintin()
    if (!t?.skills?.remove) return { ok: false, error: '技能通道不可用' }
    try {
      const r = await t.skills.remove(id)
      if (r && typeof r === 'object' && r.ok) {
        actionMsg.value = '技能已从客户端卸载'
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

  /** 服务端登记（原版 register_skill：POST /skills，machine_id 主进程注入；失败仅返回不抛出） */
  async function registerToServer(entry: SkillEntry): Promise<{ ok: boolean; offline?: boolean; error?: string }> {
    const t = getTintin()
    if (!t?.skills?.serverRegister) return { ok: false, error: '技能服务端登记通道不可用' }
    try {
      const r = await t.skills.serverRegister({
        id: String(entry?.id || ''),
        name: String(entry?.name || entry?.id || ''),
        description: String(entry?.description || ''),
        instruction: String(entry?.instruction || ''),
        version: String(entry?.version || '1.0.0')
      })
      if (r && typeof r === 'object') {
        return r.ok
          ? { ok: true }
          : { ok: false, offline: !!r.offline, error: r.error ? String(r.error) : '服务端登记失败' }
      }
      return { ok: false, error: '服务端登记结果异常' }
    } catch (e) {
      return { ok: false, error: String((e as Error)?.message || e) }
    }
  }

  /** 服务端注销（原版 unregister_skill：DELETE /skills/{skill_id}） */
  async function unregisterFromServer(id: string): Promise<{ ok: boolean; error?: string }> {
    const t = getTintin()
    if (!t?.skills?.serverUnregister) return { ok: false, error: '技能服务端注销通道不可用' }
    try {
      const r = await t.skills.serverUnregister(id)
      return r && typeof r === 'object' && r.ok
        ? { ok: true }
        : { ok: false, error: r?.error ? String(r.error) : '服务端注销失败' }
    } catch (e) {
      return { ok: false, error: String((e as Error)?.message || e) }
    }
  }

  /**
   * 手动上传已安装技能到服务端（管理弹窗「上传」按钮；原版 register_skill
   * 幂等覆盖口径）。内置技能无此入口（用户口径：内置技能不上传）。
   */
  async function upload(id: string): Promise<{ ok: boolean; error?: string }> {
    const entry = user.value.find((s) => s.id === id)
    if (!entry) return { ok: false, error: '技能不存在（可能已卸载）' }
    actionMsg.value = `正在上传「${entry.name || entry.id}」到服务端…`
    const r = await registerToServer(entry)
    if (r.ok) {
      uploadedIds.value.add(String(entry.id || id)) // 上传标识同步（弹窗按钮回显）
      actionMsg.value = `「${entry.name || entry.id}」已上传服务端，其他客户端可共享使用`
      return { ok: true }
    }
    actionMsg.value = r.offline
      ? `服务端暂不可达，「${entry.name || entry.id}」未上传；请检查服务连接后重试`
      : `上传失败：${r.error || '未知错误'}`
    return { ok: false, error: r.error }
  }

  return { builtin, user, loading, error, actionMsg, uploadedIds, isUploaded, serverSkills, serverError, load, loadServerSkills, install, installFromServer, remove, upload }
}
