<script setup lang="ts">
// KeywordAnnotateRows.vue — 字幕关键词标注面板（2026-09-23 用户裁决）
// 每视频一块：字幕段横向平铺（时间戳+文本），命中词按词表序彩色标注。
// 选中文字→右键「标注为关键词」，右键彩色词→「取消标注」。
// 变色为本地乐观更新（立即生效），同时上报父层持久化（localStorage+预览轨重刷）。
import { ref, reactive, watch, onMounted, onUnmounted } from 'vue'

export interface KeywordAnnotateTrack {
  key: string
  name: string
  durationSec: number
  rows: Array<{ text: string; start: number; end: number }>
  hits: Array<{ text: string; start: number; end: number }>
  words: string[]
}
const props = defineProps<{ tracks: KeywordAnnotateTrack[] }>()
const emit = defineEmits<{
  (e: 'add', planKey: string, word: string): void
  (e: 'remove', planKey: string, word: string): void
}>()

function fmt(t: number): string {
  const s = Math.max(0, Number(t) || 0)
  const m = Math.floor(s / 60)
  return `${String(m).padStart(2, '0')}:${(s % 60).toFixed(1).padStart(4, '0')}`
}

// ── 本地词表（乐观更新）：trackKey → 词表。add/remove 先改本地立即变色，
//  同时 emit 给父层持久化；父层权威刷新（props.words 变化）后整体覆盖同步。──
const wordsByKey = reactive<Record<string, string[]>>({})
function wordsOf(key: string, fallback: string[]): string[] {
  return wordsByKey[key] ?? (fallback || [])
}
function syncFromProps(): void {
  for (const t of props.tracks) {
    if (!(t.key in wordsByKey)) wordsByKey[t.key] = [...(t.words || [])]
  }
}
watch(() => props.tracks, (tracks) => {
  // 父层权威刷新落地：覆盖为最新词表（含手工词，add/remove 已同步进存储）
  for (const t of tracks) wordsByKey[t.key] = [...(t.words || [])]
})
watch(() => props.tracks, syncFromProps, { immediate: true })

function hitWord(row: { text: string }, words: string[]): string {
  const t = String(row.text || '').toLowerCase()
  for (const w of words) {
    const k = String(w || '').toLowerCase()
    if (k && t.includes(k)) return String(w)
  }
  return ''
}
function seg(row: { text: string }, words: string[]): { pre: string; kw: string; post: string } {
  const t = String(row.text || '')
  const w = hitWord(row, words)
  if (!w) return { pre: t, kw: '', post: '' }
  const i = t.toLowerCase().indexOf(w.toLowerCase())
  return { pre: t.slice(0, i), kw: t.slice(i, i + w.length), post: t.slice(i + w.length) }
}

// ── 右键菜单：标注 / 取消标注 ──
const menu = ref({ show: false, x: 0, y: 0, planKey: '', word: '', mode: 'add' as 'add' | 'remove' })
function openAdd(planKey: string, rowText: string, e: MouseEvent): void {
  const sel = (window.getSelection?.()?.toString() || '').trim()
  // 必须是本段文本的非空子串（跨段选择不算），长度限 30
  if (!sel || sel.length > 30 || !rowText.includes(sel)) { menu.value.show = false; return }
  menu.value = { show: true, x: e.clientX, y: e.clientY, planKey, word: sel, mode: 'add' }
}
function openRemove(planKey: string, word: string, e: MouseEvent): void {
  menu.value = { show: true, x: e.clientX, y: e.clientY, planKey, word, mode: 'remove' }
}
function confirmMenu(): void {
  const { planKey, word, mode } = menu.value
  // 乐观更新本地词表（立即变色/褪色），再上报父层持久化
  const cur = wordsByKey[planKey] || []
  if (mode === 'add' && !cur.some((x) => x === word)) wordsByKey[planKey] = [...cur, word]
  if (mode === 'remove') wordsByKey[planKey] = cur.filter((x) => x !== word)
  if (mode === 'add') emit('add', planKey, word)
  else emit('remove', planKey, word)
  menu.value.show = false
  try { window.getSelection?.()?.removeAllRanges?.() } catch (_) {}
}
function closeMenu(): void { menu.value.show = false }
onMounted(() => document.addEventListener('click', closeMenu))
onUnmounted(() => document.removeEventListener('click', closeMenu))
</script>

