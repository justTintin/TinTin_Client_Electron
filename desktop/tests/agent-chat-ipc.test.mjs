// ═══════════════════════════════════════════════════════════════
// agent-chat-ipc.test.mjs — 工作台 AI 对话真实链路·主进程 IPC 单测
// 对照 BUSINESS_ALIGNMENT §一 W1/W2/W3（P1）与 openapi-latest.json 实际契约：
//   · POST /agent/chat          JSON body {message, history?, model?, max_rounds=3,
//                               mode?, session_id?, stream:false, machine_id}
//   · GET  /agent/sessions      query {machine_id, limit}
//   · DELETE /agent/sessions/{id}
//   · GET/POST /agent/sessions/{id}/attachments（POST = multipart: file | material_id）
//   · DELETE /agent/sessions/{id}/attachments/{key}
// 异常四分支（项目铁律）：网络失败→null / 5xx→{error} / 参数校验→{error} / 端点路径
// 运行：node --test "tests/*.test.mjs"
// ═══════════════════════════════════════════════════════════════

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

// agent-chat-ipc.js 由 server-proxy.js 注入依赖（同 media-proxy-ipc 模式），
// 测试注入假 httpRequest / multipartUpload / getMachineId，不发起真实网络。
const { createAgentChatIpc } = require('../main/agent-chat-ipc.js')
const { API_ENDPOINTS } = require('../main/server-proxy.js')

/** 收集 ipcMain.handle 注册表 → { channel: handler } */
function makeIpcMain() {
  const handlers = {}
  return {
    handlers,
    handle(channel, fn) { handlers[channel] = fn }
  }
}

/** 组装被测模块：返回 { handlers, calls, uploads } */
function setup({ httpImpl, uploadImpl, machineId = 'MACHINE-ABC' } = {}) {
  const calls = []   // httpRequest 调用记录
  const uploads = [] // multipartUpload 调用记录
  const ipcMain = makeIpcMain()
  createAgentChatIpc(ipcMain, {
    httpRequest: httpImpl || (async (...a) => { calls.push(a); return { data: { ok: true } } }),
    multipartUpload: uploadImpl || (async (...a) => { uploads.push(a); return { attachment: { file_ref: 'ref-1' } } }),
    API_ENDPOINTS,
    isExpectedOfflineError: (err) => {
      const code = err && (err.code || err.message)
      return typeof code === 'string' &&
        ['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET'].some((c) => code.includes(c))
    },
    getMachineId: () => machineId
  })
  return { handlers: ipcMain.handlers, calls, uploads }
}

test('agent:chat 缺 message → 参数校验失败 {error}，不发请求', async () => {
  const { handlers, calls } = setup()
  const r = await handlers['agent:chat']({}, { history: [] })
  assert.ok(r && r.error, '必须返回 {error}')
  assert.equal(calls.length, 0, '参数校验失败不得发起 HTTP')
})

test('agent:chat body 组装：max_rounds=3/stream:false/mode/session_id/machine_id 注入', async () => {
  const { handlers, calls } = setup({ machineId: 'MID-1' })
  await handlers['agent:chat']({}, {
    message: '帮我写脚本',
    history: [{ role: 'user', content: '上一轮' }],
    model: 'deepseek-chat',
    mode: 'plan',
    sessionId: 's-9'
  })
  assert.equal(calls.length, 1)
  const [method, endpoint, opts] = calls[0]
  assert.equal(method, 'POST')
  assert.equal(endpoint, '/agent/chat')
  assert.deepEqual(opts.body, {
    message: '帮我写脚本',
    history: [{ role: 'user', content: '上一轮' }],
    model: 'deepseek-chat',
    max_rounds: 3,
    mode: 'plan',
    session_id: 's-9',
    stream: false,
    machine_id: 'MID-1'
  })
})

test('agent:chat 成功 → 透传服务端响应（reply/session_id）', async () => {
  const { handlers } = setup({
    httpImpl: async () => ({ data: { reply: '好的', session_id: 's-1' } })
  })
  const r = await handlers['agent:chat']({}, { message: 'hi' })
  assert.deepEqual(r, { reply: '好的', session_id: 's-1' })
})

