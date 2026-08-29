// ═══════════════════════════════════════════════════════════════
// server-proxy-serverurl.test.mjs — getServerUrl 服务端地址解析单测
// 对照「服务端配置业务对齐（2026-08-28 用户裁决）」：
//   1. electron-store 'server.url'（设置页保存）必须优先于 ai_config.json 回退
//      —— 否则「保存服务端地址后立即生效」链路断裂（模型列表/功能测试打旧地址）
//   2. 无 store / store 无值时回退 ai_config.json server_url（desktop/config）
//   3. llm:providers 随 Provider 凭证客户端化废弃：API_ENDPOINTS.llm 不再含 providers
// 运行：node --test "tests/*.test.mjs"
// ═══════════════════════════════════════════════════════════════

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

// server-proxy.js 顶层 require('electron')，node --test 环境预注入最小 mock
const Module = require('node:module')
const originalLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return { ipcMain: { handle: () => {} } }
  return originalLoad.call(this, request, parent, isMain)
}

const { getServerUrl, setConfigStore, API_ENDPOINTS } = require('../main/server-proxy.js')

test('getServerUrl 优先读 electron-store server.url（设置页保存后立即生效）', () => {
  setConfigStore({ get: (key) => (key === 'server.url' ? 'http://10.0.0.9:9000/' : undefined) })
  assert.equal(getServerUrl(), 'http://10.0.0.9:9000') // 尾斜杠归一化
  setConfigStore(null) // 还原，避免影响后续用例
})

test('getServerUrl 无 store 值时回退（ai_config 搜索路径未命中 → 默认 8766）', () => {
  setConfigStore({ get: () => undefined })
  // 搜索路径为项目根 config/ai_config.json（desktop/config 不在其列），未命中 → 默认值
  assert.equal(getServerUrl(), 'http://127.0.0.1:8766')
  setConfigStore(null)
})

test('API_ENDPOINTS.llm 不含 providers（llm:providers 已废弃）且保留 models', () => {
  assert.equal(API_ENDPOINTS.llm.providers, undefined)
  assert.equal(API_ENDPOINTS.llm.models, '/llm/models')
})
