<script setup lang="ts">
// ═══════════════════════════════════════════════════════════════
// MontageStep4Panel.vue — 智能混剪 Step4 特效包装/BGM/成片面板（铁律 10 Phase3 P4，2026-09-19）
// 模板/样式自 VideoMontage.vue 逐字搬迁；状态经 inject 解构回原名（零改动）。
// 本面板本地逻辑：textfx 样式画布测量（折叠/ResizeObserver）、BGM 选择弹窗
// （音频库 + AI 生成右栏，useAudioGen 独立实例）、花字/字幕下拉选项与预览 computed、
// 右栏 step4PreviewItems。
// ═══════════════════════════════════════════════════════════════
import { ref, computed, watch, onMounted, onUnmounted, nextTick, inject } from 'vue'
import TButton from '@/components/common/TButton.vue'
import TSelect from '@/components/common/TSelect.vue'
import StepPreviewPane, { type StepPreviewItem, type StepPreviewKeyword } from './StepPreviewPane.vue'
import VdStepBar from './VdStepBar.vue'
import { useAudioGen } from '@/composables/useAudioGen'
import { montageShellKey } from './montageUiContext'
import { FANCY_STYLE_PREVIEW, fancyDrawtextToPreview, subtitlePresetTileStyle } from '@/composables/videoMontageLogic'

const shell = inject(montageShellKey)!
const { step, go, vdLeftStyle, onSplitDown } = shell
const {
  splitResolution,
  previewUrl,
  concatLayout,
  assemblePlans,
  planRowText,
  voiceRows,
  addSubtitles,
  subtitleFont,
  fontOptions,
  fontsLoading,
  refreshFonts,
  subtitleStyleKey,
  subtitleStylePresets,
  subtitlePreviewStyle,
  subtitleAnimKey,
  subtitleFontSize,
  fontOptionStyle,
  fancyEnabled,
  fancyStyle,
  fancyPosition,
  subtitleBgOpacity,
  fancyTemplateId,
  fancyTemplates,
  fancyPreviews,
  lutRestore,
  lutId,
  lutList,
  lutListLoading,
  textFxEnabled,
  textTemplateId,
  textTemplateOptions,
  textTemplates,
  textRandomCount,
  textKeywordDensity,
  TEXT_RANDOM_COUNT_OPTIONS,
  TEXT_KEYWORD_DENSITY_OPTIONS,
  textFxPreviewTracks,
  textFxStyleSamples,
  loadTextTemplates,
  FANCY_STYLE_OPTIONS,
  FANCY_POSITION_OPTIONS,
  SUBTITLE_BG_OPTIONS,
  fmtDur,
  pathBasename,
  bgmPath,
  bgmName,
  bgmVolume,
  finalBusy,
  finalMode,
  finalDone,
  finalProgress,
  exportBusy,
  exportProgress,
  exportStage,
  lastExportDraftPath,
  exportDoneMsg,
  exportJianyingPackageDraft,
  finalVideoList,
  finalSelIdx,
  bgmPlaying,
  bgmPosMs,
  bgmDurMs,

  pickBgm,
  applyLibraryBgm,
  toggleBgmPlay,
  stopBgmPlay,
  onBgmVolumeInput,
  seekBgm,
  rowBgmName,
  setRowBgm,
  clearRowBgm,
  pickRowBgm,
  downloadLibraryBgm,
  rowBgmForCandidate,
  startFinalMix,
  openFinalDir,
  openExportDraftDir,
  exportAllToJianyingDraft,
  previewFinalVideo,
  step4Candidates,
  toAbsolute: vdToAbsolute,
  fmtBgmTime,
} = shell.s

