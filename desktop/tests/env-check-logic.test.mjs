// ═══════════════════════════════════════════════════════════════
// env-check-logic.test.mjs — 条目⑪ 环境检测口径重定义 编组单测
// 原客户端证据（以原代码为准）：studio/gui/env_config_page.py
//   check_environment L412-513：Python/CUDA/PyTorch（L414-436，新端弃）、
//   ffmpeg（L438-461，保留：候选路径 → PATH 兜底）、VSR 内嵌环境
//   （L463-473，新端服务端化 → 弃）、VoxCPM/OCR（L475-493 → 服务端健康）、
//   硬件信息 os/cpu/ram/gpu（L495-510，保留 os/cpu/ram 轻量项，gpu 弃）。
// 新口径 = 服务端连通（env:serverPing）+ 服务端能力健康
//   （server.healthCapabilities /health/capabilities）+ 本地资源
//   （ffmpeg / 磁盘空间 / os·cpu·ram 轻量项）。
// 运行：node --test "tests/*.test.mjs"
// ═══════════════════════════════════════════════════════════════

import { test } from 'node:test'
import assert from 'node:assert/strict'

const R = await import('../renderer/src/composables/envCheckLogic.ts')

const LOCAL_OK = {
  ffmpeg: { ok: true, path: 'C:/app/resources/bin/ffmpeg.exe' },
  os: 'Windows 11 Pro',
  cpu: 'Intel Core i7 (16)',
  ramGb: 32,
  disk: { freeGb: 120.4, totalGb: 476.9 },
}

const CAPS_ALL = {
  capabilities: Object.fromEntries(
    ['rembg', 'vsr', 'vsr_remove', 'whisper', 'voice_clone', 'stock_search',
      'reverse_prompt', 'llm', 'asr', 'digital_human', 'montage', 'ocr']
      .map((k) => [k, { enabled: true }]),
  ),
  server_time: '2026-08-28T00:00:00',
}

// ── 正向：全绿 ──

test('正向：服务端在线 + 12 能力全启用 + 本地资源健康 → 各行 ok 且磁盘/ffmpeg 细节正确', () => {
  const rows = R.groupEnvReport(
    { server: { online: true, url: 'http://127.0.0.1:8000', latencyMs: 12 }, local: LOCAL_OK },
    CAPS_ALL,
  )
  const byLabel = Object.fromEntries(rows.map((r) => [r.label, r]))
  assert.equal(byLabel['服务端连通'].state, 'ok')
  assert.match(byLabel['服务端连通'].detail, /12ms/)
  assert.equal(byLabel['服务端功能能力'].state, 'ok')
  assert.match(byLabel['服务端功能能力'].detail, /12\/12/)
  assert.equal(byLabel['FFmpeg'].state, 'ok')
  assert.equal(byLabel['磁盘可用空间'].state, 'ok')
  assert.match(byLabel['磁盘可用空间'].detail, /120\.4\s*GB/)
  assert.equal(byLabel['系统资源'].state, 'ok')
  assert.match(byLabel['系统资源'].detail, /Windows 11 Pro/)
  assert.match(byLabel['系统资源'].detail, /32\s*GB/)
})

// ── 网络失败：服务端离线（能力行随失败，本地行不受影响） ──

test('离线：服务端连通 bad，能力行 bad「服务端离线」，本地资源行仍正常评估', () => {
  const rows = R.groupEnvReport(
    { server: { online: false, url: 'http://127.0.0.1:8000' }, local: LOCAL_OK },
    null, // capabilities null = 离线静默
  )
  const byLabel = Object.fromEntries(rows.map((r) => [r.label, r]))
  assert.equal(byLabel['服务端连通'].state, 'bad')
  assert.equal(byLabel['服务端功能能力'].state, 'bad')
  assert.match(byLabel['服务端功能能力'].detail, /服务端离线/)
  assert.equal(byLabel['FFmpeg'].state, 'ok', '本地 ffmpeg 检测不依赖服务端')
})

// ── 5xx / 业务错误分支 ──

test('能力响应 {error}（5xx）→ 能力行 bad 且透出错误消息；连通行仍按 ping 判定', () => {
  const rows = R.groupEnvReport(
    { server: { online: true, url: 'http://x', latencyMs: 5 }, local: LOCAL_OK },
    { error: 'HTTP 500 Internal Server Error' },
  )
  const byLabel = Object.fromEntries(rows.map((r) => [r.label, r]))
  assert.equal(byLabel['服务端连通'].state, 'ok')
  assert.equal(byLabel['服务端功能能力'].state, 'bad')
  assert.match(byLabel['服务端功能能力'].detail, /500/)
})

test('能力部分禁用 → 能力行 warn 并列出禁用项', () => {
  const caps = JSON.parse(JSON.stringify(CAPS_ALL))
  caps.capabilities.montage.enabled = false
  caps.capabilities.ocr.enabled = false
  const rows = R.groupEnvReport(
    { server: { online: true, url: 'http://x', latencyMs: 5 }, local: LOCAL_OK },
    caps,
  )
  const byLabel = Object.fromEntries(rows.map((r) => [r.label, r]))
  assert.equal(byLabel['服务端功能能力'].state, 'warn')
  assert.match(byLabel['服务端功能能力'].detail, /10\/12/)
  assert.match(byLabel['服务端功能能力'].detail, /montage/)
  assert.match(byLabel['服务端功能能力'].detail, /ocr/)
})

// ── 本地资源检测失败分支 ──

