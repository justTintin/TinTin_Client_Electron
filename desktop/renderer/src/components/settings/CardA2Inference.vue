<script setup lang="ts">
// ═══════════════════════════════════════════════════════════════
// CardA2Inference — 扩展插件·A2 本地推理能力卡（§1.5.4 规格）
// 模板自 Settings.vue L582-700 原样迁出（IRON-08）；
// 组件内自行调用 composables/useInferenceSettings（props 不传大对象），
// 经 defineExpose 暴露 refreshA2 / attachDownloadBus，
// 由容器 Settings.vue 在 onMounted 触发初次加载、onBeforeUnmount 停止轮询。
// ═══════════════════════════════════════════════════════════════

import { useInferenceSettings, bytesToMB, type PkgRow } from '../../composables/useInferenceSettings'

const {
  currentMode,
  capability,
  pkgList,
  a2Busy,
  lastError,
  totalSizeMB,
  MODE_TABS,
  LOCAL_INFERENCE_AVAILABLE,
  statusSummary,
  refreshA2,
  setMode,
  actOnPkg: _actOnPkg,
  attachDownloadBus,
} = useInferenceSettings()

// 2026-09-04 用户裁决：仅服务端推理可用，能力概览与模型下载列表随本地推理一并隐藏
const localInferenceAvailable = LOCAL_INFERENCE_AVAILABLE

/** 供模板调用的包装：保持原模板 @click 签名 */
function actOnPkg(row: PkgRow, action: 'download' | 'cancel' | 'uninstall') {
  void _actOnPkg(row, action)
}

/** 容器生命周期编排入口：初始加载 + 下载进度轮询启停 */
defineExpose({
  refreshA2,
  attachDownloadBus,
})
</script>

<template>
  <section class="luo-card a2-card">
    <div class="luo-card-head">
      <div>
        <h2 class="luo-card-title">本地推理能力</h2>
        <p class="luo-card-desc">
          当前版本仅支持服务端推理：所有 OCR / 向量检索 / 封面合成走服务端 HTTP。
          本地推理能力（模型下载后断网可用、数据不出本机）将在后续版本开放。
        </p>
      </div>
      <div class="a2-status-chip" :class="currentMode">
        <span class="dot" />
        {{ statusSummary() }}
      </div>
    </div>

    <!-- 推理模式分段控件（3 档）-->
    <div class="a2-mode-section">
      <div class="a2-section-label">推理模式</div>
      <div class="segmented">
        <button
          v-for="m in MODE_TABS"
          :key="m.value"
          class="seg-item"
          :class="{ active: currentMode === m.value, disabled: a2Busy || !m.enabled }"
          :disabled="a2Busy || !m.enabled"
          :title="m.enabled ? undefined : '暂未开放，当前版本仅支持服务端推理'"
          @click="setMode(m.value)"
        >{{ m.label }}</button>
      </div>
      <p class="a2-mode-hint">
        {{ MODE_TABS.find(x => x.value === currentMode)?.hint }}
      </p>
    </div>

    <!-- 能力概览 + 模型/扩展包（本地推理未开放时整块隐藏，2026-09-04 用户裁决） -->
    <template v-if="localInferenceAvailable">
    <div class="a2-grid-metrics">
      <div class="a2-metric">
        <div class="a2-m-k">原生模块</div>
        <div class="a2-m-v"><span :class="capability?.nativeModulesOk ? 'ok' : 'no'">{{ capability?.nativeModulesOk ? '就绪' : '未加载' }}</span></div>
      </div>
      <div class="a2-metric">
        <div class="a2-m-k">模型文件</div>
        <div class="a2-m-v"><span :class="capability?.modelsOk ? 'ok' : 'no'">{{ capability?.modelsOk ? '完整' : '缺失' }}</span></div>
      </div>
      <div class="a2-metric">
        <div class="a2-m-k">本地平均耗时</div>
        <div class="a2-m-v">{{ capability?.avgLocalMs ? capability.avgLocalMs.toFixed(0) + ' ms' : '—' }}</div>
      </div>
      <div class="a2-metric">
        <div class="a2-m-k">清单版本</div>
        <div class="a2-m-v mono">{{ capability?.manifestVersion || '—' }}</div>
      </div>
    </div>

    <!-- 模型包列表 -->
    <div class="a2-pkg-title">模型 / 扩展包</div>
    <div class="a2-pkg-list">
      <div v-for="p in pkgList" :key="p.id" class="a2-pkg-row">
        <div class="pkg-main">
          <div class="pkg-row-head">
            <div class="pkg-name">{{ p.label }}</div>
            <div class="pkg-size">≈ {{ p.totalSizeMB }} MB</div>
          </div>
          <div class="pkg-desc">{{ p.desc }}</div>
          <div class="pkg-files">
            <span v-for="f in p.files.slice(0, 3)" :key="f.name" class="pkg-chip">
              {{ f.name }}
              <em>{{ bytesToMB(f.size) }} MB</em>
            </span>
            <span v-if="p.files.length > 3" class="pkg-chip more">+{{ p.files.length - 3 }} 更多</span>
          </div>
          <div v-if="p.status === 'DOWNLOADING' && p.progress !== undefined" class="pkg-prog">
            <div class="pkg-prog-bar"><div class="pkg-prog-fill" :style="{ width: p.progress + '%' }" /></div>
            <div class="pkg-prog-num">{{ p.progress }}%</div>
          </div>
        </div>
        <div class="pkg-actions">
          <template v-if="p.status === 'INSTALLED'">
            <span class="pkg-status ok">✓ 已安装</span>
            <button class="btn-secondary-sm danger" @click="actOnPkg(p, 'uninstall')" :disabled="a2Busy">卸载</button>
          </template>
          <template v-else-if="p.status === 'DOWNLOADING'">
            <span class="pkg-status pending">下载中</span>
            <button class="btn-secondary-sm" @click="actOnPkg(p, 'cancel')" :disabled="a2Busy">取消</button>
          </template>
          <template v-else-if="p.status === 'SKIPPED'">
            <span class="pkg-status muted">当前平台跳过</span>
          </template>
          <template v-else>
            <span class="pkg-status muted">未下载</span>
            <button class="btn-primary-sm" @click="actOnPkg(p, 'download')" :disabled="a2Busy">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
              下载
            </button>
          </template>
        </div>
      </div>
    </div>
    </template>
    <div v-if="lastError" class="a2-error">{{ lastError }}</div>

    <!-- 脚注：不阻塞 / 自动降级说明 -->
    <div class="a2-footnote">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <circle cx="12" cy="12" r="10" />
        <line x1="12" y1="16" x2="12" y2="12" />
        <line x1="12" y1="8" x2="12.01" y2="8" />
      </svg>
      本地能力缺失或异常时，OCR / 向量 / 封面制作会自动降级到服务端 HTTP，用户零感知；绝不会因为模型未下载而导致功能不可用。
    </div>
  </section>
