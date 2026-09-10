// ═══════════════════════════════════════════════════════════════
// video-montage-logic.test.mjs — 智能混剪·服务端四步链路纯函数 单测（M8 条目⑥）
// 被测：renderer/src/composables/videoMontageLogic.ts（纯函数，无 vue/IPC 依赖）
// 对照原客户端 studio/gui（video_montage_page.py + gui/montage/workers/*）：
//   · ServerSplitWorker L121-171（POST /montage/split 响应 shots[] 解析：
//     start_sec/end_sec/shot_index/filename/download_url/aesthetic_score/
//     shot_analysis/description；无 shots → 空）
//   · _submit_concat_to_server L2663-2725（转场安全映射 SERVER_TRANSITION_MAP、
//     layout→width/height、source 探测回退 1080x1920、options 白名单）
//   · montage_concat_server_worker L57-128（files/clip_urls 至少一项；clip_urls
//     JSON 字符串；result.video_url/url/output_url 提取）
// 运行：node --test "tests/*.test.mjs"
// ═══════════════════════════════════════════════════════════════

import { test } from 'node:test'
import assert from 'node:assert/strict'

const R = await import('../renderer/src/composables/videoMontageLogic.ts')

// ── Step3 字幕/花字样式预设（2026-09-09 裁决：样式属字幕配置，字幕三行布局）──

test('SUBTITLE_STYLE_PRESETS：24 格色板，首项默认白字无描边，key 全表唯一', () => {
  assert.equal(R.SUBTITLE_STYLE_PRESETS.length, 24)
  assert.equal(R.SUBTITLE_STYLE_PRESETS[0].key, 'white')
  assert.equal(R.SUBTITLE_STYLE_PRESETS[0].stroke, '')
  const keys = R.SUBTITLE_STYLE_PRESETS.map((p) => p.key)
  assert.equal(new Set(keys).size, keys.length)
})

test('SUBTITLE_STYLE_PRESETS 与主进程 SUBTITLE_STYLES key 一一对应（两表同步维护）', async () => {
  const { createRequire } = await import('node:module')
  const L = createRequire(import.meta.url)('../main/voice-tts-logic.js')
  assert.deepEqual(
    Object.keys(L.SUBTITLE_STYLES).sort(),
    R.SUBTITLE_STYLE_PRESETS.map((p) => p.key).sort(),
  )
})

test('subtitlePresetTileStyle：无描边只给 color；有描边给 text-stroke+paintOrder', () => {
  const plain = R.subtitlePresetTileStyle({ key: 'white', label: '', color: '#FFFFFF', stroke: '' })
  assert.equal(plain.color, '#FFFFFF')
  assert.equal(plain.webkitTextStroke, undefined)
  const stroked = R.subtitlePresetTileStyle({ key: 'yellow_red', label: '', color: '#FFE135', stroke: '#CC0000' })
  assert.equal(stroked.webkitTextStroke, '2.5px #CC0000')
  assert.equal(stroked.paintOrder, 'stroke')
})

test('FANCY_STYLE_PREVIEW：7 项与 FANCY_STYLE_OPTIONS 一一对应且色对齐全', () => {
  for (const o of R.FANCY_STYLE_OPTIONS) {
    const p = R.FANCY_STYLE_PREVIEW[o.value]
    assert.ok(p && p.color && p.stroke, o.value)
  }
})

test('fancyDrawtextToPreview：drawtext 串还原主色+描边；white/black 别名；空/无 fontcolor → null', () => {
  const gold = R.fancyDrawtextToPreview('fontcolor=0xF0C040:borderw=4:bordercolor=0x6B3000:shadowx=2:shadowy=2:shadowcolor=0x000000@0.8')
  assert.equal(gold.color, '#F0C040')
  assert.equal(gold.webkitTextStroke, '3px #6B3000')
  assert.equal(gold.paintOrder, 'stroke')
  const white = R.fancyDrawtextToPreview('fontcolor=white:borderw=5:bordercolor=black')
  assert.equal(white.color, '#FFFFFF')
  assert.equal(white.webkitTextStroke, '4px #000000')
  assert.equal(R.fancyDrawtextToPreview(''), null)
  assert.equal(R.fancyDrawtextToPreview('borderw=3'), null)
})

// ── Step1 分割响应解析（对照 ServerSplitWorker L121-171）──

test('parseSplitResponse：shots[] 归一化（download_url/score/description）', () => {
  const shots = R.parseSplitResponse({
    shots: [
      { start_sec: 0, end_sec: 3.2, shot_index: 1, filename: 'a_shot_001.mp4', download_url: '/montage/split/clip/t/a.mp4', aesthetic_score: 7.5, shot_analysis: '特写', description: '产品特写' },
      { start_sec: 3.2, end_sec: 6, shot_index: 2, filename: 'a_shot_002.mp4', download_url: '' },
    ],
  })
  assert.equal(shots.length, 2)
  assert.equal(shots[0].startSec, 0)
  assert.equal(shots[0].endSec, 3.2)
  assert.equal(shots[0].filename, 'a_shot_001.mp4')
  assert.equal(shots[0].downloadUrl, '/montage/split/clip/t/a.mp4')
  assert.equal(shots[0].score, 7.5)
  assert.equal(shots[0].analysis, '特写')
  assert.equal(shots[0].description, '产品特写')
  assert.equal(shots[1].score, undefined)
  assert.equal(shots[1].downloadUrl, '')
  // 逐镜扩展字段缺省为空串（老响应无 shot_type/product/model/resolution）
  assert.equal(shots[0].shotType, '')
  assert.equal(shots[0].product, '')
  assert.equal(shots[0].model, '')
  assert.equal(shots[0].resolution, '')
})

