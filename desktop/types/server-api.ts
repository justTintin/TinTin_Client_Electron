// ====================================================================
// server-api.ts — 服务端接口类型桥接层（F-1 → F-2 迁移过渡层）
//
// ⚠️  单一真实来源（SSOT）= desktop/renderer/src/types/api-contract.generated.ts
//     由 `npm run contract:gen` 或 `npm run contract:gen-local` 从服务端
//     OpenAPI 3.1.0 规范生成，任何请求/响应字段名、类型不一致都以它为准。
//
// 本文件三层结构：
//   1. SSOT 锚点  — paths / components 直接 re-export 自契约（权威）
//   2. Contract   — components.schemas 命名 schema 的别名区（权威）
//   3. Common     — 客户端本地业务约定类型（非契约 schema，保留在客户端）
//   4. API_PATHS  — 路径常量（方便 IPC / server-proxy.js 使用，字符串可对比契约）
//   5. Namespaces — 业务域过渡类型（与现有业务代码兼容，字段以契约为准）
//
// F-3 verify-contract.js 会在 CI 中对比本文件 vs 契约的路径/字段漂移。
// 新代码请尽量从 desktop/renderer/src/api/tintin-client.ts 统一入口导入，
// 不要直接 import 本文件（保持跨层路径解耦）。
// ====================================================================

import type {
  paths      as _paths,
  components as _components,
} from '../renderer/src/types/api-contract.generated'

// ─────────────────────────────────────────────────────────────────────
// 0. SSOT 锚点（OpenAPI 契约单一真实来源）
//    业务代码精确引用请求/响应字段时，请用：
//      import type { paths, components } from '@/api/tintin-client'
//      type R = paths['/health/capabilities']['get']['responses'][200]['content']['application/json']
// ─────────────────────────────────────────────────────────────────────
export type paths      = _paths
export type components = _components

// ─────────────────────────────────────────────────────────────────────
// 0b. Contract — 契约命名 schema 锚点区（权威 = 100% 对齐 components.schemas）
//     每次 contract:gen 后若命名 schema 变化，这里会直接报错。
//     命名规则：components.schemas 里的 key 名原样映射为 PascalCase。
// ─────────────────────────────────────────────────────────────────────
export namespace Contract {
  export type Body_ocr_image_material_ocr_post    = _components['schemas']['Body_ocr_image_material_ocr_post']
  export type Body_remove_subtitle_vsr_remove_post = _components['schemas']['Body_remove_subtitle_vsr_remove_post']
  export type Body_split_video_montage_split_post = _components['schemas']['Body_split_video_montage_split_post']
  export type Body_transcribe_whisper_transcribe_post = _components['schemas']['Body_transcribe_whisper_transcribe_post']
  export type OCRLine        = _components['schemas']['OCRLine']
  export type OCRResponse    = _components['schemas']['OCRResponse']
  export type HTTPValidationError = _components['schemas']['HTTPValidationError']
}

// ─────────────────────────────────────────────────────────────────────
// 1. Common — 全局通用类型
//    [注意] 以下类型是客户端-服务端业务约定，未在契约 components.schemas 声明：
//    · TaskIdPrefix / TaskStatus / UnifiedTaskType — 枚举字符串联合
//    · PaginatedResponse<T>                        — 通用分页包装器
//    · ArtifactItem / CapabilityRegistryItem       — 服务端返回为 inline object
//    · CapabilitySwitch                            — GET /health/capabilities 每项子结构
//    校验方式：F-3 verify-contract.js 抽样等价 paths 响应结构匹配。
// ─────────────────────────────────────────────────────────────────────

/** 任务 ID 前缀约定（V2 分工文档 §2 + V3 §2.2）：客户端不新增前缀 */
export type TaskIdPrefix =
  | 'c_'   // 渲染 / 成片任务 / 媒体工具（V3 S1/S2 rembg、vsr 必须复用此前缀）
  | 'a_'   // 智能体编排子任务（父子任务树）
  | 't_'   // 转码 / 后台派生任务

