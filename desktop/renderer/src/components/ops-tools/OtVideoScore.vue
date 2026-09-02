<script setup lang="ts">
// ═══════════════════════════════════════════════════════════════
// OtVideoScore.vue — 视频评价预测（运营工具 · 完整实现）
//
// 对照原客户端 studio/gui/hook_score_page.py HookScorePage.setup：
//   标题说明 → 实验性警告 → 视觉模型状态卡（信息/状态/测试连接）
//   → 输入栏（平台下拉 + 视频路径 + 浏览 + 开始预测）
//   → 关键帧预览（横向缩略图，scaledToHeight 104）
//   → 结果卡（综合分 + 量级 + 黄金3秒 + 6 维卡片 + 雷达图 + 总评 + 建议）
//   → 反馈回填（真实播放量 + 平台评价，反哺下次预测校准）
//   → 待回填历史（对照 pending_feedback）
// 分层：本组件只绘制 + 事件转发；编排在 useVideoScore，纯计算在 videoScoreLogic。
// ═══════════════════════════════════════════════════════════════
import { computed, onMounted } from 'vue'
import { useVideoScore } from '@/composables/useVideoScore'
import { radarGeometry, toSvgPoints } from '@/composables/videoScoreLogic'
import { jpegDataUrl } from '@/composables/visionLogic'
import TButton from '@/components/common/TButton.vue'
import TSelect from '@/components/common/TSelect.vue'

const {
  videoPath, platform, state, errorMsg, progressText,
  result, totalColor, levelColor,
  frames, duration,
  modelInfo, modelStatusText, modelStatusColor, canTestModel, testVisionModel,
  pendingRecords, calibrationCount,
  feedbackPlay, feedbackEval, feedbackHint,
  init, pickVideo, setVideoPath, resetResult, setPlatform,
  startPredict, saveFeedback, pickPendingRecord,
  PLATFORMS, DIMENSIONS, DIM_COLORS,
} = useVideoScore()

const platformOptions = PLATFORMS.map((p) => ({ label: p, value: p }))

/** 雷达图几何（对照 RadarChartWidget，170×170） */
const radar = computed(() => radarGeometry(result.value?.dims || {}, 170))
/** 数据多边形填充（对照 QBrush(QColor(46,204,113,60))） */
const RADAR_FILL = 'rgba(46,204,113,0.235)'

onMounted(() => { init() })
</script>

