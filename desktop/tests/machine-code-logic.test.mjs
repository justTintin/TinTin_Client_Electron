// ═══════════════════════════════════════════════════════════════
// machine-code-logic.test.mjs — 关于卡·本机机器码纯函数单测
// 被测：renderer/src/composables/machineCodeLogic.ts（纯函数，无 vue/IPC 依赖）
// 口径（2026-08-30 对齐原版 license.py get_machine_id L44-72）：
//       seed = "mac:{12位hex}|host:{hostname}|cpu:{processor}" →
//       SHA-256 前 16 位 hex 小写原样展示（不分组不大写）。
// 运行：node --test "tests/*.test.mjs"
// ═══════════════════════════════════════════════════════════════

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

const C = await import('../renderer/src/composables/machineCodeLogic.ts')

const INFO = {
  hostname: 'DESKTOP-ABC123',
  platform: 'win32',
  machineGuid: '88888888-4444-4444-4444-CCCCCCCCCCCC',
  mac: 'AA-BB-CC-DD-EE-FF',
  cpu: 'Intel64 Family 6 Model 186 Stepping 2, GenuineIntel',
  source: 'machine-guid'
}

/** 与实现同口径的独立参照实现（node:crypto），用于校验 SHA-256 摘要正确性 */
function expectedCode(info) {
  const seed = C.buildMachineSeed(info)
  return createHash('sha256').update(seed, 'utf8').digest('hex').slice(0, 16)
}

/* ── buildMachineSeed：原版口径拼接 ─────────────────────────── */

test('buildMachineSeed：mac 归一 12 位小写 hex，hostname/cpu 原样（原版 seed 口径）', () => {
  assert.equal(
    C.buildMachineSeed(INFO),
    'mac:aabbccddeeff|host:DESKTOP-ABC123|cpu:Intel64 Family 6 Model 186 Stepping 2, GenuineIntel'
  )
})

test('buildMachineSeed：platform/machineGuid 不参与派生（原版无此二段）', () => {
  assert.equal(C.buildMachineSeed(INFO), C.buildMachineSeed({ ...INFO, platform: 'linux', machineGuid: 'other' }))
})

test('buildMachineSeed：null/undefined → 全空段（mac:|host:|cpu:，不抛错）', () => {
  assert.equal(C.buildMachineSeed(null), 'mac:|host:|cpu:')
  assert.equal(C.buildMachineSeed(undefined), 'mac:|host:|cpu:')
})

test('buildMachineSeed：mac 分隔符混排/大小写归一；hostname 大小写敏感（原版未归一）', () => {
  assert.equal(C.buildMachineSeed({ mac: 'aa:bb:cc:dd:ee:ff' }), C.buildMachineSeed({ mac: 'AA-BB-CC-DD-EE-FF' }))
  assert.notEqual(C.buildMachineSeed({ hostname: 'PC-01' }), C.buildMachineSeed({ hostname: 'pc-01' }))
  // cpu 两端空白 trim（采集侧可能带换行）
  assert.equal(C.buildMachineSeed({ cpu: '  x ' }), 'mac:|host:|cpu:x')
})

/* ── formatMachineCode：主入口（SHA-256 前 16 位小写原样） ─── */

test('formatMachineCode：与 node:crypto 参照实现一致（SHA-256 前 16 位小写）', async () => {
  const got = await C.formatMachineCode(INFO)
  assert.equal(got, expectedCode(INFO))
  assert.match(got, /^[0-9a-f]{16}$/)
})

test('formatMachineCode：确定性——同输入同输出（跨重启稳定口径）', async () => {
  const a = await C.formatMachineCode(INFO)
  const b = await C.formatMachineCode({ ...INFO })
  assert.equal(a, b)
})

test('formatMachineCode：不同机器信息 → 不同机器码（cpu/hostname 各自参与差异）', async () => {
  const a = await C.formatMachineCode(INFO)
  const b = await C.formatMachineCode({ ...INFO, cpu: 'AMD64 Family 25 Model 33 Stepping 2, AuthenticAMD' })
  const c = await C.formatMachineCode({ ...INFO, hostname: 'OTHER-HOST' })
  assert.notEqual(a, b)
  assert.notEqual(a, c)
})

test('formatMachineCode：空信息也能出格式合法的机器码（全空 seed 兜底）', async () => {
  const got = await C.formatMachineCode(null)
  assert.match(got, /^[0-9a-f]{16}$/)
  assert.equal(got, expectedCode(null))
})