test('parseSplitResponse：服务端逐镜扩展字段解析（shot_type/product/model/resolution）', () => {
  const shots = R.parseSplitResponse({
    shots: [{
      start_sec: 0, end_sec: 2.5, shot_index: 1, filename: 'a_shot_001.mp4', download_url: '/u1',
      score: 8.2, shot_type: '中景', product: '鼠标', model: 'M3', resolution: '1920x1080',
    }],
  })
  assert.equal(shots[0].shotType, '中景')
  assert.equal(shots[0].product, '鼠标')
  assert.equal(shots[0].model, 'M3')
  assert.equal(shots[0].resolution, '1920x1080')
})

// 2026-09-11 在线实测回归：服务端 shots[].resolution 是对象 {width,height}，
// 旧实现 String(对象) 直接渲染成 "[object Object]" 填满表格画幅列
test('parseSplitResponse：resolution 为对象 {width,height} → 归一化为 WxH（不得出 [object Object]）', () => {
  const shots = R.parseSplitResponse({
    shots: [{ start_sec: 0, end_sec: 1, filename: 'a.mp4', resolution: { width: 1080, height: 1920 } }],
  })
  assert.equal(shots[0].resolution, '1080x1920')
  assert.ok(!shots[0].resolution.includes('object'))
  // 顶层 source_resolution 同形态（实测含 fps/codec/aspect_ratio）
  const srcRes = { width: 480, height: 854, aspect_ratio: '240:427', fps: 25, codec: 'h264' }
  assert.equal(R.normalizeSourceResolution(srcRes), '480x854')
})

test('parseSplitResponse：resolution 对象缺 width/height → 空串（UI 回退全表兜底值）', () => {
  const shots = R.parseSplitResponse({
    shots: [{ start_sec: 0, end_sec: 1, filename: 'a.mp4', resolution: { aspect_ratio: '16:9' } }],
  })
  assert.equal(shots[0].resolution, '')
})

test('parseSplitResponse：clips/segments 兜底；非对象/空 → 空数组', () => {
  assert.equal(R.parseSplitResponse({ clips: [{ start_sec: 1, end_sec: 2 }] }).length, 1)
  assert.equal(R.parseSplitResponse({ segments: [{ start_sec: 1, end_sec: 2 }] }).length, 1)
  assert.deepEqual(R.parseSplitResponse({ shots: [] }), [])
  assert.deepEqual(R.parseSplitResponse(null), [])
  assert.deepEqual(R.parseSplitResponse('x'), [])
})

test('shotsToRows：表格行（勾选默认 true、时长、可过滤评分）', () => {
  const rows = R.shotsToRows([
    { startSec: 0, endSec: 3.2, shotIndex: 1, filename: 'a_shot_001.mp4', downloadUrl: '/u1', score: 7.5, analysis: '特写', description: '产品特写' },
    { startSec: 3.2, endSec: 6, shotIndex: 2, filename: 'a_shot_002.mp4', downloadUrl: '', score: 0, analysis: '', description: '' },
  ], 'demo.mp4')
  assert.equal(rows.length, 2)
  assert.equal(rows[0].idx, 1)
  assert.equal(rows[0].checked, true)
  assert.equal(rows[0].duration.toFixed(1), '3.2')
  assert.equal(rows[0].sourceName, 'demo.mp4')
  assert.equal(rows[0].clipUrl, '/u1')
  assert.equal(rows[0].shotType, undefined) // 无路径关键词、无服务端字段 → 不标注
})

test('shotsToRows：景别仅服务端返回；位置兑底仅认入场/出场（2026-09-09 二次裁决）', () => {
  // 路径含「特写」但服务端返回「中景」→ 景别仅取服务端
  const rows = R.shotsToRows([
    { startSec: 0, endSec: 2, shotIndex: 1, filename: 'a.mp4', downloadUrl: '/u1', score: 8.5, analysis: '', description: 'd', shotType: '中景', product: '鼠标', model: 'M3', resolution: '1920x1080' },
    { startSec: 2, endSec: 4, shotIndex: 2, filename: 'b.mp4', downloadUrl: '', score: 0, analysis: '', description: '', shotType: '', product: '', model: '', resolution: '' },
  ], '特写_C9288_20260817.mp4', 'X:\\混剪素材\\特写_C9288_20260817.mp4')
  assert.equal(rows[0].shotType, '中景')
  assert.equal(rows[0].product, '鼠标')
  assert.equal(rows[0].model, 'M3')
  assert.equal(rows[0].resolution, '1920x1080')
  // 第二行服务端景别空 → 景别不推断显 —；
  // 文件名含「特写」是景别不是位置 → 位置不得标注（2026-09-09 用户纠偏）
  assert.equal(rows[1].shotType, undefined)
  assert.equal(rows[1].position, undefined)
  assert.equal(rows[1].positionSource, undefined)
  assert.equal(rows[1].product, undefined)
  assert.equal(rows[1].model, undefined)
  assert.equal(rows[1].resolution, undefined)
})

