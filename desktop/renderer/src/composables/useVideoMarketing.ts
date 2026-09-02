// ═══════════════════════════════════════════════════════════════
// useVideoMarketing.ts — 视频营销检测编排层
// 对照原客户端 studio/gui/marketing_detect_page.py MarketingDetectPage
//
// 完整链路（对照 MarketingDetectWorker.do_work + _run/_done/_render）：
//   1. 选视频（_browse / in_video 可手填）
//   2. 探测时长 → _sample_times（全片均匀 5~10 帧）→ 抽关键帧
//   3. 拼 system prompt + 多模态 content → llm_chat_messages（temperature=0.3）
//   4. safe_json_parse → 渲染结论/分类/品牌/线索/分析/建议
//
// 分层：抽帧/模型状态/LLM 调用收敛在 useVisionAnalyze（与视频评价预测共用），
//       采样策略、prompt、结果归一化、结论文案在 videoMarketingLogic 纯函数层。
// 本工具无落库需求（原版检测完即展示，不做历史记录）。
// ═══════════════════════════════════════════════════════════════

import { ref, computed } from 'vue'
import {
  buildMarketingContent,
  buildMarketingPrompt,
  marketingCategoryText,
  marketingConfidenceColor,
  marketingConfidenceText,
  marketingProductText,
  marketingSampleTimes,
  marketingVerdictColor,
  marketingVerdictText,
  parseMarketingResponse,
  type MarketingResult,
} from './videoMarketingLogic'
import { videoBaseName, videoTitleOf } from './visionLogic'
import { useVisionAnalyze, VISION_TEMPERATURE_MARKETING } from './useVisionAnalyze'

/** 抽帧目录标识（对照原版 TMP_DIR/marketing_frames） */
const FRAMES_TAG = 'marketing'

/** 检测状态（对照 btn_run 禁用 + pbar 可见 + lbl_status 文案） */
type DetectState = 'idle' | 'extracting' | 'detecting' | 'done' | 'failed'

