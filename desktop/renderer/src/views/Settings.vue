<script setup lang="ts">
// ═══════════════════════════════════════════════════════════════
// Settings.vue — 系统设置（左栏6菜单项 + 右区4类设置 + A2本地推理卡）
// ═══════════════════════════════════════════════════════════════

import { ref, onMounted, onBeforeUnmount } from 'vue'
import { useRouter } from 'vue-router'
import { useAppStore, type ThemeMode } from '../stores/app'
import { useInferenceSettings, bytesToMB as _bytesToMB, type PkgRow } from '../composables/useInferenceSettings'

const router = useRouter()
const appStore = useAppStore()

/* ── 外观主题：3 档分段控件 ───────────────────────────────────── */
const THEME_TABS: Array<{ value: ThemeMode; label: string; icon: string }> = [
  { value: 'light',  label: '亮色',    icon: '☀' },
  { value: 'dark',   label: '暗色',    icon: '🌙' },
  { value: 'system', label: '跟随系统', icon: '🖥' },
]

/* ── 左侧菜单 ──────────────────────────────────────────────── */
interface MenuItem {
  id: string
  label: string
  icon: string // SVG inner path
  desc?: string
}

const menuItems = ref<MenuItem[]>([
  { id: 'platform',   label: '平台接入',   desc: 'LLM · 服务接入',       icon: 'platform' },
  { id: 'local',      label: '本地配置',   desc: '数据路径 · 代理',      icon: 'local' },
  { id: 'theme',      label: '外观主题',   desc: '亮色 / 暗色 / 跟随',   icon: 'theme' },
  { id: 'env',        label: '环境与维护', desc: '服务 · 日志 · 缓存',   icon: 'env' },
  { id: 'inference',  label: '本地推理能力', desc: 'OCR · 向量 · 封面', icon: 'inference' },
  { id: 'ext',        label: '扩展插件',   desc: '采集 · 自动上架',      icon: 'ext' },
  { id: 'about',      label: '关于',       desc: '版本 V' + appStore.version, icon: 'about' }
])

const activeMenu = ref<string>('platform')

function backToWorkbench() {
  router.push('/')
}

/* ── 平台接入：LLM 设置 / 服务接入（对齐客户端设置设计稿） ── */
const platTabs = ['LLM 设置', '服务接入']
const activePlatTab = ref<string>('LLM 设置')

const modelOptions = ['GPT-4o', 'Claude 3.5 Sonnet', 'DeepSeek-V2']
const defaultModel = ref<string>('GPT-4o')
const apiKey = ref<string>('sk-xxxxxxxxxxxxxxxx')
const baseUrl = ref<string>('https://api.openai.com/v1')
const webSearch = ref<boolean>(true)

/* ── 本地配置：分段控件 ──────────────────────────────────────── */
const localTabs = ['数据目录', '字体', '代理']
const activeLocalTab = ref<string>('数据目录')

/* ── 真实 IPC 访问（壳外纯浏览器预览时降级） ──────────────────── */
const tintin = () => (window as any).tintin
const hasEnv = () => !!tintin()?.env
const hasConfig = () => !!tintin()?.config

/** 读 electron-store 配置（无 IPC 返回默认） */
async function readCfg(key: string, def: string | boolean) {
  if (!hasConfig()) return def
  try { return (await tintin().config.get(key)) ?? def } catch (_) { return def }
}
/** 写配置到 electron-store（无 IPC 静默） */
async function writeCfg(key: string, val: any) {
  if (!hasConfig()) return
  try { await tintin().config.set(key, val) } catch (_) {}
}

/* ── 扩展插件：下载插件 / 自动上架（配置经 IPC 持久化） ───────── */
const extTabs = ['下载插件', '自动上架']
const activeExtTab = ref<string>('下载插件')

const bridgePort = ref<string>('8123')
const bridgeSaveDir = ref<string>('D:\\TinTin\\collected')
const extScanServer = ref<boolean>(true)
const chromePort = ref<string>('9222')
const chromePath = ref<string>('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe')
const chromeDataDir = ref<string>('D:\\TinTin\\chrome-profile')
const shopKeyword = ref<string>('桔柚')

/** 自动上架预览状态（已解析到正式连接前为 null） */
const cdpState = ref<string>('未检测')
const cdpBusy = ref<boolean>(false)

async function loadExtCfg() {
  bridgePort.value    = String(await readCfg('ext.bridgePort', bridgePort.value))
  bridgeSaveDir.value = String(await readCfg('ext.bridgeSaveDir', bridgeSaveDir.value))
  extScanServer.value = (await readCfg('ext.scanServer', extScanServer.value)) as boolean
  chromePort.value    = String(await readCfg('ext.chromePort', chromePort.value))
  chromePath.value    = String(await readCfg('ext.chromePath', chromePath.value))
  chromeDataDir.value = String(await readCfg('ext.chromeDataDir', chromeDataDir.value))
  shopKeyword.value   = String(await readCfg('ext.shopKeyword', shopKeyword.value))
}

async function browseDir(field: 'bridgeSaveDir' | 'chromeDataDir') {
  if (!tintin()?.dialog?.openDir) return
  try {
    const r = await tintin().dialog.openDir({})
    const picked = Array.isArray(r?.filePaths) ? r.filePaths[0] : (r?.filePaths ?? r?.path)
    if (picked) { (field === 'bridgeSaveDir' ? bridgeSaveDir : chromeDataDir).value = String(picked) }
  } catch (_) {}
}

async function browseFile() {
  if (!tintin()?.dialog?.openFile) return
  try {
    const r = await tintin().dialog.openFile({})
    const picked = Array.isArray(r?.filePaths) ? r.filePaths[0] : (r?.filePaths ?? r?.path)
    if (picked) chromePath.value = String(picked)
  } catch (_) {}
}

/** 检测调试 Chrome（env:detectCdp — 真实 IPC） */
async function detectChrome() {
  cdpBusy.value = true
  if (!hasEnv()) { cdpState.value = '预览环境暂不可用'; cdpBusy.value = false; return }
  try {
    const r = await tintin().env.detectCdp(Number(chromePort.value) || 9222)
    cdpState.value = r?.connected ? `已连接 · ${r.info?.Browser || 'Chrome'} (127.0.0.1:${r.port})` : `未检测到 :${Number(chromePort.value) || 9222}`
  } catch (_e) { cdpState.value = '检测失败' }
  cdpBusy.value = false
}

async function saveExtension() {
  await Promise.all([
    writeCfg('ext.bridgePort', bridgePort.value),
    writeCfg('ext.bridgeSaveDir', bridgeSaveDir.value),
    writeCfg('ext.scanServer', extScanServer.value),
    writeCfg('ext.chromePort', chromePort.value),
    writeCfg('ext.chromePath', chromePath.value),
    writeCfg('ext.chromeDataDir', chromeDataDir.value),
    writeCfg('ext.shopKeyword', shopKeyword.value),
  ])
}

