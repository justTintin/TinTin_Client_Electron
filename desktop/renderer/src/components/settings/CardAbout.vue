<script setup lang="ts">
// ═══════════════════════════════════════════════════════════════
// CardAbout — 关于卡（品牌/授权/版本信息，纯展示组件）
// 模板自 Settings.vue L820-854 原样迁出（IRON-08）；
// appVersion/buildDate/channel 由容器组装后以 props 传入。
// 2026-08-28：新增本机机器码展示 +「复制」按钮；机器码由容器经
// useSettingsGeneral.loadMachineCode 加载（主进程原始信息 +
// 渲染层纯函数 machineCodeLogic 摘要）。
// 2026-08-30 用户裁决：系统信息（OS/CPU/内存/磁盘）自「系统与运行」卡
// 并入本卡（env:detectEnv local，容器经 useSettingsIntegration 加载）。
// 2026-08-30 补齐原客户端关于页信息（gui/main_window_pages.py L1640-1747）：
//   · 品牌/开发者卡：螺丝钉-电商智能体矩阵 / 大怪工作室 / 联系电话
//   · 软件授权与激活卡：授权状态/激活签名/有效期至（原版为常量文案，
//     license_status = "已激活 (客户端免激活)" 等 L1670-1672）
//   · 机器码算法对齐原版 license.py get_machine_id（16 位小写 hex 原样）
// ═══════════════════════════════════════════════════════════════

import { ref } from 'vue'

defineProps<{
  appVersion: string
  buildDate: string
  channel: string
  machineCode: string
  sysInfoRows: Array<{ label: string; value: string }>
  sysInfoLoading: boolean
}>()

const emit = defineEmits<{
  (e: 'refresh-sysinfo'): void
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

    <!-- 品牌/开发者信息（对齐原 gui/main_window_pages.py L1652-1662） -->
    <div class="brand-card">
      <div class="brand-title">螺丝钉-电商智能体矩阵</div>
      <div class="brand-dev">此智能体由 <b>大怪工作室</b> 开发</div>
      <div class="brand-contact">
        联系电话：<span class="brand-phone">17361907260</span>（微信同号）
      </div>
    </div>

    <!-- 软件授权与激活（对齐原 L1670-1745：客户端免激活形态，常量文案） -->
    <div class="license-card">
      <div class="license-title">软件授权与激活</div>

      <div class="license-row">
        <span class="license-k">本机机器码</span>
        <span class="machine-code" :title="machineCode || '加载中…'">{{ machineCode || '—' }}</span>
        <button
          class="btn-secondary-sm"
          :disabled="!machineCode"
          :title="machineCode ? '复制机器码' : '加载中'"
          @click="copyMachineCode(machineCode)"
        >
          {{ copied ? '已复制' : '复制机器码' }}
        </button>
      </div>

      <div class="license-row">
        <span class="license-k">授权状态</span>
        <span class="license-ok">已激活 (客户端免激活)</span>
      </div>
      <div class="license-row">
        <span class="license-k">激活签名</span>
        <span class="license-v">服务端统一授权验证</span>
      </div>
      <div class="license-row">
        <span class="license-k">有效期至</span>
        <span class="license-v">自适应计算服务端授权状态</span>
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

    <!-- 系统信息（env:detectEnv local：os/cpu/ram/disk；自「系统与运行」卡迁入） -->
    <div class="sysinfo-row">
      <div class="about-k">系统信息</div>
      <div class="sysinfo-line">
        <div v-if="sysInfoRows.length" class="sysinfo-list">
          <div v-for="row in sysInfoRows" :key="row.label" class="sysinfo-item">
            <span class="sysinfo-label">{{ row.label }}</span>
            <span class="sysinfo-value" :title="row.value">{{ row.value }}</span>
          </div>
        </div>
        <span v-else class="sysinfo-empty">{{ sysInfoLoading ? '检测中…' : '未检测' }}</span>
        <button class="btn-secondary-sm" :disabled="sysInfoLoading" @click="emit('refresh-sysinfo')">
          {{ sysInfoLoading ? '检测中…' : '刷新' }}
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

/* 品牌/开发者信息卡（对齐原 about_app_title / about_dev_info / about_contact） */
.brand-card {
  padding: var(--space-4) var(--space-5);
  background: var(--surface-container);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  margin-bottom: var(--space-4);
}
.brand-title {
  font-size: 17px;
  font-weight: 800;
  color: var(--foreground);
  letter-spacing: 0.02em;
}
.brand-dev {
  margin-top: 8px;
  font-size: 13px;
  color: var(--muted-foreground);
}
.brand-dev b { color: var(--foreground); }
.brand-contact {
  margin-top: 6px;
  font-size: 13px;
  color: var(--muted-foreground);
}
.brand-phone {
  color: var(--primary, #3b82f6);
  font-weight: 700;
}

/* 软件授权与激活卡（对齐原 license_card） */
.license-card {
  padding: var(--space-4) var(--space-5);
  background: var(--surface-container);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  margin-bottom: var(--space-5);
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.license-title {
  font-size: 13px;
  font-weight: 800;
  color: var(--success, #10b981);
  letter-spacing: 0.04em;
  margin-bottom: 2px;
}
.license-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-width: 0;
}
.license-k {
  flex: 0 0 76px;
  font-size: 12px;
  font-weight: 700;
  color: var(--muted-foreground);
}
.license-v {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 12px;
  font-weight: 600;
  color: var(--foreground);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.license-ok {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 12px;
  font-weight: 700;
  color: var(--success, #10b981);
}
.license-row .machine-code {
  flex: 1 1 auto;
  min-width: 0;
  font-family: ui-monospace, Consolas, monospace;
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.04em;
  color: var(--foreground);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.license-row .btn-secondary-sm { flex: 0 0 auto; }

/* 系统信息行（自「系统与运行」卡迁入） */
.sysinfo-row {
  padding: var(--space-3) var(--space-4);
  background: var(--surface-container);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  margin-bottom: var(--space-5);
}
.sysinfo-line {
  margin-top: 6px;
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
}
.sysinfo-line .btn-secondary-sm { flex: 0 0 auto; }
.sysinfo-list {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.sysinfo-item { display: flex; align-items: center; gap: var(--space-3); min-width: 0; }
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
.sysinfo-empty { flex: 1 1 auto; font-size: 12px; color: var(--muted-foreground); }

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
