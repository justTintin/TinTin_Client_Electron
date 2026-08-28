<script setup lang="ts">
// ═══════════════════════════════════════════════════════════════
// CardPlatform — 平台接入卡（LLM 设置 / 服务接入，纯展示组件）
// 模板自 Settings.vue L349-434 原样迁出（IRON-08）；
// 表单值经可写 computed 代理转为 update:* 上抛，容器接线到
// useSettingsGeneral；无专属样式（全部走 settings-shared.css）。
// ═══════════════════════════════════════════════════════════════

import { computed } from 'vue'

const props = defineProps<{
  platTabs: string[]
  activeTab: string
  modelOptions: string[]
  defaultModel: string
  apiKey: string
  baseUrl: string
  providerName: string
  providerLoaded: boolean
  webSearch: boolean
  savingLlm: boolean
  testingLlm: boolean
  serverDesc: string
  serverUrl: string
  savingServerUrl: boolean
}>()

const emit = defineEmits<{
  (e: 'update:activeTab', v: string): void
  (e: 'update:defaultModel', v: string): void
  (e: 'update:webSearch', v: boolean): void
  (e: 'update:serverUrl', v: string): void
  (e: 'save-llm'): void
  (e: 'save-server-url'): void
  (e: 'refresh-server'): void
  (e: 'test-llm'): void
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
        <p class="luo-card-desc">配置大模型 API、服务账号与联网能力。</p>
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
      <!-- LLM 设置（模型选择本地保存；Key/URL 由服务端 Provider 管理，只读回显） -->
      <div v-if="curTab === 'LLM 设置'">
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
            <div class="setting-label">API Key</div>
            <div class="setting-desc">由服务端 Provider 统一管理，此处仅回显</div>
          </div>
          <span class="input w-72 readonly-field" :title="apiKey || '服务端离线，无法读取'">
            {{ apiKey || (providerLoaded ? '未配置' : '服务端离线，无法读取') }}
          </span>
        </div>
        <div class="setting-row">
          <div>
            <div class="setting-label">Base URL</div>
            <div class="setting-desc">{{ providerName ? `${providerName} · 由服务端管理` : '由服务端 Provider 统一管理' }}</div>
          </div>
          <span class="input w-72 readonly-field" :title="baseUrl || '服务端离线，无法读取'">
            {{ baseUrl || (providerLoaded ? '未配置' : '服务端离线，无法读取') }}
          </span>
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

      <!-- 服务接入 -->
      <div v-else>
        <div class="setting-row">
          <div>
            <div class="setting-label">服务端地址</div>
            <div class="setting-desc">AI 推理服务地址，保存后立即生效并重新探测</div>
          </div>
          <div class="server-url-row">
            <input v-model="curServerUrl" type="text" class="input w-56" placeholder="http://192.168.x.x:8000" />
            <button class="btn-secondary-sm" :disabled="savingServerUrl" @click="emit('save-server-url')">
              {{ savingServerUrl ? '保存中…' : '保存' }}
            </button>
          </div>
        </div>
        <div class="setting-row">
          <div>
            <div class="setting-label">本地服务端</div>
            <div class="setting-desc">{{ serverDesc }}</div>
          </div>
          <button class="btn-secondary-sm" @click="emit('refresh-server')">刷新状态</button>
        </div>
        <div class="setting-row">
          <div>
            <div class="setting-label">LLM 连接测试</div>
            <div class="setting-desc">向当前模型发送一条探测消息以校验接入</div>
          </div>
          <button class="btn-secondary-sm primary-sm" :disabled="testingLlm" @click="emit('test-llm')">
            {{ testingLlm ? '测试中…' : '测试连接' }}
          </button>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
/* 只读回显字段（Key/URL 由服务端管理）：弱化输入框外观 */
.readonly-field {
  display: inline-block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  opacity: 0.85;
  cursor: default;
}
/* 服务端地址行：输入框 + 保存按钮并排 */
.server-url-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
</style>
