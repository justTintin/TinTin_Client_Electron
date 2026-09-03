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

test('shotsToRows：服务端 shot_type 优先于路径推断；product/model/resolution 透传（原版表格 10 列口径）', () => {
  // 路径含「特写」但服务端返回「中景」→ 服务端优先
  const rows = R.shotsToRows([
    { startSec: 0, endSec: 2, shotIndex: 1, filename: 'a.mp4', downloadUrl: '/u1', score: 8.5, analysis: '', description: 'd', shotType: '中景', product: '鼠标', model: 'M3', resolution: '1920x1080' },
    { startSec: 2, endSec: 4, shotIndex: 2, filename: 'b.mp4', downloadUrl: '', score: 0, analysis: '', description: '', shotType: '', product: '', model: '', resolution: '' },
  ], '特写_C9288_20260817.mp4', 'X:\\混剪素材\\特写_C9288_20260817.mp4')
  assert.equal(rows[0].shotType, '中景')
  assert.equal(rows[0].product, '鼠标')
  assert.equal(rows[0].model, 'M3')
  assert.equal(rows[0].resolution, '1920x1080')
  // 第二行服务端字段全空 → 景别回退路径推断（classifyShotType 返回枚举 key，中文标签由 SHOT_TYPE_LABELS 映射）
  assert.equal(rows[1].shotType, 'closeup')
  assert.equal(rows[1].product, undefined)
  assert.equal(rows[1].model, undefined)
  assert.equal(rows[1].resolution, undefined)
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

test('normalizeSourceResolution：服务端 split 响应分辨率归一化（数组/WxH 串/无效）', () => {
  // 对照原版 _detect_and_show_source_resolution L4768-4773
  assert.equal(R.normalizeSourceResolution([1920, 1080]), '1920x1080')
  assert.equal(R.normalizeSourceResolution('1080x1920'), '1080x1920')
  assert.equal(R.normalizeSourceResolution(' 720x1280 '), '720x1280')
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

test('buildPrecomposePlans：景别编排入场头/出场尾（apply_shot_layout_order 同口径）', () => {
  const clips = [
    mkRow(1, 5, { shotType: 'exit' }),
    mkRow(2, 5, { shotType: 'entrance' }),
    mkRow(3, 5),
  ]
  const plans = R.buildPrecomposePlans({
    clips, batchCount: 1, durationLimitSec: 0, randomness: 'low', randomFn: () => 0.5,
  })
  const types = plans[0].clips.map((c) => c.shotType)
  assert.equal(types[0], 'entrance')
  assert.equal(types[types.length - 1], 'exit')
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
