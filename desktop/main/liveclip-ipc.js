// ═══════════════════════════════════════════════════════════════
// liveclip-ipc.js — 直播切片（M9）本地文件 I/O handler（3 条）
// 设计口径（IRON-06/07）：渲染层负责全部策略（封面像素合成 canvas、
// 切片段字幕裁剪、SRT 文本生成），主进程只做无决策的文件 I/O。
//   · liveclip:writeImageFile { path, base64 } → 封面 jpg/png 落盘
//     （渲染层 canvas 复刻原版 PIL generate_cover_image 的产物，
//      原版 gui/live_clip/utils.py L99-139；限定 .jpg/.jpeg/.png）
//   · liveclip:writeTextFile  { path, content } → 导出字幕 SRT
//     （原版 page.py _export_subtitles L808-828；渲染层先 dialog:saveFile
//      拿目标路径，此处纯写 utf8，限定 .srt/.txt）
//   · liveclip:writeTempText  { basename, content } → 系统临时文件
//     （切片烧字幕的临时 SRT，原版 VideoClipWorker L297-303 temp_srt
//      同角色；basename 由渲染层生成后仍在主进程校验防路径穿越）
// 错误态统一 { error }；成功 { ok: true, path }。
// ═══════════════════════════════════════════════════════════════
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

function _err(message) {
  return { error: message || '未知错误' }
}

/** base64 → Buffer（容错 dataURL 前缀） */
function _toBuffer(base64) {
  const raw = String(base64 || '').replace(/^data:[^,]*,/, '')
  if (!raw) return null
  try { return Buffer.from(raw, 'base64') } catch (_) { return null }
}

/** 防路径穿越：basename 白名单校验 */
function _safeBasename(name) {
  const base = path.basename(String(name || ''))
  if (!base || base === '.' || base === '..' || /[\\/]/.test(base)) return null
  return base
}

function createLiveclipIpc(ipcMain) {
  // ── 封面图落盘（限定图片扩展，防滥用为任意文件写入）──
  ipcMain.handle('liveclip:writeImageFile', async (_event, payload) => {
    try {
      const p = payload || {}
      const ext = path.extname(String(p.path || '')).toLowerCase()
      if (!['.jpg', '.jpeg', '.png'].includes(ext)) return _err('仅支持 .jpg/.jpeg/.png 封面文件')
      const buf = _toBuffer(p.base64)
      if (!buf || buf.length === 0) return _err('缺少图片数据')
      await fs.promises.mkdir(path.dirname(p.path), { recursive: true })
      await fs.promises.writeFile(p.path, buf)
      return { ok: true, path: p.path }
    } catch (e) {
      return _err((e && e.message) || String(e))
    }
  })

  // ── 导出字幕（用户已通过 dialog:saveFile 选定路径，纯 utf8 写入）──
  ipcMain.handle('liveclip:writeTextFile', async (_event, payload) => {
    try {
      const p = payload || {}
      const ext = path.extname(String(p.path || '')).toLowerCase()
      if (!['.srt', '.txt'].includes(ext)) return _err('仅支持 .srt/.txt 字幕文件')
      const content = typeof p.content === 'string' ? p.content : ''
      if (!content) return _err('缺少字幕内容')
      await fs.promises.writeFile(p.path, content, 'utf8')
      return { ok: true, path: p.path }
    } catch (e) {
      return _err((e && e.message) || String(e))
    }
  })

  // ── 切片烧字幕临时 SRT（写入系统临时目录，路径主进程生成）──
  ipcMain.handle('liveclip:writeTempText', async (_event, payload) => {
    try {
      const p = payload || {}
      const base = _safeBasename(p.basename)
      if (!base) return _err('非法文件名')
      if (!base.toLowerCase().endsWith('.srt')) return _err('临时字幕仅支持 .srt')
      const content = typeof p.content === 'string' ? p.content : ''
      if (!content) return _err('缺少字幕内容')
      const filePath = path.join(os.tmpdir(), base)
      await fs.promises.writeFile(filePath, content, 'utf8')
      return { path: filePath }
    } catch (e) {
      return _err((e && e.message) || String(e))
    }
  })
}

module.exports = { createLiveclipIpc }
