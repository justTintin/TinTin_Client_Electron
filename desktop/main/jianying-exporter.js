// ═══════════════════════════════════════════════════════════════
// jianying-exporter.js — 剪映专业版草稿（DRT）导出器
// 对照原客户端 studio/utils/jianying_exporter.py 一比一移植：
//   · TRANSITION_MAP 8 项（UI 转场 key → 剪映转场名/资源ID/效果ID/is_overlap/时长微秒）
//   · get_default_draft_root        → getDefaultDraftRoot
//   · export_to_draft（单段，兼容旧入口）→ exportToDraft
//   · export_multi_to_draft（多片段时间轴）→ exportMultiToDraft
//   · _probe_video/_normalize_transitions/_build_transition_material/
//     _append_subtitle_track/_append_bgm_track/_parse_srt/_timestamp_to_sec
// 结构逐字段对齐（draft_meta_info.json + draft_content.json 的 canvas_config/
// materials{videos,audios,texts,transitions}/tracks），禁止自拟字段。
// ffprobe 探测以 deps 注入（montage-final-ipc.js 提供），本文件不碰进程，
// 纯逻辑可单测（tests/jianying-exporter.test.mjs）。
// ═══════════════════════════════════════════════════════════════

'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')

// UI 转场 key -> (剪映转场名, resource_id, effect_id, is_overlap, 默认时长(微秒))
// 资源 ID 来自剪映内置转场元数据（pyJianYingDraft，2024 版剪映专业版）
const TRANSITION_MAP = {
  fade:       { name: '模糊',     resourceId: '6911569618171597320', effectId: '4212596', isOverlap: true,  duration: 500000 },
  dissolve:   { name: '叠化',     resourceId: '6724845717472416269', effectId: '322577',  isOverlap: true,  duration: 500000 },
  slideleft:  { name: '向左擦除', resourceId: '6724849999336706573', effectId: '2917283', isOverlap: true,  duration: 500000 },
  slideright: { name: '向右擦除', resourceId: '6724849898857959950', effectId: '2917284', isOverlap: true,  duration: 500000 },
  slideup:    { name: '向上擦除', resourceId: '6724849456891564557', effectId: '2917281', isOverlap: true,  duration: 500000 },
  slidedown:  { name: '向下擦除', resourceId: '6724849752921346573', effectId: '2917282', isOverlap: true,  duration: 500000 },
  zoomin:     { name: '推近',     resourceId: '6724226861666144779', effectId: '359359',  isOverlap: false, duration: 1000000 },
  zoomout:    { name: '拉远',     resourceId: '6724226338418332167', effectId: '359365',  isOverlap: false, duration: 1000000 },
}

/** 大写无连字符 uuid（对照 str(uuid.uuid4()).upper()） */
function newId() {
  return randomUUID().replace(/-/g, '').toUpperCase()
}

/** Windows 默认的剪映专业版草稿根目录（get_default_draft_root） */
function getDefaultDraftRoot() {
  let appdata = process.env.LOCALAPPDATA || ''
  if (!appdata) appdata = path.join(process.env.USERPROFILE || '', 'AppData', 'Local')
  return path.join(appdata, 'JianyingPro', 'User Data', 'Projects', 'com.lveditor.draft')
}

/** 单视频导出（兼容旧入口，内部走多片段时间轴导出；export_to_draft L43-64） */
function exportToDraft({ videoPath, bgmPath = '', bgmVolume = 50, srtPath = '', draftName = '', deps }) {
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
    deps,
  })
}

