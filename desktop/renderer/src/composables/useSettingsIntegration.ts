// ═══════════════════════════════════════════════════════════════
// useSettingsIntegration — 设置页「平台接入」（S8）+「系统与运行」（S9）composable
// 业务动作编排；编组/校验/脱敏纯函数在 settingsIntegrationLogic.ts（可单测）。
//
// S8 平台接入（对齐原 main_window_pages.py L990-1245 数字人 Tab）：
//   · ComfyUI：PUT /comfyui/config（host/port，openapi ComfyUIConfig schema）
//     + 测试 GET /comfyui/status —— 服务端接口存在，保存/测试均走服务端
//   · RunningHub：PUT /runninghub/config（api_key/base_url/use_personal_queue）
//     + 测试 GET /runninghub/status —— 服务端接口存在；api_key 服务端持有，
//     本地不回存，已存值仅脱敏回显（maskKey），输入框只装新输入
//   · 数字人：无独立配置接口（/digital-human/batch 默认 workflow_id
//     2085292185062297602）→ workflowId 存本地 config integration 域
//
// S9 系统与运行（对齐原 L1931-2040 自启动/缓存目录 + L2041-2120 LUT +
//   L1622-1637 系统信息）：
//   · 自启动：system:getAutoStart/setAutoStart（app.setLoginItemSettings，
//     与托盘 tray.js 同通道一致，双向同步）
//   · 缓存目录：dialog.openDir 选择 → config 'local.cacheDir'（原 local_config.cache_dir）
//   · LUT：video.lutMap（name → path 映射，.cube/.3dl/.lut，app 域）
//   · 系统信息：env:detectEnv local（os/cpu/ram/disk；gpu 弃检）
// 异常口径：无 IPC（预览环境）/ 服务端离线 / 保存失败 / 参数校验拦截 四类分支齐备。
// ═══════════════════════════════════════════════════════════════

import { computed, ref } from 'vue'
import {
  PLATFORM_TABS,
  COMFYUI_DEFAULTS,
  maskKey,
  validateComfyui,
  validateRunninghub,
  buildComfyuiBody,
  buildRunninghubBody,
  validateLutName,
  normalizeLutName,
  LUT_EXTS,
  CACHE_DIR_KEY,
  buildSysInfoRows,
} from './settingsIntegrationLogic'
import { getTintin, readCfg, writeCfg } from './useSettingsConfig'

/** 平台测试/保存结果（null=未测试；对照原版状态标签 绿/红 语义） */
export interface PlatformConnResult {
  ok: boolean
  message: string
}

export interface LutEntry { name: string; path: string }

