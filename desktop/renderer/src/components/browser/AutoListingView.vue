<script setup lang="ts">
// ═══════════════════════════════════════════════════════════════
// AutoListingView — 自动上架面板（P3 迁移，展示组件）
// 迁移自原「系统设置 → 扩展插件 → 自动上架」（2026-08-27 裁决）：
//   · 载体变更：不再依赖外挂 Chrome CDP(9222) + bridge(8123)，
//     改为「打开抖店工作台」进入内置分区 persist:tintin-fxg 已登录会话；
//   · 本期为入口版：店铺关键词配置 + 打开抖店分区；完整自动化
//     链路（数据包校验/商品填写/草稿/截图/断点续跑）后续排期。
// 业务状态在 composables/useAutoListing.ts；打开动作经容器接 nav.selectFxg。
// ═══════════════════════════════════════════════════════════════
import { onMounted } from 'vue'
import { useAutoListing } from '../../composables/useAutoListing'

const emit = defineEmits<{
  /** 打开抖店工作台分区会话（容器接 selectFxg） */
  (e: 'open-fxg'): void
}>()

const { shopKeyword, saving, saved, loadCfg, saveCfg } = useAutoListing()

onMounted(() => { void loadCfg() })
</script>

<template>
  <div class="autolisting-view-area">
    <div class="al-header">
      <div class="al-title">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M12 19V5" />
          <path d="M5 12l7-7 7 7" />
        </svg>
        <span>自动上架</span>
      </div>
      <p class="al-desc">操作抖店工作台完成商品上架（复用内置浏览器已登录会话）。</p>
    </div>

    <div class="al-body">
      <!-- 步骤说明 -->
      <div class="al-card">
        <div class="al-card-title">使用流程</div>
        <ol class="al-steps">
          <li>在下方填写店铺关键词（用于数据包命名校验）</li>
          <li>点击「打开抖店工作台」，在抖店页面登录商家账号</li>
          <li>登录后回到本面板，后续自动化上架链路将在此展开</li>
        </ol>
      </div>

      <!-- 配置区 -->
      <div class="al-card">
        <div class="al-card-title">上架配置</div>
        <div class="al-row">
          <label class="al-label">店铺关键词</label>
          <input v-model="shopKeyword" class="al-input" placeholder="数据包命名校验用的店铺关键词" />
          <button class="al-btn" :disabled="saving" @click="saveCfg()">
            {{ saved ? '已保存' : saving ? '保存中…' : '保存' }}
          </button>
        </div>
        <div class="al-hint">配置保存在本机（原「系统设置 → 扩展插件」配置无缝继承）。</div>
      </div>

      <!-- 打开抖店 -->
      <div class="al-card">
        <div class="al-card-title">抖店工作台</div>
        <div class="al-hint">进入内置浏览器抖店分区（独立登录态，与其他平台互不干扰）。</div>
        <button class="al-btn primary" @click="emit('open-fxg')">打开抖店工作台</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 同构 FavoritesView：header + 滚动卡片列表 */
.autolisting-view-area {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  padding: 20px 24px;
}
.autolisting-view-area::-webkit-scrollbar { width: 6px; }
.autolisting-view-area::-webkit-scrollbar-thumb { background: var(--surface-container-high); border-radius: 3px; }

.al-header { margin-bottom: 16px; }
.al-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 15px;
  font-weight: 600;
  color: var(--foreground);
}
.al-desc {
  margin-top: 4px;
  font-size: 12px;
  color: var(--muted-foreground);
}

.al-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-width: 560px;
}
.al-card {
  border: 1px solid var(--border);
  border-radius: var(--radius-lg, 10px);
  background: var(--surface-container);
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.al-card-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--foreground);
}
.al-steps {
  margin: 0;
  padding-left: 18px;
  font-size: 12px;
  color: var(--muted-foreground);
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.al-row {
  display: flex;
  align-items: center;
  gap: 10px;
}
.al-label {
  flex: 0 0 auto;
  font-size: 12px;
  color: var(--muted-foreground);
}
.al-input {
  flex: 1;
  min-width: 0;
  height: 30px;
  padding: 0 10px;
  border-radius: var(--radius-md, 8px);
  border: 1px solid var(--border);
  background: var(--background);
  color: var(--foreground);
  font-size: 13px;
}
.al-btn {
  flex: 0 0 auto;
  height: 30px;
  padding: 0 12px;
  border-radius: var(--radius-md, 8px);
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--foreground);
  font-size: 12px;
  cursor: pointer;
}
.al-btn:hover { border-color: var(--primary); color: var(--primary); }
.al-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.al-btn.primary {
  background: var(--primary, #6366f1);
  border-color: var(--primary, #6366f1);
  color: #fff;
}
.al-btn.primary:hover { opacity: 0.9; color: #fff; }
.al-hint {
  font-size: 12px;
  color: var(--muted-foreground);
}
</style>
