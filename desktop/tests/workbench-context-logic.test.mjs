// ═══════════════════════════════════════════════════════════════
// workbench-context-logic.test.mjs — 工作台输入区重排·纯逻辑单测
// 被测：renderer/src/composables/workbenchChatContext.ts（纯函数，无 vue 依赖）
// 对照原客户端 gui/agent_home_page.py：
//   · _AgentLoader L707-725（GET /agent/agents 过滤 exposed=False → {id,name,desc}）
//   · _SlashPopup L254-259/294-307（is_agent_prefix / 名称+描述过滤）
//   · _insert_agent L338-361（移除 /关键字 段插入唤醒词）
//   · _product_summary L1320-1334 / _material_summary L1336-1350 /
//     _script_summary L1352-1366 / _build_context_text L1733-1751
//   · _AgentBar L728-807（每行 10 个/超出折叠 → 桌面端按可用宽度 fitCount 收纳）
//   · _MEDIA_TYPE_LABEL L64（image/video/audio/document 标签）
// 运行：node --test "tests/*.test.mjs"
// ═══════════════════════════════════════════════════════════════

import { test } from 'node:test'
import assert from 'node:assert/strict'

const C = await import('../renderer/src/composables/workbenchChatContext.ts')

const AGENTS = [
  { id: 'copywriting', name: '文案大师', desc: '短视频文案创作' },
  { id: 'negative', name: '负面分析师', desc: '负向词排查与规避' },
  { id: 'hidden', name: '隐藏智能体', desc: '不对外', exposed: false }
]

/* ── 智能体列表解析（GET /agent/agents） ───────────────────── */

test('parseAgentsResponse：{agents:[…]} 形态 → 映射 id/name/desc', () => {
  const r = C.parseAgentsResponse({ agents: [
    { agent_id: 'copywriting', name: '文案大师', desc: '短视频文案创作', version: '1.0' }
  ] })
  assert.deepEqual(r, [{ id: 'copywriting', name: '文案大师', desc: '短视频文案创作' }])
})

test('parseAgentsResponse：裸数组形态（原版 get_agents 兼容两种返回）', () => {
  const r = C.parseAgentsResponse([{ agent_id: 'a1', name: 'A1' }])
  assert.equal(r.length, 1)
  assert.equal(r[0].id, 'a1')
  assert.equal(r[0].name, 'A1')
  assert.equal(r[0].desc, '')
})

test('parseAgentsResponse：exposed=False 过滤（原版 _AgentLoader L715-716）', () => {
  const r = C.parseAgentsResponse({ agents: [
    { agent_id: 'a', name: 'A', exposed: true },
    { agent_id: 'b', name: 'B', exposed: false },
    { agent_id: 'c', name: 'C' }
  ] })
  assert.deepEqual(r.map((x) => x.id), ['a', 'c'])
})

test('parseAgentsResponse：异常/脏数据 → 空数组（回退仅「对话」项）', () => {
  assert.deepEqual(C.parseAgentsResponse(null), [])
  assert.deepEqual(C.parseAgentsResponse('junk'), [])
  assert.deepEqual(C.parseAgentsResponse({ agents: [null, 42, { name: 'n' }] }).length, 1)
})

/* ── 快捷条条目（首项固定「对话」） ─────────────────────────── */

test('buildQuickEntries：首项固定「对话」(llm)，其余为 agent', () => {
  const r = C.buildQuickEntries(AGENTS.filter((a) => a.id !== 'hidden'))
  assert.equal(r.length, 3)
  assert.equal(r[0].key, C.CHAT_ENTRY_KEY)
  assert.equal(r[0].kind, 'llm')
  assert.equal(r[0].name, '对话')
  assert.equal(r[1].kind, 'agent')
  assert.equal(r[1].name, '文案大师')
})

test('buildQuickEntries：空列表 → 仅「对话」项（失败回退口径）', () => {
  const r = C.buildQuickEntries([])
  assert.equal(r.length, 1)
  assert.equal(r[0].name, '对话')
})

