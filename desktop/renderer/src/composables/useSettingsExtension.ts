// ═══════════════════════════════════════════════════════════════
// useSettingsExtension — 设置页·扩展插件（下载插件 / 自动上架）
// 状态与方法自 Settings.vue 原样迁出（行为不变，IRON-08）；
// 配置经 electron-store（IPC）持久化，读写工具来自 useSettingsConfig。
// ═══════════════════════════════════════════════════════════════

import { ref } from 'vue'
import { getTintin, hasEnv, readCfg, writeCfg } from './useSettingsConfig'

/* ── 常量：分段控件选项 ─────────────────────────────────────── */
const extTabs = ['下载插件', '自动上架']

export function useSettingsExtension() {
  const activeExtTab = ref<string>('下载插件')

  const bridgePort = ref<string>('8123')
  const bridgeSaveDir = ref<string>('D:\\TinTin\\collected')
  const extScanServer = ref<boolean>(true)
  const chromePort = ref<string>('9222')
  const chromePath = ref<string>('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe')
  const chromeDataDir = ref<string>('D:\\TinTin\\chrome-profile')
  const shopKeyword = ref<string>('桔柚')

  /** 自动上架预览状态（已解析到正式连接前为 null） */
  const cdpState = ref<string>('未检测')
  const cdpBusy = ref<boolean>(false)

  async function loadExtCfg() {
    bridgePort.value    = String(await readCfg('ext.bridgePort', bridgePort.value))
    bridgeSaveDir.value = String(await readCfg('ext.bridgeSaveDir', bridgeSaveDir.value))
    extScanServer.value = (await readCfg('ext.scanServer', extScanServer.value)) as boolean
    chromePort.value    = String(await readCfg('ext.chromePort', chromePort.value))
    chromePath.value    = String(await readCfg('ext.chromePath', chromePath.value))
    chromeDataDir.value = String(await readCfg('ext.chromeDataDir', chromeDataDir.value))
    shopKeyword.value   = String(await readCfg('ext.shopKeyword', shopKeyword.value))
  }

  async function browseDir(field: 'bridgeSaveDir' | 'chromeDataDir') {
    if (!getTintin()?.dialog?.openDir) return
    try {
      const r = await getTintin().dialog.openDir({})
      const picked = Array.isArray(r?.filePaths) ? r.filePaths[0] : (r?.filePaths ?? r?.path)
      if (picked) { (field === 'bridgeSaveDir' ? bridgeSaveDir : chromeDataDir).value = String(picked) }
    } catch (_) {}
  }

  async function browseFile() {
    if (!getTintin()?.dialog?.openFile) return
    try {
      const r = await getTintin().dialog.openFile({})
      const picked = Array.isArray(r?.filePaths) ? r.filePaths[0] : (r?.filePaths ?? r?.path)
      if (picked) chromePath.value = String(picked)
    } catch (_) {}
  }

  /** 检测调试 Chrome（env:detectCdp — 真实 IPC） */
  async function detectChrome() {
    cdpBusy.value = true
    if (!hasEnv()) { cdpState.value = '预览环境暂不可用'; cdpBusy.value = false; return }
    try {
      const r = await getTintin().env.detectCdp(Number(chromePort.value) || 9222)
      cdpState.value = r?.connected ? `已连接 · ${r.info?.Browser || 'Chrome'} (127.0.0.1:${r.port})` : `未检测到 :${Number(chromePort.value) || 9222}`
    } catch (_e) { cdpState.value = '检测失败' }
    cdpBusy.value = false
  }

  async function saveExtension() {
    await Promise.all([
      writeCfg('ext.bridgePort', bridgePort.value),
      writeCfg('ext.bridgeSaveDir', bridgeSaveDir.value),
      writeCfg('ext.scanServer', extScanServer.value),
      writeCfg('ext.chromePort', chromePort.value),
      writeCfg('ext.chromePath', chromePath.value),
      writeCfg('ext.chromeDataDir', chromeDataDir.value),
      writeCfg('ext.shopKeyword', shopKeyword.value),
    ])
  }

  return {
    extTabs,
    activeExtTab,
    bridgePort,
    bridgeSaveDir,
    extScanServer,
    chromePort,
    chromePath,
    chromeDataDir,
    shopKeyword,
    cdpState,
    cdpBusy,
    loadExtCfg,
    browseDir,
    browseFile,
    detectChrome,
    saveExtension,
  }
}
