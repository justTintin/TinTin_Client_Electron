<script setup lang="ts">
// ═══════════════════════════════════════════════════════════════
// VideoRepair.vue — 视频修复（条目⑤ 组件层：绘制 + 事件转发）
// 业务对齐原客户端 gui/main_window_pages.py setup_video_tools_page L430-497
// + gui/main_window_aigen.py run_video_tool_task/_query_single_rh_task/
//   _auto_download_rh_results：
//   生成后端（工作流自带）→ 工作流选择（GET /workflows?scope=client，
//   默认「修复脸部细节」L492-497）→ 选视频 → POST /workflows/{id}/run
//   （multipart，{path} 包装本地文件）→ 3s 轮询 GET /workflows/task/{id}
//   → 终态回填结果 + 下载（saveFile+downloadResult）+ 打开目录 + 失败透出
// 业务逻辑在 useVideoRepair.ts（编排）+ videoRepairLogic.ts（纯函数）
// ═══════════════════════════════════════════════════════════════
import { ref, onMounted } from 'vue'
import TButton from '@/components/common/TButton.vue'
import TSelect from '@/components/common/TSelect.vue'
import { useFilePicker } from '@/composables/useFilePicker'
import { useVideoRepair } from '@/composables/useVideoRepair'

const r = useVideoRepair()
const {
  wfOptions, selectedWfId, wfLoading, wfStatusText, backendText,
  videoName, submitting, uploadPercent, taskId, polling, statusInfo,
  errorMessage, results, downloadingIdx, canSubmit,
  loadWorkflows, setVideo, stopPolling, downloadEntry, resultDisplayName,
} = r

const isDragging = ref(false)

const {
  filePath: videoPath,
  pickFile: pickVideo,
  onDrop,
  onDragOver,
  onDragLeave,
} = useFilePicker({
  dialogTitle: '选择要修复的视频',
  filters: [{ name: '视频', extensions: ['mp4', 'avi', 'mov', 'mkv'] }],
  onPicked: (p) => setVideo(p),
})

function onDropForward(e: DragEvent): void {
  onDrop(e)
  isDragging.value = false
}

onMounted(loadWorkflows)
</script>

<template>
  <div class="tool-form">
    <!-- 生成后端（新口径：后端由服务端工作流自带，原版锁 ComfyUI 语义保留为只读展示） -->
    <div class="form-field">
      <label class="form-label">生成后端</label>
      <div class="backend-badge">{{ backendText }}（由所选工作流决定）</div>
    </div>

    <!-- 工作流选择（对照 vt_workflow_selector + 默认修复脸部细节） -->
    <div class="form-field">
      <div class="field-head">
        <label class="form-label">选择工作流（服务端工作流库）</label>
        <TButton
          label="刷新"
          icon="refresh"
          size="small"
          :disabled="wfLoading"
          :loading="wfLoading"
          @click="loadWorkflows"
        />
      </div>
      <TSelect
        v-model="selectedWfId"
        :options="wfOptions"
        placeholder="选择工作流"
        :disabled="submitting || polling"
      />
      <span class="hint" :class="{ ok: wfStatusText.startsWith('已加载') }">{{ wfStatusText }}</span>
    </div>

    <!-- 输入视频 -->
    <div
      class="dropzone"
      :class="{ 'is-active': isDragging, 'has-file': !!videoPath }"
      @click="pickVideo"
      @drop.prevent="onDropForward"
      @dragover.prevent="onDragOver(); isDragging = true"
      @dragleave.prevent="onDragLeave(); isDragging = false"
    >
      <svg v-if="!videoPath" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12" />
      </svg>
      <div class="dropzone__text">
        <template v-if="!videoPath">
          <span class="dropzone__main">点击选择输入视频</span>
          <span class="dropzone__hint">支持 MP4 / AVI / MOV / MKV</span>
        </template>
        <template v-else>
          <span class="dropzone__main">{{ videoName }}</span>
          <span class="dropzone__hint">点击重新选择</span>
        </template>
      </div>
    </div>

    <!-- 提交 -->
    <div class="action-row">
      <TButton
        label="提交视频处理任务"
        icon="play"
        :disabled="!canSubmit"
        :loading="submitting"
        @click="r.submit()"
      />
      <span v-if="submitting && uploadPercent > 0 && uploadPercent < 100" class="upload-progress">
        上传中 {{ uploadPercent }}%
      </span>
      <TButton
        v-if="polling"
        label="停止刷新"
        icon="pause"
        size="small"
        @click="stopPolling"
      />
    </div>

    <!-- 任务状态（对照 rh 任务行：状态中文 + 进度） -->
    <div v-if="taskId" class="task">
      <div class="task__head">
        <span class="task__id">任务 ID：{{ taskId }}</span>
        <span v-if="statusInfo" class="task__status" :class="`phase-${statusInfo.phase}`">
          {{ statusInfo.text }}
        </span>
      </div>
      <div v-if="statusInfo && statusInfo.phase === 'running'" class="progress-bar">
        <div class="progress-bar__fill" :style="{ width: statusInfo.progress + '%' }" />
      </div>
      <span v-if="polling" class="task__polling">每 3 秒轮询任务状态…</span>
    </div>

    <!-- 失败分支（对照 FAILED → errorMessage 透出） -->
    <div v-if="errorMessage" class="error-msg">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="10" />
        <line x1="12" y1="8" x2="12" y2="12" />
        <line x1="12" y1="16" x2="12.01" y2="16" />
      </svg>
      <span>{{ errorMessage }}</span>
    </div>

    <!-- 结果回填（对照 _auto_download_rh_results：结果列表 + 下载） -->
    <div v-if="results.length" class="result">
      <div class="result__head">
        <span class="result__title">修复结果（{{ results.length }} 个）</span>
      </div>
      <div v-for="(entry, i) in results" :key="i" class="result__row">
        <span class="result__name" :title="entry.url || entry.text || ''">
          {{ resultDisplayName(entry) }}
        </span>
        <TButton
          label="下载"
          icon="download"
          size="small"
          :loading="downloadingIdx === i"
          @click="downloadEntry(entry, i)"
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
.tool-form { display: flex; flex-direction: column; gap: var(--space-5); }

