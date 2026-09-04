<script setup lang="ts">
// ═══════════════════════════════════════════════════════════════
// VideoTranscribe.vue — 视频转文字（条目③ 组件层：绘制 + 事件转发）
// 业务对齐原客户端 gui/transcription_page.py：
//   多文件批量队列（_add_paths/_start_batch/_process_next）→ 行级状态色
//   （_apply_row_color）→ SRT 预览/双击编辑回写（_enter/_exit_edit_mode +
//   _apply_edits）→ LLM 洗稿对话框（_show_rewrite_dialog，改写后保留时间轴
//   回写 _plain_to_srt）→ 四格式导出（_show_save_dialog/_convert_format：
//   srt/vtt/txt/plain）→ 行级失败重试（_retry_transcribe）
// 业务逻辑在 useTranscribeQueue.ts（编排）+ srtUtils.ts / voiceCloneLogic.ts（纯函数）
// ═══════════════════════════════════════════════════════════════
import { computed, ref } from 'vue'
import TButton from '@/components/common/TButton.vue'
import { useTranscribeQueue, STATUS_TEXT } from '@/composables/useTranscribeQueue'
import type { QueueStatus } from '@/composables/useTranscribeQueue'
import { useOfficeExport } from '@/composables/useOfficeExport'
import { buildTranscriptDocxStructure, formatDateTime } from '@/composables/officeDocLogic'

const q = useTranscribeQueue()
const {
  files, lang, busy, stageText, uploadPercent,
  selectedIndex, selected, editMode, editedText,
  pickFiles, onDrop, remove, retry, select, startBatch,
  enterEdit, exitEdit, rewriteSelected, applyRewriteResult, exportSrt,
} = q

/* ── 办公能力导出 Word（PRD §3.2④：SRT 时间轴 → docx；E1 无字幕禁用 / E6 导出中禁用）── */
const officeExport = useOfficeExport()
const exportBusy = computed(() => officeExport.state.value === 'exporting')