test('agent:chat maxRounds=1 透传（原版 create_session 轻量建会话口径）', async () => {
  const { handlers, calls } = setup()
  await handlers['agent:chat']({}, { message: '会话初始化', maxRounds: 1 })
  assert.equal(calls.length, 1)
  assert.equal(calls[0][2].body.max_rounds, 1)
  assert.equal(calls[0][2].body.message, '会话初始化')
})

test('agent:chat 网络失败（ECONNREFUSED）→ null（离线静默）', async () => {
  const { handlers } = setup({
    httpImpl: async () => { const e = new Error('connect ECONNREFUSED'); e.code = 'ECONNREFUSED'; throw e }
  })
  const r = await handlers['agent:chat']({}, { message: 'hi' })
  assert.equal(r, null)
})

test('agent:chat 服务端 5xx → {error:"HTTP 500"}', async () => {
  const { handlers } = setup({
    httpImpl: async () => { const e = new Error('HTTP 500'); e.status = 500; throw e }
  })
  const r = await handlers['agent:chat']({}, { message: 'hi' })
  assert.ok(r && /HTTP 500/.test(r.error))
})

test('agent:sessions → GET /agent/sessions 且 query 携带 machine_id + limit', async () => {
  const { handlers, calls } = setup({ machineId: 'MID-2' })
  await handlers['agent:sessions']({}, { limit: 50 })
  assert.equal(calls.length, 1)
  const [method, endpoint] = calls[0]
  assert.equal(method, 'GET')
  assert.ok(endpoint.startsWith('/agent/sessions?'), endpoint)
  assert.ok(endpoint.includes('machine_id=MID-2'), endpoint)
  assert.ok(endpoint.includes('limit=50'), endpoint)
})

test('agent:sessionDelete → DELETE /agent/sessions/{id}?machine_id=…；缺 id 报错', async () => {
  const { handlers, calls } = setup({ machineId: 'MID-3' })
  await handlers['agent:sessionDelete']({}, { id: 's-7' })
  const [method, endpoint] = calls[0]
  assert.equal(method, 'DELETE')
  assert.equal(endpoint, '/agent/sessions/s-7?machine_id=MID-3')
  const bad = await handlers['agent:sessionDelete']({}, {})
  assert.ok(bad && bad.error)
})

test('agent:sessionAttachments → GET /agent/sessions/{id}/attachments?machine_id=…', async () => {
  const { handlers, calls } = setup({ machineId: 'MID-4' })
  await handlers['agent:sessionAttachments']({}, { id: 's-8' })
  const [method, endpoint] = calls[0]
  assert.equal(method, 'GET')
  assert.equal(endpoint, '/agent/sessions/s-8/attachments?machine_id=MID-4')
})

test('agent:sessionAttachmentAdd material_id 引用 → multipart 字符串字段', async () => {
  const { handlers, uploads } = setup()
  const r = await handlers['agent:sessionAttachmentAdd']({}, { id: 's-1', materialId: 42 })
  assert.deepEqual(r, { attachment: { file_ref: 'ref-1' } })
  assert.equal(uploads.length, 1)
  const [endpoint, fields] = uploads[0]
  assert.equal(endpoint, '/agent/sessions/s-1/attachments')
  assert.equal(fields.material_id, '42')
})

test('agent:sessionAttachmentAdd 本地文件 → multipart ReadStream（filename 保留）', async () => {
  const tmp = path.join(os.tmpdir(), 'tintin-agent-att-test.txt')
  fs.writeFileSync(tmp, 'hello')
  let fileStream = null
  try {
    const { handlers, uploads } = setup()
    await handlers['agent:sessionAttachmentAdd']({}, { id: 's-2', filePath: tmp })
    assert.equal(uploads.length, 1)
    const [endpoint, fields] = uploads[0]
    assert.equal(endpoint, '/agent/sessions/s-2/attachments')
    assert.ok(fields.file, '必须有 file 字段')
    assert.equal(path.basename(fields.file.path), path.basename(tmp))
    fileStream = fields.file
  } finally {
    // mock 未消费流：挂 error 监听 + 销毁，避免懒 open 在 unlink 后触发 ENOENT uncaught
    try { fileStream?.on?.('error', () => {}); fileStream?.destroy() } catch (_e) {}
    fs.unlinkSync(tmp)
  }
})

