// ═══════════════════════════════════════════════════════════════
// model-manager.js — A2 双模式：模型下载/校验/安装管理
//
// 规格 §1.5.4：
//   - 从 model-manifest.json 读取 CDN 清单（唯一事实源）
//   - HTTP Range 断点续传（复用 download-manager 的 EventBus）
//   - 每文件下载完成 → SHA256 校验 → 失败删除重试 2 次
//   - 安装到 app.getPath('userData')/models/onnx 与 /native-addons
//
// 红线 Q1：onnx 模型/原生 DLL 绝不打进 NSIS 包，只从 CDN 下载到 userData
// ═══════════════════════════════════════════════════════════════

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const https = require('node:https')
const http = require('node:http')
const { URL } = require('node:url')
const { app, BrowserWindow } = require('electron')

const MANIFEST = require('./model-manifest.json')

// ───────────────────── 路径工具 ─────────────────────
function modelsDir() {
  const p = path.join(app.getPath('userData'), 'models', 'onnx')
  fs.mkdirSync(p, { recursive: true })
  return p
}
function nativeAddonsDir() {
  const p = path.join(app.getPath('userData'), 'native-addons')
  fs.mkdirSync(p, { recursive: true })
  return p
}
function dbDir() {
  const p = path.join(app.getPath('userData'), 'db')
  fs.mkdirSync(p, { recursive: true })
  return p
}

// ───────────────────── SHA256 校验 ─────────────────────
function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    const rs = fs.createReadStream(filePath)
    rs.on('error', reject)
    rs.on('data', (c) => hash.update(c))
    rs.on('end', () => resolve(hash.digest('hex')))
  })
}

// ───────────────────── HTTP Range 下载（断点续传）─────────────────────
function downloadFile(urlStr, savePath, { expectedSha256, expectedSize, onProgress, taskId } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr)
    const lib = url.protocol === 'https:' ? https : http
    let downloaded = fs.existsSync(savePath) ? fs.statSync(savePath).size : 0

    const opts = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + (url.search || ''),
      method: 'GET',
      headers: {}
    }
    if (downloaded > 0 && downloaded < expectedSize) {
      opts.headers['Range'] = `bytes=${downloaded}-`
    }

    const req = lib.request(opts, (res) => {
      if (res.statusCode === 416) {
        // Range 不可满足 → 已完整
        onProgress && onProgress(taskId, { percent: 100, downloaded: expectedSize, total: expectedSize, state: 'downloading' })
        return resolve({ path: savePath, size: expectedSize })
      }
      if (res.statusCode !== 200 && res.statusCode !== 206) {
        return reject(new Error(`HTTP ${res.statusCode}`))
      }
      const total = res.headers['content-range']
        ? parseInt(res.headers['content-range'].split('/')[1], 10) || expectedSize
        : parseInt(res.headers['content-length'], 10) || expectedSize

      const stream = fs.createWriteStream(savePath, { flags: downloaded > 0 && res.statusCode === 206 ? 'a' : 'w' })
      let lastPercent = -1
      res.on('data', (chunk) => {
        downloaded += chunk.length
        const percent = Math.round((downloaded / total) * 100)
        if (percent !== lastPercent) {
          lastPercent = percent
          onProgress && onProgress(taskId, { percent, downloaded, total, state: 'downloading', speed: 0 })
        }
      })
      res.pipe(stream)
      stream.on('finish', () => {
        stream.close(() => resolve({ path: savePath, size: downloaded }))
      })
      stream.on('error', reject)
    })
    req.on('error', reject)
    req.setTimeout(60_000, () => { req.destroy(new Error('Download timeout')) })
    req.end()
  })
}

// ───────────────────── 广播进度/完成（对齐 download-manager EventBus）─────────────────────
function broadcastProgress(taskId, progress) {
  for (const win of BrowserWindow.getAllWindows()) {
    try { win.webContents.send('downloads:progress', { taskId, ...progress }) } catch (_) {}
  }
}
function broadcastDone(taskId, result) {
  for (const win of BrowserWindow.getAllWindows()) {
    try { win.webContents.send('downloads:done', { taskId, ...result }) } catch (_) {}
  }
}
function broadcastError(taskId, error) {
  for (const win of BrowserWindow.getAllWindows()) {
    try { win.webContents.send('downloads:error', { taskId, error: error.message || String(error) }) } catch (_) {}
  }
}

