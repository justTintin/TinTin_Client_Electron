<template>
  <div class="jytpl-page">
    <div class="jytpl-tabs">
      <button v-for="cat in categories" :key="cat" class="jytpl-tab"
        :class="{ active: activeTab === cat }" @click="activeTab = cat">{{ cat }}
        <span class="jytpl-count">{{ (grouped[cat] || []).length }}</span>
      </button>
    </div>

    <div v-if="loading" class="jytpl-loading"><span class="spinner" />正在扫描剪映素材…</div>

    <div v-else-if="errorMsg" class="jytpl-error">
      <p>{{ errorMsg }}</p>
      <p class="muted">请确认剪映专业版已安装且版本 ≥ 5.9。</p>
    </div>

    <div v-else class="jytpl-grid">
      <div v-for="item in (grouped[activeTab] || [])" :key="String(item.id || item.name)" class="jytpl-card">
        <div class="jytpl-card-preview">
          <img v-if="item.previewDataUri" :src="String(item.previewDataUri)" :alt="String(item.name)" class="jytpl-preview-img" />
          <div v-else-if="item.color" class="jytpl-preview-text" :style="{ color: String(item.color) }">{{ String(item.name) }}</div>
          <div v-else class="jytpl-preview-placeholder">{{ String(item.name || '?').slice(0, 2) }}</div>
        </div>
        <div class="jytpl-card-body">
          <div class="jytpl-card-name" :title="String(item.name || item.id)">{{ String(item.name || item.id) }}</div>
          <div class="jytpl-card-meta">
            <span v-if="item.effectName" class="tag">{{ String(item.effectName) }}</span>
            <span v-if="item.stickerCount" class="tag">贴纸×{{ String(item.stickerCount) }}</span>
            <span v-if="item.durationSec" class="tag">{{ String(item.durationSec) }}s</span>
            <span v-if="item.isOverlap !== undefined" class="tag">{{ item.isOverlap ? '叠加' : '覆盖' }}</span>
          </div>
        </div>
      </div>
      <div v-if="!(grouped[activeTab] || []).length" class="jytpl-empty">该分类暂无素材</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'

interface JyTplItem {
  id: string
  name: string
  color?: string
  stickerCount?: number
  hasEffect?: boolean
  effectName?: string
  effectId?: string
  previewDataUri?: string
  preview?: string
  durationSec?: number
  isOverlap?: boolean
  file?: string
  bytes?: number
  [key: string]: unknown
}

const categories = ['文本', '特效', '贴纸', '转场', '字幕', '音频']
const loading = ref(true)
const errorMsg = ref('')
const activeTab = ref('文本')
const grouped = ref<Record<string, JyTplItem[]>>({})

onMounted(async () => {
  try {
    const res = await window.tintin?.server?.jyTemplatesList?.()
    if (res && 'ok' in res && res.ok) {
      grouped.value = res.categories as Record<string, JyTplItem[]>
    } else if (res && 'error' in res) {
      errorMsg.value = res.error
    }
  } catch (e) {
    errorMsg.value = String(e)
  } finally {
    loading.value = false
  }
})
</script>

<style scoped>
.jytpl-page { padding: 0; }
.jytpl-tabs { display: flex; gap: 4px; margin-bottom: 16px; flex-wrap: wrap; }
.jytpl-tab {
  padding: 6px 14px; border: 1px solid var(--el-border-color, #333); border-radius: 6px;
  background: transparent; cursor: pointer; font-size: 13px; color: var(--el-text-color-regular, #ccc);
  transition: all .15s;
}
.jytpl-tab.active { background: var(--el-color-primary, #409eff); color: #fff; border-color: var(--el-color-primary, #409eff); }
.jytpl-tab:hover:not(.active) { background: rgba(255,255,255,.06); }
.jytpl-count { font-size: 11px; opacity: .6; margin-left: 4px; }
.jytpl-loading, .jytpl-error, .jytpl-empty { padding: 40px 0; text-align: center; color: #999; }
.jytpl-error { color: #f56c6c; }
.jytpl-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 12px; }
.jytpl-card { border: 1px solid var(--el-border-color-lighter, #333); border-radius: 8px; overflow: hidden; background: var(--el-bg-color, #1a1a1a); transition: border-color .15s; }
.jytpl-card:hover { border-color: var(--el-color-primary, #409eff); }
.jytpl-card-preview { height: 90px; display: flex; align-items: center; justify-content: center; overflow: hidden; background: rgba(0,0,0,.2); }
.jytpl-preview-img { max-width: 100%; max-height: 100%; object-fit: contain; }
.jytpl-preview-text { font-weight: 900; font-size: 16px; text-shadow: 0 2px 6px rgba(0,0,0,.4); }
.jytpl-preview-placeholder { font-size: 28px; color: #555; font-weight: bold; }
.jytpl-card-body { padding: 8px 10px; }
.jytpl-card-name { font-size: 13px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.jytpl-card-meta { display: flex; gap: 4px; margin-top: 4px; flex-wrap: wrap; }
.tag { font-size: 11px; padding: 1px 6px; border-radius: 3px; background: rgba(255,255,255,.08); color: #999; }
.muted { color: #666; }
.spinner { display: inline-block; width: 16px; height: 16px; border: 2px solid #409eff; border-top-color: transparent; border-radius: 50%; animation: spin .8s linear infinite; margin-right: 8px; vertical-align: middle; }
@keyframes spin { to { transform: rotate(360deg) } }
</style>
