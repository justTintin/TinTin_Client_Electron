<script setup lang="ts">
// ═══════════════════════════════════════════════════════════════
// CardEnvMaint — 环境与维护卡（服务状态、日志与存储管理，纯展示组件）
// 模板自 Settings.vue L541-580 原样迁出（IRON-08）；
// 业务动作经 emits 上抛容器接线到 useSettingsGeneral。
// ═══════════════════════════════════════════════════════════════

defineProps<{
  serverRunning: boolean
  serverDesc: string
  serverBusy: boolean
  logLevel: string
  cacheClearing: boolean
  actionHint: string
}>()

const emit = defineEmits<{
  (e: 'restart'): void
  (e: 'change-loglevel', v: string): void
  (e: 'clear'): void
}>()

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
        <button class="btn-secondary-sm" @click="emit('restart')">{{ serverBusy ? '重启中…' : '重启服务' }}</button>
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
</style>
