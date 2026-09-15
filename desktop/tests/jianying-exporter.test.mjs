// ══════════════════════════════════════════════════════════════
// jianying-exporter.test.mjs — 剪映草稿导出器单测
// 运行：node --test "tests/*.test.mjs"
// 对照基准（以原代码为准）：
//   · studio/utils/jianying_exporter.py（480 行）一比一移植校验：
//     TRANSITION_MAP 8 项 / _normalize_transitions / _parse_srt /
//     _timestamp_to_sec / export_multi_to_draft 草稿结构
// ══════════════════════════════════════════════════════════════
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const {
  TRANSITION_MAP,
  getDefaultDraftRoot,
  exportToDraft,
  exportMultiToDraft,
  normalizeTransitions,
  normalizeOneTransition,
  parseSrt,
  timestampToSec,
  appendKeywordTrack,
} = await import('../main/jianying-exporter.js')

// ── TRANSITION_MAP（对照原版 8 项资源 ID，禁止自拟）──

test('TRANSITION_MAP：8 项转场，名称与资源 ID 对照原版', () => {
  assert.equal(Object.keys(TRANSITION_MAP).length, 8)
  assert.deepEqual(Object.keys(TRANSITION_MAP), [
    'fade', 'dissolve', 'slideleft', 'slideright', 'slideup', 'slidedown', 'zoomin', 'zoomout',
  ])
  assert.equal(TRANSITION_MAP.fade.name, '模糊')
  assert.equal(TRANSITION_MAP.fade.resourceId, '6911569618171597320')
  assert.equal(TRANSITION_MAP.fade.effectId, '4212596')
  assert.equal(TRANSITION_MAP.dissolve.name, '叠化')
  assert.equal(TRANSITION_MAP.slideleft.name, '向左擦除')
  assert.equal(TRANSITION_MAP.slideright.name, '向右擦除')
  assert.equal(TRANSITION_MAP.slideup.name, '向上擦除')
  assert.equal(TRANSITION_MAP.slidedown.name, '向下擦除')
  assert.equal(TRANSITION_MAP.zoomin.name, '推近')
  assert.equal(TRANSITION_MAP.zoomout.name, '拉远')
  // 500ms 转场 is_overlap=true；1s 转场（zoom 系列）is_overlap=false
  for (const k of ['fade', 'dissolve', 'slideleft', 'slideright', 'slideup', 'slidedown']) {
    assert.equal(TRANSITION_MAP[k].isOverlap, true)
    assert.equal(TRANSITION_MAP[k].duration, 500000)
  }
  assert.equal(TRANSITION_MAP.zoomin.isOverlap, false)
  assert.equal(TRANSITION_MAP.zoomout.isOverlap, false)
  assert.equal(TRANSITION_MAP.zoomin.duration, 1000000)
})

// ── normalizeTransitions / normalizeOneTransition（对照 _normalize_* L273-314）──

test('normalizeTransitions：不足处按 fade 兜底，字符串规格展开为单元素', () => {
  // null → 全部默认 fade
  const r1 = normalizeTransitions(null, 3)
  assert.equal(r1.length, 3)
  for (const s of r1) { assert.equal(s.name, '模糊'); assert.equal(s.resource_id, '6911569618171597320') }
  // 单字符串 → 只覆盖第 0 个，其余 fade
  const r2 = normalizeTransitions('zoomin', 2)
  assert.equal(r2[0].name, '推近')
  assert.equal(r2[1].name, '模糊')
  // 超出 count 截断
  assert.equal(normalizeTransitions(['fade', 'fade', 'fade'], 2).length, 2)
})

test('normalizeOneTransition：none/空 → null；未知 key → fade 兜底；对象规格直通', () => {
  assert.equal(normalizeOneTransition(null), null)
  assert.equal(normalizeOneTransition('none'), null)
  assert.equal(normalizeOneTransition('无'), null)
  assert.equal(normalizeOneTransition(''), null)
  assert.equal(normalizeOneTransition('unknown_key').name, '模糊')
  const obj = normalizeOneTransition({ name: '自定义', resource_id: 'R1', effect_id: 'E1', is_overlap: 1, duration: '700000' })
  assert.deepEqual(obj, { name: '自定义', resource_id: 'R1', effect_id: 'E1', is_overlap: true, duration: 700000 })
  // 缺 resource_id 的对象 → null
  assert.equal(normalizeOneTransition({ name: 'x' }), null)
})

// ── timestampToSec / parseSrt（对照 _timestamp_to_sec L469-480 / _parse_srt L428-466）──

