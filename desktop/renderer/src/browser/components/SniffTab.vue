<script setup lang="ts">
// SniffTab — 右栏「媒体嗅探」Tab 展示组件（纯展示，无业务逻辑）
// 来源：views/Browser.vue 原 template（B站插件模式 / 页面解析下载 /
// 媒体嗅探卡片三区段）+ 对应 style，因 BrowserRightPanel 超 800 行红线
// 按「容器 + 展示组件」原样搬移至此——DOM 结构与类名不变，逻辑零改动。
import { ref } from 'vue'
import type {
  SniffedMedia,
  BiliExtDownload,
  MediaDownloadTask,
} from '../composables/useBrowserDownloads'

const props = defineProps<{
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
  /** 抖音分享链接解析结果提示（父组件执行 browser:douyinParse 后回传） */
  douyinParseMsg?: { ok: boolean; message: string } | null
  /** 嗅探到的媒体列表 */
  sniffedMedia: SniffedMedia[]
  /** 增强下载任务（卡片内嵌进度条按 taskId 绑定） */
  mediaTasks: MediaDownloadTask[]
}>()

defineEmits<{
  (e: 'download-media', m: SniffedMedia): void
  (e: 'download-bili', dl: BiliExtDownload): void
  (e: 'page-download'): void
  (e: 'douyin-parse', text: string): void
}>()

/** 抖音分享链接输入（UI 本地态；解析由父组件经 browser:douyinParse 执行） */
const shareText = ref('')

/** 按 taskId 取关联任务（展示辅助，无副作用） */
function taskOf(id?: string): MediaDownloadTask | undefined {
  if (!id) return undefined
  return props.mediaTasks.find(t => t.id === id)
}
</script>

