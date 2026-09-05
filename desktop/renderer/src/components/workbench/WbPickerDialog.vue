<script setup lang="ts">
// WbPickerDialog.vue — 工作台选择弹窗·通用骨架（产品/素材/脚本共用）
// 搜索编排（fetcher 调用 / 离线与 5xx 文案）在 usePickerSearch
// （composables/useWorkbenchPickers），本组件只绘制三态（加载中/失败/
// 空结果）与结果列表，选中即上报（原版弹窗「确定」语义 → 点行即选并关闭）。
// 每次打开重置并按空关键字预载列表（原版弹窗每次 exec 重新加载口径）。
// 2026-09-01 预览模式（previewable，产品弹窗用）：点行仅切换右侧预览区
// （slot #preview，插槽 props: item/confirm），由预览区内「选择」按钮触发
// pick——选中语义与预览语义分离（用户裁决，对齐音频 Tab 的选择按钮）。
import { ref, watch } from 'vue'
import TDialog from '@/components/common/TDialog.vue'
import { usePickerSearch, type PickerItem } from '@/composables/useWorkbenchPickers'

const props = defineProps<{
  visible: boolean
  title: string
  placeholder: string
  /** 底部数据来源提示（原版 tip 文案口径） */
  tip: string
  /** 搜索函数（三个弹窗各自注入，组件不感知 URL） */
  fetcher: (kw: string) => Promise<PickerItem[]>
  /** 空结果提示 */
  emptyText: string
  /** 预览模式：点行不 pick，只切换右侧预览区（默认 false 保持点行即选） */
  previewable?: boolean
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'pick', item: PickerItem): void
  (e: 'preview', item: PickerItem): void
}>()

const { kw, items, loading, error, searched, run, reset } = usePickerSearch(props.fetcher)

/** 预览模式当前选中条目（点行切换；搜索/重开后失效清空） */
const sel = ref<PickerItem | null>(null)

// 打开即预载（immediate 兼容父层 v-if 挂载即 visible=true 的用法）
watch(
  () => props.visible,
  (v) => {
    if (v) {
      reset()
      sel.value = null
      void run()
    }
  },
  { immediate: true }
)

// 搜索后列表变化，预览条目可能已不在结果内（避免预览残留）
watch(items, () => { sel.value = null })

/** 选中条目：上报后关闭（单选语义，原版 dlg.exec()==Accepted） */
function onPick(item: PickerItem) {
  emit('pick', item)
  emit('close')
}

/** 行点击：预览模式仅切换预览；普通模式即选即关 */
function onRowClick(item: PickerItem) {
  if (props.previewable) {
    sel.value = item
    emit('preview', item)
  } else {
    onPick(item)
  }
}
</script>

<template>
  <!-- 2026-08-31 用户裁决：弹窗放大到主界面 80%，vw/vh 随窗口缩放 -->
  <TDialog :visible="visible" :title="title" width="80vw" :show-footer="false" @close="emit('close')">
    <div class="picker">
      <div class="picker-search">
        <input
          v-model="kw"
          class="picker-input"
          :placeholder="placeholder"
          @keydown.enter="run()"
        />
        <button class="picker-btn" :disabled="loading" @click="run()">搜索</button>
      </div>

      <div class="picker-main">
        <div class="picker-list">
          <div v-if="loading" class="picker-state">加载中…</div>
          <div v-else-if="error" class="picker-state picker-state--error">{{ error }}</div>
          <div v-else-if="!items.length" class="picker-state">
            {{ searched ? emptyText : '输入关键词后回车或点「搜索」' }}
          </div>
          <button
            v-for="(it, i) in items"
            v-else
            :key="String(it.id ?? it.material_id ?? i)"
            class="picker-row"
            :class="{ active: sel === it }"
            :title="previewable ? '查看该条目详情' : '选择该条目'"
            @click="onRowClick(it)"
          >
            <slot name="item" :item="it" />
          </button>
        </div>

        <!-- 预览模式右侧列：纵向堆叠 预览框 + 确认按钮（2026-09-04 用户裁决：
             预览框高度减少一行，按钮在框下方；修复原 footer 与预览框并排拉成竖条） -->
        <div v-if="previewable" class="picker-side">
          <div class="picker-preview custom-scroll">
            <slot name="preview" :item="sel" />
          </div>
          <div v-if="sel" class="picker-preview-footer">
            <slot name="preview-footer" :item="sel" :confirm="onPick" />
          </div>
        </div>
      </div>

      <p class="picker-tip">{{ tip }}</p>
    </div>
  </TDialog>
</template>

<style scoped>
.picker {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  /* 弹窗高度 ≈ 主界面 80vh（扣除 TDialog 头部/内边距）；列表区弹性填满并滚动 */
  height: calc(80vh - 120px);
}

.picker-search {
  display: flex;
  gap: var(--space-2);
}

.picker-input {
  flex: 1 1 auto;
  height: 34px;
  padding: 0 var(--space-3);
  background: var(--surface-container);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  color: var(--foreground);
  font-size: var(--font-size-body);
  outline: none;
  transition: all var(--duration-fast);
}

.picker-input:focus {
  border-color: var(--primary);
  box-shadow: 0 0 0 3px var(--ring);
}

.picker-btn {
  height: 34px;
  padding: 0 var(--space-4);
  border-radius: var(--radius-md);
  background: var(--primary);
  color: var(--primary-foreground);
  font-size: var(--font-size-body);
  transition: filter var(--duration-fast);
}

.picker-btn:hover {
  filter: brightness(1.1);
}

.picker-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.picker-main {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  gap: var(--space-3);
}

.picker-list {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 160px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

/* 预览模式右侧列：纵向 预览框 + footer（宽度沿用原预览区占比） */
.picker-side {
  flex: 0 0 46%;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

/* 预览模式：预览框弹性填满侧列（扣除 footer 一行按钮高度），独立滚动 */
.picker-preview {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--surface-container);
  padding: var(--space-3);
}

/* 预览模式当前条目高亮（点行仅预览，需看见选中的是哪条） */
.picker-row.active {
  border-color: var(--primary);
  background: var(--surface-container-high);
}

.custom-scroll::-webkit-scrollbar { width: 6px; height: 6px; }
.custom-scroll::-webkit-scrollbar-thumb { background: var(--surface-container-high); border-radius: 3px; }

/* 预览模式底部操作栏（预览框下方一行；按钮宽度与预览框对齐，
   2026-09-04 用户裁决，同素材弹窗 mtd-btn--full 口径） */
.picker-preview-footer {
  flex: 0 0 auto;
  display: flex;
  padding-top: var(--space-2);
}
.picker-preview-footer :deep(button) {
  flex: 1 1 auto;
  width: 100%;
}

.picker-state {
  padding: var(--space-5) var(--space-3);
  text-align: center;
  font-size: var(--font-size-body);
  color: var(--muted-foreground);
}

.picker-state--error {
  color: var(--destructive, #e5484d);
}

.picker-row {
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--surface-container);
  text-align: left;
  display: flex;
  flex-direction: column;
  gap: 2px;
  transition: all var(--duration-fast);
}

.picker-row:hover {
  border-color: var(--primary);
  background: var(--surface-container-high);
}

.picker-tip {
  font-size: 12px;
  color: var(--muted-foreground);
}
</style>
