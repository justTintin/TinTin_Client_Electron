<script setup lang="ts">
// ═════════════════════════════════════════════════════════════
// CopyStep1Panel.vue — 文案混剪 Step1 文案编写面板
// 2026-09-21 用户裁决：按参考界面重排——高级脚本设置（生成方式/段落数量/自定义要求/
// 系统提示）+ AI 生成视频文案与关键词；原「选择素材 + 智能镜头分割」自本页删除
// （分割/素材编排仍保留在 useCopywritingMontageStep1Split，供「镜头重组」页链路使用）。
// 状态经 inject 解构回原名（零改动）；本页提示词组装与生成在 useCopywritingMontage。
// ═════════════════════════════════════════════════════════════
import { ref, computed, onMounted, inject } from 'vue'
import TButton from '@/components/common/TButton.vue'
import CopyStoryboard from './CopyStoryboard.vue'
import TSelect from '@/components/common/TSelect.vue'
import VdStepBar from '../VdStepBar.vue'
import WbPickProductDialog from '@/components/workbench/WbPickProductDialog.vue'
import { copywritingMontageShellKey } from './copywritingMontageUiContext'

const shell = inject(copywritingMontageShellKey)!
const { step, go, steps } = shell
const {
  // 文案编写（2026-09-21 用户裁决：高级脚本设置 + AI 生成视频文案与关键词）
  sharedProductInfo, applyScriptProduct, clearScriptProduct,
  manualCopy, manualCopyBusy, suggestDuration, activeNarrative,
  scriptProvider, scriptProviderOptions, paragraphCount, customRequirement, systemPrompt,
  scriptScene, SCRIPT_SCENE_OPTIONS,
  resetSystemPrompt, promptPreviewDlg, openPromptPreview, closePromptPreview,
  genScriptAndKeywords, loadScriptProviders,
} = shell.s

/** 高级脚本设置弹窗（2026-09-21 用户裁决：高级设置改弹出窗；场景选择置于入口之后） */
const showAdvDlg = ref(false)

/* ── 选择产品（公共弹窗；选中后显示在按钮后面，写入 sharedProductInfo 单一来源）── */
const pickDlgVisible = ref(false)
const productLabel = computed(() => {
  const i = sharedProductInfo.value
  const base = [i.brand, i.product, i.model].map((v) => String(v || '').trim()).filter(Boolean).join(' / ')
  const extras = String(i.extra || '').split('\n').map((s) => s.trim()).filter(Boolean)
  return extras.length ? `${base}（${extras.length} 条卖点）` : base
})

onMounted(() => { void loadScriptProviders() })
</script>

