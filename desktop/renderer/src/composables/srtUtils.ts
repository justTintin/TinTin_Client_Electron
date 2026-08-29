// ═══════════════════════════════════════════════════════════════
// srtUtils — SRT 字幕解析/生成/格式转换/编辑回写（纯函数，无 vue/IPC 依赖）
// 业务对齐 M2（条目③ 视频转文字）：对照原客户端 studio/utils/srt_utils.py 与
// studio/gui/transcription_page.py：
//   · parse_srt / segments_to_srt      → srt_utils.py L46-97
//   · _convert_format (srt/vtt/txt/plain) → transcription_page.py L973-999
//   · _plain_to_srt + _split_text_into_chunks（润色回写保留时间轴）→ L35-49 / L678-693
//   · _apply_edits（未改段保留 words、改动段打 edited 标记）→ L853-887
//   · /v1/audio/transcriptions 响应防御解析（openapi 响应 schema 未定型，
//     兼容 segments / result.segments / text / 裸文本多形态，对照原 asr_client L225-240）
// ═══════════════════════════════════════════════════════════════

/** 字幕段（words 为字级时间戳，可选） */
export interface SrtSegment {
  start: number
  end: number
  text: string
  speaker?: string
  words?: Array<{ word: string; start: number; end: number }>
  edited?: boolean
}

/** 支持的媒体扩展名（对照 transcription_page.py SUPPORTED_EXTS L59-62） */
export const SUPPORTED_EXTS = new Set([
  '.mp4', '.mov', '.avi', '.mkv', '.flv', '.webm', '.m4v',
  '.mp3', '.wav', '.m4a', '.flac', '.aac', '.ogg', '.wma',
])

/** 秒 → SRT 时间戳 HH:MM:SS,mmm（对照 srt_utils.format_srt_timestamp L49-63） */
export function formatSrtTimestamp(sec: number): string {
  let s = Math.floor(sec)
  let ms = Math.round((sec - Math.floor(sec)) * 1000)
  if (ms >= 1000) { ms = 0; s += 1 }
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = s % 60
  const p2 = (n: number) => String(n).padStart(2, '0')
  const p3 = (n: number) => String(n).padStart(3, '0')
  return `${p2(h)}:${p2(m)}:${p2(r)},${p3(ms)}`
}

/** 秒 → WebVTT 时间戳 HH:MM:SS.mmm（对照 srt_utils.format_vtt_timestamp L66-80） */
export function formatVttTimestamp(sec: number): string {
  return formatSrtTimestamp(sec).replace(',', '.')
}

/** SRT/VTT 时间戳 → 秒（对照 srt_utils.parse_srt_time L35-43） */
export function parseSrtTime(t: string): number {
  const norm = t.trim().replace('.', ',')
  const m = norm.match(/^(\d{1,2}):(\d{2}):(\d{2}),(\d{1,3})$/)
  if (!m) return 0
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4].slice(0, 3)) / 1000
}

const TIME_RE = /(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})/

/**
 * 逐行解析字幕文本 → segments（对照 srt_utils.parse_srt L46-78）。
 * 序号行忽略；正文跨行合并；按 start 排序；过滤空正文段。
 */
export function parseSrt(text: string): SrtSegment[] {
  const segments: SrtSegment[] = []
  let cur: SrtSegment | null = null
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    const m = TIME_RE.exec(line)
    if (m) {
      if (cur) segments.push(cur)
      cur = { start: parseSrtTime(m[1]), end: parseSrtTime(m[2]), text: '', words: [] }
      continue
    }
    if (/^\d+$/.test(line)) continue
    if (cur) cur.text = `${cur.text} ${line}`.trim()
  }
  if (cur) segments.push(cur)
  return segments
    .filter((s) => s.text)
    .sort((a, b) => a.start - b.start)
}

/**
 * segments → SRT 文本（对照 srt_utils.segments_to_srt L81-97）。
 * speaker 存在时正文加 `[speaker]: ` 前缀。
 */