<template>
  <!-- B站已装下载插件 → 展示扩展推送的下载链接 -->
  <div v-if="biliPluginMode" class="side-block">
    <div class="section-title">
      <span v-if="biliExtTitle">{{ biliExtTitle }}</span>
      <span v-else>B站下载助手</span>
    </div>
    <!-- 有扩展推送的下载链接 → 显示下载按钮列表 -->
    <div v-if="biliExtDownloads.length > 0" class="bili-ext-dl-list">
      <div
        v-for="(dl, idx) in biliExtDownloads"
        :key="idx"
        class="bili-ext-dl-item"
      >
        <div class="bili-ext-dl-info">
          <div class="bili-ext-dl-name" :title="dl.text">{{ dl.text }}</div>
          <div v-if="dl.sizeText" class="bili-ext-dl-size">{{ dl.sizeText }}</div>
          <!-- 卡片内嵌进度：点击下载后在本卡片上显示（不跳转右栏 Tab） -->
          <template v-if="taskOf(dl.taskId)">
            <div v-if="taskOf(dl.taskId)!.status === 'downloading'" class="card-progress">
              <div class="card-bar"><i :style="{ width: (taskOf(dl.taskId)!.progress || 0) + '%' }" /></div>
              <span class="card-pct">{{ taskOf(dl.taskId)!.progress || 0 }}%</span>
            </div>
            <div v-else-if="taskOf(dl.taskId)!.status === 'done'" class="card-done">已完成</div>
            <div v-else-if="taskOf(dl.taskId)!.status === 'error'" class="card-fail">下载失败</div>
          </template>
        </div>
        <button
          v-if="!taskOf(dl.taskId) || taskOf(dl.taskId)!.status === 'error' || taskOf(dl.taskId)!.status === 'cancelled'"
          class="bili-ext-dl-btn"
          :disabled="!isElectronShell"
          title="下载"
          @click="$emit('download-bili', dl)"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
        </button>
      </div>
    </div>
    <!-- 暂无下载链接 → 显示加载提示 -->
    <div v-else class="bili-ext-waiting">
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" class="bili-spinner">
        <path d="M21 12a9 9 0 1 1-6.219-8.56" />
      </svg>
      <p>正在检测视频下载链接…</p>
      <ul class="bili-plugin-steps">
        <li>打开一个 B站视频详情页</li>
        <li>播放视频，扩展会自动解析下载地址</li>
        <li>在此处点击按钮即可下载</li>
      </ul>
    </div>
  </div>
  <div v-else class="side-block">
    <!-- 从页面解析下载按钮（针对动态加载平台的回退方案） -->
    <div v-if="activePlatformId && ['bilibili','youtube','douyin','kuaishou','xiaohongshu'].includes(activePlatformId)" class="page-dl-section">
      <div class="section-title">页面解析下载</div>
      <button
        class="page-dl-btn"
        :disabled="!isElectronShell || !pageUrl"
        @click="$emit('page-download')"
        title="使用 yt-dlp 解析当前页面并下载视频"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="7 10 12 15 17 10" />
          <line x1="12" y1="15" x2="12" y2="3" />
        </svg>
        解析当前页面下载
      </button>
      <div class="page-dl-hint">当嗅探不到视频流时，使用此功能通过 yt-dlp 解析下载</div>
    </div>

    <!-- 抖音预装扩展（chrom-douyin）能力：分享链接解析下载（2026-09-02） -->
    <div v-if="activePlatformId === 'douyin'" class="page-dl-section dy-parse-section">
      <div class="section-title">抖音视频下载助手（预装扩展）</div>
      <input
        v-model="shareText"
        class="dy-parse-input"
        type="text"
        placeholder="粘贴分享文本或 v.douyin.com 链接"
        @keydown.enter="$emit('douyin-parse', shareText)"
      />
      <button
        class="page-dl-btn"
        :disabled="!isElectronShell || !shareText.trim()"
        @click="$emit('douyin-parse', shareText)"
        title="解析分享链接并下载无水印视频"
      >
        解析下载
      </button>
      <div v-if="douyinParseMsg" class="page-dl-hint" :class="{ 'dy-parse-err': !douyinParseMsg.ok }">{{ douyinParseMsg.message }}</div>
      <div v-else class="page-dl-hint">在抖音 App 分享→复制链接，粘贴到这里即可下载无水印完整视频（含声音）</div>
    </div>

    <div v-if="sniffedMedia.length > 0" class="sniff-list">
      <div
        v-for="m in sniffedMedia"
        :key="m.id"
        class="sniff-card"
      >
        <div class="sniff-type-ic" :class="m.type">
          <svg v-if="m.type === 'video'" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <polygon points="23 7 16 12 23 17 23 7" />
            <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
          </svg>
          <svg v-else-if="m.type === 'audio'" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M9 18V5l12-2v13" />
            <circle cx="6" cy="18" r="3" />
            <circle cx="18" cy="16" r="3" />
          </svg>
          <svg v-else width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
            <circle cx="8.5" cy="8.5" r="1.5" />
            <polyline points="21 15 16 10 5 21" />
          </svg>
        </div>
        <div class="sniff-info">
          <div class="sniff-name" :title="m.name">{{ m.name }}</div>
          <div class="sniff-meta">
            <span v-if="m.sizeText">{{ m.sizeText }}</span>
            <span v-if="m.audioUrl" class="sniff-audio-tag">含音频</span>
          </div>
          <!-- 卡片内嵌进度：点击下载后在本卡片上显示 -->
          <template v-if="taskOf(m.taskId)">
            <div v-if="taskOf(m.taskId)!.status === 'downloading'" class="card-progress">
              <div class="card-bar"><i :style="{ width: (taskOf(m.taskId)!.progress || 0) + '%' }" /></div>
              <span class="card-pct">{{ taskOf(m.taskId)!.progress || 0 }}%</span>
            </div>
            <div v-else-if="taskOf(m.taskId)!.status === 'done'" class="card-done">已完成</div>
            <div v-else-if="taskOf(m.taskId)!.status === 'error'" class="card-fail">下载失败</div>
          </template>
        </div>
        <button
          v-if="!taskOf(m.taskId) || taskOf(m.taskId)!.status === 'error' || taskOf(m.taskId)!.status === 'cancelled'"
          class="sniff-dl-btn"
          :disabled="!isElectronShell"
          title="下载"
          @click="$emit('download-media', m)"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
        </button>
      </div>
    </div>
    <div v-else class="rb-empty">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <circle cx="11" cy="11" r="8" />
        <line x1="21" y1="21" x2="16.65" y2="16.65" />
      </svg>
      <span>正在嗅探媒体资源…</span>
      <span class="rb-empty-sub">在页面上播放视频或音频以触发嗅探</span>
    </div>
  </div>
