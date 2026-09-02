<script setup lang="ts">
// WbPickProductDialog.vue — 选择产品弹窗（工作台输入区上下文）
// 原版 _ProductPickerDialog（L810-875）+ _pick_product L1778-1784：
// 单选，重复选择直接覆盖当前产品胶囊。
// 2026-09-01 用户裁决（预览模式）：左侧列表仅型号行，点击仅切换右侧预览
// （选中产品的性能参数+核心卖点全文，像素材预览），预览区下方「选择该产品」
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

    <template #preview="{ item }">
      <!-- 空态：未选择任何产品 -->
      <div v-if="!item" class="pv-empty">
        点击左侧产品查看性能参数与核心卖点
      </div>
      <div v-else class="pv">
        <div class="pv-title">{{ previewTitle(item) }}</div>

        <!-- 性能参数卡片 -->
        <div class="pv-card">
          <div class="pv-card-head">
            <svg class="pv-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>
            </svg>
            <span>性能参数</span>
          </div>
          <div v-if="specLines(item).length" class="pv-tags">
            <span v-for="(l, i) in specLines(item)" :key="'sp' + i" class="pv-tag">{{ l }}</span>
          </div>
          <div v-else class="pv-none">暂无性能参数</div>
        </div>

        <!-- 核心卖点卡片 -->
        <div class="pv-card">
          <div class="pv-card-head">
            <svg class="pv-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
            </svg>
            <span>核心卖点</span>
          </div>
          <div v-if="pointLines(item).length" class="pv-tags">
            <span v-for="(l, i) in pointLines(item)" :key="'pt' + i" class="pv-tag pv-tag--accent">{{ l }}</span>
          </div>
          <div v-else class="pv-none">暂无核心卖点</div>
        </div>
      </div>
    </template>

    <template #preview-footer="{ item, confirm }">
      <button class="pv-confirm" title="选中该产品，加入对话上下文（原「确定」语义）" @click="confirm(item)">
        选择该产品
      </button>
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
  gap: var(--space-3);
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

/* 分组卡片 */
.pv-card {
  background: var(--surface-container);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  padding: var(--space-3);
}

.pv-card-head {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: var(--font-weight-semibold);
  color: var(--muted-foreground);
  margin-bottom: var(--space-2);
}

.pv-icon {
  color: var(--muted-foreground);
  flex-shrink: 0;
}

/* 标签式列表 */
.pv-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.pv-tag {
  display: inline-block;
  padding: 3px 10px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--foreground);
  background: var(--surface-container-high);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  word-break: break-word;
}

.pv-tag--accent {
  border-color: color-mix(in srgb, var(--primary) 30%, transparent);
  background: color-mix(in srgb, var(--primary) 8%, transparent);
}

.pv-none {
  font-size: 12px;
  color: var(--muted-foreground);
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