export function segmentsToSrt(segments: SrtSegment[]): string {
  if (!segments || !segments.length) return ''
  const lines: string[] = []
  segments.forEach((seg, i) => {
    const text = String(seg.text || '').trim().replace(/\n/g, ' ')
    const body = seg.speaker ? `[${seg.speaker}]: ${text}` : text
    lines.push(String(i + 1))
    lines.push(`${formatSrtTimestamp(seg.start)} --> ${formatSrtTimestamp(seg.end)}`)
    lines.push(body)
    lines.push('')
  })
  return lines.join('\n').replace(/\n$/, '')
}

/** SRT 文本 → 纯文本（无时间戳，逐段一行；对照原 _convert_format 'plain'） */
export function srtToPlainText(srtText: string): string {
  return convertSrtFormat(srtText, 'plain')
}

/**
 * SRT → 指定格式（对照 transcription_page._convert_format L973-999）。
 * fmt: srt（原样）/ vtt（WEBVTT 头 + . 毫秒）/ txt（[起始时间] 正文）/ plain（仅正文）
 */
export function convertSrtFormat(srtText: string, fmt: 'srt' | 'vtt' | 'txt' | 'plain'): string {
  if (fmt === 'srt') return srtText
  const lines: string[] = []
  for (const raw of String(srtText || '').split(/\r?\n\r?\n/)) {
    const seg = raw.trim()
    if (!seg) continue
    const parts = seg.split(/\r?\n/)
    if (parts.length < 3) continue
    const idx = parts[0]
    const timeLine = parts[1]
    const text = parts[2]
    if (fmt === 'vtt') {
      lines.push(idx)
      // 原版 Python str.replace 全量替换；JS 需 /,/g（两个时间戳的逗号都要换成点）
      lines.push(timeLine.replace(/,/g, '.'))
      lines.push(text)
      lines.push('')
    } else if (fmt === 'txt') {
      const start = timeLine.split('-->')[0].trim()
      lines.push(`[${start}] ${text}`)
    } else if (fmt === 'plain') {
      lines.push(text)
    }
  }
  if (fmt === 'vtt') return 'WEBVTT\n\n' + lines.join('\n')
  return lines.join('\n')
}

/**
 * 纯文本按句大致均分切 n 段（对照 transcription_page._split_text_into_chunks L35-49）。
 * round-robin 累加：第 i 句进 chunks[i % n]。
 */
export function splitTextIntoChunks(text: string, n: number): string[] {
  const t = (text || '').trim()
  if (!t || n <= 1) return t ? [t] : []
  const parts = t.split(/[\n。！？]+/).filter((p) => p.trim())
  if (parts.length <= n) return [...parts, ...Array(n - parts.length).fill('')]
  const chunks: string[] = Array(n).fill('')
  let idx = 0
  for (const p of parts) {
    // 对照原 L47：chunk 非空时追加「句子+。」（不加句间分隔符，只补尾句号）
    chunks[idx % n] = chunks[idx % n] ? chunks[idx % n] + p + '。' : p
    idx++
  }
  return chunks
}

/**
 * 润色回写：整段纯文本写进原 SRT，保留时间轴，文案按段均分
 * （对照 transcription_page._plain_to_srt L678-693）。
 * 原 SRT 无可用时间轴 → 原样返回。
 */
export function plainToSrt(plainText: string, oldSrt: string): string {
  const blocks = String(oldSrt || '').split(/\r?\n\r?\n/).filter((b) => b.trim())
  const times: string[] = []
  for (const b of blocks) {
    const ls = b.split(/\r?\n/)
    if (ls.length >= 2 && ls[1].includes('-->')) times.push(ls[1])
  }
  if (!times.length) return oldSrt
  const chunks = splitTextIntoChunks(plainText, times.length)
  const out: string[] = []
  for (let i = 0; i < times.length; i++) {
    const text = i < chunks.length ? chunks[i] : ''
    out.push(`${i + 1}\n${times[i]}\n${text}`)
  }
  return out.join('\n\n')
}

/**
 * 编辑回写（对照 transcription_page._apply_edits L853-887）：
 * - 解析编辑文本失败（无任何段）→ null（不生效）
 * - 首次编辑时快照 curSegments 作为"是否修改"对比基准（origSegments）
 * - 与当前段完全一致（文本+±0.01s）→ 保留字级 words
 * - 与基准不一致（时间/文本）或新增段 → edited=true
 *
 * @returns { segments, origSegments } 或 null
 */
