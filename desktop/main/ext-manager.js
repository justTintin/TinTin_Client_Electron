// ═══════════════════════════════════════════════════════════════
// ext-manager.js — 扩展管理器（从 thickShell-ipc.js 原样拆出，无逻辑改动）
//   上传 crx/zip → 解压到 userData/extensions → 对每个平台分隔离 session 逐个 loadExtension
//   逐 session 加载：保持各平台 cookie/登录态隔离（电商多店铺安全），扩展 content script 按 manifest.matches 在各平台页面生效
// ═══════════════════════════════════════════════════════════════

const path = require('node:path')
const fs = require('node:fs')
const { app, session } = require('electron')
const AdmZip = require('adm-zip')
const { PLATFORM_DEFS, PLATFORM_IDS } = require('./platform-meta')
const { _findBilibiliHelperDir } = require('./bilibili-ext')

const _extManager = {
  root: null,          // userData/extensions
  manifest: [],        // 已安装扩展清单 [{ id, name, version, path, icon, addedAt }]
  manifestFile: null,
  // 计算清单指纹：内容变更时推送 renderer 刷新工具栏/面板
  _fingerprint: '',

  init() {
    try {
      this.root = path.join(app.getPath('userData'), 'extensions')
      this.manifestFile = path.join(this.root, 'manifest.json')
      fs.mkdirSync(this.root, { recursive: true })
      this._loadManifest()
    } catch (_) {}
  },
  _loadManifest() {
    try {
      if (fs.existsSync(this.manifestFile)) {
        this.manifest = JSON.parse(fs.readFileSync(this.manifestFile, 'utf8'))
        if (!Array.isArray(this.manifest)) this.manifest = []
      }
    } catch (_) { this.manifest = [] }
  },
  _saveManifest() {
    try { fs.writeFileSync(this.manifestFile, JSON.stringify(this.manifest, null, 2), 'utf8') } catch (_) {}
  },
  _fingerprintOf(list) {
    try { return list.map(e => `${e.id}@${e.version}`).join(',') } catch (_) { return '' }
  },
  // 对单个扩展目录，加载到"指定平台 session"；返回 {id,name,version}
  _loadIntoSession(extDir, sess) {
    try {
      const ext = sess.loadExtension(extDir)
      // loadExtension 返回 Promise；此处同步返回 extDir 相关，实际结果由调用方 await
      return ext
    } catch (_) { return null }
  },
  // 获取所有平台/网页的隔离 session（含可能已创建的）
  _allSessions() {
    const sess = []
    for (const id of PLATFORM_IDS) {
      try { sess.push(session.fromPartition(PLATFORM_DEFS[id].partition, { cache: true })) } catch (_) {}
    }
    return sess
  },
  // 把一个扩展目录加载到全部分离 session（幂等：已加载的会被 loadExtension 去重）
  _loadExtToAllSessions(extDir) {
    const results = []
    for (const s of this._allSessions()) {
      try { results.push(s.loadExtension(extDir)) } catch (_) {}
    }
    return Promise.allSettled(results)
  },
  // 安装：接收 crx/zip 文件源路径 → 解压到 root/<id>/ → loadExtension 全 session → 持久化
  async install(filePath) {
    if (!filePath) return { success: false, message: '未选择文件' }
    try {
      const extDir = this._extractPackage(filePath)
      if (!extDir) return { success: false, message: '无法解析扩展包（需为 manifest.json 的 zip 或 crx）' }
      // 读取解析出的 manifest 基本信息
      const mf = JSON.parse(fs.readFileSync(path.join(extDir, 'manifest.json'), 'utf8'))
      const id = (mf.key ? String(mf.key).slice(0, 32) : null) || path.basename(extDir)
      const entry = {
        id,
        name: mf.name || '未命名扩展',
        version: mf.version || '—',
        path: extDir,
        icon: (mf.icons && (mf.icons['128'] || mf.icons['48'] || mf.icons['32'] || mf.icons['16'])) || null,
        addedAt: Date.now(),
      }
      // 先移除同 id 旧版本，再加载新版（避免重复）
      this._removeExtensionEntry(id)
      await this._loadExtToAllSessions(extDir)
      this.manifest.push(entry)
      this._saveManifest()
      this._bump()
      return { success: true, data: entry, message: `已安装：${entry.name} v${entry.version}` }
    } catch (e) {
      return { success: false, message: '安装失败：' + (e.message || e) }
    }
  },
  _removeExtensionEntry(id) {
    const idx = this.manifest.findIndex(e => e.id === id)
    if (idx >= 0) this.manifest.splice(idx, 1)
  },
  // 卸载：从清单移除 + userData 删除目录 + 各 session removeExtension
  uninstall(id) {
    try {
      const entry = this.manifest.find(e => e.id === id)
      if (!entry) return { success: false, message: '扩展不存在' }
      for (const s of this._allSessions()) {
        try { s.removeExtension(id) } catch (_) {}
      }
      this._removeExtensionEntry(id)
      this._saveManifest()
      try { fs.rmSync(entry.path, { recursive: true, force: true }) } catch (_) {}
      this._bump()
      return { success: true, message: `已卸载：${entry.name}` }
    } catch (e) { return { success: false, message: '卸载失败：' + (e.message || e) } }
  },
  // 列表：内置 B站下载助手 + 已装用户扩展
  list() {
    const builtin = _builtinExtension()
    return { installed: true, extensions: [builtin, ...this.manifest] }
  },
  // 通知渲染层扩展列表已变化
  _bump() {
    try {
      const f = this._fingerprintOf(this.manifest)
      if (f === this._fingerprint) return
      this._fingerprint = f
      const mw = require('electron').BrowserWindow.getAllWindows().find(w => !w.isDestroyed())
      if (mw) mw.webContents.send('browser:extensions-changed', { extensions: this.list().extensions })
    } catch (_) {}
  },
  // 解压 crx/zip 到 root/<dir>，返回目录；失败返回 null
  _extractPackage(src) {
    const buf = fs.readFileSync(src)
    let zipBuf = buf
    // crx：头部 "Cr24" + version(4) + pubkeyLen(4) + sigLen(4) + header
    if (buf.length >= 4 && buf[0] === 0x43 && buf[1] === 0x72 && buf[2] === 0x32 && buf[3] === 0x34) {
      if (buf.length < 16) return null
      const pubLen = buf.readUInt32LE(8)
      const sigLen = buf.readUInt32LE(12)
      const headLen = 16 + pubLen + sigLen
      if (headLen >= buf.length) return null
      zipBuf = buf.slice(headLen)
    }
    let zip
    try { zip = new AdmZip(zipBuf) } catch (_) { return null }
    const entries = zip.getEntries()
    // 校验根目录有 manifest.json（可能在子目录，做一层查找）
    let manifestEntry = entries.find(e => !e.isDirectory && e.entryName === 'manifest.json')
    let baseDir = ''
    if (!manifestEntry) {
      const inDir = entries.find(e => !e.isDirectory && /(^|\/)manifest\.json$/i.test(e.entryName) && !e.entryName.split('/').slice(1).find(x => x))
      if (inDir) {
        baseDir = inDir.entryName.split('/')[0] + '/'
        manifestEntry = inDir
      }
    }
    if (!manifestEntry) return null
    const mf = JSON.parse(manifestEntry.getData().toString('utf8')) || {}
    const id = (mf.key ? String(mf.key).slice(0, 32) : null) || ('ext_' + Math.random().toString(36).slice(2, 10))
    const outDir = path.join(this.root, id)
    fs.mkdirSync(outDir, { recursive: true })
    // 解压（含 baseDir 前缀剥离）
    for (const en of entries) {
      if (en.isDirectory) continue
      let rel = en.entryName
      if (baseDir && rel.startsWith(baseDir)) rel = rel.slice(baseDir.length)
      if (!rel) continue
      const dest = path.join(outDir, rel)
      try {
        fs.mkdirSync(path.dirname(dest), { recursive: true })
        fs.writeFileSync(dest, en.getData())
      } catch (_) {}
    }
    return fs.existsSync(path.join(outDir, 'manifest.json')) ? outDir : null
  },
}

// 内置 B站下载助手（随包分发，手动注入方案，作为"预装扩展"展示在列表顶部）
function _builtinExtension() {
  const dir = _findBilibiliHelperDir()
  if (!dir) return { id: 'bilibili-helper-builtin', name: 'B站下载助手', version: '预装', installed: true }
  let mf = null
  try { mf = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')) } catch (_) {}
  const ic = (mf && mf.icons) || {}
  return {
    id: 'bilibili-helper',
    name: (mf && mf.name) || 'B站下载助手',
    version: (mf && mf.version) || '—',
    path: dir,
    icon: ic['128'] || ic['48'] || ic['32'] || ic['16'] || null,
    builtin: true,
    description: (mf && mf.description) || 'B站视频下载辅助扩展',
  }
}

module.exports = { _extManager, _builtinExtension }
