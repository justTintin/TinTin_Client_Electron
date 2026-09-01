<script setup lang="ts">
// WbScheduledDrawer.vue — 定时任务抽屉（双 Tab；2026-08-31 结构澄清）
// 对照基准：原客户端 scheduled_tasks_mgmt_page.py（注册清单）+
//   scheduled_tasks_page.py（执行状态页）。
// 2026-08-31 用户裁决：编排任务也是定时任务（云端智能体类型到点执行的
// 实例），本抽屉双 Tab：
//   · 「定时任务」= 注册清单（新建 + 已注册任务，即注册了哪些定时任务）
//   · 「执行结果」= 任务执行详情（①编排任务执行实例 ②服务端成片定时
//     任务执行记录 GET /scheduled/tasks）；非定时任务执行结果在左下角
//     「任务队列」（/tasks/unified，另域）。
// 业务状态在 composables/useScheduledTasks.ts + scheduledExecLogic.ts，
// 本组件只做绘制与事件绑定。
// 开关（v-if + notify-mask 遮罩 + drawer-slide/drawer-fade 过渡）由容器 Workbench.vue 持有。
import { onMounted, ref } from 'vue'
import {
  useScheduledTasks, TYPE_LABEL, agentStatusText, WEEKDAY_LABELS
} from '@/composables/useScheduledTasks'
import { schedResultSummary } from '@/composables/scheduledExecLogic'

const emit = defineEmits<{
  /** 关闭按钮（容器接 closeScheduled） */
  (e: 'close'): void
}>()

const {
  tasks, loading, creating, notice, form, formError,
  load, create, runNow, remove,
  currentPlan, splitting, splitPlan,
  capturing, captureProgress, captureNow,
  detailTask, detailLoading, openDetail, closeDetail,
  pendingDecision, decisionSel, decisionError, decisionSubmitting,
  toggleChoice, submitDecision, rejectDecision,
  agentTasks, agentLoading, loadAgent, confirmAgent,
  schedExecRows, schedExecLoading, loadSchedExec,
  schedItem, schedItemLoading, openSchedItem, closeSchedItem
} = useScheduledTasks()

/** 抽屉双 Tab：registry=定时任务（注册清单）/ results=执行结果 */
const activeTab = ref<'registry' | 'results'>('registry')

onMounted(() => {
  void load()
  void loadAgent()
  void loadSchedExec()
})

