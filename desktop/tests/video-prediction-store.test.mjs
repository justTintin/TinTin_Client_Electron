// ══════════════════════════════════════════════════════════════
// video-prediction-store.test.mjs — 视频评价预测记录库单测（主进程）
// 被测：main/video-prediction-store.js
// 对照原客户端 studio/utils/video_prediction_manager.py：
//   · add_prediction（insert(0, item) 最新在前 / os.urandom(8).hex() / int(time.time())）
//   · set_feedback（actual = {play_count, platform_eval, at}）
//   · pending_feedback / recent_with_feedback(platform, limit=12)
//   · load / save（原版 data/video_predictions.json → 此处 userData/video_predictions.json）
// IPC 层用假 ipcMain + 假 app（指向临时目录）做真实读写回环，不触碰用户数据。
// 运行：cd desktop && node --test "tests/*.test.mjs"
// ══════════════════════════════════════════════════════════════
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const S = require('../main/video-prediction-store.js')

/** 收集 ipcMain.handle 注册表 → { channel: handler } */
function makeIpcMain() {
  const handlers = {}
  return { handlers, handle(channel, fn) { handlers[channel] = fn } }
}

/** 组装被测 IPC：userData 指向一次性临时目录 */
function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tintin-pred-'))
  const ipcMain = makeIpcMain()
  S.createVideoPredictionIpc(ipcMain, { app: { getPath: () => dir } })
  return { handlers: ipcMain.handlers, dir, file: path.join(dir, 'video_predictions.json') }
}

/** 一份合法的模型预测输出 */
const PREDICTED = {
  total: 82,
  play_level: '优质',
  golden3s: true,
  dims: { 吸睛力: 80, 画面冲击: 75, 悬念信息: 70, 节奏: 85, 完播预测: 78, 平台适配: 90 },
  comment: '开头抓人',
  suggestions: ['加强字幕'],
}

// ── addPrediction（纯函数）─────────────────────────────────────

test('addPrediction：unshift 到队首（对照 insert(0, item) 最新在前）', () => {
  const old = [{ id: 'old', video_path: 'D:\\v\\old.mp4', platform: '抖音', predicted: {}, actual: null, created_at: 1 }]
  const { list, id } = S.addPrediction(old, { videoPath: 'D:\\v\\new.mp4', platform: 'B站', predicted: PREDICTED })
  assert.equal(list.length, 2)
  assert.equal(list[0].id, id, '新记录必须在队首')
  assert.equal(list[1].id, 'old')
})

test('addPrediction：记录字段结构对照原版', () => {
  const { list, id } = S.addPrediction([], {
    videoPath: 'D:\\videos\\我的作品.mp4', platform: ' 小红书 ', predicted: PREDICTED,
  })
  const it = list[0]
  assert.equal(it.id, id)
  assert.equal(it.video_path, 'D:\\videos\\我的作品.mp4')
  assert.equal(it.video_name, '我的作品.mp4', 'video_name = basename(video_path)')
  assert.equal(it.platform, '小红书', 'platform 需 trim')
  assert.deepEqual(it.predicted, PREDICTED)
  assert.equal(it.actual, null, '新增时未回填')
})

test('addPrediction：id 为 16 位十六进制（对照 os.urandom(8).hex()）且唯一', () => {
  const ids = new Set()
  for (let i = 0; i < 50; i++) {
    const { id } = S.addPrediction([], { videoPath: `D:\\v\\${i}.mp4`, predicted: PREDICTED })
    assert.match(id, /^[0-9a-f]{16}$/, `id 格式异常：${id}`)
    ids.add(id)
  }
  assert.equal(ids.size, 50, 'id 必须唯一')
})

test('addPrediction：created_at 为秒级时间戳（对照 int(time.time())）', () => {
  const before = Math.floor(Date.now() / 1000)
  const { list } = S.addPrediction([], { videoPath: 'D:\\v\\a.mp4', predicted: PREDICTED })
  const after = Math.floor(Date.now() / 1000)
  assert.ok(list[0].created_at >= before && list[0].created_at <= after)
  assert.equal(String(list[0].created_at).length, 10, '必须是秒级而非毫秒级')
})

