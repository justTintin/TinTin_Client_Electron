// ═══════════════════════════════════════════════════════════════
// daily-assets.test.mjs — B9 每日素材单测（日期分组 + 筛选 + 预览类型）
// 运行：node --test "tests/*.test.mjs"
// 对照基准（以原代码为准）：
//   · apps/asset-browser/main.js L766-818 `get-daily-assets`：
//     按 YYYY-MM-DD 日期目录扫描下载目录，忽略 .tmp/.cookies.txt，
//     按 video/image/text/file 分类，日期降序分组
//   · apps/asset-browser/renderer/app.js L2273-2312 getFilteredDailyMaterials：
//     日期/类型/搜索/排序 四维筛选
//   · 原版 L2314-2338 _buildMaterialPreviewHtml：视频找同名 cover 封面
// ═══════════════════════════════════════════════════════════════

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

// 主进程扫描（CJS named exports）
const { classifyFileType, scanDailyAssets } = await import('../main/daily-assets.js')
// 前端纯函数（TS 直接加载）
const R = await import('../renderer/src/browser/logic/dailyAssets.ts')

/** 建临时下载目录（返回目录路径，用后删除） */
function makeTmpDirs() {
  const root = mkdtempSync(join(tmpdir(), 'tintin-daily-assets-'))
  const dl = join(root, 'downloads')
  mkdirSync(join(dl, '2026-08-02'), { recursive: true })
  mkdirSync(join(dl, '2026-08-01'), { recursive: true })
  writeFileSync(join(dl, '2026-08-01', 'a.mp4'), 'x'.repeat(100))
  writeFileSync(join(dl, '2026-08-01', 'b.jpg'), 'x'.repeat(50))
  writeFileSync(join(dl, '2026-08-01', 'c.txt'), 'hello')
  writeFileSync(join(dl, '2026-08-01', 'd.tmp'), 'tmp')            // 应忽略
  writeFileSync(join(dl, '2026-08-01', 'e.cookies.txt'), 'c')      // 应忽略
  writeFileSync(join(dl, '2026-08-02', 'f.mp4'), 'x'.repeat(200))
  // 非日期目录不入组
  mkdirSync(join(dl, 'misc'), { recursive: true })
  writeFileSync(join(dl, 'misc', 'g.mp4'), 'x')
  return { root, dl }
}

// ── classifyFileType（对照原版 _classifyFileType L656-665）──

test('classifyFileType：video/image/text/file 四分类', () => {
  assert.equal(classifyFileType('a.mp4'), 'video')
  assert.equal(classifyFileType('a.MKV'), 'video')   // 大小写不敏感
  assert.equal(classifyFileType('b.jpg'), 'image')
  assert.equal(classifyFileType('c.txt'), 'text')
  assert.equal(classifyFileType('d.json'), 'text')
  assert.equal(classifyFileType('e.zip'), 'file')
  assert.equal(classifyFileType(''), 'file')
})

// ── scanDailyAssets（对照原版 get-daily-assets L766-818）──

