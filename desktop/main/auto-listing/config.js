// ═══════════════════════════════════════════════════════════════
// auto-listing/config.js — B12 自动上架：店铺映射 + 配置读写
//
// 对位：原 studio/utils/auto_listing/config.py（DOUYIN_STORES / default_config
//   / load_config / save_config），载体由「外挂 Chrome CDP」改为「内置
//   BrowserView persist:tintin-fxg 分区 + executeJavaScript + CDP debugger」。
//
// 配置存储取舍：沿用 config-store（main/config-store.js 分域 JSON）的
//   autoListing.* 键，不新增独立 JSON 文件 —— 与现有 config:get/set IPC
//   同源（渲染层经 tintinBrowser.config 可直接读写），避免双份配置源。
//   autoListing.* 未在前缀路由表命中 → 落入 app.json 兜底域（原 electron-store
//   单文件语义兼容）。
// ═══════════════════════════════════════════════════════════════
'use strict'

const path = require('node:path')

/** 抖店店铺映射（对位原 config.py DOUYIN_STORES，字段一致：name/aliases/homepage_url） */
const DOUYIN_STORES = {
  juyou: {
    name: '桔柚数码外设严选',
    aliases: ['桔柚', 'juyou'],
    homepage_url: 'https://fxg.jinritemai.com/ffa/mshop/homepage/index',
  },
  '555_battery': {
    name: '555井韵电池店铺',
    aliases: ['555', '井韵'],
    homepage_url: 'https://fxg.jinritemai.com/ffa/mshop/homepage/index',
  },
}

/** 自动上架默认配置（userData/auto-listing 下 runs/ results/ logs/ 三目录，PRD 14.6） */
function defaultConfig(userDataDir) {
  const root = path.join(userDataDir, 'auto-listing')
  return {
    shopKey: 'juyou',
    publishAfterSave: false,
    syncDir: root,
    resultDir: path.join(root, 'results'),
  }
}

/** 读配置：store 缺失/异常 → 默认值（绝不抛错） */
function loadConfig(store, userDataDir) {
  const d = defaultConfig(userDataDir)
  if (!store || typeof store.get !== 'function') return d
  try {
    const saved = store.get('autoListing') || {}
    if (saved && typeof saved === 'object') {
      if (typeof saved.shopKey === 'string' && saved.shopKey) d.shopKey = saved.shopKey
      if (typeof saved.publishAfterSave === 'boolean') d.publishAfterSave = saved.publishAfterSave
      if (typeof saved.syncDir === 'string' && saved.syncDir) d.syncDir = saved.syncDir
      if (typeof saved.resultDir === 'string' && saved.resultDir) d.resultDir = saved.resultDir
    }
  } catch (_) { /* 配置读失败回退默认 */ }
  return d
}

/** 写配置（patch 合入 autoListing.* 并落盘；返回合并后配置） */
function saveConfig(store, userDataDir, patch) {
  const merged = { ...loadConfig(store, userDataDir), ...(patch || {}) }
  if (store && typeof store.set === 'function') {
    try { store.set('autoListing', merged) } catch (_) { /* 写失败静默 */ }
  }
  return merged
}

module.exports = { DOUYIN_STORES, defaultConfig, loadConfig, saveConfig }
