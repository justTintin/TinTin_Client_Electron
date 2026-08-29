<script setup lang="ts">
// ═══════════════════════════════════════════════════════════════
// CardAccountLogin — 设置页「账号与登录」卡（纯展示，条目⑩ S6+S7）
// 飞书配置：七字段对齐原 gui/main_window_aiconfig.py load/save_feishu_config
//   L537-583（AppId/AppSecret/AppToken/TableId/TopicField/ScriptField/FolderToken）；
//   测试连接对照 _test_feishu L584-600。
// 即梦登录：原版 CLI 设备码 OAuth（L481-536）新端不可复用，口径替换为
//   浏览器「即梦AI」平台 Tab 登录 + cookie 登录态检测（复用条目⑧链路）。
// 业务逻辑在 composables/useSettingsAccounts.ts，本组件只绘制 + 事件转发。
// ═══════════════════════════════════════════════════════════════

import { computed, ref } from 'vue'
import { loginStateText } from '../../browser/composables/useBrowserLogin'
import type { LoginState } from '../../browser/composables/useBrowserLogin'
import type { FeishuFieldMeta } from '../../composables/settingsAccountLogic'
import type { ConnTestResult } from '../../composables/useSettingsAccounts'

const props = defineProps<{
  fields: FeishuFieldMeta[]
  /** 字段当前值 getter（AppSecret 返回空串——明文不回显） */
  getField: (key: string) => string
  appSecretMasked: string
  saving: boolean
  hint: string
  testBusy: boolean
  testResult: ConnTestResult | null
  jimengState: LoginState
  jimengChecking: boolean
  douyinState: LoginState
  douyinChecking: boolean
}>()

const emit = defineEmits<{
  (e: 'save'): void
  (e: 'test-conn'): void
  (e: 'check-jimeng'): void
  (e: 'check-douyin'): void
  (e: 'field-input', key: string, v: string): void
}>()

const tabs = ['飞书', '即梦', '抖音']
const curTab = ref('飞书')

const jimengDesc = computed(() => {
  const s = props.jimengState
  if (s === 'logged_in') return '已登录（浏览器「即梦AI」分区会话有效）'
  if (s === 'logged_out') return '未登录：请到 浏览器 → 即梦AI 登录后重试'
  return s === 'checking' ? '检测中…' : '未检测'
})

const douyinDesc = computed(() => {
  const s = props.douyinState
  if (s === 'logged_in') return '已登录（浏览器「抖音」分区会话有效，sessionid cookie 命中）'
  if (s === 'logged_out') return '未登录：请到 浏览器 → 抖音 登录后重试'
  return s === 'checking' ? '检测中…' : '未检测'
})
</script>

