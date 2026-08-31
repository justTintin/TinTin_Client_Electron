<script setup lang="ts">
// ═══════════════════════════════════════════════════════════════
// Workbench.vue — 工作台容器（聊天会话界面）
// 结构：左侧 260px 会话侧栏（新建会话/定时任务/分组会话列表/系统设置）
//       中间主区：消息流 + 底部输入框（上传/发送按钮 + 快捷键提示）
//       右侧抽屉：定时任务 / 通知中心 / 任务队列（遮罩 + 滑入过渡由本容器持有）
// 拆分布局：业务状态在 composables/useWorkbench*.ts，
//           展示片段在 components/workbench/Wb*.vue，此处仅做接线与公共样式。
// P1 微调（移植原则：框架不动、按需加组件）：侧栏「新建会话」下新增「定时任务」
//           入口 → 右侧滑出定时任务抽屉（P1 占位，P2 实装），与通知/任务抽屉同构。
// ═══════════════════════════════════════════════════════════════

import { ref, computed, watch, onMounted } from 'vue'
import WbSidebar from '@/components/workbench/WbSidebar.vue'
import WbMessages from '@/components/workbench/WbMessages.vue'
import WbComposer from '@/components/workbench/WbComposer.vue'
import WbPickProductDialog from '@/components/workbench/WbPickProductDialog.vue'
import WbPickMaterialDialog from '@/components/workbench/WbPickMaterialDialog.vue'
import WbPickScriptDialog from '@/components/workbench/WbPickScriptDialog.vue'
import WbNotificationDrawer from '@/components/workbench/WbNotificationDrawer.vue'
import WbTaskDrawer from '@/components/workbench/WbTaskDrawer.vue'
import WbScheduledDrawer from '@/components/workbench/WbScheduledDrawer.vue'
import SkillManagerDialog from '@/components/workbench/SkillManagerDialog.vue'
import { useWorkbenchSessions, SESSION_GROUPS } from '@/composables/useWorkbenchSessions'
import { useWorkbenchChat } from '@/composables/useWorkbenchChat'
import { useWorkbenchAgents } from '@/composables/useWorkbenchAgents'
import { useSkills } from '@/composables/useSkills'
import { mergeSkillCandidates, buildSkillWakeText, applyWakePrefix } from '@/composables/skillsLogic'
import { buildAgentWakeText } from '@/composables/workbenchChatContext'
import { useWorkbenchNotifications } from '@/composables/useWorkbenchNotifications'
import { useWorkbenchTasks } from '@/composables/useWorkbenchTasks'
import { useOfficeExport } from '@/composables/useOfficeExport'
import { useOfficePreview } from '@/composables/useOfficePreview'
import { buildChatDocxStructure, formatDate, formatDateTime } from '@/composables/officeDocLogic'
import { chatToSheet, tasksToSheet } from '@/composables/officeSheetLogic'
import { detectChatAssets } from '@/composables/workbenchChatLogic'
import type { ChatAsset } from '@/composables/workbenchChatLogic'
import WorkbenchPreviewPanel from '@/components/workbench/WorkbenchPreviewPanel.vue'
import type {
  WorkbenchAgent,
  CtxProductItem,
  CtxMaterialItem,
  CtxScriptItem
} from '@/composables/workbenchChatContext'
import type { SkillEntry } from '@/composables/skillsLogic'
import type { PickerItem } from '@/composables/useWorkbenchPickers'

/* ── 子组件实例引用：跨组件 DOM 行为经 expose 方法桥接 ────── */
const msgsComp = ref<InstanceType<typeof WbMessages> | null>(null)
const composerComp = ref<InstanceType<typeof WbComposer> | null>(null)

/* ── 会话域（先建）：electron-store 单一真相源，消息域经 onSessionUpdate 回写 ── */
const sessions = useWorkbenchSessions({
  onConversationCreate: () => chat.resetToWelcome(),
  onSessionFocus: () => composerComp.value?.focus()
})
const { activeSessionId, sidebarOpen, toggleSidebarPanel, sessionsByGroup, groupLabels } = sessions

