<script setup lang="ts">
// ═══════════════════════════════════════════════════════════════
// AudioGen.vue — 音频生成（媒体工具·音频组）
// 移植原客户端 audio_material_page.py：左列 = 「全部」tab 音频列表（L455-571，
// 语义搜索 + 分类过滤 + 双击试听 + 分页）；右列 = 「 AI 生成」tab 两组
// （BGM MusicGen / 音效 AudioLDM2，L1568-1684）上下排列。
// 2026-09-04 用户裁决：左右两栏布局，右侧两面板上下排列（不用 tab）。
// 架构差异（注明）：播放原版走临时文件下载 + QMediaPlayer，V3 内联
// <audio controls> 流式播放（/material/serve 与结果 URL 拼服务端基址）。
// ═══════════════════════════════════════════════════════════════
import { ref, onMounted } from 'vue'
import TButton from '@/components/common/TButton.vue'
import TSelect from '@/components/common/TSelect.vue'
import { useAudioGen } from '@/composables/useAudioGen'

const s = useAudioGen()
const {
  bgmStyle, bgmStyleOptions, bgmDuration, bgmBusy, bgmResultLabel, bgmUrl, bgmSaving,
  generateBgm, saveBgmToLib,
  sfxPrompt, sfxDuration, sfxBusy, sfxResultLabel, sfxUrl, sfxSaving,
  generateSfx, saveSfxToLib,
  toAbsolute,
  // 音频列表（原「全部」tab）
  listQuery, listTag, listKind, LIST_KIND_OPTIONS,
  listRows, listLoading, listError, listStat, listPageSize,
  pageLabel, canPrevPage, canNextPage,
  doSearch, goPrevPage, goNextPage,
  // 2026-09-05 用户裁决合并：「标签」下拉已删——生成与入库统一用「风格」（bgmStyle）
  loadBgmTags,
  bgmMood, bgmMoodOptions, bgmScene, bgmSceneOptions,
  playingMid, listAudioEl, playListRow,
  downloadRow, deleteRow,
  kindOverrides, setRowKind,
} = s

// ── 行内分类下拉（本地覆盖，见 useAudioGen 铁律注释）──
const KIND_EDIT_OPTIONS = [
  { value: '', label: '未分类' },
  { value: 'sfx', label: '音效' },
  { value: 'voice', label: '配音' },
  { value: 'music', label: '音乐' },
]
function kindValueOf(it: { mid: string; kindCode: string }): string {
  return kindOverrides.value[it.mid] ?? it.kindCode
}

// ── 生成面板内联播放（原 icon_button("play") 触发；<audio controls> 可暂停/拖动）──
const bgmAudioEl = ref<HTMLAudioElement | null>(null)
const sfxAudioEl = ref<HTMLAudioElement | null>(null)

function playBgm(): void {
  const el = bgmAudioEl.value
  if (!el || !bgmUrl.value) return
  el.src = toAbsolute(bgmUrl.value)
  void el.play().catch(() => { /* 加载失败静默（服务端不可达时结果标签已有错误态） */ })
}

function playSfx(): void {
  const el = sfxAudioEl.value
  if (!el || !sfxUrl.value) return
  el.src = toAbsolute(sfxUrl.value)
  void el.play().catch(() => { /* 同上 */ })
}

/** 进入页面拉取列表 + 服务端 BGM 标签体系（2026-09-04 用户裁决：tag 服务端定义） */
onMounted(() => { doSearch(); void loadBgmTags() })
</script>

