// ══════════════════════════════════════════════════════════════
// platform-meta-detail.test.mjs — 平台详情页白名单判定·纯函数单测
// （2026-09-02 用户反馈：抖音精选/推荐流里弹层播放视频，右侧嗅探不到。
//   根因：抖音是 SPA，feed 内点开视频走弹层播放，URL 停留在
//   /jingxuan /discover（或仅追加 ?modal_id=），不会变成 /video/\d+，
//   主进程把所有媒体请求判为 NOT_DETAIL_PAGE 全部跳过）
// 运行：node --test "tests/*.test.mjs"
// ══════════════════════════════════════════════════════════════
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { isDetailPage, PLATFORM_DETAIL_PATTERNS } = await import('../main/platform-meta.js')

test('douyin 裸 feed 路径不是详情页，不嗅探（防预加载视频刷屏，2026-09-02 用户反馈）', () => {
  assert.equal(isDetailPage('https://www.douyin.com/jingxuan', 'douyin'), false)
  assert.equal(isDetailPage('https://www.douyin.com/discover', 'douyin'), false)
  assert.equal(isDetailPage('https://www.douyin.com/follow', 'douyin'), false)
})

test('douyin feed 弹层详情页（带 modal_id）应视为详情页可嗅探', () => {
  assert.equal(
    isDetailPage('https://www.douyin.com/jingxuan?modal_id=7345678901234567890', 'douyin'),
    true,
  )
  assert.equal(
    isDetailPage('https://www.douyin.com/discover?modal_id=7345678901234567890', 'douyin'),
    true,
  )
})

test('douyin 经典视频页 /video/\\d+ 保持可嗅探（回归）', () => {
  assert.equal(isDetailPage('https://www.douyin.com/video/7345678901234567890', 'douyin'), true)
  assert.equal(isDetailPage('https://www.douyin.com/note/7345678901234567890', 'douyin'), true)
})

test('douyin 首页与搜索页仍不嗅探（防列表页视频缩略图误触发）', () => {
  assert.equal(isDetailPage('https://www.douyin.com', 'douyin'), false)
  assert.equal(isDetailPage('https://www.douyin.com/search/%E7%9F%A5%E5%90%A6', 'douyin'), false)
  assert.equal(isDetailPage('', 'douyin'), false)
})

test('bilibili 详情页模式不受本轮改动影响（回归）', () => {
  assert.equal(isDetailPage('https://www.bilibili.com/video/BV1xx411c7mD', 'bilibili'), true)
  assert.equal(isDetailPage('https://www.bilibili.com', 'bilibili'), false)
})

test('douyin 白名单必须包含 modal_id 弹层模式（防止被误删）', () => {
  const pats = PLATFORM_DETAIL_PATTERNS.douyin.map((p) => p.source)
  assert.ok(pats.some((s) => s.includes('modal_id')), '缺 modal_id 模式')
  assert.ok(!pats.some((s) => s.includes('jingxuan')), '裸 feed 路径不应入白名单')
})
