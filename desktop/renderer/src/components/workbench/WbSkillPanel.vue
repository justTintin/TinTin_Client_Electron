<script setup lang="ts">
// WbSkillPanel.vue — 右侧技能管理面板（2026-09-01 用户裁决：技能管理从弹窗迁到
// 右侧侧边栏，入口在工作台左侧「定时任务」下方；内容=原 SkillManagerDialog）：
//   · 安装单个 .md / 含 SKILL.md 的目录 / ZIP 包（对话框选择来源）
//   · 内置技能（随包分发）只读展示、不可卸载、不上传（用户口径）；用户技能可卸载
//   · 用户技能可手动上传为服务端共享（原版 register_skill；安装时已自动登记，
//     此处为离线补传/重传入口）
//   · 安装/卸载后由容器刷新列表（技能重新合并进斜杠菜单）
// 纯展示 + 来源选择转发：安装/卸载/上传业务在容器 useSkills（onInstall/onRemove/upload）。
import { computed, ref } from 'vue'
import type { SkillEntry } from '@/composables/skillsLogic'

const props = defineProps<{
  open: boolean
  builtin: SkillEntry[]
  user: SkillEntry[]
  loading?: boolean
  /** 安装/卸载操作结果提示（useSkills.actionMsg） */
  actionMsg?: string
  /** 已上传服务端的技能 id 列表（useSkills.uploadedIds；已上传回显「已上传」，
   *  仍可点击重传幂等覆盖） */
  uploadedIds?: string[]
  /** 服务端共享技能全量条目（2026-09-01 技能下载：面板打开时自动同步） */
  serverSkills?: SkillEntry[]
  /** 服务端技能列表拉取中（与本地列表 loading 分离，避免互闪） */
  serverLoading?: boolean
  /** 本地已安装技能 id（内置+用户；服务端区块「已安装」回显判定） */
  installedIds?: string[]
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'install-file'): void
  (e: 'install-dir'): void
  (e: 'remove', id: string): void
  (e: 'upload', id: string): void
  /** 从服务端下载技能并安装到本地（服务端技能区「下载」按钮） */
  (e: 'install-server', id: string): void
}>()

/** 卸载确认（防误删；原版 QMessageBox 问询口径） */
const confirmId = ref('')
function onRemoveClick(id: string, name: string) {
  if (confirmId.value === id) {
    confirmId.value = ''
    emit('remove', id)
  } else {
    confirmId.value = id // 二次点击确认；点其他处/再次展开重置
    setTimeout(() => { if (confirmId.value === id) confirmId.value = '' }, 3000)
  }
  void name
}

/** 已上传 id 集合（数组 → Set，模板判断用） */
const uploadedSet = computed(() => new Set(props.uploadedIds || []))

/** 本地已安装 id 集合（内置+用户；服务端技能区「已安装」判定） */
const installedSet = computed(() => new Set(props.installedIds || []))

/** 服务端技能（过滤本地已安装：只展示可下载的；用户口径：面板重点是「能从服务端下载」） */
const serverAvail = computed(() =>
  (props.serverSkills || []).filter((s) => !installedSet.value.has(String(s.id || '')))
)

function subText(s: SkillEntry): string {
  const d = String(s.description || '').trim()
  const tags = Array.isArray(s.tags) && s.tags.length ? `　标签：${s.tags.join(' / ')}` : ''
  return d ? `${d}${tags}` : tags
}
</script>

<template>
  <!-- ─── 右侧技能管理面板（340px，由容器 wrap 控制开合动画） ─── -->
  <aside class="skill-panel" aria-label="技能管理">
    <div class="skill-panel-head">
      <span class="skill-panel-title">技能管理</span>
      <button class="skill-panel-x" title="关闭" @click="emit('close')">×</button>
    </div>
    <p class="skill-panel-tip">
      技能为含 SKILL.md 的本地指令包；安装后以「请按技能【…】执行」注入对话
      （输入 / 可唤起技能候选）。
    </p>

    <div class="skill-panel-actions">
      <button class="skill-btn" title="选择 .md 技能文件或 .zip 技能包" @click="emit('install-file')">
        安装文件（.md / .zip）
      </button>
      <button class="skill-btn" title="选择含 SKILL.md 的技能目录（整目录复制）" @click="emit('install-dir')">
        安装目录
      </button>
    </div>

    <div class="skill-panel-body custom-scroll">
      <div class="skill-section">内置技能（随客户端分发，不可卸载）</div>
      <div v-if="!builtin.length" class="skill-empty">暂无内置技能</div>
      <div v-for="s in builtin" :key="'b-' + s.id" class="skill-row">
        <div class="skill-main">
          <span class="skill-name">{{ s.name || s.id }}</span>
          <span v-if="subText(s)" class="skill-sub">{{ subText(s) }}</span>
        </div>
      </div>

      <div class="skill-section">服务端技能（可下载安装到本地）</div>
      <div v-if="serverLoading" class="skill-empty">服务端技能加载中…</div>
      <div v-else-if="!serverAvail.length" class="skill-empty">服务端暂无可下载的新技能</div>
      <div v-for="s in serverAvail" :key="'sv-' + s.id" class="skill-row">
        <div class="skill-main">
          <span class="skill-name">{{ s.name || s.id }}</span>
          <span v-if="subText(s)" class="skill-sub">{{ subText(s) }}</span>
        </div>
        <button
          class="skill-download"
          title="从服务端下载该技能并安装到本地（本地已装同 id 技能会被覆盖）"
          @click="emit('install-server', s.id)"
        >
          下载
        </button>
      </div>

      <div class="skill-section">已安装技能（可上传为服务端共享）</div>
      <div v-if="!user.length" class="skill-empty">尚未安装本地技能</div>
      <div v-for="s in user" :key="'u-' + s.id" class="skill-row">
        <div class="skill-main">
          <span class="skill-name">{{ s.name || s.id }}</span>
          <span v-if="subText(s)" class="skill-sub">{{ subText(s) }}</span>
        </div>
        <button
          class="skill-upload"
          :class="{ uploaded: uploadedSet.has(s.id) }"
          :title="uploadedSet.has(s.id)
            ? '已上传服务端；点击可重新上传（幂等覆盖，更新内容后可用）'
            : '上传到服务端，供其他客户端共享使用（离线时安装已自动重试，可在此补传）'"
          @click="emit('upload', s.id)"
        >
          {{ uploadedSet.has(s.id) ? '已上传' : '上传' }}
        </button>
        <button
          class="skill-remove"
          :class="{ confirming: confirmId === s.id }"
          :title="confirmId === s.id ? '再次点击确认卸载' : '卸载该技能'"
          @click="onRemoveClick(s.id, s.name)"
        >
          {{ confirmId === s.id ? '确认卸载？' : '卸载' }}
        </button>
      </div>
    </div>

    <div class="skill-panel-foot">
      <span v-if="actionMsg" class="skill-msg">{{ actionMsg }}</span>
      <span v-else-if="loading" class="skill-msg muted">加载中…</span>
    </div>
  </aside>
