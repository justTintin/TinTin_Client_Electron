<script setup lang="ts">
// WbPickProductDialog.vue — 选择产品弹窗（工作台输入区上下文）
// 原版 _ProductPickerDialog（L810-875）+ _pick_product L1778-1784：
// 单选，重复选择直接覆盖当前产品胶囊。
// 2026-09-01 用户裁决（预览模式）：左侧列表仅型号行，点击仅切换右侧预览
// （选中产品的性能参数+核心卖点全文，像素材预览），预览区内「选择该产品」
// 按钮才真正选中——预览与选中语义分离（对齐音频 Tab 的选择按钮口径）。
// 行文案/预览内容为纯展示拼接，业务在容器 chat.addCtxProduct。
import WbPickerDialog from './WbPickerDialog.vue'
import { fetchProducts, type PickerItem } from '@/composables/useWorkbenchPickers'
import { markdownListLines } from '@/composables/opsProductLibraryLogic'

/** 行主文案：[品类] 品牌 / 型号（原版 L865-866，型号缺省回退货号） */
function mainText(it: PickerItem): string {
  const cat = String(it.category || '未分类')
  const brand = String(it.brand || '')
  const model = String(it.model || it.goods_no || '')
  return `[${cat}] ${brand} / ${model}`
}

/** 预览区标题：品牌 / 型号（不带品类前缀，详情语义） */
function previewTitle(it: PickerItem): string {
  const brand = String(it.brand || '')
  const model = String(it.model || it.goods_no || '')
  return [brand, model].filter(Boolean).join(' / ') || '(未命名产品)'
}

/** 性能参数全文（features 多行 markdown 列表 → 逐条剥离标记；logic 层可单测） */
function specLines(it: PickerItem): string[] {
  return markdownListLines(it.features)
}

/** 核心卖点全文（selling_points 同格式，逐条剥离标记） */
function pointLines(it: PickerItem): string[] {
  return markdownListLines(it.selling_points)
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
    previewable
    @close="emit('close')"
    @pick="(it) => emit('pick', it)"
  >
    <template #item="{ item }">
      <!-- 左列表行：仅型号主文案（参数/卖点移到右侧预览区全文展示） -->
      <span class="prow">{{ mainText(item) }}</span>
    </template>

    <template #preview="{ item, confirm }">
      <!-- 空态：未选择任何产品 -->
      <div v-if="!item" class="pv-empty">
        点击左侧产品查看性能参数与核心卖点
      </div>
      <div v-else class="pv">
        <div class="pv-title">{{ previewTitle(item) }}</div>

        <div class="pv-section">性能参数</div>
        <div v-if="specLines(item).length" class="pv-lines">
          <div v-for="(l, i) in specLines(item)" :key="'sp' + i" class="pv-line">{{ l }}</div>
        </div>
        <div v-else class="pv-none">暂无性能参数</div>

        <div class="pv-section">核心卖点</div>
        <div v-if="pointLines(item).length" class="pv-lines">
          <div v-for="(l, i) in pointLines(item)" :key="'pt' + i" class="pv-line">{{ l }}</div>
        </div>
        <div v-else class="pv-none">暂无核心卖点</div>

        <div class="pv-ops">
          <button class="pv-confirm" title="选中该产品，加入对话上下文（原「确定」语义）" @click="confirm(item)">
            选择该产品
          </button>
        </div>
      </div>
    </template>
  </WbPickerDialog>
</template>

<style scoped>
/* 左列表行：型号主文案（单行截断） */
.prow {
  display: block;
  width: 100%;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  color: var(--foreground);
}

/* ─── 右侧预览区 ─── */
.pv {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.pv-empty {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  color: var(--muted-foreground);
  text-align: center;
  padding: 0 var(--space-3);
}

.pv-title {
  font-size: 15px;
  font-weight: var(--font-weight-semibold);
  color: var(--foreground);
  padding-bottom: var(--space-2);
  border-bottom: 1px solid var(--border);
}

.pv-section {
  margin-top: var(--space-2);
  font-size: 12px;
  font-weight: var(--font-weight-semibold);
  color: var(--muted-foreground);
}

.pv-lines {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.pv-line {
  font-size: 13px;
  line-height: 1.6;
  color: var(--foreground);
  word-break: break-word;
}

.pv-none {
  font-size: 12px;
  color: var(--muted-foreground);
}

.pv-ops {
  margin-top: var(--space-3);
  padding-top: var(--space-3);
  border-top: 1px solid var(--border);
  display: flex;
  justify-content: flex-end;
}

.pv-confirm {
  padding: 7px var(--space-4);
  font-size: 13px;
  background: var(--primary);
  color: var(--primary-foreground);
  border-radius: var(--radius-md);
  transition: filter var(--duration-fast);
}
.pv-confirm:hover { filter: brightness(1.1); }
</style>
