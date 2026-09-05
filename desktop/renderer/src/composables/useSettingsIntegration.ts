// ═══════════════════════════════════════════════════════════════
// useSettingsIntegration — 设置页「系统与运行」（S9）composable
// 业务动作编排；编组/校验/脱敏纯函数在 settingsIntegrationLogic.ts（可单测）。
//
// 2026-08-30 用户裁决：S8 平台接入（数字人/ComfyUI/RunningHub 直连配置）整体移除——
//   三者均已通过统一服务端接入，原客户端已删除直连配置，客户端不再保留入口。
//
// S9 系统与运行（对齐原 L1931-2040 自启动/缓存目录 + L1622-1637 系统信息）：
//   · 自启动：system:getAutoStart/setAutoStart（app.setLoginItemSettings，
//     与托盘 tray.js 同通道一致，双向同步）
//   · 缓存目录：dialog.openDir 选择 → config 'local.cacheDir'（原 local_config.cache_dir）
//   · 系统信息：env:detectEnv local（os/cpu/ram/disk；gpu 弃检）
// 2026-09-04 用户裁决：LUT 调色文件逻辑整体删除（原 L2041-2120 / video.lutMap，
//   本端无消费方；如后续混剪镜头重组需调色可再回收）
// 异常口径：无 IPC（预览环境）/ 保存失败 / 参数校验拦截 分支齐备。
// ═══════════════════════════════════════════════════════════════

import { ref } from 'vue'
import {
  CACHE_DIR_KEY,
  buildSysInfoRows,
} from './settingsIntegrationLogic'
import { getTintin, readCfg, writeCfg } from './useSettingsConfig'

export function useSettingsIntegration() {
  /* ── S9 系统与运行（hint 由缓存目录保存动作复用） ────── */
  const autoStart = ref(false)
  const autoStartLoading = ref(false)
  const cacheDir = ref('')
  const cacheDirIsDefault = ref(false)  // true = 显示的是默认 outputs 目录（未用户配置）
  const sysInfoRows = ref<Array<{ label: string; value: string }>>([])
  const sysInfoLoading = ref(false)
  const hint = ref('')

  /** 自启动状态（读系统真实值；托盘同通道） */
  async function loadAutoStart(): Promise<void> {
    const t = getTintin()
    if (!t?.system?.getAutoStart) return
    try {
      const r = await t.system.getAutoStart()
      if (r) autoStart.value = !!r.enabled
    } catch (_e) { /* 静默 */ }
  }

  /** 切换自启动（写系统 + 回读确认） */
  async function toggleAutoStart(v: boolean): Promise<void> {
    if (autoStartLoading.value) return
    autoStartLoading.value = true
    const t = getTintin()
    try {
      if (!t?.system?.setAutoStart) { autoStart.value = !v; return }
      const r = await t.system.setAutoStart(v)
      autoStart.value = r ? !!r.enabled : !v
    } catch (_e) { autoStart.value = !v }
    finally { autoStartLoading.value = false }
  }

  /** 缓存目录：dialog 选择 → config 'local.cacheDir' */
  async function pickCacheDir(): Promise<void> {
    const t = getTintin()
    if (!t?.dialog?.openDir) return
    const r = await t.dialog.openDir({ title: '选择本地缓存目录' })
    // 主进程 dialog:openDir 返回 string（路径）或 null（取消）
    const d = typeof r === 'string' ? r : (Array.isArray(r?.filePaths) ? r.filePaths[0] : (r?.filePaths ?? r?.path))
    if (!d) return
    const ok = await writeCfg(CACHE_DIR_KEY, String(d))
    if (ok) cacheDir.value = String(d)
    hint.value = ok ? '缓存目录已保存' : '保存失败'
    setTimeout(() => { hint.value = '' }, 1500)
  }

  /** 系统信息（env:detectEnv local：os/cpu/ram/disk） */
  async function loadSysInfo(): Promise<void> {
    if (sysInfoLoading.value) return
    sysInfoLoading.value = true
    const t = getTintin()
    try {
      if (!t?.env?.detectEnv) {
        sysInfoRows.value = buildSysInfoRows(null)
        return
      }
      const r = await t.env.detectEnv()
      sysInfoRows.value = buildSysInfoRows(r?.local ?? null)
    } catch (_e) {
      sysInfoRows.value = buildSysInfoRows(null)
    } finally {
      sysInfoLoading.value = false
    }
  }

  /** 容器 onMounted 编排：全部加载 */
  async function loadIntegrationCfg(): Promise<void> {
    await loadAutoStart()
    const saved = await readCfg(CACHE_DIR_KEY, '')
    if (saved) {
      cacheDir.value = String(saved)
      cacheDirIsDefault.value = false
    } else {
      // 未配置时显示默认 outputs 目录
      const t = getTintin()
      try {
        const ws = t?.app?.getPath ? await t.app.getPath('workspace') : ''
        cacheDir.value = ws ? String(ws) : ''
        cacheDirIsDefault.value = !!ws
      } catch (_) { cacheDir.value = ''; cacheDirIsDefault.value = false }
    }
    void loadSysInfo()
  }

  return {
    // S9
    autoStart,
    autoStartLoading,
    toggleAutoStart,
    cacheDir,
    cacheDirIsDefault,
    pickCacheDir,
    sysInfoRows,
    sysInfoLoading,
    loadSysInfo,
    hint,
    loadIntegrationCfg,
  }
}