/* ── 模块与插件信息 ── */
const appVersion = computed(() => appStore.version)
const buildDate = '2026-08-25'
const channel = 'Stable'

/* ── 环境与维护：本地服务端 / 日志级别 / 缓存清理（真实 IPC） ──── */
const serverRunning = ref<boolean>(false)
const serverDesc = ref<string>('http://127.0.0.1:8000 · 检测中…')
const serverBusy = ref<boolean>(false)
const logLevel = ref<string>('INFO')
const cacheClearing = ref<boolean>(false)
const actionHint = ref<string>('')

async function pingServer() {
  const t = tintin()
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
  const t = tintin()
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
  const t = tintin()
  if (t?.env) {
    try { const r = await t.env.clearCache(); actionHint.value = r?.ok ? '已清理缓存' : '清理失败' } catch (_e) { actionHint.value = '清理失败' }
  } else { actionHint.value = '预览环境：无 IPC' }
  setTimeout(() => { actionHint.value = ''; cacheClearing.value = false }, 1200)
}

async function saveLogLevel() { await writeCfg('env.logLevel', logLevel.value) }

/** 服务接入：LLM 连接测试（server:llmChat 真实 IPC） */
const testingLlm = ref<boolean>(false)
async function testLlm() {
  testingLlm.value = true
  const t = tintin()
  if (t?.server?.llmChat) {
    try {
      await t.server.llmChat({ messages: [{ role: 'user', content: 'ping' }] })
      actionHint.value = 'LLM 连接正常'
    } catch (_e) { actionHint.value = 'LLM 连接失败' }
  } else { actionHint.value = '预览环境：无 IPC' }
  setTimeout(() => { actionHint.value = ''; testingLlm.value = false }, 1400)
}

/* ═══════════════════════════════════════════════════════════
   A2 双模式：本地推理能力卡片（§1.5.4 规格）
   业务逻辑已收编至 composables/useInferenceSettings.ts（界面层零内嵌）
   ═══════════════════════════════════════════════════════════ */

const {
  currentMode,
  capability,
  pkgList,
  a2Busy,
  lastError,
  totalSizeMB,
  MODE_TABS,
  statusSummary,
  refreshA2,
  setMode,
  actOnPkg: _actOnPkg,
  attachDownloadBus,
} = useInferenceSettings()

/** 供模板调用的包装：保持原模板 @click 签名 */
function actOnPkg(row: PkgRow, action: 'download' | 'cancel' | 'uninstall') {
  void _actOnPkg(row, action)
}

/** 供模板调用的工具转发（pkg-chip 文件体积显示） */
function bytesToMB(n: number): string {
  return _bytesToMB(n)
}

let stopDownloadBus: (() => void) | null = null

onMounted(() => {
  // A2 初始化 + 挂载下载进度监听；用 await/try 代替 .then/.catch 链路，避免运行环境差异
  const initA2 = async () => {
    try { await refreshA2(false) } catch (_) { /* 离线/无 IPC 静默 */ }
    stopDownloadBus = attachDownloadBus()
  }
  initA2()
  // 加载真实配置并探测本地服务端
  ;(async () => {
    await loadExtCfg()
    logLevel.value = String(await readCfg('env.logLevel', 'INFO')).toUpperCase()
  })()
  pingServer()
})

onBeforeUnmount(() => {
  if (stopDownloadBus) { stopDownloadBus(); stopDownloadBus = null }
})
</script>

