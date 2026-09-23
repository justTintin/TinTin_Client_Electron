// ══════════════════════════════════════════════════════════
// useMontageStep3Voice.ts — 智能混剪 Step3 口播配音/字幕花字/文字模板编排（铁律 10 拆分，2026-09-18）
// 自 useVideoMontage.ts 纯搬迁（IRON-02 五项 checklist；蓝图见
// docs/智能混剪拆分迁移映射_2026-09-18.md §五 Step3）。
// 跨步依赖经 ctx 注入：共享运行时（statusText/serverUrl/ensureServerUrl）+
//   Step2 assemblePlans + Step1 previewUrl + 上提 ref（finalBusy/step4Candidates）+
//   S4 函数惰性绑定（collectCandidates/ensureProcessedSrt，运行时才解析）。
// 本步内 offVoiceProgress 槽随 nextVoiceChannel 同步迁入，对外暴露
//   clearVoiceProgressListener（与 setClearBusy 同类机械适配，槽语义不变）。
// ─────────────────────────────────────────────────═
import { ref, computed, watch } from 'vue'
import type { Ref } from 'vue'
import { clientError } from '../../utils/clientLog'
import {
  serverStylesToPresets, SUBTITLE_STYLE_PRESETS_FALLBACK, subtitlePresetTileStyle,
  TEXT_KEYWORD_DENSITY_MAX, pickRandomItems, extractFancyWordsFromText,
  buildSubtitleRows, buildTextFxTracks, textFxStyleOf,
  resolveOutMontageDir, pathBasename,
  type TextFxTrack, type SubtitleStylePreset, type PrecomposePlan, type VoiceRow,
} from '../videoMontageLogic'
import { notify, errText, joinPath } from './context'
import { useMontageTextFx } from './useMontageTextFx'

export interface MontageStep3Context {
  statusText: Ref<string>
  serverUrl: Ref<string>
  ensureServerUrl: () => Promise<string>
  assemblePlans: Ref<PrecomposePlan[]>
  previewUrl: Ref<string>
  finalBusy: Ref<boolean>
  finalProgress: Ref<number>
  finalDone: Ref<boolean>
  finalVideoList: Ref<Array<{ name: string; path: string }>>
  finalVideoPath: Ref<string>
  step4Candidates: Ref<string[]>
  collectCandidates: (useSource?: boolean) => Promise<string[]>
  ensureProcessedSrt: (text: string, wavPath: string, candidate: string) => Promise<string>
  /** 产品信息（2026-09-19 架构：关键词命中词源=产品资料关联关键词，透传 textfx 子编排） */
  sharedProductInfo: Ref<{ brand: string; product: string; model: string; extra: string; keywords: string[] }>
}

