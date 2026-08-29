// ═══════════════════════════════════════════════════════════════
// useVoiceCloneStudio — 声音克隆·转写取词/LLM 分句/逐行生成（条目④ 业务层）
// 对照原客户端 studio/gui/voice_clone_page.py：
//   · _transcribe_ref_audio L690-743（ASR → segments_to_plain →
//     PunctuationLLMWorker 标点优化，失败降级原文 L723-726）
//   · _split_and_populate_text_only L1566-1613（SentenceSplitterLLMWorker →
//     _validate_llm_split 漏字回退本地 L1583-1586 → _merge_short_fragments → 填表）
//   · _run_synthesize L1197-1249（分行克隆：无文案拦截 L1230-1232、
//     逐行任务、行级进度/失败）
//   · _estimate_max_chars L890-913（样本语速 = 样本文案字数 / 样本音频时长，
//     经 ffmpeg.probe 取时长；拿不到退回 4字/秒兜底）
// 纯逻辑在 voiceCloneLogic.ts（parser/builder 层），本文件仅编排（runner 层）
// ═══════════════════════════════════════════════════════════════

import { ref, computed } from 'vue'
import {
  PUNCTUATION_SYSTEM_PROMPT,
  SENTENCE_SPLIT_SYSTEM_PROMPT,
  estimateMaxChars,
  mergeShortFragments,
  splitTextIntoSentences,
  validateLlmSplit,
  extractLlmLines,
  extractLlmContent,
} from './voiceCloneLogic'
import { parseTranscriptionResponse, segmentsToPlainText } from './srtUtils'
import { useServerTask } from './useServerTask'

/** 逐行配音文案行状态（对照行级状态标签） */
export type RowStatus = 'idle' | 'running' | 'done' | 'failed'

export interface VoiceRow {
  text: string
  status: RowStatus
  audioUrl: string
  error: string
}

/** 音色/样本目录项（来自 /voices/list、/voices/samples） */
export interface CatalogItem {
  id: string
  name: string
  path?: string
  url?: string
}

function notify(title: string, body: string): void {
  try { window.tintin?.shell?.showNotification?.(title, body) } catch (_) {}
}