<template>
  <section class="settings">
    <!-- ─── 左侧设置菜单 240px ─── -->
    <aside class="settings-sidebar">
      <!-- 侧栏页头（对齐设计稿 settings：设置 + 副标题） -->
      <div class="side-head">
        <h1 class="side-title">设置</h1>
        <p class="side-sub">管理账号、模型与系统偏好</p>
      </div>
      <nav class="menu-list custom-scroll">
        <div
          v-for="m in menuItems"
          :key="m.id"
          class="menu-item"
          :class="{ active: activeMenu === m.id }"
          @click="activeMenu = m.id"
        >
          <div class="menu-ic">
            <!-- 图标集合 -->
            <svg v-if="m.icon === 'platform'" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <circle cx="12" cy="12" r="10" />
              <path d="M2 12h20" />
              <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
            </svg>
            <svg v-else-if="m.icon === 'local'" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
              <polyline points="13 2 13 9 20 9" />
            </svg>
            <svg v-else-if="m.icon === 'env'" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <path d="M12 2v4" />
              <path d="M12 18v4" />
              <path d="m4.93 4.93 2.83 2.83" />
              <path d="m16.24 16.24 2.83 2.83" />
              <path d="M2 12h4" />
              <path d="M18 12h4" />
              <path d="m4.93 19.07 2.83-2.83" />
              <path d="m16.24 7.76 2.83-2.83" />
              <circle cx="12" cy="12" r="4" />
            </svg>
            <svg v-else-if="m.icon === 'theme'" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z" />
            </svg>
            <svg v-else-if="m.icon === 'inference'" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <rect x="4" y="4" width="16" height="16" rx="2" />
              <rect x="9" y="9" width="6" height="6" />
              <line x1="9" y1="2" x2="9" y2="4" />
              <line x1="15" y1="2" x2="15" y2="4" />
              <line x1="9" y1="20" x2="9" y2="22" />
              <line x1="15" y1="20" x2="15" y2="22" />
              <line x1="2" y1="9" x2="4" y2="9" />
              <line x1="2" y1="15" x2="4" y2="15" />
              <line x1="20" y1="9" x2="22" y2="9" />
              <line x1="20" y1="15" x2="22" y2="15" />
            </svg>
            <svg v-else-if="m.icon === 'ext'" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
              <path d="M3.27 6.96 12 12.01l8.73-5.05" />
              <line x1="12" y1="22.08" x2="12" y2="12" />
            </svg>
            <svg v-else width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="16" x2="12" y2="12" />
              <line x1="12" y1="8" x2="12.01" y2="8" />
            </svg>
          </div>
          <div class="menu-text">
            <div class="menu-label">{{ m.label }}</div>
            <div v-if="m.desc" class="menu-desc">{{ m.desc }}</div>
          </div>
        </div>
      </nav>

      <div class="sidebar-foot">
        <button class="back-btn" @click="backToWorkbench">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M19 12H5" />
            <path d="M12 19l-7-7 7-7" />
          </svg>
          返回工作台
        </button>
      </div>
    </aside>

    <!-- ─── 右侧设置内容区 ─── -->
    <main class="settings-main custom-scroll">
      <div class="content-inner">
        <!-- 标题栏 -->
        <header class="p-header">
          <h1 class="p-title">系统设置</h1>
          <p class="p-sub">配置平台连接、本地环境、扩展与版本信息。</p>
        </header>

        <!-- 一、平台接入卡（LLM 设置 / 服务接入，对齐设计稿） -->
        <section class="luo-card">
          <div class="luo-card-head">
            <div>
              <h2 class="luo-card-title">平台接入</h2>
              <p class="luo-card-desc">配置大模型 API、服务账号与联网能力。</p>
            </div>
          </div>

          <div class="seg-wrap">
            <div class="segmented">
              <button
                v-for="t in platTabs"
                :key="t"
                class="seg-item"
                :class="{ active: activePlatTab === t }"
                @click="activePlatTab = t"
              >{{ t }}</button>
            </div>
          </div>

          <div class="setting-list">
            <!-- LLM 设置 -->
            <div v-if="activePlatTab === 'LLM 设置'">
              <div class="setting-row">
                <div>
                  <div class="setting-label">默认模型</div>
                  <div class="setting-desc">选择会话中默认使用的模型</div>
                </div>
                <select v-model="defaultModel" class="input w-56">
                  <option v-for="m in modelOptions" :key="m" :value="m">{{ m }}</option>
                </select>
              </div>
              <div class="setting-row">
                <div>
                  <div class="setting-label">API Key</div>
                  <div class="setting-desc">用于调用模型服务的密钥</div>
                </div>
                <input v-model="apiKey" type="password" class="input w-72" />
              </div>
              <div class="setting-row">
                <div>
                  <div class="setting-label">Base URL</div>
                  <div class="setting-desc">自定义 API 代理地址</div>
                </div>
                <input v-model="baseUrl" type="text" class="input w-72" />
              </div>
              <div class="setting-row">
                <div>
                  <div class="setting-label">启用联网搜索</div>
                  <div class="setting-desc">让模型在必要时检索实时信息</div>
                </div>
                <button
                  type="button"
                  class="switch"
                  :class="{ on: webSearch }"
                  :aria-checked="webSearch"
                  role="switch"
                  @click="webSearch = !webSearch"
                >
                  <span class="knob" />
                </button>
              </div>
            </div>

            <!-- 服务接入 -->
            <div v-else>
              <div class="setting-row">
                <div>
                  <div class="setting-label">本地服务端</div>
                  <div class="setting-desc">{{ serverDesc }}</div>
                </div>
                <button class="btn-secondary-sm" @click="pingServer">刷新状态</button>
              </div>
              <div class="setting-row">
                <div>
                  <div class="setting-label">LLM 连接测试</div>
                  <div class="setting-desc">向当前模型发送一条探测消息以校验接入</div>
                </div>
                <button class="btn-secondary-sm primary-sm" :disabled="testingLlm" @click="testLlm">
                  {{ testingLlm ? '测试中…' : '测试连接' }}
                </button>
              </div>
            </div>
          </div>
        </section>

        <!-- 二、本地配置卡 -->
        <section class="luo-card">
          <div class="luo-card-head">
            <div>
              <h2 class="luo-card-title">本地配置</h2>
              <p class="luo-card-desc">运行时相关的路径、字体与网络代理。</p>
            </div>
          </div>

          <div class="seg-wrap">
            <div class="segmented small">
              <button
                v-for="t in localTabs"
                :key="t"
                class="seg-item"
                :class="{ active: activeLocalTab === t }"
                @click="activeLocalTab = t"
              >{{ t }}</button>
            </div>
          </div>

          <div class="path-row">
            <div class="path-label">当前数据目录</div>
            <div class="path-value">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
              </svg>
              <span>C:\Users\TinTin\AppData\Roaming\TinTin\workspace</span>
            </div>
            <div class="path-actions">
              <button class="btn-secondary-sm">浏览</button>
              <button class="btn-secondary-sm">打开</button>
            </div>
          </div>
        </section>

        <!-- 二+、外观主题卡（本地配置分组：亮/暗/跟随系统 3 档） -->
        <section class="luo-card theme-card">
          <div class="luo-card-head">
            <div>
              <h2 class="luo-card-title">外观主题</h2>
              <p class="luo-card-desc">{{ appStore.themeModeLabel }}</p>
            </div>
          </div>

          <div class="seg-wrap">
            <div class="segmented" role="tablist" aria-label="外观主题">
              <button
                v-for="t in THEME_TABS"
                :key="t.value"
                class="seg-item"
                :class="{ active: appStore.themeMode === t.value }"
                role="tab"
                :aria-selected="appStore.themeMode === t.value"
                @click="appStore.setThemeMode(t.value)"
              >
                <span class="seg-icon" aria-hidden="true">{{ t.icon }}</span>
                {{ t.label }}
              </button>
            </div>
          </div>

          <div class="theme-preview" aria-hidden="true">
            <div class="tp-pane" :class="appStore.resolvedTheme">
              <div class="tp-topbar">
                <span class="tp-dot red"></span>
                <span class="tp-dot yellow"></span>
                <span class="tp-dot green"></span>
                <span class="tp-title">工作台预览</span>
              </div>
              <div class="tp-body">
                <div class="tp-side"></div>
                <div class="tp-main">
                  <div class="tp-line primary"></div>
                  <div class="tp-line short"></div>
                  <div class="tp-line"></div>
                  <div class="tp-btn">示例按钮</div>
                </div>
              </div>
            </div>
            <div class="tp-meta">
              <div class="tp-meta-row">
                <span class="tp-swatch swatch-bg"></span>
                <span class="tp-label">背景</span>
                <span class="tp-value">
                  {{ appStore.resolvedTheme === 'dark' ? 'slate-950 (#0b0c10)' : 'white (#ffffff)' }}
                </span>
              </div>
              <div class="tp-meta-row">
                <span class="tp-swatch swatch-primary"></span>
                <span class="tp-label">主色</span>
                <span class="tp-value">
                  indigo {{ appStore.resolvedTheme === 'dark' ? '400 #818cf8' : '500 #6366f1' }}
                </span>
              </div>
              <div class="tp-meta-row">
                <span class="tp-swatch swatch-border"></span>
                <span class="tp-label">分割线</span>
                <span class="tp-value">
                  {{ appStore.resolvedTheme === 'dark' ? 'slate-700' : 'slate-200' }}
                </span>
              </div>
            </div>
          </div>
        </section>

        <!-- 三、环境与维护卡（对齐设计稿：服务状态、日志与存储管理） -->
        <section class="luo-card">
          <div class="luo-card-head">
            <div>
              <h2 class="luo-card-title">环境与维护</h2>
              <p class="luo-card-desc">服务状态、日志与存储管理。</p>
            </div>
          </div>
          <div class="setting-list">
            <div class="setting-row">
              <div class="server-cell">
                <span class="status-dot" :class="serverRunning ? 'ok' : 'down'"></span>
                <div>
                  <div class="setting-label">本地服务端</div>
                  <div class="setting-desc">{{ serverDesc }}</div>
                </div>
              </div>
              <button class="btn-secondary-sm" @click="restartServer">{{ serverBusy ? '重启中…' : '重启服务' }}</button>
            </div>
            <div class="setting-row">
              <div>
                <div class="setting-label">日志级别</div>
                <div class="setting-desc">控制台与日志文件输出详细程度</div>
              </div>
              <select v-model="logLevel" class="input w-40" @change="saveLogLevel">
                <option>INFO</option>
                <option>DEBUG</option>
                <option>WARNING</option>
              </select>
            </div>
            <div class="setting-row">
              <div>
                <div class="setting-label">缓存清理</div>
                <div class="setting-desc">释放临时文件与预览缓存占用的空间</div>
              </div>
              <button class="btn-secondary-sm" :disabled="cacheClearing" @click="clearCache">{{ cacheClearing ? '清理中…' : '立即清理' }}</button>
            </div>
            <div v-if="actionHint" class="env-hint">{{ actionHint }}</div>
          </div>
        </section>

        <!-- ══════════════════════════════════════════════════════════
             三+、扩展插件 · A2 本地推理能力（§1.5.4 规格）
             ══════════════════════════════════════════════════════════ -->
        <section class="luo-card a2-card">
          <div class="luo-card-head">
            <div>
              <h2 class="luo-card-title">本地推理能力</h2>
              <p class="luo-card-desc">
                按需下载 ONNX 模型（约 {{ totalSizeMB }} MB）与原生扩展后，OCR、向量检索、封面合成可 100% 在本地运行，
                断网仍可用，数据不出本机，符合隐私合规要求。
              </p>
            </div>
            <div class="a2-status-chip" :class="currentMode">
              <span class="dot" />
              {{ statusSummary() }}
            </div>
          </div>

          <!-- 推理模式分段控件（3 档）-->
          <div class="a2-mode-section">
            <div class="a2-section-label">推理模式</div>
            <div class="segmented">
              <button
                v-for="m in MODE_TABS"
                :key="m.value"
                class="seg-item"
                :class="{ active: currentMode === m.value, disabled: a2Busy }"
                :disabled="a2Busy"
                @click="setMode(m.value)"
              >{{ m.label }}</button>
            </div>
            <p class="a2-mode-hint">
              {{ MODE_TABS.find(x => x.value === currentMode)?.hint }}
            </p>
          </div>

          <!-- 能力概览（4 指标）-->
          <div class="a2-grid-metrics">
            <div class="a2-metric">
              <div class="a2-m-k">原生模块</div>
              <div class="a2-m-v"><span :class="capability?.nativeModulesOk ? 'ok' : 'no'">{{ capability?.nativeModulesOk ? '就绪' : '未加载' }}</span></div>
            </div>
            <div class="a2-metric">
              <div class="a2-m-k">模型文件</div>
              <div class="a2-m-v"><span :class="capability?.modelsOk ? 'ok' : 'no'">{{ capability?.modelsOk ? '完整' : '缺失' }}</span></div>
            </div>
            <div class="a2-metric">
              <div class="a2-m-k">本地平均耗时</div>
              <div class="a2-m-v">{{ capability?.avgLocalMs ? capability.avgLocalMs.toFixed(0) + ' ms' : '—' }}</div>
            </div>
            <div class="a2-metric">
              <div class="a2-m-k">清单版本</div>
              <div class="a2-m-v mono">{{ capability?.manifestVersion || '—' }}</div>
            </div>
          </div>

          <!-- 模型包列表 -->
          <div class="a2-pkg-title">模型 / 扩展包</div>
          <div class="a2-pkg-list">
            <div v-for="p in pkgList" :key="p.id" class="a2-pkg-row">
              <div class="pkg-main">
                <div class="pkg-row-head">
                  <div class="pkg-name">{{ p.label }}</div>
                  <div class="pkg-size">≈ {{ p.totalSizeMB }} MB</div>
                </div>
                <div class="pkg-desc">{{ p.desc }}</div>
                <div class="pkg-files">
                  <span v-for="f in p.files.slice(0, 3)" :key="f.name" class="pkg-chip">
                    {{ f.name }}
                    <em>{{ bytesToMB(f.size) }} MB</em>
                  </span>
                  <span v-if="p.files.length > 3" class="pkg-chip more">+{{ p.files.length - 3 }} 更多</span>
                </div>
                <div v-if="p.status === 'DOWNLOADING' && p.progress !== undefined" class="pkg-prog">
                  <div class="pkg-prog-bar"><div class="pkg-prog-fill" :style="{ width: p.progress + '%' }" /></div>
                  <div class="pkg-prog-num">{{ p.progress }}%</div>
                </div>
              </div>
              <div class="pkg-actions">
                <template v-if="p.status === 'INSTALLED'">
                  <span class="pkg-status ok">✓ 已安装</span>
                  <button class="btn-secondary-sm danger" @click="actOnPkg(p, 'uninstall')" :disabled="a2Busy">卸载</button>
                </template>
                <template v-else-if="p.status === 'DOWNLOADING'">
                  <span class="pkg-status pending">下载中</span>
                  <button class="btn-secondary-sm" @click="actOnPkg(p, 'cancel')" :disabled="a2Busy">取消</button>
                </template>
                <template v-else-if="p.status === 'SKIPPED'">
                  <span class="pkg-status muted">当前平台跳过</span>
                </template>
                <template v-else>
                  <span class="pkg-status muted">未下载</span>
                  <button class="btn-primary-sm" @click="actOnPkg(p, 'download')" :disabled="a2Busy">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                      <polyline points="7 10 12 15 17 10" />
                      <line x1="12" y1="15" x2="12" y2="3" />
                    </svg>
                    下载
                  </button>
                </template>
              </div>
            </div>
          </div>

          <!-- 错误提示 -->
          <div v-if="lastError" class="a2-error">{{ lastError }}</div>

          <!-- 脚注：不阻塞 / 自动降级说明 -->
          <div class="a2-footnote">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="16" x2="12" y2="12" />
              <line x1="12" y1="8" x2="12.01" y2="8" />
            </svg>
            本地能力缺失或异常时，OCR / 向量 / 封面制作会自动降级到服务端 HTTP，用户零感知；绝不会因为模型未下载而导致功能不可用。
          </div>
        </section>

        <!-- 扩展插件卡（下载插件 / 自动上架，对齐原来客户端） -->
        <section class="luo-card">
          <div class="luo-card-head">
            <div>
              <h2 class="luo-card-title">扩展插件</h2>
              <p class="luo-card-desc">浏览器采集扩展与电商自动上架能力入口。</p>
            </div>
          </div>

          <div class="seg-wrap">
            <div class="segmented">
              <button
                v-for="t in extTabs"
                :key="t"
                class="seg-item"
                :class="{ active: activeExtTab === t }"
                @click="activeExtTab = t"
              >{{ t }}</button>
            </div>
          </div>

          <div class="setting-list">
            <template v-if="activeExtTab === '下载插件'">
              <div class="setting-row">
                <div>
                  <div class="setting-label">采集桥接服务端口</div>
                  <div class="setting-desc">浏览器扩展桥接服务监听端口</div>
                </div>
                <input v-model="bridgePort" type="text" class="input w-32" />
              </div>
              <div class="setting-row">
                <div>
                  <div class="setting-label">采集保存目录</div>
                  <div class="setting-desc">扩展采集结果的本地保存路径</div>
                </div>
                <div class="setting-row-right">
                  <input v-model="bridgeSaveDir" type="text" class="input w-64" />
                  <button class="btn-secondary-sm" @click="browseDir('bridgeSaveDir')">浏览</button>
                </div>
              </div>
              <div class="setting-row">
                <div>
                  <div class="setting-label">服务端扫描入库</div>
                  <div class="setting-desc">采集完成后自动扫描并入库到服务端</div>
                </div>
                <button
                  type="button"
                  class="switch"
                  :class="{ on: extScanServer }"
                  role="switch"
                  :aria-checked="extScanServer"
                  @click="extScanServer = !extScanServer; saveExtension()"
                >
                  <span class="knob" />
                </button>
              </div>
              <div class="setting-row">
                <div>
                  <div class="setting-label">保存配置</div>
                  <div class="setting-desc">将下载插件配置持久化到本地</div>
                </div>
                <button class="btn-secondary-sm primary-sm" @click="saveExtension">保存</button>
              </div>
            </template>

            <template v-else>
              <div class="setting-row">
                <div>
                  <div class="setting-label">Chrome 调试端口</div>
                  <div class="setting-desc">复用已登录 Chrome（CDP 调试端口）</div>
                </div>
                <input v-model="chromePort" type="text" class="input w-32" />
              </div>
              <div class="setting-row">
                <div>
                  <div class="setting-label">Chrome 可执行路径</div>
                  <div class="setting-desc">调试 Chrome 的可执行文件位置</div>
                </div>
                <div class="setting-row-right">
                  <input v-model="chromePath" type="text" class="input w-64" />
                  <button class="btn-secondary-sm" @click="browseFile">浏览</button>
                </div>
              </div>
              <div class="setting-row">
                <div>
                  <div class="setting-label">user-data-dir</div>
                  <div class="setting-desc">固定浏览器配置目录，复用登录态</div>
                </div>
                <div class="setting-row-right">
                  <input v-model="chromeDataDir" type="text" class="input w-64" />
                  <button class="btn-secondary-sm" @click="browseDir('chromeDataDir')">浏览</button>
                </div>
              </div>
              <div class="setting-row">
                <div>
                  <div class="setting-label">Chrome 连接状态</div>
                  <div class="setting-desc" :class="cdpState.toLowerCase().includes('已连接') ? 'svc-ok' : ''">{{ cdpState }}</div>
                </div>
                <button class="btn-secondary-sm" :disabled="cdpBusy" @click="detectChrome">{{ cdpBusy ? '检测中…' : '检测 Chrome' }}</button>
              </div>
              <div class="setting-row">
                <div>
                  <div class="setting-label">店铺关键词</div>
                  <div class="setting-desc">数据包命名校验用的店铺关键词</div>
                </div>
                <input v-model="shopKeyword" type="text" class="input w-32" />
              </div>
              <div class="setting-row">
                <div>
                  <div class="setting-label">自动上架任务</div>
                  <div class="setting-desc">先检测调试 Chrome；后台上架流程为本地技能链路</div>
                </div>
                <button class="btn-secondary-sm primary-sm" @click="saveExtension">保存配置</button>
              </div>
            </template>
          </div>
        </section>

        <!-- 四、关于卡 -->
        <section class="luo-card about">
          <div class="luo-card-head">
            <div>
              <h2 class="luo-card-title">关于</h2>
              <p class="luo-card-desc">客户端组件版本、更新频道与开源许可信息。</p>
            </div>
          </div>

          <div class="about-grid">
            <div class="about-item">
              <div class="about-k">客户端版本</div>
              <div class="about-v">{{ appVersion }}</div>
            </div>
            <div class="about-item">
              <div class="about-k">组件版本</div>
              <div class="about-v">组件库 @luosiding/ui 0.9.3</div>
            </div>
            <div class="about-item">
              <div class="about-k">构建时间</div>
              <div class="about-v">{{ buildDate }}</div>
            </div>
            <div class="about-item">
              <div class="about-k">更新频道</div>
              <div class="about-v">
                <span class="channel-tag">{{ channel }}</span>
              </div>
            </div>
          </div>

          <div class="about-actions">
            <button class="btn-secondary-sm">检查更新</button>
            <button class="btn-ghost-sm">开源许可协议</button>
          </div>
        </section>
      </div>
    </main>
  </section>
