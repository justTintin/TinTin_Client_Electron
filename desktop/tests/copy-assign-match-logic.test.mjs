// 分镜×素材智能匹配纯逻辑单测（2026-09-21 用户裁决方案 C：
// 本地预筛 + LLM 精选 + 循环兜底，实现在 copyMontageAssignLogic.ts；
// 2026-09-22 用户裁决开工：一镜多片·按时长装填——planShotGroup/groupUseDurs 等）
import { test } from 'node:test'
import assert from 'node:assert/strict'

const M = await import('../renderer/src/composables/copyMontageAssignLogic.ts')
const S = await import('../renderer/src/composables/copyMontageStep2ConcatLogic.ts')

/** 造池项：key 按 源片|起|止 指纹（与 sceneHashKey 同口径即可，测试只要求唯一） */
function item(idx, { type = '', dur = 3, score = 0, desc = '' } = {}) {
  return {
    key: `src|${idx * 10}|${idx * 10 + dur}`,
    scene: {
      idx, name: `clip_${idx}`, sourceName: 'src', startSec: idx * 10, endSec: idx * 10 + dur,
      duration: dur, description: desc, analysis: '', score, clipUrl: `u${idx}`, serverPath: `p${idx}`,
      downloadState: 'ok', checked: true, shotType: type || undefined,
    },
  }
}

function shot(index, { type = '', dur = 3, visual = '' } = {}) {
  return { index, shot_type: type, visual, audio: '', sfx: '', duration: dur,
    material_path: '', material_type: '', material_hash: '', material_id: 0 }
}

test('shotTypeMatches：键/中文/跨表示命中，空值不命中', () => {
  assert.equal(M.shotTypeMatches('closeup', 'closeup'), true)
  assert.equal(M.shotTypeMatches('closeup', '特写'), true)
  assert.equal(M.shotTypeMatches('特写', 'closeup'), false) // 素材侧不会存中文，单向即可
  assert.equal(M.shotTypeMatches('', '特写'), false)
  assert.equal(M.shotTypeMatches('closeup', ''), false)
})

test('prefilterShotCandidates：同景别优先，桶内时长窗>|Δdur|>评分', () => {
  const pool = [
    item(1, { type: 'medium', dur: 3, score: 9 }),   // 异景别
    item(2, { type: 'closeup', dur: 30, score: 9 }), // 同景别窗外
    item(3, { type: 'closeup', dur: 3.2, score: 6 }),// 同景别窗内 Δ0.2
    item(4, { type: 'closeup', dur: 2.8, score: 8 }),// 同景别窗内 Δ0.2 评分高
  ]
  const r = M.prefilterShotCandidates(shot(1, { type: '特写', dur: 3 }), pool)
  assert.deepEqual(r.map((x) => x.scene.idx), [4, 3, 2, 1]) // 4/3 窗内按评分，2 同景别窗外，1 异景别
})

test('prefilterShotCandidates：镜未标景别→无桶偏好，按窗+评分；topK 截断', () => {
  const pool = Array.from({ length: 12 }, (_, i) => item(i + 1, { dur: 3, score: 12 - i }))
  const r = M.prefilterShotCandidates(shot(1, { dur: 3 }), pool)
  assert.equal(r.length, M.ASSIGN_MATCH_PER_SHOT_TOPK)
  assert.equal(r[0].scene.idx, 1) // Δdur 全 0 → 评分降序
})

test('buildAssignCandidateSet：轮转并集保证每镜首选入池、去重、超帽截断', () => {
  const pool = [
    item(1, { type: 'closeup', dur: 3, score: 9 }),
    item(2, { type: 'medium', dur: 3, score: 8 }),
    item(3, { type: 'closeup', dur: 8, score: 7 }),
  ]
  const shots = [shot(1, { type: '特写', dur: 3 }), shot(2, { type: '中景', dur: 3 })]
  const set = M.buildAssignCandidateSet(shots, pool)
  assert.deepEqual(set.map((x) => x.scene.idx), [1, 2, 3]) // 两镜首选 1、2 先入，再补 3
  // 超帽语义：每镜只带各自 topK 进并集——同序榜单并集=topK（8），cap=10 未触顶
  const bigPool = Array.from({ length: 60 }, (_, i) => item(i + 1, { score: 60 - i }))
  const manyShots = Array.from({ length: 30 }, (_, i) => shot(i + 1, { dur: 3 }))
  const capped = M.buildAssignCandidateSet(manyShots, bigPool, 10)
  assert.equal(capped.length, 8)
  assert.deepEqual(capped.map((c) => c.scene.idx), [1, 2, 3, 4, 5, 6, 7, 8])
})

