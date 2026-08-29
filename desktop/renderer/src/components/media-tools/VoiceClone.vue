<script setup lang="ts">
// ═══════════════════════════════════════════════════════════════
// VoiceClone.vue — 声音克隆（条目④ 组件层：绘制 + 事件转发）
// 业务对齐原客户端 gui/voice_clone_page.py：
//   参考音频二选一（上传/样本库）→ 识别参考音频文本（ASR+LLM 标点，
//   _transcribe_ref_audio L690-743）→ 整体克隆（_clone_whole）→
//   一键拆分填充（LLM 分句+漏字校验+短句合并，_split_and_populate_text_only
//   L1566-1613）→ 逐行文案表（增删改/逐行生成/试听/导出，L494-609/1043-1053）
// 业务逻辑在 useVoiceCloneStudio.ts（编排）+ voiceCloneLogic.ts（纯函数）
// ═══════════════════════════════════════════════════════════════
import { ref, onMounted } from 'vue'
import TButton from '@/components/common/TButton.vue'
import TSelect from '@/components/common/TSelect.vue'
import { useFilePicker } from '@/composables/useFilePicker'
import { useVoiceCloneStudio } from '@/composables/useVoiceCloneStudio'
import type { RowStatus } from '@/composables/useVoiceCloneStudio'

const s = useVoiceCloneStudio()
const {
  refText, transcribing, voiceOptions, samples, voice,
  wholeText, rows, splitting, generating, stageText, maxChars,
  wholeTask, wholeProgress,
  refReady, canSplit,
  loadCatalog, setRefAudio, selectSample, transcribeRefAudio,
  splitIntoRows, updateRowText, removeRow, addRow, clearRows,
  generateRow, generateAll, generateWhole, downloadRow,
} = s

type RefMode = 'upload' | 'sample'
const refMode = ref<RefMode>('upload')
const isDragging = ref(false)

// 参考音频选择 + 拖拽（共享 composable；选中后转发给业务层）
const {
  filePath: refFilePath,
  fileName: refFileName,
  pickFile: pickRefFile,
  onDrop,
  onDragOver,
  onDragLeave,
  resolveSrc,
} = useFilePicker({
  dialogTitle: '选择参考音频',
  filters: [{ name: '音频', extensions: ['mp3', 'wav', 'm4a', 'flac', 'aac', 'ogg'] }],
  onPicked: (p) => setRefAudio(p),
})

function onDropForward(e: DragEvent): void {
  onDrop(e)
  isDragging.value = false
  if (refFilePath.value) setRefAudio(refFilePath.value)
}

const ROW_STATUS_TEXT: Record<RowStatus, string> = {
  idle: '待生成',
  running: '生成中',
  done: '完成',
  failed: '失败',
}
function rowStatusClass(st: RowStatus): string {
  return { idle: '', running: 'is-running', done: 'is-done', failed: 'is-failed' }[st] || ''
}

onMounted(loadCatalog)
</script>

