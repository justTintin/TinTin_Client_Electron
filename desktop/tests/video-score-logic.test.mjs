// ══════════════════════════════════════════════════════════════
// video-score-logic.test.mjs — 视频评价预测纯函数单测
// 被测：renderer/src/composables/videoScoreLogic.ts
// 对照原客户端：
//   · studio/gui/hook_score_page.py
//       _sample_times（前3秒密集 0.5/1.5/2.5 + span>3.2 时 9 帧覆盖前20秒）
//       HookScoreWorker.do_work（sys_prompt / content 拼接 / safe_json_parse）
//       RadarChartWidget.paintEvent（170×170，r_max=55，4 圈网格，标签 r_max+13）
//   · studio/utils/video_prediction_manager.py
//       PLATFORMS / recent_with_feedback(limit=12) / pending_feedback / calibration_text
// 运行：cd desktop && node --test "tests/*.test.mjs"
// ══════════════════════════════════════════════════════════════
import { test } from 'node:test'
import assert from 'node:assert/strict'

const L = await import('../renderer/src/composables/videoScoreLogic.ts')

/** 造帧 */
function frame(timeSec, base64 = 'QUJD') {
  return { path: `/tmp/f_${timeSec}.jpg`, timeSec, base64 }
}

/** 造一条预测记录 */
function rec(over = {}) {
  return Object.assign({
    id: 'a1',
    video_path: 'D:\\v\\a.mp4',
    video_name: 'a.mp4',
    platform: '抖音',
    predicted: { total: 85, play_level: '优质' },
    actual: { play_count: '1.2万', platform_eval: '不错', at: 1 },
    created_at: 1,
  }, over)
}

// ── 常量定义 ────────────────────────────────────────────────────

test('PLATFORMS：与 video_prediction_manager.PLATFORMS 同序', () => {
  assert.deepEqual([...L.PLATFORMS], ['抖音', '小红书', '视频号', 'B站', '快手'])
})

test('DIMENSIONS：6 维且顺序对照原版', () => {
  assert.deepEqual(
    [...L.DIMENSIONS],
    ['吸睛力', '画面冲击', '悬念信息', '节奏', '完播预测', '平台适配']
  )
})

