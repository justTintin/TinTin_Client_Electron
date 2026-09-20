<script setup lang="ts">
// ═══════════════════════════════════════════════════════════
// CopyStep1Panel.vue — 智能混剪 Step1 镜头智能分割面板（铁律 10 Phase3 P1，2026-09-19）
// 模板/样式自 VideoMontage.vue 逐字搬迁；状态经 inject 解构回原名（零改动）。
// 本面板本地逻辑：素材缩略图抽帧簇 + 时长文案 + 评分着色。
// ═══════════════════════════════════════════════════════════
import { reactive, watch, onUnmounted, inject } from 'vue'
import TButton from '@/components/common/TButton.vue'
import VdStepBar from '../VdStepBar.vue'
import { copyMontageShellKey } from './copyMontageUiContext'

const shell = inject(copyMontageShellKey)!
const { step, go, steps } = shell
const {
  srcVideos, srcDurations, threshold, minSceneLen, imageDuration,
  scenes, scoreFilter, filteredScenes,
  splitBusy, splitError, splitMsg, splitProgress, splitResolution,
  selectFolder, onDrop, removeVideo, runSplit, updateSceneDesc,
  previewSourceVideo, previewScene, clearSplitCache, openSplitsDir, splitsDownloading,
  SHOT_TYPE_COLORS, SHOT_TYPE_LABELS,
} = shell.s

// 2026-09-07 缩略图改主进程 ffmpeg 抽帧（dataURL <img>）：
// ① 根治多路 <video> 解码器并发初始化崩溃（前版限 8 行挂载导致“缩略图只有一部分”）；
// ② 全部素材行均有缩略图，抽帧失败行回退占位图标。
// 注：原客户端素材列表本无缩略图（_decorate_video_item_widget 仅设景别色），此为本端增强；
// 素材库条目缩略图走服务端 /material/thumbnail（WbPickMaterialDialog 同源），待 Step1
// 补素材库入口后接入——用户裁决 2026-09-07：优先服务端，无则本地抽帧。
const thumbs = reactive(new Map<string, string>())
let thumbSeq = 0