export type TaskStatus =
  | 'queued'             // 排队中
  | 'processing'         // 执行中（含 children_progress）
  | 'waiting_user_input' // 人工确认挂起（PATCH confirm/cancel/resume）
  | 'paused'             // 暂停
  | 'completed'          // 完成
  | 'failed'             // 失败（保留 7 天可 retry）
  | 'cancelled'          // 已取消

/** 成片任务类型枚举（/tasks/unified 过滤） */
export type UnifiedTaskType =
  | 'editor_render'
  | 'digital_human'
  | 'rembg_matting'  // V3 S1
  | 'vsr_enhance'    // V3 S2
  | 'storyboard_export'
  | 'script_generate'
  | 'tts_generate'
  | 'asr_transcribe'

export interface PaginatedResponse<T> {
  items: T[]
  total: number
  page: number
  page_size: number
  has_more: boolean
}

export interface ArtifactItem {
  artifact_id: string
  task_id: string
  name: string
  kind: 'image' | 'video' | 'audio' | 'text' | 'zip' | 'other'
  url?: string            // 本地绝对路径或服务端 GET URL
  size_bytes?: number
  mime_type?: string
  created_at: string
  metadata?: Record<string, any>
}

/** 能力注册表条目（V2 §13 Orchestrator 完整 schema / S1 GET /agent/registry） */
export interface CapabilityRegistryItem {
  key: string                          // 唯一能力 key（eg "llm.chat", "material.stock_search"）
  name: string                         // 人类可读中文名
  description?: string
  category:
    | 'llm' | 'asr' | 'tts' | 'vision'
    | 'material' | 'montage' | 'editor'
    | 'digital_human' | 'agent' | 'system'
  executor: 'server' | 'client_tool' | 'external'  // 执行位置
  endpoint?: string                    // executor=server 时必填，HTTP 路径
  input_schema?: Record<string, any>   // JSON Schema
  output_schema?: Record<string, any>
  requires_approval?: boolean          // 人工确认前置
  poll?: { endpoint: string; interval_sec: number }  // 异步任务轮询地址
  enabled?: boolean
}

/** 能力开关（S4 GET /health/capabilities -> capabilities 下每项的结构） */
export interface CapabilitySwitch {
  enabled: boolean
  models?: string[]        // rembg / llm 等
  modes?: string[]         // vsr: repair/superres/both
  engines?: string[]       // stock_search: pexels/pixabay/...
  url?: string             // 子服务地址（whisper/voice_clone）
  [extra: string]: any
}

// ─────────────────────────────────────────────────────────────────────
// 2. API_PATHS — 路径常量（服务端 URL 名空间，避免字符串散落在业务层）
//
// 【验证】F-3 verify-contract.js 会把本对象所有叶子字符串（string 类型、非函数）
//        与 OpenAPI 契约 paths interface 的 key 做集合对比，
//        任何缺失 / 多余路径都会在 verify 阶段 FAIL，阻断提交。
//        函数形式的路径（如 scriptsItem: id => `/api/storyboard/scripts/${id}`）
//        在 verify 中按 "去掉参数段的前缀" 做抽样匹配。
// ─────────────────────────────────────────────────────────────────────

