// ═══════════════════════════════════════════════════════════════
// vsr-quad-logic.test.mjs — 字幕/水印去除 quad 框选·纯逻辑单测（M4）
// 被测：renderer/src/composables/vsrQuadLogic.ts（纯函数，无 vue/IPC 依赖；
// Node ≥22.18 原生 type stripping 直接加载）。
// 对照原客户端 gui/subtitle_removal_page_v14.py：
//   · _quad_aabb/_rect_to_quad/_quad_to_relative_polygon L38-54
//   · _point_in_quad L301-312（射线法）
//   · InteractivePreviewLabelV14 移动/顶点/旋转分支 L402-517
//   · _add_box/_delete_box L1104-1131
//   · _start_remote_removal 的 sub_areas 编组 L1294-1309（核心契约入参）
//   · start_removal 参数校验 L1252-1262 / RemoteVSRWorkerV14.stop L103-114
// 运行：node --test "tests/*.test.mjs"
// ═══════════════════════════════════════════════════════════════

import { test } from 'node:test'
import assert from 'node:assert/strict'

const L = await import('../renderer/src/composables/vsrQuadLogic.ts')

// ── 几何基础（对照 _quad_aabb / _rect_to_quad）────────────────────

test('quadAabb：斜四边形取轴对齐外接框', () => {
  const quad = [[100, 400], [900, 380], [900, 470], [100, 450]]
  assert.deepEqual(L.quadAabb(quad), [100, 380, 800, 90])
})

test('rectToQuad：顺时针四点（左上→右上→右下→左下）', () => {
  assert.deepEqual(L.rectToQuad(10, 20, 30, 40), [[10, 20], [40, 20], [40, 60], [10, 60]])
})

test('pointInQuad：射线法内/外判定', () => {
  const quad = [[0, 0], [100, 0], [100, 100], [0, 100]]
  assert.equal(L.pointInQuad(50, 50, quad), true)
  assert.equal(L.pointInQuad(150, 50, quad), false)
  assert.equal(L.pointInQuad(-5, 50, quad), false)
  // 斜四边形：中心在内部、右上方外部
  const slant = [[0, 100], [100, 80], [100, 180], [0, 200]]
  assert.equal(L.pointInQuad(50, 140, slant), true)
  assert.equal(L.pointInQuad(95, 70, slant), false)
})

test('quadToRelativePolygon：帧像素 → 相对坐标，4 位小数', () => {
  const quad = [[100, 400], [900, 380], [900, 470], [100, 450]]
  const rel = L.quadToRelativePolygon(quad, 1000, 500)
  assert.deepEqual(rel, [[0.1, 0.8], [0.9, 0.76], [0.9, 0.94], [0.1, 0.9]])
})

// ── sub_areas 编组（核心契约入参，对照 _start_remote_removal L1294-1309）──

test('buildSubAreas：智能模式 → 空串（服务端自动检测）', () => {
  const out = L.buildSubAreas([], { isSmart: true, purpose: 'subtitle', frame: { w: 1000, h: 500 } })
  assert.equal(out, '')
})

test('buildSubAreas：去字幕 → 轴对齐矩形相对坐标 [[ymin,ymax,xmin,xmax],...]（斜框先取 AABB）', () => {
  const boxes = [
    [[100, 400], [900, 400], [900, 490], [100, 490]],   // 轴对齐
    [[100, 400], [900, 380], [900, 470], [100, 450]],   // 斜框 → AABB(100,380,800,90)
  ]
  const out = L.buildSubAreas(boxes, { isSmart: false, purpose: 'subtitle', frame: { w: 1000, h: 500 } })
  assert.deepEqual(JSON.parse(out), [
    [0.8, 0.98, 0.1, 0.9],
    [0.76, 0.94, 0.1, 0.9],
  ])
})