/* ── 斜杠菜单（原版 _SlashPopup 口径） ─────────────────────── */

test('isAgentPrefix：空关键字=true；关键字命中任一智能体名=true（L254-259）', () => {
  assert.equal(C.isAgentPrefix(AGENTS, ''), true)
  assert.equal(C.isAgentPrefix(AGENTS, '文案'), true)
  assert.equal(C.isAgentPrefix(AGENTS, '文案大师X'), false)
  assert.equal(C.isAgentPrefix(AGENTS, '负面'), true)
})

test('filterSlashCandidates：名称或描述包含关键字（大小写不敏感）', () => {
  assert.deepEqual(C.filterSlashCandidates(AGENTS, '文案').map((a) => a.id), ['copywriting'])
  assert.deepEqual(C.filterSlashCandidates(AGENTS, '规避').map((a) => a.id), ['negative'])
  assert.deepEqual(C.filterSlashCandidates(AGENTS, '分析').map((a) => a.id), ['negative'])
  assert.equal(C.filterSlashCandidates(AGENTS, '').length, 3)
})

test('detectSlashKeyword：光标前 /([^\s/]*)$ 提取关键字（L191）', () => {
  assert.deepEqual(C.detectSlashKeyword('/neg', 4), 'neg')
  assert.deepEqual(C.detectSlashKeyword('帮我 /st', 7), 'st')
  assert.deepEqual(C.detectSlashKeyword('https://a.com/b', 15), 'b')
  assert.deepEqual(C.detectSlashKeyword('没有斜杠', 4), null)
  assert.deepEqual(C.detectSlashKeyword('/斜杠 关键字', 10), null)
  assert.deepEqual(C.detectSlashKeyword('/', 1), '')
})

test('buildAgentWakeText：带描述/不带描述（L358-361）', () => {
  assert.equal(C.buildAgentWakeText({ id: 'a', name: '文案大师', desc: '写文案' }),
    '请【文案大师】智能体执行：写文案')
  assert.equal(C.buildAgentWakeText({ id: 'a', name: '文案大师', desc: '' }),
    '请【文案大师】智能体执行')
})

test('applyAgentWakeInsert：移除 /关键字 段并插入唤醒词（L338-361）', () => {
  const r = C.applyAgentWakeInsert('/neg 帮我看看', 4, { id: 'n', name: '负面分析师', desc: '' })
  assert.ok(r.text.startsWith('请【负面分析师】智能体执行'), '唤醒词插入原 /段 位置')
  assert.ok(r.text.slice(r.caret).startsWith(' 帮我看看'), '光标停在唤醒词末尾（原版插入后光标即当前位置）')
  assert.ok(r.text.includes('帮我看看'))
})

test('applyAgentWakeInsert：唤醒词前无内容时不留多余空隙', () => {
  const r = C.applyAgentWakeInsert('/neg', 4, { id: 'n', name: '负面分析师', desc: '' })
  assert.equal(r.text, '请【负面分析师】智能体执行')
})

/* ── 快捷条收纳（原版 _AgentBar 折叠 → 宽度自适应） ─────────── */

test('estimateEntryWidth：中文按 12px/字、ASCII 按 7px/字 + 固定内边距，且有上限', () => {
  assert.equal(C.estimateEntryWidth('对话'), 24 + 2 + 24)
  assert.ok(C.estimateEntryWidth('ab') < C.estimateEntryWidth('中文中文'))
  assert.ok(C.estimateEntryWidth('特别特别特别长的智能体名称') <= C.QUICK_ENTRY_MAX_WIDTH)
})

test('fitCount：全部放得下 → 全显且不出现「更多」', () => {
  const widths = [80, 80, 80]
  assert.deepEqual(C.fitQuickBar(widths, 260, { gap: 6, more: 64 }), { count: 3, more: false })
})

