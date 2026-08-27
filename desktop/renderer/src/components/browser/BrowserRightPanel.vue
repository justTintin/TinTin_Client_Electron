<script setup lang="ts">
// BrowserRightPanel — 浏览器页右栏容器（双 Tab 壳：媒体嗅探 / 下载管理）
// 原 866 行超「单文件 ≤800 行」红线，按「容器 + 展示组件」拆分：
//   · SniffTab.vue     媒体嗅探 Tab（B站插件 / 页面解析 / 嗅探卡片及其样式）
//   · DownloadsTab.vue 下载管理 Tab（增强任务卡 / 旧下载卡及其样式）
// 对外 props/emits 接口与拆分前逐字一致，views/Browser.vue 零改动。
// 模板与样式来源：views/Browser.vue 原 template L1568-1808 +
// style .browser-rightbar/.rightbar-tabs/.rb-tab*/.side-scroll 区段
// （类名/结构不变）。
import type {
  DownloadItem,
  SniffedMedia,
  BiliExtDownload,
  MediaDownloadTask,
} from '../../composables/useBrowserDownloads'
import SniffTab from './SniffTab.vue'
import DownloadsTab from './DownloadsTab.vue'

defineProps<{
  /** <1200px 滑出面板展开态 */
  open: boolean
  /** 活跃 Tab：'sniff' | 'downloads'（v-model:activeTab） */
  activeTab: 'sniff' | 'downloads'
  /** 嗅探条数（Tab 徽标） */
  sniffedCount: number
  /** 进行中任务数（Tab 徽标） */
  activeDownloadCount: number
  /** 嗅探到的媒体列表 */
  sniffedMedia: SniffedMedia[]
  /** 增强下载任务卡片 */
  mediaDownloadTasks: MediaDownloadTask[]
  /** 兼容旧 will-download 的下载卡片 */
  downloads: DownloadItem[]
  /** B站已装插件下载模式（替代嗅探列表） */
  biliPluginMode: boolean
  /** B站扩展推送标题 */
  biliExtTitle: string
  /** B站扩展推送的下载链接列表 */
  biliExtDownloads: BiliExtDownload[]
  /** 是否 Electron 壳模式 */
  isElectronShell: boolean
  /** 当前平台 ID（页面解析下载按钮显隐用） */
  activePlatformId: string | null
  /** 地址栏 URL（页面解析按钮禁用判断） */
  pageUrl: string
  /** 速度格式化（downloads 域 _formatSpeed） */
  formatSpeed: (bps: number) => string
  /** 状态文案（downloads 域 dlStatusText） */
  dlStatusText: (d: DownloadItem) => string
}>()

const emit = defineEmits<{
  (e: 'update:activeTab', tab: 'sniff' | 'downloads'): void
  (e: 'download-media', m: SniffedMedia): void
  (e: 'download-bili', dl: BiliExtDownload): void
  (e: 'page-download'): void
  (e: 'pause-task', t: MediaDownloadTask): void
  (e: 'cancel-task', t: MediaDownloadTask): void
  (e: 'remove-task', t: MediaDownloadTask): void
}>()
</script>

<template>
  <aside class="browser-rightbar" :class="{ open }">
    <div class="rightbar-tabs">
      <button
        class="rb-tab"
        :class="{ active: activeTab === 'sniff' }"
        @click="emit('update:activeTab', 'sniff')"
      >
        媒体嗅探
        <span v-if="sniffedCount > 0" class="rb-tab-badge">{{ sniffedCount }}</span>
      </button>
      <button
        class="rb-tab"
        :class="{ active: activeTab === 'downloads' }"
        @click="emit('update:activeTab', 'downloads')"
      >
        下载管理
        <span v-if="activeDownloadCount > 0" class="rb-tab-badge active">{{ activeDownloadCount }}</span>
      </button>
    </div>
    <div class="side-scroll custom-scroll">
      <!-- Tab: 媒体嗅探 -->
      <template v-if="activeTab === 'sniff'">
        <SniffTab
          :bili-plugin-mode="biliPluginMode"
          :bili-ext-title="biliExtTitle"
          :bili-ext-downloads="biliExtDownloads"
          :is-electron-shell="isElectronShell"
          :active-platform-id="activePlatformId"
          :page-url="pageUrl"
          :sniffed-media="sniffedMedia"
          @download-media="emit('download-media', $event)"
          @download-bili="emit('download-bili', $event)"
          @page-download="emit('page-download')"
        />
      </template>

      <!-- Tab: 下载管理 -->
      <template v-else>
        <DownloadsTab
          :media-download-tasks="mediaDownloadTasks"
          :downloads="downloads"
          :format-speed="formatSpeed"
          :dl-status-text="dlStatusText"
          @pause-task="emit('pause-task', $event)"
          @cancel-task="emit('cancel-task', $event)"
          @remove-task="emit('remove-task', $event)"
        />
      </template>
    </div>
  </aside>
</template>

<style scoped>
/* ─── 右栏：下载管理 ─── */
.browser-rightbar {
  flex: 0 0 240px;
  width: 240px;
  background: var(--surface);
  border-left: 1px solid var(--border);
  display: flex;
  flex-direction: column;
}

/* ─── 通用侧栏块 ─── */
.side-scroll {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 12px 10px;
}

.custom-scroll::-webkit-scrollbar { width: 6px; height: 6px; }
.custom-scroll::-webkit-scrollbar-thumb { background: var(--surface-container-high); border-radius: 3px; }

/* ═══ Phase 2: 右栏 Tabs ═══ */
.rightbar-tabs {
  display: flex;
  gap: 0;
  flex-shrink: 0;
  background: var(--surface);
  border-bottom: 1px solid var(--border);
}

.rb-tab {
  flex: 1 1 50%;
  padding: 10px 12px;
  font-size: 12px;
  font-weight: 500;
  color: var(--muted-foreground);
  background: transparent;
  border: none;
  border-bottom: 2px solid transparent;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  transition: all var(--duration-fast);
}

.rb-tab:hover {
  color: var(--foreground);
  background: var(--surface-container);
}

.rb-tab.active {
  color: var(--primary);
  border-bottom-color: var(--primary);
  font-weight: 600;
}

.rb-tab-badge {
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  border-radius: 9px;
  background: var(--surface-container-high);
  color: var(--muted-foreground);
  font-size: 10px;
  font-weight: 600;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.rb-tab-badge.active {
  background: var(--primary);
  color: var(--primary-foreground);
}

@media (max-width: 1199px) {
  .browser-rightbar {
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    z-index: 50;
    width: 260px;
    transform: translateX(100%);
    transition: transform var(--duration-normal) var(--easing-default);
    box-shadow: var(--shadow-3);
  }
  .browser-rightbar.open {
    transform: translateX(0);
  }
}

@media (prefers-reduced-motion: reduce) {
  .browser-rightbar {
    transition: none;
  }
}
</style>