<template>
  <section class="audio-gen">
    <!-- ═══ 左栏：音频列表（原「全部」tab） ═══ -->
    <aside class="list-pane">
      <div class="list-search">
        <input
          v-model="listQuery"
          class="text-input"
          type="text"
          placeholder="搜索音频（语义检索，如：激昂的背景音乐）"
          :disabled="listLoading"
          @keydown.enter="doSearch()"
        />
        <TButton label="搜索" variant="primary" :loading="listLoading" :disabled="listLoading" @click="doSearch()" />
      </div>

      <div class="list-filters">
        <label class="row-label">分类:</label>
        <TSelect v-model="listKind" class="kind-select" :options="[...LIST_KIND_OPTIONS]" :disabled="listLoading" @update:model-value="doSearch()" />
        <input
          v-model="listTag"
          class="text-input tag-input"
          type="text"
          placeholder="情绪/场景标签"
          :disabled="listLoading"
          @keydown.enter="doSearch()"
        />
      </div>

      <div class="list-rows">
        <div v-if="!listLoading && !listError && !listRows.length" class="list-state">暂无音频，试试调整筛选条件。</div>
        <button
          v-for="it in listRows"
          v-else
          :key="it.mid"
          class="list-row"
          :class="{ active: playingMid === it.mid }"
          type="button"
          :title="`${it.filename}\n分类: ${it.kindName}\n时长: ${it.durStr}\n大小: ${it.sizeStr}${it.scene ? `\n描述: ${it.scene}` : ''}`"
          @dblclick="playListRow(it)"
        >
          <span class="row-name" :title="it.filename">{{ it.filename }}</span>
          <select
            :class="['row-kind', 'kind-edit', 'kind--' + (kindValueOf(it) || 'none')]"
            :value="kindValueOf(it)"
            :title="`修改分类：${it.filename}`"
            @change="setRowKind(it, ($event.target as HTMLSelectElement).value)"
            @click.stop
            @dblclick.stop
          >
            <option v-for="o in KIND_EDIT_OPTIONS" :key="o.value" :value="o.value">{{ o.label }}</option>
          </select>
          <span class="row-meta">{{ it.durStr }}</span>
          <span class="row-meta">{{ it.sizeStr }}</span>
          <!-- 2026-09-04 用户裁决：行内增加 播放/下载 按钮（单击触发，不与双击试听冲突） -->
          <!-- 外层行是 button，内层用 span[role=button]（HTML 不允许嵌套 button） -->
          <!-- 2026-09-05 用户裁决：换统一 Lucide SVG 图标（与 TButton/全程序同一套，替代 ▶⤓✕ 字符） -->
          <span class="row-act" role="button" tabindex="-1" title="播放" @click.stop="playListRow(it)" @dblclick.stop @keydown.enter.stop="playListRow(it)">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 3l14 9-14 9V3z" /></svg>
          </span>
          <span class="row-act" role="button" tabindex="-1" title="下载" @click.stop="downloadRow(it)" @dblclick.stop @keydown.enter.stop="downloadRow(it)">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" /></svg>
          </span>
          <!-- 2026-09-05 用户裁决：行内删除（DELETE /audio/library/{id}，连源文件一并删除） -->
          <span class="row-act row-act--danger" role="button" tabindex="-1" title="删除" @click.stop="deleteRow(it)" @dblclick.stop @keydown.enter.stop="deleteRow(it)">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
          </span>
        </button>
      </div>

      <!-- 2026-09-05 用户裁决（纠正）：统计+提示独占一行（原样一行）；换页/播放条/每页设置单独一行 -->
      <div class="list-page">
        <span class="page-stat" :class="{ 'page-stat--error': listError }" :title="listError || listStat">{{ listError || (listLoading ? '加载中...' : `${listStat} · 双击试听或点行内 ▶ 播放`) }}</span>
        <div class="page-controls">
          <TButton label="上一页" variant="secondary" size="small" :disabled="!canPrevPage || listLoading" @click="goPrevPage()" />
          <span class="page-label">{{ pageLabel }}</span>
          <TButton label="下一页" variant="secondary" size="small" :disabled="!canNextPage || listLoading" @click="goNextPage()" />
          <!-- 试听播放条居中于「下一页」与「每页」之间（2026-09-04 用户裁决） -->
          <div class="list-player">
            <audio v-if="playingMid" ref="listAudioEl" controls class="inline-audio" />
          </div>
          <label class="row-label">每页:</label>
          <input
            v-model.number="listPageSize"
            class="num-input num-input--sm"
            type="number"
            min="10"
            max="200"
            step="10"
            :disabled="listLoading"
            @change="doSearch()"
          />
        </div>
      </div>
    </aside>

    <!-- ═══ 右栏：AI 生成两组上下排列 ═══ -->
    <div class="gen-pane">
      <!-- 组1：生成 BGM -->
      <div class="gen-group">
        <h2 class="group-title">生成 BGM</h2>

        <!-- 2026-09-05 最终裁决：纯结构化口径 {style,mood,duration}，无描述输入——
             GUIDE 无 prompt 字段（服务端自组 prompt），保留描述框=假功能 -->
        <div class="params-row">
          <label class="row-label">风格:</label>
          <!-- 2026-09-05 用户裁决合并：风格生成/入库两用（入库 style='auto' 时传空）；
               候选 = 自动 + 服务端 /audio/bgm/tags style 组（分类由服务端固定'配乐'） -->
          <TSelect v-model="bgmStyle" class="style-select" :options="bgmStyleOptions" :disabled="bgmBusy" />
          <label class="row-label row-label--gap">时长(秒):</label>
          <!-- 2026-09-05 用户裁决：客户端生成 BGM 时长限制 30 秒内，最高选 30 -->
          <input v-model.number="bgmDuration" class="num-input" type="number" min="5" max="30" step="5" :disabled="bgmBusy" />
        </div>

        <!-- 2026-09-05 用户裁决：情绪/场景精控下拉（服务端 /audio/bgm/tags 的 mood/scene 组；保存随 mood/scene 字段上传） -->
        <div class="params-row">
          <label class="row-label">情绪:</label>
          <TSelect v-model="bgmMood" class="tag-select" :options="bgmMoodOptions" :disabled="bgmBusy" />
          <label class="row-label row-label--gap">场景:</label>
          <TSelect v-model="bgmScene" class="tag-select" :options="bgmSceneOptions" :disabled="bgmBusy" />
        </div>

        <!-- 2026-09-04 用户裁决：生成按钮独立一行（参数行不再拼按钮，避免挤压） -->
        <div class="params-row gen-row">
          <span class="flex-spacer" />
          <TButton label="生成 BGM" variant="primary" :loading="bgmBusy" :disabled="bgmBusy" @click="generateBgm()" />
        </div>

        <div v-if="bgmBusy" class="gen-progress"><div class="gen-progress-bar" /></div>

        <p v-if="bgmResultLabel" class="result-label">{{ bgmResultLabel }}</p>

        <div class="action-row">
          <TButton label="播放生成的 BGM" variant="ghost" size="small" class="action-btn" :disabled="!bgmUrl" @click="playBgm" />
          <TButton label="保存到 BGM 库" variant="secondary" size="small" class="action-btn" :loading="bgmSaving" :disabled="!bgmUrl || bgmSaving" @click="saveBgmToLib" />
          <audio v-if="bgmUrl" ref="bgmAudioEl" controls class="inline-audio" />
        </div>
      </div>

      <!-- 组2：生成音效 -->
      <div class="gen-group">
        <h2 class="group-title">生成音效</h2>

        <div class="prompt-row">
          <label class="row-label">描述:</label>
          <input
            v-model="sfxPrompt"
            class="text-input"
            type="text"
            placeholder="描述你想要的音效，如：门铃声、打字声、雨声、爆炸效果"
            :disabled="sfxBusy"
            @keydown.enter="generateSfx()"
          />
        </div>

        <div class="params-row">
          <label class="row-label">时长(秒):</label>
          <input v-model.number="sfxDuration" class="num-input" type="number" min="1" max="15" :disabled="sfxBusy" />
        </div>

        <!-- 生成按钮独立一行（同 BGM 组口径） -->
        <div class="params-row gen-row">
          <span class="flex-spacer" />
          <TButton label="生成音效" variant="primary" :loading="sfxBusy" :disabled="sfxBusy" @click="generateSfx()" />
        </div>

        <div v-if="sfxBusy" class="gen-progress"><div class="gen-progress-bar" /></div>

        <p v-if="sfxResultLabel" class="result-label">{{ sfxResultLabel }}</p>

        <div class="action-row">
          <TButton label="播放生成的音效" variant="ghost" size="small" class="action-btn" :disabled="!sfxUrl" @click="playSfx" />
          <TButton label="保存到音效库" variant="secondary" size="small" class="action-btn" :loading="sfxSaving" :disabled="!sfxUrl || sfxSaving" @click="saveSfxToLib" />
          <audio v-if="sfxUrl" ref="sfxAudioEl" controls class="inline-audio" />
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.audio-gen {
  width: 100%;
  height: 100%;
  display: grid;
  grid-template-columns: minmax(360px, 6fr) 4fr; /* 2026-09-05 用户裁决：左右 6:4 */
  gap: var(--space-4);
  align-items: start;
}

