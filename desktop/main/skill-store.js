// ═══════════════════════════════════════════════════════════════
// skill-store.js — 本地技能安装/管理（主进程，2026-08-31 工作台技能入口移植）
// 对齐原客户端 studio/utils/skill_manager.py + gui/skill_manager_dialog.py：
//   · 技能 = 含 SKILL.md 的目录（安装落 userData/skills/<skill_id>/SKILL.md）
//   · 安装来源：单个 .md / 含 SKILL.md（或唯一 .md）的文件夹 / ZIP 包
//     （ZIP 解压防路径穿越，原版 _safe_extract_zip 口径）
//   · 卸载：内置技能（随包分发 resources/skills，客户端功能）不允许卸载；
//     目标目录不在 skills 内拒绝删除（原版 remove_skill 口径）
//   · 列表：扫描自愈（不依赖索引文件；原版 list_skills 同语义）
//   · env:skills:* 4 条 IPC（list/install/remove）
// frontmatter/id 兜底解析在 skills-logic.js（纯函数，可单测）。
// ═══════════════════════════════════════════════════════════════
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const AdmZip = require('adm-zip')
const { parseSkillMd } = require('./skills-logic')

const isMarkdown = (name) => /\.(md|markdown)$/i.test(name)

/**
 * 递归复制目录（自实现，不用 fs.cpSync）：
 * Node v22.23.1 在本机实测 cpSync 目标路径含中文时原生崩溃（0xC0000005，
 * run-cjk.mjs 稳定复现）；技能 id 来自中文技能名，目录/ZIP 安装必踩，
 * 故改 readdir/copyFile 逐项复制（中文路径 writeFileSync/mkdirSync 已验证正常）。
 */
function copyDirDeep(src, dest) {
  fs.mkdirSync(dest, { recursive: true })
  for (const name of fs.readdirSync(src)) {
    const s = path.join(src, name)
    const d = path.join(dest, name)
    let st
    try { st = fs.statSync(s) } catch (_) { continue }
    if (st.isDirectory()) copyDirDeep(s, d)
    else if (st.isFile()) { try { fs.copyFileSync(s, d) } catch (_) { /* 单文件失败不阻塞安装 */ } }
  }
}

