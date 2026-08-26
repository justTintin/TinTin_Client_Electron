<script setup lang="ts">
// ═══════════════════════════════════════════════════════════════
// VideoRepair.vue — 视频修复
// 严格按原客户端 video_tools 流程：
//   选择生成后端(锁定 ComfyUI) → 选择工作流(assets/workflow) → 选择输入视频
//   → 提交视频处理任务（workflow 提交），返回 task_id
// 真正执行依赖服务端 workflow 能力（workflow:run）。
// ═══════════════════════════════════════════════════════════════
import { ref, computed } from 'vue'
import TButton from '@/components/common/TButton.vue'
import TSelect, { type SelectOption } from '@/components/common/TSelect.vue'

/** 原客户端 assets/workflow 中常用工作流（以修复脸部细节为默认） */
const BACKENDS: SelectOption[] = [{ label: 'ComfyUI (本地/局域网)', value: 'comfyui' }]
const DEFAULT_WF = '输入视频-修复脸部细节-20260113.json'
const WORKFLOWS: SelectOption[] = [
  { label: DEFAULT_WF, value: DEFAULT_WF },
  { label: '输入视频-高清画质修复-20260113.json', value: '输入视频-高清画质修复-20260113.json' },
]

const backend = ref('comfyui')
const workflow = ref(DEFAULT_WF)
const workflowStatus = ref('请选择工作流并加载')
const videoPath = ref('')
const videoName = ref('')
const isDragging = ref(false)
const submitting = ref(false)
const taskId = ref('')
const msg = ref('')
const isErr = ref(false)

const tintin = () => (window as any).tintin
const canSubmit = computed(() => !!videoPath.value && !!workflow.value && !submitting.value)

async function pickVideo() {
  const res = await tintin()?.dialog?.openFile({
    title: '选择要修复的视频',
    filters: [{ name: '视频', extensions: ['mp4', 'avi', 'mov', 'mkv'] }],
  })
  if (res) { videoPath.value = res; videoName.value = String(res).split(/[\\/]/).pop() || ''; msg.value = '' }
}
function onDrop(e: DragEvent) {
  isDragging.value = false
  const f = e.dataTransfer?.files?.[0]
  const p = (f as File & { path?: string })?.path
  if (p) { videoPath.value = p; videoName.value = String(p).split(/[\\/]/).pop() || '' }
}
function onWfChange() {
  workflowStatus.value = workflow.value ? `已加载工作流: ${workflow.value}` : '请选择工作流并加载'
}

async function submit() {
  if (!canSubmit.value) return
  submitting.value = true; msg.value = ''; isErr.value = false; taskId.value = ''
  try {
    // 原客户端 wfc.run_workflow(workflow_id="", files={"video":...}, values={"workflow_json":...})
    const res = await tintin()?.server?.workflowRun?.({
      workflow_id: '',
      files: { video: videoPath.value as unknown as Blob },
      values: { workflow_json: workflow.value },
    })
    if (!res) throw new Error('workflow:run 不可用（预览环境无 IPC 或服务端未就绪）')
    const id = res?.task_id ?? res?.id ?? res?.taskId
    if (!id) throw new Error((res as any)?.error || '提交失败，未返回任务 ID')
    taskId.value = String(id)
    msg.value = `任务已提交！ID: ${id}`
    try { tintin()?.shell?.showNotification('视频修复', `任务已提交：${id}`) } catch (_) {}
  } catch (e) {
    isErr.value = true; msg.value = e instanceof Error ? e.message : String(e)
  }
  submitting.value = false
}
</script>

<template>
  <div class="vrepair" style="display: flex; flex-direction: column; gap: var(--space-5); max-width: 720px;">
    <div class="field">
      <label class="label">选择生成后端</label>
      <TSelect v-model="backend" :options="BACKENDS" />
    </div>

    <div class="field">
      <label class="label">选择工作流 (assets/workflow)</label>
      <TSelect v-model="workflow" :options="WORKFLOWS" @change="onWfChange" />
      <span class="hint" :class="{ ok: workflowStatus.startsWith('已加载') }">{{ workflowStatus }}</span>
    </div>

    <div
      class="dropzone"
      :class="{ 'is-active': isDragging, 'has-file': !!videoPath }"
      @click="pickVideo"
      @drop.prevent="onDrop"
      @dragover.prevent="isDragging = true"
      @dragleave.prevent="isDragging = false"
    >
      <svg v-if="!videoPath" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12" />
      </svg>
      <div class="dropzone__text">
        <template v-if="!videoPath"><span class="dropzone__main">点击选择输入视频</span><span class="dropzone__hint">支持 MP4 / AVI / MOV / MKV</span></template>
        <template v-else><span class="dropzone__main">{{ videoName }}</span><span class="dropzone__hint">点击重新选择</span></template>
      </div>
    </div>

    <div class="action-row">
      <TButton label="提交视频处理任务" icon="rocket" :disabled="!canSubmit" :loading="submitting" @click="submit" />
    </div>

    <div v-if="msg" class="msg" :class="{ 'is-err': isErr, ok: !!taskId && !isErr }">{{ msg }}</div>
  </div>
</template>

<style scoped>
.field { display: flex; flex-direction: column; gap: var(--space-2); }
.label { font-size: var(--font-size-caption); font-weight: var(--font-weight-medium); color: var(--foreground-muted); }
.hint { font-size: var(--font-size-caption); color: var(--muted-foreground); }
.hint.ok { color: var(--success); }

.dropzone { display: flex; align-items: center; gap: var(--space-3); padding: var(--space-5); background: var(--surface-container); border: 1.5px dashed var(--border); border-radius: var(--radius-lg); color: var(--muted-foreground); cursor: pointer; transition: border-color var(--duration-fast), background var(--duration-fast); }
.dropzone:hover, .dropzone.is-active { border-color: var(--primary); background: var(--surface-container-high); }
.dropzone.has-file { border-style: solid; color: var(--foreground); }
.dropzone__text { display: flex; flex-direction: column; gap: 2px; }
.dropzone__main { font-size: var(--font-size-body); font-weight: var(--font-weight-medium); color: var(--foreground); }
.dropzone__hint { font-size: var(--font-size-caption); color: var(--muted-foreground); }

.action-row { display: flex; align-items: center; gap: var(--space-3); }
.msg { padding: var(--space-3) var(--space-4); border-radius: var(--radius-md); font-size: var(--font-size-caption); }
.msg.is-err { background: rgba(239,68,68,0.1); border: 1px solid rgba(239,68,68,0.3); color: var(--error); }
.msg.ok { background: rgba(16,185,129,0.1); border: 1px solid rgba(16,185,129,0.3); color: var(--success); }
</style>