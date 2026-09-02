// ═══════════════════════════════════════════════════════════════
// visionLogic.ts — 视觉模型研判类工具共用纯逻辑
//
// 服务对象（两者链路同构）：
//   · 视频评价预测  studio/gui/hook_score_page.py
//   · 视频营销检测  studio/gui/marketing_detect_page.py
// 共同链路：探测时长 → 抽关键帧 → base64 拼 image_url → llmChat → safe_json_parse
// 差异仅在「抽帧策略」与「prompt / 结果结构」，故共用部分收敛到本文件，
// 各自策略仍留在 videoScoreLogic.ts / videoMarketingLogic.ts。
//
// 本文件不做任何 IPC / DOM 操作（IRON-06/07 分层）。
// ═══════════════════════════════════════════════════════════════

/**
 * 一帧关键帧。
 * base64 = jpeg 二进制（对照原版 base64.b64encode(open(fr,'rb').read()).decode()）
 */
export interface VisionFrame {
  path: string
  timeSec: number
  base64: string
}

/**
 * OpenAI 风格多模态 content 分段（结构对齐 LLMAPI.ChatContentPart）。
 * 此处本地声明而非 import，保证纯逻辑层可被 node --test 直接加载。
 */
export interface VisionContentPart {
  type: 'text' | 'image_url'
  text?: string
  image_url?: { url: string }
}

/** 请求侧 message（结构对齐 LLMAPI.ChatRequestMessage） */
export interface VisionRequestMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | VisionContentPart[]
}

/** jpeg base64 → data URL（对照 f"data:image/jpeg;base64,{b64}"） */
export function jpegDataUrl(base64: string): string {
  return `data:image/jpeg;base64,${base64 || ''}`
}

/**
 * 视频路径 → 标题（对照两页的 title = os.path.splitext(os.path.basename(video))[0]）。
 * 兼容 Windows 反斜杠与 POSIX 正斜杠。
 */
export function videoTitleOf(videoPath: string): string {
  const name = String(videoPath || '').split(/[\\/]/).pop() || ''
  return name.replace(/\.[^.]+$/, '')
}

/** 视频路径 → 文件名（含扩展名，对照 os.path.basename） */
export function videoBaseName(videoPath: string): string {
  return String(videoPath || '').split(/[\\/]/).pop() || ''
}

/**
 * 帧列表 → 多模态 content（文本引导句 + 逐帧 image_url）。
 * 对照 hook_score_page.py L211-216 / marketing_detect_page.py L124-128：
 *   content = [{"type":"text","text":引导句}] + 每帧一个 image_url
 */
export function buildVisionContent(leadText: string, frames: VisionFrame[]): VisionContentPart[] {
  const content: VisionContentPart[] = [{ type: 'text', text: leadText }]
  for (const f of frames) {
    if (!f || !f.base64) continue
    content.push({ type: 'image_url', image_url: { url: jpegDataUrl(f.base64) } })
  }
  return content
}

/** /llm/chat/completions 响应 → 文本（choices[0].message.content，防御解析） */
export function pickLlmText(res: unknown): string {
  const r = res as { choices?: Array<{ message?: { content?: unknown } }> } | null
  return String(r?.choices?.[0]?.message?.content ?? '').trim()
}

/**
 * IPC 错误体判定：null（服务端离线）或 { error } 形态统一抛错。
 * 对照 llm:chat / ffmpeg:extractFrames 的返回口径（server-proxy.js isExpectedOfflineError → null）。
 */
export function throwIfIpcError(res: unknown, fallbackMsg: string): void {
  if (res === null || res === undefined) throw new Error(fallbackMsg)
  const e = (res as { error?: unknown }).error
  if (e) throw new Error(String(e))
}

/** ffprobe 结果 → 时长秒（对照 _probe_duration(video) or 10.0） */
export function probeDurationSec(probeRes: unknown, fallback = 10.0): number {
  const d = (probeRes as { duration?: unknown } | null)?.duration
  const n = typeof d === 'number' ? d : parseFloat(String(d ?? ''))
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/**
 * 通用 JSON 解析（对照 utils/llm_output_utils.safe_json_parse）。
 * 依次尝试：纯 JSON → markdown 代码块 → 首个 { 到末个 } 的截断。
 * 解析失败返回 null，由调用方决定报错文案。
 */
export function safeJsonParse(text: string): Record<string, any> | null {
  if (!text || typeof text !== 'string') return null

  const tryParse = (s: string): Record<string, any> | null => {
    try {
      const obj = JSON.parse(s)
      return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : null
    } catch (_) { return null }
  }

  const direct = tryParse(text.trim())
  if (direct) return direct

  const block = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (block) {
    const parsed = tryParse(block[1].trim())
    if (parsed) return parsed
  }

  const first = text.indexOf('{')
  const last = text.lastIndexOf('}')
  if (first !== -1 && last > first) {
    const parsed = tryParse(text.slice(first, last + 1))
    if (parsed) return parsed
  }

  return null
}

/** 数组字段归一（对照原版 isinstance(x, list) 才用，否则退化为单元素/空） */
export function toStringList(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x) => typeof x === 'string')
  if (typeof v === 'string' && v.trim()) return [v.trim()]
  return []
}

/** 0-100 数值夹紧（模型偶发越界/字符串数字） */
export function clampScore(v: unknown): number {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''))
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(100, Math.round(n)))
}

// ── 视觉模型状态卡（对照两页 model_status_card / update_vision_model_display）──

export type VisionModelState =
  | 'unknown'       // 未检测
  | 'configured'    // 已配置服务端地址（视觉模型由服务端选择）
  | 'unconfigured'  // 未配置服务端地址
  | 'testing'       // 正在测试…
  | 'ok'            // 连接成功
  | 'fail'          // 无法连接

/** 状态文案（对照 lbl_model_status 各分支） */
export function visionModelStatusText(state: VisionModelState): string {
  switch (state) {
    case 'configured':   return '已配置'
    case 'unconfigured': return '未配置'
    case 'testing':      return '正在测试…'
    case 'ok':           return '连接成功'
    case 'fail':         return '无法连接'
    default:             return '未检测'
  }
}

/** 状态颜色（对照原版 setStyleSheet color 各分支） */
export function visionModelStatusColor(state: VisionModelState): string {
  switch (state) {
    case 'configured':
    case 'ok':           return '#2ecc71'
    case 'unconfigured':
    case 'fail':         return '#e74c3c'
    case 'testing':      return '#f1c40f'
    default:             return '#a0aec0'
  }
}

/** 模型信息文案（对照 lbl_model_info 两分支） */
export function visionModelInfoText(hasServerUrl: boolean): string {
  return hasServerUrl ? '视频大模型：由服务端选择' : '视频大模型：未配置服务端地址'
}