test('addPrediction：入参非法 → id 空串且不写入', () => {
  assert.equal(S.addPrediction([], {}).id, '')
  assert.equal(S.addPrediction([], { videoPath: '', predicted: PREDICTED }).id, '')
  assert.equal(S.addPrediction([], { videoPath: '   ', predicted: PREDICTED }).id, '')
  assert.equal(S.addPrediction([], { videoPath: 'D:\\v\\a.mp4' }).id, '')
  assert.equal(S.addPrediction([], { videoPath: 'D:\\v\\a.mp4', predicted: null }).id, '')
  assert.equal(S.addPrediction([], { videoPath: 'D:\\v\\a.mp4', predicted: 'str' }).id, '')
  assert.deepEqual(S.addPrediction([], { videoPath: '', predicted: PREDICTED }).list, [])
})

test('addPrediction：POSIX 路径也能取到 video_name', () => {
  const { list } = S.addPrediction([], { videoPath: '/home/u/clip.mov', predicted: PREDICTED })
  assert.equal(list[0].video_name, 'clip.mov')
})

test('addPrediction：不改传入的原数组（纯函数）', () => {
  const origin = [{ id: 'x' }]
  S.addPrediction(origin, { videoPath: 'D:\\v\\a.mp4', predicted: PREDICTED })
  assert.equal(origin.length, 1, '原数组不得被就地修改')
})

test('addPrediction：超出 MAX_RECORDS 丢弃最旧条目', () => {
  const bulk = []
  for (let i = 0; i < S.MAX_RECORDS; i++) {
    bulk.push({ id: `old-${i}`, video_path: `D:\\v\\${i}.mp4`, platform: '抖音', predicted: {}, actual: null, created_at: i })
  }
  const { list, id } = S.addPrediction(bulk, { videoPath: 'D:\\v\\new.mp4', predicted: PREDICTED })
  assert.equal(list.length, S.MAX_RECORDS, '条数不得超过上限')
  assert.equal(list[0].id, id)
  assert.ok(!list.some((x) => x.id === `old-${S.MAX_RECORDS - 1}`), '最旧一条应被丢弃')
})

// ── setFeedback（纯函数）───────────────────────────────────────

test('setFeedback：命中 id → 写入 actual 三元组', () => {
  const { list: base, id } = S.addPrediction([], { videoPath: 'D:\\v\\a.mp4', platform: '抖音', predicted: PREDICTED })
  const before = Math.floor(Date.now() / 1000)
  const { list, ok } = S.setFeedback(base, id, ' 1.2万 ', ' 表现不错 ')
  assert.equal(ok, true)
  assert.equal(list[0].actual.play_count, '1.2万', '需 trim')
  assert.equal(list[0].actual.platform_eval, '表现不错', '需 trim')
  assert.ok(list[0].actual.at >= before)
})

test('setFeedback：未命中 id → ok=false 且列表不变', () => {
  const { list: base } = S.addPrediction([], { videoPath: 'D:\\v\\a.mp4', predicted: PREDICTED })
  const { list, ok } = S.setFeedback(base, 'not-exist', '1000', '一般')
  assert.equal(ok, false)
  assert.equal(list[0].actual, null)
})

test('setFeedback：null/undefined 入参归一为空串（原版允许只填一项）', () => {
  const { list: base, id } = S.addPrediction([], { videoPath: 'D:\\v\\a.mp4', predicted: PREDICTED })
  const { list, ok } = S.setFeedback(base, id, null, undefined)
  assert.equal(ok, true)
  assert.equal(list[0].actual.play_count, '')
  assert.equal(list[0].actual.platform_eval, '')
})

