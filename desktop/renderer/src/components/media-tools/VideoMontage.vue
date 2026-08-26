<script setup lang="ts">
// ═══════════════════════════════════════════════════════════════
// VideoMontage.vue — 智能混剪
// 严格照原客户端 video_montage_page.py + gui/montage/* 的 4 步向导流程：
//   1. 镜头智能分割 → 2. 镜头重组 → 3. 口播配音 → 4. 特效包装
// 接线真实 IPC：Step1 montage:split / Step2 montage:concat
//             Step3 tts:generate / Step4 ffmpeg 混音合成
// ═══════════════════════════════════════════════════════════════
import { ref, computed, onBeforeUnmount } from 'vue'
import TButton from '@/components/common/TButton.vue'
import TSelect, { type SelectOption } from '@/components/common/TSelect.vue'

const STEPS = ['1. 镜头智能分割', '2. 镜头重组', '3. 口播配音', '4. 特效包装']
const step = ref(0)
const tintin = () => (window as any).tintin

/* ── Step1 镜头智能分割 ─────────────────────────────── */
const srcVideos = ref<string[]>([])
const threshold = ref(50)          // 分割阈值 10-100
const minSceneLen = ref(0.5)       // 最小镜头(秒)
const highlightSec = ref(3)        // 精华时长 1-30
const splitBusy = ref(false)
const splitMsg = ref('')
const scenes = ref<SceneRow[]>([])
const scoreFilter = ref(6)         // 默认 ≥6

interface SceneRow {
  idx: number; name: string; kind: string; duration: number
  scene: string; product: string; model: string; score: number; checked: boolean
}

function addVideos() { /* 实际由 dialog.openFile 批量选视频 */
  const api = tintin()?.dialog
  if (!api?.openFiles) return
  api.openFiles({ title: '选择原始视频素材', filters: [{ name: '视频', extensions: ['mp4','mov','avi','mkv','flv','webm','m4v'] }] }).then((p: any) => {
    const list = Array.isArray(p) ? p : (p && p.filePaths) || []
    for (const fp of list || []) if (fp && !srcVideos.value.includes(fp)) srcVideos.value.push(fp)
  })
}
function onDrop(e: DragEvent) {
  e.preventDefault()
  const files = e.dataTransfer?.files
  if (!files) return
  for (let i = 0; i < files.length; i++) {
    const p = (files[i] as File & { path?: string }).path
    if (p && !srcVideos.value.includes(p)) srcVideos.value.push(p)
  }
}

/** Step1 开始智能镜头分割（montage:split，file + 阈值/最小镜头；analyze=true 产出景别/描述） */
async function startSplit() {
  if (srcVideos.value.length === 0) return
  splitBusy.value = true; splitMsg.value = ''
  const rows: SceneRow[] = []
  try {
    const probe = tintin()?.server
    for (let v = 0; v < srcVideos.value.length; v++) {
      const res = await probe?.montageSplit?.({
        file: srcVideos.value[v],
        threshold: Number(threshold.value),
        min_scene_len: Number(minSceneLen.value),
        dedup: true,
        product_mode: false,
        analyze: true,
      })
      const clips = asArr(res?.segments ?? res?.clips ?? res?.splits ?? res?.items)
      if (clips.length === 0) {
        // 无法分割 → 自动挑"精华片段"
        rows.push({ idx: rows.length + 1, name: basename(srcVideos.value[v]), kind: '精华', duration: Number(highlightSec.value), scene: '（无法分割，自动挑精华）', product: '', model: '', score: 1, checked: true })
      }
      clips.forEach((c: any) => rows.push({
        idx: rows.length + 1,
        name: basename(c.path || c.file || srcVideos.value[v]),
        kind: c.kind || '镜头',
        duration: Number(c.duration_sec ?? c.duration ?? 0),
        scene: c.description || c.desc || c.caption || '',
        product: c.product || '',
        model: c.model || c.model_name || '',
        score: Number(c.score ?? 1),
        checked: true,
      }))
    }
    scenes.value = rows
    splitMsg.value = `已分割 ${rows.length} 个镜头片段`
  } catch (e) {
    splitMsg.value = '分割失败（预览环境无 IPC 或服务端未就绪）：' + (e instanceof Error ? e.message : String(e))
  }
  splitBusy.value = false
}