</template>

<style scoped>
/* ═══════════════════════════════════════════════════════════════
   A2 · 本地推理能力卡片（§1.5.4 规格，原 Settings.vue L1481-1643 迁出）
   ═══════════════════════════════════════════════════════════════ */
.a2-card .luo-card-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-4);
}

.a2-status-chip {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--surface-container);
  color: var(--muted-foreground);
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
  max-width: 50%;
}
.a2-status-chip .dot {
  width: 8px; height: 8px; border-radius: 50%;
  background: var(--muted-foreground);
  box-shadow: 0 0 0 3px rgba(148,163,184,0.15);
}
.a2-status-chip.server-only    { color: var(--warning); border-color: rgba(245, 158, 11, 0.25); background: var(--warning-container); }
.a2-status-chip.server-only .dot  { background: var(--warning); box-shadow: 0 0 0 3px rgba(245,158,11,0.18); }
.a2-status-chip.hybrid-auto    { color: var(--primary); border-color: rgba(59,130,246,0.25); background: var(--primary-container); }
.a2-status-chip.hybrid-auto .dot  { background: var(--primary); box-shadow: 0 0 0 3px rgba(59,130,246,0.18); }
.a2-status-chip.force-local    { color: var(--success); border-color: rgba(16,185,129,0.25); background: var(--success-container); }
.a2-status-chip.force-local .dot  { background: var(--success); box-shadow: 0 0 0 3px rgba(16,185,129,0.18); }

.a2-mode-section { margin-bottom: var(--space-5); }
.a2-section-label {
  font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase;
  font-weight: 700; color: var(--muted-foreground); margin-bottom: var(--space-2);
}
.a2-mode-hint {
  margin: var(--space-2) 0 0;
  font-size: 13px; color: var(--muted-foreground); line-height: 1.55;
}