</template>

<style scoped>
/* ─── 面板容器（高度由 wrap 撑满，本组件纵向排布） ─── */
.skill-panel {
  height: 100%;
  display: flex;
  flex-direction: column;
  padding: var(--space-4);
  background: var(--surface);
  border-left: 1px solid var(--border);
}

.skill-panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.skill-panel-title {
  font-size: 15px;
  font-weight: var(--font-weight-semibold);
  color: var(--foreground);
}

.skill-panel-x {
  width: 26px;
  height: 26px;
  font-size: 16px;
  color: var(--muted-foreground);
  border-radius: var(--radius-md);
}
.skill-panel-x:hover { background: var(--surface-container-high); color: var(--foreground); }

.skill-panel-tip {
  margin: var(--space-2) 0 var(--space-3);
  font-size: 12px;
  line-height: 1.6;
  color: var(--muted-foreground);
}

.skill-panel-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin-bottom: var(--space-3);
}

.skill-btn {
  padding: 6px var(--space-3);
  font-size: 13px;
  color: var(--foreground);
  background: var(--surface-container);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  transition: background var(--duration-fast);
}
.skill-btn:hover { background: var(--surface-container-high); }

.skill-panel-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  border-top: 1px solid var(--border);
  padding-top: var(--space-3);
}

.skill-section {
  font-size: 12px;
  font-weight: var(--font-weight-semibold);
  color: var(--muted-foreground);
  margin-bottom: var(--space-2);
}

.skill-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 7px var(--space-2);
  border-radius: var(--radius-md);
}
.skill-row:hover { background: var(--surface-container); }

.skill-main {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.skill-name {
  font-size: 13px;
  font-weight: var(--font-weight-medium);
  color: var(--foreground);
}

.skill-sub {
  font-size: 12px;
  color: var(--muted-foreground);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.skill-remove {
  flex: 0 0 auto;
  padding: 3px 10px;
  font-size: 12px;
  color: var(--muted-foreground);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
}
.skill-remove:hover { color: var(--foreground); background: var(--surface-container-high); }
.skill-remove.confirming { color: #b91c1c; border-color: #b91c1c; }

.skill-upload {
  flex: 0 0 auto;
  padding: 3px 10px;
  font-size: 12px;
  color: var(--muted-foreground);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
}
.skill-upload:hover { background: var(--surface-container-high); }
.skill-upload.uploaded {
  color: var(--primary);
  border-color: var(--primary);
  background: transparent;
}
.skill-upload.uploaded:hover { background: var(--surface-container-high); }

/* 服务端技能「下载」按钮（主色描边，与「上传」回显同族） */
.skill-download {
  flex: 0 0 auto;
  padding: 3px 10px;
  font-size: 12px;
  color: var(--primary);
  border: 1px solid var(--primary);
  border-radius: var(--radius-md);
}
.skill-download:hover { background: var(--surface-container-high); }

.skill-empty {
  padding: 4px var(--space-2) 10px;
  font-size: 12px;
  color: var(--muted-foreground);
}

.skill-panel-foot {
  min-height: 22px;
  margin-top: var(--space-2);
}

.skill-msg {
  font-size: 12px;
  color: var(--foreground);
}
.skill-msg.muted { color: var(--muted-foreground); }

.custom-scroll::-webkit-scrollbar { width: 6px; height: 6px; }
.custom-scroll::-webkit-scrollbar-thumb { background: var(--surface-container-high); border-radius: 3px; }
</style>