export function useMontageStep3Voice(ctx: MontageStep3Context) {
  const { statusText, serverUrl, ensureServerUrl, assemblePlans, previewUrl,
    finalBusy, finalProgress, finalDone, finalVideoList, finalVideoPath,
    step4Candidates, collectCandidates, ensureProcessedSrt, sharedProductInfo } = ctx

  // ── Step3 口播配音（对照 step3_voice_view.py 逐控件 + VoiceCloneWorker api 模式 +
  // VideoDubbingWorker；TTS 直连用户可改 apiUrl，初值跟随 server_url + /indextts/tts；
  // 2026-09-05 服务端将删 /voxcpm/*，随声音克隆裁决统一切 IndexTTS）──
  const voiceDirInput = ref('')
  const selectedVoiceFiles = ref<string[]>([])
  const voicesDir = ref('')
  const voiceRows = ref<VoiceRow[]>([])
  // 参考声音（用户裁决 2026-09-03：声音样本从服务端取，与 VoiceClone 页同源 GET /voice/samples；
  // 原版为本地 voice_samples_page 样本库，本端以服务端样本库对齐）
  const refSamples = ref<Array<{ id: string; name: string; url: string; text: string }>>([])
  const selectedRefSample = ref<{ id: string; url: string } | null>(null)
  const refAudioPath = ref('')
  const refAudioLabel = ref('未找到预设声音样本')
  /** 选中样本播放条地址（对齐 VoiceClone samplePreviewUrl：常驻 audio 控件换 src） */
  const refPreviewUrl = ref('')
  const refText = ref('')
  // TTS 参数（L114-175；inference_timesteps/cfg_value 存而不用，原版同口径）
  const ttsApiUrl = ref('')
  const ttsSteps = ref(10)
  const ttsCfg = ref(2.0)
  const ttsSpeedMin = ref(0.9)
  const ttsSpeedMax = ref(1.2)
  // 字幕/花字（L210-265）
  // 2026-09-11 用户裁决：烧制字幕默认勾选（Step4 特效包装开箱即用，未配置也走字幕烧制）
  const addSubtitles = ref(true)
  const subtitleFont = ref('')
  const fontOptions = ref<Array<{ label: string; value: string }>>([{ label: '默认（不指定字体）', value: '' }])
  const fontsLoading = ref(false)
  const fancyEnabled = ref(false)
  const fancyStyle = ref('gold')
  // 字幕样式（2026-09-17 用户裁决：字幕样式统一来自服务端 /subtitle_styles）
  const subtitleStyleKey = ref('')
  const subtitleStylePresets = ref<SubtitleStylePreset[]>(SUBTITLE_STYLE_PRESETS_FALLBACK)
  // 字幕入场动画 key（2026-09-10 用户裁决：字幕可选动画，预览与烧制同用该选择；
  // key 与主进程 VALID_ANIMS 同表：fade/rise/slide/pop/none）
  const subtitleAnimKey = ref('fade')
  // 2026-09-22 用户裁决：字幕字号默认 12 号（2026-09-18 曾定 10，实测仍偏小）；
  // 第四步「字号」下拉覆写，预览同比例缩放
  const subtitleFontSize = ref(12)
  // 花字位置/字幕背景/模板（L224-352；模板首项「自定义 (下方样式)」value=''）
  const fancyPosition = ref('upper_middle')
  // 字幕背景不透明度默认 20%（2026-09-15 用户裁决：背景里的透明默认设计为 20%，原 0.5）
  const subtitleBgOpacity = ref(0.2)
  const fancyTemplateId = ref('')
  const fancyTemplates = ref<FancyTemplateItem[]>([])
  const fancyPreviews = ref<Record<string, string>>({})
  const fancyTemplatesLoading = ref(false)
  // ── 文字模板 textfx（已迁 montage/useMontageTextFx.ts，铁律 10 E3b 纯搬迁）──
  const tfx = useMontageTextFx({ voiceRows, assemblePlans, finalBusy, step4Candidates, collectCandidates, sharedProductInfo })
  const {
    textFxEnabled, lutRestore, lutId, lutList, lutListLoading, loadLuts,
    textTemplateId, textRandomCount, textKeywordDensity, textTemplates, textTemplatesLoading,
    activeTextPool, activeTextCount, textTemplateOptions, catalogTextLanes, loadCatalogLanes,
    textFxPreviewTracks, textFxStyleSamples, srvBase, loadTextTemplates,
    resolveKeywordHits, currentMatchTemplateIds, refreshTextFxTracks,
  } = tfx

  // AI 改写（_show_ai_rewrite_settings：ai_rewrite_temperature 默认 0.5 → 自由度 50%）
    // TTS 引擎选择与克隆参数（2026-09-09 用户裁决：文案生成设置左边加 TTS 下拉，默认 idexttts，
    //  对齐声音克隆页裁决；duration_factor/emo_text/emo_alpha 契约同 /indextts/tts，克隆时逐条随请求发送）
    // 2026-09-20 用户裁决：默认 QwenTTS（engine=qwen3）
    const ttsEngine = ref<'indextts' | 'qwen3'>('qwen3')
    const ttsDurationFactor = ref(1.0)   // 语速 0.5~2.0，默认 1.0（对齐 VoiceClone 页）
    const ttsEmoText = ref('')           // 情感文字（空=用样本默认情感）
    const ttsEmoAlpha = ref(0.5)         // 情感强度 0~1，默认 0.5
    // 句间停顿（2026-09-08 服务端新增，毫秒；0=不插标记，句间停顿由模型按标点自然处理）
    const ttsPauseMs = ref(0)
    const cloneParamsDlg = ref({ show: false, factor: 1.0, emo: '', alpha: 0.5, pause: 0, engine: 'qwen3' })
    // Qwen3-TTS 专属设置（2026-09-20 用户裁决：设置声音克隆对话框按引擎提供各自参数）
    const qwen3Speaker = ref('')
    const qwen3Instruct = ref('')
    const qwen3Voices = ref<Array<{ value: string; label: string }>>([])
    const qwen3VoicesLoading = ref(false)
    async function loadQwen3Voices(): Promise<void> {
      if (qwen3VoicesLoading.value) return
      qwen3VoicesLoading.value = true
      try {
        const res = await window.tintin.server.ttsQwen3Voices()
        const speakers = res && 'speakers' in res && Array.isArray(res.speakers) ? res.speakers : []
        qwen3Voices.value = speakers.map((v) => ({ value: String(v), label: String(v) }))
      } finally { qwen3VoicesLoading.value = false }
    }
  const editDlg = ref({ show: false, index: -1, title: '', content: '', original: '' })
  const voiceBusy = ref(false)
  // 2026-09-09 用户裁决：配音动作迁 Step4 统一合成（dubBusy/dubbingEnabled/配音弹窗随之移除）

  let offVoiceProgress: (() => void) | null = null

/** 清理口播进度监听（原 useVideoMontage 闭包槽复位口径：有则调用并置空） */
function clearVoiceProgressListener(): void {
  offVoiceProgress?.()
  offVoiceProgress = null
}

  // 批量克隆/配音整体进度（0-100）：主进程逐条 emitRow，渲染层按
  //  「已完成条数 + 当条百分比」聚合；动作行下方进度条呈现（2026-09-09 用户裁决）
  const voiceProgress = ref(0)
  let voiceTotal = 0
  let voiceDone = 0
  function nextVoiceChannel(): string {
    const ch = `voice:progress:${(crypto?.randomUUID?.() || `${Date.now()}_${Math.floor(Math.random() * 1e8)}`).replace(/-/g, '')}`
    offVoiceProgress?.(); offVoiceProgress = null
    offVoiceProgress = window.tintin?.server?.onVoiceProgress?.(ch, (d) => {
      if (d.rowIdx !== undefined && d.rowIdx >= 0) {
        const row = voiceRows.value[d.rowIdx]
        if (row) {
          if (d.value !== undefined) row.progress = d.value
          if (d.value !== undefined) row.status = d.value >= 100 ? 'done' : 'generating'
          // 2026-09-11 用户裁决「状态要实时」：完成事件随带 wavPath/时长即回写（此前
          // wavPath 只在整批返回后统一回写 → 已合成行整批期间仍显示未生成/灰字/试听禁用）
          if (d.wavPath) {
            row.wavPath = d.wavPath
            row.dubbedPath = ''
            row.voiceDurSec = d.durSec || 0
            row.status = 'done'
            row.progress = 100
          } else if (d.failed) {
            row.status = 'pending'
            row.progress = 0
          }
        }
        if (d.value !== undefined && voiceTotal > 0) {
          if (d.value >= 100 || d.failed) voiceDone++ // 失败行同样终结，计入完成数（否则总进度到不了 100）
          const frac = d.value < 100 ? d.value / 100 : 0
          voiceProgress.value = Math.min(100, Math.round(((voiceDone + frac) / voiceTotal) * 100))
        }
      }
      // Step4 统一合成：进度接通 + 成片增量上表（2026-09-12 用户反馈：服务端已合成完
      // 列表仍空——此前 final:mix 的 value 无 rowIdx 分支被丢弃致进度条不动，列表只在
      // 整批返回后填充；现 donePath 逐条追加、进度实时回写。条件排除克隆/配音链
      // （带 rowIdx / wavPath），避免 Step4 一键链本地配音段误写合成进度）
      if (finalBusy.value && d.rowIdx === undefined && !d.wavPath) {
        if (d.value !== undefined) finalProgress.value = d.value
        if (d.donePath && !finalVideoList.value.some((it) => it.path === d.donePath)) {
          finalVideoList.value = [...finalVideoList.value, { name: pathBasename(d.donePath), path: d.donePath }]
          if (!finalVideoPath.value) finalVideoPath.value = d.donePath
          finalDone.value = true
        }
      }
      if (d.stage) statusText.value = d.stage
    }) || null
    return ch
  }

  /** TTS 地址初值跟随系统设置（原版 ai_config.vox_api_url 同源等价） */
  async function ensureTtsApiUrl(): Promise<void> {
    if (ttsApiUrl.value) return
    const url = await ensureServerUrl()
    if (url) ttsApiUrl.value = url.replace(/\/$/, '') + '/indextts/tts'
  }

  /** 选择视频（原 _select_voice_dir 本地目录选择：2026-09-08 用户裁决口播配音不需要视频输入功能，删除；
   *  配音对象改为自动取 Step2 已确认合成产物所在目录，见下方 watch） */

  /** 确认产物所在目录（去重保序；2026-09-09 修复：确认合成产物可能分散在多个 outputs 目录——
   *  落盘目录跟随确认时的 splitsJobId，jobId 被重置后（清空缓存/重新分割）产物落到 session 目录，
   *  Step3 只扫第一个目录致「合成 3 个只显示 1 个」实测根因） */
  function confirmedVoiceDirs(paths: string[]): string[] {
    const dirs: string[] = []
    for (const p of paths) {
      const dir = p.slice(0, Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/')))
      if (dir && !dirs.includes(dir)) dirs.push(dir)
    }
    return dirs
  }

  /** 扫描视频目录（对照 _do_scan_voice_dir；保留已编辑文案 existing_texts 口径）。
   *  keepFiles：本次确认合成产物列表，主进程据此清理首个目录里的旧 montage_concat_* 产物
   *  （对照 _cleanup_stale_montage_outputs L597-634；不传则不清理仅扫描）。
   *  dirs：聚合扫描目录列表（2026-09-09 新增；缺省=[voiceDirInput]），
   *  确认产物分散多目录时逐目录扫描合并，配音对象目录仍取首个（voices/outputs 推导基准不变）。 */
  async function scanVoiceDir(opts?: { keepFiles?: string[]; dirs?: string[] }): Promise<void> {
    const dirs = (opts?.dirs?.length ? opts.dirs : [voiceDirInput.value]).filter((d) => d && d.trim())
    if (!dirs.length) { voiceRows.value = []; return }
    try {
      const prevTexts = new Map(voiceRows.value.map((r) => [r.path, r.text]))
      // 展开为纯数组：ref([]) 的 .value 是响应式 Proxy，ipcRenderer.invoke 结构化克隆
      //   不支持 Proxy，直接传会批「An object could not be cloned」致扫描永远失败
      //   （2026-09-08 实测：Step3 视频列表从未建成的真正根因）
      const allFiles: Array<{ path: string; name: string; originalText: string; wavPath?: string; dubbedPath?: string; durationSec?: number; voiceDurSec?: number }> = []
      let voicesDirFirst = ''
      for (let i = 0; i < dirs.length; i++) {
        const dirPath = dirs[i]
        const res = await window.tintin?.server?.voiceScanDir?.({
          dirPath,
          selectedFiles: [...selectedVoiceFiles.value],
          // keepFiles 清理只作用于首个目录（原版单目录口径）；其余目录仅扫描不清理
          keepFiles: i === 0 && opts?.keepFiles?.length ? [...opts.keepFiles] : undefined,
        })
        if (!res || 'error' in res) throw new Error((res as { error?: string })?.error || '扫描失败')
        if (!voicesDirFirst) voicesDirFirst = res.voicesDir || ''
        allFiles.push(...res.files)
      }
      // 多目录合并去重（同路径防御）
      const seen = new Set<string>()
      const files = allFiles.filter((f) => (seen.has(f.path) ? false : (seen.add(f.path), true)))
      voicesDir.value = voicesDirFirst
      voiceRows.value = files.map((f) => ({
        path: f.path,
        name: f.name,
        text: prevTexts.get(f.path) || f.originalText || '',
        originalText: f.originalText,
        status: f.wavPath ? 'done' : 'pending',
        progress: f.wavPath ? 100 : 0,
        wavPath: f.wavPath || '',
        // 配音产物重关联（2026-09-15 报障：重启后 dubbedPath 丢失 → 导出时间轴静默丢口播）
        dubbedPath: f.dubbedPath || '',
        // 2026-09-20 用户裁决：默认以声音对齐（配音为时间轴权威；行内可切回视频）
        lengthMode: 'audio' as const,
        durationSec: f.durationSec || 0,
        // 克隆音频时长（2026-09-10 报障修复：重建行时从扫描结果恢复，不再恒 0 → --:--）
        voiceDurSec: f.voiceDurSec || 0,
      }))
    } catch (e) {
      statusText.value = `扫描失败： ${errText(e)}`
    }
  }

  /** 配音视频自动就绪（2026-09-08 用户裁决：口播配音无视频输入功能）：
   *  Step2 确认合成的产物落盘后自动取其所在目录为配音对象目录并扫描，
   *  保留已编辑文案（existing_texts 口径）；文案行数随确认产物变化重建 */
  watch(
    () => assemblePlans.value.map((p) => (p.confirmed ? p.outputPath || '' : '')).join('|'),
    (sig) => {
      const paths = sig.split('|').filter(Boolean)
      if (!paths.length) return
      const first = paths[0]
      const dir = first.slice(0, Math.max(first.lastIndexOf('\\'), first.lastIndexOf('/')))
      if (!dir) return
      // 确认产物同落一个 outputs 目录：不能以「目录变化/列表为空」为重扫条件，
      // 否则第 2~N 条确认完成后不会进列表（旧守卫 bug）；签名变化即重扫，
      // 已编辑文案由 scanVoiceDir 的 prevTexts 按路径保留。
      // 2026-09-09：产物可能分散多目录（jobId 重置后落 session），聚合扫描全部目录
      voiceDirInput.value = dir
      void scanVoiceDir({ dirs: confirmedVoiceDirs(paths) })
    },
  )

  /** 进入 Step3 自动带视频（对照 _on_enter_step_3 L636-656 一比一）：
   *  取已确认合成产物所在目录 → 清理旧产物 → 回填目录并扫描。
   *  无确认产物时不动现有列表（保留原版回退语义的空态）。
   *  字幕字体列表来自服务端，进 Step3 预拉一次（对照同函数 L667-669：
   *  if not _fonts_loaded → _refresh_server_fonts；失败可用「刷新字体」重拉） */
  let fontsPreloaded = false
  let subtitleStylesPreloaded = false
  async function enterStepVoice(): Promise<void> {
    if (!fontsPreloaded) {
      fontsPreloaded = true
      void refreshFonts()
    }
    if (!subtitleStylesPreloaded) {
      subtitleStylesPreloaded = true
      void refreshSubtitleStyles()
    }
    const confirmed = assemblePlans.value
      .filter((p) => p.confirmed && p.outputPath)
      .map((p) => p.outputPath as string)
    if (!confirmed.length) return
    const first = confirmed[0]
    const dir = first.slice(0, Math.max(first.lastIndexOf('\\'), first.lastIndexOf('/')))
    if (!dir) return
    voiceDirInput.value = dir
    // 2026-09-09 修复：确认产物可能分散多目录（jobId 重置后落 session），聚合扫描全部目录
    await scanVoiceDir({ keepFiles: confirmed, dirs: confirmedVoiceDirs(confirmed) })
  }

  /** 拉取服务端声音样本库（GET /voice/samples，与 VoiceClone 页 loadCatalog 同源） */
  async function loadRefSamples(): Promise<void> {
    try {
      const raw = await window.tintin?.server?.ttsVoicesSamples?.()
      const list = Array.isArray(raw) ? raw : (extractArrayLike(raw))
      refSamples.value = list.map((s: any) => ({
        id: String(s.id ?? ''),
        name: String(s.name ?? `样本${s.id ?? ''}`),
        url: String(s.audio_url || ''),   // 契约 /voice/samples 音频字段为 audio_url；url 属猜测兜底，删除
        text: String(s.text || ''),
      }))
    } catch (_) { refSamples.value = [] /* 服务端离线时呈无样本态 */ }
  }

  /** {items|data|samples|...} 包裹响应解包（对齐 useVoiceCloneStudio extractArray 口径） */
  function extractArrayLike(res: unknown): any[] {
    if (Array.isArray(res)) return res
    if (res && typeof res === 'object') {
      const obj = res as Record<string, unknown>
      for (const key of ['items', 'data', 'samples', 'voices', 'list', 'results']) {
        if (Array.isArray(obj[key])) return obj[key] as any[]
      }
    }
    return []
  }

  /** 下拉选择：服务端样本（sample:{id}）；选中即换播放条 src（对齐 VoiceClone selectSample → loadSamplePreview） */
  function selectRefAudio(value: string): void {
    if (value.startsWith('sample:')) {
      const s = refSamples.value.find((x) => x.id === value.slice(7))
      if (!s) return
      selectedRefSample.value = { id: s.id, url: s.url }
      refAudioPath.value = ''
      refAudioLabel.value = s.name
      // 对齐 VoiceClone 页 selectSample：自动填充样本参考文字
      if (s.text) refText.value = s.text
      // 播放条地址：服务端相对路径拼绝对 URL（直连服务端，媒体栈自行加载，无 base64/blob 中间环节）
      if (!s.url) { refPreviewUrl.value = ''; return }
      refPreviewUrl.value = /^https?:/i.test(s.url)
        ? s.url
        : serverUrl.value.replace(/\/$/, '') + (s.url.startsWith('/') ? s.url : '/' + s.url)
      if (!serverUrl.value) void ensureServerUrl().then(() => {
        const cur = selectedRefSample.value
        if (cur?.url && !/^https?:/i.test(cur.url)) {
          refPreviewUrl.value = serverUrl.value.replace(/\/$/, '') + (cur.url.startsWith('/') ? cur.url : '/' + cur.url)
        }
      })
    } else {
      selectedRefSample.value = null
      refAudioLabel.value = refSamples.value.length ? '请选择声音样本' : '未找到预设声音样本'
    }
  }

  /** 底部上传新样本（对齐 VoiceClone onUploadNewSample：音频+名称+文字 → 服务端
   *  POST /voice/samples → 刷新下拉并自动选中；2026-09-08 用户裁决与声音克隆页同口径，
   *  不再是行内「选择本地文件」仅本地路径的旧交互） */
  const nsFilePath = ref('')
  const nsName = ref('')
  const nsText = ref('')
  const nsError = ref('')
  const nsSuccess = ref('')
  const nsBusy = ref(false)
  const nsTranscribing = ref(false)

  function pickNewSampleFile(): void {
    void (async () => {
      try {
        const p = await window.tintin?.dialog?.openFile?.({
          title: '选择音频文件上传为样本',
          filters: [{ name: '音频', extensions: ['mp3', 'wav', 'm4a', 'flac', 'aac', 'ogg'] }, { name: 'All Files', extensions: ['*'] }],
        })
        if (!p) return
        nsFilePath.value = p
        const base = pathBasename(p).replace(/\.[^.]+$/, '')
        if (base && !nsName.value) nsName.value = base
      } catch (_) { /* 取消 */ }
    })()
  }

  /** 上传样本时 ASR 识别音频文字（VoiceClone transcribeForNewSample 同款） */
  function transcribeNewSample(): void {
    void (async () => {
      if (!nsFilePath.value) return
      nsTranscribing.value = true
      nsError.value = ''
      try {
        const res = await window.tintin.server.asrTranscribe({
          audio: { path: nsFilePath.value } as unknown as Blob,
          language: 'zh',
          format: 'txt',
        } as any)
        if (!res || (res as any).error) throw new Error((res as any)?.error || '识别失败')
        nsText.value = (typeof res === 'string' ? res : (res as any).text || '').trim()
      } catch (err) {
        nsError.value = `文字识别失败：${errText(err)}`
      } finally {
        nsTranscribing.value = false
      }
    })()
  }

  function uploadNewSampleRef(): void {
    void (async () => {
      nsError.value = ''
      nsSuccess.value = ''
      if (!nsFilePath.value) { nsError.value = '请先选择音频文件'; return }
      if (!nsName.value.trim()) { nsError.value = '请输入样本名称'; return }
      nsBusy.value = true
      try {
        const res = await window.tintin.server.ttsUploadSample({
          file: { path: nsFilePath.value } as unknown as Blob,
          name: nsName.value.trim(),
          text: nsText.value.trim() || '',
        } as any)
        if (!res || (res as any).error) throw new Error((res as any)?.error || '上传失败')
        const newId = String((res as any)?.id || '')
        await loadRefSamples()
        if (newId) selectRefAudio(`sample:${newId}`)
        nsSuccess.value = `样本「${nsName.value}」上传成功，已自动选中`
        nsFilePath.value = ''
        nsName.value = ''
        nsText.value = ''
      } catch (err) {
        nsError.value = errText(err)
      } finally {
        nsBusy.value = false
      }
    })()
  }

  /** 设置声音克隆弹窗（对齐声音克隆页 IndexTTS 参数：语速/情感/情感强度；保存后克隆时生效。
   *  句间停顿：2026-09-08 服务端新增 ((pause=毫秒)) 标记口径） */
  function openCloneParams(): void {
    cloneParamsDlg.value = { show: true, factor: ttsDurationFactor.value, emo: ttsEmoText.value, alpha: ttsEmoAlpha.value, pause: ttsPauseMs.value, engine: ttsEngine.value }
    // QwenTTS 时预载预置音色列表（2026-09-20 用户裁决）
    if (ttsEngine.value === 'qwen3' && !qwen3Voices.value.length) void loadQwen3Voices()
  }
  function closeCloneParams(): void { cloneParamsDlg.value.show = false }
  function saveCloneParams(): void {
    ttsDurationFactor.value = cloneParamsDlg.value.factor
    ttsEmoText.value = cloneParamsDlg.value.emo
    ttsEmoAlpha.value = cloneParamsDlg.value.alpha
    ttsPauseMs.value = cloneParamsDlg.value.pause
    ttsEngine.value = cloneParamsDlg.value.engine as 'indextts' | 'qwen3'
    cloneParamsDlg.value.show = false
  }

  // 停止批量克隆（2026-09-23 用户裁决：串行批次可中止——当前条完成后停止，
  // 剩余条保持待合成可直接重试；语音合成串行+3 次重试+恢复等待，服务端无响应时
  // 不再被迫等全批跑完）
  const voiceStopRequested = ref(false)
  let activeCloneChannel = ''
  function stopVoiceClone(): void {
    if (!voiceBusy.value || !activeCloneChannel) return
    voiceStopRequested.value = true
    try { void window.tintin?.server?.voiceCloneBatchStop?.({ progressChannel: activeCloneChannel }) } catch (_) {}
  }
  /** 单条/批量克隆人声（对照 _start_synthesize_voice + VoiceCloneWorker.run） */
  async function runCloneBatch(rowIdxs: number[]): Promise<{ ok: number; failures: Array<{ rowIdx: number; msg: string }> }> {
    const tasks = rowIdxs
      .filter((i) => voiceRows.value[i]?.text.trim())
      .map((i) => ({
        rowIdx: i,
        text: voiceRows.value[i].text.trim(),
        videoPath: voiceRows.value[i].path,
        outWavPath: joinPath(voicesDir.value, `voice_${i + 1}.wav`),
      }))
    voiceBusy.value = true
    voiceStopRequested.value = false
    voiceTotal = tasks.length; voiceDone = 0; voiceProgress.value = 0
    const channel = nextVoiceChannel()
    activeCloneChannel = channel
    try {
      const res = await window.tintin?.server?.voiceCloneBatch?.({
        tasks,
        refAudioPath: refAudioPath.value,
        // 2026-09-20 用户裁决：传 sample_id 走样本库渠道——服务端用库内样本并自动补
        // ref_text，主进程不再重复下载样本音频转 b64（省带宽；0=未选样本 → Base 音色）
        sampleId: Number(selectedRefSample.value?.id || 0),
        refAudioUrl: selectedRefSample.value?.url || '',
        apiUrl: ttsApiUrl.value,
        speedMin: ttsSpeedMin.value,
        speedMax: ttsSpeedMax.value,
        // 克隆参数（「设置声音克隆」弹窗配置；主进程展开进 /indextts/tts 载荷）
        ttsParams: {
          durationFactor: ttsDurationFactor.value,
          emoText: ttsEmoText.value,
          emoAlpha: ttsEmoAlpha.value,
          pauseMs: ttsPauseMs.value,
          // Qwen3-TTS 专属（2026-09-20 用户裁决）：预置音色/指令文本随批次下发
          speaker: qwen3Speaker.value,
          instruct: qwen3Instruct.value,
        },
        engine: ttsEngine.value,
        refText: refText.value,
        progressChannel: channel,
      })
      if (!res) throw new Error('主进程不可达')
      if ('error' in res) throw new Error(res.error)
      if ((res as { stopped?: boolean }).stopped) {
        statusText.value = '已停止声音克隆：剩余条保持待合成，可直接重试'
      }
      // 回写已生成 wav（generated_voice_paths 口径）+ 状态
      for (const t of tasks) {
        const wav = res.results[t.videoPath]
        if (wav && voiceRows.value[t.rowIdx]) {
          voiceRows.value[t.rowIdx].wavPath = wav
          // 重新克隆 = 旧配音失效（Step4 一键链检测到缺 dubbedPath 会自动重配）
          voiceRows.value[t.rowIdx].dubbedPath = ''
          voiceRows.value[t.rowIdx].status = 'done'
          voiceRows.value[t.rowIdx].progress = 100
          // 克隆音频时长（voice_audio_durations 口径，行内绿字）
          voiceRows.value[t.rowIdx].voiceDurSec = res.durations?.[t.videoPath] || 0
        } else if (voiceRows.value[t.rowIdx]) {
          voiceRows.value[t.rowIdx].status = 'pending'
          voiceRows.value[t.rowIdx].progress = 0
        }
      }
      // 2026-09-18 用户裁决：字幕重切段后处理在声音克隆完成后立即执行——逐条成功
      //   克隆生成 SRT 资产（LLM 重切段 + timing 映射）落 srt/，供本地剪映导出与
      //   服务端合成 subtitle_srt 上传消费；best-effort，失败不阻断克隆结果
      for (const t of tasks) {
        const wav = res.results[t.videoPath]
        if (wav) await ensureProcessedSrt(t.text, wav, t.videoPath)
      }
      return { ok: Object.keys(res.results).length, failures: res.failures }
    } finally {
      voiceBusy.value = false
      voiceStopRequested.value = false
      offVoiceProgress?.(); offVoiceProgress = null
    }
  }

  /** 开始批量克隆人声合成（对照 _start_synthesize_voice 弹窗逐字） */
  async function startSynthesizeVoice(): Promise<void> {
    if (voiceBusy.value) return
    await ensureTtsApiUrl()
    if (!refAudioPath.value && !selectedRefSample.value?.url) {
      notify('未选择声音样本', '请先选择或上传声音样本 (wav/mp3/m4a)！')
      return
    }
    if (!voiceDirInput.value) {
      notify('路径无效', '请选择有效的视频输入目录。')
      return
    }
    // 2026-09-23 用户裁决：批量克隆=补齐未生成的条目（断点续跑）——已生成（wavPath 在）
    // 的行跳过，配合「停止克隆」实现中断后续跑；单行重做走行内「重新生成」
    const idxs = voiceRows.value
      .map((_, i) => i)
      .filter((i) => voiceRows.value[i].text.trim() && !voiceRows.value[i].wavPath)
    if (!idxs.length) {
      if (voiceRows.value.some((r) => r.text.trim() && r.wavPath)) {
        notify('已全部生成', '所有带文案的条目都已有克隆音频。如需重做某条，请使用该行的「重新生成」。')
        return
      }
      notify('文案为空', '没有检测到任何有配音文案的视频。请在表格的“配音文案”栏输入内容。')
      return
    }
    const { ok, failures } = await runCloneBatch(idxs)
    statusText.value = '完成： 克隆人声音频生成完成！'
    if (failures.length) {
      statusText.value = `注意： 合成完成：成功 ${ok} 个，失败 ${failures.length} 个（已跳过）`
      const detail = failures.slice(0, 8).map((f) => `· 第 ${f.rowIdx + 1} 个：${f.msg}`).join('\n')
      const more = failures.length <= 8 ? '' : `\n…… 等共 ${failures.length} 个失败`
      notify(
        '部分合成失败',
        `批量人声克隆完成：成功 ${ok} 个，失败 ${failures.length} 个（已跳过，可单独重试）。\n\n${detail}${more}\n\n提示：失败多为 VoxCPM 显存不足/文案过长，可重启服务或缩短该条文案后重试。`,
      )
    } else {
      notify('合成成功', `批量人声克隆合成完毕，共生成 ${ok} 个音频文件。`)
    }
  }

  /** Step4 一键链·配音阶段（原 startDubVideos 内核；2026-09-09 用户裁决：配音动作自
   *  Step3 迁入 Step4 统一合成时自动执行——纯化配音不烧特效（特效在 final:mix 阶段），
   *  完成回写 dubbedPath，不再弹配音完成弹窗；失败抛错由 startFinalMix 统一上报） */
  async function runDubBatch(): Promise<void> {
    if (!voiceDirInput.value) throw new Error('视频输入目录无效，请先回到第②步确认合成产物')
    // 2026-09-20 撤销此前「qwen3 缺 ref_text 前置拦截」：Base/CustomVoice 模式本就不需要
    // ref_text；克隆模式走 sample_id 渠道时服务端从样本库自动补参照文字，缺口由服务端
    // 显式 400（报错含双渠道指引）。客户端不做冗余硬拦。
    const dubbedDir = joinPath(resolveOutMontageDir(voiceDirInput.value), 'dubbed')
    const tasks = voiceRows.value
      .filter((r) => r.wavPath && r.path)
      .map((r) => ({
        videoPath: r.path,
        voiceWavPath: r.wavPath,
        outVideoPath: joinPath(dubbedDir, `dubbed_${r.name}`),
        text: r.text.trim(),
      }))
    if (!tasks.length) return
    voiceTotal = tasks.length; voiceDone = 0; voiceProgress.value = 0
    const channel = nextVoiceChannel()
    try {
      // 纯化配音：字幕/花字特效已在 final:mix 统一烧制，此处不传任何特效配置
      const res = await window.tintin?.server?.voiceDubVideos?.({
        tasks,
        lengthModes: Object.fromEntries(voiceRows.value.map((r) => [r.path, r.lengthMode])),
        progressChannel: channel,
      })
      if (!res) throw new Error('主进程不可达')
      if ('error' in res) throw new Error(res.error)
      // 回写配音后视频（dubbed_video_paths 口径）
      for (const [vid, dubbed] of Object.entries(res.results)) {
        const row = voiceRows.value.find((r) => r.path === vid)
        if (row) row.dubbedPath = dubbed
      }
    } finally {
      offVoiceProgress?.(); offVoiceProgress = null
    }
  }

  /** 选定字体族名（对照 _selected_subtitle_font：itemData 空 → 未指定） */
  function selectedFontFamily(): string {
    const opt = fontOptions.value.find((o) => o.value === subtitleFont.value)
    return opt ? opt.value : ''
  }

  // ---- 字体自渲染设施（2026-09-09 裁决：字幕三行改造，下拉/预览按各自字体渲染，图2）----
  // fontId → 服务端族名（CSS font-family 回退链用）；FontFace 注册为 'stfont_<id>'
  //  独立族名，避免与本地同名字体冲突；fontFacesVersion 驱动样式重算。
  const serverFontFamilies = new Map<string, string>()
  const fontFaceLoaded = new Set<string>()
  const fontFacePending = new Set<string>()
  const fontFacesVersion = ref(0)

  /** 预载服务端字体文件并注册 FontFace（voice:fontFile → GET /config/fonts/{id}/file） */
  async function ensureServerFontFace(fid: string): Promise<void> {
    if (!fid || fontFaceLoaded.has(fid) || fontFacePending.has(fid)) return
    fontFacePending.add(fid)
    try {
      const res = await window.tintin?.server?.voiceFontFile?.(fid)
      const buf = res && !('error' in res) && res.data ? res.data : null
      if (buf) {
        // 断言说明：IPC 结构化克隆后的字节载体必为普通 ArrayBuffer（非 SharedArrayBuffer），
        //  TS 泛型 ArrayBufferLike 无法窄化，故这里显式断言为 BufferSource
        const ff = new FontFace(`stfont_${fid}`, buf as unknown as BufferSource)
        await ff.load()
        document.fonts.add(ff)
        fontFaceLoaded.add(fid)
        fontFacesVersion.value++
      }
    } catch (_) {
      // 字体文件拉取失败：保留族名回退链，不阻断 UI
    } finally {
      fontFacePending.delete(fid)
    }
  }

  /** 字体选项的 CSS font-family（stfont_ 注册族 → 服务端族名 → sans-serif） */
  function fontOptionCssFamily(fid: string): string {
    if (!fid) return ''
    const family = (serverFontFamilies.get(fid) || '').replace(/'/g, '')
    return `'stfont_${fid}'${family ? `, '${family}'` : ''}, sans-serif`
  }

  /** TSelect optionStyle：字体下拉/触发器按所选字体自渲染；顺带惰性预载字体文件 */
  function fontOptionStyle(opt: { label: string; value: string | number }): Record<string, string> | undefined {
    const fid = String(opt.value || '')
    if (!fid) return undefined
    void fontFacesVersion.value
    void ensureServerFontFace(fid)
    return { fontFamily: fontOptionCssFamily(fid) }
  }

  /** 字幕效果预览（行3）：选中预设的 CSS 近似（描边 paintOrder）+ 选中字体 + 背景框 */
  const selectedSubtitlePreset = computed<SubtitleStylePreset>(
    () => subtitleStylePresets.value.find((p) => p.key === subtitleStyleKey.value) || subtitleStylePresets.value[0]
  )
  const subtitlePreviewStyle = computed<Record<string, string>>(() => {
    void fontFacesVersion.value
    const st = subtitlePresetTileStyle(selectedSubtitlePreset.value)
    // 2026-09-18：预览字号随「字号」设置同比例缩放（10 号→18px=原观感基准）
    st.fontSize = `${Math.round(subtitleFontSize.value * 1.8)}px`
    st.fontWeight = '700'
    st.lineHeight = '1.5'
    st.textAlign = 'center'
    if (subtitleFont.value) st.fontFamily = fontOptionCssFamily(subtitleFont.value)
    if (addSubtitles.value && subtitleBgOpacity.value > 0) {
      st.background = `rgba(0,0,0,${subtitleBgOpacity.value})`
    }
    return st
  })

  /** 刷新字体（对照 _refresh_server_fonts：失败降级空列表不阻断） */
  async function refreshFonts(): Promise<void> {
    if (fontsLoading.value) return
    fontsLoading.value = true
    try {
      const res = await window.tintin?.server?.voiceFonts?.()
      const fonts = res && !('error' in res) ? res.fonts || [] : []
      // 对照 _populate_font_combo：首项「默认（不指定字体）」；同族多字重追加文件名区分
      const items: Array<{ label: string; value: string }> = [{ label: '默认（不指定字体）', value: '' }]
      const seen = new Set<string>()
      for (const f of fonts) {
        const fid = String(f.id || '').trim()
        const family = String(f.family || f.filename || '').trim()
        if (!fid || !family) continue
        serverFontFamilies.set(fid, family)
        const label = seen.has(family) && f.filename ? `${family}（${f.filename}）` : family
        seen.add(family)
        items.push({ label, value: fid })
      }
      fontOptions.value = items
      // 后台按序预载字体文件（自渲染下拉需要；FontFace 注册一次后 document.fonts 缓存复用）
      void items.slice(1).reduce(
        (p, it) => p.then(() => ensureServerFontFace(it.value)),
        Promise.resolve()
      )
      if (!subtitleFont.value) subtitleFont.value = ''
      statusText.value = items.length > 1
        ? `已从服务端加载 ${items.length - 1} 个字体`
        : '服务端未返回字体，字幕将使用默认字体'
    } catch (_) {
      statusText.value = '拉取服务端字体失败，字幕将使用默认字体'
    } finally {
      fontsLoading.value = false
    }
  }

  /** 刷新字幕样式（2026-09-17 用户裁决：字幕样式统一来自服务端 /subtitle_styles）。
   *  失败降级兆底预设（SUBTITLE_STYLE_PRESETS_FALLBACK），不阻断 UI。 */
  async function refreshSubtitleStyles(): Promise<void> {
    try {
      const res = await window.tintin?.server?.voiceSubtitleStyles?.()
      const styles = res && !('error' in res) ? res.styles || [] : []
      if (styles.length) {
        subtitleStylePresets.value = serverStylesToPresets(styles)
        // 默认选中第一个（或保持当前选中，若仍在列表中）
        if (!subtitleStyleKey.value || !subtitleStylePresets.value.some((p) => p.key === subtitleStyleKey.value)) {
          subtitleStyleKey.value = subtitleStylePresets.value[0]?.key || ''
        }
      }
    } catch (_) {
      // 降级兆底预设，不阻断
    }
  }

  /** 花字模板列表 + 预览图（对照 _start_fancy_preview_loader / _update_fancy_template_preview）。
   *  2026-09-09 对齐核实：服务端 GET /fancy/templates 返回的剪映系模板与本地同格式
   *  （style 即 ffmpeg drawtext 样式串），可直接进本地配音烧制链；来源标记仅用于
   *  UI 后缀展示。预览图：服务端模板与本地同一 ffmpeg drawtext 预览口径。
   *  服务端离线/失败回退本地 resources/fancy/templates。 */
  async function loadFancyTemplates(): Promise<void> {
    if (fancyTemplatesLoading.value) return
    fancyTemplatesLoading.value = true
    try {
      // 服务端模板库（宽容解析：items 包裹/数组直收；离线 null）
      const sr = await window.tintin?.server?.fancyServerTemplates?.()
      const serverItems: FancyTemplateItem[] = sr && !('error' in sr) && Array.isArray(sr.templates)
        ? sr.templates.map((t) => ({
            ...t,
            // 防御：服务端模板 style 必为 drawtext 样式串，缺省置空（不可进烧制链时预览/烧制自动降级）
            style: String((t as Record<string, unknown>).style ?? ''),
            origin: 'server' as const,
            anim: '',
            hasSound: !!(t as Record<string, unknown>).sound,
          }))
        : []
      // 本地模板（服务端不可用时的回退集）
      const res = await window.tintin?.server?.fancyListTemplates?.()
      const localItems: FancyTemplateItem[] = res && !('error' in res)
        ? res.templates.map((t) => ({ ...t, origin: 'local' as const }))
        : []
      fancyTemplates.value = [...serverItems, ...localItems]
      fancyPreviews.value = res && !('error' in res) ? { ...res.previews } : {}
      // 本地+服务端缺失预览图后台补齐（同一 drawtext 预览口径；服务端模板传 dict 生成）
      const r2 = await window.tintin?.server?.fancyEnsurePreviews?.(
        serverItems.length ? { templates: serverItems.map((t) => ({ ...t })) } : undefined,
      )
      if (r2 && !('error' in r2) && r2.generated > 0) {
        fancyPreviews.value = { ...fancyPreviews.value, ...r2.previews }
      }
      if (serverItems.length) {
        statusText.value = `已从服务端加载 ${serverItems.length} 个花字模板`
      }
    } catch (_) { /* 模板加载失败不阻断页面 */ } finally {
      fancyTemplatesLoading.value = false
    }
  }

  /** 选定模板 dict（模板优先：样式/动画/音效以模板为准；未选/未勾选返回 null=自定义样式） */
  const selectedFancyTemplate = computed(() => {
    if (!fancyEnabled.value || !fancyTemplateId.value) return null
    return fancyTemplates.value.find((t) => t.template_id === fancyTemplateId.value) || null
  })

  /** 双击文案 → 弹窗编辑（对照 _on_edit_double_clicked → TextEditDialog） */
  function openEditDlg(index: number): void {
    const row = voiceRows.value[index]
    if (!row) return
    editDlg.value = {
      show: true,
      index,
      title: `编辑第 ${index + 1} 行配音文案`,
      content: row.text,
      original: row.originalText,
    }
  }
  function saveEditDlg(): void {
    const i = editDlg.value.index
    if (i >= 0 && voiceRows.value[i]) voiceRows.value[i].text = editDlg.value.content
    editDlg.value.show = false
  }

  /** 导出克隆声音（对照 _on_btn_export_clicked：保存对话框 + copy2 + 成功提示） */
  async function exportVoice(index: number): Promise<void> {
    const row = voiceRows.value[index]
    if (!row?.wavPath) return
    try {
      const savePath = await window.tintin?.dialog?.saveFile?.({
        title: '导出克隆声音',
        defaultPath: pathBasename(row.wavPath),
        filters: [{ name: 'Audio Files', extensions: ['wav'] }, { name: 'All Files', extensions: ['*'] }],
      })
      if (!savePath) return
      const r = await window.tintin?.server?.voiceExportAudio?.({ srcPath: row.wavPath, savePath })
      if (r && 'error' in r) throw new Error(r.error)
      notify('导出成功', `人声音频成功导出至：\n${savePath}`)
    } catch (e) {
      clientError('video-montage', '导出人声音频失败', e)
      notify('导出失败', errText(e))
    }
  }

  /** 行播放视频：配音后优先（对照 _on_play_row_video L6725-6733）→ 内置播放器 */
  function playRowVideo(index: number): void {
    const row = voiceRows.value[index]
    if (!row) return
    const target = (row.dubbedPath && row.dubbedPath.endsWith('.mp4')) ? row.dubbedPath : row.path
    if (target) previewUrl.value = target
  }

  /** 播放配音后的视频（对照 btn_play_dubbed：仅已生成时可用）→ 内置播放器 */
  function playDubbedVideo(index: number): void {
    const row = voiceRows.value[index]
    if (row?.dubbedPath) previewUrl.value = row.dubbedPath
  }

  /** 时长模式切换（对照 btn_length_mode toggle：video↔audio + tooltip 两态） */
  function toggleLengthMode(index: number): void {
    const row = voiceRows.value[index]
    if (row) row.lengthMode = row.lengthMode === 'video' ? 'audio' : 'video'
  }

  function lengthModeTip(row: VoiceRow): string {
    return row.lengthMode === 'video'
      ? '以视频长度为准（点击切换为以音频长度为准）'
      : '以音频长度为准，视频不够用最后一帧补足（点击切回）'
  }

  /** 仅重新生成该声音（对照 _on_btn_regen_clicked：空文案弹窗 + 单条合成） */
  async function regenVoice(index: number): Promise<void> {
    const row = voiceRows.value[index]
    if (!row) return
    if (!row.text.trim()) {
      notify('配音文案为空', '该行文案为空，无法生成克隆人声。')
      return
    }
    await ensureTtsApiUrl()
    await runCloneBatch([index])
  }

  return {
    voiceDirInput, selectedVoiceFiles, voicesDir, voiceRows,
    // Qwen3-TTS 专属（2026-09-20 用户裁决）
    qwen3Speaker, qwen3Instruct, qwen3Voices, qwen3VoicesLoading, loadQwen3Voices,
    refSamples, selectedRefSample, refAudioPath, refAudioLabel, refPreviewUrl, refText,
    ttsApiUrl, ttsSteps, ttsCfg, ttsSpeedMin, ttsSpeedMax,
    addSubtitles, subtitleFont, fontOptions, fontsLoading,
    fancyEnabled, fancyStyle, subtitleStyleKey, subtitleStylePresets, subtitleAnimKey,
    subtitleFontSize, fancyPosition, subtitleBgOpacity, fancyTemplateId, fancyTemplates,
    fancyPreviews, fancyTemplatesLoading, textFxEnabled, lutRestore, lutId, lutList,
    lutListLoading, textTemplateId, textRandomCount, textKeywordDensity, textTemplates,
    textTemplatesLoading, activeTextPool, activeTextCount, textTemplateOptions,
    textFxPreviewTracks, textFxStyleSamples, srvBase,
    ttsEngine, ttsDurationFactor, ttsEmoText, ttsEmoAlpha, ttsPauseMs, cloneParamsDlg,
    editDlg, voiceBusy, voiceProgress, voiceStopRequested, stopVoiceClone,
    loadLuts, loadCatalogLanes, resolveKeywordHits,
    currentMatchTemplateIds, refreshTextFxTracks, loadTextTemplates, ensureTtsApiUrl,
    nextVoiceChannel, clearVoiceProgressListener, scanVoiceDir, enterStepVoice,
    loadRefSamples, selectRefAudio, pickNewSampleFile, transcribeNewSample,
    nsFilePath, nsName, nsText, nsError, nsSuccess, nsBusy, nsTranscribing,
    uploadNewSampleRef, startSynthesizeVoice, runDubBatch, runCloneBatch,
    selectedFontFamily, ensureServerFontFace, fontOptionStyle, selectedSubtitlePreset,
    subtitlePreviewStyle, refreshFonts, refreshSubtitleStyles, loadFancyTemplates,
    selectedFancyTemplate, openEditDlg, saveEditDlg, exportVoice, playRowVideo,
    playDubbedVideo, toggleLengthMode, lengthModeTip, regenVoice,
    openCloneParams, closeCloneParams, saveCloneParams,
  }
}

/** 花字模板项（fancyListTemplates 返回字段；PR#4 对照 utils/fancy_templates.py） */
export type FancyTemplateItem = Record<string, unknown> & {
  template_id: string
  name: string
  style: string
  anim: string
  hasSound: boolean
  /** 模板来源（2026-09-09 服务端对接）：server=GET /fancy/templates 模板库；local=本地 resources/fancy */
  origin?: 'server' | 'local'
  /** 服务端模板描述（textfx 模板无本地预览图，UI 显描述文字） */
  description?: string
  category?: string
}

// TSelect 选项最小结构已随 Step2（TRANSITIONS）迁 montage/useMontageStep2Concat.ts