</template>

<style scoped>
.settings {
  display: flex;
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: var(--background);
}

/* ─── 左栏 ─── */
.settings-sidebar {
  flex: 0 0 240px;
  width: 240px;
  background: var(--surface);
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
}

/* ─── 侧栏页头（设计稿对齐） ─── */
.side-head {
  padding: var(--space-4) var(--space-4) var(--space-2);
}
.side-title {
  margin: 0;
  font-size: var(--font-size-h3);
  font-weight: 700;
  line-height: 1.2;
  color: var(--foreground);
}
.side-sub {
  margin: 4px 0 0;
  font-size: var(--font-size-caption);
  color: var(--muted-foreground);
}

.menu-list {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: var(--space-2) var(--space-3) var(--space-4);
}

.menu-item {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  padding: 10px 12px;
  margin-bottom: 2px;
  border-radius: var(--radius-lg);
  cursor: pointer;
  transition: all var(--duration-fast);
}

.menu-ic {
  flex: 0 0 auto;
  width: 32px;
  height: 32px;
  border-radius: 10px;
  background: var(--surface-container);
  color: var(--muted-foreground);
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all var(--duration-fast);
}

.menu-text {
  flex: 1 1 auto;
  min-width: 0;
}

.menu-label {
  font-size: 13px;
  font-weight: 600;
  color: var(--foreground);
  line-height: 1.3;
}

