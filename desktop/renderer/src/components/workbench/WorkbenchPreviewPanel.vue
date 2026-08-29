<script setup lang="ts">
// ═══════════════════════════════════════════════════════════════
// WorkbenchPreviewPanel.vue — 工作台右侧预览面板（纯展示 + 事件转发）
// 结构：顶部标题 + 折叠按钮；两类预览（tab 切换）：
//   · 资产预览：资产列表（可切换）→ script <pre> 代码样式 + 复制/导出 Word；
//                text 段落渲染 + 复制/导出 Word；table markdown 表格渲染
//   · 文件预览：docx iframe / xlsx 表格（复用 OfficeDocumentView 渲染体）
// 数据/业务在容器：assets 由容器 detectChatAssets 产出；文件预览复用 useOfficePreview
// 状态；导出 Word 仅事件转发（业务在 useOfficeExport）。
// ═══════════════════════════════════════════════════════════════
import { ref, computed, watch } from 'vue'
import type { ChatAsset } from '@/composables/workbenchChatLogic'
import { parseMarkdownTable } from '@/composables/workbenchChatLogic'
import type { OfficePreviewState } from '@/composables/useOfficePreview'
import OfficeDocumentView from '@/components/common/OfficeDocumentView.vue'

const props = defineProps<{
  /** 面板是否展开（容器控制宽度动画，本组件始终渲染） */
  open: boolean
  /** 对话资产（容器 detectChatAssets 产出；空数组 → 资产空态） */
  assets: ChatAsset[]
  /** 文件预览状态（useOfficePreview.state；open=true 且有 kind → 文件 tab 有内容） */
  file?: OfficePreviewState
  /** 文件转换加载中（docx/xlsx 读取） */
  fileLoading?: boolean
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'open-system'): void
  (e: 'switch-sheet', index: number): void
  (e: 'export-asset', asset: ChatAsset): void
}>()

const activeTab = ref<'assets' | 'file'>('assets')
const activeIndex = ref(0)
const copiedId = ref('')

const hasFile = computed(() => !!(props.file && props.file.open && props.file.kind !== ''))
const hasAssets = computed(() => props.assets.length > 0)
const current = computed<ChatAsset | null>(() => props.assets[activeIndex.value] || null)
const tableRows = computed<string[][]>(() =>
  current.value?.type === 'table' ? parseMarkdownTable(current.value.content) : []
)

/** 类型徽标文案 */
function typeLabel(t: ChatAsset['type']): string {
  return t === 'script' ? '脚本' : t === 'table' ? '表格' : '文案'
}

// 资产集更新（新气泡资产/切换会话）→ 切回资产 tab 并选中首个
watch(
  () => props.assets,
  (list) => {
    if (list.length) {
      activeIndex.value = 0
      activeTab.value = 'assets'
    }
  }
)
// 文件预览就绪（导出成功加载）→ 切到文件 tab
watch(
  () => props.file?.open,
  (v) => {
    if (v) activeTab.value = 'file'
  }
)

/** 复制资产内容（剪贴板不可用静默；成功短暂显示「已复制」） */
async function copyAsset(asset: ChatAsset) {
  try {
    await navigator.clipboard.writeText(asset.content)
    copiedId.value = asset.id
    setTimeout(() => {
      if (copiedId.value === asset.id) copiedId.value = ''
    }, 1500)
  } catch (_) { /* 剪贴板不可用不阻塞 */ }
}
</script>

