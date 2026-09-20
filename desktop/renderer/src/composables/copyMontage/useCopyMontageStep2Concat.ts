// ═══════════════════════════════════════════════════════════════
// useCopyMontageStep2Concat.ts — 智能混剪 Step2 镜头重组编排（铁律 10 拆分，2026-09-18）
// 自 useCopyMontage.ts 纯搬迁（IRON-02 五项 checklist；蓝图见
// docs/智能混剪拆分迁移映射_2026-09-18.md §五 Step2）。
// 跨步依赖经 ctx 注入：共享运行时（statusText/ensureServerUrl/toAbsolute/
// startPolling/setClearBusy）+ clearAllBusy（组装层，联动 Step4 finalBusy）+
// Step1 产物（scenes/splitFps/splitResolution/srcVideos/splitsJobId）。
// 机械适配（语义不变）：clearBusy 槽赋值改走 setClearBusy。
// ═══════════════════════════════════════════════════════════════
import { ref, computed, watch } from 'vue'
import type { Ref } from 'vue'
import { clientError } from '../../utils/clientLog'
import { readCacheDir } from '../useSettingsConfig'
import {
  buildConcatPayload,
  resolveConcatFps,
  extractConcatResultUrl,
  extractSubmitTaskId,
  extractTaskObj,
  mapTaskStatus,
  pollPhaseText,
  buildPrecomposePlans,
  planActiveDurationSec,
  buildVoiceoverPayload,
  parseVoiceoverResponse,
  assembledRowText,
  copyPreviewText,
  fmtDur,
  type PrecomposePlan,
  type SplitSceneRow,
} from '../copyMontageLogic'
import { notify, unwrapIpc, errText, joinPath, POLL_INTERVAL_MS, type MontageSharedRuntime } from './context'

/** TSelect 选项最小结构（避免组件层依赖方向反转） */
export interface SelectOptionLite {
  label: string
  value: SelectOptionLiteValue
}
type SelectOptionLiteValue = string | number

export interface MontageStep2Context {
  statusText: Ref<string>
  ensureServerUrl: () => Promise<string>
  toAbsolute: (url: string) => string
  startPolling: MontageSharedRuntime['startPolling']
  setClearBusy: MontageSharedRuntime['setClearBusy']
  clearAllBusy: () => void
  scenes: Ref<SplitSceneRow[]>
  splitFps: Ref<number>
  splitResolution: Ref<string>
  srcVideos: Ref<string[]>
  splitsJobId: Ref<string>
}