.menu-desc {
  margin-top: 2px;
  font-size: 11px;
  color: var(--muted-foreground);
  line-height: 1.3;
}

.menu-item:hover {
  background: var(--surface-container);
}
.menu-item:hover .menu-ic {
  color: var(--primary);
}

.menu-item.active {
  background: var(--primary);
}
.menu-item.active .menu-label,
.menu-item.active .menu-desc {
  color: var(--primary-foreground);
}
.menu-item.active .menu-ic {
  background: rgba(255, 255, 255, 0.15);
  color: var(--primary-foreground);
}

.sidebar-foot {
  padding: var(--space-4);
  border-top: 1px solid var(--border);
}

.back-btn {
  width: 100%;
  height: 40px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  color: var(--foreground);
  font-size: var(--font-size-body);
  font-weight: 500;
  transition: all var(--duration-fast);
}

.back-btn:hover {
  background: var(--surface-container-high);
  border-color: var(--primary);
  color: var(--primary);
}

/* ─── 主内容区 ─── */
.settings-main {
  flex: 1 1 auto;
  min-width: 0;
  overflow-y: auto;
}

.content-inner {
  max-width: 960px;
  margin: 0 auto;
  padding: var(--space-6);
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
}

.p-header {
  margin-bottom: var(--space-2);
}
.p-title {
  margin: 0;
  font-size: 28px;
  font-weight: 800;
  line-height: 1.2;
  color: var(--foreground);
  letter-spacing: -0.01em;
}
.p-sub {
  margin: 8px 0 0;
  color: var(--muted-foreground);
  font-size: var(--font-size-body);
}

