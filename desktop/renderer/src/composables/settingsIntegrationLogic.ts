// ═══════════════════════════════════════════════════════════════
// settingsIntegrationLogic — 平台接入（S8）+ 系统与运行（S9）编组纯函数
// （无 vue/IPC 依赖，可单测；业务动作在 useSettingsIntegration.ts）
//
// S8 平台接入（对照原客户端 main_window_pages.py L990-1245 数字人 Tab）：
//   · ComfyUI：服务端 PUT /comfyui/config {host, port}（openapi ComfyUIConfig
//     schema：host 默认 127.0.0.1 / port 默认 8188）；测试 GET /comfyui/status
//   · RunningHub：服务端 PUT /runninghub/config（api_key/base_url/
//     use_personal_queue 等，openapi L990-1245 对应字段）；测试 GET /runninghub/status
//   · 数字人：无独立配置接口（/digital-human/batch 提交时 workflow_id 默认
//     2085292185062297602）→ workflowId 存本地 config integration 域
//   · 凭据脱敏：api_key 保存后 UI 只显示尾 4 位（maskKey）
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

/* ── S8 平台接入 ───────────────────────────────────────────── */

/** 平台 Tab 顺序（对齐原版 backend_selector：全部/ComfyUI/RunningHub 语义） */
export const PLATFORM_TABS = ['数字人', 'ComfyUI', 'RunningHub'] as const

/** ComfyUI 配置默认值（openapi ComfyUIConfig schema：host 127.0.0.1 / port 8188） */
export const COMFYUI_DEFAULTS = { host: '127.0.0.1', port: 8188 }

/**
 * 凭据脱敏展示（对齐飞书 maskSecret 语义：保存后只显示尾 4 位）
 */
export function maskKey(v: string): string {
  if (!v) return ''
  if (v.length <= 4) return '••••'
  return '••••' + v.slice(-4)
}

/** ComfyUI 配置校验（''=通过；对照原版表单校验语义） */
export function validateComfyui(host: string, port: number | string): string {
  const h = String(host || '').trim()
  if (!h) return '请填写 ComfyUI 地址（host）'
  const p = Number(port)
  if (!Number.isInteger(p) || p < 1 || p > 65535) return '端口应为 1~65535 的整数'
  return ''
}

/** RunningHub 配置校验（''=通过；base_url 缺省合法——服务端用默认） */
export function validateRunninghub(apiKey: string, baseUrl: string): string {
  const b = String(baseUrl || '').trim()
  if (b && !/^https?:\/\/.+/.test(b)) return 'base_url 应为 http(s)://host[:port]'
  // api_key 允许缺省（已保存过 / 服务端持有）：仅在有输入时校验格式
  const k = String(apiKey || '').trim()
  if (k && k.length < 8) return 'api_key 长度不应少于 8 位'
  return ''
}

/** 编组 ComfyUI 提交体（空字段跳过，服务端保留原值） */
export function buildComfyuiBody(host: string, port: number | string): Record<string, unknown> {
  const body: Record<string, unknown> = {}
  const h = String(host || '').trim()
  if (h) body.host = h
  const p = Number(port)
  if (Number.isInteger(p) && p > 0) body.port = p
  return body
}

/** 编组 RunningHub 提交体（空 api_key 跳过=保留已存值；布尔开关显式携带） */
export function buildRunninghubBody(
  apiKey: string,
  baseUrl: string,
  usePersonalQueue: boolean,
): Record<string, unknown> {
  const body: Record<string, unknown> = {}
  const k = String(apiKey || '').trim()
  if (k) body.api_key = k
  const b = String(baseUrl || '').trim()
  if (b) body.base_url = b
  body.use_personal_queue = !!usePersonalQueue
  return body
}

/** 平台状态响应判定（GET /comfyui/status、/runninghub/status；离线 null=fail） */
export function parsePlatformStatus(r: unknown, platform: string): { ok: boolean; message: string } {
  if (r === null || r === undefined) return { ok: false, message: `${platform} 服务端离线或不可达` }
  if (typeof r === 'object' && 'error' in (r as object)) {
    return { ok: false, message: `${platform} 查询失败：${String((r as any).error)}` }
  }
  // 在线判定：ComfyUI status 含 online/queue；RunningHub status 含连接信息。
  // 响应存在即视为端点可达（字段随服务端版本变化，不臆造强断言）
  return { ok: true, message: `${platform} 端点可达` }
}

/* ── S9 缓存目录 / LUT / 系统信息 ──────────────────────────── */

/** 缓存目录配置键（对齐原 local_config.cache_dir 语义，存 config app 域） */
export const CACHE_DIR_KEY = 'local.cacheDir'

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
