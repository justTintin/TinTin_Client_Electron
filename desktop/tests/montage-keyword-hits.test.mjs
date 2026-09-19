// 关键词命中纯函数单测（2026-09-19 架构：/text_templates/match 删除——
// 词源=产品资料关联关键词（客户端命中），产品未关联词 LLM 兜底提词）
import { test } from 'node:test'
import assert from 'node:assert/strict'

const M = await import('../renderer/src/composables/montageStep4FxBgmLogic.ts')
const P = await import('../renderer/src/composables/opsProductLibraryLogic.ts')

const ROWS = [
  { text: '职业级无线连接，低延迟稳定传输', start: 0, end: 3 },
  { text: '50mm 大驱动单元，沉浸式游戏音效', start: 3, end: 6 },
  { text: '轻量化设计，久戴不累', start: 6, end: 9 },
]

test('matchKeywordHits：词×行窗口命中，templateId=候选池轮转', () => {
  const hits = M.matchKeywordHits(['低延迟', '轻量化', '不存在的词'], ROWS, ['tplA', 'tplB'])
  assert.equal(hits.length, 2)
  assert.equal(hits[0].text, '低延迟')
  assert.deepEqual(hits[0].keywords, ['低延迟'])
  assert.deepEqual({ start: hits[0].start, end: hits[0].end }, { start: 0, end: 3 })
  assert.equal(hits[0].templateId, 'tplA') // 池轮转：0%2=0
  assert.equal(hits[1].text, '轻量化')
  assert.equal(hits[1].templateId, 'tplB') // 1%2=1
})

test('matchKeywordHits：大小写不敏感；空词表/空行 → 空；空池 templateId 为 undefined', () => {
  assert.equal(M.matchKeywordHits(['50MM'], ROWS, []).length, 1)
  assert.equal(M.matchKeywordHits([], ROWS, ['a']).length, 0)
  assert.equal(M.matchKeywordHits(['无线'], [], ['a']).length, 0)
  assert.equal(M.matchKeywordHits(['无线'], ROWS, [])[0].templateId, '')
})

test('parseLlmKeywords：JSON 数组解析 + 去重 + 截断', () => {
  assert.deepEqual(M.parseLlmKeywords('["低延迟","大容量","低延迟","快充"]', 3), ['低延迟', '大容量', '快充'])
  // 带解释文字时截取首个 JSON 数组片段
  assert.deepEqual(M.parseLlmKeywords('好的，关键词如下：["防水","长续航"] 请查收', 8), ['防水', '长续航'])
  // 非 JSON → 文本切分（顿号/逗号/引号剥离）
  assert.deepEqual(M.parseLlmKeywords('低延迟、大容量，快充', 8), ['低延迟', '大容量', '快充'])
  assert.deepEqual(M.parseLlmKeywords('', 8), [])
})

test('parseProductKeywords：产品资料关联词防御解析（string[]/分隔串/多字段名）', () => {
  assert.deepEqual(P.parseProductKeywords({ keywords: ['防水', '快充'] }), ['防水', '快充'])
  assert.deepEqual(P.parseProductKeywords({ keywords: '防水、快充,长续航；轻便' }), ['防水', '快充', '长续航', '轻便'])
  assert.deepEqual(P.parseProductKeywords({ product_keywords: '降噪' }), ['降噪'])
  assert.deepEqual(P.parseProductKeywords({ '关键词': '大容量' }), ['大容量'])
  assert.deepEqual(P.parseProductKeywords({ keywords: [' ', '', '防水', '防水'] }), ['防水'])
  assert.deepEqual(P.parseProductKeywords({}), [])
  assert.deepEqual(P.parseProductKeywords(null), [])
})
