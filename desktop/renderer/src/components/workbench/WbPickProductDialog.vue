<script setup lang="ts">
// WbPickProductDialog.vue — 选择产品弹窗（工作台输入区上下文）
// 原版 _ProductPickerDialog（L810-875）+ _pick_product L1778-1784：
// 单选，重复选择直接覆盖当前产品胶囊；列表行为「[品类] 品牌 / 型号」。
// 行文案为纯展示拼接（原版 L866 同口径），业务在容器 chat.addCtxProduct。
import WbPickerDialog from './WbPickerDialog.vue'
import { fetchProducts, type PickerItem } from '@/composables/useWorkbenchPickers'

defineProps<{ visible: boolean }>()
const emit = defineEmits<{
  (e: 'close'): void
  (e: 'pick', item: PickerItem): void
}>()

/** 行主文案：[品类] 品牌 / 型号（原版 L865-866，型号缺省回退货号） */
function mainText(it: PickerItem): string {
  const cat = String(it.category || '未分类')
  const brand = String(it.brand || '')
  const model = String(it.model || it.goods_no || '')
  return `[${cat}] ${brand} / ${model}`
}

/** 行副文案：卖点摘要（截断 60 字） */
function subText(it: PickerItem): string {
  const sp = String(it.selling_points || '').trim()
  return sp ? `卖点：${sp.slice(0, 60)}` : ''
}
</script>

<template>
  <WbPickerDialog
    :visible="visible"
    title="选择产品"
    placeholder="输入品类/品牌/型号搜索…"
    tip="产品数据来自服务端产品资料库；为空时可先在「产品资料」页同步。"
    empty-text="未找到匹配的产品，换个关键词试试。"
    :fetcher="fetchProducts"
    @close="emit('close')"
    @pick="(it) => emit('pick', it)"
  >
    <template #item="{ item }">
      <span class="row-main">{{ mainText(item) }}</span>
      <span v-if="subText(item)" class="row-sub">{{ subText(item) }}</span>
    </template>
  </WbPickerDialog>
</template>

<style scoped>
.row-main {
  font-size: 13px;
  color: var(--foreground);
}

.row-sub {
  font-size: 12px;
  color: var(--muted-foreground);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
