// ═══════════════════════════════════════════════════════════════
// auto-listing-meta.test.mjs — B12 自动上架渲染端纯函数元数据单测
// 覆盖：DOUYIN_STORES 店铺映射（对齐 main/auto-listing/config.js）、
//   storeMetaByKey 回退、parseProgressMessage（`[阶段] 内容` 解析）、
//   runStatusMeta 运行记录编组（续跑/重试/完成语义）。
// 运行：node --test "tests/*.test.mjs"
// ═══════════════════════════════════════════════════════════════
import { test } from 'node:test'
import assert from 'node:assert/strict'

const R = await import('../renderer/src/browser/composables/autoListingMeta.ts')

// ── DOUYIN_STORES：对齐主进程 config.js（name/aliases/homepage_url）──

test('DOUYIN_STORES 覆盖两店铺（juyou / 555_battery），字段对齐 config.js', () => {
  const keys = R.DOUYIN_STORES.map((s) => s.key)
  assert.deepEqual(keys, ['juyou', '555_battery'])
  const juyou = R.DOUYIN_STORES.find((s) => s.key === 'juyou')
  assert.equal(juyou.name, '桔柚数码外设严选')
  assert.ok(juyou.aliases.includes('桔柚'))
  assert.ok(juyou.homepage_url.includes('jinritemai.com'))
})

test('storeMetaByKey：未知键回退首个店铺', () => {
  assert.equal(R.storeMetaByKey('juyou').key, 'juyou')
  assert.equal(R.storeMetaByKey('unknown_key').key, 'juyou')
})

// ── parseProgressMessage：`[阶段] 内容` 解析（对位 engine._emit 格式）──

test('parseProgressMessage：标准 `[阶段] 内容` 拆出 stage/text', () => {
  assert.deepEqual(R.parseProgressMessage('[阶段1] 上传主图 / 填写标题'), { stage: '阶段1', text: '上传主图 / 填写标题' })
  assert.deepEqual(R.parseProgressMessage('[校验] 校验通过：A商品 / 2 个SKU'), { stage: '校验', text: '校验通过：A商品 / 2 个SKU' })
})

test('parseProgressMessage：无前缀/空消息回退 stage=进度', () => {
  assert.deepEqual(R.parseProgressMessage('任务完成'), { stage: '进度', text: '任务完成' })
  assert.deepEqual(R.parseProgressMessage(''), { stage: '进度', text: '' })
  assert.deepEqual(R.parseProgressMessage(null), { stage: '进度', text: '' })
})

// ── runStatusMeta：运行记录编组（结果卡 续跑/重试/完成 语义）──

test('runStatusMeta：interrupted 可续跑、done 完成不可续、failed 可重试可续跑', () => {
  const base = { runId: 'r1' }
  const interrupted = R.runStatusMeta({ ...base, stage: 'stage2', status: 'interrupted' })
  assert.equal(interrupted.statusText, '已中断')
  assert.equal(interrupted.stageText, '阶段2')
  assert.equal(interrupted.canResume, true)
  assert.equal(interrupted.canRetry, false)
  assert.equal(interrupted.isDone, false)

  const done = R.runStatusMeta({ ...base, stage: 'final', status: 'done' })
  assert.equal(done.statusText, '完成')
  assert.equal(done.stageText, '完成')
  assert.equal(done.isDone, true)
  assert.equal(done.canResume, false)

  const failed = R.runStatusMeta({ ...base, stage: 'save_draft', status: 'failed' })
  assert.equal(failed.statusText, '失败')
  assert.equal(failed.canRetry, true)
  assert.equal(failed.canResume, true)
})

test('runStatusMeta：running/pending 不可续跑，未知状态回退原文', () => {
  const running = R.runStatusMeta({ runId: 'r1', status: 'running' })
  assert.equal(running.statusText, '运行中')
  assert.equal(running.canResume, false)

  const pending = R.runStatusMeta({ runId: 'r1', status: 'pending' })
  assert.equal(pending.statusText, '排队中')
  assert.equal(pending.canResume, true)

  const unknown = R.runStatusMeta({ runId: 'r1', status: 'weird', stage: 'x' })
  assert.equal(unknown.statusText, 'weird')
  assert.equal(unknown.stageText, 'x')
  assert.equal(unknown.canResume, false)
})

test('runStatusMeta：无 status（state.json 未写）视为可续跑兜底', () => {
  const empty = R.runStatusMeta({ runId: 'r1' })
  assert.equal(empty.canResume, true)
  assert.equal(empty.statusText, '未知')
})