<template>
  <section class="luo-card">
    <div class="luo-card-head">
      <div>
        <h2 class="luo-card-title">账号与登录</h2>
        <p class="luo-card-desc">飞书多维表格凭证与即梦登录态（凭证脱敏存储）。</p>
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
      <!-- ── 飞书：七字段 + 保存 + 测试连接 ── -->
      <div v-if="curTab === '飞书'">
        <div v-for="f in fields" :key="f.key" class="feishu-field">
          <label class="feishu-label" :for="`feishu-${f.key}`">{{ f.label }}</label>
          <input
            :id="`feishu-${f.key}`"
            type="text"
            class="input w-56"
            :value="getField(f.key)"
            :placeholder="f.secret
              ? (appSecretMasked ? `已保存（${appSecretMasked}），留空保持不变` : (f.placeholder || ''))
              : (f.placeholder || '')"
            autocomplete="off"
            spellcheck="false"
            @input="emit('field-input', f.key, ($event.target as HTMLInputElement).value)"
          />
        </div>
        <div class="setting-row">
          <div>
            <div class="setting-label">保存飞书配置</div>
            <div class="setting-desc">保存到本地（electron-store），主进程可读；Secret 脱敏不回显</div>
          </div>
          <button class="btn-secondary-sm primary-sm" :disabled="saving" @click="emit('save')">
            {{ saving ? '保存中…' : '保存' }}
          </button>
        </div>
        <div class="setting-row">
          <div>
            <div class="setting-label">测试连接</div>
            <div class="setting-desc">
              {{ testResult ? testResult.message : '以 App ID + Secret 换取 tenant_access_token' }}
            </div>
          </div>
          <button class="btn-secondary-sm" :disabled="testBusy" @click="emit('test-conn')">
            {{ testBusy ? '测试中…' : '测试' }}
          </button>
        </div>
        <div v-if="testResult" class="feishu-test-state" :class="testResult.ok ? 'ok' : 'no'">
          <span class="state-dot" />
          {{ testResult.ok ? '连接成功' : '连接失败' }}
        </div>
        <div v-if="hint" class="env-hint">{{ hint }}</div>
      </div>

      <!-- ── 即梦：登录态检测（原 CLI 设备码 OAuth 已按新端口径替换） ── -->
      <div v-else-if="curTab === '即梦'">
        <div class="setting-row">
          <div>
            <div class="setting-label">即梦登录状态</div>
            <div class="setting-desc">{{ jimengDesc }}</div>
          </div>
          <button class="btn-secondary-sm" :disabled="jimengChecking" @click="emit('check-jimeng')">
            {{ jimengChecking ? '检测中…' : '检测登录态' }}
          </button>
        </div>
        <div class="setting-row">
          <div>
            <div class="setting-label">如何登录</div>
            <div class="setting-desc">
              打开 浏览器 → 平台「即梦AI」→ 登录账号；分区会话（persist:tintin-jimeng）保持登录态，
              此处检测 cookie 特征（sessionid）。
            </div>
          </div>
          <span class="login-badge" :class="jimengState">{{ loginStateText(jimengState) }}</span>
        </div>
      </div>

      <!-- ── 抖音：账号信息（S9 对齐原账号页；来源=浏览器分区 cookie 登录态） ── -->
      <div v-else>
        <div class="setting-row">
          <div>
            <div class="setting-label">抖音账号登录状态</div>
            <div class="setting-desc">{{ douyinDesc }}</div>
          </div>
          <button class="btn-secondary-sm" :disabled="douyinChecking" @click="emit('check-douyin')">
            {{ douyinChecking ? '检测中…' : '检测登录态' }}
          </button>
        </div>
        <div class="setting-row">
          <div>
            <div class="setting-label">账号信息来源</div>
            <div class="setting-desc">
              浏览器「抖音」分区会话 cookie（persist:tintin-douyin，douyin.com + sessionid）；
              昵称/头像需页面 DOM 提取（不稳定），以登录态 cookie 为准。原账号页
              「添加新账户 / 发布视频清单」依赖平台接口，登记后置。
            </div>
          </div>
          <span class="login-badge" :class="douyinState">{{ loginStateText(douyinState) }}</span>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
/* 飞书字段纵排（七字段较多，setting-row 双列放不下） */
.feishu-field {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: 6px 0;
}
.feishu-label {
  flex: 0 0 auto;
  font-size: 13px;
  color: var(--foreground);
  font-weight: 500;
}

/* 测试连接状态色（对照原版状态标签 绿成功/红失败） */
.feishu-test-state {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 8px 12px;
  border-radius: var(--radius-md);
  font-size: 12px;
  font-weight: 600;
}
.feishu-test-state.ok { color: var(--success); background: rgba(16, 185, 129, 0.08); }
.feishu-test-state.no { color: var(--error); background: rgba(239, 68, 68, 0.08); }
.state-dot {
  width: 8px;
  height: 8px;
  border-radius: 999px;
  background: currentColor;
}

/* 即梦登录态徽章 */
.login-badge {
  padding: 4px 10px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
  border: 1px solid var(--border);
  color: var(--muted-foreground);
  white-space: nowrap;
}
.login-badge.logged_in {
  color: var(--success);
  background: rgba(16, 185, 129, 0.10);
  border-color: rgba(16, 185, 129, 0.30);
}
.login-badge.logged_out {
  color: var(--error);
  background: rgba(239, 68, 68, 0.06);
  border-color: rgba(239, 68, 68, 0.22);
}
</style>
