<script lang="ts">
/** 选项定义 */
export interface SelectOption {
  label: string
  value: string | number
  disabled?: boolean
}
</script>
<script setup lang="ts">
/**
 * TSelect 下拉选择组件
 * 支持 v-model 双向绑定，点击外部自动收起。
 */
import { computed, ref, onMounted, onBeforeUnmount, watch } from 'vue'

const props = withDefaults(
  defineProps<{
    /** 绑定值（v-model） */
    modelValue?: string | number
    /** 选项列表 */
    options?: SelectOption[]
    /** 占位提示 */
    placeholder?: string
    /** 禁用态 */
    disabled?: boolean
    /** 是否可清空 */
    clearable?: boolean
  }>(),
  {
    modelValue: '',
    options: () => [],
    placeholder: '请选择',
    disabled: false,
    clearable: false
  }
)

const emit = defineEmits<{
  (e: 'update:modelValue', value: string | number): void
}>()

const open = ref(false)
const rootRef = ref<HTMLElement | null>(null)

// 当前选中项的标签
const selectedLabel = computed(() => {
  const item = props.options.find((o) => o.value === props.modelValue)
  return item ? item.label : ''
})

function toggleMenu() {
  if (props.disabled) return
  open.value = !open.value
}

function selectOption(option: SelectOption) {
  if (option.disabled) return
  emit('update:modelValue', option.value)
  open.value = false
}

function handleClear(event: MouseEvent) {
  event.stopPropagation()
  emit('update:modelValue', '')
  open.value = false
}

// 点击组件外部时收起下拉
function handleClickOutside(event: MouseEvent) {
  if (rootRef.value && !rootRef.value.contains(event.target as Node)) {
    open.value = false
  }
}

onMounted(() => {
  document.addEventListener('click', handleClickOutside)
})

onBeforeUnmount(() => {
  document.removeEventListener('click', handleClickOutside)
})

// 不可用时强制收起
watch(
  () => props.disabled,
  (val) => {
    if (val) open.value = false
  }
)
</script>

<template>
  <div ref="rootRef" class="t-select" :class="{ 'is-disabled': disabled, 'is-open': open }">
    <!-- 触发器 -->
    <div class="t-select__trigger" @click="toggleMenu">
      <span class="t-select__value" :class="{ 'is-placeholder': !selectedLabel }">
        {{ selectedLabel || placeholder }}
      </span>
      <div class="t-select__suffix">
        <!-- 清除按钮 -->
        <button
          v-if="clearable && selectedLabel && !disabled"
          type="button"
          class="t-select__clear"
          title="清除"
          @click="handleClear"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
        <!-- 箭头 -->
        <svg
          class="t-select__arrow"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </div>
    </div>

    <!-- 下拉面板 -->
    <Transition name="t-select">
      <ul v-if="open" class="t-select__menu">
        <li
          v-for="opt in options"
          :key="opt.value"
          class="t-select__option"
          :class="{
            'is-selected': opt.value === modelValue,
            'is-disabled': opt.disabled
          }"
          @click="selectOption(opt)"
        >
          <span>{{ opt.label }}</span>
          <svg
            v-if="opt.value === modelValue"
            class="t-select__check"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M20 6L9 17l-5-5" />
          </svg>
        </li>
        <li v-if="options.length === 0" class="t-select__empty">暂无选项</li>
      </ul>
    </Transition>
  </div>
</template>

<style scoped>
.t-select {
  position: relative;
  width: 100%;
  font-size: var(--font-size-body);
}

.t-select__trigger {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: var(--size-input-height);
  padding: 0 var(--space-3);
  background: var(--surface-container);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: border-color var(--duration-fast) var(--easing-default),
    box-shadow var(--duration-fast) var(--easing-default);
}

.t-select.is-open .t-select__trigger {
  border-color: var(--primary);
  box-shadow: 0 0 0 2px var(--ring);
}

.t-select.is-disabled .t-select__trigger {
  opacity: 0.5;
  cursor: not-allowed;
}

.t-select__value {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--foreground);
}

.t-select__value.is-placeholder {
  color: var(--muted-foreground);
}

.t-select__suffix {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  color: var(--muted-foreground);
  flex-shrink: 0;
}

.t-select__clear {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: var(--radius-sm);
  transition: color var(--duration-fast) var(--easing-default),
    background var(--duration-fast) var(--easing-default);
}

.t-select__clear:hover {
  color: var(--foreground);
  background: var(--surface-container-high);
}

.t-select__arrow {
  transition: transform var(--duration-fast) var(--easing-default);
}

.t-select.is-open .t-select__arrow {
  transform: rotate(180deg);
}

/* 下拉面板 */
.t-select__menu {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  right: 0;
  z-index: var(--z-dropdown);
  max-height: 240px;
  overflow-y: auto;
  background: var(--popover);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-float);
  padding: var(--space-1);
}

.t-select__option {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-sm);
  color: var(--foreground);
  cursor: pointer;
  transition: background var(--duration-fast) var(--easing-default),
    color var(--duration-fast) var(--easing-default);
}

.t-select__option:hover {
  background: var(--surface-container);
}

.t-select__option.is-selected {
  color: var(--primary);
  background: var(--surface-container);
}

.t-select__option.is-disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.t-select__option.is-disabled:hover {
  background: transparent;
}

.t-select__check {
  color: var(--primary);
  flex-shrink: 0;
}

.t-select__empty {
  padding: var(--space-4);
  text-align: center;
  color: var(--muted-foreground);
}

/* 过渡动画 */
.t-select-enter-active,
.t-select-leave-active {
  transition: opacity var(--duration-fast) var(--easing-default),
    transform var(--duration-fast) var(--easing-default);
}

.t-select-enter-from,
.t-select-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}
</style>
