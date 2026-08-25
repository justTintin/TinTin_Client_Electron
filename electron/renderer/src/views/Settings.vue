<script setup lang="ts">
// ═══════════════════════════════════════════════════════════════
// Settings.vue — 系统设置（左栏6菜单项 + 右区4类设置 + A2本地推理卡）
// ═══════════════════════════════════════════════════════════════

import { ref, onMounted, computed } from 'vue'
import { useRouter } from 'vue-router'
import { useAppStore, type ThemeMode } from '../stores/app'

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
  { id: 'platform',   label: '平台接入',   desc: '抖音 · 视频号 · 快手', icon: 'platform' },
  { id: 'local',      label: '本地配置',   desc: '数据路径 · 代理',      icon: 'local' },
  { id: 'env',        label: '环境维护',   desc: '缓存 · 诊断 · 重启',   icon: 'env' },
  { id: 'ext',        label: '扩展插件',   desc: '本地推理 · 插件生态',  icon: 'ext' },
  { id: 'queue',      label: '任务队列',   desc: '查看全部任务进度',     icon: 'queue' },
  { id: 'about',      label: '关于',       desc: '版本 v1.0.0-beta.2',   icon: 'about' }
])

const activeMenu = ref<string>('platform')

function backToWorkbench() {
  router.push('/')
}

/* ── 平台接入：分段控件 ──────────────────────────────────────── */
const platTabs = ['全局', '抖音', '视频号', '快手', '小红书']
const activePlatTab = ref<string>('全局')

interface SwitchRow {
  id: string
  title: string
  desc: string
  value: boolean
}

const switchRows = ref<SwitchRow[]>([
  { id: 's1', title: '自动同步数据',     desc: '后台周期性自动拉取最新的商品与达人数据到本地。', value: true },
  { id: 's2', title: '开启平台登录态共享', desc: '通过浏览器侧栏保持登录态，所有工具共享身份。',   value: true },
  { id: 's3', title: '启用失败重试',     desc: '上传或发布失败时按指数退避自动重试最多 3 次。',  value: false },
  { id: 's4', title: '启用素材本地缓存',  desc: '生成与下载的素材默认保留 30 天本地副本。',       value: true }
])

function toggleSwitch(row: SwitchRow) {
  row.value = !row.value
}

/* ── 本地配置：分段控件 ──────────────────────────────────────── */
const localTabs = ['数据目录', '字体', '代理']
const activeLocalTab = ref<string>('数据目录')

/* ── 关于：版本信息 ───────────────────────────────────────── */
const appVersion = 'v1.0.0-beta.2'
const buildDate = '2025-06-18'
const channel = 'Stable'

/* ═══════════════════════════════════════════════════════════
   A2 双模式：本地推理能力卡片（§1.5.4 规格）
   ═══════════════════════════════════════════════════════════ */

// 3 种模式（对齐 inference-router 的 store 取值）
const MODE_TABS: Array<{ value: 'server-only' | 'hybrid-auto' | 'force-local'; label: string; hint: string }> = [
  { value: 'server-only', label: '仅服务端', hint: '所有 OCR / 向量 / 封面走服务端 HTTP；新安装默认。' },
  { value: 'hybrid-auto', label: '混合自动', hint: '模型已下载时本地优先；失败/耗时过高自动切服务端（用户零感知）。' },
  { value: 'force-local', label: '强制本地', hint: '仅使用本地能力；本地不可用时直接返回错误，用于隐私合规场景。' },
]
const currentMode = ref<'server-only' | 'hybrid-auto' | 'force-local'>('server-only')

// 能力状态
type CapState = {
  mode: string
  nativeModulesOk: boolean
  modelsOk: boolean
  avgLocalMs: number
  manifestVersion?: string
} | null
const capability = ref<CapState>(null)

// 模型包列表
type PkgStatus = 'NOT_INSTALLED' | 'INSTALLED' | 'SKIPPED' | 'DOWNLOADING'
interface PkgRow {
  id: string
  label: string
  desc: string
  totalSizeMB: string
  status: PkgStatus
  progress?: number  // 0-100
  files: Array<{ name: string; size: number }>
}
const pkgList = ref<PkgRow[]>([])
const totalSizeMB = computed(() => {
  return (pkgList.value.reduce((s, p) => s + (parseFloat(p.totalSizeMB) || 0), 0)).toFixed(0)
})
const a2Busy = ref(false)
const lastError = ref<string | null>(null)

