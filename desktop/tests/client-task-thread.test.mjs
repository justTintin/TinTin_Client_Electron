// ═══════════════════════════════════════════════════════════════
// client-task-thread.test.mjs — W11 客户端任务下发闭环 编组单测
// 基准（以原代码为准）：
//   · studio/gui/client_task_thread.py L14-61：每 5s 领取 → execute_task →
//     POST report（ok/failed）；异常仅告警继续轮询（L33-35）
//   · studio/utils/client_task_worker.py：
//       _is_download_task L107-113（capability 关键词 / url http(s)）
//       pickup_tasks L56-62（{tasks:[...]}|裸数组）
//       _wait_download_file L126-140（轮询下载目录新文件，超时 null）
//   · openapi-latest.json：POST /tasks/{task_id}/report Body schema
//     machine_id(必填) / status(ok|failed) / error / result / file
//   · studio/utils/license.py get_machine_id L44-71：SHA256 前 16 位
// 运行：node --test "tests/*.test.mjs"
// ═══════════════════════════════════════════════════════════════

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const R = await import('../main/client-task-thread.js')

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'ctt-')) }

// ── 下载类任务判定（对照原版 _is_download_task L107-113） ──

test('isDownloadTask：capability 关键词命中（download/browser/素材下载/下载）', () => {
  assert.equal(R.isDownloadTask({ capability: 'video_download' }), true)
  assert.equal(R.isDownloadTask({ capability: 'browser_collect' }), true)
  assert.equal(R.isDownloadTask({ capability: '素材下载' }), true)
  assert.equal(R.isDownloadTask({ capability: '下载视频' }), true)
})

test('isDownloadTask：params.url http(s) 开头命中；其余 false', () => {
  assert.equal(R.isDownloadTask({ params: { url: 'https://v.douyin.com/abc' } }), true)
  assert.equal(R.isDownloadTask({ capability: 'clip', params: { url: 'http://x.com/a.mp4' } }), true)
  assert.equal(R.isDownloadTask({ capability: 'asr_transcribe' }), false)
  assert.equal(R.isDownloadTask({ params: { url: 'C:/local/file.mp4' } }), false)
  assert.equal(R.isDownloadTask({}), false)
})

// ── 领取响应解析（对照原版 pickup_tasks L56-62） ──

test('parsePickupResponse：{tasks:[...]} / 裸数组 / 空与垃圾', () => {
  const t1 = { task_id: 'c_1' }
  assert.deepEqual(R.parsePickupResponse({ tasks: [t1] }), [t1])
  assert.deepEqual(R.parsePickupResponse([t1]), [t1])
  assert.deepEqual(R.parsePickupResponse({}), [])
  assert.deepEqual(R.parsePickupResponse(null), [])
  assert.deepEqual(R.parsePickupResponse(undefined), [])
  assert.deepEqual(R.parsePickupResponse('nope'), [])
})

// ── report 字段编组（对照 openapi Body_report_task schema） ──

test('buildReportFields：ok+file → machine_id/status/file；result 带出', () => {
  const f = R.buildReportFields({ machineId: 'mid1', status: 'ok', file_path: 'D:/a/b.mp4', result: '{"k":1}' })
  assert.equal(f.machine_id, 'mid1')
  assert.equal(f.status, 'ok')
  assert.deepEqual(f.file, { path: 'D:/a/b.mp4' })
  assert.equal(f.result, '{"k":1}')
  assert.equal(f.error, undefined)
})

test('buildReportFields：failed → status=failed + error；无文件/无 result 不带多余键', () => {
  const f = R.buildReportFields({ machineId: 'mid1', status: 'failed', error: '执行失败' })
  assert.equal(f.status, 'failed')
  assert.equal(f.error, '执行失败')
  assert.equal(f.file, undefined)
  assert.equal(f.result, undefined)
  const g = R.buildReportFields({ machineId: 'mid1', status: 'ok' })
  assert.deepEqual(Object.keys(g).sort(), ['machine_id', 'status'])
})

test('buildReportFields：result 空串/undefined 不带；file_path 非字符串不带', () => {
  const f = R.buildReportFields({ machineId: 'm', status: 'ok', result: '', file_path: 0 })
  assert.equal(f.result, undefined)
  assert.equal(f.file, undefined)
})

// ── machine_id 派生（对照原版 license.get_machine_id：SHA256 前 16 位） ──