test('fitCount：放不下 → 收纳并预留「更多」按钮宽度（L776-807 折叠口径）', () => {
  const widths = [80, 80, 80, 80, 80]
  // 前两个 80*2+6=166 + 6(gap) + 64(more) = 236 ≤ 300；再加一个超
  const r = C.fitQuickBar(widths, 300, { gap: 6, more: 64 })
  assert.equal(r.count, 2)
  assert.equal(r.more, true)
})

test('fitQuickBar：可用宽度极窄 → 至少收纳到 0 个并强制显示「更多」', () => {
  const r = C.fitQuickBar([80, 80], 50, { gap: 6, more: 64 })
  assert.equal(r.more, true)
  assert.ok(r.count >= 0)
})

/* ── 对话上下文编组（原版 _build_context_text L1733-1751） ──── */

const PRODUCT = { id: 'p1', brand: '品牌A', model: 'X100', category: '手机', goods_no: 'G001', features: '续航长', selling_points: '便宜大碗' }
const MATERIAL = { id: 'm1', filename: '开箱.mp4', media_type: 'video', brand: '品牌A', model: 'X100', path: '/srv/m1.mp4' }
const SCRIPT = { id: 's1', topic: '新品开箱', shot_count: 5, ratio: '9:16', saved_at: '2026-08-28 10:00:00' }

test('productSummary：品牌/型号/品类/货号 + 性能/卖点截断 300（L1320-1334）', () => {
  const t = C.productSummary(PRODUCT)
  assert.ok(t.includes('品牌:品牌A'))
  assert.ok(t.includes('型号:X100'))
  assert.ok(t.includes('品类:手机'))
  assert.ok(t.includes('货号:G001'))
  assert.ok(t.includes('性能:续航长'))
  assert.ok(t.includes('卖点:便宜大碗'))
  const long = C.productSummary({ ...PRODUCT, features: 'x'.repeat(400) })
  assert.ok(long.includes('x'.repeat(300)))
  assert.ok(!long.includes('x'.repeat(301)))
})

test('materialSummary：ID/文件名/类型/品牌型号/路径（L1336-1350）', () => {
  const t = C.materialSummary(MATERIAL)
  assert.ok(t.includes('素材ID:m1'))
  assert.ok(t.includes('文件名:开箱.mp4'))
  assert.ok(t.includes('类型:视频'))
  assert.ok(t.includes('品牌:品牌A'))
  assert.ok(t.includes('路径:/srv/m1.mp4'))
})

test('scriptSummary：ID/主题/镜头数/画幅/保存时间（L1352-1366）', () => {
  const t = C.scriptSummary(SCRIPT)
  assert.ok(t.includes('脚本ID:s1'))
  assert.ok(t.includes('主题:新品开箱'))
  assert.ok(t.includes('镜头数:5'))
  assert.ok(t.includes('画幅:9:16'))
  assert.ok(t.includes('保存时间:2026-08-28 10:00:00'))
})

test('buildContextText：agent 模式只拼产品/脚本（素材/附件走服务端素材池）', () => {
  const t = C.buildContextText({
    product: PRODUCT,
    scripts: [SCRIPT],
    atts: [
      { name: '开箱.mp4', path: '', materialId: 'm1', material: MATERIAL, state: 'pooled' },
      { name: 'a.mp4', path: 'D:\\a.mp4', state: 'pooled' }
    ],
    poolMode: true
  })
  assert.ok(t.startsWith('【产品】'))
  assert.ok(t.includes('【脚本】'))
  assert.ok(!t.includes('【素材】'))
  assert.ok(!t.includes('【附件】'))
  // 消息增强顺序：text + \n\n + ctx（原版 _send_text L1244-1246）
  assert.equal(C.appendContextText('用户输入', t), '用户输入\n\n' + t)
})

