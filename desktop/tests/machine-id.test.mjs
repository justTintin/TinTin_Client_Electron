// ═══════════════════════════════════════════════════════════════
// machine-id.test.mjs — machine-id.js 稳定派生单测（W11 双入口一致性）
// 基准：studio/utils/license.py get_machine_id L44-72（2026-08-30 对齐：
// seed = "mac:{12位hex}|host:{hostname}|cpu:{processor}"，SHA256 前 16 位
// 小写；hostname/cpu 原样，platform/machineGuid 不参与）；口径与渲染层
// machineCodeLogic.buildMachineSeed 一致。
// 覆盖：deriveMachineId 稳定性/空信息；resolveMachineIdSync 缓存复用
// （不重复派生/不写回）+ 首次派生写回（幂等）。
// 运行：node --test "tests/*.test.mjs"
// ═══════════════════════════════════════════════════════════════

import { test } from 'node:test'
import assert from 'node:assert/strict'

const R = await import('../main/machine-id.js')

test('deriveMachineId：SHA256 前 16 位小写 hex，同输入稳定', () => {
  const info = { hostname: 'PC-01', platform: 'win32', machineGuid: 'ABC-123', mac: 'AA:BB:CC:DD:EE:FF', cpu: 'Intel64 Family 6' }
  const a = R.deriveMachineId(info)
  const b = R.deriveMachineId(info)
  assert.equal(a, b)
  assert.equal(a.length, 16)
  assert.match(a, /^[0-9a-f]{16}$/)
  // mac 大小写/分隔符归一后同值；platform/machineGuid 不参与派生（原版无此二段）
  assert.equal(R.deriveMachineId({ ...info, mac: 'aabbccddeeff' }), a)
  assert.equal(R.deriveMachineId({ ...info, platform: 'linux', machineGuid: 'other' }), a)
  // hostname/cpu 原样参与（原版未归一大小写）→ 变更即变码
  assert.notEqual(R.deriveMachineId({ ...info, hostname: 'pc-01' }), a)
  assert.notEqual(R.deriveMachineId({ ...info, cpu: 'AMD64' }), a)
})

test('deriveMachineId：空信息返回空串（无稳定种子不臆造）', () => {
  assert.equal(R.deriveMachineId({}), '')
  assert.equal(R.deriveMachineId(null), '')
})

test('resolveMachineIdSync：有缓存直接复用（不派生、不写回）', () => {
  let setCalls = 0
  const store = {
    get: (k) => (k === R.MACHINE_ID_KEY ? 'cached-mid-1234567890abcdef' : null),
    set: () => { setCalls += 1 },
  }
  assert.equal(R.resolveMachineIdSync({ store }), 'cached-mid-1234567890abcdef')
  assert.equal(R.MACHINE_ID_KEY, 'machineIdV2')
  assert.equal(setCalls, 0)
})

test('resolveMachineIdSync：无缓存派生并写回；重启后读缓存同值（幂等）', () => {
  let saved = null
  const store = {
    get: () => null,
    set: (_k, v) => { saved = v },
  }
  const collect = () => ({ hostname: 'pc-a', platform: 'win32', machineGuid: 'G-1', mac: 'aabbccddeeff' })
  const a = R.resolveMachineIdSync({ store, collect })
  assert.equal(a.length, 16)
  assert.match(a, /^[0-9a-f]{16}$/)
  assert.equal(saved, a)
  // 二次调用模拟重启后：store 已有缓存 → 复用同一值（不重新派生）
  const store2 = { get: () => saved, set: () => {} }
  assert.equal(R.resolveMachineIdSync({ store: store2 }), a)
})

test('resolveMachineIdSync：store 缺失时返回派生值不抛错', () => {
  const mid = R.resolveMachineIdSync({ store: null, collect: () => ({ hostname: 'pc-b', platform: 'linux' }) })
  assert.equal(mid.length, 16)
  assert.match(mid, /^[0-9a-f]{16}$/)
})

test('collectMachineInfoSync：返回 hostname/platform/mac/cpu 字段（win32 含 machineGuid）', () => {
  const info = R.collectMachineInfoSync()
  assert.equal(typeof info.hostname, 'string')
  assert.ok(info.hostname.length > 0)
  assert.equal(typeof info.platform, 'string')
  assert.equal(typeof info.mac, 'string')
  assert.equal(typeof info.cpu, 'string')
  assert.equal(typeof info.machineGuid, 'string')
  // 派生结果可被 deriveMachineId 消费（16 位 hex 或空串）
  const mid = R.deriveMachineId(info)
  assert.ok(mid === '' || /^[0-9a-f]{16}$/.test(mid))
})