test('deriveMachineId：SHA256 前 16 位小写 hex，同输入稳定', () => {
  const info = { hostname: 'PC-01', platform: 'win32', machineGuid: 'ABC-123', mac: 'AA:BB:CC:DD:EE:FF' }
  const a = R.deriveMachineId(info)
  const b = R.deriveMachineId(info)
  assert.equal(a, b)
  assert.equal(a.length, 16)
  assert.match(a, /^[0-9a-f]{16}$/)
  // 大小写/冒号归一后同值（与渲染层 machineCodeLogic.buildMachineSeed 同口径）
  assert.equal(R.deriveMachineId({ hostname: 'pc-01', platform: 'WIN32', machineGuid: 'abc-123', mac: 'aabbccddeeff' }), a)
})

test('deriveMachineId：空信息返回空串（无稳定种子不臆造）', () => {
  assert.equal(R.deriveMachineId({}), '')
  assert.equal(R.deriveMachineId(null), '')
})

// ── 轮询间隔分段（对照原版 L55-58：5s/0.5s=10 段，stop 可打断） ──

test('buildSleepChunks：5000/500=10；非法值兜底 ≥1', () => {
  assert.equal(R.buildSleepChunks(5000, 500), 10)
  assert.equal(R.buildSleepChunks(5000), 10)
  assert.equal(R.buildSleepChunks(0, 500), 1)
  assert.equal(R.buildSleepChunks(-1), 1)
})

// ── 下载目录快照（对照原版 _snapshot_dir L116-123） ──

test('snapshotDir：仅收集文件；目录/不存在 → 空集', () => {
  const d = tmpDir()
  fs.writeFileSync(path.join(d, 'a.mp4'), 'x')
  fs.mkdirSync(path.join(d, 'sub'))
  assert.deepEqual(R.snapshotDir(d), new Set(['a.mp4']))
  assert.deepEqual(R.snapshotDir(path.join(d, 'sub')), new Set())
  assert.deepEqual(R.snapshotDir(path.join(d, 'nope')), new Set())
})

// ── 等待下载文件（对照原版 _wait_download_file L126-140） ──

test('waitDownloadFile：目录出现新文件 → 返回（字典序最后者）', async () => {
  const d = tmpDir()
  fs.writeFileSync(path.join(d, 'old.mp4'), 'x')
  const before = R.snapshotDir(d)
  const sleep = async () => {}
  // 注入第一轮快照后写入两个新文件
  let first = true
  const sleeper = async () => { if (first) { first = false; fs.writeFileSync(path.join(d, 'b.mp4'), 'x'); fs.writeFileSync(path.join(d, 'a.mp4'), 'x') } await sleep() }
  const got = await R.waitDownloadFile(d, before, { maxWaitMs: 100, pollMs: 5, sleep: sleeper })
  assert.equal(got, path.join(d, 'b.mp4')) // 字典序排序后取最后者
})

test('waitDownloadFile：超时无新文件 → null', async () => {
  const d = tmpDir()
  fs.writeFileSync(path.join(d, 'old.mp4'), 'x')
  const before = R.snapshotDir(d)
  const got = await R.waitDownloadFile(d, before, { maxWaitMs: 30, pollMs: 5, sleep: async () => {} })
  assert.equal(got, null)
})

// ── 轮询状态机（runOnePoll：领取→执行→上报；异常仅告警继续） ──

test('runOnePoll：领取异常 → 告警并返回 []（继续轮询，原版 L33-35）', async () => {
  const logs = []
  const res = await R.runOnePoll({
    machineId: 'm',
    pickup: async () => { throw new Error('conn refused') },
    executeTask: async () => { throw new Error('不应执行') },
    report: async () => { throw new Error('不应上报') },
    onLog: (m) => logs.push(m),
  })
  assert.deepEqual(res, [])
  assert.ok(logs.some((l) => l.includes('conn refused')))
})

test('runOnePoll：无 task_id 的任务跳过；有效任务执行成功 → 上报 ok+file', async () => {
  const calls = []
  const res = await R.runOnePoll({
    machineId: 'm',
    pickup: async () => [{}, { task_id: 'c_1' }],
    executeTask: async (t) => { calls.push(['exec', t.task_id]); return { ok: true, file_path: 'D:/x.mp4' } },
    report: async (id, fields) => { calls.push(['report', id, fields]); return true },
  })
  assert.deepEqual(res, [{ task_id: 'c_1', ok: true, status: 'ok' }])
  assert.equal(calls.length, 2)
  const [, , fields] = calls[1]
  assert.equal(fields.status, 'ok')
  assert.deepEqual(fields.file, { path: 'D:/x.mp4' })
})