<template>
      <section class="card">
        <VdStepBar :step="step" :steps="steps" @go="go" />

        <!-- 选择产品（公共弹窗；选中产品显示在其右侧，写入 sharedProductInfo 供本页生成与后续链路共用） -->
        <div class="row product-row">
          <TButton label="选择产品" icon="search" @click="pickDlgVisible = true" />
          <template v-if="productLabel">
            <span class="product-chip" :title="productLabel">当前产品：{{ productLabel }}</span>
            <button class="product-clear" title="清除已选产品" @click="clearScriptProduct">×</button>
          </template>
        </div>

        <!-- 高级脚本设置入口（弹窗）+ 场景选择（2026-09-21 用户裁决：高级设置改弹窗，
             场景选择放在入口之后；场景指令并入发给 LLM 的系统提示词） -->
        <div class="row adv-row">
          <TButton label="高级脚本设置" icon="settings" variant="secondary" @click="showAdvDlg = true" />
          <label class="field-label">场景</label>
          <span class="info-i" title="场景指令与产品信息会并入系统提示词一并发给大模型（「预览最终提示词」可查看合并结果）">ⓘ</span>
          <TSelect v-model="scriptScene" :options="SCRIPT_SCENE_OPTIONS" class="scene-select" />
          <label class="field-label">
            建议时长
            <span class="info-i" title="按口播约 4 字/秒估算；切换场景时自动取该场景默认值，可手动调整">ⓘ</span>
          </label>
          <input v-model.number="suggestDuration" type="number" min="5" max="600" step="5" class="input w70" />
          <span class="field-label">秒</span>
          <!-- 2026-09-21 用户裁决：AI 生成文案和关键词按钮放到场景后面同一行 -->
          <TButton label="✨ 点击使用AI生成视频文案" :loading="manualCopyBusy" @click="genScriptAndKeywords" />
        </div>

        <div class="field">
          <label class="field-label">
            视频文案（可选）
            <span class="info-i" title="可直接手动编写，或点击上方按钮由 AI 生成。2026-09-21 用户裁决：口播文案与分镜脚本绑定——有分镜脚本时本框即激活分镜的旁白（克隆声音以此为准），无分镜时为全局草稿（随本地设置保存）">ⓘ</span>
          </label>
          <textarea
            v-model="activeNarrative"
            class="input ta ta--copy"
            rows="12"
            placeholder="在此编写视频文案，或点击上方按钮由 AI 生成"
          />
        </div>

        <!-- 分镜脚本（2026-09-21 用户裁决：生成脚本的界面与逻辑自第二步移到本页文案下方；
             生成后作为四步公共显示组件，每步都有、只是状态不同——本步为编辑态） -->
        <CopyStoryboard mode="edit" />


      </section>

      <!-- 底部导航条 -->
      <div class="row">
        <span class="spacer"></span>
        <TButton label="下一步：口播配音" icon="right" @click="go(1)" />
      </div>

      <!-- 选择产品公共弹窗（WbPickProductDialog：TDialog 壳 + WbPickProductPanel，单选上报后自动关闭） -->
      <WbPickProductDialog
        :visible="pickDlgVisible"
        @close="pickDlgVisible = false"
        @pick="applyScriptProduct"
      />

      <!-- 高级脚本设置弹窗（2026-09-21 用户裁决：改弹出窗；表单项实时绑定即时生效） -->
      <teleport to="body">
        <div v-if="showAdvDlg" class="modal-mask" @click.self="showAdvDlg = false">
          <div class="modal modal--adv">
            <span class="modal-title">高级脚本设置</span>
            <div class="field">
              <label class="field-label">
                文案生成方式
                <span class="info-i" title="选择生成文案所用的大模型；「当前大模型 Provider」= 服务端默认模型（设置页可改）">ⓘ</span>
              </label>
              <TSelect v-model="scriptProvider" :options="scriptProviderOptions" />
            </div>
            <div class="field">
              <label class="field-label">文案段落数量</label>
              <input v-model.number="paragraphCount" type="number" min="1" max="20" step="1" class="input w80" />
            </div>
            <div class="field">
              <label class="field-label">自定义文案要求</label>
              <textarea
                v-model="customRequirement"
                class="input ta"
                rows="3"
                placeholder="例：语气更轻松，适合小红书风格，面向年轻用户，并带有悬念"
              />
            </div>
            <div class="field">
              <label class="field-label">系统提示</label>
              <textarea
                v-model="systemPrompt"
                class="input ta ta--sys"
                rows="8"
                spellcheck="false"
              />
            </div>
            <div class="row">
              <TButton label="恢复默认提示词" icon="refresh" plain @click="resetSystemPrompt" />
              <TButton label="预览最终提示词" icon="search" plain @click="openPromptPreview" />
            </div>
            <div class="modal-actions"><TButton label="完成" @click="showAdvDlg = false" /></div>
          </div>
        </div>
      </teleport>

      <!-- 预览最终提示词弹窗（只读展示 system + user 两条消息） -->
      <teleport to="body">
        <div v-if="promptPreviewDlg.show" class="modal-mask" @click.self="closePromptPreview">
          <div class="modal modal-wide">
            <span class="modal-title">预览最终提示词</span>
            <div class="prompt-block">
              <label class="field-label">系统提示（system）</label>
              <textarea readonly class="input ta prompt-ta" rows="8">{{ promptPreviewDlg.system }}</textarea>
            </div>
            <div class="prompt-block">
              <label class="field-label">用户消息（user）</label>
              <textarea readonly class="input ta prompt-ta" rows="6">{{ promptPreviewDlg.user }}</textarea>
            </div>
            <div class="modal-actions"><TButton label="关闭" plain @click="closePromptPreview" /></div>
          </div>
        </div>
      </teleport>
