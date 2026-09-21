<script setup lang="ts">
// ═══════════════════════════════════════════════════════════════
// CopyStep2Panel.vue — 智能混剪 Step2 镜头重组面板（铁律 10 Phase3 P2，2026-09-19）
// 模板/样式自 VideoMontage.vue 逐字搬迁；状态经 inject 解构回原名（零改动）。
// 本面板本地逻辑：右栏预览 computed、排列/时长/画幅下拉选项、方案与镜头详情
// 右键菜单、口播弹窗产品选择（WbPickProductPanel）、scoreClass（Step1/2 各持一份）。
// 注：toAbsolute 在面板内以原名解构，模板沿用原别名 vdToAbsolute（与 Shell 等价）。
// ═══════════════════════════════════════════════════════════════
import { ref, reactive, computed, watch, inject, onUnmounted } from 'vue'
import TButton from '@/components/common/TButton.vue'
import TSelect from '@/components/common/TSelect.vue'
import WbPickProductPanel from '@/components/workbench/WbPickProductPanel.vue'
import VdStepBar from '../VdStepBar.vue'
import { markdownListLines, stripProductCodeFromModel, parseProductKeywords } from '@/composables/opsProductLibraryLogic'
import { copyPreviewText, SHOT_TYPE_COLORS, SHOT_TYPE_LABELS, buildAssignPool } from '@/composables/copyMontageLogic'
import { buildAssignCandidateSet, buildAssignMatchPrompt, parseAssignMatchResponse, mergeTabAssignment } from '@/composables/copyMontageAssignLogic'
import { errText } from '@/composables/copyMontage/context'
import { clientError } from '@/utils/clientLog'
import CopyStoryboard from './CopyStoryboard.vue'
import type { PickerItem } from '@/composables/useWorkbenchPickers'
import { copyMontageShellKey } from './copyMontageUiContext'

const shell = inject(copyMontageShellKey)!
const { step, go, steps } = shell
const {
  // 参数与方案
  assembleLogic, concatLayout, concatFps, durationLimit,
  concatTransition, confirmBusy, copyBusy,
  edgeSpeedup, EDGE_SPEEDUP_OPTIONS, TRANSITIONS, FPS_OPTIONS, splitFps,
  statusText, concatProgress, splitResolution, filteredScenes,
  assemblePlans, currentPlanIdx, currentPlan,
  hasUnconfirmed, confirmedPaths, concatResults, planDurText,
  // 上一步（口播配音）的分镜脚本 + 每镜绑定素材（2026-09-21 用户裁决：
  // 确认合成的视频来源=分割镜头按分镜绑定；自动分配/单独选素材都写 shotClipIdx）
  storyboards, shotClipIdx, runConcatFromAllStoryboards, syncStoryboardsToServer,
  // 素材上传与镜头分割（2026-09-21 用户裁决：自智能混剪 Step1 移植到本页「本地上传」tab）
  srcVideos, srcDurations, threshold, minSceneLen, imageDuration,
  scenes, scoreFilter, splitBusy, splitError, splitMsg, splitProgress,
  selectFolder, onDrop, removeVideo, runSplit, updateSceneDesc,
  previewSourceVideo, previewScene, clearSplitCache, openSplitsDir, splitsDownloading,
  // 动作
  planRowText, selectPlan, startSeqPreview, onSeqEnded,
  submitConcatTask, confirmAllPrecompose, confirmPlanSingle,
  openProductDlg, productDlg, closeProductDlg, productDlgGenerate,
  copyViewDlg, viewPlanCopy, closeCopyView, planMenu, openPlanMenu, closePlanMenu,
  onDetailDragStart, onDetailDragEnd, onDetailDrop, toggleClipDeleted,
  toAbsolute: vdToAbsolute,
} = shell.s

// ── 素材来源 tabs（2026-09-21 用户裁决：本地上传/素材库/在线库/AI生成/混合；
//    当前仅本地上传实装，其余占位）──
const SOURCE_TABS = ['本地上传', '素材库', '在线搜索', 'AI生成', '混合']
const sourceTab = ref('本地上传')

