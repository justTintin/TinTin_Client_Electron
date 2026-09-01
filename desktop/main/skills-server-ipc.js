// ═══════════════════════════════════════════════════════════════
// skills-server-ipc.js — 服务端代理·技能登记域 IPC（2026-08-31 用户反馈：
// 原客户端有把安装的 skill 上传为服务端共用，Electron 端未随移植带入）
// 对照 openapi-latest.json 实际契约（POST /skills 请求体 additionalProperties
// 自由；GET /skills；DELETE /skills/{skill_id}）与原客户端 utils/skill_manager.py：
//   · skills:serverRegister    POST   /skills（原 register_skill L81-125：
//                              body={skill_id,name,description,instruction,
//                              machine_id,version}，失败仅告警不阻塞本地）
//   · skills:serverUnregister  DELETE /skills/{skill_id}?machine_id=
//                              （原 unregister_skill L131-147）
//   · skills:serverList        GET    /skills（原 server_skills L153-186，
//                              响应兼容裸数组 / {skills} / {items}）
// 口径说明：原版 ensure_builtin_skills 对内置技能也会登记服务端；按用户明确
// 要求（内置技能不上传），本域仅服务用户已安装技能，内置技能不调用本域。
// machine_id 在主进程注入（渲染层不传），与 agent 域双通道口径一致。
// 依赖（httpRequest/API_ENDPOINTS/isExpectedOfflineError/getMachineId）由
// server-proxy.js 注入，不重复实现。
// ═══════════════════════════════════════════════════════════════
const { buildSkillRegisterBody } = require('./skills-logic')

function createSkillsServerIpc(ipcMain, { httpRequest, API_ENDPOINTS, isExpectedOfflineError, getMachineId }) {
  // --- 登记/更新（覆盖式幂等；对照原版 install_skill → register_skill 链路）──
  ipcMain.handle('skills:serverRegister', async (_e, entry) => {
    try {
      const built = buildSkillRegisterBody(entry, getMachineId())
      if (!built.ok) throw new Error(`skills:serverRegister ${built.error}`)
      await httpRequest('POST', API_ENDPOINTS.skills.list, { body: built.body, timeout: 15000 })
      return { ok: true }
    } catch (err) { return isExpectedOfflineError(err) ? { ok: false, offline: true } : { ok: false, error: err.message } }
  })

  // --- 注销（卸载技能后清理服务端共享；对照原版 unregister_skill）──
  ipcMain.handle('skills:serverUnregister', async (_e, params) => {
    try {
      const skillId = String(params?.skillId || '').trim()
      if (!skillId) throw new Error('skills:serverUnregister requires skillId')
      const path = `${API_ENDPOINTS.skills.item(skillId)}?machine_id=${encodeURIComponent(getMachineId())}`
      await httpRequest('DELETE', path, { timeout: 15000 })
      return { ok: true }
    } catch (err) { return isExpectedOfflineError(err) ? { ok: false, offline: true } : { ok: false, error: err.message } }
  })

  // --- 服务端共享技能列表（对照原版 server_skills；离线返回 offline 标记；
  //     响应归一化为 {id,name,...}[]，渲染层以此回查「已上传」标识，2026-09-01）──
  ipcMain.handle('skills:serverList', async () => {
    try {
      const res = await httpRequest('GET', API_ENDPOINTS.skills.list, { timeout: 10000 })
      return { ok: true, items: normalizeServerSkills(res.data) }
    } catch (err) { return isExpectedOfflineError(err) ? { ok: false, offline: true } : { ok: false, error: err.message } }
  })
}

module.exports = { createSkillsServerIpc }
