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

// ── SRT 生成 / 裁剪（M9 补齐：原版 _format_timestamp / _RemoteWorker / slice_srt）──

test('formatSrtTimestamp：hh:mm:ss,mmm 进位链对齐原版 page.py L742-756', () => {
  assert.equal(L.formatSrtTimestamp(0), '00:00:00,000')
  assert.equal(L.formatSrtTimestamp(59.5), '00:00:59,500')
  assert.equal(L.formatSrtTimestamp(3661.5), '01:01:01,500')
  // ms==1000 → 秒进位（原版 L747-755 链式进位）
  assert.equal(L.formatSrtTimestamp(0.99999), '00:00:01,000')
  assert.equal(L.formatSrtTimestamp(59.99999), '00:01:00,000')
  assert.equal(L.formatSrtTimestamp(3599.99999), '01:00:00,000')
  // 负数兜底 0
  assert.equal(L.formatSrtTimestamp(-5), '00:00:00,000')
})

test('buildSrtFromSegments：序号/时间轴/空行格式对齐原版 _RemoteWorker L484-492', () => {
  const srt = L.buildSrtFromSegments([
    { start: 0, end: 2.5, text: ' 第一行 ' },
    { start: 3, end: 5, text: '第二行\n换行' },
  ])
  const lines = srt.split('\n')
  assert.equal(lines[0], '1')
  assert.equal(lines[1], '00:00:00,000 --> 00:00:02,500')
  assert.equal(lines[2], '第一行')
  assert.equal(lines[3], '')
  assert.equal(lines[4], '2')
  assert.equal(lines[6], '第二行 换行') // text 内换行替换为空格
  // 空输入
  assert.equal(L.buildSrtFromSegments([]), '')
  assert.equal(L.buildSrtFromSegments(null), '')
})

test('clipSegmentsForRange：重叠保留平移、不重叠过滤（原版 slice_srt L72-76 语义）', () => {
  const segs = [
    { start: 0, end: 10, text: 'a' },
    { start: 8, end: 14, text: 'b' },
    { start: 20, end: 30, text: 'c' },
  ]
  const out = L.clipSegmentsForRange(segs, 10, 20)
  // a: end=10 不 > startSec=10 → 丢；b: 8<20 && 14>10 → 平移保留；c: 20 不 < 20 → 丢
  assert.equal(out.length, 1)
  assert.deepEqual(out[0], { start: 0, end: 4, text: 'b' })
  // 空输入
  assert.deepEqual(L.clipSegmentsForRange(null, 0, 10), [])
})

// ── LLM 分析（M9 接线：原版 _llm_analyze 请求段 L172-231）──

test('buildLlmChunks：[mm:ss] text 行 + 4000 字符分块 + 5 行重叠（原版 L172-193）', () => {
  // 单块：短字幕全部进一个块
  const small = L.buildLlmChunks([{ start: 75, end: 80, text: '大分钟偏移' }])
  assert.equal(small.length, 1)
  assert.equal(small[0], '[01:15] 大分钟偏移')
  // 多块：构造长字幕（每行约 30 字符，145 行 > 4000 字符 → ≥2 块，第二块首 5 行 =第一块末 5 行）
  const long = []
  for (let i = 0; i < 145; i++) long.push({ start: i * 2, end: i * 2 + 2, text: `第${i}句测试文本内容固定长度二十几个字符左右啊` })
  const chunks = L.buildLlmChunks(long)
  assert.ok(chunks.length >= 2, `应分多块，实际 ${chunks.length}`)
  const lastLines = (s) => s.split('\n')
  const firstTail = lastLines(chunks[0]).slice(-5)
  const secondHead = lastLines(chunks[1]).slice(0, 5)
  assert.deepEqual(secondHead, firstTail, '第二块前 5 行应与第一块末 5 行重叠')
  // 空输入
  assert.deepEqual(L.buildLlmChunks([]), [])
  assert.deepEqual(L.buildLlmChunks(null), [])
})

test('buildLlmPrompt：逐字保留原版 prompt 结构 + 拼接分块', () => {
  const p = L.buildLlmPrompt('[00:10] 内容')
  assert.ok(p.startsWith('你是专业的直播视频内容分析师'))
  assert.ok(p.includes('【分析与剪裁规则】'))
  assert.ok(p.includes('【输出格式要求】'))
  assert.ok(p.includes('不要转换为 `时:分:秒`'))
  assert.ok(p.endsWith('【待分析字幕文本】：\n[00:10] 内容'))
})

