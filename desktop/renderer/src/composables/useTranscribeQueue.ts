// ═══════════════════════════════════════════════════════════════
// useTranscribeQueue — 视频转文字·批量队列状态机（条目③ 业务层）
// 对照原客户端 studio/gui/transcription_page.py：
//   · _add_paths/_add_files L509-545（去重、过滤支持类型、多选）
//   · _start_batch L1006-1038 / _process_next L1039-1106（逐文件排队、
//     任务进行中明确提示不静默吞点击、pending=等待+失败）
//   · _on_file_done L1108-1128（SRT 生成 + 预览首段前 50 字 + 状态）
//   · _on_file_error L1134-1148（行级失败 + 继续下一个）
//   · _retry_transcribe L763-770（重置为待处理、清 orig 基准）
//   · _remove_file L710-720（移除；编辑中先退出编辑态）
//   · _enter/_exit_edit_mode L796-839 + _apply_edits L854-888（编辑回写）
//   · _show_rewrite_dialog L588-676（洗稿：原文 plain → LLM → plain_to_srt 回写）
//   · _show_save_dialog L915-973 + _convert_format L975-1000（四格式导出）
// 纯逻辑在 srtUtils.ts / voiceCloneLogic.ts（parser/builder 层），本文件仅编排（runner 层）
// ═══════════════════════════════════════════════════════════════

import { ref, computed } from 'vue'
import {
  SUPPORTED_EXTS,
  parseTranscriptionResponse,
  segmentsToSrt,
  buildSrtPreview,
  applyEditsToSegments,
  convertSrtFormat,
  plainToSrt,
  parseSrt,
  type SrtSegment,
} from './srtUtils'
import { buildRewriteMessages, extractLlmContent } from './voiceCloneLogic'

/** 队列行状态（对照原行状态色 _apply_row_color L695-709） */
export type QueueStatus = 'wait' | 'running' | 'done' | 'failed'

export interface QueueItem {
  path: string
  name: string
  sizeMb: number
  status: QueueStatus
  srtText: string
  segments: SrtSegment[]
  preview: string
  error: string
  /** 首次编辑时快照的原始转写基准（对照 orig_segments） */
  origSegments: SrtSegment[] | null
}

export const STATUS_TEXT: Record<QueueStatus, string> = {
  wait: '等待处理',
  running: '处理中',
  done: '完成',
  failed: '失败',
}

function notify(title: string, body: string): void {
  try { window.tintin?.shell?.showNotification?.(title, body) } catch (_) {}
}

