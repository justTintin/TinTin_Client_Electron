<script setup lang="ts">
/**
 * VideoPlayer.vue — 全局视频播放器组件（基于 plyr）
 * 功能：倍速/字幕/快捷键/画中画/全屏/音量/进度
 * 支持本地路径（file://）和网络 URL
 */
import { ref, onMounted, onBeforeUnmount, watch, nextTick } from 'vue'
import Plyr from 'plyr'
import 'plyr/dist/plyr.css'

const props = withDefaults(
  defineProps<{
    /** 视频地址（URL 或文件路径） */
    src?: string
    /** 是否自动播放 */
    autoplay?: boolean
    /** 是否循环播放 */
    loop?: boolean
    /** 是否静音 */
    muted?: boolean
    /** 自定义配置（覆盖默认） */
    options?: Plyr.Options
  }>(),
  {
    src: '',
    autoplay: false,
    loop: false,
    muted: false,
    options: () => ({})
  }
)

const emit = defineEmits<{
  (e: 'play'): void
  (e: 'pause'): void
  (e: 'ended'): void
  (e: 'error', error: Event): void
}>()

const videoRef = ref<HTMLVideoElement | null>(null)
let player: Plyr | null = null

// 处理视频源：Electron 下本地路径需要 file:// 协议
function resolveSrc(src: string): string {
  if (!src) return ''
  if (/^(https?|blob|file|data):/i.test(src)) return src
  const normalized = src.replace(/\\/g, '/')
  return `file://${normalized}`
}

// 初始化 plyr
function initPlayer() {
  if (!videoRef.value || player) return

  const defaultOptions: Plyr.Options = {
    controls: [
      'play-large',
      'play',
      'progress',
      'current-time',
      'duration',
      'mute',
      'volume',
      'settings',
      'pip',
      'airplay',
      'fullscreen'
    ],
    settings: ['captions', 'quality', 'speed'],
    speed: { selected: 1, options: [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2] },
    keyboard: { focused: true, global: true },
    tooltips: { controls: true, seek: true },
    i18n: {
      play: '播放',
      pause: '暂停',
      speed: '速度',
      normal: '正常',
      quality: '质量',
      loop: '循环',
      start: '开始',
      end: '结束',
      all: '全部',
      reset: '重置',
      disabled: '已禁用',
      advertisement: '广告',
      seek: '进度',
      seekLabel: '{currentTime} / {duration}',
      played: '已播放',
      currentTime: '当前时间',
      duration: '总时长',
      volume: '音量',
      muted: '已静音',
      enterFullscreen: '进入全屏',
      exitFullscreen: '退出全屏',
      frameTitle: '播放器',
      captions: '字幕',
      enabled: '已启用',
      disable: '禁用',
      menuBack: '返回',
      download: '下载',
      qualityBadge: {
        2160: '4K',
        1440: 'HD',
        1080: 'HD',
        720: 'HD',
        576: 'SD',
        480: 'SD'
      }
    }
  }

  const mergedOptions = { ...defaultOptions, ...props.options }
  player = new Plyr(videoRef.value, mergedOptions)

  // 事件转发
  player.on('play', () => emit('play'))
  player.on('pause', () => emit('pause'))
  player.on('ended', () => emit('ended'))
  player.on('error', (event: Event) => emit('error', event))
}

// 销毁 plyr
function destroyPlayer() {
  if (player) {
    player.destroy()
    player = null
  }
}

// 监听 src 变化
watch(
  () => props.src,
  () => {
    if (player) {
      player.source = {
        type: 'video',
        sources: [{ src: resolveSrc(props.src), type: 'video/mp4' }]
      }
    }
  }
)

onMounted(() => {
  nextTick(() => {
    initPlayer()
    if (props.autoplay && player) {
      player.play().catch(() => {})
    }
  })
})

onBeforeUnmount(() => {
  destroyPlayer()
})
</script>

<template>
  <div class="video-player">
    <video
      v-if="src"
      ref="videoRef"
      :src="resolveSrc(src)"
      :loop="loop"
      :muted="muted"
      playsinline
    />
    <div v-else class="video-player__empty">
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2">
        <polygon points="23 7 16 12 23 17 23 7" />
        <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
      </svg>
      <span>暂无视频源</span>
    </div>
  </div>
</template>

<style scoped>
.video-player {
  width: 100%;
  background: #000;
  border-radius: var(--radius-md);
  overflow: hidden;
}

.video-player :deep(.plyr) {
  width: 100%;
  border-radius: var(--radius-md);
}

.video-player :deep(.plyr__control) {
  color: var(--foreground);
}

.video-player :deep(.plyr__control:hover) {
  background: var(--primary);
  color: var(--primary-foreground);
}

.video-player :deep(.plyr__progress__buffer) {
  background: rgba(255, 255, 255, 0.2);
}

.video-player :deep(.plyr--full-ui input[type='range']) {
  color: var(--primary);
}

.video-player__empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-3);
  padding: var(--space-8);
  color: var(--muted-foreground);
  font-size: var(--font-size-caption);
  min-height: 280px;
}
</style>
