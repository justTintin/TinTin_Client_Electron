// ═══════════════════════════════════════════════════════════════
// jianying-exporter.js — 剪映专业版草稿（DRT）导出器
// ── v2（2026-09-12 M1）：完整字段 schema ──
//   M0 闸门实测（附录 D）：旧极简字段集被剪映 11.5.5 判定「草稿内容已损坏」
//   拒开。v2 以 pyJianYingDraft 0.3.0 的已知可用明文结构为字段基准重写：
//   · 骨架骨架：jianying-draft-template.js（new_version 110.0.0 / version 360000 /
//     platform app_version 5.9.0，顶层 29 字段全量）
//   · segment 字段：segment.py（BaseSegment/MediaSegment/VisualSegment）+
//     video_segment.py（hdr_settings）+ audio_segment.py（clip:null）
//   · 素材字段：local_materials.py（VideoMaterial/AudioMaterial）+
//     text_segment.py（texts.content 富样式 JSON 串）
//   来源版本三元组见 DRAFT_SCHEMA（防版本漂移，素材同步同契约）。
// 保留自原 studio/utils/jianying_exporter.py 一比一移植的工具层：
//   TRANSITION_MAP（8 项转场资源 ID）/ get_default_draft_root /
//   _normalize_transitions / _parse_srt / _timestamp_to_sec，均对照原版。
// 纯逻辑可单测（tests/jianying-exporter.test.mjs）。
// ═══════════════════════════════════════════════════════════════

'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const TEMPLATE = require('./jianying-draft-template.js')
const { findTextIntroAnimation } = require('./jianying-text-animations.js')

// UI 转场 key -> (剪映转场名, resource_id, effect_id, is_overlap, 默认时长(微秒))
// 资源 ID 来自剪映内置转场元数据（pyJianYingDraft，2024 版剪映专业版）
const TRANSITION_MAP = {
  fade:       { name: '模糊',     resourceId: '6911569618171597320', effectId: '4212596',  isOverlap: true,  duration: 500000 },
  dissolve:   { name: '叠化',     resourceId: '6724845717472416269', effectId: '322577',   isOverlap: true,  duration: 500000 },
  slideleft:  { name: '向左擦除', resourceId: '6724849999336706573', effectId: '2917283',  isOverlap: true,  duration: 500000 },
  slideright: { name: '向右擦除', resourceId: '6724849898857959950', effectId: '2917284',  isOverlap: true,  duration: 500000 },
  slideup:    { name: '向上擦除', resourceId: '6724849456891564557', effectId: '2917281',  isOverlap: true,  duration: 500000 },
  slidedown:  { name: '向下擦除', resourceId: '6724849752921346573', effectId: '2917282',  isOverlap: true,  duration: 500000 },
  zoomin:     { name: '推近',     resourceId: '6724226861666144779', effectId: '359359',   isOverlap: false, duration: 1000000 },
  zoomout:    { name: '拉远',     resourceId: '6724226338418332167', effectId: '359365',   isOverlap: false, duration: 1000000 },
}

// 草稿 schema 来源版本三元组（同步/排障时对版本用）
const DRAFT_SCHEMA = Object.freeze({
  source: 'pyJianYingDraft 0.3.0 assets/draft_content_template.json',
  new_version: '110.0.0',
  version: 360000,
  generator_app_version: '5.9.0',
})

/** 大写无连字符 uuid（draft_meta_info.draft_id 用，对照 str(uuid.uuid4()).upper()） */
function newId() {
  return randomUUID().replace(/-/g, '').toUpperCase()
}

/** 32 位小写 hex（草稿内 track/segment/素材 id，对照 pyJianYingDraft uuid4().hex） */
function hexId() {
  return randomUUID().replace(/-/g, '')
}

/** '#RRGGBB' → [r,g,b] 0-1 浮点（剪映 texts.content 样式色格式） */
function hexToRgbFloats(hex) {
  const m = /^#?([0-9a-fA-F]{6})/.exec(String(hex || ''))
  if (!m) return [1.0, 1.0, 1.0]
  return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255)
}

/** Windows 默认的剪映专业版草稿根目录（get_default_draft_root） */
function getDefaultDraftRoot() {
  let appdata = process.env.LOCALAPPDATA || ''
  if (!appdata) appdata = path.join(process.env.USERPROFILE || '', 'AppData', 'Local')
  return path.join(appdata, 'JianyingPro', 'User Data', 'Projects', 'com.lveditor.draft')
}

