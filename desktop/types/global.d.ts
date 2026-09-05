// 为了让 TintinBridgeServer 下的业务级方法直接对齐 server-api.ts 命名空间类型，
// 先在顶部 import 该文件的命名空间与公共类型（declare global 前可用 import type）。
import type {
  HealthAPI,
  StatsAPI,
  LLMAPI,
  ASRAPI,
  TTSAPI,
  MaterialAPI,
  MontageAPI,
  AudioAPI,
  VSRAPI,
  RembgAPI,
  VisionAPI,
  WorkflowAPI,
  AgentAPI,
  TasksAPI,
  ScheduledAPI,
  StoryboardAPI,
  SystemAPI,
  CapabilityRegistryItem,
  PaginatedResponse,
  ArtifactItem,
} from './server-api'

// --------------------------------------------------------------------
// app
// --------------------------------------------------------------------
declare interface TintinBridgeApp {
  getVersion(): string
  getPath(name: 'home' | 'userData' | 'temp' | 'workspace'): string
  quit(): void
  relaunch(): void
  onUpdateAvailable(cb: (ver: string, url: string) => void): () => void
}

// --------------------------------------------------------------------
// dialog
// --------------------------------------------------------------------
declare interface TintinBridgeDialog {
  openFile(params?: {
    title?: string
    filters?: Array<{ name: string; extensions: string[] }>
  }): Promise<string | null>
  openFiles(params?: {
    title?: string
    filters?: Array<{ name: string; extensions: string[] }>
    multi: true
  }): Promise<string[] | null>
  openDir(params?: { title?: string }): Promise<string | null>
  saveFile(params?: {
    title?: string
    defaultPath?: string
    filters?: Array<{ name: string; extensions: string[] }>
  }): Promise<string | null>
  /** 递归收集文件夹内全部视频文件（对齐 PR#3 collect_video_files） */
  collectVideos(params?: {
    root: string
    exts?: string[]
    limit?: number
    skipDirs?: string[]
  }): Promise<string[]>
}

// --------------------------------------------------------------------
// downloads
// --------------------------------------------------------------------
declare interface TintinBridgeDownloadProgress {
  speed: number
  percent: number
  downloaded: number
  total: number
}
declare interface TintinBridgeDownloadDone {
  finalPath: string
  size: number
}
declare interface TintinBridgeDownloads {
  start(params: {
    url: string
    savePath: string
    referer?: string
    headers?: Record<string, string>
  }): Promise<string>
  pause(taskId: string): void
  resume(taskId: string): void
  cancel(taskId: string): void
  onProgress(
    taskId: string,
    cb: (p: TintinBridgeDownloadProgress) => void
  ): () => void
  onDone(taskId: string, cb: (p: TintinBridgeDownloadDone) => void): () => void
}

// --------------------------------------------------------------------
// server — 通用兜底 + 业务级方法（类型对齐 server-api.ts）
// --------------------------------------------------------------------
type IpcError<T> = T | null | { error: string }

declare interface TintinBridgeServer {
  // 通用兜底：保持与旧版本兼容，允许业务层直接按路径调用
  get<T = any>(path: string, params?: Record<string, any>): Promise<T | null>
  post<T = any>(path: string, body?: any, headers?: Record<string, string>): Promise<T | null>
  put<T = any>(path: string, body?: any, headers?: Record<string, string>): Promise<T | null>
  delete<T = any>(path: string, params?: Record<string, any>): Promise<T | null>
  upload<T = any>(
    path: string,
    fields: Record<string, Blob | string>,
    onProgress?: (percent: number) => void
  ): Promise<T | null>
  sse(
    path: string,
    onEvent: (data: any) => void,
    onError?: (err: any) => void
  ): () => void
  downloadResult(path: string, savePath: string): Promise<string | null>

  // ---------- health / stats ----------
  healthCapabilities(): Promise<IpcError<HealthAPI.CapabilitiesResponse>>
  statsWorkbench(): Promise<IpcError<StatsAPI.WorkbenchResponse>>

  // ---------- agent ----------
  agentRegistry(): Promise<IpcError<CapabilityRegistryItem[]>>
  agentTaskList(params?: { page?: number; page_size?: number }): Promise<IpcError<{ tasks: any[]; total?: number }>>
  agentSubmitTask(
    payload: AgentAPI.SubmitTaskRequest
  ): Promise<IpcError<AgentAPI.SubmitTaskResponse>>
  agentTaskAction(params: {
    id: string
    action: 'confirm' | 'pause' | 'resume' | 'retry' | 'cancel'
    reason?: string
    /** 人审决策点字段（PRD-human-in-loop-choices）：confirm body 透传——
     *  提交 {decision_id, choice:[...]} / 拒绝 {decision_id, action:'reject', reason} */
    decision?: Record<string, unknown>
  }): Promise<IpcError<any>>
  agentRegisterArtifact(
    payload: AgentAPI.RegisterArtifactRequest
  ): Promise<IpcError<ArtifactItem>>

