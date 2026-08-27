<script setup lang="ts">
// WbScheduledDrawer.vue — 定时任务抽屉（P2 实装）
// 对照基准：原客户端 scheduled_tasks_mgmt_page.py（两个板块 → 抽屉内两 Tab）。
// 业务状态在 composables/useScheduledTasks.ts，本组件只做绘制与事件绑定。
// 开关（v-if + notify-mask 遮罩 + drawer-slide/drawer-fade 过渡）由容器 Workbench.vue 持有。
import { onMounted, ref } from 'vue'
import {
  useScheduledTasks, TYPE_LABEL, agentStatusText, WEEKDAY_LABELS
} from '@/composables/useScheduledTasks'

const emit = defineEmits<{
  /** 关闭按钮（容器接 closeScheduled） */
  (e: 'close'): void
}>()

const {
  tasks, loading, creating, notice, form, formError,
  load, create, runNow, remove,
  agentTasks, agentLoading, loadAgent, confirmAgent,
  agentCaps, capsLoading, loadRegistry
} = useScheduledTasks()

/** 抽屉内 Tab：local=本地定时任务（schtasks）；agent=云端编排（/agent/tasks） */
const tab = ref<'local' | 'agent'>('local')

onMounted(() => {
  void load()
  void loadAgent()
})

function switchTab(t: 'local' | 'agent') {
  tab.value = t
  if (t === 'local') void load()
  else void loadAgent()
}

/** 时间输入兜底 HH:MM（失焦补零） */
function normalizeTime(e: Event) {
  const el = e.target as HTMLInputElement
  const m = /^(\d{1,2})[:：]?(\d{0,2})$/.exec(el.value.trim())
  if (m) {
    const h = Math.min(23, Number(m[1]))
    const min = Math.min(59, Number(m[2] || '0'))
    form.value.time = `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`
  }
  el.value = form.value.time
}
</script>

