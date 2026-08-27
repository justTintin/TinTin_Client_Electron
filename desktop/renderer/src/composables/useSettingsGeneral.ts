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
import { getTintin, readCfg, writeCfg } from './useSettingsConfig'

/* ── 常量：分段控件选项 ─────────────────────────────────────── */
const platTabs = ['LLM 设置', '服务接入']
const localTabs = ['数据目录', '字体', '代理']
const modelOptions = ['GPT-4o', 'Claude 3.5 Sonnet', 'DeepSeek-V2']

export function useSettingsGeneral() {
  /* ── 平台接入 ── */
  const activePlatTab = ref<string>('LLM 设置')
  const defaultModel = ref<string>('GPT-4o')
  const apiKey = ref<string>('sk-xxxxxxxxxxxxxxxx')
  const baseUrl = ref<string>('https://api.openai.com/v1')
  const webSearch = ref<boolean>(true)

  /** 服务接入：LLM 连接测试进行中标志 */
  const testingLlm = ref<boolean>(false)

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
      serverDesc.value = r?.online
        ? `${r.url} · 运行中（${r.latencyMs}ms）`
        : `${r?.url || 'http://127.0.0.1:8000'} · 离线`
    } catch (_e) { serverRunning.value = false; serverDesc.value = '检测失败' }
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

  /** 服务接入：LLM 连接测试（server:llmChat 真实 IPC） */
  async function testLlm() {
    testingLlm.value = true
    const t = getTintin()
    if (t?.server?.llmChat) {
      try {
        await t.server.llmChat({ messages: [{ role: 'user', content: 'ping' }] })
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
    webSearch,
    testingLlm,
    testLlm,
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
