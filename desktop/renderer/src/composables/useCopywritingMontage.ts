// ═══════════════════════════════════════════════════════════════
// useCopywritingMontage — 智能混剪·服务端四步链路编排（M8 条目⑥ runner 层）
// 四步（对照原客户端 gui/video_montage_page.py steps_text L257，严格一致）：
//   1. 素材解析   POST /montage/split（同步返回 shots[]，ServerSplitWorker L121-171）
//   2. AI 编排    POST /montage/concat → 任务 → 轮询 GET /scheduled/tasks/{id} →
//        GET /montage/concat/result/{id}（montage_concat_server_worker L57-165：
//        stc.get_task 轮询 / status completed → result.video_url|url|output_url →
//        download_result 落盘；status failed/error → error_msg 透出）
//   3. 口播配音   TTS（voxcpm）逐条生成 + 视频合成（voice_clone_page.py VoiceCloneWorker）
//   4. 合成       POST /montage/bgm（同步返回 {ok, path, video_url}，特效包装/混音）
// 注：原客户端「卡点成片」属独立「一键成片」页（compile_video_page.py tab3，
//     BeatMontageController），不在智能混剪向导内，本端亦不纳入。
// 闭环口径：提交 → 轮询 → 结果下载/打开目录 → 失败重试（复用 useVideoRepair 模式）。
// 纯函数在 copywritingMontageLogic.ts（parser/builder 层），本文件仅编排（IRON-06/07）。
// ═══════════════════════════════════════════════════════════════

import { ref, computed, watch, onUnmounted } from 'vue'
import { clientError } from '../utils/clientLog'
import {
  // Step3 字幕样式（2026-09-17 用户裁决：字幕样式统一来自服务端 /subtitle_styles）
  serverStylesToPresets,
  SUBTITLE_STYLE_PRESETS_FALLBACK,
  subtitlePresetTileStyle,
  type SubtitleStylePreset,
  // 文字模板（2026-09-09 裁决：服务端 textfx 体系，与花字独立）
  TEXT_RANDOM_COUNT_OPTIONS,
  TEXT_KEYWORD_DENSITY_OPTIONS,
  TEXT_KEYWORD_DENSITY_MAX,
  pickRandomItems,
  extractFancyWordsFromText,
  buildSubtitleRows,
  buildTextFxTracks,
  textFxStyleOf,
  type TextFxTrack,
  // Step4 特效包装（对照 step4_final_view.py / FinalMixWorker / JianyingExporter）
  buildBgmGenPayload,
  parseBgmGenResponse,
  BGM_STYLE_OPTIONS,
  type BgmGenPayload,
  resolveOutFinalDir,
  collectMixCandidates,
  buildFinalTasks,
  fmtBgmTime,
  srcDirName,
  SHOT_TYPE_LABELS,
  SHOT_TYPE_COLORS,
  type SplitSceneRow,
  // Step3 口播配音（对照 step3_voice_view.py / VoiceCloneWorker api / VideoDubbingWorker）
  type VoiceRow,
  FANCY_STYLE_OPTIONS,
  AI_REWRITE_DESC,
  rewriteTemperature,
  buildRewriteSystemPrompt,
  cleanRewriteContent,
  FANCY_POSITION_OPTIONS,
  SUBTITLE_BG_OPTIONS,
  resolveOutMontageDir,
  FPS_OPTIONS,
  voiceStatusText,
  voiceStatusClass,
  fmtDur,
  pathBasename,
  inputNameFromFinalPath,
  // 字幕重切段后处理（2026-09-18 用户裁决：声音克隆完成后即处理）
} from './copywritingMontageLogic'
// 原客户端 SentenceSplitterLLMWorker 机器（LLM 拆句 + 漏字校验回退本地）
import {
  SENTENCE_SPLIT_SYSTEM_PROMPT,
  extractLlmLines,
  extractLlmContent,
} from './voiceCloneLogic'
import { readCacheDir } from './useSettingsConfig'
import { joinDefaultPath } from './settingsIntegrationLogic'
// 模块级工具/轮询常量与 Step1/Step2 编排已迁 montage/（铁律 10 拆分，纯搬迁，
// 蓝图见 docs/智能混剪拆分迁移映射_2026-09-18.md）
import { notify, errText, createMontageSharedRuntime } from './copywritingMontage/context'
import {
  SCRIPT_SYSTEM_PROMPT_DEFAULT,
  SCRIPT_SYSTEM_PROMPT_LEGACY_DEFAULT,
  SCRIPT_SCENE_OPTIONS,
  buildScriptSystemPrompt,
  buildScriptUserPrompt,
} from './copywritingMontageStep2ConcatLogic'
// 文案编写页选择产品（公共弹窗 WbPickProductDialog）：PickerItem → sharedProductInfo 同
// 镜头重组页弹窗 onPickProduct 口径（stripProductCodeFromModel 型号剥编码 / 关联关键词带回）
import type { PickerItem } from './useWorkbenchPickers'
import { markdownListLines, stripProductCodeFromModel, parseProductKeywords } from './opsProductLibraryLogic'
import { useCopywritingMontageStep1Split } from './copywritingMontage/useCopywritingMontageStep1Split'
import { useCopywritingMontageStep2Concat } from './copywritingMontage/useCopywritingMontageStep2Concat'
import { useCopywritingMontageStep3Voice } from './copywritingMontage/useCopywritingMontageStep3Voice'
import { useCopywritingMontageStep4Final } from './copywritingMontage/useCopywritingMontageStep4Final'

