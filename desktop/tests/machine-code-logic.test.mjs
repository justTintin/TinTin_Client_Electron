// ═══════════════════════════════════════════════════════════════
// machine-code-logic.test.mjs — 关于卡·本机机器码纯函数单测
// 被测：renderer/src/composables/machineCodeLogic.ts（纯函数，无 vue/IPC 依赖）
// 口径：buildMachineSeed 规范化拼接 → SHA-256 → 前 16 位 hex 大写 →
//       XXXX-XXXX-XXXX-XXXX 分组；跨重启稳定（同输入同输出）。
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
  source: 'machine-guid'
}

/** 与实现同口径的独立参照实现（node:crypto），用于校验 SHA-256 摘要正确性 */
function expectedCode(info) {
  const seed = C.buildMachineSeed(info)
  const hex = createHash('sha256').update(seed, 'utf8').digest('hex')
  const up = hex.slice(0, 16).toUpperCase().padEnd(16, '0')
  return [up.slice(0, 4), up.slice(4, 8), up.slice(8, 12), up.slice(12, 16)].join('-')
}

/* ── buildMachineSeed：规范化拼接 ─────────────────────────── */

test('buildMachineSeed：mac 去冒号/连字符小写，hostname 小写，固定 4 字段分隔', () => {
  assert.equal(C.buildMachineSeed(INFO), 'desktop-abc123|win32|88888888-4444-4444-4444-cccccccccccc|aabbccddeeff')
})

test('buildMachineSeed：null/undefined → 全空位（三个分隔符，不抛错）', () => {
  assert.equal(C.buildMachineSeed(null), '|||')
  assert.equal(C.buildMachineSeed(undefined), '|||')
})

test('buildMachineSeed：字段缺失保留分隔位（拼接稳定 = 同 seed）', () => {
  const onlyGuid = C.buildMachineSeed({ machineGuid: 'G-1', hostname: 'h', platform: 'win32', mac: '' })
  const manual = C.buildMachineSeed({ hostname: 'h', platform: 'win32', machineGuid: 'G-1', mac: '' })
  assert.equal(onlyGuid, manual)
  assert.match(onlyGuid, /win32\|g-1\|$/)
})

/* ── groupHex16：格式化 ───────────────────────────────────── */

test('groupHex16：16 位 hex → 4×4 大写分组 XXXX-XXXX-XXXX-XXXX', () => {
  assert.equal(C.groupHex16('0123456789abcdef'), '0123-4567-89AB-CDEF')
  assert.equal(C.groupHex16('abcdef0123456789'), 'ABCD-EF01-2345-6789')
})

test('groupHex16：非 hex 字符剔除、短输入右侧 0 补位、非法输入全 0', () => {
  assert.equal(C.groupHex16('abcd-ef01'), 'ABCD-EF01-0000-0000')
  assert.equal(C.groupHex16('xyz'), '0000-0000-0000-0000')
  assert.equal(C.groupHex16(''), '0000-0000-0000-0000')
  // 超长截断到 16 位
  assert.equal(C.groupHex16('1234567890abcdef99'), '1234-5678-90AB-CDEF')
})

/* ── formatMachineCode：主入口（SHA-256 摘要 + 分组） ─────── */

test('formatMachineCode：与 node:crypto 参照实现一致（SHA-256 前 16 位大写分组）', async () => {
  const got = await C.formatMachineCode(INFO)
  assert.equal(got, expectedCode(INFO))
  assert.match(got, /^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/)
})

test('formatMachineCode：确定性——同输入同输出（跨重启稳定口径）', async () => {
  const a = await C.formatMachineCode(INFO)
  const b = await C.formatMachineCode({ ...INFO })
  assert.equal(a, b)
})

test('formatMachineCode：不同机器信息 → 不同机器码', async () => {
  const a = await C.formatMachineCode(INFO)
  const b = await C.formatMachineCode({ ...INFO, machineGuid: 'other-guid' })
  assert.notEqual(a, b)
})

test('formatMachineCode：空信息也能出格式合法的机器码（全空 seed 兜底）', async () => {
  const got = await C.formatMachineCode(null)
  assert.match(got, /^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/)
  assert.equal(got, expectedCode(null))
})
