// ═══════════════════════════════════════════════════════════════
// office-doc-logic.test.mjs — 办公能力：对话/转写 → docx 结构纯函数单测
// 被测：renderer/src/composables/officeDocLogic.ts（纯函数，无 vue/docx 依赖；
// Node ≥22.18 原生 type stripping 直接加载）。
// 对照 PRD §3.1（对话 → Word 结构）+ §3.2④（转写 → Word）+ E5（截断）。
// 运行：node --test "tests/*.test.mjs"
// ═══════════════════════════════════════════════════════════════

import { test } from 'node:test'
import assert from 'node:assert/strict'

const D = await import('../renderer/src/composables/officeDocLogic.ts')

/** 本地当天日期 YYYY-MM-DD（与 officeDocLogic 默认标题同口径，避免跨天硬编码失效） */
function todayStr() {
  const d = new Date()
  const p2 = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`
}

// ── 时间格式化 ──

test('formatSeconds：秒 → HH:MM:SS（转写时间轴 `[00:00:03]` 口径）', () => {
  assert.equal(D.formatSeconds(0), '00:00:00')
  assert.equal(D.formatSeconds(3), '00:00:03')
  assert.equal(D.formatSeconds(65), '00:01:05')
  assert.equal(D.formatSeconds(3661), '01:01:01')
  assert.equal(D.formatSeconds(undefined), '00:00:00')
})

test('formatDate / formatDateTime：YYYY-MM-DD 与 YYYY-MM-DD HH:mm', () => {
  const d = new Date(2026, 7, 29, 9, 12) // 2026-08-29 09:12
  assert.equal(D.formatDate(d), '2026-08-29')
  assert.equal(D.formatDateTime(d), '2026-08-29 09:12')
  assert.equal(D.formatDateTime('2026-08-29T09:12:00'), '2026-08-29 09:12')
  assert.equal(D.formatDateTime(null), '')
  assert.equal(D.formatDateTime(''), '')
})

// ── Markdown 解析 ──

test('parseInlineMarkdown：**加粗** → bold run；普通文本 → 单个 run', () => {
  assert.deepEqual(D.parseInlineMarkdown('**加粗**'), [{ text: '加粗', bold: true }])
  assert.deepEqual(D.parseInlineMarkdown('前**加粗**后'), [
    { text: '前' },
    { text: '加粗', bold: true },
    { text: '后' },
  ])
  assert.deepEqual(D.parseInlineMarkdown('纯文本'), [{ text: '纯文本' }])
  assert.deepEqual(D.parseInlineMarkdown(''), [])
})

test('parseDocxLine：- 列表 / > 引用 / 普通段落 / 空行', () => {
  assert.deepEqual(D.parseDocxLine('- 列表项'), { kind: 'list', runs: [{ text: '列表项' }] })
  assert.deepEqual(D.parseDocxLine('* 星号列表'), { kind: 'list', runs: [{ text: '星号列表' }] })
  assert.deepEqual(D.parseDocxLine('> 引用内容'), { kind: 'quote', runs: [{ text: '引用内容' }] })
  assert.deepEqual(D.parseDocxLine('>引用无空格'), { kind: 'quote', runs: [{ text: '引用无空格' }] })
  assert.deepEqual(D.parseDocxLine('普通段落'), { kind: 'para', runs: [{ text: '普通段落' }] })
  assert.equal(D.parseDocxLine('   '), null)
  assert.equal(D.parseDocxLine(''), null)
})

test('contentToBlocks：连续列表行合并为一条 list 块', () => {
  const blocks = D.contentToBlocks('- 甲\n- 乙\n\n> 引用\n正文')
  assert.deepEqual(blocks, [
    { type: 'list', items: [[{ text: '甲' }], [{ text: '乙' }]] },
    { type: 'quote', runs: [{ text: '引用' }] },
    { type: 'para', runs: [{ text: '正文' }] },
  ])
})

// ── 对话 → docx 结构（PRD §3.1）──

test('buildChatDocxStructure：标题/元信息/分隔线/角色标头/内容齐全', () => {
  const s = D.buildChatDocxStructure(
    [
      { role: 'user', content: '你好' },
      { role: 'ai', content: '**回复**内容' },
    ],
    { title: '我的会话', metaLines: ['智能体 · 会话 ID x · 导出时间 2026-08-29 09:12'] },
  )
  assert.equal(s.title, '我的会话')
  assert.equal(s.metaLines.length, 1)
  // heading + meta + divider + (role+para) x2
  assert.equal(s.blocks[0].type, 'heading')
  assert.equal(s.blocks[1].type, 'meta')
  assert.equal(s.blocks[2].type, 'divider')
  assert.deepEqual(s.blocks[3], { type: 'role', role: 'user', time: undefined })
  assert.deepEqual(s.blocks[4], { type: 'para', runs: [{ text: '你好' }] })
  assert.deepEqual(s.blocks[5], { type: 'role', role: 'ai', time: undefined })
  assert.deepEqual(s.blocks[6], { type: 'para', runs: [{ text: '回复', bold: true }, { text: '内容' }] })
  assert.equal(s.truncated, false)
})

test('buildChatDocxStructure：默认标题 `会话 YYYY-MM-DD` + 角色标头带时间（无 metaLines → heading+divider 骨架）', () => {
  const s = D.buildChatDocxStructure([{ role: 'user', content: 'x', time: '2026-08-29 09:12' }])
  assert.match(s.title, new RegExp(`^会话 ${todayStr()}$`))
  // 无 metaLines：blocks = [heading, divider, role, para]
  assert.equal(s.blocks[0].type, 'heading')
  assert.equal(s.blocks[1].type, 'divider')
  assert.deepEqual(s.blocks[2], { type: 'role', role: 'user', time: '2026-08-29 09:12' })
  assert.deepEqual(s.blocks[3], { type: 'para', runs: [{ text: 'x' }] })
})

test('buildChatDocxStructure：空内容消息过滤；全部空 → 仅骨架块', () => {
  const s = D.buildChatDocxStructure([
    { role: 'user', content: '' },
    { role: 'ai', content: '   ' },
  ])
  assert.deepEqual(s.blocks.map((b) => b.type), ['heading', 'divider'])
  const empty = D.buildChatDocxStructure([])
  assert.equal(empty.blocks.length, 2)
})

test('buildChatDocxStructure：每 40 条消息插分页符（40 条 → 1 个 pageBreak）', () => {
  const msgs = Array.from({ length: 40 }, (_, i) => ({ role: 'user', content: `m${i}` }))
  const s = D.buildChatDocxStructure(msgs)
  const breaks = s.blocks.filter((b) => b.type === 'pageBreak')
  assert.equal(breaks.length, 1)
  // 2 骨架（heading+divider）+ 40*(role+para) + 1 pageBreak
  assert.equal(s.blocks.length, 2 + 40 * 2 + 1)
  // pageBreak 位于第 40 条消息内容之后
  assert.equal(s.blocks[s.blocks.length - 1].type, 'pageBreak')
})

test('buildChatDocxStructure：E5 段数超 5000 截断 + 标记', () => {
  // 每条消息产出 1 块（role）+ 1 块（para）；2000 条 × 2 + 3 骨架 > 5000
  const msgs = Array.from({ length: 2600 }, (_, i) => ({ role: 'ai', content: `r${i}` }))
  const s = D.buildChatDocxStructure(msgs)
  assert.equal(s.truncated, true)
  assert.ok(s.blocks.length <= D.DOCX_MAX_BLOCKS)
})

// ── 转写 → docx 结构（PRD §3.2④）──

test('buildTranscriptDocxStructure：标题/元信息/SRT 时间轴段', () => {
  const s = D.buildTranscriptDocxStructure(
    [
      { start: 3, text: '第一句' },
      { start: 65, text: '第二句' },
      { text: '纯文本段' },
    ],
    { filename: 'demo.mp4', durationSec: 120, transcribeTime: '2026-08-29 09:12' },
  )
  assert.match(s.title, new RegExp(`^转写 demo\\.mp4 ${todayStr()}$`))
  assert.ok(s.metaLines.some((m) => m.includes('源文件：demo.mp4')))
  assert.ok(s.metaLines.some((m) => m.includes('时长：00:02:00')))
  assert.ok(s.metaLines.some((m) => m.includes('转写时间：2026-08-29 09:12')))
  // 3 条 meta → blocks: heading(0) + meta(1,2,3) + divider(4) + para(5,6,7)
  assert.equal(s.blocks[4].type, 'divider')
  assert.equal(s.blocks[5].type, 'para')
  assert.deepEqual(s.blocks[5].runs, [{ text: '[00:00:03] 第一句' }])
  assert.deepEqual(s.blocks[6].runs, [{ text: '[00:01:05] 第二句' }])
  assert.deepEqual(s.blocks[7].runs, [{ text: '纯文本段' }])
  assert.equal(s.truncated, false)
})

test('buildTranscriptDocxStructure：每 80 段插分页符', () => {
  const segs = Array.from({ length: 80 }, (_, i) => ({ start: i, text: `s${i}` }))
  const s = D.buildTranscriptDocxStructure(segs)
  const breaks = s.blocks.filter((b) => b.type === 'pageBreak')
  assert.equal(breaks.length, 1)
  // 3 骨架 + 80 para + 1 pageBreak
  assert.equal(s.blocks.length, 3 + 80 + 1)
})

// ═══════════════════════════════════════════════════════════════
// 补充覆盖（2026-08-29）：Markdown 解析边界 / 列表间隔 / 分页边界 /
// 转写空段与无时长 / 时间与秒格式边界
// ═══════════════════════════════════════════════════════════════

test('parseInlineMarkdown：多个加粗 / 不闭合 / 空星号 / 奇数星', () => {
  assert.deepEqual(D.parseInlineMarkdown('**甲**和**乙**'), [
    { text: '甲', bold: true },
    { text: '和' },
    { text: '乙', bold: true },
  ])
  // 不闭合 `**未闭合`：split 后非成对 → 普通 run（原样保留星号）
  assert.deepEqual(D.parseInlineMarkdown('**未闭合'), [{ text: '**未闭合' }])
  // `****` length===4 不满足 >4 且无非星分隔 → 整段普通 run（正则不匹配）
  assert.deepEqual(D.parseInlineMarkdown('前****后'), [{ text: '前****后' }])
  // 奇数星不配对 → 整段普通 run
  assert.deepEqual(D.parseInlineMarkdown('a**b*c'), [{ text: 'a**b*c' }])
})

test('contentToBlocks：列表被其他行打断后再次列表 → 新 list 块；列表项带加粗', () => {
  const blocks = D.contentToBlocks('- **甲**\n- 乙\n\n> 引用\n- 丙')
  assert.equal(blocks[0].type, 'list')
  assert.deepEqual(blocks[0].items, [[{ text: '甲', bold: true }], [{ text: '乙' }]])
  assert.equal(blocks[1].type, 'quote')
  assert.equal(blocks[2].type, 'list')
  assert.deepEqual(blocks[2].items, [[{ text: '丙' }]])
})

test('buildChatDocxStructure：多条 metaLines → 多 meta 块；列表消息 → role+list', () => {
  const s = D.buildChatDocxStructure(
    [{ role: 'user', content: '- a\n- b' }],
    { title: 't', metaLines: ['m1', 'm2'] },
  )
  assert.deepEqual(s.blocks.map((b) => b.type), ['heading', 'meta', 'meta', 'divider', 'role', 'list'])
  assert.equal(s.blocks[4].role, 'user')
  assert.deepEqual(s.blocks[5].items, [[{ text: 'a' }], [{ text: 'b' }]])
})

test('buildChatDocxStructure：分页边界——39 条无分页、80 条 2 个', () => {
  const m39 = Array.from({ length: 39 }, (_, i) => ({ role: 'user', content: `m${i}` }))
  const b39 = D.buildChatDocxStructure(m39).blocks.filter((b) => b.type === 'pageBreak')
  assert.equal(b39.length, 0)
  const m80 = Array.from({ length: 80 }, (_, i) => ({ role: 'ai', content: `r${i}` }))
  const b80 = D.buildChatDocxStructure(m80).blocks.filter((b) => b.type === 'pageBreak')
  assert.equal(b80.length, 2)
})

test('buildTranscriptDocxStructure：空段 → 骨架；无 durationSec → 无时长 meta 行', () => {
  const s = D.buildTranscriptDocxStructure([], { filename: 'a.mp4' })
  assert.deepEqual(s.blocks.map((b) => b.type), ['heading', 'meta', 'divider'])
  assert.equal(s.metaLines.length, 1)
  assert.equal(s.metaLines[0], '源文件：a.mp4')
})

test('buildTranscriptDocxStructure：160 段 → 2 个分页符', () => {
  const segs = Array.from({ length: 160 }, (_, i) => ({ start: i, text: `s${i}` }))
  const s = D.buildTranscriptDocxStructure(segs)
  assert.equal(s.blocks.filter((b) => b.type === 'pageBreak').length, 2)
})

test('formatSeconds：负值归零 / 小数向下取整 / NaN 归零 / 59:59', () => {
  assert.equal(D.formatSeconds(-5), '00:00:00')
  assert.equal(D.formatSeconds(3.9), '00:00:03')
  assert.equal(D.formatSeconds(NaN), '00:00:00')
  assert.equal(D.formatSeconds(3599), '00:59:59')
})

test('formatDate / formatDateTime：数字时间戳 / 非法输入返回空', () => {
  const ts = new Date(2026, 7, 29, 9, 12).getTime()
  assert.equal(D.formatDate(ts), '2026-08-29')
  assert.equal(D.formatDateTime(ts), '2026-08-29 09:12')
  assert.equal(D.formatDate('bad-date'), '')
  assert.equal(D.formatDateTime('bad-date'), '')
  assert.equal(D.formatDate(null), '')
})
