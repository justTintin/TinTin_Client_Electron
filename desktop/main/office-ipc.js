// ═══════════════════════════════════════════════════════════════
// office-ipc.js — 办公能力集成主进程（P1，PRD §4.2）
// 通道（渲染层经 tintin.office.* / tintinBrowser.office.* 调用，两窗口共用）：
//   · office:saveFile     { filename, ext:'docx'|'xlsx', data:ArrayBuffer|Uint8Array }
//                         → { saved:true, path } | { saved:false }（用户取消）| { error }
//   · office:openPath     path → { ok:true } | { ok:false, error }
//   · office:previewDocx  path → { html } | { error }（mammoth convertToHtml + 样式注入）
//   · office:readXlsx     path → { sheets:[{name, rows:any[][]}] } | { error }（exceljs 读，首 200 行截断）
// 依赖：mammoth（docx→html）/ exceljs（已有）纯 JS，无原生编译。
// 错误态统一 { error }；saveFile 用户取消返回 { saved:false }（渲染层静默）。
// ═══════════════════════════════════════════════════════════════
'use strict'

const fs = require('node:fs')

/** 统一错误对象（PRD §4.2：错误态统一 {error}） */
function _err(message) {
  return { error: message || '未知错误' }
}

/** 主窗口（saveDialog 挂父窗口；未就绪时降级为无父窗口对话框） */
function _parentWindow(getMainWindow) {
  try {
    const w = getMainWindow && getMainWindow()
    return w && !w.isDestroyed() ? w : undefined
  } catch (_) { return undefined }
}

/** 渲染层传入的文件数据（ArrayBuffer / Uint8Array / Buffer）→ Buffer */
function _toBuffer(data) {
  if (!data) return null
  if (Buffer.isBuffer(data)) return data
  if (data instanceof Uint8Array) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  }
  if (typeof data === 'string') {
    try { return Buffer.from(data, 'base64') } catch (_) { return null }
  }
  return null
}

