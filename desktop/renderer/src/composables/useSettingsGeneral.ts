// ═══════════════════════════════════════════════════════════════
// useSettingsGeneral — 设置页·平台接入 / 本地配置 / 环境与维护
// 业务状态与方法自 Settings.vue 原样迁出（行为不变，IRON-08）：
//   · 平台接入：LLM 设置 / 服务接入分段 + LLM 连接测试
//   · 本地配置：数据目录/字体/代理分段状态
//   · 环境维护：服务端 ping/重启、日志级别、缓存清理
// 容器只调用一次本 composable 并以 props/emits 向卡片子组件接线，
// 不与其他 composable 互相 import 内部状态（配置读写走 useSettingsConfig）。
// ═══════════════════════════════════════════════════════════════

import { ref } from 'vue'
import type { LLMAPI } from '../../../types/server-api'
import { getTintin, readCfg, writeCfg } from './useSettingsConfig'

/* ── 常量：分段控件选项 ─────────────────────────────────────── */
const platTabs = ['LLM 设置', '服务接入']
const localTabs = ['数据目录', '字体', '代理']
/** 模型列表兜底选项（服务端离线时；在线数据来自 GET /llm/models，对照原版） */
const FALLBACK_MODELS = ['GPT-4o', 'Claude 3.5 Sonnet', 'DeepSeek-V2']

