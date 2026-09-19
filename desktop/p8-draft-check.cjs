// P8 诊断（执行后删除）：解析最新草稿的轨道/段类型
const fs = require('fs')
const path = require('path')
const draftDir = process.argv[2]
const c = JSON.parse(fs.readFileSync(path.join(draftDir, 'draft_content.json'), 'utf8'))
const tracks = c.tracks || []
const texts = c.materials.texts || []
const audios = c.materials.audios || []
console.log('tracks:', tracks.length)
tracks.forEach((t, i) => {
  const segs = t.segments || []
  const first = segs[0] || {}
  // 找段对应的材料类型
  let matType = '', matContent = ''
  const mid = first.material_id
  if (mid) {
    const mat = texts.find(x => x.id === mid)
    if (mat) { matType = mat.type; matContent = String(mat.content || '').slice(0, 40) }
  }
  console.log(`track[${i}] type=${JSON.stringify(t.type)} segs=${segs.length} flag=${t.flag} attr=${JSON.stringify(t.attribute)} firstMatType=${matType} firstText=${JSON.stringify(matContent)}`)
})
console.log('materials.texts:', texts.length, '| materials.audios:', audios.length)
// 文本段抽样：前3条的 content/type/时间
let shown = 0
for (const t of tracks) {
  for (const s of (t.segments || [])) {
    const mat = texts.find(x => x.id === s.material_id)
    if (mat && shown < 3) {
      console.log('抽样文本段:', JSON.stringify({ type: mat.type, content: String(mat.content).slice(0, 50), start: s.target_timerange && s.target_timerange.start, dur: s.target_timerange && s.target_timerange.duration, clipTransform: JSON.stringify(s.clip && s.clip.transform) }))
      shown++
    }
  }
}
