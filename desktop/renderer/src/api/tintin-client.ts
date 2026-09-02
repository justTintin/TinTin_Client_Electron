// ═══════════════════════════════════════════════════════════════════
// tintin-client.ts — 基于 OpenAPI 契约的类型安全 API 客户端
//
// 设计思路：
//   1. 渲染层代码使用本客户端调用接口，获得 100% 编译期类型安全
//      （参数名/类型错误、响应字段拼写错误都会在 tsc 阶段报错）
//   2. 底层通过 window.tintin.server 的 IPC 通道发送请求，
//      由主进程 server-proxy.js 转发到外部 AI 推理服务（绕过 CORS）
//   3. 对 GET / POST(JSON) / POST(multipart) 三种模式分别适配：
//        • GET     → server:get(path, query)
//        • POST    → server:post(path, body)
//        • UPLOAD  → server:upload(path, fields)  支持 onProgress
//
// 契约权威：electron/renderer/src/types/api-contract.generated.ts
//           （由服务端 http://192.168.111.31:8000/openapi.json 生成）
// ═══════════════════════════════════════════════════════════════════

import createClient, { type ClientOptions } from 'openapi-fetch'
import type { paths, components } from '../types/api-contract.generated'

// ──────────────────────────────────────────────────────────────────
// 【权威锚点】OpenAPI 3.1.0 契约单一真实来源（SSOT）
//   · paths       — 所有接口路径 + 方法对应的参数/响应类型（openapi-fetch 编译期校验用）
//   · components  — 所有命名 schema：请求体、响应体、错误体等
//
// 业务代码需要精确引用某个接口的请求/响应字段时，直接通过 paths 索引：
//   import type { paths } from '@/api/tintin-client'
//   type Res = paths['/health/capabilities']['get']['responses'][200]['content']['application/json']
//
// 契约生成命令：
//   npm run contract:gen        ← 从服务端 /openapi.json 实时拉取
//   npm run contract:gen-local  ← 从 API-GUIDE 在线页离线生成
//   npm run contract:typecheck  ← tsc 校验生成类型无破坏
// ──────────────────────────────────────────────────────────────────
export type { paths, components }

// ──────────────────────────────────────────────────────────────────
// 常用 schema 快捷别名（从 components.schemas 直接别名，未来可增量补充）
// 渲染层老代码可继续从 server-api.ts import；新代码推荐直接走 paths / components 索引
// ──────────────────────────────────────────────────────────────────
export type OCRResponse = components['schemas']['OCRResponse']
export type OCRLine = components['schemas']['OCRLine']
export type SplitBody = components['schemas']['Body_split_video_montage_split_post']
export type OcrBody = components['schemas']['Body_ocr_image_material_ocr_post']
export type MaterialListQuery =
  paths['/material/list']['get']['parameters'] extends { query?: infer Q } ? Q : never

// ──────────────────────────────────────────────────────────────────
// 业务命名空间 & 常量统一出口（ESM re-export 自 electron/types/server-api 桥接层）
// 渲染层从一个文件就能拿到所有契约类型：
//   import { TaskStatus, API_PATHS, HealthAPI } from '@/api/tintin-client'
//
// 注意：namespace 在 TS 中是"类型+值"混合导出，所以必须用普通 `export { X }`，
//       不能用 `export type { X }`，否则对象式访问（HealthAPI.CapabilitiesResponse）会丢失。
// ──────────────────────────────────────────────────────────────────
export { API_PATHS } from '../../../types/server-api'
export type {
  TaskIdPrefix, TaskStatus, UnifiedTaskType,
  PaginatedResponse, ArtifactItem,
  CapabilityRegistryItem, CapabilitySwitch,
  ApiPathLeaf,
} from '../../../types/server-api'
export {
  HealthAPI, StatsAPI, LLMAPI, ASRAPI, TTSAPI, WorkflowAPI,
  MaterialAPI, MontageAPI, VSRAPI, RembgAPI, VisionAPI,
  DigitalHumanAPI, AgentAPI, TasksAPI, ScheduledAPI, StoryboardAPI, SystemAPI,
} from '../../../types/server-api'

// ──────────────────────────────────────────────────────────────────
// IPC 适配器：把 openapi-fetch 的 Request 对象桥接到 window.tintin.server
// ──────────────────────────────────────────────────────────────────

