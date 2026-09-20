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

test('parseProductKeywords：严格读取 keywords 字段（2026-09-19 服务端实测 ProductItemOut.keywords: string[]；铁律6 不猜测不兜底）', () => {
  assert.deepEqual(P.parseProductKeywords({ keywords: ['防水', '快充'] }), ['防水', '快充'])
  assert.deepEqual(P.parseProductKeywords({ keywords: '防水、快充,长续航；轻便' }), ['防水', '快充', '长续航', '轻便'])
  assert.deepEqual(P.parseProductKeywords({ keywords: [' ', '', '防水', '防水'] }), ['防水'])
  // 其余候选字段名不再回退（服务端实测字段=keywords，契约已声明 ProductSearchOut/ProductItemOut）
  assert.deepEqual(P.parseProductKeywords({ product_keywords: '降噪' }), [])
  assert.deepEqual(P.parseProductKeywords({ '关键词': '大容量' }), [])
  assert.deepEqual(P.parseProductKeywords({}), [])
  assert.deepEqual(P.parseProductKeywords(null), [])
})

// ── 2026-09-19 用户裁决：一个字幕段只出一条文字模板（同段多命中取词表序最前）──

test('matchKeywordHits：一字幕段只出一条文字模板（词表序优先），不同段各自出条', () => {
  const rows = [
    { text: '低延迟稳定传输，大容量长续航', start: 0, end: 4 },
    { text: '防水轻便', start: 4, end: 7 },
  ]
  const out = M.matchKeywordHits(['大容量', '低延迟', '防水'], rows, ['t1', 't2'])
  // 第一段同时命中『大容量/低延迟』→ 只取词表序最前的『大容量』一条，不叠第二条
  assert.equal(out.length, 2)
  assert.equal(out[0].text, '大容量')
  assert.deepEqual([out[0].start, out[0].end], [0, 4])
  assert.equal(out[0].templateId, 't1')
  // 第二段独立命中 → 照常出条
  assert.equal(out[1].text, '防水')
  assert.equal(out[1].templateId, 't2')
})

test('matchKeywordHits：row.chars 存在时命中窗口=词首末字符实测起止（字级精度）', () => {
  const rows = [{
    text: '专业级无感延迟，',
    start: 7.646, end: 9.388,
    chars: [
      { c: '专', start: 7.646, end: 7.9 },
      { c: '业', start: 7.9, end: 8.1 },
      { c: '级', start: 8.1, end: 8.3 },
      { c: '无', start: 8.35, end: 8.6 },
      { c: '感', start: 8.6, end: 8.85 },
      { c: '延', start: 8.9, end: 9.1 },
      { c: '迟', start: 9.1, end: 9.35 },
      { c: '，', start: null, end: null },
    ],
  }]
  const out = M.matchKeywordHits(['无感延迟'], rows, ['t1'])
  assert.deepEqual([out[0].start, out[0].end], [8.35, 9.35])
  const out2 = M.matchKeywordHits(['无感延迟'], [{ text: '专业级无感延迟，', start: 7.646, end: 9.388 }], ['t1'])
  assert.deepEqual([out2[0].start, out2[0].end], [7.646, 9.388])
})

// ── 2026-09-20 用户报障：关键词未与字级对齐时间线挂钩、命中词条「两个挤一起」──
// 实机产物（whisperx）：chars 里大量 0/0（词流未识别）与 null（标点）——两者都是
// 「无效 span」哨兵；修复前 Number(null)=0 且 0 有限被当词级真值，命中窗口塌到 0。

test('matchKeywordHits：chars 含 null/0、0 哨兵——只取有效字符窗口，全无效回退行窗口', () => {
  // 部分有效：命中词内仅『配』有实测值 → 窗口=该字实测起止，不塌到 0
  const rows = [{
    text: '粉色限定配色，',
    start: 28.002, end: 28.371,
    chars: [
      { c: '粉', start: 0, end: 0 },
      { c: '色', start: 0, end: 0 },
      { c: '限', start: 0, end: 0 },
      { c: '定', start: 0, end: 0 },
      { c: '配', start: 28.002, end: 28.166 },
      { c: '色', start: 0, end: 0 },
      { c: '，', start: null, end: null },
    ],
  }]
  const out = M.matchKeywordHits(['限定配色'], rows, ['t1'])
  assert.deepEqual([out[0].start, out[0].end], [28.002, 28.166])
  // 全无效（0/0）→ 回退行窗口（不取 0）
  const rows2 = [{
    text: '超轻机身搭配记忆泡沫耳罩，',
    start: 25.949, end: 28.166,
    chars: [
      { c: '超', start: 0, end: 0 }, { c: '轻', start: 0, end: 0 }, { c: '机', start: 0, end: 0 },
      { c: '身', start: 0, end: 0 }, { c: '搭', start: 0, end: 0 }, { c: '配', start: 0, end: 0 },
      { c: '记', start: 0, end: 0 }, { c: '忆', start: 0, end: 0 }, { c: '泡', start: 0, end: 0 },
      { c: '沫', start: 0, end: 0 }, { c: '耳', start: 0, end: 0 }, { c: '罩', start: 0, end: 0 },
      { c: '，', start: null, end: null },
    ],
  }]
  const out2 = M.matchKeywordHits(['记忆泡沫'], rows2, ['t1'])
  assert.deepEqual([out2[0].start, out2[0].end], [25.949, 28.166])
})