/** mammoth HTML 包壳：正文 14px / 行距 1.6 / 页边距（PRD §3.3 样式注入） */
function _wrapDocxHtml(body) {
  const css = [
    'body{font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;font-size:14px;line-height:1.6;color:#1f2328;margin:0;padding:28px;background:#ffffff;}',
    'h1{font-size:24px;} h2{font-size:20px;} h3{font-size:17px;}',
    'table{border-collapse:collapse;width:100%;margin:8px 0;}',
    'td,th{border:1px solid #d0d7de;padding:5px 9px;text-align:left;font-size:13px;}',
    'th{background:#f6f8fa;font-weight:600;}',
    'img{max-width:100%;height:auto;}',
    'blockquote{margin:6px 0;padding:4px 12px;border-left:3px solid #d0d7de;color:#57606a;}',
    'ul,ol{margin:6px 0;padding-left:22px;}',
    'code{background:#f6f8fa;padding:1px 5px;border-radius:4px;font-size:13px;}',
    'pre{background:#f6f8fa;padding:10px 12px;border-radius:6px;overflow:auto;font-size:13px;}',
    'p{margin:6px 0;}',
  ].join('')
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body>${body || ''}</body></html>`
}

/**
 * 注册 4 条 office:* IPC（P1 基础设施，PRD §4.2）。
 * deps = { getMainWindow }（dialog.showSaveDialog 挂主窗口；浏览器窗口共用同一 handler）
 */
function createOfficeIpc(ipcMain, deps) {
  if (!ipcMain) throw new Error('createOfficeIpc: ipcMain is required')
  const { getMainWindow } = deps || {}
  const { dialog, shell } = require('electron')

  // ── office:saveFile：系统保存对话框 + fs.writeFile（PRD §3.4 / §4.2）──
  ipcMain.handle('office:saveFile', async (_event, payload) => {
    try {
      const p = payload || {}
      const ext = String(p.ext || 'docx').toLowerCase() === 'xlsx' ? 'xlsx' : 'docx'
      const filename = String(p.filename || `导出.${ext}`)
      const buf = _toBuffer(p.data)
      if (!buf || buf.length === 0) return _err('缺少文件数据')

      const filters = ext === 'xlsx'
        ? [{ name: 'Excel 工作簿', extensions: ['xlsx'] }]
        : [{ name: 'Word 文档', extensions: ['docx'] }]
      const result = await dialog.showSaveDialog(_parentWindow(getMainWindow), {
        title: '导出文件',
        defaultPath: filename,
        filters,
      })
      if (result.canceled || !result.filePath) return { saved: false } // E2：取消静默

      let filePath = result.filePath
      // 兜底扩展名（用户手改后缀 / 删掉后缀时补全）
      if (!filePath.toLowerCase().endsWith(`.${ext}`)) filePath += `.${ext}`
      await fs.promises.writeFile(filePath, buf)
      return { saved: true, path: filePath }
    } catch (e) {
      return _err((e && e.message) || String(e))
    }
  })

  // ── office:openPath：系统默认程序打开（shell.openPath）──
  ipcMain.handle('office:openPath', async (_event, filePath) => {
    try {
      const p = String(filePath || '')
      if (!p) return _err('路径为空')
      if (!fs.existsSync(p)) return _err('文件不存在')
      const err = await shell.openPath(p)
      return err ? _err(err) : { ok: true }
    } catch (e) {
      return _err((e && e.message) || String(e))
    }
  })

  // ── office:previewDocx：mammoth docx→html（PRD §3.3 内嵌预览）──
  ipcMain.handle('office:previewDocx', async (_event, filePath) => {
    try {
      const p = String(filePath || '')
      if (!p) return _err('路径为空')
      if (!fs.existsSync(p)) return _err('文件不存在')
      const mammoth = require('mammoth')
      const result = await mammoth.convertToHtml({
        path: p,
        // 内嵌图片转 base64 data URI（PRD §3.3「内嵌图片(base64)」）
        convertImage: mammoth.images.imgElement((image) =>
          image.read('base64').then((base64) => ({
            src: `data:${image.contentType};base64,${base64}`,
          })),
        ),
      })
      return { html: _wrapDocxHtml(result.value) }
    } catch (e) {
      return _err((e && e.message) || String(e))
    }
  })

  // ── office:readXlsx：exceljs 读 + 首 200 行截断（PRD §4.2）──
  ipcMain.handle('office:readXlsx', async (_event, filePath) => {
    try {
      const p = String(filePath || '')
      if (!p) return _err('路径为空')
      if (!fs.existsSync(p)) return _err('文件不存在')
      const ExcelJS = require('exceljs')
      const workbook = new ExcelJS.Workbook()
      await workbook.xlsx.readFile(p)

      const MAX_ROWS = 200
      const sheets = workbook.worksheets.map((ws) => {
        const rows = []
        const maxRow = Math.min(ws.rowCount, MAX_ROWS)
        for (let i = 1; i <= maxRow; i++) {
          const row = ws.getRow(i)
          const cells = []
          for (let c = 1; c <= row.cellCount; c++) {
            const cell = row.getCell(c)
            let text = ''
            try { text = cell.text } catch (_) { text = '' }
            const v = cell.value
            if (text) {
              cells.push(text)
            } else if (v === null || v === undefined) {
              cells.push('')
            } else if (typeof v === 'object') {
              if (Array.isArray(v.richText)) cells.push(v.richText.map((r) => r.text || '').join(''))
              else if (v.hyperlink) cells.push(String(v.hyperlink))
              else if (v.formula !== undefined) cells.push(v.result === undefined ? `=${v.formula}` : String(v.result))
              else cells.push(JSON.stringify(v))
            } else {
              cells.push(String(v))
            }
          }
          rows.push(cells)
        }
        return { name: ws.name, rows }
      })
      return { sheets }
    } catch (e) {
      return _err((e && e.message) || String(e))
    }
  })
}

module.exports = { createOfficeIpc }
