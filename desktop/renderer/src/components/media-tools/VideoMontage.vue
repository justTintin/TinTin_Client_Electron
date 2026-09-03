<script setup lang="ts">
// ═══════════════════════════════════════════════════════════════
// VideoMontage.vue — 智能混剪·服务端四步向导（M8 条目⑥ UI 层）
// 四步（对照原客户端 gui/video_montage_page.py steps_text L257，严格一致）：
//   1.素材解析(镜头智能分割) → 2.AI 编排(镜头重组) → 3.口播配音 → 4.合成(特效包装)
// 链路全部走服务端：montage:split / montage:concat / montage:bgm
// 注：原客户端「卡点成片」属独立「一键成片」页（compile_video_page.py tab3，
//     BeatMontageController），不在智能混剪向导内，本端亦不纳入。
// 组件只绘制 + 事件转发；选段/载荷/轮询/下载业务全部在 useVideoMontage
// （纯函数 videoMontageLogic.ts，IRON-06/07 分层）。
// 闭环口径：提交 → 轮询 → 结果下载/打开目录 → 失败重试（重按按钮即重试）。
// ═══════════════════════════════════════════════════════════════
import { ref } from 'vue'
import TButton from '@/components/common/TButton.vue'
import TSelect from '@/components/common/TSelect.vue'
import { useVideoMontage } from '@/composables/useVideoMontage'

const STEPS = ['1. 素材解析', '2. AI 编排', '3. 口播配音', '4. 合成']
const step = ref(0)
function go(i: number) { step.value = Math.max(0, Math.min(STEPS.length - 1, i)) }

const {
  // 共享
  polling, activeTaskId, statusText, cancelPolling, downloadingKey,
  // Step1 素材解析
  srcVideos, threshold, minSceneLen, imageDuration,
  scenes, scoreFilter, filteredScenes, checkedCount,
  splitBusy, splitError, splitMsg,
  addVideos, selectFolder, onDrop, removeVideo, runSplit,
  // Step2 AI 编排
  concatTransition, concatLayout, concatTransitionDuration,
  edgeSpeedup, EDGE_SPEEDUP_OPTIONS, TRANSITIONS,
  concatBusy, concatError, concatResults, runConcat, downloadConcat,
  // Step3 口播配音
  voiceRows, selectedSpeaker, speakerOptions, batchGenerating,
  loadSpeakerOptions, selectVoiceDir, updateVoiceText,
  generateSingleVoice, generateAllVoices, playVoice, exportVoice,
  allVoicesDone, voiceStatusText, voiceStatusClass,
  // Step4 合成
  finalSource, bgmPath, bgmName, bgmVolume, sourceVolume,
  finalBusy, finalError, finalResults,
  pickBgm, pickLocalFinal, runFinalMix, downloadFinal, revealLocal,
  // 景别分类
  SHOT_TYPE_LABELS, SHOT_TYPE_COLORS,
} = useVideoMontage()

// 初始化时加载音色列表
loadSpeakerOptions()

const LAYOUTS = [
  { label: '竖屏 (1080x1920 抖音流)', value: 'vertical' },
  { label: '横屏 (1920x1080 宽屏)', value: 'horizontal' },
  { label: '与原视频一致', value: 'source' },
]

function basename(p: string) { return String(p || '').split(/[\\/]/).pop() || p }
function urlTail(u: string) { return String(u || '').split('/').pop() || u }
</script>

