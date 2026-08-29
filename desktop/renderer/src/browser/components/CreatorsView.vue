<script setup lang="ts">
// ═══════════════════════════════════════════════════════════════
// CreatorsView — B10 达人/创作者库视图（达人列表 + 采集清单双 Tab）
// 对照原版 apps/asset-browser/renderer/app.js：
//   · L1258-1312 collectAllFromCreator（选定达人 → 进主页 → 自动滚动采集）
//   · creators DB 增删（main.js L543-564）
// 业务状态在 composables/useBrowserCreators.ts（IPC 转发 + 采集编排），
// 纯函数在 logic/creators.ts；本组件只做绘制 + 事件转发。
// 「打开主页」emit 容器（Browser.vue 切浏览器模式 + navigate）。
// ═══════════════════════════════════════════════════════════════
import { computed, onMounted, ref, watch } from 'vue'
import { useBrowserCreators } from '../composables/useBrowserCreators'
import { importStatusMeta } from '../logic/creators'
import type { CollectedItem, CreatorItem } from '../logic/creators'
import { useOfficeExport } from '@/composables/useOfficeExport'
import { creatorsToSheet, importsToSheet } from '@/composables/officeSheetLogic'
import { formatDate } from '@/composables/officeDocLogic'

const emit = defineEmits<{
  (e: 'open-homepage', creator: CreatorItem): void
}>()

// B7：侧栏「素材采集」入口 → collectMode=true 时默认/强制展示「采集清单」Tab
//（入库复用 B10 collected.json + material:import；素材采集与达人库共用本视图）
const props = withDefaults(
  defineProps<{
    collectMode?: boolean
  }>(),
  { collectMode: false }
)

const {
  creators, collected, loading, collecting, collectPhase, query, groupMode,
  filteredCreators, collectedGroups,
  loadCreators, loadCollected, addCreator, deleteCreator,
  collectFromCreator, platformName,
  importing, importPhase, collectedSelected, collectedSelectedCount,
  toggleCollectedSelect, clearCollectedSelection,
  importOne, importSelected,
} = useBrowserCreators({ onOpenHomepage: (c) => emit('open-homepage', c) })

const activeTab = ref<'creators' | 'collected'>('creators')

// B7：collectMode 变化 → 同步 Tab（素材采集入口固定展示采集清单；达人库入口回达人列表）
watch(
  () => props.collectMode,
  (collect) => {
    activeTab.value = collect ? 'collected' : 'creators'
  },
  { immediate: true }
)

function onImportOne(it: CollectedItem): void {
  void importOne(it)
}
function onImportSelected(): void {
  void importSelected()
}
function statusMeta(it: CollectedItem): { text: string; cls: string } {
  return importStatusMeta(it.importStatus)
}

// 新增表单
const formName = ref('')
const formPlatform = ref('douyin')
const formHomepage = ref('')
const formError = ref('')
const PLATFORM_OPTIONS = [
  { value: 'douyin', label: '抖音' },
  { value: 'bilibili', label: 'B站' },
  { value: 'kuaishou', label: '快手' },
  { value: 'xiaohongshu', label: '小红书' },
  { value: 'weixin', label: '视频号' },
  { value: 'youtube', label: 'YouTube' },
  { value: 'jimeng', label: '即梦AI' },
]

function submitAdd(): void {
  const name = formName.value.trim()
  if (!name) {
    formError.value = '请填写达人名称'
    return
  }
  // id = 主页 URL 末段或名称（对照原版 id+platform 唯一键）
  const url = formHomepage.value.trim()
  const id = url ? String(url.replace(/\/+$/, '').split('/').pop() || name) : name
  const ok = addCreator({ id, platform: formPlatform.value, name, homepageUrl: url })
  if (!ok) {
    formError.value = '新增失败（重复或参数不完整）'
    return
  }
  formError.value = ''
  formName.value = ''
  formHomepage.value = ''
}

function onCollect(creator: CreatorItem): void {
  activeTab.value = 'creators'
  void collectFromCreator(creator)
}