/** 多个视频按顺序导出为一条剪映时间轴（export_multi_to_draft L67-234） */
function exportMultiToDraft({ videoPaths, transitions = null, bgmPath = '', bgmVolume = 50, srtPaths = null, draftName = '', deps }) {
  const paths = (videoPaths || []).filter(Boolean)
  if (!paths.length) return { success: false, message: '没有可导出的视频' }
  for (const p of paths) {
    if (!fs.existsSync(p)) return { success: false, message: `视频文件不存在: ${p}` }
  }

  try {
    // 1. 探测每个视频的时长与分辨率（_probe_video；失败兜底 10s / 1080x1920）
    const clips = []
    let totalDurationUs = 0
    for (const p of paths) {
      const [durationUs, width, height] = probeVideo(p, deps)
      clips.push({
        path: p,
        durationUs: durationUs > 0 ? durationUs : 10000000,
        width: width || 1080,
        height: height || 1920,
      })
      totalDurationUs += clips[clips.length - 1].durationUs
    }

    const canvasWidth = clips[0].width
    const canvasHeight = clips[0].height

    // 2. 准备草稿目录与 UUID
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

    // 3. draft_meta_info.json（L128-139 字段一比一）
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

    // 4. 素材库 + 轨道（视频轨顺序排布；转场挂「前一个」片段；字幕按时间轴偏移）
    const materials = { videos: [], audios: [], texts: [], transitions: [] }
    const videoTrack = { id: newId(), type: 'video', segments: [] }
    const tracks = [videoTrack]

    const transitionSpecs = normalizeTransitions(transitions, clips.length - 1)
    let cursorUs = 0
    for (let i = 0; i < clips.length; i++) {
      const clip = clips[i]
      const videoMaterialId = newId()
      materials.videos.push({
        id: videoMaterialId,
        local_material_path: clip.path.split('\\').join('/'),
        duration: clip.durationUs,
        type: 'video',
        width: clip.width,
        height: clip.height,
      })
      videoTrack.segments.push({
        id: newId(),
        material_id: videoMaterialId,
        target_timerange: { start: cursorUs, duration: clip.durationUs },
        source_timerange: { start: 0, duration: clip.durationUs },
        speed: 1.0,
        volume: 1.0,
        extra_material_refs: [],
      })
      if (i > 0) {
        const spec = transitionSpecs[i - 1]
        if (spec) videoTrack.segments[videoTrack.segments.length - 2].extra_material_refs.push(buildTransitionMaterial(materials, spec))
      }
      if (srtPaths && i < srtPaths.length && srtPaths[i] && fs.existsSync(srtPaths[i])) {
        appendSubtitleTrack(tracks, materials, srtPaths[i], cursorUs, cursorUs + clip.durationUs)
      }
      cursorUs += clip.durationUs
    }

    // 5. BGM（覆盖整条时间轴）
    if (bgmPath && fs.existsSync(bgmPath)) {
      appendBgmTrack(tracks, materials, bgmPath, bgmVolume, totalDurationUs, deps)
    }

    // 6. canvas_config 比例
    let ratio = '9:16'
    if (canvasWidth > canvasHeight) ratio = '16:9'
    else if (canvasWidth === canvasHeight) ratio = '1:1'

    const contentInfo = {
      canvas_config: { width: canvasWidth, height: canvasHeight, ratio },
      materials,
      tracks,
    }
    fs.writeFileSync(path.join(draftFolder, 'draft_content.json'), JSON.stringify(contentInfo, null, 2), 'utf-8')
    return { success: true, message: draftFolder }
  } catch (e) {
    return { success: false, message: e && e.message ? e.message : String(e) }
  }
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

/** 转场写入 materials.transitions，返回素材 id（_build_transition_material L317-332） */
function buildTransitionMaterial(materials, spec) {
  const transId = newId()
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

/** 一个 .srt 写入字幕轨（不存在则新建），时间整体偏移 offset（_append_subtitle_track L335-372） */
function appendSubtitleTrack(tracks, materials, srtPath, offsetUs = 0, limitEndUs = null) {
  const srtSegments = parseSrt(srtPath)
  if (!srtSegments.length) return
  let textTrack = null
  for (const t of tracks) {
    if (t.type === 'text') { textTrack = t; break }
  }
  if (textTrack === null) {
    textTrack = { id: newId(), type: 'text', segments: [] }
    tracks.push(textTrack)
  }
  for (const [startSec, endSec, textContent] of srtSegments) {
    const startUs = Math.floor(startSec * 1000000) + offsetUs
    let durUs = Math.floor((endSec - startSec) * 1000000)
    if (durUs <= 0) continue
    if (limitEndUs !== null && startUs + durUs > limitEndUs) durUs = Math.max(0, limitEndUs - startUs)
    if (durUs <= 0) continue
    const textMaterialId = newId()
    // 转义字幕文本中的引号/反斜杠，避免破坏 content 的 JSON 结构
    const safeText = textContent.split('\\').join('\\\\').split('"').join('\\"')
    materials.texts.push({
      id: textMaterialId,
      content: `[{"text":"${safeText}","style":{"bold":false,"color":"#FFFFFF","font":""}}]`,
      type: 'text',
    })
    textTrack.segments.push({
      id: newId(),
      material_id: textMaterialId,
      target_timerange: { start: startUs, duration: durUs },
    })
  }
}

/** BGM 音频轨覆盖整条时间轴（_append_bgm_track L375-425） */
function appendBgmTrack(tracks, materials, bgmPath, bgmVolume, totalDurationUs, deps) {
  let bgmDurationSec = 0.0
  if (deps && typeof deps.probeMedia === 'function') {
    try {
      const { durationSec } = deps.probeMedia(bgmPath)
      bgmDurationSec = durationSec || 0
    } catch (_) { /* 原版失败按 0 处理 */ }
  }
  if (bgmDurationSec <= 0) bgmDurationSec = totalDurationUs / 1000000.0 + 60.0 // 足够长

  const bgmMaterialId = newId()
  materials.audios.push({
    id: bgmMaterialId,
    local_material_path: bgmPath.split('\\').join('/'),
    duration: Math.floor(bgmDurationSec * 1000000),
    type: 'audio',
  })
  const volDb = (bgmVolume / 50.0 - 1.0) * 12.0 // 粗略的分贝转换
  tracks.push({
    id: newId(),
    type: 'audio',
    segments: [{
      id: newId(),
      material_id: bgmMaterialId,
      target_timerange: { start: 0, duration: totalDurationUs },
      source_timerange: { start: 0, duration: totalDurationUs },
      volume: bgmVolume / 100.0,
      volume_db: volDb,
    }],
  })
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
  getDefaultDraftRoot,
  exportToDraft,
  exportMultiToDraft,
  normalizeTransitions,
  normalizeOneTransition,
  parseSrt,
  timestampToSec,
}
