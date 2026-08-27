<script setup lang="ts">
// ═══════════════════════════════════════════════════════════════
// CardAbout — 关于卡（版本信息，纯展示组件）
// 模板自 Settings.vue L820-854 原样迁出（IRON-08）；
// appVersion/buildDate/channel 由容器组装后以 props 传入。
// ═══════════════════════════════════════════════════════════════

defineProps<{
  appVersion: string
  buildDate: string
  channel: string
}>()
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
