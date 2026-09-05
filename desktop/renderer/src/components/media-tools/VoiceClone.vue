<script setup lang="ts">
// ═══════════════════════════════════════════════════════════════
// VoiceClone.vue — 声音克隆（重新设计：样本下拉 + 底部上传）
// 布局：TTS引擎 → 样本选择(下拉) → 参考文本 → 待克隆文案 → 克隆/拆分
//       底部：上传新样本（音频+名称+文字 → 服务端 → 自动刷新下拉）
// ═══════════════════════════════════════════════════════════════
import { ref, computed, watch, onMounted } from 'vue'
import TButton from '@/components/common/TButton.vue'
import TSelect from '@/components/common/TSelect.vue'
import { useFilePicker } from '@/composables/useFilePicker'
import { useVoiceCloneStudio } from '@/composables/useVoiceCloneStudio'
import type { RowStatus } from '@/composables/useVoiceCloneStudio'

const s = useVoiceCloneStudio()
const {
  refText, transcribing, voiceOptions, samples, voice, selectedSampleId,
  ttsDurationFactor, ttsEmoText, ttsEmoAlpha,
  wholeText, rows, splitting, generating, stageText, maxChars,
  wholeTask, wholeProgress, uploadingSample,
  // 整体克隆：解包视图 + 合成进度 + 另存为（wholeTask 内嵌 ref 模板不解包，禁直接 wholeTask.xxx 判断）
  wholeStatus, wholeIsProcessing, wholeErrorMsg, wholeResultUrl, wholeResultPath,
  wholeSynthProgress, saveWholeAudioAs, uploadingToLib, uploadWholeToLibrary,
  refReady, canSplit,
  samplePreviewUrl, samplePreviewLoading, playSample, stopSamplePreview,
  loadCatalog, selectSample, uploadNewSample, transcribeRefAudio,
  splitIntoRows, updateRowText, removeRow, addRow, clearRows,
  generateRow, generateAll, generateWhole, downloadRow,
} = s

/** 情感预设选项（IndexTTS emo_text 常用值） */
const EMO_OPTIONS = [
  { label: '开心', value: '开心' },
  { label: '悲伤', value: '悲伤' },
  { label: '激动', value: '激动' },
  { label: '温柔', value: '温柔' },
  { label: '愤怒', value: '愤怒' },
  { label: '恐惧', value: '恐惧' },
  { label: '惊讶', value: '惊讶' },
  { label: '厌恶', value: '厌恶' },
  { label: '平静', value: '平静' },
]

const isDragging = ref(false)

// ─ 样本试听：音频元素 + 样本切换/建�?URL 后自动播放 ──
const sampleAudioEl = ref<HTMLAudioElement | null>(null)
watch(samplePreviewUrl, () => {
  const el = sampleAudioEl.value
  if (el) { el.currentTime = 0; el.play().catch(() => {}); }
}, { flush: 'post' })

// ─ 底部上传新样本 ──
const newSampleFilePath = ref('')
const newSampleFileName = ref('')
const newSampleName = ref('')
const newSampleText = ref('')
const newSampleError = ref('')
const newSampleSuccess = ref('')

const {
  filePath: uploadFilePath,
  fileName: uploadFileName,
  pickFile: pickUploadFile,
  onDrop,
  onDragOver,
  onDragLeave,
  resolveSrc,
} = useFilePicker({
  dialogTitle: '选择音频文件上传为样本',
  filters: [{ name: '音频', extensions: ['mp3', 'wav', 'm4a', 'flac', 'aac', 'ogg'] }],
  onPicked: (p) => {
    newSampleFilePath.value = p
    newSampleFileName.value = p.split('\\').pop()?.split('/').pop() || ''
    // 自动用文件名作为样本名称（去掉扩展名）
    const base = newSampleFileName.value.replace(/\.[^.]+$/, '')
    if (base && !newSampleName.value) newSampleName.value = base
  },
})

function onDropForward(e: DragEvent): void {
  onDrop(e)
  isDragging.value = false
}

