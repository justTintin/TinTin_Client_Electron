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
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

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
  // cue 之间必须空行分隔（标准 SRT）：缺空行会被严格解析器当 1 条 cue，文本塞满
  // 编号/时间戳行 → 行级命中退化为整片一个动画（2026-09-11 服务端 #914 实测教训）
  assert.ok(srt.includes('第一句\n\n2\n'))
  assert.equal(srt.split(/\n\n/).length, 2)
})

test('buildSrtFromTiming: 无 timing → 字数比例均分到视频时长', () => {
  const srt = M.buildSrtFromTiming('第一句啊\n第二句', null, 10)
  assert.ok(srt.includes('00:00:00,000 -->'))
  assert.ok(srt.includes('第一句啊'))
  // 句间隔至少 0.2s（max(start+0.2, end) 口径）
  assert.ok(srt.includes('第二句'))
  // 无 timing 分支同样空行分隔
  assert.ok(srt.includes('第一句啊\n\n2\n'))
})

test('buildSrtFromTiming: 空文本/无行 → 空串', () => {
  assert.equal(M.buildSrtFromTiming('', null, 10), '')
  assert.equal(M.buildSrtFromTiming('   \n  ', null, 10), '')
})

// ── buildServerFxFields（在线契约字段名与口径）──

test('buildServerFxFields: 字幕 → burn_subtitle/font_id/subtitle_style(JSON)', () => {
  const f = M.buildServerFxFields(
    // 客户端字体下拉 value 就是服务端字体 id（GET /config/fonts）→ 走契约 font_id；
    // 旧实现误将 id 当族名传 fontname（2026-09-11 纠偏）
    { addSubtitles: true, subtitleFont: 'msyh_001', subtitleBoxOpacity: 0.5 },
    '1\n00:00:00,000 --> 00:00:02,000\n第一句',
  )
  assert.equal(f.burn_subtitle, 'true')
  assert.equal(f.font_id, 'msyh_001')
  assert.ok(!('fontname' in f))
  assert.deepEqual(JSON.parse(f.subtitle_style), { box_opacity: 0.5 })
  assert.ok(String(f.subtitle_srt).includes('第一句'))
})

test('buildServerFxFields: 字幕动画开启不影响服务端字段（按钮决定链路，参数只是参数）', () => {
  // 2026-09-11 用户终裁：服务端契约无字幕动画字段，动画参数不产生任何字段，
  // 也不再作为渲染层改走本地的理由
  const f = M.buildServerFxFields(
    { addSubtitles: true, subtitleAnim: 'rise', subtitleStyle: 'white' },
    '1\n00:00:00,000 --> 00:00:02,000\n第一句',
  )
  assert.equal(f.burn_subtitle, 'true')
  assert.ok(!Object.keys(f).some((k) => /anim/i.test(k)))
})

test('buildServerFxFields: box_opacity 越界钳制 0-1；无 SRT 不传', () => {
  const f = M.buildServerFxFields({ addSubtitles: true, subtitleBoxOpacity: 2.5 }, '')
  assert.deepEqual(JSON.parse(f.subtitle_style), { box_opacity: 1 })
  assert.ok(!('subtitle_srt' in f))
})

test('buildServerFxFields: subtitleStyleObj → 服务端样式对象原样回传，box 不透明度用滑块重写', () => {
  const f = M.buildServerFxFields({
    addSubtitles: true,
    subtitleStyleObj: { color: '#FFE135', outline: 3, outline_colour: 'black', box: 'black@0.9', fontsize: 12, margin: 8 },
    subtitleBoxOpacity: 0.35,
  }, '')
  const st = JSON.parse(f.subtitle_style)
  // 文字色/描边/字号/边距原样透传
  assert.equal(st.color, '#FFE135')
  assert.equal(st.outline, 3)
  assert.equal(st.outline_colour, 'black')
  assert.equal(st.fontsize, 12)
  assert.equal(st.margin, 8)
  // box 底色沿用样式(black)，不透明度改为客户端滑块 0.35
  assert.equal(st.box, 'black@0.35')
  // 不再回退旧口径 box_opacity
  assert.ok(!('box_opacity' in st))
})

