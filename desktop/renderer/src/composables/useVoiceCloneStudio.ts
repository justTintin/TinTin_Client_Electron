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

import { ref, computed, onBeforeUnmount } from 'vue'
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
import { readCacheDir } from './useSettingsConfig'

/**
 * 声音克隆文件命名规范（对齐原客户端 voice_clone_page.py _get_named_filename）
 * 格式：{样本前缀}_{文案前10字}_{YYYYMMDD}[后缀].wav
 *  - 样本前缀：样本名按 -/_/空格 拆分取第一段
 *  - 文案前缀：文案前 10 字，去除 Windows 非法字符
 *  - 后缀：整体=无，合并=_merged，分句=_row{idx}
 */
const VOICE_CLONE_SUBDIR = 'voice_clone'

/** 取样本名前缀（按 -/_/空格 拆分取第一段） */
function getSamplePrefix(sampleName: string): string {
  if (!sampleName) return ''
  for (const sep of ['-', '_', ' ']) {
    if (sampleName.includes(sep)) {
      return sampleName.split(sep)[0].trim()
    }
  }
  return sampleName.trim()
}

/** 取文案前 n 字（去除 Windows 非法字符） */
function getTextPrefix(text: string, n = 10): string {
  if (!text) return ''
  let compact = text.replace(/\s+/g, '')
  for (const c of ['\\', '/', ':', '*', '?', '"', '<', '>', '|']) {
    compact = compact.replace(new RegExp(`\\${c}`, 'g'), '')
  }
  compact = compact.replace(/^[ .]+|[ .]+$/g, '')
  return compact.slice(0, n) || '未命名'
}