</template>

<style scoped>
/* ─── 通用侧栏块 ─── */
.section-title {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.08em;
  color: var(--muted-foreground);
  text-transform: uppercase;
  margin-bottom: var(--space-3);
}

.rb-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-6) 0;
  color: var(--muted-foreground);
  font-size: 12px;
}

.rb-empty-sub {
  font-size: 11px;
  opacity: 0.7;
}

/* ═══ Phase 2: 媒体嗅探卡片 ═══ */
.sniff-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.sniff-list .sniff-card:nth-child(odd) {
  background: var(--surface-container);
}

.sniff-list .sniff-card:nth-child(even) {
  background: var(--card);
}

.sniff-list .sniff-card:hover {
  background: rgba(99, 102, 241, 0.08);
  border-color: var(--primary);
  box-shadow: var(--shadow-1);
}

.sniff-card {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  transition: all var(--duration-fast);
}

.sniff-card:hover {
  border-color: var(--primary);
  box-shadow: var(--shadow-1);
  background: var(--surface-container);
}

.sniff-type-ic {
  width: 32px;
  height: 32px;
  border-radius: var(--radius-md);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  background: var(--surface-container);
  color: var(--muted-foreground);
}

.sniff-type-ic.video {
  background: rgba(99, 102, 241, 0.12);
  color: var(--primary);
}

.sniff-type-ic.audio {
  background: rgba(16, 185, 129, 0.12);
  color: var(--success);
}

.sniff-type-ic.image {
  background: rgba(245, 158, 11, 0.12);
  color: #f59e0b;
}

.sniff-info {
  flex: 1 1 auto;
  min-width: 0;
}

.sniff-name {
  font-size: 13px;
  font-weight: 500;
  color: var(--foreground);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.sniff-meta {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-top: 2px;
  font-size: 11px;
  color: var(--muted-foreground);
}

.sniff-audio-tag {
  padding: 1px 6px;
  border-radius: var(--radius-full);
  background: rgba(16, 185, 129, 0.12);
  color: var(--success);
  font-size: 10px;
  font-weight: 500;
}

.sniff-dl-btn {
  width: 28px;
  height: 28px;
  border-radius: var(--radius-md);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--primary);
  color: var(--primary-foreground);
  border: none;
  cursor: pointer;
  flex-shrink: 0;
  transition: all var(--duration-fast);
}

.sniff-dl-btn:hover:not(:disabled) {
  filter: brightness(1.08);
  transform: translateY(-1px);
}

.sniff-dl-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* ═══ 页面解析下载按钮 ═══ */
.page-dl-section {
  margin-bottom: 12px;
  padding: 10px;
  background: linear-gradient(135deg, rgba(139, 92, 246, 0.08) 0%, rgba(59, 130, 246, 0.08) 100%);
  border-radius: var(--radius-md);
  border: 1px solid rgba(139, 92, 246, 0.2);
}

.page-dl-section .section-title {
  font-size: 11px;
  font-weight: 600;
  color: var(--muted-foreground);
  margin-bottom: 8px;
  letter-spacing: 0.5px;
}