export function useVoiceCloneStudio() {
  // ── 参考音频 ──
  const refAudioPath = ref('')        // 上传的本地路径
  const selectedSampleId = ref('')    // 或选中的样本 id
  const refText = ref('')             // 参考文本（转写取词结果，可编辑）
  const transcribing = ref(false)

  // ── 目录数据 ──
  const voiceOptions = ref<CatalogItem[]>([])
  const samples = ref<CatalogItem[]>([])
  const voice = ref('')

  // ── 文案与行表 ──
  const wholeText = ref('')
  const rows = ref<VoiceRow[]>([])
  const splitting = ref(false)
  const generating = ref(false)
  const stageText = ref('')
  const maxChars = ref(60) // 单行字数上限（样本语速推算，对照 _estimate_max_chars）

  // ── 整体合成（原「整体克隆人声」入口保留；task_id 异步经 /tasks/{id} 轮询）──
  const wholeTask = useServerTask({
    successTitle: '声音克隆完成',
    failTitle: '声音克隆失败',
    getSuccessBody: () => '合成音频已就绪',
  })
  const wholeProgress = wholeTask.uploadPercent

  const refReady = computed(() => !!refAudioPath.value || !!selectedSampleId.value)
  const canSplit = computed(() => !!wholeText.value.trim() && !splitting.value)
  const hasRefText = computed(() => !!refText.value.trim())

  /** 拉取音色与样本目录（对照 _populate_ref_audio_samples L613-683 数据源） */
  async function loadCatalog(): Promise<void> {
    try {
      const list = await window.tintin.server.ttsVoicesList()
      if (!list || !Array.isArray(list)) throw new Error((list as any)?.error || '音色列表为空')
      voiceOptions.value = list.map((v) => ({ id: v.id, name: v.name }))
      if (voiceOptions.value.length && !voice.value) voice.value = voiceOptions.value[0].id
    } catch (err) {
      console.warn('[voice-clone] 拉取音色列表失败:', err)
    }
    try {
      const list = await window.tintin.server.ttsVoicesSamples()
      if (!list || !Array.isArray(list)) throw new Error((list as any)?.error || '参考样本列表为空')
      samples.value = list.map((s) => ({
        id: s.id,
        name: s.name,
        path: (s as any).path,
        url: s.audio_url || (s as any).url,
      }))
    } catch (err) {
      console.warn('[voice-clone] 拉取参考样本失败:', err)
      samples.value = []
    }
  }

  /** 参考音频就绪路径（上传=本地路径；样本=服务端 path，缺省空） */
  function getRefAudioPath(): string {
    if (refAudioPath.value) return refAudioPath.value
    const s = samples.value.find((x) => x.id === selectedSampleId.value)
    return s?.path || ''
  }

  /** 参考音频就绪 URL（样本无本地路径时用服务端 url 直传 ASR） */
  function getRefAudioUrl(): string {
    if (refAudioPath.value) return ''
    const s = samples.value.find((x) => x.id === selectedSampleId.value)
    return s?.url || ''
  }

  function setRefAudio(path: string): void {
    refAudioPath.value = path
    selectedSampleId.value = ''
    void estimateFromSample()
  }

  function selectSample(id: string): void {
    selectedSampleId.value = id
    refAudioPath.value = ''
    void estimateFromSample()
  }

  /** 按样本语速推算单行字数上限（对照 _estimate_max_chars：语速 = 字数/时长） */
  async function estimateFromSample(): Promise<void> {
    const path = getRefAudioPath()
    const text = refText.value.trim()
    if (path) {
      try {
        const info = await window.tintin.ffmpeg.probe(path)
        maxChars.value = estimateMaxChars(Number(info?.duration) || 0, text)
        return
      } catch (_) { /* 读时长失败走兜底 */ }
    }
    maxChars.value = estimateMaxChars(0, text)
  }

  /** 参考音频转写取词（对照 _transcribe_ref_audio：ASR → LLM 标点 → 失败降级原文） */
  async function transcribeRefAudio(): Promise<void> {
    if (!refReady.value) {
      notify('未选择声音样本', '请先选择参考声音样本 (wav/mp3)！')
      return
    }
    transcribing.value = true
    stageText.value = '正在识别参考音频文本...'
    try {
      const localPath = getRefAudioPath()
      const url = getRefAudioUrl()
      const payload: Record<string, unknown> = localPath
        ? { audio: { path: localPath } as unknown as Blob }
        : { url }
      const res = await window.tintin.server.asrTranscribe(payload as any)
      if (!res) throw new Error('服务端离线或未返回结果')
      if ((res as any).error) throw new Error((res as any).error)
      const segments = parseTranscriptionResponse(res)
      const plain = segmentsToPlainText(segments)
      if (!plain) throw new Error('无法从参考音频中提取文本')
      stageText.value = '正在使用 AI 模型自动优化断句与标点...'
      try {
        const llmRes = await window.tintin.server.llmChat({
          messages: [
            { role: 'system', content: PUNCTUATION_SYSTEM_PROMPT },
            { role: 'user', content: plain },
          ],
        })
        if (!llmRes || (llmRes as any).error) throw new Error((llmRes as any)?.error || 'LLM 离线')
        const punctuated = extractLlmContent(llmRes).trim()
        refText.value = punctuated || plain // LLM 空输出 → 原文兜底
        stageText.value = '完成： 识别与标点优化完成'
      } catch (_) {
        // 标点优化失败 → 原始识别文本（对照 on_punc_err L723-726）
        refText.value = plain
        stageText.value = '完成： 识别完成（标点优化失败）'
      }
      await estimateFromSample()
    } catch (err) {
      stageText.value = '失败： 识别文本失败'
      notify('识别文本失败', `无法从参考音频中提取文本：\n${err instanceof Error ? err.message : String(err)}`)
    } finally {
      transcribing.value = false
    }
  }

  /** 行表操作 */
  function updateRowText(i: number, text: string): void {
    const r = rows.value[i]
    if (r) r.text = text
  }
  function removeRow(i: number): void {
    rows.value.splice(i, 1)
  }
  function addRow(): void {
    rows.value.push({ text: '', status: 'idle', audioUrl: '', error: '' })
  }
  function clearRows(): void {
    rows.value = []
  }

  /** 一键拆分填充（对照 _split_and_populate_text_only：LLM → 校验回退 → 合并 → 填表） */
  async function splitIntoRows(): Promise<void> {
    const text = wholeText.value.trim()
    if (!text) {
      notify('提示', '请先在「待克隆整体文案」输入内容！')
      return
    }
    splitting.value = true
    stageText.value = '正在使用大模型智能拆分文案...'
    let usedFallbackLocal = false
    try {
      let lines: string[] = []
      try {
        const res = await window.tintin.server.llmChat({
          messages: [
            { role: 'system', content: SENTENCE_SPLIT_SYSTEM_PROMPT },
            { role: 'user', content: text },
          ],
        })
        if (!res || (res as any).error) throw new Error((res as any)?.error || 'LLM 离线')
        lines = extractLlmLines(extractLlmContent(res))
        // 防漏字保护：疑似漏字/误删编号 → 自动退回本地规则拆分（对照 _validate_llm_split）
        const fallback = validateLlmSplit(text, lines)
        if (fallback !== null) {
          lines = fallback
          stageText.value = '注意： AI 拆分疑似漏字，已自动退回本地规则拆分'
        }
      } catch (_) {
        // AI 拆分失败 → 本地规则（对照 on_split_err L1599-1606）
        lines = splitTextIntoSentences(text)
        usedFallbackLocal = true
        stageText.value = '注意： AI 智能拆分失败，已自动使用本地规则'
      }
      lines = mergeShortFragments(lines, maxChars.value)
      clearRows()
      for (const s of lines) {
        rows.value.push({ text: s, status: 'idle', audioUrl: '', error: '' })
      }
      if (!usedFallbackLocal && stageText.value.startsWith('正在')) {
        stageText.value = '完成： AI 智能拆分完成'
      } else if (!usedFallbackLocal) {
        stageText.value = `完成： 拆分填充 ${rows.value.length} 行`
      }
      notify('拆分完成', `已拆分并填入列表，共 ${rows.value.length} 行。`)
    } finally {
      splitting.value = false
    }
  }

  /** 单行克隆合成（对照逐行 VoiceCloneWorker：ref_audio + ref_text + 行文案） */
  async function generateRow(i: number): Promise<void> {
    const row = rows.value[i]
    if (!row) return
    const localPath = getRefAudioPath()
    const sampleUrl = getRefAudioUrl()
    if (!localPath && !sampleUrl) {
      notify('未选择声音样本', '请先上传/选择参考声音样本 (wav/mp3)！')
      return
    }
    if (!row.text.trim()) {
      notify('文案为空', '该行没有可合成的文案。')
      return
    }
    row.status = 'running'
    row.error = ''
    stageText.value = `正在生成第 ${i + 1} 行的克隆声音...`
    try {
      const payload: Record<string, unknown> = {
        text: row.text.trim(),
        voice_id: voice.value || undefined,
        // 有参考音频时服务端走参考克隆；样本 URL 无法作为 multipart 文件，
        // 此时退回选中音色合成（样本试听/转写不受影响）
        ...(localPath ? { clone_ref_file: { path: localPath } as unknown as Blob } : {}),
      }
      const res = await window.tintin.server.ttsGenerate(payload as any)
      if (!res) throw new Error('服务端离线或未返回结果')
      if ((res as any).error) throw new Error((res as any).error)
      const url = (res as any).audio_url || (res as any).url || ''
      if (!url) throw new Error('未返回音频地址')
      row.audioUrl = url
      row.status = 'done'
    } catch (err) {
      row.status = 'failed'
      row.error = err instanceof Error ? err.message : String(err)
      notify('行级生成失败', `第 ${i + 1} 行：${row.error}`)
    }
  }

  /** 批量分行克隆（对照 _run_synthesize merge=False：无文案拦截 + 逐行顺序执行） */
  async function generateAll(): Promise<void> {
    if (generating.value) return
    const localPath = getRefAudioPath()
    if (!localPath && !getRefAudioUrl()) {
      notify('未上传声音样本', '请先上传/选择参考声音样本 (wav/mp3)！')
      return
    }
    const targets = rows.value
      .map((r, i) => ({ r, i }))
      .filter(({ r }) => r.text.trim())
    if (!targets.length) {
      notify('文案为空', '没有检测到任何配文。请在列表的「配音文案」栏输入内容。')
      return
    }
    generating.value = true
    for (const { i } of targets) {
      await generateRow(i)
    }
    stageText.value = '完成： 逐行克隆结束'
    generating.value = false
  }

  /** 整体克隆（对照 _clone_whole：文本+参考音频 → voxcpm；同步 audio_url / 异步 task_id 双路径） */
  async function generateWhole(): Promise<void> {
    const text = wholeText.value.trim()
    if (!text) {
      notify('提示', '请先输入待克隆整体文案！')
      return
    }
    const localPath = getRefAudioPath()
    if (!localPath && !getRefAudioUrl()) {
      notify('未上传声音样本', '请先上传/选择参考声音样本 (wav/mp3)！')
      return
    }
    stageText.value = '正在进行整体克隆...'
    wholeTask.begin()
    try {
      const payload: Record<string, unknown> = {
        text,
        voice_id: voice.value || undefined,
        ...(localPath ? { clone_ref_file: { path: localPath } as unknown as Blob } : {}),
      }
      const res = await window.tintin.server.ttsGenerate(payload as any, wholeTask.setUpload)
      if (!res) throw new Error('服务端离线或未返回结果')
      // ttsGenerate 返回 audio_url；若带 task_id（异步模式）则进入轮询；否则同步显示结果
      if ((res as any).task_id && !(res as any).audio_url) {
        wholeTask.startPolling((res as any).task_id)
      } else {
        wholeTask.completeSync((res as any).audio_url || '')
        stageText.value = '完成： 整体克隆人声生成成功！'
        notify('生成成功', '整体克隆人声音频生成完毕。')
      }
    } catch (err) {
      wholeTask.failWith(err)
      stageText.value = '失败： 整体生成失败'
    }
  }

  /** 行音频下载 */
  function downloadRow(i: number): void {
    const row = rows.value[i]
    if (!row?.audioUrl) return
    const a = document.createElement('a')
    a.href = row.audioUrl
    a.download = `voice_${i + 1}.wav`
    document.body.appendChild(a)
    a.click()
    a.remove()
  }

  return {
    // state
    refAudioPath, selectedSampleId, refText, transcribing,
    voiceOptions, samples, voice,
    wholeText, rows, splitting, generating, stageText, maxChars,
    wholeTask, wholeProgress,
    refReady, canSplit, hasRefText,
    // methods
    loadCatalog, setRefAudio, selectSample, transcribeRefAudio,
    splitIntoRows, updateRowText, removeRow, addRow, clearRows,
    generateRow, generateAll, generateWhole, downloadRow,
  }
}
