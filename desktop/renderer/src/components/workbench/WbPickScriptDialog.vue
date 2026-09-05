<script setup lang="ts">
// WbPickScriptDialog.vue — 选择分镜脚本弹窗（工作台输入区上下文）
// 原版 _ScriptPickerDialog（L957-1024）+ _pick_script L1830-1838：
// 单选，选中后由容器按 id 去重加入脚本胶囊；列表行为
// 「[主题] N镜 · 保存时间」（原版 L1012-1014 同口径）。
// 2026-09-04 用户裁决（预览模式）：对齐产品弹窗——左侧列表仅预览选择，
// 点行切换右侧脚本基本信息（详情拉取 GET /api/storyboard/scripts/{id}，
// parseScriptDetail 解析：基本信息 + 关联产品 + 镜头概要），
// 预览区下方「选择该脚本」按钮才真正选中（预览与选中语义分离）。
import { ref } from 'vue'
import WbPickerDialog from './WbPickerDialog.vue'
import { fetchScripts, type PickerItem } from '@/composables/useWorkbenchPickers'
import { parseScriptDetail, type ScriptDetail } from '@/composables/opsStoryboardLogic'
import { getTintin } from '@/composables/useSettingsConfig'

defineProps<{ visible: boolean }>()
const emit = defineEmits<{
  (e: 'close'): void
  (e: 'pick', item: PickerItem): void
}>()

/** 行主文案：[主题] N镜（原版 L1012） */
function mainText(it: PickerItem): string {
  return `[${String(it.topic || '')}] ${Number(it.shot_count || 0)}镜`
}

/** 行副文案：画幅 · 保存时间（原版 L1013-1014） */
function subText(it: PickerItem): string {
  const parts: string[] = []
  const ratio = String(it.ratio || '').trim()
  if (ratio) parts.push(ratio)
  const saved = String(it.saved_at || '').trim()
  if (saved) parts.push(saved)
  return parts.join(' · ')
}

/* ── 右侧预览：脚本详情（点行拉取；离线/失败回退仅列表摘要字段） ── */
const detail = ref<ScriptDetail | null>(null)
const detailLoading = ref(false)
const detailError = ref('')

async function onPreview(it: PickerItem): Promise<void> {
  detail.value = null
  detailError.value = ''
  const id = String(it.id || '').trim()
  if (!id) return
  const t = getTintin()
  if (!t?.server) { detailError.value = '无法连接服务端，仅显示列表信息。'; return }
  detailLoading.value = true
  try {
    const data = await t.server.get(`/api/storyboard/scripts/${encodeURIComponent(id)}`, {})
    if (data === null || data === undefined) throw new Error('无法连接服务端。')
    if (typeof data === 'object' && 'error' in (data as Record<string, unknown>)) {
      throw new Error(String((data as Record<string, unknown>).error || '加载失败'))
    }
    detail.value = parseScriptDetail(data)
  } catch (e) {
    detailError.value = e instanceof Error ? e.message : String(e)
  } finally {
    detailLoading.value = false
  }
}

/** 产品摘要行：品类 / 品牌 / 型号（详情 product 域，空域不显示行） */
function productLine(it: PickerItem): Array<{ label: string; value: string }> {
  const p = detail.value?.product || {}
  const lines: Array<{ label: string; value: string }> = []
  const pairs: Array<[string, string]> = [
    ['品类', String(p.category || '')],
    ['品牌', String(p.brand || '')],
    ['型号', String(p.model || '')],
    ['名称', String(p.name || '')],
  ]
  for (const [label, value] of pairs) {
    if (value.trim()) lines.push({ label, value: value.trim() })
  }
  return lines
}

/** 镜头概要行：镜别 · 时长s · 画面（截断展示，对齐分镜表口径） */
function shotLines(): string[] {
  const shots = detail.value?.shots || []
  return shots.map((sh, i) => {
    const type = String(sh.shot_type || '').trim() || '—'
    const dur = String(sh.duration ?? '').trim()
    const visual = String(sh.visual || '').trim()
    const seg = [`${i + 1}. ${type}`, dur ? `${dur}s` : ''].filter(Boolean).join(' · ')
    return visual ? `${seg} — ${visual}` : seg
  })
}
</script>

