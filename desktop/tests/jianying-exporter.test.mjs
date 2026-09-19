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
  appendSfxTrackFromEvents,
  appendTextTemplateSegments,
  jianyingSubtitleStyleFromServer,
  registerInRootMeta,
  verifyDraftFolder,
  validateDraftPackage,
  auditDraftStandardConformance,
  buildSubtitleSegment,
  VIDEO_GAP_US,
  SUBTITLE_TRANSFORM_Y,
  SUBTITLE_ALIGNMENT,
  SUBTITLE_FONT_SIZE_DEFAULT,
  TEXT_TEMPLATE_TRANSFORM_Y,
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
  // 2026-09-17 对齐收尾：meta 字段名对齐标准 §1.6 骨架（draft_fold_path / draft_root_path）
  assert.equal(meta.draft_fold_path, r.message.split('\\').join('/'))
  assert.equal(meta.draft_root_path, getDefaultDraftRoot().split('\\').join('/'))

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
  assert.equal(content.materials.speeds.length, 5) // 视频2 + 字幕1 + BGM2（2026-09-18：逐视频窗各一段）
  // 视频轨 2 段顺序排布；转场挂「前一个」片段 extra_material_refs（[speed, 转场]）
  const videoTrack = content.tracks.find((t) => t.type === 'video')
  assert.equal(videoTrack.segments.length, 2)
  assert.equal(videoTrack.segments[0].extra_material_refs.length, 2)
  assert.equal(videoTrack.segments[1].extra_material_refs.length, 1)
  assert.deepEqual(videoTrack.segments[0].target_timerange, { start: 0, duration: 4000000 })
  // 2026-09-16 用户裁决：视频片段之间添加半秒（500000 微秒）间隔
  assert.deepEqual(videoTrack.segments[1].target_timerange, { start: 4500000, duration: 4000000 })
  // v2 片段完整字段（pyJianYingDraft segment.py / video_segment.py）
  assert.equal(videoTrack.segments[0].render_index, 0)
  assert.deepEqual(videoTrack.segments[0].clip, { alpha: 1, flip: { horizontal: false, vertical: false }, rotation: 0, scale: { x: 1, y: 1 }, transform: { x: 0, y: 0 } })
  assert.deepEqual(videoTrack.segments[0].hdr_settings, { intensity: 1.0, mode: 1, nits: 1000 })
  assert.deepEqual(videoTrack.segments[0].source_timerange, { start: 0, duration: 4000000 })
  assert.equal(videoTrack.segments[0].visible, true)
  // 字幕轨：整体偏移到第 0 段内
  const textTrack = content.tracks.find((t) => t.type === 'text')
  assert.equal(textTrack.segments[0].target_timerange.start, 0)
  // 2026-09-19 改判 F3（用户报障：字幕轨与普通文本轨无区别）：flag=1=剪映「字幕轨」属性
  assert.equal(textTrack.flag, 1)
  // 2026-09-16 修复（用户实测：字幕显示在画面中间）：字幕=屏幕下方 + 水平居中
  // （pyJianYingDraft ClipSettings(transform_y=-0.8) 口径，clip.transform 单位=半画布）
  assert.deepEqual(textTrack.segments[0].clip.transform, { x: 0, y: SUBTITLE_TRANSFORM_Y })
  assert.equal(content.materials.texts[0].alignment, SUBTITLE_ALIGNMENT)
  // BGM 音轨：volume=30/100、clip=null（audio_segment.py）
  const audioTrack = content.tracks.find((t) => t.type === 'audio')
  assert.equal(audioTrack.segments[0].volume, 0.3)
  assert.equal(audioTrack.segments[0].clip, null)
  // 2026-09-18 用户裁决：单 BGM 逐视频窗落段（第一段截断于第一个视频结尾，
  // 不是整条时间轴；间隔期静音）；源游标跨窗连续（第二段从 4s 处接着取）
  assert.equal(audioTrack.segments.length, 2)
  assert.deepEqual(audioTrack.segments[0].target_timerange, { start: 0, duration: 4000000 })
  assert.deepEqual(audioTrack.segments[0].source_timerange, { start: 0, duration: 4000000 })
  assert.deepEqual(audioTrack.segments[1].target_timerange, { start: 4500000, duration: 4000000 })
  assert.deepEqual(audioTrack.segments[1].source_timerange, { start: 4000000, duration: 4000000 })
  // 2026-09-17 对齐收尾（标准 §4.2）：音频素材 local_material_id / music_id = id
  const audioMat = content.materials.audios[0]
  assert.equal(audioMat.local_material_id, audioMat.id)
  assert.equal(audioMat.music_id, audioMat.id)
  // 2026-09-17 golden 对照抓出的存量 bug 钉住：BGM 段 material_id 必须指向 audios 素材（§7-⑤ 无悬空）
  assert.equal(audioTrack.segments[0].material_id, audioMat.id)
  // 2026-09-17 对齐收尾（标准 §4.3）：texts 基准字段 line_max_width + content.useLetterColor
  assert.equal(content.materials.texts[0].line_max_width, 0.82)
  assert.equal(JSON.parse(content.materials.texts[0].content).styles[0].useLetterColor, true)
  // 2026-09-18 用户裁决：字幕字号默认 10 号（原缺省 8 实测偏小；第四步「字号」可覆写）
  assert.equal(JSON.parse(content.materials.texts[0].content).styles[0].size, 10)
  // 2026-09-17 对齐收尾（标准 §0.3 条3）：本路径全走标准构造器，符合性审计预期 0 警告
  assert.equal(r.conformance.warnings.length, 0)
  assert.ok(r.conformance.checkedSegs >= 4)
})

