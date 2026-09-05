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
import {
  extractTaskObj,
  mapTaskStatus,
  pollPhaseText,
  parseSplitResponse,
  shotsToRows,
  buildConcatPayload,
  extractConcatResultUrl,
  extractSubmitTaskId,
  // Step1 splits 本地缓存（原版 montage_cache 口径）
  safeSourceName,
  normalizeSourceResolution,
  // Step2 镜头重组·预合成方案
  buildPrecomposePlans,
  type PrecomposePlan,
  buildSceneCopyMessages,
  parseLlmCopyResponse,
  assembledRowText,
  copyPreviewText,
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
  VIDEO_EXTS,
  MAX_SOURCE_VIDEOS,
  classifyShotType,
  applyShotLayoutOrder,
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
  parseFancyWords,
  resolveOutMontageDir,
  voiceStatusText,
  voiceStatusClass,
  fmtDur,
  pathBasename,
} from './videoMontageLogic'
import { readCacheDir } from './useSettingsConfig'
import { joinDefaultPath } from './settingsIntegrationLogic'

const POLL_INTERVAL_MS = 3000   // 对照原版轮询周期（_query_single_rh_task L656 同口径）
const POLL_TIMEOUT_MS = 600_000 // 10 分钟上限

function notify(title: string, body: string): void {
  try { window.tintin?.shell?.showNotification?.(title, body) } catch (_) {}
}

