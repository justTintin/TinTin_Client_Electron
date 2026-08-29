<script setup lang="ts">
// ═══════════════════════════════════════════════════════════════
// OfficePreview.vue — 办公能力内嵌预览弹窗壳（P1，PRD §3.3 纯展示）
// 结构：标题（文件名）+ 工具栏（用系统程序打开 / 关闭）+ 加载态；
//       主体渲染体抽至 OfficeDocumentView（docx iframe / xlsx 表格 / 错误兜底），
//       弹窗与右侧工作台预览面板共用同一渲染体。
// 行为：Esc / 遮罩点击关闭；不自动弹出（调用方在导出成功反馈中提供入口）。
// 状态在 useOfficePreview（composable），本组件只做绘制 + 事件转发。
// ═══════════════════════════════════════════════════════════════
import { onMounted, onBeforeUnmount } from 'vue'
import type { OfficePreviewState } from '@/composables/useOfficePreview'
import OfficeDocumentView from '@/components/common/OfficeDocumentView.vue'

const props = defineProps<{
  preview: OfficePreviewState
  loading?: boolean
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'open-system'): void
  (e: 'switch-sheet', index: number): void
}>()

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && props.preview?.open) emit('close')
}
onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <Teleport to="body">
    <div v-if="preview.open" class="office-preview-mask" @click.self="emit('close')">
      <div class="office-preview" role="dialog" aria-label="文件预览">
        <!-- 标题 + 工具栏（用系统程序打开 / 关闭） -->
        <header class="office-preview__head">
          <span class="office-preview__title" :title="preview.path">{{ preview.name }}</span>
          <div class="office-preview__ops">
            <button class="op-btn" title="用系统程序打开（Word/Excel/WPS）" @click="emit('open-system')">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                <polyline points="15 3 21 3 21 9" />
                <line x1="10" y1="14" x2="21" y2="3" />
              </svg>
              用系统程序打开
            </button>
            <button class="op-btn op-btn--close" title="关闭（Esc）" @click="emit('close')">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
              关闭
            </button>
          </div>
        </header>

        <!-- 加载态 -->
        <div v-if="loading" class="office-preview__loading">正在转换预览…</div>

        <!-- 渲染体（docx iframe / xlsx 表格 / 错误态兜底，与右侧面板共用） -->
        <OfficeDocumentView
          v-else
          :docx-html="preview.kind === 'docx' ? preview.html : ''"
          :xlsx-sheets="preview.kind === 'xlsx' ? preview.sheets : undefined"
          :active-sheet="preview.activeSheet"
          :error="preview.error"
          :filename="preview.name"
          @open-system="emit('open-system')"
          @switch-sheet="emit('switch-sheet', $event)"
        />
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.office-preview-mask {
  position: fixed;
  inset: 0;
  z-index: 200;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(11, 12, 16, 0.5);
  backdrop-filter: blur(2px);
}
.office-preview {
  width: min(880px, calc(100vw - 64px));
  height: min(620px, calc(100vh - 64px));
  display: flex;
  flex-direction: column;
  background: var(--surface, #fff);
  border: 1px solid var(--border, #e2e4ea);
  border-radius: var(--radius-lg, 12px);
  box-shadow: var(--shadow-4, 0 16px 48px rgba(0, 0, 0, 0.28));
  overflow: hidden;
}
.office-preview__head {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: var(--space-3, 12px);
  padding: 10px var(--space-4, 16px);
  border-bottom: 1px solid var(--border, #e2e4ea);
  background: var(--surface, #fff);
}
.office-preview__title {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--foreground, #1f2328);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.office-preview__ops { display: flex; align-items: center; gap: 6px; flex: 0 0 auto; }
.op-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 26px;
  padding: 0 10px;
  font-size: 12px;
  border: 1px solid var(--border, #e2e4ea);
  border-radius: var(--radius-md, 8px);
  background: var(--surface-container, #f6f7f9);
  color: var(--muted-foreground, #666);
  cursor: pointer;
  font-family: inherit;
  transition: all var(--duration-fast, 0.15s);
}
.op-btn:hover { border-color: var(--primary, #6366f1); color: var(--primary, #6366f1); }
.op-btn--close:hover { border-color: var(--destructive, #e5484d); color: var(--destructive, #e5484d); }

.office-preview__loading {
  flex: 1 1 auto;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  color: var(--muted-foreground, #666);
}
</style>