<template>
  <div class="video-score">
    <!-- 标题栏（对照 heading + ElidedLabel 说明） -->
    <div class="header">
      <h1 class="title">📈 视频评价预测</h1>
      <p class="subtitle">
        选投放平台 → 上传视频 → 抽取覆盖全片的关键帧 → 视觉模型按该平台推荐逻辑
        预测表现（综合分 + 预测量级 + 多维评分 + 建议）。发布后回填真实播放量与平台评价，
        这些「预测 vs 实际」对照会反哺下次预测。
      </p>
    </div>

    <!-- 实验性警告（对照 warning_lbl） -->
    <div class="warning">⚠️ 注意：此为根据大模型预测，实验功能，不一定完全准确。</div>

    <!-- 视觉模型状态卡（对照 model_status_card） -->
    <section class="card model-bar">
      <span class="model-info">{{ modelInfo }}</span>
      <span class="model-status" :style="{ color: modelStatusColor }">{{ modelStatusText }}</span>
      <span v-if="calibrationCount" class="model-calib">
        已积累 {{ calibrationCount }} 条「{{ platform }}」预测对照用于校准
      </span>
      <div class="spacer" />
      <TButton
        label="测试连接"
        variant="secondary"
        size="small"
        :disabled="!canTestModel"
        @click="testVisionModel()"
      />
    </section>

    <!-- 输入栏（对照 bar：选择视频 + 浏览 + 开始检测） -->
    <section class="card input-bar">
      <div class="row">
        <label class="label">投放平台:</label>
        <TSelect
          :model-value="platform"
          :options="platformOptions"
          class="w120"
          @update:model-value="setPlatform($event as any)"
        />

        <input
          :value="videoPath"
          placeholder="请选择或拖入视频文件路径…"
          class="input grow"
          @change="setVideoPath(($event.target as HTMLInputElement).value)"
        />
        <TButton label="浏览…" variant="secondary" @click="pickVideo" />
        <TButton
          label="开始预测"
          icon="play"
          :loading="state === 'extracting' || state === 'predicting'"
          :disabled="!videoPath || state === 'extracting' || state === 'predicting'"
          @click="startPredict"
        />
        <TButton
          v-if="state !== 'idle'"
          label="重置"
          variant="ghost"
          size="small"
          @click="resetResult"
        />
      </div>

      <!-- 底部状态栏（对照 lbl_status） -->
      <div v-if="progressText" class="status-text">{{ progressText }}</div>
      <div v-if="errorMsg" class="error-msg">⚠ {{ errorMsg }}</div>
    </section>

    <!-- 关键帧预览（对照 frames_scroll，真实缩略图） -->
    <section v-if="frames.length" class="card frames-card">
      <div class="card-title">
        关键帧预览（共 {{ frames.length }} 帧<template v-if="duration">，视频时长 {{ duration.toFixed(1) }}s</template>）
      </div>
      <div class="frames-strip">
        <figure v-for="f in frames" :key="f.path" class="frame-item" :title="f.path">
          <img class="frame-img" :src="jpegDataUrl(f.base64)" :alt="`${f.timeSec}s`" loading="lazy" />
          <figcaption class="frame-time">{{ f.timeSec }}s</figcaption>
        </figure>
      </div>
    </section>

    <!-- 结果卡（对照 result_card） -->
    <section v-if="result" class="card result-card">
      <!-- 顶部：综合分 + 量级 + 黄金3秒 + 雷达图 -->
      <div class="result-top">
        <div class="total-score" :style="{ color: totalColor }">{{ result.total }}</div>
        <div class="total-info">
          <div class="total-cap">综合预测分</div>
          <div class="level" :style="{ color: levelColor }">{{ result.play_level }}</div>
          <div class="golden" :class="result.golden3s ? 'ok' : 'bad'">
            {{ result.golden3s ? '✅ 黄金3秒合格' : '❌ 黄金3秒不合格' }}
          </div>
        </div>

        <!-- 雷达图（对照 RadarChartWidget.paintEvent） -->
        <svg
          class="radar"
          :width="radar.size"
          :height="radar.size"
          :viewBox="`0 0 ${radar.size} ${radar.size}`"
        >
          <polygon
            v-for="(ring, ri) in radar.rings"
            :key="`ring-${ri}`"
            :points="toSvgPoints(ring)"
            fill="none"
            stroke="#3a3a4a"
            stroke-width="1"
            stroke-dasharray="3,3"
          />
          <line
            v-for="(ax, ai) in radar.axes"
            :key="`axis-${ai}`"
            :x1="radar.cx" :y1="radar.cy" :x2="ax.x" :y2="ax.y"
            stroke="#4a4a5a" stroke-width="1"
          />
          <polygon
            :points="toSvgPoints(radar.polygon)"
            :fill="RADAR_FILL"
            stroke="#2ecc71"
            stroke-width="2"
          />
          <text
            v-for="lb in radar.labels"
            :key="lb.dim"
            :x="lb.x" :y="lb.y"
            :fill="lb.color"
            text-anchor="middle"
            class="radar-label"
          >
            <tspan :x="lb.x" dy="-0.3em">{{ lb.dim }}</tspan>
            <tspan :x="lb.x" dy="1.2em">{{ lb.score }}</tspan>
          </text>
        </svg>
      </div>

      <!-- 6 维评分卡（对照 DimScoreCard，边框/分值色取 DIM_COLORS） -->
      <div class="dims-grid">
        <div
          v-for="dim in DIMENSIONS"
          :key="dim"
          class="dim-card"
          :style="{ borderColor: DIM_COLORS[dim] }"
        >
          <div class="dim-title">{{ dim }}</div>
          <div class="dim-score" :style="{ color: DIM_COLORS[dim] }">{{ result.dims[dim] }}</div>
        </div>
      </div>

      <!-- 总评 -->
      <div class="block">
        <div class="section-title">💬 一句话总评</div>
        <div class="block-text">{{ result.comment || '—' }}</div>
      </div>

      <!-- 改进建议 -->
      <div class="block">
        <div class="section-title">🛠 改进建议</div>
        <ul v-if="result.suggestions.length" class="bullet-list">
          <li v-for="(s, i) in result.suggestions" :key="i">{{ s }}</li>
        </ul>
        <div v-else class="block-text">—</div>
      </div>
    </section>

    <!-- 反馈回填（对照 _save_feedback → set_feedback） -->
    <section v-if="result" class="card feedback-card">
      <div class="card-title">📝 回填真实数据（发布后填写，模型据此校准下次预测）</div>
      <div class="row">
        <label class="label">真实播放量:</label>
        <input v-model="feedbackPlay" placeholder="如 12.5万 / 8000" class="input grow" />
        <label class="label">平台评价/标签:</label>
        <input
          v-model="feedbackEval"
          placeholder="如：被推荐 / 限流 / 上热门 / 完播率低"
          class="input grow2"
        />
        <TButton label="保存反馈" variant="secondary" @click="saveFeedback" />
      </div>
      <div v-if="feedbackHint" class="status-text">{{ feedbackHint }}</div>
    </section>

    <!-- 待回填历史（对照 pending_feedback） -->
    <section v-if="pendingRecords.length" class="card history-card">
      <div class="card-title">🕓 待回填的预测记录（{{ pendingRecords.length }} 条）</div>
      <div class="history-list">
        <button
          v-for="rec in pendingRecords.slice(0, 20)"
          :key="rec.id"
          class="history-item"
          @click="pickPendingRecord(rec)"
        >
          <span class="h-platform">{{ rec.platform || '—' }}</span>
          <span class="h-name" :title="rec.video_path">{{ rec.video_name || '（无文件名）' }}</span>
          <span class="h-score">预测 {{ rec.predicted?.total ?? '?' }} 分 / {{ rec.predicted?.play_level || '?' }}</span>
        </button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.video-score {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  padding: var(--space-6);
  overflow-y: auto;
  height: 100%;
}