test('shotsToRows：文件名/文件夹含入场/出场 → 位置兑底标来源；景别词（中景）不进位置列', () => {
  // 文件名「中景」首段命中即返回（原版 classify 口径：文件名优先、命中即返回，
  //  不再回退父目录）→ 景别词不进位置列，位置空（原版消费侧也只在
  //  entrance/exit 时才动作，medium/closeup 命中即放弃）
  const rows = R.shotsToRows([
    { startSec: 0, endSec: 2, shotIndex: 1, filename: 'a.mp4', downloadUrl: '/u1' },
  ], 'mix.mp4', 'X:\\混剪素材\\555电池出场\\555电池中景_001.mp4')
  assert.equal(rows[0].position, undefined)
  assert.equal(rows[0].positionSource, undefined)
  // 纯中景命名 → 位置空
  const r2 = R.shotsToRows([{ startSec: 0, endSec: 2, shotIndex: 1, filename: 'a.mp4', downloadUrl: '/u1' }],
    'mix.mp4', 'X:\\混剪素材\\产品中景_002.mp4')
  assert.equal(r2[0].position, undefined)
  // 纯出场命名 → 位置=exit（文件名来源）
  const r3 = R.shotsToRows([{ startSec: 0, endSec: 2, shotIndex: 1, filename: 'a.mp4', downloadUrl: '/u1' }],
    'mix.mp4', 'X:\\混剪素材\\555电池出场 (1).mp4')
  assert.equal(r3[0].position, 'exit')
  assert.ok(r3[0].positionSource.startsWith('文件名「'))
})

test('shotsToRows：服务端 enter/exit 布尔 → 位置（服务端标注）优先于路径推断', () => {
  const rows = R.shotsToRows([
    { startSec: 0, endSec: 2, shotIndex: 1, filename: 'a.mp4', downloadUrl: '/u1', score: 8, analysis: '', description: '', shotType: '', enter: true, exit: false },
    { startSec: 2, endSec: 4, shotIndex: 2, filename: 'b.mp4', downloadUrl: '', score: 0, analysis: '', description: '', shotType: '', enter: false, exit: true },
  ], '出场_001.mp4', 'X:\\混剪素材\\出场_001.mp4')
  assert.equal(rows[0].position, 'entrance')
  assert.equal(rows[0].positionSource, '服务端标注')
  assert.equal(rows[1].position, 'exit')
  assert.equal(rows[1].positionSource, '服务端标注')
})

// ── Step2 镜头重组（对照 _submit_concat_to_server L2663-2725 + server worker L57-128）──

test('mapTransition：服务端 xfade 安全映射，未知回退 fade（对照 L2692-2703）', () => {
  assert.equal(R.mapTransition('fade'), 'fade')
  assert.equal(R.mapTransition('dissolve'), 'dissolve')
  assert.equal(R.mapTransition('slideleft'), 'wipeleft')
  assert.equal(R.mapTransition('slideright'), 'wiperight')
  assert.equal(R.mapTransition('zoomin'), 'circleopen')
  assert.equal(R.mapTransition('zoomout'), 'radial')
  assert.equal(R.mapTransition('weird'), 'fade')
})

test('layoutSize：vertical/horizontal/source 探测回退（对照 L2707-2714）', () => {
  assert.deepEqual(R.layoutSize('vertical'), { width: 1080, height: 1920 })
  assert.deepEqual(R.layoutSize('horizontal'), { width: 1920, height: 1080 })
  assert.deepEqual(R.layoutSize('source', { width: 720, height: 1280 }), { width: 720, height: 1280 })
  assert.deepEqual(R.layoutSize('source', { width: 0, height: 0 }), { width: 1080, height: 1920 })
  assert.deepEqual(R.layoutSize('source'), { width: 1080, height: 1920 })
})

test('buildConcatPayload：clip_urls 优先（JSON 字符串）；否则 files 本地路径（对照 server worker L77-96）', () => {
  const p1 = R.buildConcatPayload({
    clipUrls: ['/montage/split/clip/t/a.mp4', '/montage/split/clip/t/b.mp4'],
    transition: 'slideleft', layout: 'vertical',
  })
  assert.deepEqual(p1.clip_urls, JSON.stringify(['/montage/split/clip/t/a.mp4', '/montage/split/clip/t/b.mp4']))
  assert.equal(p1.files, undefined)
  assert.equal(p1.transition, 'wipeleft')
  assert.equal(p1.width, 1080)
  assert.equal(p1.height, 1920)

  const p2 = R.buildConcatPayload({ files: ['D:/x/a.mp4', 'D:/x/b.mp4'] })
  assert.deepEqual(p2.files, ['D:/x/a.mp4', 'D:/x/b.mp4'])
  assert.equal(p2.clip_urls, undefined)
})

