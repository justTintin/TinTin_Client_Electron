<script setup lang="ts">
// ═══════════════════════════════════════════════════════════════
// MontageStep3Panel.vue — 智能混剪 Step3 口播配音面板（铁律 10 Phase3 P3，2026-09-19）
// 模板/样式自 VideoMontage.vue 逐字搬迁；状态经 inject 解构回原名（零改动）。
// 本面板本地逻辑：TTS 引擎/情感选项、页尾样本上传拖拽（useFilePicker）、
// 参考声音下拉、生命周期（进 Step3 拉样本/字体/模板清单由 Shell 编排）。
// ═══════════════════════════════════════════════════════════════
import { ref, computed, inject } from 'vue'
import TButton from '@/components/common/TButton.vue'
import TSelect from '@/components/common/TSelect.vue'
import VdStepBar from './VdStepBar.vue'
import StepPreviewPane, { type StepPreviewItem } from './StepPreviewPane.vue'
import { useFilePicker } from '@/composables/useFilePicker'
import { montageShellKey } from './montageUiContext'

const shell = inject(montageShellKey)!
const { step, go, vdLeftStyle, onSplitDown, previewAspect } = shell
const {
  statusText,
  onDrop,
  voiceRows,
  refSamples,
  selectedRefSample,
  refText,
  selectRefAudio,
  ttsSteps,
  ttsCfg,
  ttsSpeedMin,
  voiceProgress,
  ttsEngine, qwen3Speaker, qwen3Instruct, qwen3Voices, qwen3VoicesLoading,
  cloneParamsDlg,
  openCloneParams,
  closeCloneParams,
  saveCloneParams,
  editDlg,
  openEditDlg,
  saveEditDlg,
  voiceBusy, voiceStopRequested, stopVoiceClone,
  refPreviewUrl,
  nsFilePath,
  nsName,
  nsText,
  nsError,
  nsSuccess,
  nsBusy,
  nsTranscribing,
  transcribeNewSample,
  uploadNewSampleRef,
  startSynthesizeVoice,
  regenVoice,
  toggleLengthMode,
  lengthModeTip,
  voiceStatusText,
  voiceStatusClass,
  fmtDur,
  pathBasename,
} = shell.s