/** IpcError 三态分流：null=离线 / {error}=业务与 HTTP 错误 / 正常数据 */
function unwrapIpc<T>(res: T | null | { error: string }, label: string): T {
  if (res === null || res === undefined) {
    throw new Error(`${label}：服务端不可达（OFFLINE），请检查服务端地址与网络`)
  }
  if (typeof res === 'object' && 'error' in (res as Record<string, unknown>)) {
    throw new Error(`${label}：${String((res as Record<string, unknown>).error)}`)
  }
  return res as T
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** Windows 路径拼接（渲染层无 node path；混剪缓存目录专用） */
function joinPath(...parts: string[]): string {
  return parts
    .filter(Boolean)
    .map((s, i) => (i === 0 ? s.replace(/[\\/]+$/, '') : s.replace(/^[\\/]+|[\\/]+$/g, '')))
    .join('\\')
}

/** 轮询通道：unified=GET /tasks/unified/{id}；scheduled=GET /scheduled/tasks/{id}（契约各自指定） */
type PollChannel = 'unified' | 'scheduled'

export function useVideoMontage() {
  // ── 服务端地址（结果相对路径拼绝对 URL；单一地址源 getServerUrl 经 env:serverPing 取回）──
  const serverUrl = ref('')
  async function ensureServerUrl(): Promise<string> {
    if (serverUrl.value) return serverUrl.value
    try {
      const ping = await (window as any).tintin?.env?.serverPing?.()
      serverUrl.value = String(ping?.url || '')
    } catch (_) { /* 预览环境无 env 桥 → 空串，结果按相对路径下载 */ }
    return serverUrl.value
  }

  /** 相对路径 → 绝对 URL（http 原样；无 serverUrl 时保持相对，下载由主进程按 getServerUrl 解析） */
  function toAbsolute(url: string): string {
    const u = String(url || '')
    if (!u || /^https?:\/\//i.test(u)) return u
    return serverUrl.value ? serverUrl.value.replace(/\/$/, '') + u : u
  }

  // ── 共享轮询状态机（同一时刻一个活动任务；超时/失败/取消统一口径）──
  const polling = ref(false)
  const activeTaskId = ref('')
  const statusText = ref('')
  let pollTimer: ReturnType<typeof setInterval> | null = null
  let pollCancelled = false
  let clearBusy: (() => void) | null = null

  function stopPolling(): void {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
    polling.value = false
  }

  function cancelPolling(): void {
    pollCancelled = true
    stopPolling()
    statusText.value = '已取消等待（可重新提交重试）'
    if (clearBusy) { clearBusy(); clearBusy = null }
  }

  function startPolling(opts: {
    id: string
    channel: PollChannel
    onDone: (task: Record<string, unknown>) => void
    onFail: (msg: string) => void
  }): void {
    stopPolling()
    pollCancelled = false
    polling.value = true
    activeTaskId.value = opts.id
    const startedAt = Date.now()
    let inFlight = false
    const tick = async (): Promise<void> => {
      if (inFlight || pollCancelled) return
      inFlight = true
      try {
        const resp = opts.channel === 'unified'
          ? await window.tintin.server.tasksUnifiedItem(opts.id)
          : await window.tintin.server.get<Record<string, unknown>>(
              `/scheduled/tasks/${encodeURIComponent(opts.id)}`)
        if (!resp || (resp as Record<string, unknown>).error) {
          // 单次查询失败/离线不终止轮询（对照原版轮询失败静默重试）
          statusText.value = pollPhaseText(null, (Date.now() - startedAt) / 1000)
          return
        }
        const task = extractTaskObj(resp) as Record<string, any>
        // 错误字段名归一：unified 节点 error_message / scheduled error_msg
        const errCarrier = {
          error_msg: task.error_message || task.error_msg || task.error || task.message || '',
        }
        const info = mapTaskStatus(task.status ?? task.state, errCarrier)
        if (info.phase === 'done') {
          stopPolling()
          opts.onDone((task.result ?? task) as Record<string, unknown>)
        } else if (info.phase === 'failed') {
          stopPolling()
          opts.onFail(info.error)
        } else {
          statusText.value = pollPhaseText(task.progress, (Date.now() - startedAt) / 1000)
          if (Date.now() - startedAt > POLL_TIMEOUT_MS) {
            stopPolling()
            opts.onFail(`轮询超时（${Math.round(POLL_TIMEOUT_MS / 1000)}s），可重新提交重试`)
          }
        }
      } catch (_) {
        // 查询异常保持等待下一拍
      } finally {
        inFlight = false
      }
    }
    void tick()
    pollTimer = setInterval(() => { void tick() }, POLL_INTERVAL_MS)
  }

  // ══ Step1 素材解析（/montage/split，同步）═══════════════════
  const srcVideos = ref<string[]>([])
  const threshold = ref(50)        // 原版 L67 默认 50，范围 10-100（数字越大越不敏感）
  const minSceneLen = ref(0.5)     // 最小镜头秒（原版 L76 默认 0.5，范围 0.1-60）
  const imageDuration = ref(3)     // 精华时长（原版 L85 默认 3；无法分割的视频自动挑出多长的精华片段）
  const scenes = ref<SplitSceneRow[]>([])
  const scoreFilter = ref(0)       // 默认不过滤（0=全部显示；原版 L116 默认 ≥6，用户要求默认不过滤）
  const splitBusy = ref(false)
  const splitError = ref('')
  const splitMsg = ref('')
  /** 画幅列兜底：服务端 shot 未返回 resolution 时，探测第一个源视频全表共用（原版 _probed_resolution 口径） */
  const splitResolution = ref('')

  function addVideos(): void {
    void (async () => {
      const extArr = VIDEO_EXTS.map((e) => e.replace('.', ''))
      const res = await window.tintin.dialog.openFiles({
        title: '选择原始视频素材',
        multi: true,
        filters: [{ name: '视频', extensions: extArr }],
      })
      const remaining = MAX_SOURCE_VIDEOS - srcVideos.value.length
      if (remaining <= 0) { splitError.value = `素材已达上限（${MAX_SOURCE_VIDEOS}）`; return }
      for (const fp of (res || []).slice(0, remaining)) {
        if (fp && !srcVideos.value.includes(fp)) srcVideos.value.push(fp)
      }
    })()
  }

  /** 选择素材文件夹，递归收集内部全部视频文件（对齐 PR#3 allow_dirs + collect_video_files） */
  function selectFolder(): void {
    void (async () => {
      const dir = await window.tintin.dialog.openDir({ title: '选择素材文件夹（自动遍历子文件夹内全部视频）' })
      if (!dir) return
      const remaining = MAX_SOURCE_VIDEOS - srcVideos.value.length
      if (remaining <= 0) { splitError.value = `素材已达上限（${MAX_SOURCE_VIDEOS}）`; return }
      const videos = await window.tintin.dialog.collectVideos({
        root: dir,
        exts: [...VIDEO_EXTS],
        limit: remaining,
      })
      for (const fp of videos) {
        if (fp && !srcVideos.value.includes(fp)) srcVideos.value.push(fp)
      }
      if (!videos.length) splitMsg.value = '所选文件夹内未找到视频文件'
    })()
  }

  /** 拖入：目录递归展开内部全部视频（原版 _expand_dropped_paths 同口径），文件回退原路径。
   *  修旧缺陷：旧实现把拖入的文件夹路径直接 push，后续 /montage/split 传目录会失败 */
  async function onDrop(e: DragEvent): Promise<void> {
    e.preventDefault()
    const files = e.dataTransfer?.files
    if (!files) return
    for (const f of Array.from(files)) {
      const remaining = MAX_SOURCE_VIDEOS - srcVideos.value.length
      if (remaining <= 0) { splitError.value = `素材已达上限（${MAX_SOURCE_VIDEOS}）`; return }
      const p = (f as File & { path?: string }).path
      if (!p) continue
      // 目录→collectVideos 递归展开；文件路径→主进程 isDirectory 检查不通过返回 []，回退原路径
      const expanded = await window.tintin.dialog.collectVideos({
        root: p, exts: [...VIDEO_EXTS], limit: remaining,
      })
      if (expanded.length) {
        for (const fp of expanded) {
          if (fp && !srcVideos.value.includes(fp)) srcVideos.value.push(fp)
        }
      } else if (!srcVideos.value.includes(p)) {
        srcVideos.value.push(p)
      }
    }
  }

  function removeVideo(i: number): void {
    srcVideos.value.splice(i, 1)
  }

  /** 混剪任务缓存索引（原版 _montage_job_id = uuid4hex；本轮分割生成一次） */
  const splitsJobId = ref('')
  const splitsDownloading = ref(false)

  /** 逐个素材调 /montage/split（同步返回 shots[]）；ECONNRESET/ETIMEDOUT 等瞬时断线自动重试 1 次 */
  async function runSplit(): Promise<void> {
    if (!srcVideos.value.length) { splitError.value = '请先选择视频素材'; return }
    splitBusy.value = true
    splitError.value = ''
    splitMsg.value = '正在解析素材…'
    try {
      const rows: SplitSceneRow[] = []
      for (const v of srcVideos.value) {
        const name = v.split(/[\\/]/).pop() || v
        // 瞬时断线（ECONNRESET/ETIMEDOUT）自动重试 1 次，避免误报 OFFLINE
        // 注意：server-proxy 的 isExpectedOfflineError 会把 ECONNRESET 吞为 null，
        // 所以重试条件需检查 null / {error}，不能只靠 catch
        let raw: unknown = null
        let lastErr: unknown = null
        for (let attempt = 0; attempt < 2; attempt++) {
          lastErr = null
          try {
            raw = await window.tintin.server.montageSplit({
              file: { path: v },
              threshold: Number(threshold.value),
              min_scene_len: Number(minSceneLen.value),
              image_duration: Number(imageDuration.value),
              dedup: true,
              analyze: true,
              product_mode: false,
            })
          } catch (e) { lastErr = e }
          // null = IPC 层吞掉了瞬时网络错误（ECONNRESET 等），服务端实际可能在线
          if (raw !== null && raw !== undefined) break
          if (attempt === 0) console.warn(`[split] ${name}: 首次请求失败（null），自动重试…`)
        }
        // 重试后仍为 null 或 catch 到异常 → 抛错
        if (raw === null || raw === undefined) {
          throw lastErr || new Error('服务端不可达（OFFLINE）')
        }
        const res = unwrapIpc(raw as any, '素材解析')
        // 传递 sourcePath 用于景别分类（对齐 PR#3 classify_shot_type）
        const shots = parseSplitResponse(res)
        console.log(`[split] ${name}: ${shots.length} shots, 首个 clipUrl=${shots[0]?.downloadUrl || '(空)'}`)
        rows.push(...shotsToRows(shots, name, v))
        // 原片分辨率：优先服务端 split 响应 source_resolution（对照原版 step1_split_controller
        // L326-328 逐素材覆盖 _source_resolution 的同口径），无则后置本地探测兑底
        const sr = normalizeSourceResolution((res as { source_resolution?: unknown }).source_resolution)
        if (sr) splitResolution.value = sr
      }
      // 全局重编号（多素材时 shotsToRows 每批从 1 起，需统一为连续序号）
      rows.forEach((r, i) => { r.idx = i + 1 })
      scenes.value = rows
      splitMsg.value = rows.length
        ? `解析完成：共 ${rows.length} 个镜头片段`
        : '未解析出镜头片段（可调低分割阈值后重试）'
      // 片段落盘本地 splits 目录（原版分割产物在 .runtime/montage_cache/<job_id>/splits/<短视频名>/；
      // 本端片段在服务端，分割完成后批量下载补齐同一目录结构，供「打开已分割镜头目录」与双击预览）
      if (rows.length) {
        splitsJobId.value = (crypto?.randomUUID?.() || `${Date.now()}_${Math.floor(Math.random() * 1e8)}`).replace(/-/g, '')
        await downloadClipsToSplits()
      }
      // 探测兑底（原版 _detect_and_show_source_resolution L4783-4793：服务端未返回时
      // probe 第一个镜头文件；本端片段已落盘 splits，优先探测片段，源视频兑底）
      if (!splitResolution.value) {
        const firstClip = rows.find((r) => r.clipLocalPath)
        const probeTarget = firstClip?.clipLocalPath || srcVideos.value[0]
        if (probeTarget) {
          void window.tintin.ffmpeg.probe(probeTarget).then((info) => {
            if (Number(info?.width) > 0 && Number(info?.height) > 0 && !splitResolution.value) {
              splitResolution.value = `${Number(info.width)}x${Number(info.height)}`
            }
          }).catch(() => { /* 探测失败画幅列显 — */ })
        }
      }
    } catch (e) {
      splitError.value = errText(e)
      notify('素材解析失败', splitError.value)
    } finally {
      splitBusy.value = false
    }
  }

  const filteredScenes = computed(() => {
    const f = Number(scoreFilter.value) || 0
    return f > 0 ? scenes.value.filter((s) => !s.score || s.score >= f) : scenes.value
  })

  /** 双击画面描述列手动修改（写回行数据；原版 _on_table_cell_changed 会重命名本地片段文件，
   *  本端片段名由服务端固定，仅更新镜头描述供后续编排参考） */
  function updateSceneDesc(idx: number, desc: string): void {
    const row = scenes.value.find((s) => s.idx === idx)
    if (row) row.description = desc.trim()
  }

  /** 素材双击预览：内置 Plyr 播放器弹窗（替代系统播放器） */
  function previewSourceVideo(path: string): void {
    if (!path) return
    previewUrl.value = path
  }

  /** 分割完成后把服务端片段批量下载到本地 splits 目录（并发 4，单个失败不阻断） */
  async function downloadClipsToSplits(): Promise<void> {
    const clips = scenes.value.filter((s) => s.clipUrl)
    if (!clips.length) return
    splitsDownloading.value = true
    let done = 0
    const queue = [...clips]
    const worker = async (): Promise<void> => {
      while (queue.length) {
        const row = queue.shift()
        if (!row) break
        if (!row.clipLocalPath) {
          try {
            await ensureServerUrl()
            const dir = joinPath(await readCacheDir(), 'montage_cache', splitsJobId.value,
              'splits', safeSourceName(row.sourceName))
            const savePath = joinPath(dir, row.name)
            await window.tintin.server.downloadResult(toAbsolute(row.clipUrl), savePath)
            row.clipLocalPath = savePath
          } catch (_) { /* 单个失败不阻断：该片段预览回退内嵌播放 */ }
        }
        done++
        splitMsg.value = `正在下载片段到本地 splits 目录 (${done}/${clips.length})…`
      }
    }
    await Promise.all(Array.from({ length: 4 }, worker))
    splitsDownloading.value = false
    const okCount = scenes.value.filter((s) => s.clipLocalPath).length
    if (okCount) {
      splitMsg.value = `解析完成：共 ${scenes.value.length} 个镜头片段，已缓存 ${okCount} 个到本地 splits 目录`
    } else {
      splitMsg.value = `解析完成：共 ${scenes.value.length} 个镜头片段，本地缓存失败（请检查服务端地址与网络）`
    }
  }

  /** 打开已分割镜头目录（原版 _open_splits_dir L4833：任务缓存存在 → 打开 splits 目录） */
  async function openSplitsDir(): Promise<void> {
    if (!splitsJobId.value) {
      splitMsg.value = '尚未生成分割片段，请先开始智能镜头分割'
      return
    }
    const dir = joinPath(await readCacheDir(), 'montage_cache', splitsJobId.value, 'splits')
    try { window.tintin.shell.openItem(dir) } catch (_) { /* 打开失败静默 */ }
  }

  /** 镜头片段预览：内置 Plyr 播放器弹窗（本地路径 / 服务端 URL 均支持） */
  const previewUrl = ref('')
  function previewScene(row: SplitSceneRow): void {
    if (row.clipLocalPath) {
      previewUrl.value = row.clipLocalPath
      return
    }
    if (!row.clipUrl) return
    void (async () => {
      await ensureServerUrl()
      previewUrl.value = toAbsolute(row.clipUrl)
    })()
  }
  function closePreview(): void { previewUrl.value = '' }

  /** 清空混剪缓存（原版 _clear_montage_cache → clear_montage_cache：删除 montage_cache 下
   *  全部任务目录，不触碰原始素材；本端同口径删本地缓存目录 + 清会话内镜头清单） */
  async function clearSplitCache(): Promise<void> {
    scenes.value = []
    splitResolution.value = ''
    splitError.value = ''
    try {
      const res = await window.tintin.server.clearMontageCache(joinPath(await readCacheDir(), 'montage_cache'))
      splitMsg.value = res && 'error' in res
        ? `已清空镜头清单；本地缓存目录清理失败：${res.error}`
        : '已清空本地混剪缓存（分割片段/成片输出目录），原始素材不受影响'
    } catch (_) {
      splitMsg.value = '已清空本地混剪缓存（镜头清单与解析状态），原始素材与服务端任务不受影响'
    }
    splitsJobId.value = ''
  }

  /** 取消/复位统一清 busy（方案生成 / 确认合成 / 口播文案 / 混音四个异步步） */
  function clearAllBusy(): void {
    concatBusy.value = false
    confirmBusy.value = false
    copyBusy.value = false
    finalBusy.value = false
  }

  // ══ Step2 镜头重组（预合成方案 → 确认合成 → 口播文案；对照 _start_assemble_video/
  //    _confirm_all_precompose/_batch_gen_copy_by_scene 三段行为链）═══
  const assembleLogic = ref('random')      // 排列逻辑（原版 logic_combo 唯一可见项「智能重排」）
  const concatLayout = ref('source')       // 输出画幅（原版 setCurrentIndex(0)=与原视频一致）
  const durationLimit = ref(30)            // 时长限制（原版 10/20/30/40/50 秒，默认 30）
  const DURATION_LIMITS = [10, 20, 30, 40, 50]
  const batchCount = ref(3)                // 生成视频数量（原版 spin 默认 3，随推荐值回写）
  const randomness = ref('medium')         // 混编随机度（原版默认「中 (保留同场景)」，控件隐藏）
  const concatTransition = ref('fade')     // 转场动画（原版默认「模糊」）
  const concatBusy = ref(false)            // 预合成方案生成中
  const confirmBusy = ref(false)           // 确认合成队列执行中
  const copyBusy = ref(false)              // 口播文案生成中
  const concatError = ref('')
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
  
  // 推荐数量 = max(1, 勾选数)//2 夹 1-10，勾选变化时回写 spin（原版 _update_batch_count_recommendation）
  const recBatchCount = computed(() =>
    Math.max(1, Math.min(10, Math.floor(Math.max(1, checkedCount.value) / 2))))
  watch(checkedCount, () => { batchCount.value = recBatchCount.value })
  
  const assemblePlans = ref<PrecomposePlan[]>([])
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
    clearBusy = clearAllBusy
    statusText.value = `正在生成预合成方案（分析 ${checked.length} 个镜头）…`
    // 原版在后台线程做镜头分析避免卡 UI；渲染层用微任务让出当前帧保证状态先渲染
    void Promise.resolve().then(() => {
      try {
        const plans = buildPrecomposePlans({
          clips: checked,
          batchCount: batchCount.value,
          durationLimitSec: Number(durationLimit.value),
          randomness: randomness.value,
          shotTypeOf: (r) => r.shotType || '',
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
        clearBusy = null
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
  
  /** 提交单条 /montage/concat 并轮询至完成，返回成片 URL（原版 MontageConcatServerWorker 同口径）
   *  clip_urls 使用服务端绝对路径（split 返回的 path 字段），文件已在服务端无需上传
   *  clipShotTypes：镜头文件名→景别键（对照原版 L3004-3015 clip_shot_types，仅非空景别收进） */
  async function submitConcatTask(clipUrls: string[], clipShotTypes?: Record<string, string>): Promise<string> {
    await ensureServerUrl()
    // 「与原片一致」分辨率优先级（对照原版 _submit_concat_to_server L2963-2979：
    // ① 服务端 split 响应的原片分辨率 → ② 本地探测第一个镜头 → ③ 兑底 1080x1920）
    let sourceProbe: { width?: number; height?: number } | null = null
    if (concatLayout.value === 'source') {
      const m = /^(\d+)x(\d+)$/.exec(splitResolution.value || '')
      if (m) sourceProbe = { width: Number(m[1]), height: Number(m[2]) }
      if (!sourceProbe) {
        const firstClip = scenes.value.find((c) => c.clipLocalPath)
        const candidates = [firstClip?.clipLocalPath, srcVideos.value[0]].filter(Boolean) as string[]
        for (const p of candidates) {
          try {
            const info = await window.tintin.ffmpeg.probe(p)
            if (Number(info?.width) > 0 && Number(info?.height) > 0) {
              sourceProbe = { width: Number(info.width), height: Number(info.height) }
              break
            }
          } catch (_) { /* 尝试下一个候选 */ }
        }
      }
    }
    const payload = buildConcatPayload({
      clipUrls,
      transition: concatTransition.value,
      layout: concatLayout.value,
      probe: sourceProbe,
      transitionDuration: 0.5,   // 原版 options 固定 transition_duration: 0.5
      fps: 30,
      crf: 23,
      preset: 'superfast',
    })
    // 景别标注随载荷摊平（对照原版 L3004-3015：仅当有非空景别才发送；
    // 服务端只对 clip_shot_types 里 entrance/exit 的片段应用 edge_speedup 加速）
    const stPayload: Record<string, string> = {}
    for (const [k, v] of Object.entries(clipShotTypes || {})) {
      if (v) stPayload[k] = v
    }
    const concatReq: Record<string, unknown> = {
      clip_urls: payload.clip_urls,
      transition: payload.transition,
      transition_duration: payload.transition_duration,
      width: payload.width,
      height: payload.height,
      fps: payload.fps,
      crf: payload.crf,
      preset: payload.preset,
      ...(edgeSpeedup.value !== 1.0 ? { edge_speedup: edgeSpeedup.value } : {}),
      ...(Object.keys(stPayload).length ? { clip_shot_types: JSON.stringify(stPayload) } : {}),
    }
    console.log('[concat] 提交载荷:', JSON.stringify({ ...concatReq, clip_urls: payload.clip_urls?.slice(0, 200) }))
    const res = unwrapIpc(await window.tintin.server.montageConcat(concatReq), '确认合成')
    const id = extractSubmitTaskId(res)
    statusText.value = `确认合成任务已提交：${id}`
    return await new Promise<string>((resolve, reject) => {
      startPolling({
        id,
        channel: 'scheduled',
        onDone: (result) => {
          // result.video_url|url|output_url，缺失回退契约下载端点（worker L134-136/L165）
          resolve(toAbsolute(extractConcatResultUrl(result) || `/montage/concat/result/${id}`))
        },
        onFail: (msg) => reject(new Error(msg)),
      })
    })
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
    try {
      // 景别标注：key = 服务端片段文件名（= clip_url basename，对照原版 os.path.basename(clip)）
      const activeClips = p.clips.filter((_, i) => !p.deletedFlags[i])
      const shotTypes = Object.fromEntries(activeClips.map((c) => [c.name, c.shotType || '']))
      const url = await submitConcatTask(clipUrls, shotTypes)
      const name = `montage_concat_server_${Math.floor(Math.random() * 9000 + 1000)}_1.mp4`
      let localPath = ''
      try {
        localPath = joinPath(await readCacheDir(), 'montage_cache',
          splitsJobId.value || 'session', 'outputs', name)
        await window.tintin.server.downloadResult(url, localPath)
      } catch (_) { /* 落盘失败保留服务端 URL，不影响状态推进 */ }
      p.confirmed = true
      p.outputUrl = url
      p.outputPath = localPath
      p.outputName = localPath ? name : (url.split('/').pop() || name)
    } catch (e) {
      concatError.value = errText(e)
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
    clearBusy = clearAllBusy
    planConfirmQueue.value = unconfirmed
    try {
      while (planConfirmQueue.value.length) {
        const idx = planConfirmQueue.value.shift() as number
        await confirmPlanOne(idx)
      }
      statusText.value = '完成： 预合成已全部确认合成，可生成口播文案或进入下一步'
    } finally {
      confirmBusy.value = false
      clearBusy = null
    }
  }
  
  /** 单条确认合成（预合成列表右键菜单，对照 _confirm_precompose 单条入口） */
  async function confirmPlanSingle(index: number): Promise<void> {
    if (confirmBusy.value) { concatError.value = '当前已有合成任务在执行，请稍候。'; return }
    if (!assemblePlans.value[index] || assemblePlans.value[index].confirmed) return
    concatError.value = ''
    confirmBusy.value = true
    clearBusy = clearAllBusy
    try {
      await confirmPlanOne(index)
      if (assemblePlans.value[index]?.confirmed) {
        statusText.value = `完成： 预合成 ${index + 1} 已确认合成`
      }
    } finally {
      confirmBusy.value = false
      clearBusy = null
    }
  }
  
  // ── 口播文案（对照 _batch_gen_copy_by_scene：产品信息弹窗 → 逐条 SceneCopyWorker）──
  const sharedProductInfo = ref({ brand: '', product: '', model: '', extra: '' })
  const productDlg = ref<{
    show: boolean; target: 'all' | number
    brand: string; product: string; model: string; extra: string
  }>({ show: false, target: 'all', brand: '', product: '', model: '', extra: '' })
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
  
  /** 为单条方案按画面生成口播文案（对照 SceneCopyWorker：镜头描述序列 + 产品背景） */
  async function genCopyForPlan(p: PrecomposePlan): Promise<void> {
    const clips = p.clips.filter((_, i) => !p.deletedFlags[i])
    const descs = clips.map((c) => c.description)
    const totalDur = clips.reduce((a, c) => a + (Number(c.duration) || 0), 0)
    const msgs = buildSceneCopyMessages({
      sceneDescriptions: descs,
      brand: sharedProductInfo.value.brand,
      product: sharedProductInfo.value.product,
      modelName: sharedProductInfo.value.model,
      extra: sharedProductInfo.value.extra,
      totalDuration: totalDur,
    })
    const res = unwrapIpc(await window.tintin.server.llmChat({
      messages: [
        { role: 'system', content: msgs.system },
        { role: 'user', content: msgs.user },
      ],
      temperature: msgs.temperature,
    }), '生成口播文案')
    p.copy = parseLlmCopyResponse(res)
  }
  
  /** 产品信息弹窗「生成」：全空确认后逐条串行生成（对照 _start_batch_copy 队列） */
  async function productDlgGenerate(): Promise<void> {
    const d = productDlg.value
    d.show = false
    sharedProductInfo.value = {
      brand: d.brand.trim(), product: d.product.trim(),
      model: d.model.trim(), extra: d.extra.trim(),
    }
    const info = sharedProductInfo.value
    if (!info.brand && !info.product && !info.model && !info.extra) {
      const go = window.confirm(
        '你没有填写任何产品信息（品牌/产品/型号/卖点）。\n\n' +
        '确定 = 仍然生成（AI 仅根据画面自由发挥，可能不够精准）\n取消 = 返回填写')
      if (!go) return
    }
    const targets = d.target === 'all'
      ? assemblePlans.value.map((p, i) => ({ p, i }))
          .filter((x) => x.p.confirmed && (x.p.outputPath || x.p.outputUrl))
      : [{ p: assemblePlans.value[d.target as number], i: d.target as number }]
    if (!targets.length) return
    copyBusy.value = true
    clearBusy = clearAllBusy
    let ok = 0
    const failures: string[] = []
    try {
      for (let k = 0; k < targets.length; k++) {
        const { p, i } = targets[k]
        statusText.value = `正在按画面生成文案 (${k + 1}/${targets.length})：${p.outputName || `预合成 ${i + 1}`}`
        try {
          await genCopyForPlan(p)
          ok++
        } catch (e) {
          failures.push(`${p.outputName || `预合成 ${i + 1}`}：${errText(e)}`)
        }
      }
    } finally {
      copyBusy.value = false
      clearBusy = null
    }
    if (failures.length) {
      statusText.value = `注意： 批量文案生成完成：成功 ${ok}，失败 ${failures.length}`
      notify('部分失败', `批量按画面生成文案完成。\n成功 ${ok} 个，失败 ${failures.length} 个：\n${failures.join('\n')}`)
    } else {
      statusText.value = ` 已为全部 ${ok} 个视频按画面生成口播文案`
      notify('全部完成', `已根据画面为全部 ${ok} 个组合视频生成口播文案并保存。\n进入下一步「口播配音」会自动载入。`)
    }
  }
  
  /** 双击预合成项：展示完整口播文案（对照 _on_assembled_double_clicked → _view_assembled_copy） */
  function viewPlanCopy(i: number): void {
    const p = assemblePlans.value[i]
    if (!p) return
    if (!p.copy) {
      concatError.value = '该视频尚未生成口播文案。\n\n请点击底部「生成口播文案」按钮，选择产品信息后由 AI 根据画面生成口播文案。'
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

  // ══ Step4 特效包装（对照 step4_final_view.py 逐控件 + _start_final_mix/FinalMixWorker 一比一）══
  const bgmPath = ref('')
  const bgmName = ref('')
  const bgmVolume = ref(100)       // BGM 增益 0-200（原版 slider 默认 100=原音量）
  const finalBusy = ref(false)
  const finalDone = ref(false)     // 三按钮启用开关（原版 btn_open_final_dir 等初始 disabled）
  const finalProgress = ref(-1)    // 混音进度 0-100（-1=隐藏；原版共享 progress_bar 口径）
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
      notify('BGM 生成失败', bgmGenError.value)
    } finally {
      bgmGenBusy.value = false
    }
  }

  /** 生成结果的预览地址（相对路径拼服务端基址） */
  const bgmPreviewUrl = computed(() => toAbsolute(bgmGenUrl.value))

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
   *  已确认合成的本地落盘产物，等价原版 outputs 目录扫描口径） */
  async function collectCandidates(): Promise<string[]> {
    const dubbed = voiceRows.value.map((r) => r.dubbedPath || '').filter(Boolean)
    let outputsFiles: string[] = assemblePlans.value
      .map((p) => (p.outputPath && p.confirmed ? p.outputPath : ''))
      .filter(Boolean)
    if (!dubbed.length && !outputsFiles.length) {
      const dirPath = voiceDirInput.value
      if (dirPath) {
        const res = await window.tintin?.server?.finalCollectOutputs?.({ dirPath })
        if (res && 'files' in res) outputsFiles = res.files || []
      }
    }
    return collectMixCandidates(dubbed, outputsFiles)
  }

  /** 切到第④步：待混音数量 stage 提示（_go_to_step index==3 L388-395 逐字） */
  async function enterStep4(): Promise<void> {
    statusText.value = ''
    finalProgress.value = -1
    try {
      const n = (await collectCandidates()).length
      statusText.value = n > 0
        ? `准备就绪：待混音合成 ${n} 个视频，点击「开始混音合成」`
        : '暂无待合成视频，请先完成「口播配音」'
    } catch (_) { /* 原版 except pass */ }
  }

  /** 开始混音合成（_start_final_mix L4114-4161 一比一；FinalMixWorker 在主进程 final:mix） */
  async function startFinalMix(): Promise<void> {
    if (finalBusy.value) return
    const candidates = await collectCandidates()
    if (!candidates.length) {
      notify('无待合成视频', '未找到待合成的视频。\n请先完成第③步「口播配音」生成配音视频，或确认第②步的排列视频已生成。')
      return
    }
    const outFinalDir = resolveOutFinalDir(candidates[0])
    // 原版 src_name = 第①步素材目录名（folder_path_input basename）；本端取第③步视频输入目录名同语义
    const tasks = buildFinalTasks(candidates, srcDirName(voiceDirInput.value), outFinalDir)
    finalBusy.value = true
    finalDone.value = false
    finalVideoList.value = []
    finalVideoPath.value = ''
    finalProgress.value = 0
    stopBgmPlay()
    const channel = nextVoiceChannel()
    try {
      const res = await window.tintin?.server?.finalMix?.({
        tasks,
        bgmPath: bgmPath.value,
        bgmVolume: bgmVolume.value,
        progressChannel: channel,
      })
      if (!res) throw new Error('主进程不可达')
      if ('error' in res) throw new Error(res.error)
      onMixFinished(res.results)
    } catch (e) {
      onMixError(errText(e))
    } finally {
      finalBusy.value = false
      offVoiceProgress?.(); offVoiceProgress = null
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
    notify('合成错误', `处理过程中发生错误：\n${err}`)
  }

  /** 打开视频输出目录（_open_output_dir：startfile 成片目录） */
  function openFinalDir(): void {
    if (!finalVideoPath.value) return
    const dir = finalVideoPath.value.slice(0, Math.max(finalVideoPath.value.lastIndexOf('\\'), finalVideoPath.value.lastIndexOf('/')))
    try { window.tintin.shell.openItem(dir) } catch (e) { notify('打开失败', errText(e)) }
  }

  /** 一键导出到剪映草稿（_export_to_jianying_draft：选中项默认第一个；单段无转场） */
  async function exportJianyingDraft(): Promise<void> {
    const items = finalVideoList.value
    if (!items.length) { notify('未选中视频', '请先在合成列表中选择一个视频！'); return }
    const idx = finalSelIdx.value >= 0 ? finalSelIdx.value : 0
    const videoPath = items[idx]?.path || ''
    if (!videoPath) {
      notify('文件不存在', `无法定位该视频的物理文件：\n${videoPath}`)
      return
    }
    await doJianyingExport({
      mode: 'single',
      videoPath,
      draftName: `螺丝钉剪辑_${pathBasename(videoPath).replace(/\.[^.]+$/, '')}`,
      successBody: (name) => `混剪工程导出完成！\n\n项目名称：${name}\n\n请直接打开您的电脑「剪映专业版」客户端进行精修编辑。\n系统已为您在资源管理器中定位到该草稿文件夹。`,
    })
  }

  /** 导出全部到时间轴（_export_all_to_jianying_draft：转场沿用第②步下拉，默认 fade） */
  async function exportAllToJianyingDraft(): Promise<void> {
    const paths = finalVideoList.value.map((it) => it.path).filter(Boolean)
    if (!paths.length) { notify('未选中视频', '合成列表为空，请先生成视频！'); return }
    // 逐段找配套 srt（主进程 _find_srt_for_video 同口径）
    const srtPaths: Array<string | null> = []
    for (const p of paths) {
      const r = await window.tintin?.server?.finalFindSrt?.({ videoPath: p })
      srtPaths.push(r && 'srtPath' in r && r.srtPath ? r.srtPath : null)
    }
    const transition = concatTransition.value || 'fade'
    await doJianyingExport({
      mode: 'multi',
      videoPaths: paths,
      srtPaths,
      transitions: transition,
      draftName: `螺丝钉剪辑_多片段时间轴(${paths.length}段)`,
      successBody: (name) => `已将 ${paths.length} 个片段导出为剪映时间轴（转场：${transition}）！\n\n项目名称：${name}\n\n请直接打开您的电脑「剪映专业版」客户端进行精修编辑。\n系统已为您在资源管理器中定位到该草稿文件夹。`,
    })
  }

  /** 剪映导出公共体：BGM/音量随当前选择；成功弹窗逐字 + 打开草稿目录；失败长错误 */
  async function doJianyingExport(base: {
    mode: 'single' | 'multi'
    videoPath?: string
    videoPaths?: string[]
    srtPaths?: Array<string | null>
    transitions?: string
    draftName: string
    successBody: (name: string) => string
  }): Promise<void> {
    const res = await window.tintin?.server?.jianyingExport?.({
      ...base,
      bgmPath: bgmPath.value,
      bgmVolume: bgmVolume.value,
    })
    if (res && res.success) {
      notify('草稿导出成功', base.successBody(base.draftName))
      try { window.tintin.shell.openItem(res.message) } catch (_) {}
    } else {
      notify('导出失败', `导出剪映草稿时发生错误：\n${res ? res.message : '主进程不可达'}`)
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
  // VideoDubbingWorker；TTS 直连用户可改 apiUrl，初值跟随 server_url + /voxcpm/tts）──
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
  const refText = ref('')
  // TTS 参数（L114-175；inference_timesteps/cfg_value 存而不用，原版同口径）
  const ttsApiUrl = ref('')
  const ttsSteps = ref(10)
  const ttsCfg = ref(2.0)
  const ttsSpeedMin = ref(0.9)
  const ttsSpeedMax = ref(1.2)
  // 字幕/花字（L210-265）
  const addSubtitles = ref(false)
  const subtitleFont = ref('')
  const fontOptions = ref<Array<{ label: string; value: string }>>([{ label: '默认（不指定字体）', value: '' }])
  const fontsLoading = ref(false)
  const fancyEnabled = ref(false)
  const fancyStyle = ref('gold')
  const fancyWordsInput = ref('')
  // AI 改写（_show_ai_rewrite_settings：ai_rewrite_temperature 默认 0.5 → 自由度 50%）
  const rewriteTemp = ref(0.5)
  const aiRewriteDlg = ref({ show: false, pct: 50 })
  const editDlg = ref({ show: false, index: -1, title: '', content: '', original: '' })
  const dubbedDlg = ref({
    show: false,
    outDir: '',
    items: [] as Array<{ videoPath: string; dubbedPath: string; name: string }>,
  })
  const voiceBusy = ref(false)
  const dubBusy = ref(false)
  const rewriteBusy = ref(false)
  const dubbingEnabled = computed(() => voiceRows.value.some((r) => r.wavPath))

  let offVoiceProgress: (() => void) | null = null
  function nextVoiceChannel(): string {
    const ch = `voice:progress:${(crypto?.randomUUID?.() || `${Date.now()}_${Math.floor(Math.random() * 1e8)}`).replace(/-/g, '')}`
    offVoiceProgress?.(); offVoiceProgress = null
    offVoiceProgress = window.tintin?.server?.onVoiceProgress?.(ch, (d) => {
      if (d.rowIdx !== undefined && d.rowIdx >= 0) {
        const row = voiceRows.value[d.rowIdx]
        if (row) {
          if (d.value !== undefined) row.progress = d.value
          if (d.value !== undefined) row.status = d.value >= 100 ? 'done' : 'generating'
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
    if (url) ttsApiUrl.value = url.replace(/\/$/, '') + '/voxcpm/tts'
  }

  /** 选择视频（对照 _select_voice_video_dir：pick_files 多选 → dir=dirname(首文件)） */
  async function selectVoiceDir(): Promise<void> {
    try {
      const res = await window.tintin?.dialog?.openFiles?.({
        title: '选择需要克隆配音的视频',
        multi: true,
        filters: [{ name: '视频文件', extensions: ['mp4', 'mov', 'avi', 'mkv', 'flv', 'webm', 'm4v'] }, { name: '所有文件', extensions: ['*'] }],
      })
      const paths = res || []
      if (!paths.length) return
      const first = paths[0]
      voiceDirInput.value = first.slice(0, Math.max(first.lastIndexOf('\\'), first.lastIndexOf('/')))
      selectedVoiceFiles.value = paths
      void scanVoiceDir()
    } catch (_) { /* 对话框取消 */ }
  }

  /** 扫描视频目录（对照 _do_scan_voice_video_dir；保留已编辑文案 existing_texts 口径） */
  async function scanVoiceDir(): Promise<void> {
    if (!voiceDirInput.value) { voiceRows.value = []; return }
    try {
      const prevTexts = new Map(voiceRows.value.map((r) => [r.path, r.text]))
      const res = await window.tintin?.server?.voiceScanDir?.({
        dirPath: voiceDirInput.value,
        selectedFiles: selectedVoiceFiles.value,
      })
      if (!res || 'error' in res) throw new Error((res as { error?: string })?.error || '扫描失败')
      voicesDir.value = res.voicesDir || ''
      voiceRows.value = res.files.map((f) => ({
        path: f.path,
        name: f.name,
        text: prevTexts.get(f.path) || f.originalText || '',
        originalText: f.originalText,
        status: f.wavPath ? 'done' : 'pending',
        progress: f.wavPath ? 100 : 0,
        wavPath: f.wavPath,
        lengthMode: 'video' as const,
        durationSec: f.durationSec || 0,
        voiceDurSec: 0,
      }))
    } catch (e) {
      statusText.value = `扫描失败： ${errText(e)}`
    }
  }

  /** 拉取服务端声音样本库（GET /voice/samples，与 VoiceClone 页 loadCatalog 同源） */
  async function loadRefSamples(): Promise<void> {
    try {
      const raw = await window.tintin?.server?.ttsVoicesSamples?.()
      const list = Array.isArray(raw) ? raw : []
      refSamples.value = list.map((s: any) => ({
        id: String(s.id ?? ''),
        name: String(s.name ?? `样本${s.id ?? ''}`),
        url: String(s.audio_url || s.url || ''),
        text: String(s.text || ''),
      }))
    } catch (_) { refSamples.value = [] /* 服务端离线时呈无样本态 */ }
  }
  void loadRefSamples()

  /** 下拉选择：服务端样本（sample:{id}）/ 本地上传（__upload__）/ 空态占位 */
  function selectRefAudio(value: string): void {
    if (value === '__upload__') { void uploadRefAudio(); return }
    if (value.startsWith('sample:')) {
      const s = refSamples.value.find((x) => x.id === value.slice(7))
      if (!s) return
      selectedRefSample.value = { id: s.id, url: s.url }
      refAudioPath.value = ''
      refAudioLabel.value = s.name
      // 对齐 VoiceClone 页 selectSample：自动填充样本参考文字
      if (s.text) refText.value = s.text
    }
  }

  /** 上传参考声音（对照 _select_ref_audio：wav/mp3/m4a，选中后优先于服务端样本） */
  async function uploadRefAudio(): Promise<void> {
    try {
      const p = await window.tintin?.dialog?.openFile?.({
        title: '选择人声克隆样本',
        filters: [{ name: 'Audio Files', extensions: ['wav', 'mp3', 'm4a'] }, { name: 'All Files', extensions: ['*'] }],
      })
      if (!p) return
      selectedRefSample.value = null
      refAudioPath.value = p
      refAudioLabel.value = `本地: ${pathBasename(p)}`
    } catch (_) { /* 取消 */ }
  }

  function playRefAudio(): void {
    // 服务端样本：用 URL 直接播放（相对路径拼 serverUrl）；本地文件：系统播放器
    if (selectedRefSample.value?.url) {
      try {
        const u = selectedRefSample.value.url
        const abs = /^https?:/i.test(u) ? u : (serverUrl.value.replace(/\/$/, '') + (u.startsWith('/') ? u : '/' + u))
        void new Audio(abs).play()
      } catch (_) {}
      return
    }
    if (refAudioPath.value) { try { window.tintin?.shell?.openItem?.(refAudioPath.value) } catch (_) {} }
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
        progressChannel: channel,
      })
      if (!res) throw new Error('主进程不可达')
      if ('error' in res) throw new Error(res.error)
      // 回写已生成 wav（generated_voice_paths 口径）+ 状态
      for (const t of tasks) {
        const wav = res.results[t.videoPath]
        if (wav && voiceRows.value[t.rowIdx]) {
          voiceRows.value[t.rowIdx].wavPath = wav
          voiceRows.value[t.rowIdx].status = 'done'
          voiceRows.value[t.rowIdx].progress = 100
          // 克隆音频时长（voice_audio_durations 口径，行内绿字）
          voiceRows.value[t.rowIdx].voiceDurSec = res.durations?.[t.videoPath] || 0
        } else if (voiceRows.value[t.rowIdx]) {
          voiceRows.value[t.rowIdx].status = 'pending'
          voiceRows.value[t.rowIdx].progress = 0
        }
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
    if (!refAudioPath.value) {
      notify('未上传声音样本', '请先上传/选择参考声音样本 (wav/mp3)！')
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

  /** 开始给视频配音（替换原声）（对照 _start_dubbing_videos 逐字） */
  async function startDubVideos(): Promise<void> {
    if (dubBusy.value) return
    if (!voiceDirInput.value) { notify('路径无效', '请选择有效的视频输入目录。'); return }
    const dubbedDir = joinPath(resolveOutMontageDir(voiceDirInput.value), 'dubbed')
    const tasks = voiceRows.value
      .filter((r) => r.wavPath && r.path)
      .map((r) => ({
        videoPath: r.path,
        voiceWavPath: r.wavPath,
        outVideoPath: joinPath(dubbedDir, `dubbed_${r.name}`),
        text: r.text.trim(),
      }))
    if (!tasks.length) {
      notify('缺少音频', '尚未生成任何对应的克隆人声音频。请先点击“开始批量克隆人声合成”进行合成。')
      return
    }
    dubBusy.value = true
    const channel = nextVoiceChannel()
    try {
      const res = await window.tintin?.server?.voiceDubVideos?.({
        tasks,
        addSubtitles: addSubtitles.value,
        lengthModes: Object.fromEntries(voiceRows.value.map((r) => [r.path, r.lengthMode])),
        fancyText: fancyEnabled.value,
        fancyStyle: fancyStyle.value,
        fancyWords: fancyEnabled.value ? parseFancyWords(fancyWordsInput.value) : [],
        subtitleFont: addSubtitles.value ? selectedFontFamily() : '',
        progressChannel: channel,
      })
      if (!res) throw new Error('主进程不可达')
      if ('error' in res) throw new Error(res.error)
      // 回写配音后视频（dubbed_video_paths 口径）
      const items: Array<{ videoPath: string; dubbedPath: string; name: string }> = []
      for (const [vid, dubbed] of Object.entries(res.results)) {
        const row = voiceRows.value.find((r) => r.path === vid)
        if (row) row.dubbedPath = dubbed
        items.push({ videoPath: vid, dubbedPath: dubbed, name: pathBasename(dubbed) })
      }
      statusText.value = '完成： 替换视频原声配音完成！'
      // DubbedVideosDialog（dialogs.py L167-230：标题/header/保存目录/列表）
      dubbedDlg.value = {
        show: true,
        outDir: items.length ? items[0].dubbedPath.slice(0, Math.max(items[0].dubbedPath.lastIndexOf('\\'), 0)) : '',
        items,
      }
    } catch (e) {
      statusText.value = '失败： 配音替换失败'
      notify('配音替换错误', `替换配音过程中发生错误：\n${errText(e)}`)
    } finally {
      dubBusy.value = false
      offVoiceProgress?.(); offVoiceProgress = null
    }
  }

  /** 选定字体族名（对照 _selected_subtitle_font：itemData 空 → 未指定） */
  function selectedFontFamily(): string {
    const opt = fontOptions.value.find((o) => o.value === subtitleFont.value)
    return opt ? opt.value : ''
  }

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
        const label = seen.has(family) && f.filename ? `${family}（${f.filename}）` : family
        seen.add(family)
        items.push({ label, value: fid })
      }
      fontOptions.value = items
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
      notify('导出失败', errText(e))
    }
  }

  /** 播放克隆的声音（对照 _on_btn_play_clicked → _play_audio） */
  function playVoice(index: number): void {
    const row = voiceRows.value[index]
    if (row?.wavPath) { try { window.tintin?.shell?.openItem?.(row.wavPath) } catch (_) {} }
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
    pollCancelled = true
    stopPolling()
    offVoiceProgress?.(); offVoiceProgress = null
  })

  return {
    // 共享
    serverUrl, polling, activeTaskId, statusText, cancelPolling, stopPolling,
    // Step1 素材解析
    srcVideos, threshold, minSceneLen, imageDuration,
    scenes, scoreFilter, filteredScenes, checkedCount,
    splitBusy, splitError, splitMsg, splitResolution,
    addVideos, selectFolder, onDrop, removeVideo, runSplit,
    updateSceneDesc, previewSourceVideo, previewScene, closePreview, clearSplitCache,
    previewUrl, openSplitsDir, splitsDownloading,
    // Step2 镜头重组
    assembleLogic, concatLayout, durationLimit, DURATION_LIMITS, batchCount, recBatchCount,
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
    fancyEnabled, fancyStyle, fancyWordsInput, FANCY_STYLE_OPTIONS, AI_REWRITE_DESC,
    aiRewriteDlg, openRewriteSettings, closeRewriteSettings, saveRewriteSettings,
    editDlg, openEditDlg, saveEditDlg,
    dubbedDlg,
    rewriteTemp,
    voiceBusy, dubBusy, rewriteBusy, dubbingEnabled,
    selectVoiceDir, scanVoiceDir, uploadRefAudio, playRefAudio,
    batchAiRewrite, startSynthesizeVoice, startDubVideos,
    regenVoice, exportVoice, playVoice, playRowVideo, playDubbedVideo,
    toggleLengthMode, lengthModeTip,
    voiceStatusText, voiceStatusClass, fmtDur, pathBasename,
    // Step4 特效包装
    bgmPath, bgmName, bgmVolume, finalBusy, finalDone, finalProgress,
    finalVideoList, finalVideoPath, finalSelIdx, finalPreviewUrl, finalPreviewTitle,
    bgmSource, bgmGenPrompt, bgmGenStyle, bgmGenDuration,
    bgmGenBusy, bgmGenError, bgmGenUrl, bgmGenMeta, bgmPreviewUrl,
    bgmPlaying, bgmPosMs, bgmDurMs,
    generateBgm,
    pickBgm, toggleBgmPlay, stopBgmPlay, onBgmVolumeInput, seekBgm,
    enterStep4, startFinalMix, openFinalDir,
    exportJianyingDraft, exportAllToJianyingDraft, previewFinalVideo,
    // 景别分类（UI 展示用）
    SHOT_TYPE_LABELS, SHOT_TYPE_COLORS,
  }
}

/** TSelect 选项最小结构（避免组件层依赖方向反转） */
interface SelectOptionLite {
  label: string
  value: SelectOptionLiteValue
}
type SelectOptionLiteValue = string | number
