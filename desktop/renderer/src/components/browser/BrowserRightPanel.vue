<script setup lang="ts">
// BrowserRightPanel — 浏览器页右栏容器（媒体嗅探单栏）
// 下载管理已迁出右栏：实时进度内嵌在嗅探卡片（SniffTab），
// 历史与文件操作迁移至工具栏⬇按钮唤起的 downloads-panel.html 浮窗。
// 模板与样式来源：views/Browser.vue 原 template 区段
// （类名/结构不变）。
import type {
  SniffedMedia,
  BiliExtDownload,
  MediaDownloadTask,
} from '../../composables/useBrowserDownloads'
import SniffTab from './SniffTab.vue'

defineProps<{
  /** <1200px 滑出面板展开态 */
  open: boolean
  /** 嗅探到的媒体列表 */
  sniffedMedia: SniffedMedia[]
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
  /** 增强下载任务（卡片内嵌进度绑定） */
  mediaTasks: MediaDownloadTask[]
}>()

const emit = defineEmits<{
  (e: 'download-media', m: SniffedMedia): void
  (e: 'download-bili', dl: BiliExtDownload): void
  (e: 'page-download'): void
}>()
</script>

<template>
  <aside class="browser-rightbar" :class="{ open }">
    <div class="side-scroll custom-scroll">
      <SniffTab
        :bili-plugin-mode="biliPluginMode"
        :bili-ext-title="biliExtTitle"
        :bili-ext-downloads="biliExtDownloads"
        :is-electron-shell="isElectronShell"
        :active-platform-id="activePlatformId"
        :page-url="pageUrl"
        :sniffed-media="sniffedMedia"
        :media-tasks="mediaTasks"
        @download-media="emit('download-media', $event)"
        @download-bili="emit('download-bili', $event)"
        @page-download="emit('page-download')"
      />
    </div>
  </aside>
</template>

<style scoped>
/* ─── 右栏 ─── */
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
