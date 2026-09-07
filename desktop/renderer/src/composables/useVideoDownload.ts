import { ref } from 'vue'
// ── 参考视频下载（OpenCreator download 架构移植，2026-09-07）──
// 渲染层只做状态与事件转发；白名单/档位/进度解析/错误分类全在主进程
// ytdlp-logic.js 纯函数层（策略）+ ytdlp-gate.js（I/O）。
// 错误文案逐字对照 OpenCreator VideoDownloadWorkspace formatDownloadError。

export interface YtdlpOption {
  id: string
  mediaType: 'video' | 'audio'
  label: string
  detail: string
  videoFormatId?: string
  audioFormatId?: string
  kbps?: number
  estimatedSize?: number
}

export interface YtdlpProbeInfo {
  id: string
  title: string
  uploader: string
  duration: number
  thumbnail: string
  extractorKey: string
  platform: 'bilibili' | 'youtube'
  webpageUrl: string
  resolution: string
}

export interface DownloadItem {
  key: string
  url: string
  title: string
  optionId: string
  optionLabel: string
  mediaType: 'video' | 'audio'
  state: 'running' | 'done' | 'error'
  /** 阶段文案（对照 OpenCreator：正在合并音视频/正在提取 MP3 音频/正在转换为本机兼容格式） */
  phaseText: string
  pct: number
  path?: string
  fileName?: string
  error?: string
}

/** 阶段 → 文案（对照 OpenCreator 项目文件 tab 阶段描述逐字） */
function phaseTextOf(phase: string, mediaType: 'video' | 'audio'): string {
  if (phase === 'merge') return '正在合并音视频'
  if (phase === 'extract') return '正在提取 MP3 音频'
  if (phase === 'normalize') return '正在转换为本机兼容格式'
  return mediaType === 'audio' ? '正在下载音频' : '正在下载视频'
}

function formatDuration(sec: number): string {
  const s = Math.round(Number(sec) || 0)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = s % 60
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`
    : `${m}:${String(r).padStart(2, '0')}`
}

export function useVideoDownload() {
  const url = ref('')
  const probing = ref(false)
  const probeError = ref('')
  const probe = ref<YtdlpProbeInfo | null>(null)
  const options = ref<YtdlpOption[]>([])
  const mediaType = ref<'video' | 'audio'>('video')
  const downloads = ref<DownloadItem[]>([])
  let seq = 0

  /** 解析链接（probe） */
  async function analyze(): Promise<void> {
    if (probing.value || downloads.value.some((d) => d.state === 'running')) return
    const target = url.value.trim()
    if (!target) { probeError.value = '请输入有效的 YouTube 或 Bilibili 公公开视频链接'; return }
    probing.value = true
    probeError.value = ''
    probe.value = null
    options.value = []
    try {
      const res = await window.tintin.ytdlp.probe({ url: target })
      if (res.error || !res.probe) {
        probeError.value = res.error || '解析失败，请稍后重试'
        return
      }
      probe.value = res.probe
      options.value = res.options || []
    } catch (e) {
      probeError.value = e instanceof Error ? e.message : String(e)
    } finally {
      probing.value = false
    }
  }

  /** 更换链接：清结果回 Step0 */
  function resetProbe(): void {
    probe.value = null
    options.value = []
    probeError.value = ''
  }

  /** 下载指定档位（同档位去重：同 URL 同 option 运行中/已完成不重复提交） */
  async function download(option: YtdlpOption): Promise<void> {
    const target = probe.value?.webpageUrl || url.value.trim()
    if (!target || !probe.value) return
    if (downloads.value.some((d) => d.url === target && d.optionId === option.id && d.state !== 'error')) return
    if (downloads.value.some((d) => d.state === 'running')) return
    const item: DownloadItem = {
      key: `dl_${++seq}`,
      url: target,
      title: probe.value.title,
      optionId: option.id,
      optionLabel: option.label,
      mediaType: option.mediaType,
      state: 'running',
      phaseText: phaseTextOf('download', option.mediaType),
      pct: 2,
    }
    downloads.value.push(item)
    const off = window.tintin.ytdlp.onProgress((p) => {
      item.pct = Math.max(0, Math.min(100, Math.round(p.pct)))
      item.phaseText = p.phase === 'done' ? '已完成' : phaseTextOf(p.phase, option.mediaType)
    })
    try {
      const res = await window.tintin.ytdlp.download({ url: target, option })
      if (res.error || !res.path) {
        item.state = 'error'
        item.error = res.error || '下载失败，请重试'
      } else {
        item.state = 'done'
        item.pct = 100
        item.phaseText = '已完成'
        item.path = res.path
        item.fileName = res.fileName || ''
      }
    } catch (e) {
      item.state = 'error'
      item.error = e instanceof Error ? e.message : String(e)
    } finally {
      off()
    }
  }

  /** 保存到本机（saveFile 对话框 + 主进程复制，替代 OpenCreator 的 blob 通道） */
  async function saveToLocal(item: DownloadItem): Promise<void> {
    if (!item.path) return
    const dst = await window.tintin.dialog.saveFile({
      title: '保存到本机',
      defaultPath: item.fileName || 'video.mp4',
      filters: [{ name: '视频/音频', extensions: ['mp4', 'mp3', 'm4a', 'webm'] }],
    })
    if (!dst) return
    const res = await window.tintin.ytdlp.saveAs({ src: item.path, dst })
    if (res.error) item.error = res.error
  }

  return {
    url, probing, probeError, probe, options, mediaType, downloads,
    analyze, resetProbe, download, saveToLocal, formatDuration,
  }
}