<template>
  <div class="tool-form">
    <!-- 参考音频来源（对照音色视频目录 / 参考音频样本库二选一） -->
    <div class="form-field">
      <label class="form-label">参考音频</label>
      <div class="segmented">
        <button
          class="segmented__btn"
          :class="{ 'is-active': refMode === 'upload' }"
          :disabled="transcribing"
          @click="refMode = 'upload'"
        >
          上传音频
        </button>
        <button
          class="segmented__btn"
          :class="{ 'is-active': refMode === 'sample' }"
          :disabled="transcribing"
          @click="refMode = 'sample'"
        >
          从样本选择
        </button>
      </div>
    </div>

    <!-- 上传模式 -->
    <div
      v-if="refMode === 'upload'"
      class="dropzone"
      :class="{ 'is-active': isDragging, 'has-file': !!refFilePath }"
      @click="pickRefFile"
      @drop.prevent="onDropForward"
      @dragover.prevent="onDragOver(); isDragging = true"
      @dragleave.prevent="onDragLeave(); isDragging = false"
    >
      <svg v-if="!refFilePath" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12" />
      </svg>
      <div class="dropzone__text">
        <template v-if="!refFilePath">
          <span class="dropzone__main">点击选择参考音频或拖拽到此处</span>
          <span class="dropzone__hint">支持 MP3 / WAV / M4A / FLAC</span>
        </template>
        <template v-else>
          <span class="dropzone__main">{{ refFileName }}</span>
          <span class="dropzone__hint">点击重新选择</span>
        </template>
      </div>
    </div>

    <!-- 样本选择模式 -->
    <div v-else class="sample-grid">
      <button
        v-for="item in samples"
        :key="item.id"
        class="sample-card"
        :class="{ 'is-selected': s.selectedSampleId === item.id }"
        @click="selectSample(item.id)"
      >
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M3 18v-6a9 9 0 0 1 18 0v6" />
          <path d="M21 19a2 2 0 0 1-2 2h-1v-6h3zM3 19a2 2 0 0 0 2 2h1v-6H3z" />
        </svg>
        <span class="sample-card__name">{{ item.name }}</span>
      </button>
      <div v-if="!samples.length" class="sample-empty">暂无参考样本，请使用上传方式</div>
    </div>

    <!-- 参考文本：ASR 转写取词 + LLM 标点（对照 _transcribe_ref_audio） -->
    <div class="form-field">
      <div class="field-head">
        <label class="form-label">参考文本（可先「识别参考音频文本」自动取词）</label>
        <TButton
          :label="transcribing ? '正在识别文本...' : '识别参考音频文本'"
          icon="search"
          size="small"
          :disabled="transcribing || !refReady"
          :loading="transcribing"
          @click="transcribeRefAudio"
        />
      </div>
      <textarea
        v-model="refText"
        class="text-area"
        rows="3"
        placeholder="上传/选择参考音频后，点击右上角按钮自动识别；也可直接手输参考文案"
      />
      <span class="form-hint">
        拆分合并用的单行字数上限：约 {{ maxChars }} 字（15 秒安全时长；由样本语速推算）
      </span>
    </div>

    <!-- 音色 -->
    <div class="form-field">
      <label class="form-label">合成音色（无参考音频时使用）</label>
      <TSelect
        v-model="voice"
        :options="voiceOptions.map((v) => ({ label: v.name, value: v.id }))"
        placeholder="选择音色"
      />
    </div>

    <!-- 待克隆整体文案 + 整体克隆 / 一键拆分填充 -->
    <div class="form-field">
      <label class="form-label">待克隆整体文案</label>
      <textarea
        v-model="wholeText"
        class="text-area"
        rows="5"
        placeholder="输入要合成语音的文本；每段文本合成时长不超过 20 秒"
      />
      <div class="action-row">
        <TButton
          label="整体克隆人声"
          icon="play"
          :disabled="!wholeText.trim() || !refReady"
          @click="generateWhole"
        />
        <TButton
          label="一键拆分填充"
          icon="edit"
          :disabled="!canSplit"
          :loading="splitting"
          @click="splitIntoRows"
        />
        <span
          class="hint-link"
          title="拆分流程：优先 AI 智能断句（不可用退回本地规则）；按样本语速合并短句（单行≤15秒）；AI 疑似漏字自动退回本地拆分，编号一字不丢"
        >拆分策略说明</span>
      </div>
      <span v-if="wholeTask.isProcessing && wholeProgress > 0 && wholeProgress < 100" class="upload-progress">
        上传中 {{ wholeProgress }}%
      </span>
      <span v-if="wholeTask.errorMsg" class="form-error">{{ wholeTask.errorMsg }}</span>
      <audio
        v-if="wholeTask.status === 'done' && (wholeTask.resultUrl || wholeTask.resultPath)"
        class="audio-player"
        :src="resolveSrc(wholeTask.resultUrl) || resolveSrc(wholeTask.resultPath)"
        controls
      />
    </div>

    <!-- 阶段提示 -->
    <div v-if="stageText" class="stage-line">{{ stageText }}</div>

    <!-- 逐行配音文案表（对照 voice_table：文案可编辑 + 逐行生成/试听/删除） -->
    <div v-if="rows.length" class="rows">
      <div class="rows__head">
        <span class="rows__title">逐行配音文案（{{ rows.length }} 行）</span>
        <div class="rows__ops">
          <TButton label="添加一行" icon="plus" size="small" @click="addRow" />
          <TButton
            label="逐行克隆"
            icon="play"
            size="small"
            :disabled="generating"
            :loading="generating"
            @click="generateAll"
          />
          <TButton label="清空" icon="trash" size="small" :disabled="generating" @click="clearRows" />
        </div>
      </div>
      <div
        v-for="(row, i) in rows"
        :key="i"
        class="row"
        :class="rowStatusClass(row.status)"
      >
        <span class="row__idx">{{ i + 1 }}</span>
        <input
          class="row__text"
          :value="row.text"
          placeholder="本行配音文案"
          :disabled="row.status === 'running'"
          @input="updateRowText(i, ($event.target as HTMLInputElement).value)"
        />
        <audio
          v-if="row.status === 'done' && row.audioUrl"
          class="row__audio"
          :src="resolveSrc(row.audioUrl)"
          controls
        />
        <span class="row__status" :class="rowStatusClass(row.status)">
          {{ ROW_STATUS_TEXT[row.status] }}<template v-if="row.error">：{{ row.error }}</template>
        </span>
        <div class="row__actions">
          <button
            class="icon-btn"
            title="生成本行"
            :disabled="row.status === 'running' || generating"
            @click="generateRow(i)"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M5 3l14 9-14 9V3z"/></svg>
          </button>
          <button
            class="icon-btn"
            title="下载本行音频"
            :disabled="row.status !== 'done'"
            @click="downloadRow(i)"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>
          </button>
          <button
            class="icon-btn"
            title="删除本行"
            :disabled="row.status === 'running' || generating"
            @click="removeRow(i)"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.tool-form { display: flex; flex-direction: column; gap: var(--space-5); }

