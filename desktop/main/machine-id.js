// ═══════════════════════════════════════════════════════════════
// machine-id.js — 稳定 machine_id 派生（共享纯函数 + 同步采集）
//
// 口径统一（W11 双入口一致性）：
//   · server-proxy.js getMachineId（X-Machine-ID 请求头）
//   · client-task-thread.js resolveMachineId（任务领取归属）
// 两处共用本模块：config-store 'machineId' 缓存优先（跨重启稳定），
// 无则按本机信息派生 SHA256 前 16 位并写回（幂等）。任一入口先注册
// 后，另一入口直接复用同一值（agent 会话隔离一致）。
// 对照原版 studio/utils/license.py get_machine_id L44-71（种子口径与
// 渲染层 machineCodeLogic.buildMachineSeed 一致：hostname|platform|
// MachineGuid|mac 归一后 SHA256 前 16 位小写 hex）。
// ═══════════════════════════════════════════════════════════════
const crypto = require('node:crypto')
const os = require('node:os')
const { execFileSync } = require('node:child_process')

/** config-store 缓存键（与 client-task-thread.js resolveMachineId 同键） */
const MACHINE_ID_KEY = 'machineId'

/**
 * machine_id 派生（纯函数，同输入恒同输出；无稳定种子返回空串不臆造）。
 * 输入 info 归一：hostname/platform/machineGuid 小写、mac 去冒号小写。
 */
function deriveMachineId(info) {
  const hostname = String((info && info.hostname) || '').trim().toLowerCase()
  const platform = String((info && info.platform) || '').trim().toLowerCase()
  const guid = String((info && info.machineGuid) || '').trim().toLowerCase()
  const mac = String((info && info.mac) || '').replace(/[:-]/g, '').trim().toLowerCase()
  if (!hostname && !guid && !mac) return ''
  const seed = `${hostname}|${platform}|${guid}|${mac}`
  return crypto.createHash('sha256').update(seed, 'utf-8').digest('hex').slice(0, 16)
}

/**
 * 同步采集本机机器码原始信息（server-proxy getMachineId 同步场景用；
 * win32 同步读注册表 MachineGuid）。与 client-task-thread.collectMachineInfo
 * 同口径，仅 MachineGuid 由异步 execFile 换为同步 execFileSync。
 */
function collectMachineInfoSync() {
  const info = { hostname: os.hostname(), platform: os.platform(), machineGuid: '', mac: '', source: 'sync' }
  try {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const ni of list || []) {
        if (ni && !ni.internal && ni.mac && ni.mac !== '00:00:00:00:00:00') { info.mac = ni.mac; break }
      }
      if (info.mac) break
    }
  } catch (_) {}
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
