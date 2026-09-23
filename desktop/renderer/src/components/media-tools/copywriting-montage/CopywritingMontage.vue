<script setup lang="ts">
// ═══════════════════════════════════════════════════════════════
// VideoMontage.vue — 智能混剪·服务端四步向导 Shell（M8 条目⑥ UI 层）
// 四步：1.素材解析 → 2.AI 编排 → 3.口播配音 → 4.特效包装（对照 steps_text L257）。
// 铁律 10 拆分（2026-09-19）：编排状态在 useCopywritingMontage（纯逻辑在
//   copywritingMontageLogic 桶 + montage/* 子模块），四步 UI 在 MontageStep1-4Panel.vue
//   （经 copywritingMontageShellKey inject，模板/样式逐字搬迁）；本组件仅保留向导步序、
//   分栏拖拽、右栏画幅与页尾状态条，只绘制 + 事件转发（IRON-06/07 分层）。
// ═══════════════════════════════════════════════════════════════
import { ref, reactive, computed, provide, onMounted, onActivated, onUnmounted, watch, nextTick } from 'vue'
import TButton from '@/components/common/TButton.vue'
import TSelect from '@/components/common/TSelect.vue'
import VideoPreview from '@/components/common/VideoPreview.vue'
// import VideoPlayer 已移除：Step4 成片预览由统一右栏 StepPreviewPane 接管（2026-09-10 界面统一）
import { useCopywritingMontage } from '@/composables/useCopywritingMontage'
import { useAudioGen } from '@/composables/useAudioGen'
import { useFilePicker } from '@/composables/useFilePicker'
import WbPickProductPanel from '@/components/workbench/WbPickProductPanel.vue'
import StepPreviewPane, { type StepPreviewItem, type StepPreviewKeyword } from '../StepPreviewPane.vue'
import VdStepBar from '../VdStepBar.vue'
import CopyStep4Panel from './CopyStep4Panel.vue'
import CopyStep2Panel from './CopyStep2Panel.vue'
import CopyStep3Panel from './CopyStep3Panel.vue'
import CopyStep1Panel from './CopyStep1Panel.vue'
import { copywritingMontageShellKey } from './copywritingMontageUiContext'
import { markdownListLines, stripProductCodeFromModel, parseProductKeywords } from '@/composables/opsProductLibraryLogic'
import { copyPreviewText, subtitlePresetTileStyle, FANCY_STYLE_PREVIEW, fancyDrawtextToPreview } from '@/composables/copywritingMontageLogic'
import type { PickerItem } from '@/composables/useWorkbenchPickers'

// 2026-09-17 用户裁决：步骤序定案 1.文案编写 → 2.口播配音 → 3.镜头重组 → 4.特效包装
// 2026-09-21 用户裁决：第③步展示名「镜头重组」→「视频素材」（仅步骤条展示名，
// 页面内「镜头重组」执行按钮不动）
const STEPS = ['1. 文案编写', '2. 口播配音', '3. 视频素材', '4. 特效包装']
const step = ref(0)
function go(i: number) {
  step.value = Math.max(0, Math.min(STEPS.length - 1, i))
  // 第②步（口播配音，2026-09-17 换序）：自动带视频
  // （_on_enter_step_3 L636-656 口径：取确认产物目录→清理旧产物→扫描）
  if (i === 1) void enterStepVoice()
  // 第④步：待混音数量 stage 提示（_go_to_step index==3 L388-395 同口径）
  if (i === 3) void enterStep4()
}

const s = useCopywritingMontage()
const {
  // 共享
  polling, activeTaskId, statusText, cancelPolling,
  // Step1 素材解析（镜头智能分割）
  splitResolution,
  closePreview,
  previewUrl, previewTranscoding,
  // Step2 镜头重组
  concatLayout, DURATION_LIMITS,
  confirmBusy, copyBusy,
  currentPlan,
  toggleClipDeleted,
  confirmPlanSingle,
  openProductDlg, productDlg, closeProductDlg, productDlgGenerate,
  copyViewDlg, viewPlanCopy, closeCopyView,
  planMenu, closePlanMenu,
  onSeqEnded,
  // Step3 口播配音（对照 step3_voice_view.py 逐控件）
  loadRefSamples,
  // 字幕样式（2026-09-17 用户裁决：字幕样式统一来自服务端 /subtitle_styles）
  fancyStyle,
  // 文字模板（2026-09-09 裁决：服务端 textfx 体系，与花字独立；随机样式默认 3 个）
  loadLuts,
  loadTextTemplates,
  fancyTemplateId, fancyTemplates, fancyPreviews,
  loadFancyTemplates,
  FANCY_STYLE_OPTIONS, FANCY_POSITION_OPTIONS, SUBTITLE_BG_OPTIONS,
  enterStepVoice,
  // Step4 特效包装（对照 step4_final_view.py 逐控件）
  // 2026-09-18：逐视频 BGM 指派（行名/指派/清除/本地选择）+ 弹窗下载助手
  enterStep4,
  // 景别分类
} = s



// ── 左右分栏手动调整（2026-09-10 用户需求）：拖拽分隔条改左右比例，默认 6:4，localStorage 记忆 ──
const VD_SPLIT_KEY = 'vd-split-pct'
const vdSplitPct = ref(Math.min(80, Math.max(35, Number(localStorage.getItem(VD_SPLIT_KEY)) || 60)))
/** 左栏宽度由分隔条拖拽控制（右栏吃剩余全部，三步共享同一比例 → 右栏位置切步不变） */
const vdLeftStyle = computed(() => ({ flex: `0 0 calc(${vdSplitPct.value}% - 6px)` }))
// 拖拽改宽后每行能容纳的样式卡片数会变 → 重测样式预览是否溢出（声明须在
// vdSplitPct 之后，否则 const TDZ 报错）


/** 预览块画幅（2026-09-11 用户裁决）：竖屏 9/16、横屏 16/9、source 按分割片段分辨率；
 *  三步右栏共用同一比例（Step3/4 预览的都是本链路成片，画幅同源） */
const previewAspect = computed(() => {
  const layout = concatLayout.value
  if (layout === 'vertical') return '9 / 16'
  if (layout === 'horizontal') return '16 / 9'
  const m = /^(\d+)x(\d+)$/.exec(splitResolution.value || '')
  if (m) {
    const w = Number(m[1])
    const h = Number(m[2])
    if (w > 0 && h > 0) return `${w} / ${h}`
  }
  return '9 / 16'
})
function onSplitDown(e: MouseEvent): void {
  e.preventDefault()
  const pane = (e.currentTarget as HTMLElement).parentElement
  if (!pane) return
  const rect = pane.getBoundingClientRect()
  const onMove = (ev: MouseEvent) => {
    vdSplitPct.value = Math.min(80, Math.max(35, Math.round(((ev.clientX - rect.left) / rect.width) * 100)))
  }
  const onUp = () => {
    document.removeEventListener('mousemove', onMove)
    document.removeEventListener('mouseup', onUp)
    localStorage.setItem(VD_SPLIT_KEY, String(vdSplitPct.value))
  }
  document.addEventListener('mousemove', onMove)
  document.addEventListener('mouseup', onUp)
}

