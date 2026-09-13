<template>
  <div class="jytpl-page">
    <!-- 顶部：组/子类目两级 tabs + 右上角「从剪映同步」 -->
    <div class="jytpl-toolbar">
      <div class="jytpl-tabs">
        <template v-for="g in groups" :key="g.group">
          <!-- 单 lane 组：一个 tab -->
          <button v-if="(g.lanes || []).length === 1" class="jytpl-tab"
            :class="{ active: activeLane === (g.group + '/' + g.lanes[0].lane) }"
            @click="switchLane(g.lanes[0], g.group)">
            {{ g.lanes[0].lane }} <span class="jytpl-count">{{ g.lanes[0].total }}</span>
          </button>
          <!-- 多 lane 组（文本）：组 tab + 子类目下拉 -->
          <template v-else>
            <button class="jytpl-tab jytpl-tab-group"
              :class="{ active: activeGroup === g.group }" @click="switchGroup(g)">
              {{ g.group }} <span class="jytpl-count">{{ (g.lanes || []).reduce((s, l) => s + (l.total || 0), 0) }}</span>
              <span class="jytpl-caret">▾</span>
            </button>
            <div v-if="activeGroup === g.group" class="jytpl-sublanes">
              <button v-for="l in g.lanes" :key="l.lane" class="jytpl-tab jytpl-tab-sub"
                :class="{ active: activeLane === g.group + '/' + l.lane }" @click="switchLane(l, g.group)">
                {{ l.lane }} <span class="jytpl-count">{{ l.total }}</span>
              </button>
            </div>
          </template>
        </template>
      </div>
      <div class="jytpl-actions">
        <template v-if="isTextLane">
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

    <!-- 卡片网格：数据源=服务端 catalog lanes -->
    <template v-else>
      <div v-if="activeLaneData" class="jytpl-grid">
        <div v-for="item in activeLaneData.items" :key="String(item.id)" class="jytpl-card"
          :class="{ checked: selection.has(String(item.id)) }" @click="isTextLane ? toggleSel(String(item.id)) : undefined">
          <label v-if="isTextLane" class="jytpl-check" @click.stop>
            <input type="checkbox" :checked="selection.has(String(item.id))" @change="toggleSel(String(item.id))" />
          </label>
          <span class="jytpl-kind-badge" :class="activeLaneData.lane === '花字库' ? 'fancy' : 'tpl'">{{ activeLaneData.lane }}</span>
          <div class="jytpl-card-preview">
            <!-- 动态预览优先：preview.webm（透明通道循环播放，真·动画）；失败回退 png → CSS 文字动画 -->
            <video v-if="String(item.previewWebm) && !brokenPreview.has(String(item.id))" class="jytpl-preview-video"
              :src="absUrl(String(item.previewWebm))" autoplay loop muted playsinline
              @error="brokenPreview.add(String(item.id))" />
            <img v-else-if="String(item.preview) && !brokenPreview.has('img:' + String(item.id))" :src="absUrl(String(item.preview))" :alt="String(item.name)" class="jytpl-preview-img"
              loading="lazy" @error="brokenPreview.add('img:' + String(item.id))" />
            <div v-else class="jytpl-preview-anim" :class="'anim-' + String(item.anim || 'fade')">
              <span class="jytpl-preview-text" :style="{ color: String(item.color || '#fff') }">{{ String(item.text || item.name) }}</span>
            </div>
          </div>
          <div class="jytpl-card-body">
            <div class="jytpl-card-name" :title="String(item.name)">{{ String(item.name) }}</div>
            <div class="jytpl-card-meta">
              <span v-if="item.category" class="tag">{{ item.category }}</span>
              <span v-if="item.anim" class="tag anim-tag">{{ animLabel(String(item.anim)) }}</span>
              <span v-if="item.durationSec" class="tag">{{ item.durationSec }}s</span>
            </div>
          </div>
        </div>
        <div v-if="!activeLaneData || !activeLaneData.items.length" class="jytpl-empty">
          该子类目暂无模板——点右上角「从剪映同步」上传
        </div>
      </div>
      <div v-else class="jytpl-empty">请选择类目</div>
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
            <select v-model="syncDlg.lane" class="jytpl-dlg-select">
              <option value="花字库">文本 / 花字库</option>
              <option value="文字模板">文本 / 文字模板</option>
            </select>
          </div>
          <div class="jytpl-dlg-list">
            <div v-if="syncLocalItems.length === 0" class="jytpl-empty">本机剪映未发现该类目素材</div>
            <label v-for="it in syncLocalItems" :key="String(it.effectId || it.id)" class="jytpl-dlg-item">
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

interface Lane {
  lane: string
  total: number
  endpoint: string
  tags: Array<{ name: string; count: number }>
  items: Array<Record<string, unknown>>
}
interface Group {
  group: string
  lanes: Lane[]
}

const groups = ref<Group[]>([])
const activeGroup = ref('文本')
const activeLane = ref('文本/花字库')
const loading = ref(true)
const errorMsg = ref('')
const busy = ref(false)
const serverUrl = ref('')
const selection = reactive(new Set<string>())
const brokenPreview = reactive(new Set<string>())

