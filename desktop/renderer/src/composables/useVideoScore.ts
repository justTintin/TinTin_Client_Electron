// ═══════════════════════════════════════════════════════════════
// useVideoScore.ts — 视频评价预测编排层（对照 hook_score_page.py）
//
// 完整链路（对照 HookScoreWorker.do_work + HookScorePage）：
//   1. 选投放平台 + 选视频
//   2. 探测时长 → _sample_times → 抽关键帧（前3秒密集 + 覆盖前20秒）
//   3. 拼 system prompt（含历史「预测 vs 实际」校准段）+ 多模态 content
//   4. llm_chat_messages（视觉模型由服务端选择）→ safe_json_parse → 渲染
//   5. 结果落库（VideoPredictionManager.add_prediction）
//   6. 发布后回填真实播放量/平台评价（set_feedback）→ 反哺下次预测
//
// 分层：抽帧/模型状态/LLM 调用收敛在 useVisionAnalyze（与视频营销检测共用），
//       采样策略、prompt、结果归一化、校准文本在 videoScoreLogic 纯函数层。
// ═══════════════════════════════════════════════════════════════

import { ref, computed } from 'vue'
import {
  PLATFORMS,
  DIMENSIONS,
  DIM_COLORS,
  sampleTimes,
  parseScoreResponse,
  buildScorePrompt,
  buildScoreContent,
  buildCalibrationText,
  filterPendingFeedback,
  playLevelColor,
  totalScoreColor,
  type Platform,
  type PredictionRecord,
  type VideoScoreResult,
} from './videoScoreLogic'
import { videoBaseName, videoTitleOf } from './visionLogic'
import { useVisionAnalyze, VISION_TEMPERATURE_SCORE } from './useVisionAnalyze'

/** 抽帧目录标识（对照原版 TMP_DIR/hook_frames） */
const FRAMES_TAG = 'hook_score'

/** 预测状态（对照 btn_run 禁用 + pbar 可见 + lbl_status 文案） */
type PredictState = 'idle' | 'extracting' | 'predicting' | 'done' | 'failed'