export function useVideoMarketing() {
  const vision = useVisionAnalyze(FRAMES_TAG)

  // ── 输入 ────────────────────────────────────────────────────────
  const videoPath = ref('')
  const videoName = ref('')

  // ── 运行态 ──────────────────────────────────────────────────────
  const state = ref<DetectState>('idle')
  const errorMsg = ref('')
  const statusText = ref('')

  // ── 结果 ────────────────────────────────────────────────────────
  const result = ref<MarketingResult | null>(null)

  // ── 计算属性 ────────────────────────────────────────────────────
  const isIdle = computed(() => state.value === 'idle')
  const isExtracting = computed(() => state.value === 'extracting')
  const isDetecting = computed(() => state.value === 'detecting')
  const isDone = computed(() => state.value === 'done')
  const isFailed = computed(() => state.value === 'failed')
  const isBusy = computed(() => isExtracting.value || isDetecting.value)
  const canDetect = computed(() => !!videoPath.value && !isBusy.value)

  // 结论展示（对照 _render 各控件取值）
  const verdictText = computed(() =>
    result.value ? marketingVerdictText(result.value.is_marketing) : '—'
  )
  const verdictColor = computed(() =>
    result.value ? marketingVerdictColor(result.value.is_marketing) : '#a0aec0'
  )
  const confidenceText = computed(() =>
    result.value ? marketingConfidenceText(result.value.confidence) : ''
  )
  const confidenceColor = computed(() =>
    result.value ? marketingConfidenceColor(result.value.confidence) : '#a0aec0'
  )
  const categoryText = computed(() =>
    result.value ? marketingCategoryText(result.value.category) : '—'
  )
  const productText = computed(() =>
    result.value ? marketingProductText(result.value.product_or_brand) : '—'
  )

  // ── 方法 ────────────────────────────────────────────────────────

  /** 初始化：加载服务端地址（模型状态卡，对照 update_vision_model_display） */
  async function init(): Promise<void> {
    await vision.loadModelConfig()
  }

  /** 选择视频文件（对照 _browse：视频 *.mp4 *.mov *.mkv *.avi *.webm *.flv） */
  async function pickVideo(): Promise<void> {
    const res = await window.tintin?.dialog?.openFile?.({
      title: '选择视频',
      filters: [{ name: '视频', extensions: ['mp4', 'mov', 'mkv', 'avi', 'webm', 'flv'] }],
    })
    if (res && typeof res === 'string') setVideoPath(res)
  }

  /** 手动填写路径后同步显示名（对照 in_video 可直接编辑） */
  function setVideoPath(p: string): void {
    videoPath.value = String(p || '').trim()
    videoName.value = videoBaseName(videoPath.value)
    reset()
  }

  /** 重置（对照重跑：清结果与关键帧，保留视频选择） */
  function reset(): void {
    state.value = 'idle'
    errorMsg.value = ''
    statusText.value = ''
    result.value = null
    vision.resetFrames()
  }

  /** 开始检测（对照 _run → MarketingDetectWorker） */
  async function startDetect(): Promise<void> {
    // 对照原版：if not video or not os.path.isfile(video): show_warning("请选择有效的视频文件。")
    if (!videoPath.value) {
      errorMsg.value = '请选择有效的视频文件。'
      state.value = 'failed'
      return
    }
    if (isBusy.value) return

    errorMsg.value = ''
    result.value = null
    statusText.value = '检测中…'

    try {
      // 1. 抽帧（对照 phase「正在解析视频时长…」→「正在提取关键帧 i/n（t s）…」）
      state.value = 'extracting'
      const frames = await vision.probeAndExtract(videoPath.value, marketingSampleTimes)
      statusText.value = `已提取 ${frames.length} 帧关键帧`

      // 2. 视觉大模型研判（对照 phase「视觉大模型正在研判视频属性中…」）
      state.value = 'detecting'
      statusText.value = '视觉大模型正在研判视频属性中…'
      const content = buildMarketingContent(videoTitleOf(videoPath.value), frames)
      let text = ''
      try {
        text = await vision.analyze(buildMarketingPrompt(), content, VISION_TEMPERATURE_MARKETING)
      } catch (e) {
        // 对照原版：except RuntimeError → "无法连接视觉大模型：…\n请检查“大模型配置”中的服务端地址和视觉模型名称。"
        throw new Error(
          `无法连接视觉大模型：${e instanceof Error ? e.message : String(e)}\n` +
          `请检查『系统设置』中的服务端地址。`
        )
      }

      // 3. 解析（对照 safe_json_parse；失败时报原始返回前 500 字）
      const parsed = parseMarketingResponse(text)
      if (!parsed) {
        throw new Error('大模型没有输出有效的 JSON 对象，原始返回为：\n' + text.slice(0, 500))
      }
      result.value = parsed

      state.value = 'done'
      statusText.value = '检测完成。'
    } catch (e) {
      // 对照 _err：lbl_status「检测失败。」+ show_error(str(e))
      state.value = 'failed'
      statusText.value = '检测失败。'
      errorMsg.value = e instanceof Error ? e.message : String(e)
    }
  }

  return {
    // 输入 / 运行态
    videoPath, videoName, state, errorMsg, statusText,
    isIdle, isExtracting, isDetecting, isDone, isFailed, isBusy, canDetect,
    // 结果
    result, verdictText, verdictColor, confidenceText, confidenceColor,
    categoryText, productText,
    // 关键帧（与评价预测共用编排）
    frames: vision.frames,
    duration: vision.duration,
    // 视觉模型状态卡
    modelInfo: vision.modelInfo,
    modelStatusText: vision.modelStatusText,
    modelStatusColor: vision.modelStatusColor,
    canTestModel: vision.canTestModel,
    testVisionModel: vision.testVisionModel,
    // 方法
    init, pickVideo, setVideoPath, reset, startDetect,
  }
}
