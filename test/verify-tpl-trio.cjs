// 真机验证：原生文字模板三件套导出 → 剪映首页可见（2026-09-15）
// 用法：node test/verify-tpl-trio.cjs  → 输出草稿目录 + 结构摘要
'use strict'
const path = require('node:path')
const fs = require('node:fs')
const JY = require('../desktop/main/jianying-exporter.js')

const video = path.resolve(__dirname, 'probe-allfx-in.mp4')
if (!fs.existsSync(video)) { console.error('缺测试视频', video); process.exit(1) }

// 真实模板：本机 Presets/Text_V2 的「超级推荐」（结构范本同款 resource_id）
const RID = '7575772843741580569'
const res = JY.exportMultiToDraft({
  videoPaths: [video],
  srtPaths: null,
  fxWords: ['超级推荐', '199元'],
  fxKinds: ['fancy', 'tpl'],
  tplEffectId: RID,
  textTemplateClips: [[
    { phrase: '199元', startUs: 500000, durUs: 1500000, resourceId: 'jy_' + RID },
    { phrase: '限时上新', startUs: 2500000, durUs: 2000000, resourceId: RID },
  ]],
  draftName: '原生文字模板轨验证_20260915',
  deps: { probeMedia: () => ({ durationSec: 5, width: 1080, height: 1920 }) },
})
console.log('export:', JSON.stringify({ success: res.success, draft: res.message, err: res.success ? undefined : res.message }))
if (!res.success) process.exit(1)

const content = JSON.parse(fs.readFileSync(path.join(res.message, 'draft_content.json'), 'utf-8'))
const m = content.materials
console.log('text_templates:', m.text_templates.length)
console.log('texts(填充):', m.texts.length, '条，内容=', m.texts.map((t) => { try { return JSON.parse(t.content).text } catch (_) { return '?' } }).join(' | '))
console.log('tracks:', content.tracks.map((t) => t.type + 'x' + t.segments.length).join(', '))
const tplTrack = content.tracks.find((t) => t.type === 'text' && t.segments.some((s) => s.material_id === (m.text_templates[0] || {}).id))
console.log('模板轨 segments:', tplTrack ? tplTrack.segments.length : '无')
for (const s of (tplTrack && tplTrack.segments) || []) {
  console.log('  seg target=', JSON.stringify(s.target_timerange), 'extraRefs=', s.extra_material_refs.length)
}
const tpl = m.text_templates[0]
if (tpl) {
  console.log('实例字段: resource_id=%s name=%s category=%s resources=%d non_text=%d path_exists=%s',
    tpl.resource_id, tpl.name, tpl.category_name, tpl.resources.length, tpl.non_text_info_resources.length,
    tpl.path ? fs.existsSync(tpl.path) : '(空)')
  console.log('text_info attach:', JSON.stringify(tpl.text_info_resources[0].attach_info))
  // 资源缓存存在性抽查（剪映打开时按 path 直接读缓存）
  const missing = tpl.resources.filter((r) => r.path && !fs.existsSync(r.path))
  console.log('resources 缓存缺失:', missing.length, missing.map((r) => r.resource_id).join(','))
}
// 首页索引登记（与应用内导出同口径）+ 蓝字轨应缺席
console.log('旧蓝字轨残留:', m.texts.some((t) => { try { const c = JSON.parse(t.content); return c.styles[0] && c.styles[0].bold && c.text === '199元' } catch (_) { return false } }))
const reg = JY.registerInRootMeta({ draftFolder: res.message, draftName: res.draftName, durationUs: 5000000, coverPath: '' })
console.log('register:', reg.ok)
console.log('DONE', res.message)
