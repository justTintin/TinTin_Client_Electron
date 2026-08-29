<script setup lang="ts">
// ═══════════════════════════════════════════════════════════════
// CardSystem — 设置页「系统与运行」卡（S9，纯展示组件）
// 对齐原客户端 gui/main_window_pages.py：
//   · 自启动 L1931-1971：_on_autostart_toggled（注册表 Run 键，默认开启）→
//     新端 app.setLoginItemSettings（与托盘 tray.js 同通道一致，双向同步）
//   · 缓存目录 L1973-2039：local_config.cache_dir（outputs 目录可自定义）→
//     config 'local.cacheDir'（app 域）
//   · LUT 配置 L2041-2120：video_config 下 name → path 映射
//     （.cube/.3dl/.lut，智能混剪镜头重组时可选应用调色还原）→
//     config 'video.lutMap'（app 域；当前混剪链路未消费，配置先落地登记后置）
//   · 系统信息 L1622-1637：os/cpu/ram/gpu → 新端 env:detectEnv local
//     （os/cpu/ram/disk；gpu 弃检，见 env-detect.js 头注）
// 业务逻辑在 composables/useSettingsIntegration.ts，本组件只绘制 + 事件转发。
// ═══════════════════════════════════════════════════════════════

import type { LutEntry } from '../../composables/useSettingsIntegration'

const props = defineProps<{
  autoStart: boolean
  autoStartLoading: boolean
  cacheDir: string
  lutList: LutEntry[]
  sysInfoRows: Array<{ label: string; value: string }>
  sysInfoLoading: boolean
  hint: string
}>()

const emit = defineEmits<{
  (e: 'toggle-autostart', v: boolean): void
  (e: 'pick-cache-dir'): void
  (e: 'add-lut'): void
  (e: 'remove-lut', name: string): void
  (e: 'refresh-sysinfo'): void
}>()
</script>

<template>
  <section class="luo-card">
    <div class="luo-card-head">
      <div>
        <h2 class="luo-card-title">系统与运行</h2>
        <p class="luo-card-desc">开机自启、缓存目录、LUT 调色配置与本机系统信息。</p>
      </div>
    </div>

    <div class="setting-list">
      <!-- ── 自启动（app.setLoginItemSettings；与托盘菜单同通道）── -->
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

      <!-- ── 缓存目录改选（原 local_config.cache_dir）── -->
      <div class="setting-row">
        <div>
          <div class="setting-label">缓存目录</div>
          <div class="setting-desc">
            智能混剪、分割等生成的中间文件统一存放目录{{ cacheDir ? '' : '（未配置，使用默认 outputs 目录）' }}
          </div>
        </div>
        <div class="setting-row-right">
          <span v-if="cacheDir" class="cache-path" :title="cacheDir">{{ cacheDir }}</span>
          <button class="btn-secondary-sm" @click="emit('pick-cache-dir')">
            {{ cacheDir ? '更改' : '选择…' }}
          </button>
        </div>
      </div>

      <!-- ── LUT 配置（原 video_config：name → path 映射）── -->
      <div class="setting-row">
        <div>
          <div class="setting-label">LUT 调色文件</div>
          <div class="setting-desc">
            各相机/风格的 LUT 还原文件（.cube / .3dl / .lut），智能混剪镜头重组时可选择应用；
            当前混剪链路暂未消费，配置先行落地（登记后置）
          </div>
        </div>
        <button class="btn-secondary-sm" @click="emit('add-lut')">添加 LUT 文件</button>
      </div>
      <div v-if="lutList.length" class="lut-list">
        <div v-for="e in lutList" :key="e.name" class="lut-item">
          <span class="lut-name">{{ e.name }}</span>
          <span class="lut-path" :title="e.path">{{ e.path }}</span>
          <button class="btn-ghost-sm danger-sm" @click="emit('remove-lut', e.name)">删除</button>
        </div>
      </div>
      <div v-else class="env-hint">暂无 LUT 配置，点击「添加 LUT 文件」导入调色文件</div>

      <!-- ── 系统信息（env:detectEnv local：os/cpu/ram/disk）── -->
      <div class="setting-row">
        <div>
          <div class="setting-label">系统信息</div>
          <div class="setting-desc">本机操作系统 / 处理器 / 内存 / 磁盘（数据源 env:detectEnv）</div>
        </div>
        <button class="btn-secondary-sm" :disabled="sysInfoLoading" @click="emit('refresh-sysinfo')">
          {{ sysInfoLoading ? '检测中…' : '刷新' }}
        </button>
      </div>
      <div v-if="sysInfoRows.length" class="sysinfo-list">
        <div v-for="row in sysInfoRows" :key="row.label" class="sysinfo-row">
          <span class="sysinfo-label">{{ row.label }}</span>
          <span class="sysinfo-value" :title="row.value">{{ row.value }}</span>
        </div>
      </div>

      <div v-if="hint" class="env-hint">{{ hint }}</div>
    </div>
  </section>
</template>

<style scoped>
/* 缓存目录路径（monospace 截断） */
.cache-path {
  max-width: 260px;
  font-family: ui-monospace, Consolas, monospace;
  font-size: 12px;
  color: var(--muted-foreground);
  background: var(--surface-container);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 6px 10px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* LUT 列表（对齐原 _load_lut_config 列表语义：name → path 行） */
.lut-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--surface-container);
}
.lut-item {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-width: 0;
}
.lut-name { flex: 0 0 auto; font-size: 12px; font-weight: 600; color: var(--foreground); }
.lut-path {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 12px;
  color: var(--muted-foreground);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.danger-sm { color: var(--error); }
.danger-sm:hover { color: var(--error); background: var(--error-container); }

/* 系统信息行 */
.sysinfo-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--surface-container);
}
.sysinfo-row { display: flex; align-items: center; gap: var(--space-3); min-width: 0; }
.sysinfo-label { flex: 0 0 110px; font-size: 12px; font-weight: 600; color: var(--foreground); }
.sysinfo-value {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 12px;
  color: var(--muted-foreground);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.env-hint {
  margin-top: var(--space-2);
  padding: 8px 12px;
  border-radius: var(--radius-md);
  background: var(--surface-container);
  font-size: 12px;
  color: var(--primary);
}
</style>