// ── v2 字段构建器（字段对照 pyJianYingDraft：segment.py / local_materials.py / text_segment.py）──

/** 播放速度素材（materials.speeds 成员；segment.extra_material_refs 引用其 id） */
function speedMaterial(speed) {
  return { curve_speed: null, id: hexId(), mode: 0, speed, type: 'speed' }
}

/** 通用片段字段（segment.py BaseSegment.export_json） */
function baseSegmentFields(materialId, start, dur) {
  return {
    enable_adjust: true,
    enable_color_correct_adjust: false,
    enable_color_curves: true,
    enable_color_match_adjust: false,
    enable_color_wheels: true,
    enable_lut: true,
    enable_smart_color_adjust: false,
    last_nonzero_volume: 1.0,
    reverse: false,
    track_attribute: 0,
    track_render_index: 0,
    visible: true,
    id: hexId(),
    material_id: materialId,
    target_timerange: { start, duration: dur },
    common_keyframes: [],
    keyframe_refs: [],
  }
}

/** 媒体片段字段（segment.py MediaSegment.export_json；speedId 进 extra_material_refs） */
function mediaSegmentFields(dur, speedId, { speed = 1.0, volume = 1.0 } = {}) {
  return {
    source_timerange: { start: 0, duration: dur },
    speed,
    volume,
    extra_material_refs: [speedId],
    is_tone_modify: false,
  }
}

/** 视觉片段字段（segment.py VisualSegment.export_json） */
function visualSegmentFields() {
  return {
    clip: {
      alpha: 1.0,
      flip: { horizontal: false, vertical: false },
      rotation: 0.0,
      scale: { x: 1.0, y: 1.0 },
      transform: { x: 0.0, y: 0.0 },
    },
    uniform_scale: { on: true, value: 1.0 },
  }
}

/** 轨道（track.py Track.export_json） */
function newTrack(type) {
  return { attribute: 0, flag: 0, id: hexId(), is_default_name: true, name: '', segments: [], type }
}

/** 文字入场动画素材（materials.material_animations 成员；animation.py SegmentAnimations/Text_animation）。
 *  按 TEXT_INTRO_ANIMATIONS 表（pyJianYingDraft text_intro.py 免费档）查名；未命中返回 null。
 *  时长取 min(动画默认时长, 片段时长)。 */
function textIntroAnimationMaterial(animName, segDurUs) {
  const meta = findTextIntroAnimation(animName)
  if (!meta) return null
  const material = {
    id: hexId(),
    type: 'sticker_animation',
    multi_language_current: 'none',
    animations: [
      {
        anim_adjust_params: null,
        platform: 'all',
        panel: '',
        material_type: 'sticker',
        name: meta.name,
        id: meta.effect_id,
        type: 'in',
        resource_id: meta.resource_id,
        start: 0,
        duration: Math.min(meta.duration, segDurUs),
      },
    ],
  }
  return { material, animId: material.id }
}

/** 文字花字效果素材（materials.effects 成员；text_segment.py TextEffect.export_json——
 *  pyJianYingDraft 将气泡/花字导出到 materials.effects，segment 挂引用 + content.effectStyle）。 */
function textEffectMaterial(effectId) {
  return {
    apply_target_type: 0,
    effect_id: effectId,
    id: hexId(),
    resource_id: effectId,
    type: 'text_effect',
    value: 1.0,
    source_platform: 1,
  }
}

/** 为文本片段挂入场动画 + 花字效果引用（无命中静默跳过，不造假） */
function decorateTextSegment(seg, materials, { anim, effectId } = {}) {
  if (anim) {
    const r = textIntroAnimationMaterial(anim, seg.target_timerange.duration)
    if (r) {
      if (!Array.isArray(materials.material_animations)) materials.material_animations = []
      materials.material_animations.push(r.material)
      seg.extra_material_refs.push(r.animId)
    }
  }
  if (effectId) {
    if (!Array.isArray(materials.effects)) materials.effects = []
    materials.effects.push(textEffectMaterial(effectId))
    seg.extra_material_refs.push(materials.effects[materials.effects.length - 1].id)
  }
}

