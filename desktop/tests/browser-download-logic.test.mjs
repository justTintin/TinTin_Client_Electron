// ══════════════════════════════════════════════════════════════
// browser-download-logic.test.mjs — 浏览器页面解析下载·纯函数单测
// （2026-09-01 用户反馈：视频详情页点「页面解析下载」却把抖音首页 URL
// 传给了 yt-dlp → Unsupported URL exit 1。根因：addressUrl（地址栏值）
// 在 SPA 页内路由时可能滞后/未同步，改为 webview 实际 URL 优先）
// 运行：node --test "tests/*.test.mjs"
// ══════════════════════════════════════════════════════════════
import { test } from 'node:test'
import assert from 'node:assert/strict'

const M = await import('../renderer/src/browser/composables/browserDownloadLogic.ts')

// ── pickPageDownloadUrl：实际 URL 优先 + 平台根路径拒绝 ──

test('pickPageDownloadUrl：webview 实际 URL 优先于地址栏值（SPA 地址栏滞后修复）', () => {
  const r = M.pickPageDownloadUrl('https://www.douyin.com/video/7345678901234567890', 'https://www.douyin.com')
  assert.equal(r.ok, true)
  assert.equal(r.url, 'https://www.douyin.com/video/7345678901234567890')
})

test('pickPageDownloadUrl：实际 URL 拿不到时回退地址栏值（视频页则可用）', () => {
  const r = M.pickPageDownloadUrl(null, 'https://www.douyin.com/video/7345678901234567890')
  assert.equal(r.ok, true)
  assert.equal(r.url, 'https://www.douyin.com/video/7345678901234567890')
})

test('pickPageDownloadUrl：两者都是平台根路径 → 拒绝并提示进入视频页', () => {
  for (const real of [null, 'https://www.douyin.com']) {
    const r = M.pickPageDownloadUrl(real, 'https://www.douyin.com')
    assert.equal(r.ok, false)
    assert.match(r.reason, /视频播放页/)
  }
})

test('pickPageDownloadUrl：实际 URL 是详情页而地址栏是根路径 → 用实际 URL 不误拒', () => {
  const r = M.pickPageDownloadUrl('https://www.douyin.com/note/7300000000000000000', 'https://www.douyin.com')
  assert.equal(r.ok, true)
  assert.equal(r.url, 'https://www.douyin.com/note/7300000000000000000')
})

test('pickPageDownloadUrl：B站/快手/小红书视频页同样放行，根路径同样拒绝', () => {
  assert.equal(M.pickPageDownloadUrl(null, 'https://www.bilibili.com/video/BV1xx411c7mD').ok, true)
  assert.equal(M.pickPageDownloadUrl(null, 'https://www.kuaishou.com').ok, false)
  assert.equal(M.pickPageDownloadUrl(null, 'https://www.xiaohongshu.com/explore/65abcdef0000000000000000').ok, true)
  assert.equal(M.pickPageDownloadUrl(null, 'https://www.youtube.com/watch?v=abc123').ok, true)
})
