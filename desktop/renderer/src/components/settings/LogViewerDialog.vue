<script setup lang="ts">
// ═══════════════════════════════════════════════════════════════
// LogViewerDialog — 系统日志查看器（独立弹出窗口，2026-09-06 用户裁决）
// 自环境与维护卡内嵌区块抽取：设置页只留「打开日志」按钮触发本弹窗。
// 内容对齐原客户端日志查看页（gui/main_window_pages.py L1563-1620）：
//   · 历史日志文件下拉（新→旧）+ 级别过滤 + 关键词过滤 + 只读文本区展示
//   · 内置操作（2026-08-31 用户反馈：不再用外部软件打开）：
//     「复制」＝当前查看内容写剪贴板（env:copyText）；
//     「清空」＝当前文件写入归零（文件保留，env:logClear）
// 数据源：env:logList / env:logRead / env:logClear / env:copyText
//   （主进程 logger.js，electron-log 5.x：main.log 5MB 旋转 main.old.log，
//   历史 client-YYYYMMDD.log 只读兼容、随 30 天清理自然淘汰）。
// 过滤编组纯函数在 logViewLogic.ts（可单测）。
// ═══════════════════════════════════════════════════════════════
import { watch } from 'vue'
import { useLogViewer } from '../../composables/useLogViewer'
import { LOG_LEVEL_FILTERS, parseLogLevel } from '../../composables/logViewLogic'

const props = defineProps<{ modelValue: boolean }>()
const emit = defineEmits<{ (e: 'update:modelValue', v: boolean): void }>()

const {
  logFiles,
  logsDir,
  selectedLog,
  levelFilter,
  keyword,
  filteredLines,
  loading,
  truncated,
  loadError,
  actionMsg,
  loadLogList,
  selectLogFile,
  copyLog,
  clearLog,
} = useLogViewer()

/** 弹窗打开时拉取日志文件列表（默认选中最新一份） */
watch(
  () => props.modelValue,
  (open) => { if (open) void loadLogList() },
  { immediate: true },
)

function close() { emit('update:modelValue', false) }

/** 按日志行等级返回着色 class（info 默认前景色；DEBUG/未知用灰） */
function lineClass(line: string): string {
  const lv = parseLogLevel(line)
  if (lv === 'ERROR') return 'log-error'
  if (lv === 'WARN' || lv === 'WARNING') return 'log-warn'
  if (lv === 'DEBUG') return 'log-debug'
  return 'log-info'
}
function onFileChange(e: Event) { void selectLogFile((e.target as HTMLSelectElement).value) }
function onLevelFilterChange(e: Event) { levelFilter.value = (e.target as HTMLSelectElement).value }
function onKeywordInput(e: Event) { keyword.value = (e.target as HTMLInputElement).value }
</script>

<template>
  <div v-if="modelValue" class="modal-mask" @click.self="close">
    <div class="modal modal-wide log-modal">
      <div class="modal-title">系统日志</div>
      <div v-if="logsDir" class="env-hint">日志目录：{{ logsDir }}</div>

      <div class="log-toolbar">
        <select
          class="input log-file-select"
          :value="selectedLog"
          :disabled="!logFiles.length"
          @change="onFileChange"
        >
          <option v-if="!logFiles.length" value="">暂无日志文件</option>
          <option v-for="f in logFiles" :key="f.name" :value="f.name">{{ f.name }}</option>
        </select>
        <select class="input log-level-select" :value="levelFilter" @change="onLevelFilterChange">
          <option v-for="lv in LOG_LEVEL_FILTERS" :key="lv" :value="lv">{{ lv }}</option>
        </select>
        <input
          class="input log-keyword"
          type="text"
          placeholder="关键词过滤…"
          :value="keyword"
          @input="onKeywordInput"
        />
        <button class="btn-secondary-sm" @click="loadLogList">刷新</button>
        <button class="btn-secondary-sm" :disabled="!selectedLog || loading" @click="copyLog">复制</button>
        <button class="btn-secondary-sm" :disabled="!selectedLog || loading" @click="clearLog">清空</button>
      </div>

      <div class="log-view custom-scroll">
        <template v-if="loading">日志加载中…</template>
        <template v-else-if="loadError">读取失败：{{ loadError }}</template>
        <template v-else-if="!selectedLog">选择日志文件后在此查看（只读）</template>
        <template v-else-if="!filteredLines.length">无匹配日志行（调整级别或关键词）</template>
        <template v-else>
          <div v-for="(line, i) in filteredLines" :key="i" class="log-line" :class="lineClass(line)">{{ line }}</div>
        </template>
      </div>
      <div v-if="truncated" class="env-hint">文件较大，仅显示末尾 1MB 内容</div>
      <div v-if="actionMsg" class="env-hint">{{ actionMsg }}</div>

      <div class="modal-actions">
        <button class="btn-secondary-sm" @click="close">关闭</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* ── 弹窗容器（对齐项目 modal-mask/modal 惯例，见 VideoMontage.vue） ── */
.modal-mask {
  position: fixed; inset: 0; z-index: 1002; display: flex; align-items: center; justify-content: center;
  background: rgba(0,0,0,.7);
}
.modal {
  display: flex; flex-direction: column; gap: 12px; width: 440px; max-width: 90vw; max-height: 84vh;
  padding: 20px; background: var(--card); border: 1px solid var(--border); border-radius: var(--radius-lg);
}
.modal-wide { width: 920px; max-width: 94vw; }
.modal-title { font-size: 15px; font-weight: 600; }
.modal-actions { display: flex; justify-content: flex-end; gap: 8px; }

/* ── 日志工具栏 + 只读查看区（自 CardEnvMaint 迁入） ── */
.log-toolbar {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
}
.log-file-select { flex: 1 1 200px; min-width: 0; }
.log-level-select { flex: 0 0 auto; width: 96px; }
.log-keyword { flex: 1 1 140px; min-width: 0; }

.log-view {
  flex: 1 1 auto;
  min-height: 320px;
  max-height: 56vh;
  overflow-y: auto;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--surface-container);
  font-family: ui-monospace, Consolas, monospace;
  font-size: 12px;
  line-height: 1.7;
  color: var(--foreground);
  white-space: pre-wrap;
  word-break: break-all;
}
.log-line { display: block; }
.log-line.log-error { color: var(--error); }
.log-line.log-warn { color: var(--warning); }
.log-line.log-debug { color: var(--muted-foreground); }

.env-hint {
  padding: 8px 12px;
  border-radius: var(--radius-md);
  background: var(--surface-container);
  font-size: 12px;
  color: var(--primary);
}
</style>
