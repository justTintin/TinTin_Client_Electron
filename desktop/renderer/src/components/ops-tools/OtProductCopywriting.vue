<script setup lang="ts">
// ═══════════════════════════════════════════════════════════════
// OtProductCopywriting.vue — 产品文案创作（媒体工具卡 · P1 实装）
// 2026-08-30 裁决：自原「方案脚本」组划归媒体工具 Tab。
// 对照 product_script_page.py 完整链路：
//   产品检索选择 → 性能参数&核心卖点回填（可临时编辑）→
//   生成设置（平台/语气/结构/话题标签/违禁词）+ 附加提示词 →
//   一键生成文案（llmChat）→ 极限词检测 → 复制 → 前往分镜脚本。
// 风格化（知识库条目）待知识库批次；分层：本组件只绘制 + 事件转发。
// ═══════════════════════════════════════════════════════════════

import { onMounted } from 'vue'
import { useRouter } from 'vue-router'
import {
  PLATFORM_OPTIONS,
  STRUCTURE_OPTIONS,
  TAG_OPTIONS,
  TONE_OPTIONS,
} from '../../composables/opsCopywritingLogic'
import { useOpsCopywriting } from '../../composables/useOpsCopywriting'

const C = useOpsCopywriting()
const router = useRouter()

/** 携带文案→分镜卡（goToStoryboard 写入 app store 草案信号） */
function goStoryboard(): void {
  if (C.goToStoryboard()) void router.push({ name: 'media-tools', query: { tool: 'storyboard' } })
}

onMounted(() => { void C.loadProducts() })
</script>

<template>
  <section class="opc">
    <!-- ═══ 左栏：产品选择 + 已保存资料（可临时编辑） ═══ -->
    <div class="opc-left">
      <div class="card">
        <div class="card-title">产品选择</div>
        <input
          class="input"
          type="text"
          placeholder="输入品牌/型号搜索产品…"
          :value="C.keyword.value"
          @input="C.onKeywordInput(($event.target as HTMLInputElement).value)"
        />
        <select class="input" :value="C.selectedProductId.value" @change="C.selectProduct(($event.target as HTMLSelectElement).value)">
          <option value="">--- 请选择产品 ---</option>
          <option v-if="C.productsError.value && !C.productOptions.value.length" disabled>{{ C.productsError.value }}</option>
          <option v-for="opt in C.productOptions.value" :key="opt.id" :value="opt.id">{{ opt.label }}</option>
        </select>
        <span v-if="C.productsLoading.value" class="hint">检索中…</span>
      </div>

      <div class="card">
        <div class="card-title">产品已保存资料（性能参数与核心卖点）</div>
        <label class="field">
          <span class="lbl">性能参数</span>
          <textarea
            class="input ta"
            placeholder="选择产品后自动显示；支持临时编辑…"
            v-model="C.features.value"
          ></textarea>
        </label>
        <label class="field">
          <span class="lbl">核心卖点</span>
          <textarea
            class="input ta"
            placeholder="选择产品后自动显示；支持临时编辑…"
            v-model="C.sellingPoints.value"
          ></textarea>
        </label>
      </div>

      <div class="card">
        <div class="card-title">风格化（可选）</div>
        <p class="hint">知识库模块分批实施中，风格化条目暂不可选；生成流程为纯产品驱动。</p>
      </div>
    </div>

    <!-- ═══ 右栏：生成设置 + 文案 ═══ -->
    <div class="opc-right">
      <div class="card">
        <div class="settings-grid">
          <label class="field">
            <span class="lbl">平台</span>
            <select class="input" v-model="C.platform.value">
              <option v-for="o in PLATFORM_OPTIONS" :key="o" :value="o">{{ o }}</option>
            </select>
          </label>
          <label class="field">
            <span class="lbl">语气</span>
            <select class="input" v-model="C.tone.value">
              <option v-for="o in TONE_OPTIONS" :key="o" :value="o">{{ o }}</option>
            </select>
          </label>
          <label class="field">
            <span class="lbl">结构</span>
            <select class="input" v-model="C.structure.value">
              <option v-for="o in STRUCTURE_OPTIONS" :key="o" :value="o">{{ o }}</option>
            </select>
          </label>
          <label class="field">
            <span class="lbl">话题标签</span>
            <select class="input" v-model="C.tags.value">
              <option v-for="o in TAG_OPTIONS" :key="o" :value="o">{{ o }}</option>
            </select>
          </label>
        </div>
        <label class="check-row">
          <input type="checkbox" v-model="C.avoidBanned.value" />
          规避平台违禁词 / 极限词
        </label>

        <label class="field">
          <span class="lbl">附加提示词（可选）</span>
          <textarea
            class="input ta short"
            placeholder="可输入额外要求，例如：时长约60秒 / 针对年轻女性 / 偏硬核测评风格 / 避免夸大词…"
            v-model="C.extraPrompt.value"
          ></textarea>
        </label>

        <div class="btn-row">
          <button class="btn" :disabled="C.generating.value" @click="C.checkExtreme">极端词检测</button>
          <button class="btn primary" :disabled="C.generating.value" @click="C.generate">
            {{ C.generating.value ? 'AI 正在创作文案…' : '生成文案' }}
          </button>
        </div>

        <label class="field">
          <span class="lbl">视频文案（可编辑）</span>
          <textarea
            class="input ta copy"
            placeholder="根据产品卖点（和可选风格化）生成的文案显示在这里；生成后可直接编辑。"
            v-model="C.copyText.value"
          ></textarea>
        </label>

        <div class="btn-row">
          <button class="btn" @click="C.copyToClipboard">复制文案</button>
          <button class="btn primary" @click="goStoryboard">前往分镜脚本设计 →</button>
        </div>

        <div v-if="C.status.value" class="status">{{ C.status.value }}</div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.opc { display: grid; grid-template-columns: minmax(280px, 2fr) 3fr; gap: var(--space-4); height: 100%; }
