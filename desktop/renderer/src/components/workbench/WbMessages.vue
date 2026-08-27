<script setup lang="ts">
// WbMessages.vue — 工作台聊天消息主区（纯展示）
// 结构：小屏汉堡按钮 / 消息流（用户/AI 消息与脚本镜头卡片）
// messageListRef 在本组件内部自持：「发送后 nextTick 滚动」经容器桥接到 expose 的
// scrollToBottom，「初始滚动」由本组件 onMounted 完成——与原容器 onMounted 时机等价。
import { ref, nextTick, onMounted } from 'vue'
import type { ChatMessage } from '@/composables/useWorkbenchChat'

defineProps<{
  messages: ChatMessage[]
}>()

const emit = defineEmits<{
  (e: 'toggle-sidebar'): void
}>()

const listRef = ref<HTMLDivElement | null>(null)

/** 原 Workbench 内 scrollToBottom 实现，逐字等价（nextTick 包裹 + scrollTop 置底） */
function scrollToBottom() {
  nextTick(() => {
    const el = listRef.value
    if (el) el.scrollTop = el.scrollHeight
  })
}

/* 原容器级 onMounted(scrollToBottom)，迁移至消息列表归属组件 */
onMounted(() => {
  scrollToBottom()
})

defineExpose({ scrollToBottom })
</script>

<template>
  <!-- ─── 聊天主区 ─── -->
  <main class="chat-main">
    <!-- 小屏下显示侧栏开关（汉堡按钮） -->
    <button class="sidebar-toggle" title="会话列表" aria-label="会话列表" @click="emit('toggle-sidebar')">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <line x1="3" y1="6" x2="21" y2="6" />
        <line x1="3" y1="12" x2="21" y2="12" />
        <line x1="3" y1="18" x2="21" y2="18" />
      </svg>
    </button>
    <div ref="listRef" class="message-list custom-scroll">
      <div class="messages-inner">
        <div
          v-for="m in messages"
          :key="m.id"
          class="message-row"
          :class="m.role"
        >
          <div class="message" :class="m.role">
            <p>{{ m.content }}</p>
            <!-- 脚本镜头卡片（AI 消息附带） -->
            <div v-if="m.shots?.length" class="shots-card">
              <template v-for="shot in m.shots" :key="shot.index">
                <div class="shot-row">
                  <span class="shot-idx">镜头 {{ shot.index }}</span>
                  <span class="shot-label">{{ shot.label }}</span>
                </div>
                <div class="shot-desc">{{ shot.desc }}</div>
              </template>
            </div>
          </div>
        </div>
      </div>
    </div>
  </main>
</template>

<style scoped>
/* ─── 聊天主区 ─── */
.chat-main {
  position: relative;
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  background: var(--background);
}

.message-list {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: var(--space-6);
}

.messages-inner {
  max-width: 48rem;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: var(--space-6);
}

.message-row {
  display: flex;
  width: 100%;
}

.message-row.user {
  justify-content: flex-end;
}

.message-row.ai {
  justify-content: flex-start;
}

.message {
  max-width: 78%;
  padding: 14px 18px;
  border-radius: var(--radius-xl);
  line-height: 1.65;
  font-size: var(--font-size-body);
}

.message.ai {
  background: var(--card);
  color: var(--foreground);
  border: 1px solid var(--border);
  border-bottom-left-radius: 6px;
}

.message.user {
  background: var(--primary);
  color: var(--primary-foreground);
  border-bottom-right-radius: 6px;
}

.message p {
  margin: 0;
}

/* 脚本镜头卡片 */
.shots-card {
  margin-top: var(--space-3);
  background: var(--surface-container);
  border: 1px solid var(--border);
  border-radius: var(--radius-xl);
  padding: var(--space-4);
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.shot-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  font-size: var(--font-size-body);
}

.shot-idx {
  font-weight: 600;
  color: var(--primary);
}

.shot-label {
  color: var(--muted-foreground);
}

.shot-desc {
  font-size: var(--font-size-body);
  color: var(--muted-foreground);
}

/* ─── 小屏侧栏开关（汉堡按钮，桌面隐藏） ─── */
.sidebar-toggle {
  display: none;
  align-items: center;
  justify-content: center;
  position: absolute;
  top: 10px;
  left: 12px;
  width: 34px;
  height: 34px;
  border-radius: var(--radius-md);
  background: var(--surface);
  border: 1px solid var(--border);
  color: var(--foreground);
  box-shadow: var(--shadow-1);
  z-index: 30;
  transition: all var(--duration-fast);
}
.sidebar-toggle:hover {
  background: var(--surface-container);
}

/* custom-scroll 为本组件自持副本（与原 Workbench scoped 定义逐字一致） */
.custom-scroll::-webkit-scrollbar { width: 6px; height: 6px; }
.custom-scroll::-webkit-scrollbar-thumb { background: var(--surface-container-high); border-radius: 3px; }

@media (max-width: 768px) {
  .sidebar-toggle {
    display: inline-flex;
  }
  .message-list {
    padding-top: var(--space-12);
  }
  .messages-inner {
    max-width: 100%;
  }
  .message {
    max-width: 90%;
  }
}
</style>