<template>
  <WbPickerDialog
    :visible="visible"
    title="选择分镜脚本"
    placeholder="输入主题搜索脚本…"
    tip="脚本来自服务端分镜脚本库；为空时可先在「分镜脚本创作」页保存脚本。"
    empty-text="未找到匹配的脚本，换个关键词试试。"
    :fetcher="fetchScripts"
    previewable
    @close="emit('close')"
    @preview="onPreview"
    @pick="(it) => emit('pick', it)"
  >
    <template #item="{ item }">
      <span class="row-main">{{ mainText(item) }}</span>
      <span v-if="subText(item)" class="row-sub">{{ subText(item) }}</span>
    </template>

    <template #preview="{ item }">
      <!-- 空态：未选择任何脚本 -->
      <div v-if="!item" class="pv-empty">
        点击左侧脚本查看基本信息与镜头概要
      </div>
      <div v-else class="pv">
        <div class="pv-title">{{ mainText(item) }}</div>

        <!-- 基本信息卡片：镜头数 / 画幅 / 保存时间（列表摘要字段，同步展示） -->
        <div class="pv-card">
          <div class="pv-card-head">
            <svg class="pv-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="10" />
              <path d="M12 6v6l4 2" />
            </svg>
            <span>基本信息</span>
          </div>
          <div class="pv-meta">
            <span class="pv-meta-item"><span class="pv-meta-label">镜头数</span>{{ Number(item.shot_count || 0) }} 镜</span>
            <span v-if="String(item.ratio || '').trim()" class="pv-meta-item"><span class="pv-meta-label">画幅</span>{{ String(item.ratio).trim() }}</span>
            <span v-if="String(item.saved_at || '').trim()" class="pv-meta-item"><span class="pv-meta-label">保存时间</span>{{ String(item.saved_at).trim() }}</span>
          </div>
          <div v-if="detailLoading" class="pv-none">脚本详情加载中…</div>
          <div v-else-if="detailError" class="pv-none">{{ detailError }}</div>
        </div>

        <!-- 关联产品卡片（详情 product 域，脚本创作时绑定的产品上下文） -->
        <div v-if="productLine(item).length" class="pv-card">
          <div class="pv-card-head">
            <svg class="pv-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M20.59 13.41L11 3.83A2 2 0 0 0 9.59 3.24H4a2 2 0 0 0-2 2v5.59a2 2 0 0 0 .59 1.42l9.58 9.58a2 2 0 0 0 2.83 0l5.59-5.59a2 2 0 0 0 0-2.83z" />
              <circle cx="6.5" cy="6.5" r="1" fill="currentColor" stroke="none" />
            </svg>
            <span>关联产品</span>
          </div>
          <div class="pv-meta">
            <span v-for="l in productLine(item)" :key="l.label" class="pv-meta-item">
              <span class="pv-meta-label">{{ l.label }}</span>{{ l.value }}
            </span>
          </div>
        </div>

        <!-- 镜头概要卡片（详情 shots 域，镜别 · 时长 — 画面） -->
        <div v-if="!detailLoading && detail && detail.shots.length" class="pv-card">
          <div class="pv-card-head">
            <svg class="pv-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <rect x="2" y="5" width="14" height="14" rx="2" />
              <path d="M16 10l6-3v10l-6-3" />
            </svg>
            <span>镜头概要</span>
          </div>
          <div class="pv-shots">
            <div v-for="(line, i) in shotLines()" :key="'sh' + i" class="pv-shot">{{ line }}</div>
          </div>
        </div>
      </div>
    </template>

    <template #preview-footer="{ item, confirm }">
      <button class="pv-confirm" title="选中该脚本，加入对话上下文" @click="confirm(item)">
        选择该脚本
      </button>
    </template>
  </WbPickerDialog>
</template>

<style scoped>
.row-main {
  font-size: 13px;
  color: var(--foreground);
}

.row-sub {
  font-size: 12px;
  color: var(--muted-foreground);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ─── 右侧预览区（同产品弹窗 pv-* 风格，scoped 互不影响） ─── */
.pv {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.pv-empty {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  color: var(--muted-foreground);
  text-align: center;
  padding: 0 var(--space-3);
}

.pv-title {
  font-size: 15px;
  font-weight: var(--font-weight-semibold);
  color: var(--foreground);
  padding-bottom: var(--space-2);
  border-bottom: 1px solid var(--border);
}

.pv-card {
  background: var(--surface-container);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  padding: var(--space-3);
}

.pv-card-head {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: var(--font-weight-semibold);
  color: var(--muted-foreground);
  margin-bottom: var(--space-2);
}

.pv-icon {
  color: var(--muted-foreground);
  flex-shrink: 0;
}

/* 信息行（label + 值 网格排布） */
.pv-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px var(--space-4);
}

.pv-meta-item {
  font-size: 13px;
  color: var(--foreground);
}

.pv-meta-label {
  display: inline-block;
  margin-right: 6px;
  font-size: 12px;
  color: var(--muted-foreground);
}

/* 镜头概要行 */
.pv-shots {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.pv-shot {
  font-size: 12px;
  line-height: 1.5;
  color: var(--foreground);
  padding: 5px 10px;
  background: var(--surface-container-high);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  word-break: break-word;
}

.pv-none {
  font-size: 12px;
  color: var(--muted-foreground);
  margin-top: var(--space-2);
}

.pv-confirm {
  padding: 7px var(--space-4);
  font-size: 13px;
  background: var(--primary);
  color: var(--primary-foreground);
  border-radius: var(--radius-md);
  transition: filter var(--duration-fast);
}
.pv-confirm:hover { filter: brightness(1.1); }
</style>
