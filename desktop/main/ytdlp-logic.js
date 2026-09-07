const YTDLP_ALLOWED_HOST_SUFFIXES = ['.youtube.com', '.bilibili.com']
const YTDLP_ALLOWED_HOSTS = new Set(['youtube.com', 'youtu.be', 'bilibili.com', 'b23.tv'])
const MP3_KBPS_TIERS = [320, 192, 128]

/** URL 白名单（对照 OpenCreator executor.ts isSupportedUrl：https + YouTube/Bilibili 域） */
function isSupportedUrl(rawUrl) {
  const url = String(rawUrl || '').trim()
  if (!url.startsWith('https://')) return false
  let host = ''
  try { host = new URL(url).hostname.toLowerCase() } catch (_) { return false }
  if (YTDLP_ALLOWED_HOSTS.has(host)) return true
  return YTDLP_ALLOWED_HOST_SUFFIXES.some((sfx) => host.endsWith(sfx))
}

/** 平台标签（对照 platform：extractor_key 含 bilibili → 'bilibili'，否则 'youtube'） */
function platformFor(extractorKey) {
  return String(extractorKey || '').toLowerCase().includes('bilibili') ? 'bilibili' : 'youtube'
}

/** probe 前的 URL→平台判定（cookies 导出用；非白名单域返回 ''） */
function platformFromUrl(rawUrl) {
  let host = ''
  try { host = new URL(String(rawUrl || '').trim()).hostname.toLowerCase() } catch (_) { return '' }
  if (host === 'bilibili.com' || host.endsWith('.bilibili.com') || host === 'b23.tv') return 'bilibili'
  if (host === 'youtube.com' || host.endsWith('.youtube.com') || host === 'youtu.be') return 'youtube'
  return ''
}

/** probe 参数（--dump-single-json --no-playlist [+ --proxy]） */
function buildProbeArgs(url, proxy) {
  const args = ['--dump-single-json', '--no-playlist']
  if (proxy) args.push('--proxy', String(proxy))
  args.push(url)
  return args
}

const DOWNLOAD_COMMON_ARGS = [
  '--no-playlist', '--newline', '--windows-filenames',
  '--print', 'after_move:filepath', '--progress', '--progress-delta', '0.5',
]

/** 视频下载参数（对照 executor.ts videoDownloadArgs：合流 mp4 + remux） */
function buildVideoDownloadArgs(input) {
  const { url, formatId, audioFormatId, outTemplate, ffmpegDir, proxy } = input
  const args = [...DOWNLOAD_COMMON_ARGS]
  if (ffmpegDir) args.push('--ffmpeg-location', ffmpegDir)
  if (proxy) args.push('--proxy', String(proxy))
  args.push('-f', audioFormatId ? `${formatId}+${audioFormatId}` : String(formatId))
  args.push('--merge-output-format', 'mp4', '--remux-video', 'mp4', '-o', outTemplate, url)
  return args
}

/** 音频下载参数（对照 audioDownloadArgs：--extract-audio mp3@kbps） */
function buildAudioDownloadArgs(input) {
  const { url, formatId, kbps, outTemplate, ffmpegDir, proxy } = input
  const args = [...DOWNLOAD_COMMON_ARGS]
  if (ffmpegDir) args.push('--ffmpeg-location', ffmpegDir)
  if (proxy) args.push('--proxy', String(proxy))
  args.push('-f', String(formatId), '--extract-audio', '--audio-format', 'mp3', '--audio-quality', `${kbps}K`, '-o', outTemplate, url)
  return args
}

/**
 * 进度行解析（对照 createDownloadProgressReporter 逐行口径）：
 * [download] 42.3% → { phase:'download', pct }；[Merger]/[VideoRemuxer] → merge；
 * [ExtractAudio]/[AudioConvertor] → extract。其余行返回 null。
 */
