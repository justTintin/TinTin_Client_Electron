<script setup lang="ts">
// ═══════════════════════════════════════════════════════════════
// ViralClone.vue — 仿爆款（Viral Clone）组件层（绘制 + 事件转发）
// 业务对齐原客户端 gui/viral_clone_dialog.py ViralClonePage L175-475：
//   左右分栏（左 35% 拆解复刻 / 右 65% 视频编辑工作流），对话框 1400×880。
// 2026-09-06 用户裁决：下载 / 素材浏览器链路不移植，输入统一为「本地视频上传」：
//   本地文件 → 通用 upload 到服务端 output/upload 区 → 拿 video_path 走 flow/analyze。
// 业务逻辑在 useViralClone.ts（编排）+ viralCloneLogic.ts（纯函数）
// ═══════════════════════════════════════════════════════════════
import { ref, computed, onMounted, watch } from 'vue'
import TButton from '@/components/common/TButton.vue'
import TSelect from '@/components/common/TSelect.vue'
import { useFilePicker } from '@/composables/useFilePicker'
import { useViralClone } from '@/composables/useViralClone'
import { productDisplayName } from '@/composables/viralCloneLogic'

const vc = useViralClone()
const {
  sourceVideoPath, uploadedVideoPath, uploaded, uploadPercent, uploading,
  productItems, selectedProduct, customProduct, productStatus, productsLoading,
  running, statusText, outputText, errorMessage, canRun,
  workflows, wfOptions, selectedWfId, wfLoading, wfDesc,
  formEntries, formState, editSubmitting, editPolling, editProgress,
  editStatus, editOutput, editError, editCanSubmit,
  setSourceVideo, clearSource, loadProducts, runClone,
  onGenerate, onMontage, onReview, copyScript,
  loadWorkflows, onWfChanged, pickEditFile, submitEdit, stopEditPolling,
} = vc

// ── 左侧来源：本地视频上传（拖入 / 点击选择，V3 移除链接下载链路）──
const isDragging = ref(false)
const {
  filePath: pickPath,
  fileName: sourceName,
  pickFile,
  onDrop,
  onDragOver,
  onDragLeave,
} = useFilePicker({
  dialogTitle: '选择爆款视频',
  filters: [{ name: '视频', extensions: ['mp4', 'mov', 'mkv', 'avi', 'webm', 'flv', 'm4v'] }],
  onPicked: (p) => setSourceVideo(p),
})

function onDropForward(e: DragEvent): void {
  onDrop(e)
  isDragging.value = false
}

// ── 本店产品下拉（value 用序号承接对象选中）──
const productIdx = ref(-1)
const productOptions = computed(() =>
  productItems.value.map((it, i) => ({ label: productDisplayName(it) || '未命名产品', value: i })),
)
watch(productIdx, (i) => {
  selectedProduct.value = i >= 0 ? (productItems.value[i] ?? null) : null
})

// ── 来源展示文案 ──
const sourceDisplay = computed(() => {
  if (uploaded.value && uploadedVideoPath.value) return `已上传：${uploadedVideoPath.value}`
  return sourceName.value || pickPath.value
})
const sourceReady = computed(() => uploaded.value && !!uploadedVideoPath.value)

// ── 动态表单字段辅助（类型安全：手动 :value + @input/@change）──
function setFormValue(key: string, val: unknown): void {
  formState.value = { ...formState.value, [key]: val }
}
function onTextInput(key: string, ev: Event): void {
  setFormValue(key, (ev.target as HTMLInputElement).value)
}
function onSelectChange(key: string, ev: Event): void {
  const cur = (ev.target as HTMLSelectElement).value
  setFormValue(key, cur)
}
function selectDisplayValue(ent: { key: string }): string {
  return String(formState.value[ent.key] ?? '')
}
function isFileKind(kind: string): boolean {
  return kind === 'image' || kind === 'video' || kind === 'audio'
}