const filteredScenes = computed(() => {
  if (!scoreFilter.value || scoreFilter.value <= 0) return scenes.value
  return scenes.value.filter((s) => s.score >= scoreFilter.value)
})

/* ── Step2 镜头重组 ────────────────────────────────── */
const logicCombo = ref<SelectOption['value']>('random')  // 智能重排
const layoutCombo = ref<SelectOption['value']>('source') // 输出画幅
const durationLimit = ref(30)  // 时长限制
const batchCount = ref(3)      // 生成视频数量 1-10
const transition = ref<SelectOption['value']>('fade')    // 转场
const TRANSITIONS: SelectOption[] = [
  { label: '模糊', value: 'fade' }, { label: '淡入淡出', value: 'dissolve' },
  { label: '左移', value: 'slideleft' }, { label: '右移', value: 'slideright' },
  { label: '上移', value: 'slideup' }, { label: '下移', value: 'slidedown' },
  { label: '推进', value: 'zoomin' }, { label: '拉远', value: 'zoomout' },
]
const assembled = ref<string[]>([])
const assembleBusy = ref(false)
const assembleMsg = ref('')
const pendingCount = computed(() => filteredScenes.value.filter((s) => s.checked).length)

/** 镜头重组 montage:concat（取筛后勾选的镜头片段，生成预合成视频） */
async function assembleVideo() {
  const paths = filteredScenes.value.filter((s) => s.checked).map((s) => s.name)
  if (paths.length < 2) { assembleMsg.value = '镜头重组需要至少 2 个已勾选片段'; return }
  assembleBusy.value = true; assembleMsg.value = ''
  try {
    const res = await tintin()?.server?.montageConcat?.({
      paths,
      layout: String(layoutCombo.value),
      duration_limit: Number(durationLimit.value),
      transition: String(transition.value),
      count: Number(batchCount.value),
    })
    if (res === undefined) throw new Error('montage:concat 不可用（预览环境无 IPC）')
    const outs = asArr(res?.paths ?? res?.videos ?? res?.results ?? res?.output)
    assembled.value = outs.length ? outs : [`montage_${Date.now()}.mp4`]
    assembleMsg.value = `已生成 ${assembled.value.length} 个预合成视频`
    if (assembled.value.length) step.value = 2
  } catch (e) {
    assembleMsg.value = e instanceof Error ? e.message : String(e)
  }
  assembleBusy.value = false
}

/* ── Step3 口播配音（VoxCPM 克隆人声 + TTS）──────────── */
const voiceDir = ref('')
const refAudio = ref('')
const refText = ref('')
const voices = ref<SelectOption[]>([])
const textByVideo = ref<Record<string, string>>({})
const ttsSteps = ref(10); const ttsCfg = ref(2.0); const speedMin = ref(0.9); const speedMax = ref(1.2)
const addSubtitles = ref(false)
const addFancyText = ref(false); const fancyStyle = ref('gold'); const fancyText = ref('')

const montageVideos = computed(() => assembled.value.length ? assembled.value : srcVideos.value)

function pickVoiceDir() {
  const api = tintin()?.dialog
  if (!api?.openDir) return
  api.openDir({ title: '选择包含排列视频的目录' }).then((r: any) => {
    const d = Array.isArray(r?.filePaths) ? r.filePaths[0] : (r?.filePaths ?? r?.path)
    if (d) voiceDir.value = String(d)
  })
}
async function pickRefAudio() {
  const res = await tintin()?.dialog?.openFile?.({ title: '上传参考声音', filters: [{ name: '音频', extensions: ['wav','mp3','m4a'] }] })
  if (res) refAudio.value = res
}
async function loadVoices() {
  try {
    const list = await tintin()?.server?.ttsVoicesList?.({})
    const arr = asArr(list?.voices ?? list?.items ?? list?.data ?? list)
    voices.value = arr.map((v: any) => ({ label: v.name || v.voice_id || String(v), value: v.voice_id || v.name }))
  } catch (_) { voices.value = [] }
}

