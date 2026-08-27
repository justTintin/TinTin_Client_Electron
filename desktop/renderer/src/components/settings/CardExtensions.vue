<script setup lang="ts">
// ═══════════════════════════════════════════════════════════════
// CardExtensions — 扩展插件卡（下载插件 / 自动上架，纯展示组件）
// 模板自 Settings.vue L702-818 原样迁出（IRON-08）；
// 字段经可写 computed 代理转为 update:* 上抛；业务动作
// browse-dir / browse-file / detect / save 由容器接线到
// useSettingsExtension。无共享样式依赖之外的专属样式仅 .svc-ok。
// ═══════════════════════════════════════════════════════════════

import { computed } from 'vue'

const props = defineProps<{
  extTabs: string[]
  activeTab: string
  bridgePort: string
  bridgeSaveDir: string
  extScanServer: boolean
  chromePort: string
  chromePath: string
  chromeDataDir: string
  shopKeyword: string
  cdpState: string
  cdpBusy: boolean
}>()

const emit = defineEmits<{
  (e: 'update:activeTab', v: string): void
  (e: 'update:bridgePort', v: string): void
  (e: 'update:bridgeSaveDir', v: string): void
  (e: 'update:extScanServer', v: boolean): void
  (e: 'update:chromePort', v: string): void
  (e: 'update:chromePath', v: string): void
  (e: 'update:chromeDataDir', v: string): void
  (e: 'update:shopKeyword', v: string): void
  (e: 'browse-dir', field: 'bridgeSaveDir' | 'chromeDataDir'): void
  (e: 'browse-file'): void
  (e: 'detect'): void
  (e: 'save'): void
}>()

/* 可写代理：模板保持原 v-model 写法，改动经 update:* 上抛容器 */
const curTab = computed({
  get: () => props.activeTab,
  set: (v: string) => emit('update:activeTab', v),
})
const curBridgePort = computed({
  get: () => props.bridgePort,
  set: (v: string) => emit('update:bridgePort', v),
})
const curSaveDir = computed({
  get: () => props.bridgeSaveDir,
  set: (v: string) => emit('update:bridgeSaveDir', v),
})
const curScan = computed({
  get: () => props.extScanServer,
  set: (v: boolean) => emit('update:extScanServer', v),
})
const curChromePort = computed({
  get: () => props.chromePort,
  set: (v: string) => emit('update:chromePort', v),
})
const curChromePath = computed({
  get: () => props.chromePath,
  set: (v: string) => emit('update:chromePath', v),
})
const curDataDir = computed({
  get: () => props.chromeDataDir,
  set: (v: string) => emit('update:chromeDataDir', v),
})
const curKeyword = computed({
  get: () => props.shopKeyword,
  set: (v: string) => emit('update:shopKeyword', v),
})
</script>

<template>
  <section class="luo-card">
    <div class="luo-card-head">
      <div>
        <h2 class="luo-card-title">扩展插件</h2>
        <p class="luo-card-desc">浏览器采集扩展与电商自动上架能力入口。</p>
      </div>
    </div>

    <div class="seg-wrap">
      <div class="segmented">
        <button
          v-for="t in extTabs"
          :key="t"
          class="seg-item"
          :class="{ active: curTab === t }"
          @click="curTab = t"
        >{{ t }}</button>
      </div>
    </div>

    <div class="setting-list">
      <template v-if="curTab === '下载插件'">
        <div class="setting-row">
          <div>
            <div class="setting-label">采集桥接服务端口</div>
            <div class="setting-desc">浏览器扩展桥接服务监听端口</div>
          </div>
          <input v-model="curBridgePort" type="text" class="input w-32" />
        </div>
        <div class="setting-row">
          <div>
            <div class="setting-label">采集保存目录</div>
            <div class="setting-desc">扩展采集结果的本地保存路径</div>
          </div>
          <div class="setting-row-right">
            <input v-model="curSaveDir" type="text" class="input w-64" />
            <button class="btn-secondary-sm" @click="emit('browse-dir', 'bridgeSaveDir')">浏览</button>
          </div>
        </div>
        <div class="setting-row">
          <div>
            <div class="setting-label">服务端扫描入库</div>
            <div class="setting-desc">采集完成后自动扫描并入库到服务端</div>
          </div>
          <button
            type="button"
            class="switch"
            :class="{ on: curScan }"
            role="switch"
            :aria-checked="curScan"
            @click="curScan = !curScan; emit('save')"
          >
            <span class="knob" />
          </button>
        </div>
        <div class="setting-row">
          <div>
            <div class="setting-label">保存配置</div>
            <div class="setting-desc">将下载插件配置持久化到本地</div>
          </div>
          <button class="btn-secondary-sm primary-sm" @click="emit('save')">保存</button>
        </div>
      </template>

      <template v-else>
        <div class="setting-row">
          <div>
            <div class="setting-label">Chrome 调试端口</div>
            <div class="setting-desc">复用已登录 Chrome（CDP 调试端口）</div>
          </div>
          <input v-model="curChromePort" type="text" class="input w-32" />
        </div>
        <div class="setting-row">
          <div>
            <div class="setting-label">Chrome 可执行路径</div>
            <div class="setting-desc">调试 Chrome 的可执行文件位置</div>
          </div>
          <div class="setting-row-right">
            <input v-model="curChromePath" type="text" class="input w-64" />
            <button class="btn-secondary-sm" @click="emit('browse-file')">浏览</button>
          </div>
        </div>
        <div class="setting-row">
          <div>
            <div class="setting-label">user-data-dir</div>
            <div class="setting-desc">固定浏览器配置目录，复用登录态</div>
          </div>
          <div class="setting-row-right">
            <input v-model="curDataDir" type="text" class="input w-64" />
            <button class="btn-secondary-sm" @click="emit('browse-dir', 'chromeDataDir')">浏览</button>
          </div>
        </div>
        <div class="setting-row">
          <div>
            <div class="setting-label">Chrome 连接状态</div>
            <div class="setting-desc" :class="cdpState.toLowerCase().includes('已连接') ? 'svc-ok' : ''">{{ cdpState }}</div>
          </div>
          <button class="btn-secondary-sm" :disabled="cdpBusy" @click="emit('detect')">{{ cdpBusy ? '检测中…' : '检测 Chrome' }}</button>
        </div>
        <div class="setting-row">
          <div>
            <div class="setting-label">店铺关键词</div>
            <div class="setting-desc">数据包命名校验用的店铺关键词</div>
          </div>
          <input v-model="curKeyword" type="text" class="input w-32" />
        </div>
        <div class="setting-row">
          <div>
            <div class="setting-label">自动上架任务</div>
            <div class="setting-desc">先检测调试 Chrome；后台上架流程为本地技能链路</div>
          </div>
          <button class="btn-secondary-sm primary-sm" @click="emit('save')">保存配置</button>
        </div>
      </template>
    </div>
  </section>
</template>

<style scoped>
/* Chrome 连接状态成功色（仅本卡使用） */
.svc-ok { color: var(--success); font-weight: 600; }
</style>