function createSkillStore({ userDataRoot, builtinRoot }) {
  const skillsDir = path.join(userDataRoot, 'skills')

  /** 读取技能目录 → 条目（无 SKILL.md 返回 null） */
  function entryFromSkillDir(skillDir, { builtin = false } = {}) {
    const mdPath = path.join(skillDir, 'SKILL.md')
    if (!fs.existsSync(mdPath)) return null
    let entry
    try {
      entry = parseSkillMd(fs.readFileSync(mdPath, 'utf8'), path.basename(skillDir))
    } catch (_) { return null } // 单目录解析失败跳过（扫描自愈，不阻塞列表）
    return { ...entry, source: 'skill', builtin, path: builtin ? '' : skillDir }
  }

  /** 已安装技能（userData/skills 扫描，按名称排序） */
  function listSkills() {
    if (!fs.existsSync(skillsDir)) return []
    const out = []
    for (const name of fs.readdirSync(skillsDir).sort()) {
      const d = path.join(skillsDir, name)
      if (!fs.statSync(d).isDirectory()) continue
      const e = entryFromSkillDir(d)
      if (e) out.push(e)
    }
    return out.sort((a, b) => String(a.name).localeCompare(String(b.name)))
  }

  /** 内置技能（随包分发，builtinRoot 各子目录内 SKILL.md；只读展示，不可卸载） */
  function listBuiltinSkills() {
    if (!builtinRoot || !fs.existsSync(builtinRoot)) return []
    const out = []
    for (const name of fs.readdirSync(builtinRoot).sort()) {
      const d = path.join(builtinRoot, name)
      try {
        if (!fs.statSync(d).isDirectory()) continue
      } catch (_) { continue }
      const e = entryFromSkillDir(d, { builtin: true })
      if (e) out.push(e)
    }
    return out.sort((a, b) => String(a.name).localeCompare(String(b.name)))
  }

  function isBuiltin(id) {
    const sid = String(id || '').trim()
    return !!sid && listBuiltinSkills().some((e) => e.id === sid)
  }

  /** 安装落位：写入 skills/<id>/SKILL.md（overwrite 覆盖已有；id 防穿越） */
  function writeEntry(entry, raw, overwrite) {
    fs.mkdirSync(skillsDir, { recursive: true })
    const skillsAbs = path.resolve(skillsDir)
    const dest = path.resolve(skillsAbs, String(entry.id))
    if (dest !== skillsAbs && !dest.startsWith(skillsAbs + path.sep)) {
      throw new Error('技能 id 非法，已拒绝安装')
    }
    if (fs.existsSync(dest)) {
      if (!overwrite) throw new Error(`技能已存在: ${entry.id}`)
      fs.rmSync(dest, { recursive: true, force: true })
    }
    fs.mkdirSync(dest, { recursive: true })
    fs.writeFileSync(path.join(dest, 'SKILL.md'), raw, 'utf8')
    return { ...entry, source: 'skill', builtin: false, path: dest }
  }

  /** 单个 .md 安装（原版 _copy_skill_file：内部仍落 <skill_id>/SKILL.md） */
  function installMdFile(mdPath, overwrite) {
    const raw = fs.readFileSync(mdPath, 'utf8')
    const fallback = path.basename(mdPath).replace(/\.(md|markdown)$/i, '')
    return writeEntry(parseSkillMd(raw, fallback), raw, overwrite)
  }

  /** 文件夹安装（含 SKILL.md → 整目录复制；唯一 .md → 单文件安装，原版口径） */
  function installDir(src, overwrite) {
    if (fs.existsSync(path.join(src, 'SKILL.md'))) {
      const raw = fs.readFileSync(path.join(src, 'SKILL.md'), 'utf8')
      const entry = parseSkillMd(raw, path.basename(src))
      const saved = writeEntry(entry, raw, overwrite)
      // 整目录复制（保留技能附带资源；SKILL.md 已由 writeEntry 写入，覆盖余下文件）
      try { copyDirDeep(src, saved.path) } catch (_) { /* 复制失败保留 SKILL.md */ }
      return saved
    }
    const mdFiles = fs.readdirSync(src).filter((f) => isMarkdown(f))
    if (mdFiles.length === 1) return installMdFile(path.join(src, mdFiles[0]), overwrite)
    if (!mdFiles.length) throw new Error('技能目录缺少 SKILL.md 或 .md 文件')
    throw new Error(`技能目录存在多个 .md 文件（${mdFiles.length} 个），请选择单个 .md 或保留 SKILL.md`)
  }

  /** ZIP 安装（safe extract 防穿越 → 找 SKILL.md 目录或唯一 .md，原版口径） */
  function installZip(zipPath, overwrite) {
    const zip = new AdmZip(zipPath)
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tintin-skill-'))
    try {
      for (const e of zip.getEntries()) {
        const target = path.resolve(tmp, e.entryName)
        if (target !== tmp && !target.startsWith(tmp + path.sep)) {
          throw new Error('技能包包含非法路径，已拒绝安装')
        }
        if (e.isDirectory) { fs.mkdirSync(target, { recursive: true }); continue }
        fs.mkdirSync(path.dirname(target), { recursive: true })
        fs.writeFileSync(target, e.getData())
      }
      // 任意层级找 SKILL.md（浅层优先）
      const queue = [tmp]
      while (queue.length) {
        const dir = queue.shift()
        let names = []
        try { names = fs.readdirSync(dir) } catch (_) { continue }
        if (names.includes('SKILL.md')) return installDir(dir, overwrite)
        for (const n of names) {
          const d = path.join(dir, n)
          try { if (fs.statSync(d).isDirectory()) queue.push(d) } catch (_) { /* 跳过 */ }
        }
      }
      const mdFiles = []
      const walk = (dir) => {
        let names = []
        try { names = fs.readdirSync(dir) } catch (_) { return }
        for (const n of names) {
          const p = path.join(dir, n)
          try {
            if (fs.statSync(p).isDirectory()) walk(p)
            else if (isMarkdown(n)) mdFiles.push(p)
          } catch (_) { /* 跳过 */ }
        }
      }
      walk(tmp)
      if (mdFiles.length === 1) return installMdFile(mdFiles[0], overwrite)
      throw new Error('技能包内未找到 SKILL.md 或唯一 .md 文件')
    } finally {
      try { fs.rmSync(tmp, { recursive: true, force: true }) } catch (_) { /* 清理失败不阻塞 */ }
    }
  }

  /** 安装技能（来源：.md / 目录 / .zip；返回规范化条目） */
  function installSkill(src, overwrite = true) {
    const p = String(src || '').trim()
    if (!p || !fs.existsSync(p)) throw new Error(`技能来源不存在: ${p}`)
    if (fs.statSync(p).isDirectory()) return installDir(p, overwrite)
    if (isMarkdown(p)) return installMdFile(p, overwrite)
    if (/\.zip$/i.test(p)) return installZip(p, overwrite)
    throw new Error('技能来源必须是 .md 文件、含 SKILL.md 的目录或 .zip 包')
  }

  /** 卸载（内置不可卸载；目标必须位于 skills 内，原版 remove_skill 口径） */
  function removeSkill(id) {
    const sid = String(id || '').trim()
    if (isBuiltin(sid)) return { ok: false, error: '内置技能不允许卸载' }
    if (!sid) return { ok: false, error: 'INVALID_ID' }
    const skillsAbs = path.resolve(skillsDir)
    const target = path.resolve(skillsAbs, sid)
    if (target !== skillsAbs && !target.startsWith(skillsAbs + path.sep)) {
      return { ok: false, error: '技能 id 非法，已拒绝卸载' }
    }
    if (!fs.existsSync(target)) return { ok: false, error: 'NOT_FOUND' }
    fs.rmSync(target, { recursive: true, force: true })
    return { ok: true }
  }

  return { skillsDir, listSkills, listBuiltinSkills, installSkill, removeSkill, isBuiltin }
}

/** IPC 注册（main.js app.whenReady 内调用；4 条 skills:*） */
function createSkillsIpc(ipcMain, { app }) {
  const builtinRoot = app.isPackaged
    ? path.join(process.resourcesPath, 'skills')
    : path.join(__dirname, '..', '..', 'resources', 'skills')
  const store = createSkillStore({ userDataRoot: app.getPath('userData'), builtinRoot })
  ipcMain.handle('skills:list', () => {
    try { return { ok: true, builtin: store.listBuiltinSkills(), user: store.listSkills() } }
    catch (e) { return { ok: false, builtin: [], user: [], error: String(e?.message || e) } }
  })
  ipcMain.handle('skills:install', (_e, src) => {
    try { return { ok: true, entry: store.installSkill(src) } }
    catch (e) { return { ok: false, error: String(e?.message || e) } }
  })
  ipcMain.handle('skills:remove', (_e, id) => {
    try { return store.removeSkill(id) }
    catch (e) { return { ok: false, error: String(e?.message || e) } }
  })
}

module.exports = { createSkillStore, createSkillsIpc }
