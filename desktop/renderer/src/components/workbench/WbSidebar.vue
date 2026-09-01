<script setup lang="ts">
// WbSidebar.vue — 工作台左侧会话侧栏（纯展示 + 行内编辑态）
// 结构：新建会话按钮 / 分组会话列表 / 底部（任务队列 / 通知中心带未读徽标 / 系统设置）
// 分组数据由容器经 useWorkbenchSessions 的 sessionsByGroup + groupLabels 组装传入
// W7：每项 hover 显示「置顶 / 重命名 / 删除」图标按钮（用户偏好图标入口）；
//     重命名为行内编辑（input + Enter 确认 / Esc 取消 / 失焦提交），
//     业务持久化经 emit('rename-commit') 转发到容器 → useWorkbenchSessions.renameSession；
//     置顶为 toggle（2026-09-01 用户需求：置顶会话固定在普通会话上面），
//     经 emit('pin') 转发到容器 → useWorkbenchSessions.togglePinSession。
import { nextTick, ref } from 'vue'
import type { Session, SessionGroup } from '@/composables/useWorkbenchSessions'

defineProps<{
  /** 分组后的会话数据（置顶/今天/昨天/更早） */
  groups: SessionGroup[]
  activeSessionId: string
  /** 小屏侧栏抽屉展开态 */
  open: boolean
  /** 未读通知数（徽标） */
  unreadCount: number
}>()

const emit = defineEmits<{
  (e: 'select', id: string): void
  (e: 'create'): void
  (e: 'delete', id: string): void
  (e: 'pin', id: string): void
  (e: 'rename-commit', id: string, title: string): void
  (e: 'open-scheduled'): void
  (e: 'open-skills'): void
  (e: 'toggle-taskqueue'): void
  (e: 'toggle-notifications'): void
  (e: 'open-settings'): void
}>()

/* ── W7 行内编辑态（同一时刻至多一个会话处于编辑） ── */
const editingId = ref('')
const editText = ref('')
const editInput = ref<HTMLInputElement | null>(null)

function startRename(s: Session, e: Event): void {
  e.stopPropagation()
  editingId.value = s.id
  editText.value = s.title
  nextTick(() => editInput.value?.focus())
}

function commitRename(id: string): void {
  if (editingId.value !== id) return
  const title = editText.value.trim()
  editingId.value = ''
  if (title) emit('rename-commit', id, title)
}

function cancelRename(): void {
  editingId.value = ''
}
</script>

<template>
  <!-- ─── 左侧会话侧栏 260px ─── -->
  <aside class="sidebar" :class="{ open }">
    <div class="sidebar-top">
      <button class="btn btn-secondary w-full h-btn text-sm new-session" @click="emit('create')">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M12 5v14" />
          <path d="M5 12h14" />
        </svg>
        新建会话
      </button>
      <!-- 定时任务入口（移植自原客户端；P1 占位抽屉，P2 实装） -->
      <button class="btn btn-secondary w-full h-btn text-sm scheduled-btn" @click="emit('open-scheduled')">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <circle cx="12" cy="12" r="10" />
          <path d="M12 6v6l4 2" />
        </svg>
        定时任务
      </button>
      <!-- 技能管理入口（2026-09-01 用户裁决：技能从输入框快捷条迁到此处，
           管理面板在右侧侧边栏展示，不再用弹窗） -->
      <button class="btn btn-secondary w-full h-btn text-sm skills-btn" @click="emit('open-skills')">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z" />
          <path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z" />
          <path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0" />
          <path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5" />
        </svg>
        技能管理
      </button>
    </div>

    <div class="session-list custom-scroll">
      <template v-for="g in groups" :key="g.key">
        <template v-if="g.items.length">
          <div class="group-label">{{ g.label }}</div>
          <div
            v-for="s in g.items"
            :key="s.id"
            class="session-item"
            :class="{ active: activeSessionId === s.id }"
            @click="emit('select', s.id)"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
            <!-- W7 行内编辑态：input + Enter 确认 / Esc 取消 / 失焦提交 -->
            <input
              v-if="editingId === s.id"
              ref="editInput"
              v-model="editText"
              class="session-rename-input"
              @click.stop
              @keyup.enter="commitRename(s.id)"
              @keyup.esc="cancelRename"
              @blur="commitRename(s.id)"
            >
            <div v-else class="session-text">
              <div class="session-title">{{ s.title }}</div>
              <div class="session-sub">{{ s.subtitle }}</div>
            </div>
            <!-- W7 hover 操作：置顶（图钉，toggle）/ 重命名（铅笔）/ 删除（垃圾桶），点击不触发切换 -->
            <div v-if="editingId !== s.id" class="session-actions" @click.stop>
              <button
                class="session-action session-action--pin"
                :class="{ pinned: s.pinned }"
                :title="s.pinned ? '取消置顶' : '置顶'"
                @click="emit('pin', s.id)"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M12 17v5" />
                  <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1z" />
                </svg>
              </button>
              <button class="session-action" title="重命名" @click="startRename(s, $event)">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
                </svg>
              </button>
              <button class="session-action session-action--danger" title="删除" @click="emit('delete', s.id)">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M3 6h18" />
                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                  <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                </svg>
              </button>
            </div>
          </div>
        </template>
      </template>
    </div>

    <div class="sidebar-bottom">
      <button class="btn btn-secondary w-full h-btn text-sm taskq-btn" @click="emit('toggle-taskqueue')">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <rect x="3" y="4" width="18" height="18" rx="2" />
          <path d="M16 2v4" />
          <path d="M8 2v4" />
          <path d="M3 10h18" />
          <path d="M9 16l3 3 4-5" />
        </svg>
        任务队列
      </button>
      <button class="btn btn-secondary w-full h-btn text-sm notify-btn" :class="{ 'badge': unreadCount > 0 }" @click="emit('toggle-notifications')">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
          <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
        </svg>
        通知中心
        <span v-if="unreadCount > 0" class="notify-badge">{{ unreadCount }}</span>
      </button>
      <button class="btn btn-secondary w-full h-btn text-sm settings-btn" @click="emit('open-settings')">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1Z" />
        </svg>
        系统设置
      </button>
    </div>
  </aside>