// 2026-09-07 缩略图改主进程 ffmpeg 抽帧（dataURL <img>）：根治多路 <video> 解码器
// 并发初始化崩溃，且全部素材行均有缩略图，抽帧失败行回退占位图标（自智能混剪 Step1 移植）
const thumbs = reactive(new Map<string, string>())
let thumbSeq = 0
let thumbToken = 0
watch(() => [...srcVideos.value], (list) => {
  const token = ++thumbToken
  void (async () => {
    // 3 路并发池：4K XAVC 单帧解码较慢，串行 50 行需数分钟
    const pending = list.filter((v) => !thumbs.has(v))
    let cursor = 0
    const worker = async () => {
      while (token === thumbToken && cursor < pending.length) {
        const v = pending[cursor++]
        // 每素材独立 tag（extractFrames 输出目录按 tag 清空重建，避免互踩）
        try {
          const r = await window.tintin.ffmpeg.extractFrames({
            videoPath: v, times: [1.0], tag: `copysrcthumb${++thumbSeq}`, width: 160, quality: 3,
          })
          if (token !== thumbToken) return
          const b64 = r?.frames?.[0]?.base64
          if (b64) thumbs.set(v, `data:image/jpeg;base64,${b64}`)
        } catch { /* 抽帧失败 → 该行显示占位图标 */ }
      }
    }
    await Promise.all(Array.from({ length: Math.min(3, pending.length) }, () => worker()))
  })()
}, { immediate: true })
onUnmounted(() => { thumbToken++ })

/** 素材行时长文案（ffprobe 探测结果；未就绪/失败显 —） */
function fmtSrcDur(v: string): string {
  const d = srcDurations.get(v)
  return d && d > 0 ? d.toFixed(1) + 's' : '—'
}

/** Step2 排列逻辑（原版 logic_combo 唯一可见项；「按文案智能匹配」原版已隐藏） */
const logicOptions = [{ label: '智能重排', value: 'random' }]
/** 输出画幅下拉（首项动态附分割片段画幅） */
const LAYOUTS = computed(() => [
  { label: splitResolution.value ? `与分割视频一致 (${splitResolution.value})` : '与分割视频一致', value: 'source' },
  { label: '竖屏 (1080x1920 抖音流)', value: 'vertical' },
  { label: '横屏 (1920x1080 宽屏)', value: 'horizontal' },
])

const assignMsg = ref('')

/** 智能匹配到分镜脚本（2026-09-21 用户裁决方案 C：「自动分配到分镜脚本」按钮直接升级——
 *  逐脚本一次 llm:chat：本地硬约束预筛候选（景别桶>时长窗>评分，copyMontageAssignLogic）
 *  → LLM 候选内语义精选 → 校验解析；失败/缺槽按原循环轮转兜底（全局镜头序跨脚本连续
 *  取模，各素材使用次数均衡）。素材来源将来含在线/AI 生成时同样进 buildAssignPool 池 */