/* 4 指标网格 */
.a2-grid-metrics {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: var(--space-3);
  margin-bottom: var(--space-5);
}
.a2-metric {
  padding: var(--space-4);
  background: var(--surface-container);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
}
.a2-m-k {
  font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase;
  color: var(--muted-foreground); font-weight: 600;
}
.a2-m-v { margin-top: 6px; font-size: 15px; font-weight: 700; color: var(--foreground); }
.a2-m-v .ok { color: var(--success); }
.a2-m-v .no { color: var(--error); }
.a2-m-v .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; }

/* 模型包列表 */
.a2-pkg-title {
  font-size: 13px; font-weight: 700; color: var(--foreground);
  margin-bottom: var(--space-2);
}
.a2-pkg-list {
  display: flex; flex-direction: column; gap: var(--space-2);
  margin-bottom: var(--space-4);
}
.a2-pkg-row {
  display: flex; align-items: stretch; gap: var(--space-4);
  padding: var(--space-4);
  background: var(--surface-container);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  transition: border-color var(--duration-fast);
}
.a2-pkg-row:hover { border-color: var(--primary); }

.pkg-main { flex: 1 1 auto; min-width: 0; }
.pkg-row-head {
  display: flex; align-items: baseline; justify-content: space-between;
  gap: var(--space-2); margin-bottom: 4px;
}
.pkg-name { font-size: 14px; font-weight: 700; color: var(--foreground); }
.pkg-size { font-size: 12px; font-weight: 600; color: var(--muted-foreground); }
.pkg-desc { font-size: 13px; color: var(--muted-foreground); line-height: 1.5; margin-bottom: var(--space-2); }
.pkg-files { display: flex; flex-wrap: wrap; gap: 6px; }
.pkg-chip {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 3px 10px;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 999px;
  font-size: 11px; font-weight: 500; color: var(--muted-foreground);
}
.pkg-chip em {
  font-style: normal;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  opacity: 0.7;
}
.pkg-chip.more { background: var(--surface-container-high); }

.pkg-prog {
  display: flex; align-items: center; gap: var(--space-2);
  margin-top: var(--space-2);
}
.pkg-prog-bar {
  flex: 1 1 auto; height: 6px;
  background: var(--surface-container-high);
  border-radius: 999px; overflow: hidden;
}
.pkg-prog-fill {
  height: 100%; width: 0;
  background: linear-gradient(90deg, var(--primary), var(--tertiary));
  transition: width 0.25s ease;
}
.pkg-prog-num {
  flex: 0 0 auto; font-size: 12px; font-weight: 700;
  font-variant-numeric: tabular-nums; color: var(--primary);
  width: 44px; text-align: right;
}

.pkg-actions {
  flex: 0 0 auto;
  display: inline-flex; flex-direction: column; align-items: flex-end;
  justify-content: center; gap: 8px;
  min-width: 140px;
}
.pkg-status {
  font-size: 12px; font-weight: 600;
}
.pkg-status.ok    { color: var(--success); }
.pkg-status.pending { color: var(--primary); }
.pkg-status.muted { color: var(--muted-foreground); }

.a2-error {
  margin-top: var(--space-3);
  padding: 10px 14px;
  background: var(--error-container);
  border: 1px solid rgba(239, 68, 68, 0.25);
  color: var(--error);
  border-radius: var(--radius-lg);
  font-size: 13px; line-height: 1.5;
}

.a2-footnote {
  margin-top: var(--space-4);
  display: flex; align-items: flex-start; gap: 8px;
  padding: var(--space-3) var(--space-4);
  background: var(--surface-container);
  border: 1px dashed var(--border);
  border-radius: var(--radius-lg);
  font-size: 12px; line-height: 1.6;
  color: var(--muted-foreground);
}
.a2-footnote svg { flex: 0 0 auto; margin-top: 1px; color: var(--warning); }

/* A2 卡响应式 */
@media (max-width: 900px) {
  .a2-grid-metrics { grid-template-columns: repeat(2, 1fr); }
}

@media (max-width: 560px) {
  .a2-grid-metrics { grid-template-columns: 1fr 1fr; }
  .a2-pkg-row { flex-direction: column; gap: var(--space-3); }
  .pkg-actions { flex-direction: row; justify-content: space-between; align-items: center; min-width: 0; }
  .a2-status-chip { max-width: 100%; }
}
</style>
