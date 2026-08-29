// ═══════════════════════════════════════════════════════════════
// auto-listing-state.test.mjs — B12 自动上架：state.json 读写 + URL 阶段判定
// 对位：PRD 14.5「无参数 create 为阶段1，create? 进入详情配置页」+ 断点续跑
// 覆盖：state.json 读写往返、stageFromUrl 三态判定、resumePlan 语义
//   （NO_STATE / done 不可续 / create? 续 stage2 / validate 归一 stage1）。
// ═══════════════════════════════════════════════════════════════
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  runsRootDir, statePath, defaultState, readState, writeState, stageFromUrl, resumePlan,
} from '../main/auto-listing/state.js'

function tempBase() {
  const d = mkdtempSync(join(tmpdir(), 'tintin-als-state-'))
  return { d, cleanup: () => rmSync(d, { recursive: true, force: true }) }
}

test('state.json 读写往返 + 原子写落盘', () => {
  const { d, cleanup } = tempBase()
  try {
    const root = runsRootDir(d)
    writeState(root, 'run1', { stage: 'stage2', status: 'running', shopKey: 'juyou' })
    const s = readState(root, 'run1')
    assert.ok(s)
    assert.equal(s.runId, 'run1')
    assert.equal(s.stage, 'stage2')
    assert.equal(s.shopKey, 'juyou')
    assert.equal(typeof s.ts, 'number')
    assert.ok(existsSync(statePath(root, 'run1')))
    // 合入 patch 不丢既有字段
    writeState(root, 'run1', { url: 'https://fxg.jinritemai.com/ffa/g/create?x=1' })
    const s2 = readState(root, 'run1')
    assert.equal(s2.stage, 'stage2')
    assert.equal(s2.shopKey, 'juyou')
    assert.ok(s2.url.includes('create?'))
  } finally { cleanup() }
})

test('readState 不存在 / 损坏 → null', () => {
  const { d, cleanup } = tempBase()
  try {
    const root = runsRootDir(d)
    assert.equal(readState(root, 'nope'), null)
    mkdirSync(join(root, 'bad'), { recursive: true })
    writeFileSync(join(root, 'bad', 'state.json'), '{broken json', 'utf8')
    assert.equal(readState(root, 'bad'), null)
  } finally { cleanup() }
})

test('defaultState 字段齐备', () => {
  const s = defaultState('r9')
  assert.equal(s.runId, 'r9')
  assert.equal(s.stage, 'validate')
  assert.equal(s.status, 'pending')
  assert.equal(s.url, '')
})

// ── stageFromUrl：PRD 14.5 URL 特征判定 ──
test('stageFromUrl 无参数 create → stage1；create? 参数 → stage2；无 create → unknown', () => {
  assert.equal(stageFromUrl('https://fxg.jinritemai.com/ffa/g/create'), 'stage1')
  assert.equal(stageFromUrl('https://fxg.jinritemai.com/ffa/g/create/'), 'stage1')
  assert.equal(stageFromUrl('https://fxg.jinritemai.com/ffa/g/create?tab=base'), 'stage2')
  assert.equal(stageFromUrl('https://fxg.jinritemai.com/ffa/g/create?product_id=123'), 'stage2')
  assert.equal(stageFromUrl('https://fxg.jinritemai.com/ffa/mshop/homepage/index'), 'unknown')
  assert.equal(stageFromUrl(''), 'unknown')
  assert.equal(stageFromUrl('https://fxg.jinritemai.com/ffa/g/create#/x'), 'stage1') // 锚点不视为参数
})

// ── resumePlan：断点续跑语义 ──
test('resumePlan 无 state → 不可续（NO_STATE）', () => {
  assert.deepEqual(resumePlan(null), { canResume: false, reason: 'NO_STATE' })
})

test('resumePlan done/failed → 不可续', () => {
  const s = { status: 'done', stage: 'final' }
  assert.deepEqual(resumePlan(s), { canResume: false, reason: 'STATUS_DONE' })
  const s2 = { status: 'failed', stage: 'stage2' }
  assert.deepEqual(resumePlan(s2), { canResume: false, reason: 'STATUS_FAILED' })
})

test('resumePlan 当前 URL 已是 create? → 从 stage2 继续', () => {
  const s = { status: 'running', stage: 'stage1', url: 'https://fxg.jinritemai.com/ffa/g/create' }
  const plan = resumePlan(s, 'https://fxg.jinritemai.com/ffa/g/create?tab=price')
  assert.deepEqual(plan, { canResume: true, stage: 'stage2' })
})

test('resumePlan 按 state.stage 记录继续；validate 归一为 stage1', () => {
  assert.equal(resumePlan({ status: 'interrupted', stage: 'stage1' }).stage, 'stage1')
  assert.equal(resumePlan({ status: 'interrupted', stage: 'stage2' }).stage, 'stage2')
  assert.equal(resumePlan({ status: 'running', stage: 'validate' }).stage, 'stage1')
  assert.equal(resumePlan({ status: 'running', stage: 'save_draft' }).stage, 'save_draft')
})

test('state.json 文件内容为合法 JSON（原子写 tmp→rename）', () => {
  const { d, cleanup } = tempBase()
  try {
    const root = runsRootDir(d)
    writeState(root, 'r1', { stage: 'stage1' })
    const raw = readFileSync(statePath(root, 'r1'), 'utf8')
    const parsed = JSON.parse(raw)
    assert.equal(parsed.stage, 'stage1')
  } finally { cleanup() }
})
