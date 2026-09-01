<script setup lang="ts">
// WbPickProductDialog.vue — 选择产品弹窗（工作台输入区上下文）
// 原版 _ProductPickerDialog（L810-875）+ _pick_product L1778-1784：
// 单选，重复选择直接覆盖当前产品胶囊；列表行为「[品类] 品牌 / 型号」。
// 行文案为纯展示拼接（原版 L866 同口径），业务在容器 chat.addCtxProduct。
import WbPickerDialog from './WbPickerDialog.vue'
import { fetchProducts, type PickerItem } from '@/composables/useWorkbenchPickers'
import { firstMarkdownLine, firstSellingPoint } from '@/composables/opsProductLibraryLogic'

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

/** 行副文案：核心卖点摘要（取第一条卖点并剥离 markdown 标记；logic 层可单测） */
function subText(it: PickerItem): string {
  const sp = firstSellingPoint(it.selling_points)
  return sp ? `卖点：${sp}` : ''
}

/** 右块上行：性能参数首行（features，与卖点同格式多行 markdown 列表） */
function specText(it: PickerItem): string {
  const sp = firstMarkdownLine(it.features)
  return sp ? `参数：${sp}` : ''
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
      <!-- 2026-09-01 用户裁决（像素材检索分块）：左侧产品型号，右侧性能参数+核心卖点两行 -->
      <span class="prow">
        <span class="row-main">{{ mainText(item) }}</span>
        <span class="row-side">
          <span v-if="specText(item)" class="row-line" :title="specText(item)">{{ specText(item) }}</span>
          <span v-if="subText(item)" class="row-line" :title="subText(item)">{{ subText(item) }}</span>
        </span>
      </span>
    </template>
  </WbPickerDialog>
</template>

<style scoped>
/* 两块布局（像素材检索）：左侧产品型号（主文案，可收缩截断），
   右侧性能参数 + 核心卖点两行（固定占比宽，ellipsis + title 悬停看全文） */
.prow {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  width: 100%;
  min-width: 0;
}

.row-main {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  color: var(--foreground);
}

.row-side {
  flex: 0 1 45%;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.row-line {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  color: var(--muted-foreground);
}
</style>