export function useSettingsGeneral() {
  /* ── 平台接入 ── */
  const activePlatTab = ref<string>('LLM 设置')
  // 模型列表：在线从服务端 /llm/models 拉取，离线回退兜底占位
  const modelOptions = ref<string[]>([...FALLBACK_MODELS])
  const defaultModel = ref<string>('GPT-4o')
  // API Key / Base URL 由服务端 Provider 管理（用户裁决：客户端不负责 provider），
  // 这里只读回显服务端脱敏值（如 sk-***48b），不可编辑
  const apiKey = ref<string>('')
  const baseUrl = ref<string>('')
  const providerName = ref<string>('')
  const providerLoaded = ref<boolean>(false)
  const webSearch = ref<boolean>(true)
  const savingLlm = ref<boolean>(false)

  /** 服务接入：LLM 连接测试进行中标志 */
  const testingLlm = ref<boolean>(false)

  /* ── 服务端地址（electron-store 'server.url'，主进程 getServerUrl 动态读取） ── */
  const serverUrl = ref<string>('http://127.0.0.1:8000')
  const savingServerUrl = ref<boolean>(false)

  /* ── 本地配置 ── */
  const activeLocalTab = ref<string>('数据目录')

  /* ── 环境与维护：本地服务端 / 日志级别 / 缓存清理（真实 IPC） ── */
  const serverRunning = ref<boolean>(false)
  const serverDesc = ref<string>('http://127.0.0.1:8000 · 检测中…')
  const serverBusy = ref<boolean>(false)
  const logLevel = ref<string>('INFO')
  const cacheClearing = ref<boolean>(false)
  const actionHint = ref<string>('')

  async function pingServer() {
    const t = getTintin()
    if (!t?.env) { serverRunning.value = false; serverDesc.value = '预览环境：无 IPC'; return }
    try {
      const r = await t.env.serverPing()
      serverRunning.value = !!r?.online
      // 回填当前生效的服务端地址（主进程 getServerUrl：store → ai_config.json → 默认）
      if (r?.url) serverUrl.value = r.url
      serverDesc.value = r?.online
        ? `${r.url} · 运行中（${r.latencyMs}ms）`
        : `${r?.url || 'http://127.0.0.1:8000'} · 离线`
    } catch (_e) { serverRunning.value = false; serverDesc.value = '检测失败' }
  }

  /* ── LLM 对接（P5）：模型列表 / Provider 回显 / 配置持久化 ── */

  /** 拉取模型列表 + Provider 脱敏回显（设置页进入时调用；离线静默回退兜底） */
  async function fetchLlm() {
    const t = getTintin()
    if (!t?.server?.llmModels) return
    try {
      const r = await t.server.llmModels()
      if (r && !('error' in r) && Array.isArray(r.models) && r.models.length) {
        modelOptions.value = r.models.map((m: LLMAPI.LlmModel) => m.id)
        // 已存偏好不在列表中时回退到首个可用模型
        if (!modelOptions.value.includes(defaultModel.value)) {
          defaultModel.value = r.models[0].id
        }
      }
    } catch (_e) { /* 离线保留兜底列表 */ }
    try {
      const r = await t.server.llmProviders?.()
      if (r && !('error' in r) && r.providers) {
        const entries = Object.entries(r.providers) as Array<[string, LLMAPI.LlmProvider]>
        if (entries.length) {
          const [key, p] = entries[0]
          providerName.value = p.name || key
          apiKey.value = p.api_key || ''
          baseUrl.value = p.base_url || ''
        }
        providerLoaded.value = true
      }
    } catch (_e) { /* 离线不回显 */ }
  }

  /** 设置页配置加载（容器 onMounted 调用）：本地偏好 + 服务端模型列表 */
  async function loadLlmCfg() {
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

  /** 保存服务端地址 → electron-store 'server.url'（主进程 getServerUrl 即时生效）→ 重新探测 */
  async function saveServerUrl() {
    if (savingServerUrl.value) return
    const url = serverUrl.value.trim().replace(/\/$/, '')
    if (!/^https?:\/\/.+/.test(url)) { actionHint.value = '地址格式应为 http(s)://host:port'; setTimeout(() => { actionHint.value = '' }, 1800); return }
    savingServerUrl.value = true
    try {
      await writeCfg('server.url', url)
      serverUrl.value = url
      await pingServer()
      await fetchLlm() // 地址生效后刷新模型列表 / Provider 回显
      actionHint.value = '服务端地址已保存'
    } catch (_e) { actionHint.value = '保存失败' }
    setTimeout(() => { actionHint.value = ''; savingServerUrl.value = false }, 1200)
  }

  async function restartServer() {
    if (serverBusy.value) return
    serverBusy.value = true
    const t = getTintin()
    if (t?.env) {
      try { const r = await t.env.restartService();
        serverRunning.value = !!r?.online; serverDesc.value = r?.online ? `${r.url} · 运行中` : `${r?.url || 'http://127.0.0.1:8000'} · 离线` }
      catch (_e) { serverRunning.value = false }
    }
    serverBusy.value = false
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

  /** onMounted 时读回持久化的日志级别（容器编排调用） */
  async function loadEnvCfg() {
    logLevel.value = String(await readCfg('env.logLevel', 'INFO')).toUpperCase()
  }

  /** 服务接入：LLM 连接测试（server:llmChat 真实 IPC；llm:chat 要求 model 必填） */
  async function testLlm() {
    testingLlm.value = true
    const t = getTintin()
    if (t?.server?.llmChat) {
      try {
        await t.server.llmChat({
          model: defaultModel.value,
          messages: [{ role: 'user', content: 'ping' }],
        })
        actionHint.value = 'LLM 连接正常'
      } catch (_e) { actionHint.value = 'LLM 连接失败' }
    } else { actionHint.value = '预览环境：无 IPC' }
    setTimeout(() => { actionHint.value = ''; testingLlm.value = false }, 1400)
  }

  return {
    // 平台接入
    platTabs,
    activePlatTab,
    modelOptions,
    defaultModel,
    apiKey,
    baseUrl,
    providerName,
    providerLoaded,
    webSearch,
    savingLlm,
    testingLlm,
    testLlm,
    saveLlm,
    loadLlmCfg,
    // 服务端地址
    serverUrl,
    savingServerUrl,
    saveServerUrl,
    // 本地配置
    localTabs,
    activeLocalTab,
    // 环境与维护
    serverRunning,
    serverDesc,
    serverBusy,
    logLevel,
    cacheClearing,
    actionHint,
    pingServer,
    restartServer,
    clearCache,
    saveLogLevel,
    loadEnvCfg,
  }
}