function switchTab(t: 'registry' | 'results') {
  activeTab.value = t
  if (t === 'results') {
    void loadAgent()
    void loadSchedExec()
  }
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

    <div v-if="notice" class="sched-notice">{{ notice }}</div>

    <!-- ─── 双 Tab（2026-08-31）：定时任务=注册清单 / 执行结果=任务执行详情 ─── -->
    <div class="sched-tabs">
      <button
        class="sched-tab"
        :class="{ active: activeTab === 'registry' }"
        @click="switchTab('registry')"
      >定时任务</button>
      <button
        class="sched-tab"
        :class="{ active: activeTab === 'results' }"
        @click="switchTab('results')"
      >执行结果</button>
    </div>

    <div class="sched-body">
      <template v-if="activeTab === 'registry'">
      <!-- 新建区 -->
      <div class="card">
        <div class="card-title">＋ 新建定时任务</div>
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
          <button class="btn-ghost" :disabled="splitting || !form.goal.trim()" title="调用服务端 LLM 拆解为能力步骤" @click="splitPlan()">
            {{ splitting ? '拆解中…' : '拆解任务' }}
          </button>
        </div>
        <!-- 拆解步骤预览（agent 类型，plan 将随任务存储，到点优先提交） -->
        <div v-if="form.taskType === 'agent' && currentPlan" class="plan-preview">
          <div class="plan-title">拆解步骤（{{ currentPlan.steps.length }} 步）</div>
          <div v-for="(step, i) in currentPlan.steps" :key="step.id" class="plan-step">
            <span class="plan-num">{{ i + 1 }}.</span>
            <span class="plan-cap">{{ step.capability }}</span>
            <span v-if="step.needs_user_input" class="plan-flag">需确认</span>
            <div class="plan-params">{{ JSON.stringify(step.params) }}</div>
          </div>
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
            class="btn-ghost"
            :disabled="capturing"
            :title="capturing ? `采集中：${captureProgress ? captureProgress.platform + ' (' + captureProgress.index + '/' + captureProgress.total + ')' : '准备中…'}` : '采集 抖音/小红书/B站 热榜并写入清单'"
            @click="captureNow()"
          >{{ capturing ? '采集中…' : '立即采集今日热点' }}</button>
          <button class="btn-ghost" @click="load()">刷新</button>
        </div>
        <div v-if="loading" class="muted">加载中…</div>
        <div v-else-if="!tasks.length" class="muted">暂无定时任务</div>
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
      </template>

      <template v-else>
      <!-- ─── 执行结果①：编排任务执行实例（云端智能体定时任务到点执行产生；
           对齐原版 mgmt_page L262「最近编排任务」，2026-08-31 移入执行结果 Tab） ─── -->
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
          <div class="task-ops">
            <button class="btn-ghost" :disabled="detailLoading" @click="openDetail(t.id)">
              {{ detailLoading ? '加载中…' : '详情' }}
            </button>
          </div>
        </div>
      </div>

      <!-- ─── 执行结果②：服务端定时任务执行记录（成片类定时任务到点执行；
           对齐原 scheduled_tasks_page.py 执行状态页：类型/状态/进度/总分/结果） ─── -->
      <div class="card">
        <div class="card-title list-head">
          <span>服务端定时任务执行记录（成片类）</span>
          <button class="btn-ghost" @click="loadSchedExec()">刷新</button>
        </div>
        <div v-if="schedExecLoading" class="muted">加载中…</div>
        <div v-else-if="!schedExecRows.length" class="muted">暂无执行记录</div>
        <div v-for="r in schedExecRows" :key="r.id" class="task-card">
          <div class="task-line">
            <span class="task-name" :title="r.title">{{ r.title }}</span>
            <span class="task-status" :style="{ color: r.statusColor }">{{ r.statusText }}</span>
          </div>
          <div class="task-meta">
            <span>{{ r.typeText }}</span>
            <span>进度 {{ r.progress }}%</span>
            <span v-if="r.score !== null">总分 {{ r.score }}</span>
            <span v-if="r.createdAt">{{ r.createdAt }}</span>
          </div>
          <div class="task-bar"><i :style="{ width: r.progress + '%' }" /></div>
          <div class="task-ops">
            <button
              class="btn-ghost"
              :disabled="schedItemLoading"
              @click="openSchedItem(r.id)"
            >{{ schedItemLoading ? '加载中…' : '详情' }}</button>
          </div>
        </div>
      </div>
      </template>
    </div>

    <!-- ─── 编排任务详情弹窗（/tasks/unified/{id} 子步骤树） ─── -->
    <div v-if="detailTask" class="detail-mask" @click.self="closeDetail()">
      <div class="detail-modal" role="dialog" aria-label="编排任务详情">
        <header class="detail-head">
          <span class="detail-title" :title="detailTask.title">{{ detailTask.title || '编排任务详情' }}</span>
          <button class="sched-actions" @click="closeDetail()" title="关闭">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </header>
        <div class="detail-body">
          <div class="task-meta">
            <span>状态：{{ agentStatusText(detailTask.status) }}</span>
            <span>进度：{{ detailTask.progress ?? 0 }}%</span>
            <span v-if="detailTask.created_at">创建：{{ detailTask.created_at.slice(0, 16) }}</span>
          </div>
          <div v-if="detailTask.stage" class="task-meta"><span>阶段：{{ detailTask.stage }}</span></div>
          <div v-if="detailTask.waiting_reason" class="task-meta"><span>等待原因：{{ detailTask.waiting_reason }}</span></div>
          <!-- 人审决策卡（PRD-human-in-loop-choices）：pending_decision 渲染选项 + 提交/拒绝；
               决策数据异常 fail-closed → 回退纯确认按钮 -->
          <div v-if="pendingDecision" class="decision-card">
            <div class="decision-ask">
              {{ pendingDecision.ask }}
              <span class="decision-kind">{{ pendingDecision.kind === 'multi_choice' ? '（可多选）' : '（单选）' }}</span>
            </div>
            <label
              v-for="c in pendingDecision.choices"
              :key="c.value"
              class="decision-choice"
            >
              <input
                :type="pendingDecision.kind === 'multi_choice' ? 'checkbox' : 'radio'"
                :name="'decision-' + pendingDecision.decisionId"
                :checked="decisionSel.includes(c.value)"
                @change="toggleChoice(pendingDecision.kind, c.value)"
              >
              <span class="choice-label">{{ c.label }}</span>
              <span v-if="c.desc" class="choice-desc" :title="c.desc">{{ c.desc }}</span>
            </label>
            <div v-if="pendingDecision.placeholder" class="fhint">{{ pendingDecision.placeholder }}</div>
            <div v-if="decisionError" class="ferr">{{ decisionError }}</div>
            <div class="task-ops">
              <button class="btn-primary sm" :disabled="decisionSubmitting" @click="submitDecision()">
                {{ decisionSubmitting ? '提交中…' : '提交选择' }}
              </button>
              <button class="btn-ghost" :disabled="decisionSubmitting" title="拒绝该决策，由服务端按策略（默认值/中止）处理" @click="rejectDecision()">拒绝</button>
            </div>
          </div>
          <div v-else-if="detailTask.status === 'waiting_user_input'" class="task-ops">
            <button class="btn-primary sm" @click="confirmAgent(detailTask.id)">人工确认，继续执行</button>
          </div>
          <div v-if="detailTask.result_preview" class="detail-preview">{{ detailTask.result_preview }}</div>
          <div v-if="detailTask.children?.length" class="detail-steps">
            <div class="plan-title">子步骤（{{ detailTask.children.length }}）</div>
            <div v-for="ch in detailTask.children" :key="ch.id" class="plan-step">
              <span class="plan-cap">{{ ch.goal || ch.title || ch.capability || ch.capability_key || ch.id }}</span>
              <span class="task-status">{{ agentStatusText(ch.status) }}{{ ch.progress !== undefined ? ' ' + ch.progress + '%' : '' }}</span>
              <div v-if="ch.result_preview" class="plan-params">{{ ch.result_preview }}</div>
              <div v-if="ch.error_message" class="ferr">{{ ch.error_message }}</div>
            </div>
          </div>
          <div v-else class="muted">暂无子步骤信息</div>
        </div>
      </div>
    </div>

    <!-- ─── 服务端定时任务执行记录详情弹窗（GET /scheduled/tasks/{id}） ─── -->
    <div v-if="schedItem" class="detail-mask" @click.self="closeSchedItem()">
      <div class="detail-modal" role="dialog" aria-label="执行记录详情">
        <header class="detail-head">
          <span class="detail-title" :title="schedItem.title">{{ schedItem.title || '执行记录详情' }}</span>
          <button class="sched-actions" @click="closeSchedItem()" title="关闭">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </header>
        <div class="detail-body">
          <div class="task-meta">
            <span>状态：{{ schedItem.status || '—' }}</span>
            <span>进度：{{ schedItem.progress ?? 0 }}%</span>
            <span v-if="schedItem.score !== undefined && schedItem.score !== null">总分：{{ schedItem.score }}</span>
          </div>
          <div v-if="schedItem.created_at" class="task-meta"><span>创建：{{ schedItem.created_at.slice(0, 16) }}</span></div>
          <div v-if="schedItem.completed_at" class="task-meta"><span>完成：{{ schedItem.completed_at.slice(0, 16) }}</span></div>
          <div v-if="schedResultSummary(schedItem)" class="detail-preview">{{ schedResultSummary(schedItem) }}</div>
          <div v-if="schedItem.error_msg" class="ferr">{{ schedItem.error_msg }}</div>
          <div v-if="schedItem.params && Object.keys(schedItem.params).length" class="detail-steps">
            <div class="plan-title">任务参数</div>
            <div class="plan-params">{{ JSON.stringify(schedItem.params, null, 1) }}</div>
          </div>
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

/* 双 Tab（定时任务=注册清单 / 执行结果=执行详情） */
.sched-tabs {
  display: flex;
  gap: 4px;
  margin: 10px 16px 0;
  padding: 3px;
  border-radius: 8px;
  background: var(--secondary, rgba(255, 255, 255, 0.06));
}
.sched-tab {
  flex: 1;
  height: 28px;
  border-radius: 6px;
  font-size: 12px;
  color: var(--muted-foreground, #8a8f98);
  transition: background var(--duration-fast, 0.15s), color var(--duration-fast, 0.15s);
}
.sched-tab.active {
  background: var(--surface);
  color: var(--foreground, #e6e8eb);
  font-weight: 600;
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

/* 拆解步骤预览 */
.plan-preview {
  border: 1px dashed var(--border);
  border-radius: 8px;
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.plan-title {
  font-size: 12px;
  font-weight: 600;
}
.plan-step {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px;
  font-size: 12px;
}
.plan-num {
  color: var(--muted-foreground, #8a8f98);
}
.plan-cap {
  font-weight: 600;
}
.plan-flag {
  font-size: 10px;
  padding: 0 5px;
  border-radius: 999px;
  border: 1px solid #fbbf24;
  color: #fbbf24;
}
.plan-params {
  flex-basis: 100%;
  font-size: 11px;
  color: var(--muted-foreground, #8a8f98);
  word-break: break-all;
  white-space: normal;
}

/* 人审决策卡（PRD-human-in-loop-choices）：待决策问题 + 候选选项 + 提交/拒绝 */
.decision-card {
  border: 1px solid color-mix(in srgb, var(--primary, #3b82f6) 45%, transparent);
  border-radius: 8px;
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.decision-ask {
  font-size: 13px;
  font-weight: 600;
}
.decision-kind {
  font-size: 11px;
  font-weight: 400;
  color: var(--muted-foreground, #8a8f98);
}
.decision-choice {
  display: flex;
  align-items: baseline;
  gap: 6px;
  font-size: 12px;
  cursor: pointer;
}
.choice-label {
  font-weight: 600;
  flex: 0 0 auto;
}
.choice-desc {
  color: var(--muted-foreground, #8a8f98);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 详情弹窗 */
.detail-mask {
  position: absolute;
  inset: 0;
  z-index: 80;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
}
.detail-modal {
  width: 340px;
  max-width: 94%;
  max-height: 80%;
  display: flex;
  flex-direction: column;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 10px;
  box-shadow: var(--shadow-4);
  overflow: hidden;
}
.detail-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border);
}
.detail-title {
  flex: 1;
  font-size: 13px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.detail-body {
  flex: 1;
  overflow: auto;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.detail-preview {
  font-size: 12px;
  color: var(--foreground, #e6e8eb);
  background: var(--secondary, rgba(255, 255, 255, 0.06));
  border-radius: 6px;
  padding: 6px 8px;
  white-space: pre-wrap;
  word-break: break-all;
}
.detail-steps {
  display: flex;
  flex-direction: column;
  gap: 5px;
  margin-top: 4px;
}
.muted {
  font-size: 12px;
  color: var(--muted-foreground, #8a8f98);
}
</style>