export const API_PATHS = {
  health: {
    capabilities: '/health/capabilities',
    check:        '/health/check',
  },
  stats: {
    workbench: '/stats/workbench',
  },
  llm: {
    chatCompletions: '/llm/chat/completions',
    adjustCopywriting: '/script/adjust-copywriting',
    list:  '/script/list',
  },
  asr: {
    transcribe: '/whisper/transcribe',
  },
  tts: {
    generate: '/voxcpm/tts',
    cloneVoice: '/voxcpm/clone-voice',
    voicesList: '/voices/list',
    voicesSamples: '/voices/samples',
  },
  workflow: {
    run: '/workflow/run',
  },
  material: {
    list:        '/material/list',
    search:      '/material/search',
    serve:       '/material/serve',
    ocr:         '/material/ocr',
    stockSearch: '/material/stock_search',
    scoreClip:   '/material/score-clip',
  },
  montage: {
    split:    '/montage/split',
    concat:   '/montage/concat',
    beatSync: '/montage/beat',
    auto:     '/montage/auto-mix',
  },
  vsr: {
    enhance: '/vsr/enhance',      // V3 S2
    remove:  '/vsr/remove',
  },
  rembg: {
    matting: '/rembg/matting',    // V3 S1
  },
  vision: {
    reversePrompt: '/vision/reverse-prompt',  // V3 S3
  },
  digitalHuman: {
    generate:   '/digital-human/generate',
    listModels: '/digital-human/models',
  },
  storyboard: {
    scriptsList: '/api/storyboard/scripts',
    scriptsItem: (id: string) => `/api/storyboard/scripts/${id}`,
    save:        '/api/storyboard/scripts',
  },
  agent: {
    registry:              '/agent/registry',
    tasks:                 '/agent/tasks',
    tasksItem:             (id: string) => `/agent/tasks/${id}`,
    tasksItemConfirm:      (id: string) => `/agent/tasks/${id}/confirm`,
    tasksItemPause:        (id: string) => `/agent/tasks/${id}/pause`,
    tasksItemResume:       (id: string) => `/agent/tasks/${id}/resume`,
    tasksItemRetry:        (id: string) => `/agent/tasks/${id}/retry`,
    tasksItemCancel:       (id: string) => `/agent/tasks/${id}/cancel`,
    artifacts:             '/agent/artifacts',
    tasksArtifacts:        (id: string) => `/agent/tasks/${id}/artifacts`,
    chat:                  '/agent/chat',
    sessionsList:          '/agent/sessions',
    sessionsItem:          (id: string) => `/agent/sessions/${id}`,
  },
  tasks: {
    unifiedList:            '/tasks/unified',
    unifiedItem:            (id: string) => `/tasks/unified/${id}`,
    item:                   (id: string) => `/tasks/${id}`,
    itemResult:             (id: string) => `/tasks/${id}/result`,
  },
  scheduled: {
    tasksList: '/scheduled/tasks',
    tasksItem: (id: string) => `/scheduled/tasks/${id}`,
  },
  editor: {
    renderPackage: (id: string) => `/editor/render/${id}/package`,
  },
  system: {
    license: '/system/license',
    guide:   '/guide',
  },
} as const

export type ApiPathLeaf =
  | string
  | ((...args: any[]) => string)

// ─────────────────────────────────────────────────────────────────────
// 3. Namespaces — 业务域过渡类型
//
// ⚠️  过渡说明：
//    本区块类型为"客户端字段快照"，用于与现有业务代码调用（stores/server.ts、
//    stores/tasks.ts、8 个媒体工具组件）保持编译兼容。
//    字段命名与服务端 OpenAPI 契约不一致的点如下（verify-contract 会报告）：
//
//    | 过渡类型                    | 契约权威等价                              | 差异说明
//    +-----------------------------+-------------------------------------------+------------------------------
//    | MaterialAPI.OcrRequest      | Contract.Body_ocr_image_material_ocr_post | 请求字段：image: Blob ↔ file: string
//    | MaterialAPI.OCRResponse     | Contract.OCRResponse                      | 响应字段：过渡版缺 filename/total，多 boxes
//    | ASRAPI.TranscribeRequest    | Contract.Body_transcribe_whisper_..._post | 请求字段：audio ↔ file
//    | VSRAPI.RemoveRequest        | Contract.Body_remove_subtitle_vsr_remove  | 字段集合与命名不完全对齐
//    | Rembg/VSR/Workflow…Request  | 契约 paths[X].post.requestBody            | 本文件声明为 Blob，契约用 multipart File
//
//    新业务代码请使用 paths[path].method.parameters / responses 精确引用，
//    不要直接依赖过渡类型；verify-contract 每次 contract:gen 后会重跑差异扫描。
// ─────────────────────────────────────────────────────────────────────

