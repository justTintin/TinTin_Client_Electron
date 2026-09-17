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

// 2026-09-16 用户裁决：视频片段之间添加半秒（500000 微秒）间隔，所有轨道随窗口起点同步。
// 模块级单一口径：exportMultiToDraft 与 montage-final-ipc 共用
// （导出后 JY.VIDEO_GAP_US 引用），避免多处常量漂移。
const VIDEO_GAP_US = 500000

// 2026-09-16 修复（用户实测：字幕显示在画面中间）：字幕标准位=屏幕下方，
// 口径沿用 pyJianYingDraft ClipSettings(transform_y=-0.8)（官方 README 字幕示例）——
// clip.transform 单位=半画布（y 负=向下）。单视频路径 appendSubtitleTrack 与
// 服务端包路径（montage-final-ipc 经 JY.SUBTITLE_TRANSFORM_Y / SUBTITLE_ALIGNMENT
// 引用）共用，避免两路径字幕位置漂移。
const SUBTITLE_TRANSFORM_Y = -0.8
// 字幕文本水平对齐：0=左 1=居中 2=右（materials.texts[].alignment）
const SUBTITLE_ALIGNMENT = 1

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

// ── 剪映原生文字模板三件套（2026-09-15 用户裁决：文字模板轨=剪映原生模板引用，
// resource_id 让剪映自己套模板渲染，零渲染保真损失）──
// 结构范本：王晗雨解密草稿（test/wang-dec.json）「超级推荐」实例逐字段比对本机
// .textpreset（Presets/Text_V2）证实结构同构，可机械重排生成：
//   materials.text_templates[] ← preset.effect/resources/paragraphs[0].attach_info/
//                                 elements[](sticker)
//   materials.texts[]          ← preset.paragraphs[0].content（仅替换 text+range）
//   文字轨 segment             ← material_id 指向 text_templates 实例 id
// 贴纸纹理在草稿中本无直接引用（non_text 条目不带 resource_id），剪映打开时按
// resource_id 从本机缓存模板定义重建实例——草稿只是实例快照，故动画/花字引用按
// panel 可确定性推导的部分随行（text/flower/sticker），不可推导的贴纸元素绑定留空。

/** 按 resource_id 定位并解析 .textpreset（找到返回解析对象，否则 null） */
function findTextPreset(presetDir, rid) {
  if (!presetDir || !rid || !fs.existsSync(presetDir)) return null
  const want = String(rid)
  for (const f of safeListDir(presetDir)) {
    if (!f.endsWith('.textpreset')) continue
    const p = readJsonSafe(path.join(presetDir, f))
    const eff = p && p.effect
    if (eff && String(eff.resource_id || eff.effect_id || '') === want) return p
  }
  return null
}

/** .textpreset attach_info.clip → 草稿 clip（scale/transform 拆对象 + flip 补空） */
function presetAttachClipToDraft(c) {
  const s = c || {}
  return {
    scale: { x: Number(s.scale_x || 1), y: Number(s.scale_y || 1) },
    rotation: Number(s.rotation || 0),
    transform: { x: Number(s.transform_x || 0), y: Number(s.transform_y || 0) },
    flip: {},
  }
}

/** .textpreset attach_info → 草稿 attach_info（duration/original_size/clip） */
function presetAttachToDraft(a) {
  const s = a || {}
  return {
    duration: Number(s.duration || 0),
    original_size_width: Number(s.original_size_width || 0),
    original_size_height: Number(s.original_size_height || 0),
    clip: presetAttachClipToDraft(s.clip),
  }
}

/** 浮点 rgb 三元组 → '#rrggbbff'（草稿 texts.text_color 口径，范本 '#fdfbfbff'） */
function rgbToHex8(c) {
  if (!Array.isArray(c) || c.length < 3) return '#FFFFFFFF'
  return '#' + c.slice(0, 3).map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('').toUpperCase() + 'FF'
}

/** 猜动画方向（in/loop）：资源目录 lua 名——EnlargeIn/BounceIn→in，Rotate/Loop→loop */
function guessStickerAnimType(dir) {
  for (const f of safeListDir(dir)) {
    if (!/\.lua$/i.test(f)) continue
    if (/(rotate|loop|float|wave|swing)/i.test(f)) return 'loop'
  }
  return 'in'
}

/** 模板实例动画素材（materials.material_animations 成员；范本最小形状：
 *  {id, type:'sticker_animation', animations:[{id:'',type,duration,path,resource_id,
 *  source_platform:1,material_type:'sticker'}]}）。时长用范本常量 in=500000/loop=800000。 */
function templateAnimMaterial(entries) {
  if (!entries.length) return null
  return { id: hexId(), type: 'sticker_animation', animations: entries }
}

/** 模板实例花字效果素材（materials.effects 成员；范本形状，flower 面板资源） */
function templateFlowerEffectMaterial(rid, dirPath) {
  return {
    id: hexId(),
    resource_id: String(rid),
    type: 'text_effect',
    sub_type: 'none',
    path: dirPath,
    source_platform: 1,
    multi_language_current: '',
    beauty_face_auto_retouch_info: {},
  }
}

/** 模板自身资源包定位（范本 path=C:/.../Cache/artistEffect/<rid>/<hash>；缺失返 ''） */
function findArtistEffectPath(rid) {
  const root = path.join(process.env.LOCALAPPDATA || '', 'JianyingPro', 'User Data', 'Cache', 'artistEffect', String(rid))
  for (const h of safeListDir(root)) {
    const hd = path.join(root, h)
    try { if (fs.statSync(hd).isDirectory()) return hd.split('\\').join('/') } catch (_) {}
  }
  return ''
}

/**
 * 从 .textpreset 构建单个文字模板实例三件套（一次命中=一个实例，范本同构：
 * 19 段=19 实例）。phrase=填充文字（命中关键词），替换 content.text 并对齐 range。
 * 返回 { templateMaterial, textEntry, animMaterials[], flowerEffects[], extraRefs[] }
 * 或 null（preset 缺关键结构）。
 */
