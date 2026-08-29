// ═══════════════════════════════════════════════════════════════
// task-queue-logic.test.mjs — 条目⑫ 任务队列去 mock + 轮询 + 本地持久化 编组单测
// 原客户端证据（以原代码为准）studio/gui/main_window_pages.py：
//   · 任务队列页 L1246-1300：七列「任务ID/任务类型/来源/状态/进度/时间/操作」
//   · 状态映射 status_map L1417：completed 完成 / processing 处理中 /
//     pending 排队中 / failed 失败 / error 错误
//   · 进度语义 L1420：processing→progress 值，completed→100，其它→0
//   · 详情区 L1317-1341：ID/类型/状态/进度/错误/参数/结果（结果打开）
// 新端数据源：/tasks/unified 统一任务中心（tasksStore）+ 抽屉打开期间轮询回填。
// 运行：node --test "tests/*.test.mjs"
// ═══════════════════════════════════════════════════════════════

import { test } from 'node:test'
import assert from 'node:assert/strict'

const R = await import('../renderer/src/composables/taskQueueLogic.ts')

// ── 状态文案：对齐原 status_map L1417（含新枚举扩展档） ──

test('statusText：原 status_map 五态 + 新枚举 waiting/paused/cancelled/queued + 未知原样透出', () => {
  assert.equal(R.statusText('completed'), '已完成')
  assert.equal(R.statusText('processing'), '处理中')
  assert.equal(R.statusText('pending'), '排队中')
  assert.equal(R.statusText('queued'), '排队中')
  assert.equal(R.statusText('failed'), '失败')
  assert.equal(R.statusText('error'), '错误')
  assert.equal(R.statusText('waiting_user_input'), '等待确认')
  assert.equal(R.statusText('paused'), '已暂停')
  assert.equal(R.statusText('cancelled'), '已取消')
  assert.equal(R.statusText('some_new_status'), 'some_new_status')
})

// ── TaskNode → 展示行映射：进度语义对齐原 L1420 ──

const node = (over = {}) => ({
  id: 'c_abc123',
  title: '抠图 · COVER.png',
  capability_key: 'rembg_matting',
  status: 'processing',
  progress: 42,
  created_at: '2026-08-28T10:00:00',
  updated_at: '2026-08-28T10:01:00',
  ...over,
})

test('mapServerTaskRow：processing→progress 值；completed→100；queued/failed→0（对齐原 L1420）', () => {
  assert.equal(R.mapServerTaskRow(node()).progress, 42)
  assert.equal(R.mapServerTaskRow(node({ status: 'completed' })).progress, 100)
  assert.equal(R.mapServerTaskRow(node({ status: 'queued', progress: 30 })).progress, 0)
  assert.equal(R.mapServerTaskRow(node({ status: 'failed' })).progress, 0)
})

test('mapServerTaskRow：行状态三档 running/pending/done + type 取 capability_key + 错误透出', () => {
  const r = R.mapServerTaskRow(node({ status: 'failed', error_message: 'boom' }))
  assert.equal(r.status, 'pending')
  assert.equal(r.eta, '失败： boom')
  assert.equal(R.mapServerTaskRow(node({ status: 'completed' })).status, 'done')
  assert.equal(R.mapServerTaskRow(node({ status: 'queued' })).status, 'pending')
  assert.equal(R.mapServerTaskRow(node()).status, 'running')
  assert.equal(R.mapServerTaskRow(node()).type, 'rembg_matting')
  // waiting_user_input → 行级 pending + 等待确认文案
  const w = R.mapServerTaskRow(node({ status: 'waiting_user_input' }))
  assert.equal(w.status, 'pending')
  assert.equal(w.eta, '等待确认')
})

// ── 结果打开目标提取（原详情区「结果」L1339-1340 语义） ──

test('extractResultTarget：http(s)→url；本地绝对路径→path；无→null', () => {
  assert.deepEqual(
    R.extractResultTarget({ result_preview: 'http://127.0.0.1:8000/montage/result/x.mp4' }),
    { kind: 'url', value: 'http://127.0.0.1:8000/montage/result/x.mp4' },
  )
  assert.deepEqual(
    R.extractResultTarget({ result_preview: 'D:\\out\\final.mp4' }),
    { kind: 'path', value: 'D:\\out\\final.mp4' },
  )
  assert.deepEqual(
    R.extractResultTarget({ result_preview: 'http://x/a.png （3.2MB）' }),
    { kind: 'url', value: 'http://x/a.png' },
  )
  assert.equal(R.extractResultTarget({ result_preview: '纯文本预览' }), null)
  assert.equal(R.extractResultTarget({}), null)
  assert.equal(R.extractResultTarget(null), null)
})
