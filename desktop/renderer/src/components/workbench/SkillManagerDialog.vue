<script setup lang="ts">
// SkillManagerDialog.vue — 技能管理弹窗（2026-08-31 技能入口移植）
// 对齐原客户端 gui/skill_manager_dialog.py 能力：
//   · 安装单个 .md / 含 SKILL.md 的目录 / ZIP 包（对话框选择来源）
//   · 内置技能（随包分发）只读展示、不可卸载；用户技能可卸载
//   · 安装/卸载后由容器刷新列表（技能重新合并进快捷条/斜杠菜单）
// 纯展示 + 来源选择转发：安装/卸载业务在容器 useSkills（onInstall/onRemove）。
import { ref } from 'vue'
import type { SkillEntry } from '@/composables/skillsLogic'

defineProps<{
  visible: boolean
  builtin: SkillEntry[]
  user: SkillEntry[]
  loading?: boolean
  /** 安装/卸载操作结果提示（useSkills.actionMsg） */
  actionMsg?: string
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'install-file'): void
  (e: 'install-dir'): void
  (e: 'remove', id: string): void
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

function subText(s: SkillEntry): string {
  const d = String(s.description || '').trim()
  const tags = Array.isArray(s.tags) && s.tags.length ? `　标签：${s.tags.join(' / ')}` : ''
  return d ? `${d}${tags}` : tags
}
</script>

<template>
  <Transition name="skill-dlg">
    <div v-if="visible" class="skill-dlg-mask" @click.self="emit('close')">
      <div class="skill-dlg" role="dialog" aria-label="技能管理">
        <div class="skill-dlg-head">
          <span class="skill-dlg-title">技能管理</span>
          <button class="skill-dlg-x" title="关闭" @click="emit('close')">×</button>
        </div>
        <p class="skill-dlg-tip">
          技能为含 SKILL.md 的本地指令包；安装后与智能体一样出现在快捷条和斜杠菜单，
          选中后以「请按技能【…】执行」注入对话。
        </p>

        <div class="skill-dlg-actions">
          <button class="skill-btn" title="选择 .md 技能文件或 .zip 技能包" @click="emit('install-file')">
            安装文件（.md / .zip）
          </button>
          <button class="skill-btn" title="选择含 SKILL.md 的技能目录（整目录复制）" @click="emit('install-dir')">
            安装目录
          </button>
        </div>

        <div class="skill-dlg-body">
          <div class="skill-section">内置技能（随客户端分发，不可卸载）</div>
          <div v-if="!builtin.length" class="skill-empty">暂无内置技能</div>
          <div v-for="s in builtin" :key="'b-' + s.id" class="skill-row">
            <div class="skill-main">
              <span class="skill-name">{{ s.name || s.id }}</span>
              <span v-if="subText(s)" class="skill-sub">{{ subText(s) }}</span>
            </div>
          </div>

          <div class="skill-section">已安装技能</div>
          <div v-if="!user.length" class="skill-empty">尚未安装本地技能</div>
          <div v-for="s in user" :key="'u-' + s.id" class="skill-row">
            <div class="skill-main">
              <span class="skill-name">{{ s.name || s.id }}</span>
              <span v-if="subText(s)" class="skill-sub">{{ subText(s) }}</span>
            </div>
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

        <div class="skill-dlg-foot">
          <span v-if="actionMsg" class="skill-msg">{{ actionMsg }}</span>
          <span v-else-if="loading" class="skill-msg muted">加载中…</span>
        </div>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.skill-dlg-mask {
  position: fixed;
  inset: 0;
  z-index: 60;
  background: color-mix(in srgb, black 45%, transparent);
  display: flex;
  align-items: center;
  justify-content: center;
}

.skill-dlg {
  width: min(560px, calc(100vw - 48px));
  max-height: min(640px, calc(100vh - 64px));
  display: flex;
  flex-direction: column;
  padding: var(--space-5);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-xl);
  box-shadow: var(--shadow-modal);
}

.skill-dlg-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.skill-dlg-title {
  font-size: 15px;
  font-weight: var(--font-weight-semibold);
  color: var(--foreground);
}

.skill-dlg-x {
  width: 26px;
  height: 26px;
  font-size: 16px;
  color: var(--muted-foreground);
  border-radius: var(--radius-md);
}
.skill-dlg-x:hover { background: var(--surface-container-high); color: var(--foreground); }

.skill-dlg-tip {
  margin: var(--space-2) 0 var(--space-3);
  font-size: 12px;
  line-height: 1.6;
  color: var(--muted-foreground);
}

.skill-dlg-actions {
  display: flex;
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

.skill-dlg-body {
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

.skill-empty {
  padding: 4px var(--space-2) 10px;
  font-size: 12px;
  color: var(--muted-foreground);
}

.skill-dlg-foot {
  min-height: 22px;
  margin-top: var(--space-2);
}

.skill-msg {
  font-size: 12px;
  color: var(--foreground);
}
.skill-msg.muted { color: var(--muted-foreground); }

.skill-dlg-enter-active,
.skill-dlg-leave-active { transition: opacity var(--duration-fast); }
.skill-dlg-enter-from,
.skill-dlg-leave-to { opacity: 0; }
</style>
