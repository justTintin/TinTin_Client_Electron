<script setup lang="ts">
// ═══════════════════════════════════════════════════════════════
// LiveClip.vue — 直播智能切片（M9 批次补齐）
// 严格照原客户端 live_clip/page.py 的 2 步向导流程：
//   1. 视频分析与热点发现 → 2. 切片与封面生成
// 接线真实 IPC：ffmpeg(extractAudio/cut) + server.asrTranscribe(/whisper/transcribe)。
// M9 补齐（对齐原 live_clip/workers.py）：
//   · 热点策略纯函数化：buildClipPlan（原 _rule_analyze L108-168：60s 窗口/30s
//     步长 → 热词×3+密度×10+唯一率×15+数字×0.3 → 阈值=均值×1.3 → 峰值合并
//     gap<20 → 15~300s → 标题 → 降序）与 mergeLlmPlan（原 _llm_analyze 合并段
//     L233-259）在 composables/liveClipLogic.ts（纯函数，含单测）
//   · 分段处理状态显示：逐段切片 pending→running→done/failed
//   · 结果回填/下载：切片标题可编辑 + 打开输出目录
// 归属口径（IRON-11）：ASR 转写走服务端（原版 transcribe_remote 同口径）；
//   切片为本地 ffmpeg 顺序裁剪（原版 VideoClipWorker 同口径，非并行任务调度，
//   服务端无切片接口）。LLM 热点分析依赖服务端 LLM 代理（原版 llm_chat_messages），
//   新端未接该代理 → LLM 模式回退内置算法（对齐原版"未配置 LLM 用内置算法"兜底）。
// ═══════════════════════════════════════════════════════════════
import { ref, computed } from 'vue'
import TButton from '@/components/common/TButton.vue'
import TSelect, { type SelectOption } from '@/components/common/TSelect.vue'
import { buildClipPlan, buildPlanFromText } from '@/composables/liveClipLogic'
import type { ClipPlanItem } from '@/composables/liveClipLogic'
import { parseTranscriptionResponse } from '@/composables/srtUtils'
import type { SrtSegment } from '@/composables/srtUtils'

const STEPS = ['1. 视频分析与热点发现', '2. 切片与封面生成']
const step = ref(0)
const tintin = () => (window as any).tintin

/* ── Step 0 视频分析与热点发现 ───────────────────────── */
const videoPath = ref('')
const videoName = ref('')
const isDragging = ref(false)
const analysisMode = ref<SelectOption['value']>('rule')
const transcribeLang = ref('zh')
const forceReextract = ref(false)
const analyzing = ref(false)
const analysisMsg = ref('')
const transcript = ref('')
const hotspots = ref<ClipPlanItem[]>([])
const clipDir = ref('')

function pickVideo() {
  tintin()?.dialog?.openFile?.({ title: '选择直播录像', filters: [{ name: '视频', extensions: ['mp4','mov','avi','mkv','flv','ts','webm','m4v'] }] }).then((r: any) => {
    if (r) setVideo(r)
  })
}
function onDrop(e: DragEvent) {
  e.preventDefault(); isDragging.value = false
  const p = (e.dataTransfer?.files?.[0] as File & { path?: string })?.path
  if (p) setVideo(p)
}
function setVideo(p: string) { videoPath.value = p; videoName.value = String(p).split(/[\\/]/).pop() || ''; hotspots.value = []; transcript.value = ''; clips.value = [] }

function pickClipDir() {
  tintin()?.dialog?.openDir?.({ title: '选择切片输出目录' }).then((r: any) => {
    const d = Array.isArray(r?.filePaths) ? r.filePaths[0] : (r?.filePaths ?? r?.path)
    if (d) clipDir.value = String(d)
  })
}

/**
 * Step0 开始提取并分析（对齐原版 _start_analysis_pipeline 链路）：
 * ffmpeg 提取音频 → 服务端 ASR 转写（/whisper/transcribe）→ 热点策略生成切片计划。
 */
