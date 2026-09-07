// ═══════════════════════════════════════════════════════════════
// viral-clone-logic.test.mjs — 仿爆款（Viral Clone）纯函数层单测
// 对照原客户端 studio/utils/viral_clone_client.py normalize_source L158-186
// + run_clone L191-232，studio/gui/viral_clone_dialog.py
// _collect_edit_payload L790-841 / _build_edit_form L566-658，
// studio/utils/workflow_client.py normalize_server_workflow L60-88。
// 运行：cd desktop && node --test "tests/*.test.mjs"
// ═══════════════════════════════════════════════════════════════

import { test } from 'node:test'
import assert from 'node:assert/strict'

const V = await import('../renderer/src/composables/viralCloneLogic.ts')

// ── normalizeSource（V3 改动版：本地文件→上传，链接移除）─────────────

test('normalizeSource：空/未提供 → ok=false + 中文提示', () => {
  assert.equal(V.normalizeSource(null).ok, false)
  assert.equal(V.normalizeSource(undefined).ok, false)
  assert.equal(V.normalizeSource('').ok, false)
  assert.equal(V.normalizeSource('   ').ok, false)
  assert.match(V.normalizeSource('').note, /未提供爆款视频/)
})

test('normalizeSource：数字/纯数字字符串 → material_id', () => {
  assert.deepEqual(V.normalizeSource(42), { ok: true, materialId: 42, note: '素材库 id=42' })
  assert.deepEqual(V.normalizeSource('42'), { ok: true, materialId: 42, note: '素材库 id=42' })
  const str = V.normalizeSource('abc')
  assert.equal(str.ok, true)
  assert.equal(str.materialId, 'abc')
})

test('normalizeSource：服务端 output 区路径 → videoPath', () => {
  const r = V.normalizeSource('/output/videos/clip.mp4')
  assert.equal(r.ok, true)
  assert.equal(r.videoPath, '/output/videos/clip.mp4')
  assert.match(r.note, /output/)
})

test('normalizeSource：本地文件 → needsUpload（唯一本端输入）', () => {
  const r = V.normalizeSource('C:/videos/爆款.mp4')
  assert.equal(r.ok, true)
  assert.equal(r.needsUpload, true)
  assert.match(r.note, /本地视频/)
})

test('normalizeSource：http(s) 链接 → 移除（下载链路不移植）', () => {
  const r = V.normalizeSource('https://v.douyin.com/xxx')
  assert.equal(r.ok, false)
  assert.match(r.note, /链接输入已移除/)
})

// ── 请求体组包 ──

test('buildFlowBody：video_path 二选一', () => {
  assert.deepEqual(V.buildFlowBody('/output/a.mp4', undefined, '店A产品'), {
    video_path: '/output/a.mp4',
    product_info: '店A产品',
  })
  assert.deepEqual(V.buildFlowBody(undefined, 7, '产品'), {
    material_id: 7,
    product_info: '产品',
  })
  // 都缺 → 仅 product_info
  assert.deepEqual(V.buildFlowBody(undefined, undefined, ''), { product_info: '' })
})

test('buildAnalyzeBody：material_id 优先于 video_path', () => {
  assert.deepEqual(V.buildAnalyzeBody('/output/a.mp4', 3), { material_id: 3 })
  assert.deepEqual(V.buildAnalyzeBody('/output/a.mp4'), { video_path: '/output/a.mp4' })
})

test('buildPlanBody：structure 必填 + product_info', () => {
  assert.deepEqual(V.buildPlanBody({ meta: { duration: 30 } }, '店B'), {
    structure: { meta: { duration: 30 } },
    product_info: '店B',
  })
})

// ── i18nFlowError（viral_clone_client.flow L119-126 文案映射）────────

test('i18nFlowError：need_login / captcha / error 映射中文文案', () => {
  assert.match(V.i18nFlowError({ needLogin: true }), /抖音未登录/)
  assert.match(V.i18nFlowError({ captcha: true }), /滑块验证/)
  assert.equal(V.i18nFlowError({ error: 'flow 未返回成功' }), 'flow 未返回成功')
  assert.equal(V.i18nFlowError({}), 'flow 未返回成功')
})

// ── 结果格式化 ──

test('formatCloneResult：爆款结构 + 复刻脚本两段', () => {
  const out = V.formatCloneResult({ meta: { duration: 10 } }, { title: '脚本' })
  assert.match(out, /══ 爆款结构/)
  assert.match(out, /══ 复刻脚本/)
  assert.match(out, /duration/)
  assert.match(out, /脚本/)
})

test('toEditorText：对象→缩进 JSON、字符串原样、空回退', () => {
  assert.equal(V.toEditorText('abc'), 'abc')
  assert.equal(V.toEditorText(null), '')
  assert.equal(V.toEditorText(undefined), '')
  assert.deepEqual(JSON.parse(V.toEditorText({ a: 1 })), { a: 1 })
})

