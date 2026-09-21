// 文案编写页提示词构建器单测（2026-09-21 用户裁决：文案混剪 Step1 按参考界面重排——
// 高级脚本设置 + AI 生成视频文案与关键词；纯函数在 copyMontageStep2ConcatLogic.ts）
import { test } from 'node:test'
import assert from 'node:assert/strict'

const M = await import('../renderer/src/composables/copyMontageStep2ConcatLogic.ts')

test('buildScriptSystemPrompt：基底+场景+产品信息+自定义要求合并', () => {
  const sys = M.buildScriptSystemPrompt('BASE', {
    scene: 'live_pitch', brand: '罗技', product: '鼠标', modelName: 'G502', extra: '8K回报率',
    customRequirement: '轻松风格',
  })
  assert.ok(sys.startsWith('BASE'))
  assert.ok(sys.includes('## 场景\n口播带货场景'))
  assert.ok(sys.includes('## 产品信息\n产品：罗技，鼠标，G502\n核心卖点：8K回报率'))
  assert.ok(sys.includes('## 文案要求\n轻松风格'))
})

test('buildScriptSystemPrompt：未知场景回退通用；产品全空省略产品信息块', () => {
  const sys = M.buildScriptSystemPrompt('BASE', { scene: 'nope' })
  assert.ok(sys.includes('## 场景\n不限定具体场景'))
  assert.ok(!sys.includes('## 产品信息'))
  assert.ok(!sys.includes('## 文案要求'))
})

test('SCRIPT_SCENE_OPTIONS：通用/口播带货/产品讲解/种草推荐，值唯一', () => {
  assert.deepEqual(M.SCRIPT_SCENE_OPTIONS.map((o) => o.value), ['general', 'live_pitch', 'explain', 'seeding'])
})

test('SCRIPT_SCENE_OPTIONS：各场景带建议时长默认值', () => {
  const defs = Object.fromEntries(M.SCRIPT_SCENE_OPTIONS.map((o) => [o.value, o.defaultSec]))
  assert.equal(defs.general, 30)
  assert.equal(defs.live_pitch, 30)
  assert.equal(defs.explain, 45)
  assert.equal(defs.seeding, 40)
})

test('buildScriptSystemPrompt：建议时长并入（秒 + 字数换算）', () => {
  const sys = M.buildScriptSystemPrompt('BASE', { scene: 'live_pitch', suggestSec: 30 })
  assert.ok(sys.includes(`## 建议时长\n约 30 秒（口播约 4 字/秒，正文控制在 120 字左右）`))
})

test('buildScriptSystemPrompt：未传建议时长 → 不出现该块（兼容旧调用）', () => {
  const sys = M.buildScriptSystemPrompt('BASE', {})
  assert.ok(!sys.includes('建议时长'))
})

test('assignScenesToShots：按时长贪心装填至分镜时长，素材耗尽余镜为空', () => {
  const scenes = [
    { idx: 1, duration: 2 }, { idx: 2, duration: 3 }, { idx: 3, duration: 4 }, { idx: 4, duration: 1 },
  ]
  const shots = [{ duration: 3 }, { duration: 4 }, { duration: 6 }]
  const a = M.assignScenesToShots(shots, scenes)
  // 镜1（3s）：装 idx1(2s) 后未达标 → 再装 idx2(3s) 累计 5s 停
  assert.deepEqual(a[0].scenes.map((s) => s.idx), [1, 2])
  assert.equal(a[0].coveredSec, 5)
  // 镜2（4s）：idx3(4s) 一次达标
  assert.deepEqual(a[1].scenes.map((s) => s.idx), [3])
  assert.equal(a[1].coveredSec, 4)
  // 镜3（6s）：只剩 idx4(1s)（每镜至少 1 素材）
  assert.deepEqual(a[2].scenes.map((s) => s.idx), [4])
  assert.equal(a[2].coveredSec, 1)
})

test('buildScriptUserPrompt：只含脚本长度与产出指令（产品/场景已并入 system）', () => {
  const p = M.buildScriptUserPrompt({ paragraphCount: 3.9 })
  assert.ok(p.includes('脚本长度：3 个段落'))
  assert.ok(!p.includes('产品信息'))
  assert.ok(p.endsWith('直接返回文案正文。'))
})

