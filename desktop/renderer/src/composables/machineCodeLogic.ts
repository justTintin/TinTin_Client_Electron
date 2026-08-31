// ═══════════════════════════════════════════════════════════════
// machineCodeLogic — 本机机器码纯函数（无 vue / IPC 依赖，可单测）
// 2026-08-30 用户裁决：算法严格对齐原版 studio/utils/license.py
// get_machine_id L44-72——seed = "mac:{12位hex}|host:{hostname}|cpu:{processor}"
// （Windows 无 dmidecode uuid 段），SHA256 前 16 位 hex 小写、原样展示
// （不分组不大写，与原客户端关于页一致，服务端按 machine_id 隔离）。
// 链路：主进程 env:getMachineInfo 采集（hostname/mac/cpu）→ 本模块拼接
// → SHA-256。hostname/cpu 保持原样（原版未归一），mac 归一 12 位小写 hex。
// ═══════════════════════════════════════════════════════════════

/** 主进程 env:getMachineInfo 返回的原始系统信息（platform/machineGuid 采集但已不参与派生） */
export interface MachineInfoInput {
  hostname: string
  platform?: string
  machineGuid?: string
  mac: string
  cpu?: string
  source?: string
}

/** 规范化拼接机器码种子（原版口径）：mac 去分隔符 12 位小写 hex，hostname/cpu 原样 */
export function buildMachineSeed(info: Partial<MachineInfoInput> | null | undefined): string {
  const mac = String(info?.mac || '').replace(/[^0-9a-fA-F]/g, '').toLowerCase()
  const hostname = String(info?.hostname || '').trim()
  const cpu = String(info?.cpu || '').trim()
  return `mac:${mac}|host:${hostname}|cpu:${cpu}`
}

/** 机器码主入口：系统信息 → SHA-256 前 16 位 hex 小写（WebCrypto，Node/Electron 均可用） */
export async function formatMachineCode(info: Partial<MachineInfoInput> | null | undefined): Promise<string> {
  const seed = buildMachineSeed(info)
  const buf = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(seed))
  const hex = Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('')
  return hex.slice(0, 16)
}
