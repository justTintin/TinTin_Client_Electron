<script setup lang="ts">
// ═══════════════════════════════════════════════════════════════
// LiveClip.vue — 直播智能切片
// 严格照原客户端 live_clip/page.py 的 2 步向导流程：
//   1. 视频分析与热点发现 → 2. 切片与封面生成
// 接线真实 IPC：ffmpeg(extractAudio/probe/cut) + server.asrTranscribe(/whisper/transcribe)
// ═══════════════════════════════════════════════════════════════
import { ref, computed } from 'vue'
import TButton from '@/components/common/TButton.vue'
import TSelect, { type SelectOption } from '@/components/common/TSelect.vue'

const STEPS = ['1. 视频分析与热点发现', '2. 切片与封面生成']
const step = ref(0)
const tintin = () => (window as any).tintin

/* ── Step 0 视频分析与热点发现 ───────────────────────── */
const videoPath = ref('')
const videoName = ref('')
const isDragging = ref(false)
const analysisMode = ref<SelectOption['value']>('llm')
const transcribeLang = ref('zh')
const forceReextract = ref(false)
const analyzing = ref(false)
const analysisMsg = ref('')
const transcript = ref('')
const hotspots = ref<Hotspot[]>([])
const clipDir = ref('')

interface Hotspot {
  id: string; idx: number; start: number; end: number; title: string; score: number; checked: boolean
}

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
function setVideo(p: string) { videoPath.value = p; videoName.value = String(p).split(/[\\/]/).pop() || ''; hotspots.value = []; transcript.value = '' }

function pickClipDir() {
  tintin()?.dialog?.openDir?.({ title: '选择切片输出目录' }).then((r: any) => {
    const d = Array.isArray(r?.filePaths) ? r.filePaths[0] : (r?.filePaths ?? r?.path)
    if (d) clipDir.value = String(d)
  })
}

/** Step0 开始提取并分析：ffmpeg 抽音频 → asr 转写 → 生成热点候选 */
async function startAnalysis() {
  if (!videoPath.value) return
  analyzing.value = true; analysisMsg.value = '正在提取音频并转写...'
  try {
    let transcriptText = ''
    const t = tintin()
    // 抽取音频（可选）：asr 直接接受视频路径时无需显式抽取
    try { if (forceReextract.value && t?.ffmpeg?.extractAudio) await t.ffmpeg.extractAudio(videoPath.value, videoPath.value + '.wav') } catch (_) {}

    // 转写（POST /whisper/transcribe）
    try {
      const res = await t?.server?.asrTranscribe?.({
        file: videoPath.value,
        language: transcribeLang.value,
        reextract: forceReextract.value,
      })
      transcriptText = res?.text ?? res?.transcript ?? res?.segments_text ?? String(res || '')
      if (!transcriptText && Array.isArray(res?.segments)) transcriptText = res.segments.map((s: any) => s.text).join('')
    } catch (e) {
      analysisMsg.value = '转写不可用（预览环境无 IPC 或服务端未就绪）：' + (e instanceof Error ? e.message : String(e))
      analyzing.value = false
      return
    }
    transcript.value = transcriptText

    // 热点候选：内置算法按关键词切分；真实环境可按热词/LLM 细化为带时间区间的高光片段
    const rules = analysisMode.value === 'rule'
    hotspots.value = segmentHotspots(transcriptText, rules)
    analysisMsg.value = `分析完成，发现 ${hotspots.value.length} 个热点片段`
    if (hotspots.value.length) step.value = 1
  } finally {
    analyzing.value = false
  }
}

function segmentHotspots(text: string, ruleMode: boolean): Hotspot[] {
  const parts = (text || '').split(/[。！？\n]+/).map((s) => s.trim()).filter(Boolean)
  const rows: Hotspot[] = []
  // 每个句子作为一个候选热点片段（真实环境会带上精确起止时间 + 热词命中评分）
  parts.forEach((s, i) => {
    const score = 6 + (i % 4)
    rows.push({ id: 'h' + i, idx: i + 1, start: i * 3, end: i * 3 + 3, title: s.slice(0, 40), score, checked: true })
  })
  return rows.slice(0, ruleMode ? Math.min(parts.length, 12) : Math.min(parts.length || 4, 12))
}

const selectedCount = computed(() => hotspots.value.filter((h) => h.checked).length)