test('buildAssignMatchPrompt：C 号编表、中文景别标签、输出契约就位', () => {
  const pool = [item(1, { type: 'closeup', dur: 2.8, score: 9.2, desc: '手部拿起瓶子特写' })]
  const { systemPrompt, userPrompt } = M.buildAssignMatchPrompt([shot(1, { type: '特写', dur: 3, visual: '产品旋转展示' })], pool)
  assert.ok(systemPrompt.includes('只能使用候选表中出现的素材号'))
  assert.ok(systemPrompt.includes('{"matches":{"1":"C1","2":"C3"}}'))
  assert.ok(userPrompt.includes('1|特写|3.0s|产品旋转展示'))
  assert.ok(userPrompt.includes('C1|特写|2.8s|9.2分|手部拿起瓶子特写'))
})

test('parseAssignMatchResponse：裸 JSON/围栏/C 前缀/数字值均收，越界丢弃', () => {
  const p = (s, n = 3, c = 5) => M.parseAssignMatchResponse(s, n, c)
  assert.deepEqual([...p('{"matches":{"1":"C2","2":3,"3":"9"}}') || []], [[1, 2], [2, 3]]) // 9 越界丢弃
  assert.deepEqual([...p('```json\n{"matches":{"1":"C5"}}\n```') || []], [[1, 5]])
  assert.deepEqual([...p('前置说明 {"matches":{"2":"C1"}} 后置') || []], [[2, 1]]) // 杂讯截取后局部合法条目保留
})

test('parseAssignMatchResponse：不可解析/缺 matches/空入参 → null', () => {
  assert.equal(M.parseAssignMatchResponse('完全不是 JSON', 3, 5), null)
  assert.equal(M.parseAssignMatchResponse('{"foo":1}', 3, 5), null)
  assert.equal(M.parseAssignMatchResponse('{"matches":{}}', 3, 5), null)
  assert.equal(M.parseAssignMatchResponse('{"matches":{"1":"C1"}}', 0, 5), null)
  assert.equal(M.parseAssignMatchResponse('{"matches":{"1":"C1"}}', 3, 0), null)
})

test('mergeTabAssignment：命中写回 + 缺口循环兜底 + 游标跨脚本连续', () => {
  const pool = [item(11), item(22), item(33)]
  const cands = [pool[0], pool[2]] // C1=idx11, C2=idx33
  const r1 = M.mergeTabAssignment(3, new Map([[1, 2]]), cands, pool, 0)
  assert.deepEqual(r1.idxs, [33, 11, 22]) // 镜1 LLM 命中 C2；镜2/3 从 k=0 轮转 11、22
  assert.equal(r1.matched, 1)
  assert.equal(r1.nextK, 2)
  const r2 = M.mergeTabAssignment(2, null, cands, pool, r1.nextK) // 下一脚本解析失败全兜底
  assert.deepEqual(r2.idxs, [33, 11])
  assert.equal(r2.matched, 0)
  assert.equal(r2.nextK, 4)
})

test('mergeTabAssignment：空池全 -1；解析失败整组兜底', () => {
  const r = M.mergeTabAssignment(2, null, [], [], 0)
  assert.deepEqual(r.idxs, [-1, -1])
  assert.equal(r.matched, 0)
  const pool = [item(7)]
  const full = M.mergeTabAssignment(2, null, [], pool, 0)
  assert.deepEqual(full.idxs, [7, 7]) // 池=1 相邻重复不可避免（兜底口径与原版一致）
})

// ── 一镜多片·按时长装填（2026-09-22 用户裁决开工）──

function shotOf(dur) {
  return { index: 1, shot_type: '', visual: '', audio: '', sfx: '', duration: dur,
    material_path: '', material_type: '', material_hash: '', material_id: 0 }
}