.form-field { display: flex; flex-direction: column; gap: var(--space-2); }
.form-label { font-size: var(--font-size-caption); font-weight: var(--font-weight-medium); color: var(--foreground-muted); }
.field-head { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); }
.backend-badge {
  align-self: flex-start; padding: 4px var(--space-3);
  font-size: var(--font-size-caption); color: var(--foreground-muted);
  background: var(--surface-container); border: 1px solid var(--border);
  border-radius: var(--radius-full);
}
.hint { font-size: var(--font-size-caption); color: var(--muted-foreground); }
.hint.ok { color: var(--success); }

.dropzone {
  display: flex; align-items: center; gap: var(--space-3); padding: var(--space-5);
  background: var(--surface-container); border: 1.5px dashed var(--border);
  border-radius: var(--radius-lg); color: var(--muted-foreground); cursor: pointer;
  transition: border-color var(--duration-fast), background var(--duration-fast);
}
.dropzone:hover, .dropzone.is-active { border-color: var(--primary); background: var(--surface-container-high); }
.dropzone.has-file { border-style: solid; color: var(--foreground); }
.dropzone__text { display: flex; flex-direction: column; gap: 2px; }
.dropzone__main { font-size: var(--font-size-body); font-weight: var(--font-weight-medium); color: var(--foreground); }
.dropzone__hint { font-size: var(--font-size-caption); color: var(--muted-foreground); }

.action-row { display: flex; align-items: center; gap: var(--space-3); }
.upload-progress { font-size: var(--font-size-caption); color: var(--muted-foreground); }

.task { display: flex; flex-direction: column; gap: var(--space-2); padding: var(--space-3) var(--space-4); background: var(--surface-container); border: 1px solid var(--border-subtle); border-radius: var(--radius-lg); }
.task__head { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); }
.task__id { font-size: var(--font-size-caption); color: var(--foreground-muted); font-family: var(--font-mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.task__status { font-size: var(--font-size-caption); font-weight: var(--font-weight-medium); padding: 2px var(--space-3); border-radius: var(--radius-full); background: var(--surface-container-high); color: var(--foreground-muted); flex-shrink: 0; }
.task__status.phase-running { color: var(--info); background: rgba(59, 130, 246, 0.15); }
.task__status.phase-done { color: var(--success); background: rgba(16, 185, 129, 0.15); }
.task__status.phase-failed { color: var(--error); background: rgba(239, 68, 68, 0.15); }
.task__polling { font-size: var(--font-size-caption); color: var(--muted-foreground); }
.progress-bar { height: 6px; background: var(--surface); border-radius: var(--radius-full); overflow: hidden; }
.progress-bar__fill { height: 100%; background: var(--primary); border-radius: var(--radius-full); transition: width var(--duration-slow) var(--easing-default); }

.error-msg {
  display: flex; align-items: center; gap: var(--space-2);
  padding: var(--space-3) var(--space-4);
  background: rgba(239, 68, 68, 0.1); border: 1px solid rgba(239, 68, 68, 0.3);
  border-radius: var(--radius-md); color: var(--error); font-size: var(--font-size-caption);
}

.result { display: flex; flex-direction: column; gap: var(--space-2); padding: var(--space-4); background: var(--surface-container); border: 1px solid var(--border-subtle); border-radius: var(--radius-lg); }
.result__head { margin-bottom: var(--space-1); }
.result__title { font-size: var(--font-size-lead); font-weight: var(--font-weight-semibold); color: var(--foreground); }
.result__row { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); padding: var(--space-2) var(--space-3); background: var(--surface); border: 1px solid var(--border-subtle); border-radius: var(--radius-md); }
.result__name { font-size: var(--font-size-caption); color: var(--foreground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
