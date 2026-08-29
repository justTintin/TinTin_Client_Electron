// ═══════════════════════════════════════════════════════════════
// material-import.test.mjs — B8 素材入库编组纯函数单测（先红后绿）
//   采集条目 → /material/web_download 请求体组包、去重、状态标注、
//   每日素材本地文件反查来源 URL、enqueue_analysis 分析队列组包
// 运行：node --test "tests/*.test.mjs"
// 契约依据（openapi-latest.json）：
//   · DownloadRequest：{ url: string(5..1000, 必填), format?, cookies_file?,
//       proxy?, max_filesize? (int>=0, 0=500MB), share_name? (默认 "web_download") }
//   · /material/web_download → POST 单条 url，返回异步任务（轮询
//     /material/web_download/{task_id}）
//   · /material/enqueue_analysis → 按筛选条件批量入 AI 分析队列（默认
//     ai_status=pending，返回匹配总数 + task_id）
// ═══════════════════════════════════════════════════════════════

import { test } from 'node:test'
import assert from 'node:assert/strict'

const M = await import('../main/material-import.js')

// ── buildDownloadRequest：采集条目 → web_download 请求体（契约组包）──

test('buildDownloadRequest：合法采集条目 → DownloadRequest（url 必填 + share_name 默认 web_download）', () => {
  const item = {
    platform: 'douyin',
    creatorId: 'u1',
    creatorName: '达人A',
    title: '爆款视频',
    url: 'https://www.douyin.com/video/123456',
    source: 'https://www.douyin.com/user/u1',
    date: '2026-08-28',
    collectedAt: '2026-08-28T10:00:00.000Z',
  }
  const req = M.buildDownloadRequest(item)
  assert.ok(req, '应返回请求体')
  assert.equal(req.url, 'https://www.douyin.com/video/123456')
  assert.equal(req.share_name, 'web_download') // 契约默认值
})

test('buildDownloadRequest：opts 覆盖 share_name / max_filesize / format', () => {
  const req = M.buildDownloadRequest(
    { url: 'https://www.bilibili.com/video/BV1xx411c7mD', title: 'B站视频' },
    { shareName: 'creators_collect', maxFilesize: 100 * 1024 * 1024, format: 'bestvideo+bestaudio' }
  )
  assert.equal(req.share_name, 'creators_collect')
  assert.equal(req.max_filesize, 100 * 1024 * 1024)
  assert.equal(req.format, 'bestvideo+bestaudio')
  // 契约允许的字段边界（int>=0）
  assert.equal(M.buildDownloadRequest({ url: 'https://a.b/v' }, { maxFilesize: 0 }).max_filesize, 0)
})

test('buildDownloadRequest：非法 url（缺失/非 http/https/过短/超长）→ null', () => {
  assert.equal(M.buildDownloadRequest(null), null)
  assert.equal(M.buildDownloadRequest({}), null)
  assert.equal(M.buildDownloadRequest({ url: '' }), null)
  assert.equal(M.buildDownloadRequest({ url: 'file:///C:/x.mp4' }), null) // 本地路径非 http
  assert.equal(M.buildDownloadRequest({ url: 'abcd' }), null)            // 长度 < 5 且非 URL
  const longUrl = 'https://example.com/' + 'x'.repeat(1100)
  assert.equal(M.buildDownloadRequest({ url: longUrl }), null)            // 超 maxLength 1000
})

// ── dedupeImportItems：按 url 去重（保留首个）──

test('dedupeImportItems：url 键去重保留首个', () => {
  const items = [
    { url: 'https://a.com/v1', title: '第一个' },
    { url: 'https://a.com/v1', title: '第二个' }, // 重复
    { url: 'https://a.com/v2', title: '第三个' },
  ]
  const out = M.dedupeImportItems(items)
  assert.equal(out.length, 2)
  assert.equal(out[0].title, '第一个')
  assert.deepEqual(M.dedupeImportItems(null), [])
})

// ── splitImportItems：pending / duplicates / noUrl 三分 ──

test('splitImportItems：有 url / 重复 / 无 url 三类分组', () => {
  const items = [
    { url: 'https://a.com/v1', title: 'A' },
    { url: 'https://a.com/v1', title: 'A重复' },  // duplicates
    { url: 'https://a.com/v2', title: 'B' },
    { title: '本地文件无 url' },                    // noUrl
    { url: 'bad', title: '非法 url' },             // noUrl（非 http）
  ]
  const { pending, duplicates, noUrl } = M.splitImportItems(items)
  assert.equal(pending.length, 2)
  assert.equal(pending[0].title, 'A')
  assert.equal(pending[1].title, 'B')
  assert.equal(duplicates.length, 1)
  assert.equal(duplicates[0].title, 'A重复')
  assert.equal(noUrl.length, 2)
  assert.deepEqual(M.splitImportItems([]), { pending: [], duplicates: [], noUrl: [] })
})

