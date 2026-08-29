<script setup lang="ts">
// ═══════════════════════════════════════════════════════════════
// CardPlatformIntegration — 设置页「平台接入」卡（S8，纯展示组件）
// 对齐原客户端 gui/main_window_pages.py L990-1245 数字人 Tab 的平台配置：
//   · 数字人：workflowId（无服务端配置接口 → 本地 integration 域；
//     /digital-human/batch 默认 workflow_id 2085292185062297602）
//   · ComfyUI：host/port（PUT /comfyui/config，openapi ComfyUIConfig
//     host 默认 127.0.0.1 / port 默认 8188）+ 测试 GET /comfyui/status
//   · RunningHub：api_key/base_url/use_personal_queue（PUT /runninghub/config，
//     api_key 服务端持有，脱敏回显）+ 测试 GET /runninghub/status
// 业务逻辑在 composables/useSettingsIntegration.ts，本组件只绘制 + 事件转发。
// ═══════════════════════════════════════════════════════════════

import { computed } from 'vue'
import type { PlatformConnResult } from '../../composables/useSettingsIntegration'

const props = defineProps<{
  tabs: string[]
  activeTab: string
  workflowId: string
  comfyuiHost: string
  comfyuiPort: string
  rhApiKeyInput: string
  rhApiKeyMasked: string
  rhBaseUrl: string
  rhUsePersonalQueue: boolean
  saving: boolean
  hint: string
  testBusy: boolean
  testResult: PlatformConnResult | null
}>()

const emit = defineEmits<{
  (e: 'update:activeTab', v: string): void
  (e: 'update:workflowId', v: string): void
  (e: 'update:comfyuiHost', v: string): void
  (e: 'update:comfyuiPort', v: string): void
  (e: 'update:rhApiKeyInput', v: string): void
  (e: 'update:rhBaseUrl', v: string): void
  (e: 'update:rhUsePersonalQueue', v: boolean): void
  (e: 'save'): void
  (e: 'test-conn'): void
}>()

const curTab = computed({
  get: () => props.activeTab,
  set: (v: string) => emit('update:activeTab', v),
})
</script>