function buildTemplateClipTrio(p, phrase) {
  if (!p || !p.effect) return null
  const eff = p.effect
  const para = (p.paragraphs || [])[0] || {}
  const text = String(phrase ?? '').trim() || (() => { try { return String(JSON.parse(para.content || '{}').text || '') } catch (_) { return '' } })()
  // content：预设原文即草稿 texts.content 同源串（字体/effectStyle/size 全同），仅换文字
  let contentObj = null
  try { contentObj = JSON.parse(para.content || '') } catch (_) { contentObj = null }
  if (!contentObj || typeof contentObj !== 'object') contentObj = { text: text, styles: [] }
  contentObj.text = text
  for (const st of contentObj.styles || []) { if (Array.isArray(st.range)) st.range = [0, text.length] }
  const contentJson = JSON.stringify(contentObj)

  // 字体（content.styles[].font → texts.fonts，去重）
  const fonts = []
  const seenFont = new Set()
  for (const st of contentObj.styles || []) {
    const f = st && st.font
    if (!f || (!f.path && !f.id)) continue
    const key = String(f.id || '') + '|' + String(f.path || '')
    if (seenFont.has(key)) continue
    seenFont.add(key)
    fonts.push({ id: hexId(), resource_id: String(f.id || ''), source_platform: 1, path: String(f.path || '') })
  }

  const textEntry = {
    id: hexId(),
    // 关键绑定键（2026-09-15 真机定位）：texts.name = 预设 text_name = 模板工程
    // content.json 文字元素 id（@343E12FD...）——剪映按它把填充文字映射进模板
    // extra.json texts[] 槽位；随机 id 时剪映回退渲染模板默认文字（超级推荐）。
    name: String(para.text_name || hexId()),
    type: 'text',
    content: contentJson,
    words: {},
    current_words: {},
    combo_info: {},
    caption_template_info: { resource_id: '', path: '' },
    layer_weight: 1,
    line_spacing: 0.1,
    shadow_alpha: 0,
    shadow_distance: 5,
    shadow_point: { x: 0, y: 0 },
    shadow_angle: -45,
    border_alpha: 0,
    border_width: 0,
    text_color: (para.style && para.style.color) || rgbToHex8((() => {
      try {
        const st = (contentObj.styles || []).find((s) => s && s.fill && s.fill.content && s.fill.content.solid)
        return st ? st.fill.content.solid.color : null
      } catch (_) { return null }
    })()),
    initial_scale: 1,
    bold_width: 0.008,
    italic_degree: 10,
    check_flag: 47,
    fonts,
    lyrics_template: { resource_id: '', path: '' },
  }

  // panel 推导的可确定性引用：text=入场/循环动画、flower=花字效果、sticker=贴纸动画
  const fwd = (s) => String(s || '').split('\\').join('/')
  const textPanel = []
  const stickerPanel = []
  let flowerRes = null
  const flowerRidFromContent = (() => {
    try {
      const st = (contentObj.styles || []).find((s) => s && s.effectStyle && s.effectStyle.id)
      return st ? String(st.effectStyle.id) : ''
    } catch (_) { return '' }
  })()
  for (const r of p.resources || []) {
    const panel = String(r.panel || '')
    if (panel === 'text') textPanel.push(r)
    else if (panel === 'sticker') stickerPanel.push(r)
    else if (panel === 'flower' && (!flowerRes || String(r.resource_id || '') === flowerRidFromContent)) flowerRes = r
  }

  const animMaterials = []
  const flowerEffects = []
  const extraRefs = []
  if (textPanel.length) {
    const anims = textPanel.slice(0, 2).map((r, i) => ({
      id: '',
      type: i === 0 ? 'in' : 'loop',
      duration: i === 0 ? 500000 : 800000,
      path: fwd(r.file_path),
      resource_id: String(r.resource_id || ''),
      source_platform: 1,
      material_type: 'sticker',
    }))
    const mat = templateAnimMaterial(anims)
    if (mat) animMaterials.push(mat)
  }
  if (flowerRes) {
    flowerEffects.push(templateFlowerEffectMaterial(flowerRes.resource_id, fwd(flowerRes.file_path)))
  }
  for (const r of stickerPanel) {
    const type = guessStickerAnimType(r.file_path)
    const mat = templateAnimMaterial([{
      id: '',
      type,
      duration: type === 'in' ? 500000 : 800000,
      path: fwd(r.file_path),
      resource_id: String(r.resource_id || ''),
      source_platform: 1,
      material_type: 'sticker',
    }])
    if (mat) animMaterials.push(mat)
  }
  extraRefs.push(...flowerEffects.map((m) => m.id), ...animMaterials.map((m) => m.id))

  const templateMaterial = {
    id: hexId(),
    version: String(eff.effect_version || '1.0.0'),
    effect_id: String(eff.effect_id || eff.resource_id || ''),
    resource_id: String(eff.resource_id || eff.effect_id || ''),
    name: String(eff.effect_name || ''),
    type: 'text_template',
    path: findArtistEffectPath(eff.resource_id || eff.effect_id || ''),
    category_id: String(eff.category_id || ''),
    category_name: String(eff.category_name || ''),
    source_platform: 1,
    resources: (p.resources || []).map((r) => ({
      panel: String(r.panel || ''),
      path: fwd(r.file_path),
      resource_id: String(r.resource_id || ''),
      source_platform: 1,
    })),
    text_info_resources: [{
      id: hexId(),
      attach_info: presetAttachToDraft(para.attach_info),
      text_material_id: textEntry.id,
      // 范本顺序：[花字效果, 文字动画]
      extra_material_refs: [...flowerEffects.map((m) => m.id), ...animMaterials.slice(0, 1).map((m) => m.id)],
    }],
    non_text_info_resources: (p.elements || [])
      .filter((e) => e && e.type === 'sticker')
      .map((e) => ({
        name: String(e.element_name || hexId()),
        type: 'sticker',
        attach_info: presetAttachToDraft(e.attach_info),
        shape_param: {},
      })),
    aigc_config: { font_item: { id: hexId(), resource_id: '', path: '' } },
    request_id: '',
    origin_word_info: {},
    current_word_info: {},
    preview_time: 0.1,
    ai_generate_task_info: { resource_id: '', path: '' },
  }
  return { templateMaterial, textEntry, animMaterials, flowerEffects, extraRefs }
}

/**
 * textTemplateClips 输入归一化：逐视频数组（与 videoPaths 对齐，同 srtPaths 口径）。
 * 条目 {phrase, startUs, durUs, resourceId}；resourceId 容错剥 'jy_' 前缀；
 * 非法条目丢弃。返回 Array<Array> 或 null（无输入）。
 */
function normalizeTextTemplateClips(textTemplateClips, videoCount) {
  if (!Array.isArray(textTemplateClips)) return null
  const out = []
  for (let i = 0; i < videoCount; i++) {
    const arr = Array.isArray(textTemplateClips[i]) ? textTemplateClips[i] : []
    const list = []
    for (const c of arr) {
      if (!c) continue
      const rid = String(c.resourceId || c.resource_id || '').trim().replace(/^jy_/, '')
      const startUs = Math.max(0, Math.round(Number(c.startUs ?? c.start_us ?? 0)))
      const durUs = Math.round(Number(c.durUs ?? c.dur_us ?? 0))
      if (!rid || durUs <= 0) continue
      list.push({ phrase: String(c.phrase ?? c.text ?? ''), startUs, durUs, resourceId: rid })
    }
    list.sort((a, b) => a.startUs - b.startUs)
    out.push(list)
  }
  return out
}

/** voiceClips 输入归一化：逐视频数组 [{path,startUs,durUs}]（与 videoPaths 对齐，同
 *  textTemplateClips 口径）；非法条目丢弃。返回 Array<Array> 或 []（无输入）。 */
function normalizeVoiceClips(voiceClips, videoCount) {
  if (!Array.isArray(voiceClips)) return []
  const out = []
  for (let i = 0; i < videoCount; i++) {
    const arr = Array.isArray(voiceClips[i]) ? voiceClips[i] : []
    const list = []
    for (const c of arr) {
      if (!c) continue
      const p = String(c.path || '')
      const startUs = Math.max(0, Math.round(Number(c.startUs ?? 0)))
      const durUs = Math.round(Number(c.durUs ?? 0))
      if (!p || durUs <= 0) continue
      list.push({ path: p, startUs, durUs })
    }
    out.push(list)
  }
  return out
}


/** 合并后轨道统一 render_index（按轨序逐段，对照本导出器 exportMultiToDraft 收尾口径） */

/** 音效轨（2026-09-17 用户裁决·定义修正）：独立音频轨，**跟随文字模板命中位置**落段
 *  （位置=关键词命中位置；与花字轨无关——花字轨是纯文本轨）。
 *  events=[{word|phrase,startUs,durUs}] 为该成片局部系；offsetUs=合并时间轴起点；
 *  opts.probeDur(path)=秒（主进程 ffprobe 注入）；sfxPath 不存在→不落轨（不造假）。 */
