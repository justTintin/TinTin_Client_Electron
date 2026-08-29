<script setup lang="ts">
// WbPickScriptDialog.vue — 选择分镜脚本弹窗（工作台输入区上下文）
// 原版 _ScriptPickerDialog（L957-1024）+ _pick_script L1830-1838：
// 单选，选中后由容器按 id 去重加入脚本胶囊；列表行为
// 「[主题] N镜 · 保存时间」（原版 L1012-1014 同口径）。
import WbPickerDialog from './WbPickerDialog.vue'
import { fetchScripts, type PickerItem } from '@/composables/useWorkbenchPickers'

defineProps<{ visible: boolean }>()
const emit = defineEmits<{
  (e: 'close'): void
  (e: 'pick', item: PickerItem): void
}>()

/** 行主文案：[主题] N镜（原版 L1012） */
function mainText(it: PickerItem): string {
  return `[${String(it.topic || '')}] ${Number(it.shot_count || 0)}镜`
}

/** 行副文案：画幅 · 保存时间（原版 L1013-1014） */
function subText(it: PickerItem): string {
  const parts: string[] = []
  const ratio = String(it.ratio || '').trim()
  if (ratio) parts.push(ratio)
  const saved = String(it.saved_at || '').trim()
  if (saved) parts.push(saved)
  return parts.join(' · ')
}
</script>

<template>
  <WbPickerDialog
    :visible="visible"
    title="选择分镜脚本"
    placeholder="输入主题搜索脚本…"
    tip="脚本来自服务端分镜脚本库；为空时可先在「分镜脚本创作」页保存脚本。"
    empty-text="未找到匹配的脚本，换个关键词试试。"
    :fetcher="fetchScripts"
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
