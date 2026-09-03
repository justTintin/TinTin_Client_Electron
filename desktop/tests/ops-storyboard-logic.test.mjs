// ═══════════════════════════════════════════════════════════════
// ops-storyboard-logic.test.mjs — 分镜脚本创作·纯逻辑单测
// 被测：renderer/src/composables/opsStoryboardLogic.ts（纯函数，无 vue 依赖）
// 对照原客户端 gui/storyboard_page.py：
//   · 生成 prompt L2219-2230、解析 _fill_storyboard L2234-2254、
//     镜头默认值 L2130-2142、服务端契约 _upload_storyboard_to_server
//     L1564-1603、topic 清洗 L1496
// 运行：node --test "tests/*.test.mjs"
// ═══════════════════════════════════════════════════════════════

import { test } from 'node:test'
import assert from 'node:assert/strict'

const M = await import('../renderer/src/composables/opsStoryboardLogic.ts')

/* ── 画幅 ───────────────────────────────────────────────────── */

test('ratioToOrient/Full：三档映射 + 未知原样返回', () => {
  assert.equal(M.ratioToOrient('9:16'), '竖屏')
  assert.equal(M.ratioToOrient('16:9'), '横屏')
  assert.equal(M.ratioToOrient('1:1'), '方形')
  assert.equal(M.ratioToOrient('4:3'), '4:3')
  assert.equal(M.ratioToOrientFull('9:16'), '竖屏（9:16）')
})

/* ── 生成 prompt（对齐 L2219-2230） ──────────────────────────── */

test('buildStoryboardPrompt：导演人设 + JSON 字段约定 + 画幅', () => {
  const { systemPrompt, userPrompt } = M.buildStoryboardPrompt('这是一段文案', '16:9')
  assert.ok(systemPrompt.includes('专业短视频导演'))
  assert.ok(userPrompt.includes('横屏（16:9）画幅'))
  assert.ok(userPrompt.includes('"shot_type"'))
  assert.ok(userPrompt.includes('"visual"'))
  assert.ok(userPrompt.includes('"audio"'))
  assert.ok(userPrompt.includes('"sfx"'))
  assert.ok(userPrompt.includes('"duration"'))
  assert.ok(userPrompt.includes('严格只输出 JSON 数组'))
  assert.ok(userPrompt.endsWith('文案：\n这是一段文案'))
})

/* ── 解析（对齐 _fill_storyboard） ───────────────────────────── */

test('parseStoryboardShots：纯 JSON 数组解析 + 字段归一', () => {
  const raw = [
    { index: 1, shot_type: '特写', visual: '产品特写', audio: '台词1', sfx: '叮', duration: 4 },
    { shot_type: '全景', visual: '场景', audio: '台词2', sfx: '', duration: 6 },
  ]
  const { shots, fallback } = M.parseStoryboardShots(JSON.stringify(raw))
  assert.equal(fallback, false)
  assert.equal(shots.length, 2)
  assert.equal(shots[0].index, 1)
  assert.equal(shots[0].material_id, 0)
  assert.equal(shots[1].index, 2, '缺 index 补位序号')
})

test('parseStoryboardShots：剥 ```json 包裹', () => {
  const raw = JSON.stringify([{ index: 1, shot_type: '近景', visual: 'v', audio: 'a', sfx: '', duration: 5 }])
  const wrapped = '```json\n' + raw + '\n```'
  const { shots, fallback } = M.parseStoryboardShots(wrapped)
  assert.equal(fallback, false)
  assert.equal(shots.length, 1)
  assert.equal(shots[0].shot_type, '近景')
})

test('parseStoryboardShots：解析失败回退单镜（原文进 visual）', () => {
  const { shots, fallback } = M.parseStoryboardShots('这不是 JSON 的输出')
  assert.equal(fallback, true)
  assert.equal(shots.length, 1)
  assert.equal(shots[0].index, 1)
  assert.equal(shots[0].visual, '这不是 JSON 的输出')
  assert.equal(shots[0].duration, 5)
  assert.equal(shots[0].shot_type, '近景')
})