/** 文本素材（materials.texts 成员；text_segment.py TextSegment.export_material）。
 *  effectStyleId：剪映花字效果 id（jy_effect_id）→ content.effectStyle 引用（path 'C:' 为原版占位）。 */
function textMaterial(text, { colorHex = '#FFFFFF', bold = false, size = 8.0, effectStyleId = '' } = {}) {
  const contentJson = {
    styles: [
      {
        fill: {
          alpha: 1.0,
          content: { render_type: 'solid', solid: { alpha: 1.0, color: hexToRgbFloats(colorHex) } },
        },
        range: [0, text.length],
        size,
        bold: !!bold,
        italic: false,
        underline: false,
        strokes: [],
      },
    ],
    text,
  }
  if (effectStyleId) contentJson.styles[0].effectStyle = { id: effectStyleId, path: 'C:' }
  return {
    id: hexId(),
    content: JSON.stringify(contentJson),
    typesetting: 0,
    alignment: 0,
    letter_spacing: 0,
    line_spacing: 0.02,
    line_feed: 1,
    force_apply_line_max_width: false,
    check_flag: 7,
    type: 'text',
    global_alpha: 1.0,
  }
}

/** 视频素材（materials.videos 成员；local_materials.py VideoMaterial.export_json） */
function videoMaterialFields(clip) {
  return {
    audio_fade: null,
    category_id: '',
    category_name: 'local',
    check_flag: 63487,
    crop: {
      upper_left_x: 0.0, upper_left_y: 0.0,
      upper_right_x: 1.0, upper_right_y: 0.0,
      lower_left_x: 0.0, lower_left_y: 1.0,
      lower_right_x: 1.0, lower_right_y: 1.0,
    },
    crop_ratio: 'free',
    crop_scale: 1.0,
    duration: clip.durationUs,
    height: clip.height,
    id: clip.materialId,
    local_material_id: '',
    material_id: clip.materialId,
    material_name: clip.name,
    media_path: '',
    path: clip.path,
    type: 'video',
    width: clip.width,
  }
}

/** 音频素材（materials.audios 成员；local_materials.py AudioMaterial.export_json） */
function audioMaterialFields(bgmPath, durationUs) {
  return {
    app_id: 0,
    category_id: '',
    category_name: 'local',
    check_flag: 3,
    copyright_limit_type: 'none',
    duration: durationUs,
    effect_id: '',
    formula_id: '',
    id: hexId(),
    local_material_id: '',
    music_id: '',
    name: path.basename(bgmPath),
    path: bgmPath,
    source_platform: 0,
    type: 'extract_music',
    wave_points: [],
  }
}

/** 单视频导出（兼容旧入口，内部走多片段时间轴导出；export_to_draft L43-64） */
function exportToDraft({ videoPath, bgmPath = '', bgmVolume = 50, srtPath = '', draftName = '', fxWords = null, fxKinds = null, textAnim = '', fancyEffectId = '', tplEffectId = '', deps }) {
  if (!videoPath || !fs.existsSync(videoPath)) return { success: false, message: '视频文件不存在' }
  if (!draftName) {
    draftName = `螺丝钉智能混剪_${path.basename(videoPath, path.extname(videoPath))}`
  }
  return exportMultiToDraft({
    videoPaths: [videoPath],
    transitions: null,
    bgmPath,
    bgmVolume,
    srtPaths: srtPath ? [srtPath] : null,
    draftName,
    fxWords,
    fxKinds,
    textAnim,
    fancyEffectId,
    tplEffectId,
    deps,
  })
}

/** 多个视频按顺序导出为一条剪映时间轴（v2 完整 schema）。
 *  fxWords（关键词）+ fxKinds（['fancy','tpl']）→ 关键词命中的字幕行导出为
 *  独立文本轨（花字/文字模板各一条，样式色区分），供剪映内直接套样式精修。 */
