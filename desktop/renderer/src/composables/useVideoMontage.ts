// ═══════════════════════════════════════════════════════════════
// useVideoMontage — 智能混剪·服务端四步链路编排（M8 条目⑥ runner 层）
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
// 纯函数在 videoMontageLogic.ts（parser/builder 层），本文件仅编排（IRON-06/07）。
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
  planSubtitleLines,
  mapLinesToTiming,
  serializeSrtRows,
} from './videoMontageLogic'
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
import { notify, unwrapIpc, errText, joinPath, createMontageSharedRuntime } from './montage/context'
import { useMontageStep1Split } from './montage/useMontageStep1Split'
import { useMontageStep2Concat } from './montage/useMontageStep2Concat'

export function useVideoMontage() {
  // ── 共享运行时（已迁 montage/context.ts，铁律 10 纯搬迁；
  //    clearBusy 槽经 setClearBusy 存取，槽语义不变）──
  const {
    serverUrl, ensureServerUrl, toAbsolute,
    polling, activeTaskId, statusText,
    stopPolling, cancelPolling, abortPolling, startPolling, setClearBusy,
  } = createMontageSharedRuntime()

  // ══ Step1 素材解析（已迁 montage/useMontageStep1Split.ts，铁律 10 纯搬迁；
  //    解构回原名 → 下文与 return 键集合零改动）═════════════════
  const step1 = useMontageStep1Split({ statusText, ensureServerUrl, toAbsolute })
  const {
    srcVideos, srcDurations, threshold, minSceneLen, imageDuration,
    scenes, scoreFilter, filteredScenes,
    splitBusy, splitError, splitMsg, splitProgress, splitResolution, splitFps,
    splitsJobId, splitsDownloading,
    previewUrl, previewTranscoding,
    addVideos, selectFolder, onDrop, removeVideo, runSplit,
    updateSceneDesc, previewSourceVideo, previewScene, closePreview,
    clearSplitCache, openSplitsDir,
  } = step1

  // ── 出入场超长片段自动裁剪（已迁 useMontageStep1Split.ts，铁律 10 纯搬迁）──

  /** 取消/复位统一清 busy（方案生成 / 确认合成 / 口播文案 / 混音四个异步步） */
  function clearAllBusy(): void {
    concatBusy.value = false
    confirmBusy.value = false
    copyBusy.value = false
    finalBusy.value = false
  }

  // ══ Step2 镜头重组（已迁 montage/useMontageStep2Concat.ts，铁律 10 纯搬迁；
  //    clearBusy 槽赋值改走 setClearBusy，语义不变；解构回原名→ return 键零改动）══
  const step2 = useMontageStep2Concat({
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
    planDurText, runConcat, planRowText, selectPlan, startSeqPreview, onSeqEnded,
    submitConcatTask, confirmAllPrecompose, confirmPlanSingle,
    openProductDlg, productDlg, closeProductDlg, productDlgGenerate,
    copyViewDlg, viewPlanCopy, closeCopyView,
    planMenu, openPlanMenu, closePlanMenu,
    onDetailDragStart, onDetailDragEnd, onDetailDrop, toggleClipDeleted,
  } = step2

  // ══ Step4 特效包装（对照 step4_final_view.py 逐控件 + _start_final_mix/FinalMixWorker 一比一）══
  // BGM 选择持久化（2026-09-15 用户报障：会话级 ref 重启清空 → 导出时间轴缺 BGM 轨。
  // localStorage 跨会话记忆 bgmPath/bgmVolume，文件被删时导出侧 fs.existsSync 兜底跳过）
  const bgmPath = ref(localStorage.getItem('montage.bgmPath') || '')
  const bgmName = ref('')
  // BGM 增益默认 35%（2026-09-15 用户裁决，原 100；localStorage 记忆用户调整，0=静音为合法值不回退）
  const storedBgmVolume = Number(localStorage.getItem('montage.bgmVolume'))
  const bgmVolume = ref(Number.isFinite(storedBgmVolume) ? storedBgmVolume : 35)
  watch([bgmPath, bgmVolume], () => {
    try {
      localStorage.setItem('montage.bgmPath', bgmPath.value)
      localStorage.setItem('montage.bgmVolume', String(bgmVolume.value))
    } catch (_) { /* 隐私模式等写失败忽略 */ }
  })
  // 2026-09-18 用户裁决：逐视频 BGM 指派（Step4 视频列表每行可单独选 BGM）。
  // 键=候选视频路径（step4Candidates 口径：配音产物 dubbedPath / outputs）；值={path,name}。
  // 未指派的行导出/合成时回退全局 bgmPath。会话级（不持久化：路径跨会话易失效）。
  const rowBgm = ref<Record<string, { path: string; name: string }>>({})
  const finalBusy = ref(false)
  const finalMode = ref<'' | 'server' | 'local'>('') // 进行中的链路（双按钮独立 loading）
  const finalDone = ref(false)     // 三按钮启用开关（原版 btn_open_final_dir 等初始 disabled）
  const finalProgress = ref(-1)    // 混音进度 0-100（-1=隐藏；原版共享 progress_bar 口径）
  // 2026-09-16：导出剪映时间轴进度（独立于 finalBusy，导出期间禁用按钮+显示进度条）
  const exportBusy = ref(false)
  const exportProgress = ref(-1)   // 导出进度 0-100（-1=隐藏）
  const exportStage = ref('')      // 导出阶段文案
  // 2026-09-16：导出成功后记录草稿目录路径（供「打开草稿目录」按钮使用）
  const lastExportDraftPath = ref('')
  // 2026-09-18 用户裁决：导出完成提示行（仿声音克隆完成提示形态：状态行「完成：…」），
  // 「打开草稿目录」按钮内嵌该提示（自底部结果区移入）；重导时清空
  const exportDoneMsg = ref('')
  const finalVideoList = ref<Array<{ name: string; path: string }>>([])
  const finalVideoPath = ref('')   // 首个成片（final_video_path 口径）
  const finalSelIdx = ref(-1)      // 列表选中项（原版 currentItem，默认取第一个）
  const finalPreviewUrl = ref('')  // 右侧内嵌预览（打包后 file:// 源直读本地文件）
  const finalPreviewTitle = ref(' 视频预览')

  // ── AI 生成 BGM（本端保留功能：POST /audio/gen/bgm，原客户端 _GenBgmWorker 同口径：
  // prompt 必填 + style 英文值下拉 + duration；无 mood —— BGM 库的标签体系不属生成）──
  const bgmSource = ref<'local' | 'ai'>('local')   // 'ai' 仅作 AI 面板展开开关
  const bgmGenPrompt = ref('')
  const bgmGenStyle = ref('auto')
  const bgmGenDuration = ref(30)   // 秒（2026-09-05 用户裁决：客户端生成 BGM 上限 30 秒，滑杆 max=30 + 生成前 clamp）
  const bgmGenBusy = ref(false)
  const bgmGenError = ref('')
  const bgmGenUrl = ref('')        // 生成结果相对路径（预览/下载用）
  const bgmGenMeta = ref('')       // engine · duration 展示

  /** AI 生成 BGM：成功后主进程下载落盘（本地混音需本地文件，本端扩展）并回填 bgmPath */
  async function generateBgm(): Promise<void> {
    let payload: BgmGenPayload
    try {
      payload = buildBgmGenPayload({
        prompt: bgmGenPrompt.value,
        style: bgmGenStyle.value,
        duration: Math.min(30, Math.max(3, Math.round(Number(bgmGenDuration.value) || 30))),
      })
    } catch (e) {
      bgmGenError.value = errText(e)
      return
    }
    bgmGenError.value = ''
    bgmGenBusy.value = true
    try {
      await ensureServerUrl()
      const res = unwrapIpc(await window.tintin.server.audioGenBgm(payload), 'AI 生成 BGM')
      const parsed = parseBgmGenResponse(res)
      bgmGenUrl.value = parsed.url
      bgmGenMeta.value = [
        parsed.engine || 'MusicGen',
        parsed.duration ? `${Math.round(parsed.duration)}s` : '',
      ].filter(Boolean).join(' · ')
      // 本端扩展：本地 ffmpeg 混音/剪映草稿都需本地文件，主进程下载落盘（待裁决清单）
      const destDir = voiceDirInput.value
        ? joinPath(resolveOutMontageDir(voiceDirInput.value), 'bgm_ai')
        : joinPath(await readCacheDir(), 'montage_cache', 'bgm_ai')
      const dl = await window.tintin?.server?.bgmDownloadUrl?.({ url: bgmGenUrl.value, destDir })
      if (dl && 'path' in dl && dl.path) {
        bgmPath.value = dl.path
        bgmName.value = pathBasename(dl.path)
      }
      bgmSource.value = 'ai'
      notify('BGM 生成完成', `${payload.style === 'auto' ? '自动风格' : payload.style}｜已落盘：${bgmName.value || '(下载失败，仅预览可用)'}`)
    } catch (e) {
      bgmGenError.value = errText(e)
      clientError('video-montage', 'BGM生成失败', e)
      notify('BGM 生成失败', bgmGenError.value)
    } finally {
      bgmGenBusy.value = false
    }
  }

  /** 生成结果的预览地址（相对路径拼服务端基址） */
  const bgmPreviewUrl = computed(() => toAbsolute(bgmGenUrl.value))

  /** 下载音频库 BGM 到本地（仅下载不回填全局）——全局指派与逐行指派共用（2026-09-18） */
  async function downloadLibraryBgm(mid: string): Promise<{ path?: string; error?: string }> {
    try {
      const destDir = voiceDirInput.value
        ? joinPath(resolveOutMontageDir(voiceDirInput.value), 'bgm_lib')
        : joinPath(await readCacheDir(), 'montage_cache', 'bgm_lib')
      const dl = await window.tintin?.server?.bgmDownloadUrl?.({ url: `/audio/library/${mid}/file`, destDir })
      if (!dl || !('path' in dl) || !dl.path) return { error: '下载失败（服务端不可达或文件不存在）' }
      return { path: dl.path }
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) }
    }
  }

  /** BGM 选择弹窗确认（2026-09-09 用户裁决）：音频库音频经 /audio/library/{mid}/file
   *  下载落盘后回填全局 bgmPath（ffmpeg 混音/剪映导出需本地文件） */
  async function applyLibraryBgm(mid: string, filename: string): Promise<{ path?: string; error?: string }> {
    const r = await downloadLibraryBgm(mid)
    if (r.error || !r.path) return { error: r.error || '下载失败' }
    bgmPath.value = r.path
    bgmName.value = filename || pathBasename(r.path)
    return { path: r.path }
  }

  /** 选择背景音乐（_select_bgm L1522：标题「选择背景配乐」，mp3/wav/m4a/aac） */
  function pickBgm(): void {
    void (async () => {
      const res = await window.tintin.dialog.openFile({
        title: '选择背景配乐',
        filters: [{ name: 'Audio Files', extensions: ['mp3', 'wav', 'm4a', 'aac'] }],
      })
      if (res) {
        bgmPath.value = String(res)
        bgmName.value = pathBasename(bgmPath.value)
      }
    })()
  }

  // ── 逐视频 BGM 指派（2026-09-18 用户裁决：Step4 视频列表每行独立选 BGM）──
  /** 该行已指派的 BGM 显示名（未指派返回空串→模板显示占位「跟随全局 BGM」） */
  function rowBgmName(videoPath: string): string {
    return rowBgm.value[videoPath]?.name || ''
  }
  /** 指派/更新某行 BGM（path 为空=清除） */
  function setRowBgm(videoPath: string, path: string, name = ''): void {
    if (!videoPath) return
    const next = { ...rowBgm.value }
    if (path) next[videoPath] = { path, name: name || pathBasename(path) }
    else delete next[videoPath]
    rowBgm.value = next
  }
  /** 清除某行 BGM（回退跟随全局） */
  function clearRowBgm(videoPath: string): void { setRowBgm(videoPath, '', '') }
  /** 逐行本地文件选择（同 pickBgm，落 rowBgm 而非全局） */
  function pickRowBgm(videoPath: string): void {
    void (async () => {
      const res = await window.tintin.dialog.openFile({
        title: '选择背景配乐',
        filters: [{ name: 'Audio Files', extensions: ['mp3', 'wav', 'm4a', 'aac'] }],
      })
      if (res) setRowBgm(videoPath, String(res), pathBasename(String(res)))
    })()
  }
  /** 解析某候选视频路径的逐行 BGM 覆盖（仅行指派，不含全局回退；未指派返回空串）。
   *  服务端合成候选=源视频 r.path，而列表键=dubbedPath——经 voiceRows 双向映射兜住 */
  function rowBgmOverride(videoPath: string): string {
    const direct = rowBgm.value[videoPath]?.path
    if (direct) return direct
    const row = voiceRows.value.find((r) => r.path === videoPath || r.dubbedPath === videoPath)
    if (row) {
      const key = row.dubbedPath || row.path
      const p = rowBgm.value[key]?.path
      if (p) return p
    }
    return ''
  }
  /** 解析某候选视频路径的有效 BGM（逐行指派优先，回退全局） */
  function rowBgmForCandidate(videoPath: string): string {
    return rowBgmOverride(videoPath) || bgmPath.value || ''
  }

  // ── BGM 试听播放器（_toggle_bgm_play/_stop_bgm_play/_on_bgm_position_changed 等；
  // QMediaPlayer → HTMLAudioElement，进度条 range=duration、拖动 seek、增益实时生效）──
  let bgmAudioEl: HTMLAudioElement | null = null
  const bgmPlaying = ref(false)
  const bgmPosMs = ref(0)
  const bgmDurMs = ref(0)

  function toggleBgmPlay(): void {
    if (!bgmPath.value) { notify('文件不存在', '请先选择有效的背景音乐文件！'); return }
    try {
      if (!bgmAudioEl || bgmAudioEl.dataset.src !== bgmPath.value) {
        bgmAudioEl?.pause()
        bgmAudioEl = new Audio('file:///' + encodeURI(bgmPath.value.replace(/\\/g, '/')).replace(/#/g, '%23'))
        bgmAudioEl.dataset.src = bgmPath.value
        bgmAudioEl.ontimeupdate = () => { bgmPosMs.value = (bgmAudioEl?.currentTime || 0) * 1000 }
        bgmAudioEl.onloadedmetadata = () => { bgmDurMs.value = (bgmAudioEl?.duration || 0) * 1000 }
        bgmAudioEl.onended = () => { bgmPlaying.value = false; bgmPosMs.value = 0 }
      }
      if (bgmPlaying.value) {
        bgmAudioEl.pause()
        bgmPlaying.value = false
      } else {
        // 应用当前 BGM 增益（滑块 0-200%；HTML volume 上限 1，>100% 试听按满量，合成不受影响）
        bgmAudioEl.volume = Math.min(1, bgmVolume.value / 100)
        void bgmAudioEl.play()
        bgmPlaying.value = true
      }
    } catch (e) {
      clientError('video-montage', '播放背景音乐失败', e)
      notify('播放错误', `播放背景音乐失败: ${errText(e)}`)
    }
  }

  /** 停止试听（_stop_bgm_play：stop + 进度/时间复位，⏹ 在播放后可用） */
  function stopBgmPlay(): void {
    try {
      if (bgmAudioEl) { bgmAudioEl.pause(); bgmAudioEl.currentTime = 0 }
      bgmPlaying.value = false
      bgmPosMs.value = 0
    } catch (_) { /* 原版仅 log */ }
  }

  /** 增益滑杆拖动实时改变试听音量（_on_bgm_volume_changed；HTML volume 上限 1） */
  function onBgmVolumeInput(): void {
    if (bgmAudioEl) bgmAudioEl.volume = Math.min(1, bgmVolume.value / 100)
  }

  /** 进度条拖动定位（_set_bgm_position） */
  function seekBgm(e: Event): void {
    const v = Number((e.target as HTMLInputElement).value)
    if (bgmAudioEl) bgmAudioEl.currentTime = v / 1000
  }

  // ── 候选收集 / 混音合成 / 剪映导出（_collect_mix_candidates/_start_final_mix/
  // _export_to_jianying_draft/_export_all_to_jianying_draft 一比一）──

  /** 收集待混音候选：优先第③步配音视频，回退扫描 outputs 排列视频（本端另含
   *  已确认合成的本地落盘产物，等价原版 outputs 目录扫描口径）。
   *  2026-09-11 voice 接线（统一合成契约提案③）：useSource=true（服务端链路）取
   *  源视频路径（有配音 wav 的行）——配音随 concat voice 轨上传，不再本地替换
   *  原声（无「先声音合成」中间态）；本地链路维持 dubbed 产物口径。 */
  async function collectCandidates(useSource = false): Promise<string[]> {
    const primary = useSource
      ? voiceRows.value.filter((r) => r.wavPath && r.path).map((r) => r.path)
      : voiceRows.value.map((r) => r.dubbedPath || '').filter(Boolean)
    let outputsFiles: string[] = assemblePlans.value
      .map((p) => (p.outputPath && p.confirmed ? p.outputPath : ''))
      .filter(Boolean)
    if (!primary.length && !outputsFiles.length) {
      const dirPath = voiceDirInput.value
      if (dirPath) {
        const res = await window.tintin?.server?.finalCollectOutputs?.({ dirPath })
        if (res && 'files' in res) outputsFiles = res.files || []
      }
    }
    return collectMixCandidates(primary, outputsFiles)
  }

  /** 切到第④步：待混音数量 stage 提示（_go_to_step index==3 L388-395 逐字） */
  async function enterStep4(): Promise<void> {
    statusText.value = ''
    finalProgress.value = -1
    // 2026-09-17 用户报障②③④：voiceRows 仅进 Step3/合成确认时扫描，重启后直进
    // 第四步为空会话态 → 字幕/文字模板/口播/音效轨全空；按需重扫（非空 no-op）
    await ensureVoiceRows()
    // 2026-09-09 裁决：特效配置迁入 Step4，进入时拉取服务端文字模板库（空库仅随机项）
    void loadTextTemplates()
    // 效果预览轨（2026-09-10 二次裁决）：进入时按合成候选刷新一次（候选列表独立于 voiceRows）；
    // 2026-09-15 用户裁决：词条=纯标记不渲染，进页无渲染请求
    void refreshTextFxTracks()
    try {
      const cands = await collectCandidates()
      step4Candidates.value = cands // 联动预览候选（不依赖 textFx 开关，进入即刷）
      const n = cands.length
      statusText.value = n > 0
        ? `准备就绪：待混音合成 ${n} 个视频，点击「服务端合成」或「本地合成」`
        : '暂无待合成视频，请先完成「口播配音」'
    } catch (_) { /* 原版 except pass */ }
    // 历史成片恢复（2026-09-10 用户报障：刷新/重启后 finalDone=false 三按钮全禁用，
    // 「一键导出到剪映」点击无反应——按候选视频推导 final 目录回扫已合成产物）
    if (!finalVideoList.value.length) {
      try {
        const first = (await collectCandidates())[0]
        if (first) {
          const r = await window.tintin?.server?.finalListResults?.({ dirPath: resolveOutFinalDir(first) })
          const files = r && 'files' in r ? r.files : []
          if (files.length) {
            finalVideoList.value = files.map((p) => ({ name: pathBasename(p), path: p }))
            finalVideoPath.value = files[0]
            finalDone.value = true
            finalProgress.value = 100
            statusText.value = `已恢复上次合成结果（${files.length} 个成片），可直接导出剪映草稿或重新合成`
          }
        }
      } catch (_) { /* 恢复失败静默，不阻断进入 */ }
    }
  }

  /** 开始混音合成（_start_final_mix 一比一；FinalMixWorker 在主进程 final:mix）。
   *  2026-09-09 用户裁决：口播声音带到第四步统一合成处理——一键链=①给有声音未配音的
   *  视频替换原声 → ②特效烧制 → ③BGM 混音；无声音行沿用原视频直通 */
  /** 启动最终合成（2026-09-10 用户裁决双链路）：mode='server'（缺省）特效烧制与
   *  BGM 混音均走服务端，mode='local' 全本地 ffmpeg。
   *  2026-09-11 用户终裁：按钮决定链路，开启的特效只是参数全部随链路下发；
   *  服务端环节失败直接报错，不再静默回退本地（否则两按钮语义失真）。 */
  async function startFinalMix(mode: 'server' | 'local' = 'server'): Promise<void> {
    if (finalBusy.value) return
    finalBusy.value = true
    // 2026-09-10 用户裁决：双按钮同行独立转圈——记录本次链路，只让对应按钮 loading
    finalMode.value = mode
    finalDone.value = false
    finalVideoList.value = []
    finalVideoPath.value = ''
    finalProgress.value = 0
    stopBgmPlay()
    try {
      // ── 配音阶段（一键链第①段，仅本地链路）：本地替换原声需要 dubbed 产物；
      //    服务端链路配音改随 concat voice 轨一次合成（2026-09-11 统一合成契约
      //    提案③），直接用源视频 + voice 上传，不再本地预热——无配音的行不带
      //    voice 直通；无声音的行不配音，直接用原视频进后续特效/混音
      if (mode === 'local') {
        const needDub = voiceRows.value.filter((r) => r.wavPath && r.path && !r.dubbedPath).length
        if (needDub) {
          statusText.value = `正在替换口播原声 (${needDub} 个视频)...`
          await runDubBatch()
        }
      }
      // 服务端链路候选=源视频（voice 轨单独上传）；本地链路=dubbed 产物
      const candidates = await collectCandidates(mode === 'server')
      if (!candidates.length) {
        notify('无待合成视频', '未找到待合成的视频。\n请先完成第③步「口播配音」生成声音，或确认第②步的排列视频已生成。')
        return
      }
      const outFinalDir = resolveOutFinalDir(candidates[0])
      // 原版 src_name = 第①步素材目录名（folder_path_input basename）；本端取第③步视频输入目录名同语义
      // 2026-09-18 用户裁决：逐任务 BGM 覆盖（行指派优先；空串=跟随请求级全局 bgmPath）
      const tasks = buildFinalTasks(candidates, srcDirName(voiceDirInput.value), outFinalDir)
        .map((t) => ({ ...t, bgmPath: rowBgmOverride(t.videoPath) }))
      const channel = nextVoiceChannel()
      // 2026-09-09 裁决：特效配置迁 Step4，混音前统一烧制字幕/花字。
      // subtitleTexts 按候选视频映射 Step3 文案行：无对应行（如 outputs
      // 未配音排列视频）不烧字幕/花字，直通混音。
      // fxLines：文字模板命中行（服务端 match 结果，本地烧制素材下载与 drawtext 兜底消费）
      // matchId（2026-09-13 接口对齐）：match 响应回执，服务端 concat 按它直接复用
      //   已保存 events 烧制（不重算）→ 预览所见即成片所做
      // voicePath：配音 wav（2026-09-11 voice 接线：仅服务端链路消费，随 concat
      //   voice 轨上传；本地链路已由 dubVideos 替换进视频，不消费）
      const srtDirNow = await subtitleAssetDir()
      const subtitleTexts = candidates
        .map((c) => {
          // 服务端链路候选=源视频（r.path）；本地链路=配音产物（r.dubbedPath）
          const row = voiceRows.value.find((r) => (mode === 'server' ? r.path : r.dubbedPath) === c)
          if (!row || !row.text.trim()) return null
          return {
            videoPath: c,
            text: row.text.trim(),
            timingPath: row.wavPath ? `${row.wavPath}.timing.json` : '',
            voicePath: row.wavPath || '',
            // 2026-09-18 用户裁决：字幕重切段后处理资产路径（克隆完成即生成）——
            // 主进程存在性校验命中则优先上传该 SRT，缺失回退 buildSrtFromTiming
            srtPath: joinPath(srtDirNow, pathBasename(c).replace(/\.[^.]+$/, '') + '.srt'),
            fxLines: [] as Array<{ text: string; start: number; end: number; keywords: string[]; templateId?: string }>,
            matchId: '',
          }
        })
        .filter((x): x is {
          videoPath: string; text: string; timingPath: string; voicePath: string; srtPath: string
          fxLines: Array<{ text: string; start: number; end: number; keywords: string[]; templateId?: string }>
          matchId: string
        } => !!x)
      // 文字模板命中预取（2026-09-13 接口对齐：两种链路都预取——本地用 events/clips
      // 下素材+兜底；服务端把 match 回执 match_id 随 concat 下发，服务端直接用保存的
      // events 烧制不重算 → 预览=成片一致。离线/失败 → 本地空数组不烧 / 服务端无
      // match_id 退回旧口径由 concat 自行命中）
      if (textFxEnabled.value && subtitleTexts.length) {
        statusText.value = '正在获取文字模板命中...'
        // 勾选模板随 match 下发（与 concat text_template_match_ids 同源）：
        // 随机=当次随机池子集；指定=该模板自身
        const matchTemplateIds = currentMatchTemplateIds()
        // 串行取数 + 失败归集（2026-09-12 日志实锤：并行 3 连击期间服务端 match
        // 500/ECONNRESET 全灭 → textFxHits=0 → 成片既无关键词也无动画且无提示；
        // 串行+单点重试降连击压力，失败不再静默）
        const failed: string[] = []
        for (const st of subtitleTexts) {
          const r = await fetchTextFxHits(st.videoPath, st.text, st.timingPath, matchTemplateIds)
          st.fxLines = r.lines
          st.matchId = r.matchId
          if (!r.ok) failed.push(pathBasename(st.videoPath))
        }
        if (failed.length) {
          // 如实透出（铁律：服务端 5xx 定性归因服务端）：不静默产出无文字模板的成片
          clientError('video-montage', '文字模板关键词获取失败', `服务端 /text_templates/match 异常（500/连接中断），以下视频本次未烧文字模板：${failed.join('、')}`)
          notify('文字模板未生效', `服务端关键词命中接口异常（500/连接中断），以下视频本次合成不含文字模板：\n${failed.join('\n')}\n\n可稍后重试合成。`)
        }
      }
      const hasFx = addSubtitles.value || fancyEnabled.value || textFxEnabled.value
      // 2026-09-11 用户终裁：按钮决定链路，开了哪些特效、是否选 BGM 都只是参数——
      // 点「服务端合成」= 特效烧制 + BGM 混音整条交服务端一次 concat 完成（失败
      // 直接报错不回退本地）；点「本地合成」= 全部本地 ffmpeg。mixMode 是唯一
      // 开关（旧 serverFx 字段与它同义，已合并删除）。
      // 注：字幕动画（fade/rise/slide/pop）服务端无字段，服务端产物不生效。
      // 展开为纯对象：computed 从响应式数组 find 出的是 Proxy，直传 IPC 会报
      //   「An object could not be cloned」（同 scanVoiceDir selectedFiles 教训）
      const fxTpl = selectedFancyTemplate.value
      const fxTplPlain = fxTpl ? { ...fxTpl } : null
      // 2026-09-18 修复「An object could not be cloned」：computed 取出的 serverStyle
      //   是响应式 Proxy，直传 ipcRenderer.invoke 被结构化克隆拒绝（同 scanVoiceDir
      //   selectedFiles 教训）；JSON 往返展平为纯对象（样式对象为纯 JSON 形态）
      const subtitleStylePlain = plainJson(selectedSubtitlePreset.value?.serverStyle || null)
      const res = await window.tintin?.server?.finalMix?.({
        mixMode: mode,
        tasks,
        bgmPath: bgmPath.value,
        bgmVolume: bgmVolume.value,
        ...(hasFx ? {
          effects: {
            addSubtitles: addSubtitles.value,
            subtitleFont: addSubtitles.value ? selectedFontFamily() : '',
            subtitleStyle: subtitleStyleKey.value,
            subtitleStyleObj: subtitleStylePlain,
            subtitleBoxOpacity: subtitleBgOpacity.value,
            subtitleAnim: subtitleAnimKey.value,
            fancyText: fancyEnabled.value,
            fancyStyle: fancyStyle.value,
            fancyPosition: fancyPosition.value,
            fancyTemplate: fxTplPlain,
            // 文字模板随统一合成提交服务端（text_template_* 字段；2026-09-11 用户裁决：
            // 不再传本地提取词表（text_template_words）——关键词命中在合成请求内由
            // 服务端从随请求提交的字幕自行完成；random 模板→match_enabled + 模板池）
            textFxEnabled: textFxEnabled.value,
            // 2026-09-14：还原 LUT 开关随统一合成提交服务端（lut_restore，仅服务端链消费）
            lutRestore: lutRestore.value,
            lutId: lutRestore.value ? (lutId.value || '') : '',
            textTemplateId: textTemplateId.value,
            // match 模式必填（/guide text_template_match_ids）：每次合成从模板库随机
            // 取 N 个 id 作模板池，命中行从池中随机选一（与「随机数量」UI 语义一致）
            // 2026-09-13 对齐：兜底池与 match 预取同源（currentMatchTemplateIds），
            // 预取失败退回 concat 自行命中时也保持同一候选集
            textTemplateMatchIds: textTemplateId.value === 'random'
              ? currentMatchTemplateIds()
              : [],
            matchDensity: textKeywordDensity.value,
            // 本地烧制样式池（2026-09-10 用户二次裁决：传全量库+随机个数，每视频在烧制端
            // 确定性洗牌取子集，与效果预览同源；提炼主色/效果色/动画同预览口径）
            textFxStyles: activeTextPool.value.map((t) => textFxStyleOf(t)),
            textFxCount: activeTextCount.value,
          },
        } : {}),
        // 2026-09-11 voice 接线：subtitleTexts 在服务端链路无条件下发（其中 voicePath
        // 即 concat voice 轨来源，无特效纯配音任务也要带）；本地链路无特效不传（零开销直通）
        ...((hasFx || (mode === 'server' && subtitleTexts.length)) ? { subtitleTexts } : {}),
        progressChannel: channel,
      })
      if (!res) throw new Error('主进程不可达')
      if ('error' in res) throw new Error(res.error)
      // 记录各成片的合成任务 id（2026-09-15：from-task 时间轴导出用，持久化跨会话）
      // inputPath=该成片的合成输入源（2026-09-17 修复：时间轴导出按它回关联口播行/
      // 字幕 timing——合成产物路径匹配不到 voiceRows，曾致 SRT 空串导出失败）
      if (Array.isArray(res.taskIds) && res.taskIds.length) {
        lastComposeTasks.value = res.taskIds
          .map((tid, idx) => ({ taskId: String(tid), outputPath: String(res.results[idx] || ''), inputPath: String(candidates[idx] || '') }))
          .filter((p2) => p2.taskId && p2.outputPath)
        try { localStorage.setItem('montage.lastComposeTasks', JSON.stringify(lastComposeTasks.value)) } catch (_) { /* 忽略 */ }
      }
      onMixFinished(res.results)
    } catch (e) {
      onMixError(errText(e))
    } finally {
      finalBusy.value = false
      finalMode.value = ''
      offVoiceProgress?.(); offVoiceProgress = null
      // 合成结束重刷效果预览（合成期间 refreshTextFxTracks 被 finalBusy 短路跳过；
      // setTimeout 让 finalBusy=false 先生效，2026-09-12）
      setTimeout(() => { void refreshTextFxTracks() }, 0)
    }
  }

  /** 混音完成（_on_mix_finished：三按钮启用 + 列表填充 + stage 文案逐字） */
  function onMixFinished(paths: string[]): void {
    finalDone.value = true
    finalProgress.value = 100
    statusText.value = '完成： 最终合成视频完成！'
    finalVideoList.value = (paths || []).map((p) => ({ name: pathBasename(p), path: p }))
    finalVideoPath.value = paths && paths.length ? paths[0] : ''
    finalSelIdx.value = -1
  }

  /** 混音失败（_on_mix_error：stage + 长错误弹窗） */
  function onMixError(err: string): void {
    finalProgress.value = 0
    statusText.value = '失败： 合成失败'
    clientError('video-montage', '混音合成失败', err)
    notify('合成错误', `处理过程中发生错误：\n${err}`)
  }

  /** 打开视频输出目录（_open_output_dir：startfile 成片目录） */
  function openFinalDir(): void {
    if (!finalVideoPath.value) return
    const dir = finalVideoPath.value.slice(0, Math.max(finalVideoPath.value.lastIndexOf('\\'), finalVideoPath.value.lastIndexOf('/')))
    try { window.tintin.shell.openItem(dir) } catch (e) { clientError('video-montage', '打开输出目录失败', e); notify('打开失败', errText(e)) }
  }

  /** 打开剪映草稿目录（2026-09-16：导出成功后供用户直接查看草稿文件） */
  function openExportDraftDir(): void {
    if (!lastExportDraftPath.value) return
    try { window.tintin.shell.openItem(lastExportDraftPath.value) } catch (e) { clientError('video-montage', '打开草稿目录失败', e); notify('打开失败', errText(e)) }
  }

  /** 导出全部到时间轴（2026-09-14 用户裁决：同轨道导出口径，带转场） */
async function exportAllToJianyingDraft(): Promise<void> {
    // 2026-09-18 用户裁决：导出进度条独立全程显示（不与服务端合成 finalBusy
    //   进度条混用）；渲染层分段驱动，完成后切换完成提示行
    exportBusy.value = true
    exportProgress.value = 5
    exportStage.value = '正在扫描候选素材...'
    exportDoneMsg.value = ''
    try {
      await exportMontageTracksDraft('螺丝钉剪辑_轨道时间轴')
    } finally {
      exportBusy.value = false
    }
  }

  // ── 旧客户端自组装导出（无服务端合成任务时的 B 路径使用）──
  async function doJianyingExport(base: {
    mode: 'single' | 'multi'
    videoPath?: string
    videoPaths?: string[]
    srtPath?: string
    srtPaths?: Array<string | null>
    transitions?: string
    bgmPath?: string
    /** 2026-09-18 用户裁决：逐视频 BGM（与 videoPaths 平行；空串=该窗回退全局 bgmPath） */
    bgmPaths?: Array<string | null>
    bgmVolume?: number
    fxWords?: string[]
    fxKinds?: Array<'fancy' | 'tpl'>
    textAnim?: string
    fancyEffectId?: string
    tplEffectId?: string
    /** 2026-09-15：逐视频原生文字模板命中（match textfx_clips 权威指派）→ 导出器三件套轨 */
    textTemplateClips?: Array<Array<{ phrase: string; startUs: number; durUs: number; resourceId: string }>>
    /** 2026-09-15：逐视频口播 wav（音频三轨体系：口播轨独立，对应素材段静音） */
    voiceClips?: Array<Array<{ path: string; startUs: number; durUs: number }>>
    /** 2026-09-17：音效兜底来源（所选花字模板的本地 sound 声明；音效轨跟随文字模板
     *  命中位置——与花字轨无关）。2026-09-18 用户裁决：音效主来源=服务端音频库
     *  剪映音效库 <2s 条目（主进程下载落 sfxDestDir 后按命中循环指派） */
    fancyTemplate?: Record<string, unknown> | null
    /** 2026-09-18：音效池下载落盘目录（工程资产目录 sfx/；缺省回落临时目录） */
    sfxDestDir?: string
    /** 2026-09-17 用户报障①：第四步选中的服务端字幕样式对象（/subtitle_styles 成员）
     *  + UI 背景不透明度百分比 → 主进程映射为草稿字幕轨文本样式 */
    subtitleStyle?: Record<string, unknown> | null
    subtitleBoxOpacity?: number | null
    /** 2026-09-18 用户裁决：字幕字号（缺省 10 号）→ 草稿 texts size */
    subtitleFontSize?: number | null
    draftName: string
    successBody: (name: string) => string
  }): Promise<boolean> {
    // 2026-09-12 缺陷修复（用户报「两导出按钮点击毫无反应」，日志仅一条
    // Error: An object could not be cloned.）：successBody 是渲染层本地回调，此前经
    // ...base 整体展开混入 IPC payload——结构化克隆无法序列化函数 → invoke 直接
    // reject → 链路无 catch → 无弹窗无日志的完全静默。解构剔除回调后 IPC 只收纯数据，
    // 并对 invoke 兜底 catch：任何异常都 clientError + 弹窗透出，不再「没反应」。
    const { successBody, ...ipcBase } = base
    let res: { success: boolean; message: string } | undefined
    try {
      res = await window.tintin?.server?.jianyingExport?.({
        ...ipcBase,
        bgmPath: bgmPath.value,
        bgmVolume: bgmVolume.value,
      })
    } catch (e) {
      clientError('video-montage', '导出剪映草稿失败', errText(e))
      notify('导出失败', `导出剪映草稿时发生错误：\n${errText(e)}`)
      return false
    }
    if (res && res.success) {
      // 2026-09-14 用户裁决：导出成功后自动拉起剪映（主进程 launchJianying），
      // 替代原「打开草稿文件夹」；拉起状态附在通知里
      const rx = res as unknown as { launched?: boolean; jianyingRunning?: boolean; bgmIncluded?: boolean; message?: string; conformance?: { checkedSegs?: number; warnings?: string[] } }
      let tail = rx.launched ? '（已拉起剪映）' : rx.jianyingRunning ? '（剪映已运行，草稿已在首页）' : ''
      // 2026-09-16：记录草稿目录路径（供「打开草稿目录」按钮使用）
      if (rx.message) lastExportDraftPath.value = String(rx.message)
      // 2026-09-15 用户报障：BGM 未选/文件已删时静默产出无 BGM 轨草稿——据实附在通知里
      // （导出器回传 bgmIncluded：未选 BGM 或所选文件不存在时为 false）
      if (rx.bgmIncluded === false) {
        tail += '\n⚠️ 本次草稿未包含 BGM 轨（未选择 BGM 或所选文件不存在）'
      }
      // 2026-09-17 对齐收尾：符合性审计警告透出（本路径全走标准构造器，预期 0 警告；
      // 非 0 即构造器缺陷，必须可见——不得只回传字段无人消费）
      const cw = rx.conformance && Array.isArray(rx.conformance.warnings) ? rx.conformance.warnings : []
      if (cw.length) {
        tail += '\n⚠️ 格式符合性警告 ' + cw.length + ' 条（不影响打开，已记录日志）：' + cw.slice(0, 3).join('；') + (cw.length > 3 ? ' …' : '')
      }
      notify('草稿导出成功', successBody(base.draftName) + tail)
      return true
    } else {
      clientError('video-montage', '导出剪映草稿失败', res ? res.message : '主进程不可达')
      notify('导出失败', `导出剪映草稿时发生错误：\n${res ? res.message : '主进程不可达'}`)
      return false
    }
  }

  function jianyingFxParams(): {
    fxWords?: string[]
    fxKinds?: Array<'fancy' | 'tpl'>
    textAnim?: string
    fancyEffectId?: string
    tplEffectId?: string
    subAnim?: string
  } {
    const kinds: Array<'fancy' | 'tpl'> = []
    if (fancyEnabled.value) kinds.push('fancy')
    if (textFxEnabled.value) kinds.push('tpl')
    if (!kinds.length) {
      // 二期②：仅字幕动画（addSubtitles 开且选了非 fade 动画）也随导出
      const subAnim = subtitleAnimKey.value && subtitleAnimKey.value !== 'fade' ? subtitleAnimKey.value : ''
      return addSubtitles.value && subAnim ? { subAnim } : {}
    }
    const words = extractTextFxWords()
    const subAnim = subtitleAnimKey.value && subtitleAnimKey.value !== 'fade' ? subtitleAnimKey.value : ''
    const out: { fxWords?: string[]; fxKinds?: Array<'fancy' | 'tpl'>; textAnim?: string; fancyEffectId?: string; tplEffectId?: string; subAnim?: string } = { fxKinds: kinds }
    if (words.length) out.fxWords = words
    if (subAnim) out.subAnim = subAnim
    const ftpl = selectedFancyTemplate.value as Record<string, unknown> | null
    if (fancyEnabled.value && ftpl) {
      const eff = String(ftpl.jy_effect_id || '').trim()
      const anim = String(ftpl.jy_intro_anim || '').trim()
      if (eff) out.fancyEffectId = eff
      if (anim) out.textAnim = anim
    }
    if (textFxEnabled.value && textTemplateId.value.startsWith('jy_')) {
      out.tplEffectId = textTemplateId.value.slice(3)
    }
    return out
  }

  /** 各成片合成任务 id（from-task 合并流数据源；随服务端合成回传并持久化跨会话）。
   *  inputPath 为 2026-09-17 修复新增：合成输入源（旧持久化数据无此字段→undefined）。 */
  const lastComposeTasks = ref<Array<{ taskId: string; outputPath: string; inputPath?: string }>>((
    () => {
      try { return JSON.parse(localStorage.getItem('montage.lastComposeTasks') || '[]') } catch (_) { return [] }
    }
  )())

  /** 响应式对象 → 纯 JSON 对象（ipcRenderer.invoke 结构化克隆不接受 Proxy；
   *  2026-09-18 合成报「An object could not be cloned」的根因修复 helper） */
  function plainJson<T>(o: T): T {
    if (o === null || o === undefined) return o
    try { return JSON.parse(JSON.stringify(o)) as T } catch (_) { return o }
  }

  /** 草稿命名：品牌+产品型号+日期时间+分辨率+音频索引+轨道时间轴（2026-09-16 用户裁决） */
  function timelineDraftName(): string {
    const brand = String(sharedProductInfo.value.brand || '').trim()
    const product = String(sharedProductInfo.value.product || '').trim()
    const model = String(sharedProductInfo.value.model || '').trim()
    // 品牌+产品型号（无则兜底「混剪」）
    const bp = (brand + product + model) || '混剪'
    // 日期时间：YYYYMMDD_HHmmss
    const d = new Date()
    const ymd = d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0')
    const hms = String(d.getHours()).padStart(2, '0') + String(d.getMinutes()).padStart(2, '0') + String(d.getSeconds()).padStart(2, '0')
    // 分辨率（splitResolution 格式 "1080x1920"，无则兜底「未知分辨率」）
    const resolution = splitResolution.value || '未知分辨率'
    // 音频索引
    const idxs = voiceRows.value
      .map((r) => {
        const base = (r.wavPath || '').split('/').pop() || ''
        const m = base.match(/voice_(\d+)\.wav/i)
        return m ? Number(m[1]) : 0
      })
      .filter((n) => n > 0)
      .sort((a, b) => a - b)
    let audioPart = ''
    if (idxs.length) {
      audioPart = (idxs[idxs.length - 1] - idxs[0] === idxs.length - 1)
        ? '音频' + idxs[0] + '-' + idxs[idxs.length - 1]
        : '音频' + idxs.join(',')
    }
    return bp + '_' + ymd + '_' + hms + '_' + resolution + (audioPart ? '_' + audioPart : '') + '_轨道时间轴'
  }

  /** 口播行会话态恢复（2026-09-17 用户报障②③④）：voiceRows 仅在进 Step3/合成确认时
   *  扫描，重启后直进第四步或导出即为空数组 → 字幕/文字模板/口播/音效轨全空（草稿
   *  只剩视频+BGM）。空时按持久化记录回推扫描目录重扫：已确认合成产物目录（与
   *  enterStepVoice 同源）→ 合成记录 inputPath → 当前 voiceDirInput。不做旧产物清理
   *  （keepFiles 不传，导出不得删文件）。 */
  async function ensureVoiceRows(): Promise<void> {
    if (voiceRows.value.length) return
    const dirs: string[] = []
    const push = (d: string) => { if (d && !dirs.includes(d)) dirs.push(d) }
    const dirOf = (p: string) => String(p || '').slice(0, Math.max(String(p || '').lastIndexOf('\\'), String(p || '').lastIndexOf('/')))
    for (const p of assemblePlans.value) {
      if (p.confirmed && p.outputPath) push(dirOf(p.outputPath))
    }
    for (const t of lastComposeTasks.value) {
      if (t.inputPath) push(dirOf(t.inputPath))
    }
    if (voiceDirInput.value) push(voiceDirInput.value)
    if (!dirs.length) return
    await scanVoiceDir({ dirs })
  }

  /** 字幕资产目录（2026-09-18 用户裁决：srt/ 与 dubbed//bgm_ai/ 同级；
   *  克隆后后处理/导出/合成三处同源，提取复用） */
  async function subtitleAssetDir(): Promise<string> {
    return voiceDirInput.value
      ? joinPath(resolveOutMontageDir(voiceDirInput.value), 'srt')
      : joinPath(await readCacheDir(), 'montage_cache', 'srt')
  }

  /** 字幕重切段后处理（2026-09-18 用户裁决：声音克隆完成后即处理）：
   *  LLM 重切文案为字幕行（漏字/拼接一致性校验不过回退本地规则拆句）+ TTS 句级
   *  timing 字符位置映射 → SRT 资产落 srt/<候选 basename>.srt。资产已存在直接复用
   *  （不重复调 LLM；dubbed_ 前缀产物回退剥前缀同名资产）；best-effort：离线/LLM
   *  失败回落本地切段，写失败/无行返回空串由调用方回退旧口径。 */
  async function ensureProcessedSrt(text: string, wavPath: string, candidate: string): Promise<string> {
    try {
      const src = String(text || '').trim()
      if (!src || !candidate) return ''
      const dir = await subtitleAssetDir()
      const stem = pathBasename(candidate).replace(/\.[^.]+$/, '')
      const nmIn = inputNameFromFinalPath(candidate)
      for (const nm of [stem, nmIn]) {
        if (!nm) continue
        const hit = joinPath(dir, nm + '.srt')
        const ex = await window.tintin?.liveclip?.fileExists?.({ path: hit })
        if (ex?.exists) return hit
      }
      const tr = await window.tintin?.server?.finalReadTiming?.({ timingPath: String(wavPath || '') + '.timing.json' })
      const timing = tr && 'items' in tr ? tr.items : []
      let llmLines: string[] | null = null
      try {
        const resp = await window.tintin?.server?.llmChat?.({
          messages: [
            { role: 'system', content: SENTENCE_SPLIT_SYSTEM_PROMPT },
            { role: 'user', content: src },
          ],
          temperature: 0.2,
        })
        const lines = extractLlmLines(extractLlmContent(resp))
        if (lines.length) llmLines = lines
      } catch (_) { llmLines = null }
      const rows = mapLinesToTiming(planSubtitleLines(src, llmLines), timing)
      if (!rows.length) return ''
      const file = joinPath(dir, stem + '.srt')
      const w = await window.tintin?.liveclip?.writeTextFile?.({ path: file, content: serializeSrtRows(rows) })
      return w?.ok ? file : ''
    } catch (_) {
      return ''
    }
  }

  /** 导出到剪映时间轴（2026-09-15 用户裁决双路径）：
   *  A) 有服务端合成任务 → from-task 合并流：素材/字幕/口播/BGM 由服务端清单出
   *     （assets 逐个下载落草稿目录），客户端对齐追加文字模板三件套/花字/音效轨；
   *  B) 无任务 → 客户端自组装流：候选素材 + 口播 wav 轨 + 字幕 + 文字模板三件套 + BGM。
   *  两路径草稿命名一致：品牌产品+日期+音频索引+轨道时间轴。 */
  async function exportMontageTracksDraft(draftName: string): Promise<void> {
    // 2026-09-17 用户裁决「一个按钮一条路」：本按钮=纯本地组装——本地视频/本地口播 wav/
    // 本地 timing 生成 SRT/本地文字模板命中/本地 BGM → exportMultiToDraft。
    // 不调服务端清单、不下载资产（原「有任务走服务端清单」分流整段删除）；
    // 服务端包走「导入服务端草稿包」按钮（editor:exportJianyingPackage）。
    // 2026-09-17 用户报障③④二次修正：候选恒取当前口播行（配音产物/确认合成产物，
    //  即「预合成、无烧制字幕、无混音」的视频），不再优先 lastComposeTasks 合成产物——
    //  合成产物自带混音（与口播轨/BGM 轨双重发声）且烧制字幕/花字与轨道双重绘制；
    //  跨会话持久化的合成记录与当前 voiceRows 失配时还会致全轨落空（草稿只剩视频+BGM）。
    await ensureVoiceRows()
    const cands = await collectCandidates()
    if (!cands.length) {
      notify('无候选素材', '请先完成镜头重组与口播配音再导出')
      return
    }
    exportProgress.value = 10
    exportStage.value = `候选素材共 ${cands.length} 段，生成字幕资产...`
    const srtPaths: Array<string | null> = []
    const textTemplateClips: Array<Array<{ phrase: string; startUs: number; durUs: number; resourceId: string }>> = []
    const voiceClips: Array<Array<{ path: string; startUs: number; durUs: number }>> = []
    const fancyEvents: Array<Array<{ word: string; startUs: number; durUs: number }>> = []
    const fxWords = fancyEnabled.value ? extractTextFxWords() : []
    let noSubClips = 0
    for (let i = 0; i < cands.length; i++) {
      const c = cands[i]
      // 2026-09-18 用户裁决：导出进度条分段驱动（独立于服务端合成进度条）
      exportStage.value = `生成字幕资产（${i + 1}/${cands.length}）...`
      exportProgress.value = 10 + Math.round((70 * i) / cands.length)
      // 2026-09-17 用户报障③④二次修正：候选恒为当前口播行路径（配音产物/确认合成
      //  产物），按 dubbedPath/path 直配 voiceRows；basename 兜底仅跨会话重扫目录
      //  漂移（同名产物不同目录）时用，含 dubbed_ 前缀与合成产物命名约定反推。
      let row = voiceRows.value.find((r) => r.dubbedPath === c || r.path === c)
      if (!row) {
        const nm = pathBasename(c)
        const nmIn = inputNameFromFinalPath(c)
        row = voiceRows.value.find((r) => [r.path, r.dubbedPath].some((q) => {
          if (!q) return false
          const qb = pathBasename(q)
          return qb === nm || qb === 'dubbed_' + nm
            || (nmIn !== '' && (qb === nmIn || qb === 'dubbed_' + nmIn))
        }))
      }
      const text = String(row?.text || '').trim()
      const timingPath = row?.wavPath ? row.wavPath + '.timing.json' : ''
      let timing: Array<{ text: string; start: number; end: number }> = []
      if (timingPath) {
        const r = await window.tintin?.server?.finalReadTiming?.({ timingPath })
        timing = r && 'items' in r ? r.items : []
      }
      const rows2 = buildSubtitleRows(text, timing, 0)
      // 字幕 SRT：消费声音克隆完成后即生成的后处理资产（2026-09-18 用户裁决：
      //   后处理时点前移至克隆完成，导出与服务端合成均为纯消费者）。资产命中→
      //   直接用；缺失（旧会话/未跑克隆）→ 现场重切段回写；文案空/写失败 → 该段
      //   不出字幕轨（导出器 srtPaths null 容忍，2026-09-17 修复：合成产物候选曾在此整单中断）
      {
        const srtFile = text ? await ensureProcessedSrt(text, row?.wavPath || '', c) : ''
        if (srtFile) {
          srtPaths.push(srtFile)
        } else {
          noSubClips++
          srtPaths.push(null)
        }
      }
      // 文字模板命中（2026-09-17 用户裁决）：本地缓存优先（预览/合成已预取的命中，
      // 预览位置=命中位置）；未命中本地现算（关键词×行窗口，phrase=命中关键词）。
      // 不再调服务端 match——命中判定属客户端映射职责。
      if (textFxEnabled.value) {
        // 命中缓存键=候选自身（与预览/合成预取同源键）；未命中本地现算
        const hits = textFxHitsForExport(c, rows2)
        textTemplateClips.push(hits
          .filter((h) => h.templateId && h.end > h.start)
          .map((h) => ({
            phrase: h.text,
            startUs: Math.round(h.start * 1e6),
            durUs: Math.round((h.end - h.start) * 1e6),
            resourceId: String(h.templateId),
          })))
      } else {
        textTemplateClips.push([])
      }
      // 口播 wav（独立口播轨；候选即配音产物时其声已内嵌，此轨仍保留便于独立调整）
      if (row?.wavPath) {
        voiceClips.push([{ path: row.wavPath, startUs: 0, durUs: Math.max(1, Math.round((row.voiceDurSec || 0) * 1e6)) }])
      } else {
        voiceClips.push([])
      }
      // 花字命中（fancyEnabled：命中关键词在成片内的时间窗）——花字轨=纯文本轨（无音效职责）
      if (fancyEnabled.value && fxWords.length) {
        const evs: Array<{ word: string; startUs: number; durUs: number }> = []
        for (const r of rows2) {
          for (const w of fxWords) {
            if (r.text.toLowerCase().includes(w.toLowerCase())) evs.push({ word: w, startUs: Math.round(r.start * 1e6), durUs: Math.round((r.end - r.start) * 1e6) })
          }
        }
        fancyEvents.push(evs)
      } else {
        fancyEvents.push([])
      }
    }
    const transition = concatTransition.value || 'fade'
    const finalName = timelineDraftName()
    exportStage.value = '组装剪映时间轴草稿（转场/口播/字幕/BGM 各轨）...'
    exportProgress.value = 85
    // 本地组装（2026-09-18 用户裁决：音效=主进程从服务端音频库剪映音效库 <2s 条目
    // 下载到资产目录 sfx/ 后按命中循环指派；空池回落花字模板本地 sound 声明）
    const ok = await doJianyingExport({
      mode: 'multi',
      videoPaths: cands,
      srtPaths,
      transitions: transition,
      ...jianyingFxParams(),
      fancyTemplate: selectedFancyTemplate.value ? ({ ...selectedFancyTemplate.value } as Record<string, unknown>) : null,
      subtitleStyle: plainJson(selectedSubtitlePreset.value?.serverStyle || null) as Record<string, unknown> | null,
      subtitleBoxOpacity: subtitleBgOpacity.value,
      subtitleFontSize: subtitleFontSize.value,
      textTemplateClips,
      voiceClips,
      bgmPath: bgmPath.value,
      // 2026-09-18 用户裁决：逐视频 BGM（与 cands 平行；未指派的行=空串→导出器回退全局 bgmPath）
      bgmPaths: cands.map((c) => rowBgmForCandidate(c)),
      bgmVolume: bgmVolume.value,
      // 音效下载落盘目录：工程资产目录 sfx/（与 srt//jy_pkg/ 同级；无输入目录
      // 回落 cacheDir/montage_cache/sfx，同 SRT 口径）
      sfxDestDir: voiceDirInput.value
        ? joinPath(resolveOutMontageDir(voiceDirInput.value), 'sfx')
        : joinPath(await readCacheDir(), 'montage_cache', 'sfx'),
      draftName: finalName,
      successBody: (name: string) => '已按原始轨道结构导出 ' + cands.length + ' 段候选视频（转场：' + transition + '，含口播/字幕/关键词/BGM 轨）！\n项目名称：' + name + (noSubClips ? '\n（注：' + noSubClips + ' 段无口播文案，未出字幕/关键词轨）' : ''),
    })
    if (ok) {
      exportProgress.value = 100
      exportStage.value = '导出完成'
      // 2026-09-18 用户裁决：完成提示仿声音克隆生成完成提示形态（状态行「完成：…」+ OS 弹窗）；
      // 「打开草稿目录」按钮内嵌该提示行（自底部结果区移入）
      exportDoneMsg.value = '完成： 剪映时间轴草稿导出完成！'
      statusText.value = exportDoneMsg.value
    } else {
      statusText.value = '注意： 剪映时间轴导出失败（详见弹窗通知）'
    }
  }

  /** 轨 2（2026-09-17 用户裁决）：导入服务端草稿包——服务端封装好的剪映格式 zip，
   *  客户端只做 解压→数据/路径校验→落盘剪映草稿目录（映射关系属客户端职责；
   *  服务端给映射=服务端出草稿包，即本轨）。逐任务一个草稿。 */
  async function exportJianyingPackageDraft(): Promise<void> {
    const tasks = lastComposeTasks.value
    if (!tasks.length) {
      notify('无法导入', '没有可导入的合成任务：请先执行「服务端合成」')
      return
    }
    exportBusy.value = true
    exportProgress.value = 0
    exportStage.value = '准备导入...'
    const progressChannel = `jy-pkg:progress:${(crypto?.randomUUID?.() || `${Date.now()}_${Math.floor(Math.random() * 1e8)}`).replace(/-/g, '')}`
    const offProgress = window.tintin?.server?.onVoiceProgress?.(progressChannel, (d: { stage?: string; value?: number }) => {
      if (typeof d?.value === 'number') exportProgress.value = d.value
      if (d?.stage) exportStage.value = String(d.stage)
    })
    try {
      const res = await window.tintin?.server?.editorExportJianyingPackage?.({
        taskIds: tasks.map((t2) => t2.taskId),
        progressChannel,
        // 2026-09-18 用户裁决：草稿包 zip 属资产，落工程资产目录 jy_pkg/
        //   （与 srt/ 同级，重导覆盖为最新，导入成功保留可复用）；主进程从该
        //   文件解压（stdin 流式读 zip 静默丢条目曾致误报「包内无 draft_content.json」）
        zipDestDir: voiceDirInput.value
          ? joinPath(resolveOutMontageDir(voiceDirInput.value), 'jy_pkg')
          : joinPath(await readCacheDir(), 'montage_cache', 'jy_pkg'),
      })
      if (res && res.success) {
        const rx = res as unknown as { results?: Array<{ taskId: string; draftFolder: string; warnings: string[]; registered: boolean }>; launched?: boolean; jianyingRunning?: boolean; message?: string }
        const rs = rx.results || []
        if (rs[0]?.draftFolder) lastExportDraftPath.value = String(rs[0].draftFolder)
        const tail = rx.launched ? '（已拉起剪映）' : rx.jianyingRunning ? '（剪映已运行，草稿已在首页）' : ''
        const lines = rs.map((r) => '任务 ' + r.taskId + ' → ' + r.draftFolder + (r.registered ? '' : '（首页注册失败，草稿仍可用）'))
        const warnCount = rs.reduce((n, r) => n + (r.warnings?.length || 0), 0)
        const wsum = warnCount ? '\n⚠️ 格式符合性警告 ' + warnCount + ' 条（不影响打开，已记录日志）' : ''
        notify('服务端草稿包导入成功', '已导入 ' + rs.length + ' 个草稿：\n' + lines.join('\n') + wsum + tail)
      } else {
        const msg = res && 'message' in res ? String(res.message || '') : '主进程不可达'
        clientError('video-montage', '导入服务端草稿包失败', msg)
        notify('导入失败', '导入服务端草稿包时发生错误：\n' + msg)
      }
    } catch (e) {
      clientError('video-montage', '导入服务端草稿包失败', errText(e))
      notify('导入失败', '导入服务端草稿包时发生错误：\n' + errText(e))
    } finally {
      exportBusy.value = false
      exportProgress.value = -1
      exportStage.value = ''
      if (typeof offProgress === 'function') offProgress()
    }
  }

  /** 双击成片项内嵌预览（_preview_final_video：标题换文件名并播放） */
  function previewFinalVideo(i: number): void {
    const it = finalVideoList.value[i]
    if (!it?.path) return
    finalPreviewTitle.value = `  ${it.name}`
    finalPreviewUrl.value = 'file:///' + encodeURI(it.path.replace(/\\/g, '/')).replace(/#/g, '%23')
  }

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
  // 2026-09-18 用户裁决：字幕字号（剪映草稿 texts content styles[].size），默认 10 号
  // （原导出器缺省 8 实测偏小）；第四步「字号」下拉覆写，预览同比例缩放
  const subtitleFontSize = ref(10)
  // 花字位置/字幕背景/模板（L224-352；模板首项「自定义 (下方样式)」value=''）
  const fancyPosition = ref('upper_middle')
  // 字幕背景不透明度默认 20%（2026-09-15 用户裁决：背景里的透明默认设计为 20%，原 0.5）
  const subtitleBgOpacity = ref(0.2)
  const fancyTemplateId = ref('')
  const fancyTemplates = ref<FancyTemplateItem[]>([])
  const fancyPreviews = ref<Record<string, string>>({})
  const fancyTemplatesLoading = ref(false)
  // ── 文字模板（2026-09-09 用户裁决：服务端 textfx 体系，与花字独立概念）──
  // textTemplateId 首项 'random'（随机样式，默认）：每次合成从全部模板随机选 N 个（默认 3）；
  // 2026-09-10 在线契约纠偏：服务端统一合成 POST /montage/concat（multipart）已支持全套
  // text_template_* 字段（enabled/id/words/timing/match_enabled/match_ids），不存在也不需要
  // 独立「文字模板烧制」接口——所有素材统一合成（用户裁决口径）；待把字段接入确认合成请求。
  // 2026-09-13 用户裁决：文字模板默认勾选（模板池/命中均由服务端承担，默认开不增本地负担）
  const textFxEnabled = ref(true)
  // 2026-09-14 服务端 /montage/concat 新增 lut_restore（bool，默认 false）：
  // 勾选=恢复旧行为（无显式 LUT 文件时自动抽帧匹配 LUT 库）；默认不勾=不还原 LUT
  const lutRestore = ref(false)
  // 2026-09-14 用户裁决：勾选还原后可选库内具体 LUT（GET /config/luts 清单单选）
  const lutId = ref('')
  const lutList = ref<Array<Record<string, unknown> & { id: string; name: string; kind?: string; description?: string }>>([])
  const lutListLoading = ref(false)
  async function loadLuts(): Promise<void> {
    if (lutListLoading.value) return
    lutListLoading.value = true
    try {
      const res = await window.tintin?.server?.lutList?.()
      lutList.value = res && 'luts' in res && Array.isArray(res.luts)
        ? res.luts.map((x) => ({ ...(x as Record<string, unknown>), id: String(x.id ?? ''), name: String(x.name ?? x.filename ?? x.id ?? '') }))
        : []
    } catch (_) { lutList.value = [] } finally { lutListLoading.value = false }
  }
  watch(lutRestore, (on) => {
    if (on) { void loadLuts() } else { lutId.value = '' } // 取消勾选清空选择
  })
  const textTemplateId = ref('random')
  const textRandomCount = ref(3)
  // 关键词密度档位（2026-09-10 用户裁决：低/中/高；调节后重新提取关键词并重新掷模板）
  const textKeywordDensity = ref('mid')
  const textTemplates = ref<Array<Record<string, unknown> & { template_id: string; name: string }>>([])
  const textTemplatesLoading = ref(false)
  /** 生效模板池（2026-09-10 用户二次裁决：随机数量 N 对应每条视频各自随机选——
   *  池恒为全量库，逐视频在烧制/预览端确定性洗牌取子集；指定模板则池=单模板）。
   *  2026-09-15 用户裁决：随机只从剪映同步模板（jy_ 前缀）中选，内置模板不参与；
   *  无 jy_ 模板时回退全量池（避免随机失效） */
  const activeTextPool = computed(() => {
    if (textTemplateId.value !== 'random') {
      const one = textTemplates.value.find((t) => t.template_id === textTemplateId.value)
      return one ? [one] : []
    }
    const jy = textTemplates.value.filter((t) => String(t.template_id || '').startsWith('jy_'))
    return jy.length ? jy : textTemplates.value
  })
  /** 随机模式生效个数（指定模板=1；每视频从 activeTextPool 独立随机选 N 个） */
  const activeTextCount = computed(() => textTemplateId.value === 'random' ? textRandomCount.value : 1)
  /** 文字模板下拉：首项随机样式（默认）；按 catalog 类目前缀分组平铺（「花字库｜」「文字模板｜」）；
   *  jy_ 前缀=剪映同步。TSelect 无嵌套分组，用前缀承载层级 */
  const CATALOG_LANE_TPL = '/text_templates/templates'
  const catalogTextLanes = ref<Array<{ lane: string; endpoint: string }>>([])
  function catalogLaneIdOf(t: { template_id?: string; description?: string }): string {
    const id = String(t.template_id || '')
    if (!id.startsWith('jy_')) return '内置'
    const m = /原始类目:([^|]+)/.exec(String(t.description || ''))
    return m && /文字模板/.test(m[1]) ? '文字模板' : '花字库'
  }
  const textTemplateOptions = computed(() => {
    const base = [{ label: '随机样式', value: 'random' }]
    if (!catalogTextLanes.value.length) {
      return [...base, ...textTemplates.value.map((t) => ({
        label: String(t.name || t.template_id) + (String(t.template_id).startsWith('jy_') ? '（剪映）' : ''),
        value: t.template_id,
      }))]
    }
    const lanes = [...catalogTextLanes.value.map((l) => l.lane), '内置']
    const out: Array<{ label: string; value: string }> = [...base]
    for (const lane of lanes) {
      for (const t of textTemplates.value) {
        if (catalogLaneIdOf(t) !== lane) continue
        out.push({ label: `${lane}｜${String(t.name || t.template_id)}`, value: String(t.template_id) })
      }
    }
    // 兜底：分类遗漏的模板（不该发生，防丢）
    const inLanes = new Set(out.map((o) => o.value))
    for (const t of textTemplates.value) {
      if (!inLanes.has(String(t.template_id))) out.push({ label: String(t.name || t.template_id), value: String(t.template_id) })
    }
    return out
  })
  async function loadCatalogLanes(): Promise<void> {
    try {
      const res = await window.tintin?.server?.jyTemplatesList?.()
      if (res && 'ok' in res && res.ok) {
        const textGroup = (res.groups || []).find((g) => g.group === '文本')
        catalogTextLanes.value = (textGroup?.lanes || [])
          .filter((l) => l.endpoint === CATALOG_LANE_TPL)
          .map((l) => ({ lane: l.lane, endpoint: l.endpoint }))
      }
    } catch (_) { /* catalog 不可用 → 兜底平铺 */ }
  }
  /** 按密度档位从口播文案提取卖点词（2026-09-11 起仅剩一个消费者：剪映导出随行
   *  特效——效果预览与本地合成均已改走服务端 /text_templates/match 命中行，服务端
   *  合成不传词表、关键词命中由服务端从字幕完成）。
   *  上限随档位：低=3/中=8/高=12，TEXT_KEYWORD_DENSITY_MAX */
  function extractTextFxWords(): string[] {
    const joined = voiceRows.value.map((r) => r.text).join('\n')
    return [...new Set(extractFancyWordsFromText(
      joined,
      TEXT_KEYWORD_DENSITY_MAX[textKeywordDensity.value] ?? 8,
    ))]
  }
  /** 效果预览：按视频分行时间轴（2026-09-10 用户裁决终态：轨数=上一步确认成片条数
   *  （assemblePlans confirmed 产物，不走 collectCandidates 配音优先口径——
   *  3 条成片只配 1 条音时也必须显示 3 条轨）；轨名列=视频名（用户明确要求显示视频名）；
   *  背景条=视频时长（probeDuration 实测），文案按 voiceRows 行（path 匹配成片）命中
   *  timing.json 真实时间点；无命中行仍保留空轨。异步组装（seq 过期响应丢弃）。
   *  2026-09-11 用户二次裁决：展示层轨名改「第N条」序号（完整视频名留 title 悬停），
   *  数据字段 name 仍为文件名，序号由渲染层按行序生成。
   *  2026-09-11 用户三次裁决：命中数据一律取自服务端 /text_templates/match（合成前自查，
   *  与 /montage/concat 命中模式共用选择逻辑 → 预览所见即合成所做；llm_fill=true 按
   *  合成口径补足；density 档位透传，不传 duration——与合成端同口径由服务端取字幕
   *  末行 t1）；客户端不再本地提取关键词，服务端离线/失败时呈空轨（不造数）。 */
  const textFxPreviewTracks = ref<TextFxTrack[]>([])
  /** Step4 合成候选路径（界面统一联动预览 2026-09-10：右栏预览块数据源；
   *  与 textFxPreviewTracks 同批刷新，另在 enterStep4 主动刷一次不依赖 textFx 开关） */
  const step4Candidates = ref<string[]>([])
  let textFxTrackSeq = 0
  /** 逐视频取服务端 /text_templates/match 命中行（效果预览与本地合成共用同一口径：
   *  rows 由 buildSubtitleRows 组装，density 透传，llm_fill=true 按合成口径保底；
   *  离线/失败 → 空（不造数）。返回 { dur, lines, ok }——dur 供预览轨背景条复用，
   *  ok=false 区分「接口失败」与「合法零命中」（失败不再静默） */
  /** 逐视频命中缓存（2026-09-15：导出剪映草稿构建原生文字模板三件套的数据源——
   *  match textfx_clips 短语+时间+模板 id 的权威结果；fetchTextFxHits 成功/缓存命中
   *  都回填，键=取数时的 videoPath 实参）。lastMatchTemplateIds 记录最近一次 match
   *  的候选模板池：随机模式下导出复用同池查 textFxHitsCache（rows+ids 同键）→
   *  不再二次随机、不再二次请求，与预览/合成所见一致。 */
  const textFxHitsByVideo = new Map<string, Array<{ text: string; start: number; end: number; keywords: string[]; templateId?: string }>>()
  let lastMatchTemplateIds: string[] = []
  /** 导出取命中（2026-09-17 用户裁决「一个按钮一条路」：导出不再依赖服务端 match）：
   *  ① 逐视频缓存命中（预览/合成已预取的 textFxHitsByVideo）→ 直接用——预览所在位置
   *     就是命中位置；② 未命中（跨会话）→ 纯本地现算：关键词（extractTextFxWords 密度
   *     口径）× 字幕行窗口（命中位置=关键词所在行），phrase=命中关键词，
   *     templateId=匹配池轮转。rows 由调用方传入（与字幕/花字同一份行数据）。 */
  function textFxHitsForExport(
    videoPath: string,
    rows: Array<{ text: string; start: number; end: number }>,
  ): Array<{ text: string; start: number; end: number; keywords: string[]; templateId?: string }> {
    const cachedByVideo = textFxHitsByVideo.get(videoPath)
    if (cachedByVideo) return cachedByVideo
    const words = extractTextFxWords()
    const pool = lastMatchTemplateIds.length ? lastMatchTemplateIds : currentMatchTemplateIds()
    const out: Array<{ text: string; start: number; end: number; keywords: string[]; templateId?: string }> = []
    for (const r of rows) {
      for (const w of words) {
        if (!w || !r.text.toLowerCase().includes(w.toLowerCase())) continue
        const templateId = pool.length ? String(pool[out.length % pool.length]) : ''
        out.push({ text: w, start: r.start, end: r.end, keywords: [w], templateId })
      }
    }
    textFxHitsByVideo.set(videoPath, out)
    return out
  }
  async function fetchTextFxHits(
    videoPath: string,
    text: string,
    timingPath: string,
    templateIds: string[] = [],
  ): Promise<{
    dur: number
    lines: Array<{ text: string; start: number; end: number; keywords: string[]; templateId?: string }>
    matchId: string
    ok: boolean
  }> {
    const dur = Number(await window.tintin?.ffmpeg?.probeDuration?.(videoPath).catch?.(() => 0)) || 0
    let timing: Array<{ text: string; start: number; end: number }> = []
    if (timingPath) {
      const res = await window.tintin?.server?.finalReadTiming?.({ timingPath })
      timing = res && 'items' in res ? res.items : []
    }
    const rows = buildSubtitleRows(String(text || '').trim(), timing, dur)
    if (!rows.length) return { dur, lines: [], matchId: '', ok: true }
    // 缓存复用（预览与合成共享同一份命中行+match_id，不再二次调服务端；
    // 密度/模板池/行内容变化 → key 变 → 重取）
    const cacheKey = textFxHitsKey(rows) + '|' + templateIds.join(',')
    const cached = textFxHitsCache.get(cacheKey)
    if (cached) {
      textFxHitsByVideo.set(videoPath, cached.lines)
      return { dur, lines: cached.lines, matchId: cached.matchId, ok: true }
    }
    // 重试口径（2026-09-12 实锤：服务端 match 偶发 500/ECONNRESET，单次失败曾致
    // 本地烧制 textFxHits=0 → 成片无文字模板；400/900ms 退避共 3 次）
    let ok = false
    let matchId = ''
    let lines: Array<{ text: string; start: number; end: number; keywords: string[]; templateId?: string }> = []
    for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
      const res = await window.tintin?.server?.textfxMatchKeywords?.({
        rows,
        density: textKeywordDensity.value,
        llmFill: true,
        templateIds,
      })
      if (res && 'lines' in res && Array.isArray(res.lines)) {
        ok = true
        matchId = String((res as Record<string, unknown>).match_id || '')
        // 2026-09-13 接口对齐：textfx_clips = 服务端按候选模板逐事件指派的权威结果
        // （template_id+text+start+end），本地素材下载/预览直接消费；缺失回退 lines
        const clips = Array.isArray((res as Record<string, unknown>).textfx_clips)
          ? ((res as Record<string, unknown>).textfx_clips as Array<Record<string, unknown>>)
          : []
        if (clips.length) {
          lines = clips
            .filter((c) => c && String(c.template_id || ''))
            .map((c) => ({
              text: String(c.text || ''),
              start: Number(c.start) || 0,
              end: Number(c.end) || 0,
              keywords: [String(c.text || '')],
              templateId: String(c.template_id || ''),
            }))
        } else {
          lines = (res.lines as Array<Record<string, unknown>>)
            .filter((l) => l.selected)
            .map((l) => ({
              text: String(l.text || ''),
              start: Number(l.start) || 0,
              end: Number(l.end) || 0,
              keywords: Array.isArray(l.matched_keywords) ? l.matched_keywords.map((k) => String(k)) : [],
            }))
        }
      } else if (attempt < 3) {
        console.warn(`[textfx] match 第 ${attempt}/3 次失败，重试...`, res)
        await new Promise((r) => setTimeout(r, attempt === 1 ? 400 : 900))
      }
    }
    if (!ok) console.warn('[textfx] match 三次均失败（服务端 500/离线），本次不烧文字模板', videoPath)
    if (ok) {
      textFxHitsCache.set(cacheKey, { lines, matchId }) // 成功才入缓存（失败不污染，下次重取）
      textFxHitsByVideo.set(videoPath, lines)
      if (templateIds.length) lastMatchTemplateIds = templateIds.slice()
    }
    return { dur, lines, matchId, ok }
  }
  /** 命中行缓存（2026-09-12 用户质询：预览已调过 match，合成为何再调——match 的唯一
   *  业务输入就是 rows（文案+时间轴的实际组装结果），不发也不依赖视频文件；rows 已涵盖
   *  「timing.json 优先」与「无 timing 按时长占比估算」两种口径 → 直接以 密度+rows 为 key：
   *  timing 存在时预览/合成 rows 完全一致必命中（不再二次调服务端）；无 timing 时两链
   *  时长不同（源视频 vs 配音后视频）rows 即不同 → 自动重取，避免用源视频时间窗烧配音后
   *  视频的错位。二次调用放大服务端 match 压力正是 500 全灭致文字模板整块消失的诱因） */
  const textFxHitsCache = new Map<string, { lines: Array<{ text: string; start: number; end: number; keywords: string[]; templateId?: string }>; matchId: string }>()
  function textFxHitsKey(rows: Array<{ text: string; start: number; end: number }>): string {
    return `${textKeywordDensity.value}\u0000${JSON.stringify(rows)}`
  }
  /** 当前勾选模板随 match 下发的候选池（与 concat text_template_match_ids 同源）：
   *  随机=当次随机池子集；指定=该模板自身。预览与合成共用 → 同 match_id 同 events */
  function currentMatchTemplateIds(): string[] {
    return textTemplateId.value === 'random'
      ? pickRandomItems(activeTextPool.value, textRandomCount.value).map((t) => String(t.template_id))
      : [textTemplateId.value]
  }
  async function refreshTextFxTracks(): Promise<void> {
    const seq = ++textFxTrackSeq
    if (!textFxEnabled.value) { textFxPreviewTracks.value = []; return }
    // 合成期间跳过预览刷新（2026-09-12）：与本地预取并发连击服务端 match 是 500
    // 诱因之一；合成完成后由 startFinalMix finally 统一重刷
    if (finalBusy.value) return
    const tplNames = activeTextPool.value.map((t) => String(t.name || ''))
    if (!tplNames.length) { textFxPreviewTracks.value = []; return }
    // Step4 右栏候选仍走混音口径（配音优先回退成片），与效果预览轨数据源分离
    void collectCandidates().then((cands) => { if (seq === textFxTrackSeq) step4Candidates.value = cands })
    const outputs = assemblePlans.value
      .map((p) => (p.confirmed && p.outputPath ? p.outputPath : ''))
      .filter(Boolean)
    if (!outputs.length) { textFxPreviewTracks.value = []; return }
    // 逐视频取服务端命中判定（与本地合成同一取数函数 fetchTextFxHits；
    // 离线/失败 → 空轨）；串行取数（2026-09-12：并发连击曾致服务端 match 500）
    const matched: Array<{ name: string; durationSec: number; lines: Array<{ text: string; start: number; end: number; keywords: string[] }> }> = []
    for (const c of outputs) {
      const row = voiceRows.value.find((r) => r.path === c || r.dubbedPath === c)
      const { dur, lines } = await fetchTextFxHits(
        c, String(row?.text || '').trim(), row?.wavPath ? `${row.wavPath}.timing.json` : '',
        currentMatchTemplateIds(),
      )
      matched.push({ name: pathBasename(c), durationSec: dur, lines })
    }
    if (seq !== textFxTrackSeq) return // 过期响应丢弃（连续触发只保留最新）
    // 2026-09-10 用户终裁：轨名列显示视频名（模板名拼接方案废止；name 字段自此=文件名）
    // 2026-09-11 用户二次裁决：展示层改「第N条」序号，见 VideoMontage.vue .textfx-track-name
    // 2026-09-10 用户裁决：词条按命中模板渲染颜色+动画（与样式橱窗 textFxStyleSamples
    //  同源同构，去除 fontSize 只取颜色/渐变；不命中模板的词条走 CSS 默认色）
    textFxPreviewTracks.value = buildTextFxTracks({
      rows: matched,
      tplNames,
      count: activeTextCount.value, // 每视频独立随机选 N 个（2026-09-10 用户二次裁决）
    })
    // 2026-09-15 用户裁决：词条=纯关键词标记（哪些词/哪个位置），不再拉 render-preview
    // 动画片段——那是近似物（默认字体+CSS 动画，实测非模板真值），渲染只在合成时发生
  }
  // 2026-09-11：match 含 LLM 补足（服务端 15s 内），防抖 800ms 收敛连续触发
  // （旧本地提取为纯计算，可直接同步跑；接入服务端后必须防抖）
  let textFxTracksTimer: ReturnType<typeof setTimeout> | null = null
  watch([textFxEnabled, textTemplateId, textRandomCount, textTemplates, textKeywordDensity, voiceRows, assemblePlans], () => {
    if (textFxTracksTimer) clearTimeout(textFxTracksTimer)
    textFxTracksTimer = setTimeout(() => { void refreshTextFxTracks() }, 800)
  }, { deep: true })
  // 2026-09-11 用户裁决：本地提取词表 → 上传服务端（旧 textfx:keywordsSave 桥）
  // 整链废止——关键词命中在合成请求内由服务端从随请求提交的字幕完成，服务端
  // 不保存待命中的字幕；服务端「全局常用关键词」库不再被客户端覆盖。
  /** 样式预览样本：按命中模板 variables 默认值本地渲染（服务端
   *  /text_templates/templates/{id}/preview 静态预览图 2026-09-10 复测已可用（200 png），
   *  但为单帧静态图无动画，与「文字模板预览要有动画」裁决不符，故预览仍走本地 CSS 动画；
   *  render-preview 动画预览接口实测 500（服务端内部错误，契约缺口已上报）。
   *  从 variables 推导：颜色收集≥2 个做渐变字，fontSize 按比例缩到预览口径） */
  const srvBase = ref('')
  const textFxStyleSamples = computed(() => {
    // 2026-09-15 用户裁决：橱窗只显示剪映同步模板（jy_ 前缀），内置模板不再展示；
    // 随机数量是每条视频各自随机选 N 个，在效果预览/烧制端逐视频应用，不在此处裁剪
    return textTemplates.value
      .filter((t) => String(t.template_id || '').startsWith('jy_'))
      .map((t) => {
      const vars = (t.variables && typeof t.variables === 'object' ? t.variables : {}) as Record<string, { default?: unknown }>
      const colors: string[] = []
      let fontSize = 0
      for (const v of Object.values(vars)) {
        const d = v && typeof v === 'object' ? (v as { default?: unknown }).default : v
        if (typeof d === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(d) && colors.length < 3) colors.push(d)
        if (typeof d === 'number' && d >= 10 && d <= 300) fontSize = Math.max(fontSize, d)
      }
      const text = String((vars.text && typeof vars.text === 'object' ? (vars.text as { default?: unknown }).default : undefined) || t.name || '')
      const size = fontSize ? Math.min(28, Math.max(14, Math.round((fontSize / 72) * 28))) : 20
      // 动画类型：按服务端模板定义对齐（服务端无结构化动画字段，以 id/name 语义
      //  命名 + variables 效果色变量约定动画；2026-09-10 全量对齐 10 个模板）
      // M2a：显式 anim 变量优先（同步 jy_ 模板声明），名称正则兜底
      const varsAnim = vars.anim && typeof vars.anim === 'object' ? String((vars.anim as { default?: unknown }).default || '') : ''
      const key = `${t.template_id || ''}${t.name || ''}`
      const anim = varsAnim || (/bounce|pop|弹/.test(key) ? 'bounce'
        : /flip|翻转/.test(key) ? 'flip'
        : /gradient|渐变/.test(key) ? 'flow'
        : /neon|glow|霓虹/.test(key) ? 'neon'
        : /shimmer|闪|扫/.test(key) ? 'shine'
        : /slide|滑/.test(key) ? 'slide'
        : /typewriter|打字/.test(key) ? 'type'
        : /pulse|zoom|脉冲|缩放/.test(key) ? 'pulse'
        : /fade|淡/.test(key) ? 'fade'
        : 'fade')
      // 效果色：variables 中除主色 color 外的第一个色值（jumpColor/popColor/shine/
      //  glow/pulse/accent/cursorColor/color2 —— 服务端为每个动画模板配的专用色）
      const mainColor = String((vars.color && typeof vars.color === 'object' ? (vars.color as { default?: unknown }).default : '') || '#FFFFFF')
      const effect = colors.find((c) => c.toLowerCase() !== mainColor.toLowerCase()) || mainColor
      const style: Record<string, string> = { fontSize: size + 'px', '--fx-color': effect }
      if (anim === 'flow') {
        // gradient_text：color+color2 双色渐变流动（background-position 循环）
        style.background = `linear-gradient(90deg, ${mainColor}, ${effect}, ${mainColor})`
        style.backgroundSize = '200% 100%'
        style.webkitBackgroundClip = 'text'
        style.backgroundClip = 'text'
        style.color = 'transparent'
      } else if (anim === 'shine') {
        // shimmer 闪光扫过：三段渐变含高光带（高光色用服务端 shine 变量）+ 扫光动画
        style.background = `linear-gradient(110deg, ${mainColor} 35%, ${effect} 50%, ${mainColor} 65%)`
        style.backgroundSize = '300% 100%'
        style.webkitBackgroundClip = 'text'
        style.backgroundClip = 'text'
        style.color = 'transparent'
      } else {
        style.color = mainColor
      }
      // M2a：服务端真实效果预览（上传时自动生成，贴纸+文字合成图）——有则优先用，
      // 无则回退本地近似画法。相对路径需绝对化（file:// origin 下 / 开头路径 404 → 碎图），
      // 基址经 env:serverPing 取一次缓存（ensureSrvBase，loadTextTemplates 时触发）
      const previewUrl = srvAbs(String((t as Record<string, unknown>).preview || ''))
      const previewWebmUrl = srvAbs(String((t as Record<string, unknown>).preview_webm || ''))
      return { id: String(t.template_id), name: String(t.name || t.template_id), text, anim, style, previewUrl, previewWebmUrl }
    })
  })
  /** 服务端基址缓存（预览 URL 绝对化用；loadTextTemplates 时经 env:serverPing 取一次）。
   *  ref 响应式：加载后 textFxStyleSamples 自动重算（修复预览碎图） */
  async function ensureSrvBase(): Promise<void> {
    if (srvBase.value) return
    try {
      const bridge = window.tintin as unknown as { env?: { serverPing?: () => Promise<{ url?: string }> } } | undefined
      const ping = await bridge?.env?.serverPing?.()
      srvBase.value = String(ping?.url || '')
    } catch (_) { /* 无 env 桥（预览环境） */ }
  }
  function srvAbs(p: string): string {
    if (!p || /^https:\/\//.test(p)) return p
    return srvBase.value ? srvBase.value.replace(/\/$/, '') + (p.startsWith('/') ? p : '/' + p) : p
  }
  /** 拉取服务端文字模板库（GET /text_templates/templates，2026-09-10 纠偏；进入 Step4 时调用；空库时下拉仅随机项） */
  async function loadTextTemplates(): Promise<void> {
    if (textTemplatesLoading.value) return
    textTemplatesLoading.value = true
    try {
      const sr = await window.tintin?.server?.textfxServerTemplates?.()
      const items = sr && !('error' in sr) && Array.isArray(sr.templates) ? sr.templates : []
      textTemplates.value = items.filter((t) => t && t.template_id)
      void ensureSrvBase() // 预览 URL 绝对化基址（异步不阻塞下拉）
      void loadCatalogLanes() // 二期：catalog 类目分组（异步不阻塞下拉）
    } catch (_) {
      textTemplates.value = []
    } finally {
      textTemplatesLoading.value = false
    }
  }
  // AI 改写（_show_ai_rewrite_settings：ai_rewrite_temperature 默认 0.5 → 自由度 50%）
  const rewriteTemp = ref(0.5)
  const aiRewriteDlg = ref({ show: false, pct: 50 })
    // TTS 引擎选择与克隆参数（2026-09-09 用户裁决：文案生成设置左边加 TTS 下拉，默认 idexttts，
    //  对齐声音克隆页裁决；duration_factor/emo_text/emo_alpha 契约同 /indextts/tts，克隆时逐条随请求发送）
    const ttsEngine = ref('idexttts')
    const ttsDurationFactor = ref(1.0)   // 语速 0.5~2.0，默认 1.0（对齐 VoiceClone 页）
    const ttsEmoText = ref('')           // 情感文字（空=用样本默认情感）
    const ttsEmoAlpha = ref(0.5)         // 情感强度 0~1，默认 0.5
    // 句间停顿（2026-09-08 服务端新增，毫秒；0=不插标记，句间停顿由模型按标点自然处理）
    const ttsPauseMs = ref(0)
    const cloneParamsDlg = ref({ show: false, factor: 1.0, emo: '', alpha: 0.5, pause: 0 })
  const editDlg = ref({ show: false, index: -1, title: '', content: '', original: '' })
  const voiceBusy = ref(false)
  const rewriteBusy = ref(false)
  // 2026-09-09 用户裁决：配音动作迁 Step4 统一合成（dubBusy/dubbingEnabled/配音弹窗随之移除）

  let offVoiceProgress: (() => void) | null = null
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
        lengthMode: 'video' as const,
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

  /** 文案生成设置弹窗（对照 _show_ai_rewrite_settings：slider 初值 = 当前温度换算） */
  function openRewriteSettings(): void {
    aiRewriteDlg.value = { show: true, pct: Math.round((1.0 - rewriteTemp.value) * 100) }
  }
  function closeRewriteSettings(): void { aiRewriteDlg.value.show = false }
  function saveRewriteSettings(): void {
    rewriteTemp.value = rewriteTemperature(aiRewriteDlg.value.pct)
    aiRewriteDlg.value.show = false
  }

  /** 设置声音克隆弹窗（对齐声音克隆页 IndexTTS 参数：语速/情感/情感强度；保存后克隆时生效。
   *  句间停顿：2026-09-08 服务端新增 ((pause=毫秒)) 标记口径） */
  function openCloneParams(): void {
    cloneParamsDlg.value = { show: true, factor: ttsDurationFactor.value, emo: ttsEmoText.value, alpha: ttsEmoAlpha.value, pause: ttsPauseMs.value }
  }
  function closeCloneParams(): void { cloneParamsDlg.value.show = false }
  function saveCloneParams(): void {
    ttsDurationFactor.value = cloneParamsDlg.value.factor
    ttsEmoText.value = cloneParamsDlg.value.emo
    ttsEmoAlpha.value = cloneParamsDlg.value.alpha
    ttsPauseMs.value = cloneParamsDlg.value.pause
    cloneParamsDlg.value.show = false
  }

  /** 一键AI修改全部文案（对照 _batch_ai_rewrite_scripts + BatchAITextRewriteWorker；
   *  V3 LLM 凭证由服务端持有（用户裁决 2026-08-28）→ 不再检查本地 llm_model 配置） */
  async function batchAiRewrite(): Promise<void> {
    if (rewriteBusy.value) return
    const tasks = voiceRows.value
      .map((r, i) => ({ i, text: r.originalText || r.text.trim() }))
      .filter((t) => t.text)
    if (!tasks.length) { notify('无可改写内容', '当前列表中没有可改写的视频或文案。'); return }
    rewriteBusy.value = true
    statusText.value = '正在调用AI批量修改文案...'
    let failed = 0
    try {
      const system = buildRewriteSystemPrompt(rewriteTemp.value)
      for (let k = 0; k < tasks.length; k++) {
        const t = tasks[k]
        statusText.value = `正在调用AI批量修改文案... (${k + 1}/${tasks.length})`
        try {
          const res = await window.tintin?.server?.llmChat?.({
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: t.text },
            ],
            temperature: rewriteTemp.value,
          })
          const content = String((res as { choices?: Array<{ message?: { content?: string } }> })?.choices?.[0]?.message?.content ?? '')
          if (content) voiceRows.value[t.i].text = cleanRewriteContent(content)
        } catch (_) { failed++ }
      }
      statusText.value = '完成： 一键AI修改全部文案完成！'
      notify('成功', '批量AI文案修改润色完成！')
    } finally {
      rewriteBusy.value = false
    }
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
    voiceTotal = tasks.length; voiceDone = 0; voiceProgress.value = 0
    const channel = nextVoiceChannel()
    try {
      const res = await window.tintin?.server?.voiceCloneBatch?.({
        tasks,
        refAudioPath: refAudioPath.value,
        // 服务端样本库声音（sample:{id} 选中时）：主进程经 audio_url 下载后转 b64 prompt_audio
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
        },
        progressChannel: channel,
      })
      if (!res) throw new Error('主进程不可达')
      if ('error' in res) throw new Error(res.error)
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
    const idxs = voiceRows.value.map((_, i) => i).filter((i) => voiceRows.value[i].text.trim())
    if (!idxs.length) {
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

  onUnmounted(() => {
    abortPolling()
    offVoiceProgress?.(); offVoiceProgress = null
  })

  return {
    // 共享
    serverUrl, polling, activeTaskId, statusText, cancelPolling, stopPolling,
    // Step1 素材解析
    srcVideos, srcDurations, threshold, minSceneLen, imageDuration,
    scenes, scoreFilter, filteredScenes, checkedCount,
    splitBusy, splitError, splitMsg, splitProgress, splitResolution, concatProgress,
    addVideos, selectFolder, onDrop, removeVideo, runSplit,
    updateSceneDesc, previewSourceVideo, previewScene, closePreview, clearSplitCache,
    previewUrl, previewTranscoding, openSplitsDir, splitsDownloading,
    // Step2 镜头重组
    assembleLogic, concatLayout, durationLimit, DURATION_LIMITS, batchCount, recBatchCount,
    concatFps, FPS_OPTIONS, splitFps,
    concatTransition, edgeSpeedup, EDGE_SPEEDUP_OPTIONS, TRANSITIONS,
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
    concatResults,
    // Step3 口播配音（对照 step3_voice_view.py 逐控件）
    voiceDirInput, voicesDir, voiceRows,
    refSamples, selectedRefSample, refAudioPath, refText, selectRefAudio,
    ttsApiUrl, ttsSteps, ttsCfg, ttsSpeedMin, ttsSpeedMax,
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
