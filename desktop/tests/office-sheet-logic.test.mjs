// ═══════════════════════════════════════════════════════════════
// office-sheet-logic.test.mjs — 办公能力：五类清单/报告 → Excel 结构纯函数单测
// 被测：renderer/src/composables/officeSheetLogic.ts（纯函数，无 exceljs/vue 依赖；
// Node ≥22.18 原生 type stripping 直接加载）。
// 对照 PRD §3.1（对话摘要表）+ §3.2 ①-⑤（达人/每日/入库/任务）+ E5（截断）。
// 运行：node --test "tests/*.test.mjs"
// ═══════════════════════════════════════════════════════════════

import { test } from 'node:test'
import assert from 'node:assert/strict'

const S = await import('../renderer/src/composables/officeSheetLogic.ts')

// ── 通用 ──

test('importStatusText / taskStatusText：状态文案映射', () => {
  assert.equal(S.importStatusText('submitted'), '待处理')
  assert.equal(S.importStatusText('imported'), '已入库')
  assert.equal(S.importStatusText('failed'), '失败')
  assert.equal(S.importStatusText('unknown'), 'unknown')
  assert.equal(S.taskStatusText('completed'), '已完成')
  assert.equal(S.taskStatusText('processing'), '处理中')
  assert.equal(S.taskStatusText('pending'), '排队中')
  assert.equal(S.taskStatusText('failed'), '失败')
  assert.equal(S.taskStatusText('queued'), '排队中')
})

test('sheetFormatBytes：B/KB/MB/GB', () => {
  assert.equal(S.sheetFormatBytes(500), '500 B')
  assert.equal(S.sheetFormatBytes(2048), '2.0 KB')
  assert.equal(S.sheetFormatBytes(5 * 1024 * 1024), '5.0 MB')
  assert.equal(S.sheetFormatBytes(3 * 1024 * 1024 * 1024), '3.0 GB')
  assert.equal(S.sheetFormatBytes(null), '0 B')
})

test('sheetFormatDateTime：YYYY-MM-DD HH:mm；非法/空原样', () => {
  assert.equal(S.sheetFormatDateTime('2026-08-29T09:12:00'), '2026-08-29 09:12')
  assert.equal(S.sheetFormatDateTime(''), '')
  assert.equal(S.sheetFormatDateTime(undefined), '')
  assert.equal(S.sheetFormatDateTime('not-a-date'), 'not-a-date')
})

// ── ① 对话摘要表（PRD §3.1 xlsx）──

test('chatToSheet：序号/角色/内容/时间四列正确', () => {
  const s = S.chatToSheet([
    { role: 'user', content: '你好', time: '2026-08-29T09:12:00' },
    { role: 'ai', content: '回复', time: '2026-08-29T09:12:05' },
  ])
  assert.equal(s.name, '对话记录')
  assert.deepEqual(s.columns, [
    { header: '序号', width: 8 },
    { header: '角色', width: 10 },
    { header: '内容', width: 60 },
    { header: '时间', width: 20 },
  ])
  assert.deepEqual(s.rows[0], [1, '用户', '你好', '2026-08-29 09:12'])
  assert.deepEqual(s.rows[1], [2, '助手', '回复', '2026-08-29 09:12'])
  assert.equal(s.truncated, false)
})

test('chatToSheet：空内容过滤 + E5 超 5000 行截断标记', () => {
  const empty = S.chatToSheet([{ role: 'user', content: '' }])
  assert.equal(empty.rows.length, 0)
  const big = Array.from({ length: 5200 }, (_, i) => ({ role: 'user', content: `m${i}` }))
  const s = S.chatToSheet(big)
  assert.equal(s.truncated, true)
  assert.equal(s.rows.length, S.SHEET_MAX_ROWS)
})

test('chatToSheet：Sheet 名规范化（会话标题含非法字符 → 替换 + ≤31 字符）', () => {
  const s = S.chatToSheet([{ role: 'user', content: 'x' }], { title: 'a/b*c?d: 超长标题' + 'e'.repeat(40) })
  assert.ok(!/[\\/:*?[\]]/.test(s.name))
  assert.ok(s.name.length <= 31)
  assert.ok(s.name.includes('a_b_c_d'))
})

// ── ② 达人采集清单（PRD §3.2①）──

