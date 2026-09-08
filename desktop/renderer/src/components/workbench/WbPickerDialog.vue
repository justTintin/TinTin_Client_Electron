<script setup lang="ts">
// WbPickerDialog.vue — 工作台选择弹窗·通用壳（产品/脚本共用）
// 2026-09-08 折壳重构：搜索/列表/预览主体抽至 WbPickerPanel（无弹窗版本，
// 供 VideoMontage 口播弹窗内嵌复用），本组件只提供 TDialog 壳与定高容器，
// 对外 props/emits/slots 与原实现完全一致（既有调用方零改动）。
// 2026-09-01 预览模式（previewable，产品弹窗用）：点行仅切换右侧预览区，
// 由预览区内「选择」按钮触发 pick——选中语义与预览语义分离（用户裁决）。
import TDialog from '@/components/common/TDialog.vue'
import WbPickerPanel from './WbPickerPanel.vue'
import type { PickerItem } from '@/composables/useWorkbenchPickers'

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

/** 选中条目：上报后关闭（单选语义，原版 dlg.exec()==Accepted） */
function onPick(item: PickerItem) {
  emit('pick', item)
  emit('close')
}
</script>

<template>
  <!-- 2026-08-31 用户裁决：弹窗放大到主界面 80%，vw/vh 随窗口缩放 -->
  <TDialog :visible="visible" :title="title" width="80vw" :show-footer="false" @close="emit('close')">
    <div class="picker-host">
      <WbPickerPanel
        :active="visible"
        :placeholder="placeholder"
        :tip="tip"
        :empty-text="emptyText"
        :fetcher="fetcher"
        :previewable="previewable"
        @pick="onPick"
        @preview="(it) => emit('preview', it)"
      >
        <template v-for="(_, name) in $slots" :key="name" #[name]="slotProps">
          <slot :name="name" v-bind="slotProps ?? {}" />
        </template>
      </WbPickerPanel>
    </div>
  </TDialog>
</template>

<style scoped>
/* 弹窗高度 ≈ 主界面 80vh（扣除 TDialog 头部/内边距）；面板弹性填满 */
.picker-host {
  height: calc(80vh - 120px);
}
</style>