  // ---------- agent chat（工作台 AI 对话真实链路 P1）----------
  /** GET /agent/agents（智能体列表；离线 null / 5xx {error}，解析见 workbenchChatContext.parseAgentsResponse） */
  agentAgents(): Promise<IpcError<AgentAPI.AgentsResponse>>
  /** POST /agent/chat（max_rounds 默认 3、stream:false；sessionId 续接服务端会话；离线 null / 5xx {error}） */
  agentChat(
    payload: AgentAPI.ChatIpcRequest
  ): Promise<IpcError<AgentAPI.ChatResponse>>
  /** GET /agent/sessions?machine_id=&limit=（machine_id 主进程注入） */
  agentSessions(params?: {
    limit?: number
  }): Promise<IpcError<AgentAPI.SessionsResponse>>
  /** DELETE /agent/sessions/{id}（素材池一并清理） */
  agentSessionDelete(id: string): Promise<IpcError<{ ok: boolean }>>
  /** GET /agent/sessions/{id}/attachments（会话素材池列表） */
  agentSessionAttachments(
    id: string
  ): Promise<IpcError<AgentAPI.SessionAttachmentsResponse>>
  /** POST /agent/sessions/{id}/attachments（materialId 引用素材库 | filePath 上传本地附件） */
  agentSessionAttachmentAdd(payload: {
    id: string
    materialId?: number | string
    filePath?: string
  }, onProgress?: (percent: number) => void): Promise<IpcError<AgentAPI.SessionAttachmentAddResponse>>
  /** DELETE /agent/sessions/{id}/attachments/{key}（key=入池返回的 file_ref） */
  agentSessionAttachmentRemove(id: string, key: string): Promise<IpcError<{ ok: boolean }>>

  // ---------- tasks ----------
  tasksUnifiedList(
    params?: TasksAPI.UnifiedListRequest
  ): Promise<IpcError<TasksAPI.UnifiedListResponse>>
  tasksUnifiedItem(id: string): Promise<IpcError<AgentAPI.TaskNode>>
  tasksProgress(id: string): Promise<IpcError<TasksAPI.ProgressResponse>>
  tasksDownloadResult(id: string, savePath: string): Promise<IpcError<string>>

  // ---------- scheduled（服务端定时任务执行记录，对齐原 scheduled_tasks_page.py）----------
  scheduledTasksList(params?: {
    status?: string
    task_type?: string
    page?: number
    size?: number
  }): Promise<IpcError<{ tasks?: any[]; items?: any[]; total?: number }>>
  scheduledTaskItem(id: string): Promise<IpcError<ScheduledAPI.TaskExecRecord>>

  // ---------- V3 S1~S3 媒体工具 ----------
  rembgSubmit(
    payload: RembgAPI.MattingRequest,
    onProgress?: (percent: number) => void
  ): Promise<IpcError<RembgAPI.MattingResponse>>
  vsrSubmit(
    payload: VSRAPI.EnhanceRequest,
    onProgress?: (percent: number) => void
  ): Promise<IpcError<VSRAPI.EnhanceResponse>>
  vsrRemove(
    payload: VSRAPI.RemoveRequest,
    onProgress?: (percent: number) => void
  ): Promise<IpcError<VSRAPI.RemoveResponse>>
  visionReversePrompt(
    payload: VisionAPI.ReversePromptRequest,
    onProgress?: (percent: number) => void
  ): Promise<IpcError<VisionAPI.ReversePromptResponse>>

  // ---------- asr / tts ----------
  asrTranscribe(
    payload: ASRAPI.TranscribeRequest,
    onProgress?: (percent: number) => void
  ): Promise<IpcError<ASRAPI.TranscribeResponse>>
  ttsGenerate(
    payload: TTSAPI.GenerateRequest
  ): Promise<IpcError<TTSAPI.GenerateResponse>>
  /** 将 base64 音频写入本地文件（或 fromPath 复制模式）；相对路径统一解析到 userData 下，返回绝对路径 */
  ttsSaveAudio(payload: { base64?: string; fromPath?: string; savePath: string }): Promise<string | { error: string }>
  ttsVoicesSamples(params?: {
    speaker?: string
    cloned_only?: boolean
    page?: number
    page_size?: number
  }): Promise<IpcError<TTSAPI.VoicesSamplesResponse>>
  ttsUploadSample(
    payload: TTSAPI.UploadSampleRequest,
    onProgress?: (percent: number) => void
  ): Promise<IpcError<TTSAPI.UploadSampleResponse>>
  /** 取回样本音频（audio_url 为相对路径，主进程拼 baseUrl 取回），返回 base64 供试听 */
  ttsFetchSampleAudio(payload: { url: string }): Promise<{ audio_base64: string; content_type?: string } | { error: string } | null>

  // ---------- 智能混剪 Step3 口播配音（原版 VoiceCloneWorker/VideoDubbingWorker 主进程化）----------
  /** 扫描视频输入目录（对照 _do_scan_voice_video_dir：无 .flv，自动检测 voices/voice_N.wav 与伴随 .txt） */
  voiceScanDir(payload: { dirPath: string; selectedFiles?: string[] }): Promise<{
    files: Array<{ path: string; name: string; wavPath: string; originalText: string; durationSec: number }>
    voicesDir: string
  } | { error: string }>
  /** 批量克隆人声（TTS 逐句 + wav 拼接 + 变速 + .timing.json；对照 VoiceCloneWorker api 模式） */
  voiceCloneBatch(payload: {
    tasks: Array<{ rowIdx: number; text: string; videoPath: string; outWavPath: string }>
    refAudioPath: string
    /** 服务端样本库参考声音（/voice/samples audio_url；主进程下载后转 b64 prompt_audio） */
    refAudioUrl?: string
    apiUrl: string
    speedMin: number
    speedMax: number
    progressChannel?: string
  }): Promise<{ results: Record<string, string>; durations: Record<string, number>; failures: Array<{ rowIdx: number; msg: string }> } | { error: string }>
  /** 批量替换原声（ffmpeg 字幕/花字/atempo；对照 VideoDubbingWorker） */
  voiceDubVideos(payload: {
    tasks: Array<{ videoPath: string; voiceWavPath: string; outVideoPath: string; text: string }>
    addSubtitles: boolean
    lengthModes: Record<string, string>
    fancyText: boolean
    fancyStyle: string
    fancyWords: string[]
    subtitleFont: string
    progressChannel?: string
  }): Promise<{ results: Record<string, string> } | { error: string; results?: Record<string, string> }>
  /** 服务端字体列表（GET /config/fonts） */
  voiceFonts(): Promise<{ fonts: Array<{ id: string; family: string; filename?: string }> } | { error: string } | null>
  /** 导出克隆声音（copy2 到用户选的保存路径） */
  voiceExportAudio(payload: { srcPath: string; savePath: string }): Promise<{ ok: boolean; savePath: string } | { error: string }>
  /** 订阅 voice 域进度事件（返回取消订阅函数） */
  onVoiceProgress(channel: string, cb: (d: { rowIdx?: number; value?: number; stage?: string }) => void): () => void

