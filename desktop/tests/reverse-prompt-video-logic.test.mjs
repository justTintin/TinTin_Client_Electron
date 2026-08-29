// ═══════════════════════════════════════════════════════════════
// reverse-prompt-video-logic.test.mjs — 视频反推提示词·时间轴选段/任务轮询 单测（M6 条目⑦）
// 被测：renderer/src/composables/reversePromptVideoLogic.ts（纯函数，无 vue/IPC 依赖）
// 对照原客户端 studio/gui/prompt_reverse_page.py：
//   · _VideoTimeline L210-420（MAX_WINDOW=30 拖拽约束 / set_video 初始选区 / _fmt_sec）
//   · _extract_frames L73-95（均匀抽帧 fps=1/step，共 count 帧）
//   · _VideoPromptWorker L461-502（POST /prompt/video start_sec/end_sec 随提交，
//     无本地裁切；响应 task_id/id/job_id → 轮询，无 task_id 同步结果）
//   · _poll_task_result L128-188（{data:{}} 解包 / status|state / 终态与失败态 /
//     progress ≤1 ×100 进度文案 / 超时）
//   · _format_result L101-122（描述/正向/反向/风格标签/画面比例/引擎 分段）
// 运行：node --test "tests/*.test.mjs"
// ═══════════════════════════════════════════════════════════════

import { test } from 'node:test'
import assert from 'node:assert/strict'

const R = await import('../renderer/src/composables/reversePromptVideoLogic.ts')

// ── 时间轴选段约束（对照 _VideoTimeline）──

test('initialRange：默认选区 0 ~ min(30, duration)（对照 set_video L227-234）', () => {
  assert.deepEqual(R.initialRange(120), { start: 0, end: 30 })
  assert.deepEqual(R.initialRange(12), { start: 0, end: 12 })
  assert.deepEqual(R.initialRange(0.5), { start: 0, end: 0.5 })
  assert.deepEqual(R.initialRange(30), { start: 0, end: 30 })
})

test('clampDragLeft：拖左手柄，最短 1s、窗口 ≤30s 超限不动（对照 mouseMoveEvent L322-325）', () => {
  // 正常左拖
  assert.deepEqual(R.clampDragLeft(5, 10, 20, 120), { start: 5, end: 20 })
  // 不得越过右手柄（最小 1s）
  assert.deepEqual(R.clampDragLeft(19.5, 10, 20, 120), { start: 19, end: 20 })
  // 不得为负
  assert.deepEqual(R.clampDragLeft(-3, 10, 20, 120), { start: 0, end: 20 })
  // 窗口超 30s → 不动（返回原值）
  assert.deepEqual(R.clampDragLeft(0, 0, 31, 120), { start: 0, end: 31 })
})

test('clampDragRight：拖右手柄，最短 1s、≤30s、不超时长（对照 L326-330）', () => {
  assert.deepEqual(R.clampDragRight(15, 10, 20, 120), { start: 10, end: 15 })
  // 最短 1s：t 小于 start+1 时取 start+1（对照 L327 max(t, start+1.0)）
  assert.deepEqual(R.clampDragRight(10.2, 10, 20, 120), { start: 10, end: 11 })
  // 超时长/超 30s 窗口 → 判定失败不改 sel_end（对照 L328-330：先夹时长，再窗口校验，超限保持原值）
  assert.deepEqual(R.clampDragRight(150, 10, 20, 120), { start: 10, end: 20 })
  // 窗口超 30s → 不动
  assert.deepEqual(R.clampDragRight(60, 0, 31, 120), { start: 0, end: 31 })
})

test('clampMove：整窗平移，夹在 [0, duration-win]（对照 L331-335）', () => {
  assert.deepEqual(R.clampMove(50, 10, 20, 120), { start: 45, end: 55 })
  // 左边界
  assert.deepEqual(R.clampMove(5, 10, 20, 120), { start: 0, end: 10 })
  // 右边界（duration-win 起步）
  assert.deepEqual(R.clampMove(118, 100, 110, 120), { start: 110, end: 120 })
})

test('fmtSec：m:ss 格式（对照 _fmt_sec L96-98）', () => {
  assert.equal(R.fmtSec(0), '0:00')
  assert.equal(R.fmtSec(65), '1:05')
  assert.equal(R.fmtSec(600), '10:00')
  assert.equal(R.fmtSec(-5), '0:00')
})

test('frameTimestamps：均匀抽帧时间点（对照 _extract_frames fps=1/step L84-89）', () => {
  // step = duration/count；ts_i = i*step
  assert.deepEqual(R.frameTimestamps(16, 16), Array.from({ length: 16 }, (_, i) => i))
  assert.deepEqual(R.frameTimestamps(32, 16), Array.from({ length: 16 }, (_, i) => i * 2))
  // count<=1 或 duration<=0 → 空数组（对照 L76 count<=1 / duration<=0 返回 []）
  assert.deepEqual(R.frameTimestamps(10, 1), [])
  assert.deepEqual(R.frameTimestamps(0, 16), [])
})

// ── 提交响应解析（对照 _VideoPromptWorker L492-499 + _extract_task_id L189-194）──

test('extractTaskId：task_id / id / job_id 兼容（对照 L189-194）', () => {
  assert.equal(R.extractTaskId({ task_id: 't1' }), 't1')
  assert.equal(R.extractTaskId({ id: 'i2' }), 'i2')
  assert.equal(R.extractTaskId({ job_id: 'j3' }), 'j3')
  assert.equal(R.extractTaskId({ task_id: 't1', id: 'i2' }), 't1')
  assert.equal(R.extractTaskId({}), '')
  assert.equal(R.extractTaskId(null), '')
  assert.equal(R.extractTaskId('str'), '')
})

