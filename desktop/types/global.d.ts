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

  // ---------- montage / audio / prompt（M6/M8 条目⑥⑦ 服务端链路）----------
  montageSplit(
    payload: MontageAPI.SplitRequest,
    onProgress?: (percent: number) => void
  ): Promise<IpcError<MontageAPI.SplitResponse>>
  montageConcat(
    payload: MontageAPI.ConcatRequest,
    onProgress?: (percent: number) => void
  ): Promise<IpcError<MontageAPI.ConcatResponse>>
  montageBeat(
    payload: MontageAPI.BeatRequest,
    onProgress?: (percent: number) => void
  ): Promise<IpcError<MontageAPI.BeatResponse>>
  montageBgm(
    payload: MontageAPI.BgmRequest,
    onProgress?: (percent: number) => void
  ): Promise<IpcError<MontageAPI.BgmResponse>>
  audioBeatmap(
    payload: MontageAPI.BeatmapRequest,
    onProgress?: (percent: number) => void
  ): Promise<IpcError<MontageAPI.BeatmapResponse>>
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
  // D4 浏览器域独立窗口
  browserWindow: TintinBridgeBrowserWindow
  // 办公能力集成（office:*）
  office: TintinBridgeOffice
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