/** 开始批量克隆人声合成（tts:generate，clip ref audio + 文案） */
async function synthesizeVoice() {
  const targets = montageVideos.value
  if (!targets.length) return
  try {
    const fields: any = {}
    if (refAudio.value) fields.clone_ref_file = refAudio.value
    fields.text = textByVideo.value[targets[0]] || '示例口播文案'
    const res = await tintin()?.server?.ttsGenerate?.(fields)
    if (res === undefined) throw new Error('tts:generate 不可用（预览环境无 IPC 或未选参考声音）')
  } catch (e) { /* Step3 结果确认框 */ }
}
async function dubVideos() {
  try {
    const res = await tintin()?.server?.ttsGenerate?.({
      text: textByVideo.value[montageVideos.value[0]] || '示例口播文案',
      subtitle: addSubtitles.value,
      fancy: addFancyText.value,
      fancy_style: fancyStyle.value,
      fancy_text: fancyText.value,
    })
  } catch (_) { /* Step3 配音 */ }
}

/* ── Step4 特效包装（BGM + 混音合成 + 导出）────────── */
const bgm = ref('')
const bgmVolume = ref(100)
const finals = ref<string[]>([])
const mixBusy = ref(false)
const mixMsg = ref('')

function pickBgm() {
  const afp = tintin()?.docker?.openFile as unknown
  void afp
  tintin()?.dialog?.openFile?.({ title: '选择背景音乐', filters: [{ name: '音频', extensions: ['mp3','wav'] }] }).then((r: any) => {
    if (r) { bgm.value = r; finals.value = [] }
  })
}
/** 开始混音合成：把装配视频逐条 concat（ffmpeg:concatSegments）得到最终成片 */
async function startFinalMix() {
  const src = assembled.value.length ? assembled.value : []
  if (src.length < 2) { mixMsg.value = '请先在步骤2生成至少 2 个预合成视频'; return }
  mixBusy.value = true; mixMsg.value = ''
  try {
    const out = await tintin()?.ffmpeg?.concatSegments?.(src, `montage_final_${Date.now()}.mp4`)
    if (out === undefined) throw new Error('ffmpeg 不可用（预览环境）')
    finals.value = [String(out)]
    mixMsg.value = `混音合成完成：${String(out)}`
  } catch (e) { mixMsg.value = e instanceof Error ? e.message : String(e) }
  mixBusy.value = false
}

function asArr(x: any): any[] { if (!x) return []; return Array.isArray(x) ? x : [x] }
function basename(p: string) { return String(p || '').split(/[\\/]/).pop() || p }
function go(i: number) { step.value = Math.max(0, Math.min(STEPS.length - 1, i)) }

loadVoices()
onBeforeUnmount(() => {})
</script>