test('local=null（主进程资源检测异常）→ 本地各行 unknown（不误报失败）', () => {
  const rows = R.groupEnvReport(
    { server: { online: true, url: 'http://x', latencyMs: 5 }, local: null },
    CAPS_ALL,
  )
  const byLabel = Object.fromEntries(rows.map((r) => [r.label, r]))
  assert.equal(byLabel['FFmpeg'].state, 'unknown')
  assert.equal(byLabel['磁盘可用空间'].state, 'unknown')
  assert.equal(byLabel['系统资源'].state, 'unknown')
})

test('ffmpeg 未找到 → bad；磁盘 <5GB → warn；disk=null → unknown', () => {
  const noFf = R.groupEnvReport(
    { server: { online: true, url: 'http://x', latencyMs: 5 }, local: { ...LOCAL_OK, ffmpeg: { ok: false, path: '' } } },
    CAPS_ALL,
  )
  const a = Object.fromEntries(noFf.map((r) => [r.label, r]))
  assert.equal(a['FFmpeg'].state, 'bad')
  assert.match(a['FFmpeg'].detail, /ffmpeg\.exe/)

  const low = R.groupEnvReport(
    { server: { online: true, url: 'http://x', latencyMs: 5 }, local: { ...LOCAL_OK, disk: { freeGb: 3.2, totalGb: 476.9 } } },
    CAPS_ALL,
  )
  const b = Object.fromEntries(low.map((r) => [r.label, r]))
  assert.equal(b['磁盘可用空间'].state, 'warn')

  const nullDisk = R.groupEnvReport(
    { server: { online: true, url: 'http://x', latencyMs: 5 }, local: { ...LOCAL_OK, disk: null } },
    CAPS_ALL,
  )
  const c = Object.fromEntries(nullDisk.map((r) => [r.label, r]))
  assert.equal(c['磁盘可用空间'].state, 'unknown')
})

// ── 主进程检测核（main/env-detect.js）：注入依赖，无 electron 依赖可直测 ──

async function loadEnvDetect() {
  const { createRequire } = await import('node:module')
  const require = createRequire(import.meta.url)
  return require('../main/env-detect.js')
}

test('detectFfmpegPath：打包 resources/bin 优先 → 开发 studioRoot/bin/win → PATH 兜底 → 未找到 ok:false', async () => {
  const { detectFfmpegPath } = await loadEnvDetect()
  const mk = (exists) => ({ existsSync: (p) => exists.has(p), statSync: () => ({ isFile: () => true }) })
  const joinWin = (...a) => a.join('\\')
  const APP = 'C:\\app\\resources'
  const DEV = 'C:\\dev\\desktop'

  // 1. 打包优先
  const r1 = await detectFfmpegPath({
    resourcesPath: APP,
    studioRoot: DEV,
    fs: mk(new Set([`${APP}\\bin\\ffmpeg.exe`, `${DEV}\\bin\\win\\ffmpeg.exe`])),
    path: { join: joinWin },
    which: async () => '',
  })
  assert.equal(r1.ok, true)
  assert.match(r1.path, /resources\\bin\\ffmpeg\.exe/)

  // 2. 开发目录兜底
  const r2 = await detectFfmpegPath({
    resourcesPath: APP,
    studioRoot: DEV,
    fs: mk(new Set([`${DEV}\\bin\\win\\ffmpeg.exe`])),
    path: { join: joinWin },
    which: async () => '',
  })
  assert.equal(r2.ok, true)
  assert.match(r2.path, /bin\\win\\ffmpeg\.exe/)

  // 3. PATH 兜底（对齐原 L454 shutil.which('ffmpeg')）
  const r3 = await detectFfmpegPath({
    resourcesPath: '', studioRoot: '',
    fs: mk(new Set()), path: { join: joinWin },
    which: async () => 'C:\\Windows\\System32\\ffmpeg.exe',
  })
  assert.equal(r3.ok, true)
  assert.match(r3.path, /ffmpeg\.exe/)

  // 4. 全缺失 → ok:false（对应 UI bad 行「未检测到 ffmpeg.exe」）
  const r4 = await detectFfmpegPath({
    resourcesPath: '', studioRoot: '',
    fs: mk(new Set()), path: { join: joinWin },
    which: async () => '',
  })
  assert.equal(r4.ok, false)
})

test('detectLocalResources：os/cpu/ram 编组 + statfs 正常/异常两分支', async () => {
  const { detectLocalResources } = await loadEnvDetect()
  const fakeFs = { existsSync: () => false }
  const fakeOs = {
    version: () => 'Windows 11 Pro',
    cpus: () => Array.from({ length: 16 }, () => ({ model: 'Intel Core i7' })),
    totalmem: () => 32 * 1024 ** 3,
    platform: () => 'win32',
    release: () => '10.0.22631',
  }

  // statfs 正常（注入 which='' 隔离真机 PATH，保持ffmpeg断言确定性）
  const ok = await detectLocalResources({
    os: fakeOs, fs: fakeFs, which: async () => '',
    statPath: 'C:/Users/x/AppData/Roaming/tintin',
    statfs: async () => ({ bsize: 4096, blocks: 125_000_000, bavail: 31_000_000 }),
  })
  assert.equal(ok.os, 'Windows 11 Pro')
  assert.match(ok.cpu, /Intel Core i7/)
  assert.match(ok.cpu, /16/)
  assert.equal(ok.ramGb, 32)
  assert.ok(ok.disk && ok.disk.freeGb > 100, 'freeGb = bavail*bsize/2^30 ≈ 118.3')

  // statfs 抛错（旧内核/路径不可用）→ disk=null（UI unknown 行）
  const bad = await detectLocalResources({
    os: fakeOs, fs: fakeFs, which: async () => '',
    statPath: 'C:/nonexistent',
    statfs: async () => { throw new Error('EPERM') },
  })
  assert.equal(bad.disk, null)
  assert.equal(bad.ffmpeg.ok, false, '无注入 which 且 existsSync=false → 未找到')
})
