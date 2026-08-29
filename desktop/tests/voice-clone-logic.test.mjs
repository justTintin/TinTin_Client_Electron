// ═══════════════════════════════════════════════════════════════
// voice-clone-logic.test.mjs — 声音克隆 分句/校验/合并 纯逻辑单测（M3 条目④）
// 被测：renderer/src/composables/voiceCloneLogic.ts（纯函数，无 vue/IPC 依赖）
// 对照原客户端 studio/gui/voice_clone_page.py：
//   · _count_chars L877-880（有效字数：中文+字母数字，忽略标点空白）
//   · _split_text_into_sentences L861-875（本地规则拆句）
//   · _estimate_max_chars L890-913（样本语速 → 单行字数上限，clamp 10~120）
//   · _merge_short_fragments L915-959（贪心合并 + 残片清理）
//   · _validate_llm_split L961-975（漏字校验 <99% → 本地拆分兜底）
//   · PunctuationLLMWorker prompt L49 / SentenceSplitterLLMWorker prompt L68-78
// 运行：node --test "tests/*.test.mjs"
// ═══════════════════════════════════════════════════════════════

import { test } from 'node:test'
import assert from 'node:assert/strict'

const V = await import('../renderer/src/composables/voiceCloneLogic.ts')

// ── countChars（对照 _count_chars L877-880）──

test('countChars：只数中文+字母数字，忽略标点/空白/（一）等编号字符', () => {
  assert.equal(V.countChars('你好，世界！'), 4)
  assert.equal(V.countChars('（一）第一条 abc 12'), 9) // 一第一第abc12
  assert.equal(V.countChars('  \n，。！'), 0)
})

// ── splitTextIntoSentences（对照 _split_text_into_sentences L861-875）──

test('splitTextIntoSentences：按中英句读+换行拆句', () => {
  const lines = V.splitTextIntoSentences('第一句。第二句！第三句？\n第四句.fifth!')
  assert.deepEqual(lines, ['第一句', '第二句', '第三句', '第四句', 'fifth'])
})

test('splitTextIntoSentences：空文本 → 空数组', () => {
  assert.deepEqual(V.splitTextIntoSentences(''), [])
})

// ── estimateMaxChars（对照 _estimate_max_chars L890-913）──

test('estimateMaxChars：样本语速推算（15s × 字数/时长）', () => {
  // 60 字 / 20 秒 = 3 字/秒 → 15×3 = 45
  assert.equal(V.estimateMaxChars(20, '一'.repeat(60)), 45)
})

test('estimateMaxChars：clamp 到 [10,120]', () => {
  assert.equal(V.estimateMaxChars(1000, '一'.repeat(900)), 13) // 0.9字/s×15=13.5→13
  assert.equal(V.estimateMaxChars(1, '一'.repeat(100)), 120)   // 100字/s×15=1500 → 120
  assert.equal(V.estimateMaxChars(50, '一'.repeat(3)), 10)     // 0.06×15≈0 → 10
})

test('estimateMaxChars：无样本时长/空文案 → 兜底 60（4字/秒×15s）', () => {
  assert.equal(V.estimateMaxChars(0, '一二三'), 60)
  assert.equal(V.estimateMaxChars(12, ''), 60)
})

// ── mergeShortFragments（对照 _merge_short_fragments L915-959）──

test('mergeShortFragments：相邻两行合并后不超上限就并', () => {
  const merged = V.mergeShortFragments(['十十十十十十', '十十十十十十', '十十十十十十十十十十十十十十'], 24)
  // 12+12=24 ≤ 24 → 并；24+24 > 24 → 断
  assert.deepEqual(merged, ['十十十十十十 十十十十十十', '十十十十十十十十十十十十十十'])
})

test('mergeShortFragments：残片（<max/4 且 <8 下限）并入前句', () => {
  const merged = V.mergeShortFragments(['一二三四五六七八九十', '哈'], 60)
  assert.deepEqual(merged, ['一二三四五六七八九十 哈'])
})

test('mergeShortFragments：末尾残片并入前句', () => {
  const merged = V.mergeShortFragments(['一二三四五六七八九十十一二', '哈'], 60)
  assert.equal(merged.length, 1)
})

test('mergeShortFragments：空数组/空行过滤', () => {
  assert.deepEqual(V.mergeShortFragments([], 60), [])
  assert.deepEqual(V.mergeShortFragments(['', '  '], 60), [])
})

// ── validateLlmSplit（对照 _validate_llm_split L961-975）──

test('validateLlmSplit：AI 输出漏字（<99%）→ 返回本地规则拆分兜底', () => {
  const original = '这是第一句话，包含编号（一）。这是第二句话。这是第三句话，比较长一点。'
  const fallback = V.validateLlmSplit(original, ['这是第一句话，包含编号。'])
  assert.ok(Array.isArray(fallback)) // 兜底 = 本地拆分
  assert.equal(V.validateLlmSplit(original, ['这是第一句话', '，包含编号（一）', '。这是第二句话。', '这是第三句话，比较长一点。']), null)
})

test('validateLlmSplit：空原文 → 校验通过（null）', () => {
  assert.equal(V.validateLlmSplit('', ['任意']), null)
})

// ── LLM 输出行提取（对照 LLM worker 代码围栏剥离 L51-52/L80-82）──

test('extractLlmLines：剥代码围栏、逐行去空', () => {
  const lines = V.extractLlmLines('```\n第一行\n\n第二行\n```')
  assert.deepEqual(lines, ['第一行', '第二行'])
})

test('extractLlmLines：原文编号行保留（不剥行首序号）', () => {
  const lines = V.extractLlmLines('（一）第一句\n（二）第二句')
  assert.deepEqual(lines, ['（一）第一句', '（二）第二句'])
})

// ── 提示词契约（对照 PunctuationLLMWorker L49 / SentenceSplitterLLMWorker L68-78）──

test('PUNCTUATION_SYSTEM_PROMPT：标点后处理关键约束在场', () => {
  assert.ok(V.PUNCTUATION_SYSTEM_PROMPT.includes('标点符号'))
  assert.ok(V.PUNCTUATION_SYSTEM_PROMPT.includes('绝对不要修改、增加或删除原文本的任何字词'))
})

test('SENTENCE_SPLIT_SYSTEM_PROMPT：拆句规则关键约束在场', () => {
  assert.ok(V.SENTENCE_SPLIT_SYSTEM_PROMPT.includes('每行一句话'))
  assert.ok(V.SENTENCE_SPLIT_SYSTEM_PROMPT.includes('绝对忠实原文'))
  assert.ok(V.SENTENCE_SPLIT_SYSTEM_PROMPT.includes('10~40 字'))
})

// ── 润色（洗稿）消息构造（对照 _show_rewrite_dialog L630-642）──

test('buildRewriteMessages：system=文案改写专家，user 携带原文与改写要求', () => {
  const msgs = V.buildRewriteMessages('语气更活泼', '原文内容')
  assert.equal(msgs[0].role, 'system')
  assert.ok(msgs[0].content.includes('文案改写专家'))
  assert.equal(msgs[1].role, 'user')
  assert.ok(msgs[1].content.includes('原文内容'))
  assert.ok(msgs[1].content.includes('语气更活泼'))
})
