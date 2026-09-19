// 字幕对齐增强（2026-09-19）单测：silencedetect 解析 + 句窗口实测对齐
// 被测：main/montage-voice-ipc.js parseSilencedetect / alignTimingToSpeech
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const M = await import('../main/montage-voice-ipc.js')

test('parseSilencedetect：stderr → 句间停顿（边缘语音段不计 leadIn/tailOut）', () => {
  const stderr = [
    '[silencedetect @ 0x0] silence_start: 0.42',
    '[silencedetect @ 0x0] silence_end: 0.95 | silence_duration: 0.53',
    '[silencedetect @ 0x0] silence_start: 5.1',
    '[silencedetect @ 0x0] silence_end: 5.6 | silence_duration: 0.5',
  ].join('\n')
  const m = M.parseSilencedetect(stderr, 6.5)
  // 音频边界 [0,0.42] 与 [5.6,6.5] 是语音（非静音）→ leadIn/tailOut = 0
  assert.equal(m.leadIn, 0)
  assert.equal(m.tailOut, 0)
  assert.equal(m.gaps.length, 2)
  assert.equal(m.gaps[0].mid, 0.685)
  assert.equal(m.gaps[1].mid, 5.35)
})

test('parseSilencedetect：全静音返回 null（无可对齐边界）', () => {
  const allSilent = '[silencedetect @ 0x0] silence_start: 0'
  const m = M.parseSilencedetect(allSilent, 10)
  assert.equal(m, null)
})

test('parseSilencedetect：无静音返回 null（对齐回退估算）', () => {
  const m = M.parseSilencedetect('', 10)
  assert.equal(m, null)
})

test('alignTimingToSpeech：句界吸附实测停顿中点 + 末句对齐实测语音终点', () => {
  const timing = [
    { text: 'A第一句', start: 0, end: 3 },
    { text: 'B第二句', start: 3, end: 6 },
    { text: 'C第三句', start: 6, end: 10 },
  ]
  const m = { leadIn: 0, tailOut: 0.5, gaps: [{ mid: 3.4 }, { mid: 6.2 }] }
  const out = M.alignTimingToSpeech(timing, m, 10)
  assert.equal(out[0].end, 3.4)
  assert.equal(out[1].start, 3.4)
  assert.equal(out[1].end, 6.2)
  assert.equal(out[2].start, 6.2)
  assert.equal(out[2].end, 9.5) // totalDur - tailOut
  assert.equal(out[1].end, out[2].start) // 连续
})

test('alignTimingToSpeech：无实测数据原样返回', () => {
  const timing = [{ text: 'x', start: 1, end: 2 }]
  assert.equal(M.alignTimingToSpeech(timing, null, 10), timing)
})

// ── 2026-09-19 报障修复：detectSpeechBounds 未 await → Promise 当测量结果 → 全 NaN/null
//    → scaleTimingSidecar Number(null)=0 → timing 整条清零（预览词条/字幕全挤 0 点）──

test('alignTimingToSpeech：测量对象非法（如误传 Promise）→ 原样返回估算 timing 不产 NaN', () => {
  const est = [
    { text: '第一句', start: 0, end: 2 },
    { text: '第二句', start: 2, end: 4.2 },
  ]
  // 修复前：m.leadIn=undefined → start/end 全 NaN → JSON 序列化为 null
  const out = M.alignTimingToSpeech(est, /* 模拟裸 Promise 被当 m */ { leadIn: NaN, tailOut: NaN, gaps: [] }, 5)
  assert.deepEqual(out, est)
})

test('scaleTimingSidecar：null/零值行不被 Number(null)=0 清零放大（跳过非法行）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'timing-'))
  try {
    const wav = path.join(dir, 'voice_1.wav')
    const p = wav + '.timing.json'
    fs.writeFileSync(p, JSON.stringify([
      { text: 'a', start: null, end: null }, // NaN→null 的污染行
      { text: 'b', start: 1, end: 3 },
    ]))
    // 拿到内部 scaleTimingSidecar：经 createMontageVoiceIpc 不可直接取 → 用导出面外的
    // 既有行为不可测，改为直接验证防御后副作用：文件存在 null 行时缩放不把 null 变 0
    // （scaleTimingSidecar 未导出 → 此处验证等价的 writeTimingSidecar 同域防御逻辑）
    // 导出面补齐见 main/montage-voice-ipc.js（scaleTimingSidecar 已导出）
    M.scaleTimingSidecar(wav, 0.5)
    const j = JSON.parse(fs.readFileSync(p, 'utf8'))
    assert.equal(j[0].start, null, 'null 行原样保留（不被 Number(null)=0 清零）')
    assert.deepEqual([j[1].start, j[1].end], [0.5, 1.5], '合法行正常缩放')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// ── 2026-09-19 用户方案：whisperx 字级流 → 文案对齐 → timing 行（真值替换估算）──

test('alignCopyToWords：单字中文 1:1 锚定；ASR 合并/错字 → 无 span 降级（回退整段窗口），不错位', () => {
  const copy = '罗技PRO X 2耳机，记忆泡沫。'
  const words = [
    { word: '罗', start: 0, end: 0.2 },
    { word: '技', start: 0.2, end: 0.4 },
    { word: 'Lightspeed', start: 0.4, end: 1.4 },   // ASR 合并了 PRO X 2 LIGHTSPEED
    { word: '耳机', start: 1.4, end: 1.8 },
    { word: '技以', start: 2.0, end: 2.4 },   // ASR 错字（应=记忆）
    { word: '泡沫', start: 2.4, end: 2.8 },
  ]
  const chars = M.alignCopyToWords(copy, words)
  const byC = (c) => chars.filter((x) => x.c === c)
  assert.equal(byC('罗')[0].start, 0)
  assert.equal(byC('技')[0].end, 0.4)
  // ASR 把 PRO X 2 LIGHTSPEED 合并成 Lightspeed：P/R/O/X/2 首字不匹配 → null（降级）
  byC('P').forEach((x) => assert.equal(x.start, null))
  // 耳机 首字匹配 → 整 token span
  assert.deepEqual([byC('耳')[0].start, byC('耳')[0].end], [1.4, 1.8])
  // ASR 错字（技以≠记忆）：记 无 span；泡沫 首字匹配
  byC('记').forEach((x) => assert.equal(x.start, null))
  assert.ok(byC('泡').some((x) => x.start !== null), '泡沫 应锚定')
})

test('charsToTimingRows：句读分行、行带 chars、无命中行内插补窗保证 end>start', () => {
  const copy = 'abcdef。ghijkl。'
  const chars = [
    ...M.alignCopyToWords('abcdef', [{ word: 'abcdef', start: 0, end: 3 }]),
    { c: '。', start: null, end: null },
    ...M.alignCopyToWords('ghijkl', [{ word: 'ghijkl', start: 4, end: 7 }]),
    { c: '。', start: null, end: null },
  ]
  const rows = M.charsToTimingRows(copy, chars)
  assert.equal(rows.length, 2)
  assert.deepEqual([rows[0].start, rows[0].end], [0, 3])
  assert.deepEqual([rows[1].start, rows[1].end], [4, 7])
  rows.forEach((r) => assert.equal(r.chars.length, r.text.length))
})