function appendSfxTrackFromEvents(tracks, materials, events, offsetUs, limitEndUs, opts = {}) {
  const sfxPath = String(opts.sfxPath || '')
  if (!sfxPath || !fs.existsSync(sfxPath)) return
  const list = Array.isArray(events) ? events : []
  if (!list.length) return
  const sfxDurSec = Math.max(0.05, Number(opts.probeDur ? opts.probeDur(sfxPath) : 0) || 0.5)
  const sfxDurUs = Math.round(sfxDurSec * 1e6)
  const gainDb = Number(opts.gainDb)
  const volume = Number.isFinite(gainDb) ? Math.min(1, Math.max(0, Math.pow(10, gainDb / 20))) : 1.0
  const sfxTrack = newTrack('audio')
  for (const ev of list) {
    const startUs = offsetUs + Math.max(0, Math.round(Number(ev.startUs) || 0))
    let durUs = Math.min(sfxDurUs, Math.max(1, Math.round(Number(ev.durUs) || 0)))
    if (limitEndUs !== null && startUs + durUs > limitEndUs) durUs = limitEndUs - startUs
    if (durUs <= 0) continue
    const mat = audioMaterialFields(sfxPath, durUs)
    materials.audios.push(mat)
    const ssp = speedMaterial(1.0)
    if (Array.isArray(materials.speeds)) materials.speeds.push(ssp)
    sfxTrack.segments.push({
      ...baseSegmentFields(mat.id, startUs, durUs),
      source_timerange: { start: 0, duration: durUs },
      speed: 1.0,
      volume,
      extra_material_refs: [ssp.id],
      is_tone_modify: false,
      clip: null,
      hdr_settings: null,
    })
  }
  if (sfxTrack.segments.length) tracks.push(sfxTrack)
}



function draft_content_tracks_render_index(tracks) {
  tracks.forEach((track, order) => {
    for (const seg of track.segments || []) seg.render_index = order
  })
}
/** 模板实例段追加到文字模板轨（时间窗裁剪同 appendSubtitleTrack 口径；
 *  preset 解析经 cache 复用；模板缺失静默跳过——不造假）。 */
function appendTextTemplateSegments(track, materials, clips, presetDir, offsetUs, limitEndUs, tplCache) {
  for (const c of clips) {
    const startUs = offsetUs + c.startUs
    let durUs = c.durUs
    if (limitEndUs !== null && startUs >= limitEndUs) continue
    if (limitEndUs !== null && startUs + durUs > limitEndUs) durUs = limitEndUs - startUs
    if (durUs <= 0) continue
    let p = tplCache.get(c.resourceId)
    if (p === undefined) {
      p = findTextPreset(presetDir, c.resourceId)
      tplCache.set(c.resourceId, p)
    }
    if (!p) continue
    const trio = buildTemplateClipTrio(p, c.phrase)
    if (!trio) continue
    materials.text_templates.push(trio.templateMaterial)
    materials.texts.push(trio.textEntry)
    if (!Array.isArray(materials.material_animations)) materials.material_animations = []
    materials.material_animations.push(...trio.animMaterials)
    if (trio.flowerEffects.length) {
      if (!Array.isArray(materials.effects)) materials.effects = []
      materials.effects.push(...trio.flowerEffects)
    }
    const sp = speedMaterial(1.0)
    if (Array.isArray(materials.speeds)) materials.speeds.push(sp)
    track.segments.push({
      ...baseSegmentFields(trio.templateMaterial.id, startUs, durUs),
      ...mediaSegmentFields(durUs, sp.id),
      ...visualSegmentFields(),
      source_timerange: null, // 文本段（标准 §3.6）：source_timerange = null
      extra_material_refs: [sp.id, ...trio.extraRefs],
    })
  }
}

/** 贴纸素材（materials.stickers 成员；pyJianYingDraft StickerSegment.export_material） */
function stickerMaterial(resourceId) {
  return {
    id: hexId(),
    resource_id: resourceId,
    sticker_id: resourceId,
    source_platform: 1,
    type: 'sticker',
  }
}

/** 视频特效素材（materials.video_effects 成员；pyJianYingDraft VideoEffect.export_json） */
function videoEffectMaterial(effectId, name) {
  return {
    apply_target_type: 0,
    category_id: '',
    category_name: '',
    effect_id: effectId,
    id: hexId(),
    name: name || '',
    path: '',
    platform: 'all',
    resource_id: effectId,
    source_platform: 1,
    type: 'video_effect',
    value: 1.0,
    request_id: '',
    keyframes: [],
  }
}

/**
 * 二期④：给视频主轨全部片段挂视频特效（video_effects + extra_material_refs）。
 * effectId/resource_id 剪映端自解析；失败静默（特效为可选增强）。
 */
function applyVideoEffect(materials, videoTrack, effectId, name) {
  if (!effectId || !videoTrack || !videoTrack.segments?.length) return 0
  if (!Array.isArray(materials.video_effects)) materials.video_effects = []
  const mat = videoEffectMaterial(effectId, name)
  materials.video_effects.push(mat)
  let n = 0
  for (const seg of videoTrack.segments) {
    seg.extra_material_refs.push(mat.id)
    n++
  }
  return n
}

/**
 * 从 textpreset 提取贴纸元素 → 独立贴纸轨（二期③：贴纸+动画）。
 * R2 坐标公式换算 clip 变换（720 设计画布、y 向上）；无素材/无贴纸 → 空轨不添加。
 * 返回 track 或 null。texts 用 decoration 的 attach（资源 id 即 rid 家族），
 * 来源标识：resource_id = preset effect resource_id + 序号。
 */
