<script setup lang="ts">
// ═══════════════════════════════════════════════════════════════
// DailyAssetsView — B9 每日素材视图（日期分组 + 预览 + 筛选）
// 对照原版 apps/asset-browser/renderer/app.js：
//   · L2340-2436 renderDailyMaterials（日期头 + 文件卡网格 + 类型徽标 +
//     勾选 + 单击定位/双击打开）
//   · L2314-2338 _buildMaterialPreviewHtml（图片直出 / 视频封面角标）
// 业务状态在 composables/useBrowserDailyAssets.ts（IPC 转发 + 筛选编排），
// 纯函数在 logic/dailyAssets.ts；本组件只做绘制 + 事件转发。
// ═══════════════════════════════════════════════════════════════
import { computed, reactive, ref } from 'vue'
import { onMounted } from 'vue'
import { useBrowserDailyAssets } from '../composables/useBrowserDailyAssets'
import { useOfficeExport } from '@/composables/useOfficeExport'
import { dailyToSheet } from '@/composables/officeSheetLogic'
import { formatDate } from '@/composables/officeDocLogic'

const {
  loading, filteredGroups, dates, totalCount, selectedCount,
  filterDate, filterType, filterQuery, filterSort,
  loadDailyAssets, setDate, setType, setQuery, setSort,
  toggleSelect, clearSelection, revealFile, openFile,
  formatBytes, previewType, selectedPaths,
  importing, importPhase, importSelected,
} = useBrowserDailyAssets()

/* ── 办公能力导出（浏览器窗口经 tintinBrowser.office，PRD §3.2②）── */
const officeExport = useOfficeExport({ bridge: () => (window as any).tintinBrowser })
/** E6：导出中禁用 */
const exportBusy = computed(() => officeExport.state.value === 'exporting')
/** 导出反馈横幅（成功显示保存路径 + 截断提示） */
const exportPhase = computed(() => {
  const s = officeExport.state.value
  if (s === 'exporting') return '正在导出…'
  if (s === 'done') {
    const extra = officeExport.truncated.value ? '（部分内容超出上限，超出部分未导出）' : ''
    return `已保存：${officeExport.lastPath.value}${extra}`
  }
  return ''
})

/** 每日素材 → Excel（PRD §3.2②；E1 无素材禁用/提示） */
async function onExportDaily(): Promise<void> {
  if (exportBusy.value) return
  if (totalCount.value === 0) { window.alert?.('暂无内容可导出'); return }
  await officeExport.exportXlsx(dailyToSheet(filteredGroups.value), `每日素材_${formatDate(new Date())}.xlsx`)
}

/** 图片/封面加载失败集合（file:// 在 dev http 页面被 CORS 拦截时降级为图标） */
const imgFailed = reactive(new Set<string>())
function fileUrl(p: string): string {
  return 'file:///' + String(p).replace(/\\/g, '/')
}
function onImgError(p: string): void {
  if (!imgFailed.has(p)) imgFailed.add(p)
}

const empty = computed(() => !loading.value && filteredGroups.value.length === 0)
const isSelected = (p: string) => selectedPaths.value.has(p)

onMounted(() => { void loadDailyAssets() })
</script>

