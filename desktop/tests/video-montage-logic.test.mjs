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
//   · BeatDetectWorker L453-519（beats/beat_times/timestamps/beat_points 提取、
//     clips {start,end,strength} 排序过滤）
//   · BeatVideoGenWorker L526-781（/montage/beat 仅传非空参数、result.variants /
//     result.file、结果 URL http 原样 // 前缀拼 server / 否则 /montage/result/{tid}[/{variant}]）
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
  assert.deepEqual(shots[0], {
    startSec: 0, endSec: 3.2, shotIndex: 1, filename: 'a_shot_001.mp4',
    downloadUrl: '/montage/split/clip/t/a.mp4', score: 7.5,
    analysis: '特写', description: '产品特写',
  })
  assert.equal(shots[1].score, 0)
  assert.equal(shots[1].downloadUrl, '')
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

test('extractSubmitTaskId：id/task_id/job_id（对照 L103-105 与 beat L760-764）', () => {
  assert.equal(R.extractSubmitTaskId({ id: '9' }), '9')
  assert.equal(R.extractSubmitTaskId({ task_id: 't' }), 't')
  assert.equal(R.extractSubmitTaskId({ job_id: 'j' }), 'j')
  assert.throws(() => R.extractSubmitTaskId({}), /未返回任务/)
})

// ── BGM 节拍检测（对照 BeatDetectWorker L341-519）──

test('buildBeatmapPayload：count>0 才传 count；segment_duration>0 才传（对照 L379-383）', () => {
  assert.deepEqual(R.buildBeatmapPayload('/m.mp3', { count: 4, segmentDuration: 2 }), { file: '/m.mp3', count: 4, segment_duration: 2 })
  assert.deepEqual(R.buildBeatmapPayload('/m.mp3', {}), { file: '/m.mp3' })
  assert.throws(() => R.buildBeatmapPayload('', {}), /缺少音频文件/)
})

test('extractBeats：beats/beat_times/timestamps/beat_points + result 嵌套 + 数值排序（对照 L453-476）', () => {
  assert.deepEqual(R.extractBeats({ beats: [3, 1, 2] }), [1, 2, 3])
  assert.deepEqual(R.extractBeats({ beat_times: ['0.5', 1.5] }), [0.5, 1.5])
  assert.deepEqual(R.extractBeats({ result: { timestamps: [2, 1] } }), [1, 2])
  assert.deepEqual(R.extractBeats({ beat_points: [1] }), [1])
  assert.deepEqual(R.extractBeats({}), [])
  // 对照 L500-502：'x' 无法 float() → 异常 → 整体返回 []（null 跳过，但非法元素一票否决）
  assert.deepEqual(R.extractBeats({ beats: [null, 'x', 1] }), [])
})

test('extractBeatClips：clips {start,end,strength} 排序、过滤非法（对照 L478-519）', () => {
  const clips = R.extractBeatClips({
    clips: [
      { start: '2', end: 3, strength: '2' },
      { start: 0, end: 1 },
      { start: 5, end: 4 },   // end<=start 丢弃
      { start: 'x', end: 9 }, // 非法丢弃
      { start: 4, end: 5, strength: null },
    ],
  })
  assert.deepEqual(clips, [
    { start: 0, end: 1, strength: 1 },
    { start: 2, end: 3, strength: 2 },
    { start: 4, end: 5, strength: 1 },
  ])
  assert.deepEqual(R.extractBeatClips({ result: { clips: [{ start: 0, end: 1 }] } }).length, 1)
  assert.deepEqual(R.extractBeatClips({}), [])
})

// ── 卡点成片（对照 BeatVideoGenWorker L526-781）──

test('buildBeatPayload：仅传非空参数（对照 _submit_one L721-728）', () => {
  const p = R.buildBeatPayload({
    music: 'D:/m.mp3',
    videos: ['D:/a.mp4', 'D:/b.mp4'],
    count: 0, timeLimit: 30, variantCount: 2,
    minDuration: 1, maxDuration: 3,
    width: 1080, height: 1920, fps: 30, crf: 20,
    transition: 'fade', transitionDuration: 0.3,
  })
  assert.equal(p.count, undefined) // 0 → 不传
  assert.equal(p.time_limit, 30)
  assert.equal(p.variant_count, 2)
  assert.equal(p.min_duration, 1)
  assert.equal(p.max_duration, 3)
  assert.equal(p.aspect_ratio, undefined) // 空 → 不传
  assert.equal(p.transition, 'fade')
})

test('buildBeatPayload：music/videos 必填校验（对照 L713-718）', () => {
  assert.throws(() => R.buildBeatPayload({ videos: ['/a.mp4'] }), /缺少音乐文件/)
  assert.throws(() => R.buildBeatPayload({ music: '/m.mp3', videos: [] }), /没有可上传的镜头视频/)
})

test('extractBeatVariants：variants[] 优先，否则 result.file 单变体（对照 L624-653）', () => {
  const r1 = R.extractBeatVariants({ variants: [{ variant: 1, file: '/a.mp4' }, { variant: 2, file: '/b.mp4' }] })
  assert.equal(r1.length, 2)
  assert.deepEqual(r1[0], { variant: 1, file: '/a.mp4' })
  const r2 = R.extractBeatVariants({ file: '/c.mp4' })
  assert.deepEqual(r2, [{ variant: 1, file: '/c.mp4' }])
  const r3 = R.extractBeatVariants({})
  assert.deepEqual(r3, [{ variant: 1, file: '' }])
})

test('buildResultUrl：http 原样 / / 前缀拼 server / 否则 result_url（对照 _download L767-775）', () => {
  const s = 'http://s:8766'
  assert.equal(R.buildResultUrl(s, 't1', 'http://cdn/x.mp4', 0), 'http://cdn/x.mp4')
  assert.equal(R.buildResultUrl(s, 't1', '/files/x.mp4', 0), 'http://s:8766/files/x.mp4')
  assert.equal(R.buildResultUrl(s, 't1', '', 2), 'http://s:8766/montage/result/t1/2')
  assert.equal(R.buildResultUrl(s, 't1', '', undefined), 'http://s:8766/montage/result/t1')
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