/* ── 办公能力导出（浏览器窗口经 tintinBrowser.office，PRD §3.2①/③）── */
const officeExport = useOfficeExport({ bridge: () => (window as any).tintinBrowser })
/** E6：导出中禁用（两处导出共用） */
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

/** ① 达人采集清单 → Excel（PRD §3.2①；E1 空清单禁用/提示） */
async function onExportCollected(): Promise<void> {
  if (exportBusy.value) return
  if (collected.value.length === 0) { window.alert?.('暂无内容可导出'); return }
  await officeExport.exportXlsx(
    creatorsToSheet(collected.value),
    `达人采集清单_${formatDate(new Date())}.xlsx`,
  )
}

/** ③ 素材采集·入库清单 → Excel（PRD §3.2③，数据源 materialImport.listTasks） */
async function onExportImports(): Promise<void> {
  if (exportBusy.value) return
  const t = (window as any).tintinBrowser
  if (!t?.materialImport?.listTasks) { window.alert?.('入库清单数据源不可用'); return }
  let tasks: Array<Record<string, any>> = []
  try {
    const res = await t.materialImport.listTasks()
    if (res?.success && Array.isArray(res.data)) tasks = res.data
  } catch (_) { /* 读取失败按空处理 */ }
  if (tasks.length === 0) { window.alert?.('暂无内容可导出'); return }
  await officeExport.exportXlsx(importsToSheet(tasks), `入库清单_${formatDate(new Date())}.xlsx`)
}

onMounted(() => {
  void loadCreators()
  void loadCollected()
})
</script>