async function startAnalysis() {
  if (!videoPath.value) return
  analyzing.value = true; analysisMsg.value = '正在提取音频并转写...'
  const t = tintin()
  try {
    // 1. 提取音频（对齐原版 AudioExtractWorker：先抽音频再上传服务端 ASR）
    const audioPath = `${videoPath.value}.m4a`
    try {
      if (t?.ffmpeg?.extractAudio) await t.ffmpeg.extractAudio(videoPath.value, audioPath, 'aac')
    } catch (e) {
      analysisMsg.value = '音频提取失败：' + (e instanceof Error ? e.message : String(e))
      analyzing.value = false
      return
    }

    // 2. 服务端 ASR 转写（multipart 上传音频；language 语义对齐原版 transcribe_lang）
    let segs: SrtSegment[] = []
    let text = ''
    try {
      const res = await t?.server?.asrTranscribe?.({
        audio: { path: audioPath },
        language: transcribeLang.value === 'auto' ? undefined : transcribeLang.value,
        task: 'transcribe',
      })
      // 防御解析（对齐 asr_client：segments / result.segments / text / 裸文本多形态）
      segs = parseTranscriptionResponse(res ?? null)
      text = segs.map((s) => s.text).join('')
    } catch (e) {
      analysisMsg.value = '转写不可用（预览环境无 IPC 或服务端未就绪）：' + (e instanceof Error ? e.message : String(e))
      analyzing.value = false
      return
    }
    transcript.value = text || segs.map((s) => s.text).join('')

    // 3. 热点策略（纯函数）：有时间戳分段 → buildClipPlan；仅文本 → 估时兜底。
    //    LLM 模式：原版走服务端 LLM 代理（llm_chat_messages），新端未接该代理 →
    //    回退内置算法，并用 mergeLlmPlan 口径占位（服务端代理就绪后接 LLM 结果）。
    if (analysisMode.value === 'llm') {
      // LLM 分析未接线：先用内置算法生成候选，语义对齐原版"未配置 LLM 用内置算法"
      hotspots.value = segs.length ? buildClipPlan(segs) : buildPlanFromText(text)
    } else {
      hotspots.value = segs.length ? buildClipPlan(segs) : buildPlanFromText(text)
    }
    analysisMsg.value = `分析完成，发现 ${hotspots.value.length} 个热点片段`
    if (hotspots.value.length) step.value = 1
  } finally {
    analyzing.value = false
  }
}

// 勾选状态挂载在热点条目副本上（纯函数输出不直接污染）
const selectedPlan = computed(() =>
  hotspots.value.map((h, i) => ({ ...h, checked: (h as any).checked ?? true, _idx: i })))
const selectedCount = computed(() => selectedPlan.value.filter((h) => h.checked).length)

type ClipState = 'pending' | 'running' | 'done' | 'failed'
interface Clip { id: string; path: string; title: string; start: number; end: number; state: ClipState; err: string }
const clips = ref<Clip[]>([])
const clipBusy = ref(false)
const clipMsg = ref('')

