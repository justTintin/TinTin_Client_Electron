<script setup lang="ts">
// ═══════════════════════════════════════════════════════════════
// CardEnvMaint — 环境与维护卡（纯展示组件）
// 对齐原客户端「环境与维护」页（gui/main_window_pages.py L1892-1929
// 三个 Tab：系统日志 / 运行环境 / 系统配置(自启动)）：
//   · 系统日志入口：日志查看器已抽出为独立弹窗（LogViewerDialog），
//     本卡只保留「打开日志」按钮（2026-09-06 用户裁决）
//   · 系统配置：开机自启动开关（app.setLoginItemSettings，与托盘双向同步；
//     2026-08-30 自「系统与运行」卡迁入）
//   · 环境检测（条目⑪，行编组在 envCheckLogic，动作在 useEnvCheck）
//   · 日志级别设置保留
// 2026-08-30 用户裁决整改：删除「本地服务端」状态区块（统一服务端连通状态
// 由标题栏状态胶囊展示，不再重复）。
// 2026-08-30 闭环整改：「缓存清理」移入本地配置卡（与缓存目录同卡管理）。
// 业务动作经 emits 上抛容器接线到 useSettingsGeneral / useSettingsIntegration。
// ═══════════════════════════════════════════════════════════════

import { ref } from 'vue'
import type { EnvCheckRow } from '../../composables/envCheckLogic'

defineProps<{
  autoStart: boolean
  autoStartLoading: boolean
  logLevel: string
  envRows: EnvCheckRow[]
  envChecking: boolean
  downloadingServerLog: boolean
}>()

const emit = defineEmits<{
  (e: 'toggle-autostart', v: boolean): void
  (e: 'change-loglevel', v: string): void
  (e: 'run-env-check'): void
  (e: 'open-log'): void
  (e: 'download-server-log', opts: { date: string; kind: 'merged' | 'server' }): void
}>()

/** C-6 服务端失败日志下载：下载目标（客户端合并/服务端错误）与默认日期（今日） */
const downKind = ref<'merged' | 'server'>('merged')
const today = new Date().toISOString().slice(0, 10)

/** select 变更：原为 v-model + @change=saveLogLevel，此处合并为一个事件 */
function onLevelChange(e: Event) {
  emit('change-loglevel', (e.target as HTMLSelectElement).value)
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
      <!-- ── 系统日志入口（日志查看器已抽出为 LogViewerDialog 独立弹窗） ── -->
      <div class="setting-row">
        <div>
          <div class="setting-label">系统日志</div>
          <div class="setting-desc">打开独立窗口查看与过滤历史日志（复制 / 清空）</div>
        </div>
        <button class="btn-secondary-sm" @click="emit('open-log')">打开日志</button>
      </div>

      <!-- ── C-6 服务端失败日志下载（2026-09-06）：客户端错误自动上报后在此查看合并结果 ── -->
      <div class="setting-row">
        <div>
          <div class="setting-label">服务端失败日志</div>
          <div class="setting-desc">从服务端按天下载失败日志（客户端合并 / 服务端错误）；客户端运行错误已自动上报合并</div>
        </div>
        <div class="download-log-ctl">
          <select v-model="downKind" class="input w-40">
            <option value="merged">客户端合并</option>
            <option value="server">服务端错误</option>
          </select>
          <button class="btn-secondary-sm" :disabled="downloadingServerLog"
            @click="emit('download-server-log', { date: today, kind: downKind })">
            {{ downloadingServerLog ? '下载中…' : '下载日志' }}
          </button>
        </div>
      </div>

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

/* ─── C-6 服务端失败日志下载行控件 ─── */
.download-log-ctl {
  display: flex;
  align-items: center;
  gap: 8px;
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
