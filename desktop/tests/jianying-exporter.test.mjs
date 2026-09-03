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
  // 素材库：2 视频 + 1 音频 + 1 字幕 + 1 转场
  assert.equal(content.materials.videos.length, 2)
  assert.equal(content.materials.audios.length, 1)
  assert.equal(content.materials.texts.length, 1)
  assert.equal(content.materials.transitions.length, 1)
  assert.equal(content.materials.transitions[0].name, '推近')
  assert.equal(content.materials.transitions[0].resource_id, '6724226861666144779')
  // 视频轨 2 段顺序排布；转场挂「前一个」片段 extra_material_refs
  const videoTrack = content.tracks.find((t) => t.type === 'video')
  assert.equal(videoTrack.segments.length, 2)
  assert.equal(videoTrack.segments[0].extra_material_refs.length, 1)
  assert.equal(videoTrack.segments[1].extra_material_refs.length, 0)
  assert.deepEqual(videoTrack.segments[0].target_timerange, { start: 0, duration: 4000000 })
  assert.deepEqual(videoTrack.segments[1].target_timerange, { start: 4000000, duration: 4000000 })
  // 字幕轨：整体偏移到第 0 段内
  const textTrack = content.tracks.find((t) => t.type === 'text')
  assert.equal(textTrack.segments[0].target_timerange.start, 0)
  // BGM 音轨：volume=30/100、volume_db=(30/50-1)*12=-4.8、覆盖整条时间轴
  const audioTrack = content.tracks.find((t) => t.type === 'audio')
  assert.equal(audioTrack.segments[0].volume, 0.3)
  assert.ok(Math.abs(audioTrack.segments[0].volume_db - -4.8) < 1e-9) // (30/50-1)*12 浮点精度
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
