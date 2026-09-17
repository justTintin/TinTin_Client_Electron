#!/usr/bin/env node
/**
 * audit-golden-draft.cjs — 导出草稿 vs 剪映真机草稿（golden 基线）对照工具
 *
 * 用途（2026-09-17 golden 验收基础设施，互通方案附录 H #18 收尾项）：
 *   以剪映真机产出的草稿（golden）为基线，对照导出器产出的草稿：
 *   ① 轨道构成对照（type → 段数，双侧）
 *   ② 导出草稿跑 auditDraftStandardConformance（标准 §0.3 条3）+ verifyDraftFolder（§7）
 *   ③ 输出逐项 PASS/DIFF 报告；DIFF 数 > 0 时 exit 1（可作门禁）
 *
 * 用法：
 *   node desktop/scripts/audit-golden-draft.cjs <导出草稿目录> <golden draft_content.json>
 *
 * 例：
 *   node desktop/scripts/audit-golden-draft.cjs \
 *     "%LOCALAPPDATA%/JianyingPro/User Data/Projects/com.lveditor.draft/<draftName>" \
 *     test/jy-decrypted/draft_content.json
 *
 * 说明：golden 草稿若为本机加密草稿，需先用 jy-draftc 解密出明文 draft_content.json。
 */
'use strict'

const fs = require('fs')
const path = require('path')

const JY = require(path.join(__dirname, '..', 'main', 'jianying-exporter.js'))

function trackCounts(content) {
  const m = {}
  for (const t of (content && content.tracks) || []) {
    const n = (t.segments || []).length
    m[t.type] = (m[t.type] || 0) + n
  }
  return m
}

function fmtCounts(c) {
  const keys = Object.keys(c).sort()
  return keys.length ? keys.map((k) => `${k}:${c[k]}`).join(' ') : '（空）'
}

function main() {
  const [draftDir, goldenPath] = process.argv.slice(2)
  if (!draftDir || !goldenPath) {
    console.error('用法：node audit-golden-draft.cjs <导出草稿目录> <golden draft_content.json>')
    process.exit(2)
  }
  if (!fs.existsSync(path.join(draftDir, 'draft_content.json'))) {
    console.error('导出草稿目录缺 draft_content.json：' + draftDir)
    process.exit(2)
  }
  if (!fs.existsSync(goldenPath)) {
    console.error('golden 文件不存在：' + goldenPath)
    process.exit(2)
  }

  const exported = JSON.parse(fs.readFileSync(path.join(draftDir, 'draft_content.json'), 'utf-8'))
  const golden = JSON.parse(fs.readFileSync(goldenPath, 'utf-8'))

  let diffs = 0
  const row = (name, pass, detail) => {
    console.log((pass ? 'PASS' : 'DIFF') + '  ' + name + (detail ? ' —— ' + detail : ''))
    if (!pass) diffs++
  }

  // ① 轨道构成对照
  const ec = trackCounts(exported)
  const gc = trackCounts(golden)
  console.log('── 轨道构成 ──')
  console.log('golden  ：' + fmtCounts(gc))
  console.log('exported：' + fmtCounts(ec))
  row('视频轨存在且非空', (ec.video || 0) > 0, `exported video=${ec.video || 0}（golden ${gc.video || 0}）`)
  row('文本轨存在', (ec.text || 0) > 0, `exported text=${ec.text || 0}（golden ${gc.text || 0}）`)
  row('音频轨存在', (ec.audio || 0) > 0, `exported audio=${ec.audio || 0}（golden ${gc.audio || 0}）`)

  // ② 画布与总时长
  console.log('── 画布/时长 ──')
  const er = exported.canvas_config && exported.canvas_config.ratio
  const gr = golden.canvas_config && golden.canvas_config.ratio
  row('画幅比一致', er === gr, `exported ratio=${er}（golden ${gr}）`)
  row('总时长 > 0', (exported.duration || 0) > 0, `exported duration=${exported.duration}us（golden ${golden.duration}us）`)

  // ③ 标准符合性审计（导出侧）
  console.log('── 标准符合性（导出草稿） ──')
  const conf = JY.auditDraftStandardConformance(exported)
  row('符合性 0 警告', conf.warnings.length === 0,
    conf.warnings.length ? `${conf.warnings.length} 条：${conf.warnings.slice(0, 3).join('；')}${conf.warnings.length > 3 ? ' …' : ''}` : `checkedSegs=${conf.checkedSegs}`)

  // ④ 目录合规校验（导出侧）
  const vf = JY.verifyDraftFolder({ draftFolder: draftDir, expectedAssetCount: 0 })
  row('verifyDraftFolder 通过', vf.ok,
    vf.ok ? `pathRefs=${vf.pathRefs} missing=0 dangling=0` : vf.problems.slice(0, 3).join('；'))

  console.log('──')
  console.log(diffs === 0 ? '全部通过（0 DIFF）' : `${diffs} 项 DIFF（详见上）`)
  process.exit(diffs === 0 ? 0 : 1)
}

main()