const activeGroupData = computed(() => groups.value.find((g) => g.group === activeGroup.value) || null)
const activeLaneData = computed<Lane | null>(() => {
  for (const g of groups.value) {
    for (const l of g.lanes || []) {
      if (activeGroup.value + '/' + l.lane === activeLane.value) return l
    }
  }
  return null
})
const isTextLane = computed(() => {
  const l = activeLaneData.value
  return !!l && (l.lane === '花字库' || l.lane === '文字模板')
})

function switchGroup(g: Group) {
  activeGroup.value = g.group
  const first = (g.lanes || [])[0]
  if (first) activeLane.value = g.group + '/' + first.lane
  selection.clear()
}
function switchLane(l: Lane, groupName?: string) {
  const gn = groupName || activeGroup.value
  activeGroup.value = gn
  activeLane.value = gn + '/' + l.lane
  selection.clear()
}

const allChecked = computed(() => {
  const items = activeLaneData.value?.items || []
  return items.length > 0 && items.every((it) => selection.has(String(it.id)))
})
function toggleSel(id: string) {
  if (selection.has(id)) selection.delete(id)
  else selection.add(id)
}
function toggleAll(e: Event) {
  const on = (e.target as HTMLInputElement).checked
  selection.clear()
  if (on) for (const it of (activeLaneData.value?.items || [])) selection.add(String(it.id))
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
  show: false, lane: '花字库', busy: false, progress: '', force: false,
  localItems: [] as Array<Record<string, unknown> & { picked?: boolean; group?: string; syncedToServer?: boolean; effectId?: string; name?: string }>,
})
const syncLocalItems = computed(() => {
  if (syncDlg.lane === '花字库') return syncDlg.localItems.filter((i) => i.group === '花字库')
  if (syncDlg.lane === '文字模板') return syncDlg.localItems.filter((i) => i.group === '文字模板')
  return []
})
const pickedCount = computed(() => syncLocalItems.value.filter((i) => i.picked).length)

async function openSyncDlg() {
  syncDlg.show = true
  syncDlg.progress = ''
  const res = await window.tintin?.server?.jyTemplatesList?.()
  if (res && 'ok' in res && res.ok) {
    syncDlg.localItems = (res.localAvailable || []) as Array<Record<string, unknown> & { picked?: boolean; group?: string; syncedToServer?: boolean; effectId?: string; name?: string }>
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
      groups.value = (res.groups || []) as Group[]
      serverUrl.value = String((res as Record<string, unknown>).serverUrl || '')
      // 默认选中「文本/花字库」
      if (!groups.value.find((g) => g.group === activeGroup.value)) activeGroup.value = '文本'
      if (!activeLaneData.value) activeLane.value = '文本/花字库'
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
  busy.value = true
  try {
    // 文本 lane 内勾选的 jy_ 模板 → 重新上传本机预设覆盖（服务端为唯一数据源，重传即更新）
    const res = await window.tintin?.server?.jyTemplatesSync?.({ ids: [...selection].filter((id) => id.startsWith('jy_')) })
    if (res && 'ok' in res && res.ok) {
      const okN = (res.results || []).filter((r) => r.ok).length
      const fails = (res.results || []).filter((r) => !r.ok)
      if (fails.length) window.alert(`成功 ${okN}，失败 ${fails.length}\n` + fails.map((f) => `${f.id}: ${f.error}`).join('\n'))
      else if (okN) window.alert(`已重新同步 ${okN} 个模板`)
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
.jytpl-toolbar { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; margin-bottom: 16px; flex-wrap: wrap; }
.jytpl-tabs { display: flex; gap: 4px; flex-wrap: wrap; align-items: center; }
.jytpl-tab { padding: 6px 14px; border: 1px solid #333; border-radius: 6px; background: transparent; cursor: pointer; font-size: 13px; color: #ccc; transition: all .15s; }
.jytpl-tab.active { background: #409eff; color: #fff; border-color: #409eff; }
.jytpl-tab:hover:not(.active) { background: rgba(255,255,255,.06); }
.jytpl-tab-group { font-weight: 600; }
.jytpl-caret { font-size: 10px; opacity: .6; margin-left: 2px; }
.jytpl-sublanes { display: flex; gap: 4px; }
.jytpl-tab-sub { padding: 5px 10px; font-size: 12px; }
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
.jytpl-preview-video { max-width: 100%; max-height: 100%; object-fit: contain; pointer-events: none; }
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
.jytpl-dlg-select { flex: 0 0 220px; padding: 5px 8px; background: #2a2a2a; color: #ddd; border: 1px solid #444; border-radius: 6px; }
.jytpl-dlg-list { max-height: 300px; overflow-y: auto; border: 1px solid #333; border-radius: 6px; }
.jytpl-dlg-item { display: flex; align-items: center; gap: 8px; padding: 7px 10px; cursor: pointer; border-bottom: 1px solid #2a2a2a; }
.jytpl-dlg-item:hover { background: rgba(255,255,255,.04); }
.jytpl-dlg-item-name { flex: 1; font-size: 13px; }
.jytpl-dlg-progress { margin-top: 10px; font-size: 12px; color: #8ab4f8; min-height: 16px; }
.jytpl-dlg-foot { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 16px; border-top: 1px solid #333; }
</style>
