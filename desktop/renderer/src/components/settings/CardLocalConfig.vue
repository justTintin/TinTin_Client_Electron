<script setup lang="ts">
// ═══════════════════════════════════════════════════════════════
// CardLocalConfig — 本地配置卡（纯展示组件）
// 对齐原客户端「本地配置」页（gui/main_window_pages.py L1973-2039）：
//   · 缓存目录：local_config.cache_dir（outputs 目录可自定义，浏览选择后
//     持久化）→ config 'local.cacheDir'（app 域）
//   · LUT 调色文件（2026-08-30 用户裁决迁入本地配置；原客户端在视频配置
//     Tab L2041-2120）：video_config 下 name → path 映射（.cube/.3dl/.lut，
//     智能混剪镜头重组时可选应用调色还原）→ config 'video.lutMap'（app 域）
// 2026-08-30 用户裁决整改：删除「数据目录/字体/代理」占位（原客户端无此项，
// 且原实现为硬编码只读展示，不可切换）。
// 2026-08-30 闭环整改：「缓存清理」自环境与维护卡迁入（与缓存目录同卡管理，
// env:clearCache → session.defaultSession.clearCache）。
// 业务逻辑在 composables/useSettingsIntegration.ts，本组件只绘制 + 事件转发。
// ═══════════════════════════════════════════════════════════════

import type { LutEntry } from '../../composables/useSettingsIntegration'

defineProps<{
  cacheDir: string
  cacheDirIsDefault: boolean
  lutList: LutEntry[]
  hint: string
  cacheClearing: boolean
  clearHint: string
}>()

const emit = defineEmits<{
  (e: 'pick-cache-dir'): void
  (e: 'add-lut'): void
  (e: 'remove-lut', name: string): void
  (e: 'clear'): void
}>()
</script>

<template>
  <section class="luo-card">
    <div class="luo-card-head">
      <div>
        <h2 class="luo-card-title">本地配置</h2>
        <p class="luo-card-desc">缓存目录与 LUT 调色文件。</p>
      </div>
    </div>

    <div class="setting-list">
      <!-- ── 缓存目录（原 local_config.cache_dir；浏览选择后持久化生效） ── -->
      <div class="setting-row">
        <div>
          <div class="setting-label">缓存目录</div>
          <div class="setting-desc">
            智能混剪、分割等生成的中间文件统一存放目录{{ cacheDirIsDefault ? '（当前为默认 outputs 目录）' : '' }}
          </div>
        </div>
        <div class="setting-row-right">
          <span v-if="cacheDir" class="cache-path" :class="{ 'is-default': cacheDirIsDefault }" :title="cacheDir">{{ cacheDir }}</span>
          <button class="btn-secondary-sm" @click="emit('pick-cache-dir')">
            {{ cacheDir ? '更改' : '浏览…' }}
          </button>
        </div>
      </div>

      <!-- ── 缓存清理（与缓存目录同卡管理；env:clearCache → 清 Electron 会话缓存） ── -->
      <div class="setting-row">
        <div>
          <div class="setting-label">缓存清理</div>
          <div class="setting-desc">释放临时文件与预览缓存占用的空间（下载结果默认存于上方缓存目录）</div>
        </div>
        <button class="btn-secondary-sm" :disabled="cacheClearing" @click="emit('clear')">
          {{ cacheClearing ? '清理中…' : '立即清理' }}
        </button>
      </div>

      <!-- ── LUT 调色文件（原 video_config：name → path 映射） ── -->
      <div class="setting-row">
        <div>
          <div class="setting-label">LUT 调色文件</div>
          <div class="setting-desc">
            各相机/风格的 LUT 还原文件（.cube / .3dl / .lut），智能混剪镜头重组时可选择应用
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

      <div v-if="hint || clearHint" class="env-hint">{{ hint || clearHint }}</div>
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
.cache-path.is-default {
  color: var(--foreground-muted);
  border-style: dashed;
  opacity: 0.75;
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

.env-hint {
  margin-top: var(--space-2);
  padding: 8px 12px;
  border-radius: var(--radius-md);
  background: var(--surface-container);
  font-size: 12px;
  color: var(--primary);
}
</style>
