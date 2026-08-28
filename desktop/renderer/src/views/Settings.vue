<script setup lang="ts">
// ═══════════════════════════════════════════════════════════════
// Settings.vue — 系统设置容器（左栏6菜单项 + 右区设置卡片接线）
// 拆分后职责：
//   · 子组件引用与 props/emits 接线（业务逻辑在 composables/useSettings*.ts）
//   · onMounted/onBeforeUnmount 编排（A2 初始加载 / 下载总线启停 / 配置回读 / ping）
//   · 布局级样式 + 本地配置卡（未独立成卡，保留于此）；
//     公用卡片样式在 components/settings/settings-shared.css（非 scoped 引入一次）
// ═══════════════════════════════════════════════════════════════

import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useAppStore } from '../stores/app'
import { useSettingsGeneral } from '../composables/useSettingsGeneral'
import SettingsSidebar, { type SettingsMenuItem } from '../components/settings/SettingsSidebar.vue'
import CardPlatform from '../components/settings/CardPlatform.vue'
import CardTheme from '../components/settings/CardTheme.vue'
import CardEnvMaint from '../components/settings/CardEnvMaint.vue'
import CardA2Inference from '../components/settings/CardA2Inference.vue'
import CardAbout from '../components/settings/CardAbout.vue'

const router = useRouter()
const appStore = useAppStore()

/* ── 左侧菜单 ──────────────────────────────────────────────── */
const menuItems = ref<SettingsMenuItem[]>([
  { id: 'platform',   label: '平台接入',   desc: 'LLM · 服务接入',       icon: 'platform' },
  { id: 'local',      label: '本地配置',   desc: '数据路径 · 代理',      icon: 'local' },
  { id: 'theme',      label: '外观主题',   desc: '亮色 / 暗色 / 跟随',   icon: 'theme' },
  { id: 'env',        label: '环境与维护', desc: '服务 · 日志 · 缓存',   icon: 'env' },
  { id: 'inference',  label: '本地推理能力', desc: 'OCR · 向量 · 封面', icon: 'inference' },
  { id: 'about',      label: '关于',       desc: '版本 V' + appStore.version, icon: 'about' }
])

const activeMenu = ref<string>('platform')

function backToWorkbench() {
  router.push('/')
}

/* ── 平台接入 / 本地配置 / 环境维护：useSettingsGeneral 单实例接线 ── */
const {
  platTabs,
  activePlatTab,
  modelOptions,
  defaultModel,
  apiKey,
  baseUrl,
  webSearch,
  testingLlm,
  testLlm,
  localTabs,
  activeLocalTab,
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
} = useSettingsGeneral()

/** 日志级别变更：先写回状态再持久化（对齐原 v-model + @change=saveLogLevel） */
async function onLogLevelChange(v: string) {
  logLevel.value = v
  await saveLogLevel()
}

/* ── 关于卡 props 组装（原散落于 Settings.vue 的常量） ─────── */
const appVersion = computed(() => appStore.version)
const buildDate = '2026-08-25'
const channel = 'Stable'

/* ═══════════════════════════════════════════════════════════
   A2 双模式编排：初始加载与下载进度总线由容器生命周期触发，
   状态与动作全部收编于 components/settings/CardA2Inference 内部
   ═══════════════════════════════════════════════════════════ */
const a2Ref = ref<InstanceType<typeof CardA2Inference> | null>(null)

let stopDownloadBus: (() => void) | null = null

onMounted(() => {
  // A2 初始化 + 挂载下载进度监听；用 await/try 代替 .then/.catch 链路，避免运行环境差异
  const initA2 = async () => {
    const comp = a2Ref.value
    if (!comp) return
    try { await comp.refreshA2(false) } catch (_) { /* 离线/无 IPC 静默 */ }
    stopDownloadBus = comp.attachDownloadBus()
  }
  initA2()
  // 加载真实配置并探测本地服务端
  ;(async () => {
    await loadEnvCfg()
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
    <SettingsSidebar
      :items="menuItems"
      :active-menu="activeMenu"
      @select="activeMenu = $event"
      @back="backToWorkbench"
    />

    <!-- ─── 右侧设置内容区 ─── -->
    <main class="settings-main custom-scroll">
      <div class="content-inner">
        <!-- 标题栏 -->
        <header class="p-header">
          <h1 class="p-title">系统设置</h1>
          <p class="p-sub">配置平台连接、本地环境、扩展与版本信息。</p>
        </header>

        <!-- 一、平台接入卡（LLM 设置 / 服务接入，对齐设计稿） -->
        <CardPlatform
          :plat-tabs="platTabs"
          v-model:active-tab="activePlatTab"
          :model-options="modelOptions"
          v-model:default-model="defaultModel"
          v-model:api-key="apiKey"
          v-model:base-url="baseUrl"
          v-model:web-search="webSearch"
          :testing-llm="testingLlm"
          :server-desc="serverDesc"
          @refresh-server="pingServer"
          @test-llm="testLlm"
        />

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
        <CardTheme />

        <!-- 三、环境与维护卡（对齐设计稿：服务状态、日志与存储管理） -->
        <CardEnvMaint
          :server-running="serverRunning"
          :server-desc="serverDesc"
          :server-busy="serverBusy"
          :log-level="logLevel"
          :cache-clearing="cacheClearing"
          :action-hint="actionHint"
          @restart="restartServer"
          @change-loglevel="onLogLevelChange"
          @clear="clearCache"
        />

        <!-- 三+、扩展插件 · A2 本地推理能力（§1.5.4 规格） -->
        <CardA2Inference ref="a2Ref" />

        <!-- 四、关于卡 -->
        <CardAbout
          :app-version="appVersion"
          :build-date="buildDate"
          :channel="channel"
        />
      </div>
    </main>
  </section>
</template>

<style src="../components/settings/settings-shared.css"></style>

<style scoped>
.settings {
  display: flex;
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: var(--background);
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

.custom-scroll::-webkit-scrollbar { width: 6px; height: 6px; }
.custom-scroll::-webkit-scrollbar-thumb { background: var(--surface-container-high); border-radius: 3px; }

/* ─── 响应式 ─── */
@media (max-width: 900px) {
  .content-inner { padding: var(--space-4); }
  .path-row {
    grid-template-columns: 1fr;
    gap: var(--space-2);
  }
  .path-actions { justify-content: flex-end; }
}
</style>
