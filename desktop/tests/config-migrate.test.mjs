// ═══════════════════════════════════════════════════════════════
// config-migrate 单测 — ext.* 废弃键清理（P3 遗留闭环，IRON-04/10）
// 运行：node --test tests/config-migrate.test.mjs
// ═══════════════════════════════════════════════════════════════
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { DEPRECATED_EXT_KEYS, KEPT_EXT_KEYS, purgeDeprecatedExtKeys } = require('../main/config-migrate.js')

/** 内存 store（模拟 electron-store 接口） */
function makeStore(initial = {}) {
  const m = new Map(Object.entries(initial))
  return {
    get: (k, d) => (m.has(k) ? m.get(k) : d),
    set: (k, v) => m.set(k, v),
    delete: (k) => m.delete(k),
    has: (k) => m.has(k),
  }
}

test('purgeDeprecatedExtKeys 删除全部 6 个废弃键并返回删除清单', () => {
  const store = makeStore({
    'ext.bridgePort': '8123',
    'ext.bridgeSaveDir': 'D:\\TinTin\\collected',
    'ext.scanServer': true,
    'ext.chromePort': '9222',
    'ext.chromePath': 'C:\\chrome.exe',
    'ext.chromeDataDir': 'C:\\chrome-data',
  })
  const removed = purgeDeprecatedExtKeys(store)
  assert.equal(removed.length, 6)
  for (const k of DEPRECATED_EXT_KEYS) assert.equal(store.has(k), false, `${k} 应被删除`)
})

test('ext.shopKeyword 保留不被误删（自动上架面板仍使用）', () => {
  const store = makeStore({ 'ext.shopKeyword': '桔柚' })
  const removed = purgeDeprecatedExtKeys(store)
  assert.equal(removed.length, 0)
  assert.equal(store.get('ext.shopKeyword'), '桔柚')
  assert.ok(!KEPT_EXT_KEYS.some((k) => DEPRECATED_EXT_KEYS.includes(k)), '保留键与废弃键不得重叠')
})

test('幂等：已清理的 store 再次执行零删除', () => {
  const store = makeStore({ 'ext.chromePort': '9222', 'ext.shopKeyword': 'k' })
  purgeDeprecatedExtKeys(store)
  const second = purgeDeprecatedExtKeys(store)
  assert.deepEqual(second, [])
})

test('空 store / 非法入参不抛错', () => {
  assert.deepEqual(purgeDeprecatedExtKeys(makeStore()), [])
  assert.deepEqual(purgeDeprecatedExtKeys(null), [])
  assert.deepEqual(purgeDeprecatedExtKeys({}), [])
})