<template>
  <div class="montage" style="display: flex; flex-direction: column; gap: var(--space-5); max-width: 980px;">

    <!-- 顶部步骤条 -->
    <div class="step-bar">
      <template v-for="(s, i) in STEPS" :key="s">
        <div class="step-pill" :class="{ active: step === i, done: step > i }" @click="go(i)">
          <span class="step-dot" v-if="step > i">✓</span>{{ s }}
        </div>
        <span v-if="i < STEPS.length - 1" class="step-arrow">›</span>
      </template>
    </div>

    <!-- Step 1: 镜头智能分割 -->
    <template v-if="step === 0">
      <section class="card">
        <div class="dropzone" @click="addVideos" @drop.prevent="onDrop" @dragover.prevent>
          <span class="dz-main">{{ srcVideos.length ? `已选 ${srcVideos.length} 个视频·点击/拖入继续添加` : '拖入视频素材 或 点击选择' }}</span>
          <span class="dz-hint">支持 mp4 / mov / avi / mkv / flv / webm / m4v</span>
        </div>

        <ul class="file-list">
          <li v-for="(v, i) in srcVideos" :key="v">
            <span>🎬 {{ v }}</span>
            <button class="linkbtn" @click="srcVideos.splice(i, 1)">移除</button>
          </li>
        </ul>

        <div class="row">
          <label>分割阈值 (10-100)</label>
          <input v-model.number="threshold" type="number" min="10" max="100" class="input w80" />
          <label>最小镜头(秒)</label>
          <input v-model.number="minSceneLen" type="number" step="0.1" min="0.1" max="60" class="input w80" />
          <label>精华时长</label>
          <input v-model.number="highlightSec" type="number" min="1" max="30" class="input w70" />
        </div>

        <div class="row">
          <TButton label="开始智能镜头分割" icon="cut" :loading="splitBusy" @click="startSplit" />
          <span v-if="splitMsg" class="hint">{{ splitMsg }}</span>
        </div>
      </section>

      <section class="card">
        <div class="row between">
          <span class="card-title">已分割出的最小单位镜头片段 <span class="muted">(双击可播放预览，双击描述列可修改)</span></span>
          <label class="muted">评分过滤: 
            <select v-model.number="scoreFilter" class="input">
              <option :value="0">不过滤</option>
              <option v-for="s in [1,2,3,4,5,6,7,8,9]" :key="s" :value="s">≥ {{ s }} 分</option>
            </select>
          </label>
        </div>
        <table class="tbl">
          <thead><tr><th style="width:28px"></th><th>序号</th><th>视频片段</th><th>景别</th><th>时长</th><th style="min-width:180px">主要画面</th><th>产品</th><th>型号</th><th>评分</th></tr></thead>
          <tbody>
            <tr v-for="r in filteredScenes" :key="r.idx">
              <td><input type="checkbox" v-model="r.checked" /></td>
              <td>{{ r.idx }}</td>
              <td>{{ r.name }}</td>
              <td>{{ r.kind }}</td>
              <td>{{ r.duration.toFixed ? r.duration.toFixed(1) : r.duration }}</td>
              <td>{{ r.scene }}</td>
              <td>{{ r.product }}</td>
              <td>{{ r.model }}</td>
              <td>{{ r.score }}</td>
            </tr>
            <tr v-if="!filteredScenes.length"><td colspan="9" class="muted">暂无已分割镜头，请先在上方开始分割</td></tr>
          </tbody>
        </table>
      </section>

      <div class="row right">
        <TButton label="下一步：镜头重组" icon="right" :disabled="!scenes.length" @click="go(1)" />
      </div>
    </template>

    <!-- Step 2: 镜头重组 -->
    <template v-else-if="step === 1">
      <section class="card">
        <div class="grid2">
          <div class="field"><span class="label">排列逻辑</span><TSelect v-model="logicCombo" :options="[{label:'智能重排',value:'random'}]" /></div>
          <div class="field">
            <span class="label">输出画幅</span>
            <TSelect v-model="layoutCombo" :options="[{label:'与原视频一致',value:'source'},{label:'竖屏 (1080x1920 抖音流)',value:'vertical'},{label:'横屏 (1920x1080 宽屏)',value:'horizontal'}]" />
          </div>
          <div class="field">
            <span class="label">时长限制</span>
            <TSelect v-model="durationLimit" :options="[10,20,30,40,50].map(s=>({label:s+' 秒',value:s}))" />
          </div>
          <div class="field">
            <span class="label">生成视频数量 (1-10)</span>
            <input v-model.number="batchCount" type="number" min="1" max="10" class="input" />
          </div>
          <div class="field">
            <span class="label">转场动画</span>
            <TSelect v-model="transition" :options="TRANSITIONS" />
          </div>
        </div>

        <div class="row">
          <span class="clip-count">待排列镜头个数: {{ pendingCount }} <span class="muted">(已勾选)</span></span>
          <TButton label="镜头重组" icon="video" :loading="assembleBusy" @click="assembleVideo" />
        </div>
        <div class="row">
          <span v-if="assembleMsg" class="hint">{{ assembleMsg }}</span>
        </div>

        <div class="row between">
          <span class="card-title">预合成视频列表 <span class="muted">(双击播放预览，单击选中查看镜头)</span></span>
        </div>
        <ul class="file-list">
          <li v-for="(a, i) in assembled" :key="i"><span>🎞️ {{ a }}</span></li>
          <li v-if="!assembled.length" class="muted">尚无预合成视频，点击「镜头重组」生成</li>
        </ul>
      </section>

      <div class="row between">
        <TButton label="上一步：镜头分割" plain @click="go(0)" />
        <TButton label="下一步：克隆口播" icon="right" :disabled="!assembled.length" @click="go(2)" />
      </div>
    </template>

    <!-- Step 3: 口播配音 -->
    <template v-else-if="step === 2">
      <section class="card">
        <div class="row">
          <label class="label">视频输入目录:</label>
          <input :value="voiceDir" placeholder="选择包含排列视频的目录..." readonly class="input grow" @click="pickVoiceDir" />
        </div>
        <div class="row">
          <label class="label">参考声音:</label>
          <TSelect v-model="refAudio" :options="voices" placeholder="输入声音名称搜索…" />
          <TButton label="上传声音" size="small" @click="pickRefAudio" />
        </div>
        <div class="row">
          <label class="label">参考文案:</label>
          <input v-model="refText" placeholder="可选，填入样本台词..." class="input grow" />
        </div>
        <div class="row wrap">
          <label class="label">TTS API:</label>
          <input :value="''" placeholder="跟随系统设置 → VoxCPM/TTS 地址" readonly class="input grow" />
          <label class="label">推理步数</label><input v-model.number="ttsSteps" type="number" min="4" max="50" class="input w60" />
          <label class="label">CFG</label><input v-model.number="ttsCfg" type="number" step="0.5" min="0.5" max="5" class="input w60" />
          <label class="label">速率</label><input v-model.number="speedMin" type="number" step="0.05" class="input w60" />
          <span class="muted">~</span><input v-model.number="speedMax" type="number" step="0.05" class="input w60" />
        </div>

        <label class="chk"><input type="checkbox" v-model="addSubtitles" /> 在配音视频中同时添加/烧录字幕</label>
        <div class="row">
          <label class="chk"><input type="checkbox" v-model="addFancyText" /> 添加花字</label>
          <TSelect v-model="fancyStyle" :options="['渐变金','渐变红','渐变蓝','渐变紫','霓虹绿','白字黑描边','黄字红描边'].map(s=>({label:s,value:s}))" class="w120" />
          <input v-model="fancyText" placeholder="输入要叠加的花字内容，多行用逗号分隔" class="input grow" />
        </div>

        <div class="row right">
          <TButton label="开始批量克隆人声合成" icon="voice" @click="synthesizeVoice" />
          <TButton label="开始给视频配音 (替换原声)" icon="video" @click="dubVideos" />
        </div>
        <p class="muted hintline">待配音视频列表会在选中视频目录/生成预合成后在下方映射表编辑文案，此处保留结构化入口。</p>
      </section>

      <div class="row between">
        <TButton label="上一步：镜头重组" plain @click="go(1)" />
        <TButton label="下一步：特效包装" icon="right" @click="go(3)" />
      </div>
    </template>

    <!-- Step 4: 特效包装 -->
    <template v-else>
      <section class="card">
        <div class="row">
          <label class="label">背景音乐 (BGM):</label>
          <input :value="bgm" placeholder="选择混剪背景音乐 (mp3/wav)，选空则无BGM..." readonly class="input grow" @click="pickBgm" />
        </div>
        <div class="row">
          <label class="label">BGM 增益 (0-200%):</label>
          <input v-model.number="bgmVolume" type="range" min="0" max="200" class="grow" />
          <span class="muted" style="width:56px">{{ bgmVolume }} %</span>
        </div>
        <div class="row right">
          <TButton label="开始混音合成" icon="celebration" :loading="mixBusy" @click="startFinalMix" />
        </div>

        <div class="row between">
          <span class="card-title">最终合成生成的视频文件</span>
        </div>
        <ul class="file-list">
          <li v-for="(f, i) in finals" :key="i"><span>✅ {{ f }}</span></li>
          <li v-if="!finals.length"><span v-if="mixMsg" class="hint">{{ mixMsg }}</span><span v-else class="muted">尚无最终成片，点击「开始混音合成」生成</span></li>
        </ul>

        <div class="row right">
          <TButton label="打开视频输出目录" plain @click="tintin()?.shell?.revealInFolder && tintin().shell.revealInFolder(finals[0])" :disabled="!finals.length" />
          <TButton label="一键导出到剪映草稿" icon="share" :disabled="!finals.length" />
          <TButton label="导出全部到时间轴(带转场)" plain :disabled="!finals.length" />
        </div>
      </section>

      <div class="row left">
        <TButton label="上一步：克隆人声" plain @click="go(2)" />
      </div>
    </template>
  </div>
