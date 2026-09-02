// ═══════════════════════════════════════════════════════════════
// useVisionAnalyze.ts — 视觉模型研判共用编排层
//
// 服务对象：视频评价预测（hook_score_page.py）/ 视频营销检测（marketing_detect_page.py）
// 收敛两页完全一致的三段：
//   · 视觉模型状态卡（update_vision_model_display + VisionModelTestWorker）
//   · 探测时长 + 批量抽帧（_probe_duration + extract_frame 循环 + base64 读回）
//   · 调用视觉模型（llm_chat_messages，多模态 content 数组）
// 各自的抽帧策略与 prompt 由调用方纯函数提供（IRON-06/07 分层：本文件只做编排）。
// ═══════════════════════════════════════════════════════════════

import { ref, shallowRef, computed } from 'vue'
import {
  pickLlmText,
  probeDurationSec,
  throwIfIpcError,
  visionModelInfoText,
  visionModelStatusColor,
  visionModelStatusText,
  type VisionContentPart,
  type VisionFrame,
  type VisionModelState,
} from './visionLogic'
import { readCfg } from './useSettingsConfig'

/** 关键帧缩放宽度（对照 extract_frame(scale="512:-2")） */
const FRAME_WIDTH = 512
/** JPEG 质量（对照 extract_frame(quality=4) 默认值，两页实际都走 4） */
const FRAME_QUALITY = 4
/** 视觉模型请求超时口径：主进程 llm:chat 已固定 180s（对照 timeout=180） */
const VISION_TEMPERATURE_SCORE = 0.4     // hook_score_page.py L221
const VISION_TEMPERATURE_MARKETING = 0.3 // marketing_detect_page.py L134

export { VISION_TEMPERATURE_SCORE, VISION_TEMPERATURE_MARKETING }

/**
 * @param tag 抽帧输出目录标识（对照 TMP_DIR/hook_frames、TMP_DIR/marketing_frames）
 */
export function useVisionAnalyze(tag: string) {
  // ── 视觉模型状态卡 ──────────────────────────────────────────────
  const serverUrl = ref('')
  const modelState = ref<VisionModelState>('unknown')
  const modelInfo = computed(() => visionModelInfoText(!!serverUrl.value))
  const modelStatusText = computed(() => visionModelStatusText(modelState.value))
  const modelStatusColor = computed(() => visionModelStatusColor(modelState.value))
  const canTestModel = computed(() => !!serverUrl.value && modelState.value !== 'testing')

  // ── 关键帧 ──────────────────────────────────────────────────────
  // shallowRef：base64 为长字符串，避免深层响应式代理带来的无谓开销
  const frames = shallowRef<VisionFrame[]>([])
  const duration = ref(0)
  const phaseText = ref('')

  /**
   * 加载服务端地址（对照 update_vision_model_display 读 ai_config.compute_server_url）。
   * Electron 侧单一真相源为 electron-store 'server.url'（见 useSettingsGeneral.ts）。
   */
  async function loadModelConfig(): Promise<void> {
    serverUrl.value = String((await readCfg('server.url', '')) || '').trim()
    modelState.value = serverUrl.value ? 'configured' : 'unconfigured'
  }

  /** 测试连接（对照 VisionModelTestWorker：llm_chat("", "Hi", max_tokens=5, timeout=8)） */
  async function testVisionModel(): Promise<boolean> {
    if (!serverUrl.value) { modelState.value = 'unconfigured'; return false }
    modelState.value = 'testing'
    try {
      const res = await window.tintin?.server?.llmChat?.({
        model: '', // 视觉模型由服务端选择，客户端不指定（对照 model = None）
        messages: [{ role: 'user', content: 'Hi' }],
      })
      throwIfIpcError(res, '服务端离线或未返回内容')
      modelState.value = 'ok'
      return true
    } catch (_) {
      modelState.value = 'fail'
      return false
    }
  }

  /** 探测时长（对照 _probe_duration(video) or 10.0；探测失败不阻断，退化为默认值） */
  async function probeDuration(videoPath: string): Promise<number> {
    try {
      const res = await window.tintin?.ffmpeg?.probe?.(videoPath)
      return probeDurationSec(res)
    } catch (_) { return 10.0 }
  }

  /**
   * 批量抽关键帧（对照两页 extract_frame 循环 + frames.emit）。
   * 时间点由调用方纯函数给出；主进程负责清空重建目录、逐帧截图、读回 base64。
   */
  async function extractFrames(videoPath: string, times: number[]): Promise<VisionFrame[]> {
    const list = (Array.isArray(times) ? times : []).filter((t) => Number.isFinite(t) && t >= 0)
    if (!list.length) throw new Error('抽帧时间点为空')

    phaseText.value = `正在提取关键帧（共 ${list.length} 帧）…`
    const res = await window.tintin?.ffmpeg?.extractFrames?.({
      videoPath,
      times: list,
      tag,
      width: FRAME_WIDTH,
      quality: FRAME_QUALITY,
    })
    // 对照原版：if not frames: raise RuntimeError("视频关键帧提取失败…")
    throwIfIpcError(res, '视频关键帧提取失败，请检查视频文件是否损坏。')
    const out = ((res as { frames?: VisionFrame[] }).frames || []).filter((f) => f && f.base64)
    if (!out.length) throw new Error('视频关键帧提取失败，请检查视频文件是否损坏。')

    frames.value = out
    return out
  }

  /** 探测时长 + 抽帧一步到位（两页 do_work 前半段口径一致） */
  async function probeAndExtract(
    videoPath: string,
    sample: (dur: number) => number[]
  ): Promise<VisionFrame[]> {
    phaseText.value = '正在解析视频时长…'
    const dur = await probeDuration(videoPath)
    duration.value = dur
    return await extractFrames(videoPath, sample(dur))
  }

  /**
   * 调用视觉模型（对照 llm_chat_messages([{system}, {user: content[]}], model=None, temperature)）。
   * @returns 模型原始文本（JSON 解析由各工具纯函数负责）
   */
  async function analyze(
    systemPrompt: string,
    userContent: VisionContentPart[],
    temperature: number
  ): Promise<string> {
    phaseText.value = '视觉大模型正在研判中…'
    const res = await window.tintin?.server?.llmChat?.({
      model: '', // 视觉模型由服务端选择，客户端不再指定 model
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
      temperature,
    })
    throwIfIpcError(res, '大模型返回空响应。')
    const text = pickLlmText(res)
    if (!text) throw new Error('视觉模型返回空响应（请确认所选模型支持图片/视觉输入）。')
    return text
  }

  function resetFrames(): void {
    frames.value = []
    duration.value = 0
    phaseText.value = ''
  }

  return {
    // 模型状态卡
    serverUrl, modelState, modelInfo, modelStatusText, modelStatusColor, canTestModel,
    loadModelConfig, testVisionModel,
    // 抽帧
    frames, duration, phaseText,
    probeDuration, extractFrames, probeAndExtract, resetFrames,
    // 研判
    analyze,
  }
}