test('timestampToSec：逗号毫秒与点毫秒均可解析', () => {
  assert.equal(timestampToSec('00:00:02,120'), 2.12)
  assert.equal(timestampToSec('00:01:00.000'), 60)
  assert.equal(timestampToSec('01:00:00,000'), 3600)
  assert.equal(timestampToSec('bad'), 0)
})

test('parseSrt：多 cue 与多行文本；文件缺失返回空（原版 OSError 仅 warning）', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jy-srt-'))
  try {
    const p = path.join(tmp, 'a.srt')
    fs.writeFileSync(p, '1\n00:00:01,000 --> 00:00:02,500\n第一行\n第二行\n\n2\n00:00:03,000 --> 00:00:04,000\n你好\n', 'utf-8')
    const segs = parseSrt(p)
    assert.equal(segs.length, 2)
    assert.deepEqual(segs[0], [1, 2.5, '第一行 第二行'])
    assert.deepEqual(segs[1], [3, 4, '你好'])
    assert.deepEqual(parseSrt(path.join(tmp, 'missing.srt')), [])
  } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
})

// ── export_multi_to_draft 草稿结构（写真实临时目录，probeMedia 注入）──

let tmpRoot = ''
beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jy-draft-'))
  process.env.LOCALAPPDATA = tmpRoot // getDefaultDraftRoot 重定向
})
afterEach(() => { fs.rmSync(tmpRoot, { recursive: true, force: true }) })

const probeMedia = (p) => (p.endsWith('.mp4') ? { durationSec: 4, width: 1080, height: 1920 } : { durationSec: 10, width: 800, height: 600 })
const DEPS = { probeMedia }

test('exportMultiToDraft：视频缺失 / 空列表 → 失败且不落盘', () => {
  assert.deepEqual(exportMultiToDraft({ videoPaths: [] }), { success: false, message: '没有可导出的视频' })
  const r = exportMultiToDraft({ videoPaths: [path.join(tmpRoot, 'no.mp4')] })
  assert.equal(r.success, false)
  assert.match(r.message, /视频文件不存在/)
  assert.equal(getDefaultDraftRoot().startsWith(tmpRoot), true)
})

test('exportMultiToDraft：多段导出 → meta/content 结构逐字段对齐', () => {
  const v1 = path.join(tmpRoot, 'dubbed_a.mp4')
  const v2 = path.join(tmpRoot, 'dubbed_b.mp4')
  fs.writeFileSync(v1, 'x'); fs.writeFileSync(v2, 'x')
  const srt = path.join(tmpRoot, 'a.srt')
  fs.writeFileSync(srt, '1\n00:00:00,000 --> 00:00:01,000\n字幕A\n', 'utf-8')
  const bgm = path.join(tmpRoot, 'bgm.mp3')
  fs.writeFileSync(bgm, 'x')

  const r = exportMultiToDraft({
    videoPaths: [v1, v2],
    transitions: ['zoomin'],
    bgmPath: bgm,
    bgmVolume: 30,
    srtPaths: [srt, ''],
    draftName: '测试工程',
    deps: DEPS,
  })
  assert.equal(r.success, true)

  const meta = JSON.parse(fs.readFileSync(path.join(r.message, 'draft_meta_info.json'), 'utf-8'))
  assert.equal(meta.draft_name, '测试工程')
  assert.equal(meta.draft_type, 'face')
  assert.equal(meta.platform, 'windows')
  assert.equal(meta.draft_foldpath, r.message.split('\\').join('/'))

  const content = JSON.parse(fs.readFileSync(path.join(r.message, 'draft_content.json'), 'utf-8'))
  // canvas 取第 0 段 1080x1920 → 9:16
  assert.deepEqual(content.canvas_config, { width: 1080, height: 1920, ratio: '9:16' })
  // v2 schema 来源三元组（防版本漂移）
  assert.deepEqual(r.schemaVersion, { source: 'pyJianYingDraft 0.3.0 assets/draft_content_template.json', new_version: '110.0.0', version: 360000, generator_app_version: '5.9.0' })
  assert.equal(content.new_version, '110.0.0')
  assert.equal(content.version, 360000)
  // 素材库：2 视频 + 1 音频 + 1 字幕 + 1 转场 + speeds（每媒体片段 1 条）
  assert.equal(content.materials.videos.length, 2)
  assert.equal(content.materials.audios.length, 1)
  assert.equal(content.materials.texts.length, 1)
  assert.equal(content.materials.transitions.length, 1)
  assert.equal(content.materials.transitions[0].name, '推近')
  assert.equal(content.materials.transitions[0].resource_id, '6724226861666144779')
  assert.equal(content.materials.speeds.length, 4) // 视频2 + 字幕1 + BGM1
  // 视频轨 2 段顺序排布；转场挂「前一个」片段 extra_material_refs（[speed, 转场]）
  const videoTrack = content.tracks.find((t) => t.type === 'video')
  assert.equal(videoTrack.segments.length, 2)
  assert.equal(videoTrack.segments[0].extra_material_refs.length, 2)
  assert.equal(videoTrack.segments[1].extra_material_refs.length, 1)
  assert.deepEqual(videoTrack.segments[0].target_timerange, { start: 0, duration: 4000000 })
  assert.deepEqual(videoTrack.segments[1].target_timerange, { start: 4000000, duration: 4000000 })
  // v2 片段完整字段（pyJianYingDraft segment.py / video_segment.py）
  assert.equal(videoTrack.segments[0].render_index, 0)
  assert.deepEqual(videoTrack.segments[0].clip, { alpha: 1, flip: { horizontal: false, vertical: false }, rotation: 0, scale: { x: 1, y: 1 }, transform: { x: 0, y: 0 } })
  assert.deepEqual(videoTrack.segments[0].hdr_settings, { intensity: 1.0, mode: 1, nits: 1000 })
  assert.deepEqual(videoTrack.segments[0].source_timerange, { start: 0, duration: 4000000 })
  assert.equal(videoTrack.segments[0].visible, true)
  // 字幕轨：整体偏移到第 0 段内
  const textTrack = content.tracks.find((t) => t.type === 'text')
  assert.equal(textTrack.segments[0].target_timerange.start, 0)
  // BGM 音轨：volume=30/100、覆盖整条时间轴、clip=null（audio_segment.py）
  const audioTrack = content.tracks.find((t) => t.type === 'audio')
  assert.equal(audioTrack.segments[0].volume, 0.3)
  assert.equal(audioTrack.segments[0].clip, null)
  assert.equal(audioTrack.segments[0].target_timerange.duration, 8000000)
})