test('buildSubAreas：去水印 → 可旋转四边形相对坐标 [[[x,y]×4],...]（保留旋转）', () => {
  const boxes = [[[100, 400], [900, 380], [900, 470], [100, 450]]]
  const out = L.buildSubAreas(boxes, { isSmart: false, purpose: 'watermark', frame: { w: 1000, h: 500 } })
  assert.deepEqual(JSON.parse(out), [[[0.1, 0.8], [0.9, 0.76], [0.9, 0.94], [0.1, 0.9]]])
})

// ── 提交字段编组 + 参数校验（对照 start_removal L1252-1262 / L1284-1346）──

test('buildVsrFields：去字幕正常编组（inpaint_mode=sttn_det，sub_areas 矩形）', () => {
  const r = L.buildVsrFields({
    videoPath: 'D:/v/a.mp4',
    isSmart: false,
    purpose: 'subtitle',
    watermarkText: '',
    boxes: [[[100, 400], [900, 400], [900, 490], [100, 490]]],
    frame: { w: 1000, h: 500 },
  })
  assert.equal(r.ok, true)
  assert.deepEqual(r.fields, {
    video: 'D:/v/a.mp4',
    inpaint_mode: 'sttn_det',
    sub_areas: '[[0.8,0.98,0.1,0.9]]',
    purpose: 'subtitle',
    watermark_text: '',
  })
})

test('buildVsrFields：去水印 inpaint_mode=sttn_auto + 携带水印文字（对照 L1292/L1312-1314）', () => {
  const r = L.buildVsrFields({
    videoPath: 'D:/v/a.mp4',
    isSmart: false,
    purpose: 'watermark',
    watermarkText: 'LOGO',
    boxes: [[[100, 400], [900, 380], [900, 470], [100, 450]]],
    frame: { w: 1000, h: 500 },
  })
  assert.equal(r.ok, true)
  assert.equal(r.fields.inpaint_mode, 'sttn_auto')
  assert.equal(r.fields.purpose, 'watermark')
  assert.equal(r.fields.watermark_text, 'LOGO')
  assert.ok(r.fields.sub_areas.startsWith('[[['))
})

test('buildVsrFields：智能模式 sub_areas 为空串仍可提交', () => {
  const r = L.buildVsrFields({
    videoPath: 'D:/v/a.mp4', isSmart: true, purpose: 'subtitle',
    watermarkText: '', boxes: [], frame: { w: 1000, h: 500 },
  })
  assert.equal(r.ok, true)
  assert.equal(r.fields.sub_areas, '')
})

test('buildVsrFields：无视频 → 校验失败（原版文案）', () => {
  const r = L.buildVsrFields({
    videoPath: '', isSmart: false, purpose: 'subtitle',
    watermarkText: '', boxes: [[[0, 0], [1, 0], [1, 1], [0, 1]]], frame: { w: 10, h: 10 },
  })
  assert.equal(r.ok, false)
  assert.equal(r.error, '请先选择有效的输入视频或图片！')
})

test('buildVsrFields：标注模式未框选就提交 → 校验失败（原版文案 L1261）', () => {
  const r = L.buildVsrFields({
    videoPath: 'D:/v/a.mp4', isSmart: false, purpose: 'subtitle',
    watermarkText: '', boxes: [], frame: { w: 1000, h: 500 },
  })
  assert.equal(r.ok, false)
  assert.equal(r.error, '请先设置至少一个擦除选区！')
})

test('buildVsrFields：智能模式无框可提交（不校验选区）', () => {
  const r = L.buildVsrFields({
    videoPath: 'D:/v/a.mp4', isSmart: true, purpose: 'watermark',
    watermarkText: '', boxes: [], frame: { w: 1000, h: 500 },
  })
  assert.equal(r.ok, true)
})

// ── 框交互几何（对照 InteractivePreviewLabelV14 各拖拽分支）──────