async function onUploadNewSample(): Promise<void> {
  newSampleError.value = ''
  newSampleSuccess.value = ''
  if (!newSampleFilePath.value) { newSampleError.value = '请先选择音频文件'; return }
  if (!newSampleName.value.trim()) { newSampleError.value = '请输入样本名称'; return }
  const result = await uploadNewSample(newSampleFilePath.value, newSampleName.value, newSampleText.value)
  if (result.ok) {
    newSampleSuccess.value = `样本「${newSampleName.value}」上传成功，已自动选中`
    newSampleFilePath.value = ''
    newSampleFileName.value = ''
    newSampleName.value = ''
    newSampleText.value = ''
  } else {
    newSampleError.value = result.error || '上传失败'
  }
}

/** 上传样本时 ASR 识别音频文字 */
async function transcribeForNewSample(): Promise<void> {
  if (!newSampleFilePath.value) return
  transcribing.value = true
  newSampleError.value = ''
  try {
    const res = await window.tintin.server.asrTranscribe({
      audio: { path: newSampleFilePath.value } as unknown as Blob,
      language: 'zh',
      format: 'txt',
    } as any)
    if (!res || (res as any).error) throw new Error((res as any)?.error || '识别失败')
    const text = typeof res === 'string' ? res : (res as any).text || (res as any).content || JSON.stringify(res)
    newSampleText.value = String(text).trim()
  } catch (err) {
    newSampleError.value = `文字识别失败：${err instanceof Error ? err.message : String(err)}`
  } finally {
    transcribing.value = false
  }
}