<template>
  <div class="montage" style="display: flex; flex-direction: column; gap: var(--space-5);">

    <!-- 顶部步骤条 -->
    <div class="step-bar">
      <template v-for="(s, i) in STEPS" :key="s">
        <div class="step-pill" :class="{ active: step === i, done: step > i }" @click="go(i)">
          <span class="step-dot" v-if="step > i">✓</span>{{ s }}
        </div>
        <span v-if="i < STEPS.length - 1" class="step-arrow">›</span>
      </template>
    </div>

    <!-- 共享任务状态条（轮询中/最近状态） -->
    <div v-if="polling || statusText" class="status-bar">
      <span class="status-text" :class="{ spinning: polling }">{{ statusText }}</span>
      <span v-if="activeTaskId" class="muted">任务 {{ activeTaskId }}</span>
      <TButton v-if="polling" label="取消等待" size="small" plain @click="cancelPolling" />
    </div>

    <!-- Step 1: 素材解析 -->
    <template v-if="step === 0">
      <section class="card">
        <div class="dropzone" @click="addVideos" @drop.prevent="onDrop" @dragover.prevent>
          <span class="dz-main">{{ srcVideos.length ? `已选 ${srcVideos.length} 个视频·点击/拖入继续添加` : '拖入素材文件夹（自动遍历子文件夹内全部视频） 或 点击选择文件夹' }}</span>
          <span class="dz-hint">支持 mp4 / mov / avi / mkv / flv / webm / m4v，服务端完成分割与逐镜分析</span>
        </div>
        <div class="row">
          <TButton label="选择文件夹" size="small" @click="selectFolder" />
          <span class="muted">自动递归遍历子文件夹内全部视频文件（上限 500 个，跳过 splits/outputs 等派生目录）</span>
        </div>

        <ul class="file-list">
          <li v-for="(v, i) in srcVideos" :key="v">
            <span>🎬 {{ v }}</span>
            <button class="linkbtn" @click="removeVideo(i)">移除</button>
          </li>
        </ul>

        <div class="row">
          <label>分割阈值 (1-100，越小越敏感)</label>
          <input v-model.number="threshold" type="number" min="1" max="100" class="input w80" />
          <label>最小镜头(秒)</label>
          <input v-model.number="minSceneLen" type="number" step="0.1" min="0.1" max="60" class="input w80" />
          <label>图片镜头时长(秒)</label>
          <input v-model.number="imageDuration" type="number" min="1" max="30" class="input w70" />
        </div>

        <div class="row">
          <TButton label="开始解析素材" icon="cut" :loading="splitBusy" @click="runSplit" />
          <span v-if="splitMsg" class="hint">{{ splitMsg }}</span>
        </div>
        <div v-if="splitError" class="error-msg">⚠ {{ splitError }}（修正后重按「开始解析素材」重试）</div>
      </section>

      <section class="card">
        <div class="row between">
          <span class="card-title">已分割镜头片段 <span class="muted">(勾选参与后续编排)</span></span>
          <label class="muted">评分过滤:
            <select v-model.number="scoreFilter" class="input">
              <option :value="0">不过滤</option>
              <option v-for="s in [1,2,3,4,5,6,7,8,9]" :key="s" :value="s">≥ {{ s }} 分</option>
            </select>
          </label>
        </div>
        <table class="tbl">
          <thead><tr><th style="width:28px"></th><th>序号</th><th>来源</th><th>景别</th><th>镜头</th><th>时长</th><th>评分</th><th style="min-width:160px">主要画面</th><th style="min-width:120px">分析</th></tr></thead>
          <tbody>
            <tr v-for="r in filteredScenes" :key="r.idx">
              <td><input v-model="r.checked" type="checkbox" /></td>
              <td>{{ r.idx }}</td>
              <td>{{ r.sourceName }}</td>
              <td>
                <span v-if="r.shotType" class="shot-type-badge" :style="{ color: SHOT_TYPE_COLORS[r.shotType] || '#888', borderColor: SHOT_TYPE_COLORS[r.shotType] || '#888' }">
                  {{ SHOT_TYPE_LABELS[r.shotType] || r.shotType }}
                </span>
                <span v-else class="muted">—</span>
              </td>
              <td>{{ r.startSec.toFixed(1) }}s ~ {{ r.endSec.toFixed(1) }}s</td>
              <td>{{ r.duration.toFixed(1) }}s</td>
              <td>{{ r.score || '—' }}</td>
              <td>{{ r.description || '—' }}</td>
              <td>{{ r.analysis || '—' }}</td>
            </tr>
            <tr v-if="!filteredScenes.length"><td colspan="9" class="muted">暂无已分割镜头，请先在上方开始解析</td></tr>
          </tbody>
        </table>
      </section>

      <div class="row right">
        <TButton label="下一步：AI 编排" icon="right" :disabled="!scenes.length" @click="go(1)" />
      </div>
    </template>

    <!-- Step 2: AI 编排 -->
    <template v-else-if="step === 1">
      <section class="card">
        <div class="grid2">
          <div class="field"><span class="label">转场动画</span><TSelect v-model="concatTransition" :options="TRANSITIONS" /></div>
          <div class="field"><span class="label">输出画幅</span><TSelect v-model="concatLayout" :options="LAYOUTS" /></div>
          <div class="field"><span class="label">转场时长(秒，0=默认)</span><input v-model.number="concatTransitionDuration" type="number" step="0.1" min="0" class="input" /></div>
          <div class="field">
            <span class="label">出入场加速 <span class="muted">(识别为入场/出场景别的镜头按此倍速加速)</span></span>
            <TSelect v-model="edgeSpeedup" :options="EDGE_SPEEDUP_OPTIONS" />
          </div>
        </div>

        <div class="row">
          <span class="clip-count">待编排镜头: {{ checkedCount }} <span class="muted">(已勾选，优先用服务端片段地址免二次上传)</span></span>
          <TButton label="提交 AI 编排" icon="video" :loading="concatBusy" @click="runConcat" />
        </div>
        <div class="row">
          <span class="muted">提交 /montage/concat → 轮询 /scheduled/tasks/{id} → 完成后 /montage/concat/result/{id} 下载</span>
        </div>
        <div v-if="concatError" class="error-msg">⚠ {{ concatError }}（修正后重按「提交 AI 编排」重试）</div>

        <div class="row between">
          <span class="card-title">编排成片</span>
        </div>
        <ul class="file-list">
          <li v-for="(u, i) in concatResults" :key="i">
            <span>🎞️ {{ urlTail(u) }}</span>
            <TButton label="下载" size="small" plain
              :loading="downloadingKey === `concat:${i}`" @click="downloadConcat(i)" />
          </li>
          <li v-if="!concatResults.length" class="muted">尚无编排成片，勾选镜头后点击「提交 AI 编排」</li>
        </ul>
      </section>

      <div class="row between">
        <TButton label="上一步：素材解析" plain @click="go(0)" />
        <TButton label="下一步：口播配音" icon="right" @click="go(2)" />
      </div>
    </template>

    <!-- Step 3: 口播配音 -->
    <template v-else-if="step === 2">
      <section class="card">
        <div class="row between">
          <span class="card-title">参考音色选择</span>
        </div>
        <div class="row">
          <label class="label">音色:</label>
          <TSelect v-model="selectedSpeaker" :options="speakerOptions" class="grow" />
          <TButton label="刷新列表" size="small" plain @click="loadSpeakerOptions" />
        </div>
        <div class="row">
          <span class="muted">选择预置音色或上传自定义音色样本（对照原客户端 _populate_ref_audio_samples）</span>
        </div>

        <div class="row between">
          <span class="card-title">视频目录选择</span>
        </div>
        <div class="row">
          <TButton label="选择视频目录" icon="folder" @click="selectVoiceDir" />
          <span class="muted">已选 {{ voiceRows.length }} 个视频</span>
        </div>
        <div class="row">
          <span class="muted">递归扫描目录下所有视频文件（.mp4/.mov/.avi/.mkv/.flv/.webm/.m4v），上限 500 个</span>
        </div>

        <div class="row between">
          <span class="card-title">配音队列</span>
          <TButton label="批量生成全部" icon="play" :loading="batchGenerating" :disabled="!voiceRows.length" @click="generateAllVoices" />
        </div>
        <div v-if="!voiceRows.length" class="muted">尚未选择视频目录，请先点击「选择视频目录」</div>
        <table v-else class="tbl voice-table">
          <thead>
            <tr>
              <th style="width:40px">#</th>
              <th>视频文件</th>
              <th style="width:300px">配音文案（双击编辑）</th>
              <th style="width:100px">状态</th>
              <th style="width:140px">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(row, i) in voiceRows" :key="i">
              <td>{{ i + 1 }}</td>
              <td class="video-name">{{ basename(row.videoPath) }}</td>
              <td>
                <textarea
                  class="voice-text"
                  :value="row.text"
                  placeholder="留空则跳过此视频"
                  @change="updateVoiceText(i, ($event.target as HTMLTextAreaElement).value)"
                />
              </td>
              <td>
                <span :class="voiceStatusClass(row.status)">{{ voiceStatusText(row.status) }}</span>
                <progress v-if="row.status === 'generating'" class="voice-progress" :value="row.progress" max="100" />
              </td>
              <td class="voice-ops">
                <TButton
                  size="small"
                  :loading="row.status === 'generating'"
                  :disabled="!row.text.trim() || row.status === 'generating'"
                  @click="generateSingleVoice(i)"
                >生成</TButton>
                <TButton
                  size="small"
                  plain
                  :disabled="!row.resultPath"
                  @click="playVoice(i)"
                >▶</TButton>
                <TButton
                  size="small"
                  plain
                  :disabled="!row.resultPath"
                  @click="exportVoice(i)"
                ></TButton>
              </td>
            </tr>
          </tbody>
        </table>
      </section>

      <div class="row between">
        <TButton label="上一步：AI 编排" plain @click="go(1)" />
        <TButton label="下一步：合成" icon="right" :disabled="!allVoicesDone()" @click="go(3)" />
      </div>
    </template>

    <!-- Step 4: 合成 -->
    <template v-else>
      <section class="card">
        <div class="row between">
          <span class="card-title">成片来源 <span class="muted">(编排结果或本地视频)</span></span>
        </div>
        <ul class="file-list">
          <li v-for="(u, i) in concatResults" :key="i" :class="{ picked: finalSource === u }" @click="finalSource = u" style="cursor: pointer">
            <span>{{ finalSource === u ? '☑' : '☐' }} 编排成片 {{ i + 1 }} · {{ urlTail(u) }}</span>
          </li>
          <li v-if="!concatResults.length" class="muted">暂无编排成片，可改为选择本地视频</li>
        </ul>
        <div class="row">
          <label class="label">本地成片:</label>
          <input :value="finalSource && !/^https?:/i.test(finalSource) ? finalSource : ''" placeholder="选择本地成片文件..." readonly class="input grow" @click="pickLocalFinal" />
          <TButton label="选择文件" size="small" @click="pickLocalFinal" />
          <TButton v-if="finalSource && !/^https?:/i.test(finalSource)" label="打开目录" size="small" plain @click="revealLocal(finalSource)" />
        </div>

        <div class="row">
          <label class="label">背景音乐:</label>
          <input :value="bgmPath" placeholder="选择背景音乐 (mp3/wav)..." readonly class="input grow" @click="pickBgm" />
          <TButton label="选择音乐" size="small" @click="pickBgm" />
        </div>
        <div class="row">
          <label class="label">BGM 音量</label>
          <input v-model.number="bgmVolume" type="range" min="0" max="200" class="grow" />
          <span class="muted" style="width:56px">{{ bgmVolume }} %</span>
          <label class="label">原声音量</label>
          <input v-model.number="sourceVolume" type="range" min="0" max="200" class="grow" />
          <span class="muted" style="width:56px">{{ sourceVolume }} %</span>
        </div>

        <div class="row right">
          <TButton label="开始合成（混音）" icon="celebration" :loading="finalBusy" @click="runFinalMix" />
        </div>
        <div class="row">
          <span class="muted">POST /montage/bgm（file/video_url + bgm，同步返回成片地址）</span>
        </div>
        <div v-if="finalError" class="error-msg">⚠ {{ finalError }}（修正后重按「开始合成（混音）」重试）</div>

        <div class="row between">
          <span class="card-title">最终成片</span>
        </div>
        <ul class="file-list">
          <li v-for="(u, i) in finalResults" :key="i">
            <span>✅ {{ urlTail(u) }}</span>
            <TButton label="下载" size="small" plain
              :loading="downloadingKey === `final:${i}`" @click="downloadFinal(i)" />
          </li>
          <li v-if="!finalResults.length" class="muted">尚无最终成片，选择来源与 BGM 后点击「开始合成（混音）」</li>
        </ul>
      </section>

      <div class="row left">
        <TButton label="上一步：口播配音" plain @click="go(2)" />
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