test('parseKeywordsText：中英逗号/顿号/换行统一，剥序号引号代码块，去重保序', () => {
  const parts = M.parseKeywordsText('```text\n1. 无感延迟，2、"轻量化"、大驱动\n无线连接， 无感延迟\n```')
  assert.deepEqual(parts, ['无感延迟', '轻量化', '大驱动', '无线连接'])
})

test('parseKeywordsText：普通逗号串原样切分；空输入 → 空', () => {
  assert.deepEqual(M.parseKeywordsText('低延迟，长续航'), ['低延迟', '长续航'])
  assert.deepEqual(M.parseKeywordsText(''), [])
  assert.deepEqual(M.parseKeywordsText(null), [])
})

test('buildCopyStoryboardPrompt：口播=旁白 + 文字分镜 skill 规则 + 现有 JSON 契约 + 文案全文', () => {
  const { systemPrompt, userPrompt } = M.buildCopyStoryboardPrompt('测试口播文案。')
  // 口播≠分镜：旁白连续存在，分镜由 AI 根据旁白梳理
  assert.ok(systemPrompt.includes('口播旁白'))
  assert.ok(systemPrompt.includes('不是分镜'))
  assert.ok(systemPrompt.includes('根据旁白梳理出分镜脚本'))
  // skill 工艺规则（.zcode/skills/text-storyboard/SKILL.md）
  assert.ok(systemPrompt.includes('具体的物理动作'))
  assert.ok(systemPrompt.includes('连续的动作链'))
  assert.ok(systemPrompt.includes('镜头运动要有明确方向'))
  assert.ok(systemPrompt.includes('3200K暖光'))
  // Viral_Writer 口播节奏（黄金3秒钩子/金句/行动号召）
  assert.ok(systemPrompt.includes('开场钩子'))
  assert.ok(systemPrompt.includes('行动号召'))
  // 现有分镜脚本规范（opsStoryboardLogic 同款 JSON 字段契约）
  assert.ok(systemPrompt.includes('"shot_type"'))
  assert.ok(systemPrompt.includes('"visual"'))
  assert.ok(systemPrompt.includes('"audio"'))
  assert.ok(systemPrompt.includes('"sfx"'))
  assert.ok(systemPrompt.includes('"duration"'))
  // 旁白=原文片段契约
  assert.ok(systemPrompt.includes('原文片段'))
  assert.ok(userPrompt.includes('竖屏（9:16）'))
  assert.ok(userPrompt.includes('测试口播文案。'))
})

test('shotsNarrationText：逐镜旁白去空白按序拼接（克隆合成全文）', () => {
  const shots = [
    { audio: '第一镜旁白内容大概十六个字符的长度哦。' },
    { audio: '  ' },
    { audio: '第二镜。' },
  ]
  assert.equal(M.shotsNarrationText(shots), '第一镜旁白内容大概十六个字符的长度哦。\n第二镜。')
})

test('SCRIPT_SYSTEM_PROMPT_DEFAULT：Video Script Generator 角色式提示词（2026-09-21 用户定稿）', () => {
  assert.ok(M.SCRIPT_SYSTEM_PROMPT_DEFAULT.startsWith('# Role: Video Script Generator'))
  assert.ok(M.SCRIPT_SYSTEM_PROMPT_DEFAULT.includes('## Goals:'))
  assert.ok(M.SCRIPT_SYSTEM_PROMPT_DEFAULT.includes('## Constrains:'))
  assert.ok(M.SCRIPT_SYSTEM_PROMPT_DEFAULT.includes('8. respond in the same language as the video subject.'))
})

test('SCRIPT_SYSTEM_PROMPT_LEGACY_DEFAULT：旧默认（迁移比对用），与新默认不同', () => {
  assert.ok(M.SCRIPT_SYSTEM_PROMPT_LEGACY_DEFAULT.startsWith('## Constraints:'))
  assert.notEqual(M.SCRIPT_SYSTEM_PROMPT_LEGACY_DEFAULT, M.SCRIPT_SYSTEM_PROMPT_DEFAULT)
})
