// ═══════════════════════════════════════════════════════════════
// useVideoMontage — 智能混剪·服务端四步链路编排（M8 条目⑥ runner 层）
// 四步（用户验收口径，对照原客户端 gui/video_montage_page.py + gui/montage/*）：
//   1. 素材解析   POST /montage/split（同步返回 shots[]，ServerSplitWorker L121-171）
//   2. BGM 节拍/卡点
//      · 节拍检测 POST /audio/beatmap → 任务 → 轮询 GET /tasks/unified/{id}
//        （契约：客户端轮询 GET /tasks/unified/{id} 取结果；BeatDetectWorker L341-519）
//      · 卡点成片 POST /montage/beat → 任务 → 轮询 /tasks/unified/{id} →
//        GET /montage/result/{task_id}[/{variant}]（BeatVideoGenWorker L526-781）
//   3. AI 编排   POST /montage/concat → 任务 → 轮询 GET /scheduled/tasks/{id} →
//        GET /montage/concat/result/{id}（montage_concat_server_worker L57-165：
//        stc.get_task 轮询 / status completed → result.video_url|url|output_url →
//        download_result 落盘；status failed/error → error_msg 透出）
//   4. 合成      POST /montage/bgm（同步返回 {ok, path, video_url}，契约注明）
// 闭环口径：提交 → 轮询 → 结果下载/打开目录 → 失败重试（复用 useVideoRepair 模式）。
// 纯函数在 videoMontageLogic.ts（parser/builder 层），本文件仅编排（IRON-06/07）。
// ═══════════════════════════════════════════════════════════════

