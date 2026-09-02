// ═══════════════════════════════════════════════════════════════
// useSettingsGeneral — 设置页·服务端 / 本地配置 / 环境与维护
// 2026-08-28「服务端配置业务对齐」用户裁决改造（对齐原客户端
// compute_server_url 单一统一地址模型，gui/main_window_aiconfig.py）：
//   · 只有一个统一服务端地址（electron-store 'server.url' 单一键，经 IPC 持久化），
//     保存后主进程 getServerUrl 即时生效；LLM 凭证由服务端持有，客户端不配置
//   · 模型列表：服务端地址保存生效后 / 设置页进入时从服务端 GET /llm/models 拉取
//   · 取消独立「LLM 测试连接」，改为按功能（API-GUIDE 实际端点）分别测试
// 容器只调用一次本 composable 并以 props/emits 向卡片子组件接线，
// 不与其他 composable 互相 import 内部状态（配置读写走 useSettingsConfig）。
// ═══════════════════════════════════════════════════════════════

import { ref } from 'vue'
import type { LLMAPI } from '../../../types/server-api'
import { getTintin, readCfg, writeCfg } from './useSettingsConfig'
import { useServerStore } from '../stores/server'
import { formatMachineCode } from './machineCodeLogic'

/* ── 常量：分段控件选项 ─────────────────────────────────────── */
const platTabs = ['服务端', '模型']
/** 模型列表兜底选项（服务端离线时；在线数据来自 GET /llm/models，对照原版） */
const FALLBACK_MODELS = ['GPT-4o', 'Claude 3.5 Sonnet', 'DeepSeek-V2']

/** 单项功能测试结果（ok=null 表示尚未测试） */
export interface FuncTestResult {
  name: string
  ok: boolean | null
  message: string
}