// ── 面板注入（须晚于 vdLeftStyle/previewAspect 声明；setup 期一次性绑定）──
provide(copywritingMontageShellKey, { s, step, go, steps: STEPS, vdLeftStyle, onSplitDown, previewAspect })

/** 花字样式下拉（原版 fancy_style_combo 7 项） */
const fancyStyleOptions = FANCY_STYLE_OPTIONS
/** 花字位置下拉（原版 fancy_position_combo 8 项，L335-339） */
const fancyPositionOptions = FANCY_POSITION_OPTIONS
/** 字幕背景下拉（原版 subtitle_bg_combo 6 项，L226-228） */
const subtitleBgOptions = SUBTITLE_BG_OPTIONS
/** 字幕入场动画下拉（2026-09-10 用户裁决：可选动画，预览与烧制同用该选择；
 *  key 与主进程 VALID_ANIMS 同表） */
const SUBTITLE_ANIM_OPTIONS = [
  { label: '淡入', value: 'fade' },
  { label: '上浮', value: 'rise' },
  { label: '滑入', value: 'slide' },
  { label: '弹入', value: 'pop' },
  { label: '无动画', value: 'none' },
]
const subtitleAnimOptions = SUBTITLE_ANIM_OPTIONS
/** 字幕字号下拉（2026-09-18 用户裁决：默认 10 号，置于「动画」后；
 *  值=剪映草稿 texts content styles[].size，预览同比例缩放） */
const subtitleFontSizeOptions = [6, 8, 10, 12, 15, 20, 25, 30].map((v) => ({ label: String(v), value: v }))
/** 花字模板下拉（原版 fancy_template_combo：首项「自定义 (下方样式)」value=''，L269-274；
 *  2026-09-09 服务端对接：服务端模板库条目加「（服务端）」来源后缀，排在本地模板前） */
const fancyTemplateOptions = computed(() => [
  { label: '自定义 (下方样式)', value: '' },
  ...fancyTemplates.value.map((t) => ({
    label: t.origin === 'server' ? `${t.name}（服务端）` : t.name,
    value: t.template_id,
  })),
])
/** 当前选中模板（含来源标记） */
const selectedTemplate = computed(() =>
  fancyTemplateId.value ? fancyTemplates.value.find((t) => t.template_id === fancyTemplateId.value) || null : null)
/** 服务端模板描述预览（textfx 动画渲染在服务端，客户端不自行渲染——显描述文字占位，
 *  对照 docs/CLIENT-FANCY-ACCESS.md §6「不做：客户端自行渲染花字」） */
const serverTemplateDesc = computed(() => {
  const t = selectedTemplate.value
  if (!t || t.origin !== 'server') return ''
  const desc = String(t.description || t.category || '').trim()
  return desc ? `${t.name}：${desc}` : `${t.name}：服务端模板（渲染在服务端）`
})
/** 当前模板预览图（dataURL；对照 fancy_template_preview_lbl） */
const fancyTemplatePreview = computed(() =>
  fancyTemplateId.value ? fancyPreviews.value[fancyTemplateId.value] || '' : '')
/** 花字效果预览样本字（行3 效果预览；卖点风格样例） */
const FANCY_PREVIEW_TEXT = '199元超值'
/** 花字自定义样式效果预览（行3）：选模板时解析模板 drawtext style 还原主色+描边；
 *  自定义（无模板）时用选中样式预设的 CSS 近似（对照主进程 FANCY_STYLES） */
const fancyCustomPreviewStyle = computed<Record<string, string>>(() => {
  const tpl = selectedTemplate.value
  const parsed = tpl ? fancyDrawtextToPreview(String(tpl.style || '')) : null
  if (parsed) return parsed
  const p = FANCY_STYLE_PREVIEW[fancyStyle.value] || FANCY_STYLE_PREVIEW.white_outline
  return {
    color: p.color,
    webkitTextStroke: `3px ${p.stroke}`,
    paintOrder: 'stroke',
    textShadow: '2px 2px 4px rgba(0,0,0,.6)',
  }
})
onMounted(() => { void loadFancyTemplates() })
// 2026-09-15 用户裁决：KeepAlive 下每次进入第④步都刷新模板库/字体/LUT 清单（服务端重渲染后进页面即见新预览）
onActivated(() => {
  void loadTextTemplates()
  void loadFancyTemplates()
  void loadLuts()
})
// 声音样本与 VoiceClone 页同口径：每次进入 Step3（及挂载时）重新拉取（原实现仅在
// composable 创建时拉一次，服务端新增样本/离线恢复后下拉一直为空）
onMounted(() => { void loadRefSamples() })
// 2026-09-21 修复：换序后口播配音=index 1，进入时重新拉取声音样本（原条件 v===2 为旧序）
watch(step, (v) => { if (v === 1) void loadRefSamples() })

/** 输出画幅下拉（原版 layout_combo 3 项；首项动态附分割片段画幅——
 *  2026-09-15 用户裁决：「与原视频一致」基准=分割片段，非原素材（4K 素材分割产物
 *  1080x1920，取原素材会把预合成撑成 4K/横屏），文案同步改「与分割视频一致」） */
const LAYOUTS = computed(() => [
  { label: splitResolution.value ? `与分割视频一致 (${splitResolution.value})` : '与分割视频一致', value: 'source' },
  { label: '竖屏 (1080x1920 抖音流)', value: 'vertical' },
  { label: '横屏 (1920x1080 宽屏)', value: 'horizontal' },
])

/** Step2 排列逻辑（原版 logic_combo 唯一可见项；「按文案智能匹配」原版已隐藏） */
const logicOptions = [{ label: '智能重排', value: 'random' }]
/** 时长限制下拉（原版 duration_limit_combo：10/20/30/40/50 秒） */
const durationOptions = DURATION_LIMITS.map((s) => ({ label: `${s} 秒`, value: s }))