const smartAssignBusy = ref(false)
async function applyAssignment(): Promise<void> {
  const pool = buildAssignPool(filteredScenes.value)
  if (!pool.length) {
    assignMsg.value = '没有可用素材：请先上传素材并完成镜头分割。'
    return
  }
  const tabs = storyboards.value.slice()
  if (!tabs.length) {
    assignMsg.value = '还没有分镜脚本：请先在「文案编写」页生成。'
    return
  }
  smartAssignBusy.value = true
  const sceneByIdx = new Map(pool.map((p) => [p.scene.idx, p.scene]))
  let cyclicK = 0
  let total = 0
  let aiHit = 0
  const failedTabs: string[] = []
  try {
    for (let ti = 0; ti < tabs.length; ti++) {
      const tab = tabs[ti]
      if (!tab.shots.length) { tab.clipIdxs = []; continue }
      statusText.value = `智能匹配中（第 ${ti + 1}/${tabs.length} 个分镜脚本）…`
      const candidates = buildAssignCandidateSet(tab.shots, pool)
      let parsed: Map<number, number> | null = null
      try {
        const { systemPrompt, userPrompt } = buildAssignMatchPrompt(tab.shots, candidates)
        const res = await window.tintin.server.llmChat({
          model: '',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
        })
        if (res && 'error' in res) throw new Error(String(res.error) || 'LLM 返回空错误')
        const content = String(res?.choices?.[0]?.message?.content ?? '')
        parsed = parseAssignMatchResponse(content, tab.shots.length, candidates.length)
        if (!parsed) throw new Error('匹配结果解析失败（未返回合法 matches JSON）')
      } catch (e) {
        clientError('copy-montage', '智能匹配 LLM 失败（该脚本整组循环兜底）', errText(e))
        failedTabs.push(tab.name)
        parsed = null
      }
      const { idxs, matched, nextK } = mergeTabAssignment(tab.shots.length, parsed, candidates, pool, cyclicK)
      cyclicK = nextK
      tab.clipIdxs = idxs
      tab.shots.forEach((shot, si) => {
        const sc = sceneByIdx.get(idxs[si])
        if (sc && shot) {
          shot.material_path = sc.clipUrl || sc.name || ''
          shot.material_type = 'video'
        }
      })
      total += tab.shots.length
      aiHit += matched
    }
    const fallback = total - aiHit
    const failNote = failedTabs.length ? `；脚本「${failedTabs.join('」「')}」LLM 不可用已整组兜底` : ''
    assignMsg.value = `智能匹配完成：${tabs.length} 个分镜脚本共 ${total} 镜，AI 命中 ${aiHit}、循环兜底 ${fallback}（素材池去重后 ${pool.length} 段）${failNote}`
    void syncStoryboardsToServer()
  } finally {
    smartAssignBusy.value = false
  }
}

/** 确认合成视频（2026-09-21 用户裁决：视频来源=分割镜头按分镜绑定；任一分镜未绑定
 *  镜头则不能合成——runConcatFromShots 内校验并提示）：按分镜出方案 → 确认合成 */
async function onConfirmCompose(): Promise<void> {
  const tabs = storyboards.value.map((s) => ({ id: s.id, name: s.name, narrative: s.narrative, shots: s.shots, clipIdxs: s.clipIdxs.slice() }))
  const ok = await runConcatFromAllStoryboards(tabs)
  if (ok) {
    await confirmAllPrecompose()
    void syncStoryboardsToServer()
  }
}

/** 全部 tab 绑定齐全才允许合成（用户裁决 4：必须全部 tab 绑定全） */
const tabsAllBound = computed(() =>
  storyboards.value.length > 0 &&
  storyboards.value.every((tab) =>
    tab.shots.length > 0 && tab.clipIdxs.length === tab.shots.length && tab.clipIdxs.every((v) => Number(v) >= 0)))

/** 评分着色（原版 L1443-1448：≥8 绿 / ≥6 黄 / ≥0 红）；Step1 用途已迁 Step1Panel，Step2 详情表仍消费 */
function scoreClass(score: number | undefined): string {
  if (!score) return ''
  if (score >= 8) return 'score-high'
  if (score >= 6) return 'score-mid'
  return 'score-low'
}
</script>

