// ═══════════════════════════════════════════════════════════════
// useCopyMontageStep4Final.ts — 智能混剪 Step4 特效包装/BGM/剪映导出编排（铁律 10 拆分，2026-09-19）
// 自 useCopyMontage.ts 纯搬迁（IRON-02 五项 checklist；蓝图见
// docs/智能混剪拆分迁移映射_2026-09-18.md §五 Step4）。
// 跨步依赖经 ctx 注入：共享运行时 + Step2（assemblePlans/concatTransition/
//   sharedProductInfo）+ Step1 splitResolution + Step3 全套消费（voiceRows/
//   voiceDirInput/文字模板与花字字幕状态/runDubBatch/nextVoiceChannel 等）+
//   上提 ref（finalBusy/finalProgress/finalDone/finalVideoList/finalVideoPath/
//   step4Candidates）。
// ═══════════════════════════════════════════════════════════════
import { ref, computed, watch } from 'vue'
import type { Ref } from 'vue'
import { clientError } from '../../utils/clientLog'
import { readCacheDir } from '../useSettingsConfig'
import {
  buildBgmGenPayload, parseBgmGenResponse, resolveOutFinalDir, collectMixCandidates,
  srcDirName,
  buildFinalTasks, fmtBgmTime, inputNameFromFinalPath,
  pathBasename,
  resolveOutMontageDir, textFxStyleOf,
  type BgmGenPayload, type PrecomposePlan, type VoiceRow,
} from '../copyMontageLogic'
import { notify, unwrapIpc, errText, joinPath } from './context'
import { useCopyMontageStep3Voice } from './useCopyMontageStep3Voice'
import { useCopyMontageBgmGen } from './useCopyMontageBgmGen'
import { useCopyMontageBgmPlayer } from './useCopyMontageBgmPlayer'

type CopyStep3Api = ReturnType<typeof useCopyMontageStep3Voice>

export interface MontageStep4Context {
  statusText: Ref<string>
  ensureServerUrl: () => Promise<string>
  toAbsolute: (url: string) => string
  assemblePlans: Ref<PrecomposePlan[]>
  concatTransition: Ref<string>
  sharedProductInfo: Ref<{ brand: string; product: string; model: string; extra: string }>
  splitResolution: Ref<string>
  voiceRows: Ref<VoiceRow[]>
  voiceDirInput: Ref<string>
  runDubBatch: CopyStep3Api["runDubBatch"]
  nextVoiceChannel: CopyStep3Api["nextVoiceChannel"]
  loadTextTemplates: CopyStep3Api["loadTextTemplates"]
  refreshTextFxTracks: CopyStep3Api["refreshTextFxTracks"]
  currentMatchTemplateIds: CopyStep3Api["currentMatchTemplateIds"]
  resolveKeywordHits: CopyStep3Api["resolveKeywordHits"]
  scanVoiceDir: CopyStep3Api["scanVoiceDir"]
  activeTextPool: CopyStep3Api["activeTextPool"]
  activeTextCount: CopyStep3Api["activeTextCount"]
  selectedFancyTemplate: CopyStep3Api["selectedFancyTemplate"]
  selectedSubtitlePreset: CopyStep3Api["selectedSubtitlePreset"]
  selectedFontFamily: CopyStep3Api["selectedFontFamily"]
  addSubtitles: Ref<boolean>
  subtitleStyleKey: Ref<string>
  subtitleBgOpacity: Ref<number>
  subtitleAnimKey: Ref<string>
  fancyEnabled: Ref<boolean>
  fancyStyle: Ref<string>
  fancyPosition: Ref<string>
  textFxEnabled: Ref<boolean>
  lutRestore: Ref<boolean>
  lutId: Ref<string>
  textTemplateId: Ref<string>
  textKeywordDensity: Ref<string>
  subtitleFontSize: Ref<number>
  clearVoiceProgressListener: CopyStep3Api["clearVoiceProgressListener"]
  finalBusy: Ref<boolean>
  finalProgress: Ref<number>
  finalDone: Ref<boolean>
  finalVideoList: Ref<Array<{ name: string; path: string }>>
  finalVideoPath: Ref<string>
  step4Candidates: Ref<string[]>
}