<template>
  <aside class="wb-panel" aria-label="工作台预览">
    <!-- ─── 标题 + 折叠按钮 ─── -->
    <header class="wb-panel__head">
      <span class="wb-panel__title">工作台预览</span>
      <button class="wb-panel__fold" title="收起预览面板" @click="emit('close')">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6" /></svg>
      </button>
    </header>

    <!-- ─── tab（有文件预览时出现） ─── -->
    <div v-if="hasFile || hasAssets" class="wb-panel__tabs">
      <button
        class="wb-tab"
        :class="{ active: activeTab === 'assets' }"
        @click="activeTab = 'assets'"
      >资产<template v-if="assets.length">（{{ assets.length }}）</template></button>
      <button
        v-if="hasFile"
        class="wb-tab"
        :class="{ active: activeTab === 'file' }"
        @click="activeTab = 'file'"
      >文件</button>
    </div>

    <!-- ─── 资产预览 ─── -->
    <div v-if="activeTab === 'assets'" class="wb-panel__body">
      <template v-if="hasAssets">
        <!-- 资产列表（可切换） -->
        <div class="asset-list custom-scroll">
          <button
            v-for="(a, i) in assets"
            :key="a.id"
            class="asset-item"
            :class="{ active: i === activeIndex }"
            @click="activeIndex = i"
          >
            <span class="asset-badge" :class="a.type">{{ typeLabel(a.type) }}</span>
            <span class="asset-title" :title="a.title">{{ a.title }}</span>
          </button>
        </div>
        <!-- 资产详情 -->
        <div class="asset-detail custom-scroll">
          <template v-if="current">
            <div class="asset-detail__bar">
              <span class="asset-detail__name" :title="current.title">{{ current.title }}</span>
              <span v-if="current.lang" class="asset-lang">{{ current.lang }}</span>
              <div class="asset-detail__ops">
                <button
                  v-if="current.type !== 'table'"
                  class="ad-btn"
                  :title="copiedId === current.id ? '已复制' : '复制内容到剪贴板'"
                  @click="copyAsset(current)"
                >
                  <svg v-if="copiedId === current.id" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
                  <svg v-else width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
                  {{ copiedId === current.id ? '已复制' : '复制' }}
                </button>
                <button
                  v-if="current.type !== 'table'"
                  class="ad-btn"
                  title="导出该资产为 Word 文档"
                  @click="emit('export-asset', current)"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /></svg>
                  导出 Word
                </button>
              </div>
            </div>

            <!-- script：<pre> 代码样式 -->
            <pre v-if="current.type === 'script'" class="asset-pre">{{ current.content }}</pre>
            <!-- text：段落渲染（保留换行） -->
            <div v-else-if="current.type === 'text'" class="asset-text">{{ current.content }}</div>
            <!-- table：markdown 表格渲染（首行灰底表头） -->
            <div v-else-if="current.type === 'table'" class="asset-table-wrap">
              <table class="asset-table">
                <tbody>
                  <tr v-for="(row, ri) in tableRows" :key="ri">
                    <td v-for="(cell, ci) in row" :key="ci">{{ cell }}</td>
                  </tr>
                </tbody>
              </table>
              <div v-if="!tableRows.length" class="panel-empty">表格内容为空</div>
            </div>
          </template>
        </div>
      </template>
      <!-- 资产空态 -->
      <div v-else class="panel-empty">
        <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /></svg>
        <div class="panel-empty__text">暂无预览内容<br />AI 回复中的代码块 / 长文案 / 表格会自动出现在这里</div>
      </div>
    </div>

    <!-- ─── 文件预览（docx iframe / xlsx 表格，复用 OfficeDocumentView） ─── -->
    <div v-else-if="activeTab === 'file'" class="wb-panel__body wb-panel__file">
      <div v-if="fileLoading" class="panel-loading">正在转换预览…</div>
      <OfficeDocumentView
        v-else
        :docx-html="file && file.kind === 'docx' ? file.html : ''"
        :xlsx-sheets="file && file.kind === 'xlsx' ? file.sheets : undefined"
        :active-sheet="file ? file.activeSheet : 0"
        :error="file ? file.error : ''"
        :filename="file ? file.name : ''"
        @open-system="emit('open-system')"
        @switch-sheet="emit('switch-sheet', $event)"
      />
    </div>
  </aside>
</template>

<style scoped>
.wb-panel {
  width: 340px;
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--surface);
  border-left: 1px solid var(--border);
}

/* ─── 标题栏 ─── */
.wb-panel__head {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 10px var(--space-3);
  border-bottom: 1px solid var(--border);
}
.wb-panel__title {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--foreground);
}
.wb-panel__fold {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border: none;
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--muted-foreground);
  cursor: pointer;
  transition: all var(--duration-fast);
}
.wb-panel__fold:hover { background: var(--surface-container); color: var(--foreground); }