test('agent:sessionAttachmentAdd 文件不存在 → 参数校验失败 {error}', async () => {
  const { handlers, uploads } = setup()
  const r = await handlers['agent:sessionAttachmentAdd']({}, {
    id: 's-3', filePath: path.join(os.tmpdir(), 'no-such-file-xyz.bin')
  })
  assert.ok(r && r.error)
  assert.equal(uploads.length, 0)
})

test('agent:sessionAttachmentAdd 无 materialId 且无 filePath → {error}', async () => {
  const { handlers, uploads } = setup()
  const r = await handlers['agent:sessionAttachmentAdd']({}, { id: 's-4' })
  assert.ok(r && r.error)
  assert.equal(uploads.length, 0)
})

test('agent:sessionAttachmentRemove → DELETE /agent/sessions/{id}/attachments/{key}', async () => {
  const { handlers, calls } = setup({ machineId: 'MID-5' })
  await handlers['agent:sessionAttachmentRemove']({}, { id: 's-5', key: 'ref-9' })
  const [method, endpoint] = calls[0]
  assert.equal(method, 'DELETE')
  assert.equal(endpoint, '/agent/sessions/s-5/attachments/ref-9?machine_id=MID-5')
})

test('agent:agents → GET /agent/agents 并透传响应（{agents} 或裸数组）', async () => {
  const calls = []
  const { handlers } = setup({
    httpImpl: async (...a) => { calls.push(a); return { data: { agents: [{ agent_id: 'a1', name: 'A1', exposed: true }] } } }
  })
  const r = await handlers['agent:agents']()
  assert.deepEqual(r, { agents: [{ agent_id: 'a1', name: 'A1', exposed: true }] })
  assert.equal(calls.length, 1)
  const [method, endpoint] = calls[0]
  assert.equal(method, 'GET')
  assert.equal(endpoint, '/agent/agents')
})

test('agent:agents 网络失败（ECONNREFUSED）→ null（离线静默，快捷条回退仅「对话」）', async () => {
  const { handlers } = setup({
    httpImpl: async () => { const e = new Error('connect ECONNREFUSED'); e.code = 'ECONNREFUSED'; throw e }
  })
  const r = await handlers['agent:agents']()
  assert.equal(r, null)
})

test('agent:agents 服务端 5xx → {error:"HTTP 500"}', async () => {
  const { handlers } = setup({
    httpImpl: async () => { const e = new Error('HTTP 500'); e.status = 500; throw e }
  })
  const r = await handlers['agent:agents']()
  assert.ok(r && /HTTP 500/.test(r.error))
})

test('API_ENDPOINTS.agent 补齐对话/会话子端点（chat/sessions/attachments）', () => {
  assert.equal(API_ENDPOINTS.agent.chat, '/agent/chat')
  assert.equal(API_ENDPOINTS.agent.sessions, '/agent/sessions')
  assert.equal(typeof API_ENDPOINTS.agent.sessionItem, 'function')
  assert.equal(API_ENDPOINTS.agent.sessionItem('x'), '/agent/sessions/x')
  assert.equal(typeof API_ENDPOINTS.agent.sessionAttachments, 'function')
  assert.equal(API_ENDPOINTS.agent.sessionAttachments('x'), '/agent/sessions/x/attachments')
  assert.equal(typeof API_ENDPOINTS.agent.sessionAttachmentItem, 'function')
  assert.equal(API_ENDPOINTS.agent.sessionAttachmentItem('x', 'k'), '/agent/sessions/x/attachments/k')
})