<template>
      <section class="card">
        <VdStepBar :step="step" :steps="steps" @go="go" />
        <!-- 分镜脚本（2026-09-21 用户裁决：上一步的分镜脚本在页面顶部显示（material 态，
             只读 + 自动分配的素材镜头列表）；素材上传/分割区移到脚本下面） -->
        <CopyStoryboard mode="material" />

        <!-- 素材来源（2026-09-21 用户裁决：本地上传/素材库/在线库/AI生成/混合 五个 tab，
             当前仅本地上传实装；上传素材+镜头分割自智能混剪 Step1 移植） -->
        <div class="src-tabs">
          <button v-for="t in SOURCE_TABS" :key="t" class="src-tab" :class="{ active: sourceTab === t }"
            @click="sourceTab = t">{{ t }}</button>
        </div>

        <template v-if="sourceTab === '本地上传'">
          <div class="dropzone" @click="selectFolder" @drop.prevent="onDrop" @dragover.prevent>
            <span class="dz-main">拖入素材文件夹（自动遍历子文件夹内全部视频） 或 点击选择文件夹</span>
            <span class="dz-hint">支持 mp4 / mov / avi / mkv / flv / webm / m4v，服务端完成分割与逐镜分析</span>
          </div>

          <span class="sec-label">已选择的原始视频素材 (双击可播放预览):</span>
          <ul class="file-list src-video-list">
            <li v-for="(v, i) in srcVideos" :key="v" :title="v">
              <img v-if="thumbs.get(v)" class="video-thumb" :src="thumbs.get(v)" alt="" />
              <span v-else class="video-thumb video-thumb--ph" aria-hidden="true">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="4" width="15" height="14" rx="2" /><polygon points="10 8 16 11 10 14" fill="currentColor" stroke="none" /><path d="M19 8l3-2v12l-3-2" /></svg>
              </span>
              <span class="video-path" @dblclick="previewSourceVideo(v)">{{ v }}</span>
              <span class="video-dur">{{ fmtSrcDur(v) }}</span>
              <button class="video-play-btn" title="播放" @click="previewSourceVideo(v)">▶</button>
              <button class="video-remove-btn" title="从素材列表移除" @click="removeVideo(i)">×</button>
            </li>
            <li v-if="!srcVideos.length" class="muted">暂无素材，拖入或点击上方区域选择</li>
          </ul>
          <div v-if="srcVideos.length" class="video-count-footer">选择视频共 {{ srcVideos.length }} 行</div>

          <!-- 分割参数行 + 行内右对齐「开始智能镜头分割」 -->
          <div class="row">
            <label class="param-label">分割阈值 (10-100):</label>
            <input v-model.number="threshold" type="number" min="10" max="100" class="input w80" />
            <label class="param-label">最小镜头(秒):</label>
            <input v-model.number="minSceneLen" type="number" step="0.1" min="0.1" max="60" class="input w80" />
            <label class="param-label" title="无法分割的视频，自动挑出多长的片段">分镜头时长(秒):</label>
            <input v-model.number="imageDuration" type="number" min="1" max="30"
              title="无法分割的视频，自动挑出多长的片段" class="input w80" />
            <span class="spacer"></span>
            <TButton label="开始智能镜头分割" icon="cut" :loading="splitBusy" @click="runSplit" />
          </div>
          <progress v-if="splitBusy" class="vd-progress split-progress" :value="splitProgress" max="100" />
          <div v-if="splitMsg" class="hint">{{ splitMsg }}</div>
          <div v-if="splitError" class="error-msg">⚠ {{ splitError }}（修正后重按「开始智能镜头分割」重试）</div>

          <!-- 已分割镜头表（评分过滤同智能混剪口径；勾选镜头经「自动分配到分镜脚本」落到各分镜） -->
          <div class="row between">
            <span class="sec-label">已分割出的最小单位镜头片段 (双击可播放预览，双击画面描述列可手动修改):</span>
            <label class="muted">评分过滤:
              <select v-model.number="scoreFilter" class="input" title="按评分筛选镜头：达到阈值的镜头才会进入镜头列表参与自动分配">
                <option :value="0">不过滤</option>
                <option v-for="s in [1,2,3,4,5,6,7,8,9]" :key="s" :value="s">≥ {{ s }} 分</option>
              </select>
            </label>
          </div>
          <div class="tbl-scroll-wrap">
            <table class="tbl">
              <thead><tr>
                <th class="w32"></th><th>序号</th><th style="min-width:140px">视频片段</th><th>景别</th><th>位置</th><th>时长</th>
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
                  <td class="ta-c shot-source-cell" :title="r.positionSource || ''">
                    <span v-if="r.position" class="shot-type-badge"
                      :style="{ color: SHOT_TYPE_COLORS[r.position] || '#888', borderColor: SHOT_TYPE_COLORS[r.position] || '#888' }">
                      {{ SHOT_TYPE_LABELS[r.position] || r.position }}
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
                <tr v-if="!filteredScenes.length"><td colspan="11" class="muted">暂无已分割镜头，请先上传素材并开始智能镜头分割</td></tr>
              </tbody>
            </table>
          </div>
        </template>
        <div v-else class="src-placeholder muted">「{{ sourceTab }}」素材来源暂不支持，当前仅支持本地上传</div>

        <!-- 智能匹配到分镜脚本（2026-09-21 用户裁决方案 C：原「自动分配到分镜脚本」
             直接升级——本地预筛+LLM 精选+循环兜底；分配明细见顶部分镜脚本各镜） -->
        <div class="param-row">
          <span class="spacer"></span>
          <span v-if="assignMsg" class="hint">{{ assignMsg }}</span>
          <TButton label="智能匹配到分镜脚本" icon="check" :loading="smartAssignBusy" :disabled="!filteredScenes.length || !storyboards.length" @click="applyAssignment" />
        </div>

        <!-- 参数设置组（原版 params_group：统一边框背景内两行参数；2026-09-21 用户裁决（图2标注）：
             自页顶移到「确认合成视频」上一行单独成块——合成前最后确认参数） -->
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
              title="分割片段画幅（2026-09-15 裁决：画幅基准=分割片段而非原素材），选择'与分割视频一致'时将使用此分辨率">
              分割画幅: {{ splitResolution || '未知' }}</span>
            <span class="param-label">时长限制:</span>
            <!-- 2026-09-21 用户裁决：时长跟随第二步口播声音的实际时长（只读，不再手选） -->
            <input :value="durationLimit" readonly class="input w80"
              title="跟随第二步口播声音的实际时长；未生成声音时为缺省 30 秒" />
            <span class="hint">跟随声音</span>
            <!-- 2026-09-21 用户裁决：成片数=分镜脚本数，生成视频数量输入删除 -->
          </div>
          <!-- Parameters row 2（原版 L109-140：转场动画 | 出入场加速；输出帧率是本端新增控件——
               原版无帧率入口、写死 30fps，2026-09-11 用户裁决加下拉且默认「跟随原片」） -->
          <div class="param-row">
            <span class="param-label">转场动画:</span>
            <select v-model="concatTransition" class="input w120" title="镜头之间的转场动画效果（剪映常用转场）">
              <option v-for="o in TRANSITIONS" :key="o.value" :value="o.value">{{ o.label }}</option>
            </select>
            <span class="param-label">出入场加速:</span>
            <select v-model.number="edgeSpeedup" class="input w90"
              title="识别为「入场/出场」（位置，非景别）的镜头按此倍速加速播放，其它位置不受影响。&#10;位置来源：服务端 enter/exit 标注优先，否则按素材文件夹/文件名命名（入场、出场等）推断（见分割表「位置」列）。&#10;走服务端合成时生效；本地回退合成不支持加速；无位置标注的素材无效果。">
              <option v-for="o in EDGE_SPEEDUP_OPTIONS" :key="o.value" :value="o.value">{{ o.label }}</option>
            </select>
            <span class="param-label">输出帧率:</span>
            <select v-model="concatFps" class="input w140"
              title="成片帧率，随服务端合成提交 fps 字段（契约 integer，默认 30）。&#10;跟随原片：用服务端 split 响应的 source_resolution.fps（2026-09-11 实测有此字段），&#10;服务端未给时本地探测兑底；都不行则回退 30。&#10;29.97/23.976 等小数帧率服务端不收，一律取整。">
              <option v-for="o in FPS_OPTIONS" :key="o.value" :value="o.value">{{ o.label }}</option>
            </select>
            <span v-if="concatFps === 'source'" class="src-res"
              title="服务端 source_resolution.fps 优先，本地探测兑底；都拿不到时按 30 fps 提交">
              原片: {{ splitFps > 0 ? splitFps + ' fps' : '未知（回退 30）' }}</span>
          </div>
        </div>

        <!-- 确认行（原版 confirm_row L268-286：确认合成视频 + 生成口播文案，初始禁用；
             2026-09-10 界面统一：属执行步骤，归左栏底部） -->
        <div class="row confirm-row">
          <TButton label="确认合成视频" :loading="confirmBusy" :disabled="!tabsAllBound" title="所有分镜脚本绑定完整素材后才能合成；有分镜缺素材时不能合成" @click="onConfirmCompose" />
          <!-- 2026-09-21 用户裁决：「生成口播文案」删除——文案在第一步编写/生成，旁白已在第二步克隆 -->
        </div>
        <template v-if="confirmBusy">
          <div class="concat-status-line">{{ statusText }}</div>
          <progress class="vd-progress split-progress" :value="concatProgress" max="100" />
        </template>

        <!-- 导航行（2026-09-10 用户裁决：上/下步按钮属操作区，归左栏底部；原版 nav_row L288-301） -->
        <div class="row between">
          <!-- 2026-09-17 用户裁决：上一步删除；下一步=跳转口播配音界面（换序后 go(1)） -->
          <TButton label="上一步：口播配音" icon="left" @click="go(1)" />
          <!-- 2026-09-21 用户裁决：完成第三步可进入第四步特效包装 -->
          <TButton label="下一步：特效包装" icon="right" @click="go(3)" />
        </div>
      </section>