test('DIM_COLORS：每维都有配色（对照 DIM_COLORS）', () => {
  for (const d of L.DIMENSIONS) {
    assert.match(L.DIM_COLORS[d], /^#[0-9a-f]{6}$/i, `${d} 缺配色`)
  }
})

// ── sampleTimes（关键帧时间点）──────────────────────────────────

test('sampleTimes：dur=0（未知时长）→ 前3秒密集 + 9 帧覆盖前20秒，共 12 帧', () => {
  assert.deepEqual(L.sampleTimes(0), [
    0.5, 1.5, 2.5, 3.9, 5.8, 7.7, 9.6, 11.5, 13.4, 15.3, 17.2, 19.1,
  ])
})

test('sampleTimes：长视频 span 被截到 20 秒（对照 min(20.0, dur)）', () => {
  assert.deepEqual(L.sampleTimes(60), L.sampleTimes(0))
  assert.deepEqual(L.sampleTimes(600), L.sampleTimes(0))
})

test('sampleTimes：dur=15 → 9 帧均匀落在 3~15 秒且全部 < dur', () => {
  assert.deepEqual(L.sampleTimes(15), [
    0.5, 1.5, 2.5, 3.7, 5, 6.3, 7.7, 9, 10.3, 11.7, 13, 14.3,
  ])
})

test('sampleTimes：span<=3.2 不生成后段帧，且过滤 t>=dur', () => {
  assert.deepEqual(L.sampleTimes(3.2), [0.5, 1.5, 2.5])
  assert.deepEqual(L.sampleTimes(3), [0.5, 1.5, 2.5])
  assert.deepEqual(L.sampleTimes(2), [0.5, 1.5], '2.5s 被 t<dur 过滤')
  assert.deepEqual(L.sampleTimes(1), [0.5])
})

test('sampleTimes：极短视频全部被过滤 → 兜底 [0.5]', () => {
  assert.deepEqual(L.sampleTimes(0.3), [0.5])
  assert.deepEqual(L.sampleTimes(0.1), [0.5])
})

test('sampleTimes：NaN/undefined 走「时长未知」分支（对照 Python dur or 20.0）', () => {
  assert.deepEqual(L.sampleTimes(NaN), L.sampleTimes(0))
  assert.deepEqual(L.sampleTimes(undefined), L.sampleTimes(0))
})

test('sampleTimes：span>3.2 的临界值 3.3 生成的帧全部合法（递增且 < dur）', () => {
  const t = L.sampleTimes(3.3)
  assert.ok(t.length > 3, '应额外生成后段帧')
  for (const x of t) assert.ok(x < 3.3, `${x} 必须 < dur`)
  for (let i = 1; i < t.length; i++) assert.ok(t[i] >= t[i - 1], '必须非递减')
})

// ── parseScoreResponse（结果归一化）─────────────────────────────

const GOOD = JSON.stringify({
  total: 82,
  play_level: '优质',
  golden3s: true,
  dims: { 吸睛力: 80, 画面冲击: 75, 悬念信息: 70, 节奏: 85, 完播预测: 78, 平台适配: 90 },
  comment: '开头抓人',
  suggestions: ['加强字幕', '缩短前奏'],
})

test('parseScoreResponse：完整 JSON → 原样归一', () => {
  const r = L.parseScoreResponse(GOOD)
  assert.equal(r.total, 82)
  assert.equal(r.play_level, '优质')
  assert.equal(r.golden3s, true)
  assert.equal(r.dims.吸睛力, 80)
  assert.equal(r.dims.平台适配, 90)
  assert.equal(r.comment, '开头抓人')
  assert.deepEqual(r.suggestions, ['加强字幕', '缩短前奏'])
})

test('parseScoreResponse：markdown 代码块 / 带前后缀文本均可解析', () => {
  assert.equal(L.parseScoreResponse('```json\n' + GOOD + '\n```').total, 82)
  assert.equal(L.parseScoreResponse('分析结果：' + GOOD + ' 以上。').total, 82)
})

test('parseScoreResponse：越界分值被夹紧到 0-100', () => {
  const r = L.parseScoreResponse(JSON.stringify({
    total: 150,
    play_level: '爆款',
    dims: { 吸睛力: -20, 画面冲击: '77', 悬念信息: 'abc' },
  }))
  assert.equal(r.total, 100)
  assert.equal(r.dims.吸睛力, 0)
  assert.equal(r.dims.画面冲击, 77)
  assert.equal(r.dims.悬念信息, 0)
})

test('parseScoreResponse：缺失维度补 0（对照 scores.get(d, 0)）', () => {
  const r = L.parseScoreResponse(JSON.stringify({ total: 60, play_level: '普通', dims: {} }))
  for (const d of L.DIMENSIONS) assert.equal(r.dims[d], 0, `${d} 应补 0`)
})

test('parseScoreResponse：可选字段缺省 → golden3s=false / comment="" / suggestions=[]', () => {
  const r = L.parseScoreResponse(JSON.stringify({ total: 60, play_level: '普通', dims: {} }))
  assert.equal(r.golden3s, false)
  assert.equal(r.comment, '')
  assert.deepEqual(r.suggestions, [])
})

test('parseScoreResponse：缺 total / play_level 非串 / dims 非对象 → null', () => {
  assert.equal(L.parseScoreResponse(JSON.stringify({ play_level: '爆款', dims: {} })), null)
  assert.equal(L.parseScoreResponse(JSON.stringify({ total: 80, play_level: 123, dims: {} })), null)
  assert.equal(L.parseScoreResponse(JSON.stringify({ total: 80, play_level: '', dims: {} })), null)
  assert.equal(L.parseScoreResponse(JSON.stringify({ total: 80, play_level: '爆款' })), null)
  assert.equal(L.parseScoreResponse(JSON.stringify({ total: 80, play_level: '爆款', dims: 'x' })), null)
})

test('parseScoreResponse：非 JSON → null（由编排层报原始返回）', () => {
  assert.equal(L.parseScoreResponse('我无法判断'), null)
  assert.equal(L.parseScoreResponse(''), null)
})

// ── prompt / content 组装 ──────────────────────────────────────

test('buildScorePrompt：注入平台 + 严格 JSON 输出约束', () => {
  const p = L.buildScorePrompt('小红书')
  assert.ok(p.includes('小红书'), '必须含目标平台')
  assert.ok(p.includes('严格只输出 JSON'), '必须约束输出格式')
  assert.ok(p.includes('"play_level":"爆款|优质|普通|偏弱"'))
  for (const d of L.DIMENSIONS) assert.ok(p.includes(d), `prompt 缺维度 ${d}`)
})

test('buildScorePrompt：无校准段时不插入空行；有校准段时置于输出约束之前', () => {
  const plain = L.buildScorePrompt('抖音')
  assert.ok(!plain.includes('预测 vs 实际'))

  const withCalib = L.buildScorePrompt('抖音', 'CALIB_TEXT')
  assert.ok(withCalib.includes('CALIB_TEXT'))
  assert.ok(
    withCalib.indexOf('CALIB_TEXT') < withCalib.indexOf('严格只输出 JSON'),
    '校准段必须在输出约束之前'
  )
})

test('buildScoreLeadText / buildScoreContent：平台+标题引导句 + 逐帧图片', () => {
  assert.equal(
    L.buildScoreLeadText('B站', '我的视频'),
    '目标平台：B站；视频标题：我的视频。以下为该视频的关键帧（按时间先后）：'
  )
  const c = L.buildScoreContent('B站', '我的视频', [frame(0.5), frame(1.5)])
  assert.equal(c.length, 3)
  assert.equal(c[0].type, 'text')
  assert.ok(c[0].text.includes('B站'))
  assert.equal(c[1].image_url.url, 'data:image/jpeg;base64,QUJD')
})

// ── 配色 ───────────────────────────────────────────────────────

test('playLevelColor：四量级配色', () => {
  assert.equal(L.playLevelColor('爆款'), '#e74c3c')
  assert.equal(L.playLevelColor('优质'), '#2ecc71')
  assert.equal(L.playLevelColor('普通'), '#f1c40f')
  assert.equal(L.playLevelColor('偏弱'), '#95a5a6')
})

test('totalScoreColor：>=80 绿 / >=60 黄 / else 红', () => {
  assert.equal(L.totalScoreColor(100), '#2ecc71')
  assert.equal(L.totalScoreColor(80), '#2ecc71')
  assert.equal(L.totalScoreColor(79), '#f1c40f')
  assert.equal(L.totalScoreColor(60), '#f1c40f')
  assert.equal(L.totalScoreColor(59), '#e74c3c')
  assert.equal(L.totalScoreColor(0), '#e74c3c')
})

// ── radarGeometry（对照 RadarChartWidget.paintEvent）────────────

const FULL = { 吸睛力: 80, 画面冲击: 75, 悬念信息: 70, 节奏: 85, 完播预测: 78, 平台适配: 90 }

test('radarGeometry：size=170 → cx=cy=85，r_max=min(w,h)/2-30=55', () => {
  const g = L.radarGeometry(FULL, 170)
  assert.equal(g.size, 170)
  assert.equal(g.cx, 85)
  assert.equal(g.cy, 85)
  assert.equal(g.rMax, 55)
})

test('radarGeometry：4 圈网格 × 6 顶点；4 条轴线终点在 r_max 上', () => {
  const g = L.radarGeometry(FULL)
  assert.equal(g.rings.length, 4)
  for (const ring of g.rings) assert.equal(ring.length, 6)
  assert.equal(g.axes.length, 6)
  for (const p of g.axes) {
    const r = Math.hypot(p.x - g.cx, p.y - g.cy)
    assert.ok(Math.abs(r - 55) < 1e-9, `轴线终点半径应为 55，实际 ${r}`)
  }
})

test('radarGeometry：首维指向正上方（a=-π/2），第二维 -π/2+2π/6', () => {
  const g = L.radarGeometry(FULL)
  assert.ok(Math.abs(g.axes[0].x - 85) < 1e-9)
  assert.ok(Math.abs(g.axes[0].y - 30) < 1e-9, '正上方 y = 85-55 = 30')

  // a = -π/2 + π/3 = -π/6 → cos=√3/2, sin=-1/2
  const expectX = 85 + 55 * (Math.sqrt(3) / 2)
  const expectY = 85 + 55 * (-0.5)
  assert.ok(Math.abs(g.axes[1].x - expectX) < 1e-9, `x 应为 ${expectX}`)
  assert.ok(Math.abs(g.axes[1].y - expectY) < 1e-9, `y 应为 ${expectY}`)
})

test('radarGeometry：数据多边形半径 r=r_max*(v/100)', () => {
  const g = L.radarGeometry(FULL)
  for (let i = 0; i < 6; i++) {
    const d = L.DIMENSIONS[i]
    const r = Math.hypot(g.polygon[i].x - g.cx, g.polygon[i].y - g.cy)
    const expect = 55 * (FULL[d] / 100)
    assert.ok(Math.abs(r - expect) < 1e-9, `${d} 半径应为 ${expect}，实际 ${r}`)
  }
})

test('radarGeometry：满分多边形与轴线重合；零分/缺维塌缩到圆心', () => {
  const all100 = {}
  for (const d of L.DIMENSIONS) all100[d] = 100
  const g100 = L.radarGeometry(all100)
  for (let i = 0; i < 6; i++) {
    assert.ok(Math.abs(g100.polygon[i].x - g100.axes[i].x) < 1e-9)
    assert.ok(Math.abs(g100.polygon[i].y - g100.axes[i].y) < 1e-9)
  }

  const g0 = L.radarGeometry({})
  for (const p of g0.polygon) {
    assert.ok(Math.abs(p.x - 85) < 1e-9 && Math.abs(p.y - 85) < 1e-9, '零分应在圆心')
  }
})

test('radarGeometry：越界分值夹紧到 0-100', () => {
  const g = L.radarGeometry({ 吸睛力: 500, 画面冲击: -50 })
  const r0 = Math.hypot(g.polygon[0].x - g.cx, g.polygon[0].y - g.cy)
  const r1 = Math.hypot(g.polygon[1].x - g.cx, g.polygon[1].y - g.cy)
  assert.ok(Math.abs(r0 - 55) < 1e-9, '500 应夹到 100 → 半径 55')
  assert.ok(Math.abs(r1) < 1e-9, '-50 应夹到 0 → 圆心')
})

test('radarGeometry：标签位于 r_max+13，带维度名/分值/DIM_COLORS 配色', () => {
  const g = L.radarGeometry(FULL)
  assert.equal(g.labels.length, 6)
  assert.ok(Math.abs(g.labels[0].y - (85 - 68)) < 1e-9, '首标签 y = 85-(55+13) = 17')
  assert.equal(g.labels[0].dim, '吸睛力')
  assert.equal(g.labels[0].score, 80)
  assert.equal(g.labels[0].color, L.DIM_COLORS['吸睛力'])
  assert.equal(g.labels[5].dim, '平台适配')
  assert.equal(g.labels[5].score, 90)
})

test('radarGeometry：画布过小（r_max<=0）→ 空几何，不产生 NaN', () => {
  const g = L.radarGeometry(FULL, 50) // 25-30 = -5
  assert.equal(g.rMax, -5)
  assert.deepEqual(g.rings, [])
  assert.deepEqual(g.axes, [])
  assert.deepEqual(g.polygon, [])
  assert.deepEqual(g.labels, [])
})

test('radarGeometry：默认 size=170（对照 setMinimumSize(170,170)）', () => {
  assert.equal(L.radarGeometry(FULL).size, 170)
})

test('toSvgPoints：产出 "x.xx,y.yy …" 两位小数空格分隔', () => {
  assert.equal(L.toSvgPoints([{ x: 1, y: 2 }, { x: 3.456, y: 7 }]), '1.00,2.00 3.46,7.00')
  assert.equal(L.toSvgPoints([]), '')
})

// ── 预测记录 / 校准文本 ─────────────────────────────────────────

test('CALIBRATION_LIMIT=12（对照 recent_with_feedback(limit=12)）', () => {
  assert.equal(L.CALIBRATION_LIMIT, 12)
})

test('recentWithFeedback：只取已回填记录，保持最新在前', () => {
  const items = [rec({ id: '1' }), rec({ id: '2', actual: null }), rec({ id: '3' })]
  assert.deepEqual(L.recentWithFeedback(items).map((x) => x.id), ['1', '3'])
})

test('recentWithFeedback：按平台过滤 + limit 截断', () => {
  const items = [
    rec({ id: '1', platform: '抖音' }),
    rec({ id: '2', platform: 'B站' }),
    rec({ id: '3', platform: '抖音' }),
  ]
  assert.deepEqual(L.recentWithFeedback(items, '抖音').map((x) => x.id), ['1', '3'])
  assert.deepEqual(L.recentWithFeedback(items, '抖音', 1).map((x) => x.id), ['1'])
  assert.deepEqual(L.recentWithFeedback(items, undefined, 2).map((x) => x.id), ['1', '2'])
})

test('recentWithFeedback：非数组/空 → []', () => {
  assert.deepEqual(L.recentWithFeedback([]), [])
  assert.deepEqual(L.recentWithFeedback(null), [])
  assert.deepEqual(L.recentWithFeedback(undefined), [])
})

test('filterPendingFeedback：只取未回填记录（对照 pending_feedback）', () => {
  const items = [rec({ id: '1' }), rec({ id: '2', actual: null }), null]
  assert.deepEqual(L.filterPendingFeedback(items).map((x) => x.id), ['2'])
  assert.deepEqual(L.filterPendingFeedback(null), [])
})

test('buildCalibrationText：无已回填数据 → 空串（prompt 不插校准段）', () => {
  assert.equal(L.buildCalibrationText([]), '')
  assert.equal(L.buildCalibrationText([rec({ actual: null })]), '')
})

test('buildCalibrationText：首行提示 + 逐行对照（逐字对照 calibration_text）', () => {
  const txt = L.buildCalibrationText([rec()])
  const lines = txt.split('\n')
  assert.equal(lines.length, 2)
  assert.equal(
    lines[0],
    '以下是你过往的『预测 vs 实际』对照（同一作者/账号），请据此校准本次预测——若历史上你高估/低估，请相应修正：'
  )
  assert.equal(lines[1], '- [抖音] 预测综合85分/量级优质 → 实际播放1.2万、平台评价「不错」')
})

test('buildCalibrationText：字段缺失走 .get(key,"?") 缺省口径', () => {
  const txt = L.buildCalibrationText([rec({
    platform: '',
    predicted: {},
    actual: { play_count: '', platform_eval: null, at: 1 },
  })])
  assert.equal(txt.split('\n')[1], '- [] 预测综合?分/量级? → 实际播放?、平台评价「」')
})

test('buildCalibrationText：predicted 为 total=0 时不被误判为缺失', () => {
  const txt = L.buildCalibrationText([rec({ predicted: { total: 0, play_level: '偏弱' } })])
  assert.ok(txt.includes('预测综合0分/量级偏弱'), `实际输出：${txt}`)
})

test('buildCalibrationText：多条按序拼接，受平台过滤与 limit 约束', () => {
  const items = [
    rec({ id: '1', platform: '抖音', predicted: { total: 90, play_level: '爆款' }, actual: { play_count: '5万', platform_eval: '很好', at: 1 } }),
    rec({ id: '2', platform: 'B站', predicted: { total: 40, play_level: '偏弱' }, actual: { play_count: '300', platform_eval: '一般', at: 1 } }),
    rec({ id: '3', platform: '抖音', predicted: { total: 70, play_level: '普通' }, actual: { play_count: '8000', platform_eval: '还行', at: 1 } }),
  ]
  const all = L.buildCalibrationText(items).split('\n')
  assert.equal(all.length, 4, '首行 + 3 条')

  const douyin = L.buildCalibrationText(items, '抖音').split('\n')
  assert.equal(douyin.length, 3, '首行 + 2 条抖音')
  assert.ok(douyin[1].includes('预测综合90分'))
  assert.ok(douyin[2].includes('预测综合70分'))

  const limited = L.buildCalibrationText(items, undefined, 1).split('\n')
  assert.equal(limited.length, 2)
})
