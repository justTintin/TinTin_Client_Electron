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
  webSearch: boolean
  testingLlm: boolean
  serverDesc: string
}>()

const emit = defineEmits<{
  (e: 'update:activeTab', v: string): void
  (e: 'update:defaultModel', v: string): void
  (e: 'update:apiKey', v: string): void
  (e: 'update:baseUrl', v: string): void
  (e: 'update:webSearch', v: boolean): void
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
const curKey = computed({
  get: () => props.apiKey,
  set: (v: string) => emit('update:apiKey', v),
})
const curUrl = computed({
  get: () => props.baseUrl,
  set: (v: string) => emit('update:baseUrl', v),
})
const searchOn = computed({
  get: () => props.webSearch,
  set: (v: boolean) => emit('update:webSearch', v),
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
      <!-- LLM 设置 -->
      <div v-if="curTab === 'LLM 设置'">
        <div class="setting-row">
          <div>
            <div class="setting-label">默认模型</div>
            <div class="setting-desc">选择会话中默认使用的模型</div>
          </div>
          <select v-model="curModel" class="input w-56">
            <option v-for="m in modelOptions" :key="m" :value="m">{{ m }}</option>
          </select>
        </div>
        <div class="setting-row">
          <div>
            <div class="setting-label">API Key</div>
            <div class="setting-desc">用于调用模型服务的密钥</div>
          </div>
          <input v-model="curKey" type="password" class="input w-72" />
        </div>
        <div class="setting-row">
          <div>
            <div class="setting-label">Base URL</div>
            <div class="setting-desc">自定义 API 代理地址</div>
          </div>
          <input v-model="curUrl" type="text" class="input w-72" />
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
      </div>

      <!-- 服务接入 -->
      <div v-else>
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