/** 本地路径 → file URL（previewFinalVideo 同口径） */
function toFileUrl(p: string): string {
  return 'file:///' + encodeURI(String(p).replace(/\\/g, '/')).replace(/#/g, '%23')
}

/** 逐视频 BGM 行播放条 src（2026-09-18 用户裁决）：该行生效 BGM=逐行指派优先、
 *  未指派回退全局（同导出/合成口径）；无生效 BGM 返空串（不渲染播放条） */
function rowBgmAudioSrc(videoPath: string): string {
  const p = rowBgmForCandidate(videoPath)
  return p ? toFileUrl(p) : ''
}

/** 预览块画幅（2026-09-11 用户裁决）：竖屏模式下预览块也竖起来，不再是横向块里
 *  嵌竖条（两侧大片黑边）。口径与 Step2「输出画幅」+ layoutSize 兜底完全同步：
 *  vertical → 9/16；horizontal → 16/9；source → 分割片段分辨率（splitResolution，
 *  2026-09-15 用户裁决：基准=分割片段而非原素材）；
 *  source 拿不到 → 9/16（layoutSize 对 source 无效探测的兜底即 1080x1920）。
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

/** Step2 右栏：每条方案一块——确认成片直播；未确认给镜头连播序列（激活块内连播） */
const step2PreviewItems = computed<StepPreviewItem[]>(() => assemblePlans.value.map((p, i) => {
  if (p.confirmed && p.outputPath) {
    return { badge: `第 ${i + 1} 条`, src: toFileUrl(p.outputPath), tip: p.outputName || '' }
  }
  const seq = p.clips.filter((_, ci) => !p.deletedFlags[ci]).map((c) => vdToAbsolute(c.clipUrl))
  return {
    badge: `第 ${i + 1} 条`,
    seqList: seq,
    placeholder: seq.length ? `${seq.length} 个镜头 · 待确认合成` : '待确认合成',
    tip: planRowText(i),
  }
}))

/** Step4 右栏：合成完成→成片直播；否则候选视频 + 特效叠加预览（样式随左侧配置实时联动） */
const step4PreviewItems = computed<StepPreviewItem[]>(() => {
  if (finalDone.value && finalVideoList.value.length) {
    return finalVideoList.value.map((it, i) => ({
      badge: `第 ${i + 1} 条`, src: toFileUrl(it.path), tag: '成片', tagClass: 'ok', tip: it.name,
    }))
  }
  const kwStyle = textFxStyleSamples.value[0]?.style as Record<string, string | number> | undefined
  return step4Candidates.value.map((c, i) => {
    const row = voiceRows.value.find((r) => r.dubbedPath === c || r.path === c)
    const sub = addSubtitles.value ? String(row?.text || '').split(/\r?\n/)[0]?.trim().slice(0, 20) : ''
    const track = textFxPreviewTracks.value[i]
    let keywords: StepPreviewKeyword[] = []
    if (textFxEnabled.value && track?.items?.length) {
      keywords = track.items.slice(0, 2).map((t) => ({ text: t.word, style: kwStyle }))
    } else if (fancyEnabled.value) {
      keywords = [{ text: FANCY_PREVIEW_TEXT, style: fancyCustomPreviewStyle.value }]
    }
    return {
      badge: `第 ${i + 1} 条`,
      src: toFileUrl(c),
      subtitle: sub || undefined,
      subtitleStyle: subtitlePreviewStyle.value,
      keywords: keywords.length ? keywords : undefined,
      tag: row?.dubbedPath ? '已配音' : '待配音',
      tagClass: row?.dubbedPath ? 'ok' : '',
      tip: pathBasename(c),
    }
  })
})

/** Step4 选中联动：右栏点块 = 左列表选中（成片预览由块内 video 直播） */
function onStep4Select(i: number): void {
  finalSelIdx.value = i
}


// 文字模板样式预览折叠（2026-09-11 用户裁决：两端箭头废止 → 最右侧折叠按钮，
// 默认只显示一行，样式多于一行时点「展开」看剩余）
const textFxCanvasEl = ref<HTMLElement | null>(null)
const textFxExpanded = ref(false)
/** 样式是否多到一行装不下（决定折叠按钮是否出现；只有一行时不给按钮） */
const textFxOverflow = ref(false)
/** 「一行」高度：按首个卡片实测（字号随模板变化，写死会裁字）+ 上下 padding */
const textFxRowH = ref(0)
const textFxCanvasStyle = computed(() =>
  textFxExpanded.value ? {} : { '--fx-row-h': `${textFxRowH.value || 56}px` })
/** 仅在收起态测量：展开态 scrollHeight == clientHeight 量不出溢出基准 */
function measureTextFxStyles(): void {
  const el = textFxCanvasEl.value
  if (!el || textFxExpanded.value) return
  // 不可见时（步未到或勾选关闭）几何全为 0 量不出真实溢出，跳过避免误判「一行装得下」
  if (!el.clientHeight) return
  const first = el.querySelector('.textfx-sample') as HTMLElement | null
  if (first && first.offsetHeight > 0) textFxRowH.value = first.offsetHeight + 8
  textFxOverflow.value = el.scrollHeight - el.clientHeight > 2
}
/** 展开/收起切换：收起后需重测（宽度不变但一行基准变了） */
async function toggleTextFxStyles(): Promise<void> {
  textFxExpanded.value = !textFxExpanded.value
  await nextTick()
  measureTextFxStyles()
}
watch(textFxStyleSamples, async () => {
  textFxExpanded.value = false
  await nextTick()
  measureTextFxStyles()
})
// 首次挂载即测（模板库若已有数据、watch 不会触发 → 按钮会永不出现）
onMounted(async () => { await nextTick(); measureTextFxStyles() })
// 2026-09-11 二次修复「折叠箭头不出现」——全链路根因：模板库进入第④步才拉取
// （loadTextTemplates），画布又随 textFxEnabled 勾选 v-if 挂载；原触发点（onMounted/
// 样本变化）在画布不在 DOM 时全部空跑（ref=null 直接 return），勾选后无任何重测
// → textFxOverflow 恒 false → 按钮 v-if 永不出现（父布局无固定高度，非布局钳制）。
// 补两路触发：①扫到第④步/勾选开关变化即重测；②画布实挂载即挂 ResizeObserver
// （初始回调保证挂载即测一次，持续兜底尺寸与布局变化）
watch([step, textFxEnabled], async () => { await nextTick(); measureTextFxStyles() })
let textFxResizeObs: ResizeObserver | null = null
watch(textFxCanvasEl, (el) => {
  textFxResizeObs?.disconnect()
  textFxResizeObs = null
  if (el) {
    measureTextFxStyles()
    textFxResizeObs = new ResizeObserver(() => measureTextFxStyles())
    textFxResizeObs.observe(el)
  }
}, { flush: 'post' })
onUnmounted(() => { textFxResizeObs?.disconnect(); textFxResizeObs = null })


// ── Step4 BGM 选择弹窗 + AI 生成 BGM（2026-09-09 用户裁决：复用音频生成页域，
//    独立实例与 AudioGen 页互不影响；AI 生成用「生成 BGM」同款结构化布局，
//    生成/选中后回填 bgmPath 本地混音链路）──
const ag = useAudioGen()
const {
  bgmStyle, bgmStyleOptions, bgmDuration, bgmBusy, bgmResultLabel, bgmUrl, bgmSaving,
  bgmLocal, generateBgm, saveBgmToLib, openBgmLocation,
  bgmMood, bgmMoodOptions, bgmScene, bgmSceneOptions,
  listQuery, listTag, listKind, LIST_KIND_OPTIONS,
  listRows, listLoading, listError, listStat, listPageSize,
  pageLabel, canPrevPage, canNextPage,
  doSearch, goPrevPage, goNextPage, loadBgmTags,
  playingMid, listAudioEl, playListRow,
  toAbsolute,
} = ag

// 生成完成自动归档本地后回填 BGM 路径（混音/剪映导出走同一本地链路）
// 2026-09-18 用户裁决：AI 生成 BGM 集成进「选择 BGM」弹窗右栏——生成结果按弹窗当前
// 目标回填（target 非空=逐行指派到该视频；空=回填全局 bgmPath）
watch(bgmLocal, (p) => {
  if (!p) return
  const target = bgmPickDlg.value.target
  if (target) setRowBgm(target, p, pathBasename(p))
  else { bgmPath.value = p; bgmName.value = pathBasename(p) }
})

/** 生成面板内联播放条（2026-09-15 用户裁决：删「播放生成的 BGM」按钮，<audio controls>
 *  的 src 直挂就地播放；取源口径同原 playAgBgm——本地归档优先，未就绪回退在线 URL；
 *  src 变化时 audio 自动重载，新生成即播新文件） */
const agBgmAudioSrc = computed(() => bgmLocal.value
  ? toFileUrl(bgmLocal.value)
  : bgmUrl.value ? toAbsolute(bgmUrl.value) : '')

/** BGM 选择弹窗（2026-09-18 用户裁决：左栏音频库列表 + 右栏 AI 生成，2:1）。
 *  target='' 指派全局 BGM；target=视频路径 指派该视频逐行 BGM。 */
const bgmPickDlg = ref<{ show: boolean; target: string; pickedMid: string; busy: boolean; error: string }>({ show: false, target: '', pickedMid: '', busy: false, error: '' })
function openBgmPickDlg(target = ''): void {
  bgmPickDlg.value.show = true
  bgmPickDlg.value.target = target
  bgmPickDlg.value.pickedMid = ''
  bgmPickDlg.value.error = ''
  // 2026-09-10 用户裁决：BGM 选择弹窗默认分类「音乐」（列表状态与音频生成页共享，
  // 仅在打开弹窗时置分类并刷新，不影响音频生成页自身默认「全部」）
  if (listKind.value !== 'music') {
    listKind.value = 'music'
    doSearch()
  } else if (!listRows.value.length && !listLoading.value) {
    doSearch()
  }
  void loadBgmTags()
}
function confirmBgmPick(): void {
  if (bgmPickDlg.value.busy) return
  const target = bgmPickDlg.value.target
  // 2026-09-18 用户裁决：AI 生成结果可直接「确定」应用（无需先保存到 BGM 库再回左栏选）——
  // 未选左栏条目但右栏已生成本地文件时，直接按弹窗目标回填生成结果并关闭
  const it = listRows.value.find((r) => r.mid === bgmPickDlg.value.pickedMid)
  if (!it) {
    const gen = bgmLocal.value
    if (!gen) { bgmPickDlg.value.error = '请先在左栏选择音频，或在右栏生成 BGM'; return }
    if (target) setRowBgm(target, gen, pathBasename(gen))
    else { bgmPath.value = gen; bgmName.value = pathBasename(gen) }
    bgmPickDlg.value.show = false
    return
  }
  bgmPickDlg.value.busy = true
  bgmPickDlg.value.error = ''
  const done = (r: { path?: string; error?: string }): void => {
    bgmPickDlg.value.busy = false
    if (r && r.error) { bgmPickDlg.value.error = r.error; return }
    if (target && r && r.path) setRowBgm(target, r.path, it.filename || pathBasename(r.path))
    bgmPickDlg.value.show = false
  }
  if (target) void downloadLibraryBgm(it.mid).then(done)
  else void applyLibraryBgm(it.mid, it.filename).then(done)
}


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
</script>

<template>
      <section class="card">
        <!-- 2026-09-10 界面统一：左操作区 + 右统一预览两栏（右栏与 Step2/3 同位置同宽） -->
        <div class="vd-unified">
        <div class="vd-unified-left" :style="vdLeftStyle">
        <VdStepBar :step="step" @go="go" />
        <!-- 特效包装分组（2026-09-13 用户裁决：字幕拆出单独成组、置于背景音乐上方）：花字 + 文字模板 -->
        <div class="action-box fx-pack-box">
          <div class="fx-pack-title">花字</div>

          <!-- 花字（原 Step3 三行原样迁入；2026-09-14 用户裁决：花字/文字模板分开成组） -->
          <div class="row">
            <label class="chk" title="在视频画面叠加花字特效文字（可选出现位置），用于突出关键卖点/价格/型号等信息。&#10;花字内容自动从口播文案中逐行提取卖点（价格 > 数字参数 > 关键词），无需手动输入；&#10;每个花字随对应字幕提前 0.3 秒出现、该句字幕结束即消失。">
              <input v-model="fancyEnabled" type="checkbox" />
              添加花字 (关键信息加重提醒)
            </label>
            <label class="param-label">花字内容:</label>
            <span class="fancy-content-hint">自动提取口播文案卖点（价格/数字参数/关键词），随对应字幕提前 0.3 秒出现、字幕结束消失</span>
          </div>
          <div v-if="fancyEnabled" class="row">
            <label class="param-label">模板:</label>
            <TSelect v-model="fancyTemplateId" :options="fancyTemplateOptions" class="w130"
              title="花字模板 = 样式 + 入场动画 + 出现音效 + 出现时机。&#10;标「（服务端）」的条目来自服务端花字模板库（GET /fancy/templates），与本地同格式、可直接参与配音烧制；其余为本地剪映提取模板（resources/fancy/templates/）。&#10;选「自定义」时用下方样式/位置；选模板时以模板样式为准；右侧预览标签展示渲染效果。" />
            <span class="fancy-preview"
              title="花字模板预览（按模板样式渲染样本字）；悬停查看动画/音效/时机信息。服务端与本地模板同一预览口径。">
              <img v-if="fancyTemplatePreview" :src="fancyTemplatePreview" alt="预览" />
              <span v-else-if="serverTemplateDesc" class="fancy-preview-desc">{{ serverTemplateDesc }}</span>
              <template v-else>预览生成中…</template>
            </span>
            <label class="param-label">样式:</label>
            <TSelect v-model="fancyStyle" :options="fancyStyleOptions" class="w110" />
            <label class="param-label">位置:</label>
            <TSelect v-model="fancyPosition" :options="fancyPositionOptions" class="w110"
              title="花字在画面中出现的位置。&#10;底部两个位置与逐行字幕可能重叠，字幕开启时建议选顶部/中上/四角。" />
          </div>
          <div v-if="fancyEnabled" class="row">
            <label class="param-label">效果预览:</label>
            <div class="style-preview-canvas">
              <span class="style-preview-text" :style="fancyCustomPreviewStyle">{{ FANCY_PREVIEW_TEXT }}</span>
            </div>
          </div>

        </div>

        <!-- 文字模板分组（2026-09-14 用户裁决：与花字分开成组） -->
        <div class="action-box fx-pack-box">
          <div class="fx-pack-title">文字模板</div>
          <!-- 文字模板（2026-09-09 用户裁决：服务端 textfx 动画体系，与花字独立概念；
               随机样式默认从全部模板中选 3 个；烧制待服务端烧制接口上线，先配置+预览；
               2026-09-10 布局裁决：勾选/设置/样式预览/效果预览各占一行） -->
          <div class="row">
            <label class="chk" title="服务端文字模板（textfx 动画：弹跳/打字机/霓虹等），与花字是独立体系。&#10;随机样式=关键词命中模式：服务端从随合成请求提交的字幕里判定命中行（常用关键词∪内置卖点词），命中行整行改用模板动画；不足时自动由 LLM 从字幕行补足（默认开）。&#10;指定样式=整段字幕按该模板渲染。">
              <input v-model="textFxEnabled" type="checkbox" />
              添加文字模板 (关键信息动画提醒)
            </label>
          </div>
          <div v-if="textFxEnabled" class="row">
            <label class="param-label">文字模板:</label>
            <TSelect v-model="textTemplateId" :options="textTemplateOptions" class="w130"
              title="来自服务端文字模板库（GET /text_templates/templates）。&#10;关键词判定与文案提取全部由服务端从合成请求携带的字幕完成，客户端不上传词表。&#10;选「随机样式」时命中行从随机模板池选样式；指定样式时整段字幕用该模板。" />
            <template v-if="textTemplateId === 'random'">
              <label class="param-label">随机数量:</label>
              <TSelect v-model="textRandomCount" :options="TEXT_RANDOM_COUNT_OPTIONS" class="w80"
                title="随机模板池大小（默认 3 个）：每次合成从模板库随机取 N 个作为命中行的候选样式" />
              <label class="param-label">关键词密度:</label>
              <TSelect v-model="textKeywordDensity" :options="TEXT_KEYWORD_DENSITY_OPTIONS" class="w80"
                title="命中动画密度（服务端口径）：每 30 秒按低/中/高分别命中 3/6/10 个，保底 3 个；&#10;命中过多自动等距抽稀，不足时由 LLM 从字幕行挑补足。" />
            </template>
          </div>
          <div v-if="textFxEnabled" class="row">
            <label class="param-label">样式预览:</label>
            <!-- 2026-09-11 用户裁决：两端箭头废止，改最右折叠——默认一行，超出点「展开」
                 （横向滚动条与两端箭头两套旧方案均已废止） -->
            <div ref="textFxCanvasEl" class="style-preview-canvas textfx-canvas"
              :class="{ 'textfx-expanded': textFxExpanded }" :style="textFxCanvasStyle">
              <template v-if="textFxStyleSamples.length">
                <span v-for="s in textFxStyleSamples" :key="'ts' + s.id" class="textfx-sample"
                  :title="`模板：${s.name}`">
                  <!-- 2026-09-13 用户裁决：要不播真实动画（服务端 preview.webm，与成片同渲染器），
                       要不只是文字/静态图——CSS 近似动画废止 -->
                  <video v-if="s.previewWebmUrl" class="textfx-sample-video" :src="s.previewWebmUrl"
                    autoplay loop muted playsinline />
                  <img v-else-if="s.previewUrl" class="textfx-sample-img" :src="s.previewUrl" :alt="s.name" />
                  <span v-else class="textfx-sample-text" :style="s.style">{{ s.text }}</span>
                  <small class="textfx-word-tpl">{{ s.name }}</small>
                </span>
              </template>
              <span v-else class="muted">{{ textTemplates.length ? '未命中模板' : '文字模板库为空，请先在服务端上传文字模板' }}</span>
            </div>
            <button v-if="textFxOverflow" class="textfx-toggle"
              :title="textFxExpanded ? '收起，只看一行' : '展开全部样式'"
              @click="toggleTextFxStyles">
              {{ textFxExpanded ? '收起 ▲' : '展开 ▼' }}
            </button>
          </div>
          <!-- 2026-09-10 用户终裁：本行不设「效果预览:」标签字；时间轴条内词条只显示关键词本体
               （模板名小字废止，仅保留在 hover 提示里）。
               2026-09-11 用户裁决：行左侧改显示「第N条」序号（完整视频名保留在悬停提示） -->
          <div v-if="textFxEnabled" class="row">
            <!-- 上一步合成几条就几条轨（2026-09-11 裁决：全部平铺不截断），
                 轨名=第N条，背景条本身即时长，词条按真实时间点定位 -->
            <div class="style-preview-canvas textfx-tracks">
              <template v-if="textFxPreviewTracks.length">
                <div v-for="(tr, ti) in textFxPreviewTracks" :key="'tt' + ti" class="textfx-track">
                  <span class="textfx-track-name" :title="tr.name">第{{ ti + 1 }}条</span>
                  <div class="textfx-track-bar">
                    <span v-for="(it, ii) in tr.items" :key="'ti' + ii" class="textfx-track-item"
                      :style="{ left: (tr.durationSec > 0 ? Math.min(92, (it.start / tr.durationSec) * 100) : 0) + '%' }"
                      :title="`${it.fullText || it.word} · ${it.tplName} · ${fmtDur(it.start)} / ${fmtDur(tr.durationSec)}`">
                      <!-- 2026-09-15 用户裁决：词条=纯关键词标记（哪些词/哪个位置），不播
                           render-preview 片段——那是近似物（默认字体+CSS 动画），渲染只在合成时发生 -->
                      <b>{{ it.word }}</b>
                    </span>
                  </div>
                </div>
              </template>
              <span v-else class="muted">{{ textTemplates.length ? '上一步合成的视频将在此逐条预览关键词效果' : '文字模板库为空，请先在服务端上传文字模板' }}</span>
            </div>
          </div>
        </div>

        <!-- 字幕分组（2026-09-13 用户裁决：字幕单独一组，置于背景音乐上方；自特效包装组拆出。
             行1 勾选 / 行2 字体+背景+动画+预设样式色板 / 行3 效果预览；样式 key 与主进程 SUBTITLE_STYLES 同表） -->
        <div class="action-box fx-pack-box">
          <div class="fx-pack-title">字幕</div>
          <div class="row">
            <label class="chk" title="字幕字体取自服务端字体库（GET /config/fonts）。&#10;本地 ffmpeg 烧制：预设样式以 drawtext 描边（borderw=3）实现；&#10;服务端合成时随 subtitle_style 一并提交。">
              <input v-model="addSubtitles" type="checkbox" />
              烧制字幕（逐行按时间显示，字号随视频高度自适应）
            </label>
          </div>
          <div v-if="addSubtitles" class="row">
            <label class="param-label">字幕字体:</label>
            <TSelect v-model="subtitleFont" :options="fontOptions" class="w230" :option-style="fontOptionStyle"
              title="字体列表来自服务端 /config/fonts，各选项按自身字体渲染" />
            <TButton label="刷新字体" variant="secondary" size="small" :loading="fontsLoading" title="重新从服务端拉取字体列表" @click="refreshFonts" />
            <label class="param-label">背景:</label>
            <TSelect v-model="subtitleBgOpacity" :options="subtitleBgOptions" class="w130"
              title="字幕背景色为黑色，此项调背景不透明度（0=无背景框）。&#10;值越高背景越实。" />
            <label class="param-label">动画:</label>
            <TSelect v-model="subtitleAnimKey" :options="subtitleAnimOptions" class="w130"
              title="字幕入场动画（烧制与预览同用此选择）。&#10;注意背景框不参与淡入（drawtext alpha 只作用于文字）。" />
            <label class="param-label">字号:</label>
            <TSelect v-model="subtitleFontSize" :options="subtitleFontSizeOptions" class="w90"
              title="字幕字号（剪映草稿文本 size，默认 10 号）。&#10;值越大字幕越大，效果预览同比例缩放。" />
            <label class="param-label">样式:</label>
            <div class="sub-style-grid" title="字幕样式来自服务端 /subtitle_styles 库（烧制时以 ffmpeg drawtext 或服务端引擎实现，效果以成品为准）">
              <button v-for="p in subtitleStylePresets" :key="p.key" type="button" class="sub-style-tile"
                :class="{ active: subtitleStyleKey === p.key }" :title="p.label" @click="subtitleStyleKey = p.key">
                <span class="sub-style-tile-text" :style="subtitlePresetTileStyle(p)">字幕</span>
              </button>
            </div>
          </div>
          <div v-if="addSubtitles" class="row">
            <label class="param-label">效果预览:</label>
            <div class="style-preview-canvas">
              <span class="style-preview-text" :class="subtitleAnimKey !== 'none' ? 'sub-anim-' + subtitleAnimKey : ''"
                :style="subtitlePreviewStyle">这是字幕预览效果 ABC123</span>
            </div>
          </div>
        </div>

        <!-- 1. BGM input（全局）：2026-09-18 用户裁决——AI 生成 BGM 已集成进「选择BGM」弹窗右栏，
             删除独立「AI 生成 BGM」按钮与内联面板；「选择BGM」弹窗 target='' 指派全局 BGM -->
        <div class="row">
          <label class="label"> 背景音乐 (BGM):</label>
          <input :value="bgmPath" placeholder="选择混剪背景音乐 (mp3/wav)，选空则无BGM..." readonly class="input grow" @click="pickBgm" />
          <!-- 2026-09-10 用户裁决：删「选择背景音乐」按钮（点击输入框已可上传）；保留「选择BGM」弹音频库 -->
          <TButton label="选择BGM" size="small" variant="secondary" @click="openBgmPickDlg('')" />
        </div>

        <!-- BGM 试听一行（2026-09-10 用户裁决：播放控制在 前、设置在后）：
             播放/暂停 ⏹ + 进度条 + 时间 + BGM 增益（0-200%，100%=原音量，拖动实时改变试听音量） -->
        <div class="row vd4-player">
          <button class="icon-btn vd4-pbtn" :title="bgmPlaying ? '暂停' : '播放/暂停'" @click="toggleBgmPlay">{{ bgmPlaying ? '⏸' : '▶' }}</button>
          <button class="icon-btn vd4-pbtn" title="停止播放" :disabled="!bgmPlaying" @click="stopBgmPlay">⏹</button>
          <input class="vd4-seek grow" type="range" min="0" :max="bgmDurMs" step="1" :value="bgmPosMs" @input="seekBgm" />
          <span class="vd4-time">{{ fmtBgmTime(bgmPosMs) }} / {{ fmtBgmTime(bgmDurMs) }}</span>
          <label class="label" title="BGM 增益 0-200%，100%=原音量；拖动实时改变试听音量">BGM 增益:</label>
          <input v-model.number="bgmVolume" type="range" min="0" max="200" step="1" class="vd4-gain" @input="onBgmVolumeInput" />
          <span class="vd4-gain-label">{{ bgmVolume }} %</span>
        </div>

        <!-- 2026-09-18 用户裁决：逐视频 BGM 指派列表（上一步整个视频列表）——默认最多 10 行高，
             多则滚动、少则不撑满；每行 = 序号+视频名 + BGM 输入框（点击选本地文件）+ 选择BGM 按钮 -->
        <div class="vd4-rowbgm">
          <div class="vd4-rowbgm-title">逐视频 BGM（未设置的行跟随上方全局 BGM）</div>
          <div class="vd4-rowbgm-list">
            <div v-for="(c, i) in step4Candidates" :key="c" class="vd4-rowbgm-item">
              <span class="vd4-rowbgm-name" :title="c">{{ i + 1 }}. {{ pathBasename(c) }}</span>
              <input :value="rowBgmName(c)" readonly class="input grow vd4-rowbgm-input"
                placeholder="跟随全局 BGM（点击选本地文件）" @click="pickRowBgm(c)" />
              <audio v-if="rowBgmAudioSrc(c)" :src="rowBgmAudioSrc(c)" controls preload="none"
                class="vd4-rowbgm-audio" :title="`试听该行生效 BGM（${rowBgmName(c) ? '逐行指派' : '跟随全局'}）`" />
              <TButton label="选择BGM" size="small" variant="secondary" @click="openBgmPickDlg(c)" />
              <TButton v-if="rowBgmName(c)" label="清除" size="small" plain @click="clearRowBgm(c)" />
            </div>
            <div v-if="!step4Candidates.length" class="muted vd4-rowbgm-empty">暂无视频，请先完成上一步镜头重组与口播配音</div>
          </div>
        </div>

        <!-- 2026-09-14 服务端 /montage/concat 新增 lut_restore（默认 false=不还原 LUT）：
             勾选=恢复旧行为（无显式 LUT 文件时自动抽帧匹配 LUT 库）；显式 LUT 文件上传
             始终优先不受开关影响。仅服务端合成消费（本地 ffmpeg 无 LUT 概念） -->
        <div class="row">
          <label class="chk" title="勾选后：服务端合成在未显式上传 LUT 文件时，自动抽帧匹配 LUT 库还原调色（恢复旧行为）。&#10;默认不勾选 = 不做 LUT 还原。显式上传 LUT 文件时始终应用，不受此开关影响。">
            <input v-model="lutRestore" type="checkbox" />
            还原 LUT（自动抽帧匹配 LUT 库）
          </label>
        </div>
        <div v-if="lutRestore" class="row">
          <label class="param-label">选择 LUT:</label>
          <div class="lut-list">
            <label v-for="l in lutList" :key="String(l.id)" class="chk">
              <input type="radio" name="lutPick" :value="String(l.id)" :checked="lutId === String(l.id)"
                @change="lutId = String(l.id)" />
              {{ String(l.name) }}
              <span class="tag">{{ l.kind === 'restore' ? '还原' : '风格' }}</span>
              <span v-if="l.description" class="muted">{{ String(l.description) }}</span>
            </label>
            <span v-if="!lutList.length" class="muted">{{ lutListLoading ? '加载中…' : '服务端 LUT 库为空（可用 /config/luts 上传 .cube）' }}</span>
          </div>
        </div>
        <!-- 2026-09-18 用户裁决：动作区加导出方案引导文案，竖排：
             标题「请选择导出方案」→ 方案一文案 → 其两按钮 → 方案二文案 → 服务端合成按钮 -->
        <div class="vd4-schemes">
          <div class="vd4-scheme-title">请选择导出方案</div>
          <div class="vd4-scheme-line">方案一，速度快，可以在剪映里编辑，需要本地安装剪映，</div>
          <div class="row" style="gap: var(--space-2)">
            <!-- 2026-09-15 用户裁决：本地合成删除（统一走服务端合成）；
                 导出到剪映时间轴紧随服务端合成之后 -->
            <TButton label="导出到剪映时间轴(带转场)" variant="secondary" class="vd4-run vd4-grow"
              :disabled="finalBusy || exportBusy"
              :title="exportBusy ? exportStage : '将合成候选按顺序导出为一条剪映时间轴草稿（口播/字幕/关键词/BGM 各轨独立，片段间自动转场）'"
              @click="exportAllToJianyingDraft" />
            <!-- 轨 2（2026-09-17 用户裁决）：服务端封装好的剪映格式草稿 zip → 解压校验 → 落盘剪映
                 2026-09-18 用户裁决：暂时禁止使用（恒禁用）；恢复时把 :disabled 改回
                 "finalBusy || exportBusy"、title 改回原文案即可 -->
            <TButton label="导入服务端草稿包" variant="secondary" class="vd4-run vd4-grow"
              :disabled="true"
              title="该功能暂时停用"
              @click="exportJianyingPackageDraft" />
          </div>
          <!-- 2026-09-18 用户裁决：导出剪映时间轴进度条+完成提示独立于服务端合成，
               紧跟方案一按钮（不放到服务端合成下面） -->
          <div v-if="exportBusy" class="pbar"><div class="pbar-inner" :style="{ width: exportProgress + '%' }"></div></div>
          <div v-if="exportBusy && exportStage" class="muted" style="margin-top:4px;font-size:12px">{{ exportStage }}</div>
          <div v-if="exportDoneMsg" class="row left" style="gap: var(--space-2); margin-top: 4px">
            <span class="concat-status-line">{{ exportDoneMsg }}</span>
            <TButton v-if="lastExportDraftPath" label="打开草稿目录" variant="secondary" size="small" @click="openExportDraftDir" />
          </div>
          <div class="vd4-scheme-line">方案二，服务端合成视频，时间较长</div>
          <TButton label="服务端合成" class="vd4-run" :loading="finalBusy && finalMode === 'server'"
            :disabled="finalBusy" title="特效烧制 + BGM 混音全部走服务端一次合成（字幕入场动画服务端无字段，不生效）" @click="startFinalMix()" />
        </div>
        <!-- 服务端合成进度条（独立于导出进度；导出进度/完成提示已移至方案一按钮下方） -->
        <div v-if="finalBusy" class="pbar"><div class="pbar-inner" :style="{ width: finalProgress + '%' }"></div></div>

        <!-- 结果区：左 成片列表 + 三按钮；右 视频预览 -->
        <div class="vd4-result">
          <div class="vd4-left">
            <div class="vd4-left-title">最终合成生成的视频文件:</div>
            <ul class="file-list vd4-list">
              <li
                v-for="(it, i) in finalVideoList" :key="i"
                :class="{ picked: finalSelIdx === i }"
                @click="onStep4Select(i)"
              >{{ it.name }}</li>
              <li v-if="!finalVideoList.length" class="muted">暂无成片，点击「服务端合成」后此处展示结果</li>
            </ul>
            <div class="vd4-btns">
              <TButton label="打开视频输出目录" variant="secondary" :disabled="!finalDone" class="grow" @click="openFinalDir" />
            </div>
          </div>
        </div><!-- /vd4-result -->

        <!-- 导航行（2026-09-10 用户裁决：上/下步按钮属操作区；原版 Step4 仅上一步，文案逐字 L190） -->
        <div class="row left">
          <TButton label="上一步：口播配音" plain @click="go(2)" />
        </div>
        </div><!-- /vd-unified-left -->

<div class="vd-split" title="拖动调整左右比例" @mousedown="onSplitDown"></div>

        <!-- 右栏：统一预览（成片直播/候选+特效叠加层，点击块切列表选中） -->
        <div class="vd-unified-right">
          <StepPreviewPane title="成片预览" :items="step4PreviewItems" :active-index="finalSelIdx"
            :aspect="previewAspect"
            empty-text="完成配音后进入本步，点击「服务端合成」或「本地合成」生成成片" @select="onStep4Select" />
        </div>
        </div><!-- /vd-unified -->
      </section>
      <div v-if="bgmPickDlg.show" class="modal-mask" @click.self="bgmPickDlg.show = false">
        <div class="modal modal-wide bgm-pick">
          <span class="modal-title">选择 BGM{{ bgmPickDlg.target ? '（当前视频）' : '（全局）' }}</span>
          <!-- 2026-09-18 用户裁决：左右 2:1 分栏——左=音频库列表，右=AI 生成 BGM -->
          <div class="bgm-pick-cols">
          <div class="bgm-pick-left">
          <div class="row">
            <input v-model="listQuery" class="input grow" placeholder="搜索音频（语义检索，如：激昂的背景音乐）" :disabled="listLoading" @keydown.enter="doSearch()" />
            <TButton label="搜索" :loading="listLoading" :disabled="listLoading" @click="doSearch()" />
          </div>
          <div class="row">
            <label class="label">分类:</label>
            <TSelect v-model="listKind" class="bgm-kind-select" :options="[...LIST_KIND_OPTIONS]" :disabled="listLoading" @update:model-value="doSearch()" />
            <input v-model="listTag" class="input bgm-tag-input" placeholder="情绪/场景标签" :disabled="listLoading" @keydown.enter="doSearch()" />
          </div>
          <div class="bgm-pick-rows">
            <div v-if="!listLoading && !listError && !listRows.length" class="bgm-pick-state">暂无音频，试试调整筛选条件。</div>
            <div
              v-for="it in listRows"
              v-else
              :key="it.mid"
              class="bgm-pick-row"
              :class="{ picked: bgmPickDlg.pickedMid === it.mid, playing: playingMid === it.mid }"
              :title="`${it.filename}\n分类: ${it.kindName}\n时长: ${it.durStr}\n大小: ${it.sizeStr}`"
              @click="bgmPickDlg.pickedMid = it.mid"
              @dblclick="playListRow(it)"
            >
              <span class="bgm-pick-name" :title="it.filename">{{ it.filename }}</span>
              <span class="vd-tag muted-tag">{{ it.kindName }}</span>
              <span class="bgm-pick-meta">{{ it.durStr }}</span>
              <span class="bgm-pick-meta">{{ it.sizeStr }}</span>
              <span class="bgm-pick-act" role="button" title="试听" @click.stop="playListRow(it)">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 3l14 9-14 9V3z" /></svg>
              </span>
            </div>
          </div>
          <div class="row">
            <span class="muted" :title="listError || listStat">{{ listError || (listLoading ? '加载中...' : `${listStat} · 单击选中，双击或 ▶ 试听`) }}</span>
            <span class="grow"></span>
            <TButton label="上一页" variant="secondary" size="small" :disabled="!canPrevPage || listLoading" @click="goPrevPage()" />
            <span class="muted">{{ pageLabel }}</span>
            <TButton label="下一页" variant="secondary" size="small" :disabled="!canNextPage || listLoading" @click="goNextPage()" />
            <label class="label">每页:</label>
            <input v-model.number="listPageSize" class="input bgm-page-input" type="number" min="10" max="200" step="10" :disabled="listLoading" @change="doSearch()" />
            <audio v-show="playingMid" ref="listAudioEl" controls class="bgm-pick-audio" />
          </div>
          </div><!-- /bgm-pick-left -->
          <!-- 2026-09-18 用户裁决：右栏 = AI 生成 BGM（自原内联面板移入；生成结果按弹窗目标回填） -->
          <div class="bgm-pick-right">
            <div class="bgm-pick-right-title">AI 生成 BGM</div>
            <div class="row">
              <label class="label">风格:</label>
              <TSelect v-model="bgmStyle" class="ag-style-select" :options="bgmStyleOptions" :disabled="bgmBusy" />
            </div>
            <div class="row">
              <label class="label">时长(秒):</label>
              <input v-model.number="bgmDuration" class="input ag-num-input" type="number" min="5" max="30" step="5" :disabled="bgmBusy" />
            </div>
            <div class="row">
              <label class="label">情绪:</label>
              <TSelect v-model="bgmMood" class="ag-tag-select" :options="bgmMoodOptions" :disabled="bgmBusy" />
            </div>
            <div class="row">
              <label class="label">场景:</label>
              <TSelect v-model="bgmScene" class="ag-tag-select" :options="bgmSceneOptions" :disabled="bgmBusy" />
            </div>
            <div class="row agb-gen-row">
              <TButton label="生成 BGM" :loading="bgmBusy" :disabled="bgmBusy" @click="generateBgm()" />
            </div>
            <p v-if="bgmResultLabel" class="agb-result">{{ bgmResultLabel }}</p>
            <div class="row">
              <TButton label="保存到 BGM 库" variant="secondary" size="small" :loading="bgmSaving" :disabled="!bgmUrl || bgmSaving" @click="saveBgmToLib" />
              <TButton label="打开位置" variant="secondary" size="small" :disabled="!bgmLocal" title="在资源管理器中打开生成的 BGM 本地文件（outputs/ai_audio）" @click="openBgmLocation" />
            </div>
            <audio v-if="agBgmAudioSrc" :src="agBgmAudioSrc" controls class="bgm-pick-right-audio" />
            <p class="bgm-pick-right-tip">生成后自动落盘；可直接点「确定」应用{{ bgmPickDlg.target ? '到当前视频行' : '为全局 BGM' }}，无需先保存到 BGM 库。</p>
          </div><!-- /bgm-pick-right -->
          </div><!-- /bgm-pick-cols -->
          <div v-if="bgmPickDlg.error" class="error-msg">⚠ {{ bgmPickDlg.error }}</div>
          <div class="modal-actions">
            <TButton label="取消" plain @click="bgmPickDlg.show = false" />
            <TButton label="确定" :loading="bgmPickDlg.busy" :disabled="(!bgmPickDlg.pickedMid && !bgmLocal) || bgmPickDlg.busy" @click="confirmBgmPick" />
          </div>
        </div>
      </div>
</template>

<style scoped>
.param-label { font-size: 13px; color: var(--foreground); white-space: nowrap; }
.pbar { height: 6px; border-radius: 3px; background: var(--surface-container); overflow: hidden; }
.pbar-inner {
  height: 100%; width: 32%; border-radius: 3px; background: var(--primary);
  animation: pbar-slide 1.2s ease-in-out infinite;
}
.card { display: flex; flex-direction: column; gap: var(--space-4); padding: var(--space-5); background: var(--card); border: 1px solid var(--border); border-radius: var(--radius-lg); }
/* 2026-09-05 用户裁决：全程序列表行间统一规范——页面内嵌密集列表 = 分隔线式（1px 横线），
   弹窗选择列表 = 卡片式（边框+圆角+空隙）；本页三处列表统一改分隔线式 */
.file-list { display: flex; flex-direction: column; list-style: none; margin: 0; padding: 0; font-size: 13px; }
.file-list li { display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); padding: 6px 10px; border-bottom: 1px solid var(--border); word-break: break-all; }
.file-list li:last-child { border-bottom: none; }
.file-list li.picked { background: color-mix(in srgb, var(--primary) 12%, transparent); }
.row { display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap; }
.row.between { justify-content: space-between; }
.row.right { justify-content: flex-end; }
.row.left { justify-content: flex-start; }
.label, .card-title { font-size: 13px; font-weight: 600; color: var(--foreground); }
.muted { color: var(--muted-foreground); font-size: 12px; }
.error-msg { color: var(--danger, #e74c3c); font-size: 12px; }
.input { height: 32px; padding: 0 10px; background: var(--card); border: 1px solid var(--border); border-radius: var(--radius-md); color: var(--foreground); outline: none; font-size: 13px; }
.input:focus { border-color: var(--primary); }
.input.grow { flex: 1; min-width: 120px; }
.w80 { width: 80px; }
.param-row .param-label { margin-left: var(--space-3); }
.param-row .param-label:first-child { margin-left: 0; }
.w90 { width: 90px; }
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
/* 参考文案（2026-09-11 用户裁决：单行 input 显示不全 → 两行高度，可纵向拉伸）。
   源序必须在 .input 之后（同特异性覆盖其 height:32px / padding:0 10px） */
.ref-text {
  height: auto; min-height: 52px; padding: 6px 10px;
  line-height: 1.5; font-family: inherit; resize: vertical;
}
.dropzone:hover, .dropzone.is-active { border-color: var(--primary); background: color-mix(in srgb, var(--primary) 12%, var(--surface-container)); }
.icon-btn {
  width: 28px; height: 24px; padding: 0; font-size: 13px; line-height: 1; flex: none;
  background: var(--card); color: var(--foreground);
  border: 1px solid var(--border); border-radius: var(--radius-sm); cursor: pointer;
}
.icon-btn:hover:not(:disabled) { border-color: var(--primary); }
.icon-btn:disabled { opacity: .4; cursor: not-allowed; }
.concat-status-line { font-size: 11px; color: var(--primary); margin: 4px 0 2px; }
.vd-tag { flex: none; font-size: 12px; }
.muted-tag { width: 48px; color: var(--muted-foreground); }
/* 2026-09-09 用户裁决：克隆按钮独立外框 + 配音设置分组（字幕/花字/配音按钮） */
.action-box {
  padding: var(--space-4); background: var(--surface-container);
  border: 1px solid var(--border); border-radius: var(--radius-md);
}
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
/* 还原 LUT：库内选择列表（2026-09-14） */
.lut-list { display: flex; flex-direction: column; gap: 4px; max-height: 132px; overflow-y: auto; }
</style>