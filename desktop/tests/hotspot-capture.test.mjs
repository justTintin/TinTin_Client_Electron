// ═══════════════════════════════════════════════════════════════
// hotspot-capture.test.mjs — 热点采集纯函数单测（P4 补齐）
// 运行：node --test tests/
// 对照基准：原版 apps/asset-browser/preload-webview.js L1188+（四平台
//   API 拦截解析）+ renderer/app.js HOTSPOT_PAGES/_hotspotDomScript +
//   main.js append-hotspot-manifest（追加 + date）
// ═══════════════════════════════════════════════════════════════

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import {
  HOTSPOT_PAGES,
  parseHotspotPayload,
  domFallbackScript,
  appendHotspotManifest,
  hotspotManifestPath,
} from '../main/hotspot-capture.js'

// ── HOTSPOT_PAGES：对照原版（zhihu 已隐藏）──
test('HOTSPOT_PAGES 对照原版：douyin/xiaohongshu/bilibili 三平台', () => {
  assert.deepEqual(HOTSPOT_PAGES, [
    { platform: 'douyin', url: 'https://www.douyin.com/hot' },
    { platform: 'xiaohongshu', url: 'https://www.xiaohongshu.com/explore' },
    { platform: 'bilibili', url: 'https://www.bilibili.com/v/popular/rank/all' },
  ])
})

// ── 抖音：aweme/v1/web/hot/search/list ──
test('parseHotspotPayload 抖音 word_list → platform=douyin + rank + 搜索链接', () => {
  const url = 'https://www.douyin.com/aweme/v1/web/hot/search/list/?device_platform=webapp'
  const payload = { data: { word_list: [
    { word: '热点甲', hot_value: 987654, position: 0 },
    { word: '热点乙', hot_value: 12345 },
    { word: '', hot_value: 1 }, // 空标题应被过滤
  ] } }
  const items = parseHotspotPayload(url, payload)
  assert.equal(items.length, 2)
  assert.equal(items[0].platform, 'douyin')
  assert.equal(items[0].title, '热点甲')
  assert.equal(items[0].rank, 1) // position+1 对照原版
  assert.equal(items[0].hot, 987654)
  assert.ok(items[0].url.includes('douyin.com/search/'))
  assert.equal(items[1].rank, 2) // 无 position 时回退 i+1
})

// ── 知乎：feed/topstory/hot-lists（页面已隐藏，解析保留对照）──
test('parseHotspotPayload 知乎 hot-lists → question 链接', () => {
  const url = 'https://www.zhihu.com/api/v3/feed/topstory/hot-lists/total?limit=50'
  const payload = { data: [
    { target: { id: 123, title: '如何看待事件A' }, detail_text: '500 万热度' },
  ] }
  const items = parseHotspotPayload(url, payload)
  assert.equal(items.length, 1)
  assert.equal(items[0].platform, 'zhihu')
  assert.equal(items[0].url, 'https://www.zhihu.com/question/123')
  assert.equal(items[0].hot, '500 万热度')
})

// ── 小红书：sns/web/v1/search/hot ──
test('parseHotspotPayload 小红书 items → keyword 搜索链接', () => {
  const url = 'https://edith.xiaohongshu.com/api/sns/web/v1/search/hotlist'
  const payload = { data: { items: [
    { title: '新品测评', score: 88 },
    { query: '好物推荐' },
  ] } }
  const items = parseHotspotPayload(url, payload)
  assert.equal(items.length, 2)
  assert.equal(items[0].platform, 'xiaohongshu')
  assert.ok(items[0].url.includes('xiaohongshu.com/search_result'))
  assert.equal(items[1].title, '好物推荐')
})

// ── B站：x/web-interface/ranking / popular ──
test('parseHotspotPayload B站 list → bvid 链接 + 万播放格式化', () => {
  const url = 'https://api.bilibili.com/x/web-interface/ranking/v2'
  const payload = { data: { list: [
    { title: '视频A', bvid: 'BV1xx', stat: { view: 250000 } },
    { title: '视频B', bvid: 'BV2yy', stat: { view: 4200 } },
  ] } }
  const items = parseHotspotPayload(url, payload)
  assert.equal(items.length, 2)
  assert.equal(items[0].platform, 'bilibili')
  assert.equal(items[0].hot, '25.0万播放') // 对照原版 >=10000 → 万播放
  assert.equal(items[1].hot, '4200播放')
  assert.equal(items[0].url, 'https://www.bilibili.com/video/BV1xx')
})

// ── 未命中 URL / 非法 payload ──
test('parseHotspotPayload 未命中热榜 API 返回空数组', () => {
  assert.deepEqual(parseHotspotPayload('https://example.com/api', { data: {} }), [])
  assert.deepEqual(parseHotspotPayload('https://api.bilibili.com/x/web-interface/ranking/v2', null), [])
})

// ── DOM 兜底（对照原版：仅 xiaohongshu 有脚本，douyin/bilibili 靠 API）──
test('domFallbackScript 仅 xiaohongshu 返回采集脚本，其余 null', () => {
  assert.notEqual(domFallbackScript('xiaohongshu'), 'null')
  assert.ok(domFallbackScript('xiaohongshu').includes('/explore/'))
  assert.equal(domFallbackScript('douyin'), 'null')
  assert.equal(domFallbackScript('bilibili'), 'null')
})

// ── 清单追加（对照原版 append-hotspot-manifest）──
test('appendHotspotManifest 追加条目带日期 + 再次追加累积合并', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tintin-hotspot-'))
  try {
    const r1 = appendHotspotManifest(dir, [{ platform: 'douyin', title: 'T1', rank: 1, hot: 1, url: 'u' }])
    assert.equal(r1.ok, true)
    assert.equal(r1.count, 1)
    assert.match(r1.date, /^\d{4}-\d{2}-\d{2}$/)
    appendHotspotManifest(dir, [{ platform: 'bilibili', title: 'T2', rank: 1, hot: '', url: '' }])
    const arr = JSON.parse(readFileSync(hotspotManifestPath(dir), 'utf-8'))
    assert.equal(arr.length, 2)
    assert.ok(arr.every((x) => /^\d{4}-\d{2}-\d{2}$/.test(x.date)), '每条都应带 date 字段')
    assert.equal(arr[1].platform, 'bilibili')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('appendHotspotManifest 空条目返回 count=0 且不落盘', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tintin-hotspot-'))
  try {
    const r = appendHotspotManifest(dir, [])
    assert.equal(r.ok, true)
    assert.equal(r.count, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