/** 打开输出目录（使用保存后的本地文件路径） */
function openOutputFolder(): void {
  try {
    const filePath = wholeResultPath.value
    if (!filePath) {
      notify('提示', '文件尚未保存到本地，请使用「下载」另存')
      return
    }
    const dirPath = filePath.substring(0, filePath.lastIndexOf('\\') > 0 ? filePath.lastIndexOf('\\') : filePath.lastIndexOf('/'))
    window.tintin?.shell?.openPath?.(dirPath)
  } catch (_) {
    notify('提示', '无法打开目录')
  }
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

/** 克隆成功后显示的文件名 */
const wholeFileName = computed(() => {
  const p = wholeResultPath.value
  if (!p) return ''
  return p.includes('\\') ? p.split('\\').pop()! : p.split('/').pop()!
})

onMounted(loadCatalog)
</script>

<template>
  <div class="tool-form">

    <!-- ① 声音样本（下拉选择） -->
    <div class="form-field">
      <label class="form-label">声音样本</label>
      <TSelect
        :model-value="selectedSampleId"
        :options="samples.map((s) => ({ label: s.name, value: s.id }))"
        placeholder="选择声音样本"
        @update:model-value="(v: string) => selectSample(v)"
      />
      <div class="sample-preview">
        <TButton
          :label="samplePreviewLoading ? '加载中…' : '试听样本'"
          icon="play"
          size="small"
          :disabled="!selectedSampleId || samplePreviewLoading"
          @click="playSample(selectedSampleId)"
        />
        <audio v-if="samplePreviewUrl" ref="sampleAudioEl" :src="samplePreviewUrl" controls class="sample-audio" @ended="stopSamplePreview" />
      </div>
    </div>

    <!-- ③ 样本参考文本（选择样本后自动填充） -->
    <div class="form-field">
      <div class="field-head">
        <label class="form-label">样本参考文本</label>
        <TButton
          :label="transcribing ? '正在识别...' : '识别参考音频文本'"
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
        placeholder="选择样本后自动填充；也可手动编辑"
      />
      <span class="form-hint">
        拆分合并用的单行字数上限：约 {{ maxChars }} 字（15 秒安全时长；由样本语速推算）
      </span>
    </div>

    <!-- ③ 克隆模型：当前固定 IndexTTS；QwenTTS 入口占位，等服务端实现后启用（voxcpm 已删除不恢复） -->
    <div class="form-field">
      <label class="form-label">克隆模型</label>
      <div class="segmented">
        <button class="segmented__btn is-active" type="button">IndexTTS（快速/情感）</button>
        <button class="segmented__btn" type="button" disabled title="QwenTTS 等待服务端实现，启用后开放">QwenTTS（待服务端实现）</button>
      </div>
      <span class="form-hint">当前使用 IndexTTS；整体克隆与逐行生成都用此模型与下方参数</span>
    </div>

    <!-- ③+ IndexTTS 参数 -->
    <div class="engine-params">
      <div class="form-field">
        <div class="field-head">
          <label class="form-label">语速（duration_factor）</label>
          <span class="param-value">{{ ttsDurationFactor.toFixed(1) }}x</span>
        </div>
        <input
          type="range"
          class="slider"
          min="0.5"
          max="2.0"
          step="0.1"
          v-model.number="ttsDurationFactor"
        />
        <div class="slider-labels">
          <span>0.5x 慢</span>
          <span>1.0x 正常</span>
          <span>2.0x 快</span>
        </div>
      </div>
      <div class="form-field">
        <label class="form-label">情感选择（emo_text，可选）</label>
        <TSelect
          :model-value="ttsEmoText"
          :options="EMO_OPTIONS"
          placeholder="不选择则使用样本默认情感"
          @update:model-value="(v: string) => ttsEmoText = v"
        />
      </div>
      <div class="form-field">
        <div class="field-head">
          <label class="form-label">情感强度（emo_alpha）</label>
          <span class="param-value">{{ ttsEmoAlpha.toFixed(1) }}</span>
        </div>
        <input
          type="range"
          class="slider"
          min="0"
          max="1"
          step="0.1"
          v-model.number="ttsEmoAlpha"
        />
      </div>
    </div>

    <!-- ④ 待克隆整体文案 -->
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
      <!-- 合成进度（服务端同步等待无真实进度：缓动假进度，完成置 100） -->
      <div v-if="wholeIsProcessing" class="synth-progress">
        <div class="synth-progress__track">
          <div class="synth-progress__bar" :style="{ width: Math.round(wholeSynthProgress) + '%' }" />
        </div>
        <span class="synth-progress__text">正在合成克隆人声… {{ Math.round(wholeSynthProgress) }}%{{ wholeSynthProgress >= 92 ? '（长文案合成需稍等）' : '' }}</span>
      </div>
      <span v-if="wholeErrorMsg" class="form-error">{{ wholeErrorMsg }}</span>
      <audio
        v-if="wholeStatus === 'done' && (wholeResultUrl || wholeResultPath)"
        class="audio-player"
        :src="resolveSrc(wholeResultUrl) || resolveSrc(wholeResultPath)"
        controls
      />
      <!-- 成功提示 + 上传配音库 + 下载 + 打开目录（内嵌 audio 播放器即播放控制，不另设播放按钮） -->
      <div v-if="wholeStatus === 'done'" class="success-info">
        <span class="success-icon">✓</span>
        <span class="success-text">克隆成功</span>
        <span class="success-engine">IndexTTS</span>
        <span v-if="wholeFileName" class="success-file">{{ wholeFileName }}</span>
        <div class="success-actions">
          <button class="action-btn" :disabled="uploadingToLib" @click="uploadWholeToLibrary" title="上传到素材库（音频库·配音分类）">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M17 8l-5-5-5 5"/><path d="M12 3v12"/></svg>
            {{ uploadingToLib ? '上传中…' : '上传配音到素材库' }}
          </button>
          <button class="action-btn" @click="saveWholeAudioAs" title="另存为到指定位置">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/></svg>
            下载
          </button>
          <button class="action-btn" @click="openOutputFolder" title="打开文件所在目录">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
            打开目录
          </button>
        </div>
      </div>
    </div>

    <!-- 阶段提示 -->
    <div v-if="stageText" class="stage-line">{{ stageText }}</div>

    <!--  逐行配音文案表 -->
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
          {{ ROW_STATUS_TEXT[row.status] }}<template v-if="row.engine && row.status === 'done'"> · IndexTTS</template><template v-if="row.error">：{{ row.error }}</template>
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

    <!-- ⑥ 底部：上传新样本 -->
    <div class="upload-section">
      <div class="upload-section__title">没有想要的样本？上传音频创建新样本</div>
      <div
        class="dropzone"
        :class="{ 'is-active': isDragging, 'has-file': !!newSampleFilePath }"
        @click="pickUploadFile"
        @drop.prevent="onDropForward"
        @dragover.prevent="onDragOver(); isDragging = true"
        @dragleave.prevent="onDragLeave(); isDragging = false"
      >
        <svg v-if="!newSampleFilePath" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12" />
        </svg>
        <div class="dropzone__text">
          <template v-if="!newSampleFilePath">
            <span class="dropzone__main">点击选择音频或拖拽到此处</span>
            <span class="dropzone__hint">支持 MP3 / WAV / M4A / FLAC</span>
          </template>
          <template v-else>
            <span class="dropzone__main">{{ newSampleFileName }}</span>
            <span class="dropzone__hint">点击重新选择</span>
          </template>
        </div>
      </div>
      <div v-if="newSampleFilePath" class="upload-fields">
        <div class="form-field">
          <label class="form-label">样本名称 *</label>
          <input
            v-model="newSampleName"
            class="text-input"
            placeholder="例：小美-温柔女声"
          />
        </div>
        <div class="form-field">
          <div class="field-head">
            <label class="form-label">对应文字（可选）</label>
            <TButton
              label="识别参考文字"
              size="small"
              :loading="transcribing"
              :disabled="!newSampleFilePath"
              @click="transcribeForNewSample"
            />
          </div>
          <textarea
            v-model="newSampleText"
            class="text-area text-area--sm"
            rows="2"
            placeholder="与参考音频一致的文字；也可点击右侧按钮自动识别"
          />
        </div>
        <div class="upload-actions">
          <TButton
            label="上传为样本"
            icon="upload"
            :loading="uploadingSample"
            :disabled="!newSampleFilePath || !newSampleName.trim()"
            @click="onUploadNewSample"
          />
        </div>
        <div v-if="newSampleError" class="form-error">{{ newSampleError }}</div>
        <div v-if="newSampleSuccess" class="form-success">{{ newSampleSuccess }}</div>
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
.form-success { font-size: var(--font-size-caption); color: var(--success); }
.field-head { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); }