export function applyEditsToSegments(
  editedText: string,
  curSegments: SrtSegment[],
  origSegments: SrtSegment[] | null,
): { segments: SrtSegment[]; origSegments: SrtSegment[] } | null {
  const newSegments = parseSrt(editedText)
  if (!newSegments.length) return null
  const cur = curSegments || []
  // 首次编辑：快照原始转写结果作为修改标记对比基准
  const orig: SrtSegment[] = origSegments
    ? origSegments
    : cur.map((s) => ({ start: s.start, end: s.end, text: String(s.text || '').trim() }))
  const near = (a: number, b: number) => Math.abs(a - b) <= 0.01
  for (let i = 0; i < newSegments.length; i++) {
    const seg = newSegments[i]
    // 与当前段完全一致 → 保留字级时间戳（逐字点击/高亮能力不丢失）
    if (i < cur.length) {
      const c = cur[i]
      if (seg.text === String(c.text || '').trim() && near(seg.start, c.start) && near(seg.end, c.end)) {
        seg.words = c.words || []
      }
    }
    // 与原始基准对比 → 是否标记已修改
    seg.edited = i >= orig.length
      ? true
      : !near(seg.start, orig[i].start) || !near(seg.end, orig[i].end) || seg.text !== orig[i].text
  }
  return { segments: newSegments, origSegments: orig }
}

/** 转写完成后的预览文本：取第一段正文前 50 字（对照 _on_file_done L1113-1122） */
export function buildSrtPreview(srtText: string): string {
  for (const raw of String(srtText || '').split(/\r?\n\r?\n/)) {
    const seg = raw.trim()
    if (!seg) continue
    const parts = seg.split(/\r?\n/)
    if (parts.length >= 3) return parts[2].slice(0, 50)
  }
  return ''
}

/**
 * /v1/audio/transcriptions 响应防御解析 → segments。
 * openapi 该接口 200 响应 schema 未定型（{}），按 OpenAI 兼容惯例兼容多形态：
 *   1. { segments: [...] } / { result: { segments } }（verbose_json / 原嵌套，对照 asr_client L233）
 *   2. { text } 无 segments → 单段兜底（对照 asr_client L235-237）
 *   3. 裸字符串（response_format=text）→ 单段
 * 解析不出任何内容 → []。
 */
export function parseTranscriptionResponse(data: unknown): SrtSegment[] {
  const norm = (arr: unknown[]): SrtSegment[] =>
    (arr || [])
      .filter((s): s is Record<string, unknown> => !!s && typeof s === 'object')
      .map((s) => ({
        start: Number(s.start ?? 0) || 0,
        end: Number(s.end ?? 0) || 0,
        text: String(s.text ?? '').trim(),
        ...(Array.isArray(s.words) ? { words: s.words as SrtSegment['words'] } : {}),
        ...(s.speaker ? { speaker: String(s.speaker) } : {}),
      }))
      .filter((s) => s.text)

  if (typeof data === 'string') {
    const t = data.trim()
    return t ? [{ start: 0, end: 0, text: t }] : []
  }
  if (!data || typeof data !== 'object') return []
  const obj = data as Record<string, any>
  if (Array.isArray(obj.segments)) return norm(obj.segments)
  if (obj.result && typeof obj.result === 'object' && Array.isArray(obj.result.segments)) {
    return norm(obj.result.segments)
  }
  if (obj.text && typeof obj.text === 'string' && obj.text.trim()) {
    return [{ start: 0, end: 0, text: obj.text.trim() }]
  }
  return []
}

/** segments → 纯文本（无时间戳；对照 asr_client.segments_to_plain L101-111：逐段一行，speaker 加前缀） */
export function segmentsToPlainText(segments: SrtSegment[]): string {
  return (segments || [])
    .map((s) => {
      const text = String(s.text || '').trim()
      return s.speaker ? `[${s.speaker}]: ${text}` : text
    })
    .filter(Boolean)
    .join('\n')
    .trim()
}
