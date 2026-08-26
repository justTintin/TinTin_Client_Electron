<script setup lang="ts">
/**
 * TInput 输入框组件
 * 支持文本框、文本域、密码框三种类型。
 * 通过 v-model 双向绑定。
 */
import { computed, ref } from 'vue'

type InputType = 'text' | 'textarea' | 'password'

const props = withDefaults(
  defineProps<{
    /** 绑定值（v-model） */
    modelValue?: string
    /** 输入类型 */
    type?: InputType
    /** 占位提示 */
    placeholder?: string
    /** 禁用态 */
    disabled?: boolean
    /** 只读态 */
    readonly?: boolean
    /** 文本域行数（仅 type=textarea 生效） */
    rows?: number
    /** 是否显示清除按钮 */
    clearable?: boolean
  }>(),
  {
    modelValue: '',
    type: 'text',
    placeholder: '',
    disabled: false,
    readonly: false,
    rows: 4,
    clearable: false
  }
)

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void
  (e: 'enter', event: KeyboardEvent): void
}>()

const showPassword = ref(false)

// 实际渲染的 input type
const inputType = computed(() => {
  if (props.type === 'password') {
    return showPassword.value ? 'text' : 'password'
  }
  return props.type === 'textarea' ? 'text' : props.type
})

function handleInput(event: Event) {
  const target = event.target as HTMLInputElement | HTMLTextAreaElement
  emit('update:modelValue', target.value)
}

function handleEnter(event: KeyboardEvent) {
  emit('enter', event)
}

function handleClear() {
  emit('update:modelValue', '')
}

function togglePassword() {
  showPassword.value = !showPassword.value
}
</script>

<template>
  <div class="t-input" :class="{ 'is-disabled': disabled, 'is-textarea': type === 'textarea' }">
    <!-- 文本域 -->
    <textarea
      v-if="type === 'textarea'"
      class="t-input__field t-input__textarea"
      :value="modelValue"
      :placeholder="placeholder"
      :disabled="disabled"
      :readonly="readonly"
      :rows="rows"
      @input="handleInput"
      @keydown.enter="handleEnter"
    />

    <!-- 单行输入框 -->
    <template v-else>
      <input
        class="t-input__field"
        :type="inputType"
        :value="modelValue"
        :placeholder="placeholder"
        :disabled="disabled"
        :readonly="readonly"
        @input="handleInput"
        @keydown.enter="handleEnter"
      />
      <div class="t-input__suffix">
        <!-- 密码可见切换 -->
        <button
          v-if="type === 'password' && !disabled"
          type="button"
          class="t-input__toggle"
          :title="showPassword ? '隐藏' : '显示'"
          @click="togglePassword"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
            <template v-if="showPassword">
              <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
              <path d="M1 1l22 22" />
            </template>
            <template v-else>
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
              <circle cx="12" cy="12" r="3" />
            </template>
          </svg>
        </button>
        <!-- 清除按钮 -->
        <button
          v-if="clearable && modelValue && !disabled"
          type="button"
          class="t-input__toggle"
          title="清除"
          @click="handleClear"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      </div>
    </template>
  </div>
</template>

<style scoped>
.t-input {
  position: relative;
  display: flex;
  align-items: center;
  width: 100%;
}

.t-input.is-textarea {
  display: block;
}

.t-input__field {
  width: 100%;
  height: var(--size-input-height);
  padding: 0 var(--space-3);
  background: var(--surface-container);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  color: var(--foreground);
  font-size: var(--font-size-body);
  line-height: var(--line-height-body);
  outline: none;
  transition: border-color var(--duration-fast) var(--easing-default),
    box-shadow var(--duration-fast) var(--easing-default);
}

/* 单行输入框需要为后缀留出空间 */
.t-input:not(.is-textarea) .t-input__field {
  padding-right: calc(var(--space-3) * 2 + 16px);
}

.t-input__field::placeholder {
  color: var(--muted-foreground);
}

.t-input__field:focus {
  border-color: var(--primary);
  box-shadow: 0 0 0 2px var(--ring);
}

/* 文本域 */
.t-input__textarea {
  height: auto;
  min-height: calc(var(--size-input-height) * 1.5);
  padding: var(--space-2) var(--space-3);
  resize: vertical;
  line-height: var(--line-height-relaxed);
}

/* 禁用态 */
.t-input.is-disabled .t-input__field {
  opacity: 0.5;
  cursor: not-allowed;
}

/* 后缀区域 */
.t-input__suffix {
  position: absolute;
  right: var(--space-2);
  top: 50%;
  transform: translateY(-50%);
  display: flex;
  align-items: center;
  gap: var(--space-1);
}

.t-input__toggle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  color: var(--muted-foreground);
  border-radius: var(--radius-sm);
  transition: color var(--duration-fast) var(--easing-default),
    background var(--duration-fast) var(--easing-default);
}

.t-input__toggle:hover {
  color: var(--foreground);
  background: var(--surface-container-high);
}
</style>
