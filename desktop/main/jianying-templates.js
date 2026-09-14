// jianying-templates.js — 剪映素材模板聚合扫描器（主进程纯逻辑，可单测）
// 扫描本机剪映目录（明文三件套：textpreset / artistEffect 缓存 / music 缓存）
// + 服务端已同步文字模板，按剪映菜单体系六大分类输出。
// 纯逻辑：仅内置模块，可单测，不碰 electron。
'use strict'
const fs = require('node:fs')
const path = require('node:path')

const CATEGORIES = ['花字库', '文字模板', '特效', '贴纸', '转场', '字幕', '音频']

// 转场映射（延迟 require 避免循环依赖）
function getTransitionMap() {
  try { return require('./jianying-exporter.js').TRANSITION_MAP || {} } catch (_) { return {} }
}

/** 安全读目录（不存在/无权限→[]） */
function safeReaddir(dir) {
  try { return fs.readdirSync(dir) } catch (_) { return [] }
}
function safeStat(fp) {
  try { return fs.statSync(fp) } catch (_) { return null }
}
function readJson(fp) {
  try { return JSON.parse(fs.readFileSync(fp, 'utf-8')) } catch (_) { return null }
}

/** PNG 尺寸（IHDR 偏移 16/20） */
function pngSize(fp) {
  try {
    const b = fs.readFileSync(fp)
    if (b.length < 24 || b[0] !== 0x89) return null
    return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) }
  } catch (_) { return null }
}

