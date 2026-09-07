// ytdlp-logic 纯函数层单测（对照 OpenCreator download/probe-parser + executor 口径）
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  isSupportedUrl, platformFor, platformFromUrl, buildProbeArgs, buildVideoDownloadArgs,
  buildAudioDownloadArgs, parseProgressLine, parseProbeJson,
  createDownloadOptions, classifyDownloadError, downloadErrorText,
  isPlaybackCompatible, buildNormalizeArgs, formatBytes,
} from '../main/ytdlp-logic.js'

test('isSupportedUrl 白名单（https + YouTube/Bilibili 域）', () => {
  assert.equal(isSupportedUrl('https://www.youtube.com/watch?v=x'), true)
  assert.equal(isSupportedUrl('https://youtu.be/x'), true)
  assert.equal(isSupportedUrl('https://m.youtube.com/watch?v=x'), true)
  assert.equal(isSupportedUrl('https://www.bilibili.com/video/BV1'), true)
  assert.equal(isSupportedUrl('https://b23.tv/abc'), true)
  assert.equal(isSupportedUrl('http://www.youtube.com/watch?v=x'), false)
  assert.equal(isSupportedUrl('https://evil.com/youtube.com'), false)
  assert.equal(isSupportedUrl('https://notyoutube.com/watch'), false)
  assert.equal(isSupportedUrl('https://'), false)
  assert.equal(isSupportedUrl(''), false)
})

test('platformFor：extractor_key 含 bilibili 判 B 站，否则 youtube', () => {
  assert.equal(platformFor('Bilibili'), 'bilibili')
  assert.equal(platformFor('Youtube'), 'youtube')
  assert.equal(platformFor(''), 'youtube')
})

test('platformFromUrl：URL→平台判定（cookies 导出用）', () => {
  assert.equal(platformFromUrl('https://www.bilibili.com/video/BV1'), 'bilibili')
  assert.equal(platformFromUrl('https://b23.tv/abc'), 'bilibili')
  assert.equal(platformFromUrl('https://www.youtube.com/watch?v=x'), 'youtube')
  assert.equal(platformFromUrl('https://youtu.be/x'), 'youtube')
  assert.equal(platformFromUrl('https://example.com/v'), '')
  assert.equal(platformFromUrl('not-a-url'), '')
})

test('buildProbeArgs / 视频 / 音频参数集', () => {
  assert.deepEqual(buildProbeArgs('https://a', ''), ['--dump-single-json', '--no-playlist', 'https://a'])
  assert.deepEqual(buildProbeArgs('https://a', 'http://p:1'), ['--dump-single-json', '--no-playlist', '--proxy', 'http://p:1', 'https://a'])
  const v = buildVideoDownloadArgs({ url: 'https://a', formatId: '137', audioFormatId: '140', outTemplate: 'o/%(title)s.%(ext)s', ffmpegDir: 'ff', proxy: '' })
  assert.ok(v.includes('-f') && v.includes('137+140'))
  assert.ok(v.includes('--merge-output-format') && v.includes('mp4') && v.includes('--remux-video'))
  assert.ok(v.includes('--ffmpeg-location') && v.includes('ff'))
  const a = buildAudioDownloadArgs({ url: 'https://a', formatId: '140', kbps: 192, outTemplate: 'o', ffmpegDir: '', proxy: 'http://p:1' })
  assert.deepEqual(a.slice(a.indexOf('--extract-audio'), a.indexOf('--extract-audio') + 5), ['--extract-audio', '--audio-format', 'mp3', '--audio-quality', '192K'])
  assert.ok(a.includes('--proxy'))
})

test('parseProgressLine：download 百分比 / Merger / ExtractAudio', () => {
  assert.deepEqual(parseProgressLine('[download]   42.3% of 10.00MiB at 1.00MiB/s'), { phase: 'download', pct: 42.3 })
  assert.deepEqual(parseProgressLine('[Merger] Merging formats into "x.mp4"'), { phase: 'merge', pct: 96 })
  assert.deepEqual(parseProgressLine('[VideoRemuxer] Remuxing'), { phase: 'merge', pct: 96 })
  assert.deepEqual(parseProgressLine('[ExtractAudio] Destination: x.mp3'), { phase: 'extract', pct: 96 })
  assert.equal(parseProgressLine('[info] xxx'), null)
})