onMounted(() => {
  loadProducts()
  loadWorkflows()
})

// 工作流选择变化 → 重建描述 + 动态表单
watch(selectedWfId, () => onWfChanged())
</script>

<template>
  <div class="vc-page">
    <!-- 顶部标题 -->
    <div class="vc-head">
      <h1 class="vc-title">爆款仿制（Viral Clone）</h1>
      <p class="vc-sub">
        给一条爆款视频 → 自动拆解结构（镜头/文案/节奏）→ 生成复刻脚本（保留结构、替换本店产品）；右侧可基于上传视频选择服务端工作流进行编辑处理。
      </p>
    </div>

    <!-- 左右分栏 35:65 -->
    <div class="vc-split">
      <!-- ═══ 左侧：拆解复刻 ═══ -->
      <div class="vc-left">
        <!-- ① 爆款视频来源 -->
        <div class="vc-group">
          <div class="vc-group-title">① 爆款视频来源（本地视频上传）</div>
          <div
            class="vc-dropzone"
            :class="{ 'is-active': isDragging, 'has-file': !!pickPath || !!sourceVideoPath }"
            @click="pickFile"
            @drop.prevent="onDropForward"
            @dragover.prevent="onDragOver(); isDragging = true"
            @dragleave.prevent="onDragLeave(); isDragging = false"
          >
            <svg v-if="!pickPath && !sourceVideoPath" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12" />
            </svg>
            <div class="vc-dropzone__text">
              <template v-if="!pickPath && !sourceVideoPath">
                <span class="vc-dropzone__main">拖入爆款视频 或 点击选择</span>
                <span class="vc-dropzone__hint">支持 MP4 / MOV / MKV / AVI / WEBM / FLV / M4V</span>
              </template>
              <template v-else>
                <span class="vc-dropzone__main">{{ sourceDisplay }}</span>
                <span class="vc-dropzone__hint">{{ uploading ? `上传中 ${uploadPercent}%` : '点击重新选择' }}</span>
              </template>
            </div>
          </div>
          <span v-if="errorMessage" class="vc-error">{{ errorMessage }}</span>
          <p class="vc-hint">
            提示：本地视频拖入后自动作为拆解来源，会同步到右侧编辑工作流的 video 字段；拆解前先上传到服务端 output/upload 区。
          </p>
        </div>

        <!-- ② 本店产品 -->
        <div class="vc-group">
          <div class="vc-group-title">② 本店产品（替换爆款中的产品）</div>
          <div class="vc-prod-row">
            <span class="vc-label">产品：</span>
            <TSelect
              v-model="productIdx"
              :options="productOptions"
              placeholder="搜索选择本店产品…"
              clearable
              :disabled="productsLoading"
            />
          </div>
          <div class="vc-prod-row">
            <span class="vc-label">自定义：</span>
            <input
              v-model="customProduct"
              class="vc-input"
              placeholder="或手动输入产品描述（品牌/型号/核心卖点）…"
            />
          </div>
          <span class="vc-status">{{ productStatus }}</span>
        </div>

        <!-- 操作按钮行（对照 _build_left_pane ops_box） -->
        <div class="vc-ops">
          <TButton label="拆解并复刻" icon="play" :disabled="!canRun" :loading="running" @click="runClone" />
          <TButton label="生成素材（占位）" icon="edit" size="small" variant="secondary" @click="onGenerate" />
          <TButton label="组装成片（占位）" icon="play" size="small" variant="secondary" @click="onMontage" />
          <TButton label="复制复刻脚本" icon="edit" size="small" variant="secondary" @click="copyScript" />
        </div>

        <!-- 状态 + 输出 -->
        <div class="vc-left-status">
          <span class="vc-status" :class="{ 'is-error': errorMessage }">{{ statusText }}</span>
        </div>
        <pre class="vc-output">{{ outputText }}</pre>
      </div>

      <!-- ═══ 右侧：视频编辑工作流 ═══ -->
      <div class="vc-right">
        <div class="vc-group">
          <div class="vc-group-title">③ 视频编辑工作流（处理上传/拆解的视频）</div>

          <!-- 工作流选择行 -->
          <div class="vc-wf-head">
            <span class="vc-label">选择工作流：</span>
            <TSelect
              v-model="selectedWfId"
              :options="wfOptions"
              placeholder="加载中…"
              :disabled="editSubmitting || editPolling"
            />
            <TButton label="刷新" icon="refresh" size="small" :disabled="wfLoading" :loading="wfLoading" @click="loadWorkflows" />
          </div>

          <!-- 工作流描述 -->
          <div class="vc-wf-desc">{{ wfDesc }}</div>

          <!-- 动态表单 -->
          <div class="vc-form">
            <div v-if="formEntries.length === 0" class="vc-form-empty">（当前工作流无可配置参数，可直接提交）</div>
            <div v-for="ent in formEntries" :key="ent.key" class="vc-form-row">
              <label class="vc-form-label">{{ ent.label }}{{ ent.required ? ' *' : '' }}</label>
              <!-- 文件类：路径输入 + 选择按钮 -->
              <div v-if="isFileKind(ent.kind)" class="vc-file-field">
                <input
                  class="vc-input"
                  :value="String(formState[ent.key] ?? '')"
                  :placeholder="ent.placeholder"
                  @input="onTextInput(ent.key, $event)"
                />
                <TButton label="…" icon="edit" size="small" variant="secondary" @click="pickEditFile(ent)" />
              </div>
              <!-- select 类 -->
              <select
                v-else-if="ent.kind === 'select'"
                class="vc-input vc-select"
                :value="selectDisplayValue(ent)"
                @change="onSelectChange(ent.key, $event)"
              >
                <option v-for="opt in ent.options" :key="String(opt.value)" :value="String(opt.value)">
                  {{ opt.label }}
                </option>
              </select>
              <!-- 文本类 -->
              <input
                v-else
                class="vc-input"
                :value="String(formState[ent.key] ?? '')"
                :placeholder="ent.placeholder"
                @input="onTextInput(ent.key, $event)"
              />
            </div>
          </div>

          <!-- 提交 -->
          <div class="vc-submit-row">
            <TButton label="提交编辑任务" icon="play" :disabled="!editCanSubmit" :loading="editSubmitting" @click="submitEdit" />
            <TButton v-if="editPolling" label="停止刷新" icon="pause" size="small" variant="secondary" @click="stopEditPolling" />
          </div>

          <!-- 进度条 -->
          <div v-if="editSubmitting || editPolling" class="vc-progress">
            <div class="vc-progress__fill" :style="{ width: editProgress + '%' }" />
          </div>

          <!-- 状态/结果 -->
          <span class="vc-status" :class="{ 'is-error': editError }">{{ editStatus }}</span>
          <pre class="vc-output vc-output--edit">{{ editOutput }}</pre>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.vc-page {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  height: 100%;
  margin: 0 var(--space-2) 0 0;
}
.vc-head { display: flex; flex-direction: column; gap: var(--space-1); }
.vc-title { margin: 0; font-size: 18px; font-weight: 700; color: var(--foreground); }
.vc-sub { margin: 0; font-size: var(--font-size-caption); line-height: var(--line-height-body); color: var(--muted-foreground); }