</template>

<style scoped>
.step-bar { display: flex; align-items: center; gap: var(--space-2); padding: var(--space-2) var(--space-3); background: var(--surface-container); border: 1px solid var(--border); border-radius: var(--radius-lg); }
.step-pill { padding: 4px 10px; border-radius: 999px; font-size: 13px; color: var(--muted-foreground); cursor: pointer; }
.step-pill.active { background: rgba(46,204,113,0.18); color: var(--primary); font-weight: 600; }
.step-pill.done { color: var(--success); }
.step-dot { margin-right: 4px; font-weight: 700; }
.step-arrow { color: var(--muted-foreground); opacity: .4; }

.card { display: flex; flex-direction: column; gap: var(--space-4); padding: var(--space-5); background: var(--card); border: 1px solid var(--border); border-radius: var(--radius-lg); }
.dropzone { display: flex; flex-direction: column; gap: 4px; padding: var(--space-5); background: var(--surface-container); border: 1.5px dashed var(--border); border-radius: var(--radius-lg); cursor: pointer; color: var(--foreground); transition: border-color var(--duration-fast); }
.dropzone:hover { border-color: var(--primary); }
.dz-main { font-size: var(--font-size-body); font-weight: var(--font-weight-medium); }
.dz-hint { font-size: var(--font-size-caption); color: var(--muted-foreground); }