/* 设置卡片 */
.luo-card {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: var(--radius-xl);
  padding: var(--space-5);
  box-shadow: var(--shadow-1);
}

.luo-card-head {
  margin-bottom: var(--space-4);
}

.luo-card-title {
  margin: 0;
  font-size: var(--font-size-h2);
  font-weight: 700;
  line-height: var(--line-height-tight);
  color: var(--foreground);
}
.luo-card-desc {
  margin: 6px 0 0;
  color: var(--muted-foreground);
  font-size: var(--font-size-body);
}

/* 分段控件 */
.seg-wrap {
  margin: 0 calc(-1 * var(--space-1)) var(--space-4);
  padding: 0 var(--space-1);
}
.segmented {
  display: inline-flex;
  align-items: center;
  padding: 4px;
  background: var(--surface-container);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  gap: 2px;
}
.segmented.small .seg-item { height: 34px; padding: 0 14px; font-size: 13px; }

.seg-item {
  height: 38px;
  padding: 0 18px;
  border-radius: calc(var(--radius-lg) - 2px);
  border: none;
  background: transparent;
  color: var(--muted-foreground);
  font-size: var(--font-size-body);
  font-weight: 600;
  cursor: pointer;
  transition: all var(--duration-fast);
  white-space: nowrap;
}
.seg-item:hover { color: var(--foreground); }
.seg-item.active {
  background: var(--card);
  color: var(--primary);
  box-shadow: var(--shadow-1);
}

/* 设置行（平台接入·LLM 设置，对齐设计稿 setting-row） */
.setting-list { width: 100%; }
.setting-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  padding: 14px 0;
  border-bottom: 1px solid var(--border-subtle);
}
.setting-row:last-child { border-bottom: none; }
.setting-row:first-child { padding-top: 0; }
.setting-label {
  font-size: var(--font-size-body);
  font-weight: 600;
  color: var(--foreground);
  margin-bottom: 4px;
}
.setting-desc {
  font-size: 13px;
  color: var(--muted-foreground);
}

/* 输入框与宽度（对齐设计稿 .input / w-*） */
.input {
  height: 40px;
  padding: 0 14px;
  background: var(--surface-container);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  color: var(--foreground);
  outline: none;
  font-size: var(--font-size-body);
  transition: all var(--duration-fast);
}
.input:focus {
  border-color: var(--primary);
  box-shadow: 0 0 0 3px var(--ring);
  background: var(--card);
}
.w-32 { width: 128px; }
.w-56 { width: 224px; }
.w-64 { width: 256px; }
.w-72 { width: 288px; }

.setting-row-right {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
}

.btn-secondary-sm.primary-sm {
  background: var(--primary);
  border-color: var(--primary);
  color: var(--primary-foreground);
}
.btn-secondary-sm.primary-sm:hover {
  filter: brightness(1.05);
  color: var(--primary-foreground);
}

/* Switch 开关 */
.switch {
  flex: 0 0 auto;
  position: relative;
  width: 46px;
  height: 26px;
  padding: 0;
  border-radius: 999px;
  background: var(--surface-container-high);
  border: 1px solid var(--border);
  cursor: pointer;
  transition: all var(--duration-fast);
}
.switch .knob {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 20px;
  height: 20px;
  border-radius: 999px;
  background: var(--card);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.15);
  transition: all var(--duration-fast);
}
.switch.on {
  background: var(--primary);
  border-color: var(--primary);
}
.switch.on .knob {
  transform: translateX(20px);
}

/* 路径选择行 */
.path-row {
  display: grid;
  grid-template-columns: 110px 1fr auto;
  gap: var(--space-3);
  align-items: center;
  padding: var(--space-4);
  background: var(--surface-container);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
}

.path-label {
  font-size: 13px;
  font-weight: 600;
  color: var(--muted-foreground);
}
.path-value {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  font-size: 13px;
  color: var(--foreground);
  background: var(--card);
  padding: 8px 12px;
  border-radius: 10px;
  border: 1px solid var(--border);
  min-width: 0;
}
.path-value svg {
  flex: 0 0 auto;
  color: var(--primary);
}
.path-value span {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.path-actions {
  display: inline-flex;
  gap: var(--space-2);
}

.btn-secondary-sm {
  height: 34px;
  padding: 0 14px;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 10px;
  color: var(--foreground);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: all var(--duration-fast);
}
.btn-secondary-sm:hover {
  border-color: var(--primary);
  color: var(--primary);
}
.btn-ghost-sm {
  height: 34px;
  padding: 0 14px;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 10px;
  color: var(--muted-foreground);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: all var(--duration-fast);
}
.btn-ghost-sm:hover {
  color: var(--primary);
  background: var(--primary-container);
}

/* 环境与维护：服务状态 + 日志级别 + 缓存清理 */
.status-dot {
  flex: 0 0 auto;
  width: 8px;
  height: 8px;
  border-radius: var(--radius-full);
  background: var(--muted-foreground);
}
.status-dot.ok   { background: var(--success); box-shadow: 0 0 0 3px rgba(16, 185, 129, 0.18); }
.status-dot.down { background: var(--error);   box-shadow: 0 0 0 3px rgba(239, 68, 68, 0.18); }

.server-cell {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}
.w-40 { width: 160px; }

.env-hint {
  margin-top: var(--space-2);
  padding: 8px 12px;
  border-radius: var(--radius-md);
  background: var(--surface-container);
  font-size: 12px;
  color: var(--primary);
}
.svc-ok { color: var(--success); font-weight: 600; }

/* 关于 */
.about-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-3);
  margin-bottom: var(--space-5);
}

