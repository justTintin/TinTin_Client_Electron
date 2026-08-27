<script setup lang="ts">
// WbComposer.vue — 工作台底部输入区（纯展示）
// 结构：textarea 输入框 / 上传与发送按钮 / 快捷键提示行
// textarea DOM ref 在本组件内部自持并 expose focus()：
// 「新建会话后聚焦输入框」（原 createSession 内 inputRef.value?.focus()）
// 经容器桥接到 useWorkbenchSessions 的 onSessionFocus 钩子。
import { computed, ref } from 'vue'

const props = defineProps<{
  modelValue: string
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void
  (e: 'send'): void
  /** 原生 keydown 上抛；handleKeydown 中 preventDefault 对同一原生事件对象生效 */
  (e: 'keydown', ev: KeyboardEvent): void
}>()

const innerText = computed({
  get: () => props.modelValue,
  set: (v) => emit('update:modelValue', v)
})

const textareaRef = ref<HTMLTextAreaElement | null>(null)

/** 原 createSession 内 inputRef.value?.focus() 的等价实现 */
function focus() {
  textareaRef.value?.focus()
}

defineExpose({ focus })
</script>

<template>
  <!-- ─── 输入区 ─── -->
  <div class="input-bar">
    <div class="input-wrap">
      <textarea
        ref="textareaRef"
        v-model="innerText"
        class="chat-input"
        rows="4"
        placeholder="输入消息..."
        @keydown="emit('keydown', $event)"
      ></textarea>
      <div class="input-actions">
        <button class="action-ic" title="上传文件">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="17 8 12 3 7 8" />
            <line x1="12" y1="3" x2="12" y2="15" />
          </svg>
        </button>
        <button class="action-send" title="发送" @click="emit('send')">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="m22 2-7 20-4-9-9-4 20-7z" />
            <path d="M22 2 11 13" />
          </svg>
        </button>
      </div>
    </div>
    <div class="input-foot">
      <span>Enter 发送，Shift + Enter 换行</span>
      <span class="model-tag">模型：GPT-4o</span>
    </div>
  </div>
</template>

<style scoped>
/* ─── 输入区 ─── */
.input-bar {
  flex: 0 0 auto;
  padding: var(--space-4);
  background: var(--surface);
  border-top: 1px solid var(--border);
}

.input-wrap {
  max-width: 48rem;
  margin: 0 auto;
  position: relative;
}

.chat-input {
  width: 100%;
  min-height: 112px;
  padding: var(--space-4) 64px var(--space-4) var(--space-4);
  background: var(--surface-container);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  color: var(--foreground);
  font-size: var(--font-size-body);
  line-height: var(--line-height-body);
  outline: none;
  resize: none;
  transition: all var(--duration-fast);
}

.chat-input:focus {
  border-color: var(--primary);
  box-shadow: 0 0 0 3px var(--ring);
  background: var(--card);
}

.input-actions {
  position: absolute;
  right: var(--space-3);
  bottom: var(--space-3);
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.action-ic {
  width: 36px;
  height: 36px;
  border-radius: var(--radius-lg);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--muted-foreground);
  transition: all var(--duration-fast);
}

.action-ic:hover {
  background: var(--surface-container-high);
  color: var(--foreground);
}

.action-send {
  width: 36px;
  height: 36px;
  border-radius: var(--radius-lg);
  background: var(--primary);
  color: var(--primary-foreground);
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all var(--duration-fast);
}

.action-send:hover {
  filter: brightness(1.1);
}

.input-foot {
  max-width: 48rem;
  margin: var(--space-3) auto 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 11px;
  color: var(--muted-foreground);
}

.model-tag {
  white-space: nowrap;
}
</style>