test('setFeedback：回填后原 predicted 保留（供校准对照）', () => {
  const { list: base, id } = S.addPrediction([], { videoPath: 'D:\\v\\a.mp4', predicted: PREDICTED })
  const { list } = S.setFeedback(base, id, '5万', '很好')
  assert.deepEqual(list[0].predicted, PREDICTED)
})

test('setFeedback：非数组输入不抛异常', () => {
  assert.deepEqual(S.setFeedback(null, 'x', '1', '2'), { list: [], ok: false })
})

// ── pendingFeedback / recentWithFeedback ───────────────────────

test('pendingFeedback：只返回未回填记录，跳过 null 项', () => {
  const items = [
    { id: '1', actual: null },
    { id: '2', actual: { play_count: '9', platform_eval: '', at: 1 } },
    null,
    { id: '3' },
  ]
  assert.deepEqual(S.pendingFeedback(items).map((x) => x.id), ['1', '3'])
  assert.deepEqual(S.pendingFeedback(null), [])
})

test('recentWithFeedback：只返回已回填记录，默认 limit=12（对照原版签名）', () => {
  const items = []
  for (let i = 0; i < 20; i++) {
    items.push({ id: `r${i}`, platform: '抖音', predicted: { total: i }, actual: { play_count: `${i}`, platform_eval: '', at: i } })
  }
  assert.equal(S.recentWithFeedback(items).length, 12)
  assert.equal(S.recentWithFeedback(items, '抖音', 5).length, 5)
})

test('recentWithFeedback：按平台过滤，未回填与非本平台被排除', () => {
  const items = [
    { id: '1', platform: '抖音', actual: { play_count: '1', platform_eval: '', at: 1 } },
    { id: '2', platform: 'B站', actual: { play_count: '2', platform_eval: '', at: 1 } },
    { id: '3', platform: '抖音', actual: null },
    { id: '4', platform: '抖音', actual: { play_count: '4', platform_eval: '', at: 1 } },
  ]
  assert.deepEqual(S.recentWithFeedback(items, '抖音').map((x) => x.id), ['1', '4'])
  assert.deepEqual(S.recentWithFeedback(items, 'B站').map((x) => x.id), ['2'])
  assert.deepEqual(S.recentWithFeedback(items, '快手'), [])
  assert.deepEqual(S.recentWithFeedback(items, '').map((x) => x.id), ['1', '2', '4'], '空平台＝不过滤')
})

test('recentWithFeedback：非数组 → []', () => {
  assert.deepEqual(S.recentWithFeedback(null), [])
  assert.deepEqual(S.recentWithFeedback(undefined, '抖音'), [])
})

// ── IPC 回环（真实读写临时目录）─────────────────────────────────

test('createVideoPredictionIpc：缺 ipcMain 直接抛错', () => {
  assert.throws(() => S.createVideoPredictionIpc(null, {}), /ipcMain is required/)
})

test('createVideoPredictionIpc：注册 3 个白名单通道', () => {
  const { handlers } = setup()
  assert.deepEqual(
    Object.keys(handlers).sort(),
    ['prediction:add', 'prediction:list', 'prediction:setFeedback']
  )
})

test('prediction:list：首次（文件不存在）→ { items: [] }', async () => {
  const { handlers, file } = setup()
  assert.equal(fs.existsSync(file), false)
  assert.deepEqual(await handlers['prediction:list']({}), { items: [] })
})

test('prediction:add → list：落盘并可读回（含 video_name / actual=null）', async () => {
  const { handlers, file } = setup()
  const r = await handlers['prediction:add']({}, {
    videoPath: 'D:\\videos\\测试视频.mp4', platform: '视频号', predicted: PREDICTED,
  })
  assert.match(r.id, /^[0-9a-f]{16}$/)
  assert.equal(fs.existsSync(file), true, '必须真实落盘')

  const { items } = await handlers['prediction:list']({})
  assert.equal(items.length, 1)
  assert.equal(items[0].id, r.id)
  assert.equal(items[0].video_name, '测试视频.mp4')
  assert.equal(items[0].platform, '视频号')
  assert.equal(items[0].actual, null)
  assert.equal(items[0].predicted.total, 82)
})

