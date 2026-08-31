// ═══════════════════════════════════════════════════════════════
// ops-copywriting-logic.test.mjs — 产品文案创作·纯逻辑单测
// 被测：renderer/src/composables/opsCopywritingLogic.ts（纯函数，无 vue 依赖）
// 对照原客户端：
//   · gui/product_script_page.py：_generate_copywriting L412-486
//     （资料段/prompt 构造/设置映射）、_populate_products L330-334
//   · utils/extreme_words.py：EXTREME_WORDS 全表 + check_extreme_words
// 运行：node --test "tests/*.test.mjs"
// ═══════════════════════════════════════════════════════════════

import { test } from 'node:test'
import assert from 'node:assert/strict'

const M = await import('../renderer/src/composables/opsCopywritingLogic.ts')

/* ── 生成设置映射（对齐原 L443-464） ─────────────────────────── */

test('PLATFORM_TEXT/TONE_TEXT/STRUCTURE_TEXT：选项齐全且非空文本', () => {
  assert.deepEqual(M.PLATFORM_OPTIONS, ['通用', '抖音', '快手', '小红书'])
  for (const p of M.PLATFORM_OPTIONS) assert.ok(M.PLATFORM_TEXT[p].length > 5)
  for (const t of M.TONE_OPTIONS) assert.ok(M.TONE_TEXT[t].length > 5)
  for (const s of M.STRUCTURE_OPTIONS) assert.ok(M.STRUCTURE_TEXT[s].length > 5)
})

test('tagCountOf：不生成/5 个/10 个 → 0/5/10，未知回退 0', () => {
  assert.equal(M.tagCountOf('不生成'), 0)
  assert.equal(M.tagCountOf('5 个'), 5)
  assert.equal(M.tagCountOf('10 个'), 10)
  assert.equal(M.tagCountOf('其他'), 0)
})

/* ── 产品资料段（对齐原 L412-425） ───────────────────────────── */

test('buildProductBasicLine：空值跳过 + 两空格连接', () => {
  assert.equal(
    M.buildProductBasicLine({ category: '清洁电器', brand: 'X品牌', model: 'V9', goods_no: 'G001', spec_name: '标准版' }),
    '品类：清洁电器  品牌：X品牌  型号：V9  商家编码：G001  规格：标准版',
  )
  assert.equal(M.buildProductBasicLine({ brand: '  ', model: 'V9' }), '型号：V9')
  assert.equal(M.buildProductBasicLine(null), '')
})

test('buildProductSection：未录入占位对齐原版', () => {
  const sec = M.buildProductSection({ brand: 'A' }, '', '卖点1\n卖点2')
  assert.ok(sec.includes('品牌：A'))
  assert.ok(sec.includes('【性能参数】\n（未录入）'))
  assert.ok(sec.includes('【核心卖点】\n卖点1\n卖点2'))
  assert.ok(!sec.startsWith('\n'))
})

/* ── prompt 构造（对齐原 L428-486） ──────────────────────────── */

test('buildCopywritingPrompt：基础结构含资料段/三设置/收尾约束', () => {
  const { systemPrompt, userPrompt } = M.buildCopywritingPrompt({
    productText: '品牌：A',
    platform: '抖音', tone: '专业测评', structure: '清单式',
    tagCount: 0, avoidBanned: false,
  })
  assert.ok(systemPrompt.includes('爆款短视频带货文案主创'))
  assert.ok(userPrompt.includes('【产品资料】\n品牌：A'))
  assert.ok(userPrompt.includes(`平台要求：${M.PLATFORM_TEXT['抖音']}`))
  assert.ok(userPrompt.includes(`语气要求：${M.TONE_TEXT['专业测评']}`))
  assert.ok(userPrompt.includes(`结构要求：${M.STRUCTURE_TEXT['清单式']}`))
  assert.ok(!userPrompt.includes('话题标签'))
  assert.ok(!userPrompt.includes('违禁词要求'))
  assert.ok(userPrompt.includes('只输出文案正文'))
})

