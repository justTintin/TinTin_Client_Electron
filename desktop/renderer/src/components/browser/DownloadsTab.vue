<script setup lang="ts">
// DownloadsTab — 右栏「下载管理」Tab 展示组件（纯展示，无业务逻辑）
// 来源：views/Browser.vue 原 template（增强下载任务卡片 / 兼容旧
// will-download 卡片两区段）+ 对应 style，因 BrowserRightPanel 超 800 行
// 红线按「容器 + 展示组件」原样搬移至此——DOM 结构与类名不变，逻辑零改动。
import type {
  DownloadItem,
  MediaDownloadTask,
} from '../../composables/useBrowserDownloads'

defineProps<{
  /** 增强下载任务卡片 */
  mediaDownloadTasks: MediaDownloadTask[]
  /** 兼容旧 will-download 的下载卡片 */
  downloads: DownloadItem[]
  /** 速度格式化（downloads 域 _formatSpeed） */
  formatSpeed: (bps: number) => string
  /** 状态文案（downloads 域 dlStatusText） */
  dlStatusText: (d: DownloadItem) => string
}>()

defineEmits<{
  (e: 'pause-task', t: MediaDownloadTask): void
  (e: 'cancel-task', t: MediaDownloadTask): void
  (e: 'remove-task', t: MediaDownloadTask): void
}>()
</script>

<template>
  <!-- Phase 2-2: 增强下载任务卡片 -->
  <div v-if="mediaDownloadTasks.length > 0" class="side-block">
    <div
      v-for="t in mediaDownloadTasks"
      :key="t.id"
      class="dl-card enhanced"
      :class="{ paused: t.paused, done: t.status === 'done', cancelled: t.status === 'cancelled', error: t.status === 'error' }"
    >
      <div class="dl-card-header">
        <div class="dl-name" :title="t.title">{{ t.title }}</div>
        <div class="dl-actions">
          <button
            v-if="t.status !== 'done' && t.status !== 'cancelled' && t.status !== 'error'"
            class="dl-action-btn"
            :title="t.paused ? '继续' : '暂停'"
            @click="$emit('pause-task', t)"
          >
            <svg v-if="!t.paused" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="6" y="4" width="4" height="16" />
              <rect x="14" y="4" width="4" height="16" />
            </svg>
            <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polygon points="5 3 19 12 5 21 5 3" />
            </svg>
          </button>
          <button
            v-if="t.status !== 'done' && t.status !== 'cancelled'"
            class="dl-action-btn"
            title="取消"
            @click="$emit('cancel-task', t)"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
          <button
            v-if="t.status === 'done' || t.status === 'cancelled' || t.status === 'error'"
            class="dl-action-btn"
            title="移除"
            @click="$emit('remove-task', t)"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
            </svg>
          </button>
        </div>
      </div>
      <div class="dl-bar">
        <div
          class="dl-fill"
          :class="{
            done: t.status === 'done',
            queued: t.status === 'queued',
            paused: t.paused,
            cancelled: t.status === 'cancelled',
            error: t.status === 'error',
          }"
          :style="{ width: t.progress + '%' }"
        />
      </div>
      <div class="dl-foot">
        <span class="dl-progress-text">{{ t.status === 'done' ? '100%' : t.progress + '%' }}</span>
        <span class="dl-speed" v-if="t.speed > 0">{{ formatSpeed(t.speed) }}</span>
        <span
          class="dl-status"
          :class="{ 'dl-done': t.status === 'done', 'dl-paused': t.paused, 'dl-cancelled': t.status === 'cancelled', 'dl-error': t.status === 'error' }"
        >
          {{ t.status === 'done' ? '已完成' : t.paused ? '已暂停' : t.status === 'cancelled' ? '已取消' : t.status === 'error' ? '错误' : '下载中' }}
        </span>
      </div>
    </div>
  </div>
  <!-- 兼容旧 will-download 事件（非媒体嗅探来源） -->
  <div v-if="mediaDownloadTasks.length === 0 && downloads.length > 0" class="side-block">
    <div v-for="d in downloads" :key="d.id" class="dl-card">
      <div class="dl-name" :title="d.title">{{ d.title }}</div>
      <div class="dl-bar">
        <div class="dl-fill" :class="d.status" :style="{ width: d.progress + '%' }" />
      </div>
      <div class="dl-foot">
        <span>{{ d.status === 'done' ? '100%' : d.progress + '%' }}</span>
        <span :class="{ 'dl-done': d.status === 'done' }">{{ dlStatusText(d) }}</span>
      </div>
    </div>
  </div>
  <div v-if="mediaDownloadTasks.length === 0 && downloads.length === 0" class="rb-empty">
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
    <span>暂无下载任务</span>
  </div>
</template>

<style scoped>
/* ─── 相邻侧栏块间距（本 Tab 内多块并存的间隔规则，随 DOM 归位） ─── */
.side-block + .side-block {
  margin-top: var(--space-5);
}

/* ─── 下载管理：通用卡片 ─── */
.dl-card {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  padding: 8px 10px;
  margin-bottom: 6px;
  box-shadow: none;
}

.dl-card.enhanced {
  padding: 8px 10px;
}

.dl-name {
  font-size: 14px;
  color: var(--foreground);
  margin-bottom: var(--space-2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.dl-bar {
  height: 6px;
  background: var(--surface-container);
  border-radius: var(--radius-full);
  overflow: hidden;
  margin-bottom: var(--space-2);
}

.dl-fill {
  height: 100%;
  background: var(--primary);
  border-radius: var(--radius-full);
  transition: width 0.3s ease;
}

.dl-fill.done {
  background: var(--success);
}

.dl-fill.queued {
  background: var(--surface-container-high);
}

.dl-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 11px;
  color: var(--muted-foreground);
}

.dl-done { color: var(--success); }

.rb-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-6) 0;
  color: var(--muted-foreground);
  font-size: 12px;
}

/* ═══ Phase 2: 增强下载卡片 ═══ */

.side-block .dl-card:nth-child(odd) {
  background: var(--surface-container);
}

.side-block .dl-card:nth-child(even) {
  background: var(--card);
}

.dl-card.enhanced.done {
  opacity: 0.85;
}

.dl-card.enhanced.paused {
  border-color: var(--warning, #f59e0b);
}

.dl-card.enhanced.cancelled,
.dl-card.enhanced.error {
  opacity: 0.6;
}

.dl-card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  margin-bottom: var(--space-2);
}

.dl-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

.dl-action-btn {
  width: 24px;
  height: 24px;
  border-radius: var(--radius-md);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--surface-container);
  color: var(--muted-foreground);
  border: none;
  cursor: pointer;
  transition: all var(--duration-fast);
}

.dl-action-btn:hover {
  background: var(--surface-container-high);
  color: var(--foreground);
}

.dl-progress-text {
  font-variant-numeric: tabular-nums;
  font-weight: 500;
}

.dl-speed {
  font-variant-numeric: tabular-nums;
  color: var(--primary);
  font-weight: 500;
}

.dl-status {
  font-size: 11px;
}

.dl-status.dl-done {
  color: var(--success);
}

.dl-status.dl-paused {
  color: var(--warning, #f59e0b);
}

.dl-status.dl-cancelled {
  color: var(--muted-foreground);
}

.dl-status.dl-error {
  color: var(--error);
}

.dl-fill.paused {
  background: var(--warning, #f59e0b);
}

.dl-fill.cancelled {
  background: var(--muted-foreground);
}

.dl-fill.error {
  background: var(--error);
}

@media (prefers-reduced-motion: reduce) {
  .dl-fill { transition: none; }
}
</style>
