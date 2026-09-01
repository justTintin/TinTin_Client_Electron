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

const { buildSkillRegisterBody, normalizeServerSkills, buildSkillMdFromServer, parseSkillMd } = await import('../main/skills-logic.js')

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
    assert.deepEqual(list[0], { id: 's1', name: '技能一', description: 'd', version: '1.0', machineId: 'm1', instruction: '', tags: [] })
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

// ── 2026-09-01 技能下载：normalizeServerSkills 保留 instruction/tags ──
//    （客户端「从服务端下载技能」需完整 SKILL.md 内容）

test('normalizeServerSkills: 条目保留 instruction 与 tags（下载安装依赖）', () => {
  const list = normalizeServerSkills({ skills: [{
    id: 'viral-video-download', name: '视频下载', description: 'd',
    instruction: '# 视频下载\n\n## 用途\n…', tags: ['client_tool', '下载'], version: '1.0'
  }] })
  assert.equal(list.length, 1)
  assert.equal(list[0].instruction, '# 视频下载\n\n## 用途\n…')
  assert.deepEqual(list[0].tags, ['client_tool', '下载'])
  // 缺省回退空值（旧响应兼容）
  const bare = normalizeServerSkills({ skills: [{ id: 'x', name: 'y' }] })
  assert.equal(bare[0].instruction, '')
  assert.deepEqual(bare[0].tags, [])
})

// ── buildSkillMdFromServer：服务端条目 → SKILL.md 原文（下载安装落盘格式）──
//    frontmatter 单行化（splitFrontmatter 按 key: value 行解析，多行值会破坏结构）

test('buildSkillMdFromServer: 条目 → frontmatter(id/name/description/version/tags) + instruction 正文', () => {
  const r = buildSkillMdFromServer({
    id: 'my-skill', name: '调研技能', description: '多行\n描述',
    instruction: '# 标题\n\n正文第一段', version: '2.0', tags: ['a', 'b']
  })
  assert.equal(r.ok, true)
  assert.match(r.raw, /^---\n/)                          // frontmatter 起始
  assert.match(r.raw, /id: my-skill\n/)
  assert.match(r.raw, /name: 调研技能\n/)
  assert.match(r.raw, /description: 多行 描述\n/)          // 多行值单行化
  assert.match(r.raw, /version: 2.0\n/)
  assert.match(r.raw, /tags: \[a, b\]\n/)
  assert.equal(r.raw, '---\nid: my-skill\nname: 调研技能\ndescription: 多行 描述\nversion: 2.0\ntags: [a, b]\n---\n\n# 标题\n\n正文第一段')
  // 往返一致：parseSkillMd 解析回来 id/name/instruction 不变
  const back = parseSkillMd(r.raw, 'fallback')
  assert.equal(back.id, 'my-skill')
  assert.equal(back.name, '调研技能')
  assert.equal(back.instruction, '# 标题\n\n正文第一段')
})

test('buildSkillMdFromServer: 缺 id / 缺 instruction 拒绝；tags 非数组安全回退', () => {
  assert.equal(buildSkillMdFromServer({ name: 'x', instruction: 'y' }).ok, false)
  assert.equal(buildSkillMdFromServer({ id: 'x', instruction: '' }).ok, false)
  assert.equal(buildSkillMdFromServer(null).ok, false)
  const r = buildSkillMdFromServer({ id: 'x', name: 'y', instruction: 'z', tags: 'not-array' })
  assert.equal(r.ok, true)
  assert.equal(r.raw.includes('tags:'), false) // 非法 tags 不写入 frontmatter
})
