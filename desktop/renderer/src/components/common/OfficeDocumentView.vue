<script setup lang="ts">
// ═══════════════════════════════════════════════════════════════
// OfficeDocumentView.vue — 办公文件预览渲染体（纯展示，弹窗/右侧面板共用）
// 职责：docx → iframe（sandbox，srcdoc=mammoth html）；xlsx → 多 Sheet Tab +
//       只读表格（表头灰底）；错误态（E4）→ 错误文案 + 「用系统程序打开」兜底。
// 无状态：props 即全部数据源，事件向上转发（open-system / switch-sheet）。
// ═══════════════════════════════════════════════════════════════
import { ref, watch } from 'vue'
import type { PreviewSheet } from '@/composables/useOfficePreview'

defineProps<{
  /** docx 预览 html（mammoth 输出，iframe srcdoc；非空即 docx 渲染） */
  docxHtml?: string
  /** xlsx 预览多 Sheet（undefined=非 xlsx；空数组=无 Sheet 空态） */
  xlsxSheets?: PreviewSheet[]
  /** 当前激活 Sheet 下标 */
  activeSheet?: number
  /** 错误态（E4：损坏/非预期 → 错误文案 + 系统打开兜底） */
  error?: string
  /** 文件名（错误文案等展示用） */
  filename?: string
}>()

const emit = defineEmits<{
  (e: 'open-system'): void
  (e: 'switch-sheet', index: number): void
}>()

// 切换 Sheet 时重置滚动位置
const sheetBodyRef = ref<HTMLDivElement | null>(null)
watch(
  () => activeSheet,
  () => {
    if (sheetBodyRef.value) sheetBodyRef.value.scrollTop = 0
  }
)
</script>

<template>
  <!-- 错误态（E4：损坏/非预期 → 错误文案 + 系统打开兜底） -->
  <div v-if="error" class="odv-error">
    <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2">
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
    </svg>
    <div class="err-title">预览失败</div>
    <div class="err-desc">{{ error }}</div>
    <button class="err-open" @click="emit('open-system')">用系统程序打开</button>
  </div>

  <!-- docx：iframe（sandbox，srcdoc=mammoth html，正文 14px/行距 1.6 样式已由主进程注入） -->
  <iframe
    v-else-if="docxHtml"
    class="odv-frame"
    sandbox=""
    :srcdoc="docxHtml"
    :title="`${filename || '文档'} 预览`"
  />

  <!-- xlsx：多 Sheet Tab + 只读表格 -->
  <div v-else-if="xlsxSheets !== undefined" class="odv-xlsx">
    <div v-if="xlsxSheets.length > 1" class="sheet-tabs">
      <button
        v-for="(s, i) in xlsxSheets"
        :key="s.name + i"
        class="sheet-tab"
        :class="{ active: activeSheet === i }"
        @click="emit('switch-sheet', i)"
      >{{ s.name }}</button>
    </div>
    <div ref="sheetBodyRef" class="sheet-body custom-scroll">
      <template v-if="xlsxSheets.length">
        <table class="sheet-table">
          <tbody>
            <tr v-for="(row, ri) in xlsxSheets[activeSheet || 0]?.rows || []" :key="ri">
              <td v-for="(cell, ci) in row" :key="ci">{{ cell }}</td>
            </tr>
          </tbody>
        </table>
        <div v-if="xlsxSheets[activeSheet || 0]?.rows?.length === 0" class="sheet-empty">该 Sheet 无数据</div>
      </template>
      <div v-else class="sheet-empty">无可预览的 Sheet</div>
    </div>
  </div>

  <!-- 兜底空态（无 docx/xlsx/error 数据） -->
  <div v-else class="odv-empty">无可预览的内容</div>
</template>

<style scoped>
.odv-frame {
  flex: 1 1 auto;
  min-height: 0;
  width: 100%;
  border: none;
  background: #fff;
}
.odv-error {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 24px;
  color: var(--muted-foreground, #666);
  text-align: center;
}
.err-title { font-size: 15px; font-weight: 600; color: var(--foreground, #1f2328); }
.err-desc { font-size: 12px; max-width: 420px; line-height: 1.6; word-break: break-all; }
.err-open {
  margin-top: 6px;
  height: 28px;
  padding: 0 14px;
  font-size: 12px;
  border: 1px solid var(--primary, #6366f1);
  border-radius: var(--radius-md, 8px);
  background: transparent;
  color: var(--primary, #6366f1);
  cursor: pointer;
  font-family: inherit;
}
.err-open:hover { background: rgba(99, 102, 241, 0.08); }

.odv-xlsx {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.sheet-tabs {
  flex: 0 0 auto;
  display: flex;
  gap: 4px;
  padding: 8px var(--space-4, 16px) 0;
  border-bottom: 1px solid var(--border, #e2e4ea);
  background: var(--surface, #fff);
}
.sheet-tab {
  height: 30px;
  padding: 0 12px;
  font-size: 12px;
  border: 1px solid transparent;
  border-bottom: none;
  border-radius: var(--radius-md, 8px) var(--radius-md, 8px) 0 0;
  background: transparent;
  color: var(--muted-foreground, #666);
  cursor: pointer;
  font-family: inherit;
}
.sheet-tab.active {
  background: var(--surface-container, #f6f7f9);
  border-color: var(--border, #e2e4ea);
  color: var(--primary, #6366f1);
  font-weight: 600;
}
.sheet-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  padding: var(--space-3, 12px) var(--space-4, 16px);
}
.sheet-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
  color: var(--foreground, #1f2328);
}
.sheet-table td {
  border: 1px solid var(--border, #e2e4ea);
  padding: 5px 8px;
  white-space: pre-wrap;
  word-break: break-all;
  vertical-align: top;
  background: var(--surface, #fff);
}
.sheet-table tr:first-child td {
  background: var(--surface-container, #f6f7f9);
  font-weight: 600;
}
.sheet-empty {
  padding: 40px 0;
  text-align: center;
  font-size: 13px;
  color: var(--muted-foreground, #666);
}
.odv-empty {
  flex: 1 1 auto;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  color: var(--muted-foreground, #666);
}
.custom-scroll::-webkit-scrollbar { width: 8px; height: 8px; }
.custom-scroll::-webkit-scrollbar-thumb { background: var(--surface-container-high, #d5d8e0); border-radius: 4px; }
</style>