/* ── 左栏：音频列表 ── */
.list-pane {
  display: flex;
  flex-direction: column;
  /* 2026-09-05 用户裁决：一屏 20 条——gap/padding 收紧（12/8），纵向开销让给列表区 */
  gap: var(--space-2);
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: var(--radius-xl);
  padding: var(--space-3);
}
.list-search { display: flex; align-items: center; gap: var(--space-2); }
.list-search .text-input { flex: 1 1 auto; }
.list-filters { display: flex; align-items: center; gap: var(--space-2); }
.kind-select { width: 170px; }
.tag-input { max-width: 140px; }

.list-rows {
  display: flex;
  flex-direction: column;
  min-height: 240px;
  /* 2026-09-05 三次裁决：默认高度 600px（小窗口按视口收缩，270px = 非列表纵向开销）；
     行高与过滤栏同源 token（--size-input-height = 34px） */
  height: min(600px, calc(100vh - 270px));
  overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
}
.list-state {
  padding: var(--space-6) var(--space-4);
  text-align: center;
  font-size: var(--font-size-body);
  color: var(--muted-foreground);
}
.list-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  /* 2026-09-05 四次裁决：行高 36px（用户指定；此前 34px 对齐 --size-input-height token），
     行内分类下拉 height:100% 跟随撑满 */
  /* 根因修复（2026-09-05 用户实测抓出）：.list-rows 是固定高度 flex 纵向容器，
     行未设 flex-shrink:0 → 20×36=720 > 600 被压缩到 ~30px/行，
     导致此前 31/34/36px 三轮改动实际渲染全部无效（始终 ≈600/20）。 */
  flex: 0 0 auto;
  height: 36px;
  padding: 0 var(--space-3);
  background: transparent;
  border: none;
  border-bottom: 1px solid var(--border);
  color: var(--foreground);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
  transition: background var(--duration-fast);
}
.list-row:last-child { border-bottom: none; }
.list-row:hover { background: var(--surface-container); }
/* 2026-09-05 用户裁决（美化 1+2+3）：
   ②播放行强调 = 主色左边条 + 淡主色底；
   ③文件名加粗 + 行 hover 变主色（暗示可双击试听） */
