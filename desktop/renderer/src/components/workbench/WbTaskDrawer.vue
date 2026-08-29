<script setup lang="ts">
// WbTaskDrawer.vue — 任务队列抽屉本体（纯展示）
// 抽屉开关（v-if + notify-mask 遮罩 + 过渡动画）由容器持有；
// statusText 为 useWorkbenchTasks 模块级唯一定义的纯函数，此处直接 import。
// 有可打开结果（url/路径）的行显示结果图标按钮（对齐原详情区「结果」）。
import type { TaskRow } from '@/composables/useWorkbenchTasks'
import { statusText } from '@/composables/useWorkbenchTasks'

defineProps<{
  rows: TaskRow[]
  /** 导出中/空清单 → 导出按钮禁用（PRD E1/E6） */
  exportDisabled?: boolean
}>()

const emit = defineEmits<{
  /** 关闭按钮与遮罩共用（容器接原 closeTaskQueue） */
  (e: 'close'): void
  /** 打开任务结果（url→外部浏览器 / 本地路径→资源管理器，容器接 openTaskResult） */
  (e: 'open-result', row: TaskRow): void
  /** 顶部「导出 Excel」（PRD §3.2⑤ 任务报告，容器接 useOfficeExport） */
  (e: 'export-excel'): void
}>()
</script>

<template>
  <aside class="notify-drawer taskq-drawer" aria-label="任务队列">
    <header class="notify-head">
      <span class="notify-title">任务队列</span>
      <span class="notify-head-badge">{{ rows.length }} 项</span>
      <button
        class="taskq-export-btn"
        title="导出任务报告为 Excel"
        :disabled="exportDisabled"
        @click="emit('export-excel')"
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2" /><line x1="3" y1="9" x2="21" y2="9" /><line x1="9" y1="4" x2="9" y2="20" /><line x1="15" y1="4" x2="15" y2="20" /></svg>
        导出 Excel
      </button>
      <button class="notify-actions" @click="emit('close')" title="关闭">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </header>
    <div class="notify-body">
      <div v-for="t in rows" :key="t.id" class="taskq-row">
        <div class="taskq-head">
          <span class="q-dot" :class="t.status"></span>
          <span class="taskq-title">{{ t.title }}</span>
          <button
            v-if="t.resultTarget"
            class="taskq-open-btn"
            :title="t.resultTarget.kind === 'url' ? '在浏览器打开结果' : '打开结果所在位置'"
            @click="emit('open-result', t)"
          >
            <svg v-if="t.resultTarget.kind === 'url'" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
              <polyline points="15 3 21 3 21 9" />
              <line x1="10" y1="14" x2="21" y2="3" />
            </svg>
            <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            </svg>
          </button>
          <span class="taskq-eta" :class="t.status">{{ t.eta }}</span>
        </div>
        <div class="taskq-type">{{ t.type }}</div>
        <div class="taskq-bar">
          <div class="taskq-fill" :class="t.status" :style="{ width: t.progress + '%' }"></div>
        </div>
        <div class="taskq-foot">
          <span>{{ t.status === 'done' ? '100%' : t.progress + '%' }}</span>
          <span>{{ statusText(t.status) }}</span>
        </div>
      </div>
      <div v-if="rows.length === 0" class="notify-empty">暂无任务 · 提交后显示在这里</div>
    </div>
  </aside>
</template>

<style scoped>
/* 抽屉骨架/头部与任务行样式自持副本（与原 Workbench scoped 定义逐字一致；
   .notify-mask 与过渡动画样式保留在容器） */
.notify-drawer {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  width: 340px;
  max-width: 86%;
  z-index: 70;
  display: flex;
  flex-direction: column;
  background: var(--surface);
  border-left: 1px solid var(--border);
  box-shadow: var(--shadow-4);
}

.notify-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-4);
  border-bottom: 1px solid var(--border);
}

.notify-title {
  font-size: var(--font-size-h4);
  font-weight: var(--font-weight-semibold);
}

.notify-head-badge {
  font-size: 11px;
  color: var(--color-error);
  font-weight: 600;
}

.notify-actions {
  margin-left: auto;
  width: 28px;
  height: 28px;
  border-radius: var(--radius-md);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--muted-foreground);
  transition: all var(--duration-fast);
}
.notify-actions:hover {
  background: var(--surface-container);
  color: var(--foreground);
}

/* 顶部「导出 Excel」（PRD §3.2⑤ 任务报告） */
.taskq-export-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 26px;
  padding: 0 10px;
  font-size: 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--surface-container);
  color: var(--muted-foreground);
  cursor: pointer;
  font-family: inherit;
  transition: all var(--duration-fast);
}
.taskq-export-btn:hover:not(:disabled) { border-color: var(--primary); color: var(--primary); }
.taskq-export-btn:disabled { opacity: 0.5; cursor: not-allowed; }

/* ─── 任务队列抽屉内容 ─── */
.taskq-row {
  padding: var(--space-3);
  border-radius: var(--radius-lg);
  background: var(--surface-container);
  border: 1px solid var(--border);
  margin-bottom: var(--space-2);
  transition: border-color var(--duration-fast);
}
.taskq-row:hover { border-color: var(--primary); }

.taskq-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

/* 结果打开图标按钮（对齐用户偏好：列表内用图标不用文字按钮） */
.taskq-open-btn {
  flex: 0 0 auto;
  width: 22px;
  height: 22px;
  border: none;
  background: transparent;
  border-radius: var(--radius-md);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--primary);
  cursor: pointer;
  transition: background var(--duration-fast);
}
.taskq-open-btn:hover { background: var(--surface-container); }
.q-dot {
  flex: 0 0 auto;
  width: 8px;
  height: 8px;
  border-radius: var(--radius-full);
}
.q-dot.running { background: var(--primary); box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.18); }
.q-dot.done    { background: var(--success);  box-shadow: 0 0 0 3px rgba(16, 185, 129, 0.18); }
.q-dot.pending { background: var(--muted-foreground); }

.taskq-title {
  flex: 1 1 auto;
  min-width: 0;
  font-size: var(--font-size-body);
  font-weight: 600;
  color: var(--foreground);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.taskq-eta {
  flex: 0 0 auto;
  font-size: 11px;
  color: var(--muted-foreground);
}
.taskq-eta.done { color: var(--success); }
.taskq-eta.running { color: var(--primary); }

.taskq-type {
  margin-top: 2px;
  font-size: 11px;
  color: var(--muted-foreground);
}

.taskq-bar {
  margin-top: var(--space-2);
  height: 6px;
  background: var(--surface-container-high);
  border-radius: var(--radius-full);
  overflow: hidden;
}
.taskq-fill {
  height: 100%;
  border-radius: var(--radius-full);
  background: var(--primary);
  transition: width 0.3s ease;
}
.taskq-fill.done { background: var(--success); }
.taskq-fill.pending { background: var(--surface-container-highest); }

.taskq-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 6px;
  font-size: 11px;
  color: var(--muted-foreground);
  font-variant-numeric: tabular-nums;
}

.notify-empty {
  padding: var(--space-8) 0;
  text-align: center;
  font-size: 13px;
  color: var(--muted-foreground);
}
</style>