  // ---------- 智能混剪 Step4 特效包装（FinalMixWorker 主进程化 + 剪映草稿导出）----------
  /** 最终混音合成（本地 ffmpeg：sidechain ducking + 淡入淡出 + loudnorm；无 BGM -c copy） */
  finalMix(payload: {
    tasks: Array<{ videoPath: string; outPath: string }>
    bgmPath: string
    bgmVolume: number
    progressChannel?: string
  }): Promise<{ results: string[] } | { error: string }>
  /** 回退扫描 outputs 排列视频（_collect_mix_candidates 回退段 + _get_out_montage_dir 规则） */
  finalCollectOutputs(payload: { dirPath: string }): Promise<{ files: string[]; outDir?: string } | { error: string }>
  /** 查找视频同目录配套 .srt（_find_srt_for_video：兼容 dubbed_/final_ 前缀） */
  finalFindSrt(payload: { videoPath: string }): Promise<{ srtPath: string } | { error: string }>
  /** 剪映专业版草稿导出（JianyingExporter 一比一；mode single=单视频 / multi=多片段时间轴带转场） */
  jianyingExport(payload: {
    mode: 'single' | 'multi'
    videoPath?: string
    videoPaths?: string[]
    transitions?: string | string[] | null
    bgmPath?: string
    bgmVolume?: number
    srtPath?: string
    srtPaths?: Array<string | null>
    draftName?: string
  }): Promise<{ success: boolean; message: string }>
  /** AI 生成 BGM 服务端 URL 下载落盘（本端扩展：本地混音需本地文件） */
  bgmDownloadUrl(payload: { url: string; destDir: string }): Promise<{ path: string } | { error: string } | null>

  // ---------- workflow（CoverMaker 一键成片编排）----------
  workflowRun(
    payload: WorkflowAPI.RunRequest
  ): Promise<IpcError<WorkflowAPI.RunResponse>>

  // ---------- llm ----------
  llmChat(
    payload: LLMAPI.ChatCompletionsRequest
  ): Promise<IpcError<LLMAPI.ChatCompletionsResponse>>
  llmAdjustCopywriting(payload: {
    script_id?: string
    text?: string
    instruction?: string
    [k: string]: any
  }): Promise<IpcError<any>>
  /** GET /llm/models → 设置页「默认模型」下拉数据源（离线返回 null 或 {error}） */
  llmModels(): Promise<IpcError<LLMAPI.LlmModelsResponse>>

  // ---------- material ----------
  materialList(
    params?: MaterialAPI.ListRequest
  ): Promise<IpcError<MaterialAPI.ListResponse>>
  materialStockSearch(
    payload: MaterialAPI.StockSearchRequest
  ): Promise<IpcError<MaterialAPI.StockSearchResponse>>
  materialOcr(
    payload: MaterialAPI.OcrRequest,
    onProgress?: (percent: number) => void
  ): Promise<IpcError<MaterialAPI.OcrResponse>>

  // ---------- montage / prompt（M6/M8 条目⑥⑦ 服务端链路）----------
  montageSplit(
    payload: MontageAPI.SplitRequest,
    onProgress?: (percent: number) => void
  ): Promise<IpcError<MontageAPI.SplitResponse>>
  montageConcat(
    payload: MontageAPI.ConcatRequest,
    onProgress?: (percent: number) => void
  ): Promise<IpcError<MontageAPI.ConcatResponse>>
  montageBgm(
    payload: MontageAPI.BgmRequest,
    onProgress?: (percent: number) => void
  ): Promise<IpcError<MontageAPI.BgmResponse>>
  /** 清空混剪任务缓存（对照原版 _clear_montage_cache：删 montage_cache 下任务目录，不动原始素材） */
  clearMontageCache(dir: string): Promise<{ ok: boolean } | { error: string }>
  /** POST /audio/gen/bgm — 生成 BGM（MusicGen-small；2026-09-05 服务端 GUIDE 新口径 {style,mood?,duration}，无 prompt），生成即出 {url, duration, engine} */
  audioGenBgm(payload: AudioAPI.GenBgmRequest): Promise<IpcError<AudioAPI.GenBgmResponse>>
  /** POST /audio/gen/sfx — AI 生成音效（AudioLDM2，原客户端 gen_sfx 同口径 {prompt,duration}） */
  audioGenSfx(payload: AudioAPI.GenSfxRequest): Promise<IpcError<AudioAPI.GenSfxResponse>>
  /** POST /audio/bgm/upload — 上传 BGM 入库（2026-09-04 服务端契约更新：multipart file+style/scene/mood/tags，tag 字段移除） */
  audioBgmUpload(payload: AudioAPI.BgmUploadRequest): Promise<IpcError<AudioAPI.BgmUploadResponse>>
  /** POST /audio/library/upload — 音频库直传（2026-09-05 服务端音频分流 audio_library 表：
   *  保存音效入库走此通道 category='音效'；/sfx 音效库不进左列表） */
  audioLibraryUpload(payload: AudioAPI.LibraryUploadRequest): Promise<IpcError<Record<string, unknown>>>
  /** @deprecated POST /sfx/analyze — 旧音效库分析入库（音频已分流 audio_library，客户端不再调用，保留待清理） */
  audioSfxAnalyze(payload: AudioAPI.SfxAnalyzeRequest): Promise<IpcError<AudioAPI.SfxAnalyzeResponse>>
  /** 生成结果 URL 下载临时目录（本端扩展：入库需本地文件，ext 按 Content-Type 判定） */
  audioDownloadTemp(payload: AudioAPI.DownloadTempRequest): Promise<AudioAPI.DownloadTempResponse>
  promptVideo(
    payload: MontageAPI.PromptVideoRequest,
    onProgress?: (percent: number) => void
  ): Promise<IpcError<MontageAPI.PromptVideoResponse>>