/* ── 消息域：发送后「nextTick 滚动」桥接到 WbMessages expose 的 scrollToBottom ── */
const chat = useWorkbenchChat({
  scrollToBottom: () => msgsComp.value?.scrollToBottom(),
  onSessionUpdate: (patch) => sessions.updateActive(patch)
})
const {
  messages,
  inputText,
  sending,
  mode,
  planMode,
  attachments,
  ctxProduct,
  ctxScripts,
  handleSend,
  handleKeydown,
  confirmPlanExec,
  openSettings,
  loadSession,
  resetToWelcome,
  initModel,
  addAttachments,
  addScreenshots,
  removeAttachment,
  addCtxProduct,
  removeCtxProduct,
  addCtxScript,
  removeCtxScript,
  addCtxMaterial,
  addCtxAudio,
  downloadVideoAsset,
  quoteMessage,
  handleRegenerate
} = chat

/* ── 智能体快捷条域（2026-08-31 用户裁决：移除「对话」llm 直连入口；
   快捷条为纯列表不持有选中态，点击条目=插唤醒词，见 onSelectEntry） ── */
const {
  entries: agentEntries,
  errorMessage: agentsError,
  loadAgents,
  setSkills
} = useWorkbenchAgents()

/* ── 技能域（原版 _load_agents：技能与智能体一起更新进快捷条/斜杠菜单） ── */
const skills = useSkills()
const {
  builtin: skillBuiltin,
  user: skillUser,
  loading: skillsLoading,
  actionMsg: skillsActionMsg,
  load: loadSkills,
  install: installSkillSrc,
  remove: removeSkillId,
  upload: uploadSkillId
} = skills

/** 全部技能（内置 + 已安装；快捷条合并与选中回查共用） */
const skillsAll = computed<SkillEntry[]>(() => [...skillBuiltin.value, ...skillUser.value])
watch(skillsAll, (list) => setSkills(list), { immediate: true }) // 列表变更 → 快捷条重建

/** 斜杠候选数据源：服务端智能体（仅 agent 条目）+ 本地技能（原版 L1519 顺序） */
const agentList = computed(() =>
  mergeSkillCandidates(
    agentEntries.value
      .filter((e) => e.kind === 'agent')
      .map((e) => ({ id: e.key, name: e.name, desc: e.desc })),
    skillsAll.value
  )
)

/* ── 技能管理弹窗（工具行「⚙技能」入口；安装/卸载后列表自动刷新） ── */
const showSkillManager = ref(false)
function onOpenSkills() {
  void loadSkills()
  showSkillManager.value = true
}
async function onInstallSkillFile() {
  const t = (window as any).tintin
  if (!t?.dialog?.openFile) return
  const src = await t.dialog.openFile({
    title: '选择技能文件（.md 或 .zip）',
    filters: [
      { name: '技能包', extensions: ['md', 'markdown', 'zip'] }
    ]
  })
  if (src) await installSkillSrc(String(src))
}
async function onInstallSkillDir() {
  const t = (window as any).tintin
  if (!t?.dialog?.openDir) return
  const src = await t.dialog.openDir({ title: '选择技能目录（含 SKILL.md）' })
  if (src) await installSkillSrc(Array.isArray(src) ? String(src[0]) : String(src))
}

/* ── 网络异常底部 toast 条（2026-08-30 用户反馈：错误不再内嵌快捷条，
      改为底部居中一行 + 右侧关闭；agentsError 出现新文案时自动重新显示） ── */
const dismissedNetError = ref('')
const netErrorVisible = computed(
  () => !!agentsError.value && agentsError.value !== dismissedNetError.value
)
function dismissNetError() {
  dismissedNetError.value = agentsError.value
}

/* ── 选择弹窗开关（产品/素材/脚本，业务在 chat 的 addCtx* 系列） ── */
const showProduct = ref(false)
const showMaterial = ref(false)
const showScript = ref(false)

/** 选中产品（原版 _pick_product L1778-1784：单选覆盖） */
function onPickProduct(item: PickerItem) {
  addCtxProduct(item as CtxProductItem)
}

/** 选中素材（原版 _pick_material：按 material_id 去重入会话素材池） */
function onPickMaterial(item: PickerItem) {
  addCtxMaterial(item as CtxMaterialItem)
}