.form-field { display: flex; flex-direction: column; gap: var(--space-2); }
.form-label { font-size: var(--font-size-caption); font-weight: var(--font-weight-medium); color: var(--foreground-muted); }
.form-hint { font-size: var(--font-size-caption); color: var(--muted-foreground); }
.form-error { font-size: var(--font-size-caption); color: var(--error); }
.field-head { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); }

/* 分段切换 */
.segmented {
  display: inline-flex; padding: 2px; background: var(--surface-container);
  border: 1px solid var(--border); border-radius: var(--radius-md); align-self: flex-start;
}
.segmented__btn {
  padding: 0 var(--space-4); height: var(--size-button-height-sm);
  font-size: var(--font-size-caption); font-weight: var(--font-weight-medium);
  color: var(--muted-foreground); border-radius: var(--radius-sm);
  transition: background var(--duration-fast), color var(--duration-fast);
}
.segmented__btn.is-active { background: var(--primary); color: var(--primary-foreground); }
.segmented__btn:disabled { opacity: 0.5; cursor: not-allowed; }

/* 拖拽上传区 */
.dropzone {
  display: flex; align-items: center; gap: var(--space-3); padding: var(--space-6);
  background: var(--surface-container); border: 1.5px dashed var(--border);
  border-radius: var(--radius-lg); color: var(--muted-foreground); cursor: pointer;
  transition: border-color var(--duration-fast), background var(--duration-fast);
}
.dropzone:hover, .dropzone.is-active { border-color: var(--primary); background: var(--surface-container-high); }
.dropzone.has-file { border-style: solid; color: var(--foreground); }
.dropzone__text { display: flex; flex-direction: column; gap: 2px; }
.dropzone__main { font-size: var(--font-size-body); font-weight: var(--font-weight-medium); color: var(--foreground); }
.dropzone__hint { font-size: var(--font-size-caption); color: var(--muted-foreground); }