/** 素材行时长文案（ffprobe 探测结果；未就绪/失败显 —） */
function fmtSrcDur(v: string): string {
  const d = srcDurations.get(v)
  return d && d > 0 ? d.toFixed(1) + 's' : '—'
}
let thumbToken = 0
watch(() => [...srcVideos.value], (list) => {
  const token = ++thumbToken
  void (async () => {
    // 3 路并发池：4K XAVC 单帧解码较慢，串行 50 行需数分钟（2026-09-09 用户反馈封面迟迟不出）
    const pending = list.filter((v) => !thumbs.has(v))
    let cursor = 0
    const worker = async () => {
      while (token === thumbToken && cursor < pending.length) {
        const v = pending[cursor++]
        // 每素材独立 tag（extractFrames 输出目录按 tag 清空重建，避免互踩）
        try {
          const r = await window.tintin.ffmpeg.extractFrames({
            videoPath: v, times: [1.0], tag: `montagethumb${++thumbSeq}`, width: 160, quality: 3,
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
        <div class="dropzone" @click="selectFolder" @drop.prevent="onDrop" @dragover.prevent>
          <span class="dz-main">拖入素材文件夹（自动遍历子文件夹内全部视频） 或 点击选择文件夹</span>
          <span class="dz-hint">支持 mp4 / mov / avi / mkv / flv / webm / m4v，服务端完成分割与逐镜分析</span>
        </div>

        <span class="sec-label">已选择的原始视频素材 (双击可播放预览):</span>
        <ul class="file-list src-video-list">
          <li v-for="(v, i) in srcVideos" :key="v" :title="v">
            <!-- 2026-09-07 缩略图改主进程 ffmpeg 抽帧 dataURL（根治多路 <video> 并发
                 初始化崩溃，且全部行有缩略图）；抽帧失败行显示占位图标 -->
            <img v-if="thumbs.get(v)" class="video-thumb" :src="thumbs.get(v)" alt="" />
            <span v-else class="video-thumb video-thumb--ph" aria-hidden="true">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="4" width="15" height="14" rx="2" /><polygon points="10 8 16 11 10 14" fill="currentColor" stroke="none" /><path d="M19 8l3-2v12l-3-2" /></svg>
            </span>
            <span class="video-path" @dblclick="previewSourceVideo(v)">{{ v }}</span>
            <!-- 时长列（2026-09-09 用户裁决：素材列表加时长显示，ffprobe 探测） -->
            <span class="video-dur">{{ fmtSrcDur(v) }}</span>
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
          <label class="param-label" title="无法分割的视频，自动挑出多长的片段">分镜头时长(秒):</label>
          <input v-model.number="imageDuration" type="number" min="1" max="30"
            title="无法分割的视频，自动挑出多长的片段" class="input w80" />
          <span class="spacer"></span>
          <TButton label="开始智能镜头分割" icon="cut" :loading="splitBusy" @click="runSplit" />
        </div>
        <!-- 解析进度（对照原版 step1_split_controller _progress：按素材数 0-100 推进） -->
        <progress v-if="splitBusy" class="vd-progress split-progress" :value="splitProgress" max="100" />
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
        <!-- 11 列：原版 10 列（勾选|序号|视频片段|景别|时长|画幅|主要画面|产品|型号|评分）
             + 本端增强「位置」列（2026-09-09 裁决：位置≠景别——位置=入场/出场等叙事位置，
             服务端 enter/exit 优先、源素材文件名/文件夹命名兑底；景别仅服务端返回） -->
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
              <!-- 景别：仅服务端 shot_analysis.shot_type，客户端不自行推断（2026-09-09 裁决） -->
              <td class="ta-c">
                <span v-if="r.shotType" class="shot-type-badge"
                  :style="{ color: SHOT_TYPE_COLORS[r.shotType] || '#888', borderColor: SHOT_TYPE_COLORS[r.shotType] || '#888' }">
                  {{ SHOT_TYPE_LABELS[r.shotType] || r.shotType }}
                </span>
                <span v-else class="muted">—</span>
              </td>
              <!-- 位置：入场/出场（服务端 enter/exit 优先，否则路径命名兑底；tooltip 标来源） -->
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
        <!-- 2026-09-17 用户裁决换序：go(1)=口播配音 -->
        <TButton label="下一步：口播配音" icon="right" :disabled="!scenes.length" @click="go(1)" />
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

/* Step1 解析进度条（复用 vd-progress 配色） */
.split-progress { margin: 6px 0 2px; }

.video-count-footer { text-align: center; color: var(--muted-foreground); font-size: 12px; padding: 4px 0; }

.row { display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap; }

.row.between { justify-content: space-between; }

.row.right { justify-content: flex-end; }

.row.left { justify-content: flex-start; }

.label, .card-title { font-size: 13px; font-weight: 600; color: var(--foreground); }

.muted { color: var(--muted-foreground); font-size: 12px; }

.hint { color: var(--muted-foreground); font-size: 12px; }

.error-msg { color: var(--danger, #e74c3c); font-size: 12px; }

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

.param-row .param-label { margin-left: var(--space-3); }

.param-row .param-label:first-child { margin-left: 0; }

.detail-scroll-wrap .tbl { border-radius: 0; }

.row-deleted td {
  color: var(--muted-foreground); text-decoration: line-through;
  background: rgba(231, 76, 60, 0.12);
}

.pick-right .modal-field--stack :deep(.input) { width: 100%; flex: none; }

/* 参考文案（2026-09-11 用户裁决：单行 input 显示不全 → 两行高度，可纵向拉伸）。
   源序必须在 .input 之后（同特异性覆盖其 height:32px / padding:0 10px） */
.ref-text {
  height: auto; min-height: 52px; padding: 6px 10px;
  line-height: 1.5; font-family: inherit; resize: vertical;
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

.vd-progress-text { font-size: 11px; color: var(--primary); }

.muted-tag { width: 48px; color: var(--muted-foreground); }

.vd-progress { width: 100%; height: 6px; appearance: none; border-radius: 3px; overflow: hidden; }

.vd-progress::-webkit-progress-bar { background: var(--surface-container); }

.vd-progress::-webkit-progress-value { background: var(--primary); transition: width 0.3s; }

.bgm-pick-right .row { gap: 6px; }

.w80 { width: 80px; flex: none; }
</style>