/** 选中脚本（原版 _pick_script L1830-1838：按 id 去重多选） */
function onPickScript(item: PickerItem) {
  addCtxScript(item as CtxScriptItem)
}

/** 快捷条点击（2026-08-31 用户裁决：智能体条只是列表，不应有选择态；
 *  调用统一走输入框——点击条目 = 注入唤醒前缀，与 / 菜单同口径
 *  （原版 _on_agent_selected L1537-1549 applyWakePrefix：换选时剥离旧前缀）。 */
function onSelectEntry(key: string) {
  const entry = agentEntries.value.find((e) => e.key === key)
  if (!entry) return
  const wake =
    entry.kind === 'skill'
      ? buildSkillWakeText(skillsAll.value.find((x) => `skill:${x.id}` === key))
      : buildAgentWakeText(entry)
  inputText.value = applyWakePrefix(inputText.value, wake)
  nextTick(() => composerComp.value?.focusEnd())
}

/* ── W9：引用回复（业务在 chat.quoteMessage，纯函数在 logic 层；聚焦/光标桥接输入区） ── */
function onQuoteMessage(id: string) {
  quoteMessage(id)
  nextTick(() => composerComp.value?.focusEnd())
}

/** W9：重新生成（chat.handleRegenerate 重发该轮提问并替换旧气泡） */
function onRegenerateMessage(id: string) {
  void handleRegenerate(id)
}

/* ── 启动恢复（原版 _restore_chat：本地消息 + 服务端 session_id 续接） ── */
onMounted(async () => {
  await sessions.init()
  const active = sessions.getActive()
  if (active && active.messages.length) {
    loadSession({
      serverSessionId: active.serverSessionId,
      messages: active.messages,
      mode: active.mode
    })
  } else {
    resetToWelcome() // 无持久化会话（或空会话）→ 欢迎语新对话
  }
  void initModel()
  void loadAgents() // 智能体快捷条/斜杠菜单数据源（失败快捷条暂不可用）
  void loadSkills() // 本地技能（内置+已安装）→ 合并进快捷条/斜杠菜单（原版 _load_agents 同步加载）
})

/** 切换会话：把该会话消息 / 服务端 session_id / 模式装载进消息域（原版恢复口径） */
function onSelectSession(id: string) {
  if (id === activeSessionId.value) return
  sessions.selectSession(id)
  const s = sessions.getActive()
  if (s) {
    loadSession({ serverSessionId: s.serverSessionId, messages: s.messages, mode: s.mode })
  }
}

/** 新建会话（侧栏按钮）：以当前模式创建；钩子内已重置欢迎消息并聚焦输入框 */
function onCreateSession() {
  sessions.createSession(mode.value)
}

/* ── W7：删除 / 重命名会话（业务在 sessions 域，纯函数在 logic 层；UI 仅事件转发） ── */

/** 删除会话：本地删除先行，服务端 sessionDelete 同步失败仅提示（本地已删） */
async function onDeleteSession(id: string) {
  const wasActive = id === activeSessionId.value
  const r = await sessions.deleteSession(id)
  // 删除的是当前激活会话 → 消息域装载下一个会话（各自绑定 session_id）或欢迎语
  if (wasActive) {
    const next = sessions.getActive()
    if (next) {
      loadSession({
        serverSessionId: next.serverSessionId,
        messages: next.messages,
        mode: next.mode
      })
    } else {
      resetToWelcome()
    }
  }
  if (r.error) window.alert?.(r.error)
}

/** 重命名会话：行内编辑 Enter 确认后持久化（Esc 取消在侧栏内部消化） */
function onRenameSession(id: string, title: string) {
  sessions.renameSession(id, title)
}

/* ── 通知域 ── */
const {
  notifications,
  unreadCount,
  notificationOpen,
  toggleNotifications,
  closeNotifications,
  markNotifyRead,
  markAllRead
} = useWorkbenchNotifications()

/* ── 任务队列域 ── */
const { taskQueueOpen, taskRows, toggleTaskQueue, closeTaskQueue, openTaskResult } = useWorkbenchTasks()

