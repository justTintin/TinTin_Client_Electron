// jianying-templates.js — 剪映素材模板聚合扫描器（主进程纯逻辑，可单测）
// 扫描本机剪映目录（明文三件套：textpreset / artistEffect 缓存 / music 缓存）
// + 服务端已同步文字模板，按剪映菜单体系六大分类输出。
// 纯逻辑：仅内置模块，可单测，不碰 electron。
'use strict'
const fs = require('node:fs')
const path = require('node:path')

const CATEGORIES = ['文本', '特效', '贴纸', '转场', '字幕', '音频']

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
  const captionItems = []
  if (!fs.existsSync(presetDir)) return { textItems, captionItems }
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
      // 花字效果/带贴纸 → 文本；纯文字（无效果引用）→ 字幕
      if (item.hasEffect || stickerCount > 0) textItems.push(item)
      else captionItems.push(item)
    } catch (_) {}
  }
  return { textItems, captionItems }
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
 * opts: { jianyingRoot(剪映 User Data 根), serverTextTemplates(可选：已同步模板数组) }
 * 返回 { 文本: [], 特效: [], 贴纸: [], 转场: [], 字幕: [], 音频: [] }
 */
function scanAll(opts) {
  const o = opts || {}
  const ud = o.jianyingRoot || path.join(process.env.LOCALAPPDATA || '', 'JianyingPro', 'User Data')
  const presetDir = path.join(ud, 'Presets', 'Text_V2')
  const effectCache = path.join(ud, 'Cache', 'artistEffect')
  const musicCache = path.join(ud, 'Cache', 'music')

  const result = {}
  for (const c of CATEGORIES) result[c] = []

  // 文本 + 字幕（textpreset）
  const { textItems, captionItems } = scanTextPresets(presetDir)
  result['文本'] = textItems
  result['字幕'] = captionItems

  // 特效（artistEffect 缓存）
  result['特效'] = scanEffectCache(effectCache)

  // 转场
  result['转场'] = getTransitions(getTransitionMap())

  // 音频
  result['音频'] = scanAudioCache(musicCache)

  return result
}

module.exports = { CATEGORIES, scanAll, scanTextPresets, scanEffectCache, scanAudioCache, getTransitions, pngSize }