/* ─── tab ─── */
.wb-panel__tabs {
  flex: 0 0 auto;
  display: flex;
  gap: 2px;
  padding: 6px var(--space-3) 0;
  border-bottom: 1px solid var(--border);
}
.wb-tab {
  height: 28px;
  padding: 0 12px;
  font-size: 12px;
  border: 1px solid transparent;
  border-bottom: none;
  border-radius: var(--radius-md) var(--radius-md) 0 0;
  background: transparent;
  color: var(--muted-foreground);
  cursor: pointer;
  font-family: inherit;
}
.wb-tab.active {
  background: var(--surface-container);
  border-color: var(--border);
  color: var(--primary);
  font-weight: 600;
}

/* ─── 主体 ─── */
.wb-panel__body {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.wb-panel__file {
  padding: 0;
}

/* ─── 资产列表 ─── */
.asset-list {
  flex: 0 0 auto;
  max-height: 132px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px var(--space-2);
  border-bottom: 1px solid var(--border);
}
.asset-item {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 5px 8px;
  font-size: 12px;
  border: none;
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--foreground);
  text-align: left;
  cursor: pointer;
  font-family: inherit;
}
.asset-item:hover { background: var(--surface-container); }
.asset-item.active { background: var(--surface-container-high); }
.asset-badge {
  flex: 0 0 auto;
  padding: 1px 6px;
  font-size: 11px;
  border-radius: 999px;
  background: var(--surface-container-high);
  color: var(--muted-foreground);
}
.asset-badge.script { background: rgba(99, 102, 241, 0.12); color: var(--primary); }
.asset-badge.table { background: rgba(52, 199, 89, 0.12); color: #2e8b57; }
.asset-title {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ─── 资产详情 ─── */
.asset-detail {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
}
.asset-detail__bar {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px var(--space-3);
  border-bottom: 1px solid var(--border);
  background: var(--surface-container);
}
.asset-detail__name {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 12px;
  font-weight: 600;
  color: var(--foreground);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.asset-lang {
  flex: 0 0 auto;
  padding: 1px 6px;
  font-size: 11px;
  border-radius: 999px;
  background: var(--surface-container-high);
  color: var(--muted-foreground);
}
.asset-detail__ops { flex: 0 0 auto; display: flex; gap: 4px; }
.ad-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 24px;
  padding: 0 8px;
  font-size: 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--surface);
  color: var(--muted-foreground);
  cursor: pointer;
  font-family: inherit;
  transition: all var(--duration-fast);
}
.ad-btn:hover { border-color: var(--primary); color: var(--primary); }

.asset-pre {
  flex: 1 1 auto;
  margin: 0;
  padding: var(--space-3);
  font-size: 12px;
  line-height: 1.6;
  color: var(--foreground);
  background: var(--surface-container);
  white-space: pre-wrap;
  word-break: break-all;
  font-family: 'JetBrains Mono', Consolas, 'Courier New', monospace;
}
.asset-text {
  flex: 1 1 auto;
  padding: var(--space-3);
  font-size: 13px;
  line-height: 1.7;
  color: var(--foreground);
  white-space: pre-wrap;
  word-break: break-word;
}
.asset-table-wrap {
  flex: 1 1 auto;
  overflow: auto;
  padding: var(--space-3);
}
.asset-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
  color: var(--foreground);
}
.asset-table td {
  border: 1px solid var(--border);
  padding: 5px 8px;
  white-space: pre-wrap;
  word-break: break-all;
  vertical-align: top;
  background: var(--surface);
}
.asset-table tr:first-child td {
  background: var(--surface-container);
  font-weight: 600;
}

/* ─── 空态 / 加载态 ─── */
.panel-empty {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 24px;
  color: var(--muted-foreground);
  text-align: center;
}
.panel-empty__text { font-size: 12px; line-height: 1.7; }
.panel-loading {
  flex: 1 1 auto;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  color: var(--muted-foreground);
}

.custom-scroll::-webkit-scrollbar { width: 6px; height: 6px; }
.custom-scroll::-webkit-scrollbar-thumb { background: var(--surface-container-high); border-radius: 3px; }
</style>