<template>
  <div class="creators-view-area">
    <!-- 双 Tab 头部 -->
    <div class="creators-header">
      <div class="creators-tabs">
        <button class="creators-tab" :class="{ active: activeTab === 'creators' }" @click="activeTab = 'creators'">
          达人库 <span class="creators-count">{{ creators.length }}</span>
        </button>
        <button class="creators-tab" :class="{ active: activeTab === 'collected' }" @click="activeTab = 'collected'">
          采集清单 <span class="creators-count">{{ collected.length }}</span>
        </button>
      </div>
      <div class="creators-actions">
        <button
          class="creators-btn"
          title="导出当前采集清单为 Excel"
          :disabled="loading || exportBusy || collected.length === 0"
          @click="onExportCollected"
        >{{ exportBusy ? '导出中…' : '导出 Excel' }}</button>
        <button class="creators-btn" :disabled="loading" @click="loadCreators">{{ loading ? '加载中…' : '刷新' }}</button>
      </div>
    </div>

    <!-- 导出反馈横幅（成功显示保存路径，PRD §3.4） -->
    <div v-if="exportPhase" class="creators-progress" :class="{ done: officeExport.state.value === 'done' }">{{ exportPhase }}</div>

    <!-- Tab1：达人列表 -->
    <div v-if="activeTab === 'creators'" class="creators-body">
      <!-- 新增表单 -->
      <div class="creators-add-form">
        <input
          v-model="formName"
          class="creators-input form-name"
          type="text"
          placeholder="达人名称（必填）"
          @keyup.enter="submitAdd"
        >
        <select v-model="formPlatform" class="creators-select">
          <option v-for="p in PLATFORM_OPTIONS" :key="p.value" :value="p.value">{{ p.label }}</option>
        </select>
        <input
          v-model="formHomepage"
          class="creators-input form-url"
          type="text"
          placeholder="主页 URL（可选，留空则按平台搜索推导）"
          @keyup.enter="submitAdd"
        >
        <button class="creators-btn primary" @click="submitAdd">添加达人</button>
      </div>
      <div v-if="formError" class="creators-error">{{ formError }}</div>

      <!-- 搜索 -->
      <div class="creators-toolbar">
        <input
          v-model="query"
          class="creators-input form-name"
          type="search"
          placeholder="搜索达人（名称 / 平台 / 主页）"
        >
      </div>

      <!-- 采集进度 -->
      <div v-if="collecting" class="creators-progress">
        <span class="creators-spinner"></span>
        <span>{{ collectPhase || '采集中…' }}</span>
      </div>
      <div v-else-if="collectPhase" class="creators-progress done">{{ collectPhase }}</div>

      <!-- 达人卡片 -->
      <div v-if="filteredCreators.length > 0" class="creators-list">
        <div v-for="c in filteredCreators" :key="c.platform + '|' + c.id" class="creator-card">
          <div class="creator-avatar" :class="c.platform">{{ platformName(c.platform).slice(0, 1) }}</div>
          <div class="creator-info">
            <div class="creator-name" :title="c.name">{{ c.name }}</div>
            <div class="creator-meta">
              <span class="creator-platform">{{ platformName(c.platform) }}</span>
              <span class="creator-url" :title="c.homepageUrl">{{ c.homepageUrl || '主页由平台搜索推导' }}</span>
            </div>
          </div>
          <div class="creator-ops">
            <button class="creators-btn primary" title="进入达人主页自动滚动采集全部内容" @click="onCollect(c)">采集</button>
            <button class="creators-btn" title="打开达人主页" @click="emit('open-homepage', c)">打开主页</button>
            <button class="creators-btn danger" title="删除该达人" @click="deleteCreator(c.id, c.platform)">删除</button>
          </div>
        </div>
      </div>
      <div v-else class="creators-empty">
        <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1">
          <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
          <circle cx="9" cy="7" r="4" />
          <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
          <path d="M16 3.13a4 4 0 0 1 0 7.75" />
        </svg>
        <div class="creators-empty-title">暂无达人</div>
        <div class="creators-empty-sub">添加达人后点「采集」自动滚动加载其主页全部内容；「打开主页」在浏览器中浏览</div>
      </div>
    </div>

    <!-- Tab2：采集清单 -->
    <div v-else class="creators-body">
      <div class="creators-toolbar">
        <div class="collected-mode">
          <button class="creators-btn" :class="{ active: groupMode === 'date' }" @click="groupMode = 'date'">按日期</button>
          <button class="creators-btn" :class="{ active: groupMode === 'creator' }" @click="groupMode = 'creator'">按达人</button>
        </div>
        <div class="collected-ops">
          <button
            class="creators-btn"
            title="导出素材采集入库清单（import-tasks.json 记录）为 Excel"
            :disabled="exportBusy"
            @click="onExportImports"
          >{{ exportBusy ? '导出中…' : '导出入库清单' }}</button>
          <button
            v-if="collectedSelectedCount > 0"
            class="creators-btn primary"
            :disabled="importing"
            @click="onImportSelected"
          >{{ importing ? '入库中…' : `入库所选(${collectedSelectedCount})` }}</button>
          <button v-if="collectedSelectedCount > 0" class="creators-btn" :disabled="importing" @click="clearCollectedSelection">取消勾选</button>
          <button class="creators-btn" @click="loadCollected">刷新</button>
        </div>
      </div>
      <!-- B8 入库进度/结果反馈 -->
      <div v-if="importPhase" class="creators-progress" :class="{ done: !importing }">{{ importPhase }}</div>
      <div class="collected-list">
        <div v-for="g in collectedGroups" :key="g.key" class="collected-group">
          <div class="collected-group-header">
            <span>{{ g.key }}</span>
            <span class="collected-group-count">{{ g.items.length }} 条</span>
          </div>
          <div class="collected-items">
            <div
              v-for="(it, i) in g.items"
              :key="it.url + i"
              class="collected-item"
              :class="{ selected: collectedSelected.has(it.url) }"
              :title="it.url"
            >
              <label class="collected-check" title="勾选用于批量入库" @click.stop>
                <input
                  type="checkbox"
                  :checked="collectedSelected.has(it.url)"
                  :disabled="importing"
                  @change="toggleCollectedSelect(it.url)"
                >
              </label>
              <span class="collected-platform" :class="it.platform">{{ platformName(it.platform) }}</span>
              <span class="collected-title">{{ it.title }}</span>
              <span class="collected-by">@{{ it.creatorName }}</span>
              <span
                v-if="statusMeta(it).text"
                class="collected-import-badge"
                :class="statusMeta(it).cls"
                :title="it.importError || (it.importTaskId ? `任务 ${it.importTaskId}` : '')"
              >{{ statusMeta(it).text }}</span>
              <button
                class="collected-import-btn"
                :disabled="importing"
                :title="it.importStatus === 'submitted' || it.importStatus === 'imported'
                  ? '已提交入库，可在导入任务中查看进度'
                  : '提交该素材到服务端素材库（异步下载）'"
                @click="onImportOne(it)"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="7 10 12 15 17 10" />
                  <line x1="12" y1="15" x2="12" y2="3" />
                </svg>
              </button>
            </div>
          </div>
        </div>
        <div v-if="collectedGroups.length === 0" class="creators-empty">
          <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
          </svg>
          <div class="creators-empty-title">暂无采集记录</div>
          <div class="creators-empty-sub">达人主页采集的内容链接将先落本地采集清单，勾选或点行级「入库」即可提交到服务端素材库（异步下载）</div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.creators-view-area {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--background);
}