function parseProgressLine(line) {
  const text = String(line || '')
  const dl = text.match(/\[download\]\s+([\d.]+)%/)
  if (dl) return { phase: 'download', pct: Number(dl[1]) }
  if (text.startsWith('[Merger]') || text.startsWith('[VideoRemuxer]')) return { phase: 'merge', pct: 96 }
  if (text.startsWith('[ExtractAudio]') || text.startsWith('[AudioConvertor]')) return { phase: 'extract', pct: 96 }
  return null
}

/** format 行宽容取值（字段缺失/类型漂移不抛错，全按 nullish 兜底） */
function fmtNum(v) { const n = Number(v); return Number.isFinite(n) ? n : 0 }
function fmtStr(v) { return v === null || v === undefined ? '' : String(v) }

/**
 * probe JSON → 规范化结构（zod passthrough 的 JS 等价：只挑已知字段 + 兜底）。
 * 保留原始 formats 供档位生成。
 */
function parseProbeJson(json) {
  const p = json && typeof json === 'object' ? json : {}
  const formats = Array.isArray(p.formats) ? p.formats.filter((f) => f && typeof f === 'object') : []
  const bestVideo = formats
    .filter((f) => f.vcodec && f.vcodec !== 'none' && Number(f.height) > 0)
    .sort((a, b) => Number(b.height) - Number(a.height))[0]
  return {
    id: fmtStr(p.id),
    title: fmtStr(p.title),
    uploader: fmtStr(p.uploader),
    duration: fmtNum(p.duration),
    thumbnail: fmtStr(p.thumbnail),
    extractorKey: fmtStr(p.extractor_key),
    platform: platformFor(p.extractor_key),
    webpageUrl: fmtStr(p.webpage_url),
    resolution: bestVideo ? `${Number(bestVideo.width)}x${Number(bestVideo.height)}` : '',
    formats: formats.map((f) => ({
      formatId: fmtStr(f.format_id),
      ext: fmtStr(f.ext),
      vcodec: fmtStr(f.vcodec),
      acodec: fmtStr(f.acodec),
      width: fmtNum(f.width),
      height: fmtNum(f.height),
      fps: fmtNum(f.fps),
      filesize: fmtNum(f.filesize),
      tbr: fmtNum(f.tbr),
      abr: fmtNum(f.abr),
    })),
  }
}

/** 视频格式排序权重（对照 probe-parser：高>宽>h264>mp4>有音轨>码率>大小） */
function compareVideoFormats(a, b) {
  const h264 = (f) => (f.vcodec === 'h264' || f.vcodec.startsWith('avc') ? 1 : 0)
  const hasAudio = (f) => (f.acodec !== 'none' && f.acodec ? 1 : 0)
  return b.height - a.height
    || b.width - a.width
    || h264(b) - h264(a)
    || (b.ext === 'mp4' ? 1 : 0) - (a.ext === 'mp4' ? 1 : 0)
    || hasAudio(b) - hasAudio(a)
    || b.tbr - a.tbr
    || b.filesize - a.filesize
}

/** 最佳纯音轨（m4a/mp4 优先，abr/tbr 降序） */
function bestAudioFormat(formats) {
  const audios = formats.filter((f) => f.vcodec === 'none' && f.acodec !== 'none' && f.formatId)
  if (!audios.length) return null
  audios.sort((a, b) =>
    (b.ext === 'm4a' || b.ext === 'mp4' ? 1 : 0) - (a.ext === 'm4a' || a.ext === 'mp4' ? 1 : 0)
    || b.abr - a.abr || b.tbr - a.tbr)
  return audios[0]
}

function estimateSize(fmt, durationSec) {
  if (fmt.filesize > 0) return fmt.filesize
  const bitrate = fmt.tbr > 0 ? fmt.tbr : fmt.abr
  return bitrate > 0 && durationSec > 0 ? Math.round((durationSec * bitrate * 1000) / 8) : 0
}

function formatBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return ''
  const units = ['B', 'KB', 'MB', 'GB']
  let v = n
  let i = 0
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`
}

/**
 * 档位(options)生成——纯函数核心资产（对照 probe-parser createDownloadOptions）：
 * 视频档按 宽x高 去重取最优（id=video-{height}-{n}，自动搭配最佳纯音轨）；
 * 音频档固定 320/192/128 三档 MP3（id=audio-mp3-{kbps}）。
 */
function createDownloadOptions(probe) {
  const options = []
  const videos = probe.formats.filter((f) => f.vcodec !== 'none' && f.vcodec && f.height > 0 && f.formatId)
  videos.sort(compareVideoFormats)
  const seen = new Set()
  let n = 0
  const audio = bestAudioFormat(probe.formats)
  for (const f of videos) {
    const key = `${f.width}x${f.height}`
    if (seen.has(key)) continue
    seen.add(key)
    n += 1
    const label = n === 1 ? '原始画质' : `${f.height}p`
    const detailParts = ['MP4']
    if (f.width > 0 && f.height > 0) detailParts.push(`${f.width} x ${f.height}`)
    if (f.fps > 0) detailParts.push(`${Math.round(f.fps)} FPS`)
    const size = estimateSize(f, probe.duration)
    if (size > 0) detailParts.push(`估计大小 ${formatBytes(size)}`)
    options.push({
      id: `video-${f.height}-${n}`,
      mediaType: 'video',
      label,
      detail: detailParts.join(' · '),
      videoFormatId: f.formatId,
      audioFormatId: f.acodec === 'none' || !f.acodec ? (audio ? audio.formatId : '') : '',
      estimatedSize: size,
    })
  }
  for (const kbps of MP3_KBPS_TIERS) {
    const size = probe.duration > 0 ? Math.round((probe.duration * kbps * 1000) / 8) : 0
    options.push({
      id: `audio-mp3-${kbps}`,
      mediaType: 'audio',
      label: `${kbps} kbps`,
      detail: `MP3 · ${kbps} kbps${size > 0 ? ` · 估计大小 ${formatBytes(size)}` : ''}`,
      audioFormatId: audio ? audio.formatId : 'bestaudio',
      kbps,
      estimatedSize: size,
    })
  }
  return options
}

/**
 * 错误分类（对照 classifyDownloadError 六类，stderr 关键词 → 错误码）：
 * network_unavailable / login_required / region_or_copyright_restricted /
 * yt_dlp_update_recommended / disk_full / download_failed。
 */
function classifyDownloadError(stderr) {
  const text = String(stderr || '')
  const tail = text.length > 2000 ? text.slice(-2000) : text
  const lower = text.toLowerCase()
  if (/timeout|timed out|unreachable|connection refused|getaddrinfo|temporary failure in name resolution/i.test(text)) {
    return { code: 'network_unavailable', stderrTail: tail }
  }
  if (/sign in to confirm|login required|log in to|cookies/i.test(text)) {
    return { code: 'login_required', stderrTail: tail }
  }
  if (/copyright|geo-?restrict|not available in your country/i.test(text)) {
    return { code: 'region_or_copyright_restricted', stderrTail: tail }
  }
  if (/please update|nsig extraction failed|unable to extract|extractor error/i.test(lower)) {
    return { code: 'yt_dlp_update_recommended', stderrTail: tail }
  }
  if (/no space left on device|disk full/i.test(text)) {
    return { code: 'disk_full', stderrTail: tail }
  }
  return { code: 'download_failed', stderrTail: tail }
}

/** 错误码 → 中文文案（对照 VideoDownloadWorkspace formatDownloadError 逐字） */
const DOWNLOAD_ERROR_TEXT = {
  unsupported_source: '当前仅支持 YouTube 和 Bilibili 公公开视频',
  download_probe_stale: '链接已变化，请重新解析后再下载',
  login_required: '该视频需要登录后访问，当前无法下载',
  region_or_copyright_restricted: '该视频受地区或版权限制，当前无法下载',
  disk_full: '磁盘空间不足，无法保存下载文件',
  download_playback_conversion_failed: '视频兼容格式转换失败，请重新下载或选择其他清晰度',
  network_unavailable: '无法连接视频平台，请检查网络或代理设置后重试',
  yt_dlp_update_recommended: '视频平台规则可能已变化，请更新 yt-dlp 后重试',
  download_failed: '下载失败，请检查网络后重试',
}

function downloadErrorText(code, fallback) {
  return DOWNLOAD_ERROR_TEXT[code] || fallback || DOWNLOAD_ERROR_TEXT.download_failed
}

/**
 * 播放兼容判定（对照 normalizeVideoForPlayback ffprobe 口径）：
 * vcodec ∈ {h264, avc1*, avc3*} 且 pix_fmt ∈ {yuv420p, yuvj420p} 且（无音轨或 aac/mp4a*）。
 * @param info ffmpeg-gate probe 结果 { streams: [...] }
 */
function isPlaybackCompatible(info) {
  const streams = Array.isArray(info?.streams) ? info.streams : []
  const video = streams.find((s) => String(s.codec_type || '') === 'video')
  if (!video) return false
  const vcodec = String(video.codec_name || '')
  const codecOk = vcodec === 'h264' || vcodec.startsWith('avc1') || vcodec.startsWith('avc3')
  const pixOk = ['yuv420p', 'yuvj420p'].includes(String(video.pix_fmt || ''))
  const audio = streams.find((s) => String(s.codec_type || '') === 'audio')
  const audioOk = !audio || ['aac', 'mp4a'].some((k) => String(audio.codec_name || '').startsWith(k))
  return codecOk && pixOk && audioOk
}

/**
 * 归一化转码参数（对照 normalizeVideoForPlayback）：
 * 已是 h264+yuv420p → 流复制（仅容器级修复）；否则 libx264 crf20 fast + yuv420p + avc1 tag + faststart。
 */
function buildNormalizeArgs(src, dst, info) {
  const streams = Array.isArray(info?.streams) ? info.streams : []
  const video = streams.find((s) => String(s.codec_type || '') === 'video')
  const pixOk = ['yuv420p', 'yuvj420p'].includes(String(video?.pix_fmt || ''))
  const args = ['-y']
  if (String(video?.codec_name || '') === 'h264' && pixOk) {
    args.push('-c:v', 'copy')
  } else {
    args.push('-c:v', 'libx264', '-crf', '20', '-preset', 'fast', '-pix_fmt', 'yuv420p', '-tag:v', 'avc1')
  }
  const audio = streams.find((s) => String(s.codec_type || '') === 'audio')
  if (!audio) {
    // 无音轨：不加音频参数
  } else if (String(audio.codec_name || '').startsWith('aac') || String(audio.codec_name || '').startsWith('mp4a')) {
    args.push('-c:a', 'copy')
  } else {
    args.push('-c:a', 'aac', '-b:a', '192k')
  }
  args.push('-movflags', '+faststart', src, dst)
  return args
}

/** 输出文件名模板（对照 -o OpenCreator-%(title).120B-%(id)s.%(ext)s → 本端前缀） */
function outTemplateFor(dir) {
  return require('node:path').join(dir, 'TinTin-%(title).120B-%(id)s.%(ext)s')
}

module.exports = {
  isSupportedUrl,
  platformFor,
  platformFromUrl,
  buildProbeArgs,
  buildVideoDownloadArgs,
  buildAudioDownloadArgs,
  parseProgressLine,
  parseProbeJson,
  createDownloadOptions,
  classifyDownloadError,
  downloadErrorText,
  isPlaybackCompatible,
  buildNormalizeArgs,
  outTemplateFor,
  formatBytes,
}