.status-bar { display: flex; align-items: center; gap: var(--space-3); padding: var(--space-2) var(--space-3); background: var(--surface-container); border: 1px solid var(--border); border-radius: var(--radius-md); font-size: 13px; }
.status-text { color: var(--foreground); font-weight: 500; }
.status-text.spinning { color: var(--primary); }

.card { display: flex; flex-direction: column; gap: var(--space-4); padding: var(--space-5); background: var(--card); border: 1px solid var(--border); border-radius: var(--radius-lg); }
.dropzone { display: flex; flex-direction: column; gap: 4px; padding: var(--space-5); background: var(--surface-container); border: 1.5px dashed var(--border); border-radius: var(--radius-lg); cursor: pointer; color: var(--foreground); transition: border-color var(--duration-fast); }
.dropzone:hover { border-color: var(--primary); }
.dz-main { font-size: var(--font-size-body); font-weight: var(--font-weight-medium); }
.dz-hint { font-size: var(--font-size-caption); color: var(--muted-foreground); }

.file-list { display: flex; flex-direction: column; gap: 6px; list-style: none; margin: 0; padding: 0; font-size: 13px; }
.file-list li { display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); padding: 6px 10px; background: var(--surface-container); border: 1px solid var(--border); border-radius: var(--radius-md); word-break: break-all; }
.file-list li.picked { border-color: var(--primary); }