test('exportMultiToDraft：未传 draftName → 命名「螺丝钉智能混剪_多片段时间轴」/单段「螺丝钉智能混剪_{basename}」', () => {
  const v1 = path.join(tmpRoot, 'clip1.mp4')
  const v2 = path.join(tmpRoot, 'clip2.mp4')
  fs.writeFileSync(v1, 'x'); fs.writeFileSync(v2, 'x')
  const multi = exportMultiToDraft({ videoPaths: [v1, v2], deps: DEPS })
  assert.equal(JSON.parse(fs.readFileSync(path.join(multi.message, 'draft_meta_info.json'), 'utf-8')).draft_name, '螺丝钉智能混剪_多片段时间轴')
  const single = exportToDraft({ videoPath: v1, deps: DEPS })
  assert.equal(single.success, true)
  assert.equal(JSON.parse(fs.readFileSync(path.join(single.message, 'draft_meta_info.json'), 'utf-8')).draft_name, '螺丝钉智能混剪_clip1')
})

test('exportToDraft：视频不存在 → {success:false, message:"视频文件不存在"}', () => {
  assert.deepEqual(exportToDraft({ videoPath: '' }), { success: false, message: '视频文件不存在' })
})

test('exportMultiToDraft：横屏素材 → canvas ratio 16:9；BGM 不存在时静默跳过音轨', () => {
  const v = path.join(tmpRoot, 'land.avi') // 非 .mp4 命名 → probeMedia 返 800x600 分支
  fs.writeFileSync(v, 'x')
  const r = exportMultiToDraft({ videoPaths: [v], bgmPath: path.join(tmpRoot, 'no-bgm.mp3'), deps: DEPS })
  assert.equal(r.success, true)
  const content = JSON.parse(fs.readFileSync(path.join(r.message, 'draft_content.json'), 'utf-8'))
  assert.equal(content.canvas_config.ratio, '16:9')
  assert.equal(content.tracks.filter((t) => t.type === 'audio').length, 0)
})

// ── appendKeywordTrack（2026-09-10 用户裁决：花字/文字模板数据格式随剪映导出）──