test('buildConcatPayload：可选参数白名单透传（transition_duration/fps/crf/preset/image_duration）', () => {
  const p = R.buildConcatPayload({
    clipUrls: ['/a'], transitionDuration: 0.5, fps: 30, crf: 23, preset: 'superfast', imageDuration: 3,
  })
  assert.equal(p.transition_duration, 0.5)
  assert.equal(p.fps, 30)
  assert.equal(p.crf, 23)
  assert.equal(p.preset, 'superfast')
  assert.equal(p.image_duration, 3)
  // 未传字段不出现在载荷（对照原注释「options 只包含文档列出的字段」L2671-2672）
  assert.equal('time_limit' in p, false)
})

// ── Step2 输出帧率（2026-09-11 用户裁决：帧率可控、默认「跟随原片」）──
// 旧实现写死 fps:30；现由下拉决定，服务端契约 fps 为 integer → 小数帧率必须取整

test('resolveConcatFps：跟随原片→探测值取整（29.97 → 30，契约 integer）', () => {
  assert.equal(R.resolveConcatFps('source', 25), 25)
  assert.equal(R.resolveConcatFps('source', 29.97), 30)
  assert.equal(R.resolveConcatFps('source', 23.976), 24)
  assert.equal(R.resolveConcatFps('source', 59.94), 60)
})

test('resolveConcatFps：探测失败（0/NaN/负）→ 兑底 30（与契约默认值一致）', () => {
  assert.equal(R.resolveConcatFps('source', 0), 30)
  assert.equal(R.resolveConcatFps('source', NaN), 30)
  assert.equal(R.resolveConcatFps('source', -1), 30)
  // 手动档位给非法值同样兑底，不得把 0 传上去（服务端会出 0 帧/拒参）
  assert.equal(R.resolveConcatFps(0, 25), 30)
})

test('resolveConcatFps：手动档位直接生效（不受探测值影响）', () => {
  assert.equal(R.resolveConcatFps(24, 60), 24)
  assert.equal(R.resolveConcatFps(60, 0), 60)
})

test('FPS_OPTIONS：首项「跟随原片」（默认值）且数字档位全为整数', () => {
  assert.equal(R.FPS_OPTIONS[0].value, 'source')
  const nums = R.FPS_OPTIONS.map((o) => o.value).filter((v) => typeof v === 'number')
  assert.ok(nums.length >= 3)
  for (const n of nums) assert.equal(Number.isInteger(n), true, `档位 ${n} 必为整数`)
  assert.equal(new Set(R.FPS_OPTIONS.map((o) => o.value)).size, R.FPS_OPTIONS.length)
})

test('buildConcatPayload：无素材来源 → 抛错（对照 server worker L57-59）', () => {
  assert.throws(() => R.buildConcatPayload({}), /没有可合成的镜头/)
  assert.throws(() => R.buildConcatPayload({ clipUrls: [], files: [] }), /没有可合成的镜头/)
})

// ── Step2 拼接结果轮询（对照 montage_concat_server_worker L113-143）──

test('extractConcatResultUrl：video_url/url/output_url 依次提取（对照 L125-128）', () => {
  assert.equal(R.extractConcatResultUrl({ video_url: '/v1' }), '/v1')
  assert.equal(R.extractConcatResultUrl({ url: '/v2' }), '/v2')
  assert.equal(R.extractConcatResultUrl({ output_url: '/v3' }), '/v3')
  assert.equal(R.extractConcatResultUrl({ video_url: '/v1', url: '/v2' }), '/v1')
  assert.equal(R.extractConcatResultUrl({}), '')
  assert.equal(R.extractConcatResultUrl(null), '')
})

test('extractSubmitTaskId：id/task_id/job_id（对照 L103-105）', () => {
  assert.equal(R.extractSubmitTaskId({ id: '9' }), '9')
  assert.equal(R.extractSubmitTaskId({ task_id: 't' }), 't')
  assert.equal(R.extractSubmitTaskId({ job_id: 'j' }), 'j')
  assert.throws(() => R.extractSubmitTaskId({}), /未返回任务/)
})

// ── Step4 成片混音 /montage/bgm（对照原 FinalMixWorker 口径的服务端化）──

test('extractBgmResult：task_id 优先轮询；否则 video_url/url/output_url/file 同步下载', () => {
  assert.deepEqual(R.extractBgmResult({ task_id: 't9' }), { taskId: 't9', url: '' })
  assert.deepEqual(R.extractBgmResult({ id: 'i9' }), { taskId: 'i9', url: '' })
  assert.deepEqual(R.extractBgmResult({ video_url: '/v.mp4' }), { taskId: '', url: '/v.mp4' })
  assert.deepEqual(R.extractBgmResult({ output_url: '/o.mp4' }), { taskId: '', url: '/o.mp4' })
  assert.deepEqual(R.extractBgmResult({ file: '/f.mp4' }), { taskId: '', url: '/f.mp4' })
  assert.deepEqual(R.extractBgmResult({}), { taskId: '', url: '' })
})