async function onExportWord(): Promise<void> {
  const f = selected.value
  if (exportBusy.value) return
  if (!f?.segments?.length) { window.alert?.('暂无内容可导出'); return }
  // 时长 = 最大段结束时间（无则省略该元信息行）
  const dur = f.segments.reduce((m, s) => Math.max(m, s.end || s.start || 0), 0)
  const structure = buildTranscriptDocxStructure(f.segments, {
    filename: f.name,
    durationSec: dur > 0 ? dur : undefined,
    transcribeTime: formatDateTime(new Date()),
  })
  const base = (f.name.replace(/\.[^.]+$/, '') || '转写').replace(/[\\/:*?"<>|]/g, '_')
  await officeExport.exportDocx(structure, `${base}.docx`)
}

const isDragging = ref(false)

// ── 洗稿对话框（对照 _show_rewrite_dialog：改写要求 + 生成 + 预览应用）──
const rewriteOpen = ref(false)
const rewriteHint = ref('')
const rewriteBusy = ref(false)
const rewriteResult = ref('')
const rewriteError = ref('')

const exportFormats: Array<{ fmt: 'srt' | 'vtt' | 'txt' | 'plain'; label: string }> = [
  { fmt: 'srt', label: 'SRT 字幕' },
  { fmt: 'vtt', label: 'WebVTT' },
  { fmt: 'txt', label: '带时间文本' },
  { fmt: 'plain', label: '纯文本' },
]

function statusClass(s: QueueStatus): string {
  return { wait: '', running: 'is-running', done: 'is-done', failed: 'is-failed' }[s] || ''
}

async function openRewrite(): Promise<void> {
  if (!selected.value?.srtText) return
  rewriteHint.value = ''
  rewriteResult.value = ''
  rewriteError.value = ''
  rewriteOpen.value = true
}

async function runRewrite(): Promise<void> {
  rewriteBusy.value = true
  rewriteError.value = ''
  rewriteResult.value = ''
  const res = await rewriteSelected(rewriteHint.value)
  rewriteBusy.value = false
  if (!res.ok) {
    rewriteError.value = res.error
    return
  }
  rewriteResult.value = res.content
}

function applyRewrite(): void {
  applyRewriteResult(rewriteResult.value)
  rewriteOpen.value = false
}
</script>

<template>
  <div class="tool-form">
    <!-- 顶部操作：添加文件 + 语言 + 开始处理（对照 _add_paths / _start_batch） -->
    <div class="action-row">
      <TButton
        label="添加文件"
        icon="upload"
        :disabled="busy"
        @click="pickFiles"
      />
      <input
        v-model="lang"
        class="lang-input"
        placeholder="语言（留空=自动识别）"
        :disabled="busy"
      />
      <TButton
        label="开始处理"
        icon="play"
        :disabled="!files.length && !busy"
        :loading="busy"
        @click="startBatch"
      />
      <span v-if="busy && uploadPercent > 0 && uploadPercent < 100" class="upload-progress">
        上传中 {{ uploadPercent }}%
      </span>
    </div>

    <!-- 拖拽区 -->
    <div
      class="dropzone"
      :class="{ 'is-active': isDragging }"
      @click="pickFiles"
      @drop.prevent="onDrop(); isDragging = false"
      @dragover.prevent="isDragging = true"
      @dragleave.prevent="isDragging = false"
    >
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12" />
      </svg>
      <span class="dropzone__text">点击选择或拖入媒体文件（可多选）· MP4 / MOV / MP3 / WAV 等</span>
    </div>

    <!-- 阶段提示 -->
    <div v-if="stageText" class="stage-line">{{ stageText }}</div>

    <!-- 队列列表（行级状态色对照 _apply_row_color） -->
    <div v-if="files.length" class="queue">
      <div
        v-for="(f, i) in files"
        :key="f.path"
        class="queue__row"
        :class="[statusClass(f.status), { 'is-selected': selectedIndex === i }]"
        @click="select(i)"
      >
        <div class="queue__main">
          <span class="queue__name" :title="f.path">{{ f.name }}</span>
          <span class="queue__preview" :title="f.preview">{{ f.preview }}</span>
        </div>
        <span class="queue__status">{{ STATUS_TEXT[f.status] }}</span>
        <div class="queue__actions" @click.stop>
          <!-- 图标操作（用户偏好：列表用图标） -->
          <button class="icon-btn" title="查看字幕" :disabled="!f.srtText" @click="select(i)">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
          </button>
          <button class="icon-btn" title="编辑字幕" :disabled="!f.srtText" @click="select(i); enterEdit()">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
          </button>
          <button class="icon-btn" title="重新转写" :disabled="busy" @click="retry(i)">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
          </button>
          <button class="icon-btn" title="移除" :disabled="busy" @click="remove(i)">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
          </button>
        </div>
      </div>
    </div>

    <!-- 字幕区：预览 / 编辑（对照 _render_subtitle_html + 编辑模式） -->
    <div v-if="selected" class="result">
      <div class="result__head">
        <span class="result__title">字幕 · {{ selected.name }}</span>
        <div class="result__ops">
          <TButton
            v-if="!editMode"
            label="导出 Word"
            icon="download"
            size="small"
            :disabled="!selected?.srtText || exportBusy"
            @click="onExportWord"
          />
          <TButton
            v-if="!editMode"
            label="编辑"
            icon="edit"
            size="small"
            :disabled="!selected.srtText"
            @click="enterEdit"
          />
          <TButton
            v-if="!editMode"
            label="AI 洗稿"
            icon="sparkles"
            size="small"
            :disabled="!selected.srtText"
            @click="openRewrite"
          />
          <template v-if="editMode">
            <TButton label="保存" icon="check" size="small" @click="exitEdit(true)" />
            <TButton label="取消" size="small" @click="exitEdit(false)" />
          </template>
        </div>
      </div>

      <textarea
        v-if="editMode"
        v-model="editedText"
        class="srt-editor"
        rows="12"
        spellcheck="false"
      />
      <pre v-else class="srt-view">{{ selected.srtText || '暂无字幕，请先处理该文件。' }}</pre>

      <!-- 导出（对照 _show_save_dialog/_convert_format 四格式） -->
      <div v-if="!editMode && selected.srtText" class="export-row">
        <span class="export-label">导出：</span>
        <button
          v-for="f in exportFormats"
          :key="f.fmt"
          class="chip-btn"
          @click="exportSrt(selectedIndex, f.fmt)"
        >
          {{ f.label }}
        </button>
      </div>
    </div>

    <!-- 洗稿对话框（对照 _show_rewrite_dialog） -->
    <div v-if="rewriteOpen" class="modal-mask" @click.self="rewriteOpen = false">
      <div class="modal">
        <div class="modal__head">
          <span class="modal__title">AI 洗稿 · {{ selected?.name }}</span>
          <button class="icon-btn" title="关闭" @click="rewriteOpen = false">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
        <input
          v-model="rewriteHint"
          class="text-input"
          placeholder="改写要求（留空=主题一致、字数相近）"
          :disabled="rewriteBusy"
        />
        <div class="modal__ops">
          <TButton label="生成新文案" icon="sparkles" :loading="rewriteBusy" @click="runRewrite" />
          <span v-if="rewriteError" class="rewrite-err">{{ rewriteError }}</span>
        </div>
        <pre v-if="rewriteResult" class="rewrite-preview">{{ rewriteResult }}</pre>
        <div class="modal__foot">
          <TButton
            label="应用（保留时间轴回写）"
            icon="check"
            :disabled="!rewriteResult"
            @click="applyRewrite"
          />
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.tool-form { display: flex; flex-direction: column; gap: var(--space-5); }

.action-row { display: flex; align-items: center; gap: var(--space-3); }
.lang-input {
  width: 200px; height: var(--size-input-height); padding: 0 var(--space-3);
  background: var(--surface-container); border: 1px solid var(--border);
  border-radius: var(--radius-md); color: var(--foreground); font-size: var(--font-size-body);
  outline: none; transition: border-color var(--duration-fast), box-shadow var(--duration-fast);
}
.lang-input::placeholder { color: var(--muted-foreground); }
.lang-input:focus { border-color: var(--primary); box-shadow: 0 0 0 2px var(--ring); }
.lang-input:disabled { opacity: 0.5; }
.upload-progress { font-size: var(--font-size-caption); color: var(--muted-foreground); }

.dropzone {
  display: flex; align-items: center; justify-content: center; gap: var(--space-3);
  padding: var(--space-4); background: color-mix(in srgb, var(--primary) 6%, var(--surface-container));
  border: 1.5px dashed color-mix(in srgb, var(--primary) 40%, var(--border)); border-radius: var(--radius-lg);
  color: var(--muted-foreground); cursor: pointer;
  transition: border-color var(--duration-fast), background var(--duration-fast);
}
.dropzone:hover, .dropzone.is-active { border-color: var(--primary); background: color-mix(in srgb, var(--primary) 12%, var(--surface-container)); }
.dropzone__text { font-size: var(--font-size-caption); }

.stage-line { font-size: var(--font-size-caption); color: var(--foreground-muted); }

/* 队列列表 */
.queue { display: flex; flex-direction: column; border: 1px solid var(--border-subtle); border-radius: var(--radius-lg); overflow: hidden; }
.queue__row {
  display: flex; align-items: center; gap: var(--space-3);
  padding: var(--space-2) var(--space-3); cursor: pointer;
  border-bottom: 1px solid var(--border-subtle);
  border-left: 3px solid transparent;
  transition: background var(--duration-fast);
}
.queue__row:last-child { border-bottom: none; }
.queue__row:hover { background: var(--surface-container); }
.queue__row.is-selected { background: var(--surface-container); border-left-color: var(--primary); }
/* 行级状态色（对照 _apply_row_color L695-709：等待灰/处理蓝/完成绿/失败红） */
.queue__row.is-running { border-left-color: var(--info); }
.queue__row.is-done { border-left-color: var(--success); }
.queue__row.is-failed { border-left-color: var(--error); }
.queue__main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.queue__name { font-size: var(--font-size-body); font-weight: var(--font-weight-medium); color: var(--foreground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.queue__preview { font-size: var(--font-size-caption); color: var(--muted-foreground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.queue__status { font-size: var(--font-size-caption); color: var(--muted-foreground); flex-shrink: 0; }
.queue__row.is-running .queue__status { color: var(--info); }
.queue__row.is-done .queue__status { color: var(--success); }
.queue__row.is-failed .queue__status { color: var(--error); }
.queue__actions { display: flex; align-items: center; gap: var(--space-1); flex-shrink: 0; }

.icon-btn {
  display: inline-flex; align-items: center; justify-content: center;
  width: 26px; height: 26px; border-radius: var(--radius-sm);
  color: var(--muted-foreground); background: transparent;
  transition: color var(--duration-fast), background var(--duration-fast);
}
.icon-btn:hover:not(:disabled) { color: var(--foreground); background: var(--surface-container-high); }
.icon-btn:disabled { opacity: 0.35; cursor: not-allowed; }

/* 字幕区 */
.result { display: flex; flex-direction: column; gap: var(--space-3); padding: var(--space-4); background: var(--surface-container); border: 1px solid var(--border-subtle); border-radius: var(--radius-lg); }
.result__head { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); }
.result__title { font-size: var(--font-size-lead); font-weight: var(--font-weight-semibold); color: var(--foreground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.result__ops { display: flex; align-items: center; gap: var(--space-2); flex-shrink: 0; }
.srt-view, .srt-editor {
  margin: 0; max-height: 380px; overflow: auto; padding: var(--space-3) var(--space-4);
  background: var(--surface); border: 1px solid var(--border-subtle); border-radius: var(--radius-md);
  font-family: var(--font-mono); font-size: var(--font-size-mono);
  line-height: var(--line-height-relaxed); color: var(--foreground);
  white-space: pre-wrap; word-break: break-word; width: 100%;
  box-sizing: border-box; resize: vertical; outline: none;
}
.srt-editor:focus { border-color: var(--primary); box-shadow: 0 0 0 2px var(--ring); }

.export-row { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; }
.export-label { font-size: var(--font-size-caption); color: var(--muted-foreground); }
.chip-btn {
  padding: 4px var(--space-3); font-size: var(--font-size-caption);
  border: 1px solid var(--border); border-radius: var(--radius-full);
  background: var(--surface); color: var(--foreground-muted);
  transition: border-color var(--duration-fast), color var(--duration-fast);
}
.chip-btn:hover { border-color: var(--primary); color: var(--primary); }

/* 洗稿对话框 */
.modal-mask {
  position: fixed; inset: 0; z-index: 100; display: flex; align-items: center; justify-content: center;
  background: rgba(0, 0, 0, 0.45); backdrop-filter: blur(2px);
}
.modal {
  width: min(640px, calc(100vw - 48px)); max-height: 80vh; overflow: auto;
  display: flex; flex-direction: column; gap: var(--space-3);
  padding: var(--space-5); background: var(--surface);
  border: 1px solid var(--border-subtle); border-radius: var(--radius-lg);
  box-shadow: var(--shadow-xl, 0 16px 40px rgba(0,0,0,0.25));
}
.modal__head { display: flex; align-items: center; justify-content: space-between; }
.modal__title { font-size: var(--font-size-lead); font-weight: var(--font-weight-semibold); color: var(--foreground); }
.modal__ops { display: flex; align-items: center; gap: var(--space-3); }
.modal__foot { display: flex; justify-content: flex-end; }
.text-input {
  width: 100%; height: var(--size-input-height); padding: 0 var(--space-3);
  background: var(--surface-container); border: 1px solid var(--border);
  border-radius: var(--radius-md); color: var(--foreground); font-size: var(--font-size-body);
  outline: none; box-sizing: border-box;
}
.text-input::placeholder { color: var(--muted-foreground); }
.text-input:focus { border-color: var(--primary); box-shadow: 0 0 0 2px var(--ring); }
.rewrite-err { font-size: var(--font-size-caption); color: var(--error); }
.rewrite-preview {
  margin: 0; padding: var(--space-3) var(--space-4); max-height: 260px; overflow: auto;
  background: var(--surface-container); border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md); font-size: var(--font-size-body);
  line-height: var(--line-height-relaxed); color: var(--foreground); white-space: pre-wrap;
}
</style>