test('appendKeywordTrack：命中行生成独立文本轨，命中词拼接+样式区分；同 kind 复用同一轨', () => {
  const srt = path.join(tmpRoot, 'kw.srt')
  fs.writeFileSync(srt, '1\n00:00:00,000 --> 00:00:02,000\n爆款好物限时上新\n\n2\n00:00:03,000 --> 00:00:05,000\n普通行没有关键词\n', 'utf-8')
  const tracks = [], materials = { texts: [] }, cache = {}
  appendKeywordTrack(tracks, materials, srt, ['爆款', '上新'], 'fancy', 0, null, cache)
  assert.equal(tracks.length, 1)             // 仅一条花字文本轨
  assert.equal(tracks[0].segments.length, 1) // 仅命中行生成条目
  assert.equal(materials.texts.length, 1)
  const mat = materials.texts[0]
  assert.equal(mat.type, 'text')
  assert.ok(mat.content.includes('爆款 上新'))
  assert.ok(mat.content.includes('"bold":true'))
  // v2：样式色为 [r,g,b] 0-1 浮点（#FFD700 → [1, 0.843..., 0]，text_segment.py 格式）
  const parsed = JSON.parse(mat.content)
  assert.deepEqual(parsed.styles[0].fill.content.solid.color, [1, 0.8431372549019608, 0])
  assert.equal(tracks[0].segments[0].target_timerange.start, 0)
  assert.equal(tracks[0].segments[0].target_timerange.duration, 2000000)
})

test('appendKeywordTrack：fancy/tpl 各一条独立轨；空词/无命中不生轨；offset 偏移生效', () => {
  const srt = path.join(tmpRoot, 'kw2.srt')
  fs.writeFileSync(srt, '1\n00:00:00,000 --> 00:00:01,000\n限时上新\n', 'utf-8')
  const tracks = [], materials = { texts: [] }, cache = {}
  appendKeywordTrack(tracks, materials, srt, [], 'fancy', 0, null, cache)      // 空词不生轨
  assert.equal(tracks.length, 0)
  appendKeywordTrack(tracks, materials, srt, ['不存在的词'], 'tpl', 0, null, cache) // 无命中不生轨
  assert.equal(tracks.length, 0)
  appendKeywordTrack(tracks, materials, srt, ['上新'], 'fancy', 5000000, null, cache)
  appendKeywordTrack(tracks, materials, srt, ['上新'], 'tpl', 5000000, null, cache)
  assert.equal(tracks.length, 2)              // fancy/tpl 各一条
  assert.notEqual(tracks[0].id, tracks[1].id)
  assert.equal(tracks[0].segments[0].target_timerange.start, 5000000) // offset 生效
  const tplMat = materials.texts[1]
  // v2：#4FC3F7 → [0.30980392156862746, 0.7647058823529411, 0.9686274509803922]
  const tplParsed = JSON.parse(tplMat.content)
  assert.deepEqual(tplParsed.styles[0].fill.content.solid.color, [0.30980392156862746, 0.7647058823529411, 0.9686274509803922])
})

test('exportMultiToDraft：textAnim/fancyEffectId → 入场动画 + 花字效果随行（M2a 剪映原生通道）', () => {
  const v = path.join(tmpRoot, 'fx.mp4')
  fs.writeFileSync(v, 'x')
  const srt = path.join(tmpRoot, 'fx.srt')
  fs.writeFileSync(srt, '1\n00:00:00,000 --> 00:00:02,000\n只要199元就买它\n', 'utf-8')
  const r = exportMultiToDraft({
    videoPaths: [v],
    srtPaths: [srt],
    fxWords: ['199元'],
    fxKinds: ['fancy'],
    textAnim: '复古打字机',
    fancyEffectId: '7495312625169911065',
    draftName: '动画测试',
    deps: DEPS,
  })
  assert.equal(r.success, true)
  const content = JSON.parse(fs.readFileSync(path.join(r.message, 'draft_content.json'), 'utf-8'))
  // 入场动画进 materials.material_animations，片段挂引用（字幕1 + fancy关键词1 = 2）
  assert.equal(content.materials.material_animations.length, 2)
  const anim = content.materials.material_animations[0]
  assert.equal(anim.type, 'sticker_animation')
  assert.equal(anim.animations[0].type, 'in')
  assert.equal(anim.animations[0].name, '复古打字机')
  assert.equal(anim.animations[0].resource_id, '7253888335163167291')
  assert.equal(anim.animations[0].id, '17639720')
  // 花字效果进 materials.effects，content.effectStyle 引用
  assert.equal(content.materials.effects.length, 1)
  assert.equal(content.materials.effects[0].type, 'text_effect')
  assert.equal(content.materials.effects[0].resource_id, '7495312625169911065')
  const kwText = content.materials.texts
    .map((t) => JSON.parse(t.content))
    .find((c) => c.text === '199元' && c.styles[0].bold) // 关键词轨文本（加粗）
  assert.ok(kwText, '关键词轨文本应存在')
  assert.deepEqual(kwText.styles[0].effectStyle, { id: '7495312625169911065', path: 'C:' })
  // 片段引用：动画/效果 id 均在文本轨 extra_material_refs（effect 仅在 fancy 关键词轨）
  const refs = content.tracks.filter((t) => t.type === 'text').flatMap((s) => s.segments.flatMap((x) => x.extra_material_refs))
  assert.ok(refs.includes(content.materials.material_animations[0].id))
  assert.ok(refs.includes(content.materials.effects[0].id))
  // 未命中的动画名不生成动画素材（不造假）
  const r2 = exportMultiToDraft({ videoPaths: [v], srtPaths: [srt], textAnim: '不存在的动画', draftName: '动画测试2', deps: DEPS })
  const c2 = JSON.parse(fs.readFileSync(path.join(r2.message, 'draft_content.json'), 'utf-8'))
  assert.equal(c2.materials.material_animations.length, 0)
})