export function useVideoScore() {
  const vision = useVisionAnalyze(FRAMES_TAG)

  // ── 输入 ────────────────────────────────────────────────────────
  const videoPath = ref('')
  const videoName = ref('')
  const platform = ref<Platform>('抖音')

  // ── 运行态 ──────────────────────────────────────────────────────
  const state = ref<PredictState>('idle')
  const errorMsg = ref('')
  const progressText = ref('')

  // ── 结果 ────────────────────────────────────────────────────────
  const result = ref<VideoScoreResult | null>(null)
  /** 本次预测落库后的记录 id（回填反馈时定位用） */
  const currentRecordId = ref('')

  // ── 记录库（对照 VideoPredictionManager）────────────────────────
  const records = ref<PredictionRecord[]>([])

  // ── 回填表单（对照 feedback 区）─────────────────────────────────
  const feedbackPlay = ref('')
  const feedbackEval = ref('')
  const feedbackHint = ref('')

  // ── 计算属性 ────────────────────────────────────────────────────
  const isIdle = computed(() => state.value === 'idle')
  const isExtracting = computed(() => state.value === 'extracting')
  const isPredicting = computed(() => state.value === 'predicting')
  const isDone = computed(() => state.value === 'done')
  const isFailed = computed(() => state.value === 'failed')
  const isBusy = computed(() => isExtracting.value || isPredicting.value)
  const canPredict = computed(() => !!videoPath.value && !isBusy.value)

  const totalColor = computed(() => (result.value ? totalScoreColor(result.value.total) : '#888'))
  const levelColor = computed(() => (result.value ? playLevelColor(result.value.play_level) : '#888'))

  /** 尚未回填真实数据的记录（对照 pending_feedback） */
  const pendingRecords = computed(() => filterPendingFeedback(records.value))
  /** 当前平台已回填的对照条数（决定校准是否生效） */
  const calibrationCount = computed(
    () => records.value.filter((it) => it.actual && it.platform === platform.value).length
  )
  const calibrationText = computed(() => buildCalibrationText(records.value, platform.value))

  // ── 方法 ────────────────────────────────────────────────────────

  /** 初始化：加载服务端地址（模型状态卡）+ 历史记录（校准） */
  async function init(): Promise<void> {
    await Promise.all([vision.loadModelConfig(), loadRecords()])
  }

  /** 读取预测记录库（对照 VideoPredictionManager.load） */
  async function loadRecords(): Promise<void> {
    try {
      const res = await window.tintin?.prediction?.list?.()
      const items = (res as { items?: PredictionRecord[] } | undefined)?.items
      records.value = Array.isArray(items) ? items : []
    } catch (_) {
      records.value = []
    }
  }

  /** 选择视频文件（对照 _browse） */
  async function pickVideo(): Promise<void> {
    const res = await window.tintin?.dialog?.openFile?.({
      title: '选择视频',
      filters: [{ name: '视频', extensions: ['mp4', 'mov', 'mkv', 'avi', 'webm', 'flv'] }],
    })
    if (res && typeof res === 'string') {
      videoPath.value = res
      videoName.value = videoBaseName(res)
      resetResult()
    }
  }

  /** 手动填写路径后同步显示名（对照 in_video 可直接编辑） */
  function setVideoPath(p: string): void {
    videoPath.value = String(p || '').trim()
    videoName.value = videoBaseName(videoPath.value)
    resetResult()
  }

  /** 只清结果，保留视频与平台选择（对照重跑同一条视频） */
  function resetResult(): void {
    state.value = 'idle'
    errorMsg.value = ''
    progressText.value = ''
    result.value = null
    currentRecordId.value = ''
    feedbackPlay.value = ''
    feedbackEval.value = ''
    feedbackHint.value = ''
    vision.resetFrames()
  }

  /** 切换平台（对照 platform 下拉；切换后校准文本随平台变化） */
  function setPlatform(p: Platform): void {
    platform.value = p
  }

  /** 开始预测（对照 _run → HookScoreWorker） */
  async function startPredict(): Promise<void> {
    if (!videoPath.value) {
      errorMsg.value = '请选择有效的视频文件。'
      state.value = 'failed'
      return
    }
    if (isBusy.value) return

    errorMsg.value = ''
    feedbackHint.value = ''
    result.value = null
    currentRecordId.value = ''

    try {
      // 1. 抽帧（对照 phase「抽帧 i/n（t s）…」）
      state.value = 'extracting'
      progressText.value = '正在解析视频时长…'
      const frames = await vision.probeAndExtract(videoPath.value, sampleTimes)
      progressText.value = `已抽取 ${frames.length} 帧关键帧`

      // 2. 视觉模型预测（对照 phase「视觉模型正在按「平台」预测视频表现…」）
      state.value = 'predicting'
      progressText.value = `视觉模型正在按「${platform.value}」预测视频表现…`
      const sysPrompt = buildScorePrompt(platform.value, calibrationText.value)
      const content = buildScoreContent(platform.value, videoTitleOf(videoPath.value), frames)
      let text = ''
      try {
        text = await vision.analyze(sysPrompt, content, VISION_TEMPERATURE_SCORE)
      } catch (e) {
        // 对照原版：except RuntimeError → "无法连接视觉模型：…\n请检查『大模型配置』里的服务端地址。"
        throw new Error(
          `无法连接视觉模型：${e instanceof Error ? e.message : String(e)}\n` +
          `请检查『系统设置』里的服务端地址。`
        )
      }

      // 3. 解析（对照 safe_json_parse；失败时报原始返回前 500 字）
      const parsed = parseScoreResponse(text)
      if (!parsed) {
        throw new Error('视觉模型没有按要求输出 JSON，原始返回：\n' + text.slice(0, 500))
      }
      result.value = parsed

      // 4. 落库（对照 add_prediction；失败不影响本次结果展示）
      currentRecordId.value = await persistPrediction(parsed)

      state.value = 'done'
      progressText.value = '预测完成。'
    } catch (e) {
      state.value = 'failed'
      errorMsg.value = e instanceof Error ? e.message : String(e)
      progressText.value = ''
    }
  }

  /** 落库一条预测记录（对照 VideoPredictionManager.add_prediction） */
  async function persistPrediction(parsed: VideoScoreResult): Promise<string> {
    try {
      const res = await window.tintin?.prediction?.add?.({
        videoPath: videoPath.value,
        platform: platform.value,
        // 结构化克隆前转纯对象（Vue reactive Proxy 不能过 IPC）
        predicted: JSON.parse(JSON.stringify(parsed)),
      })
      const id = String((res as { id?: string } | undefined)?.id || '')
      await loadRecords()
      return id
    } catch (_) {
      return ''
    }
  }

  /**
   * 回填真实数据（对照 _save_feedback → set_feedback）。
   * 回填后该条进入校准集，下次预测的 prompt 会带上「预测 vs 实际」对照。
   */
  async function saveFeedback(): Promise<void> {
    if (!currentRecordId.value) {
      feedbackHint.value = '本次结果尚未入库（记录通道不可用），无法回填。'
      return
    }
    if (!feedbackPlay.value.trim() && !feedbackEval.value.trim()) {
      feedbackHint.value = '请至少填写真实播放量或平台评价其中一项。'
      return
    }
    try {
      const res = await window.tintin?.prediction?.setFeedback?.({
        id: currentRecordId.value,
        playCount: feedbackPlay.value.trim(),
        platformEval: feedbackEval.value.trim(),
      })
      const err = (res as { error?: string } | undefined)?.error
      if (err) { feedbackHint.value = `保存反馈失败：${err}`; return }
      await loadRecords()
      feedbackHint.value = '反馈已保存，模型会据此校准下次预测。'
      feedbackPlay.value = ''
      feedbackEval.value = ''
    } catch (e) {
      feedbackHint.value = `保存反馈失败：${e instanceof Error ? e.message : String(e)}`
    }
  }

  /**
   * 从历史记录选中一条待回填记录，切换回填目标（对照 pending_feedback 列表）。
   * 预测结果同时回显，便于对照填写。
   */
  function pickPendingRecord(rec: PredictionRecord): void {
    if (!rec) return
    currentRecordId.value = rec.id
    videoPath.value = rec.video_path
    videoName.value = rec.video_name
    platform.value = (PLATFORMS as readonly string[]).includes(rec.platform)
      ? (rec.platform as Platform)
      : platform.value
    const parsed = parseScoreResponse(JSON.stringify(rec.predicted || {}))
    result.value = parsed
    feedbackPlay.value = ''
    feedbackEval.value = ''
    feedbackHint.value = parsed ? '' : '该记录的预测结果字段不完整，仅可回填真实数据。'
    state.value = 'done'
    errorMsg.value = ''
    progressText.value = `已载入历史记录：${rec.video_name}`
  }

  return {
    // 输入 / 运行态
    videoPath, videoName, platform, state, errorMsg, progressText,
    isIdle, isExtracting, isPredicting, isDone, isFailed, isBusy, canPredict,
    // 结果
    result, totalColor, levelColor, currentRecordId,
    // 关键帧（与营销检测共用编排）
    frames: vision.frames,
    duration: vision.duration,
    // 视觉模型状态卡
    modelInfo: vision.modelInfo,
    modelStatusText: vision.modelStatusText,
    modelStatusColor: vision.modelStatusColor,
    canTestModel: vision.canTestModel,
    testVisionModel: vision.testVisionModel,
    // 记录库 / 校准
    records, pendingRecords, calibrationCount, calibrationText,
    // 回填表单
    feedbackPlay, feedbackEval, feedbackHint,
    // 方法
    init, loadRecords, pickVideo, setVideoPath, resetResult, setPlatform,
    startPredict, saveFeedback, pickPendingRecord,
    // 常量
    PLATFORMS, DIMENSIONS, DIM_COLORS,
  }
}
