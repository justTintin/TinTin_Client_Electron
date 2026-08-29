// ═══════════════════════════════════════════════════════════════
// srt-utils.test.mjs — SRT 解析/生成/格式转换/编辑回写 纯逻辑单测（M2 条目③）
// 被测：renderer/src/composables/srtUtils.ts（纯函数，无 vue/IPC 依赖）
// 对照原客户端 studio/utils/srt_utils.py：
//   · parse_srt_time/parse_srt L35-78、segments_to_srt L81-97
// 对照原客户端 studio/gui/transcription_page.py：
//   · _convert_format L973-999（srt/vtt/txt/plain 四格式）
//   · _plain_to_srt L678-693 + _split_text_into_chunks L35-49（润色回写保留时间轴）
//   · _apply_edits L853-887（未改段保留 words、改动段打 edited 标记）
//   · _on_file_done 预览 L1107-1127（首段前 50 字）
//   · /v1/audio/transcriptions 响应防御解析（segments/text/裸文本多形态）
// 运行：node --test "tests/*.test.mjs"
// ═══════════════════════════════════════════════════════════════

import { test } from 'node:test'
import assert from 'node:assert/strict'

const S = await import('../renderer/src/composables/srtUtils.ts')

// ── 时间戳（对照 srt_utils.parse_srt_time / transcription_page._fmt_srt_time）──

test('formatSrtTimestamp：秒 → HH:MM:SS,mmm', () => {
  assert.equal(S.formatSrtTimestamp(0), '00:00:00,000')
  assert.equal(S.formatSrtTimestamp(3661.5), '01:01:01,500')
  assert.equal(S.formatSrtTimestamp(59.9996), '00:01:00,000') // 进位
})

test('formatVttTimestamp：秒 → HH:MM:SS.mmm', () => {
  assert.equal(S.formatVttTimestamp(3661.5), '01:01:01.500')
})

// ── segments ↔ SRT（对照 srt_utils.segments_to_srt / parse_srt）──

test('segmentsToSrt：序号+时间轴+正文，speaker 加前缀', () => {
  const srt = S.segmentsToSrt([
    { start: 0, end: 1.5, text: '你好' },
    { start: 2, end: 3, text: '再见', speaker: 'A' },
  ])
  assert.ok(srt.includes('00:00:00,000 --> 00:00:01,500'))
  assert.ok(srt.includes('你好'))
  assert.ok(srt.includes('[A]: 再见'))
})

test('parseSrt：标准 SRT 解析（序号行忽略、正文跨行合并）', () => {
  const srt = '1\n00:00:00,000 --> 00:00:01,500\n你好\n\n2\n00:00:02,000 --> 00:00:03,000\n世界\n第二行\n'
  const segs = S.parseSrt(srt)
  assert.equal(segs.length, 2)
  assert.equal(segs[0].start, 0)
  assert.equal(segs[0].end, 1.5)
  assert.equal(segs[0].text, '你好')
  assert.equal(segs[1].text, '世界 第二行')
  assert.deepEqual(segs[1].words, [])
})

test('parseSrt：按 start 排序、过滤空正文段', () => {
  const srt = '1\n00:00:02,000 --> 00:00:03,000\n后\n\n2\n00:00:00,000 --> 00:00:01,000\n\n3\n00:00:00,500 --> 00:00:01,500\n前\n'
  const segs = S.parseSrt(srt)
  assert.equal(segs.length, 2)
  assert.equal(segs[0].text, '前')
  assert.equal(segs[1].text, '后')
})

test('segmentsToSrt ↔ parseSrt 往返一致', () => {
  const segs = [
    { start: 0.5, end: 2.25, text: '第一段', words: [] },
    { start: 3, end: 4, text: '第二段', words: [{ word: '第', start: 3, end: 3.1 }] },
  ]
  const back = S.parseSrt(S.segmentsToSrt(segs))
  assert.equal(back.length, 2)
  assert.equal(back[0].text, '第一段')
  assert.equal(back[0].start, 0.5)
  assert.equal(back[1].end, 4)
})

// ── 格式转换（对照 transcription_page._convert_format L973-999）──

const FIX_SRT = '1\n00:00:01,000 --> 00:00:02,000\n甲\n\n2\n00:00:03,000 --> 00:00:04,500\n乙\n'

test('convertSrtFormat srt：原样返回', () => {
  assert.equal(S.convertSrtFormat(FIX_SRT, 'srt'), FIX_SRT)
})

test('convertSrtFormat vtt：WEBVTT 头 + 逗号时间戳换点', () => {
  const vtt = S.convertSrtFormat(FIX_SRT, 'vtt')
  assert.ok(vtt.startsWith('WEBVTT\n\n'))
  assert.ok(vtt.includes('00:00:01.000 --> 00:00:02.000'))
  assert.ok(vtt.includes('甲'))
})

test('convertSrtFormat txt：[起始时间] 正文', () => {
  const txt = S.convertSrtFormat(FIX_SRT, 'txt')
  assert.equal(txt, '[00:00:01,000] 甲\n[00:00:03,000] 乙')
})