/* 样本试听：播放按钮 + 内嵌 audio 播放器 */
.sample-preview { display: flex; align-items: center; gap: var(--space-3); margin-top: var(--space-2); }
.sample-audio {
  height: 32px;
  max-width: 320px;
  flex: 1;
}
.sample-audio::-webkit-media-controls-panel { background: var(--muted); }

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
.segmented__btn:disabled { opacity: 0.45; cursor: not-allowed; text-decoration: line-through; }

/* 拖拽上传区 */
.dropzone {
  display: flex; align-items: center; gap: var(--space-3); padding: var(--space-5);
  background: color-mix(in srgb, var(--primary) 6%, var(--surface-container)); border: 1.5px dashed color-mix(in srgb, var(--primary) 40%, var(--border));
  border-radius: var(--radius-lg); color: var(--muted-foreground); cursor: pointer;
  transition: border-color var(--duration-fast), background var(--duration-fast);
}
.dropzone:hover, .dropzone.is-active { border-color: var(--primary); background: color-mix(in srgb, var(--primary) 12%, var(--surface-container)); }
.dropzone.has-file { border-style: solid; color: var(--foreground); }
.dropzone__text { display: flex; flex-direction: column; gap: 2px; }
.dropzone__main { font-size: var(--font-size-body); font-weight: var(--font-weight-medium); color: var(--foreground); }
.dropzone__hint { font-size: var(--font-size-caption); color: var(--muted-foreground); }

