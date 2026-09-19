// 字幕对齐增强（2026-09-19）单测：silencedetect 解析 + 句窗口实测对齐
// 被测：main/montage-voice-ipc.js parseSilencedetect / alignTimingToSpeech
import { test } from 'node:test'
import assert from 'node:assert/strict'

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
