const { ipcMain, app } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

const STORAGE_KEYS = {
  SNIFFED: 'media.sniffedHistory',
  DOWNLOADS: 'media.downloadRecords',
  SETTINGS: 'media.settings',
  FAVORITES: 'media.favorites',
}

const MAX_SNIFFED = 200
const MAX_DOWNLOADS = 500
const MAX_FAVORITES = 500

function _loadFromStore(store, key, fallback) {
  try {
    if (store && store.has(key)) return store.get(key, fallback)
  } catch (_) {}
  return fallback
}

function _saveToStore(store, key, value) {
  try {
    if (store) store.set(key, value)
    return true
  } catch (_) {
    return false
  }
}

function _ensureDir(dirPath) {
  try {
    if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true })
    return true
  } catch (_) {
    return false
  }
}

function createMediaStorage(ipcMain, { store }) {
  if (!ipcMain) throw new Error('createMediaStorage: ipcMain is required')

  let sniffedCache = []
  let downloadCache = []
  let settingsCache = { autoSave: true, maxHistory: MAX_SNIFFED, downloadDir: '' }
  let favoritesCache = []

  try {
    sniffedCache = _loadFromStore(store, STORAGE_KEYS.SNIFFED, [])
    downloadCache = _loadFromStore(store, STORAGE_KEYS.DOWNLOADS, [])
    settingsCache = { ...settingsCache, ..._loadFromStore(store, STORAGE_KEYS.SETTINGS, {}) }
    favoritesCache = _loadFromStore(store, STORAGE_KEYS.FAVORITES, [])
  } catch (_) {}

  if (settingsCache.downloadDir) {
    try { _ensureDir(settingsCache.downloadDir) } catch (_) {}
  }

  const saveSniffed = (list) => {
    sniffedCache = Array.isArray(list) ? list.slice(0, settingsCache.maxHistory || MAX_SNIFFED) : []
    _saveToStore(store, STORAGE_KEYS.SNIFFED, sniffedCache)
  }

  const saveDownloads = (list) => {
    downloadCache = Array.isArray(list) ? list.slice(0, MAX_DOWNLOADS) : []
    _saveToStore(store, STORAGE_KEYS.DOWNLOADS, downloadCache)
  }

  const saveSettings = (s) => {
    settingsCache = { ...settingsCache, ...(s || {}) }
    _saveToStore(store, STORAGE_KEYS.SETTINGS, settingsCache)
  }

  const saveFavorites = (list) => {
    favoritesCache = Array.isArray(list) ? list.slice(0, MAX_FAVORITES) : []
    _saveToStore(store, STORAGE_KEYS.FAVORITES, favoritesCache)
  }

  const addFavorite = (item) => {
    if (!item || !item.url) return favoritesCache
    const exists = favoritesCache.findIndex(f => f.url === item.url)
    if (exists >= 0) {
      favoritesCache[exists] = { ...favoritesCache[exists], ...item, updatedAt: Date.now() }
    } else {
      favoritesCache.unshift({ ...item, addedAt: Date.now() })
      if (favoritesCache.length > MAX_FAVORITES) favoritesCache.pop()
    }
    _saveToStore(store, STORAGE_KEYS.FAVORITES, favoritesCache)
    return favoritesCache
  }

  const removeFavorite = (url) => {
    favoritesCache = favoritesCache.filter(f => f.url !== url)
    _saveToStore(store, STORAGE_KEYS.FAVORITES, favoritesCache)
    return favoritesCache
  }

  ipcMain.handle('media:storageGetSniffed', () => {
    try { return { success: true, data: sniffedCache } }
    catch (e) { return { success: false, error: e.message } }
  })

  ipcMain.handle('media:storageSaveSniffed', (_e, list) => {
    try {
      saveSniffed(list)
      return { success: true, count: sniffedCache.length }
    } catch (e) { return { success: false, error: e.message } }
  })

  ipcMain.handle('media:storageGetDownloads', () => {
    try { return { success: true, data: downloadCache } }
    catch (e) { return { success: false, error: e.message } }
  })

  ipcMain.handle('media:storageSaveDownloads', (_e, list) => {
    try {
      saveDownloads(list)
      return { success: true, count: downloadCache.length }
    } catch (e) { return { success: false, error: e.message } }
  })

  ipcMain.handle('media:storageGetSettings', () => {
    try { return { success: true, data: settingsCache } }
    catch (e) { return { success: false, error: e.message } }
  })

  ipcMain.handle('media:storageSaveSettings', (_e, s) => {
    try {
      saveSettings(s)
      return { success: true, data: settingsCache }
    } catch (e) { return { success: false, error: e.message } }
  })

  ipcMain.handle('media:storageExport', async (_e, { format = 'json', path: destPath } = {}) => {
    try {
      const data = {
        version: 1,
        exportedAt: new Date().toISOString(),
        sniffed: sniffedCache,
        downloads: downloadCache,
        settings: settingsCache,
      }

      if (format === 'json') {
        let outPath = destPath
        if (!outPath) {
          const dlDir = settingsCache.downloadDir || app.getPath('downloads')
          outPath = path.join(dlDir, `tintin-media-export-${Date.now()}.json`)
        }
        fs.writeFileSync(outPath, JSON.stringify(data, null, 2), 'utf-8')
        return { success: true, path: outPath }
      }

      if (format === 'csv') {
        let outPath = destPath
        if (!outPath) {
          const dlDir = settingsCache.downloadDir || app.getPath('downloads')
          outPath = path.join(dlDir, `tintin-media-sniffed-${Date.now()}.csv`)
        }
        const headers = ['name', 'type', 'url', 'size', 'platformId', 'timestamp']
        const rows = sniffedCache.map(m => [
          `"${String(m.name || '').replace(/"/g, '""')}"`,
          m.type || '',
          `"${String(m.url || '').replace(/"/g, '""')}"`,
          m.size || 0,
          m.platformId || '',
          m.ts || 0,
        ].join(','))
        fs.writeFileSync(outPath, [headers.join(','), ...rows].join('\n'), 'utf-8')
        return { success: true, path: outPath, count: sniffedCache.length }
      }

      return { success: false, error: 'UNKNOWN_FORMAT' }
    } catch (e) { return { success: false, error: e.message } }
  })

  ipcMain.handle('media:storageImport', async (_e, { path: srcPath } = {}) => {
    try {
      if (!srcPath) return { success: false, error: 'NO_PATH' }
      const raw = fs.readFileSync(srcPath, 'utf-8')
      const data = JSON.parse(raw)

      if (data.sniffed && Array.isArray(data.sniffed)) {
        const existing = new Set(sniffedCache.map(m => m.url))
        const merged = [...data.sniffed.filter(m => !existing.has(m.url)), ...sniffedCache]
        saveSniffed(merged)
      }

      if (data.downloads && Array.isArray(data.downloads)) {
        const existing = new Set(downloadCache.map(d => d.id))
        const merged = [...data.downloads.filter(d => !existing.has(d.id)), ...downloadCache]
        saveDownloads(merged)
      }

      if (data.settings && typeof data.settings === 'object') {
        saveSettings(data.settings)
      }

      return {
        success: true,
        sniffedImported: data.sniffed ? data.sniffed.length : 0,
        downloadsImported: data.downloads ? data.downloads.length : 0,
      }
    } catch (e) { return { success: false, error: e.message } }
  })

  ipcMain.handle('media:storageClearHistory', (_e, { type = 'sniffed' } = {}) => {
    try {
      if (type === 'sniffed') {
        saveSniffed([])
        return { success: true, cleared: 'sniffed' }
      }
      if (type === 'downloads') {
        saveDownloads([])
        return { success: true, cleared: 'downloads' }
      }
      if (type === 'all') {
        saveSniffed([])
        saveDownloads([])
        return { success: true, cleared: 'all' }
      }
      return { success: false, error: 'UNKNOWN_TYPE' }
    } catch (e) { return { success: false, error: e.message } }
  })

  ipcMain.handle('media:storageOpenDownloadDir', () => {
    try {
      const dlDir = settingsCache.downloadDir || app.getPath('downloads')
      _ensureDir(dlDir)
      const { shell } = require('electron')
      shell.openPath(dlDir)
      return { success: true, path: dlDir }
    } catch (e) { return { success: false, error: e.message } }
  })

  ipcMain.handle('media:storageGetFavorites', () => {
    try { return { success: true, data: favoritesCache } }
    catch (e) { return { success: false, error: e.message } }
  })

  ipcMain.handle('media:storageSaveFavorites', (_e, list) => {
    try {
      saveFavorites(list)
      return { success: true, count: favoritesCache.length }
    } catch (e) { return { success: false, error: e.message } }
  })

  ipcMain.handle('media:storageAddFavorite', (_e, item) => {
    try {
      const result = addFavorite(item)
      return { success: true, data: result, count: result.length }
    } catch (e) { return { success: false, error: e.message } }
  })

  ipcMain.handle('media:storageRemoveFavorite', (_e, url) => {
    try {
      const result = removeFavorite(url)
      return { success: true, data: result, count: result.length }
    } catch (e) { return { success: false, error: e.message } }
  })

  return {
    getSniffed: () => sniffedCache,
    getDownloads: () => downloadCache,
    getSettings: () => settingsCache,
    getFavorites: () => favoritesCache,
    setSniffed: saveSniffed,
    setDownloads: saveDownloads,
    setSettings: saveSettings,
    setFavorites: saveFavorites,
    addFavorite,
    removeFavorite,
  }
}

module.exports = { createMediaStorage, STORAGE_KEYS }