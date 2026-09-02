<script setup lang="ts">
// ═══════════════════════════════════════════════════════════════
// Settings.vue — 系统设置容器（左栏7菜单项 + 右区设置卡片接线）
// 拆分后职责：
//   · 子组件引用与 props/emits 接线（业务逻辑在 composables/useSettings*.ts）
//   · onMounted/onBeforeUnmount 编排（A2 初始加载 / 下载总线启停 / 配置回读 / ping）
//   · 布局级样式；公用卡片样式在 components/settings/settings-shared.css
// 2026-08-30 用户裁决（对齐原客户端 system_settings_dialog.py SETTINGS_MENUS：
// 平台接入/本地配置/环境与维护/扩展插件/任务队列/关于）：
//   · 删除「系统与运行」卡：自启动→环境与维护；缓存目录+LUT→本地配置；
//     系统信息→关于
//   · 本地配置：删除「数据目录/字体/代理」占位，改为 缓存目录 + LUT
//     （CardLocalConfig 卡）
//   · 环境与维护：删除「本地服务端」状态区块；内嵌日志查看器完整移植
//     （文件下拉+级别/关键词过滤，useLogViewer + logViewLogic）
//   · 账号与登录：删除「抖音」tab（保留飞书/即梦）
// ═══════════════════════════════════════════════════════════════

import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { useAppStore } from '../stores/app'
import { useSettingsGeneral } from '../composables/useSettingsGeneral'
import { useSettingsAccounts } from '../composables/useSettingsAccounts'
import { useSettingsIntegration } from '../composables/useSettingsIntegration'
import { useLogViewer, } from '../composables/useLogViewer'
import { LOG_LEVEL_FILTERS } from '../composables/logViewLogic'
import { useEnvCheck } from '../composables/useEnvCheck'
import SettingsSidebar, { type SettingsMenuItem } from '../components/settings/SettingsSidebar.vue'
import CardPlatform from '../components/settings/CardPlatform.vue'
import CardAccountLogin from '../components/settings/CardAccountLogin.vue'
import CardLocalConfig from '../components/settings/CardLocalConfig.vue'
import CardTheme from '../components/settings/CardTheme.vue'
import CardEnvMaint from '../components/settings/CardEnvMaint.vue'
import CardA2Inference from '../components/settings/CardA2Inference.vue'
import CardAbout from '../components/settings/CardAbout.vue'

const router = useRouter()
const route = useRoute()
const appStore = useAppStore()

/* ── 左侧菜单（顺序与右侧卡片流一致，供 scrollspy 对位） ───── */
const menuItems = ref<SettingsMenuItem[]>([
  { id: 'platform',   label: '平台接入',   desc: '服务端 · 模型',        icon: 'platform' },
  { id: 'account',    label: '账号与登录', desc: '飞书 · 即梦',          icon: 'account' },
  { id: 'local',      label: '本地配置',   desc: '缓存目录 · 清理 · LUT', icon: 'local' },
  { id: 'theme',      label: '外观主题',   desc: '亮色 / 暗色 / 跟随',   icon: 'theme' },
  { id: 'env',        label: '环境与维护', desc: '日志 · 自启动 · 检测', icon: 'env' },
  { id: 'inference',  label: '本地推理能力', desc: 'OCR · 向量 · 封面', icon: 'inference' },
  { id: 'about',      label: '关于',       desc: '版本 V' + appStore.version, icon: 'about' }
])

const activeMenu = ref<string>('platform')

/* ── scrollspy：点击菜单滚动到对应卡；右区滚动时同步高亮菜单 ── */
const settingsMainRef = ref<HTMLElement | null>(null)
/** 菜单 id 与右侧 [data-section] 锚点一一对应，顺序 = 滚动流顺序 */
const SECTION_ORDER = ['platform', 'account', 'local', 'theme', 'env', 'inference', 'about']
/** 点击滚动期间的 spy 锁，避免平滑滚动经过中间卡片时高亮闪烁 */
let spyLocked = false
let spyUnlockTimer: ReturnType<typeof setTimeout> | null = null

function lockSpy() {
  spyLocked = true
  if (spyUnlockTimer) clearTimeout(spyUnlockTimer)
  spyUnlockTimer = setTimeout(() => { spyLocked = false }, 900)
}