/* ── 定时任务抽屉（P1 占位开关；P2 实装数据域 useScheduledTasks） ── */
const scheduledOpen = ref(false)
function openScheduled() {
  scheduledOpen.value = true
}
function closeScheduled() {
  scheduledOpen.value = false
}

/** 侧栏分组数据（今天/昨天/更早，组名 + 成员），展示交给 WbSidebar */
const sessionGroups = computed(() =>
  SESSION_GROUPS.map((g) => ({ key: g, label: groupLabels[g], items: sessionsByGroup(g) }))
)

/* ── 办公能力导出（P1，PRD §3.1：AI 气泡操作栏导出当前会话全部消息为 Word/Excel）── */
const officeExport = useOfficeExport()
const preview = useOfficePreview()
const exportState = computed(() => officeExport.state.value)
const exportLastPath = computed(() => officeExport.lastPath.value)
let exportToastTimer: ReturnType<typeof setTimeout> | null = null
watch(exportState, (s) => {
  if (s === 'done') {
    // exportDone → 右侧面板自动展开并加载文件预览（不再弹 OfficePreview 弹窗）
    if (exportLastPath.value) {
      panelOpen.value = true
      void preview.openPreview(exportLastPath.value)
    }
    if (exportToastTimer) clearTimeout(exportToastTimer)
    exportToastTimer = setTimeout(() => officeExport.reset(), 10000) // toast 自动消失
  }
})

/* ── W10：右侧工作台预览面板（资产 + 文件预览；默认收起，资产出现/导出成功自动展开） ── */

const panelOpen = ref(false)
const panelAssets = ref<ChatAsset[]>([])

/** 检测消息资产并展开面板（气泡「预览」图标 / 资产出现自动展开共用） */
function showAssets(messageId: string) {
  const msg = messages.value.find((m) => m.id === messageId)
  if (!msg) return
  const assets = detectChatAssets(msg.content)
  if (!assets.length) return // 无资产 → 不展开（预览图标也不会出现）
  panelAssets.value = assets
  panelOpen.value = true
}

/** 气泡 hover「预览」图标 → 显式打开资产预览 */
function onPreviewAssets(messageId: string) {
  showAssets(messageId)
}

/** 气泡资产出现（新 AI 回复含资产）→ 自动展开 */
function onAssetsReady(messageId: string) {
  showAssets(messageId)
}

/** 手动折叠（面板头部按钮） */
function onClosePanel() {
  panelOpen.value = false
}

/** toast「预览」：打开右侧面板文件预览（面板已折叠自动展开） */
function onPreviewExport() {
  if (!exportLastPath.value) return
  panelOpen.value = true
  void preview.openPreview(exportLastPath.value)
}

/** 资产「导出 Word」：单个资产内容导出为 Word 文档（业务在 useOfficeExport） */
function onExportAsset(asset: ChatAsset) {
  if (exportState.value === 'exporting') return // E6
  const activeTitle = sessions.getActive()?.title
  void officeExport.exportDocx(
    {
      title: asset.title,
      metaLines: [`来源：会话「${activeTitle && activeTitle !== '新会话' ? activeTitle : '新会话'}」`],
      blocks: [
        { type: 'heading', text: asset.title },
        { type: 'para', runs: [{ text: asset.content }] },
      ],
    },
    `${_safeName(asset.title)}.docx`,
  )
}

/** E1：空会话（无用户消息）→ 导出按钮禁用；E6：导出中禁用 */
const canExportChat = computed(() =>
  messages.value.some((m) => m.role === 'user') && exportState.value !== 'exporting',
)

/** 导出元信息（PRD §3.1：标题 + 智能体/模式·会话 ID·导出时间） */
function exportChatMeta(): { title: string; metaLines: string[] } {
  const agentName = agentEntries.value.find((e) => e.key === agentSelectedKey.value)?.name || '智能体'
  const activeTitle = sessions.getActive()?.title
  const title = activeTitle && activeTitle !== '新会话'
    ? activeTitle
    : `会话 ${agentName} ${formatDate(new Date())}`
  return {
    title,
    metaLines: [
      `智能体：${agentName} · 模式：${mode.value === 'agent' ? '智能体编排' : '通用对话'}`,
      `会话 ID：${chat.sessionId || '（本地会话）'}`,
      `导出时间：${formatDateTime(new Date())}`,
    ],
  }
}