// ── 工作流归一化（workflow_client.normalize_server_workflow）──────

test('normalizeServerWorkflow：缺 workflow_id / 非对象 → null', () => {
  assert.equal(V.normalizeServerWorkflow(null), null)
  assert.equal(V.normalizeServerWorkflow('x'), null)
  assert.equal(V.normalizeServerWorkflow({}), null)
})

test('normalizeServerWorkflow：常规条目映射', () => {
  const w = V.normalizeServerWorkflow({
    workflow_id: 'wf-1',
    name: '修复脸部',
    type: 'video',
    backend: 'comfy',
    description: '描述',
    instance_type: 'default',
    output_type: 'video',
    inputs: [{ key: 'video', kind: 'video' }],
  })
  assert.equal(w.id, 'wf-1')
  assert.equal(w.name, '修复脸部')
  assert.equal(w.backend, 'comfy')
  assert.equal(w.outputType, 'video')
  assert.equal(w.inputs.length, 1)
})

test('filterVideoWorkflows：只留 output_type=video', () => {
  const a = V.normalizeServerWorkflow({ workflow_id: 'a', output_type: 'video' })
  const b = V.normalizeServerWorkflow({ workflow_id: 'b', output_type: 'image' })
  const list = V.filterVideoWorkflows([a, b, null, undefined])
  assert.deepEqual(list.map((w) => w.id), ['a'])
})

test('workflowDisplayName / workflowDescText 文案', () => {
  const a = V.normalizeServerWorkflow({ workflow_id: 'a', name: 'N', backend: 'comfy', instance_type: 'default', description: 'D' })
  assert.equal(V.workflowDisplayName(a), 'N  [comfy]')
  assert.match(V.workflowDescText(a), /【COMFY】/)
  assert.match(V.workflowDescText(a), /D/)
})

// ── 动态表单（_build_edit_form / _collect_edit_payload）───────────

test('buildFormEntries：无 inputs 默认一个 video 字段', () => {
  const w = V.normalizeServerWorkflow({ workflow_id: 'a' })
  const es = V.buildFormEntries(w)
  assert.equal(es.length, 1)
  assert.equal(es[0].kind, 'video')
  assert.equal(es[0].required, true)
})

test('buildFormEntries：video 字段预置 defaultVideoPath', () => {
  const w = V.normalizeServerWorkflow({
    workflow_id: 'a',
    inputs: [{ key: 'video', kind: 'video', label: '视频', required: true }],
  })
  const es = V.buildFormEntries(w, '/output/v.mp4')
  assert.equal(es[0].default, '/output/v.mp4')
})

test('collectEditPayload：文件本地路径→files / 素材ID→values / 必填缺失→error', () => {
  const es = V.buildFormEntries(V.normalizeServerWorkflow({
    workflow_id: 'a',
    inputs: [
      { key: 'video', kind: 'video', label: '视频', required: true },
      { key: 'rate', kind: 'text', label: '倍速', required: false },
    ],
  }))
  // 本地路径 → files
  let p = V.collectEditPayload(es, { video: 'C:/v/a.mp4', rate: '1.5' })
  assert.equal(p.files.video, 'C:/v/a.mp4')
  assert.equal(p.values.rate, '1.5')
  assert.equal(p.error, '')
  // 素材 ID → values
  p = V.collectEditPayload(es, { video: '12345', rate: '' })
  assert.equal(p.values.video, '12345')
  // 必填缺失 → error
  p = V.collectEditPayload(es, { rate: '' })
  assert.match(p.error, /视频 为必填项/)
})

// ── 产品展示 ──

test('productDisplayName / productPromptText：常见字段拼装', () => {
  assert.equal(V.productDisplayName({ brand: 'A', model: 'M' }), 'A / M')
  assert.match(V.productPromptText({ brand: 'A', model: 'M', selling_points: '好' }), /品牌：A/)
  assert.match(V.productPromptText({ brand: 'A', model: 'M', selling_points: '好' }), /卖点：好/)
})

// ── 工具 ──

test('isServerPath / isLocalPathLike / guessPlatform 判定', () => {
  assert.equal(V.isServerPath('/output/a.mp4'), true)
  assert.equal(V.isServerPath('C:/v/a.mp4'), false)
  assert.equal(V.isLocalPathLike('C:/v/a.mp4'), true)
  assert.equal(V.isLocalPathLike('123'), false)
  assert.equal(V.guessPlatform('https://v.douyin.com/x'), 'douyin')
  assert.equal(V.guessPlatform('https://www.bilibili.com/v/x'), 'bilibili')
})

test('pathBasename：取尾段', () => {
  assert.equal(V.pathBasename('C:/v/a.mp4'), 'a.mp4')
  assert.equal(V.pathBasename('/server/output/clip.mp4'), 'clip.mp4')
})
