// P3：Step3 面板抽取（node p3-step.cjs [--dry]）。先校验后变更，锚点即时定位。
const fs = require('fs')
const dry = process.argv.includes('--dry')
const VF = 'renderer/src/components/media-tools/VideoMontage.vue'
let lines = fs.readFileSync(VF, 'utf8').split('\n')
const clean = l => l.replace(/\r$/, '')
const find = (s, from = 0) => lines.findIndex((l, i) => i >= from && l.includes(s))
const must = (i, why) => { if (i < 0) { console.error('锚点缺失: ' + why); process.exit(1) } return i }

// ── 1) 四个抽取块（锚点 + div/template 深度匹配）──
const depthScan = (startIdx, openRe, closeRe) => {
  let d = 0
  for (let i = startIdx; i < lines.length; i++) {
    const l = clean(lines[i])
    d += (l.match(openRe) || []).length
    d -= (l.match(closeRe) || []).length
    if (d <= 0) return i
  }
  return -1
}
const s3i = must(find('<template v-else-if="step === 2">'), 'step3 面板头')
const s3e = depthScan(s3i, /<template\b/g, /<\/template>/g)
const nsi = must(find('<div v-if="step === 2" class="ns-section">'), 'ns-section')
const nse = depthScan(nsi, /<div\b/g, /<\/div>/g)
const aiRi = must(find('<div v-if="aiRewriteDlg.show"'), 'aiRewriteDlg')
const aiRe = depthScan(aiRi, /<div\b/g, /<\/div>/g)
const clNi = must(find('<div v-if="cloneParamsDlg.show"'), 'cloneParamsDlg')
const clNe = depthScan(clNi, /<div\b/g, /<\/div>/g)
const edi = must(find('<div v-if="editDlg.show"'), 'editDlg')
const ede = depthScan(edi, /<div\b/g, /<\/div>/g)
const spans = { step3: [s3i, s3e], ns: [nsi, nse], ai: [aiRi, aiRe], clone: [clNi, clNe], edit: [edi, ede] }
for (const [k, [a, b]] of Object.entries(spans)) {
  if (b < a) { console.error(k + ' 区间倒置'); process.exit(1) }
  console.log('[dry] ' + k + ': ' + (a + 1) + '..' + (b + 1) + ' (' + (b - a + 1) + ' 行)')
}
const tplLines = [
  // step3 子块：去 <template v-else-if> 包装对
  (() => {
    const s3 = lines.slice(s3i, s3e + 1).map(clean)
    s3.shift()
    while (s3.length && !s3[s3.length - 1].trim()) s3.pop()
    if (s3[s3.length - 1].trim() !== '</template>') { console.error('step3 尾异常: ' + s3[s3.length - 1]); process.exit(1) }
    s3.pop()
    return s3
  })(),
  ...lines.slice(nsi, nse + 1).map(clean),
  ...lines.slice(aiRi, aiRe + 1).map(clean),
  ...lines.slice(clNi, clNe + 1).map(clean),
  ...lines.slice(edi, ede + 1).map(clean),
].flat()

// ── 2) 自动解构：扫描组合式 return 键（逐段解析，含别名）──
const umFile = fs.readFileSync('renderer/src/composables/useVideoMontage.ts', 'utf8').split('\n')
const rStart = umFile.findIndex(l => l.trim() === 'return {')
const keys = []
for (let i = rStart + 1; i < umFile.length; i++) {
  const l = clean(umFile[i])
  if (l.trim() === '}') break
  const t = l.trim()
  if (!t || t.startsWith('//')) continue
  for (const piece of t.split(',')) {
    const p = piece.trim()
    if (!p || p.startsWith('//')) continue
    const mm = p.match(/^([A-Za-z_][A-Za-z0-9_]*)(?:\s*:\s*([A-Za-z_$][\w$]*))?$/)
    if (mm) keys.push({ name: mm[1], alias: mm[2] || mm[1] })
  }
}
const uniqKeys = [...new Map(keys.map(k => [k.alias, k])).values()]
const tplText = tplLines.join('\n')

// ── 3) 类名 → 样式规则 ──
const styleStart = must(find('<style scoped>'), '样式段')
const styleText = lines.slice(styleStart).join('\n').replace('<style scoped>', '').replace(/\r/g, '')
const rules = []
depth = 0; cur = ''
for (const ch of styleText) {
  cur += ch
  if (ch === '{') depth++
  if (ch === '}') { depth--; if (depth === 0) { rules.push(cur.trim()); cur = '' } }
}
const used = new Set()
for (const m of tplText.matchAll(/class="([^"]+)"/g)) m[1].split(/\s+/).forEach(c => { if (c && !c.includes(':') && !c.includes('{')) used.add(c) })
for (const m of tplText.matchAll(/'(score-(?:high|mid|low)|st-(?:ok|busy|pending))'/g)) used.add(m[1])
const picked = rules.filter(r => { const sel = r.split('{')[0]; return [...used].some(c => sel.includes('.' + c)) })
console.log('[dry] 样式规则:', picked.length, '条')

