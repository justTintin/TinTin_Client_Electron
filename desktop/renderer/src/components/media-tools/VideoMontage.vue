<script setup lang="ts">
// ═══════════════════════════════════════════════════════════════
// VideoMontage.vue — 智能混剪·服务端四步向导（M8 条目⑥ UI 层）
// 四步（对照原客户端 gui/video_montage_page.py steps_text L257，严格一致）：
//   1.素材解析(镜头智能分割) → 2.AI 编排(镜头重组) → 3.口播配音 → 4.合成(特效包装)
// 链路全部走服务端：montage:split / montage:concat / montage:bgm
// 注：原客户端「卡点成片」属独立「一键成片」页（compile_video_page.py tab3，
//     BeatMontageController），不在智能混剪向导内，本端亦不纳入。
// 组件只绘制 + 事件转发；选段/载荷/轮询/下载业务全部在 useVideoMontage
// （纯函数 videoMontageLogic.ts，IRON-06/07 分层）。
// 闭环口径：提交 → 轮询 → 结果下载/打开目录 → 失败重试（重按按钮即重试）。
// ═══════════════════════════════════════════════════════════════
import { ref, reactive, computed, onMounted, onActivated, onUnmounted, watch, nextTick } from 'vue'
import TButton from '@/components/common/TButton.vue'
import TSelect from '@/components/common/TSelect.vue'
import VideoPreview from '@/components/common/VideoPreview.vue'
// import VideoPlayer 已移除：Step4 成片预览由统一右栏 StepPreviewPane 接管（2026-09-10 界面统一）
import { useVideoMontage } from '@/composables/useVideoMontage'
import { useAudioGen } from '@/composables/useAudioGen'
import { useFilePicker } from '@/composables/useFilePicker'
import WbPickProductPanel from '@/components/workbench/WbPickProductPanel.vue'
import StepPreviewPane, { type StepPreviewItem, type StepPreviewKeyword } from './StepPreviewPane.vue'
import VdStepBar from './VdStepBar.vue'
import { markdownListLines } from '@/composables/opsProductLibraryLogic'
import { copyPreviewText, subtitlePresetTileStyle, FANCY_STYLE_PREVIEW, fancyDrawtextToPreview } from '@/composables/videoMontageLogic'
import type { PickerItem } from '@/composables/useWorkbenchPickers'

// 步骤条文案对照原客户端 gui/video_montage_page.py steps_text L257，严格一致
const STEPS = ['1. 镜头智能分割', '2. 镜头重组', '3. 口播配音', '4. 特效包装']
const step = ref(0)
function go(i: number) {
  step.value = Math.max(0, Math.min(STEPS.length - 1, i))
  // 第③步：自动带视频（_on_enter_step_3 L636-656 口径：取确认产物目录→清理旧产物→扫描）
  if (i === 2) void enterStepVoice()
  // 第④步：待混音数量 stage 提示（_go_to_step index==3 L388-395 同口径）
  if (i === 3) void enterStep4()
}

const {
  // 共享
  polling, activeTaskId, statusText, cancelPolling, concatProgress,
  // Step1 素材解析（镜头智能分割）
  srcVideos, srcDurations, threshold, minSceneLen, imageDuration,
  scenes, scoreFilter, filteredScenes, checkedCount,
  splitBusy, splitError, splitMsg, splitProgress, splitResolution,
  selectFolder, onDrop, removeVideo, runSplit,
  updateSceneDesc, previewSourceVideo, previewScene, closePreview, clearSplitCache,
  previewUrl, previewTranscoding, openSplitsDir, splitsDownloading,
  // Step2 镜头重组
  assembleLogic, concatLayout, durationLimit, DURATION_LIMITS, batchCount, recBatchCount,
  concatFps, FPS_OPTIONS, splitFps,
  concatTransition, edgeSpeedup, EDGE_SPEEDUP_OPTIONS, TRANSITIONS,
  concatBusy, confirmBusy, copyBusy, concatError,
  assemblePlans, currentPlanIdx, currentPlan, hasUnconfirmed, confirmedPaths,
  runConcat, planRowText, selectPlan,
  onDetailDragStart, onDetailDragEnd, onDetailDrop, toggleClipDeleted,
  confirmAllPrecompose, confirmPlanSingle,
  openProductDlg, productDlg, closeProductDlg, productDlgGenerate,
  copyViewDlg, viewPlanCopy, closeCopyView,
  planMenu, openPlanMenu, closePlanMenu,
  seqClips, seqIdx, seqSrc,
  onSeqEnded,
  concatResults,
  // Step3 口播配音（对照 step3_voice_view.py 逐控件）
  voiceDirInput, voiceRows,
  refSamples, selectedRefSample, refAudioPath, refText, refPreviewUrl, loadRefSamples,
  nsFilePath, nsName, nsText, nsError, nsSuccess, nsBusy, nsTranscribing,
  transcribeNewSample, uploadNewSampleRef,
  ttsApiUrl, ttsSteps, ttsCfg, ttsSpeedMin, ttsSpeedMax,
  addSubtitles, subtitleFont, fontOptions, fontsLoading, refreshFonts,
  // 字幕样式（2026-09-17 用户裁决：字幕样式统一来自服务端 /subtitle_styles）
  subtitleStyleKey, subtitleStylePresets, subtitlePreviewStyle, fontOptionStyle,
  subtitleAnimKey,
  subtitleFontSize,
  fancyEnabled, fancyStyle, fancyPosition, subtitleBgOpacity,
  // 文字模板（2026-09-09 裁决：服务端 textfx 体系，与花字独立；随机样式默认 3 个）
  lutRestore, lutId, lutList, lutListLoading, loadLuts, textFxEnabled, textTemplateId, textTemplateOptions, textTemplates,
  textRandomCount, textKeywordDensity, TEXT_RANDOM_COUNT_OPTIONS, TEXT_KEYWORD_DENSITY_OPTIONS,
  textFxPreviewTracks, textFxStyleSamples, loadTextTemplates,
  voiceProgress,
  fancyTemplateId, fancyTemplates, fancyPreviews,
  loadFancyTemplates,
  FANCY_STYLE_OPTIONS, FANCY_POSITION_OPTIONS, SUBTITLE_BG_OPTIONS, AI_REWRITE_DESC,
  aiRewriteDlg, openRewriteSettings, closeRewriteSettings, saveRewriteSettings,
  ttsEngine, ttsDurationFactor, ttsEmoText, ttsEmoAlpha, ttsPauseMs,
  cloneParamsDlg, openCloneParams, closeCloneParams, saveCloneParams,
  editDlg, openEditDlg, saveEditDlg,
    voiceBusy, rewriteBusy,
  scanVoiceDir, enterStepVoice,
    batchAiRewrite, startSynthesizeVoice,
  regenVoice, exportVoice, playDubbedVideo,
  toggleLengthMode, lengthModeTip,
  voiceStatusText, voiceStatusClass, pathBasename,
  // Step4 特效包装（对照 step4_final_view.py 逐控件）
  bgmPath, bgmName, bgmVolume, finalBusy, finalMode, finalDone, finalProgress,
  exportBusy, exportProgress, exportStage, // 2026-09-16：导出剪映时间轴进度
  lastExportDraftPath, // 2026-09-16：导出成功后草稿目录路径
  exportJianyingPackageDraft, // 轨 2（2026-09-17）：导入服务端草稿包
  finalVideoList, finalSelIdx,
  bgmSource,
  bgmPlaying, bgmPosMs, bgmDurMs,
  pickBgm, applyLibraryBgm, toggleBgmPlay, stopBgmPlay, onBgmVolumeInput, seekBgm,
  enterStep4, startFinalMix, openFinalDir, openExportDraftDir,
  exportAllToJianyingDraft, step4Candidates, toAbsolute: vdToAbsolute,
  fmtBgmTime,
  selectRefAudio,
  fmtDur,
  planDurText,
  // 景别分类
  SHOT_TYPE_LABELS, SHOT_TYPE_COLORS,
} = useVideoMontage()

