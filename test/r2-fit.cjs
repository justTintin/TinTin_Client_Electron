// test/r2-fit.cjs — R2 装饰图标坐标标定：PNG↔封面 模板匹配实测（只读分析）
// 用法：node test/r2-fit.cjs <预设名>
// 原理：按「PNG 自然尺寸 == elements[].original_size」配对，显示尺寸 = natural × element.scale，
//       在 860x860 封面做 alpha 加权 SAD 全搜，实测元素真实中心，与 transform 对照，
//       反推 attach_info.clip.transform 的坐标语义（单位/锚点/y 方向）。
'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const FFMPEG = path.resolve(__dirname, '..', 'resources', 'bin', 'ffmpeg.exe')
const DIR = path.join(process.env.LOCALAPPDATA, 'JianyingPro', 'User Data', 'Presets', 'Text_V2')
const TMP = path.resolve(__dirname, 'm0-out', 'r2-raw')
fs.mkdirSync(TMP, { recursive: true })

function decodeRgba(imgPath, w, h, tag) {
  const out = path.join(TMP, tag + '.raw')
  execFileSync(FFMPEG, ['-y', '-v', 'error', '-i', imgPath, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-vf', 'scale=' + w + ':' + h, out], { stdio: 'pipe' })
  return { w: w, h: h, data: fs.readFileSync(out) }
}

function pngSize(fp) {
  const b = fs.readFileSync(fp)
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) }
}

// alpha 加权 SAD 全搜（步长2）
function search(cover, tplRaw) {
  const tw = tplRaw.w, th = tplRaw.h, td = tplRaw.data
  let best = null
  for (let py = 0; py + th <= cover.h; py += 2) {
    for (let px = 0; px + tw <= cover.w; px += 2) {
      let score = 0, n = 0
      for (let y = 0; y < th; y += 2) {
        for (let x = 0; x < tw; x += 2) {
          const ti = (y * tw + x) * 4
          if (td[ti + 3] < 80) continue
          const ci = ((py + y) * cover.w + px + x) * 4
          score += Math.abs(cover.data[ci] - td[ti]) + Math.abs(cover.data[ci + 1] - td[ti + 1]) + Math.abs(cover.data[ci + 2] - td[ti + 2])
          n++
        }
      }
      score = n ? score / n : 1e9
      if (!best || score < best.score) best = { x: px + tw / 2, y: py + th / 2, score: score }
    }
  }
  return best
}

// ── 主流程 ──
const target = process.argv[2] || '预设文本1'
const p = JSON.parse(fs.readFileSync(path.join(DIR, target + '.textpreset'), 'utf-8'))
const cover = decodeRgba(p.cover_image_path, 860, 860, 'cover')
console.log('预设:', target, '| elements:', (p.elements || []).length, '| cover 860x860 中心=(430,430)')

const CX = 430, CY = 430
;(p.elements || []).forEach((e, i) => {
  const c = e.attach_info.clip
  const ow = e.attach_info.original_size_width, oh = e.attach_info.original_size_height
  let src = null
  for (const r of p.resources || []) {
    try {
      for (const f of fs.readdirSync(r.file_path)) {
        if (!f.endsWith('.png')) continue
        const fp = path.join(r.file_path, f)
        const sz = pngSize(fp)
        if (sz.w === ow && sz.h === oh) src = { fp: fp, w: sz.w, h: sz.h }
      }
    } catch (e2) {}
  }
  if (!src) { console.log('elem' + i + ': 未找到 ' + ow + 'x' + oh + ' PNG → 跳过'); return }
  const dw = Math.max(4, Math.round(ow * c.scale_x)), dh = Math.max(4, Math.round(oh * c.scale_y))
  const tpl = decodeRgba(src.fp, dw, dh, 'e' + i)
  const m = search(cover, tpl)
  if (!m) { console.log('elem' + i + ': 未匹配'); return }
  const dx = m.x - CX, dy = m.y - CY
  console.log('elem' + i + ' natural=' + ow + 'x' + oh + ' 显示=' + dw + 'x' + dh + ' score=' + m.score.toFixed(0))
  console.log('   实测中心=(' + m.x.toFixed(0) + ',' + m.y.toFixed(0) + ') 中心偏移 dx=' + dx.toFixed(0) + ' dy=' + dy.toFixed(0) + ' (y向下为正)')
  console.log('   transform=(' + c.transform_x.toFixed(1) + ', ' + c.transform_y.toFixed(1) + ') rot=' + c.rotation.toFixed(1))
  const rx = c.transform_x ? (dx / c.transform_x).toFixed(2) : '-'
  const ry = c.transform_y ? (dy / (-c.transform_y)).toFixed(2) : '-'
  console.log('   比值[y-up假设]: dx/tx=' + rx + '  dy/(-ty)=' + ry)
})
