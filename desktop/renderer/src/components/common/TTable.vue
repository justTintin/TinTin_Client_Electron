<script lang="ts">
/** 列定义 */
export interface TableColumn {
  /** 数据字段名 */
  key: string
  /** 列标题 */
  label: string
  /** 列宽（数字按 px，字符串直接作为 CSS） */
  width?: string | number
  /** 对齐方式 */
  align?: 'left' | 'center' | 'right'
}
</script>
<script setup lang="ts">
/**
 * TTable 通用表格组件
 * 支持列配置、行点击、可选多选（含表头全选复选框）。
 */
import { computed, ref, watch } from 'vue'

const props = withDefaults(
  defineProps<{
    /** 列配置 */
    columns?: TableColumn[]
    /** 数据数组 */
    data?: Record<string, any>[]
    /** 是否显示选择列 */
    selectable?: boolean
    /** 行唯一标识字段名（默认取 index） */
    rowKey?: string
    /** 空数据提示文字 */
    emptyText?: string
  }>(),
  {
    columns: () => [],
    data: () => [],
    selectable: false,
    rowKey: '',
    emptyText: '暂无数据'
  }
)

const emit = defineEmits<{
  (e: 'row-click', row: Record<string, any>, index: number): void
  (e: 'select-change', selectedRows: Record<string, any>[]): void
}>()

// 当前选中的行索引集合
const selectedIndexes = ref<Set<number>>(new Set())

// 数据变化时清空选择
watch(
  () => props.data,
  () => {
    selectedIndexes.value = new Set()
    emit('select-change', [])
  }
)

// 是否全选
const isAllSelected = computed(() => {
  return props.data.length > 0 && selectedIndexes.value.size === props.data.length
})

// 是否半选
const isIndeterminate = computed(() => {
  const size = selectedIndexes.value.size
  return size > 0 && size < props.data.length
})

function toggleRow(index: number) {
  const next = new Set(selectedIndexes.value)
  if (next.has(index)) {
    next.delete(index)
  } else {
    next.add(index)
  }
  selectedIndexes.value = next
  emitSelectChange()
}

function toggleAll() {
  if (isAllSelected.value) {
    selectedIndexes.value = new Set()
  } else {
    selectedIndexes.value = new Set(props.data.map((_, i) => i))
  }
  emitSelectChange()
}

function emitSelectChange() {
  const rows = Array.from(selectedIndexes.value).map((i) => props.data[i])
  emit('select-change', rows)
}

function handleRowClick(row: Record<string, any>, index: number) {
  emit('row-click', row, index)
}

// 列对齐样式
function cellStyle(col: TableColumn): Record<string, string> {
  const style: Record<string, string> = {}
  if (col.width) {
    style.width = typeof col.width === 'number' ? `${col.width}px` : col.width
  }
  style.textAlign = col.align ?? 'left'
  return style
}
</script>

<template>
  <div class="t-table">
    <table class="t-table__inner">
      <thead>
        <tr>
          <!-- 选择列 -->
          <th v-if="selectable" class="t-table__check-cell">
            <label class="t-checkbox">
              <input
                type="checkbox"
                :checked="isAllSelected"
                :indeterminate.prop="isIndeterminate"
                @change="toggleAll"
              />
              <span class="t-checkbox__box" />
            </label>
          </th>
          <!-- 数据列 -->
          <th
            v-for="col in columns"
            :key="col.key"
            :style="cellStyle(col)"
          >
            {{ col.label }}
          </th>
        </tr>
      </thead>
      <tbody>
        <!-- 空状态 -->
        <tr v-if="data.length === 0">
          <td :colspan="columns.length + (selectable ? 1 : 0)" class="t-table__empty">
            {{ emptyText }}
          </td>
        </tr>
        <!-- 数据行 -->
        <tr
          v-for="(row, index) in data"
          :key="rowKey ? row[rowKey] : index"
          class="t-table__row"
          @click="handleRowClick(row, index)"
        >
          <td v-if="selectable" class="t-table__check-cell" @click.stop>
            <label class="t-checkbox">
              <input
                type="checkbox"
                :checked="selectedIndexes.has(index)"
                @change="toggleRow(index)"
              />
              <span class="t-checkbox__box" />
            </label>
          </td>
          <td
            v-for="col in columns"
            :key="col.key"
            :style="cellStyle(col)"
          >
            <slot :name="`cell-${col.key}`" :row="row" :value="row[col.key]">
              {{ row[col.key] }}
            </slot>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.t-table {
  width: 100%;
  overflow-x: auto;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-xl);
}

.t-table__inner {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--font-size-body);
}

thead th {
  position: sticky;
  top: 0;
  padding: var(--space-2) var(--space-3);
  background: var(--surface-container);
  color: var(--muted-foreground);
  font-size: var(--font-size-caption);
  font-weight: var(--font-weight-medium);
  text-align: left;
  white-space: nowrap;
  border-bottom: 1px solid var(--border);
}

tbody td {
  padding: var(--space-3);
  color: var(--foreground);
  border-bottom: 1px solid var(--border-subtle);
}

tbody tr:last-child td {
  border-bottom: none;
}

.t-table__row {
  cursor: pointer;
  transition: background var(--duration-fast) var(--easing-default);
}

.t-table__row:hover {
  background: var(--surface-container);
}

.t-table__check-cell {
  width: 44px;
  text-align: center !important;
}

.t-table__empty {
  text-align: center !important;
  color: var(--muted-foreground);
  padding: var(--space-8) var(--space-3);
}

/* 自定义复选框 */
.t-checkbox {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  position: relative;
  width: 16px;
  height: 16px;
}

.t-checkbox input {
  position: absolute;
  opacity: 0;
  inset: 0;
  cursor: pointer;
}

.t-checkbox__box {
  width: 16px;
  height: 16px;
  border: 1.5px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface-container);
  transition: background var(--duration-fast) var(--easing-default),
    border-color var(--duration-fast) var(--easing-default);
}

.t-checkbox__box::after {
  content: '';
  position: absolute;
  left: 5px;
  top: 1px;
  width: 4px;
  height: 9px;
  border: solid var(--primary-foreground);
  border-width: 0 2px 2px 0;
  transform: rotate(45deg) scale(0);
  transition: transform var(--duration-fast) var(--easing-default);
}

.t-checkbox input:checked + .t-checkbox__box {
  background: var(--primary);
  border-color: var(--primary);
}

.t-checkbox input:checked + .t-checkbox__box::after {
  transform: rotate(45deg) scale(1);
}

.t-checkbox input:indeterminate + .t-checkbox__box {
  background: var(--primary);
  border-color: var(--primary);
}

.t-checkbox input:indeterminate + .t-checkbox__box::after {
  border-width: 0;
  background: var(--primary-foreground);
  width: 8px;
  height: 2px;
  transform: rotate(0) scale(1);
  left: 4px;
  top: 7px;
}
</style>