<template>
  <div class="daily-assets-view-area">
    <!-- 头部：标题 + 刷新 / 清除选择 -->
    <div class="daily-header">
      <div class="daily-title">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <rect x="3" y="4" width="18" height="18" rx="2" />
          <line x1="16" y1="2" x2="16" y2="6" />
          <line x1="8" y1="2" x2="8" y2="6" />
          <line x1="3" y1="10" x2="21" y2="10" />
        </svg>
        <span>每日素材</span>
        <span class="daily-count">{{ totalCount }}</span>
      </div>
      <div class="daily-actions">
        <button
          class="daily-btn"
          title="导出当前筛选结果为 Excel"
          :disabled="exportBusy || totalCount === 0"
          @click="onExportDaily"
        >{{ exportBusy ? '导出中…' : '导出 Excel' }}</button>
        <button
          v-if="selectedCount > 0"
          class="daily-btn"
          :disabled="importing"
          title="勾选条目提交到服务端素材库（异步下载入库）"
          @click="importSelected"
        >{{ importing ? '入库中…' : `入库所选(${selectedCount})` }}</button>
        <button
          v-if="selectedCount > 0"
          class="daily-btn"
          title="清除勾选"
          @click="clearSelection"
        >清除选择({{ selectedCount }})</button>
        <button class="daily-btn" :disabled="loading" @click="loadDailyAssets">
          {{ loading ? '扫描中…' : '刷新' }}
        </button>
      </div>
    </div>

    <!-- 导出反馈横幅（成功显示保存路径，PRD §3.4） -->
    <div v-if="exportPhase" class="daily-import-progress" :class="{ done: officeExport.state.value === 'done' }">{{ exportPhase }}</div>

    <!-- B8 入库进度/结果反馈 -->
    <div v-if="importPhase" class="daily-import-progress" :class="{ done: !importing }">{{ importPhase }}</div>

    <!-- 筛选栏：日期 / 类型 / 搜索 / 排序（对照原版四个筛选器） -->
    <div class="daily-filters">
      <select class="daily-select" v-model="filterDate" @change="setDate(filterDate)">
        <option value="all">全部日期</option>
        <option v-for="d in dates" :key="d" :value="d">{{ d }}</option>
      </select>
      <select class="daily-select" v-model="filterType" @change="setType(filterType)">
        <option value="all">全部类型</option>
        <option value="video">视频</option>
        <option value="image">图片</option>
        <option value="text">图文</option>
        <option value="file">文件</option>
      </select>
      <input
        v-model="filterQuery"
        class="daily-search"
        type="search"
        placeholder="搜索文件名 / 路径"
        @input="setQuery(filterQuery)"
      >
      <select class="daily-select" v-model="filterSort" @change="setSort(filterSort)">
        <option value="date_desc">日期↓</option>
        <option value="date_asc">日期↑</option>
        <option value="size_desc">大小↓</option>
        <option value="size_asc">大小↑</option>
        <option value="name_desc">名称↓</option>
        <option value="name_asc">名称↑</option>
        <option value="type_asc">类型</option>
      </select>
    </div>

    <!-- 日期分组素材网格 -->
    <div class="daily-list">
      <div v-for="group in filteredGroups" :key="group.date" class="materials-group">
        <div class="materials-date-header">
          <span>{{ group.date }}</span>
          <span class="materials-group-count">{{ group.files.length }} 个文件</span>
        </div>
        <div class="materials-grid">
          <div
            v-for="file in group.files"
            :key="file.path"
            class="material-file-card"
            :class="{ selected: isSelected(file.path) }"
            :title="`单击定位文件\n双击打开文件：${file.name}`"
            @click="revealFile(file.path)"
            @dblclick="openFile(file.path)"
          >
            <span class="material-badge" :class="file.type">{{ file.type === 'video' ? '视频' : file.type === 'image' ? '图片' : file.type === 'text' ? '图文' : '文件' }}</span>
            <label class="material-select-wrap" title="勾选用于批量操作" @click.stop>
              <input
                type="checkbox"
                :checked="isSelected(file.path)"
                @change="toggleSelect(file.path)"
              >
            </label>
            <div class="material-preview-box">
              <!-- 图片 / 视频封面（file:// 加载失败自动降级为图标） -->
              <img
                v-if="(previewType(file, group.files) === 'image' || previewType(file, group.files) === 'video-cover') && !imgFailed.has(file.path)"
                :src="fileUrl(file.path)"
                :alt="file.name"
                loading="lazy"
                @error="onImgError(file.path)"
              >
              <template v-else-if="previewType(file, group.files) === 'video-cover' || previewType(file, group.files) === 'video'">
                <svg class="preview-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <polygon points="23 7 16 12 23 17 23 7" />
                  <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
                </svg>
                <div class="video-play-overlay">
                  <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3" /></svg>
                </div>
              </template>
              <template v-else-if="previewType(file, group.files) === 'text'">
                <svg class="preview-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                  <line x1="16" y1="13" x2="8" y2="13" />
                  <line x1="16" y1="17" x2="8" y2="17" />
                </svg>
              </template>
              <template v-else>
                <svg class="preview-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
                  <polyline points="13 2 13 9 20 9" />
                </svg>
              </template>
            </div>
            <div class="material-info-box">
              <div class="material-name" :title="file.name">{{ file.name }}</div>
              <div class="material-size">{{ formatBytes(file.size) }}</div>
            </div>
          </div>
        </div>
      </div>
      <div v-if="empty" class="empty-state">
        <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1">
          <rect x="3" y="4" width="18" height="18" rx="2" />
          <line x1="16" y1="2" x2="16" y2="6" />
          <line x1="8" y1="2" x2="8" y2="6" />
        </svg>
        <div class="empty-title">暂无符合筛选条件的素材</div>
        <div class="empty-sub">素材将按「YYYY-MM-DD」日期目录组织；下载任务默认落在媒体下载目录的日期子目录中</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.daily-assets-view-area {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--background);
}

