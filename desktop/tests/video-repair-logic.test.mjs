// ═══════════════════════════════════════════════════════════════
// video-repair-logic.test.mjs — 视频修复 工作流归一化/状态映射/结果命名 单测（M7 条目⑤）
// 被测：renderer/src/composables/videoRepairLogic.ts（纯函数，无 vue/IPC 依赖）
// 对照原客户端：
//   · studio/utils/workflow_client.py normalize_server_workflow L60-88
//     （GET /workflows 条目 → 客户端结构：id/name/type/instanceType/output_type/inputs）
//   · studio/gui/main_window_aigen.py _query_single_rh_task L823-906
//     （GET /workflows/task/{id} → resp.data 兜底；QUEUED/RUNNING/SUCCESS/FAILED/PAUSED）
//   · studio/gui/main_window_aigen.py _auto_download_rh_results L1061-1082
//     （结果命名：media.ext / media_idx.ext / 冲突加 task_id）
//   · setup_video_tools_page L492-497（默认工作流「输入视频-修复脸部细节-20260113.json」）
// 运行：node --test "tests/*.test.mjs"
// ═══════════════════════════════════════════════════════════════

import { test } from 'node:test'
import assert from 'node:assert/strict'

const R = await import('../renderer/src/composables/videoRepairLogic.ts')

// ── normalizeServerWorkflow（对照 workflow_client.normalize_server_workflow L60-88）──

test('normalizeServerWorkflow：服务端字段 → 客户端结构', () => {
  const w = R.normalizeServerWorkflow({
    workflow_id: 'wf_face',
    name: '输入视频-修复脸部细节',
    type: '视频修复',
    instance_type: 'plus',
    description: '修复脸部',
    client_api: 'video',
    image_nodes: ['1'],
    audio_nodes: [],
    backend: 'runninghub',
    scope: 'client',
    output_type: 'video',
    inputs: [{ key: 'video', kind: 'video' }],
    io: {},
  })
  assert.equal(w.id, 'wf_face')
  assert.equal(w.name, '输入视频-修复脸部细节')
  assert.equal(w.type, '视频修复')
  assert.equal(w.instanceType, 'plus')
  assert.equal(w.outputType, 'video')
  assert.deepEqual(w.inputs, [{ key: 'video', kind: 'video' }])
  assert.equal(w.backend, 'runninghub')
})

test('normalizeServerWorkflow：缺 workflow_id / 非对象 → null', () => {
  assert.equal(R.normalizeServerWorkflow({ name: 'no id' }), null)
  assert.equal(R.normalizeServerWorkflow(null), null)
  assert.equal(R.normalizeServerWorkflow('str'), null)
})

test('normalizeServerWorkflow：缺省字段兜底（type=其他 / instanceType=default）', () => {
  const w = R.normalizeServerWorkflow({ workflow_id: 'x' })
  assert.equal(w.type, '其他')
  assert.equal(w.instanceType, 'default')
  assert.equal(w.name, 'x')
})

// ── 任务查询响应解包（对照 _query_single_rh_task L833-843）──

test('extractTaskData：{code,data:{...}} → data；裸响应 → 自身', () => {
  const data = { status: 'SUCCESS', results: [{ url: 'http://x/v.mp4' }] }
  assert.equal(R.extractTaskData({ code: 0, data }), data)
  assert.equal(R.extractTaskData(data), data)
  assert.deepEqual(R.extractTaskData(null), {})
})

test('extractTaskResults：results 数组提取，缺省空', () => {
  assert.equal(R.extractTaskResults({ status: 'RUNNING' }).length, 0)
  assert.equal(R.extractTaskResults({ results: [{ url: 'u' }] }).length, 1)
})

// ── 状态映射（对照 status_text_map L859-865 + comfy 小写映射 L939-948）──

test('mapWorkflowStatus：RunningHub 大写状态', () => {
  assert.deepEqual(R.mapWorkflowStatus('QUEUED'), { text: '排队中', phase: 'queued', progress: 0 })
  assert.deepEqual(R.mapWorkflowStatus('RUNNING'), { text: '运行中', phase: 'running', progress: 50 })
  assert.deepEqual(R.mapWorkflowStatus('SUCCESS'), { text: '完成', phase: 'done', progress: 100 })
  assert.deepEqual(R.mapWorkflowStatus('FAILED'), { text: '失败', phase: 'failed', progress: 100 })
  assert.deepEqual(R.mapWorkflowStatus('PAUSED'), { text: '已暂停', phase: 'paused', progress: 0 })
})

test('mapWorkflowStatus：ComfyUI 协议小写状态（success/completed/error/failed）', () => {
  assert.equal(R.mapWorkflowStatus('success').phase, 'done')
  assert.equal(R.mapWorkflowStatus('completed').phase, 'done')
  assert.equal(R.mapWorkflowStatus('error').phase, 'failed')
  assert.equal(R.mapWorkflowStatus('queued').phase, 'queued')
  assert.equal(R.mapWorkflowStatus('什么玩意').text, '什么玩意') // 未知状态原样透出
})

// ── 结果命名（对照 _auto_download_rh_results L1073-1082）──

test('buildResultName：单结果 media.ext；多结果 media_idx.ext', () => {
  assert.equal(R.buildResultName('视频', 1, 1, 'mp4', 't1', () => false), '视频.mp4')
  assert.equal(R.buildResultName('视频', 2, 3, 'mp4', 't1', () => false), '视频_2.mp4')
  assert.equal(R.buildResultName('', 1, 1, 'png', 'task9', () => false), 'task9_1.png')
})

test('buildResultName：同名冲突 → 追加 task_id', () => {
  assert.equal(R.buildResultName('视频', 1, 1, 'mp4', 't1', () => true), '视频_t1.mp4')
})

test('buildResultName：outputType 缺省 bin', () => {
  assert.equal(R.buildResultName('v', 1, 1, '', 't', () => false), 'v.bin')
})

// ── 默认工作流（对照 setup_video_tools_page L492-497）──

test('pickDefaultWorkflow：按名称匹配默认工作流 id，无匹配回退首个', () => {
  const items = [
    { id: 'wf_a', name: '输入视频-高清画质修复-20260113' },
    { id: 'wf_b', name: '输入视频-修复脸部细节-20260113' },
  ]
  assert.equal(R.pickDefaultWorkflow(items), 'wf_b')
  assert.equal(R.pickDefaultWorkflow(items.slice(0, 1)), 'wf_a')
  assert.equal(R.pickDefaultWorkflow([]), '')
})

// ── 结果 URL 提取（对照 _auto_download_rh_results L1064-1072 res.url）──

test('extractResultEntries：仅保留含 url/filename/text 的 dict 项', () => {
  const entries = R.extractResultEntries([
    { url: 'http://x/1.mp4', outputType: 'mp4' },
    '垃圾字符串',
    { filename: 'only-name' },
    42,
  ])
  assert.equal(entries.length, 2)
  assert.equal(entries[0].url, 'http://x/1.mp4')
  assert.equal(entries[1].filename, 'only-name')
})
