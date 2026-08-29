// ═══════════════════════════════════════════════════════════════
// autoListingMeta — B12 自动上架：渲染端纯函数元数据（无 vue/IPC 依赖）
// 对位：main/auto-listing/config.js（DOUYIN_STORES 字段一致 name/aliases/
//   homepage_url，仅由对象改数组便于下拉渲染）；main/auto-listing/state.js
//   （STAGE_ORDER 中文文案）；main/auto-listing/ipc.js（进度消息 `[阶段] msg`
//   与 listRuns 记录编组）。
// 纯函数可脱离 electron 单测（tests/auto-listing-meta.test.mjs）。
// ═══════════════════════════════════════════════════════════════

/** 抖店店铺映射（对齐 main/auto-listing/config.js DOUYIN_STORES，数组化供下拉 v-for） */
export interface DouyinStoreMeta {
  key: string
  name: string
  aliases: string[]
  homepage_url: string
}

export const DOUYIN_STORES: DouyinStoreMeta[] = [
  { key: 'juyou', name: '桔柚数码外设严选', aliases: ['桔柚', 'juyou'], homepage_url: 'https://fxg.jinritemai.com/ffa/mshop/homepage/index' },
  { key: '555_battery', name: '555井韵电池店铺', aliases: ['555', '井韵'], homepage_url: 'https://fxg.jinritemai.com/ffa/mshop/homepage/index' },
]

/** 店铺键 → 店铺元信息（未知键回退首个店铺） */
export function storeMetaByKey(key: string): DouyinStoreMeta {
  return DOUYIN_STORES.find((s) => s.key === key) || DOUYIN_STORES[0]
}

/** state.stage → 中文文案（对齐 state.js STAGE_ORDER + 引擎 emit 阶段名） */
export const STAGE_LABELS: Record<string, string> = {
  validate: '校验',
  stage1: '阶段1',
  stage2: '阶段2',
  save_draft: '保存草稿',
  publish: '上架',
  final: '完成',
  progress: '进度',
}

/** state.status → 中文文案 */
export const STATUS_LABELS: Record<string, string> = {
  pending: '排队中',
  running: '运行中',
  interrupted: '已中断',
  done: '完成',
  failed: '失败',
}

/**
 * 解析进度消息 `[阶段] 内容`（对位 engine._emit 格式）。
 * 无前缀 → { stage: '进度', text: 原文 }（防御非标准消息）。
 */
export function parseProgressMessage(message: string): { stage: string; text: string } {
  const m = /^\[([^\]]+)\]\s*([\s\S]*)$/.exec(String(message || ''))
  return m ? { stage: m[1], text: m[2] } : { stage: '进度', text: String(message || '') }
}

/** listRuns 单条记录最小结构（对齐 global.d.ts TintinAutoListingRun） */
export interface AutoListingRunLike {
  runId: string
  stage?: string
  status?: string
  ts?: number
  sourceName?: string
  title?: string
}

/**
 * 运行记录编组（结果卡展示元信息，纯函数）：
 *   statusText 中文状态；stageText 中文阶段；canResume=未完成可续跑
 *   （interrupted/failed/pending）；canRetry=失败可重试；isDone=已完成
 */
export function runStatusMeta(run: AutoListingRunLike): {
  statusText: string
  stageText: string
  canResume: boolean
  canRetry: boolean
  isDone: boolean
} {
  const status = String(run.status || '')
  const stage = String(run.stage || '')
  return {
    statusText: STATUS_LABELS[status] || status || '未知',
    stageText: STAGE_LABELS[stage] || stage,
    canResume: status === 'interrupted' || status === 'failed' || status === 'pending' || status === '',
    canRetry: status === 'failed',
    isDone: status === 'done',
  }
}
