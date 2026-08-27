// ═══════════════════════════════════════════════════════════════
// local-scheduler.test.mjs — 本地定时任务纯函数单测（P2）
// 运行：node --test tests/
// 对照基准：原客户端 utils/local_scheduler.py 的
//   _parse_query_info / _result_text / _schedule_text / create_task 前置校验
// ═══════════════════════════════════════════════════════════════

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseQueryInfo,
  resultText,
  scheduleText,
  validateCreate,
  buildCreateArgs,
  findScheduledArg
} from '../main/local-scheduler.js'

// ── parseQueryInfo：中英文键兼容 ──
test('parseQueryInfo 解析中文 schtasks LIST 输出', () => {
  const out = [
    '主机名:      DESKTOP-XXX',
    '任务名:      \\TinTinAI_热点采集',
    '下次运行时间: 2026/8/28 9:00:00',
    '上次运行时间: 2026/8/27 9:00:00',
    '上次结果:    (0x0)',
    '状态:       就绪'
  ].join('\n')
  const info = parseQueryInfo(out)
  assert.equal(info['下次运行时间'], '2026/8/28 9:00:00')
  assert.equal(info['上次运行时间'], '2026/8/27 9:00:00')
  assert.equal(info['上次结果'], '(0x0)')
  assert.equal(info['状态'], '就绪')
})

test('parseQueryInfo 兼容英文键并忽略无关行', () => {
  const info = parseQueryInfo('Next Run Time: 9:00:00\nLast Result: (267011)\nRandom: x\nno-colon-line')
  assert.equal(info['Next Run Time'], '9:00:00')
  assert.equal(info['Last Result'], '(267011)')
  assert.equal(info['Random'], undefined)
})

// ── resultText：0x0=成功 / 0x41303=尚未运行 ──
test('resultText 三态映射', () => {
  assert.equal(resultText('(0x0)'), '成功')
  assert.equal(resultText('0'), '成功')
  assert.equal(resultText('(0x41303)'), '尚未运行')
  assert.equal(resultText('267011'), '尚未运行')
  assert.equal(resultText('(0x1)'), '(0x1)')
  assert.equal(resultText(''), '—')
  assert.equal(resultText(undefined), '—')
})

// ── scheduleText：每天/每周 ──
test('scheduleText 每天与每周格式', () => {
  assert.equal(scheduleText({ mode: 'daily', time: '09:00' }), '每天 09:00')
  assert.equal(scheduleText({ mode: 'weekly', time: '08:30', weekdays: [0, 1, 2, 3, 4] }), '每周 周一、二、三、四、五 08:30')
  assert.equal(scheduleText({ mode: 'weekly', time: '08:30', weekdays: [] }), '每周 08:30')
  assert.equal(scheduleText(null), '每天 ')
})

// ── validateCreate：与原版 create_task 校验逐条对照 ──
test('validateCreate 正向：hotspot 每天默认时间', () => {
  const v = validateCreate({ name: '热点采集', taskType: 'hotspot', schedule: { mode: 'daily', time: '09:00' } })
  assert.equal(v.ok, true)
  assert.equal(v.taskName, 'TinTinAI_热点采集')
})

test('validateCreate 边界：agent 缺 goal / 非法时间 / 空名 / 重复字符清洗', () => {
  assert.equal(validateCreate({ name: 'x', taskType: 'agent', goal: '  ' }).msg, '云端智能体任务需要任务描述（goal）')
  assert.equal(validateCreate({ name: 'x', schedule: { time: '9:00' } }).msg, '时间格式应为 HH:MM：9:00')
  assert.equal(validateCreate({ name: '///' }).msg, '任务名称不能为空')
  const v = validateCreate({ name: '热 点 采 集!' })
  assert.equal(v.safe, '热点采集')
  assert.equal(validateCreate({ name: 'x', schedule: { mode: 'hourly' } }).msg, '不支持的调度方式: hourly')
  assert.equal(validateCreate({ name: 'x', taskType: 'cron' }).msg, '不支持的本地任务类型: cron')
})

// ── buildCreateArgs：schtasks 参数与星期排序去重 ──
test('buildCreateArgs 每天', () => {
  const r = buildCreateArgs({ taskName: 'TinTinAI_a', mode: 'daily', timeStr: '09:00' })
  assert.deepEqual(r.args.slice(0, 4), ['/create', '/f', '/tn', 'TinTinAI_a'])
  assert.deepEqual(r.args.slice(6), ['/sc', 'DAILY', '/st', '09:00'])
})

test('buildCreateArgs 每周星期去重排序为 MON..SUN；空星期报错', () => {
  // 0=MON（对齐原版 _WEEKDAY_ABBR）；[5,0,5,6] → 去重排序 [0,5,6] → MON,SAT,SUN
  const r = buildCreateArgs({ taskName: 'T', mode: 'weekly', timeStr: '08:00', weekdays: [5, 0, 5, 6] })
  assert.equal(r.args[r.args.indexOf('/d') + 1], 'MON,SAT,SUN')
  const fri = buildCreateArgs({ taskName: 'T', mode: 'weekly', timeStr: '08:00', weekdays: [4, 0] })
  assert.equal(fri.args[fri.args.indexOf('/d') + 1], 'MON,FRI')
  const bad = buildCreateArgs({ taskName: 'T', mode: 'weekly', timeStr: '08:00', weekdays: [] })
  assert.equal(bad.ok, false)
  assert.equal(bad.msg, '每周模式至少选择一个星期')
})

// ── findScheduledArg：到点参数解析 ──
test('findScheduledArg 提取 type:name，无参数返回 null', () => {
  assert.equal(findScheduledArg(['--tintin-scheduled=agent:TinTinAI_热点采集']), 'agent:TinTinAI_热点采集')
  assert.equal(findScheduledArg(['--other']), null)
  assert.equal(findScheduledArg([]), null)
})
