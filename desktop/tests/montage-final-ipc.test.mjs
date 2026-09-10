// ═══════════════════════════════════════════════════════════════
// montage-final-ipc.test.mjs — 智能混剪 Step4 服务端统一合成纯函数单测
// 对照：main/montage-final-ipc.js buildSrtFromTiming/buildServerFxFields ↔
//   在线契约 POST /montage/concat（multipart）subtitle_*/fancy_*/text_template_*
//   原版 _submit_concat_to_server 口径（pr4.diff）：
//   subtitle_style=JSON{box_opacity}；fancy_timing='subtitle_sync'；
//   模板序列化 JSON + id；文案服务端自动提取
// ═══════════════════════════════════════════════════════════════
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const M = require('../main/montage-final-ipc.js')

// ── buildSrtFromTiming ──

test('buildSrtFromTiming: timing.json 优先 → 句级时间轴 SRT', () => {
  const srt = M.buildSrtFromTiming(
    '第一句\n第二句',
    [
      { text: '第一句', start: 0, end: 2 },
      { text: '第二句', start: 2, end: 4.5 },
    ],
    4.5,
  )
  assert.ok(srt.startsWith('1\n00:00:00,000 --> 00:00:02,000\n第一句\n'))
  assert.ok(srt.endsWith('2\n00:00:02,000 --> 00:00:04,500\n第二句'))
})

test('buildSrtFromTiming: 无 timing → 字数比例均分到视频时长', () => {
  const srt = M.buildSrtFromTiming('第一句啊\n第二句', null, 10)
  assert.ok(srt.includes('00:00:00,000 -->'))
  assert.ok(srt.includes('第一句啊'))
  // 句间隔至少 0.2s（max(start+0.2, end) 口径）
  assert.ok(srt.includes('第二句'))
})

test('buildSrtFromTiming: 空文本/无行 → 空串', () => {
  assert.equal(M.buildSrtFromTiming('', null, 10), '')
  assert.equal(M.buildSrtFromTiming('   \n  ', null, 10), '')
})

// ── buildServerFxFields（在线契约字段名与口径）──

test('buildServerFxFields: 字幕 → burn_subtitle/fontname/subtitle_style(JSON)', () => {
  const f = M.buildServerFxFields(
    { addSubtitles: true, subtitleFont: '微软雅黑', subtitleBoxOpacity: 0.5 },
    '1\n00:00:00,000 --> 00:00:02,000\n第一句',
  )
  assert.equal(f.burn_subtitle, 'true')
  assert.equal(f.fontname, '微软雅黑')
  assert.deepEqual(JSON.parse(f.subtitle_style), { box_opacity: 0.5 })
  assert.ok(String(f.subtitle_srt).includes('第一句'))
})

test('buildServerFxFields: box_opacity 越界钳制 0-1；无 SRT 不传', () => {
  const f = M.buildServerFxFields({ addSubtitles: true, subtitleBoxOpacity: 2.5 }, '')
  assert.deepEqual(JSON.parse(f.subtitle_style), { box_opacity: 1 })
  assert.ok(!('subtitle_srt' in f))
})

test('buildServerFxFields: 花字 → fancy_timing=subtitle_sync + 模板序列化 + id', () => {
  const f = M.buildServerFxFields({
    fancyText: true,
    fancyStyle: 'gold',
    fancyPosition: 'upper_middle',
    fancyTemplate: JSON.stringify({ template_id: 'tpl_9', name: '金光' }),
  }, '')
  assert.equal(f.fancy_enabled, 'true')
  assert.equal(f.fancy_timing, 'subtitle_sync')
  assert.equal(f.fancy_style, 'gold')
  assert.equal(f.fancy_position, 'upper_middle')
  assert.deepEqual(JSON.parse(f.fancy_template), { template_id: 'tpl_9', name: '金光' })
  assert.equal(f.fancy_template_id, 'tpl_9')
})

test('buildServerFxFields: 文字模板 → enabled/id(非 random)/words(JSON) + match_density 透传', () => {
  const f = M.buildServerFxFields(
    { textFxEnabled: true, textTemplateId: 'tt_3', textTemplateWords: ['爆款', '上新'], matchDensity: 'mid' },
    '',
  )
  assert.equal(f.text_template_enabled, 'true')
  assert.equal(f.text_template_id, 'tt_3')
  assert.deepEqual(JSON.parse(f.text_template_words), ['爆款', '上新'])
  assert.equal(f.text_template_match_density, 'mid')
})

test('buildServerFxFields: random 模板 → match_enabled 自动匹配（不传 id）', () => {
  const f = M.buildServerFxFields(
    { textFxEnabled: true, textTemplateId: 'random', textTemplateWords: ['爆款'], matchDensity: 'low' },
    '',
  )
  assert.ok(!('text_template_id' in f))
  assert.equal(f.text_template_match_enabled, 'true')
  assert.equal(f.text_template_match_density, 'low')
})

test('buildServerFxFields: match_density 非法/缺省不传（走服务端默认 high）', () => {
  const f = M.buildServerFxFields({ textFxEnabled: true, matchDensity: 'ultra' }, '')
  assert.ok(!('text_template_match_density' in f))
  const g = M.buildServerFxFields({ textFxEnabled: true }, '')
  assert.ok(!('text_template_match_density' in g))
})

test('buildServerFxFields: 模板 id=random 走 match 自动匹配；words 空数组不传', () => {
  const f = M.buildServerFxFields(
    { textFxEnabled: true, textTemplateId: 'random', textTemplateWords: [] },
    '',
  )
  assert.ok(!('text_template_id' in f))
  assert.ok(!('text_template_words' in f))
})

test('buildServerFxFields: 全关 → 空对象（零开销直通）', () => {
  assert.deepEqual(M.buildServerFxFields({}, ''), {})
})
