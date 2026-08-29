// ═══════════════════════════════════════════════════════════════
// auto-listing/state.js — B12 自动上架：任务状态读写 + URL 阶段判定
//
// PRD 14.5：通过 URL 特征区分阶段 —— 无参数 `create` 为阶段1（主图/标题/
//   类目/下一步），`create?` 进入详情配置页（阶段2 各 Tab 填写）。
// 每步执行前写 runs/<runId>/state.json（当前阶段/URL/runId），供
//   断点续跑（resume）与 UI 状态查询（autoListing:status/listRuns）使用。
// 纯函数优先，可脱离 electron 单测。
// ═══════════════════════════════════════════════════════════════
'use strict'

const fs = require('node:fs')
const path = require('node:path')

/** 任务阶段顺序（resume 按此判断从哪一步继续） */
const STAGE_ORDER = ['validate', 'stage1', 'stage2', 'save_draft', 'publish', 'final']

function runsRootDir(syncDir) {
  return path.join(syncDir, 'runs')
}

function statePath(runsRoot, runId) {
  return path.join(runsRoot, String(runId), 'state.json')
}

/** 新任务默认状态（stage=validate，status=pending） */
function defaultState(runId) {
  return {
    runId: String(runId),
    stage: 'validate',
    status: 'pending', // pending / running / interrupted / done / failed
    url: '',
    sourceName: '',
    shopKey: '',
    publishAfterSave: false,
    error: '',
    ts: Date.now(),
  }
}

/** 读 state.json（不存在/损坏 → null） */
function readState(runsRoot, runId) {
  try {
    const p = statePath(runsRoot, runId)
    if (!fs.existsSync(p)) return null
    const s = JSON.parse(fs.readFileSync(p, 'utf8'))
    return (s && typeof s === 'object' && !Array.isArray(s)) ? s : null
  } catch (_) { return null }
}

/** 原子写 state.json（合入 patch；目录自动建） */
function writeState(runsRoot, runId, patch) {
  const p = statePath(runsRoot, runId)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  const cur = readState(runsRoot, runId) || defaultState(runId)
  const next = { ...cur, ...(patch || {}), runId: String(runId), ts: Date.now() }
  const tmp = p + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8')
  fs.renameSync(tmp, p)
  return next
}

/**
 * URL 特征 → 阶段判定（PRD 14.5 口径，纯函数）。
 * @param {string} url 当前页面 URL
 * @returns {'stage1'|'stage2'|'unknown'} create 后无参数 → stage1；create?xxx → stage2
 */
function stageFromUrl(url) {
  const u = String(url || '')
  const idx = u.indexOf('create')
  if (idx < 0) return 'unknown'
  const after = u.slice(idx + 'create'.length)
  return after.startsWith('?') ? 'stage2' : 'stage1'
}

/**
 * resume 语义：由 state 推导续跑计划（纯函数）。
 * @param {object|null} state readState 结果
 * @param {string} [currentUrl] 当前页面 URL（补充 URL 特征判定）
 * @returns {{canResume: boolean, stage: string, reason?: string}}
 */
function resumePlan(state, currentUrl) {
  if (!state) return { canResume: false, reason: 'NO_STATE' }
  if (state.status === 'done' || state.status === 'failed') {
    return { canResume: false, reason: 'STATUS_' + String(state.status).toUpperCase() }
  }
  // 当前 URL 已是详情配置页（create?）→ 从阶段2继续（用户在阶段2中断）
  if (currentUrl && stageFromUrl(currentUrl) === 'stage2') {
    return { canResume: true, stage: 'stage2' }
  }
  // 否则按 state.stage 记录继续（validate 已完成则至少从 stage1 开始）
  let stage = state.stage && STAGE_ORDER.includes(state.stage) ? state.stage : 'validate'
  if (stage === 'validate') stage = 'stage1'
  return { canResume: true, stage }
}

module.exports = {
  STAGE_ORDER,
  runsRootDir,
  statePath,
  defaultState,
  readState,
  writeState,
  stageFromUrl,
  resumePlan,
}