test('creatorsToSheet：七列 + 标题截断 80 字 + 入库状态映射', () => {
  const s = S.creatorsToSheet([
    {
      platform: 'douyin',
      creatorName: '张三',
      title: 't'.repeat(100),
      url: 'https://v.douyin.com/x',
      date: '2026-08-29',
      collectedAt: '2026-08-29 09:12',
      importStatus: 'submitted',
    },
  ])
  assert.equal(s.name, '采集清单')
  assert.deepEqual(s.columns.map((c) => c.header), ['平台', '达人', '标题', '链接', '日期', '采集时间', '入库状态'])
  assert.equal(s.rows[0][0], 'douyin')
  assert.equal(s.rows[0][1], '张三')
  assert.equal(s.rows[0][2].length, 80)
  assert.equal(s.rows[0][6], '待处理')
  assert.equal(s.rows[0][3], 'https://v.douyin.com/x')
})

test('creatorsToSheet：空清单 → 空行', () => {
  const s = S.creatorsToSheet([])
  assert.equal(s.rows.length, 0)
  assert.equal(s.truncated, false)
})

// ── ③ 每日素材（PRD §3.2②）──

test('dailyToSheet：日期组展平 + 大小格式化', () => {
  const s = S.dailyToSheet([
    {
      date: '2026-08-29',
      files: [
        { name: 'a.mp4', type: 'video', path: 'D:\\dl\\2026-08-29\\a.mp4', size: 2048 },
        { name: 'b.jpg', type: 'image', path: 'D:\\dl\\2026-08-29\\b.jpg', size: 512 },
      ],
    },
    { date: '2026-08-28', files: [] },
  ])
  assert.equal(s.name, '每日素材')
  assert.deepEqual(s.columns.map((c) => c.header), ['文件名', '类型', '日期', '路径', '大小'])
  assert.deepEqual(s.rows[0], ['a.mp4', 'video', '2026-08-29', 'D:\\dl\\2026-08-29\\a.mp4', '2.0 KB'])
  assert.deepEqual(s.rows[1], ['b.jpg', 'image', '2026-08-29', 'D:\\dl\\2026-08-29\\b.jpg', '512 B'])
  assert.equal(s.rows.length, 2)
})

// ── ④ 入库清单（PRD §3.2③）──

test('importsToSheet：六列 + 来源回退 + 状态映射', () => {
  const s = S.importsToSheet([
    {
      url: 'https://x.com/1',
      title: '标题',
      platform: 'bilibili',
      status: 'imported',
      submittedAt: '2026-08-29T10:00:00',
      taskId: 't-1',
    },
    { url: 'https://x.com/2', shareName: 'web_download', status: 'failed' },
  ])
  assert.equal(s.name, '入库清单')
  assert.deepEqual(s.columns.map((c) => c.header), ['URL', '标题', '来源', '状态', '提交时间', '任务ID'])
  assert.deepEqual(s.rows[0], ['https://x.com/1', '标题', 'bilibili', '已入库', '2026-08-29 10:00', 't-1'])
  assert.deepEqual(s.rows[1], ['https://x.com/2', '', 'web_download', '失败', '', ''])
})

// ── ⑤ 任务报告（PRD §3.2⑤）──

test('tasksToSheet：七列 + 状态文案 + 进度收敛 + 结果取值', () => {
  const s = S.tasksToSheet([
    {
      id: 'c_1',
      title: '混剪任务',
      type: 'video_montage',
      status: 'completed',
      progress: 100,
      createdAt: '2026-08-29T08:00:00',
      resultTarget: { kind: 'path', value: 'D:\\out\\final.mp4' },
    },
    { id: 'c_2', title: '等待', type: 'x', status: 'pending', progress: 150, resultTarget: null },
  ])
  assert.equal(s.name, '任务报告')
  assert.deepEqual(s.columns.map((c) => c.header), ['任务ID', '标题', '类型', '状态', '进度', '创建时间', '结果'])
  assert.deepEqual(s.rows[0], ['c_1', '混剪任务', 'video_montage', '已完成', 100, '2026-08-29 08:00', 'D:\\out\\final.mp4'])
  assert.deepEqual(s.rows[1], ['c_2', '等待', 'x', '排队中', 100, '', ''])
})

test('tasksToSheet：空列表 → 空行不截断', () => {
  const s = S.tasksToSheet([])
  assert.equal(s.rows.length, 0)
  assert.equal(s.truncated, false)
})