test('buildContextText：llm 模式全文本拼接（产品/素材/脚本/附件）', () => {
  const t = C.buildContextText({
    product: PRODUCT,
    scripts: [SCRIPT],
    atts: [
      { name: '开箱.mp4', path: '', materialId: 'm1', material: MATERIAL, state: 'pending' },
      { name: 'a.mp4', path: 'D:\\a.mp4', state: 'pending' }
    ],
    poolMode: false
  })
  const order = ['【产品】', '【素材】', '【脚本】', '【附件】'].map((k) => t.indexOf(k))
  assert.ok(order.every((i) => i >= 0), '四个段都存在')
  assert.deepEqual(order, [...order].sort((a, b) => a - b), '顺序=产品→素材→脚本→附件')
  assert.ok(t.includes('素材ID:m1'))
  assert.ok(t.includes('- a.mp4（D:\\a.mp4）'))
})

test('buildContextText：空上下文 → 空串', () => {
  assert.equal(C.buildContextText({ product: null, scripts: [], atts: [], poolMode: true }), '')
  assert.equal(C.appendContextText('原文', ''), '原文')
})

test('buildContextText：infoOnly 截图附件任何模式都拼文本（不入素材池）', () => {
  const base = {
    product: PRODUCT,
    scripts: [SCRIPT],
    atts: [
      { name: 'a.mp4', path: 'D:\\a.mp4', state: 'pooled' },
      { name: '截图.png', path: 'D:\\paste\\x.png', state: 'pending', infoOnly: true }
    ]
  }
  // agent 模式：普通附件不拼，但 infoOnly 截图必拼（服务端才能读到信息）
  const agent = C.buildContextText({ ...base, poolMode: true })
  assert.ok(agent.includes('【附件】'), 'agent 模式截图附件拼文本')
  assert.ok(agent.includes('- 截图.png（D:\\paste\\x.png）'))
  assert.ok(!agent.includes('- a.mp4'), 'agent 模式普通附件仍不拼')
  // llm 模式：两者都拼
  const llm = C.buildContextText({ ...base, poolMode: false })
  assert.ok(llm.includes('- 截图.png（D:\\paste\\x.png）'))
  assert.ok(llm.includes('- a.mp4（D:\\a.mp4）'))
})

/* ── 弹窗列表容错解析（{items}|{data}|{results}|裸数组） ────── */

test('pickListItems：兼容 items/data/results/裸数组/异常空', () => {
  assert.deepEqual(C.pickListItems({ items: [{ a: 1 }] }), [{ a: 1 }])
  assert.deepEqual(C.pickListItems({ data: [{ b: 2 }] }), [{ b: 2 }])
  assert.deepEqual(C.pickListItems({ results: [{ c: 3 }] }), [{ c: 3 }])
  assert.deepEqual(C.pickListItems([{ x: 4 }]), [{ x: 4 }])
  assert.deepEqual(C.pickListItems(null), [])
  assert.deepEqual(C.pickListItems({ items: 'not-array' }), [])
  assert.deepEqual(C.pickListItems([4]), [], '非对象条目剔除（防御脏数据）')
})

test('mediaTypeLabel：原版 _MEDIA_TYPE_LABEL L64 映射', () => {
  assert.equal(C.mediaTypeLabel('video'), '视频')
  assert.equal(C.mediaTypeLabel('IMAGE'), '图片')
  assert.equal(C.mediaTypeLabel('audio'), '音频')
  assert.equal(C.mediaTypeLabel('document'), '文档')
  assert.equal(C.mediaTypeLabel('other'), '素材')
})

test('productLabel / materialLabel / scriptLabel：胶囊展示文案（_rebuild_ctx_bar L1581-1594）', () => {
  assert.equal(C.productLabel(PRODUCT), '品牌A / X100')
  assert.equal(C.materialLabel(MATERIAL), '[视频] 开箱.mp4')
  assert.equal(C.scriptLabel(SCRIPT), '[新品开箱] 5镜')
})

test('searchErrorText：网络失败/5xx 异常分支文案', () => {
  assert.ok(C.searchErrorText(null).includes('网络异常'))
  assert.ok(C.searchErrorText(new Error('HTTP 500')).includes('HTTP 500'))
})
