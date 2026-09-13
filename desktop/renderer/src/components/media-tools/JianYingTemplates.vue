<template>
  <div class="jytpl-page">
    <!-- 顶部：分类 tabs + 右上角「从剪映同步」 -->
    <div class="jytpl-toolbar">
      <div class="jytpl-tabs">
        <button v-for="cat in categories" :key="cat" class="jytpl-tab"
          :class="{ active: activeTab === cat }" @click="activeTab = cat; selection.clear()">{{ cat }}
          <span class="jytpl-count">{{ (serverTemplates[cat] || []).length }}</span>
        </button>
      </div>
      <div class="jytpl-actions">
        <template v-if="isTextTab">
          <label class="jytpl-checkall">
            <input type="checkbox" :checked="allChecked" @change="toggleAll($event)" /> 全选
          </label>
          <button class="jytpl-btn primary" :disabled="!selection.size || busy" @click="syncSelectedById">同步选中（{{ selection.size }}）</button>
          <button class="jytpl-btn danger" :disabled="!selection.size || busy" @click="deleteSelected">删除（{{ selection.size }}）</button>
        </template>
        <button class="jytpl-btn accent" :disabled="syncDlg.busy" @click="openSyncDlg">⟳ 从剪映同步</button>
      </div>
    </div>

    <div v-if="loading" class="jytpl-loading"><span class="spinner" />正在从服务端加载模板…</div>

    <div v-else-if="errorMsg" class="jytpl-error">
      <p>{{ errorMsg }}</p>
      <p class="muted">请确认服务端可访问。</p>
    </div>

    <!-- 卡片网格：数据源=服务端 -->
    <template v-else>
      <div v-for="cat in categories" v-show="activeTab === cat" :key="cat" class="jytpl-grid">
        <div v-for="item in (serverTemplates[cat] || [])" :key="item.id" class="jytpl-card"
          :class="{ checked: selection.has(item.id) }" @click="isTextTab ? toggleSel(item.id) : undefined">
          <label v-if="isTextTab" class="jytpl-check" @click.stop>
            <input type="checkbox" :checked="selection.has(item.id)" @change="toggleSel(item.id)" />
          </label>
          <span class="jytpl-kind-badge" :class="cat === '花字库' ? 'fancy' : 'tpl'">{{ cat }}</span>
          <div class="jytpl-card-preview">
            <img v-if="item.preview" :src="absUrl(item.preview)" :alt="item.name" class="jytpl-preview-img"
              loading="lazy" @error="($event) => { ($event.target as HTMLImageElement).style.display = 'none' }" />
            <div v-else class="jytpl-preview-anim" :class="'anim-' + (item.anim || 'fade')">
              <span class="jytpl-preview-text" :style="{ color: item.color }">{{ item.text || item.name }}</span>
            </div>
          </div>
          <div class="jytpl-card-body">
            <div class="jytpl-card-name" :title="item.name">{{ item.name }}</div>
            <div class="jytpl-card-meta">
              <span v-if="item.category" class="tag">{{ item.category }}</span>
              <span v-if="item.anim" class="tag anim-tag">{{ animLabel(item.anim) }}</span>
              <span class="tag">{{ item.id.slice(0, 14) }}</span>
            </div>
          </div>
        </div>
        <div v-if="!(serverTemplates[cat] || []).length" class="jytpl-empty">
          该分类暂无模板——点右上角「从剪映同步」上传
        </div>
      </div>
    </template>

    <!-- 从剪映同步弹窗 -->
    <div v-if="syncDlg.show" class="jytpl-dlg-mask" @click.self="syncDlg.show = false">
      <div class="jytpl-dlg">
        <div class="jytpl-dlg-head">
          <span>从剪映同步</span>
          <button class="jytpl-dlg-close" @click="syncDlg.show = false">×</button>
        </div>
        <div class="jytpl-dlg-body">
          <div class="jytpl-dlg-row">
            <label class="jytpl-dlg-label">同步类目:</label>
            <select v-model="syncDlg.category" class="jytpl-dlg-select">
              <option value="花字库">花字库</option>
              <option value="文字模板">文字模板</option>
              <option value="音频">音频</option>
              <option value="特效">特效</option>
            </select>
          </div>
          <div class="jytpl-dlg-list">
            <div v-if="syncLocalItems.length === 0" class="jytpl-empty">本机剪映未发现该类目素材</div>
            <label v-for="it in syncLocalItems" :key="it.effectId || it.id" class="jytpl-dlg-item">
              <input type="checkbox" v-model="it.picked" :disabled="it.syncedToServer && !syncDlg.force" />
              <span class="jytpl-dlg-item-name">{{ it.name }}</span>
              <span class="tag" :class="it.syncedToServer ? 'ok' : ''">{{ it.syncedToServer ? '已在服务端' : '未同步' }}</span>
            </label>
          </div>
          <div class="jytpl-dlg-progress" v-if="syncDlg.progress">{{ syncDlg.progress }}</div>
        </div>
        <div class="jytpl-dlg-foot">
          <button class="jytpl-btn" @click="syncDlg.show = false">取消</button>
          <button class="jytpl-btn primary" :disabled="!pickedCount || syncDlg.busy" @click="doSyncFromJianying">
            开始同步（{{ pickedCount }}）
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted } from 'vue'

