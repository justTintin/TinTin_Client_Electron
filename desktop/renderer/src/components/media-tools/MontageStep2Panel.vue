<script setup lang="ts">
// ═══════════════════════════════════════════════════════════════
// MontageStep2Panel.vue — 智能混剪 Step2 镜头重组面板（铁律 10 Phase3 P2，2026-09-19）
// 模板/样式自 VideoMontage.vue 逐字搬迁；状态经 inject 解构回原名（零改动）。
// 本面板本地逻辑：右栏预览 computed、排列/时长/画幅下拉选项、方案与镜头详情
// 右键菜单、口播弹窗产品选择（WbPickProductPanel）、scoreClass（Step1/2 各持一份）。
// 注：toAbsolute 在面板内以原名解构，模板沿用原别名 vdToAbsolute（与 Shell 等价）。
// ═══════════════════════════════════════════════════════════════
import { ref, computed, inject } from 'vue'
import TButton from '@/components/common/TButton.vue'
import TSelect from '@/components/common/TSelect.vue'
import StepPreviewPane, { type StepPreviewItem } from './StepPreviewPane.vue'
import WbPickProductPanel from '@/components/workbench/WbPickProductPanel.vue'
import VdStepBar from './VdStepBar.vue'
import { markdownListLines, stripProductCodeFromModel } from '@/composables/opsProductLibraryLogic'
import { copyPreviewText, SHOT_TYPE_COLORS, SHOT_TYPE_LABELS } from '@/composables/videoMontageLogic'
import type { PickerItem } from '@/composables/useWorkbenchPickers'
import { montageShellKey } from './montageUiContext'

const shell = inject(montageShellKey)!
const { step, go, vdLeftStyle, onSplitDown, previewAspect } = shell
const {
  // 参数与方案
  assembleLogic, concatLayout, concatFps, durationLimit, DURATION_LIMITS,
  batchCount, recBatchCount, concatTransition, concatBusy, confirmBusy, copyBusy,
  concatError, edgeSpeedup, EDGE_SPEEDUP_OPTIONS, TRANSITIONS, FPS_OPTIONS, splitFps,
  statusText, concatProgress, splitResolution, filteredScenes, checkedCount,
  assemblePlans, currentPlanIdx, currentPlan,
  hasUnconfirmed, confirmedPaths, concatResults, planDurText,
  // 动作
  runConcat, planRowText, selectPlan, startSeqPreview, onSeqEnded,
  submitConcatTask, confirmAllPrecompose, confirmPlanSingle,
  openProductDlg, productDlg, closeProductDlg, productDlgGenerate,
  copyViewDlg, viewPlanCopy, closeCopyView, planMenu, openPlanMenu, closePlanMenu,
  onDetailDragStart, onDetailDragEnd, onDetailDrop, toggleClipDeleted,
  toAbsolute: vdToAbsolute,
} = shell.s

