<script setup lang="ts">
// ═══════════════════════════════════════════════════════════════
// VideoMontage.vue — 智能混剪·服务端四步向导（M8 条目⑥ UI 层）
// 四步（对照原客户端 gui/video_montage_page.py steps_text L257，严格一致）：
//   1.素材解析(镜头智能分割) → 2.AI 编排(镜头重组) → 3.口播配音 → 4.合成(特效包装)
// 链路全部走服务端：montage:split / montage:concat / montage:bgm
// 注：原客户端「卡点成片」属独立「一键成片」页（compile_video_page.py tab3，
//     BeatMontageController），不在智能混剪向导内，本端亦不纳入。
// 组件只绘制 + 事件转发；选段/载荷/轮询/下载业务全部在 useVideoMontage
// （纯函数 videoMontageLogic.ts，IRON-06/07 分层）。
// 闭环口径：提交 → 轮询 → 结果下载/打开目录 → 失败重试（重按按钮即重试）。
// ═══════════════════════════════════════════════════════════════
import { ref, computed } from 'vue'
import TButton from '@/components/common/TButton.vue'
import TSelect from '@/components/common/TSelect.vue'
import VideoPreview from '@/components/common/VideoPreview.vue'
import VideoPlayer from '@/components/common/VideoPlayer.vue'
import { useVideoMontage } from '@/composables/useVideoMontage'
import { BGM_STYLE_OPTIONS } from '@/composables/videoMontageLogic'

// 步骤条文案对照原客户端 gui/video_montage_page.py steps_text L257，严格一致
const STEPS = ['1. 镜头智能分割', '2. 镜头重组', '3. 口播配音', '4. 特效包装']
const step = ref(0)
function go(i: number) {
  step.value = Math.max(0, Math.min(STEPS.length - 1, i))
  // 第④步：待混音数量 stage 提示（_go_to_step index==3 L388-395 同口径）
  if (i === 3) void enterStep4()
}

const {
  // 共享
  polling, activeTaskId, statusText, cancelPolling,
  // Step1 素材解析（镜头智能分割）
  srcVideos, threshold, minSceneLen, imageDuration,
  scenes, scoreFilter, filteredScenes, checkedCount,
  splitBusy, splitError, splitMsg, splitResolution,
  selectFolder, onDrop, removeVideo, runSplit,
  updateSceneDesc, previewSourceVideo, previewScene, closePreview, clearSplitCache,
  previewUrl, openSplitsDir, splitsDownloading,
  // Step2 镜头重组
  assembleLogic, concatLayout, durationLimit, DURATION_LIMITS, batchCount, recBatchCount,
  concatTransition, edgeSpeedup, EDGE_SPEEDUP_OPTIONS, TRANSITIONS,
  concatBusy, confirmBusy, copyBusy, concatError,
  assemblePlans, currentPlanIdx, currentPlan, hasUnconfirmed, confirmedPaths,
  runConcat, planRowText, selectPlan,
  onDetailDragStart, onDetailDragEnd, onDetailDrop, toggleClipDeleted,
  confirmAllPrecompose, confirmPlanSingle,
  openProductDlg, productDlg, closeProductDlg, productDlgGenerate,
  copyViewDlg, viewPlanCopy, closeCopyView,
  planMenu, openPlanMenu, closePlanMenu,
  seqClips, seqIdx, seqSrc,
  onSeqEnded,
  concatResults,
  // Step3 口播配音（对照 step3_voice_view.py 逐控件）
  voiceDirInput, voiceRows,
  refSamples, selectedRefSample, refAudioPath, refText,
  ttsApiUrl, ttsSteps, ttsCfg, ttsSpeedMin, ttsSpeedMax,
  addSubtitles, subtitleFont, fontOptions, fontsLoading, refreshFonts,
  fancyEnabled, fancyStyle, fancyWordsInput, FANCY_STYLE_OPTIONS, AI_REWRITE_DESC,
  aiRewriteDlg, openRewriteSettings, closeRewriteSettings, saveRewriteSettings,
  editDlg, openEditDlg, saveEditDlg,
  dubbedDlg,
  voiceBusy, dubBusy, rewriteBusy, dubbingEnabled,
  selectVoiceDir, scanVoiceDir, uploadRefAudio, playRefAudio,
  batchAiRewrite, startSynthesizeVoice, startDubVideos,
  regenVoice, exportVoice, playVoice, playRowVideo, playDubbedVideo,
  toggleLengthMode, lengthModeTip,
  voiceStatusText, voiceStatusClass, pathBasename,
  // Step4 特效包装（对照 step4_final_view.py 逐控件）
  bgmPath, bgmName, bgmVolume, finalBusy, finalDone, finalProgress,
  finalVideoList, finalSelIdx, finalPreviewUrl, finalPreviewTitle,
  bgmSource, bgmGenPrompt, bgmGenStyle, bgmGenDuration,
  bgmGenBusy, bgmGenError, bgmGenUrl, bgmGenMeta, bgmPreviewUrl,
  bgmPlaying, bgmPosMs, bgmDurMs,
  generateBgm,
  pickBgm, toggleBgmPlay, stopBgmPlay, onBgmVolumeInput, seekBgm,
  enterStep4, startFinalMix, openFinalDir,
  exportJianyingDraft, exportAllToJianyingDraft, previewFinalVideo,
  fmtBgmTime,
  // 景别分类
  SHOT_TYPE_LABELS, SHOT_TYPE_COLORS,
} = useVideoMontage()

// 参考声音下拉（用户裁决 2026-09-03：声音样本从服务端取，GET /voice/samples 与 VoiceClone 页同源；
// 尾项保留本地上传；选中样本自动带出参考文案（selectSample 口径））
const refAudioOptions = computed(() => [
  ...refSamples.value.map((s) => ({ label: s.name, value: `sample:${s.id}` })),
  ...(refSamples.value.length ? [] : [{ label: '未找到预设声音样本', value: '' }]),
  { label: '选择本地文件...', value: '__upload__' },
])
function onRefAudioChange(v: string): void { selectRefAudio(v) }
/** 花字样式下拉（原版 fancy_style_combo 7 项） */
const fancyStyleOptions = FANCY_STYLE_OPTIONS

/** 配音结果弹窗行动作（DubbedVideosDialog） */
function playDubbed(path: string): void { try { window.tintin?.shell?.openItem?.(path) } catch (_) {} }
function locateDubbed(path: string): void { try { window.tintin?.shell?.revealInFolder?.(path) } catch (_) {} }
function openDubbedDir(): void {
  const d = dubbedDlg.value.outDir
  if (d) playDubbed(d)
}

