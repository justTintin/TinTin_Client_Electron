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
import { ref, reactive, computed, onMounted, onUnmounted, watch } from 'vue'
import TButton from '@/components/common/TButton.vue'
import TSelect from '@/components/common/TSelect.vue'
import VideoPreview from '@/components/common/VideoPreview.vue'
import VideoPlayer from '@/components/common/VideoPlayer.vue'
import { useVideoMontage } from '@/composables/useVideoMontage'
import { useAudioGen } from '@/composables/useAudioGen'
import { useFilePicker } from '@/composables/useFilePicker'
import WbPickProductPanel from '@/components/workbench/WbPickProductPanel.vue'
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
  // 字幕预设样式（2026-09-09 裁决：样式属字幕配置；SUBTITLE_STYLE_PRESETS 为图3 色板）
  subtitleStyleKey, SUBTITLE_STYLE_PRESETS, subtitlePreviewStyle, fontOptionStyle,
  subtitleAnimKey,
  fancyEnabled, fancyStyle, fancyPosition, subtitleBgOpacity,
  // 文字模板（2026-09-09 裁决：服务端 textfx 体系，与花字独立；随机样式默认 3 个）
  textFxEnabled, textTemplateId, textTemplateOptions, textTemplates,
  textRandomCount, TEXT_RANDOM_COUNT_OPTIONS, textFxPreviewItems, textFxStyleSamples,
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
  regenVoice, exportVoice, playVoice, playRowVideo, playDubbedVideo,
  toggleLengthMode, lengthModeTip,
  voiceStatusText, voiceStatusClass, pathBasename,
  // Step4 特效包装（对照 step4_final_view.py 逐控件）
  bgmPath, bgmName, bgmVolume, finalBusy, finalDone, finalProgress,
  finalVideoList, finalSelIdx, finalPreviewUrl, finalPreviewTitle,
  bgmSource,
  bgmPlaying, bgmPosMs, bgmDurMs,
  pickBgm, applyLibraryBgm, toggleBgmPlay, stopBgmPlay, onBgmVolumeInput, seekBgm,
  enterStep4, startFinalMix, openFinalDir,
  exportJianyingDraft, exportAllToJianyingDraft, previewFinalVideo,
  fmtBgmTime,
  selectRefAudio,
  fmtDur,
  planDurText,
  // 景别分类
  SHOT_TYPE_LABELS, SHOT_TYPE_COLORS,
} = useVideoMontage()

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

