<template>
  <div class="jytpl-page">
    <div class="jytpl-toolbar">
      <div class="jytpl-tabs">
        <button v-for="cat in categories" :key="cat" class="jytpl-tab"
          :class="{ active: activeTab === cat }" @click="activeTab = cat; selection.clear()">{{ cat }}
          <span class="jytpl-count">{{ (grouped[cat] || []).length }}</span>
        </button>
      </div>
      <!-- 右上角批量操作（仅文本 tab 有同步/删除语义） -->
      <div v-if="activeTab === '文本' && (grouped['文本'] || []).length" class="jytpl-actions">
        <label class="jytpl-checkall">
          <input type="checkbox" :checked="allChecked" @change="toggleAll($event)" /> 全选
        </label>
        <button class="jytpl-btn primary" :disabled="!selection.size || busy" @click="syncSelected">
          同步到服务端（{{ selection.size }}）
        </button>
        <button class="jytpl-btn danger" :disabled="!selection.size || busy" @click="deleteSelected">
          删除服务端（{{ selection.size }}）
        </button>
      </div>
    </div>

    <div v-if="loading" class="jytpl-loading"><span class="spinner" />正在扫描剪映素材…</div>

    <div v-else-if="errorMsg" class="jytpl-error">
      <p>{{ errorMsg }}</p>
      <p class="muted">请确认剪映专业版已安装且版本 ≥ 5.9。</p>
    </div>

    <template v-else>
      <div class="jytpl-grid">
        <div v-for="item in (grouped[activeTab] || [])" :key="String(item.id || item.name)" class="jytpl-card"
          :class="{ checked: selection.has(String(item.effectId || item.id)) }">
          <!-- 复选框（文本 tab） -->
          <label v-if="activeTab === '文本' && item.effectId" class="jytpl-check"
            @click.stop>
            <input type="checkbox" :checked="selection.has(String(item.effectId))"
              @change="toggleSel(String(item.effectId))" />
          </label>
          <!-- 同步状态角标（文本 tab） -->
          <span v-if="activeTab === '文本'" class="jytpl-sync-badge"
            :class="item.syncedToServer ? 'synced' : 'local'">
            {{ item.syncedToServer ? '已同步' : '未同步' }}
          </span>
          <div class="jytpl-card-preview">
            <img v-if="item.previewDataUri" :src="String(item.previewDataUri)" :alt="String(item.name)" class="jytpl-preview-img" />
            <!-- 动画演示文字（无预览图时按 anim 语义动态播放） -->
            <div v-else class="jytpl-preview-anim" :class="'anim-' + (item.serverAnim || guessAnim(item))">
              <span class="jytpl-preview-text" :style="{ color: String(item.color || '#fff') }">{{ String(item.name) }}</span>
            </div>
          </div>
          <div class="jytpl-card-body">
            <div class="jytpl-card-name" :title="String(item.name || item.id)">{{ String(item.name || item.id) }}</div>
            <div class="jytpl-card-meta">
              <span v-if="item.effectName" class="tag">{{ String(item.effectName) }}</span>
              <span v-if="item.stickerCount" class="tag">贴纸×{{ String(item.stickerCount) }}</span>
              <span v-if="item.isOverlap !== undefined" class="tag">{{ item.isOverlap ? '叠加' : '覆盖' }}</span>
              <span v-if="item.animSignature" class="tag anim-tag" :title="String(item.animSignature)">{{ displayAnim(item) }}</span>
            </div>
          </div>
        </div>
        <div v-if="!(grouped[activeTab] || []).length" class="jytpl-empty">该分类暂无素材</div>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted } from 'vue'

interface JyTplItem {
  id: string
  name: string
  color?: string
  stickerCount?: number
  hasEffect?: boolean
  effectName?: string
  effectId?: string
  previewDataUri?: string
  syncedToServer?: boolean
  serverAnim?: string
  animSignature?: string
  isOverlap?: boolean
  durationSec?: number
  [key: string]: unknown
}