// ── 界面统一+联动预览（2026-09-10 用户需求）：Step2/3/4 右栏统一多块视频预览 ──
/** 本地路径 → file URL（previewFinalVideo 同口径） */
function toFileUrl(p: string): string {
  return 'file:///' + encodeURI(String(p).replace(/\\/g, '/')).replace(/#/g, '%23')
}

/** 预览块画幅（2026-09-11 用户裁决）：竖屏模式下预览块也竖起来，不再是横向块里
 *  嵌竖条（两侧大片黑边）。口径与 Step2「输出画幅」+ layoutSize 兜底完全同步：
 *  vertical → 9/16；horizontal → 16/9；source → 分割片段分辨率（splitResolution，
 *  2026-09-15 用户裁决：基准=分割片段而非原素材）；
 *  source 拿不到 → 9/16（layoutSize 对 source 无效探测的兜底即 1080x1920）。
 *  三步右栏共用同一比例（Step3/4 预览的都是本链路成片，画幅同源） */
const previewAspect = computed(() => {
  const layout = concatLayout.value
  if (layout === 'vertical') return '9 / 16'
  if (layout === 'horizontal') return '16 / 9'
  const m = /^(\d+)x(\d+)$/.exec(splitResolution.value || '')
  if (m) {
    const w = Number(m[1])
    const h = Number(m[2])
    if (w > 0 && h > 0) return `${w} / ${h}`
  }
  return '9 / 16'
})

/** Step2 右栏：每条方案一块——确认成片直播；未确认给镜头连播序列（激活块内连播） */
const step2PreviewItems = computed<StepPreviewItem[]>(() => assemblePlans.value.map((p, i) => {
  if (p.confirmed && p.outputPath) {
    return { badge: `第 ${i + 1} 条`, src: toFileUrl(p.outputPath), tip: p.outputName || '' }
  }
  const seq = p.clips.filter((_, ci) => !p.deletedFlags[ci]).map((c) => vdToAbsolute(c.clipUrl))
  return {
    badge: `第 ${i + 1} 条`,
    seqList: seq,
    placeholder: seq.length ? `${seq.length} 个镜头 · 待确认合成` : '待确认合成',
    tip: planRowText(i),
  }
}))

/** Step3 右栏：每条待配音视频一块——配音完成切换配音后视频并点亮，进行中显进度 */
const step3PreviewItems = computed<StepPreviewItem[]>(() => voiceRows.value.map((r, i) => {
  const target = (r.dubbedPath && r.dubbedPath.endsWith('.mp4')) ? r.dubbedPath : r.path
  const generating = r.status === 'generating'
  return {
    badge: `第 ${i + 1} 条`,
    src: target ? toFileUrl(target) : '',
    placeholder: '待确认合成产物',
    tag: generating ? `配音中 ${r.progress}%` : (r.dubbedPath ? '已配音' : (r.wavPath ? '声音已克隆' : '待配音')),
    tagClass: r.dubbedPath ? 'ok' : (generating ? 'busy' : ''),
    tip: r.name,
  }
}))

/** Step4 右栏：合成完成→成片直播；否则候选视频 + 特效叠加预览（样式随左侧配置实时联动） */
const step4PreviewItems = computed<StepPreviewItem[]>(() => {
  if (finalDone.value && finalVideoList.value.length) {
    return finalVideoList.value.map((it, i) => ({
      badge: `第 ${i + 1} 条`, src: toFileUrl(it.path), tag: '成片', tagClass: 'ok', tip: it.name,
    }))
  }
  const kwStyle = textFxStyleSamples.value[0]?.style as Record<string, string | number> | undefined
  return step4Candidates.value.map((c, i) => {
    const row = voiceRows.value.find((r) => r.dubbedPath === c || r.path === c)
    const sub = addSubtitles.value ? String(row?.text || '').split(/\r?\n/)[0]?.trim().slice(0, 20) : ''
    const track = textFxPreviewTracks.value[i]
    let keywords: StepPreviewKeyword[] = []
    if (textFxEnabled.value && track?.items?.length) {
      keywords = track.items.slice(0, 2).map((t) => ({ text: t.word, style: kwStyle }))
    } else if (fancyEnabled.value) {
      keywords = [{ text: FANCY_PREVIEW_TEXT, style: fancyCustomPreviewStyle.value }]
    }
    return {
      badge: `第 ${i + 1} 条`,
      src: toFileUrl(c),
      subtitle: sub || undefined,
      subtitleStyle: subtitlePreviewStyle.value,
      keywords: keywords.length ? keywords : undefined,
      tag: row?.dubbedPath ? '已配音' : '待配音',
      tagClass: row?.dubbedPath ? 'ok' : '',
      tip: pathBasename(c),
    }
  })
})

/** Step4 选中联动：右栏点块 = 左列表选中（成片预览由块内 video 直播） */
function onStep4Select(i: number): void {
  finalSelIdx.value = i
}

// 文字模板样式预览折叠（2026-09-11 用户裁决：两端箭头废止 → 最右侧折叠按钮，
// 默认只显示一行，样式多于一行时点「展开」看剩余）
const textFxCanvasEl = ref<HTMLElement | null>(null)
const textFxExpanded = ref(false)
/** 样式是否多到一行装不下（决定折叠按钮是否出现；只有一行时不给按钮） */
const textFxOverflow = ref(false)
/** 「一行」高度：按首个卡片实测（字号随模板变化，写死会裁字）+ 上下 padding */
const textFxRowH = ref(0)
const textFxCanvasStyle = computed(() =>
  textFxExpanded.value ? {} : { '--fx-row-h': `${textFxRowH.value || 56}px` })
/** 仅在收起态测量：展开态 scrollHeight == clientHeight 量不出溢出基准 */
function measureTextFxStyles(): void {
  const el = textFxCanvasEl.value
  if (!el || textFxExpanded.value) return
  // 不可见时（步未到或勾选关闭）几何全为 0 量不出真实溢出，跳过避免误判「一行装得下」
  if (!el.clientHeight) return
  const first = el.querySelector('.textfx-sample') as HTMLElement | null
  if (first && first.offsetHeight > 0) textFxRowH.value = first.offsetHeight + 8
  textFxOverflow.value = el.scrollHeight - el.clientHeight > 2
}
/** 展开/收起切换：收起后需重测（宽度不变但一行基准变了） */
async function toggleTextFxStyles(): Promise<void> {
  textFxExpanded.value = !textFxExpanded.value
  await nextTick()
  measureTextFxStyles()
}
watch(textFxStyleSamples, async () => {
  textFxExpanded.value = false
  await nextTick()
  measureTextFxStyles()
})
// 首次挂载即测（模板库若已有数据、watch 不会触发 → 按钮会永不出现）
onMounted(async () => { await nextTick(); measureTextFxStyles() })
// 2026-09-11 二次修复「折叠箭头不出现」——全链路根因：模板库进入第④步才拉取
// （loadTextTemplates），画布又随 textFxEnabled 勾选 v-if 挂载；原触发点（onMounted/
// 样本变化）在画布不在 DOM 时全部空跑（ref=null 直接 return），勾选后无任何重测
// → textFxOverflow 恒 false → 按钮 v-if 永不出现（父布局无固定高度，非布局钳制）。
// 补两路触发：①扫到第④步/勾选开关变化即重测；②画布实挂载即挂 ResizeObserver
// （初始回调保证挂载即测一次，持续兜底尺寸与布局变化）
watch([step, textFxEnabled], async () => { await nextTick(); measureTextFxStyles() })
let textFxResizeObs: ResizeObserver | null = null
watch(textFxCanvasEl, (el) => {
  textFxResizeObs?.disconnect()
  textFxResizeObs = null
  if (el) {
    measureTextFxStyles()
    textFxResizeObs = new ResizeObserver(() => measureTextFxStyles())
    textFxResizeObs.observe(el)
  }
}, { flush: 'post' })
onUnmounted(() => { textFxResizeObs?.disconnect(); textFxResizeObs = null })

// ── 左右分栏手动调整（2026-09-10 用户需求）：拖拽分隔条改左右比例，默认 6:4，localStorage 记忆 ──
const VD_SPLIT_KEY = 'vd-split-pct'
const vdSplitPct = ref(Math.min(80, Math.max(35, Number(localStorage.getItem(VD_SPLIT_KEY)) || 60)))
/** 左栏宽度由分隔条拖拽控制（右栏吃剩余全部，三步共享同一比例 → 右栏位置切步不变） */
const vdLeftStyle = computed(() => ({ flex: `0 0 calc(${vdSplitPct.value}% - 6px)` }))
// 拖拽改宽后每行能容纳的样式卡片数会变 → 重测样式预览是否溢出（声明须在
// vdSplitPct 之后，否则 const TDZ 报错）
watch(vdSplitPct, async () => { await nextTick(); measureTextFxStyles() })

function onSplitDown(e: MouseEvent): void {
  e.preventDefault()
  const pane = (e.currentTarget as HTMLElement).parentElement
  if (!pane) return
  const rect = pane.getBoundingClientRect()
  const onMove = (ev: MouseEvent) => {
    vdSplitPct.value = Math.min(80, Math.max(35, Math.round(((ev.clientX - rect.left) / rect.width) * 100)))
  }
  const onUp = () => {
    document.removeEventListener('mousemove', onMove)
    document.removeEventListener('mouseup', onUp)
    localStorage.setItem(VD_SPLIT_KEY, String(vdSplitPct.value))
  }
  document.addEventListener('mousemove', onMove)
  document.addEventListener('mouseup', onUp)
}

/** TTS 引擎下拉选项（2026-09-09 用户裁决：默认 idexttts，对齐声音克隆页裁决；
 *  QwenTTS 待服务端实现，禁用占位） */
const TTS_ENGINE_OPTIONS = [
  { label: 'IndexTTS（快速/情感）', value: 'idexttts' },
  { label: 'QwenTTS（待服务端实现）', value: 'qwentts', disabled: true },
]
/** 情感预设选项（IndexTTS emo_text 常用值，同声音克隆页） */
const TTS_EMO_OPTIONS = [
  { label: '开心', value: '开心' },
  { label: '悲伤', value: '悲伤' },
  { label: '激动', value: '激动' },
  { label: '温柔', value: '温柔' },
  { label: '愤怒', value: '愤怒' },
  { label: '恐惧', value: '恐惧' },
  { label: '惊讶', value: '惊讶' },
  { label: '厌恶', value: '厌恶' },
  { label: '平静', value: '平静' },
]

// ── Step4 BGM 选择弹窗 + AI 生成 BGM（2026-09-09 用户裁决：复用音频生成页域，
//    独立实例与 AudioGen 页互不影响；AI 生成用「生成 BGM」同款结构化布局，
//    生成/选中后回填 bgmPath 本地混音链路）──
const ag = useAudioGen()
const {
  bgmStyle, bgmStyleOptions, bgmDuration, bgmBusy, bgmResultLabel, bgmUrl, bgmSaving,
  bgmLocal, generateBgm, saveBgmToLib, openBgmLocation,
  bgmMood, bgmMoodOptions, bgmScene, bgmSceneOptions,
  listQuery, listTag, listKind, LIST_KIND_OPTIONS,
  listRows, listLoading, listError, listStat, listPageSize,
  pageLabel, canPrevPage, canNextPage,
  doSearch, goPrevPage, goNextPage, loadBgmTags,
  playingMid, listAudioEl, playListRow,
  toAbsolute,
} = ag

// 生成完成自动归档本地后回填 BGM 路径（混音/剪映导出走同一本地链路）
watch(bgmLocal, (p) => {
  if (p) { bgmPath.value = p; bgmName.value = pathBasename(p) }
})

/** 生成面板内联播放条（2026-09-15 用户裁决：删「播放生成的 BGM」按钮，<audio controls>
 *  的 src 直挂就地播放；取源口径同原 playAgBgm——本地归档优先，未就绪回退在线 URL；
 *  src 变化时 audio 自动重载，新生成即播新文件） */
const agBgmAudioSrc = computed(() => bgmLocal.value
  ? toFileUrl(bgmLocal.value)
  : bgmUrl.value ? toAbsolute(bgmUrl.value) : '')

/** BGM 选择弹窗（同音频生成页左栏布局：搜索/分类/标签/列表/分页；单击选中，双击或 ▶ 试听） */
const bgmPickDlg = ref<{ show: boolean; pickedMid: string; busy: boolean; error: string }>({ show: false, pickedMid: '', busy: false, error: '' })
function openBgmPickDlg(): void {
  bgmPickDlg.value.show = true
  bgmPickDlg.value.error = ''
  // 2026-09-10 用户裁决：BGM 选择弹窗默认分类「音乐」（列表状态与音频生成页共享，
  // 仅在打开弹窗时置分类并刷新，不影响音频生成页自身默认「全部」）
  if (listKind.value !== 'music') {
    listKind.value = 'music'
    doSearch()
  } else if (!listRows.value.length && !listLoading.value) {
    doSearch()
  }
  void loadBgmTags()
}
function confirmBgmPick(): void {
  const it = listRows.value.find((r) => r.mid === bgmPickDlg.value.pickedMid)
  if (!it || bgmPickDlg.value.busy) return
  bgmPickDlg.value.busy = true
  bgmPickDlg.value.error = ''
  void applyLibraryBgm(it.mid, it.filename).then((r) => {
    bgmPickDlg.value.busy = false
    if (r && r.error) { bgmPickDlg.value.error = r.error; return }
    bgmPickDlg.value.show = false
  })
}

// ─ 页尾上传新样本（VoiceClone 底部上传区同款同处理：dropzone 点击/拖拽选文件，
//   useFilePicker 统一拖拽；选中后名称自动带出（去扩展名））──
const nsDragging = ref(false)
const {
  fileName: nsFileName,
  pickFile: pickNsFile,
  onDrop: onNsDrop,
  onDragOver: onNsDragOver,
  onDragLeave: onNsDragLeave,
} = useFilePicker({
  dialogTitle: '选择音频文件上传为样本',
  filters: [{ name: '音频', extensions: ['mp3', 'wav', 'm4a', 'flac', 'aac', 'ogg'] }],
  onPicked: (p) => {
    nsFilePath.value = p
    const base = pathBasename(p).replace(/\.[^.]+$/, '')
    if (base && !nsName.value) nsName.value = base
  },
})
function onNsDropForward(e: DragEvent): void {
  onNsDrop(e)
  nsDragging.value = false
}

// 2026-09-07 缩略图改主进程 ffmpeg 抽帧（dataURL <img>）：
// ① 根治多路 <video> 解码器并发初始化崩溃（前版限 8 行挂载导致“缩略图只有一部分”）；
// ② 全部素材行均有缩略图，抽帧失败行回退占位图标。
// 注：原客户端素材列表本无缩略图（_decorate_video_item_widget 仅设景别色），此为本端增强；
// 素材库条目缩略图走服务端 /material/thumbnail（WbPickMaterialDialog 同源），待 Step1
// 补素材库入口后接入——用户裁决 2026-09-07：优先服务端，无则本地抽帧。
const thumbs = reactive(new Map<string, string>())
let thumbSeq = 0

/** 素材行时长文案（ffprobe 探测结果；未就绪/失败显 —） */
function fmtSrcDur(v: string): string {
  const d = srcDurations.get(v)
  return d && d > 0 ? d.toFixed(1) + 's' : '—'
}
let thumbToken = 0
watch(() => [...srcVideos.value], (list) => {
  const token = ++thumbToken
  void (async () => {
    // 3 路并发池：4K XAVC 单帧解码较慢，串行 50 行需数分钟（2026-09-09 用户反馈封面迟迟不出）
    const pending = list.filter((v) => !thumbs.has(v))
    let cursor = 0
    const worker = async () => {
      while (token === thumbToken && cursor < pending.length) {
        const v = pending[cursor++]
        // 每素材独立 tag（extractFrames 输出目录按 tag 清空重建，避免互踩）
        try {
          const r = await window.tintin.ffmpeg.extractFrames({
            videoPath: v, times: [1.0], tag: `montagethumb${++thumbSeq}`, width: 160, quality: 3,
          })
          if (token !== thumbToken) return
          const b64 = r?.frames?.[0]?.base64
          if (b64) thumbs.set(v, `data:image/jpeg;base64,${b64}`)
        } catch { /* 抽帧失败 → 该行显示占位图标 */ }
      }
    }
    await Promise.all(Array.from({ length: Math.min(3, pending.length) }, () => worker()))
  })()
}, { immediate: true })
onUnmounted(() => { thumbToken++ })

// 参考声音下拉（用户裁决 2026-09-03：声音样本从服务端取，GET /voice/samples 与 VoiceClone 页同源；
// 尾项保留本地上传；选中样本自动带出参考文案（selectSample 口径））
const refAudioOptions = computed(() => [
  ...refSamples.value.map((s) => ({ label: s.name, value: `sample:${s.id}` })),
  ...(refSamples.value.length ? [] : [{ label: '未找到预设声音样本', value: '' }]),
])
function onRefAudioChange(v: string | number): void { selectRefAudio(String(v)) }
/** 花字样式下拉（原版 fancy_style_combo 7 项） */
const fancyStyleOptions = FANCY_STYLE_OPTIONS
/** 花字位置下拉（原版 fancy_position_combo 8 项，L335-339） */
const fancyPositionOptions = FANCY_POSITION_OPTIONS
/** 字幕背景下拉（原版 subtitle_bg_combo 6 项，L226-228） */
const subtitleBgOptions = SUBTITLE_BG_OPTIONS
/** 字幕入场动画下拉（2026-09-10 用户裁决：可选动画，预览与烧制同用该选择；
 *  key 与主进程 VALID_ANIMS 同表） */
const SUBTITLE_ANIM_OPTIONS = [
  { label: '淡入', value: 'fade' },
  { label: '上浮', value: 'rise' },
  { label: '滑入', value: 'slide' },
  { label: '弹入', value: 'pop' },
  { label: '无动画', value: 'none' },
]
const subtitleAnimOptions = SUBTITLE_ANIM_OPTIONS
/** 字幕字号下拉（2026-09-18 用户裁决：默认 10 号，置于「动画」后；
 *  值=剪映草稿 texts content styles[].size，预览同比例缩放） */
const subtitleFontSizeOptions = [6, 8, 10, 12, 15, 20, 25, 30].map((v) => ({ label: String(v), value: v }))
/** 花字模板下拉（原版 fancy_template_combo：首项「自定义 (下方样式)」value=''，L269-274；
 *  2026-09-09 服务端对接：服务端模板库条目加「（服务端）」来源后缀，排在本地模板前） */
const fancyTemplateOptions = computed(() => [
  { label: '自定义 (下方样式)', value: '' },
  ...fancyTemplates.value.map((t) => ({
    label: t.origin === 'server' ? `${t.name}（服务端）` : t.name,
    value: t.template_id,
  })),
])
/** 当前选中模板（含来源标记） */
const selectedTemplate = computed(() =>
  fancyTemplateId.value ? fancyTemplates.value.find((t) => t.template_id === fancyTemplateId.value) || null : null)
/** 服务端模板描述预览（textfx 动画渲染在服务端，客户端不自行渲染——显描述文字占位，
 *  对照 docs/CLIENT-FANCY-ACCESS.md §6「不做：客户端自行渲染花字」） */
const serverTemplateDesc = computed(() => {
  const t = selectedTemplate.value
  if (!t || t.origin !== 'server') return ''
  const desc = String(t.description || t.category || '').trim()
  return desc ? `${t.name}：${desc}` : `${t.name}：服务端模板（渲染在服务端）`
})
/** 当前模板预览图（dataURL；对照 fancy_template_preview_lbl） */
const fancyTemplatePreview = computed(() =>
  fancyTemplateId.value ? fancyPreviews.value[fancyTemplateId.value] || '' : '')
/** 花字效果预览样本字（行3 效果预览；卖点风格样例） */
const FANCY_PREVIEW_TEXT = '199元超值'
/** 花字自定义样式效果预览（行3）：选模板时解析模板 drawtext style 还原主色+描边；
 *  自定义（无模板）时用选中样式预设的 CSS 近似（对照主进程 FANCY_STYLES） */
const fancyCustomPreviewStyle = computed<Record<string, string>>(() => {
  const tpl = selectedTemplate.value
  const parsed = tpl ? fancyDrawtextToPreview(String(tpl.style || '')) : null
  if (parsed) return parsed
  const p = FANCY_STYLE_PREVIEW[fancyStyle.value] || FANCY_STYLE_PREVIEW.white_outline
  return {
    color: p.color,
    webkitTextStroke: `3px ${p.stroke}`,
    paintOrder: 'stroke',
    textShadow: '2px 2px 4px rgba(0,0,0,.6)',
  }
})
onMounted(() => { void loadFancyTemplates() })
// 2026-09-15 用户裁决：KeepAlive 下每次进入第④步都刷新模板库/字体/LUT 清单（服务端重渲染后进页面即见新预览）
onActivated(() => {
  void loadTextTemplates()
  void loadFancyTemplates()
  void loadLuts()
})
// 声音样本与 VoiceClone 页同口径：每次进入 Step3（及挂载时）重新拉取（原实现仅在
// composable 创建时拉一次，服务端新增样本/离线恢复后下拉一直为空）
onMounted(() => { void loadRefSamples() })
watch(step, (v) => { if (v === 2) void loadRefSamples() })

/** 输出画幅下拉（原版 layout_combo 3 项；首项动态附分割片段画幅——
 *  2026-09-15 用户裁决：「与原视频一致」基准=分割片段，非原素材（4K 素材分割产物
 *  1080x1920，取原素材会把预合成撑成 4K/横屏），文案同步改「与分割视频一致」） */
const LAYOUTS = computed(() => [
  { label: splitResolution.value ? `与分割视频一致 (${splitResolution.value})` : '与分割视频一致', value: 'source' },
  { label: '竖屏 (1080x1920 抖音流)', value: 'vertical' },
  { label: '横屏 (1920x1080 宽屏)', value: 'horizontal' },
])

/** Step2 排列逻辑（原版 logic_combo 唯一可见项；「按文案智能匹配」原版已隐藏） */
const logicOptions = [{ label: '智能重排', value: 'random' }]
/** 时长限制下拉（原版 duration_limit_combo：10/20/30/40/50 秒） */
const durationOptions = DURATION_LIMITS.map((s) => ({ label: `${s} 秒`, value: s }))

// ── Step2 镜头详情右键菜单（原版 _on_source_context_menu 同口径）──
const detailMenu = ref({ show: false, x: 0, y: 0, row: -1, deleted: false })
function openDetailMenu(e: MouseEvent, row: number): void {
  const p = currentPlan.value
  detailMenu.value = { show: true, x: e.clientX, y: e.clientY, row, deleted: !!p?.deletedFlags[row] }
}
function closeDetailMenu(): void { detailMenu.value.show = false }
function menuToggleDeleted(): void {
  if (detailMenu.value.row >= 0) toggleClipDeleted(detailMenu.value.row)
  closeDetailMenu()
}
// ── 预合成列表右键菜单动作（原版 _show_assembled_context_menu 三项）──
function planMenuConfirm(): void { const i = planMenu.value.index; closePlanMenu(); if (i >= 0) void confirmPlanSingle(i) }
function planMenuGen(): void { const i = planMenu.value.index; closePlanMenu(); if (i >= 0) openProductDlg(i) }
function planMenuView(): void { const i = planMenu.value.index; closePlanMenu(); if (i >= 0) viewPlanCopy(i) }

// ── 口播弹窗左侧内嵌产品选择区（WbPickProductPanel：左列表右参数/卖点；
//   2026-09-09 用户裁决：不需要「选择该产品」按钮，点左侧行即选中，
//   中间预览与右侧四字段同步填充，仍可手改）──
function onPickProduct(it: PickerItem): void {
  productDlg.value.brand = String(it.brand || '')
  productDlg.value.product = String(it.category || '')
  productDlg.value.model = String(it.model || it.goods_no || '')
  // 核心卖点逐条拼入补充卖点（多行，可继续手改/留空）
  productDlg.value.extra = markdownListLines(it.selling_points).join('\n')
}

function urlTail(u: string) { return String(u || '').split('/').pop() || u }

// ── Step1 素材列表删除（已改为行内按钮，原右键菜单已删除）──

/** 评分着色（原版 L1443-1448：≥8 绿 / ≥6 黄 / ≥0 红） */
function scoreClass(score: number | undefined): string {
  if (!score) return ''
  if (score >= 8) return 'score-high'
  if (score >= 6) return 'score-mid'
  return 'score-low'
}
</script>

<template>
  <div class="montage" style="display: flex; flex-direction: column; gap: var(--space-5);">

    <!-- 顶部全宽步骤条已删（2026-09-10 用户裁决：四个 tab 步骤统一放操作区/卡片内，
         各步骤 card 顶部各一份 VdStepBar，预览区不受影响；门控保留在组件内） -->

    <!-- 共享任务状态条移至页尾（原版底部 stage_label + progress_bar 同位置） -->

    <!-- Step 1: 镜头智能分割（布局对照原版 gui/montage/step1_split_view.py L27-181） -->
    <template v-if="step === 0">
      <section class="card">
        <VdStepBar :step="step" @go="go" />
        <div class="dropzone" @click="selectFolder" @drop.prevent="onDrop" @dragover.prevent>
          <span class="dz-main">拖入素材文件夹（自动遍历子文件夹内全部视频） 或 点击选择文件夹</span>
          <span class="dz-hint">支持 mp4 / mov / avi / mkv / flv / webm / m4v，服务端完成分割与逐镜分析</span>
        </div>

        <span class="sec-label">已选择的原始视频素材 (双击可播放预览):</span>
        <ul class="file-list src-video-list">
          <li v-for="(v, i) in srcVideos" :key="v" :title="v">
            <!-- 2026-09-07 缩略图改主进程 ffmpeg 抽帧 dataURL（根治多路 <video> 并发
                 初始化崩溃，且全部行有缩略图）；抽帧失败行显示占位图标 -->
            <img v-if="thumbs.get(v)" class="video-thumb" :src="thumbs.get(v)" alt="" />
            <span v-else class="video-thumb video-thumb--ph" aria-hidden="true">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="4" width="15" height="14" rx="2" /><polygon points="10 8 16 11 10 14" fill="currentColor" stroke="none" /><path d="M19 8l3-2v12l-3-2" /></svg>
            </span>
            <span class="video-path" @dblclick="previewSourceVideo(v)">{{ v }}</span>
            <!-- 时长列（2026-09-09 用户裁决：素材列表加时长显示，ffprobe 探测） -->
            <span class="video-dur">{{ fmtSrcDur(v) }}</span>
            <button class="video-play-btn" title="播放" @click="previewSourceVideo(v)">▶</button>
            <button class="video-remove-btn" title="从素材列表移除" @click="removeVideo(i)">×</button>
          </li>
          <li v-if="!srcVideos.length" class="muted">暂无素材，拖入或点击上方区域选择</li>
        </ul>
        <div v-if="srcVideos.length" class="video-count-footer">选择视频共 {{ srcVideos.length }} 行</div>

        <!-- 参数行 + 行内右对齐「开始智能镜头分割」（原版 split_row 同布局） -->
        <div class="row">
          <label class="param-label">分割阈值 (10-100):</label>
          <input v-model.number="threshold" type="number" min="10" max="100" class="input w80" />
          <label class="param-label">最小镜头(秒):</label>
          <input v-model.number="minSceneLen" type="number" step="0.1" min="0.1" max="60" class="input w80" />
          <label class="param-label" title="无法分割的视频，自动挑出多长的片段">分镜头时长(秒):</label>
          <input v-model.number="imageDuration" type="number" min="1" max="30"
            title="无法分割的视频，自动挑出多长的片段" class="input w80" />
          <span class="spacer"></span>
          <TButton label="开始智能镜头分割" icon="cut" :loading="splitBusy" @click="runSplit" />
        </div>
        <!-- 解析进度（对照原版 step1_split_controller _progress：按素材数 0-100 推进） -->
        <progress v-if="splitBusy" class="vd-progress split-progress" :value="splitProgress" max="100" />
        <div v-if="splitMsg" class="hint">{{ splitMsg }}</div>
        <div v-if="splitError" class="error-msg">⚠ {{ splitError }}（修正后重按「开始智能镜头分割」重试）</div>
      </section>

      <section class="card">
        <div class="row between">
          <span class="sec-label">已分割出的最小单位镜头片段 (双击可播放预览，双击画面描述列可手动修改):</span>
          <label class="muted">评分过滤:
            <select v-model.number="scoreFilter" class="input" title="按评分筛选镜头：达到阈值的镜头才会作为选中素材带入下一步镜头重组">
              <option :value="0">不过滤</option>
              <option v-for="s in [1,2,3,4,5,6,7,8,9]" :key="s" :value="s">≥ {{ s }} 分</option>
            </select>
          </label>
        </div>
        <!-- 11 列：原版 10 列（勾选|序号|视频片段|景别|时长|画幅|主要画面|产品|型号|评分）
             + 本端增强「位置」列（2026-09-09 裁决：位置≠景别——位置=入场/出场等叙事位置，
             服务端 enter/exit 优先、源素材文件名/文件夹命名兑底；景别仅服务端返回） -->
        <div class="tbl-scroll-wrap">
        <table class="tbl">
          <thead><tr>
            <th class="w32"></th><th>序号</th><th style="min-width:140px">视频片段</th><th>景别</th><th>位置</th><th>时长</th>
            <th>画幅</th><th style="min-width:200px">主要画面</th><th>产品</th><th>型号</th><th>评分</th>
          </tr></thead>
          <tbody>
            <tr v-for="r in filteredScenes" :key="r.idx" @dblclick="previewScene(r)">
              <td><input v-model="r.checked" type="checkbox" @dblclick.stop /></td>
              <td class="ta-c">{{ r.idx }}</td>
              <td :title="r.clipUrl || r.name">{{ r.name }}</td>
              <!-- 景别：仅服务端 shot_analysis.shot_type，客户端不自行推断（2026-09-09 裁决） -->
              <td class="ta-c">
                <span v-if="r.shotType" class="shot-type-badge"
                  :style="{ color: SHOT_TYPE_COLORS[r.shotType] || '#888', borderColor: SHOT_TYPE_COLORS[r.shotType] || '#888' }">
                  {{ SHOT_TYPE_LABELS[r.shotType] || r.shotType }}
                </span>
                <span v-else class="muted">—</span>
              </td>
              <!-- 位置：入场/出场（服务端 enter/exit 优先，否则路径命名兑底；tooltip 标来源） -->
              <td class="ta-c shot-source-cell" :title="r.positionSource || ''">
                <span v-if="r.position" class="shot-type-badge"
                  :style="{ color: SHOT_TYPE_COLORS[r.position] || '#888', borderColor: SHOT_TYPE_COLORS[r.position] || '#888' }">
                  {{ SHOT_TYPE_LABELS[r.position] || r.position }}
                </span>
                <span v-else class="muted">—</span>
              </td>
              <td class="ta-c">{{ r.duration > 0 ? r.duration.toFixed(1) + 's' : '—' }}</td>
              <td class="ta-c">{{ r.resolution || splitResolution || '—' }}</td>
              <td>
                <input class="input desc-input" :value="r.description" placeholder="—"
                  @dblclick.stop @change="updateSceneDesc(r.idx, ($event.target as HTMLInputElement).value)" />
              </td>
              <td>{{ r.product || '—' }}</td>
              <td>{{ r.model || '—' }}</td>
              <td class="ta-c" :class="scoreClass(r.score)">{{ r.score ? r.score.toFixed(1) : '—' }}</td>
            </tr>
            <tr v-if="!filteredScenes.length"><td colspan="10" class="muted">暂无已分割镜头，请先开始智能镜头分割</td></tr>
          </tbody>
        </table>
        </div>
      </section>

      <!-- 底部导航条（原版 step1 nav_row L161 顺序：打开已分割镜头目录 → 清空混剪缓存 → stretch → 下一步：镜头重组） -->
      <div class="row">
        <TButton label="打开已分割镜头目录" plain :loading="splitsDownloading" @click="openSplitsDir" />
        <TButton label="清空混剪缓存" plain title="清除本地混剪任务缓存（分割片段/成片输出目录），不会删除原始素材。" @click="clearSplitCache" />
        <span class="spacer"></span>
        <TButton label="下一步：镜头重组" icon="right" :disabled="!scenes.length" @click="go(1)" />
      </div>
    </template>

    <!-- Step 2: 镜头重组（布局逐控件对照原版 gui/montage/step2_concat_view.py setup_ui）；
         2026-09-10 用户需求「界面统一+联动预览」：左操作区 + 右多块预览两栏 -->
    <template v-else-if="step === 1">
      <section class="card">
        <div class="vd-unified">
        <div class="vd-unified-left" :style="vdLeftStyle">
        <VdStepBar :step="step" @go="go" />
        <!-- 参数设置组（原版 params_group：统一边框背景内两行参数） -->
        <div class="params-group">
          <!-- Parameters row 1（原版 L45-106：排列逻辑|输出画幅+原片画幅|时长限制|生成视频数量+推荐；混编随机度隐藏） -->
          <div class="param-row">
            <span class="param-label">排列逻辑:</span>
            <select v-model="assembleLogic" class="input w120" title="智能重排：镜头智能排列组合。">
              <option v-for="o in logicOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
            </select>
            <span class="param-label">输出画幅:</span>
            <select v-model="concatLayout" class="input w180">
              <option v-for="o in LAYOUTS" :key="o.value" :value="o.value">{{ o.label }}</option>
            </select>
            <span v-if="concatLayout === 'source'" class="src-res"
              title="分割片段画幅（2026-09-15 裁决：画幅基准=分割片段而非原素材），选择'与分割视频一致'时将使用此分辨率">
              分割画幅: {{ splitResolution || '未知' }}</span>
            <span class="param-label">时长限制:</span>
            <select v-model.number="durationLimit" class="input w80" title="每个预合成视频的总时长上限（实际不超此值的 1.1 倍）">
              <option v-for="s in DURATION_LIMITS" :key="s" :value="s">{{ s }} 秒</option>
            </select>
            <span class="param-label">生成视频数量 (1-20):</span>
            <input v-model.number="batchCount" type="number" min="1" max="20" class="input w60" />
            <span class="hint">推荐: {{ recBatchCount }}</span>
          </div>
          <!-- Parameters row 2（原版 L109-140：转场动画 | 出入场加速；输出帧率是本端新增控件——
               原版无帧率入口、写死 30fps，2026-09-11 用户裁决加下拉且默认「跟随原片」） -->
          <div class="param-row">
            <span class="param-label">转场动画:</span>
            <select v-model="concatTransition" class="input w120" title="镜头之间的转场动画效果（剪映常用转场）">
              <option v-for="o in TRANSITIONS" :key="o.value" :value="o.value">{{ o.label }}</option>
            </select>
            <span class="param-label">出入场加速:</span>
            <select v-model.number="edgeSpeedup" class="input w90"
              title="识别为「入场/出场」（位置，非景别）的镜头按此倍速加速播放，其它位置不受影响。&#10;位置来源：服务端 enter/exit 标注优先，否则按素材文件夹/文件名命名（入场、出场等）推断（见分割表「位置」列）。&#10;走服务端合成时生效；本地回退合成不支持加速；无位置标注的素材无效果。">
              <option v-for="o in EDGE_SPEEDUP_OPTIONS" :key="o.value" :value="o.value">{{ o.label }}</option>
            </select>
            <span class="param-label">输出帧率:</span>
            <select v-model="concatFps" class="input w140"
              title="成片帧率，随服务端合成提交 fps 字段（契约 integer，默认 30）。&#10;跟随原片：用服务端 split 响应的 source_resolution.fps（2026-09-11 实测有此字段），&#10;服务端未给时本地探测兑底；都不行则回退 30。&#10;29.97/23.976 等小数帧率服务端不收，一律取整。">
              <option v-for="o in FPS_OPTIONS" :key="o.value" :value="o.value">{{ o.label }}</option>
            </select>
            <span v-if="concatFps === 'source'" class="src-res"
              title="服务端 source_resolution.fps 优先，本地探测兑底；都拿不到时按 30 fps 提交">
              原片: {{ splitFps > 0 ? splitFps + ' fps' : '未知（回退 30）' }}</span>
          </div>
        </div>

        <!-- 脚本工具栏（原版 L155-174：待排列镜头个数黄色粗体 + stretch + 镜头重组；
             原版「AI 生成文案」按钮 setVisible(False) 隐藏，不渲染） -->
        <div class="param-row">
          <span class="clip-count">待排列镜头个数: {{ filteredScenes.length }}  (已勾选: {{ checkedCount }})</span>
          <span class="spacer"></span>
          <TButton label="镜头重组" icon="video" :loading="concatBusy" @click="runConcat" />
        </div>
        <div v-if="concatError" class="error-msg">⚠ {{ concatError }}（修正后重按「镜头重组」重试）</div>

        <!-- 中间结果区（原版 result_box） -->
        <div class="result-box">
          <!-- 预合成视频列表（2026-09-09 用户裁决：改表格列显示，不再单行挤在一起；
               列：序号|视频|时长|状态|口播文案；时长列为同日追加裁决：已合成=成片探测
               实际时长，待确认=未删除镜头之和估计；交互不变：单击选中/双击查看文案/右键菜单） -->
          <span class="sec-label">预合成视频列表 (双击播放预览，单击选中查看镜头):</span>
          <!-- 滚动容器（2026-09-11 用户裁决）：最大 10 行高度（表头 + 10 行，与下方详情表
               380px 同口径），超出滚动；少于 10 行随真实行数收缩，不再用占位行撑高。
               注：旧值 332px 行高实测约 33px 只能完整显示 9 行 → 调至 380px（表头约
               30px + 10 行 × 35px），2026-09-11 用户裁决「至少显示 10 个」 -->
          <div class="plan-tbl-wrap">
            <table class="tbl plan-tbl">
              <thead><tr>
                <th class="w48">序号</th><th style="min-width:140px">视频</th><th class="w64">时长</th><th class="w64">状态</th><th style="min-width:180px">口播文案</th>
              </tr></thead>
              <tbody>
                <tr v-for="(p, i) in assemblePlans" :key="i" :class="{ picked: currentPlanIdx === i }"
                  :title="planRowText(i)" @click="selectPlan(i)" @dblclick="viewPlanCopy(i)"
                  @contextmenu.prevent="openPlanMenu($event, i)">
                  <td class="ta-c">{{ i + 1 }}</td>
                  <td class="plan-file" :title="p.outputName">{{ p.outputName || `${p.clips.length} 个镜头` }}</td>
                  <td class="ta-c">{{ planDurText(p) }}</td>
                  <td class="ta-c">{{ p.confirmed && p.outputName ? '已合成' : '待确认' }}</td>
                  <td class="plan-copy" :title="p.copy || ''">{{ p.copy ? copyPreviewText(p.copy) : '未生成口播文案' }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <div v-if="!assemblePlans.length" class="muted plan-empty">尚无预合成视频，勾选镜头后点击「镜头重组」</div>

          <!-- 下半区：分割镜头详情表（表头 + 10 行高，见 .detail-scroll-wrap 380px；
               2026-09-11 用户裁决至少显示 10 个；连播预览已迁右侧统一预览栏，
               2026-09-10 用户需求：单击预览块联动选中方案） -->
          <div class="result-bottom">
            <div class="detail-col">
              <span class="sec-label">视频组成镜头详情 (拖动把手调序，右键删除/恢复镜头):</span>
              <div class="detail-scroll-wrap">
                <table class="tbl detail-tbl">
                  <thead><tr>
                    <th class="w48">序号</th><th class="w32"></th><th style="min-width:120px">分割文件名</th>
                    <th>时长</th><th>景别</th><th>位置</th><th style="min-width:180px">描述文案</th><th>评分</th>
                  </tr></thead>
                  <tbody v-if="currentPlan">
                    <tr v-for="(c, ri) in currentPlan.clips" :key="ri"
                      :class="{ 'row-deleted': currentPlan.deletedFlags[ri] }"
                      draggable="true"
                      @dragstart="onDetailDragStart(ri)" @dragend="onDetailDragEnd"
                      @drop.prevent="onDetailDrop(ri)" @dragover.prevent
                      @contextmenu.prevent="openDetailMenu($event, ri)">
                      <td class="ta-c">{{ ri + 1 }}</td>
                      <td class="ta-c grip-cell" title="拖动调序">⠿</td>
                      <td class="clip-name" :title="c.clipUrl || c.name">{{ c.name }}</td>
                      <td class="ta-c">{{ c.duration > 0 ? c.duration.toFixed(1) + 's' : '—' }}</td>
                      <td class="ta-c">
                        <span v-if="c.shotType" class="shot-type-badge"
                          :style="{ color: SHOT_TYPE_COLORS[c.shotType] || '#888', borderColor: SHOT_TYPE_COLORS[c.shotType] || '#888' }">
                          {{ SHOT_TYPE_LABELS[c.shotType] || c.shotType }}
                        </span>
                        <span v-else class="muted">—</span>
                      </td>
                      <!-- 位置：入场/出场（同 Step1 口径：服务端 enter/exit 优先，路径命名兑底；tooltip 标来源）。
                           重组排序即按此列：入场头/出场尾/其余居中（applyShotLayoutOrder） -->
                      <td class="ta-c shot-source-cell" :title="c.positionSource || ''">
                        <span v-if="c.position" class="shot-type-badge"
                          :style="{ color: SHOT_TYPE_COLORS[c.position] || '#888', borderColor: SHOT_TYPE_COLORS[c.position] || '#888' }">
                          {{ SHOT_TYPE_LABELS[c.position] || c.position }}
                        </span>
                        <span v-else class="muted">—</span>
                      </td>
                      <td class="clip-desc" :title="c.description">{{ c.description || '—' }}</td>
                      <td class="ta-c" :class="scoreClass(c.score)">{{ c.score ? c.score.toFixed(1) : '—' }}</td>
                    </tr>
                    <!-- 不足 10 行时占位 -->
                    <tr v-for="n in Math.max(0, 10 - (currentPlan?.clips.length || 0))" :key="'dph'+n" class="detail-placeholder-row"><td colspan="8"></td></tr>
                  </tbody>
                  <tbody v-else>
                    <tr><td colspan="7" class="muted">单击右侧预览块或上方预合成项查看镜头详情</td></tr>
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>

        <!-- 确认行（原版 confirm_row L268-286：确认合成视频 + 生成口播文案，初始禁用；
             2026-09-10 界面统一：属执行步骤，归左栏底部） -->
        <div class="row confirm-row">
          <TButton label="确认合成视频" :loading="confirmBusy" :disabled="!hasUnconfirmed" @click="confirmAllPrecompose" />
          <!-- 2026-09-09 用户裁决：合成完成后生成口播文案要标明可点击状态（可用时切 primary 高亮） -->
          <TButton label="生成口播文案" :variant="confirmedPaths.length ? 'primary' : 'secondary'" :loading="copyBusy" :disabled="!confirmedPaths.length" @click="openProductDlg('all')" />
        </div>
        <template v-if="confirmBusy">
          <div class="concat-status-line">{{ statusText }}</div>
          <progress class="vd-progress split-progress" :value="concatProgress" max="100" />
        </template>

        <!-- 导航行（2026-09-10 用户裁决：上/下步按钮属操作区，归左栏底部；原版 nav_row L288-301） -->
        <div class="row between">
          <TButton label="上一步：镜头分割" plain @click="go(0)" />
          <TButton label="下一步：口播配音" icon="right" :disabled="!confirmedPaths.length" @click="go(2)" />
        </div>
        </div><!-- /vd-unified-left -->

<div class="vd-split" title="拖动调整左右比例" @mousedown="onSplitDown"></div>

        <!-- 右栏：每条方案一块预览（确认成片直播；未确认单击块连播镜头序列，并联动左栏镜头表） -->
        <div class="vd-unified-right">
          <StepPreviewPane title="画面预览" :items="step2PreviewItems" :active-index="currentPlanIdx"
            :aspect="previewAspect"
            empty-text="尚无预合成方案，勾选镜头后点击「镜头重组」" @select="selectPlan" />
        </div>
        </div><!-- /vd-unified -->
      </section>
    </template>

    <!-- Step 3: 口播配音（对照 gui/montage/step3_voice_view.py L27-298 逐控件一比一）；
         2026-09-10 用户需求「界面统一+联动预览」：左操作区 + 右逐条点亮预览 -->
    <template v-else-if="step === 2">
      <section class="card">
        <div class="vd-unified">
        <div class="vd-unified-left" :style="vdLeftStyle">
        <VdStepBar :step="step" @go="go" />
        <!-- 1. 视频输入目录行：2026-09-08 用户裁决删除——口播配音无视频输入功能，
             配音对象自动取 Step2 已确认合成产物所在目录 -->

        <!-- 2. 参考声音（对齐 VoiceClone 页形态：样本下拉 + 常驻播放条换 src；
             声音样本数据源 = 服务端 GET /voice/samples；选中样本自动带出参考文案） -->
        <div class="row ref-row">
          <label class="label">参考声音:</label>
          <TSelect :model-value="selectedRefSample ? `sample:${selectedRefSample.id}` : ''" :options="refAudioOptions" class="grow" @update:model-value="onRefAudioChange" />
          <!-- 2026-09-09 用户裁决：播放条放到样本下拉框后面（同行右侧）。2026-09-11
               实测修复：TSelect 根默认 width:100% 会独占整行把播放条挤到下一行 →
               行内归位为弹性填充（.ref-row 规则） -->
          <audio v-if="refPreviewUrl" :src="refPreviewUrl" controls preload="auto" class="ref-audio" />
        </div>

        <!-- 3. 参考文案行（2026-09-11 用户裁决：单行显示不全 → 两行 textarea） -->
        <div class="row">
          <label class="label">参考文案:</label>
          <textarea v-model="refText" rows="2" class="input grow ref-text" placeholder="可选，填入样本台词..."></textarea>
        </div>

        <!-- TTS API 与推理参数行：2026-09-08 用户裁决删除（TTS 地址自动跟随系统设置，
             ttsSteps/ttsCfg 存而不用；ttsSpeedMin/Max 保留默认值 0.9~1.2 随克隆请求发送） -->

        <!-- 4. 表格标题行（L177-196；2026-09-10 用户裁决：TTS 引擎/克隆/文案设置组移到「开始批量克隆」前面） -->
        <div class="row">
          <span class="card-title"> 待合成视频列表与配音文案映射 (在配音文案栏直接输入):</span>
        </div>

        <!-- 5. 待合成视频表（L198-208 两列：序号 | 视频/配音/文案/状态/操作；行结构对照 dialogs.py VoiceRowDetailWidget L392-459） -->
        <table v-if="voiceRows.length" class="tbl voice-table">
          <thead>
            <tr>
              <th class="w-idx">序号</th>
              <th>视频/配音/文案/状态/操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(row, i) in voiceRows" :key="row.path">
              <td class="ta-c">{{ i + 1 }}</td>
              <td>
                <div class="vd-detail">
                  <!-- 行 1：文件名 + 状态 + 操作（2026-09-10 用户裁决：删行内 ▶ 播放按钮，视频预览已在右侧统一预览栏） -->
                  <div class="vd-top">
                    <span class="vd-name" :title="row.path">视频: {{ row.name }}</span>
                    <span class="spacer"></span>
                    <span v-if="row.status === 'generating'" class="vd-progress-text">{{ row.progress }}%</span>
                    <span class="vd-status" :class="voiceStatusClass(row)">{{ voiceStatusText(row) }}</span>
                    <!-- 2026-09-11 用户裁决：原 emoji 图标（🔊💾⚖↻🎬📽）与全局按钮体系
                         不统一、含义不明 → 统一为 TButton 文字小按钮（显示作用），
                         成组右对齐（.vd-actions，窄宽度换行后仍贴右）；
                         二次裁决：删「导出」「试看」两按钮（不需要） -->
                    <div class="vd-actions">
                      <!-- 2026-09-15 用户裁决：试听按钮 → 行内原生播放条（<audio controls>，
                           即浏览器原生控件：播放/进度拖动/时长/音量），生成后就地试听；
                           key 带 voiceDurSec——重生成覆写同路径 wav 时强制重建元素避开媒体缓存 -->
                      <audio
                        v-if="row.wavPath"
                        :key="row.wavPath + '|' + (row.voiceDurSec || 0)"
                        class="vd-voice-audio"
                        controls
                        preload="none"
                        :src="toFileUrl(row.wavPath)"
                        :title="`试听克隆声音（${fmtDur(row.voiceDurSec)}）`"
                      />
                      <audio v-else class="vd-voice-audio" controls preload="none" disabled title="尚未生成克隆声音" />
                      <TButton label="编辑" variant="secondary" size="small" title="对比与编辑文案（双击配音文案栏同效）" @click="openEditDlg(i)" />
                      <TButton label="重生成" variant="secondary" size="small" :disabled="row.status === 'generating'" :title="row.status === 'generating' ? '生成中，请稍候' : '仅重新生成该声音'" @click="regenVoice(i)" />
                      <TButton :label="row.lengthMode === 'video' ? '时长:视频' : '时长:音频'" variant="secondary" size="small" :title="lengthModeTip(row)" @click="toggleLengthMode(i)" />
                    </div>
                  </div>
                  <!-- 行 2：原文 + 视频时长（dialogs.py L424-439） -->
                  <div class="vd-row2">
                    <span class="vd-tag muted-tag">原文:</span>
                    <span class="vd-orig">{{ row.originalText || '(无)' }}</span>
                    <span v-if="row.durationSec > 0" class="vd-dur-vid">{{ fmtDur(row.durationSec) }}</span>
                  </div>
                  <!-- 行 3：修改后 + 配音文案编辑框 + 克隆音频时长（dialogs.py L441-459；绿背景 = 已生成，L1718-1745） -->
                  <div class="vd-row3">
                    <span class="vd-tag accent-tag">修改后:</span>
                    <input
                      class="vd-edit" :class="{ 'has-wav': row.wavPath }"
                      :value="row.text"
                      placeholder="双击可弹窗编辑大段文案，留空则不克隆此视频的声音"
                      @change="row.text = ($event.target as HTMLInputElement).value"
                      @dblclick="openEditDlg(i)"
                    />
                    <span class="vd-dur-voice" :class="{ none: !row.voiceDurSec }">{{ row.voiceDurSec > 0 ? fmtDur(row.voiceDurSec) : '--:--' }}</span>
                  </div>
                  <progress v-if="row.status === 'generating'" class="vd-progress" :value="row.progress" max="100" />
                </div>
              </td>
            </tr>
          </tbody>
        </table>
        <div v-else class="muted">确认合成完成后，Step2 的成片视频会自动出现在这里</div>

        <!-- 2026-09-10 用户裁决：克隆按钮变短，与设置组（TTS 引擎/声音克隆/文案生成/AI 改文案）同行、
             整行靠右（克隆=主操作居最右）；原独立 voice-clone-box 全宽框取消 -->
        <!-- 2026-09-10 用户裁决：声音设置组靠左、克隆主操作靠右（两端对齐） -->
        <div class="row between clone-row">
          <div class="row">
            <TSelect v-model="ttsEngine" :options="TTS_ENGINE_OPTIONS" class="tts-engine-select" />
            <TButton label="设置声音克隆" variant="secondary" size="small" @click="openCloneParams" />
            <TButton label="文案生成设置" variant="secondary" size="small" @click="openRewriteSettings" />
            <TButton label="一键AI修改全部文案" size="small" :loading="rewriteBusy" @click="batchAiRewrite" />
          </div>
          <TButton label="开始批量克隆人声合成" :loading="voiceBusy" @click="startSynthesizeVoice" />
        </div>

        <!-- 7. 配音动作已迁 Step4 统一合成（2026-09-09 用户裁决：Step3 只合成口播声音，
             配音+特效烧制+BGM 混音在第四步点「开始混音合成」一键完成） -->

        <!-- 克隆批量进度（主进程逐条 emitRow 聚合为整体百分比；文案+进度条对照确认合成形态） -->
        <template v-if="voiceBusy">
          <div class="concat-status-line">{{ statusText }}</div>
          <progress class="vd-progress split-progress" :value="voiceProgress" max="100" />
        </template>

        <!-- 导航行（2026-09-10 用户裁决：上/下步按钮属操作区；2026-09-09 裁决：合成声音即可跳第四步） -->
        <div class="row between">
          <TButton label="上一步：镜头重组" plain @click="go(1)" />
          <TButton label="下一步：特效包装" icon="right" title="生成口播声音后即可进入；配音/特效/混音在第四步统一合成"
            :disabled="!voiceRows.some(r => r.wavPath)" @click="go(3)" />
        </div>
        </div><!-- /vd-unified-left -->

<div class="vd-split" title="拖动调整左右比例" @mousedown="onSplitDown"></div>

        <!-- 右栏：每条待配音视频一块（配音完成切换配音后视频并点亮；进行中显进度，实时联动） -->
        <div class="vd-unified-right">
          <StepPreviewPane title="配音预览" :items="step3PreviewItems"
            :aspect="previewAspect"
            empty-text="确认合成完成后，Step2 的成片视频会出现在这里逐条预览配音效果" />
        </div>
        </div><!-- /vd-unified -->
      </section>
    </template>

    <!-- Step 4: 特效包装（step4_final_view.py L14-196 逐控件；另保留本端 AI 生成 BGM）；
         2026-09-09 用户裁决：烧制字幕/花字/文字模板特效配置自 Step3 迁入此处，随混音统一烧制，
         字幕文案按视频从 Step3 文案表带过去 -->
    <template v-else>
      <section class="card">
        <!-- 2026-09-10 界面统一：左操作区 + 右统一预览两栏（右栏与 Step2/3 同位置同宽） -->
        <div class="vd-unified">
        <div class="vd-unified-left" :style="vdLeftStyle">
        <VdStepBar :step="step" @go="go" />
        <!-- 特效包装分组（2026-09-13 用户裁决：字幕拆出单独成组、置于背景音乐上方）：花字 + 文字模板 -->
        <div class="action-box fx-pack-box">
          <div class="fx-pack-title">花字</div>

          <!-- 花字（原 Step3 三行原样迁入；2026-09-14 用户裁决：花字/文字模板分开成组） -->
          <div class="row">
            <label class="chk" title="在视频画面叠加花字特效文字（可选出现位置），用于突出关键卖点/价格/型号等信息。&#10;花字内容自动从口播文案中逐行提取卖点（价格 > 数字参数 > 关键词），无需手动输入；&#10;每个花字随对应字幕提前 0.3 秒出现、该句字幕结束即消失。">
              <input v-model="fancyEnabled" type="checkbox" />
              添加花字 (关键信息加重提醒)
            </label>
            <label class="param-label">花字内容:</label>
            <span class="fancy-content-hint">自动提取口播文案卖点（价格/数字参数/关键词），随对应字幕提前 0.3 秒出现、字幕结束消失</span>
          </div>
          <div v-if="fancyEnabled" class="row">
            <label class="param-label">模板:</label>
            <TSelect v-model="fancyTemplateId" :options="fancyTemplateOptions" class="w130"
              title="花字模板 = 样式 + 入场动画 + 出现音效 + 出现时机。&#10;标「（服务端）」的条目来自服务端花字模板库（GET /fancy/templates），与本地同格式、可直接参与配音烧制；其余为本地剪映提取模板（resources/fancy/templates/）。&#10;选「自定义」时用下方样式/位置；选模板时以模板样式为准；右侧预览标签展示渲染效果。" />
            <span class="fancy-preview"
              title="花字模板预览（按模板样式渲染样本字）；悬停查看动画/音效/时机信息。服务端与本地模板同一预览口径。">
              <img v-if="fancyTemplatePreview" :src="fancyTemplatePreview" alt="预览" />
              <span v-else-if="serverTemplateDesc" class="fancy-preview-desc">{{ serverTemplateDesc }}</span>
              <template v-else>预览生成中…</template>
            </span>
            <label class="param-label">样式:</label>
            <TSelect v-model="fancyStyle" :options="fancyStyleOptions" class="w110" />
            <label class="param-label">位置:</label>
            <TSelect v-model="fancyPosition" :options="fancyPositionOptions" class="w110"
              title="花字在画面中出现的位置。&#10;底部两个位置与逐行字幕可能重叠，字幕开启时建议选顶部/中上/四角。" />
          </div>
          <div v-if="fancyEnabled" class="row">
            <label class="param-label">效果预览:</label>
            <div class="style-preview-canvas">
              <span class="style-preview-text" :style="fancyCustomPreviewStyle">{{ FANCY_PREVIEW_TEXT }}</span>
            </div>
          </div>

        </div>

        <!-- 文字模板分组（2026-09-14 用户裁决：与花字分开成组） -->
        <div class="action-box fx-pack-box">
          <div class="fx-pack-title">文字模板</div>
          <!-- 文字模板（2026-09-09 用户裁决：服务端 textfx 动画体系，与花字独立概念；
               随机样式默认从全部模板中选 3 个；烧制待服务端烧制接口上线，先配置+预览；
               2026-09-10 布局裁决：勾选/设置/样式预览/效果预览各占一行） -->
          <div class="row">
            <label class="chk" title="服务端文字模板（textfx 动画：弹跳/打字机/霓虹等），与花字是独立体系。&#10;随机样式=关键词命中模式：服务端从随合成请求提交的字幕里判定命中行（常用关键词∪内置卖点词），命中行整行改用模板动画；不足时自动由 LLM 从字幕行补足（默认开）。&#10;指定样式=整段字幕按该模板渲染。">
              <input v-model="textFxEnabled" type="checkbox" />
              添加文字模板 (关键信息动画提醒)
            </label>
          </div>
          <div v-if="textFxEnabled" class="row">
            <label class="param-label">文字模板:</label>
            <TSelect v-model="textTemplateId" :options="textTemplateOptions" class="w130"
              title="来自服务端文字模板库（GET /text_templates/templates）。&#10;关键词判定与文案提取全部由服务端从合成请求携带的字幕完成，客户端不上传词表。&#10;选「随机样式」时命中行从随机模板池选样式；指定样式时整段字幕用该模板。" />
            <template v-if="textTemplateId === 'random'">
              <label class="param-label">随机数量:</label>
              <TSelect v-model="textRandomCount" :options="TEXT_RANDOM_COUNT_OPTIONS" class="w80"
                title="随机模板池大小（默认 3 个）：每次合成从模板库随机取 N 个作为命中行的候选样式" />
              <label class="param-label">关键词密度:</label>
              <TSelect v-model="textKeywordDensity" :options="TEXT_KEYWORD_DENSITY_OPTIONS" class="w80"
                title="命中动画密度（服务端口径）：每 30 秒按低/中/高分别命中 3/6/10 个，保底 3 个；&#10;命中过多自动等距抽稀，不足时由 LLM 从字幕行挑补足。" />
            </template>
          </div>
          <div v-if="textFxEnabled" class="row">
            <label class="param-label">样式预览:</label>
            <!-- 2026-09-11 用户裁决：两端箭头废止，改最右折叠——默认一行，超出点「展开」
                 （横向滚动条与两端箭头两套旧方案均已废止） -->
            <div ref="textFxCanvasEl" class="style-preview-canvas textfx-canvas"
              :class="{ 'textfx-expanded': textFxExpanded }" :style="textFxCanvasStyle">
              <template v-if="textFxStyleSamples.length">
                <span v-for="s in textFxStyleSamples" :key="'ts' + s.id" class="textfx-sample"
                  :title="`模板：${s.name}`">
                  <!-- 2026-09-13 用户裁决：要不播真实动画（服务端 preview.webm，与成片同渲染器），
                       要不只是文字/静态图——CSS 近似动画废止 -->
                  <video v-if="s.previewWebmUrl" class="textfx-sample-video" :src="s.previewWebmUrl"
                    autoplay loop muted playsinline />
                  <img v-else-if="s.previewUrl" class="textfx-sample-img" :src="s.previewUrl" :alt="s.name" />
                  <span v-else class="textfx-sample-text" :style="s.style">{{ s.text }}</span>
                  <small class="textfx-word-tpl">{{ s.name }}</small>
                </span>
              </template>
              <span v-else class="muted">{{ textTemplates.length ? '未命中模板' : '文字模板库为空，请先在服务端上传文字模板' }}</span>
            </div>
            <button v-if="textFxOverflow" class="textfx-toggle"
              :title="textFxExpanded ? '收起，只看一行' : '展开全部样式'"
              @click="toggleTextFxStyles">
              {{ textFxExpanded ? '收起 ▲' : '展开 ▼' }}
            </button>
          </div>
          <!-- 2026-09-10 用户终裁：本行不设「效果预览:」标签字；时间轴条内词条只显示关键词本体
               （模板名小字废止，仅保留在 hover 提示里）。
               2026-09-11 用户裁决：行左侧改显示「第N条」序号（完整视频名保留在悬停提示） -->
          <div v-if="textFxEnabled" class="row">
            <!-- 上一步合成几条就几条轨（2026-09-11 裁决：全部平铺不截断），
                 轨名=第N条，背景条本身即时长，词条按真实时间点定位 -->
            <div class="style-preview-canvas textfx-tracks">
              <template v-if="textFxPreviewTracks.length">
                <div v-for="(tr, ti) in textFxPreviewTracks" :key="'tt' + ti" class="textfx-track">
                  <span class="textfx-track-name" :title="tr.name">第{{ ti + 1 }}条</span>
                  <div class="textfx-track-bar">
                    <span v-for="(it, ii) in tr.items" :key="'ti' + ii" class="textfx-track-item"
                      :style="{ left: (tr.durationSec > 0 ? Math.min(92, (it.start / tr.durationSec) * 100) : 0) + '%' }"
                      :title="`${it.fullText || it.word} · ${it.tplName} · ${fmtDur(it.start)} / ${fmtDur(tr.durationSec)}`">
                      <!-- 2026-09-15 用户裁决：词条=纯关键词标记（哪些词/哪个位置），不播
                           render-preview 片段——那是近似物（默认字体+CSS 动画），渲染只在合成时发生 -->
                      <b>{{ it.word }}</b>
                    </span>
                  </div>
                </div>
              </template>
              <span v-else class="muted">{{ textTemplates.length ? '上一步合成的视频将在此逐条预览关键词效果' : '文字模板库为空，请先在服务端上传文字模板' }}</span>
            </div>
          </div>
        </div>

        <!-- 字幕分组（2026-09-13 用户裁决：字幕单独一组，置于背景音乐上方；自特效包装组拆出。
             行1 勾选 / 行2 字体+背景+动画+预设样式色板 / 行3 效果预览；样式 key 与主进程 SUBTITLE_STYLES 同表） -->
        <div class="action-box fx-pack-box">
          <div class="fx-pack-title">字幕</div>
          <div class="row">
            <label class="chk" title="字幕字体取自服务端字体库（GET /config/fonts）。&#10;本地 ffmpeg 烧制：预设样式以 drawtext 描边（borderw=3）实现；&#10;服务端合成时随 subtitle_style 一并提交。">
              <input v-model="addSubtitles" type="checkbox" />
              烧制字幕（逐行按时间显示，字号随视频高度自适应）
            </label>
          </div>
          <div v-if="addSubtitles" class="row">
            <label class="param-label">字幕字体:</label>
            <TSelect v-model="subtitleFont" :options="fontOptions" class="w230" :option-style="fontOptionStyle"
              title="字体列表来自服务端 /config/fonts，各选项按自身字体渲染" />
            <TButton label="刷新字体" variant="secondary" size="small" :loading="fontsLoading" title="重新从服务端拉取字体列表" @click="refreshFonts" />
            <label class="param-label">背景:</label>
            <TSelect v-model="subtitleBgOpacity" :options="subtitleBgOptions" class="w130"
              title="字幕背景色为黑色，此项调背景不透明度（0=无背景框）。&#10;值越高背景越实。" />
            <label class="param-label">动画:</label>
            <TSelect v-model="subtitleAnimKey" :options="subtitleAnimOptions" class="w130"
              title="字幕入场动画（烧制与预览同用此选择）。&#10;注意背景框不参与淡入（drawtext alpha 只作用于文字）。" />
            <label class="param-label">字号:</label>
            <TSelect v-model="subtitleFontSize" :options="subtitleFontSizeOptions" class="w90"
              title="字幕字号（剪映草稿文本 size，默认 10 号）。&#10;值越大字幕越大，效果预览同比例缩放。" />
            <label class="param-label">样式:</label>
            <div class="sub-style-grid" title="字幕样式来自服务端 /subtitle_styles 库（烧制时以 ffmpeg drawtext 或服务端引擎实现，效果以成品为准）">
              <button v-for="p in subtitleStylePresets" :key="p.key" type="button" class="sub-style-tile"
                :class="{ active: subtitleStyleKey === p.key }" :title="p.label" @click="subtitleStyleKey = p.key">
                <span class="sub-style-tile-text" :style="subtitlePresetTileStyle(p)">字幕</span>
              </button>
            </div>
          </div>
          <div v-if="addSubtitles" class="row">
            <label class="param-label">效果预览:</label>
            <div class="style-preview-canvas">
              <span class="style-preview-text" :class="subtitleAnimKey !== 'none' ? 'sub-anim-' + subtitleAnimKey : ''"
                :style="subtitlePreviewStyle">这是字幕预览效果 ABC123</span>
            </div>
          </div>
        </div>

        <!-- 1. BGM input -->
        <div class="row">
          <label class="label"> 背景音乐 (BGM):</label>
          <input :value="bgmPath" placeholder="选择混剪背景音乐 (mp3/wav)，选空则无BGM..." readonly class="input grow" @click="pickBgm" />
          <!-- 2026-09-10 用户裁决：删「选择背景音乐」按钮（点击输入框已可上传）；保留「选择BGM」弹音频库 -->
          <TButton label="选择BGM" size="small" variant="secondary" @click="openBgmPickDlg" />
          <!-- 本端保留功能：AI 生成 BGM（生成后自动归档本地，自动填入输入框作为已选 BGM） -->
          <TButton label="AI 生成 BGM" size="small" :variant="bgmSource === 'ai' ? 'primary' : 'secondary'" @click="bgmSource = bgmSource === 'ai' ? 'local' : 'ai'" />
        </div>
        <div v-if="bgmSource === 'ai'" class="ai-bgm-panel">
          <!-- 2026-09-09 用户裁决：AI 生成 BGM 改音频生成页「生成 BGM」同款布局
               （结构化口径 style/mood/duration；生成后自动归档本地并回填 BGM 路径） -->
          <div class="row">
            <label class="label">风格:</label>
            <TSelect v-model="bgmStyle" class="ag-style-select" :options="bgmStyleOptions" :disabled="bgmBusy" />
            <label class="label">时长(秒):</label>
            <input v-model.number="bgmDuration" class="input ag-num-input" type="number" min="5" max="30" step="5" :disabled="bgmBusy" />
          </div>
          <div class="row">
            <label class="label">情绪:</label>
            <TSelect v-model="bgmMood" class="ag-tag-select" :options="bgmMoodOptions" :disabled="bgmBusy" />
            <label class="label">场景:</label>
            <TSelect v-model="bgmScene" class="ag-tag-select" :options="bgmSceneOptions" :disabled="bgmBusy" />
          </div>
          <div class="row agb-gen-row">
            <TButton label="生成 BGM" :loading="bgmBusy" :disabled="bgmBusy" @click="generateBgm()" />
          </div>
          <p v-if="bgmResultLabel" class="agb-result">{{ bgmResultLabel }}</p>
          <div class="row">
            <TButton label="保存到 BGM 库" variant="secondary" size="small" :loading="bgmSaving" :disabled="!bgmUrl || bgmSaving" @click="saveBgmToLib" />
            <TButton label="打开位置" variant="secondary" size="small" :disabled="!bgmLocal" title="在资源管理器中打开生成的 BGM 本地文件（outputs/ai_audio）" @click="openBgmLocation" />
            <audio v-if="agBgmAudioSrc" :src="agBgmAudioSrc" controls class="grow" />
          </div>
        </div>

        <!-- BGM 试听一行（2026-09-10 用户裁决：播放控制在 前、设置在后）：
             播放/暂停 ⏹ + 进度条 + 时间 + BGM 增益（0-200%，100%=原音量，拖动实时改变试听音量） -->
        <div class="row vd4-player">
          <button class="icon-btn vd4-pbtn" :title="bgmPlaying ? '暂停' : '播放/暂停'" @click="toggleBgmPlay">{{ bgmPlaying ? '⏸' : '▶' }}</button>
          <button class="icon-btn vd4-pbtn" title="停止播放" :disabled="!bgmPlaying" @click="stopBgmPlay">⏹</button>
          <input class="vd4-seek grow" type="range" min="0" :max="bgmDurMs" step="1" :value="bgmPosMs" @input="seekBgm" />
          <span class="vd4-time">{{ fmtBgmTime(bgmPosMs) }} / {{ fmtBgmTime(bgmDurMs) }}</span>
          <label class="label" title="BGM 增益 0-200%，100%=原音量；拖动实时改变试听音量">BGM 增益:</label>
          <input v-model.number="bgmVolume" type="range" min="0" max="200" step="1" class="vd4-gain" @input="onBgmVolumeInput" />
          <span class="vd4-gain-label">{{ bgmVolume }} %</span>
        </div>

        <!-- 2026-09-14 服务端 /montage/concat 新增 lut_restore（默认 false=不还原 LUT）：
             勾选=恢复旧行为（无显式 LUT 文件时自动抽帧匹配 LUT 库）；显式 LUT 文件上传
             始终优先不受开关影响。仅服务端合成消费（本地 ffmpeg 无 LUT 概念） -->
        <div class="row">
          <label class="chk" title="勾选后：服务端合成在未显式上传 LUT 文件时，自动抽帧匹配 LUT 库还原调色（恢复旧行为）。&#10;默认不勾选 = 不做 LUT 还原。显式上传 LUT 文件时始终应用，不受此开关影响。">
            <input v-model="lutRestore" type="checkbox" />
            还原 LUT（自动抽帧匹配 LUT 库）
          </label>
        </div>
        <div v-if="lutRestore" class="row">
          <label class="param-label">选择 LUT:</label>
          <div class="lut-list">
            <label v-for="l in lutList" :key="String(l.id)" class="chk">
              <input type="radio" name="lutPick" :value="String(l.id)" :checked="lutId === String(l.id)"
                @change="lutId = String(l.id)" />
              {{ String(l.name) }}
              <span class="tag">{{ l.kind === 'restore' ? '还原' : '风格' }}</span>
              <span v-if="l.description" class="muted">{{ String(l.description) }}</span>
            </label>
            <span v-if="!lutList.length" class="muted">{{ lutListLoading ? '加载中…' : '服务端 LUT 库为空（可用 /config/luts 上传 .cube）' }}</span>
          </div>
        </div>
        <!-- 2026-09-18 用户裁决：动作区加导出方案引导文案，竖排：
             标题「请选择导出方案」→ 方案一文案 → 其两按钮 → 方案二文案 → 服务端合成按钮 -->
        <div class="vd4-schemes">
          <div class="vd4-scheme-title">请选择导出方案</div>
          <div class="vd4-scheme-line">方案一，速度快，可以在剪映里编辑，需要本地安装剪映，</div>
          <div class="row" style="gap: var(--space-2)">
            <!-- 2026-09-15 用户裁决：本地合成删除（统一走服务端合成）；
                 导出到剪映时间轴紧随服务端合成之后 -->
            <TButton label="导出到剪映时间轴(带转场)" variant="secondary" class="vd4-run vd4-grow"
              :disabled="finalBusy || exportBusy"
              :title="exportBusy ? exportStage : '将合成候选按顺序导出为一条剪映时间轴草稿（口播/字幕/关键词/BGM 各轨独立，片段间自动转场）'"
              @click="exportAllToJianyingDraft" />
            <!-- 轨 2（2026-09-17 用户裁决）：服务端封装好的剪映格式草稿 zip → 解压校验 → 落盘剪映 -->
            <TButton label="导入服务端草稿包" variant="secondary" class="vd4-run vd4-grow"
              :disabled="finalBusy || exportBusy"
              :title="exportBusy ? exportStage : '逐个合成任务下载服务端封装好的剪映格式草稿包，解压校验后放入剪映草稿目录（每任务一个草稿）'"
              @click="exportJianyingPackageDraft" />
          </div>
          <div class="vd4-scheme-line">方案二，服务端合成视频，时间较长</div>
          <TButton label="服务端合成" class="vd4-run" :loading="finalBusy && finalMode === 'server'"
            :disabled="finalBusy" title="特效烧制 + BGM 混音全部走服务端一次合成（字幕入场动画服务端无字段，不生效）" @click="startFinalMix()" />
        </div>
        <div v-if="finalBusy" class="pbar"><div class="pbar-inner" :style="{ width: finalProgress + '%' }"></div></div>
        <!-- 2026-09-16：导出剪映时间轴进度条（独立于 finalBusy） -->
        <div v-if="exportBusy" class="pbar"><div class="pbar-inner" :style="{ width: exportProgress + '%' }"></div></div>
        <div v-if="exportBusy && exportStage" class="muted" style="margin-top:4px;font-size:12px">{{ exportStage }}</div>

        <!-- 结果区：左 成片列表 + 三按钮；右 视频预览 -->
        <div class="vd4-result">
          <div class="vd4-left">
            <div class="vd4-left-title">最终合成生成的视频文件:</div>
            <ul class="file-list vd4-list">
              <li
                v-for="(it, i) in finalVideoList" :key="i"
                :class="{ picked: finalSelIdx === i }"
                @click="onStep4Select(i)"
              >{{ it.name }}</li>
              <li v-if="!finalVideoList.length" class="muted">暂无成片，点击「服务端合成」后此处展示结果</li>
            </ul>
            <div class="vd4-btns">
              <TButton label="打开视频输出目录" variant="secondary" :disabled="!finalDone" class="grow" @click="openFinalDir" />
              <!-- 2026-09-16：导出成功后显示「打开草稿目录」按钮 -->
              <TButton v-if="lastExportDraftPath" label="打开草稿目录" variant="secondary" class="grow" @click="openExportDraftDir" />
            </div>
          </div>
        </div><!-- /vd4-result -->

        <!-- 导航行（2026-09-10 用户裁决：上/下步按钮属操作区；原版 Step4 仅上一步，文案逐字 L190） -->
        <div class="row left">
          <TButton label="上一步：口播配音" plain @click="go(2)" />
        </div>
        </div><!-- /vd-unified-left -->

<div class="vd-split" title="拖动调整左右比例" @mousedown="onSplitDown"></div>

        <!-- 右栏：统一预览（成片直播/候选+特效叠加层，点击块切列表选中） -->
        <div class="vd-unified-right">
          <StepPreviewPane title="成片预览" :items="step4PreviewItems" :active-index="finalSelIdx"
            :aspect="previewAspect"
            empty-text="完成配音后进入本步，点击「服务端合成」或「本地合成」生成成片" @select="onStep4Select" />
        </div>
        </div><!-- /vd-unified -->
      </section>
    </template>

    <!-- 页尾状态区（原版底部共享：stage_label + progress_bar；
      确认合成期间不重复显示——状态文案已置进度条上方，用户裁决：下面的文字提示不需要） -->
    <div v-if="(polling || statusText) && !confirmBusy" class="bottom-status">
      <div class="bottom-status-row">
        <span class="status-text" :class="{ spinning: polling }">{{ statusText }}</span>
        <span v-if="activeTaskId" class="muted">任务 {{ activeTaskId }}</span>
        <TButton v-if="polling" label="取消等待" size="small" plain @click="cancelPolling" />
      </div>
      <div v-if="polling" class="pbar"><div class="pbar-inner"></div></div>
    </div>

    <!-- 页尾上传新样本（2026-09-08 用户裁决：放在扫描失败提示之下，整个界面最底部；
      VoiceClone 底部上传区同款同处理：dropzone 点击/拖拽选文件，
      字段（名称自动带出/文字可 ASR 识别）→ 上传服务端 → 刷新下拉并自动选中） -->
    <div v-if="step === 2" class="ns-section">
      <div class="ns-title">没有想要的样本？上传音频创建新样本</div>
      <div
        class="dropzone"
        :class="{ 'is-active': nsDragging, 'has-file': !!nsFilePath }"
        @click="pickNsFile"
        @drop.prevent="onNsDropForward"
        @dragover.prevent="onNsDragOver(); nsDragging = true"
        @dragleave.prevent="onNsDragLeave(); nsDragging = false"
      >
        <svg v-if="!nsFilePath" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12" />
        </svg>
        <div class="dropzone__text">
          <template v-if="!nsFilePath">
            <span class="dropzone__main">点击选择音频或拖拽到此处</span>
            <span class="dropzone__hint">支持 MP3 / WAV / M4A / FLAC</span>
          </template>
          <template v-else>
            <span class="dropzone__main">{{ nsFileName }}</span>
            <span class="dropzone__hint">点击重新选择</span>
          </template>
        </div>
      </div>
      <div v-if="nsFilePath" class="ns-fields">
        <div class="ns-field">
          <label class="ns-label">样本名称 *</label>
          <input v-model="nsName" class="input" placeholder="例：小美-温柔女声" />
        </div>
        <div class="ns-field">
          <div class="ns-field-head">
            <label class="ns-label">对应文字（可选）</label>
            <TButton label="识别参考文字" size="small" :loading="nsTranscribing" :disabled="!nsFilePath" @click="transcribeNewSample" />
          </div>
          <textarea v-model="nsText" class="input ns-textarea" rows="2" placeholder="与参考音频一致的文字；也可点击右侧按钮自动识别"></textarea>
        </div>
        <div class="ns-actions">
          <TButton label="上传为样本" icon="upload" :loading="nsBusy" :disabled="!nsFilePath || !nsName.trim()" @click="uploadNewSampleRef" />
        </div>
        <div v-if="nsError" class="ns-msg ns-err">{{ nsError }}</div>
        <div v-if="nsSuccess" class="ns-msg ns-ok">{{ nsSuccess }}</div>
      </div>
    </div>

    <!-- 镜头片段预览弹层（内置 Plyr 播放器，支持本地路径 + 服务端 URL） -->
    <VideoPreview :visible="!!previewUrl" :src="previewUrl" :loading="previewTranscoding" @close="closePreview" @ended="onSeqEnded" />

    <!-- 预合成列表右键菜单（原版 _show_assembled_context_menu L5412-5434 三项，查看文案仅已生成时显示） -->
    <teleport to="body">
      <div v-if="planMenu.show" class="ctx-mask" @click="closePlanMenu" @contextmenu.prevent="closePlanMenu">
        <div class="ctx-menu" :style="{ left: planMenu.x + 'px', top: planMenu.y + 'px' }" @click.stop>
          <button class="ctx-item" @click="planMenuConfirm">完成： 确认合成视频</button>
          <button class="ctx-item" @click="planMenuGen"> 生成口播文案</button>
          <button v-if="planMenu.hasCopy" class="ctx-item" @click="planMenuView"> 查看文案</button>
        </div>
      </div>
    </teleport>

    <!-- 镜头详情右键菜单（原版 _on_source_context_menu L5843-5851） -->
    <teleport to="body">
      <div v-if="detailMenu.show" class="ctx-mask" @click="closeDetailMenu" @contextmenu.prevent="closeDetailMenu">
        <div class="ctx-menu" :style="{ left: detailMenu.x + 'px', top: detailMenu.y + 'px' }" @click.stop>
          <button v-if="detailMenu.deleted" class="ctx-item" @click="menuToggleDeleted">↩ 恢复镜头</button>
          <button v-else class="ctx-item" @click="menuToggleDeleted"> 标记删除（不参与合成和预览）</button>
        </div>
      </div>
    </teleport>

    <!-- 产品信息弹窗（原版 ProductCopyInputDialog，dialogs.py L347-388 文案逐字；
      2026-09-08 用户裁决：产品选择区与填写区合二为一不再二次弹窗——左侧内嵌
      WbPickProductPanel，选中自动回填右侧表单，仍可手改；填写区高度加高。
      2026-09-11 用户裁决：三块（产品列表｜产品详情｜填写表单）宽度 1:1:1。
      2026-09-13 改调 /copywriting/voiceover：时长不再手填，逐条按成片时长 duration_s 传入） -->
    <teleport to="body">
      <div v-if="productDlg.show" class="modal-mask" @click.self="closeProductDlg">
        <div class="modal modal-pick">
          <span class="modal-title"> 生成口播文案</span>
          <span class="hint">输入产品信息，由大模型生成该组合视频的口播文案；可从产品库选择自动填充，也可直接手动填写：</span>
          <div class="pick-layout">
            <div class="pick-left">
              <WbPickProductPanel :active="productDlg.show" click-to-pick @pick="onPickProduct" />
            </div>
            <div class="pick-right">
              <!-- 2026-09-09 用户裁决：label 与输入框换行（label 上、输入框下占满），
                补充卖点高度加倍；生成/取消互换位置并与「选择该产品」平行、宽度平分 -->
              <div class="modal-field modal-field--stack"><label>品牌:</label><input v-model="productDlg.brand" class="input" placeholder="如 罗技 / Logitech" /></div>
              <div class="modal-field modal-field--stack"><label>产品:</label><input v-model="productDlg.product" class="input" placeholder="如 鼠标 / 键盘 / 无线耳机" /></div>
              <div class="modal-field modal-field--stack"><label>型号:</label><input v-model="productDlg.model" class="input" placeholder="如 G502 / MX Master 3S" /></div>
              <div class="modal-field modal-field--stack modal-extra"><label>补充卖点（可选）:</label>
                <textarea v-model="productDlg.extra" class="modal-textarea modal-textarea--tall" placeholder="如 8K回报率、轻量化、长续航……（可留空）"></textarea>
              </div>
              <div class="modal-actions modal-actions--split">
                <TButton label="取消" plain @click="closeProductDlg" />
                <TButton label="生成" :loading="copyBusy" @click="productDlgGenerate" />
              </div>
            </div>
          </div>
        </div>
      </div>
    </teleport>

    <!-- 口播文案查看弹窗（原版 _view_assembled_copy：标题 + 只读全文 + 关闭） -->
    <teleport to="body">
      <div v-if="copyViewDlg.show" class="modal-mask" @click.self="closeCopyView">
        <div class="modal modal-wide">
          <span class="modal-title">{{ copyViewDlg.title }}</span>
          <textarea readonly class="modal-textarea modal-copy">{{ copyViewDlg.content }}</textarea>
          <div class="modal-actions"><TButton label="关闭" plain @click="closeCopyView" /></div>
        </div>
      </div>
    </teleport>

    <!-- 文案生成设置弹窗（原版 _show_ai_rewrite_settings L3317-3405 文案逐字） -->
    <teleport to="body">
      <div v-if="aiRewriteDlg.show" class="modal-mask" @click.self="closeRewriteSettings">
        <div class="modal">
          <span class="modal-title">文案生成设置</span>
          <span class="rw-title">文案生成自由度设置</span>
          <span class="rw-desc">{{ AI_REWRITE_DESC }}</span>
          <div class="row">
            <span class="muted">0%</span>
            <input v-model.number="aiRewriteDlg.pct" type="range" min="0" max="100" step="1" class="grow" />
            <span class="muted">100%</span>
          </div>
          <span class="rw-value">当前: {{ aiRewriteDlg.pct }}%</span>
          <div class="modal-actions">
            <TButton label="取消" plain @click="closeRewriteSettings" />
            <TButton label="保存" @click="saveRewriteSettings" />
          </div>
        </div>
      </div>
    </teleport>

    <!-- 设置声音克隆弹窗（2026-09-09 用户裁决：对齐声音克隆页 IndexTTS 参数——语速/情感/情感强度；
      保存后克隆声音时随每次 TTS 请求发送） -->
    <teleport to="body">
      <div v-if="cloneParamsDlg.show" class="modal-mask" @click.self="closeCloneParams">
        <div class="modal">
          <span class="modal-title">设置声音克隆</span>
          <span class="hint">以下参数在克隆声音时随每次 TTS 请求发送（当前引擎：IndexTTS）</span>
          <div class="cp-field">
            <div class="row between">
              <span class="label">语速（duration_factor）</span>
              <span class="cp-value">{{ cloneParamsDlg.factor.toFixed(1) }}x</span>
            </div>
            <input v-model.number="cloneParamsDlg.factor" type="range" min="0.5" max="2" step="0.1" class="grow" />
            <div class="row between cp-labels"><span>0.5x 慢</span><span>1.0x 正常</span><span>2.0x 快</span></div>
          </div>
          <div class="cp-field">
            <span class="label">情感选择（emo_text，可选）</span>
            <TSelect :model-value="cloneParamsDlg.emo" :options="TTS_EMO_OPTIONS" placeholder="不选择则使用样本默认情感" @update:model-value="(v: string | number) => (cloneParamsDlg.emo = String(v))" />
          </div>
          <div class="cp-field">
            <div class="row between">
              <span class="label">情感强度（emo_alpha）</span>
              <span class="cp-value">{{ cloneParamsDlg.alpha.toFixed(1) }}</span>
            </div>
            <input v-model.number="cloneParamsDlg.alpha" type="range" min="0" max="1" step="0.1" class="grow" />
          </div>
          <div class="cp-field">
            <div class="row between">
              <span class="label">句间停顿（毫秒）</span>
              <span class="cp-value">{{ cloneParamsDlg.pause > 0 ? cloneParamsDlg.pause + 'ms' : '默认（无额外停顿）' }}</span>
            </div>
            <input v-model.number="cloneParamsDlg.pause" type="range" min="0" max="3000" step="100" class="grow" />
            <div class="row between cp-labels"><span>0 关</span><span>1500ms</span><span>3000ms</span></div>
            <span class="cp-tip">句间插入服务端停顿标记（((pause=毫秒))），精确控制停顿；每处标记将拆段分别合成，文案较长时耗时增加</span>
          </div>
          <div class="modal-actions">
            <TButton label="取消" plain @click="closeCloneParams" />
            <TButton label="保存" @click="saveCloneParams" />
          </div>
        </div>
      </div>
    </teleport>

    <!-- BGM 选择弹窗（2026-09-09 用户裁决：同音频生成页左栏布局——搜索/分类/标签/列表/分页；
      单击选中、双击或 ▶ 试听；确定后下载落盘回填 BGM 路径） -->
    <teleport to="body">
      <div v-if="bgmPickDlg.show" class="modal-mask" @click.self="bgmPickDlg.show = false">
        <div class="modal modal-wide bgm-pick">
          <span class="modal-title">选择 BGM</span>
          <div class="row">
            <input v-model="listQuery" class="input grow" placeholder="搜索音频（语义检索，如：激昂的背景音乐）" :disabled="listLoading" @keydown.enter="doSearch()" />
            <TButton label="搜索" :loading="listLoading" :disabled="listLoading" @click="doSearch()" />
          </div>
          <div class="row">
            <label class="label">分类:</label>
            <TSelect v-model="listKind" class="bgm-kind-select" :options="[...LIST_KIND_OPTIONS]" :disabled="listLoading" @update:model-value="doSearch()" />
            <input v-model="listTag" class="input bgm-tag-input" placeholder="情绪/场景标签" :disabled="listLoading" @keydown.enter="doSearch()" />
          </div>
          <div class="bgm-pick-rows">
            <div v-if="!listLoading && !listError && !listRows.length" class="bgm-pick-state">暂无音频，试试调整筛选条件。</div>
            <div
              v-for="it in listRows"
              v-else
              :key="it.mid"
              class="bgm-pick-row"
              :class="{ picked: bgmPickDlg.pickedMid === it.mid, playing: playingMid === it.mid }"
              :title="`${it.filename}\n分类: ${it.kindName}\n时长: ${it.durStr}\n大小: ${it.sizeStr}`"
              @click="bgmPickDlg.pickedMid = it.mid"
              @dblclick="playListRow(it)"
            >
              <span class="bgm-pick-name" :title="it.filename">{{ it.filename }}</span>
              <span class="vd-tag muted-tag">{{ it.kindName }}</span>
              <span class="bgm-pick-meta">{{ it.durStr }}</span>
              <span class="bgm-pick-meta">{{ it.sizeStr }}</span>
              <span class="bgm-pick-act" role="button" title="试听" @click.stop="playListRow(it)">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 3l14 9-14 9V3z" /></svg>
              </span>
            </div>
          </div>
          <div class="row">
            <span class="muted" :title="listError || listStat">{{ listError || (listLoading ? '加载中...' : `${listStat} · 单击选中，双击或 ▶ 试听`) }}</span>
            <span class="grow"></span>
            <TButton label="上一页" variant="secondary" size="small" :disabled="!canPrevPage || listLoading" @click="goPrevPage()" />
            <span class="muted">{{ pageLabel }}</span>
            <TButton label="下一页" variant="secondary" size="small" :disabled="!canNextPage || listLoading" @click="goNextPage()" />
            <label class="label">每页:</label>
            <input v-model.number="listPageSize" class="input bgm-page-input" type="number" min="10" max="200" step="10" :disabled="listLoading" @change="doSearch()" />
            <audio v-show="playingMid" ref="listAudioEl" controls class="bgm-pick-audio" />
          </div>
          <div v-if="bgmPickDlg.error" class="error-msg">⚠ {{ bgmPickDlg.error }}</div>
          <div class="modal-actions">
            <TButton label="取消" plain @click="bgmPickDlg.show = false" />
            <TButton label="确定" :loading="bgmPickDlg.busy" :disabled="!bgmPickDlg.pickedMid || bgmPickDlg.busy" @click="confirmBgmPick" />
          </div>
        </div>
      </div>
    </teleport>

    <!-- 配音文案编辑弹窗（原版 TextEditDialog，dialogs.py L31-80 文案逐字；⚖ 对比按钮同入口附原文对照） -->
    <teleport to="body">
      <div v-if="editDlg.show" class="modal-mask" @click.self="editDlg.show = false">
        <div class="modal modal-wide">
          <span class="modal-title">{{ editDlg.title }}</span>
          <!-- 2026-09-11 用户裁决：对比改左右并排 1:1（左=原文只读栏、右=修改编辑栏；
               原「配音文案编辑:」提示行删除——两栏标签已自明） -->
          <div class="edit-cols">
            <div v-if="editDlg.original" class="edit-col">
              <span class="vd-tag muted-tag">原文:</span>
              <div class="vd-orig">{{ editDlg.original }}</div>
            </div>
            <div class="edit-col">
              <span class="vd-tag accent-tag">修改后:</span>
              <textarea v-model="editDlg.content" class="modal-textarea modal-copy"></textarea>
            </div>
          </div>
          <div class="modal-actions">
            <TButton label="确定" @click="saveEditDlg" />
            <TButton label="取消" plain @click="editDlg.show = false" />
          </div>
        </div>
      </div>
    </teleport>
  </div>
</template>

<style scoped>
/* 顶部步骤条 .step-bar 系样式已迁入 VdStepBar.vue（2026-09-10 tab 入操作区） */

.sec-label { font-size: 13px; font-weight: 600; color: var(--foreground); }
.param-label { font-size: 13px; color: var(--foreground); white-space: nowrap; }
.spacer { flex: 1; }
.ta-c { text-align: center; }
.w32 { width: 32px; }
.desc-input { height: 28px; width: 100%; padding: 0 8px; font-size: 12px; }
.score-high { color: #2ecc71; font-weight: 600; }
.score-mid { color: #f1c40f; font-weight: 600; }
.score-low { color: #e74c3c; font-weight: 600; }

/* 素材右键菜单 */
.ctx-mask { position: fixed; inset: 0; z-index: 1000; }
.ctx-menu {
  position: fixed; min-width: 140px; padding: 4px;
  background: var(--card); border: 1px solid var(--border);
  border-radius: var(--radius-md); box-shadow: 0 6px 24px rgba(0,0,0,.4);
}
.ctx-item {
  display: block; width: 100%; padding: 6px 12px; border: none; border-radius: var(--radius-sm);
  background: none; color: var(--foreground); font-size: 13px; text-align: left; cursor: pointer;
}
.ctx-item:hover { background: var(--surface-container); }

/* 页尾状态区（原版底部 stage_label + progress bar） */
.bottom-status { display: flex; flex-direction: column; gap: 6px; }
.bottom-status-row { display: flex; align-items: center; gap: var(--space-3); font-size: 13px; }
.status-text { color: var(--foreground); font-weight: 500; }
.status-text.spinning { color: var(--primary); }
.pbar { height: 6px; border-radius: 3px; background: var(--surface-container); overflow: hidden; }
.pbar-inner {
  height: 100%; width: 32%; border-radius: 3px; background: var(--primary);
  animation: pbar-slide 1.2s ease-in-out infinite;
}
@keyframes pbar-slide {
  0% { transform: translateX(-100%); }
  100% { transform: translateX(320%); }
}

.card { display: flex; flex-direction: column; gap: var(--space-4); padding: var(--space-5); background: var(--card); border: 1px solid var(--border); border-radius: var(--radius-lg); }
/* 2026-09-07 用户裁决：全程序拖拽上传区高度统一 min-height 120px（以本区原高 ≈80px 基准 +1/2），内容垂直居中 */
.dropzone { display: flex; flex-direction: column; justify-content: center; align-items: center; gap: 4px; min-height: 120px; padding: var(--space-5); background: color-mix(in srgb, var(--primary) 6%, var(--surface-container)); border: 1.5px dashed color-mix(in srgb, var(--primary) 40%, var(--border)); border-radius: var(--radius-lg); cursor: pointer; color: var(--foreground); transition: border-color var(--duration-fast), background var(--duration-fast); }
.dropzone:hover { border-color: var(--primary); background: color-mix(in srgb, var(--primary) 12%, var(--surface-container)); }
.dz-main { font-size: var(--font-size-body); font-weight: var(--font-weight-medium); }
.dz-hint { font-size: var(--font-size-caption); color: var(--muted-foreground); }

/* 2026-09-05 用户裁决：全程序列表行间统一规范——页面内嵌密集列表 = 分隔线式（1px 横线），
   弹窗选择列表 = 卡片式（边框+圆角+空隙）；本页三处列表统一改分隔线式 */
.file-list { display: flex; flex-direction: column; list-style: none; margin: 0; padding: 0; font-size: 13px; }
.file-list li { display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); padding: 6px 10px; border-bottom: 1px solid var(--border); word-break: break-all; }
.file-list li:last-child { border-bottom: none; }
.file-list li.picked { background: color-mix(in srgb, var(--primary) 12%, transparent); }
/* Step1 素材列表（缩略图 + 路径 + 播放/删除按钮） */
.src-video-list { max-height: 480px; overflow-y: auto; }
.src-video-list li { padding: 4px 8px; }
.video-thumb { width: 60px; height: 40px; object-fit: cover; border-radius: var(--radius-sm); background: #000; flex: none; }
.video-thumb--ph { display: inline-flex; align-items: center; justify-content: center; color: var(--muted-foreground); background: var(--surface-container-high); }
.video-path { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: pointer; }
.video-dur { flex: none; width: 52px; text-align: right; font-size: 12px; color: var(--muted-foreground); margin-right: 8px; font-variant-numeric: tabular-nums; }
.shot-source-cell { font-size: 12px; color: var(--muted-foreground); white-space: nowrap; }
.video-play-btn { width: 24px; height: 24px; padding: 0; font-size: 12px; line-height: 1; flex: none; background: transparent; color: var(--muted-foreground); border: 1px solid var(--border); border-radius: var(--radius-sm); cursor: pointer; margin-right: 4px; }
.video-play-btn:hover { color: var(--success); border-color: var(--success); }
.video-remove-btn { width: 24px; height: 24px; padding: 0; font-size: 16px; line-height: 1; flex: none; background: transparent; color: var(--muted-foreground); border: 1px solid var(--border); border-radius: var(--radius-sm); cursor: pointer; }
.video-remove-btn:hover { color: var(--danger); border-color: var(--danger); }
.video-count { justify-content: center; color: var(--muted-foreground); font-size: 12px; padding: 4px 10px; background: transparent; border: none; }
/* Step1 解析进度条（复用 vd-progress 配色） */
.split-progress { margin: 6px 0 2px; }
.video-count-footer { text-align: center; color: var(--muted-foreground); font-size: 12px; padding: 4px 0; }

.row { display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap; }
.row.between { justify-content: space-between; }
.row.right { justify-content: flex-end; }
.row.left { justify-content: flex-start; }
.grid2 { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: var(--space-3); }
.field { display: flex; flex-direction: column; gap: 6px; }
.label, .card-title { font-size: 13px; font-weight: 600; color: var(--foreground); }
.muted { color: var(--muted-foreground); font-size: 12px; }
.hint { color: var(--muted-foreground); font-size: 12px; }
.error-msg { color: var(--danger, #e74c3c); font-size: 12px; }
.clip-count { font-weight: 700; }

.input { height: 32px; padding: 0 10px; background: var(--card); border: 1px solid var(--border); border-radius: var(--radius-md); color: var(--foreground); outline: none; font-size: 13px; }
.input:focus { border-color: var(--primary); }
.input.grow { flex: 1; min-width: 120px; }
.w70 { width: 70px; } .w80 { width: 80px; }
.linkbtn { border: none; background: none; color: var(--primary); cursor: pointer; font-size: 12px; }

.tbl { width: 100%; border-collapse: collapse; font-size: 13px; }
.tbl-scroll-wrap { max-height: 420px; overflow-y: auto; border: 1px solid var(--border); border-radius: var(--radius-md); }
.tbl-scroll-wrap .tbl { border-radius: 0; }
.tbl th, .tbl td { padding: 6px 8px; border-bottom: 1px solid var(--border); text-align: left; vertical-align: top; }
.tbl th { color: var(--muted-foreground); font-weight: 500; font-size: 12px; position: sticky; top: 0; background: var(--surface-container); z-index: 1; }
.shot-type-badge {
  display: inline-block; padding: 1px 6px; border: 1px solid;
  border-radius: 4px; font-size: 11px; font-weight: 600; line-height: 1.4;
}

/* Step2 镜头重组（原版 params_group/result_box/player 等同布局；颜色走 V3 design tokens） */
.params-group {
  display: flex; flex-direction: column; gap: 10px; padding: 10px 12px;
  background: var(--surface-container); border: 1px solid var(--border); border-radius: var(--radius-md);
}
.param-row { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; }
.param-row .param-label { margin-left: var(--space-3); }
.param-row .param-label:first-child { margin-left: 0; }
.src-res { color: var(--warning); font-size: 11px; margin-left: 4px; }
.w60 { width: 60px; } .w90 { width: 90px; } .w120 { width: 120px; } .w140 { width: 140px; } .w180 { width: 180px; }
.clip-count { font-weight: 700; font-size: 14px; color: var(--warning); }
.result-box {
  display: flex; flex-direction: column; gap: 10px; padding: 10px;
  background: var(--surface-container); border: 1px dashed var(--border); border-radius: var(--radius-md);
}
/* 预合成列表（2026-09-09 用户裁决改表格；2026-09-11 用户裁决：最大 10 行高度，
   超出滚动；不足 10 行随真实行数收缩——占位行已删，防止两表之间空余过多） */
.plan-tbl-wrap {
  /* 380px = 表头(约30px) + 10 行(约35px/行) 完整可见（旧值 332px 行高下只能显 9 行） */
  max-height: 380px; overflow-y: auto;
  border: 1px solid var(--border); border-radius: var(--radius-md);
}
.plan-tbl-wrap .plan-tbl { border-radius: 0; }
.plan-tbl tr { cursor: pointer; }
.plan-tbl tbody tr:hover { background: color-mix(in srgb, var(--primary) 6%, transparent); }
.plan-tbl tr.picked { background: color-mix(in srgb, var(--primary) 12%, transparent); }
.plan-file { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 260px; }
.plan-copy { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted-foreground); }
.plan-empty { padding: 8px 10px; }
.w48 { width: 48px; white-space: nowrap; }
.w64 { width: 64px; white-space: nowrap; }
/* 下半区：分割镜头详情表（表头 + 10 行高，见 .detail-scroll-wrap） */
.result-bottom { display: flex; gap: 15px; align-items: flex-start; }
.detail-col { flex: 3; min-width: 0; display: flex; flex-direction: column; gap: 6px; }
.detail-scroll-wrap {
  /* 用户裁决(2026-09-11)：镜头详情至少显示 10 行 → 380px（同上方预合成列表口径） */
  max-height: 380px; overflow-y: auto; border: 1px solid var(--border); border-radius: var(--radius-sm);
}
.detail-scroll-wrap .tbl { border-radius: 0; }
.detail-placeholder-row td { height: 30px; border-bottom: 1px solid var(--border); }
/* 右侧播放器 .player-col/.player-wrap 系已删：连播预览迁右侧统一预览栏 StepPreviewPane（2026-09-10） */
.detail-tbl td { height: 30px; }
.grip-cell { cursor: grab; color: var(--muted-foreground); user-select: none; }
.row-deleted td {
  color: var(--muted-foreground); text-decoration: line-through;
  background: rgba(231, 76, 60, 0.12);
}
.clip-name, .clip-desc { max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.confirm-row > * { flex: 1; }

/* 弹窗（产品信息 / 口播文案查看） */
.modal-mask {
  position: fixed; inset: 0; z-index: 1002; display: flex; align-items: center; justify-content: center;
  background: rgba(0,0,0,.7);
}
.modal {
  display: flex; flex-direction: column; gap: 12px; width: 440px; max-width: 90vw; max-height: 80vh;
  padding: 20px; background: var(--card); border: 1px solid var(--border); border-radius: var(--radius-lg);
}
.modal-wide { width: 600px; }
/* 口播弹窗三块 1:1:1（2026-09-11 用户裁决）：左列=内嵌产品选择区（其内部
   列表 : 详情预览 = 对半），右列=填写表单——列表 : 详情 : 表单 ≈ 1 : 1 : 1 */
.modal-pick { width: 80vw; max-width: 90vw; height: 80vh; }
.pick-layout { flex: 1 1 auto; min-height: 0; display: flex; gap: var(--space-4); }
.pick-left { flex: 1 1 66.67%; min-width: 0; min-height: 0; }
/* 面板默认列表 : 预览 = 54 : 46（工作台弹窗口径不变），本弹窗内覆写为对半 */
.pick-left :deep(.picker-side) { flex: 0 0 50%; }
.pick-right { flex: 1 1 33.33%; min-width: 0; display: flex; flex-direction: column; gap: 12px; overflow-y: auto; padding-right: 2px; }
.pick-right .modal-field { flex: 0 0 auto; }
/* 2026-09-09 用户裁决：字段换行（label 上、输入框下占满整行） */
.pick-right .modal-field--stack { flex-direction: column; align-items: stretch; gap: 6px; }
.pick-right .modal-field--stack label { width: auto; }
.pick-right .modal-field--stack :deep(.input) { width: 100%; flex: none; }
.pick-right .modal-field.modal-extra { flex: 1 1 auto; min-height: 0; }
/* 2026-09-09 用户裁决：补充卖点与上方输入框左右对齐（占满整行），高度弹性填满
  剩余空间（不出现右侧滚动条） */
.pick-right .modal-textarea--tall { min-height: 0; height: auto; flex: 1 1 auto; width: 100%; }
/* 生成/取消与右侧表单贴底（2026-09-09 裁决：预览确认按钮已删，点行即选） */
.pick-right .modal-actions { margin-top: auto; }
.pick-right .modal-actions--split { justify-content: stretch; gap: 12px; }
.pick-right .modal-actions--split :deep(.t-button) { flex: 1 1 0; }
.modal-textarea--tall { min-height: 220px; }
.modal-title { font-size: 15px; font-weight: 600; }
.modal-field { display: flex; align-items: center; gap: 8px; }
.modal-field label { width: 64px; flex: none; font-size: 13px; }
.modal-field.modal-extra { align-items: flex-start; }
.modal-textarea {
  flex: 1; min-height: 72px; padding: 8px; background: var(--surface-container);
  border: 1px solid var(--border); border-radius: var(--radius-md); color: var(--foreground);
  font-size: 13px; font-family: inherit; resize: vertical; outline: none;
}
.modal-textarea:focus { border-color: var(--primary); }
.modal-copy { min-height: 300px; }
.modal-actions { display: flex; justify-content: flex-end; gap: 8px; }

/* Step3 口播配音样式（对照 VoiceRowDetailWidget 三行布局；颜色走 V3 design tokens） */
/* Step3 参考声音行（2026-09-09 用户裁决：播放条与样本下拉同行、位于其后；
   2026-09-11 修复：TSelect 根默认 width:100%，在 flex-wrap 行内独占整行把
   播放条挤到下一行 → 行内将下拉归位为弹性填充，宽度交给剩余空间） */
.ref-row :deep(.t-select) { flex: 1 1 0; width: auto; min-width: 0; }
.ref-audio { height: 32px; width: 320px; flex: 0 1 auto; }
/* 参考文案（2026-09-11 用户裁决：单行 input 显示不全 → 两行高度，可纵向拉伸）。
   源序必须在 .input 之后（同特异性覆盖其 height:32px / padding:0 10px） */
.ref-text {
  height: auto; min-height: 52px; padding: 6px 10px;
  line-height: 1.5; font-family: inherit; resize: vertical;
}
/* 页尾上传新样本（VoiceClone upload-section 同款卡片 + dropzone 拖拽区） */
.ns-section {
  padding: var(--space-5);
  background: var(--surface-container);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-lg);
}
.ns-title {
  font-size: var(--font-size-lead); font-weight: var(--font-weight-semibold);
  color: var(--foreground); margin-bottom: var(--space-4);
}
.dropzone {
  display: flex; align-items: center; gap: var(--space-3); min-height: 120px; padding: var(--space-5);
  background: color-mix(in srgb, var(--primary) 6%, var(--surface-container));
  border: 1.5px dashed color-mix(in srgb, var(--primary) 40%, var(--border));
  border-radius: var(--radius-lg); color: var(--muted-foreground); cursor: pointer;
  transition: border-color var(--duration-fast), background var(--duration-fast);
}
.dropzone:hover, .dropzone.is-active { border-color: var(--primary); background: color-mix(in srgb, var(--primary) 12%, var(--surface-container)); }
.dropzone.has-file { border-style: solid; color: var(--foreground); }
.dropzone__text { display: flex; flex-direction: column; gap: 2px; }
.dropzone__main { font-size: var(--font-size-body); font-weight: var(--font-weight-medium); color: var(--foreground); }
.dropzone__hint { font-size: var(--font-size-caption); color: var(--muted-foreground); }
.ns-fields { display: flex; flex-direction: column; gap: var(--space-3); margin-top: var(--space-4); }
.ns-field { display: flex; flex-direction: column; gap: var(--space-2); }
.ns-label { font-size: var(--font-size-caption); font-weight: var(--font-weight-medium); color: var(--foreground-muted); }
.ns-field-head { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); }
.ns-textarea { min-height: 56px; resize: vertical; }
.ns-actions { display: flex; justify-content: flex-end; }
.ns-msg { font-size: var(--font-size-caption); }
.ns-err { color: var(--error, var(--destructive, #e5484d)); }
.ns-ok { color: var(--success, #2e9e5b); }

/* 2026-09-10 用户报障：左栏折叠时操作按钮被截断隐藏、文本不能缩短 →
   table-layout:fixed 强制列宽受容器约束（序号 48px 定宽 + 详情列吃剩余），
   列内按钮 flex-wrap 换行、长文本省略，窄宽度不再把操作列挤出可视区 */
.voice-table { margin-top: var(--space-3); width: 100%; table-layout: fixed; }
.voice-table .w-idx { width: 48px; }
/* 整个列表底色（2026-09-11 用户裁决）：表体整体铺 surface-container 浅底，
   表头再深一档 surface-container-high 保持层级；行内编辑框连带反转为白底
   （见 .vd-edit 的 .voice-table 覆盖），避免灰底上输入框消失 */
.voice-table { background: var(--surface-container); }
.voice-table th { background: var(--surface-container-high); }
.vd-detail { display: flex; flex-direction: column; gap: 6px; }
.vd-top { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
/* 行内操作按钮组（2026-09-11 用户裁决：emoji 图标统一为文字小按钮；成组右对齐，
   且右缘与行 2/3「原文/修改后」文案栏右缘对齐——不是与时间列对齐。
   偏移 66px = 时间列 60px（.vd-dur-*）+ 行间隙 6px（.vd-row2/3 gap），同步维护） */
.vd-actions {
  display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
  margin-left: auto; margin-right: 66px;
}
/* 行内原生试听播放条（2026-09-15 用户裁决：<audio controls>，Chromium 原生控件） */
.vd-voice-audio {
  width: 260px; height: 32px; vertical-align: middle;
}
.vd-voice-audio[disabled] { opacity: 0.45; }
.vd-name {
  max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: 13px; font-weight: 600; color: var(--foreground);
}
.icon-btn {
  width: 28px; height: 24px; padding: 0; font-size: 13px; line-height: 1; flex: none;
  background: var(--card); color: var(--foreground);
  border: 1px solid var(--border); border-radius: var(--radius-sm); cursor: pointer;
}
.icon-btn:hover:not(:disabled) { border-color: var(--primary); }
.icon-btn:disabled { opacity: .4; cursor: not-allowed; }
.vd-status { font-size: 11px; margin-left: 4px; }
.vd-progress-text { font-size: 11px; color: var(--primary); }
.concat-status-line { font-size: 11px; color: var(--primary); margin: 4px 0 2px; }
.vd-row2, .vd-row3 { display: flex; align-items: center; gap: 6px; }
.vd-tag { flex: none; font-size: 12px; }
.muted-tag { width: 48px; color: var(--muted-foreground); }
.accent-tag { color: var(--primary); }
.vd-orig {
  flex: 1; min-width: 0; font-size: 12px; color: var(--muted-foreground);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.vd-dur-vid { flex: none; width: 60px; text-align: right; font-size: 11px; font-weight: 700; color: var(--warning); }
.vd-dur-voice { flex: none; width: 60px; text-align: right; font-size: 11px; font-weight: 700; color: var(--success); }
.vd-dur-voice.none { color: var(--muted-foreground); font-weight: 400; }
.vd-edit {
  flex: 1; min-width: 0; height: 30px; padding: 4px 8px; font-size: 13px;
  background: var(--surface-container); border: 1px solid var(--border); border-radius: 4px;
  color: var(--foreground); outline: none;
}
.vd-edit:focus { border-color: var(--success); }
/* 已生成绿背景（原版 rgba(46,204,113,0.25) + border #2ecc71，L1718-1745） */
.vd-edit.has-wav { background: rgba(46, 204, 113, 0.25); border-color: #2ecc71; }
/* 2026-09-11 列表底色裁决连带：表体已铺浅灰底，默认态编辑框反转为白底保持可辨识。
   必须用 :not(.has-wav) —— 绿底规则同特异性且在本规则之前，不限定会被罩掉 */
.voice-table .vd-edit:not(.has-wav) { background: var(--card); }
.vd-progress { width: 100%; height: 6px; appearance: none; border-radius: 3px; overflow: hidden; }
.vd-progress::-webkit-progress-bar { background: var(--surface-container); }
.vd-progress::-webkit-progress-value { background: var(--primary); transition: width 0.3s; }
/* 2026-09-09 用户裁决：克隆按钮独立外框 + 配音设置分组（字幕/花字/配音按钮） */
.action-box {
  padding: var(--space-4); background: var(--surface-container);
  border: 1px solid var(--border); border-radius: var(--radius-md);
}
/* 2026-09-10 用户裁决：设置组靠左、克隆主操作居最右（两端对齐）。
   2026-09-11 用户裁决：本行控件等高——下拉 34 / 小按钮 28 / 主按钮 36 三种高度
   混排 → 统一为输入高度 34px（与下拉及页面表单控件同口径，含四颗按钮） */
.clone-row { align-items: center; }
.clone-row :deep(.t-button) { height: var(--size-input-height); }
.chk {
  display: flex; align-items: center; gap: 6px; cursor: pointer;
  font-size: 13px; font-weight: 600; color: var(--foreground);
}
.chk input { accent-color: var(--primary); }
.w230 { width: 230px; }
.w110 { width: 110px; }
.w130 { width: 130px; }
/* 花字模板预览标签（fancy_template_preview_lbl 124x34 #202020） */
.fancy-preview {
  display: inline-flex; align-items: center; justify-content: center;
  width: 124px; height: 34px; flex: none;
  background-color: #202020; color: #666; font-size: 10px; border-radius: 3px;
  overflow: hidden;
}
.fancy-preview img { width: 100%; height: 100%; object-fit: cover; }
/* 服务端模板无本地预览图（textfx 渲染在服务端）→ 描述文字占位 */
.fancy-preview-desc {
  max-width: 100%; max-height: 100%; padding: 0 6px; text-align: center;
  font-size: 10px; line-height: 1.3; color: #aaa;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}
.fancy-content-hint { color: #888; font-size: 12px; }
/* 字幕预设样式色板（2026-09-09 裁决：图3 ~24 格，点选即选中；tile 内嵌「字幕」样字按预设渲染） */
.sub-style-grid {
  /* 2026-09-09 二次裁决：单行流式（原固定 8 列三行），放不下自动换行 */
  display: flex; flex-wrap: wrap; align-content: flex-start; gap: 6px;
  flex: 1 1 auto; min-width: 0;
}
.sub-style-tile {
  height: 32px; display: inline-flex; align-items: center; justify-content: center;
  background: #2a2a2a; border: 1px solid var(--border); border-radius: 4px;
  cursor: pointer; padding: 0; overflow: hidden;
  transition: border-color var(--duration-fast) var(--easing-default),
    box-shadow var(--duration-fast) var(--easing-default);
}
.sub-style-tile:hover { border-color: var(--primary); }
.sub-style-tile.active { border-color: var(--primary); box-shadow: 0 0 0 2px var(--ring); }
.sub-style-tile-text { font-size: 14px; font-weight: 700; line-height: 1; white-space: nowrap; pointer-events: none; }
/* 效果预览画布（字幕/花字行3 共用；深底渐变近似视频画面） */
.style-preview-canvas {
  flex: 1; min-width: 0; height: 52px;
  display: flex; align-items: center; justify-content: center;
  background: linear-gradient(135deg, #3a3f4a 0%, #23262e 100%);
  border: 1px solid var(--border); border-radius: 6px; overflow: hidden;
}
.style-preview-text {
  max-width: 94%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  padding: 2px 10px;
}
/* 字幕入场动画预览（2026-09-10 用户裁决：字幕可选动画，预览与烧制同用该选择；
   CSS 循环近似演示 drawtext 烧制效果，与成品非逐帧一致） */
@keyframes sub-anim-fade-kf {
  0%   { opacity: 0; }
  25%  { opacity: 1; }
  80%  { opacity: 1; }
  100% { opacity: 0; }
}
@keyframes sub-anim-rise-kf {
  0%   { opacity: 0; transform: translateY(8px); }
  25%  { opacity: 1; transform: translateY(0); }
  80%  { opacity: 1; transform: translateY(0); }
  100% { opacity: 0; transform: translateY(0); }
}
@keyframes sub-anim-slide-kf {
  0%   { opacity: 0; transform: translateX(24px); }
  25%  { opacity: 1; transform: translateX(0); }
  80%  { opacity: 1; transform: translateX(0); }
  100% { opacity: 0; transform: translateX(0); }
}
@keyframes sub-anim-pop-kf {
  0%   { opacity: 0; transform: scale(0.6); }
  20%  { opacity: 1; transform: scale(1.15); }
  30%  { transform: scale(0.95); }
  38%  { transform: scale(1); }
  80%  { opacity: 1; transform: scale(1); }
  100% { opacity: 0; transform: scale(1); }
}
.sub-anim-fade  { animation: sub-anim-fade-kf 2.4s ease-in-out infinite; }
.sub-anim-rise  { animation: sub-anim-rise-kf 2.4s ease-out infinite; }
.sub-anim-slide { animation: sub-anim-slide-kf 2.4s ease-out infinite; }
.sub-anim-pop   { animation: sub-anim-pop-kf 2.4s ease-out infinite; }

/* 文案生成设置弹窗 */
.rw-title { font-size: 13px; color: var(--foreground); }
.rw-desc { font-size: 12px; color: var(--muted-foreground); white-space: pre-line; }
.rw-value { font-size: 14px; font-weight: 700; color: var(--primary); text-align: center; }

/* TTS 引擎下拉（表格标题行内，不占满） */
.tts-engine-select { width: 220px; flex: none; }
/* 设置声音克隆弹窗 */
.cp-field { display: flex; flex-direction: column; gap: 6px; }
.cp-value { font-size: 13px; font-weight: 700; color: var(--primary); }
.cp-labels { font-size: 11px; color: var(--muted-foreground); }
.cp-tip { font-size: 11px; color: var(--muted-foreground); line-height: 1.5; }

/* AI 生成 BGM 面板（音频生成页「生成 BGM」同款布局，2026-09-09 用户裁决） */
.ag-style-select { width: 160px; flex: none; }
.ag-tag-select { width: 150px; flex: none; }
.ag-num-input { width: 72px; flex: none; }
.agb-gen-row { justify-content: flex-end; }
.agb-result { margin: 0; font-size: 12px; color: var(--muted-foreground); white-space: pre-line; }

/* BGM 选择弹窗（音频生成页左栏同款） */
.bgm-pick { width: min(900px, 92vw); }
.bgm-kind-select { width: 170px; flex: none; }
.bgm-tag-input { max-width: 140px; }
.bgm-page-input { width: 64px; }
.bgm-pick-audio { height: 30px; max-width: 220px; }
.bgm-pick-rows {
  height: min(420px, 50vh); overflow-y: auto;
  border: 1px solid var(--border); border-radius: var(--radius-md);
  display: flex; flex-direction: column;
}
.bgm-pick-state { padding: 24px 16px; text-align: center; font-size: 12px; color: var(--muted-foreground); }
.bgm-pick-row {
  display: flex; align-items: center; gap: 8px;
  flex: 0 0 auto; height: 36px; padding: 0 12px;
  border-bottom: 1px solid var(--border); cursor: pointer;
}
.bgm-pick-row:last-child { border-bottom: none; }
.bgm-pick-row:hover { background: var(--surface-container); }
.bgm-pick-row.picked { background: var(--surface-container); box-shadow: inset 3px 0 0 var(--primary); }
.bgm-pick-row.playing { color: var(--primary); }
.bgm-pick-name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
.bgm-pick-meta { font-size: 12px; color: var(--muted-foreground); flex: none; }
.bgm-pick-act {
  display: inline-flex; align-items: center; justify-content: center;
  width: 26px; height: 26px; border-radius: var(--radius-sm);
  color: var(--primary); flex: none; cursor: pointer;
}
.bgm-pick-act:hover { background: var(--surface-container-high); }

/* 配音文案编辑弹窗：原文/修改后左右对照 1:1（2026-09-11 用户裁决：左右并排等宽，
   而非上原文下编辑框；两栏等高，原文栏为只读框、修改栏为编辑 textarea） */
.edit-cols { display: flex; gap: var(--space-3); align-items: stretch; }
.edit-col { flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; gap: 6px; }
.edit-col .vd-orig {
  flex: 1 1 auto; min-height: 300px; padding: 8px;
  background: var(--surface-container); border: 1px solid var(--border);
  border-radius: var(--radius-md); color: var(--foreground); font-size: 13px;
  white-space: pre-wrap; overflow-wrap: anywhere; overflow-y: auto;
}

/* Step4 AI 生成 BGM 面板 */
.ai-bgm-panel {
  display: flex; flex-direction: column; gap: var(--space-3);
  padding: var(--space-4); background: var(--surface-container);
  border: 1px solid var(--border); border-radius: var(--radius-md);
}
.ai-bgm-panel audio { flex: 1; min-width: 200px; height: 36px; }

/* Step4 特效包装/字幕分组（2026-09-09 裁决：花字/文字模板自 Step3 迁入；
   2026-09-13 裁决：字幕拆出单独成组置于背景音乐上方，两盒共用本样式） */
.fx-pack-box { display: flex; flex-direction: column; gap: var(--space-3); margin-bottom: var(--space-4); }
.fx-pack-title {
  font-size: 13px; font-weight: var(--font-weight-semibold); color: var(--foreground);
  padding-bottom: var(--space-2); border-bottom: 1px solid var(--border);
}
/* 文字模板效果预览：逐词应用随机模板，词下角标显示模板名 */
.textfx-word {
  display: inline-flex; flex-direction: column; align-items: center; gap: 2px;
  margin: 0 6px; padding: 2px 8px; background: #2a2a2a; border: 1px solid var(--border);
  border-radius: var(--radius-sm); font-size: 16px; font-weight: 700; color: #ffd24d;
  text-shadow: 0 0 4px rgba(0, 0, 0, 0.8);
}
/* 2026-09-10 用户终裁：词条只显示关键词本体（textfx-word-tpl 模板名小字废止） */
/* 效果预览时间轴（2026-09-10 用户裁决：每视频一条，背景条=视频时长，
   词条按 timing 真实时间点绝对定位；hover 提示词/模板/时间点） */
/* 2026-09-10 报障：多轨被共用画布 52px 固定高裁剪 → 曾放开到 168px 高、3 轨滚动；
   2026-09-11 用户裁决改用平铺：有几条视频几条轨全部显示不内部滚动
   （高度由内容撑开，长列表交给页面滚动） */
.textfx-tracks { flex-direction: column; align-items: stretch; justify-content: flex-start; gap: 6px; height: auto; overflow: hidden; }
.textfx-track { display: flex; align-items: center; gap: 8px; min-width: 0; }
.textfx-track-name {
  /* 2026-09-11 用户裁决：轨名=「第N条」序号（190px 文件名宽版与 break-all 换行废止，
     完整视频名保留在 title 悬停提示）；定宽保证各轨条头对齐 */
  flex: 0 0 60px; font-size: 11px; color: var(--muted-foreground);
  white-space: nowrap; text-align: right; line-height: 1.3;
}
.textfx-track-bar {
  position: relative; flex: 1; height: 44px; min-width: 0;
  background: repeating-linear-gradient(90deg, #262626 0 46px, #2e2e2e 46px 47px);
  border: 1px solid var(--border); border-radius: var(--radius-sm); overflow: hidden;
}
.textfx-track-item {
  position: absolute; top: 50%; transform: translateY(-50%);
  display: inline-flex; flex-direction: column; align-items: center; gap: 1px;
  padding: 2px 7px; background: #2a2a2a; border: 1px solid var(--border);
  border-radius: var(--radius-sm); font-size: 14px; font-weight: 700;
  /* 2026-09-10 用户裁决：词条颜色由命中模板决定（tplStyle 行内注入，
     与烧制主色同源）；默认色=白（烧制缺省主色），写死黄色废止 */
  color: #fff;
  text-shadow: 0 0 4px rgba(0, 0, 0, 0.8); white-space: nowrap; cursor: default;
}
/* 文字模板样式预览：按模板 variables 默认色本地渲染示例（服务端无预览接口，2026-09-10） */
/* 文字模板行样式预览（2026-09-11 用户终裁：换行铺满 + 默认只显示一行，
 * 超出由行尾「展开/收起」按钮控制；旧的横向滚动 + 两端箭头方案废止） */
.style-preview-canvas.textfx-canvas {
  justify-content: flex-start;
  align-items: flex-start;
  align-content: flex-start;
  flex-wrap: wrap;
  height: auto;
  max-height: var(--fx-row-h, 56px);
  overflow: hidden;
  padding: 4px 8px;
  row-gap: 4px;
}
.style-preview-canvas.textfx-canvas.textfx-expanded {
  max-height: 420px;
  overflow-y: auto;
}
/* 折叠按钮（最右侧）：不用 .icon-btn（28px 宽装不下中文） */
.textfx-toggle {
  flex: none; height: 24px; padding: 0 8px; font-size: 12px; white-space: nowrap;
  background: var(--card); color: var(--muted-foreground);
  border: 1px solid var(--border); border-radius: var(--radius-sm); cursor: pointer;
}
.textfx-toggle:hover { border-color: var(--primary); color: var(--foreground); }
.textfx-sample {
  display: inline-flex; flex-direction: column; align-items: center; gap: 2px;
  margin: 0 6px; padding: 4px 10px; background: #2a2a2a; border: 1px solid var(--border);
  border-radius: var(--radius-sm);
}
.textfx-sample-text {
  font-weight: 700; line-height: 1.2; max-width: 160px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  text-shadow: 0 0 4px rgba(0, 0, 0, 0.8);
}
/* 样式预览循环动画（2026-09-10 按服务端模板定义全量对齐 10 个动画模板：
   服务端以 id/name 语义 + variables 效果色变量约定动画，效果色经 --fx-color 注入；
   本地 CSS 近似演示，与服务端烧制效果非逐帧一致） */
/* 2026-09-13 用户裁决：文字模板预览要不播真实动画（render-preview/服务端 webm），
   要不只显示文字/静态图——CSS 近似模板动画整体废止（原 keyframes + textfx-anim-* 已删） */
/* 2026-09-14 用户裁决：样式预览换成剪映模板页同款卡片（9:16 视频卡+模板名），
   原 52px 共用容器压扁竖版视频 → 文字模板组独立加高 */
.textfx-sample-video { width: 108px; height: 160px; object-fit: cover; display: block; border-radius: 4px; background: #101010; }
/* 时间轴词条真实动画素材（alpha webm）：高度撑满轨条，宽度按素材比例 */
.textfx-clip { height: 100%; width: auto; display: block; border-radius: 3px; }
.w80 { width: 80px; flex: none; }

/* Step4 特效包装（对照 step4_final_view.py L80-196 同布局；颜色走 V3 design tokens） */
.vd4-gain { width: 140px; flex: none; accent-color: var(--primary); }
.vd4-gain-label { width: 50px; flex: none; font-size: 13px; color: var(--foreground); }
/* 播放/暂停、停止按钮（原版 ▶ 56x28，L80-88） */
.vd4-pbtn { width: 56px; height: 28px; font-size: 13px; }
/* 试听进度条（原版 groove 4px #27272a / handle #3b82f6 12px，L80-92 → token 化） */
.vd4-seek {
  height: 4px; appearance: none; border-radius: 2px; cursor: pointer;
  background: var(--border); outline: none;
}
.vd4-seek::-webkit-slider-thumb {
  width: 12px; height: 12px; margin-top: 0; border: none; border-radius: 6px;
  background: var(--primary); appearance: none;
}
.vd4-time { width: 90px; flex: none; font-size: 12px; color: var(--muted-foreground); text-align: center; }
/* 开始混音合成（原版 action_button 高 40 全宽，L116） */
.vd4-run { width: 100%; height: 40px; margin-top: var(--space-2); }
.vd4-grow { flex: 1; width: auto; }
/* 2026-09-18 用户裁决：导出方案引导区（标题 + 方案一/二文案 + 各自按钮竖排） */
.vd4-schemes { display: flex; flex-direction: column; }
.vd4-scheme-title { margin-top: var(--space-2); font-size: 13px; font-weight: 600; color: var(--foreground); }
.vd4-scheme-line { margin-top: 6px; font-size: 12px; color: var(--muted-foreground); }
/* 结果区（原版 result_box：rgba(255,255,255,0.03) + border rgba(255,255,255,0.1)，L116 → token 化） */
.vd4-result {
  display: flex; gap: 15px; padding: 10px; margin-top: var(--space-2);
  background: var(--surface-container); border: 1px solid var(--border); border-radius: 4px;
}
.vd4-left { flex: 3; min-width: 0; display: flex; flex-direction: column; gap: 8px; }
.vd4-left-title { font-size: 13px; font-weight: 600; color: var(--foreground); }
/* 成片列表限高约 10 行（2026-09-15 用户裁决：多则滚动、少则按实际高度），行内带逐条导出按钮 */
.vd4-list { max-height: 320px; overflow-y: auto; }
.vd4-btns { display: flex; gap: 8px; }
.vd4-btns > .t-button { flex: 1; padding: 0 6px; }
/* 界面统一两栏（2026-09-10 用户需求「二三四步界面统一+联动预览」）：
   左=操作区（自适应），右=统一预览栏（拖拽调比例）；
   2026-09-10 用户报障「口播配音界面重叠」：左栏表格 min-content 撑破盒子溢出绘制
   进右栏区 → 左栏 overflow:hidden 截断 + 右栏 border-left 明确分界 */
.vd-unified { display: flex; gap: 0; align-items: stretch; min-height: 0; }
.vd-unified-left { min-width: 0; display: flex; flex-direction: column; gap: var(--space-2); padding-right: 12px; overflow: hidden; }
.vd-unified-right { flex: 1 1 0; min-width: 260px; display: flex; flex-direction: column; min-height: 0; padding-left: 12px; border-left: 1px solid var(--border); }
/* 可拖拽分隔条：左右比例手动调整（默认 6:4，拖后 localStorage 记忆） */
.vd-split {
  flex: 0 0 6px; cursor: col-resize; border-radius: 3px;
  background: transparent; transition: background 0.15s;
}
.vd-split:hover { background: var(--primary); opacity: 0.35; }

/* 状态标签样式 */
.st-pending { color: var(--muted-foreground); font-size: 12px; }
.st-running { color: var(--primary); font-size: 12px; font-weight: 600; }
.st-done { color: var(--success); font-size: 12px; font-weight: 600; }
.st-failed { color: var(--danger, #e74c3c); font-size: 12px; font-weight: 600; }

/* 还原 LUT：库内选择列表（2026-09-14） */
.lut-list { display: flex; flex-direction: column; gap: 4px; max-height: 132px; overflow-y: auto; }
</style>