// ── Step2 镜头详情右键菜单（原版 _on_source_context_menu 同口径）──
const detailMenu = ref({ show: false, x: 0, y: 0, row: -1, deleted: false })
function openDetailMenu(e: MouseEvent, row: number): void {
  const p = currentPlan.value
  detailMenu.value = { show: true, x: e.clientX, y: e.clientY, row, deleted: !!p?.deletedFlags[row] }
}
function closeDetailMenu(): void { detailMenu.value.show = false }
function menuToggleDeleted(): void {
  if (detailMenu.value.row >= 0) toggleClipDeleted(detailMenu.value.row)
  closeDetailMenu()
}
// ── 预合成列表右键菜单动作（原版 _show_assembled_context_menu 三项）──
function planMenuConfirm(): void { const i = planMenu.value.index; closePlanMenu(); if (i >= 0) void confirmPlanSingle(i) }
function planMenuGen(): void { const i = planMenu.value.index; closePlanMenu(); if (i >= 0) openProductDlg(i) }
function planMenuView(): void { const i = planMenu.value.index; closePlanMenu(); if (i >= 0) viewPlanCopy(i) }

// ── 口播弹窗左侧内嵌产品选择区（WbPickProductPanel：左列表右参数/卖点；
//   2026-09-09 用户裁决：不需要「选择该产品」按钮，点左侧行即选中，
//   中间预览与右侧四字段同步填充，仍可手改）──
function onPickProduct(it: PickerItem): void {
  productDlg.value.brand = String(it.brand || '')
  productDlg.value.product = String(it.category || '')
  // 2026-09-19 用户报障：型号不填商品编码（【981-001277】类尾部段剥离）；
  // goods_no 本身是编码，不再作为型号兜底
  productDlg.value.model = stripProductCodeFromModel(it.model)
  // 2026-09-19 架构：产品资料关联关键词随选择带回（导出/合成时客户端据此命中；
  // 手动填写的产品无关联词 → 导出时 LLM 兜底提词）
  productDlg.value.keywords = parseProductKeywords(it)
  // 核心卖点逐条拼入补充卖点（多行，可继续手改/留空）
  productDlg.value.extra = markdownListLines(it.selling_points).join('\n')
}

function urlTail(u: string) { return String(u || '').split('/').pop() || u }

// ── Step1 素材列表删除（已改为行内按钮，原右键菜单已删除）──

/** 评分着色（原版 L1443-1448：≥8 绿 / ≥6 黄 / ≥0 红）；Step1 用途已迁 Step1Panel，Step2 详情表仍消费 */
function scoreClass(score: number | undefined): string {
  if (!score) return ''
  if (score >= 8) return 'score-high'
  if (score >= 6) return 'score-mid'
  return 'score-low'
}
</script>

<template>
  <div class="montage" style="display: flex; flex-direction: column; gap: var(--space-5);">

    <!-- 顶部全宽步骤条已删（2026-09-10 用户裁决：四个 tab 步骤统一放操作区/卡片内，
         各步骤 card 顶部各一份 VdStepBar，预览区不受影响；门控保留在组件内） -->

    <!-- 共享任务状态条移至页尾（原版底部 stage_label + progress_bar 同位置） -->

    <!-- Step 1: 镜头智能分割（布局对照原版 gui/montage/step1_split_view.py L27-181） -->
    <!-- 2026-09-17 用户裁决换序：1.文案编写(CopyStep1Panel 历史名=分割页) →
         2.口播配音(CopyStep3Panel 历史名) → 3.镜头重组(CopyStep2Panel 历史名) -->
    <CopyStep1Panel v-if="step === 0" />
    <CopyStep3Panel v-else-if="step === 1" />
    <CopyStep2Panel v-else-if="step === 2" />

    <!-- Step 3: 口播配音（对照 gui/montage/step3_voice_view.py L27-298 逐控件一比一）；
         2026-09-10 用户需求「界面统一+联动预览」：左操作区 + 右逐条点亮预览 -->

    <!-- Step 4: 特效包装（step4_final_view.py L14-196 逐控件；另保留本端 AI 生成 BGM）；
         2026-09-09 用户裁决：烧制字幕/花字/文字模板特效配置自 Step3 迁入此处，随混音统一烧制，
         字幕文案按视频从 Step3 文案表带过去 -->
    <CopyStep4Panel v-else />

    <!-- 页尾状态区（原版底部共享：stage_label + progress_bar；
      确认合成期间不重复显示——状态文案已置进度条上方，用户裁决：下面的文字提示不需要） -->
    <div v-if="(polling || statusText) && !confirmBusy" class="bottom-status">
      <div class="bottom-status-row">
        <span class="status-text" :class="{ spinning: polling }">{{ statusText }}</span>
        <span v-if="activeTaskId" class="muted">任务 {{ activeTaskId }}</span>
        <TButton v-if="polling" label="取消等待" size="small" plain @click="cancelPolling" />
      </div>
      <div v-if="polling" class="pbar"><div class="pbar-inner"></div></div>
    </div>

    <!-- 页尾上传新样本（2026-09-08 用户裁决：放在扫描失败提示之下，整个界面最底部；
      VoiceClone 底部上传区同款同处理：dropzone 点击/拖拽选文件，
      字段（名称自动带出/文字可 ASR 识别）→ 上传服务端 → 刷新下拉并自动选中） -->

    <!-- 镜头片段预览弹层（内置 Plyr 播放器，支持本地路径 + 服务端 URL） -->
    <VideoPreview :visible="!!previewUrl" :src="previewUrl" :loading="previewTranscoding" @close="closePreview" @ended="onSeqEnded" />



    <!-- 产品信息弹窗（原版 ProductCopyInputDialog，dialogs.py L347-388 文案逐字；
      2026-09-08 用户裁决：产品选择区与填写区合二为一不再二次弹窗——左侧内嵌
      WbPickProductPanel，选中自动回填右侧表单，仍可手改；填写区高度加高。
      2026-09-11 用户裁决：三块（产品列表｜产品详情｜填写表单）宽度 1:1:1。
      2026-09-19 用户裁决改判：三块宽度 1:1.5:1（详情中栏加宽，核心卖点下新增关键词展示）。
      2026-09-13 改调 /copywriting/voiceover：时长不再手填，逐条按成片时长 duration_s 传入） -->
    <teleport to="body">
      <div v-if="productDlg.show" class="modal-mask" @click.self="closeProductDlg">
        <div class="modal modal-pick">
          <span class="modal-title"> 生成口播文案</span>
          <span class="hint">输入产品信息，由大模型生成该组合视频的口播文案；可从产品库选择自动填充，也可直接手动填写：</span>
          <div class="pick-layout">
            <div class="pick-left">
              <WbPickProductPanel :active="productDlg.show" click-to-pick @pick="onPickProduct" />
            </div>
            <div class="pick-right">
              <!-- 2026-09-09 用户裁决：label 与输入框换行（label 上、输入框下占满），
                补充卖点高度加倍；生成/取消互换位置并与「选择该产品」平行、宽度平分 -->
              <div class="modal-field modal-field--stack"><label>品牌:</label><input v-model="productDlg.brand" class="input" placeholder="如 罗技 / Logitech" /></div>
              <div class="modal-field modal-field--stack"><label>产品:</label><input v-model="productDlg.product" class="input" placeholder="如 鼠标 / 键盘 / 无线耳机" /></div>
              <div class="modal-field modal-field--stack"><label>型号:</label><input v-model="productDlg.model" class="input" placeholder="如 G502 / MX Master 3S" /></div>
              <div class="modal-field modal-field--stack modal-extra"><label>补充卖点（可选）:</label>
                <textarea v-model="productDlg.extra" class="modal-textarea modal-textarea--tall" placeholder="如 8K回报率、轻量化、长续航……（可留空）"></textarea>
              </div>
              <div class="modal-actions modal-actions--split">
                <TButton label="取消" plain @click="closeProductDlg" />
                <TButton label="生成" :loading="copyBusy" @click="productDlgGenerate" />
              </div>
            </div>
          </div>
        </div>
      </div>
    </teleport>

    <!-- 口播文案查看弹窗（原版 _view_assembled_copy：标题 + 只读全文 + 关闭） -->
    <teleport to="body">
      <div v-if="copyViewDlg.show" class="modal-mask" @click.self="closeCopyView">
        <div class="modal modal-wide">
          <span class="modal-title">{{ copyViewDlg.title }}</span>
          <textarea readonly class="modal-textarea modal-copy">{{ copyViewDlg.content }}</textarea>
          <div class="modal-actions"><TButton label="关闭" plain @click="closeCopyView" /></div>
        </div>
      </div>
    </teleport>

    <!-- 文案生成设置弹窗（原版 _show_ai_rewrite_settings L3317-3405 文案逐字） -->
    <teleport to="body">
    </teleport>

    <!-- 设置声音克隆弹窗（2026-09-09 用户裁决：对齐声音克隆页 IndexTTS 参数——语速/情感/情感强度；
      保存后克隆声音时随每次 TTS 请求发送） -->
    <teleport to="body">
    </teleport>

    <!-- BGM 选择弹窗（2026-09-09 用户裁决：同音频生成页左栏布局——搜索/分类/标签/列表/分页；
      单击选中、双击或 ▶ 试听；确定后下载落盘回填 BGM 路径） -->
    <teleport to="body">
    </teleport>

    <!-- 配音文案编辑弹窗（原版 TextEditDialog，dialogs.py L31-80 文案逐字；⚖ 对比按钮同入口附原文对照） -->
    <teleport to="body">
    </teleport>
  </div>
