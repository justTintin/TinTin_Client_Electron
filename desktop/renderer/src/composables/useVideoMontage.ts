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

import { ref, reactive, computed, watch, onUnmounted } from 'vue'
import { clientError } from '../utils/clientLog'
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
  collectEdgeTrimJobs,
  EDGE_CLIP_MAX_SEC,
  // Step2 镜头重组·预合成方案
  buildPrecomposePlans,
  planActiveDurationSec,
  type PrecomposePlan,
  buildSceneCopyMessages,
  parseLlmCopyResponse,
  assembledRowText,
  copyPreviewText,
  // Step3 字幕样式预设（2026-09-09 裁决：样式属字幕配置，字幕新增自有预设色板）
  SUBTITLE_STYLE_PRESETS,
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
  FANCY_POSITION_OPTIONS,
  SUBTITLE_BG_OPTIONS,
  resolveOutMontageDir,
  FPS_OPTIONS,
  resolveConcatFps,
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
  // 素材时长列（2026-09-09 用户裁决：素材列表加时长显示；路径→秒，增量探测）
  // 2026-09-09 修复：原 watch(srcVideos, ...) 为 ref 浅层监听，addVideos/selectFolder
  //  均为 push 原地变更不触发 → 探测从未启动全列显「—」；改 getter 形式监听数组变更。
  //  探测改 ffmpeg:probeDuration（resources/bin 无 ffprobe.exe，主进程回退 ffmpeg -i 解析）。
  const srcDurations = reactive(new Map<string, number>())
  watch(() => [...srcVideos.value], (list) => {
    for (const p of list) {
      if (srcDurations.has(p)) continue
      srcDurations.set(p, 0) // 占位防并发重复探测（探测完成回写真实值，0 仍显 —）
      void window.tintin.ffmpeg.probeDuration(p).then((d) => {
        const sec = Number(d) || 0
        if (sec > 0) srcDurations.set(p, sec)
        else srcDurations.delete(p)
      }).catch(() => { srcDurations.delete(p) /* 探测失败显 — */ })
    }
  }, { immediate: true })
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
  /** 原片帧率（2026-09-11 用户裁决：Step2 输出帧率默认「跟随原片」）。
   * 数据源：服务端 split 响应的 source_resolution.fps（在线实测 {width,height,
   * aspect_ratio,fps,codec}）优先；服务端未给时本地 ffmpeg:probe 探测兑底 */
  const splitFps = ref(0)

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
  /** 解析进度 0-100（对照原版 step1_split_controller _progress：按素材数推进，每素材开始前更新） */
  const splitProgress = ref(0)
  /** 确认合成进度 0-100（对照原版 montage_concat_server_worker：提交 30/轮询钳 48/完成 100） */
  const concatProgress = ref(0)

  /** 逐个素材调 /montage/split（同步返回 shots[]）；ECONNRESET/ETIMEDOUT 等瞬时断线自动重试 1 次 */
  async function runSplit(): Promise<void> {
    if (!srcVideos.value.length) { splitError.value = '请先选择视频素材'; return }
    splitBusy.value = true
    splitError.value = ''
    splitMsg.value = '正在解析素材…'
    try {
      const rows: SplitSceneRow[] = []
      // 逐素材阶段文案 + 进度（对照原版 _process_next_merged_video L202-203：
      // `_stage("智能镜头分割 ({idx}/{total})：{fname}")` + `_progress(done*100/total)`）
      const total = srcVideos.value.length
      splitProgress.value = 0
      for (let vi = 0; vi < total; vi++) {
        const v = srcVideos.value[vi]
        const name = v.split(/[\\/]/).pop() || v
        splitMsg.value = `智能镜头分割 (${vi + 1}/${total})：${name}`
        splitProgress.value = Math.round((vi * 100) / total)
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
        // 传递 sourcePath 用于「位置」兑底推断（对齐 PR#3 classify_shot_type；景别仅服务端返回）
        const shots = parseSplitResponse(res)
        console.log(`[split] ${name}: ${shots.length} shots, 首个 clipUrl=${shots[0]?.downloadUrl || '(空)'}`)
        rows.push(...shotsToRows(shots, name, v))
        // 逐素材增量上表（对照原版 _on_split_analysis_ready L309-316：每素材分割完成
        // 即刷新 split_result_table；行号连续重编号，未落盘行预览回退服务端 clipUrl 内嵌）
        scenes.value = rows.slice()
        rows.forEach((r, i) => { r.idx = i + 1 })
        // 原片分辨率：优先服务端 split 响应 source_resolution（对照原版 step1_split_controller
        // L326-328 逐素材覆盖 _source_resolution 的同口径），无则后置本地探测兑底。
        // 帧率同源（2026-09-11 在线实测）：source_resolution 是对象
        // {width,height,aspect_ratio,fps,codec}，其中 fps 即原片帧率——「跟随原片」
        // 优先用它（本地探测在无 ffprobe 的打包环境可能失败，服务端值是白送的）
        const srcRes = (res as { source_resolution?: unknown }).source_resolution
        const sr = normalizeSourceResolution(srcRes)
        if (sr) splitResolution.value = sr
        const remoteFps = Number((srcRes as { fps?: unknown } | null | undefined)?.fps)
        if (Number.isFinite(remoteFps) && remoteFps > 0) splitFps.value = remoteFps
      }
      // 行已随各素材完成逐批增量上表（scenes 与 rows 同引用集），此处仅收尾文案
      splitMsg.value = rows.length
        ? `解析完成：共 ${rows.length} 个镜头片段`
        : '未解析出镜头片段（可调低分割阈值后重试）'
      // 片段落盘本地 splits 目录（原版分割产物在 .runtime/montage_cache/<job_id>/splits/<短视频名>/；
      // 本端片段在服务端，分割完成后批量下载补齐同一目录结构，供「打开已分割镜头目录」与双击预览）
      if (rows.length) {
        splitsJobId.value = (crypto?.randomUUID?.() || `${Date.now()}_${Math.floor(Math.random() * 1e8)}`).replace(/-/g, '')
        await downloadClipsToSplits()
      }
      // PR#4 条目10：出入场超长片段自动裁剪（后台，对照 _maybe_trim_edge_clips L1706
      // 挂在 _check_split_clips_exist 尾部的同口径：分割完成即扫描）
      void maybeTrimEdgeClips()
      // 探测兑底（原版 _detect_and_show_source_resolution L4783-4793：服务端未返回时
      // probe 第一个镜头文件；本端片段已落盘 splits，优先探测片段，源视频兑底）。
      // 触发条件含 fps（2026-09-11 纠偏）：服务端 split 只给 source_resolution 不给
      // 帧率（在线核实无 source_fps 字段）→ 画幅已知时仍需探测一次拿 fps
      if (!splitResolution.value || !splitFps.value) {
        const firstClip = rows.find((r) => r.clipLocalPath)
        const probeTarget = firstClip?.clipLocalPath || srcVideos.value[0]
        if (probeTarget) {
          void window.tintin.ffmpeg.probe(probeTarget).then((info) => {
            if (Number(info?.width) > 0 && Number(info?.height) > 0 && !splitResolution.value) {
              splitResolution.value = `${Number(info.width)}x${Number(info.height)}`
            }
            // 原片帧率同源探测（一次 probe 同时拿宽高与 fps）
            if (Number(info?.fps) > 0 && !splitFps.value) splitFps.value = Number(info.fps)
          }).catch(() => { /* 探测失败：画幅列显 —、帧率走 resolveConcatFps 兑底 30 */ })
        }
      }
    } catch (e) {
      splitError.value = errText(e)
      clientError('video-montage', '素材解析失败', e)
      notify('素材解析失败', splitError.value)
    } finally {
      splitBusy.value = false
    }
  }

  // ── 出入场超长片段自动裁剪（PR#4 条目10，对照 _maybe_trim_edge_clips L1708-1779：
  //  识别为入场/出场的分割片段超过 EDGE_CLIP_MAX_SEC 时裁剪（取中间时间段——产品
  //  通常在镜头中间段），主进程重编码替换本地文件并同步改写文件名时间戳；幂等：
  //  已裁片段时长 ≤ 阈值不会再次入选；防死循环：连续 2 轮无产出停止自动重试。
  //  裁剪后行回写新路径/新时长/trimmed 标记，concat 对含被裁片段的方案改走本地 files）──
  let edgeTrimRunning = false
  let edgeTrimFailCount = 0
  async function maybeTrimEdgeClips(): Promise<void> {
    if (edgeTrimRunning || edgeTrimFailCount >= 2) return
    const jobs = collectEdgeTrimJobs(scenes.value)
    if (!jobs.length) return
    edgeTrimRunning = true
    statusText.value = `正在裁剪 ${jobs.length} 个超长出入场镜头（取中间时间段）…`
    console.log(`[出入场裁剪] 启动：${jobs.length} 个片段待裁剪`)
    try {
      const res = await window.tintin.server.trimEdgeClips({ jobs })
      if (!res) throw new Error('主进程不可达')
      if ('error' in res) throw new Error(res.error)
      if (res.renamed.length) {
        edgeTrimFailCount = 0
        // 回写行：新本地路径/新文件名/新时长 + trimmed 标记（原版迁移 split_descriptions
        // 缓存键的同口径；本端描述在行对象上，随行保留不动）
        for (const [oldP, newP, keep] of res.renamed) {
          const row = scenes.value.find((r) => r.clipLocalPath === oldP)
          if (row) {
            row.clipLocalPath = newP
            row.name = pathBasename(newP)
            row.duration = keep
            row.trimmed = true
          }
        }
        console.log(`[出入场裁剪] 完成：${res.renamed.length} 个片段已裁剪替换，skipped=${res.skipped}`)
        statusText.value = `完成：已裁剪 ${res.renamed.length} 个超长出入场镜头。`
      } else {
        edgeTrimFailCount++
        console.warn(`[出入场裁剪] 本轮无产出（连续第 ${edgeTrimFailCount} 次），skipped=${res.skipped}`)
        statusText.value = '出入场镜头时长均正常，无需裁剪。'
      }
    } catch (e) {
      edgeTrimFailCount++
      clientError('video-montage', '出入场裁剪失败', e)
      statusText.value = ''
    } finally {
      edgeTrimRunning = false
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

  /** 镜头片段预览：内置 Plyr 播放器弹窗（本地路径 / 服务端 URL 均支持） */
  const previewUrl = ref('')
  /** 不可播编码自动转码进行中（VideoPreview 弹窗显示转码提示，2026-09-10） */
  const previewTranscoding = ref(false)
  let previewToken = 0

  /** 预览可播性保障：Chromium 不可播编码（H.264 4:2:2 10bit、MP4+PCM 等，
   *  2026-09-10 素材预览全灭根因）主进程 ensurePlayable 自动转码兜底；
   *  可播/检测失败原路径直返，转码失败提示后按原样播放（沿用既有错误 UI）。 */
  async function ensurePreviewSrc(p: string, token: number): Promise<string> {
    try {
      const res = await window.tintin.ffmpeg.ensurePlayable(p)
      // 弹窗已关闭或已有更新一次预览 → 丢弃本次结果
      if (token !== previewToken || !previewUrl.value) return ''
      if (res && 'error' in res) {
        console.error(`[preview] ensurePlayable 转码失败: ${res.error}`)
        splitMsg.value = `预览转码失败（${res.error}），将按原样播放`
        return p
      }
      return res.path
    } catch (err) {
      console.error(`[preview] ensurePlayable 调用失败: ${err}`)
      return p
    }
  }

  /** 素材双击预览：内置 Plyr 播放器弹窗（替代系统播放器） */
  async function previewSourceVideo(path: string): Promise<void> {
    if (!path) return
    const token = ++previewToken
    previewUrl.value = path
    previewTranscoding.value = true
    const playable = await ensurePreviewSrc(path, token)
    if (playable) previewUrl.value = playable
    if (token === previewToken) previewTranscoding.value = false
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

  function previewScene(row: SplitSceneRow): void {
    if (row.clipLocalPath) {
      void previewSourceVideo(row.clipLocalPath)
      return
    }
    if (!row.clipUrl) return
    void (async () => {
      await ensureServerUrl()
      await previewSourceVideo(toAbsolute(row.clipUrl))
    })()
  }
  function closePreview(): void { previewUrl.value = '' }

  /** 清空混剪缓存（原版 _clear_montage_cache → clear_montage_cache：删除 montage_cache 下
   *  全部任务目录，不触碰原始素材；本端同口径删本地缓存目录 + 清会话内镜头清单） */
  async function clearSplitCache(): Promise<void> {
    scenes.value = []
    splitResolution.value = ''
    splitFps.value = 0
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
   *  clipShotTypes：镜头文件名→景别键（对照原版 L3004-3015 clip_shot_types，仅非空景别收进） */
  async function submitConcatTask(clipUrls: string[], clipShotTypes?: Record<string, string>, localFiles?: string[]): Promise<{ url: string; id: string; newContract: boolean }> {
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
              // 帧率同步补探测（Step1 探测失败时走到这里）
              if (Number(info?.fps) > 0 && !splitFps.value) splitFps.value = Number(info.fps)
              break
            }
          } catch (_) { /* 尝试下一个候选 */ }
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
      clientError('video-montage', `批量文案生成部分失败 成功${ok}失败${failures.length}`, failures.join('\n'))
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
  const finalMode = ref<'' | 'server' | 'local'>('') // 进行中的链路（双按钮独立 loading）
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
      clientError('video-montage', 'BGM生成失败', e)
      notify('BGM 生成失败', bgmGenError.value)
    } finally {
      bgmGenBusy.value = false
    }
  }

  /** 生成结果的预览地址（相对路径拼服务端基址） */
  const bgmPreviewUrl = computed(() => toAbsolute(bgmGenUrl.value))

  /** BGM 选择弹窗确认（2026-09-09 用户裁决）：音频库音频经 /audio/library/{mid}/file
   *  下载落盘后回填 bgmPath（ffmpeg 混音/剪映导出需本地文件） */
  async function applyLibraryBgm(mid: string, filename: string): Promise<{ path?: string; error?: string }> {
    try {
      const destDir = voiceDirInput.value
        ? joinPath(resolveOutMontageDir(voiceDirInput.value), 'bgm_lib')
        : joinPath(await readCacheDir(), 'montage_cache', 'bgm_lib')
      const dl = await window.tintin?.server?.bgmDownloadUrl?.({ url: `/audio/library/${mid}/file`, destDir })
      if (!dl || !('path' in dl) || !dl.path) return { error: '下载失败（服务端不可达或文件不存在）' }
      bgmPath.value = dl.path
      bgmName.value = filename || pathBasename(dl.path)
      return { path: dl.path }
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) }
    }
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
    // 2026-09-09 裁决：特效配置迁入 Step4，进入时拉取服务端文字模板库（空库仅随机项）
    void loadTextTemplates()
    // 效果预览轨（2026-09-10 二次裁决）：进入时按合成候选刷新一次（候选列表独立于 voiceRows）
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
      const tasks = buildFinalTasks(candidates, srcDirName(voiceDirInput.value), outFinalDir)
      const channel = nextVoiceChannel()
      // 2026-09-09 裁决：特效配置迁 Step4，混音前统一烧制字幕/花字。
      // subtitleTexts 按候选视频映射 Step3 文案行：无对应行（如 outputs
      // 未配音排列视频）不烧字幕/花字，直通混音。
      // fxLines：文字模板命中行（服务端 match 结果，仅本地烧制消费，见下方预取）
      // voicePath：配音 wav（2026-09-11 voice 接线：仅服务端链路消费，随 concat
      //   voice 轨上传；本地链路已由 dubVideos 替换进视频，不消费）
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
            fxLines: [] as Array<{ text: string; start: number; end: number; keywords: string[] }>,
          }
        })
        .filter((x): x is {
          videoPath: string; text: string; timingPath: string; voicePath: string
          fxLines: Array<{ text: string; start: number; end: number; keywords: string[] }>
        } => !!x)
      // 2026-09-11 用户裁决：本地合成文字模板与服务端 match、效果预览同源（预览所见即
      // 合成所做）——仅本地链路预取命中行（服务端链路由 concat 自行从字幕命中）；
      // 离线/失败 → 空数组（不烧，与预览空轨口径一致，不造数）
      if (mode === 'local' && textFxEnabled.value && subtitleTexts.length) {
        statusText.value = '正在获取文字模板命中...'
        // 串行取数 + 失败归集（2026-09-12 日志实锤：并行 3 连击期间服务端 match
        // 500/ECONNRESET 全灭 → textFxHits=0 → 成片既无关键词也无动画且无提示；
        // 串行+单点重试降连击压力，失败不再静默）
        const failed: string[] = []
        for (const st of subtitleTexts) {
          const r = await fetchTextFxHits(st.videoPath, st.text, st.timingPath)
          st.fxLines = r.lines
          if (!r.ok) failed.push(pathBasename(st.videoPath))
        }
        if (failed.length) {
          // 如实透出（铁律：服务端 5xx 定性归因服务端）：不静默产出无文字模板的成片
          clientError('video-montage', '文字模板关键词获取失败', `服务端 /text_templates/match 异常（500/连接中断），以下视频本次未烧文字模板：${failed.join('、')}`)
          notify('文字模板未生效', `服务端关键词命中接口异常（500/连接中断），以下视频本次合成不含文字模板：\n${failed.join('\n')}\n\n可稍后重试「本地合成」。`)
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
            textTemplateId: textTemplateId.value,
            // match 模式必填（/guide text_template_match_ids）：每次合成从模板库随机
            // 取 N 个 id 作模板池，命中行从池中随机选一（与「随机数量」UI 语义一致）
            textTemplateMatchIds: textTemplateId.value === 'random'
              ? pickRandomItems(activeTextPool.value, textRandomCount.value).map((t) => String(t.template_id))
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
    // 2026-09-10 缺陷修复：单段导出此前漏传 srtPath（剪映草稿缺字幕轨），与多段同口径找配套 SRT
    const fr = await window.tintin?.server?.finalFindSrt?.({ videoPath })
    const srtPath = fr && 'srtPath' in fr && fr.srtPath ? fr.srtPath : ''
    await doJianyingExport({
      mode: 'single',
      videoPath,
      srtPath,
      ...jianyingFxParams(),
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
      ...jianyingFxParams(),
      draftName: `螺丝钉剪辑_多片段时间轴(${paths.length}段)`,
      successBody: (name) => `已将 ${paths.length} 个片段导出为剪映时间轴（转场：${transition}）！\n\n项目名称：${name}\n\n请直接打开您的电脑「剪映专业版」客户端进行精修编辑。\n系统已为您在资源管理器中定位到该草稿文件夹。`,
    })
  }

  /** 剪映导出随行特效（2026-09-10 用户裁决：花字/文字模板数据格式进草稿）。
   *  关键词取口播文案同口径（extractTextFxWords）；轨道随 Step4 开关：
   *  fancyEnabled→花字轨（金色加粗）、textFxEnabled→文字模板轨（蓝色加粗）。
   *  2026-09-12 M2a：选中花字模板带 jy_effect_id/jy_intro_anim → 剪映原生效果/入场动画随行；
   *  文字模板下拉选中 jy_ 前缀（剪映同步）模板 → tplEffectId 随行（剪映端还原原生效果）。 */
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

  /** 剪映导出公共体：BGM/音量随当前选择；成功弹窗逐字 + 打开草稿目录；失败长错误 */
  async function doJianyingExport(base: {
    mode: 'single' | 'multi'
    videoPath?: string
    videoPaths?: string[]
    srtPath?: string
    srtPaths?: Array<string | null>
    transitions?: string
    fxWords?: string[]
    fxKinds?: Array<'fancy' | 'tpl'>
    textAnim?: string
    fancyEffectId?: string
    tplEffectId?: string
    draftName: string
    successBody: (name: string) => string
  }): Promise<void> {
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
      return
    }
    if (res && res.success) {
      notify('草稿导出成功', successBody(base.draftName))
      try { window.tintin.shell.openItem(res.message) } catch (_) {}
    } else {
      clientError('video-montage', '导出剪映草稿失败', res ? res.message : '主进程不可达')
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
  // 字幕样式预设 key（2026-09-09 裁决：字幕配置新增自有样式色板，key 与主进程 SUBTITLE_STYLES 同表）
  const subtitleStyleKey = ref('white')
  // 字幕入场动画 key（2026-09-10 用户裁决：字幕可选动画，预览与烧制同用该选择；
  // key 与主进程 VALID_ANIMS 同表：fade/rise/slide/pop/none）
  const subtitleAnimKey = ref('fade')
  // 花字位置/字幕背景/模板（L224-352；模板首项「自定义 (下方样式)」value=''）
  const fancyPosition = ref('upper_middle')
  const subtitleBgOpacity = ref(0.5)
  const fancyTemplateId = ref('')
  const fancyTemplates = ref<FancyTemplateItem[]>([])
  const fancyPreviews = ref<Record<string, string>>({})
  const fancyTemplatesLoading = ref(false)
  // ── 文字模板（2026-09-09 用户裁决：服务端 textfx 体系，与花字独立概念）──
  // textTemplateId 首项 'random'（随机样式，默认）：每次合成从全部模板随机选 N 个（默认 3）；
  // 2026-09-10 在线契约纠偏：服务端统一合成 POST /montage/concat（multipart）已支持全套
  // text_template_* 字段（enabled/id/words/timing/match_enabled/match_ids），不存在也不需要
  // 独立「文字模板烧制」接口——所有素材统一合成（用户裁决口径）；待把字段接入确认合成请求。
  const textFxEnabled = ref(false)
  const textTemplateId = ref('random')
  const textRandomCount = ref(3)
  // 关键词密度档位（2026-09-10 用户裁决：低/中/高；调节后重新提取关键词并重新掷模板）
  const textKeywordDensity = ref('mid')
  const textTemplates = ref<Array<Record<string, unknown> & { template_id: string; name: string }>>([])
  const textTemplatesLoading = ref(false)
  /** 生效模板池（2026-09-10 用户二次裁决：随机数量 N 对应每条视频各自随机选——
   *  池恒为全量库，逐视频在烧制/预览端确定性洗牌取子集；指定模板则池=单模板） */
  const activeTextPool = computed(() => {
    if (textTemplateId.value !== 'random') {
      const one = textTemplates.value.find((t) => t.template_id === textTemplateId.value)
      return one ? [one] : []
    }
    return textTemplates.value
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
  async function fetchTextFxHits(
    videoPath: string,
    text: string,
    timingPath: string,
  ): Promise<{ dur: number; lines: Array<{ text: string; start: number; end: number; keywords: string[] }>; ok: boolean }> {
    const dur = Number(await window.tintin?.ffmpeg?.probeDuration?.(videoPath).catch?.(() => 0)) || 0
    let timing: Array<{ text: string; start: number; end: number }> = []
    if (timingPath) {
      const res = await window.tintin?.server?.finalReadTiming?.({ timingPath })
      timing = res && 'items' in res ? res.items : []
    }
    const rows = buildSubtitleRows(String(text || '').trim(), timing, dur)
    if (!rows.length) return { dur, lines: [], ok: true }
    // 缓存复用（预览与合成共享同一份命中行，不再二次调服务端；密度或行内容变化 → key 变 → 重取）
    const cacheKey = textFxHitsKey(rows)
    const cached = textFxHitsCache.get(cacheKey)
    if (cached) return { dur, lines: cached, ok: true }
    // 重试口径（2026-09-12 实锤：服务端 match 偶发 500/ECONNRESET，单次失败曾致
    // 本地烧制 textFxHits=0 → 成片无文字模板；400/900ms 退避共 3 次）
    let ok = false
    let lines: Array<{ text: string; start: number; end: number; keywords: string[] }> = []
    for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
      const res = await window.tintin?.server?.textfxMatchKeywords?.({
        rows,
        density: textKeywordDensity.value,
        llmFill: true,
      })
      if (res && 'lines' in res && Array.isArray(res.lines)) {
        ok = true
        lines = res.lines
          .filter((l) => l.selected)
          .map((l) => ({
            text: String(l.text || ''),
            start: Number(l.start) || 0,
            end: Number(l.end) || 0,
            keywords: Array.isArray(l.matched_keywords) ? l.matched_keywords.map((k) => String(k)) : [],
          }))
      } else if (attempt < 3) {
        console.warn(`[textfx] match 第 ${attempt}/3 次失败，重试...`, res)
        await new Promise((r) => setTimeout(r, attempt === 1 ? 400 : 900))
      }
    }
    if (!ok) console.warn('[textfx] match 三次均失败（服务端 500/离线），本次不烧文字模板', videoPath)
    if (ok) textFxHitsCache.set(cacheKey, lines) // 成功才入缓存（失败不污染，下次重取）
    return { dur, lines, ok }
  }
  /** 命中行缓存（2026-09-12 用户质询：预览已调过 match，合成为何再调——match 的唯一
   *  业务输入就是 rows（文案+时间轴的实际组装结果），不发也不依赖视频文件；rows 已涵盖
   *  「timing.json 优先」与「无 timing 按时长占比估算」两种口径 → 直接以 密度+rows 为 key：
   *  timing 存在时预览/合成 rows 完全一致必命中（不再二次调服务端）；无 timing 时两链
   *  时长不同（源视频 vs 配音后视频）rows 即不同 → 自动重取，避免用源视频时间窗烧配音后
   *  视频的错位。二次调用放大服务端 match 压力正是 500 全灭致文字模板整块消失的诱因） */
  const textFxHitsCache = new Map<string, Array<{ text: string; start: number; end: number; keywords: string[] }>>()
  function textFxHitsKey(rows: Array<{ text: string; start: number; end: number }>): string {
    return `${textKeywordDensity.value}\u0000${JSON.stringify(rows)}`
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
      )
      matched.push({ name: pathBasename(c), durationSec: dur, lines })
    }
    if (seq !== textFxTrackSeq) return // 过期响应丢弃（连续触发只保留最新）
    // 2026-09-10 用户终裁：轨名列显示视频名（模板名拼接方案废止；name 字段自此=文件名）
    // 2026-09-11 用户二次裁决：展示层改「第N条」序号，见 VideoMontage.vue .textfx-track-name
    // 2026-09-10 用户裁决：词条按命中模板渲染颜色+动画（与样式橱窗 textFxStyleSamples
    //  同源同构，去除 fontSize 只取颜色/渐变；不命中模板的词条走 CSS 默认色）
    const sampleByName = new Map(textFxStyleSamples.value.map((s) => [s.name, s]))
    textFxPreviewTracks.value = buildTextFxTracks({
      rows: matched,
      tplNames,
      count: activeTextCount.value, // 每视频独立随机选 N 个（2026-09-10 用户二次裁决）
    }).map((tr) => ({
      ...tr,
      items: tr.items.map((it) => {
        const s = sampleByName.get(it.tplName)
        if (!s) return it
        const { fontSize: _fs, ...tplStyle } = s.style
        return { ...it, anim: s.anim, tplStyle }
      }),
    }))
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
  const textFxStyleSamples = computed(() => {
    // 2026-09-10 用户二次裁决：样式预览显示模板库全部样式（橱窗）；
    // 随机数量是每条视频各自随机选 N 个，在效果预览/烧制端逐视频应用，不在此处裁剪
    return textTemplates.value.map((t) => {
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
      // M2a：服务端真实效果预览（上传时自动生成，贴纸+文字合成图）——有则优先用图，
      // 无则回退本地近似画法
      const previewUrl = String((t as Record<string, unknown>).preview || '')
      const previewWebmUrl = String((t as Record<string, unknown>).preview_webm || '')
      return { id: String(t.template_id), name: String(t.name || t.template_id), text, anim, style, previewUrl, previewWebmUrl }
    })
  })
  /** 拉取服务端文字模板库（GET /text_templates/templates，2026-09-10 纠偏；进入 Step4 时调用；空库时下拉仅随机项） */
  async function loadTextTemplates(): Promise<void> {
    if (textTemplatesLoading.value) return
    textTemplatesLoading.value = true
    try {
      const sr = await window.tintin?.server?.textfxServerTemplates?.()
      const items = sr && !('error' in sr) && Array.isArray(sr.templates) ? sr.templates : []
      textTemplates.value = items.filter((t) => t && t.template_id)
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
      const allFiles: Array<{ path: string; name: string; originalText: string; wavPath?: string; durationSec?: number; voiceDurSec?: number }> = []
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
  async function enterStepVoice(): Promise<void> {
    if (!fontsPreloaded) {
      fontsPreloaded = true
      void refreshFonts()
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
    () => SUBTITLE_STYLE_PRESETS.find((p) => p.key === subtitleStyleKey.value) || SUBTITLE_STYLE_PRESETS[0]
  )
  const subtitlePreviewStyle = computed<Record<string, string>>(() => {
    void fontFacesVersion.value
    const st = subtitlePresetTileStyle(selectedSubtitlePreset.value)
    st.fontSize = '18px'
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
    subtitleStyleKey, SUBTITLE_STYLE_PRESETS, selectedSubtitlePreset, subtitlePreviewStyle,
    subtitleAnimKey,
    fontOptionStyle,
    fancyEnabled, fancyStyle, fancyPosition, subtitleBgOpacity,
    fancyTemplateId, fancyTemplates, fancyPreviews,
    voiceProgress, fancyTemplatesLoading,
    selectedFancyTemplate, loadFancyTemplates,
    // 文字模板（textfx；与花字独立；随机样式默认 3 个）
    textFxEnabled, textTemplateId, textTemplateOptions, textTemplates,
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
    regenVoice, exportVoice, playVoice, playRowVideo, playDubbedVideo,
    toggleLengthMode, lengthModeTip,
    voiceStatusText, voiceStatusClass, fmtDur, pathBasename,
    planDurText,
    // Step4 特效包装
    bgmPath, bgmName, bgmVolume, finalBusy, finalMode, finalDone, finalProgress,
    finalVideoList, finalVideoPath, finalSelIdx, finalPreviewUrl, finalPreviewTitle,
    bgmSource, bgmGenPrompt, bgmGenStyle, bgmGenDuration,
    bgmGenBusy, bgmGenError, bgmGenUrl, bgmGenMeta, bgmPreviewUrl,
    bgmPlaying, bgmPosMs, bgmDurMs,
    generateBgm,
    pickBgm, applyLibraryBgm, toggleBgmPlay, stopBgmPlay, onBgmVolumeInput, seekBgm,
    enterStep4, startFinalMix, openFinalDir,
    exportJianyingDraft, exportAllToJianyingDraft, previewFinalVideo, step4Candidates, toAbsolute,
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

/** TSelect 选项最小结构（避免组件层依赖方向反转） */
interface SelectOptionLite {
  label: string
  value: SelectOptionLiteValue
}
type SelectOptionLiteValue = string | number
