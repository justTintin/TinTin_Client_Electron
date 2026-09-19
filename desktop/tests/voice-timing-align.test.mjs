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

// ── 2026-09-19 用户方案：cues+字级词流 → timing 行（服务端双返回直接取用，零切片）──

test('buildRowsFromCues：cues 原样为行；行内可见字符与时间窗词流 1:1 配对（标点 null）', () => {
  const rows = M.buildRowsFromCues(
    [
      { text: '粉色控的终极梦想来了，', start: 0.06, end: 2.282 },
      { text: '专业级无感延迟，', start: 7.646, end: 9.388 },
    ],
    [
      { word: '粉', start: 0.06, end: 0.3 },
      { word: '色', start: 0.3, end: 0.5 },
      { word: '无', start: 7.65, end: 7.9 },
      { word: '感', start: 7.9, end: 8.1 },
      { word: '延', start: 8.15, end: 8.4 },
      { word: '迟', start: 8.4, end: 8.7 },
    ],
  )
  assert.equal(rows.length, 2)
  // 行=服务端 cue 原样（文案原文+真值窗口），零切片零改写
  assert.equal(rows[0].text, '粉色控的终极梦想来了，')
  assert.deepEqual([rows[0].start, rows[0].end], [0.06, 2.282])
  assert.deepEqual([rows[1].start, rows[1].end], [7.646, 9.388])
  // 行 chars 与行文本逐字对应，可见字符按序吃词流
  rows.forEach((r) => assert.equal(r.chars.length, Array.from(r.text).length))
  assert.equal(rows[0].chars[0].start, 0.06)              // 粉
  assert.equal(rows[1].chars[3].start, 7.65)              // 无
  // 标点不占词流
  const wan = rows[1].chars.find((x) => x.c === '延')
  assert.equal(wan.start, 8.15)
})

test('buildRowsFromCues：无效 cue 丢弃；词流为空 → 行保留但 chars 全 null', () => {
  const rows = M.buildRowsFromCues(
    [
      { text: '正常', start: 1, end: 2 },
      { text: '坏行', start: 5, end: 3 },   // end<=start 丢弃
      { text: '无词', start: 3, end: 4 },
    ],
    [],
  )
  assert.equal(rows.length, 2)
  assert.equal(rows[0].text, '正常')
  assert.equal(rows[1].text, '无词')
  assert.ok(rows[1].chars.every((c) => c.start === null))
})
