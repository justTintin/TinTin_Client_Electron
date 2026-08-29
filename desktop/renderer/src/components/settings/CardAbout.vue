<script setup lang="ts">
// ═══════════════════════════════════════════════════════════════
// CardAbout — 关于卡（版本信息，纯展示组件）
// 模板自 Settings.vue L820-854 原样迁出（IRON-08）；
// appVersion/buildDate/channel 由容器组装后以 props 传入。
// 2026-08-28：新增本机机器码展示（SHA256 前 16 位大写分组，
// XXXX-XXXX-XXXX-XXXX）+「复制」按钮；机器码由容器经
// useSettingsGeneral.loadMachineCode 加载（主进程原始信息 +
// 渲染层纯函数 machineCodeLogic 摘要）。
// ═══════════════════════════════════════════════════════════════

import { ref } from 'vue'

defineProps<{
  appVersion: string
  buildDate: string
  channel: string
  machineCode: string
}>()

/* 复制按钮：UI 动作（写入剪贴板 + 1.2s 反馈），无业务逻辑 */
const copied = ref(false)
async function copyMachineCode(code: string) {
  try { await navigator.clipboard.writeText(code) } catch (_) { return }
  copied.value = true
  setTimeout(() => { copied.value = false }, 1200)
}
</script>

<template>
  <section class="luo-card about">
    <div class="luo-card-head">
      <div>
        <h2 class="luo-card-title">关于</h2>
        <p class="luo-card-desc">客户端组件版本、更新频道与开源许可信息。</p>
      </div>
    </div>

    <div class="about-grid">
      <div class="about-item">
        <div class="about-k">客户端版本</div>
        <div class="about-v">{{ appVersion }}</div>
      </div>
      <div class="about-item">
        <div class="about-k">组件版本</div>
        <div class="about-v">组件库 @luosiding/ui 0.9.3</div>
      </div>
      <div class="about-item">
        <div class="about-k">构建时间</div>
        <div class="about-v">{{ buildDate }}</div>
      </div>
      <div class="about-item">
        <div class="about-k">更新频道</div>
        <div class="about-v">
          <span class="channel-tag">{{ channel }}</span>
        </div>
      </div>
    </div>

    <!-- 本机机器码（纯展示 + 复制；由容器加载 machineCode prop） -->
    <div class="machine-row">
      <div class="about-k">本机机器码</div>
      <div class="machine-line">
        <span class="machine-code" :title="machineCode || '加载中…'">{{ machineCode || '—' }}</span>
        <button
          class="btn-secondary-sm"
          :disabled="!machineCode"
          :title="machineCode ? '复制机器码' : '加载中'"
          @click="copyMachineCode(machineCode)"
        >
          {{ copied ? '已复制' : '复制' }}
        </button>
      </div>
    </div>

    <div class="about-actions">
      <button class="btn-secondary-sm">检查更新</button>
      <button class="btn-ghost-sm">开源许可协议</button>
    </div>
  </section>
</template>

<style scoped>
/* 关于（仅本卡使用，随卡迁出） */
.about-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-3);
  margin-bottom: var(--space-5);
}

.about-item {
  padding: var(--space-4);
  background: var(--surface-container);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
}
.about-k {
  font-size: 11px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--muted-foreground);
  font-weight: 600;
}
.about-v {
  margin-top: 6px;
  font-size: 14px;
  font-weight: 600;
  color: var(--foreground);
}

.channel-tag {
  display: inline-block;
  padding: 3px 10px;
  background: var(--success-container);
  color: var(--success);
  font-size: 11px;
  font-weight: 700;
  border-radius: 999px;
  line-height: 1.2;
}

/* 本机机器码行 */
.machine-row {
  padding: var(--space-3) var(--space-4);
  background: var(--surface-container);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  margin-bottom: var(--space-5);
}
.machine-line {
  margin-top: 6px;
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-width: 0;
}
.machine-code {
  flex: 1 1 auto;
  min-width: 0;
  font-family: ui-monospace, Consolas, monospace;
  font-size: 14px;
  font-weight: 700;
  letter-spacing: 0.04em;
  color: var(--foreground);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.about-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3);
  padding-top: var(--space-4);
  border-top: 1px solid var(--border);
}

@media (max-width: 900px) {
  .about-grid { grid-template-columns: 1fr; }
}
</style>