  // ---------- storyboard ----------
  storyboardListScripts(params?: {
    source?: string
    page?: number
    page_size?: number
  }): Promise<IpcError<PaginatedResponse<StoryboardAPI.Script>>>
  storyboardSaveScript(
    payload: StoryboardAPI.Script
  ): Promise<IpcError<StoryboardAPI.Script>>

  // ---------- system ----------
  systemLicenseVerify(payload: {
    activation_code: string
  }): Promise<IpcError<SystemAPI.LicenseVerifyResponse>>
}

// --------------------------------------------------------------------
// ffmpeg / shell / bridge
// --------------------------------------------------------------------
declare interface TintinBridgeFfprobeResult {
  duration: number
  width: number
  height: number
  fps: number
  codec: string
  audio_bitrate: number
}
declare interface TintinBridgeFfmpeg {
  probe(file: string): Promise<TintinBridgeFfprobeResult>
  extractThumb(video: string, atSec: number, w?: number): Promise<string>
  /**
   * 批量抽帧 + base64（视觉模型研判类工具共用：视频评价预测/视频营销检测）。
   * 对照原客户端 hook_score_page.py / marketing_detect_page.py 抽帧段：
   * 输出目录由主进程按 tag 在 tmpdir 下清空重建，逐帧 scale=width:-2 / -q:v quality。
   * 抽帧时间点由渲染层纯函数计算，主进程不做策略决策。
   */
  extractFrames(payload: {
    videoPath: string
    times: number[]
    tag?: string
    width?: number
    quality?: number
  }): Promise<{
    frames?: Array<{ path: string; timeSec: number; base64: string }>
    outDir?: string
    error?: string
  }>
  /** 封面片头嵌入（原版 embed_cover_to_video 同语义：封面 2s 片头 concat + 音频延迟） */
  embedCover(
    video: string,
    cover: string,
    outPath: string,
    durationSec?: number
  ): Promise<string>
  concatSegments(paths: string[], outPath: string): Promise<string>
  extractAudio(video: string, outPath: string, format?: string): Promise<string>
  /**
   * 带缓存音频提取（M9 直播切片，原版 page.py L469-601 同口径）：
   * meta（mtime+size+路径）校验通过且未强制 → 复用缓存；否则按原版
   * AudioExtractWorker 同参数（pcm_s16le/16kHz/单声道 wav）重新提取。
   */
  extractAudioCached(
    video: string,
    forceReextract?: boolean
  ): Promise<{ path: string; cached: boolean; error?: string }>
  /** opts.reencode：两段式精确 seek + 重编码（原版 VideoClipWorker 同口径）；opts.srtPath：烧录切片段字幕 */
  cut(
    video: string,
    outPath: string,
    startSec: number,
    endSec: number,
    opts?: { reencode?: boolean; srtPath?: string }
  ): Promise<string>
}

/** 直播切片 M9 本地文件 I/O（渲染层策略 + 主进程纯 I/O，见 main/liveclip-ipc.js） */
declare interface TintinBridgeLiveclip {
  writeImageFile(payload: { path: string; base64: string }): Promise<{ ok?: boolean; path?: string; error?: string }>
  writeTextFile(payload: { path: string; content: string }): Promise<{ ok?: boolean; path?: string; error?: string }>
  writeTempText(payload: { basename: string; content: string }): Promise<{ path?: string; error?: string }>
}
declare interface TintinBridgeShell {
  openExternal(url: string): void
  showNotification(
    title: string,
    body: string,
    icon?: string,
    onClick?: () => void
  ): void
  openItem(path: string): void
  revealInFolder(path: string): void
}
declare interface TintinBridgeStatus {
  ready: boolean
  port: number
}
declare interface TintinBridgeBridge {
  getStatus(): Promise<TintinBridgeStatus>
  navigate(path: string): Promise<void>
}

// --------------------------------------------------------------------
// P1.5 厚壳化：win（自绘标题栏 + 窗口控制，§1.3.1 A3）
// --------------------------------------------------------------------
declare interface TintinBridgeWinState {
  width: number
  height: number
  x: number
  y: number
  minimized: boolean
  maximized: boolean
  fullscreen: boolean
  resizable: boolean
  maximizable: boolean
  minimizable: boolean
  closable: boolean
  focused: boolean
  title: string
}
declare interface TintinBridgeWin {
  getState(): Promise<{ success: boolean; data?: TintinBridgeWinState; error?: string }>
  minimize(): Promise<{ success: boolean; error?: string }>
  toggleMaximize(): Promise<{ success: boolean; data?: TintinBridgeWinState; error?: string }>
  close(): Promise<{ success: boolean; error?: string }>
  onStateChange(cb: (state: TintinBridgeWinState) => void): () => void
}