// ── 剪映原生文字模板三件套（2026-09-15 用户裁决：模板引用由 .textpreset 机械重排，
//    结构范本=王晗雨解密草稿「超级推荐」实例，逐字段对照见 buildTemplateClipTrio）──

const {
  findTextPreset,
  presetAttachToDraft,
  buildTemplateClipTrio,
  normalizeTextTemplateClips,
} = await import('../main/jianying-exporter.js')

const TPL_RID = '7575772843741580569'

/** 构造迷你「超级推荐」同构 .textpreset（资源目录落盘以测 sticker 动画方向推断） */
function writeFixturePreset(root) {
  const presetDir = path.join(root, 'JianyingPro', 'User Data', 'Presets', 'Text_V2')
  fs.mkdirSync(presetDir, { recursive: true })
  const dirs = {
    fonts: path.join(root, 'cache', 'effect', 'F1', 'h1'),
    text1: path.join(root, 'cache', 'effect', 'T1', 'h1'),
    text2: path.join(root, 'cache', 'effect', 'T2', 'h1'),
    sticker: path.join(root, 'cache', 'effect', 'S1', 'h1'),
    flower: path.join(root, 'cache', 'artistEffect', 'FL1', 'h1'),
    template: path.join(root, 'JianyingPro', 'User Data', 'Cache', 'artistEffect', TPL_RID, 'hashA'),
  }
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(path.join(dirs.sticker, 'Rotate.lua'), 'x') // → loop
  // 134x122 最小 PNG（IHDR 尺寸头与 element original_size 精确配对，供二期③贴纸轨配对逻辑）
  const png = Buffer.alloc(24); png.writeUInt32BE(134, 16); png.writeUInt32BE(122, 20)
  fs.writeFileSync(path.join(dirs.sticker, 'pair.png'), png)
  fs.writeFileSync(path.join(dirs.template, 'config.json'), '{}')
  const content = JSON.stringify({
    text: '超级推荐',
    styles: [{
      fill: { content: { render_type: 'solid', solid: { color: [0.99215686321258545, 0.984313726425171, 0.984313726425171] } } },
      font: { path: dirs.fonts + '/字由奇巧.ttf', id: 'F1' },
      size: 15,
      effectStyle: { path: dirs.flower.split('\\').join('/'), id: 'FL1' },
      range: [0, 4],
    }],
  })
  const preset = {
    version: 5,
    type: 'text',
    effect: {
      category_id: '10682', category_name: '好物种草', effect_id: TPL_RID,
      effect_name: '超级推荐', effect_version: '1.0.0', platform: 'all',
      resource_id: TPL_RID, source_platform: 'artist',
    },
    resources: [
      { file_path: dirs.fonts + '/字由奇巧.ttf', panel: 'fonts', resource_id: 'F1', source_platform: 'artist' },
      { file_path: dirs.text1, panel: 'text', resource_id: 'T1', source_platform: 'artist' },
      { file_path: dirs.text2, panel: 'text', resource_id: 'T2', source_platform: 'artist' },
      { file_path: dirs.sticker, panel: 'sticker', resource_id: 'S1', source_platform: 'artist' },
      { file_path: dirs.flower, panel: 'flower', resource_id: 'FL1', source_platform: 'artist' },
      { file_path: dirs.text1, panel: 'default', resource_id: 'D1', source_platform: 'artist' },
    ],
    paragraphs: [{
      attach_info: {
        clip: { position_size_checked: true, rotation: -4.664638519287109, scale_x: 2.390739679336548, scale_y: 2.481419324874878, transform_x: -3, transform_y: -13 },
        duration: 1166666, original_size_height: 87.5, original_size_width: 275, start_time: 0,
      },
      // text_name = 模板工程文字元素 id（texts.name 槽位绑定键，缺失时剪映渲染默认文字）
      text_name: '343E12FD-629B-4ffe-A7AF-DA54FDBC2E64',
      style: { color: '#fdfbfbff', line_spacing: 0.1, font_size: 15 },
      content,
    }],
    elements: [{
      attach_info: {
        clip: { position_size_checked: true, rotation: -7.99, scale_x: 0.636, scale_y: 0.636, transform_x: -89.04, transform_y: 145.76 },
        duration: 1166666, original_size_height: 122, original_size_width: 134, start_time: 0,
      },
      element_name: 'ELEM-1', shape_params: { shape_type: 0 }, type: 'sticker',
    }],
  }
  fs.writeFileSync(path.join(presetDir, TPL_RID + '.textpreset'), JSON.stringify(preset), 'utf-8')
  return { preset, dirs }
}

