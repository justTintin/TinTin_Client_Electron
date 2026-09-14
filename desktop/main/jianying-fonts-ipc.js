// ═══════════════════════════════════════════════════════════════
// jianying-fonts-ipc.js — 剪映模板页「字体（剪映）」分类域 IPC
// （2026-09-13 用户裁决：与原服务端字体管理分开；把本机剪映字体上传到
//   服务端字体库，来源标记=剪映——本分类清单全部来自剪映目录）
// 契约：
//   POST /config/fonts/upload  multipart file → 服务端 fc-scan 安装 + fontconfig 注册
//   GET  /config/fonts         已装字体列表（voice:fonts 同解析）
// 扫描范围：Resources\Font（剪映字体资源根）+ Cache 内模板引用字体（深度 4），
// 过滤 ._ AppleDouble 垃圾，按 文件名+大小 去重。纯函数可单测。
// ═══════════════════════════════════════════════════════════════

'use strict'

const fs = require('node:fs')
const path = require('node:path')

/** 扫描本机剪映字体。fontDir=Resources\Font；cacheDir=Cache（递归深度 4）。 */
function scanFontFiles(fontDir, cacheDir) {
  const out = []
  const seen = new Set()
  const push = (fp, source) => {
    const base = path.basename(fp)
    if (/^\._/.test(base)) return // macOS AppleDouble 垃圾
    if (!/\.(ttf|otf)$/i.test(base)) return
    let st
    try { st = fs.statSync(fp) } catch (_) { return }
    const key = base.toLowerCase() + ':' + st.size
    if (seen.has(key)) return
    seen.add(key)
    out.push({
      name: base,
      family: base.replace(/\.(ttf|otf)$/i, ''),
      path: fp,
      sizeKb: Math.round(st.size / 1024),
      source,
    })
  }
  try { for (const f of fs.readdirSync(fontDir)) push(path.join(fontDir, f), 'fontdir') } catch (_) { /* 目录缺失 */ }
  const walk = (d, depth) => {
    if (depth > 4) return
    let es = []
    try { es = fs.readdirSync(d, { withFileTypes: true }) } catch (_) { return }
    for (const e of es) {
      const fp = path.join(d, e.name)
      if (e.isDirectory()) walk(fp, depth + 1)
      else push(fp, 'cache')
    }
  }
  walk(cacheDir, 0)
  return out.sort((a, b) => a.name.localeCompare(b.name, 'zh'))
}

/** 已装判定（2026-09-13 实测：服务端 fc-scan 家族名为字体内部英文名，如
 *  字由奇巧.ttf → family "HelloFont ID QiQiao"，与中文文件名对不上）：
 *  ① filename 与候选文件名精确相等（服务端按文件名去重 409）；
 *  ② family 与候选 family 互含（大小写不敏感）。任一命中即已存在 */
function fontMatches(entry, family, fileName) {
  if (!entry || typeof entry !== 'object') return false
  const fam = String(entry.family || entry.font_name || entry.name || '').toLowerCase()
  const sfn = String(entry.filename || entry.stored_as || '').toLowerCase()
  const f = String(family || '').toLowerCase()
  const fn = String(fileName || '').toLowerCase()
  if (sfn && fn && sfn === fn) return true
  return !!(fam && f && (fam.includes(f) || f.includes(fam)))
}
/** 兼容旧签名：单名互含 */
function matchServerFont(serverName, family) {
  return fontMatches({ family: serverName }, family, '')
}

/** 服务端已装字体原始条目（{id,family,filename,stored_as,installed}；离线/失败 → []） */
async function fetchServerFonts(httpRequest) {
  try {
    const res = await httpRequest('GET', '/config/fonts', { timeout: 10000 })
    const data = res.data
    return Array.isArray(data) ? data : (Array.isArray(data?.fonts) ? data.fonts : [])
  } catch (_) { return [] }
}

/** 批量上传字体（串行；名称互含命中已装跳过；单条失败不阻断）。
 *  供 jyfonts:upload 与文字模板同步（jytpl:sync 字体随传）共用。 */
async function uploadFontFiles(httpRequest, paths, { timeout = 120000 } = {}) {
  const serverFonts = await fetchServerFonts(httpRequest)
  const results = []
  for (const fp of (Array.isArray(paths) ? paths : []).map((x) => String(x))) {
    const name = path.basename(fp).replace(/\.(ttf|otf)$/i, '')
    try {
      if (!fs.existsSync(fp)) throw new Error('文件不存在')
      if (serverFonts.some((e) => fontMatches(e, name, path.basename(fp)))) {
        results.push({ path: fp, name, ok: true, skipped: true })
        continue
      }
      const boundary = '----TinTinJyFont' + Date.now() + Math.random().toString(16).slice(2)
      const fbuf = fs.readFileSync(fp)
      const body = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${path.basename(fp).replace(/"/g, '')}"\r\nContent-Type: font/ttf\r\n\r\n`),
        fbuf,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ])
      const res = await httpRequest('POST', '/config/fonts/upload', {
        body,
        headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary },
        timeout,
      })
      if (res.status === 409) {
        // 服务端按文件名去重：同名字体已存在 → 视为已上传（跳过）
        results.push({ path: fp, name, ok: true, skipped: true })
        continue
      }
      if (res.status !== 200) {
        throw new Error(Buffer.from(res.raw || '').toString('utf-8').slice(0, 120) || ('HTTP ' + res.status))
      }
      results.push({ path: fp, name, ok: true })
    } catch (e) {
      results.push({ path: fp, name, ok: false, error: String(e.message).slice(0, 120) })
    }
  }
  return results
}


function createJianyingFontsIpc(ipcMain, { httpRequest, isExpectedOfflineError }) {
  const jyRoot = () => path.join(process.env.LOCALAPPDATA || '', 'JianyingPro', 'User Data')
  const fetchServerFonts = async () => {
    const res = await httpRequest('GET', '/config/fonts', { timeout: 10000 })
    const data = res.data
    return Array.isArray(data) ? data : (Array.isArray(data?.fonts) ? data.fonts : [])
  }

  // ── jyfonts:scan — 本机剪映字体清单 ──
  ipcMain.handle('jyfonts:scan', async () => {
    try {
      const root = jyRoot()
      return { fonts: scanFontFiles(path.join(root, 'Resources', 'Font'), path.join(root, 'Cache')) }
    } catch (err) { return { error: err.message } }
  })

  // ── jyfonts:serverList — 服务端已装字体（含 font_id 供删除/引用）──
  ipcMain.handle('jyfonts:serverList', async () => {
    try {
      return { fonts: await fetchServerFonts() }
    } catch (err) { return isExpectedOfflineError(err) ? null : { error: err.message } }
  })

  // ── jyfonts:upload — 批量上传（串行逐个；名称互含命中已装则跳过；单条失败不阻断）──
  ipcMain.handle('jyfonts:upload', async (_e, payload) => {
    const paths = Array.isArray((payload || {}).paths) ? payload.paths.map((x) => String(x)) : []
    if (!paths.length) return { error: 'jyfonts:upload requires paths[]' }
    const results = await uploadFontFiles(httpRequest, paths)
    return { ok: true, results }
  })
}

module.exports = { scanFontFiles, fontMatches, matchServerFont, fetchServerFonts, uploadFontFiles, createJianyingFontsIpc }
