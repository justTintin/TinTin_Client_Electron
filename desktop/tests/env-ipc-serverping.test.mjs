// ═══════════════════════════════════════════════════════════════
// env-ipc-serverping.test.mjs — env:serverPing 统一状态判定通道单测
// 对照「服务端状态指示不同源」缺陷修复（2026-08-28）：
//   1. env:serverPing 是标题栏状态胶囊与设置区「测试连接」的唯一共同判定通道，
//      地址来自 getServerUrl()（electron-store 'server.url' 单一真相源）
//   2. pingServer 必须支持 https 地址（设置页可保存 https），否则统一通道会把
//      https 服务端误判离线（修复点：按协议选 http/https 模块）
//   3. 离线/非法地址静默返回 { online:false }，不抛异常
// 运行：node --test "tests/*.test.mjs"
// ═══════════════════════════════════════════════════════════════

import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

// env-ipc.js 顶层 require('electron')，node --test 环境预注入最小 mock
// （session.defaultSession.clearCache 供 env:restartService 使用）
const Module = require('node:module')
const originalLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'electron') {
    return {
      ipcMain: { handle: () => {} },
      session: { defaultSession: { clearCache: async () => {} } },
    }
  }
  return originalLoad.call(this, request, parent, isMain)
}

const { createEnvIpc } = require('../main/env-ipc.js')

/** 装配 env IPC（mock ipcMain 捕获 handlers），返回按通道名调用的 helper */
function setupEnvIpc(getServerUrl) {
  const handlers = new Map()
  createEnvIpc({ handle: (ch, fn) => handlers.set(ch, fn) }, { getServerUrl })
  return (channel) => handlers.get(channel)
}

test('env:serverPing 对在线 http 服务端返回 online=true + 生效地址 + 延迟', async () => {
  const server = http.createServer((_req, res) => { res.writeHead(200); res.end('ok') })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  try {
    const url = `http://127.0.0.1:${port}`
    const serverPing = setupEnvIpc(() => url)
    const r = await serverPing('env:serverPing')()
    assert.equal(r.online, true)
    assert.equal(r.url, url) // 回显 getServerUrl 的单一地址源
    assert.equal(typeof r.latencyMs, 'number')
  } finally {
    await new Promise((r) => server.close(r))
  }
})

test('env:serverPing 对未监听端口静默返回 online=false（不抛异常）', async () => {
  const serverPing = setupEnvIpc(() => 'http://127.0.0.1:1') // 保留端口，必拒绝
  const r = await serverPing('env:serverPing')()
  assert.equal(r.online, false)
  assert.equal(r.url, 'http://127.0.0.1:1')
})

test('env:serverPing 支持 https 地址（协议分支修复：不得误判/抛异常）', async () => {
  // https 请求打到 http 端口 → TLS 握手失败 → 静默 offline（证明走了 https 分支且不崩）
  const serverPing = setupEnvIpc(() => 'https://127.0.0.1:1')
  const r = await serverPing('env:serverPing')()
  assert.equal(r.online, false)
  assert.equal(r.url, 'https://127.0.0.1:1')
})

test('env:serverPing 对非法地址字符串返回 online=false', async () => {
  const serverPing = setupEnvIpc(() => 'not-a-url')
  const r = await serverPing('env:serverPing')()
  assert.equal(r.online, false)
})

test('env:restartService 清缓存后重新探测同一地址源（在线场景）', async () => {
  const server = http.createServer((_req, res) => { res.writeHead(200); res.end('ok') })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  try {
    const url = `http://127.0.0.1:${port}`
    const restartService = setupEnvIpc(() => url)
    const r = await restartService('env:restartService')()
    assert.equal(r.online, true)
    assert.equal(r.url, url)
  } finally {
    await new Promise((r) => server.close(r))
  }
})