.opc-left, .opc-right { display: flex; flex-direction: column; gap: var(--space-4); min-height: 0; }
.opc-left { overflow-y: auto; }
.opc-right { overflow-y: auto; }

.card {
  background: var(--card); border: 1px solid var(--border);
  border-radius: var(--radius-lg); padding: var(--space-4);
  display: flex; flex-direction: column; gap: var(--space-3);
}
.card-title { font-size: 14px; font-weight: 700; color: var(--foreground); }
.hint { font-size: 12px; color: var(--muted-foreground); }

.input {
  height: 32px; padding: 0 10px; border-radius: var(--radius-md);
  border: 1px solid var(--border); background: var(--background);
  color: var(--foreground); font-size: 13px; width: 100%; box-sizing: border-box;
}
.ta { height: 96px; padding: 8px 10px; resize: vertical; line-height: 1.5; }
.ta.short { height: 64px; }
.ta.copy { height: 320px; flex: 1 1 auto; }

.field { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.lbl { font-size: 12px; color: var(--muted-foreground); }
.check-row { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--foreground); }

.settings-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-2) var(--space-3); }

.btn-row { display: flex; align-items: center; gap: var(--space-3); justify-content: flex-end; }
.btn {
  height: 32px; padding: 0 14px; border-radius: var(--radius-md);
  border: 1px solid var(--border); background: var(--surface-container);
  color: var(--foreground); font-size: 13px; font-weight: 500; cursor: pointer;
  transition: all var(--duration-fast); white-space: nowrap;
}
.btn:hover { border-color: var(--primary); color: var(--primary); }
.btn.primary { background: var(--primary); border-color: var(--primary); color: var(--primary-foreground); }
.btn.primary:hover { opacity: 0.9; }
.btn:disabled { opacity: 0.55; cursor: not-allowed; }

.status { font-size: 12px; color: var(--muted-foreground); line-height: 1.5; word-break: break-all; }

@media (max-width: 1000px) {
  .opc { grid-template-columns: 1fr; }
  .settings-grid { grid-template-columns: 1fr; }
}
</style>