export function useSettingsIntegration() {
  /* ── S8 平台接入 ─────────────────────────────────────────── */
  const activePlatTab = ref<string>(PLATFORM_TABS[0])

  // 数字人（本地 integration 域）
  const workflowId = ref('')

  // ComfyUI（服务端 PUT /comfyui/config）
  const comfyuiHost = ref(COMFYUI_DEFAULTS.host)
  const comfyuiPort = ref(String(COMFYUI_DEFAULTS.port))

  // RunningHub（服务端 PUT /runninghub/config；api_key 服务端持有）
  const rhApiKeyInput = ref('')       // 只装新输入值（不回显明文）
  const rhApiKeyStored = ref('')      // 已保存值（脱敏展示）
  const rhBaseUrl = ref('')
  const rhUsePersonalQueue = ref(false)

  const saving = ref(false)
  const hint = ref('')
  const testBusy = ref(false)
  const testResult = ref<PlatformConnResult | null>(null)

  /** 已保存 api_key 脱敏（''=未保存） */
  const rhApiKeyMasked = computed(() => maskKey(rhApiKeyStored.value))

  /** 平台配置加载（容器 onMounted 调用）：本地数字人 workflowId + 服务端配置回显 */
  async function loadPlatformCfg(): Promise<void> {
    workflowId.value = String((await readCfg('digitalhuman.workflowId', '')) || '')
    const t = getTintin()
    if (!t?.platform?.getConfig) return // 预览环境无 IPC：保留默认值
    try {
      const r = await t.platform.getConfig()
      if (!r) return
      if (r.comfyui && typeof r.comfyui === 'object') {
        if (r.comfyui.host) comfyuiHost.value = String(r.comfyui.host)
        if (r.comfyui.port) comfyuiPort.value = String(r.comfyui.port)
      }
      if (r.runninghub && typeof r.runninghub === 'object') {
        if (r.runninghub.api_key) rhApiKeyStored.value = String(r.runninghub.api_key)
        if (r.runninghub.base_url) rhBaseUrl.value = String(r.runninghub.base_url)
        rhUsePersonalQueue.value = !!r.runninghub.use_personal_queue
      }
    } catch (_e) { /* 服务端离线静默：保留默认值 */ }
  }

  /** 显式保存（按当前 Tab 分平台提交） */
  async function savePlatform(): Promise<void> {
    if (saving.value) return
    const t = getTintin()
    if (!t?.platform) { hint.value = '预览环境：无 IPC'; setTimeout(() => { hint.value = '' }, 1500); return }

    // 数字人：无服务端接口 → 本地 integration 域
    if (activePlatTab.value === '数字人') {
      const v = String(workflowId.value || '').trim()
      saving.value = true
      try {
        const ok = await writeCfg('digitalhuman.workflowId', v)
        hint.value = ok ? '数字人工作流 ID 已保存（本地）' : '保存失败：配置通道不可用'
      } catch (_e) { hint.value = '保存失败' }
      saving.value = false
      setTimeout(() => { hint.value = '' }, 1500)
      return
    }

    // ComfyUI：PUT /comfyui/config
    if (activePlatTab.value === 'ComfyUI') {
      const err = validateComfyui(comfyuiHost.value, comfyuiPort.value)
      if (err) { hint.value = err; setTimeout(() => { hint.value = '' }, 1800); return }
      saving.value = true
      try {
        const r = await t.platform.saveComfyui(buildComfyuiBody(comfyuiHost.value, comfyuiPort.value))
        hint.value = r?.ok ? 'ComfyUI 地址已保存' : String(r?.message || '保存失败')
        if (r?.ok) { /* 保存后回读刷新 */ await loadPlatformCfg() }
      } catch (e) { hint.value = `保存失败：${String((e as any)?.message || e)}` }
      saving.value = false
      setTimeout(() => { hint.value = '' }, 1500)
      return
    }

    // RunningHub：PUT /runninghub/config
    const err = validateRunninghub(rhApiKeyInput.value, rhBaseUrl.value)
    if (err) { hint.value = err; setTimeout(() => { hint.value = '' }, 1800); return }
    saving.value = true
    try {
      const r = await t.platform.saveRunninghub(
        buildRunninghubBody(rhApiKeyInput.value, rhBaseUrl.value, rhUsePersonalQueue.value),
      )
      hint.value = r?.ok ? 'RunningHub 配置已保存' : String(r?.message || '保存失败')
      if (r?.ok) {
        rhApiKeyInput.value = '' // 清明文输入
        await loadPlatformCfg()   // 回读刷新已存 api_key（脱敏展示）
      }
    } catch (e) { hint.value = `保存失败：${String((e as any)?.message || e)}` }
    saving.value = false
    setTimeout(() => { hint.value = '' }, 1500)
  }

  /** 测试连接（ComfyUI / RunningHub，走服务端 status 接口） */
  async function testPlatform(): Promise<void> {
    if (testBusy.value) return
    if (activePlatTab.value !== 'ComfyUI' && activePlatTab.value !== 'RunningHub') {
      testResult.value = { ok: false, message: '数字人无独立测试接口（提交时经 /digital-human/batch 验证）' }
      return
    }
    testBusy.value = true
    testResult.value = null
    const t = getTintin()
    try {
      if (!t?.platform) { testResult.value = { ok: false, message: '预览环境：无 IPC' }; return }
      const r = activePlatTab.value === 'ComfyUI'
        ? await t.platform.testComfyui()
        : await t.platform.testRunninghub()
      testResult.value = r || { ok: false, message: '测试失败' }
    } catch (e) {
      testResult.value = { ok: false, message: `测试失败：${String((e as any)?.message || e)}` }
    } finally {
      testBusy.value = false
    }
  }

  /* ── S9 系统与运行 ───────────────────────────────────────── */
  const autoStart = ref(false)
  const autoStartLoading = ref(false)
  const cacheDir = ref('')
  const lutList = ref<LutEntry[]>([])
  const sysInfoRows = ref<Array<{ label: string; value: string }>>([])
  const sysInfoLoading = ref(false)

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
    const d = Array.isArray(r?.filePaths) ? r.filePaths[0] : (r?.filePaths ?? r?.path)
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
    await loadPlatformCfg()
    await loadAutoStart()
    cacheDir.value = String((await readCfg(CACHE_DIR_KEY, '')) || '')
    await loadLuts()
    void loadSysInfo()
  }

  return {
    // S8
    PLATFORM_TABS,
    activePlatTab,
    workflowId,
    comfyuiHost,
    comfyuiPort,
    rhApiKeyInput,
    rhApiKeyMasked,
    rhBaseUrl,
    rhUsePersonalQueue,
    saving,
    hint,
    testBusy,
    testResult,
    savePlatform,
    testPlatform,
    // S9
    autoStart,
    autoStartLoading,
    toggleAutoStart,
    cacheDir,
    pickCacheDir,
    lutList,
    addLut,
    removeLut,
    sysInfoRows,
    sysInfoLoading,
    loadSysInfo,
    loadIntegrationCfg,
  }
}