test('scanDailyAssets：按 YYYY-MM-DD 分组降序 + 类型分类 + 忽略 tmp/cookies', () => {
  const { root, dl } = makeTmpDirs()
  try {
    const groups = scanDailyAssets([dl])
    assert.equal(groups.length, 2)
    assert.equal(groups[0].date, '2026-08-02') // 降序
    assert.equal(groups[1].date, '2026-08-01')

    const d1 = groups[1].files
    assert.equal(d1.length, 3) // tmp/cookies 被忽略
    const byName = Object.fromEntries(d1.map((f) => [f.name, f]))
    assert.equal(byName['a.mp4'].type, 'video')
    assert.equal(byName['b.jpg'].type, 'image')
    assert.equal(byName['c.txt'].type, 'text')
    assert.equal(byName['a.mp4'].size, 100)
    assert.equal(groups[0].files[0].type, 'video')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('scanDailyAssets：多目录去重（同路径只收一次）', () => {
  const { root, dl } = makeTmpDirs()
  try {
    const groups = scanDailyAssets([dl, dl]) // 重复目录
    assert.equal(groups.length, 2)
    assert.equal(groups[0].files.length, 1) // 去重后无重复
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('scanDailyAssets：目录不存在/空数组安全返回 []', () => {
  assert.deepEqual(scanDailyAssets([]), [])
  assert.deepEqual(scanDailyAssets([join(tmpdir(), 'not-exist-tintin-xyz')]), [])
})

// ── filterDailyAssets（对照原版 getFilteredDailyMaterials L2273-2312）──

const SAMPLE_GROUPS = [
  { date: '2026-08-01', files: [
    { name: 'alpha.mp4', path: 'D:/dl/2026-08-01/alpha.mp4', size: 200, type: 'video' },
    { name: 'beta.jpg',  path: 'D:/dl/2026-08-01/beta.jpg',  size: 100, type: 'image' },
  ] },
  { date: '2026-08-02', files: [
    { name: 'gamma.mp4', path: 'D:/dl/2026-08-02/gamma.mp4', size: 300, type: 'video' },
  ] },
]

test('filterDailyAssets：日期精确筛选（对照 dateVal !== all）', () => {
  const out = R.filterDailyAssets(SAMPLE_GROUPS, { date: '2026-08-01' })
  assert.equal(out.length, 1)
  assert.equal(out[0].date, '2026-08-01')
  assert.equal(out[0].files.length, 2)
})

test('filterDailyAssets：类型筛选（video）', () => {
  const out = R.filterDailyAssets(SAMPLE_GROUPS, { type: 'video' })
  assert.equal(out.length, 2)
  assert.equal(out[0].files.length, 1) // 08-02 只剩 gamma
  assert.equal(out[0].files[0].type, 'video')
})

test('filterDailyAssets：搜索 name/path 子串（不区分大小写）', () => {
  const out = R.filterDailyAssets(SAMPLE_GROUPS, { query: 'BETA' })
  assert.equal(out.length, 1)
  assert.equal(out[0].files[0].name, 'beta.jpg')
  const byPath = R.filterDailyAssets(SAMPLE_GROUPS, { query: '2026-08-02' })
  assert.equal(byPath.length, 1)
  assert.equal(byPath[0].files[0].name, 'gamma.mp4')
})

test('filterDailyAssets：排序 size_desc / name_asc / type_asc', () => {
  const g = [{ date: '2026-08-01', files: [
    { name: 'b.mp4', path: 'p/b.mp4', size: 100, type: 'video' },
    { name: 'a.jpg', path: 'p/a.jpg', size: 300, type: 'image' },
  ] }]
  const bySize = R.filterDailyAssets(g, { sort: 'size_desc' })
  assert.equal(bySize[0].files[0].name, 'a.jpg')
  const byName = R.filterDailyAssets(g, { sort: 'name_asc' })
  assert.equal(byName[0].files[0].name, 'a.jpg')
  const byType = R.filterDailyAssets(g, { sort: 'type_asc' })
  assert.equal(byType[0].files[0].type, 'image') // image < video
})

test('filterDailyAssets：组间日期排序 date_asc 升序 / 缺省降序', () => {
  const asc = R.filterDailyAssets(SAMPLE_GROUPS, { sort: 'date_asc' })
  assert.equal(asc[0].date, '2026-08-01')
  const desc = R.filterDailyAssets(SAMPLE_GROUPS)
  assert.equal(desc[0].date, '2026-08-02')
})

test('filterDailyAssets：筛选后空组剔除', () => {
  const out = R.filterDailyAssets(SAMPLE_GROUPS, { query: 'no-such-file' })
  assert.deepEqual(out, [])
  assert.deepEqual(R.filterDailyAssets(null), [])
})

// ── formatBytes（对照原版 formatBytes）──

test('formatBytes：B/KB/MB/GB 格式化', () => {
  assert.equal(R.formatBytes(512), '512 B')
  assert.equal(R.formatBytes(2048), '2.0 KB')
  assert.equal(R.formatBytes(5 * 1024 * 1024), '5.0 MB')
  assert.equal(R.formatBytes(2 * 1024 * 1024 * 1024), '2.0 GB')
  assert.equal(R.formatBytes(0), '0 B')
  assert.equal(R.formatBytes(undefined), '0 B')
})

// ── buildMaterialPreviewType（对照原版 _buildMaterialPreviewHtml L2314-2338）──

test('buildMaterialPreviewType：视频同名 cover 图 → video-cover', () => {
  const group = [
    { name: 'clip.mp4', path: 'p/clip.mp4', size: 1, type: 'video' },
    { name: 'clip_cover.jpg', path: 'p/clip_cover.jpg', size: 1, type: 'image' },
  ]
  assert.equal(R.buildMaterialPreviewType(group[0], group), 'video-cover')
})

test('buildMaterialPreviewType：视频无 cover → video；image/text/file', () => {
  const group = [
    { name: 'clip.mp4', path: 'p/clip.mp4', size: 1, type: 'video' },
    { name: 'cover2.jpg', path: 'p/cover2.jpg', size: 1, type: 'image' }, // 前缀不匹配
  ]
  assert.equal(R.buildMaterialPreviewType(group[0], group), 'video')
  assert.equal(R.buildMaterialPreviewType(group[1], group), 'image')
  assert.equal(R.buildMaterialPreviewType({ name: 'n.txt', path: 'p', size: 1, type: 'text' }, null), 'text')
  assert.equal(R.buildMaterialPreviewType({ name: 'n.zip', path: 'p', size: 1, type: 'file' }, null), 'file')
})

test('assetTypeBadge：徽标文案/类名对照原版', () => {
  assert.deepEqual(R.assetTypeBadge('video'), { text: '视频', cls: 'video' })
  assert.deepEqual(R.assetTypeBadge('image'), { text: '图片', cls: 'image' })
  assert.deepEqual(R.assetTypeBadge('text'), { text: '图文', cls: 'text' })
  assert.deepEqual(R.assetTypeBadge('file'), { text: '文件', cls: 'file' })
})
