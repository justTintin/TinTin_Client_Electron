// ═══════════════════════════════════════════════════════════════
// config-migrate.js — electron-store 配置键一次性迁移清理
// 2026-08-28：electron-store 已由 config-store 分域存储接管（见 config-store.js），
//   本模块仅保留「废弃键启动清理」职责，接口（has/delete 注入）不变、零改动兼容。
// P3 遗留闭环（GAP §3.4-3，2026-08-27 裁决）：
//   「系统设置 → 扩展插件」卡已随 P3 移除，外挂 Chrome CDP(9222) +
//   bridge(8123) 载体作废，其 6 个分离时代配置键随启动静默清除；
//   ext.shopKeyword 仍被浏览器自动上架面板使用，保留。
// ═══════════════════════════════════════════════════════════════

/** P3 废弃的 ext.* 键（原 useSettingsExtension 下载插件 Tab 6 项配置） */
const DEPRECATED_EXT_KEYS = [
  'ext.bridgePort',
  'ext.bridgeSaveDir',
  'ext.scanServer',
  'ext.chromePort',
  'ext.chromePath',
  'ext.chromeDataDir',
]

/** 仍有效的 ext.* 键（禁止误删） */
const KEPT_EXT_KEYS = ['ext.shopKeyword']

/**
 * 清除废弃配置键（幂等，可重复执行）
 * @param {{has:(k:string)=>boolean, delete:(k:string)=>void}} store electron-store 实例或内存兜底
 * @returns {string[]} 实际删除的键
 */
function purgeDeprecatedExtKeys(store) {
  const removed = []
  if (!store || typeof store.has !== 'function' || typeof store.delete !== 'function') return removed
  for (const k of DEPRECATED_EXT_KEYS) {
    try {
      if (store.has(k)) {
        store.delete(k)
        removed.push(k)
      }
    } catch (_) { /* 单键失败不中断 */ }
  }
  return removed
}

module.exports = { DEPRECATED_EXT_KEYS, KEPT_EXT_KEYS, purgeDeprecatedExtKeys }