</template>

<style scoped>
/* 顶部步骤条 .step-bar 系样式已迁入 VdStepBar.vue（2026-09-10 tab 入操作区） */

.sec-label { font-size: 13px; font-weight: 600; color: var(--foreground); }
.param-label { font-size: 13px; color: var(--foreground); white-space: nowrap; }
.spacer { flex: 1; }
.ta-c { text-align: center; }
.w32 { width: 32px; }
.card { display: flex; flex-direction: column; gap: var(--space-4); padding: var(--space-5); background: var(--card); border: 1px solid var(--border); border-radius: var(--radius-lg); }
.shot-source-cell { font-size: 12px; color: var(--muted-foreground); white-space: nowrap; }
/* Step1 解析进度条（复用 vd-progress 配色） */
.split-progress { margin: 6px 0 2px; }
.row { display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap; }
.row.between { justify-content: space-between; }
.row.right { justify-content: flex-end; }
.row.left { justify-content: flex-start; }
.label, .card-title { font-size: 13px; font-weight: 600; color: var(--foreground); }
.muted { color: var(--muted-foreground); font-size: 12px; }
.hint { color: var(--muted-foreground); font-size: 12px; }
.error-msg { color: var(--danger, #e74c3c); font-size: 12px; }
.clip-count { font-weight: 700; }
.input { height: 32px; padding: 0 10px; background: var(--card); border: 1px solid var(--border); border-radius: var(--radius-md); color: var(--foreground); outline: none; font-size: 13px; }
.input:focus { border-color: var(--primary); }
.input.grow { flex: 1; min-width: 120px; }
.w80 { width: 80px; }
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
.w60 { width: 60px; }
.w90 { width: 90px; }
.w120 { width: 120px; }
.w140 { width: 140px; }
.w180 { width: 180px; }
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
.pick-right .modal-field--stack :deep(.input) { width: 100%; flex: none; }
/* 参考文案（2026-09-11 用户裁决：单行 input 显示不全 → 两行高度，可纵向拉伸）。
   源序必须在 .input 之后（同特异性覆盖其 height:32px / padding:0 10px） */
.ref-text {
  height: auto; min-height: 52px; padding: 6px 10px;
  line-height: 1.5; font-family: inherit; resize: vertical;
}
.dropzone { display: flex; flex-direction: column; justify-content: center; align-items: center; gap: 4px; min-height: 120px; padding: var(--space-5); background: color-mix(in srgb, var(--primary) 6%, var(--surface-container)); border: 1.5px dashed color-mix(in srgb, var(--primary) 40%, var(--border)); border-radius: var(--radius-lg); cursor: pointer; color: var(--foreground); transition: border-color var(--duration-fast), background var(--duration-fast); }
.dropzone:hover, .dropzone.is-active { border-color: var(--primary); background: color-mix(in srgb, var(--primary) 12%, var(--surface-container)); }
.dz-main { font-size: var(--font-size-body); font-weight: var(--font-weight-medium); }
.dz-hint { font-size: var(--font-size-caption); color: var(--muted-foreground); }
.icon-btn {
  width: 28px; height: 24px; padding: 0; font-size: 13px; line-height: 1; flex: none;
  background: var(--card); color: var(--foreground);
  border: 1px solid var(--border); border-radius: var(--radius-sm); cursor: pointer;
}
.icon-btn:hover:not(:disabled) { border-color: var(--primary); }
.icon-btn:disabled { opacity: .4; cursor: not-allowed; }
.vd-progress-text { font-size: 11px; color: var(--primary); }
.concat-status-line { font-size: 11px; color: var(--primary); margin: 4px 0 2px; }
.muted-tag { width: 48px; color: var(--muted-foreground); }
.vd-progress { width: 100%; height: 6px; appearance: none; border-radius: 3px; overflow: hidden; }
.vd-progress::-webkit-progress-bar { background: var(--surface-container); }
.vd-progress::-webkit-progress-value { background: var(--primary); transition: width 0.3s; }
.bgm-pick-right .row { gap: 6px; }
/* 折叠按钮（最右侧）：不用 .icon-btn（28px 宽装不下中文） */
.textfx-toggle {
  flex: none; height: 24px; padding: 0 8px; font-size: 12px; white-space: nowrap;
  background: var(--card); color: var(--muted-foreground);
  border: 1px solid var(--border); border-radius: var(--radius-sm); cursor: pointer;
}
.w80 { width: 80px; flex: none; }
/* ── 素材来源 tabs + 本地上传（自智能混剪 Step1 移植，2026-09-21 用户裁决）── */
.src-tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--border); }
.src-tab {
  height: 32px; padding: 0 16px; border: none; background: transparent;
  color: var(--muted-foreground); font-size: 13px; cursor: pointer;
  border-bottom: 2px solid transparent;
}
.src-tab:hover { color: var(--foreground); }
.src-tab.active { color: var(--primary); font-weight: 600; border-bottom-color: var(--primary); }
.src-placeholder { padding: 24px; text-align: center; background: var(--surface-container); border-radius: var(--radius-md); }