/** 生成面板内联播放（同 AudioGen playBgm：本地归档优先，未就绪回退在线 URL） */
const agBgmAudioEl = ref<HTMLAudioElement | null>(null)
function playAgBgm(): void {
  const el = agBgmAudioEl.value
  if (!el) return
  if (bgmLocal.value) {
    el.src = 'file:///' + encodeURI(bgmLocal.value.replace(/\\/g, '/')).replace(/#/g, '%23')
    void el.play().catch(() => { /* 加载失败静默 */ })
    return
  }
  if (!bgmUrl.value) return
  el.src = toAbsolute(bgmUrl.value)
  void el.play().catch(() => { /* 加载失败静默 */ })
}

/** BGM 选择弹窗（同音频生成页左栏布局：搜索/分类/标签/列表/分页；单击选中，双击或 ▶ 试听） */
const bgmPickDlg = ref<{ show: boolean; pickedMid: string; busy: boolean; error: string }>({ show: false, pickedMid: '', busy: false, error: '' })
function openBgmPickDlg(): void {
  bgmPickDlg.value.show = true
  bgmPickDlg.value.error = ''
  if (!listRows.value.length && !listLoading.value) doSearch()
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
// 声音样本与 VoiceClone 页同口径：每次进入 Step3（及挂载时）重新拉取（原实现仅在
// composable 创建时拉一次，服务端新增样本/离线恢复后下拉一直为空）
onMounted(() => { void loadRefSamples() })
watch(step, (v) => { if (v === 2) void loadRefSamples() })

/** 输出画幅下拉（原版 layout_combo 3 项；首项动态附原片分辨率，L4800-4802 同口径） */
const LAYOUTS = computed(() => [
  { label: splitResolution.value ? `与原视频一致 (${splitResolution.value})` : '与原视频一致', value: 'source' },
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

    <!-- 顶部步骤条（原版 step_labels 是 QLabel 不可点击，仅通过按钮切换；本端保留可点击但加门控：仅允许跳转到已完成或当前步骤） -->
    <div class="step-bar">
      <template v-for="(s, i) in STEPS" :key="s">
        <div class="step-pill" :class="{ active: step === i, done: step > i, disabled: i > step }" @click="i <= step && go(i)">
          <span class="step-dot" v-if="step > i">✓</span>{{ s }}
        </div>
        <span v-if="i < STEPS.length - 1" class="step-arrow">›</span>
      </template>
    </div>

    <!-- 共享任务状态条移至页尾（原版底部 stage_label + progress_bar 同位置） -->

    <!-- Step 1: 镜头智能分割（布局对照原版 gui/montage/step1_split_view.py L27-181） -->
    <template v-if="step === 0">
      <section class="card">
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

    <!-- Step 2: 镜头重组（布局逐控件对照原版 gui/montage/step2_concat_view.py setup_ui） -->
    <template v-else-if="step === 1">
      <section class="card">
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
              title="分割片段检测到的原始画幅，选择'与原视频一致'时将使用此分辨率">
              原片: {{ splitResolution || '未知' }}</span>
            <span class="param-label">时长限制:</span>
            <select v-model.number="durationLimit" class="input w80" title="每个预合成视频的总时长上限（实际不超此值的 1.1 倍）">
              <option v-for="s in DURATION_LIMITS" :key="s" :value="s">{{ s }} 秒</option>
            </select>
            <span class="param-label">生成视频数量 (1-20):</span>
            <input v-model.number="batchCount" type="number" min="1" max="20" class="input w60" />
            <span class="hint">推荐: {{ recBatchCount }}</span>
          </div>
          <!-- Parameters row 2（原版 L109-140：转场动画 | 出入场加速） -->
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
              <!-- 不足 10 行时占位，保持固定高度 -->
              <tr v-for="n in Math.max(0, 10 - assemblePlans.length)" :key="'ph'+n" class="plan-placeholder"><td colspan="5"></td></tr>
            </tbody>
          </table>
          <div v-if="!assemblePlans.length" class="muted plan-empty">尚无预合成视频，勾选镜头后点击「镜头重组」</div>

          <!-- 下半区：左=分割镜头详情表（10行高度），右=视频预览（等高） -->
          <div class="result-bottom">
            <div class="detail-col">
              <span class="sec-label">视频组成镜头详情 (拖动把手调序，右键删除/恢复镜头):</span>
              <div class="detail-scroll-wrap">
                <table class="tbl detail-tbl">
                  <thead><tr>
                    <th class="w48">序号</th><th class="w32"></th><th style="min-width:120px">分割文件名</th>
                    <th>时长</th><th>景别</th><th style="min-width:180px">描述文案</th><th>评分</th>
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
                      <td class="clip-desc" :title="c.description">{{ c.description || '—' }}</td>
                      <td class="ta-c" :class="scoreClass(c.score)">{{ c.score ? c.score.toFixed(1) : '—' }}</td>
                    </tr>
                    <!-- 不足 10 行时占位 -->
                    <tr v-for="n in Math.max(0, 10 - (currentPlan?.clips.length || 0))" :key="'dph'+n" class="detail-placeholder-row"><td colspan="7"></td></tr>
                  </tbody>
                  <tbody v-else>
                    <tr><td colspan="7" class="muted">单击上方预合成项查看镜头详情</td></tr>
                  </tbody>
                </table>
              </div>
            </div>
            <div class="player-col">
              <span class="sec-label">视频播放预览:</span>
              <div class="player-wrap">
                <VideoPlayer v-if="seqSrc" :src="seqSrc" autoplay class="player-video" @ended="onSeqEnded" />
                <div v-else class="player-empty">单击预合成项预览序列</div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <!-- 确认行（原版 confirm_row L268-286：确认合成视频 + 生成口播文案，初始禁用） -->
      <div class="row confirm-row">
        <TButton label="确认合成视频" :loading="confirmBusy" :disabled="!hasUnconfirmed" @click="confirmAllPrecompose" />
        <!-- 2026-09-09 用户裁决：合成完成后生成口播文案要标明可点击状态（可用时切 primary 高亮） -->
        <TButton label="生成口播文案" :variant="confirmedPaths.length ? 'primary' : 'secondary'" :loading="copyBusy" :disabled="!confirmedPaths.length" @click="openProductDlg('all')" />
      </div>
      <!-- 确认合成进度（样式对齐 Step1 split-progress，同卡片内按钮行下方呈现；
        阶段值对照原版 montage_concat_server_worker progress：提交 30/轮询钳 48/完成 100）；
        状态文案置于进度条上方（用户裁决：文字在进度条上面） -->
      <template v-if="confirmBusy">
        <div class="concat-status-line">{{ statusText }}</div>
        <progress class="vd-progress split-progress" :value="concatProgress" max="100" />
      </template>

      <!-- 导航行（原版 nav_row L288-301：上一步：镜头分割 / 下一步：克隆口播） -->
      <div class="row between">
        <TButton label="上一步：镜头分割" plain @click="go(0)" />
        <TButton label="下一步：克隆口播" icon="right" :disabled="!confirmedPaths.length" @click="go(2)" />
      </div>
    </template>

    <!-- Step 3: 口播配音（对照 gui/montage/step3_voice_view.py L27-298 逐控件一比一） -->
    <template v-else-if="step === 2">
      <section class="card">
        <!-- 1. 视频输入目录行：2026-09-08 用户裁决删除——口播配音无视频输入功能，
             配音对象自动取 Step2 已确认合成产物所在目录 -->

        <!-- 2. 参考声音（对齐 VoiceClone 页形态：样本下拉 + 常驻播放条换 src；
             声音样本数据源 = 服务端 GET /voice/samples；选中样本自动带出参考文案） -->
        <div class="row">
          <label class="label">参考声音:</label>
          <TSelect :model-value="selectedRefSample ? `sample:${selectedRefSample.id}` : ''" :options="refAudioOptions" class="grow" @update:model-value="onRefAudioChange" />
          <!-- 2026-09-09 用户裁决：播放条放到样本下拉框后面（同行右侧） -->
          <audio v-if="refPreviewUrl" :src="refPreviewUrl" controls preload="auto" class="ref-audio" />
        </div>

        <!-- 3. 参考文案行 -->
        <div class="row">
          <label class="label">参考文案:</label>
          <input v-model="refText" class="input grow" placeholder="可选，填入样本台词..." />
        </div>

        <!-- TTS API 与推理参数行：2026-09-08 用户裁决删除（TTS 地址自动跟随系统设置，
             ttsSteps/ttsCfg 存而不用；ttsSpeedMin/Max 保留默认值 0.9~1.2 随克隆请求发送） -->

        <!-- 4. 表格标题行（L177-196） -->
        <div class="row between">
          <span class="card-title"> 待合成视频列表与配音文案映射 (在配音文案栏直接输入):</span>
          <div class="row">
            <!-- 2026-09-09 用户裁决：文案生成设置左边加 TTS 选择下拉（默认 idexttts）
                 + 设置声音克隆按钮（弹窗配置克隆参数，克隆时随请求发送） -->
            <TSelect v-model="ttsEngine" :options="TTS_ENGINE_OPTIONS" class="tts-engine-select" />
            <TButton label="设置声音克隆" variant="secondary" size="small" @click="openCloneParams" />
            <TButton label="文案生成设置" variant="secondary" size="small" @click="openRewriteSettings" />
            <TButton label="一键AI修改全部文案" size="small" :loading="rewriteBusy" @click="batchAiRewrite" />
          </div>
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
                  <!-- 行 1：文件名 + 播放视频（配音后优先） + 状态 + 操作 -->
                  <div class="vd-top">
                    <span class="vd-name" :title="row.path">视频: {{ row.name }}</span>
                    <button class="icon-btn" title="播放视频（配音后优先）" @click="playRowVideo(i)">▶</button>
                    <span class="spacer"></span>
                    <span v-if="row.status === 'generating'" class="vd-progress-text">{{ row.progress }}%</span>
                    <span class="vd-status" :class="voiceStatusClass(row)">{{ voiceStatusText(row) }}</span>
                    <button class="icon-btn" title="播放克隆的声音" :disabled="!row.wavPath" @click="playVoice(i)">🔊</button>
                    <button class="icon-btn" title="导出该克隆声音" :disabled="!row.wavPath" @click="exportVoice(i)">💾</button>
                    <button class="icon-btn" title="对比与编辑文案" @click="openEditDlg(i)">⚖</button>
                    <button class="icon-btn" title="仅重新生成该声音" :disabled="row.status === 'generating'" @click="regenVoice(i)">↻</button>
                    <button class="icon-btn" :title="lengthModeTip(row)" @click="toggleLengthMode(i)">{{ row.lengthMode === 'video' ? '🎬' : '🎵' }}</button>
                    <button class="icon-btn" :title="row.dubbedPath ? '播放配音后的视频' : '尚未生成配音视频'" :disabled="!row.dubbedPath" @click="playDubbedVideo(i)">📽</button>
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

        <!-- 6. 声音克隆动作外框（2026-09-09 用户裁决：烧制字幕/添加花字属配音设置，
             移入下方「视频配音设置」分组，此处仅保留克隆按钮独立成框） -->
        <div class="action-box voice-clone-box">
          <TButton label="开始批量克隆人声合成" class="clone-btn" :loading="voiceBusy" @click="startSynthesizeVoice" />
        </div>

        <!-- 7. 配音动作已迁 Step4 统一合成（2026-09-09 用户裁决：Step3 只合成口播声音，
             配音+特效烧制+BGM 混音在第四步点「开始混音合成」一键完成） -->

        <!-- 克隆批量进度（主进程逐条 emitRow 聚合为整体百分比；文案+进度条对照确认合成形态） -->
        <template v-if="voiceBusy">
          <div class="concat-status-line">{{ statusText }}</div>
          <progress class="vd-progress split-progress" :value="voiceProgress" max="100" />
        </template>
      </section>

      <!-- 导航行（L284-297；2026-09-09 用户裁决：合成声音即可跳转第四步，配音在第四步统一处理） -->
      <div class="row between">
        <TButton label="上一步：镜头重组" plain @click="go(1)" />
        <TButton label="下一步：特效包装" icon="right" title="生成口播声音后即可进入；配音/特效/混音在第四步统一合成"
          :disabled="!voiceRows.some(r => r.wavPath)" @click="go(3)" />
      </div>
    </template>

    <!-- Step 4: 特效包装（step4_final_view.py L14-196 逐控件；另保留本端 AI 生成 BGM）；
         2026-09-09 用户裁决：烧制字幕/花字/文字模板特效配置自 Step3 迁入此处，随混音统一烧制，
         字幕文案按视频从 Step3 文案表带过去 -->
    <template v-else>
      <section class="card">
        <!-- 特效包装分组：烧制字幕 + 花字 + 文字模板 -->
        <div class="action-box fx-pack-box">
          <div class="fx-pack-title">特效包装</div>

          <!-- 烧制字幕（原 Step3 三行原样迁入：行1 勾选 / 行2 字体+背景+预设样式色板 / 行3 效果预览；
               样式 key 与主进程 SUBTITLE_STYLES 同表） -->
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
            <label class="param-label">预设样式:</label>
            <div class="sub-style-grid" title="字幕文字样式预设（烧制时以 ffmpeg drawtext 描边实现，效果以成品为准）">
              <button v-for="p in SUBTITLE_STYLE_PRESETS" :key="p.key" type="button" class="sub-style-tile"
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

          <!-- 花字（原 Step3 三行原样迁入） -->
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

          <!-- 文字模板（2026-09-09 用户裁决：服务端 textfx 动画体系，与花字独立概念；
               随机样式默认从全部模板中选 3 个；烧制待服务端烧制接口上线，先配置+预览；
               2026-09-10 布局裁决：勾选/设置/样式预览/效果预览各占一行） -->
          <div class="row">
            <label class="chk" title="服务端文字模板（textfx 动画：弹跳/打字机/霓虹等），与花字是独立体系。&#10;随机样式：从模板库全部样式中随机选取 N 个轮换使用。&#10;烧制需服务端渲染支持（接口上线后接线）。">
              <input v-model="textFxEnabled" type="checkbox" />
              添加文字模板 (关键信息动画提醒)
            </label>
          </div>
          <div v-if="textFxEnabled" class="row">
            <label class="param-label">文字模板:</label>
            <TSelect v-model="textTemplateId" :options="textTemplateOptions" class="w130"
              title="来自服务端文字模板库（GET /text_templates/templates）。&#10;选「随机样式」时每次合成从全部模板随机选取 N 个，逐个关键词轮换使用。" />
            <template v-if="textTemplateId === 'random'">
              <label class="param-label">随机数量:</label>
              <TSelect v-model="textRandomCount" :options="TEXT_RANDOM_COUNT_OPTIONS" class="w80"
                title="随机模式下从全部文字模板样式中选取的个数（默认 3 个）" />
            </template>
          </div>
          <div v-if="textFxEnabled" class="row">
            <label class="param-label">样式预览:</label>
            <div class="style-preview-canvas">
              <template v-if="textFxStyleSamples.length">
                <span v-for="s in textFxStyleSamples" :key="'ts' + s.id" class="textfx-sample"
                  :title="`模板：${s.name}`">
                  <span class="textfx-sample-text" :class="`textfx-anim-${s.anim}`" :style="s.style">{{ s.text }}</span>
                  <small class="textfx-word-tpl">{{ s.name }}</small>
                </span>
              </template>
              <span v-else class="muted">{{ textTemplates.length ? '未命中模板' : '文字模板库为空，请先在服务端上传文字模板' }}</span>
            </div>
          </div>
          <div v-if="textFxEnabled" class="row">
            <label class="param-label">效果预览:</label>
            <div class="style-preview-canvas">
              <template v-if="textFxPreviewItems.length">
                <span v-for="(w, i) in textFxPreviewItems" :key="'tw' + i" class="textfx-word"
                  :title="`模板：${w.tplName}`">{{ w.word }}<small class="textfx-word-tpl">{{ w.tplName }}</small></span>
              </template>
              <span v-else class="muted">{{ textTemplates.length ? '提取不到关键词（需口播文案含价格/数字/关键词）' : '文字模板库为空，请先在服务端上传文字模板' }}</span>
            </div>
          </div>
        </div>

        <!-- 1. BGM input -->
        <div class="row">
          <label class="label"> 背景音乐 (BGM):</label>
          <input :value="bgmPath" placeholder="选择混剪背景音乐 (mp3/wav)，选空则无BGM..." readonly class="input grow" @click="pickBgm" />
          <!-- 2026-09-09 用户裁决：选择背景音乐前加「选择BGM」按钮，弹音频库选择框 -->
          <TButton label="选择BGM" size="small" variant="secondary" @click="openBgmPickDlg" />
          <TButton label="选择背景音乐" size="small" variant="secondary" @click="pickBgm" />
          <!-- 本端保留功能：AI 生成 BGM（生成后自动归档本地，走同一本地混音链路） -->
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
            <TButton label="播放生成的 BGM" variant="ghost" size="small" :disabled="!bgmUrl" @click="playAgBgm" />
            <TButton label="保存到 BGM 库" variant="secondary" size="small" :loading="bgmSaving" :disabled="!bgmUrl || bgmSaving" @click="saveBgmToLib" />
            <TButton label="打开位置" variant="secondary" size="small" :disabled="!bgmLocal" title="在资源管理器中打开生成的 BGM 本地文件（outputs/ai_audio）" @click="openBgmLocation" />
            <audio v-if="bgmUrl" ref="agBgmAudioEl" controls class="grow" />
          </div>
        </div>

        <!-- BGM 增益（0-200%，100%=原音量；拖动实时改变试听音量） -->
        <div class="row">
          <label class="label"> BGM 增益 (0-200%, 100%=原音量):</label>
          <input v-model.number="bgmVolume" type="range" min="0" max="200" step="1" class="vd4-gain" @input="onBgmVolumeInput" />
          <span class="vd4-gain-label">{{ bgmVolume }} %</span>
        </div>

        <!-- BGM 试听播放器：播放/暂停 ⏹ + 进度条 + 时间标签 -->
        <div class="row vd4-player">
          <button class="icon-btn vd4-pbtn" :title="bgmPlaying ? '暂停' : '播放/暂停'" @click="toggleBgmPlay">{{ bgmPlaying ? '⏸' : '▶' }}</button>
          <button class="icon-btn vd4-pbtn" title="停止播放" :disabled="!bgmPlaying" @click="stopBgmPlay">⏹</button>
          <input class="vd4-seek grow" type="range" min="0" :max="bgmDurMs" step="1" :value="bgmPosMs" @input="seekBgm" />
          <span class="vd4-time">{{ fmtBgmTime(bgmPosMs) }} / {{ fmtBgmTime(bgmDurMs) }}</span>
        </div>

        <!-- 开始混音合成（action_button 高 40 全宽） -->
        <TButton label="开始混音合成" class="vd4-run" :loading="finalBusy" @click="startFinalMix" />
        <div v-if="finalBusy" class="pbar"><div class="pbar-inner" :style="{ width: finalProgress + '%' }"></div></div>

        <!-- 结果区：左 成片列表 + 三按钮；右 视频预览 -->
        <div class="vd4-result">
          <div class="vd4-left">
            <div class="vd4-left-title">最终合成生成的视频文件:</div>
            <ul class="file-list vd4-list">
              <li
                v-for="(it, i) in finalVideoList" :key="i"
                :class="{ picked: finalSelIdx === i }"
                @click="finalSelIdx = i"
                @dblclick="previewFinalVideo(i)"
              >{{ it.name }}</li>
              <li v-if="!finalVideoList.length" class="muted">暂无成片，点击「开始混音合成」后此处展示结果</li>
            </ul>
            <div class="vd4-btns">
              <TButton label="打开视频输出目录" variant="secondary" :disabled="!finalDone" class="grow" @click="openFinalDir" />
              <TButton label="一键导出到剪映草稿" variant="primary" :disabled="!finalDone" class="grow" @click="exportJianyingDraft" />
              <TButton label="导出全部到时间轴(带转场)" variant="secondary" :disabled="!finalDone" class="grow"
                title="将合成列表中的所有视频按顺序导出为一条剪映时间轴，片段之间自动添加所选转场，每个片段携带各自字幕"
                @click="exportAllToJianyingDraft" />
            </div>
          </div>
          <div class="vd4-right">
            <div class="vd4-preview-title">{{ finalPreviewTitle }}</div>
            <VideoPlayer v-if="finalPreviewUrl" :src="finalPreviewUrl" autoplay class="vd4-video" />
            <div v-else class="vd4-video vd4-video-empty"></div>
          </div>
        </div>
      </section>

      <!-- 导航行（原版 Step4 仅「上一步：口播配音」，文案逐字 L190） -->
      <div class="row left">
        <TButton label="上一步：口播配音" plain @click="go(2)" />
      </div>
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
      WbPickProductPanel（占弹窗一半宽），选中自动回填右侧表单，仍可手改；
      填写区高度加高） -->
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
          <span class="hint">配音文案编辑:</span>
          <div v-if="editDlg.original" class="edit-orig">
            <span class="vd-tag muted-tag">原文:</span>
            <span class="vd-orig">{{ editDlg.original }}</span>
          </div>
          <textarea v-model="editDlg.content" class="modal-textarea modal-copy"></textarea>
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
.step-bar { display: flex; align-items: center; gap: var(--space-2); padding: 6px 12px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-lg); }
.step-pill { flex: 1; padding: 4px 0; border-radius: var(--radius-sm); font-size: 13px; color: var(--muted-foreground); cursor: pointer; text-align: center; transition: background var(--duration-fast), color var(--duration-fast); }
.step-pill.disabled { cursor: not-allowed; opacity: .5; }
.step-pill.active { background: rgba(96, 165, 250, 0.12); color: var(--info, #60a5fa); font-weight: 700; padding: 4px 8px; }
.step-pill.done { background: rgba(52, 211, 153, 0.1); color: var(--success); padding: 4px 8px; }
.step-dot { margin-right: 4px; font-weight: 700; }
.step-arrow { color: rgba(255, 255, 255, 0.2); font-weight: bold; }

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
.w60 { width: 60px; } .w90 { width: 90px; } .w120 { width: 120px; } .w180 { width: 180px; }
.clip-count { font-weight: 700; font-size: 14px; color: var(--warning); }
.result-box {
  display: flex; flex-direction: column; gap: 10px; padding: 10px;
  background: var(--surface-container); border: 1px dashed var(--border); border-radius: var(--radius-md);
}
/* 预合成列表（2026-09-09 用户裁决改表格）：固定 10 行高度，不足占位，多余滚动 */
.plan-tbl {
  height: 290px; /* 10 行 × 29px，同原 .plan-list 口径 */
  border: 1px solid var(--border); border-radius: var(--radius-md);
}
.plan-tbl tr { cursor: pointer; }
.plan-tbl tbody tr:hover { background: color-mix(in srgb, var(--primary) 6%, transparent); }
.plan-tbl tr.picked { background: color-mix(in srgb, var(--primary) 12%, transparent); }
.plan-tbl tr.plan-placeholder { visibility: hidden; pointer-events: none; }
.plan-tbl tr.plan-placeholder td { border-bottom: 1px solid var(--border); height: 29px; }
.plan-file { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 260px; }
.plan-copy { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted-foreground); }
.plan-empty { padding: 8px 10px; }
.w48 { width: 48px; white-space: nowrap; }
.w64 { width: 64px; white-space: nowrap; }
/* 下半区：左=分割镜头详情表（10行高度），右=视频预览（等高） */
.result-bottom { display: flex; gap: 15px; align-items: flex-start; }
.detail-col { flex: 3; min-width: 0; display: flex; flex-direction: column; gap: 6px; }
/* 详情表滚动容器：固定 10 行高度（表头 ~30px + 10 行 × 30px + 2px 边框补偿） */
.detail-scroll-wrap {
  max-height: 332px; overflow-y: auto; border: 1px solid var(--border); border-radius: var(--radius-sm);
}
.detail-scroll-wrap .tbl { border-radius: 0; }
.detail-placeholder-row td { height: 30px; border-bottom: 1px solid var(--border); }
/* 右侧播放器（高度匹配左侧详情表 10 行） */
.player-col { flex: 2; min-width: 220px; display: flex; flex-direction: column; gap: 6px; }
.player-wrap {
  height: 332px; background: #000; border: 1px solid var(--border); border-radius: var(--radius-md);
  display: flex; align-items: center; justify-content: center; overflow: hidden;
}
.player-video { width: 100%; height: 100%; object-fit: contain; }
/* 预览区 contain 约束（视频播放器尺寸规范）：Plyr wrapper 默认按视频比例撑高，
   竖屏/大分辨率镜头会被 overflow:hidden 裁到只剩一角且超出预览区；
   覆写为 wrapper 填满预览框 + 视频 object-fit: contain，完整帧恒可见且不越界 */
.player-wrap :deep(.plyr),
.player-wrap :deep(.plyr__video-wrapper) {
  height: 100%;
}
.player-wrap :deep(.plyr__video-wrapper) {
  aspect-ratio: auto !important;
}
.player-wrap :deep(video) {
  width: 100%;
  height: 100%;
  object-fit: contain;
}
.player-empty { color: var(--muted-foreground); font-size: 12px; }
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
/* 口播弹窗两栏：左=内嵌产品选择区（宽度≈原独立选择弹窗的一半），右=填写表单 */
.modal-pick { width: 80vw; max-width: 90vw; height: 80vh; }
.pick-layout { flex: 1 1 auto; min-height: 0; display: flex; gap: var(--space-4); }
.pick-left { flex: 1 1 50%; min-width: 0; min-height: 0; }
.pick-right { flex: 1 1 50%; min-width: 0; display: flex; flex-direction: column; gap: 12px; overflow-y: auto; padding-right: 2px; }
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
/* Step3 参考声音播放条（2026-09-09 用户裁决：与样本下拉同行、位于其后） */
.ref-audio { height: 32px; width: 320px; flex: 0 1 auto; }
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

.voice-table { margin-top: var(--space-3); }
.voice-table .w-idx { width: 48px; }
.vd-detail { display: flex; flex-direction: column; gap: 6px; }
.vd-top { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
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
.vd-progress { width: 100%; height: 6px; appearance: none; border-radius: 3px; overflow: hidden; }
.vd-progress::-webkit-progress-bar { background: var(--surface-container); }
.vd-progress::-webkit-progress-value { background: var(--primary); transition: width 0.3s; }
/* 2026-09-09 用户裁决：克隆按钮独立外框 + 配音设置分组（字幕/花字/配音按钮） */
.action-box {
  padding: var(--space-4); background: var(--surface-container);
  border: 1px solid var(--border); border-radius: var(--radius-md);
}
.voice-clone-box .clone-btn { width: 100%; }
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

/* 配音文案编辑弹窗原文对照 */
.edit-orig { display: flex; align-items: flex-start; gap: 6px; }
.edit-orig .vd-orig { white-space: pre-wrap; max-height: 72px; overflow-y: auto; }

/* Step4 AI 生成 BGM 面板 */
.ai-bgm-panel {
  display: flex; flex-direction: column; gap: var(--space-3);
  padding: var(--space-4); background: var(--surface-container);
  border: 1px solid var(--border); border-radius: var(--radius-md);
}
.ai-bgm-panel audio { flex: 1; min-width: 200px; height: 36px; }

/* Step4 特效包装分组（2026-09-09 裁决：字幕/花字/文字模板自 Step3 迿入） */
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
.textfx-word-tpl { font-size: 10px; font-weight: 400; color: #9aa; max-width: 120px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* 文字模板样式预览：按模板 variables 默认色本地渲染示例（服务端无预览接口，2026-09-10） */
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
@keyframes textfx-slide-in {
  0%   { opacity: 0; transform: translateX(-22px); }
  18%  { opacity: 1; transform: translateX(0); }
  82%  { opacity: 1; transform: translateX(0); }
  100% { opacity: 0; transform: translateX(-22px); }
}
@keyframes textfx-shine-sweep {
  0%   { background-position: 100% 0; }
  60%  { background-position: 0% 0; }
  100% { background-position: 0% 0; }
}
@keyframes textfx-bounce-in {
  0%   { opacity: 0; transform: scale(0.3); }
  25%  { opacity: 1; transform: scale(1.15); text-shadow: 0 0 10px var(--fx-color); }
  38%  { transform: scale(0.92); }
  50%  { transform: scale(1.05); text-shadow: 0 0 10px var(--fx-color); }
  62%  { transform: scale(1); }
  85%  { opacity: 1; transform: scale(1); }
  100% { opacity: 0; transform: scale(0.3); }
}
@keyframes textfx-flip-in {
  0%   { opacity: 0; transform: perspective(300px) rotateY(-90deg); }
  35%  { opacity: 1; transform: perspective(300px) rotateY(0deg); text-shadow: 0 0 10px var(--fx-color); }
  80%  { opacity: 1; transform: perspective(300px) rotateY(0deg); text-shadow: 0 0 10px var(--fx-color); }
  100% { opacity: 0; transform: perspective(300px) rotateY(-90deg); }
}
@keyframes textfx-pulse-soft {
  0%, 100% { transform: scale(1); text-shadow: 0 0 2px transparent; }
  50%      { transform: scale(1.12); text-shadow: 0 0 12px var(--fx-color); }
}
@keyframes textfx-fade-io {
  0%   { opacity: 0; }
  25%  { opacity: 1; }
  80%  { opacity: 1; }
  100% { opacity: 0; }
}
@keyframes textfx-flow {
  0%   { background-position: 0% 50%; }
  100% { background-position: 200% 50%; }
}
@keyframes textfx-neon {
  0%, 100% { text-shadow: 0 0 3px var(--fx-color); }
  50%      { text-shadow: 0 0 14px var(--fx-color), 0 0 26px var(--fx-color); }
}
@keyframes textfx-type {
  0%   { clip-path: inset(0 100% 0 0); }
  60%  { clip-path: inset(0 0 0 0); }
  100% { clip-path: inset(0 0 0 0); }
}
@keyframes textfx-caret {
  0%, 49%  { opacity: 1; }
  50%, 100% { opacity: 0; }
}
.textfx-anim-slide  { animation: textfx-slide-in 2.4s ease infinite; }
.textfx-anim-shine  { animation: textfx-shine-sweep 2.2s linear infinite; }
.textfx-anim-bounce { animation: textfx-bounce-in 2.6s ease infinite; }
.textfx-anim-flip   { animation: textfx-flip-in 2.8s ease infinite; }
.textfx-anim-pulse  { animation: textfx-pulse-soft 1.8s ease-in-out infinite; }
.textfx-anim-fade   { animation: textfx-fade-io 2.4s ease infinite; }
.textfx-anim-flow   { animation: textfx-flow 3s linear infinite; }
.textfx-anim-neon   { animation: textfx-neon 1.6s ease-in-out infinite; }
/* 打字机：逐字裁切显现 + 光标色竖线闪烁（cursorColor → --fx-color） */
.textfx-anim-type   { animation: textfx-type 2.6s steps(10, end) infinite; }
.textfx-anim-type::after {
  content: ''; display: inline-block; width: 2px; height: 1em;
  margin-left: 2px; vertical-align: -0.12em;
  background: var(--fx-color); animation: textfx-caret 1s steps(1) infinite;
}
.w80 { width: 80px; flex: none; }

/* Step4 特效包装（对照 step4_final_view.py L80-196 同布局；颜色走 V3 design tokens） */
.vd4-gain { width: 200px; flex: none; accent-color: var(--primary); }
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
/* 结果区（原版 result_box：rgba(255,255,255,0.03) + border rgba(255,255,255,0.1)，L116 → token 化） */
.vd4-result {
  display: flex; gap: 15px; padding: 10px; margin-top: var(--space-2);
  background: var(--surface-container); border: 1px solid var(--border); border-radius: 4px;
}
.vd4-left { flex: 3; min-width: 0; display: flex; flex-direction: column; gap: 8px; }
.vd4-left-title { font-size: 13px; font-weight: 600; color: var(--foreground); }
.vd4-list { max-height: 150px; overflow-y: auto; }
.vd4-btns { display: flex; gap: 8px; }
.vd4-btns > .t-button { flex: 1; padding: 0 6px; }
/* 右预览（原版 #000000 + border #27272a，L161-167 → token 化） */
.vd4-right {
  flex: 2; min-width: 220px; display: flex; flex-direction: column; gap: 6px;
  background: #000; border: 1px solid var(--border); border-radius: var(--radius-md); padding: 6px;
}
.vd4-preview-title { font-size: 11px; font-weight: bold; color: var(--muted-foreground); }
.vd4-video {
  width: 100%; min-height: 150px; flex: 1; object-fit: contain;
  border-radius: var(--radius-sm); background: #000;
}
.vd4-video-empty { min-height: 150px; }

/* 状态标签样式 */
.st-pending { color: var(--muted-foreground); font-size: 12px; }
.st-running { color: var(--primary); font-size: 12px; font-weight: 600; }
.st-done { color: var(--success); font-size: 12px; font-weight: 600; }
.st-failed { color: var(--danger, #e74c3c); font-size: 12px; font-weight: 600; }
</style>
