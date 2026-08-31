// ═══════════════════════════════════════════════════════════════
// skill-store.test.mjs — 本地技能安装/管理·主进程单测
// 被测：main/skill-store.js（对齐原 studio/utils/skill_manager.py）：
//   · .md / 目录（整目录复制）/ ZIP（嵌套 SKILL.md）三种安装来源
//   · 卸载保护：内置技能不可卸载；id 防路径穿越；不在 skills 内拒绝
//   · 列表：内置 + 用户技能扫描自愈
// 运行：node --test "tests/*.test.mjs"
// ═══════════════════════════════════════════════════════════════

import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createSkillStore } = require('../main/skill-store.js')
const AdmZip = require('adm-zip')

let tmp = ''
let userData = ''
let builtinRoot = ''
let store = null

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tintin-skillstore-'))
  userData = path.join(tmp, 'userdata')
  builtinRoot = path.join(tmp, 'builtin')
  // 内置技能：builtin/viral-download/SKILL.md
  fs.mkdirSync(path.join(builtinRoot, 'viral-download'), { recursive: true })
  fs.writeFileSync(
    path.join(builtinRoot, 'viral-download', 'SKILL.md'),
    '---\nname: 爆款视频下载\ndescription: 下载各平台视频\n---\n下载指令正文',
    'utf8'
  )
  store = createSkillStore({ userDataRoot: userData, builtinRoot })
})

test('listBuiltinSkills：扫描内置目录 → builtin=true、path 不暴露', () => {
  const list = store.listBuiltinSkills()
  assert.equal(list.length, 1)
  // id 口径：meta.id || slugify(name)（目录名仅在缺 name 时兑底，原版 _parse_skill_dir）
  assert.equal(list[0].id, '爆款视频下载')
  assert.equal(list[0].name, '爆款视频下载')
  assert.equal(list[0].builtin, true)
  assert.equal(list[0].path, '') // 内置只读展示，不暴露磁盘路径
})

test('installSkill(.md)：落 userData/skills/<id>/SKILL.md，列表可见', () => {
  const src = path.join(tmp, 'my-skill.md')
  fs.writeFileSync(src, '---\nname: 文案助手\ndescription: 帮我改写文案\n---\n指令正文', 'utf8')
  const entry = store.installSkill(src)
  assert.equal(entry.id, '文案助手')
  assert.equal(entry.builtin, false)
  assert.equal(
    fs.readFileSync(path.join(store.skillsDir, entry.id, 'SKILL.md'), 'utf8').includes('指令正文'),
    true
  )
  assert.equal(store.listSkills().length, 1)
})

test('installSkill(目录含 SKILL.md)：整目录复制（附带资源保留）', () => {
  const src = path.join(tmp, 'skill-dir')
  fs.mkdirSync(src, { recursive: true })
  fs.writeFileSync(path.join(src, 'SKILL.md'), '---\nname: 目录技能\n---\n正文', 'utf8')
  fs.writeFileSync(path.join(src, 'helper.txt'), '资源文件', 'utf8')
  const entry = store.installSkill(src)
  assert.equal(entry.id, '目录技能')
  assert.equal(fs.existsSync(path.join(entry.path, 'helper.txt')), true) // 附带资源随目录复制
})

test('installSkill(zip)：嵌套 SKILL.md 任意层级可安装（防穿越口径）', () => {
  const zipPath = path.join(tmp, 'pack.zip')
  const zip = new AdmZip()
  zip.addFile('pack/readme.txt', Buffer.from('说明'))
  zip.addFile('pack/sub/SKILL.md', Buffer.from('---\nname: 压缩包技能\n---\nZIP 正文', 'utf8'))
  zip.writeZip(zipPath)
  const entry = store.installSkill(zipPath)
  assert.equal(entry.id, '压缩包技能')
  assert.equal(fs.readFileSync(path.join(entry.path, 'SKILL.md'), 'utf8').includes('ZIP 正文'), true)
})

test('installSkill：重复安装默认覆盖（overwrite=true），id 不变', () => {
  const src = path.join(tmp, 'dup.md')
  fs.writeFileSync(src, '---\nname: 重复技能\n---\nv1', 'utf8')
  store.installSkill(src)
  fs.writeFileSync(src, '---\nname: 重复技能\n---\nv2', 'utf8')
  const entry = store.installSkill(src)
  assert.equal(fs.readFileSync(path.join(entry.path, 'SKILL.md'), 'utf8').includes('v2'), true)
})

test('installSkill：非法来源（无 .md 的目录 / 未知扩展名）报错', () => {
  const emptyDir = path.join(tmp, 'empty-dir')
  fs.mkdirSync(emptyDir, { recursive: true })
  assert.throws(() => store.installSkill(emptyDir), /SKILL\.md/)
  const exe = path.join(tmp, 'x.exe') // 文件存在但扩展名不支持 → 来源类型报错
  fs.writeFileSync(exe, 'bin', 'utf8')
  assert.throws(() => store.installSkill(exe), /\.md 文件、含 SKILL\.md 的目录或 \.zip/)
})

test('removeSkill：内置技能拒绝卸载；不存在报 NOT_FOUND', () => {
  assert.equal(store.removeSkill('viral-download').ok, false) // 内置不可卸载
  assert.equal(store.removeSkill('no-such-skill').error, 'NOT_FOUND')
})

test('removeSkill：id 防路径穿越（../ 逃逸拒绝），合法 id 正常卸载', () => {
  const outside = path.join(tmp, 'outside-target')
  fs.mkdirSync(outside, { recursive: true })
  assert.equal(store.removeSkill('..%2F..%2Foutside-target').ok, false)
  assert.equal(store.removeSkill('../outside-target').ok, false)
  assert.equal(fs.existsSync(outside), true) // 越权目标未被触碰
  // 合法卸载
  const src = path.join(tmp, 'rm.md')
  fs.writeFileSync(src, '---\nname: 待删技能\n---\n正文', 'utf8')
  const entry = store.installSkill(src)
  assert.equal(store.removeSkill(entry.id).ok, true)
  assert.equal(fs.existsSync(path.join(store.skillsDir, entry.id)), false)
})
