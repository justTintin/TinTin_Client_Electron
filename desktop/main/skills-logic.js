// ═══════════════════════════════════════════════════════════════
// skills-logic.js — 本地技能·纯函数逻辑层（无 IO / 无 electron 依赖，可单测）
// 对齐原客户端 studio/utils/skill_manager.py（2026-08-31 用户反馈：工作台
// 技能入口未随移植带入）：
//   · _split_frontmatter   → splitFrontmatter（YAML 风格简化解析：标量 /
//                            [a, b] 数组 / true|false；缺失时 meta 空、body 全文）
//   · _slugify             → slugify（id 兜底：小写 + 非 \w 中文- 连字符归一）
//   · _parse_skill_dir     → parseSkillMd（name/description 兜底：目录名 /
//                            正文首行去 #；instruction=正文）
// 条目口径（与智能体同构，skill_entries L203-207）：id/name/description/
// instruction/version/author/tags。
// ═══════════════════════════════════════════════════════════════

/** frontmatter 解析（原版 _split_frontmatter：--- 起始、\n--- 结束、key: value 行） */
function splitFrontmatter(raw) {
  const text = String(raw || '').replace(/^\uFEFF/, '')
  if (!text.startsWith('---')) return { meta: {}, body: text.trim() }
  const end = text.indexOf('\n---', 3)
  if (end === -1) return { meta: {}, body: text.trim() }
  const meta = {}
  for (const line0 of text.slice(3, end).split(/\r?\n/)) {
    const line = line0.trim()
    if (!line || !line.includes(':')) continue
    const idx = line.indexOf(':')
    const key = line.slice(0, idx).trim().toLowerCase()
    let val = line.slice(idx + 1).trim()
    if (!key || !val) continue
    if (val.startsWith('[') && val.endsWith(']')) {
      val = val.slice(1, -1).split(',').map((v) => v.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
    } else if (val.toLowerCase() === 'true') {
      val = true
    } else if (val.toLowerCase() === 'false') {
      val = false
    }
    meta[key] = val
  }
  return { meta, body: text.slice(end + 4).trim() }
}

/** id 兜底（原版 _slugify：小写 + 非法字符归一为连字符；空回退 'skill'） */
function slugify(text) {
  let s = String(text || '').trim().toLowerCase().replace(/[^\w\u4e00-\u9fff-]+/g, '-')
  s = s.replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '')
  return s || 'skill'
}

/**
 * 解析 SKILL.md 原文 → 规范化技能条目（原版 _parse_skill_dir/_copy_skill_file 口径）：
 *   name 兜底 fallbackName；description 兜底正文首行去 #；
 *   instruction=正文（frontmatter 缺失时为全文）；id=meta.id || slugify(name)。
 */
function parseSkillMd(raw, fallbackName) {
  const { meta, body } = splitFrontmatter(raw)
  const name = String(meta.name || fallbackName || '').trim()
  let desc = String(meta.description || '').trim()
  if (!desc && body) desc = body.split(/\r?\n/)[0].replace(/^#+/, '').trim()
  return {
    id: String(meta.id || slugify(name)),
    name,
    description: desc,
    version: String(meta.version || '1.0.0'),
    author: String(meta.author || ''),
    tags: Array.isArray(meta.tags) ? meta.tags : [],
    instruction: body || String(raw || '').trim(),
  }
}

/**
 * 服务端技能登记 body（原版 register_skill L81-125 口径：POST /skills，
 * executor 由服务端按客户端来源固定 client_tool，body 含
 * skill_id/name/description/instruction/machine_id/version；失败仅告警不阻塞本地）。
 * 返回 { ok, body?, error? }：缺 skill_id/name 时拒绝登记。
 */
function buildSkillRegisterBody(entry, machineId) {
  const skillId = String(entry?.id || '').trim()
  const name = String(entry?.name || entry?.id || '').trim()
  if (!skillId || !name) return { ok: false, error: 'MISSING_ID_OR_NAME' }
  const body = {
    skill_id: skillId,
    name,
    description: String(entry?.description || '').trim(),
    instruction: String(entry?.instruction || '').trim(),
    machine_id: String(machineId || '').trim(),
    version: String(entry?.version || '1.0.0'),
  }
  return { ok: true, body }
}

/**
 * 服务端技能列表归一（原版 server_skills L153-186 口径：响应兼容裸数组与
 * {skills:[…]} / {items:[…]} 三种形态；条目回退本地 name/description 同构）。
 */
function normalizeServerSkills(data) {
  const raw = Array.isArray(data)
    ? data
    : (data && typeof data === 'object' && Array.isArray(data.skills))
      ? data.skills
      : (data && typeof data === 'object' && Array.isArray(data.items))
        ? data.items
        : []
  return raw
    .filter((s) => s && typeof s === 'object')
    .map((s) => ({
      id: String(s.skill_id || s.id || '').trim(),
      name: String(s.name || s.skill_id || s.id || ''),
      description: String(s.description || ''),
      version: String(s.version || ''),
      machineId: String(s.machine_id || ''),
    }))
    .filter((s) => s.id)
}

module.exports = { splitFrontmatter, slugify, parseSkillMd, buildSkillRegisterBody, normalizeServerSkills }