/** 生成声音克隆文件名（对齐原客户端 _get_named_filename；引擎段后缀：同目录不同模型的产物可区分） */
function buildVoiceCloneFileName(
  text: string,
  sampleName: string,
  kind: 'whole' | 'merged' | 'row' = 'whole',
  rowIdx?: number,
  engine?: string,
): string {
  const today = new Date()
  const dateStr = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`
  const sample = getSamplePrefix(sampleName)
  const text10 = getTextPrefix(text)
  const parts = [sample, text10, dateStr, engine || ''].filter(Boolean)
  const base = parts.join('_')
  if (kind === 'merged') return `${base}_merged.wav`
  if (kind === 'row' && rowIdx !== undefined) return `${base}_row${rowIdx}.wav`
  return `${base}.wav`
}

/** 获取声音克隆保存目录（cacheDir/voice_clone/） */
async function getVoiceCloneSaveDir(): Promise<string> {
  const cacheDir = await readCacheDir()
  const base = cacheDir || ''
  return base ? `${base.replace(/[/\\]+$/, '')}/${VOICE_CLONE_SUBDIR}` : VOICE_CLONE_SUBDIR
}

/** 逐行配音文案行状态（对照行级状态标签） */
export type RowStatus = 'idle' | 'running' | 'done' | 'failed'

export interface VoiceRow {
  text: string
  status: RowStatus
  audioUrl: string
  audioPath?: string  // 本地文件路径（命名规范落盘后）
  error: string
  engine?: 'voxcpm2' | 'indextts'  // 生成所用模型（切换引擎时用于清理旧结果/展示标注）
}

/** 音色/样本目录项（来自 /voices/list、/voices/samples） */
export interface CatalogItem {
  id: string
  name: string
  path?: string
  url?: string
  text?: string       // 样本对应文字（API-GUIDE: /voice/samples 返回 text 字段）
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
  const uploadingSample = ref(false)
  // 2026-09-05 用户裁决：声音克隆固定使用 IndexTTS，不再使用 voxcpm（无引擎选择器）
  const ttsEngine = 'indextts' as const
  const wholeEngine = 'indextts' as const
  // IndexTTS 专属参数（API-GUIDE：/indextts/tts）
  const ttsDurationFactor = ref(1.0)   // 语速 0.5~2.0，默认 1.0
  const ttsEmoText = ref('')           // 情感文字（如：开心、悲伤、激动）
  const ttsEmoAlpha = ref(0.5)         // 情感强度 0~1，默认 0.5

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

  // ── 整体克隆合成进度 ──
  // 服务端 HTTP 同步等待（IndexTTS 内部队列对外也是等完返回），无真实进度可拉：
  // 用缓动假进度逼近 92%（前快后慢），完成置 100、失败归零。此前只有上传进度
  // （wholeProgress=uploadPercent，ttsGenerate 未接 onProgress 恒 0），合成等待期无任何指示。
  const wholeSynthProgress = ref(0)
  let synthTimer: ReturnType<typeof setInterval> | null = null
  function startSynthProgress(): void {
    stopSynthProgress(false)
    synthTimer = setInterval(() => {
      const p = wholeSynthProgress.value
      wholeSynthProgress.value = Math.min(92, p + Math.max(0.6, (92 - p) * 0.045))
    }, 150)
  }
  function stopSynthProgress(done: boolean): void {
    if (synthTimer) { clearInterval(synthTimer); synthTimer = null }
    wholeSynthProgress.value = done ? 100 : 0
  }

  // ── wholeTask 解包视图（嵌套 ref 在模板中不自动解包，直接 wholeTask.status===... 恒 false，
  // 这是此前「克隆成功后无播放/下载」的根因；组件统一改用以下 computed）──
  const wholeStatus = computed(() => wholeTask.status.value)
  const wholeIsProcessing = computed(() => wholeTask.isProcessing.value)
  const wholeErrorMsg = computed(() => wholeTask.errorMsg.value)
  const wholeResultUrl = computed(() => wholeTask.resultUrl.value)
  const wholeResultPath = computed(() => wholeTask.resultPath.value)

  const refReady = computed(() => !!refAudioPath.value || !!selectedSampleId.value)
  const canSplit = computed(() => !!wholeText.value.trim() && !splitting.value)
  const hasRefText = computed(() => !!refText.value.trim())

  /** 从服务端响应中提取数组（兼容裸数组 / {items} / {data} / {samples} / {voices} 等包裹格式） */
  function extractArray(res: unknown): unknown[] {
    if (Array.isArray(res)) return res
    if (res && typeof res === 'object') {
      const obj = res as Record<string, unknown>
      for (const key of ['items', 'data', 'samples', 'voices', 'list', 'results']) {
        if (Array.isArray(obj[key])) return obj[key] as unknown[]
      }
    }
    return []
  }

  /** 拉取样本目录（GET /voice/samples，一次请求同时填充 voiceOptions + samples） */
  async function loadCatalog(): Promise<void> {
    try {
      const raw = await window.tintin.server.ttsVoicesSamples()
      const list = extractArray(raw)
      if (!list.length) throw new Error((raw as any)?.error || '样本列表为空')
      // 同时填充音色选项 + 样本列表（两者来自同一端点）
      voiceOptions.value = list.map((v: any) => ({ id: String(v.id), name: v.name }))
      samples.value = list.map((s: any) => ({
        id: String(s.id),
        name: s.name,
        path: s.path,
        url: s.audio_url || s.url,
        text: s.text || '',
      }))
      if (voiceOptions.value.length && !voice.value) voice.value = voiceOptions.value[0].id
    } catch (err) {
      console.warn('[voice-clone] 拉取样本目录失败:', err)
      voiceOptions.value = []
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
    stopSamplePreview()
    refAudioPath.value = path
    selectedSampleId.value = ''
    void estimateFromSample()
  }

  // ── 样本试听（GET 样本 audio_url 取回 base64 → blob；audio_url 为相对路径，主进程取回）──
  const samplePreviewUrl = ref('')
  const samplePreviewLoading = ref(false)
  let _previewSampleId = ''   // 当前 blob 对应的样本 id（切样本时作废旧 blob）
  let _previewToken = 0       // 竞态令牌：切样本后旧请求结果丢弃

  async function playSample(id: string): Promise<void> {
    const s = samples.value.find((x) => x.id === id)
    if (!s?.url) return
    const token = ++_previewToken
    samplePreviewLoading.value = true
    try {
      // 切换了样本 → 先作废旧 blob
      if (_previewSampleId !== id && samplePreviewUrl.value) {
        try { URL.revokeObjectURL(samplePreviewUrl.value) } catch (_) {}
        _previewSampleId = ''
        samplePreviewUrl.value = ''
      }
      if (!samplePreviewUrl.value) {
        const res = await window.tintin.server.ttsFetchSampleAudio({ url: s.url })
        if (token !== _previewToken) return
        const b64 = (res as any)?.audio_base64
        if (!b64) { notify('提示', (res as any)?.error ? `试听失败：${(res as any).error}` : '试听失败：服务端未返回音频'); return }
        const ct = (res as any)?.content_type || 'audio/wav'
        const blob = await (await fetch(`data:${ct};base64,${b64}`)).blob()
        if (token !== _previewToken) return
        if (samplePreviewUrl.value) { try { URL.revokeObjectURL(samplePreviewUrl.value) } catch (_) {} }
        samplePreviewUrl.value = URL.createObjectURL(blob)
        _previewSampleId = id
      }
    } catch (err) {
      notify('提示', `试听失败：${(err as any)?.message || err}`)
    } finally {
      if (token === _previewToken) samplePreviewLoading.value = false
    }
  }

  function stopSamplePreview(): void {
    _previewToken++
    if (samplePreviewUrl.value) { try { URL.revokeObjectURL(samplePreviewUrl.value) } catch (_) {} }
    samplePreviewUrl.value = ''
    _previewSampleId = ''
    samplePreviewLoading.value = false
  }

  onBeforeUnmount(() => { stopSamplePreview() })

  function selectSample(id: string): void {
    stopSamplePreview()
    selectedSampleId.value = id
    refAudioPath.value = ''
    // 自动填充样本的参考文字
    const s = samples.value.find((x) => x.id === id)
    if (s?.text) refText.value = s.text
    void estimateFromSample()
  }

  /** 上传音频为样本（API-GUIDE：POST /voice/samples，multipart: file + name + text） */
  async function uploadSample(name: string, text?: string): Promise<{ ok: boolean; error?: string }> {
    const path = refAudioPath.value
    if (!path) return { ok: false, error: '没有可上传的音频文件' }
    if (!name.trim()) return { ok: false, error: '样本名称不能为空' }
    uploadingSample.value = true
    try {
      const res = await window.tintin.server.ttsUploadSample({
        file: { path } as unknown as Blob,
        name: name.trim(),
        text: text?.trim() || '',
      } as any)
      if (!res || (res as any).error) {
        return { ok: false, error: (res as any)?.error || '上传失败' }
      }
      await loadCatalog()
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    } finally {
      uploadingSample.value = false
    }
  }

  /** 底部独立上传新样本（指定文件路径 + 名称 + 文字，上传后自动刷新列表） */
  async function uploadNewSample(filePath: string, name: string, text?: string): Promise<{ ok: boolean; error?: string; sampleId?: string }> {
    if (!filePath) return { ok: false, error: '没有可上传的音频文件' }
    if (!name.trim()) return { ok: false, error: '样本名称不能为空' }
    uploadingSample.value = true
    try {
      const res = await window.tintin.server.ttsUploadSample({
        file: { path: filePath } as unknown as Blob,
        name: name.trim(),
        text: text?.trim() || '',
      } as any)
      if (!res || (res as any).error) {
        return { ok: false, error: (res as any)?.error || '上传失败' }
      }
      await loadCatalog()
      // 自动选中新上传的样本
      const newId = String((res as any)?.id || '')
      if (newId) selectSample(newId)
      return { ok: true, sampleId: newId }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    } finally {
      uploadingSample.value = false
    }
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
    rows.value.push({ text: '', status: 'idle', audioUrl: '', audioPath: '', error: '' })
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
        rows.value.push({ text: s, status: 'idle', audioUrl: '', audioPath: '', error: '' })
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

  /** base64 → Blob URL（TTS 返回 WAV 二进制经主进程 base64 透传） */
  function base64ToAudioUrl(base64: string, contentType = 'audio/wav'): string {
    const binary = atob(base64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    const blob = new Blob([bytes], { type: contentType })
    return URL.createObjectURL(blob)
  }

  /** 从 TTS 响应中提取音频 URL（兼容 audio_base64 / audio_url） */
  function extractAudioUrl(res: any): string {
    if (res?.audio_base64) return base64ToAudioUrl(res.audio_base64, res.content_type)
    return res?.audio_url || res?.url || ''
  }

  /** 单行克隆合成（API-GUIDE：sample_id 引用样本库 + engine 双引擎） */
  async function generateRow(i: number): Promise<void> {
    const row = rows.value[i]
    if (!row) return
    const sampleUrl = getRefAudioUrl()
    if (!sampleUrl && !selectedSampleId.value) {
      notify('未选择声音样本', '请先从样本库选择参考声音样本！')
      return
    }
    if (!row.text.trim()) {
      notify('文案为空', '该行没有可合成的文案。')
      return
    }
    row.status = 'running'
    row.error = ''
    row.engine = ttsEngine
    stageText.value = `正在生成第 ${i + 1} 行的克隆声音（${ttsEngine}）...`
    try {
      const payload: Record<string, unknown> = {
        text: row.text.trim(),
        // API-GUIDE 推荐：sample_id 引用 /voice/samples 样本库
        ...(selectedSampleId.value ? { sample_id: Number(selectedSampleId.value) } : {}),
        // IndexTTSRequest 专属参数（引擎已固定 IndexTTS，voxcpm 分支已删；契约无 engine 字段不发）
        duration_factor: ttsDurationFactor.value,
        ...(ttsEmoText.value.trim() ? { emo_text: ttsEmoText.value.trim() } : {}),
        emo_alpha: ttsEmoAlpha.value,
        resp: 'json',
      }
      const res = await window.tintin.server.ttsGenerate(payload as any)
      if (!res) throw new Error('服务端离线或未返回结果')
      if ((res as any).error) throw new Error((res as any).error)
      const url = extractAudioUrl(res)
      if (!url) throw new Error('未返回音频数据')
      row.audioUrl = url
      // 按命名规范保存到 voice_clone 子目录
      try {
        const saveDir = await getVoiceCloneSaveDir()
        const sampleName = samples.value.find((s) => s.id === selectedSampleId.value)?.name || ''
        const fileName = buildVoiceCloneFileName(row.text.trim(), sampleName, 'row', i + 1, ttsEngine)
        const savePath = `${saveDir}/${fileName}`
        let localPath = ''
        if ((res as any).audio_base64) {
          const saved = await window.tintin.server.ttsSaveAudio({
            base64: (res as any).audio_base64,
            savePath,
          })
          localPath = typeof saved === 'string' ? saved : ''
        } else if (url.startsWith('http')) {
          const saved = await window.tintin.server.downloadResult(url, savePath)
          localPath = String(saved || '')
        }
        if (localPath) row.audioPath = localPath
      } catch (_) { /* 行级保存失败不影响播放 */ }
      row.status = 'done'
    } catch (err) {
      row.status = 'failed'
      row.error = err instanceof Error ? err.message : String(err)
      notify('行级生成失败', `第 ${i + 1} 行：${row.error}`)
    }
  }

  /** 批量分行克隆 */
  async function generateAll(): Promise<void> {
    if (generating.value) return
    if (!getRefAudioUrl() && !selectedSampleId.value) {
      notify('未选择声音样本', '请先从样本库选择参考声音样本！')
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

  /** 整体克隆（API-GUIDE：sample_id + engine 双引擎；WAV base64 / audio_url 双响应） */
  async function generateWhole(): Promise<void> {
    const text = wholeText.value.trim()
    if (!text) {
      notify('提示', '请先输入待克隆整体文案！')
      return
    }
    if (!getRefAudioUrl() && !selectedSampleId.value) {
      notify('未选择声音样本', '请先从样本库选择参考声音样本！')
      return
    }
    stageText.value = '正在进行整体克隆...'
    wholeTask.begin()
    startSynthProgress()
    try {
      const payload: Record<string, unknown> = {
        text,
        ...(selectedSampleId.value ? { sample_id: Number(selectedSampleId.value) } : {}),
        // IndexTTSRequest 专属参数（引擎已固定，契约无 engine 字段不发）
        duration_factor: ttsDurationFactor.value,
        ...(ttsEmoText.value.trim() ? { emo_text: ttsEmoText.value.trim() } : {}),
        emo_alpha: ttsEmoAlpha.value,
        resp: 'json',
      }
      const res = await window.tintin.server.ttsGenerate(payload as any)
      if (!res) throw new Error('服务端离线或未返回结果')
      if ((res as any).error) throw new Error((res as any).error)
      const url = extractAudioUrl(res)
      if (url) {
        // 按命名规范生成文件名（含引擎段）+ 保存到 voice_clone 子目录
        const saveDir = await getVoiceCloneSaveDir()
        const sampleName = samples.value.find((s) => s.id === selectedSampleId.value)?.name || ''
        const fileName = buildVoiceCloneFileName(text, sampleName, 'whole', undefined, wholeEngine)
        const savePath = `${saveDir}/${fileName}`
        let localPath = ''
        try {
          if ((res as any).audio_base64) {
            // base64 响应：直接写入本地文件
            const saved = await window.tintin.server.ttsSaveAudio({
              base64: (res as any).audio_base64,
              savePath,
            })
            localPath = typeof saved === 'string' ? saved : ''
          } else if (url.startsWith('http')) {
            // audio_url 响应：从服务端下载
            const saved = await window.tintin.server.downloadResult(url, savePath)
            localPath = String(saved || '')
          }
        } catch (_) {
          localPath = ''
        }
        wholeTask.completeSync(url)
        if (localPath) {
          // 注意必须写 .value：直接 wholeTask.resultPath = localPath 会把 ref 覆盖成字符串、破坏响应性
          wholeTask.resultPath.value = localPath
        }
        stopSynthProgress(true)
        stageText.value = `完成： 整体克隆人声生成成功！文件：${fileName}`
        notify('生成成功', `文件：${fileName}${localPath ? '，已保存到缓存目录' : ''}`)
      } else if ((res as any).task_id) {
        stopSynthProgress(false) // 切换到 /tasks/{id} 真实轮询进度
        wholeTask.startPolling((res as any).task_id)
      } else {
        throw new Error('未返回音频数据')
      }
    } catch (err) {
      stopSynthProgress(false)
      wholeTask.failWith(err)
      stageText.value = '失败： 整体生成失败'
    }
  }

  /** 整体克隆结果另存为（成功区「下载」：dialog 选位置 → 优先复制已落盘文件，兜底 blob 转 base64） */
  async function saveWholeAudioAs(): Promise<void> {
    const url = wholeResultUrl.value
    const localPath = wholeResultPath.value
    if (!url && !localPath) {
      notify('提示', '还没有可下载的克隆音频')
      return
    }
    const sampleName = samples.value.find((s) => s.id === selectedSampleId.value)?.name || ''
    const defaultName = buildVoiceCloneFileName(wholeText.value.trim(), sampleName, 'whole', undefined, wholeEngine)
    let target = ''
    try {
      target = (await window.tintin.dialog.saveFile({
        title: '保存克隆音频',
        defaultPath: defaultName,
        filters: [{ name: 'WAV 音频', extensions: ['wav'] }],
      })) || ''
    } catch (e) {
      notify('保存失败', '无法打开保存对话框：' + (e instanceof Error ? e.message : String(e)))
      return
    }
    if (!target) return // 用户取消
    try {
      if (localPath) {
        // 已落盘（ttsSaveAudio 返回绝对路径）：直接复制，最可靠
        const saved = await window.tintin.server.ttsSaveAudio({ fromPath: localPath, savePath: target })
        if (saved && typeof saved === 'object' && (saved as any).error) throw new Error((saved as any).error)
      } else if (url.startsWith('blob:')) {
        // 无本地文件时兜底：blob URL → base64 → 写盘
        const blob = await fetch(url).then((r) => r.blob())
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const fr = new FileReader()
          fr.onload = () => resolve(String(fr.result || ''))
          fr.onerror = () => reject(new Error('读取音频数据失败'))
          fr.readAsDataURL(blob)
        })
        const base64 = dataUrl.split(',')[1] || ''
        if (!base64) throw new Error('音频数据为空')
        const saved = await window.tintin.server.ttsSaveAudio({ base64, savePath: target })
        if (saved && typeof saved === 'object' && (saved as any).error) throw new Error((saved as any).error)
      } else if (url.startsWith('http')) {
        const saved = await window.tintin.server.downloadResult(url, target)
        if (!saved) throw new Error('下载失败')
      } else {
        throw new Error('无可用的音频数据源')
      }
      notify('下载完成', target)
    } catch (err) {
      notify('下载失败', err instanceof Error ? err.message : String(err))
    }
  }

  /** 整体克隆结果上传到素材库（音频库 audio_library，与 AudioGen 保存 BGM/音效同通道；
   *  category='配音'，tags 带引擎标识；依赖 ttsSaveAudio 返回的绝对路径） */
  const uploadingToLib = ref(false)
  async function uploadWholeToLibrary(): Promise<void> {
    if (uploadingToLib.value) return
    let filePath = wholeResultPath.value
    if (!filePath) {
      // 兕底：尚未落盘时先从 blob 写盘再传
      const url = wholeResultUrl.value
      if (!url?.startsWith('blob:')) {
        notify('提示', '没有可上传的克隆音频')
        return
      }
      try {
        const saveDir = await getVoiceCloneSaveDir()
        const sampleName = samples.value.find((s) => s.id === selectedSampleId.value)?.name || ''
        const fileName = buildVoiceCloneFileName(wholeText.value.trim(), sampleName, 'whole', undefined, wholeEngine)
        const blob = await fetch(url).then((r) => r.blob())
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const fr = new FileReader()
          fr.onload = () => resolve(String(fr.result || ''))
          fr.onerror = () => reject(new Error('读取音频数据失败'))
          fr.readAsDataURL(blob)
        })
        const base64 = dataUrl.split(',')[1] || ''
        if (!base64) throw new Error('音频数据为空')
        const saved = await window.tintin.server.ttsSaveAudio({ base64, savePath: `${saveDir}/${fileName}` })
        if (typeof saved !== 'string') throw new Error((saved as any).error || '落盘失败')
        filePath = saved
        wholeTask.resultPath.value = saved
      } catch (err) {
        notify('上传失败', err instanceof Error ? err.message : String(err))
        return
      }
    }
    uploadingToLib.value = true
    try {
      const data = await window.tintin.server.audioLibraryUpload({
        filePath,
        category: '配音',
        tags: `声音克隆,${wholeEngine}`,
      })
      if (data && typeof data === 'object' && (data as any).error) throw new Error((data as any).error)
      const newId = Number((data as any)?.id)
      notify('成功', `配音已上传到素材库（音频库）${Number.isInteger(newId) && newId > 0 ? `，编号 #${newId}` : ''}`)
    } catch (err) {
      notify('上传失败', err instanceof Error ? err.message : String(err))
    } finally {
      uploadingToLib.value = false
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
    voiceOptions, samples, voice, ttsEngine, ttsDurationFactor, ttsEmoText, ttsEmoAlpha,
    wholeText, rows, splitting, generating, stageText, maxChars,
    wholeTask, wholeProgress,
    // 整体克隆：解包视图 + 合成进度 + 另存为（模板直接用，禁 wholeTask.xxx 裸访问）
    wholeStatus, wholeIsProcessing, wholeErrorMsg, wholeResultUrl, wholeResultPath,
    wholeSynthProgress, saveWholeAudioAs, uploadingToLib, uploadWholeToLibrary,
    refReady, canSplit, hasRefText, uploadingSample,
    // methods
    loadCatalog, setRefAudio, selectSample, uploadSample, uploadNewSample, transcribeRefAudio,
    playSample, stopSamplePreview,
    splitIntoRows, updateRowText, removeRow, addRow, clearRows,
    generateRow, generateAll, generateWhole, downloadRow,
  }
}
