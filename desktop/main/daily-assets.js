// ═══════════════════════════════════════════════════════════════
// daily-assets.js — B9 每日素材（按日期扫描本地下载目录 + 预览 IPC）
//
// 对照基准（零 Python 移植，逐段对照原版）：
//   · apps/asset-browser/main.js L766-818 `get-daily-assets`：
//     合并 settings.downloadPath + downloadDirs → 扫描每个目录下
//     `YYYY-MM-DD` 命名子目录 → 排除 .tmp/.cookies.txt →
//     按 video/image/text/file 分类 → 按日期分组降序返回
//     [{date, files:[{name,path,size,type}]}]
//   · 原版 app.js L2340-2447 renderDailyMaterials / getFilteredDailyMaterials
//     （预览/筛选在前端完成，见 renderer/src/browser/logic/dailyAssets.ts）
//
// 数据源打通（新客户端）：下载目录 = store('downloadDir')（download.json，
//   media-downloader _resolveDownloadDir 同源）> media.settings.downloadDir
//   （media-storage 设置，兼容旧路径）> Windows 下载文件夹（app.getPath）。
//
// IPC 通道（browser-preload.js 白名单收口，见 browser 域 bridge 说明）：
//   browser:getDailyAssets   → 扫描下载目录按日期分组（B9）
//   browser:revealFile       → 单击卡片定位文件（对照原 open-file-folder）
//   browser:openFilePath     → 双击卡片打开文件（对照原 open-path）
// ═══════════════════════════════════════════════════════════════

'use strict'
const fs = require('node:fs')
const path = require('node:path')

const VIDEO_EXT = new Set(['.mp4', '.mkv', '.avi', '.mov', '.webm', '.m4v'])
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'])
const TEXT_EXT = new Set(['.txt', '.html', '.md', '.json'])
/** 每日素材目录名（对照原版 /^\d{4}-\d{2}-\d{2}$/） */
const DATE_DIR_RE = /^\d{4}-\d{2}-\d{2}$/
/** 扫描时忽略的临时/辅助文件（对照原版 L795：.tmp + .cookies.txt） */
const IGNORE_SUFFIX = ['.tmp', '.cookies.txt']

/**
 * 文件类型分类（对照原版 _classifyFileType L656-665 / get-daily-assets L802-806）。
 * @param {string} name 文件名
 * @returns {'video'|'image'|'text'|'file'}
 */
function classifyFileType(name) {
  const ext = path.extname(String(name || '')).toLowerCase()
  if (VIDEO_EXT.has(ext)) return 'video'
  if (IMAGE_EXT.has(ext)) return 'image'
  if (TEXT_EXT.has(ext)) return 'text'
  return 'file'
}

/**
 * 按日期扫描下载目录（纯函数，供单测；对照原版 get-daily-assets L766-818）。
 * 合并多目录去重（同路径文件只收一次）；日期降序返回。
 * @param {string[]} dirs 待扫描目录（已存在的才扫）
 * @returns {Array<{date:string, files:Array<{name:string,path:string,size:number,type:string}>}>}
 */
function scanDailyAssets(dirs) {
  const dateGroups = {}
  for (const baseDir of (Array.isArray(dirs) ? dirs : [])) {
    if (!baseDir || !fs.existsSync(baseDir)) continue
    let entries
    try {
      entries = fs.readdirSync(baseDir)
    } catch (_) {
      continue
    }
    for (const name of entries) {
      if (!DATE_DIR_RE.test(name)) continue
      const datePath = path.join(baseDir, name)
      let isDir = false
      try {
        isDir = fs.statSync(datePath).isDirectory()
      } catch (_) { /* stat 失败跳过 */ }
      if (!isDir) continue

      if (!dateGroups[name]) dateGroups[name] = { files: [], seen: new Set() }
      const group = dateGroups[name]
      let files
      try {
        files = fs.readdirSync(datePath)
      } catch (_) {
        continue
      }
      for (const f of files) {
        if (IGNORE_SUFFIX.some((s) => f.endsWith(s))) continue
        const fp = path.join(datePath, f)
        let isFile = false
        try {
          isFile = fs.statSync(fp).isFile()
        } catch (_) { /* stat 失败跳过 */ }
        if (!isFile) continue
        if (group.seen.has(fp)) continue
        group.seen.add(fp)
        let size = 0
        try { size = fs.statSync(fp).size } catch (_) { size = 0 }
        group.files.push({ name: f, path: fp, size, type: classifyFileType(f) })
      }
    }
  }
  return Object.keys(dateGroups)
    .sort().reverse()
    .map((date) => ({ date, files: dateGroups[date].files }))
}

/**
 * 创建 B9 IPC handlers（main.js 在 createMediaStorage 之后调用）。
 * ctx = { store, app }（config-store 分域 / electron app）
 */
function createDailyAssetsIpc(ipcMain, ctx) {
  if (!ipcMain) throw new Error('createDailyAssetsIpc: ipcMain is required')
  const { store, app } = ctx || {}

  /** 下载目录集合（对照原版 L769-772 合并当前目录 + 历史目录去重） */
  function _resolveDownloadDirs() {
    const dirs = new Set()
    try {
      const pref = store && store.get && store.get('downloadDir')
      if (pref && typeof pref === 'string') dirs.add(pref)
    } catch (_) {}
    try {
      const mediaSettings = store && store.get && store.get('media.settings')
      if (mediaSettings && typeof mediaSettings === 'object' && typeof mediaSettings.downloadDir === 'string') {
        dirs.add(mediaSettings.downloadDir)
      }
    } catch (_) {}
    try { dirs.add(app.getPath('downloads')) } catch (_) {}
    return Array.from(dirs)
  }

  // browser:getDailyAssets → 扫描下载目录按日期分组（B9）
  ipcMain.handle('browser:getDailyAssets', async () => {
    try {
      const groups = scanDailyAssets(_resolveDownloadDirs())
      return { success: true, data: groups }
    } catch (e) {
      return { success: false, error: (e && e.message) || String(e) }
    }
  })

  // browser:revealFile → 文件定位（对照原 open-file-folder：showItemInFolder）
  ipcMain.handle('browser:revealFile', (_e, filePath) => {
    try {
      const { shell } = require('electron')
      if (!filePath || !fs.existsSync(filePath)) return { success: false, error: 'NO_FILE' }
      shell.showItemInFolder(String(filePath))
      return { success: true }
    } catch (e) { return { success: false, error: (e && e.message) || String(e) } }
  })

  // browser:openFilePath → 双击打开文件（对照原 open-path：shell.openPath）
  ipcMain.handle('browser:openFilePath', async (_e, filePath) => {
    try {
      const { shell } = require('electron')
      if (!filePath || !fs.existsSync(filePath)) return { success: false, error: 'NO_FILE' }
      const err = await shell.openPath(String(filePath))
      if (err) return { success: false, error: err }
      return { success: true }
    } catch (e) { return { success: false, error: (e && e.message) || String(e) } }
  })
}

module.exports = { classifyFileType, scanDailyAssets, createDailyAssetsIpc }