test('prediction:add：入参非法 → { error } 且不落盘', async () => {
  const { handlers, file } = setup()
  const r = await handlers['prediction:add']({}, { videoPath: '', predicted: PREDICTED })
  assert.ok(r.error, '必须返回 error')
  assert.equal(r.id, undefined)
  assert.equal(fs.existsSync(file), false, '非法入参不得创建文件')

  const r2 = await handlers['prediction:add']({}, undefined)
  assert.ok(r2.error)
})

test('prediction:add：多次写入按最新在前持久化', async () => {
  const { handlers } = setup()
  const a = await handlers['prediction:add']({}, { videoPath: 'D:\\v\\a.mp4', platform: '抖音', predicted: PREDICTED })
  const b = await handlers['prediction:add']({}, { videoPath: 'D:\\v\\b.mp4', platform: 'B站', predicted: PREDICTED })
  const { items } = await handlers['prediction:list']({})
  assert.deepEqual(items.map((x) => x.id), [b.id, a.id])
})

test('prediction:setFeedback → list：回填结果持久化', async () => {
  const { handlers } = setup()
  const { id } = await handlers['prediction:add']({}, { videoPath: 'D:\\v\\a.mp4', platform: '抖音', predicted: PREDICTED })

  const r = await handlers['prediction:setFeedback']({}, { id, playCount: '3.5万', platformEval: '超出预期' })
  assert.equal(r.ok, true)

  const { items } = await handlers['prediction:list']({})
  assert.equal(items[0].actual.play_count, '3.5万')
  assert.equal(items[0].actual.platform_eval, '超出预期')
  assert.ok(items[0].actual.at > 0)
  assert.deepEqual(items[0].predicted, PREDICTED, 'predicted 不得被覆盖')
})

test('prediction:setFeedback：未知 id → { ok:false, error }', async () => {
  const { handlers } = setup()
  await handlers['prediction:add']({}, { videoPath: 'D:\\v\\a.mp4', predicted: PREDICTED })
  const r = await handlers['prediction:setFeedback']({}, { id: 'ghost', playCount: '1', platformEval: '' })
  assert.equal(r.ok, false)
  assert.ok(r.error)
})

test('prediction:list：JSON 文件损坏 → 降级为 { items: [] } 而非抛错', async () => {
  const { handlers, file } = setup()
  await handlers['prediction:add']({}, { videoPath: 'D:\\v\\a.mp4', predicted: PREDICTED })
  fs.writeFileSync(file, '{ 这不是合法 JSON', 'utf8')
  assert.deepEqual(await handlers['prediction:list']({}), { items: [] })
})

test('prediction:list：JSON 文件是对象而非数组 → 降级为 { items: [] }', async () => {
  const { handlers, file } = setup()
  fs.writeFileSync(file, '{"a":1}', 'utf8')
  assert.deepEqual(await handlers['prediction:list']({}), { items: [] })
})

test('IPC 全链路：add → setFeedback → 已回填/待回填分流（对照 pending_feedback）', async () => {
  const { handlers } = setup()
  const p1 = await handlers['prediction:add']({}, { videoPath: 'D:\\v\\1.mp4', platform: '抖音', predicted: { total: 90, play_level: '爆款' } })
  const p2 = await handlers['prediction:add']({}, { videoPath: 'D:\\v\\2.mp4', platform: '抖音', predicted: { total: 60, play_level: '普通' } })
  await handlers['prediction:setFeedback']({}, { id: p2.id, playCount: '2000', platformEval: '一般' })

  const { items } = await handlers['prediction:list']({})
  assert.deepEqual(S.pendingFeedback(items).map((x) => x.id), [p1.id])
  assert.deepEqual(S.recentWithFeedback(items, '抖音').map((x) => x.id), [p2.id])
})
