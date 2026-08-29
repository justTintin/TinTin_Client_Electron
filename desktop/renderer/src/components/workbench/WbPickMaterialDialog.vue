<script setup lang="ts">
// WbPickMaterialDialog.vue — 选择素材弹窗（工作台输入区上下文）
// 原版 _MaterialPickerDialog（L878-954）+ _pick_material L1786-1828：
// 单选，选中后由容器按 material_id 去重入会话素材池；列表行为
// 「[类型] 文件名（品牌 / 型号）」（原版 L936-945 同口径）。
import WbPickerDialog from './WbPickerDialog.vue'
import { fetchMaterials, type PickerItem } from '@/composables/useWorkbenchPickers'
import { mediaTypeLabel } from '@/composables/workbenchChatContext'

defineProps<{ visible: boolean }>()
const emit = defineEmits<{
  (e: 'close'): void
  (e: 'pick', item: PickerItem): void
}>()

/** 行主文案：[类型] 文件名（原版 L937-945，类型中文标签回退「素材」） */
function mainText(it: PickerItem): string {
  const mid = String(it.id ?? it.material_id ?? '')
  const name = String(it.filename || mid || '未命名')
  return `[${mediaTypeLabel(String(it.media_type || ''))}] ${name}`
}

/** 行副文案：品牌 / 型号 · 路径（原版 L941-944，model 缺省回退 product） */
function subText(it: PickerItem): string {
  const brand = String(it.brand || '').trim()
  const model = String(it.model || it.product || '').trim()
  const parts: string[] = []
  if (brand || model) parts.push(`${brand} / ${model}`)
  const path = String(it.path || '').trim()
  if (path) parts.push(path)
  return parts.join(' · ')
}
</script>

<template>
  <WbPickerDialog
    :visible="visible"
    title="选择素材"
    placeholder="输入文件名/品牌/型号搜索…"
    tip="素材来自服务端素材库；为空时可先在「素材检索」页确认服务端素材是否已入库。"
    empty-text="未找到匹配的素材，换个关键词试试。"
    :fetcher="fetchMaterials"
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