test('buildBgmPayload：file/bgm 必填 + 音量参数（对照 Body_montage_add_bgm_montage_bgm_post）', () => {
  const p = R.buildBgmPayload({ file: 'D:/v.mp4', bgm: 'D:/b.mp3', bgmVolume: 0.6, sourceVolume: 1 })
  assert.equal(p.file, 'D:/v.mp4')
  assert.equal(p.bgm, 'D:/b.mp3')
  assert.equal(p.bgm_volume, 0.6)
  assert.equal(p.source_volume, 1)
  assert.throws(() => R.buildBgmPayload({ bgm: '/b.mp3' }), /缺少视频文件/)
  assert.throws(() => R.buildBgmPayload({ file: '/v.mp4' }), /缺少背景音乐/)
})

// ── Step4 AI 生成 BGM（/audio/gen/bgm，对齐原客户端 gen_bgm L159-175：
//    body = {prompt, style, duration}，无 mood；style 英文 7 项）──

test('BGM_STYLE_OPTIONS：原客户端 _build_tab_ai L1588-1594 同款 7 项', () => {
  assert.equal(R.BGM_STYLE_OPTIONS.length, 7)
  assert.deepEqual(
    R.BGM_STYLE_OPTIONS.map((o) => o.value),
    ['auto', 'electronic', 'classical', 'rock', 'jazz', 'ambient', 'lofi'],
  )
  assert.equal(R.BGM_STYLE_OPTIONS[0].label, '自动')
  assert.equal(R.BGM_STYLE_OPTIONS[6].label, 'Lo-Fi')
})

test('buildBgmGenPayload：prompt 必填 + style 默认 auto + duration 3-60（无 mood）', () => {
  assert.deepEqual(
    R.buildBgmGenPayload({ prompt: '激昂的电子音乐，适合科技感视频' }),
    { prompt: '激昂的电子音乐，适合科技感视频', style: 'auto' },
  )
  assert.deepEqual(
    R.buildBgmGenPayload({ prompt: ' 激昂的电子乐 ', style: 'electronic', duration: 30.6 }),
    { prompt: '激昂的电子乐', style: 'electronic', duration: 31 },
  )
  assert.throws(() => R.buildBgmGenPayload({}), /请输入 BGM 描述/)
  assert.throws(() => R.buildBgmGenPayload({ prompt: '  ' }), /请输入 BGM 描述/)
  assert.throws(() => R.buildBgmGenPayload({ prompt: 'x', duration: 2 }), /3-60/)
  assert.throws(() => R.buildBgmGenPayload({ prompt: 'x', duration: 61 }), /3-60/)
  assert.throws(() => R.buildBgmGenPayload({ prompt: 'x', duration: NaN }), /3-60/)
})

test('parseBgmGenResponse：url 必填 + 元信息保留；缺 url 报错', () => {
  const r = R.parseBgmGenResponse({ url: '/output/audio_gen/a.wav', duration: 20, prompt: 'pop', engine: 'musicgen-small', audio_id: 7 })
  assert.equal(r.url, '/output/audio_gen/a.wav')
  assert.equal(r.duration, 20)
  assert.equal(r.engine, 'musicgen-small')
  assert.equal(r.audioId, '7')
  assert.equal(R.parseBgmGenResponse({ audio_url: '/a.wav' }).url, '/a.wav')
  assert.throws(() => R.parseBgmGenResponse({ engine: 'x' }), /未返回音频地址/)
  assert.throws(() => R.parseBgmGenResponse(null), /响应为空/)
})

test('pickBgmMixField：本地优先 {path}；否则 bgm_url；皆空报错', () => {
  assert.deepEqual(R.pickBgmMixField('D:/b.mp3', '/gen/a.wav'), { bgm: { path: 'D:/b.mp3' } })
  assert.deepEqual(R.pickBgmMixField('', '/gen/a.wav'), { bgm_url: '/gen/a.wav' })
  assert.throws(() => R.pickBgmMixField('', ''), /请先选择背景音乐或生成 BGM/)
})

// ── Step1 splits 目录安全源名（对照 utils_media.py safe_source_name max_len=40）──

/** 构造镜头行（buildPrecomposePlans/方案断言共用） */
function mkRow(idx, duration, extra = {}) {
  return {
    idx, name: `shot_${String(idx).padStart(3, '0')}.mp4`, sourceName: 'demo.mp4',
    startSec: 0, endSec: duration, duration, description: `画面${idx}`, analysis: '',
    score: 7, clipUrl: `/u/${idx}`, downloadState: 'ok', checked: true, ...extra,
  }
}

test('safeSourceName：非法字符替换 _、折叠空白、剔首尾点；空名回退 video', () => {
  assert.equal(R.safeSourceName('demo.mp4'), 'demo')
  // 每个非法字符各替换为一个 _（原版不折叠）
  assert.equal(R.safeSourceName('a<b>:c"d/e\\f|g?h*i.mp4'), 'a_b__c_d_e_f_g_h_i')
  assert.equal(R.safeSourceName('  多  空格  名.mp4 '), '多 空格 名')
  assert.equal(R.safeSourceName('..点首尾..mp4'), '点首尾')
  assert.equal(R.safeSourceName(''), 'video')
  // 仅清洗后为空才回退 video；全非法字符 → 全下划线（原版同口径）
  assert.equal(R.safeSourceName('???'), '___')
})