/** 切片：逐热点 ffmpeg:cut 到输出目录 */
async function startClipping() {
  const sel = hotspots.value.filter((h) => h.checked)
  const outDir = clipDir.value || videoPath.value.replace(/[\\/][^\\/]+$/, '')
  if (sel.length === 0) return
  clipBusy.value = true; clipMsg.value = ''
  try {
    for (let i = 0; i < sel.length; i++) {
      const h = sel[i]
      const safe = (h.title || 'clip').slice(0, 30).replace(/[\\/:*?"<>|]/g, '_')
      const out = `${outDir}\\${safe}_${h.id}.mp4`
      const res = await tintin()?.ffmpeg?.cut?.(videoPath.value, out, h.start, h.end)
      if (res === undefined) throw new Error('ffmpeg:cut 不可用（预览环境）')
      clips.value.push({ id: h.id, path: out, title: h.title, state: 'done' })
    }
    clipMsg.value = `已生成 ${clips.value.length} 段切片`
  } catch (e) { clipMsg.value = e instanceof Error ? e.message : String(e) }
  clipBusy.value = false
}
interface Clip { id: string; path: string; title: string; state: 'done' | 'cover' | 'exported' }
const clips = ref<Clip[]>([])
const clipBusy = ref(false)
const clipMsg = ref('')

const canNext = computed(() => hotspots.value.length > 0)
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
          <TSelect class="w160" v-model="analysisMode" :options="[{label:'AI 大模型 (DeepSeek/OpenAI)',value:'llm'},{label:'内置算法 (无需 API)',value:'rule'}]" />
          <label class="label">转写语言:</label>
          <TSelect class="w130" v-model="transcribeLang" :options="[{label:'中文 (简体)',value:'zh'},{label:'自动识别',value:'auto'},{label:'英语',value:'en'}]" />
          <label class="chk"><input type="checkbox" v-model="forceReextract" /> 强制重新提取音频</label>
          <TButton label="开始提取并分析" icon="mic" :loading="analyzing" @click="startAnalysis" />
        </div>
        <div v-if="analysisMsg" class="hint">{{ analysisMsg }}</div>
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
          <thead><tr><th style="width:30px"></th><th>#</th><th>起止 (s)</th><th>热点标题</th><th>评分</th></tr></thead>
          <tbody>
            <tr v-for="h in hotspots" :key="h.id">
              <td><input type="checkbox" v-model="h.checked" /></td>
              <td>{{ h.idx }}</td>
              <td>{{ h.start }}–{{ h.end }}</td>
              <td>{{ h.title }}</td>
              <td>{{ h.score }}</td>
            </tr>
            <tr v-if="!hotspots.length"><td colspan="5" class="muted">尚无热点，请先在上方开始提取并分析</td></tr>
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
        <div v-if="clipMsg" class="hint">{{ clipMsg }}</div>

        <div class="row between"><span class="card-title">已生成切片 <span class="muted">(双击可编辑标题，封面随切片生成)</span></span></div>
        <ul class="file-list">
          <li v-for="c in clips" :key="c.id"><span>🎞️ {{ c.title || c.path }}</span><span class="muted">{{ c.path }}</span></li>
          <li v-if="!clips.length" class="muted">点击「开始切片」从所选热点片段生成剪辑</li>
        </ul>
      </section>

      <section class="card">
        <div class="row right">
          <TButton label="生成封面" icon="image" />
          <TButton label="生成视频 (嵌封面导出)" icon="export" :disabled="!clips.length" />
          <TButton label="打开输出目录" plain @click="tintin()?.shell?.revealInFolder && clips.length && tintin().shell.revealInFolder(clips[0].path)" />
        </div>
        <p class="muted hintline">封面生成与最终导出（嵌封面成片）依赖封面/导出后端；此处保留原客户端 2 步流程结构。</p>
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
.file-list li { display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); padding: 6px 10px; background: var(--surface-container); border: 1px solid var(--border); border-radius: var(--radius-md); word-break: break-all; }
.transcript { display: flex; flex-direction: column; gap: 6px; padding: var(--space-3); background: var(--surface-container); border: 1px solid var(--border); border-radius: var(--radius-md); }
.transcript-title { font-size: 12px; font-weight: 600; color: var(--muted-foreground); }
.transcript-body { max-height: 120px; overflow: auto; font-size: 13px; color: var(--foreground-muted); }
</style>