export namespace HealthAPI {
  export interface CapabilitiesResponse {
    server_time: string
    capabilities: {
      rembg:          CapabilitySwitch
      vsr:            CapabilitySwitch
      vsr_remove:     CapabilitySwitch
      whisper:        CapabilitySwitch
      voice_clone:    CapabilitySwitch
      stock_search:   CapabilitySwitch
      reverse_prompt: CapabilitySwitch
      llm:            CapabilitySwitch
      asr:            CapabilitySwitch
      digital_human:  CapabilitySwitch
      montage:        CapabilitySwitch
      ocr:            CapabilitySwitch
    }
    queue_load: Record<string, number>  // key = 能力名，value = 排队任务数
  }
}

export namespace StatsAPI {
  export interface WorkbenchResponse {
    recentTasks:  number
    runningTasks: number
    scripts:      number
    materials:    number
  }
}

export namespace LLMAPI {
  export interface ChatMessage {
    role: 'system' | 'user' | 'assistant' | 'tool'
    content: string
  }
  export interface ChatCompletionsRequest {
    model: string
    messages: ChatMessage[]
    temperature?: number
    stream?: boolean
  }
  export type ChatCompletionsResponse = {
    id: string
    model: string
    choices: Array<{
      index: number
      message: ChatMessage
      finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter'
    }>
    usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
  }
}

export namespace ASRAPI {
  export interface TranscribeRequest {
    audio:       Blob   // multipart/form-data；客户端上传字段名 = "audio"
    language?:   string
    task?:       'transcribe' | 'translate'
    word_timestamps?: boolean
  }
  export interface TranscribeResponse {
    task_id?:    string
    text:        string
    segments?:   Array<{ start: number; end: number; text: string }>
    language?:   string
    duration_s?: number
  }
}

export namespace TTSAPI {
  export interface GenerateRequest {
    text:       string
    voice_id?:  string           // 缺省用默认音色
    speed?:     number           // 0.5 ~ 2.0
    emotion?:   string
    format?:    'mp3' | 'wav' | 'opus'
    clone_ref_file?: Blob       // 声音克隆参考音频（多 part）
  }
  export interface GenerateResponse {
    task_id?:  string
    audio_url: string            // 相对路径 / 绝对 URL
    duration_s: number
    voice_id: string
  }
  export interface CloneVoiceRequest {
    name: string
    reference_audio: Blob
    description?: string
  }
  export interface CloneVoiceResponse {
    voice_id: string
    sample_url: string
  }
  export interface VoiceItem {
    id:       string
    name:     string
    gender?:  'male' | 'female' | 'neutral'
    language?: string
    preview_url?: string
    is_cloned?: boolean
  }
  export interface VoiceSample {
    id:         string
    name:       string
    duration_s: number
    audio_url:  string
    speaker?:   string
    created_at?: string
  }
  export type VoicesListResponse = VoiceItem[]
  export type VoicesSamplesResponse = VoiceSample[]
}

export namespace WorkflowAPI {
  // CoverMaker 一键成片 workflow 编排接口
  export interface WorkflowNode {
    id: string
    capability_key: string
    input: Record<string, any>
    depends_on?: string[]
  }
  export interface RunRequest {
    title?:    string
    product_context?: Record<string, any>
    nodes:     WorkflowNode[]
    priority?: 0 | 1 | 2
  }
  export interface RunResponse {
    run_id:    string
    task_id?:  string   // 如果编排后合并为一个 c_* 任务
    status:    TaskStatus
    queued_at: string
  }
}