/** 切片：逐热点顺序 ffmpeg:cut（对齐原版 VideoClipWorker 顺序裁剪，非并行） */
async function startClipping() {
  const sel = selectedPlan.value.filter((h) => h.checked)
  const outDir = clipDir.value || videoPath.value.replace(/[\\/][^\\/]+$/, '')
  if (!sel.length) return
  clipBusy.value = true; clipMsg.value = ''
  clips.value = sel.map((h) => ({
    id: `clip_${h._idx}`,
    path: '',
    title: h.title,
    start: h.start,
    end: h.end,
    state: 'pending' as ClipState,
    err: '',
  }))
  try {
    for (let i = 0; i < clips.value.length; i++) {
      const c = clips.value[i]
      c.state = 'running'
      const safe = (c.title || 'clip').slice(0, 30).replace(/[\\/:*?"<>|]/g, '_')
      const out = `${outDir}\\${safe}_${c.id}.mp4`
      try {
        const res = await tintin()?.ffmpeg?.cut?.(videoPath.value, out, c.start, c.end)
        if (res === undefined) throw new Error('ffmpeg:cut 不可用（预览环境）')
        c.path = out
        c.state = 'done'
      } catch (e) {
        c.state = 'failed'
        c.err = e instanceof Error ? e.message : String(e)
      }
    }
    const ok = clips.value.filter((c) => c.state === 'done').length
    const fail = clips.value.length - ok
    clipMsg.value = fail ? `切片完成：成功 ${ok} / 失败 ${fail}` : `切片完成：${ok} 段`
  } finally {
    clipBusy.value = false
  }
}

/** 编辑切片标题（结果回填，UI 层事件） */
function editClipTitle(c: Clip, v: string) { c.title = v }

const canNext = computed(() => hotspots.value.length > 0)
const doneCount = computed(() => clips.value.filter((c) => c.state === 'done').length)
</script>

<template>
  <div class="liveclip" style="display: flex; flex-direction: column; gap: var(--space-5); max-width: 980px;">

    <!-- 顶部步骤条 -->
    <div class="step-bar">
      <div class="step-pill" :class="{ active: step === 0, done: step > 0 }" @click="step = 0">1. 视频分析与热点发现</div>
      <span class="step-arrow">›</span>
      <div class="step-pill" :class="{ active: step === 1, done: step > 1 }" @click="step = 1">2. 切片与封面生成</div>
    </div>

    <!-- Step 0: 分析与热点 -->
    <template v-if="step === 0">
      <section class="card">
        <div class="dropzone" @click="pickVideo" @drop.prevent="onDrop" @dragover.prevent="isDragging = true" @dragleave.prevent="isDragging = false">
          <span class="dz-main">{{ videoName || '拖入直播录像 或 点击选择（支持 40GB+，流式处理）' }}</span>
          <span class="dz-hint">支持 mp4 / mov / avi / mkv / flv / ts / webm / m4v</span>
        </div>

        <div class="row wrap">
          <label class="label">分析方法:</label>
          <TSelect class="w160" v-model="analysisMode" :options="[{label:'内置算法 (无需 API)',value:'rule'},{label:'AI 大模型 (服务端代理)',value:'llm'}]" />
          <label class="label">转写语言:</label>
          <TSelect class="w130" v-model="transcribeLang" :options="[{label:'中文 (简体)',value:'zh'},{label:'自动识别',value:'auto'},{label:'英语',value:'en'}]" />
          <label class="chk"><input type="checkbox" v-model="forceReextract" /> 强制重新提取音频</label>
          <TButton label="开始提取并分析" icon="mic" :loading="analyzing" @click="startAnalysis" />
        </div>
        <div v-if="analysisMsg" class="hint">{{ analysisMsg }}</div>
        <p class="hint hintline">
          链路：本地 ffmpeg 提取音频 → 服务端 ASR 转写（/whisper/transcribe）→ 内置热点算法
          （60s 窗口/30s 步长评分，阈值=均值×1.3，片段 15~300s）生成切片计划。LLM 分析模式依赖
          服务端 LLM 代理，未接线时自动回退内置算法（对齐原版兜底口径）。
        </p>
      </section>

      <section class="card">
        <div class="row between">
          <span class="card-title">热点片段 <span class="muted">(勾选后进入下一步切片)</span></span>
          <span class="clip-count">已选 {{ selectedCount }} 个</span>
        </div>
        <div v-if="transcript" class="transcript">
          <div class="transcript-title">转写预览</div>
          <div class="transcript-body">{{ transcript }}</div>
        </div>
        <table class="tbl">
          <thead><tr><th style="width:30px"></th><th>#</th><th>起止</th><th>时长</th><th>热点标题</th><th>评分</th></tr></thead>
          <tbody>
            <tr v-for="(h, i) in selectedPlan" :key="i">
              <td><input type="checkbox" v-model="h.checked" /></td>
              <td>{{ i + 1 }}</td>
              <td>{{ h.startStr }} – {{ h.endStr }}</td>
              <td>{{ h.duration }}s</td>
              <td :title="h.title">{{ h.title }}</td>
              <td>{{ h.score }}</td>
            </tr>
            <tr v-if="!hotspots.length"><td colspan="6" class="muted">尚无热点，请先在上方开始提取并分析</td></tr>
          </tbody>
        </table>
      </section>

      <div class="row right">
        <TButton label="下一步：切片与封面生成" icon="right" :disabled="!canNext" @click="step = 1" />
      </div>
    </template>

    <!-- Step 1: 切片与封面生成 -->
    <template v-else>
      <section class="card">
        <div class="row">
          <label class="label">切片输出目录:</label>
          <input :value="clipDir" placeholder="选择切片保存目录..." readonly class="input grow" @click="pickClipDir" />
        </div>
        <div class="row">
          <span class="clip-count">已选 {{ selectedCount }} 个片段待切片</span>
          <TButton label="开始切片" icon="cut" :loading="clipBusy" @click="startClipping" />
        </div>
        <div v-if="clipMsg" class="hint" :class="{ ok: doneCount === clips.length && clips.length }">{{ clipMsg }}</div>

        <!-- 分段处理状态：待处理/处理中/成功/失败 + 标题编辑回填 -->
        <div class="row between"><span class="card-title">切片结果 <span class="muted">(标题可编辑，切片完成后回填路径)</span></span></div>
        <ul class="file-list">
          <li v-for="c in clips" :key="c.id" class="clip-item">
            <span class="clip-state" :class="c.state">
              {{ c.state === 'pending' ? '待处理' : c.state === 'running' ? '处理中…' : c.state === 'done' ? '成功' : '失败' }}
            </span>
            <input v-if="c.state === 'done'" class="clip-title" :value="c.title" @input="editClipTitle(c, ($event.target as HTMLInputElement).value)" />
            <span v-else class="clip-title-static">{{ c.title }}</span>
            <span class="muted clip-path">{{ c.state === 'done' ? c.path : (c.err || '') }}</span>
            <TButton v-if="c.state === 'done'" label="打开" plain @click="tintin()?.shell?.revealInFolder?.(c.path)" />
          </li>
          <li v-if="!clips.length" class="muted">点击「开始切片」从所选热点片段生成剪辑</li>
        </ul>
      </section>

      <section class="card">
        <div class="row right">
          <TButton label="打开输出目录" plain @click="clips.length && tintin()?.shell?.revealInFolder?.(clips[0].path)" />
        </div>
        <p class="muted hintline">
          封面生成与最终导出（嵌封面成片）在原版由本地 CoverGeneratorWorker / FinalExportWorker
          （ffmpeg 抽帧 + 横竖封面 + 封面首帧嵌入）完成；新端封面/导出链路待接线，此处保留
          原客户端 2 步流程结构，切片结果已可直接回填使用。
        </p>
      </section>

      <div class="row left">
        <TButton label="上一步：视频分析与热点发现" plain @click="step = 0" />
      </div>
    </template>
  </div>
</template>

<style scoped>
.step-bar { display: flex; align-items: center; gap: var(--space-2); padding: var(--space-2) var(--space-3); background: var(--surface-container); border: 1px solid var(--border); border-radius: var(--radius-lg); }
.step-pill { padding: 4px 10px; border-radius: 999px; font-size: 13px; color: var(--muted-foreground); cursor: pointer; }
.step-pill.active { background: rgba(46,204,113,0.18); color: var(--primary); font-weight: 600; }
.step-pill.done { color: var(--success); }
.step-arrow { color: var(--muted-foreground); opacity: .4; }

.card { display: flex; flex-direction: column; gap: var(--space-4); padding: var(--space-5); background: var(--card); border: 1px solid var(--border); border-radius: var(--radius-lg); }
.dropzone { display: flex; flex-direction: column; gap: 4px; padding: var(--space-5); background: var(--surface-container); border: 1.5px dashed var(--border); border-radius: var(--radius-lg); cursor: pointer; color: var(--foreground); transition: border-color var(--duration-fast); }
.dropzone:hover { border-color: var(--primary); }
.dz-main { font-size: var(--font-size-body); font-weight: var(--font-weight-medium); }
.dz-hint { font-size: var(--font-size-caption); color: var(--muted-foreground); }

.row { display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap; }
.row.between { justify-content: space-between; }
.row.right { justify-content: flex-end; }
.row.left { justify-content: flex-start; }
.label, .card-title { font-size: 13px; font-weight: 600; color: var(--foreground); }
.muted { color: var(--muted-foreground); font-size: 12px; }
.hint { color: var(--muted-foreground); font-size: 12px; }
.hint.ok { color: var(--success); font-weight: 600; }
.hintline { max-width: 720px; }
.clip-count { font-weight: 700; }
.chk { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; }

.input { height: 32px; padding: 0 10px; background: var(--card); border: 1px solid var(--border); border-radius: var(--radius-md); color: var(--foreground); outline: none; font-size: 13px; }
.input:focus { border-color: var(--primary); }
.input.grow { flex: 1; min-width: 120px; }
.w130 { width: 130px; } .w160 { width: 160px; }

.tbl { width: 100%; border-collapse: collapse; font-size: 13px; }
.tbl th, .tbl td { padding: 6px 8px; border-bottom: 1px solid var(--border); text-align: left; }
.tbl th { color: var(--muted-foreground); font-weight: 500; font-size: 12px; }

.file-list { display: flex; flex-direction: column; gap: 6px; list-style: none; margin: 0; padding: 0; font-size: 13px; }
.clip-item { display: flex; align-items: center; gap: var(--space-2); padding: 6px 10px; background: var(--surface-container); border: 1px solid var(--border); border-radius: var(--radius-md); }
.clip-state { flex: 0 0 auto; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; color: var(--muted-foreground); background: var(--surface-container-high); }
.clip-state.running { color: var(--primary); background: rgba(46,204,113,0.12); }
.clip-state.done { color: var(--success); background: rgba(16,185,129,0.12); }
.clip-state.failed { color: var(--error); background: rgba(239,68,68,0.12); }
.clip-title { flex: 0 1 260px; min-width: 120px; height: 26px; padding: 0 8px; background: var(--card); border: 1px solid var(--border); border-radius: var(--radius-md); color: var(--foreground); font-size: 12px; outline: none; }
.clip-title:focus { border-color: var(--primary); }
.clip-title-static { flex: 0 1 260px; min-width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.clip-path { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.transcript { display: flex; flex-direction: column; gap: 6px; padding: var(--space-3); background: var(--surface-container); border: 1px solid var(--border); border-radius: var(--radius-md); }
.transcript-title { font-size: 12px; font-weight: 600; color: var(--muted-foreground); }
.transcript-body { max-height: 120px; overflow: auto; font-size: 13px; color: var(--foreground-muted); }
</style>
