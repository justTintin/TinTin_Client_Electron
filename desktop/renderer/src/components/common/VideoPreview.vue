<script setup lang="ts">
/**
 * VideoPreview 视频预览弹窗组件
 * 使用 VideoPlayer（基于 plyr）实现完整播放控制。
 * src 可为本地文件路径或网络 URL。
 */
import { ref } from 'vue'
import VideoPlayer from './VideoPlayer.vue'

const props = withDefaults(
  defineProps<{
    /** 是否可见 */
    visible?: boolean
    /** 视频地址（URL 或文件路径） */
    src?: string
    /** 是否循环播放 */
    loop?: boolean
  }>(),
  {
    visible: false,
    src: '',
    loop: false
  }
)

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'ended'): void
}>()

// 视频加载失败标记
const hasError = ref(false)

function handleClose() {
  emit('close')
}

// 点击遮罩关闭
function handleMaskClick(event: MouseEvent) {
  if (event.target === event.currentTarget) {
    handleClose()
  }
}

// 视频加载失败
function handleError() {
  hasError.value = true
}
</script>

<template>
  <Transition name="t-video">
    <div v-if="visible" class="video-preview__mask" @click="handleMaskClick">
      <div class="video-preview" @click.stop>
        <!-- 顶部条：标题 + 关闭按钮 -->
        <div class="video-preview__bar">
          <span class="video-preview__title" :title="src">{{ src }}</span>
          <button class="video-preview__close" title="关闭" @click="handleClose">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <!-- 视频容器 -->
        <div class="video-preview__stage">
          <VideoPlayer
            v-if="src && !hasError"
            :src="src"
            autoplay
            :loop="loop"
            @error="handleError"
            @ended="emit('ended')"
          />
          <!-- 加载失败提示 -->
          <div v-else class="video-preview__error">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round">
              <polygon points="23 7 16 12 23 17 23 7" />
              <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
            </svg>
            <span>{{ hasError ? '视频加载失败，请检查路径或格式' : '暂无视频源' }}</span>
          </div>
        </div>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.video-preview__mask {
  position: fixed;
  inset: 0;
  z-index: var(--z-modal);
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.75);
}

.video-preview {
  display: flex;
  flex-direction: column;
  width: min(960px, 90vw);
  max-height: 90vh;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-xl);
  box-shadow: var(--shadow-modal);
  overflow: hidden;
}

.video-preview__bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  border-bottom: 1px solid var(--border-subtle);
}

.video-preview__title {
  flex: 1;
  font-size: var(--font-size-caption);
  color: var(--muted-foreground);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono);
}

.video-preview__close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  color: var(--muted-foreground);
  border-radius: var(--radius-sm);
  transition: color var(--duration-fast) var(--easing-default),
    background var(--duration-fast) var(--easing-default);
}

.video-preview__close:hover {
  color: var(--foreground);
  background: var(--surface-container-high);
}

.video-preview__stage {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #000;
  min-height: 280px;
}

.video-preview__error {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-8);
  color: var(--muted-foreground);
  font-size: var(--font-size-caption);
}

/* 过渡动画 */
.t-video-enter-active,
.t-video-leave-active {
  transition: opacity var(--duration-normal) var(--easing-default);
}

.t-video-enter-active .video-preview,
.t-video-leave-active .video-preview {
  transition: transform var(--duration-normal) var(--easing-default),
    opacity var(--duration-normal) var(--easing-default);
}

.t-video-enter-from,
.t-video-leave-to {
  opacity: 0;
}

.t-video-enter-from .video-preview,
.t-video-leave-to .video-preview {
  transform: scale(0.96);
  opacity: 0;
}
</style>