test('parseLlmPlanResponse：纯 JSON / ```块 / 方括号块 + mm:ss→秒 + score 默认 5.0', () => {
  // 纯 JSON 数组
  const a = L.parseLlmPlanResponse('[{"start":"12:34","end":"13:04","title":"甲","score":8.5}]')
  assert.equal(a.length, 1)
  assert.equal(a[0].start, 12 * 60 + 34)
  assert.equal(a[0].end, 13 * 60 + 4)
  assert.equal(a[0].score, 8.5)
  // Markdown 代码块包裹
  const b = L.parseLlmPlanResponse('结果如下：\n```json\n[{"start":"00:05","end":"00:35","title":"乙"}]\n```\n以上')
  assert.equal(b.length, 1)
  assert.equal(b[0].start, 5)
  assert.equal(b[0].score, 5.0) // 默认分
  // 大分钟 75:20（原版 prompt 明确允许）
  const c = L.parseLlmPlanResponse('[{"start":"75:20","end":"76:00","title":"丙"}]')
  assert.equal(c[0].start, 75 * 60 + 20)
  // 非法项过滤（end<=start / 非法时间）
  const d = L.parseLlmPlanResponse('[{"start":"01:00","end":"00:30","title":"逆序"},{"start":"bad","end":"02:00"},{"start":"01:00","end":"02:00","title":"有效"}]')
  assert.equal(d.length, 1)
  assert.equal(d[0].title, '有效')
  // 解析失败 → []
  assert.deepEqual(L.parseLlmPlanResponse('完全不是 JSON'), [])
  assert.deepEqual(L.parseLlmPlanResponse(''), [])
  assert.deepEqual(L.parseLlmPlanResponse(null), [])
})

test('mergeLlmPlan：相邻 gap≤15 且合并后 ≤300 合并、标题 / 连接截 25（原版 L233-251）', () => {
  const merged = L.mergeLlmPlan([
    { start: 0, end: 60, title: '甲', score: 5 },
    { start: 70, end: 120, title: '乙', score: 9 }, // gap 10 → 合并
    { start: 300, end: 360, title: '丙', score: 7 }, // gap 180 → 独立
  ])
  assert.equal(merged.length, 2)
  // 合并块：end 取 max(120)，score 取 max(9)，标题甲/乙
  const m = merged.find((x) => x.start === 0)
  assert.equal(m.end, 120)
  assert.equal(m.score, 9)
  assert.equal(m.title, '甲/乙')
})

// ── 切片命名 / 评分过滤（M9 补齐）──

test('clipFileName：clip_NNN_标题.mp4，非法字符→_，截 30，序号补零（原版 L280-281）', () => {
  assert.equal(L.clipFileName(0, '精彩片段：第一期!'), 'clip_001_精彩片段_第一期_.mp4')
  assert.equal(L.clipFileName(9, 'abc'), 'clip_010_abc.mp4')
  const long = L.clipFileName(0, '标'.repeat(40))
  assert.ok(long.startsWith('clip_001_'))
  // 标题截 30 字（30 个「标」）
  assert.ok(long.includes('标'.repeat(30)))
  assert.ok(!long.includes('标'.repeat(31)))
  // 空标题兜底 'clip'（原版 clip.get("title", "clip")）
  assert.equal(L.clipFileName(2, ''), 'clip_003_clip.mp4')
})

test('SCORE_FILTER_OPTIONS：7 档对齐原版 page.py L264-272，默认 ≥9.0', () => {
  assert.equal(L.SCORE_FILTER_OPTIONS.length, 7)
  assert.deepEqual(L.SCORE_FILTER_OPTIONS.map((o) => o.value), [0, 3, 5, 6, 7, 8, 9])
  assert.equal(L.SCORE_FILTER_DEFAULT, 9.0)
})

test('scoreClass：≥7 绿 / ≥5 黄（原版 _on_analysis L682-685）', () => {
  assert.equal(L.scoreClass(7), 'score-high')
  assert.equal(L.scoreClass(9.5), 'score-high')
  assert.equal(L.scoreClass(5), 'score-mid')
  assert.equal(L.scoreClass(4.9), '')
})
