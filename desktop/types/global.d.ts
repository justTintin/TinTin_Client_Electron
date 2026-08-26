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
  VSRAPI,
  RembgAPI,
  VisionAPI,
  WorkflowAPI,
  AgentAPI,
  TasksAPI,
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
  agentSubmitTask(
    payload: AgentAPI.SubmitTaskRequest
  ): Promise<IpcError<AgentAPI.SubmitTaskResponse>>
  agentTaskAction(params: {
    id: string
    action: 'confirm' | 'pause' | 'resume' | 'retry' | 'cancel'
    reason?: string
  }): Promise<IpcError<any>>
  agentRegisterArtifact(
    payload: AgentAPI.RegisterArtifactRequest
  ): Promise<IpcError<ArtifactItem>>

  // ---------- tasks ----------
  tasksUnifiedList(
    params?: TasksAPI.UnifiedListRequest
  ): Promise<IpcError<TasksAPI.UnifiedListResponse>>
  tasksUnifiedItem(id: string): Promise<IpcError<AgentAPI.TaskNode>>
  tasksProgress(id: string): Promise<IpcError<TasksAPI.ProgressResponse>>
  tasksDownloadResult(id: string, savePath: string): Promise<IpcError<string>>

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
    payload: TTSAPI.GenerateRequest,
    onProgress?: (percent: number) => void
  ): Promise<IpcError<TTSAPI.GenerateResponse>>
  ttsCloneVoice(
    payload: TTSAPI.CloneVoiceRequest,
    onProgress?: (percent: number) => void
  ): Promise<IpcError<TTSAPI.CloneVoiceResponse>>
  ttsVoicesList(params?: {
    language?: string
    page?: number
    page_size?: number
  }): Promise<IpcError<TTSAPI.VoicesListResponse>>
  ttsVoicesSamples(params?: {
    speaker?: string
    cloned_only?: boolean
    page?: number
    page_size?: number
  }): Promise<IpcError<TTSAPI.VoicesSamplesResponse>>

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

  // ---------- montage ----------
  montageConcat(
    payload: MontageAPI.ConcatRequest
  ): Promise<IpcError<MontageAPI.ConcatResponse>>
  montageBeatSync(
    payload: MontageAPI.BeatSyncRequest
  ): Promise<IpcError<MontageAPI.BeatSyncResponse>>

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
  embedCover(
    video: string,
    cover: string,
    outPath: string,
    durationSec?: number
  ): Promise<string>
  concatSegments(paths: string[], outPath: string): Promise<string>
  extractAudio(video: string, outPath: string, format?: string): Promise<string>
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

declare interface TintinBridge {
  app: TintinBridgeApp
  dialog: TintinBridgeDialog
  downloads: TintinBridgeDownloads
  server: TintinBridgeServer
  ffmpeg: TintinBridgeFfmpeg
  shell: TintinBridgeShell
  bridge: TintinBridgeBridge
  // P1.5 厚壳化
  win: TintinBridgeWin
  browser: TintinBridgeBrowser
  // A2 双模式
  config: TintinBridgeConfig
  model: TintinBridgeModel
  inference: TintinBridgeInference
  ocr: TintinBridgeOcr
  knowledge: TintinBridgeKnowledge
}

declare global {
  interface Window {
    tintin: Readonly<TintinBridge>
  }
}

export {}
