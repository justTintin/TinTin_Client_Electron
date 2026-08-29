// ═══════════════════════════════════════════════════════════════
// agent-chat-ipc.js — 服务端代理·智能体对话域 IPC（工作台 P1 真实链路）
// 对照 openapi-latest.json 实际契约（禁止臆造）与原客户端 utils/agent_client.py：
//   · agent:agents                 GET  /agent/agents（智能体列表，工作台快捷条/斜杠菜单数据源）
//   · agent:chat                   POST /agent/chat（JSON，max_rounds=3，stream:false）
//   · agent:sessions               GET  /agent/sessions?machine_id=&limit=
//   · agent:sessionDelete          DELETE /agent/sessions/{id}（素材池一并清理）
//   · agent:sessionAttachments     GET  /agent/sessions/{id}/attachments
//   · agent:sessionAttachmentAdd   POST /agent/sessions/{id}/attachments
//                                  （multipart：file=本地附件 | material_id=素材库引用）
//   · agent:sessionAttachmentRemove DELETE /agent/sessions/{id}/attachments/{key}
// 会话/素材池均按 machine_id 多租户隔离（httpRequest 已注入 X-Machine-ID 头，
// 服务端 /agent/* 契约另要求 body/query 显式携带 machine_id，双通道同值）。
// 依赖（httpRequest/multipartUpload/API_ENDPOINTS/isExpectedOfflineError/
// getMachineId）由 server-proxy.js 注入，不重复实现。
// ═══════════════════════════════════════════════════════════════
const fs = require('node:fs')

function createAgentChatIpc(ipcMain, { httpRequest, multipartUpload, API_ENDPOINTS, isExpectedOfflineError, getMachineId }) {
  // --- 对话（对照原版 _ChatWorker agent 分支：agent_chat(message, history, model, max_rounds=3, mode, session_id)）──
  ipcMain.handle('agent:chat', async (_e, payload) => {
    try {
      const p = payload || {}
      if (!p.message || !String(p.message).trim()) throw new Error('agent:chat requires message')
      const body = {
        message: String(p.message),
        max_rounds: 3,
        stream: false,
        machine_id: getMachineId()
      }
      if (Array.isArray(p.history) && p.history.length) body.history = p.history
      if (p.model) body.model = p.model
      // maxRounds 可选透传（原版 create_session 用轻量 max_rounds=1 建会话；默认 3）
      if (p.maxRounds) body.max_rounds = Number(p.maxRounds) || 3
      if (p.mode) body.mode = p.mode
      if (p.sessionId) body.session_id = p.sessionId
      const res = await httpRequest('POST', API_ENDPOINTS.agent.chat, { body, timeout: 180000 })
      return res.data
    } catch (err) { return isExpectedOfflineError(err) ? null : { error: err.message } }
  })

  // --- 智能体列表（GET /agent/agents，AGENT_PERSONAS 权威；对照原版 _AgentLoader/get_agents：
  //     响应兼容 {agents:[…]} 与裸数组，条目 {agent_id,name,version,exposed,desc}，
  //     exposed=False 过滤在渲染层 parseAgentsResponse 统一处理）──
  ipcMain.handle('agent:agents', async () => {
    try {
      const res = await httpRequest('GET', API_ENDPOINTS.agent.agents, { timeout: 10000 })
      return res.data
    } catch (err) { return isExpectedOfflineError(err) ? null : { error: err.message } }
  })

  // --- 会话列表（GET /agent/sessions?machine_id=&limit=）──
  ipcMain.handle('agent:sessions', async (_e, params) => {
    try {
      const p = params || {}
      const qs = new URLSearchParams({ machine_id: getMachineId() })
      qs.set('limit', String(p.limit || 100))
      const res = await httpRequest('GET', `${API_ENDPOINTS.agent.sessions}?${qs.toString()}`, { timeout: 10000 })
      return res.data
    } catch (err) { return isExpectedOfflineError(err) ? null : { error: err.message } }
  })

  // --- 删除服务端会话（素材池一并清理；对照原版 delete_session）──
  ipcMain.handle('agent:sessionDelete', async (_e, params) => {
    try {
      const p = params || {}
      if (!p.id) throw new Error('agent:sessionDelete requires id')
      const path = `${API_ENDPOINTS.agent.sessionItem(p.id)}?machine_id=${encodeURIComponent(getMachineId())}`
      await httpRequest('DELETE', path, { timeout: 10000 })
      return { ok: true }
    } catch (err) { return isExpectedOfflineError(err) ? null : { error: err.message } }
  })

  // --- 会话素材池列表（条目：{name,file_ref,media_type,source,added_at}）──
  ipcMain.handle('agent:sessionAttachments', async (_e, params) => {
    try {
      const p = params || {}
      if (!p.id) throw new Error('agent:sessionAttachments requires id')
      const path = `${API_ENDPOINTS.agent.sessionAttachments(p.id)}?machine_id=${encodeURIComponent(getMachineId())}`
      const res = await httpRequest('GET', path, { timeout: 10000 })
      return res.data
    } catch (err) { return isExpectedOfflineError(err) ? null : { error: err.message } }
  })

  // --- 素材入池（二选一：materialId 引用素材库 | filePath 上传本地附件）──
  ipcMain.handle('agent:sessionAttachmentAdd', async (event, params, onProgressChannel) => {
    try {
      const p = params || {}
      if (!p.id) throw new Error('agent:sessionAttachmentAdd requires id')
      const fields = {}
      if (p.materialId !== undefined && p.materialId !== null && p.materialId !== '') {
        fields.material_id = String(p.materialId)
      } else if (p.filePath) {
        if (!fs.existsSync(p.filePath)) throw new Error(`附件不存在：${p.filePath}`)
        fields.file = fs.createReadStream(p.filePath)
      } else {
        throw new Error('agent:sessionAttachmentAdd 需要 materialId 或 filePath 二选一')
      }
      const onProgress = onProgressChannel
        ? (percent) => event.sender.send(onProgressChannel, percent)
        : undefined
      return await multipartUpload(API_ENDPOINTS.agent.sessionAttachments(p.id), fields, onProgress)
    } catch (err) { return isExpectedOfflineError(err) ? null : { error: err.message } }
  })

  // --- 从素材池移除（key = 入池返回的 file_ref；对照原版 session_attachment_remove）──
  ipcMain.handle('agent:sessionAttachmentRemove', async (_e, params) => {
    try {
      const p = params || {}
      if (!p.id || !p.key) throw new Error('agent:sessionAttachmentRemove requires id+key')
      const path = `${API_ENDPOINTS.agent.sessionAttachmentItem(p.id, p.key)}?machine_id=${encodeURIComponent(getMachineId())}`
      await httpRequest('DELETE', path, { timeout: 10000 })
      return { ok: true }
    } catch (err) { return isExpectedOfflineError(err) ? null : { error: err.message } }
  })
}

module.exports = { createAgentChatIpc }
