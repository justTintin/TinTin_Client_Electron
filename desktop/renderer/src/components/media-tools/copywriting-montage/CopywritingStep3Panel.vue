<script setup lang="ts">
// ═══════════════════════════════════════════════════════════════
// CopywritingStep3Panel.vue — 智能混剪 Step3 口播配音面板（铁律 10 Phase3 P3，2026-09-19）
// 模板/样式自 VideoMontage.vue 逐字搬迁；状态经 inject 解构回原名（零改动）。
// 本面板本地逻辑：TTS 引擎/情感选项、页尾样本上传拖拽（useFilePicker）、
// 参考声音下拉、生命周期（进 Step3 拉样本/字体/模板清单由 Shell 编排）。
// ═══════════════════════════════════════════════════════════════
import { ref, computed, inject } from 'vue'
import TButton from '@/components/common/TButton.vue'
import TSelect from '@/components/common/TSelect.vue'
import VdStepBar from '../VdStepBar.vue'
import { useFilePicker } from '@/composables/useFilePicker'
import { copywritingMontageShellKey } from './copywritingMontageUiContext'
import CopywritingStoryboard from './CopywritingStoryboard.vue'

const shell = inject(copywritingMontageShellKey)!
// 2026-09-21 用户裁决：本步只有声音 → 右侧配音预览栏删除（vd-unified 两栏壳一并拆除）
const { step, go, steps } = shell
const {
  statusText,
  activeNarrative,
  activeStoryboard,
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
  voiceBusy,
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
  fmtDur,
  pathBasename,
} = shell.s

