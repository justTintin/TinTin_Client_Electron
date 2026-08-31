// ═══════════════════════════════════════════════════════════════
// skills-logic.test.mjs — 本地技能·主进程纯函数单测
// 被测：main/skills-logic.js（对齐原 studio/utils/skill_manager.py）：
//   · _split_frontmatter（--- 包裹 / 数组 / 布尔 / 缺失回退全文）
//   · _slugify（中文保留、非法字符归一连字符）
//   · _parse_skill_dir 口径（name/description 兜底、instruction=正文）
// 运行：node --test "tests/*.test.mjs"
// ═══════════════════════════════════════════════════════════════

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)

const L = require('../main/skills-logic.js')

test('splitFrontmatter：标准 frontmatter（标量/数组）→ meta+body', () => {
  const raw = '---\nname: 文案改写\nversion: 1.0.0\ntags: [文案, 改写]\n---\n正文第一行\n正文第二行'
  const { meta, body } = L.splitFrontmatter(raw)
  assert.equal(meta.name, '文案改写')
  assert.equal(meta.version, '1.0.0')
  assert.deepEqual(meta.tags, ['文案', '改写'])
  assert.equal(body, '正文第一行\n正文第二行')
})

test('splitFrontmatter：缺失 --- → meta 空、body 全文；无结束符同样回退', () => {
  assert.deepEqual(L.splitFrontmatter('直接正文'), { meta: {}, body: '直接正文' })
  assert.deepEqual(L.splitFrontmatter('---\nname: x\n没有结束'), { meta: {}, body: '---\nname: x\n没有结束'.trim() })
})

test('splitFrontmatter：BOM 头 + 布尔值', () => {
  const { meta } = L.splitFrontmatter('\uFEFF---\nname: a\nenabled: true\noff: false\n---\nbody')
  assert.equal(meta.enabled, true)
  assert.equal(meta.off, false)
})

test('slugify：中文保留、非法字符归一连字符、空回退 skill', () => {
  assert.equal(L.slugify('文案 风格/改写'), '文案-风格-改写')
  assert.equal(L.slugify('A  B--C'), 'a-b-c')
  assert.equal(L.slugify(''), 'skill')
})

test('parseSkillMd：name/description 兜底（fallback 名 + 正文首行去 #）', () => {
  const e = L.parseSkillMd('# 我的技能\n正文指令', 'fallback-name')
  assert.equal(e.name, 'fallback-name') // 无 frontmatter → 兜底名
  assert.equal(e.description, '我的技能') // 正文首行去 #
  assert.equal(e.instruction, '# 我的技能\n正文指令')
  assert.ok(e.id.length > 0)
})

test('parseSkillMd：frontmatter 齐全 → id/版本/author/tags 原样，instruction=正文', () => {
  const raw = '---\nid: my-skill\nname: 技能甲\ndescription: 描述\nversion: 2.1.0\nauthor: 张三\ntags: [a]\n---\n指令正文'
  const e = L.parseSkillMd(raw, 'x')
  assert.equal(e.id, 'my-skill')
  assert.equal(e.name, '技能甲')
  assert.equal(e.description, '描述')
  assert.equal(e.version, '2.1.0')
  assert.equal(e.author, '张三')
  assert.deepEqual(e.tags, ['a'])
  assert.equal(e.instruction, '指令正文')
})