/** 从 Request URL 中解析出相对 path（去掉 baseUrl 前缀）和 query 对象 */
function parseRequestUrl(req: Request, baseUrl: string) {
  const full = req.url
  const rel = full.startsWith(baseUrl) ? full.slice(baseUrl.length) : full
  const [pathOnly, queryStr] = rel.split('?')
  const query: Record<string, string> = {}
  if (queryStr) {
    const usp = new URLSearchParams(queryStr)
    usp.forEach((v, k) => { query[k] = v })
  }
  return { path: pathOnly, query }
}

/**
 * 判断 body 是否为 FormData（multipart 上传类接口）。
 * 注意：由于 IPC 无法直接序列化 Blob/File，业务层在调用上传接口时
 * 应通过带 onProgress 的专用函数（见下面 montageSplit / materialOcr），
 * 不走该通用 fetch 适配器。这里仅做兜底兼容。
 */
function isFormData(body: BodyInit | null | undefined): body is FormData {
  return typeof FormData !== 'undefined' && body instanceof FormData
}

/**
 * 创建自定义 fetch，底层通过 IPC 的 server:get/post/upload 转发请求。
 * openapi-fetch 会调用这个 fetch 并期待返回标准 Response 对象。
 */
function createIpcFetch(baseUrl: string): ClientOptions['fetch'] {
  return async (input: Request): Promise<Response> => {
    const req = input
    const method = req.method.toUpperCase()
    const { path, query } = parseRequestUrl(req, baseUrl)

    // 离线兜底：window.tintin 尚未注入（渲染层过早调用）
    const tintin = (window as any).tintin
    if (!tintin?.server) {
      return new Response(
        JSON.stringify({ error: 'window.tintin 未就绪（thickShellReady gate 未通过）' }),
        { status: 503, headers: { 'Content-Type': 'application/json' } }
      )
    }

    try {
      let result: any

      if (method === 'GET') {
        const mergedQuery = Object.keys(query).length > 0 ? query : undefined
        result = await tintin.server.get(path, mergedQuery)
      } else if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
        const ct = req.headers.get('Content-Type') || ''
        if (ct.includes('multipart/form-data') || isFormData(req.body as any)) {
          // 上传走 server:upload（通用兜底；专用接口建议走下方 typed upload 函数）
          const bodyAny = req.body as unknown as any
          const fd: FormData = isFormData(bodyAny)
            ? bodyAny
            : await req.formData()
          const fields: Record<string, any> = {}
          fd.forEach((v, k) => { fields[k] = v })
          result = await tintin.server.upload(path, fields)
        } else {
          // JSON body
          let body: any = null
          if (req.body && (ct.includes('application/json') || !ct)) {
            try { body = await req.json() } catch { /* noop */ }
          }
          result = (method === 'POST')
            ? await tintin.server.post(path, body)
            : await tintin.server.put(path, body)
        }
      } else if (method === 'DELETE') {
        const mergedQuery = Object.keys(query).length > 0 ? query : undefined
        result = await tintin.server.delete(path, mergedQuery)
      } else {
        return new Response(
          JSON.stringify({ error: `Unsupported method: ${method}` }),
          { status: 405, headers: { 'Content-Type': 'application/json' } }
        )
      }

      // 离线态 IPC 返回 null → 映射为 503
      if (result === null || result === undefined) {
        return new Response(
          JSON.stringify({ error: '服务端不可达（OFFLINE）' }),
          { status: 503, headers: { 'Content-Type': 'application/json' } }
        )
      }

      // 业务错误（{ error: ... } 结构）也返回 200，让 openapi-fetch 走 data 分支
      // 这样渲染层可以通过 if (res.error) 统一判断
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    } catch (err: any) {
      // IPC 抛错 → 映射为 500
      return new Response(
        JSON.stringify({ error: err?.message || String(err) }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      )
    }
  }
}

// ──────────────────────────────────────────────────────────────────
// openapi-fetch 原生客户端（供需要细粒度控制的场景直接使用）
// ──────────────────────────────────────────────────────────────────

/** 渲染层不需要真实 baseUrl，路径在 IPC 适配器中完整传递 */
const BASE_URL = 'http://ipc.local'

export type TintinClient = ReturnType<typeof createClient<paths>>

let _client: TintinClient | null = null