// --------------------------------------------------------------------
// P1.5 厚壳化：browser（BrowserView 真嵌入，§1.3.2 B3+B4+B6）
// --------------------------------------------------------------------
declare type BrowserPlatformId = 'douyin' | 'weixin' | 'kuaishou' | 'xiaohongshu' | 'bilibili' | 'youtube' | 'jimeng'
declare interface BrowserAttachResult {
  platformId: BrowserPlatformId
  currentUrl: string
  canGoBack: boolean
  canGoForward: boolean
  title: string
}
declare interface BrowserNavigateResult {
  platformId: BrowserPlatformId
  currentUrl: string
  canGoBack: boolean
  canGoForward: boolean
}
declare interface BrowserBounds {
  platformId: BrowserPlatformId
  x: number
  y: number
  width: number
  height: number
}

/** Cherry Studio：BrowserView bounds 校验报告（期望值 vs Electron 实际生效值） */
declare interface BrowserBoundsVerifyReport {
  platformId: BrowserPlatformId
  /** 是否 attach 在主窗口 getBrowserViews() 内 */
  attached: boolean
  /** 是否在窗口可见范围内（排除负值/越界） */
  visible: boolean
  actual: { x: number; y: number; width: number; height: number }
  expected?: { x: number; y: number; width: number; height: number }
  /** 最大边差，单位 px */
  deltaPx?: number
  tolerancePx: number
  /** 是否在容忍阈值内（<= 3px 算 OK） */
  withinTolerance?: boolean
  /** 主窗口尺寸（用于越界诊断） */
  winSize: { width: number; height: number }
  ts: number
}

declare interface TintinBridgeBrowser {
  attachPlatform(platformId: BrowserPlatformId, seedUrl?: string):
    Promise<{ success: boolean; data?: BrowserAttachResult; error?: string }>
  detachAll(): Promise<{ success: boolean; error?: string }>
  setBounds(bounds: BrowserBounds):
    Promise<{
      success: boolean
      data?: { x: number; y: number; width: number; height: number }
      verify?: {
        expected: { x: number; y: number; width: number; height: number }
        actual:   { x: number; y: number; width: number; height: number }
        deltaPx: number
        tolerancePx: number
        withinTolerance: boolean
      }
      error?: string
    }>
  navigate(payload: {
    platformId: BrowserPlatformId
    back?: boolean
    forward?: boolean
    reload?: boolean
    url?: string
  }): Promise<{ success: boolean; data?: BrowserNavigateResult; error?: string }>
  extractDOM(platformId: BrowserPlatformId):
    Promise<{ success: boolean; ok?: boolean; data?: any; error?: { type: string; message: string; hint?: string } }>
  /** 浮动面板：独立原生窗口（扩展/设置/下载）；openSettingsPanel 的 data 为平台列表 [{id,name,badge}] */
  openExtensionsPanel(x: number, y: number): void
  closeExtensionsPanel(): void
  openSettingsPanel(x: number, y: number, data?: { id: string; name: string; badge: string }[]): void
  closeSettingsPanel(): void
  /** 下载管理浮窗：独立原生窗口（历史 + 文件操作；实时进度内嵌嗅探卡片） */
  openDownloadsPanel(x: number, y: number): void
  closeDownloadsPanel(): void
  /** Cherry Studio：主动校验 bounds（渲染端期望 vs 主进程实际） */
  verifyBounds(payload: {
    platformId: BrowserPlatformId
    expected?: { x: number; y: number; width: number; height: number }
  }): Promise<{ success: boolean; data?: BrowserBoundsVerifyReport; error?: string }>
  onUrlUpdated(cb: (payload: { platformId: BrowserPlatformId; url: string; ts: number; inPage?: boolean }) => void): () => void
  onDownloadsUpdated(cb: (payload: {
    platformId: BrowserPlatformId
    kind: 'will-download' | 'progress' | 'completed' | 'cancelled' | 'interrupted' | string
    filename: string
    size?: number
    receivedBytes?: number
    totalBytes?: number
    percent?: number
    savePath?: string
    sourceUrl?: string
  }) => void): () => void
  /** Cherry Studio：订阅 BrowserView did-stop-loading 广播 → 收到立刻重算 bounds */
  onViewReady(cb: (payload: { platformId: BrowserPlatformId; url: string; title: string; ts: number }) => void): () => void
  /** B站扩展下载链接订阅 */
  onBiliExtDownloads(cb: (payload: {
    platformId: BrowserPlatformId
    payload: {
      source: string
      title: string
      downloads: Array<{ url: string; download: string; text: string; sizeText: string }>
      url: string
      ts: number
    }
    ts: number
  }) => void): () => void
  /** 安装扩展（crx/zip）→ 对每个平台隔离 session 逐个 loadExtension */
  installExtension(filePath: string): Promise<{ success: boolean; message?: string; data?: any }>
  /** 卸载扩展 */
  uninstallExtension(id: string): Promise<{ success: boolean; message?: string }>
  /** 扩展列表变更订阅（安装/卸载后主进程广播） */
  onExtensionsChanged(cb: () => void): () => void
  /** 列出平台 partition cookies（条目⑧ 登录态检测链路；cookie 字段已摘要化，不含 value） */
  cookieList(platformId: string): Promise<{
    success: boolean
    data?: { platformId: string; count: number; cookies: Array<{
      name: string; domain: string; path: string; secure: boolean; httpOnly: boolean; session: boolean; expirationDate?: number
    }> }
    error?: string
  }>
  /** 清除平台 partition cookies */
  cookieClear(platformId: string): Promise<{ success: boolean; error?: string }>
}

