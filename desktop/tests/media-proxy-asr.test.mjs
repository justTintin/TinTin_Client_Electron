// ═══════════════════════════════════════════════════════════════
// media-proxy-asr.test.mjs — asr:transcribe 契约单测
// 2026-09-06 修复 POST /whisper/transcribe 422 的固化测试：
//   契约 Body_transcribe_whisper_transcribe_post = multipart/form-data：
//     file(必填) + language + fmt + task_id；**无 JSON {url} 分支**。
//   · 本地文件分支：渲染层 audio={path} → multipart 字段名必须是 file（曾误用 audio）
//   · url 分支（服务端样本）：先 GET 取回音频字节 → multipart file 上传（曾为 JSON POST → 422）
//   · p.format 兼容映射契约字段 fmt
// 运行：node --test "tests/*.test.mjs"
// ═══════════════════════════════════════════════════════════════

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

// media-proxy-ipc.js 顶层 require('electron') + logger（electron app/shell/electron-log），
// node --test 环境预注入最小 mock（同 server-proxy-multipart.test.mjs 先例）
const Module = require('node:module')
const originalLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'electron') {
    return { app: { getPath: () => process.cwd() }, shell: {}, ipcMain: { handle: () => {} } }
  }
  if (request === 'electron-log') return { scopes: () => ({ info: () => {}, warn: () => {}, error: () => {} }) }
  return originalLoad.call(this, request, parent, isMain)
}

const { createMediaProxyIpc } = require('../main/media-proxy-ipc.js')
const { API_ENDPOINTS } = require('../main/server-proxy.js')

/** 收集 ipcMain.handle 注册表 → { channel: handler } */
function makeIpcMain() {
  const handlers = {}
  return { handlers, handle(channel, fn) { handlers[channel] = fn } }
}

/** 组装被测模块：注入假 httpRequest / multipartUpload，记录调用不发起真实网络 */
function setup({ httpImpl, uploadImpl } = {}) {
  const calls = []   // httpRequest 调用记录
  const uploads = [] // multipartUpload 调用记录
  const ipcMain = makeIpcMain()
  createMediaProxyIpc(ipcMain, {
    httpRequest: httpImpl || (async (...a) => { calls.push(a); return { data: {} } }),
    multipartUpload: uploadImpl || (async (...a) => { uploads.push(a); return { ok: true } }),
    API_ENDPOINTS,
    resolveEndpoint: (ep) => ep,
    isExpectedOfflineError: (err) =>
      ['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET'].some((c) => String(err?.message || err).includes(c)),
  })
  return { handlers: ipcMain.handlers, calls, uploads }
}

test('端点对齐：asr.transcribe = /whisper/transcribe', () => {
  assert.equal(API_ENDPOINTS.asr.transcribe, '/whisper/transcribe')
})

test('缺 audio 和 url → 参数校验 {error}，不发请求', async () => {
  const { handlers, calls, uploads } = setup()
  const r = await handlers['asr:transcribe']({}, {})
  assert.ok(r && r.error, '必须返回 {error}')
  assert.equal(calls.length, 0)
  assert.equal(uploads.length, 0)
})

test('本地文件分支：multipart 字段名 file（契约），format 兼容映射 fmt', async () => {
  const { handlers, uploads } = setup()
  await handlers['asr:transcribe']({}, {
    audio: { path: 'D:/audio/ref.wav' },
    language: 'zh',
    format: 'txt',
  })
  assert.equal(uploads.length, 1)
  const [endpoint, fields] = uploads[0]
  assert.equal(endpoint, '/whisper/transcribe')
  assert.deepEqual(fields.file, { path: 'D:/audio/ref.wav' }, '契约字段名为 file')
  assert.equal(fields.language, 'zh')
  assert.equal(fields.fmt, 'txt', 'p.format 应映射契约字段 fmt')
  assert.equal(fields.audio, undefined, '不得再发送非契约字段 audio')
})

test('url 分支（服务端样本）：先 GET 取回字节 → multipart file 上传，非 JSON POST', async () => {
  const audioBytes = Buffer.from('RIFF....WAVE')
  const { handlers, calls, uploads } = setup({
    httpImpl: async (...a) => {
      calls.push(a)
      return { data: audioBytes, raw: audioBytes, headers: { 'content-type': 'audio/wav' } }
    },
  })
  await handlers['asr:transcribe']({}, { url: '/voice/samples/3/audio', fmt: 'json' })
  // 1) 只发一次 GET（无 JSON POST）
  assert.equal(calls.length, 1)
  const [method, url] = calls[0]
  assert.equal(method, 'GET')
  assert.equal(url, '/voice/samples/3/audio')
  // 2) multipart 字段：file（内存字节）+ fmt
  assert.equal(uploads.length, 1)
  const [endpoint, fields] = uploads[1 - 1]
  assert.equal(endpoint, '/whisper/transcribe')
  assert.ok(Buffer.isBuffer(fields.file.buffer), 'file.buffer 必须是 Buffer')
  assert.equal(fields.file.buffer.toString(), 'RIFF....WAVE')
  assert.equal(fields.file.filename, 'sample.wav', 'URL 无扩展名时按 content-type 推断 .wav')
  assert.equal(fields.file.contentType, 'audio/wav')
  assert.equal(fields.fmt, 'json')
  assert.equal(fields.url, undefined, '契约无 url 字段，不得发送')
})

test('url 分支：服务端返回非音频（JSON 错误体）→ {error}，不上传', async () => {
  const { handlers, uploads } = setup({
    httpImpl: async () => ({ data: { detail: 'not found' }, raw: null, headers: { 'content-type': 'application/json' } }),
  })
  const r = await handlers['asr:transcribe']({}, { url: '/voice/samples/999/audio' })
  assert.ok(r && r.error && r.error.includes('样本音频下载失败'), `应报样本下载失败，实为 ${r && r.error}`)
  assert.equal(uploads.length, 0)
})
