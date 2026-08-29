<script setup lang="ts">
// ═══════════════════════════════════════════════════════════════
// AutoListingView — 自动上架面板（B12 UI 接线，展示组件）
// 页面结构对齐 PRD 14.3 + 原 studio/gui/auto_listing_tab.py 布局语义：
//   ① 数据包（路径+校验+摘要）② 执行（店铺下拉+开始/停止/续跑+
//     「保存后直接上架」）③ 进度日志（阶段列表+实时日志）④ 结果
//     （草稿/上架状态、失败原因、重试入口、打开结果目录、历史运行）。
// 纯展示 + 事件转发：全部状态/进度/编组在 composables/useAutoListing.ts
//   （业务纯函数在 autoListingMeta.ts）；「打开抖店工作台」经容器接
//   selectFxg（Browser.vue openFxg）。
// ═══════════════════════════════════════════════════════════════
import { ref, watch, nextTick, onMounted } from 'vue'
import { useAutoListing } from '../composables/useAutoListing'

const emit = defineEmits<{
  /** 打开抖店工作台分区会话（容器接 selectFxg） */
  (e: 'open-fxg'): void
}>()

const al = useAutoListing()
const {
  stores, runStatusMeta,
  shopKey, publishAfterSave, saving, saved, saveCfg,
  inputPath, validating, summary, validateError, validatePackage,
  running, actionBusy, actionError, startTask, stopTask, resumeTask,
  phases, logs, lastResult,
  runs, runsLoaded, openDirMsg, openResult,
} = al

const logEl = ref<HTMLDivElement | null>(null)

onMounted(() => { void al.init() })

// 日志区自动滚到底
watch(logs, async () => {
  await nextTick()
  if (logEl.value) logEl.value.scrollTop = logEl.value.scrollHeight
})

/** 结果卡：当前运行任务的展示文案 */
function currentRunText(): string {
  if (running.value) return `任务运行中（runId=${al.currentRunId.value}）…`
  return al.currentRunId.value ? `最近任务：${al.currentRunId.value}` : '尚无运行记录'
}
</script>