test('parseProbeJson 宽容解析 + 平台判定', () => {
  const probe = parseProbeJson({
    id: 'x', title: 'T', duration: 60.5, thumbnail: 'http://t', extractor_key: 'Bilibili',
    formats: [
      { format_id: '1', ext: 'mp4', vcodec: 'h264', acodec: 'mp4a.40.2', width: 1920, height: 1080, fps: 30, filesize: 1000, tbr: 2000 },
      { format_id: '2', ext: 'mp4', vcodec: 'h264', acodec: 'none', width: 1920, height: 1080, fps: 30, tbr: 4000 },
      { format_id: '3', ext: 'm4a', vcodec: 'none', acodec: 'mp4a.40.2', abr: 128 },
    ],
  })
  assert.equal(probe.platform, 'bilibili')
  assert.equal(probe.formats.length, 3)
  assert.equal(probe.duration, 60.5)
  const empty = parseProbeJson(null)
  assert.equal(empty.formats.length, 0)
})

test('createDownloadOptions：视频档按宽x高去重 + MP3 三档', () => {
  const probe = parseProbeJson({
    duration: 100,
    formats: [
      { format_id: 'l', ext: 'mp4', vcodec: 'h264', acodec: 'none', width: 1920, height: 1080, tbr: 4000 },
      { format_id: 's', ext: 'mp4', vcodec: 'h264', acodec: 'none', width: 1280, height: 720, tbr: 2000 },
      { format_id: 's2', ext: 'webm', vcodec: 'vp9', acodec: 'none', width: 1280, height: 720, tbr: 2500 },
      { format_id: 'a', ext: 'm4a', vcodec: 'none', acodec: 'mp4a.40.2', abr: 128 },
    ],
  })
  const opts = createDownloadOptions(probe)
  const videoOpts = opts.filter((o) => o.mediaType === 'video')
  assert.equal(videoOpts.length, 2)
  assert.equal(videoOpts[0].label, '原始画质')
  assert.equal(videoOpts[1].label, '720p')
  assert.equal(videoOpts[0].audioFormatId, 'a') // 无音轨档自动搭配最佳纯音轨
  const audioOpts = opts.filter((o) => o.mediaType === 'audio')
  assert.deepEqual(audioOpts.map((o) => o.id), ['audio-mp3-320', 'audio-mp3-192', 'audio-mp3-128'])
  assert.equal(audioOpts[0].estimatedSize, 100 * 320 * 1000 / 8)
})

test('classifyDownloadError 六类 + 文案映射', () => {
  assert.equal(classifyDownloadError('Connection refused by peer').code, 'network_unavailable')
  assert.equal(classifyDownloadError('Please sign in to confirm your age').code, 'login_required')
  assert.equal(classifyDownloadError('This video is geo-restricted').code, 'region_or_copyright_restricted')
  assert.equal(classifyDownloadError('nsig extraction failed').code, 'yt_dlp_update_recommended')
  assert.equal(classifyDownloadError('No space left on device').code, 'disk_full')
  assert.equal(classifyDownloadError('whatever else').code, 'download_failed')
  assert.equal(downloadErrorText('login_required'), '该视频需要登录后访问，当前无法下载')
  assert.equal(downloadErrorText('unknown_code', '兜底'), '兜底')
})

test('isPlaybackCompatible / buildNormalizeArgs（h264+yuv420p 走 copy）', () => {
  const ok = { streams: [
    { codec_type: 'video', codec_name: 'h264', pix_fmt: 'yuv420p' },
    { codec_type: 'audio', codec_name: 'aac' },
  ] }
  assert.equal(isPlaybackCompatible(ok), true)
  const vp9 = { streams: [{ codec_type: 'video', codec_name: 'vp9', pix_fmt: 'yuv420p' }] }
  assert.equal(isPlaybackCompatible(vp9), false)
  const copy = buildNormalizeArgs('in.mp4', 'out.mp4', ok)
  assert.deepEqual(copy, ['-y', '-c:v', 'copy', '-c:a', 'copy', '-movflags', '+faststart', 'in.mp4', 'out.mp4'])
  const trans = buildNormalizeArgs('in.mp4', 'out.mp4', vp9)
  assert.ok(trans.includes('libx264') && trans.includes('yuv420p') && trans.includes('avc1'))
})

test('formatBytes', () => {
  assert.equal(formatBytes(0), '')
  assert.equal(formatBytes(512), '512 B')
  assert.equal(formatBytes(2048), '2.0 KB')
})