function buildStickerTrackFromPreset(presetDir, rid, clipDurationUs, canvasW, canvasH) {
  if (!presetDir || !rid || !(clipDurationUs > 0) || !(canvasW > 0) || !(canvasH > 0)) return null
  if (!fs.existsSync(presetDir)) return null
  let preset = null
  for (const f of safeListDir(presetDir)) {
    if (!f.endsWith('.textpreset')) continue
    const p = readJsonSafe(path.join(presetDir, f))
    const eff = p && p.effect
    if (eff && String(eff.resource_id || eff.effect_id || '') === String(rid)) { preset = p; break }
  }
  if (!preset) return null
  const elements = (preset.elements || []).filter((e) => e && e.type === 'sticker')
  if (!elements.length) return null
  // PNG 素材池（与 elements 两遍配对：精确尺寸 → 宽高比就近）
  const pngs = []
  const seen = new Set()
  for (const r of preset.resources || []) {
    try {
      for (const f of safeListDir(r.file_path)) {
        if (!f.endsWith('.png')) continue
        const fp = path.join(r.file_path, f)
        const b = fs.readFileSync(fp)
        const nw = b.readUInt32BE(16), nh = b.readUInt32BE(20)
        const key = nw + 'x' + nh + ':' + b.length
        if (seen.has(key)) continue
        seen.add(key)
        pngs.push({ file: fp, nw, nh, bytes: b })
      }
    } catch (_) {}
  }
  pngs.forEach((d) => { d.used = false })
  const assign = new Array(elements.length).fill(null)
  elements.forEach((e, i) => {
    const c = (e.attach_info && e.attach_info.clip) || {}
    const ow = Number(e.attach_info.original_size_width || 0), oh = Number(e.attach_info.original_size_height || 0)
    const d = pngs.find((x) => !x.used && x.nw === ow && x.nh === oh)
    if (d) { d.used = true; assign[i] = d }
  })
  elements.forEach((e, i) => {
    if (assign[i]) return
    const c = (e.attach_info && e.attach_info.clip) || {}
    const ow = Number(e.attach_info.original_size_width || 1), oh = Number(e.attach_info.original_size_height || 1)
    let bestD = null, bestDiff = 1e9
    for (const d of pngs) {
      if (d.used) continue
      const diff = Math.abs(d.nw / d.nh - ow / oh)
      if (diff < bestDiff) { bestDiff = diff; bestD = d }
    }
    if (bestD) { bestD.used = true; assign[i] = bestD }
  })
  // 贴纸本地文件必须存在于剪映缓存（resource_id 指向云端时剪映自动下载），
  // 我们导出为贴纸段（sticker material 带 resource_id），文件路径仅作排障参考。
  const track = newTrack('sticker')
  elements.forEach((e, i) => {
    const c = (e.attach_info && e.attach_info.clip) || {}
    const d = assign[i]
    if (!d) return
    const tx = Number(c.transform_x || 0), ty = Number(c.transform_y || 0)
    const sc = Number(c.scale_x || 1)
    // R2 公式：clip.transform 单位=半画布宽（pyJianYingDraft ClipSettings 注释）
    const transformX = (tx * 2) / 720
    const transformY = (-ty * 2 * canvasW / 720) / canvasH
    const scaleX = sc * (canvasW / 720)
    const scaleY = sc * (canvasW / 720)
    const mat = stickerMaterial(rid + '_' + i)
    if (!Array.isArray(preset._stickerMaterials)) preset._stickerMaterials = []
    preset._stickerMaterials.push(mat)
    const sp = speedMaterial(1.0)
    if (!Array.isArray(preset._stickerSpeeds)) preset._stickerSpeeds = []
    preset._stickerSpeeds.push(sp)
    const seg = {
      ...baseSegmentFields(mat.id, 0, clipDurationUs),
      ...mediaSegmentFields(clipDurationUs, sp.id),
      clip: {
        alpha: 1.0,
        flip: { horizontal: false, vertical: false },
        rotation: Number(c.rotation || 0),
        scale: { x: scaleX, y: scaleY },
        transform: { x: transformX, y: transformY },
      },
      uniform_scale: { on: true, value: 1.0 },
      // 标准 §3.7：贴纸段 source_timerange = null，且无 hdr_settings 字段
      // （2026-09-17 对齐收尾：此前误写 source_timerange 对象 + hdr_settings:null）
      source_timerange: null,
    }
    track.segments.push(seg)
  })
  return track.segments.length ? { track, materials: preset._stickerMaterials || [], speeds: preset._stickerSpeeds || [] } : null
}

function safeListDir(dir) {
  try { return fs.readdirSync(dir) } catch (_) { return [] }
}
function readJsonSafe(fp) {
  try { return JSON.parse(fs.readFileSync(fp, 'utf-8')) } catch (_) { return null }
}

/** 文本素材（materials.texts 成员；text_segment.py TextSegment.export_material）。
 *  effectStyleId：剪映花字效果 id（jy_effect_id）→ content.effectStyle 引用（path 'C:' 为原版占位）。
 *  alignment：水平对齐（0=左 1=居中 2=右）；字幕传 SUBTITLE_ALIGNMENT。 */
function textMaterial(text, { colorHex = '#FFFFFF', bold = false, size = 8.0, effectStyleId = '', alignment = 0 } = {}) {
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
        // 11.x 实测字段（标准 §4.3 content 注记）：pyJianYingDraft 不导出，导出器补齐
        useLetterColor: true,
      },
    ],
    text,
  }
  if (effectStyleId) contentJson.styles[0].effectStyle = { id: effectStyleId, path: 'C:' }
  return {
    id: hexId(),
    content: JSON.stringify(contentJson),
    typesetting: 0,
    alignment,
    letter_spacing: 0,
    line_spacing: 0.02,
    line_feed: 1,
    line_max_width: 0.82, // 标准 §4.3 基准字段（2026-09-17 对齐收尾：此前遗漏）
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
  const id = hexId()
  return {
    app_id: 0,
    category_id: '',
    category_name: 'local',
    check_flag: 3,
    copyright_limit_type: 'none',
    duration: durationUs,
    effect_id: '',
    formula_id: '',
    id,
    // 标准 §4.2：local_material_id / music_id = id（2026-09-17 对齐收尾：此前误写 ''）
    local_material_id: id,
    music_id: id,
    name: path.basename(bgmPath),
    path: bgmPath,
    source_platform: 0,
    type: 'extract_music',
    wave_points: [],
  }
}

/** 单视频导出（兼容旧入口，内部走多片段时间轴导出；export_to_draft L43-64） */
function exportToDraft({ videoPath, bgmPath = '', bgmVolume = 50, srtPath = '', draftName = '', fxWords = null, fxKinds = null, textAnim = '', fancyEffectId = '', tplEffectId = '', subAnim = '', videoEffectId = '', videoEffectName = '', textTemplateClips = null, deps }) {
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
    subAnim,
    videoEffectId,
    videoEffectName,
    textTemplateClips: textTemplateClips ? [textTemplateClips] : null,
    deps,
  })
}

/** 多个视频按顺序导出为一条剪映时间轴（v2 完整 schema）。
 *  fxWords（关键词）+ fxKinds（['fancy','tpl']）→ 关键词命中的字幕行导出为
 *  独立文本轨（花字/文字模板各一条，样式色区分），供剪映内直接套样式精修。
 *  textTemplateClips（2026-09-15 用户裁决）：逐视频文字模板命中
 *  [{phrase,startUs,durUs,resourceId}]（match textfx_clips 权威指派）→
 *  剪映原生文字模板三件套轨（text_templates+texts+segment）；有命中的视频
 *  不再导出旧 'tpl' 蓝字关键词轨（原生模板实例替代），'fancy' 花字轨照旧。 */