/** 获取全局单例 openapi-fetch 客户端 */
export function getTintinClient(): TintinClient {
  if (!_client) {
    _client = createClient<paths>({
      baseUrl: BASE_URL,
      fetch: createIpcFetch(BASE_URL) as any,
    })
  }
  return _client
}

// ──────────────────────────────────────────────────────────────────
// 3 个接口的类型安全封装函数（渲染层业务代码直接调用这些）
//
// 设计原则：
//   1. 入参严格对齐 OpenAPI 契约的 query / body 类型
//   2. 返回值去除 FetchResponse 包装，直接返回 { data, error } 元组风格
//   3. 上传类接口（ocr、split）额外支持 onProgress 回调，
//      直接走 window.tintin.server 的业务级 upload IPC 通道，
//      不经过通用 openapi-fetch fetch 适配器，确保 FormData/进度正常
// ──────────────────────────────────────────────────────────────────

export interface ApiResult<T> {
  data: T | null
  error: string | null
  response?: any
}

/**
 * GET /material/list — 素材列表（类型安全版）
 *
 * @param query 对齐 OpenAPI 契约 paths['/material/list'].get.parameters.query
 * @returns 列表响应（与原 server-api.ts PaginatedResponse 结构一致，字段来自服务端实际返回）
 */
export async function materialList(
  query?: MaterialListQuery
): Promise<ApiResult<any>> {
  try {
    const client = getTintinClient()
    const res = await client.GET('/material/list', {
      params: { query: (query || {}) as any },
    })
    if (res.error) {
      return { data: null, error: String((res.error as any)?.error || res.error), response: res.response }
    }
    // openapi.json 中该接口响应声明为 unknown，但实际结构是标准分页；
    // 返回 data 原封不动，由业务层按契约字段消费（类型可后续细化）。
    return { data: (res.data as any) || null, error: null, response: res.response }
  } catch (err: any) {
    return { data: null, error: err?.message || String(err) }
  }
}

/**
 * POST /material/ocr — 图片 OCR（A2 双模式版：主进程 inference-router 自动路由本地/HTTP）
 *
 * 优先级：
 *   1. 优先走 window.tintin.ocr.imageToText（A2 双模式通道，主进程单例 Router 做本地/HTTP 决策）
 *      · inference.mode = 'server-only' → 纯 HTTP
 *      · inference.mode = 'force-local' → 本地执行，失败返回 LOCAL_NOT_READY
 *      · inference.mode = 'hybrid-auto' → 本地前置检查全部通过 → 本地；否则 HTTP
 *      · 本地执行异常 / 耗时 >5s / 空结果 → 自动 fallback HTTP（用户零感知，Q3 红线）
 *   2. 若 A2 通道未就绪（preload.js 未更新） → 回退 window.tintin.server.materialOcr（纯 HTTP 兜底）
 *
 * @param payload.image   Blob | { path: string } — 待识别图片（IPC 层接受文件路径对象或 ReadStream）
 * @param payload.lang    可选：识别语言 'zh' | 'en' | 'zh+en'
 * @param payload.material_id / file_hash — 对齐 OpenAPI query（可选）
 * @param onProgress      上传进度 0-100
 */
export async function materialOcr(
  payload: {
    image: any               // Blob 或 { path: string }
    lang?: string
    material_id?: number
    file_hash?: string
  },
  onProgress?: (percent: number) => void
): Promise<ApiResult<OCRResponse>> {
  try {
    const tintin = (window as any).tintin

    // ────── 通道 1：A2 双模式（优先）──────
    if (tintin?.ocr?.imageToText) {
      const fields: Record<string, any> = { image: payload.image }
      if (payload.lang)           fields.lang           = payload.lang
      if (payload.material_id !== undefined) fields.material_id = String(payload.material_id)
      if (payload.file_hash)      fields.file_hash      = payload.file_hash

      const result = await tintin.ocr.imageToText(fields, onProgress)
      if (result === null || result === undefined) {
        return { data: null, error: 'A2 OCR 返回空（OFFLINE）' }
      }
      if (result?.error) {
        // LOCAL_NOT_READY + force-local 场景：按业务错误返回
        return {
          data: null,
          error: result.detail ? `${result.error}: ${result.detail}` : result.error,
          response: result,
        }
      }
      // 返回结构对齐 OCRResponse 契约；本地/HTTP 分支由主进程序列化成相同字段
      return {
        data: result as OCRResponse,
        error: null,
        response: { branch: result.branch, durationMs: result.durationMs },
      }
    }

    // ────── 通道 2：兜底纯 HTTP（老 preload 兼容）──────
    if (!tintin?.server?.materialOcr) {
      return { data: null, error: 'window.tintin.ocr / server.materialOcr 均未就绪' }
    }
    const fields: Record<string, any> = { image: payload.image }
    if (payload.lang)       fields.lang = payload.lang
    if (payload.material_id !== undefined) fields.material_id = String(payload.material_id)
    if (payload.file_hash)                 fields.file_hash = payload.file_hash

    const result = await tintin.server.materialOcr(fields, onProgress)
    if (result === null || result === undefined) {
      return { data: null, error: '服务端不可达（OFFLINE）' }
    }
    if (result?.error) {
      return { data: null, error: result.error }
    }
    return { data: result as OCRResponse, error: null, response: { branch: 'http-legacy' } }
  } catch (err: any) {
    return { data: null, error: err?.message || String(err) }
  }
}