/** 导出消息：过滤 pending 占位与空内容（欢迎语等 AI 消息保留；逐条时间数据源无 → 省略） */
function exportChatMessages() {
  return messages.value
    .filter((m) => m.status !== 'pending' && m.content && m.content.trim())
    .map((m) => ({ role: m.role, content: m.content, time: undefined }))
}

function _safeName(title: string): string {
  return title.replace(/[\\/:*?"<>|]/g, '_')
}

async function onExportWord() {
  if (exportState.value === 'exporting') return // E6
  if (!canExportChat.value) { window.alert?.('暂无内容可导出'); return } // E1
  const meta = exportChatMeta()
  await officeExport.exportDocx(buildChatDocxStructure(exportChatMessages(), meta), `${_safeName(meta.title)}.docx`)
}

async function onExportExcel() {
  if (exportState.value === 'exporting') return
  if (!canExportChat.value) { window.alert?.('暂无内容可导出'); return }
  const meta = exportChatMeta()
  await officeExport.exportXlsx(
    chatToSheet(exportChatMessages(), { title: meta.title }),
    `${_safeName(meta.title)}.xlsx`,
  )
}

/* ── 办公能力导出（PRD §3.2⑤：任务队列 → 任务报告 Excel）── */
async function onExportTasks() {
  if (exportState.value === 'exporting') return // E6
  if (taskRows.value.length === 0) { window.alert?.('暂无内容可导出'); return } // E1
  await officeExport.exportXlsx(tasksToSheet(taskRows.value as any), `任务报告_${formatDate(new Date())}.xlsx`)
}
</script>

<template>
  <section class="workbench">
    <!-- ─── 左侧会话侧栏 ─── -->
    <WbSidebar
      :groups="sessionGroups"
      :active-session-id="activeSessionId"
      :open="sidebarOpen"
      :unread-count="unreadCount"
      @select="onSelectSession"
      @create="onCreateSession"
      @delete="onDeleteSession"
      @rename-commit="onRenameSession"
      @open-scheduled="openScheduled"
      @toggle-taskqueue="toggleTaskQueue"
      @toggle-notifications="toggleNotifications"
      @open-settings="openSettings"
    />

    <!-- ─── 聊天主区（消息流 + 底部输入框，纵向排列） ─── -->
    <main class="wb-main">
      <WbMessages
        ref="msgsComp"
        :messages="messages"
        :export-disabled="!canExportChat"
        @toggle-sidebar="toggleSidebarPanel"
        @quote-message="onQuoteMessage"
        @regenerate-message="onRegenerateMessage"
        @confirm-plan="confirmPlanExec"
        @download-video="downloadVideoAsset"
        @export-word="onExportWord"
        @export-excel="onExportExcel"
        @assets-ready="onAssetsReady"
        @preview-assets="onPreviewAssets"
      />

      <!-- ─── 输入区（左下工具行：上传/产品/素材/脚本入口 + 智能体快捷条；
                模式分段与模型下拉已移除，选中快捷条即切换，业务在 useWorkbenchChat） ─── -->
      <WbComposer
        ref="composerComp"
        v-model="inputText"
        :sending="sending"
        :mode="mode"
        :plan-mode="planMode"
        :attachments="attachments"
        :ctx-product="ctxProduct"
        :ctx-scripts="ctxScripts"
        :entries="agentEntries"
        :agents="agentList"
        @send="handleSend"
        @keydown="handleKeydown"
        @update:plan-mode="planMode = $event"
        @attachments-picked="addAttachments"
        @screenshots-picked="addScreenshots"
        @remove-attachment="removeAttachment"
        @remove-product="removeCtxProduct"
        @remove-script="removeCtxScript"
        @pick-product="showProduct = true"
        @pick-material="showMaterial = true"
        @open-skills="onOpenSkills"
        @pick-script="showScript = true"
        @select-entry="onSelectEntry"
      />
    </main>

    <!-- ─── 右侧工作台预览面板（默认收起：宽度 0 + 动画；资产出现/导出成功自动展开，手动折叠关闭） ─── -->
    <div class="preview-panel-wrap" :class="{ 'is-open': panelOpen }">
      <WorkbenchPreviewPanel
        :open="panelOpen"
        :assets="panelAssets"
        :file="preview.state"
        :file-loading="preview.loading"
        @close="onClosePanel"
        @open-system="preview.openWithSystem()"
        @switch-sheet="preview.switchSheet"
        @export-asset="onExportAsset"
      />
    </div>

    <!-- ─── 选择产品/素材/脚本弹窗（选中 → chat 上下文胶囊/素材池） ─── -->
    <WbPickProductDialog
      :visible="showProduct"
      @close="showProduct = false"
      @pick="onPickProduct"
    />
    <WbPickMaterialDialog
      :visible="showMaterial"
      @close="showMaterial = false"
      @pick="onPickMaterial"
      @pick-audio="addCtxAudio"
    />
    <WbPickScriptDialog
      :visible="showScript"
      @close="showScript = false"
      @pick="onPickScript"
    />

    <!-- ─── 定时任务抽屉（新建会话入口下方按钮唤起；P1 占位，P2 实装） ─── -->
    <Transition name="drawer-fade">
      <div v-if="scheduledOpen" class="notify-mask" @click.self="closeScheduled"></div>
    </Transition>
    <Transition name="drawer-slide">
      <WbScheduledDrawer v-if="scheduledOpen" @close="closeScheduled" />
    </Transition>

    <!-- ─── 通知中心抽屉（对齐设计稿侧栏底部“通知中心”入口） ─── -->
    <Transition name="drawer-fade">
      <div v-if="notificationOpen" class="notify-mask" @click.self="closeNotifications"></div>
    </Transition>
    <Transition name="drawer-slide">
      <WbNotificationDrawer
        v-if="notificationOpen"
        :notifications="notifications"
        :unread-count="unreadCount"
        @close="toggleNotifications"
        @mark-read="markNotifyRead"
        @mark-all="markAllRead"
      />
    </Transition>

    <!-- ─── 任务队列抽屉（位于通知中心上方，对齐最新设计） ─── -->
    <Transition name="drawer-fade">
      <div v-if="taskQueueOpen" class="notify-mask" @click.self="closeTaskQueue"></div>
    </Transition>
    <Transition name="drawer-slide">
      <WbTaskDrawer
        v-if="taskQueueOpen"
        :rows="taskRows"
        :export-disabled="taskRows.length === 0 || exportState === 'exporting'"
        @close="closeTaskQueue"
        @open-result="openTaskResult"
        @export-excel="onExportTasks"
      />
    </Transition>

    <!-- ─── 技能管理弹窗（安装 .md/.zip/目录；内置只读，用户技能可卸载/上传服务端） ─── -->
    <SkillManagerDialog
      :visible="showSkillManager"
      :builtin="skillBuiltin"
      :user="skillUser"
      :loading="skillsLoading"
      :action-msg="skillsActionMsg"
      @close="showSkillManager = false"
      @install-file="onInstallSkillFile"
      @install-dir="onInstallSkillDir"
      @remove="removeSkillId"
      @upload="uploadSkillId"
    />

    <!-- ─── 网络异常底部 toast 条（单行居中 + 右侧关闭；出现新文案自动重现） ─── -->
    <Transition name="net-toast">
      <div v-if="netErrorVisible" class="net-error-toast" role="alert">
        <span class="net-error-text">{{ agentsError }}</span>
        <button class="net-error-x" title="关闭" @click="dismissNetError">×</button>
      </div>
    </Transition>

    <!-- ─── 办公能力：导出成功反馈 toast（已保存 + 预览 / 打开所在位置，PRD §3.4）─── -->
    <Transition name="export-toast">
      <div v-if="exportState === 'done' && exportLastPath" class="export-toast" role="status">
        <svg class="export-toast__icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
          <polyline points="22 4 12 14.01 9 11.01" />
        </svg>
        <span class="export-toast__text" :title="exportLastPath">已保存：{{ exportLastPath }}</span>
        <button class="export-toast__btn" title="在右侧预览面板查看导出文件" @click="onPreviewExport">预览</button>
        <button class="export-toast__btn" title="在资源管理器中定位文件" @click="officeExport.revealInFolder(exportLastPath)">打开所在位置</button>
        <button class="export-toast__close" title="关闭提示" @click="officeExport.reset()">×</button>
      </div>
    </Transition>
  </section>
</template>

<style scoped>
.workbench {
  position: relative;
  display: flex;
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: var(--background);
}

/* ─── 聊天主区：消息流(flex:1) + 底部输入框 纵向排列 ─── */
.wb-main {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

/* ─── 右侧工作台预览面板容器：默认收起（宽度 0 + overflow 裁切），展开 340px 带动画 ─── */
.preview-panel-wrap {
  flex: 0 0 auto;
  width: 0;
  overflow: hidden;
  transition: width var(--duration-normal) var(--easing-out);
}
.preview-panel-wrap.is-open {
  width: 340px;
}

/* ─── 抽屉遮罩（定时任务 / 通知中心 / 任务队列共用） ─── */
.notify-mask {
  position: absolute;
  inset: 0;
  z-index: 60;
  background: rgba(11, 12, 16, 0.32);
}

/* 抽屉过渡动画 */
.drawer-slide-enter-active,
.drawer-slide-leave-active {
  transition: transform var(--duration-normal) var(--easing-out);
}
.drawer-slide-enter-from,
.drawer-slide-leave-to {
  transform: translateX(100%);
}
.drawer-fade-enter-active,
.drawer-fade-leave-active {
  transition: opacity var(--duration-normal) var(--easing-default);
}
.drawer-fade-enter-from,
.drawer-fade-leave-to {
  opacity: 0;
}

/* ─── 办公能力导出成功 toast（已保存 + 预览/打开所在位置） ─── */
.export-toast {
  position: absolute;
  right: 16px;
  bottom: 20px;
  z-index: 80;
  display: flex;
  align-items: center;
  gap: 8px;
  max-width: min(480px, calc(100vw - 32px));
  padding: 10px 12px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-4);
  font-size: 12px;
  color: var(--foreground);
}

/* ─── 网络异常底部 toast 条（fixed 全窗底部居中一行 + 右侧关闭） ─── */
.net-error-toast {
  position: fixed;
  left: 50%;
  bottom: 18px;
  transform: translateX(-50%);
  z-index: 90;
  display: flex;
  align-items: center;
  gap: 10px;
  max-width: min(640px, calc(100vw - 32px));
  padding: 9px 10px 9px 14px;
  background: var(--surface);
  border: 1px solid var(--destructive, #e5484d);
  border-left-width: 4px;
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-4);
  font-size: 12px;
  color: var(--destructive, #e5484d);
}
.net-error-text {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.net-error-x {
  flex: 0 0 auto;
  width: 22px;
  height: 22px;
  border-radius: var(--radius-full);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 15px;
  line-height: 1;
  color: var(--destructive, #e5484d);
}
.net-error-x:hover {
  background: var(--surface-container-high);
}
.net-toast-enter-active,
.net-toast-leave-active {
  transition: opacity var(--duration-fast), transform var(--duration-fast);
}
.net-toast-enter-from,
.net-toast-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(8px);
}

.export-toast__icon { color: var(--success); flex: 0 0 auto; }
.export-toast__text {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.export-toast__btn {
  flex: 0 0 auto;
  height: 24px;
  padding: 0 10px;
  font-size: 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--surface-container);
  color: var(--muted-foreground);
  cursor: pointer;
  font-family: inherit;
}
.export-toast__btn:hover { border-color: var(--primary); color: var(--primary); }
.export-toast__close {
  flex: 0 0 auto;
  width: 22px;
  height: 22px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--muted-foreground);
  font-size: 15px;
  line-height: 1;
  cursor: pointer;
}
.export-toast__close:hover { background: var(--surface-container); color: var(--foreground); }
.export-toast-enter-active,
.export-toast-leave-active { transition: all var(--duration-normal) var(--easing-out); }
.export-toast-enter-from,
.export-toast-leave-to { opacity: 0; transform: translateY(8px); }
</style>