test('buildCopywritingPrompt：标签数/违禁词/附加要求按需拼入', () => {
  const { userPrompt } = M.buildCopywritingPrompt({
    productText: 'x', platform: '小红书', tone: '热情种草', structure: '痛点切入',
    tagCount: 10, avoidBanned: true, extraPrompt: '提及赠品',
  })
  assert.ok(userPrompt.includes('生成 10 个话题标签'))
  assert.ok(userPrompt.includes('违禁词要求'))
  assert.ok(userPrompt.includes('【附加要求】\n提及赠品'))
})

test('buildCopywritingPrompt：风格指引进 system + user（截 1000）', () => {
  const long = '风'.repeat(1500)
  const { systemPrompt, userPrompt } = M.buildCopywritingPrompt({
    productText: 'x', platform: '通用', tone: '热情种草', structure: '黄金3秒开场',
    tagCount: 0, avoidBanned: false, styleText: long,
  })
  assert.ok(systemPrompt.includes('风格指引'))
  assert.ok(userPrompt.includes('【风格指引】'))
  const styleSeg = userPrompt.split('【风格指引】\n')[1].split('\n')[0]
  assert.equal(styleSeg.length, 1000)
})

test('buildCopywritingPrompt：未知设置回退默认值', () => {
  const { userPrompt } = M.buildCopywritingPrompt({
    productText: 'x', platform: '不存在', tone: '不存在', structure: '不存在',
    tagCount: 0, avoidBanned: false,
  })
  assert.ok(userPrompt.includes(M.PLATFORM_TEXT['通用']))
  assert.ok(userPrompt.includes(M.TONE_TEXT['热情种草']))
  assert.ok(userPrompt.includes(M.STRUCTURE_TEXT['黄金3秒开场']))
})

/* ── 极限词检测（extreme_words.py 全表） ─────────────────────── */

test('EXTREME_WORDS：全表规模且含关键词条', () => {
  assert.ok(M.EXTREME_WORDS.length >= 70)
  for (const w of ['全网最低', '第一', '100%', '国家级', '纯天然', '独家']) {
    assert.ok(M.EXTREME_WORDS.includes(w), `缺词条：${w}`)
  }
})

test('checkExtremeWords：命中位置排序 + 不区分大小写', () => {
  const ms = M.checkExtremeWords('全网最低价，包你 100% 满意；这是第一名的产品')
  const words = ms.map((m) => m.word)
  assert.ok(words.includes('全网最低价') || words.includes('全网最低'))
  assert.ok(words.includes('100%'))
  assert.ok(words.includes('第一'))
  const starts = ms.map((m) => m.start)
  assert.deepEqual([...starts].sort((a, b) => a - b), starts)
})

test('checkExtremeWords：无命中/空文本安全', () => {
  assert.deepEqual(M.checkExtremeWords('这是一段干净的文案'), [])
  assert.deepEqual(M.checkExtremeWords(''), [])
})

test('summarizeExtremeWords：去重排序、顿号连接', () => {
  const ms = M.checkExtremeWords('最最好，绝对第一，最好用')
  const s = M.summarizeExtremeWords(ms)
  assert.ok(s.includes('最好'))
  assert.ok(s.includes('第一'))
  assert.equal(s.split('、').length, [...new Set(s.split('、'))].length)
  const arr = s.split('、')
  assert.deepEqual([...arr].sort(), arr)
})

/* ── 产品下拉标签（对齐原 _populate_products L330-334） ──────── */

test('productComboLabel：[品类] 品牌 - 型号 + 编码兜底', () => {
  assert.equal(M.productComboLabel({ category: '清洁', brand: 'A', model: 'V9' }), '[清洁] A - V9')
  assert.equal(M.productComboLabel({ brand: 'A', model: 'V9' }), 'A - V9')
  assert.equal(M.productComboLabel({ goods_no: 'G001' }), 'G001')
  assert.equal(M.productComboLabel({ category: '清洁', goods_no: 'G001' }), '[清洁] G001')
})