function exportMultiToDraft({ videoPaths, transitions = null, bgmPath = '', bgmVolume = 50, srtPaths = null, draftName = '', fxWords = null, fxKinds = null, textAnim = '', fancyEffectId = '', tplEffectId = '', subAnim = '', videoEffectId = '', videoEffectName = '', textTemplateClips = null, voiceClips = null, sfxPath = '', sfxGainDb = null, deps }) {
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
    // 总时长包含片段间隔（除最后一个片段外，每个片段后加半秒）
    if (clips.length > 1) totalDurationUs += (clips.length - 1) * VIDEO_GAP_US
    const canvasWidth = clips[0].width
    const canvasHeight = clips[0].height

    // 2. 草稿目录
    const draftRoot = getDefaultDraftRoot()
    fs.mkdirSync(draftRoot, { recursive: true })
    // 2026-09-16 用户裁决：草稿目录名从随机 UUID 改为有意义名称（品牌+产品型号+日期时间+分辨率）
    // 目录名需合法（Windows 文件名限制）；日期时间已保证唯一性，无需追加 UUID 后缀
    if (!draftName) {
      draftName = clips.length === 1
        ? `螺丝钉智能混剪_${path.basename(clips[0].path, path.extname(clips[0].path))}`
        : '螺丝钉智能混剪_多片段时间轴'
    }
    const projectUuid = String(draftName)
      .replace(/[\\/:*?"<>|]/g, '_')  // Windows 非法字符替换为下划线
      .slice(0, 80)  // 限制长度（Windows 路径上限 260，预留空间）
    const draftFolder = path.join(draftRoot, projectUuid)
    fs.mkdirSync(draftFolder, { recursive: true })

    // 3. draft_meta_info.json（原版字段保留；列表可见性由 registerInRootMeta 保证）
    //    字段名对齐标准 §1.6 骨架：draft_fold_path / draft_root_path
    //    （2026-09-17 对齐收尾：此前误写 draft_foldpath / draft_rootpath）
    const nowMs = Date.now()
    const metaInfo = {
      id: projectUuid,
      draft_name: draftName,
      draft_fold_path: draftFolder.split('\\').join('/'),
      draft_type: 'face',
      create_time: nowMs,
      update_time: nowMs,
      tm_draft_modified: nowMs,
      draft_root_path: draftRoot.split('\\').join('/'),
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

    // 5. 视频轨（order 0）：全片段 + 转场挂「前一个」片段；
    //    口播轨（2026-09-15 用户裁决：音频=口播轨/BGM 轨/音效轨三轨体系）——
    //    口播 wav 独立成音频轨，对应素材段自动静音（与成片「配音替换原声」混音口径一致）；
    //    无口播的素材段保留原声
    const transitionSpecs = normalizeTransitions(transitions, clips.length - 1)
    const videoTrack = newTrack('video')
    const voiceTrack = newTrack('audio')
    const voiceSegsByVideo = normalizeVoiceClips(voiceClips, clips.length)
    let cursorUs = 0
    clips.forEach((clip, i) => {
      const materialId = hexId()
      materials.videos.push(videoMaterialFields({ ...clip, materialId }))
      const sp = speedMaterial(1.0)
      speeds.push(sp)
      const voiced = (voiceSegsByVideo[i] || []).length > 0
      const seg = {
        ...baseSegmentFields(materialId, cursorUs, clip.durationUs),
        ...mediaSegmentFields(clip.durationUs, sp.id, { volume: voiced ? 0 : 1.0 }),
        ...visualSegmentFields(),
        hdr_settings: { intensity: 1.0, mode: 1, nits: 1000 },
      }
      videoTrack.segments.push(seg)
      if (i > 0) {
        const spec = transitionSpecs[i - 1]
        if (spec) videoTrack.segments[videoTrack.segments.length - 2].extra_material_refs.push(buildTransitionMaterial(materials, spec))
      }
      for (const vc of voiceSegsByVideo[i] || []) {
        const mat = audioMaterialFields(vc.path, vc.durUs)
        materials.audios.push(mat)
        const vsp = speedMaterial(1.0)
        speeds.push(vsp)
        voiceTrack.segments.push({
          ...baseSegmentFields(mat.id, cursorUs + vc.startUs, vc.durUs),
          source_timerange: { start: 0, duration: vc.durUs },
          speed: 1.0,
          volume: 1.0,
          extra_material_refs: [vsp.id],
          is_tone_modify: false,
          clip: null,
          hdr_settings: null,
        })
      }
      cursorUs += clip.durationUs
      // 除最后一个片段外，每个片段后添加半秒间隔
      if (i < clips.length - 1) cursorUs += VIDEO_GAP_US
    })
    const tracks = [videoTrack]

    // 6. 字幕轨（order 1）+ 关键词轨（fancy/tpl）+ 原生文字模板轨；textAnim=文字入场动画名，
    //    fancyEffectId=花字效果 id。二期②：subAnim=字幕轨入场动画（本地语义 key → 剪映动画名映射）
    const SUB_ANIM_TO_JY = { rise: '向上滑动', slide: '向右滑动', pop: '弹入' }
    const subAnimName = SUB_ANIM_TO_JY[subAnim] || subAnim || ''
    // 2026-09-15：原生文字模板命中归一化（match textfx_clips 权威指派；有命中→'tpl'
    // 蓝字轨被原生实例替代）
    const tplClips = normalizeTextTemplateClips(textTemplateClips, clips.length)
    const tplTrack = tplClips ? newTrack('text') : null
    const tplCache = new Map()
    const presetDir = path.join(process.env.LOCALAPPDATA || '', 'JianyingPro', 'User Data', 'Presets', 'Text_V2')
    if (srtPaths) {
      const subtitleTrack = newTrack('text')
      tracks.push(subtitleTrack)
      const fxTrackCache = {}
      const kwWords = Array.isArray(fxWords) ? fxWords.filter(Boolean) : []
      const kwKinds = Array.isArray(fxKinds) ? fxKinds.filter((k) => k === 'fancy' || k === 'tpl') : []
      const hasTplClips = !!tplClips && tplClips.some((l) => l.length)
      const effKinds = hasTplClips ? kwKinds.filter((k) => k !== 'tpl') : kwKinds
      cursorUs = 0
      clips.forEach((clip, i) => {
        if (srtPaths && i < srtPaths.length && srtPaths[i] && fs.existsSync(srtPaths[i])) {
          appendSubtitleTrack(subtitleTrack, materials, srtPaths[i], cursorUs, cursorUs + clip.durationUs, { anim: subAnimName || textAnim })
          for (const kind of effKinds) {
            appendKeywordTrack(tracks, materials, srtPaths[i], kwWords, kind, cursorUs, cursorUs + clip.durationUs, fxTrackCache, {
              anim: textAnim,
              effectId: kind === 'fancy' ? fancyEffectId : tplEffectId,
            })
          }
        }
        if (tplClips && tplClips[i] && tplClips[i].length) {
          try {
            appendTextTemplateSegments(tplTrack, materials, tplClips[i], presetDir, cursorUs, cursorUs + clip.durationUs, tplCache)
            // 音效轨（2026-09-17 用户裁决·定义修正）：跟随文字模板命中位置落段
            // （位置=关键词命中位置；与花字轨无关）。sfxPath 由调用方解析（本地音效文件）
            if (sfxPath) {
              appendSfxTrackFromEvents(tracks, materials, tplClips[i], cursorUs, cursorUs + clip.durationUs, {
                sfxPath,
                gainDb: sfxGainDb,
                probeDur: (fp) => (deps && typeof deps.probeMedia === 'function' ? (deps.probeMedia(fp).durationSec || 0) : 0),
              })
            }
          } catch (_) { /* 模板轨失败不阻断导出（字幕轨仍在） */ }
        }
        cursorUs += clip.durationUs
        // 2026-09-16 用户裁决：视频片段之间添加半秒间隔，所有轨道同步
        if (i < clips.length - 1) cursorUs += VIDEO_GAP_US
      })
      if (!subtitleTrack.segments.length) tracks.splice(tracks.indexOf(subtitleTrack), 1)
      if (tplTrack && tplTrack.segments.length) tracks.push(tplTrack)
    } else if (tplClips && tplClips.some((l) => l.length)) {
      // 无字幕轨输入时模板轨独立成轨（时间轴累计口径与上方一致）
      cursorUs = 0
      clips.forEach((clip, i) => {
        if (tplClips[i] && tplClips[i].length) {
          try {
            appendTextTemplateSegments(tplTrack, materials, tplClips[i], presetDir, cursorUs, cursorUs + clip.durationUs, tplCache)
          } catch (_) {}
        }
        cursorUs += clip.durationUs
        // 2026-09-16 用户裁决：视频片段之间添加半秒间隔，所有轨道同步
        if (i < clips.length - 1) cursorUs += VIDEO_GAP_US
      })
      if (tplTrack && tplTrack.segments.length) tracks.push(tplTrack)
    }

    // 二期③：贴纸轨（jy_ 文字模板选中时，把该预设的装饰元素导出为独立贴纸段，
    // R2 坐标公式换算 clip 变换；剪映按 resource_id 解析云端素材）。
    // 2026-09-15：原生模板轨有命中时跳过——模板实例自带贴纸，叠加会双重绘制。
    const hasNativeTpl = !!(tplTrack && tplTrack.segments.length)
    if (tplEffectId && !hasNativeTpl) {
      const presetDir = path.join(process.env.LOCALAPPDATA || '', 'JianyingPro', 'User Data', 'Presets', 'Text_V2')
      try {
        const built = buildStickerTrackFromPreset(presetDir, tplEffectId, totalDurationUs, canvasWidth, canvasHeight)
        if (built) {
          for (const m of built.materials) if (Array.isArray(materials.stickers)) materials.stickers.push(m)
          for (const s of built.speeds) if (Array.isArray(materials.speeds)) materials.speeds.push(s)
          tracks.push(built.track)
        }
      } catch (_) { /* 贴纸轨失败不阻断导出（文本轨仍在） */ }
    }

    // 二期④：视频特效挂载（videoEffectId 有值时给主轨全片段挂 video_effects）
    if (videoEffectId) {
      applyVideoEffect(materials, videoTrack, videoEffectId, videoEffectName)
    }

    // 6.5 口播音频轨（有段才入轨；音频域三轨=口播/BGM/音效）
    if (voiceTrack.segments.length) tracks.push(voiceTrack)

    // 7. BGM 轨（最后一条）：覆盖整条时间轴
    let bgmIncluded = false
    if (bgmPath && fs.existsSync(bgmPath)) {
      appendBgmTrack(tracks, materials, bgmPath, bgmVolume, totalDurationUs, deps)
      bgmIncluded = true
    }

    // 8. render_index = 轨道顺序（pyJianYingDraft script_file.dumps：主轨 0，叠加轨依次递增）
    tracks.forEach((track, order) => {
      for (const seg of track.segments) seg.render_index = order
    })
    content.tracks = tracks

    fs.writeFileSync(path.join(draftFolder, 'draft_content.json'), JSON.stringify(content, null, 2), 'utf-8')
    // bgmIncluded：BGM 轨是否实际生成（未选/文件不存在时为 false，渲染层据实提示）
    // conformance：标准符合性自检（本路径全部走标准构造器，预期 0 警告；非 0 即构造器缺陷）
    const conformance = auditDraftStandardConformance(content)
    return { success: true, message: draftFolder, draftName, schemaVersion: DRAFT_SCHEMA, bgmIncluded, conformance }
  } catch (e) {
    return { success: false, message: e && e.message ? e.message : String(e) }
  }
}

/** 把导出的草稿登记进 root_meta_info.json 首页索引（2026-09-12 M1）。
 *  条目 = 固定基线（ROOT_META_ENTRY_BASE） + 11 项业务字段覆写；写前备份；
 *  按 draft_fold_path 去重合并、置顶。 */
/** root_meta_info.json 条目固定基线（2026-09-16 用户裁决：废止「克隆 store[0]」）：
 *  来源 = 本机剪映 11.x 自行写入的条目快照（实测本机 18 个条目字段并集完全一致，共 38 键）；
 *  云端/企业/统计字段取中性缺省，调用时仅覆写 registerInRootMeta 列出的 11 项业务字段。
 *  旧实现克隆 store[0]（首页列表第一条草稿）保真 schema，代价是继承他人路径字段——实测
 *  draft_cover 指向「剪辑模板」目录（2026-09-16 封面事故）。
 *  注：草稿的轨道/素材定义在 draft_content.json（pyJianYingDraft 骨架，见 DRAFT_SCHEMA），
 *  与首页索引条目无关；本条目只是首页卡片的字段集合。 */
const ROOT_META_ENTRY_BASE = {
  cloud_draft_cover: false,
  cloud_draft_sync: false,
  draft_cloud_last_action_download: false,
  draft_cloud_purchase_info: '',
  draft_cloud_template_id: '',
  draft_cloud_tutorial_info: '',
  draft_cloud_videocut_purchase_info: '',
  draft_cover: '',
  draft_fold_path: '',
  draft_id: '',
  draft_is_ai_shorts: false,
  draft_is_cloud_temp_draft: false,
  draft_is_infinite_canvas_draft: false,
  draft_is_invisible: false,
  draft_is_pippit_draft: false,
  draft_is_web_article_video: false,
  draft_json_file: '',
  draft_name: '',
  draft_new_version: '',
  draft_root_path: '',
  draft_timeline_materials_size: 0,
  draft_type: 'face',
  draft_web_article_video_enter_from: '',
  pippit_avatar_url: '',
  pippit_extra_info: '',
  pippit_id: '',
  pippit_user_name: '',
  streaming_edit_draft_ready: true,
  tm_draft_cloud_completed: '',
  tm_draft_cloud_entry_id: -1,
  tm_draft_cloud_modified: 0,
  tm_draft_cloud_parent_entry_id: -1,
  tm_draft_cloud_space_id: -1,
  tm_draft_cloud_user_id: -1,
  tm_draft_create: 0,
  tm_draft_modified: 0,
  tm_draft_removed: 0,
  tm_duration: 0,
}

function registerInRootMeta({ draftFolder, draftName, durationUs = 0, coverPath = '' }) {
  const draftRoot = getDefaultDraftRoot()
  const rootMetaPath = path.join(draftRoot, 'root_meta_info.json')
  const fwd = (p) => p.split('\\').join('/')
  const rootMeta = JSON.parse(fs.readFileSync(rootMetaPath, 'utf-8'))
  const store = Array.isArray(rootMeta.all_draft_store) ? rootMeta.all_draft_store : []
  const backupPath = rootMetaPath + '.tintin-backup'
  if (!fs.existsSync(backupPath)) fs.copyFileSync(rootMetaPath, backupPath)

  // 2026-09-16 用户裁决：条目从固定基线构建，不再克隆 store[0]（旧实现会继承他人草稿
  // 的路径字段——实测 draft_cover 指向「剪辑模板」）
  const entry = JSON.parse(JSON.stringify(ROOT_META_ENTRY_BASE))
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
    tm_draft_removed: 0, // 基线快照若带「移除」时间戳必须清零（防首页误判已删除）
    // 2026-09-16 修复（用户实测：首页封面串到别的草稿）：封面由调用方先生成
    // draftFolder/draft_cover.jpg 再传 coverPath；未生成时一律空串，不得指向他人目录。
    draft_cover: coverPath ? fwd(coverPath) : '',
  })
  rootMeta.all_draft_store = [entry, ...store.filter((e) => e && e.draft_fold_path !== entry.draft_fold_path)]
  fs.writeFileSync(rootMetaPath, JSON.stringify(rootMeta, null, 2), 'utf-8')
  return { ok: true, backupPath, entry }
}