<template>
  <div class="kwar">
    <template v-if="tracks.length">
      <div v-for="(tr, ti) in tracks" :key="tr.key" class="kwar-track">
        <div class="kwar-track-head">
          <span class="kwar-track-name" :title="tr.name">第{{ ti + 1 }}条</span>
          <span class="kwar-track-meta">{{ tr.rows.length }} 段字幕 · 全长 {{ fmt(tr.durationSec) }}</span>
          <span class="kwar-track-hint">选中文字→右键标注为关键词；右键彩色词→取消标注</span>
        </div>
        <!-- 字幕段横向平铺：一段一个[时间戳+文本]，从左到右自动换行 -->
        <div class="kwar-flow">
          <span v-for="(row, ri) in tr.rows" :key="ri" class="kwar-seg"
            @contextmenu.prevent="openAdd(tr.key, String(row.text || ''), $event)">
            <span class="kwar-ts">[{{ fmt(row.start) }}]</span><template v-if="seg(row, wordsOf(tr.key, tr.words)).kw"><span>{{ seg(row, wordsOf(tr.key, tr.words)).pre }}</span><span class="kwar-kw"
              :title="'已标注：' + seg(row, wordsOf(tr.key, tr.words)).kw + '（右键取消标注）'"
              @contextmenu.prevent.stop="openRemove(tr.key, hitWord(row, wordsOf(tr.key, tr.words)), $event)">{{ seg(row, wordsOf(tr.key, tr.words)).kw }}</span><span>{{ seg(row, wordsOf(tr.key, tr.words)).post }}</span></template><template v-else>{{ row.text }}</template>
          </span>
          <span v-if="!tr.rows.length" class="kwar-empty">该视频暂无字幕行（未配音或未生成 timing）</span>
        </div>
      </div>
    </template>
    <div v-else class="kwar-empty">完成上一步配音合成后，这里按视频逐条显示字幕文本，可标注关键词</div>
    <!-- 右键菜单（固定定位跟鼠标；点击页面其他处关闭） -->
    <div v-if="menu.show" class="kwar-menu" :style="{ left: menu.x + 'px', top: menu.y + 'px' }"
      @click.stop @contextmenu.prevent>
      <button class="kwar-menu-item" :class="{ danger: menu.mode === 'remove' }" @click="confirmMenu">
        {{ menu.mode === 'add' ? `标注为关键词：「${menu.word}」` : `取消标注：「${menu.word}」` }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.kwar { display: flex; flex-direction: column; gap: 12px; width: 100%; }
.kwar-track { display: flex; flex-direction: column; gap: 6px; }
.kwar-track-head { display: flex; align-items: baseline; gap: 10px; }
.kwar-track-name { font-size: 13px; font-weight: 700; color: var(--primary); }
.kwar-track-meta { font-size: 12px; color: var(--muted-foreground); }
.kwar-track-hint { margin-left: auto; font-size: 11px; color: var(--muted-foreground); }
/* 字幕段横向平铺（2026-09-23 用户裁决：不再逐行纵向堆叠） */
.kwar-flow {
  display: flex; flex-wrap: wrap; align-content: flex-start;
  gap: 4px 16px; padding: 8px 10px;
  background: var(--surface-container); border-radius: var(--radius-md);
}
.kwar-seg { font-size: 13px; color: var(--foreground); user-select: text; cursor: text; }
.kwar-ts { font-size: 11px; font-weight: 700; color: var(--muted-foreground); font-variant-numeric: tabular-nums; margin-right: 2px; }
.kwar-kw {
  color: var(--primary); font-weight: 700; cursor: context-menu;
  background: color-mix(in srgb, var(--primary) 14%, transparent);
  border-radius: 4px; padding: 0 2px;
}
.kwar-empty { font-size: 12px; color: var(--muted-foreground); }
.kwar-menu {
  position: fixed; z-index: 1200; min-width: 180px; padding: 4px;
  background: var(--card); border: 1px solid var(--border);
  border-radius: var(--radius-md); box-shadow: 0 6px 24px rgba(0, 0, 0, 0.4);
}
.kwar-menu-item {
  display: block; width: 100%; padding: 6px 12px; border: none; border-radius: var(--radius-sm);
  background: none; color: var(--foreground); font-size: 13px; text-align: left; cursor: pointer;
  white-space: nowrap;
}
.kwar-menu-item:hover { background: var(--surface-container); }
.kwar-menu-item.danger { color: var(--destructive, #e5484d); }
.kwar-menu-item.danger:hover { background: color-mix(in srgb, var(--destructive, #e5484d) 12%, transparent); }
</style>