.about-item {
  padding: var(--space-4);
  background: var(--surface-container);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
}
.about-k {
  font-size: 11px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--muted-foreground);
  font-weight: 600;
}
.about-v {
  margin-top: 6px;
  font-size: 14px;
  font-weight: 600;
  color: var(--foreground);
}

.channel-tag {
  display: inline-block;
  padding: 3px 10px;
  background: var(--success-container);
  color: var(--success);
  font-size: 11px;
  font-weight: 700;
  border-radius: 999px;
  line-height: 1.2;
}

.about-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3);
  padding-top: var(--space-4);
  border-top: 1px solid var(--border);
}

.custom-scroll::-webkit-scrollbar { width: 6px; height: 6px; }
.custom-scroll::-webkit-scrollbar-thumb { background: var(--surface-container-high); border-radius: 3px; }

/* 按钮变体补充（A2 本地推理卡 / 队列卡用） */
.btn-primary-sm {
  height: 34px;
  padding: 0 14px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: var(--primary);
  border: 1px solid var(--primary);
  border-radius: 10px;
  color: var(--primary-foreground);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: all var(--duration-fast);
}
.btn-primary-sm:hover { filter: brightness(1.05); }
.btn-primary-sm:disabled,
.btn-secondary-sm:disabled { opacity: 0.5; cursor: not-allowed; transform: none !important; }

.btn-secondary-sm.danger {
  color: var(--error);
  border-color: rgba(239, 68, 68, 0.25);
}
.btn-secondary-sm.danger:hover {
  background: var(--error-container);
  color: var(--error);
  border-color: var(--error);
}

.segmented .seg-item.disabled { opacity: 0.5; cursor: not-allowed; }
.segmented .seg-icon {
  display: inline-flex; align-items: center; justify-content: center;
  width: 18px; margin-right: 6px; font-size: 14px; line-height: 1;
}

/* ═══════════════════════════════════════════════════════════
   外观主题卡：预览小窗 + 色板说明
   ═══════════════════════════════════════════════════════════ */