test('runOnePoll：执行失败 → 上报 failed+error（原版 L49-52）', async () => {
  const calls = []
  const res = await R.runOnePoll({
    machineId: 'm',
    pickup: async () => [{ task_id: 'c_2' }],
    executeTask: async () => ({ ok: false, error: '打开素材浏览器失败' }),
    report: async (id, fields) => { calls.push(fields); return true },
  })
  assert.deepEqual(res, [{ task_id: 'c_2', ok: true, status: 'failed' }])
  assert.equal(calls[0].status, 'failed')
  assert.equal(calls[0].error, '打开素材浏览器失败')
})

test('runOnePoll：执行抛异常 → 归为 failed 上报；上报抛异常 → ok=false 不中断', async () => {
  const res = await R.runOnePoll({
    machineId: 'm',
    pickup: async () => [{ task_id: 'c_3' }, { task_id: 'c_4' }],
    executeTask: async (t) => (t.task_id === 'c_3' ? { ok: true } : { ok: true }),
    report: async (id) => (id === 'c_3' ? Promise.reject(new Error('http 500')) : true),
  })
  assert.deepEqual(res, [
    { task_id: 'c_3', ok: false, status: 'ok' },
    { task_id: 'c_4', ok: true, status: 'ok' },
  ])
})

test('runOnePoll：isRunning=false → 中断后续任务（stop 语义）', async () => {
  const exec = []
  await R.runOnePoll({
    machineId: 'm',
    pickup: async () => [{ task_id: 'a' }, { task_id: 'b' }],
    executeTask: async (t) => { exec.push(t.task_id); return { ok: true } },
    report: async () => true,
    isRunning: () => exec.length < 1,
  })
  assert.deepEqual(exec, ['a'])
})

// ── execute_task（引导下载语义，对照原版 execute_task L143-184） ──

test('executeDownloadTask：非下载能力 → failed「未实现的客户端能力」', async () => {
  const res = await R.executeDownloadTask({ task_id: 'c_5', capability: 'asr_transcribe' }, {
    openDownloadPage: async () => ({ ok: true }),
    getDownloadDir: () => tmpDir(),
    maxWaitMs: 50, pollMs: 5,
  })
  assert.equal(res.ok, false)
  assert.match(res.error, /未实现的客户端能力/)
})

test('executeDownloadTask：打开浏览器失败 → failed（不上报成功）', async () => {
  const res = await R.executeDownloadTask({ task_id: 'c_6', params: { url: 'https://v.douyin.com/x' } }, {
    openDownloadPage: async () => ({ ok: false, error: '浏览器窗口不可用' }),
    getDownloadDir: () => tmpDir(),
    maxWaitMs: 50, pollMs: 5,
  })
  assert.equal(res.ok, false)
  assert.equal(res.error, '浏览器窗口不可用')
})

test('executeDownloadTask：用户完成下载 → ok + file_path；超时 → failed', async () => {
  const d = tmpDir()
  fs.writeFileSync(path.join(d, 'old.mp4'), 'x')
  // 成功路径：打开后延迟写入新文件
  setTimeout(() => fs.writeFileSync(path.join(d, 'new.mp4'), 'x'), 30)
  const okRes = await R.executeDownloadTask({ task_id: 'c_7', params: { url: 'https://v.douyin.com/x' } }, {
    openDownloadPage: async () => ({ ok: true }),
    getDownloadDir: () => d,
    maxWaitMs: 2000, pollMs: 20,
  })
  assert.equal(okRes.ok, true)
  assert.equal(okRes.file_path, path.join(d, 'new.mp4'))
  // 超时路径：无新文件
  const d2 = tmpDir()
  const timeoutRes = await R.executeDownloadTask({ task_id: 'c_8', params: { url: 'https://v.douyin.com/x' } }, {
    openDownloadPage: async () => ({ ok: true }),
    getDownloadDir: () => d2,
    maxWaitMs: 60, pollMs: 10,
  })
  assert.equal(timeoutRes.ok, false)
  assert.match(timeoutRes.error, /等待下载超时，用户未完成下载/)
})