test('planShotGroup：主片够长单片段封镜（超镜标裁到镜标）；主片严重超长同样裁', () => {
  const pool = [item(1, { dur: 5, score: 9 }), item(2, { dur: 4, score: 8 })]
  // 主片 5s > 镜标 4 → 单片封镜并裁到 4
  const r1 = M.planShotGroup(shotOf(4), 1, pool)
  assert.deepEqual(r1.idxs, [1])
  assert.deepEqual(r1.useDurs, [4])
  assert.equal(r1.coveredSec, 4)
  assert.equal(r1.sealed, true)
  // 主片 5s > 镜标 3 → 裁到 3
  const r2 = M.planShotGroup(shotOf(3), 1, pool)
  assert.deepEqual(r2.idxs, [1])
  assert.deepEqual(r2.useDurs, [3])
  assert.equal(r2.coveredSec, 3)
  assert.equal(r2.sealed, true)
})

test('planShotGroup：欠长装填补片，末端裁到镜标；素材耗尽欠装未封镜', () => {
  const pool = [item(1, { dur: 2, score: 9 }), item(2, { dur: 2, score: 8 }), item(3, { dur: 2, score: 7 }), item(4, { dur: 2, score: 6 })]
  // 镜标 5：主片 2 + 补 2 = 4 <5 继续补 2 → 6>5 末端裁到 1 → covered=5 sealed
  const r1 = M.planShotGroup(shotOf(5), 1, pool)
  assert.deepEqual(r1.idxs, [1, 2, 3])
  assert.deepEqual(r1.useDurs, [2, 2, 1])
  assert.equal(r1.coveredSec, 5)
  assert.equal(r1.sealed, true)
  // 镜标 6：池尽 2+2+2+2=8≥5.4 封镜且 8>6 末端裁到 0？——2+2+2=6 封镜（covered≥5.4 后停）
  const r2 = M.planShotGroup(shotOf(6), 1, pool)
  assert.deepEqual(r2.useDurs, [2, 2, 2])
  assert.equal(r2.coveredSec, 6)
  // 素材耗尽欠装：池仅 1 段 2s、镜标 5 → covered 2 <4.5 未封镜
  const small = [item(1, { dur: 2 })]
  const r3 = M.planShotGroup(shotOf(5), 1, small)
  assert.deepEqual(r3.idxs, [1])
  assert.equal(r3.coveredSec, 2)
  assert.equal(r3.sealed, false)
})

test('planShotGroup：主片不在池 → 空计划；镜标 0 → 主片全长单片', () => {
  const pool = [item(1, { dur: 3 })]
  assert.deepEqual(M.planShotGroup(shotOf(3), 99, pool), { idxs: [], useDurs: [], coveredSec: 0, sealed: false })
  const r = M.planShotGroup(shotOf(0), 1, pool)
  assert.deepEqual(r.idxs, [1])
  assert.equal(r.sealed, true)
})

test('groupUseDurs：顺序消耗镜标，末端裁到剩余量；组短于镜标全长使用', () => {
  const g = [item(1, { dur: 2 }).scene, item(2, { dur: 2 }).scene, item(3, { dur: 2 }).scene]
  assert.deepEqual(S.groupUseDurs(g, 5), [2, 2, 1])
  assert.deepEqual(S.groupUseDurs(g, 10), [2, 2, 2])
  assert.deepEqual(S.groupUseDurs(g, 0), [2, 2, 2])
})

test('planNeedsGroupRender：多片组/裁剪组触发；单片段全长不触发', () => {
  const a = item(1, { dur: 4 }).scene
  const b = item(2, { dur: 4 }).scene
  assert.equal(S.planNeedsGroupRender([{ scenes: [a], useDurs: [4] }]), false)
  assert.equal(S.planNeedsGroupRender([{ scenes: [a, b], useDurs: [4, 4] }]), true)
  assert.equal(S.planNeedsGroupRender([{ scenes: [a], useDurs: [2.5] }]), true)
})

test('buildGroupedPrecomposePlan：组保序摊平 clips，groups 带 useDurs', () => {
  const g1 = [item(1, { dur: 3 }).scene]
  const g2 = [item(2, { dur: 2 }).scene, item(3, { dur: 2 }).scene]
  const plan = S.buildGroupedPrecomposePlan([g1, g2], [3, 5])
  assert.equal(plan.clips.length, 3)
  assert.equal(plan.groups.length, 2)
  assert.deepEqual(plan.groups[1].useDurs, [2, 2])
  assert.deepEqual(plan.groups[1].scenes.map((s) => s.idx), [2, 3])
  assert.equal(plan.confirmed, false)
})
