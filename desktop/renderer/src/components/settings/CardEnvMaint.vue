<script setup lang="ts">
// ═══════════════════════════════════════════════════════════════
// CardEnvMaint — 环境与维护卡（服务状态、日志与存储管理，纯展示组件）
// 模板自 Settings.vue L541-580 原样迁出（IRON-08）；
// 业务动作经 emits 上抛容器接线到 useSettingsGeneral。
// 条目⑪：新增「环境检测」区——原客户端 env_config_page.py L412-513 为
// Python 依赖矩阵，新端口径重定义（服务端连通/能力健康/本地资源），
// 行编组在 envCheckLogic（纯函数），检测动作在 useEnvCheck。
// 2026-08-28 对齐原客户端（无「重启服务端」概念，见
// docs/BUSINESS_ALIGNMENT_移植业务对齐清单_2026-08-28.md §四）：
//   · 删除「重启服务」按钮；服务状态行保留状态点 + 描述
//   · 新增「日志」区块：客户端日志文件列表（新→旧）+ 逐行打开 + 刷新
//     （主进程 %APPDATA%/logs/client-YYYYMMDD.log，env:logList / env:openLog）
// ═══════════════════════════════════════════════════════════════

import type { LogFileInfo } from '../../composables/useSettingsGeneral'
import type { EnvCheckRow } from '../../composables/envCheckLogic'

defineProps<{
  serverRunning: boolean
  serverDesc: string
  logLevel: string
  cacheClearing: boolean
  actionHint: string
  envRows: EnvCheckRow[]
  envChecking: boolean
  logFiles: LogFileInfo[]
  logsDir: string
}>()

const emit = defineEmits<{
  (e: 'change-loglevel', v: string): void
  (e: 'clear'): void
  (e: 'run-env-check'): void
  (e: 'refresh-logs'): void
  (e: 'open-log', name: string): void
}>()

/** select 变更：原为 v-model + @change=saveLogLevel，此处合并为一个事件 */
function onLevelChange(e: Event) {
  emit('change-loglevel', (e.target as HTMLSelectElement).value)
}

/** 日志文件大小展示（KB 级足够） */
function fmtSize(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`
}

/** 日志文件时间展示（本地时区，到分钟） */
function fmtTime(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
</script>

<template>
  <section class="luo-card">
    <div class="luo-card-head">
      <div>
        <h2 class="luo-card-title">环境与维护</h2>
        <p class="luo-card-desc">服务状态、日志与存储管理。</p>
      </div>
    </div>
    <div class="setting-list">
      <div class="setting-row">
        <div class="server-cell">
          <span class="status-dot" :class="serverRunning ? 'ok' : 'down'"></span>
          <div>
            <div class="setting-label">本地服务端</div>
            <div class="setting-desc">{{ serverDesc }}</div>
          </div>
        </div>
      </div>
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
      <div class="setting-row">
        <div>
          <div class="setting-label">缓存清理</div>
          <div class="setting-desc">释放临时文件与预览缓存占用的空间</div>
        </div>
        <button class="btn-secondary-sm" :disabled="cacheClearing" @click="emit('clear')">{{ cacheClearing ? '清理中…' : '立即清理' }}</button>
      </div>

      <!-- 日志区块（对齐原客户端日志查看页）：文件列表 + 逐行打开 + 刷新 -->
      <div class="setting-row">
        <div>
          <div class="setting-label">日志</div>
          <div class="setting-desc">客户端运行日志{{ logsDir ? ` · ${logsDir}` : '' }}</div>
        </div>
        <button class="btn-secondary-sm" @click="emit('refresh-logs')">刷新</button>
      </div>
      <div v-if="logFiles.length" class="env-rows">
        <div v-for="f in logFiles" :key="f.name" class="env-row">
          <span class="env-dot ok" />
          <span class="env-row-label">{{ f.name }}</span>
          <span class="env-row-detail" :title="`${fmtSize(f.sizeBytes)} · ${fmtTime(f.mtimeMs)}`">
            {{ fmtSize(f.sizeBytes) }} · {{ fmtTime(f.mtimeMs) }}
          </span>
          <button class="btn-secondary-sm log-open" @click="emit('open-log', f.name)">打开</button>
        </div>
      </div>
      <div v-else class="env-hint">暂无日志文件（应用运行关键事件会写入 logs 目录，点击「刷新」重新加载）</div>

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

      <div v-if="actionHint" class="env-hint">{{ actionHint }}</div>
    </div>
  </section>
</template>

<style scoped>
/* 环境与维护：服务状态 + 日志级别 + 缓存清理（仅本卡使用，随卡迁出） */
.status-dot {
  flex: 0 0 auto;
  width: 8px;
  height: 8px;
  border-radius: var(--radius-full);
  background: var(--muted-foreground);
}
.status-dot.ok   { background: var(--success); box-shadow: 0 0 0 3px rgba(16, 185, 129, 0.18); }
.status-dot.down { background: var(--error);   box-shadow: 0 0 0 3px rgba(239, 68, 68, 0.18); }

.server-cell {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}
.w-40 { width: 160px; }

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

/* 日志行「打开」按钮：不随 ellipsis 挤压 */
.log-open {
  flex: 0 0 auto;
}
</style>
