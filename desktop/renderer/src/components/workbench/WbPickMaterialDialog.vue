<script setup lang="ts">
// WbPickMaterialDialog.vue — 选择素材弹窗（双 tab：图视 / 音频）
// 2026-08-31 用户需求（参考原版素材检索 vector_search/page.py 口径）：
//   · 图视 tab：顶部 关键字/品牌/型号 过滤 + 类型分段（全部|视频|图片）；
//     卡片网格（缩略图 /material/thumbnail）+ 右侧预览（/material/serve 流式，
//     视频 video / 图片 img；不移植原版反推面板）；点卡片预览，确认按钮选中。
//   · 音频 tab：关键字 + 分类下拉（GET /audio/categories）过滤；列表行点击
//     → 底部播放条（<audio> 原生控件，GET /audio/library/{audio_id}/file）。
// 选中语义：图视 emit('pick')（容器 addCtxMaterial 入素材池，原口径）；
// 音频 emit('pick-audio')（容器 addCtxAudio：infoOnly 信息胶囊不入池）。
// 数据获取在 useWorkbenchPickers（组件零 URL 拼装，IRON-06）。
import { computed, ref, watch } from 'vue'
import TDialog from '@/components/common/TDialog.vue'
import {
  fetchMaterialGrid,
  fetchAudioLibrary,
  fetchAudioCategories,
  type PickerItem
} from '@/composables/useWorkbenchPickers'
import {
  buildMediaServeUrl,
  buildMediaThumbUrl,
  buildAudioFileUrl,
  mediaTypeLabel
} from '@/composables/workbenchChatContext'

const props = defineProps<{ visible: boolean }>()
const emit = defineEmits<{
  (e: 'close'): void
  /** 图视条目选中（容器 addCtxMaterial，入会话素材池） */
  (e: 'pick', item: PickerItem): void
  /** 音频条目选中（容器 addCtxAudio，信息胶囊不入池） */
  (e: 'pick-audio', item: PickerItem): void
}>()

const tab = ref<'av' | 'audio'>('av')

/* ── 服务端地址（预览/缩略图/播放条 URL 拼接；经 env:serverPing 取回） ── */
const serverUrl = ref('')
async function ensureServerUrl(): Promise<void> {
  if (serverUrl.value) return
  try {
    const ping = await (window as any).tintin?.env?.serverPing?.()
    serverUrl.value = String(ping?.url || '')
  } catch (_) {
    serverUrl.value = ''
  }
}

/* ── 图视域（关键字/品牌/型号/类型过滤 + 卡片网格 + 预览） ── */
const kw = ref('')
const brand = ref('')
const model = ref('')
const mType = ref<'' | 'video' | 'image'>('')
const TYPE_TABS: Array<{ v: '' | 'video' | 'image'; t: string }> = [
  { v: '', t: '全部' },
  { v: 'video', t: '视频' },
  { v: 'image', t: '图片' }
]
const items = ref<PickerItem[]>([])
const loading = ref(false)
const error = ref('')

async function run() {
  loading.value = true
  error.value = ''
  try {
    items.value = await fetchMaterialGrid({
      search: kw.value,
      brand: brand.value,
      model: model.value,
      mediaType: mType.value
    })
  } catch (e) {
    items.value = []
    error.value = (e as Error)?.message || String(e)
  } finally {
    loading.value = false
  }
}

function midOf(it: PickerItem): string {
  return String(it?.material_id ?? it?.id ?? '').trim()
}
function mainText(it: PickerItem): string {
  return String(it?.filename || it?.name || midOf(it) || '未命名素材')
}
function subText(it: PickerItem): string {
  const seg = [String(it?.brand || ''), String(it?.model || '')].filter(Boolean).join(' / ')
  return seg
}
function thumbUrl(it: PickerItem): string {
  const mid = midOf(it)
  return mid ? buildMediaThumbUrl(serverUrl.value, mid) : ''
}

/** 缩略图加载失败 → 显示文字块（空库/服务端未生成缩略图时兜底） */
const thumbFailed = ref<Record<number, boolean>>({})
function onThumbError(i: number) {
  thumbFailed.value[i] = true
}

