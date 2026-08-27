// ═══════════════════════════════════════════════════════════════
// media-sniff-utils.js — 媒体嗅探辅助（从 thickShell-ipc.js 原样拆出，无逻辑改动）
//   _formatBytes / ALLOWED_PROTOCOLS / _isAudioUrl / _sniffMediaFromHeaders
// ═══════════════════════════════════════════════════════════════

const path = require('node:path')
const { URL } = require('node:url')

// ── 媒体嗅探辅助 ──
function _formatBytes(bytes, decimals = 2) {
  if (!bytes) return '0 B'
  if (bytes === 0) return '0 Bytes'
  const k = 1024
  const dm = decimals < 0 ? 0 : decimals
  const sizes = ['Bytes', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i]
}

const ALLOWED_PROTOCOLS = ['http:', 'https:', 'file:', 'ws:', 'wss:', 'data:', 'blob:', 'about:', 'chrome-extension:', 'devtools:']

function _isAudioUrl(urlStr) {
  const lower = urlStr.toLowerCase()
  return lower.includes('.mp3') || lower.includes('mime=audio') || lower.includes('media-audio') ||
    lower.includes('-30216') || lower.includes('-30232') || lower.includes('-30280') ||
    lower.includes('-30250') || lower.includes('audio')
}

function _sniffMediaFromHeaders(responseHeaders, url) {
  const contentTypeKey = Object.keys(responseHeaders || {}).find(k => k.toLowerCase() === 'content-type')
  const contentType = contentTypeKey ? responseHeaders[contentTypeKey][0] : ''

  let isMedia = false
  let mediaType = ''

  if (contentType) {
    const ct = contentType.toLowerCase()
    if (ct.startsWith('video/') || ct.startsWith('audio/')) {
      isMedia = true
      mediaType = ct.startsWith('audio/') ? 'audio' : 'video'
      if (mediaType === 'video' && _isAudioUrl(url)) mediaType = 'audio'
    } else if (ct.includes('application/vnd.apple.mpegurl') || ct.includes('application/x-mpegurl') || ct.includes('application/octet-stream')) {
      const lowerUrl = url.toLowerCase()
      if (lowerUrl.includes('.m3u8') || lowerUrl.includes('.ts') || lowerUrl.includes('.mp4') || lowerUrl.includes('.mp3') || lowerUrl.includes('.m4s') || lowerUrl.includes('videoplayback')) {
        isMedia = true
        mediaType = _isAudioUrl(url) ? 'audio' : 'video'
      }
    }
  }

  if (!isMedia) {
    const lowerUrl = url.toLowerCase()
    if (lowerUrl.includes('.mp4') || lowerUrl.includes('.m3u8') || lowerUrl.includes('.mp3') || lowerUrl.includes('.webm') || lowerUrl.includes('.m4s') || lowerUrl.includes('.flv') || lowerUrl.includes('videoplayback')) {
      isMedia = true
      mediaType = _isAudioUrl(url) ? 'audio' : 'video'
    }
  }

  if (!isMedia || url.includes('127.0.0.1') || url.includes('localhost') || url.startsWith('file:')) {
    return null
  }

  let filename = '媒体素材'
  try {
    const parsed = new URL(url)
    filename = path.basename(parsed.pathname) || '媒体素材'
  } catch (_) {}
  filename = filename.split('?')[0]

  if (url.includes('videoplayback')) {
    filename = 'youtube_video_' + Math.random().toString(36).substring(2, 7)
  } else if (url.includes('video/tos') || url.includes('video_')) {
    filename = 'douyin_video_' + Math.random().toString(36).substring(2, 7)
  }

  const fileExt = mediaType === 'audio' ? '.mp3' : '.mp4'
  if (!filename.includes('.')) filename += fileExt

  let totalSize = 0
  const crKey = Object.keys(responseHeaders || {}).find(k => k.toLowerCase() === 'content-range')
  if (crKey && responseHeaders[crKey][0]) {
    const m = responseHeaders[crKey][0].match(/\/(\d+)$/)
    if (m) totalSize = parseInt(m[1], 10)
  }
  if (!totalSize) {
    const clKey = Object.keys(responseHeaders || {}).find(k => k.toLowerCase() === 'content-length')
    if (clKey && responseHeaders[clKey][0]) totalSize = parseInt(responseHeaders[clKey][0], 10)
  }

  return {
    url,
    type: mediaType,
    name: filename,
    size: totalSize,
    sizeText: totalSize > 0 ? _formatBytes(totalSize) : '网络流自动嗅探',
  }
}

module.exports = { _formatBytes, ALLOWED_PROTOCOLS, _isAudioUrl, _sniffMediaFromHeaders }