/** mp3 时长（秒，ffprobe 不可用返回 0） */
function audioDuration(fp) {
  try {
    const ffprobe = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Links', 'ffprobe.exe')
    const { execFileSync } = require('node:child_process')
    return parseFloat(execFileSync(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', fp], { encoding: 'utf-8', timeout: 5000 }).trim()) || 0
  } catch (_) { return 0 }
}

// ── 扫描器 ──

/** 扫描文字预设（.textpreset → 文本/字幕类目） */
function scanTextPresets(presetDir) {
  const textItems = []
  const tplItems = []
  const captionItems = []
  if (!fs.existsSync(presetDir)) return { textItems, tplItems, captionItems }
  for (const f of safeReaddir(presetDir)) {
    if (!f.endsWith('.textpreset')) continue
    try {
      const p = readJson(path.join(presetDir, f))
      if (!p) continue
      const para = (p.paragraphs || [])[0] || {}
      let text = '', color = '#FFFFFF'
      try {
        const cc = JSON.parse(para.content)
        text = cc.text || ''
        for (const st of cc.styles || []) {
          if (st.fill && st.fill.content && st.fill.content.solid) {
            const col = st.fill.content.solid.color
            if (Array.isArray(col) && col.length >= 3) color = '#' + col.slice(0, 3).map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('')
          }
        }
      } catch (_) {}
      if (!text) text = String((p.effect && p.effect.effect_name) || f.replace('.textpreset', ''))
      const stickerCount = (p.elements || []).filter((e) => e.type === 'sticker').length
      const item = {
        id: path.basename(f, '.textpreset'),
        name: text,
        color,
        stickerCount,
        hasEffect: !!(p.effect && p.effect.effect_id),
        effectName: (p.effect && p.effect.effect_name) || '',
        effectId: (p.effect && p.effect.resource_id) || '',
        cover: fs.existsSync(p.cover_image_path || '') ? p.cover_image_path : '',
        file: path.join(presetDir, f),
      }
      // 二期分组：花字库（带 effect 引用且非「文字模板」类目）/ 文字模板（category_name 含文字模板）/ 字幕（纯文字无效果）
      const effCategory = String((p.effect && p.effect.category_name) || '')
      item.group = item.hasEffect && !/文字模板/.test(effCategory) ? '花字库' : (item.hasEffect ? '文字模板' : '')
      if (item.group === '花字库') textItems.push(item)
      else if (item.group === '文字模板') tplItems.push(item)
      else captionItems.push(item)
    } catch (_) {}
  }
  return { textItems, tplItems, captionItems }
}

/** 扫描效果缓存（artistEffect → 特效类目） */
function scanEffectCache(cacheDir) {
  const items = []
  if (!fs.existsSync(cacheDir)) return items
  for (const rid of safeReaddir(cacheDir)) {
    const bundleDir = path.join(cacheDir, rid)
    if (!safeStat(bundleDir)?.isDirectory()) continue
    for (const hash of safeReaddir(bundleDir)) {
      const hd = path.join(bundleDir, hash)
      if (!safeStat(hd)?.isDirectory()) continue
      const config = readJson(path.join(hd, 'config.json'))
      const info = readJson(path.join(hd, 'heycanInfo.json'))
      if (!config && !info) continue
      // 找预览图
      let preview = ''
      for (const f of safeReaddir(hd)) {
        if (f.endsWith('.png') || f.endsWith('.jpg')) { preview = path.join(hd, f); break }
      }
      items.push({
        id: rid,
        name: (config && config.effect && config.effect.name) || rid,
        path: hd,
        preview,
      })
      break // 每个 rid 只取一个 hash 包
    }
  }
  return items
}

/** 扫描音频缓存（music → 音频类目） */
function scanAudioCache(musicDir) {
  const items = []
  if (!fs.existsSync(musicDir)) return items
  for (const f of safeReaddir(musicDir)) {
    if (!f.toLowerCase().endsWith('.mp3')) continue
    const fp = path.join(musicDir, f)
    const st = safeStat(fp)
    if (!st || st.size < 1024) continue
    items.push({
      id: f.replace('.mp3', ''),
      name: '剪映音频_' + f.replace('.mp3', '').slice(0, 8),
      file: fp,
      bytes: st.size,
    })
  }
  return items
}

/** 转场列表（从 TRANSITION_MAP 导出） */
function getTransitions(transitionMap) {
  return Object.entries(transitionMap).map(([key, val]) => ({
    id: key,
    name: val.name,
    durationUs: val.duration,
    isOverlap: val.isOverlap,
  }))
}

/**
 * 聚合扫描：返回六大分类的模板/素材列表。
 * opts: { jianyingRoot(剪映 User Data 根), transitionMap, httpRequest(GET 服务端) }
 * 文本类目带 syncedToServer（resource_id 在服务端 /text_templates/templates 库中）。
 */
async function scanAllAsync(opts) {
  const o = opts || {}
  const ud = o.jianyingRoot || path.join(process.env.LOCALAPPDATA || '', 'JianyingPro', 'User Data')
  const presetDir = path.join(ud, 'Presets', 'Text_V2')
  const effectCache = path.join(ud, 'Cache', 'artistEffect')
  const musicCache = path.join(ud, 'Cache', 'music')

  const result = {}
  for (const c of CATEGORIES) result[c] = []

  // 文本 + 字幕（textpreset）
  const { textItems, tplItems, captionItems } = scanTextPresets(presetDir)
  result['花字库'] = textItems
  result['文字模板'] = tplItems
  result['字幕'] = captionItems

  // 特效（artistEffect 缓存）
  result['特效'] = scanEffectCache(effectCache)

  // 转场
  result['转场'] = getTransitions(getTransitionMap())

  // 音频
  result['音频'] = scanAudioCache(musicCache)

  // 服务端同步状态：拉 /text_templates/templates 比对 resource_id（jy_<rid>）
  if (typeof o.httpRequest === 'function') {
    try {
      const res = await o.httpRequest('GET', '/text_templates/templates', { timeout: 10000 })
      const data = res && res.data
      const list = Array.isArray(data) ? data : (Array.isArray(data?.items) ? data.items : [])
      const serverIds = new Set(list.map((t) => String(t.id || '')))
      for (const item of [...result['花字库'], ...result['文字模板']]) {
        item.syncedToServer = serverIds.has('jy_' + item.effectId)
        item.serverAnim = ''
        if (item.syncedToServer) {
          const hit = list.find((t) => String(t.id) === 'jy_' + item.effectId)
          item.serverAnim = (hit && hit.variables && hit.variables.anim && hit.variables.anim.default) || ''
        }
      }
    } catch (_) { /* 离线：syncedToServer 留空（前端显示未同步） */ }
  }
  for (const item of [...result['花字库'], ...result['文字模板']]) if (item.syncedToServer === undefined) item.syncedToServer = false

  return result
}

/** 同步版（无服务端状态，测试用） */
function scanAll(opts) {
  const o = opts || {}
  const ud = o.jianyingRoot || path.join(process.env.LOCALAPPDATA || '', 'JianyingPro', 'User Data')
  const presetDir = path.join(ud, 'Presets', 'Text_V2')
  const effectCache = path.join(ud, 'Cache', 'artistEffect')
  const musicCache = path.join(ud, 'Cache', 'music')

  const result = {}
  for (const c of CATEGORIES) result[c] = []
  const { textItems, tplItems, captionItems } = scanTextPresets(presetDir)
  result['花字库'] = textItems
  result['文字模板'] = tplItems
  result['字幕'] = captionItems
  result['特效'] = scanEffectCache(effectCache)
  result['转场'] = getTransitions(o.transitionMap || getTransitionMap())
  result['音频'] = scanAudioCache(musicCache)
  return result
}

/**
 * 打包单个 textpreset 为服务端模板包（复用 test/sync-textpresets.cjs 逻辑）。
 * 返回 { meta, html } 或 null。
 */
/** 收集预设引用的字体文件（panel=fonts 资源，ttf/otf 直文件；路径去重、存在性过滤）。
 *  2026-09-13 用户裁决：文字模板同步时对应字体一并上传（POST /config/fonts/upload）。 */
function collectTemplateFonts(presetDir, rid) {
  const out = []
  const seenPreset = new Set()
  let p = null
  for (const f of safeReaddir(presetDir)) {
    if (!f.endsWith('.textpreset')) continue
    const cand = readJson(path.join(presetDir, f))
    if (cand && cand.effect && String(cand.effect.resource_id || cand.effect.effect_id || '') === String(rid)) { p = cand; break }
  }
  if (!p) return out
  const seenPath = new Set()
  for (const r of p.resources || []) {
    if (String(r.panel || '') !== 'fonts') continue
    const fp = String(r.file_path || '')
    if (!fp || seenPath.has(fp)) continue
    seenPath.add(fp)
    if (!/.(ttf|otf)$/i.test(fp)) continue
    if (!fs.existsSync(fp)) continue
    out.push({ name: path.basename(fp), path: fp })
  }
  return out
}

function buildSyncPackage(presetDir, rid, opts) {
  if (!presetDir || !rid || !fs.existsSync(presetDir)) return null
  let p = null
  for (const f of safeReaddir(presetDir)) {
    if (!f.endsWith('.textpreset')) continue
    const cand = readJson(path.join(presetDir, f))
    if (cand && cand.effect && String(cand.effect.resource_id || cand.effect.effect_id || '') === String(rid)) { p = cand; break }
  }
  if (!p) return null
  const eff = p.effect || {}
  const para = (p.paragraphs || [])[0] || {}
  let text = '', color = '#FFFFFF', color2 = '', fontSize = 60
  // rgb 浮点三元组 → #RRGGBB
  const rgbaToHex = (c) => (Array.isArray(c) && c.length >= 3)
    ? '#' + c.slice(0, 3).map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('')
    : ''
  try {
    const cc = JSON.parse(para.content)
    text = cc.text || ''
    for (const st of cc.styles || []) {
      if (st.size) fontSize = st.size
      const fc = st.fill && st.fill.content
      if (!fc) continue
      if (fc.solid) {
        const hex = rgbaToHex(fc.solid.color)
        if (hex) color = hex
      } else if (fc.gradient && Array.isArray(fc.gradient.color) && fc.gradient.color.length) {
        // 2026-09-13 用户裁决：渐变填充导出主色+副色（color=首 stop/color2=第一个
        // 与主色不同的 stop，首末同色时取中间色，如好物分享 白→浅蓝→白）——
        // 此前只读 solid，渐变模板全被提炼成白字，本地 drawtext 清一色默认观感。
        // 服务端原样存储可后续做渐变字。
        const stops = fc.gradient.color
        const h0 = rgbaToHex(stops[0])
        let h1 = ''
        for (let k = 1; k < stops.length; k++) {
          const hk = rgbaToHex(stops[k])
          if (hk && hk.toLowerCase() !== (h0 || '').toLowerCase()) { h1 = hk; break }
        }
        if (h0) color = h0
        if (h1) color2 = h1
      }
    }
  } catch (_) {}
  if (!text) text = String(eff.effect_name || rid)
  const pc = (para.attach_info && para.attach_info.clip) || {}
  const textScale = pc.scale_x || 1
  const textRot = pc.rotation || 0
  const fsVw = (fontSize * textScale * 100 / DESIGN).toFixed(3)
  // 动画签名（与 sync 脚本同口径）
  const TOOL = /^(infoSticker|AETools|Util|Utils|LuaRTTI\.MarkGen|Transform|Rotate|Appear)$/i
  const animKeys = new Set()
  for (const r of p.resources || []) {
    try {
      for (const f of safeReaddir(r.file_path)) {
        if (!/\.(lua|prefab)$/i.test(f)) continue
        const base = f.replace(/\.(lua|prefab)$/i, '')
        if (!TOOL.test(base) && base !== 'anim') animKeys.add(base)
      }
    } catch (_) {}
  }
  const animAll = [...animKeys].join('|')
  let anim = 'fade'
  if (/bounce/i.test(animAll)) anim = 'bounce'
  else if (/slide|shangxiaweiyi/i.test(animAll)) anim = 'slide'
  else if (/enlarge|spring|heartbeat|textwave|textanim/i.test(animAll)) anim = 'pulse'
  const animCssMap = { fade: 'fadeIn .5s ease both', pulse: 'pulseAnim 1.6s ease-in-out .3s infinite', bounce: 'bounceIn .6s cubic-bezier(.2,1.6,.4,1) both', slide: 'slideIn .5s ease-out both' }
  const animCss = animCssMap[anim] || animCssMap.fade
  const kfMap = {
    fadeIn: '@keyframes fadeIn{0%{opacity:0}100%{opacity:1}}',
    pulseAnim: '@keyframes pulseAnim{0%{transform:scale(.92)}50%{transform:scale(1.06)}100%{transform:scale(1)}}',
    bounceIn: '@keyframes bounceIn{0%{transform:scale(.3);opacity:0}60%{transform:scale(1.08);opacity:1}100%{transform:scale(1)}}',
    slideIn: '@keyframes slideIn{0%{transform:translateX(-24px);opacity:0}100%{transform:translateX(0);opacity:1}}',
  }
  // 装饰图标（2026-09-13 用户裁决：只收 panel==='default' 的 infoSticker 贴图 art——
  //   singleImage.png/SequenceMap.png。resource.panel 标资源角色：'flower'=花字库
  //   （cover_icon 是烤进像素的样例字位图，如"眼前一亮"包里 4856B 的"花字"图）、
  //   'text'=文字特效、'sticker'=动效 prefab——这些目录里的 PNG 一律禁入装饰层：
  //   服务端渲染只能替换 {{text}} 文本占位符，改不了图片像素，混入会跟关键词
  //   文字双重叠加。示例文字走 text.default（预设原文），不落图。）
  const DECORATION_PANELS = new Set(['default'])
  const decorations = []
  const seen = new Set()
  for (const r of p.resources || []) {
    if (!DECORATION_PANELS.has(String(r.panel || ''))) continue
    try {
      for (const f of safeReaddir(r.file_path)) {
        if (!f.endsWith('.png')) continue
        const fp = path.join(r.file_path, f)
        const b = fs.readFileSync(fp)
        const nw = b.readUInt32BE(16), nh = b.readUInt32BE(20)
        const key = nw + 'x' + nh + ':' + b.length
        if (seen.has(key)) continue
        seen.add(key)
        decorations.push({ b64: b.toString('base64'), nw, nh })
      }
    } catch (_) {}
  }
  const elements = (p.elements || []).filter((e) => e && e.type === 'sticker')
  decorations.forEach((d) => { d.used = false })
  const assign = new Array(elements.length).fill(null)
  elements.forEach((e, i) => {
    const c = (e.attach_info && e.attach_info.clip) || {}
    const ow = Number(e.attach_info.original_size_width || 0), oh = Number(e.attach_info.original_size_height || 0)
    const d = decorations.find((x) => !x.used && x.nw === ow && x.nh === oh)
    if (d) { d.used = true; assign[i] = d }
  })
  elements.forEach((e, i) => {
    if (assign[i]) return
    const c = (e.attach_info && e.attach_info.clip) || {}
    const ow = Number(e.attach_info.original_size_width || 1), oh = Number(e.attach_info.original_size_height || 1)
    let bestD = null, bestDiff = 1e9
    for (const d of decorations) {
      if (d.used) continue
      const diff = Math.abs(d.nw / d.nh - ow / oh)
      if (diff < bestDiff) { bestDiff = diff; bestD = d }
    }
    if (bestD) { bestD.used = true; assign[i] = bestD }
  })
  const imgs = elements.map((e, i) => {
    const c = (e.attach_info && e.attach_info.clip) || {}
    const d = assign[i]
    if (!d) return ''
    const lx = (Number(c.transform_x || 0) * 100 / DESIGN).toFixed(3)
    const ly = (-Number(c.transform_y || 0) * 100 / DESIGN).toFixed(3)
    const wPct = (d.nw * Number(c.scale_x || 1) * 100 / DESIGN).toFixed(3)
    const rot = Number(c.rotation || 0).toFixed(1)
    return '<img class="d" src="data:image/png;base64,' + d.b64 + '" style="position:absolute;left:calc(50% + ' + lx + 'vw);top:calc(50% + ' + ly + 'vw);width:' + wPct + 'vw;transform:translate(-50%,-50%) rotate(' + rot + 'deg)">'
  }).join('')
  const kfName = animCss.split(' ')[0]
  // 2026-09-13 用户裁决：同步时模板字体一并上传（/config/fonts/upload + fontconfig），
  // HTML font-family 写服务端解析出的家族名（opts.fontFamily），未上传/未命中回退雅黑
  const cssFont = (opts && String(opts.fontFamily || '').trim())
    ? "'" + String(opts.fontFamily).trim().replace(/'/g, '') + "'," : ''
  const html = '<!DOCTYPE html><html><head><meta charset="utf-8"><style>' +
    'body{margin:0;background:transparent;height:100vh;display:flex;align-items:center;justify-content:center;position:relative;overflow:hidden}' +
    '.wrap{position:relative;display:inline-block;animation:' + animCss + '}' +
    '.t{font-family:' + cssFont + '"Microsoft YaHei",sans-serif;font-weight:900;color:' + color + ';font-size:' + fsVw + 'vw;letter-spacing:2px;text-shadow:0 3px 10px rgba(0,0,0,.45);white-space:nowrap}' +
    '.d{position:absolute}' + (kfMap[kfName] || '') +
    '</style></head><body><div class="wrap">' + imgs + '<div class="t" style="transform:rotate(' + textRot + 'deg)">{{text}}</div></div></body></html>'
  const category = eff.category_name && /^(好物种草|美食|穿搭|科技数码|综艺|强调|热门)$/.test(eff.category_name) ? eff.category_name : (eff.category_name === '文字模板' ? '好物种草' : '热门')
  const meta = {
    id: 'jy_' + rid,
    name: eff.effect_name || ('剪映模板_' + rid),
    category,
    // 场景/溯源标签（2026-09-13 服务端对接清单：tags 数组随模板入库）
    tags: [category, '剪映同步', 'source=jianying-cache'],
    description: '来源:剪映文字模板 resource_id=' + rid + ' | 剪映11.5.5.14461 | textpreset v' + (p.version || 5) + ' | tintin同步 | 原始类目:' + (eff.category_name || ''),
    variables: {
      text: { type: 'string', default: text, label: '标题文字' },
      color: { type: 'string', default: color, label: '文字颜色' },
      ...(color2 ? { color2: { type: 'string', default: color2, label: '渐变副色' } } : {}),
      fontSize: { type: 'number', default: Number((fontSize * textScale).toFixed(1)), label: '字号' },
      font: { type: 'string', default: (opts && String(opts.fontFamily || '').trim()) || 'Microsoft YaHei', label: '字体' },
      anim: { type: 'string', default: anim, label: '入场动画' },
      animSignature: { type: 'string', default: animAll || 'none', label: '动画签名(剪映lua语义)' },
    },
  }
  return { meta, html }
}

const DESIGN = 720

/** 资产补充数据包（2026-09-13 用户裁决：v2 原地升级所需数据由客户端上传——
 *  effectStyle/动画参数(data_val)/Lua/序列帧只在客户端剪映缓存里，v1 HTML 转换时已丢，
 *  服务端无法反推。收集模板全部原始资源文件，保留 cache 相对结构 + manifest 清单；
 *  字体走 /config/fonts/upload 通道（manifest 标注 channel=fonts-api，不入包）。
 *  返回 { files:[{relPath,absPath}], manifest }。可单测（fs 除外）。 */
function buildAssetPackage(presetDir, rid, cacheRoot) {
  let p = null
  for (const f of safeReaddir(presetDir)) {
    if (!f.endsWith('.textpreset')) continue
    const cand = readJson(path.join(presetDir, f))
    if (cand && cand.effect && String(cand.effect.resource_id || cand.effect.effect_id || '') === String(rid)) { p = cand; break }
  }
  if (!p) return null
  const eff = p.effect || {}
  const files = []
  const resources = []
  const fonts = []
  const seen = new Set()
  for (const r of p.resources || []) {
    const panel = String(r.panel || 'misc')
    const fp = String(r.file_path || '')
    if (!fp || seen.has(fp)) continue
    seen.add(fp)
    const ridSeg = String(r.resource_id || '')
    const segs = fp.split(/[\/]+/).filter(Boolean)
    const lastSeg = segs[segs.length - 1] || ''
    const hashSeg = lastSeg.replace(/\.[^.]*$/, '').slice(0, 24)
    if (panel === 'fonts') {
      // 字体：走 /config/fonts/upload 通道（fontconfig 按名安装），不入资产包
      let st
      try { st = fs.statSync(fp) } catch (_) { continue }
      if (!/.(ttf|otf)$/i.test(fp)) continue
      fonts.push({ file: path.basename(fp), family: path.basename(fp).replace(/.(ttf|otf)$/i, ''), sizeKb: Math.round(st.size / 1024), channel: 'fonts-api' })
      resources.push({ panel, resource_id: ridSeg, file: path.basename(fp), channel: 'fonts-api' })
      continue
    }
    let es = []
    try { es = fs.readdirSync(fp) } catch (_) { continue }
    const seg = ridSeg ? (panel + '/' + ridSeg + '/' + hashSeg) : (panel + '/' + hashSeg)
    for (const fn of es) {
      const abs = path.join(fp, fn)
      let st
      try { st = fs.statSync(abs) } catch (_) { continue }
      if (st.isDirectory()) continue
      const rel = 'assets/' + seg + '/' + fn
      files.push({ relPath: rel.split('\\').join('/'), absPath: abs })
      resources.push({ panel, resource_id: ridSeg, path: rel.split('\\').join('/'), file: fn, sizeKb: Math.round(st.size / 1024) })
    }
  }
  const manifest = {
    rid: String(rid),
    name: eff.effect_name || '',
    category: eff.category_name || '',
    textpreset_version: p.version || 5,
    generator: 'tintin-client asset-package v1',
    fonts,
    resources,
  }
  return { files, manifest }
}

/** v2 资产升级包（2026-09-14 服务端新增 POST /text_templates/templates/{id}/assets）：
 *  按 v2 规范 schema 产出规范化数据（effect_style/text_anim/meta_patch.fonts），
 *  服务端运行时做语义翻译与确定性驱动（__renderAt）。纯函数可单测（fs 除外）。
 *  opts.serverFonts：服务端已装字体条目（GET /config/fonts），用于 meta_patch 字体对齐。 */
function rgbToHex01(c) {
  if (!Array.isArray(c) || c.length < 3) return '#FFFFFF'
  return '#' + c.slice(0, 3).map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('')
}
function normalizeFillContent(fc) {
  if (!fc) return null
  const rt = String(fc.render_type || '').toLowerCase()
  if (rt === 'gradient' && fc.gradient && Array.isArray(fc.gradient.color)) {
    const g = fc.gradient
    const stops = g.color.map((c, i) => ({
      offset: Math.round((Array.isArray(g.percent) && g.percent[i] != null ? g.percent[i] : i / Math.max(1, g.color.length - 1)) * 100),
      color: rgbToHex01(c),
    }))
    return { type: 'gradient', angle: Number(g.angle) || 90, stops }
  }
  if (rt === 'texture' && fc.texture && fc.texture.path) {
    return { type: 'texture', image: 'assets/textures/' + path.basename(fc.texture.path), alpha: Number(fc.texture.alpha) || 1 }
  }
  const solid = fc.solid || {}
  return { type: 'solid', color: rgbToHex01(solid.color), alpha: Number(solid.alpha != null ? solid.alpha : 1) }
}
function normalizeShadowLayer(arr, kind) {
  return (Array.isArray(arr) ? arr : [])
    .filter((s) => s && s.enable !== false)
    .map((s) => {
      const fill = normalizeFillContent(s.content)
      const color = fill && fill.type === 'solid' ? fill.color : (fill && fill.stops ? fill.stops[0].color : '#000000')
      return {
        kind,
        angle: Number(s.angle) || 0,
        distance: Number(s.distance) || 0,
        blur: Math.round((Number(s.diffuse) || 0) * 100),
        color,
        alpha: Number(s.alpha != null ? s.alpha : 1),
      }
    })
}
/** 服务端字体条目匹配（与 jianying-fonts-ipc.fontMatches 同逻辑；本模块零依赖内联）：
 *  filename 精确（服务端按文件名去重）或 family 互含（fc-scan 英文家族名）。 */
function jyFontEntryMatches(entry, family, fileName) {
  if (!entry || typeof entry !== 'object') return false
  const fam = String(entry.family || entry.font_name || entry.name || '').toLowerCase()
  const sfn = String(entry.filename || entry.stored_as || '').toLowerCase()
  const f = String(family || '').toLowerCase()
  const fn = String(fileName || '').toLowerCase()
  if (sfn && fn && sfn === fn) return true
  return !!(fam && f && (fam.includes(f) || f.includes(fam)))
}
function buildV2AssetUpgrade(presetDir, rid, cacheRoot, opts) {
  void cacheRoot
  let p = null
  for (const f of safeReaddir(presetDir)) {
    if (!f.endsWith('.textpreset')) continue
    const cand = readJson(path.join(presetDir, f))
    if (cand && cand.effect && String(cand.effect.resource_id || cand.effect.effect_id || '') === String(rid)) { p = cand; break }
  }
  if (!p) return null
  // ① effectStyle.json（flower 资源目录，明文样式定义）→ 规范化 + 纹理源图收集
  let effectStyle = null
  const textures = []
  const flowerDir = (p.resources || []).map((r) => String(r.file_path || '')).find((fp) => {
    try { return fs.existsSync(path.join(fp, 'effectStyle.json')) } catch (_) { return false }
  })
  if (flowerDir) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(flowerDir, 'effectStyle.json'), 'utf8'))
      effectStyle = {
        fills: [normalizeFillContent(raw.fill && raw.fill.content)].filter(Boolean)
          .concat(normalizeShadowLayer(raw.inner_shadows, 'inner').length ? [] : []),
        shadows: normalizeShadowLayer(raw.inner_shadows, 'inner')
          .concat(normalizeShadowLayer(raw.shadows, 'outer')),
        stroke: Array.isArray(raw.strokes) && raw.strokes.length
          ? { color: rgbToHex01((raw.strokes[0].content && raw.strokes[0].content.solid && raw.strokes[0].content.solid.color) || []), width: Number(raw.strokes[0].width) || 2 }
          : undefined,
      }
      if (!effectStyle.fills.length) delete effectStyle.fills
      if (!effectStyle.stroke) delete effectStyle.stroke
      // 纹理源图收集（fill/shadow content.texture.path 相对 flowerDir）
      for (const s of [raw.fill && raw.fill.content].concat(raw.inner_shadows || [], raw.shadows || [])) {
        const tp = s && s.texture && String(s.texture.path || '')
        if (tp && path.basename(tp) === tp) {
          const src = path.join(flowerDir, tp)
          if (fs.existsSync(src)) textures.push({ name: 'assets/textures/' + tp, absPath: src })
        }
      }
    } catch (_) { effectStyle = null }
  }
  // ② text_anim（panel=text 资源 data_val.json → 逐字 chars；贝塞尔/时序/模糊为明文参数）
  let textAnim = null
  let textLen = 0
  try {
    const para = (p.paragraphs || [])[0] || {}
    const cc = JSON.parse(para.content || '{}')
    textLen = String(cc.text || '').length
  } catch (_) {}
  const seenR = new Set()
  for (const r of p.resources || []) {
    if (seenR.has(r.file_path)) continue
    seenR.add(r.file_path)
    if (String(r.panel || '') !== 'text') continue
    const dvPath = path.join(String(r.file_path), 'data_val.json')
    if (!fs.existsSync(dvPath)) continue
    try {
      const dv = JSON.parse(fs.readFileSync(dvPath, 'utf8'))
      const bez = Array.isArray(dv.bezierValue2) ? dv.bezierValue2 : (Array.isArray(dv.bezierValue1) ? dv.bezierValue1 : [0.25, 0.1, 0.25, 1])
      const timer = Array.isArray(dv.textAnimTimer) ? dv.textAnimTimer : [0, 1]
      const per = Number(dv.single_char_anim_time && dv.single_char_anim_time[0]) || 0.08
      const n = Math.max(1, Math.min(textLen || 1, 24))
      const blur0 = Array.isArray(dv.blur_info) ? (Number(dv.blur_info[0]) || 0) : 0
      const y0 = (Number(dv.initialPosition_weight) || 0) * 100
      const chars = []
      for (let i = 0; i < n; i++) {
        chars.push({
          index: i,
          delay: Math.round(i * per * 1000) / 1000,
          duration: 0.4,
          easing: bez.map((v) => Math.round(v * 1000) / 1000),
          from: { x: 0, y: Math.round(y0), scale: 1, rotate: 0, opacity: 0, blur: Math.round(blur0 * 50) },
          to: { x: 0, y: 0, scale: 1, rotate: 0, opacity: 1, blur: 0 },
        })
      }
      textAnim = { chars }
      break
    } catch (_) {}
  }
  if (!textAnim && !effectStyle) return null
  // ③ meta_patch.fonts：服务端已装家族名对齐（fc-scan 英文名，fontMatches 宽松匹配）
  const fonts = collectTemplateFonts(presetDir, rid)
  const patchFonts = []
  for (const f of fonts) {
    const e = (Array.isArray(opts && opts.serverFonts) ? opts.serverFonts : []).find((s) => jyFontEntryMatches(s, f.family, f.name))
    const fam = (e && e.family) || ''
    // 家族名解析失败（如泛名 font.ttf 且服务端无同名条目）→ 不进 patch（服务端校验 family 必填）
    if (fam) patchFonts.push({ family: fam })
  }
  const files = []
  // 无扩展名纹理：嗅探魔数补扩展名（服务端仅收 png/jpg 等图片扩展名；剪映缓存文件常无后缀）
  for (const t of textures) {
    if (/.(png|jpe?g|webp)$/i.test(t.name)) continue
    let b
    try { b = fs.readFileSync(t.absPath) } catch (_) { t.drop = true; continue }
    let ext = ''
    if (b[0] === 0x89 && b[1] === 0x50) ext = '.png'
    else if (b[0] === 0xFF && b[1] === 0xD8) ext = '.jpg'
    else { t.drop = true; continue }
    t.oldRef = t.name
    t.name += ext
  }
  let esText = effectStyle ? JSON.stringify(effectStyle) : ''
  for (const t of textures) {
    if (t.drop || !t.oldRef) continue
    esText = esText.split('assets/textures/' + path.basename(t.oldRef)).join(t.name)
  }
  if (effectStyle) files.push({ name: 'assets/effect_style.json', data: Buffer.from(esText) })
  if (textAnim) files.push({ name: 'assets/text_anim.json', data: Buffer.from(JSON.stringify(textAnim)) })
  if (patchFonts.length) files.push({ name: 'meta_patch.json', data: Buffer.from(JSON.stringify({ fonts: patchFonts })) })
  for (const t of textures) { if (!t.drop) files.push({ name: t.name, absPath: t.absPath }) }
  return { files, effectStyle: !!effectStyle, textAnim: !!textAnim, fonts: patchFonts.length }
}

module.exports = { CATEGORIES, scanAll, scanAllAsync, scanTextPresets, scanEffectCache, scanAudioCache, getTransitions, pngSize, buildSyncPackage, collectTemplateFonts, buildAssetPackage, buildV2AssetUpgrade, jyFontEntryMatches }
