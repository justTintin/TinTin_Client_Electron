// ═══════════════════════════════════════════════════════════════
// scheduled-exec-logic.test.mjs — 服务端定时任务执行记录·纯逻辑单测
// 被测：renderer/src/composables/scheduledExecLogic.ts
// 对照原客户端 scheduled_tasks_page.py：
//   · _status_label L1002-1004 / _status_color L1007-1010 /
//     _type_label L996-999 / 详情字段（模块 docstring L9-10）
// 运行：node --test "tests/*.test.mjs"
// ═══════════════════════════════════════════════════════════════

import { test } from 'node:test'
import assert from 'node:assert/strict'

const M = await import('../renderer/src/composables/scheduledExecLogic.ts')

/* ── 状态映射（对齐原 _status_label/_status_color） ───────────── */

test('schedStatusText：四态中文标签 + 未知原样 + 空值占位', () => {
  assert.equal(M.schedStatusText('pending'), '排队中')
  assert.equal(M.schedStatusText('running'), '执行中')
  assert.equal(M.schedStatusText('completed'), '已完成')
  assert.equal(M.schedStatusText('failed'), '失败')
  assert.equal(M.schedStatusText('other'), 'other')
  assert.equal(M.schedStatusText(''), '—')
  assert.equal(M.schedStatusText(undefined), '—')
})

test('schedStatusColor：running 橙/completed 绿/failed 红/pending 灰', () => {
  assert.equal(M.schedStatusColor('running'), '#f39c12')
  assert.equal(M.schedStatusColor('completed'), '#2ecc71')
  assert.equal(M.schedStatusColor('failed'), '#e74c3c')
  assert.equal(M.schedStatusColor('pending'), '#8a8f98')
  assert.equal(M.schedStatusColor(undefined), '#8a8f98')
  assert.equal(M.schedStatusColor('x'), '#8a8f98')
})

/* ── 类型映射（对齐原 _type_label） ──────────────────────────── */

test('schedTypeText：成片类型归并 + 未知原样 + 空值占位', () => {
  assert.equal(M.schedTypeText('product_montage'), '产品成片')
  assert.equal(M.schedTypeText('video_montage'), '产品成片')
  assert.equal(M.schedTypeText('compile_video'), '产品成片')
  assert.equal(M.schedTypeText('storyboard_montage'), '脚本成片')
  assert.equal(M.schedTypeText('script_montage'), '脚本成片')
  assert.equal(M.schedTypeText('custom_type'), 'custom_type')
  assert.equal(M.schedTypeText(''), '—')
  assert.equal(M.schedTypeText(undefined), '—')
})

/* ── 结果摘要提取 ───────────────────────────────────────────── */

test('schedResultSummary：video_url 优先、逐键回退、非对象安全', () => {
  assert.equal(M.schedResultSummary({ result: { video_url: 'http://v/1.mp4', text: 'x' } }), 'http://v/1.mp4')
  assert.equal(M.schedResultSummary({ result: { url: 'http://u' } }), 'http://u')
  assert.equal(M.schedResultSummary({ result: { text: '说明文本' } }), '说明文本')
  assert.equal(M.schedResultSummary({ result: { other: 1 } }), '')
  assert.equal(M.schedResultSummary({ result: null }), '')
  assert.equal(M.schedResultSummary({}), '')
  assert.equal(M.schedResultSummary(null), '')
  assert.equal(M.schedResultSummary(undefined), '')
})

/* ── 行视图归一（toSchedExecRows） ───────────────────────────── */

test('toSchedExecRows：字段归一/时间截断/总分空安全/结果标记', () => {
  const rows = M.toSchedExecRows([
    {
      id: 7, title: '一键成片-0521', task_type: 'product_montage',
      status: 'running', progress: 40, score: 8.5,
      created_at: '2026-08-31T10:20:30', completed_at: null,
      result: { video_url: 'http://v/1.mp4' },
    },
    { id: 'x1', title: '', task_type: '', status: 'failed', progress: 'bad', error_msg: 'boom' },
  ])
  assert.equal(rows.length, 2)
  assert.deepEqual(
    { t: rows[0].typeText, s: rows[0].statusText, c: rows[0].statusColor, p: rows[0].progress },
    { t: '产品成片', s: '执行中', c: '#f39c12', p: 40 },
  )
  assert.equal(rows[0].score, 8.5)
  assert.equal(rows[0].createdAt, '2026-08-31T10:20')
  assert.equal(rows[0].completedAt, '')
  assert.equal(rows[0].hasResultUrl, true)
  assert.equal(rows[0].id, '7')

  assert.equal(rows[1].title, '—')
  assert.equal(rows[1].typeText, '—')
  assert.equal(rows[1].statusText, '失败')
  assert.equal(rows[1].progress, 0)
  assert.equal(rows[1].score, null)
  assert.equal(rows[1].hasResultUrl, false)
})

test('toSchedExecRows：空/非数组安全', () => {
  assert.deepEqual(M.toSchedExecRows([]), [])
  assert.deepEqual(M.toSchedExecRows(undefined), [])
})