/* 工具：size → human MB */
function bytesToMB(n: number) {
  if (!n) return '0'
  return (n / 1024 / 1024).toFixed(1)
}

/* 能力描述 */
function statusSummary() {
  if (!capability.value) return '加载中…'
  if (currentMode.value === 'server-only')  return '当前：仅使用服务端推理（默认）。'
  if (currentMode.value === 'force-local')  return `当前：强制本地（原生模块 ${capability.value.nativeModulesOk ? '✓' : '✗'}，模型 ${capability.value.modelsOk ? '✓' : '✗'}）`
  if (capability.value.modelsOk && capability.value.nativeModulesOk) return '当前：混合自动模式 · 本地能力就绪 ✓'
  if (capability.value.nativeModulesOk && !capability.value.modelsOk) return '当前：混合自动模式 · 原生模块就绪，但模型尚未下载（自动走服务端）。'
  return '当前：混合自动模式 · 本地能力未就绪（自动走服务端）。'
}

/* 主流程：加载能力 + 模型清单 */
async function refreshA2(force = false) {
  const tintin = (window as any).tintin
  const ok =
    !!tintin?.inference &&
    typeof tintin.inference.getCapability === 'function' &&
    typeof tintin.inference.setMode === 'function' &&
    !!tintin?.model &&
    typeof tintin.model.listPkgs === 'function' &&
    typeof tintin.model.downloadPkg === 'function' &&
    typeof tintin.model.cancelPkg === 'function' &&
    typeof tintin.model.uninstallPkg === 'function'
  if (!ok) {
    lastError.value = 'A2 IPC 未就绪（preload.js 可能未加载）；当前所有推理仍走服务端 HTTP。'
    return
  }
  lastError.value = null
  try {
    const [capRes, listRes] = await Promise.all([
      tintin.inference.getCapability(force),
      tintin.model.listPkgs(),
    ])
    if (capRes?.success && capRes.data) {
      currentMode.value = (capRes.data.mode || 'server-only') as any
      capability.value = {
        mode: capRes.data.mode,
        nativeModulesOk: !!capRes.data.nativeModulesOk,
        modelsOk: !!capRes.data.modelsOk,
        avgLocalMs: capRes.data.avgLocalMs || 0,
        manifestVersion: capRes.data.detail?.manifestVersion,
      }
    }
    if (listRes?.success && Array.isArray(listRes.data)) {
      const labelMap: Record<string, { label: string; desc: string }> = {
        'ocr-paddle-int8':              { label: 'OCR · PaddleOCR INT8 3件套', desc: '本地图片/截图文字识别（det + rec + cls）' },
        'embedding-bge-small-zh':       { label: 'Embedding · bge-small-zh INT8', desc: '768 维中文向量生成，驱动本地知识库检索' },
        'native-addons-sqlitevss-sharp':{ label: '原生扩展 · sqlite-vss + sharp', desc: '向量 ANN 检索引擎、封面合成图像库（仅 Windows x64）' },
      }
      pkgList.value = listRes.data.map((p: any) => ({
        id: p.id,
        label: labelMap[p.id]?.label || p.id,
        desc:  labelMap[p.id]?.desc  || '',
        totalSizeMB: bytesToMB(p.totalSize),
        status: (p.status || 'NOT_INSTALLED') as PkgStatus,
        files: p.files || [],
      }))
    }
  } catch (e: any) {
    lastError.value = e?.message || String(e)
  }
}

/* 切换模式（写回 electron-store → inference:setMode） */
async function setMode(m: typeof currentMode.value) {
  const tintin = (window as any).tintin
  if (!tintin?.inference) return
  a2Busy.value = true
  try {
    await tintin.inference.setMode(m)
    currentMode.value = m
    // 刷新能力缓存
    await refreshA2(true)
  } catch (e: any) {
    lastError.value = e?.message || String(e)
  } finally {
    a2Busy.value = false
  }
}

