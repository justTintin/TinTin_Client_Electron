// ═══════════════════════════════════════════════════════════════
// machine-id.js — 稳定 machine_id 派生（共享纯函数 + 同步采集）
//
// 口径统一（W11 双入口一致性）：
//   · server-proxy.js getMachineId（X-Machine-ID 请求头）
//   · client-task-thread.js resolveMachineId（任务领取归属）
// 两处共用本模块：config-store 'machineId' 缓存优先（跨重启稳定），
// 无则按本机信息派生并写回（幂等）。任一入口先注册后，另一入口
// 直接复用同一值（agent 会话隔离一致）。
// 2026-08-30 用户裁决：算法严格对齐原版 studio/utils/license.py
// get_machine_id L44-72——seed = "mac:{12位hex}|host:{hostname}|cpu:{processor}"
// （Windows 无 dmidecode uuid 段），SHA256 前 16 位小写 hex。
// 与渲染层 machineCodeLogic.buildMachineSeed 同口径（展示=原样 16 位）。
// 注意：hostname/cpu 保持原样大小写（原版 socket.gethostname /
// platform.processor 未做归一），mac 归一 12 位小写 hex。
// ═══════════════════════════════════════════════════════════════
const crypto = require('node:crypto')
const os = require('node:os')
const { execFileSync } = require('node:child_process')

/** config-store 缓存键（与 client-task-thread.js / server-proxy.js 同键）。
 *  V2：2026-08-30 算法对齐原版 license.py 后换键——旧 'machineId' 是旧口径
 *  派生值，继续复用会导致展示机器码与注册 ID 永久不一致，故弃用旧键。 */
const MACHINE_ID_KEY = 'machineIdV2'

/**
 * machine_id 派生（纯函数，同输入恒同输出；无稳定种子返回空串不臆造）。
 * 对齐原版 license.py：mac 归一 12 位小写 hex（等价 f"{mac:012x}"），
 * hostname/cpu 原样（原版未归一），Windows 恒无 uuid 段。
 */
function deriveMachineId(info) {
  const mac = String((info && info.mac) || '').replace(/[^0-9a-fA-F]/g, '').toLowerCase()
  const hostname = String((info && info.hostname) || '').trim()
  const cpu = String((info && info.cpu) || '').trim()
  if (!mac && !hostname && !cpu) return ''
  const seed = `mac:${mac}|host:${hostname}|cpu:${cpu}`
  return crypto.createHash('sha256').update(seed, 'utf-8').digest('hex').slice(0, 16)
}

/**
 * 同步采集本机机器码原始信息（server-proxy getMachineId 同步场景用；
 * win32 同步读注册表 MachineGuid）。与 client-task-thread.collectMachineInfo
 * 同口径，仅 MachineGuid 由异步 execFile 换为同步 execFileSync。
 * cpu 对齐原版 platform.processor()（Windows = PROCESSOR_IDENTIFIER）。
 */
function collectMachineInfoSync() {
  const info = { hostname: os.hostname(), platform: os.platform(), machineGuid: '', mac: '', cpu: '', source: 'sync' }
  try {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const ni of list || []) {
        if (ni && !ni.internal && ni.mac && ni.mac !== '00:00:00:00:00:00') { info.mac = ni.mac; break }
      }
      if (info.mac) break
    }
  } catch (_) {}
  info.cpu = String(process.env.PROCESSOR_IDENTIFIER || '').trim()
  if (process.platform === 'win32') {
    try {
      const out = execFileSync('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'],
        { timeout: 3000, encoding: 'utf8' })
      const m = String(out).match(/MachineGuid\s+REG_SZ\s+(\S+)/i)
      info.machineGuid = m ? m[1] : ''
    } catch (_) {}
  }
  return info
}

/**
 * 幂等解析稳定 machine_id：config-store 'machineId' 缓存优先（复用
 * 既有注册值）；无则同步采集派生并写回缓存。store 缺失时仅返回派生值
 * （进程内 getMachineId 自缓存，不落盘）。
 */
function resolveMachineIdSync({ store, collect = collectMachineInfoSync }) {
  try {
    const cached = store && typeof store.get === 'function' ? store.get(MACHINE_ID_KEY) : null
    if (cached) return String(cached)
  } catch (_) {}
  const mid = deriveMachineId(collect())
  if (mid && store && typeof store.set === 'function') {
    try { store.set(MACHINE_ID_KEY, mid) } catch (_) {}
  }
  return mid
}

module.exports = {
  MACHINE_ID_KEY,
  deriveMachineId,
  collectMachineInfoSync,
  resolveMachineIdSync,
}