test('parseStoryboardShots：非法字段值走默认（对齐 L2130-2142）', () => {
  const { shots } = M.parseStoryboardShots(JSON.stringify([
    { duration: -3, shot_type: '', material_id: '12.7' },
    { duration: 'abc' },
  ]))
  assert.equal(shots[0].duration, 5, '非法时长回退 5 秒')
  assert.equal(shots[0].shot_type, '近景', '空镜别回退近景')
  assert.equal(shots[0].material_id, 12, 'material_id 截断 int 化')
  assert.equal(shots[1].duration, 5)
})

/* ── 时长统计 ───────────────────────────────────────────────── */

test('totalDuration：求和 + 非法值按 0', () => {
  assert.equal(M.totalDuration([4, 6, 5]), 15)
  assert.equal(M.totalDuration([4, NaN, 6]), 10)
  assert.equal(M.totalDuration([]), 0)
})

/* ── topic 清洗 / 默认命名（对齐 L1496） ─────────────────────── */

test('sanitizeTopic：非法字符替换 + 截 40', () => {
  assert.equal(M.sanitizeTopic('a/b\\c:d*e?f"g<h>i|j'), 'a_b_c_d_e_f_g_h_i_j')
  assert.equal(M.sanitizeTopic('行1\r\n行2\t列'), '行1__行2_列')
  assert.equal(M.sanitizeTopic('x'.repeat(50)).length, 40)
  assert.equal(M.sanitizeTopic(''), '')
})

test('defaultStoryboardTopic：分镜脚本_YYYYMMDD_HHMM', () => {
  const name = M.defaultStoryboardTopic(new Date(2026, 7, 31, 9, 5))
  assert.equal(name, '分镜脚本_20260831_0905')
})

/* ── 服务端保存契约（ScriptIn，对齐 L1564-1603） ─────────────── */

test('buildScriptPayload：完整契约（product/顶层四字段/saved_at/统计）', () => {
  const shots = [
    { index: 1, shot_type: '特写', visual: 'v1', audio: 'a1', sfx: 's1', duration: 4, material_path: '', material_type: '', material_hash: '', material_id: 0 },
    { index: 2, shot_type: '全景', visual: 'v2', audio: 'a2', sfx: '', duration: 6, material_path: '/m/x.mp4', material_type: 'video', material_hash: 'h1', material_id: 7.9 },
  ]
  const payload = M.buildScriptPayload({
    topic: '测试/脚本', ratio: '9:16', shots,
    product: { brand: 'A', model: 'V9', category: '清洁', name: 'V9 Pro' },
    now: new Date(2026, 7, 31, 14, 16, 30),
  })
  assert.equal(payload.topic, '测试_脚本')
  assert.equal(payload.ratio, '9:16')
  assert.equal(payload.total_duration, 10)
  assert.equal(payload.shot_count, 2)
  assert.equal(payload.saved_at, '2026-08-31T14:16:30')
  assert.deepEqual(payload.product, { brand: 'A', model: 'V9', category: '清洁', name: 'V9 Pro' })
  assert.equal(payload.brand, 'A')
  assert.equal(payload.model, 'V9')
  assert.equal(payload.category, '清洁')
  assert.equal(payload.name, 'V9 Pro')
  assert.equal(payload.shots[1].material_id, 7, 'material_id int 化')
  assert.equal(payload.shots[1].audio, 'a2', '旁白在 audio 字段')
  assert.ok(!('material_name' in payload.shots[1]), '展示辅助字段不上传')
})

test('buildScriptPayload：空 topic/缺 product 兜底', () => {
  const payload = M.buildScriptPayload({
    topic: '', ratio: '1:1', shots: [],
    product: null, now: new Date(2026, 0, 2, 3, 4, 5),
  })
  assert.equal(payload.topic, '未命名分镜脚本', '空白 topic 兜底默认名')
  assert.equal(M.buildScriptPayload({ topic: '///', ratio: '1:1', shots: [] }).topic, '___',
    '纯非法字符清洗为下划线（对齐原版不二次兜底）')
  assert.deepEqual(payload.product, { brand: '', model: '', category: '', name: '' })
  assert.equal(payload.saved_at, '2026-01-02T03:04:05')
  assert.equal(payload.total_duration, 0)
})

/* -- 已有脚本·继续创作（对齐 _continue_from_script/_apply_server_script） -- */