function exportMultiToDraft({ videoPaths, transitions = null, bgmPath = '', bgmVolume = 50, srtPaths = null, draftName = '', fxWords = null, fxKinds = null, textAnim = '', fancyEffectId = '', tplEffectId = '', deps }) {
  const paths = (videoPaths || []).filter(Boolean)
  if (!paths.length) return { success: false, message: '没有可导出的视频' }
  for (const p of paths) {
    if (!fs.existsSync(p)) return { success: false, message: `视频文件不存在: ${p}` }
  }

  try {
    // 1. 探测每个视频的时长与分辨率（失败兜底 10s / 1080x1920）
    const clips = []
    let totalDurationUs = 0
    for (const p of paths) {
      const [durationUs, width, height] = probeVideo(p, deps)
      clips.push({
        path: p.split('\\').join('/'),
        name: path.basename(p),
        durationUs: durationUs > 0 ? durationUs : 10000000,
        width: width || 1080,
        height: height || 1920,
      })
      totalDurationUs += clips[clips.length - 1].durationUs
    }
    const canvasWidth = clips[0].width
    const canvasHeight = clips[0].height

    // 2. 草稿目录
    const draftRoot = getDefaultDraftRoot()
    fs.mkdirSync(draftRoot, { recursive: true })
    const projectUuid = newId()
    if (!draftName) {
      draftName = clips.length === 1
        ? `螺丝钉智能混剪_${path.basename(clips[0].path, path.extname(clips[0].path))}`
        : '螺丝钉智能混剪_多片段时间轴'
    }
    const draftFolder = path.join(draftRoot, projectUuid)
    fs.mkdirSync(draftFolder, { recursive: true })

    // 3. draft_meta_info.json（原版字段保留；列表可见性由 registerInRootMeta 保证）
    const nowMs = Date.now()
    const metaInfo = {
      id: projectUuid,
      draft_name: draftName,
      draft_foldpath: draftFolder.split('\\').join('/'),
      draft_type: 'face',
      create_time: nowMs,
      update_time: nowMs,
      tm_draft_modified: nowMs,
      draft_rootpath: draftRoot.split('\\').join('/'),
      platform: 'windows',
    }
    fs.writeFileSync(path.join(draftFolder, 'draft_meta_info.json'), JSON.stringify(metaInfo, null, 2), 'utf-8')

    // 4. 内容骨架（pyJianYingDraft 已知可用模板）+ 覆写身份/画布字段
    const content = JSON.parse(JSON.stringify(TEMPLATE))
    content.id = newId()
    content.name = draftName
    content.fps = 30
    content.duration = totalDurationUs
    content.create_time = Math.floor(nowMs / 1000)
    content.update_time = Math.floor(nowMs / 1000)
    let ratio = '9:16'
    if (canvasWidth > canvasHeight) ratio = '16:9'
    else if (canvasWidth === canvasHeight) ratio = '1:1'
    content.canvas_config = { width: canvasWidth, height: canvasHeight, ratio }

    const materials = content.materials
    const speeds = Array.isArray(materials.speeds) ? materials.speeds : (materials.speeds = [])

    // 5. 视频轨（order 0）：全片段 + 转场挂「前一个」片段
    const transitionSpecs = normalizeTransitions(transitions, clips.length - 1)
    const videoTrack = newTrack('video')
    let cursorUs = 0
    clips.forEach((clip, i) => {
      const materialId = hexId()
      materials.videos.push(videoMaterialFields({ ...clip, materialId }))
      const sp = speedMaterial(1.0)
      speeds.push(sp)
      const seg = {
        ...baseSegmentFields(materialId, cursorUs, clip.durationUs),
        ...mediaSegmentFields(clip.durationUs, sp.id),
        ...visualSegmentFields(),
        hdr_settings: { intensity: 1.0, mode: 1, nits: 1000 },
      }
      videoTrack.segments.push(seg)
      if (i > 0) {
        const spec = transitionSpecs[i - 1]
        if (spec) videoTrack.segments[videoTrack.segments.length - 2].extra_material_refs.push(buildTransitionMaterial(materials, spec))
      }
      cursorUs += clip.durationUs
    })
    const tracks = [videoTrack]

    // 6. 字幕轨（order 1）+ 关键词轨（fancy/tpl）；textAnim=文字入场动画名，fancyEffectId=花字效果 id
    if (srtPaths) {
      const subtitleTrack = newTrack('text')
      tracks.push(subtitleTrack)
      const fxTrackCache = {}
      const kwWords = Array.isArray(fxWords) ? fxWords.filter(Boolean) : []
      const kwKinds = Array.isArray(fxKinds) ? fxKinds.filter((k) => k === 'fancy' || k === 'tpl') : []
      cursorUs = 0
      clips.forEach((clip, i) => {
        if (srtPaths && i < srtPaths.length && srtPaths[i] && fs.existsSync(srtPaths[i])) {
          appendSubtitleTrack(subtitleTrack, materials, srtPaths[i], cursorUs, cursorUs + clip.durationUs, { anim: textAnim })
          for (const kind of kwKinds) {
            appendKeywordTrack(tracks, materials, srtPaths[i], kwWords, kind, cursorUs, cursorUs + clip.durationUs, fxTrackCache, {
              anim: textAnim,
              effectId: kind === 'fancy' ? fancyEffectId : tplEffectId,
            })
          }
        }
        cursorUs += clip.durationUs
      })
      if (!subtitleTrack.segments.length) tracks.splice(tracks.indexOf(subtitleTrack), 1)
    }

    // 7. BGM 轨（最后一条）：覆盖整条时间轴
    if (bgmPath && fs.existsSync(bgmPath)) {
      appendBgmTrack(tracks, materials, bgmPath, bgmVolume, totalDurationUs, deps)
    }

    // 8. render_index = 轨道顺序（pyJianYingDraft script_file.dumps：主轨 0，叠加轨依次递增）
    tracks.forEach((track, order) => {
      for (const seg of track.segments) seg.render_index = order
    })
    content.tracks = tracks

    fs.writeFileSync(path.join(draftFolder, 'draft_content.json'), JSON.stringify(content, null, 2), 'utf-8')
    return { success: true, message: draftFolder, draftName, schemaVersion: DRAFT_SCHEMA }
  } catch (e) {
    return { success: false, message: e && e.message ? e.message : String(e) }
  }
}