/** 草稿段/素材符合性审计（标准 §0.3 条3「服务端直传段违反标准 → 上报不兜底」的落地，
 *  2026-09-17 对齐收尾新增）。只上报不阻断，返回 { checkedSegs, warnings[] }：
 *  ① 段/素材 id = 32 位小写 hex（§0.4）；② target_timerange.duration > 0；
 *  ③ 视频段 hdr_settings 必须为对象（§3.4）；④ 段字段超出标准已知集
 *  （5.9 全集 + 11.x 实测并集）→ 列名上报。warnings 上限 20 条。 */
const KNOWN_SEGMENT_FIELDS = new Set([
  // §3.1 基类 17
  'id', 'material_id', 'target_timerange', 'enable_adjust', 'enable_color_correct_adjust',
  'enable_color_curves', 'enable_color_match_adjust', 'enable_color_wheels', 'enable_lut',
  'enable_smart_color_adjust', 'last_nonzero_volume', 'reverse', 'track_attribute',
  'track_render_index', 'visible', 'common_keyframes', 'keyframe_refs',
  // §3.2 媒体 5
  'source_timerange', 'speed', 'volume', 'extra_material_refs', 'is_tone_modify',
  // §3.3 视觉 2 + §3.4/§3.5
  'clip', 'uniform_scale', 'hdr_settings',
  // §3.11 轨序赋值
  'render_index',
  // 11.x 实测并集新增（标准 §3.1 注）
  'enable_adjust_mask', 'enable_hsl', 'render_timerange', 'responsive_layout', 'source',
])
function auditDraftStandardConformance(content) {
  const warnings = []
  const push = (msg) => { if (warnings.length < 20) warnings.push(msg) }
  const lowerHex = /^[0-9a-f]{32}$/
  let checkedSegs = 0
  for (const tr of ((content && content.tracks) || [])) {
    for (const seg of (tr.segments || [])) {
      if (!seg || typeof seg !== 'object') continue
      checkedSegs++
      if (!lowerHex.test(String(seg.id || ''))) push(`${tr.type} 轨段 id 非标准 32 位小写 hex：${seg.id}`)
      if (seg.material_id && !lowerHex.test(String(seg.material_id))) push(`${tr.type} 轨段 material_id 非标准格式：${seg.material_id}`)
      const dur = seg.target_timerange && seg.target_timerange.duration
      if (!(dur > 0)) push(`${tr.type} 轨段 target_timerange.duration ≤ 0（id=${seg.id}）`)
      if (tr.type === 'video' && (!seg.hdr_settings || typeof seg.hdr_settings !== 'object')) {
        push(`视频段 hdr_settings 缺失或为 null（id=${seg.id}，§3.4）`)
      }
      for (const k of Object.keys(seg)) {
        if (!KNOWN_SEGMENT_FIELDS.has(k)) push(`${tr.type} 轨段含标准外字段 ${k}（id=${seg.id}）`)
      }
    }
  }
  for (const mk of Object.keys((content && content.materials) || {})) {
    for (const m of (content.materials[mk] || [])) {
      if (m && m.id && !lowerHex.test(String(m.id))) push(`materials.${mk} id 非标准 32 位小写 hex：${m.id}`)
    }
  }
  return { checkedSegs, warnings }
}