const categories = ['文本', '特效', '贴纸', '转场', '字幕', '音频']
const loading = ref(true)
const errorMsg = ref('')
const activeTab = ref('文本')
const busy = ref(false)
const grouped = ref<Record<string, JyTplItem[]>>({})
const selection = reactive(new Set<string>())

const allChecked = computed(() => {
  const items = grouped.value['文本'] || []
  return items.length > 0 && items.every((it) => selection.has(String(it.effectId || it.id)))
})

function toggleSel(id: string) {
  if (selection.has(id)) selection.delete(id)
  else selection.add(id)
}
function toggleAll(e: Event) {
  const on = (e.target as HTMLInputElement).checked
  selection.clear()
  if (on) for (const it of (grouped.value['文本'] || [])) selection.add(String(it.effectId || it.id))
}

/** lua 签名 → 动画语义（与 buildSyncPackage 同口径，预览兜底用） */
function guessAnim(item: JyTplItem): string {
  const sig = String(item.animSignature || '')
  if (/bounce/i.test(sig)) return 'bounce'
  if (/slide|shangxiaweiyi/i.test(sig)) return 'slide'
  if (/enlarge|spring|heartbeat|textwave|textanim/i.test(sig)) return 'pulse'
  return 'fade'
}
function displayAnim(item: JyTplItem): string {
  const a = item.serverAnim || guessAnim(item)
  return { bounce: '弹入', pulse: '律动', slide: '滑入', fade: '淡入' }[a] || a
}

async function reload() {
  loading.value = true
  errorMsg.value = ''
  selection.clear()
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
}
onMounted(reload)

async function syncSelected() {
  busy.value = true
  try {
    const res = await window.tintin?.server?.jyTemplatesSync?.({ ids: [...selection] })
    if (res && 'ok' in res && res.ok) {
      const okN = (res.results || []).filter((r: { ok: boolean }) => r.ok).length
      const fails = (res.results || []).filter((r: { ok: boolean }) => !r.ok)
      if (fails.length) {
        window.alert(`同步完成：成功 ${okN}，失败 ${fails.length}\n` + fails.map((f) => `${f.id}: ${f.error}`).join('\n'))
      } else {
        window.alert(`已同步 ${okN} 个模板到服务端`)
      }
      await reload()
    } else if (res && 'error' in res) {
      window.alert('同步失败：' + res.error)
    }
  } finally {
    busy.value = false
  }
}

async function deleteSelected() {
  const ids = [...selection]
  if (!window.confirm(`确认从服务端删除选中的 ${ids.length} 个模板？（本地预设不受影响）`)) return
  busy.value = true
  try {
    const res = await window.tintin?.server?.jyTemplatesDeleteServer?.({ ids })
    if (res && 'ok' in res && res.ok) {
      const okN = (res.results || []).filter((r: { ok: boolean }) => r.ok).length
      window.alert(`已从服务端删除 ${okN} 个模板`)
      await reload()
    } else if (res && 'error' in res) {
      window.alert('删除失败：' + res.error)
    }
  } finally {
    busy.value = false
  }
}
</script>