<template>
  <div class="autolisting-view-area">
    <div class="al-header">
      <div class="al-title">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M12 19V5" />
          <path d="M5 12l7-7 7 7" />
        </svg>
        <span>自动上架</span>
        <span v-if="running" class="al-badge running">运行中</span>
      </div>
      <p class="al-desc">操作抖店工作台完成商品上架（复用内置浏览器已登录会话）。</p>
    </div>

    <div class="al-body">
      <!-- ① 数据包 -->
      <div class="al-card">
        <div class="al-card-title">① 数据包</div>
        <div class="al-row">
          <input v-model="inputPath" class="al-input" placeholder="选择包含 sku.xlsx、主图、详情页、sku图 的目录或 .zip" />
          <button class="al-btn primary" :disabled="validating || actionBusy" @click="validatePackage()">
            {{ validating ? '校验中…' : '校验' }}
          </button>
        </div>

        <div v-if="summary" class="al-summary">
          <div>完成：店铺：{{ summary.shopName }} | 标题：{{ summary.title || '（未命名）' }} | SKU：{{ summary.skuCount }} | 主图：{{ summary.mainImages }} | 详情：{{ summary.detailImages }} | SKU图：{{ summary.skuImages }}</div>
          <div class="al-warn-line">警告：{{ summary.warnings && summary.warnings.length ? summary.warnings.join('；') : '无' }}</div>
          <div class="al-hint">runId：{{ summary.runId }}（开始任务将复用本次 staging，从阶段1继续）</div>
        </div>
        <div v-else-if="validating" class="al-hint">正在校验…</div>
        <div v-else-if="validateError" class="al-error">{{ validateError }}</div>
        <div v-else class="al-hint">尚未校验数据包</div>
      </div>

      <!-- ② 执行 -->
      <div class="al-card">
        <div class="al-card-title">② 执行</div>
        <div class="al-row">
          <label class="al-label">目标店铺</label>
          <select v-model="shopKey" class="al-select">
            <option v-for="s in stores" :key="s.key" :value="s.key">{{ s.name }}（{{ s.key }}）</option>
          </select>
          <label class="al-check">
            <input v-model="publishAfterSave" type="checkbox" />
            <span>保存后直接上架</span>
          </label>
          <button class="al-btn" :disabled="saving" @click="saveCfg()">{{ saved ? '已保存' : '保存配置' }}</button>
        </div>
        <div class="al-row">
          <button class="al-btn primary" :disabled="running || actionBusy" @click="startTask()">开始自动上架</button>
          <button class="al-btn" :disabled="!running || actionBusy" @click="stopTask()">停止</button>
          <button class="al-btn" @click="emit('open-fxg')">打开抖店工作台</button>
        </div>
        <div class="al-hint">断点续跑在下方「结果」卡对未完成任务操作；浏览器未打开时会提示先打开抖店工作台。</div>
        <div v-if="actionError" class="al-error">{{ actionError }}</div>
      </div>

      <!-- ③ 进度日志 -->
      <div class="al-card">
        <div class="al-card-title">③ 进度日志</div>
        <div v-if="phases.length" class="al-phases">
          <div v-for="(ph, i) in phases" :key="i" class="al-phase">
            <span class="al-phase-tag">{{ ph.stage }}</span>
            <span class="al-phase-msg">{{ ph.message }}</span>
          </div>
        </div>
        <div v-else class="al-hint">暂无阶段进度</div>
        <div ref="logEl" class="al-log">
          <div v-for="(l, i) in logs" :key="i" class="al-log-line">{{ l }}</div>
          <div v-if="!logs.length" class="al-log-empty">运行日志会显示在这里</div>
        </div>
      </div>

      <!-- ④ 结果 -->
      <div class="al-card">
        <div class="al-card-title">④ 结果</div>
        <div class="al-result-current">
          <div class="al-hint">{{ currentRunText() }}</div>
          <template v-if="lastResult">
            <div class="al-result-line">
              草稿保存：<b :class="lastResult.saved ? 'ok' : 'warn'">{{ lastResult.saved ? '成功' : '未确认' }}</b>
              <span v-if="lastResult.publish_attempted"> | 已尝试直接上架</span>
              <span v-if="lastResult.sku_count"> | SKU：{{ lastResult.sku_count }}</span>
            </div>
            <div v-if="lastResult.result_dir" class="al-row">
              <span class="al-result-dir">{{ lastResult.result_dir }}</span>
              <button class="al-btn" @click="openResult(al.currentRunId.value)">打开结果目录</button>
            </div>
          </template>
        </div>

        <div class="al-sub-title">历史运行</div>
        <div v-if="!runs.length && runsLoaded" class="al-hint">暂无历史运行</div>
        <div v-else class="al-runs">
          <div v-for="r in runs" :key="r.runId" class="al-run">
            <div class="al-run-head">
              <span class="al-run-id">{{ r.runId }}</span>
              <span class="al-run-meta">{{ r.title || r.sourceName || '' }}</span>
            </div>
            <div class="al-run-foot">
              <span class="al-phase-tag">{{ runStatusMeta(r).stageText }}</span>
              <span class="al-status" :class="r.status">{{ runStatusMeta(r).statusText }}</span>
              <span class="al-run-btns">
                <button
                  v-if="runStatusMeta(r).canResume"
                  class="al-btn small"
                  :disabled="running || actionBusy"
                  :title="runStatusMeta(r).canRetry ? '失败任务重试（断点续跑）' : '断点续跑'"
                  @click="resumeTask(r.runId)"
                >{{ runStatusMeta(r).canRetry ? '重试' : '续跑' }}</button>
                <button v-if="runStatusMeta(r).isDone" class="al-btn small" @click="openResult(r.runId)">打开结果目录</button>
              </span>
            </div>
          </div>
        </div>
        <div v-if="openDirMsg" class="al-error">{{ openDirMsg }}</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.autolisting-view-area {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  padding: 20px 24px;
}
.autolisting-view-area::-webkit-scrollbar { width: 6px; }
.autolisting-view-area::-webkit-scrollbar-thumb { background: var(--surface-container-high); border-radius: 3px; }