/** 把导出的草稿登记进 root_meta_info.json 首页索引（2026-09-12 M1）。
 *  条目 schema 克隆索引现有首条（保真本机剪映版本字段集）；写前备份；
 *  按 draft_fold_path 去重合并。 */
function registerInRootMeta({ draftFolder, draftName, durationUs = 0, coverPath = '' }) {
  const draftRoot = getDefaultDraftRoot()
  const rootMetaPath = path.join(draftRoot, 'root_meta_info.json')
  const fwd = (p) => p.split('\\').join('/')
  const rootMeta = JSON.parse(fs.readFileSync(rootMetaPath, 'utf-8'))
  const store = Array.isArray(rootMeta.all_draft_store) ? rootMeta.all_draft_store : []
  const backupPath = rootMetaPath + '.tintin-backup'
  if (!fs.existsSync(backupPath)) fs.copyFileSync(rootMetaPath, backupPath)

  const templateEntry = store[0] || {}
  const entry = JSON.parse(JSON.stringify(templateEntry))
  const nowUs = Date.now() * 1000
  Object.assign(entry, {
    draft_name: draftName,
    draft_fold_path: fwd(draftFolder),
    draft_json_file: fwd(draftFolder) + '/draft_content.json',
    draft_root_path: fwd(draftRoot),
    draft_id: newId(),
    draft_new_version: '',
    tm_draft_create: nowUs,
    tm_draft_modified: nowUs,
    tm_duration: Math.round(durationUs),
    draft_cover: coverPath ? fwd(coverPath) : (templateEntry.draft_cover ?? ''),
  })
  rootMeta.all_draft_store = [entry, ...store.filter((e) => e && e.draft_fold_path !== entry.draft_fold_path)]
  fs.writeFileSync(rootMetaPath, JSON.stringify(rootMeta, null, 2), 'utf-8')
  return { ok: true, backupPath, entry }
}

/** 探测 (时长微秒, 宽, 高)；无 deps 或失败返回 [0, 1080, 1920]（_probe_video L241-270） */
function probeVideo(videoPath, deps) {
  if (!deps || typeof deps.probeMedia !== 'function') return [0, 1080, 1920]
  try {
    const { durationSec, width, height } = deps.probeMedia(videoPath)
    return [Math.floor((durationSec || 0) * 1000000), width, height]
  } catch (_) {
    return [0, 1080, 1920]
  }
}