<style scoped>
.jytpl-page { padding: 0; }
.jytpl-toolbar { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 16px; flex-wrap: wrap; }
.jytpl-tabs { display: flex; gap: 4px; flex-wrap: wrap; }
.jytpl-tab {
  padding: 6px 14px; border: 1px solid var(--el-border-color, #333); border-radius: 6px;
  background: transparent; cursor: pointer; font-size: 13px; color: var(--el-text-color-regular, #ccc);
  transition: all .15s;
}
.jytpl-tab.active { background: var(--el-color-primary, #409eff); color: #fff; border-color: var(--el-color-primary, #409eff); }
.jytpl-tab:hover:not(.active) { background: rgba(255,255,255,.06); }
.jytpl-count { font-size: 11px; opacity: .6; margin-left: 4px; }
.jytpl-actions { display: flex; gap: 8px; align-items: center; }
.jytpl-checkall { font-size: 12px; color: #ccc; cursor: pointer; display: flex; align-items: center; gap: 4px; }
.jytpl-btn { padding: 5px 12px; border-radius: 6px; border: 1px solid #444; background: #2a2a2a; color: #ddd; cursor: pointer; font-size: 12px; }
.jytpl-btn.primary { background: #409eff; border-color: #409eff; color: #fff; }
.jytpl-btn.primary:disabled { opacity: .4; cursor: not-allowed; }
.jytpl-btn.danger { background: #a85555; border-color: #a85555; color: #fff; }
.jytpl-btn.danger:disabled { opacity: .4; cursor: not-allowed; }
.jytpl-loading, .jytpl-error, .jytpl-empty { padding: 40px 0; text-align: center; color: #999; }
.jytpl-error { color: #f56c6c; }
.jytpl-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 12px; }
.jytpl-card { position: relative; border: 1px solid #333; border-radius: 8px; overflow: hidden; background: #1a1a1a; transition: border-color .15s, box-shadow .15s; }
.jytpl-card:hover { border-color: #409eff; }
.jytpl-card.checked { border-color: #409eff; box-shadow: 0 0 0 1px #409eff; }
.jytpl-check { position: absolute; top: 8px; left: 8px; z-index: 2; cursor: pointer; }
.jytpl-check input { width: 15px; height: 15px; cursor: pointer; }
.jytpl-sync-badge { position: absolute; top: 8px; right: 8px; z-index: 2; font-size: 10px; padding: 2px 7px; border-radius: 8px; }
.jytpl-sync-badge.synced { background: rgba(82,196,26,.2); color: #67c23a; border: 1px solid rgba(82,196,26,.4); }
.jytpl-sync-badge.local { background: rgba(230,162,60,.15); color: #e6a23c; border: 1px solid rgba(230,162,60,.4); }
.jytpl-card-preview { height: 96px; display: flex; align-items: center; justify-content: center; overflow: hidden; background: radial-gradient(circle at 50% 60%, #222, #0d0d0d); }
.jytpl-preview-img { max-width: 100%; max-height: 100%; object-fit: contain; }
.jytpl-preview-anim { display: flex; align-items: center; justify-content: center; width: 100%; }
.jytpl-preview-text { font-weight: 900; font-size: 20px; text-shadow: 0 2px 8px rgba(0,0,0,.5); display: inline-block; }
/* 卡片内动画演示（按模板动画语义，与服务端 CSS 动画同源近似） */
.anim-bounce .jytpl-preview-text { animation: demoBounce 1.6s cubic-bezier(.2,1.6,.4,1) infinite; }
.anim-pulse .jytpl-preview-text { animation: demoPulse 1.6s ease-in-out .3s infinite; }
.anim-slide .jytpl-preview-text { animation: demoSlide 1.8s ease-out infinite; }
.anim-fade .jytpl-preview-text { animation: demoFade 2.2s ease infinite; }
@keyframes demoBounce { 0%,100%{transform:translateY(0) scale(1)} 12%{transform:translateY(-10px) scale(1.06)} 24%{transform:translateY(0) scale(.96)} 36%{transform:translateY(0) scale(1)} }
@keyframes demoPulse { 0%,100%{transform:scale(.95)} 50%{transform:scale(1.05)} }
@keyframes demoSlide { 0%{transform:translateX(-16px);opacity:0} 30%,85%{transform:translateX(0);opacity:1} 100%{transform:translateX(0);opacity:.4} }
@keyframes demoFade { 0%,100%{opacity:.35} 50%{opacity:1} }
.jytpl-preview-placeholder { font-size: 28px; color: #555; font-weight: bold; }
.jytpl-card-body { padding: 8px 10px; }
.jytpl-card-name { font-size: 13px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.jytpl-card-meta { display: flex; gap: 4px; margin-top: 4px; flex-wrap: wrap; }
.tag { font-size: 11px; padding: 1px 6px; border-radius: 3px; background: rgba(255,255,255,.08); color: #999; }
.anim-tag { color: #8ab4f8; }
.muted { color: #666; }
.spinner { display: inline-block; width: 16px; height: 16px; border: 2px solid #409eff; border-top-color: transparent; border-radius: 50%; animation: spin .8s linear infinite; margin-right: 8px; vertical-align: middle; }
@keyframes spin { to { transform: rotate(360deg) } }
</style>
