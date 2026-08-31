<script setup lang="ts">
// ═══════════════════════════════════════════════════════════════
// CardEnvMaint — 环境与维护卡（纯展示组件）
// 对齐原客户端「环境与维护」页（gui/main_window_pages.py L1892-1929
// 三个 Tab：系统日志 / 运行环境 / 系统配置(自启动)）：
//   · 系统日志（L1563-1620 完整移植）：日志文件下拉（新→旧）+ 级别过滤 +
//     关键词过滤 + 只读文本区展示（env:logList/logRead）；
//     2026-08-31 用户反馈：不再用外部软件打开，改为内置复制/清空
//     （env:copyText / env:logClear，对齐原客户端日志查看页能力）
//   · 系统配置：开机自启动开关（app.setLoginItemSettings，与托盘双向同步；
//     2026-08-30 自「系统与运行」卡迁入）
//   · 环境检测（条目⑪，行编组在 envCheckLogic，动作在 useEnvCheck）
//   · 日志级别设置保留
// 2026-08-30 用户裁决整改：删除「本地服务端」状态区块（统一服务端连通状态
// 由标题栏状态胶囊展示，不再重复）；日志查看器对齐原客户端（可过滤）。
// 2026-08-30 闭环整改：「缓存清理」移入本地配置卡（与缓存目录同卡管理）。
// 业务动作经 emits 上抛容器接线到 useSettingsGeneral / useLogViewer /
// useSettingsIntegration。
// ═══════════════════════════════════════════════════════════════

import type { LogFileInfo } from '../../composables/useLogViewer'
import type { EnvCheckRow } from '../../composables/envCheckLogic'

defineProps<{
  autoStart: boolean
  autoStartLoading: boolean
  logLevel: string
  envRows: EnvCheckRow[]
  envChecking: boolean
  // 日志查看器（useLogViewer 状态）
  logFiles: LogFileInfo[]
  logsDir: string
  selectedLog: string
  levelFilter: string
  levelFilters: readonly string[]
  keyword: string
  filteredLines: string[]
  logLoading: boolean
  logTruncated: boolean
  logError: string
  /** 复制/清空操作结果提示（短暂展示） */
  logActionMsg: string
}>()

const emit = defineEmits<{
  (e: 'toggle-autostart', v: boolean): void
  (e: 'change-loglevel', v: string): void
  (e: 'run-env-check'): void
  (e: 'refresh-logs'): void
  (e: 'select-log', name: string): void
  (e: 'change-level-filter', v: string): void
  (e: 'change-keyword', v: string): void
  (e: 'copy-log'): void
  (e: 'clear-log'): void
}>()

/** select 变更：原为 v-model + @change=saveLogLevel，此处合并为一个事件 */
function onLevelChange(e: Event) {
  emit('change-loglevel', (e.target as HTMLSelectElement).value)
}
function onFileChange(e: Event) {
  emit('select-log', (e.target as HTMLSelectElement).value)
}
function onLevelFilterChange(e: Event) {
  emit('change-level-filter', (e.target as HTMLSelectElement).value)
}
function onKeywordInput(e: Event) {
  emit('change-keyword', (e.target as HTMLInputElement).value)
}
</script>