.al-header { margin-bottom: 16px; }
.al-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 15px;
  font-weight: 600;
  color: var(--foreground);
}
.al-badge {
  font-size: 11px;
  font-weight: 500;
  padding: 1px 8px;
  border-radius: 999px;
}
.al-badge.running { background: rgba(99, 102, 241, 0.15); color: var(--primary, #6366f1); }
.al-desc {
  margin-top: 4px;
  font-size: 12px;
  color: var(--muted-foreground);
}

.al-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-width: 720px;
}
.al-card {
  border: 1px solid var(--border);
  border-radius: var(--radius-lg, 10px);
  background: var(--surface-container);
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.al-card-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--foreground);
}
.al-sub-title {
  margin-top: 4px;
  font-size: 12px;
  font-weight: 600;
  color: var(--foreground);
}
.al-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.al-label {
  flex: 0 0 auto;
  font-size: 12px;
  color: var(--muted-foreground);
}
.al-input {
  flex: 1;
  min-width: 200px;
  height: 30px;
  padding: 0 10px;
  border-radius: var(--radius-md, 8px);
  border: 1px solid var(--border);
  background: var(--background);
  color: var(--foreground);
  font-size: 13px;
}
.al-select {
  height: 30px;
  padding: 0 8px;
  border-radius: var(--radius-md, 8px);
  border: 1px solid var(--border);
  background: var(--background);
  color: var(--foreground);
  font-size: 12px;
}
.al-check {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  color: var(--muted-foreground);
  cursor: pointer;
}
.al-btn {
  flex: 0 0 auto;
  height: 30px;
  padding: 0 12px;
  border-radius: var(--radius-md, 8px);
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--foreground);
  font-size: 12px;
  cursor: pointer;
}
.al-btn.small { height: 24px; padding: 0 8px; font-size: 11px; }
.al-btn:hover { border-color: var(--primary); color: var(--primary); }
.al-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.al-btn.primary {
  background: var(--primary, #6366f1);
  border-color: var(--primary, #6366f1);
  color: #fff;
}
.al-btn.primary:hover { opacity: 0.9; color: #fff; }
.al-hint {
  font-size: 12px;
  color: var(--muted-foreground);
}
.al-error {
  font-size: 12px;
  color: #e5484d;
  background: rgba(229, 72, 77, 0.08);
  border: 1px solid rgba(229, 72, 77, 0.25);
  border-radius: var(--radius-md, 8px);
  padding: 6px 10px;
  word-break: break-all;
}
.al-summary {
  font-size: 12px;
  color: var(--foreground);
  background: var(--background);
  border: 1px solid var(--border);
  border-radius: var(--radius-md, 8px);
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  word-break: break-all;
}
.al-warn-line { color: #d97706; }

/* ③ 进度日志 */
.al-phases {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.al-phase {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}
.al-phase-tag {
  flex: 0 0 auto;
  font-size: 11px;
  color: var(--primary, #6366f1);
  background: rgba(99, 102, 241, 0.1);
  border-radius: 4px;
  padding: 1px 6px;
}
.al-phase-msg {
  color: var(--foreground);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.al-log {
  height: 180px;
  overflow-y: auto;
  background: var(--background);
  border: 1px solid var(--border);
  border-radius: var(--radius-md, 8px);
  padding: 8px 10px;
  font-family: ui-monospace, Consolas, 'Courier New', monospace;
  font-size: 11px;
  line-height: 1.7;
}
.al-log-line { color: var(--foreground); word-break: break-all; white-space: pre-wrap; }
.al-log-empty { color: var(--muted-foreground); }

/* ④ 结果 */
.al-result-current {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.al-result-line {
  font-size: 12px;
  color: var(--foreground);
}
.al-result-line .ok { color: #16a34a; }
.al-result-line .warn { color: #d97706; }
.al-result-dir {
  font-size: 11px;
  color: var(--muted-foreground);
  word-break: break-all;
}
.al-runs {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 260px;
  overflow-y: auto;
}
.al-run {
  border: 1px solid var(--border);
  border-radius: var(--radius-md, 8px);
  background: var(--background);
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.al-run-head {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}
.al-run-id { font-weight: 600; color: var(--foreground); }
.al-run-meta { color: var(--muted-foreground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.al-run-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
}
.al-status { color: var(--muted-foreground); }
.al-status.done { color: #16a34a; }
.al-status.failed { color: #e5484d; }
.al-status.running { color: var(--primary, #6366f1); }
.al-run-btns { margin-left: auto; display: inline-flex; gap: 6px; }
</style>
