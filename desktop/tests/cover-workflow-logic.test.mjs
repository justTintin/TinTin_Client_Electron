// ═══════════════════════════════════════════════════════════════
// cover-workflow-logic.test.mjs — M5 封面制作·提交参数编组与 AI 文案解析纯函数单测
// 被测：renderer/src/components/media-tools/cover-workflow-logic.ts
// （无 vue 依赖，Node ≥22.18 原生 type stripping 直接加载）
// 覆盖：buildCoverWorkflow 保持既有结构 + template/title 透传；
//       parseAiCopyJson 对齐原版 _ai_suggest 的 JSON 输出解析（含容错）。
// 运行：node --test "tests/*.test.mjs"
// ═══════════════════════════════════════════════════════════════

import { test } from 'node:test'
import assert from 'node:assert/strict'

const L = await import('../renderer/src/components/media-tools/cover-workflow-logic.ts')

function baseParams(overrides = {}) {
  return {
    size: '1:1',
    count: 4,
    bgColor: '#161828',
    bgTransparent: false,
    productPath: '',
    textContent: '',
    logoPath: '',
    ...overrides,
  }
}

test('buildCoverWorkflow：既有结构保持（type/size/count/layers 完整映射）', () => {
  const body = L.buildCoverWorkflow(baseParams({
    size: '9:16',
    count: 2,
    bgColor: '#ff0000',
    productPath: 'C:/p.png',
    textContent: '大促',
    logoPath: 'C:/l.png',
  }))
  assert.equal(body.type, 'cover')
  assert.equal(body.size, '9:16')
  assert.equal(body.count, 2)
  assert.deepEqual(body.layers, {
    background: { color: '#ff0000' },
    product: { file: 'C:/p.png' },
    text: { content: '大促' },
    logo: { file: 'C:/l.png' },
  })
  // 未填 template/title → 不产生臆造字段
  assert.equal('template' in body, false)
  assert.equal('title' in body, false)
})

test('buildCoverWorkflow：背景透明 → background.transparent 优先', () => {
  const body = L.buildCoverWorkflow(baseParams({ bgTransparent: true }))
  assert.deepEqual(body.layers.background, { transparent: true })
})

test('buildCoverWorkflow：空图层字段 → null（不丢键）', () => {
  const body = L.buildCoverWorkflow(baseParams())
  assert.equal(body.layers.product, null)
  assert.equal(body.layers.text, null)
  assert.equal(body.layers.logo, null)
})

test('buildCoverWorkflow：template/title 非空时透传（对齐 CoverRequest 字段命名）', () => {
  const body = L.buildCoverWorkflow(baseParams({ template: '  tpl-01  ', title: '  限时特惠  ' }))
  assert.equal(body.template, 'tpl-01')
  assert.equal(body.title, '限时特惠')
})

test('buildCoverWorkflow：template/title 全空白 → 不携带', () => {
  const body = L.buildCoverWorkflow(baseParams({ template: '   ', title: '' }))
  assert.equal('template' in body, false)
  assert.equal('title' in body, false)
})

/* ── parseAiCopyJson（对齐原版 safe_json_parse 容错） ── */

test('parseAiCopyJson：纯 JSON 输出 → title/subtitle 提取并 trim', () => {
  const r = L.parseAiCopyJson('{"title": " 爆款 ", "subtitle": " 限时秒杀 "}')
  assert.deepEqual(r, { title: '爆款', subtitle: '限时秒杀' })
})

test('parseAiCopyJson：markdown 代码块/前后说明包裹 → 提取首个 JSON 对象', () => {
  const r = L.parseAiCopyJson('```json\n{"title": "大促", "subtitle": "全场5折"}\n```')
  assert.deepEqual(r, { title: '大促', subtitle: '全场5折' })
  const r2 = L.parseAiCopyJson('好的，建议如下：\n{"title": "A", "subtitle": "B"}\n请查收')
  assert.deepEqual(r2, { title: 'A', subtitle: 'B' })
})

test('parseAiCopyJson：缺字段 → 空串补位', () => {
  const r = L.parseAiCopyJson('{"title": "只有标题"}')
  assert.deepEqual(r, { title: '只有标题', subtitle: '' })
})

test('parseAiCopyJson：无 JSON / 非法 JSON / 空输入 → null（调用方截断回退）', () => {
  assert.equal(L.parseAiCopyJson(''), null)
  assert.equal(L.parseAiCopyJson('纯文本没有 JSON'), null)
  assert.equal(L.parseAiCopyJson('{"title": 未闭合'), null)
  assert.equal(L.parseAiCopyJson('[1,2,3]'), null)
})
