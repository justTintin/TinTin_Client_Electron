// ═══════════════════════════════════════════════════════════════
// useCopyMontageStep1Split.ts — 智能混剪 Step1 素材解析编排（铁律 10 拆分，2026-09-18）
// 自 useCopyMontage.ts 纯搬迁（IRON-02 五项 checklist；蓝图见
// docs/智能混剪拆分迁移映射_2026-09-18.md §五 Step1）。
// 跨步依赖仅三项，经 ctx 注入：statusText / ensureServerUrl / toAbsolute。
// ═══════════════════════════════════════════════════════════════
import { ref, reactive, computed, watch } from 'vue'
import { clientError } from '../../utils/clientLog'
import { readCacheDir } from '../useSettingsConfig'
import {
  parseSplitResponse,
  shotsToRows,
  collectEdgeTrimJobs,
  resolveSplitBaselineResolution,
  normalizeSourceResolution,
  safeSourceName,
  pathBasename,
  VIDEO_EXTS,
  MAX_SOURCE_VIDEOS,
  type SplitSceneRow,
} from '../copyMontageLogic'
import { notify, unwrapIpc, errText, joinPath } from './context'

/** Step1 编排上下文（共享轮询文案与服务端地址设施，见映射文档 §四） */
export interface MontageStep1Context {
  statusText: import('vue').Ref<string>
  ensureServerUrl: () => Promise<string>
  toAbsolute: (url: string) => string
}

export function useCopyMontageStep1Split(ctx: MontageStep1Context) {
  const { statusText, ensureServerUrl, toAbsolute } = ctx

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

  /** 逐个素材调 /montage/split（同步返回 shots[]）；ECONNRESET/ETIMEDOUT 等瞬时断线自动重试 1 次 */
  async function runSplit(): Promise<void> {
    if (!srcVideos.value.length) { splitError.value = '请先选择视频素材'; return }
    splitBusy.value = true
    splitError.value = ''
    splitMsg.value = '正在解析素材…'
    try {
      const rows: SplitSceneRow[] = []
      // 最后一次素材的 source_resolution（供分割后画幅兜底链 ③ 使用；帧率取 fps 字段）
      let lastSrcRes: unknown = null
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
        // 画幅基准（2026-09-15 用户裁决）：「与原视频一致」= 与分割片段一致，非原素材——
        // 服务端分割产物已统一缩放（4K 竖屏素材出 1080x1920），旧实现取 source_resolution
        // （原素材 4K）当画幅基准，Step2 预合成被撑成 4K/横屏。取值链：
        // ① 逐镜画幅（shots[].resolution，分割产物口径，resolveSplitBaselineResolution 取首个非空）
        // ② 本地探测首个片段（splits 落盘，见下方 probe 兑底块）
        // ③ source_resolution 最后兜底（前两者皆缺时，见 probe 兑底块 else 分支）
        // 帧率同源不变（2026-09-11）：source_resolution.fps 即原片帧率，分割片段与原片同帧率
        const srcRes = (res as { source_resolution?: unknown }).source_resolution
        lastSrcRes = srcRes
        splitResolution.value = resolveSplitBaselineResolution(rows.map((r) => r.resolution), '')
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
      // 探测兑底（2026-09-15 用户裁决后的画幅兜底链收口）：逐镜画幅缺失时探
      // 首个本地片段（分割产物=画幅基准）；原素材仅作帧率兜底探测，画幅不再取
      // 原素材（4K 素材曾把 Step2 撑成 4K/横屏）
      if (!splitResolution.value || !splitFps.value) {
        const firstClip = rows.find((r) => r.clipLocalPath)
        if (firstClip?.clipLocalPath) {
          void window.tintin.ffmpeg.probe(firstClip.clipLocalPath).then((info) => {
            if (Number(info?.width) > 0 && Number(info?.height) > 0 && !splitResolution.value) {
              splitResolution.value = `${Number(info.width)}x${Number(info.height)}`
            }
            // 原片帧率同源探测（一次 probe 同时拿宽高与 fps）
            if (Number(info?.fps) > 0 && !splitFps.value) splitFps.value = Number(info.fps)
          }).catch(() => { /* 探测失败：画幅列显 —、帧率走 resolveConcatFps 兑底 30 */ })
        } else if (!splitResolution.value) {
          // ③ 兜底：无逐镜画幅且片段未落盘（下载失败等）——source_resolution 最后降级
          const sr = normalizeSourceResolution(lastSrcRes)
          if (sr) splitResolution.value = sr
        }
        // 帧率兜底：分割片段与原素材同帧率，无本地片段时探原素材拿 fps（画幅不取）
        if (!splitFps.value && !firstClip?.clipLocalPath && srcVideos.value[0]) {
          void window.tintin.ffmpeg.probe(srcVideos.value[0]).then((info) => {
            if (Number(info?.fps) > 0 && !splitFps.value) splitFps.value = Number(info.fps)
          }).catch(() => { /* 帧率走 resolveConcatFps 兑底 30 */ })
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

  return {
    // refs / computed
    srcVideos, srcDurations, threshold, minSceneLen, imageDuration,
    scenes, scoreFilter, filteredScenes,
    splitBusy, splitError, splitMsg, splitProgress, splitResolution, splitFps,
    splitsJobId, splitsDownloading,
    previewUrl, previewTranscoding,
    // fns
    addVideos, selectFolder, onDrop, removeVideo, runSplit,
    updateSceneDesc, previewSourceVideo, previewScene, closePreview,
    clearSplitCache, openSplitsDir,
  }
}