/* 上传区域 */
.upload-section {
  margin-top: var(--space-2);
  padding: var(--space-5);
  background: var(--surface-container);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-lg);
}
.upload-section__title {
  font-size: var(--font-size-lead);
  font-weight: var(--font-weight-semibold);
  color: var(--foreground);
  margin-bottom: var(--space-4);
}
.upload-fields { display: flex; flex-direction: column; gap: var(--space-3); margin-top: var(--space-4); }
.upload-actions { display: flex; justify-content: flex-end; }

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
.text-area--sm { min-height: 56px; }

.text-input {
  width: 100%; padding: var(--space-2) var(--space-3);
  font-size: var(--font-size-body); color: var(--foreground);
  background: var(--surface-container); border: 1px solid var(--border);
  border-radius: var(--radius-sm); outline: none;
}
.text-input:focus { border-color: var(--primary); }

.action-row { display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap; }
.hint-link {
  font-size: var(--font-size-caption); color: var(--muted-foreground);
  cursor: help; text-decoration: underline dotted;
}
.upload-progress { font-size: var(--font-size-caption); color: var(--muted-foreground); }
/* 整体克隆合成进度条（缓动假进度：无真实进度可拉，前快后慢逼近 92%，完成置 100） */
.synth-progress { display: flex; align-items: center; gap: var(--space-3); }
.synth-progress__track {
  flex: 1; max-width: 320px; height: 6px; border-radius: 3px;
  background: var(--surface-container); overflow: hidden;
}
.synth-progress__bar {
  height: 100%; border-radius: 3px; background: var(--primary);
  transition: width 150ms linear;
}
.synth-progress__text { font-size: var(--font-size-caption); color: var(--muted-foreground); white-space: nowrap; }
.audio-player { width: 100%; }
.stage-line { font-size: var(--font-size-caption); color: var(--foreground-muted); }

/* 引擎参数区 */
.engine-params {
  padding: var(--space-4);
  background: var(--surface-container);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  display: flex; flex-direction: column; gap: var(--space-3);
}
.param-value {
  font-size: var(--font-size-caption);
  font-weight: var(--font-weight-medium);
  color: var(--primary);
  min-width: 40px;
  text-align: right;
}
.slider {
  width: 100%; height: 6px;
  -webkit-appearance: none; appearance: none;
  background: var(--border); border-radius: 3px; outline: none;
}
.slider::-webkit-slider-thumb {
  -webkit-appearance: none; appearance: none;
  width: 16px; height: 16px; border-radius: 50%;
  background: var(--primary); cursor: pointer;
}
.slider-labels {
  display: flex; justify-content: space-between;
  font-size: var(--font-size-caption); color: var(--muted-foreground);
}

/* 成功提示 */
.success-info {
  display: flex; align-items: center; gap: var(--space-2);
  padding: var(--space-3); margin-top: var(--space-3);
  background: rgba(34, 197, 94, 0.1); border: 1px solid rgba(34, 197, 94, 0.3);
  border-radius: var(--radius-md);
}
.success-icon {
  display: inline-flex; align-items: center; justify-content: center;
  width: 20px; height: 20px; border-radius: 50%;
  background: var(--success); color: white; font-size: 12px; font-weight: bold;
}
.success-text { font-size: var(--font-size-caption); color: var(--success); font-weight: var(--font-weight-medium); }
.success-engine {
  font-size: var(--font-size-caption); padding: 1px 8px; border-radius: 999px;
  background: color-mix(in srgb, var(--primary) 12%, transparent); color: var(--primary);
  white-space: nowrap;
}
.success-file {
  font-size: var(--font-size-caption); color: var(--foreground-muted);
  font-family: var(--font-mono); max-width: 200px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.success-actions {
  display: flex; align-items: center; gap: var(--space-1); margin-left: auto;
}
.action-btn {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 4px 10px;
  font-size: var(--font-size-caption); color: var(--foreground-muted);
  background: var(--surface-container); border: 1px solid var(--border);
  border-radius: var(--radius-sm); cursor: pointer;
  transition: all var(--duration-fast);
}
.action-btn:hover { color: var(--foreground); border-color: var(--primary); background: var(--surface-container-high); }

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