/* 素材列表（缩略图 + 路径 + 时长 + 播放/删除按钮） */
.file-list { display: flex; flex-direction: column; list-style: none; margin: 0; padding: 0; font-size: 13px; }
.file-list li { display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); padding: 6px 10px; border-bottom: 1px solid var(--border); word-break: break-all; }
.file-list li:last-child { border-bottom: none; }
.src-video-list { max-height: 480px; overflow-y: auto; }
.src-video-list li { padding: 4px 8px; }
.video-thumb { width: 60px; height: 40px; object-fit: cover; border-radius: var(--radius-sm); background: #000; flex: none; }
.video-thumb--ph { display: inline-flex; align-items: center; justify-content: center; color: var(--muted-foreground); background: var(--surface-container-high); }
.video-path { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: pointer; }
.video-dur { flex: none; width: 52px; text-align: right; font-size: 12px; color: var(--muted-foreground); margin-right: 8px; font-variant-numeric: tabular-nums; }
.video-play-btn { width: 24px; height: 24px; padding: 0; font-size: 12px; line-height: 1; flex: none; background: transparent; color: var(--muted-foreground); border: 1px solid var(--border); border-radius: var(--radius-sm); cursor: pointer; margin-right: 4px; }
.video-play-btn:hover { color: var(--success); border-color: var(--success); }
.video-remove-btn { width: 24px; height: 24px; padding: 0; font-size: 16px; line-height: 1; flex: none; background: transparent; color: var(--muted-foreground); border: 1px solid var(--border); border-radius: var(--radius-sm); cursor: pointer; }
.video-remove-btn:hover { color: var(--danger); border-color: var(--danger); }
.video-count-footer { text-align: center; color: var(--muted-foreground); font-size: 12px; padding: 4px 0; }
.desc-input { height: 28px; width: 100%; padding: 0 8px; font-size: 12px; }
/* 评分着色（分割镜头表；≥8 绿 / ≥6 黄 / 其余红，原版 L1443-1448 口径） */
.score-high { color: #2ecc71; font-weight: 600; }
.score-mid { color: #f1c40f; font-weight: 600; }
.score-low { color: #e74c3c; font-weight: 600; }
/* 分镜脚本卡样式在公共组件 CopyStoryboard.vue（material 态自注入） */
</style>