// ── 右栏预览（本面板切片；toFileUrl 为面板内私有拷贝，Shell 版供 Step3/4）──
/** 本地路径 → file URL（previewFinalVideo 同口径） */
function toFileUrl(p: string): string {
  return 'file:///' + encodeURI(String(p).replace(/\\/g, '/')).replace(/#/g, '%23')
}

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
  // 核心卖点逐条拼入补充卖点（多行，可继续手改/留空）
  productDlg.value.extra = markdownListLines(it.selling_points).join('\n')
}


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
        <div class="vd-unified">
        <div class="vd-unified-left" :style="vdLeftStyle">
        <VdStepBar :step="step" @go="go" />
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
              title="分割片段画幅（2026-09-15 裁决：画幅基准=分割片段而非原素材），选择'与分割视频一致'时将使用此分辨率">
              分割画幅: {{ splitResolution || '未知' }}</span>
            <span class="param-label">时长限制:</span>
            <select v-model.number="durationLimit" class="input w80" title="每个预合成视频的总时长上限（实际不超此值的 1.1 倍）">
              <option v-for="s in DURATION_LIMITS" :key="s" :value="s">{{ s }} 秒</option>
            </select>
            <span class="param-label">生成视频数量 (1-20):</span>
            <input v-model.number="batchCount" type="number" min="1" max="20" class="input w60" />
            <span class="hint">推荐: {{ recBatchCount }}</span>
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
          <!-- 预合成视频列表（2026-09-09 用户裁决：改表格列显示，不再单行挤在一起；
               列：序号|视频|时长|状态|口播文案；时长列为同日追加裁决：已合成=成片探测
               实际时长，待确认=未删除镜头之和估计；交互不变：单击选中/双击查看文案/右键菜单） -->
          <span class="sec-label">预合成视频列表 (双击播放预览，单击选中查看镜头):</span>
          <!-- 滚动容器（2026-09-11 用户裁决）：最大 10 行高度（表头 + 10 行，与下方详情表
               380px 同口径），超出滚动；少于 10 行随真实行数收缩，不再用占位行撑高。
               注：旧值 332px 行高实测约 33px 只能完整显示 9 行 → 调至 380px（表头约
               30px + 10 行 × 35px），2026-09-11 用户裁决「至少显示 10 个」 -->
          <div class="plan-tbl-wrap">
            <table class="tbl plan-tbl">
              <thead><tr>
                <th class="w48">序号</th><th style="min-width:140px">视频</th><th class="w64">时长</th><th class="w64">状态</th><th style="min-width:180px">口播文案</th>
              </tr></thead>
              <tbody>
                <tr v-for="(p, i) in assemblePlans" :key="i" :class="{ picked: currentPlanIdx === i }"
                  :title="planRowText(i)" @click="selectPlan(i)" @dblclick="viewPlanCopy(i)"
                  @contextmenu.prevent="openPlanMenu($event, i)">
                  <td class="ta-c">{{ i + 1 }}</td>
                  <td class="plan-file" :title="p.outputName">{{ p.outputName || `${p.clips.length} 个镜头` }}</td>
                  <td class="ta-c">{{ planDurText(p) }}</td>
                  <td class="ta-c">{{ p.confirmed && p.outputName ? '已合成' : '待确认' }}</td>
                  <td class="plan-copy" :title="p.copy || ''">{{ p.copy ? copyPreviewText(p.copy) : '未生成口播文案' }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <div v-if="!assemblePlans.length" class="muted plan-empty">尚无预合成视频，勾选镜头后点击「镜头重组」</div>

          <!-- 下半区：分割镜头详情表（表头 + 10 行高，见 .detail-scroll-wrap 380px；
               2026-09-11 用户裁决至少显示 10 个；连播预览已迁右侧统一预览栏，
               2026-09-10 用户需求：单击预览块联动选中方案） -->
          <div class="result-bottom">
            <div class="detail-col">
              <span class="sec-label">视频组成镜头详情 (拖动把手调序，右键删除/恢复镜头):</span>
              <div class="detail-scroll-wrap">
                <table class="tbl detail-tbl">
                  <thead><tr>
                    <th class="w48">序号</th><th class="w32"></th><th style="min-width:120px">分割文件名</th>
                    <th>时长</th><th>景别</th><th>位置</th><th style="min-width:180px">描述文案</th><th>评分</th>
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
                      <!-- 位置：入场/出场（同 Step1 口径：服务端 enter/exit 优先，路径命名兑底；tooltip 标来源）。
                           重组排序即按此列：入场头/出场尾/其余居中（applyShotLayoutOrder） -->
                      <td class="ta-c shot-source-cell" :title="c.positionSource || ''">
                        <span v-if="c.position" class="shot-type-badge"
                          :style="{ color: SHOT_TYPE_COLORS[c.position] || '#888', borderColor: SHOT_TYPE_COLORS[c.position] || '#888' }">
                          {{ SHOT_TYPE_LABELS[c.position] || c.position }}
                        </span>
                        <span v-else class="muted">—</span>
                      </td>
                      <td class="clip-desc" :title="c.description">{{ c.description || '—' }}</td>
                      <td class="ta-c" :class="scoreClass(c.score)">{{ c.score ? c.score.toFixed(1) : '—' }}</td>
                    </tr>
                    <!-- 不足 10 行时占位 -->
                    <tr v-for="n in Math.max(0, 10 - (currentPlan?.clips.length || 0))" :key="'dph'+n" class="detail-placeholder-row"><td colspan="8"></td></tr>
                  </tbody>
                  <tbody v-else>
                    <tr><td colspan="7" class="muted">单击右侧预览块或上方预合成项查看镜头详情</td></tr>
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>

        <!-- 确认行（原版 confirm_row L268-286：确认合成视频 + 生成口播文案，初始禁用；
             2026-09-10 界面统一：属执行步骤，归左栏底部） -->
        <div class="row confirm-row">
          <TButton label="确认合成视频" :loading="confirmBusy" :disabled="!hasUnconfirmed" @click="confirmAllPrecompose" />
          <!-- 2026-09-09 用户裁决：合成完成后生成口播文案要标明可点击状态（可用时切 primary 高亮） -->
          <TButton label="生成口播文案" :variant="confirmedPaths.length ? 'primary' : 'secondary'" :loading="copyBusy" :disabled="!confirmedPaths.length" @click="openProductDlg('all')" />
        </div>
        <template v-if="confirmBusy">
          <div class="concat-status-line">{{ statusText }}</div>
          <progress class="vd-progress split-progress" :value="concatProgress" max="100" />
        </template>

        <!-- 导航行（2026-09-10 用户裁决：上/下步按钮属操作区，归左栏底部；原版 nav_row L288-301） -->
        <div class="row between">
          <TButton label="上一步：镜头分割" plain @click="go(0)" />
          <TButton label="下一步：口播配音" icon="right" :disabled="!confirmedPaths.length" @click="go(2)" />
        </div>
        </div><!-- /vd-unified-left -->

<div class="vd-split" title="拖动调整左右比例" @mousedown="onSplitDown"></div>

        <!-- 右栏：每条方案一块预览（确认成片直播；未确认单击块连播镜头序列，并联动左栏镜头表） -->
        <div class="vd-unified-right">
          <StepPreviewPane title="画面预览" :items="step2PreviewItems" :active-index="currentPlanIdx"
            :aspect="previewAspect"
            empty-text="尚无预合成方案，勾选镜头后点击「镜头重组」" @select="selectPlan" />
        </div>
        </div><!-- /vd-unified -->
      </section>
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
.dropzone:hover, .dropzone.is-active { border-color: var(--primary); background: color-mix(in srgb, var(--primary) 12%, var(--surface-container)); }
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