/* 头部 + Tab */
.creators-header {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--space-3) var(--space-5);
  border-bottom: 1px solid var(--border);
  background: var(--surface);
}
.creators-tabs { display: flex; gap: 6px; }
.creators-tab {
  padding: 6px 14px;
  border-radius: var(--radius-md);
  background: transparent;
  border: 1px solid transparent;
  color: var(--muted-foreground);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  font-family: inherit;
}
.creators-tab.active {
  background: var(--luosiding-indigo-50, #e0e7ff);
  border-color: var(--primary);
  color: var(--primary);
}
:root.dark .creators-tab.active,
.dark .creators-tab.active { background: rgba(99, 102, 241, 0.16); }
.creators-count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  border-radius: 999px;
  background: var(--surface-container-high);
  font-size: 10px;
  font-weight: 600;
  margin-left: 4px;
}

.creators-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: var(--space-4) var(--space-5);
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

/* 按钮/输入 */
.creators-btn {
  padding: 5px 12px;
  border-radius: var(--radius-md);
  background: var(--surface-container);
  border: 1px solid var(--border);
  color: var(--foreground);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  font-family: inherit;
}
.creators-btn:hover { border-color: var(--primary); color: var(--primary); }
.creators-btn.primary { background: var(--primary); border-color: var(--primary); color: var(--primary-foreground); }
.creators-btn.primary:hover { opacity: 0.88; }
.creators-btn.danger:hover { border-color: var(--error); color: var(--error); }
.creators-btn:disabled { opacity: 0.5; cursor: default; }
.creators-btn.active { border-color: var(--primary); color: var(--primary); }

.creators-input {
  padding: 5px 10px;
  border-radius: var(--radius-md);
  background: var(--surface-container);
  border: 1px solid var(--border);
  color: var(--foreground);
  font-size: 12px;
  font-family: inherit;
}
.creators-select {
  padding: 5px 8px;
  border-radius: var(--radius-md);
  background: var(--surface-container);
  border: 1px solid var(--border);
  color: var(--foreground);
  font-size: 12px;
  font-family: inherit;
}