test('moveQuad：整体平移 clamp 使 AABB 不出帧（对照 L474-479）', () => {
  const quad = [[100, 100], [200, 100], [200, 200], [100, 200]]
  // dx=5000 超出 → 右缘贴帧右边界（frame 1000）
  const moved = L.moveQuad(quad, 5000, 0, { w: 1000, h: 500 })
  assert.deepEqual(moved, [[900, 100], [1000, 100], [1000, 200], [900, 200]])
  // dy 负向越界 → 上缘贴 0
  const up = L.moveQuad(quad, 0, -5000, { w: 1000, h: 500 })
  assert.deepEqual(up, [[100, 0], [200, 0], [200, 100], [100, 100]])
  // 正常范围内自由移动
  const mid = L.moveQuad(quad, 30, 40, { w: 1000, h: 500 })
  assert.deepEqual(mid, [[130, 140], [230, 140], [230, 240], [130, 240]])
})

test('dragVertex：去字幕（轴对齐）拖角点=对角固定的矩形缩放（对照 L489-496）', () => {
  const quad = [[100, 100], [200, 100], [200, 200], [100, 200]]
  const out = L.dragVertex(quad, 0, 300, 50, { w: 1000, h: 500 }, false)
  // 对角 = 顶点 2 (200,200) 固定
  assert.deepEqual(out, [[200, 50], [300, 50], [300, 200], [200, 200]])
})

test('dragVertex：去水印（可旋转）自由移动顶点并 clamp 帧内（对照 L482-487）', () => {
  const quad = [[100, 100], [200, 100], [200, 200], [100, 200]]
  const out = L.dragVertex(quad, 0, 300, 50, { w: 1000, h: 500 }, true)
  assert.deepEqual(out, [[300, 50], [200, 100], [200, 200], [100, 200]])
  // 超出帧边界 → clamp 到帧内
  const clamped = L.dragVertex(quad, 0, 5000, -50, { w: 1000, h: 500 }, true)
  assert.deepEqual(clamped[0], [1000, 0])
})

test('applyRotation：绕中心旋转 90°（对照 L433-445）', () => {
  const quad = [[100, 100], [200, 100], [200, 200], [100, 200]]
  const out = L.applyRotation(quad, Math.PI / 2, { w: 1000, h: 500 })
  const set = (q) => q.map((p) => p.join(',')).sort().join('|')
  assert.equal(set(out), set([[200, 100], [200, 200], [100, 200], [100, 100]]))
})

test('applyRotation：旋转后 AABB 超帧 → 平移贴边不出画面（对照 L447-465）', () => {
  // 构造一个旋转后左缘越界的框：中心在 (50, 250)，宽 200 的水平框
  const quad = [[-50, 200], [50, 200], [50, 300], [-50, 300]]
  const out = L.applyRotation(quad, 0, { w: 1000, h: 500 })
  // delta=0 仍执行贴边平移：aabb.x0=-50 <0 且放得下 → tx=50
  assert.deepEqual(L.quadAabb(out), [0, 200, 100, 100])
})

test('rotateHandleIndex：取 x+y 最大的顶点；去字幕模式返回 -1（对照 L314-332）', () => {
  const quad = [[0, 0], [10, 0], [10, 10], [0, 10]]
  assert.equal(L.rotateHandleIndex(quad, true), 2)
  assert.equal(L.rotateHandleIndex(quad, false), -1)
})

test('defaultNewQuad：首个框=底部字幕区（5%/78%/90%/21%，对照 L1108-1111）', () => {
  const q = L.defaultNewQuad(null, { w: 1000, h: 500 })
  assert.deepEqual(q, [[50, 390], [950, 390], [950, 495], [50, 495]])
})

test('defaultNewQuad：后续框与上一框同宽、上移 40 避免完全重叠（对照 L1112-1118）', () => {
  const prev = [[50, 390], [950, 390], [950, 495], [50, 495]]
  const q = L.defaultNewQuad(prev, { w: 1000, h: 500 })
  assert.deepEqual(q, [[50, 350], [950, 350], [950, 455], [50, 455]])
  // 上移触顶 → clamp 到 0
  const top = L.defaultNewQuad([[50, 20], [950, 20], [950, 100], [50, 100]], { w: 1000, h: 500 })
  assert.equal(top[0][1], 0)
})