export function useTranscribeQueue() {
  const files = ref<QueueItem[]>([])
  const lang = ref('')                 // 语言（原 lang_input 文本框，空=自动）
  const busy = ref(false)
  const stageText = ref('')
  const uploadPercent = ref(0)
  const selectedIndex = ref(-1)
  const editMode = ref(false)
  const editedText = ref('')

  const selected = computed(() =>
    selectedIndex.value >= 0 && selectedIndex.value < files.value.length
      ? files.value[selectedIndex.value]
      : null,
  )

  // ── 文件管理（对照 _add_paths L509-545）──
  function addPaths(paths: string[]): void {
    for (const p of paths || []) {
      const ext = (p.split('.').pop() || '').toLowerCase()
      if (!SUPPORTED_EXTS.has(`.${ext}`)) continue
      if (files.value.some((f) => f.path === p)) continue
      files.value.push({
        path: p,
        name: p.split(/[\\/]/).pop() || p,
        sizeMb: 0, // 渲染层无 fs；尺寸列仅在拿到系统数据时展示，缺省空
        status: 'wait',
        srtText: '', segments: [], preview: '', error: '', origSegments: null,
      })
    }
  }

  async function pickFiles(): Promise<void> {
    // 原过滤器 _add_files L542：mp4 mov avi mkv mp3 wav m4a flac aac ogg
    const res = await window.tintin.dialog.openFiles({
      title: '选择文件',
      filters: [
        { name: 'Media Files', extensions: ['mp4', 'mov', 'avi', 'mkv', 'mp3', 'wav', 'm4a', 'flac', 'aac', 'ogg'] },
      ],
      multi: true,
    })
    if (res?.length) addPaths(res)
  }

  function onDrop(e: DragEvent): void {
    const fs = Array.from(e.dataTransfer?.files || [])
    const paths = fs.map((f) => (f as File & { path?: string }).path).filter(Boolean) as string[]
    if (paths.length) addPaths(paths)
  }

  function remove(idx: number): void {
    // 对照 _remove_file L710-720：编辑中该行先退出编辑态
    if (editMode.value && selectedIndex.value === idx) exitEdit(false)
    files.value.splice(idx, 1)
    if (selectedIndex.value >= files.value.length) selectedIndex.value = files.value.length - 1
  }

  /** 重新转写（对照 _retry_transcribe L763-770：重置状态、清 orig 基准） */
  function retry(idx: number): void {
    const f = files.value[idx]
    if (!f) return
    f.status = 'wait'
    f.origSegments = null
    stageText.value = `已重置为待处理: ${f.name}（点击「开始处理」重新转写）`
  }

  function select(idx: number): void {
    if (editMode.value) exitEdit(true)
    selectedIndex.value = idx
  }

  // ── 批量处理（对照 _start_batch L1006-1038 + _process_next 逐个排队）──
  async function startBatch(): Promise<void> {
    if (busy.value) {
      // 对照 L1007-1011：任务进行中明确告知，不静默吞掉点击
      notify('正在处理', `当前任务仍在处理中，请等待完成后再提交。\n当前状态：${stageText.value || '处理中'}`)
      return
    }
    const pending: number[] = []
    files.value.forEach((f, i) => {
      if (f.status === 'wait' || f.status === 'failed') pending.push(i)
    })
    if (!pending.length) {
      // 对照 L1024-1025：无待处理文件提示（行内「重新转写」承担原右键菜单入口）
      notify('无待处理文件', '没有待处理的文件。如需重新生成字幕，请对已完成文件点击「重新转写」。')
      return
    }
    busy.value = true
    uploadPercent.value = 0
    const language = lang.value.trim() || undefined
    for (const idx of pending) {
      const f = files.value[idx]
      if (!f) continue
      f.status = 'running'
      f.error = ''
      stageText.value = `正在处理: ${f.name}`
      try {
        // 本地文件走 multipart（{path} 包装 → 主进程按路径读文件；对照 vsr:remove 同款约定）
        const res = await window.tintin.server.asrTranscribe(
          {
            audio: { path: f.path } as unknown as Blob,
            language,
            word_timestamps: true,
          },
          (p: number) => { uploadPercent.value = Math.round(p) },
        )
        if (res && (res as any).error) throw new Error((res as any).error)
        const segments = parseTranscriptionResponse(res)
        if (!segments.length) throw new Error('未返回转写内容')
        f.segments = segments
        f.srtText = segmentsToSrt(segments)
        f.preview = buildSrtPreview(f.srtText)
        f.origSegments = null // 新结果成为修改标记新基准（对照 L1113）
        f.status = 'done'
      } catch (err) {
        f.status = 'failed'
        f.error = err instanceof Error ? err.message : String(err)
        notify('处理失败', `失败：${f.name}\n错误摘要：${f.error}`)
      }
      uploadPercent.value = 0
    }
    stageText.value = '完成：全部处理完成'
    // 对照 L1044-1051：默认展示第一个已完成文件
    const firstDone = files.value.findIndex((f) => f.status === 'done' && f.srtText)
    if (firstDone >= 0) selectedIndex.value = firstDone
    busy.value = false
  }

  // ── 字幕编辑（对照 _enter/_exit_edit_mode L796-839 + _apply_edits L854-888）──
  function enterEdit(): void {
    const f = selected.value
    if (!f) return
    if (!f.srtText) {
      stageText.value = '该文件还没有字幕，无法编辑'
      return
    }
    editedText.value = f.srtText
    editMode.value = true
  }

  /** 退出编辑并回写（对照 _exit_edit_mode → _apply_edits；解析失败不生效） */
  function exitEdit(refresh: boolean): void {
    const f = selected.value
    if (f && editMode.value) {
      const out = applyEditsToSegments(editedText.value, f.segments, f.origSegments)
      if (out) {
        f.segments = out.segments
        f.origSegments = out.origSegments
        f.srtText = segmentsToSrt(out.segments)
      }
    }
    editMode.value = false
    if (!refresh) return
    // 仍选中该行则立即重渲染（对照 L824-835）
    if (f) editedText.value = f.srtText
  }

  // ── 一键洗稿（对照 _show_rewrite_dialog L588-676）──
  async function rewriteSelected(hint: string): Promise<{ ok: boolean; content: string; error: string }> {
    const f = selected.value
    if (!f) return { ok: false, content: '', error: '未选择文件' }
    const original = convertSrtFormat(f.srtText, 'plain').trim()
    if (!original) return { ok: false, content: '', error: '该文件没有可洗稿的文案。' }
    const res = await window.tintin.server.llmChat({
      messages: buildRewriteMessages(hint, original),
      temperature: 0.7,
    })
    if (!res) return { ok: false, content: '', error: '服务端离线或未返回结果' }
    if ((res as any).error) return { ok: false, content: '', error: (res as any).error }
    const content = extractLlmContent(res).trim()
    if (!content) return { ok: false, content: '', error: '洗稿失败，请重试。' }
    return { ok: true, content, error: '' }
  }

  /** 应用洗稿结果（对照 _apply L662-671：plain_to_srt 回写时间轴 + 清 orig 基准） */
  function applyRewriteResult(newText: string): void {
    const f = selected.value
    if (!f || !newText.trim()) return
    f.srtText = plainToSrt(newText.trim(), f.srtText)
    f.origSegments = null
    f.segments = parseSrt(f.srtText)
    if (editMode.value) editedText.value = f.srtText
  }

  // ── 导出（对照 _show_save_dialog L915-973 + _convert_format；落盘经下载目录）──
  function exportSrt(idx: number, fmt: 'srt' | 'vtt' | 'txt' | 'plain'): void {
    const f = files.value[idx]
    if (!f?.srtText) return
    const ext = fmt === 'txt' || fmt === 'plain' ? 'txt' : fmt
    const text = convertSrtFormat(f.srtText, fmt)
    const base = f.name.replace(/\.[^.]+$/, '')
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
    const href = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = href
    a.download = `${base}.${ext}`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(href)
  }

  return {
    // state
    files, lang, busy, stageText, uploadPercent,
    selectedIndex, selected, editMode, editedText,
    // methods
    addPaths, pickFiles, onDrop, remove, retry, select, startBatch,
    enterEdit, exitEdit, rewriteSelected, applyRewriteResult, exportSrt,
  }
}