/* 新增表单 */
.creators-add-form {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.form-name { flex: 1 1 140px; }
.form-url { flex: 2 1 220px; }
.creators-error { color: var(--error); font-size: 12px; }

.creators-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.collected-mode { display: flex; gap: 6px; }
.collected-ops { display: flex; gap: 6px; }

/* 采集清单条目（B8 入库：勾选 + 状态徽标 + 行级入库按钮） */
.collected-item.selected { border-color: var(--primary); background: rgba(99, 102, 241, 0.06); }
.collected-check {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  cursor: pointer;
}
.collected-check input { cursor: pointer; }
.collected-import-btn {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: var(--radius-md);
  background: var(--surface-container);
  border: 1px solid var(--border);
  color: var(--muted-foreground);
  cursor: pointer;
  font-family: inherit;
}
.collected-import-btn:hover:not(:disabled) { border-color: var(--primary); color: var(--primary); }
.collected-import-btn:disabled { opacity: 0.5; cursor: default; }
.collected-import-badge {
  flex: 0 0 auto;
  padding: 1px 7px;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 600;
  color: #fff;
  background: var(--muted-foreground);
}
.collected-import-badge.pending { background: #f59e0b; }
.collected-import-badge.done { background: #22c55e; }
.collected-import-badge.fail { background: #ef4444; }

/* 采集进度 */
.creators-progress {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-radius: var(--radius-md);
  background: rgba(99, 102, 241, 0.08);
  border: 1px solid var(--primary);
  color: var(--primary);
  font-size: 12px;
}
.creators-progress.done { background: rgba(34, 197, 94, 0.08); border-color: var(--success); color: var(--success); }
.creators-spinner {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  border: 2px solid var(--primary);
  border-top-color: transparent;
  animation: creators-spin 0.8s linear infinite;
}
@keyframes creators-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) {
  .creators-spinner { animation: none; }
}

/* 达人卡片 */
.creators-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}
.creator-card {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
}
.creator-card:hover { border-color: var(--primary); box-shadow: 0 0 0 1px var(--ring); }
.creator-avatar {
  flex: 0 0 auto;
  width: 38px;
  height: 38px;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  font-size: 14px;
  font-weight: 700;
  background: #64748b;
}
.creator-avatar.douyin { background: #FE2C55; }
.creator-avatar.bilibili { background: #00AEEC; }
.creator-avatar.kuaishou { background: #FF6600; }
.creator-avatar.xiaohongshu { background: #FF2442; }
.creator-avatar.weixin { background: #07C160; }
.creator-avatar.youtube { background: #FF0000; }
.creator-avatar.jimeng { background: #7C3AED; }
.creator-info {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.creator-name {
  font-size: 14px;
  font-weight: 500;
  color: var(--foreground);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.creator-meta { display: flex; align-items: center; gap: 8px; }
.creator-platform {
  font-size: 11px;
  padding: 1px 7px;
  border-radius: 999px;
  background: var(--surface-container-high);
  color: var(--muted-foreground);
}
.creator-url {
  font-size: 11px;
  color: var(--muted-foreground);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 260px;
}
.creator-ops { display: flex; gap: 6px; flex: 0 0 auto; }

/* 采集清单 */
.collected-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}
.collected-group { margin-bottom: var(--space-2); }
.collected-group-header {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  font-weight: 600;
  color: var(--foreground);
  padding: 4px 2px;
}
.collected-group-count {
  font-size: 11px;
  font-weight: 500;
  color: var(--muted-foreground);
}
.collected-items {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.collected-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-radius: var(--radius-md);
  background: var(--surface);
  border: 1px solid var(--border);
  font-size: 12px;
  cursor: default;
}
.collected-item:hover { border-color: var(--primary); }
.collected-platform {
  flex: 0 0 auto;
  padding: 0 6px;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 600;
  color: #fff;
  background: #64748b;
}
.collected-platform.douyin { background: #FE2C55; }
.collected-platform.bilibili { background: #00AEEC; }
.collected-platform.kuaishou { background: #FF6600; }
.collected-platform.xiaohongshu { background: #FF2442; }
.collected-platform.weixin { background: #07C160; }
.collected-platform.youtube { background: #FF0000; }
.collected-title {
  flex: 1 1 auto;
  min-width: 0;
  color: var(--foreground);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.collected-by { flex: 0 0 auto; font-size: 11px; color: var(--muted-foreground); }

/* 空状态 */
.creators-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-3);
  padding: 60px 20px;
  color: var(--muted-foreground);
  text-align: center;
}
.creators-empty svg { opacity: 0.4; }
.creators-empty-title { font-size: 15px; font-weight: 500; color: var(--foreground); }
.creators-empty-sub { font-size: 12px; max-width: 340px; line-height: 1.6; }

.creators-body::-webkit-scrollbar,
.collected-list::-webkit-scrollbar { width: 6px; }
.creators-body::-webkit-scrollbar-thumb,
.collected-list::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
.creators-body::-webkit-scrollbar-track,
.collected-list::-webkit-scrollbar-track { background: transparent; }
</style>