test('buildServerFxFields: subtitleStyleObj + 滑块=0 → 删 box（无背景框）', () => {
  const f = M.buildServerFxFields({
    addSubtitles: true,
    subtitleStyleObj: { color: 'white', box: 'black@0.6' },
    subtitleBoxOpacity: 0,
  }, '')
  const st = JSON.parse(f.subtitle_style)
  assert.equal(st.color, 'white')
  assert.ok(!('box' in st))
})

test('buildServerFxFields: 服务端样式对象+预设 key → subtitle_style_id 透传；离线兜底不发（2026-09-18 契约对齐）', () => {
  // live /openapi.json：/montage/concat 收 subtitle_style_id（字幕样式库 id，见 GET /subtitle_styles）
  const f = M.buildServerFxFields({
    addSubtitles: true,
    subtitleStyle: 'top_title', // 渲染层预设 key=服务端 style.id
    subtitleStyleObj: { color: '#FFD700', outline: 3 },
  }, '')
  assert.equal(f.subtitle_style_id, 'top_title')
  assert.ok(String(f.subtitle_style).includes('#FFD700'))
  // 无服务端样式对象（离线兜底本地键）→ 不发 id，防误命中库 id
  const g = M.buildServerFxFields({ addSubtitles: true, subtitleStyle: 'std_bottom' }, '')
  assert.ok(!('subtitle_style_id' in g))
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

test('buildServerFxFields: 文字模板 → enabled/id(非 random) + match_density 透传；不传词表', () => {
  const f = M.buildServerFxFields(
    { textFxEnabled: true, textTemplateId: 'tt_3', textTemplateWords: ['爆款', '上新'], matchDensity: 'mid' },
    '',
  )
  assert.equal(f.text_template_enabled, 'true')
  assert.equal(f.text_template_id, 'tt_3')
  // 2026-09-11 用户裁决：词表废止——即便上游残留 words 也不再透传，命中由服务端从字幕做
  assert.ok(!('text_template_words' in f))
  assert.ok(!('text_template_match_ids' in f))
  // 2026-09-13 接口对齐：density 属 match 模式参数，指定模板（text_template_id）不再透传
  assert.ok(!('text_template_match_density' in f))
})

test('buildServerFxFields: random 模板 → match_enabled 自动匹配（不传 id；match_ids 必填透传）', () => {
  const f = M.buildServerFxFields(
    { textFxEnabled: true, textTemplateId: 'random', textTemplateMatchIds: ['tt_1', 'tt_5'], matchDensity: 'low' },
    '',
  )
  assert.ok(!('text_template_id' in f))
  assert.equal(f.text_template_match_enabled, 'true')
  assert.deepEqual(JSON.parse(f.text_template_match_ids), ['tt_1', 'tt_5'])
  assert.equal(f.text_template_match_density, 'low')
})

test('buildServerFxFields: lutRestore 勾选 → lut_restore=true；默认/未勾选不传（2026-09-14 服务端口径）', () => {
  const on = M.buildServerFxFields({ lutRestore: true }, '')
  assert.equal(on.lut_restore, 'true')
  const off = M.buildServerFxFields({}, '')
  assert.ok(!('lut_restore' in off), '默认不传（服务端默认 false=不还原 LUT）')
  const sfx = M.buildServerFxFields({ lutRestore: true, textFxEnabled: true, textTemplateId: 'random', textTemplateMatchIds: ['tt_1'] }, '')
  assert.equal(sfx.lut_restore, 'true')
  assert.equal(sfx.text_template_match_enabled, 'true', '与文字模板字段互不干扰')
})

test('buildServerFxFields: match_id 已随 /text_templates/match 下线作废，任何入参都不再下发（2026-09-19）', () => {
  // 2026-09-13 曾有「预取回执 match_id 复用」口径；match 接口删除后该机制作废，
  // 服务端 concat 无 match_id 时按词表（text_template_words）或旧口径自行命中
  const f = M.buildServerFxFields(
    { textFxEnabled: true, textTemplateId: 'random', textTemplateMatchIds: ['tt_1', 'tt_5'], matchDensity: 'mid' },
    '',
  )
  assert.equal(f.text_template_enabled, 'true')
  assert.equal(f.text_template_match_enabled, 'true')
  assert.deepEqual(JSON.parse(f.text_template_match_ids), ['tt_1', 'tt_5'])
  assert.ok(!('text_template_match_id' in f))
})

test('buildServerFxFields: 指定模板 → 仍走 text_template_id（match 模式字段不适用）', () => {
  const f = M.buildServerFxFields(
    { textFxEnabled: true, textTemplateId: 'tt_3' },
    '',
  )
  assert.equal(f.text_template_id, 'tt_3')
  assert.ok(!('text_template_match_id' in f))
  assert.ok(!('text_template_match_enabled' in f))
})

test('buildServerFxFields: match_density 非法/缺省不传（走服务端默认 high）', () => {
  const f = M.buildServerFxFields({ textFxEnabled: true, matchDensity: 'ultra' }, '')
  assert.ok(!('text_template_match_density' in f))
  const g = M.buildServerFxFields({ textFxEnabled: true }, '')
  assert.ok(!('text_template_match_density' in g))
})

test('buildServerFxFields: random 无模板池 → match_enabled 照传；words/match_ids 均不出现', () => {
  const f = M.buildServerFxFields(
    { textFxEnabled: true, textTemplateId: 'random', textTemplateWords: [], textTemplateMatchIds: [] },
    '',
  )
  assert.ok(!('text_template_id' in f))
  assert.equal(f.text_template_match_enabled, 'true')
  assert.ok(!('text_template_words' in f))
  assert.ok(!('text_template_match_ids' in f))
})

// 2026-09-11 用户裁决：字幕是烧字幕/花字/文字模板的共同数据源，任一特效开启即随
// 请求下发；burn_subtitle 只决定是否烧进画面（match 模式无字幕会被服务端 400 拒绝）
test('buildServerFxFields: subtitle_srt 随任一依赖字幕的特效下发（不依赖 burn_subtitle）', () => {
  const srt = '1\n00:00:00,000 --> 00:00:01,000\n只要199元'
  const a = M.buildServerFxFields({ textFxEnabled: true, textTemplateId: 'random' }, srt)
  assert.equal(a.subtitle_srt, srt)
  assert.ok(!('burn_subtitle' in a))
  const b = M.buildServerFxFields({ fancyText: true, fancyStyle: 'gold', fancyPosition: 'upper_middle' }, srt)
  assert.equal(b.subtitle_srt, srt)
  assert.ok(!('burn_subtitle' in b))
  // 全关 → 不传字幕（零开销直通）
  assert.ok(!('subtitle_srt' in M.buildServerFxFields({}, srt)))
})

test('buildServerFxFields: 全关 → 空对象（零开销直通）', () => {
  assert.deepEqual(M.buildServerFxFields({}, ''), {})
})

// ── serverComposeOne（2026-09-11 终裁：特效 + BGM 一次 concat 完成）──
// 用假 httpRequest 捕获提交体，钉住三件实测坑换来的约束：
//  ① 必须回传源 width/height/fps（否则服务端按默认 1080x1920@30 改写产物）
//  ② BGM 随 concat 上传（不走 /montage/bgm：其 video_url 实测 404 死链）
//  ③ 产物校验不过必须抛错（调用方报错，不静默回退本地）

function makeTmpVideos() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-concat-'))
  const video = path.join(dir, 'in.mp4')
  const bgm = path.join(dir, 'bgm.mp3')
  const bgmWav = path.join(dir, 'bgm2.wav')
  const voice = path.join(dir, 'v.wav')
  fs.writeFileSync(video, Buffer.alloc(4096, 7))
  fs.writeFileSync(bgm, Buffer.alloc(512, 9))
  fs.writeFileSync(bgmWav, Buffer.alloc(512, 11))
  fs.writeFileSync(voice, Buffer.alloc(512, 13))
  return { dir, video, bgm, bgmWav, voice, out: path.join(dir, 'out.mp4') }
}

/** 假 httpRequest：POST 捕获提交体，GET 返回大于 1KB 的 video 体（让轮询立即结束）
 *  —— 产物是假字节，因无 moov 故 getMediaDuration 必失败 → 用于断言提交内容后抛错 */
function fakeHttp(onPost) {
  return async (method, url, opts) => {
    if (method === 'POST') {
      onPost && onPost(url, opts.body)
      return { data: { id: 999 } }
    }
    return { raw: Buffer.alloc(4096, 3), headers: { 'content-type': 'video/mp4' } }
  }
}

test('serverComposeOne: 特效+源规格+BGM 同一次 /montage/concat 提交', async () => {
  const t = makeTmpVideos()
  let postedUrl = ''
  let body = ''
  const httpRequest = fakeHttp((u, b) => { postedUrl = u; body = b.toString('latin1') })
  const fx = { addSubtitles: true, subtitleFont: 'msyh_001', subtitleBoxOpacity: 0.5, fancyText: true }
  await assert.rejects(
    () => M.serverComposeOne({
      httpRequest, videoPath: t.video, outPath: t.out,
      fx, sub: { text: '第一句', timingPath: '' }, videoDur: 3,
      spec: { durationSec: 3, width: 720, height: 1280, fps: 25 },
      bgmPath: t.bgm, bgmVol: 0.8,
    }),
    /产物无法读取/, // 假字节无 moov → 必拒（防截断产物冒充成功）
  )
  assert.equal(postedUrl, '/montage/concat')
  assert.match(body, /name="files"; filename="in\.mp4"/)
  assert.match(body, /name="bgm"; filename="bgm\.mp3"/) // BGM 随 concat 上传
  assert.ok(body.includes('name="bgm_volume"\r\n\r\n0.80'))
  assert.ok(body.includes('name="width"\r\n\r\n720')) // 源规格回传
  assert.ok(body.includes('name="height"\r\n\r\n1280'))
  assert.ok(body.includes('name="fps"\r\n\r\n25'))
  assert.ok(body.includes('name="burn_subtitle"\r\n\r\ntrue'))
  assert.ok(body.includes('name="font_id"\r\n\r\nmsyh_001'))
  assert.ok(!body.includes('name="fontname"'))
  assert.ok(!body.includes('voice_mode')) // 无 voicePath → 不附配音轨
  fs.rmSync(t.dir, { recursive: true, force: true })
})

test('serverComposeOne: 无特效（fx=null）仅混音 → 不传字幕字段，仍走 concat', async () => {
  const t = makeTmpVideos()
  let body = ''
  const httpRequest = fakeHttp((_u, b) => { body = b.toString('latin1') })
  await assert.rejects(
    () => M.serverComposeOne({
      httpRequest, videoPath: t.video, outPath: t.out,
      fx: null, sub: null, videoDur: 3,
      spec: { durationSec: 3, width: 1920, height: 1080, fps: 30 },
      bgmPath: t.bgm, bgmVol: 0.6,
    }),
    /产物无法读取/,
  )
  assert.ok(!body.includes('name="burn_subtitle"'))
  assert.ok(!body.includes('name="subtitle_srt"'))
  assert.match(body, /name="bgm"/) // 横屏素材也必须回传源规格，否则被掰成竖屏
  assert.ok(body.includes('name="width"\r\n\r\n1920'))
  assert.ok(body.includes('name="height"\r\n\r\n1080'))
  fs.rmSync(t.dir, { recursive: true, force: true })
})

test('serverComposeOne: 无 BGM 文件 → 不附 bgm 部分也不传 bgm_volume', async () => {
  const t = makeTmpVideos()
  let body = ''
  const httpRequest = fakeHttp((_u, b) => { body = b.toString('latin1') })
  await assert.rejects(
    () => M.serverComposeOne({
      httpRequest, videoPath: t.video, outPath: t.out,
      fx: null, sub: null, videoDur: 3,
      spec: { durationSec: 3, width: 720, height: 1280, fps: 25 },
      bgmPath: '', bgmVol: 0.6,
    }),
    /产物无法读取/,
  )
  assert.ok(!body.includes('name="bgm";'))
  assert.ok(!body.includes('name="bgm_volume"'))
  fs.rmSync(t.dir, { recursive: true, force: true })
})

test('serverComposeOne: fps=0（可变帧率探测失败）→ 不回传 fps，交服务端默认', async () => {
  const t = makeTmpVideos()
  let body = ''
  const httpRequest = fakeHttp((_u, b) => { body = b.toString('latin1') })
  await assert.rejects(
    () => M.serverComposeOne({
      httpRequest, videoPath: t.video, outPath: t.out,
      fx: null, sub: null, videoDur: 3,
      spec: { durationSec: 3, width: 720, height: 1280, fps: 0 },
      bgmPath: '', bgmVol: 0.6,
    }),
    /产物无法读取/,
  )
  assert.ok(!body.includes('name="fps"'))
  assert.ok(body.includes('name="width"\r\n\r\n720'))
  fs.rmSync(t.dir, { recursive: true, force: true })
})

// ── voice 配音轨（2026-09-11 统一合成契约提案③接线）──

test('serverComposeOne: 配音 wav → voice 字段 + voice_mode=replace（ctype 按扩展名）', async () => {
  const t = makeTmpVideos()
  let body = ''
  const httpRequest = fakeHttp((_u, b) => { body = b.toString('latin1') })
  await assert.rejects(
    () => M.serverComposeOne({
      httpRequest, videoPath: t.video, outPath: t.out,
      fx: null, sub: { text: '口播', timingPath: '', voicePath: t.voice }, videoDur: 3,
      spec: { durationSec: 3, width: 720, height: 1280, fps: 25 },
      bgmPath: '', bgmVol: 0.6,
    }),
    /产物无法读取/,
  )
  assert.match(body, /name="voice"; filename="v\.wav"/)
  assert.ok(body.includes('Content-Type: audio/wav')) // 扩展名映射（旧实现只固定 audio/mpeg）
  assert.ok(body.includes('name="voice_mode"\r\n\r\nreplace')) // 口播默认替换原声
  fs.rmSync(t.dir, { recursive: true, force: true })
})

test('serverComposeOne: voicePath 文件缺失 → 不附 voice 也不传 voice_mode', async () => {
  const t = makeTmpVideos()
  let body = ''
  const httpRequest = fakeHttp((_u, b) => { body = b.toString('latin1') })
  await assert.rejects(
    () => M.serverComposeOne({
      httpRequest, videoPath: t.video, outPath: t.out,
      fx: null, sub: { text: '口播', timingPath: '', voicePath: path.join(t.dir, 'nope.wav') }, videoDur: 3,
      spec: { durationSec: 3, width: 720, height: 1280, fps: 25 },
      bgmPath: '', bgmVol: 0.6,
    }),
    /产物无法读取/,
  )
  assert.ok(!body.includes('name="voice"'))
  assert.ok(!body.includes('voice_mode'))
  fs.rmSync(t.dir, { recursive: true, force: true })
})

test('serverComposeOne: bgm_volume clamp 0~1（0 不回退 0.6）且 wav BGM ctype 正确', async () => {
  const t = makeTmpVideos()
  const bodies = []
  const httpRequest = fakeHttp((_u, b) => { bodies.push(b.toString('latin1')) })
  for (const vol of [0, 1.5, undefined]) {
    await assert.rejects(
      () => M.serverComposeOne({
        httpRequest, videoPath: t.video, outPath: t.out,
        fx: null, sub: null, videoDur: 3,
        spec: { durationSec: 3, width: 720, height: 1280, fps: 25 },
        bgmPath: t.bgmWav, bgmVol: vol,
      }),
      /产物无法读取/,
    )
  }
  assert.ok(bodies[0].includes('name="bgm_volume"\r\n\r\n0.00')) // 0=静音合法值，不再回退 0.6
  assert.ok(bodies[1].includes('name="bgm_volume"\r\n\r\n1.00')) // 1.5 → clamp 1（契约 0~1）
  assert.ok(bodies[2].includes('name="bgm_volume"\r\n\r\n0.60')) // 缺省 → 契约默认
  assert.ok(bodies[0].includes('Content-Type: audio/wav')) // wav BGM 不再固定 audio/mpeg
  fs.rmSync(t.dir, { recursive: true, force: true })
})

// ── subtitleStyleCard / cssColorFromStyle（剪映模板页「字幕」分类，catalog lane endpoint=/subtitle_styles）──

test('cssColorFromStyle：hex 原样 / 色名映射 / @opacity 剥离 / 空→白', () => {
  assert.equal(M.cssColorFromStyle('#FFD700'), '#FFD700')
  assert.equal(M.cssColorFromStyle('white'), '#FFFFFF')
  assert.equal(M.cssColorFromStyle('black@0.9'), '#000000')
  assert.equal(M.cssColorFromStyle(''), '#FFFFFF')
  assert.equal(M.cssColorFromStyle(undefined), '#FFFFFF')
})

test('subtitleStyleCard：服务端样式条目 → 卡片（color/cssStyle 描边/category=scenario/tags）', () => {
  const card = M.subtitleStyleCard({
    id: 'top_title',
    name: '顶部大字标题',
    style: { pos: 'top', color: '#FFD700', margin: 0.06, outline: 3, fontsize: 0.075 },
    tags: ['标题', '顶部'],
    scenario: '通用',
    preview: '',
  })
  assert.equal(card.id, 'top_title')
  assert.equal(card.name, '顶部大字标题')
  assert.equal(card.color, '#FFD700')
  assert.equal(card.category, '通用')
  assert.deepEqual(card.tags, ['标题', '顶部'])
  // 描边还原（outline=3 → -webkit-text-stroke 3px，outline_colour 缺省 black）
  assert.ok(card.cssStyle.includes('color:#FFD700'))
  assert.ok(card.cssStyle.includes('-webkit-text-stroke:3px #000000'))
  assert.ok(card.cssStyle.includes('paint-order:stroke'))
  // raw 保留原始条目
  assert.equal(card.raw.style.pos, 'top')
})

test('subtitleStyleCard：box="color@opacity" → rgba 背景；无 outline → 无描边', () => {
  const card = M.subtitleStyleCard({
    id: 'box_style',
    name: '黑底白字',
    style: { color: 'white', box: 'black@0.6' },
  })
  assert.equal(card.color, '#FFFFFF')
  assert.ok(!card.cssStyle.includes('-webkit-text-stroke'))
  assert.ok(card.cssStyle.includes('background:rgba(0,0,0,0.6)'))
  assert.deepEqual(card.tags, [])
})

test('subtitleStyleCard: preview 空 → 回落 /subtitle_styles/{id}/preview.png（2026-09-18 新增端点）；非空原样', () => {
  const card = M.subtitleStyleCard({ id: 'top_title', name: '顶部大字标题', style: { color: 'white' }, preview: '' })
  assert.equal(card.preview, '/subtitle_styles/top_title/preview.png')
  const card2 = M.subtitleStyleCard({ id: 'x', name: 'x', style: {}, preview: '/static/a.png' })
  assert.equal(card2.preview, '/static/a.png')
})

// ── parseJianyingCachePath / getJianyingMediaCacheDir（2026-09-17 服务端契约：from-task 导出必填 jianying_cache_dir）──

test('parseJianyingCachePath：globalSetting ini currentCachePath → 媒体缓存根；无键/空文 → 空串', () => {
  const ini = '[General]\nscreenRecordLocation=C:/x\ncurrentCachePath=C:\\Users\\u\\AppData\\Local\\JianyingPro\\User Data\\Cache\ncacheDate=30\n'
  assert.equal(M.parseJianyingCachePath(ini), 'C:\\Users\\u\\AppData\\Local\\JianyingPro\\User Data\\Cache')
  // 值含空格保留；行首空白容忍
  assert.equal(M.parseJianyingCachePath('[General]\n  currentCachePath = D:/jy cache \n'), 'D:/jy cache')
  assert.equal(M.parseJianyingCachePath('[General]\ncacheDate=30\n'), '')
  assert.equal(M.parseJianyingCachePath(''), '')
  assert.equal(M.parseJianyingCachePath(undefined), '')
})

test('getJianyingMediaCacheDir：设置值 currentCachePath 优先，无设置回退默认 Cache；正斜杠口径', () => {
  const dir = M.getJianyingMediaCacheDir()
  assert.ok(dir && !dir.includes('\\'), '应为正斜杠路径：' + dir)
  // 接线验证：与「读 globalSetting → 回退默认 → 正斜杠」同口径重算对拍
  const cfg = path.join(process.env.LOCALAPPDATA || '', 'JianyingPro', 'User Data', 'Config', 'globalSetting')
  let want = ''
  try { if (fs.existsSync(cfg)) want = M.parseJianyingCachePath(fs.readFileSync(cfg, 'utf-8')) } catch (_) { /* 回退 */ }
  if (!want) want = path.join(process.env.LOCALAPPDATA || '', 'JianyingPro', 'User Data', 'Cache')
  assert.equal(dir, want.split('\\').join('/'))
})

// ── readProcessedSrtAsset（2026-09-18 字幕重切段后处理资产优先消费）──

test('readProcessedSrtAsset: srtPath 存在非空直读；缺失/空文件/无 srtPath → 空串回退', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'srtasset-'))
  try {
    const f = path.join(dir, 'a.srt')
    const body = '1\n00:00:00,000 --> 00:00:01,000\n一\n'
    fs.writeFileSync(f, body)
    assert.equal(M.readProcessedSrtAsset({ srtPath: f }), body)
    const empty = path.join(dir, 'e.srt')
    fs.writeFileSync(empty, '')
    assert.equal(M.readProcessedSrtAsset({ srtPath: empty }), '', '空文件应回退')
    assert.equal(M.readProcessedSrtAsset({ srtPath: path.join(dir, 'nope.srt') }), '', '不存在应回退')
    assert.equal(M.readProcessedSrtAsset({}), '', '无 srtPath 应回退')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// ── 方案A·词表层（2026-09-19）：词源=产品关联词/LLM 兜底 → fxLines 去重词表随 concat 下发 ──

test('buildServerFxFields: 方案A词表层——fxLines 去重出 text_template_words/fancy_words', () => {
  const hits = [
    { text: '低延迟', start: 0, end: 3, templateId: 'a' },
    { text: '低延迟', start: 5, end: 7, templateId: 'b' }, // 重复词去重
    { text: '大容量', start: 3, end: 5, templateId: 'c' },
  ]
  const f = M.buildServerFxFields(
    { textFxEnabled: true, fancyText: true, textTemplateMatchIds: ['a', 'b'] },
    '1\n00:00:00,000 --> 00:00:02,000\n第一句',
    hits,
  )
  assert.deepEqual(JSON.parse(f.text_template_words), ['低延迟', '大容量'])
  assert.deepEqual(JSON.parse(f.fancy_words), ['低延迟', '大容量'])
  assert.equal(f.text_template_match_enabled, 'true')
  assert.deepEqual(JSON.parse(f.text_template_match_ids), ['a', 'b'])
  // 事件直传（服务端 2026-09-19 新增）：事件不去重（同词不同时间=不同事件），
  // 秒单位原样下发，template_id 随事件携带 → 服务端按事件烧制跳过自有命中
  assert.deepEqual(JSON.parse(f.text_template_match_events), [
    { word: '低延迟', start: 0, end: 3, template_id: 'a' },
    { word: '低延迟', start: 5, end: 7, template_id: 'b' },
    { word: '大容量', start: 3, end: 5, template_id: 'c' },
  ])
  // match_id 不再下发（/text_templates/match 下线，回执复用机制作废）
  assert.ok(!('text_template_match_id' in f))
})

test('buildServerFxFields: 事件直传容错——无效窗口/空词事件被过滤，零命中不传 events', () => {
  const f = M.buildServerFxFields(
    { textFxEnabled: true, textTemplateMatchIds: ['a'] },
    '',
    [
      { text: '低延迟', start: 0, end: 0, templateId: 'a' }, // end<=start → 过滤
      { text: '', start: 1, end: 2 }, // 空词 → 过滤
      { text: '防水', start: 1.5, end: 2.5 }, // 无 templateId → 事件保留但省略字段
    ],
  )
  assert.deepEqual(JSON.parse(f.text_template_match_events), [{ word: '防水', start: 1.5, end: 2.5 }])
  assert.equal(f.text_template_words, JSON.stringify(['防水']))
  const f0 = M.buildServerFxFields({ textFxEnabled: true }, 'srt', [])
  assert.ok(!('text_template_match_events' in f0), '零命中不传 events')
  assert.ok(!('text_template_words' in f0))
})

test('buildServerFxFields: 无命中不传词表；textFx 关闭则文字模板块整块缺席', () => {
  const f1 = M.buildServerFxFields({ textFxEnabled: true, textTemplateMatchIds: ['a'] }, 'srt', [])
  assert.ok(!('text_template_words' in f1), '零命中不应传空词表（语义待服务端定义，宁缺勿错）')
  const f2 = M.buildServerFxFields({ fancyText: true, textFxEnabled: false }, 'srt', [
    { text: '防水', start: 0, end: 1 },
  ])
  assert.ok(!('text_template_words' in f2), 'textFx 关闭不应有文字模板块')
  assert.deepEqual(JSON.parse(f2.fancy_words), ['防水'], '花字词表独立生效')
})