interface ServerTpl {
  id: string
  name: string
  color: string
  text: string
  anim: string
  animSignature: string
  category: string
  preview: string
  previewWebm: string
  synced: boolean
}
interface LocalItem {
  id: string
  name: string
  effectId: string
  effectName?: string
  color?: string
  stickerCount?: number
  syncedToServer?: boolean
  serverId?: string
  picked?: boolean
  group?: string
  [key: string]: unknown
}

const serverUrl = ref('')
const categories = ['花字库', '文字模板', '特效', '贴纸', '转场', '字幕', '音频']
const loading = ref(true)
const errorMsg = ref('')
const activeTab = ref('花字库')
const busy = ref(false)
const serverTemplates = ref<Record<string, ServerTpl[]>>({ 花字库: [], 文字模板: [], 特效: [], 贴纸: [], 转场: [], 字幕: [], 音频: [] })
const selection = reactive(new Set<string>())

const isTextTab = computed(() => activeTab.value === '花字库' || activeTab.value === '文字模板')
const allChecked = computed(() => {
  const items = serverTemplates.value[activeTab.value] || []
  return items.length > 0 && items.every((it) => selection.has(it.id))
})
function toggleSel(id: string) {
  if (selection.has(id)) selection.delete(id)
  else selection.add(id)
}
function toggleAll(e: Event) {
  const on = (e.target as HTMLInputElement).checked
  selection.clear()
  if (on) for (const it of (serverTemplates.value[activeTab.value] || [])) selection.add(it.id)
}
function animLabel(a: string): string {
  return ({ bounce: '弹入', pulse: '律动', slide: '滑入', fade: '淡入' })[a] || a
}
function absUrl(p: string): string {
  if (!p) return ''
  if (/^https?:/.test(p)) return p
  return serverUrl.value.replace(/\/$/, '') + (p.startsWith('/') ? p : '/' + p)
}

// ── 从剪映同步弹窗 ──
const syncDlg = reactive({
  show: false, category: '花字库', busy: false, progress: '', force: false,
  localItems: [] as LocalItem[],
})
const syncLocalItems = computed(() => {
  const cat = syncDlg.category
  if (cat === '花字库') return syncDlg.localItems.filter((i) => i.group === '花字库')
  if (cat === '文字模板') return syncDlg.localItems.filter((i) => i.group === '文字模板')
  return [] // 音频/特效走 sync-audio 通道，弹窗内提示
})
const pickedCount = computed(() => syncLocalItems.value.filter((i) => i.picked).length)

async function openSyncDlg() {
  syncDlg.show = true
  syncDlg.progress = ''
  // 拉本机可同步清单
  const res = await window.tintin?.server?.jyTemplatesList?.()
  if (res && 'ok' in res && res.ok) {
    syncDlg.localItems = (res.localAvailable || []) as LocalItem[]
  } else {
    syncDlg.localItems = []
    syncDlg.progress = '本机剪映目录扫描失败'
  }
}

