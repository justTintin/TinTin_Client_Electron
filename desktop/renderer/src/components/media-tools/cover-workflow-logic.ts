// ═══════════════════════════════════════════════════════════════
// cover-workflow-logic.ts — 封面制作·提交参数编组与 AI 文案解析（纯函数，无 vue 依赖，可单测）
// 单测：desktop/tests/cover-workflow-logic.test.mjs
//
// 口径：
//   · buildCoverWorkflow 保持既有服务端模板渲染链路结构（type/size/count/layers），
//     M5 增量透传 template / title（字段命名对齐 openapi-latest.json CoverRequest：
//     template=封面模板标识、title=封面标题；服务端 cover 工作流按字段名识别，
//     不识别则忽略，不影响既有提交）。
//   · parseAiCopyJson 对齐原版 cover_maker_page.py _ai_suggest 的 AI 输出解析
//     （safe_json_parse：只输出 JSON {"title":..., "subtitle":...}）。
// ═══════════════════════════════════════════════════════════════

/** 封面提交参数（CoverMaker.vue 表单状态 → buildCoverWorkflow） */
export interface CoverWorkflowParams {
  size: string
  count: number
  bgColor: string
  bgTransparent: boolean
  productPath: string
  textContent: string
  logoPath: string
  /** 封面模板标识（M5 可选输入；对齐 CoverRequest.template，契约无列表接口则手动填写） */
  template?: string
  /** 封面标题（AI 建议或手动填写；对齐 CoverRequest.title） */
  title?: string
}

/** 构建封面工作流提交体（保持既有结构；template/title 仅非空时透传） */
export function buildCoverWorkflow(params: CoverWorkflowParams): Record<string, unknown> {
  const body: Record<string, unknown> = {
    type: 'cover',
    size: params.size,
    count: params.count,
    layers: {
      background: params.bgTransparent ? { transparent: true } : { color: params.bgColor },
      product: params.productPath ? { file: params.productPath } : null,
      text: params.textContent ? { content: params.textContent } : null,
      logo: params.logoPath ? { file: params.logoPath } : null
    }
  }
  const template = String(params.template || '').trim()
  if (template) body.template = template
  const title = String(params.title || '').trim()
  if (title) body.title = title
  return body
}

/**
 * 解析 AI 文案生成结果：模型输出可能带 markdown 代码块/前后说明，
 * 提取首个 JSON 对象并取 title/subtitle（对齐原版 safe_json_parse 口径）；
 * 解析失败 → null（调用方回退：整段截断作标题）。
 */
export function parseAiCopyJson(text: string): { title: string; subtitle: string } | null {
  const src = String(text || '')
  if (!src) return null
  const m = src.match(/\{[\s\S]*\}/)
  if (!m) return null
  try {
    const d = JSON.parse(m[0])
    if (!d || typeof d !== 'object' || Array.isArray(d)) return null
    return {
      title: String((d as Record<string, unknown>).title ?? '').trim(),
      subtitle: String((d as Record<string, unknown>).subtitle ?? '').trim()
    }
  } catch (_e) {
    return null
  }
}