test('parsePromptVideoResponse：有 task_id → 轮询；无 → 同步结果（对照 L492-499）', () => {
  const r1 = R.parsePromptVideoResponse({ task_id: '42' })
  assert.equal(r1.taskId, '42')
  assert.equal(r1.sync, null)
  const data = { description: 'd', prompt: 'p' }
  const r2 = R.parsePromptVideoResponse(data)
  assert.equal(r2.taskId, '')
  assert.equal(r2.sync, data)
})

// ── 轮询状态机（对照 _poll_task_result L128-188）──

test('extractTaskObj：{data:{...}} 解包，裸响应原样（对照 L150）', () => {
  const inner = { status: 'completed' }
  assert.equal(R.extractTaskObj({ data: inner }), inner)
  assert.equal(R.extractTaskObj(inner), inner)
  assert.deepEqual(R.extractTaskObj(null), {})
  assert.deepEqual(R.extractTaskObj('x'), {})
})

test('mapTaskStatus：终态/失败态/进行中（对照 L158/L177/L182）', () => {
  for (const s of ['completed', 'done', 'success', 'finished']) {
    assert.equal(R.mapTaskStatus(s).phase, 'done', s)
  }
  for (const s of ['failed', 'error', 'cancelled']) {
    assert.equal(R.mapTaskStatus(s).phase, 'failed', s)
  }
  assert.equal(R.mapTaskStatus('running').phase, 'running')
  assert.equal(R.mapTaskStatus('pending').phase, 'running')
  assert.equal(R.mapTaskStatus('').phase, 'running') // 未知状态保持等待
  assert.equal(R.mapTaskStatus('COMPLETED').phase, 'done') // 大小写不敏感
})

test('mapTaskStatus：失败态透出 error_msg/error/message（对照 L183-185）', () => {
  assert.equal(R.mapTaskStatus('failed', { error_msg: 'boom' }).error, 'boom')
  assert.equal(R.mapTaskStatus('failed', { error: 'e2' }).error, 'e2')
  assert.equal(R.mapTaskStatus('cancelled', { message: 'm3' }).error, 'm3')
  assert.equal(R.mapTaskStatus('failed', {}).error, '未知错误')
})

test('pollPhaseText：progress ≤1 ×100；无 progress 显示已等待秒数（对照 L162-176）', () => {
  assert.equal(R.pollPhaseText(0.35), '服务端处理中 35%')
  assert.equal(R.pollPhaseText(72), '服务端处理中 72%')
  assert.equal(R.pollPhaseText(null, 42), '等待服务端处理，已等待 42 秒...')
  assert.equal(R.pollPhaseText(undefined, 3), '等待服务端处理，已等待 3 秒...')
})

test('POLL_TIMEOUT_MS / POLL_INTERVAL_MS = 600s / 3s（对照 L128 默认参数）', () => {
  assert.equal(R.POLL_TIMEOUT_MS, 600000)
  assert.equal(R.POLL_INTERVAL_MS, 3000)
})

// ── 结果格式化（对照 _format_result L101-122）──

test('formatPromptResult：全字段分段（描述/正向/反向/风格/比例/引擎）', () => {
  const segs = R.formatPromptResult({
    description: '一只猫',
    prompt: 'a cat, studio light',
    negative_prompt: 'blurry',
    style_tags: ['cinematic', 'warm'],
    aspect_ratio: '16:9',
    engine_used: 'qwen-vl',
  })
  assert.deepEqual(segs, [
    { label: '描述', text: '一只猫' },
    { label: '正向提示词 Prompt', text: 'a cat, studio light' },
    { label: '反向提示词 Negative Prompt', text: 'blurry' },
    { label: '风格标签', text: 'cinematic, warm' },
    { label: '画面比例', text: '16:9' },
    { label: '引擎', text: 'qwen-vl' },
  ])
})

test('formatPromptResult：model_used 兜底引擎；空对象回退原始 JSON（对照 L119-122）', () => {
  const segs = R.formatPromptResult({ model_used: 'gpt-4v' })
  assert.deepEqual(segs, [{ label: '引擎', text: 'gpt-4v' }])
  const raw = R.formatPromptResult({ foo: 1 })
  assert.equal(raw.length, 1)
  assert.equal(raw[0].label, '')
  assert.equal(raw[0].text, JSON.stringify({ foo: 1 }, null, 2))
})

// ── 选段提交载荷（对照 _VideoPromptWorker L482-488：start_sec/end_sec 两位小数随提交）──

test('buildPromptVideoPayload：start/end 随提交，禁止本地裁切语义', () => {
  const p = R.buildPromptVideoPayload('/a/b.mp4', 3.4567, 12.891)
  assert.equal(p.file, '/a/b.mp4')
  assert.equal(p.start_sec, '3.46')
  assert.equal(p.end_sec, '12.89')
})

test('validateRange：起止合法（0≤start<end≤duration、≤30s）否则报错文案', () => {
  assert.equal(R.validateRange(0, 30, 120), '')
  assert.equal(R.validateRange(10, 40, 120), '')
  assert.ok(R.validateRange(-1, 30, 120).length > 0)
  assert.ok(R.validateRange(0, 121, 120).length > 0)
  assert.ok(R.validateRange(30, 30, 120).length > 0) // 起止相等
  assert.ok(R.validateRange(50, 20, 120).length > 0) // start > end
  assert.ok(R.validateRange(0, 31, 120).includes('30')) // 超 30s 上限
})