test('exportMultiToDraft：bgmPaths 逐视频 BGM → 各窗各素材，源游标按素材独立（2026-09-18）', () => {
  const v1 = path.join(tmpRoot, 'p_a.mp4')
  const v2 = path.join(tmpRoot, 'p_b.mp4')
  fs.writeFileSync(v1, 'x'); fs.writeFileSync(v2, 'x')
  const bgmA = path.join(tmpRoot, 'rowa.mp3')
  const bgmB = path.join(tmpRoot, 'rowb.mp3')
  fs.writeFileSync(bgmA, 'x'); fs.writeFileSync(bgmB, 'x')
  const r = exportMultiToDraft({
    videoPaths: [v1, v2],
    bgmPaths: [bgmA, bgmB],
    bgmVolume: 40,
    draftName: '逐视频BGM',
    deps: DEPS,
  })
  assert.equal(r.success, true)
  assert.equal(r.bgmIncluded, true)
  const content = JSON.parse(fs.readFileSync(path.join(r.message, 'draft_content.json'), 'utf-8'))
  // 两个不同 BGM 文件 → 两份音频素材
  assert.equal(content.materials.audios.length, 2)
  const audioTrack = content.tracks.find((t) => t.type === 'audio')
  assert.equal(audioTrack.segments.length, 2)
  const matA = content.materials.audios.find((m) => m.path.endsWith('rowa.mp3'))
  const matB = content.materials.audios.find((m) => m.path.endsWith('rowb.mp3'))
  assert.ok(matA && matB && matA.id !== matB.id)
  // 第一窗引用 A、第二窗引用 B；各自源游标从 0 起（独立素材，不跨素材连续）
  assert.equal(audioTrack.segments[0].material_id, matA.id)
  assert.deepEqual(audioTrack.segments[0].source_timerange, { start: 0, duration: 4000000 })
  assert.equal(audioTrack.segments[1].material_id, matB.id)
  assert.deepEqual(audioTrack.segments[1].source_timerange, { start: 0, duration: 4000000 })
  assert.deepEqual(audioTrack.segments[1].target_timerange, { start: 4500000, duration: 4000000 })
  assert.equal(audioTrack.segments[0].volume, 0.4)
  assert.equal(r.conformance.warnings.length, 0)
})

test('exportMultiToDraft：bgmPaths 空串窗回退全局 bgmPath（2026-09-18）', () => {
  const v1 = path.join(tmpRoot, 'f_a.mp4')
  const v2 = path.join(tmpRoot, 'f_b.mp4')
  fs.writeFileSync(v1, 'x'); fs.writeFileSync(v2, 'x')
  const g = path.join(tmpRoot, 'global.mp3')
  const rowB = path.join(tmpRoot, 'onlyrow.mp3')
  fs.writeFileSync(g, 'x'); fs.writeFileSync(rowB, 'x')
  // 窗0 空串→回退全局 global；窗1 指派 onlyrow
  const r = exportMultiToDraft({
    videoPaths: [v1, v2],
    bgmPath: g,
    bgmPaths: ['', rowB],
    bgmVolume: 50,
    draftName: '回退',
    deps: DEPS,
  })
  assert.equal(r.success, true)
  assert.equal(r.bgmIncluded, true)
  const content = JSON.parse(fs.readFileSync(path.join(r.message, 'draft_content.json'), 'utf-8'))
  const audioTrack = content.tracks.find((t) => t.type === 'audio')
  const matG = content.materials.audios.find((m) => m.path.endsWith('global.mp3'))
  const matRow = content.materials.audios.find((m) => m.path.endsWith('onlyrow.mp3'))
  assert.equal(audioTrack.segments[0].material_id, matG.id)
  assert.equal(audioTrack.segments[1].material_id, matRow.id)
})