test('safeSourceName：超长截断 + 8 位散列后缀（同输入同输出，异输入异后缀）', () => {
  const long = '这是一个特别特别长的视频文件名用来测试超过四十字符之后触发截断与散列后缀逻辑Demo.mp4'
  const s1 = R.safeSourceName(long)
  const s2 = R.safeSourceName(long)
  assert.ok(s1.length <= 40 + 1 + 8)
  assert.match(s1, /_[0-9a-f]{8}$/)
  assert.equal(s1, s2)
  assert.notEqual(s1, R.safeSourceName(long.replace('Demo', 'Deno')))
  // 短名不加后缀
  assert.equal(R.safeSourceName('short.mp4'), 'short')
})

test('normalizeSourceResolution：服务端 split 响应分辨率归一化（数组/WxH 串/对象/无效）', () => {
  // 对照原版 _detect_and_show_source_resolution L4768-4773
  assert.equal(R.normalizeSourceResolution([1920, 1080]), '1920x1080')
  assert.equal(R.normalizeSourceResolution('1080x1920'), '1080x1920')
  assert.equal(R.normalizeSourceResolution(' 720x1280 '), '720x1280')
  // 2026-09-11 在线实测第三形态：对象 {width,height}（shots[].resolution 与顶层
  // source_resolution 均为对象）；容错 w/h 缩写键
  assert.equal(R.normalizeSourceResolution({ width: 1080, height: 1920 }), '1080x1920')
  assert.equal(R.normalizeSourceResolution({ w: 720, h: 1280 }), '720x1280')
  assert.equal(R.normalizeSourceResolution({ width: 0, height: 0 }), '')
  assert.equal(R.normalizeSourceResolution({ width: 1080 }), '')
  assert.equal(R.normalizeSourceResolution({}), '')
  assert.equal(R.normalizeSourceResolution('0x100'), '')
  assert.equal(R.normalizeSourceResolution('abc'), '')
  assert.equal(R.normalizeSourceResolution(''), '')
  assert.equal(R.normalizeSourceResolution(null), '')
  assert.equal(R.normalizeSourceResolution(undefined), '')
  assert.equal(R.normalizeSourceResolution([1920]), '')
  assert.equal(R.normalizeSourceResolution(1920), '')
})

// ── Step2 预合成方案（对照 _build_precompose_plans L5223-5344）──

test('buildPrecomposePlans：去重 + low 不洗牌保持原序 + 方案结构初始态', () => {
  const clips = [mkRow(1, 5), mkRow(2, 5), mkRow(3, 5)]
  const plans = R.buildPrecomposePlans({
    clips: [...clips, clips[0]], batchCount: 1, durationLimitSec: 0,
    randomness: 'low', randomFn: () => 0.99,
  })
  assert.equal(plans.length, 1)
  assert.deepEqual(plans[0].clips.map((c) => c.idx), [1, 2, 3])
  assert.deepEqual(plans[0].deletedFlags, [false, false, false])
  assert.equal(plans[0].confirmed, false)
  assert.equal(plans[0].copy, '')
  // 重复引用去重：3 行只保留 3 个（同 idx 不重复入列）
  assert.equal(plans[0].clips.length, 3)
})

test('buildPrecomposePlans：时长预算 limit×1.1（10s×5 镜头 limit30 → 每批 ≤3 个）', () => {
  const clips = [1, 2, 3, 4, 5].map((i) => mkRow(i, 10))
  const plans = R.buildPrecomposePlans({
    clips, batchCount: 3, durationLimitSec: 30, randomness: 'low', randomFn: () => 0.5,
  })
  assert.equal(plans.length, 3)
  for (const p of plans) {
    assert.ok(p.clips.length <= 3, `每批不超 3 个（实际 ${p.clips.length}）`)
    const total = p.clips.reduce((a, c) => a + c.duration, 0)
    assert.ok(total <= 30 * 1.1 + 1e-9)
  }
})

test('buildPrecomposePlans：位置编排入场头/出场尾（apply_shot_layout_order 同口径；2026-09-09 裁决取 position）', () => {
  const clips = [
    mkRow(1, 5, { position: 'exit' }),
    mkRow(2, 5, { position: 'entrance' }),
    mkRow(3, 5),
  ]
  const plans = R.buildPrecomposePlans({
    clips, batchCount: 1, durationLimitSec: 0, randomness: 'low', randomFn: () => 0.5,
  })
  const positions = plans[0].clips.map((c) => c.position)
  assert.equal(positions[0], 'entrance')
  assert.equal(positions[positions.length - 1], 'exit')
})

test('buildPrecomposePlans：空输入 → 空数组', () => {
  assert.deepEqual(R.buildPrecomposePlans({ clips: [], batchCount: 2, durationLimitSec: 30, randomness: 'medium' }), [])
})

// ── Step2 口播文案 prompt（对照 script_workers.py SceneCopyWorker L235-266）──