export function useCopywritingMontage() {
  // 2026-09-23 模块代码前缀两连改（产品名仍为文案混剪）：copy-montage → plan-montage → copywriting-montage。
  // localStorage 历史键一次性迁移（copy-montage.* 与 plan-montage.* 两个来源均收）——
  // 新键不存在时整串复制（旧键保留作回滚保险）。必须先于各 step 组合函数的 revive 恢复执行，故置于本函数首行。
  try {
    const legacyPrefixes = ['copy-montage.', 'plan-montage.']
    const staleKeys: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k && legacyPrefixes.some((p) => k.startsWith(p))) staleKeys.push(k)
    }
    for (const k of staleKeys) {
      const nk = 'copywriting-montage.' + k.slice(legacyPrefixes.find((p) => k.startsWith(p))!.length)
      if (localStorage.getItem(nk) === null) localStorage.setItem(nk, localStorage.getItem(k) as string)
    }
  } catch (_) { /* 存储不可写静默 */ }
  // ── 共享运行时（已迁 montage/context.ts，铁律 10 纯搬迁；
  //    clearBusy 槽经 setClearBusy 存取，槽语义不变）──
  const {
    serverUrl, ensureServerUrl, toAbsolute,
    polling, activeTaskId, statusText,
    stopPolling, cancelPolling, abortPolling, startPolling, setClearBusy,
  } = createMontageSharedRuntime()

  // ── 跨步共享 ref（铁律 10 拆分上提：Step3 textfx 与 Step4 混音/合成双向消费，
  //    上提至主文件使两侧函数体零改动；见映射文档 §四）──
  const finalBusy = ref(false)
  const finalDone = ref(false)     // 三按钮启用开关（原版 btn_open_final_dir 等初始 disabled）
  const finalVideoList = ref<Array<{ name: string; path: string }>>([])
  const finalVideoPath = ref('')   // 首个成片（final_video_path 口径）
  /** Step4 合成候选路径（界面统一联动预览 2026-09-10：右栏预览块数据源；
   *  与 textFxPreviewTracks 同批刷新，另在 enterStep4 主动刷一次不依赖 textFx 开关） */
  const step4Candidates = ref<string[]>([])
  // finalProgress 同属跨步共享：nextVoiceChannel（Step3）写、Step4 混音读写
  const finalProgress = ref(-1)    // 混音进度 0-100（-1=隐藏；原版共享 progress_bar 口径）

  // ══ Step1 素材解析（已迁 montage/useCopywritingMontageStep1Split.ts，铁律 10 纯搬迁；
  //    解构回原名 → 下文与 return 键集合零改动）═════════════════
  const step1 = useCopywritingMontageStep1Split({ statusText, ensureServerUrl, toAbsolute })
  const {
    srcVideos, srcDurations, threshold, minSceneLen, imageDuration,
    scenes, scoreFilter, filteredScenes,
    splitBusy, splitError, splitMsg, splitProgress, splitResolution, splitFps,
    splitsJobId, splitsDownloading,
    previewUrl, previewTranscoding,
    addVideos, selectFolder, onDrop, removeVideo, runSplit, requestStopSplit, splitStatusOf,
    updateSceneDesc, previewSourceVideo, previewScene, closePreview,
    clearSplitCache, openSplitsDir,
  } = step1

  // ── 出入场超长片段自动裁剪（已迁 useCopywritingMontageStep1Split.ts，铁律 10 纯搬迁）──

  /** 取消/复位统一清 busy（方案生成 / 确认合成 / 口播文案 / 混音四个异步步） */
  function clearAllBusy(): void {
    concatBusy.value = false
    confirmBusy.value = false
    copyBusy.value = false
    finalBusy.value = false
  }

  // ══ Step2 镜头重组（已迁 montage/useCopywritingMontageStep2Concat.ts，铁律 10 纯搬迁；
  //    clearBusy 槽赋值改走 setClearBusy，语义不变；解构回原名→ return 键零改动）══
  const step2 = useCopywritingMontageStep2Concat({
    statusText, ensureServerUrl, toAbsolute, startPolling, setClearBusy,
    clearAllBusy, scenes, splitFps, splitResolution, srcVideos, splitsJobId,
  })
  const {
    assembleLogic, concatLayout, concatFps, durationLimit, DURATION_LIMITS,
    batchCount, recBatchCount, randomness,
    concatTransition, concatBusy, confirmBusy, copyBusy, concatError, concatProgress,
    edgeSpeedup, EDGE_SPEEDUP_OPTIONS, TRANSITIONS,
    checkedCount, assemblePlans, currentPlanIdx, currentPlan, hasUnconfirmed,
    confirmedPaths, concatResults, seqClips, seqIdx, seqSrc, detailDragFrom,
    planConfirmQueue, sharedProductInfo,
    planDurText, runConcat, runConcatFromAllStoryboards, planRowText, selectPlan, startSeqPreview, onSeqEnded,
    submitConcatTask, confirmAllPrecompose, confirmPlanSingle,
    openProductDlg, productDlg, closeProductDlg, productDlgGenerate,
    copyViewDlg, viewPlanCopy, closeCopyView,
    planMenu, openPlanMenu, closePlanMenu,
    onDetailDragStart, onDetailDragEnd, onDetailDrop, toggleClipDeleted,
  } = step2

  // ══ 文案编写页（2026-09-21 用户裁决：按参考界面重排——高级脚本设置（生成方式/段落数量/
  //    自定义要求/系统提示）+ AI 生成视频文案与关键词；素材选择与镜头分割自本页删除，
  //    分割编排原样保留供「镜头重组」页。生成走 llm:chat（区别于产品弹窗的
  //    /copywriting/voiceover）：系统提示=页面可编辑系统提示（默认 Constraints 七条），
  //    模型随「文案生成方式」（空=当前大模型 Provider，即服务端默认）。
  //    文案/关键词仍为页面级草稿（localStorage copywriting-montage.script.* 持久化；2026-09-23 自 copy-montage.* 迁移），
  //    不回写预合成方案旁车 .txt——接管关系待裁决）══
  const scriptLsKey = (k: string): string => `copywriting-montage.script.${k}`
  const scriptProvider = ref('')        // ''=当前大模型 Provider（服务端默认模型）
  const scriptModelOptions = ref<Array<{ label: string; value: string }>>([])
  const paragraphCount = ref(3)
  const customRequirement = ref('')
  const scriptScene = ref('general')    // 场景（通用/口播带货/产品讲解/种草推荐）
  const suggestDuration = ref(30)       // 建议时长（秒）：随场景取默认，可手动调整
  const systemPrompt = ref(SCRIPT_SYSTEM_PROMPT_DEFAULT)
  const manualCopy = ref('')            // 视频文案（可选，可编辑）
  const manualCopyBusy = ref(false)     // 「生成文案和关键词」进行中（关键词为其串行第二步）
  // localStorage 恢复：显式判 null 为未设置才回退默认（Number(null)=0 的坑见 679133e）；
  // 段落数量另做整数域校验
  const lsGet = (k: string): string | null => {
    try { return localStorage.getItem(scriptLsKey(k)) } catch { return null }
  }
  const savedParas = lsGet('paragraphs')
  if (savedParas !== null && savedParas !== '' && Number.isFinite(Number(savedParas)) && Number(savedParas) >= 1) {
    paragraphCount.value = Math.floor(Number(savedParas))
  }
  const savedReq = lsGet('requirement')
  if (savedReq !== null) customRequirement.value = savedReq
  const savedSys = lsGet('systemPrompt')
  if (savedSys !== null && savedSys.trim()) {
    // 一次性迁移：存量值恰为旧版默认 → 升级新默认（用户自定义过的不动）
    systemPrompt.value = savedSys === SCRIPT_SYSTEM_PROMPT_LEGACY_DEFAULT
      ? SCRIPT_SYSTEM_PROMPT_DEFAULT
      : savedSys
  }
  const savedProv = lsGet('provider')
  if (savedProv !== null) scriptProvider.value = savedProv
  const savedScene = lsGet('scene')
  if (savedScene !== null && SCRIPT_SCENE_OPTIONS.some((o) => o.value === savedScene)) {
    scriptScene.value = savedScene
  }
  const savedDur = lsGet('duration')
  if (savedDur !== null && Number.isFinite(Number(savedDur)) && Number(savedDur) >= 5) {
    suggestDuration.value = Math.round(Number(savedDur))
  }
  const savedCopy = lsGet('copy')
  if (savedCopy !== null) manualCopy.value = savedCopy
  function persistScript(): void {
    try {
      localStorage.setItem(scriptLsKey('provider'), scriptProvider.value)
      localStorage.setItem(scriptLsKey('paragraphs'), String(paragraphCount.value))
      localStorage.setItem(scriptLsKey('requirement'), customRequirement.value)
      localStorage.setItem(scriptLsKey('scene'), scriptScene.value)
      localStorage.setItem(scriptLsKey('duration'), String(suggestDuration.value))
      localStorage.setItem(scriptLsKey('systemPrompt'), systemPrompt.value)
      localStorage.setItem(scriptLsKey('copy'), manualCopy.value)
    } catch { /* 隐私模式等写入失败静默 */ }
  }
  watch([scriptProvider, paragraphCount, customRequirement, scriptScene, suggestDuration, systemPrompt, manualCopy], persistScript)
  // 场景切换 → 建议时长取该场景默认值（用户随后可手动调整）
  watch(scriptScene, (v) => {
    const def = SCRIPT_SCENE_OPTIONS.find((o) => o.value === v)?.defaultSec
    if (def) suggestDuration.value = def
  })

  /** 「文案生成方式」下拉：默认项=当前大模型 Provider（''），其后为 GET /llm/models 模型清单 */
  const scriptProviderOptions = computed(() => [
    { label: '当前大模型 Provider', value: '' },
    ...scriptModelOptions.value,
  ])
  /** 面板挂载时拉模型清单（离线/失败静默保留默认项） */
  async function loadScriptProviders(): Promise<void> {
    if (scriptModelOptions.value.length) return
    try {
      const res = await window.tintin.server.llmModels()
      if (!res || (typeof res === 'object' && 'error' in res)) return
      const models = Array.isArray(res.models) ? res.models : []
      scriptModelOptions.value = models
        .map((m) => String(m?.id || '')).filter(Boolean)
        .map((id) => ({ label: id, value: id }))
    } catch { /* 离线 */ }
  }

  /** llm:chat 单轮文本：{error} 抛错、空内容报错，正常返回 choices[0].message.content */
  async function llmChatText(system: string, user: string, model: string): Promise<string> {
    const res = await window.tintin.server.llmChat({
      model: model || '',
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    })
    if (res && 'error' in res) throw new Error(String(res.error) || '服务端返回空错误')
    const text = String(res?.choices?.[0]?.message?.content ?? '').trim()
    if (!text) throw new Error('模型未返回内容')
    return text
  }

  /** 文案编写页「选择产品」（公共弹窗 WbPickProductDialog）：PickerItem → sharedProductInfo
   *  （与镜头重组页弹窗 onPickProduct 同口径：型号剥商品编码、关联关键词随选带回、
   *  核心卖点逐条拼入）。产品信息单一来源 → 本页生成提示词与后续命中管线共用，
   *  镜头重组页弹窗打开时即预填本产品 */
  function applyScriptProduct(it: PickerItem): void {
    sharedProductInfo.value = {
      brand: String(it.brand || ''),
      product: String(it.category || ''),
      model: stripProductCodeFromModel(it.model),
      keywords: parseProductKeywords(it),
      extra: markdownListLines(it.selling_points).join('\n'),
    }
  }

  /** 清除已选产品（恢复空产品信息） */
  function clearScriptProduct(): void {
    sharedProductInfo.value = { brand: '', product: '', model: '', extra: '', keywords: [] }
  }

  /** 最终 system 提示词：页面可编辑系统提示为基底 + 场景指令 + 产品信息 + 自定义要求
   *  （产品信息取 sharedProductInfo——本页「选择产品」与镜头重组页弹窗的单一来源） */
  function scriptSystemPrompt(): string {
    const info = sharedProductInfo.value || { brand: '', product: '', model: '', extra: '' }
    return buildScriptSystemPrompt(systemPrompt.value, {
      scene: scriptScene.value,
      suggestSec: suggestDuration.value,
      brand: info.brand, product: info.product, modelName: info.model, extra: info.extra,
      customRequirement: customRequirement.value,
    })
  }

  /** user 消息：脚本长度 + 产出指令（场景/产品/要求均已并入 system） */
  function scriptUserPrompt(): string {
    return buildScriptUserPrompt({ paragraphCount: paragraphCount.value })
  }

  /** 预览最终提示词（只读弹窗展示合并后的 system + user 两条消息） */
  const promptPreviewDlg = ref({ show: false, system: '', user: '' })
  function openPromptPreview(): void {
    promptPreviewDlg.value = { show: true, system: scriptSystemPrompt(), user: scriptUserPrompt() }
  }
  function closePromptPreview(): void { promptPreviewDlg.value.show = false }

  /** 恢复默认系统提示 */
  function resetSystemPrompt(): void { systemPrompt.value = SCRIPT_SYSTEM_PROMPT_DEFAULT }

  /** ✨ 生成视频文案（2026-09-21 用户裁决：省掉关键词请求，只生成文案） */
  async function genScriptAndKeywords(): Promise<void> {
    if (manualCopyBusy.value) return
    const info = sharedProductInfo.value || { brand: '', product: '', model: '', extra: '' }
    if (!info.brand && !info.product && !info.model && !info.extra && !customRequirement.value.trim()) {
      notify('无法生成', '请先点击「选择产品」选择产品，或在「自定义文案要求」中描述要写的文案。')
      return
    }
    manualCopyBusy.value = true
    try {
      // 2026-09-21 用户裁决：省掉关键词请求——只生成文案；写入激活分镜旁白
      activeNarrative.value = await llmChatText(scriptSystemPrompt(), scriptUserPrompt(), scriptProvider.value)
      // 分镜以服务端脚本库为持久化层：每步完成后同步
      void syncStoryboardsToServer()
      statusText.value = '完成： 视频文案已生成，可在下方编辑'
      notify('生成完成', '视频文案已生成，可在下方编辑。')
    } catch (e) {
      clientError('copywriting-montage', '生成视频文案失败', errText(e))
      notify('生成失败', errText(e))
    } finally {
      manualCopyBusy.value = false
    }
  }



  // ══ Step3 口播配音（已迁 montage/useCopywritingMontageStep3Voice.ts，铁律 10 纯搬迁；
  //    S3↔S4 双向点经 ctx：collectCandidates/ensureProcessedSrt 惰性 lambda、
  //    finalBusy/step4Candidates 上提主文件，见映射文档 §四）══
  const step3 = useCopywritingMontageStep3Voice({
    statusText, serverUrl, ensureServerUrl, assemblePlans, previewUrl,
    finalBusy, finalProgress, finalDone, finalVideoList, finalVideoPath,
    step4Candidates, sharedProductInfo,
    // 2026-09-21 用户裁决：第一步文案带入口播配音页（扫描建行无 .txt 时回退）
    getScriptCopy: () => manualCopy.value,
    // 选择脚本应用时回填旁白（第一步文案 = 镜头旁白拼接，与分镜脚本页「继续创作」同口径）
    setScriptCopy: (text: string) => { manualCopy.value = text },
    collectCandidates: (useSource?: boolean) => step4.collectCandidates(useSource),
    ensureProcessedSrt: (text: string, wavPath: string, candidate: string) =>
      step4.ensureProcessedSrt(text, wavPath, candidate),
  })
  const {
    voiceDirInput, selectedVoiceFiles, voicesDir, voiceRows,
    refSamples, selectedRefSample, refAudioPath, refAudioLabel, refPreviewUrl, refText,
    ttsApiUrl, ttsSteps, ttsCfg, ttsSpeedMin, ttsSpeedMax,
    // Qwen3-TTS 专属（2026-09-20 用户裁决）
    qwen3Speaker, qwen3Instruct, qwen3Voices, qwen3VoicesLoading, loadQwen3Voices,
    addSubtitles, subtitleFont, fontOptions, fontsLoading,
    fancyEnabled, fancyStyle, subtitleStyleKey, subtitleStylePresets, subtitleAnimKey,
    subtitleFontSize, fancyPosition, subtitleBgOpacity, fancyTemplateId, fancyTemplates,
    fancyPreviews, fancyTemplatesLoading, textFxEnabled, lutRestore, lutId, lutList,
    lutListLoading, textTemplateId, textRandomCount, textKeywordDensity, textTemplates,
    textTemplatesLoading, activeTextPool, activeTextCount, textTemplateOptions,
    textFxPreviewTracks, textFxStyleSamples, srvBase, rewriteTemp, aiRewriteDlg,
    ttsEngine, ttsDurationFactor, ttsEmoText, ttsEmoAlpha, ttsPauseMs, cloneParamsDlg,
    editDlg, voiceBusy, rewriteBusy, voiceProgress,
    copyShots, copyShotsStale, shotClipGroup, bindShotMaterial, removeShotClipAt, unbindShotMaterial, genStoryboard, storyboardBusy, scriptSaving, saveStoryboard,
    storyboards, activeStoryboardId, activeStoryboard, setActiveStoryboard, renameStoryboardTab, removeStoryboardTab, activeNarrative, COPY_STORYBOARD_MAX,
    scriptPickDlg, openScriptPick, refreshScriptOptions, pickDetail, selectScriptOption, applySelectedScript, syncStoryboardsToServer,
    loadLuts, loadCatalogLanes, resolveKeywordHits,
    currentMatchTemplateIds, refreshTextFxTracks, loadTextTemplates, ensureTtsApiUrl,
    nextVoiceChannel, clearVoiceProgressListener, scanVoiceDir, enterStepVoice,
    loadRefSamples, selectRefAudio, pickNewSampleFile, transcribeNewSample,
    nsFilePath, nsName, nsText, nsError, nsSuccess, nsBusy, nsTranscribing,
    uploadNewSampleRef, batchAiRewrite, startSynthesizeVoice, runDubBatch, runCloneBatch,
    selectedFontFamily, ensureServerFontFace, fontOptionStyle, selectedSubtitlePreset,
    subtitlePreviewStyle, refreshFonts, refreshSubtitleStyles, loadFancyTemplates,
    selectedFancyTemplate, openEditDlg, saveEditDlg, exportVoice, playRowVideo,
    playDubbedVideo, toggleLengthMode, lengthModeTip, regenVoice,
    openRewriteSettings, closeRewriteSettings, saveRewriteSettings,
    openCloneParams, closeCloneParams, saveCloneParams,
  } = step3

  // ══ Step4 特效包装（已迁 montage/useCopywritingMontageStep4Final.ts，铁律 10 纯搬迁；
  //    ctx 消费 step2/step3 产物与上提 ref，见映射文档 §四）══
  const step4 = useCopywritingMontageStep4Final({
    statusText, ensureServerUrl, toAbsolute, assemblePlans, concatTransition,
    sharedProductInfo, splitResolution, voiceRows, voiceDirInput,
    // 2026-09-22 用户裁决：候选↔分镜按方案 tabId 精确解析（原 getTabVoiceWavs 过滤
    // 未生成 tab 与 getTabNarratives 不过滤口径不一致，候选按下标错位拿错声音/旁白）
    getTabById: (id: string) =>
      storyboards.value
        .filter((t) => t.id === id)
        .map((t) => ({ voiceWav: t.voiceWav, narrative: t.narrative, transition: t.transition, shots: t.shots.map((s) => ({ sfxWavLocal: s.sfxWavLocal, sfxDurSec: s.sfxDurSec })) }))[0] ?? null,
    runDubBatch, nextVoiceChannel, loadTextTemplates, refreshTextFxTracks,
    currentMatchTemplateIds, resolveKeywordHits,
    scanVoiceDir, activeTextPool,
    activeTextCount, selectedFancyTemplate, selectedSubtitlePreset, selectedFontFamily,
    addSubtitles, subtitleStyleKey, subtitleBgOpacity, subtitleAnimKey, fancyEnabled,
    fancyStyle, fancyPosition, textFxEnabled, lutRestore, lutId, textTemplateId,
    textKeywordDensity, subtitleFontSize, clearVoiceProgressListener,
    finalBusy, finalProgress, finalDone, finalVideoList, finalVideoPath, step4Candidates,
  })
  const {
    bgmPath, bgmName, bgmVolume, rowBgm, finalMode, exportBusy, exportProgress, exportStage,
    lastExportDraftPath, exportDoneMsg, finalSelIdx, finalPreviewUrl, finalPreviewTitle,
    bgmSource, bgmGenPrompt, bgmGenStyle, bgmGenDuration, bgmGenBusy, bgmGenError, bgmGenUrl,
    bgmGenMeta, bgmPreviewUrl, bgmPlaying, bgmPosMs, bgmDurMs, lastComposeTasks,
    generateBgm, downloadLibraryBgm, applyLibraryBgm, pickBgm, rowBgmName, setRowBgm,
    clearRowBgm, pickRowBgm, rowBgmForCandidate, collectCandidates, ensureProcessedSrt,
    enterStep4, startFinalMix, openFinalDir, openExportDraftDir, exportAllToJianyingDraft,
    previewFinalVideo, exportJianyingPackageDraft,
    toggleBgmPlay, stopBgmPlay, onBgmVolumeInput, seekBgm,
  } = step4

  onUnmounted(() => {
    abortPolling()
    clearVoiceProgressListener()
  })

  // ── 每脚本视频设置（2026-09-23 用户裁决：输出画幅/转场/帧率按 tab 绑定）──
  // 读写都落在激活 tab 上（切 tab 即切设置）；无 tab 回退全局 ref（legacy 口径）。
  // 时长限制=派生只读值：跟随本 tab 克隆声音时长，未生成回退全局（30 缺省）。
  const activeTabLayout = computed<string>({
    get: () => activeStoryboard.value?.layout ?? concatLayout.value,
    set: (v) => { const t = activeStoryboard.value; if (t) t.layout = v; else concatLayout.value = v },
  })
  const activeTabTransition = computed<string>({
    get: () => activeStoryboard.value?.transition ?? concatTransition.value,
    set: (v) => { const t = activeStoryboard.value; if (t) t.transition = v; else concatTransition.value = v },
  })
  const activeTabFps = computed<number | 'source'>({
    get: () => activeStoryboard.value?.fps ?? concatFps.value,
    set: (v) => { const t = activeStoryboard.value; if (t) t.fps = v; else concatFps.value = v },
  })
  const activeTabDurationLimit = computed(() => {
    const t = activeStoryboard.value
    return t && t.voiceDurSec > 0 ? Math.max(1, Math.round(t.voiceDurSec)) : Number(durationLimit.value)
  })

  return {
    // 共享
    serverUrl, polling, activeTaskId, statusText, cancelPolling, stopPolling,
    // Step1 素材解析
    srcVideos, srcDurations, threshold, minSceneLen, imageDuration,
    scenes, scoreFilter, filteredScenes, checkedCount,
    splitBusy, splitError, splitMsg, splitProgress, splitResolution, concatProgress,
    addVideos, selectFolder, onDrop, removeVideo, runSplit, requestStopSplit, splitStatusOf,
    // 文案编写（2026-09-21 用户裁决：高级脚本设置 + AI 生成视频文案与关键词）
    sharedProductInfo, applyScriptProduct, clearScriptProduct,
    manualCopy, manualCopyBusy, activeNarrative, suggestDuration, syncStoryboardsToServer,
    storyboards, activeStoryboardId, activeStoryboard, setActiveStoryboard, renameStoryboardTab, removeStoryboardTab, COPY_STORYBOARD_MAX,
    scriptProvider, scriptProviderOptions, paragraphCount, customRequirement, systemPrompt,
    scriptScene, SCRIPT_SCENE_OPTIONS,
    resetSystemPrompt, promptPreviewDlg, openPromptPreview, closePromptPreview,
    genScriptAndKeywords, loadScriptProviders,
    updateSceneDesc, previewSourceVideo, previewScene, closePreview, clearSplitCache,
    previewUrl, previewTranscoding, openSplitsDir, splitsDownloading,
    // Step2 镜头重组
    assembleLogic, concatLayout, durationLimit, DURATION_LIMITS, batchCount, recBatchCount,
    concatFps, FPS_OPTIONS, splitFps,
    concatTransition, edgeSpeedup, EDGE_SPEEDUP_OPTIONS, TRANSITIONS,
    // 每脚本视频设置（2026-09-23 用户裁决：按激活 tab 读写的绑定视图）
    activeTabLayout, activeTabTransition, activeTabFps, activeTabDurationLimit,
    concatBusy, confirmBusy, copyBusy, concatError,
    assemblePlans, currentPlanIdx, currentPlan, hasUnconfirmed, confirmedPaths,
    runConcat, planRowText, selectPlan, startSeqPreview,
    detailDragFrom, onDetailDragStart, onDetailDragEnd, onDetailDrop, toggleClipDeleted,
    submitConcatTask, confirmAllPrecompose, confirmPlanSingle,
    openProductDlg, productDlg, closeProductDlg, productDlgGenerate,
    copyViewDlg, viewPlanCopy, closeCopyView,
    planMenu, openPlanMenu, closePlanMenu,
    seqClips, seqIdx, seqSrc,
    onSeqEnded,
    concatResults, runConcatFromAllStoryboards,
    // Step3 口播配音（对照 step3_voice_view.py 逐控件）
    voiceDirInput, voicesDir, voiceRows,
    refSamples, selectedRefSample, refAudioPath, refText, selectRefAudio,
    ttsApiUrl, ttsSteps, ttsCfg, ttsSpeedMin, ttsSpeedMax,
    qwen3Speaker, qwen3Instruct, qwen3Voices, qwen3VoicesLoading, loadQwen3Voices,
    addSubtitles, subtitleFont, fontOptions, fontsLoading, refreshFonts,
    subtitleStyleKey, subtitleStylePresets, selectedSubtitlePreset, subtitlePreviewStyle,
    subtitleAnimKey,
    subtitleFontSize,
    fontOptionStyle,
    fancyEnabled, fancyStyle, fancyPosition, subtitleBgOpacity,
    fancyTemplateId, fancyTemplates, fancyPreviews,
    voiceProgress, fancyTemplatesLoading,
    selectedFancyTemplate, loadFancyTemplates,
    // 文字模板（textfx；与花字独立；随机样式默认 3 个）
    lutRestore, lutId, lutList, lutListLoading, loadLuts, textFxEnabled, textTemplateId, textTemplateOptions, textTemplates,
    textRandomCount, textKeywordDensity, TEXT_RANDOM_COUNT_OPTIONS, TEXT_KEYWORD_DENSITY_OPTIONS,
    textFxPreviewTracks, textFxStyleSamples, loadTextTemplates,
    FANCY_STYLE_OPTIONS, FANCY_POSITION_OPTIONS, SUBTITLE_BG_OPTIONS, AI_REWRITE_DESC,
    aiRewriteDlg, openRewriteSettings, closeRewriteSettings, saveRewriteSettings,
    ttsEngine, ttsDurationFactor, ttsEmoText, ttsEmoAlpha, ttsPauseMs,
    cloneParamsDlg, openCloneParams, closeCloneParams, saveCloneParams,
    editDlg, openEditDlg, saveEditDlg,
    rewriteTemp,
    voiceBusy, rewriteBusy,
    copyShots, copyShotsStale, shotClipGroup, bindShotMaterial, removeShotClipAt, unbindShotMaterial, genStoryboard, storyboardBusy, scriptSaving, saveStoryboard,
    scriptPickDlg, openScriptPick, refreshScriptOptions, pickDetail, selectScriptOption, applySelectedScript,
    scanVoiceDir, enterStepVoice, loadRefSamples, refPreviewUrl,
    nsFilePath, nsName, nsText, nsError, nsSuccess, nsBusy, nsTranscribing,
    pickNewSampleFile, transcribeNewSample, uploadNewSampleRef,
    batchAiRewrite, startSynthesizeVoice,
    regenVoice, exportVoice, playRowVideo, playDubbedVideo,
    toggleLengthMode, lengthModeTip,
    voiceStatusText, voiceStatusClass, fmtDur, pathBasename,
    planDurText,
    // Step4 特效包装
    bgmPath, bgmName, bgmVolume, finalBusy, finalMode, finalDone, finalProgress,
    exportBusy, exportProgress, exportStage, // 2026-09-16：导出剪映时间轴进度
    lastExportDraftPath, // 2026-09-16：导出成功后草稿目录路径（供「打开草稿目录」按钮）
    exportDoneMsg, // 2026-09-18：导出完成提示行（内嵌「打开草稿目录」按钮）
    exportJianyingPackageDraft, // 轨 2（2026-09-17）：导入服务端草稿包
    finalVideoList, finalVideoPath, finalSelIdx, finalPreviewUrl, finalPreviewTitle,
    bgmSource, bgmGenPrompt, bgmGenStyle, bgmGenDuration,
    bgmGenBusy, bgmGenError, bgmGenUrl, bgmGenMeta, bgmPreviewUrl,
    bgmPlaying, bgmPosMs, bgmDurMs,
    generateBgm,
    pickBgm, applyLibraryBgm, toggleBgmPlay, stopBgmPlay, onBgmVolumeInput, seekBgm,
    // 2026-09-18：逐视频 BGM 指派 + 弹窗下载助手（行目标不回填全局）
    rowBgm, rowBgmName, setRowBgm, clearRowBgm, pickRowBgm, downloadLibraryBgm, rowBgmForCandidate,
    enterStep4, startFinalMix, openFinalDir, openExportDraftDir,
    exportAllToJianyingDraft, previewFinalVideo, step4Candidates, toAbsolute,
    fmtBgmTime,
    // 景别分类（UI 展示用）
    SHOT_TYPE_LABELS, SHOT_TYPE_COLORS,
  }
}