.header { display: flex; flex-direction: column; gap: var(--space-2); }
.title { margin: 0; font-size: var(--font-size-h1); color: var(--foreground); }
.subtitle {
  margin: 0;
  font-size: 13px;
  color: var(--muted-foreground);
  line-height: 1.6;
}

.warning {
  padding: 8px 14px;
  background: rgba(245, 158, 11, 0.1);
  border: 1px solid rgba(245, 158, 11, 0.3);
  border-radius: var(--radius-md);
  color: #f59e0b;
  font-weight: 600;
  font-size: 12px;
}

.card {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-4) var(--space-5);
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
}
.card-title { font-size: 13px; font-weight: 600; color: var(--foreground); }

.row { display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap; }
.grow { flex: 1; min-width: 180px; }
.grow2 { flex: 2; min-width: 180px; }
.w120 { width: 120px; flex: none; }
.spacer { flex: 1; }
.label { font-size: 13px; font-weight: 600; color: var(--foreground); white-space: nowrap; }

.input {
  height: 32px;
  padding: 0 10px;
  background: var(--surface-container, var(--card));
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  color: var(--foreground);
  outline: none;
  font-size: 13px;
}
.input:focus { border-color: var(--primary); }

/* ── 模型状态卡 ── */
.model-bar { flex-direction: row; align-items: center; gap: var(--space-3); flex-wrap: wrap; }
.model-info { font-size: 13px; font-weight: 700; color: var(--foreground); }
.model-status { font-size: 13px; font-weight: 700; }
.model-calib { font-size: 12px; color: var(--muted-foreground); }

.status-text { font-size: 12px; color: var(--primary); font-weight: 500; }
.error-msg {
  font-size: 12px;
  color: #e74c3c;
  white-space: pre-wrap;
  line-height: 1.6;
}

/* ── 关键帧（对照 frames_scroll 固定高 124，横向滚动） ── */
.frames-strip {
  display: flex;
  gap: 6px;
  overflow-x: auto;
  padding-bottom: 4px;
}
.frame-item { margin: 0; flex: none; text-align: center; }
.frame-img {
  height: 104px;              /* 对照 scaledToHeight(104) */
  width: auto;
  display: block;
  border-radius: var(--radius-sm, 4px);
  border: 1px solid var(--border);
  background: #000;
}
.frame-time { font-size: 11px; color: var(--muted-foreground); margin-top: 2px; }

/* ── 结果卡 ── */
.result-top { display: flex; align-items: center; gap: var(--space-5); flex-wrap: wrap; }
.total-score { font-size: 46px; font-weight: 700; line-height: 1; }
.total-info { display: flex; flex-direction: column; gap: 4px; min-width: 140px; }
.total-cap { font-size: 13px; color: var(--muted-foreground); }
.level { font-size: 18px; font-weight: 700; }
.golden { font-size: 12px; }
.golden.ok { color: #2ecc71; }
.golden.bad { color: #e74c3c; }

.radar { flex: none; }
.radar-label { font-size: 9px; font-weight: 700; }

.dims-grid { display: grid; grid-template-columns: repeat(6, 1fr); gap: var(--space-3); }
.dim-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: var(--space-3);
  background: var(--surface-container, rgba(255, 255, 255, 0.03));
  border: 2px solid var(--border);
  border-radius: var(--radius-lg);
}
.dim-title { font-size: 12px; color: var(--muted-foreground); font-weight: 600; }
.dim-score { font-size: 24px; font-weight: 700; }

.block { display: flex; flex-direction: column; gap: var(--space-2); }
.section-title { font-size: 13px; font-weight: 600; color: var(--foreground); }
.block-text { font-size: 13px; color: var(--muted-foreground); line-height: 1.7; }
.bullet-list {
  margin: 0;
  padding-left: 20px;
  font-size: 13px;
  color: var(--muted-foreground);
  line-height: 1.8;
}

/* ── 待回填历史 ── */
.history-list { display: flex; flex-direction: column; gap: 6px; max-height: 220px; overflow-y: auto; }
.history-item {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: 6px 10px;
  background: var(--surface-container, transparent);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  color: var(--foreground);
  font-size: 12px;
  cursor: pointer;
  text-align: left;
}
.history-item:hover { border-color: var(--primary); }
.h-platform {
  flex: none;
  padding: 1px 8px;
  border-radius: 10px;
  background: rgba(139, 92, 246, 0.18);
  color: #a78bfa;
  font-weight: 600;
}
.h-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.h-score { flex: none; color: var(--muted-foreground); }

@media (max-width: 1100px) {
  .dims-grid { grid-template-columns: repeat(3, 1fr); }
}
</style>