function onMenuSelect(id: string) {
  activeMenu.value = id
  const container = settingsMainRef.value
  if (!container) return
  const el = container.querySelector(`[data-section="${id}"]`)
  if (!el) return
  lockSpy()
  el.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

function onMainScroll() {
  if (spyLocked) return
  const container = settingsMainRef.value
  if (!container) return
  const threshold = container.getBoundingClientRect().top + 140
  let cur = SECTION_ORDER[0]
  for (const id of SECTION_ORDER) {
    const el = container.querySelector(`[data-section="${id}"]`)
    if (el && (el as HTMLElement).getBoundingClientRect().top <= threshold) cur = id
  }
  // 滚动到底：强制最后一项（关于卡较矮时仍能命中）
  if (container.scrollTop + container.clientHeight >= container.scrollHeight - 2) {
    cur = SECTION_ORDER[SECTION_ORDER.length - 1]
  }
  if (cur !== activeMenu.value) activeMenu.value = cur
}

function backToWorkbench() {
  router.push('/')
}

/* ── 服务端 / 环境维护：useSettingsGeneral 单实例接线 ── */
const {
  platTabs,
  activePlatTab,
  modelOptions,
  defaultModel,
  webSearch,
  savingLlm,
  saveLlm,
  loadLlmCfg,
  serverDesc,
  serverUrl,
  savingServerUrl,
  saveServerUrl,
  testingFuncs,
  funcResults,
  testFunction,
  perFunctionTest,
  logLevel,
  cacheClearing,
  actionHint,
  pingServer,
  clearCache,
  saveLogLevel,
  loadEnvCfg,
  machineCode,
} = useSettingsGeneral()

/* ── 日志查看器（对齐原客户端日志查看页；过滤编组在 logViewLogic） ── */
const {
  logFiles,
  logsDir,
  selectedLog,
  levelFilter,
  keyword,
  filteredLines,
  loading: logLoading,
  truncated: logTruncated,
  loadError: logError,
  actionMsg: logActionMsg,
  loadLogList,
  selectLogFile,
  copyLog,
  clearLog,
} = useLogViewer()

/* ── 账号与登录卡：飞书配置 + 即梦登录态（useSettingsAccounts 单实例） ── */
const {
  feishu,
  FEISHU_FIELDS: accountFeishuFields,
  fieldValue: feishuFieldValue,
  appSecretMasked,
  feishuSaving,
  feishuHint,
  feishuTestBusy,
  feishuTestResult,
  loadFeishuCfg,
  saveFeishu,
  testFeishu,
  jimengState,
  jimengChecking,
  checkJimeng,
} = useSettingsAccounts()

/* ── 本地配置（缓存目录/LUT）+ 系统信息：useSettingsIntegration 单实例。
 *    2026-08-30 用户裁决：「系统与运行」卡解散——自启动迁环境与维护、
 *    缓存目录+LUT 迁本地配置、系统信息迁关于；S8 平台接入此前已移除。 ── */
const {
  autoStart,
  autoStartLoading,
  toggleAutoStart,
  cacheDir,
  cacheDirIsDefault,
  pickCacheDir,
  lutList,
  addLut,
  removeLut,
  sysInfoRows,
  sysInfoLoading,
  loadSysInfo,
  hint: integrationHint,
  loadIntegrationCfg,
} = useSettingsIntegration()

/* ── 环境检测（条目⑪ 口径重定义）：服务端连通/能力健康 + 本地资源 ── */
const { envRows, envChecking, runEnvCheck } = useEnvCheck()

/** 日志级别变更：先写回状态再持久化（对齐原 v-model + @change=saveLogLevel） */
async function onLogLevelChange(v: string) {
  logLevel.value = v
  await saveLogLevel()
}

/* ── 关于卡 props 组装（原散落于 Settings.vue 的常量） ─────── */
const appVersion = computed(() => appStore.version)
// 构建时间：vite.config.ts define 注入（'YYYY-MM-DD HH:mm'，含时分以区分同日多次出包）
const buildDate = __BUILD_TIME__
const channel = 'Stable'

/* ═══════════════════════════════════════════════════════════
   A2 双模式编排：初始加载与下载进度总线由容器生命周期触发，
   状态与动作全部收编于 components/settings/CardA2Inference 内部
   ═══════════════════════════════════════════════════════════ */
const a2Ref = ref<InstanceType<typeof CardA2Inference> | null>(null)

let stopDownloadBus: (() => void) | null = null

onMounted(() => {
  // scrollspy：右区滚动 → 同步左侧菜单高亮
  settingsMainRef.value?.addEventListener('scroll', onMainScroll, { passive: true })
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
    await loadLlmCfg() // LLM 对接：本地偏好回读 + 服务端模型列表拉取
    await loadFeishuCfg() // 条目⑩：飞书配置回读（Secret 不回显，仅脱敏标记）
    void checkJimeng() // 条目⑩：即梦登录态自动检测（失败静默不阻塞）
    void loadLogList() // 日志查看器：文件列表加载（默认选中最新一份）
    void loadIntegrationCfg() // 自启动/缓存目录/LUT/系统信息
  })()
  pingServer()
  // 跨页定位：浏览器左栏「服务端」入口 → /settings?focus=server（2026-08-31）。
  // 平台接入卡的 tab 默认即「服务端」，这里显式置一次防止未来默认值变更；
  // nextTick 等右区 DOM 就绪后滚动到平台接入区（onMenuSelect 自带 spy 锁）。
  if (route.query.focus === 'server') {
    activePlatTab.value = '服务端'
    void nextTick(() => onMenuSelect('platform'))
  }
})

onBeforeUnmount(() => {
  settingsMainRef.value?.removeEventListener('scroll', onMainScroll)
  if (spyUnlockTimer) { clearTimeout(spyUnlockTimer); spyUnlockTimer = null }
  if (stopDownloadBus) { stopDownloadBus(); stopDownloadBus = null }
})
</script>