// ═══════════════════════════════════════════════════════════════
// 补充覆盖（2026-08-29）：五类 E5 截断 / 进度边界 / 角色兜底 /
// 格式边界 / Sheet 名兜底 / 状态 null 处理
// ═══════════════════════════════════════════════════════════════

test('五类函数均受 5000 行截断（E5：creators/daily/imports/tasks）', () => {
  const n = 5200
  const c = S.creatorsToSheet(Array.from({ length: n }, (_, i) => ({ platform: 'p' })))
  assert.equal(c.truncated, true)
  assert.equal(c.rows.length, S.SHEET_MAX_ROWS)
  const d = S.dailyToSheet([{ date: 'd', files: Array.from({ length: n }, (_, i) => ({ name: `f${i}` })) }])
  assert.equal(d.truncated, true)
  assert.equal(d.rows.length, S.SHEET_MAX_ROWS)
  const im = S.importsToSheet(Array.from({ length: n }, (_, i) => ({ url: `u${i}` })))
  assert.equal(im.truncated, true)
  assert.equal(im.rows.length, S.SHEET_MAX_ROWS)
  const t = S.tasksToSheet(Array.from({ length: n }, (_, i) => ({ id: `t${i}` })))
  assert.equal(t.truncated, true)
  assert.equal(t.rows.length, S.SHEET_MAX_ROWS)
})

test('tasksToSheet：progress 负数→0、NaN→0、超上限→100', () => {
  const s = S.tasksToSheet([
    { id: 'a', status: 'processing', progress: -10 },
    { id: 'b', status: 'processing', progress: NaN },
    { id: 'c', status: 'processing', progress: 250 },
  ])
  assert.equal(s.rows[0][4], 0)
  assert.equal(s.rows[1][4], 0)
  assert.equal(s.rows[2][4], 100)
})

test('chatToSheet：role 非 user（system 等）→ 助手；空内容过滤后序号连续', () => {
  const s = S.chatToSheet([
    { role: 'system', content: 'sys' },
    { role: 'user', content: '' },
    { role: 'ai', content: 'ok' },
  ])
  assert.equal(s.rows.length, 2)
  assert.equal(s.rows[0][1], '助手')
  assert.equal(s.rows[0][0], 1)
  assert.equal(s.rows[1][0], 2)
})

test('sheetFormatBytes：0 与 1024 边界', () => {
  assert.equal(S.sheetFormatBytes(0), '0 B')
  assert.equal(S.sheetFormatBytes(1023), '1023 B')
  assert.equal(S.sheetFormatBytes(1024), '1.0 KB')
})

test('sheetFormatDateTime：Date 对象与数字时间戳', () => {
  const d = new Date(2026, 7, 29, 9, 12)
  assert.equal(S.sheetFormatDateTime(d), '2026-08-29 09:12')
  assert.equal(S.sheetFormatDateTime(d.getTime()), '2026-08-29 09:12')
})

test('空标题 Sheet 名 → Sheet1（_sheetName 兜底）', () => {
  const s = S.chatToSheet([{ role: 'user', content: 'x' }], { title: '  ' })
  assert.equal(s.name, 'Sheet1')
})

test('importStatusText：null/undefined → 空串', () => {
  assert.equal(S.importStatusText(null), '')
  assert.equal(S.importStatusText(undefined), '')
})

// ── tableToSheet：右侧预览面板 table 资产导出 Excel（2026-09-01 用户裁决：
//    导出动作跟产物走——消息体去整会话导出，预览面板表格资产支持导出 Excel） ──

test('tableToSheet：markdown 表格 → SheetSpec（首行表头，余行数据）', () => {
  const md = '| 商品 | 价格 |\n| --- | --- |\n| A | 10 |\n| B | 20 |'
  const s = S.tableToSheet('竞品对比', md)
  assert.equal(s.name, '竞品对比')
  assert.deepEqual(s.columns.map((c) => c.header), ['商品', '价格'])
  assert.deepEqual(s.rows, [['A', '10'], ['B', '20']])
  assert.equal(s.truncated, false)
})

test('tableToSheet：无表格内容 → 空 columns/rows（不抛错）', () => {
  const s = S.tableToSheet('文案资产', '这是普通文本，没有表格')
  assert.deepEqual(s.columns, [])
  assert.deepEqual(s.rows, [])
})