export namespace MaterialAPI {
  export type MediaKind = 'image' | 'video' | 'audio' | 'all'
  export interface ListRequest {
    type?:          MediaKind
    brand?:         string
    model?:         string
    category?:      string
    tags?:          string[]
    min_resolution_w?: number
    duration_range_sec?: [number, number]
    page?:          number
    page_size?:     number
    query?:         string
  }
  export interface MaterialItem {
    id:              string
    path:            string            // 本地绝对路径 或 URL
    thumb:           string
    media_type:      'image' | 'video' | 'audio'
    width?:          number
    height?:         number
    duration?:       number
    brand?:          string
    model?:          string
    tags?:           string[]
    author?:         string
    source?:         string            // stock 引擎 eg pexels
    created_at?:     string
  }
  export type ListResponse = PaginatedResponse<MaterialItem>

  export interface StockSearchRequest {
    query:       string
    kind:        MediaKind
    page?:       number
    page_size?:  number
    engines?:    string[]
    license_required?: boolean
  }
  export type StockSearchResponse = PaginatedResponse<MaterialItem>

  export interface OcrRequest {
    image: Blob
    lang?: 'zh' | 'en' | 'zh+en'
  }
  export interface OcrResponse {
    text: string
    boxes?: Array<{ x0: number; y0: number; x1: number; y1: number; text: string; confidence: number }>
  }
}

export namespace MontageAPI {
  export interface BeatSyncRequest {
    video_path:  string
    audio_path:  string
    sensitivity?: number
  }
  export interface BeatSyncResponse {
    task_id:     string
    beat_points: number[]
    cuesheet:    Array<{ cut_at: number; duration: number }>
  }
  export interface ConcatRequest {
    paths:       string[]
    output_path?: string
    transition?: 'none' | 'fade' | 'dissolve'
  }
  export type ConcatResponse = { task_id: string; output_path: string; duration_s: number }
}

export namespace VSRAPI {
  // V3 S2 POST /vsr/enhance
  export interface EnhanceRequest {
    video:               Blob
    mode?:               'repair' | 'superres' | 'both'
    scale?:              '2x' | '3x' | '4x'
    fps?:                number
    denoise_strength?:   number        // 0-100
    face_restoration?:   boolean
    trim_start_sec?:     number
    trim_end_sec?:       number
  }
  export interface EnhanceResponse {
    task_id:               string
    estimated_wait_sec:    number
  }
  export interface RemoveRequest {
    video:                 Blob
    mode?:                 'watermark' | 'subtitle' | 'both'
    bboxes?:               Array<[number, number, number, number]>  // 水印区域（可选，否则自动识别）
  }
  export type RemoveResponse = { task_id: string; estimated_wait_sec: number }
}

export namespace RembgAPI {
  // V3 S1 POST /rembg/matting
  export interface MattingRequest {
    image:         Blob
    model?:        'u2net' | 'isnet-general-use' | 'birefnet-portrait' | 'sam' | string
    alpha_matting?: boolean
    return_mask?:  boolean
    bg_color?:     string | null   // "#RRGGBB" or null=透明
  }
  export interface MattingResponse {
    task_id: string
    status:  TaskStatus
  }
}

export namespace VisionAPI {
  // V3 S3 POST /vision/reverse-prompt
  export interface ReversePromptRequest {
    file:         Blob          // jpg/png/webp/mp4
    count?:       number        // 1..8
    style?:       'general' | 'midjourney' | 'stable-diffusion' | 'product-photo' | string
    language?:    'zh' | 'en' | 'zh+en'
    frame_count?: number        // 视频关键帧数量
  }
  export interface PromptItem {
    zh:         string
    en:         string
    style_tags: string[]
  }
  export interface ReversePromptResponse {
    model:      string
    elapsed_ms: number
    prompts:    PromptItem[]
  }
}

