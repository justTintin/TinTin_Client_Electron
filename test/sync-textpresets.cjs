// test/sync-textpresets.cjs — 文字模板同步固化脚本（R2 定位公式 + R4 批量上传）
// 用法：
//   node test/sync-textpresets.cjs                # 仅生成模板包到 test/m0-out/jy_<rid>/
//   node test/sync-textpresets.cjs --upload       # 生成 + 上传服务端（幂等 upsert）
// 定位公式（R2 标定，2026-09-12）：设计画布 720x720、中心原点、y 向上；封面 860 = 720x1.194。
//   offset_x = transform_x * 100/720 （% 画布宽，向右）；offset_y = -transform_y * 100/720（向下）
//   显示宽 = natural * scale * 100/720（% 画布宽）
'use strict'
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const { execFileSync } = require('node:child_process')

const SERVER = '192.168.111.31'
const PDIR = path.join(process.env.LOCALAPPDATA, 'JianyingPro', 'User Data', 'Presets', 'Text_V2')
const OUT = path.resolve(__dirname, 'm0-out')
const UPLOAD = process.argv.includes('--upload')
const ONLY = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : ''
const DESIGN = 720

function buildPackage(presetPath) {
  const p = JSON.parse(fs.readFileSync(presetPath, 'utf-8'))
  const eff = p.effect || {}
  const rid = eff.resource_id || eff.effect_id
  if (!rid) throw new Error('no effect resource_id')
  const para = (p.paragraphs || [])[0] || {}
  let text = '', color = '#FFFFFF', fontSize = 60
  try {
    const cc = JSON.parse(para.content)
    text = cc.text || ''
    for (const st of cc.styles || []) {
      if (st.size) fontSize = st.size
      if (st.fill && st.fill.content && st.fill.content.solid) {
        const col = st.fill.content.solid.color
        if (Array.isArray(col) && col.length >= 3) color = '#' + col.slice(0, 3).map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('')
      }
    }
  } catch (e) {}
  if (!text) text = String(eff.effect_name || rid)
  const pc = (para.attach_info && para.attach_info.clip) || {}
  const textScale = pc.scale_x || 1
  const textRot = pc.rotation || 0
  const fsVw = (fontSize * textScale * 100 / DESIGN).toFixed(3)

  const decorations = []
  const seen = new Set()
  for (const r of p.resources || []) {
    try {
      for (const f of fs.readdirSync(r.file_path)) {
        if (!f.endsWith('.png')) continue
        const fp = path.join(r.file_path, f)
        const b = fs.readFileSync(fp)
        const nw = b.readUInt32BE(16), nh = b.readUInt32BE(20)
        const key = nw + 'x' + nh + ':' + b.length
        if (seen.has(key)) continue
        seen.add(key)
        decorations.push({ b64: b.toString('base64'), nw, nh })
      }
    } catch (e) {}
  }
  const elements = (p.elements || []).filter((e) => e.type === 'sticker')
  // PNG↔元素两遍配对：先「PNG 自然尺寸 == element.original_size」精确匹配；余量按宽高比就近
  decorations.forEach((d) => { d.used = false })
  const assign = new Array(elements.length).fill(null)
  elements.forEach((e, i) => {
    const ow = Number(e.attach_info.original_size_width || 0), oh = Number(e.attach_info.original_size_height || 0)
    const d = decorations.find((x) => !x.used && x.nw === ow && x.nh === oh)
    if (d) { d.used = true; assign[i] = d }
  })
  elements.forEach((e, i) => {
    if (assign[i]) return
    const c = e.attach_info.clip || {}
    const ow = Number(e.attach_info.original_size_width || 1), oh = Number(e.attach_info.original_size_height || 1)
    const aspect = ow / oh
    let bestD = null, bestDiff = 1e9
    for (const d of decorations) {
      if (d.used) continue
      const diff = Math.abs(d.nw / d.nh - aspect)
      if (diff < bestDiff) { bestDiff = diff; bestD = d }
    }
    if (bestD) { bestD.used = true; assign[i] = bestD }
  })
  const imgs = elements.map((e, i) => {
    const c = e.attach_info.clip || {}
    const d = assign[i]
    if (!d) return ''
    const lx = (Number(c.transform_x || 0) * 100 / DESIGN).toFixed(3)
    const ly = (-Number(c.transform_y || 0) * 100 / DESIGN).toFixed(3)
    const wPct = (d.nw * Number(c.scale_x || 1) * 100 / DESIGN).toFixed(3)
    const rot = Number(c.rotation || 0).toFixed(1)
    return '<img class="d" src="data:image/png;base64,' + d.b64 + '" style="position:absolute;left:calc(50% + ' + lx + 'vw);top:calc(50% + ' + ly + 'vw);width:' + wPct + 'vw;transform:translate(-50%,-50%) rotate(' + rot + 'deg)">'
  }).join('')

  const html = '<!DOCTYPE html><html><head><meta charset="utf-8"><style>' +
    'body{margin:0;background:transparent;height:100vh;display:flex;align-items:center;justify-content:center;position:relative;overflow:hidden}' +
    '.wrap{position:relative;display:inline-block;animation:tin .5s cubic-bezier(.2,1.4,.4,1) both}' +
    '.t{font-family:"Microsoft YaHei",sans-serif;font-weight:900;color:' + color + ';font-size:' + fsVw + 'vw;letter-spacing:2px;text-shadow:0 3px 10px rgba(0,0,0,.45);white-space:nowrap}' +
    '.d{position:absolute}' +
    '@keyframes tin{0%{transform:scale(.3);opacity:0}100%{transform:scale(1);opacity:1}}' +
    '</style></head><body><div class="wrap">' + imgs + '<div class="t" style="transform:rotate(' + textRot + 'deg)">{{text}}</div></div></body></html>'

  const meta = {
    id: 'jy_' + rid,
    name: eff.effect_name || ('剪映模板_' + rid),
    category: eff.category_name || '好物种草',
    description: '来源:剪映文字模板 resource_id=' + rid + ' | 剪映11.5.5.14461 | textpreset v' + (p.version || 5) + ' | tintin同步',
    variables: {
      text: { type: 'string', default: text, label: '标题文字' },
      color: { type: 'string', default: color, label: '文字颜色' },
      fontSize: { type: 'number', default: Number((fontSize * textScale).toFixed(1)), label: '字号' },
    },
  }
  return { rid: rid, html: html, meta: meta }
}

