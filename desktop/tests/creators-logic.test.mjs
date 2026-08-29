// ═══════════════════════════════════════════════════════════════
// creators-logic.test.mjs — B10 达人/创作者库单测（增删去重 + 主页推导
//   + 采集清单编组）
// 运行：node --test "tests/*.test.mjs"
// 对照基准（以原代码为准）：
//   · apps/asset-browser/main.js L543-564 creators DB：
//       db-add-creator（id+platform 去重）/ db-delete-creator（同键过滤）
//   · apps/asset-browser/renderer/app.js L1258-1312 collectAllFromCreator：
//       无主页 URL 时按平台从名称推导主页搜索地址
//   · 采集清单（新客户端）：落 userData/creators/collected.json，
//     前端 groupCollectedItems 按日期/按达人编组展示
// ═══════════════════════════════════════════════════════════════

import { test } from 'node:test'
import assert from 'node:assert/strict'

// 主进程存储纯函数（CJS named exports）
const {
  addCreator,
  deleteCreator,
  dedupeCollectedItems,
  deriveProfileUrl,
  VIDEO_LINK_PATTERNS,
  extractLinksScript,
} = await import('../main/creators-store.js')
// 前端纯函数（TS 直接加载）
const R = await import('../renderer/src/browser/logic/creators.ts')

// ── addCreator / deleteCreator（对照原 db-add-creator / db-delete-creator）──

test('addCreator：新增达人（id+platform 唯一键，新条目在前）', () => {
  const list = addCreator([], { id: 'u1', platform: 'douyin', name: '达人A' })
  assert.equal(list.length, 1)
  assert.equal(list[0].id, 'u1')
  assert.equal(list[0].platform, 'douyin')
  assert.equal(list[0].name, '达人A')
})

test('addCreator：id+platform 重复不追加（对照原版 exists 检查）', () => {
  const list = addCreator(
    [{ id: 'u1', platform: 'douyin', name: '达人A', addedAt: 1 }],
    { id: 'u1', platform: 'douyin', name: '达人A2' }
  )
  assert.equal(list.length, 1) // 不追加
  // 同 id 不同平台 → 允许（对照原版 id && platform 双条件）
  const two = addCreator(list, { id: 'u1', platform: 'bilibili', name: '达人A' })
  assert.equal(two.length, 2)
})

test('addCreator：缺 id/platform 不入库', () => {
  assert.deepEqual(addCreator([], { name: '无名' }), [])
  assert.deepEqual(addCreator([], null), [])
})

test('deleteCreator：按 id+platform 过滤（对照原 db-delete-creator）', () => {
  const list = [
    { id: 'u1', platform: 'douyin', name: 'A' },
    { id: 'u1', platform: 'bilibili', name: 'B' },
    { id: 'u2', platform: 'douyin', name: 'C' },
  ]
  const out = deleteCreator(list, { id: 'u1', platform: 'douyin' })
  assert.equal(out.length, 2)
  assert.ok(!out.some((c) => c.id === 'u1' && c.platform === 'douyin'))
  assert.ok(out.some((c) => c.id === 'u1' && c.platform === 'bilibili')) // 其他平台保留
})

// ── dedupeCollectedItems（采集链接去重）──

test('dedupeCollectedItems：platform|url 键去重', () => {
  const items = [
    { platform: 'douyin', url: 'https://www.douyin.com/video/1' },
    { platform: 'douyin', url: 'https://www.douyin.com/video/1' }, // 重复
    { platform: 'douyin', url: 'https://www.douyin.com/video/2' },
    { platform: 'bilibili', url: 'https://www.douyin.com/video/1' }, // 不同平台同 url → 保留
  ]
  const out = dedupeCollectedItems(items)
  assert.equal(out.length, 3)
})

// ── deriveProfileUrl（对照原 collectAllFromCreator L1271-1290 平台推导）──

test('deriveProfileUrl：douyin/bilibili/xiaohongshu/youtube 平台搜索页推导', () => {
  assert.equal(deriveProfileUrl('张三', 'douyin'), 'https://www.douyin.com/search/%E5%BC%A0%E4%B8%89?type=user')
  assert.ok(deriveProfileUrl('up主', 'bilibili').includes('search.bilibili.com/upuser?keyword='))
  assert.ok(deriveProfileUrl('博主', 'xiaohongshu').includes('xiaohongshu.com/search_result?keyword='))
  assert.ok(deriveProfileUrl('creator', 'youtube').includes('youtube.com/results?search_query=creator'))
})

test('deriveProfileUrl：新平台推断 + 兜底 douyin 搜索（对照原版 else 分支）', () => {
  assert.ok(deriveProfileUrl('快手达人', 'kuaishou').includes('kuaishou.com/search/video'))
  assert.ok(deriveProfileUrl('X', 'unknown').includes('douyin.com/search/X?type=user'))
})

// ── 采集链接特征 + 提取脚本 ──