</template>

<style scoped>
/* ─── 侧栏 ─── */
.sidebar {
  flex: 0 0 260px;
  width: 260px;
  display: flex;
  flex-direction: column;
  background: var(--surface);
  border-right: 1px solid var(--border);
}

.sidebar-top {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: var(--space-4);
}

.new-session {
  gap: var(--space-2);
}

.session-list {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 0 var(--space-3) var(--space-3);
}

.group-label {
  padding: 0 var(--space-2);
  margin: var(--space-2) 0 var(--space-1);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--muted-foreground);
}

.session-item {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  padding: 10px 12px;
  margin-bottom: 2px;
  border-radius: var(--radius-lg);
  cursor: pointer;
  color: var(--muted-foreground);
  transition: all var(--duration-fast);
}

.session-item svg {
  flex: 0 0 auto;
  width: 18px;
  height: 18px;
  margin-top: 1px;
  color: inherit;
}

.session-item:hover {
  background: var(--surface-container);
  color: var(--foreground);
}

.session-item.active {
  background: var(--primary);
  color: var(--primary-foreground);
}

/* ─── W7：行内重命名输入 ─── */
.session-rename-input {
  flex: 1 1 auto;
  min-width: 0;
  height: 24px;
  padding: 0 6px;
  font-size: var(--font-size-body);
  color: var(--foreground);
  background: var(--surface);
  border: 1px solid var(--primary);
  border-radius: var(--radius-sm);
  outline: none;
}
.session-item.active .session-rename-input {
  color: var(--foreground);
}

/* ─── W7：hover 操作按钮（默认隐藏，hover 会话项时显示） ─── */
.session-actions {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 2px;
  opacity: 0;
  transition: opacity var(--duration-fast) var(--easing-default);
}
.session-item:hover .session-actions,
.session-item:focus-within .session-actions {
  opacity: 1;
}
.session-action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: var(--radius-sm);
  color: inherit;
  opacity: 0.85;
  transition: all var(--duration-fast) var(--easing-default);
}
.session-action:hover {
  background: rgba(128, 128, 128, 0.18);
  opacity: 1;
}
.session-item.active .session-action:hover {
  background: rgba(255, 255, 255, 0.22);
}
.session-action--pin.pinned {
  color: var(--primary);
  opacity: 1;
}
.session-action--danger:hover {
  color: var(--error);
}
.session-item.active .session-action--danger:hover {
  color: #fff;
  background: rgba(239, 68, 68, 0.7);
}

.session-text {
  flex: 1 1 auto;
  min-width: 0;
}

.session-title {
  font-size: var(--font-size-body);
  line-height: 1.4;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.session-sub {
  margin-top: 2px;
  font-size: 11px;
  line-height: 1.3;
  opacity: 0.8;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.sidebar-bottom {
  padding: var(--space-4);
  border-top: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

/* 底部入口按钮：图标+文字整体居中（2026-08-30 用户反馈） */
.sidebar-bottom .btn {
  justify-content: center;
}

.settings-btn {
  gap: var(--space-2);
}

/* ─── 通知中心入口（侧栏底部，对齐设计稿） ─── */
.notify-btn {
  gap: var(--space-2);
  position: relative;
}

.taskq-btn {
  gap: var(--space-2);
}

/* 未读徽标：绝对定位按钮内右侧垂直居中（不推挤图标+文字的居中布局，2026-08-30） */
.notify-badge {
  position: absolute;
  right: var(--space-3);
  top: 50%;
  transform: translateY(-50%);
  min-width: 20px;
  height: 20px;
  padding: 0 6px;
  border-radius: var(--radius-full);
  background: var(--color-error);
  color: var(--primary-foreground);
  font-size: 10px;
  font-weight: 600;
  line-height: 20px;
  text-align: center;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

/* 按钮 variant 与 custom-scroll 为本组件自持副本（.w-full/.text-sm 来自全局 global.css；
   .btn/.btn-secondary/.h-btn/.custom-scroll 原仅在 Workbench scoped 内定义，
   子组件 scoped 无法继承父 scoped 样式，故按原声明复制，内容逐字一致） */
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  border: 1px solid transparent;
  border-radius: var(--radius-lg);
  font-weight: 500;
  white-space: nowrap;
  transition: all var(--duration-fast);
}
.btn-secondary {
  background: var(--surface-container);
  color: var(--foreground);
  border-color: var(--border);
}
.btn-secondary:hover {
  background: var(--surface-container-high);
}
.h-btn { height: 40px; padding: 0 var(--space-4); }

.custom-scroll::-webkit-scrollbar { width: 6px; height: 6px; }
.custom-scroll::-webkit-scrollbar-thumb { background: var(--surface-container-high); border-radius: 3px; }

@media (max-width: 768px) {
  /* ─── 小屏下会话侧栏折叠为抽屉，由汉堡按钮控制 ─── */
  .sidebar {
    position: absolute;
    left: 0;
    top: 0;
    z-index: 50;
    height: 100%;
    transform: translateX(-100%);
    transition: transform var(--duration-normal) var(--easing-default);
    box-shadow: none;
  }
  .sidebar.open {
    transform: translateX(0);
    box-shadow: var(--shadow-3);
  }
}
</style>
