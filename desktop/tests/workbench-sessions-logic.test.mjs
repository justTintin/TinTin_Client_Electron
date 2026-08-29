// ═══════════════════════════════════════════════════════════════
// workbench-sessions-logic.test.mjs — W7 多会话补全·纯函数单测
// 被测：renderer/src/composables/workbenchChatLogic.ts（无 vue 依赖，
// Node ≥22.18 原生 type stripping 直接加载）
// 覆盖：会话删除（本地移除 + 服务端 session_id 联动）、重命名（规范化 +
// 更新时间刷新）、切换时各会话独立 serverSessionId 绑定。
// 运行：node --test "tests/*.test.mjs"
// ═══════════════════════════════════════════════════════════════

import { test } from 'node:test'
import assert from 'node:assert/strict'

const L = await import('../renderer/src/composables/workbenchChatLogic.ts')

/** 构造一个持久化会话条目（serverSessionId 默认绑定服务端会话） */
function mk(id, opts = {}) {
  return {
    id,
    title: opts.title ?? `会话${id}`,
    subtitle: opts.subtitle ?? '',
    updatedAt: opts.updatedAt ?? 1000,
    serverSessionId: opts.serverSessionId ?? `srv-${id}`,
    mode: opts.mode ?? 'agent',
    messages: opts.messages ?? [],
    ...(opts.group ? { group: opts.group } : {}),
  }
}

/* ── applySessionDelete ── */

test('applySessionDelete：删除非激活会话 → 本地移除 + 返回待清理服务端 session_id，激活态不变', () => {
  const list = [mk('a', { serverSessionId: 'srv-a' }), mk('b'), mk('c')]
  const r = L.applySessionDelete(list, 'b', 'a')
  assert.deepEqual(r.list.map((s) => s.id), ['a', 'c'])
  assert.equal(r.removedServerSessionId, 'srv-b')
  assert.equal(r.nextActiveId, 'a')
})

test('applySessionDelete：删除当前激活会话 → 激活态切到列表首个', () => {
  const list = [mk('a'), mk('b'), mk('c')]
  const r = L.applySessionDelete(list, 'a', 'a')
  assert.deepEqual(r.list.map((s) => s.id), ['b', 'c'])
  assert.equal(r.removedServerSessionId, 'srv-a')
  assert.equal(r.nextActiveId, 'b')
})

test('applySessionDelete：删除最后一个激活会话 → 激活态置空', () => {
  const list = [mk('a')]
  const r = L.applySessionDelete(list, 'a', 'a')
  assert.equal(r.list.length, 0)
  assert.equal(r.removedServerSessionId, 'srv-a')
  assert.equal(r.nextActiveId, '')
})

test('applySessionDelete：未绑定服务端会话 → removedServerSessionId 为空（不触发服务端删除）', () => {
  const list = [mk('a', { serverSessionId: '' }), mk('b')]
  const r = L.applySessionDelete(list, 'a', 'a')
  assert.equal(r.removedServerSessionId, '')
  assert.equal(r.nextActiveId, 'b')
})

test('applySessionDelete：目标不存在 → 原列表返回（新数组）+ 不产出服务端删除 + 激活态不变', () => {
  const list = [mk('a'), mk('b')]
  const r = L.applySessionDelete(list, 'zz', 'b')
  assert.equal(r.list.length, 2)
  assert.notEqual(r.list, list)
  assert.equal(r.removedServerSessionId, '')
  assert.equal(r.nextActiveId, 'b')
})

test('applySessionDelete：输入列表不突变（返回新数组）', () => {
  const list = [mk('a'), mk('b')]
  const snapshot = JSON.stringify(list)
  L.applySessionDelete(list, 'a', 'a')
  assert.equal(JSON.stringify(list), snapshot)
})

/* ── normalizeSessionTitle ── */

test('normalizeSessionTitle：trim 空格', () => {
  assert.equal(L.normalizeSessionTitle('  我的标题  '), '我的标题')
})

test('normalizeSessionTitle：空串/空白回退「新会话」', () => {
  assert.equal(L.normalizeSessionTitle(''), '新会话')
  assert.equal(L.normalizeSessionTitle('   '), '新会话')
  assert.equal(L.normalizeSessionTitle(undefined), '新会话')
})

/* ── applySessionRename ── */

test('applySessionRename：更新标题 + 刷新 updatedAt（最近操作置顶语义），其余字段不变', () => {
  const list = [mk('a'), mk('b', { updatedAt: 5000, serverSessionId: 'srv-b', messages: [{ role: 'user', content: 'x' }] })]
  const r = L.applySessionRename(list, 'b', '  新名字  ', 9999)
  assert.equal(r[1].title, '新名字')
  assert.equal(r[1].updatedAt, 9999)
  assert.equal(r[1].serverSessionId, 'srv-b')
  assert.deepEqual(r[1].messages, [{ role: 'user', content: 'x' }])
  assert.equal(r[0].title, '会话a') // 未改名会话不受影响
  assert.equal(r[0].updatedAt, 1000)
})

test('applySessionRename：空标题回退「新会话」', () => {
  const list = [mk('a')]
  const r = L.applySessionRename(list, 'a', '   ', 123)
  assert.equal(r[0].title, '新会话')
})

test('applySessionRename：目标不存在 → 原样返回（新数组，不突变）', () => {
  const list = [mk('a')]
  const r = L.applySessionRename(list, 'zz', 'x', 123)
  assert.equal(r.length, 1)
  assert.notEqual(r, list)
  assert.equal(r[0].title, '会话a')
})

/* ── pickSessionServerId（切换会话时各自 session_id 绑定） ── */

test('pickSessionServerId：命中返回该会话持久化的 serverSessionId', () => {
  const list = [mk('a', { serverSessionId: 'srv-a' }), mk('b', { serverSessionId: 'srv-b' })]
  assert.equal(L.pickSessionServerId(list, 'b'), 'srv-b')
})

test('pickSessionServerId：未绑定 / 不存在 → 空串（新会话语义，首轮由服务端创建回填）', () => {
  const list = [mk('a', { serverSessionId: '' })]
  assert.equal(L.pickSessionServerId(list, 'a'), '')
  assert.equal(L.pickSessionServerId(list, 'nope'), '')
})

test('切换绑定链路：删除当前激活会话后，装载的下一个会话各自携带独立 serverSessionId', () => {
  const list = [mk('a', { serverSessionId: 'srv-a' }), mk('b', { serverSessionId: 'srv-b' }), mk('c', { serverSessionId: 'srv-c' })]
  // 当前激活 b，删除 b → 下一个激活 a，且 a 绑定 srv-a（而非残留 b 的 srv-b）
  const r = L.applySessionDelete(list, 'b', 'b')
  assert.equal(r.nextActiveId, 'a')
  assert.equal(L.pickSessionServerId(r.list, r.nextActiveId), 'srv-a')
  assert.equal(r.removedServerSessionId, 'srv-b')
})