/* 预览区（点卡片加载，不选中；确认按钮才入上下文） */
const preview = ref<PickerItem | null>(null)
const previewKind = computed<'video' | 'image'>(() =>
  String(preview.value?.media_type || '').toLowerCase() === 'image' ? 'image' : 'video'
)
const previewUrl = computed(() =>
  preview.value ? buildMediaServeUrl(serverUrl.value, midOf(preview.value)) : ''
)
function showPreview(it: PickerItem) {
  preview.value = it
}
function confirmPick() {
  if (!preview.value) return
  emit('pick', preview.value)
  emit('close')
}

/* ── 音频域（关键字 + 分类过滤 + 列表 + 底部播放条） ── */
const aKw = ref('')
const aCat = ref('')
const cats = ref<string[]>([])
const aItems = ref<PickerItem[]>([])
const aLoading = ref(false)
const aError = ref('')

async function runAudio() {
  aLoading.value = true
  aError.value = ''
  try {
    aItems.value = await fetchAudioLibrary({ keyword: aKw.value, category: aCat.value })
  } catch (e) {
    aItems.value = []
    aError.value = (e as Error)?.message || String(e)
  } finally {
    aLoading.value = false
  }
}

function audioName(it: PickerItem): string {
  return String(it?.filename || it?.title || it?.name || `音频${it?.audio_id ?? ''}`)
}
function audioSub(it: PickerItem): string {
  const seg = [String(it?.category || ''), String(it?.genre || '')].filter(Boolean).join(' / ')
  const dur = Number(it?.duration || it?.duration_sec || 0)
  return dur > 0 ? `${seg}${seg ? ' · ' : ''}${Math.round(dur)}秒` : seg
}

/** 底部播放条当前音频（点列表行切换；<audio> 原生控件播放/进度） */
const currentAudio = ref<PickerItem | null>(null)
const audioUrl = computed(() =>
  currentAudio.value ? buildAudioFileUrl(serverUrl.value, String(currentAudio.value.audio_id ?? currentAudio.value.id ?? '')) : ''
)
function playAudio(it: PickerItem) {
  currentAudio.value = it
}
function confirmAudio() {
  if (!currentAudio.value) return
  emit('pick-audio', currentAudio.value)
  emit('close')
}

/* ── 打开即预载两域（弹窗每次打开重新加载，原弹窗口径） ── */
watch(
  () => props.visible,
  async (v) => {
    if (!v) {
      preview.value = null
      currentAudio.value = null
      thumbFailed.value = {}
      return
    }
    preview.value = null
    currentAudio.value = null
    thumbFailed.value = {}
    void ensureServerUrl()
    void run()
    void runAudio()
    if (!cats.value.length) cats.value = await fetchAudioCategories()
  },
  { immediate: true }
)
</script>

