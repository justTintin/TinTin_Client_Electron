<script setup lang="ts">
// ═══════════════════════════════════════════════════════════════
// CardPlatform — 平台接入卡（统一服务端地址 / 模型设置，纯展示组件）
// 2026-08-28「服务端配置业务对齐」用户裁决改造：
//   · 只有一个统一服务端地址（保存后联动各功能，自动拉取模型列表）
//   · 删除 Provider / API Key / URL 展示与独立「LLM 测试连接」
//     （LLM 凭证由服务端持有，模型列表从服务端拉取）
//   · 按功能测试连接（LLM/OCR/向量/TTS/ASR；探测逻辑在 useSettingsGeneral）
// 2026-08-30 用户裁决：本卡统一叫「平台接入」，仅保留 服务端/模型 两个 tab；
//   数字人/ComfyUI/RunningHub 已通过服务端接入（原客户端已删除直连配置），
//   不再保留任何直连配置入口。
// 表单值经可写 computed 代理转为 update:* 上抛，容器接线到
// useSettingsGeneral；无专属样式（全部走 settings-shared.css）。
// ═══════════════════════════════════════════════════════════════

import { computed } from 'vue'
import type { FuncTestResult } from '../../composables/useSettingsGeneral'

const props = defineProps<{
  platTabs: string[]
  activeTab: string
  modelOptions: string[]
  defaultModel: string
  webSearch: boolean
  savingLlm: boolean
  serverDesc: string
  serverUrl: string
  savingServerUrl: boolean
  testingFuncs: boolean
  funcResults: FuncTestResult[]
}>()

const emit = defineEmits<{
  (e: 'update:activeTab', v: string): void
  (e: 'update:defaultModel', v: string): void
  (e: 'update:webSearch', v: boolean): void
  (e: 'update:serverUrl', v: string): void
  (e: 'save-llm'): void
  (e: 'save-server-url'): void
  (e: 'refresh-server'): void
  (e: 'test-func', name: string): void
  (e: 'test-funcs-all'): void
}>()

/* 可写代理：模板保持原 v-model 写法，改动经 update:* 上抛容器 */
const curTab = computed({
  get: () => props.activeTab,
  set: (v: string) => emit('update:activeTab', v),
})
const curModel = computed({
  get: () => props.defaultModel,
  set: (v: string) => emit('update:defaultModel', v),
})
const searchOn = computed({
  get: () => props.webSearch,
  set: (v: boolean) => emit('update:webSearch', v),
})
const curServerUrl = computed({
  get: () => props.serverUrl,
  set: (v: string) => emit('update:serverUrl', v),
})
</script>

<template>
  <section class="luo-card">
    <div class="luo-card-head">
      <div>
        <h2 class="luo-card-title">平台接入</h2>
        <p class="luo-card-desc">配置统一服务端地址与数字人 / ComfyUI / RunningHub 连接；模型与各功能能力均由服务端提供，凭证不出服务端。</p>
      </div>
    </div>

    <div class="seg-wrap">
      <div class="segmented">
        <button
          v-for="t in platTabs"
          :key="t"
          class="seg-item"
          :class="{ active: curTab === t }"
          @click="curTab = t"
        >{{ t }}</button>
      </div>
    </div>

    <div class="setting-list">
      <!-- 服务端：单一统一地址 + 显式保存 + 总连通 / 按功能测试 -->
      <div v-if="curTab === '服务端'">
        <div class="setting-row">
          <div>
            <div class="setting-label">服务端地址</div>
            <div class="setting-desc">唯一统一地址，保存后立即生效并联动全部功能</div>
          </div>
          <div class="server-url-row">
            <input v-model="curServerUrl" type="text" class="input w-56" placeholder="http://192.168.x.x:8000" />
            <button class="btn-secondary-sm primary-sm" :disabled="savingServerUrl" @click="emit('save-server-url')">
              {{ savingServerUrl ? '保存中…' : '保存' }}
            </button>
          </div>
        </div>
        <div class="setting-row">
          <div>
            <div class="setting-label">总连通测试</div>
            <div class="setting-desc">{{ serverDesc }}</div>
          </div>
          <button class="btn-secondary-sm" @click="emit('refresh-server')">测试连接</button>
        </div>
        <div class="setting-row">
          <div>
            <div class="setting-label">按功能测试连接</div>
            <div class="setting-desc">对各功能端点（openapi 实际路径）分别发最小请求</div>
          </div>
          <button class="btn-secondary-sm" :disabled="testingFuncs" @click="emit('test-funcs-all')">
            {{ testingFuncs ? '测试中…' : '全部测试' }}
          </button>
        </div>
        <div v-for="r in funcResults" :key="r.name" class="setting-row">
          <div>
            <div class="setting-label func-name">
              <span class="func-dot" :class="r.ok === true ? 'ok' : r.ok === false ? 'no' : 'idle'" />
              {{ r.name }}
            </div>
            <div class="setting-desc">{{ r.message }}</div>
          </div>
          <button class="btn-secondary-sm" @click="emit('test-func', r.name)">测试</button>
        </div>
      </div>

      <!-- 模型：列表来自服务端（凭证由服务端持有，客户端只选模型） -->
      <div v-else-if="curTab === '模型'">
        <div class="setting-row">
          <div>
            <div class="setting-label">默认模型</div>
            <div class="setting-desc">选择会话中默认使用的模型（列表来自服务端）</div>
          </div>
          <select v-model="curModel" class="input w-56">
            <option v-for="m in modelOptions" :key="m" :value="m">{{ m }}</option>
          </select>
        </div>
        <div class="setting-row">
          <div>
            <div class="setting-label">启用联网搜索</div>
            <div class="setting-desc">让模型在必要时检索实时信息</div>
          </div>
          <button
            type="button"
            class="switch"
            :class="{ on: searchOn }"
            :aria-checked="searchOn"
            role="switch"
            @click="searchOn = !searchOn"
          >
            <span class="knob" />
          </button>
        </div>
        <div class="setting-row">
          <div>
            <div class="setting-label">保存配置</div>
            <div class="setting-desc">默认模型与联网搜索保存到本地</div>
          </div>
          <button class="btn-secondary-sm primary-sm" :disabled="savingLlm" @click="emit('save-llm')">
            {{ savingLlm ? '已保存' : '保存' }}
          </button>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
/* 服务端地址行：输入框 + 保存按钮并排 */
.server-url-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
/* 功能测试状态点：绿=正常 / 红=失败 / 灰=未测试 */
.func-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  margin-right: 6px;
  vertical-align: middle;
}
.func-dot.ok { background: var(--success); }
.func-dot.no { background: var(--error); }
.func-dot.idle { background: var(--muted-foreground); opacity: 0.45; }
</style>
