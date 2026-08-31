<script setup lang="ts">
// WbPickerDialog.vue — 工作台选择弹窗·通用骨架（产品/素材/脚本共用）
// 搜索编排（fetcher 调用 / 离线与 5xx 文案）在 usePickerSearch
// （composables/useWorkbenchPickers），本组件只绘制三态（加载中/失败/
// 空结果）与结果列表，选中即上报（原版弹窗「确定」语义 → 点行即选并关闭）。
// 每次打开重置并按空关键字预载列表（原版弹窗每次 exec 重新加载口径）。
import { watch } from 'vue'
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
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'pick', item: PickerItem): void
}>()

const { kw, items, loading, error, searched, run, reset } = usePickerSearch(props.fetcher)

// 打开即预载（immediate 兼容父层 v-if 挂载即 visible=true 的用法）
watch(
  () => props.visible,
  (v) => {
    if (v) {
      reset()
      void run()
    }
  },
  { immediate: true }
)

/** 选中条目：上报后关闭（单选语义，原版 dlg.exec()==Accepted） */
function onPick(item: PickerItem) {
  emit('pick', item)
  emit('close')
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
          title="选择该条目"
          @click="onPick(it)"
        >
          <slot name="item" :item="it" />
        </button>
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

.picker-list {
  flex: 1 1 auto;
  min-height: 160px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
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