/**
 * POST /montage/split — 视频/图片镜头分割（类型安全版，支持上传进度）
 *
 * 入参对齐契约 Body_split_video_montage_split_post；
 * 另外支持 onProgress 上传进度回调。
 *
 * @param payload.file            上传文件（与 material_id / clip_url 三选一）
 * @param payload.material_id     素材库素材 id（优先于 clip_url）
 * @param payload.clip_url        素材库/外部 clip URL（与 file / material_id 互斥）
 * @param payload.threshold       场景检测敏感度 1-100，默认 27
 * @param payload.min_scene_len   最小镜头秒数，默认 0.5
 * @param payload.dedup           是否去重，默认 true
 * @param payload.dedup_threshold 去重阈值 0.5~0.999，默认 0.95
 * @param payload.product_mode    产品模式评分，默认 false
 * @param payload.analyze         是否逐镜分析，默认 true
 * @param payload.image_duration  图片转静态镜头秒数，默认 3
 */
export async function montageSplit(
  payload: Partial<SplitBody> & { file?: any },
  onProgress?: (percent: number) => void
): Promise<ApiResult<any>> {
  try {
    const tintin = (window as any).tintin
    if (!tintin?.server?.montageSplit) {
      return { data: null, error: 'window.tintin.server.montageSplit 未就绪（请确认 preload.js 已更新）' }
    }

    // 契约要求至少一个来源：file XOR material_id XOR clip_url
    const hasFile = !!payload.file
    const hasMat = !!payload.material_id
    const hasUrl = !!payload.clip_url
    if ((hasFile ? 1 : 0) + (hasMat ? 1 : 0) + (hasUrl ? 1 : 0) !== 1) {
      return {
        data: null,
        error: 'montageSplit 需要且仅需要一个来源：file / material_id / clip_url 三选一',
      }
    }

    const fields: Record<string, any> = {}
    if (payload.file !== undefined)         fields.file          = payload.file
    if (payload.material_id !== undefined)  fields.material_id   = payload.material_id
    if (payload.clip_url !== undefined)     fields.clip_url      = payload.clip_url
    if (payload.threshold !== undefined)    fields.threshold     = String(payload.threshold)
    if (payload.min_scene_len !== undefined) fields.min_scene_len = String(payload.min_scene_len)
    if (payload.dedup !== undefined)        fields.dedup         = String(!!payload.dedup)
    if (payload.dedup_threshold !== undefined) fields.dedup_threshold = String(payload.dedup_threshold)
    if (payload.product_mode !== undefined) fields.product_mode  = String(!!payload.product_mode)
    if (payload.analyze !== undefined)      fields.analyze       = String(!!payload.analyze)
    if (payload.image_duration !== undefined) fields.image_duration = String(payload.image_duration)

    const result = await tintin.server.montageSplit(fields, onProgress)
    if (result === null || result === undefined) {
      return { data: null, error: '服务端不可达（OFFLINE）' }
    }
    if (result?.error) {
      return { data: null, error: result.error }
    }
    return { data: result, error: null }
  } catch (err: any) {
    return { data: null, error: err?.message || String(err) }
  }
}

// 兼容旧命名：server-api.ts 中的 MontageAPI 命名空间没有 split 函数，
// 这里以 montage:split 的标准 handler 名为准。
export { montageSplit as montageSplitVideo }
