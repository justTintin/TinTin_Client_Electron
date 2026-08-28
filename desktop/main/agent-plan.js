// ═══════════════════════════════════════════════════════════════
// agent-plan.js — 云端智能体任务拆解（P2 补齐：对照 agent_router.build_plan）
// 原版：utils/agent_router.py build_plan（LLM 拆解一句话需求 → 服务端可执行 plan）。
// 移植定位对齐：拆解属客户端能力（非 UI），放主进程；纯函数可单测。
// plan 格式：{goal, steps:[{id, capability, params, depends_on, needs_user_input}]}
// ═══════════════════════════════════════════════════════════════

const { httpRequest, API_ENDPOINTS } = require('./server-proxy')

// 参数结构特殊的能力示例模板（params_schema 未声明时的兜底提示；
// 字段以实测/服务端契约为准，仅约束 LLM 拆解输出格式）——逐字对照原版 _PARAM_TEMPLATES
const PARAM_TEMPLATES = {
  llm_chat: { prompt: '要生成/处理的文本内容或问题' },
  review_check: { content: '待审查的文案或产物文本' },
  agent_script_eval: {
    shots: [{ index: 1, shot_type: '镜头类型', visual: '画面描述',
      audio: '配音文案', sfx: '音效', duration: 3.0 }],
    topic: '分镜主题',
  },
  material_search: { query: '检索关键词' },
  asr_transcribe: { file_path: '音频文件路径' },
  tts_voice_clone: { text: '待合成文本', voice_sample: '音色样本路径' },
  task_status_unified: { task_id: '任务id' },
}

/** 能力清单 → prompt（逐字对照 build_plan 的 cap_lines/tpl_lines/plan 格式/规则四段） */
function buildPlanPrompt(serverCaps) {
  const capLines = serverCaps
    .slice(0, 40)
    .map((c) => `- ${c.id}: ${c.name}｜${String(c.description || '').slice(0, 60)}`)
  const tplLines = serverCaps
    .map((c) => {
      const tpl = PARAM_TEMPLATES[c.id]
      return tpl ? `- ${c.id}: ${JSON.stringify(tpl)}` : ''
    })
    .filter(Boolean)
  return (
    '你是多智能体编排器。把用户的一句话目标拆解为可执行 plan（严格 JSON，无其他文字）。\n' +
    '可用能力（capability id）：\n' + capLines.join('\n') + '\n' +
    '参数模板（无模板的能力按常见字段 prompt/content/text 给合理值）：\n' +
    tplLines.join('\n') + '\n' +
    'plan 格式：{"goal": "目标", "steps": [{"id": "s1", "capability": "能力id", ' +
    '"params": {能力输入字段}, "depends_on": [], "needs_user_input": false}]}\n' +
    '规则：\n' +
    '1. 只使用上面列出的能力 id，能力不够就拆到最接近的一步，params 严格按参数模板给；\n' +
    '2. 有依赖的步骤用 depends_on 引用前置步骤 id；\n' +
    '3. 需要用户提供素材/确认的步骤 needs_user_input 置 true；\n' +
    '4. 步骤 2-8 个，输出必须是合法 JSON。'
  )
}

/** LLM 返回文本 → JSON（容忍 ```json 包裹与前后多余文字，对照 llm_chat_json） */
function parsePlanJson(text) {
  let t = String(text || '').trim()
  if (!t) return null
  t = t.replace(/^```(?:json)?|```$/gm, '').trim()
  try {
    return JSON.parse(t)
  } catch (_) { /* fallthrough: 提取首个 JSON 片段 */ }
  const m = /(\[[\s\S]*\]|\{[\s\S]*\})/.exec(t)
  if (m) {
    try { return JSON.parse(m[1]) } catch (_) { /* ignore */ }
  }
  return null
}

/** plan 结构与能力合法性校验（逐字对照 build_plan 末段：steps 非空 + capability 已登记） */
function validatePlan(plan, serverCaps) {
  if (!plan || typeof plan !== 'object' || !Array.isArray(plan.steps) || !plan.steps.length) return null
  const ids = new Set(serverCaps.map((c) => c.id))
  for (const s of plan.steps) {
    if (!s || typeof s !== 'object' || !ids.has(s.capability)) return null
  }
  return plan
}

/**
 * 拆解一句话需求 → plan（runner）。
 * 返回 [true, plan] 或 [false, 错误信息]；拆解/校验失败返回 [false, 原因]。
 */
async function splitPlan(goal) {
  const text = String(goal || '').trim()
  if (!text) return [false, '请先填写任务描述，再拆解任务。']
  try {
    const reg = await httpRequest('GET', API_ENDPOINTS.agent.registry, { timeout: 8000 })
    const caps = (reg && reg.data && reg.data.capabilities) || []
    const serverCaps = caps.filter((c) => c.executor === 'server')
    if (!serverCaps.length) {
      return [false, '拆解失败（服务端 LLM 或注册表不可用），请确认服务端在线后重试。']
    }
    const prompt = buildPlanPrompt(serverCaps)
    const res = await httpRequest('POST', API_ENDPOINTS.llm.chatCompletions, {
      body: {
        messages: [
          { role: 'system', content: prompt },
          { role: 'user', content: text },
        ],
        temperature: 0.0,
      },
      timeout: 20000,
    })
    const data = res && res.data
    const content = data && data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content : ''
    const plan = validatePlan(parsePlanJson(content), serverCaps)
    if (!plan) return [false, '拆解失败：LLM 输出未通过能力校验，请调整描述后重试。']
    return [true, plan]
  } catch (e) {
    return [false, `拆解失败：${e.message}`]
  }
}

module.exports = { PARAM_TEMPLATES, buildPlanPrompt, parsePlanJson, validatePlan, splitPlan }