<template>
  <!-- 2026-08-31 用户裁决：弹窗 80% 主界面，vw/vh 随窗口缩放 -->
  <TDialog :visible="visible" title="选择素材" width="80vw" :show-footer="false" @close="emit('close')">
    <div class="mtd">
      <div class="mtd-tabs">
        <button class="mtd-tab" :class="{ active: tab === 'av' }" type="button" @click="tab = 'av'">图片 / 视频</button>
        <button class="mtd-tab" :class="{ active: tab === 'audio' }" type="button" @click="tab = 'audio'">音频</button>
      </div>

      <!-- ─── Tab1 图片/视频 ─── -->
      <div v-show="tab === 'av'" class="mtd-av">
        <div class="mtd-filter">
          <input v-model="kw" class="mtd-input" placeholder="搜索文件名/关键字…" @keydown.enter="run()" />
          <input v-model="brand" class="mtd-input mtd-input--sm" placeholder="品牌过滤…" @keydown.enter="run()" />
          <input v-model="model" class="mtd-input mtd-input--sm" placeholder="型号过滤…" @keydown.enter="run()" />
          <div class="mtd-seg">
            <button
              v-for="t in TYPE_TABS"
              :key="t.v"
              class="mtd-seg-btn"
              :class="{ active: mType === t.v }"
              type="button"
              @click="mType = t.v"
            >
              {{ t.t }}
            </button>
          </div>
          <button class="mtd-btn" :disabled="loading" @click="run()">搜索</button>
        </div>

        <div class="mtd-av-body">
          <div class="mtd-grid-wrap">
            <div v-if="loading" class="mtd-state">加载中…</div>
            <div v-else-if="error" class="mtd-state mtd-state--error">{{ error }}</div>
            <div v-else-if="!items.length" class="mtd-state">未找到匹配的素材，换个条件试试。</div>
            <div v-else class="mtd-grid">
              <button
                v-for="(it, i) in items"
                :key="midOf(it) || i"
                class="mtd-card"
                :class="{ active: preview === it }"
                type="button"
                :title="`${mediaTypeLabel(String(it?.media_type || ''))}·点击预览`"
                @click="showPreview(it)"
              >
                <img
                  v-if="thumbUrl(it) && !thumbFailed[i]"
                  class="mtd-thumb"
                  :src="thumbUrl(it)"
                  loading="lazy"
                  alt=""
                  @error="onThumbError(i)"
                />
                <span v-else class="mtd-thumb mtd-thumb--ph">{{ mediaTypeLabel(String(it?.media_type || '')) }}</span>
                <span class="mtd-card-main">{{ mainText(it) }}</span>
                <span v-if="subText(it)" class="mtd-card-sub">{{ subText(it) }}</span>
              </button>
            </div>
          </div>

          <div class="mtd-preview">
            <div class="mtd-preview-box">
              <video v-if="preview && previewKind === 'video' && previewUrl" :src="previewUrl" controls autoplay muted class="mtd-preview-media" />
              <img v-else-if="preview && previewKind === 'image' && previewUrl" :src="previewUrl" class="mtd-preview-media" alt="素材预览" />
              <div v-else class="mtd-state">点击左侧卡片预览（视频/图片）</div>
            </div>
            <div v-if="preview" class="mtd-preview-info">
              <span class="mtd-preview-name">{{ mainText(preview) }}</span>
              <span v-if="subText(preview)" class="mtd-preview-sub">{{ subText(preview) }}</span>
            </div>
            <button class="mtd-btn mtd-btn--full" :disabled="!preview" @click="confirmPick()">选择该素材</button>
          </div>
        </div>
      </div>

      <!-- ─── Tab2 音频 ─── -->
      <div v-show="tab === 'audio'" class="mtd-au">
        <div class="mtd-filter">
          <input v-model="aKw" class="mtd-input" placeholder="搜索音频名称/关键字…" @keydown.enter="runAudio()" />
          <select v-model="aCat" class="mtd-input mtd-input--sm" @change="runAudio()">
            <option value="">全部分类</option>
            <option v-for="c in cats" :key="c" :value="c">{{ c }}</option>
          </select>
          <button class="mtd-btn" :disabled="aLoading" @click="runAudio()">搜索</button>
        </div>

        <div class="mtd-au-list">
          <div v-if="aLoading" class="mtd-state">加载中…</div>
          <div v-else-if="aError" class="mtd-state mtd-state--error">{{ aError }}</div>
          <div v-else-if="!aItems.length" class="mtd-state">未找到匹配的音频，换个条件试试。</div>
          <button
            v-for="(it, i) in aItems"
            v-else
            :key="String(it?.audio_id ?? it?.id ?? i)"
            class="mtd-au-row"
            :class="{ active: currentAudio === it }"
            type="button"
            :title="audioName(it)"
            @click="playAudio(it)"
          >
            <span class="mtd-au-main">{{ audioName(it) }}</span>
            <span v-if="audioSub(it)" class="mtd-au-sub">{{ audioSub(it) }}</span>
          </button>
        </div>

        <!-- 底部播放条（<audio> 原生控件：播放/暂停/进度/音量） -->
        <div class="mtd-player">
          <span class="mtd-player-name">{{ currentAudio ? audioName(currentAudio) : '点击列表中的音频试听' }}</span>
          <audio v-if="currentAudio && audioUrl" :src="audioUrl" controls class="mtd-player-audio" />
          <button class="mtd-btn" :disabled="!currentAudio" @click="confirmAudio()">选择该音频</button>
        </div>
      </div>

      <p class="mtd-tip">图视素材来自服务端素材库，音频来自音频库；为空时可先在「素材检索」页确认是否已入库。</p>
    </div>
  </TDialog>
</template>

<style scoped>
.mtd {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  height: calc(80vh - 140px);
}

.mtd-tabs {
  display: flex;
  gap: var(--space-2);
  border-bottom: 1px solid var(--border);
  padding-bottom: var(--space-2);
}
.mtd-tab {
  padding: 6px 16px;
  font-size: var(--font-size-body);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--muted-foreground);
  transition: all var(--duration-fast);
}
.mtd-tab:hover { color: var(--primary); }
.mtd-tab.active {
  background: var(--primary);
  border-color: var(--primary);
  color: var(--primary-foreground);
}