<template>
  <section class="luo-card">
    <div class="luo-card-head">
      <div>
        <h2 class="luo-card-title">平台接入</h2>
        <p class="luo-card-desc">数字人 / ComfyUI / RunningHub 平台连接配置（凭据脱敏存储）。</p>
      </div>
    </div>

    <div class="seg-wrap">
      <div class="segmented small">
        <button
          v-for="t in tabs"
          :key="t"
          class="seg-item"
          :class="{ active: curTab === t }"
          @click="curTab = t"
        >{{ t }}</button>
      </div>
    </div>

    <div class="setting-list">
      <!-- ── 数字人：workflowId（本地存储）── -->
      <div v-if="curTab === '数字人'">
        <div class="setting-row">
          <div>
            <div class="setting-label">数字人工作流 ID</div>
            <div class="setting-desc">
              数字人批量任务（/digital-human/batch）使用的工作流；服务端默认
              2085292185062297602，此处覆盖后存本地（无独立服务端配置接口）
            </div>
          </div>
          <input
            :value="workflowId"
            type="text"
            class="input w-56"
            placeholder="留空 = 服务端默认工作流"
            autocomplete="off"
            spellcheck="false"
            @input="emit('update:workflowId', ($event.target as HTMLInputElement).value)"
          />
        </div>
        <div class="setting-row">
          <div>
            <div class="setting-label">保存数字人配置</div>
            <div class="setting-desc">存本地（electron-store integration 域），提交时随 /digital-human/batch 使用</div>
          </div>
          <button class="btn-secondary-sm primary-sm" :disabled="saving" @click="emit('save')">
            {{ saving ? '保存中…' : '保存' }}
          </button>
        </div>
        <div class="setting-row">
          <div>
            <div class="setting-label">测试连接</div>
            <div class="setting-desc">数字人无独立测试接口；提交任务时经 /digital-human/batch 验证</div>
          </div>
          <button class="btn-secondary-sm" :disabled="testBusy" @click="emit('test-conn')">
            {{ testBusy ? '测试中…' : '测试' }}
          </button>
        </div>
      </div>

      <!-- ── ComfyUI：host/port（服务端 PUT /comfyui/config）── -->
      <div v-else-if="curTab === 'ComfyUI'">
        <div class="setting-row">
          <div>
            <div class="setting-label">ComfyUI 地址</div>
            <div class="setting-desc">保存到服务端（PUT /comfyui/config），服务端直连 ComfyUI 执行工作流</div>
          </div>
          <div class="comfyui-row">
            <input
              :value="comfyuiHost"
              type="text"
              class="input w-40"
              placeholder="127.0.0.1"
              autocomplete="off"
              spellcheck="false"
              @input="emit('update:comfyuiHost', ($event.target as HTMLInputElement).value)"
            />
            <span class="colon">:</span>
            <input
              :value="comfyuiPort"
              type="number"
              class="input w-24"
              placeholder="8188"
              @input="emit('update:comfyuiPort', ($event.target as HTMLInputElement).value)"
            />
          </div>
        </div>
        <div class="setting-row">
          <div>
            <div class="setting-label">保存 / 测试连接</div>
            <div class="setting-desc">测试走 GET /comfyui/status（在线状态）</div>
          </div>
          <div class="comfyui-actions">
            <button class="btn-secondary-sm" :disabled="testBusy" @click="emit('test-conn')">
              {{ testBusy ? '测试中…' : '测试连接' }}
            </button>
            <button class="btn-secondary-sm primary-sm" :disabled="saving" @click="emit('save')">
              {{ saving ? '保存中…' : '保存' }}
            </button>
          </div>
        </div>
      </div>

      <!-- ── RunningHub：api_key/base_url/开关（服务端 PUT /runninghub/config）── -->
      <div v-else>
        <div class="setting-row">
          <div>
            <div class="setting-label">RunningHub API Key</div>
            <div class="setting-desc">
              {{ rhApiKeyMasked ? `已保存（${rhApiKeyMasked}），留空保持不变` : '未保存；密钥保存在服务端' }}
            </div>
          </div>
          <input
            :value="rhApiKeyInput"
            type="password"
            class="input w-56"
            placeholder="rh_xxx（仅保存到服务端，不回显明文）"
            autocomplete="off"
            spellcheck="false"
            @input="emit('update:rhApiKeyInput', ($event.target as HTMLInputElement).value)"
          />
        </div>
        <div class="setting-row">
          <div>
            <div class="setting-label">Base URL</div>
            <div class="setting-desc">留空 = 服务端默认（https://www.runninghub.cn）</div>
          </div>
          <input
            :value="rhBaseUrl"
            type="text"
            class="input w-56"
            placeholder="https://www.runninghub.cn"
            autocomplete="off"
            spellcheck="false"
            @input="emit('update:rhBaseUrl', ($event.target as HTMLInputElement).value)"
          />
        </div>
        <div class="setting-row">
          <div>
            <div class="setting-label">个人队列</div>
            <div class="setting-desc">use_personal_queue：优先使用个人任务队列</div>
          </div>
          <button
            class="switch"
            :class="{ on: rhUsePersonalQueue }"
            role="switch"
            :aria-checked="rhUsePersonalQueue"
            @click="emit('update:rhUsePersonalQueue', !rhUsePersonalQueue)"
          ><span class="knob" /></button>
        </div>
        <div class="setting-row">
          <div>
            <div class="setting-label">保存 / 测试连接</div>
            <div class="setting-desc">测试走 GET /runninghub/status（连接状态 + 配置）</div>
          </div>
          <div class="comfyui-actions">
            <button class="btn-secondary-sm" :disabled="testBusy" @click="emit('test-conn')">
              {{ testBusy ? '测试中…' : '测试连接' }}
            </button>
            <button class="btn-secondary-sm primary-sm" :disabled="saving" @click="emit('save')">
              {{ saving ? '保存中…' : '保存' }}
            </button>
          </div>
        </div>
      </div>

      <div v-if="testResult" class="feishu-test-state" :class="testResult.ok ? 'ok' : 'no'">
        <span class="state-dot" />
        {{ testResult.ok ? '连接成功' : '连接失败' }} · {{ testResult.message }}
      </div>
      <div v-if="hint" class="env-hint">{{ hint }}</div>
    </div>
  </section>
</template>

<style scoped>
/* 专属样式（.setting-row/.setting-label/.setting-desc/.switch/.input/w-* 复用
   settings-shared.css 公用类；CardEnvMaint 同款复用模式） */
.comfyui-row { display: flex; align-items: center; gap: 6px; }
.comfyui-actions { display: flex; gap: var(--space-2); }
.colon { color: var(--muted-foreground); }

/* 测试连接状态色 */
.feishu-test-state { display: flex; align-items: center; gap: var(--space-2); padding: 8px 12px; border-radius: var(--radius-md); font-size: 12px; font-weight: 600; }
.feishu-test-state.ok { color: var(--success); background: rgba(16, 185, 129, 0.08); }
.feishu-test-state.no { color: var(--error); background: rgba(239, 68, 68, 0.08); }
.state-dot { width: 8px; height: 8px; border-radius: 999px; background: currentColor; }
.env-hint { margin-top: var(--space-2); padding: 8px 12px; border-radius: var(--radius-md); background: var(--surface-container); font-size: 12px; color: var(--primary); }
</style>