// --------------------------------------------------------------------
// 条目⑩ 账号与登录：飞书连接测试（凭据补全在主进程，明文不出展示层）
// --------------------------------------------------------------------
declare interface TintinBridgeFeishu {
  testConn(payload: { appId: string; appSecret: string }): Promise<{ ok: boolean; message: string }>
}

// --------------------------------------------------------------------
// A2 双模式推理（§1.5）—— 类型声明（保持简洁，业务层按需细化）
// --------------------------------------------------------------------
declare interface TintinBridgeConfig {
  get<T = any>(key: string, defaultValue?: T): Promise<T>
  set(key: string | Record<string, any>, value?: any): Promise<boolean>
}
declare interface TintinBridgeModel {
  listPkgs(): Promise<any>
  downloadPkg(pkgId: string): Promise<any>
  cancelPkg(pkgId: string): Promise<any>
  uninstallPkg(pkgId: string): Promise<any>
}
declare interface TintinBridgeInference {
  getCapability(force?: boolean): Promise<any>
  setMode(mode: 'server-only' | 'hybrid-auto' | 'force-local'): Promise<any>
}
declare interface TintinBridgeOcr {
  imageToText(payload: any, onProgress?: (percent: number) => void): Promise<any>
}
declare interface TintinBridgeKnowledge {
  listDocuments(params?: any): Promise<any>
  deleteDocument(id: string): Promise<any>
  vectorSearch(payload: any): Promise<any>
}

// --------------------------------------------------------------------
// D4 浏览器域独立窗口（browserWindow:open —— 主窗口按钮 / hotspot 到点打开）
// --------------------------------------------------------------------
declare interface TintinBridgeBrowserWindow {
  /** 打开浏览器独立窗口（单实例：已存在 → 恢复 + 聚焦；hotspot=true 时窗口就绪后补发热点导航信号） */
  open(opts?: { hotspot?: boolean; count?: number | null }): Promise<{
    success: boolean
    created?: boolean
    error?: string
  }>
}

// --------------------------------------------------------------------
// 办公能力集成（office:* 主进程 handler，PRD §4.2）
// 主窗口经 tintin.office.*（preload.js），浏览器窗口经 tintinBrowser.office.*
// （browser-preload.js），通道同源复用（office:saveFile / openPath /
//   previewDocx / readXlsx）；错误态统一 { error }，取消保存返回 { saved:false }。
// --------------------------------------------------------------------
declare interface TintinBridgeOffice {
  /** 系统保存对话框 + 写入；返回 {saved:true,path} | {saved:false}(取消) | {error} */
  saveFile(payload: {
    filename: string
    ext: 'docx' | 'xlsx'
    data: ArrayBuffer | Uint8Array
  }): Promise<{ saved: boolean; path?: string; error?: string }>
  /** 系统默认程序打开（shell.openPath）→ {ok} | {ok:false,error} */
  openPath(filePath: string): Promise<{ ok: boolean; error?: string }>
  /** docx → HTML（mammoth 主进程转换 + 样式注入）→ {html} | {error} */
  previewDocx(filePath: string): Promise<{ html?: string; error?: string }>
  /** xlsx → 多 Sheet 表格（exceljs 读，首 200 行截断）→ {sheets} | {error} */
  readXlsx(filePath: string): Promise<{
    sheets?: Array<{ name: string; rows: any[][] }>
    error?: string
  }>
}

// --------------------------------------------------------------------
// 视频评价预测记录库（prediction:* 主进程 handler）
// 对照原客户端 studio/utils/video_prediction_manager.py：
//   保存每次预测结果 + 发布后回填的真实播放量/平台评价，
//   「预测 vs 实际」对照反哺下次预测（校准文本由渲染层纯函数拼接）。
// 存储：userData/video_predictions.json（JSON Manager 模式，同 creators-store）。
// --------------------------------------------------------------------
declare interface TintinVideoPredictionRecord {
  id: string
  video_path: string
  video_name: string
  platform: string
  /** 模型输出的评分 JSON（total/play_level/golden3s/dims/comment/suggestions） */
  predicted: Record<string, any>
  /** 回填后为 { play_count, platform_eval, at }；未回填为 null */
  actual: { play_count: string; platform_eval: string; at: number } | null
  created_at: number
}
declare interface TintinBridgePrediction {
  /** 全量记录（倒序，最新在前） */
  list(): Promise<{ items?: TintinVideoPredictionRecord[]; error?: string }>
  /** 新增一条预测记录，返回其 id（对照 add_prediction） */
  add(payload: {
    videoPath: string
    platform: string
    predicted: Record<string, any>
  }): Promise<{ id?: string; error?: string }>
  /** 回填真实数据（对照 set_feedback） */
  setFeedback(payload: {
    id: string
    playCount: string
    platformEval: string
  }): Promise<{ ok?: boolean; error?: string }>
}