test('buildSceneCopyMessages：字数按 3.5 字/秒夹 5-40；temperature 0.6；背景信息入 user', () => {
  // 2 镜头总 20s → 每镜 10s → 35 字（< 40 不截顶）
  const m1 = R.buildSceneCopyMessages({ sceneDescriptions: ['特写', '使用场景'], brand: '罗技', product: '鼠标', modelName: 'GPW', extra: '无线', totalDuration: 20 })
  assert.equal(m1.temperature, 0.6)
  assert.match(m1.system, /严格输出 2 行/)
  assert.match(m1.system, /每行约 5-35 字/)
  assert.match(m1.user, /品牌：罗技/)
  assert.match(m1.user, /型号：GPW/)
  assert.match(m1.user, /补充卖点：无线/)
  assert.match(m1.user, /1\. 特写/)
  // 每镜 0.5s → 1.75 字 → 夹下限 5
  const m2 = R.buildSceneCopyMessages({ sceneDescriptions: ['a', 'b'], totalDuration: 1 })
  assert.match(m2.system, /每行约 5-5 字/)
  // 无时长 → 默认 22 字
  const m3 = R.buildSceneCopyMessages({ sceneDescriptions: ['a'] })
  assert.match(m3.system, /每行约 5-22 字/)
  // 空描述 → 报错
  assert.throws(() => R.buildSceneCopyMessages({ sceneDescriptions: [] }), /没有可用的画面镜头描述/)
})

test('parseLlmCopyResponse：choices[0].message.content；空内容报错', () => {
  assert.equal(R.parseLlmCopyResponse({ choices: [{ message: { content: ' 轻量化设计\n' } }] }), '轻量化设计')
  assert.throws(() => R.parseLlmCopyResponse({ choices: [] }), /未返回文案内容/)
  assert.throws(() => R.parseLlmCopyResponse(null), /未返回文案内容/)
})

// ── Step2 预合成列表行文案（对照 _add_assembled_row L5383-5410）──

test('copyPreviewText：前 30 字换行折空格；未生成占位', () => {
  assert.equal(R.copyPreviewText(''), '未生成口播文案')
  assert.equal(R.copyPreviewText('短文案'), '短文案')
  const long = '一'.repeat(35)
  assert.equal(R.copyPreviewText(long), '一'.repeat(30) + '…')
  assert.equal(R.copyPreviewText('第一行\n第二行'), '第一行 第二行')
})

test('assembledRowText：[n] 文件名/镜头数  状态  文案预览', () => {
  assert.equal(
    R.assembledRowText({ index: 0, clipCount: 3, outputName: '', confirmed: false, copyPreview: '未生成口播文案' }),
    '[1] 3 个镜头  待确认  未生成口播文案',
  )
  assert.equal(
    R.assembledRowText({ index: 1, clipCount: 2, outputName: 'montage_concat_server_9012_1.mp4', confirmed: true, copyPreview: '轻便无线' }),
    '[2] montage_concat_server_9012_1.mp4  已合成  轻便无线',
  )
  // outputName 空 + confirmed true → 仍待确认（与原版 confirmed and out_path 口径一致）
  assert.equal(
    R.assembledRowText({ index: 2, clipCount: 1, outputName: '', confirmed: true, copyPreview: '未生成口播文案' }),
    '[3] 1 个镜头  待确认  未生成口播文案',
  )
})

test('mapTaskStatus：cancelled 无 error_msg → 服务端重启取消文案（实测任务 705 口径）', () => {
  const r = R.mapTaskStatus('cancelled', { result: { cancelled: true } })
  assert.equal(r.phase, 'failed')
  assert.equal(r.error, '服务端任务被取消（可能因服务端重启中断），请重新提交')
  // 有 error_msg 时透出原始错误；failed 无 error_msg 仍「未知错误」
  assert.equal(R.mapTaskStatus('cancelled', { error_msg: 'boom' }).error, 'boom')
  assert.equal(R.mapTaskStatus('failed', {}).error, '未知错误')
})

// ── 文字模板随机池（2026-09-09 裁决：随机样式默认 3 个；Fisher-Yates 部分洗牌）──
test('pickRandomItems：取 n 个不重复；n≥池长全量乱序；池空/非法 n 返回空；不改原池', () => {
  const pool = [1, 2, 3, 4, 5]
  const picked = R.pickRandomItems(pool, 3)
  assert.equal(picked.length, 3)
  assert.equal(new Set(picked).size, 3)
  for (const v of picked) assert.ok(pool.includes(v))
  assert.deepEqual(pool, [1, 2, 3, 4, 5])
  const all = R.pickRandomItems(pool, 99)
  assert.equal(all.length, 5)
  assert.deepEqual([...all].sort(), [1, 2, 3, 4, 5])
  assert.deepEqual(R.pickRandomItems([], 3), [])
  assert.deepEqual(R.pickRandomItems(pool, 0), [])
  assert.deepEqual(R.pickRandomItems(pool, NaN), [])
})

// ── buildSubtitleRows（2026-09-11：服务端 match/concat 的 subtitle_rows 组装）──