test('convertSrtFormat plain：仅正文', () => {
  assert.equal(S.convertSrtFormat(FIX_SRT, 'plain'), '甲\n乙')
})

// ── 润色回写（对照 _plain_to_srt L678-693 + _split_text_into_chunks L35-49）──

test('splitTextIntoChunks：句子均分到 n 段（round-robin，chunk 非空时追加 句子+。；对照原 L47）', () => {
  // 4 句分 2 段：第1、3句 → 段0，第2、4句 → 段1
  // 原版 chunks[idx % n] += (p + "。" if chunks[idx % n] else p)：不加句间分隔符，只补尾句号
  const chunks = S.splitTextIntoChunks('一。二。三。四。', 2)
  assert.equal(chunks.length, 2)
  assert.equal(chunks[0], '一三。')
  assert.equal(chunks[1], '二四。')
})

test('plainToSrt：保留原时间轴，新文案按段均分（句数≤段数时不追加句号，对照原 L42-43）', () => {
  const newSrt = S.plainToSrt('新甲。新乙。', FIX_SRT)
  assert.ok(newSrt.includes('00:00:01,000 --> 00:00:02,000'))
  assert.ok(newSrt.includes('00:00:03,000 --> 00:00:04,500'))
  assert.ok(newSrt.includes('新甲'))
  assert.ok(newSrt.includes('新乙'))
  assert.ok(newSrt.includes('1\n'))
})

test('plainToSrt：原 SRT 无时间轴 → 原样返回', () => {
  assert.equal(S.plainToSrt('新文案', '没有时间轴的文本'), '没有时间轴的文本')
})

// ── 编辑回写（对照 _apply_edits L853-887）──

const CUR = [
  { start: 0, end: 1, text: '未改', words: [{ word: '未', start: 0, end: 0.5 }] },
  { start: 2, end: 3, text: '改掉', words: [{ word: '改', start: 2, end: 2.5 }] },
]

test('applyEdits：未改段保留 words，改动段标 edited，新增段标 edited', () => {
  const editedSrt =
    '1\n00:00:00,000 --> 00:00:01,000\n未改\n\n2\n00:00:02,000 --> 00:00:03,000\n已改\n\n3\n00:00:05,000 --> 00:00:06,000\n新增\n'
  const out = S.applyEditsToSegments(editedSrt, CUR, null)
  assert.ok(out)
  assert.equal(out.segments[0].text, '未改')
  assert.equal(out.segments[0].edited, false) // 与基准一致
  assert.equal(out.segments[0].words.length, 1) // 未改段保留字级时间戳
  assert.equal(out.segments[1].text, '已改')
  assert.equal(out.segments[1].edited, true)
  assert.equal(out.segments[1].words.length, 0) // 改动段不保留旧 words
  assert.equal(out.segments[2].edited, true) // 新增段
  // 首次编辑时快照基准
  assert.equal(out.origSegments.length, 2)
})

test('applyEdits：文本无法解析出任何段 → 返回 null（编辑不生效）', () => {
  assert.equal(S.applyEditsToSegments('纯文本无时间轴', CUR, null), null)
})

// ── 预览（对照 _on_file_done L1113-1122 首段前 50 字）──

test('buildSrtPreview：取第一段正文前 50 字', () => {
  const long = '一'.repeat(60)
  const preview = S.buildSrtPreview(`1\n00:00:00,000 --> 00:00:01,000\n${long}\n`)
  assert.equal(preview.length, 50)
})

// ── /v1/audio/transcriptions 响应防御解析（多形态，禁止臆造单一形状）──

test('parseTranscriptionResponse：verbose_json segments+words', () => {
  const segs = S.parseTranscriptionResponse({
    text: '全文',
    segments: [{ start: 0, end: 1.2, text: '你好' }],
  })
  assert.equal(segs.length, 1)
  assert.equal(segs[0].end, 1.2)
})

test('parseTranscriptionResponse：嵌套 result.segments（对照原 asr_client L233）', () => {
  const segs = S.parseTranscriptionResponse({ result: { segments: [{ start: 1, end: 2, text: '嵌套' }] } })
  assert.equal(segs.length, 1)
  assert.equal(segs[0].text, '嵌套')
})

test('parseTranscriptionResponse：仅 text → 单段兜底（对照原 asr_client L235-237）', () => {
  const segs = S.parseTranscriptionResponse({ text: '纯文本结果' })
  assert.deepEqual(segs, [{ start: 0, end: 0, text: '纯文本结果' }])
})

test('parseTranscriptionResponse：裸字符串（response_format=text）', () => {
  const segs = S.parseTranscriptionResponse('裸文本')
  assert.equal(segs.length, 1)
  assert.equal(segs[0].text, '裸文本')
})

test('parseTranscriptionResponse：空/无效输入 → 空数组', () => {
  assert.deepEqual(S.parseTranscriptionResponse(null), [])
  assert.deepEqual(S.parseTranscriptionResponse({}), [])
  assert.deepEqual(S.parseTranscriptionResponse(''), [])
})