.mtd-filter {
  display: flex;
  gap: var(--space-2);
  align-items: center;
  flex-wrap: wrap;
}
.mtd-input {
  flex: 1 1 160px;
  height: 32px;
  padding: 0 var(--space-3);
  background: var(--surface-container);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  color: var(--foreground);
  font-size: var(--font-size-body);
  outline: none;
}
.mtd-input:focus { border-color: var(--primary); box-shadow: 0 0 0 3px var(--ring); }
.mtd-input--sm { flex: 0 1 140px; }
.mtd-btn {
  height: 32px;
  padding: 0 var(--space-4);
  border-radius: var(--radius-md);
  background: var(--primary);
  color: var(--primary-foreground);
  font-size: var(--font-size-body);
  transition: filter var(--duration-fast);
}
.mtd-btn:hover { filter: brightness(1.1); }
.mtd-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.mtd-btn--full { width: 100%; }

.mtd-seg { display: flex; gap: 0; }
.mtd-seg-btn {
  height: 32px;
  padding: 0 12px;
  font-size: 12px;
  border: 1px solid var(--border);
  border-right: none;
  background: var(--surface-container);
  color: var(--muted-foreground);
  transition: all var(--duration-fast);
}
.mtd-seg-btn:first-child { border-radius: var(--radius-md) 0 0 var(--radius-md); }
.mtd-seg-btn:last-child { border-right: 1px solid var(--border); border-radius: 0 var(--radius-md) var(--radius-md) 0; }
.mtd-seg-btn.active {
  background: var(--primary);
  border-color: var(--primary);
  color: var(--primary-foreground);
}

.mtd-av { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; gap: var(--space-3); }
.mtd-av-body { flex: 1 1 auto; min-height: 0; display: flex; gap: var(--space-3); }
.mtd-grid-wrap { flex: 1 1 auto; min-width: 0; overflow-y: auto; }
.mtd-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: var(--space-2);
}
.mtd-card {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: var(--space-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--surface-container);
  text-align: left;
  transition: all var(--duration-fast);
}
.mtd-card:hover { border-color: var(--primary); }
.mtd-card.active { border-color: var(--primary); box-shadow: 0 0 0 2px var(--ring); }
.mtd-thumb {
  width: 100%;
  aspect-ratio: 16 / 10;
  object-fit: cover;
  border-radius: var(--radius-sm);
  background: var(--surface-container-high);
}
.mtd-thumb--ph {
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  color: var(--muted-foreground);
}
.mtd-card-main {
  font-size: 12px;
  color: var(--foreground);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mtd-card-sub {
  font-size: 11px;
  color: var(--muted-foreground);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mtd-preview {
  flex: 0 0 300px;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.mtd-preview-box {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--surface-container);
  overflow: hidden;
}
.mtd-preview-media { max-width: 100%; max-height: 100%; }
.mtd-preview-info { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.mtd-preview-name {
  font-size: 12px;
  color: var(--foreground);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mtd-preview-sub { font-size: 11px; color: var(--muted-foreground); }

.mtd-au { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; gap: var(--space-3); }
.mtd-au-list {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.mtd-au-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--surface-container);
  text-align: left;
  transition: all var(--duration-fast);
}
.mtd-au-row:hover { border-color: var(--primary); }
.mtd-au-row.active { border-color: var(--primary); box-shadow: 0 0 0 2px var(--ring); }
.mtd-au-main {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 13px;
  color: var(--foreground);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mtd-au-sub { flex: 0 0 auto; font-size: 11px; color: var(--muted-foreground); }

.mtd-player {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--surface-container);
}
.mtd-player-name {
  flex: 0 1 220px;
  min-width: 0;
  font-size: 12px;
  color: var(--foreground);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mtd-player-audio { flex: 1 1 auto; height: 32px; }

.mtd-state {
  padding: var(--space-6) var(--space-3);
  text-align: center;
  font-size: var(--font-size-body);
  color: var(--muted-foreground);
}
.mtd-state--error { color: var(--destructive, #e5484d); }

.mtd-tip { font-size: 12px; color: var(--muted-foreground); }
</style>