export function useSettingsGeneral() {
  /* ── 服务端 / 模型（LLM 凭证由服务端持有，客户端只选模型） ── */
  const activePlatTab = ref<string>('服务端')
  // 模型列表：在线从服务端 /llm/models 拉取，离线回退兜底占位
  const modelOptions = ref<string[]>([...FALLBACK_MODELS])
  const defaultModel = ref<string>('GPT-4o')
  const webSearch = ref<boolean>(true)
  const savingLlm = ref<boolean>(false)

  /* ── 服务端地址（electron-store 'server.url'，主进程 getServerUrl 动态读取） ── */
  const serverUrl = ref<string>('http://127.0.0.1:8000')
  const savingServerUrl = ref<boolean>(false)

  /* ── 按功能测试连接（用户裁决：取消独立 LLM 测试，改为按功能分别测试） ── */
  const testingFuncs = ref<boolean>(false)
  const funcResults = ref<FuncTestResult[]>([
    { name: 'LLM · 模型列表', ok: null, message: '未测试' },
    { name: 'OCR · 文字识别', ok: null, message: '未测试' },
    { name: '向量 · 图文检索', ok: null, message: '未测试' },
    { name: 'TTS · 语音合成', ok: null, message: '未测试' },
    { name: 'ASR · 语音识别', ok: null, message: '未测试' },
  ])

  /* ── 环境与维护：日志级别 / 缓存清理（真实 IPC） ──
   * 2026-08-30 对齐原客户端整改：移除「本地服务端」状态区块（统一服务端
   * 连通状态由标题栏状态胶囊展示，单一真相源 serverStore）；
   * 日志文件列表/查看迁出至 useLogViewer（对齐原客户端日志查看页）。 */
  const serverDesc = ref<string>('http://127.0.0.1:8000 · 检测中…')
  const logLevel = ref<string>('INFO')
  const cacheClearing = ref<boolean>(false)
  const actionHint = ref<string>('')

  /* ── 关于卡·本机机器码（原始信息主进程采集，SHA256 摘要纯函数在 machineCodeLogic） ── */
  const machineCode = ref<string>('')

  /** 加载本机机器码（格式 XXXX-XXXX-XXXX-XXXX） */
  async function loadMachineCode() {
    const t = getTintin()
    if (!t?.env?.getMachineInfo) return
    try { machineCode.value = await formatMachineCode(await t.env.getMachineInfo()) } catch (_) { /* 静默 */ }
  }

  /**
   * 触发标题栏状态胶囊重查（serverStore 是全渲染层唯一状态源）。
   * env:serverPing 与胶囊在线判定为同一 IPC 通道，保存地址/测试连接后
   * 必须立刻重查，胶囊才能同步更新（否则最长滞后 60s 轮询）。
   */
  function refreshServerStatus(): void {
    try { void useServerStore().checkCapabilities() } catch (_e) { /* pinia 未就绪（预览）静默 */ }
  }

  async function pingServer() {
    const t = getTintin()
    if (!t?.env) { serverDesc.value = '预览环境：无 IPC'; return }
    try {
      const r = await t.env.serverPing()
      // 回填当前生效的服务端地址（主进程 getServerUrl：store → ai_config.json → 默认）
      if (r?.url) serverUrl.value = r.url
      serverDesc.value = r?.online
        ? `${r.url} · 运行中（${r.latencyMs}ms）`
        : `${r?.url || 'http://127.0.0.1:8000'} · 离线`
      // 同一 IPC 通道（env:serverPing）联动标题栏状态胶囊立刻重查
      refreshServerStatus()
    } catch (_e) { serverDesc.value = '检测失败' }
  }

  /* ── LLM 对接（P5）：模型列表服务端拉取 / 配置持久化 ── */

  /** 应用服务端模型列表到下拉数据源（偏好失效时回退首个可用模型） */
  function applyModels(models: LLMAPI.LlmModel[]) {
    modelOptions.value = models.map((m: LLMAPI.LlmModel) => m.id)
    // 已存偏好不在列表中时回退到首个可用模型
    if (models.length && !modelOptions.value.includes(defaultModel.value)) {
      defaultModel.value = models[0].id
    }
  }

  /** 拉取模型列表（设置页进入 / 服务端地址保存生效后调用；离线静默回退兜底） */
  async function fetchLlm() {
    const t = getTintin()
    if (!t?.server?.llmModels) return
    try {
      const r = await t.server.llmModels()
      if (r && !('error' in r) && Array.isArray(r.models) && r.models.length) {
        applyModels(r.models)
      }
    } catch (_e) { /* 离线保留兜底列表 */ }
  }

  /** 设置页配置加载（容器 onMounted 调用）：本地偏好 + 服务端模型列表 */
  async function loadLlmCfg() {
    // 回读已保存的服务端地址（electron-store 'server.url' 单一真相源；
    // 展示层不得保留硬编码第二源，主进程 pingServer 后还会用生效地址二次回填）
    serverUrl.value = String(await readCfg('server.url', serverUrl.value))
    defaultModel.value = String(await readCfg('llm.defaultModel', defaultModel.value))
    webSearch.value = (await readCfg('llm.webSearch', webSearch.value)) === true
    await fetchLlm()
  }

  /** 显式保存（用户裁决：改动集中提交）：默认模型 + 联网搜索 → electron-store */
  async function saveLlm() {
    if (savingLlm.value) return
    savingLlm.value = true
    try {
      await writeCfg('llm.defaultModel', defaultModel.value)
      await writeCfg('llm.webSearch', webSearch.value)
      actionHint.value = 'LLM 配置已保存'
    } catch (_e) { actionHint.value = '保存失败' }
    setTimeout(() => { actionHint.value = ''; savingLlm.value = false }, 1200)
  }

  /**
   * 保存服务端地址：electron-store 'server.url'（主进程 getServerUrl 即时生效）→ 重新探测 + 刷新模型列表。
   * 2026-08-28 修复「保存后重启丢失」：写入后必须回读校验（electron-store 落盘是唯一真相源），
   * 写入失败 / 回读不一致时显式报错，不再无条件提示「已保存」（旧实现把持久化失败静默掩盖）。
   */
  async function saveServerUrl() {
    if (savingServerUrl.value) return
    const url = serverUrl.value.trim().replace(/\/$/, '')
    if (!/^https?:\/\/.+/.test(url)) { actionHint.value = '地址格式应为 http(s)://host:port'; setTimeout(() => { actionHint.value = '' }, 1800); return }
    savingServerUrl.value = true
    try {
      const ok = await writeCfg('server.url', url)
      if (!ok) { actionHint.value = '保存失败：配置通道不可用'; return }
      const back = String(await readCfg('server.url', ''))
      if (back !== url) { actionHint.value = '保存失败：配置未持久化'; return }
      serverUrl.value = url
      await pingServer()
      await fetchLlm() // 地址生效后刷新模型列表（用户裁决：模型列表从服务端拉取）
      actionHint.value = '服务端地址已保存'
    } catch (_e) { actionHint.value = '保存失败' }
    finally { setTimeout(() => { actionHint.value = ''; savingServerUrl.value = false }, 1200) }
  }

  async function clearCache() {
    if (cacheClearing.value) return
    cacheClearing.value = true
    const t = getTintin()
    if (t?.env) {
      try { const r = await t.env.clearCache(); actionHint.value = r?.ok ? '已清理缓存' : '清理失败' } catch (_e) { actionHint.value = '清理失败' }
    } else { actionHint.value = '预览环境：无 IPC' }
    setTimeout(() => { actionHint.value = ''; cacheClearing.value = false }, 1200)
  }

  async function saveLogLevel() { await writeCfg('env.logLevel', logLevel.value) }

  /** onMounted 时读回持久化的日志级别（容器编排调用）；顺带加载机器码 */
  async function loadEnvCfg() {
    logLevel.value = String(await readCfg('env.logLevel', 'INFO')).toUpperCase()
    void loadMachineCode()
  }

  /* ── 按功能测试连接（用户裁决 2026-08-28：取消独立 LLM 测试）──
     端点全部核对自 API-GUIDE（api-contract.generated.ts 同源），禁止臆造：
     · LLM  GET  /llm/models      模型列表服务（业务级 llm:models）
     · OCR  POST /material/ocr    无健康端点：发最小空请求，以服务端校验响应(4xx)判定端点可达
     · 向量 GET  /clip/health     CLIP 图文向量服务
     · TTS  GET  /voxcpm/health   VoxCPM 语音合成服务
     · ASR  GET  /whisper/health  Whisper 语音识别服务
     离线判定：主进程对 ECONNREFUSED 等网络错误静默返回 null。 */

  function _setFuncResult(name: string, ok: boolean, message: string) {
    const row = funcResults.value.find((r) => r.name === name)
    if (row) { row.ok = ok; row.message = message }
  }

  function _errText(e: unknown): string {
    return String((e as any)?.message || e).replace(/^.*Error:\s*/, '')
  }

  /** LLM：GET /llm/models（顺带刷新下拉数据源） */
  async function _probeLlm() {
    const name = 'LLM · 模型列表'
    const t = getTintin()
    if (!t?.server?.llmModels) { _setFuncResult(name, false, '预览环境：无 IPC'); return }
    try {
      const r = await t.server.llmModels()
      if (r && !('error' in r) && Array.isArray(r.models)) {
        if (r.models.length) {
          applyModels(r.models)
          _setFuncResult(name, true, `正常（${r.models.length} 个模型）`)
        } else { _setFuncResult(name, false, '服务端未提供') }
      } else { _setFuncResult(name, false, '服务端离线') }
    } catch (e) { _setFuncResult(name, false, _errText(e)) }
  }

  /** 通用 GET 健康端点探测（2xx=ok；离线 null=fail） */
  async function _probeHealth(name: string, path: string) {
    const t = getTintin()
    if (!t?.server?.get) { _setFuncResult(name, false, '预览环境：无 IPC'); return }
    try {
      const r = await t.server.get(path)
      if (r === null || r === undefined) { _setFuncResult(name, false, '服务端离线'); return }
      if (r && typeof r === 'object' && 'error' in r) { _setFuncResult(name, false, String(r.error)); return }
      _setFuncResult(name, true, '正常')
    } catch (e) { _setFuncResult(name, false, _errText(e)) }
  }

  /** OCR：POST /material/ocr 空体最小探测（4xx 校验响应=端点可达；无健康端点可替代） */
  async function _probeOcr() {
    const name = 'OCR · 文字识别'
    const t = getTintin()
    if (!t?.server?.post) { _setFuncResult(name, false, '预览环境：无 IPC'); return }
    try {
      const r = await t.server.post('/material/ocr', {})
      if (r === null || r === undefined) { _setFuncResult(name, false, '服务端离线'); return }
      _setFuncResult(name, true, '正常（端点可达）')
    } catch (e) {
      // 空请求必触发服务端参数校验 → 4xx 恰好证明端点存在且网络可达
      if (/HTTP\s+4\d\d/.test(_errText(e))) { _setFuncResult(name, true, '正常（端点可达）'); return }
      _setFuncResult(name, false, _errText(e))
    }
  }

  /** 单项功能测试（CardPlatform 行内按钮） */
  async function testFunction(name: string) {
    if (name === 'LLM · 模型列表') return _probeLlm()
    if (name === 'OCR · 文字识别') return _probeOcr()
    if (name === '向量 · 图文检索') return _probeHealth('向量 · 图文检索', '/clip/health')
    if (name === 'TTS · 语音合成') return _probeHealth('TTS · 语音合成', '/voxcpm/health')
    if (name === 'ASR · 语音识别') return _probeHealth('ASR · 语音识别', '/whisper/health')
  }

  /** 全部功能测试（并行互不阻塞；结果逐项回写 funcResults） */
  async function perFunctionTest() {
    if (testingFuncs.value) return
    testingFuncs.value = true
    try {
      await Promise.all([
        _probeLlm(),
        _probeOcr(),
        _probeHealth('向量 · 图文检索', '/clip/health'),
        _probeHealth('TTS · 语音合成', '/voxcpm/health'),
        _probeHealth('ASR · 语音识别', '/whisper/health'),
      ])
    } finally { testingFuncs.value = false }
  }

  return {
    // 服务端 / 模型
    platTabs,
    activePlatTab,
    modelOptions,
    defaultModel,
    webSearch,
    savingLlm,
    saveLlm,
    loadLlmCfg,
    // 服务端地址
    serverUrl,
    savingServerUrl,
    saveServerUrl,
    // 按功能测试连接
    testingFuncs,
    funcResults,
    testFunction,
    perFunctionTest,
    // 本地配置：迁出（缓存目录/LUT 在 useSettingsIntegration，CardLocalConfig 卡）
    // 环境与维护
    serverDesc,
    logLevel,
    cacheClearing,
    actionHint,
    pingServer,
    clearCache,
    saveLogLevel,
    loadEnvCfg,
    // 关于卡·本机机器码
    machineCode,
  }
}