.vc-split {
  flex: 1 1 auto;
  display: flex;
  gap: var(--space-3);
  min-height: 0;
}
.vc-left, .vc-right {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  min-height: 0;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-lg);
  padding: var(--space-4);
  background: var(--surface-container);
}
.vc-left { flex: 35 1 0; overflow-y: auto; }
.vc-right { flex: 65 1 0; overflow-y: auto; }

.vc-group { display: flex; flex-direction: column; gap: var(--space-2); }
.vc-group-title { font-size: var(--font-size-body); font-weight: var(--font-weight-semibold); color: var(--foreground); }

/* 来源 dropzone */
.vc-dropzone {
  display: flex; align-items: center; gap: var(--space-3); padding: var(--space-4);
  background: color-mix(in srgb, var(--primary) 6%, var(--surface-container)); border: 1.5px dashed color-mix(in srgb, var(--primary) 40%, var(--border));
  border-radius: var(--radius-md); color: var(--muted-foreground); cursor: pointer;
  transition: border-color var(--duration-fast), background var(--duration-fast);
}
.vc-dropzone:hover, .vc-dropzone.is-active { border-color: var(--primary); background: color-mix(in srgb, var(--primary) 12%, var(--surface-container)); }
.vc-dropzone.has-file { border-style: solid; color: var(--foreground); }
.vc-dropzone__text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.vc-dropzone__main { font-size: var(--font-size-body); font-weight: var(--font-weight-medium); color: var(--foreground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.vc-dropzone__hint { font-size: var(--font-size-caption); color: var(--muted-foreground); }

/* 产品行 */
.vc-prod-row { display: flex; align-items: center; gap: var(--space-2); }
.vc-label { font-size: var(--font-size-caption); color: var(--foreground-muted); flex-shrink: 0; white-space: nowrap; }
.vc-input {
  flex: 1 1 auto; height: var(--size-input-height); padding: 0 var(--space-3);
  background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-md);
  color: var(--foreground); font-size: var(--font-size-body); min-width: 0;
}
.vc-input:focus { border-color: var(--primary); box-shadow: 0 0 0 2px var(--ring); outline: none; }

/* 操作按钮行 */
.vc-ops { display: flex; flex-wrap: wrap; gap: var(--space-2); align-items: center; }

.vc-status { font-size: var(--font-size-caption); color: var(--foreground-muted); word-break: break-all; }
.vc-status.is-error { color: var(--error); }

/* 输出区 */
.vc-output {
  flex: 1 1 auto; min-height: 0; margin: 0; padding: var(--space-3);
  background: var(--surface); border: 1px solid var(--border-subtle); border-radius: var(--radius-md);
  font-family: var(--font-mono); font-size: var(--font-size-caption); line-height: 1.6;
  color: var(--foreground); white-space: pre-wrap; word-break: break-all; overflow-y: auto;
}
.vc-output--edit { min-height: 140px; flex: 1 1 auto; }

.vc-hint { margin: 0; font-size: var(--font-size-caption); color: var(--foreground-subtle); line-height: var(--line-height-body); }
.vc-error { font-size: var(--font-size-caption); color: var(--error); word-break: break-all; }

/* 右侧工作流 */
.vc-wf-head { display: flex; align-items: center; gap: var(--space-2); }
.vc-wf-desc {
  padding: var(--space-2) var(--space-3); font-size: var(--font-size-caption);
  color: var(--foreground-muted); background: var(--surface); border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md); white-space: pre-wrap; line-height: var(--line-height-body);
}
.vc-form { display: flex; flex-direction: column; gap: var(--space-2); }
.vc-form-empty { font-size: var(--font-size-caption); color: var(--foreground-subtle); }
.vc-form-row { display: flex; align-items: center; gap: var(--space-2); }
.vc-form-label { flex: 0 0 auto; font-size: var(--font-size-caption); color: var(--foreground-muted); white-space: nowrap; min-width: 90px; }
.vc-file-field { flex: 1 1 auto; display: flex; align-items: center; gap: var(--space-1); min-width: 0; }
.vc-file-field .vc-input { flex: 1 1 auto; }
.vc-select { flex: 1 1 auto; min-width: 0; }

.vc-submit-row { display: flex; align-items: center; gap: var(--space-2); }
.vc-progress { height: 6px; background: var(--surface); border-radius: var(--radius-full); overflow: hidden; }
.vc-progress__fill { height: 100%; background: var(--primary); border-radius: var(--radius-full); transition: width var(--duration-normal) var(--easing-default); }
</style>