/* 样本选择网格 */
.sample-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: var(--space-3); }
.sample-card {
  display: flex; flex-direction: column; align-items: center; gap: var(--space-2);
  padding: var(--space-4); background: var(--surface-container);
  border: 1px solid var(--border); border-radius: var(--radius-md);
  color: var(--foreground-muted);
  transition: border-color var(--duration-fast), background var(--duration-fast), color var(--duration-fast);
}
.sample-card:hover { border-color: var(--primary); color: var(--foreground); }
.sample-card.is-selected { border-color: var(--primary); background: rgba(109, 93, 252, 0.12); color: var(--primary); }
.sample-card__name { font-size: var(--font-size-caption); text-align: center; word-break: break-all; }
.sample-empty {
  grid-column: 1 / -1; padding: var(--space-4); text-align: center;
  font-size: var(--font-size-caption); color: var(--muted-foreground);
}

/* 文本域 */
.text-area {
  width: 100%; padding: var(--space-3); background: var(--surface-container);
  border: 1px solid var(--border); border-radius: var(--radius-md);
  color: var(--foreground); font-size: var(--font-size-body);
  line-height: var(--line-height-relaxed); outline: none; resize: vertical;
  box-sizing: border-box;
  transition: border-color var(--duration-fast), box-shadow var(--duration-fast);
}
.text-area::placeholder { color: var(--muted-foreground); }
.text-area:focus { border-color: var(--primary); box-shadow: 0 0 0 2px var(--ring); }

.action-row { display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap; }
.hint-link {
  font-size: var(--font-size-caption); color: var(--muted-foreground);
  cursor: help; text-decoration: underline dotted;
}
.upload-progress { font-size: var(--font-size-caption); color: var(--muted-foreground); }
.audio-player { width: 100%; }
.stage-line { font-size: var(--font-size-caption); color: var(--foreground-muted); }

/* 逐行文案表 */
.rows { display: flex; flex-direction: column; gap: var(--space-2); }
.rows__head { display: flex; align-items: center; justify-content: space-between; }
.rows__title { font-size: var(--font-size-lead); font-weight: var(--font-weight-semibold); color: var(--foreground); }
.rows__ops { display: flex; align-items: center; gap: var(--space-2); }
.row {
  display: flex; align-items: center; gap: var(--space-2);
  padding: var(--space-2) var(--space-3); border: 1px solid var(--border-subtle);
  border-left: 3px solid transparent; border-radius: var(--radius-md);
  background: var(--surface-container);
}
.row.is-running { border-left-color: var(--info); }
.row.is-done { border-left-color: var(--success); }
.row.is-failed { border-left-color: var(--error); }
.row__idx { width: 22px; text-align: center; font-size: var(--font-size-caption); color: var(--muted-foreground); flex-shrink: 0; }
.row__text {
  flex: 1; min-width: 0; height: var(--size-input-height); padding: 0 var(--space-3);
  background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-sm);
  color: var(--foreground); font-size: var(--font-size-body); outline: none;
  transition: border-color var(--duration-fast), box-shadow var(--duration-fast);
}
.row__text:focus { border-color: var(--primary); box-shadow: 0 0 0 2px var(--ring); }
.row__text:disabled { opacity: 0.5; }
.row__audio { width: 180px; height: 30px; flex-shrink: 0; }
.row__status { font-size: var(--font-size-caption); color: var(--muted-foreground); flex-shrink: 0; max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.row__status.is-running { color: var(--info); }
.row__status.is-done { color: var(--success); }
.row__status.is-failed { color: var(--error); }
.row__actions { display: flex; align-items: center; gap: var(--space-1); flex-shrink: 0; }

.icon-btn {
  display: inline-flex; align-items: center; justify-content: center;
  width: 26px; height: 26px; border-radius: var(--radius-sm);
  color: var(--muted-foreground); background: transparent;
  transition: color var(--duration-fast), background var(--duration-fast);
}
.icon-btn:hover:not(:disabled) { color: var(--foreground); background: var(--surface-container-high); }
.icon-btn:disabled { opacity: 0.35; cursor: not-allowed; }
</style>
