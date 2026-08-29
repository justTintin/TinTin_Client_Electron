// ═══════════════════════════════════════════════════════════════
// envCheckLogic — 条目⑪ 环境检测编组纯函数（无副作用，可单测）
// 原客户端 gui/env_config_page.py check_environment L412-513 的检测矩阵
// 在新客户端（无 Python）重定义口径：
//   1. 服务端连通    ← env:serverPing（原 OCR/voxcpm 连通检测 L480-493 泛化）
//   2. 服务端能力健康 ← server.healthCapabilities（/health/capabilities）
//   3. FFmpeg        ← 原 L438-461（新端 resources/bin 随包分发，验证存在性）
//   4. 磁盘可用空间  ← 新增轻量项（<5GB warn 预警下载/混剪缓存）
//   5. 系统资源      ← 原 L495-510 的 os/cpu/ram 保留，gpu 弃（报告说明）
// 行状态：ok / warn / bad / unknown（unknown=检测本身失败，不误报业务失败）。
// ═══════════════════════════════════════════════════════════════

export type EnvCheckState = 'ok' | 'warn' | 'bad' | 'unknown'

export interface EnvCheckRow {
  label: string
  state: EnvCheckState
  detail: string
}

/** 主进程 env:detectEnv 返回（main/env-detect.js detectLocalResources 结构） */
export interface EnvLocalResources {
  ffmpeg: { ok: boolean; path: string }
  os: string
  cpu: string
  ramGb: number
  disk: { freeGb: number; totalGb: number } | null
}

export interface EnvDetectReport {
  server: { online: boolean; url?: string; latencyMs?: number; status?: number } | null
  local: EnvLocalResources | null
}

/** /health/capabilities 响应（12 能力布尔开关；null=离线静默；{error}=5xx/业务错误） */
export interface CapsResponse {
  capabilities?: Record<string, { enabled?: boolean }>
  error?: string
}

/** 能力注册表展示顺序（对齐 stores/server.ts ServerCapabilities 12 键） */
export const CAP_KEYS = [
  'rembg', 'vsr', 'vsr_remove', 'whisper', 'voice_clone', 'stock_search',
  'reverse_prompt', 'llm', 'asr', 'digital_human', 'montage', 'ocr',
] as const

/** 磁盘低容量预警阈值（GB） */
export const DISK_WARN_FREE_GB = 5

/**
 * 编组环境检测报告 → 展示行
 * @param report env:detectEnv（server ping + local 资源）；report.local=null → 本地行 unknown
 * @param caps   healthCapabilities 响应；null=离线；{error}=服务端业务错误（5xx 透出）
 */
export function groupEnvReport(
  report: EnvDetectReport | null,
  caps: CapsResponse | null | undefined,
): EnvCheckRow[] {
  const rows: EnvCheckRow[] = []
  const ping = report?.server ?? null
  const local = report?.local ?? null

  // 1. 服务端连通（在线判定单一真相源 = env:serverPing）
  if (ping?.online) {
    rows.push({
      label: '服务端连通',
      state: 'ok',
      detail: `${ping.url || ''} · ${typeof ping.latencyMs === 'number' ? `${ping.latencyMs}ms` : '运行中'}`,
    })
  } else {
    rows.push({ label: '服务端连通', state: 'bad', detail: `${ping?.url || '服务端'} · 离线或不可达` })
  }

  // 2. 服务端功能能力（/health/capabilities 12 键布尔）
  if (caps && typeof caps === 'object' && !caps.error) {
    const enabled = CAP_KEYS.filter((k) => !!caps.capabilities?.[k]?.enabled)
    const disabled = CAP_KEYS.filter((k) => !caps.capabilities?.[k]?.enabled)
    if (enabled.length === CAP_KEYS.length) {
      rows.push({ label: '服务端功能能力', state: 'ok', detail: `12/12 可用` })
    } else if (enabled.length > 0) {
      rows.push({
        label: '服务端功能能力',
        state: 'warn',
        detail: `${enabled.length}/${CAP_KEYS.length} 可用 · 禁用：${disabled.join(', ')}`,
      })
    } else {
      rows.push({ label: '服务端功能能力', state: 'warn', detail: `0/12 可用（能力清单为空）` })
    }
  } else if (caps && typeof caps === 'object' && caps.error) {
    rows.push({ label: '服务端功能能力', state: 'bad', detail: String(caps.error) })
  } else {
    rows.push({ label: '服务端功能能力', state: 'bad', detail: '服务端离线' })
  }

  // 3. FFmpeg（原 L438-461 语义：未找到 = bad，给下载/混剪功能预警）
  if (local) {
    rows.push(
      local.ffmpeg.ok
        ? { label: 'FFmpeg', state: 'ok', detail: local.ffmpeg.path }
        : { label: 'FFmpeg', state: 'bad', detail: '未检测到 ffmpeg.exe（应随包分发 resources/bin/）' },
    )
  } else {
    rows.push({ label: 'FFmpeg', state: 'unknown', detail: '本地资源检测失败' })
  }

  // 4. 磁盘可用空间（statPath 所在卷；<5GB warn）
  if (local) {
    if (local.disk && typeof local.disk.freeGb === 'number') {
      rows.push(
        local.disk.freeGb < DISK_WARN_FREE_GB
          ? { label: '磁盘可用空间', state: 'warn', detail: `${local.disk.freeGb} GB 可用 / 共 ${local.disk.totalGb} GB（空间不足，可能影响下载与缓存）` }
          : { label: '磁盘可用空间', state: 'ok', detail: `${local.disk.freeGb} GB 可用 / 共 ${local.disk.totalGb} GB` },
      )
    } else {
      rows.push({ label: '磁盘可用空间', state: 'unknown', detail: '无法获取磁盘信息' })
    }
  } else {
    rows.push({ label: '磁盘可用空间', state: 'unknown', detail: '本地资源检测失败' })
  }

  // 5. 系统资源（原 L499-502 os/cpu/ram 轻量项）
  if (local) {
    rows.push({
      label: '系统资源',
      state: 'ok',
      detail: `${local.os || '未知'} · ${local.cpu || '未知'} · 内存 ${local.ramGb || '?'} GB`,
    })
  } else {
    rows.push({ label: '系统资源', state: 'unknown', detail: '本地资源检测失败' })
  }

  return rows
}