/* 头部 */
.daily-header {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--space-4) var(--space-5);
  border-bottom: 1px solid var(--border);
  background: var(--surface);
}
.daily-title {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: 15px;
  font-weight: 600;
  color: var(--foreground);
}
.daily-title svg { color: var(--primary); }
.daily-count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 20px;
  height: 20px;
  padding: 0 6px;
  background: var(--primary);
  color: var(--primary-foreground);
  font-size: 11px;
  font-weight: 600;
  border-radius: 999px;
}
.daily-actions { display: flex; gap: 8px; }
/* B8 入库进度/结果提示条 */
.daily-import-progress {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 10px var(--space-5) 0;
  padding: 8px 12px;
  border-radius: var(--radius-md);
  background: rgba(99, 102, 241, 0.08);
  border: 1px solid var(--primary);
  color: var(--primary);
  font-size: 12px;
}
.daily-import-progress.done { background: rgba(34, 197, 94, 0.08); border-color: var(--success); color: var(--success); }
.daily-btn {
  padding: 4px 12px;
  border-radius: var(--radius-md);
  background: var(--surface-container);
  border: 1px solid var(--border);
  color: var(--foreground);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  font-family: inherit;
}
.daily-btn:hover { border-color: var(--primary); color: var(--primary); }
.daily-btn:disabled { opacity: 0.5; cursor: default; }

/* 筛选栏 */
.daily-filters {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px var(--space-5);
  border-bottom: 1px solid var(--border);
  background: var(--surface);
  flex-wrap: wrap;
}
.daily-select {
  padding: 5px 8px;
  border-radius: var(--radius-md);
  background: var(--surface-container);
  border: 1px solid var(--border);
  color: var(--foreground);
  font-size: 12px;
  font-family: inherit;
}
.daily-search {
  flex: 1 1 160px;
  min-width: 120px;
  padding: 5px 10px;
  border-radius: var(--radius-md);
  background: var(--surface-container);
  border: 1px solid var(--border);
  color: var(--foreground);
  font-size: 12px;
  font-family: inherit;
}

/* 日期分组列表 */
.daily-list {
  flex: 1 1 auto;
  overflow-y: auto;
  padding: var(--space-4) var(--space-5);
}
.materials-group { margin-bottom: var(--space-4); }
.materials-date-header {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: 13px;
  font-weight: 600;
  color: var(--foreground);
  padding: 6px 2px;
}
.materials-group-count {
  font-size: 11px;
  font-weight: 500;
  color: var(--muted-foreground);
}
.materials-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: var(--space-3);
}

/* 文件卡（对照原版 .material-file-card） */
.material-file-card {
  position: relative;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  overflow: hidden;
  cursor: pointer;
  transition: all var(--duration-fast);
  padding-bottom: 8px;
}
.material-file-card:hover {
  border-color: var(--primary);
  box-shadow: 0 0 0 1px var(--ring);
}
.material-file-card.selected {
  border-color: var(--primary);
  box-shadow: 0 0 0 1px var(--ring);
  background: rgba(99, 102, 241, 0.06);
}
.material-badge {
  position: absolute;
  top: 6px;
  left: 6px;
  z-index: 2;
  padding: 1px 7px;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 600;
  color: #fff;
  background: var(--muted-foreground);
}
.material-badge.video { background: #ef4444; }
.material-badge.image { background: #3b82f6; }
.material-badge.text { background: #22c55e; }
.material-badge.file { background: #64748b; }
.material-select-wrap {
  position: absolute;
  top: 4px;
  right: 4px;
  z-index: 2;
  width: 20px;
  height: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(255, 255, 255, 0.85);
  border-radius: 4px;
}
:root.dark .material-select-wrap,
.dark .material-select-wrap { background: rgba(30, 30, 46, 0.85); }
.material-select-wrap input { cursor: pointer; }
.material-preview-box {
  width: 100%;
  aspect-ratio: 16 / 10;
  background: var(--surface-container);
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
  color: var(--muted-foreground);
  overflow: hidden;
}
.material-preview-box img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.preview-icon { width: 36px; height: 36px; }
.video-play-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: rgba(255, 255, 255, 0.92);
  background: rgba(0, 0, 0, 0.18);
}
.material-info-box { padding: 6px 8px 0; }
.material-name {
  font-size: 12px;
  font-weight: 500;
  color: var(--foreground);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.material-size {
  margin-top: 2px;
  font-size: 11px;
  color: var(--muted-foreground);
}

/* 空状态 */
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-3);
  padding: 80px 20px;
  color: var(--muted-foreground);
  text-align: center;
}
.empty-state svg { opacity: 0.4; }
.empty-title { font-size: 15px; font-weight: 500; color: var(--foreground); }
.empty-sub { font-size: 12px; max-width: 320px; line-height: 1.6; }

.daily-list::-webkit-scrollbar { width: 6px; }
.daily-list::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
.daily-list::-webkit-scrollbar-track { background: transparent; }
</style>
