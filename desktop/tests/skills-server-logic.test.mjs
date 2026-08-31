// ══════════════════════════════════════════════════════════════
// skills-server-logic.test.mjs — 技能服务端登记纯函数单测
// （buildSkillRegisterBody / normalizeServerSkills）
// 运行：node --test "tests/*.test.mjs"
// 对照基准：原客户端 studio/utils/skill_manager.py
//   · register_skill L81-125：POST /skills body={skill_id,name,description,
//     instruction,machine_id,version}（缺 skill_id/name 拒绝）
//   · server_skills L153-186：响应兼容裸数组 / {skills:[…]} / {items:[…]}
// ══════════════════════════════════════════════════════════════
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { buildSkillRegisterBody, normalizeServerSkills } = await import('../main/skills-logic.js')

// ── buildSkillRegisterBody（对照原 register_skill body 口径）──

test('buildSkillRegisterBody: 规范条目 → 六字段 body，version 缺省回退 1.0.0', () => {
  const r = buildSkillRegisterBody(
    { id: 'pongfi-research', name: '深度调研', description: '行业调研', instruction: '请执行…', version: '2.1.0' },
    'machine-abc'
  )
  assert.equal(r.ok, true)
  assert.deepEqual(r.body, {
    skill_id: 'pongfi-research',
    name: '深度调研',
    description: '行业调研',
    instruction: '请执行…',
    machine_id: 'machine-abc',
    version: '2.1.0',
  })
})

test('buildSkillRegisterBody: version 缺失回退 1.0.0；字段前后空白清理', () => {
  const r = buildSkillRegisterBody(
    { id: '  my-skill  ', name: '  技能名  ', description: ' ', instruction: '', version: '' },
    ' m1 '
  )
  assert.equal(r.ok, true)
  assert.equal(r.body.skill_id, 'my-skill')
  assert.equal(r.body.name, '技能名')
  assert.equal(r.body.description, '')
  assert.equal(r.body.instruction, '')
  assert.equal(r.body.version, '1.0.0')
  assert.equal(r.body.machine_id, 'm1')
})

test('buildSkillRegisterBody: 缺 id / id+name 全空拒绝；name 缺失回退 id（同 skillToCandidate 口径）', () => {
  assert.deepEqual(buildSkillRegisterBody({ name: 'x' }, 'm'), { ok: false, error: 'MISSING_ID_OR_NAME' })
  assert.equal(buildSkillRegisterBody({ id: '  ' }, 'm').ok, false)
  assert.equal(buildSkillRegisterBody(null, 'm').ok, false)
  const r = buildSkillRegisterBody({ id: 'x' }, 'm')
  assert.equal(r.ok, true)
  assert.equal(r.body.name, 'x')
})

// ── normalizeServerSkills（对照原 server_skills 三种响应形态）──

test('normalizeServerSkills: 裸数组 / {skills} / {items} 三形态等价归一', () => {
  const item = { skill_id: 's1', name: '技能一', description: 'd', version: '1.0', machine_id: 'm1' }
  const arr = [item]
  for (const data of [arr, { skills: arr }, { items: arr }]) {
    const list = normalizeServerSkills(data)
    assert.equal(list.length, 1)
    assert.deepEqual(list[0], { id: 's1', name: '技能一', description: 'd', version: '1.0', machineId: 'm1' })
  }
})

test('normalizeServerSkills: 条目缺 skill_id 时回退 id / name，全缺剔除', () => {
  const list = normalizeServerSkills([{ id: 'only-id', name: '' }, { foo: 1 }, null])
  assert.equal(list.length, 1)
  assert.equal(list[0].id, 'only-id')
})

test('normalizeServerSkills: 非法输入安全回退空数组', () => {
  assert.deepEqual(normalizeServerSkills(undefined), [])
  assert.deepEqual(normalizeServerSkills(null), [])
  assert.deepEqual(normalizeServerSkills({}), [])
  assert.deepEqual(normalizeServerSkills('nope'), [])
})