declare interface TintinBridge {
  app: TintinBridgeApp
  dialog: TintinBridgeDialog
  downloads: TintinBridgeDownloads
  server: TintinBridgeServer
  ffmpeg: TintinBridgeFfmpeg
  // M9 直播切片（封面/导出字幕/临时烧字幕 SRT）
  liveclip: TintinBridgeLiveclip
  shell: TintinBridgeShell
  bridge: TintinBridgeBridge
  // P1.5 厚壳化
  win: TintinBridgeWin
  browser: TintinBridgeBrowser
  // D4 浏览器域独立窗口
  browserWindow: TintinBridgeBrowserWindow
  // 办公能力集成（office:*）
  office: TintinBridgeOffice
  // 视频评价预测记录库（prediction:*）
  prediction: TintinBridgePrediction
  // A2 双模式
  config: TintinBridgeConfig
  model: TintinBridgeModel
  inference: TintinBridgeInference
  ocr: TintinBridgeOcr
  knowledge: TintinBridgeKnowledge
  // P2 本地定时任务（schtasks）
  scheduled: TintinBridgeScheduled
  // 条目⑩ 账号与登录（飞书）
  feishu: TintinBridgeFeishu
  clientTasks: TintinBridgeClientTasks // W11 客户端任务活动订阅（client-task:activity → 任务队列实时刷新）
}
declare interface TintinBridgeClientTasks {
  /** 订阅客户端任务活动事件（返回取消函数） */ onActivity(cb: (payload: { type?: string; task_id?: string; ok?: boolean; status?: string }) => void): () => void
}

// --------------------------------------------------------------------
// scheduled — 本地定时任务（对照原客户端 utils/local_scheduler.py）
// --------------------------------------------------------------------
/** LLM 拆解出的执行步骤（对齐原版 build_plan 产物 / 服务端 mode=execute 契约） */
declare interface TintinBridgeAgentPlan {
  goal: string
  steps: Array<{
    id: string
    capability: string
    params: Record<string, unknown>
    depends_on: string[]
    needs_user_input: boolean
  }>
}

declare interface TintinBridgeScheduledTask {
  task_name: string
  name: string
  type: 'hotspot' | 'agent'
  schedule: { mode: 'daily' | 'weekly'; time: string; weekdays: number[] }
  goal: string
  plan?: TintinBridgeAgentPlan | null
  created_at: string
  registered?: boolean
  next_run?: string
  last_run?: string
  last_result?: string
}
export type { TintinBridgeScheduledTask, TintinBridgeAgentPlan }
declare interface TintinBridgeScheduled {
  list(): Promise<TintinBridgeScheduledTask[]>
  create(payload: {
            name: string
            taskType: 'hotspot' | 'agent'
            schedule: { mode: 'daily' | 'weekly'; time: string; weekdays?: number[] }
            goal?: string
            plan?: TintinBridgeAgentPlan | null
          }): Promise<[boolean, string]>
          /** LLM 拆解任务描述 → [true, plan] 或 [false, 错误信息]（对照原版 build_plan） */
  splitPlan(goal: string): Promise<[boolean, TintinBridgeAgentPlan | string]>
  run(taskName: string): Promise<[boolean, string]>
  delete(name: string): Promise<[boolean, string]>
  /** 手动采集今日各平台热榜 → [true, 采集条数] 或 [false, 错误信息]（对照原版「一键采集」） */
  captureHotspots(): Promise<[boolean, number | string]>
  /** 采集进度推送：{ platform, index, total } */
  onScheduledCaptureProgress(cb: (p: { platform: string; index: number; total: number }) => void): () => void
  /** hotspot 到点触发（采集完成后通知切浏览器 Tab；payload.count = 采集条数，可能为 null） */
  onScheduledHotspot(cb: (payload?: { count?: number | null }) => void): () => void
}

// --------------------------------------------------------------------
// D3 浏览器域独立 preload：window.tintinBrowser（browser-preload.js）
// 浏览器域（src/browser/）只经本命名空间走 IPC，与 window.tintin（主应用）隔离。
// 复用既有类型：TintinBridgeBrowser / TintinBridgeScheduled /
//   TintinBridgeConfig / TintinBridgeWin（见上）。
// --------------------------------------------------------------------
declare interface TintinBrowserBridgeBrowser extends TintinBridgeBrowser {
  /** 列出已装扩展（含内置 B站助手 + 用户安装扩展；preload.js 亦暴露但原类型缺漏，此处补全） */
  extensionList(): Promise<{ success: boolean; data?: { installed: boolean; extensions?: Array<{
    id: string; name: string; version: string; path?: string; icon?: string | null; builtin?: boolean; description?: string
  }> } }>
  exportCookies(platformId: string, destPath: string): Promise<{ success: boolean; count?: number; error?: string }>
  getCookieStatus(platformId: string): Promise<{ success: boolean; platformId?: string; hasLoginCookie?: boolean; cookies?: any[] }>
  getCurrentUrl(platformId: string): Promise<{ success: boolean; platformId?: string; url?: string; title?: string }>
  // B9 每日素材（main/daily-assets.js）：按日期扫描下载目录 + 文件定位/打开
  getDailyAssets(): Promise<{ success: boolean; data?: Array<{
    date: string
    files: Array<{ name: string; path: string; size: number; type: 'video' | 'image' | 'text' | 'file' }>
  }>; error?: string }>
  revealFile(filePath: string): Promise<{ success: boolean; error?: string }>
  openFilePath(filePath: string): Promise<{ success: boolean; error?: string }>
}

declare interface TintinBrowserMediaDownload {
  start(params: {
    taskId: string
    url: string
    audioUrl?: string
    filename?: string
    title?: string
    referer?: string
    platformId?: string
    subDir?: string
    useYtdlp?: boolean
  }): Promise<{ success: boolean; taskId?: string; error?: string }>
  pause(taskId: string): Promise<{ success: boolean; error?: string }>
  cancel(taskId: string): Promise<{ success: boolean; error?: string }>
  /** 共享 channel：browser:downloads-updated（{ taskId, status, progress, speed, downloaded, totalSize, filename }） */
  onProgress(cb: (p: any) => void): () => void
}

