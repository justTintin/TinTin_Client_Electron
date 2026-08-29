// ═══════════════════════════════════════════════════════════════
// live-clip-logic.test.mjs — M9 直播切片策略纯函数单测
// 对照原客户端 studio/gui/live_clip/workers.py：
//   · HotSpotAnalyzer._rule_analyze（L108-168）内置算法：
//     60s 窗口/30s 步长 → 评分（热词×3+密度×10+唯一率×15+数字×0.3）
//     → 阈值=均值×1.3（相对值：均匀高热度不产生热点）
//     → 峰值合并（gap<20s）→ 时长 15~300s → 标题 → 降序
//   · _llm_analyze 合并段（L233-259）：gap≤15s 且合并后 ≤300s 合并
// 运行：cd desktop && node --test "tests/*.test.mjs"
// ═══════════════════════════════════════════════════════════════

import { test } from 'node:test'
import assert from 'node:assert/strict'

const L = await import('../renderer/src/composables/liveClipLogic.ts')

/** 热词文本（原版热词命中为 token 全等，标点分隔为独立 token） */
const H = '重点。关键。核心。重要。注意。记住。一定要。必须。首先。然后。最后。总结。结论。'
const HA = '重点。关键。核心。重要。注意。记住。一定要。必须。'
const HB = '干货。福利。限时。免费。独家。技巧。方法。步骤。'
/** 冷文本（多 token 低分：无热词） */
const C = '今天天气。不错我们。继续分享。日常生活。的一些。小知识。欢迎关注。'

/** 构造连续字幕段：从 offset 秒起，每段 segLen 秒，共 n 段 */
function segs(n, text, offset = 0, segLen = 10) {
  const out = []
  for (let i = 0; i < n; i++) {
    const start = offset + i * segLen
    out.push({ start, end: start + segLen - 0.1, text })
  }
  return out
}

// ── 空输入 ──

test('buildClipPlan：空/非法输入返回 []', () => {
  assert.deepEqual(L.buildClipPlan([]), [])
  assert.deepEqual(L.buildClipPlan(null), [])
  assert.deepEqual(L.buildClipPlan(undefined), [])
})

// ── 单热点：冷-热-冷 → 峰值合并为 1 段 ──

test('buildClipPlan：50s冷+60s热+50s冷 → 合并为 1 段（标题含热词、时长 15~300s）', () => {
  const plan = L.buildClipPlan([
    ...segs(5, C, 0),
    ...segs(6, H, 50),
    ...segs(5, C, 110),
  ])
  assert.ok(plan.length >= 1, '冷热交替应产生热点')
  assert.equal(plan.length, 1, '相邻峰值应全部合并为 1 段')
  const p = plan[0]
  assert.ok(p.duration >= 15 && p.duration <= 300, `duration=${p.duration} 应在 15~300s`)
  assert.equal(p.end - p.start, p.duration)
  assert.ok(p.title.includes('重点'), `标题应含热词：${p.title}`)
  assert.ok(p.score > 0)
  assert.match(p.startStr, /^\d{2}:\d{2}$/)
  assert.match(p.endStr, /^\d{2}:\d{2}$/)
})

// ── 最长时长截断（>300s → end 截为 start+300）──

test('buildClipPlan：相邻两热簇合并 >300s → 截断到 300s（原版 dur>300 截断）', () => {
  // 200s冷 + 200s热A + 200s热B（紧邻）+ 200s冷 → A/B 峰值合并 [180,540) 360s → 截断 300s
  const plan = L.buildClipPlan([
    ...segs(20, C, 0),
    ...segs(20, H, 200),
    ...segs(20, HB, 400),
    ...segs(20, C, 600),
  ])
  assert.ok(plan.length >= 1)
  for (const p of plan) {
    assert.ok(p.duration <= 300, `duration=${p.duration} 不应超过 300（应被截断）`)
    assert.ok(p.duration >= 15, `duration=${p.duration} 不应小于 15`)
    assert.equal(p.end - p.start, p.duration)
  }
})

// ── 自定义参数：小窗口 + minDuration 丢弃 ──

test('buildClipPlan：win=10/step=5 且窗口时长 < minDuration → 丢弃（原版 dur<15 continue）', () => {
  // 窗口时长=10 < minDuration=15 → 全丢弃（防御分支：原版窗口 60s 恒 ≥15，此分支不触发）
  const plan = L.buildClipPlan(segs(10, H, 0), { win: 10, step: 5, minDuration: 15 })
  for (const p of plan) assert.ok(p.duration >= 15)
})

