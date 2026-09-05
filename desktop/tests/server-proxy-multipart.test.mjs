// ═══════════════════════════════════════════════════════════════
// server-proxy-multipart.test.mjs — multipart 上传契约单测
// 2026-09-04 用户裁决：音频生成「保存到 BGM/音效库」上传前检查接口与服务端
// 对齐、上传类型正确。本测试固化 buildMultipartBody 构造口径：
//   对照原客户端 utils/audio_library_client.py：
//   · bgm_upload L71-94：POST /audio/bgm/upload
//       files={"file": (basename, f)}，data={"tag","scene","mood"}
//   · sfx_analyze L127-147：POST /sfx/analyze，files={"file": (basename, f)}（无 data）
//   · requests 按 filename 扩展名推断 part Content-Type：
//       .mp3→audio/mpeg、.wav→audio/wav（本端 getMimeType 同映射）
//   · filename 带扩展名 → 服务端 FastAPI UploadFile 据此识别音频类型
// 运行：node --test "tests/*.test.mjs"
// ═══════════════════════════════════════════════════════════════

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const require = createRequire(import.meta.url)

// server-proxy.js 顶层 require('electron')，node --test 环境预注入最小 mock
// （同 server-proxy-serverurl.test.mjs 先例）
const Module = require('node:module')
const originalLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return { ipcMain: { handle: () => {} } }
  return originalLoad.call(this, request, parent, isMain)
}

const { buildMultipartBody, API_ENDPOINTS } = require('../main/server-proxy.js')

/** 按 boundary 拆出 part 头 + 载荷（text 解码） */
function parseParts(body, boundary) {
  const raw = body.toString('binary')
  return raw
    .split(`--${boundary}`)
    .filter((s) => s && s !== '--\r\n' && s.trim() !== '')
    .map((s) => {
      const idx = s.indexOf('\r\n\r\n')
      // 载荷以 binary 拆分（避免二进制损坏）；中文文本字段转回 utf-8 比对，尾部 \r\n 剥去
      const payload = Buffer.from(s.slice(idx + 4).replace(/\r\n$/, ''), 'binary').toString('utf-8')
      return { header: s.slice(0, idx), payload }
    })
}

const tmpDir = mkdtempSync(join(tmpdir(), 'tintin_multipart_'))
const wavPath = join(tmpDir, 'ai_bgm_123.wav')
const mp3Path = join(tmpDir, 'ai_sfx_456.mp3')
writeFileSync(wavPath, 'WAVDATA')
writeFileSync(mp3Path, 'MP3DATA')

test('端点对齐：/audio/bgm/upload 与 /sfx/analyze（以原客户端实际调用为准）', () => {
  assert.equal(API_ENDPOINTS.audio.bgmUpload, '/audio/bgm/upload')
  assert.equal(API_ENDPOINTS.audio.sfxAnalyze, '/sfx/analyze')
})

test('BGM 上传口径：file part（filename 带扩展名 + audio/wav）+ tag/scene/mood 文本字段', () => {
  const { body, boundary } = buildMultipartBody({
    file: { path: wavPath },
    tag: 'AI生成', scene: '', mood: '',
  })
  const parts = parseParts(body, boundary)
  assert.equal(parts.length, 4) // file + tag + scene + mood

  const filePart = parts[0]
  assert.match(filePart.header, /name="file"; filename="ai_bgm_123\.wav"/)
  assert.match(filePart.header, /Content-Type: audio\/wav/)
  assert.equal(filePart.payload, 'WAVDATA')

  assert.match(parts[1].header, /name="tag"/)
  assert.equal(parts[1].payload, 'AI生成')
  assert.match(parts[2].header, /name="scene"/)
  assert.equal(parts[2].payload, '')
  assert.match(parts[3].header, /name="mood"/)
  assert.equal(parts[3].payload, '')
})

test('SFX 上传口径：仅 file part（audio/mpeg），无 tag/scene/mood', () => {
  const { body, boundary } = buildMultipartBody({ file: { path: mp3Path } })
  const parts = parseParts(body, boundary)
  assert.equal(parts.length, 1)
  assert.match(parts[0].header, /name="file"; filename="ai_sfx_456\.mp3"/)
  assert.match(parts[0].header, /Content-Type: audio\/mpeg/)
  assert.equal(parts[0].payload, 'MP3DATA')
})

test('filename 覆写：{ path, filename } 支持显式指定（Content-Type 随新扩展名）', () => {
  const { body, boundary } = buildMultipartBody({
    file: { path: wavPath, filename: 'bgm_final.mp3' },
  })
  const parts = parseParts(body, boundary)
  assert.match(parts[0].header, /filename="bgm_final\.mp3"/)
  assert.match(parts[0].header, /Content-Type: audio\/mpeg/)
})

test('body 以结束边界收尾（multipart 规范）', () => {
  const { body, boundary } = buildMultipartBody({ file: { path: wavPath } })
  assert.ok(body.toString('binary').endsWith(`\r\n--${boundary}--\r\n`))
})