.row { display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap; }
.row.between { justify-content: space-between; }
.row.right { justify-content: flex-end; }
.row.left { justify-content: flex-start; }
.grid2 { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: var(--space-3); }
.field { display: flex; flex-direction: column; gap: 6px; }
.label, .card-title { font-size: 13px; font-weight: 600; color: var(--foreground); }
.muted { color: var(--muted-foreground); font-size: 12px; }
.hint { color: var(--muted-foreground); font-size: 12px; }
.error-msg { color: var(--danger, #e74c3c); font-size: 12px; }
.clip-count { font-weight: 700; }

.input { height: 32px; padding: 0 10px; background: var(--card); border: 1px solid var(--border); border-radius: var(--radius-md); color: var(--foreground); outline: none; font-size: 13px; }
.input:focus { border-color: var(--primary); }
.input.grow { flex: 1; min-width: 120px; }
.w70 { width: 70px; } .w80 { width: 80px; }
.linkbtn { border: none; background: none; color: var(--primary); cursor: pointer; font-size: 12px; }

.tbl { width: 100%; border-collapse: collapse; font-size: 13px; }
.tbl th, .tbl td { padding: 6px 8px; border-bottom: 1px solid var(--border); text-align: left; vertical-align: top; }
.tbl th { color: var(--muted-foreground); font-weight: 500; font-size: 12px; }
.shot-type-badge {
  display: inline-block; padding: 1px 6px; border: 1px solid;
  border-radius: 4px; font-size: 11px; font-weight: 600; line-height: 1.4;
}

/* Step3 口播配音样式 */
.voice-table { margin-top: var(--space-3); }
.voice-table .video-name { font-size: 12px; color: var(--foreground); word-break: break-all; max-width: 200px; }
.voice-text {
  width: 100%; min-height: 60px; padding: 6px 8px;
  background: var(--surface-container); border: 1px solid var(--border);
  border-radius: var(--radius-md); color: var(--foreground);
  font-size: 12px; font-family: inherit; resize: vertical;
  outline: none;
}
.voice-text:focus { border-color: var(--primary); }
.voice-progress {
  width: 80px; height: 6px; margin-top: 4px;
  appearance: none; border-radius: 3px; overflow: hidden;
}
.voice-progress::-webkit-progress-bar { background: var(--surface-container); }
.voice-progress::-webkit-progress-value { background: var(--primary); transition: width 0.3s; }
.voice-ops { display: flex; gap: 4px; align-items: center; }

/* 状态标签样式 */
.st-pending { color: var(--muted-foreground); font-size: 12px; }
.st-running { color: var(--primary); font-size: 12px; font-weight: 600; }
.st-done { color: var(--success); font-size: 12px; font-weight: 600; }
.st-failed { color: var(--danger, #e74c3c); font-size: 12px; font-weight: 600; }
</style>