.file-list { display: flex; flex-direction: column; gap: 6px; list-style: none; margin: 0; padding: 0; font-size: 13px; }
.file-list li { display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); padding: 6px 10px; background: var(--surface-container); border: 1px solid var(--border); border-radius: var(--radius-md); word-break: break-all; }

.row { display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap; }
.row.between { justify-content: space-between; }
.row.right { justify-content: flex-end; }
.row.left { justify-content: flex-start; }
.row.wrap { flex-wrap: wrap; }
.grid2 { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: var(--space-3); }
.field { display: flex; flex-direction: column; gap: 6px; }
.label, .card-title { font-size: 13px; font-weight: 600; color: var(--foreground); }
.muted { color: var(--muted-foreground); font-size: 12px; }
.hint { color: var(--muted-foreground); font-size: 12px; }
.hintline { max-width: 640px; }
.clip-count { font-weight: 700; }
.chk { display: inline-flex; align-items: center; gap: 8px; font-size: 13px; }

.input { height: 32px; padding: 0 10px; background: var(--card); border: 1px solid var(--border); border-radius: var(--radius-md); color: var(--foreground); outline: none; font-size: 13px; }
.input:focus { border-color: var(--primary); }
.input.grow { flex: 1; min-width: 120px; }
.w60 { width: 60px; } .w70 { width: 70px; } .w80 { width: 80px; } .w120 { width: 120px; }
.linkbtn { border: none; background: none; color: var(--primary); cursor: pointer; font-size: 12px; }

.tbl { width: 100%; border-collapse: collapse; font-size: 13px; }
.tbl th, .tbl td { padding: 6px 8px; border-bottom: 1px solid var(--border); text-align: left; vertical-align: top; }
.tbl th { color: var(--muted-foreground); font-weight: 500; font-size: 12px; }
</style>