import { ref, computed, onUnmounted } from 'vue'
import {
  extractTaskObj,
  mapTaskStatus,
  pollPhaseText,
  parseSplitResponse,
  shotsToRows,
  buildBeatmapPayload,
  extractBeats,
  extractBeatClips,
  buildBeatPayload,
  extractBeatVariants,
  buildResultUrl,
  buildConcatPayload,
  extractConcatResultUrl,
  extractSubmitTaskId,
  buildBgmPayload,
  extractBgmResult,
  type SplitSceneRow,
  type BeatClip,
} from './videoMontageLogic'

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
  const threshold = ref(27)        // 契约默认 27（1-100 越小越敏感）
  const minSceneLen = ref(0.5)     // 最小镜头秒（契约默认 0.5）
  const imageDuration = ref(3)     // 图片转静态镜头秒
  const scenes = ref<SplitSceneRow[]>([])
  const scoreFilter = ref(0)       // 0=不过滤
  const splitBusy = ref(false)
  const splitError = ref('')
  const splitMsg = ref('')

  function addVideos(): void {
    void (async () => {
      const res = await window.tintin.dialog.openFiles({
        title: '选择原始视频素材',
        multi: true,
        filters: [{ name: '视频', extensions: ['mp4', 'mov', 'avi', 'mkv', 'flv', 'webm', 'm4v'] }],
      })
      for (const fp of res || []) {
        if (fp && !srcVideos.value.includes(fp)) srcVideos.value.push(fp)
      }
    })()
  }

  function onDrop(e: DragEvent): void {
    e.preventDefault()
    const files = e.dataTransfer?.files
    if (!files) return
    for (let i = 0; i < files.length; i++) {
      const p = (files[i] as File & { path?: string }).path
      if (p && !srcVideos.value.includes(p)) srcVideos.value.push(p)
    }
  }

  function removeVideo(i: number): void {
    srcVideos.value.splice(i, 1)
  }

  /** 逐个素材调 /montage/split（同步返回 shots[]），解析失败/离线统一透出（失败重试=重按） */
  async function runSplit(): Promise<void> {
    if (!srcVideos.value.length) { splitError.value = '请先选择视频素材'; return }
    splitBusy.value = true
    splitError.value = ''
    splitMsg.value = '正在解析素材…'
    try {
      const rows: SplitSceneRow[] = []
      for (const v of srcVideos.value) {
        const name = v.split(/[\\/]/).pop() || v
        const res = unwrapIpc(await window.tintin.server.montageSplit({
          file: { path: v },
          threshold: Number(threshold.value),
          min_scene_len: Number(minSceneLen.value),
          image_duration: Number(imageDuration.value),
          dedup: true,
          analyze: true,
          product_mode: false,
        }), '素材解析')
        rows.push(...shotsToRows(parseSplitResponse(res), name))
      }
      scenes.value = rows
      splitMsg.value = rows.length
        ? `解析完成：共 ${rows.length} 个镜头片段`
        : '未解析出镜头片段（可调低分割阈值后重试）'
    } catch (e) {
      splitError.value = errText(e)
      notify('素材解析失败', splitError.value)
    } finally {
      splitBusy.value = false
    }
  }

  const filteredScenes = computed(() => {
    const f = Number(scoreFilter.value) || 0
    return f > 0 ? scenes.value.filter((s) => s.score >= f) : scenes.value
  })

  // ══ Step2 BGM 节拍/卡点（/audio/beatmap + /montage/beat，均异步）═══
  const musicPath = ref('')
  const musicName = ref('')
  const beatError = ref('')
  const beatmapBusy = ref(false)
  const beats = ref<number[]>([])
  const beatClips = ref<BeatClip[]>([])

  function pickMusic(): void {
    void (async () => {
      const res = await window.tintin.dialog.openFile({
        title: '选择背景音乐',
        filters: [{ name: '音频', extensions: ['mp3', 'wav', 'm4a', 'flac', 'ogg'] }],
      })
      if (res) {
        musicPath.value = String(res)
        musicName.value = musicPath.value.split(/[\\/]/).pop() || musicPath.value
        beats.value = []
        beatClips.value = []
      }
    })()
  }

  function clearAllBusy(): void {
    beatmapBusy.value = false
    beatBusy.value = false
    concatBusy.value = false
    finalBusy.value = false
  }

  /** 节拍检测：提交 → /tasks/unified/{id} 轮询 → beats/beat_clips 展示 */
  async function detectBeats(): Promise<void> {
    if (!musicPath.value) { beatError.value = '请先选择 BGM 音乐'; return }
    beatError.value = ''
    beatmapBusy.value = true
    clearBusy = clearAllBusy
    beats.value = []
    beatClips.value = []
    try {
      const bm = buildBeatmapPayload(musicPath.value)
      const res = unwrapIpc(
        await window.tintin.server.audioBeatmap({
          file: { path: bm.file },
          count: bm.count,
          segment_duration: bm.segment_duration,
        }),
        'BGM 节拍检测',
      )
      const id = extractSubmitTaskId(res)
      statusText.value = `节拍检测任务已提交：${id}`
      startPolling({
        id,
        channel: 'unified',
        onDone: (result) => {
          beats.value = extractBeats(result)
          beatClips.value = extractBeatClips(result)
          statusText.value = `节拍检测完成：${beats.value.length} 个节拍 / ${beatClips.value.length} 个卡点片段`
          notify('节拍检测完成', statusText.value)
        },
        onFail: (msg) => {
          beatError.value = msg
          notify('节拍检测失败', `任务 ${id}：${msg}`)
        },
      })
    } catch (e) {
      beatError.value = errText(e)
      notify('节拍检测失败', beatError.value)
    } finally {
      beatmapBusy.value = false
      clearBusy = null
    }
  }

  // 卡点成片参数（契约 Body_beat_compose_montage_beat_post）
  const beatCount = ref(0)            // 0=按切点全用
  const beatTimeLimit = ref(0)        // 0=完整有效区间
  const beatVariantCount = ref(1)     // 1~5
  const beatAspectRatio = ref('9:16')
  const beatTransition = ref('fade')  // 契约直用服务端转场名
  const beatTransitionDuration = ref(0)
  const beatMinDuration = ref(1)
  const beatMaxDuration = ref(3)
  const beatBusy = ref(false)
  const beatVariants = ref<Array<{ variant: number; url: string }>>([])

  /** 卡点成片：music+原始视频 → 服务端分割/卡点/拼接/混音 → 变体结果列表 */
  async function runBeatCompose(): Promise<void> {
    if (!srcVideos.value.length) { beatError.value = '请先在「素材解析」添加视频'; return }
    beatError.value = ''
    beatBusy.value = true
    clearBusy = clearAllBusy
    beatVariants.value = []
    try {
      const p = buildBeatPayload({
        music: musicPath.value,
        videos: srcVideos.value,
        count: beatCount.value,
        timeLimit: beatTimeLimit.value,
        variantCount: beatVariantCount.value,
        aspectRatio: beatAspectRatio.value,
        transition: beatTransition.value,
        transitionDuration: beatTransitionDuration.value,
        minDuration: beatMinDuration.value,
        maxDuration: beatMaxDuration.value,
      })
      const res = unwrapIpc(await window.tintin.server.montageBeat({
        music: { path: p.music },
        videos: p.videos.map((v) => ({ path: v })),
        count: p.count,
        time_limit: p.time_limit,
        variant_count: p.variant_count,
        min_duration: p.min_duration,
        max_duration: p.max_duration,
        aspect_ratio: p.aspect_ratio,
        transition: p.transition,
        transition_duration: p.transition_duration,
      }), '卡点成片')
      const id = extractSubmitTaskId(res)
      statusText.value = `卡点成片任务已提交：${id}`
      startPolling({
        id,
        channel: 'unified',
        onDone: async (result) => {
          await ensureServerUrl()
          beatVariants.value = extractBeatVariants(result).map((v) => ({
            variant: v.variant,
            url: toAbsolute(buildResultUrl(serverUrl.value, id, v.file, v.variant)),
          }))
          statusText.value = `卡点成片完成：${beatVariants.value.length} 个变体`
          notify('卡点成片完成', `任务 ${id}：${beatVariants.value.length} 个变体可下载`)
        },
        onFail: (msg) => {
          beatError.value = msg
          notify('卡点成片失败', `任务 ${id}：${msg}`)
        },
      })
    } catch (e) {
      beatError.value = errText(e)
      notify('卡点成片失败', beatError.value)
    } finally {
      beatBusy.value = false
      clearBusy = null
    }
  }

  // ══ Step3 AI 编排（/montage/concat → /scheduled/tasks/{id} 轮询）═══
  const concatTransition = ref('fade')   // 客户端风格名，提交前经 mapTransition 安全映射
  const concatLayout = ref('vertical')
  const concatTransitionDuration = ref(0)
  const concatBusy = ref(false)
  const concatError = ref('')
  const concatResults = ref<string[]>([])

  const TRANSITIONS: Array<SelectOptionLite> = [
    { label: '模糊', value: 'fade' }, { label: '淡入淡出', value: 'dissolve' },
    { label: '左移', value: 'slideleft' }, { label: '右移', value: 'slideright' },
    { label: '上移', value: 'slideup' }, { label: '下移', value: 'slidedown' },
    { label: '推进', value: 'zoomin' }, { label: '拉远', value: 'zoomout' },
  ]

  const checkedCount = computed(() => scenes.value.filter((s) => s.checked).length)

  /** AI 编排：split 片段 clip_urls 优先（服务端内部流转免二次上传），无则回退本地源文件 */
  async function runConcat(): Promise<void> {
    const checked = scenes.value.filter((s) => s.checked)
    if (!checked.length) { concatError.value = '请先勾选要编排的镜头片段'; return }
    concatError.value = ''
    concatBusy.value = true
    clearBusy = clearAllBusy
    concatResults.value = []
    try {
      await ensureServerUrl()
      const clipUrls = checked
        .map((s) => (s.clipUrl ? toAbsolute(s.clipUrl) : ''))
        .filter(Boolean)
      const payload = buildConcatPayload({
        clipUrls,
        files: clipUrls.length ? [] : srcVideos.value,
        transition: concatTransition.value,
        layout: concatLayout.value,
        transitionDuration: concatTransitionDuration.value || undefined,
      })
      const res = unwrapIpc(await window.tintin.server.montageConcat({
        files: payload.files?.map((f) => ({ path: f })),
        clip_urls: payload.clip_urls,
        transition: payload.transition,
        transition_duration: payload.transition_duration,
        width: payload.width,
        height: payload.height,
        fps: payload.fps,
        crf: payload.crf,
        preset: payload.preset,
        image_duration: payload.image_duration,
      }), 'AI 编排')
      const id = extractSubmitTaskId(res)
      statusText.value = `AI 编排任务已提交：${id}（轮询 /scheduled/tasks/${id}）`
      startPolling({
        id,
        channel: 'scheduled',
        onDone: (result) => {
          // result.video_url|url|output_url，缺失回退契约下载端点（worker L134-136/L165）
          const url = toAbsolute(extractConcatResultUrl(result) || `/montage/concat/result/${id}`)
          concatResults.value = [url]
          statusText.value = 'AI 编排完成，成片可下载'
          notify('AI 编排完成', `任务 ${id} 完成`)
        },
        onFail: (msg) => {
          concatError.value = msg
          notify('AI 编排失败', `任务 ${id}：${msg}`)
        },
      })
    } catch (e) {
      concatError.value = errText(e)
      notify('AI 编排失败', concatError.value)
    } finally {
      concatBusy.value = false
      clearBusy = null
    }
  }

  // ══ Step4 合成（/montage/bgm，同步 {ok, path, video_url}）══════
  const finalSource = ref('')      // 编排成片 URL 或本地文件路径
  const bgmPath = ref('')
  const bgmName = ref('')
  const bgmVolume = ref(60)        // %（契约默认 0.6）
  const sourceVolume = ref(100)    // %（契约默认 1.0）
  const finalBusy = ref(false)
  const finalError = ref('')
  const finalResults = ref<string[]>([])

  function pickBgm(): void {
    void (async () => {
      const res = await window.tintin.dialog.openFile({
        title: '选择背景音乐',
        filters: [{ name: '音频', extensions: ['mp3', 'wav', 'm4a', 'flac', 'ogg'] }],
      })
      if (res) {
        bgmPath.value = String(res)
        bgmName.value = bgmPath.value.split(/[\\/]/).pop() || bgmPath.value
      }
    })()
  }

  function pickLocalFinal(): void {
    void (async () => {
      const res = await window.tintin.dialog.openFile({
        title: '选择要合成的成片',
        filters: [{ name: '视频', extensions: ['mp4', 'mov', 'mkv', 'webm'] }],
      })
      if (res) finalSource.value = String(res)
    })()
  }

  /** 成片混音：本地成片走 file 上传；编排 URL 成片走 video_url（服务端自行拉取） */
  async function runFinalMix(): Promise<void> {
    if (!finalSource.value) { finalError.value = '请先选择要合成的成片（编排结果或本地文件）'; return }
    if (!bgmPath.value) { finalError.value = '请先选择背景音乐'; return }
    finalError.value = ''
    finalBusy.value = true
    clearBusy = clearAllBusy
    finalResults.value = []
    try {
      const isLocal = !/^https?:\/\//i.test(finalSource.value) && !finalSource.value.startsWith('/')
      const vol = bgmVolume.value / 100
      const svol = sourceVolume.value / 100
      const payload = isLocal
        ? buildBgmPayload({ file: finalSource.value, bgm: bgmPath.value, bgmVolume: vol, sourceVolume: svol })
        : null
      const res = unwrapIpc(await window.tintin.server.montageBgm(
        payload
          ? { file: { path: payload.file }, bgm: { path: payload.bgm }, bgm_volume: payload.bgm_volume, source_volume: payload.source_volume }
          : { video_url: finalSource.value, bgm: { path: bgmPath.value }, bgm_volume: vol, source_volume: svol },
      ), '成片混音')
      const parsed = extractBgmResult(res)
      if (parsed.taskId) {
        statusText.value = `混音任务已提交：${parsed.taskId}`
        startPolling({
          id: parsed.taskId,
          channel: 'scheduled',
          onDone: (result) => {
            const url = toAbsolute(extractConcatResultUrl(result) || parsed.url)
            if (!url) {
              finalError.value = '任务完成但未返回结果地址'
              notify('成片混音', finalError.value)
              return
            }
            finalResults.value = [url]
            statusText.value = '混音完成，成片可下载'
            notify('成片混音完成', `任务 ${parsed.taskId} 完成`)
          },
          onFail: (msg) => {
            finalError.value = msg
            notify('成片混音失败', `任务 ${parsed.taskId}：${msg}`)
          },
        })
      } else if (parsed.url) {
        finalResults.value = [toAbsolute(parsed.url)]
        statusText.value = '混音完成，成片可下载'
        notify('成片混音完成', '成片可下载')
      } else {
        throw new Error('未返回结果地址')
      }
    } catch (e) {
      finalError.value = errText(e)
      notify('成片混音失败', finalError.value)
    } finally {
      finalBusy.value = false
      clearBusy = null
    }
  }

  // ── 结果下载 / 打开目录（统一口径：saveFile 起名 → downloadResult 落盘 → reveal）──
  const downloadingKey = ref('')

  function resultFileName(prefix: string, idx: number): string {
    return `${prefix}_${idx}.mp4`
  }

  async function download(url: string, defaultName: string, key: string): Promise<void> {
    if (!url) return
    const savePath = await window.tintin.dialog.saveFile({ title: '保存结果', defaultPath: defaultName })
    if (!savePath) return // 用户取消
    downloadingKey.value = key
    try {
      const saved = await window.tintin.server.downloadResult(url, savePath)
      if (!saved) throw new Error('下载失败（服务端离线或网络异常）')
      notify('下载完成', String(saved))
      try { window.tintin.shell.revealInFolder(String(saved)) } catch (_) {}
    } catch (e) {
      notify('下载失败', errText(e))
    } finally {
      downloadingKey.value = ''
    }
  }

  function downloadBeat(idx: number): void {
    const v = beatVariants.value[idx]
    if (v) void download(v.url, resultFileName('beat', v.variant), `beat:${idx}`)
  }
  function downloadConcat(idx: number): void {
    const url = concatResults.value[idx]
    if (url) void download(url, resultFileName('montage', idx + 1), `concat:${idx}`)
  }
  function downloadFinal(idx: number): void {
    const url = finalResults.value[idx]
    if (url) void download(url, resultFileName('montage_final', idx + 1), `final:${idx}`)
  }

  /** 本地文件打开所在目录（结果打开目录口径） */
  function revealLocal(path: string): void {
    try { window.tintin.shell.revealInFolder(path) } catch (_) {}
  }

  onUnmounted(() => {
    pollCancelled = true
    stopPolling()
  })

  return {
    // 共享
    serverUrl, polling, activeTaskId, statusText, cancelPolling, stopPolling,
    downloadingKey, download, resultFileName,
    // Step1
    srcVideos, threshold, minSceneLen, imageDuration,
    scenes, scoreFilter, filteredScenes, checkedCount,
    splitBusy, splitError, splitMsg,
    addVideos, onDrop, removeVideo, runSplit,
    // Step2
    musicPath, musicName, pickMusic, beatError,
    beatmapBusy, beats, beatClips, detectBeats,
    beatCount, beatTimeLimit, beatVariantCount, beatAspectRatio,
    beatTransition, beatTransitionDuration, beatMinDuration, beatMaxDuration,
    beatBusy, beatVariants, runBeatCompose, downloadBeat, TRANSITIONS,
    // Step3
    concatTransition, concatLayout, concatTransitionDuration,
    concatBusy, concatError, concatResults, runConcat, downloadConcat,
    // Step4
    finalSource, bgmPath, bgmName, bgmVolume, sourceVolume,
    finalBusy, finalError, finalResults,
    pickBgm, pickLocalFinal, runFinalMix, downloadFinal, revealLocal,
  }
}

/** TSelect 选项最小结构（避免组件层依赖方向反转） */
interface SelectOptionLite {
  label: string
  value: SelectOptionLiteValue
}
type SelectOptionLiteValue = string | number