<template>
  <aside class="sched-drawer" aria-label="定时任务">
    <header class="sched-head">
      <span class="sched-title">定时任务</span>
      <button class="sched-actions" @click="emit('close')" title="关闭">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </header>

    <!-- ─── Tab 切换（对齐原版两板块） ─── -->
    <div class="sched-tabs">
      <button class="sched-tab" :class="{ active: tab === 'local' }" @click="switchTab('local')">本地定时任务</button>
      <button class="sched-tab" :class="{ active: tab === 'agent' }" @click="switchTab('agent')">云端编排</button>
    </div>

    <div v-if="notice" class="sched-notice">{{ notice }}</div>

    <!-- ─── 本地定时任务 ─── -->
    <div v-if="tab === 'local'" class="sched-body">
      <!-- 新建区 -->
      <div class="card">
        <div class="card-title">＋ 新建本地定时任务</div>
        <div class="frow">
          <label class="flabel">任务名</label>
          <input v-model="form.name" class="finput" placeholder="任务名称" />
        </div>
        <div class="frow">
          <label class="flabel">类型</label>
          <select v-model="form.taskType" class="finput">
            <option value="hotspot">本地定时任务</option>
            <option value="agent">云端智能体</option>
          </select>
        </div>
        <div v-if="form.taskType === 'agent'" class="frow">
          <label class="flabel">任务描述</label>
          <input v-model="form.goal" class="finput" placeholder="到点提交服务端由智能体自动拆解执行" />
        </div>
        <div class="frow">
          <label class="flabel">调度</label>
          <select v-model="form.mode" class="finput finput-sm">
            <option value="daily">每天</option>
            <option value="weekly">每周</option>
          </select>
          <input
            class="finput finput-sm" type="time" v-model="form.time"
            @change="normalizeTime" placeholder="09:00"
          />
        </div>
        <div v-if="form.mode === 'weekly'" class="frow">
          <label class="flabel">星期</label>
          <div class="wdays">
            <label v-for="(lbl, i) in WEEKDAY_LABELS" :key="i" class="wday">
              <input type="checkbox" v-model="form.weekdays[i]" />{{ lbl }}
            </label>
          </div>
        </div>
        <div v-if="formError" class="ferr">{{ formError }}</div>
        <div v-else-if="form.taskType === 'agent'" class="fhint">到点后按任务描述提交服务端，由 Orchestrator 自动拆解执行</div>
        <button class="btn-primary" :disabled="!!formError || creating" @click="create()">
          {{ creating ? '注册中…' : '注册任务' }}
        </button>
      </div>

      <!-- 已注册列表 -->
      <div class="card">
        <div class="card-title list-head">
          <span>已注册任务（Windows 任务计划程序）</span>
          <button
            class="btn-ghost" disabled
            title="热点自动采集将在后续版本与内置浏览器联动"
          >立即采集今日热点</button>
          <button class="btn-ghost" @click="load()">刷新</button>
        </div>
        <div v-if="loading" class="muted">加载中…</div>
        <div v-else-if="!tasks.length" class="muted">暂无本地定时任务</div>
        <div v-for="t in tasks" :key="t.task_name" class="task-card">
          <div class="task-line">
            <span class="task-name">{{ t.name }}<template v-if="!t.registered">（未注册）</template></span>
            <span class="task-type" :class="t.type">{{ TYPE_LABEL[t.type] || t.type }}</span>
          </div>
          <div class="task-meta">
            <span>{{ (t.schedule?.mode === 'weekly' ? '每周 ' : '每天 ') + (t.schedule?.time || '') }}
              <template v-if="t.schedule?.mode === 'weekly' && t.schedule?.weekdays?.length">（{{ t.schedule.weekdays.map((d: number) => '一二三四五六日'[d]).join('、') }}）</template>
            </span>
            <span v-if="t.next_run">下次：{{ t.next_run }}</span>
          </div>
          <div class="task-meta">
            <span v-if="t.last_run">上次：{{ t.last_run }}</span>
            <span>结果：{{ t.last_result ? (t.last_result.includes('0x0') || t.last_result === '0' ? '成功' : (t.last_result.includes('41303') || t.last_result.includes('267011') ? '尚未运行' : t.last_result)) : '—' }}</span>
          </div>
          <div class="task-ops">
            <button v-if="t.registered" class="btn-ghost" @click="runNow(t.task_name)">立即运行</button>
            <button class="btn-ghost danger" @click="remove(t.name)">取消定时</button>
          </div>
        </div>
      </div>
    </div>

    <!-- ─── 云端编排（/agent/tasks 根任务概览） ─── -->
    <div v-else class="sched-body">
      <div class="card">
        <div class="card-title list-head">
          <span>最近编排任务（等待确认可继续）</span>
          <button class="btn-ghost" @click="loadAgent()">刷新</button>
        </div>
        <div v-if="agentLoading" class="muted">加载中…</div>
        <div v-else-if="!agentTasks.length" class="muted">暂无编排任务</div>
        <div v-for="t in agentTasks" :key="t.id" class="task-card">
          <div class="task-line">
            <span class="task-name" :title="t.goal">{{ t.goal || '—' }}</span>
            <span class="task-status">{{ agentStatusText(t.status) }}</span>
          </div>
          <div class="task-meta">
            <span>进度 {{ t.progress }}%</span>
            <span v-if="t.created_at">{{ t.created_at }}</span>
          </div>
          <div class="task-bar"><i :style="{ width: t.progress + '%' }" /></div>
          <div v-if="t.status === 'waiting_user_input'" class="task-ops">
            <button class="btn-primary sm" @click="confirmAgent(t.id)">人工确认，继续执行</button>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-title list-head">
          <span>云端智能体能力</span>
          <button class="btn-ghost" :disabled="capsLoading" @click="loadRegistry()">
            {{ capsLoading ? '加载中…' : '查看云端智能体' }}
          </button>
        </div>
        <div v-if="!agentCaps.length" class="muted">点「查看云端智能体」拉取服务端注册清单</div>
        <div v-for="c in agentCaps" :key="c.id" class="cap-card">
          <div class="task-line">
            <span class="task-name">{{ c.name }}</span>
            <span class="task-type agent">{{ c.id }}</span>
          </div>
          <div class="task-meta cap-desc">{{ c.description }}</div>
        </div>
      </div>
    </div>
  </aside>
</template>