/** 轨 2（服务端标准包）解压后校验（2026-09-17 用户裁决「下载服务端封装好的草稿 zip →
 *  解压 → 数据校验 + 里面文件的路径校验 → 放到草稿目录下」）。
 *  pkgDir=解压出的草稿目录（含 draft_content.json）。校验：
 *  ① 两个 JSON 可解析；② 轨道非空；③ materials.*.path（相对路径）在包内存在；
 *  ④ 段 material_id 无悬空。符合性审计（auditDraftStandardConformance）警告仅上报
 *  不阻断（服务端拥有格式，标准 §0.3 条3 口径）。返回 { ok, problems, warnings, trackCounts, pathRefs } */
function validateDraftPackage(pkgDir) {
  const problems = []
  const warnings = []
  const trackCounts = {}
  let pathRefs = 0
  let content = null
  try {
    content = JSON.parse(fs.readFileSync(path.join(pkgDir, 'draft_content.json'), 'utf-8'))
  } catch (e) { problems.push('draft_content.json 不可解析：' + ((e && e.message) || e)) }
  try {
    JSON.parse(fs.readFileSync(path.join(pkgDir, 'draft_meta_info.json'), 'utf-8'))
  } catch (e) { problems.push('draft_meta_info.json 不可解析：' + ((e && e.message) || e)) }
  if (content) {
    for (const t of (content.tracks || [])) {
      trackCounts[t.type] = (trackCounts[t.type] || 0) + (t.segments || []).length
    }
    if (!(content.tracks || []).length) problems.push('包内草稿无轨道')
    const matIds = new Set()
    for (const k of Object.keys(content.materials || {})) {
      for (const it of (content.materials[k] || [])) { if (it && it.id) matIds.add(it.id) }
    }
    for (const t of (content.tracks || [])) {
      for (const s of (t.segments || [])) {
        if (s && s.material_id && !matIds.has(s.material_id)) {
          problems.push('段素材引用悬空：' + t.type + ' 轨 -> ' + s.material_id)
        }
      }
    }
    for (const k of Object.keys(content.materials || {})) {
      for (const it of (content.materials[k] || [])) {
        if (it && typeof it.path === 'string' && it.path && !path.isAbsolute(it.path)) {
          pathRefs++
          const fp = path.join(pkgDir, it.path.split('\\').join('/'))
          if (!fs.existsSync(fp)) {
            if (problems.length < 10) problems.push('包内缺素材文件：' + it.path)
          }
        }
      }
    }
    const conf = auditDraftStandardConformance(content)
    warnings.push(...conf.warnings)
  }
  return { ok: problems.length === 0, problems, warnings, trackCounts, pathRefs }
}

/** 草稿目录自检（2026-09-16：导出「成功」的硬判据，替代仅检查文件存在）：
 *  ① 两个 JSON 可解析；② 轨道非空；③ 所有素材引用路径在磁盘上存在；
 *  ④ assets 目录文件数 ≥ 导出清单（expectedAssetCount>0 时）。
 *  返回 { ok, trackCounts, pathRefs, missing, assetFiles, problems }；不抛异常。 */
function verifyDraftFolder({ draftFolder, expectedAssetCount = 0 }) {
  const problems = []
  let content = null
  try { content = JSON.parse(fs.readFileSync(path.join(draftFolder, 'draft_content.json'), 'utf-8')) } catch (e) { problems.push('draft_content.json 不可解析：' + ((e && e.message) || e)) }
  try { JSON.parse(fs.readFileSync(path.join(draftFolder, 'draft_meta_info.json'), 'utf-8')) } catch (e) { problems.push('draft_meta_info.json 不可解析：' + ((e && e.message) || e)) }
  const trackCounts = {}
  let pathRefs = 0
  let missing = 0
  let dangling = 0
  if (content) {
    for (const t of content.tracks || []) {
      const n = (t.segments || []).length
      trackCounts[t.type] = (trackCounts[t.type] || 0) + n
    }
    if (!(content.tracks || []).length) problems.push('draft_content.json 无轨道')
    for (const k of Object.keys(content.materials || {})) {
      for (const it of content.materials[k] || []) {
        if (it && typeof it.path === 'string' && it.path) {
          pathRefs++
          if (!fs.existsSync(it.path)) {
            missing++
            if (problems.length < 10) problems.push('素材路径不存在：' + it.path)
          }
        }
      }
    }
    // 2026-09-16 新增（《剪映轨道格式标准_2026-09-16》§7 合规校验）：段素材引用悬空检查——
    // segment.material_id 必须在 content.materials.* 中存在（悬空 = 剪映显示占位/丢素材）
    const matIds = new Set()
    for (const k of Object.keys(content.materials || {})) {
      for (const it of content.materials[k] || []) { if (it && it.id) matIds.add(it.id) }
    }
    for (const t of content.tracks || []) {
      for (const s of t.segments || []) {
        if (s && s.material_id && !matIds.has(s.material_id)) {
          dangling++
          if (problems.length < 10) problems.push('段素材引用悬空：' + t.type + ' 轨 -> ' + s.material_id)
        }
      }
    }
  }
  let assetFiles = 0
  try {
    const walk = (dir) => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const fp = path.join(dir, ent.name)
        if (ent.isDirectory()) walk(fp)
        else assetFiles++
      }
    }
    walk(path.join(draftFolder, 'assets'))
  } catch (_) { /* 无 assets 目录（本地文件导出路经）不视为问题 */ }
  if (expectedAssetCount > 0 && assetFiles < expectedAssetCount) problems.push('资产文件数不足：磁盘 ' + assetFiles + ' < 清单 ' + expectedAssetCount)
  return { ok: problems.length === 0, trackCounts, pathRefs, missing, dangling, assetFiles, problems }
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