.list-row.active {
  background: color-mix(in srgb, var(--primary) 10%, transparent);
  box-shadow: inset 3px 0 0 var(--primary);
}
.row-name {
  flex: 1 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
  transition: color var(--duration-fast);
}
.list-row:hover .row-name { color: var(--primary); }
.row-kind {
  flex: 0 0 auto;
  width: 102px; /* 2026-09-05 用户裁决：胶囊再拉长 1/2（68→102px） */
  text-align: center;
  font-size: 12px;
  color: var(--muted-foreground);
  background: var(--surface-container);
  border-radius: var(--radius-md);
  padding: 0 var(--space-2);
  white-space: nowrap;
}
/* 行内分类下拉（本地覆盖）。2026-09-05 五次裁决：固定 32px（36px 行内上下各留 4px） */
select.row-kind {
  height: 32px;
  border: 1px solid var(--border);
  cursor: pointer;
  outline: none;
  transition: border-color var(--duration-fast), background var(--duration-fast);
}
select.row-kind:hover { border-color: var(--primary); }
select.row-kind:focus { border-color: var(--primary); }
/* 2026-09-05 用户裁决（美化①）：分类胶囊按类型着色，替代全灰一片
   音乐=淡蓝 / 音效=淡绿 / 配音=淡紫 / 未分类=中性灰；文字同色系加深保证对比度 */