test('extractScriptItems：{items}|{data}|{results}|裸数组 容错展开；垃圾回空', () => {
  const it = [{ id: 1 }]
  assert.deepEqual(M.extractScriptItems({ items: it }), it)
  assert.deepEqual(M.extractScriptItems({ data: it }), it)
  assert.deepEqual(M.extractScriptItems({ results: it }), it)
  assert.deepEqual(M.extractScriptItems(it), it)
  assert.deepEqual(M.extractScriptItems({ items: 'x' }), [])
  assert.deepEqual(M.extractScriptItems(null), [])
  assert.deepEqual(M.extractScriptItems({}), [])
})

test('toScriptOption：摘要字段映射；无 id 丢弃；label 字段口径', () => {
  const o = M.toScriptOption({ id: 'a1', topic: '春季新品', ratio: '9:16', shot_count: 9, saved_at: '2026-09-03T10:00:00' })
  assert.equal(o.id, 'a1')
  assert.equal(o.topic, '春季新品')
  assert.equal(o.ratio, '9:16')
  assert.equal(o.shotCount, 9)
  assert.equal(o.savedAt, '2026-09-03T10:00:00')
  assert.equal(M.toScriptOption({ topic: 'x' }), null)
  assert.equal(M.toScriptOption({ id: '  ' }), null)
  assert.equal(M.toScriptOption({ id: 7 }).shotCount, 0)
})

test('parseScriptDetail：{script} 包裹 / 裸 dict 兼容；product 优先顶层四字段兑底；垃圾回 null', () => {
  const inner = {
    topic: '开学季', ratio: '16:9', shots: [{ index: 1, audio: 'a' }],
    product: { brand: 'B', model: 'M', category: 'C', name: 'N' },
  }
  const d1 = M.parseScriptDetail({ script: inner })
  assert.equal(d1.topic, '开学季')
  assert.equal(d1.ratio, '16:9')
  assert.equal(d1.shots.length, 1)
  assert.equal(d1.product.brand, 'B')
  // 裸 dict + product 缺失 → 顶层四字段兑底（原 L1814-1818）
  const d2 = M.parseScriptDetail({ ...inner, product: null, brand: 'B2', model: 'M2', category: 'C2', name: 'N2' })
  assert.equal(d2.product.brand, 'B2')
  assert.equal(d2.product.model, 'M2')
  assert.equal(d2.product.category, 'C2')
  // 非 dict shots → 空
  const d3 = M.parseScriptDetail({ topic: 'x', shots: 'bad' })
  assert.deepEqual(d3.shots, [])
  assert.equal(M.parseScriptDetail(null), null)
  assert.equal(M.parseScriptDetail('x'), null)
  assert.deepEqual(M.parseScriptDetail({ script: 'bad' }).shots, [])
})

test('copyFromShots：镜头旁白拼接（过滤空行）；原 L1801-1802 口径', () => {
  assert.equal(M.copyFromShots([{ audio: ' 第一句 ' }, { audio: '' }, { visual: 'x' }, { audio: '第二句' }]), '第一句\n第二句')
  assert.equal(M.copyFromShots([]), '')
  assert.equal(M.copyFromShots([{ audio: null }]), '')
})

test('buildAdjustCopyPrompt：原始文案 + 额外要求 + 固定指令（原 _adjust_copy 口径）', () => {
  const { systemPrompt, userPrompt } = M.buildAdjustCopyPrompt({ copyText: '原文案', extraPrompt: '精简' })
  assert.ok(systemPrompt.includes('优化和调整'))
  assert.ok(userPrompt.includes('原始视频文案：\n原文案'))
  assert.ok(userPrompt.includes('额外要求：\n精简'))
  assert.ok(userPrompt.includes('保持核心信息不变'))
  // 空 extra/style 不产生空段
  const { userPrompt: u2 } = M.buildAdjustCopyPrompt({ copyText: 'x' })
  assert.ok(!u2.includes('额外要求'))
  assert.ok(!u2.includes('风格化要求'))
  // styleText 存在时输出风格段（知识库批次接入即生效）
  const { userPrompt: u3 } = M.buildAdjustCopyPrompt({ copyText: 'x', styleText: '克制冷静' })
  assert.ok(u3.includes('风格化要求（HOW to write）：\n克制冷静'))
})