/** 转场参数归一化为长度 count 的列表（_normalize_transitions L273-283；注意：list 保持原样，仅 str/单个 dict 包数组） */
function normalizeTransitions(transitions, count) {
  if (transitions === null || transitions === undefined) transitions = []
  else if (!Array.isArray(transitions) && (typeof transitions === 'string' || typeof transitions === 'object')) transitions = [transitions]
  const result = []
  for (let i = 0; i < count; i++) {
    const spec = i < transitions.length ? transitions[i] : 'fade'
    result.push(normalizeOneTransition(spec))
  }
  return result
}

/** 单个转场规格 -> dict 或 None（_normalize_one_transition L286-314） */
function normalizeOneTransition(spec) {
  if (spec === null || spec === undefined) return null
  if (typeof spec === 'string') {
    const key = spec.trim().toLowerCase()
    if (['', 'none', '无', 'null'].includes(key)) return null
    const t = TRANSITION_MAP[key] || TRANSITION_MAP.fade
    return { name: t.name, resource_id: t.resourceId, effect_id: t.effectId, is_overlap: t.isOverlap, duration: t.duration }
  }
  if (typeof spec === 'object') {
    if (!spec.resource_id) return null
    return {
      name: spec.name || '模糊',
      resource_id: String(spec.resource_id),
      effect_id: String(spec.effect_id || ''),
      is_overlap: !!spec.is_overlap,
      duration: parseInt(spec.duration, 10) || 500000,
    }
  }
  return null
}

/** 转场写入 materials.transitions，返回素材 id（_build_transition_material L317-332；
 *  字段与 pyJianYingDraft Transition.export_json 一致） */
function buildTransitionMaterial(materials, spec) {
  const transId = hexId()
  materials.transitions.push({
    category_id: '',
    category_name: '',
    duration: spec.duration,
    effect_id: spec.effect_id,
    id: transId,
    is_overlap: spec.is_overlap,
    name: spec.name,
    platform: 'all',
    resource_id: spec.resource_id,
    type: 'transition',
  })
  return transId
}

/** 一条 SRT 的 cue 追加到文本轨（v2：segments 带完整视觉片段字段；opts.anim=入场动画名） */
function appendSubtitleTrack(track, materials, srtPath, offsetUs = 0, limitEndUs = null, opts = {}) {
  for (const [startSec, endSec, textContent] of parseSrt(srtPath)) {
    const startUs = Math.floor(startSec * 1000000) + offsetUs
    let durUs = Math.floor((endSec - startSec) * 1000000)
    if (durUs <= 0) continue
    if (limitEndUs !== null && startUs + durUs > limitEndUs) durUs = Math.max(0, limitEndUs - startUs)
    if (durUs <= 0) continue
    const mat = textMaterial(textContent)
    materials.texts.push(mat)
    const sp = speedMaterial(1.0)
    if (Array.isArray(materials.speeds)) materials.speeds.push(sp)
    const seg = {
      ...baseSegmentFields(mat.id, startUs, durUs),
      ...mediaSegmentFields(durUs, sp.id),
      ...visualSegmentFields(),
    }
    decorateTextSegment(seg, materials, opts)
    track.segments.push(seg)
  }
}

/** 关键词命中行 → 独立文本轨（花字金/文字模板蓝；同 kind 复用 cache 轨道）。
 *  v2：轨道/片段/素材均按 pyJianYingDraft 结构构建；opts.anim=入场动画名、
 *  opts.effectId=花字效果 id（jy_effect_id，挂 materials.effects + content.effectStyle）。 */