/* 下载 / 取消 / 卸载 */
async function actOnPkg(row: PkgRow, action: 'download' | 'cancel' | 'uninstall') {
  const tintin = (window as any).tintin
  if (!tintin?.model) return
  a2Busy.value = true
  try {
    if (action === 'download') {
      row.status = 'DOWNLOADING'
      row.progress = 0
      const r = await tintin.model.downloadPkg(row.id)
      if (r?.skipped) {
        lastError.value = r.reason || 'SKIPPED'
      } else if (!r?.ok) {
        lastError.value = r?.error || '下载失败'
      }
    } else if (action === 'cancel') {
      await tintin.model.cancelPkg(row.id)
    } else if (action === 'uninstall') {
      await tintin.model.uninstallPkg(row.id)
    }
    await refreshA2(true)
  } catch (e: any) {
    lastError.value = e?.message || String(e)
  } finally {
    a2Busy.value = false
  }
}

/* Footer 下载总线监听：模型下载进度挂 downloads:progress */
function attachDownloadBus() {
  const tintin = (window as any).tintin
  if (!tintin?.downloads) return
  // 简化：每 5s 轮询 listPkgs 更新安装状态（避免任务ID跟踪）
  setInterval(() => refreshA2(false).catch(() => {}), 5000)
}

onMounted(() => {
  refreshA2(false).then(attachDownloadBus).catch(() => attachDownloadBus())
})
</script>

<template>
  <section class="settings">
    <!-- ─── 左侧设置菜单 240px ─── -->
    <aside class="settings-sidebar">
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
            <svg v-else-if="m.icon === 'ext'" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
              <path d="M3.27 6.96 12 12.01l8.73-5.05" />
              <line x1="12" y1="22.08" x2="12" y2="12" />
            </svg>
            <svg v-else-if="m.icon === 'queue'" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <line x1="8" y1="6" x2="21" y2="6" />
              <line x1="8" y1="12" x2="21" y2="12" />
              <line x1="8" y1="18" x2="21" y2="18" />
              <line x1="3" y1="6" x2="3.01" y2="6" />
              <line x1="3" y1="12" x2="3.01" y2="12" />
              <line x1="3" y1="18" x2="3.01" y2="18" />
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

        <!-- 一、平台接入卡 -->
        <section class="luo-card">
          <div class="luo-card-head">
            <div>
              <h2 class="luo-card-title">平台接入</h2>
              <p class="luo-card-desc">按平台分别配置登录态、数据同步和发布策略。</p>
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

          <div class="switch-list">
            <div v-for="row in switchRows" :key="row.id" class="switch-row">
              <div class="sw-text">
                <div class="sw-title">{{ row.title }}</div>
                <div class="sw-desc">{{ row.desc }}</div>
              </div>
              <button
                type="button"
                class="switch"
                :class="{ on: row.value }"
                :aria-checked="row.value"
                role="switch"
                @click="toggleSwitch(row)"
              >
                <span class="knob" />
              </button>
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

        <!-- 三、环境维护卡 -->
        <section class="luo-card">
          <div class="luo-card-head">
            <div>
              <h2 class="luo-card-title">环境维护</h2>
              <p class="luo-card-desc">清理缓存、诊断异常或重启后端服务进程。</p>
            </div>
          </div>
          <div class="btn-row">
            <button class="env-btn">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <polyline points="23 4 23 10 17 10" />
                <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
              </svg>
              清理缓存
            </button>
            <button class="env-btn">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <polyline points="1 4 1 10 7 10" />
                <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
              </svg>
              重启后端进程
            </button>
            <button class="env-btn primary">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <path d="M9 11l3 3L22 4" />
                <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
              </svg>
              一键诊断
            </button>
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

        <!-- 五、任务队列占位卡 -->
        <section class="luo-card queue-card">
          <div class="luo-card-head">
            <div>
              <h2 class="luo-card-title">任务队列</h2>
              <p class="luo-card-desc">全量媒体工具任务一览：成片 / 抠图 / 超分 / 语音克隆等。</p>
            </div>
            <button class="btn-secondary-sm">查看全部</button>
          </div>
          <div class="queue-list">
            <div v-for="i in 3" :key="i" class="queue-row">
              <div class="q-col q-name">
                <div class="q-dot" :class="['running','done','pending'][i-1]" />
                任务标题示例 {{ i }}
              </div>
              <div class="q-col q-type">成片 · 视频混剪</div>
              <div class="q-col q-prog">
                <div class="q-prog-bar"><div class="q-prog-fill" :style="{ width: [78, 100, 12][i-1] + '%' }" /></div>
              </div>
              <div class="q-col q-pct text-right">{{ [78, 100, 12][i-1] }}%</div>
              <div class="q-col q-eta">{{ ['剩余 02:13', '已完成', '排队中'][i-1] }}</div>
            </div>
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