export function useCopyMontageStep4Final(ctx: MontageStep4Context) {
  const {
    statusText, ensureServerUrl, toAbsolute, assemblePlans, concatTransition,
    sharedProductInfo, splitResolution, voiceRows, voiceDirInput,
    runDubBatch, nextVoiceChannel, loadTextTemplates, refreshTextFxTracks,
    currentMatchTemplateIds, resolveKeywordHits,
    scanVoiceDir, activeTextPool,
    activeTextCount, selectedFancyTemplate, selectedSubtitlePreset, selectedFontFamily,
    addSubtitles, subtitleStyleKey, subtitleBgOpacity, subtitleAnimKey, fancyEnabled,
    fancyStyle, fancyPosition, textFxEnabled, lutRestore, lutId, textTemplateId,
    textKeywordDensity, subtitleFontSize, clearVoiceProgressListener,
    finalBusy, finalProgress, finalDone, finalVideoList, finalVideoPath, step4Candidates,
  } = ctx

  // ══ Step4 特效包装（对照 step4_final_view.py 逐控件 + _start_final_mix/FinalMixWorker 一比一）══
  // BGM 选择持久化（2026-09-15 用户报障：会话级 ref 重启清空 → 导出时间轴缺 BGM 轨。
  // localStorage 跨会话记忆 bgmPath/bgmVolume，文件被删时导出侧 fs.existsSync 兜底跳过）
  const bgmPath = ref(localStorage.getItem('copy-montage.bgmPath') || '')
  const bgmName = ref('')
  // BGM 增益默认 35%（2026-09-15 用户裁决，原 100；localStorage 记忆用户调整，0=静音为合法值不回退）
  const storedBgmVolume = Number(localStorage.getItem('copy-montage.bgmVolume'))
  const bgmVolume = ref(Number.isFinite(storedBgmVolume) ? storedBgmVolume : 35)
  watch([bgmPath, bgmVolume], () => {
    try {
      localStorage.setItem('copy-montage.bgmPath', bgmPath.value)
      localStorage.setItem('copy-montage.bgmVolume', String(bgmVolume.value))
    } catch (_) { /* 隐私模式等写失败忽略 */ }
  })
  // 2026-09-18 用户裁决：逐视频 BGM 指派（Step4 视频列表每行可单独选 BGM）。
  // 键=候选视频路径（step4Candidates 口径：配音产物 dubbedPath / outputs）；值={path,name}。
  // 未指派的行导出/合成时回退全局 bgmPath。会话级（不持久化：路径跨会话易失效）。
  const rowBgm = ref<Record<string, { path: string; name: string }>>({})
  const finalMode = ref<'' | 'server' | 'local'>('') // 进行中的链路（双按钮独立 loading）
  // 2026-09-16：导出剪映时间轴进度（独立于 finalBusy，导出期间禁用按钮+显示进度条）
  const exportBusy = ref(false)
  const exportProgress = ref(-1)   // 导出进度 0-100（-1=隐藏）
  const exportStage = ref('')      // 导出阶段文案
  // 2026-09-16：导出成功后记录草稿目录路径（供「打开草稿目录」按钮使用）
  const lastExportDraftPath = ref('')
  // 2026-09-18 用户裁决：导出完成提示行（仿声音克隆完成提示形态：状态行「完成：…」），
  // 「打开草稿目录」按钮内嵌该提示（自底部结果区移入）；重导时清空
  const exportDoneMsg = ref('')
  const finalSelIdx = ref(-1)      // 列表选中项（原版 currentItem，默认取第一个）
  const finalPreviewUrl = ref('')  // 右侧内嵌预览（打包后 file:// 源直读本地文件）
  const finalPreviewTitle = ref(' 视频预览')

  // ── AI 生成 BGM（已迁 montage/useCopyMontageBgmGen.ts，铁律 10 纯搬迁）──
  const bgmGen = useCopyMontageBgmGen({ ensureServerUrl, toAbsolute, voiceDirInput, bgmPath, bgmName })
  const {
    bgmSource, bgmGenPrompt, bgmGenStyle, bgmGenDuration, bgmGenBusy, bgmGenError, bgmGenUrl, bgmGenMeta, bgmPreviewUrl, generateBgm, downloadLibraryBgm, applyLibraryBgm,
  } = bgmGen


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

  // ── BGM 试听播放器（已迁 montage/useCopyMontageBgmPlayer.ts，铁律 10 纯搬迁）──
  const bgmPlayer = useCopyMontageBgmPlayer({ bgmPath, bgmVolume })
  const { bgmPlaying, bgmPosMs, bgmDurMs, toggleBgmPlay, stopBgmPlay, onBgmVolumeInput, seekBgm } = bgmPlayer


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
      // fxLines：关键词命中行（2026-09-19 架构：产品资料关联词客户端命中 +
      // LLM 兜底，resolveKeywordHits 产物；素材下载与 drawtext 兜底消费）。
      // matchId 已删除（2026-09-13 引入的 match 响应回执，随 /text_templates/match
      // 下线而作废；服务端 concat 无 match_id 时按其旧口径自行命中）
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
          }
        })
        .filter((x): x is {
          videoPath: string; text: string; timingPath: string; voicePath: string; srtPath: string
          fxLines: Array<{ text: string; start: number; end: number; keywords: string[]; templateId?: string }>
        } => !!x)
      // 文字模板命中预取（2026-09-19 架构：/text_templates/match 删除，客户端不再调用——
      // 命中=产品资料关联关键词（客户端字幕行窗口命中），产品未关联词 → LLM 兜底提词）
      if (textFxEnabled.value && subtitleTexts.length) {
        statusText.value = '正在判定关键词命中...'
        const empty: string[] = []
        for (const st of subtitleTexts) {
          st.fxLines = await resolveKeywordHits(st.text, st.timingPath)
          if (!st.fxLines.length) empty.push(pathBasename(st.videoPath))
        }
        if (empty.length) {
          // 如实透出（不静默产出无文字模板的成片）：零命中=产品未关联词且 LLM 兜底
          // 未提取到可用词，或命中词与文案无交集
          clientError('video-montage', '关键词零命中', `以下视频未命中任何关键词：${empty.join('、')}`)
          notify('文字模板未生效', `以下视频本次合成不含文字模板（无关键词命中：产品未关联关键词且 LLM 兜底未提取到词，或命中词与文案无交集）：\n${empty.join('\n')}`)
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
        try { localStorage.setItem('copy-montage.lastComposeTasks', JSON.stringify(lastComposeTasks.value)) } catch (_) { /* 忽略 */ }
      }
      onMixFinished(res.results)
    } catch (e) {
      onMixError(errText(e))
    } finally {
      finalBusy.value = false
      finalMode.value = ''
    clearVoiceProgressListener()
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
    /** 2026-09-19 用户裁决「统一」：花字轨词源=产品资料关联关键词（与文字模板同源
     *  resolveKeywordHits；产品未关联词时 LLM 兜底提词）——逐视频事件（词+时间点）原样落段 */
    fancyEvents?: Array<Array<{ word: string; startUs: number; durUs: number }>>
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
      // 2026-09-19 模板轨诊断透出（导出器回传 textTpl* 三字段，用户报障「关键词不显示」）：
      // 关键词命中=服务端权威（词+时间点），模板只是渲染样式层——预设缺失时同一命中
      // 已落纯文本段兜底（kwFallbackSegs），只缺原生模板样式，据实告知
      const rxDiag = rx as unknown as { textTplExpected?: boolean; textTplAppended?: number; textTplKwFallbackSegs?: number }
      if (rxDiag.textTplExpected && !rxDiag.textTplAppended) {
        clientError('video-montage', '原生文字模板样式缺席', `预设库查不到命中模板（Text_V2）；纯文本兜底段数=${rxDiag.textTplKwFallbackSegs ?? 0}`)
        if (rxDiag.textTplKwFallbackSegs) {
          tail += '\n⚠️ 原生文字模板在本机剪映预设库（Text_V2）找不到，关键词已按纯色文本样式显示（词与时间点不变，仅模板样式缺席）'
        } else {
          tail += '\n⚠️ 文字模板轨整链缺席：本机剪映预设库（Text_V2）查不到命中模板，且命中窗口均无效'
        }
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
    // 2026-09-19 用户裁决：fxWords（本地词典提取）停发——词源统一=服务端 match
    // （LLM 兜底在服务端），导出链不再携带本地词表
    const subAnim = subtitleAnimKey.value && subtitleAnimKey.value !== 'fade' ? subtitleAnimKey.value : ''
    const out: { fxKinds?: Array<'fancy' | 'tpl'>; textAnim?: string; fancyEffectId?: string; tplEffectId?: string; subAnim?: string } = { fxKinds: kinds }
    if (subAnim) out.subAnim = subAnim
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
      try { return JSON.parse(localStorage.getItem('copy-montage.lastComposeTasks') || '[]') } catch (_) { return [] }
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
  /** 字幕资产（2026-09-19 用户裁决：**字幕单一来源=服务端**）——
   *  声音克隆时主进程已把服务端 whisperx 按文案强制对齐的 SRT 落为
   *  <wav>.aligned.srt；本函数只做资产定位：①服务端对齐 SRT 优先；
   *  ②旧重切段资产缓存；③都没有返回空串（下游回退 buildSrtFromTiming 旧口径）。
   *  客户端不再 LLM 切段/映射/切行（责任界限：字幕由服务端提供）。 */
  async function ensureProcessedSrt(text: string, wavPath: string, candidate: string): Promise<string> {
    try {
      if (!text || !candidate) return ''
      const aligned = wavPath ? wavPath + '.aligned.srt' : ''
      if (aligned) {
        const ex = await window.tintin?.liveclip?.fileExists?.({ path: aligned })
        if (ex?.exists) return aligned
      }
      const dir = await subtitleAssetDir()
      const stem = pathBasename(candidate).replace(/\.[^.]+$/, '')
      const nmIn = inputNameFromFinalPath(candidate)
      for (const nm of [stem, nmIn]) {
        if (!nm) continue
        const hit = joinPath(dir, nm + '.srt')
        const ex = await window.tintin?.liveclip?.fileExists?.({ path: hit })
        if (ex?.exists) return hit
      }
      return ''
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
      // 关键词命中取数（2026-09-19 架构：/text_templates/match 删除，客户端不再调用）：
      // 词源=产品资料关联关键词（产品库选择带回 sharedProductInfo.keywords），客户端
      // 对字幕行窗口命中；产品未关联词 → LLM 兜底提词（/llm/chat/completions）。
      // resolveKeywordHits 内部：timing 读取+行组装+LLM 文案级缓存；串行取数
      //（2026-09-12：并发连击曾致服务端 500 的教训）
      const hits: Array<{ text: string; start: number; end: number; keywords: string[]; templateId?: string }> = []
      if (textFxEnabled.value || fancyEnabled.value) {
        exportStage.value = `关键词命中判定（${i + 1}/${cands.length}）...`
        hits.push(...await resolveKeywordHits(text, timingPath))
      }
      if (textFxEnabled.value) {
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
      // 花字事件=同一命中（词+时间点）原样落段（2026-09-19 用户裁决「统一」）。
      // 原实现：fxWords×行 重匹配且 fancyEvents 组装后从未传给导出器（死变量）——
      // 草稿花字轨此前实际只吃过本地词典，服务端命中从未参与
      if (fancyEnabled.value) {
        fancyEvents.push(hits
          .filter((h) => h.end > h.start)
          .map((h) => ({
            word: h.text,
            startUs: Math.round(h.start * 1e6),
            durUs: Math.round((h.end - h.start) * 1e6),
          })))
      } else {
        fancyEvents.push([])
      }
    }
    // 防御性提示（2026-09-19 用户报障「关键词轨静默变空」）：花字/关键词词源统一=
    // 服务端 match（LLM 兜底在服务端，本地词典兜底已停用）。全空=服务端无命中或
    // match 不可达 → 据实告知不再静默；文字模板命中全空 → 命中判定结果告知
    if (fancyEnabled.value && cands.length && fancyEvents.every((t) => !t.length)) {
      clientError('video-montage', '导出花字轨为空', `候选 ${cands.length} 段均无关键词命中（服务端 match 无命中或不可达）`)
      notify('花字轨无命中', '本次导出花字轨为空：服务端关键词无命中或 match 接口不可达（LLM 兜底在服务端；本地词典兜底已停用）。')
    } else if (textFxEnabled.value && cands.length && textTemplateClips.every((t) => !t.length)) {
      const reason = activeTextPool.value.length
        ? '关键词与文案无命中（可调高「关键词密度」或更换模板池后重试）'
        : '文字模板库为空（进第四步时会自动拉取，若持续为空请检查服务端 /text_templates/templates）'
      clientError('video-montage', '导出关键词轨为空', `候选 ${cands.length} 段均未命中文字模板`)
      notify('无关键词特效', `本次导出未包含关键词/文字模板轨：\n${reason}`)
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
      // 2026-09-19 用户裁决「统一」：花字轨词源=服务端命中（与文字模板同源），逐视频
      // 事件（词+时间点）随导出下发——导出器按事件落段，不再 fxWords×SRT 重匹配
      fancyEvents,
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

  return {
    bgmPath, bgmName, bgmVolume, rowBgm, finalMode, exportBusy, exportProgress, exportStage,
    lastExportDraftPath, exportDoneMsg, finalSelIdx, finalPreviewUrl, finalPreviewTitle,
    bgmSource, bgmGenPrompt, bgmGenStyle, bgmGenDuration, bgmGenBusy, bgmGenError, bgmGenUrl,
    bgmGenMeta, bgmPreviewUrl, bgmPlaying, bgmPosMs, bgmDurMs, lastComposeTasks,
    generateBgm, downloadLibraryBgm, applyLibraryBgm, pickBgm, rowBgmName, setRowBgm,
    clearRowBgm, pickRowBgm, rowBgmForCandidate, collectCandidates, ensureProcessedSrt,
    exportJianyingPackageDraft, enterStep4, startFinalMix, openFinalDir, openExportDraftDir,
    exportAllToJianyingDraft, toggleBgmPlay, stopBgmPlay, onBgmVolumeInput, seekBgm,
    previewFinalVideo,
  }
}