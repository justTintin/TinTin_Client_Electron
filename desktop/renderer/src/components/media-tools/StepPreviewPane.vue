<template>
  <div class="spp-root">
    <div class="spp-head">
      <span class="spp-title">{{ title }}</span>
      <span v-if="items.length" class="spp-count">{{ items.length }} 条</span>
    </div>
    <div v-if="items.length" class="spp-grid">
      <div
        v-for="(it, i) in items" :key="i"
        class="spp-item" :class="{ active: i === activeIndex }"
        :title="it.tip || ''"
        @click="$emit('select', i)"
      >
        <span class="spp-badge">{{ it.badge }}</span>
        <span v-if="it.tag" class="spp-tag" :class="it.tagClass">{{ it.tag }}</span>
        <!-- 块内播放器：src 直播；连播序列（seqList）仅激活块播放，ended 自动切下一段循环 -->
        <video
          v-if="playSrc(i)"
          class="spp-video"
          :src="playSrc(i)"
          controls
          muted
          preload="metadata"
          @ended="onEnded(i)"
        />
        <div v-else class="spp-empty">
          <span>{{ it.placeholder || '暂无预览' }}</span>
          <span v-if="it.seqList?.length" class="spp-empty-hint">单击块连播预览</span>
        </div>
        <!-- 特效叠加预览层（Step4）：底部字幕 + 顶部关键词，样式随左侧配置实时联动 -->
        <div v-if="it.subtitle" class="spp-sub" :style="it.subtitleStyle">{{ it.subtitle }}</div>
        <div v-if="it.keywords && it.keywords.length" class="spp-kw">
          <span v-for="(k, ki) in it.keywords" :key="ki" class="spp-kw-item" :style="k.style">{{ k.text }}</span>
        </div>
      </div>
    </div>
    <div v-else class="spp-empty-all">{{ emptyText }}</div>
  </div>
</template>

<script setup lang="ts">
/**
 * 步骤预览面板（2026-09-10 用户需求「界面统一+联动预览」）：
 * Step2/3/4 右栏统一的多块视频预览——按合成条数显示网格块，
 * 每块左上角标「第 N 条」，支持状态 tag 与特效叠加层。
 * 连播序列（seqList）只在激活块播放（ended 事件循环推进），避免多块同时解码。
 */
import { ref, watch } from 'vue'

export interface StepPreviewKeyword {
  text: string
  style?: Record<string, string | number>
}
export interface StepPreviewItem {
  /** 左上角条数角标（如「第 1 条」） */
  badge: string
  /** 直接可播视频源（确认成片/配音视频/候选视频） */
  src?: string
  /** 连播序列（未确认方案的镜头列表；仅激活块播放，ended 循环） */
  seqList?: string[]
  /** 无源时的占位文案 */
  placeholder?: string
  /** 右上状态标签（待配音/配音中/已配音/成片…） */
  tag?: string
  tagClass?: string
  tip?: string
  /** 底部字幕叠加（特效预览） */
  subtitle?: string
  subtitleStyle?: Record<string, string | number>
  /** 顶部关键词叠加（文字模板/花字特效预览） */
  keywords?: StepPreviewKeyword[]
}

const props = withDefaults(defineProps<{
  title: string
  items: StepPreviewItem[]
  activeIndex?: number
  emptyText?: string
}>(), { activeIndex: -1, emptyText: '' })

defineEmits<{ (e: 'select', index: number): void }>()

// 连播状态：同一时刻只有激活块在连播（ended → 下一段，尾段回 0 循环）
const seqIdx = ref(0)
watch(() => props.activeIndex, () => { seqIdx.value = 0 })

function playSrc(i: number): string {
  const it = props.items[i]
  if (!it) return ''
  if (it.src) return it.src
  const seq = it.seqList || []
  if (seq.length && i === props.activeIndex) return seq[seqIdx.value % seq.length]
  return ''
}

function onEnded(i: number): void {
  const it = props.items[i]
  const seq = it?.seqList || []
  if (seq.length > 1) seqIdx.value = (seqIdx.value + 1) % seq.length
}
</script>

<style scoped>
.spp-root {
  display: flex; flex-direction: column; gap: 6px;
  height: 100%; min-height: 0;
}
.spp-head { display: flex; align-items: center; gap: 8px; }
.spp-title { font-weight: 600; font-size: 13px; color: var(--foreground); }
.spp-count { font-size: 12px; color: var(--muted-foreground); }

.spp-grid {
  display: grid; grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px; align-content: start;
  overflow-y: auto; flex: 1; min-height: 0;
  padding-right: 2px;
}
.spp-item {
  position: relative; overflow: hidden;
  border: 1px solid var(--border); border-radius: 6px;
  background: #000; cursor: pointer; min-height: 148px;
  display: flex; align-items: center; justify-content: center;
}
.spp-item.active { border-color: var(--primary); box-shadow: 0 0 0 2px var(--ring); }
.spp-badge {
  position: absolute; top: 4px; left: 4px; z-index: 3;
  background: rgba(0, 0, 0, 0.65); color: #fff;
  font-size: 11px; line-height: 1; padding: 3px 7px; border-radius: 3px;
  pointer-events: none;
}
.spp-tag {
  position: absolute; top: 4px; right: 4px; z-index: 3;
  background: rgba(0, 0, 0, 0.65); color: #ddd;
  font-size: 11px; line-height: 1; padding: 3px 7px; border-radius: 3px;
  pointer-events: none;
}
.spp-tag.ok { color: #7ee787; }
.spp-tag.busy { color: #ffd24d; }

.spp-video {
  width: 100%; height: 176px; object-fit: contain; background: #000; display: block;
}
.spp-empty {
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px;
  height: 176px; padding: 8px; text-align: center;
  color: var(--muted-foreground); font-size: 12px;
  background: linear-gradient(135deg, #3a3f4a 0%, #23262e 100%);
}
.spp-empty-hint { font-size: 11px; opacity: 0.8; }
.spp-empty-all {
  flex: 1; min-height: 148px; display: flex; align-items: center; justify-content: center;
  border: 1px dashed var(--border); border-radius: 6px;
  color: var(--muted-foreground); font-size: 12px; padding: 12px; text-align: center;
  background: linear-gradient(135deg, #3a3f4a 0%, #23262e 100%);
}

/* 特效叠加层（Step4 预览）：坐标随块内画面 contain 居中近似 */
.spp-sub {
  position: absolute; bottom: 6px; left: 0; right: 0; z-index: 2;
  text-align: center; padding: 0 6px; pointer-events: none;
  color: #fff; font-size: 13px; font-weight: 600;
  text-shadow: 0 0 3px rgba(0, 0, 0, 0.9), 0 1px 2px rgba(0, 0, 0, 0.8);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.spp-kw {
  position: absolute; top: 24px; left: 0; right: 0; z-index: 2;
  display: flex; justify-content: center; gap: 6px; pointer-events: none; flex-wrap: wrap;
}
.spp-kw-item {
  font-size: 14px; font-weight: 700; color: #ffd24d;
  text-shadow: 0 0 3px rgba(0, 0, 0, 0.9), 0 0 2px #ff8800;
}
</style>
