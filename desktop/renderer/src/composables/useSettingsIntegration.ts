// ═══════════════════════════════════════════════════════════════
// useSettingsIntegration — 设置页「系统与运行」（S9）composable
// 业务动作编排；编组/校验/脱敏纯函数在 settingsIntegrationLogic.ts（可单测）。
//
// 2026-08-30 用户裁决：S8 平台接入（数字人/ComfyUI/RunningHub 直连配置）整体移除——
//   三者均已通过统一服务端接入，原客户端已删除直连配置，客户端不再保留入口。
//
// S9 系统与运行（对齐原 L1931-2040 自启动/缓存目录 + L2041-2120 LUT +
//   L1622-1637 系统信息）：
//   · 自启动：system:getAutoStart/setAutoStart（app.setLoginItemSettings，
//     与托盘 tray.js 同通道一致，双向同步）
//   · 缓存目录：dialog.openDir 选择 → config 'local.cacheDir'（原 local_config.cache_dir）
//   · LUT：video.lutMap（name → path 映射，.cube/.3dl/.lut，app 域）
//   · 系统信息：env:detectEnv local（os/cpu/ram/disk；gpu 弃检）
// 异常口径：无 IPC（预览环境）/ 保存失败 / 参数校验拦截 分支齐备。
// ═══════════════════════════════════════════════════════════════

import { ref } from 'vue'
import {
  validateLutName,
  normalizeLutName,
  CACHE_DIR_KEY,
  buildSysInfoRows,
} from './settingsIntegrationLogic'
import { getTintin, readCfg, writeCfg } from './useSettingsConfig'

export interface LutEntry { name: string; path: string }

export function useSettingsIntegration() {
  /* ── S9 系统与运行（hint 由缓存目录/LUT 保存动作复用） ────── */
  const autoStart = ref(false)
  const autoStartLoading = ref(false)
  const cacheDir = ref('')
  const cacheDirIsDefault = ref(false)  // true = 显示的是默认 outputs 目录（未用户配置）
  const lutList = ref<LutEntry[]>([])
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

  /** LUT 列表加载（video.lutMap：name → path） */
  async function loadLuts(): Promise<void> {
    // readCfg 泛型约束 string|boolean，对象值经类型断言收敛（config-store 实际可存对象）
    const raw = (await readCfg('video.lutMap', '')) as unknown
    const map = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? (raw as Record<string, unknown>) : {}
    lutList.value = Object.entries(map).map(([name, path]) => ({ name, path: String(path) }))
  }

  /** 添加 LUT：选文件（.cube/.3dl/.lut）→ 默认名=去扩展名 → 追加 */
  async function addLut(): Promise<void> {
    const t = getTintin()
    if (!t?.dialog?.openFile) return
    const r = await t.dialog.openFile({
      title: '选择 LUT 还原文件',
      filters: [{ name: 'LUT 文件', extensions: ['cube', '3dl', 'lut'] }],
    })
    if (!r) return
    const p = String(r)
    const name = normalizeLutName(p)
    if (lutList.value.some((e) => e.name === name)) { hint.value = `已存在同名 LUT：${name}`; setTimeout(() => { hint.value = '' }, 1500); return }
    lutList.value.push({ name, path: p })
    await saveLuts()
  }

  /** 删除 LUT（按名称） */
  async function removeLut(name: string): Promise<void> {
    lutList.value = lutList.value.filter((e) => e.name !== name)
    await saveLuts()
  }

  /** 保存 LUT 映射（video.lutMap，app 域） */
  async function saveLuts(): Promise<void> {
    const map: Record<string, string> = {}
    for (const e of lutList.value) {
      const n = String(e.name || '').trim()
      if (n && validateLutName(n) === '') map[n] = String(e.path || '')
    }
    const ok = await writeCfg('video.lutMap', map)
    hint.value = ok ? 'LUT 配置已保存' : 'LUT 保存失败'
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
    await loadLuts()
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
    lutList,
    addLut,
    removeLut,
    sysInfoRows,
    sysInfoLoading,
    loadSysInfo,
    hint,
    loadIntegrationCfg,
  }
}