<style scoped>
/* 抽屉骨架与通知抽屉同构；.notify-mask 与过渡动画样式保留在容器 */
.sched-drawer {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  width: 380px;
  max-width: 92%;
  z-index: 70;
  display: flex;
  flex-direction: column;
  background: var(--surface);
  border-left: 1px solid var(--border);
  box-shadow: var(--shadow-4);
}
.sched-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 14px 16px;
  border-bottom: 1px solid var(--border);
}
.sched-title {
  flex: 1;
  font-size: 14px;
  font-weight: 600;
}
.sched-actions {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 6px;
  color: var(--muted-foreground, #8a8f98);
}
.sched-actions:hover {
  background: var(--secondary, rgba(255, 255, 255, 0.06));
}

/* Tab */
.sched-tabs {
  display: flex;
  gap: 4px;
  padding: 10px 16px 0;
}
.sched-tab {
  padding: 6px 12px;
  border-radius: 8px 8px 0 0;
  font-size: 13px;
  color: var(--muted-foreground, #8a8f98);
}
.sched-tab.active {
  background: var(--secondary, rgba(255, 255, 255, 0.06));
  color: var(--foreground, #e6e8eb);
}

/* 提示条 */
.sched-notice {
  margin: 8px 16px 0;
  padding: 8px 10px;
  border-radius: 8px;
  font-size: 12px;
  background: rgba(59, 130, 246, 0.12);
  color: var(--foreground, #e6e8eb);
  white-space: pre-line;
}

/* 内容区 */
.sched-body {
  flex: 1;
  overflow: auto;
  padding: 12px 16px 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.card {
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.card-title {
  font-size: 13px;
  font-weight: 600;
}
.list-head {
  display: flex;
  align-items: center;
  gap: 6px;
  justify-content: space-between;
}
.list-head > span {
  flex: 1;
}

/* 表单 */
.frow {
  display: flex;
  align-items: center;
  gap: 8px;
}
.flabel {
  flex: 0 0 52px;
  font-size: 12px;
  color: var(--muted-foreground, #8a8f98);
}
.finput {
  flex: 1;
  min-width: 0;
  height: 30px;
  padding: 0 8px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--background);
  color: var(--foreground, #e6e8eb);
  font-size: 13px;
}
.finput-sm {
  flex: 0 0 auto;
  width: 92px;
}
.wdays {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.wday {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  font-size: 12px;
}
.ferr {
  font-size: 12px;
  color: #f87171;
}
.fhint {
  font-size: 12px;
  color: var(--muted-foreground, #8a8f98);
}
.btn-primary {
  height: 32px;
  border-radius: 8px;
  background: var(--primary, #3b82f6);
  color: #fff;
  font-size: 13px;
}
.btn-primary:disabled {
  opacity: 0.5;
}
.btn-primary.sm {
  height: 28px;
  padding: 0 10px;
}
.btn-ghost {
  height: 26px;
  padding: 0 8px;
  border-radius: 6px;
  font-size: 12px;
  color: var(--foreground, #e6e8eb);
  border: 1px solid var(--border);
}
.btn-ghost:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.btn-ghost.danger {
  color: #f87171;
}

/* 任务卡片 */
.task-card {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.task-line {
  display: flex;
  align-items: center;
  gap: 8px;
  justify-content: space-between;
}
.task-name {
  font-size: 13px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.task-type {
  flex: 0 0 auto;
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 999px;
  border: 1px solid var(--border);
}
.task-type.agent {
  color: #93c5fd;
}
.task-status {
  font-size: 12px;
  color: var(--muted-foreground, #8a8f98);
}
.task-meta {
  display: flex;
  gap: 12px;
  font-size: 12px;
  color: var(--muted-foreground, #8a8f98);
}
.task-bar {
  height: 4px;
  border-radius: 999px;
  background: var(--secondary, rgba(255, 255, 255, 0.08));
  overflow: hidden;
}
.task-bar i {
  display: block;
  height: 100%;
  background: var(--primary, #3b82f6);
}
.task-ops {
  display: flex;
  gap: 6px;
}
.cap-card {
  border-bottom: 1px dashed var(--border);
  padding-bottom: 6px;
}
.cap-desc {
  white-space: normal;
}
.muted {
  font-size: 12px;
  color: var(--muted-foreground, #8a8f98);
}
</style>
