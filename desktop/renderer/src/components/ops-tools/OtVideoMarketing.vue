<script setup lang="ts">
// ═══════════════════════════════════════════════════════════════
// OtVideoMarketing.vue — 视频营销检测（运营工具 · 完整实现）
//
// 对照原客户端 studio/gui/marketing_detect_page.py MarketingDetectPage.setup：
//   标题说明 → 实验性警告 → 视觉模型状态卡（信息/状态/测试连接）
//   → 输入栏（选择视频 + 浏览 + 开始检测 + 进度）
//   → 关键帧预览（横向缩略图，scaledToHeight 104）
//   → 结果卡（结论 + 置信度 / 推广分类 + 涉及品牌商品 / 营销线索 / 研判分析 / 改进建议）
//   → 底部状态栏
//
// 落地文档 §4.6：与视频评价预测共用「视频 → 关键帧 → 视觉模型」链路
//   （共用编排在 useVisionAnalyze，共用纯函数在 visionLogic）。
// 分层：本组件只绘制 + 事件转发；编排在 useVideoMarketing，纯计算在 videoMarketingLogic。
// ═══════════════════════════════════════════════════════════════
import { onMounted } from 'vue'
import { useVideoMarketing } from '@/composables/useVideoMarketing'
import { jpegDataUrl } from '@/composables/visionLogic'
import TButton from '@/components/common/TButton.vue'

const {
  videoPath, state, errorMsg, statusText,
  result, verdictText, verdictColor, confidenceText, confidenceColor,
  categoryText, productText,
  frames, duration,
  modelInfo, modelStatusText, modelStatusColor, canTestModel, testVisionModel,
  init, pickVideo, setVideoPath, reset, startDetect,
} = useVideoMarketing()

onMounted(() => { init() })
</script>

<template>
  <div class="video-marketing">
    <!-- 标题栏（对照 heading + ElidedLabel 说明） -->
    <div class="header">
      <h1 class="title">🎯 视频营销检测</h1>
      <p class="subtitle">
        提取视频关键帧 → 通过视觉大模型多维分析视频内容、字幕、场景，
        研判是否为广告推广/带货引流视频，并给出推广品类、营销线索与改进建议。
      </p>
    </div>

    <!-- 实验性警告（对照 warning_lbl） -->
    <div class="warning">⚠️ 注意：此为根据大模型预测，实验功能，不一定完全准确。</div>

    <!-- 视觉模型状态卡（对照 model_status_card） -->
    <section class="card model-bar">
      <span class="model-info">{{ modelInfo }}</span>
      <span class="model-status" :style="{ color: modelStatusColor }">{{ modelStatusText }}</span>
      <div class="spacer" />
      <TButton
        label="测试连接"
        variant="secondary"
        size="small"
        :disabled="!canTestModel"
        @click="testVisionModel()"
      />
    </section>

    <!-- 输入栏（对照 bar：选择视频 + 浏览 + 开始检测 + pbar） -->
    <section class="card input-bar">
      <div class="row">
        <label class="label">选择视频:</label>
        <input
          :value="videoPath"
          placeholder="请选择或拖入视频文件路径…"
          class="input grow"
          @change="setVideoPath(($event.target as HTMLInputElement).value)"
        />
        <TButton label="浏览…" variant="secondary" @click="pickVideo" />
        <TButton
          label="开始检测"
          icon="play"
          :loading="state === 'extracting' || state === 'detecting'"
          :disabled="!videoPath || state === 'extracting' || state === 'detecting'"
          @click="startDetect"
        />
        <TButton
          v-if="state !== 'idle'"
          label="重置"
          variant="ghost"
          size="small"
          @click="reset"
        />
      </div>

      <!-- 底部状态栏（对照 lbl_status） -->
      <div v-if="statusText" class="status-text">{{ statusText }}</div>
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

    <!-- 检测结果卡（对照 result_card + _render） -->
    <section v-if="result" class="card result-card">
      <!-- 顶部结论 + 置信度 -->
      <div class="verdict-row">
        <span class="verdict" :style="{ color: verdictColor }">{{ verdictText }}</span>
        <span class="confidence" :style="{ color: confidenceColor }">{{ confidenceText }}</span>
      </div>

      <!-- 属性网格（对照 QGridLayout：推广分类 / 涉及品牌商品） -->
      <div class="attr-grid">
        <div class="attr">
          <span class="attr-label">🏷 推广分类：</span>
          <span class="attr-value">{{ categoryText }}</span>
        </div>
        <div class="attr">
          <span class="attr-label">📦 涉及品牌/商品：</span>
          <span class="attr-value">{{ productText }}</span>
        </div>
      </div>

      <!-- 营销线索（对照 txt_clues） -->
      <div class="block">
        <div class="section-title">🔍 提取到的营销线索</div>
        <ul v-if="result.clues.length" class="bullet-list">
          <li v-for="(c, i) in result.clues" :key="i">{{ c }}</li>
        </ul>
        <div v-else class="block-text">—</div>
      </div>

      <!-- 详细研判分析（对照 txt_analysis） -->
      <div class="block">
        <div class="section-title">🧪 详细研判分析</div>
        <div class="block-text">{{ result.analysis || '—' }}</div>
      </div>

      <!-- 优化与改进建议（对照 txt_suggestions） -->
      <div class="block">
        <div class="section-title">🛠 优化与改进建议</div>
        <ul v-if="result.suggestions.length" class="bullet-list">
          <li v-for="(s, i) in result.suggestions" :key="i">{{ s }}</li>
        </ul>
        <div v-else class="block-text">—</div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.video-marketing {
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
.verdict-row { display: flex; align-items: baseline; gap: var(--space-3); flex-wrap: wrap; }
.verdict { font-size: 20px; font-weight: 700; }
.confidence { font-size: 15px; font-weight: 700; }

.attr-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-3);
}
.attr {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  background: var(--surface-container, rgba(255, 255, 255, 0.03));
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  font-size: 13px;
}
.attr-label { color: var(--muted-foreground); white-space: nowrap; }
.attr-value { color: var(--foreground); font-weight: 700; }

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

@media (max-width: 900px) {
  .attr-grid { grid-template-columns: 1fr; }
}
</style>