async function doSyncFromJianying() {
  const ids = syncLocalItems.value.filter((i) => i.picked).map((i) => String(i.effectId))
  if (!ids.length) return
  syncDlg.busy = true
  syncDlg.progress = `正在同步 ${ids.length} 个素材…`
  try {
    const res = await window.tintin?.server?.jyTemplatesSync?.({ ids })
    if (res && 'ok' in res && res.ok) {
      const okN = (res.results || []).filter((r) => r.ok).length
      const fails = (res.results || []).filter((r) => !r.ok)
      syncDlg.progress = `完成：成功 ${okN}${fails.length ? '，失败 ' + fails.length : ''}`
      if (fails.length) window.alert(fails.map((f) => `${f.id}: ${f.error}`).join('\n'))
      await reload()
    } else if (res && 'error' in res) {
      syncDlg.progress = '同步失败：' + res.error
    }
  } finally {
    syncDlg.busy = false
  }
}

async function reload() {
  loading.value = true
  errorMsg.value = ''
  selection.clear()
  try {
    const res = await window.tintin?.server?.jyTemplatesList?.()
    if (res && 'ok' in res && res.ok) {
      serverTemplates.value = { ...serverTemplates.value, ...(res.serverTemplates || {}) } as Record<string, ServerTpl[]>
      serverUrl.value = String((res as Record<string, unknown>).serverUrl || window.location.origin)
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

async function syncSelectedById() {
  // 服务端已同步的模板勾选同步 = 重新上传本机预设覆盖（等价于从剪映同步该项）
  busy.value = true
  try {
    const res = await window.tintin?.server?.jyTemplatesSync?.({ ids: [...selection] })
    if (res && 'ok' in res && res.ok) {
      const okN = (res.results || []).filter((r) => r.ok).length
      const fails = (res.results || []).filter((r) => !r.ok)
      if (fails.length) window.alert(`成功 ${okN}，失败 ${fails.length}\n` + fails.map((f) => `${f.id}: ${f.error}`).join('\n'))
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
  if (!window.confirm(`确认从服务端删除选中的 ${ids.length} 个模板？`)) return
  busy.value = true
  try {
    const res = await window.tintin?.server?.jyTemplatesDeleteServer?.({ ids })
    if (res && 'ok' in res && res.ok) {
      const okN = (res.results || []).filter((r) => r.ok).length
      window.alert(`已删除 ${okN} 个`)
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
.jytpl-tab { padding: 6px 14px; border: 1px solid #333; border-radius: 6px; background: transparent; cursor: pointer; font-size: 13px; color: #ccc; transition: all .15s; }
.jytpl-tab.active { background: #409eff; color: #fff; border-color: #409eff; }
.jytpl-tab:hover:not(.active) { background: rgba(255,255,255,.06); }
.jytpl-count { font-size: 11px; opacity: .6; margin-left: 4px; }
.jytpl-actions { display: flex; gap: 8px; align-items: center; }
.jytpl-checkall { font-size: 12px; color: #ccc; cursor: pointer; display: flex; align-items: center; gap: 4px; }
.jytpl-btn { padding: 5px 12px; border-radius: 6px; border: 1px solid #444; background: #2a2a2a; color: #ddd; cursor: pointer; font-size: 12px; }
.jytpl-btn.primary { background: #409eff; border-color: #409eff; color: #fff; }
.jytpl-btn.accent { background: #67c23a; border-color: #67c23a; color: #fff; }
.jytpl-btn.danger { background: #a85555; border-color: #a85555; color: #fff; }
.jytpl-btn:disabled { opacity: .4; cursor: not-allowed; }
.jytpl-loading, .jytpl-error, .jytpl-empty { padding: 40px 0; text-align: center; color: #999; }
.jytpl-error { color: #f56c6c; }
.jytpl-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 12px; }
.jytpl-card { position: relative; border: 1px solid #333; border-radius: 8px; overflow: hidden; background: #1a1a1a; transition: border-color .15s, box-shadow .15s; cursor: pointer; }
.jytpl-card:hover { border-color: #409eff; }
.jytpl-card.checked { border-color: #409eff; box-shadow: 0 0 0 1px #409eff; }
.jytpl-check { position: absolute; top: 8px; left: 8px; z-index: 2; cursor: pointer; }
.jytpl-check input { width: 15px; height: 15px; cursor: pointer; }
.jytpl-kind-badge { position: absolute; top: 8px; right: 8px; z-index: 2; font-size: 10px; padding: 2px 7px; border-radius: 8px; }
.jytpl-kind-badge.fancy { background: rgba(236,72,153,.2); color: #f9a8d4; border: 1px solid rgba(236,72,153,.4); }
.jytpl-kind-badge.tpl { background: rgba(96,165,250,.15); color: #93c5fd; border: 1px solid rgba(96,165,250,.4); }
.jytpl-card-preview { height: 110px; display: flex; align-items: center; justify-content: center; overflow: hidden; background: radial-gradient(circle at 50% 60%, #222, #0d0d0d); }
.jytpl-preview-img { max-width: 100%; max-height: 100%; object-fit: contain; }
.jytpl-preview-anim { display: flex; align-items: center; justify-content: center; width: 100%; }
.jytpl-preview-text { font-weight: 900; font-size: 20px; text-shadow: 0 2px 8px rgba(0,0,0,.5); display: inline-block; }
.anim-bounce .jytpl-preview-text { animation: demoBounce 1.6s cubic-bezier(.2,1.6,.4,1) infinite; }
.anim-pulse .jytpl-preview-text { animation: demoPulse 1.6s ease-in-out .3s infinite; }
.anim-slide .jytpl-preview-text { animation: demoSlide 1.8s ease-out infinite; }
.anim-fade .jytpl-preview-text { animation: demoFade 2.2s ease infinite; }
@keyframes demoBounce { 0%,100%{transform:translateY(0) scale(1)} 12%{transform:translateY(-10px) scale(1.06)} 24%{transform:translateY(0) scale(.96)} 36%{transform:translateY(0) scale(1)} }
@keyframes demoPulse { 0%,100%{transform:scale(.95)} 50%{transform:scale(1.05)} }
@keyframes demoSlide { 0%{transform:translateX(-16px);opacity:0} 30%,85%{transform:translateX(0);opacity:1} 100%{transform:translateX(0);opacity:.4} }
@keyframes demoFade { 0%,100%{opacity:.35} 50%{opacity:1} }
.jytpl-card-body { padding: 8px 10px; }
.jytpl-card-name { font-size: 13px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.jytpl-card-meta { display: flex; gap: 4px; margin-top: 4px; flex-wrap: wrap; }
.tag { font-size: 11px; padding: 1px 6px; border-radius: 3px; background: rgba(255,255,255,.08); color: #999; }
.tag.ok { color: #67c23a; }
.anim-tag { color: #8ab4f8; }
.muted { color: #666; }
.spinner { display: inline-block; width: 16px; height: 16px; border: 2px solid #409eff; border-top-color: transparent; border-radius: 50%; animation: spin .8s linear infinite; margin-right: 8px; vertical-align: middle; }
@keyframes spin { to { transform: rotate(360deg) } }
/* 弹窗 */
.jytpl-dlg-mask { position: fixed; inset: 0; background: rgba(0,0,0,.55); z-index: 100; display: flex; align-items: center; justify-content: center; }
.jytpl-dlg { width: 480px; max-height: 80vh; background: #1e1e1e; border: 1px solid #333; border-radius: 10px; display: flex; flex-direction: column; }
.jytpl-dlg-head { display: flex; justify-content: space-between; align-items: center; padding: 12px 16px; border-bottom: 1px solid #333; font-size: 14px; font-weight: 600; }
.jytpl-dlg-close { background: none; border: none; color: #999; font-size: 18px; cursor: pointer; }
.jytpl-dlg-body { padding: 14px 16px; overflow-y: auto; }
.jytpl-dlg-row { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.jytpl-dlg-label { font-size: 13px; color: #ccc; }
.jytpl-dlg-select { flex: 0 0 180px; padding: 5px 8px; background: #2a2a2a; color: #ddd; border: 1px solid #444; border-radius: 6px; }
.jytpl-dlg-checkbox { font-size: 13px; color: #ccc; cursor: pointer; display: flex; gap: 6px; align-items: center; }
.jytpl-dlg-list { max-height: 300px; overflow-y: auto; border: 1px solid #333; border-radius: 6px; }
.jytpl-dlg-item { display: flex; align-items: center; gap: 8px; padding: 7px 10px; cursor: pointer; border-bottom: 1px solid #2a2a2a; }
.jytpl-dlg-item:hover { background: rgba(255,255,255,.04); }
.jytpl-dlg-item-name { flex: 1; font-size: 13px; }
.jytpl-dlg-progress { margin-top: 10px; font-size: 12px; color: #8ab4f8; min-height: 16px; }
.jytpl-dlg-foot { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 16px; border-top: 1px solid #333; }
</style>
