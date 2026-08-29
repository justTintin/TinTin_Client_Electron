// ═══════════════════════════════════════════════════════════════
// machineCodeLogic — 本机机器码纯函数（无 vue / IPC 依赖，可单测）
// 链路：主进程 env:getMachineInfo 采集原始系统信息（hostname/platform/
// Windows MachineGuid/网卡 MAC）→ 本模块规范化拼接 → SHA-256 →
// 取前 16 位 hex 大写 → 4×4 分组 XXXX-XXXX-XXXX-XXXX。
// 字段缺失按空位跳值保留分隔符（拼接稳定 = 机器码跨重启稳定）。
// ═══════════════════════════════════════════════════════════════

/** 主进程 env:getMachineInfo 返回的原始系统信息 */
export interface MachineInfoInput {
  hostname: string
  platform: string
  machineGuid: string
  mac: string
  source?: string
}

/** 规范化拼接机器码种子：mac 去冒号小写、hostname 小写、空字段保留分隔位 */
export function buildMachineSeed(info: Partial<MachineInfoInput> | null | undefined): string {
  const hostname = String(info?.hostname || '').trim().toLowerCase()
  const platform = String(info?.platform || '').trim().toLowerCase()
  const guid = String(info?.machineGuid || '').trim().toLowerCase()
  const mac = String(info?.mac || '').replace(/[:-]/g, '').trim().toLowerCase()
  return `${hostname}|${platform}|${guid}|${mac}`
}

/** 16 位 hex 大写 → XXXX-XXXX-XXXX-XXXX（不足 4 位组以 0 补位） */
export function groupHex16(hex: string): string {
  const up = String(hex || '').replace(/[^0-9a-fA-F]/g, '').toUpperCase().slice(0, 16).padEnd(16, '0')
  return [up.slice(0, 4), up.slice(4, 8), up.slice(8, 12), up.slice(12, 16)].join('-')
}

/** 机器码主入口：系统信息 → SHA-256 前 16 位大写分组（WebCrypto，Node/Electron 均可用） */
export async function formatMachineCode(info: Partial<MachineInfoInput> | null | undefined): Promise<string> {
  const seed = buildMachineSeed(info)
  const buf = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(seed))
  const hex = Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('')
  return groupHex16(hex.slice(0, 16))
}