const KEYWORD_TRACK_STYLES = {
  fancy: { color: '#FFD700' },
  tpl:   { color: '#4FC3F7' },
}
function appendKeywordTrack(tracks, materials, srtPath, words, kind, offsetUs = 0, limitEndUs = null, cache = {}, opts = {}) {
  const hitWords = (Array.isArray(words) ? words : []).map((w) => String(w).trim()).filter(Boolean)
  if (!hitWords.length) return
  const st = KEYWORD_TRACK_STYLES[kind] || KEYWORD_TRACK_STYLES.tpl
  for (const [startSec, endSec, textContent] of parseSrt(srtPath)) {
    const lower = textContent.toLowerCase()
    const hits = hitWords.filter((w) => lower.includes(w.toLowerCase()))
    if (!hits.length) continue
    const startUs = Math.floor(startSec * 1000000) + offsetUs
    let durUs = Math.floor((endSec - startSec) * 1000000)
    if (durUs <= 0) continue
    if (limitEndUs !== null && startUs + durUs > limitEndUs) durUs = Math.max(0, limitEndUs - startUs)
    if (durUs <= 0) continue
    let track = cache[kind]
    if (!track) {
      track = newTrack('text')
      tracks.push(track)
      cache[kind] = track
    }
    const mat = textMaterial(hits.join(' '), { colorHex: st.color, bold: true, effectStyleId: opts.effectId || '' })
    materials.texts.push(mat)
    const sp = speedMaterial(1.0)
    if (Array.isArray(materials.speeds)) materials.speeds.push(sp)
    const seg = {
      ...baseSegmentFields(mat.id, startUs, durUs),
      ...mediaSegmentFields(durUs, sp.id),
      ...visualSegmentFields(),
    }
    decorateTextSegment(seg, materials, opts)
    track.segments.push(seg)
  }
}

/** BGM 音轨覆盖整条时间轴（_append_bgm_track L375-425；v2 素材/片段结构） */
function appendBgmTrack(tracks, materials, bgmPath, bgmVolume, totalDurationUs, deps) {
  let bgmDurationSec = 0.0
  if (deps && typeof deps.probeMedia === 'function') {
    try {
      const { durationSec } = deps.probeMedia(bgmPath)
      bgmDurationSec = durationSec || 0
    } catch (_) { /* 原版失败按 0 处理 */ }
  }
  if (bgmDurationSec <= 0) bgmDurationSec = totalDurationUs / 1000000.0 + 60.0 // 足够长

  const materialId = hexId()
  materials.audios.push(audioMaterialFields(bgmPath.split('\\').join('/'), Math.floor(bgmDurationSec * 1000000)))
  const sp = speedMaterial(1.0)
  materials.speeds.push(sp)
  const track = newTrack('audio')
  track.segments.push({
    ...baseSegmentFields(materialId, 0, totalDurationUs),
    source_timerange: { start: 0, duration: totalDurationUs },
    speed: 1.0,
    volume: bgmVolume / 100.0,
    extra_material_refs: [sp.id],
    is_tone_modify: false,
    clip: null,
    hdr_settings: null,
  })
  tracks.push(track)
}

/** 解析 srt 为 [startSec, endSec, text] 列表（_parse_srt L428-466） */
function parseSrt(srtPath) {
  const segments = []
  try {
    const lines = fs.readFileSync(srtPath, 'utf-8').split(/\r?\n/)
    let idx = 0
    while (idx < lines.length) {
      let line = lines[idx].trim()
      if (!line) { idx += 1; continue }
      // Skip numeric index line
      if (/^\d+$/.test(line)) {
        idx += 1
        if (idx >= lines.length) break
        line = lines[idx].trim()
      }
      if (line.includes('-->')) {
        const parts = line.split('-->')
        const startSec = timestampToSec(parts[0].trim())
        const endSec = timestampToSec(parts[1].trim())
        idx += 1
        const textLines = []
        while (idx < lines.length && lines[idx].trim()) {
          textLines.push(lines[idx].trim())
          idx += 1
        }
        segments.push([startSec, endSec, textLines.join(' ')])
      }
      idx += 1
    }
  } catch (_) { /* 原版 OSError 仅 warning 后返回空 */ }
  return segments
}

/** 00:00:02,120 → 秒（_timestamp_to_sec L469-480；格式非法返 0.0，对照原版 except ValueError） */
function timestampToSec(ts) {
  try {
    const parts = String(ts).replace(',', '.').split(':')
    const h = parseInt(parts[0], 10)
    const m = parseInt(parts[1], 10)
    const s = parseFloat(parts[2])
    if (Number.isNaN(h) || Number.isNaN(m) || Number.isNaN(s)) return 0.0
    return h * 3600 + m * 60 + s
  } catch (_) {
    return 0.0
  }
}

module.exports = {
  TRANSITION_MAP,
  DRAFT_SCHEMA,
  getDefaultDraftRoot,
  exportToDraft,
  exportMultiToDraft,
  registerInRootMeta,
  normalizeTransitions,
  normalizeOneTransition,
  parseSrt,
  timestampToSec,
  appendKeywordTrack,
  KEYWORD_TRACK_STYLES,
}
