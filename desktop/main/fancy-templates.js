// ═══════════════════════════════════════════════════════════════
// fancy-templates.js — 花字模板包加载器（主进程 CJS，可被单测 require）
// 对照原客户端 studio/utils/fancy_templates.py（2026-09-07 PR#4）逐行移植。
// 模板包 JSON schema：
// {
//   "template_id": "gold_pop",
//   "name": "鎏金弹出",
//   "style": "fontcolor=...:borderw=4:...",   // drawtext 样式串（本地直出通道）
//   "jy_effect_id": "7296357486490144036",    // 剪映草稿通道的花字效果 id（可空）
//   "jy_intro_anim": "复古打字机",             // 剪映入场动画名（可空）
//   "sound": {"file": "sfx/pop_01.wav", "gain_db": -6},  // 出现音效（可空；
//                                                         // file 相对 fancy 根目录）
//   "timing": "uniform"
// }
// 资产目录：resources/fancy/{templates,sfx,previews}（extraResources 随包分发；
//   dev 为 <repo>/resources/fancy，打包后 <resourcesPath>/fancy，同 getBinDir 口径）。
// 动画映射 getFancyAnim 在 voice-tts-logic.js（与烧制链路同文件，此处不重复）。
// ═══════════════════════════════════════════════════════════════

'use strict'

const fs = require('node:fs')
const path = require('node:path')

/** 花字资产根目录（dev: <repo>/resources/fancy；打包: <resourcesPath>/fancy） */
function getAssetsFancyDir() {
  if (process.resourcesPath) {
    const pkg = path.join(process.resourcesPath, 'fancy')
    if (fs.existsSync(pkg)) return pkg
  }
  return path.resolve(__dirname, '..', 'resources', 'fancy')
}

function getTemplateDir() {
  return path.join(getAssetsFancyDir(), 'templates')
}

let cache = null

/** 列出全部花字模板 dict；解析失败的文件跳过。结果缓存（forceReload 重载）。 */
function listFancyTemplates(forceReload = false) {
  if (cache !== null && !forceReload) return cache
  const templates = []
  const dir = getTemplateDir()
  let files = []
  try {
    files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.json')).sort()
  } catch (_) {
    cache = templates
    return templates
  }
  for (const f of files) {
    const p = path.join(dir, f)
    try {
      const data = JSON.parse(fs.readFileSync(p, 'utf-8'))
      if (data && typeof data === 'object' && data.template_id && data.name) {
        data._path = p
        templates.push(data)
      }
      // 缺 template_id/name → 跳过（同原版 log.warning 口径，静默跳过）
    } catch (_) { /* 解析失败，跳过 */ }
  }
  cache = templates
  return templates
}

/** 把花字模板 dict 序列化为任务字段 fancy_template 的 JSON 串；无效返回 ""。
 *  去掉加载器注入的 _path，保留全部业务字段。 */
function serializeForTask(template) {
  if (!template || typeof template !== 'object' || !template.template_id) return ''
  try {
    const data = {}
    for (const k of Object.keys(template)) {
      if (k !== '_path') data[k] = template[k]
    }
    return JSON.stringify(data)
  } catch (_) {
    return ''
  }
}

/** 模板音效文件的绝对路径；未配置/文件不存在返回空串。 */
function getFancySoundPath(template) {
  const sound = (template || {}).sound || {}
  const rel = String(sound.file || '').trim()
  if (!rel) return ''
  const p = path.isAbsolute(rel) ? rel : path.join(getAssetsFancyDir(), rel)
  try {
    return fs.statSync(p).isFile() ? p : ''
  } catch (_) {
    return ''
  }
}

/** 模板音效增益（dB），缺省 -6（避免音效盖过人声）。 */
function getFancySoundGainDb(template) {
  try {
    const v = Number(((template || {}).sound || {}).gain_db)
    return Number.isFinite(v) ? v : -6.0
  } catch (_) {
    return -6.0
  }
}

// ── 模板预览图（下拉框图标 + 预览标签）──────────────────────────────
const PREVIEW_TEXT = '199元超值' // 预览样本字（含数字，检验数字+描边观感）

function templatePreviewPath(templateId) {
  return path.join(getAssetsFancyDir(), 'previews', `${templateId}.png`)
}

/**
 * 生成（或复用缓存）模板预览图，返回 PNG 绝对路径；失败返回 ""。
 * 黑底 240x56，按模板 style 的 drawtext 串渲染样本字——预览与烧制同一
 * 样式串，所见即所得。重复调用直接命中缓存；ffmpeg 失败静默返回空。
 * （对照 ensure_template_preview L135-166 逐行；ffmpeg 由调用方注入。）
 */
function ensureTemplatePreview(template, ffmpegPath, fontPath) {
  const tid = String((template || {}).template_id || '').trim()
  if (!tid || !ffmpegPath) return ''
  const out = templatePreviewPath(tid)
  try {
    if (fs.existsSync(out) && fs.statSync(out).size > 0) return out
  } catch (_) { /* 继续生成 */ }
  const style = String(template.style || '').trim()
  if (!style) return ''
  try {
    fs.mkdirSync(path.dirname(out), { recursive: true })
  } catch (_) { /* 目录已存在/失败 → ffmpeg 阶段报错 */ }
  const fontEsc = String(fontPath).replace(/\\/g, '/').replace(/:/g, '\\:')
  // drawtext 居中 + 稍大字号，充分展示描边/阴影观感
  const vf = `drawtext=fontfile='${fontEsc}':text='${PREVIEW_TEXT}':fontsize=26:x=(w-text_w)/2:y=(h-text_h)/2:${style}`
  const { execFileSync } = require('node:child_process')
  try {
    execFileSync(ffmpegPath, [
      '-y', '-f', 'lavfi', '-i', 'color=c=0x202020:s=240x56:d=1',
      '-frames:v', '1', '-vf', vf, out,
    ], { timeout: 30000, windowsHide: true, stdio: 'ignore' })
    if (fs.existsSync(out) && fs.statSync(out).size > 0) return out
  } catch (_) { /* 生成失败静默（模板可先只用样式） */ }
  return ''
}

module.exports = {
  getAssetsFancyDir,
  getTemplateDir,
  listFancyTemplates,
  serializeForTask,
  getFancySoundPath,
  getFancySoundGainDb,
  templatePreviewPath,
  ensureTemplatePreview,
  PREVIEW_TEXT,
}