// ── 4) 脚本簇抽取（随迁面板）──
const ttsA = must(find('/** TTS 引擎下拉选项'), 'TTS 选项头')
const ttsB = must(find('── Step4 BGM 选择弹窗'), 'TTS 选项尾')
const ttsCluster = lines.slice(ttsA, ttsB - 1).map(clean).join('\n').replace(/\r/g, '')
const nsA = must(find('页尾上传新样本'), '样本拖拽簇头')
const nsB = must(find('function onNsDropForward'), '样本拖拽簇尾')
const nsCluster = lines.slice(nsA, nsB).map(clean).join('\n').replace(/\r/g, '')
const fwdA = must(find('function onNsDropForward'), 'onNsDropForward')
const fwB = must(find('参考声音下拉（用户裁决', fwdA), 'onNsDropForward 尾')
const fwdCluster = lines.slice(fwdA, fwB - 1).map(clean).join('\n').replace(/\r/g, '')
const refA = must(find('参考声音下拉（用户裁决 2026-09-03'), '参考声音簇头')
const refB = must(find('/** 花字样式下拉（原版 fancy_style_combo 7 项） */'), '参考声音簇尾')
const refCluster = lines.slice(refA, refB).map(clean).join('\n').replace(/\r/g, '')
const usageScan = [tplText, ttsCluster, nsCluster, fwdCluster, refCluster].join('\n')
const usedKeys = uniqKeys.filter(k => new RegExp('\\b' + k.alias + '\\b').test(usageScan))
console.log('[dry] 候选键:', uniqKeys.length, '；面板使用:', usedKeys.length)
console.log('[dry] 解构清单:', usedKeys.map(k => k.alias).join(', '))

if (dry) { console.log('DRY 通过，未写盘'); process.exit(0) }

// ── 5) 组装 MontageStep3Panel.vue ──
const content = [
  '<script setup lang="ts">',
  '// ═══════════════════════════════════════════════════════════════',
  '// MontageStep3Panel.vue — 智能混剪 Step3 口播配音面板（铁律 10 Phase3 P3，2026-09-19）',
  '// 模板/样式自 VideoMontage.vue 逐字搬迁；状态经 inject 解构回原名（零改动）。',
  '// 本面板本地逻辑：TTS 引擎/情感选项、页尾样本上传拖拽（useFilePicker）、',
  '// 参考声音下拉、生命周期（进 Step3 拉样本/字体/模板清单由 Shell 编排）。',
  '// ═══════════════════════════════════════════════════════════════',
  "import { ref, computed, inject } from 'vue'",
  "import TButton from '@/components/common/TButton.vue'",
  "import TSelect from '@/components/common/TSelect.vue'",
  "import VdStepBar from './VdStepBar.vue'",
  "import { useFilePicker } from '@/composables/useFilePicker'",
  "import { montageShellKey } from './montageUiContext'",
  "import { pathBasename } from '@/composables/videoMontageLogic'",
  '',
  'const shell = inject(montageShellKey)!',
  'const { step, go, vdLeftStyle, onSplitDown } = shell',
  'const {',
  ...usedKeys.map(k => k.alias === k.name ? '  ' + k.name + ',' : '  ' + k.name + ': ' + k.alias + ','),
  '} = shell.s',
  '',
  ttsCluster,
  '',
  nsCluster,
  '',
  fwdCluster,
  '',
  refCluster,
  '</script>',
  '',
  '<template>',
  ...tplLines,
  '</template>',
  '',
  '<style scoped>',
  ...picked,
  '</style>',
].join('\n')
fs.writeFileSync('renderer/src/components/media-tools/MontageStep3Panel.vue', content)

// ── 6) Shell 修补（倒序变更：edit → clone → ai → ns → step3 段 → 脚本簇）──
lines.splice(edi, ede - edi + 1)
lines.splice(clNi, clNe - clNi + 1)
lines.splice(aiRi, aiRe - aiRi + 1)
lines.splice(nsi, nse - nsi + 1)
lines.splice(s3i, s3e - s3i + 1, '    <MontageStep3Panel v-else-if="step === 2" />')
// 脚本簇删除（重新定位；顺序：自底向上，避免锚点被先行删除）
const dTtsA = must(find('/** TTS 引擎下拉选项'), 'dTts')
const dTtsB = must(find('── Step4 BGM 选择弹窗'), 'dTts 尾')
lines.splice(dTtsA, dTtsB - dTtsA)
const dNsA = must(find('页尾上传新样本'), 'dNs')
const dNsB = must(find('function onNsDropForward'), 'dNs 尾')
lines.splice(dNsA, dNsB - dNsA)
const dFwdA = must(find('function onNsDropForward'), 'dFwd')
const dFwB = must(find('参考声音下拉（用户裁决'), 'dFwd 尾')
lines.splice(dFwdA, dFwB - dFwdA)
const dRefA = must(find('参考声音下拉（用户裁决 2026-09-03'), 'dRef')
const dRefB = must(find('/** 花字样式下拉（原版 fancy_style_combo 7 项） */'), 'dRef 尾')
lines.splice(dRefA, dRefB - dRefA)
fs.writeFileSync(VF, lines.join('\n'))
console.log('OK 面板:', content.split('\n').length, '行；主文件现', lines.length, '行')