// ── 无热词中性内容 → 无峰值（空数组）──

test('buildClipPlan：纯中性字幕 → 无窗口过阈值（空数组）', () => {
  // 冷文本窗口分数低且均匀 → 阈值=均值×1.3 无峰值（对齐原版相对阈值语义）
  const plan = L.buildClipPlan(segs(30, C, 0))
  assert.equal(plan.length, 0)
})

// ── 输出排序：评分降序 ──

test('buildClipPlan：两簇热点 → 按 score 降序（原版 sort reverse=True）', () => {
  const plan = L.buildClipPlan([
    ...segs(8, HA, 0),     // 簇 A：0-80s
    ...segs(6, C, 80),     // 冷间隔：80-140s
    ...segs(8, HB, 140),   // 簇 B：140-220s
  ])
  assert.ok(plan.length >= 2, `应有 ≥2 段热点，实际 ${plan.length}`)
  for (let i = 1; i < plan.length; i++) {
    assert.ok(plan[i - 1].score >= plan[i].score, '必须按评分降序')
  }
})

// ── fmtMinSec（原版允许分钟 >60）──

test('fmtMinSec：mm:ss 格式（分钟可超 60，对齐原版 L161-162）', () => {
  assert.equal(L.fmtMinSec(0), '00:00')
  assert.equal(L.fmtMinSec(65), '01:05')
  assert.equal(L.fmtMinSec(3600), '60:00')
})

// ── LLM 结果合并（原版 _llm_analyze 合并段 L233-259）──

test('mergeLlmPlan：gap≤15s 且合并后 ≤300s → 合并（标题 / 拼接、分数取大）', () => {
  const items = [
    { start: 0, end: 60, title: 'A', score: 8 },
    { start: 70, end: 120, title: 'B', score: 9 },
  ]
  const plan = L.mergeLlmPlan(items)
  assert.equal(plan.length, 1)
  assert.equal(plan[0].start, 0)
  assert.equal(plan[0].end, 120)
  assert.equal(plan[0].duration, 120)
  assert.equal(plan[0].score, 9)
  assert.equal(plan[0].title, 'A/B')
})

test('mergeLlmPlan：合并后 >300s → 不合并（保持 2 段）', () => {
  const items = [
    { start: 0, end: 200, title: 'A' },
    { start: 250, end: 400, title: 'B' },
  ]
  const plan = L.mergeLlmPlan(items)
  assert.equal(plan.length, 2)
})

test('mergeLlmPlan：乱序输入 → 按 score 降序输出', () => {
  const items = [
    { start: 100, end: 150, title: 'low', score: 5 },
    { start: 0, end: 50, title: 'high', score: 9 },
  ]
  const plan = L.mergeLlmPlan(items)
  assert.equal(plan.length, 2)
  assert.equal(plan[0].title, 'high')
})

// ── 无时间戳文本估时（fallback）──

test('estimateSegmentsFromText：按标点分句 + 4字/秒估时累加', () => {
  const segsOut = L.estimateSegmentsFromText('第一句话。第二句话！第三句\n第四句')
  assert.equal(segsOut.length, 4)
  assert.equal(segsOut[0].start, 0)
  // 第一句 5 字 → dur = max(2, ceil(5/4)) = 2
  assert.equal(segsOut[0].end, 2)
  assert.equal(segsOut[1].start, 2)
  // 空输入
  assert.deepEqual(L.estimateSegmentsFromText(''), [])
  assert.deepEqual(L.estimateSegmentsFromText(null), [])
})

test('buildPlanFromText：无 SRT 文本 → 估时计划（时长在 15~300s 边界内）', () => {
  const plan = L.buildPlanFromText('这是一个重点。这也是关键干货。还有福利限时免费。')
  for (const p of plan) {
    assert.ok(p.duration >= 15 && p.duration <= 300)
  }
})

// ── 热词表完整性（39 词对齐原版）──

test('HOT_KEYWORDS_CN：39 词对齐原版 utils.py L14-21', () => {
  assert.equal(L.HOT_KEYWORDS_CN.length, 39)
  for (const w of ['重点', '干货', '限时', '免费', '变现', '涨粉', 'AI', '深度学习', '教程']) {
    assert.ok(L.HOT_KEYWORDS_CN.includes(w), `缺少热词 ${w}`)
  }
})