test('exportMultiToDraft：仅逐行 BGM（全局空）仍落轨；均无 BGM 则 bgmIncluded=false（2026-09-18）', () => {
  const v1 = path.join(tmpRoot, 'g_a.mp4')
  fs.writeFileSync(v1, 'x')
  const rowOnly = path.join(tmpRoot, 'rowonly.mp3')
  fs.writeFileSync(rowOnly, 'x')
  const r1 = exportMultiToDraft({ videoPaths: [v1], bgmPaths: [rowOnly], bgmVolume: 50, draftName: '仅逐行', deps: DEPS })
  assert.equal(r1.success, true)
  assert.equal(r1.bgmIncluded, true)
  const c1 = JSON.parse(fs.readFileSync(path.join(r1.message, 'draft_content.json'), 'utf-8'))
  assert.ok(c1.tracks.some((t) => t.type === 'audio'))
  // 全局空 + 逐行空/文件不存在 → 不落 BGM 轨
  const r2 = exportMultiToDraft({ videoPaths: [v1], bgmPaths: [''], bgmVolume: 50, draftName: '无BGM', deps: DEPS })
  assert.equal(r2.success, true)
  assert.equal(r2.bgmIncluded, false)
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

test('presetAttachToDraft：按当前视频画布等比钳制 scale（2026-09-18 文字模板超宽修复）', () => {
  const attach = { clip: { scale_x: 4, scale_y: 2, rotation: 0, transform_x: 0, transform_y: 0 }, duration: 1000, original_size_width: 300, original_size_height: 100 }
  // 宽度超出：effW=300×4=1200 > 1080 → factor=0.9，等比缩小 x/y；original_size 不变
  const d = presetAttachToDraft(attach, 1080, 1920)
  assert.equal(d.original_size_width, 300)
  assert.ok(Math.abs(d.clip.scale.x - 3.6) < 1e-9, `scale.x 应钳到 3.6，实际 ${d.clip.scale.x}`)
  assert.ok(Math.abs(d.clip.scale.y - 1.8) < 1e-9, `scale.y 等比钳到 1.8，实际 ${d.clip.scale.y}`)
  // 均不超出 → 原样（factor=1）
  assert.deepEqual(presetAttachToDraft(attach, 1920, 1080).clip.scale, { x: 4, y: 2 })
  // 画布尺寸缺失（0）→ 原样（向后兼容旧口径，无从换算不强缩）
  assert.deepEqual(presetAttachToDraft(attach).clip.scale, { x: 4, y: 2 })
  // 高度超出触发：effH=100×2=200 > 150 → factor=0.75，x 亦等比 ×0.75
  const dh = presetAttachToDraft(attach, 100000, 150)
  assert.ok(Math.abs(dh.clip.scale.y - 1.5) < 1e-9, `scale.y 应钳到 1.5，实际 ${dh.clip.scale.y}`)
  assert.ok(Math.abs(dh.clip.scale.x - 3) < 1e-9, `scale.x 等比钳到 3，实际 ${dh.clip.scale.x}`)
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

test('buildTemplateClipTrio：传画布尺寸→模板 attach scale 按画布钳制（超宽修复端到端）', () => {
  writeFixturePreset(tmpRoot)
  const p = findTextPreset(path.join(tmpRoot, 'JianyingPro', 'User Data', 'Presets', 'Text_V2'), TPL_RID)
  // fixture 主体 original_size_width=275, scale_x≈2.3907 → effW≈657.45；画布宽 500 触发钳制
  const trio = buildTemplateClipTrio(p, '199元', 500, 1200)
  const att = trio.templateMaterial.text_info_resources[0].attach_info
  assert.equal(att.original_size_width, 275, 'original_size 不随钳制改变')
  // 钳制后实际像素宽 = 275 × scale.x ≈ 画布宽 500（不超）
  assert.ok(Math.abs(275 * att.clip.scale.x - 500) < 1e-6, `钳制后 effW 应≈500，实际 ${275 * att.clip.scale.x}`)
  // 不传画布（默认 0）→ 保持预设原 scale（向后兼容）
  const trio0 = buildTemplateClipTrio(p, '199元')
  assert.ok(Math.abs(trio0.templateMaterial.text_info_resources[0].attach_info.clip.scale.x - 2.390739679336548) < 1e-9)
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
  // 第二个视频（4s 分条）时间轴偏移：4s(第一段) + 0.5s(片段间隔) + 0.5s(段内局部起点) 起，1.5s 长
  assert.equal(seg.target_timerange.start, 5000000)
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

test('exportMultiToDraft：预设缺失（模板零成段）→ tpl 蓝字轨兜底 + textTpl* 诊断回传（2026-09-19 根因④）', () => {
  // 不写 fixture preset → Text_V2 无任何 .textpreset → findTextPreset 全空、模板段零产出
  const v = path.join(tmpRoot, 'dubbed_t4.mp4')
  fs.writeFileSync(v, 'x')
  const srt = path.join(tmpRoot, 't4.srt')
  fs.writeFileSync(srt, '1\n00:00:00,000 --> 00:00:02,000\n限时上新199元\n', 'utf-8')
  const r = exportMultiToDraft({
    videoPaths: [v],
    srtPaths: [srt],
    fxWords: ['199元'],
    fxKinds: ['tpl'],
    tplEffectId: TPL_RID,
    textTemplateClips: [
      [{ phrase: '199元', startUs: 500000, durUs: 1500000, resourceId: 'jy_' + TPL_RID }],
    ],
    draftName: '预设缺失兜底测试',
    deps: DEPS,
  })
  assert.equal(r.success, true)
  // 诊断回传：输入命中非空（expected）、预设零成段（appended=0）、蓝字兜底 1 段
  assert.equal(r.textTplExpected, true)
  assert.equal(r.textTplAppended, 0)
  assert.equal(r.textTplKwFallbackSegs, 1)
  const content = JSON.parse(fs.readFileSync(path.join(r.message, 'draft_content.json'), 'utf-8'))
  assert.equal(content.materials.text_templates.length, 0)
  assert.equal(content.materials.texts.filter(isBlueKeywordText).length, 1, '预设缺失时蓝字轨应兜底补建，关键词不再全灭')
})

test('exportMultiToDraft：voiceClips → 口播独立音频轨 + 有口播的素材段静音（音频三轨体系）', () => {
  const v1 = path.join(tmpRoot, 'dubbed_v1.mp4')
  const v2 = path.join(tmpRoot, 'dubbed_v2.mp4')
  const wav = path.join(tmpRoot, 'voice_1.wav')
  fs.writeFileSync(v1, 'x'); fs.writeFileSync(v2, 'x'); fs.writeFileSync(wav, 'x')
  const r = exportMultiToDraft({
    videoPaths: [v1, v2],
    voiceClips: [
      [{ path: wav, startUs: 0, durUs: 2000000 }],
      [],
    ],
    draftName: '口播轨测试',
    deps: DEPS,
  })
  assert.equal(r.success, true)
  const content = JSON.parse(fs.readFileSync(path.join(r.message, 'draft_content.json'), 'utf-8'))
  const audioTracks = content.tracks.filter((t) => t.type === 'audio')
  assert.equal(audioTracks.length, 1, '口播独立音频轨应存在')
  assert.equal(audioTracks[0].segments.length, 1)
  assert.equal(audioTracks[0].segments[0].target_timerange.start, 0)
  assert.equal(audioTracks[0].segments[0].target_timerange.duration, 2000000)
  // 有口播的素材段静音（配音替换原声口径），无口播段保留原声
  const vt = content.tracks.find((t) => t.type === 'video')
  assert.equal(vt.segments[0].volume, 0)
  assert.equal(vt.segments[1].volume, 1.0)
  // 口播 wav 进音频素材
  assert.ok(content.materials.audios.some((a) => String(a.path).endsWith('voice_1.wav')))
})

// ── 2026-09-18 本地导出三修复：BGM 回环 / 音效池循环指派 / 文字模板居中上 ──

test('exportMultiToDraft：BGM 短于视频窗 → 窗内回环切 chunk（源游标连续无缝接续）', () => {
  const v1 = path.join(tmpRoot, 'loop_a.mp4')
  const v2 = path.join(tmpRoot, 'loop_b.mp4')
  const bgm = path.join(tmpRoot, 'short.mp3')
  fs.writeFileSync(v1, 'x'); fs.writeFileSync(v2, 'x'); fs.writeFileSync(bgm, 'x')
  const r = exportMultiToDraft({ videoPaths: [v1, v2], bgmPath: bgm, bgmVolume: 50, deps: DEPS })
  assert.equal(r.success, true)
  const content = JSON.parse(fs.readFileSync(path.join(r.message, 'draft_content.json'), 'utf-8'))
  const at = content.tracks.filter((t) => t.type === 'audio')
  assert.equal(at.length, 1)
  // BGM 素材 probe=10s（非 .mp4 分支不适用；.mp3 → 10s）不够回环？——DEPS 非 .mp4
  // 返 10s：窗 4s+4s 共需源 8s < 10s → 2 段不回环。改用 .mp4 命名 BGM 触发 4s probe：
  const bgm4 = path.join(tmpRoot, 'short4.mp4')
  fs.writeFileSync(bgm4, 'x')
  const r2 = exportMultiToDraft({ videoPaths: [v1, v2], bgmPath: bgm4, bgmVolume: 50, deps: DEPS })
  assert.equal(r2.success, true)
  const c2 = JSON.parse(fs.readFileSync(path.join(r2.message, 'draft_content.json'), 'utf-8'))
  const at2 = c2.tracks.filter((t) => t.type === 'audio')
  assert.equal(at2.length, 1)
  // BGM 素材 4s，每窗 4s：窗1=[0,4s) src[0,4s)；窗2 起点 4.5s，源游标已满归零
  // → src[0,4s)（回环无缝：若不归零会越界）；共 2 段、同素材 id（不重复入素材库）
  assert.equal(at2[0].segments.length, 2)
  assert.deepEqual(at2[0].segments[0].source_timerange, { start: 0, duration: 4000000 })
  assert.deepEqual(at2[0].segments[1].target_timerange, { start: 4500000, duration: 4000000 })
  assert.deepEqual(at2[0].segments[1].source_timerange, { start: 0, duration: 4000000 })
  assert.equal(at2[0].segments[0].material_id, at2[0].segments[1].material_id)
  assert.equal(c2.materials.audios.length, 1)
})

test('appendSfxTrackFromEvents：音效池按事件全局索引循环指派；段长=min(素材长,事件窗)；空池不落轨', () => {
  const s1 = path.join(tmpRoot, 'sfx1.mp3')
  const s2 = path.join(tmpRoot, 'sfx2.mp3')
  const s3 = path.join(tmpRoot, 'sfx3.mp3')
  fs.writeFileSync(s1, 'x'); fs.writeFileSync(s2, 'x'); fs.writeFileSync(s3, 'x')
  const pool = [s1, s2, s3]
  const tracks = []
  const materials = { audios: [], speeds: [] }
  const probeCache = new Map()
  const opts = (off) => ({ sfxPool: pool, eventOffset: off, probeCache, probeDur: () => 1.0 })
  const evs = (n) => Array.from({ length: n }, (_, k) => ({ phrase: 'p' + k, startUs: k * 1000000, durUs: 3000000 }))
  // 视频1：事件全局索引 0,1 → sfx1,sfx2
  appendSfxTrackFromEvents(tracks, materials, evs(2), 0, 4000000, opts(0))
  // 视频2：全局索引续 2,3,4 → sfx3,sfx1(回环),sfx2
  appendSfxTrackFromEvents(tracks, materials, evs(3), 4500000, 8500000, opts(2))
  assert.equal(tracks.length, 2)
  const pathsOf = (tr) => tr.segments.map((s) => materials.audios.find((a) => a.id === s.material_id).path)
  assert.deepEqual(pathsOf(tracks[0]), [s1, s2])
  assert.deepEqual(pathsOf(tracks[1]), [s3, s1, s2])
  // 段长=min(素材 1s, 事件窗 3s)=1s；时间轴落点=合并系偏移+局部 startUs
  assert.equal(tracks[0].segments[0].target_timerange.duration, 1000000)
  assert.equal(tracks[1].segments[0].target_timerange.start, 4500000)
  assert.equal(tracks[1].segments[2].target_timerange.start, 6500000)
  // 空池/文件全缺失 → 不落轨（不造假）
  const t2 = []
  appendSfxTrackFromEvents(t2, { audios: [], speeds: [] }, evs(1), 0, null, { sfxPool: [], probeDur: () => 1 })
  appendSfxTrackFromEvents(t2, { audios: [], speeds: [] }, evs(1), 0, null, { sfxPool: [path.join(tmpRoot, 'gone.mp3')], probeDur: () => 1 })
  assert.equal(t2.length, 0)
})

test('exportMultiToDraft：sfxPaths 音效池 → 文字模板命中位置落音效轨（跨视频全局循环）', () => {
  writeFixturePreset(tmpRoot)
  const v1 = path.join(tmpRoot, 'dubbed_s1.mp4')
  const v2 = path.join(tmpRoot, 'dubbed_s2.mp4')
  const sfxA = path.join(tmpRoot, 'tt_sfx_A.mp3')
  const sfxB = path.join(tmpRoot, 'tt_sfx_B.mp3')
  fs.writeFileSync(v1, 'x'); fs.writeFileSync(v2, 'x'); fs.writeFileSync(sfxA, 'x'); fs.writeFileSync(sfxB, 'x')
  const srt = path.join(tmpRoot, 's.srt')
  fs.writeFileSync(srt, '1\n00:00:00,000 --> 00:00:02,000\n限时上新199元\n', 'utf-8')
  const r = exportMultiToDraft({
    videoPaths: [v1, v2],
    srtPaths: [srt, srt],
    textTemplateClips: [
      [{ phrase: '199元', startUs: 500000, durUs: 1500000, resourceId: TPL_RID }],
      [{ phrase: '199元', startUs: 300000, durUs: 1000000, resourceId: TPL_RID }],
    ],
    sfxPaths: [sfxA, sfxB],
    subtitleFontSize: 12,
    draftName: '音效池测试',
    // BGM 缺失分支不受影响；音效素材 probe：.mp3 → 10s（非 .mp4 分支）→ 段长受事件窗限制
    deps: DEPS,
  })
  assert.equal(r.success, true)
  const content = JSON.parse(fs.readFileSync(path.join(r.message, 'draft_content.json'), 'utf-8'))
  // 音效轨=独立音频轨（每视频一条，含段才入轨）；指派：全局索引 0→sfxA、1→sfxB
  const audioTracks = content.tracks.filter((t) => t.type === 'audio')
  assert.equal(audioTracks.length, 2)
  const matOf = (tr) => tr.segments.map((s) => content.materials.audios.find((a) => a.id === s.material_id).path)
  assert.ok(matOf(audioTracks[0])[0].endsWith('tt_sfx_A.mp3'))
  assert.ok(matOf(audioTracks[1])[0].endsWith('tt_sfx_B.mp3'))
  // 段长=min(素材 probe 10s, 事件窗)：视频1 事件窗 1.5s → 1500000
  assert.equal(audioTracks[0].segments[0].target_timerange.duration, 1500000)
  // 时间轴落点：视频2 音效=4s+0.5s(间隔)+0.3s(局部)=4800000
  assert.equal(audioTracks[1].segments[0].target_timerange.start, 4800000)
  // 字号设置透传：字幕轨 texts size=12（第四步「字号」下拉覆写默认 10）
  assert.equal(JSON.parse(content.materials.texts[0].content).styles[0].size, 12)
})

test('appendTextTemplateSegments：段默认位置=居中上（TEXT_TEMPLATE_TRANSFORM_Y，2026-09-18 用户裁决）', () => {
  writeFixturePreset(tmpRoot)
  const presetDir = path.join(tmpRoot, 'JianyingPro', 'User Data', 'Presets', 'Text_V2')
  const track = { segments: [] }
  const materials = { text_templates: [], texts: [], speeds: [] }
  appendTextTemplateSegments(track, materials, [
    { phrase: '199元', startUs: 0, durUs: 1500000, resourceId: TPL_RID },
  ], presetDir, 0, 4000000, new Map())
  assert.equal(track.segments.length, 1)
  assert.deepEqual(track.segments[0].clip.transform, { x: 0, y: TEXT_TEMPLATE_TRANSFORM_Y })
  assert.equal(TEXT_TEMPLATE_TRANSFORM_Y, 0.6)
})

// ── registerInRootMeta / verifyDraftFolder（2026-09-16：固定基线不克隆他人条目 + 草稿自检）──

test('registerInRootMeta：固定基线构建条目（不继承 store[0] 脏字段），覆写 11 项 + 置顶 + 同路径去重', () => {
  const draftRoot = getDefaultDraftRoot()
  fs.mkdirSync(draftRoot, { recursive: true })
  const rootMetaPath = path.join(draftRoot, 'root_meta_info.json')
  // store[0] 故意带「脏」字段：他人封面 / 移除时间戳 / 隐藏标记 —— 验证不再被继承
  fs.writeFileSync(rootMetaPath, JSON.stringify({ all_draft_store: [{ draft_name: '剪辑模板', draft_cover: 'C:/other/draft_cover.jpg', tm_draft_removed: 1789558813242, draft_is_invisible: true }] }), 'utf-8')
  const folder = path.join(draftRoot, '测试工程')
  const fwd = folder.split('\\').join('/')
  const r1 = registerInRootMeta({ draftFolder: folder, draftName: '测试工程', durationUs: 123456, coverPath: '' })
  assert.equal(r1.ok, true)
  let store = JSON.parse(fs.readFileSync(rootMetaPath, 'utf-8')).all_draft_store
  assert.equal(store[0].draft_name, '测试工程')
  assert.equal(store[0].draft_cover, '') // 不继承他人封面
  assert.equal(store[0].draft_is_invisible, false) // 脏布尔不继承
  assert.equal(store[0].tm_draft_removed, 0) // 基线移除时间戳清零
  assert.equal(Object.keys(store[0]).length, 38) // 固定基线 38 键，不多不漏
  assert.equal(store[0].draft_fold_path, fwd)
  assert.equal(store[0].draft_json_file, fwd + '/draft_content.json')
  assert.equal(store[0].tm_duration, 123456)
  assert.equal(store[0].draft_type, 'face')
  // 同名路径二次登记 → 置顶且不堆积；coverPath 给定则原样写入
  const cover = path.join(folder, 'draft_cover.jpg')
  registerInRootMeta({ draftFolder: folder, draftName: '测试工程', durationUs: 1, coverPath: cover })
  store = JSON.parse(fs.readFileSync(rootMetaPath, 'utf-8')).all_draft_store
  assert.equal(store.filter((e) => e.draft_fold_path === fwd).length, 1)
  assert.equal(store[0].draft_cover, cover.split('\\').join('/'))
  assert.equal(store.length, 2)
})

test('verifyDraftFolder：完好草稿通过；素材缺失/坏 JSON → ok:false 且列明问题', () => {
  const folder = path.join(tmpRoot, 'draftX')
  const asset = path.join(folder, 'assets', '0001_clip_001.mp4')
  fs.mkdirSync(path.dirname(asset), { recursive: true })
  fs.writeFileSync(asset, 'x')
  const content = { duration: 1000000, materials: { videos: [{ id: 'v1', path: asset }] }, tracks: [{ type: 'video', segments: [{ id: 's1' }] }] }
  fs.writeFileSync(path.join(folder, 'draft_content.json'), JSON.stringify(content), 'utf-8')
  fs.writeFileSync(path.join(folder, 'draft_meta_info.json'), JSON.stringify({ draft_name: 'draftX' }), 'utf-8')
  const ok = verifyDraftFolder({ draftFolder: folder, expectedAssetCount: 1 })
  assert.equal(ok.ok, true)
  assert.equal(ok.trackCounts.video, 1)
  assert.equal(ok.pathRefs, 1)
  assert.equal(ok.missing, 0)
  assert.equal(ok.assetFiles, 1)
  // 素材被删 → 缺失定向报错
  fs.rmSync(asset)
  const bad = verifyDraftFolder({ draftFolder: folder, expectedAssetCount: 1 })
  assert.equal(bad.ok, false)
  assert.equal(bad.missing, 1)
  assert.equal(bad.problems.some((p) => p.includes('素材路径不存在')), true)
  // 坏 JSON → 解析问题
  fs.writeFileSync(path.join(folder, 'draft_content.json'), '{oops', 'utf-8')
  const bad2 = verifyDraftFolder({ draftFolder: folder })
  assert.equal(bad2.ok, false)
  assert.equal(bad2.problems.some((p) => p.includes('不可解析')), true)
})

// ── 轨道格式标准（2026-09-16：《剪映轨道格式标准_2026-09-16》§3.2 唯一构造器 + §7-⑤ 校验）──

test('buildSubtitleSegment：标准字段齐全（基类/媒体/视觉/字幕标准位/speed 引用不悬空）', () => {
  const materials = { texts: [], speeds: [] }
  const seg = buildSubtitleSegment('测试字幕', 1000000, 2000000, materials)
  // 素材层：texts + speeds 各一件，段引用可解析（§7-⑤）
  assert.equal(materials.texts.length, 1)
  assert.equal(materials.speeds.length, 1)
  assert.equal(seg.material_id, materials.texts[0].id)
  assert.equal(seg.extra_material_refs.includes(materials.speeds[0].id), true)
  // 基类标准字段（§3.1）
  assert.equal(seg.enable_adjust, true)
  assert.equal(seg.track_attribute, 0)
  assert.equal(seg.track_render_index, 0)
  assert.equal(seg.visible, true)
  assert.equal(seg.reverse, false)
  assert.deepEqual(seg.target_timerange, { start: 1000000, duration: 2000000 })
  assert.deepEqual(seg.common_keyframes, [])
  assert.deepEqual(seg.keyframe_refs, [])
  // 媒体附加（§3.2）；2026-09-17 对齐收尾（标准 §3.6）：文本段 source_timerange = null
  assert.equal(seg.source_timerange, null)
  assert.equal(seg.speed, 1.0)
  assert.equal(seg.is_tone_modify, false)
  // 视觉附加 + 字幕标准位（§3.2）
  assert.deepEqual(seg.clip.transform, { x: 0, y: SUBTITLE_TRANSFORM_Y })
  assert.equal(seg.uniform_scale.on, true)
  // 文本素材：水平居中 + content JSON 可解析（§4.3）
  assert.equal(materials.texts[0].alignment, SUBTITLE_ALIGNMENT)
  assert.equal(materials.texts[0].type, 'text')
  assert.equal(JSON.parse(materials.texts[0].content).text, '测试字幕')
  // 2026-09-18 用户裁决：字号默认 10 号；opts.fontSize（第四步「字号」下拉）覆写
  assert.equal(SUBTITLE_FONT_SIZE_DEFAULT, 10)
  assert.equal(JSON.parse(materials.texts[0].content).styles[0].size, 10)
  buildSubtitleSegment('大字幕', 0, 1000000, materials, { fontSize: 15 })
  assert.equal(JSON.parse(materials.texts[1].content).styles[0].size, 15)
  // 非法字号回落默认（不产出 size<=0 的草稿字段）
  buildSubtitleSegment('回落', 0, 1000000, materials, { fontSize: 0 })
  assert.equal(JSON.parse(materials.texts[2].content).styles[0].size, 10)
})

test('verifyDraftFolder：段 material_id 悬空 → ok:false 且计 dangling（标准 §7-⑤）', () => {
  const folder = path.join(tmpRoot, 'draftDangling')
  fs.mkdirSync(folder, { recursive: true })
  const content = {
    duration: 1000000,
    materials: { videos: [{ id: 'v1' }] },
    tracks: [
      { type: 'video', segments: [{ id: 's1', material_id: 'v1' }] },
      { type: 'text', segments: [{ id: 's2', material_id: 'ghost' }] },
    ],
  }
  fs.writeFileSync(path.join(folder, 'draft_content.json'), JSON.stringify(content), 'utf-8')
  fs.writeFileSync(path.join(folder, 'draft_meta_info.json'), '{}', 'utf-8')
  const v = verifyDraftFolder({ draftFolder: folder })
  assert.equal(v.ok, false)
  assert.equal(v.dangling, 1)
  assert.equal(v.problems.some((p) => p.includes('段素材引用悬空')), true)
  assert.equal(v.trackCounts.video, 1)
  assert.equal(v.trackCounts.text, 1)
})

// ── auditDraftStandardConformance（标准 §0.3 条3「上报不兜底」，2026-09-17 对齐收尾）──

test('auditDraftStandardConformance：标准构造产物 0 警告；服务端旧格式段被列名上报', () => {
  // ① 标准构造器产物（字幕段 + speed）→ 预期 0 警告
  const materials = {}
  const seg = buildSubtitleSegment('标准段', 0, 1000000, materials)
  const ok = auditDraftStandardConformance({
    tracks: [{ type: 'text', segments: [seg] }],
    materials,
  })
  assert.equal(ok.checkedSegs, 1)
  assert.deepEqual(ok.warnings, [])

  // ② 服务端旧格式特征（from-task 实测）：大写 id、duration=0 占位、
  //    视频段 hdr_settings=null、标准外字段（enable_video_mask 等）→ 全部上报
  const bad = auditDraftStandardConformance({
    tracks: [{
      type: 'video',
      segments: [{
        id: '22024C9C3C0C47279A893C8350AD94DD',            // 大写 hex（§0.4 应小写）
        material_id: '1EAAA818A4FC400BA0CD0ED8B7609250',
        target_timerange: { start: 0, duration: 0 },        // duration=0 占位
        source_timerange: { start: 0, duration: 0 },
        hdr_settings: null,                                  // 视频段应为对象（§3.4）
        enable_video_mask: false,                            // 标准外字段
        intensifies_audio: false,
        is_placeholder: false,
      }],
    }],
    materials: { videos: [{ id: '1EAAA818A4FC400BA0CD0ED8B7609250' }] },
  })
  assert.equal(bad.checkedSegs, 1)
  assert.equal(bad.warnings.some((w) => w.includes('非标准 32 位小写 hex')), true)
  assert.equal(bad.warnings.some((w) => w.includes('duration ≤ 0')), true)
  assert.equal(bad.warnings.some((w) => w.includes('hdr_settings 缺失或为 null')), true)
  assert.equal(bad.warnings.some((w) => w.includes('标准外字段 enable_video_mask')), true)
  assert.equal(bad.warnings.some((w) => w.includes('标准外字段 intensifies_audio')), true)
  assert.equal(bad.warnings.some((w) => w.includes('标准外字段 is_placeholder')), true)
  assert.equal(bad.warnings.some((w) => w.includes('materials.videos id 非标准')), true)
})

// ── validateDraftPackage（轨 2：服务端标准包解压后校验，2026-09-17 用户裁决）──

test('validateDraftPackage：完好包通过；缺素材/悬空引用/坏 JSON 显式列出；符合性警告只上报不阻断', () => {
  const make = (dir, { content, meta = {}, files = {} }) => {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'draft_content.json'), JSON.stringify(content), 'utf-8')
    fs.writeFileSync(path.join(dir, 'draft_meta_info.json'), JSON.stringify(meta), 'utf-8')
    for (const [rel, body] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
      fs.writeFileSync(path.join(dir, rel), body)
    }
  }
  const baseContent = {
    duration: 1000000,
    materials: { videos: [{ id: 'v1', path: 'assets/a.mp4' }], audios: [] },
    tracks: [{ type: 'video', segments: [{ id: 's1', material_id: 'v1', target_timerange: { start: 0, duration: 1000000 } }] }],
  }
  // ① 完好包（素材在包内）
  const okDir = path.join(tmpRoot, 'pkg-ok')
  make(okDir, { content: baseContent, files: { 'assets/a.mp4': 'x' } })
  const ok = validateDraftPackage(okDir)
  assert.equal(ok.ok, true)
  assert.equal(ok.trackCounts.video, 1)
  assert.equal(ok.pathRefs, 1)

  // ② 缺素材文件 + 悬空引用 → 显式失败
  const badDir = path.join(tmpRoot, 'pkg-bad')
  make(badDir, {
    content: {
      ...baseContent,
      materials: { videos: [{ id: 'v1', path: 'assets/gone.mp4' }], audios: [{ id: 'a1', path: 'assets/x.mp3' }] },
      tracks: [{ type: 'video', segments: [{ id: 's1', material_id: 'ghost', target_timerange: { start: 0, duration: 1 } }] }],
    },
  })
  const bad = validateDraftPackage(badDir)
  assert.equal(bad.ok, false)
  assert.equal(bad.problems.some((p) => p.includes('包内缺素材文件')), true)
  assert.equal(bad.problems.some((p) => p.includes('段素材引用悬空')), true)

  // ③ 坏 JSON
  const badJsonDir = path.join(tmpRoot, 'pkg-badjson')
  fs.mkdirSync(badJsonDir, { recursive: true })
  fs.writeFileSync(path.join(badJsonDir, 'draft_content.json'), '{oops', 'utf-8')
  fs.writeFileSync(path.join(badJsonDir, 'draft_meta_info.json'), '{}', 'utf-8')
  const bj = validateDraftPackage(badJsonDir)
  assert.equal(bj.ok, false)
  assert.equal(bj.problems.some((p) => p.includes('draft_content.json 不可解析')), true)

  // ④ 符合性警告只进 warnings 不阻断（大写 id 服务端段）
  const warnDir = path.join(tmpRoot, 'pkg-warn')
  make(warnDir, {
    content: {
      ...baseContent,
      tracks: [{ type: 'video', segments: [{ ...baseContent.tracks[0].segments[0], id: 'ABCDEF0123456789ABCDEF0123456789' }] }],
    },
    files: { 'assets/a.mp4': 'x' },
  })
  const w = validateDraftPackage(warnDir)
  assert.equal(w.ok, true)
  assert.equal(w.warnings.some((x) => x.includes('非标准 32 位小写 hex')), true)
})

// ── 服务端字幕样式 → 剪映文本样式（2026-09-17 用户报障①）──

test('jianyingSubtitleStyleFromServer：色/描边/背景框映射与夹逼口径', () => {
  // 无样式对象 → 默认白字无描边无背景
  assert.deepEqual(jianyingSubtitleStyleFromServer(null, 20), {
    colorHex: '#FFFFFF', strokeColorHex: '', strokeWidth: 0, bgColorHex: '', bgAlpha: 0,
  })
  assert.deepEqual(jianyingSubtitleStyleFromServer(undefined, null).colorHex, '#FFFFFF')
  // 全字段：UI 不透明度优先于 box 自带 opacity
  const m = jianyingSubtitleStyleFromServer({
    color: '#FFE135', outline: 3, outline_colour: '#000000', box: 'black@0.5',
  }, 20)
  assert.equal(m.colorHex, '#FFE135')
  assert.equal(m.strokeWidth, 0.03)
  assert.equal(m.strokeColorHex, '#000000')
  assert.equal(m.bgAlpha, 0.2)
  assert.equal(m.bgColorHex, '#000000')
  // 色名归一 + UI 传 null 回退 box 自带 opacity
  const m2 = jianyingSubtitleStyleFromServer({ color: 'white', outline: 5, outline_colour: 'black', box: '#102030@0.5' }, null)
  assert.equal(m2.colorHex, '#FFFFFF')
  assert.equal(m2.strokeWidth, 0.05)
  assert.equal(m2.strokeColorHex, '#000000')
  assert.equal(m2.bgAlpha, 0.5)
  assert.equal(m2.bgColorHex, '#102030')
  // UI 0% → 无背景框；outline 0 → 无描边
  const m3 = jianyingSubtitleStyleFromServer({ color: '#FF0000', outline: 0, box: 'black@0.5' }, 0)
  assert.equal(m3.bgAlpha, 0)
  assert.equal(m3.strokeWidth, 0)
  // 描边宽夹逼 [0.005, 0.1]
  assert.equal(jianyingSubtitleStyleFromServer({ outline: 50 }, null).strokeWidth, 0.1)
  assert.equal(jianyingSubtitleStyleFromServer({ outline: 0.1 }, null).strokeWidth, 0.005)
})

test('buildSubtitleSegment：subtitleStyle 落文本素材（fill/strokes/background 真机 schema）', () => {
  const materials = {}
  const style = jianyingSubtitleStyleFromServer({
    color: '#FFE135', outline: 3, outline_colour: '#223344', box: 'black@0.5',
  }, 40)
  const seg = buildSubtitleSegment('字幕行', 0, 2000000, materials, { subtitleStyle: style })
  assert.ok(seg.material_id)
  const mat = materials.texts[0]
  const content = JSON.parse(mat.content)
  const st = content.styles[0]
  // 填充色 = 选中样式色
  assert.deepEqual(st.fill.content.solid.color, [1, 225 / 255, 53 / 255])
  // 描边：真机 schema strokes=[{content:{render_type,solid},width,mode:0}]
  assert.equal(st.strokes.length, 1)
  assert.equal(st.strokes[0].width, 0.03)
  assert.equal(st.strokes[0].mode, 0)
  assert.deepEqual(st.strokes[0].content.solid.color, [34 / 255, 51 / 255, 68 / 255])
  // 背景框：enable + fill.alpha=UI 不透明度
  assert.equal(st.background.enable, true)
  assert.equal(st.background.fill.alpha, 0.4)
  assert.deepEqual(st.background.fill.content.solid.color, [0, 0, 0])
  // 无样式时回退默认：无描边无背景
  const materials2 = {}
  buildSubtitleSegment('默认', 0, 1000000, materials2, {})
  const st2 = JSON.parse(materials2.texts[0].content).styles[0]
  assert.deepEqual(st2.strokes, [])
  assert.equal(st2.background, undefined)
  assert.deepEqual(st2.fill.content.solid.color, [1, 1, 1])
})