/** 旧 tpl 蓝字关键词轨文本识别（#4FC3F7 solid fill + bold，KEYWORD_TRACK_STYLES.tpl） */
function isBlueKeywordText(t) {
  try {
    const c = JSON.parse(t.content)
    const st = c.styles && c.styles[0]
    return !!(st && st.bold && st.fill && st.fill.content && st.fill.content.solid
      && st.fill.content.solid.color[0] === 0.30980392156862746)
  } catch (_) { return false }
}

test('findTextPreset：按 resource_id 命中；目录缺失/未知 id 返回 null', () => {
  const presetDir = path.join(tmpRoot, 'JianyingPro', 'User Data', 'Presets', 'Text_V2')
  assert.equal(findTextPreset(presetDir, TPL_RID), null) // 目录不存在不抛
  writeFixturePreset(tmpRoot)
  const p = findTextPreset(presetDir, TPL_RID)
  assert.ok(p && p.effect && p.effect.resource_id === TPL_RID)
  assert.equal(findTextPreset(presetDir, '999'), null)
})

test('normalizeTextTemplateClips：逐视频对齐 / jy_ 前缀剥离 / 非法条目丢弃 / startUs 排序', () => {
  assert.equal(normalizeTextTemplateClips(null, 2), null)
  const r = normalizeTextTemplateClips([
    [
      { phrase: 'b', startUs: 2, durUs: 1, resourceId: 'jy_R2' },
      { phrase: 'a', startUs: 1, durUs: 1, resourceId: 'R1' },
      { phrase: 'n1', startUs: 0, durUs: 5, resourceId: '' },     // 空 rid 丢弃
      { phrase: 'n2', startUs: 0, durUs: 0, resourceId: 'R4' },   // 零时长丢弃
    ],
    'not-an-array',
  ], 3)
  assert.equal(r.length, 3)
  assert.deepEqual(r[0].map((c) => c.resourceId), ['R1', 'R2']) // 排序 + 前缀剥离
  assert.deepEqual(r[1], [])
  assert.deepEqual(r[2], [])
})

test('presetAttachToDraft：scale/transform 拆对象 + flip 补空（范本同构）', () => {
  const d = presetAttachToDraft({ clip: { scale_x: 2.39, scale_y: 2.48, rotation: -4.66, transform_x: -3, transform_y: -13 }, duration: 1166666, original_size_width: 275, original_size_height: 87.5 })
  assert.deepEqual(d, {
    duration: 1166666, original_size_width: 275, original_size_height: 87.5,
    clip: { scale: { x: 2.39, y: 2.48 }, rotation: -4.66, transform: { x: -3, y: -13 }, flip: {} },
  })
  assert.deepEqual(presetAttachToDraft(null).clip.scale, { x: 1, y: 1 })
})