/** 本地路径 → file URL（面板内私有拷贝，Shell 版供 Step4 簇） */
function toFileUrl(p: string): string {
  return 'file:///' + encodeURI(String(p).replace(/\\/g, '/')).replace(/#/g, '%23')
}

/** TTS 引擎下拉选项（2026-09-20 服务端 TTS 统一入口上线：QwenTTS 启用，
 *  value 对齐契约 engine=qwen3；修正历史拼写 idexttts→indextts） */
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

/** 激活分镜自己的整段克隆声音（2026-09-23 用户裁决：声音与脚本对齐——播放条只显示
 *  激活分镜的 voiceWav，随 tab 切换；此前平铺全部 tab 的声音，切换分镜不变，
 *  被误读为「声音没绑脚本」。旁白同源：文案内容一致时两条声音听感相同属预期，
 *  各分镜要不同声音请在「文案编写」页改各自旁白后再批量克隆） */
const tabVoices = computed(() => {
  const tab = activeStoryboard.value
  if (!tab || !tab.voiceWav) return []
  return [{ tabId: tab.id, name: tab.name, wav: tab.voiceWav, dur: tab.voiceDurSec }]
})
</script>

<template>
      <section class="card">
        <VdStepBar :step="step" :steps="steps" @go="go" />
        <!-- 1. 视频输入目录行：2026-09-08 用户裁决删除——口播配音无视频输入功能，
             配音对象自动取 Step2 已确认合成产物所在目录 -->

        <!-- 分镜脚本（公共组件 voice 态，始终显示；2026-09-21 用户报障：从视频素材返回本步时分镜消失） -->
        <CopywritingStoryboard mode="voice" />

        <!-- 2026-09-22 用户裁决：移除旧「待合成视频列表与配音文案映射」表（智能混剪遗留的
             逐视频配音界面——编辑/重生成/时长:视频）；文案混剪声音=每分镜脚本一条
             （tab.voiceWav）。本框不再随视频行切换，恒显：口播文案（与激活分镜绑定）
             + 各分镜克隆声音播放条 -->
        <div v-if="activeNarrative.trim()" class="carry-copy">
          <!-- 2026-09-21 用户裁决：口播文案与分镜脚本绑定——显示激活分镜的旁白
               （= 批量克隆的声音来源），不再是全局草稿 manualCopy（曾致框文与声音不一致） -->
          <span class="sb-info">口播文案（旁白，与激活分镜脚本绑定，共 {{ activeNarrative.length }} 字；在「文案编写」页编辑）：</span>
          <textarea readonly rows="3" class="input carry-textarea">{{ activeNarrative }}</textarea>

          <!-- 2026-09-22 用户裁决：播放条自空态分支上提为常显——此前预合成后 voiceRows
               非空顶掉本框，声音播放条随之消失（用户报障②） -->
          <template v-if="tabVoices.length">
            <div class="carry-voice-list">
              <div v-for="v in tabVoices" :key="v.tabId" class="carry-voice-row">
                <span class="carry-voice-name" :title="v.name">{{ v.name }}</span>
                <audio
                  :key="v.wav + '|' + (v.dur || 0)"
                  class="vd-voice-audio"
                  controls
                  preload="auto"
                  :src="toFileUrl(v.wav)"
                  :title="`分镜「${v.name}」克隆声音（${v.dur > 0 ? fmtDur(v.dur) : '时长未知'}）`"
                />
                <span class="vd-dur-voice" :class="{ none: !v.dur }">{{ v.dur > 0 ? fmtDur(v.dur) : '--:--' }}</span>
              </div>
            </div>
            <!-- 2026-09-23 用户裁决：列表只含激活分镜自己的一条声音（绑定随 tab 切换） -->
            <span class="muted">当前分镜「{{ tabVoices[0].name }}」的声音已生成，可就地试听；点「开始批量克隆人声合成」可重新生成（会重克全部分镜）</span>
          </template>
          <span v-else class="muted">当前分镜暂无声音：点击下方「开始批量克隆人声合成」，即为各分镜旁白生成声音</span>
        </div>
        <div v-else class="muted">先在「文案编写」页生成文案与分镜脚本，再点击「开始批量克隆人声合成」生成声音</div>

      </section>

    <!-- 批量声音克隆（2026-09-21 用户裁决：批量生成的所有脚本的声音克隆，独立分组） -->
    <section class="card">
      <div class="fx-pack-title">批量声音克隆（全部分镜脚本）</div>

        <!-- 2. 参考声音（2026-09-21 用户裁决：移到克隆操作行上方，选定声音即开始克隆；
             对齐 VoiceClone 页形态：样本下拉 + 常驻播放条换 src；数据源 = GET /voice/samples；
             选中样本自动带出参考文案） -->
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

        <div class="row between clone-row">
          <div class="row">
            <TSelect v-model="ttsEngine" :options="TTS_ENGINE_OPTIONS" class="tts-engine-select" />
            <TButton label="设置声音克隆" variant="secondary" size="small" @click="openCloneParams" />
          </div>
          <TButton label="开始批量克隆人声合成" :loading="voiceBusy" @click="startSynthesizeVoice" />
        </div>

        <!-- 7. 配音动作已迁 Step4 统一合成（2026-09-09 用户裁决：Step3 只合成口播声音，
             配音+特效烧制+BGM 混音在第四步点「开始混音合成」一键完成） -->


        <!-- 克隆批量进度（主进程逐条 emitRow 聚合为整体百分比；文案+进度条对照确认合成形态） -->
        <template v-if="voiceBusy">
          <div class="concat-status-line">{{ statusText }}</div>
          <progress class="vd-progress split-progress" :value="voiceProgress" max="100" />
        </template>
      </section>

        <!-- 导航行（2026-09-10 用户裁决：上/下步按钮属操作区；2026-09-09 裁决：合成声音即可跳第四步） -->
        <div class="row between">
          <!-- 2026-09-17 用户裁决换序：上一步=文案编写(0) -->
          <TButton label="上一步：文案编写" plain @click="go(0)" />
          <!-- 2026-09-17 用户裁决换序：下一步=镜头重组(2)；2026-09-21 展示名改「视频素材」 -->
          <TButton label="下一步：视频素材" icon="right" @click="go(2)" />
        </div>
    <div v-if="step === 1" class="ns-section">
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
/* 2026-09-22 用户裁决：旧「待合成视频列表」表移除，其行样式（voice-table/vd-* 行簇）一并清除；
   保留 .vd-voice-audio/.vd-dur-voice/.vd-progress/.concat-status-line（分镜声音播放条与克隆进度仍用） */
/* 行内原生试听播放条（2026-09-15 用户裁决：<audio controls>，Chromium 原生控件） */
.vd-voice-audio {
  width: 260px; height: 32px; vertical-align: middle;
}
.concat-status-line { font-size: 11px; color: var(--primary); margin: 4px 0 2px; }
.vd-dur-voice { flex: none; width: 60px; text-align: right; font-size: 11px; font-weight: 700; color: var(--success); }
.vd-dur-voice.none { color: var(--muted-foreground); font-weight: 400; }
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
/* 2026-09-21 用户裁决：本步只有声音 → 右侧配音预览栏删除，
   vd-unified 两栏壳/vd-split 分隔条样式一并移除（全宽单栏） */
/* 第一步文案带过来（无视频行时展示；确认合成后自动填入各行配音文案） */
.carry-copy { display: flex; flex-direction: column; gap: 6px; }
/* 分镜卡/旁白小框样式已随分镜界面迁至公共组件 CopywritingStoryboard.vue */

/* 左上角框内的分镜声音播放条列表（2026-09-21 用户裁决：克隆完成后就地试听） */
.carry-voice-list { display: flex; flex-direction: column; gap: 6px; }
.carry-voice-row { display: flex; align-items: center; gap: 8px; }
.carry-voice-name {
  flex: none; max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: 12px; font-weight: 600; color: var(--foreground);
}
/* 源序在 .input 之后（覆盖其 height:32px / padding:0 10px） */
.carry-textarea {
  height: auto; min-height: 96px; padding: 8px 10px;
  line-height: 1.6; font-family: inherit; resize: vertical;
}
</style>