test('normalizeQuadsForPurpose：切到去字幕时斜四边形规范化为轴对齐矩形（对照 L1043-1045）', () => {
  const slant = [[100, 400], [900, 380], [900, 470], [100, 450]]
  const out = L.normalizeQuadsForPurpose([slant], 'subtitle')
  assert.deepEqual(out[0], [[100, 380], [900, 380], [900, 470], [100, 470]])
  const keep = L.normalizeQuadsForPurpose([slant], 'watermark')
  assert.deepEqual(keep[0], slant)
})

// ── 命中测试（对照 get_handle_under_mouse L370-400）──────────────

test('hitTestQuad：激活框顶点命中优先 → vertex-N', () => {
  const boxes = [[[100, 400], [900, 400], [900, 490], [100, 490]]]
  const r = L.hitTestQuad({
    mx: 50, my: 200, boxes, activeIndex: 0,
    display: { w: 500, h: 250, offsetX: 0, offsetY: 0 },
    frame: { w: 1000, h: 500 }, allowRotation: true, threshold: 10,
  })
  assert.deepEqual(r, { handle: 'vertex-0', index: 0 })
})

test('hitTestQuad：框内命中 → move（含非激活框）', () => {
  const boxes = [
    [[100, 400], [900, 400], [900, 490], [100, 490]],
    [[100, 50], [300, 50], [300, 120], [100, 120]],
  ]
  // 非激活框内（frame 200,80 → widget 100,40）
  const r = L.hitTestQuad({
    mx: 100, my: 40, boxes, activeIndex: 0,
    display: { w: 500, h: 250, offsetX: 0, offsetY: 0 },
    frame: { w: 1000, h: 500 }, allowRotation: true,
  })
  assert.deepEqual(r, { handle: 'move', index: 1 })
})

test('hitTestQuad：空白处 → null', () => {
  const boxes = [[[100, 400], [900, 400], [900, 490], [100, 490]]]
  const r = L.hitTestQuad({
    mx: 250, my: 50, boxes, activeIndex: 0,
    display: { w: 500, h: 250, offsetX: 0, offsetY: 0 },
    frame: { w: 1000, h: 500 }, allowRotation: true,
  })
  assert.equal(r, null)
})

// ── 提交错误映射 / 取消口径（对照 RemoteVSRWorkerV14 异常分支）────

test('toSubmitError：null（网络离线）→ 离线提示', () => {
  const e = L.toSubmitError(null)
  assert.ok(e instanceof Error)
  assert.match(e.message, /服务端离线/)
})

test('toSubmitError：服务端错误透传（5xx/422 detail 主进程已组装）', () => {
  const e = L.toSubmitError({ error: '服务端返回 422: {"detail":...}' })
  assert.equal(e.message, '服务端返回 422: {"detail":...}')
})

test('toSubmitError：无 task_id → 原版口径「服务端未返回任务 ID: {body}」（截断 300）', () => {
  const e = L.toSubmitError({ foo: 'x'.repeat(400) })
  assert.match(e.message, /^服务端未返回任务 ID: /)
  assert.ok(e.message.length <= 350)
})

test('shouldCancelServerTask：有 task_id 才发 DELETE（对照 worker.stop L106）', () => {
  assert.equal(L.shouldCancelServerTask('c_abc123'), true)
  assert.equal(L.shouldCancelServerTask(''), false)
  assert.equal(L.shouldCancelServerTask(null), false)
})

test('取消/终止文案常量对齐原客户端（stop L178 / finished L1388）', () => {
  assert.equal(L.USER_ABORT_MESSAGE, '用户终止运行。')
  assert.equal(L.CANCELLED_STATUS_TEXT, '已被用户终止。')
})