test('buildSubtitleRows：timing 优先原样透传；缺失回退字数占比均分（与主进程同口径）', () => {
  const timing = [{ text: '第一句', start: 2, end: 6 }]
  assert.deepEqual(R.buildSubtitleRows('随便', timing, 30), [{ text: '第一句', start: 2, end: 6 }])
  const rows = R.buildSubtitleRows('第一句\n第二句更长一点的文案', undefined, 10)
  assert.equal(rows.length, 2)
  assert.equal(rows[0].text, '第一句')
  assert.equal(rows[0].start, 0)
  assert.ok(rows[0].end > 0 && rows[0].end < 10)
  assert.equal(Math.round(rows[1].end * 1000) / 1000, 10) // 末行 t1=时长
  // 空文本/空行/空 timing 回退 → 空数组
  assert.deepEqual(R.buildSubtitleRows('', undefined, 10), [])
  assert.deepEqual(R.buildSubtitleRows('  \n ', [], 10), [])
})

// ── buildTextFxTracks（2026-09-11 用户裁决：命中数据取自服务端 /text_templates/match）──

test('buildTextFxTracks：服务端命中行 → 关键词行显命中词、无词行整行截断；每视频轮换模板', () => {
  const tracks = R.buildTextFxTracks({
    rows: [
      {
        name: 'a.mp4', durationSec: 30,
        lines: [
          { text: '只要199元就能买到', start: 2, end: 6, keywords: ['199元'] },
          { text: '这款充电宝持久续航不虚标', start: 6, end: 10 },
        ],
      },
      { name: 'b.mp4', durationSec: 20, lines: [{ text: '限时特价', start: 1, end: 5, keywords: ['特价'] }] },
    ],
    tplNames: ['霓虹发光', '弹跳', '打字机'],
  })
  assert.equal(tracks.length, 2)
  assert.equal(tracks[0].durationSec, 30)
  // keyword 行 word=命中词；无词（llm/fallback 补足）行=整行截断
  assert.deepEqual(tracks[0].items.map((it) => it.word), ['199元', '这款充电宝持久续航不…'])
  assert.equal(tracks[0].items[0].start, 2)
  assert.equal(tracks[0].items[0].fullText, '只要199元就能买到')
  for (const it of tracks[0].items) assert.ok(it.tplName, '模板名不为空')
  // 视频间模板错开：(vi+ii)%len 轮换
  assert.notEqual(tracks[0].items[0].tplName, tracks[1].items[0].tplName)
  // 空 lines / 空 rows
  assert.deepEqual(R.buildTextFxTracks({ rows: [{ name: 'c.mp4', durationSec: 5, lines: [] }], tplNames: ['x'] })[0].items, [])
  assert.deepEqual(R.buildTextFxTracks({ rows: [], tplNames: ['x'] }), [])
})

// ── 每视频独立随机样式子集（2026-09-10 二次裁决：样式预览=全量库；随机数量 N 每视频各自生效）──

test('seededShuffle/pickVideoStyles：确定性（同 seed 同结果）；count<=0 或池≤1 返回全量；子集不超 count', () => {
  const pool = ['甲', '乙', '丙', '丁', '戊']
  // 确定性：同 seed 结果相同且是原元素重排
  const s1 = R.seededShuffle(pool, 3)
  const s2 = R.seededShuffle(pool, 3)
  assert.deepEqual(s1, s2)
  assert.deepEqual([...s1].sort(), [...pool].sort())
  assert.notDeepEqual(s1, pool) // 5 元素下碰撞概率可忽略
  // 不同 seed 结果不同（大概率）
  assert.notDeepEqual(R.seededShuffle(pool, 0), R.seededShuffle(pool, 1))
  // count 边界
  assert.deepEqual(R.pickVideoStyles(pool, 0, 1), pool)
  assert.deepEqual(R.pickVideoStyles(pool, -1, 1), pool)
  assert.deepEqual(R.pickVideoStyles(['唯一'], 3, 1), ['唯一'])
  const sub = R.pickVideoStyles(pool, 2, 1)
  assert.equal(sub.length, 2)
  for (const x of sub) assert.ok(pool.includes(x))
})

test('buildTextFxTracks count：每视频条目模板收敛到各自随机子集内；同输入确定性可重现', () => {
  const rows = [
    { name: 'a.mp4', durationSec: 20, lines: [{ text: '限时 99 元特价', start: 1, end: 3, keywords: ['99元'] }] },
    { name: 'b.mp4', durationSec: 20, lines: [{ text: '真的便宜', start: 2, end: 4, keywords: [] }] },
  ]
  const tplNames = ['霓虹发光', '弹跳', '打字机', '霓虹灯牌']
  const run = () => R.buildTextFxTracks({ rows, tplNames, count: 2 })
  const tracks = run()
  assert.deepEqual(run(), tracks) // 确定性：预览与烧制同源不漂移
  for (const t of tracks) {
    const names = new Set(t.items.map((it) => it.tplName))
    for (const n of names) assert.ok(tplNames.includes(n), `模板名应在全量池内：${n}`)
  }
  // 视频子集=seededShuffle(pool, vi).slice(0,2)：直接对拍轮换上限
  tracks.forEach((t, vi) => {
    const subset = new Set(R.pickVideoStyles(tplNames, 2, vi))
    for (const it of t.items) assert.ok(subset.has(it.tplName), `条目模板应在该视频子集内：${it.tplName}`)
  })
})