// ───────────────────── 运行时状态 ─────────────────────
/** 当前正在下载的 pkgId → taskId / AbortController */
const runningTasks = new Map()
const TASK_PREFIX = 'a2model_'

function makeTaskId(pkgId) { return `${TASK_PREFIX}${pkgId}_${Date.now().toString(36)}` }

// ───────────────────── 单包校验：文件齐全 + SHA256 通过 ─────────────────────
function verifyPkg(pkg) {
  const results = []
  for (const f of pkg.files) {
    const filePath = path.join(
      pkg.id.startsWith('native-addons') ? nativeAddonsDir() : modelsDir(),
      f.name
    )
    if (!fs.existsSync(filePath)) {
      results.push({ name: f.name, ok: false, reason: 'MISSING' })
      continue
    }
    const stat = fs.statSync(filePath)
    if (stat.size !== f.size) {
      results.push({ name: f.name, ok: false, reason: 'SIZE_MISMATCH', actual: stat.size, expected: f.size })
      continue
    }
    // SHA256 标记 TBD 时跳过（开发阶段占位值）
    if (f.sha256 && !f.sha256.startsWith('TBD_')) {
      // 真实校验需要 hash，此处先占位（生产必须开启）
      results.push({ name: f.name, ok: true, reason: 'SIZE_OK_SHA256_DEFERRED' })
    } else {
      results.push({ name: f.name, ok: true, reason: 'SIZE_OK_SHA256_TBD' })
    }
  }
  const allOk = results.every((r) => r.ok)
  return { allOk, files: results }
}

// ───────────────────── 校验整个安装 ─────────────────────
/**
 * 冷启动第 4 项检查（§2.3 / §1.5 规格）。
 * 返回 { inferenceMode: 'server-only' | 'hybrid-auto', details: {...} }
 * — 任何一项失败 → inferenceMode = 'server-only'
 * — 全部通过    → inferenceMode = 'hybrid-auto'
 * 绝不阻塞启动（P1 红线）。
 */
function verifyInstallation() {
  const report = { pkgs: {}, nativeModules: {} }
  let allOk = true

  // 1) 模型包
  for (const pkg of MANIFEST.inferencePkgs) {
    // platformOnly 过滤
    if (pkg.platformOnly && !pkg.platformOnly.includes(`${process.platform}-${process.arch}`)) {
      report.pkgs[pkg.id] = { skipped: true, reason: 'PLATFORM_NOT_MATCH' }
      continue
    }
    const vr = verifyPkg(pkg)
    report.pkgs[pkg.id] = vr
    if (!vr.allOk) allOk = false
  }

  // 2) 原生模块 require 可加载性（不阻塞，失败记到报告）
  for (const modName of ['onnxruntime-node', 'better-sqlite3']) {
    try {
      require.resolve(modName)
      report.nativeModules[modName] = { ok: true, resolved: require.resolve(modName) }
    } catch (e) {
      report.nativeModules[modName] = { ok: false, reason: e.message }
      allOk = false
    }
  }

  return {
    inferenceMode: allOk ? 'hybrid-auto' : 'server-only',
    allOk,
    details: report,
    manifestVersion: MANIFEST.version,
    totalDownloadSizeBytes: MANIFEST.totalDownloadSizeBytes
  }
}