test('buildTemplateClipTrio：effect/resources/attach 逐字段映射 + texts 填充 + panel 推导引用', () => {
  const { dirs } = writeFixturePreset(tmpRoot)
  const p = findTextPreset(path.join(tmpRoot, 'JianyingPro', 'User Data', 'Presets', 'Text_V2'), TPL_RID)
  const trio = buildTemplateClipTrio(p, '199元')
  assert.ok(trio)
  const tpl = trio.templateMaterial
  // 范本字段：effect 段直映 + path 指向模板自身 artistEffect 缓存包
  assert.equal(tpl.type, 'text_template')
  assert.equal(tpl.effect_id, TPL_RID)
  assert.equal(tpl.resource_id, TPL_RID)
  assert.equal(tpl.name, '超级推荐')
  assert.equal(tpl.category_id, '10682')
  assert.equal(tpl.category_name, '好物种草')
  assert.equal(tpl.source_platform, 1)
  assert.equal(tpl.path.split('\\').join('/').endsWith('/Cache/artistEffect/' + TPL_RID + '/hashA'), true)
  // resources：panel/path/resource_id 同构（file_path → path），source_platform 数值化
  assert.equal(tpl.resources.length, 6)
  assert.deepEqual(tpl.resources[0], { panel: 'fonts', path: dirs.fonts.replace(/\\/g, '/') + '/字由奇巧.ttf', resource_id: 'F1', source_platform: 1 })
  // text_info_resources：attach_info 范本数值原样 + text_material_id 绑定 texts 条目
  assert.equal(tpl.text_info_resources.length, 1)
  const tir = tpl.text_info_resources[0]
  assert.equal(tir.attach_info.duration, 1166666)
  assert.equal(tir.attach_info.clip.scale.x, 2.390739679336548)
  assert.equal(tir.text_material_id, trio.textEntry.id)
  // non_text_info_resources：element_name/attach 同构
  assert.equal(tpl.non_text_info_resources.length, 1)
  assert.equal(tpl.non_text_info_resources[0].name, 'ELEM-1')
  assert.equal(tpl.non_text_info_resources[0].type, 'sticker')
  assert.equal(tpl.non_text_info_resources[0].attach_info.clip.scale.x, 0.636)
  // texts：填充文字替换 + range 对齐 + 字体/花字引用/颜色（范本形状）
  const parsed = JSON.parse(trio.textEntry.content)
  assert.equal(parsed.text, '199元')
  assert.deepEqual(parsed.styles[0].range, [0, 4])
  assert.deepEqual(parsed.styles[0].effectStyle, { path: dirs.flower.replace(/\\/g, '/'), id: 'FL1' })
  assert.equal(trio.textEntry.fonts[0].resource_id, 'F1')
  assert.equal(trio.textEntry.type, 'text')
  assert.equal(trio.textEntry.check_flag, 47)
  assert.equal(trio.textEntry.text_color, '#fdfbfbff') // 预设 style.color 透传（范本小写口径）
  // 槽位绑定键：texts.name = 预设 text_name（模板工程文字元素 id）
  assert.equal(trio.textEntry.name, '343E12FD-629B-4ffe-A7AF-DA54FDBC2E64')
  // panel 推导：text 动画 1 素材（in+loop 两资源）+ flower 效果 1 + sticker 动画 1（Rotate.lua→loop）
  assert.equal(trio.animMaterials.length, 2)
  const textAnim = trio.animMaterials[0]
  assert.equal(textAnim.type, 'sticker_animation')
  assert.equal(textAnim.animations.length, 2)
  assert.equal(textAnim.animations[0].type, 'in')
  assert.equal(textAnim.animations[0].resource_id, 'T1')
  assert.equal(textAnim.animations[1].type, 'loop')
  assert.equal(textAnim.animations[1].resource_id, 'T2')
  assert.equal(trio.flowerEffects.length, 1)
  assert.equal(trio.flowerEffects[0].type, 'text_effect')
  assert.equal(trio.flowerEffects[0].resource_id, 'FL1')
  const stickerAnim = trio.animMaterials[1]
  assert.equal(stickerAnim.animations[0].type, 'loop') // Rotate.lua
  assert.equal(stickerAnim.animations[0].resource_id, 'S1')
  // 引用集合：text_info 挂 [flower, textAnim]，segment 挂全部
  assert.deepEqual(tir.extra_material_refs, [trio.flowerEffects[0].id, textAnim.id])
  assert.deepEqual(trio.extraRefs, [trio.flowerEffects[0].id, textAnim.id, stickerAnim.id])
  // 空短语回退预设原文
  const trio2 = buildTemplateClipTrio(p, '  ')
  assert.equal(JSON.parse(trio2.textEntry.content).text, '超级推荐')
})