<template>
  <section class="settings">
    <!-- ─── 左侧设置菜单 240px ─── -->
    <SettingsSidebar
      :items="menuItems"
      :active-menu="activeMenu"
      @select="onMenuSelect"
      @back="backToWorkbench"
    />

    <!-- ─── 右侧设置内容区 ─── -->
    <main ref="settingsMainRef" class="settings-main custom-scroll">
      <div class="content-inner">
        <!-- 标题栏 -->
        <header class="p-header">
          <h1 class="p-title">系统设置</h1>
          <p class="p-sub">配置平台连接、本地环境、扩展与版本信息。</p>
        </header>

        <!-- 一、平台接入卡（服务端/模型；2026-08-30 用户裁决：数字人/ComfyUI/RunningHub
             已通过服务端接入且原客户端已删除，客户端不再保留直连配置） -->
        <CardPlatform
          data-section="platform"
          :plat-tabs="platTabs"
          v-model:active-tab="activePlatTab"
          :model-options="modelOptions"
          v-model:default-model="defaultModel"
          v-model:web-search="webSearch"
          :saving-llm="savingLlm"
          :server-desc="serverDesc"
          v-model:server-url="serverUrl"
          :saving-server-url="savingServerUrl"
          :testing-funcs="testingFuncs"
          :func-results="funcResults"
          @save-llm="saveLlm"
          @save-server-url="saveServerUrl"
          @refresh-server="pingServer"
          @test-func="testFunction"
          @test-funcs-all="perFunctionTest"
        />

        <!-- 一+、账号与登录卡（条目⑩：飞书七字段 + 即梦登录态；2026-08-30 删抖音 tab） -->
        <CardAccountLogin
          data-section="account"
          :fields="accountFeishuFields"
          :get-field="feishuFieldValue"
          :app-secret-masked="appSecretMasked"
          :saving="feishuSaving"
          :hint="feishuHint"
          :test-busy="feishuTestBusy"
          :test-result="feishuTestResult"
          :jimeng-state="jimengState"
          :jimeng-checking="jimengChecking"
          @field-input="(k: string, v: string) => { feishu[k] = v }"
          @save="saveFeishu"
          @test-conn="testFeishu"
          @check-jimeng="checkJimeng"
        />

        <!-- 二、本地配置卡（缓存目录 + 缓存清理 + LUT；2026-08-30 删数据目录/字体/代理占位，
             闭环整改：缓存清理自环境与维护迁入与缓存目录同卡） -->
        <CardLocalConfig
          data-section="local"
          :cache-dir="cacheDir"
          :cache-dir-is-default="cacheDirIsDefault"
          :lut-list="lutList"
          :hint="integrationHint"
          :cache-clearing="cacheClearing"
          :clear-hint="actionHint"
          @pick-cache-dir="pickCacheDir"
          @add-lut="addLut"
          @remove-lut="removeLut"
          @clear="clearCache"
        />

        <!-- 二+、外观主题卡（本地配置分组：亮/暗/跟随系统 3 档） -->
        <CardTheme data-section="theme" />

        <!-- 三、环境与维护卡（日志查看器完整移植 + 自启动迁入；删「本地服务端」区块，
             闭环整改：缓存清理迁出至本地配置卡） -->
        <CardEnvMaint
          data-section="env"
          :auto-start="autoStart"
          :auto-start-loading="autoStartLoading"
          :log-level="logLevel"
          :env-rows="envRows"
          :env-checking="envChecking"
          :log-files="logFiles"
          :logs-dir="logsDir"
          :selected-log="selectedLog"
          :level-filter="levelFilter"
          :level-filters="LOG_LEVEL_FILTERS"
          :keyword="keyword"
          :filtered-lines="filteredLines"
          :log-loading="logLoading"
          :log-truncated="logTruncated"
          :log-error="logError"
          @toggle-autostart="toggleAutoStart"
          @change-loglevel="onLogLevelChange"
          @run-env-check="runEnvCheck"
          @refresh-logs="loadLogList"
          @select-log="selectLogFile"
          @change-level-filter="(v: string) => levelFilter = v"
          @change-keyword="(v: string) => keyword = v"
          @copy-log="copyLog"
          @clear-log="clearLog"
          :log-action-msg="logActionMsg"
        />

        <!-- 三+、扩展插件 · A2 本地推理能力（§1.5.4 规格） -->
        <CardA2Inference ref="a2Ref" data-section="inference" />

        <!-- 四、关于卡（含本机机器码 + 系统信息；2026-08-30 系统信息自「系统与运行」迁入） -->
        <CardAbout
          data-section="about"
          :app-version="appVersion"
          :build-date="buildDate"
          :channel="channel"
          :machine-code="machineCode"
          :sys-info-rows="sysInfoRows"
          :sys-info-loading="sysInfoLoading"
          @refresh-sysinfo="loadSysInfo"
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
}
</style>