declare interface TintinBrowserMediaStorage {
  getSniffed(): Promise<{ success: boolean; data?: any[] }>
  saveSniffed(list: any[]): Promise<{ success: boolean }>
  getDownloads(): Promise<{ success: boolean; data?: any[] }>
  saveDownloads(list: any[]): Promise<{ success: boolean }>
  getSettings(): Promise<{ success: boolean; data?: any }>
  saveSettings(s: any): Promise<{ success: boolean }>
  getFavorites(): Promise<{ success: boolean; data?: any[] }>
  saveFavorites(list: any[]): Promise<{ success: boolean }>
  addFavorite(item: any): Promise<{ success: boolean; data?: any[] }>
  removeFavorite(url: string): Promise<{ success: boolean; data?: any[] }>
  export(format: string, filePath: string): Promise<{ success: boolean }>
  import(filePath: string): Promise<{ success: boolean }>
  clearHistory(type: string): Promise<{ success: boolean }>
  openDownloadDir(): Promise<{ success: boolean }>
}

declare interface TintinBrowserHistory {
  open(items: Array<{ index: number; url: string; title: string; timestamp: number }>, x: number, y: number): void
  close(): void
  onNavigate(cb: (index: number) => void): () => void
  onCleared(cb: () => void): () => void
}

// --------------------------------------------------------------------
// B10 达人/创作者库（main/creators-store.js）：达人 JSON 存储 + 主页全量采集
//   采集清单条目落 userData/creators/collected.json（B8 素材库衔接点）
// --------------------------------------------------------------------
declare interface TintinBrowserCreatorItem {
  id: string
  platform: string
  name: string
  homepageUrl?: string
  addedAt?: number
}
declare interface TintinBrowserCollectedItem {
  platform: string
  creatorId: string
  creatorName: string
  title: string
  url: string
  source: string
  date: string
  collectedAt: string
}
declare interface TintinBrowserCreators {
  getCreators(): Promise<{ success: boolean; data?: TintinBrowserCreatorItem[]; error?: string }>
  addCreator(creator: TintinBrowserCreatorItem): Promise<{ success: boolean; data?: TintinBrowserCreatorItem[]; error?: string }>
  deleteCreator(payload: { id: string; platform: string }): Promise<{ success: boolean; data?: TintinBrowserCreatorItem[]; error?: string }>
  getCollected(): Promise<{ success: boolean; data?: TintinBrowserCollectedItem[]; error?: string }>
  collectFromCreator(payload: { creator: TintinBrowserCreatorItem }): Promise<{
    success: boolean
    data?: { count: number; items: TintinBrowserCollectedItem[]; profileUrl: string }
    error?: string
  }>
  /** 采集进度推送：{ phase } */
  onCollectProgress(cb: (p: { phase: string }) => void): () => void
}

// --------------------------------------------------------------------
// B8 素材入库（main/material-import.js）：采集清单/每日素材 →
//   /material/web_download 异步下载任务 → 本地导入任务记录 → 可选分析队列
//   imported 状态：submitted（待处理）/ failed（失败+原因）/ imported（已入库）
// --------------------------------------------------------------------
declare interface TintinBrowserImportTask {
  taskId: string
  url: string
  title?: string
  platform?: string
  shareName?: string
  status?: 'submitted' | 'imported' | 'failed' | string
  submittedAt?: string
  updatedAt?: string
}
declare interface TintinBrowserMaterialImport {
  /** 提交入库：{ items: 采集条目[] | 每日素材[{name,path,...}], opts?: { shareName?, maxFilesize?, format?, enqueueAnalysis? } } */
  import(payload: {
    items: Array<Record<string, any>>
    opts?: {
      shareName?: string
      maxFilesize?: number
      format?: string
      enqueueAnalysis?: boolean
    }
  }): Promise<{
    success: boolean
    error?: string
    data?: {
      submitted: number
      failed: number
      duplicates: number
      noUrl: number
      markedCount: number
      tasks: TintinBrowserImportTask[]
      results: Array<{ url: string; taskId?: string; error?: string }>
      analysis?: unknown
      analysisError?: unknown
      firstError?: string
    }
  }>
  /** 本地导入任务记录（去重/状态跟踪） */
  listTasks(): Promise<{ success: boolean; data?: TintinBrowserImportTask[]; error?: string }>
  /** 轮询服务端下载任务状态（GET /material/web_download/{task_id}）并回写本地记录 */
  status(taskId: string): Promise<{
    success: boolean
    data?: { taskId: string; status: 'submitted' | 'imported' | 'failed' | string; raw: unknown }
    error?: string
  } | null>
}

// --------------------------------------------------------------------
// B12 自动上架：tintinBrowser.autoListing 类型见 types/auto-listing.d.ts
//   （7 条 IPC + 订阅式进度 channel 'auto-listing:progress'）
// --------------------------------------------------------------------
declare interface TintinBrowserBridge {
  browser: TintinBrowserBridgeBrowser
  mediaDownload: TintinBrowserMediaDownload
  mediaStorage: TintinBrowserMediaStorage
  history: TintinBrowserHistory
  scheduled: TintinBridgeScheduled
  config: TintinBridgeConfig
  win: TintinBridgeWin
  creators: TintinBrowserCreators
  materialImport: TintinBrowserMaterialImport
  autoListing: TintinBrowserAutoListing
  /** 办公能力集成（office:* 主进程 handler，与主应用同通道复用） */
  office: TintinBridgeOffice
}

declare global {
  interface Window {
    tintin: Readonly<TintinBridge>
    tintinBrowser: Readonly<TintinBrowserBridge>
  }
}

export {}
