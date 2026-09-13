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
function buildSyncPackage(presetDir, rid) {
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
  // 装饰图标
  const decorations = []
  const seen = new Set()
  for (const r of p.resources || []) {
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
  const html = '<!DOCTYPE html><html><head><meta charset="utf-8"><style>' +
    'body{margin:0;background:transparent;height:100vh;display:flex;align-items:center;justify-content:center;position:relative;overflow:hidden}' +
    '.wrap{position:relative;display:inline-block;animation:' + animCss + '}' +
    '.t{font-family:"Microsoft YaHei",sans-serif;font-weight:900;color:' + color + ';font-size:' + fsVw + 'vw;letter-spacing:2px;text-shadow:0 3px 10px rgba(0,0,0,.45);white-space:nowrap}' +
    '.d{position:absolute}' + (kfMap[kfName] || '') +
    '</style></head><body><div class="wrap">' + imgs + '<div class="t" style="transform:rotate(' + textRot + 'deg)">{{text}}</div></div></body></html>'
  const meta = {
    id: 'jy_' + rid,
    name: eff.effect_name || ('剪映模板_' + rid),
    category: eff.category_name && /^(好物种草|美食|穿搭|科技数码|综艺|强调|热门)$/.test(eff.category_name) ? eff.category_name : (eff.category_name === '文字模板' ? '好物种草' : '热门'),
    description: '来源:剪映文字模板 resource_id=' + rid + ' | 剪映11.5.5.14461 | textpreset v' + (p.version || 5) + ' | tintin同步 | 原始类目:' + (eff.category_name || ''),
    variables: {
      text: { type: 'string', default: text, label: '标题文字' },
      color: { type: 'string', default: color, label: '文字颜色' },
      fontSize: { type: 'number', default: Number((fontSize * textScale).toFixed(1)), label: '字号' },
      anim: { type: 'string', default: anim, label: '入场动画' },
      animSignature: { type: 'string', default: animAll || 'none', label: '动画签名(剪映lua语义)' },
    },
  }
  return { meta, html }
}

const DESIGN = 720

module.exports = { CATEGORIES, scanAll, scanAllAsync, scanTextPresets, scanEffectCache, scanAudioCache, getTransitions, pngSize, buildSyncPackage }