function upload(rid, zipPath) {
  return new Promise((resolve, reject) => {
    const boundary = '----TinTinSync' + Date.now()
    const file = fs.readFileSync(zipPath)
    const body = Buffer.concat([
      Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="file"; filename="' + rid + '.zip"\r\nContent-Type: application/zip\r\n\r\n'),
      file,
      Buffer.from('\r\n--' + boundary + '--\r\n'),
    ])
    const req = http.request({ host: SERVER, port: 8000, path: '/text_templates/templates', method: 'POST', headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary, 'Content-Length': body.length } }, (r) => {
      let s = ''
      r.on('data', (d) => s += d)
      r.on('end', () => resolve({ code: r.statusCode, body: s.slice(0, 50) }))
    })
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

const files = fs.readdirSync(PDIR).filter((f) => f.endsWith('.textpreset'))
let okN = 0
for (const f of files) {
  try {
    const built = buildPackage(path.join(PDIR, f))
    if (ONLY && built.rid !== ONLY) continue
    const out = path.join(OUT, 'jy_' + built.rid)
    fs.mkdirSync(out, { recursive: true })
    fs.writeFileSync(path.join(out, 'meta.json'), JSON.stringify(built.meta, null, 1))
    fs.writeFileSync(path.join(out, 'template.html'), built.html)
    if (UPLOAD) {
      const zip = path.join(OUT, 'jy_' + built.rid + '.zip')
      try { fs.unlinkSync(zip) } catch (e) {}
      execFileSync('powershell', ['-NoProfile', '-Command', 'Compress-Archive -Force -Path "' + out.replaceAll('/', '\\') + '\\*" -DestinationPath "' + zip.replaceAll('/', '\\') + '"'], { stdio: 'pipe' })
      const resp = execFileSync('curl', ['-s', '-m', '30', '-X', 'POST', '-F', 'file=@' + zip, 'http://192.168.111.31:8000/text_templates/templates'], { encoding: 'utf-8' })
      console.log('上传', built.meta.name, '→', resp.slice(0, 60))
    } else {
      console.log('生成', built.meta.name, '→', out)
    }
    okN++
  } catch (e) {
    console.error('ERR', f, e.message.slice(0, 80))
  }
}
console.log('完成: ok=' + okN + ' upload=' + UPLOAD)