/** AI 生成 style 下拉（原客户端 _build_tab_ai L1588-1594 同款 7 项，硬编码不拉接口） */
const bgmStyleOptions = [...BGM_STYLE_OPTIONS]

/** 输出画幅下拉（原版 layout_combo 3 项；首项动态附原片分辨率，L4800-4802 同口径） */
const LAYOUTS = computed(() => [
  { label: splitResolution.value ? `与原视频一致 (${splitResolution.value})` : '与原视频一致', value: 'source' },
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

function urlTail(u: string) { return String(u || '').split('/').pop() || u }

// ── Step1 素材列表删除（已改为行内按钮，原右键菜单已删除）──

/** 评分着色（原版 L1443-1448：≥8 绿 / ≥6 黄 / ≥0 红） */
function scoreClass(score: number): string {
  if (!score) return ''
  if (score >= 8) return 'score-high'
  if (score >= 6) return 'score-mid'
  return 'score-low'
}
</script>

<template>
  <div class="montage" style="display: flex; flex-direction: column; gap: var(--space-5);">

    <!-- 顶部步骤条（原版 step_labels 是 QLabel 不可点击，仅通过按钮切换；本端保留可点击但加门控：仅允许跳转到已完成或当前步骤） -->
    <div class="step-bar">
      <template v-for="(s, i) in STEPS" :key="s">
        <div class="step-pill" :class="{ active: step === i, done: step > i, disabled: i > step }" @click="i <= step && go(i)">
          <span class="step-dot" v-if="step > i">✓</span>{{ s }}
        </div>
        <span v-if="i < STEPS.length - 1" class="step-arrow">›</span>
      </template>
    </div>

    <!-- 共享任务状态条移至页尾（原版底部 stage_label + progress_bar 同位置） -->

    <!-- Step 1: 镜头智能分割（布局对照原版 gui/montage/step1_split_view.py L27-181） -->
    <template v-if="step === 0">
      <section class="card">
        <div class="dropzone" @click="selectFolder" @drop.prevent="onDrop" @dragover.prevent>
          <span class="dz-main">拖入素材文件夹（自动遍历子文件夹内全部视频） 或 点击选择文件夹</span>
          <span class="dz-hint">支持 mp4 / mov / avi / mkv / flv / webm / m4v，服务端完成分割与逐镜分析</span>
        </div>

        <span class="sec-label">已选择的原始视频素材 (双击可播放预览):</span>
        <ul class="file-list src-video-list">
          <li v-for="(v, i) in srcVideos" :key="v" :title="v">
            <video class="video-thumb" :src="v" preload="metadata" muted playsinline></video>
            <span class="video-path" @dblclick="previewSourceVideo(v)">{{ v }}</span>
            <button class="video-play-btn" title="播放" @click="previewSourceVideo(v)">▶</button>
            <button class="video-remove-btn" title="从素材列表移除" @click="removeVideo(i)">×</button>
          </li>
          <li v-if="!srcVideos.length" class="muted">暂无素材，拖入或点击上方区域选择</li>
        </ul>
        <div v-if="srcVideos.length" class="video-count-footer">选择视频共 {{ srcVideos.length }} 行</div>

        <!-- 参数行 + 行内右对齐「开始智能镜头分割」（原版 split_row 同布局） -->
        <div class="row">
          <label class="param-label">分割阈值 (10-100):</label>
          <input v-model.number="threshold" type="number" min="10" max="100" class="input w80" />
          <label class="param-label">最小镜头(秒):</label>
          <input v-model.number="minSceneLen" type="number" step="0.1" min="0.1" max="60" class="input w80" />
          <label class="param-label" title="无法分割的视频，自动挑出多长的精华片段">精华时长:</label>
          <input v-model.number="imageDuration" type="number" min="1" max="30"
            title="无法分割的视频，自动挑出多长的精华片段" class="input w80" />
          <span class="spacer"></span>
          <TButton label="开始智能镜头分割" icon="cut" :loading="splitBusy" @click="runSplit" />
        </div>
        <div v-if="splitMsg" class="hint">{{ splitMsg }}</div>
        <div v-if="splitError" class="error-msg">⚠ {{ splitError }}（修正后重按「开始智能镜头分割」重试）</div>
      </section>

      <section class="card">
        <div class="row between">
          <span class="sec-label">已分割出的最小单位镜头片段 (双击可播放预览，双击画面描述列可手动修改):</span>
          <label class="muted">评分过滤:
            <select v-model.number="scoreFilter" class="input" title="按评分筛选镜头：达到阈值的镜头才会作为选中素材带入下一步镜头重组">
              <option :value="0">不过滤</option>
              <option v-for="s in [1,2,3,4,5,6,7,8,9]" :key="s" :value="s">≥ {{ s }} 分</option>
            </select>
          </label>
        </div>
        <!-- 10 列对照原版 L127-128：勾选|序号|视频片段|景别|时长|画幅|主要画面|产品|型号|评分 -->
        <div class="tbl-scroll-wrap">
        <table class="tbl">
          <thead><tr>
            <th class="w32"></th><th>序号</th><th style="min-width:140px">视频片段</th><th>景别</th><th>时长</th>
            <th>画幅</th><th style="min-width:200px">主要画面</th><th>产品</th><th>型号</th><th>评分</th>
          </tr></thead>
          <tbody>
            <tr v-for="r in filteredScenes" :key="r.idx" @dblclick="previewScene(r)">
              <td><input v-model="r.checked" type="checkbox" @dblclick.stop /></td>
              <td class="ta-c">{{ r.idx }}</td>
              <td :title="r.clipUrl || r.name">{{ r.name }}</td>
              <td class="ta-c">
                <span v-if="r.shotType" class="shot-type-badge"
                  :style="{ color: SHOT_TYPE_COLORS[r.shotType] || '#888', borderColor: SHOT_TYPE_COLORS[r.shotType] || '#888' }">
                  {{ SHOT_TYPE_LABELS[r.shotType] || r.shotType }}
                </span>
                <span v-else class="muted">—</span>
              </td>
              <td class="ta-c">{{ r.duration > 0 ? r.duration.toFixed(1) + 's' : '—' }}</td>
              <td class="ta-c">{{ r.resolution || splitResolution || '—' }}</td>
              <td>
                <input class="input desc-input" :value="r.description" placeholder="—"
                  @dblclick.stop @change="updateSceneDesc(r.idx, ($event.target as HTMLInputElement).value)" />
              </td>
              <td>{{ r.product || '—' }}</td>
              <td>{{ r.model || '—' }}</td>
              <td class="ta-c" :class="scoreClass(r.score)">{{ r.score ? r.score.toFixed(1) : '—' }}</td>
            </tr>
            <tr v-if="!filteredScenes.length"><td colspan="10" class="muted">暂无已分割镜头，请先开始智能镜头分割</td></tr>
          </tbody>
        </table>
        </div>
      </section>

      <!-- 底部导航条（原版 step1 nav_row L161 顺序：打开已分割镜头目录 → 清空混剪缓存 → stretch → 下一步：镜头重组） -->
      <div class="row">
        <TButton label="打开已分割镜头目录" plain :loading="splitsDownloading" @click="openSplitsDir" />
        <TButton label="清空混剪缓存" plain title="清除本地混剪任务缓存（分割片段/成片输出目录），不会删除原始素材。" @click="clearSplitCache" />
        <span class="spacer"></span>
        <TButton label="下一步：镜头重组" icon="right" :disabled="!scenes.length" @click="go(1)" />
      </div>
    </template>

    <!-- Step 2: 镜头重组（布局逐控件对照原版 gui/montage/step2_concat_view.py setup_ui） -->
    <template v-else-if="step === 1">
      <section class="card">
        <!-- 参数设置组（原版 params_group：统一边框背景内两行参数） -->
        <div class="params-group">
          <!-- Parameters row 1（原版 L45-106：排列逻辑|输出画幅+原片画幅|时长限制|生成视频数量+推荐；混编随机度隐藏） -->
          <div class="param-row">
            <span class="param-label">排列逻辑:</span>
            <select v-model="assembleLogic" class="input w120" title="智能重排：镜头智能排列组合。">
              <option v-for="o in logicOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
            </select>
            <span class="param-label">输出画幅:</span>
            <select v-model="concatLayout" class="input w180">
              <option v-for="o in LAYOUTS" :key="o.value" :value="o.value">{{ o.label }}</option>
            </select>
            <span v-if="concatLayout === 'source'" class="src-res"
              title="分割片段检测到的原始画幅，选择'与原视频一致'时将使用此分辨率">
              原片: {{ splitResolution || '未知' }}</span>
            <span class="param-label">时长限制:</span>
            <select v-model.number="durationLimit" class="input w80" title="每个预合成视频的总时长上限（实际不超此值的 1.1 倍）">
              <option v-for="s in DURATION_LIMITS" :key="s" :value="s">{{ s }} 秒</option>
            </select>
            <span class="param-label">生成视频数量 (1-10):</span>
            <input v-model.number="batchCount" type="number" min="1" max="10" class="input w60" />
            <span class="hint">推荐: {{ recBatchCount }}</span>
          </div>
          <!-- Parameters row 2（原版 L109-140：转场动画 | 出入场加速） -->
          <div class="param-row">
            <span class="param-label">转场动画:</span>
            <select v-model="concatTransition" class="input w120" title="镜头之间的转场动画效果（剪映常用转场）">
              <option v-for="o in TRANSITIONS" :key="o.value" :value="o.value">{{ o.label }}</option>
            </select>
            <span class="param-label">出入场加速:</span>
            <select v-model.number="edgeSpeedup" class="input w90"
              title="识别为「入场/出场」景别的镜头按此倍速加速播放（中景/特写不受影响）。\n景别来自素材文件夹/文件名命名（入场、出场、中景、特写）；\n走服务端合成时生效；本地回退合成不支持加速；无景别标注的素材无效果。">
              <option v-for="o in EDGE_SPEEDUP_OPTIONS" :key="o.value" :value="o.value">{{ o.label }}</option>
            </select>
          </div>
        </div>

        <!-- 脚本工具栏（原版 L155-174：待排列镜头个数黄色粗体 + stretch + 镜头重组；
             原版「AI 生成文案」按钮 setVisible(False) 隐藏，不渲染） -->
        <div class="param-row">
          <span class="clip-count">待排列镜头个数: {{ filteredScenes.length }}  (已勾选: {{ checkedCount }})</span>
          <span class="spacer"></span>
          <TButton label="镜头重组" icon="video" :loading="concatBusy" @click="runConcat" />
        </div>
        <div v-if="concatError" class="error-msg">⚠ {{ concatError }}（修正后重按「镜头重组」重试）</div>

        <!-- 中间结果区（原版 result_box） -->
        <div class="result-box">
          <!-- 预合成视频列表：全宽，固定 10 行高度 -->
          <span class="sec-label">预合成视频列表 (双击播放预览，单击选中查看镜头):</span>
          <ul class="plan-list">
            <li v-for="(p, i) in assemblePlans" :key="i" :class="{ picked: currentPlanIdx === i }"
              :title="planRowText(i)" @click="selectPlan(i)" @dblclick="viewPlanCopy(i)"
              @contextmenu.prevent="openPlanMenu($event, i)">{{ planRowText(i) }}</li>
            <!-- 不足 10 行时占位，保持固定高度 -->
            <li v-for="n in Math.max(0, 10 - assemblePlans.length)" :key="'ph'+n" class="plan-placeholder"></li>
            <li v-if="!assemblePlans.length" class="muted">尚无预合成视频，勾选镜头后点击「镜头重组」</li>
          </ul>

          <!-- 下半区：左=分割镜头详情表（10行高度），右=视频预览（等高） -->
          <div class="result-bottom">
            <div class="detail-col">
              <span class="sec-label">视频组成镜头详情 (拖动把手调序，右键删除/恢复镜头):</span>
              <div class="detail-scroll-wrap">
                <table class="tbl detail-tbl">
                  <thead><tr>
                    <th class="w32">序号</th><th class="w32"></th><th style="min-width:120px">分割文件名</th>
                    <th>时长</th><th>景别</th><th style="min-width:180px">描述文案</th><th>评分</th>
                  </tr></thead>
                  <tbody v-if="currentPlan">
                    <tr v-for="(c, ri) in currentPlan.clips" :key="ri"
                      :class="{ 'row-deleted': currentPlan.deletedFlags[ri] }"
                      draggable="true"
                      @dragstart="onDetailDragStart(ri)" @dragend="onDetailDragEnd"
                      @drop.prevent="onDetailDrop(ri)" @dragover.prevent
                      @contextmenu.prevent="openDetailMenu($event, ri)">
                      <td class="ta-c">{{ ri + 1 }}</td>
                      <td class="ta-c grip-cell" title="拖动调序">⠿</td>
                      <td class="clip-name" :title="c.clipUrl || c.name">{{ c.name }}</td>
                      <td class="ta-c">{{ c.duration > 0 ? c.duration.toFixed(1) + 's' : '—' }}</td>
                      <td class="ta-c">
                        <span v-if="c.shotType" class="shot-type-badge"
                          :style="{ color: SHOT_TYPE_COLORS[c.shotType] || '#888', borderColor: SHOT_TYPE_COLORS[c.shotType] || '#888' }">
                          {{ SHOT_TYPE_LABELS[c.shotType] || c.shotType }}
                        </span>
                        <span v-else class="muted">—</span>
                      </td>
                      <td class="clip-desc" :title="c.description">{{ c.description || '—' }}</td>
                      <td class="ta-c" :class="scoreClass(c.score)">{{ c.score ? c.score.toFixed(1) : '—' }}</td>
                    </tr>
                    <!-- 不足 10 行时占位 -->
                    <tr v-for="n in Math.max(0, 10 - (currentPlan?.clips.length || 0))" :key="'dph'+n" class="detail-placeholder-row"><td colspan="7"></td></tr>
                  </tbody>
                  <tbody v-else>
                    <tr><td colspan="7" class="muted">单击上方预合成项查看镜头详情</td></tr>
                  </tbody>
                </table>
              </div>
            </div>
            <div class="player-col">
              <span class="sec-label">视频播放预览:</span>
              <div class="player-wrap">
                <VideoPlayer v-if="seqSrc" :src="seqSrc" autoplay class="player-video" @ended="onSeqEnded" />
                <div v-else class="player-empty">单击预合成项预览序列</div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <!-- 确认行（原版 confirm_row L268-286：确认合成视频 + 生成口播文案，初始禁用） -->
      <div class="row confirm-row">
        <TButton label="确认合成视频" :loading="confirmBusy" :disabled="!hasUnconfirmed" @click="confirmAllPrecompose" />
        <TButton label="生成口播文案" variant="secondary" :loading="copyBusy" :disabled="!confirmedPaths.length" @click="openProductDlg('all')" />
      </div>

      <!-- 导航行（原版 nav_row L288-301：上一步：镜头分割 / 下一步：克隆口播） -->
      <div class="row between">
        <TButton label="上一步：镜头分割" plain @click="go(0)" />
        <TButton label="下一步：克隆口播" icon="right" :disabled="!confirmedPaths.length" @click="go(2)" />
      </div>
    </template>

    <!-- Step 3: 口播配音（对照 gui/montage/step3_voice_view.py L27-298 逐控件一比一） -->
    <template v-else-if="step === 2">
      <section class="card">
        <!-- 1. 视频输入目录行（L40-49） -->
        <div class="row">
          <label class="label">视频输入目录:</label>
          <input v-model="voiceDirInput" class="input grow" placeholder="选择包含排列视频的目录..." @change="scanVoiceDir" />
          <TButton label="选择目录" variant="secondary" @click="selectVoiceDir" />
        </div>

        <!-- 2a. 参考声音行（L65-93 控件结构；声音样本数据源 = 服务端 GET /voice/samples，用户裁决 2026-09-03） -->
        <div class="row">
          <label class="label">参考声音:</label>
          <TSelect :model-value="selectedRefSample ? `sample:${selectedRefSample.id}` : refAudioPath" :options="refAudioOptions" class="grow" @update:model-value="onRefAudioChange" />
          <button class="icon-btn" title="播放人声样本" :disabled="!refAudioPath && !selectedRefSample?.url" @click="playRefAudio">🔊</button>
          <TButton label="上传声音" variant="secondary" title="上传本地音频文件作为参考声音 (wav/mp3/m4a)" @click="uploadRefAudio" />
        </div>

        <!-- 2b. 参考文案行（L95-112） -->
        <div class="row">
          <label class="label">参考文案:</label>
          <input v-model="refText" class="input grow" placeholder="可选，填入样本台词..." />
        </div>

        <!-- 3. TTS API 与推理参数行（L114-175；inference_timesteps/cfg 存而不用，控件保留、值不随请求发送） -->
        <div class="row">
          <label class="label">TTS API:</label>
          <input v-model="ttsApiUrl" class="input grow" placeholder="跟随系统设置 → VoxCPM/TTS 地址（形如 http://<服务端>:8000/voxcpm/tts）" />
          <label class="param-label">推理步数:</label>
          <input v-model.number="ttsSteps" type="number" class="input w60" min="4" max="50" step="5"
            title="VoxCPM 推理步数（4-30，默认10）&#10;步数越多音质越细腻，但速度越慢&#10;推荐：快速=10，高质量=20-30" />
          <label class="param-label">CFG:</label>
          <input v-model.number="ttsCfg" type="number" class="input w60" min="0.5" max="5.0" step="0.5"
            title="引导强度（0.5-5.0，默认2.0）&#10;越高越贴近参考音色但可能过拟合&#10;推荐范围：1.5 - 3.0" />
          <label class="param-label">速率:</label>
          <input v-model.number="ttsSpeedMin" type="number" class="input w60" min="0.5" max="1.0" step="0.05"
            title="变速下限（默认0.90）&#10;音频比视频长时最多允许拉慢到此倍速&#10;超出范围时不再强制调速，保留自然音质" />
          <label class="param-label">~</label>
          <input v-model.number="ttsSpeedMax" type="number" class="input w60" min="1.0" max="2.0" step="0.05"
            title="变速上限（默认1.20）&#10;音频比视频短时最多允许加速到此倍速&#10;超出范围时不再强制调速，保留自然音质" />
        </div>

        <!-- 4. 表格标题行（L177-196） -->
        <div class="row between">
          <span class="card-title"> 待合成视频列表与配音文案映射 (在配音文案栏直接输入):</span>
          <div class="row">
            <TButton label="文案生成设置" variant="secondary" size="small" @click="openRewriteSettings" />
            <TButton label="一键AI修改全部文案" size="small" :loading="rewriteBusy" @click="batchAiRewrite" />
          </div>
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
                  <!-- 行 1：文件名 + 播放视频（配音后优先） + 状态 + 操作 -->
                  <div class="vd-top">
                    <span class="vd-name" :title="row.path">视频: {{ row.name }}</span>
                    <button class="icon-btn" title="播放视频（配音后优先）" @click="playRowVideo(i)">▶</button>
                    <span class="spacer"></span>
                    <span v-if="row.status === 'generating'" class="vd-progress-text">{{ row.progress }}%</span>
                    <span class="vd-status" :class="voiceStatusClass(row)">{{ voiceStatusText(row) }}</span>
                    <button class="icon-btn" title="播放克隆的声音" :disabled="!row.wavPath" @click="playVoice(i)">🔊</button>
                    <button class="icon-btn" title="导出该克隆声音" :disabled="!row.wavPath" @click="exportVoice(i)">💾</button>
                    <button class="icon-btn" title="对比与编辑文案" @click="openEditDlg(i)">⚖</button>
                    <button class="icon-btn" title="仅重新生成该声音" :disabled="row.status === 'generating'" @click="regenVoice(i)">↻</button>
                    <button class="icon-btn" :title="lengthModeTip(row)" @click="toggleLengthMode(i)">{{ row.lengthMode === 'video' ? '🎬' : '🎵' }}</button>
                    <button class="icon-btn" :title="row.dubbedPath ? '播放配音后的视频' : '尚未生成配音视频'" :disabled="!row.dubbedPath" @click="playDubbedVideo(i)">📽</button>
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
        <div v-else class="muted">尚未选择视频，在上方输入目录或点击「选择目录」后自动扫描</div>

        <!-- 6. 烧制字幕行（L210-237） -->
        <div class="row">
          <label class="chk" title="字幕字体取自服务端字体库（GET /config/fonts）。&#10;走服务端合成时，会把 font_id / fontname / burn_subtitle 一并提交给服务端烧制；&#10;服务端尚未支持该参数时，回退到本地 ffmpeg 烧制（按同名解析本机已装字体）。">
            <input v-model="addSubtitles" type="checkbox" />
            烧制字幕（逐行按时间显示，字号随视频高度自适应，白色 50% 透明背景）
          </label>
          <label class="param-label">字幕字体:</label>
          <TSelect v-model="subtitleFont" :options="fontOptions" class="w230" title="字体列表来自服务端 /config/fonts，可输入关键字过滤" />
          <TButton label="刷新字体" variant="secondary" size="small" :loading="fontsLoading" title="重新从服务端拉取字体列表" @click="refreshFonts" />
        </div>

        <!-- 7. 花字行（L239-265） -->
        <div class="row">
          <label class="chk" title="在视频画面中央叠加花字特效文字，用于突出关键卖点/价格/型号等信息">
            <input v-model="fancyEnabled" type="checkbox" />
            添加花字 (关键信息加重提醒)
          </label>
          <label class="param-label">样式:</label>
          <TSelect v-model="fancyStyle" :options="fancyStyleOptions" class="w110" />
          <label class="param-label">花字内容:</label>
          <input v-model="fancyWordsInput" class="input grow" placeholder="输入要叠加的花字内容，多行用逗号分隔（按镜头顺序轮换）"
            title="多个花字用逗号分隔，会按镜头顺序轮换显示。如：超轻量化,8000DPI,续航70小时" />
        </div>

        <!-- 8. 动作行（L267-281；配音按钮初始禁用，L279） -->
        <div class="row voice-actions">
          <TButton label="开始批量克隆人声合成" :loading="voiceBusy" @click="startSynthesizeVoice" />
          <TButton label="开始给视频配音 (替换原声)" :loading="dubBusy" :disabled="!dubbingEnabled" @click="startDubVideos" />
        </div>
      </section>

      <!-- 导航行（L284-297；btn_next_to_step_4.setEnabled(True) 需有配音视频） -->
      <div class="row between">
        <TButton label="上一步：镜头重组" plain @click="go(1)" />
        <TButton label="下一步：特效包装" icon="right" :disabled="!voiceRows.some(r => r.dubbedPath)" @click="go(3)" />
      </div>
    </template>

    <!-- Step 4: 特效包装（step4_final_view.py L14-196 逐控件；另保留本端 AI 生成 BGM） -->
    <template v-else>
      <section class="card">
        <!-- 1. BGM input -->
        <div class="row">
          <label class="label"> 背景音乐 (BGM):</label>
          <input :value="bgmPath" placeholder="选择混剪背景音乐 (mp3/wav)，选空则无BGM..." readonly class="input grow" @click="pickBgm" />
          <TButton label="选择背景音乐" size="small" variant="secondary" @click="pickBgm" />
          <!-- 本端保留功能：AI 生成 BGM（生成后主进程下载落盘，走同一本地混音链路） -->
          <TButton label="AI 生成 BGM" size="small" :variant="bgmSource === 'ai' ? 'primary' : 'secondary'" @click="bgmSource = bgmSource === 'ai' ? 'local' : 'ai'" />
        </div>
        <div v-if="bgmSource === 'ai'" class="ai-bgm-panel">
          <div class="row">
            <label class="label">描述:</label>
            <input
              v-model="bgmGenPrompt"
              placeholder="描述你想要的 BGM，如：激昂的电子音乐，适合科技感视频"
              class="input grow"
              @keyup.enter="generateBgm"
            />
          </div>
          <div class="row">
            <label class="label">风格:</label>
            <TSelect v-model="bgmGenStyle" :options="bgmStyleOptions" />
            <label class="label">时长 <span class="muted">({{ bgmGenDuration }} 秒，3-60)</span></label>
            <input v-model.number="bgmGenDuration" type="range" min="3" max="60" step="1" class="grow" />
            <TButton label="生成 BGM" icon="play" :loading="bgmGenBusy" @click="generateBgm" />
          </div>
          <div class="row">
            <span class="muted">POST /audio/gen/bgm（MusicGen-small，生成约需 30-60 秒；生成后自动下载落盘供混音/剪映导出）</span>
          </div>
          <div v-if="bgmGenError" class="error-msg">⚠ {{ bgmGenError }}（修正后重按「生成 BGM」重试）</div>
          <div v-if="bgmGenUrl" class="row">
            <audio controls :src="bgmPreviewUrl" class="grow" />
            <span class="muted" style="white-space: nowrap">{{ bgmGenMeta }}</span>
          </div>
          <div v-else-if="bgmGenBusy" class="row">
            <span class="muted">AI 正在生成 BGM（约需 30-60 秒，请稍候）…</span>
          </div>
        </div>

        <!-- BGM 增益（0-200%，100%=原音量；拖动实时改变试听音量） -->
        <div class="row">
          <label class="label"> BGM 增益 (0-200%, 100%=原音量):</label>
          <input v-model.number="bgmVolume" type="range" min="0" max="200" step="1" class="vd4-gain" @input="onBgmVolumeInput" />
          <span class="vd4-gain-label">{{ bgmVolume }} %</span>
        </div>

        <!-- BGM 试听播放器：播放/暂停 ⏹ + 进度条 + 时间标签 -->
        <div class="row vd4-player">
          <button class="icon-btn vd4-pbtn" :title="bgmPlaying ? '暂停' : '播放/暂停'" @click="toggleBgmPlay">{{ bgmPlaying ? '⏸' : '▶' }}</button>
          <button class="icon-btn vd4-pbtn" title="停止播放" :disabled="!bgmPlaying" @click="stopBgmPlay">⏹</button>
          <input class="vd4-seek grow" type="range" min="0" :max="bgmDurMs" step="1" :value="bgmPosMs" @input="seekBgm" />
          <span class="vd4-time">{{ fmtBgmTime(bgmPosMs) }} / {{ fmtBgmTime(bgmDurMs) }}</span>
        </div>

        <!-- 开始混音合成（action_button 高 40 全宽） -->
        <TButton label="开始混音合成" class="vd4-run" :loading="finalBusy" @click="startFinalMix" />
        <div v-if="finalBusy" class="pbar"><div class="pbar-inner" :style="{ width: finalProgress + '%' }"></div></div>

        <!-- 结果区：左 成片列表 + 三按钮；右 视频预览 -->
        <div class="vd4-result">
          <div class="vd4-left">
            <div class="vd4-left-title">最终合成生成的视频文件:</div>
            <ul class="file-list vd4-list">
              <li
                v-for="(it, i) in finalVideoList" :key="i"
                :class="{ picked: finalSelIdx === i }"
                @click="finalSelIdx = i"
                @dblclick="previewFinalVideo(i)"
              >{{ it.name }}</li>
              <li v-if="!finalVideoList.length" class="muted">暂无成片，点击「开始混音合成」后此处展示结果</li>
            </ul>
            <div class="vd4-btns">
              <TButton label="打开视频输出目录" variant="secondary" :disabled="!finalDone" class="grow" @click="openFinalDir" />
              <TButton label="一键导出到剪映草稿" variant="primary" :disabled="!finalDone" class="grow" @click="exportJianyingDraft" />
              <TButton label="导出全部到时间轴(带转场)" variant="secondary" :disabled="!finalDone" class="grow"
                title="将合成列表中的所有视频按顺序导出为一条剪映时间轴，片段之间自动添加所选转场，每个片段携带各自字幕"
                @click="exportAllToJianyingDraft" />
            </div>
          </div>
          <div class="vd4-right">
            <div class="vd4-preview-title">{{ finalPreviewTitle }}</div>
            <VideoPlayer v-if="finalPreviewUrl" :src="finalPreviewUrl" autoplay class="vd4-video" />
            <div v-else class="vd4-video vd4-video-empty"></div>
          </div>
        </div>
      </section>

      <!-- 导航行（原版 Step4 仅「上一步：克隆人声」，文案逐字 L190） -->
      <div class="row left">
        <TButton label="上一步：克隆人声" plain @click="go(2)" />
      </div>
    </template>

    <!-- 页尾状态区（原版底部共享：stage_label + progress_bar） -->
    <div v-if="polling || statusText" class="bottom-status">
      <div class="bottom-status-row">
        <span class="status-text" :class="{ spinning: polling }">{{ statusText }}</span>
        <span v-if="activeTaskId" class="muted">任务 {{ activeTaskId }}</span>
        <TButton v-if="polling" label="取消等待" size="small" plain @click="cancelPolling" />
      </div>
      <div v-if="polling" class="pbar"><div class="pbar-inner"></div></div>
    </div>

    <!-- 镜头片段预览弹层（内置 Plyr 播放器，支持本地路径 + 服务端 URL） -->
    <VideoPreview :visible="!!previewUrl" :src="previewUrl" @close="closePreview" @ended="onSeqEnded" />

    <!-- 预合成列表右键菜单（原版 _show_assembled_context_menu L5412-5434 三项，查看文案仅已生成时显示） -->
    <teleport to="body">
      <div v-if="planMenu.show" class="ctx-mask" @click="closePlanMenu" @contextmenu.prevent="closePlanMenu">
        <div class="ctx-menu" :style="{ left: planMenu.x + 'px', top: planMenu.y + 'px' }" @click.stop>
          <button class="ctx-item" @click="planMenuConfirm">完成： 确认合成视频</button>
          <button class="ctx-item" @click="planMenuGen"> 生成口播文案</button>
          <button v-if="planMenu.hasCopy" class="ctx-item" @click="planMenuView"> 查看文案</button>
        </div>
      </div>
    </teleport>

    <!-- 镜头详情右键菜单（原版 _on_source_context_menu L5843-5851） -->
    <teleport to="body">
      <div v-if="detailMenu.show" class="ctx-mask" @click="closeDetailMenu" @contextmenu.prevent="closeDetailMenu">
        <div class="ctx-menu" :style="{ left: detailMenu.x + 'px', top: detailMenu.y + 'px' }" @click.stop>
          <button v-if="detailMenu.deleted" class="ctx-item" @click="menuToggleDeleted">↩ 恢复镜头</button>
          <button v-else class="ctx-item" @click="menuToggleDeleted"> 标记删除（不参与合成和预览）</button>
        </div>
      </div>
    </teleport>

    <!-- 产品信息弹窗（原版 ProductCopyInputDialog，dialogs.py L347-388 文案逐字） -->
    <teleport to="body">
      <div v-if="productDlg.show" class="modal-mask" @click.self="closeProductDlg">
        <div class="modal">
          <span class="modal-title"> 生成口播文案</span>
          <span class="hint">输入产品信息，由大模型生成该组合视频的口播文案：</span>
          <div class="modal-field"><label>品牌:</label><input v-model="productDlg.brand" class="input grow" placeholder="如 罗技 / Logitech" /></div>
          <div class="modal-field"><label>产品:</label><input v-model="productDlg.product" class="input grow" placeholder="如 鼠标 / 键盘 / 无线耳机" /></div>
          <div class="modal-field"><label>型号:</label><input v-model="productDlg.model" class="input grow" placeholder="如 G502 / MX Master 3S" /></div>
          <div class="modal-field modal-extra"><label>补充卖点（可选）:</label>
            <textarea v-model="productDlg.extra" class="modal-textarea" placeholder="如 8K回报率、轻量化、长续航……（可留空）"></textarea>
          </div>
          <div class="modal-actions">
            <TButton label="生成" :loading="copyBusy" @click="productDlgGenerate" />
            <TButton label="取消" plain @click="closeProductDlg" />
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
      <div v-if="aiRewriteDlg.show" class="modal-mask" @click.self="closeRewriteSettings">
        <div class="modal">
          <span class="modal-title">文案生成设置</span>
          <span class="rw-title">文案生成自由度设置</span>
          <span class="rw-desc">{{ AI_REWRITE_DESC }}</span>
          <div class="row">
            <span class="muted">0%</span>
            <input v-model.number="aiRewriteDlg.pct" type="range" min="0" max="100" step="1" class="grow" />
            <span class="muted">100%</span>
          </div>
          <span class="rw-value">当前: {{ aiRewriteDlg.pct }}%</span>
          <div class="modal-actions">
            <TButton label="取消" plain @click="closeRewriteSettings" />
            <TButton label="保存" @click="saveRewriteSettings" />
          </div>
        </div>
      </div>
    </teleport>

    <!-- 配音文案编辑弹窗（原版 TextEditDialog，dialogs.py L31-80 文案逐字；⚖ 对比按钮同入口附原文对照） -->
    <teleport to="body">
      <div v-if="editDlg.show" class="modal-mask" @click.self="editDlg.show = false">
        <div class="modal modal-wide">
          <span class="modal-title">{{ editDlg.title }}</span>
          <span class="hint">配音文案编辑:</span>
          <div v-if="editDlg.original" class="edit-orig">
            <span class="vd-tag muted-tag">原文:</span>
            <span class="vd-orig">{{ editDlg.original }}</span>
          </div>
          <textarea v-model="editDlg.content" class="modal-textarea modal-copy"></textarea>
          <div class="modal-actions">
            <TButton label="确定" @click="saveEditDlg" />
            <TButton label="取消" plain @click="editDlg.show = false" />
          </div>
        </div>
      </div>
    </teleport>

    <!-- 配音完成弹窗（原版 DubbedVideosDialog，dialogs.py L167-231 文案逐字） -->
    <teleport to="body">
      <div v-if="dubbedDlg.show" class="modal-mask" @click.self="dubbedDlg.show = false">
        <div class="modal modal-wide">
          <span class="modal-title"> 配音替换完成</span>
          <span class="dub-header">所有视频配音替换完毕！已成功为您生成以下配音文件：</span>
          <div v-if="dubbedDlg.outDir" class="dub-dir">
            <b>保存目录：</b><span class="dub-dir-path">{{ dubbedDlg.outDir }}</span>
          </div>
          <div class="dub-list">
            <div v-for="it in dubbedDlg.items" :key="it.dubbedPath" class="dub-item"
              :title="`原视频: ${it.videoPath}\n配音视频: ${it.dubbedPath}`">
              <span class="dub-name">{{ it.name }}</span>
              <TButton label="播放视频" size="small" @click="playDubbed(it.dubbedPath)" />
              <TButton label="打开所在目录" size="small" @click="locateDubbed(it.dubbedPath)" />
            </div>
          </div>
          <div class="modal-actions">
            <TButton label="打开整体输出文件夹" plain @click="openDubbedDir" />
            <TButton label="确认并返回" @click="dubbedDlg.show = false" />
          </div>
        </div>
      </div>
    </teleport>
  </div>
</template>

<style scoped>
.step-bar { display: flex; align-items: center; gap: var(--space-2); padding: 6px 12px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-lg); }
.step-pill { flex: 1; padding: 4px 0; border-radius: var(--radius-sm); font-size: 13px; color: var(--muted-foreground); cursor: pointer; text-align: center; transition: background var(--duration-fast), color var(--duration-fast); }
.step-pill.disabled { cursor: not-allowed; opacity: .5; }
.step-pill.active { background: rgba(96, 165, 250, 0.12); color: var(--info, #60a5fa); font-weight: 700; padding: 4px 8px; }
.step-pill.done { background: rgba(52, 211, 153, 0.1); color: var(--success); padding: 4px 8px; }
.step-dot { margin-right: 4px; font-weight: 700; }
.step-arrow { color: rgba(255, 255, 255, 0.2); font-weight: bold; }

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
.dropzone { display: flex; flex-direction: column; gap: 4px; padding: var(--space-5); background: color-mix(in srgb, var(--primary) 6%, var(--surface-container)); border: 1.5px dashed color-mix(in srgb, var(--primary) 40%, var(--border)); border-radius: var(--radius-lg); cursor: pointer; color: var(--foreground); transition: border-color var(--duration-fast), background var(--duration-fast); }
.dropzone:hover { border-color: var(--primary); background: color-mix(in srgb, var(--primary) 12%, var(--surface-container)); }
.dz-main { font-size: var(--font-size-body); font-weight: var(--font-weight-medium); }
.dz-hint { font-size: var(--font-size-caption); color: var(--muted-foreground); }

.file-list { display: flex; flex-direction: column; gap: 6px; list-style: none; margin: 0; padding: 0; font-size: 13px; }
.file-list li { display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); padding: 6px 10px; background: var(--surface-container); border: 1px solid var(--border); border-radius: var(--radius-md); word-break: break-all; }
.file-list li.picked { border-color: var(--primary); }
/* Step1 素材列表（缩略图 + 路径 + 播放/删除按钮） */
.src-video-list { max-height: 480px; overflow-y: auto; }
.src-video-list li { padding: 4px 8px; }
.video-thumb { width: 60px; height: 40px; object-fit: cover; border-radius: var(--radius-sm); background: #000; flex: none; }
.video-path { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: pointer; }
.video-play-btn { width: 24px; height: 24px; padding: 0; font-size: 12px; line-height: 1; flex: none; background: transparent; color: var(--muted-foreground); border: 1px solid var(--border); border-radius: var(--radius-sm); cursor: pointer; margin-right: 4px; }
.video-play-btn:hover { color: var(--success); border-color: var(--success); }
.video-remove-btn { width: 24px; height: 24px; padding: 0; font-size: 16px; line-height: 1; flex: none; background: transparent; color: var(--muted-foreground); border: 1px solid var(--border); border-radius: var(--radius-sm); cursor: pointer; }
.video-remove-btn:hover { color: var(--danger); border-color: var(--danger); }
.video-count { justify-content: center; color: var(--muted-foreground); font-size: 12px; padding: 4px 10px; background: transparent; border: none; }
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
.w60 { width: 60px; } .w90 { width: 90px; } .w120 { width: 120px; } .w180 { width: 180px; }
.clip-count { font-weight: 700; font-size: 14px; color: var(--warning); }
.result-box {
  display: flex; flex-direction: column; gap: 10px; padding: 10px;
  background: var(--surface-container); border: 1px dashed var(--border); border-radius: var(--radius-md);
}
/* 预合成列表：固定 10 行高度（每行 ~30px + 4px gap），不足占位，多余滚动 */
.plan-list {
  display: flex; flex-direction: column; gap: 4px; list-style: none; margin: 0; padding: 0;
  height: 336px; /* 10 行 × (26px 内容 + 4px gap) */
  overflow-y: auto; font-size: 13px;
}
.plan-list li {
  padding: 5px 10px; background: var(--card); border: 1px solid var(--border); border-radius: var(--radius-sm);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: pointer; flex: none;
}
.plan-list li.picked { border-color: var(--primary); }
.plan-list li.plan-placeholder {
  visibility: hidden; pointer-events: none; border-color: transparent; background: transparent;
}
/* 下半区：左=分割镜头详情表（10行高度），右=视频预览（等高） */
.result-bottom { display: flex; gap: 15px; align-items: flex-start; }
.detail-col { flex: 3; min-width: 0; display: flex; flex-direction: column; gap: 6px; }
/* 详情表滚动容器：固定 10 行高度（表头 ~30px + 10 行 × 30px + 2px 边框补偿） */
.detail-scroll-wrap {
  max-height: 332px; overflow-y: auto; border: 1px solid var(--border); border-radius: var(--radius-sm);
}
.detail-scroll-wrap .tbl { border-radius: 0; }
.detail-placeholder-row td { height: 30px; border-bottom: 1px solid var(--border); }
/* 右侧播放器（高度匹配左侧详情表 10 行） */
.player-col { flex: 2; min-width: 220px; display: flex; flex-direction: column; gap: 6px; }
.player-wrap {
  height: 332px; background: #000; border: 1px solid var(--border); border-radius: var(--radius-md);
  display: flex; align-items: center; justify-content: center; overflow: hidden;
}
.player-video { width: 100%; height: 100%; object-fit: contain; }
.player-empty { color: var(--muted-foreground); font-size: 12px; }
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
.voice-table { margin-top: var(--space-3); }
.voice-table .w-idx { width: 48px; }
.vd-detail { display: flex; flex-direction: column; gap: 6px; }
.vd-top { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
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
.vd-progress { width: 100%; height: 6px; appearance: none; border-radius: 3px; overflow: hidden; }
.vd-progress::-webkit-progress-bar { background: var(--surface-container); }
.vd-progress::-webkit-progress-value { background: var(--primary); transition: width 0.3s; }
.voice-actions > :first-child { flex: 2; }
.voice-actions > :last-child { flex: 3; }
.chk {
  display: flex; align-items: center; gap: 6px; cursor: pointer;
  font-size: 13px; font-weight: 600; color: var(--foreground);
}
.chk input { accent-color: var(--primary); }
.w230 { width: 230px; }
.w110 { width: 110px; }

/* 文案生成设置弹窗 */
.rw-title { font-size: 13px; color: var(--foreground); }
.rw-desc { font-size: 12px; color: var(--muted-foreground); white-space: pre-line; }
.rw-value { font-size: 14px; font-weight: 700; color: var(--primary); text-align: center; }

/* 配音文案编辑弹窗原文对照 */
.edit-orig { display: flex; align-items: flex-start; gap: 6px; }
.edit-orig .vd-orig { white-space: pre-wrap; max-height: 72px; overflow-y: auto; }

/* 配音完成弹窗（原版 header 绿色 + 目录蓝色链接色） */
.dub-header { font-size: 14px; font-weight: 700; color: var(--success); }
.dub-dir { font-size: 12px; color: var(--foreground); word-break: break-all; }
.dub-dir-path { color: var(--primary); }
.dub-list { display: flex; flex-direction: column; gap: 6px; max-height: 260px; overflow-y: auto; }
.dub-item {
  display: flex; align-items: center; gap: 10px; padding: 6px 10px;
  background: var(--surface-container); border: 1px solid var(--border); border-radius: var(--radius-md);
}
.dub-name {
  flex: 1; min-width: 0; font-size: 13px; font-weight: 700;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}

/* Step4 AI 生成 BGM 面板 */
.ai-bgm-panel {
  display: flex; flex-direction: column; gap: var(--space-3);
  padding: var(--space-4); background: var(--surface-container);
  border: 1px solid var(--border); border-radius: var(--radius-md);
}
.ai-bgm-panel audio { flex: 1; min-width: 200px; height: 36px; }

/* Step4 特效包装（对照 step4_final_view.py L80-196 同布局；颜色走 V3 design tokens） */
.vd4-gain { width: 200px; flex: none; accent-color: var(--primary); }
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
/* 结果区（原版 result_box：rgba(255,255,255,0.03) + border rgba(255,255,255,0.1)，L116 → token 化） */
.vd4-result {
  display: flex; gap: 15px; padding: 10px; margin-top: var(--space-2);
  background: var(--surface-container); border: 1px solid var(--border); border-radius: 4px;
}
.vd4-left { flex: 3; min-width: 0; display: flex; flex-direction: column; gap: 8px; }
.vd4-left-title { font-size: 13px; font-weight: 600; color: var(--foreground); }
.vd4-list { max-height: 150px; overflow-y: auto; }
.vd4-btns { display: flex; gap: 8px; }
.vd4-btns > .t-button { flex: 1; padding: 0 6px; }
/* 右预览（原版 #000000 + border #27272a，L161-167 → token 化） */
.vd4-right {
  flex: 2; min-width: 220px; display: flex; flex-direction: column; gap: 6px;
  background: #000; border: 1px solid var(--border); border-radius: var(--radius-md); padding: 6px;
}
.vd4-preview-title { font-size: 11px; font-weight: bold; color: var(--muted-foreground); }
.vd4-video {
  width: 100%; min-height: 150px; flex: 1; object-fit: contain;
  border-radius: var(--radius-sm); background: #000;
}
.vd4-video-empty { min-height: 150px; }

/* 状态标签样式 */
.st-pending { color: var(--muted-foreground); font-size: 12px; }
.st-running { color: var(--primary); font-size: 12px; font-weight: 600; }
.st-done { color: var(--success); font-size: 12px; font-weight: 600; }
.st-failed { color: var(--danger, #e74c3c); font-size: 12px; font-weight: 600; }
</style>