/** 字幕段标准构造器（2026-09-16：《剪映轨道格式标准_2026-09-16》§3.2 唯一实现）。
 *  两条导出路径（exportMultiToDraft 单/多视频、from-tasks 字幕重建）共用——
 *  禁止各自手写段对象（此前 from-tasks 手写段缺 track_attribute/track_render_index/
 *  visible/speed 引用等标准字段）。用户裁决：轨道格式按标准导出，不许自组装。
 *  结构 = baseSegmentFields + mediaSegmentFields + visualSegmentFields +
 *  字幕标准位（transform_y=SUBTITLE_TRANSFORM_Y）+ 文本水平居中（texts.alignment）。 */
function buildSubtitleSegment(textContent, startUs, durUs, materials, opts = {}) {
  const mat = textMaterial(textContent, { alignment: SUBTITLE_ALIGNMENT })
  if (!Array.isArray(materials.texts)) materials.texts = []
  materials.texts.push(mat)
  const sp = speedMaterial(1.0)
  if (!Array.isArray(materials.speeds)) materials.speeds = []
  materials.speeds.push(sp)
  const seg = {
    ...baseSegmentFields(mat.id, startUs, durUs),
    ...mediaSegmentFields(durUs, sp.id),
    ...visualSegmentFields(),
    // 标准 §3.6：文本段 source_timerange = null（pyJianYingDraft TextSegment 传 None；
    // 11.x 实测文本段无此字段。2026-09-17 对齐收尾：此前误写 {start:0,duration}）
    source_timerange: null,
  }
  // 字幕标准位：屏幕下方（口径见 SUBTITLE_TRANSFORM_Y 注释）
  seg.clip.transform = { x: 0, y: SUBTITLE_TRANSFORM_Y }
  decorateTextSegment(seg, materials, opts)
  return seg
}

/** 一条 SRT 的 cue 追加到文本轨（v2：走 buildSubtitleSegment 标准构造器；opts.anim=入场动画名） */
function appendSubtitleTrack(track, materials, srtPath, offsetUs = 0, limitEndUs = null, opts = {}) {
  for (const [startSec, endSec, textContent] of parseSrt(srtPath)) {
    const startUs = Math.floor(startSec * 1000000) + offsetUs
    let durUs = Math.floor((endSec - startSec) * 1000000)
    if (durUs <= 0) continue
    if (limitEndUs !== null && startUs + durUs > limitEndUs) durUs = Math.max(0, limitEndUs - startUs)
    if (durUs <= 0) continue
    track.segments.push(buildSubtitleSegment(textContent, startUs, durUs, materials, opts))
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
      source_timerange: null, // 文本段（标准 §3.6）：source_timerange = null
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

  // 2026-09-17 golden 对照工具抓出的存量 bug：素材与段必须共用同一个 id——
  // 此前段用独立 materialId 而 audioMaterialFields 内部另生 id → 段引用悬空（§7-⑤ 必拦截）
  const bgmMat = audioMaterialFields(bgmPath.split('\\').join('/'), Math.floor(bgmDurationSec * 1000000))
  materials.audios.push(bgmMat)
  const sp = speedMaterial(1.0)
  materials.speeds.push(sp)
  const track = newTrack('audio')
  track.segments.push({
    ...baseSegmentFields(bgmMat.id, 0, totalDurationUs),
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

/** 定位剪映主程序（Apps\<版本>\JianyingPro.exe，取存在 exe 的最高版本号） */
function findJianyingExe(appsDir) {
  const local = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Local')
  const root = appsDir || path.join(local, 'JianyingPro', 'Apps')
  let best = null
  try {
    for (const ver of fs.readdirSync(root)) {
      const exe = path.join(root, ver, 'JianyingPro.exe')
      let ok = false
      try { ok = fs.statSync(exe).isFile() } catch (_) { ok = false }
      if (!ok) continue
      const key = String(ver).split('.').map((x) => parseInt(x, 10) || 0)
      if (!best) { best = { exe, key }; continue }
      for (let i = 0; i < Math.max(key.length, best.key.length); i++) {
        const a = key[i] || 0
        const bv = best.key[i] || 0
        if (a !== bv) { if (a > bv) best = { exe, key }; break }
      }
    }
  } catch (_) {}
  return best ? best.exe : ''
}

/** 拉起剪映（已运行不重复启动；未找到安装返回 ok:false）。尽力而为，不抛异常 */
function launchJianying(appsDir) {
  try {
    const { execFileSync, spawn } = require('node:child_process')
    try {
      const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq JianyingPro.exe'], { encoding: 'utf8', timeout: 10000, windowsHide: true })
      if (/JianyingPro\.exe/i.test(out)) return { ok: true, running: true }
    } catch (_) { /* tasklist 失败按未运行处理，继续尝试拉起 */ }
    const exe = findJianyingExe(appsDir)
    if (!exe) return { ok: false, error: '未找到剪映安装路径（Apps 下无 <版本>/JianyingPro.exe）' }
    const child = spawn(exe, [], { detached: true, stdio: 'ignore', windowsHide: false })
    child.unref()
    return { ok: true, launched: true, exe }
  } catch (e) { return { ok: false, error: e.message } }
}

module.exports = {
  TRANSITION_MAP,
  DRAFT_SCHEMA,
  getDefaultDraftRoot,
  exportToDraft,
  exportMultiToDraft,
  registerInRootMeta,
  verifyDraftFolder,
  validateDraftPackage,
  auditDraftStandardConformance,
  normalizeTransitions,
  normalizeOneTransition,
  parseSrt,
  timestampToSec,
  appendKeywordTrack,
  KEYWORD_TRACK_STYLES,
  findJianyingExe,
  launchJianying,
  // 剪映原生文字模板三件套（2026-09-15）
  findTextPreset,
  presetAttachToDraft,
  buildTemplateClipTrio,
  normalizeTextTemplateClips,
  appendTextTemplateSegments,
  appendSfxTrackFromEvents,
  draft_content_tracks_render_index,
  normalizeVoiceClips,
  SUBTITLE_TRANSFORM_Y,
  SUBTITLE_ALIGNMENT,
  buildSubtitleSegment,
  VIDEO_GAP_US,
}