test('exportMultiToDraft：textTemplateClips → 原生模板轨三件套 + tpl 蓝字轨/贴纸轨替代', () => {
  writeFixturePreset(tmpRoot)
  const v1 = path.join(tmpRoot, 'dubbed_t1.mp4')
  const v2 = path.join(tmpRoot, 'dubbed_t2.mp4')
  fs.writeFileSync(v1, 'x'); fs.writeFileSync(v2, 'x')
  const srt = path.join(tmpRoot, 't.srt')
  fs.writeFileSync(srt, '1\n00:00:00,000 --> 00:00:02,000\n限时上新199元\n', 'utf-8')
  const r = exportMultiToDraft({
    videoPaths: [v1, v2],
    srtPaths: [srt, srt],
    fxWords: ['199元'],
    fxKinds: ['fancy', 'tpl'],
    tplEffectId: TPL_RID,
    textTemplateClips: [
      [],
      [{ phrase: '199元', startUs: 500000, durUs: 1500000, resourceId: 'jy_' + TPL_RID }],
    ],
    draftName: '原生模板轨测试',
    deps: DEPS,
  })
  assert.equal(r.success, true)
  const content = JSON.parse(fs.readFileSync(path.join(r.message, 'draft_content.json'), 'utf-8'))
  // 三件套：1 实例 + 1 texts 填充条目 + 文字轨 segment material_id 指模板实例
  assert.equal(content.materials.text_templates.length, 1)
  const tpl = content.materials.text_templates[0]
  assert.equal(tpl.resource_id, TPL_RID)
  assert.ok(content.materials.texts.some((t) => t.id === tpl.text_info_resources[0].text_material_id))
  const tplTrack = content.tracks.find((t) => t.type === 'text' && t.segments.some((s) => s.material_id === tpl.id))
  assert.ok(tplTrack, '模板轨应存在且 segment.material_id=模板实例 id')
  assert.equal(tplTrack.segments.length, 1)
  const seg = tplTrack.segments.find((s) => s.material_id === tpl.id)
  // 第二个视频（4s 分条）时间轴偏移：4s+0.5s 起，1.5s 长
  assert.equal(seg.target_timerange.start, 4500000)
  assert.equal(seg.target_timerange.duration, 1500000)
  // 片段引用：模板动画/花字 id 全在 extra_material_refs
  for (const ref of tpl.text_info_resources[0].extra_material_refs) {
    assert.ok(seg.extra_material_refs.includes(ref))
  }
  assert.ok(content.materials.material_animations.length >= 2) // text in+loop + sticker loop
  assert.equal(content.materials.effects.length, 1) // flower（fancyEffectId 未传，别无 effects）
  // 有原生命中 → 旧 tpl 蓝字关键词轨不再生成（fancy 照旧）、tplEffectId 贴纸轨跳过
  assert.equal(content.materials.texts.filter(isBlueKeywordText).length, 0, 'tpl 蓝字关键词轨应被原生模板实例替代')
  assert.equal(content.materials.stickers.length, 0, '贴纸轨应被模板实例自带贴纸替代')
  // 填充文字条目（范本形状带 fonts 数组）恰好 1 条
  const filled = content.materials.texts.filter((t) => Array.isArray(t.fonts) && JSON.parse(t.content).text === '199元')
  assert.equal(filled.length, 1)
})

test('exportMultiToDraft：无命中（空 clips）→ 回退旧 tpl 蓝字轨 + 贴纸轨（离线兼容）', () => {
  writeFixturePreset(tmpRoot)
  const v = path.join(tmpRoot, 'dubbed_t3.mp4')
  fs.writeFileSync(v, 'x')
  const srt = path.join(tmpRoot, 't3.srt')
  fs.writeFileSync(srt, '1\n00:00:00,000 --> 00:00:02,000\n限时上新199元\n', 'utf-8')
  const r = exportMultiToDraft({
    videoPaths: [v],
    srtPaths: [srt],
    fxWords: ['199元'],
    fxKinds: ['tpl'],
    tplEffectId: TPL_RID,
    textTemplateClips: [[]],
    draftName: '回退口径测试',
    deps: DEPS,
  })
  assert.equal(r.success, true)
  const content = JSON.parse(fs.readFileSync(path.join(r.message, 'draft_content.json'), 'utf-8'))
  assert.equal(content.materials.text_templates.length, 0)
  assert.equal(content.materials.stickers.length >= 1, true) // 二期③贴纸轨照旧
  assert.equal(content.materials.texts.filter(isBlueKeywordText).length, 1) // 旧蓝字轨回退
})