.theme-card .theme-preview {
  display: grid;
  grid-template-columns: 1.25fr 1fr;
  gap: var(--space-4);
  padding-top: var(--space-2);
}
.theme-card .tp-pane {
  width: 100%; aspect-ratio: 16 / 10;
  border-radius: var(--radius-lg);
  overflow: hidden;
  border: 1px solid var(--border-subtle);
  box-shadow: var(--shadow-card);
  transition: background var(--duration-normal), color var(--duration-normal),
              border-color var(--duration-normal);
}
.theme-card .tp-pane.light {
  background: #ffffff; color: var(--luosiding-slate-900);
  border-color: var(--luosiding-slate-200);
}
.theme-card .tp-pane.dark {
  background: #0b0c10; color: var(--luosiding-slate-50);
  border-color: var(--luosiding-slate-700);
}
.theme-card .tp-topbar {
  height: 26px; padding: 0 10px;
  display: flex; align-items: center; gap: 6px;
  border-bottom: 1px solid var(--border-subtle);
  font-size: 11px; font-weight: 600;
}
.theme-card .tp-pane.light .tp-topbar { background: #f5f6fa; color: #54576a; border-color: #e5e7ec; }
.theme-card .tp-pane.dark  .tp-topbar { background: #121425; color: #9ea1b2; border-color: #1d2138; }

.theme-card .tp-dot {
  width: 9px; height: 9px; border-radius: 50%;
  box-shadow: inset 0 0 0 0.5px rgba(0,0,0,0.15);
}
.theme-card .tp-dot.red    { background: #ff6159; }
.theme-card .tp-dot.yellow { background: #ffbd2e; }
.theme-card .tp-dot.green  { background: #28c940; }
.theme-card .tp-title { margin-left: 8px; }

.theme-card .tp-body {
  display: grid; grid-template-columns: 84px 1fr;
  height: calc(100% - 26px);
}
.theme-card .tp-side {
  border-right: 1px solid var(--border-subtle);
}
.theme-card .tp-pane.light .tp-side { background: #f5f6fa; border-color: #e5e7ec; }
.theme-card .tp-pane.dark  .tp-side { background: #121425; border-color: #1d2138; }

.theme-card .tp-main {
  padding: 14px 16px; display: flex; flex-direction: column; gap: 9px;
}
.theme-card .tp-line {
  height: 7px; border-radius: 999px;
  background: var(--muted);
}
.theme-card .tp-line.primary { height: 9px; background: var(--primary); width: 42%; opacity: 0.85; }
.theme-card .tp-line.short   { width: 68%; opacity: 0.85; }
.theme-card .tp-btn {
  margin-top: auto;
  align-self: flex-start;
  padding: 6px 14px; border-radius: 999px;
  background: var(--primary); color: #fff;
  font-size: 12px; font-weight: 600;
  box-shadow: 0 1px 2px rgba(99,102,241,0.25);
}
.theme-card .tp-pane.light .tp-line { background: var(--luosiding-slate-200); }
.theme-card .tp-pane.dark  .tp-line { background: var(--luosiding-slate-700); }

.theme-card .tp-meta {
  display: flex; flex-direction: column; gap: var(--space-3);
  padding-top: 4px;
}
.theme-card .tp-meta-row {
  display: grid;
  grid-template-columns: 22px 54px 1fr;
  gap: var(--space-2);
  align-items: center;
  font-size: 13px;
}
.theme-card .tp-swatch {
  width: 20px; height: 20px; border-radius: 6px;
  border: 1px solid var(--border-subtle);
  box-shadow: inset 0 0 0 0.5px rgba(255,255,255,0.4);
}
.theme-card .tp-swatch.swatch-bg      { background: var(--background); }
.theme-card .tp-swatch.swatch-primary { background: var(--primary); }
.theme-card .tp-swatch.swatch-border  { background: var(--border); }

.theme-card .tp-label { color: var(--muted-foreground); font-size: 12px; }
.theme-card .tp-value { color: var(--foreground); font-variant-numeric: tabular-nums; }

/* 主题卡响应式 */
@media (max-width: 900px) {
  .theme-card .theme-preview { grid-template-columns: 1fr; }
}
@media (max-width: 560px) {
  .theme-card .tp-body { grid-template-columns: 68px 1fr; }
  .theme-card .tp-main { padding: 10px 12px; }
}

/* ═══════════════════════════════════════════════════════════════
   A2 · 本地推理能力卡片（§1.5.4 规格）
   ═══════════════════════════════════════════════════════════════ */
.a2-card .luo-card-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-4);
}

.a2-status-chip {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--surface-container);
  color: var(--muted-foreground);
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
  max-width: 50%;
}
.a2-status-chip .dot {
  width: 8px; height: 8px; border-radius: 50%;
  background: var(--muted-foreground);
  box-shadow: 0 0 0 3px rgba(148,163,184,0.15);
}
.a2-status-chip.server-only    { color: var(--warning); border-color: rgba(245, 158, 11, 0.25); background: var(--warning-container); }
.a2-status-chip.server-only .dot  { background: var(--warning); box-shadow: 0 0 0 3px rgba(245,158,11,0.18); }
.a2-status-chip.hybrid-auto    { color: var(--primary); border-color: rgba(59,130,246,0.25); background: var(--primary-container); }
.a2-status-chip.hybrid-auto .dot  { background: var(--primary); box-shadow: 0 0 0 3px rgba(59,130,246,0.18); }
.a2-status-chip.force-local    { color: var(--success); border-color: rgba(16,185,129,0.25); background: var(--success-container); }
.a2-status-chip.force-local .dot  { background: var(--success); box-shadow: 0 0 0 3px rgba(16,185,129,0.18); }

.a2-mode-section { margin-bottom: var(--space-5); }
.a2-section-label {
  font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase;
  font-weight: 700; color: var(--muted-foreground); margin-bottom: var(--space-2);
}
.a2-mode-hint {
  margin: var(--space-2) 0 0;
  font-size: 13px; color: var(--muted-foreground); line-height: 1.55;
}

/* 4 指标网格 */
.a2-grid-metrics {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: var(--space-3);
  margin-bottom: var(--space-5);
}
.a2-metric {
  padding: var(--space-4);
  background: var(--surface-container);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
}
.a2-m-k {
  font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase;
  color: var(--muted-foreground); font-weight: 600;
}
.a2-m-v { margin-top: 6px; font-size: 15px; font-weight: 700; color: var(--foreground); }
.a2-m-v .ok { color: var(--success); }
.a2-m-v .no { color: var(--error); }
.a2-m-v .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; }

/* 模型包列表 */
.a2-pkg-title {
  font-size: 13px; font-weight: 700; color: var(--foreground);
  margin-bottom: var(--space-2);
}
.a2-pkg-list {
  display: flex; flex-direction: column; gap: var(--space-2);
  margin-bottom: var(--space-4);
}
.a2-pkg-row {
  display: flex; align-items: stretch; gap: var(--space-4);
  padding: var(--space-4);
  background: var(--surface-container);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  transition: border-color var(--duration-fast);
}
.a2-pkg-row:hover { border-color: var(--primary); }

.pkg-main { flex: 1 1 auto; min-width: 0; }
.pkg-row-head {
  display: flex; align-items: baseline; justify-content: space-between;
  gap: var(--space-2); margin-bottom: 4px;
}
.pkg-name { font-size: 14px; font-weight: 700; color: var(--foreground); }
.pkg-size { font-size: 12px; font-weight: 600; color: var(--muted-foreground); }
.pkg-desc { font-size: 13px; color: var(--muted-foreground); line-height: 1.5; margin-bottom: var(--space-2); }
.pkg-files { display: flex; flex-wrap: wrap; gap: 6px; }
.pkg-chip {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 3px 10px;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 999px;
  font-size: 11px; font-weight: 500; color: var(--muted-foreground);
}
.pkg-chip em {
  font-style: normal;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  opacity: 0.7;
}
.pkg-chip.more { background: var(--surface-container-high); }

.pkg-prog {
  display: flex; align-items: center; gap: var(--space-2);
  margin-top: var(--space-2);
}
.pkg-prog-bar {
  flex: 1 1 auto; height: 6px;
  background: var(--surface-container-high);
  border-radius: 999px; overflow: hidden;
}
.pkg-prog-fill {
  height: 100%; width: 0;
  background: linear-gradient(90deg, var(--primary), var(--tertiary));
  transition: width 0.25s ease;
}
.pkg-prog-num {
  flex: 0 0 auto; font-size: 12px; font-weight: 700;
  font-variant-numeric: tabular-nums; color: var(--primary);
  width: 44px; text-align: right;
}

.pkg-actions {
  flex: 0 0 auto;
  display: inline-flex; flex-direction: column; align-items: flex-end;
  justify-content: center; gap: 8px;
  min-width: 140px;
}
.pkg-status {
  font-size: 12px; font-weight: 600;
}
.pkg-status.ok    { color: var(--success); }
.pkg-status.pending { color: var(--primary); }
.pkg-status.muted { color: var(--muted-foreground); }

.a2-error {
  margin-top: var(--space-3);
  padding: 10px 14px;
  background: var(--error-container);
  border: 1px solid rgba(239, 68, 68, 0.25);
  color: var(--error);
  border-radius: var(--radius-lg);
  font-size: 13px; line-height: 1.5;
}

.a2-footnote {
  margin-top: var(--space-4);
  display: flex; align-items: flex-start; gap: 8px;
  padding: var(--space-3) var(--space-4);
  background: var(--surface-container);
  border: 1px dashed var(--border);
  border-radius: var(--radius-lg);
  font-size: 12px; line-height: 1.6;
  color: var(--muted-foreground);
}
.a2-footnote svg { flex: 0 0 auto; margin-top: 1px; color: var(--warning); }

/* ─── 响应式 ─── */
@media (max-width: 900px) {
  .settings-sidebar {
    position: absolute;
    z-index: 50;
    height: 100%;
    transform: translateX(-100%);
    transition: transform var(--duration-normal) var(--easing-default);
    box-shadow: var(--shadow-3);
  }
  .settings-sidebar.open { transform: translateX(0); }
  .content-inner { padding: var(--space-4); }
  .about-grid { grid-template-columns: 1fr; }
  .path-row {
    grid-template-columns: 1fr;
    gap: var(--space-2);
  }
  .path-actions { justify-content: flex-end; }
  .a2-grid-metrics { grid-template-columns: repeat(2, 1fr); }
}

@media (max-width: 560px) {
  .segmented { flex-wrap: wrap; }
  .a2-grid-metrics { grid-template-columns: 1fr 1fr; }
  .a2-pkg-row { flex-direction: column; gap: var(--space-3); }
  .pkg-actions { flex-direction: row; justify-content: space-between; align-items: center; min-width: 0; }
  .a2-status-chip { max-width: 100%; }
}
</style>