// ── markCollectedImported：状态标注（待处理/失败+原因）──

test('markCollectedImported：提交成功 → submitted + importTaskId；失败 → failed + 原因', () => {
  const items = [
    { url: 'https://a.com/v1', title: 'A' },
    { url: 'https://a.com/v2', title: 'B' },
    { url: 'https://a.com/v3', title: 'C' },
  ]
  const results = [
    { url: 'https://a.com/v1', taskId: 'wd_111' },
    { url: 'https://a.com/v2', error: 'HTTP 503 服务不可用' },
    // v3 无结果 → 保持原样（未提交）
  ]
  const out = M.markCollectedImported(items, results)
  const byUrl = (u) => out.find((x) => x.url === u)
  assert.equal(byUrl('https://a.com/v1').importStatus, 'submitted')          // 待处理（异步下载中）
  assert.equal(byUrl('https://a.com/v1').importTaskId, 'wd_111')
  assert.equal(byUrl('https://a.com/v1').importedAt, undefined)              // 提交时间由调用方写入
  assert.equal(byUrl('https://a.com/v2').importStatus, 'failed')             // 失败 + 原因
  assert.equal(byUrl('https://a.com/v2').importError, 'HTTP 503 服务不可用')
  assert.equal(byUrl('https://a.com/v3').importStatus, undefined)            // 未提交保持原样
  // 原字段不丢
  assert.equal(byUrl('https://a.com/v1').title, 'A')
  assert.deepEqual(M.markCollectedImported(null, []), [])
})

// ── buildEnqueueAnalysisBody：enqueue_analysis 分析队列组包 ──

test('buildEnqueueAnalysisBody：默认 ai_status=pending + share_name 筛选（契约描述默认只取待分析）', () => {
  const body = M.buildEnqueueAnalysisBody('web_download')
  assert.equal(body.ai_status, 'pending')
  assert.equal(body.share_name, 'web_download')
  const other = M.buildEnqueueAnalysisBody('creators_collect')
  assert.equal(other.share_name, 'creators_collect')
})

// ── resolveDownloadUrlByFile：每日素材本地文件反查来源 URL（B9→B8）──

test('resolveDownloadUrlByFile：按最终路径精确匹配下载历史 → 来源 url', () => {
  const history = [
    { taskId: 't1', filename: 'v1.mp4', path: 'D:\\dl\\2026-08-28\\v1.mp4', url: 'https://www.douyin.com/video/1' },
    { taskId: 't2', filename: 'v2.jpg', path: 'D:\\dl\\2026-08-27\\v2.jpg', url: 'https://www.xiaohongshu.com/explore/aaa' },
  ]
  assert.equal(M.resolveDownloadUrlByFile('D:\\dl\\2026-08-28\\v1.mp4', history), 'https://www.douyin.com/video/1')
  // 路径大小写归一（Windows 不区分大小写）
  assert.equal(M.resolveDownloadUrlByFile('d:\\DL\\2026-08-28\\v1.mp4', history), 'https://www.douyin.com/video/1')
  // 无历史 / 未命中 → null
  assert.equal(M.resolveDownloadUrlByFile('D:\\dl\\2026-08-28\\nope.mp4', history), null)
  assert.equal(M.resolveDownloadUrlByFile('D:\\x.mp4', null), null)
  assert.equal(M.resolveDownloadUrlByFile('', history), null)
})

// ── validateImportInput：空清单 / 无 url / 超长 参数校验（异常分支）──

test('validateImportInput：空清单 / 非数组 / 全无 url 三类校验错误', () => {
  assert.equal(M.validateImportInput([]).ok, false)
  assert.match(M.validateImportInput([]).error, /空/i)
  assert.equal(M.validateImportInput(null).ok, false)
  assert.equal(M.validateImportInput([{ title: 'x' }]).ok, false)
  assert.match(M.validateImportInput([{ title: 'x' }]).error, /无.*url/i)
  assert.equal(M.validateImportInput([{ url: 'https://a.com/v1' }]).ok, true)
})