.menu-list {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: var(--space-4) var(--space-3);
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

/* 开关行列表 */
.switch-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.switch-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  padding: var(--space-4);
  border-radius: var(--radius-lg);
  transition: background var(--duration-fast);
}
.switch-row:hover {
  background: var(--surface-container);
}

.sw-text { flex: 1 1 auto; min-width: 0; }
.sw-title {
  font-size: var(--font-size-body);
  font-weight: 600;
  color: var(--foreground);
  line-height: 1.4;
}
.sw-desc {
  margin-top: 2px;
  font-size: 13px;
  color: var(--muted-foreground);
  line-height: 1.5;
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

/* 环境维护按钮行 */
.btn-row {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3);
}

.env-btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  height: 42px;
  padding: 0 var(--space-5);
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  color: var(--foreground);
  font-size: var(--font-size-body);
  font-weight: 600;
  cursor: pointer;
  transition: all var(--duration-fast);
}
.env-btn:hover {
  border-color: var(--primary);
  transform: translateY(-1px);
  box-shadow: var(--shadow-2);
}
.env-btn.primary {
  background: var(--primary);
  border-color: var(--primary);
  color: var(--primary-foreground);
}
.env-btn.primary:hover {
  filter: brightness(1.05);
}

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

/* ═══════════════════════════════════════════════════════════════
   任务队列占位卡
   ═══════════════════════════════════════════════════════════════ */
.queue-card .luo-card-head {
  display: flex; align-items: center; justify-content: space-between; gap: var(--space-4);
}
.queue-list {
  display: flex; flex-direction: column; gap: var(--space-1);
}
.queue-row {
  display: grid;
  grid-template-columns: 1.6fr 1.2fr 2fr 56px 110px;
  gap: var(--space-3);
  align-items: center;
  padding: var(--space-3);
  border-radius: var(--radius-md);
  transition: background var(--duration-fast);
}
.queue-row:hover { background: var(--surface-container); }
.q-col { font-size: 13px; color: var(--foreground); min-width: 0; }
.q-col.text-right { text-align: right; }
.q-name { display: inline-flex; align-items: center; gap: 10px; font-weight: 600; }
.q-dot {
  width: 8px; height: 8px; border-radius: 50%; flex: 0 0 auto;
  box-shadow: 0 0 0 3px rgba(0,0,0,0.03);
}
.q-dot.running { background: var(--primary);  box-shadow: 0 0 0 3px rgba(59,130,246,0.18); }
.q-dot.done    { background: var(--success);  box-shadow: 0 0 0 3px rgba(16,185,129,0.18); }
.q-dot.pending { background: var(--muted-foreground); }
.q-type { color: var(--muted-foreground); }
.q-pct  { font-variant-numeric: tabular-nums; font-weight: 700; }
.q-eta  { color: var(--muted-foreground); font-size: 12px; text-align: right; }
.q-prog-bar {
  height: 6px; background: var(--surface-container-high);
  border-radius: 999px; overflow: hidden;
}
.q-prog-fill {
  height: 100%;
  background: linear-gradient(90deg, var(--primary), var(--tertiary));
  border-radius: 999px;
  transition: width 0.25s ease;
}

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
  .queue-row {
    grid-template-columns: 1fr 110px;
    grid-template-areas:
      "name eta"
      "type pct"
      "prog prog";
    gap: var(--space-2);
  }
  .queue-row .q-name { grid-area: name; }
  .queue-row .q-type { grid-area: type; }
  .queue-row .q-prog { grid-area: prog; }
  .queue-row .q-pct  { grid-area: pct; text-align: left; color: var(--primary); }
  .queue-row .q-eta  { grid-area: eta; }
}

@media (max-width: 560px) {
  .segmented { flex-wrap: wrap; }
  .btn-row { width: 100%; }
  .env-btn { flex: 1 1 calc(50% - var(--space-2)); }
  .a2-grid-metrics { grid-template-columns: 1fr 1fr; }
  .a2-pkg-row { flex-direction: column; gap: var(--space-3); }
  .pkg-actions { flex-direction: row; justify-content: space-between; align-items: center; min-width: 0; }
  .a2-status-chip { max-width: 100%; }
}
</style>
