<script setup lang="ts">
// ═══════════════════════════════════════════════════════════════
// VsrFrameScrubber.vue — 视频去字幕·逐帧时间轴把手（铁律 10 P6，2026-09-19）
// 自 SubtitleRemoval.vue 逐字搬迁（IRON-02 五项 checklist）。
// 机械适配（语义不变）：① scrubDown/scrubMove 的 seekToTime 内联调用改
//   emit('seek', t)——逐帧量化/钳制/预览视频 seek 留在父组件 @seek 处原样执行；
//   ② durationS/fps/currentT/srcPath → props（模板 is-disabled 绑定改用 disabled）。
// 原口径：拖拽把手逐帧 seek，刻度按帧间隔对齐，框选随帧更新。
// ═══════════════════════════════════════════════════════════════
import { ref, computed } from 'vue'

const props = defineProps<{
  durationS: number
  fps: number
  currentT: number
  disabled?: boolean
}>()
const emit = defineEmits<{ (e: 'seek', t: number): void }>()

// ── 时间轴把手：拖拽把手 → 逐帧 seek 预览视频（框选随帧更新）──
const scrubEl = ref<HTMLElement | null>(null)
// 拖拽态用 ref：模板需要它切换把手 grabbing 光标
const scrubbing = ref(false)
function scrubRatio(clientX: number): number {
  const el = scrubEl.value
  if (!el || !props.durationS) return 0
  const rect = el.getBoundingClientRect()
  return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
}
function scrubDown(e: PointerEvent): void {
  if (!props.durationS) return
  scrubbing.value = true
  emit('seek', scrubRatio(e.clientX) * props.durationS)
}
function scrubMove(e: PointerEvent): void {
  if (!scrubbing.value) return
  emit('seek', scrubRatio(e.clientX) * props.durationS)
}
function scrubUp(): void {
  scrubbing.value = false
}
const scrubPct = computed(() =>
  props.durationS ? `${(props.currentT / props.durationS) * 100}%` : '0%')
function fmtTime(s: number): string {
  if (!Number.isFinite(s) || s < 0) s = 0
  const m = Math.floor(s / 60)
  const sec = s - m * 60
  return `${String(m).padStart(2, '0')}:${sec.toFixed(2).padStart(5, '0')}`
}

// ── 帧刻度细分（fps>0 时把手按帧间隔显示刻度线，拖拽对齐到帧）──
const totalFrames = computed(() =>
  props.fps > 0 ? Math.max(0, Math.round(props.durationS * props.fps)) : 0)
const frameIdx = computed(() =>
  props.fps > 0 ? Math.max(0, Math.floor(props.currentT * props.fps)) : -1)
/** 刻度步长（帧）：控制在约 32 条以内，并归整到友好步长（1/2/5×10^k） */
const tickStep = computed(() => {
  const total = totalFrames.value
  if (total <= 0) return 0
  const step = Math.max(1, Math.ceil(total / 32))
  const mag = Math.pow(10, Math.floor(Math.log10(step)))
  const norm = step / mag
  const nice = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10
  return nice * mag
})
const tickList = computed(() => {
  const step = tickStep.value
  const total = totalFrames.value
  if (step <= 0 || total <= 0) return [] as number[]
  const out: number[] = []
  for (let f = 0; f <= total; f += step) out.push(f)
  return out
})
const frameTickPct = (f: number) =>
  totalFrames.value ? `${(f / totalFrames.value) * 100}%` : '0%'

</script>

<template>
          <!-- 时间轴把手：拖拽到目标帧（逐帧），当前帧同步到上方预览 -->
</template>

<style scoped>
/* 时间轴把手（逐帧拖拽；2026-09-07 用户裁决：做成明显把手形态，加大热区好拖） */
.frame-scrub {
  padding: var(--space-2) var(--space-2) var(--space-3);
  cursor: grab;
  user-select: none;
  touch-action: none;
}
.frame-scrub.is-scrubbing {
  cursor: grabbing;
}
.frame-scrub.is-scrubbing .frame-scrub__handle {
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--primary) 22%, transparent);
}
.frame-scrub.is-disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.frame-scrub__track {
  position: relative;
  height: 22px;
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--foreground) 8%, var(--surface-container-high));
  border: 1px solid var(--border-subtle);
}
.frame-scrub__tick {
  position: absolute;
  top: 5px;
  bottom: 5px;
  width: 1px;
  background: color-mix(in srgb, var(--foreground) 22%, transparent);
  pointer-events: none;
}
.frame-scrub__fill {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--primary) 30%, transparent);
}
.frame-scrub__handle {
  position: absolute;
  top: 50%;
  width: 18px;
  height: 28px;
  margin-left: -9px;
  transform: translateY(-50%);
  border-radius: 6px;
  background: var(--surface);
  border: 2px solid var(--primary);
  box-sizing: border-box;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.25);
  /* 抓握纹理：竖向棱纹，看起来可拖 */
  background-image: repeating-linear-gradient(
    to right,
    transparent 0 3px,
    color-mix(in srgb, var(--primary) 45%, transparent) 3px 5px
  );
  background-position: center;
  background-size: 9px 12px;
  background-repeat: no-repeat;
}
.frame-scrub__meta {
  display: flex;
  align-items: baseline;
  gap: 4px;
  margin-top: 3px;
  font-size: 11px;
  color: var(--muted-foreground);
  font-variant-numeric: tabular-nums;
}
.frame-scrub__time {
  color: var(--foreground);
}
</style>