</template>

<style scoped>
.card { display: flex; flex-direction: column; gap: var(--space-4); padding: var(--space-5); background: var(--card); border: 1px solid var(--border); border-radius: var(--radius-lg); }

/* 高级脚本设置：入口行 + 弹窗（2026-09-21 用户裁决：折叠块改弹窗） */
.adv-row :deep(.t-select) { flex: 1 1 auto; min-width: 220px; width: auto; }
.modal--adv { width: 640px; }

.field { display: flex; flex-direction: column; gap: 6px; }

.field-label { font-size: 13px; color: var(--foreground); display: inline-flex; align-items: center; gap: 4px; }

.info-i { color: var(--muted-foreground); font-size: 12px; cursor: help; }

.row { display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap; }

.spacer { flex: 1; }

.input { height: 32px; padding: 0 10px; background: var(--card); border: 1px solid var(--border); border-radius: var(--radius-md); color: var(--foreground); outline: none; font-size: 13px; }

.input:focus { border-color: var(--primary); }

.w80 { width: 80px; flex: none; }

/* textarea：源序在 .input 之后覆盖其 height:32px / padding:0 10px */
.ta {
  height: auto; min-height: 72px; padding: 8px 10px;
  line-height: 1.6; font-family: inherit; resize: vertical;
}

.ta--sys { min-height: 180px; font-size: 12px; line-height: 1.55; font-family: Consolas, Menlo, monospace; }

.ta--copy { min-height: 260px; }

/* ✨ AI 动作行（参考界面：全宽平铺行 + 星标图标） */
.ai-row {
  display: flex; align-items: center; justify-content: center; gap: 8px;
  width: 100%; height: 40px;
  background: color-mix(in srgb, var(--primary) 8%, var(--surface-container));
  border: 1px solid color-mix(in srgb, var(--primary) 30%, var(--border));
  border-radius: var(--radius-md); color: var(--foreground);
  font-size: 13px; font-weight: var(--font-weight-medium, 500); cursor: pointer;
  transition: border-color var(--duration-fast, 0.15s), background var(--duration-fast, 0.15s);
}

.ai-row:hover:not(:disabled) { border-color: var(--primary); background: color-mix(in srgb, var(--primary) 14%, var(--surface-container)); }

.ai-row:disabled { opacity: 0.55; cursor: not-allowed; }

.ai-row-icon { font-size: 14px; }

.divider { height: 1px; background: var(--border); flex: none; }

/* 选择产品行（高级脚本设置上方） */
.product-row { gap: var(--space-2); }

.product-chip {
  max-width: 60%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  padding: 4px 10px; background: color-mix(in srgb, var(--primary) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--primary) 35%, var(--border));
  border-radius: 999px; font-size: 12px; color: var(--foreground);
}

.product-clear {
  width: 22px; height: 22px; padding: 0; line-height: 1; font-size: 14px; flex: none;
  background: transparent; color: var(--muted-foreground);
  border: 1px solid var(--border); border-radius: 50%; cursor: pointer;
}

.product-clear:hover { color: var(--danger, #e74c3c); border-color: var(--danger, #e74c3c); }

.muted { color: var(--muted-foreground); font-size: 12px; }

/* 预览最终提示词弹窗 */
.modal-mask {
  position: fixed; inset: 0; z-index: 1002; display: flex; align-items: center; justify-content: center;
  background: rgba(0,0,0,.7);
}

.modal {
  display: flex; flex-direction: column; gap: 12px; width: 440px; max-width: 90vw; max-height: 80vh;
  padding: 20px; background: var(--card); border: 1px solid var(--border); border-radius: var(--radius-lg);
}

.modal-wide { width: 720px; }

.modal-title { font-size: 15px; font-weight: 600; }

.prompt-block { display: flex; flex-direction: column; gap: 6px; min-height: 0; }

.prompt-ta { min-height: 0; overflow-y: auto; white-space: pre; }

.modal-actions { display: flex; justify-content: flex-end; gap: 8px; }
</style>