select.row-kind.kind--music { background: color-mix(in srgb, #3b82f6 14%, transparent); color: #2563eb; border-color: transparent; }
select.row-kind.kind--sfx { background: color-mix(in srgb, #10b981 14%, transparent); color: #059669; border-color: transparent; }
select.row-kind.kind--voice { background: color-mix(in srgb, #8b5cf6 14%, transparent); color: #7c3aed; border-color: transparent; }
select.row-kind.kind--none { background: var(--surface-container); color: var(--muted-foreground); border-color: transparent; }
select.row-kind.kind--music:hover, select.row-kind.kind--sfx:hover,
select.row-kind.kind--voice:hover, select.row-kind.kind--none:hover { border-color: var(--primary); }
.row-meta { flex: 0 0 auto; width: 48px; text-align: right; color: var(--muted-foreground); }

/* 行内 播放/下载/删除 图标按钮（2026-09-05 用户裁决：去边框去底色的 ghost 样式，
   32px 热区不变，图标本体加大到 18px——之前只是框大图标小） */
.row-act {
  flex: 0 0 auto;
  width: 32px;
  height: 32px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: var(--radius-sm, 6px);
  background: transparent;
  color: var(--foreground);
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
  transition: background var(--duration-fast), color var(--duration-fast);
}
.row-act:hover { background: var(--surface-container); color: var(--primary); }
/* 删除按钮：hover 红色警示（2026-09-05 用户裁决新增） */
.row-act--danger:hover { color: var(--destructive, #ef4444); }

/* 2026-09-05 用户裁决（纠正）：统计+提示独占一行；换页/播放条/每页设置单独一行 */
.list-page { display: flex; flex-direction: column; gap: 4px; }
.page-stat {
  min-width: 0;
  font-size: 12px;
  color: var(--muted-foreground);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.page-stat--error { color: var(--danger, #dc2626); }
.page-controls { display: flex; align-items: center; gap: var(--space-2); }
.page-label { font-size: 12px; color: var(--muted-foreground); }
.flex-spacer { flex: 1 1 auto; }

/* 试听播放条：居中于「下一页」与「每页」之间（2026-09-04 用户裁决） */
.list-player {
  flex: 1 1 auto;
  display: flex;
  justify-content: center;
  min-width: 0;
}
.inline-audio { width: 100%; max-width: 420px; height: 32px; }

/* ── 右栏：生成面板上下排列 ── */
.gen-pane {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  min-width: 0;
}

/* 分组框（对照原 QGroupBox；占满整行） */
.gen-group {
  width: 100%;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: var(--radius-xl);
  padding: var(--space-5) var(--space-6); /* 2026-09-04 用户裁决：面板内留白加宽 */
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}
.group-title {
  margin: 0 0 var(--space-1);
  font-size: var(--font-size-h3);
  font-weight: 700;
  color: var(--foreground);
}

/* 行布局（对照原 QHBoxLayout） */
.prompt-row,
.params-row,
.gen-row,
.action-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

/* 生成按钮独立行：右对齐（flex-spacer 顶开），与参数行保持呼吸间距 */
.gen-row { margin-top: var(--space-1); }
.row-label {
  font-size: var(--font-size-body);
  color: var(--foreground);
  white-space: nowrap;
}
.row-label--gap { margin-left: var(--space-3); }

.text-input {
  flex: 1 1 auto;
  min-width: 0;
  height: 34px;
  padding: 0 var(--space-3);
  background: var(--surface-container);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  color: var(--foreground);
  font-size: var(--font-size-body);
  outline: none;
  transition: border-color var(--duration-fast), box-shadow var(--duration-fast);
}
.text-input::placeholder { color: var(--muted-foreground); }
.text-input:focus { border-color: var(--primary); box-shadow: 0 0 0 2px var(--ring); }
.text-input:disabled { opacity: 0.6; }

.style-select { width: 120px; }
.tag-select { width: 150px; }

.num-input {
  width: 84px;
  height: 34px;
  padding: 0 var(--space-2);
  background: var(--surface-container);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  color: var(--foreground);
  font-size: var(--font-size-body);
  outline: none;
  transition: border-color var(--duration-fast), box-shadow var(--duration-fast);
}
.num-input--sm { width: 68px; height: 28px; }
.num-input:focus { border-color: var(--primary); box-shadow: 0 0 0 2px var(--ring); }
.num-input:disabled { opacity: 0.6; }

/* 不定进度条（对照原 QProgressBar setRange(0,0)） */
.gen-progress {
  height: 4px;
  border-radius: 999px;
  background: var(--surface-container);
  overflow: hidden;
}
.gen-progress-bar {
  height: 100%;
  width: 40%;
  border-radius: 999px;
  background: var(--primary);
  animation: gen-indeterminate 1.2s ease-in-out infinite;
}
@keyframes gen-indeterminate {
  0% { transform: translateX(-100%); }
  100% { transform: translateX(350%); }
}

/* 结果标签（对照原 muted_text WordWrap 多行）；预留两行高度避免生成后跳动 */
.result-label {
  margin: 0;
  min-height: 40px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--muted-foreground);
  white-space: pre-line;
  word-break: break-all;
}

.action-row { flex-wrap: wrap; }
/* 2026-09-04 用户裁决：播放/保存两按钮平分剩余宽度 */
.action-row .action-btn { flex: 1 1 0; min-width: 0; }
.action-row .inline-audio { width: 100%; max-width: none; flex-basis: 100%; }

/* 响应式：窄屏退化为上下堆叠 */
@media (max-width: 980px) {
  .audio-gen { grid-template-columns: 1fr; }
}
</style>