export function useCopyMontageStep2Concat(ctx: MontageStep2Context) {
  const { statusText, ensureServerUrl, toAbsolute, startPolling, setClearBusy, clearAllBusy,
    scenes, splitFps, splitResolution, srcVideos, splitsJobId } = ctx

  // ══ Step2 镜头重组（预合成方案 → 确认合成 → 口播文案；对照 _start_assemble_video/
  //    _confirm_all_precompose/_batch_gen_copy_by_scene 三段行为链）═══
  const assembleLogic = ref('random')      // 排列逻辑（原版 logic_combo 唯一可见项「智能重排」）
  const concatLayout = ref('source')       // 输出画幅（原版 setCurrentIndex(0)=与原视频一致）
  // 输出帧率（2026-09-11 用户裁决：加下拉且默认「跟随原片」；旧实现写死 30）
  const concatFps = ref<number | 'source'>('source')
  const durationLimit = ref(30)            // 时长限制（原版 10/20/30/40/50 秒，默认 30）
  const DURATION_LIMITS = [10, 20, 30, 40, 50]
  const batchCount = ref(3)                // 生成视频数量（原版 spin 默认 3，随推荐值回写）
  const randomness = ref('medium')         // 混编随机度（原版默认「中 (保留同场景)」，控件隐藏）
  const concatTransition = ref('fade')     // 转场动画（原版默认「模糊」）
  const concatBusy = ref(false)            // 预合成方案生成中
  const confirmBusy = ref(false)           // 确认合成队列执行中
  const copyBusy = ref(false)              // 口播文案生成中
  const concatError = ref('')
  /** 确认合成进度 0-100（对照原版 montage_concat_server_worker：提交 30/轮询钳 48/完成 100） */
  const concatProgress = ref(0)
  // PR#3 出入场镜头加速倍率（对齐 step2_concat_view.py edge_speedup_combo）
  const edgeSpeedup = ref(1.0)  // 1.0=不加速, 1.2/1.5/2.0/2.5/3.0
  const EDGE_SPEEDUP_OPTIONS = [
    { label: '不加速', value: 1.0 },
    { label: '1.2 倍', value: 1.2 },
    { label: '1.5 倍', value: 1.5 },
    { label: '2 倍', value: 2.0 },
    { label: '2.5 倍', value: 2.5 },
    { label: '3 倍', value: 3.0 },
  ]

  const TRANSITIONS: Array<SelectOptionLite> = [
    { label: '模糊', value: 'fade' }, { label: '淡入淡出', value: 'dissolve' },
    { label: '左移', value: 'slideleft' }, { label: '右移', value: 'slideright' },
    { label: '上移', value: 'slideup' }, { label: '下移', value: 'slidedown' },
    { label: '推进', value: 'zoomin' }, { label: '拉远', value: 'zoomout' },
  ]

  const checkedCount = computed(() => scenes.value.filter((s) => s.checked).length)

  // 推荐数量 = max(1, 勾选数)//2 夹 1-20，勾选变化时回写 spin（原版 _update_batch_count_recommendation
  //  夹 1-10；2026-09-09 用户裁决：生成视频数量上限扩至 1-20，推荐值同步放宽）
  const recBatchCount = computed(() =>
    Math.max(1, Math.min(20, Math.floor(Math.max(1, checkedCount.value) / 2))))
  watch(checkedCount, () => { batchCount.value = recBatchCount.value })

  const assemblePlans = ref<PrecomposePlan[]>([])
  // 预合成时长列（2026-09-09 用户裁决新增）：已合成行探测成片实际时长（ffmpeg:probeDuration，
  //  resources/bin 无 ffprobe.exe 时主进程回退 ffmpeg -i 解析）；待确认行走镜头时长求和（planDurText）。
  //  watch 用 getter 形式监听确认状态/落盘路径变更（确认合成后 p.confirmed/outputPath 才填充）。
  watch(() => assemblePlans.value.map((p) => `${p.confirmed ? 1 : 0}|${p.outputPath}`).join('\n'), () => {
    for (const p of assemblePlans.value) {
      if (!p.confirmed || !p.outputPath || p.durationSec !== undefined) continue
      p.durationSec = 0 // 占位防重复探测（探测完成回写真实值，0 仍显 —）
      const path = p.outputPath
      void window.tintin.ffmpeg.probeDuration(path).then((d) => {
        const sec = Number(d) || 0
        if (sec > 0 && p.outputPath === path) p.durationSec = sec
      })
    }
  })
  /** 预合成行时长文本：已合成=成片实际时长（探测回写 durationSec）；待确认=未删除镜头时长之和（估计值） */
  function planDurText(p: PrecomposePlan): string {
    if (p.confirmed) return p.durationSec && p.durationSec > 0 ? fmtDur(p.durationSec) : '—'
    return fmtDur(planActiveDurationSec(p))
  }
  const currentPlanIdx = ref(-1)
  const currentPlan = computed(() =>
    currentPlanIdx.value >= 0 ? assemblePlans.value[currentPlanIdx.value] || null : null)
  const hasUnconfirmed = computed(() => assemblePlans.value.some((p) => !p.confirmed))
  const confirmedPaths = computed(() =>
    assemblePlans.value.filter((p) => p.confirmed && (p.outputPath || p.outputUrl)))
  /** Step4 成片来源兼容（原版 _collect_assembled_paths：按列表顺序返回已确认合成的视频路径） */
  const concatResults = computed(() => confirmedPaths.value.map((p) => p.outputPath || p.outputUrl))

  /** 「镜头重组」= 本地生成预合成方案（对照 _start_assemble_video 随机洗牌分支 L2670-2718） */
  function runConcat(): void {
    if (concatBusy.value) return
    const checked = scenes.value.filter((s) => s.checked)
    if (!checked.length) {
      concatError.value = '当前没有勾选任何镜头，无法执行镜头重组。\n可能原因：镜头评分低于筛选阈值，已被自动取消勾选。\n解决方法：在镜头列表中手动勾选镜头，或降低评分筛选阈值后重新过滤。'
      return
    }
    concatError.value = ''
    concatBusy.value = true
    setClearBusy(clearAllBusy)
    statusText.value = `正在生成预合成方案（分析 ${checked.length} 个镜头）…`
    // 原版在后台线程做镜头分析避免卡 UI；渲染层用微任务让出当前帧保证状态先渲染
    void Promise.resolve().then(() => {
      try {
        const plans = buildPrecomposePlans({
          clips: checked,
          batchCount: batchCount.value,
          durationLimitSec: Number(durationLimit.value),
          randomness: randomness.value,
          // 位置编排取行 position（2026-09-09 裁决：入场头/出场尾属位置编排，非景别）
          positionOf: (r) => r.position || '',
        })
        assemblePlans.value = plans
        currentPlanIdx.value = plans.length ? 0 : -1
        if (!plans.length) {
          statusText.value = ''
          concatError.value = '未能生成预合成方案，请检查是否已勾选镜头。'
        } else {
          statusText.value = `完成： 预合成方案已生成：${plans.length} 条，请检查后确认合成`
          notify('预合成完成', `已生成 ${plans.length} 条预合成方案。\n可在下方删除/调序镜头，确认无误后点击「确认合成视频」。`)
          startSeqPreview(0)
        }
      } catch (e) {
        statusText.value = ''
        concatError.value = errText(e)
      } finally {
        concatBusy.value = false
        setClearBusy(null)
      }
    })
  }

  /** 预合成列表行文案（对照 _add_assembled_row L5383-5410：[n] 文件名/镜头数  状态  文案预览） */
  function planRowText(i: number): string {
    const p = assemblePlans.value[i]
    if (!p) return ''
    return assembledRowText({
      index: i,
      clipCount: p.clips.length,
      outputName: p.outputName,
      confirmed: p.confirmed,
      copyPreview: copyPreviewText(p.copy),
    })
  }

  /** 单击选中方案：刷新镜头详情 + 启动序列预览（对照 _on_assembled_item_clicked L6590） */
  function selectPlan(i: number): void {
    if (i < 0 || i >= assemblePlans.value.length) return
    currentPlanIdx.value = i
    startSeqPreview(i)
  }

  // ── 序列预览（原版 QMediaPlayer 序列连播循环；改用 VideoPreview 弹窗 + Plyr 播放）──
  const seqClips = ref<SplitSceneRow[]>([])
  const seqIdx = ref(-1)
  const seqSrc = ref('')

  function setSeqClip(i: number): void {
    if (!seqClips.value.length) { seqIdx.value = -1; seqSrc.value = ''; return }
    const n = seqClips.value.length
    seqIdx.value = ((i % n) + n) % n
    void (async () => {
      await ensureServerUrl()
      const url = toAbsolute(seqClips.value[seqIdx.value].clipUrl)
      seqSrc.value = url
      // 不再设置 previewUrl，避免弹出 VideoPreview 弹窗（播放由右侧内嵌 VideoPlayer 承担）
    })()
  }

  function startSeqPreview(planIdx: number): void {
    const p = assemblePlans.value[planIdx]
    const clips = p ? p.clips.filter((_, i) => !p.deletedFlags[i]) : []
    seqClips.value = clips
    if (clips.length) setSeqClip(0)
    else { seqIdx.value = -1; seqSrc.value = '' }
  }

  /** 播完自动连播下一个（原版 _preview_auto_advance 默认 true 循环；VideoPlayer autoplay 自动播放） */
  function onSeqEnded(): void {
    if (seqClips.value.length > 1) setSeqClip(seqIdx.value + 1)
  }

  // ── 方案内镜头管理（拖动把手调序/右键删除恢复，对照 _on_source_order_changed/_toggle_source_deleted）──
  const detailDragFrom = ref(-1)

  /** 调序/删除后方案作废重合成（对照 _mark_current_plan_dirty L5797） */
  function markPlanDirty(p: PrecomposePlan): void {
    p.confirmed = false
    p.outputUrl = ''
    p.outputName = ''
    p.outputPath = ''
    p.durationSec = undefined // 重合成后时长需重新探测
  }

  function onDetailDragStart(i: number): void { detailDragFrom.value = i }
  function onDetailDragEnd(): void { detailDragFrom.value = -1 }
  function onDetailDrop(i: number): void {
    const from = detailDragFrom.value
    detailDragFrom.value = -1
    const p = currentPlan.value
    if (!p || from < 0 || from === i || i < 0 || i >= p.clips.length) return
    const [clip] = p.clips.splice(from, 1)
    p.clips.splice(i, 0, clip)
    const [flag] = p.deletedFlags.splice(from, 1)
    p.deletedFlags.splice(Math.min(i, p.deletedFlags.length), 0, flag)
    markPlanDirty(p)
    startSeqPreview(currentPlanIdx.value)
  }

  function toggleClipDeleted(row: number): void {
    const p = currentPlan.value
    if (!p || row < 0 || row >= p.clips.length) return
    while (p.deletedFlags.length < p.clips.length) p.deletedFlags.push(false)
    const active = p.deletedFlags.filter((f) => !f).length
    if (!p.deletedFlags[row] && active <= 1) {
      concatError.value = '无法删除：至少保留 1 个有效镜头片段。'
      return
    }
    p.deletedFlags[row] = !p.deletedFlags[row]
    markPlanDirty(p)
    startSeqPreview(currentPlanIdx.value)
  }

  // ── 确认合成（对照 _confirm_all_precompose → _confirm_precompose → _submit_concat_to_server）──
  function planClipUrls(p: PrecomposePlan): string[] {
    // 使用服务端绝对路径 path（resolve_asset 白名单内），文件已在服务端无需上传
    // 原客户端传 files 是因为镜头在它本地；我们走服务端分割流，直接用 split 返回的 path
    return p.clips
      .filter((_, i) => !p.deletedFlags[i])
      .map((s) => s.serverPath || '')
      .filter(Boolean)
  }

  /** 原片帧率保障（2026-09-11 用户裁决：输出帧率默认「跟随原片」）：服务端
   *  source_resolution.fps 优先（在线实测），未给时本地探测兌底；Step1 未拿到时
   *  提交前补探测一次（与画幅选择无关——选 1080x1920 时同样需要知道原片帧率）。 */
  async function ensureSourceFps(): Promise<void> {
    if (splitFps.value > 0) return
    const firstClip = scenes.value.find((c) => c.clipLocalPath)
    const candidates = [firstClip?.clipLocalPath, srcVideos.value[0]].filter(Boolean) as string[]
    for (const p of candidates) {
      try {
        const info = await window.tintin.ffmpeg.probe(p)
        if (Number(info?.fps) > 0) { splitFps.value = Number(info.fps); return }
      } catch (_) { /* 尝试下一个候选 */ }
    }
  }

  /** 提交单条 /montage/concat 并轮询至完成，返回成片 URL（原版 MontageConcatServerWorker 同口径）
   *  clip_urls 使用服务端绝对路径（split 返回的 path 字段），文件已在服务端无需上传
   *  clipShotTypes：镜头文件名→景别键（对照原版 L3004-3015 clip_shot_types，仅非空景别收进）
   *  2026-09-16 用户裁决（服务端反馈）：预合成=纯镜头拼接，不带任何字幕字段——
   *  ① 预合成阶段口播文案尚未生成（流程：预合成方案→确认合成→口播文案），无字幕数据可烧；
   *  ② 字幕/花字/文字模板烧制只在最终合成（Step4 特效包装 serverComposeOne，SRT=口播
   *     timing）发生，此处再开 burn_subtitle 会与 Step4 二次烧制叠加（成片双重字幕）。 */
  async function submitConcatTask(
    clipUrls: string[],
    clipShotTypes?: Record<string, string>,
    localFiles?: string[],
  ): Promise<{ url: string; id: string; newContract: boolean }> {
    await ensureServerUrl()
    // 「与原片一致」分辨率优先级（2026-09-15 用户裁决：画幅基准=分割片段，非原素材——
    // ① splitResolution（逐镜画幅/首个片段探测，Step1 已收口）→ ② 本地探测首个片段 →
    // ③ 探测不到交 layoutSize 兜底 1080x1920（与分割产物同口径）。原素材分辨率不再进画幅链）
    let sourceProbe: { width?: number; height?: number } | null = null
    if (concatLayout.value === 'source') {
      const m = /^(\d+)x(\d+)$/.exec(splitResolution.value || '')
      if (m) sourceProbe = { width: Number(m[1]), height: Number(m[2]) }
      if (!sourceProbe) {
        const firstClip = scenes.value.find((c) => c.clipLocalPath)
        if (firstClip?.clipLocalPath) {
          try {
            const info = await window.tintin.ffmpeg.probe(firstClip.clipLocalPath)
            if (Number(info?.width) > 0 && Number(info?.height) > 0) {
              sourceProbe = { width: Number(info.width), height: Number(info.height) }
              // 帧率同步补探测（Step1 探测失败时走到这里）
              if (Number(info?.fps) > 0 && !splitFps.value) splitFps.value = Number(info.fps)
            }
          } catch (_) { /* 画幅交 layoutSize 兜底 1080x1920 */ }
        }
      }
    }
    // 选「跟随原片」但仍未拿到 fps → 独立补探测（画幅非 source 时上面不跑）
    if (concatFps.value === 'source') await ensureSourceFps()
    const payload = buildConcatPayload({
      clipUrls,
      transition: concatTransition.value,
      layout: concatLayout.value,
      probe: sourceProbe,
      transitionDuration: 0.5,   // 原版 options 固定 transition_duration: 0.5
      // 帧率按 Step2 下拉决定（2026-09-11 用户裁决：旧实现此处写死 fps: 30）——
      // 「跟随原片」用探测到的原片 fps，探测不到由 resolveConcatFps 兑底 30
      fps: resolveConcatFps(concatFps.value, splitFps.value),
      crf: 23,
      preset: 'superfast',
    })
    // 位置标注随载荷摊平（对照原版 L3004-3015：仅当有非空标注才发送；
    // 2026-09-09 裁决：出入场加速按「位置」（entrance/exit）判断而非景别——
    // 服务端只对 clip_shot_types 里 entrance/exit 的片段应用 edge_speedup 加速）
    const stPayload: Record<string, string> = {}
    for (const [k, v] of Object.entries(clipShotTypes || {})) {
      if (v) stPayload[k] = v
    }
    // PR#4 条目10：方案内含本地已裁剪片段时改走本地 files 上传（契约 files/clip_urls
    // 至少一项；全量 files 保序，与原客户端上传本地镜头同一口径——clip_urls 指向的
    // 服务端片段未经裁剪，直接混用会产出未裁剪成片）
    const useLocalFiles = !!(localFiles && localFiles.length && localFiles.length === clipUrls.length)
    const concatReq: Record<string, unknown> = {
      ...(useLocalFiles ? { files: localFiles } : { clip_urls: payload.clip_urls }),
      transition: payload.transition,
      transition_duration: payload.transition_duration,
      width: payload.width,
      height: payload.height,
      fps: payload.fps,
      crf: payload.crf,
      preset: payload.preset,
      ...(edgeSpeedup.value !== 1.0 ? { edge_speedup: edgeSpeedup.value } : {}),
      ...(Object.keys(stPayload).length ? { clip_shot_types: JSON.stringify(stPayload) } : {}),
      // 2026-09-16 用户裁决（服务端反馈）：预合成不烧字幕——不传 burn_subtitle/font_id/
      // subtitle_style/subtitle_srt（字幕烧制只在 Step4 特效包装，见 submitConcatTask 头注）
    }
    console.log('[concat] 提交载荷:', JSON.stringify({ ...concatReq, clip_urls: payload.clip_urls?.slice(0, 200) }))
    const res = unwrapIpc(await window.tintin.server.montageConcat(concatReq), '确认合成')
    const id = extractSubmitTaskId(res)
    // PR#4 条目13：新契约判别（对照 worker L138-142：响应含 queue_position → 任务不注册任务表，
    // 任务表端点查不到或命中历史撞名任务，只能走结果端点直出）
    const newContract = !!res && typeof res === 'object' && 'queue_position' in (res as Record<string, unknown>)
    statusText.value = `确认合成任务已提交：${id}`
    if (newContract) {
      // 新契约：不走任务表轮询，直接回结果端点 URL（未产出 404，由下载/轮询兑底取片）
      return { url: toAbsolute(`/montage/concat/result/${encodeURIComponent(id)}`), id, newContract }
    }
    return await new Promise<{ url: string; id: string; newContract: boolean }>((resolve, reject) => {
      startPolling({
        id,
        channel: 'scheduled',
        onDone: (result) => {
          // result.video_url|url|output_url，缺失回退契约下载端点（worker L134-136/L165）
          resolve({ url: toAbsolute(extractConcatResultUrl(result) || `/montage/concat/result/${id}`), id, newContract })
        },
        onFail: (msg) => reject(new Error(msg)),
      })
    })
  }

  // ── 成片下载 + 完整性校验（PR#4 条目12/13，对照 _download/_validate_downloaded_file/
  // _poll_result_endpoint L224-304）──

  /** 下载成片并做完整性校验（>1KB 且 ffprobe 可读），未通过自动重下 1 次再验（L280-304）：
   *  返回 'ok' | 'no-file'（从未取到文件：HTTP 非 200/空响应）| 'invalid'（取到但损坏，如 moov 缺失） */
  async function downloadFinalChecked(srcUrl: string, localPath: string): Promise<'ok' | 'no-file' | 'invalid'> {
    let hasFile = false
    for (let attempt = 1; attempt <= 2; attempt++) {
      try { await window.tintin.server.downloadResult(srcUrl, localPath) } catch (_) { /* 非 200/网络异常：按未取到处理 */ }
      try {
        const v = await window.tintin.server.montageValidateFinal(localPath)
        if (v && !('error' in v)) {
          hasFile = !!v.hasFile
          if (v.ok) return 'ok'
        }
      } catch (_) { /* 校验失败按未通过处理 */ }
      console.warn(`[montage_concat] 成片完整性校验未通过（第 ${attempt}/2 次）: ${localPath}`)
      // 2026-09-10 实测：服务端 result 端点会返回未写完的截断 mp4（moov 缺失）甚至
      //  200 空体，坏片残留 outputs 会被 Step3 扫描带入配音/合成链，问题延迟到第四步
      //  统一合成才暴露——校验未通过即删，重下也拿不到旧坏文件残留的干扰
      try { await window.tintin.server.montageDeleteBadFinal(localPath) } catch (_) { /* 删失败不阻断 */ }
    }
    return hasFile ? 'invalid' : 'no-file'
  }

  /** 单个 promise 硬性兑底期限：到期未 settle 则返回 fallback（2026-09-08 实测存在
   *  主进程 httpRequest 超时失效、IPC promise 永不 settle 的场景，会把轮询循环
   *  永久的卡死在单发请求上——总超时检查只在两拍之间，永远走不到） */
  function withDeadline<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
    return new Promise<T>((resolve) => {
      let settled = false
      const timer = setTimeout(() => { if (!settled) { settled = true; resolve(fallback) } }, ms)
      p.then(
        (v) => { if (!settled) { settled = true; clearTimeout(timer); resolve(v) } },
        () => { if (!settled) { settled = true; clearTimeout(timer); resolve(fallback) } },
      )
    })
  }

  /** PR#4 条目13：结果端点直取轮询（对照 _poll_result_endpoint L224-239：
   *  GET /montage/concat/result/{id} 未完成 404 → 继续轮，完成 200 直出 mp4 →
   *  落盘 + 完整性校验；总超时兑底（原版 _RESULT_POLL_TIMEOUT 60 分钟，本端兑底路径取 30 分钟）。
   *  偏差修正：原版新契约不注册任务表故不查；本端服务端实测新契约任务也注册任务表
   *  （failed 带 error_msg，结果端点永远 404）→ 每拍穿插查一次任务表，failed 立即终止，
   *  查无任务（404）时回退纯结果端点轮询（对齐原版假设）；轮询期更新状态文案。
   *  每发请求均套硬性兑底期限（下载 > 主进程 600s 超时取 11 分钟；任务表查询 40s），
   *  单发挂死只会损失一拍，循环与总超时始终可达 */
  async function pollResultEndpoint(id: string, localPath: string, timeoutMs = 30 * 60 * 1000): Promise<'ok' | 'no-file' | 'invalid'> {
    const url = toAbsolute(`/montage/concat/result/${encodeURIComponent(id)}`)
    const startedAt = Date.now()
    for (;;) {
      const r = await withDeadline(downloadFinalChecked(url, localPath), 11 * 60 * 1000, 'no-file' as const)
      if (r !== 'no-file') return r
      if (Date.now() - startedAt > timeoutMs) return 'no-file'
      // 穿插任务表状态（新契约本端服务端也注册表）：failed 立即终止报服务端错误
      try {
        const resp = await withDeadline(
          window.tintin.server.get<Record<string, unknown>>(`/scheduled/tasks/${encodeURIComponent(id)}`),
          40 * 1000,
          {} as Record<string, unknown>,
        )
        const task = extractTaskObj(resp) as Record<string, any>
        const errCarrier = { error_msg: task.error_message || task.error_msg || task.error || task.message || '' }
        const info = mapTaskStatus(task.status ?? task.state, errCarrier)
        if (info.phase === 'failed') throw new Error(`服务端合成失败：${info.error}`)
        if (info.phase === 'running') {
          statusText.value = `已提交服务端合成，任务 ID=${id}，正在轮询...（${pollPhaseText(task.progress, (Date.now() - startedAt) / 1000)}）`
        }
      } catch (e) {
        if (e instanceof Error && e.message.startsWith('服务端合成失败')) throw e
        // 查无此任务（404）/离线：对齐原版新契约假设，纯结果端点轮询继续
      }
      await new Promise((res) => setTimeout(res, POLL_INTERVAL_MS))
    }
  }

  /** 单条确认合成（不含队列推进）：成片下载落盘 outputs 目录（原版 download_result 口径） */
  async function confirmPlanOne(index: number): Promise<void> {
    const p = assemblePlans.value[index]
    if (!p) return
    const clipUrls = planClipUrls(p)
    if (!clipUrls.length) {
      concatError.value = '该预合成没有可用镜头（可能都被标记删除），请先在下方镜头列表恢复至少 1 个。'
      return
    }
    console.log(`[concat] 预合成 ${index + 1}，${clipUrls.length} 个镜头（服务端绝对路径）`)
    if (clipUrls.length) console.log('[concat] 示例 clipUrls:', clipUrls.slice(0, 3))
    statusText.value = ` 正在确认合成预合成 ${index + 1}... (剩余 ${planConfirmQueue.value.length} 条待确认)`
    // 确认合成进度（对照原版 montage_concat_server_worker：提交前 30 / 轮询中钳 48 / 完成 100；
    // 本端提交前置 10 以区分上传阶段）
    concatProgress.value = 10
    try {
      // 位置标注随载荷（key = 片段文件名，对照原版 os.path.basename(clip)；裁剪后行名已同步改写；
      // 2026-09-09 裁决：clip_shot_types 语义是出入场位置——服务端仅对 entrance/exit 应用 edge_speedup）
      const activeClips = p.clips.filter((_, i) => !p.deletedFlags[i])
      const shotTypes = Object.fromEntries(activeClips.map((c) => [c.name, c.position || '']))
      // PR#4 条目10：有被裁剪片段且全部活动片段均已本地落盘 → 改走本地 files 上传
      // （顺序与 clipUrls 一致；有片段未落盘时回退 clip_urls，注：该方案内被裁片段
      // 将以服务端未裁剪原件参与合成，属下载失败兑底场景）
      const hasTrimmed = activeClips.some((c) => c.trimmed && c.clipLocalPath)
      const localFiles = hasTrimmed && activeClips.every((c) => c.clipLocalPath)
        ? activeClips.map((c) => c.clipLocalPath as string)
        : undefined
      // 2026-09-16 用户裁决（服务端反馈）：预合成=纯镜头拼接，不随请求传字幕字段——
      // 原实现传 burn_subtitle=true 但预合成阶段无口播文案/SRT（服务端收到空烧制请求）；
      // 字幕数据只在最终合成（Step4 特效包装）随 buildServerFxFields 下发
      const { url, id } = await submitConcatTask(clipUrls, shotTypes, localFiles)
      concatProgress.value = 30
      statusText.value = `已提交服务端合成，任务 ID=${id}，正在轮询...`
      const name = `montage_concat_server_${Math.floor(Math.random() * 9000 + 1000)}_1.mp4`
      // 2026-09-09 治本：落盘目录优先跟随已有确认产物所在目录——确认期间 jobId 可能被重置
      // （清空缓存/重新分割），新产物会落到 session 目录致产物分散（Step3 只显示部分成片的根因）
      const prevConfirmed = assemblePlans.value.find((q) => q !== p && q.confirmed && q.outputPath)
      const outDir = prevConfirmed?.outputPath
        ? prevConfirmed.outputPath.slice(0, Math.max(prevConfirmed.outputPath.lastIndexOf('\\'), prevConfirmed.outputPath.lastIndexOf('/')))
        : joinPath(await readCacheDir(), 'montage_cache', splitsJobId.value || 'session', 'outputs')
      const localPath = joinPath(outDir, name)
      // PR#4 条目12：下载 + 完整性校验（>1KB 且 ffprobe 可读，失败自动重下 1 次）；
      // 同样套硬性兑底期限，防单发请求挂死卡死整个确认流程
      let final = await withDeadline(downloadFinalChecked(url, localPath), 11 * 60 * 1000, 'no-file' as const)
      if (final === 'no-file') {
        // PR#4 条目13：任务表 completed 但成片下载不到 → 极可能历史任务撞名（同类型旧任务
        // 恰好同 ID，其 video_url 指向别的产物或已失效），不据此报错终止；改走 concat
        // 结果端点继续轮询（对照 _consume_unified_task L196-202，原版此降级仅记日志不上 UI），
        // 轮询期进度钳在 48（对照原版 max(30,min(90,30+30*0.6))）
        concatProgress.value = 48
        final = await pollResultEndpoint(id, localPath)
      }
      // 两种失败根因不同，报错文案可区分（对照 _validate_downloaded_file L297-304 逐字）
      if (final === 'no-file') {
        throw new Error('成片下载失败：服务端未返回有效文件（HTTP 非 200 或空响应），通常为任务尚未完成或结果链接失效。请重新执行合成；若反复出现请检查网络/服务端。')
      }
      if (final === 'invalid') {
        throw new Error('下载后的成片无效：文件不完整或损坏（如 moov 缺失，常见于下载中断或服务端产物异常）。请重新执行合成；若反复出现请检查网络/服务端。')
      }
      p.confirmed = true
      p.outputUrl = url
      p.outputPath = localPath
      p.outputName = name
      concatProgress.value = 100
    } catch (e) {
      concatProgress.value = 0
      concatError.value = errText(e)
      clientError('video-montage', `确认合成失败 预合成${index + 1}`, e)
      notify('确认合成失败', `预合成 ${index + 1}：${concatError.value}`)
      planConfirmQueue.value = []
    }
  }

  const planConfirmQueue = ref<number[]>([])

  /** 全部确认合成：逐条串行执行（对照 _confirm_all_precompose → _confirm_next_in_queue） */
  async function confirmAllPrecompose(): Promise<void> {
    if (confirmBusy.value) { concatError.value = '当前已有合成任务在执行，请稍候。'; return }
    const unconfirmed = assemblePlans.value
      .map((p, i) => (p.confirmed ? -1 : i)).filter((i) => i >= 0)
    if (!unconfirmed.length) { concatError.value = '所有预合成均已确认。'; return }
    concatError.value = ''
    confirmBusy.value = true
    setClearBusy(clearAllBusy)
    planConfirmQueue.value = unconfirmed
    try {
      while (planConfirmQueue.value.length) {
        const idx = planConfirmQueue.value.shift() as number
        await confirmPlanOne(idx)
      }
      statusText.value = '完成： 预合成已全部确认合成，可生成口播文案或进入下一步'
    } finally {
      confirmBusy.value = false
      setClearBusy(null)
    }
  }

  /** 单条确认合成（预合成列表右键菜单，对照 _confirm_precompose 单条入口） */
  async function confirmPlanSingle(index: number): Promise<void> {
    if (confirmBusy.value) { concatError.value = '当前已有合成任务在执行，请稍候。'; return }
    if (!assemblePlans.value[index] || assemblePlans.value[index].confirmed) return
    concatError.value = ''
    confirmBusy.value = true
    setClearBusy(clearAllBusy)
    try {
      await confirmPlanOne(index)
      if (assemblePlans.value[index]?.confirmed) {
        statusText.value = `完成： 预合成 ${index + 1} 已确认合成`
      }
    } finally {
      confirmBusy.value = false
      setClearBusy(null)
    }
  }

  // ── 口播文案（2026-09-13 改调 POST /copywriting/voiceover：产品信息弹窗 → 逐条
  //    传 product_desc + duration_s，服务端自持 prompt 按时长控字数；客户端不再拼 prompt）──
  const sharedProductInfo = ref({ brand: '', product: '', model: '', extra: '', keywords: [] as string[] })
  const productDlg = ref<{
    show: boolean; target: 'all' | number
    brand: string; product: string; model: string; extra: string; keywords: string[]
  }>({ show: false, target: 'all', brand: '', product: '', model: '', extra: '', keywords: [] })
  const copyViewDlg = ref({ show: false, title: '', content: '' })

  function openProductDlg(target: 'all' | number): void {
    if (target !== 'all') {
      const p = assemblePlans.value[target]
      if (!p || !p.confirmed || !(p.outputPath || p.outputUrl)) {
        concatError.value = '该预合成还没有生成实际视频文件，请先点击「确认合成视频」。'
        return
      }
    } else if (!confirmedPaths.value.length) {
      concatError.value = '请先点击「镜头重组」生成预合成，并至少确认合成 1 条视频。'
      return
    }
    productDlg.value = { show: true, target, ...sharedProductInfo.value }
  }
  function closeProductDlg(): void { productDlg.value.show = false }

  /** 为单条方案生成口播文案（POST /copywriting/voiceover：product_desc + duration_s） */
  async function genCopyForPlan(p: PrecomposePlan): Promise<void> {
    // 2026-09-20 用户裁决：duration_s 上传「设置的时长」（时长限制，默认 30s），
    // 不再按预合成实际时长（每条方案目标一致；服务端 VoiceoverIn.duration_s=目标时长秒）
    const payload = buildVoiceoverPayload({
      brand: sharedProductInfo.value.brand,
      product: sharedProductInfo.value.product,
      modelName: sharedProductInfo.value.model,
      extra: sharedProductInfo.value.extra,
      totalDuration: durationLimit.value,
    })
    const res = unwrapIpc(await window.tintin.server.copywritingVoiceover(payload), '生成口播文案')
    p.copy = parseVoiceoverResponse(res)
    // 旁车落盘（对照原版 on_ok L7027-7030：写 <成片路径>.txt；Step3 voice:scanDir
    //   按同一约定读原文，不落盘则口播配音页原文恒为空）
    if (p.outputPath) {
      const w = await window.tintin?.liveclip?.writeTextFile?.({
        path: p.outputPath.replace(/\.[^.]+$/, '') + '.txt',
        content: p.copy,
      })
      if (w && 'error' in w && w.error) throw new Error(`写入文案文件失败：${w.error}`)
    }
  }

  /** 产品信息弹窗「生成」：全空确认后逐条串行生成（对照 _start_batch_copy 队列） */
  async function productDlgGenerate(): Promise<void> {
    const d = productDlg.value
    d.show = false
    sharedProductInfo.value = {
      brand: d.brand.trim(), product: d.product.trim(),
      model: d.model.trim(), extra: d.extra.trim(),
      keywords: d.keywords.slice(),
    }
    const info = sharedProductInfo.value
    if (!info.brand && !info.product && !info.model && !info.extra) {
      // 服务端 /copywriting/voiceover 契约：product_desc 必填（缺失 400），不再支持无产品信息自由发挥
      notify('请填写产品信息', '生成口播文案需要至少填写一项产品信息（品牌/产品/型号/卖点）。\n服务端按产品描述 + 目标时长生成文案。')
      return
    }
    const targets = d.target === 'all'
      ? assemblePlans.value.map((p, i) => ({ p, i }))
          .filter((x) => x.p.confirmed && (x.p.outputPath || x.p.outputUrl))
      : [{ p: assemblePlans.value[d.target as number], i: d.target as number }]
    if (!targets.length) return
    copyBusy.value = true
    setClearBusy(clearAllBusy)
    let ok = 0
    const failures: string[] = []
    try {
      for (let k = 0; k < targets.length; k++) {
        const { p, i } = targets[k]
        statusText.value = `正在生成口播文案 (${k + 1}/${targets.length})：${p.outputName || `预合成 ${i + 1}`}`
        try {
          await genCopyForPlan(p)
          ok++
        } catch (e) {
          failures.push(`${p.outputName || `预合成 ${i + 1}`}：${errText(e)}`)
        }
      }
    } finally {
      copyBusy.value = false
      setClearBusy(null)
    }
    if (failures.length) {
      statusText.value = `注意： 批量文案生成完成：成功 ${ok}，失败 ${failures.length}`
      clientError('video-montage', `批量文案生成部分失败 成功${ok}失败${failures.length}`, failures.join('\n'))
      notify('部分失败', `批量口播文案生成完成。\n成功 ${ok} 个，失败 ${failures.length} 个：\n${failures.join('\n')}`)
    } else {
      statusText.value = ` 已为全部 ${ok} 个视频生成口播文案`
      notify('全部完成', `已根据画面为全部 ${ok} 个组合视频生成口播文案并保存。\n进入下一步「口播配音」会自动载入。`)
    }
  }

  /** 双击预合成项：展示完整口播文案（对照 _on_assembled_double_clicked → _view_assembled_copy） */
  function viewPlanCopy(i: number): void {
    const p = assemblePlans.value[i]
    if (!p) return
    if (!p.copy) {
      concatError.value = '该视频尚未生成口播文案。\n\n请点击底部「生成口播文案」按钮，选择产品信息后由 AI 生成口播文案（按产品信息与视频时长）。'
      return
    }
    copyViewDlg.value = { show: true, title: `口播文案 - 预合成 ${i + 1}`, content: p.copy }
  }
  function closeCopyView(): void { copyViewDlg.value.show = false }

  // ── 预合成列表右键菜单（对照 _show_assembled_context_menu L5411-5434）──
  const planMenu = ref({ show: false, x: 0, y: 0, index: -1, hasCopy: false })
  function openPlanMenu(e: MouseEvent, i: number): void {
    const p = assemblePlans.value[i]
    planMenu.value = { show: true, x: e.clientX, y: e.clientY, index: i, hasCopy: !!p?.copy }
  }
  function closePlanMenu(): void { planMenu.value.show = false }

  return {
    // refs / computed
    assembleLogic, concatLayout, concatFps, durationLimit, DURATION_LIMITS,
    batchCount, recBatchCount, randomness,
    concatTransition, concatBusy, confirmBusy, copyBusy, concatError, concatProgress,
    edgeSpeedup, EDGE_SPEEDUP_OPTIONS, TRANSITIONS,
    checkedCount, assemblePlans, currentPlanIdx, currentPlan, hasUnconfirmed,
    confirmedPaths, concatResults, seqClips, seqIdx, seqSrc, detailDragFrom,
    planConfirmQueue, sharedProductInfo, productDlg, copyViewDlg, planMenu,
    // fns
    planDurText, runConcat, planRowText, selectPlan, startSeqPreview, onSeqEnded,
    markPlanDirty, onDetailDragStart, onDetailDragEnd, onDetailDrop, toggleClipDeleted,
    planClipUrls, ensureSourceFps, submitConcatTask, downloadFinalChecked,
    pollResultEndpoint, confirmPlanOne, confirmAllPrecompose, confirmPlanSingle,
    openProductDlg, closeProductDlg, genCopyForPlan, productDlgGenerate,
    viewPlanCopy, closeCopyView, openPlanMenu, closePlanMenu,
  }
}