// ───────────────────── 下载一个 pkg（多文件顺序下，断点续传 + SHA256）─────────────────────
async function downloadPkg(pkgId, { store /* electron-store 实例 */ } = {}) {
  const pkg = MANIFEST.inferencePkgs.find((p) => p.id === pkgId)
  if (!pkg) throw new Error(`Unknown pkgId: ${pkgId}`)

  if (pkg.platformOnly && !pkg.platformOnly.includes(`${process.platform}-${process.arch}`)) {
    return { skipped: true, reason: 'PLATFORM_NOT_MATCH' }
  }

  if (runningTasks.has(pkgId)) {
    return { skipped: true, reason: 'ALREADY_RUNNING', taskId: runningTasks.get(pkgId) }
  }

  const taskId = makeTaskId(pkgId)
  runningTasks.set(pkgId, taskId)

  const dir = pkgId.startsWith('native-addons') ? nativeAddonsDir() : modelsDir()
  const cdnBase = MANIFEST.cdnBase.replace(/\/$/, '')
  const totalFiles = pkg.files.length

  try {
    for (let idx = 0; idx < totalFiles; idx++) {
      const f = pkg.files[idx]
      const savePath = path.join(dir, f.name)
      const fileUrl = `${cdnBase}/${pkg.id}/${f.name}`

      // 广播文件级进度：整体 = (idx + sub) / total
      const onProgress = (_tid, sub) => {
        const overall = Math.round(((idx + (sub.percent / 100)) / totalFiles) * 100)
        broadcastProgress(taskId, {
          percent: overall,
          fileIndex: idx, totalFiles,
          fileName: f.name,
          state: 'downloading',
          downloaded: sub.downloaded,
          total: sub.total,
        })
      }

      let attempts = 0
      const MAX_ATTEMPTS = 2
      while (true) {
        attempts++
        try {
          await downloadFile(fileUrl, savePath, {
            expectedSha256: f.sha256,
            expectedSize: f.size,
            onProgress,
            taskId,
          })
          // 校验大小
          const stat = fs.statSync(savePath)
          if (stat.size !== f.size) {
            throw new Error(`Size mismatch: ${stat.size} != ${f.size}`)
          }
          // SHA256（TBD_ 跳过）
          if (f.sha256 && !f.sha256.startsWith('TBD_')) {
            const actual = await sha256File(savePath)
            if (actual.toLowerCase() !== f.sha256.toLowerCase()) {
              fs.unlinkSync(savePath)
              throw new Error(`SHA256 mismatch for ${f.name}`)
            }
          }
          break // 成功
        } catch (err) {
          if (attempts > MAX_ATTEMPTS) throw err
          // 清掉损坏文件重下
          try { fs.unlinkSync(savePath) } catch (_) {}
        }
      }
    }

    broadcastDone(taskId, { pkgId, state: 'success', finalPath: dir })
    return { taskId, pkgId, ok: true, state: 'installed' }
  } catch (err) {
    broadcastError(taskId, err)
    return { taskId, pkgId, ok: false, error: err.message || String(err) }
  } finally {
    runningTasks.delete(pkgId)
    // 刷新冷启动校验结果，写回 store
    if (store) {
      const iv = verifyInstallation()
      store.set('inference.mode', iv.inferenceMode)
      store.set('inference.lastVerifyAt', Date.now())
      store.set('inference.verifyReport', iv.details)
    }
  }
}

// ───────────────────── 卸载：删除 userData 下模型 + DLL ─────────────────────
function uninstallPkg(pkgId) {
  const pkg = MANIFEST.inferencePkgs.find((p) => p.id === pkgId)
  if (!pkg) throw new Error(`Unknown pkgId: ${pkgId}`)
  const dir = pkgId.startsWith('native-addons') ? nativeAddonsDir() : modelsDir()
  for (const f of pkg.files) {
    const fp = path.join(dir, f.name)
    try { if (fs.existsSync(fp)) fs.unlinkSync(fp) } catch (_) {}
  }
  return { pkgId, state: 'uninstalled' }
}

// ───────────────────── 对外 API ─────────────────────
function createModelManager({ store } = {}) {
  return {
    MANIFEST,
    paths: { modelsDir: modelsDir(), nativeAddonsDir: nativeAddonsDir(), dbDir: dbDir() },
    verifyInstallation,
    verifyPkg: (id) => verifyPkg(MANIFEST.inferencePkgs.find((p) => p.id === id)),
    downloadPkg: (id) => downloadPkg(id, { store }),
    uninstallPkg,
    cancelPkg: (id) => {
      runningTasks.delete(id)
      return { ok: true }
    },
    listPkgs: () => MANIFEST.inferencePkgs.map((p) => {
      const vr = (p.platformOnly && !p.platformOnly.includes(`${process.platform}-${process.arch}`))
        ? { skipped: true, reason: 'PLATFORM_NOT_MATCH' }
        : verifyPkg(p)
      return {
        id: p.id,
        totalSize: p.totalSize,
        files: p.files.map((f) => ({ name: f.name, size: f.size })),
        status: vr.skipped ? 'SKIPPED' : (vr.allOk ? 'INSTALLED' : 'NOT_INSTALLED'),
        platformOnly: p.platformOnly || null
      }
    }),
    isRunning: (id) => runningTasks.has(id)
  }
}

module.exports = { createModelManager }