test('VIDEO_LINK_PATTERNS：主流平台视频链接特征齐备（主页 DOM 采集用）', () => {
  assert.ok(VIDEO_LINK_PATTERNS.douyin.length > 0)
  assert.ok(VIDEO_LINK_PATTERNS.bilibili.length > 0)
  assert.ok(VIDEO_LINK_PATTERNS.xiaohongshu.length > 0)
  assert.ok(VIDEO_LINK_PATTERNS.youtube.length > 0)
  assert.ok(VIDEO_LINK_PATTERNS.kuaishou.length > 0)
  assert.ok(VIDEO_LINK_PATTERNS.weixin.length > 0)
})

test('extractLinksScript：注入平台正则（douyin 含 video 与 note 特征）', () => {
  const script = extractLinksScript('douyin')
  // 正则 .source 经 JSON 序列化注入（含转义），验证关键词与 patterns 结构
  assert.ok(script.includes('video'))
  assert.ok(script.includes('note'))
  assert.ok(script.includes('patterns'))
})

// ── groupCollectedItems（B10 采集清单编组；前端 TS）──

const COLLECTED = [
  { platform: 'douyin', creatorId: 'u1', creatorName: '达人A', title: 'v1', url: 'u1', source: 's', date: '2026-08-02', collectedAt: 't1' },
  { platform: 'douyin', creatorId: 'u1', creatorName: '达人A', title: 'v2', url: 'u2', source: 's', date: '2026-08-01', collectedAt: 't2' },
  { platform: 'bilibili', creatorId: 'u2', creatorName: '达人B', title: 'v3', url: 'u3', source: 's', date: '2026-08-02', collectedAt: 't3' },
]

test('groupCollectedItems：按日期编组降序（组内保持采集顺序）', () => {
  const groups = R.groupCollectedItems(COLLECTED, 'date')
  assert.equal(groups.length, 2)
  assert.equal(groups[0].key, '2026-08-02')
  assert.equal(groups[0].items.length, 2)
  assert.equal(groups[1].key, '2026-08-01')
  assert.equal(groups[1].items.length, 1)
})

test('groupCollectedItems：按达人编组名称升序', () => {
  const groups = R.groupCollectedItems(COLLECTED, 'creator')
  assert.equal(groups.length, 2)
  assert.equal(groups[0].key, '达人A')
  assert.equal(groups[0].items.length, 2)
  assert.equal(groups[1].key, '达人B')
})

test('groupCollectedItems：缺省按日期；空/null 安全返回 []', () => {
  assert.equal(R.groupCollectedItems(COLLECTED)[0].key, '2026-08-02')
  assert.deepEqual(R.groupCollectedItems(null), [])
  assert.deepEqual(R.groupCollectedItems([], 'creator'), [])
})

// ── filterCreators（达人列表搜索）──

test('filterCreators：名称/平台/主页子串搜索（不区分大小写）', () => {
  const list = [
    { id: 'u1', platform: 'douyin', name: '张三', homepageUrl: 'https://www.douyin.com/user/abc' },
    { id: 'u2', platform: 'bilibili', name: '李四' },
  ]
  assert.equal(R.filterCreators(list, '张三').length, 1)
  assert.equal(R.filterCreators(list, 'BILI').length, 1)
  assert.equal(R.filterCreators(list, 'abc').length, 1)
  assert.equal(R.filterCreators(list, '').length, 2)
  assert.equal(R.filterCreators(null, 'x').length, 0)
})

// ── platformDisplayName ──

test('platformDisplayName：平台中文名映射', () => {
  assert.equal(R.platformDisplayName('douyin'), '抖音')
  assert.equal(R.platformDisplayName('bilibili'), 'B站')
  assert.equal(R.platformDisplayName('youtube'), 'YouTube')
  assert.equal(R.platformDisplayName('unknown'), 'unknown')
})

// ── B8 入库状态标注（importStatusMeta / importResultMessage）──

test('importStatusMeta：submitted=待处理 / imported=已入库 / failed=失败 / 空=无标记', () => {
  assert.deepEqual(R.importStatusMeta('submitted'), { text: '待处理', cls: 'pending' })
  assert.deepEqual(R.importStatusMeta('imported'), { text: '已入库', cls: 'done' })
  assert.deepEqual(R.importStatusMeta('failed'), { text: '失败', cls: 'fail' })
  assert.deepEqual(R.importStatusMeta(undefined), { text: '', cls: '' })
  assert.deepEqual(R.importStatusMeta(''), { text: '', cls: '' })
})

test('importResultMessage：提交/失败/去重/无链接 汇总 + 失败原因透出', () => {
  assert.equal(R.importResultMessage({ submitted: 3 }), '已提交 3 条')
  assert.equal(
    R.importResultMessage({ submitted: 2, failed: 1, duplicates: 1, noUrl: 1 }),
    '已提交 2 条，失败 1 条，去重 1 条，无链接 1 条'
  )
  assert.match(
    R.importResultMessage({ submitted: 1, failed: 1, firstError: '服务端返回 503' }),
    /服务端返回 503/
  )
  assert.equal(R.importResultMessage(null), '入库失败')
  assert.equal(R.importResultMessage(undefined), '入库失败')
})