.page-dl-btn {
  width: 100%;
  height: 34px;
  border-radius: var(--radius-md);
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  background: linear-gradient(135deg, #8b5cf6 0%, #3b82f6 100%);
  color: white;
  border: none;
  cursor: pointer;
  font-size: 13px;
  font-weight: 500;
  transition: all var(--duration-fast);
}

.page-dl-btn:hover:not(:disabled) {
  filter: brightness(1.1);
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(139, 92, 246, 0.3);
}

.page-dl-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.page-dl-hint {
  font-size: 10px;
  color: var(--muted-foreground);
  margin-top: 6px;
  line-height: 1.4;
}

/* ─── 抖音分享链接解析下载（chrom-douyin 预装扩展能力） ─── */
.dy-parse-input {
  width: 100%;
  height: 30px;
  padding: 0 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--card);
  color: var(--foreground);
  font-size: 12px;
  outline: none;
  transition: border-color var(--duration-fast);
}
.dy-parse-input:focus {
  border-color: var(--primary);
}
.dy-parse-input + .page-dl-btn {
  margin-top: 6px;
}
.dy-parse-err {
  color: var(--destructive, #ef4444);
}

/* ─── 卡片内嵌下载进度 ─── */
.card-progress {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 5px;
}
.card-bar {
  flex: 1 1 auto;
  height: 4px;
  border-radius: 2px;
  background: var(--border);
  overflow: hidden;
}
.card-bar > i {
  display: block;
  height: 100%;
  border-radius: 2px;
  background: var(--primary);
  transition: width 0.25s ease;
}
.card-pct {
  flex-shrink: 0;
  font-size: 10px;
  color: var(--muted-foreground);
  font-variant-numeric: tabular-nums;
}
.card-done { margin-top: 5px; font-size: 11px; color: var(--success); }
.card-fail { margin-top: 5px; font-size: 11px; color: var(--destructive, #ef4444); }

/* ─── B站插件下载卡（装了插件时替代嗅探列表） ─── */
.bili-plugin-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px;
  border: 1px dashed var(--border);
  border-radius: var(--radius-md);
  background: var(--surface-container);
  color: var(--foreground);
  font-size: 13px;
  line-height: 1.6;
}
.bili-plugin-card > svg { color: #fb7299; }
.bili-plugin-card p { margin: 0; }
.bili-plugin-tip { color: var(--muted-foreground); font-size: 12px; }
.bili-plugin-steps { margin: 2px 0 0; padding-left: 18px; color: var(--muted-foreground); font-size: 12px; }

/* ─── B站扩展下载链接列表 ─── */
.bili-ext-dl-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.bili-ext-dl-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--surface-container);
  transition: border-color 0.15s ease, background 0.15s ease;
}
.bili-ext-dl-item:hover {
  border-color: #fb7299;
  background: var(--surface-container-hov, var(--surface-container));
}
.bili-ext-dl-info {
  flex: 1;
  min-width: 0;
  overflow: hidden;
}
.bili-ext-dl-name {
  font-size: 13px;
  font-weight: 500;
  color: var(--foreground);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.bili-ext-dl-size {
  font-size: 12px;
  color: var(--muted-foreground);
  margin-top: 2px;
}
.bili-ext-dl-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  flex-shrink: 0;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface);
  color: var(--foreground);
  cursor: pointer;
  transition: all 0.15s ease;
}
.bili-ext-dl-btn:hover:not(:disabled) {
  background: #fb7299;
  color: #fff;
  border-color: #fb7299;
}
.bili-ext-dl-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* ─── B站扩展等待状态 ─── */
.bili-ext-waiting {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 24px 16px;
  border: 1px dashed var(--border);
  border-radius: var(--radius-md);
  background: var(--surface-container);
  text-align: center;
}
.bili-ext-waiting svg {
  color: #fb7299;
  animation: bili-spin 2s linear infinite;
}
.bili-ext-waiting p {
  margin: 0;
  color: var(--foreground);
  font-size: 13px;
}
.bili-ext-waiting .bili-plugin-steps {
  margin-top: 8px;
  text-align: left;
}
@keyframes bili-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
</style>
