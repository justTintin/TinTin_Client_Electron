// ═══════════════════════════════════════════════════════════════
// workbench-skills-logic.test.mjs — 工作台技能·渲染层纯函数单测
// 被测：renderer/src/composables/skillsLogic.ts（原 agent_home_page.py 口径）：
//   · 技能与智能体同构合并（快捷条尾部 + 斜杠候选）
//   · 技能唤醒词前缀（请按技能【name】执行：instruction）
//   · 斜杠段替换 / 旧前缀剥离（_insert_agent L338-361、L1544-1549 口径）
// 运行：node --test "tests/*.test.mjs"
// ═══════════════════════════════════════════════════════════════

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)

// Node 原生 type-stripping 直载 .ts（allowImportingTsExtensions，与
// workbench-context-logic.test.mjs 同模式）
const L = require('../renderer/src/composables/skillsLogic.ts')

const mkSkill = (id, name, extra = {}) => ({
  id, name, description: extra.description || `${name}描述`, instruction: extra.instruction ?? `${name}指令正文`,
  builtin: !!extra.builtin
})

test('skillToCandidate：与智能体同构（desc=description、source=skill、instruction 保留）', () => {
  const c = L.skillToCandidate(mkSkill('s1', '文案改写'))
  assert.deepEqual(c, { id: 's1', name: '文案改写', desc: '文案改写描述', source: 'skill', instruction: '文案改写指令正文' })
})

test('skillQuickEntries：key 带 skill: 前缀、kind=skill；id 缺失跳过', () => {
  const list = L.skillQuickEntries([mkSkill('s1', '甲'), mkSkill('', '无id'), mkSkill('s2', '乙')])
  assert.deepEqual(list, [
    { key: 'skill:s1', kind: 'skill', name: '甲', desc: '甲描述' },
    { key: 'skill:s2', kind: 'skill', name: '乙', desc: '乙描述' }
  ])
})

test('mergeSkillCandidates：智能体在前技能在后（原版 L1519 顺序）', () => {
  const agents = [{ id: 'a1', name: '智能体甲', desc: 'd1' }]
  const merged = L.mergeSkillCandidates(agents, [mkSkill('s1', '技能乙')])
  assert.equal(merged.length, 2)
  assert.equal(merged[0].id, 'a1')
  assert.equal(merged[1].source, 'skill')
  assert.equal(merged[1].name, '技能乙')
})

test('mergeSkillCandidates：空安全（agents/skills 非数组回退空）', () => {
  assert.deepEqual(L.mergeSkillCandidates(null, undefined), [])
})

test('buildSkillWakeText：有 instruction → 请按技能【name】执行：instruction', () => {
  assert.equal(
    L.buildSkillWakeText({ name: '视频下载', instruction: '打开素材浏览器下载' }),
    '请按技能【视频下载】执行：打开素材浏览器下载'
  )
})

test('buildSkillWakeText：无 instruction → 请按技能【name】执行；name 空回退该技能', () => {
  assert.equal(L.buildSkillWakeText({ name: 'X', instruction: '  ' }), '请按技能【X】执行')
  assert.equal(L.buildSkillWakeText({}), '请按技能【该技能】执行')
})

test('applySkillWakeInsert：光标前 /关键字 段替换为技能唤醒词', () => {
  const r = L.applySkillWakeInsert('帮我 /ship', 8, { name: '视频下载', instruction: 'inst' })
  assert.equal(r.text, '帮我 请按技能【视频下载】执行：inst')
  assert.equal(r.caret, '帮我 '.length + '请按技能【视频下载】执行：inst'.length)
})

test('applySkillWakeInsert：无斜杠时在光标处插入', () => {
  const r = L.applySkillWakeInsert('正文', 2, { name: 'X' })
  assert.equal(r.text, '正文请按技能【X】执行')
})

test('stripWakePrefixLine：剥离旧技能前缀 / 旧智能体前缀首行', () => {
  assert.equal(
    L.stripWakePrefixLine('请按技能【甲】执行：do it\n\n真实需求'),
    '真实需求'
  )
  assert.equal(
    L.stripWakePrefixLine('请【智能体甲】智能体执行：desc\n\n真实需求'),
    '真实需求'
  )
  assert.equal(L.stripWakePrefixLine('没有前缀的文本'), '没有前缀的文本')
})

test('applyWakePrefix：剥离旧前缀后以新唤醒词开头（原版 L1549 口径）', () => {
  const out = L.applyWakePrefix(
    '请按技能【甲】执行：old\n\n帮我做视频',
    L.buildSkillWakeText({ name: '视频下载', instruction: 'inst' })
  )
  assert.equal(out, '请按技能【视频下载】执行：inst\n\n帮我做视频')
})

test('applyWakePrefix：无旧前缀原文全保留；空正文仅前缀', () => {
  assert.equal(L.applyWakePrefix('纯文本', 'P'), 'P\n\n纯文本')
  assert.equal(L.applyWakePrefix('', 'P'), 'P')
})
