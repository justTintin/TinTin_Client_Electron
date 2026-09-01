// ═══════════════════════════════════════════════════════════════
// decision-logic.test.mjs — 人审决策点·渲染层纯逻辑单测
// 被测：renderer/src/composables/decisionLogic.ts（纯函数，无 vue 依赖；
// Node ≥22.18 原生 type stripping 直接加载）。
// 契约：服务端 PRD-human-in-loop-choices.md（live /guide 在线文档）——
//   · pending_decision：{decision_id, ask, kind, choices[{value,label,desc}],
//     default[], placeholder}（GET /tasks/unified/{id}，status=waiting_user_input）
//   · confirm body：{decision_id, choice:[...]} 或 {decision_id, action:'reject', reason}
//   · 错误：非法 choice → 422（提示合法值）；重复/过期提交 → 409 无副作用
// 运行：node --test "tests/*.test.mjs"
// ═══════════════════════════════════════════════════════════════

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizePendingDecision,
  validateDecisionSelection,
  mapDecisionError
} from '../renderer/src/composables/decisionLogic.ts'

// ── normalizePendingDecision：契约结构 → 归一；fail-closed ──

test('normalizePendingDecision：合法 multi_choice 全结构归一（default 过滤 choices 外的值）', () => {
  const raw = {
    decision_id: 'dc_step3_select_shots',
    ask: '请选择要混剪的镜头（可多选）',
    kind: 'multi_choice',
    choices: [
      { value: 'shot_01', label: '镜头1', desc: '0:03-0:08 特写 88分' },
      { value: 'shot_02', label: '镜头2' }
    ],
    default: ['shot_02', 'shot_99'], // shot_99 不在 choices 内 → 过滤
    placeholder: '选好后提交，我将继续混剪'
  }
  const d = normalizePendingDecision(raw)
  assert.ok(d)
  assert.equal(d.decisionId, 'dc_step3_select_shots')
  assert.equal(d.ask, '请选择要混剪的镜头（可多选）')
  assert.equal(d.kind, 'multi_choice')
  assert.equal(d.choices.length, 2)
  assert.deepEqual(d.default, ['shot_02'])
  assert.equal(d.placeholder, '选好后提交，我将继续混剪')
})

test('normalizePendingDecision：kind 缺省 → single_choice；desc/default/placeholder 缺省容错', () => {
  const d = normalizePendingDecision({
    decision_id: 'dc1', ask: '选音色',
    choices: [{ value: 'v1', label: '音色A' }]
  })
  assert.equal(d.kind, 'single_choice')
  assert.deepEqual(d.default, [])
  assert.equal(d.placeholder, '')
  assert.equal(d.choices[0].desc, '')
})

test('normalizePendingDecision：fail-closed——非对象/缺 decision_id/choices 非数组或空 → null', () => {
  assert.equal(normalizePendingDecision(null), null)
  assert.equal(normalizePendingDecision('x'), null)
  assert.equal(normalizePendingDecision({ ask: 'no id', choices: [{ value: 'a', label: 'A' }] }), null)
  assert.equal(normalizePendingDecision({ decision_id: 'd', ask: 'x', choices: 'bad' }), null)
  assert.equal(normalizePendingDecision({ decision_id: 'd', ask: 'x', choices: [] }), null)
})

// ── validateDecisionSelection：提交前本地校验（422 前置拦截） ──

test('validateDecisionSelection：single_choice 恰好 1 项（0 项/多项拒绝）', () => {
  assert.equal(validateDecisionSelection('single_choice', ['shot_01']), '')
  assert.ok(validateDecisionSelection('single_choice', []))
  assert.ok(validateDecisionSelection('single_choice', ['a', 'b']))
})

test('validateDecisionSelection：multi_choice 至少 1 项', () => {
  assert.equal(validateDecisionSelection('multi_choice', ['a', 'b']), '')
  assert.ok(validateDecisionSelection('multi_choice', []))
})

// ── mapDecisionError：主进程 {error,status,detail} → 用户文案 ──

test('mapDecisionError：409 → 决策已被处理提示；422 → 服务端 detail 优先', () => {
  const r409 = mapDecisionError({ error: 'HTTP 409', status: 409 })
  assert.ok(r409.includes('已被处理'), r409)
  const r422 = mapDecisionError({ error: 'HTTP 422', status: 422, detail: 'choice 必须在 [shot_01, shot_02] 内' })
  assert.ok(r422.includes('choice 必须在 [shot_01, shot_02] 内'), r422)
})

test('mapDecisionError：无 status/detail → 原始 error 兜底；空 → 通用失败文案', () => {
  assert.equal(mapDecisionError({ error: '网络错误' }), '网络错误')
  assert.ok(mapDecisionError(null).length > 0)
  assert.ok(mapDecisionError({ error: '' }).length > 0)
})