/** 本地路径 → file URL（面板内私有拷贝，Shell 版供 Step4 簇） */
function toFileUrl(p: string): string {
  return 'file:///' + encodeURI(String(p).replace(/\\/g, '/')).replace(/#/g, '%23')
}

/** Step3 右栏：每条待配音视频一块——配音完成切换配音后视频并点亮，进行中显进度 */
const step3PreviewItems = computed<StepPreviewItem[]>(() => voiceRows.value.map((r, i) => {
  const target = (r.dubbedPath && r.dubbedPath.endsWith('.mp4')) ? r.dubbedPath : r.path
  const generating = r.status === 'generating'
  return {
    badge: `第 ${i + 1} 条`,
    src: target ? toFileUrl(target) : '',
    placeholder: '待确认合成产物',
    tag: generating ? `配音中 ${r.progress}%` : (r.dubbedPath ? '已配音' : (r.wavPath ? '声音已克隆' : '待配音')),
    tagClass: r.dubbedPath ? 'ok' : (generating ? 'busy' : ''),
    tip: r.name,
  }
}))

/** TTS 引擎下拉选项（2026-09-09 用户裁决：默认 IndexTTS；
 *  2026-09-20 服务端 TTS 统一入口上线：QwenTTS 启用，value 对齐契约 engine=qwen3；
 *  修正历史拼写 idexttts→indextts。Qwen3 克隆必填参考音频文稿（ref_text）） */
// 2026-09-20 用户裁决：QwenTTS 为默认引擎，选项置顶
const TTS_ENGINE_OPTIONS = [
  { label: 'QwenTTS（Qwen3-TTS）', value: 'qwen3' },
  { label: 'IndexTTS（快速/情感）', value: 'indextts' },
]
/** 情感预设选项（IndexTTS emo_text 常用值，同声音克隆页） */
const TTS_EMO_OPTIONS = [
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

// ─ 页尾上传新样本（VoiceClone 底部上传区同款同处理：dropzone 点击/拖拽选文件，
//   useFilePicker 统一拖拽；选中后名称自动带出（去扩展名））──
const nsDragging = ref(false)
const {
  fileName: nsFileName,
  pickFile: pickNsFile,
  onDrop: onNsDrop,
  onDragOver: onNsDragOver,
  onDragLeave: onNsDragLeave,
} = useFilePicker({
  dialogTitle: '选择音频文件上传为样本',
  filters: [{ name: '音频', extensions: ['mp3', 'wav', 'm4a', 'flac', 'aac', 'ogg'] }],
  onPicked: (p) => {
    nsFilePath.value = p
    const base = pathBasename(p).replace(/\.[^.]+$/, '')
    if (base && !nsName.value) nsName.value = base
  },
})

function onNsDropForward(e: DragEvent): void {
  onNsDrop(e)
  nsDragging.value = false
}


// 参考声音下拉（用户裁决 2026-09-03：声音样本从服务端取，GET /voice/samples 与 VoiceClone 页同源；
// 尾项保留本地上传；选中样本自动带出参考文案（selectSample 口径））
const refAudioOptions = computed(() => [
  ...refSamples.value.map((s) => ({ label: s.name, value: `sample:${s.id}` })),
  ...(refSamples.value.length ? [] : [{ label: '未找到预设声音样本', value: '' }]),
])
function onRefAudioChange(v: string | number): void { selectRefAudio(String(v)) }
</script>

<template>
      <section class="card">
        <div class="vd-unified">
        <div class="vd-unified-left" :style="vdLeftStyle">
        <VdStepBar :step="step" @go="go" />
        <!-- 1. 视频输入目录行：2026-09-08 用户裁决删除——口播配音无视频输入功能，
             配音对象自动取 Step2 已确认合成产物所在目录 -->

        <!-- 2. 参考声音（对齐 VoiceClone 页形态：样本下拉 + 常驻播放条换 src；
             声音样本数据源 = 服务端 GET /voice/samples；选中样本自动带出参考文案） -->
        <div class="row ref-row">
          <label class="label">参考声音:</label>
          <TSelect :model-value="selectedRefSample ? `sample:${selectedRefSample.id}` : ''" :options="refAudioOptions" class="grow" @update:model-value="onRefAudioChange" />
          <!-- 2026-09-09 用户裁决：播放条放到样本下拉框后面（同行右侧）。2026-09-11
               实测修复：TSelect 根默认 width:100% 会独占整行把播放条挤到下一行 →
               行内归位为弹性填充（.ref-row 规则） -->
          <audio v-if="refPreviewUrl" :src="refPreviewUrl" controls preload="auto" class="ref-audio" />
        </div>

        <!-- 3. 参考文案行（2026-09-11 用户裁决：单行显示不全 → 两行 textarea） -->
        <div class="row">
          <label class="label">参考文案:</label>
          <textarea v-model="refText" rows="2" class="input grow ref-text" placeholder="可选，填入样本台词..."></textarea>
        </div>

        <!-- TTS API 与推理参数行：2026-09-08 用户裁决删除（TTS 地址自动跟随系统设置，
             ttsSteps/ttsCfg 存而不用；ttsSpeedMin/Max 保留默认值 0.9~1.2 随克隆请求发送） -->

        <!-- 4. 表格标题行（L177-196；2026-09-10 用户裁决：TTS 引擎/克隆/文案设置组移到「开始批量克隆」前面） -->
        <div class="row">
          <span class="card-title"> 待合成视频列表与配音文案映射 (在配音文案栏直接输入):</span>
        </div>

        <!-- 5. 待合成视频表（L198-208 两列：序号 | 视频/配音/文案/状态/操作；行结构对照 dialogs.py VoiceRowDetailWidget L392-459） -->
        <table v-if="voiceRows.length" class="tbl voice-table">
          <thead>
            <tr>
              <th class="w-idx">序号</th>
              <th>视频/配音/文案/状态/操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(row, i) in voiceRows" :key="row.path">
              <td class="ta-c">{{ i + 1 }}</td>
              <td>
                <div class="vd-detail">
                  <!-- 行 1：文件名 + 状态 + 操作（2026-09-10 用户裁决：删行内 ▶ 播放按钮，视频预览已在右侧统一预览栏） -->
                  <div class="vd-top">
                    <span class="vd-name" :title="row.path">视频: {{ row.name }}</span>
                    <span class="spacer"></span>
                    <span v-if="row.status === 'generating'" class="vd-progress-text">{{ row.progress }}%</span>
                    <span class="vd-status" :class="voiceStatusClass(row)">{{ voiceStatusText(row) }}</span>
                    <!-- 2026-09-11 用户裁决：原 emoji 图标（🔊💾⚖↻🎬📽）与全局按钮体系
                         不统一、含义不明 → 统一为 TButton 文字小按钮（显示作用），
                         成组右对齐（.vd-actions，窄宽度换行后仍贴右）；
                         二次裁决：删「导出」「试看」两按钮（不需要） -->
                    <div class="vd-actions">
                      <!-- 2026-09-15 用户裁决：试听按钮 → 行内原生播放条（<audio controls>，
                           即浏览器原生控件：播放/进度拖动/时长/音量），生成后就地试听；
                           key 带 voiceDurSec——重生成覆写同路径 wav 时强制重建元素避开媒体缓存 -->
                      <audio
                        v-if="row.wavPath"
                        :key="row.wavPath + '|' + (row.voiceDurSec || 0)"
                        class="vd-voice-audio"
                        controls
                        preload="none"
                        :src="toFileUrl(row.wavPath)"
                        :title="`试听克隆声音（${fmtDur(row.voiceDurSec)}）`"
                      />
                      <audio v-else class="vd-voice-audio" controls preload="none" disabled title="尚未生成克隆声音" />
                      <TButton label="编辑" variant="secondary" size="small" title="对比与编辑文案（双击配音文案栏同效）" @click="openEditDlg(i)" />
                      <TButton label="重生成" variant="secondary" size="small" :disabled="row.status === 'generating'" :title="row.status === 'generating' ? '生成中，请稍候' : '仅重新生成该声音'" @click="regenVoice(i)" />
                      <TButton :label="row.lengthMode === 'video' ? '时长:视频' : '时长:音频'" variant="secondary" size="small" :title="lengthModeTip(row)" @click="toggleLengthMode(i)" />
                    </div>
                  </div>
                  <!-- 行 2：原文 + 视频时长（dialogs.py L424-439） -->
                  <div class="vd-row2">
                    <span class="vd-tag muted-tag">原文:</span>
                    <span class="vd-orig">{{ row.originalText || '(无)' }}</span>
                    <span v-if="row.durationSec > 0" class="vd-dur-vid">{{ fmtDur(row.durationSec) }}</span>
                  </div>
                  <!-- 行 3：修改后 + 配音文案编辑框 + 克隆音频时长（dialogs.py L441-459；绿背景 = 已生成，L1718-1745） -->
                  <div class="vd-row3">
                    <span class="vd-tag accent-tag">修改后:</span>
                    <input
                      class="vd-edit" :class="{ 'has-wav': row.wavPath }"
                      :value="row.text"
                      placeholder="双击可弹窗编辑大段文案，留空则不克隆此视频的声音"
                      @change="row.text = ($event.target as HTMLInputElement).value"
                      @dblclick="openEditDlg(i)"
                    />
                    <span class="vd-dur-voice" :class="{ none: !row.voiceDurSec }">{{ row.voiceDurSec > 0 ? fmtDur(row.voiceDurSec) : '--:--' }}</span>
                  </div>
                  <progress v-if="row.status === 'generating'" class="vd-progress" :value="row.progress" max="100" />
                </div>
              </td>
            </tr>
          </tbody>
        </table>
        <div v-else class="muted">确认合成完成后，Step2 的成片视频会自动出现在这里</div>

        <!-- 2026-09-10 用户裁决：克隆按钮变短，与设置组（TTS 引擎/声音克隆/文案生成/AI 改文案）同行、
             整行靠右（克隆=主操作居最右）；原独立 voice-clone-box 全宽框取消 -->
        <!-- 2026-09-10 用户裁决：声音设置组靠左、克隆主操作靠右（两端对齐） -->
        <div class="row between clone-row">
          <div class="row">
            <TSelect v-model="ttsEngine" :options="TTS_ENGINE_OPTIONS" class="tts-engine-select" />
            <TButton label="设置声音克隆" variant="secondary" size="small" @click="openCloneParams" />
          </div>
          <TButton label="开始批量克隆人声合成" :loading="voiceBusy" @click="startSynthesizeVoice" />
          <TButton label="停止克隆" variant="secondary" :disabled="!voiceBusy || voiceStopRequested" title="当前条合成完成后停止，剩余条保持待合成，可直接重试" @click="stopVoiceClone" />
        </div>

        <!-- 7. 配音动作已迁 Step4 统一合成（2026-09-09 用户裁决：Step3 只合成口播声音，
             配音+特效烧制+BGM 混音在第四步点「开始混音合成」一键完成） -->

        <!-- 克隆批量进度（主进程逐条 emitRow 聚合为整体百分比；文案+进度条对照确认合成形态） -->
        <template v-if="voiceBusy">
          <div class="concat-status-line">{{ statusText }}</div>
          <progress class="vd-progress split-progress" :value="voiceProgress" max="100" />
        </template>

        <!-- 导航行（2026-09-10 用户裁决：上/下步按钮属操作区；2026-09-09 裁决：合成声音即可跳第四步） -->
        <div class="row between">
          <TButton label="上一步：镜头重组" plain @click="go(1)" />
          <TButton label="下一步：特效包装" icon="right" title="生成口播声音后即可进入；配音/特效/混音在第四步统一合成"
            :disabled="!voiceRows.some(r => r.wavPath)" @click="go(3)" />
        </div>
        </div><!-- /vd-unified-left -->

<div class="vd-split" title="拖动调整左右比例" @mousedown="onSplitDown"></div>

        <!-- 右栏：每条待配音视频一块（配音完成切换配音后视频并点亮；进行中显进度，实时联动） -->
        <div class="vd-unified-right">
          <StepPreviewPane title="配音预览" :items="step3PreviewItems"
            :aspect="previewAspect"
            empty-text="确认合成完成后，Step2 的成片视频会出现在这里逐条预览配音效果" />
        </div>
        </div><!-- /vd-unified -->
      </section>
    <div v-if="step === 2" class="ns-section">
      <div class="ns-title">没有想要的样本？上传音频创建新样本</div>
      <div
        class="dropzone"
        :class="{ 'is-active': nsDragging, 'has-file': !!nsFilePath }"
        @click="pickNsFile"
        @drop.prevent="onNsDropForward"
        @dragover.prevent="onNsDragOver(); nsDragging = true"
        @dragleave.prevent="onNsDragLeave(); nsDragging = false"
      >
        <svg v-if="!nsFilePath" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12" />
        </svg>
        <div class="dropzone__text">
          <template v-if="!nsFilePath">
            <span class="dropzone__main">点击选择音频或拖拽到此处</span>
            <span class="dropzone__hint">支持 MP3 / WAV / M4A / FLAC</span>
          </template>
          <template v-else>
            <span class="dropzone__main">{{ nsFileName }}</span>
            <span class="dropzone__hint">点击重新选择</span>
          </template>
        </div>
      </div>
      <div v-if="nsFilePath" class="ns-fields">
        <div class="ns-field">
          <label class="ns-label">样本名称 *</label>
          <input v-model="nsName" class="input" placeholder="例：小美-温柔女声" />
        </div>
        <div class="ns-field">
          <div class="ns-field-head">
            <label class="ns-label">对应文字（可选）</label>
            <TButton label="识别参考文字" size="small" :loading="nsTranscribing" :disabled="!nsFilePath" @click="transcribeNewSample" />
          </div>
          <textarea v-model="nsText" class="input ns-textarea" rows="2" placeholder="与参考音频一致的文字；也可点击右侧按钮自动识别"></textarea>
        </div>
        <div class="ns-actions">
          <TButton label="上传为样本" icon="upload" :loading="nsBusy" :disabled="!nsFilePath || !nsName.trim()" @click="uploadNewSampleRef" />
        </div>
        <div v-if="nsError" class="ns-msg ns-err">{{ nsError }}</div>
        <div v-if="nsSuccess" class="ns-msg ns-ok">{{ nsSuccess }}</div>
      </div>
    </div>

    <div v-if="cloneParamsDlg.show" class="modal-mask" @click.self="closeCloneParams">
        <div class="modal">
          <span class="modal-title">设置声音克隆</span>
          <!-- 2026-09-20 用户裁决：按引擎显示各自设置——语速/情感为 IndexTTS 专属（QwenTTS 忽略，曾致「变速不起作用」） -->
          <span class="hint">以下参数在克隆声音时随每次 TTS 请求发送（当前引擎：{{ cloneParamsDlg.engine === 'qwen3' ? 'QwenTTS' : 'IndexTTS' }}）</span>
          <template v-if="cloneParamsDlg.engine === 'indextts'">
          <div class="cp-field">
            <div class="row between">
              <span class="label">语速（duration_factor）</span>
              <span class="cp-value">{{ cloneParamsDlg.factor.toFixed(1) }}x</span>
            </div>
            <input v-model.number="cloneParamsDlg.factor" type="range" min="0.5" max="2" step="0.1" class="grow" />
            <div class="row between cp-labels"><span>0.5x 慢</span><span>1.0x 正常</span><span>2.0x 快</span></div>
          </div>
          <div class="cp-field">
            <span class="label">情感选择（emo_text，可选）</span>
            <TSelect :model-value="cloneParamsDlg.emo" :options="TTS_EMO_OPTIONS" placeholder="不选择则使用样本默认情感" @update:model-value="(v: string | number) => (cloneParamsDlg.emo = String(v))" />
          </div>
          <div class="cp-field">
            <div class="row between">
              <span class="label">情感强度（emo_alpha）</span>
              <span class="cp-value">{{ cloneParamsDlg.alpha.toFixed(1) }}</span>
            </div>
            <input v-model.number="cloneParamsDlg.alpha" type="range" min="0" max="1" step="0.1" class="grow" />
          </div>
          </template>
          <template v-else>
          <div class="cp-field">
            <span class="label">预置音色（speaker，可选）</span>
            <TSelect :model-value="qwen3Speaker" :options="qwen3Voices" :loading="qwen3VoicesLoading" placeholder="不选择则按参考样本克隆音色" @update:model-value="(v: string | number) => (qwen3Speaker = String(v))" />
          </div>
          <div class="cp-field">
            <span class="label">指令文本（instruct，可选）</span>
            <input v-model="qwen3Instruct" type="text" placeholder="用自然语言描述语气/语速，如：用轻快的语速说" />
            <span class="hint">QwenTTS 不支持语速/情感数值参数；语气与语速请用指令文本描述</span>
          </div>
          </template>
          <div class="cp-field">
            <div class="row between">
              <span class="label">句间停顿（毫秒）</span>
              <span class="cp-value">{{ cloneParamsDlg.pause > 0 ? cloneParamsDlg.pause + 'ms' : '默认（无额外停顿）' }}</span>
            </div>
            <input v-model.number="cloneParamsDlg.pause" type="range" min="0" max="3000" step="100" class="grow" />
            <div class="row between cp-labels"><span>0 关</span><span>1500ms</span><span>3000ms</span></div>
            <span class="cp-tip">句间插入服务端停顿标记（((pause=毫秒))），精确控制停顿；每处标记将拆段分别合成，文案较长时耗时增加。2026-09-18：凑音频长度不再依赖停顿（变速拉满仍不足时客户端自动尾部补静音至视频时长）；设了停顿字幕也会精确对齐</span>
          </div>
          <div class="modal-actions">
            <TButton label="取消" plain @click="closeCloneParams" />
            <TButton label="保存" @click="saveCloneParams" />
          </div>
        </div>
      </div>
      <div v-if="editDlg.show" class="modal-mask" @click.self="editDlg.show = false">
        <div class="modal modal-wide">
          <span class="modal-title">{{ editDlg.title }}</span>
          <!-- 2026-09-11 用户裁决：对比改左右并排 1:1（左=原文只读栏、右=修改编辑栏；
               原「配音文案编辑:」提示行删除——两栏标签已自明） -->
          <div class="edit-cols">
            <div v-if="editDlg.original" class="edit-col">
              <span class="vd-tag muted-tag">原文:</span>
              <div class="vd-orig">{{ editDlg.original }}</div>
            </div>
            <div class="edit-col">
              <span class="vd-tag accent-tag">修改后:</span>
              <textarea v-model="editDlg.content" class="modal-textarea modal-copy"></textarea>
            </div>
          </div>
          <div class="modal-actions">
            <TButton label="确定" @click="saveEditDlg" />
            <TButton label="取消" plain @click="editDlg.show = false" />
          </div>
        </div>
      </div>
</template>

<style scoped>
.spacer { flex: 1; }
.ta-c { text-align: center; }
.card { display: flex; flex-direction: column; gap: var(--space-4); padding: var(--space-5); background: var(--card); border: 1px solid var(--border); border-radius: var(--radius-lg); }
/* 2026-09-07 用户裁决：全程序拖拽上传区高度统一 min-height 120px（以本区原高 ≈80px 基准 +1/2），内容垂直居中 */
.dropzone { display: flex; flex-direction: column; justify-content: center; align-items: center; gap: 4px; min-height: 120px; padding: var(--space-5); background: color-mix(in srgb, var(--primary) 6%, var(--surface-container)); border: 1.5px dashed color-mix(in srgb, var(--primary) 40%, var(--border)); border-radius: var(--radius-lg); cursor: pointer; color: var(--foreground); transition: border-color var(--duration-fast), background var(--duration-fast); }
.dropzone:hover { border-color: var(--primary); background: color-mix(in srgb, var(--primary) 12%, var(--surface-container)); }
/* Step1 解析进度条（复用 vd-progress 配色） */
.split-progress { margin: 6px 0 2px; }
.row { display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap; }
.row.between { justify-content: space-between; }
.row.right { justify-content: flex-end; }
.row.left { justify-content: flex-start; }
.label, .card-title { font-size: 13px; font-weight: 600; color: var(--foreground); }
.muted { color: var(--muted-foreground); font-size: 12px; }
.hint { color: var(--muted-foreground); font-size: 12px; }
.input { height: 32px; padding: 0 10px; background: var(--card); border: 1px solid var(--border); border-radius: var(--radius-md); color: var(--foreground); outline: none; font-size: 13px; }
.input:focus { border-color: var(--primary); }
.input.grow { flex: 1; min-width: 120px; }
.tbl { width: 100%; border-collapse: collapse; font-size: 13px; }
.tbl-scroll-wrap { max-height: 420px; overflow-y: auto; border: 1px solid var(--border); border-radius: var(--radius-md); }
.tbl-scroll-wrap .tbl { border-radius: 0; }
.tbl th, .tbl td { padding: 6px 8px; border-bottom: 1px solid var(--border); text-align: left; vertical-align: top; }
.tbl th { color: var(--muted-foreground); font-weight: 500; font-size: 12px; position: sticky; top: 0; background: var(--surface-container); z-index: 1; }
.detail-scroll-wrap .tbl { border-radius: 0; }
.row-deleted td {
  color: var(--muted-foreground); text-decoration: line-through;
  background: rgba(231, 76, 60, 0.12);
}
/* 弹窗（产品信息 / 口播文案查看） */
.modal-mask {
  position: fixed; inset: 0; z-index: 1002; display: flex; align-items: center; justify-content: center;
  background: rgba(0,0,0,.7);
}
.modal {
  display: flex; flex-direction: column; gap: 12px; width: 440px; max-width: 90vw; max-height: 80vh;
  padding: 20px; background: var(--card); border: 1px solid var(--border); border-radius: var(--radius-lg);
}
.modal-wide { width: 600px; }
/* 口播弹窗三块 1:1:1（2026-09-11 用户裁决）：左列=内嵌产品选择区（其内部
   列表 : 详情预览 = 对半），右列=填写表单——列表 : 详情 : 表单 ≈ 1 : 1 : 1 */
.modal-pick { width: 80vw; max-width: 90vw; height: 80vh; }
.pick-right .modal-field { flex: 0 0 auto; }
/* 2026-09-09 用户裁决：字段换行（label 上、输入框下占满整行） */
.pick-right .modal-field--stack { flex-direction: column; align-items: stretch; gap: 6px; }
.pick-right .modal-field--stack label { width: auto; }
.pick-right .modal-field--stack :deep(.input) { width: 100%; flex: none; }
.pick-right .modal-field.modal-extra { flex: 1 1 auto; min-height: 0; }
/* 2026-09-09 用户裁决：补充卖点与上方输入框左右对齐（占满整行），高度弹性填满
  剩余空间（不出现右侧滚动条） */
.pick-right .modal-textarea--tall { min-height: 0; height: auto; flex: 1 1 auto; width: 100%; }
/* 生成/取消与右侧表单贴底（2026-09-09 裁决：预览确认按钮已删，点行即选） */
.pick-right .modal-actions { margin-top: auto; }
.pick-right .modal-actions--split { justify-content: stretch; gap: 12px; }
.pick-right .modal-actions--split :deep(.t-button) { flex: 1 1 0; }
.modal-textarea--tall { min-height: 220px; }
.modal-title { font-size: 15px; font-weight: 600; }
.modal-field { display: flex; align-items: center; gap: 8px; }
.modal-field label { width: 64px; flex: none; font-size: 13px; }
.modal-field.modal-extra { align-items: flex-start; }
.modal-textarea {
  flex: 1; min-height: 72px; padding: 8px; background: var(--surface-container);
  border: 1px solid var(--border); border-radius: var(--radius-md); color: var(--foreground);
  font-size: 13px; font-family: inherit; resize: vertical; outline: none;
}
.modal-textarea:focus { border-color: var(--primary); }
.modal-copy { min-height: 300px; }
.modal-actions { display: flex; justify-content: flex-end; gap: 8px; }
/* Step3 口播配音样式（对照 VoiceRowDetailWidget 三行布局；颜色走 V3 design tokens） */
/* Step3 参考声音行（2026-09-09 用户裁决：播放条与样本下拉同行、位于其后；
   2026-09-11 修复：TSelect 根默认 width:100%，在 flex-wrap 行内独占整行把
   播放条挤到下一行 → 行内将下拉归位为弹性填充，宽度交给剩余空间） */
.ref-row :deep(.t-select) { flex: 1 1 0; width: auto; min-width: 0; }
.ref-audio { height: 32px; width: 320px; flex: 0 1 auto; }
/* 参考文案（2026-09-11 用户裁决：单行 input 显示不全 → 两行高度，可纵向拉伸）。
   源序必须在 .input 之后（同特异性覆盖其 height:32px / padding:0 10px） */
.ref-text {
  height: auto; min-height: 52px; padding: 6px 10px;
  line-height: 1.5; font-family: inherit; resize: vertical;
}
/* 页尾上传新样本（VoiceClone upload-section 同款卡片 + dropzone 拖拽区） */
.ns-section {
  padding: var(--space-5);
  background: var(--surface-container);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-lg);
}
.ns-title {
  font-size: var(--font-size-lead); font-weight: var(--font-weight-semibold);
  color: var(--foreground); margin-bottom: var(--space-4);
}
.dropzone {
  display: flex; align-items: center; gap: var(--space-3); min-height: 120px; padding: var(--space-5);
  background: color-mix(in srgb, var(--primary) 6%, var(--surface-container));
  border: 1.5px dashed color-mix(in srgb, var(--primary) 40%, var(--border));
  border-radius: var(--radius-lg); color: var(--muted-foreground); cursor: pointer;
  transition: border-color var(--duration-fast), background var(--duration-fast);
}
.dropzone:hover, .dropzone.is-active { border-color: var(--primary); background: color-mix(in srgb, var(--primary) 12%, var(--surface-container)); }
.dropzone.has-file { border-style: solid; color: var(--foreground); }
.dropzone__text { display: flex; flex-direction: column; gap: 2px; }
.dropzone__main { font-size: var(--font-size-body); font-weight: var(--font-weight-medium); color: var(--foreground); }
.dropzone__hint { font-size: var(--font-size-caption); color: var(--muted-foreground); }
.ns-fields { display: flex; flex-direction: column; gap: var(--space-3); margin-top: var(--space-4); }
.ns-field { display: flex; flex-direction: column; gap: var(--space-2); }
.ns-label { font-size: var(--font-size-caption); font-weight: var(--font-weight-medium); color: var(--foreground-muted); }
.ns-field-head { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); }
.ns-textarea { min-height: 56px; resize: vertical; }
.ns-actions { display: flex; justify-content: flex-end; }
.ns-msg { font-size: var(--font-size-caption); }
.ns-err { color: var(--error, var(--destructive, #e5484d)); }
.ns-ok { color: var(--success, #2e9e5b); }
/* 2026-09-10 用户报障：左栏折叠时操作按钮被截断隐藏、文本不能缩短 →
   table-layout:fixed 强制列宽受容器约束（序号 48px 定宽 + 详情列吃剩余），
   列内按钮 flex-wrap 换行、长文本省略，窄宽度不再把操作列挤出可视区 */
.voice-table { margin-top: var(--space-3); width: 100%; table-layout: fixed; }
.voice-table .w-idx { width: 48px; }
/* 整个列表底色（2026-09-11 用户裁决）：表体整体铺 surface-container 浅底，
   表头再深一档 surface-container-high 保持层级；行内编辑框连带反转为白底
   （见 .vd-edit 的 .voice-table 覆盖），避免灰底上输入框消失 */
.voice-table { background: var(--surface-container); }
.voice-table th { background: var(--surface-container-high); }
.vd-detail { display: flex; flex-direction: column; gap: 6px; }
.vd-top { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
/* 行内操作按钮组（2026-09-11 用户裁决：emoji 图标统一为文字小按钮；成组右对齐，
   且右缘与行 2/3「原文/修改后」文案栏右缘对齐——不是与时间列对齐。
   偏移 66px = 时间列 60px（.vd-dur-*）+ 行间隙 6px（.vd-row2/3 gap），同步维护） */
.vd-actions {
  display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
  margin-left: auto; margin-right: 66px;
}
/* 行内原生试听播放条（2026-09-15 用户裁决：<audio controls>，Chromium 原生控件） */
.vd-voice-audio {
  width: 260px; height: 32px; vertical-align: middle;
}
.vd-voice-audio[disabled] { opacity: 0.45; }
.vd-name {
  max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: 13px; font-weight: 600; color: var(--foreground);
}
.vd-status { font-size: 11px; margin-left: 4px; }
.vd-progress-text { font-size: 11px; color: var(--primary); }
.concat-status-line { font-size: 11px; color: var(--primary); margin: 4px 0 2px; }
.vd-row2, .vd-row3 { display: flex; align-items: center; gap: 6px; }
.vd-tag { flex: none; font-size: 12px; }
.muted-tag { width: 48px; color: var(--muted-foreground); }
.accent-tag { color: var(--primary); }
.vd-orig {
  flex: 1; min-width: 0; font-size: 12px; color: var(--muted-foreground);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.vd-dur-vid { flex: none; width: 60px; text-align: right; font-size: 11px; font-weight: 700; color: var(--warning); }
.vd-dur-voice { flex: none; width: 60px; text-align: right; font-size: 11px; font-weight: 700; color: var(--success); }
.vd-dur-voice.none { color: var(--muted-foreground); font-weight: 400; }
.vd-edit {
  flex: 1; min-width: 0; height: 30px; padding: 4px 8px; font-size: 13px;
  background: var(--surface-container); border: 1px solid var(--border); border-radius: 4px;
  color: var(--foreground); outline: none;
}
.vd-edit:focus { border-color: var(--success); }
/* 已生成绿背景（原版 rgba(46,204,113,0.25) + border #2ecc71，L1718-1745） */
.vd-edit.has-wav { background: rgba(46, 204, 113, 0.25); border-color: #2ecc71; }
/* 2026-09-11 列表底色裁决连带：表体已铺浅灰底，默认态编辑框反转为白底保持可辨识。
   必须用 :not(.has-wav) —— 绿底规则同特异性且在本规则之前，不限定会被罩掉 */
.voice-table .vd-edit:not(.has-wav) { background: var(--card); }
.vd-progress { width: 100%; height: 6px; appearance: none; border-radius: 3px; overflow: hidden; }
.vd-progress::-webkit-progress-bar { background: var(--surface-container); }
.vd-progress::-webkit-progress-value { background: var(--primary); transition: width 0.3s; }
/* 2026-09-10 用户裁决：设置组靠左、克隆主操作居最右（两端对齐）。
   2026-09-11 用户裁决：本行控件等高——下拉 34 / 小按钮 28 / 主按钮 36 三种高度
   混排 → 统一为输入高度 34px（与下拉及页面表单控件同口径，含四颗按钮） */
.clone-row { align-items: center; }
.clone-row :deep(.t-button) { height: var(--size-input-height); }
/* TTS 引擎下拉（表格标题行内，不占满） */
.tts-engine-select { width: 220px; flex: none; }
/* 设置声音克隆弹窗 */
.cp-field { display: flex; flex-direction: column; gap: 6px; }
.cp-value { font-size: 13px; font-weight: 700; color: var(--primary); }
.cp-labels { font-size: 11px; color: var(--muted-foreground); }
.cp-tip { font-size: 11px; color: var(--muted-foreground); line-height: 1.5; }
/* 配音文案编辑弹窗：原文/修改后左右对照 1:1（2026-09-11 用户裁决：左右并排等宽，
   而非上原文下编辑框；两栏等高，原文栏为只读框、修改栏为编辑 textarea） */
.edit-cols { display: flex; gap: var(--space-3); align-items: stretch; }
.edit-col { flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; gap: 6px; }
.edit-col .vd-orig {
  flex: 1 1 auto; min-height: 300px; padding: 8px;
  background: var(--surface-container); border: 1px solid var(--border);
  border-radius: var(--radius-md); color: var(--foreground); font-size: 13px;
  white-space: pre-wrap; overflow-wrap: anywhere; overflow-y: auto;
}
.bgm-pick-right .row { gap: 6px; }
/* 界面统一两栏（2026-09-10 用户需求「二三四步界面统一+联动预览」）：
   左=操作区（自适应），右=统一预览栏（拖拽调比例）；
   2026-09-10 用户报障「口播配音界面重叠」：左栏表格 min-content 撑破盒子溢出绘制
   进右栏区 → 左栏 overflow:hidden 截断 + 右栏 border-left 明确分界 */
.vd-unified { display: flex; gap: 0; align-items: stretch; min-height: 0; }
.vd-unified-left { min-width: 0; display: flex; flex-direction: column; gap: var(--space-2); padding-right: 12px; overflow: hidden; }
.vd-unified-right { flex: 1 1 0; min-width: 260px; display: flex; flex-direction: column; min-height: 0; padding-left: 12px; border-left: 1px solid var(--border); }
/* 可拖拽分隔条：左右比例手动调整（默认 6:4，拖后 localStorage 记忆） */
.vd-split {
  flex: 0 0 6px; cursor: col-resize; border-radius: 3px;
  background: transparent; transition: background 0.15s;
}
.vd-split:hover { background: var(--primary); opacity: 0.35; }
</style>