<template>
  <section class="luo-card">
    <div class="luo-card-head">
      <div>
        <h2 class="luo-card-title">环境与维护</h2>
        <p class="luo-card-desc">系统日志、运行环境与系统配置（自启动）。</p>
      </div>
    </div>
    <div class="setting-list">
      <!-- ── 系统日志（对齐原客户端日志查看页：文件下拉 + 级别/关键词过滤 + 只读文本区） ── -->
      <div class="setting-row">
        <div>
          <div class="setting-label">系统日志</div>
          <div class="setting-desc">历史日志查看与过滤{{ logsDir ? ` · ${logsDir}` : '' }}</div>
        </div>
        <button class="btn-secondary-sm" @click="emit('refresh-logs')">刷新</button>
      </div>

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
          <option v-for="lv in levelFilters" :key="lv" :value="lv">{{ lv }}</option>
        </select>
        <input
          class="input log-keyword"
          type="text"
          placeholder="关键词过滤…"
          :value="keyword"
          @input="onKeywordInput"
        />
        <button class="btn-secondary-sm" :disabled="!selectedLog || logLoading" @click="emit('copy-log')">复制</button>
        <button class="btn-secondary-sm" :disabled="!selectedLog || logLoading" @click="emit('clear-log')">清空</button>
      </div>

      <div class="log-view custom-scroll">
        <template v-if="logLoading">日志加载中…</template>
        <template v-else-if="logError">读取失败：{{ logError }}</template>
        <template v-else-if="!selectedLog">选择日志文件后在此查看（只读）</template>
        <template v-else-if="!filteredLines.length">无匹配日志行（调整级别或关键词）</template>
        <template v-else>
          <div v-for="(line, i) in filteredLines" :key="i" class="log-line">{{ line }}</div>
        </template>
      </div>
      <div v-if="logTruncated" class="env-hint">文件较大，仅显示末尾 1MB 内容</div>
      <div v-if="logActionMsg" class="env-hint">{{ logActionMsg }}</div>

      <!-- ── 系统配置：开机自启动（对齐原客户端「系统配置」Tab；与托盘菜单双向一致） ── -->
      <div class="setting-row">
        <div>
          <div class="setting-label">开机自动运行</div>
          <div class="setting-desc">
            登录 Windows 后自动启动本程序（写入系统登录项；托盘菜单开关与此处双向一致）
          </div>
        </div>
        <button
          class="switch"
          :class="{ on: autoStart }"
          role="switch"
          :aria-checked="autoStart"
          :disabled="autoStartLoading"
          @click="emit('toggle-autostart', !autoStart)"
        ><span class="knob" /></button>
      </div>

      <!-- ── 日志级别（输出详细程度设置） ── -->
      <div class="setting-row">
        <div>
          <div class="setting-label">日志级别</div>
          <div class="setting-desc">控制台与日志文件输出详细程度</div>
        </div>
        <select :value="logLevel" class="input w-40" @change="onLevelChange">
          <option>INFO</option>
          <option>DEBUG</option>
          <option>WARNING</option>
        </select>
      </div>

      <!-- 条目⑪ 环境检测（口径重定义：服务端连通/能力健康 + 本地资源轻量项） -->
      <div class="setting-row">
        <div>
          <div class="setting-label">环境检测</div>
          <div class="setting-desc">服务端连通 · 功能能力健康 · FFmpeg · 磁盘空间 · 系统资源</div>
        </div>
        <button class="btn-secondary-sm" :disabled="envChecking" @click="emit('run-env-check')">
          {{ envChecking ? '检测中…' : (envRows.length ? '重新检测' : '开始检测') }}
        </button>
      </div>
      <div v-if="envRows.length" class="env-rows">
        <div v-for="row in envRows" :key="row.label" class="env-row">
          <span class="env-dot" :class="row.state" />
          <span class="env-row-label">{{ row.label }}</span>
          <span class="env-row-detail" :title="row.detail">{{ row.detail }}</span>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.w-40 { width: 160px; }

/* ── 日志查看器（对齐原客户端日志查看页交互） ── */
.log-toolbar {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
}
.log-file-select {
  flex: 1 1 200px;
  min-width: 0;
}
.log-level-select {
  flex: 0 0 auto;
  width: 96px;
}
.log-keyword {
  flex: 1 1 140px;
  min-width: 0;
}

.log-view {
  max-height: 320px;
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

.env-hint {
  margin-top: var(--space-2);
  padding: 8px 12px;
  border-radius: var(--radius-md);
  background: var(--surface-container);
  font-size: 12px;
  color: var(--primary);
}

/* ─── 条目⑪ 环境检测结果行 ─── */
.env-rows {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--surface-container);
}
.env-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-width: 0;
}
.env-dot {
  flex: 0 0 auto;
  width: 8px;
  height: 8px;
  border-radius: var(--radius-full);
  background: var(--muted-foreground);
}
.env-dot.ok      { background: var(--success); }
.env-dot.warn    { background: #f59e0b; }
.env-dot.bad     { background: var(--error); }
.env-dot.unknown { background: var(--muted-foreground); }
.env-row-label {
  flex: 0 0 auto;
  font-size: 12px;
  font-weight: 600;
  color: var(--foreground);
}
.env-row-detail {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 12px;
  color: var(--muted-foreground);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
