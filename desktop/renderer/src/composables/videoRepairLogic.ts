// ═══════════════════════════════════════════════════════════════
// videoRepairLogic — 视频修复 工作流归一化/任务轮询/结果命名（纯函数，无 vue/IPC 依赖）
// 业务对齐 M7（条目⑤）：对照原客户端：
//   · studio/utils/workflow_client.py normalize_server_workflow L60-88
//     （GET /workflows 条目 → 客户端结构；非 dict 或无 workflow_id → None）
//   · studio/gui/main_window_aigen.py _query_single_rh_task L823-906
//     （GET /workflows/task/{id} → resp.data 兜底；status_text_map L859-865；
//      comfy 协议小写映射 L939-948；进度 RUNNING=50、终态=100 L867）
//   · studio/gui/main_window_aigen.py _auto_download_rh_results L1031-1095
//     （命名：media.ext / media_idx.ext / task_id_idx.ext；同名冲突追加 task_id L1080-1082）
//   · studio/gui/main_window_pages.py L492-497（默认工作流「输入视频-修复脸部细节-20260113.json」）
// ═══════════════════════════════════════════════════════════════

/** 归一化后的服务端工作流（对照 workflow_client.normalize_server_workflow L72-88） */
export interface ServerWorkflow {
  id: string
  name: string
  type: string
  instanceType: string
  description: string
  clientApi: string
  imageNodes: string[]
  audioNodes: string[]
  backend: string
  scope: string
  outputType: string
  inputs: Array<Record<string, unknown>>
  io: Record<string, unknown>
}

/** 工作流任务状态映射结果 */
export interface WorkflowStatusInfo {
  text: string
  phase: 'queued' | 'running' | 'done' | 'failed' | 'paused' | 'unknown'
  progress: number
}

/** GET /workflows 条目 → 客户端结构（缺 workflow_id / 非对象 → null） */
export function normalizeServerWorkflow(w: unknown): ServerWorkflow | null {
  if (!w || typeof w !== 'object') return null
  const item = w as Record<string, any>
  const wfId = item.workflow_id
  if (!wfId) return null
  return {
    id: String(wfId),
    name: item.name || wfId,
    type: item.type || '其他',
    instanceType: item.instance_type || 'default',
    description: item.description || '',
    clientApi: item.client_api || '',
    imageNodes: item.image_nodes || [],
    audioNodes: item.audio_nodes || [],
    backend: item.backend || '',
    scope: item.scope || 'client',
    // 服务端固定的输出类型字段：image / video
    outputType: item.output_type || '',
    // 统一工作流输入组件清单（kind: image/video/audio/text/select）
    inputs: item.inputs || [],
    io: item.io || {},
  }
}

/**
 * 任务查询响应解包（对照 _query_single_rh_task L833-843）：
 * {code, data:{...}} → data；裸响应 → 自身；空 → {}。
 */
export function extractTaskData(resp: unknown): Record<string, any> {
  if (resp && typeof resp === 'object' && (resp as any).data) return (resp as any).data
  if (resp && typeof resp === 'object') return resp as Record<string, any>
  return {}
}

/** data.results 数组提取，缺省空（对照 L843 results = data.get("results") or []） */
export function extractTaskResults(data: unknown): unknown[] {
  const r = (data as any)?.results
  return Array.isArray(r) ? r : []
}

/**
 * 状态 → 中文文本/阶段/进度（对照 status_text_map L859-865 + comfy 小写映射 L939-948；
 * 进度口径 L867：SUCCESS/FAILED=100、RUNNING=50、其余=0；未知状态原样透出）。
 */
export function mapWorkflowStatus(status: unknown): WorkflowStatusInfo {
  const s = String(status ?? '').trim()
  const upper = s.toUpperCase()
  const lower = s.toLowerCase()
  if (upper === 'QUEUED' || lower === 'queued') return { text: '排队中', phase: 'queued', progress: 0 }
  if (upper === 'RUNNING' || lower === 'running') return { text: '运行中', phase: 'running', progress: 50 }
  if (upper === 'SUCCESS' || lower === 'success' || lower === 'completed') {
    return { text: '完成', phase: 'done', progress: 100 }
  }
  if (upper === 'FAILED' || lower === 'failed' || lower === 'error') {
    return { text: '失败', phase: 'failed', progress: 100 }
  }
  if (upper === 'PAUSED' || lower === 'paused') return { text: '已暂停', phase: 'paused', progress: 0 }
  return { text: s, phase: 'unknown', progress: 0 }
}

/**
 * 结果文件命名（对照 _auto_download_rh_results L1073-1082）：
 * 单结果 media.ext；多结果 media_idx.ext；无媒体名 → task_id_idx.ext；
 * 同名冲突 → base_taskId.ext（existsFn 由调用方注入；ext 缺省 bin）。
 */
export function buildResultName(
  mediaName: string,
  idx: number,
  total: number,
  ext: string,
  taskId: string,
  existsFn: (name: string) => boolean,
): string {
  const e = ext || 'bin'
  const base = mediaName
    ? total === 1
      ? mediaName
      : `${mediaName}_${idx}`
    : `${taskId}_${idx}`
  const name = `${base}.${e}`
  if (existsFn(name)) return `${base}_${taskId}.${e}`
  return name
}

/** 默认工作流：按名称匹配「修复脸部细节」（对照 main_window_pages L492-497），无匹配回退首个 */
export function pickDefaultWorkflow(items: Array<{ id: string; name: string }>): string {
  if (!items || !items.length) return ''
  const hit = items.find((w) => String(w.name || '').includes('修复脸部细节'))
  return hit ? hit.id : items[0].id
}

/**
 * 结果条目提取（对照 _auto_download_rh_results L1064-1072）：
 * 仅保留含 url / filename / text 的 dict 项，跳过字符串/数字等垃圾项。
 */
export function extractResultEntries(results: unknown): Array<Record<string, any>> {
  return (Array.isArray(results) ? results : []).filter(
    (r): r is Record<string, any> =>
      !!r && typeof r === 'object' && !!(r.url || r.filename || r.text),
  )
}