export namespace DigitalHumanAPI {
  export interface GenerateRequest {
    model_id:     string
    script_text:  string
    voice_id?:    string
    background?:  string
    output_path?: string
  }
  export type GenerateResponse = { task_id: string; estimated_wait_sec: number }
}

export namespace AgentAPI {
  // S1 GET /agent/registry
  export type RegistryResponse = CapabilityRegistryItem[]

  // S2 POST /agent/tasks — 提交编排计划
  export interface SubmitTaskRequest {
    plan_id?:          string
    goal:              string
    product_context?:  Record<string, any>  // {brand, model, category, name, ...}
    capabilities?:     string[]             // 使用的能力 key
    priority?:         0 | 1 | 2
    requires_approval?: boolean
  }
  export interface SubmitTaskResponse {
    task_id:      string          // a_* 前缀
    status:       TaskStatus
    created_at:   string
    children?:    Array<{ id: string; key: string }>
  }

  // S3 GET /tasks/unified/{id} — 父子任务树扩展
  export interface TaskNode {
    id:                string     // a_* 或 c_* 前缀
    parent_task_id?:   string     // 根 = undefined
    title:             string
    capability_key?:   string
    status:            TaskStatus
    progress?:         number     // 0-100
    stage?:            string
    children_progress?: Record<string, number>
    result_preview?:   string
    error_message?:    string
    requires_approval?: boolean
    waiting_reason?:   string     // 仅 status=waiting_user_input 时有值
    created_at:        string
    updated_at:        string
    children?:         TaskNode[]
  }

  // S6 POST /agent/artifacts
  export interface RegisterArtifactRequest {
    task_id:      string
    name:         string
    kind:         ArtifactItem['kind']
    path_or_url:  string
    metadata?:    Record<string, any>
  }
  export type RegisterArtifactResponse = ArtifactItem
}

export namespace TasksAPI {
  export interface UnifiedListRequest {
    types?:       UnifiedTaskType[]
    statuses?:    TaskStatus[]
    search?:      string
    created_from?: string
    created_to?:  string
    page?:        number
    page_size?:   number
  }
  export type UnifiedListResponse = PaginatedResponse<AgentAPI.TaskNode>
  export interface ProgressResponse {
    task_id:    string
    type:       UnifiedTaskType | string
    status:     TaskStatus
    progress:   number
    stage?:     string
    message?:   string
    result_url?: string
    error_message?: string
  }
}

export namespace ScheduledAPI {
  export interface CronItem {
    id:              string
    name:            string
    cron_expression: string
    payload:         Record<string, any>  // 提交到 agent/tasks 的请求
    enabled:         boolean
    last_run_at?:    string
    next_run_at?:    string
  }
}

export namespace StoryboardAPI {
  export interface Shot {
    index:       number
    shot_type?:  string          // 远景/中景/近景/特写
    duration_sec: number
    sfx?:        string
    description: string
    narration?:  string
    materials?:  Array<{
      type:       'local' | 'web_stock'
      path:       string
      thumb?:     string
      stock_id?:  string
      media_type: MaterialAPI.MaterialItem['media_type']
      width?:     number
      height?:    number
      duration?:  number
      author?:    string
      source?:    string
    }>
  }
  export interface Script {
    id?:             string
    title:           string
    source?:         'feishu' | 'manual' | 'ai'
    aspect_ratio?:   '9:16' | '16:9' | '1:1' | string
    product?:        { brand?: string; model?: string; category?: string; name?: string }
    shots:           Shot[]
    tags?:           string[]
    created_at?:     string
    updated_at?:     string
  }
}

export namespace SystemAPI {
  export interface LicenseVerifyRequest {
    activation_code: string
    machine_id:      string
  }
  export interface LicenseVerifyResponse {
    valid:       boolean
    expires_at?: string
    edition?:   'community' | 'professional' | 'enterprise' | string
    features?:  string[]
    message?:   string
  }
}
