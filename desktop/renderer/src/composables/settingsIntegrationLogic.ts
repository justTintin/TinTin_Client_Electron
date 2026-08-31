// ═══════════════════════════════════════════════════════════════
// settingsIntegrationLogic — 系统与运行（S9）编组纯函数
// （无 vue/IPC 依赖，可单测；业务动作在 useSettingsIntegration.ts）
//
// 2026-08-30 用户裁决：S8 平台接入（数字人/ComfyUI/RunningHub 直连配置）
//   整体移除——三者均已通过统一服务端接入，原客户端已删除直连配置。
//
// S9 系统与运行（对照原 L1479-1562 账号页 / L1931-2040 自启动+缓存目录 /
//   L2041-2120 LUT 配置）：
//   · 自启动：app.setLoginItemSettings（托盘 tray.js 已有同款，设置页补齐入口）
//   · 缓存目录：原 local_config.cache_dir（outputs 目录可自定义）→ local.cacheDir
//   · LUT：原 video_config 下 name → path 映射（.cube/.3dl/.lut，L2041-2120），
//     作用=智能混剪镜头重组时可选应用调色还原；新端存 video.lutMap（app 域）
//   · 系统信息：原账号页系统信息 Tab（os/cpu/ram/gpu）→ 新端 env:detectEnv
//     local 资源（os/cpu/ram/disk；gpu 弃检，见 env-detect.js 头注）
// ═══════════════════════════════════════════════════════════════

/* ── S9 缓存目录 / LUT / 系统信息 ──────────────────────────── */

/** 缓存目录配置键（对齐原 local_config.cache_dir 语义，存 config app 域） */
export const CACHE_DIR_KEY = 'local.cacheDir'

/**
 * 下载默认路径拼接（缓存目录消费端，对齐原 aigen L1044 语义：
 * cache_dir 优先、空则用系统默认位置）。
 * dir 非空 → 「目录/文件名」（统一 / 分隔，Windows 保存对话框两种分隔符均接受）；
 * dir 为空 / 文件名为空 → 原文件名原样返回（保存对话框默认位置）。
 */
export function joinDefaultPath(dir: string, fileName: string): string {
  const d = String(dir || '').trim().replace(/\\/g, '/').replace(/\/+$/, '')
  const n = String(fileName || '').trim()
  return d && n ? `${d}/${n}` : n
}

/** LUT 支持格式（对齐原 L2048：.cube / .3dl / .lut） */
export const LUT_EXTS = ['.cube', '.3dl', '.lut']

/** LUT 文件名校验（''=通过） */
export function validateLutName(name: string): string {
  if (!String(name || '').trim()) return '请输入 LUT 显示名称'
  return ''
}

/** 文件名 → 默认 LUT 显示名（去扩展名，对齐原 _add_lut_entry L2099） */
export function normalizeLutName(fileName: string): string {
  const base = String(fileName || '').replace(/\\/g, '/').split('/').pop() || ''
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(0, dot) : base
}

/**
 * 系统信息展示行（原账号页系统信息 Tab：os/cpu/ram/gpu/python/cuda；
 * 新端无 Python，gpu 弃检 → os/cpu/ram/disk 四行，数据源 env:detectEnv local）
 */
export function buildSysInfoRows(
  local: { os?: string; cpu?: string; ramGb?: number; disk?: { freeGb: number; totalGb: number } | null } | null,
): Array<{ label: string; value: string }> {
  if (!local) return [
    { label: '系统信息', value: '未检测（预览环境无 IPC 或检测失败）' },
  ]
  const rows: Array<{ label: string; value: string }> = []
  rows.push({ label: '操作系统', value: String(local.os || '未知') })
  rows.push({ label: '处理器', value: String(local.cpu || '未知') })
  rows.push({ label: '内存', value: typeof local.ramGb === 'number' ? `${local.ramGb} GB` : '未知' })
  rows.push({
    label: '磁盘可用空间',
    value: local.disk && typeof local.disk.freeGb === 'number'
      ? `${local.disk.freeGb} GB 可用 / 共 ${local.disk.totalGb} GB`
      : '未知',
  })
  return rows
}