</template>

<style scoped>
/* 顶部步骤条 .step-bar 系样式已迁入 VdStepBar.vue（2026-09-10 tab 入操作区） */

.sec-label { font-size: 13px; font-weight: 600; color: var(--foreground); }
.param-label { font-size: 13px; color: var(--foreground); white-space: nowrap; }
.spacer { flex: 1; }
.ta-c { text-align: center; }
.w32 { width: 32px; }
.desc-input { height: 28px; width: 100%; padding: 0 8px; font-size: 12px; }
.score-high { color: #2ecc71; font-weight: 600; }
.score-mid { color: #f1c40f; font-weight: 600; }
.score-low { color: #e74c3c; font-weight: 600; }

/* 素材右键菜单 */
.ctx-mask { position: fixed; inset: 0; z-index: 1000; }
.ctx-menu {
  position: fixed; min-width: 140px; padding: 4px;
  background: var(--card); border: 1px solid var(--border);
  border-radius: var(--radius-md); box-shadow: 0 6px 24px rgba(0,0,0,.4);
}
.ctx-item {
  display: block; width: 100%; padding: 6px 12px; border: none; border-radius: var(--radius-sm);
  background: none; color: var(--foreground); font-size: 13px; text-align: left; cursor: pointer;
}
.ctx-item:hover { background: var(--surface-container); }

/* 页尾状态区（原版底部 stage_label + progress bar） */
.bottom-status { display: flex; flex-direction: column; gap: 6px; }
.bottom-status-row { display: flex; align-items: center; gap: var(--space-3); font-size: 13px; }
.status-text { color: var(--foreground); font-weight: 500; }
.status-text.spinning { color: var(--primary); }
.pbar { height: 6px; border-radius: 3px; background: var(--surface-container); overflow: hidden; }
.pbar-inner {
  height: 100%; width: 32%; border-radius: 3px; background: var(--primary);
  animation: pbar-slide 1.2s ease-in-out infinite;
}
@keyframes pbar-slide {
  0% { transform: translateX(-100%); }
  100% { transform: translateX(320%); }
}

.card { display: flex; flex-direction: column; gap: var(--space-4); padding: var(--space-5); background: var(--card); border: 1px solid var(--border); border-radius: var(--radius-lg); }
/* 2026-09-07 用户裁决：全程序拖拽上传区高度统一 min-height 120px（以本区原高 ≈80px 基准 +1/2），内容垂直居中 */
.dropzone { display: flex; flex-direction: column; justify-content: center; align-items: center; gap: 4px; min-height: 120px; padding: var(--space-5); background: color-mix(in srgb, var(--primary) 6%, var(--surface-container)); border: 1.5px dashed color-mix(in srgb, var(--primary) 40%, var(--border)); border-radius: var(--radius-lg); cursor: pointer; color: var(--foreground); transition: border-color var(--duration-fast), background var(--duration-fast); }
.dropzone:hover { border-color: var(--primary); background: color-mix(in srgb, var(--primary) 12%, var(--surface-container)); }
.dz-main { font-size: var(--font-size-body); font-weight: var(--font-weight-medium); }
.dz-hint { font-size: var(--font-size-caption); color: var(--muted-foreground); }

/* 2026-09-05 用户裁决：全程序列表行间统一规范——页面内嵌密集列表 = 分隔线式（1px 横线），
   弹窗选择列表 = 卡片式（边框+圆角+空隙）；本页三处列表统一改分隔线式 */
.file-list { display: flex; flex-direction: column; list-style: none; margin: 0; padding: 0; font-size: 13px; }
.file-list li { display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); padding: 6px 10px; border-bottom: 1px solid var(--border); word-break: break-all; }
.file-list li:last-child { border-bottom: none; }
.file-list li.picked { background: color-mix(in srgb, var(--primary) 12%, transparent); }
/* Step1 素材列表（缩略图 + 路径 + 播放/删除按钮） */
.src-video-list { max-height: 480px; overflow-y: auto; }
.src-video-list li { padding: 4px 8px; }
.video-thumb { width: 60px; height: 40px; object-fit: cover; border-radius: var(--radius-sm); background: #000; flex: none; }
.video-thumb--ph { display: inline-flex; align-items: center; justify-content: center; color: var(--muted-foreground); background: var(--surface-container-high); }
.video-path { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: pointer; }
.video-dur { flex: none; width: 52px; text-align: right; font-size: 12px; color: var(--muted-foreground); margin-right: 8px; font-variant-numeric: tabular-nums; }
.shot-source-cell { font-size: 12px; color: var(--muted-foreground); white-space: nowrap; }
.video-play-btn { width: 24px; height: 24px; padding: 0; font-size: 12px; line-height: 1; flex: none; background: transparent; color: var(--muted-foreground); border: 1px solid var(--border); border-radius: var(--radius-sm); cursor: pointer; margin-right: 4px; }
.video-play-btn:hover { color: var(--success); border-color: var(--success); }
.video-remove-btn { width: 24px; height: 24px; padding: 0; font-size: 16px; line-height: 1; flex: none; background: transparent; color: var(--muted-foreground); border: 1px solid var(--border); border-radius: var(--radius-sm); cursor: pointer; }
.video-remove-btn:hover { color: var(--danger); border-color: var(--danger); }
.video-count { justify-content: center; color: var(--muted-foreground); font-size: 12px; padding: 4px 10px; background: transparent; border: none; }
/* Step1 解析进度条（复用 vd-progress 配色） */
.split-progress { margin: 6px 0 2px; }
.video-count-footer { text-align: center; color: var(--muted-foreground); font-size: 12px; padding: 4px 0; }

.row { display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap; }
.row.between { justify-content: space-between; }
.row.right { justify-content: flex-end; }
.row.left { justify-content: flex-start; }
.grid2 { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: var(--space-3); }
.field { display: flex; flex-direction: column; gap: 6px; }
.label, .card-title { font-size: 13px; font-weight: 600; color: var(--foreground); }
.muted { color: var(--muted-foreground); font-size: 12px; }
.hint { color: var(--muted-foreground); font-size: 12px; }
.error-msg { color: var(--danger, #e74c3c); font-size: 12px; }
.clip-count { font-weight: 700; }

.input { height: 32px; padding: 0 10px; background: var(--card); border: 1px solid var(--border); border-radius: var(--radius-md); color: var(--foreground); outline: none; font-size: 13px; }
.input:focus { border-color: var(--primary); }
.input.grow { flex: 1; min-width: 120px; }
.w70 { width: 70px; } .w80 { width: 80px; }
.linkbtn { border: none; background: none; color: var(--primary); cursor: pointer; font-size: 12px; }

.tbl { width: 100%; border-collapse: collapse; font-size: 13px; }
.tbl-scroll-wrap { max-height: 420px; overflow-y: auto; border: 1px solid var(--border); border-radius: var(--radius-md); }
.tbl-scroll-wrap .tbl { border-radius: 0; }
.tbl th, .tbl td { padding: 6px 8px; border-bottom: 1px solid var(--border); text-align: left; vertical-align: top; }
.tbl th { color: var(--muted-foreground); font-weight: 500; font-size: 12px; position: sticky; top: 0; background: var(--surface-container); z-index: 1; }
.shot-type-badge {
  display: inline-block; padding: 1px 6px; border: 1px solid;
  border-radius: 4px; font-size: 11px; font-weight: 600; line-height: 1.4;
}

/* Step2 镜头重组（原版 params_group/result_box/player 等同布局；颜色走 V3 design tokens） */
.params-group {
  display: flex; flex-direction: column; gap: 10px; padding: 10px 12px;
  background: var(--surface-container); border: 1px solid var(--border); border-radius: var(--radius-md);
}
.param-row { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; }
.param-row .param-label { margin-left: var(--space-3); }
.param-row .param-label:first-child { margin-left: 0; }
.src-res { color: var(--warning); font-size: 11px; margin-left: 4px; }
.w60 { width: 60px; } .w90 { width: 90px; } .w120 { width: 120px; } .w140 { width: 140px; } .w180 { width: 180px; }
.clip-count { font-weight: 700; font-size: 14px; color: var(--warning); }
.result-box {
  display: flex; flex-direction: column; gap: 10px; padding: 10px;
  background: var(--surface-container); border: 1px dashed var(--border); border-radius: var(--radius-md);
}
/* 预合成列表（2026-09-09 用户裁决改表格；2026-09-11 用户裁决：最大 10 行高度，
   超出滚动；不足 10 行随真实行数收缩——占位行已删，防止两表之间空余过多） */
.plan-tbl-wrap {
  /* 380px = 表头(约30px) + 10 行(约35px/行) 完整可见（旧值 332px 行高下只能显 9 行） */
  max-height: 380px; overflow-y: auto;
  border: 1px solid var(--border); border-radius: var(--radius-md);
}
.plan-tbl-wrap .plan-tbl { border-radius: 0; }
.plan-tbl tr { cursor: pointer; }
.plan-tbl tbody tr:hover { background: color-mix(in srgb, var(--primary) 6%, transparent); }
.plan-tbl tr.picked { background: color-mix(in srgb, var(--primary) 12%, transparent); }
.plan-file { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 260px; }
.plan-copy { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted-foreground); }
.plan-empty { padding: 8px 10px; }
.w48 { width: 48px; white-space: nowrap; }
.w64 { width: 64px; white-space: nowrap; }
/* 下半区：分割镜头详情表（表头 + 10 行高，见 .detail-scroll-wrap） */
.result-bottom { display: flex; gap: 15px; align-items: flex-start; }
.detail-col { flex: 3; min-width: 0; display: flex; flex-direction: column; gap: 6px; }
.detail-scroll-wrap {
  /* 用户裁决(2026-09-11)：镜头详情至少显示 10 行 → 380px（同上方预合成列表口径） */
  max-height: 380px; overflow-y: auto; border: 1px solid var(--border); border-radius: var(--radius-sm);
}
.detail-scroll-wrap .tbl { border-radius: 0; }
.detail-placeholder-row td { height: 30px; border-bottom: 1px solid var(--border); }
/* 右侧播放器 .player-col/.player-wrap 系已删：连播预览迁右侧统一预览栏 StepPreviewPane（2026-09-10） */
.detail-tbl td { height: 30px; }
.grip-cell { cursor: grab; color: var(--muted-foreground); user-select: none; }
.row-deleted td {
  color: var(--muted-foreground); text-decoration: line-through;
  background: rgba(231, 76, 60, 0.12);
}
.clip-name, .clip-desc { max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.confirm-row > * { flex: 1; }

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
/* 口播弹窗三块 1:1.5:1（2026-09-19 用户裁决，原 2026-09-11 的 1:1:1 作废）：
   左列=内嵌产品选择区（其内部列表 : 详情预览 = 40 : 60），右列=填写表单
   ——列表 : 详情 : 表单 ≈ 1 : 1.5 : 1 */
.modal-pick { width: 80vw; max-width: 90vw; height: 80vh; }
.pick-layout { flex: 1 1 auto; min-height: 0; display: flex; gap: var(--space-4); }
.pick-left { flex: 1 1 71.43%; min-width: 0; min-height: 0; }
/* 面板默认列表 : 预览 = 54 : 46（工作台弹窗口径不变），本弹窗内覆写为 40 : 60
   ——与外层 71.43 : 28.57 相乘 = 列表 : 详情 : 表单 ≈ 1 : 1.5 : 1（2026-09-19 用户裁决） */
.pick-left :deep(.picker-side) { flex: 0 0 60%; }
.pick-right { flex: 1 1 28.57%; min-width: 0; display: flex; flex-direction: column; gap: 12px; overflow-y: auto; padding-right: 2px; }
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
.icon-btn {
  width: 28px; height: 24px; padding: 0; font-size: 13px; line-height: 1; flex: none;
  background: var(--card); color: var(--foreground);
  border: 1px solid var(--border); border-radius: var(--radius-sm); cursor: pointer;
}
.icon-btn:hover:not(:disabled) { border-color: var(--primary); }
.icon-btn:disabled { opacity: .4; cursor: not-allowed; }
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
/* 2026-09-09 用户裁决：克隆按钮独立外框 + 配音设置分组（字幕/花字/配音按钮） */
.action-box {
  padding: var(--space-4); background: var(--surface-container);
  border: 1px solid var(--border); border-radius: var(--radius-md);
}
/* 2026-09-10 用户裁决：设置组靠左、克隆主操作居最右（两端对齐）。
   2026-09-11 用户裁决：本行控件等高——下拉 34 / 小按钮 28 / 主按钮 36 三种高度
   混排 → 统一为输入高度 34px（与下拉及页面表单控件同口径，含四颗按钮） */
.clone-row { align-items: center; }
.clone-row :deep(.t-button) { height: var(--size-input-height); }
.chk {
  display: flex; align-items: center; gap: 6px; cursor: pointer;
  font-size: 13px; font-weight: 600; color: var(--foreground);
}
.chk input { accent-color: var(--primary); }
.w230 { width: 230px; }
.w110 { width: 110px; }
.w130 { width: 130px; }
/* 花字模板预览标签（fancy_template_preview_lbl 124x34 #202020） */
.fancy-preview {
  display: inline-flex; align-items: center; justify-content: center;
  width: 124px; height: 34px; flex: none;
  background-color: #202020; color: #666; font-size: 10px; border-radius: 3px;
  overflow: hidden;
}
.fancy-preview img { width: 100%; height: 100%; object-fit: cover; }
/* 服务端模板无本地预览图（textfx 渲染在服务端）→ 描述文字占位 */
.fancy-preview-desc {
  max-width: 100%; max-height: 100%; padding: 0 6px; text-align: center;
  font-size: 10px; line-height: 1.3; color: #aaa;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}
.fancy-content-hint { color: #888; font-size: 12px; }
/* 字幕预设样式色板（2026-09-09 裁决：图3 ~24 格，点选即选中；tile 内嵌「字幕」样字按预设渲染） */
.sub-style-grid {
  /* 2026-09-09 二次裁决：单行流式（原固定 8 列三行），放不下自动换行 */
  display: flex; flex-wrap: wrap; align-content: flex-start; gap: 6px;
  flex: 1 1 auto; min-width: 0;
}
.sub-style-tile {
  height: 32px; display: inline-flex; align-items: center; justify-content: center;
  background: #2a2a2a; border: 1px solid var(--border); border-radius: 4px;
  cursor: pointer; padding: 0; overflow: hidden;
  transition: border-color var(--duration-fast) var(--easing-default),
    box-shadow var(--duration-fast) var(--easing-default);
}
.sub-style-tile:hover { border-color: var(--primary); }
.sub-style-tile.active { border-color: var(--primary); box-shadow: 0 0 0 2px var(--ring); }
.sub-style-tile-text { font-size: 14px; font-weight: 700; line-height: 1; white-space: nowrap; pointer-events: none; }
/* 效果预览画布（字幕/花字行3 共用；深底渐变近似视频画面） */
.style-preview-canvas {
  flex: 1; min-width: 0; height: 52px;
  display: flex; align-items: center; justify-content: center;
  background: linear-gradient(135deg, #3a3f4a 0%, #23262e 100%);
  border: 1px solid var(--border); border-radius: 6px; overflow: hidden;
}
.style-preview-text {
  max-width: 94%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  padding: 2px 10px;
}
/* 字幕入场动画预览（2026-09-10 用户裁决：字幕可选动画，预览与烧制同用该选择；
   CSS 循环近似演示 drawtext 烧制效果，与成品非逐帧一致） */
@keyframes sub-anim-fade-kf {
  0%   { opacity: 0; }
  25%  { opacity: 1; }
  80%  { opacity: 1; }
  100% { opacity: 0; }
}
@keyframes sub-anim-rise-kf {
  0%   { opacity: 0; transform: translateY(8px); }
  25%  { opacity: 1; transform: translateY(0); }
  80%  { opacity: 1; transform: translateY(0); }
  100% { opacity: 0; transform: translateY(0); }
}
@keyframes sub-anim-slide-kf {
  0%   { opacity: 0; transform: translateX(24px); }
  25%  { opacity: 1; transform: translateX(0); }
  80%  { opacity: 1; transform: translateX(0); }
  100% { opacity: 0; transform: translateX(0); }
}
@keyframes sub-anim-pop-kf {
  0%   { opacity: 0; transform: scale(0.6); }
  20%  { opacity: 1; transform: scale(1.15); }
  30%  { transform: scale(0.95); }
  38%  { transform: scale(1); }
  80%  { opacity: 1; transform: scale(1); }
  100% { opacity: 0; transform: scale(1); }
}
.sub-anim-fade  { animation: sub-anim-fade-kf 2.4s ease-in-out infinite; }
.sub-anim-rise  { animation: sub-anim-rise-kf 2.4s ease-out infinite; }
.sub-anim-slide { animation: sub-anim-slide-kf 2.4s ease-out infinite; }
.sub-anim-pop   { animation: sub-anim-pop-kf 2.4s ease-out infinite; }

/* 文案生成设置弹窗 */
.rw-title { font-size: 13px; color: var(--foreground); }
.rw-desc { font-size: 12px; color: var(--muted-foreground); white-space: pre-line; }
.rw-value { font-size: 14px; font-weight: 700; color: var(--primary); text-align: center; }

/* TTS 引擎下拉（表格标题行内，不占满） */
.tts-engine-select { width: 220px; flex: none; }
/* 设置声音克隆弹窗 */
.cp-field { display: flex; flex-direction: column; gap: 6px; }
.cp-value { font-size: 13px; font-weight: 700; color: var(--primary); }
.cp-labels { font-size: 11px; color: var(--muted-foreground); }
.cp-tip { font-size: 11px; color: var(--muted-foreground); line-height: 1.5; }

/* AI 生成 BGM 面板（音频生成页「生成 BGM」同款布局，2026-09-09 用户裁决） */
.ag-style-select { width: 160px; flex: none; }
.ag-tag-select { width: 150px; flex: none; }
.ag-num-input { width: 72px; flex: none; }
.agb-gen-row { justify-content: flex-end; }
.agb-result { margin: 0; font-size: 12px; color: var(--muted-foreground); white-space: pre-line; }

/* BGM 选择弹窗（音频生成页左栏同款） */
.bgm-pick { width: min(1200px, 94vw); }
.bgm-kind-select { width: 170px; flex: none; }
.bgm-tag-input { max-width: 140px; }
.bgm-page-input { width: 64px; }
.bgm-pick-audio { height: 30px; max-width: 220px; }
.bgm-pick-rows {
  height: min(420px, 50vh); overflow-y: auto;
  border: 1px solid var(--border); border-radius: var(--radius-md);
  display: flex; flex-direction: column;
}
.bgm-pick-state { padding: 24px 16px; text-align: center; font-size: 12px; color: var(--muted-foreground); }
.bgm-pick-row {
  display: flex; align-items: center; gap: 8px;
  flex: 0 0 auto; height: 36px; padding: 0 12px;
  border-bottom: 1px solid var(--border); cursor: pointer;
}
.bgm-pick-row:last-child { border-bottom: none; }
.bgm-pick-row:hover { background: var(--surface-container); }
.bgm-pick-row.picked { background: var(--surface-container); box-shadow: inset 3px 0 0 var(--primary); }
.bgm-pick-row.playing { color: var(--primary); }
.bgm-pick-name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
.bgm-pick-meta { font-size: 12px; color: var(--muted-foreground); flex: none; }
.bgm-pick-act {
  display: inline-flex; align-items: center; justify-content: center;
  width: 26px; height: 26px; border-radius: var(--radius-sm);
  color: var(--primary); flex: none; cursor: pointer;
}
.bgm-pick-act:hover { background: var(--surface-container-high); }

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

/* 2026-09-18 用户裁决：选择 BGM 弹窗左右 2:1 分栏（左=音频库列表，右=AI 生成 BGM） */
.bgm-pick-cols { display: flex; gap: var(--space-3); align-items: stretch; }
.bgm-pick-left { flex: 2 1 0; min-width: 0; display: flex; flex-direction: column; gap: var(--space-2); }
.bgm-pick-right {
  flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; gap: var(--space-2);
  padding-left: var(--space-3); border-left: 1px solid var(--border);
}
.bgm-pick-right-title { font-size: 13px; font-weight: 600; color: var(--foreground); }
.bgm-pick-right .row { gap: 6px; }
.bgm-pick-right .ag-style-select,
.bgm-pick-right .ag-tag-select,
.bgm-pick-right .ag-num-input { width: auto; flex: 1 1 auto; min-width: 0; }
.bgm-pick-right-audio { width: 100%; height: 36px; }
.bgm-pick-right-tip { margin: 0; font-size: 11px; color: var(--muted-foreground); }

/* 2026-09-18 用户裁决：Step4 逐视频 BGM 指派列表（最多 10 行高，多则滚动、少则不撑满） */
.vd4-rowbgm { display: flex; flex-direction: column; margin-top: var(--space-2); }
.vd4-rowbgm-title { font-size: 12px; font-weight: 600; color: var(--muted-foreground); margin-bottom: 4px; }
.vd4-rowbgm-list {
  display: flex; flex-direction: column; gap: 4px;
  max-height: 340px; overflow-y: auto;
  padding: 6px; border: 1px solid var(--border); border-radius: var(--radius-md);
}
.vd4-rowbgm-item { display: flex; align-items: center; gap: 6px; flex: 0 0 auto; }
.vd4-rowbgm-name {
  flex: 0 0 160px; min-width: 0; overflow: hidden; text-overflow: ellipsis;
  white-space: nowrap; font-size: 12px; color: var(--foreground);
}
.vd4-rowbgm-input { cursor: pointer; }
.vd4-rowbgm-audio { flex: 0 0 240px; height: 32px; }
.vd4-rowbgm-empty { padding: 12px; text-align: center; font-size: 12px; }

/* Step4 特效包装/字幕分组（2026-09-09 裁决：花字/文字模板自 Step3 迁入；
   2026-09-13 裁决：字幕拆出单独成组置于背景音乐上方，两盒共用本样式） */
.fx-pack-box { display: flex; flex-direction: column; gap: var(--space-3); margin-bottom: var(--space-4); }
.fx-pack-title {
  font-size: 13px; font-weight: var(--font-weight-semibold); color: var(--foreground);
  padding-bottom: var(--space-2); border-bottom: 1px solid var(--border);
}
/* 文字模板效果预览：逐词应用随机模板，词下角标显示模板名 */
.textfx-word {
  display: inline-flex; flex-direction: column; align-items: center; gap: 2px;
  margin: 0 6px; padding: 2px 8px; background: #2a2a2a; border: 1px solid var(--border);
  border-radius: var(--radius-sm); font-size: 16px; font-weight: 700; color: #ffd24d;
  text-shadow: 0 0 4px rgba(0, 0, 0, 0.8);
}
/* 2026-09-10 用户终裁：词条只显示关键词本体（textfx-word-tpl 模板名小字废止） */
/* 效果预览时间轴（2026-09-10 用户裁决：每视频一条，背景条=视频时长，
   词条按 timing 真实时间点绝对定位；hover 提示词/模板/时间点） */
/* 2026-09-10 报障：多轨被共用画布 52px 固定高裁剪 → 曾放开到 168px 高、3 轨滚动；
   2026-09-11 用户裁决改用平铺：有几条视频几条轨全部显示不内部滚动
   （高度由内容撑开，长列表交给页面滚动） */
.textfx-tracks { flex-direction: column; align-items: stretch; justify-content: flex-start; gap: 6px; height: auto; overflow: hidden; }
.textfx-track { display: flex; align-items: center; gap: 8px; min-width: 0; }
.textfx-track-name {
  /* 2026-09-11 用户裁决：轨名=「第N条」序号（190px 文件名宽版与 break-all 换行废止，
     完整视频名保留在 title 悬停提示）；定宽保证各轨条头对齐 */
  flex: 0 0 60px; font-size: 11px; color: var(--muted-foreground);
  white-space: nowrap; text-align: right; line-height: 1.3;
}
.textfx-track-bar {
  position: relative; flex: 1; height: 44px; min-width: 0;
  background: repeating-linear-gradient(90deg, #262626 0 46px, #2e2e2e 46px 47px);
  border: 1px solid var(--border); border-radius: var(--radius-sm); overflow: hidden;
}
.textfx-track-item {
  position: absolute; top: 50%; transform: translateY(-50%);
  display: inline-flex; flex-direction: column; align-items: center; gap: 1px;
  padding: 2px 7px; background: #2a2a2a; border: 1px solid var(--border);
  border-radius: var(--radius-sm); font-size: 14px; font-weight: 700;
  /* 2026-09-10 用户裁决：词条颜色由命中模板决定（tplStyle 行内注入，
     与烧制主色同源）；默认色=白（烧制缺省主色），写死黄色废止 */
  color: #fff;
  text-shadow: 0 0 4px rgba(0, 0, 0, 0.8); white-space: nowrap; cursor: default;
}
/* 文字模板样式预览：按模板 variables 默认色本地渲染示例（服务端无预览接口，2026-09-10） */
/* 文字模板行样式预览（2026-09-11 用户终裁：换行铺满 + 默认只显示一行，
 * 超出由行尾「展开/收起」按钮控制；旧的横向滚动 + 两端箭头方案废止） */
.style-preview-canvas.textfx-canvas {
  justify-content: flex-start;
  align-items: flex-start;
  align-content: flex-start;
  flex-wrap: wrap;
  height: auto;
  max-height: var(--fx-row-h, 56px);
  overflow: hidden;
  padding: 4px 8px;
  row-gap: 4px;
}
.style-preview-canvas.textfx-canvas.textfx-expanded {
  max-height: 420px;
  overflow-y: auto;
}
/* 折叠按钮（最右侧）：不用 .icon-btn（28px 宽装不下中文） */
.textfx-toggle {
  flex: none; height: 24px; padding: 0 8px; font-size: 12px; white-space: nowrap;
  background: var(--card); color: var(--muted-foreground);
  border: 1px solid var(--border); border-radius: var(--radius-sm); cursor: pointer;
}
.textfx-toggle:hover { border-color: var(--primary); color: var(--foreground); }
.textfx-sample {
  display: inline-flex; flex-direction: column; align-items: center; gap: 2px;
  margin: 0 6px; padding: 4px 10px; background: #2a2a2a; border: 1px solid var(--border);
  border-radius: var(--radius-sm);
}
.textfx-sample-text {
  font-weight: 700; line-height: 1.2; max-width: 160px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  text-shadow: 0 0 4px rgba(0, 0, 0, 0.8);
}
/* 样式预览循环动画（2026-09-10 按服务端模板定义全量对齐 10 个动画模板：
   服务端以 id/name 语义 + variables 效果色变量约定动画，效果色经 --fx-color 注入；
   本地 CSS 近似演示，与服务端烧制效果非逐帧一致） */
/* 2026-09-13 用户裁决：文字模板预览要不播真实动画（render-preview/服务端 webm），
   要不只显示文字/静态图——CSS 近似模板动画整体废止（原 keyframes + textfx-anim-* 已删） */
/* 2026-09-14 用户裁决：样式预览换成剪映模板页同款卡片（9:16 视频卡+模板名），
   原 52px 共用容器压扁竖版视频 → 文字模板组独立加高 */
.textfx-sample-video { width: 108px; height: 160px; object-fit: cover; display: block; border-radius: 4px; background: #101010; }
/* 时间轴词条真实动画素材（alpha webm）：高度撑满轨条，宽度按素材比例 */
.textfx-clip { height: 100%; width: auto; display: block; border-radius: 3px; }
.w80 { width: 80px; flex: none; }

/* Step4 特效包装（对照 step4_final_view.py L80-196 同布局；颜色走 V3 design tokens） */
.vd4-gain { width: 140px; flex: none; accent-color: var(--primary); }
.vd4-gain-label { width: 50px; flex: none; font-size: 13px; color: var(--foreground); }
/* 播放/暂停、停止按钮（原版 ▶ 56x28，L80-88） */
.vd4-pbtn { width: 56px; height: 28px; font-size: 13px; }
/* 试听进度条（原版 groove 4px #27272a / handle #3b82f6 12px，L80-92 → token 化） */
.vd4-seek {
  height: 4px; appearance: none; border-radius: 2px; cursor: pointer;
  background: var(--border); outline: none;
}
.vd4-seek::-webkit-slider-thumb {
  width: 12px; height: 12px; margin-top: 0; border: none; border-radius: 6px;
  background: var(--primary); appearance: none;
}
.vd4-time { width: 90px; flex: none; font-size: 12px; color: var(--muted-foreground); text-align: center; }
/* 开始混音合成（原版 action_button 高 40 全宽，L116） */
.vd4-run { width: 100%; height: 40px; margin-top: var(--space-2); }
.vd4-grow { flex: 1; width: auto; }
/* 2026-09-18 用户裁决：导出方案引导区（标题 + 方案一/二文案 + 各自按钮竖排） */
.vd4-schemes { display: flex; flex-direction: column; }
.vd4-scheme-title { margin-top: var(--space-2); font-size: 13px; font-weight: 600; color: var(--foreground); }
.vd4-scheme-line { margin-top: 6px; font-size: 12px; color: var(--muted-foreground); }
/* 结果区（原版 result_box：rgba(255,255,255,0.03) + border rgba(255,255,255,0.1)，L116 → token 化） */
.vd4-result {
  display: flex; gap: 15px; padding: 10px; margin-top: var(--space-2);
  background: var(--surface-container); border: 1px solid var(--border); border-radius: 4px;
}
.vd4-left { flex: 3; min-width: 0; display: flex; flex-direction: column; gap: 8px; }
.vd4-left-title { font-size: 13px; font-weight: 600; color: var(--foreground); }
/* 成片列表限高约 10 行（2026-09-15 用户裁决：多则滚动、少则按实际高度），行内带逐条导出按钮 */
.vd4-list { max-height: 320px; overflow-y: auto; }
.vd4-btns { display: flex; gap: 8px; }
.vd4-btns > .t-button { flex: 1; padding: 0 6px; }
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

/* 状态标签样式 */
.st-pending { color: var(--muted-foreground); font-size: 12px; }
.st-running { color: var(--primary); font-size: 12px; font-weight: 600; }
.st-done { color: var(--success); font-size: 12px; font-weight: 600; }
.st-failed { color: var(--danger, #e74c3c); font-size: 12px; font-weight: 600; }

/* 还原 LUT：库内选择列表（2026-09-14） */
.lut-list { display: flex; flex-direction: column; gap: 4px; max-height: 132px; overflow-y: auto; }
</style>
